'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG, createShadow } = require('../src/main/brain/index');
const { salience } = require('../src/main/brain/amygdala');
const { createReassessmentPolicy } = require('../src/main/brain/reassessment-policy');
const { planInfluence, commitInfluence } = require('../src/main/brain/influence-glue');

let seqId = 9000;
const nextUuid = () => `00000000-0000-4000-8000-${String(++seqId).padStart(12, '0')}`;

function makeEventBuilder() {
  const source_id = nextUuid();
  let source_seq = 0;
  return function makeTask() {
    const task_id = nextUuid();
    let task_seq = 0;
    return (type, atMs, extra = {}) => {
      source_seq++;
      task_seq++;
      const defaults = {
        message: { origin: 'user', route: 'unknown', novelty: 0, uncertainty: 0, contradiction: 0, urgency: 0 },
        tool_result: { outcome: 'ok', duration_ms: 0 },
        error: { error_kind: 'execution' },
        task_completed: { outcome: 'completed', validation: 'verified', utility: 1 },
      };
      return {
        type,
        schema_version: CONFIG.schema_version,
        config_version: CONFIG.version,
        event_id: nextUuid(),
        task_id,
        source_id,
        source_seq,
        task_seq,
        occurred_at_ms: atMs,
        received_at_ms: atMs,
        ...defaults[type],
        ...extra,
      };
    };
  };
}

function makeFakeHook(getSnap, { torBlocked = false } = {}) {
  return {
    isTorBlocked: () => torBlocked,
    peekChannels: () => getSnap(),
  };
}

const BASE_CFG = {
  brainShadow: true,
  brainInfluence: 'reassessment',
  provider: 'ollama',
  rp: false,
};

test('amygdala salience: detects uncertainty and novelty with damping and ignores code/urls', () => {
  const unc = salience('Не уверен в этих цифрах, приведи источник и проверь источник пожалуйста.');
  assert.equal(unc.uncertainty, 1);
  assert.equal(unc.novelty, 0);

  const uncEn = salience('I am not sure about this claim, can you cite source and double-check?');
  assert.equal(uncEn.uncertainty, 1);

  const damped = salience('Не срочно, объясни простым языком и перечитай условие.');
  assert.equal(damped.uncertainty, 0);
  assert.equal(damped.novelty, 0);

  const multiUncDamped = salience('Не уверен, откуда эта информация, но не срочно — посмотрим потом.');
  assert.equal(multiUncDamped.uncertainty, 0);

  const nov = salience('Настраиваем новый стек с нуля, раньше не пользовался и переходим на него впервые.');
  assert.equal(nov.novelty, 1);

  const codeAndUrl = salience('```\n// not sure, from scratch, verify source\nconst x = 1;\n``` https://example.com/first-time/uncertain');
  assert.equal(codeAndUrl.uncertainty, 0);
  assert.equal(codeAndUrl.novelty, 0);
});

