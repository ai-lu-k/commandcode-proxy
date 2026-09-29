// 告警系统单测：
//   · 检查逻辑（余额 / 池健康 / 失败率）用合成数据，不打真实上游
//   · SMTP 用进程内的假服务器真连一遍（EHLO 多行应答 / AUTH LOGIN / DATA / 中文主题）
//   · 引擎跑去重 / 恢复 / 限速，用本地 HTTP 端点当 webhook 通道
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ALERT_DEFAULTS, normalizeAlerts, normalizeRecipients, applyEnvOverrides, maskConfig,
  checkKeyCredits, checkPoolHealth, checkFailureStats, buildAlertText, buildEmail,
  encodeHeader, smtpSend, detectWebhookType, buildWebhookBody, postWebhook,
  createAlerts, defaultStatePath,
} from '../alerts.mjs';

const CFG = normalizeAlerts({});
const now = () => Date.now();

// ── 配置 ──────────────────────────────────────────────
test('normalizeAlerts：默认值 / 脏数据收敛 / 端口猜 secure', () => {
  const d = normalizeAlerts(null);
  assert.equal(d.enabled, true);
  assert.equal(d.email.port, 465);
  assert.equal(d.email.secure, true);
  assert.deepEqual(d.email.to, []);
  assert.equal(d.minCreditsPerKey, ALERT_DEFAULTS.minCreditsPerKey);

  const odd = normalizeAlerts({
    enabled: 'no-such-value',
    email: { port: 587, to: 'a@x.com, b@y.com;bad-addr', pass: 12345 },
    windowMs: 5,
    failureRateWarn: 999,
    unknownField: 1,
  });
  assert.equal(odd.enabled, true);                  // 只有明确的 false 才关
  assert.equal(odd.email.port, 587);
  assert.equal(odd.email.secure, false);            // 587 → 非隐式 TLS
  assert.deepEqual(odd.email.to, ['a@x.com', 'b@y.com']);
  assert.equal(odd.email.pass, '12345');
  assert.equal(odd.windowMs, 30 * 1000);            // 收敛到下限
  assert.equal(odd.failureRateWarn, 100);
  assert.equal(odd.unknownField, undefined);

  assert.equal(normalizeAlerts({ enabled: false }).enabled, false);
  assert.deepEqual(normalizeRecipients(['a@b.co', 'a@b.co', ' ', 'x']), ['a@b.co']);
});

test('applyEnvOverrides：环境变量能覆写并叠加收件人', () => {
  const base = normalizeAlerts({ email: { host: 'old.example', to: ['keep@x.com'] } });
  const env = applyEnvOverrides(base, {
    CC_ALERT_ENABLED: 'false',
    CC_ALERT_SMTP_HOST: 'smtp.qq.com',
    CC_ALERT_SMTP_PORT: '465',
    CC_ALERT_SMTP_USER: 'me@qq.com',
    CC_ALERT_SMTP_PASS: 'authcode',
    CC_ALERT_TO: 'boss@x.com',
    CC_ALERT_WEBHOOK: 'https://example.com/hook',
  });
  assert.equal(env.enabled, false);
  assert.equal(env.email.host, 'smtp.qq.com');
  assert.equal(env.email.user, 'me@qq.com');
  assert.equal(env.email.pass, 'authcode');
  assert.deepEqual(env.email.to, ['keep@x.com', 'boss@x.com']);
  assert.equal(env.email.from, '');                 // from 未设 → 发送时回退到 user
  assert.equal(env.channels.webhook, true);
  // 不改变原对象
  assert.equal(base.email.host, 'old.example');
});

test('maskConfig：不回传密码，并给出通道就绪状态', () => {
  const masked = maskConfig(normalizeAlerts({
    email: { host: 'smtp.qq.com', user: 'me@qq.com', pass: 'secret', to: ['me@qq.com'] },
  }));
  assert.equal(masked.email.pass, '');
  assert.equal(masked.email.passSet, true);
  assert.equal(masked.effective.emailReady, true);
  assert.equal(masked.effective.logOnly, false);
  assert.equal(JSON.stringify(masked).includes('secret'), false);

  const none = maskConfig(normalizeAlerts({}));
  assert.equal(none.effective.logOnly, true);
  assert.equal(none.effective.emailReady, false);
});

