// 决策模型（typesafe/jev）适配层测试：
//   · 纯函数：模型识别 / 套餐判定 / 载荷解析 / 各协议分帧
//   · 端到端：真起代理 + 假上游，验证 chat / messages / responses 三条路都能落成 systemone 调用
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startProxy, startMockUpstream, setup } from './helpers.mjs';

import {
  DEFAULT_DECISION_MODELS, DECISION_PLAN_HINTS, SYSTEMONE_PATH,
  normalizeDecisionModels, isDecisionModel, planAllowsDecision,
  extractDecisionPayload, buildSystemoneBody, answersText, decisionUsage,
  chatCompletionObject, chatStreamFrames, anthropicMessageObject, anthropicStreamFrames,
  responsesObject, responsesStreamFrames, stripCodeFence, summarizeDecisionError,
} from '../decision.mjs';

const JEV = 'typesafe/jev';
const ASK = { state: 'Payments failed for three days.', questions: { urgent: { type: 'noul', instructions: 'urgent?' } } };

// ── 纯函数 ────────────────────────────────────────────
test('isDecisionModel：官方 id、站上别名、大小写、未来 typesafe/* 都认', () => {
  for (const m of ['typesafe/jev', 'typesafe-ai/jev', 'jev', 'JEV', 'TYPESAFE/jev', 'Typesafe/Jev']) {
    assert.equal(isDecisionModel(m), true, m);
  }
  assert.equal(isDecisionModel('typesafe/other-new'), true);      // 未来的决策模型
  assert.equal(isDecisionModel('deepseek/deepseek-v4.1-flash'), false);
  assert.equal(isDecisionModel('claude-sonnet-5-5'), false);
  assert.equal(isDecisionModel(''), false);
  assert.equal(isDecisionModel(undefined), false);
  // 自定义名单
  assert.equal(isDecisionModel('jev', ['x']), false);
  assert.deepEqual(normalizeDecisionModels(' a , B ;a'), ['a', 'b']);
  assert.deepEqual(normalizeDecisionModels(null), DEFAULT_DECISION_MODELS);
});

test('planAllowsDecision：GOAT 及以上放行，go 不放行', () => {
  assert.equal(planAllowsDecision('individual-goat'), true);
  assert.equal(planAllowsDecision('individual-goat-annual'), true);
  assert.equal(planAllowsDecision('goat'), true);
  assert.equal(planAllowsDecision('individual-pro'), true);
  assert.equal(planAllowsDecision('individual-max'), true);
  assert.equal(planAllowsDecision('individual-go'), false);
  assert.equal(planAllowsDecision('individual-gopher'), false);
  assert.equal(planAllowsDecision(''), false);
  assert.equal(planAllowsDecision(null), false);
  assert.equal(planAllowsDecision('enterprise'), false, '自定义 hint 之外不放行');
  assert.equal(planAllowsDecision('enterprise', ['enterprise']), true);
  assert.deepEqual(DECISION_PLAN_HINTS, ['goat', 'pro', 'max']);
});

test('stripCodeFence / extractDecisionPayload：从消息里取 JSON', () => {
  assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFence('{"a":1}'), '{"a":1}');

  const chat = (content) => extractDecisionPayload({ model: JEV, messages: [{ role: 'user', content }] }, 'chat');
  assert.equal(chat(JSON.stringify(ASK)).ok, true);
  assert.equal(chat('```json\n' + JSON.stringify(ASK) + '\n```').ok, true);
  // 数组形式的内容
  assert.equal(extractDecisionPayload({
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(ASK) }] }],
  }, 'chat').ok, true);
  // 取最后一条 user（前面有 system / assistant 噪声）
  const multi = extractDecisionPayload({
    messages: [
      { role: 'system', content: 'ignored' },
      { role: 'assistant', content: '不是 JSON' },
      { role: 'user', content: JSON.stringify(ASK) },
    ],
  }, 'chat');
  assert.equal(multi.ok, true);
  // 顶层字段（直连代理时）
  const top = extractDecisionPayload({ state: 'x', questions: { q: { type: 'noul' } } }, 'chat');
  assert.equal(top.ok, true);
  assert.equal(top.source, 'top-level');
  // responses 协议的 input
  assert.equal(extractDecisionPayload({ input: JSON.stringify(ASK) }, 'responses').ok, true);
});

