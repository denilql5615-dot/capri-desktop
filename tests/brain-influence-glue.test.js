'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  planInfluence,
  commitInfluence,
  stripBrainHints,
  effectiveInfluenceMode,
  resolveInfluenceAb,
  utc5DayInfo,
} = require('../src/main/brain/influence-glue');
const { createReassessmentPolicy, STOP_HINT_TEXT } = require('../src/main/brain/reassessment-policy');
const { createShadowHook, TOR_COOLDOWN_MS } = require('../src/main/brain/shadow-hook');
const { createChatGlue } = require('../src/main/brain/chat-glue');
const { openRotatingJournal } = require('../src/main/brain/rotating-journal');
const { createVerdictJudge } = require('../src/main/brain/verdict-judge');
const { createShadow, CONFIG } = require('../src/main/brain/index');
const { salience } = require('../src/main/brain/amygdala');
const { createTorState, shouldSkipChatPersistence } = require('../src/main/tor-guard');
const brainsLib = require('../src/main/brains');
const tor = require('../src/main/tor');

const mkDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-inf-')), 'brain-journal');

function makeUuid(prefix = 3000) {
  let n = prefix;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

test('config default keeps brainInfluence off and sets brainInfluenceAbStart to 2026-11-18', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/config.js'), 'utf8');
  assert.match(src, /brainInfluence:\s*'off'/);
  assert.match(src, /brainInfluenceAbStart:\s*'2026-11-18'/);
});

test('planInfluence: brainShadow=false returns neutral without invoking hook or policy', () => {
  let peekCalls = 0;
  let policyCalls = 0;
  const res = planInfluence({
    cfg: { brainShadow: false, brainInfluence: 'reassessment' },
    said: 'нет, ты ошиблась, проверь ещё раз срочно',
    messages: [{ role: 'user', content: 'нет, ты ошиблась, проверь ещё раз срочно' }],
    hook: { peekChannels: () => { peekCalls++; return { reassessment: 0.75, reassessment_active: 1 }; } },
    policy: { decide: () => { policyCalls++; return { action: 'escalate' }; } },
    env: { brainsReady: true, isAuto: true, now: 1000 },
    tor,
  });

  assert.deepEqual(res, { main: false, hint: null, decision: null, escalated: false });
  assert.equal(peekCalls, 0);
  assert.equal(policyCalls, 0);
});

test('planInfluence: off mode returns neutral main/hint while tracking shadow_* counters', () => {
  const clock = Date.UTC(2026, 10, 18, 12, 0, 0);
  const policy = createReassessmentPolicy({ now: () => clock });
  const fakeHook = {
    peekChannels: () => ({ reassessment: 0.7, reassessment_active: 1, stability: 1, circadian_quiet: 0 }),
  };

  const res = planInfluence({
    cfg: { brainShadow: true, brainInfluence: 'off', provider: 'ollama' },
    said: 'нет, не сработало',
    messages: [{ role: 'user', content: 'нет, не сработало' }],
    hook: fakeHook,
    policy,
    env: { local: true, brainsReady: true, isAuto: true, mainActive: false, now: clock },
    tor,
  });

  assert.equal(res.main, false);
  assert.equal(res.hint, null);
  assert.equal(res.escalated, false);
  const st = policy.stats();
  assert.equal(st.shadow_trigger_episodes, 1);
  assert.equal(st.shadow_escalate, 1);
  assert.equal(st.escalation_count, 0);
});

test('planInfluence: reassessment + channel 0.7 + contradiction returns escalate decision without charging until commitInfluence', () => {
  const clock = Date.UTC(2026, 10, 18, 12, 0, 0);
  const policy = createReassessmentPolicy({ now: () => clock });
  const fakeHook = {
    peekChannels: () => ({ reassessment: 0.7, reassessment_active: 1, stability: 1, circadian_quiet: 0 }),
  };

  const res = planInfluence({
    cfg: { brainShadow: true, brainInfluence: 'reassessment', provider: 'ollama' },
    said: 'нет, ты ошиблась в этом расчёте',
    messages: [{ role: 'user', content: 'нет, ты ошиблась в этом расчёте' }],
    hook: fakeHook,
    policy,
    env: { local: true, brainsReady: true, isAuto: true, mainActive: false, now: clock },
    tor,
  });

  assert.equal(res.main, true);
  assert.equal(res.hint, null);
  assert.equal(res.escalated, true);
  assert.equal(res.decision?.action, 'escalate');
  // P2-3: planInfluence must NOT spend budget before the 26B turn actually completes/fails
  assert.equal(policy.stats().escalation_count, 0);
  assert.equal(policy.stats().budgetLeft, 2);

  // Abort or model switch skips commitInfluence -> budget remains untouched
  assert.equal(commitInfluence(policy, res, { aborted: true }), false);
  assert.equal(commitInfluence(policy, res, { escalated: false }), false);
  assert.equal(policy.stats().escalation_count, 0);

  // Real 26B execution commits the slot
  assert.equal(commitInfluence(policy, res), true);
  assert.equal(policy.stats().escalation_count, 1);
  assert.equal(policy.stats().budgetLeft, 1);
});

test('planInfluence: overload peeks STOP_HINT_TEXT without consuming until commitInfluence', () => {
  const clock = Date.UTC(2026, 10, 18, 12, 0, 0);
  const policy = createReassessmentPolicy({ now: () => clock });
  const fakeHook = {
    peekChannels: () => ({ reassessment: 0.9, reassessment_active: 1, stability: 1, circadian_quiet: 0 }),
  };
  const call = () => planInfluence({
    cfg: { brainShadow: true, brainInfluence: 'reassessment', provider: 'ollama' },
    said: 'нет, опять ошибка в ответе',
    messages: [{ role: 'user', content: 'нет, опять ошибка в ответе' }],
    hook: fakeHook,
    policy,
    env: { local: true, brainsReady: true, isAuto: true, now: clock },
    tor,
  });

  const first = call();
  assert.equal(first.main, false);
  assert.equal(first.escalated, false);
  assert.equal(first.hint, STOP_HINT_TEXT);
  assert.equal(policy.stats().stop_hint_count, 0);

  // Aborted turn before send -> stopHint stays available for the next attempt in the series
  assert.equal(commitInfluence(policy, first, { aborted: true }), false);
  const retry = call();
  assert.equal(retry.hint, STOP_HINT_TEXT);

  // Delivered turn consumes stopHint once per series
  assert.equal(commitInfluence(policy, retry), true);
  const after = call();
  assert.equal(after.main, false);
  assert.equal(after.escalated, false);
  assert.equal(after.hint, null);
  assert.equal(policy.stats().stop_report_count, 3);
  assert.equal(policy.stats().stop_hint_count, 1);
});

