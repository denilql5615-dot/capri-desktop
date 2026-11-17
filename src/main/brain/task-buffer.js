'use strict';

// Offline in-memory task buffer for brain v1. Not connected to Capri, core ingest or the journal.
// A task's events are held here and returned as ONE immutable batch only when the root is
// finished, sealed, every descendant is closed and everything stayed ordinary. Anything
// private, unknown, cancelled, overflowing or inconsistent discards the whole task with no
// counters, summaries or IDs about it. No I/O, timers, randomness or ID generation.
// Identity = closure + WeakMap handles issued here; strings/objects/clones confer nothing.
// This is in-process API separation, not a sandbox, and a trusted caller still certifies that
// a root is ordinary (only local chat/quick replies in the first pilot; agent/tool routes never).
const { sanitize, canonical } = require('./index');

const RANK = { ordinary: 0, unknown: 1, tor: 2, dark: 2 };
const DEFAULTS = Object.freeze({ max_tasks: 16, max_events: 64, max_bytes: 32 * 1024 });
const DISCARDED = Object.freeze({ status: 'discarded' });

function limit(name, value, ceiling) {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new TypeError(`${name} must be 1..${ceiling}`);
  return value;
}
function cls(value) {
  if (typeof value !== 'string' || !Object.hasOwn(RANK, value)) throw new TypeError('classification: ordinary|unknown|tor|dark');
  return value;
}

function createTaskBuffer(options = {}) {
  const max_tasks = limit('max_tasks', options.max_tasks ?? DEFAULTS.max_tasks, 256);
  const max_events = limit('max_events', options.max_events ?? DEFAULTS.max_events, 1024);
  const max_bytes = limit('max_bytes', options.max_bytes ?? DEFAULTS.max_bytes, 1024 * 1024);
  const nodes = new WeakMap(); // handle -> { task, cls, closed, root }
  let active = 0; // tasks holding a buffer; only ordinary roots take a slot

  const mint = (node) => { const h = Object.freeze(Object.create(null)); nodes.set(h, node); return h; };
  const node = (h) => (h !== null && typeof h === 'object' ? nodes.get(h) : undefined);
  function release(task) { // idempotent: free the slot and every retained event
    if (task.slot) { task.slot = false; active--; }
    task.events = []; task.bytes = 0; task.sealed = true;
    task.task_id = null; task.source_id = null; task.seq = 0; task.seen = new Set(); task.done = false; // keep no metadata
  }
  function taint(task) { task.tainted = true; release(task); } // sealed, empty, can never publish

  // Root classification is supplied only by the trusted caller; default unknown (never published).
  function open(classification = 'unknown') {
    let c = cls(classification);
    if (c === 'ordinary' && active >= max_tasks) c = 'unknown';
    const task = { tainted: c !== 'ordinary', sealed: false, slot: false, events: [], bytes: 0, open: 0, task_id: null, source_id: null, seq: 0, seen: new Set(), done: false };
    if (c === 'ordinary') { active++; task.slot = true; }
    else release(task); // non-ordinary or capacity-full: nothing is ever retained
    return mint({ task, cls: c, closed: false, root: true });
  }

  // A child is never softer than its parent; a non-ordinary child discards the whole task.
  function child(parent, requested) {
    const p = node(parent);
    if (!p) throw new TypeError('parent handle is not authentic');
    const asked = requested === undefined ? p.cls : cls(requested);
    const c = RANK[asked] > RANK[p.cls] ? asked : p.cls;
    if (c !== 'ordinary') taint(p.task);
    if (p.closed || p.task.sealed || p.task.tainted) return mint({ task: p.task, cls: c, closed: true, root: false });
    p.task.open++;
    return mint({ task: p.task, cls: c, closed: false, root: false });
  }

  function close(handle) {
    const n = node(handle);
    if (!n || n.root) throw new TypeError('child handle required');
    if (!n.closed) { n.closed = true; if (!n.task.sealed) n.task.open--; }
  }

  // Excluded or inauthentic input is judged before the event is touched: no getters run.
  function add(handle, event) {
    const n = node(handle);
    if (!n || n.task.sealed || n.closed) return DISCARDED;
    if (n.cls !== 'ordinary') { taint(n.task); return DISCARDED; }
    const t = n.task;
    let copy;
    try { copy = sanitize('event', { privacy: 'ordinary', event }).event; } catch (err) { taint(t); throw err; }
    // Batch must replay in the core: one dedicated source and task, contiguous sequences from 1,
    // initial message with route unknown, prediction only there, no duplicate IDs, nothing after terminal.
    const first = t.events.length === 0;
    const size = Buffer.byteLength(canonical(copy));
    const consistent = !t.done && !t.seen.has(copy.event_id)
      && (first ? copy.type === 'message' && copy.route === 'unknown' && copy.task_seq === 1 && copy.source_seq === 1
        : copy.task_id === t.task_id && copy.source_id === t.source_id && copy.task_seq === t.seq + 1
          && copy.source_seq === t.seq + 1 && !Object.hasOwn(copy, 'prediction'));
    if (!consistent || t.events.length >= max_events || t.bytes + size > max_bytes) { taint(t); return DISCARDED; }
    t.task_id = copy.task_id; t.source_id = copy.source_id; t.seq = copy.task_seq;
    t.seen.add(copy.event_id); t.done = copy.type === 'task_completed';
    t.events.push(Object.freeze(copy)); t.bytes += size;
    return Object.freeze({ status: 'buffered' });
  }

  // Terminal semantics: the last event must be the only task_completed, verified, with
  // outcome completed or failed. A proven ordinary failure is published (measured failure);
  // cancelled/unknown/unverified outcomes carry no verified result and are discarded.
  function finish(root) {
    const n = node(root);
    if (!n || !n.root || n.task.sealed) return DISCARDED;
    const t = n.task;
    const last = t.events[t.events.length - 1];
    const terminal = t.events.filter((e) => e.type === 'task_completed');
    const ok = !t.tainted && n.cls === 'ordinary' && t.open === 0 && terminal.length === 1 && last === terminal[0]
      && last.validation === 'verified' && (last.outcome === 'completed' || last.outcome === 'failed');
    const batch = ok ? Object.freeze(t.events.slice()) : null;
    release(t); // sealed before returning: later add/child on any node is refused
    return batch ? Object.freeze({ status: 'published', batch }) : DISCARDED;
  }

  function cancel(root) {
    const n = node(root);
    if (n?.root) release(n.task);
    return DISCARDED;
  }

  // Scoped async lifecycle: always cancels the root in finally so abandoned tasks cannot leak slots.
  async function withTask(classification, fn) {
    const run = typeof classification === 'function' && fn === undefined ? classification : fn;
    const level = typeof classification === 'function' && fn === undefined ? 'unknown' : classification;
    if (typeof run !== 'function') throw new TypeError('task callback must be a function');
    const root = open(level);
    try { return await run(root); } finally { cancel(root); }
  }

  return Object.freeze({ open, child, close, add, finish, cancel, withTask });
}

module.exports = { createTaskBuffer, DEFAULTS };
