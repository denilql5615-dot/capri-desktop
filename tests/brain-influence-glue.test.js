'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { planInfluence } = require('../src/main/brain/influence-glue');
const { createReassessmentPolicy, STOP_HINT_TEXT } = require('../src/main/brain/reassessment-policy');
const { createShadowHook } = require('../src/main/brain/shadow-hook');
const { createChatGlue } = require('../src/main/brain/chat-glue');
const { openRotatingJournal } = require('../src/main/brain/rotating-journal');
const { createVerdictJudge } = require('../src/main/brain/verdict-judge');
const { createShadow, CONFIG } = require('../src/main/brain/index');
const { salience } = require('../src/main/brain/amygdala');
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
    cfg: { brainShadow: true, brainInfluence: 'off' },
    said: 'нет, не сработало',
    messages: [{ role: 'user', content: 'нет, не сработало' }],
    hook: fakeHook,
    policy,
    env: { brainsReady: true, isAuto: true, mainActive: false, now: clock },
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
    cfg: { brainShadow: true, brainInfluence: 'reassessment' },
    said: 'нет, ты ошиблась в этом расчёте',
    messages: [{ role: 'user', content: 'нет, ты ошиблась в этом расчёте' }],
    hook: fakeHook,
    policy,
    env: { brainsReady: true, isAuto: true, mainActive: false, now: clock },
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
    cfg: { brainShadow: true, brainInfluence: 'reassessment' },
    said: 'нет, опять ошибка в ответе',
    messages: [{ role: 'user', content: 'нет, опять ошибка в ответе' }],
    hook: fakeHook,
    policy,
    env: { brainsReady: true, isAuto: true, now: clock },
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
    cfg: { brainShadow: true, brainInfluence: 'reassessment' },
    said: 'нет, это не то',
    messages: [{ role: 'user', content: 'найди через тор' }, { role: 'user', content: 'нет, это не то' }],
    hook: hotHook,
    policy,
    env: { brainsReady: true, isAuto: true, now: clock },
    tor,
  }), { main: false, hint: null, decision: null, escalated: false });

  // RP mode
  assert.deepEqual(planInfluence({
    cfg: { brainShadow: true, brainInfluence: 'reassessment', rp: true },
    said: 'нет, не то',
    messages: [{ role: 'user', content: 'нет, не то' }],
    hook: hotHook,
    policy,
    env: { brainsReady: true, isAuto: true, rp: true, now: clock },
    tor,
  }), { main: false, hint: null, decision: null, escalated: false });

  // Cloud worker / computer route
  assert.deepEqual(planInfluence({
    cfg: { brainShadow: true, brainInfluence: 'reassessment' },
    said: 'нет, не то',
    messages: [{ role: 'user', content: 'нет, не то' }],
    route: { worker: 'claude' },
    hook: hotHook,
    policy,
    env: { brainsReady: true, isAuto: true, now: clock },
    tor,
  }), { main: false, hint: null, decision: null, escalated: false });

  // Exception inside hook.peekChannels() -> neutral, never throws
  const brokenHook = {
    peekChannels() { throw new Error('boom'); },
  };
  assert.deepEqual(planInfluence({
    cfg: { brainShadow: true, brainInfluence: 'reassessment' },
    said: 'нет, не то',
    messages: [{ role: 'user', content: 'нет, не то' }],
    hook: brokenHook,
    policy,
    env: { brainsReady: true, isAuto: true, now: clock },
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
