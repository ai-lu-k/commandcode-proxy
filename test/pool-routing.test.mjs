// 本分支自研能力（Key 池 / 会话级调度 / 额度自动停用 / 轮询 / 数据卷）的回归测试。
//
// 上游测试假设「请求头带 key 直通（BYOK）」，而本分支固定从本地 Key 池取 key，
// 所以这里都用临时工作目录自己造一份 keys.json 来驱动调度逻辑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { REPO, startMockUpstream, startProxy } from './helpers.mjs';

const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

/** 造一个只属于本次测试的工作目录（自带 config.json 与 keys.json） */
function makeCwd(keys, settings = {}, lb = {}, defaultId = null) {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-pool-'));
  copyFileSync(join(REPO, 'config.json'), join(dir, 'config.json'));
  writeFileSync(join(dir, 'keys.json'), JSON.stringify({
    // 故意带上旧版本的旋钮：读取时应当被忽略
    lb: { strategy: 'weighted', stickyBy: 'client-key', maxRetries: 2, cooldownMs: 60000, expiryFirst: true, ...lb },
    settings: {
      mode: 'session', failThreshold: 3, sessionTtlMs: 21600000,
      creditsRefreshMs: 0, autoDisableExhausted: true, onAllExhausted: 'error', expiryBusyMs: 300000, ...settings,
    },
    keys, defaultId,
  }, null, 2));
  return dir;
}

/** 造一个 Key 池条目 */
function mkKey(id, label, key, extra = {}) {
  return {
    id, label, key, weight: 1, enabled: true, priority: 0, createdAt: Date.now(),
    lastUsedAt: null, lastErrorAt: null, errorCount: 0, cooldownUntil: 0,
    consecutiveFailures: 0, autoDisabled: null, credits: null, ...extra,
  };
}

/** 一份「窗口没用过」的额度数据 */
function freshCredits(remaining = 10) {
  return {
    fetchedAt: Date.now(), plan: 'test-plan',
    credits: { monthly: remaining, purchased: 0, free: 0, remaining },
    creditsRemaining: remaining,
    windows: [
      { name: '5h', used: 0, cap: 3, resetsAt: 0, pct: 0 },
      { name: 'weekly', used: 0, cap: 6, resetsAt: 0, pct: 0 },
    ],
    worstPct: 0,
  };
}

/** 带订阅到期时间的额度数据（CC /alpha/billing/subscriptions 的落地形状） */
function creditsWithExpiry(expiresAt, remaining = 10) {
  return {
    ...freshCredits(remaining),
    plan: 'individual-go',
    subscription: {
      planId: 'individual-go', status: 'active', createdAt: Date.now() - 86400000,
      currentPeriodStart: Date.now() - 86400000, currentPeriodEnd: expiresAt,
      cancelAt: null, canceledAt: null, endedAt: null, willRenew: true, expiresAt,
    },
    expiresAt,
  };
}

const DAY = 86400000;

const cleanup = (dir) => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };

test('Key 池：请求头里的 key 被忽略，实际用的是池内 key', async () => {
  const dir = makeCwd([mkKey('key_pool0001', 'poolA', 'user_poolAAAAAAAAAAAA0001')]);
  const mock = await startMockUpstream();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    const r = await proxy.post('/v1/chat/completions', CHAT, { Authorization: 'Bearer user_fromClientHeader9999' });
    assert.equal(r.status, 200);
    const sent = mock.lastGenerate();
    assert.ok(sent, 'mock 上游应收到 generate 请求');
    assert.match(sent.headers.authorization, /user_poolAAAAAAAAAAAA0001/, '上游应收到池内 key，而不是客户端 header 里的 key');
  } finally { await proxy.kill(); await mock.close(); cleanup(dir); }
});

