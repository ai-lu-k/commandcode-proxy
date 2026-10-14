// WorkBuddy 渠道池：多出口加权轮询、慢渠道自动熔断、换渠道重试、手动开关、兜底。
//
// 全部走 loopback 的假 hub：三个 mock 上游分别代表「快的渠道」「一直很慢的渠道」
// 「一直报 429 的渠道」，不需要真 hub、不消耗任何额度。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockUpstream, startProxy } from './helpers.mjs';

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

  const proxy = await startProxy({ upstreamPort: fast.port, cwd: workdir });
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
  const proxy = await startProxy({ upstreamPort: intl.port, cwd: workdir });
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