// ── 余额检查 ──────────────────────────────────────────
const key = (over = {}) => ({
  id: 'key_1', label: '主力号', enabled: true,
  credits: { creditsRemaining: 100, credits: { monthly: 100, purchased: 0, free: 0 }, windows: [] },
  ...over,
});

test('checkKeyCredits：余额充足时不告警', () => {
  assert.deepEqual(checkKeyCredits(key(), CFG), []);
});

test('checkKeyCredits：余额偏低 / 用尽 / 窗口将满 / 窗口已满', () => {
  const low = checkKeyCredits(key({ credits: { creditsRemaining: 3, credits: { monthly: 3 }, windows: [] } }), CFG);
  assert.equal(low.length, 1);
  assert.equal(low[0].id, 'credits-low:key_1');
  assert.equal(low[0].level, 'warn');

  const zero = checkKeyCredits(key({ credits: { creditsRemaining: 0, credits: { monthly: 0 }, windows: [] } }), CFG);
  assert.equal(zero[0].id, 'credits-exhausted:key_1');
  assert.equal(zero[0].level, 'critical');

  const warnWin = checkKeyCredits(key({
    credits: { creditsRemaining: 50, windows: [{ name: 'weekly', used: 88, cap: 100, pct: 88 }] },
  }), CFG);
  assert.equal(warnWin[0].id, 'window-high:key_1:weekly');
  assert.equal(warnWin[0].level, 'warn');
  assert.match(warnWin[0].detail, /周窗口 88%/);

  const fullWin = checkKeyCredits(key({
    credits: { creditsRemaining: 50, windows: [{ name: '5h', used: 100, cap: 100, pct: 100, resetsAt: Date.now() + 3600000 }] },
  }), CFG);
  assert.equal(fullWin[0].id, 'credits-exhausted:key_1');
  assert.equal(fullWin[0].level, 'critical');
  assert.match(fullWin[0].detail, /5 小时窗口 100%/);
});

test('checkKeyCredits：自动停用（额度/凭证）、查询失败、手动停用', () => {
  const auto = checkKeyCredits(key({ autoDisabled: { reason: 'quota-exhausted', at: Date.now(), until: Date.now() + 60000 } }), CFG);
  assert.equal(auto[0].id, 'credits-exhausted:key_1');

  const invalid = checkKeyCredits(key({ autoDisabled: { reason: 'disabled', at: Date.now(), until: null } }), CFG);
  assert.equal(invalid[0].id, 'key-invalid:key_1');
  assert.equal(invalid[0].level, 'critical');

  const qerr = checkKeyCredits(key({ credits: { error: 'HTTP 500' } }), CFG);
  assert.equal(qerr.length, 1);
  assert.equal(qerr[0].id, 'key-query-failed:key_1');
  assert.match(qerr[0].detail, /HTTP 500/);

  // 用户主动停用的 Key 不参与告警
  assert.deepEqual(checkKeyCredits(key({ enabled: false, credits: { creditsRemaining: 0 } }), CFG), []);
});

test('checkPoolHealth：可用数为 0 / 低于阈值 / 额度轮询失败', () => {
  const keys = [key(), key({ id: 'key_2', label: '备用号' })];
  assert.deepEqual(checkPoolHealth({ keys, usableCount: 2, creditsRefresh: null, cfg: CFG }), []);

  const warn = checkPoolHealth({ keys, usableCount: 1, creditsRefresh: null, cfg: CFG });
  assert.equal(warn[0].id, 'usable-keys-low:pool');
  assert.equal(warn[0].level, 'warn');

  const crit = checkPoolHealth({ keys, usableCount: 0, creditsRefresh: null, cfg: CFG });
  assert.equal(crit[0].id, 'pool-unavailable:pool');
  assert.equal(crit[0].level, 'critical');

  const off = checkPoolHealth({ keys: [key({ enabled: false })], usableCount: 0, creditsRefresh: null, cfg: CFG });
  assert.equal(off[0].id, 'pool-empty:pool');

  const fetchFail = checkPoolHealth({
    keys, usableCount: 2, cfg: CFG,
    creditsRefresh: { lastAt: Date.now(), lastOk: 0, lastFailed: 3, lastError: '3 个 Key 查询失败' },
  });
  const f = fetchFail.find((x) => x.id === 'fetch-failed:pool');
  assert.equal(f.level, 'critical');                 // 全部失败 → 严重
  assert.match(f.detail, /成功 0 · 失败 3/);
});

