/**
 * Command Code · 决策模型（typesafe/jev）适配层
 * ============================================================
 * Jev 不是 chat 模型：它只有 Provider API 的
 *   POST {apiBase}/provider/v1/systemone
 *   { "model": "typesafe/jev", "state": "...", "questions": { name: { type, instructions } } }
 *   → { "model": "typesafe/jev", "answers": { name: { type, ...概率 } }, "usage": { input_tokens, output_tokens } }
 * 往 /provider/v1/chat/completions 发 typesafe/jev 会被上游拒掉
 * （实测 400 Model "typesafe/jev" is not supported on this endpoint），
 * 而中转站（newapi）只会把请求转成 /v1/chat/completions、/v1/messages、/v1/responses 三种形状，
 * 所以这里做两端翻译：
 *   入站：从消息内容里取出 jev 的 JSON（{"state":…,"questions":…}）
 *   出站：把 answers 包成对应的协议形状（并把 input/output tokens 映射成 usage，供中转站计费）
 *
 * 本模块只做纯函数：解析、校验、渲染，便于单测；网络与 Key 选择在 proxy.mjs 里。
 */

export const SYSTEMONE_PATH = '/provider/v1/systemone';

/** 默认认作决策模型的 id（CC 官方 id 是 typesafe/jev；另两个是站上/客户习惯的写法） */
export const DEFAULT_DECISION_MODELS = ['typesafe/jev', 'typesafe-ai/jev', 'jev'];

/** 「GOAT 及以上」套餐才开放 Provider API 的决策模型 */
export const DECISION_PLAN_HINTS = ['goat', 'pro', 'max'];

export const QUESTION_TYPES = ['noul', 'choice', 'score'];

/** 请求示例，报错时直接回给用户，省得去翻文档 */
export const DECISION_PAYLOAD_HINT =
  '{"state": "需要判断的现状（文本或 JSON）", "questions": {"urgent": {"type": "noul", "instructions": "是否需要紧急处理？"}}}';

export const DECISION_DOC_URL = 'https://commandcode.ai/models/jev';

// ── 模型识别 ──────────────────────────────────────────

export function normalizeDecisionModels(list) {
  const arr = Array.isArray(list) ? list : String(list ?? '').split(/[\s,;]+/);
  const out = [];
  for (const raw of arr) {
    const m = String(raw || '').trim().toLowerCase();
    if (m && !out.includes(m)) out.push(m);
  }
  return out.length ? out : [...DEFAULT_DECISION_MODELS];
}

/** 大小写不敏感；也认 typesafe/* 这种未来可能新增的决策模型 */
export function isDecisionModel(model, list = DEFAULT_DECISION_MODELS) {
  const m = String(model || '').trim().toLowerCase();
  if (!m) return false;
  const models = normalizeDecisionModels(list);
  if (models.includes(m)) return true;
  return /^typesafe[-/]/.test(m);
}

// ── 套餐判定（哪些 Key 能调决策模型）────────────────────

/**
 * plan 形如 individual-go / individual-goat / individual-goat-annual。
 * 按分隔符切成 token 精确匹配，避免 'individual-gopher' 被 'goat' 之外的前缀误伤，
 * 也覆盖 individual-goat-annual 这类带后缀的套餐。
 */
export function planAllowsDecision(plan, hints = DECISION_PLAN_HINTS, extraIds = []) {
  const p = String(plan || '').trim().toLowerCase();
  if (!p) return false;
  const tokens = p.split(/[-_.\s]+/).filter(Boolean);
  if (Array.isArray(extraIds) && extraIds.some((h) => p === String(h).trim().toLowerCase())) return true;
  const want = (Array.isArray(hints) ? hints : DECISION_PLAN_HINTS)
    .map((h) => String(h || '').trim().toLowerCase())
    .filter(Boolean);
  if (!want.length) return false;
  if (want.includes(p)) return true;
  return tokens.some((t) => want.includes(t));
}

// ── 入站解析 ──────────────────────────────────────────

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p?.text ?? p?.input_text ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/** 去掉 ```json … ``` 代码围栏 */
export function stripCodeFence(s) {
  const t = String(s ?? '').trim();
  const m = t.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : t;
}