test('会话粘性：同一会话固定同一个 Key，不同会话分散到不同 Key', async () => {
  const keys = [
    mkKey('key_s1', 'A', 'user_ssssssssssssssss0001', { credits: freshCredits() }),
    mkKey('key_s2', 'B', 'user_ssssssssssssssss0002', { credits: freshCredits() }),
    mkKey('key_s3', 'C', 'user_ssssssssssssssss0003', { credits: freshCredits() }),
  ];
  const dir = makeCwd(keys);
  const mock = await startMockUpstream();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    const sess = (id) => proxy.post('/v1/chat/completions', CHAT, { 'x-cc-session': id });
    await sess('sess-aaaaaa'); await sess('sess-bbbbbb'); await sess('sess-cccccc');
    const list = await (await proxy.get('/admin/api/sessions')).json();
    assert.equal(list.sessions.length, 3, '三个会话都应有绑定');
    const ids = list.sessions.map((s) => s.keyId);
    assert.equal(new Set(ids).size, 3, '三个会话应落在三个不同 Key 上');

    // 同一个会话再请求一次，必须还在原来的 Key
    const before = (await (await proxy.get('/admin/api/sessions')).json()).sessions.find((s) => s.id.includes('sess-aaaaaa'));
    await sess('sess-aaaaaa');
    const after = (await (await proxy.get('/admin/api/sessions')).json()).sessions.find((s) => s.id.includes('sess-aaaaaa'));
    assert.equal(after.keyId, before.keyId, '同一会话应保持同一 Key');
  } finally { await proxy.kill(); await mock.close(); cleanup(dir); }
});

test('额度用尽的 Key 自动停用，并按上游给的窗口重置时间恢复', async () => {
  const resetAt = Date.now() + 3 * 60 * 1000;
  const exhausted = {
    fetchedAt: Date.now(), plan: 'test-plan',
    credits: { monthly: 4, purchased: 0, free: 0, remaining: 4 }, creditsRemaining: 4,
    windows: [
      { name: '5h', used: 0, cap: 3, resetsAt: 0, pct: 0 },
      { name: 'weekly', used: 6, cap: 6, resetsAt: resetAt, pct: 100 },
    ],
    worstPct: 100,
  };
  const dir = makeCwd([
    mkKey('key_ex', 'exhausted', 'user_exxxxxxxxxxxxxxx0001', { credits: exhausted }),
    mkKey('key_ok', 'healthy', 'user_okokokokokokokok0001', { credits: freshCredits() }),
  ]);
  const mock = await startMockUpstream();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    const d = await (await proxy.get('/admin/api/keys')).json();
    const ex = d.keys.find((k) => k.id === 'key_ex');
    assert.ok(ex.autoDisabled, '周额度已满的 Key 应被自动停用');
    assert.ok(Math.abs(ex.autoDisabled.until - resetAt) < 5000, '恢复时间应取上游给的窗口重置时间');
    assert.equal(ex.activeSessions, 0);

    // 请求应只落到健康的那个 Key 上
    const r = await proxy.post('/v1/chat/completions', CHAT, { 'x-cc-session': 'sess-healthy' });
    assert.equal(r.status, 200);
    const list = await (await proxy.get('/admin/api/sessions')).json();
    assert.equal(list.sessions[0].keyId, 'key_ok', '会话应落到可用 Key 上');
  } finally { await proxy.kill(); await mock.close(); cleanup(dir); }
});

test('上游报额度用尽：自动换 Key 并停用出问题的 Key', async () => {
  const FAIL = 'user_failfailfailfail01';
  const resetSec = Math.floor((Date.now() + 3600_000) / 1000);
  const dir = makeCwd([
    mkKey('key_fail', 'quota-key', FAIL),
    mkKey('key_next', 'backup-key', 'user_backupbackupback01'),
  ], {}, { maxRetries: 2 });
  const mock = await startMockUpstream({
    onRequest(req, res) {
      if (req.url === '/alpha/generate' && String(req.headers.authorization || '').includes('failfail')) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: { code: 'RATE_LIMITED', status: 429, message: 'weekly usage limit reached' },
          rateLimit: { limit: 6, remaining: 0, reset: resetSec, window: 'weekly' },
        }));
      }
    },
  });
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    const r = await proxy.post('/v1/chat/completions', CHAT, { 'x-cc-session': 'sess-transfer' });
    assert.equal(r.status, 200, '第一个 Key 报额度用尽后应自动换到备用 Key 并成功');

    const d = await (await proxy.get('/admin/api/keys')).json();
    const bad = d.keys.find((k) => k.id === 'key_fail');
    assert.ok(bad.autoDisabled, '报额度用尽的 Key 应被停用');
    assert.ok(bad.consecutiveFailures >= 1, '应记录失败次数');

    const list = await (await proxy.get('/admin/api/sessions')).json();
    assert.equal(list.sessions[0].keyId, 'key_next', '会话应重绑到备用 Key');
  } finally { await proxy.kill(); await mock.close(); cleanup(dir); }
});