test('planInfluence: Tor, RP, non-local worker routes, and hook errors all fail safe to neutral', () => {
  const clock = Date.UTC(2026, 10, 18, 12, 0, 0);
  const policy = createReassessmentPolicy({ now: () => clock });
  const hotHook = {
    peekChannels: () => ({ reassessment: 0.72, reassessment_active: 1, stability: 1, circadian_quiet: 0 }),
  };

  // Tor wording in history context
  assert.deepEqual(planInfluence({
    cfg: { brainShadow: true, brainInfluence: 'reassessment', provider: 'ollama' },
    said: 'нет, это не то',
    messages: [{ role: 'user', content: 'найди через тор' }, { role: 'user', content: 'нет, это не то' }],
    hook: hotHook,
    policy,
    env: { local: true, brainsReady: true, isAuto: true, now: clock },
    tor,
  }), { main: false, hint: null, decision: null, escalated: false });

  // RP mode
  assert.deepEqual(planInfluence({
    cfg: { brainShadow: true, brainInfluence: 'reassessment', provider: 'ollama', rp: true },
    said: 'нет, не то',
    messages: [{ role: 'user', content: 'нет, не то' }],
    hook: hotHook,
    policy,
    env: { local: true, brainsReady: true, isAuto: true, rp: true, now: clock },
    tor,
  }), { main: false, hint: null, decision: null, escalated: false });

  // Cloud worker / computer route
  assert.deepEqual(planInfluence({
    cfg: { brainShadow: true, brainInfluence: 'reassessment', provider: 'ollama' },
    said: 'нет, не то',
    messages: [{ role: 'user', content: 'нет, не то' }],
    route: { worker: 'claude' },
    hook: hotHook,
    policy,
    env: { local: true, brainsReady: true, isAuto: true, now: clock },
    tor,
  }), { main: false, hint: null, decision: null, escalated: false });

  // Exception inside hook.peekChannels() -> neutral, never throws
  const brokenHook = {
    peekChannels() { throw new Error('boom'); },
  };
  assert.deepEqual(planInfluence({
    cfg: { brainShadow: true, brainInfluence: 'reassessment', provider: 'ollama' },
    said: 'нет, не то',
    messages: [{ role: 'user', content: 'нет, не то' }],
    hook: brokenHook,
    policy,
    env: { local: true, brainsReady: true, isAuto: true, now: clock },
    tor,
  }), { main: false, hint: null, decision: null, escalated: false });
  assert.equal(policy.stats().trigger_episodes, 0);
});

test('onVerdict records base vs escalated outcomes from the core verdict only (button, dict; shadow judge ignored), no Tor leak', async () => {
  const dir = mkDir();
  let clock = Date.UTC(2026, 10, 18, 12, 0, 0);
  const policy = createReassessmentPolicy({ now: () => clock });
  // Turn 2 ('не сработало', dict=-1) still calls shadow judge -> consumes idx 0; Turn 3 -> CLARIFY (0); Turn 4 -> MINUS (-1)
  const judgeQueue = ['{"v":"NONE"}', '{"v":"CLARIFY"}', '{"v":"MINUS"}'];
  let jIdx = 0;

  const judge = createVerdictJudge({
    maxPerMinute: 100,
    now: () => clock,
    callModel: async () => judgeQueue[jIdx++] || '{"v":"NONE"}',
  });
  const hook = createShadowHook({
    dir,
    now: () => { clock += 1000; return clock; },
    uuid: makeUuid(6000),
    verdictJudge: judge,
    onVerdict: (meta, verdict) => policy.recordOutcome({ escalated: Boolean(meta?.escalated), verdict }),
  });
  const glue = createChatGlue({
    getHook: () => hook,
    tor,
    salience,
    isLocalModel: () => true,
  });
  const cfg = { brainShadow: true, brainVerdictJudge: 'shadow', provider: 'ollama', rp: false };

  // 1. Base ordinary turn -> button verdict(1) -> base_pos++
  const tBase1 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'обычный вопрос' }], cfg, new AbortController().signal, {
    meta: { escalated: false },
  });
  glue.afterSuccess(tBase1);
  assert.equal(hook.verdict(1), true);

  // 2. Escalated turn -> dictionary verdict(-1) on next message -> esc_neg++
  const tEsc1 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'пересчитай' }], cfg, new AbortController().signal, {
    meta: { escalated: true },
  });
  glue.afterSuccess(tEsc1);
  glue.beforeTurn([{ role: 'user', content: 'не сработало' }], cfg);
  glue.afterTurn(cfg);
  await hook.flush();

  // 3. Escalated turn -> no dictionary verdict (judge says CLARIFY, ignored) -> verdict 0 (esc_unverified)
  const tEsc2 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'сложный разбор' }], cfg, new AbortController().signal, {
    meta: { escalated: true },
  });
  glue.afterSuccess(tEsc2);
  glue.beforeTurn([{ role: 'user', content: 'а если короче' }], cfg);
  glue.afterTurn(cfg);
  await hook.flush();

  // 4. Base turn -> judge returns MINUS, but the judge is shadow-only: the core verdict is 0 -> base_unverified
  const tBase2 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'ещё вопрос' }], cfg, new AbortController().signal, {
    meta: { escalated: false },
  });
  glue.afterSuccess(tBase2);
  glue.beforeTurn([{ role: 'user', content: 'как-то криво' }], cfg);
  glue.afterTurn(cfg);
  await hook.flush();

  // 5. Escalated turn dropped by Tor -> must NOT touch base/esc counts
  const tTor = glue.startLocal({ worker: null }, [{ role: 'user', content: 'ещё шаг' }], cfg, new AbortController().signal, {
    meta: { escalated: true },
  });
  glue.afterSuccess(tTor);
  hook.torTouched();

  await hook.close();
  const st = policy.stats();
  assert.equal(st.base_pos, 1);
  assert.equal(st.base_neg, 0);
  assert.ok(st.base_unverified >= 1);
  assert.equal(st.esc_neg, 1);
  assert.equal(st.esc_unverified, 1);
  assert.equal(st.esc_pos, 0);
  assert.equal(st.tripped, false);
});