function collectCandidates(body, protocol) {
  const out = [];
  if (protocol === 'responses') {
    const inp = body?.input;
    if (typeof inp === 'string') out.push(inp);
    else if (Array.isArray(inp)) {
      for (let i = inp.length - 1; i >= 0; i--) {
        const it = inp[i];
        if (it && (it.role === 'user' || it.type === 'message' || it.type === 'input_text')) {
          out.push(contentToText(it.content ?? it.text));
        }
      }
    }
  } else {
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === 'user') out.push(contentToText(msgs[i].content));
    }
  }
  return out.filter((s) => typeof s === 'string' && s.trim());
}

/**
 * 从入站请求里取出 {state, questions}。
 * 优先级：顶层字段（直连代理时好用）→ 最后一条 user 消息里的 JSON。
 * 返回 { ok:true, state, questions, source } 或 { ok:false, error, status, code }
 */
export function extractDecisionPayload(body, protocol = 'chat') {
  let state = body?.state;
  let questions = body?.questions;
  const topLevel = state !== undefined || questions !== undefined;

  if (state === undefined || questions === undefined) {
    const candidates = collectCandidates(body, protocol);
    let parsed = null;
    let sawJson = false;
    for (const raw of candidates) {
      try {
        const p = JSON.parse(stripCodeFence(raw));
        if (p && typeof p === 'object' && !Array.isArray(p)) { parsed = p; sawJson = true; break; }
      } catch { /* 继续找下一条 */ }
    }
    if (parsed) {
      if (state === undefined) state = parsed.state;
      if (questions === undefined) questions = parsed.questions;
    } else if (!topLevel) {
      const preview = (candidates[0] || '').slice(0, 60).replace(/\s+/g, ' ');
      return {
        ok: false, status: 400, code: 'invalid_decision_payload',
        error: '决策模型（jev）需要 systemone 载荷 {"state": …, "questions": {…}}：'
          + '可以直接放在请求体顶层，或作为最后一条 user 消息的 JSON 内容（也接受 ```json 围栏）。'
          + (preview ? ` 收到的内容：${preview}${preview.length >= 60 ? '…' : ''}` : '')
          + ` 文档：${DECISION_DOC_URL}`,
        sawUserText: !!candidates.length,
        sawJson,
      };
    }
  }

  if (state === undefined || state === null || state === '') {
    return { ok: false, status: 400, code: 'missing_state', error: `缺少 state 字段。示例：${DECISION_PAYLOAD_HINT}` };
  }
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length) {
    return { ok: false, status: 400, code: 'missing_questions', error: `缺少 questions 字段（至少一个问题）。示例：${DECISION_PAYLOAD_HINT}` };
  }

  for (const [name, q] of Object.entries(questions)) {
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      return { ok: false, status: 400, code: 'invalid_questions', error: `questions.${name} 必须是对象，形如 {"type": "noul", "instructions": "…"}` };
    }
    const type = String(q.type || '').toLowerCase();
    if (!QUESTION_TYPES.includes(type)) {
      return {
        ok: false, status: 400, code: 'invalid_question_type',
        error: `questions.${name}.type 必须是 ${QUESTION_TYPES.join(' / ')} 之一，当前是 ${q.type === undefined ? '(缺失)' : JSON.stringify(q.type)}`,
      };
    }
  }

  return { ok: true, state, questions, source: topLevel && body?.questions === questions ? 'top-level' : 'message-json' };
}

/** 发往 CC Provider API 的请求体 */
export function buildSystemoneBody(model, payload) {
  return { model: String(model), state: payload.state, questions: payload.questions };
}

// ── 结果解析与渲染 ────────────────────────────────────

/** answers 直接给 JSON 文本（格式化，便于在聊天窗口里读） */
export function answersText(answers) {
  if (answers === undefined || answers === null) return '';
  if (typeof answers === 'string') return answers;
  try { return JSON.stringify(answers, null, 2); } catch { return String(answers); }
}

