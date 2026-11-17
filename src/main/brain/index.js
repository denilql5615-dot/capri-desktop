'use strict';

// Offline shadow only: nothing here imports Capri, calls models or authorizes actions.
const fs = require('node:fs');
const path = require('node:path');

const CONFIG = Object.freeze({ version: 1, schema_version: 1, max_events: 10000, max_tasks: 1000,
  max_journal_bytes: 32 * 1024 * 1024, max_time_ms: 8640000000000000,
  reassessment_base: 0, evidence_need_base: 0, stability_base: 1,
  reassessment_tau_ms: 600000, evidence_need_tau_ms: 1800000, stability_tau_ms: 14400000,
  enter: 0.65, leave: 0.35, cooldown_ms: 60000,
  utc_offset_minutes: 300, quiet_start_minute: 1380, quiet_end_minute: 420,
  urgency_impulse: 0.25, contradiction_impulse: 0.2, novelty_impulse: 0.2,
  uncertainty_impulse: 0.3, evidence_contradiction_impulse: 0.35,
  error_reassessment_impulse: 0.35, error_stability_impulse: -0.15,
  verified_stability_impulse: 0.1 });
const CHANNELS = ['reassessment', 'evidence_need', 'stability'];
const COMMON = ['type', 'schema_version', 'config_version', 'event_id', 'task_id', 'source_id',
  'source_seq', 'task_seq', 'occurred_at_ms', 'received_at_ms'];
