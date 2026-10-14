// WorkBuddy 渠道池：多出口加权轮询、慢渠道自动熔断、换渠道重试、手动开关、兜底。
//
// 全部走 loopback 的假 hub：三个 mock 上游分别代表「快的渠道」「一直很慢的渠道」
// 「一直报 429 的渠道」，不需要真 hub、不消耗任何额度。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocPort, startMockUpstream, startProxy } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 慢渠道的首字延迟；阈值设得比它低一点点，好让「慢」这件事确定发生
const SLOW_MS = 1500;
const CHAT = { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] };

test('渠道池：轮询 / 熔断 / 重试 / 手动开关 / 阈值落盘', async (t) => {
  const fast = await startMockUpstream({
    // 探活接口打的是 hub 的 /v1/models，并读它回报的 realm；通用 mock 得把这一条
    // 也照 hub 的形状答出来，否则断言的是 mock 而不是代码。
    onRequest: (req, res) => {
      if (!req.url.startsWith('/v1/models')) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', realm: 'intl', data: [{ id: 'deepseek-v4.1-flash' }] }));
    },
  });
  const slow = await startMockUpstream({ onRequest: () => sleep(SLOW_MS) });
  const dead = await startMockUpstream({
    status: 429,
    errorBody: JSON.stringify({ error: { message: 'upstream rate limit reached for this model' } }),
  });
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wbch-'));
  const keysFile = join(workdir, 'keys.json');
  const ch = (id, name, port, extra = {}) => ({
    id, name, realm: 'intl', hubUrl: `http://127.0.0.1:${port}`,
    weight: 1, priority: 0, enabled: true, ...extra,
  });
  writeFileSync(keysFile, JSON.stringify({
    lb: {}, settings: {}, keys: [],
    wbBreaker: { slowMs: 1000, window: 4, slowCount: 3, errorCount: 2, openMs: 60000, maxOpenMs: 300000 },
    wbChannels: [ch('c-fast', '快', fast.port), ch('c-slow', '慢', slow.port)],
  }, null, 2));

  const proxy = await startProxy({
    upstreamPort: fast.port, cwd: workdir,
    // 本用例只验池子内部的行为，不占第二个出口端口（并行跑测试文件时免得抢端口）
    env: { WB_EXIT2_PORT: '0' },
  });
  const chat = () => proxy.post('/wb/v1/chat/completions', CHAT);
  const view = async () => (await proxy.get('/admin/api/wb/channels')).json();
  const patch = (id, body) => fetch(`${proxy.base}/admin/api/wb/channels/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  t.after(async () => {
    await proxy.kill();
    await Promise.all([fast.close(), slow.close(), dead.close()]);
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  await t.test('8 次请求在两条渠道之间均分，且都是 200', async () => {
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await chat()).status);
    assert.deepEqual(codes, Array(8).fill(200));
    assert.equal(fast.seen.length, 4, '快渠道应接到 4 次');
    assert.equal(slow.seen.length, 4, '慢渠道应接到 4 次');
  });

  await t.test('首字延迟被如实记下，慢渠道自动熔断、快渠道不受影响', async () => {
    const v = await view();
    const f = v.channels.find((c) => c.id === 'c-fast');
    const s = v.channels.find((c) => c.id === 'c-slow');
    assert.ok(f.stats.avgTtfbMs < 500, `快渠道首字应很小，实际 ${f.stats.avgTtfbMs}ms`);
    assert.ok(s.stats.avgTtfbMs >= SLOW_MS - 100, `慢渠道首字应接近 ${SLOW_MS}ms，实际 ${s.stats.avgTtfbMs}ms`);
    assert.equal(s.stats.slowCount, 4);
    assert.equal(s.breakerActive, true, '慢渠道应被熔断');
    assert.equal(s.breaker.reason, 'slow');
    assert.equal(f.breakerActive, false);
  });

  await t.test('熔断后的请求全部落到健康渠道', async () => {
    const before = { f: fast.seen.length, s: slow.seen.length };
    for (let i = 0; i < 4; i++) assert.equal((await chat()).status, 200);
    assert.equal(fast.seen.length - before.f, 4);
    assert.equal(slow.seen.length - before.s, 0, '被熔断的渠道不该再接新请求');
  });

  await t.test('手动停用健康渠道后，被熔断的渠道仍要兜底服务（不能 503）', async () => {
    assert.equal((await patch('c-fast', { enabled: false })).status, 200);
    const r = await chat();
    assert.equal(r.status, 200, '唯一剩下的渠道即使被熔断也要服务');
    assert.equal((await patch('c-fast', { enabled: true })).status, 200);
  });

  await t.test('上游 429 时自动换下一条渠道重试', async () => {
    const created = await (await fetch(`${proxy.base}/admin/api/wb/channels`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '坏', realm: 'intl', hubUrl: `http://127.0.0.1:${dead.port}`, priority: 99 }),
    })).json();
    const before = dead.seen.length;
    const r = await chat();
    assert.equal(r.status, 200, '坏渠道的 429 不该透传给客户端');
    assert.ok(dead.seen.length > before, '坏渠道应该被试过一次');
    // 清理，免得影响后面的用例
    await fetch(`${proxy.base}/admin/api/wb/channels/${created.id}`, { method: 'DELETE' });
  });

  await t.test('探活接口回报生效的出口版本；重置熔断清空状态', async () => {
    const test1 = await (await fetch(`${proxy.base}/admin/api/wb/channels/c-fast/test`, { method: 'POST' })).json();
    assert.equal(test1.ok, true);
    assert.equal(test1.realm, 'intl');
    const reset = await (await fetch(`${proxy.base}/admin/api/wb/channels/c-slow/reset`, { method: 'POST' })).json();
    assert.equal(reset.breakerActive, false);
    assert.equal(reset.breaker, null);
  });

  await t.test('阈值可从面板改并写进 keys.json', async () => {
    const put = await (await fetch(`${proxy.base}/admin/api/wb/breaker`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slowMs: 15000 }),
    })).json();
    assert.equal(put.breaker.slowMs, 15000);
    const onDisk = JSON.parse(readFileSync(keysFile, 'utf-8'));
    assert.equal(onDisk.wbBreaker.slowMs, 15000, '阈值要活过重启');
    assert.equal(onDisk.wbChannels.length, 2, '渠道池也要落盘');
  });

  await t.test('删除渠道', async () => {
    const r = await fetch(`${proxy.base}/admin/api/wb/channels/c-slow`, { method: 'DELETE' });
    assert.equal(r.status, 204);
    assert.equal((await view()).channels.length, 1);
  });

  await t.test('没配渠道池时保持旧行为：单条隐式渠道', async () => {
    // 直接看接口的 implicit 标记即可：清空池子等价于接入前的行为
    await fetch(`${proxy.base}/admin/api/wb/channels/c-fast`, { method: 'DELETE' });
    assert.equal((await view()).implicit, true);
  });
});