/** 百分比：0.7895 → 78.9%；保留一位小数，避免 0.79 显示成 79% 丢精度 */
function pct(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x ?? '');
  return `${Math.round(n * 1000) / 10}%`;
}

/** 紧凑数字：1 → "1"，0.87 → "0.87"，1.01 → "1.01" */
function num(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x ?? '');
  const s = n.toFixed(2);
  return s.replace(/\.?0+$/, '') || '0';
}

function legendKeys(legend) {
  if (!legend || typeof legend !== 'object') return [];
  return Object.keys(legend).map((k) => Number(k)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

function distLine(probs, legend) {
  if (!probs || typeof probs !== 'object') return null;
  const parts = Object.entries(probs).map(([k, v]) => {
    const label = legend && legend[k] !== undefined ? `${legend[k]} ` : '';
    return `${label}${k} ${pct(v)}`;
  });
  return parts.length ? `  分布：${parts.join(' / ')}` : null;
}

/**
 * answers → 人看的报告（默认给聊天窗口/脚本用）。
 * 原始 JSON 始终保留在响应的 answers 字段里，这里只负责好看。
 * noul 只有一个概率；choice 给选项 + 分布；score 给档位 + legend 文案（越界的分数只用于取档位，显示保留原值）。
 */
export function answersReport(answers) {
  if (answers === undefined || answers === null) return '';
  if (typeof answers !== 'object' || Array.isArray(answers)) return answersText(answers);
  const lines = [];
  for (const [name, a] of Object.entries(answers)) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      lines.push(`${name}: ${a === undefined || a === null ? '' : String(a)}`);
      continue;
    }
    const type = String(a.type || '').toLowerCase();
    const probs = a.probabilities && typeof a.probabilities === 'object' ? a.probabilities : null;
    const conf = a.confidence !== undefined ? `（置信度 ${pct(a.confidence)}）` : '';
    if (type === 'noul' || a.noul !== undefined) {
      lines.push(`${name}: ${pct(a.noul)}`);
    } else if (type === 'choice' || a.choice !== undefined) {
      lines.push(`${name}: ${a.choice ?? '(空)'}${conf}`);
      const d = distLine(probs, null);
      if (d) lines.push(d);
    } else if (type === 'score' || a.score !== undefined) {
      const legend = a.legend && typeof a.legend === 'object' ? a.legend : null;
      const keys = legendKeys(legend);
      const range = keys.length ? `/${keys[keys.length - 1]}` : '';
      let label = '';
      if (keys.length && Number.isFinite(Number(a.score))) {
        const idx = Math.min(keys[keys.length - 1], Math.max(keys[0], Math.round(Number(a.score))));
        if (legend[idx] !== undefined) label = `「${legend[idx]}」`;
      }
      lines.push(`${name}: ${num(a.score)}${range}${label}${conf}`);
      const d = distLine(probs, legend);
      if (d) lines.push(d);
    } else {
      lines.push(`${name}: ${answersText(a).replace(/\s*\n\s*/g, ' ')}`);
    }
  }
  return lines.join('\n');
}

/** CC 的 usage → 统一的 token 口径 */
export function decisionUsage(u) {
  const inputTokens = Number(u?.input_tokens ?? u?.inputTokens ?? u?.prompt_tokens ?? 0) || 0;
  const outputTokens = Number(u?.output_tokens ?? u?.outputTokens ?? u?.completion_tokens ?? 0) || 0;
  return { inputTokens, outputTokens, promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens };
}

export function openaiUsage(u) {
  return {
    prompt_tokens: u.promptTokens,
    completion_tokens: u.completionTokens,
    total_tokens: u.totalTokens,
    prompt_tokens_details: { cached_tokens: 0 },
  };
}

export function responsesUsage(u) {
  return {
    input_tokens: u.inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: u.outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: u.totalTokens,
  };
}

export function chatCompletionObject({ id, created, model, text, usage, answers }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: openaiUsage(usage),
    // 原始 answers：直连代理的脚本/MCP 直接用这个，不用去解析 content 文本
    ...(answers !== undefined ? { answers } : {}),
  };
}

