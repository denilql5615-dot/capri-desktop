'use strict';

// Connects Stage 6 `reassessment-policy` and `shadowHook.peekChannels` cleanly on local turns.
// Pure/fail-safe: exceptions or disabled/non-local/Tor/RP turns return the neutral decision.

const SHORT_TRIVIAL_LEN = 12;
const DAY_MS = 86400000;
const UTC5_OFFSET_MS = 5 * 60 * 60 * 1000; // fixed UTC+5 (Yekaterinburg/Tashkent, no DST)
const NEUTRAL = Object.freeze({ main: false, hint: null, decision: null, escalated: false });

function createNeutral() {
  return { ...NEUTRAL };
}

function stripBrainHints(messages) {
  return Array.isArray(messages) ? messages.filter((m) => !m?.brainHint) : [];
}

function parseUtc5DayIndex(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const dt = new Date(utc);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.floor(utc / DAY_MS);
}

function utc5DayInfo(nowMs = Date.now()) {
  const n = Number(nowMs);
  if (!Number.isFinite(n)) return null;
  const dayIndex = Math.floor((Math.trunc(n) + UTC5_OFFSET_MS) / DAY_MS);
  const dt = new Date(dayIndex * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return { dayIndex, day: `${y}-${m}-${d}` };
}

/**
 * Resolves effective Stage 6 mode and A/B day tag in fixed UTC+5 calendar days:
 * even day distance from `cfg.brainInfluenceAbStart` -> 'reassessment' (group B), odd -> 'off' (group A).
 * Invalid/missing start date or timestamp fails closed to 'off' (group null).
 */
function resolveInfluenceAb(cfg, nowMs = Date.now()) {
  const info = utc5DayInfo(nowMs);
  const ab_day = info ? info.day : null;
  const raw = cfg?.brainInfluence;
  if (raw === 'reassessment') {
    return { mode: 'reassessment', ab_group: null, ab_day };
  }
  if (raw === 'ab') {
    const startIndex = parseUtc5DayIndex(cfg?.brainInfluenceAbStart);
    if (startIndex === null || !info) {
      return { mode: 'off', ab_group: null, ab_day };
    }
    const even = Math.abs(info.dayIndex - startIndex) % 2 === 0;
    return {
      mode: even ? 'reassessment' : 'off',
      ab_group: even ? 'B' : 'A',
      ab_day,
    };
  }
  return { mode: 'off', ab_group: null, ab_day };
}

function effectiveInfluenceMode(cfg, nowMs = Date.now()) {
  return resolveInfluenceAb(cfg, nowMs).mode;
}

/**
 * Evaluates Stage 6 reassessment influence before `prepLocal` on an ordinary local turn.
 * Never throws; calls `policy.commit` on `escalate` and `policy.stopHint` on `stop`.
 */
function planInfluence({
  cfg,
  said,
  messages,
  route = { worker: null },
  quick = false,
  hook,
  policy,
  ab,
  env = {},
  salience,
  contextMentionsTor,
  tor,
} = {}) {
  try {
    if (!cfg || cfg.brainShadow !== true || cfg.provider !== 'ollama' || env?.local !== true
        || !policy || typeof policy.decide !== 'function') {
      return createNeutral();
    }
    const isRp = Boolean(env?.rp ?? (cfg.rp === true));
    if (!route || typeof route !== 'object' || route.worker !== null || route.computer || quick || env?.quick === true || isRp) {
      return createNeutral();
    }
    const text = typeof said === 'string' ? said : '';
    const torApi = tor || require('../tor');
    const torScreen = typeof contextMentionsTor === 'function'
      ? contextMentionsTor
      : require('./shadow-hook').contextMentionsTor;
    const screenMsgs = messages !== undefined ? messages : [{ role: 'user', content: text }];
    if (env?.tor === true || hook?.isTorBlocked?.() || torScreen(screenMsgs, torApi)) {
      return createNeutral();
    }
    if (!hook || typeof hook.peekChannels !== 'function') {
      return createNeutral();
    }
    const computeSalience = typeof salience === 'function' ? salience : require('./amygdala').salience;
    const features = computeSalience(text);
    const channels = hook.peekChannels(env?.now, features);
    if (!channels) {
      return createNeutral();
    }
    const preAb = ab && typeof ab === 'object' ? ab : (env?.ab && typeof env.ab === 'object' ? env.ab : null);
    const resolvedAb = preAb || resolveInfluenceAb(cfg, env?.now !== undefined ? env.now : Date.now());
    const decision = policy.decide({
      channels,
      features,
      ctx: {
        mode: resolvedAb.mode,
        ab_group: resolvedAb.ab_group,
        ab_day: resolvedAb.ab_day,
        brainsReady: Boolean(env?.brainsReady),
        isAuto: Boolean(env?.isAuto),
        wantsFast: Boolean(env?.wantsFast),
        wantsMain: Boolean(env?.wantsMain),
        wantsLocal: Boolean(env?.wantsLocal),
        mainActive: Boolean(env?.mainActive),
        gpuBusy: Boolean(env?.gpuBusy),
        voice: Boolean(env?.voice),
        rp: false,
        tor: false,
        shortTrivial: text.trim().length < SHORT_TRIVIAL_LEN,
      },
    });
    if (!decision || typeof decision !== 'object') {
      return createNeutral();
    }
    if (decision.action === 'escalate') {
      return { main: true, hint: null, decision, escalated: true };
    }
    if (decision.action === 'stop') {
      const hint = typeof policy.stopHint === 'function' ? (policy.stopHint({ consume: false }) || null) : null;
      return { main: false, hint, decision, escalated: false };
    }
    return { main: false, hint: null, decision, escalated: false };
  } catch {
    return createNeutral();
  }
}

/**
 * Commits an escalation budget slot or series stop-hint only after the local turn actually executed.
 */
function commitInfluence(policy, plan, { escalated = plan?.escalated, hintDelivered = Boolean(plan?.hint), aborted = false, tor = false, error = false } = {}) {
  if (!policy || !plan || aborted || tor) return false;
  try {
    if (escalated && plan.decision?.action === 'escalate' && typeof policy.commit === 'function') {
      return Boolean(policy.commit(plan.decision));
    }
    if (!error && hintDelivered && plan.hint && typeof policy.stopHint === 'function') {
      return Boolean(policy.stopHint({ consume: true }));
    }
  } catch {}
  return false;
}

module.exports = {
  planInfluence,
  commitInfluence,
  stripBrainHints,
  effectiveInfluenceMode,
  resolveInfluenceAb,
  utc5DayInfo,
  SHORT_TRIVIAL_LEN,
};