test('rotatingJournal.exportCheckpoint() + shadowHook memCore full resync preserves transitions & impulses', async () => {
  const dir = mkDir();
  const baseTime = Date.UTC(2026, 10, 18, 10, 0, 0);

  // Session 1: write two negative turns with contradiction/urgency so transitions & impulses are populated on disk
  let clk1 = baseTime;
  const hook1 = createShadowHook({ dir, now: () => (clk1 += 5000), uuid: makeUuid(7000) });
  for (let i = 0; i < 2; i++) {
    const t = hook1.start({ worker: null }, { features: { urgency: 1, contradiction: 1 } });
    t.complete({ verified: true, utility: -1 });
  }
  await hook1.close();

  // Verify openRotatingJournal exposes read-only exportCheckpoint() with full transitions/impulses
  const jCheck = await openRotatingJournal(dir);
  let exported;
  try {
    exported = jCheck.exportCheckpoint();
  } finally {
    await jCheck.close();
  }
  assert.ok(exported);
  assert.ok(exported.state.reassessment > 0);
  assert.ok(exported.transitions && 'reassessment' in exported.transitions);
  assert.ok(exported.impulses && 'reassessment' in exported.impulses);
  assert.ok(exported.impulses.reassessment && typeof exported.impulses.reassessment.sum === 'number');
  assert.ok(Math.abs(exported.impulses.reassessment.sum) > 0);

  // Session 2 (cold restart within same 60s window): batch write -> memCore resyncs cleanly from full journal exportCheckpoint()
  let clk2 = clk1 + 2000;
  const hook2 = createShadowHook({ dir, now: () => (clk2 += 1000), uuid: makeUuid(8000) });
  let cp2;
  let diskSnap2;
  let p2;
  const probeAt = clk1 + 10000;
  try {
    const t3 = hook2.start({ worker: null }, { features: { urgency: 0, contradiction: 0 } });
    t3.complete({ verified: true, utility: 1 });
    await hook2.flush();

    const jCompare = await openRotatingJournal(dir);
    try {
      cp2 = jCompare.exportCheckpoint();
      diskSnap2 = jCompare.snapshot();
    } finally {
      await jCompare.close();
    }
    p2 = hook2.peekChannels(probeAt, { urgency: 1, contradiction: 0 });
  } finally {
    await hook2.close();
  }

  assert.ok(p2);
  const expectedCore = createShadow({ checkpoint: cp2 });
  const expectedAdvance = expectedCore.ingest({
    privacy: 'ordinary',
    event: {
      type: 'message',
      schema_version: CONFIG.schema_version,
      config_version: CONFIG.version,
      event_id: '00000000-0000-4000-8000-000000000001',
      task_id: '00000000-0000-4000-8000-000000000002',
      source_id: '00000000-0000-4000-8000-000000000003',
      source_seq: 1,
      task_seq: 1,
      occurred_at_ms: probeAt,
      received_at_ms: probeAt,
      origin: 'user',
      route: 'unknown',
      novelty: 0,
      uncertainty: 0,
      contradiction: 0,
      urgency: 1,
    },
  });
  assert.equal(expectedAdvance.status, 'accepted');
  assert.ok(Math.abs(p2.reassessment - expectedAdvance.state.reassessment) < 1e-12);
  assert.ok(Math.abs(p2.stability - expectedAdvance.state.stability) < 1e-12);
  assert.equal(p2.reassessment_active, expectedAdvance.state.reassessment_active);
  assert.equal(diskSnap2.task_count, 3);

  // Session 3: another negative turn -> verify reassessment rises & journal records task_count=4
  let clk3 = clk2 + 2000;
  const hook3 = createShadowHook({ dir, now: () => (clk3 += 1000), uuid: makeUuid(9000) });
  try {
    const t4 = hook3.start({ worker: null }, { features: { urgency: 1, contradiction: 1 } });
    t4.complete({ verified: true, utility: -1 });
    await hook3.flush();

    const j3 = await openRotatingJournal(dir);
    let diskSnap3;
    try {
      diskSnap3 = j3.snapshot();
    } finally {
      await j3.close();
    }
    const p3 = hook3.peekChannels(clk3 + 1000, { urgency: 0, contradiction: 0 });
    assert.ok(p3);
    assert.equal(diskSnap3.task_count, 4);
    assert.ok(p3.reassessment >= 0.45);
  } finally {
    await hook3.close();
  }
});

test('Tor quarantine (chatTainted after cooldown expires) blocks verdict -> onVerdict/recordOutcome and marks mid-turn cancellation', async () => {
  const dir = mkDir();
  let clock = Date.UTC(2026, 10, 18, 13, 0, 0);
  const torState = createTorState({ now: () => clock });
  const policy = createReassessmentPolicy({ now: () => clock });
  const outcomes = [];

  const hook = createShadowHook({
    dir,
    now: () => clock,
    uuid: makeUuid(10000),
    isTorActive: () => torState.isQuarantined(),
    onVerdict: (meta, verdict) => {
      outcomes.push({ meta, verdict });
      policy.recordOutcome({ escalated: Boolean(meta?.escalated), verdict });
    },
  });
  const glue = createChatGlue({
    getHook: () => hook,
    tor,
    isTorBlocked: () => torState.isQuarantined(),
    isLocalModel: () => true,
  });
  const cfg = { brainShadow: true, brainInfluence: 'reassessment', provider: 'ollama', rp: false };

  try {
    // Mid-turn Tor activation marks shadowTurn.wasTorCancelled() === true
    const midTurn = glue.startLocal({ worker: null }, [{ role: 'user', content: 'вопрос' }], cfg, new AbortController().signal, {
      meta: { escalated: true },
    });
    assert.equal(midTurn.wasTorCancelled(), false);
    torState.touch({ inChat: true });
    hook.torTouched();
    assert.equal(midTurn.wasTorCancelled(), true);

    // Advance clock PAST cooldown expiry in the SAME chat: inCooldown() === false, chatTainted === true -> isQuarantined() === true
    clock += TOR_COOLDOWN_MS + 60_000;
    assert.equal(torState.inCooldown(), false);
    assert.equal(torState.isChatTainted(), true);
    assert.equal(torState.isQuarantined(), true);

    // Clearnet phrasing in tainted chat after cooldown: must NOT start turn or deliver verdict to onVerdict / recordOutcome
    assert.deepEqual(planInfluence({
      cfg,
      said: 'нет, неверно',
      messages: [{ role: 'user', content: 'нет, неверно' }],
      hook,
      policy,
      env: { local: true, brainsReady: true, isAuto: true, tor: torState.isQuarantined(), now: clock },
      tor,
    }), { main: false, hint: null, decision: null, escalated: false });

    const blockedTurn = glue.startLocal({ worker: null }, [{ role: 'user', content: 'проверь' }], cfg, new AbortController().signal, {
      meta: { escalated: true },
    });
    glue.afterSuccess(blockedTurn);
    assert.equal(hook.verdict(1), false);
    glue.beforeTurn([{ role: 'user', content: 'да, верно' }], cfg);
    glue.afterTurn(cfg);
    await hook.flush();

    assert.equal(outcomes.length, 0);
    assert.equal(policy.stats().base_pos, 0);
    assert.equal(policy.stats().esc_pos, 0);
    assert.equal(hook.stats().published, 0);
  } finally {
    await hook.close();
  }
});