// ── 失败率 ────────────────────────────────────────────
const samples = (n, failed) => Array.from({ length: n }, (_, i) => ({ ts: Date.now(), ok: i >= failed }));

test('checkFailureStats：样本不足不评估，超阈值给警告/严重', () => {
  const few = checkFailureStats({ samples: samples(3, 3), faults: [], consecutiveFailures: 0, cfg: CFG, now: Date.now() });
  assert.deepEqual(few.findings, []);
  assert.equal(few.stats.rate, 100);

  const warn = checkFailureStats({ samples: samples(10, 4), faults: [], consecutiveFailures: 0, cfg: CFG, now: Date.now() });
  const wf = warn.findings.find((f) => f.id === 'failure-rate:pool');
  assert.equal(wf.level, 'warn');
  assert.equal(warn.stats.rate, 40);

  const crit = checkFailureStats({ samples: samples(10, 8), faults: [], consecutiveFailures: 0, cfg: CFG, now: Date.now() });
  assert.equal(crit.findings.find((f) => f.id === 'failure-rate:pool').level, 'critical');
});

test('checkFailureStats：连续失败 / 额度故障 / 卡顿 / 并发超限', () => {
  const t = Date.now();
  const { findings, stats } = checkFailureStats({
    samples: samples(10, 4),
    faults: [
      { ts: t, kind: 'quota', trigger: 'quota-exhausted', label: '主力号' },
      { ts: t, kind: 'quota', trigger: 'disabled', label: '备用号' },
      { ts: t, kind: 'quota', trigger: 'quota-exhausted', label: '主力号' },
      { ts: t, kind: 'stall' }, { ts: t, kind: 'stall' }, { ts: t, kind: 'stall' },
      { ts: t, kind: 'inflight' }, { ts: t, kind: 'inflight' }, { ts: t, kind: 'inflight' },
      { ts: t, kind: 'inflight' }, { ts: t, kind: 'inflight' },
      { ts: t - 60 * 60 * 1000, kind: 'quota', label: '过期样本' },   // 窗口外
    ],
    consecutiveFailures: 6, cfg: CFG, now: t,
  });
  const ids = findings.map((f) => f.id);
  assert.deepEqual(ids.sort(), ['consecutive-failures:pool', 'failure-rate:pool', 'inflight:pool', 'quota-faults:pool', 'stalls:pool']);
  assert.equal(stats.quota, 3);
  assert.equal(stats.stall, 3);
  assert.equal(stats.inflight, 5);
  assert.match(findings.find((f) => f.id === 'quota-faults:pool').detail, /主力号、备用号/);
});

