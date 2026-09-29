/**
 * Command Code Proxy · 告警系统
 * ============================================================
 * 目标：在「余额快用完 / 已经用完」和「请求失败过多」这两件事发生时，
 * 主动发邮件（可选 webhook）通知，而不是等到用户来投诉。
 *
 * 设计要点
 *  - 纯 Node 实现，零依赖：SMTP 客户端用 net/tls 手写（server 上不必装 nodemailer）。
 *  - 检查逻辑是纯函数（checkKeyCredits / checkPoolHealth / checkFailureStats），
 *    可以在 test/alerts.test.mjs 里用合成数据单测，不必打真实上游。
 *  - 告警去重按「告警 id + 状态变化」：同一条告警在没恢复之前只发一次
 *    （除非升级 warn→critical，或开了 repeatWhenStuck 到点重发），避免刷屏。
 *  - 恢复通知：条件消失时补一封「已恢复」，这样一封告警有始有终。
 *  - 投递通道：邮件（SMTP）+ webhook（企业微信 / Bark / Server酱 / 通用 JSON）。
 *    没配通道时只写日志和历史（log-only），不会因为忘配 SMTP 而静默丢告警。
 */

import net from 'net';
import tls from 'tls';
import fs from 'fs';
import os from 'os';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';

// ══════════════════════════════════════════════════════════
// 配置
// ══════════════════════════════════════════════════════════

export const ALERT_DEFAULTS = {
  enabled: true,                     // 总开关（关掉后只记历史，不发不收）
  channels: { email: true, webhook: false },

  email: {
    host: '',                        // 如 smtp.qq.com
    port: 465,
    secure: true,                    // true = 465 隐式 TLS；false = 587/25 走 STARTTLS
    user: '',
    pass: '',                        // QQ/163 等填「授权码」，不是登录密码
    from: '',                        // 留空 = 用 user
    to: [],                          // 收件人，可多个（字符串用 , ; 分隔也行）
    // 默认拒绝在明文连接上发密码（服务器不支持 STARTTLS 就中止）。
    // 只有本机/内网中继（127.0.0.1:25 之类）才需要打开。
    allowPlaintextAuth: false,
  },

  webhook: {
    url: '',
    // auto = 按 URL 猜：qyapi.weixin.qq.com→企业微信，api.day.app→Bark，
    // sctapi.ftqq.com/pushplus→Server酱/PushPlus，其余按通用 JSON
    type: 'auto',
  },

  // ── 余额类阈值 ──
  minCreditsPerKey: 5,               // 单 Key 剩余额度低于这个值 → 警告
  windowPctWarn: 85,                 // 5h / 周窗口用量达到该百分比 → 警告
  windowPctCritical: 95,             // 窗口用量达到该百分比 → 严重
  minUsableKeys: 2,                  // 可用 Key 少于这个数 → 警告（0 个 → 严重）
  creditsFetchFailWarn: 2,           // 一轮额度轮询里失败 Key 数 >= 该值 → 警告

  // ── 失败类阈值 ──
  windowMs: 5 * 60 * 1000,           // 滑动窗口长度
  minSamples: 8,                     // 窗口内样本数达到该值才评估失败率
  failureRateWarn: 30,               // 失败率 >= 30% → 警告
  failureRateCritical: 60,           // 失败率 >= 60% → 严重
  consecutiveFailuresCritical: 5,    // 连续失败次数 → 严重（低流量也能抓到全挂）
  quotaFaultsCritical: 3,            // 窗口内「额度/凭证类」上游失败次数 → 严重
  stallsWarn: 3,                     // 窗口内卡顿/截断次数 → 警告
  inflightWarn: 5,                   // 窗口内被在途上限拒绝次数 → 警告

  // ── 抑制与投递 ──
  cooldownMs: 30 * 60 * 1000,        // 同一告警两次发送之间的最小间隔（防抖底线）
  repeatWhenStuck: false,            // 未恢复时是否按 cooldown 反复提醒（默认只提醒变化）
  notifyRecovery: true,              // 恢复时补一封
  maxSendsPerHour: 20,               // 每小时最多发多少封（防邮件风暴）
  timeoutMs: 15000,                  // SMTP / webhook 超时
  sweepMs: 60 * 1000,                // 定期体检间隔
  maxHistory: 200,                   // 历史保留条数
};

const num = (v, def, min, max) => {
  const n = Number(v);
  if (!isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
};

// 邮箱校验：允许内网/本机中继的无点域名（root@localhost、me@local 是合法可投递地址）
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;.]+(?:\.[^\s@,;.]+)*$/;

/**
 * 收件人统一成数组（支持 "a@x.com, b@y.com" / ["a@x.com"] / 换行分隔）。
 * 非法地址直接丢弃（由 recipientWarnings 负责告知用户，不静默吞掉错别字）。
 */
export function normalizeRecipients(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    const addr = String(raw || '').trim();
    if (!addr || !EMAIL_RE.test(addr)) continue;
    if (!out.includes(addr)) out.push(addr);
  }
  return out;
}

/** 从用户输入里挑出被忽略的非法收件人（管理台用来提示，避免"填了却没生效"） */
export function recipientWarnings(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,;]+/);
  return list.map((s) => String(s || '').trim()).filter((s) => s && !EMAIL_RE.test(s));
}

/** 配置收敛（前端/文件里塞脏数据也不会把告警逻辑搞崩） */
export function normalizeAlerts(raw) {
  const r = raw || {};
  const d = ALERT_DEFAULTS;
  const emailRaw = r.email || {};
  const to = normalizeRecipients(emailRaw.to);
  const secureRaw = emailRaw.secure;
  const port = num(emailRaw.port, d.email.port, 1, 65535);
  const webhookTypes = ['auto', 'wecom', 'bark', 'serverchan', 'pushplus', 'generic'];

  return {
    enabled: r.enabled !== false,
    channels: {
      email: (r.channels?.email ?? d.channels.email) !== false,
      webhook: r.channels?.webhook === true,
    },
    email: {
      host: String(emailRaw.host || '').trim(),
      port,
      // 没显式写 secure 就按端口猜：465 = 隐式 TLS
      secure: secureRaw === undefined || secureRaw === null ? port === 465 : !!secureRaw,
      user: String(emailRaw.user || '').trim(),
      pass: String(emailRaw.pass ?? ''),
      from: String(emailRaw.from || '').trim(),
      to,
      allowPlaintextAuth: emailRaw.allowPlaintextAuth === true,
    },
    webhook: {
      url: String(r.webhook?.url || '').trim(),
      type: webhookTypes.includes(r.webhook?.type) ? r.webhook.type : 'auto',
    },
    minCreditsPerKey: num(r.minCreditsPerKey, d.minCreditsPerKey, 0, 1e9),
    windowPctWarn: num(r.windowPctWarn, d.windowPctWarn, 1, 100),
    windowPctCritical: num(r.windowPctCritical, d.windowPctCritical, 1, 100),
    minUsableKeys: num(r.minUsableKeys, d.minUsableKeys, 0, 1000),
    creditsFetchFailWarn: num(r.creditsFetchFailWarn, d.creditsFetchFailWarn, 1, 1000),
    windowMs: num(r.windowMs, d.windowMs, 30 * 1000, 24 * 3600 * 1000),
    minSamples: num(r.minSamples, d.minSamples, 1, 100000),
    failureRateWarn: num(r.failureRateWarn, d.failureRateWarn, 1, 100),
    failureRateCritical: num(r.failureRateCritical, d.failureRateCritical, 1, 100),
    consecutiveFailuresCritical: num(r.consecutiveFailuresCritical, d.consecutiveFailuresCritical, 1, 100000),
    quotaFaultsCritical: num(r.quotaFaultsCritical, d.quotaFaultsCritical, 1, 100000),
    stallsWarn: num(r.stallsWarn, d.stallsWarn, 1, 100000),
    inflightWarn: num(r.inflightWarn, d.inflightWarn, 1, 100000),
    cooldownMs: num(r.cooldownMs, d.cooldownMs, 0, 24 * 3600 * 1000),
    repeatWhenStuck: r.repeatWhenStuck === true,
    notifyRecovery: r.notifyRecovery !== false,
    maxSendsPerHour: num(r.maxSendsPerHour, d.maxSendsPerHour, 1, 500),
    timeoutMs: num(r.timeoutMs, d.timeoutMs, 1000, 120000),
    sweepMs: num(r.sweepMs, d.sweepMs, 10 * 1000, 3600 * 1000),
    maxHistory: num(r.maxHistory, d.maxHistory, 10, 5000),
  };
}