test('Stage 6 V2 synthetic harness: evidence_need activation, 3/10min budget, and hint consumption', () => {
  let nowMs = 1_700_000_000_000;
  const shadow = createShadow();
  const mkTask = makeEventBuilder();
  const policy = createReassessmentPolicy({ now: () => nowMs });

  const text = 'Мы переходим на незнакомую технологию с нуля, я не уверен в архитектуре — приведи источник.';
  const feat = salience(text);
  assert.equal(feat.novelty, 1);
  assert.equal(feat.uncertainty, 1);

  // Two novelty+uncertainty turns across 60s window drive evidence_need >= 0.65 (0.5 + 0.5 capped at 0.70+)
  const t1 = mkTask();
  let snap = shadow.ingest({ privacy: 'ordinary', event: t1('message', nowMs, feat) }).state;
  assert.equal(snap.evidence_need, 0.5);
  assert.equal(snap.evidence_need_active, 0);

  nowMs += 65_000;
  const t2 = mkTask();
  snap = shadow.ingest({ privacy: 'ordinary', event: t2('message', nowMs, feat) }).state;
  assert.ok(snap.evidence_need >= 0.65, `expected evidence_need >= 0.65, got ${snap.evidence_need}`);
  assert.equal(snap.evidence_need_active, 1);
  assert.equal(snap.reassessment_active, 0);

  const hook = makeFakeHook(() => snap);

  // Consume 3 evidence hints inside 10 minutes
  for (let i = 0; i < 3; i += 1) {
    const plan = planInfluence({
      cfg: BASE_CFG,
      said: text,
      route: { worker: null },
      hook,
      policy,
      env: { local: true, now: nowMs, brainsReady: true, isAuto: true },
    });
    assert.equal(plan.main, false);
    assert.equal(plan.escalated, false);
    assert.equal(plan.decision.action, 'evidence');
    assert.equal(plan.decision.reason, 'evidence_need_active');
    assert.equal(plan.decision.stabilityGuarded, false);
    assert.ok(typeof plan.hint === 'string' && plan.hint.includes('подтверждённые факты'));

    assert.equal(commitInfluence(policy, plan, { hintDelivered: true }), true);
    assert.equal(commitInfluence(policy, plan, { hintDelivered: true }), false);
    nowMs += 30_000;
  }

  // 4th attempt inside 10-minute window is budget-exhausted
  const exhausted = planInfluence({
    cfg: BASE_CFG,
    said: text,
    route: { worker: null },
    hook,
    policy,
    env: { local: true, now: nowMs, brainsReady: true, isAuto: true },
  });
  assert.equal(exhausted.decision.action, 'none');
  assert.equal(exhausted.hint, null);

  // After 10-minute window expires, evidence budget resets to 3
  nowMs += 600_001;
  const refreshed = planInfluence({
    cfg: BASE_CFG,
    said: text,
    route: { worker: null },
    hook,
    policy,
    env: { local: true, now: nowMs, brainsReady: true, isAuto: true },
  });
  assert.equal(refreshed.decision.action, 'evidence');
  assert.equal(refreshed.decision.evidenceBudgetLeft, 3);
});

test('Stage 6 V2 synthetic harness: low stability guards EVC escalation and recovers on verified +1', () => {
  let nowMs = 1_700_010_000_000;
  const shadow = createShadow();
  const mkTask = makeEventBuilder();
  const policy = createReassessmentPolicy({ now: () => nowMs });

  let snap;
  for (let i = 0; i < 6; i += 1) {
    nowMs += 65_000;
    const t = mkTask();
    shadow.ingest({ privacy: 'ordinary', event: t('message', nowMs, { urgency: 1 }) });
    snap = shadow.ingest({ privacy: 'ordinary', event: t('error', nowMs) }).state;
  }
  assert.ok(snap.stability <= 0.35, `expected stability <= 0.35, got ${snap.stability}`);
  assert.equal(snap.stability_active, 1);

  // At reassessment >= 0.65 and low stability without fresh contradiction, cold EVC = 0.50 + 0.15 - (0.45 + 0.15) = +0.05;
  // without urgency/contradiction, EVC = 0.50 - (0.45 + 0.15) = -0.10 -> blocked by stability guard!
  const guarded = policy.decide({
    channels: { ...snap, reassessment: 0.72, reassessment_active: 1, circadian_quiet: 0 },
    features: { urgency: 0, contradiction: 0, novelty: 0, uncertainty: 0 },
    ctx: { mode: 'reassessment', brainsReady: true, isAuto: true, mainActive: false },
  });
  assert.equal(guarded.stabilityGuarded, true);
  assert.equal(guarded.action, 'none');
  assert.equal(guarded.reason, 'evc_negative');

  // Series of verified +1 completions restores stability > 0.65 and clears stability_active
  for (let i = 0; i < 8; i += 1) {
    nowMs += 65_000;
    const t = mkTask();
    shadow.ingest({ privacy: 'ordinary', event: t('message', nowMs) });
    snap = shadow.ingest({
      privacy: 'ordinary',
      event: t('task_completed', nowMs, { outcome: 'completed', validation: 'verified', utility: 1 }),
    }).state;
  }
  assert.ok(snap.stability >= 0.65, `expected recovered stability >= 0.65, got ${snap.stability}`);
  assert.equal(snap.stability_active, 0);

  const recovered = policy.decide({
    channels: { ...snap, reassessment: 0.72, reassessment_active: 1, circadian_quiet: 0 },
    features: { urgency: 0, contradiction: 0, novelty: 0, uncertainty: 0 },
    ctx: { mode: 'reassessment', brainsReady: true, isAuto: true, mainActive: false },
  });
  assert.equal(recovered.stabilityGuarded, false);
  assert.equal(recovered.action, 'escalate');
});

