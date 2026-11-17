'use strict';

// Offline rotating shadow journal. Not connected to Capri IPC or any live path.
// Segments are named YYYY-MM-DD-NNNN.ndjson using explicit logical UTC+5 timestamps.
// Closed segments are never appended to again; deduplication across archives uses
// bounded-memory streaming line inspection (one segment at a time), limited to archives of the
// last `dedup_days` UTC+5 days so per-task cost does not grow with total history. Startup replays
// only the active segment and its predecessor (checkpoint link); older archives were validated
// when they were active and are read only by the windowed dedup scan.
// Single writer per directory is assumed; no fsync (power-loss durability not promised).
const fsp = require('node:fs/promises');
const path = require('node:path');
const { CONFIG, createShadow, replay, sanitize, canonical } = require('./index');

const fail = (reason, cause) => new Error(`brain: ${reason}`, cause ? { cause } : undefined);
class IoPoison extends Error {
  constructor(cause) {
    super(cause?.message || 'io error', { cause });
  }
}
const DEFAULT_QUEUE = 64;
const SEGMENT_RE = /^(\d{4}-\d{2}-\d{2})-(\d{4})\.ndjson$/;
const READ_CHUNK = 64 * 1024;
const UTC5_OFFSET_MS = CONFIG.utc_offset_minutes * 60000;
const DAY_MS = 86400000;
const DEFAULT_DEDUP_DAYS = 7;
// Upper bound whose UTC+5 calendar date still fits a 4-digit year (<= 9999-12-31).
const MAX_DAY_TIME_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999) - UTC5_OFFSET_MS;

// Any finite IEEE-754 double formats to <= 25 UTF-8 bytes in JSON
// (e.g. "-0.00000" + 17 significant digits = 25 bytes). Allow 32 bytes per
// numeric state field (1 byte for "0" in ZERO_STATE + 31 bytes padding).
const STATE_BYTES_PER_NUMERIC_FIELD = 32;
const ZERO_STATE = Object.freeze(
  Object.fromEntries(Object.keys(createShadow().snapshot()).map((k) => [k, 0])),
);
const STATE_NUMERIC_PADDING = Object.keys(ZERO_STATE).length * (STATE_BYTES_PER_NUMERIC_FIELD - 1);

function utc5DayKey(ms) {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_DAY_TIME_MS) {
    throw fail('timestamp out of supported year range');
  }
  const d = new Date(ms + UTC5_OFFSET_MS);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function readBounded(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size > CONFIG.max_journal_bytes) throw fail('journal size');
    const bytes = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const { bytesRead } = await fh.read(bytes, off, size - off, off);
      if (bytesRead === 0) throw fail('journal changed during read');
      off += bytesRead;
    }
    if ((await fh.stat()).size !== size) throw fail('journal changed during read');
    return bytes;
  } finally { await fh.close(); }
}

async function scanSegmentLines(file, onLine) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size > CONFIG.max_journal_bytes) throw fail('journal size');
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    let pos = 0;
    let carry = '';
    let lineIndex = 0;
    while (pos < size) {
      const toRead = Math.min(READ_CHUNK, size - pos);
      const { bytesRead } = await fh.read(buf, 0, toRead, pos);
      if (bytesRead === 0) throw fail('journal changed during read');
      pos += bytesRead;
      carry += buf.toString('utf8', 0, bytesRead);
      if (Buffer.byteLength(carry) > CONFIG.max_journal_bytes) throw fail('journal size');
      let nl;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        onLine(line, lineIndex++);
      }
    }
    if (carry.length > 0 || lineIndex === 0) throw fail('journal size/torn tail');
    if ((await fh.stat()).size !== size) throw fail('journal changed during read');
  } finally { await fh.close(); }
}

function checkHeaderLine(line) {
  let head;
  try { head = JSON.parse(line); } catch { throw fail('corrupt journal'); }
  if (head?.kind !== 'header' || head.schema_version !== CONFIG.schema_version ||
      canonical(head.config) !== canonical(CONFIG)) throw fail('journal config/header mismatch');
}

