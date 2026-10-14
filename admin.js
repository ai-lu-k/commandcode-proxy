/* ============================================================
   Command Code Proxy · Key 池管理台（前端）
   纯原生实现，无构建步骤，直接由 proxy.mjs 静态托管。
   ============================================================ */
(function () {
  'use strict';

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

  /** 内联 SVG 图标（精灵定义在 index.html 顶部） */
  const icon = (name, cls = '') =>
    `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  /* ── 主题 ────────────────────────────────────────────── */
  const themeBtn = $('#btnTheme');
  const metaTheme = document.querySelector('meta[name="theme-color"]');

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    if (metaTheme) metaTheme.setAttribute('content', t === 'light' ? '#f3f4fa' : '#07080d');
    try { localStorage.setItem('cc-proxy-theme', t); } catch { /* 隐私模式忽略 */ }
  }
  function initialTheme() {
    // 支持 ?theme=dark|light 深链，便于分享/嵌入时固定主题
    try {
      const q = new URLSearchParams(location.search).get('theme');
      if (q === 'light' || q === 'dark') return q;
    } catch { /* 忽略 */ }
    try {
      const saved = localStorage.getItem('cc-proxy-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch { /* 忽略 */ }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  applyTheme(initialTheme());
  themeBtn.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });

  /* ── Toast ───────────────────────────────────────────── */
  const toastEl = $('#toast');
  let toastTimer = null;
  function toast(msg, kind = 'ok') {
    toastEl.className = 'toast ' + (kind === 'err' ? 'err' : 'ok');
    toastEl.innerHTML = icon(kind === 'err' ? 'alert' : 'check-circle') + '<span></span>';
    toastEl.lastElementChild.textContent = msg; // 文本节点，避免注入
    // 重启入场动画
    toastEl.style.animation = 'none';
    void toastEl.offsetWidth;
    toastEl.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3000);
  }

  /* ── API ─────────────────────────────────────────────── */
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  /* ── 格式化 ──────────────────────────────────────────── */
  const pad = (n) => String(n).padStart(2, '0');

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtClock(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function fmtNum(n) {
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }
  /** 相对时间：3 分钟前 */
  function fmtAgo(ts) {
    if (!ts) return '从未使用';
    const diff = Date.now() - ts;
    if (diff < 0) return fmtTime(ts);
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前`;
    return fmtTime(ts);
  }
  /** 倒计时：2 天 3 小时 / 38 分钟后 */
  function fmtCountdown(ts) {
    if (!ts) return '—';
    const diff = ts - serverNow();
    if (diff <= 0) return '已重置';
    const m = Math.ceil(diff / 60000);
    if (m < 60) return `${m} 分钟后`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时 ${m % 60} 分后`;
    return `${Math.floor(h / 24)} 天 ${h % 24} 小时后`;
  }
  /** 时长：45 秒 / 15 分 / 3 分 20 秒 / 2 小时 5 分 */
  function fmtDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return `${total} 秒`;
    if (total < 3600) {
      const m = Math.floor(total / 60);
      const s = total % 60;
      return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
    }
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  }
  /** 用服务端时间校准的“现在”，避免前后端时钟偏差导致倒计时不准 */
  function serverNow() {
    return Date.now() + (state.serverSkew || 0);
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function truncate(s, n) {
    const str = String(s ?? '');
    return str.length > n ? str.slice(0, n) + '…' : str;
  }
  const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  /** 用量等级：越高越危险 */
  const levelOf = (pct) => (pct >= 80 ? 'danger' : pct >= 50 ? 'warn' : 'ok');
  const WIN_NAMES = { '5h': '5 小时窗口', weekly: '本周窗口' };

  /* ── 状态 ────────────────────────────────────────────── */
  const state = {
    keys: [],
    lb: null,
    settings: {
      mode: 'session',
      failThreshold: 3,
      creditsRefreshMs: 0,
      autoDisableExhausted: true,
      onAllExhausted: 'error',
    },
    creditsRefresh: null,
    sessions: [],
    poolOrder: [],
    alerts: null,
    serverSkew: 0,
    tab: 'keys',
    filter: 'all',
    query: '',
    sort: 'default',
    busy: new Set(),   // 正在刷新额度的 Key id
    loading: true,
  };

  const FILTERS = ['all', 'usable', 'exhausted', 'cooling'];

  /* ── 过滤 / 排序 ─────────────────────────────────────── */
  function matchesFilter(k) {
    if (state.filter === 'usable' && !isUsableClient(k)) return false;
    if (state.filter === 'exhausted' && !k.autoDisabled) return false;
    if (state.filter === 'cooling' && !k.cooling) return false;
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return [k.label, k.keyPrefix, k.id]
      .some((v) => String(v ?? '').toLowerCase().includes(q));
  }

  const SORTERS = {
    // 「池内选取顺序」直接用服务端算好的 poolOrder（真空闲 → 相对空闲 → priority → 到期 …）
    default: (a, b) => (poolRank(a.id) - poolRank(b.id)) || ((a.createdAt || 0) - (b.createdAt || 0)),
    'credits-desc': (a, b) => (b.credits?.creditsRemaining ?? -1) - (a.credits?.creditsRemaining ?? -1),
    'usage-desc': (a, b) => (b.credits?.worstPct ?? -1) - (a.credits?.worstPct ?? -1),
    'weight-desc': (a, b) => (b.weight ?? 0) - (a.weight ?? 0),
    'label-asc': (a, b) => String(a.label ?? '').localeCompare(String(b.label ?? ''), 'zh-Hans-CN'),
  };

  /** 在服务端 poolOrder 里的位次；不在里面（不可用）的排到最后 */
  function poolRank(id) {
    const i = (state.poolOrder || []).findIndex((x) => x.id === id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  }

  /** 某个 Key 在选取顺序里的负载信息（用于卡片提示） */
  function poolInfo(id) {
    return (state.poolOrder || []).find((x) => x.id === id) || null;
  }

  function visibleKeys() {
    const list = state.keys.filter(matchesFilter);
    const sorter = SORTERS[state.sort];
    return sorter ? list.slice().sort(sorter) : list;
  }

  /* ── 片段渲染 ────────────────────────────────────────── */

  /** 窗口剩余比例：100 - 最高已用（100 = 完全没用过，0 = 已用尽） */
  function remainingPct(k) {
    const c = k.credits;
    if (!c || c.error) return null;
    const worst = clampPct(c.worstPct);
    return clampPct(100 - worst);
  }
  /** 剩余额度等级：充裕=ok，偏低=warn，告急=danger */
  function levelByRemaining(pct) {
    if (pct == null) return 'none';
    if (pct <= 10) return 'danger';
    if (pct <= 35) return 'warn';
    return 'ok';
  }

  function ringHtml(k) {
    const remaining = remainingPct(k);
    if (remaining == null) {
      return `<span class="ring lvl-none" style="--p:0" title="还没有额度数据"><span>—</span></span>`;
    }
    return `<span class="ring lvl-${levelByRemaining(remaining)}" style="--p:${remaining}"
      title="窗口额度剩余 ${remaining}%（按已用最高的窗口计算）"><span>${remaining}%</span></span>`;
  }

  function creditsBlock(k) {
    const c = k.credits;
    let body;
    if (!c) {
      body = `<span class="kc-cred-label">剩余额度</span>
        <strong>未查询</strong>
        <small>点击 ⟳ 查询</small>`;
    } else if (c.error) {
      body = `<span class="kc-cred-label">剩余额度</span>
        <span class="badge danger" title="${escapeHtml(c.error)}">查询失败</span>
        <small title="${escapeHtml(c.error)}">${escapeHtml(truncate(c.error, 24))}</small>`;
    } else {
      body = `<span class="kc-cred-label">剩余额度</span>
        <strong>${fmtNum(c.creditsRemaining)}</strong>
        <small>${c.plan ? escapeHtml(c.plan) : '已同步'} · ${fmtAgo(c.fetchedAt)}</small>`;
    }
    const sub = subInfo(k);
    const subLine = sub
      ? `<small class="kc-sub" title="订阅${sub.willRenew ? '（自动续费）' : ''} · ${fmtTime(sub.at)}">订阅${sub.willRenew ? '续费' : '到期'} ${fmtCountdown(sub.at)}</small>`
      : '';
    return `<div class="kc-gauge">${ringHtml(k)}<div class="kc-cred">${body}${subLine}</div></div>`;
  }

  function windowsBlock(k) {
    const c = k.credits;
    if (!c || c.error || !c.windows?.length) return '';
    return `<div class="kc-wins">${c.windows.slice(0, 2).map((w) => {
      const pct = clampPct(w.pct);
      const resets = w.resetsAt ? `<span class="sep">·</span><span>重置 ${fmtCountdown(w.resetsAt)}</span>` : '';
      return `<div class="win lvl-${levelOf(pct)}">
        <div class="win-top">
          <span class="win-name">${escapeHtml(WIN_NAMES[w.name] || w.name)}</span>
          <span class="win-pct">${pct}%</span>
        </div>
        <div class="win-bar"><i style="width:${pct}%"></i></div>
        <div class="win-foot"><span>${fmtNum(w.used)} / ${fmtNum(w.cap)}</span>${resets}</div>
      </div>`;
    }).join('')}</div>`;
  }

  /** 订阅到期信息：到期时间 + 剩余时间 + 套餐 */
  function subInfo(k) {
    const s = k?.credits?.subscription || null;
    const at = Number(s?.expiresAt ?? k?.expiresAt) || null;
    if (!at) return null;
    return {
      at,
      left: at - serverNow(),
      plan: s?.planId || k?.credits?.plan || null,
      status: s?.status || null,
      willRenew: !!s?.willRenew,
    };
  }

  /** 订阅到期徽标：已过期 / 3 天内到期 / 正常 */
  function subscriptionBadge(k) {
    const s = subInfo(k);
    if (!s) return '';
    const exp = s.left <= 0;
    const soon = !exp && s.left <= 3 * 24 * 3600 * 1000;
    const cls = exp ? 'danger' : soon ? 'warn' : '';
    const label = exp ? '订阅已过期' : `订阅 ${fmtCountdown(s.at)}过期`;
    const title = [
      s.plan ? `套餐 ${s.plan}` : null,
      s.status ? `状态 ${s.status}` : null,
      `${exp ? '已结束' : '到期'} ${fmtTime(s.at)}`,
      s.willRenew ? '当前为自动续费' : '不会自动续费',
    ].filter(Boolean).join(' · ');
    return `<span class="badge ${cls}" title="${escapeHtml(title)}">${icon('clock')}${escapeHtml(label)}</span>`;
  }

  /** 自动停用徽标（额度用尽等），带恢复时间 */
  function autoDisabledBadge(k) {
    const ad = k.autoDisabled;
    if (!ad) return '';
    const reason = ad.reason === 'quota-exhausted' ? '额度用尽' : ad.reason === 'disabled' ? '凭证失效' : '自动停用';
    if (ad.until && ad.until > Date.now()) {
      return `<span class="badge danger" title="自动停用原因：${escapeHtml(ad.reason)}；预计 ${fmtTime(ad.until)} 恢复">${icon('alert')}${reason} · ${fmtCountdown(ad.until)}恢复</span>`;
    }
    return `<span class="badge danger" title="自动停用原因：${escapeHtml(ad.reason)}">${icon('alert')}${reason}</span>`;
  }

  /** 前端侧的"可用"判断，与后端 isKeyUsable 保持一致 */
  function isUsableClient(k) {
    if (!k.enabled || k.autoDisabled || k.cooling) return false;
    return true;
  }

  /** 池内选取位次徽标：第 1 位是「首选」，其余显示位次与当前负载 */
  function poolRankBadge(k) {
    const info = poolInfo(k.id);
    if (!info) return '';
    const rank = poolRank(k.id) + 1;
    const load = info.idle ? '真空闲' : `在途 ${info.inflight} · 会话 ${info.sessions}`;
    const title = `池内选择位次 #${rank}（${load}；优先级 ${info.priority}）`;
    return rank === 1
      ? `<span class="badge star" title="${escapeHtml(title)}">${icon('star-fill')}首选</span>`
      : `<span class="badge" title="${escapeHtml(title)}">#${rank} ${escapeHtml(load)}</span>`;
  }

  function keyCard(k, index) {
    const busy = state.busy.has(k.id);
    const cls = [
      'key-card',
      k.enabled ? '' : 'is-off',
      k.cooling ? 'is-cooling' : '',
      k.errorCount ? 'is-error' : '',
      busy ? 'is-busy' : '',
    ].filter(Boolean).join(' ');

    return `<article class="${cls}" data-id="${escapeHtml(k.id)}">
      <label class="switch" title="${k.enabled ? '点击停用' : '点击启用'}">
        <input type="checkbox" data-act="toggle" ${k.enabled ? 'checked' : ''} aria-label="启用状态" />
        <span class="track"></span>
      </label>

      <div class="kc-main">
        <div class="kc-title">
          <span class="kc-index">${pad(index + 1)}</span>
          <h4 title="${escapeHtml(k.label)}">${escapeHtml(k.label)}</h4>
          ${poolRankBadge(k)}
          ${k.enabled ? '' : `<span class="badge off">停用</span>`}
          ${subscriptionBadge(k)}
          ${autoDisabledBadge(k)}
          ${k.cooling ? `<span class="badge warn" title="冷却至 ${fmtTime(k.cooldownUntil)}">${icon('clock')}冷却中</span>` : ''}
          ${k.consecutiveFailures ? `<span class="badge danger" title="连续失败 ${k.consecutiveFailures} 次，达到阈值后会换 Key">${icon('alert')}连败 ${k.consecutiveFailures}</span>` : ''}
          ${k.activeSessions ? `<span class="badge">${icon('sliders')}${k.activeSessions} 会话</span>` : ''}
        </div>
        <div class="kc-meta">
          <button type="button" class="kc-key" data-act="copy" title="点击复制 Key ID">${escapeHtml(k.keyPrefix)}${icon('copy')}</button>
          <span class="sep">·</span>
          <span>权重 <b>${escapeHtml(k.weight)}</b></span>
          <span class="sep">·</span>
          <span title="${fmtTime(k.lastUsedAt)}">最近使用 ${fmtAgo(k.lastUsedAt)}</span>
          ${k.errorCount ? `<span class="sep">·</span><span title="累计错误 ${k.errorCount} 次">错误 ${k.errorCount}</span>` : ''}
        </div>
      </div>

      <div class="kc-actions">
        <button type="button" class="icon-btn" data-act="credits" title="查询该 Key 额度" aria-label="查询该 Key 额度">${icon('refresh')}</button>
        <button type="button" class="icon-btn" data-act="edit" title="编辑" aria-label="编辑">${icon('pencil')}</button>
        <button type="button" class="icon-btn tone-danger" data-act="del" title="删除" aria-label="删除">${icon('trash')}</button>
      </div>

      <div class="kc-stats">
        ${creditsBlock(k)}
        ${windowsBlock(k)}
      </div>
    </article>`;
  }

  function skeletonCard() {
    return `<div class="skeleton">
      <span class="sk-bar sk-avatar"></span>
      <div class="sk-stack">
        <span class="sk-bar" style="width:42%"></span>
        <span class="sk-bar"></span>
      </div>
      <div class="sk-right"><span class="sk-bar" style="width:34px;height:34px;border-radius:10px"></span><span class="sk-bar" style="width:34px;height:34px;border-radius:10px"></span></div>
      <div class="sk-stack" style="grid-column:2 / -1"><span class="sk-bar" style="width:70%"></span></div>
    </div>`;
  }

  /* ── 列表渲染 ────────────────────────────────────────── */
  function renderKeys() {
    const listEl = $('#keyList');
    $('#emptyKeys').classList.toggle('hidden', state.loading || state.keys.length > 0);

    // 过滤芯片计数
    const counts = {
      all: state.keys.length,
      usable: state.keys.filter(isUsableClient).length,
      exhausted: state.keys.filter((k) => k.autoDisabled).length,
      cooling: state.keys.filter((k) => k.cooling).length,
    };
    $$('#filterChips .seg').forEach((btn) => {
      const f = btn.dataset.filter;
      const badge = btn.querySelector('b');
      if (badge) badge.textContent = String(counts[f] ?? 0);
      btn.classList.toggle('is-active', state.filter === f);
    });

    if (state.loading) {
      listEl.innerHTML = skeletonCard() + skeletonCard() + skeletonCard();
      return;
    }

    const visible = visibleKeys();
    if (!visible.length) {
      const noFilter = !state.query.trim() && state.filter === 'all';
      listEl.innerHTML = noFilter ? '' : `<p class="empty">
        <span class="empty-icon">${icon('search')}</span>
        <b>没有匹配的 Key</b>
        <span>试试其它关键词，或切换状态筛选。</span>
        <button class="btn ghost sm" type="button" data-act="reset-filter">重置筛选条件</button>
      </p>`;
      return;
    }
    listEl.innerHTML = visible.map(keyCard).join('');
  }

  function renderStats() {
    const keys = state.keys;
    const usable = keys.filter(isUsableClient);
    const exhausted = keys.filter((k) => k.autoDisabled).length;
    const notEnabled = keys.filter((k) => !k.enabled).length;
    const synced = keys.filter((k) => k.credits && !k.credits.error);
    const sum = synced.reduce((s, k) => s + (k.credits?.creditsRemaining || 0), 0);

    $('#statTotal').textContent = String(keys.length);
    $('#statTotalSub').textContent = keys.length
      ? `启用 ${keys.length - notEnabled} · 停用 ${notEnabled}`
      : '池内暂无凭证';

    $('#statUsable').textContent = String(usable.length);
    const blocked = [];
    if (exhausted) blocked.push(`用尽 ${exhausted}`);
    const cooling = keys.filter((k) => k.cooling).length;
    if (cooling) blocked.push(`冷却 ${cooling}`);
    if (notEnabled) blocked.push(`停用 ${notEnabled}`);
    $('#statUsableSub').textContent = keys.length
      ? (blocked.length ? blocked.join(' · ') : '全部可参与分发')
      : '参与请求分发';

    $('#statCredits').textContent = synced.length ? fmtNum(sum) : '—';
    $('#statCreditsSub').textContent = keys.length
      ? `已同步 ${synced.length}/${keys.length} 个 Key`
      : '尚未查询额度';

    const sessions = state.sessions || [];
    $('#statSessions').textContent = String(sessions.length);
    $('#statSessionsSub').textContent = state.settings.mode === 'session'
      ? (sessions.length
        ? `分布在 ${new Set(sessions.map((s) => s.keyId)).size} 个 Key`
        : '会话粘性 · 等待请求')
      : '每次请求模式';

    renderPoolBadge();
    renderTabBadges();
  }

  /** 池健康概览：额度告急 / 冷却 / 出错的 Key 数量 */
  function renderPoolBadge() {
    const badge = $('#poolBadge');
    const keys = state.keys;
    if (state.loading) {
      badge.className = 'hero-badge tone-idle';
      badge.innerHTML = icon('shield') + '<span>正在加载…</span>';
      return;
    }
    if (!keys.length) {
      badge.className = 'hero-badge tone-idle';
      badge.innerHTML = icon('inbox') + '<span>池内暂无 Key</span>';
      return;
    }
    const attention = keys.filter((k) =>
      k.autoDisabled
      || k.cooling
      || k.consecutiveFailures > 0
      || (k.credits && k.credits.error)
      || (!k.credits && k.enabled)
    ).length;

    if (attention) {
      badge.className = 'hero-badge tone-warn';
      badge.innerHTML = icon('alert') + `<span>${attention} 个 Key 需要关注</span>`;
    } else {
      const usableNow = keys.filter(isUsableClient).length;
      badge.className = 'hero-badge tone-ok';
      badge.innerHTML = icon('shield') + `<span>池状态良好 · ${usableNow} 个 Key 可用</span>`;
    }
  }

  function renderAll() {
    renderKeys();
    renderStats();
  }

  function fillLb(lb) {
    if (!lb) return;
    state.lb = lb;
    $('#lbMaxRetries').value = lb.maxRetries ?? 2;
    $('#lbCooldownMs').value = lb.cooldownMs ?? 60000;
  }

  /* ── 视图路由（一级=数据源，二级=该源的分区） ────────────
     视图 id 形如 "cc/keys"、"wb/accounts"，hash 里直接用它，所以每个视图都能
     分享 / 刷新停留。

     旧的单段 hash（#keys、#workbuddy…）继续认 —— 管理台地址早就被人收藏成
     https://ai.lu-k.cn/proxy/admin#keys 了，不能把这个入口弄丢。 */
  const VIEW_STORE_KEY = 'cc-proxy-view';
  const LEGACY_VIEWS = {
    keys: 'cc/keys', routing: 'cc/routing', sessions: 'cc/sessions', alerts: 'cc/alerts',
    workbuddy: 'wb/accounts',
  };
  const FALLBACK_VIEW = 'home';

  function allViews() {
    return $$('.side-item[data-view]').map((b) => b.dataset.view);
  }
  function normalizeView(raw) {
    const v = String(raw || '').replace(/^#/, '').trim();
    if (!v) return '';
    if (v.includes('/')) return allViews().includes(v) ? v : '';
    return LEGACY_VIEWS[v] || '';
  }

  function setView(view, { save = true } = {}) {
    const list = allViews();
    const v = list.includes(view) ? view : FALLBACK_VIEW;
    state.view = v;
    state.tab = v;                       // 旧字段留着，别的地方还在读

    $$('.side-item[data-view]').forEach((btn) => {
      const on = btn.dataset.view === v;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-current', on ? 'page' : 'false');
      btn.tabIndex = on ? 0 : -1;
    });
    $$('.view-panel').forEach((panel) => {
      const on = panel.dataset.view === v;
      panel.classList.toggle('is-active', on);
      if (on) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
    });
    // hero 跟着数据源走：两套 KPI 不再混在同一块
    const source = v.split('/')[0];
    $$('.hero[data-source]').forEach((h) => {
      if (h.dataset.source === source) h.removeAttribute('hidden');
      else h.setAttribute('hidden', '');
    });
    document.body.dataset.source = source;

    if (save) { try { localStorage.setItem(VIEW_STORE_KEY, v); } catch { /* 忽略 */ } }
    if (location.hash.replace(/^#/, '') !== v) {
      try { history.replaceState(null, '', '#' + v); } catch { location.hash = v; }
    }

    // 各视图按需拉自己的数据，切过去才请求
    if (v === 'home') refreshOverview();
    if (v === 'cc/sessions') refreshSessions();
    if (v === 'cc/alerts') refreshAlerts();
    // 只要进了某个数据源，就把它那套 KPI 刷新一遍（两套 KPI 不再共用一块）
    if (source === 'wb') refreshWorkbuddy();
    if (v === 'wb/schedule') refreshWbSchedule();
    if (v === 'wb/usage') refreshWbUsage();
  }

  function initialView() {
    // 显式带上 hash 才深链到具体分区；否则一律落首页。
    // 这里刻意**不读** localStorage 的"上次位置"：`/proxy/admin` 就是这个面板的
    // 门面地址，打开它看到的应该是总览，而不是某人上次停留的子页。
    const fromHash = normalizeView(location.hash);
    if (fromHash) return fromHash;
    return FALLBACK_VIEW;
  }

  const sidebarEl = $('#sidebar');
  sidebarEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.side-item[data-view]');
    if (btn) setView(btn.dataset.view);
  });
  // 上下方向键在侧边栏里切换，保留原来 tablist 的操作习惯
  sidebarEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const list = allViews();
    if (!list.length) return;
    e.preventDefault();
    const cur = Math.max(0, list.indexOf(state.view));
    const next = (cur + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
    setView(list[next]);
    const btn = $(`.side-item[data-view="${list[next]}"]`);
    if (btn) btn.focus();
  });
  window.addEventListener('hashchange', () => {
    const v = normalizeView(location.hash);
    if (v && v !== state.view) setView(v, { save: false });
  });

  function renderTabBadges() {
    const keysCount = $('#tabKeysCount');
    if (keysCount) keysCount.textContent = String(state.keys.length);
    const sessCount = $('#tabSessionsCount');
    if (sessCount) sessCount.textContent = String((state.sessions || []).length);
    // 调度标签上点一个绿点，表示服务端定时轮询开着
    const dot = $('#tabRouteDot');
    if (dot) dot.hidden = !(Number(state.settings.creditsRefreshMs) > 0);
    // 告警标签显示未恢复告警数（0 就不显示徽标）
    const alertCount = $('#tabAlertsCount');
    if (alertCount) {
      const n = (state.alerts?.active || []).length;
      alertCount.textContent = String(n);
      alertCount.hidden = !n;
    }
    // WorkBuddy 标签显示账号池大小
    const wbCount = $('#tabWorkbuddyCount');
    if (wbCount) {
      const n = (state.wb?.accounts || []).length;
      wbCount.textContent = String(n);
      wbCount.hidden = !n;
    }
    // WorkBuddy 调度标签：hub 的定时调度器开着就点个绿点
    const wbDot = $('#tabWbSchedDot');
    if (wbDot) wbDot.hidden = !state.wb?.sched?.enabled;
  }

  /** 会话列表单独刷新（很轻，不动额度） */
  let lastSessionFetch = 0;
  async function refreshSessions() {
    lastSessionFetch = Date.now();
    try {
      const res = await api('/admin/api/sessions');
      state.sessions = res.sessions || [];
      renderSessions();
    } catch { /* 静默失败，下一轮再试 */ }
  }

  /* ── 告警（余额 / 失败率预警） ───────────────────────── */
  const ALERT_LEVEL_TEXT = { critical: '严重', warn: '警告', recovery: '已恢复' };
  let lastAlertFetch = 0;

  async function refreshAlerts() {
    lastAlertFetch = Date.now();
    try {
      const res = await api('/admin/api/alerts');
      state.alerts = res;
      if (res?.config) state.settings.alerts = res.config;
      fillAlerts(res);
      renderAlerts();
    } catch (e) {
      toast('告警状态加载失败：' + e.message, 'err');
    }
  }

  /** 只更新告警状态与标签徽标，不动表单（避免刷掉正在编辑的输入） */
  async function refreshAlertsSilent() {
    lastAlertFetch = Date.now();
    try {
      const res = await api('/admin/api/alerts');
      state.alerts = res;
      if (res?.config) state.settings.alerts = res.config;
      renderTabBadges();
    } catch { /* 静默失败，下一轮再试 */ }
  }

  function syncAlertChannelBoxes() {
    $('#alertEmailBox').classList.toggle('hidden', !$('#alertEmailOn').checked);
    $('#alertHookBox').classList.toggle('hidden', !$('#alertWebhookOn').checked);
  }

  function fillAlerts(stats) {
    const c = stats?.config || stats;
    if (!c) return;
    const e = c.email || {};
    const w = c.webhook || {};
    $('#alertEnabled').checked = c.enabled !== false;
    $('#alertEmailOn').checked = !!(c.channels && c.channels.email);
    $('#alertWebhookOn').checked = !!(c.channels && c.channels.webhook);
    $('#alertSmtpHost').value = e.host || '';
    $('#alertSmtpPort').value = e.port ?? 465;
    $('#alertSmtpUser').value = e.user || '';
    $('#alertSmtpPass').value = '';
    $('#alertSmtpPass').placeholder = e.passSet ? '已设置（留空 = 不修改）' : 'SMTP 授权码';
    $('#alertPassHint').textContent = e.passSet ? '已保存密码；要清除请勾选下方「清除已保存的密码」' : 'QQ/163 邮箱填授权码，不是登录密码';
    $('#alertPassClear').checked = false;
    $('#alertSmtpFrom').value = e.from || '';
    $('#alertSmtpTo').value = (e.to || []).join(', ');
    $('#alertSmtpSecure').checked = e.secure !== false;
    $('#alertSmtpPlain').checked = !!e.allowPlaintextAuth;
    $('#alertHookUrl').value = w.url || '';
    $('#alertHookType').value = w.type || 'auto';
    $('#alertMinCredits').value = c.minCreditsPerKey;
    $('#alertMinUsable').value = c.minUsableKeys;
    $('#alertWinWarn').value = c.windowPctWarn;
    $('#alertWinCrit').value = c.windowPctCritical;
    $('#alertFetchFail').value = c.creditsFetchFailWarn;
    $('#alertWindowSec').value = Math.round(Number(c.windowMs) / 1000);
    $('#alertMinSamples').value = c.minSamples;
    $('#alertRateWarn').value = c.failureRateWarn;
    $('#alertRateCrit').value = c.failureRateCritical;
    $('#alertConsecutive').value = c.consecutiveFailuresCritical;
    $('#alertQuotaFaults').value = c.quotaFaultsCritical;
    $('#alertStalls').value = c.stallsWarn;
    $('#alertInflight').value = c.inflightWarn;
    $('#alertCooldownMin').value = Math.round(Number(c.cooldownMs) / 60000);
    $('#alertMaxHour').value = c.maxSendsPerHour;
    $('#alertRepeat').checked = !!c.repeatWhenStuck;
    $('#alertRecovery').checked = c.notifyRecovery !== false;
    syncAlertChannelBoxes();
  }

  function alertItemHtml(a, { history = false } = {}) {
    const lv = a.level === 'critical' ? 'crit' : a.level === 'recovery' ? 'rec' : 'warn';
    const status = history
      ? ({ sent: '已发送', failed: '发送失败', 'log-only': '仅记录（未配通道）', disabled: '已关闭发送', 'rate-limited': '超出小时限额' }[a.status] || a.status)
      : '';
    const channels = (a.channels || []).length ? ` · ${a.channels.join('+')}` : '';
    return `<div class="alert-item ${lv}">
      <span class="alert-tag">${ALERT_LEVEL_TEXT[a.level] || a.level}</span>
      <div class="alert-body">
        <b>${escapeHtml(a.title || '')}</b>
        ${a.detail ? `<span>${escapeHtml(a.detail)}</span>` : ''}
        <small>${history
          ? `${fmtTime(a.at)}${status ? ` · ${status}` : ''}${channels}`
          : `触发于 ${fmtTime(a.firstAt)} · ${a.sends ? `已发送 ${a.sends} 次（最近 ${fmtTime(a.lastSentAt)}）` : '尚未发送'}`}</small>
      </div>
    </div>`;
  }

  function renderAlerts() {
    const s = state.alerts;
    if (!$('#alertActive')) return;
    renderTabBadges();

    const active = s?.active || [];
    $('#alertActive').innerHTML = active.length
      ? active.map((a) => alertItemHtml(a)).join('')
      : '<p class="empty sm"><span class="empty-icon" aria-hidden="true">'
        + icon('shield') + '</span><span>当前没有未恢复的告警。</span></p>';

    const hist = s?.history || [];
    $('#alertHistory').innerHTML = hist.length
      ? `<h3 class="alert-group-title">最近通知</h3>${hist.slice(0, 30).map((a) => alertItemHtml(a, { history: true })).join('')}`
      : '';

    // 状态卡片：窗口失败率 / 通道就绪 / 上次发送结果
    const box = $('#alertStatus');
    if (!box || !s) return;
    const w = s.window || {};
    const counters = s.counters || {};
    const last = s.lastSend;
    const eff = s.config?.effective || {};
    const rateTone = s.config && w.rate >= s.config.failureRateCritical && w.total >= s.config.minSamples
      ? 'crit' : (s.config && w.rate >= s.config.failureRateWarn && w.total >= s.config.minSamples ? 'warn' : 'ok');

    box.innerHTML = `
      <div class="ps-row"><span>告警通道</span><b>${eff.logOnly
        ? '未配置（仅日志）'
        : [eff.emailReady ? '邮件' : null, eff.webhookReady ? 'Webhook' : null].filter(Boolean).join(' + ')}</b></div>
      <div class="ps-row"><span>近 ${fmtDuration(w.windowMs || 0)} 窗口</span><b class="tone-${rateTone}">${w.total || 0} 个请求 · 失败 ${w.failed || 0}（${w.rate || 0}%）</b></div>
      <div class="ps-row"><span>连续失败</span><b>${counters.consecutiveFailures || 0} 次</b></div>
      <div class="ps-row"><span>本周期的告警次数</span><b>${counters.sentLastHour || 0} / ${counters.maxSendsPerHour || 0}（每小时上限）</b></div>
      <div class="ps-row"><span>上次发送</span><b>${last
        ? `${fmtTime(last.at)} · ${last.ok ? `成功（${(last.channels || []).join('+') || '—'}）` : `失败：${escapeHtml(last.error || '未知原因')}`}`
        : '尚未发送过'}</b></div>
      <div class="ps-row"><span>状态文件</span><b>${escapeHtml(s.statePath || '—')}</b></div>
      ${s.lastError ? `<div class="ps-row"><span>最近错误</span><b class="tone-crit">${escapeHtml(s.lastError)}</b></div>` : ''}`;
  }

  /** 把表单读成 API 需要的 patch */
  function alertFormPatch() {
    const passClear = $('#alertPassClear').checked;
    const passTyped = $('#alertSmtpPass').value;
    return {
      enabled: $('#alertEnabled').checked,
      channels: { email: $('#alertEmailOn').checked, webhook: $('#alertWebhookOn').checked },
      email: {
        host: $('#alertSmtpHost').value.trim(),
        port: Number($('#alertSmtpPort').value) || 465,
        user: $('#alertSmtpUser').value.trim(),
        // 空 = 保持不变；勾了清除 = ''；否则用输入的
        pass: passClear ? '' : (passTyped ? passTyped : '__KEEP__'),
        from: $('#alertSmtpFrom').value.trim(),
        to: $('#alertSmtpTo').value,
        secure: $('#alertSmtpSecure').checked,
        allowPlaintextAuth: $('#alertSmtpPlain').checked,
      },
      webhook: { url: $('#alertHookUrl').value.trim(), type: $('#alertHookType').value },
      minCreditsPerKey: Number($('#alertMinCredits').value) || 0,
      minUsableKeys: Number($('#alertMinUsable').value) || 0,
      windowPctWarn: Number($('#alertWinWarn').value) || 85,
      windowPctCritical: Number($('#alertWinCrit').value) || 95,
      creditsFetchFailWarn: Number($('#alertFetchFail').value) || 2,
      windowMs: (Number($('#alertWindowSec').value) || 300) * 1000,
      minSamples: Number($('#alertMinSamples').value) || 8,
      failureRateWarn: Number($('#alertRateWarn').value) || 30,
      failureRateCritical: Number($('#alertRateCrit').value) || 60,
      consecutiveFailuresCritical: Number($('#alertConsecutive').value) || 5,
      quotaFaultsCritical: Number($('#alertQuotaFaults').value) || 3,
      stallsWarn: Number($('#alertStalls').value) || 3,
      inflightWarn: Number($('#alertInflight').value) || 5,
      cooldownMs: (Number($('#alertCooldownMin').value) || 0) * 60000,
      maxSendsPerHour: Number($('#alertMaxHour').value) || 20,
      repeatWhenStuck: $('#alertRepeat').checked,
      notifyRecovery: $('#alertRecovery').checked,
    };
  }

  $('#alertEmailOn').addEventListener('change', syncAlertChannelBoxes);
  $('#alertWebhookOn').addEventListener('change', syncAlertChannelBoxes);

  $('#alertForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('#alertForm button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await api('/admin/api/alerts', { method: 'PUT', body: JSON.stringify(alertFormPatch()) });
      state.alerts = res;
      fillAlerts(res);
      renderAlerts();
      if (res.warnings?.length) toast('已保存，但：' + res.warnings.join('；'), 'err');
      else toast('告警设置已保存');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('#btnAlertTest').addEventListener('click', async () => {
    const btn = $('#btnAlertTest');
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      // 先把当前表单存下来再测，避免"改了没保存就点测试"的困惑
      const saved = await api('/admin/api/alerts', { method: 'PUT', body: JSON.stringify(alertFormPatch()) });
      state.alerts = saved;
      fillAlerts(saved);
      renderAlerts();
      if (saved.warnings?.length) {
        toast('配置有问题：' + saved.warnings.join('；'), 'err');
        return;
      }
      const res = await api('/admin/api/alerts/test', { method: 'POST', body: JSON.stringify({}) });
      state.alerts = res.stats || state.alerts;
      fillAlerts(state.alerts);
      renderAlerts();
      if (res.ok) toast('测试通知已发出，请查收');
      else {
        const errs = Object.entries(res.results || {})
          .map(([ch, r]) => `${ch}: ${r.ok ? 'ok' : r.error}`).join('；');
        toast('发送失败 — ' + (errs || res.error || '未知原因'), 'err');
      }
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  });

  $('#btnAlertCheck').addEventListener('click', async () => {
    const btn = $('#btnAlertCheck');
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      const res = await api('/admin/api/alerts/check', { method: 'POST', body: JSON.stringify({}) });
      state.alerts = res;
      fillAlerts(res);
      renderAlerts();
      const n = (res.active || []).length;
      toast(n ? `体检完成：${n} 条告警未恢复` : '体检完成：一切正常');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  });

  $('#btnAlertClear').addEventListener('click', async () => {
    const ok = await askConfirm(
      '重置告警状态',
      '将清空「未恢复」标记，让每条告警都能重新发一次（告警历史保留）。<br>通常只在改完阈值想立刻复测时用。',
      '重置',
    );
    if (!ok) return;
    try {
      const res = await api('/admin/api/alerts/clear', { method: 'POST', body: JSON.stringify({}) });
      toast(`已重置 ${res.cleared || 0} 条告警状态`);
      await refreshAlerts();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  /* ── 调度设置（模式 / 失败阈值 / 额度轮询） ─────────── */
  const MODE_HINT = {
    session: '一个会话固定一个 Key：多开 agent 会话会自动分散到不同 Key，某个 Key 额度用尽或连续失败后，该会话自动换到下一个可用 Key。',
    request: '每次请求都按同一套顺序重新选 Key（真空闲 → 相对空闲 → priority → 到期），适合无会话概念的简单转发。',
  };

  function setMode(mode, { save = false } = {}) {
    const m = mode === 'request' ? 'request' : 'session';
    state.settings.mode = m;
    $$('#modeSwitch .seg').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === m));
    $('#modeHint').textContent = MODE_HINT[m];
    if (save) saveSettings({ mode: m }, '调度模式已切换为' + (m === 'session' ? '会话粘性' : '每次请求'));
  }

  function fillSettings(settings, credits) {
    if (!settings) return;
    state.settings = { ...state.settings, ...settings };
    state.creditsRefresh = credits || state.creditsRefresh;
    setMode(state.settings.mode);
    $('#failThreshold').value = state.settings.failThreshold ?? 3;

    const iv = Number(state.settings.creditsRefreshMs) || 0;
    const preset = $('#pollPreset');
    const custom = $('#pollCustom');
    const known = ['1', '5', '15', '30', '60'];
    const minutes = iv / 60000;
    if (!iv) {
      preset.value = '5';
      custom.value = '';
    } else if (known.includes(String(minutes))) {
      preset.value = String(minutes);
      custom.value = '';
    } else {
      preset.value = 'custom';
      custom.value = String(Math.max(1, Math.round(minutes)));
    }
    $('#pollEnabled').checked = iv > 0;
    $('#autoDisable').checked = !!state.settings.autoDisableExhausted;
    $('#onAllExhausted').value = state.settings.onAllExhausted || 'error';
    syncPollInputs();
    renderPollStatus();
  }

  function syncPollInputs() {
    const on = $('#pollEnabled').checked;
    $('#pollIntervalWrap').style.opacity = on ? '1' : '0.5';
    $('#pollPreset').disabled = !on;
    const custom = $('#pollPreset').value === 'custom';
    $('#pollCustom').disabled = !on || !custom;
    if (!custom) $('#pollCustom').value = '';
  }

  function pollIntervalMsFromForm() {
    if (!$('#pollEnabled').checked) return 0;
    const preset = $('#pollPreset').value;
    const minutes = preset === 'custom'
      ? Math.max(1, Math.min(1440, Number($('#pollCustom').value) || 5))
      : Number(preset) || 5;
    return minutes * 60000;
  }

  async function saveSettings(patch, okMessage) {
    try {
      const res = await api('/admin/api/settings', {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      if (res?.settings) state.settings = { ...state.settings, ...res.settings };
      if (res?.creditsRefresh) state.creditsRefresh = res.creditsRefresh;
      fillSettings(res.settings, res.creditsRefresh);
      renderStats();
      toast(okMessage || '设置已保存');
    } catch (e) {
      toast(e.message, 'err');
      await reload({ silent: true });
    }
  }

  /** 轮询状态 + 倒计时进度 */
  function renderPollStatus() {
    const box = $('#pollStatus');
    const cr = state.creditsRefresh || {};
    const iv = Number(state.settings.creditsRefreshMs) || 0;
    const on = iv > 0;

    let countdown = '—';
    let pct = 0;
    if (on && cr.nextAt) {
      const remain = Math.max(0, cr.nextAt - serverNow());
      countdown = fmtDuration(remain);
      pct = Math.max(0, Math.min(100, 100 - (remain / iv) * 100));
    }
    const lastTxt = cr.lastAt
      ? `${fmtClock(cr.lastAt)}${cr.lastDurationMs ? ` · 耗时 ${(cr.lastDurationMs / 1000).toFixed(1)}s` : ''}`
      : '尚未刷新';
    const resultTxt = cr.lastAt
      ? (cr.lastFailed ? `${cr.lastOk} 成功 · ${cr.lastFailed} 失败` : `${cr.lastOk} 个 Key 已刷新`)
      : '—';

    box.innerHTML = `
      <div class="ps-head">
        <span class="ps-dot ${on ? (cr.running ? 'warn' : 'on') : ''}"></span>
        <span>${on ? (cr.running ? '正在刷新额度…' : `每 ${fmtDuration(iv)}刷新一次`) : '定时刷新已关闭'}</span>
      </div>
      <div class="ps-bar"><i style="width:${pct}%"></i></div>
      <div class="ps-row"><span>上次刷新</span><b>${lastTxt}</b></div>
      <div class="ps-row"><span>刷新结果</span><b>${resultTxt}</b></div>
      <div class="ps-row"><span>下次刷新</span><b>${on ? countdown + ' 后' : '—'}</b></div>
    `;
  }

  /** 会话分布列表 */
  function renderSessions() {
    const box = $('#sessionList');
    const list = state.sessions || [];
    renderTabBadges();
    if (!list.length) {
      box.innerHTML = `<p class="empty sm">
        <span class="empty-icon" aria-hidden="true">${icon('sliders')}</span>
        <span>还没有会话绑定。等下游发起请求后，这里会显示每个会话正在使用的 Key。</span>
      </p>`;
      return;
    }
    box.innerHTML = list.map((s) => `
      <div class="session-row">
        <div class="sr-top">
          <code title="${escapeHtml(s.id)}">${escapeHtml(s.tag || s.shortId)}</code>
          <span class="sr-key">${escapeHtml(s.keyLabel || '—')}</span>
        </div>
        <div class="sr-meta">
          <span>使用中 ${fmtAgo(s.lastAt)}</span>
          ${s.failures ? `<span class="sep">·</span><span>连败 ${s.failures}</span>` : ''}
          <span class="sep">·</span><span>绑定 ${fmtAgo(s.boundAt)}</span>
        </div>
      </div>`).join('');
  }

  /* ── 额度明细 ────────────────────────────────────────── */
  function renderCreditsDetail(label, c) {
    const box = $('#creditsDetail');
    if (!c) {
      box.innerHTML = `<p class="empty sm"><span class="empty-icon">${icon('credits')}</span><span>暂无额度数据。</span></p>`;
      return;
    }
    if (c.error) {
      box.innerHTML = `<p class="empty sm">
        <span class="empty-icon">${icon('alert')}</span>
        <b>额度查询失败</b>
        <span>${escapeHtml(c.error)}</span>
      </p>`;
      return;
    }

    const worst = clampPct(c.worstPct);
    const sub = c.subscription || null;
    const subRow = sub && sub.expiresAt
      ? `<div class="row"><span>订阅${sub.willRenew ? '续费' : '到期'}</span><b title="${escapeHtml([
        sub.planId ? `套餐 ${sub.planId}` : '',
        sub.status ? `状态 ${sub.status}` : '',
        sub.willRenew ? '自动续费' : '不自动续费',
      ].filter(Boolean).join(' · '))}">${fmtTime(sub.expiresAt)}（${sub.expiresAt - serverNow() > 0 ? fmtCountdown(sub.expiresAt) + '后' : '已过期'}）</b></div>`
      : '';
    const wins = (c.windows || []).map((w) => {
      const pct = clampPct(w.pct);
      const resets = w.resetsAt ? `<span class="sep">·</span><span>重置 ${fmtCountdown(w.resetsAt)}</span>` : '';
      return `<div class="win lvl-${levelOf(pct)}">
        <div class="win-top">
          <span class="win-name">${escapeHtml(WIN_NAMES[w.name] || w.name)}</span>
          <span class="win-pct">${pct}%</span>
        </div>
        <div class="window-bar"><i style="width:${pct}%"></i></div>
        <div class="win-foot"><span>已用 ${fmtNum(w.used)} / ${fmtNum(w.cap)}</span>${resets}</div>
      </div>`;
    }).join('');

    box.innerHTML = `
      <div class="cred-head">
        <div class="who">
          <strong title="${escapeHtml(label)}">${escapeHtml(label)}</strong>
          ${c.plan ? `<span class="badge">${escapeHtml(c.plan)}</span>` : ''}
        </div>
        <span class="when">更新于 ${fmtTime(c.fetchedAt)}（${fmtAgo(c.fetchedAt)}）</span>
      </div>

      <div class="cred-total lvl-${levelByRemaining(100 - worst)}">
        <span class="ring-lg" style="--p:${100 - worst}" title="窗口额度剩余 ${100 - worst}%"><span><b>${100 - worst}%</b><small>剩余额度</small></span></span>
        <div class="cred-nums">
          <div class="cred-remaining"><span>剩余额度</span><strong>${fmtNum(c.creditsRemaining)}</strong></div>
          <div class="cred-pills">
            <span class="cred-pill">月度 <b>${fmtNum(c.credits?.monthly)}</b></span>
            <span class="cred-pill">购买 <b>${fmtNum(c.credits?.purchased)}</b></span>
            <span class="cred-pill">免费 <b>${fmtNum(c.credits?.free)}</b></span>
          </div>
        </div>
      </div>

      <div class="wins">${wins || `<p class="empty sm"><span>无窗口限额数据</span></p>`}</div>
      ${subRow ? `<div class="cred-extra">${subRow}</div>` : ''}
    `;
  }

  /* ── 确认弹窗 ────────────────────────────────────────── */
  const confirmDlg = $('#dlgConfirm');
  let confirmResolve = null;

  function askConfirm(title, message, okText = '删除') {
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').innerHTML = message;
    $('#confirmOk').textContent = okText;
    return new Promise((resolve) => {
      confirmResolve = resolve;
      confirmDlg.showModal();
    });
  }
  $('#confirmCancel').addEventListener('click', () => confirmDlg.close('cancel'));
  confirmDlg.addEventListener('close', () => {
    const resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(confirmDlg.returnValue === 'ok');
  });
  $('#confirmOk').addEventListener('click', () => confirmDlg.close('ok'));

  /* ── Key 表单弹窗 ────────────────────────────────────── */
  const keyDlg = $('#dlgKey');

  function openAdd() {
    $('#dlgTitle').textContent = '添加 Key';
    $('#dlgSub').innerHTML = '录入一个 <code>user_*</code> Key，加入分发池。';
    $('#editId').value = '';
    $('#keyLabel').value = '';
    $('#keyValue').value = '';
    $('#keyValue').disabled = false;
    $('#wrapKeyValue').classList.remove('hidden');
    $('#keyWeight').value = '1';
    $('#keyPriority').value = '0';
    $('#keyEnabled').checked = true;
    keyDlg.showModal();
    setTimeout(() => $('#keyLabel').focus(), 30);
  }

  function openEdit(k) {
    $('#dlgTitle').textContent = '编辑 Key';
    $('#dlgSub').textContent = '修改标签、权重、优先级与启用状态。';
    $('#editId').value = k.id;
    $('#keyLabel').value = k.label || '';
    $('#keyValue').value = k.keyPrefix || '';
    $('#keyValue').disabled = true;
    $('#wrapKeyValue').classList.add('hidden');
    $('#keyWeight').value = String(k.weight ?? 1);
    $('#keyPriority').value = String(k.priority ?? 0);
    $('#keyEnabled').checked = !!k.enabled;
    keyDlg.showModal();
    setTimeout(() => $('#keyLabel').focus(), 30);
  }

  const closeKeyDlg = () => keyDlg.close();
  $('#dlgClose').addEventListener('click', closeKeyDlg);
  $('#dlgCancel').addEventListener('click', closeKeyDlg);
  $('#btnAdd').addEventListener('click', openAdd);

  /* ── 加载 ────────────────────────────────────────────── */
  async function reload({ silent = false } = {}) {
    if (!silent && !state.keys.length) {
      state.loading = true;
      renderKeys();
    }
    try {
      const data = await api('/admin/api/keys');
      state.keys = data.keys || [];
      state.loading = false;
      state.sessions = data.sessions || [];
      state.poolOrder = data.poolOrder || [];
      if (typeof data.serverTime === 'number') state.serverSkew = data.serverTime - Date.now();
      fillLb(data.lb);
      fillSettings(data.settings, data.creditsRefresh);
      $('#apiBase').textContent = data.apiBase || 'api';
      $('#apiBase').title = data.apiBase || 'api';
      state.apiBase = data.apiBase || '';
      renderAll();
      renderSessions();
      if (state.view === 'cc/alerts') await refreshAlerts();
      else refreshAlertsSilent();
      $('#lastSync').textContent = `数据同步于 ${fmtClock(Date.now())}`;
    } catch (e) {
      state.loading = false;
      renderKeys();
      toast('加载失败：' + e.message, 'err');
    }
  }

  /* ── 统计按钮 ────────────────────────────────────────── */
  $('#btnReload').addEventListener('click', async () => {
    const btn = $('#btnReload');
    btn.classList.add('loading');
    await reload({ silent: true });
    btn.classList.remove('loading');
    toast('数据已刷新');
  });

  $('#btnRefreshCredits').addEventListener('click', async () => {
    const btn = $('#btnRefreshCredits');
    btn.disabled = true;
    btn.classList.add('loading');
    try {
      const res = await api('/admin/api/keys/refresh-credits', { method: 'POST' });
      if (res?.creditsRefresh) state.creditsRefresh = res.creditsRefresh;
      await reload({ silent: true });
      const exhausted = (res?.results || []).filter((r) => r.credits?.error).length;
      toast(exhausted ? `额度已刷新（${exhausted} 个查询失败）` : '全部额度已刷新');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  });

  /* ── 工具条 ──────────────────────────────────────────── */
  const searchInput = $('#keySearch');

  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    $('#btnClearSearch').classList.toggle('hidden', !state.query);
    renderKeys();
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      state.query = '';
      $('#btnClearSearch').classList.add('hidden');
      renderKeys();
      searchInput.blur();
    }
  });
  $('#btnClearSearch').addEventListener('click', () => {
    searchInput.value = '';
    state.query = '';
    $('#btnClearSearch').classList.add('hidden');
    renderKeys();
    searchInput.focus();
  });

  $('#filterChips').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    state.filter = FILTERS.includes(btn.dataset.filter) ? btn.dataset.filter : 'all';
    renderKeys();
  });

  $('#keySort').addEventListener('change', () => {
    state.sort = $('#keySort').value;
    renderKeys();
  });

  // Ctrl/Cmd+K 聚焦搜索
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const kbdHint = document.querySelector('.search-kbd');
  if (kbdHint && isMac) kbdHint.textContent = '⌘ K';
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  /* ── 调度 / 轮询 / 会话 ──────────────────────────────── */
  $('#modeSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg[data-mode]');
    if (!btn || btn.dataset.mode === state.settings.mode) return;
    setMode(btn.dataset.mode, { save: true });
  });

  $('#lbForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('#lbForm button[type="submit"]');
    btn.disabled = true;
    try {
      const saved = await api('/admin/api/lb', {
        method: 'PUT',
        body: JSON.stringify({
          maxRetries: Number($('#lbMaxRetries').value) || 0,
          cooldownMs: Number($('#lbCooldownMs').value) || 0,
        }),
      });
      if (saved) state.lb = saved;
      await saveSettings({
        mode: $('#modeSwitch .seg.is-active')?.dataset.mode || 'session',
        failThreshold: Number($('#failThreshold').value) || 3,
      }, '调度设置已保存');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  });

  // 轮询表单
  $('#pollEnabled').addEventListener('change', syncPollInputs);
  $('#pollPreset').addEventListener('change', syncPollInputs);

  $('#pollForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || $('#pollForm button[type="submit"]');
    btn.disabled = true;
    try {
      await saveSettings({
        creditsRefreshMs: pollIntervalMsFromForm(),
        autoDisableExhausted: $('#autoDisable').checked,
        onAllExhausted: $('#onAllExhausted').value,
      }, $('#pollEnabled').checked
        ? `已按每 ${fmtDuration(pollIntervalMsFromForm())} 自动刷新额度`
        : '已关闭定时刷新额度');
    } finally {
      btn.disabled = false;
    }
  });

  $('#btnClearSessions').addEventListener('click', async () => {
    if (!state.sessions.length) {
      toast('当前没有会话绑定');
      return;
    }
    const ok = await askConfirm(
      '清空会话绑定？',
      `当前 <b>${state.sessions.length}</b> 个会话的 Key 绑定会被清掉，它们的下一次请求将重新分配到最空闲的 Key。`,
      '清空',
    );
    if (!ok) return;
    try {
      await api('/admin/api/sessions', { method: 'DELETE' });
      await reload({ silent: true });
      toast('会话绑定已清空');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // 每秒心跳：轮询倒计时、到点后补一次状态同步、会话页停留时自动刷新会话列表
  let lastStaleSync = 0;
  setInterval(() => {
    const iv = Number(state.settings.creditsRefreshMs) || 0;
    if (iv > 0) {
      renderPollStatus();
      // 已经过了预定的刷新时间，但本地快照还没跟上 → 静默拉一次（带 15s 冷却，避免刷新期间反复触发）
      const cr = state.creditsRefresh;
      if (cr?.nextAt && serverNow() > cr.nextAt + 3000 && cr.lastAt < cr.nextAt && Date.now() - lastStaleSync > 15000) {
        lastStaleSync = Date.now();
        reload({ silent: true });
      }
    }
    // 停在会话页时自动刷新（只查会话，不动额度）
    if (state.view === 'cc/sessions' && Date.now() - lastSessionFetch > 15000) {
      refreshSessions();
    }
    // 停在告警页时自动刷新（未恢复告警数、窗口失败率）
    if (state.view === 'cc/alerts' && Date.now() - lastAlertFetch > 15000) {
      refreshAlertsSilent();
      renderAlerts();
    }
  }, 1000);

  /* ── 保存 Key ────────────────────────────────────────── */
  $('#keyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = $('#editId').value;
    const submitBtn = $('#keyForm button[type="submit"]');
    const payload = {
      label: $('#keyLabel').value.trim(),
      weight: Number($('#keyWeight').value) || 0,
      priority: Number($('#keyPriority').value) || 0,
      enabled: $('#keyEnabled').checked,
    };

    if (!editId) {
      const key = $('#keyValue').value.trim();
      if (!/^user_[A-Za-z0-9_-]+$/.test(key)) {
        toast('Key 格式不正确，需匹配 ^user_[A-Za-z0-9_-]+$', 'err');
        $('#keyValue').focus();
        return;
      }
      payload.key = key;
    }

    submitBtn.disabled = true;
    try {
      if (editId) {
        await api(`/admin/api/keys/${editId}`, { method: 'PATCH', body: JSON.stringify(payload) });
        toast('已保存');
      } else {
        await api('/admin/api/keys', { method: 'POST', body: JSON.stringify(payload) });
        toast('Key 已添加');
      }
      closeKeyDlg();
      await reload({ silent: true });
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      submitBtn.disabled = false;
    }
  });

  /* ── 复制 ────────────────────────────────────────────── */
  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 回退方案 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }

  /* ── 列表交互 ────────────────────────────────────────── */
  $('#keyList').addEventListener('click', async (e) => {
    // 空状态 / 无结果里的按钮
    const special = e.target.closest('[data-act="reset-filter"], [data-act="add-key"]');
    if (special) {
      if (special.dataset.act === 'add-key') { openAdd(); return; }
      state.query = '';
      state.filter = 'all';
      searchInput.value = '';
      $('#btnClearSearch').classList.add('hidden');
      renderKeys();
      return;
    }

    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.key-card');
    const id = card?.dataset?.id;
    if (!id) return;
    const k = state.keys.find((x) => x.id === id);
    if (!k) return;
    const label = k.label || id;
    const act = btn.dataset.act;

    if (act === 'copy') {
      const ok = await copyText(k.id);
      toast(ok ? `已复制 Key ID：${k.id}` : '复制失败，请手动选择', ok ? 'ok' : 'err');
      return;
    }

    if (act === 'del') {
      const ok = await askConfirm(
        '删除这个 Key？',
        `将把「<b>${escapeHtml(label)}</b>」从分发池中永久移除，此操作不可撤销。`,
        '删除',
      );
      if (!ok) return;
      card.classList.add('is-busy');
      try {
        await api(`/admin/api/keys/${id}`, { method: 'DELETE' });
        toast('已删除');
        await reload({ silent: true });
      } catch (err) {
        card.classList.remove('is-busy');
        toast(err.message, 'err');
      }
      return;
    }

    if (act === 'credits') {
      state.busy.add(id);
      btn.classList.add('loading');
      renderKeys();
      try {
        const c = await api(`/admin/api/keys/${id}/credits`);
        state.busy.delete(id);
        renderCreditsDetail(label, c);
        await reload({ silent: true });
        toast('额度已更新');
        if (window.innerWidth < 1080) {
          $('#creditsDetail').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch (err) {
        state.busy.delete(id);
        renderKeys();
        btn.classList.remove('loading');
        toast(err.message, 'err');
      }
      return;
    }

    if (act === 'edit') { openEdit(k); return; }
  });

  /* 快捷启停 */
  $('#keyList').addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-act="toggle"]');
    if (!input) return;
    const card = input.closest('.key-card');
    const id = card?.dataset?.id;
    if (!id) return;
    input.disabled = true;
    try {
      await api(`/admin/api/keys/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: input.checked }),
      });
      toast(input.checked ? '已启用' : '已停用');
      await reload({ silent: true });
    } catch (err) {
      input.checked = !input.checked;
      input.disabled = false;
      toast(err.message, 'err');
    }
  });

  /* ── WorkBuddy（第二套上游，与 CC Key 池无关） ───────────
     数据全部来自服务端 /admin/api/workbuddy/*：那里替我们登录 hub 面板并持会话令牌，
     浏览器不接触面板密码，也不用关心 hub 的绝对路径。 */
  const WB_REALM_TEXT = { intl: '🌐 国际版', cn: '🇨🇳 国内版' };
  // hub 的 range_window 只认 today / week / month / custom —— 刻意没有 7d / 30d 这类
  // 滚动别名（"最近七天"和"本周"是不同窗口，按钮标签会在七天里错六天）。
  // 'all' 是我们自己的意思：不传 range，拿全部历史。
  const WB_RANGE_TEXT = { today: '今天', week: '本周', month: '本月', all: '全部' };
  let wbLoginState = null;
  let wbLoginTimer = null;
  let wbFetching = false;

  function wbSetRealmActive(realm) {
    $$('#wbRealmSeg .seg').forEach((b) => b.classList.toggle('is-active', b.dataset.realm === realm));
  }

  function wbBackendRow(title, sub, b) {
    const on = !!b?.up;
    return `<div class="wb-backend">
        <span class="wb-dot ${on ? 'on' : 'off'}" aria-hidden="true"></span>
        <div class="wb-backend-main"><b>${escapeHtml(title)}</b><small>${escapeHtml(sub)}</small></div>
        <span class="wb-backend-tag ${on ? 'on' : 'off'}">${on ? '在线' : '离线'}</span>
      </div>`;
  }

  function renderWbBackends(status) {
    const el = $('#wbBackends');
    if (!el) return;
    const hub = status?.hub || {};
    const hd = hub.data || {};
    const up = status?.upstream || {};
    const mgr = status?.manager || {};
    const accounts = hd.accounts ?? '—';
    const ready = hd.accounts_ready ?? '—';
    el.innerHTML = [
      // 三个后端里有两种账号池：hub 是**本页的数据源**，Go 上游+控制台是另一套
      // 独立池（在 manager 里纳管），两者账号互不相通，标签里要说清楚，
      // 否则「Go 上游 账号 0」看起来像故障。
      wbBackendRow('网关 hub（本页数据源）', `${hub.url || '—'} · 账号 ${accounts} / 可用 ${ready}`, hub),
      wbBackendRow('Go 上游（独立账号池）', `${up.url || '—'} · 账号 ${up.data?.total ?? '—'}`, up),
      wbBackendRow('账号控制台（管 Go 上游那套）', mgr.url || '—', mgr),
    ].join('');
    if (hd.realm) wbSetRealmActive(hd.realm);
    // 数据源徽标
    const badge = $('#wbBadge');
    const badgeText = $('#wbBadgeText');
    if (badge && badgeText) {
      const hubUp = !!hub.up;
      badge.classList.remove('tone-ok', 'tone-warn', 'tone-idle');
      badge.classList.add(hubUp ? 'tone-ok' : 'tone-warn');
      badgeText.textContent = hubUp
        ? `hub 在线 · ${accounts} 个账号`
        : 'hub 离线';
    }
    const hint = $('#wbRealmHint');
    if (hint) {
      const bits = [];
      if (hd.realm) bits.push('默认出口 ' + (WB_REALM_TEXT[hd.realm] || hd.realm));
      bits.push('两区账号共存，可同时使用');
      if (status && status.panelReady === false) bits.push('未配置 hub 面板密码 → 账号列表不可读');
      hint.textContent = bits.join(' · ');
    }
  }

  /** "0.0%" → 0 */
  function wbPct(s) {
    const n = parseFloat(String(s == null ? '' : s).replace('%', ''));
    return isFinite(n) ? n : 0;
  }
  /** 保留 digits 位小数，非法值给 — */
  function wbNum(n, digits = 2) {
    if (n == null || n === '') return '—';
    const v = Number(n);
    if (!isFinite(v)) return '—';
    return v.toLocaleString('zh-CN', { maximumFractionDigits: digits });
  }
  /** token 一屏就是 1.8 亿，全写出来没法看，按中文习惯压成「亿 / 万」 */
  function wbCompact(n) {
    const v = Number(n) || 0;
    if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
    return String(Math.round(v));
  }
  /** 时间范围的查询串；'all' 表示不传 range —— 不传就是全部历史 */
  function wbRangeQuery(extra = '') {
    const range = state.wb?.range || 'today';
    const parts = [];
    if (range !== 'all') parts.push('range=' + encodeURIComponent(range));
    if (extra) parts.push(extra);
    return parts.length ? '?' + parts.join('&') : '';
  }
  function wbExpiry(a) {
    if (a.expiresIn) return String(a.expiresIn);
    if (!a.expiresAt) return '—';
    return fmtTime(a.expiresAt * 1000);
  }
  /** 一个积分包什么时候没了。no_expiry 的包 days_left 是 null，要单独说清楚。 */
  function wbWhen(p) {
    if (!p) return '';
    if (p.no_expiry) return '永久有效';
    const d = Number(p.days_left);
    if (isFinite(d) && d > 0) return `${Math.round(d)} 天后到期`;
    const t = p.cycle_end_time || p.expire_time;
    return t ? `到期 ${String(t).slice(0, 10)}` : '';
  }
  /** credits.earliest_expiring 是**对象**（{name, remain, days_left, cycle_end_time}），
      不是字符串 —— 直接 String() 会渲染成 [object Object]。 */
  function wbExpiringLabel(e) {
    if (!e) return '';
    if (typeof e === 'string') return e;
    const name = e.name || e.package_code || '积分包';
    const remain = e.remain != null ? ` 剩 ${wbNum(e.remain, 0)}` : '';
    const when = wbWhen(e);
    return `${name}${remain}${when ? ' · ' + when : ''}`;
  }
  function wbPkgRow(p) {
    const name = p.name || p.package_code || '积分包';
    const sub = p.sub_product_name || p.product_name || '';
    const expired = p.is_expired || (Number(p.remain) <= 0);
    return `<div class="wb-pkg">
        <div class="wb-pkg-name">
          <b>${escapeHtml(String(name))}</b>
          ${sub ? `<small>${escapeHtml(String(sub))}</small>` : ''}
        </div>
        <div class="wb-pkg-num">
          <b class="${expired ? 'is-dead' : ''}">${wbNum(p.remain, 0)} / ${wbNum(p.size, 0)}</b>
          <small>${escapeHtml(wbWhen(p))}</small>
        </div>
      </div>`;
  }
  /** 冷却 / 熔断 / 降级 / 停用 / 报错过，都算需要被看见的状态 */
  function wbStatusChips(a) {
    const out = [];
    if (a.enabled === false) out.push('<span class="wb-chip bad">已停用</span>');
    if (a.inCooldown) out.push(`<span class="wb-chip bad">冷却中${a.cooldownFor ? ' ' + escapeHtml(String(a.cooldownFor)) : ''}</span>`);
    if (a.breakerFor) out.push('<span class="wb-chip bad">熔断</span>');
    if (a.degradeFor) out.push('<span class="wb-chip bad">降级</span>');
    if (a.lastError) out.push(`<span class="wb-chip bad" title="${escapeHtml(String(a.lastError))}">有错误</span>`);
    if (!out.length) out.push('<span class="wb-chip ok">可用</span>');
    return out.join('');
  }

  function wbAccountCard(a) {
    const uid = String(a.uid || '');
    const nick = a.nickname || a.email || uid.slice(0, 8) || '—';
    const c = a.credits || null;
    const realm = WB_REALM_TEXT[a.realm] || a.realm || '—';
    const remainPct = c ? Math.max(0, Math.min(100, wbPct(c.remain_percent))) : 0;
    const pkgs = c && Array.isArray(c.packages) ? c.packages : [];
    const today = a.dailyTokensToday;
    const todayLimit = Number(a.dailyTokenLimit || 0);

    const meter = c
      ? `<div class="wb-meter">
            <div class="wb-meter-top"><span>积分</span><b>剩余 ${wbNum(c.remain)} / ${wbNum(c.size)}</b></div>
            <div class="wb-track" role="img" aria-label="剩余 ${remainPct.toFixed(1)}%"><i style="width:${remainPct}%"></i></div>
            <div class="wb-meter-sub">
              剩余 ${escapeHtml(String(c.remain_percent || '—'))} · 已用 ${escapeHtml(String(c.used_percent || '—'))}
              · ${c.is_paid_user ? '付费账号' : '免费账号'}
            </div>
          </div>`
      : '<div class="wb-meter"><div class="wb-meter-sub">尚无额度快照（hub 每 12 小时刷新一次）</div></div>';

    return `<article class="wb-card">
        <header class="wb-card-head">
          <span class="wb-dot ${a.enabled === false ? 'off' : 'on'}" aria-hidden="true"></span>
          <div class="wb-card-title">
            <b>${escapeHtml(String(nick))}</b>
            <small title="${escapeHtml(uid)}">${escapeHtml(uid)}</small>
          </div>
          <div class="wb-card-tags">
            <span class="wb-chip">${escapeHtml(realm)}</span>
            ${a.platform ? `<span class="wb-chip">${escapeHtml(String(a.platform))}</span>` : ''}
            ${a.product ? `<span class="wb-chip">${escapeHtml(String(a.product))}</span>` : ''}
            ${wbStatusChips(a)}
          </div>
        </header>
        ${meter}
        ${c && c.earliest_expiring ? `<div class="wb-note">最早到期：${escapeHtml(wbExpiringLabel(c.earliest_expiring))}</div>` : ''}
        ${pkgs.length ? `<div class="wb-pkgs">${pkgs.map(wbPkgRow).join('')}</div>` : ''}
        <div class="wb-facts">
          <div class="wb-fact"><span>订阅到期</span><b>${escapeHtml(wbExpiry(a))}</b></div>
          <div class="wb-fact"><span>积分包</span><b>${pkgs.length} 个</b></div>
          <div class="wb-fact"><span>今日 Token</span><b>${today == null ? '—' : wbNum(today, 0)}${todayLimit ? ' / ' + wbNum(todayLimit, 0) : ''}</b></div>
          <div class="wb-fact"><span>额度快照</span><b>${escapeHtml(String((c && c.updated_iso) || '—').slice(11) || '—')}</b></div>
        </div>
      </article>`;
  }

  function renderWbAccounts() {
    const wrap = $('#wbAccountList');
    const empty = $('#wbEmpty');
    if (!wrap) return;
    const rows = state.wb?.accounts || [];
    if (!rows.length) {
      wrap.innerHTML = '';
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');
    wrap.innerHTML = rows.map(wbAccountCard).join('');
  }

  function renderWbKpis() {
    const rows = state.wb?.accounts || [];
    const an = state.wb?.analytics || null;
    const win = an?.summary?.window || {};
    const all = an?.summary?.all_time || {};

    const total = $('#wbStatAccounts');
    if (total) {
      const usable = state.wb?.usable ?? rows.filter((a) => a.enabled !== false).length;
      total.textContent = `${rows.length} / ${usable}`;
    }
    const totalSub = $('#wbStatAccountsSub');
    if (totalSub) {
      const r = state.wb?.realms;
      totalSub.textContent = r ? `国际版 ${r.intl} · 国内版 ${r.cn}` : '总 / 可用';
    }

    // 额度合计：只把真的有快照的账号算进去，没快照的当「未知」而不是 0
    let remain = 0, size = 0, seen = 0;
    rows.forEach((a) => {
      if (!a.credits) return;
      seen += 1;
      remain += Number(a.credits.remain) || 0;
      size += Number(a.credits.size) || 0;
    });
    const creditsEl = $('#wbStatCredits');
    if (creditsEl) creditsEl.textContent = seen ? `${wbNum(remain)} / ${wbNum(size)}` : '—';
    const creditsSub = $('#wbStatCreditsSub');
    if (creditsSub) {
      const n = state.wb?.grants?.summary?.count;
      creditsSub.textContent = n != null ? `${n} 个积分包` : '上游只读快照';
    }

    const rangeLabel = WB_RANGE_TEXT[state.wb?.range || 'today'] || '';

    const reqs = $('#wbStatReqs');
    if (reqs) reqs.textContent = `${wbNum(win.requests ?? 0, 0)} / ${wbNum(all.requests ?? 0, 0)}`;
    const reqsSub = $('#wbStatReqsSub');
    if (reqsSub) {
      reqsSub.textContent = `${rangeLabel} · 累计 ${wbNum(all.requests ?? 0, 0)}`
        + (win.errors ? ` · 错误 ${wbNum(win.errors, 0)}` : '');
    }

    const toks = $('#wbStatTokens');
    if (toks) toks.textContent = `${wbCompact(win.total_tokens ?? 0)} / ${wbCompact(all.total_tokens ?? 0)}`;
    const toksSub = $('#wbStatTokensSub');
    if (toksSub) {
      toksSub.textContent = all.cost_cny
        ? `${rangeLabel} · 累计 ¥${wbNum(all.cost_cny)}`
        : `${rangeLabel} · 缓存命中 ${wbNum(all.cache_hit_pct, 1)}%`;
    }
  }

  async function refreshWorkbuddy() {
    if (wbFetching) return;
    wbFetching = true;
    state.wb = state.wb || {};
    try {
      const status = await api('/admin/api/workbuddy/status');
      state.wb.status = status;
      renderWbBackends(status);
      try {
        // 服务端把 intl / cn 两个列表各取一次再合并（见 proxy.mjs）：两区账号一起显示，
        // 而且用的是 hub 缓存的 credits，拉这个列表**不打上游**。
        const list = await api('/admin/api/workbuddy/accounts');
        state.wb.accounts = Array.isArray(list) ? list : (list?.accounts || []);
        state.wb.usable = list?.usable ?? null;
        state.wb.realms = list?.realms ?? null;
      } catch (e) {
        state.wb.accounts = [];
        const hint = $('#wbRealmHint');
        if (hint) hint.textContent = '账号列表读取失败：' + e.message;
      }
      // 这两个只影响汇总数字，失败了不该把整页拖黑
      try { state.wb.analytics = await api('/admin/api/workbuddy/analytics' + wbRangeQuery()); } catch { state.wb.analytics = null; }
      try { state.wb.grants = await api('/admin/api/workbuddy/grants'); } catch { state.wb.grants = null; }
      renderWbKpis();
      renderWbAccounts();
      renderTabBadges();
    } catch (e) {
      toast('WorkBuddy 状态读取失败：' + e.message, 'err');
    } finally {
      wbFetching = false;
    }
  }

  /* ── WorkBuddy 用量 ────────────────────────────────────────
     数据来自 hub 的用量日志：/usage/analytics 出汇总与分账号，/usage/timeseries
     按天分桶出柱状。时间范围只认 today/week/month，'全部' 就是不传 range。 */

  let wbUsageFetching = false;

  function wbSetRangeActive() {
    const range = state.wb?.range || 'today';
    $$('#wbRangeSeg .seg').forEach((b) => b.classList.toggle('is-active', b.dataset.range === range));
  }

  function renderWbUsageSummary(an) {
    const el = $('#wbUsageSummary');
    if (!el) return;
    const w = an?.summary?.window || {};
    const range = state.wb?.range || 'today';
    const since = an?.window?.since ? fmtTime(an.window.since * 1000) : null;
    const chips = [
      `<span class="wb-chip">${escapeHtml(WB_RANGE_TEXT[range] || range)}${since ? ' · 自 ' + escapeHtml(since) : ''}</span>`,
      `<span class="wb-chip">${wbNum(w.requests, 0)} 请求</span>`,
      `<span class="wb-chip">${escapeHtml(wbCompact(w.total_tokens))} token</span>`,
      `<span class="wb-chip">¥${wbNum(w.cost_cny)}</span>`,
      `<span class="wb-chip">缓存命中 ${wbNum(w.cache_hit_pct, 1)}%</span>`,
      `<span class="wb-chip">首字 ${wbNum((w.ttft_ms_avg || 0) / 1000, 1)}s · ${wbNum(w.speed_avg, 1)} tok/s</span>`,
    ];
    if (w.errors) chips.push(`<span class="wb-chip bad">${wbNum(w.errors, 0)} 错误</span>`);
    el.innerHTML = chips.join('');
  }

  function renderWbDailyBars(ts) {
    const el = $('#wbDailyBars');
    if (!el) return;
    const series = Array.isArray(ts?.series) ? ts.series : [];
    if (!series.length) {
      el.innerHTML = '<p class="wb-usage-empty">这个范围内还没有请求。</p>';
      return;
    }
    // 柱高按 token 算（这才是「用量」），请求数与缓存数放柱顶和 title
    const max = Math.max(...series.map((s) => Number(s.total_tokens) || 0), 1);
    el.innerHTML = series.map((s) => {
      const toks = Number(s.total_tokens) || 0;
      const h = Math.max(2, Math.round((toks / max) * 100));
      const d = new Date((Number(s.at) || 0) * 1000);
      const label = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const title = `${label} · ${wbNum(s.requests, 0)} 请求 · ${wbCompact(toks)} token`
        + `${s.errors ? ` · ${wbNum(s.errors, 0)} 错误` : ''} · ${wbCompact(s.cached_tokens)} 缓存`;
      return `<div class="wb-day" title="${escapeHtml(title)}">
          <b>${escapeHtml(wbCompact(toks))}</b>
          <div class="wb-day-track"><i style="height:${h}%"></i></div>
          <span>${label}</span>
        </div>`;
    }).join('');
  }

  function renderWbUsageRows(an) {
    const el = $('#wbUsageRows');
    if (!el) return;
    const rows = (Array.isArray(an?.accounts) ? an.accounts : []).slice();
    // 按窗口内 token 降序：真正在跑流量的排前面
    rows.sort((a, b) => (Number(b.window?.total_tokens) || 0) - (Number(a.window?.total_tokens) || 0));
    if (!rows.length) {
      el.innerHTML = '<p class="wb-usage-empty">这个范围内还没有账号产生请求。</p>';
      return;
    }
    el.innerHTML = rows.map((a) => {
      const w = a.window || {};
      const realm = WB_REALM_TEXT[a.realm] || a.realm || '—';
      return `<div class="wb-urow">
          <div class="wb-ucell wb-ucell-name">
            <b>${escapeHtml(String(a.nickname || a.uid || '—'))}</b>
            <small>${escapeHtml(realm)}</small>
          </div>
          <div class="wb-ucell"><b>${wbNum(w.requests, 0)}</b><small>${w.errors ? '错误 ' + wbNum(w.errors, 0) : '—'}</small></div>
          <div class="wb-ucell"><b>${escapeHtml(wbCompact(w.total_tokens))}</b><small>${escapeHtml(wbCompact(w.cached_tokens))} 缓存</small></div>
          <div class="wb-ucell"><b>¥${wbNum(w.cost_cny)}</b><small>${wbNum(w.credit)} 积分</small></div>
          <div class="wb-ucell"><b>${wbNum(w.cache_hit_pct, 1)}%</b><small>命中</small></div>
          <div class="wb-ucell"><b>${wbNum((w.ttft_ms_avg || 0) / 1000, 1)}s</b><small>首字</small></div>
          <div class="wb-ucell"><b>${wbNum(w.speed_avg, 1)}</b><small>tok/s</small></div>
        </div>`;
    }).join('');
  }

  function renderWbAllTime(an) {
    const el = $('#wbAllTimeFacts');
    if (!el) return;
    const a = an?.summary?.all_time || {};
    const facts = [
      ['请求数', wbNum(a.requests, 0)],
      ['错误数', wbNum(a.errors, 0)],
      ['Token', wbCompact(a.total_tokens)],
      ['其中缓存读', wbCompact(a.cached_tokens)],
      ['推理 token', wbCompact(a.reasoning_tokens)],
      ['花费', a.cost_cny ? '¥' + wbNum(a.cost_cny) : '—'],
      ['缓存命中', wbNum(a.cache_hit_pct, 1) + '%'],
      ['平均速度', wbNum(a.speed_avg, 1) + ' tok/s'],
    ];
    el.innerHTML = facts.map(([k, v]) =>
      `<div class="wb-fact"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('');
  }

  function renderWbUsage() {
    const an = state.wb?.analytics || null;
    wbSetRangeActive();
    renderWbUsageSummary(an);
    renderWbDailyBars(state.wb?.timeseries || null);
    renderWbUsageRows(an);
    renderWbAllTime(an);
  }

  async function refreshWbUsage() {
    if (wbUsageFetching) return;
    wbUsageFetching = true;
    state.wb = state.wb || {};
    if (!state.wb.range) state.wb.range = 'today';
    try {
      const [an, ts] = await Promise.all([
        api('/admin/api/workbuddy/analytics' + wbRangeQuery()),
        // bucket=86400 → 按本地零点分桶。realm=all 必须显式传：timeseries 不带 realm
        // 时只按全局开关那个区算，会和上面 analytics 的汇总数字对不上。
        api('/admin/api/workbuddy/timeseries' + wbRangeQuery('bucket=86400&realm=all')),
      ]);
      state.wb.analytics = an;
      state.wb.timeseries = ts;
      renderWbUsage();
      renderWbKpis();   // 顶部 KPI 跟着同一个范围走，免得两处口径打架
    } catch (e) {
      toast('用量读取失败：' + e.message, 'err');
    } finally {
      wbUsageFetching = false;
    }
  }

  const wbRangeSeg = $('#wbRangeSeg');
  if (wbRangeSeg) {
    wbRangeSeg.addEventListener('click', (e) => {
      const b = e.target.closest('.seg[data-range]');
      if (!b) return;
      state.wb = state.wb || {};
      state.wb.range = b.dataset.range;
      wbSetRangeActive();
      refreshWbUsage();
    });
  }
  const wbUsageRefreshBtn = $('#wbUsageRefresh');
  if (wbUsageRefreshBtn) wbUsageRefreshBtn.addEventListener('click', () => refreshWbUsage());

  function wbCloseLogin() {
    if (wbLoginTimer) { clearInterval(wbLoginTimer); wbLoginTimer = null; }
    wbLoginState = null;
    const p = $('#wbLoginPanel');
    if (p) p.hidden = true;
  }

  async function wbPollLogin() {
    if (!wbLoginState) return;
    const box = $('#wbLoginBox');
    const statusEl = box && box.querySelector('.wb-login-status');
    try {
      const r = await api('/admin/api/workbuddy/login/poll?state=' + encodeURIComponent(wbLoginState));
      if (statusEl) statusEl.textContent = r.message || r.status || '等待授权…';
      if (r.status === 'ok') {
        const who = (r.account && (r.account.nickname || r.account.uid)) || '账号已入池';
        toast('登录成功：' + who);
        wbCloseLogin();
        await refreshWorkbuddy();
      } else if (r.status === 'error' || r.status === 'expired' || r.status === 'unknown') {
        wbCloseLogin();
        toast('授权未完成：' + (r.message || r.status), 'err');
      }
    } catch { /* 下一轮再试 */ }
  }

  async function wbStartLogin() {
    const realm = state.wb?.status?.hub?.data?.realm || 'intl';
    const panel = $('#wbLoginPanel');
    const box = $('#wbLoginBox');
    if (panel) panel.hidden = false;
    if (box) box.innerHTML = '<p class="wb-login-status">正在向腾讯申请授权…</p>';
    try {
      const r = await api('/admin/api/workbuddy/login/start', {
        method: 'POST',
        body: JSON.stringify({ platform: 'CLI', realm }),
      });
      wbLoginState = r.state;
      if (box) {
        box.innerHTML = `
            <p class="wb-login-status">${escapeHtml(r.message || '在浏览器里完成授权，本页会自动检测。')}</p>
            <a class="btn primary sm wb-login-link" href="${escapeHtml(r.authUrl || '#')}" target="_blank" rel="noopener">打开授权页</a>
            <div class="wb-login-actions">
              <button class="btn ghost sm" type="button" id="wbCopyLogin">复制链接</button>
              <button class="btn ghost sm" type="button" id="wbCancelLogin">取消</button>
            </div>`;
        $('#wbCopyLogin').addEventListener('click', async () => {
          const ok = await copyText(r.authUrl || '');
          toast(ok ? '链接已复制' : '复制失败，请手动选择', ok ? 'ok' : 'err');
        });
        $('#wbCancelLogin').addEventListener('click', async () => {
          try { await api('/admin/api/workbuddy/login/cancel', { method: 'POST', body: '{}' }); } catch { /* 忽略 */ }
          wbCloseLogin();
        });
      }
      if (wbLoginTimer) clearInterval(wbLoginTimer);
      wbLoginTimer = setInterval(wbPollLogin, 2500);
    } catch (e) {
      if (box) box.innerHTML = `<p class="wb-login-status">发起失败：${escapeHtml(e.message)}</p>`;
    }
  }

  async function wbSetRealm(realm) {
    try {
      await api('/admin/api/workbuddy/realm', { method: 'POST', body: JSON.stringify({ realm }) });
      toast('出口已切到 ' + (WB_REALM_TEXT[realm] || realm));
      wbSetRealmActive(realm);
      await refreshWorkbuddy();
    } catch (e) {
      toast('切换失败：' + e.message, 'err');
    }
  }

  /** 真去上游刷一遍额度。这个动作**每个账号一次计费请求**且上游没有 TTL，
      所以只在用户显式点击时做；页面刷新走的是缓存的 credits。 */
  async function wbRefreshCredits() {
    const btn = $('#wbRefreshCredits');
    const label = btn && btn.querySelector('.btn-label');
    const old = label ? label.textContent : '';
    if (btn) btn.disabled = true;
    if (label) label.textContent = '刷新中…';
    try {
      const r = await api('/admin/api/workbuddy/credits', { method: 'POST', body: JSON.stringify({}) });
      const results = Array.isArray(r?.results) ? r.results : [];
      const ok = results.filter((x) => x.ok).length;
      const bad = results.length - ok;
      toast(`额度已刷新：成功 ${ok} 个${bad ? `，失败 ${bad} 个` : ''}`, bad ? 'err' : 'ok');
      await refreshWorkbuddy();
    } catch (e) {
      toast('刷新额度失败：' + e.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
      if (label) label.textContent = old || '刷新额度';
    }
  }

  /* ── WorkBuddy · 调度与轮询 ─────────────────────────────
     数据来自 hub 的 /scheduler 与 /tasks。和 CC 的调度完全是两套东西：
     CC 那边管的是"额度轮询 + 会话粘性"，这边管的是上游账号的签到/保活排程。 */
  let wbSchedFetching = false;

  function renderWbSchedule(sched, tasks) {
    const chk = $('#wbSchedEnabled');
    if (chk) chk.checked = !!sched?.enabled;

    const facts = $('#wbSchedFacts');
    if (facts) {
      const rows = [
        ['排程', sched?.mode || '—'],
        ['上次运行', sched?.last_run_time || '—'],
        ['下次运行', sched?.next_run_time || '—'],
      ];
      facts.innerHTML = rows
        .map(([k, v]) => `<div class="wb-fact"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`)
        .join('');
    }

    const logs = $('#wbSchedLogs');
    if (logs) {
      const lines = Array.isArray(sched?.logs) ? sched.logs : [];
      logs.textContent = lines.length ? lines.join('\n') : '（暂无日志）';
    }

    const list = $('#wbTaskList');
    const empty = $('#wbTaskEmpty');
    const items = Array.isArray(tasks?.tasks) ? tasks.tasks : [];
    const msg = $('#wbTaskMsg');
    if (msg) msg.textContent = tasks?.msg || (items.length ? '' : '—');
    if (list) {
      list.innerHTML = items.map((t) => {
        const name = t.name || t.task || t.label || t.title || '任务';
        const acct = t.nickname || t.uid || '';
        const failed = t.ok === false || t.status === 'failed' || t.state === 'failed';
        const state = t.status || t.state || (t.ok === true ? 'ok' : '');
        const when = t.last_run || t.updated_at || t.last_run_time || '';
        return `<div class="wb-pkg">
            <span class="wb-dot ${failed ? 'off' : 'on'}" aria-hidden="true"></span>
            <div class="wb-pkg-name">
              <b>${escapeHtml(String(name))}</b>
              <small>${escapeHtml(String(acct))}${when ? ' · ' + escapeHtml(String(when)) : ''}</small>
            </div>
            <div class="wb-pkg-num">
              ${state ? `<b class="${failed ? 'is-dead' : ''}">${escapeHtml(String(state))}</b>` : ''}
            </div>
          </div>`;
      }).join('');
    }
    if (empty) empty.classList.toggle('hidden', items.length > 0);
  }

  async function refreshWbSchedule() {
    if (wbSchedFetching) return;
    wbSchedFetching = true;
    try {
      const sched = await api('/admin/api/workbuddy/schedule');
      // 任务列表在没账号时会 4xx/空，不该把整页拖黑
      let tasks = null;
      try { tasks = await api('/admin/api/workbuddy/tasks'); } catch { tasks = null; }
      state.wb = state.wb || {};
      state.wb.sched = sched;
      state.wb.tasks = tasks;
      renderWbSchedule(sched, tasks);
      renderTabBadges();
    } catch (e) {
      toast('调度状态读取失败：' + e.message, 'err');
    } finally {
      wbSchedFetching = false;
    }
  }

  /* ── 概览首页 ────────────────────────────────────────────
     数据源目录来自服务端 /admin/api/overview（以后加一个新源只改后端一处），
     实时状态则从各源**已有的**接口现拼 —— 两个地方不各存一份真相。 */
  let overviewFetchedAt = 0;

  function dsStatus(id) {
    if (id === 'cc') {
      const keys = state.keys || [];
      const usable = keys.filter(isUsableClient).length;
      const synced = keys.filter((k) => k.credits && !k.credits.error);
      const sum = synced.reduce((s, k) => s + (k.credits?.creditsRemaining || 0), 0);
      return {
        up: keys.length > 0,
        label: keys.length ? (usable ? '在线' : '无可用 Key') : '未配置',
        stats: [
          ['Key 池', `${keys.length} 个 · ${usable} 可用`],
          ['剩余额度', synced.length ? fmtNum(sum) : '—'],
          ['活跃会话', String((state.sessions || []).length)],
        ],
      };
    }
    const rows = state.wb?.accounts || [];
    const st = state.wb?.status || {};
    const hubUp = !!st.hub?.up;
    const parts = [st.hub?.up, st.upstream?.up, st.manager?.up];
    const upCount = parts.filter(Boolean).length;
    let remain = 0, size = 0;
    rows.forEach((a) => {
      if (!a.credits) return;
      remain += Number(a.credits.remain) || 0;
      size += Number(a.credits.size) || 0;
    });
    return {
      up: hubUp,
      label: hubUp ? (upCount === 3 ? '在线' : `${upCount}/3 组件`) : '不可用',
      stats: [
        ['账号池', `${rows.length} 个 · ${state.wb?.usable ?? '—'} 可用`],
        ['积分', `${wbNum(remain)} / ${wbNum(size)}`],
        ['组件', `${upCount}/3 在线`],
      ],
    };
  }

  function renderOverview() {
    const grid = $('#dsGrid');
    if (!grid) return;
    const sources = state.overview?.sources || [];
    grid.innerHTML = sources.map((s) => {
      const st = dsStatus(s.id);
      const endpoints = (s.egress?.endpoints || [])
        .map((e) => `<code class="ds-ep">${escapeHtml(e)}</code>`)
        .join('');
      return `<article class="ds-card">
          <header class="ds-head">
            <span class="side-logo tone-${escapeHtml(s.tone || 'violet')}" aria-hidden="true"><svg class="ic" viewBox="0 0 24 24"><use href="#i-${escapeHtml(s.icon || 'key')}"/></svg></span>
            <div class="ds-title">
              <b>${escapeHtml(s.name)}</b>
              <small>${escapeHtml(s.subtitle || '')}</small>
            </div>
            <span class="ds-state ${st.up ? 'ok' : 'bad'}"><i aria-hidden="true"></i>${escapeHtml(st.label)}</span>
          </header>

          <div class="ds-kpis">
            ${st.stats.map(([k, v]) => `<div class="wb-fact"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('')}
          </div>

          <dl class="ds-meta">
            <dt>上游</dt><dd>${escapeHtml(s.upstream || '—')}</dd>
            <dt>内网出口</dt><dd><code>${escapeHtml(s.egress?.internal || '—')}</code></dd>
            <dt>接口</dt><dd class="ds-eps">${endpoints || '<code class="ds-ep">—</code>'}</dd>
          </dl>

          <footer class="ds-foot">
            <span class="ds-note">${escapeHtml(s.note || '')}</span>
            <button class="btn ghost sm" type="button" data-goto="${escapeHtml(s.entry)}">${escapeHtml(s.entryLabel || '进入')} →</button>
          </footer>
        </article>`;
    }).join('');

    const badge = $('#dsBadge');
    const badgeText = $('#dsBadgeText');
    if (badge && badgeText) {
      const total = sources.length;
      const up = sources.filter((s) => dsStatus(s.id).up).length;
      badge.classList.remove('tone-ok', 'tone-warn', 'tone-idle');
      badge.classList.add(total && up === total ? 'tone-ok' : 'tone-warn');
      badgeText.textContent = `${up}/${total} 个数据源在线`;
    }
  }

  async function refreshOverview() {
    if (!state.overview) {
      try {
        state.overview = await api('/admin/api/overview');
      } catch (e) {
        toast('数据源目录读取失败：' + e.message, 'err');
        return;
      }
    }
    renderOverview();
    // 状态数字要现拉；节流一下，别每次切回首页都全量重取
    if (Date.now() - overviewFetchedAt > 30000) {
      overviewFetchedAt = Date.now();
      await Promise.all([
        reload({ silent: true }).catch(() => {}),
        refreshWorkbuddy().catch(() => {}),
      ]);
      renderOverview();
    }
  }

  $('#dsGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-goto]');
    if (btn) setView(btn.dataset.goto);
  });

  $('#wbRealmSeg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg[data-realm]');
    if (b) wbSetRealm(b.dataset.realm);
  });
  $('#wbRefresh').addEventListener('click', () => refreshWorkbuddy());
  $('#wbRefreshCredits').addEventListener('click', () => wbRefreshCredits());
  $('#wbAddAccount').addEventListener('click', () => wbStartLogin());
  $('#wbSchedRefresh').addEventListener('click', () => refreshWbSchedule());
  $('#wbSchedTrigger').addEventListener('click', async () => {
    const btn = $('#wbSchedTrigger');
    if (btn) btn.disabled = true;
    try {
      await api('/admin/api/workbuddy/schedule/trigger', { method: 'POST', body: '{}' });
      toast('已触发一轮巡检');
    } catch (e) {
      toast('触发失败：' + e.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
      await refreshWbSchedule();
    }
  });
  $('#wbSchedEnabled').addEventListener('change', async (e) => {
    const on = e.target.checked;
    e.target.disabled = true;
    try {
      await api('/admin/api/workbuddy/schedule/toggle', {
        method: 'POST',
        body: JSON.stringify({ enabled: on }),
      });
      toast(on ? '已启用后台调度' : '已关闭后台调度');
    } catch (err) {
      e.target.checked = !on;
      toast('切换失败：' + err.message, 'err');
    } finally {
      e.target.disabled = false;
      await refreshWbSchedule();
    }
  });

  // 点击卡片空白处不触发任何操作，但 Enter 在按钮上由浏览器原生处理
  setView(initialView(), { save: false });
  reload();
})();