test('Stage 6 V2 synthetic calibration: 2 errors in 30s < 0.65, 3rd >= 0.65, alternating +1/error below saturation', () => {
  let nowMs = 1_700_020_000_000;
  const shadow = createShadow();
  const mkTask = makeEventBuilder();
  const t = mkTask();

  shadow.ingest({ privacy: 'ordinary', event: t('message', nowMs) });
  const e1 = shadow.ingest({ privacy: 'ordinary', event: t('error', nowMs) }).state;
  const e2 = shadow.ingest({ privacy: 'ordinary', event: t('error', nowMs + 10_000) }).state;
  assert.ok(e2.reassessment < 0.65, `expected < 0.65 after 2 errors, got ${e2.reassessment}`);

  const e3 = shadow.ingest({ privacy: 'ordinary', event: t('error', nowMs + 20_000) }).state;
  assert.ok(e3.reassessment >= 0.65, `expected >= 0.65 after 3 errors, got ${e3.reassessment}`);
  assert.ok(e1.reassessment < e2.reassessment && e2.reassessment < e3.reassessment);

  const altShadow = createShadow();
  const mkAlt = makeEventBuilder();
  let lastAlt;
  for (let i = 0; i < 20; i += 1) {
    nowMs += 10_000;
    const ta = mkAlt();
    altShadow.ingest({ privacy: 'ordinary', event: ta('message', nowMs) });
    const ev = i % 2 === 0
      ? ta('task_completed', nowMs, { outcome: 'completed', validation: 'verified', utility: 1 })
      : ta('error', nowMs);
    lastAlt = altShadow.ingest({ privacy: 'ordinary', event: ev }).state;
  }
  assert.ok(lastAlt.reassessment < 0.85, `alternating stream saturated: ${lastAlt.reassessment}`);
});

test('Stage 6 V2 isolation: RP, tripped, Tor, and mode=off shadow counting without user-facing hint/main', () => {
  const nowMs = 1_700_030_000_000;
  const activeChannels = {
    reassessment: 0.1,
    reassessment_active: 0,
    evidence_need: 0.8,
    evidence_need_active: 1,
    stability: 0.9,
    stability_active: 0,
    circadian_quiet: 0,
  };
  const text = 'Мы переходим на незнакомую технологию с нуля, не уверен — приведи источник.';
  const features = salience(text);
  const hook = makeFakeHook(() => activeChannels);

  // 1. mode='off' increments shadow_evidence and returns neutral plan
  const offPolicy = createReassessmentPolicy({ now: () => nowMs });
  const offPlan = planInfluence({
    cfg: { ...BASE_CFG, brainInfluence: 'off' },
    said: text,
    route: { worker: null },
    hook,
    policy: offPolicy,
    env: { local: true, now: nowMs, brainsReady: true, isAuto: true },
  });
  assert.equal(offPlan.main, false);
  assert.equal(offPlan.hint, null);
  assert.equal(offPlan.decision.action, 'none');
  assert.equal(offPlan.decision.reason, 'mode_off');
  assert.equal(offPolicy.stats().shadow_evidence, 1);
  assert.equal(offPolicy.stats().shadow_trigger_episodes, 1);

  // 2. RP context returns neutral plan without hint
  const onPolicy = createReassessmentPolicy({ now: () => nowMs });
  const rpPlan = planInfluence({
    cfg: { ...BASE_CFG, rp: true },
    said: text,
    route: { worker: null },
    hook,
    policy: onPolicy,
    env: { local: true, now: nowMs, brainsReady: true, isAuto: true },
  });
  assert.equal(rpPlan.main, false);
  assert.equal(rpPlan.hint, null);

  // 3. Tor context returns neutral plan without touching policy
  const torPlan = planInfluence({
    cfg: BASE_CFG,
    said: text,
    route: { worker: null },
    hook: makeFakeHook(() => activeChannels, { torBlocked: true }),
    policy: onPolicy,
    env: { local: true, now: nowMs, brainsReady: true, isAuto: true },
  });
  assert.equal(torPlan.main, false);
  assert.equal(torPlan.hint, null);
  assert.equal(onPolicy.stats().evidence_count, 0);

  // 4. Tripped circuit blocks evidence action
  const trippedDecision = onPolicy.decide({
    channels: activeChannels,
    features,
    ctx: { mode: 'reassessment', tripped: true },
  });
  assert.equal(trippedDecision.action, 'none');
  assert.equal(trippedDecision.reason, 'tripped');
});