/**
 * 环境变量覆写（容器里改 .env 比重建 keys.json 方便；密钥也可以只放这里）。
 *   CC_ALERT_ENABLED / CC_ALERT_SMTP_HOST / _PORT / _SECURE / _USER / _PASS / _FROM / _TO
 *   CC_ALERT_WEBHOOK / CC_ALERT_WEBHOOK_TYPE
 */
export function applyEnvOverrides(cfg, env = process.env) {
  const out = JSON.parse(JSON.stringify(cfg));
  if (env.CC_ALERT_ENABLED !== undefined) out.enabled = env.CC_ALERT_ENABLED !== 'false' && env.CC_ALERT_ENABLED !== '0';
  if (env.CC_ALERT_SMTP_HOST) out.email.host = String(env.CC_ALERT_SMTP_HOST).trim();
  if (env.CC_ALERT_SMTP_PORT) out.email.port = num(env.CC_ALERT_SMTP_PORT, out.email.port, 1, 65535);
  if (env.CC_ALERT_SMTP_SECURE !== undefined) out.email.secure = env.CC_ALERT_SMTP_SECURE !== 'false' && env.CC_ALERT_SMTP_SECURE !== '0';
  if (env.CC_ALERT_SMTP_USER) out.email.user = String(env.CC_ALERT_SMTP_USER).trim();
  if (env.CC_ALERT_SMTP_PASS) out.email.pass = String(env.CC_ALERT_SMTP_PASS);
  if (env.CC_ALERT_SMTP_FROM) out.email.from = String(env.CC_ALERT_SMTP_FROM).trim();
  const to = normalizeRecipients([...(out.email.to || []), ...normalizeRecipients(env.CC_ALERT_TO)]);
  if (to.length) out.email.to = to;
  if (env.CC_ALERT_WEBHOOK) {
    out.webhook.url = String(env.CC_ALERT_WEBHOOK).trim();
    out.channels.webhook = true;
  }
  if (env.CC_ALERT_WEBHOOK_TYPE) out.webhook.type = String(env.CC_ALERT_WEBHOOK_TYPE).trim();
  return normalizeAlerts(out);
}

/** 返回给管理台的配置：密码不回传，只回「是否已设置」 */
export function maskConfig(cfg) {
  const c = JSON.parse(JSON.stringify(cfg));
  c.email.passSet = !!c.email.pass;
  c.email.pass = '';
  c.effective = {
    emailReady: !!(c.channels.email && c.email.host && c.email.to.length),
    webhookReady: !!(c.channels.webhook && c.webhook.url),
    // 什么都没配 → log-only
    logOnly: !(c.channels.email && c.email.host && c.email.to.length)
      && !(c.channels.webhook && c.webhook.url),
  };
  return c;
}

// ══════════════════════════════════════════════════════════
// 检查逻辑（纯函数，方便单测）
// ══════════════════════════════════════════════════════════

const fmtCredits = (n) => (isFinite(Number(n)) ? Number(Number(n).toFixed(2)).toString() : '—');

/** 单 Key 的余额/窗口检查 */
export function checkKeyCredits(k, cfg) {
  const out = [];
  if (!k || k.enabled === false) return out;         // 用户主动停用的不管
  const id = k.id;
  const label = k.label || id;
  const c = k.credits;

  if (c?.error) {
    out.push({
      id: 'key-query-failed:' + id, category: 'credits', level: 'warn',
      title: `额度查询失败 · ${label}`,
      detail: `上游额度接口返回错误：${String(c.error).slice(0, 200)}`,
    });
  }

  const reason = k.autoDisabled?.reason || null;
  if (reason === 'disabled') {
    out.push({
      id: 'key-invalid:' + id, category: 'credits', level: 'critical',
      title: `凭证失效 · ${label}`,
      detail: '上游返回 401/未授权，该 Key 已自动停用，需要换 Key。',
    });
  }

  if (!c || c.error) return out;                      // 没数据就不猜

  const rem = Number(c.creditsRemaining);
  const parts = c.credits
    ? `月度 ${fmtCredits(c.credits.monthly)} · 购买 ${fmtCredits(c.credits.purchased)} · 赠送 ${fmtCredits(c.credits.free)}`
    : '';

  if (reason === 'quota-exhausted' || (isFinite(rem) && rem <= 0.000001)) {
    const until = k.autoDisabled?.until ? `，预计 ${tsText(k.autoDisabled.until)} 恢复` : '';
    out.push({
      id: 'credits-exhausted:' + id, category: 'credits', level: 'critical',
      title: `余额/额度已用尽 · ${label}`,
      detail: `剩余额度 ${fmtCredits(rem)}（${parts}）${until}`,
    });
  } else if (isFinite(rem) && rem < cfg.minCreditsPerKey) {
    out.push({
      id: 'credits-low:' + id, category: 'credits', level: 'warn',
      title: `余额偏低 · ${label}`,
      detail: `剩余额度 ${fmtCredits(rem)}，低于阈值 ${cfg.minCreditsPerKey}（${parts}）`,
    });
  }

  for (const w of Array.isArray(c.windows) ? c.windows : []) {
    const pct = Number(w.pct);
    if (!isFinite(pct)) continue;
    const windowName = w.name === '5h' ? '5 小时窗口' : w.name === 'weekly' ? '周窗口' : String(w.name || '窗口');
    if (pct >= cfg.windowPctCritical) {
      out.push({
        id: `credits-exhausted:${id}`, category: 'credits', level: 'critical',
        title: `限额窗口已满 · ${label}`,
        detail: `${windowName} ${pct}%（${fmtCredits(w.used)}/${fmtCredits(w.cap)}）${w.resetsAt ? `，${tsText(w.resetsAt)} 重置` : ''}`,
      });
    } else if (pct >= cfg.windowPctWarn) {
      out.push({
        id: `window-high:${id}:${w.name}`, category: 'credits', level: 'warn',
        title: `限额窗口将满 · ${label}`,
        detail: `${windowName} ${pct}%（${fmtCredits(w.used)}/${fmtCredits(w.cap)}）${w.resetsAt ? `，${tsText(w.resetsAt)} 重置` : ''}`,
      });
    }
  }
  return out;
}