test('全池不可用时明确报错（onAllExhausted=error）', async () => {
  const dir = makeCwd([mkKey('key_off', 'off', 'user_offoffoffoffoffoff01', { enabled: false })]);
  const mock = await startMockUpstream();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    const r = await proxy.post('/v1/chat/completions', CHAT);
    assert.equal(r.status, 429, '池内没有可用 Key 时应返回 429 而不是硬跑');
    const body = await r.json();
    assert.match(body.error.message, /都不可用|池为空/);
  } finally { await proxy.kill(); await mock.close(); cleanup(dir); }
});

test('设置接口：轮询间隔可改，并会排定下次刷新', async () => {
  const dir = makeCwd([mkKey('key_set1', 'A', 'user_setsetsetsetset0001', { credits: freshCredits() })]);
  const mock = await startMockUpstream();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    const p2 = await proxy.get('/admin/api/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creditsRefreshMs: 60000, autoDisableExhausted: true }),
    });
    assert.equal(p2.status, 200);
    const d = await p2.json();
    assert.equal(d.settings.creditsRefreshMs, 60000);
    assert.ok(d.creditsRefresh.nextAt > 0, '应排定下次刷新时间');

    const got = await (await proxy.get('/admin/api/settings')).json();
    assert.equal(got.settings.creditsRefreshMs, 60000, '设置应持久化在服务端');
  } finally { await proxy.kill(); await mock.close(); cleanup(dir); }
});

test('CC_KEYS_FILE：Key 池写到指定路径（Docker 挂卷依赖这个）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ccp-keysfile-'));
  const custom = join(home, 'data', 'keys.json');
  const dir = makeCwd([mkKey('key_seed1', 'seed', 'user_seedseedseedseed01')]);
  const mock = await startMockUpstream();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir, env: { CC_KEYS_FILE: custom } });
  try {
    // 启动日志里应打印实际使用的路径
    assert.match(proxy.logs(), /Key pool loaded/, '应有 Key 池加载日志');
    // 通过 API 加一个 Key，应该写到 CC_KEYS_FILE 指定的位置
    const r = await proxy.post('/admin/api/keys', { key: 'user_viacustompath0001', label: 'venv', weight: 1, enabled: true });
    assert.equal(r.status, 201);
    assert.ok(existsSync(custom), `keys.json 应出现在 ${custom}`);
    const saved = JSON.parse(readFileSync(custom, 'utf8'));
    assert.ok(saved.keys.some((k) => k.key === 'user_viacustompath0001'), '写入的内容应包含新增的 Key');
  } finally { await proxy.kill(); await mock.close(); cleanup(dir); cleanup(home); }
});

/* ── keys.json 健壮性（BOM / 坏 JSON 都不能把池子搞丢）── */