test('extractDecisionPayload：缺字段/类型错/非 JSON 都要给明确报错', () => {
  const bad = (body, protocol = 'chat') => extractDecisionPayload(body, protocol);
  const p1 = bad({ messages: [{ role: 'user', content: '今天天气不错' }] });
  assert.equal(p1.ok, false);
  assert.equal(p1.status, 400);
  assert.equal(p1.code, 'invalid_decision_payload');
  assert.match(p1.error, /state/);

  const p2 = bad({ messages: [{ role: 'user', content: JSON.stringify({ questions: { a: { type: 'noul' } } }) }] });
  assert.equal(p2.code, 'missing_state');

  const p3 = bad({ messages: [{ role: 'user', content: JSON.stringify({ state: 'x' }) }] });
  assert.equal(p3.code, 'missing_questions');

  const p4 = bad({ messages: [{ role: 'user', content: JSON.stringify({ state: 'x', questions: {} }) }] });
  assert.equal(p4.code, 'missing_questions');

  const p5 = bad({ messages: [{ role: 'user', content: JSON.stringify({ state: 'x', questions: { a: { type: 'yesno' } } }) }] });
  assert.equal(p5.code, 'invalid_question_type');
  assert.match(p5.error, /noul \/ choice \/ score/);

  const p6 = bad({ messages: [{ role: 'user', content: JSON.stringify({ state: 'x', questions: { a: 'noul' } }) }] });
  assert.equal(p6.code, 'invalid_questions');

  // 空消息内容
  assert.equal(bad({ messages: [{ role: 'user', content: '' }] }).ok, false);
  // 顶层只有 state，消息里也没有 JSON
  assert.equal(bad({ state: 'x', messages: [{ role: 'user', content: '没 JSON' }] }).code, 'missing_questions');
});

test('buildSystemoneBody / answersText / decisionUsage', () => {
  assert.deepEqual(buildSystemoneBody(JEV, ASK), { model: JEV, state: ASK.state, questions: ASK.questions });
  assert.equal(answersText({ urgent: { type: 'noul', noul: 0.87 } }), '{\n  "urgent": {\n    "type": "noul",\n    "noul": 0.87\n  }\n}');
  assert.equal(answersText('already text'), 'already text');
  assert.equal(answersText(null), '');

  const u = decisionUsage({ input_tokens: 278, output_tokens: 20 });
  assert.deepEqual(u, { inputTokens: 278, outputTokens: 20, promptTokens: 278, completionTokens: 20, totalTokens: 298 });
  assert.equal(decisionUsage(undefined).totalTokens, 0);
});

test('渲染：chat 对象与分帧', () => {
  const usage = decisionUsage({ input_tokens: 10, output_tokens: 5 });
  const obj = chatCompletionObject({ id: 'chatcmpl-1', created: 1, model: JEV, text: '{"a":1}', usage });
  assert.equal(obj.object, 'chat.completion');
  assert.equal(obj.choices[0].message.content, '{"a":1}');
  assert.equal(obj.choices[0].finish_reason, 'stop');
  assert.equal(obj.usage.prompt_tokens, 10);
  assert.equal(obj.usage.completion_tokens, 5);
  assert.equal(obj.usage.total_tokens, 15);

  const frames = chatStreamFrames({ id: 'chatcmpl-1', created: 1, model: JEV, text: '{"a":1}', usage });
  assert.equal(frames.length, 3);
  assert.equal(frames.at(-1), 'data: [DONE]\n\n');
  const first = JSON.parse(frames[0].replace(/^data: /, '').trim());
  assert.equal(first.object, 'chat.completion.chunk');
  assert.equal(first.choices[0].delta.content, '{"a":1}');
  const last = JSON.parse(frames[1].replace(/^data: /, '').trim());
  assert.equal(last.choices[0].finish_reason, 'stop');
  assert.equal(last.usage.total_tokens, 15);
  // include_usage 时多一帧纯 usage
  const withUsage = chatStreamFrames({ id: 'x', created: 1, model: JEV, text: 't', usage, includeUsage: true });
  assert.equal(withUsage.length, 4);
  assert.deepEqual(JSON.parse(withUsage[2].replace(/^data: /, '').trim()).choices, []);
});

