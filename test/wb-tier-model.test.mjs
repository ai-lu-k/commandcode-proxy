// 价格档位名回落 + 整池没号短期短路 + 熔断只记渠道侧的错。
//
// 这三件事都来自线上实测：
//   1) 站点卖的是「档位名」（deepseek-v4.1-flash-x0.01），上游只认基础名，
//      绕过站点直接打出口的调用会拿到上游 11102，客户端却只看到「暂时不可用」；
//   2) 出口整池没号时，hub 要先扫一遍账号池才回 502（~0.3s），站点分到这个端口的
//      那一半请求每次都白等，还在 hub 的用量里堆一堆归属不了的失败；
//   3) 调用方打错模型名也是 400，之前会把整条出口熔断掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockUpstream, startProxy } from './helpers.mjs';

const CHAT = { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] };
// 客户端可见的报文里绝不能出现的字眼（与 wb-channels.test.mjs 同一套硬约束）
const LEAKY = /账号池|上游|出口|渠道|积分|加量包|冷却|限流|熔断|hub|realm|workbuddy/i;
const CATALOG = { object: 'list', data: [{ id: 'deepseek-v4.1-flash' }, { id: 'gpt-6-sol' }] };

function writeKeys(workdir, channel, extra = {}) {
  writeFileSync(join(workdir, 'keys.json'), JSON.stringify({
    lb: {}, settings: {}, keys: [],
    ...extra,
    wbChannels: [{
      id: channel.id, name: channel.name, realm: channel.realm ?? 'intl',
      hubUrl: `http://127.0.0.1:${channel.port}`, weight: 1, priority: 0, enabled: true,
    }],
  }, null, 2));
}

test('价格档位名按上游目录回落成基础名', async (t) => {
  const models = [];
  let catalogHits = 0;
  const hub = await startMockUpstream({
    onRequest: (req, res, seen) => {
      if (req.url.startsWith('/v1/models')) {
        catalogHits++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(CATALOG));
        return;
      }
      let m = '';
      try { m = JSON.parse(seen.raw || '{}').model || ''; } catch { /* 忽略 */ }
      models.push(m);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'chat.completion', model: m, choices: [] }));
    },
  });
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wbtier-'));
  writeKeys(workdir, { id: 'c-tier', name: '档位出口', port: hub.port });
  const proxy = await startProxy({ upstreamPort: hub.port, cwd: workdir, env: { WB_EXIT2_PORT: '0' } });
  t.after(async () => {
    await proxy.kill();
    await hub.close();
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  await t.test('档位名 → 上游认的基础名', async () => {
    const r = await proxy.post('/wb/v1/chat/completions', {
      model: 'deepseek-v4.1-flash-x0.01', messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.status, 200);
    assert.equal(models.pop(), 'deepseek-v4.1-flash', '上游该收到基础名，而不是档位名');
  });

  await t.test('目录里本来就有的名字原样转发', async () => {
    await proxy.post('/wb/v1/chat/completions', { model: 'gpt-6-sol', messages: [] });
    assert.equal(models.pop(), 'gpt-6-sol');
  });

  await t.test('基础名不在目录里就一个字都不改（不猜）', async () => {
    await proxy.post('/wb/v1/chat/completions', { model: 'nosuchmodel-x0.5', messages: [] });
    assert.equal(models.pop(), 'nosuchmodel-x0.5', '基础名不在目录里，不许改');
    await proxy.post('/wb/v1/chat/completions', { model: 'plain-unknown', messages: [] });
    assert.equal(models.pop(), 'plain-unknown');
  });

  await t.test('目录只拉一次（10 分钟缓存）', () => {
    assert.equal(catalogHits, 1, `目录应缓存，实际拉了 ${catalogHits} 次`);
  });
});

test('出口整池没号：先如实报错，随后本地短路不再打上游', async (t) => {
  let chatCalls = 0;
  const hub = await startMockUpstream({
    onRequest: (req, res, seen) => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(CATALOG));
        return;
      }
      chatCalls++;
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: "no usable account for realm 'intl': all are disabled, cooling down, "
            + 'expired or parked by the daily token limit；各账号：ab12cd34 已停用',
        },
      }));
    },
  });
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wbdrain-'));
  writeKeys(workdir, { id: 'c-drain', name: '空池出口', port: hub.port });
  // 这条用例只验「短路本身」：预算设 0 = 不要在本地等（等待行为另有用例覆盖）
  const proxy = await startProxy({
    upstreamPort: hub.port, cwd: workdir,
    env: { WB_EXIT2_PORT: '0', WB_WAIT_BUDGET_MS: '0' },
  });
  t.after(async () => {
    await proxy.kill();
    await hub.close();
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  await t.test('第一次：真打上游，对外仍是通用话术', async () => {
    const r = await proxy.post('/wb/v1/chat/completions', CHAT);
    assert.equal(r.status, 502);
    const wire = JSON.stringify(await r.json());
    assert.ok(!LEAKY.test(wire), `不得出现后端字样：${wire}`);
    assert.match(wire, /暂时不可用/);
    assert.equal(chatCalls, 1);
  });

  await t.test('第二次：本地短路 503，不再打上游', async () => {
    const t0 = Date.now();
    const r = await proxy.post('/wb/v1/chat/completions', CHAT);
    const ms = Date.now() - t0;
    assert.equal(r.status, 503);
    const wire = JSON.stringify(await r.json());
    assert.ok(!LEAKY.test(wire), `不得出现后端字样：${wire}`);
    assert.match(wire, /暂时不可用/);
    assert.equal(chatCalls, 1, '短路期内不该再打上游一次');
    assert.ok(ms < 1500, `短路应当很快，实际 ${ms}ms`);
  });

  await t.test('面板能看到这个出口被短路', async () => {
    const v = await (await proxy.get('/admin/api/wb/channels')).json();
    assert.ok(v.channels[0].drainSec > 0, 'drainSec 应大于 0');
  });

  await t.test('手动重置后立刻重试（不再短路）', async () => {
    const r0 = await fetch(`${proxy.base}/admin/api/wb/channels/c-drain/reset`, { method: 'POST' });
    assert.equal(r0.status, 200);
    const r = await proxy.post('/wb/v1/chat/completions', CHAT);
    assert.equal(r.status, 502);
    assert.equal(chatCalls, 2, '重置后必须重新打上游');
  });
});