/** 池整体健康度（可用 Key 数 / 额度轮询结果） */
export function checkPoolHealth({ keys, usableCount, creditsRefresh, cfg }) {
  const out = [];
  const list = Array.isArray(keys) ? keys : [];
  const enabled = list.filter((k) => k.enabled !== false);

  if (!list.length) return out;                       // 空池在启动日志里已经很明显，不重复轰炸

  if (!enabled.length) {
    out.push({
      id: 'pool-empty:pool', category: 'pool', level: 'critical',
      title: '池内没有启用的 Key',
      detail: `共 ${list.length} 个 Key，全部被手动停用，请求会直接失败。`,
    });
    return out;
  }

  if (usableCount <= 0) {
    const exhausted = list.filter((k) => k.autoDisabled).length;
    const cooling = list.filter((k) => Number(k.cooldownUntil) > Date.now()).length;
    out.push({
      id: 'pool-unavailable:pool', category: 'pool', level: 'critical',
      title: '池内已无可用 Key',
      detail: `启用 ${enabled.length} 个：额度用尽 ${exhausted} · 冷却中 ${cooling}。新请求会立刻报错，需要充值或补充 Key。`,
    });
  } else if (usableCount < cfg.minUsableKeys) {
    out.push({
      id: 'usable-keys-low:pool', category: 'pool', level: 'warn',
      title: `可用 Key 仅剩 ${usableCount} 个`,
      detail: `低于阈值 ${cfg.minUsableKeys}，冗余不足，再挂一个就会开始报错。`,
    });
  }

  const cr = creditsRefresh || {};
  if (cr.lastAt && Number(cr.lastFailed) >= cfg.creditsFetchFailWarn) {
    const all = Number(cr.lastOk) === 0;
    out.push({
      id: 'fetch-failed:pool', category: 'pool', level: all ? 'critical' : 'warn',
      title: all ? '额度轮询全部失败' : `额度轮询部分失败（${cr.lastFailed} 个 Key）`,
      detail: `最近一轮额度刷新：成功 ${cr.lastOk || 0} · 失败 ${cr.lastFailed}${cr.lastError ? `（${cr.lastError}）` : ''}。`
        + '额度数据过期会导致自动停用判断失灵，顺带确认下网络与 Key 是否有效。',
    });
  }
  return out;
}

export const FAILURE_STATUSES = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504, 529]);
const isFailureStatus = (s) => Number(s) >= 500 || FAILURE_STATUSES.has(Number(s));

/** 滑动窗口里的失败率 / 连续失败 / 上游故障计数 */
export function checkFailureStats({ samples, faults, consecutiveFailures, cfg, now }) {
  const t = now ?? Date.now();
  const win = (arr) => (Array.isArray(arr) ? arr : []).filter((x) => t - x.ts <= cfg.windowMs);
  const winSamples = win(samples);
  const winFaults = win(faults);

  const total = winSamples.length;
  const failed = winSamples.filter((s) => !s.ok).length;
  const rate = total ? Math.round((failed / total) * 1000) / 10 : 0;

  const quota = winFaults.filter((f) => f.kind === 'quota');
  const stall = winFaults.filter((f) => f.kind === 'stall');
  const inflight = winFaults.filter((f) => f.kind === 'inflight');

  const stats = {
    windowMs: cfg.windowMs,
    total, failed, rate,
    consecutiveFailures: Number(consecutiveFailures) || 0,
    quota: quota.length, stall: stall.length, inflight: inflight.length,
  };

  const out = [];
  const rateDetail = `最近 ${fmtDuration(cfg.windowMs)} 内 ${total} 个请求，失败 ${failed} 个（${rate}%）`;

  if (total >= cfg.minSamples && rate >= cfg.failureRateCritical) {
    out.push({ id: 'failure-rate:pool', category: 'failures', level: 'critical', title: `请求失败率 ${rate}%`, detail: rateDetail });
  } else if (total >= cfg.minSamples && rate >= cfg.failureRateWarn) {
    out.push({ id: 'failure-rate:pool', category: 'failures', level: 'warn', title: `请求失败率 ${rate}%`, detail: rateDetail });
  }

  if (stats.consecutiveFailures >= cfg.consecutiveFailuresCritical) {
    out.push({
      id: 'consecutive-failures:pool', category: 'failures', level: 'critical',
      title: `连续 ${stats.consecutiveFailures} 次请求失败`,
      detail: `连续失败次数已达阈值 ${cfg.consecutiveFailuresCritical}（${rateDetail}）。`,
    });
  }

  if (quota.length >= cfg.quotaFaultsCritical) {
    const labels = [...new Set(quota.map((f) => f.label || f.keyId).filter(Boolean))].slice(0, 6).join('、');
    out.push({
      id: 'quota-faults:pool', category: 'failures', level: 'critical',
      title: `上游额度/凭证类失败 ${quota.length} 次`,
      detail: `${rateDetail}；其中额度或凭证类失败 ${quota.length} 次${labels ? `（涉及：${labels}）` : ''}，`
        + '说明有 Key 正在被消耗完或已失效。',
    });
  }

  if (stall.length >= cfg.stallsWarn) {
    out.push({
      id: 'stalls:pool', category: 'failures', level: 'warn',
      title: `上游卡顿/截断 ${stall.length} 次`,
      detail: `${rateDetail}；其中空闲超时/流截断 ${stall.length} 次，通常是上游变慢或网络抖动。`,
    });
  }

  if (inflight.length >= cfg.inflightWarn) {
    out.push({
      id: 'inflight:pool', category: 'failures', level: 'warn',
      title: `并发超限被拒 ${inflight.length} 次`,
      detail: `${rateDetail}；在途请求达到上限被拒 ${inflight.length} 次，可考虑调大 CC_MAX_INFLIGHT 或限流。`,
    });
  }

  return { findings: out, stats };
}

// ══════════════════════════════════════════════════════════
// 文本 / 邮件构造
// ══════════════════════════════════════════════════════════

const pad2 = (n) => String(n).padStart(2, '0');