test('渲染：anthropic 与 responses', () => {
  const usage = decisionUsage({ input_tokens: 7, output_tokens: 3 });
  const msg = anthropicMessageObject({ id: 'msg_1', model: JEV, text: 'answer', usage });
  assert.equal(msg.type, 'message');
  assert.equal(msg.content[0].text, 'answer');
  assert.equal(msg.stop_reason, 'end_turn');
  assert.equal(msg.usage.input_tokens, 7);
  assert.equal(msg.usage.output_tokens, 3);

  const af = anthropicStreamFrames({ id: 'msg_1', model: JEV, text: 'answer', usage });
  const names = af.map((f) => /^event: (\S+)/.exec(f)?.[1]);
  assert.deepEqual(names, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  for (const f of af) {
    const data = JSON.parse(f.split('data: ')[1]);
    assert.equal(typeof data.type, 'string');
  }
  assert.equal(JSON.parse(af[2].split('data: ')[1]).delta.text, 'answer');

  const resp = responsesObject({ id: 'resp_1', created: 5, model: JEV, text: 'answer', usage });
  assert.equal(resp.object, 'response');
  assert.equal(resp.status, 'completed');
  assert.equal(resp.output_text, 'answer');
  assert.equal(resp.output[0].content[0].text, 'answer');
  assert.equal(resp.usage.input_tokens, 7);

  const rf = responsesStreamFrames({ id: 'resp_1', created: 5, model: JEV, text: 'answer', usage });
  const rn = rf.map((f) => /^event: (\S+)/.exec(f)?.[1]);
  assert.deepEqual(rn, [
    'response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added',
    'response.output_text.delta', 'response.output_text.done', 'response.content_part.done',
    'response.output_item.done', 'response.completed',
  ]);
  assert.deepEqual(rf.map((f) => JSON.parse(f.split('data: ')[1]).sequence_number), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(JSON.parse(rf.at(-1).split('data: ')[1]).response.usage.total_tokens, 10);
});

test('summarizeDecisionError：透出上游错误信息', () => {
  assert.equal(summarizeDecisionError(400, JSON.stringify({ error: { message: 'Model "typesafe/jev" is not supported on this endpoint.' } })),
    'Model "typesafe/jev" is not supported on this endpoint.');
  assert.equal(summarizeDecisionError(500, 'boom'), 'boom');
  assert.equal(summarizeDecisionError(503, ''), '上游 503');
});

// ── 端到端（假上游 + 真代理）──────────────────────────
const JEV_ANSWER = {
  model: JEV,
  answers: { urgent: { type: 'noul', noul: 0.87 } },
  usage: { input_tokens: 278, output_tokens: 20 },
};

/** 造一个带 GOAT Key 的池子 */
function writePool(dir, { plan = 'individual-goat', label = 'goat', extra = [] } = {}) {
  const mk = (id, label_, key, plan_) => ({
    id, label: label_, key, weight: 1, enabled: true, priority: 0, createdAt: 0,
    lastUsedAt: null, lastErrorAt: null, errorCount: 0, cooldownUntil: 0, consecutiveFailures: 0,
    autoDisabled: null,
    credits: { fetchedAt: Date.now(), creditsRemaining: 50, plan: plan_, credits: { monthly: 50 }, windows: [] },
  });
  writeFileSync(join(dir, 'keys.json'), JSON.stringify({
    lb: { strategy: 'weighted', stickyBy: 'client-key', maxRetries: 2, cooldownMs: 60000 },
    settings: {
      mode: 'session', failThreshold: 3, sessionTtlMs: 21600000, creditsRefreshMs: 0,
      autoDisableExhausted: true, onAllExhausted: 'error',
    },
    keys: [mk('key_goat', label, 'user_goat000000000000000001', plan), ...extra],
    defaultId: null,
  }, null, 2));
}

function tmpPoolDir(opts) {
  const dir = mkdtempSync(join(tmpdir(), 'ccp-jev-'));
  writePool(dir, opts);
  return dir;
}

/** 假上游：只实现 /provider/v1/systemone */
async function startSystemone({ status = 200, body = JEV_ANSWER, delayMs = 0 } = {}) {
  return startMockUpstream({
    onRequest: async (req, res, seen) => {
      if (!req.url.startsWith(SYSTEMONE_PATH)) return;   // 其它路径交给 helper 的默认假上游（/alpha/generate 等）
      if (delayMs) await sleep(delayMs);
      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    },
  });
}

async function withProxy({ dirOpts, upstream, env = {} } = {}) {
  const mock = upstream || await startSystemone();
  const dir = dirOpts === null ? undefined : tmpPoolDir(dirOpts);
  const proxy = await startProxy({ upstreamPort: mock.port, cwd: dir, env });
  return {
    mock, proxy, dir,
    systemoneCalls: () => mock.seen.filter((s) => s.url.startsWith(SYSTEMONE_PATH)),
    async close() {
      await proxy.kill();
      await mock.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('端到端：/v1/chat/completions 调用 jev → 转成 systemone，answers 包成 chat', async () => {
  const s = await withProxy({ dirOpts: {} });
  try {
    const r = await s.proxy.post('/v1/chat/completions', {
      model: JEV,
      messages: [{ role: 'user', content: JSON.stringify(ASK) }],
    }, { Authorization: 'Bearer user_sitekey' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.object, 'chat.completion');
    // 默认给人看：一行一条；原始对象在 answers 字段里
    assert.match(j.choices[0].message.content, /urgent: 87%/);
    assert.deepEqual(j.answers, { urgent: { type: 'noul', noul: 0.87 } });
    assert.equal(j.usage.prompt_tokens, 278);
    assert.equal(j.usage.completion_tokens, 20);

    const calls = s.systemoneCalls();
    assert.equal(calls.length, 1);
    const sent = JSON.parse(calls[0].raw);
    assert.equal(sent.model, JEV);
    assert.equal(sent.state, ASK.state);
    assert.deepEqual(sent.questions, ASK.questions);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers.authorization, 'Bearer user_goat000000000000000001', '必须用池里 GOAT Key');
    assert.equal(calls[0].headers['x-cli-environment'], 'production');
    // 不能落到 /alpha/generate（那是 chat 信封）
    assert.equal(s.mock.generateCount?.() ?? s.mock.seen.filter((x) => x.url === '/alpha/generate').length, 0);
  } finally { await s.close(); }
});

test('端到端：流式 chat 分帧 + usage', async () => {
  const s = await withProxy({ dirOpts: {} });
  try {
    const r = await s.proxy.post('/v1/chat/completions', {
      model: JEV, stream: true,
      messages: [{ role: 'user', content: JSON.stringify(ASK) }],
    }, { Authorization: 'Bearer k' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const text = await r.text();
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /data: \[DONE\]/);
    assert.match(text, /"total_tokens":298/);
  } finally { await s.close(); }
});

test('端到端：/v1/messages 与 /v1/responses 也能调 jev', async () => {
  const s = await withProxy({ dirOpts: {} });
  try {
    const a = await s.proxy.post('/v1/messages', {
      model: JEV, max_tokens: 100,
      messages: [{ role: 'user', content: JSON.stringify(ASK) }],
    }, { 'x-api-key': 'user_sitekey' });
    assert.equal(a.status, 200);
    const aj = await a.json();
    assert.equal(aj.type, 'message');
    assert.match(aj.content[0].text, /urgent: 87%/);
    assert.equal(aj.usage.input_tokens, 278);
    assert.equal(aj.usage.output_tokens, 20);

    const b = await s.proxy.post('/v1/responses', {
      model: JEV, input: JSON.stringify(ASK),
    }, { Authorization: 'Bearer user_sitekey' });
    assert.equal(b.status, 200);
    const bj = await b.json();
    assert.equal(bj.object, 'response');
    assert.match(bj.output_text, /urgent: 87%/);
    assert.equal(bj.usage.total_tokens, 298);

    assert.equal(s.systemoneCalls().length, 2);
  } finally { await s.close(); }
});

test('端到端：池里没有 GOAT Key → 503 且说明原因；有 Key 但载荷不合法 → 400', async () => {
  const s = await withProxy({ dirOpts: { plan: 'individual-go', label: '普通号' } });
  try {
    const r = await s.proxy.post('/v1/chat/completions', {
      model: JEV, messages: [{ role: 'user', content: JSON.stringify(ASK) }],
    }, { Authorization: 'Bearer k' });
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.match(j.error.message, /GOAT/);
    assert.equal(s.systemoneCalls().length, 0, '不该向上游发请求');
  } finally { await s.close(); }
});

test('端到端：普通 chat 模型完全不受影响（仍走 /alpha/generate）', async () => {
  const s = await withProxy({ dirOpts: {} });
  try {
    const r = await s.proxy.post('/v1/chat/completions', {
      model: 'deepseek/deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
    }, { Authorization: 'Bearer k' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).choices[0].message.content, 'hello');
    assert.equal(s.systemoneCalls().length, 0);
    assert.equal(s.mock.seen.filter((x) => x.url === '/alpha/generate').length, 1);
  } finally { await s.close(); }
});

test('端到端：上游 400（端点不支持）会映射成 400 并带原始信息', async () => {
  const mock = await startSystemone({
    status: 400,
    body: { error: { message: `Model "${JEV}" is not supported on this endpoint.`, code: 'unsupported_model' } },
  });
  const s = await withProxy({ dirOpts: {}, upstream: mock });
  try {
    const r = await s.proxy.post('/v1/chat/completions', {
      model: JEV, messages: [{ role: 'user', content: JSON.stringify(ASK) }],
    }, { Authorization: 'Bearer k' });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.match(j.error.message, /not supported on this endpoint/);
  } finally { await s.close(); }
});

test('端到端：载荷不是 JSON → 400，且不去打扰上游', async () => {
  const s = await withProxy({ dirOpts: {} });
  try {
    const r = await s.proxy.post('/v1/chat/completions', {
      model: JEV, messages: [{ role: 'user', content: '帮我判断一下' }],
    }, { Authorization: 'Bearer k' });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.match(j.error.message, /state/);
    assert.equal(s.systemoneCalls().length, 0);
  } finally { await s.close(); }
});

test('端到端：decisionKeyIds 写死名单时忽略套餐判断', async () => {
  const dir = tmpPoolDir({ plan: 'individual-go', label: '普通号' });
  const mock = await startSystemone();
  try {
    // 先拿到代理生成的 key id
    const bare = await startProxy({ upstreamPort: mock.port, cwd: dir });
    const before = await bare.post('/v1/chat/completions', {
      model: JEV, messages: [{ role: 'user', content: JSON.stringify(ASK) }],
    }, { Authorization: 'Bearer k' });
    assert.equal(before.status, 503, '默认按套餐拦住');
    await bare.kill();

    // 写死名单后放行
    const keys = JSON.parse(String(await import('node:fs').then((f) => f.readFileSync(join(dir, 'keys.json'), 'utf-8'))));
    keys.settings.decisionKeyIds = [keys.keys[0].id];
    writeFileSync(join(dir, 'keys.json'), JSON.stringify(keys, null, 2));
    const forced = await startProxy({ upstreamPort: mock.port, cwd: dir });
    try {
      const r = await forced.post('/v1/chat/completions', {
        model: JEV, messages: [{ role: 'user', content: JSON.stringify(ASK) }],
      }, { Authorization: 'Bearer k' });
      assert.equal(r.status, 200);
      assert.equal(r.status, 200);
    } finally { await forced.kill(); }
  } finally { await mock.close(); rmSync(dir, { recursive: true, force: true }); }
});
