'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { replay } = require('../src/main/brain');
const { openAsyncJournal } = require('../src/main/brain/async-journal');

let id = 5000;
const uuid = () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;
function stream() {
  const source_id = uuid(), task_id = uuid();
  let seq = 0;
  return (type = 'message', extra = {}) => {
    seq++;
    const fields = {
      message: { origin: 'user', route: seq === 1 ? 'unknown' : 'local', novelty: 0, uncertainty: 0, contradiction: 0, urgency: 0, ...(seq === 1 ? { prediction: 0.25 } : {}) },
      tool_result: { outcome: 'ok', duration_ms: 100 },
      error: { error_kind: 'execution' },
      task_completed: { outcome: 'completed', validation: 'verified', utility: 1 },
    };
    return { type, schema_version: 1, config_version: 1, event_id: uuid(), task_id, source_id,
      source_seq: seq, task_seq: seq, occurred_at_ms: 0, received_at_ms: 0, ...fields[type], ...extra };
  };
}
const ord = (event) => ({ privacy: 'ordinary', event });
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-async-')), 'journal.ndjson');

// Patch FileHandle.appendFile so tests control when/if a write completes.
async function patchAppend(hook) {
  const probe = await fsp.open(__filename, 'r');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const orig = proto.appendFile;
  const calls = [];
  proto.appendFile = async function (data, enc) {
    calls.push(data);
    await hook(calls.length);
    return orig.call(this, data, enc);
  };
  return { calls, restore: () => { proto.appendFile = orig; } };
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));

test('state is not ahead of the append; acceptance resolves only after it', async () => {
  const f = file(); const j = await openAsyncJournal(f); const next = stream();
  const gate = deferred(); const p = await patchAppend(() => gate.promise);
  try {
    let settled = false;
    const op = j.ingest(ord(next())).then((r) => { settled = true; return r; });
    await tick(); await tick();
    assert.equal(settled, false);
    assert.equal(j.snapshot().record_count, 0);
    assert.equal(replay(fs.readFileSync(f, 'utf8')).snapshot().record_count, 0);
    gate.resolve();
    const r = await op;
    assert.equal(r.status, 'accepted');
    assert.equal(j.snapshot().record_count, 1);
    assert.equal(replay(fs.readFileSync(f, 'utf8')).snapshot().record_count, 1);
  } finally { p.restore(); await j.close(); }
});

test('operations are serialized in call order and journal replays to the same state', async () => {
  const f = file(); const j = await openAsyncJournal(f); const next = stream();
  const gate = deferred(); const p = await patchAppend((n) => (n === 1 ? gate.promise : undefined));
  try {
    const ops = [j.ingest(ord(next())), j.ingest(ord(next('tool_result'))), j.tick({ privacy: 'ordinary', at_ms: 5000 }), j.ingest(ord(next('error')))];
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(p.calls.length, 1); // later operations wait their turn
    gate.resolve();
    assert.deepEqual((await Promise.all(ops)).map((r) => r.status), ['accepted', 'accepted', 'accepted', 'accepted']);
    const snap = j.snapshot();
    assert.equal(snap.record_count, 4);
    assert.deepEqual(replay(fs.readFileSync(f, 'utf8')).snapshot(), snap);
    assert.deepEqual(p.calls.map((l) => JSON.parse(l).kind), ['event', 'event', 'tick', 'event']);
  } finally { p.restore(); await j.close(); }
});

test('bounded queue fails explicitly and drops no accepted record', async () => {
  const f = file(); const j = await openAsyncJournal(f, { max_queue: 2 }); const next = stream();
  const gate = deferred(); const p = await patchAppend(() => gate.promise);
  try {
    const a = j.ingest(ord(next())), b = j.ingest(ord(next('tool_result')));
    await assert.rejects(j.ingest(ord(next('error'))), /queue full/);
    gate.resolve();
    assert.deepEqual((await Promise.all([a, b])).map((r) => r.status), ['accepted', 'accepted']);
    assert.equal(j.snapshot().record_count, 2);
    assert.equal(replay(fs.readFileSync(f, 'utf8')).snapshot().record_count, 2);
  } finally { p.restore(); await j.close(); }
  await assert.rejects(openAsyncJournal(file(), { max_queue: 0 }), /max_queue/);
});

test('private envelopes are never read beyond privacy; invalid ones fail before queue and disk', async () => {
  const f = file(); const j = await openAsyncJournal(f);
  const before = fs.statSync(f).size;
  const p = await patchAppend(() => undefined);
  try {
    for (const privacy of ['tor', 'dark', 'unknown', undefined, 'Ordinary']) {
      const env = { privacy, get event() { throw new Error('event read'); }, get at_ms() { throw new Error('at_ms read'); } };
      assert.deepEqual(await j.ingest(env), { status: 'discarded' });
      assert.deepEqual(await j.tick(env), { status: 'discarded' });
    }
    assert.deepEqual(await j.ingest(undefined), { status: 'discarded' });
    const bad = { ...stream()(), text: 'secret' };
    await assert.rejects(j.ingest(ord(bad)), /schema/);
    await assert.rejects(j.tick({ privacy: 'ordinary', at_ms: -1 }), /number/);
    assert.equal(p.calls.length, 0);
    assert.equal(fs.statSync(f).size, before);
    assert.equal(j.snapshot().record_count, 0);
  } finally { p.restore(); await j.close(); }
});