test('non-ollama / non-local turns get neutral planInfluence, stripBrainHints + llm.chat strip brainHint before OpenAI and Claude', async () => {
  const clock = Date.UTC(2026, 10, 18, 14, 0, 0);
  const policy = createReassessmentPolicy({ now: () => clock });
  const hotHook = {
    peekChannels: () => ({ reassessment: 0.9, reassessment_active: 1, stability: 1, circadian_quiet: 0 }),
  };

  // (a) Non-ollama providers or local=false must stay strictly neutral without spending stop_hint_count
  for (const [cfg, env] of [
    [{ brainShadow: true, brainInfluence: 'reassessment', provider: 'claude' }, { local: false, brainsReady: true, isAuto: true, now: clock }],
    [{ brainShadow: true, brainInfluence: 'reassessment', provider: 'openai' }, { local: false, brainsReady: true, isAuto: true, now: clock }],
    [{ brainShadow: true, brainInfluence: 'reassessment', provider: 'ollama' }, { local: false, brainsReady: true, isAuto: true, now: clock }],
  ]) {
    const res = planInfluence({
      cfg,
      said: 'нет, ошибка в коде',
      messages: [{ role: 'user', content: 'нет, ошибка в коде' }],
      hook: hotHook,
      policy,
      env,
      tor,
    });
    assert.deepEqual(res, { main: false, hint: null, decision: null, escalated: false });
  }
  assert.equal(policy.stats().trigger_episodes, 0);
  assert.equal(policy.stats().stop_hint_count, 0);

  // (b) stripBrainHints leaves regular system/user messages intact and drops only brainHint: true
  const rawMsgs = [
    { role: 'system', content: 'персона' },
    { role: 'user', content: 'привет, объясни кратко' },
    { role: 'system', content: STOP_HINT_TEXT, brainHint: true },
  ];
  const stripped = stripBrainHints(rawMsgs);
  assert.deepEqual(stripped, [
    { role: 'system', content: 'персона' },
    { role: 'user', content: 'привет, объясни кратко' },
  ]);

  // (c) llm.chat filters brainHint for non-ollama (OpenAI-compatible & Claude Code stdin never see brainHint)
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const cp = require('node:child_process');
  const llmPath = require.resolve('../src/main/llm');
  const origFetch = globalThis.fetch;
  const origSpawn = cp.spawn;
  const prevCached = require.cache[llmPath];
  delete require.cache[llmPath];

  let seenOpenAiBody = null;
  let seenClaudeStdin = '';
  try {
    globalThis.fetch = async (_url, init) => {
      seenOpenAiBody = JSON.parse(init.body);
      const sse = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ок"}}]}\n\ndata: [DONE]\n\n'));
          ctrl.close();
        },
      });
      return new Response(sse, { status: 200 });
    };
    cp.spawn = () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin.on('data', (d) => { seenClaudeStdin += d.toString('utf8'); });
      child.stdin.on('end', () => {
        child.stdout.write(JSON.stringify({ type: 'result', result: 'ответ клода' }) + '\n');
        child.stdout.end();
        child.emit('close', 0);
      });
      return child;
    };

    const freshLlm = require('../src/main/llm');
    await freshLlm.chat('openai', { apiKeys: { openai: 'sk-test' } }, {
      model: 'gpt-4o',
      messages: rawMsgs,
    }, () => {}, new AbortController().signal);
    assert.deepEqual(seenOpenAiBody.messages, stripped);

    await freshLlm.chat('claude', {}, {
      model: 'Claude Code',
      messages: rawMsgs,
    }, () => {}, new AbortController().signal);
    assert.equal(seenClaudeStdin, 'привет, объясни кратко');
    assert.equal(seenClaudeStdin.includes(STOP_HINT_TEXT), false);
  } finally {
    globalThis.fetch = origFetch;
    cp.spawn = origSpawn;
    delete require.cache[llmPath];
    if (prevCached) require.cache[llmPath] = prevCached;
  }
});

test('analysisMode feeds wantsMain into planInfluence -> user_main without spending budget', () => {
  const clock = Date.UTC(2026, 10, 18, 15, 0, 0);
  const policy = createReassessmentPolicy({ now: () => clock });
  const hotHook = {
    peekChannels: () => ({ reassessment: 0.72, reassessment_active: 1, stability: 1, circadian_quiet: 0 }),
  };
  const said = 'разбери документ подробно, нет, там ошибка';
  const cfg = { brainShadow: true, brainInfluence: 'reassessment', provider: 'ollama', rp: false };
  const analysis = brainsLib.analysisMode(cfg, { rolesReady: true, auto: true, tor: false, text: said });
  assert.equal(analysis.active, true);

  const res = planInfluence({
    cfg,
    said,
    messages: [{ role: 'user', content: said }],
    hook: hotHook,
    policy,
    env: {
      local: true,
      brainsReady: true,
      isAuto: true,
      mainActive: false,
      gpuBusy: false,
      wantsFast: brainsLib.wantsFast(said),
      wantsMain: brainsLib.wantsMain(said) || analysis.active,
      wantsLocal: brainsLib.wantsLocal(said),
      now: clock,
    },
    tor,
  });

  assert.equal(res.main, false);
  assert.equal(res.hint, null);
  assert.equal(res.escalated, false);
  assert.equal(res.decision?.action, 'none');
  assert.equal(res.decision?.reason, 'user_main');
  assert.equal(policy.stats().escalation_count, 0);
  assert.equal(policy.stats().budgetLeft, 2);
});