async function scanArchivesForBatch(archiveFiles, events, requireAbsent) {
  if (archiveFiles.length === 0) return 'new';
  const taskId = events[0].task_id;
  const sourceId = events[0].source_id;
  const eventMap = new Map(events.map((e) => [e.event_id, canonical(e)]));
  const matchedIds = new Set();

  for (const file of archiveFiles) {
    await scanSegmentLines(file, (line, idx) => {
      if (idx === 0) { checkHeaderLine(line); return; } // older archives are not replayed on open
      let row;
      try { row = JSON.parse(line); } catch { throw fail('corrupt journal'); }
      if (row?.kind !== 'event') return;
      const ev = row.event;
      if (ev.task_id === taskId || ev.source_id === sourceId || eventMap.has(ev.event_id)) {
        if (requireAbsent) throw fail('conflicting/reused ID across archive');
        if (!eventMap.has(ev.event_id)) throw fail('conflicting/reused ID across archive');
        if (canonical(ev) !== eventMap.get(ev.event_id)) throw fail('conflicting event ID across archive');
        if (ev.task_id !== taskId || ev.source_id !== sourceId) throw fail('conflicting task/source across archive');
        matchedIds.add(ev.event_id);
      }
    });
  }
  if (matchedIds.size === 0) return 'new';
  if (matchedIds.size === events.length) return 'duplicate';
  throw fail('partial batch overlap across archive');
}

function sanitizeBatch(batch) {
  if (!Array.isArray(batch) || batch.length === 0) throw fail('batch must be non-empty array');
  // Check privacy of every envelope before reading any event payload.
  for (const envelope of batch) {
    if (envelope?.privacy !== 'ordinary') return null;
  }
  if (batch.length < 2) throw fail('completed batch requires at least 2 events');
  const events = batch.map((envelope) => sanitize('event', envelope).event);
  const { task_id, source_id } = events[0];
  const seenIds = new Set();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.task_id !== task_id || e.source_id !== source_id) throw fail('batch mixed task/source');
    if (e.source_seq !== i + 1 || e.task_seq !== i + 1) throw fail('batch sequence');
    if (e.occurred_at_ms > MAX_DAY_TIME_MS) throw fail('timestamp out of supported year range');
    if (seenIds.has(e.event_id)) throw fail('batch duplicate event_id');
    seenIds.add(e.event_id);
    if (i === 0) {
      if (e.type !== 'message' || e.route !== 'unknown') throw fail('batch must start with unrouted message');
    } else {
      if (Object.hasOwn(e, 'prediction')) throw fail('prediction is initial only');
      if (i < events.length - 1) {
        if (e.type === 'task_completed') throw fail('batch terminal must be last');
      } else if (e.type !== 'task_completed') {
        throw fail('batch must end with task_completed');
      }
    }
  }
  return events;
}

function projectBatchBytes(events) {
  let total = 0;
  for (const e of events) {
    total += Buffer.byteLength(canonical({ kind: 'event', event: e, state: ZERO_STATE })) + 1 + STATE_NUMERIC_PADDING;
  }
  return total;
}

function projectTickBytes(at_ms) {
  return Buffer.byteLength(canonical({ kind: 'tick', at_ms, state: ZERO_STATE })) + 1 + STATE_NUMERIC_PADDING;
}

async function listSegments(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const segments = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.ndjson')) continue;
    if (!entry.isFile()) throw fail('unexpected journal entry');
    const m = SEGMENT_RE.exec(entry.name);
    if (!m) throw fail('unexpected ndjson file in journal dir');
    const seq = Number(m[2]);
    if (seq < 1) throw fail('invalid segment sequence');
    segments.push({ name: entry.name, file: path.join(dir, entry.name), day: m[1], seq });
  }
  segments.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.seq - b.seq));
  for (let i = 0; i < segments.length; i++) {
    const cur = segments[i];
    if (i === 0) {
      if (cur.seq !== 1) throw fail('segment sequence gap');
    } else {
      const prev = segments[i - 1];
      if (cur.day === prev.day && cur.seq !== prev.seq + 1) throw fail('segment sequence gap');
      if (cur.day !== prev.day && cur.seq !== 1) throw fail('segment sequence gap');
    }
  }
  return segments;
}

