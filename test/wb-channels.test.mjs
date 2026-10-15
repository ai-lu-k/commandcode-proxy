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
// 客户端可见的报文里绝不能出现的字眼 —— 后端结构（账号池 / 上游 / 出口 / 渠道 / hub /
// realm）、计费内部（积分 / 加量包）、以及「WorkBuddy」这个上游厂商名。
// 线上被连着指出两轮（先账号 UID，后「账号池 · 上游账号冷却」），这里立成硬约束：
// 对外只说「暂时不可用」，凡描述后端结构的一律不许出现。
const LEAKY = /账号池|上游|出口|渠道|积分|加量包|冷却|限流|熔断|hub|realm|workbuddy/i;

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

// 上游报错原文里的账号 UID / 熔断剩余时间 / 采购链接不该进客户端 —— 线上真实发生过：
// hub 的 503 把「71c0a6c6 熔断 剩余 43 min，…」逐账号拼进 message 直接透传了出去。
test('上游错误脱敏：账号池内部诊断不进客户端，原文只留服务端', async (t) => {
  const HUB_503 = JSON.stringify({
    message: "no usable account for realm 'cn': all are disabled, cooling down, "
      + 'expired or parked by the daily token limit；各账号：71c0a6c6 熔断 剩余 43 min，'
      + '7cc904d4 熔断 剩余 24 min，a18de4d2 熔断 剩余 3.9 hours，6c355136 熔断 剩余 58 min，'
      + '91157b10 熔断 剩余 26 min - add or enable one at the dashboard (/)',
    type: 'server_error', param: '', code: 503,
  });
  const HUB_429 = JSON.stringify({
    error: { message: 'upstream rate limit reached for this model; retry in 2s - '
      + '{"error":{"data":{"code":14018,"msg":"Credits exhausted. '
      + 'Please visit the link below to purchase add-on packs"}}}' },
  });

  const mock = await startMockUpstream({
    onRequest: (req, res) => {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(HUB_503);
    },
  });
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wbsafe-'));
  writeFileSync(join(workdir, 'keys.json'), JSON.stringify({
    lb: {}, settings: {}, keys: [],
    wbChannels: [{ id: 'c-s', name: '唯一', realm: 'intl', hubUrl: `http://127.0.0.1:${mock.port}`, weight: 1, priority: 0, enabled: true }],
  }, null, 2));
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: workdir, env: { WB_EXIT2_PORT: '0' } });
  t.after(async () => {
    await proxy.kill();
    await mock.close();
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  await t.test('503 的后端诊断收敛成一句通用话术', async () => {
    const r = await proxy.post('/wb/v1/chat/completions', { model: 'deepseek-v4.1-flash', messages: [] });
    assert.equal(r.status, 503, '状态码照旧，只换 message');
    const j = await r.json();
    const wire = JSON.stringify(j);
    assert.ok(!/71c0a6c6|7cc904d4|a18de4d2|6c355136|91157b10/.test(wire), '不得出现账号 UID');
    assert.ok(!/各账号|add or enable one|dashboard/.test(wire), '不得出现池子状态');
    assert.ok(!LEAKY.test(wire), `不得出现后端字样：${wire}`);
    assert.match(j.error.message, /暂时不可用/);
    assert.equal(j.error.type, 'server_error');
    // 原文要留在服务端的 recent 环里（排查现场）
    const v = await (await proxy.get('/admin/api/wb/channels')).json();
    const last = (v.recent || [])[v.recent.length - 1];
    assert.ok(last && /71c0a6c6/.test(last.err || ''), '服务端 recent 环保留原文');
  });

  await t.test('14018「积分耗尽」对外也只是「暂时不可用」', async () => {
    const mock2 = await startMockUpstream({
      onRequest: (req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(HUB_429);
      },
    });
    const workdir2 = mkdtempSync(join(tmpdir(), 'ccp-wb14018-'));
    writeFileSync(join(workdir2, 'keys.json'), JSON.stringify({
      lb: {}, settings: {}, keys: [],
      wbChannels: [{ id: 'c-e', name: '唯一', realm: 'intl', hubUrl: `http://127.0.0.1:${mock2.port}`, weight: 1, priority: 0, enabled: true }],
    }, null, 2));
    const p2 = await startProxy({ upstreamPort: mock2.port, cwd: workdir2, env: { WB_EXIT2_PORT: '0' } });
    try {
      const r = await p2.post('/wb/v1/chat/completions', { model: 'gpt-6-sol', messages: [] });
      assert.equal(r.status, 429);
      const j = await r.json();
      const wire = JSON.stringify(j);
      assert.match(j.error.message, /暂时不可用/);
      assert.ok(!LEAKY.test(wire), `不得出现后端字样：${wire}`);
      assert.ok(!/14018|Credits exhausted|Please visit the link|rate limit/i.test(wire), '不透传上游原文与采购链接');
      assert.equal(j.error.type, 'rate_limit_error');
    } finally {
      await p2.kill();
      await mock2.close();
      try { rmSync(workdir2, { recursive: true, force: true }); } catch {}
    }
  });

  await t.test('2xx 流里内嵌的账号池诊断也会被洗掉', async () => {
    const leak = JSON.stringify({ type: 'error', error: { message: "no usable account for realm 'cn'；各账号：71c0a6c6 熔断 剩余 43 min" } });
    const mock3 = await startMockUpstream({
      onRequest: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"text-delta","text":"hello"}\n\n');
        res.write(`data: ${leak}\n\n`);
        res.write('data: {"type":"finish"}\n\n');
        res.end();
      },
    });
    const workdir3 = mkdtempSync(join(tmpdir(), 'ccp-wbscrub-'));
    writeFileSync(join(workdir3, 'keys.json'), JSON.stringify({
      lb: {}, settings: {}, keys: [],
      wbChannels: [{ id: 'c-x', name: '唯一', realm: 'intl', hubUrl: `http://127.0.0.1:${mock3.port}`, weight: 1, priority: 0, enabled: true }],
    }, null, 2));
    const p3 = await startProxy({ upstreamPort: mock3.port, cwd: workdir3, env: { WB_EXIT2_PORT: '0' } });
    try {
      const r = await p3.post('/wb/v1/chat/completions', { model: 'deepseek-v4.1-flash', messages: [] });
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.ok(!/71c0a6c6|各账号/.test(text), '流里的账号诊断不得下发');
      assert.ok(!LEAKY.test(text), `流里也不得出现后端字样：${text.slice(0, 200)}`);
      assert.ok(text.includes('"text":"hello"'), '正常内容必须原样通过');
      assert.ok(text.includes('"type":"finish"'), '正常的流事件不能被洗坏');
    } finally {
      await p3.kill();
      await mock3.close();
      try { rmSync(workdir3, { recursive: true, force: true }); } catch {}
    }
  });
});

