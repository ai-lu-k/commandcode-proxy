// WorkBuddy 逐账号管理：反代把 hub 面板的 /accounts/set 包一层，前端的启用/停用
// 与权重就是打这条路。这里用一个假 hub 验整条链路（含面板令牌）：
//   前端 POST /admin/api/workbuddy/accounts/set {uid, enabled}
//     -> 反代 wbHubLogin 拿 X-Panel-Token
//     -> 转发到 hub POST /accounts/set {uid, enabled}
//
// 起因：线上只能整个出口（国际版/国内版）开关，某个号积分耗尽或反复熔断时，
// 没法只把它一个摘出去，只能整版停掉，等于误伤同版的其它账号。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocPort, closeServer, startProxy } from './helpers.mjs';

/** 假 hub：只实现面板登录 + /accounts/set + /accounts，其余 404。 */
async function startMockHub() {
  const port = await allocPort();
  const seen = [];
  const state = {
    'u-aaa': { uid: 'u-aaa', nickname: '一号', realm: 'intl', enabled: true, weight: 1 },
    'u-bbb': { uid: 'u-bbb', nickname: '二号', realm: 'cn', enabled: true, weight: 1 },
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://x');
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      seen.push({ path: url.pathname, method: req.method, headers: req.headers, body });

      const json = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (url.pathname === '/panel/login') {
        if (body.password !== 'pw-test') return json(401, { error: { message: 'bad password' } });
        return json(200, { token: 'tok-123' });
      }
      // 面板路由必须带对令牌
      if (req.headers['x-panel-token'] !== 'tok-123') {
        return json(401, { error: { message: 'panel token required' } });
      }
      if (url.pathname === '/accounts' && req.method === 'GET') {
        const realm = url.searchParams.get('realm');
        return json(200, {
          accounts: Object.values(state).filter((a) => !realm || a.realm === realm),
        });
      }
      if (url.pathname === '/accounts/set' && req.method === 'POST') {
        const a = state[body.uid];
        if (!a) return json(404, { error: { message: 'no such account' } });
        if ('enabled' in body) a.enabled = !!body.enabled;
        if ('weight' in body) a.weight = Number(body.weight);
        return json(200, { ok: true, account: a });
      }
      return json(404, { error: { message: 'unknown: ' + url.pathname } });
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { port, seen, state, close: () => closeServer(server) };
}

test('逐账号开关：前端改单个账号，hub 只收到那一个的指令', async (t) => {
  const hub = await startMockHub();
  const workdir = mkdtempSync(join(tmpdir(), 'ccp-wbacc-'));
  // workbuddy 整块配置走 config.json（hubPanelPassword 也在里面）
  writeFileSync(join(workdir, 'config.json'), JSON.stringify({
    port: 0, host: '127.0.0.1',
    apiBase: 'http://127.0.0.1:9',
    workbuddy: {
      enabled: true,
      hubUrl: `http://127.0.0.1:${hub.port}`,
      upstreamUrl: 'http://127.0.0.1:9',
      managerUrl: 'http://127.0.0.1:9',
      hubPanelPassword: 'pw-test',
    },
  }, null, 2));
  writeFileSync(join(workdir, 'keys.json'), JSON.stringify({
    lb: {}, settings: {}, keys: [],
  }, null, 2));

  const proxy = await startProxy({
    upstreamPort: 9, cwd: workdir,
    // 出口关掉：这个用例只验面板路由，不验转发
    env: { WB_EXIT2_PORT: '0' },
  });
  t.after(async () => {
    await proxy.kill();
    await hub.close();
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  await t.test('账号列表按版本合并（两个 realm 各取一次）', async () => {
    const j = await (await proxy.get('/admin/api/workbuddy/accounts')).json();
    assert.equal(j.accounts.length, 2);
    assert.deepEqual(j.realms, { intl: 1, cn: 1 });
    assert.equal(j.usable, 2);
    const login = hub.seen.filter((s) => s.path === '/panel/login');
    assert.ok(login.length >= 1, '要先登录面板拿令牌');
    const list = hub.seen.filter((s) => s.path === '/accounts');
    assert.ok(list.every((s) => s.headers['x-panel-token'] === 'tok-123'), '列表请求必须带面板令牌');
  });

  await t.test('停用单个账号 → 只有它被停用', async () => {
    const r = await fetch(`${proxy.base}/admin/api/workbuddy/accounts/set`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'u-bbb', enabled: false }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.account.enabled, false);
    assert.equal(hub.state['u-aaa'].enabled, true, '同版另一个账号不该被牵连');

    const list = await (await proxy.get('/admin/api/workbuddy/accounts')).json();
    assert.equal(list.usable, 1, '可用数要跟着变成 1');
  });

  await t.test('改权重也走同一条路', async () => {
    const r = await fetch(`${proxy.base}/admin/api/workbuddy/accounts/set`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'u-aaa', weight: 5 }),
    });
    assert.equal(r.status, 200);
    assert.equal(hub.state['u-aaa'].weight, 5);
    assert.equal(hub.state['u-bbb'].weight, 1);
  });

  await t.test('未知 uid 时 hub 的 404 原样透出', async () => {
    const r = await fetch(`${proxy.base}/admin/api/workbuddy/accounts/set`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: 'u-nope', enabled: false }),
    });
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.match(j.error?.message || '', /no such account/);
  });
});