test('shadowHook preload readiness (null before cold load -> journal state after, empty ready) and write-failure invalidation', async () => {
  const baseTime = Date.UTC(2026, 10, 18, 16, 0, 0);

  // 1. Existing non-empty journal: cold preload starts null, loads exportCheckpoint() asynchronously
  const dirNonEmpty = mkDir();
  let clk1 = baseTime;
  const seedHook = createShadowHook({ dir: dirNonEmpty, now: () => (clk1 += 2000), uuid: makeUuid(11000) });
  for (let i = 0; i < 2; i++) {
    const t = seedHook.start({ worker: null }, { features: { urgency: 1, contradiction: 1 } });
    t.complete({ verified: true, utility: -1 });
  }
  await seedHook.close();

  const coldHook = createShadowHook({ dir: dirNonEmpty, preload: true, now: () => clk1 + 1000, uuid: makeUuid(12000) });
  try {
    assert.equal(coldHook.peekChannels(clk1 + 1000, { urgency: 1, contradiction: 0 }), null);
    await coldHook.flush();
    const loaded = coldHook.peekChannels(clk1 + 1000, { urgency: 1, contradiction: 0 });
    assert.ok(loaded);
    assert.ok(loaded.reassessment >= 0.45);
  } finally {
    await coldHook.close();
  }

  // 2. Empty directory with preload=true starts null, becomes ready after flush
  const emptyDir = mkDir();
  const emptyHook = createShadowHook({ dir: emptyDir, preload: true, now: () => baseTime, uuid: makeUuid(13000) });
  try {
    assert.equal(emptyHook.peekChannels(baseTime, { urgency: 0 }), null);
    await emptyHook.flush();
    const readyEmpty = emptyHook.peekChannels(baseTime, { urgency: 0 });
    assert.ok(readyEmpty);
    assert.equal(readyEmpty.reassessment, 0);
  } finally {
    await emptyHook.close();
  }

  // 3. Failed/rejected batch resets ready=false (peekChannels -> null) until next successful write rebuilds memCore
  let writeAttempt = 0;
  let coreFromDisk = createShadow();
  const mockJournal = {
    snapshot: () => coreFromDisk.snapshot(),
    exportCheckpoint: () => coreFromDisk.exportCheckpoint(),
    appendBatch: async (envs) => {
      writeAttempt++;
      if (writeAttempt === 1) throw new Error('disk EIO');
      if (writeAttempt === 2) return { status: 'rejected' };
      for (const env of envs) coreFromDisk.ingest(env);
      return { status: 'accepted', state: coreFromDisk.snapshot() };
    },
    close: async () => {},
  };

  let clkFail = baseTime;
  const failHook = createShadowHook({
    dir: mkDir(),
    preload: true,
    openJournal: async () => mockJournal,
    now: () => (clkFail += 1000),
    uuid: makeUuid(14000),
  });
  try {
    await failHook.flush();
    assert.ok(failHook.peekChannels(clkFail + 1000, { urgency: 0 }));

    // Attempt 1 throws -> ready becomes false, peekChannels returns null
    failHook.start({ worker: null }, { features: { urgency: 1, contradiction: 1 } }).complete({ verified: true, utility: -1 });
    await failHook.flush();
    assert.equal(failHook.peekChannels(clkFail + 1000, { urgency: 0 }), null);

    // Attempt 2 returns rejected -> still null
    failHook.start({ worker: null }, { features: { urgency: 1, contradiction: 1 } }).complete({ verified: true, utility: -1 });
    await failHook.flush();
    assert.equal(failHook.peekChannels(clkFail + 1000, { urgency: 0 }), null);

    // Attempt 3 succeeds with pendingWrites === 1 -> memCore rebuilds cleanly from exportCheckpoint() -> ready true
    failHook.start({ worker: null }, { features: { urgency: 1, contradiction: 1 } }).complete({ verified: true, utility: -1 });
    await failHook.flush();
    const recovered = failHook.peekChannels(clkFail + 1000, { urgency: 0, contradiction: 0 });
    assert.ok(recovered);
    assert.ok(recovered.reassessment < 0.65); // only Attempt 3 is in disk core, NOT failed Attempts 1 & 2!
  } finally {
    await failHook.close();
  }
});

test('planInfluence forwards env.voice into policy.decide ctx and blocks cold voice escalation', () => {
  const clock = Date.UTC(2026, 10, 18, 12, 0, 0);
  const hotHook = {
    peekChannels: () => ({ reassessment: 0.72, reassessment_active: 1, stability: 0.9, circadian_quiet: 0 }),
  };
  const cfg = { brainShadow: true, brainInfluence: 'reassessment', provider: 'ollama' };
  const said = 'нет, ты ошиблась, проверь ещё раз';

  let seenVoice;
  const spyPolicy = {
    decide(arg) {
      seenVoice = arg.ctx.voice;
      return { action: 'none', reason: 'voice_cold', evc: 0.3, budgetLeft: 2 };
    },
  };
  planInfluence({
    cfg,
    said,
    messages: [{ role: 'user', content: said }],
    hook: hotHook,
    policy: spyPolicy,
    env: { local: true, brainsReady: true, isAuto: true, mainActive: false, voice: true, now: clock },
    tor,
  });
  assert.equal(seenVoice, true);

  const policy = createReassessmentPolicy({ now: () => clock });
  const coldVoice = planInfluence({
    cfg,
    said,
    messages: [{ role: 'user', content: said }],
    hook: hotHook,
    policy,
    env: { local: true, brainsReady: true, isAuto: true, mainActive: false, voice: true, now: clock },
    tor,
  });
  assert.equal(coldVoice.main, false);
  assert.equal(coldVoice.escalated, false);
  assert.equal(coldVoice.decision?.reason, 'voice_cold');
  assert.equal(policy.stats().escalation_count, 0);

  const hotVoice = planInfluence({
    cfg,
    said,
    messages: [{ role: 'user', content: said }],
    hook: hotHook,
    policy,
    env: { local: true, brainsReady: true, isAuto: true, mainActive: true, voice: true, now: clock },
    tor,
  });
  assert.equal(hotVoice.main, true);
  assert.equal(hotVoice.escalated, true);
  assert.equal(policy.stats().escalation_count, 0);
  assert.equal(commitInfluence(policy, hotVoice), true);
  assert.equal(policy.stats().escalation_count, 1);
});

test('P2-1: chatTainted blocks tainted chat without extending cooldown across chats:new', async () => {
  const dir = mkDir();
  let clock = Date.UTC(2026, 10, 18, 17, 0, 0);
  const torState = createTorState({ now: () => clock });
  const hook = createShadowHook({
    dir,
    now: () => clock,
    uuid: makeUuid(15000),
    isTorActive: () => torState.inCooldown(),
    isChatTainted: () => torState.isChatTainted(),
  });
  const glue = createChatGlue({
    getHook: () => hook,
    tor,
    isTorBlocked: () => torState.inCooldown(),
    isChatTainted: () => torState.isChatTainted(),
    isLocalModel: () => true,
  });
  const cfg = { brainShadow: true, provider: 'ollama', rp: false };

  try {
    // 1. Tor touch at t=0 -> both cooldown and chatTainted active
    torState.touch({ inChat: true });
    hook.torTouched();

    // 2. Advance 15 min (> 10m cooldown) while still in same tainted chat
    clock += TOR_COOLDOWN_MS + 5 * 60 * 1000;
    assert.equal(torState.inCooldown(), false);
    assert.equal(torState.isChatTainted(), true);

    // Clearnet turn in tainted chat sees null peekChannels and does not start, WITHOUT extending lastTorAt
    assert.equal(hook.peekChannels(clock, { urgency: 1 }), null);
    glue.beforeTurn([{ role: 'user', content: 'обычный вопрос' }], cfg);
    assert.equal(glue.startLocal({ worker: null }, [{ role: 'user', content: 'ещё вопрос' }], cfg, new AbortController().signal), null);
    await hook.flush();
    assert.equal(hook.stats().published, 0);

    // 3. Reset chat (chats:new) 5s later -> clean chat is IMMEDIATELY observable without waiting another 10m!
    clock += 5000;
    torState.resetChat();
    assert.equal(torState.isQuarantined(), false);
    assert.equal(hook.isTorBlocked(), false);
    assert.ok(hook.peekChannels(clock, { urgency: 0 }));

    const cleanTurn = glue.startLocal({ worker: null }, [{ role: 'user', content: 'привет в новом чате' }], cfg, new AbortController().signal);
    cleanTurn.complete({ verified: true, utility: 1 });
    await hook.flush();
    assert.equal(hook.stats().published, 1);
  } finally {
    await hook.close();
  }
});