test('调用方自己的 400 不该把出口熔断', async (t) => {
  let chatCalls = 0;
  const hub = await startMockUpstream({
    onRequest: (req, res, seen) => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(CATALOG));
        return;
      }
      chatCalls++;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: '{"code":11102,"msg":"model [nosuchmodel] service info not found"}' },
      }));
    },
  });
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wb400-'));
  // 阈值调得很紧：只要 400 被算成错误，两次就会熔断
  writeKeys(workdir, { id: 'c-400', name: '400 出口', port: hub.port }, {
    wbBreaker: { slowMs: 60000, window: 4, slowCount: 4, errorCount: 2, openMs: 60000, maxOpenMs: 300000 },
  });
  const proxy = await startProxy({ upstreamPort: hub.port, cwd: workdir, env: { WB_EXIT2_PORT: '0' } });
  t.after(async () => {
    await proxy.kill();
    await hub.close();
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  for (let i = 0; i < 4; i++) {
    const r = await proxy.post('/wb/v1/chat/completions', { model: 'nosuchmodel', messages: [] });
    assert.equal(r.status, 400, `第 ${i + 1} 次仍应是上游的 400`);
    const wire = JSON.stringify(await r.json());
    assert.ok(!LEAKY.test(wire), `不得出现后端字样：${wire}`);
  }
  assert.equal(chatCalls, 4, '4 次都要真打上游（没被熔断挡掉）');
  const v = await (await proxy.get('/admin/api/wb/channels')).json();
  assert.equal(v.channels[0].breakerActive, false, '调用方打错模型名不该熔断出口');
  assert.equal(v.channels[0].stats.errorCount, 0, '这种 400 不该算进错误样本');
});