/**
 * jev 原生响应（不套 chat 外壳）：{model, answers, usage}。
 * usage 里除了 CC 原生的 input_tokens/output_tokens，另外补上 prompt_tokens/completion_tokens，
 * 因为中转站（newapi）只按 chat 口径读这两个键计费 —— 少了就是 0 费。
 */
export function nativeResponseObject({ model, answers, usage }) {
  return {
    model,
    answers,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
    },
  };
}

/** /v1/chat/completions 的 SSE 分帧（答案一次性给出，所以只有 3~4 帧） */
export function chatStreamFrames({ id, created, model, text, usage, includeUsage = false }) {
  const head = { id, object: 'chat.completion.chunk', created, model };
  const frames = [];
  frames.push('data: ' + JSON.stringify({
    ...head,
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  }) + '\n\n');
  frames.push('data: ' + JSON.stringify({
    ...head,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: openaiUsage(usage),
  }) + '\n\n');
  if (includeUsage) {
    frames.push('data: ' + JSON.stringify({ ...head, choices: [], usage: openaiUsage(usage) }) + '\n\n');
  }
  frames.push('data: [DONE]\n\n');
  return frames;
}

/** /v1/messages（Anthropic）的 SSE 分帧 */
export function anthropicStreamFrames({ id, model, text, usage }) {
  const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    sse('message_start', {
      message: {
        id, type: 'message', role: 'assistant', model, content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: usage.inputTokens, output_tokens: 0, cache_read_input_tokens: 0 },
      },
    }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: usage.outputTokens, input_tokens: usage.inputTokens, cache_read_input_tokens: 0 },
    }),
    sse('message_stop', {}),
  ];
}

export function anthropicMessageObject({ id, model, text, usage }) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cache_read_input_tokens: 0 },
  };
}

/** /v1/responses 的对象与 SSE 分帧（字段与代理自身的 responses 翻译器保持一致） */
export function responsesObject({ id, created, model, text, usage, status = 'completed' }) {
  const item = {
    id: id + '_msg',
    type: 'message',
    role: 'assistant',
    status,
    content: text ? [{ type: 'output_text', text, annotations: [] }] : [],
  };
  return {
    id,
    object: 'response',
    created_at: created,
    status,
    model,
    output: status === 'completed' ? [item] : [],
    output_text: text,
    error: null,
    incomplete_details: null,
    parallel_tool_calls: true,
    previous_response_id: null,
    store: false,
    tools: [],
    metadata: {},
    usage: responsesUsage(usage),
  };
}

export function responsesStreamFrames({ id, created, model, text, usage }) {
  let seq = 0;
  const sse = (type, data) => 'event: ' + type + '\ndata: ' + JSON.stringify({ type, sequence_number: seq++, ...data }) + '\n\n';
  const base = (status, output) => ({
    id, object: 'response', created_at: created, status,
    output: output || [], output_text: status === 'completed' ? text : '',
    model, error: null, incomplete_details: null,
    parallel_tool_calls: true, previous_response_id: null, store: false, tools: [], metadata: {},
    ...(status === 'completed' ? { usage: responsesUsage(usage) } : {}),
  });
  const itemId = id + '_msg';
  const itemInProgress = { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
  const itemDone = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  return [
    sse('response.created', { response: base('in_progress') }),
    sse('response.in_progress', { response: base('in_progress') }),
    sse('response.output_item.added', { output_index: 0, item: itemInProgress }),
    sse('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
    sse('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: text, logprobs: [] }),
    sse('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text, logprobs: [] }),
    sse('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } }),
    sse('response.output_item.done', { output_index: 0, item: itemDone }),
    sse('response.completed', { response: base('completed', [itemDone]) }),
  ];
}

/** 把 CC 的错误体整理成一句话（给用户看） */
export function summarizeDecisionError(status, text) {
  const raw = String(text || '').trim();
  let msg = raw.slice(0, 300);
  try {
    const j = JSON.parse(raw);
    msg = j?.error?.message || j?.message || msg;
  } catch { /* 非 JSON 就用原文 */ }
  return msg || `上游 ${status}`;
}