test('P2-2: preload racing with queued write & concurrent batch failure resync memCore accurately from exportCheckpoint', async () => {
  const baseTime = Date.UTC(2026, 10, 18, 18, 0, 0);

  // Scenario A: write queued before delayed cold preload finishes -> preload must not clobber batch1
  const dirA = mkDir();
  let clkA = baseTime;
  const seed = createShadowHook({ dir: dirA, now: () => (clkA += 1000), uuid: makeUuid(16000) });
  seed.start({ worker: null }, { features: { urgency: 1, contradiction: 0 } }).complete({ verified: true, utility: -1 });
  await seed.close();

  const seedCheck = await openRotatingJournal(dirA);
  try {
    assert.equal(seedCheck.snapshot().task_count, 1);
  } finally {
    await seedCheck.close();
  }
  let openEnteredResolve;
  const openEntered = new Promise((r) => { openEnteredResolve = r; });
  let releaseOpen;
  const hookA = createShadowHook({
    dir: dirA,
    preload: true,
    openJournal: async () => {
      openEnteredResolve();
      await new Promise((r) => { releaseOpen = r; });
      return openRotatingJournal(dirA);
    },
    now: () => (clkA += 1000),
    uuid: makeUuid(17000),
  });
  try {
    await openEntered;
    // Queue batch1 while preload open is still pending
    const t1 = hookA.start({ worker: null }, { features: { urgency: 1, contradiction: 1 } });
    t1.complete({ verified: true, utility: -1 });
    assert.equal(hookA.peekChannels(clkA + 1000, { urgency: 0 }), null);

    releaseOpen();
    await hookA.flush();
    const peekA = hookA.peekChannels(clkA + 1000, { urgency: 0 });
    assert.ok(peekA);
    // Must include BOTH preexisting negative turn AND queued batch1 (> 0.45 -> ~0.70, not just single ~0.45)
    assert.ok(peekA.reassessment >= 0.65);
  } finally {
    releaseOpen?.();
    await hookA.close();
  }
  const diskAfterA = await openRotatingJournal(dirA);
  try {
    assert.equal(diskAfterA.snapshot().task_count, 2);
  } finally {
    await diskAfterA.close();
  }

  // Scenario B: concurrent batch1 (fails) + batch2 (succeeds) while queued together -> stays null until batch2 rebuilds from exportCheckpoint
  let attempt = 0;
  let diskCoreB = createShadow();
  let write1EnteredResolve;
  const write1Entered = new Promise((r) => { write1EnteredResolve = r; });
  let write2EnteredResolve;
  const write2Entered = new Promise((r) => { write2EnteredResolve = r; });
  let releaseWrite1;
  let releaseWrite2;
  const jB = {
    snapshot: () => diskCoreB.snapshot(),
    exportCheckpoint: () => diskCoreB.exportCheckpoint(),
    appendBatch: async (envs) => {
      attempt++;
      if (attempt === 1) {
        write1EnteredResolve();
        await new Promise((r) => { releaseWrite1 = r; });
        throw new Error('batch1 EIO');
      }
      if (attempt === 2) {
        write2EnteredResolve();
        await new Promise((r) => { releaseWrite2 = r; });
      }
      for (const env of envs) diskCoreB.ingest(env);
      return { status: 'accepted', state: diskCoreB.snapshot() };
    },
    close: async () => {},
  };
  let clkB = baseTime;
  const hookB = createShadowHook({
    dir: mkDir(),
    preload: true,
    openJournal: async () => jB,
    now: () => (clkB += 1000),
    uuid: makeUuid(18000),
  });
  try {
    await hookB.flush();
    assert.ok(hookB.peekChannels(clkB + 1000, { urgency: 0 }));

    hookB.start({ worker: null }, { features: { urgency: 1, contradiction: 1 } }).complete({ verified: true, utility: -1 });
    hookB.start({ worker: null }, { features: { urgency: 0, contradiction: 0 } }).complete({ verified: true, utility: 1 });
    await write1Entered;
    releaseWrite1();
    await write2Entered;
    // Right after batch1 failed and before batch2 commits: memReady must be false -> peekChannels === null!
    assert.equal(hookB.peekChannels(clkB + 1000, { urgency: 0 }), null);
    releaseWrite2();
    await hookB.flush();

    const peekB = hookB.peekChannels(clkB + 1000, { urgency: 0 });
    assert.ok(peekB);
    // Only batch2 (utility: +1) reached disk; failed batch1 (-1, urgency: 1) must NOT linger in memCore
    assert.equal(peekB.reassessment, 0);
  } finally {
    releaseWrite1?.();
    releaseWrite2?.();
    await hookB.close();
  }
});

test('P1-1: shouldSkipChatPersistence blocks vault/notes on quarantined state or string/array Tor messages', () => {
  let clock = 1_000_000;
  const torState = createTorState({ now: () => clock });
  const onionMsg = 'http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion/';

  assert.equal(shouldSkipChatPersistence({
    torState,
    messages: [{ role: 'user', content: 'привет' }, { role: 'assistant', content: 'привет' }],
    tor,
  }), false);

  // Bare .onion without search verb & multimodal array content -> skip
  assert.equal(shouldSkipChatPersistence({
    torState,
    messages: [{ role: 'user', content: `почему не открывается ${onionMsg}` }],
    tor,
  }), true);
  assert.equal(shouldSkipChatPersistence({
    torState,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'вот цитата из даркнета' }] }],
    tor,
  }), true);

  // Quarantined chat -> skips even ordinary clearnet messages
  torState.touch({ inChat: true });
  clock += TOR_COOLDOWN_MS + 60_000;
  assert.equal(shouldSkipChatPersistence({
    torState,
    messages: [{ role: 'user', content: 'обычный вопрос' }],
    tor,
  }), true);
});