test('上游把「这个账号/渠道不可用」报成 400 时，对外必须是 5xx', async (t) => {
  // 线上实测：国际版出口的账号状态坏掉时，上游回 400 + code 11128
  // （conversation id missing / Illegal API invocation）。请求本身没问题，
  // 但 400 站点不会换渠道，直接甩给用户 —— 于是用户「一直报错」。
  let chatCalls = 0;
  const hub = await startMockUpstream({
    onRequest: (req, res, seen) => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(CATALOG));
        return;
      }
      chatCalls++;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '{"code":11128,"msg":"conversation id missing"}' } }));
    },
  });
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wb11128-'));
  writeKeys(workdir, { id: 'c-11128', name: '渠道级 400 出口', port: hub.port }, {
    wbBreaker: { slowMs: 60000, window: 4, slowCount: 4, errorCount: 2, openMs: 60000, maxOpenMs: 300000 },
  });
  const proxy = await startProxy({ upstreamPort: hub.port, cwd: workdir, env: { WB_EXIT2_PORT: '0' } });
  t.after(async () => {
    await proxy.kill();
    await hub.close();
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  await t.test('客户端看到的是 503 + 通用话术（不是 400）', async () => {
    const r = await proxy.post('/wb/v1/chat/completions', CHAT);
    assert.equal(r.status, 503, '必须是 5xx，站点才会换渠道');
    const wire = JSON.stringify(await r.json());
    assert.ok(!LEAKY.test(wire), `不得出现后端字样：${wire}`);
    assert.match(wire, /暂时不可用/);
  });

  await t.test('再打一次就够熔断（算渠道错误，不算调用方的错）', async () => {
    await proxy.post('/wb/v1/chat/completions', CHAT);
    const v = await (await proxy.get('/admin/api/wb/channels')).json();
    assert.equal(v.channels[0].stats.errorCount, 2, '两次都要算进错误样本');
    assert.equal(v.channels[0].breakerActive, true, '两次就该熔断');
  });

  await t.test('recent 环里同时留下「站点看到的 503」和「上游原始 400」', async () => {
    const v = await (await proxy.get('/admin/api/wb/channels')).json();
    const last = v.recent[v.recent.length - 1];
    assert.equal(last.status, 503);
    assert.match(String(last.err), /上游 400/, `环里要看得到上游原始状态：${last.err}`);
    assert.equal(chatCalls, 2);
  });
});

test('本出口没容量时自动换另一个版本（站点只有一条渠道也不报错）', async (t) => {
  // 线上就是这种局面：国际版整池没号，站点只开了一条渠道，站点自己换不过去 ——
  // 出口层直接拿国内版把结果拿出来，用户不看到错误。
  let intlCalls = 0;
  let cnCalls = 0;
  const intl = await startMockUpstream({
    onRequest: (req, res) => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(CATALOG));
        return;
      }
      intlCalls++;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: "no usable account for realm 'intl': all are disabled, cooling down",
        type: 'server_error', code: 503,
      }));
    },
  });
  const cn = await startMockUpstream({
    onRequest: (req, res) => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(CATALOG));
        return;
      }
      cnCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'chat.completion', model: 'deepseek-v4.1-flash' }));
    },
  });
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wbcross-'));
  writeFileSync(join(workdir, 'keys.json'), JSON.stringify({
    lb: {}, settings: {}, keys: [],
    wbChannels: [
      { id: 'c-i', name: '国际', realm: 'intl', hubUrl: `http://127.0.0.1:${intl.port}`, weight: 1, priority: 0, enabled: true },
      { id: 'c-c', name: '国内', realm: 'cn', hubUrl: `http://127.0.0.1:${cn.port}`, weight: 1, priority: 0, enabled: true },
    ],
  }, null, 2));
  // 预算设 0：这条只验「立刻换版本」，不验等待
  const proxy = await startProxy({
    upstreamPort: intl.port, cwd: workdir,
    env: { WB_EXIT2_PORT: '0', WB_WAIT_BUDGET_MS: '0' },
  });
  t.after(async () => {
    await proxy.kill();
    await Promise.all([intl.close(), cn.close()]);
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  await t.test('主端口（国际版没容量）由国内版兜底，客户端拿到 200', async () => {
    const r = await proxy.post('/wb/v1/chat/completions', CHAT);
    assert.equal(r.status, 200, '不该把错误甩给调用方');
    assert.equal(intlCalls, 1, '先试过国际版');
    assert.equal(cnCalls, 1, '再由国内版出结果');
  });

  await t.test('只在一版提供的模型不兜底（那边根本没有这个模型）', async () => {
    // 上一条把国际版标成「整池没号」了（12s 内本地短路）。面板「重置」会把短路一起
    // 清掉，这里正好顺带验一次。
    const reset = await fetch(`${proxy.base}/admin/api/wb/channels/c-i/reset`, { method: 'POST' });
    assert.equal(reset.status, 200);
    const beforeCn = cnCalls;
    const beforeIntl = intlCalls;
    const r = await proxy.post('/wb/v1/chat/completions', { model: 'gpt-6-astra', messages: [] });
    assert.notEqual(r.status, 200, 'gpt- 前缀是国际版专属，不该拿国内版去顶');
    assert.equal(cnCalls, beforeCn, '不该碰国内版');
    assert.equal(intlCalls, beforeIntl + 1, '重置后应重新打国际版一次');
  });

  await t.test('关掉兜底开关就恢复原样（返回错误）', async () => {
    const off = await startProxy({
      upstreamPort: intl.port, cwd: workdir,
      env: { WB_EXIT2_PORT: '0', WB_WAIT_BUDGET_MS: '0', WB_CROSS_REALM_FALLBACK: '0' },
    });
    try {
      const r = await off.post('/wb/v1/chat/completions', CHAT);
      assert.ok(r.status >= 500, `关掉兜底后应如实报错，实际 ${r.status}`);
      const wire = JSON.stringify(await r.json());
      assert.ok(!LEAKY.test(wire), `不得出现后端字样：${wire}`);
    } finally {
      await off.kill();
    }
  });
});