// ── 文本 / 邮件 ───────────────────────────────────────
test('buildAlertText：标题分级 + 正文含明细与池快照', () => {
  const snap = {
    total: 2, usable: 1, creditsAt: Date.now(), cfg: CFG, adminUrl: 'http://localhost:3050/',
    keys: [{ id: 'key_1', label: '主力号', credits: { creditsRemaining: 0, windows: [{ name: '5h', pct: 100 }] }, autoDisabled: { reason: 'quota-exhausted' } }],
    keysTruncated: 1,
  };
  const out = buildAlertText({
    findings: [{ level: 'critical', title: '余额/额度已用尽 · 主力号', detail: '剩余额度 0' }],
    snapshot: snap, now: Date.now(), host: 'test-host',
  });
  assert.match(out.subject, /^\[CC-Proxy 严重\] 余额\/额度已用尽 · 主力号$/);
  assert.match(out.text, /主机：test-host/);
  assert.match(out.text, /━━ 严重（1 项）━━/);
  assert.match(out.text, /主力号  剩余 0 · 5h 100% \[自动停用：quota-exhausted\]/);
  assert.match(out.text, /另有 1 个 Key/);
  assert.match(out.text, /管理台：http:\/\/localhost:3050\//);

  const warn = buildAlertText({ findings: [{ level: 'warn', title: 'a' }, { level: 'warn', title: 'b' }], now: Date.now() });
  assert.match(warn.subject, /^\[CC-Proxy 警告\] a 等 2 项$/);

  const rec = buildAlertText({ findings: [], recovery: [{ level: 'recovery', title: '余额偏低 · 主力号' }], now: Date.now() });
  assert.match(rec.subject, /^\[CC-Proxy 已恢复\]/);
});

test('buildEmail：中文主题 RFC2047 编码、正文 base64、收件人数组', () => {
  const { raw, recipients } = buildEmail({
    from: 'cc@x.com', to: ['a@x.com', 'b@y.com'], subject: '余额告警 · 主力号', text: '第一行\n第二行',
  });
  assert.deepEqual(recipients, ['a@x.com', 'b@y.com']);
  const [head, body] = raw.split('\r\n\r\n');
  assert.match(head, /^From: cc@x\.com$/m);
  assert.match(head, /^To: a@x\.com, b@y\.com$/m);
  assert.match(head, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(head, /^Content-Transfer-Encoding: base64$/m);
  // 主题可还原
  const b64 = head.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m)[1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), '余额告警 · 主力号');
  // 正文可还原（行宽 ≤76）
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), '第一行\n第二行');
  assert.equal(body.split('\r\n').every((l) => l.length <= 76), true);
  assert.equal(encodeHeader('你好'), '=?UTF-8?B?5L2g5aW9?=');
  assert.throws(() => buildEmail({ from: 'x@y.com', to: 'not-an-email', subject: 's', text: 't' }), /收件人/);
});

test('detectWebhookType / buildWebhookBody：按平台出格式', () => {
  assert.equal(detectWebhookType('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=1'), 'wecom');
  assert.equal(detectWebhookType('https://api.day.app/xxxx'), 'bark');
  assert.equal(detectWebhookType('https://sctapi.ftqq.com/SCT123.send'), 'serverchan');
  assert.equal(detectWebhookType('https://example.com/hook'), 'generic');
  assert.equal(detectWebhookType('https://example.com/hook', 'bark'), 'bark');

  const wecom = buildWebhookBody('wecom', { subject: 'S', text: 'T', level: 'critical' });
  assert.equal(wecom.msgtype, 'markdown');
  assert.match(wecom.markdown.content, /^\*\*S\*\*/);
  const bark = buildWebhookBody('bark', { subject: 'S', text: 'T', level: 'critical' });
  assert.equal(bark.level, 'timeSensitive');
  assert.equal(bark.group, 'CC-Proxy');
  const generic = buildWebhookBody('generic', { subject: 'S', text: 'T', level: 'warn' });
  assert.equal(generic.source, 'commandcode-proxy');
  assert.equal(generic.title, 'S');
});

