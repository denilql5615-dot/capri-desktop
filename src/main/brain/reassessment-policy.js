'use strict';

// Policy layer for Stage 6 channel influence (`reassessment`).
// Pure CPU decision logic: no Electron, no network, no disk I/O; time enters via injected `now`.
// All thresholds cite sections of `genesis-src/reports/brain-stage6-design-2026-11-18.md`.

const { resolveInfluenceAb, utc5DayInfo } = require('./influence-glue');

const DEFAULTS = Object.freeze({
  // §0 / §2.2: hysteresis thresholds for reassessment channel activation & overload
  enter_threshold: 0.65, // §0, §2.2: minimum reassessment to enter escalation optimum
  overload_threshold: 0.85, // §2.2: upper edge of inverted U -> stop mode (variant C)
  leave_threshold: 0.35, // §0, §2.1: hysteresis release level for reassessment_active

  // §2.1: recheck_budget limits
  budget_per_turn: 1, // §2.1: at most 1 auto-escalation to 26B per turn
  budget_window_ms: 10 * 60 * 1000, // §2.1: 10-minute sliding window
  budget_day_max: 2, // §2.1: at most 2 auto-escalations per 10 min outside quiet hours
  budget_quiet_max: 1, // §2.1: at most 1 auto-escalation per 10 min in quiet hours

  // §2.3.2: EVC = benefit - cost weights (CPU check < 1 ms)
  evc_base_benefit: 0.50, // §2.3.2: baseline benefit when reassessment_active === 1
  evc_contradiction_benefit: 0.25, // §2.3.2: bonus for fresh contradiction === 1
  evc_urgency_benefit: 0.15, // §2.3.2: bonus for fresh urgency === 1
  evc_high_stability_benefit: 0.10, // §2.3.2: bonus when stability >= 0.70
  evc_high_stability_min: 0.70, // §2.3.2: stability cutoff for high-stability bonus
  evc_warm_load_cost: 0.05, // §2.3.2: cost when 26B is already warm (`mainActive === true`)
  evc_cold_load_cost: 0.45, // §2.3.2: cost for cold swap E4B -> 26B
  evc_quiet_penalty: 0.20, // §2.3.2: extra penalty during quiet hours (`circadian_quiet === 1`)
  evc_low_stability_penalty: 0.15, // Stage 6 V2: raise escalation bar when stability is low
  low_stability_max: 0.35, // §2.3.2: stability <= 0.35 (`stability_active === 1`) after neg -> stop

  // Stage 6 V2: evidence_need channel thresholds & hint budget
  evidence_enter_threshold: 0.65,
  evidence_budget_window_ms: 10 * 60 * 1000,
  evidence_budget_max: 3,

  // §4: circuit breaker thresholds
  breaker_consecutive_failures: 3, // §4: 3 consecutive escalation failures (-1 or 26B error) -> trip
  breaker_min_verified: 5, // §4: minimum verified escalation outcomes for relative failure check
  breaker_neg_rate_margin: 0.15, // §4: max allowed excess over baseline neg rate (+15 pp)
  breaker_cooldown_ms: 60 * 60 * 1000, // §4: 60-minute trip duration

  // Stage 6 voice guard: avoid 6-12s cold E4B -> 26B swap silence during hands-free voice turns.
  voice_cold_escalation: false,
});

// §2.2 (Variant C) + Lead decision (3): short 1-2 sentence system hint for stop mode, no promises.
const STOP_HINT_TEXT = [
  'Предыдущие попытки решения не сошлись.',
  'Кратко назови одно главное препятствие и предложи пользователю уточнить условие или передать задачу внешнему агенту, без догадок и обещаний.',
].join(' ');

const EVIDENCE_HINT_TEXT = [
  'Повышена неопределённость или новизна:',
  'опирайся только на подтверждённые факты и источники, явно отметь пробелы без догадок.',
].join(' ');