test('keys.json 健壮性：带 BOM 能读出来，坏 JSON 会被挪到一边而不是被空池覆盖', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ccp-robust-'));
  copyFileSync(join(REPO, 'config.json'), join(home, 'config.json'));
  const p = join(home, 'keys.json');
  const mock = await startMockUpstream();
  const seed = {
    lb: { maxRetries: 1, cooldownMs: 60000 },
    settings: { mode: 'session' },
    keys: [mkKey('key_bom1', 'bom', 'user_bombombombombom01')],
  };

  // ① 带 BOM（Windows 记事本 / PowerShell 的默认产物）
  writeFileSync(p, '\uFEFF' + JSON.stringify(seed), 'utf8');
  let proxy = await startProxy({ upstreamPort: mock.port, cwd: home, env: { CC_KEYS_FILE: p } });
  try {
    const d = await (await proxy.get('/admin/api/keys')).json();
    assert.equal(d.keys.length, 1, '带 BOM 的 keys.json 也应该能读出来');
    assert.equal(d.keys[0].id, 'key_bom1');
  } finally { await proxy.kill(); }

  // ② 坏 JSON：挪到 .corrupt-* 留证据，而不是启动后把文件覆盖成空池
  writeFileSync(p, '{ oops', 'utf8');
  proxy = await startProxy({ upstreamPort: mock.port, cwd: home, env: { CC_KEYS_FILE: p } });
  try {
    const d = await (await proxy.get('/admin/api/keys')).json();
    assert.equal(d.keys.length, 0, '读不出来时池子为空');
    assert.match(proxy.logs(), /Key pool unreadable/, '应留下一条明确的错误日志');
    const bak = readdirSync(home).find((f) => f.startsWith('keys.json.corrupt-'));
    assert.ok(bak, '坏文件应被改名成 keys.json.corrupt-*');
    assert.equal(readFileSync(join(home, bak), 'utf8'), '{ oops', '原文件内容必须原样保留');
  } finally { await proxy.kill(); await mock.close(); cleanup(home); }
});

/* ── 池内选取顺序：真空闲 → 相对空闲 → priority → 到期 ── */

/** 三个 Key：e1 最快到期（3 天）、e2（10 天）、e3（30 天）——故意打乱定义顺序 */
function expiryKeys(base = Date.now()) {
  return [
    mkKey('key_e3', 'late', 'user_eeeeeeeeeeeeeeee0003', { credits: creditsWithExpiry(base + 30 * DAY) }),
    mkKey('key_e1', 'soon', 'user_eeeeeeeeeeeeeeee0001', { credits: creditsWithExpiry(base + 3 * DAY) }),
    mkKey('key_e2', 'mid', 'user_eeeeeeeeeeeeeeee0002', { credits: creditsWithExpiry(base + 10 * DAY) }),
  ];
}

/** 某个会话当前绑在哪个 Key 上 */
async function boundKey(proxy, tag) {
  const list = await (await proxy.get('/admin/api/sessions')).json();
  const s = list.sessions.find((x) => x.id.includes(tag));
  return s ? s.keyId : null;
}

test('选取顺序：真空闲的 Key 按订阅最早到期逐个占用，已有会话的让位', async () => {
  const dir = makeCwd(expiryKeys());
  const mock = await startMockUpstream();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  const sess = (id) => proxy.post('/v1/chat/completions', CHAT, { 'x-cc-session': id });
  try {
    await sess('sess-x-aaaaaa');
    assert.equal(await boundKey(proxy, 'sess-x-aaaaaa'), 'key_e1', '第一个会话应落在订阅最快到期的空闲 Key');

    // key_e1 已经有会话（不再真空闲）→ 下一个真空闲的是 key_e2
    await sess('sess-x-bbbbbb');
    assert.equal(await boundKey(proxy, 'sess-x-bbbbbb'), 'key_e2', '有人用的 Key 应让位给下一个真空闲的 Key');

    await sess('sess-x-cccccc');
    assert.equal(await boundKey(proxy, 'sess-x-cccccc'), 'key_e3', '三个 Key 应各占一个');

    // 四个会话 > 三个 Key：多出来的回到订阅最早到期的那个
    await sess('sess-x-dddddd');
    assert.equal(await boundKey(proxy, 'sess-x-dddddd'), 'key_e1', '都不空闲时按到期顺序回头复用');

    // 已有会话保持粘性，不因为排序被抢走
    await sess('sess-x-aaaaaa');
    assert.equal(await boundKey(proxy, 'sess-x-aaaaaa'), 'key_e1', '已有会话不应被抢走');
  } finally { await proxy.kill(); await mock.close(); cleanup(dir); }
});