test('两个版本都没容量时：先等一会儿再试，池子恢复就出结果', async (t) => {
  // 「宁可让调用方多等几秒，也别直接报 503」：这条验等待之后确实会再打一次上游，
  // 池子在这期间恢复就正常出结果。
  let calls = 0;
  const hub = await startMockUpstream({
    onRequest: (req, res) => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(CATALOG));
        return;
      }
      calls++;
      if (calls === 1) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: "no usable account for realm 'intl': all are disabled, cooling down",
          type: 'server_error', code: 503,
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'chat.completion', model: 'deepseek-v4.1-flash' }));
    },
  });
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wbwait-'));
  writeKeys(workdir, { id: 'c-wait', name: '等待出口', port: hub.port });
  const proxy = await startProxy({
    upstreamPort: hub.port, cwd: workdir,
    env: { WB_EXIT2_PORT: '0', WB_WAIT_BUDGET_MS: '4000' },
  });
  t.after(async () => {
    await proxy.kill();
    await hub.close();
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  const r = await proxy.post('/wb/v1/chat/completions', CHAT);
  assert.equal(r.status, 200, '第二次尝试成功，调用方不该看到 503');
  assert.ok(calls >= 2, `等待后要真的再打一次上游（实际 ${calls} 次）`);
});

test('等也等不到（预算耗尽）才报错，而且报错前确实等过', async (t) => {
  let calls = 0;
  const hub = await startMockUpstream({
    onRequest: (req, res) => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(CATALOG));
        return;
      }
      calls++;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: "no usable account for realm 'intl': all are disabled, cooling down",
        type: 'server_error', code: 503,
      }));
    },
  });
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wbgiveup-'));
  writeKeys(workdir, { id: 'c-giveup', name: '一直没容量', port: hub.port });
  const proxy = await startProxy({
    upstreamPort: hub.port, cwd: workdir,
    env: { WB_EXIT2_PORT: '0', WB_WAIT_BUDGET_MS: '1500' },
  });
  t.after(async () => {
    await proxy.kill();
    await hub.close();
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  const t0 = Date.now();
  const r = await proxy.post('/wb/v1/chat/completions', CHAT);
  const ms = Date.now() - t0;
  assert.ok(r.status >= 500, `预算耗尽后如实报错，实际 ${r.status}`);
  assert.ok(ms >= 1000, `报错前要真的等过（实际 ${ms}ms）`);
  assert.ok(calls >= 2, `等待期间要重试（实际 ${calls} 次）`);
  const wire = JSON.stringify(await r.json());
  assert.ok(!LEAKY.test(wire), `不得出现后端字样：${wire}`);
  assert.match(wire, /暂时不可用/);
});