// ── 假 SMTP：真连一遍 ─────────────────────────────────
/** 最小 SMTP 服务器：多行 EHLO 应答 + 可选 AUTH LOGIN + DATA 收集 */
function startFakeSmtp({ auth = false, greeting = 220 } = {}) {
  const received = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let dataLines = [];
    let stage = 0;                  // 1=等用户名 2=等密码
    let user = null;
    let pwd = null;
    const send = (line) => sock.write(line + '\r\n');
    send(String(greeting) + ' fake ESMTP ready');

    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push({ raw: dataLines.join('\r\n'), user, pwd });
            dataLines = [];
            send('250 2.0.0 Ok: queued as FAKE1');
          } else {
            dataLines.push(line);
          }
          continue;
        }
        const cmd = line.split(' ')[0].toUpperCase();
        if (stage === 1) { user = Buffer.from(line, 'base64').toString('utf8'); stage = 2; send('334 UGFzc3dvcmQ6'); continue; }
        if (stage === 2) { pwd = Buffer.from(line, 'base64').toString('utf8'); stage = 0; send('235 2.7.0 Authentication successful'); continue; }
        if (cmd === 'EHLO' || cmd === 'HELO') {
          send('250-fake.localhost greets you');
          if (auth) send('250-AUTH LOGIN PLAIN');
          send('250 SIZE 10485760');
        } else if (cmd === 'AUTH') {
          if (!auth) { send('502 5.5.1 Command not implemented'); continue; }
          if (/^AUTH LOGIN/i.test(line)) { stage = 1; send('334 VXNlcm5hbWU6'); }
          else if (/^AUTH PLAIN/i.test(line)) {
            const parts = line.split(' ');
            const raw = parts[2] ? Buffer.from(parts[2], 'base64').toString('utf8') : Buffer.from(line.slice(line.indexOf(' ' + parts[1]) + 1), 'base64').toString('utf8');
            const [, u, p] = raw.split('\0');
            user = u; pwd = p;
            send('235 2.7.0 Authentication successful');
          }
        } else if (cmd === 'MAIL' || cmd === 'RCPT') {
          send('250 2.1.0 Ok');
        } else if (cmd === 'DATA') {
          inData = true;
          send('354 End data with <CR><LF>.<CR><LF>');
        } else if (cmd === 'QUIT') {
          send('221 2.0.0 Bye');
          sock.end();
        } else {
          send('250 OK');
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      received,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

const decodeMail = (raw) => {
  const [head, body = ''] = raw.split('\r\n\r\n');
  const subjectRaw = (head.match(/^Subject: (.*)$/m) || [])[1] || '';
  const b64 = subjectRaw.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
  return {
    head,
    subject: Buffer.from(b64, 'base64').toString('utf8'),
    text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'),
  };
};

test('smtpSend：明文服务器 + 未授权明文 → 拒发（保护密码）', async () => {
  const fake = await startFakeSmtp({ auth: true });
  const r = await smtpSend(
    { host: '127.0.0.1', port: fake.port, secure: false, user: 'me@x.com', pass: 'p', to: ['to@x.com'] },
    { subject: 's', text: 't' },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /不支持 STARTTLS/);
  await fake.close();
});

test('smtpSend：走完 EHLO/AUTH LOGIN/DATA，中文主题与正文可还原', async () => {
  const fake = await startFakeSmtp({ auth: true });
  const r = await smtpSend(
    {
      host: '127.0.0.1', port: fake.port, secure: false, allowPlaintextAuth: true,
      user: 'me@x.com', pass: 'authcode', from: 'me@x.com', to: ['to@x.com', 'boss@x.com'],
    },
    { subject: '【严重】余额用尽 · 主力号', text: '剩余额度 0\n请尽快补充' },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(fake.received.length, 1);
  const mail = decodeMail(fake.received[0].raw);
  assert.equal(fake.received[0].user, 'me@x.com');
  assert.equal(fake.received[0].pwd, 'authcode');
  assert.equal(mail.subject, '【严重】余额用尽 · 主力号');
  assert.match(mail.text, /剩余额度 0/);
  assert.match(mail.head, /^To: to@x\.com, boss@x\.com$/m);
  await fake.close();
});

test('smtpSend：连接失败/收件人为空 返回错误而不抛', async () => {
  const dead = await smtpSend(
    { host: '127.0.0.1', port: 1, secure: false, user: '', pass: '', to: ['to@x.com'], from: 'f@x.com' },
    { subject: 's', text: 't' },
  );
  assert.equal(dead.ok, false);
  assert.match(dead.error, /连接/);

  const noTo = await smtpSend({ host: '127.0.0.1', port: 1, to: [] }, { subject: 's', text: 't' });
  assert.equal(noTo.ok, false);
  assert.match(noTo.error, /收件人/);
});

// ── 引擎：去重 / 恢复 / 限速 / 通道 ───────────────────
function startRecordingHook() {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"code":0}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port, hits,
      close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

function makeEngine({ port, config = {}, dir }) {
  let stored = normalizeAlerts({
    email: { host: '', to: [] },
    channels: { email: false, webhook: true },
    webhook: { url: `http://127.0.0.1:${port}/hook`, type: 'generic' },
    cooldownMs: 0,
    notifyRecovery: true,
    minUsableKeys: 0,          // 单 Key 的测试池不该顺带触发「可用 Key 不足」
    ...config,
  });
  const logs = [];
  const engine = createAlerts({
    log: (lvl, msg, data) => logs.push(`${lvl} ${msg} ${data ? JSON.stringify(data) : ''}`),
    getKeys: () => engine._keys,
    isUsable: (k) => k.enabled !== false && !k.autoDisabled,
    getCreditsRefresh: () => ({ lastAt: Date.now(), lastOk: 1, lastFailed: 0 }),
    getConfig: () => stored,
    setConfig: (c) => { stored = c; },
    statePath: join(dir, 'alerts-state.json'),
    adminUrl: 'http://admin/',
    host: 'unit-test',
  });
  engine._keys = [key()];
  engine._logs = logs;
  engine._stored = () => stored;
  return engine;
}

test('引擎：余额用尽立刻告警，未恢复不重复发，恢复时补一封', async () => {
  const hook = await startRecordingHook();
  const dir = mkdtempSync(join(tmpdir(), 'ccp-alert-'));
  const engine = makeEngine({ port: hook.port, dir });
  try {
    engine.noteKeyDisabled({ keyId: 'key_1', label: '主力号', reason: 'quota-exhausted', until: Date.now() + 3600000 });
    await sleep(2600);                                   // 2s 合并窗口
    assert.equal(hook.hits.length, 1, '应发出第一封告警');
    assert.match(hook.hits[0].body.title, /余额\/额度已用尽 · 主力号/);
    assert.equal(hook.hits[0].body.level, 'critical');

    // 同一 Key 再次触发：处于 active，不再发
    engine.noteKeyDisabled({ keyId: 'key_1', label: '主力号', reason: 'quota-exhausted' });
    await sleep(2600);
    assert.equal(hook.hits.length, 1, '未恢复不得重复发送');

    // 额度恢复 → 补一封 recovery
    engine._keys = [key({ credits: { creditsRemaining: 88, windows: [] } })];
    await engine.evaluateCredits();
    await sleep(200);
    assert.equal(hook.hits.length, 2, '恢复时应补发一封');
    assert.equal(hook.hits[1].body.level, 'recovery');
    assert.match(hook.hits[1].body.title, /余额\/额度已用尽/);

    // 恢复后再触发 → 因为 cooldownMs=0，允许再发
    engine._keys = [key({ credits: { creditsRemaining: 0, windows: [] } })];
    await engine.evaluateCredits();
    await sleep(200);
    assert.equal(hook.hits.length, 3);
    assert.equal(engine.stats().active.length, 1);
    assert.equal(engine.stats().history[0].status, 'sent');
  } finally {
    engine.stop();
    await hook.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('引擎：channel 关闭时只记历史不发送（log-only 不丢事件）', async () => {
  const hook = await startRecordingHook();
  const dir = mkdtempSync(join(tmpdir(), 'ccp-alert-'));
  const engine = makeEngine({ port: hook.port, dir, config: { channels: { email: false, webhook: false } } });
  try {
    engine.noteKeyDisabled({ keyId: 'key_1', label: '主力号', reason: 'quota-exhausted' });
    await sleep(2600);
    assert.equal(hook.hits.length, 0);
    const st = engine.stats();
    assert.equal(st.active.length, 1);
    assert.equal(st.history[0].status, 'log-only');      // 没配通道 → 只记日志与历史
    assert.equal(st.enabled, true);
    assert.ok(engine._logs.some((l) => l.includes('[alert]')), '日志里必须能看到告警');
  } finally {
    engine.stop();
    await hook.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('引擎：失败率告警 + 每小时发送限速', async () => {
  const hook = await startRecordingHook();
  const dir = mkdtempSync(join(tmpdir(), 'ccp-alert-'));
  const engine = makeEngine({ port: hook.port, dir, config: { minSamples: 5, failureRateWarn: 20, maxSendsPerHour: 2 } });
  try {
    for (let i = 0; i < 6; i++) engine.noteRequestOutcome({ status: 502, path: '/v1/chat/completions' });
    await engine.evaluateFailures();
    assert.equal(hook.hits.length, 1);
    assert.match(hook.hits[0].body.title, /请求失败率 100%/);
    assert.equal(engine.stats().window.total, 6);
    assert.equal(engine.stats().window.failed, 6);

    // 成功请求把连续失败清掉，但失败率仍在窗口内
    engine.noteRequestOutcome({ status: 200, path: '/v1/chat/completions' });
    assert.equal(engine.stats().counters.consecutiveFailures, 0);
    // 4xx 客户端错误不计入样本
    const before = engine.stats().window.total;
    engine.noteRequestOutcome({ status: 400, path: '/v1/chat/completions' });
    assert.equal(engine.stats().window.total, before);

    // 耗尽每小时额度后新告警只记录
    engine.noteKeyDisabled({ keyId: 'key_1', label: '主力号', reason: 'quota-exhausted' });
    engine.noteKeyDisabled({ keyId: 'key_2', label: '备用号', reason: 'quota-exhausted' });
    await sleep(2600);
    assert.equal(hook.hits.length, 2, '不得超过 maxSendsPerHour');
    assert.ok(engine.stats().history.some((h) => h.status === 'rate-limited'));
  } finally {
    engine.stop();
    await hook.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('引擎：配置读写（密码保持、脱敏）与 test() 通道自检', async () => {
  const hook = await startRecordingHook();
  const dir = mkdtempSync(join(tmpdir(), 'ccp-alert-'));
  const engine = makeEngine({ port: hook.port, dir });
  try {
    engine.updateConfig({ email: { host: 'smtp.qq.com', user: 'me@qq.com', pass: 'authcode', to: 'me@qq.com' } });
    assert.equal(engine._stored().email.pass, 'authcode');
    // 管理台保存其它字段时不带 pass → 保持原密码
    engine.updateConfig({ email: { host: 'smtp.qq.com', port: 587 }, minCreditsPerKey: 2 });
    assert.equal(engine._stored().email.pass, 'authcode');
    assert.equal(engine._stored().email.port, 587);
    assert.equal(engine._stored().minCreditsPerKey, 2);
    // 显式置空 → 清掉密码
    engine.updateConfig({ email: { pass: '' } });
    assert.equal(engine._stored().email.pass, '');
    assert.equal(JSON.stringify(engine.maskedConfig()).includes('authcode'), false);

    const t = await engine.test();
    assert.equal(t.ok, true, JSON.stringify(t.results));
    assert.equal(hook.hits.length, 1);
    assert.match(hook.hits[0].body.title, /测试/);
  } finally {
    engine.stop();
    await hook.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('引擎：池不可用立刻告警，getCreditsRefresh 缺失也安全', async () => {
  const hook = await startRecordingHook();
  const dir = mkdtempSync(join(tmpdir(), 'ccp-alert-'));
  const engine = makeEngine({ port: hook.port, dir });
  try {
    engine.notePoolUnavailable({ total: 3, usable: 0 });
    await sleep(2600);
    assert.equal(hook.hits.length, 1);
    assert.match(hook.hits[0].body.title, /池内已无可用 Key/);

    // 有可用 Key 后恢复
    engine._keys = [key()];
    await engine.evaluateCredits();
    await sleep(200);
    assert.equal(hook.hits.length, 2);
    assert.equal(hook.hits[1].body.level, 'recovery');
    assert.equal(engine.stats().active.length, 0);

    // postWebhook 直连失败也不抛
    const bad = await postWebhook({ url: 'http://127.0.0.1:1/hook', type: 'generic' }, { subject: 's', text: 't' }, { timeoutMs: 1000 });
    assert.equal(bad.ok, false);
  } finally {
    engine.stop();
    await hook.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('引擎：statePath 落盘与恢复（重启不重复轰炸）', async () => {
  const hook = await startRecordingHook();
  const dir = mkdtempSync(join(tmpdir(), 'ccp-alert-'));
  const statePath = join(dir, 'alerts-state.json');
  const engine = makeEngine({ port: hook.port, dir });
  try {
    assert.equal(statePath, engine.stats().statePath);
    engine.noteKeyDisabled({ keyId: 'key_1', label: '主力号', reason: 'quota-exhausted' });
    await sleep(2600);
    assert.equal(hook.hits.length, 1);

    // 模拟进程重启后读回 active，再触发不重复发
    const again = makeEngine({ port: hook.port, dir });
    again.start({ warmupMs: 10_000 });                 // 先不体检，只看状态恢复
    assert.equal(again.stats().active.length, 1);
    again.noteKeyDisabled({ keyId: 'key_1', label: '主力号', reason: 'quota-exhausted' });
    await sleep(2600);
    assert.equal(hook.hits.length, 1, '重启后不得重复发送同一告警');
    again.stop();
  } finally {
    engine.stop();
    await hook.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('引擎：从 log-only 切到配好通道时，现有告警重新发一轮', async () => {
  const hook = await startRecordingHook();
  const dir = mkdtempSync(join(tmpdir(), 'ccp-alert-'));
  // 先用「没配通道」的状态存下一条告警（只记日志）
  const engine = makeEngine({ port: hook.port, dir, config: { channels: { email: false, webhook: false } } });
  try {
    engine.noteKeyDisabled({ keyId: 'key_1', label: '主力号', reason: 'quota-exhausted' });
    await sleep(2600);
    assert.equal(hook.hits.length, 0);
    assert.equal(engine.stats().history[0].status, 'log-only');

    // 配好 webhook 通道 → 应判定为 rearmed，并清掉已发送标记
    const saved = engine.saveConfig({ channels: { email: false, webhook: true } });
    assert.equal(saved.rearmed, true);
    assert.equal(engine.stats().active.length, 0, 'active 应被清空以便重发');
    engine._keys = [key({ credits: { creditsRemaining: 0, windows: [] } })];   // 该 Key 确实是空的
    await engine.checkNow();
    await sleep(200);
    assert.equal(hook.hits.length, 1, '通道配好后应立刻补发当前告警');
    assert.match(hook.hits[0].body.title, /余额\/额度已用尽/);

    // 再次保存（通道本来就是好的）不该重复清标记
    const again = engine.saveConfig({ minCreditsPerKey: 7 });
    assert.equal(again.rearmed, false);
    await engine.checkNow();
    await sleep(200);
    assert.equal(hook.hits.length, 1, '通道已就绪时保存配置不得重复发送');
  } finally {
    engine.stop();
    await hook.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('引擎：收件人非法/缺字段会给出 warning', async () => {
  const hook = await startRecordingHook();
  const dir = mkdtempSync(join(tmpdir(), 'ccp-alert-'));
  const engine = makeEngine({ port: hook.port, dir });
  try {
    const a = engine.saveConfig({ channels: { email: true, webhook: false }, email: { host: 'smtp.qq.com', to: 'good@x.com, bad@, also-bad' } });
    assert.equal(a.warnings.length, 2, a.warnings.join(' | '));
    assert.ok(a.warnings.some((w) => w.includes('bad@')));
    assert.ok(a.warnings.some((w) => w.includes('also-bad')));
    assert.deepEqual(engine._stored().email.to, ['good@x.com']);

    const b = engine.saveConfig({ channels: { email: true, webhook: true }, email: { host: '', to: '' }, webhook: { url: '' } });
    assert.ok(b.warnings.some((w) => w.includes('SMTP 服务器')), b.warnings.join(' | '));
    assert.ok(b.warnings.some((w) => w.includes('Webhook')), b.warnings.join(' | '));

    // 有了服务器却没有收件人 → 单独提醒收件人
    const c2 = engine.saveConfig({ email: { host: 'smtp.qq.com', to: '' } });
    assert.ok(c2.warnings.some((w) => w.includes('收件人')), c2.warnings.join(' | '));
  } finally {
    engine.stop();
    await hook.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defaultStatePath：与 keys.json 同目录', () => {
  const p = defaultStatePath('/app/data/keys.json');
  assert.ok(p.endsWith('alerts-state.json'));
  assert.ok(p.includes('data'));                       // Windows 下分隔符会变成 \
});