const FIELDS = {
  message: ['origin', 'route', 'novelty', 'uncertainty', 'contradiction', 'urgency'],
  tool_result: ['outcome', 'duration_ms'],
  error: ['error_kind'],
  task_completed: ['outcome', 'validation'],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (reason) => { throw new Error(`brain: ${reason}`); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const own = (v, k) => Object.hasOwn(v, k);
function keys(v, required, optional = []) {
  if (!object(v) || required.some((k) => !own(v, k)) || Reflect.ownKeys(v).some((k) => !required.includes(k) && !optional.includes(k))) fail('schema');
  if (Object.values(Object.getOwnPropertyDescriptors(v)).some((d) => !d.enumerable || !own(d, 'value'))) fail('schema data fields');
}
function number(v, min, max, integer = false) {
  if (!Number.isFinite(v) || v < min || v > max || (integer && !Number.isSafeInteger(v))) fail('number');
}
const time = (v) => number(v, 0, CONFIG.max_time_ms, true);
function choice(v, values) { if (!values.includes(v)) fail('enum'); }
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (object(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function validateEvent(e) {
  if (!object(e) || !own(FIELDS, e.type)) fail('event type');
  keys(e, [...COMMON, ...FIELDS[e.type]], e.type === 'message' ? ['prediction'] : e.type === 'task_completed' ? ['utility'] : []);
  if (e.schema_version !== CONFIG.schema_version || e.config_version !== CONFIG.version) fail('version');
  for (const k of ['event_id', 'task_id', 'source_id']) if (typeof e[k] !== 'string' || !UUID.test(e[k])) fail('UUID v4');
  for (const k of ['source_seq', 'task_seq']) number(e[k], 1, Number.MAX_SAFE_INTEGER, true);
  time(e.occurred_at_ms); time(e.received_at_ms);
  if (e.type === 'message') {
    choice(e.origin, ['user', 'system']); choice(e.route, ['local', 'worker', 'computer', 'unknown']);
    for (const k of ['novelty', 'uncertainty', 'contradiction', 'urgency']) choice(e[k], [0, 1]);
    if (own(e, 'prediction')) number(e.prediction, -1, 1);
  } else if (e.type === 'tool_result') {
    choice(e.outcome, ['ok', 'failed', 'cancelled', 'unknown']);
    number(e.duration_ms, 0, CONFIG.max_time_ms, true);
  } else if (e.type === 'error') {
    choice(e.error_kind, ['validation', 'timeout', 'unavailable', 'quota', 'execution', 'unknown']);
  } else {
    choice(e.outcome, ['completed', 'failed', 'cancelled', 'unknown']);
    choice(e.validation, ['verified', 'unverified']);
    if (e.validation === 'verified') {
      choice(e.outcome, ['completed', 'failed']);
      if (!own(e, 'utility')) fail('missing utility');
      number(e.utility, -1, 1);
    } else if (own(e, 'utility')) fail('unverified utility');
  }
  // Only validated primitive fields cross the caller boundary.
  return { ...e };
}
function quiet(at) {
  const minute = ((Math.floor(at / 60000) + CONFIG.utc_offset_minutes) % 1440 + 1440) % 1440;
  return Number(minute >= CONFIG.quiet_start_minute || minute < CONFIG.quiet_end_minute);
}
function initial() {
  return { time_ms: 0, record_count: 0, event_count: 0, task_count: 0,
    reassessment: 0, evidence_need: 0, stability: 1,
    reassessment_active: 0, evidence_need_active: 0, stability_active: 0,
    circadian_quiet: quiet(0), rpe_count: 0, last_rpe: 0 };
}

function createShadow({ append } = {}) {
  if (append !== undefined && typeof append !== 'function') fail('append callback');
  let state = initial();
  let poisoned = false;
  const seen = new Map(), tasks = new Map(), sources = new Map();
  const transitions = Object.fromEntries(CHANNELS.map((c) => [c, null]));
  const impulses = { ...transitions };
  const snapshot = () => ({ ...state });
  const header = { kind: 'header', schema_version: CONFIG.schema_version, config: CONFIG };
  function write(record) {
    if (!append) return;
    try {
      const result = append(`${canonical(record)}\n`);
      if (result && typeof result.then === 'function') fail('append must be synchronous');
    } catch (err) {
      poisoned = true; // A partial write cannot safely be retried in this session.
      throw err;
    }
  }
  function ready() {
    if (poisoned) fail('journal writer poisoned');
    if (state.record_count >= CONFIG.max_events) fail('session event limit');
  }
  function advance(at, e) {
    const next = { ...state, time_ms: Math.max(state.time_ms, at), record_count: state.record_count + 1 };
    const dt = next.time_ms - state.time_ms;
    for (const c of CHANNELS) {
      const base = CONFIG[`${c}_base`];
      next[c] = base + (state[c] - base) * Math.exp(-dt / CONFIG[`${c}_tau_ms`]);
    }
    const delta = { reassessment: 0, evidence_need: 0, stability: 0 };
    if (e?.type === 'message') {
      delta.reassessment = CONFIG.urgency_impulse * e.urgency + CONFIG.contradiction_impulse * e.contradiction;
      delta.evidence_need = CONFIG.novelty_impulse * e.novelty + CONFIG.uncertainty_impulse * e.uncertainty + CONFIG.evidence_contradiction_impulse * e.contradiction;
    }
    if (e?.type === 'error') {
      delta.reassessment = CONFIG.error_reassessment_impulse;
      delta.stability = CONFIG.error_stability_impulse;
    }
    const task = e && tasks.get(e.task_id);
    if (e?.type === 'task_completed' && !task.terminal && e.validation === 'verified') {
      delta.stability = CONFIG.verified_stability_impulse * e.utility;
      if (task.prediction !== undefined) {
        next.rpe_count++;
        next.last_rpe = e.utility - task.prediction;
      }
    }
    const changed = { ...transitions };
    const applied = { ...impulses };
    for (const c of CHANNELS) {
      if (delta[c] !== 0 && (applied[c] === null || next.time_ms - applied[c] >= CONFIG.cooldown_ms)) {
        next[c] += delta[c];
        applied[c] = next.time_ms;
      }
      next[c] = Math.max(0, Math.min(1, next[c]));
      const signal = c === 'stability' ? 1 - next[c] : next[c];
      const active = `${c}_active`;
      if (changed[c] === null || next.time_ms - changed[c] >= CONFIG.cooldown_ms) {
        if ((!next[active] && signal >= CONFIG.enter) || (next[active] && signal <= CONFIG.leave)) {
          next[active] = 1 - next[active];
          changed[c] = next.time_ms;
        }
      }
    }
    next.circadian_quiet = quiet(next.time_ms);
    return { next, changed, applied };
  }
  function ingest(envelope) {
    // No validation, ID generation, logging or counters for private/unknown activity.
    if (envelope?.privacy !== 'ordinary') return { status: 'discarded' };
    keys(envelope, ['privacy', 'event']);
    if (poisoned) fail('journal writer poisoned');
    const e = validateEvent(envelope.event), encoded = canonical(e);
    if (seen.has(e.event_id)) {
      if (seen.get(e.event_id) !== encoded) fail('conflicting event ID');
      return { status: 'duplicate', state: snapshot() };
    }
    ready();
    if (e.source_seq !== (sources.get(e.source_id) || 0) + 1) fail('source sequence');
    const task = tasks.get(e.task_id);
    if (!task) {
      if (e.type !== 'message' || e.task_seq !== 1 || e.route !== 'unknown') fail('task must begin before route');
      if (tasks.size >= CONFIG.max_tasks) fail('session task limit');
    } else {
      if (task.source !== e.source_id || e.task_seq !== task.seq + 1) fail('task sequence/source');
      if (own(e, 'prediction')) fail('prediction is initial only');
    }
    const { next, changed, applied } = advance(e.occurred_at_ms, e);
    next.event_count++;
    next.task_count = tasks.size + Number(!task);
    write({ kind: 'event', event: e, state: next });
    state = next;
    Object.assign(transitions, changed);
    Object.assign(impulses, applied);
    seen.set(e.event_id, encoded);
    sources.set(e.source_id, e.source_seq);
    tasks.set(e.task_id, { source: e.source_id, seq: e.task_seq,
      prediction: task ? task.prediction : e.prediction,
      terminal: Boolean(task?.terminal || e.type === 'task_completed') });
    return { status: 'accepted', state: snapshot() };
  }
  function tick(envelope) {
    if (envelope?.privacy !== 'ordinary') return { status: 'discarded' };
    keys(envelope, ['privacy', 'at_ms']); time(envelope.at_ms); ready();
    const { next, changed, applied } = advance(envelope.at_ms);
    write({ kind: 'tick', at_ms: envelope.at_ms, state: next });
    state = next; Object.assign(transitions, changed); Object.assign(impulses, applied);
    return { status: 'accepted', state: snapshot() };
  }
  // Header is emitted once for a newly created stream; replay suppresses output.
  write(header);
  return { ingest, tick, snapshot };
}

function replay(ndjson) {
  if (typeof ndjson !== 'string' || Buffer.byteLength(ndjson) > CONFIG.max_journal_bytes || !ndjson.endsWith('\n')) fail('journal size/torn tail');
  const lines = ndjson.slice(0, -1).split('\n');
  if (lines.length > CONFIG.max_events + 1) fail('journal record limit');
  let rows;
  try { rows = lines.map((line) => JSON.parse(line)); } catch { fail('corrupt journal'); }
  if (rows.some((row, i) => canonical(row) !== lines[i])) fail('noncanonical/corrupt journal');
  const expected = { kind: 'header', schema_version: CONFIG.schema_version, config: CONFIG };
  if (canonical(rows[0]) !== canonical(expected)) fail('journal config/header mismatch');
  const brain = createShadow();
  for (const row of rows.slice(1)) {
    let result;
    if (row?.kind === 'event') {
      keys(row, ['kind', 'event', 'state']);
      result = brain.ingest({ privacy: 'ordinary', event: row.event });
    } else if (row?.kind === 'tick') {
      keys(row, ['kind', 'at_ms', 'state']);
      result = brain.tick({ privacy: 'ordinary', at_ms: row.at_ms });
    } else fail('journal record kind');
    if (result.status !== 'accepted' || canonical(result.state) !== canonical(row.state)) fail('journal state mismatch');
  }
  return brain;
}

function openJournal(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('absolute journal path required');
  let bytes;
  try {
    // Bound allocation even when an existing file is unexpectedly large.
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size > CONFIG.max_journal_bytes) fail('journal size');
      bytes = Buffer.alloc(size);
      if (fs.readSync(fd, bytes, 0, size, 0) !== size) fail('journal changed during read');
      if (fs.fstatSync(fd).size !== size) fail('journal changed during read');
    } finally { fs.closeSync(fd); }
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  let expectedBytes = bytes?.length;
  const append = (line) => {
    const nextBytes = expectedBytes + Buffer.byteLength(line);
    if (fs.statSync(file).size !== expectedBytes) fail('journal changed since open');
    if (nextBytes > CONFIG.max_journal_bytes) fail('journal size');
    fs.appendFileSync(file, line, 'utf8');
    expectedBytes = nextBytes;
  };
  if (bytes === undefined) {
    // wx refuses an existing file, including a concurrent creator: never truncate.
    const header = canonical({ kind: 'header', schema_version: CONFIG.schema_version, config: CONFIG });
    fs.writeFileSync(file, `${header}\n`, { flag: 'wx', encoding: 'utf8' });
    expectedBytes = Buffer.byteLength(header) + 1;
    return restoreWriter(`${header}\n`, append);
  }
  return restoreWriter(bytes.toString('utf8'), append);
}
function restoreWriter(ndjson, append) {
  // Rebuild once with a gated writer to retain dedup/terminal/transition state.
  replay(ndjson); // Validate every stored result before any append can occur.
  let live = false;
  const brain = createShadow({ append: (line) => { if (live) return append(line); } });
  for (const line of ndjson.trimEnd().split('\n').slice(1)) {
    const row = JSON.parse(line);
    if (row.kind === 'event') brain.ingest({ privacy: 'ordinary', event: row.event });
    else brain.tick({ privacy: 'ordinary', at_ms: row.at_ms });
  }
  live = true;
  return brain;
}

module.exports = { CONFIG, createShadow, replay, openJournal };