// 上游说「这个号在这个模型上没钱了」（intl 回 429 带 code 14018 Credits exhausted）
// 时，hub 只当普通限流给几秒冷却就继续派同一个号 —— 余额明明用完了还一路打过去。
// 反代这边自己记住 (出口, 模型)，短路掉后续请求，不再空转上游。
test('积分耗尽短路：同一个模型不再空转上游，换模型不受影响', async (t) => {
  const EXHAUSTED = JSON.stringify({
    error: {
      message: 'upstream rate limit reached for this model; retry in 2s - '
        + '{"error":{"data":{"code":14018,"msg":"Credits exhausted. Please visit the link below"}}}',
    },
  });
  let calls = 0;
  const byModel = {};
  const mock = await startMockUpstream({
    onRequest: (req, res, seen) => {
      calls++;
      let m = '';
      try { m = JSON.parse(seen.raw || '{}').model || ''; } catch { /* 忽略 */ }
      byModel[m] = (byModel[m] || 0) + 1;
      // 只有 gpt-6-sol 这个模型在上游没钱了；别的模型照常 200
      if (m === 'gpt-6-sol') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(EXHAUSTED);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"finish"}\n\n');
      res.end();
    },
  });
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wbcredit-'));
  writeFileSync(join(workdir, 'keys.json'), JSON.stringify({
    lb: {}, settings: {}, keys: [],
    wbChannels: [{ id: 'c-credit', name: '积分出口', realm: 'intl', hubUrl: `http://127.0.0.1:${mock.port}`, weight: 1, priority: 0, enabled: true }],
  }, null, 2));
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: workdir, env: { WB_EXIT2_PORT: '0' } });
  t.after(async () => {
    await proxy.kill();
    await mock.close();
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  await t.test('第一次：上游说积分耗尽，对外仍是「暂时不可用」', async () => {
    const r = await proxy.post('/wb/v1/chat/completions', { model: 'gpt-6-sol', messages: [] });
    assert.equal(r.status, 429, '状态码照旧，只换 message');
    const j = await r.json();
    const wire = JSON.stringify(j);
    assert.ok(!/rate limit|14018|Credits exhausted|Please visit/i.test(wire), '不透传上游原文与采购链接');
    assert.ok(!LEAKY.test(wire), `不得出现后端字样：${wire}`);
    assert.match(j.error.message, /暂时不可用/);
    assert.equal(calls, 1);
  });

  await t.test('第二次：直接短路回 503，不再打上游', async () => {
    const before = calls;
    const r = await proxy.post('/wb/v1/chat/completions', { model: 'gpt-6-sol', messages: [] });
    assert.equal(r.status, 503);
    const j = await r.json();
    const wire = JSON.stringify(j);
    assert.match(j.error.message, /暂时不可用/);
    assert.ok(!LEAKY.test(wire), `不得出现后端字样：${wire}`);
    assert.ok(!/分钟|重试时间|加量包/.test(wire), '不暴露还会被跳过多久');
    assert.equal(calls, before, '不该再打上游一次');
  });

  await t.test('面板能看到是哪个模型被跳过', async () => {
    const v = await (await proxy.get('/admin/api/wb/channels')).json();
    const c = v.channels.find((x) => x.id === 'c-credit');
    assert.equal(c.creditParks.length, 1);
    assert.equal(c.creditParks[0].model, 'gpt-6-sol');
    assert.ok(c.creditParks[0].minutes >= 9, '默认跳过 10 分钟');
  });

  await t.test('换模型不受影响（跳过是按模型记的）', async () => {
    const r = await proxy.post('/wb/v1/chat/completions', { model: 'deepseek-v4.1-flash', messages: [] });
    assert.equal(r.status, 200, '另一个模型必须正常走通');
    const c = (await (await proxy.get('/admin/api/wb/channels')).json())
      .channels.find((x) => x.id === 'c-credit');
    assert.deepEqual(c.creditParks.map((p) => p.model), ['gpt-6-sol'], '另一个模型不该被一起跳过');
  });

  await t.test('手动重置可以把跳过清掉，立刻重试', async () => {
    const before = calls;
    await fetch(`${proxy.base}/admin/api/wb/channels/c-credit/reset`, { method: 'POST' });
    const c = (await (await proxy.get('/admin/api/wb/channels')).json())
      .channels.find((x) => x.id === 'c-credit');
    assert.deepEqual(c.creditParks, []);
    const r = await proxy.post('/wb/v1/chat/completions', { model: 'gpt-6-sol', messages: [] });
    assert.equal(r.status, 429);
    assert.equal(calls, before + 1, '重置后要重新打上游');
  });
});
