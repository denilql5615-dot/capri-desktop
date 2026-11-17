'use strict';

// Passive shadow observer hook for Capri's local chat path. Off by default via cfg.brainShadow.
// Never throws on the reply path, never awaits disk I/O during chat:send, and never leaks text,
// paths, model names, error messages or renderer IDs into the journal.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { CONFIG } = require('./index');
const { createTaskBuffer } = require('./task-buffer');
const { openRotatingJournal, MAX_DAY_TIME_MS } = require('./rotating-journal');
const { freezeSnapshot } = require('./snapshot');
const { verdictOf } = require('./amygdala');

const NOOP_TURN = Object.freeze({ complete() {}, fail() {}, cancel() {} });
const MAX_PENDING_WRITES = 64; // own publish chain is bounded too, not only the journal's queue
const DEFAULT_PENDING_TTL_MS = 120000;
const bit = (v) => (v === 1 ? 1 : 0);

// Fail-closed Tor screen over the WHOLE chat context (every role, every turn), not only the last
// message: any Tor/dark wording or .onion link anywhere, or a message shape we cannot read as text,
// means the turn is not observed. Predicates are injected (main passes tor.js).
function contextMentionsTor(messages, { wantsTor, onionLink }) {
  if (!Array.isArray(messages)) return true;
  for (const m of messages) {
    const c = m?.content;
    let parts;
    if (typeof c === 'string') parts = [c];
    else if (Array.isArray(c)) {
      parts = [];
      for (const part of c) {
        if (typeof part === 'string') parts.push(part);
        else if (part && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text);
        else if (!(part && typeof part === 'object' && part.type && part.type !== 'text')) return true;
      }
    } else if (c === undefined || c === null) parts = [];
    else return true;
    for (const text of parts) if (wantsTor(text) || onionLink(text)) return true;
  }
  return false;
}

function safeTime(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const t = Math.trunc(n);
  return Math.max(0, Math.min(MAX_DAY_TIME_MS, t));
}

function isAbort(err, signal) {
  return Boolean(signal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.message === 'stopped');
}

function classifyError(err) {
  const code = String(err?.code || '').toUpperCase();
  const name = String(err?.name || '');
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || name === 'TimeoutError') return 'timeout';
  if (code === 'QUOTA' || err?.status === 429) return 'quota';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'GONE' || code === 'BUSY' || code === 'OFFLINE') return 'unavailable';
  if (code === 'ERR_INVALID_ARG_TYPE' || name === 'TypeError' || name === 'RangeError') return 'validation';
  return 'execution';
}

