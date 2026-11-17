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

const NOOP_TURN = Object.freeze({ complete() {}, fail() {}, cancel() {} });

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
} = {}) {
  const buffer = createTaskBuffer(bufferOptions);
  const counts = { published: 0, discarded: 0, observer_errors: 0 };
  const activeTurns = new Set();
  let journal = null;
  let disabled = false;
  let closed = false;
  let closing = null;
  let writeChain = Promise.resolve();

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
    if (disabled || closed) { counts.discarded++; return; }
    const envelopes = batch.map((event) => ({ privacy: 'ordinary', event }));
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
    });
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

  function openTurnOnRoot(root, signal) {
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
      contradiction: 0,
      urgency: 0,
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
      return openTurnOnRoot(root, opts?.signal);
    } catch {
      counts.observer_errors++;
      if (root) buffer.cancel(root);
      return NOOP_TURN;
    }
  }

  async function withTurn(route, opts, fn) {
    const callback = typeof opts === 'function' && fn === undefined ? opts : fn;
    const options = typeof opts === 'function' && fn === undefined ? undefined : opts;
    if (!isEligible(route, options)) return callback(NOOP_TURN);
    return buffer.withTask('ordinary', async (root) => {
      let turn = NOOP_TURN;
      try {
        turn = openTurnOnRoot(root, options?.signal);
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
    try { await writeChain; } catch {}
  }

  function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
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

  return Object.freeze({
    start,
    withTurn,
    stats: () => ({ ...counts }),
    flush,
    close,
  });
}

module.exports = { createShadowHook, classifyError };
