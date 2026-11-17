'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULTS, STOP_HINT_TEXT, createReassessmentPolicy } = require('../src/main/brain/reassessment-policy');
const { createShadowHook, TOR_COOLDOWN_MS } = require('../src/main/brain/shadow-hook');

const mkDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-policy-smoke-')), 'brain-journal');

function makeUuid(prefix = 5000) {
  let n = prefix;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

test('zones, EVC gates, sliding 10-min budget, quiet hours, and user_main bypass', () => {
  let clock = Date.UTC(2026, 10, 18, 9, 0, 0);
  const policy = createReassessmentPolicy({ now: () => clock });
  const baseCtx = {
    mode: 'reassessment',
    brainsReady: true,
    isAuto: true,
    mainActive: false,
    gpuBusy: false,
    rp: false,
    tor: false,
  };
  const optChannels = {
    reassessment: 0.70,
    reassessment_active: 1,
    stability: 0.85,
    stability_active: 0,
    circadian_quiet: 0,
  };

  // Inactive below threshold
  const idle = policy.decide({ channels: { reassessment: 0.50, reassessment_active: 0 }, ctx: baseCtx });
  assert.equal(idle.action, 'none');
  assert.equal(idle.reason, 'inactive');

  // Explicit user request for main/local does not touch budget
  const userMain = policy.decide({ channels: optChannels, ctx: { ...baseCtx, wantsMain: true } });
  assert.equal(userMain.action, 'none');
  assert.equal(userMain.reason, 'user_main');
  assert.equal(policy.stats().budgetLeft, 2);

  // Hard gates & negative quiet cold EVC
  assert.equal(policy.decide({ channels: optChannels, ctx: { ...baseCtx, gpuBusy: true } }).reason, 'gpu_busy');
  assert.equal(policy.decide({ channels: optChannels, ctx: { ...baseCtx, shortTrivial: true } }).reason, 'short_trivial');
  const quietCold = policy.decide({
    channels: { ...optChannels, circadian_quiet: 1 },
    features: { urgency: 0, contradiction: 0 },
    ctx: baseCtx,
  });
  assert.equal(quietCold.action, 'none');
  assert.equal(quietCold.reason, 'evc_negative');
  assert.ok(quietCold.evc < 0);

  // 1st escalation (budget 2 -> 1), then double-commit is ignored
  const esc1 = policy.decide({ channels: optChannels, features: { contradiction: 1, urgency: 0 }, ctx: baseCtx });
  assert.equal(esc1.action, 'escalate');
  assert.equal(esc1.budgetLeft, 2);
  assert.equal(policy.commit(esc1), true);
  assert.equal(policy.commit(esc1), false);
  assert.equal(policy.stats().budgetLeft, 1);

  // Quiet hours cap = 1, so with 1 escalation in window quiet budget is 0 -> stop
  const quietExhausted = policy.decide({
    channels: { ...optChannels, circadian_quiet: 1 },
    features: { contradiction: 1, urgency: 0 },
    ctx: baseCtx,
  });
  assert.equal(quietExhausted.action, 'stop');
  assert.equal(quietExhausted.reason, 'budget_exhausted');

  // 2nd daytime escalation spends remaining budget (1 -> 0) -> next active turn hits stop
  clock += 60_000;
  const esc2 = policy.decide({ channels: optChannels, features: { urgency: 1 }, ctx: baseCtx });
  assert.equal(esc2.action, 'escalate');
  assert.equal(policy.commit(esc2), true);
  assert.equal(policy.stats().budgetLeft, 0);

  const dayExhausted = policy.decide({ channels: optChannels, features: { urgency: 1 }, ctx: baseCtx });
  assert.equal(dayExhausted.action, 'stop');
  assert.equal(dayExhausted.reason, 'budget_exhausted');

  // Overload zone (> 0.85) stops immediately even after 10-min budget refills
  clock += DEFAULTS.budget_window_ms;
  assert.equal(policy.stats().budgetLeft, 2);
  const overload = policy.decide({
    channels: { ...optChannels, reassessment: 0.88 },
    features: { contradiction: 1 },
    ctx: baseCtx,
  });
  assert.equal(overload.action, 'stop');
  assert.equal(overload.reason, 'overload');
});

test('mode off records shadow triggers only; Tor and CLARIFY bypass without cost or escalation', () => {
  const policy = createReassessmentPolicy({ now: () => 1_700_000_000_000 });
  const optChannels = {
    reassessment: 0.72,
    reassessment_active: 1,
    stability: 0.80,
    stability_active: 0,
    circadian_quiet: 0,
  };
  const offCtx = { mode: 'off', brainsReady: true, isAuto: true, mainActive: false };

  const d1 = policy.decide({ channels: optChannels, features: { contradiction: 1 }, ctx: offCtx });
  assert.equal(d1.action, 'none');
  assert.equal(d1.reason, 'mode_off');
  assert.equal(policy.commit(d1), false);

  const d2 = policy.decide({ channels: { ...optChannels, reassessment: 0.90 }, features: { contradiction: 1 }, ctx: offCtx });
  assert.equal(d2.action, 'none');
  assert.equal(d2.reason, 'mode_off');

  // Tor and CLARIFY do not touch shadow_trigger_episodes or budget
  const torDec = policy.decide({ channels: optChannels, ctx: { mode: 'reassessment', brainsReady: true, isAuto: true, tor: true } });
  assert.deepEqual({ action: torDec.action, reason: torDec.reason }, { action: 'none', reason: 'tor' });

  const clarifyDec = policy.decide({
    channels: optChannels,
    ctx: { mode: 'reassessment', brainsReady: true, isAuto: true, verdictClass: 'CLARIFY' },
  });
  assert.deepEqual({ action: clarifyDec.action, reason: clarifyDec.reason }, { action: 'none', reason: 'clarify' });

  const s = policy.stats();
  assert.equal(s.shadow_trigger_episodes, 2);
  assert.equal(s.shadow_escalate, 1);
  assert.equal(s.shadow_stop, 1);
  assert.equal(s.trigger_episodes, 0);
  assert.equal(s.escalation_count, 0);
  assert.equal(s.budgetLeft, 2);
});

test('circuit breaker trips on 3 consecutive failures or >15pp rate gap, and stopHint emits once per series', () => {
  let clock = 1_700_000_000_000;
  const policy = createReassessmentPolicy({ now: () => clock });
  const activeChannels = { reassessment: 0.75, reassessment_active: 1, stability: 0.9, stability_active: 0, circadian_quiet: 0 };
  const idleChannels = { reassessment: 0.25, reassessment_active: 0, stability: 0.9, stability_active: 0, circadian_quiet: 0 };
  const ctx = { mode: 'reassessment', brainsReady: true, isAuto: true };

  // stopHint fires once per active series and resets only when reassessment_active becomes 0
  assert.equal(policy.stopHint(), STOP_HINT_TEXT);
  assert.equal(policy.stopHint(), null);
  policy.decide({ channels: activeChannels, ctx });
  assert.equal(policy.stopHint(), null);
  policy.decide({ channels: idleChannels, ctx });
  assert.equal(policy.stopHint(), STOP_HINT_TEXT);

  // Rule 1: 3 consecutive failures trip for 60 min
  policy.recordOutcome({ escalated: true, verdict: -1 });
  policy.recordOutcome({ escalated: true, error: true });
  assert.equal(policy.stats().tripped, false);
  policy.recordOutcome({ escalated: true, verdict: -1 });
  assert.equal(policy.stats().tripped, true);
  assert.equal(policy.decide({ channels: activeChannels, ctx }).reason, 'tripped');

  // After 60 min cooldown expires cleanly
  clock += DEFAULTS.breaker_cooldown_ms;
  assert.equal(policy.stats().tripped, false);

  // Rule 2: >=5 verified outcomes and esc neg rate > baseline neg rate + 0.15
  const policy2 = createReassessmentPolicy({ now: () => clock });
  for (let i = 0; i < 10; i++) policy2.recordOutcome({ escalated: false, verdict: 1 }); // base neg = 0.00
  for (let i = 0; i < 4; i++) policy2.recordOutcome({ escalated: true, verdict: 1 });
  policy2.recordOutcome({ escalated: true, verdict: -1 }); // esc neg = 1/5 = 0.20 > 0.00 + 0.15
  assert.equal(policy2.stats().tripped, true);
  assert.equal(policy2.stats().esc_neg, 1);
  assert.equal(policy2.stats().base_pos, 10);
});

test('shadowHook.peekChannels projects decay and impulses read-only and returns null on Tor or close', async () => {
  const dir = mkDir();
  let clock = Date.UTC(2026, 10, 18, 9, 0, 0);
  const hook = createShadowHook({ dir, now: () => clock, uuid: makeUuid() });

  // Turn 1 with urgent contradiction -> verified -1 puts reassessment at 0.45 in memCore without blocking on disk
  const t1 = hook.start({ worker: null }, { features: { urgency: 1, contradiction: 1 } });
  t1.complete({ verified: true, utility: -1 });

  // Without urgency/contradiction -> peek stays around ~0.45 (< enter 0.65); with urgency=1 -> window_cap 0.70 triggers active=1
  const plainPeek = hook.peekChannels(clock, { urgency: 0, contradiction: 0 });
  assert.ok(plainPeek);
  assert.equal(plainPeek.reassessment_active, 0);
  assert.equal(plainPeek.record_count, 2);

  const pushPeek = hook.peekChannels(clock + 1000, { urgency: 1, contradiction: 0 });
  assert.ok(pushPeek);
  assert.equal(pushPeek.reassessment_active, 1);
  assert.ok(pushPeek.reassessment >= 0.65);

  // Calling peekChannels must NOT mutate memCore or write another task
  const secondPlainPeek = hook.peekChannels(clock + 2000, { urgency: 0, contradiction: 0 });
  assert.equal(secondPlainPeek.reassessment_active, 0);
  assert.equal(secondPlainPeek.record_count, 2);

  // 30-min decay keeps channels well below 0.35
  const decayed = hook.peekChannels(clock + 30 * 60 * 1000, { urgency: 0, contradiction: 0 });
  assert.ok(decayed.reassessment < 0.05);

  // Tor quarantine -> null until cooldown lifts; close() -> null permanently
  hook.torTouched();
  assert.equal(hook.peekChannels(clock, { urgency: 1 }), null);
  assert.equal(hook.peekChannels(clock, { urgency: 0, tor: true }), null);

  clock += TOR_COOLDOWN_MS + 1000;
  assert.ok(hook.peekChannels(clock, { urgency: 0 }));

  await hook.close();
  assert.equal(hook.peekChannels(clock, { urgency: 0 }), null);
});