function createShadowHook({
  dir,
  now = Date.now,
  uuid = crypto.randomUUID,
  openJournal = openRotatingJournal,
  bufferOptions,
  pendingTtlMs = DEFAULT_PENDING_TTL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onPendingChange,
  verdictJudge,
} = {}) {
  const buffer = createTaskBuffer(bufferOptions);
  const counts = {
    published: 0,
    discarded: 0,
    observer_errors: 0,
    verified_pos: 0,
    verified_neg: 0,
    unverified: 0,
  };
  const activeTurns = new Set();
  let pending = null;
  let lastNotifiedPending = false;
  let journal = null;
  let disabled = false;
  let closed = false;
  let closing = null;
  let writeChain = Promise.resolve();
  let judgeChain = Promise.resolve();
  let deferredJudge = null;
  let judgeEpoch = 0;
  let pendingWrites = 0;

  function notifyPending(next) {
    const val = Boolean(next);
    if (val === lastNotifiedPending) return;
    lastNotifiedPending = val;
    if (typeof onPendingChange === 'function') {
      try { onPendingChange(val); } catch {}
    }
  }

  function clearPending({ cancel = true, outcome = 'unverified' } = {}) {
    if (!pending) return;
    const entry = pending;
    pending = null;
    if (outcome === 'pos') counts.verified_pos++;
    else if (outcome === 'neg') counts.verified_neg++;
    else if (outcome === 'unverified') counts.unverified++;
    notifyPending(false);
    if (entry.timer != null) {
      try { clearTimer(entry.timer); } catch {}
    }
    if (cancel) {
      try { entry.turn.cancel(); } catch { counts.observer_errors++; }
    }
  }

  async function ensureJournal() {
    if (journal) return journal;
    if (disabled) return null;
    if (typeof dir !== 'string' || !dir) throw new Error('invalid shadow journal dir');
    await fsp.mkdir(dir, { recursive: true });
    const opened = await openJournal(dir);
    if (!opened || typeof opened.appendBatch !== 'function') throw new Error('invalid shadow journal');
    journal = opened;
    return journal;
  }

  function enqueuePublish(batch) {
    if (disabled || closed || pendingWrites >= MAX_PENDING_WRITES) { counts.discarded++; return; }
    const envelopes = batch.map((event) => ({ privacy: 'ordinary', event }));
    pendingWrites++;
    writeChain = writeChain.then(async () => {
      if (disabled) { counts.discarded++; return; }
      let j;
      try {
        j = await ensureJournal();
      } catch {
        disabled = true; // journal open failed: stay quiet until restart
        counts.observer_errors++;
        return;
      }
      if (!j) { counts.discarded++; return; }
      try {
        const res = await j.appendBatch(envelopes);
        if (res?.status === 'accepted' || res?.status === 'duplicate') counts.published++;
        else counts.discarded++;
      } catch {
        counts.observer_errors++;
      }
    }).finally(() => { pendingWrites--; });
  }

  function isEligible(route, opts) {
    if (disabled || closed) return false;
    if (!route || typeof route !== 'object') return false;
    if (opts?.rp === true || opts?.quick === true || opts?.cloudFallback === true || opts?.local === false) return false;
    if (opts?.signal?.aborted) return false;
    let snap;
    try {
      snap = freezeSnapshot(route);
    } catch {
      counts.observer_errors++;
      return false;
    }
    return snap !== null && typeof snap === 'object' && snap.worker === null && !snap.computer;
  }

  function openTurnOnRoot(root, signal, features) {
    const task_id = uuid();
    const source_id = uuid();
    let seq = 0;
    let settled = false;
    const nextEvent = (type, fields) => {
      seq++;
      const at = safeTime(now());
      return {
        type,
        schema_version: CONFIG.schema_version,
        config_version: CONFIG.version,
        event_id: uuid(),
        task_id,
        source_id,
        source_seq: seq,
        task_seq: seq,
        occurred_at_ms: at,
        received_at_ms: at,
        ...fields,
      };
    };

    const initial = buffer.add(root, nextEvent('message', {
      origin: 'user',
      route: 'unknown',
      novelty: 0,
      uncertainty: 0,
      contradiction: bit(features?.contradiction),
      urgency: bit(features?.urgency),
    }));
    if (initial.status !== 'buffered') {
      buffer.cancel(root);
      counts.discarded++;
      return NOOP_TURN;
    }

    let turn;
    const onAbort = () => turn.cancel();
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      if (pending?.turn === turn) clearPending({ cancel: false });
      activeTurns.delete(turn);
      buffer.cancel(root);
    };

    turn = Object.freeze({
      complete(verifiedOpts) {
        if (settled) return;
        settled = true;
        try {
          const isVerified = verifiedOpts?.verified === true;
          const terminal = isVerified
            ? {
                outcome: 'completed',
                validation: 'verified',
                utility: Object.hasOwn(verifiedOpts, 'utility') ? verifiedOpts.utility : 1,
              }
            : { outcome: 'completed', validation: 'unverified' };
          buffer.add(root, nextEvent('task_completed', terminal));
          const res = buffer.finish(root);
          if (res.status === 'published') enqueuePublish(res.batch);
          else counts.discarded++;
        } catch {
          counts.observer_errors++;
        } finally {
          cleanup();
        }
      },
      fail(err) {
        if (settled) return;
        if (isAbort(err, signal)) { turn.cancel(); return; }
        settled = true;
        try {
          buffer.add(root, nextEvent('error', { error_kind: classifyError(err) }));
          // Failures remain unverified until a dedicated verifier adapter exists (BRAIN_V1: no penalty on unavailable/timeout).
          buffer.add(root, nextEvent('task_completed', {
            outcome: 'failed',
            validation: 'unverified',
          }));
          const res = buffer.finish(root);
          if (res.status === 'published') enqueuePublish(res.batch);
          else counts.discarded++;
        } catch {
          counts.observer_errors++;
        } finally {
          cleanup();
        }
      },
      cancel() {
        if (settled) return;
        settled = true;
        try {
          counts.discarded++;
        } catch {
          counts.observer_errors++;
        } finally {
          cleanup();
        }
      },
    });
    activeTurns.add(turn);
    return turn;
  }

  function start(route, opts) {
    if (!isEligible(route, opts)) return NOOP_TURN;
    let root = null;
    try {
      root = buffer.open('ordinary');
      return openTurnOnRoot(root, opts?.signal, opts?.features);
    } catch {
      counts.observer_errors++;
      if (root) buffer.cancel(root);
      return NOOP_TURN;
    }
  }

  function hold(turn) {
    try {
      if (!turn || !activeTurns.has(turn)) return;
      if (disabled || closed) { turn.cancel(); return; }
      clearPending({ cancel: true, outcome: 'unverified' });
      const heldAt = Number(now());
      const entry = { turn, timer: null, heldAt };
      pending = entry;
      entry.timer = setTimer(() => {
        if (pending !== entry) return;
        clearPending({ cancel: true, outcome: 'unverified' });
      }, pendingTtlMs);
      entry.timer?.unref?.();
      notifyPending(true);
    } catch {
      counts.observer_errors++;
      try { turn?.cancel?.(); } catch {}
    }
  }

  function verdict(v) {
    try {
      if (v !== 1 && v !== -1) return false;
      if (disabled || closed || !pending) return false;
      const entry = pending;
      const curNow = Number(now());
      const expired = Number.isFinite(entry.heldAt) && Number.isFinite(curNow) && curNow - entry.heldAt >= pendingTtlMs;
      if (expired) {
        clearPending({ cancel: true, outcome: 'unverified' });
        return false;
      }
      clearPending({ cancel: false, outcome: v === 1 ? 'pos' : 'neg' });
      entry.turn.complete({ verified: true, utility: v });
      return true;
    } catch {
      counts.observer_errors++;
      clearPending({ cancel: true, outcome: 'unverified' });
      return false;
    }
  }

  function enqueueJudge(item) {
    if (!verdictJudge || disabled || closed || !item) return;
    const epoch = judgeEpoch;
    judgeChain = judgeChain.then(() => {
      if (disabled || epoch !== judgeEpoch) return null;
      return verdictJudge.judge(item.text, { dictVerdict: item.dictVerdict });
    }).catch(() => null);
  }

  function runDeferredJudge() {
    if (!deferredJudge || disabled || closed) return;
    const item = deferredJudge;
    deferredJudge = null;
    enqueueJudge(item);
  }

  function resolvePending(messages, opts) {
    if (!pending) return;
    const entry = pending;
    try {
      const curNow = Number(now());
      const expired = Number.isFinite(entry.heldAt) && Number.isFinite(curNow) && curNow - entry.heldAt >= pendingTtlMs;
      if (disabled || closed || expired || opts?.rp === true) {
        deferredJudge = null;
        clearPending({ cancel: true, outcome: 'unverified' });
        return;
      }
      const torPreds = opts?.tor;
      if (!torPreds || typeof torPreds.wantsTor !== 'function' || typeof torPreds.onionLink !== 'function'
          || contextMentionsTor(messages, torPreds)) {
        deferredJudge = null;
        judgeEpoch++;
        try { verdictJudge?.abortAll?.(); } catch {}
        clearPending({ cancel: true, outcome: 'tor' });
        return;
      }
      const said = opts?.said;
      const v = verdictOf(said);
      if (v === 1 || v === -1) {
        clearPending({ cancel: false, outcome: v === 1 ? 'pos' : 'neg' });
        entry.turn.complete({ verified: true, utility: v });
      } else {
        clearPending({ cancel: false, outcome: 'unverified' });
        entry.turn.cancel();
      }
      if (verdictJudge && opts?.judge === 'shadow') {
        const item = { text: typeof said === 'string' ? said : '', dictVerdict: v };
        if (opts?.deferJudge === true) deferredJudge = item;
        else enqueueJudge(item);
      }
    } catch {
      counts.observer_errors++;
      clearPending({ cancel: true, outcome: 'unverified' });
    }
  }

  async function withTurn(route, opts, fn) {
    const callback = typeof opts === 'function' && fn === undefined ? opts : fn;
    const options = typeof opts === 'function' && fn === undefined ? undefined : opts;
    if (!isEligible(route, options)) return callback(NOOP_TURN);
    return buffer.withTask('ordinary', async (root) => {
      let turn = NOOP_TURN;
      try {
        turn = openTurnOnRoot(root, options?.signal, options?.features);
      } catch {
        counts.observer_errors++;
        buffer.cancel(root);
      }
      try {
        const out = await callback(turn);
        if (options?.signal?.aborted) turn.cancel();
        else turn.complete();
        return out;
      } catch (err) {
        turn.fail(err);
        throw err;
      } finally {
        turn.cancel();
      }
    });
  }

  async function flush() {
    runDeferredJudge();
    try { await writeChain; } catch {}
    try { await judgeChain; } catch {}
  }

  function close() {
    if (closing) return closing;
    runDeferredJudge();
    closed = true;
    closing = (async () => {
      clearPending({ cancel: true });
      for (const turn of [...activeTurns]) turn.cancel();
      await flush();
      if (journal) {
        const j = journal;
        journal = null;
        try { await j.close(); } catch { counts.observer_errors++; }
      }
    })();
    return closing;
  }

  // Any Tor activity anywhere in Capri (renderer Tor search, agent tor/dark node, the Tor window):
  // drop the waiting verdict and every turn in flight. Nothing is counted or recorded about it.
  function torTouched() {
    try {
      deferredJudge = null;
      judgeEpoch++;
      try { verdictJudge?.abortAll?.(); } catch {}
      clearPending({ cancel: true, outcome: 'tor' });
      for (const turn of [...activeTurns]) turn.cancel();
    } catch {}
  }

  return Object.freeze({
    start,
    hold,
    resolvePending,
    runDeferredJudge,
    verdict,
    torTouched,
    withTurn,
    stats: () => ({
      ...counts,
      completed_turns: counts.verified_pos + counts.verified_neg + counts.unverified + (pending ? 1 : 0),
      ...(verdictJudge ? verdictJudge.stats() : {}),
    }),
    flush,
    close,
  });
}

module.exports = { contextMentionsTor, MAX_PENDING_WRITES, createShadowHook, classifyError };