async function openRotatingJournal(dir, {
  max_queue = DEFAULT_QUEUE,
  max_events = CONFIG.max_events,
  max_tasks = CONFIG.max_tasks,
  max_journal_bytes = CONFIG.max_journal_bytes,
  dedup_days = DEFAULT_DEDUP_DAYS,
} = {}) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw fail('absolute journal dir required');
  if (!Number.isSafeInteger(max_queue) || max_queue < 1 || max_queue > 1000) throw fail('max_queue 1..1000');
  if (!Number.isSafeInteger(max_events) || max_events < 2 || max_events > CONFIG.max_events) throw fail('invalid max_events');
  if (!Number.isSafeInteger(max_tasks) || max_tasks < 1 || max_tasks > CONFIG.max_tasks) throw fail('invalid max_tasks');
  if (!Number.isSafeInteger(max_journal_bytes) || max_journal_bytes < 1024 || max_journal_bytes > CONFIG.max_journal_bytes) {
    throw fail('invalid max_journal_bytes');
  }
  if (!Number.isSafeInteger(dedup_days) || dedup_days < 1 || dedup_days > 366) throw fail('dedup_days 1..366');

  const segments = await listSegments(dir);
  const archives = []; // { file, day } in segment order
  let core = null;
  let activeFile = null;
  let currentDay = null;
  let currentSeq = 0;
  let size = 0;
  let fh = null;

  if (segments.length > 0) {
    // Bounded startup: replay only the predecessor (link + completeness) and the active segment.
    const first = Math.max(0, segments.length - 2);
    let prevCheckpoint = null;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (i < first) { archives.push({ file: seg.file, day: seg.day }); continue; }
      const bytes = await readBounded(seg.file);
      const segBrain = replay(bytes.toString('utf8'));
      if (i === 0) {
        if (segBrain.initialCheckpoint !== null) throw fail('initial segment cannot have checkpoint');
      } else {
        if (segBrain.initialCheckpoint === null) throw fail('rotated segment missing checkpoint');
        if (prevCheckpoint !== null && canonical(segBrain.initialCheckpoint) !== canonical(prevCheckpoint)) {
          throw fail('journal checkpoint mismatch');
        }
      }
      prevCheckpoint = segBrain.exportCheckpoint();
      if (i < segments.length - 1) {
        if (segBrain.hasIncompleteTask()) throw fail('incomplete task in archived segment');
        archives.push({ file: seg.file, day: seg.day });
      } else {
        core = segBrain;
        activeFile = seg.file;
        currentDay = seg.day;
        currentSeq = seg.seq;
        size = bytes.length;
      }
    }
    fh = await fsp.open(activeFile, 'a');
  }

  // Archives whose UTC+5 day is within dedup_days of the journal's logical time (or the batch's).
  function dedupFiles(events) {
    const now = Math.max(core ? core.snapshot().time_ms : 0, events[0].occurred_at_ms);
    const from = utc5DayKey(Math.max(0, now - dedup_days * DAY_MS));
    return archives.filter((a) => a.day >= from).map((a) => a.file);
  }

  const queue = [];
  let running = null;
  let active = false;
  let poison = null;
  let closed = false;
  let closing = null;
  const emptySnapshot = createShadow().snapshot();
  const pending = () => queue.length + (active ? 1 : 0);

  function poisonAll(err) {
    poison = fail('rotating journal poisoned', err);
    return queue.splice(0);
  }

  function makeHeader(cp) {
    const obj = cp
      ? { kind: 'header', schema_version: CONFIG.schema_version, config: CONFIG, checkpoint: cp }
      : { kind: 'header', schema_version: CONFIG.schema_version, config: CONFIG };
    return `${canonical(obj)}\n`;
  }

  async function ensureSegmentFor(day, neededEvents, neededTasks, neededBytes, forceNew) {
    const rotate = core === null || forceNew;
    if (!rotate) return;
    if (core !== null && core.hasIncompleteTask()) throw fail('incomplete task in active segment');

    const cp = core ? core.exportCheckpoint() : undefined;
    const headerLine = makeHeader(cp);
    const headerBytes = Buffer.byteLength(headerLine);
    if (neededEvents > max_events || neededTasks > max_tasks || headerBytes + neededBytes > max_journal_bytes) {
      throw fail('batch exceeds segment limits');
    }

    if (fh) {
      await fh.close();
      fh = null;
      archives.push({ file: activeFile, day: currentDay });
    }

    const seq = day === currentDay ? currentSeq + 1 : 1;
    const nextFile = path.join(dir, `${day}-${String(seq).padStart(4, '0')}.ndjson`);
    try {
      await fsp.writeFile(nextFile, headerLine, { flag: 'wx', encoding: 'utf8' });
      fh = await fsp.open(nextFile, 'a');
    } catch (err) {
      throw new IoPoison(err);
    }
    core = createShadow({ checkpoint: cp });
    activeFile = nextFile;
    currentDay = day;
    currentSeq = seq;
    size = headerBytes;
  }

  async function appendLine(line) {
    const added = Buffer.byteLength(line);
    if (size + added > max_journal_bytes) throw fail('journal size');
    try {
      if ((await fh.stat()).size !== size) throw fail('journal changed since open');
      await fh.appendFile(line, 'utf8');
    } catch (err) {
      throw new IoPoison(err);
    }
    size += added;
  }

  async function processBatch(events) {
    let startIndex = 0;
    if (core !== null) {
      const check = core.inspectBatch(events);
      if (core.hasIncompleteTask() && check.status !== 'retry') {
        throw fail('incomplete task in active segment');
      }
      if (check.status === 'duplicate') return { status: 'duplicate', state: core.snapshot() };
      if (check.status === 'retry') {
        await scanArchivesForBatch(dedupFiles(events), events, true);
        startIndex = check.startIndex;
      } else {
        const arc = await scanArchivesForBatch(dedupFiles(events), events, false);
        if (arc === 'duplicate') return { status: 'duplicate', state: core.snapshot() };
      }
    } else {
      const arc = await scanArchivesForBatch(dedupFiles(events), events, false);
      if (arc === 'duplicate') return { status: 'duplicate', state: { ...emptySnapshot } };
    }

    const remaining = events.slice(startIndex);
    const neededBytes = projectBatchBytes(remaining);
    const isRetry = startIndex > 0;

    if (isRetry) {
      const snap = core.snapshot();
      if (snap.record_count + remaining.length > max_events || size + neededBytes > max_journal_bytes) {
        throw fail('segment capacity exceeded on retry');
      }
    } else {
      const snap = core ? core.snapshot() : emptySnapshot;
      const targetDay = utc5DayKey(Math.max(snap.time_ms, remaining[0].occurred_at_ms));
      const forceNew = core !== null && (
        targetDay !== currentDay ||
        snap.record_count + remaining.length > max_events ||
        snap.task_count + 1 > max_tasks ||
        size + neededBytes > max_journal_bytes
      );
      await ensureSegmentFor(targetDay, remaining.length, 1, neededBytes, forceNew);
    }

    let lastResult;
    let committedAny = false;
    for (const e of remaining) {
      let staged;
      try {
        staged = core.prepareIngest({ privacy: 'ordinary', event: e });
      } catch (err) {
        if (committedAny) throw new IoPoison(err);
        throw err;
      }
      await appendLine(staged.line);
      try {
        lastResult = staged.commit();
        committedAny = true;
      } catch (err) {
        throw new IoPoison(err);
      }
    }
    return lastResult;
  }

  async function processTick(env) {
    if (core !== null && core.hasIncompleteTask()) {
      throw fail('incomplete task in active segment');
    }
    const snap = core ? core.snapshot() : emptySnapshot;
    const targetDay = utc5DayKey(Math.max(snap.time_ms, env.at_ms));
    const neededBytes = projectTickBytes(env.at_ms);
    const forceNew = core !== null && (
      targetDay !== currentDay ||
      snap.record_count + 1 > max_events ||
      size + neededBytes > max_journal_bytes
    );
    await ensureSegmentFor(targetDay, 1, 0, neededBytes, forceNew);
    const staged = core.prepareTick(env);
    await appendLine(staged.line);
    try {
      return staged.commit();
    } catch (err) {
      throw new IoPoison(err);
    }
  }

  async function pump() {
    while (queue.length) {
      const item = queue.shift();
      try {
        const res = item.kind === 'batch'
          ? await processBatch(item.payload)
          : await processTick(item.payload);
        item.resolve(res);
      } catch (err) {
        if (err instanceof IoPoison) {
          const rest = poisonAll(err);
          item.reject(poison);
          for (const r of rest) r.reject(poison);
          active = false;
          return;
        }
        item.reject(err);
      }
    }
    active = false;
  }

  function enqueue(kind, raw) {
    let payload;
    try {
      payload = kind === 'batch' ? sanitizeBatch(raw) : sanitize('tick', raw);
      if (payload === null) return Promise.resolve({ status: 'discarded' });
      if (kind === 'tick' && payload.at_ms > MAX_DAY_TIME_MS) {
        throw fail('timestamp out of supported year range');
      }
      if (poison) throw poison;
      if (closed) throw fail('journal closed');
      if (pending() >= max_queue) throw fail('queue full');
    } catch (err) {
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      queue.push({ kind, payload, resolve, reject });
      if (!active) { active = true; running = pump(); }
    });
  }

  return Object.freeze({
    appendBatch: (batch) => enqueue('batch', batch),
    tick: (envelope) => enqueue('tick', envelope),
    snapshot: () => (core ? core.snapshot() : { ...emptySnapshot }),
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        while (active) await running;
        if (fh) { await fh.close(); fh = null; }
      })();
      return closing;
    },
  });
}

module.exports = { openRotatingJournal, DEFAULT_QUEUE, DEFAULT_DEDUP_DAYS, utc5DayKey, MAX_DAY_TIME_MS };