test('realm 预筛：只在某一版提供的模型不会被送去另一版', async (t) => {
  const intl = await startMockUpstream({});
  const cn = await startMockUpstream({});
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wbrealm-'));
  writeFileSync(join(workdir, 'keys.json'), JSON.stringify({
    lb: {}, settings: {}, keys: [],
    wbChannels: [
      { id: 'c-intl', name: '国际', realm: 'intl', hubUrl: `http://127.0.0.1:${intl.port}`, weight: 1, priority: 0, enabled: true },
      { id: 'c-cn', name: '国内', realm: 'cn', hubUrl: `http://127.0.0.1:${cn.port}`, weight: 1, priority: 0, enabled: true },
    ],
  }, null, 2));
  const proxy = await startProxy({
    upstreamPort: intl.port, cwd: workdir,
    // 这条用例验的是「不按端口钉版本」时的按模型名分流（旧行为）
    env: { WB_EXIT2_PORT: '0', WB_EXIT1_REALM: '' },
  });
  t.after(async () => {
    await proxy.kill();
    await Promise.all([intl.close(), cn.close()]);
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  await t.test('gpt- 前缀（国际版专属）只打国际版渠道', async () => {
    await proxy.post('/wb/v1/chat/completions', { model: 'gpt-6-astra', messages: [] });
    assert.equal(intl.seen.length, 1);
    assert.equal(cn.seen.length, 0);
    assert.equal(intl.seen[0].headers['x-realm'], 'intl', '必须显式声明出口，否则会跟随 hub 全局开关');
  });

  await t.test('minimax- 前缀（国内版专属）只打国内版渠道', async () => {
    await proxy.post('/wb/v1/chat/completions', { model: 'minimax-m3', messages: [] });
    assert.equal(cn.seen.length, 1);
    assert.equal(intl.seen.length, 1);
    assert.equal(cn.seen[0].headers['x-realm'], 'cn');
  });

  await t.test('两版都有的模型两条渠道都会被用到', async () => {
    await proxy.post('/wb/v1/chat/completions', { model: 'deepseek-v4.1-flash', messages: [] });
    await proxy.post('/wb/v1/chat/completions', { model: 'deepseek-v4.1-flash', messages: [] });
    assert.equal(intl.seen.length, 2);
    assert.equal(cn.seen.length, 2);
  });
});

test('客户端提前挂断不算渠道失败（SSE 收完就关是常态）', async (t) => {
  // 一个慢慢吐块的假上游：客户端读一块就走，模拟真实 SSE 客户端的行为
  const streaming = await startMockUpstream({
    onRequest: async (req, res) => {
      if (!req.url.startsWith('/v1/chat')) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let i = 0; i < 10; i++) {
        res.write(`data: {"i":${i}}\n\n`);
        await sleep(150);
      }
      res.end();
    },
  });
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wbabort-'));
  writeFileSync(join(workdir, 'keys.json'), JSON.stringify({
    lb: {}, settings: {}, keys: [],
    wbChannels: [{ id: 'c-s', name: '慢流', realm: 'intl', hubUrl: `http://127.0.0.1:${streaming.port}`, weight: 1, priority: 0, enabled: true }],
  }, null, 2));
  const proxy = await startProxy({ upstreamPort: streaming.port, cwd: workdir, env: { WB_EXIT2_PORT: '0' } });
  t.after(async () => {
    await proxy.kill();
    await streaming.close();
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  // 读第一块就断开
  const ac = new AbortController();
  const r = await fetch(`${proxy.base}/wb/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(CHAT), signal: ac.signal,
  });
  assert.equal(r.status, 200);
  const reader = r.body.getReader();
  await reader.read();
  ac.abort();
  await sleep(400);   // 让服务端把 close 处理完

  const v = await (await proxy.get('/admin/api/wb/channels')).json();
  const c = v.channels[0];
  assert.ok(c.stats.samples >= 1, `挂断也该留下采样，实际 ${c.stats.samples}`);
  assert.equal(c.stats.errorCount, 0, '客户端挂断不该算成渠道失败');
  assert.equal(c.breakerActive, false, '更不该因此熔断');
  const last = (v.recent || [])[v.recent.length - 1];
  assert.match(last.err, /客户端提前断开/);
  assert.equal(last.port, proxy.port, '端口要记下来（响应结束后 socket 已解绑）');
});

test('两个端口 = 两个出口：端口定死版本，各走各的', async (t) => {
  const intl = await startMockUpstream({});
  const cn = await startMockUpstream({});
  const exit2 = await allocPort();
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wbexit-'));
  writeFileSync(join(workdir, 'keys.json'), JSON.stringify({
    lb: {}, settings: {}, keys: [],
    wbChannels: [
      { id: 'c-intl', name: '国际', realm: 'intl', hubUrl: `http://127.0.0.1:${intl.port}`, weight: 1, priority: 0, enabled: true },
      { id: 'c-cn', name: '国内', realm: 'cn', hubUrl: `http://127.0.0.1:${cn.port}`, weight: 1, priority: 0, enabled: true },
    ],
  }, null, 2));
  const proxy = await startProxy({
    upstreamPort: intl.port, cwd: workdir,
    env: { WB_EXIT1_REALM: 'intl', WB_EXIT2_PORT: String(exit2), WB_EXIT2_REALM: 'cn' },
  });
  const exit2Base = `http://127.0.0.1:${exit2}`;
  t.after(async () => {
    await proxy.kill();
    await Promise.all([intl.close(), cn.close()]);
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  await t.test('主端口只打国际版出口', async () => {
    await proxy.post('/wb/v1/chat/completions', { model: 'deepseek-v4.1-flash', messages: [] });
    assert.equal(intl.seen.length, 1);
    assert.equal(cn.seen.length, 0);
    assert.equal(intl.seen[0].headers['x-realm'], 'intl');
  });

  await t.test('第二个端口只打国内版出口', async () => {
    const r = await fetch(`${exit2Base}/wb/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [] }),
    });
    assert.equal(r.status, 200);
    assert.equal(cn.seen.length, 1);
    assert.equal(intl.seen.length, 1, '国际版出口不该被第二个端口碰到');
    assert.equal(cn.seen[0].headers['x-realm'], 'cn');
  });

  await t.test('第二个端口是专用通道：非 /wb 路径 404', async () => {
    const r = await fetch(`${exit2Base}/admin/api/keys`);
    assert.equal(r.status, 404);
    const h = await fetch(`${exit2Base}/health`);
    assert.equal(h.status, 200);
  });

  await t.test('接口回报端口 → 版本的映射', async () => {
    const v = await (await proxy.get('/admin/api/wb/channels')).json();
    assert.deepEqual(v.exits.map((e) => e.realm), ['intl', 'cn']);
    assert.equal(v.channels.find((c) => c.realm === 'cn').port, exit2);
  });

  await t.test('手动停用某个出口 → 那个端口直接 503，不会偷偷换回同一个版本', async () => {
    const post = () => fetch(`${exit2Base}/wb/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [] }),
    });
    const before = cn.seen.length;
    assert.equal((await post()).status, 200);
    assert.equal(cn.seen.length, before + 1);

    const patch = (enabled) => fetch(`${proxy.base}/admin/api/wb/channels/c-cn`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    await patch(false);
    assert.equal((await post()).status, 503, '停用的出口必须真的不服务');
    assert.equal(cn.seen.length, before + 1, '不该再碰国内版上游');
    // 另一个端口不受影响
    assert.equal((await proxy.post('/wb/v1/chat/completions', { model: 'deepseek-v4.1-flash', messages: [] })).status, 200);
    await patch(true);
    assert.equal((await post()).status, 200, '重新启用后要能恢复');
  });
});
