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
  const proxy = await startProxy({ upstreamPort: hub.port, cwd: workdir, env: { WB_EXIT2_PORT: '0' } });
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