/** 北京时间文本（服务器时区可能不是 +08） */
export function tsText(ts) {
  if (!ts || !isFinite(Number(ts))) return '—';
  const d = new Date(Number(ts) + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} `
    + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

const LEVEL_TAG = { critical: '严重', warn: '警告', recovery: '已恢复' };

/**
 * 把一批告警拼成标题 + 正文。
 * findings: [{level,title,detail,id}]；snapshot 是池子快照（可选）。
 */
export function buildAlertText({ findings, recovery = [], snapshot = null, now = Date.now(), host = '' }) {
  const all = [...findings, ...recovery];
  const critical = all.filter((f) => f.level === 'critical');
  const warn = all.filter((f) => f.level === 'warn');

  const top = critical[0] || warn[0] || recovery[0] || { title: '告警' };
  const level = critical.length ? 'critical' : (warn.length ? 'warn' : 'recovery');
  const extra = all.length > 1 ? ` 等 ${all.length} 项` : '';
  const subject = `[CC-Proxy ${LEVEL_TAG[level]}] ${top.title}${extra}`;

  const lines = [];
  lines.push('Command Code Proxy 运行告警');
  lines.push(`时间：${tsText(now)}（北京时间）`);
  if (host) lines.push(`主机：${host}`);
  lines.push('');

  for (const group of [['critical', critical], ['warn', warn], ['recovery', recovery]]) {
    const [lv, items] = group;
    if (!items.length) continue;
    lines.push(`━━ ${LEVEL_TAG[lv]}（${items.length} 项）━━`);
    for (const f of items) {
      lines.push(`• ${f.title}`);
      if (f.detail) lines.push(`  ${f.detail}`);
    }
    lines.push('');
  }

  if (snapshot) {
    lines.push('━━ Key 池快照 ━━');
    lines.push(`共 ${snapshot.total} 个 Key · 可用 ${snapshot.usable} 个`
      + (snapshot.creditsAt ? ` · 额度更新于 ${tsText(snapshot.creditsAt)}` : ' · 尚未查询额度'));
    for (const k of snapshot.keys || []) {
      const cred = k.credits;
      const rem = cred && !cred.error ? `剩余 ${fmtCredits(cred.creditsRemaining)}` : (cred?.error ? `额度查询失败：${String(cred.error).slice(0, 60)}` : '额度未知');
      const win = cred && !cred.error && Array.isArray(cred.windows) && cred.windows.length
        ? ' · ' + cred.windows.map((w) => `${w.name} ${w.pct}%`).join(' · ')
        : '';
      const state = k.autoDisabled ? ` [自动停用：${k.autoDisabled.reason}]` : (k.enabled === false ? ' [手动停用]' : '');
      lines.push(`  · ${k.label || k.id}  ${rem}${win}${state}`);
    }
    if (snapshot.keysTruncated) lines.push(`  · …另有 ${snapshot.keysTruncated} 个 Key`);
    lines.push('');
  }

  lines.push('━━ 当前阈值 ━━');
  if (snapshot?.cfg) {
    const c = snapshot.cfg;
    lines.push(`余额：单 Key 剩余 < ${c.minCreditsPerKey} 告警；窗口 ≥ ${c.windowPctWarn}% 告警 / ≥ ${c.windowPctCritical}% 严重`);
    lines.push(`失败：窗口 ${fmtDuration(c.windowMs)} 内样本 ≥ ${c.minSamples} 时，失败率 ≥ ${c.failureRateWarn}% 告警 / ≥ ${c.failureRateCritical}% 严重；连续失败 ≥ ${c.consecutiveFailuresCritical} 严重`);
    lines.push(`可用 Key 少于 ${c.minUsableKeys} 个告警；同一告警未恢复前只提醒一次${c.notifyRecovery ? '，恢复时会再发一封' : ''}。`);
    if (snapshot.adminUrl) lines.push('');
    if (snapshot.adminUrl) lines.push(`管理台：${snapshot.adminUrl}`);
  }
  lines.push('');
  lines.push('—— 本邮件由 commandcode-proxy 自动发送');

  return { subject, text: lines.join('\n'), level, critical: critical.length, warn: warn.length };
}

const wrap76 = (b64) => {
  const out = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out.join('\r\n');
};

/** RFC 2047 编码一个 header 值（中文标题必须编，否则 QQ 邮箱显示乱码） */
export const encodeHeader = (s) => `=?UTF-8?B?${Buffer.from(String(s), 'utf8').toString('base64')}?=`;

/** 组装一封最简 MIME 邮件（纯文本 + base64，规避 dot-stuffing 与行宽问题） */
export function buildEmail({ from, to, subject, text, date = Date.now(), messageId = null, extraHeaders = {} }) {
  const list = normalizeRecipients(to);
  if (!list.length) throw new Error('buildEmail: 没有有效的收件人');
  const headers = [
    `Date: ${new Date(date).toUTCString()}`,
    `From: ${from}`,
    `To: ${list.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: <${messageId || randomUUID()}@cc-proxy>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'X-Mailer: commandcode-proxy/alerts',
  ];
  for (const [k, v] of Object.entries(extraHeaders)) headers.push(`${k}: ${v}`);
  const body = wrap76(Buffer.from(String(text ?? ''), 'utf8').toString('base64'));
  return { raw: headers.join('\r\n') + '\r\n\r\n' + body + '\r\n', recipients: list };
}

// ══════════════════════════════════════════════════════════
// SMTP（零依赖实现）
// ══════════════════════════════════════════════════════════

/** 按行读 SMTP 应答，把多行应答（250-xxx…250 yyy）合成一个 reply */
function createReader(sock) {
  let buf = '';
  let acc = [];
  const queue = [];
  let waiter = null;
  let dead = null;

  const settle = (reply) => {
    if (waiter) { const w = waiter; waiter = null; reply.error ? w.reject(reply.error) : w.resolve(reply); }
    else queue.push(reply);
  };
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line) continue;
      acc.push(line);
      if (/^\d{3}[ ]/.test(line)) { settle({ code: Number(line.slice(0, 3)), lines: acc.slice() }); acc = []; }
    }
  };
  const onFail = (err) => { dead = err; settle({ error: err }); };
  sock.on('data', onData);
  sock.once('error', onFail);
  sock.once('close', () => { if (!dead) onFail(new Error('SMTP 连接被关闭')); });

  return {
    next: () => new Promise((resolve, reject) => {
      const r = queue.shift();
      if (r) return r.error ? reject(r.error) : resolve(r);
      if (dead) return reject(dead);
      waiter = { resolve, reject };
    }),
    detach: () => {
      sock.removeListener('data', onData);
      sock.removeListener('error', onFail);
      sock.removeAllListeners('close');
    },
  };
}

function smtpError(reply) {
  return new Error(`SMTP ${reply.code} ${(reply.lines || []).join(' | ').slice(0, 300)}`);
}

/**
 * 发一封信。email 为 normalizeAlerts 里的 email 段。
 * 返回 { ok, error, transcript }（transcript 只在失败时给调用方排查用，含命令名不含密码）。
 */
