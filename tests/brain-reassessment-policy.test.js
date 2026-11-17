'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CONFIG, createShadow } = require('../src/main/brain');
const { DEFAULTS, STOP_HINT_TEXT, createReassessmentPolicy } = require('../src/main/brain/reassessment-policy');
const { createShadowHook, TOR_COOLDOWN_MS } = require('../src/main/brain/shadow-hook');

const mkDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-policy-')), 'brain-journal');

function makeUuid(prefix = 1000) {
  let n = prefix;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

function makeHarness(startAtMs) {
  const brain = createShadow();
  const uuid = makeUuid(1000);
  const sourceId = uuid();
  let sourceSeq = 0;

  function beginTask(atMs, { contradiction = 0, urgency = 0, novelty = 0, uncertainty = 0 } = {}) {
    const taskId = uuid();
    let taskSeq = 0;
    const emit = (type, extra = {}) => {
      sourceSeq += 1;
      taskSeq += 1;
      return brain.ingest({
        privacy: 'ordinary',
        event: {
          type,
          schema_version: CONFIG.schema_version,
          config_version: CONFIG.version,
          event_id: uuid(),
          task_id: taskId,
          source_id: sourceId,
          source_seq: sourceSeq,
          task_seq: taskSeq,
          occurred_at_ms: extra.atMs ?? atMs,
          received_at_ms: extra.atMs ?? atMs,
          ...extra.fields,
        },
      }).state;
    };

    const startState = emit('message', {
      atMs,
      fields: { origin: 'user', route: 'unknown', novelty, uncertainty, contradiction, urgency },
    });

    return {
      state: startState,
      error(tMs, error_kind = 'execution') {
        return emit('error', { atMs: tMs, fields: { error_kind } });
      },
      completeUnverified(tMs, outcome = 'completed') {
        return emit('task_completed', { atMs: tMs, fields: { outcome, validation: 'unverified' } });
      },
      completeVerified(tMs, utility = 1, outcome = 'completed') {
        return emit('task_completed', { atMs: tMs, fields: { outcome, validation: 'verified', utility } });
      },
    };
  }

  return { brain, beginTask, tick: (atMs) => brain.tick({ privacy: 'ordinary', at_ms: atMs }).state };
}

const DAY_TIME_MS = Date.UTC(2026, 10, 18, 9, 0, 0);   // 14:00 UTC+5 (circadian_quiet === 0)
const QUIET_TIME_MS = Date.UTC(2026, 10, 18, 20, 0, 0); // 01:00 UTC+5 (circadian_quiet === 1)

test('1. error burst through real v3 core activates >=0.65, spends 2->1->0 budget, stops on exhaustion and >0.85 overload', () => {
  let clock = DAY_TIME_MS;
  const { beginTask } = makeHarness(clock);
  const policy = createReassessmentPolicy({ now: () => clock });
  const ctx = { mode: 'reassessment', brainsReady: true, isAuto: true, mainActive: true, gpuBusy: false };

  // 3 errors within 30s -> reassessment reaches ~0.688 (>= 0.65) and activates hysteresis
  const t1 = beginTask(clock);
  clock += 5_000;
  t1.error(clock);
  clock += 10_000;
  t1.error(clock);
  clock += 10_000;
  const burstState = t1.error(clock);

  assert.equal(burstState.circadian_quiet, 0);
  assert.ok(burstState.reassessment >= 0.65 && burstState.reassessment <= 0.85);
  assert.equal(burstState.reassessment_active, 1);

  // 1st escalation: budget 2 -> 1
  const d1 = policy.decide({ channels: burstState, features: { contradiction: 0, urgency: 0 }, ctx });
  assert.equal(d1.action, 'escalate');
  assert.equal(d1.reason, 'reassessment_optimum');
  assert.equal(d1.budgetLeft, 2);
  assert.equal(policy.commit(d1), true);
  assert.equal(policy.stats().budgetLeft, 1);

  // 2nd escalation: budget 1 -> 0
  clock += 5_000;
  const t2 = beginTask(clock);
  const d2 = policy.decide({ channels: t2.state, features: { contradiction: 0, urgency: 0 }, ctx });
  assert.equal(d2.action, 'escalate');
  assert.equal(d2.budgetLeft, 1);
  assert.equal(policy.commit(d2), true);
  assert.equal(policy.stats().budgetLeft, 0);

  // 3rd decision in same 10-min window -> stop (budget_exhausted), no escalate
  clock += 5_000;
  const d3 = policy.decide({ channels: t2.state, features: { contradiction: 0, urgency: 0 }, ctx });
  assert.equal(d3.action, 'stop');
  assert.equal(d3.reason, 'budget_exhausted');
  assert.equal(policy.commit(d3), false);

  // After 10-min window refills budget, pushing reassessment > 0.85 via a second 60s window hits overload stop
  clock += DEFAULTS.budget_window_ms;
  const t3 = beginTask(clock);
  let state = t3.error(clock); // +0.25 in fresh window -> low after 10m; push again with burst
  state = t3.error(clock + 1_000); // +0.25 -> ~0.50
  state = t3.error(clock + 2_000); // window capped at 0.70
  clock += 61_000;
  const t4 = beginTask(clock, { contradiction: 1, urgency: 1 }); // +0.45 in new 60s window -> > 0.85
  assert.ok(t4.state.reassessment > 0.85);
  assert.equal(policy.stats().budgetLeft, 2);

  const dOverload = policy.decide({ channels: t4.state, features: { contradiction: 1, urgency: 1 }, ctx });
  assert.equal(dOverload.action, 'stop');
  assert.equal(dOverload.reason, 'overload');
  assert.equal(policy.commit(dOverload), false);
});

test('2. praise spam (10 unverified positive-looking messages) does not trigger relief and stays active', () => {
  let clock = DAY_TIME_MS;
  const { beginTask } = makeHarness(clock);
  const policy = createReassessmentPolicy({ now: () => clock });
  const ctx = { mode: 'reassessment', brainsReady: true, isAuto: true, mainActive: true };

  // Build active reassessment via 3 errors in 20s
  const errTask = beginTask(clock);
  errTask.error(clock + 2_000);
  errTask.error(clock + 10_000);
  let state = errTask.error(clock + 20_000);
  clock += 20_000;
  assert.equal(state.reassessment_active, 1);
  const beforeSpam = state.reassessment;

  // 10 praise messages ("спасибо/молодец") without verified +1 (BRAIN_V1: praise -> unverified)
  for (let i = 0; i < 10; i++) {
    clock += 1_000;
    const praise = beginTask(clock);
    state = praise.completeUnverified(clock + 200);
  }
  clock += 200;

  // Only tiny exponential time decay (~12s / 600s), no 0.20 verified relief
  assert.ok(beforeSpam - state.reassessment < 0.03);
  assert.ok(state.reassessment >= 0.65);
  assert.equal(state.reassessment_active, 1);

  const dec = policy.decide({ channels: state, ctx });
  assert.equal(dec.action, 'escalate');

  // Contrast: explicit verified +1 DOES apply verified_reassessment_relief (-0.20)
  clock += 1_000;
  const verifiedTask = beginTask(clock);
  const afterVerified = verifiedTask.completeVerified(clock + 200, 1, 'completed');
  assert.ok(state.reassessment - afterVerified.reassessment >= 0.19);
});

test('3. >30 min silence decays reassessment below 0.35, resets active by hysteresis, yields none/inactive, and rearms stopHint', () => {
  let clock = DAY_TIME_MS;
  const { beginTask, tick } = makeHarness(clock);
  const policy = createReassessmentPolicy({ now: () => clock });
  const ctx = { mode: 'reassessment', brainsReady: true, isAuto: true, mainActive: true };

  // Enter active series and consume stopHint once
  const t1 = beginTask(clock);
  t1.error(clock + 1_000);
  t1.error(clock + 2_000);
  const activeState = t1.error(clock + 3_000);
  clock += 3_000;
  assert.equal(activeState.reassessment_active, 1);

  const activeDec = policy.decide({ channels: activeState, ctx });
  assert.equal(activeDec.action, 'escalate');
  assert.equal(policy.stopHint(), STOP_HINT_TEXT);
  assert.equal(policy.stopHint(), null); // once per series

  // > 30 min of silence (31 min, well past 60s hysteresis cooldown)
  clock += 31 * 60 * 1000;
  const decayed = tick(clock);
  assert.ok(decayed.reassessment < 0.35);
  assert.equal(decayed.reassessment_active, 0);

  const inactiveDec = policy.decide({ channels: decayed, ctx });
  assert.equal(inactiveDec.action, 'none');
  assert.equal(inactiveDec.reason, 'inactive');

  // New series (past 60s hysteresis transition cooldown) re-enables stopHint once
  clock += CONFIG.cooldown_ms;
  const t2 = beginTask(clock + 1_000);
  t2.error(clock + 2_000);
  t2.error(clock + 3_000);
  const activeAgain = t2.error(clock + 4_000);
  clock += 4_000;
  assert.equal(activeAgain.reassessment_active, 1);

  const dec2 = policy.decide({ channels: activeAgain, ctx });
  assert.equal(dec2.action, 'escalate');
  assert.equal(policy.stopHint(), STOP_HINT_TEXT);
  assert.equal(policy.stopHint(), null);
});

test('4. Tor context returns none/tor untouched budget, and peekChannels returns null on features.tor or hook quarantine', async () => {
  let clock = DAY_TIME_MS;
  const policy = createReassessmentPolicy({ now: () => clock });
  const optChannels = { reassessment: 0.72, reassessment_active: 1, stability: 0.90, stability_active: 0, circadian_quiet: 0 };

  const torActive = policy.decide({
    channels: optChannels,
    features: { contradiction: 1, urgency: 1 },
    ctx: { mode: 'reassessment', brainsReady: true, isAuto: true, mainActive: true, tor: true },
  });
  assert.deepEqual({ action: torActive.action, reason: torActive.reason }, { action: 'none', reason: 'tor' });
  assert.equal(policy.commit(torActive), false);

  // Also ignored in 'off' mode (must not count as shadow trigger or consume shadow budget)
  const torOff = policy.decide({
    channels: optChannels,
    features: { contradiction: 1 },
    ctx: { mode: 'off', brainsReady: true, isAuto: true, tor: true },
  });
  assert.deepEqual({ action: torOff.action, reason: torOff.reason }, { action: 'none', reason: 'tor' });

  const s = policy.stats();
  assert.equal(s.budgetLeft, 2);
  assert.equal(s.trigger_episodes, 0);
  assert.equal(s.shadow_trigger_episodes, 0);
  assert.equal(s.shadow_escalate, 0);

  // Hook peekChannels checks Tor feature & quarantine
  const hook = createShadowHook({ dir: mkDir(), now: () => clock, uuid: makeUuid(2000) });
  assert.ok(hook.peekChannels(clock, { urgency: 1 }));
  assert.equal(hook.peekChannels(clock, { tor: true, urgency: 1 }), null);

  hook.torTouched();
  assert.equal(hook.peekChannels(clock + 1_000, { urgency: 1 }), null);

  clock += TOR_COOLDOWN_MS + 1_000;
  assert.ok(hook.peekChannels(clock, { urgency: 0 }));
  await hook.close();
});

test('5. quiet hours (circadian_quiet=1): budget is 1 per 10 min, cold swap without contradiction/urgency is evc_negative, with contradiction escalates', () => {
  let clock = QUIET_TIME_MS;
  const { beginTask } = makeHarness(clock);
  const policy = createReassessmentPolicy({ now: () => clock });
  const quietBaseCtx = { mode: 'reassessment', brainsReady: true, isAuto: true, mainActive: false, gpuBusy: false };

  // Contradiction (+0.20) + urgency (+0.25) + 1 error (+0.25) keeps stability = 0.85 (>= 0.70) from the real core
  const t1 = beginTask(clock, { contradiction: 1, urgency: 1 });
  const highStabilityQuiet = t1.error(clock + 1_000);
  clock += 1_000;
  assert.equal(highStabilityQuiet.circadian_quiet, 1);
  assert.ok(highStabilityQuiet.reassessment >= 0.65);
  assert.equal(highStabilityQuiet.reassessment_active, 1);
  assert.ok(highStabilityQuiet.stability >= 0.70);

  const coldNoTrigger = policy.decide({
    channels: highStabilityQuiet,
    features: { contradiction: 0, urgency: 0 },
    ctx: quietBaseCtx,
  });
  assert.equal(coldNoTrigger.action, 'none');
  assert.equal(coldNoTrigger.reason, 'evc_negative');
  assert.equal(coldNoTrigger.evc, -0.05); // 0.50 + 0.10 - (0.45 + 0.20)
  assert.equal(coldNoTrigger.budgetLeft, 1);

  // With fresh contradiction: 0.50 + 0.25 + 0.10 - (0.45 + 0.20) = +0.20 > 0 -> escalate
  const coldContradiction = policy.decide({
    channels: highStabilityQuiet,
    features: { contradiction: 1, urgency: 0 },
    ctx: quietBaseCtx,
  });
  assert.equal(coldContradiction.action, 'escalate');
  assert.equal(coldContradiction.evc, 0.2);
  assert.equal(coldContradiction.budgetLeft, 1);
  assert.equal(policy.commit(coldContradiction), true);

  // 2nd quiet turn within 10 min hits quiet budget limit (1/10 min) -> stop
  clock += 60_000;
  const secondQuiet = policy.decide({
    channels: highStabilityQuiet,
    features: { contradiction: 1, urgency: 1 },
    ctx: quietBaseCtx,
  });
  assert.equal(secondQuiet.action, 'stop');
  assert.equal(secondQuiet.reason, 'budget_exhausted');
  assert.equal(secondQuiet.budgetLeft, 0);
});

test('6. hard gates: brainsReady=false, gpuBusy=true, isAuto=false always return none without exceptions or budget cost', () => {
  const clock = DAY_TIME_MS;
  const policy = createReassessmentPolicy({ now: () => clock });
  const optChannels = { reassessment: 0.75, reassessment_active: 1, stability: 0.90, stability_active: 0, circadian_quiet: 0 };
  const features = { contradiction: 1, urgency: 1 };
  const baseCtx = { mode: 'reassessment', brainsReady: true, isAuto: true, mainActive: true, gpuBusy: false };

  const dNoBrain = policy.decide({ channels: optChannels, features, ctx: { ...baseCtx, brainsReady: false } });
  assert.equal(dNoBrain.action, 'none');
  assert.equal(dNoBrain.reason, 'brains_not_ready');
  assert.equal(dNoBrain.evc, -Infinity);

  const dGpuBusy = policy.decide({ channels: optChannels, features, ctx: { ...baseCtx, gpuBusy: true } });
  assert.equal(dGpuBusy.action, 'none');
  assert.equal(dGpuBusy.reason, 'gpu_busy');
  assert.equal(dGpuBusy.evc, -Infinity);

  const dNotAuto = policy.decide({ channels: optChannels, features, ctx: { ...baseCtx, isAuto: false } });
  assert.equal(dNotAuto.action, 'none');
  assert.equal(dNotAuto.reason, 'not_auto_model');
  assert.equal(dNotAuto.evc, -Infinity);

  assert.equal(policy.stats().budgetLeft, 2);
  assert.equal(policy.stats().escalation_count, 0);
});

test('7. circuit breaker (3 consecutive failures & >15pp rate over >=5 verified) + mode off shadow budget', () => {
  let clock = DAY_TIME_MS;
  const optChannels = { reassessment: 0.72, reassessment_active: 1, stability: 0.90, stability_active: 0, circadian_quiet: 0 };
  const ctx = { mode: 'reassessment', brainsReady: true, isAuto: true, mainActive: true };

  // 7a. 3 consecutive escalation failures trip for 60 min; a positive escalation outcome resets streak
  const breaker = createReassessmentPolicy({ now: () => clock });
  breaker.recordOutcome({ escalated: true, verdict: -1 });
  breaker.recordOutcome({ escalated: true, error: true });
  breaker.recordOutcome({ escalated: true, verdict: 1 }); // resets consecutive failures
  breaker.recordOutcome({ escalated: true, verdict: -1 });
  breaker.recordOutcome({ escalated: true, verdict: -1 });
  assert.equal(breaker.stats().tripped, false);

  breaker.recordOutcome({ escalated: true, verdict: -1 }); // 3rd consecutive failure -> trip
  assert.equal(breaker.stats().tripped, true);
  assert.equal(breaker.stats().trip_count, 1);

  const trippedDec = breaker.decide({ channels: optChannels, features: { contradiction: 1 }, ctx });
  assert.equal(trippedDec.action, 'none');
  assert.equal(trippedDec.reason, 'tripped');

  clock += DEFAULTS.breaker_cooldown_ms - 1;
  assert.equal(breaker.stats().tripped, true);
  clock += 1;
  assert.equal(breaker.stats().tripped, false);
  assert.equal(breaker.decide({ channels: optChannels, features: { contradiction: 1 }, ctx }).action, 'escalate');

  // 7b. Relative failure rate breach: >= 5 verified escalation outcomes and escNegRate > baseNegRate + 0.15
  const rateBreaker = createReassessmentPolicy({ now: () => clock });
  for (let i = 0; i < 10; i++) rateBreaker.recordOutcome({ escalated: false, verdict: 1 }); // base_neg = 0.00
  rateBreaker.recordOutcome({ escalated: true, verdict: 1 });
  rateBreaker.recordOutcome({ escalated: true, verdict: 1 });
  rateBreaker.recordOutcome({ escalated: true, verdict: 1 });
  rateBreaker.recordOutcome({ escalated: true, verdict: -1 }); // 4 verified (< 5), even at 0.25 must NOT trip
  assert.equal(rateBreaker.stats().tripped, false);
  rateBreaker.recordOutcome({ escalated: true, verdict: 1 }); // 5 verified, esc_neg=0.20, but last was +1 so no rate breach check
  assert.equal(rateBreaker.stats().tripped, false);
  rateBreaker.recordOutcome({ escalated: true, verdict: -1 }); // 6 verified, esc_neg = 2/6 ≈ 0.333 > 0 + 0.15 -> trips
  assert.equal(rateBreaker.stats().tripped, true);
  assert.equal(rateBreaker.decide({ channels: optChannels, features: { contradiction: 1 }, ctx }).reason, 'tripped');

  // 7c. mode 'off': action is always 'none', shadow_* counters increment and shadow budget caps at 2 / 10 min
  const offPolicy = createReassessmentPolicy({ now: () => clock });
  const offCtx = { mode: 'off', brainsReady: true, isAuto: true, mainActive: true };

  const s1 = offPolicy.decide({ channels: optChannels, features: { contradiction: 1 }, ctx: offCtx });
  const s2 = offPolicy.decide({ channels: optChannels, features: { urgency: 1 }, ctx: offCtx });
  const s3 = offPolicy.decide({ channels: optChannels, features: { contradiction: 1 }, ctx: offCtx }); // hits shadow budget -> shadow_stop
  assert.equal(s1.action, 'none');
  assert.equal(s1.reason, 'mode_off');
  assert.equal(s2.action, 'none');
  assert.equal(s2.reason, 'mode_off');
  assert.equal(s3.action, 'none');
  assert.equal(s3.reason, 'mode_off');
  assert.equal(offPolicy.commit(s1), false);

  const st = offPolicy.stats();
  assert.equal(st.shadow_trigger_episodes, 3);
  assert.equal(st.shadow_escalate, 2);
  assert.equal(st.shadow_stop, 1);
  assert.equal(st.escalation_count, 0);
  assert.equal(st.budgetLeft, 2); // real budget untouched
});

test('8. CLARIFY, wantsMain/wantsLocal, double-commit idempotency, and stopHint series cap', () => {
  const clock = DAY_TIME_MS;
  const policy = createReassessmentPolicy({ now: () => clock });
  const optChannels = { reassessment: 0.75, reassessment_active: 1, stability: 0.90, stability_active: 0, circadian_quiet: 0 };
  const ctx = { mode: 'reassessment', brainsReady: true, isAuto: true, mainActive: true };

  // CLARIFY verdicts (ctx.verdictClass, ctx.clarify, features.clarify) -> none/'clarify', no budget spent
  for (const args of [
    { channels: optChannels, ctx: { ...ctx, verdictClass: 'CLARIFY' } },
    { channels: optChannels, ctx: { ...ctx, clarify: true } },
    { channels: optChannels, features: { clarify: 1 }, ctx },
  ]) {
    const dec = policy.decide(args);
    assert.deepEqual({ action: dec.action, reason: dec.reason }, { action: 'none', reason: 'clarify' });
    assert.equal(policy.commit(dec), false);
  }

  // Explicit user request for main/local model -> none/'user_main' without spending budget
  for (const key of ['wantsMain', 'wantsLocal']) {
    const dec = policy.decide({ channels: optChannels, features: { contradiction: 1 }, ctx: { ...ctx, [key]: true } });
    assert.deepEqual({ action: dec.action, reason: dec.reason }, { action: 'none', reason: 'user_main' });
    assert.equal(policy.commit(dec), false);
  }
  assert.equal(policy.stats().budgetLeft, 2);

  // Double-commit of the same escalate decision charges budget only once
  const esc = policy.decide({ channels: optChannels, features: { contradiction: 1 }, ctx });
  assert.equal(esc.action, 'escalate');
  assert.equal(policy.commit(esc), true);
  assert.equal(policy.commit(esc), false);
  assert.equal(policy.stats().escalation_count, 1);
  assert.equal(policy.stats().budgetLeft, 1);

  // stopHint fires at most once per active series until an inactive (reassessment_active=0) decision
  assert.equal(policy.stopHint(), STOP_HINT_TEXT);
  assert.equal(policy.stopHint(), null);
  policy.decide({ channels: optChannels, ctx });
  assert.equal(policy.stopHint(), null);
  policy.decide({ channels: { ...optChannels, reassessment: 0.20, reassessment_active: 0 }, ctx });
  assert.equal(policy.stopHint(), STOP_HINT_TEXT);
  assert.equal(policy.stats().stop_hint_count, 2);
});