test('选取顺序：同为真空闲时先比 priority（数字小的优先），再比到期时间', async () => {
  const base = Date.now();
  const dir = makeCwd([
    // 优先级低的到期更早：如果先比到期时间就会选错
    mkKey('key_p9', 'low', 'user_prioprioprioprio09', { priority: 9, credits: creditsWithExpiry(base + 2 * DAY) }),
    mkKey('key_p0', 'high', 'user_prioprioprioprio00', { priority: 0, credits: creditsWithExpiry(base + 20 * DAY) }),
  ]);
  const mock = await startMockUpstream();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    await proxy.post('/v1/chat/completions', CHAT, { 'x-cc-session': 'sess-prio-aa' });
    assert.equal(await boundKey(proxy, 'sess-prio-aa'), 'key_p0', '同一层内 priority 小的先选，不被到期时间抢走');
  } finally { await proxy.kill(); await mock.close(); cleanup(dir); }
});

test('选取顺序：真空闲优先于 priority（高优先级 Key 有人用了就让位）', async () => {
  const dir = makeCwd([
    mkKey('key_hi', 'hi', 'user_idleidleidleidle01', { priority: 0, credits: freshCredits() }),
    mkKey('key_lo', 'lo', 'user_idleidleidleidle02', { priority: 9, credits: freshCredits() }),
  ]);
  const mock = await startMockUpstream();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  const sess = (id) => proxy.post('/v1/chat/completions', CHAT, { 'x-cc-session': id });
  try {
    await sess('sess-i-aaaaaa');
    assert.equal(await boundKey(proxy, 'sess-i-aaaaaa'), 'key_hi', '都真空闲时先比 priority');

    await sess('sess-i-bbbbbb');
    assert.equal(await boundKey(proxy, 'sess-i-bbbbbb'), 'key_lo', 'key_hi 已有会话 → 让位给真空闲的低优先级 Key');

    await sess('sess-i-cccccc');
    assert.equal(await boundKey(proxy, 'sess-i-cccccc'), 'key_hi', '两个都不是真空闲时，回到 priority 比较');
  } finally { await proxy.kill(); await mock.close(); cleanup(dir); }
});

test('选取顺序：都不空闲时优先选活跃会话最少的 Key（相对空闲）', async () => {
  const dir = makeCwd([
    mkKey('key_a', 'A', 'user_relativeidle000001'),
    mkKey('key_b', 'B', 'user_relativeidle000002'),
  ]);
  const mock = await startMockUpstream();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    for (let i = 0; i < 4; i++) {
      const r = await proxy.post('/v1/chat/completions', CHAT, { 'x-cc-session': `sess-r-${i}000000` });
      assert.equal(r.status, 200);
    }
    const list = await (await proxy.get('/admin/api/sessions')).json();
    const tally = {};
    for (const s of list.sessions) tally[s.keyId] = (tally[s.keyId] || 0) + 1;
    assert.equal(tally.key_a, 2);
    assert.equal(tally.key_b, 2);
  } finally { await proxy.kill(); await mock.close(); cleanup(dir); }
});

test('默认 Key 已取消：defaultId 不再影响选取，也不再写回 keys.json', async () => {
  const base = Date.now();
  const keys = [
    mkKey('key_d9', 'later', 'user_defaultdefault0009', { credits: creditsWithExpiry(base + 20 * DAY) }),
    mkKey('key_d1', 'soon', 'user_defaultdefault0001', { credits: creditsWithExpiry(base + 2 * DAY) }),
  ];
  const dir = makeCwd(keys, {}, {}, 'key_d9');   // 旧配置里指定的默认 Key
  const mock = await startMockUpstream();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    await proxy.post('/v1/chat/completions', CHAT, { 'x-cc-session': 'sess-d-aaaaaa' });
    assert.equal(await boundKey(proxy, 'sess-d-aaaaaa'), 'key_d1', '默认 Key 不再有特权，仍按空闲顺序选');

    // 任意一次落盘都不应再写 defaultId / 旧策略字段
    const patch = await proxy.get('/admin/api/keys/key_d9', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ weight: 2 }),
    });
    assert.equal(patch.status, 200);
    const saved = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8'));
    assert.equal(saved.defaultId, undefined, 'defaultId 不应再写回');
    assert.equal(saved.lb.strategy, undefined, '旧的 strategy 字段不应再写回');
    assert.equal(saved.lb.expiryFirst, undefined, '旧的 expiryFirst 字段不应再写回');
    assert.equal(saved.settings.expiryBusyMs, undefined, '旧的 expiryBusyMs 不应再写回');
    assert.deepEqual(Object.keys(saved.lb).sort(), ['cooldownMs', 'maxRetries']);
  } finally { await proxy.kill(); await mock.close(); cleanup(dir); }
});