function safeNow(now) {
  const n = Number(now());
  return Number.isFinite(n) ? n : 0;
}

function bit(v) {
  return v === 1 || v === true ? 1 : 0;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function roundEvc(v) {
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v;
}

function createReassessmentPolicy({ now = Date.now, config = {}, getConfig } = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  const escalationTimestamps = [];
  // Lead decision (4): the control days spend a budget of their own, so shadow counts stay comparable
  const shadowTimestamps = [];
  const evidenceTimestamps = [];
  const shadowEvidenceTimestamps = [];
  const committedDecisions = new WeakSet();
  const committedEvidenceDecisions = new WeakSet();

  let stopHintEmitted = false;
  let lastEscalationWasNeg = false;
  let consecutiveEscalationFailures = 0;
  let trippedUntil = null;
  let lastQuietFlag = 0;
  let lastAbGroup = null;
  let lastAbDay = null;

  const counts = {
    trigger_episodes: 0,
    escalation_count: 0,
    stop_report_count: 0,
    stop_hint_count: 0,
    evidence_count: 0,
    stability_guard_count: 0,
    shadow_trigger_episodes: 0,
    shadow_escalate: 0,
    shadow_stop: 0,
    shadow_evidence: 0,
    esc_pos: 0,
    esc_neg: 0,
    esc_unverified: 0,
    esc_errors: 0,
    base_pos: 0,
    base_neg: 0,
    base_unverified: 0,
    trip_count: 0,
  };

  function pruneWindow(atMs, list = escalationTimestamps, windowMs = cfg.budget_window_ms) {
    while (list.length > 0 && atMs - list[0] >= windowMs) {
      list.shift();
    }
  }

  function refreshBreaker(atMs) {
    if (trippedUntil !== null && atMs >= trippedUntil) {
      trippedUntil = null;
      consecutiveEscalationFailures = 0;
    }
  }

  function isTripped(atMs) {
    refreshBreaker(atMs);
    return trippedUntil !== null && atMs < trippedUntil;
  }

  function budgetLeftAt(atMs, quiet, list = escalationTimestamps) {
    pruneWindow(atMs, list);
    const maxAllowed = quiet ? cfg.budget_quiet_max : cfg.budget_day_max;
    return Math.max(0, maxAllowed - list.length);
  }

  function evidenceBudgetLeftAt(atMs, list = evidenceTimestamps) {
    pruneWindow(atMs, list, cfg.evidence_budget_window_ms);
    return Math.max(0, cfg.evidence_budget_max - list.length);
  }

  function isLowStability(channels) {
    const stability = num(channels?.stability, 1);
    const stabilityActive = bit(channels?.stability_active);
    return stabilityActive === 1 || stability <= cfg.low_stability_max;
  }

  function computeEvc(channels, features, ctx) {
    const stability = num(channels?.stability, 1);
    const quiet = bit(channels?.circadian_quiet);
    const contradiction = bit(features?.contradiction);
    const urgency = bit(features?.urgency);
    const stabilityPenalty = isLowStability(channels) ? cfg.evc_low_stability_penalty : 0;

    const benefit = cfg.evc_base_benefit
      + cfg.evc_contradiction_benefit * contradiction
      + cfg.evc_urgency_benefit * urgency
      + (stability >= cfg.evc_high_stability_min ? cfg.evc_high_stability_benefit : 0);

    const loadCost = ctx?.mainActive === true ? cfg.evc_warm_load_cost : cfg.evc_cold_load_cost;
    const quietPenalty = quiet === 1 ? cfg.evc_quiet_penalty : 0;
    return roundEvc(benefit - (loadCost + quietPenalty + stabilityPenalty));
  }

  function decide({ channels = {}, features = {}, ctx = {} } = {}) {
    const atMs = safeNow(now);
    const quiet = bit(channels?.circadian_quiet);
    lastQuietFlag = quiet;
    if (ctx && (Object.hasOwn(ctx, 'ab_group') || Object.hasOwn(ctx, 'ab_day'))) {
      lastAbGroup = ctx.ab_group === 'A' || ctx.ab_group === 'B' ? ctx.ab_group : null;
      lastAbDay = typeof ctx.ab_day === 'string' ? ctx.ab_day : null;
    }
    const mode = ctx?.mode === 'reassessment' ? 'reassessment' : 'off';
    const budgetLeft = budgetLeftAt(atMs, quiet, mode === 'reassessment' ? escalationTimestamps : shadowTimestamps);

    const active = channels && Number(channels.reassessment_active) === 1 ? 1 : 0;
    if (active === 0) {
      stopHintEmitted = false;
    }

    // §3 / Lead: Tor context or quarantine never triggers influence or touches budgets.
    if (ctx?.tor === true) {
      return { action: 'none', reason: 'tor', evc: 0, budgetLeft };
    }
    // §3: RP prompt stays untouched.
    if (ctx?.rp === true) {
      return { action: 'none', reason: 'rp', evc: 0, budgetLeft };
    }
    // §2.3.1: explicit user request for main/local model runs natively without budget charge.
    if (ctx?.wantsMain === true || ctx?.wantsLocal === true) {
      return { action: 'none', reason: 'user_main', evc: 0, budgetLeft };
    }
    // §2.3.1: explicit user request for fast model overrides escalation.
    if (ctx?.wantsFast === true) {
      return { action: 'none', reason: 'user_fast', evc: 0, budgetLeft };
    }
    // Lead decision: CLARIFY verdict is neither failure nor trigger for escalation/stop.
    if (ctx?.clarify === true || ctx?.verdictClass === 'CLARIFY' || features?.clarify === 1) {
      return { action: 'none', reason: 'clarify', evc: 0, budgetLeft };
    }
    // §4: circuit breaker tripped.
    if (ctx?.tripped === true || isTripped(atMs)) {
      return { action: 'none', reason: 'tripped', evc: 0, budgetLeft };
    }

    const stabilityGuarded = isLowStability(channels);
    const evidenceActive = bit(channels?.evidence_need_active) === 1
      || num(channels?.evidence_need, 0) >= cfg.evidence_enter_threshold;
    const evList = mode === 'reassessment' ? evidenceTimestamps : shadowEvidenceTimestamps;
    const evidenceBudgetLeft = evidenceBudgetLeftAt(atMs, evList);

    const tryEvidence = (evcVal, countedTrigger = false) => {
      if (!evidenceActive || evidenceBudgetLeft <= 0) return null;
      if (ctx?.shortTrivial === true && bit(features?.uncertainty) === 0 && bit(features?.novelty) === 0) {
        return null;
      }
      if (mode === 'reassessment') {
        if (!countedTrigger) counts.trigger_episodes++;
        return {
          action: 'evidence',
          reason: 'evidence_need_active',
          evc: evcVal,
          budgetLeft,
          evidenceBudgetLeft,
          stabilityGuarded,
        };
      }
      if (!countedTrigger) counts.shadow_trigger_episodes++;
      counts.shadow_evidence++;
      shadowEvidenceTimestamps.push(atMs);
      return {
        action: 'none',
        reason: 'mode_off',
        evc: evcVal,
        budgetLeft,
        evidenceBudgetLeft,
        stabilityGuarded,
      };
    };

    const reassessment = num(channels?.reassessment, 0);
    if (active !== 1 || reassessment < cfg.enter_threshold) {
      return tryEvidence(0, false) || { action: 'none', reason: 'inactive', evc: 0, budgetLeft, stabilityGuarded };
    }

    const contradiction = bit(features?.contradiction);
    const urgency = bit(features?.urgency);
    const prevEscNeg = ctx?.lastEscalationNeg !== undefined ? Boolean(ctx.lastEscalationNeg) : lastEscalationWasNeg;
    const rawEvc = computeEvc(channels, features, ctx);

    let candidateAction = 'none';
    let candidateReason = 'none';
    let candidateEvc = rawEvc;

    if (reassessment > cfg.overload_threshold) {
      candidateAction = 'stop';
      candidateReason = 'overload';
    } else if (budgetLeft <= 0 || cfg.budget_per_turn <= 0) {
      candidateAction = 'stop';
      candidateReason = 'budget_exhausted';
    } else if (stabilityGuarded && prevEscNeg) {
      candidateAction = 'stop';
      candidateReason = 'low_stability_after_neg';
    } else if (ctx?.brainsReady === false) {
      candidateAction = 'none';
      candidateReason = 'brains_not_ready';
      candidateEvc = -Infinity;
    } else if (ctx?.isAuto === false) {
      candidateAction = 'none';
      candidateReason = 'not_auto_model';
      candidateEvc = -Infinity;
    } else if (ctx?.gpuBusy === true) {
      candidateAction = 'none';
      candidateReason = 'gpu_busy';
      candidateEvc = -Infinity;
    } else if (ctx?.shortTrivial === true && contradiction === 0 && urgency === 0) {
      candidateAction = 'none';
      candidateReason = 'short_trivial';
      candidateEvc = -Infinity;
    } else if (rawEvc <= 0) {
      candidateAction = 'none';
      candidateReason = 'evc_negative';
    } else {
      candidateAction = 'escalate';
      candidateReason = 'reassessment_optimum';
    }

    // Voice turns keep 26B warm-only: block cold escalation while still allowing stop hints.
    if (candidateAction === 'escalate' && !cfg.voice_cold_escalation && ctx?.voice === true && ctx?.mainActive !== true) {
      candidateAction = 'none';
      candidateReason = 'voice_cold';
    }

    if (candidateAction === 'none') {
      const evDecision = tryEvidence(candidateEvc, true);
      if (evDecision) {
        if (mode === 'reassessment') {
          counts.trigger_episodes++;
          if (stabilityGuarded) counts.stability_guard_count++;
        } else {
          counts.shadow_trigger_episodes++;
        }
        return evDecision;
      }
    }

    if (mode === 'reassessment') {
      counts.trigger_episodes++;
      if (candidateAction === 'stop') counts.stop_report_count++;
      if (stabilityGuarded && candidateAction !== 'escalate') counts.stability_guard_count++;
      return {
        action: candidateAction,
        reason: candidateReason,
        evc: candidateEvc,
        budgetLeft,
        stabilityGuarded,
      };
    }

    // Lead decision (4): in 'off' mode, evaluate in shadow without applying action.
    counts.shadow_trigger_episodes++;
    if (candidateAction === 'escalate') {
      counts.shadow_escalate++;
      shadowTimestamps.push(atMs);
    }
    else if (candidateAction === 'stop') counts.shadow_stop++;

    return {
      action: 'none',
      reason: candidateAction === 'none' ? candidateReason : 'mode_off',
      evc: candidateEvc,
      budgetLeft,
      stabilityGuarded,
    };
  }

  function commit(decision) {
    if (!decision || typeof decision !== 'object') return false;
    if (decision.action !== 'escalate') return false;
    if (decision.mode !== undefined && decision.mode !== 'reassessment') return false;
    if (committedDecisions.has(decision)) return false;

    const atMs = safeNow(now);
    const left = budgetLeftAt(atMs, lastQuietFlag === 1);
    if (left <= 0 || cfg.budget_per_turn <= 0) return false;

    committedDecisions.add(decision);
    escalationTimestamps.push(atMs);
    counts.escalation_count++;
    return true;
  }

  function recordOutcome({ escalated = false, verdict = 0, error = false } = {}) {
    const atMs = safeNow(now);
    refreshBreaker(atMs);
    const normalizedVerdict = verdict === 1 ? 1 : verdict === -1 ? -1 : 0;

    if (escalated) {
      if (error) {
        counts.esc_errors++;
        if (normalizedVerdict === -1) counts.esc_neg++;
        consecutiveEscalationFailures++;
        lastEscalationWasNeg = true;
      } else if (normalizedVerdict === 1) {
        counts.esc_pos++;
        consecutiveEscalationFailures = 0;
        lastEscalationWasNeg = false;
      } else if (normalizedVerdict === -1) {
        counts.esc_neg++;
        consecutiveEscalationFailures++;
        lastEscalationWasNeg = true;
      } else {
        counts.esc_unverified++;
        lastEscalationWasNeg = false;
      }

      const escVerified = counts.esc_pos + counts.esc_neg;
      const baseVerified = counts.base_pos + counts.base_neg;
      const escNegRate = escVerified > 0 ? counts.esc_neg / escVerified : 0;
      const baseNegRate = baseVerified > 0 ? counts.base_neg / baseVerified : 0;

      const consecutiveBreach = consecutiveEscalationFailures >= cfg.breaker_consecutive_failures;
      const rateBreach = (normalizedVerdict === -1)
        && escVerified >= cfg.breaker_min_verified
        && (escNegRate - baseNegRate > cfg.breaker_neg_rate_margin);

      if ((consecutiveBreach || rateBreach) && !isTripped(atMs)) {
        trippedUntil = atMs + cfg.breaker_cooldown_ms;
        counts.trip_count++;
      }
      return;
    }

    if (normalizedVerdict === 1) counts.base_pos++;
    else if (normalizedVerdict === -1) counts.base_neg++;
    else counts.base_unverified++;
  }

  function stopHint({ consume = true } = {}) {
    if (stopHintEmitted) return null;
    if (consume === false) return STOP_HINT_TEXT;
    stopHintEmitted = true;
    counts.stop_hint_count++;
    return STOP_HINT_TEXT;
  }

  function evidenceHint({ consume = true, decision = null } = {}) {
    const atMs = safeNow(now);
    const left = evidenceBudgetLeftAt(atMs, evidenceTimestamps);
    if (consume === false) {
      return left > 0 ? EVIDENCE_HINT_TEXT : null;
    }
    if (decision && typeof decision === 'object') {
      if (committedEvidenceDecisions.has(decision)) return null;
      committedEvidenceDecisions.add(decision);
    }
    if (left <= 0 && !(decision && typeof decision === 'object' && decision.action === 'evidence')) {
      return null;
    }
    evidenceTimestamps.push(atMs);
    counts.evidence_count++;
    return EVIDENCE_HINT_TEXT;
  }

  function stats() {
    const atMs = safeNow(now);
    const tripped = isTripped(atMs);
    const dayNow = utc5DayInfo(atMs)?.day ?? null;
    let abGroup = lastAbGroup;
    let abDay = dayNow || lastAbDay;
    if (typeof getConfig === 'function') {
      try {
        const ab = resolveInfluenceAb(getConfig(), atMs);
        abGroup = ab.ab_group;
        abDay = ab.ab_day;
      } catch {}
    } else if (lastAbDay && dayNow && lastAbDay !== dayNow) {
      abGroup = null;
    }
    return {
      ...counts,
      budgetLeft: budgetLeftAt(atMs, lastQuietFlag === 1),
      evidenceBudgetLeft: evidenceBudgetLeftAt(atMs, evidenceTimestamps),
      tripped,
      trippedUntil: tripped ? trippedUntil : null,
      lastEscalationNeg: lastEscalationWasNeg,
      ab_group: abGroup,
      ab_day: abDay,
    };
  }

  return Object.freeze({
    decide,
    commit,
    recordOutcome,
    stopHint,
    evidenceHint,
    stats,
  });
}

module.exports = {
  DEFAULTS,
  STOP_HINT_TEXT,
  EVIDENCE_HINT_TEXT,
  createReassessmentPolicy,
};