test('Sol final: llm.chat strips brainHint on Ollama cloud model, keeps it on local Ollama', async () => {
  const ollama = require('../src/main/ollama');
  const llm = require('../src/main/llm');
  const origFetch = globalThis.fetch;
  const seenBodies = [];
  const rawMsgs = [
    { role: 'system', content: 'персона' },
    { role: 'user', content: 'вопрос' },
    { role: 'system', content: STOP_HINT_TEXT, brainHint: true },
  ];
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/api/chat')) {
        seenBodies.push(JSON.parse(init.body));
        const ndjson = new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: 'ок' }, done: true }) + '\n'));
            ctrl.close();
          },
        });
        return new Response(ndjson, { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    assert.equal(ollama.isCloud('beam:cloud'), true);
    await llm.chat('ollama', {}, { model: 'beam:cloud', messages: rawMsgs }, () => {}, new AbortController().signal);
    assert.equal(seenBodies[0].messages.some((m) => m.brainHint), false);
    assert.equal(seenBodies[0].messages.length, 2);

    await llm.chat('ollama', {}, { model: 'gemma4:e4b-local', messages: rawMsgs }, () => {}, new AbortController().signal);
    assert.equal(seenBodies[1].messages.some((m) => m.brainHint), true);
    assert.equal(seenBodies[1].messages.length, 3);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Sol final: judge blocks during Tor quarantine, rechecks isBusy after /api/ps, and hook.close does not hang when callModel ignores abort', async () => {
  const dir = mkDir();
  let clock = Date.UTC(2026, 10, 18, 19, 0, 0);
  let quarantined = false;
  let judgeCalls = 0;

  // 1. In-flight callModel ignores AbortSignal -> close() must still resolve within ~timeout+1s via judgeChain Promise.race
  const hangingJudge = createVerdictJudge({
    timeoutMs: 25,
    mainTimeoutMs: 25,
    maxPerMinute: 100,
    callModel: () => {
      judgeCalls++;
      return new Promise(() => {}); // ignores abort signal completely
    },
  });
  const hook = createShadowHook({
    dir,
    now: () => clock,
    uuid: makeUuid(19000),
    isTorActive: () => quarantined,
    verdictJudge: hangingJudge,
  });
  const glue = createChatGlue({ getHook: () => hook, tor, isLocalModel: () => true });
  const cfg = { brainShadow: true, brainVerdictJudge: 'shadow', provider: 'ollama', rp: false };

  const t1 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'вопрос 1' }], cfg, new AbortController().signal);
  glue.afterSuccess(t1);
  glue.beforeTurn([{ role: 'user', content: 'ну норм' }], cfg);
  glue.afterTurn(cfg); // starts judge in judgeChain
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(judgeCalls, 1);

  const t0 = Date.now();
  await hook.close();
  assert.ok(Date.now() - t0 < 2500);

  // 2. Tor quarantine prevents runDeferredJudge from calling judge at all
  let torJudgeCalls = 0;
  const hookTor = createShadowHook({
    dir: mkDir(),
    now: () => clock,
    uuid: makeUuid(20000),
    isTorActive: () => quarantined,
    verdictJudge: createVerdictJudge({
      maxPerMinute: 100,
      callModel: async () => { torJudgeCalls++; return '{"v":"PLUS"}'; },
    }),
  });
  const glueTor = createChatGlue({ getHook: () => hookTor, tor, isLocalModel: () => true });
  glueTor.afterSuccess(glueTor.startLocal({ worker: null }, [{ role: 'user', content: 'раз' }], cfg, new AbortController().signal));
  glueTor.beforeTurn([{ role: 'user', content: 'ну вроде норм' }], cfg);
  quarantined = true;
  glueTor.afterTurn(cfg);
  await hookTor.close();
  assert.equal(torJudgeCalls, 0);

  // 3. Busy turning true DURING await /api/ps prevents judge callModel cleanly
  let busyNow = false;
  let releasePs;
  let busyCallCount = 0;
  const busyJudge = createVerdictJudge({
    isBusy: () => busyNow,
    resolveModel: async () => new Promise((r) => { releasePs = r; }),
    callModel: async () => { busyCallCount++; return '{"v":"PLUS"}'; },
  });
  const pendingJudge = busyJudge.judge('ну вот норм');
  await new Promise((r) => setTimeout(r, 5));
  busyNow = true;
  releasePs('gemma4:e4b');
  const res = await pendingJudge;
  assert.deepEqual(res, { status: 'skipped_busy', verdict: null, model: null });
  assert.equal(busyCallCount, 0);
});

test('Sol final: peekChannels during an in-flight write that rejects never exposes unconfirmed packet and flips to null on reject', async () => {
  const baseTime = Date.UTC(2026, 10, 18, 20, 0, 0);
  let diskCore = createShadow();
  let enteredResolve;
  const entered = new Promise((r) => { enteredResolve = r; });
  let releaseAppend;
  let mode = 'accept';

  const hook = createShadowHook({
    dir: mkDir(),
    preload: true,
    openJournal: async () => ({
      snapshot: () => diskCore.snapshot(),
      exportCheckpoint: () => diskCore.exportCheckpoint(),
      appendBatch: async (envs) => {
        if (mode === 'reject_paused') {
          enteredResolve();
          await new Promise((r) => { releaseAppend = r; });
          return { status: 'rejected' };
        }
        for (const env of envs) diskCore.ingest(env);
        return { status: 'accepted', state: diskCore.snapshot() };
      },
      close: async () => {},
    }),
    now: () => baseTime,
    uuid: makeUuid(21000),
  });

  try {
    await hook.flush();
    // Seed 1 confirmed negative turn (~0.45 reassessment)
    hook.start({ worker: null }, { features: { urgency: 1, contradiction: 1 } }).complete({ verified: true, utility: -1 });
    await hook.flush();
    const initial = hook.peekChannels(baseTime, { urgency: 0, contradiction: 0 });
    assert.ok(initial);
    assert.ok(initial.reassessment >= 0.44 && initial.reassessment < 0.65);

    // Start 2nd negative turn whose write is paused in flight and will reject (would have crossed 0.65 if exposed)
    mode = 'reject_paused';
    hook.start({ worker: null }, { features: { urgency: 1, contradiction: 1 } }).complete({ verified: true, utility: -1 });
    await entered;

    // While write is in flight BEFORE rejection: projection uses last confirmed checkpoint ONLY (never sees rejected packet!)
    const duringWrite = hook.peekChannels(baseTime + 1000, { urgency: 0, contradiction: 0 });
    assert.ok(duringWrite);
    assert.ok(duringWrite.reassessment < 0.65);

    releaseAppend();
    await hook.flush();
    // After rejection: memReady is false -> null
    assert.equal(hook.peekChannels(baseTime + 1000, { urgency: 0, contradiction: 0 }), null);

    // Next valid confirmed write restores confirmed checkpoint cleanly (initial + turn 3 -> >= 0.65)
    mode = 'accept';
    hook.start({ worker: null }, { features: { urgency: 1, contradiction: 1 } }).complete({ verified: true, utility: -1 });
    await hook.flush();
    const afterConfirm = hook.peekChannels(baseTime + 2000, { urgency: 0, contradiction: 0 });
    assert.ok(afterConfirm);
    assert.ok(afterConfirm.reassessment >= 0.65);
    assert.equal(diskCore.snapshot().record_count, 4);
  } finally {
    releaseAppend?.();
    await hook.close();
  }
});