test('选取顺序：request 模式下在途请求占用的 Key 会让位', async () => {
  const now = Date.now();
  const keys = [
    mkKey('key_i1', 'soon', 'user_iiiiiiiiiiiiiiii0001', { credits: creditsWithExpiry(now + 1 * DAY) }),
    mkKey('key_i2', 'later', 'user_iiiiiiiiiiiiiiii0002', { credits: creditsWithExpiry(now + 5 * DAY) }),
  ];
  const dir = makeCwd(keys, { mode: 'request' }, { maxRetries: 5 });
  let release = () => {};
  const gate = new Promise((r) => { release = r; });
  let held = false;
  const mock = await startMockUpstream({
    async onRequest(req, res) {
      if (req.url === '/alpha/generate' && !held) { held = true; await gate; }
    },
  });
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    const first = proxy.post('/v1/chat/completions', CHAT); // 落在 key_i1 并卡在上游
    for (let i = 0; i < 100 && !held; i++) await sleep(50);
    assert.ok(held, '第一个请求应已到达上游并保持未结束');

    // key_i1 仍在途 → 第二个请求应挑真空闲的那个
    const second = await proxy.post('/v1/chat/completions', CHAT);
    assert.equal(second.status, 200);

    release();
    assert.equal((await first).status, 200);

    const sentKeyIds = mock.seen
      .filter((s) => s.url === '/alpha/generate')
      .map((s) => (/user_i+0002/.test(String(s.headers.authorization || '')) ? 'key_i2' : 'key_i1'));
    assert.equal(sentKeyIds[0], 'key_i1', '第一个请求应落在订阅最快到期的 key_i1');
    assert.ok(sentKeyIds.includes('key_i2'), `在途占用的 Key 应让位给真空闲的 Key，实际顺序：${sentKeyIds.join(' → ')}`);
  } finally { release(); await proxy.kill(); await mock.close(); cleanup(dir); }
});

test('管理接口：poolOrder 透出选取顺序，lb 只剩两个旋钮，旧字段静默忽略', async () => {
  const now = Date.now();
  const expiresAt = now + 7 * DAY;
  const dir = makeCwd([mkKey('key_sub1', 'A', 'user_subsubsubsubsub01', { credits: creditsWithExpiry(expiresAt) })]);
  const mock = await startMockUpstream();
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir });
  try {
    const d = await (await proxy.get('/admin/api/keys')).json();
    assert.deepEqual(Object.keys(d.lb).sort(), ['cooldownMs', 'maxRetries'], 'lb 只应暴露还在用的旋钮');
    assert.equal(d.defaultId, undefined, '不应再有默认 Key 字段');
    assert.ok(Array.isArray(d.poolOrder), '应透出池内选取顺序');
    assert.equal(d.poolOrder[0].id, 'key_sub1');
    assert.equal(d.poolOrder[0].idle, true, '没有会话/在途的 Key 是真空闲');
    assert.equal(d.poolOrder[0].sessions, 0);
    assert.equal(d.poolOrder[0].inflight, 0);
    assert.equal(d.keys[0].expiresAt, expiresAt, '列表里应带订阅到期时间');
    assert.equal(d.keys[0].credits.subscription.planId, 'individual-go');
    assert.equal(d.keys[0].isDefault, undefined, '卡片数据里不应再带 isDefault');

    // 旧字段（strategy / expiryFirst / expiryBusyMs）照旧传也不该报错，只是被忽略
    const put = await proxy.get('/admin/api/lb', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxRetries: 3, cooldownMs: 30000, strategy: 'round-robin', expiryFirst: false }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { maxRetries: 3, cooldownMs: 30000 });

    const saved = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8'));
    assert.deepEqual(saved.lb, { maxRetries: 3, cooldownMs: 30000 }, '旧旋钮不应落盘');
  } finally { await proxy.kill(); await mock.close(); cleanup(dir); }
});