test('mutating the caller event after submit cannot change what is journaled', async () => {
  const f = file(); const j = await openAsyncJournal(f); const next = stream();
  const gate = deferred(); const p = await patchAppend(() => gate.promise);
  try {
    const event = next();
    const op = j.ingest(ord(event));
    event.urgency = 1; event.event_id = uuid();
    gate.resolve(); await op;
    const snap = j.snapshot(); snap.record_count = 99;
    assert.equal(j.snapshot().record_count, 1);
    assert.equal(replay(fs.readFileSync(f, 'utf8')).snapshot().reassessment, 0);
  } finally { p.restore(); await j.close(); }
});

test('duplicates append nothing; restart restores dedup, sequence and terminal guard', async () => {
  const f = file(); let j = await openAsyncJournal(f); const next = stream();
  const first = next(), done = next('task_completed');
  await j.ingest(ord(first)); await j.ingest(ord(done));
  const size = fs.statSync(f).size;
  assert.equal((await j.ingest(ord(first))).status, 'duplicate');
  assert.equal(fs.statSync(f).size, size);
  await assert.rejects(j.ingest(ord({ ...first, urgency: 1 })), /conflicting/);
  await j.close();

  j = await openAsyncJournal(f);
  assert.equal(j.snapshot().rpe_count, 1);
  assert.equal((await j.ingest(ord(done))).status, 'duplicate');
  assert.equal(fs.statSync(f).size, size);
  const again = next('task_completed');
  await j.ingest(ord(again)); // new ID after terminal: sequenced, no new RPE
  assert.equal(j.snapshot().rpe_count, 1);
  assert.equal(j.snapshot().record_count, 3);
  await j.close();
  assert.equal(replay(fs.readFileSync(f, 'utf8')).snapshot().record_count, 3);
});

test('stage errors reject only that operation; later operations still succeed', async () => {
  const f = file(); const j = await openAsyncJournal(f); const next = stream();
  const first = next(), skipped = next('tool_result'), third = next('tool_result');
  const results = await Promise.allSettled([j.ingest(ord(first)), j.ingest(ord(third)), j.ingest(ord(skipped))]);
  assert.equal(results[0].status, 'fulfilled');
  assert.match(results[1].reason.message, /sequence/);
  assert.equal(results[2].status, 'fulfilled');
  assert.equal(j.snapshot().record_count, 2);
  await j.close();
});

test('corrupt, torn, modified and oversized journals are refused untouched; existing file is not overwritten', async () => {
  const f = file(); const j = await openAsyncJournal(f); const next = stream();
  await j.ingest(ord(next())); await j.close();
  const good = fs.readFileSync(f, 'utf8');
  const cases = { garbage: 'not json\n', torn: good.slice(0, -5), tampered: good.replace('"record_count":1', '"record_count":2'), empty: '' };
  for (const [name, text] of Object.entries(cases)) {
    const bad = file(); fs.writeFileSync(bad, text);
    await assert.rejects(openAsyncJournal(bad), /brain:/, name);
    assert.equal(fs.readFileSync(bad, 'utf8'), text, `${name} untouched`);
  }
  const reopened = await openAsyncJournal(f);
  assert.equal(reopened.snapshot().record_count, 1);
  await reopened.close();
  assert.equal(fs.readFileSync(f, 'utf8'), good);
  await assert.rejects(openAsyncJournal('relative.ndjson'), /absolute/);
  await assert.rejects(openAsyncJournal(path.join(path.dirname(f), 'missing-dir', 'j.ndjson')), /ENOENT/);
});

test('append failure poisons: failing and queued operations reject, state stays at last durable record, no unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const f = file(); const j = await openAsyncJournal(f); const next = stream();
  const p = await patchAppend((n) => { if (n === 2) throw new Error('disk full'); });
  try {
    const ops = [j.ingest(ord(next())), j.ingest(ord(next('tool_result'))), j.ingest(ord(next('error'))), j.tick({ privacy: 'ordinary', at_ms: 9 })];
    const settled = await Promise.allSettled(ops);
    assert.equal(settled[0].status, 'fulfilled');
    for (const s of settled.slice(1)) { assert.equal(s.status, 'rejected'); assert.match(s.reason.message, /poisoned/); }
    assert.equal(j.snapshot().record_count, 1);
    await assert.rejects(j.ingest(ord(next())), /poisoned/);
    await assert.rejects(j.tick({ privacy: 'ordinary', at_ms: 10 }), /poisoned/);
    assert.deepEqual(await j.ingest({ privacy: 'tor' }), { status: 'discarded' });
    assert.equal(replay(fs.readFileSync(f, 'utf8')).snapshot().record_count, 1);
  } finally { p.restore(); await j.close(); }
  await tick(); await tick();
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
});

test('ticks are explicit: no timer advances time, and close rejects further work', async () => {
  const f = file(); const j = await openAsyncJournal(f);
  assert.equal((await j.tick({ privacy: 'ordinary', at_ms: 7000 })).state.time_ms, 7000);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(j.snapshot().time_ms, 7000);
  assert.equal(j.snapshot().record_count, 1);
  await j.close(); await j.close();
  await assert.rejects(j.tick({ privacy: 'ordinary', at_ms: 8000 }), /closed/);
});

test('concurrent close calls share completion after pending append', async () => {
  const j = await openAsyncJournal(file());
  const gate = deferred(); const entered = deferred();
  const patched = await patchAppend(() => { entered.resolve(); return gate.promise; });
  try {
    const op = j.ingest(ord(stream()()));
    await entered.promise;
    const first = j.close(), second = j.close();
    assert.equal(first, second);
    let closed = false;
    second.then(() => { closed = true; });
    await tick();
    assert.equal(closed, false);
    gate.resolve();
    await Promise.all([op, first, second]);
    assert.equal(closed, true);
    assert.equal(j.snapshot().record_count, 1);
  } finally { gate.resolve(); patched.restore(); await j.close(); }
});