test('A/B day schedule: UTC+5 boundary (23:59 vs 00:00), parity from start date, invalid start date -> off', () => {
  const abCfg = { brainInfluence: 'ab', brainInfluenceAbStart: '2026-11-18' };

  // 2026-11-18 23:59:59.999 UTC+5 == 2026-11-18 18:59:59.999 UTC -> day 0 (even) -> B / reassessment
  const beforeMidnightUtc5 = Date.UTC(2026, 10, 18, 18, 59, 59, 999);
  // 2026-11-19 00:00:00.000 UTC+5 == 2026-11-18 19:00:00.000 UTC -> day 1 (odd) -> A / off
  const atMidnightUtc5 = Date.UTC(2026, 10, 18, 19, 0, 0, 0);

  assert.equal(utc5DayInfo(beforeMidnightUtc5).day, '2026-11-18');
  assert.equal(utc5DayInfo(atMidnightUtc5).day, '2026-11-19');

  assert.deepEqual(resolveInfluenceAb(abCfg, beforeMidnightUtc5), {
    mode: 'reassessment',
    ab_group: 'B',
    ab_day: '2026-11-18',
  });
  assert.deepEqual(resolveInfluenceAb(abCfg, atMidnightUtc5), {
    mode: 'off',
    ab_group: 'A',
    ab_day: '2026-11-19',
  });
  assert.equal(effectiveInfluenceMode(abCfg, beforeMidnightUtc5), 'reassessment');
  assert.equal(effectiveInfluenceMode(abCfg, atMidnightUtc5), 'off');

  // Parity across consecutive UTC+5 days: day +2 -> B (reassessment), day +3 -> A (off)
  const dayPlus2 = Date.UTC(2026, 10, 20, 7, 0, 0, 0); // 12:00 UTC+5 on 2026-11-20
  const dayPlus3 = Date.UTC(2026, 10, 21, 7, 0, 0, 0); // 12:00 UTC+5 on 2026-11-21
  assert.deepEqual(resolveInfluenceAb(abCfg, dayPlus2), { mode: 'reassessment', ab_group: 'B', ab_day: '2026-11-20' });
  assert.deepEqual(resolveInfluenceAb(abCfg, dayPlus3), { mode: 'off', ab_group: 'A', ab_day: '2026-11-21' });

  // Fixed modes keep ab_group=null while reporting ab_day
  assert.deepEqual(resolveInfluenceAb({ brainInfluence: 'off', brainInfluenceAbStart: '2026-11-18' }, beforeMidnightUtc5), {
    mode: 'off',
    ab_group: null,
    ab_day: '2026-11-18',
  });
  assert.deepEqual(resolveInfluenceAb({ brainInfluence: 'reassessment', brainInfluenceAbStart: '2026-11-18' }, atMidnightUtc5), {
    mode: 'reassessment',
    ab_group: null,
    ab_day: '2026-11-19',
  });

  // Invalid / missing start dates fail closed to off + ab_group: null
  for (const badStart of ['', 'bad-date', '2026-02-30', '2026-13-01', '2026/11/18', null, undefined, 12345]) {
    const res = resolveInfluenceAb({ brainInfluence: 'ab', brainInfluenceAbStart: badStart }, beforeMidnightUtc5);
    assert.equal(res.mode, 'off');
    assert.equal(res.ab_group, null);
  }
});

test('A/B mode drives planInfluence and tags policy.stats() with ab_group and ab_day', () => {
  let clock = Date.UTC(2026, 10, 18, 12, 0, 0); // 2026-11-18 17:00 UTC+5 -> B (reassessment)
  const cfg = {
    brainShadow: true,
    brainInfluence: 'ab',
    brainInfluenceAbStart: '2026-11-18',
    provider: 'ollama',
  };
  const policy = createReassessmentPolicy({ now: () => clock, getConfig: () => cfg });
  const hotHook = {
    peekChannels: () => ({ reassessment: 0.72, reassessment_active: 1, stability: 0.9, circadian_quiet: 0 }),
  };

  // B-day (2026-11-18): effective mode = reassessment -> escalates
  const dayB = planInfluence({
    cfg,
    said: 'нет, ты ошиблась, проверь ещё раз',
    messages: [{ role: 'user', content: 'нет, ты ошиблась, проверь ещё раз' }],
    hook: hotHook,
    policy,
    env: { local: true, brainsReady: true, isAuto: true, mainActive: false, now: clock },
    tor,
  });
  assert.equal(dayB.main, true);
  assert.equal(dayB.escalated, true);
  let st = policy.stats();
  assert.equal(st.ab_group, 'B');
  assert.equal(st.ab_day, '2026-11-18');
  assert.equal(st.trigger_episodes, 1);
  assert.equal(st.shadow_trigger_episodes, 0);

  // Next day in UTC+5 (2026-11-19): effective mode = off -> neutral main/hint, increments shadow_* counters
  clock = Date.UTC(2026, 10, 19, 12, 0, 0);
  const dayA = planInfluence({
    cfg,
    said: 'нет, ты ошиблась, проверь ещё раз',
    messages: [{ role: 'user', content: 'нет, ты ошиблась, проверь ещё раз' }],
    hook: hotHook,
    policy,
    env: { local: true, brainsReady: true, isAuto: true, mainActive: false, now: clock },
    tor,
  });
  assert.equal(dayA.main, false);
  assert.equal(dayA.hint, null);
  assert.equal(dayA.escalated, false);
  st = policy.stats();
  assert.equal(st.ab_group, 'A');
  assert.equal(st.ab_day, '2026-11-19');
  assert.equal(st.shadow_trigger_episodes, 1);
  assert.equal(st.shadow_escalate, 1);
});
