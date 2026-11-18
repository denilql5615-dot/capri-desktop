'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planInfluence, stripBrainHints } = require('../src/main/brain/influence-glue');
const { createReassessmentPolicy, STOP_HINT_TEXT } = require('../src/main/brain/reassessment-policy');
const { createShadowHook, TOR_COOLDOWN_MS } = require('../src/main/brain/shadow-hook');
const { createChatGlue } = require('../src/main/brain/chat-glue');
const { openRotatingJournal } = require('../src/main/brain/rotating-journal');
const { createVerdictJudge } = require('../src/main/brain/verdict-judge');
const { createShadow, CONFIG } = require('../src/main/brain/index');
const { salience } = require('../src/main/brain/amygdala');
const { createTorState } = require('../src/main/tor-guard');
const brainsLib = require('../src/main/brains');
const tor = require('../src/main/tor');

const mkDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-inf-')), 'brain-journal');

function makeUuid(prefix = 3000) {
  let n = prefix;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

test('config default keeps brainInfluence off', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/config.js'), 'utf8');
  assert.match(src, /brainInfluence:\s*'off'/);
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

test('planInfluence: reassessment + channel 0.7 + contradiction escalates to main=true and consumes budget', () => {
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
  assert.equal(policy.stats().escalation_count, 1);
  assert.equal(policy.stats().budgetLeft, 1);
});

test('planInfluence: overload yields STOP_HINT_TEXT once per active series, then null', () => {
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

  const second = call();
  assert.equal(second.main, false);
  assert.equal(second.escalated, false);
  assert.equal(second.hint, null);
  assert.equal(policy.stats().stop_report_count, 2);
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