export async function smtpSend(email, mail, { timeoutMs = 15000, log = () => {} } = {}) {
  const host = String(email.host || '').trim();
  const recipients = normalizeRecipients(mail.to ?? email.to);
  const user = String(email.user || '').trim();
  const pass = String(email.pass ?? '');
  const from = String(email.from || user || '').trim();

  if (!host) return { ok: false, error: '未配置 SMTP 服务器（email.host）' };
  if (!recipients.length) return { ok: false, error: '未配置收件人（email.to）' };
  if (!from) return { ok: false, error: '未配置发件人（email.from / email.user）' };

  const port = Number(email.port) || 465;
  const implicitTls = email.secure === undefined ? port === 465 : !!email.secure;
  const transcript = [];
  let sock = null;
  let reader = null;

  const hardClose = () => { try { sock?.destroy(); } catch { /* 忽略 */ } };
  const timer = setTimeout(() => hardClose(), Math.max(3000, timeoutMs) * 2);
  timer.unref?.();

  try {
    sock = await new Promise((res, rej) => {
      const onErr = (e) => rej(new Error(`连接 ${host}:${port} 失败：${e.message}`));
      const s = implicitTls
        ? tls.connect({ host, port, servername: host, timeout: timeoutMs }, () => res(s))
        : net.connect({ host, port, timeout: timeoutMs }, () => res(s));
      s.once('error', onErr);
      s.setTimeout(timeoutMs, () => s.destroy(new Error(`连接 ${host}:${port} 超时（${timeoutMs}ms）`)));
    });
    sock.setNoDelay?.(true);

    reader = createReader(sock);
    const cmd = async (line, expect) => {
      const label = String(line).split(/[\s:]/)[0].toUpperCase();
      sock.write(line + '\r\n');
      const reply = await reader.next();
      transcript.push(`${label} → ${reply.code}`);
      if (expect && !expect.includes(reply.code)) throw smtpError(reply);
      return reply;
    };

    let greeting = await reader.next();
    transcript.push(`< ${greeting.code}`);
    if (greeting.error) throw greeting.error;
    if (greeting.code !== 220) throw smtpError(greeting);

    const ehloName = (os.hostname() || 'cc-proxy').replace(/[^A-Za-z0-9.-]/g, '-') || 'cc-proxy';
    let capLine = (await cmd(`EHLO ${ehloName}`, [250])).lines.join(' ').toUpperCase();

    // STARTTLS：非隐式 TLS 时必须升级，否则拒绝在明文里发凭据
    if (!implicitTls) {
      if (!/\bSTARTTLS\b/.test(capLine)) {
        if (user && !email.allowPlaintextAuth) {
          throw new Error('SMTP 服务器不支持 STARTTLS，为避免明文发送密码已中止（可改用 465 端口，或对本地中继显式打开 allowPlaintextAuth）');
        }
      } else {
        await cmd('STARTTLS', [220]);
        reader.detach();
        const plain = sock;
        sock = await new Promise((res, rej) => {
          const s = tls.connect({ socket: plain, servername: host, timeout: timeoutMs }, () => res(s));
          s.once('error', (e) => rej(new Error(`STARTTLS 握手失败：${e.message}`)));
        });
        sock.setNoDelay?.(true);
        reader = createReader(sock);
        capLine = (await cmd(`EHLO ${ehloName}`, [250])).lines.join(' ').toUpperCase();
        transcript.push('STARTTLS 已启用');
      }
    }

    if (user) {
      const m = capLine.match(/AUTH[ =]([A-Z0-9 \-]+)/);
      const mechs = m ? m[1].split(/[\s-]+/).filter(Boolean) : [];
      const useLogin = mechs.includes('LOGIN') || !mechs.includes('PLAIN');
      if (useLogin) {
        await cmd('AUTH LOGIN', [334]);
        await cmd(Buffer.from(user, 'utf8').toString('base64'), [334]);
        await cmd(Buffer.from(pass, 'utf8').toString('base64'), [235]);
      } else {
        await cmd('AUTH PLAIN ' + Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64'), [235]);
      }
      transcript.push(`AUTH ok (${useLogin ? 'LOGIN' : 'PLAIN'})`);
    }

    await cmd(`MAIL FROM:<${from}>`, [250]);
    for (const rcpt of recipients) await cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
    await cmd('DATA', [354]);

    const { raw } = buildEmail({ from, to: recipients, subject: mail.subject, text: mail.text, extraHeaders: mail.extraHeaders });
    sock.write(raw.replace(/\r?\n/g, '\r\n') + '\r\n.\r\n');
    const done = await reader.next();
    transcript.push(`DATA → ${done.code}`);
    if (done.error) throw done.error;
    if (done.code !== 250) throw smtpError(done);

    try { sock.write('QUIT\r\n'); } catch { /* 忽略 */ }
    transcript.push('QUIT');
    return { ok: true, transcript };
  } catch (e) {
    log('warn', 'SMTP send failed', { host, port, error: e.message });
    return { ok: false, error: e.message, transcript };
  } finally {
    clearTimeout(timer);
    hardClose();
  }
}

// ══════════════════════════════════════════════════════════
// Webhook（企业微信 / Bark / Server酱 / 通用 JSON）
// ══════════════════════════════════════════════════════════

export function detectWebhookType(url, type = 'auto') {
  if (type && type !== 'auto') return type;
  const u = String(url || '');
  if (/qyapi\.weixin\.qq\.com/.test(u)) return 'wecom';
  if (/(api\.day\.app|bark)/i.test(u)) return 'bark';
  if (/(sctapi\.ftqq\.com|serverchan)/i.test(u)) return 'serverchan';
  if (/pushplus\.plus/.test(u)) return 'pushplus';
  return 'generic';
}

export function buildWebhookBody(type, { subject, text, level }) {
  switch (type) {
    case 'wecom':
      return { msgtype: 'markdown', markdown: { content: `**${subject}**\n${text}`.slice(0, 4000) } };
    case 'bark':
      return {
        title: subject,
        body: text.slice(0, 2000),
        level: level === 'critical' ? 'timeSensitive' : 'active',
        group: 'CC-Proxy',
      };
    case 'serverchan':
    case 'pushplus':
      return { title: subject, desp: text, content: text };
    default:
      return { source: 'commandcode-proxy', level, title: subject, text, at: Date.now() };
  }
}

export async function postWebhook(wh, payload, { timeoutMs = 15000 } = {}) {
  const url = String(wh?.url || '').trim();
  if (!url) return { ok: false, error: '未配置 webhook.url' };
  const type = detectWebhookType(url, wh.type);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWebhookBody(type, payload)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await r.text().catch(() => '');
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} ${body.slice(0, 200)}`, type };
    let json = null;
    try { json = JSON.parse(body); } catch { /* 非 JSON 也算成功 */ }
    if (json && json.errcode && json.errcode !== 0) return { ok: false, error: `errcode ${json.errcode} ${json.errmsg || ''}`, type };
    if (json && json.code && json.code !== 200 && json.code !== 0) return { ok: false, error: `code ${json.code} ${json.msg || ''}`, type };
    return { ok: true, type };
  } catch (e) {
    return { ok: false, error: e.message, type };
  }
}

// ══════════════════════════════════════════════════════════
// 引擎
// ══════════════════════════════════════════════════════════

/**
 * 日志信息 → 上游故障信号。
 * 这些点都发生在「上游已经返回 200，但流中途出问题」之后，HTTP 状态码是 200，
 * 光看状态码抓不到，所以从日志里取。键名与 proxy.mjs 里的 log('...') 文案保持一致。
 */
export const LOG_FAULT_MAP = {
  'Stream idle timeout': { kind: 'stall', detail: '上游空闲超时' },
  'Upstream stream incomplete': { kind: 'stall', detail: '上游流未正常结束' },
  'Stream error': { kind: 'stall', detail: '流读取中断' },
  'Upstream error': { kind: 'stall', detail: '上游异常' },
  'In-flight limit reached, rejecting request': { kind: 'inflight', detail: '在途请求超限被拒' },
};

/**
 * @param {object} o
 * @param {(level:string,msg:string,data?:any)=>void} o.log
 * @param {()=>any[]} o.getKeys            返回 keyStore.keys
 * @param {(k:any)=>boolean} o.isUsable    返回 isKeyUsable(k)
 * @param {()=>object} o.getCreditsRefresh 返回 creditsRefresh 状态
 * @param {()=>object} o.getConfig         返回已持久化的 alerts 配置（未应用 env）
 * @param {(cfg:object)=>void} o.setConfig 持久化 alerts 配置
 * @param {string} o.statePath             历史/去重状态落盘路径
 * @param {()=>number} [o.now]
 * @param {string} [o.adminUrl]            邮件里附的管理台地址
 */
export function createAlerts(o) {
  const {
    log, getKeys, isUsable, getCreditsRefresh, getConfig, setConfig,
    statePath, now = () => Date.now(), adminUrl = '', host = os.hostname() || '',
  } = o;

  const active = new Map();   // id → { category, level, title, detail, firstAt, lastSentAt, sends, value }
  const lastSent = new Map(); // id → 上次发送时间（恢复后仍保留，用于防抖）
  let history = [];           // [{ at, level, title, detail, status, channels, error }]
  let samples = [];           // [{ ts, ok, status, path }]
  let faults = [];            // [{ ts, kind, trigger, keyId, label, status }]
  let consecutiveFailures = 0;
  let sends = [];             // 发送时间戳（限速用）
  let lastSendResult = null;
  let lastEvalAt = 0;
  let lastDispatchAt = 0;
  let lastError = null;
  let sweepTimer = null;
  let dispatching = false;
  const startedAt = now();
  let failStats = { windowMs: ALERT_DEFAULTS.windowMs, total: 0, failed: 0, rate: 0, consecutiveFailures: 0, quota: 0, stall: 0, inflight: 0 };
  let lastFailureEvalAt = 0;
  let evalScheduled = null;
  const sweepStats = { runAt: 0, runs: 0 };
  const pendingIds = new Set(); // 正在发送中的告警 id（同步去重）

  const cfg = () => applyEnvOverrides(normalizeAlerts(getConfig()));

  /** 是否至少配好了一个通道（配好之前是 log-only） */
  const channelReady = (c) => !!(
    (c.channels.email && c.email.host && c.email.to.length)
    || (c.channels.webhook && c.webhook.url)
  );

  // ── 持久化 ──────────────────────────────────────────────
  function loadState() {
    try {
      if (!statePath || !fs.existsSync(statePath)) return;
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      for (const a of raw.active || []) active.set(a.id, a);
      history = Array.isArray(raw.history) ? raw.history : [];
      sends = Array.isArray(raw.sends) ? raw.sends : [];
    } catch (e) {
      log('warn', 'Alerts state load failed', { path: statePath, message: e.message });
    }
  }
  function saveState() {
    if (!statePath) return;
    try {
      fs.mkdirSync(dirname(statePath), { recursive: true });
      const tmp = statePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        active: [...active.values()], history: history.slice(-500), sends, savedAt: now(),
      }, null, 0), 'utf-8');
      fs.renameSync(tmp, statePath);
    } catch (e) {
      log('warn', 'Alerts state save failed', { path: statePath, message: e.message });
    }
  }

  // ── 发送 ────────────────────────────────────────────────
  function hourlyCount() {
    const cut = now() - 3600 * 1000;
    sends = sends.filter((t) => t > cut);
    return sends.length;
  }

  function snapshotKeys(c) {
    const keys = getKeys() || [];
    const withCredits = keys.filter((k) => k.credits && !k.credits.error);
    withCredits.sort((a, b) => (Number(a.credits?.creditsRemaining) || 0) - (Number(b.credits?.creditsRemaining) || 0));
    const rest = keys.filter((k) => !withCredits.includes(k));
    const ordered = [...withCredits, ...rest].slice(0, 12);
    const newest = keys.reduce((m, k) => Math.max(m, Number(k.credits?.fetchedAt) || 0), 0);
    return {
      total: keys.length,
      usable: keys.filter((k) => isUsable(k)).length,
      creditsAt: Math.max(getCreditsRefresh?.()?.lastAt || 0, newest),
      keys: ordered,
      keysTruncated: Math.max(0, keys.length - ordered.length),
      cfg: c,
      adminUrl,
    };
  }

  /** 真正投递一封（不走去重/限速，供测试与 dispatch 复用） */
  async function deliver({ subject, text, level, findings = [], recovery = [] }) {
    const c = cfg();
    const payload = { subject, text, level, findings, recovery };
    const results = {};
    const channels = [];
    if (c.channels.email) {
      const r = await smtpSend(c.email, { subject, text, to: c.email.to }, { timeoutMs: c.timeoutMs, log });
      results.email = r;
      if (r.ok) channels.push('email');
    }
    if (c.channels.webhook && c.webhook.url) {
      const r = await postWebhook(c.webhook, payload, { timeoutMs: c.timeoutMs });
      results.webhook = r;
      if (r.ok) channels.push('webhook');
    }
    lastSendResult = {
      at: now(), ok: channels.length > 0, channels,
      email: results.email ? { ok: results.email.ok, error: results.email.error || null } : null,
      webhook: results.webhook ? { ok: results.webhook.ok, error: results.webhook.error || null, type: results.webhook.type } : null,
    };
    if (!lastSendResult.ok) {
      lastError = results.email?.error || results.webhook?.error || null;
    } else {
      lastError = null;
    }
    return { results, channels };
  }

  /**
   * 投递一批告警（findings = 新增/升级，recovery = 已恢复）。
   * 去重规则：未恢复前同一 id 只发一次；升级 warn→critical 立刻发；
   * 开启 repeatWhenStuck 时按 cooldownMs 重发提醒；每小时发送数有上限。
   * 注意：active 的更新是同步的（在任何 await 之前），所以同一事件重复触发不会刷屏。
   */
  async function dispatch({ findings = [], recovery = [] }) {
    if (dispatching) return { skipped: 'busy' };
    const c = cfg();
    const toSend = [];
    const toRecover = [];
    const t = now();

    for (const f of findings) {
      const prev = active.get(f.id);
      const last = lastSent.get(f.id) || 0;
      const escalate = prev && prev.level !== f.level && f.level === 'critical';
      const repeat = c.repeatWhenStuck && c.cooldownMs > 0 && t - (prev?.lastSentAt || 0) >= c.cooldownMs;
      const inCooldown = c.cooldownMs > 0 && t - last < c.cooldownMs;
      if (!prev && !inCooldown) toSend.push(f);
      else if (escalate) toSend.push(f);
      else if (repeat) toSend.push(f);
      active.set(f.id, {
        ...(prev || {}), id: f.id, category: f.category, level: f.level, title: f.title,
        detail: f.detail || '', firstAt: prev?.firstAt || t, value: f.value ?? null,
      });
    }
    for (const id of recovery) {
      const prev = active.get(id);
      if (!prev) continue;
      active.delete(id);
      if (c.notifyRecovery) toRecover.push({ ...prev, level: 'recovery' });
    }

    // 只记日志（没配任何通道）时也要在日志里看得见
    for (const f of toSend) log(f.level === 'critical' ? 'error' : 'warn', `[alert] ${f.title}`, { detail: f.detail, id: f.id });
    for (const r of toRecover) log('info', `[alert:recovered] ${r.title}`, { id: r.id });

    if (!toSend.length && !toRecover.length) return { sent: 0, recovered: toRecover.length };
    if (!c.enabled) {
      for (const f of toSend) record({ ...f, status: 'disabled' });
      return { sent: 0, recovered: toRecover.length, disabled: true };
    }

    // 没配任何通道：告警只进日志与历史（log-only），不算投递失败
    if (!channelReady(c)) {
      for (const f of [...toSend, ...toRecover]) record({ ...f, status: 'log-only' });
      return { sent: 0, recovered: toRecover.length, logOnly: true };
    }

    const budget = c.maxSendsPerHour - hourlyCount();
    if (budget <= 0) {
      log('warn', '[alert] 已达每小时发送上限，本次只记录不发送', { max: c.maxSendsPerHour });
      for (const f of toSend) record({ ...f, status: 'rate-limited' });
      return { sent: 0, recovered: toRecover.length, rateLimited: true };
    }

    const batch = [...toSend, ...toRecover];
    const take = batch.slice(0, budget);
    for (const f of batch.slice(budget)) record({ ...f, status: 'rate-limited' });
    dispatching = true;
    for (const f of take) pendingIds.add(f.id);
    try {
      const text = buildAlertText({
        findings: take.filter((f) => f.level !== 'recovery'),
        recovery: take.filter((f) => f.level === 'recovery'),
        snapshot: snapshotKeys(c), now: t, host,
      });
      const { channels } = await deliver({ subject: text.subject, text: text.text, level: text.level, findings: take });
      sends.push(now());
      lastDispatchAt = now();
      for (const f of take) {
        if (f.level !== 'recovery') {
          lastSent.set(f.id, now());
          const st = active.get(f.id) || f;
          active.set(f.id, { ...st, lastSentAt: now(), sends: (st.sends || 0) + 1 });
        }
        record({ ...f, status: channels.length ? 'sent' : 'failed', channels });
      }
      return { sent: take.length, recovered: toRecover.length, channels };
    } finally {
      dispatching = false;
      for (const f of take) pendingIds.delete(f.id);
    }
  }

  function record(entry) {
    history.push({
      at: now(), level: entry.level, title: entry.title, detail: entry.detail || '',
      id: entry.id || null, status: entry.status || 'sent', channels: entry.channels || [],
    });
    const max = cfg().maxHistory;
    if (history.length > max) history = history.slice(-max);
    saveState();
  }

  /**
   * 紧急事件（Key 用尽/失效、池不可用）不等轮询，但 2 秒内的多个紧急事件合并成一封信，
   * 避免一次事故（比如同一秒 5 个 Key 都撞额度）炸出 5 封邮件。
   */
  const immediate = { queue: [], timer: null };
  async function evaluateImmediate({ findings = [] } = {}) {
    for (const f of findings) {
      if (active.has(f.id) || pendingIds.has(f.id)) continue;
      pendingIds.add(f.id);
      immediate.queue.push(f);
    }
    if (!immediate.queue.length || immediate.timer) return;
    immediate.timer = setTimeout(async () => {
      immediate.timer = null;
      const batch = immediate.queue;
      immediate.queue = [];
      for (const f of batch) pendingIds.delete(f.id);
      if (!batch.length) return;
      try { await dispatch({ findings: batch }); } catch (e) { log('warn', 'Alert dispatch failed', { message: e.message }); }
    }, 2000);
    immediate.timer.unref?.();
  }

  // ── 评估 ────────────────────────────────────────────────
  /** 余额/池健康：一轮额度刷新后跑一次 */
  async function evaluateCredits({ keys = getKeys(), creditsRefresh = getCreditsRefresh?.() } = {}) {
    const c = cfg();
    const findings = [];
    for (const k of keys) findings.push(...checkKeyCredits(k, c));
    findings.push(...checkPoolHealth({
      keys, usableCount: keys.filter((k) => isUsable(k)).length, creditsRefresh, cfg: c,
    }));

    // 恢复：本类别里已不再触发的告警
    const ids = new Set(findings.map((f) => f.id));
    const recovery = [...active.values()]
      .filter((a) => a.category === 'credits' || a.category === 'pool')
      .filter((a) => !ids.has(a.id))
      .map((a) => a.id);

    lastEvalAt = now();
    return dispatch({ findings, recovery });
  }

  /** 失败率/连续失败/上游故障：窗口内统计 */
  async function evaluateFailures() {
    const c = cfg();
    const { findings, stats } = checkFailureStats({
      samples, faults, consecutiveFailures, cfg: c, now: now(),
    });
    failStats = stats;
    const ids = new Set(findings.map((f) => f.id));
    const recovery = [...active.values()]
      .filter((a) => a.category === 'failures')
      .filter((a) => !ids.has(a.id))
      .map((a) => a.id);
    lastEvalAt = now();
    return dispatch({ findings, recovery });
  }

  /** 结果记录后的节流评估（最多 8s 一次，避免高并发下反复算窗口） */
  function scheduleFailureEval() {
    if (evalScheduled) return;
    evalScheduled = setTimeout(async () => {
      evalScheduled = null;
      if (now() - lastFailureEvalAt < 8000) return;
      lastFailureEvalAt = now();
      try { await evaluateFailures(); } catch (e) { log('warn', 'Alert failure eval error', { message: e.message }); }
    }, 1500);
    evalScheduled.unref?.();
  }

  // ── 对外采集接口（proxy.mjs 的钩子） ───────────────────

  /** 一次请求的最终结果（HTTP 状态码视角） */
  function noteRequestOutcome({ status, path = '', durationMs = 0 } = {}) {
    const s = Number(status) || 0;
    if (s === 0) return;
    const failure = Number(s) >= 500 || FAILURE_STATUSES.has(s);
    // 4xx 里 400/404/405/413/422 属于调用方参数问题，不计入失败率
    const ignorable = s >= 400 && s < 500 && !FAILURE_STATUSES.has(s);
    if (ignorable) return;
    samples.push({ ts: now(), ok: !failure, status: s, path, durationMs });
    if (failure) consecutiveFailures++;
    else consecutiveFailures = 0;
    if (samples.length > 4000) samples = samples.slice(-2000);
    scheduleFailureEval();
  }

  /** 上游失败（来自 markKeyFailure 的 trigger） */
  function noteUpstreamFailure({ trigger = 'any-error', keyId = null, label = null, status = 0 } = {}) {
    if (trigger === 'quota-exhausted' || trigger === 'disabled') {
      faults.push({ ts: now(), kind: 'quota', trigger, keyId, label, status });
      if (faults.length > 4000) faults = faults.slice(-2000);
      scheduleFailureEval();
    }
  }

  /** Key 被自动停用（余额用尽 / 凭证失效）—— 立刻告警，不等下一轮轮询 */
  function noteKeyDisabled({ keyId, label, reason = 'unknown', until = null } = {}) {
    if (!keyId) return;
    const id = reason === 'quota-exhausted' ? `credits-exhausted:${keyId}` : `key-invalid:${keyId}`;
    if (active.has(id) || pendingIds.has(id)) return;   // 已经发过，等恢复通知
    const title = reason === 'quota-exhausted'
      ? `余额/额度已用尽 · ${label || keyId}`
      : `凭证失效 · ${label || keyId}`;
    const detail = reason === 'quota-exhausted'
      ? `该 Key 已被自动停用${until ? `，预计 ${tsText(until)} 恢复` : ''}，会话会自动换到其它 Key。`
      : '上游返回未授权（401），该 Key 已自动停用，需要换一个新的 Key。';
    evaluateImmediate({ findings: [{ id, category: 'credits', level: 'critical', title, detail }] })
      .catch((e) => log('warn', 'Alert dispatch failed', { message: e.message }));
  }

  /** 池整体不可用 */
  function notePoolUnavailable({ total = 0, usable = 0 } = {}) {
    const id = 'pool-unavailable:pool';
    if (active.has(id) || pendingIds.has(id)) return;
    const title = '池内已无可用 Key';
    const detail = `当前 ${total} 个 Key、可用 ${usable} 个，请求会立刻返回错误。`;
    evaluateImmediate({ findings: [{ id, category: 'pool', level: 'critical', title, detail }] })
      .catch((e) => log('warn', 'Alert dispatch failed', { message: e.message }));
  }

  /** 从 log() 里捞上游故障信号 */
  function noteLog(level, msg, data) {
    const m = LOG_FAULT_MAP[msg];
    if (!m) return;
    faults.push({
      ts: now(), kind: m.kind, detail: m.detail,
      keyId: data?.keyId || null, model: data?.model || null, path: data?.path || null,
    });
    if (faults.length > 4000) faults = faults.slice(-2000);
    scheduleFailureEval();
  }

  /** 定期体检：清窗口、清过期告警、补恢复通知 */
  async function sweep() {
    const c = cfg();
    const cut = now() - Math.max(c.windowMs * 2, 10 * 60 * 1000);
    samples = samples.filter((s) => s.ts > cut);
    faults = faults.filter((f) => f.ts > cut);
    if (consecutiveFailures > 0 && samples.length && now() - samples[samples.length - 1].ts > c.windowMs) {
      consecutiveFailures = 0;      // 长时间没请求，别把旧的连续失败一直挂着
    }
    try {
      await evaluateFailures();
      await evaluateCredits();
      sweepStats.runAt = now();
      sweepStats.runs++;
    } catch (e) {
      log('warn', 'Alert sweep failed', { message: e.message });
    }
    saveState();
  }

  function start({ warmupMs = 5000 } = {}) {
    loadState();
    const c = cfg();
    if (!sweepTimer) {
      sweepTimer = setInterval(() => { sweep().catch(() => {}); }, Math.max(10 * 1000, c.sweepMs));
      sweepTimer.unref?.();
    }
    // 启动后先体检一次：keys.json 里带着上次的额度数据，重启后低额度要能立刻告警
    const warm = setTimeout(() => { sweep().catch(() => {}); }, Math.max(0, warmupMs));
    warm.unref?.();
    return { stateFile: statePath, restoredActive: active.size, history: history.length };
  }
  function stop() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    if (evalScheduled) { clearTimeout(evalScheduled); evalScheduled = null; }
    if (immediate.timer) { clearTimeout(immediate.timer); immediate.timer = null; }
  }

  /** 手动立刻检测一次 */
  async function checkNow() {
    await evaluateCredits();
    await evaluateFailures();
    return stats();
  }

  /** 发测试邮件/测试 webhook（不受 enabled 与去重限制） */
  async function test({ channel = 'all' } = {}) {
    const c = cfg();
    const text = buildAlertText({
      findings: [{
        id: 'test', category: 'test', level: 'warn', title: '这是一封测试告警',
        detail: '如果你能收到这封邮件，说明告警通道配置成功；真实告警会在余额不足或失败率过高时发出。',
      }],
      snapshot: snapshotKeys(c), host,
    });
    const results = {};
    if ((channel === 'all' || channel === 'email') && c.channels.email) {
      results.email = await smtpSend(c.email, { subject: `[CC-Proxy 测试] 告警通道自检`, text: text.text, to: c.email.to }, { timeoutMs: c.timeoutMs, log });
    }
    if ((channel === 'all' || channel === 'webhook') && c.channels.webhook && c.webhook.url) {
      results.webhook = await postWebhook(c.webhook, {
        subject: '[CC-Proxy 测试] 告警通道自检', text: text.text, level: 'warn', findings: [], recovery: [],
      }, { timeoutMs: c.timeoutMs });
    }
    if (!Object.keys(results).length) {
      return { ok: false, error: '没有启用任何通道，或通道未配置（host/收件人/webhook URL）', results };
    }
    const ok = Object.values(results).every((r) => r.ok);
    lastSendResult = {
      at: now(), ok, channels: Object.entries(results).filter(([, r]) => r.ok).map(([k]) => k),
      email: results.email ? { ok: results.email.ok, error: results.email.error || null } : null,
      webhook: results.webhook ? { ok: results.webhook.ok, error: results.webhook.error || null, type: results.webhook.type } : null,
    };
    if (ok) sends.push(now());
    return { ok, results, detail: results };
  }

  function clear({ history: clearHistory = false } = {}) {
    const n = active.size;
    active.clear();
    if (clearHistory) history = [];
    saveState();
    return { cleared: n, historyCleared: clearHistory };
  }

  function stats() {
    const c = cfg();
    const keys = getKeys() || [];
    return {
      enabled: c.enabled,
      config: maskConfig(c),
      active: [...active.values()].sort((a, b) => (b.level === 'critical') - (a.level === 'critical')),
      window: { ...failStats, windowMs: c.windowMs },
      counters: {
        samples: samples.length, faults: faults.length,
        consecutiveFailures,
        sentLastHour: sends.filter((t) => t > now() - 3600 * 1000).length,
        maxSendsPerHour: c.maxSendsPerHour,
        startedAt, lastEvalAt, lastDispatchAt,
        sweepRuns: sweepStats.runs, sweepAt: sweepStats.runAt,
      },
      pool: {
        total: keys.length,
        usable: keys.filter((k) => isUsable(k)).length,
      },
      lastSend: lastSendResult,
      lastError,
      history: history.slice(-60).reverse(),
      statePath: statePath || null,
    };
  }

  /** 保存配置（管理台 PUT）：逐段合并，未提供的字段保持原值 */
  function updateConfig(patch) {
    const raw = { ...(getConfig() || {}) };
    if (patch?.email) raw.email = { ...(raw.email || {}), ...patch.email };
    if (patch?.webhook) raw.webhook = { ...(raw.webhook || {}), ...patch.webhook };
    if (patch?.channels) raw.channels = { ...(raw.channels || {}), ...patch.channels };
    const merged = normalizeAlerts({ ...raw, ...(patch || {}), email: raw.email, webhook: raw.webhook, channels: raw.channels });
    // 管理台不回传密码：没带 pass（或带哨兵值）表示「保持原值」
    const stored = normalizeAlerts(getConfig());
    if (patch?.email?.pass === undefined || patch?.email?.pass === null || patch?.email?.pass === '__KEEP__') {
      merged.email.pass = stored.email.pass;
    }
    if (patch?.email?.to === undefined) merged.email.to = stored.email.to;
    setConfig(merged);
    return merged;
  }

  /** 保存配置并给出提示：收件人里有非法值、开了邮件通道但没收件人等情况 */
  function saveConfig(patch) {
    const before = cfg();
    const wasReady = channelReady(before);
    const merged = updateConfig(patch);
    const warnings = recipientWarnings(patch?.email?.to ?? (getConfig()?.email?.to))
      .map((s) => `收件人「${s}」不是有效邮箱，已忽略`);
    if (merged.channels.email && !merged.email.host) warnings.push('邮件通道已开启但没填 SMTP 服务器');
    if (merged.channels.email && merged.email.host && !merged.email.to.length) warnings.push('邮件通道已开启但没有有效收件人');
    if (merged.channels.webhook && !merged.webhook.url) warnings.push('Webhook 通道已开启但没填地址');

    // 从「没配通道」变成「配好了」：把现有告警的已发送标记清掉，
    // 让当前真实存在的问题立刻补发一轮（否则用户配完 SMTP 还要等下次恢复再触发才看得到邮件）
    const nowReady = channelReady(cfg());
    if (!wasReady && nowReady) {
      const n = active.size;
      active.clear();
      lastSent.clear();
      log('info', '[alert] 通道刚配置完成，现有告警将重新发送一轮', { pending: n });
    }
    return { config: merged, warnings, rearmed: !wasReady && nowReady };
  }

  return {
    start, stop, stats, test, checkNow, clear, updateConfig, saveConfig,
    config: () => cfg(),
    maskedConfig: () => maskConfig(cfg()),
    evaluateCredits, evaluateFailures, sweep,
    noteRequestOutcome, noteUpstreamFailure, noteKeyDisabled, notePoolUnavailable, noteLog,
    // 供测试注入
    _internals: {
      dispatch, deliver, snapshotKeys, active, history: () => history,
      samples: () => samples, faults: () => faults,
      setConsecutive: (n) => { consecutiveFailures = n; },
    },
  };
}

export const defaultStatePath = (keysPath) => resolve(dirname(keysPath), 'alerts-state.json');
