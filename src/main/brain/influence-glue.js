'use strict';

// Connects Stage 6 `reassessment-policy` and `shadowHook.peekChannels` cleanly on local turns.
// Pure/fail-safe: exceptions or disabled/non-local/Tor/RP turns return the neutral decision.

const SHORT_TRIVIAL_LEN = 12;
const NEUTRAL = Object.freeze({ main: false, hint: null, decision: null, escalated: false });

function createNeutral() {
  return { ...NEUTRAL };
}

function stripBrainHints(messages) {
  return Array.isArray(messages) ? messages.filter((m) => !m?.brainHint) : [];
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
    const mode = cfg.brainInfluence === 'reassessment' ? 'reassessment' : 'off';
    const decision = policy.decide({
      channels,
      features,
      ctx: {
        mode,
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

module.exports = { planInfluence, commitInfluence, stripBrainHints, SHORT_TRIVIAL_LEN };
