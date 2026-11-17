'use strict';

// Glue between Capri's main chat:send IPC handler and the passive shadow brain observer.
// Kept separate from Electron IPC so chat lifecycle transitions can be tested directly.

function defaultYourWords(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      return typeof m.content === 'string' ? m.content.split('\n\n(Note for you')[0] : '';
    }
  }
  return '';
}

function isAbortLike(err, signal) {
  return Boolean(signal?.aborted || err?.message === 'stopped' || err?.name === 'AbortError' || err?.code === 'ABORT_ERR');
}

/** Stage 5-min barrier: only plain local chat without desktop control is ordinary; workers are unknown. */
function routeClass(route) {
  return route && typeof route === 'object' && route.worker === null && !route.computer ? 'ordinary' : 'unknown';
}

function createChatGlue({
  getHook,
  tor,
  salience,
  contextMentionsTor,
  isLocalModel,
  isTorBlocked,
  yourWords = defaultYourWords,
} = {}) {
  const getSalience = () => (typeof salience === 'function' ? salience : require('./amygdala').salience);
  const getTorScreen = () => (typeof contextMentionsTor === 'function' ? contextMentionsTor : require('./shadow-hook').contextMentionsTor);

  function beforeTurn(messages, cfg) {
    if (cfg?.brainShadow !== true || typeof getHook !== 'function') return;
    try {
      const hook = getHook(false);
      if (!hook) return;
      if ((typeof isTorBlocked === 'function' && isTorBlocked()) || hook.isTorBlocked?.()) {
        hook.torTouched?.();
        return;
      }
      hook.resolvePending(messages, {
        get said() { return yourWords(messages); },
        tor,
        rp: cfg.rp === true,
        judge: cfg.brainVerdictJudge === 'shadow' ? 'shadow' : 'off',
        deferJudge: true,
      });
    } catch {}
  }

  function startLocal(route, messages, cfg, signal) {
    if (cfg?.brainShadow !== true || typeof getHook !== 'function') return null;
    try {
      if (cfg.rp === true || signal?.aborted) return null;
      if (routeClass(route) !== 'ordinary') return null;
      if ((typeof isTorBlocked === 'function' && isTorBlocked()) || getHook(false)?.isTorBlocked?.()) return null;
      if (typeof isLocalModel === 'function' && !isLocalModel(cfg)) return null;
      if (!tor || typeof tor.wantsTor !== 'function' || typeof tor.onionLink !== 'function') return null;
      if (getTorScreen()(messages, tor)) return null;
      const hook = getHook(true);
      if (!hook) return null;
      const features = getSalience()(yourWords(messages));
      return hook.start(route, {
        signal,
        local: true,
        rp: cfg.rp === true,
        features,
      });
    } catch {
      return null;
    }
  }

  function afterSuccess(turn) {
    if (!turn || typeof getHook !== 'function') return;
    try {
      getHook(false)?.hold(turn);
    } catch {}
  }

  function afterError(turn, err, signal) {
    if (!turn) return;
    try {
      if (isAbortLike(err, signal)) turn.cancel?.();
      else turn.fail?.(err);
    } catch {}
  }

  function onModelSwitch(turn) {
    if (!turn) return;
    try {
      turn.cancel?.();
    } catch {}
  }

  function afterTurn(cfg) {
    if ((cfg && cfg.brainShadow !== true) || typeof getHook !== 'function') return;
    try {
      getHook(false)?.runDeferredJudge?.();
    } catch {}
  }

  function dropPending(opts) {
    if (typeof getHook !== 'function') return;
    try {
      getHook(false)?.dropPending?.(opts);
    } catch {}
  }

  function onNonLocalTurn(_route, opts) {
    dropPending(opts);
    return null;
  }

  return Object.freeze({
    beforeTurn,
    startLocal,
    afterSuccess,
    afterError,
    onModelSwitch,
    afterTurn,
    dropPending,
    onNonLocalTurn,
  });
}

module.exports = { createChatGlue, routeClass };
