'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CONFIG, createShadow, replay, openJournal } = require('../src/main/brain');

let id = 0;
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
const ingest = (brain, event) => brain.ingest({ privacy: 'ordinary', event });
const tick = (brain, at_ms) => brain.tick({ privacy: 'ordinary', at_ms });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('decay uses explicit elapsed time, stability tends to one, silence never earns RPE', () => {
  const brain = createShadow(), next = stream();
  ingest(brain, next('message', { novelty: 1, uncertainty: 1, contradiction: 1, urgency: 1 }));
  ingest(brain, next('error'));
  const before = brain.snapshot();
  tick(brain, 600000);
  const after = brain.snapshot();
  close(after.reassessment, before.reassessment * Math.exp(-1));
  close(after.evidence_need, before.evidence_need * Math.exp(-1 / 3));
  close(after.stability, 1 + (before.stability - 1) * Math.exp(-1 / 24));
  tick(brain, 30 * 86400000);
  close(brain.snapshot().stability, 1);
  close(brain.snapshot().reassessment, 0);
  assert.equal(brain.snapshot().rpe_count, 0);
});

test('hysteresis holds the middle band and decay clears at the lower threshold', () => {
  const brain = createShadow(), next = stream();
  ingest(brain, next('message', { novelty: 1, uncertainty: 1, contradiction: 1 }));
  assert.equal(brain.snapshot().evidence_need_active, 1);
  tick(brain, 900000);
  assert.ok(brain.snapshot().evidence_need > CONFIG.leave);
  assert.ok(brain.snapshot().evidence_need < CONFIG.enter);
  assert.equal(brain.snapshot().evidence_need_active, 1);
  tick(brain, 1800000);
  assert.equal(brain.snapshot().evidence_need_active, 0);
});

test('channel cooldown throttles distinct-ID error storms and permits the next interval', () => {
  const brain = createShadow(), next = stream();
  ingest(brain, next());
  for (let i = 0; i < 100; i++) ingest(brain, next('error'));
  close(brain.snapshot().stability, 0.85);
  close(brain.snapshot().reassessment, 0.35);
  ingest(brain, next('error', { occurred_at_ms: 59999, received_at_ms: 59999 }));
  close(brain.snapshot().stability, 1 - 0.15 * Math.exp(-59999 / CONFIG.stability_tau_ms));
  ingest(brain, next('error', { occurred_at_ms: 60000, received_at_ms: 60000 }));
  close(brain.snapshot().stability, 1 - 0.15 * Math.exp(-60000 / CONFIG.stability_tau_ms) - 0.15);
  close(brain.snapshot().reassessment, 0.35 * Math.exp(-0.1) + 0.35);
  assert.equal(brain.snapshot().reassessment_active, 1);
});

test('exact redelivery is a no-op, conflicts and regressing/gapped sequences are atomic', () => {
  const lines = [], brain = createShadow({ append: (line) => lines.push(line) }), next = stream();
  const first = next(); ingest(brain, first);
  const before = brain.snapshot();
  assert.equal(ingest(brain, { ...first }).status, 'duplicate');
  assert.deepEqual(brain.snapshot(), before); assert.equal(lines.length, 2);
  assert.throws(() => ingest(brain, { ...first, urgency: 1 }), /conflicting/);
  const second = next('error');
  for (const source_seq of [1, 3]) assert.throws(() => ingest(brain, { ...second, source_seq }), /sequence/);
  assert.throws(() => ingest(brain, { ...second, task_seq: 3 }), /sequence/);
  assert.throws(() => ingest(brain, { ...second, source_id: uuid(), source_seq: 1 }), /sequence\/source/);
  assert.deepEqual(brain.snapshot(), before); assert.equal(lines.length, 2);
  ingest(brain, second);
});

test('RPE uses the prior prediction once; repeated terminal IDs cannot earn again', () => {
  const brain = createShadow(), next = stream();
  ingest(brain, next('message', { prediction: 0.4 }));
  ingest(brain, next('tool_result')); // exit/success alone is not useful completion
  assert.equal(brain.snapshot().rpe_count, 0);
  ingest(brain, next('task_completed', { utility: -0.2, outcome: 'failed' }));
  close(brain.snapshot().last_rpe, -0.6);
  const before = brain.snapshot();
  ingest(brain, next('task_completed'));
  assert.equal(brain.snapshot().rpe_count, 1);
  close(brain.snapshot().stability, before.stability);
});

test('unverified terminal, missing prediction and completion before initial message never gain later RPE', () => {
  const brain = createShadow(), next = stream();
  const first = next(); delete first.prediction; ingest(brain, first);
  ingest(brain, next('task_completed'));
  assert.equal(brain.snapshot().rpe_count, 0);
  const latePrediction = next('message', { prediction: 0.3 });
  assert.throws(() => ingest(brain, latePrediction), /initial only/);
  const other = stream(); ingest(brain, other());
  const unverified = other('task_completed', { validation: 'unverified' }); delete unverified.utility;
  ingest(brain, unverified); ingest(brain, other('task_completed'));
  assert.equal(brain.snapshot().rpe_count, 0);
  const premature = stream()('task_completed');
  assert.throws(() => ingest(brain, premature), /must begin/);
  const initial = stream()('message');
  ingest(brain, { ...initial, source_id: premature.source_id, task_id: premature.task_id });
  assert.equal(brain.snapshot().rpe_count, 0);
});

test('private/unknown envelopes bypass event validation and leave no records or counters', () => {
  const lines = [], brain = createShadow({ append: (line) => lines.push(line) });
  const before = brain.snapshot();
  for (const privacy of ['tor', 'dark', 'unknown', undefined]) {
    const envelope = { privacy, get event() { throw new Error('must not inspect'); } };
    assert.equal(brain.ingest(envelope).status, 'discarded');
    assert.equal(brain.tick({ privacy, at_ms: Infinity }).status, 'discarded');
  }
  assert.deepEqual(brain.snapshot(), before); assert.equal(lines.length, 1);
});

test('strict schema rejects content, praise, bad IDs/enums, nonfinite and unsafe numbers', () => {
  const brain = createShadow(), first = stream()();
  const before = brain.snapshot();
  const cases = [
    { text: 'secret' }, { url: 'https://secret.invalid' }, { praise: 1 }, { error: 'private' },
    { event_id: 'raw-identifier' }, { type: 'praise' }, { urgency: 0.5 }, { novelty: true },
    { route: 'external' }, { prediction: NaN }, { prediction: Infinity }, { prediction: -2 },
    { occurred_at_ms: -1 }, { occurred_at_ms: Number.MAX_SAFE_INTEGER + 1 },
    { received_at_ms: CONFIG.max_time_ms + 1 }, { source_seq: 1.1 }, { config_version: 2 },
  ];
  for (const bad of cases) assert.throws(() => ingest(brain, { ...first, ...bad }));
  assert.throws(() => brain.ingest({ privacy: 'ordinary', event: first, content: 'secret' }));
  assert.throws(() => tick(brain, Infinity));
  assert.deepEqual(brain.snapshot(), before);
  ingest(brain, first);
  const badCompletion = stream()('task_completed', { validation: 'unverified' });
  assert.throws(() => ingest(brain, badCompletion), /unverified utility/);
});

test('late events and explicit ticks cannot reverse logical time; circadian is fixed-offset only', () => {
  const brain = createShadow(), next = stream();
  ingest(brain, next('message', { occurred_at_ms: 1000000, received_at_ms: 1000000 }));
  ingest(brain, next('error', { occurred_at_ms: 1, received_at_ms: 1000001 }));
  assert.equal(brain.snapshot().time_ms, 1000000);
  tick(brain, 0); assert.equal(brain.snapshot().time_ms, 1000000);
  tick(brain, 2 * 3600000); // 07:00 at UTC+5, quiet window ends
  assert.equal(brain.snapshot().circadian_quiet, 0);
  tick(brain, 18 * 3600000); // 23:00 at UTC+5
  assert.equal(brain.snapshot().circadian_quiet, 1);
  tick(brain, CONFIG.max_time_ms);
  assert.ok(Object.values(brain.snapshot()).every(Number.isFinite));
});

test('snapshots and input mutation cannot alter internal state or dedup payload', () => {
  const brain = createShadow(), next = stream(), first = next();
  const saved = { ...first }; ingest(brain, first);
  const snap = brain.snapshot(); snap.stability = -999; snap.event_count = -9;
  first.urgency = 1;
  assert.equal(brain.snapshot().stability, 1);
  assert.equal(brain.snapshot().event_count, 1);
  assert.equal(ingest(brain, saved).status, 'duplicate');
  assert.throws(() => ingest(brain, first), /conflicting/);
});

test('replay exactly restores decay, RPE, ordering and dedup; journal contains metadata only', () => {
  const lines = [], brain = createShadow({ append: (line) => lines.push(line) }), next = stream();
  const first = next('message', { novelty: 1, contradiction: 1, uncertainty: 1 });
  ingest(brain, first); ingest(brain, next('error')); tick(brain, 1800000);
  ingest(brain, next('task_completed', { occurred_at_ms: 1000, received_at_ms: 1800001 }));
  const restored = replay(lines.join(''));
  assert.deepEqual(restored.snapshot(), brain.snapshot());
  assert.equal(ingest(restored, first).status, 'duplicate');
  ingest(restored, next('task_completed'));
  assert.equal(restored.snapshot().rpe_count, 1);
  assert.doesNotMatch(lines.join(''), /https:|secret|"text"|"content"|"error"\s*:/);
});

test('append failure is atomic and poisons further intake, including duplicate delivery', () => {
  let calls = 0;
  const brain = createShadow({ append: () => { if (++calls === 3) throw new Error('disk full'); } }), next = stream();
  const first = next(); ingest(brain, first);
  const before = brain.snapshot();
  assert.throws(() => tick(brain, 60000), /disk full/);
  assert.deepEqual(brain.snapshot(), before);
  assert.throws(() => ingest(brain, first), /poisoned/);
  assert.throws(() => ingest(brain, next('error')), /poisoned/);
  assert.throws(() => tick(brain, 70000), /poisoned/);
  assert.equal(calls, 3);
});

test('event append failure leaves task/sequence/terminal/RPE guards uncommitted', () => {
  const lines = []; let blocked = false;
  const brain = createShadow({ append: (line) => { if (blocked) throw new Error('write failed'); lines.push(line); } }), next = stream();
  ingest(brain, next()); const before = brain.snapshot(); blocked = true;
  const completion = next('task_completed');
  assert.throws(() => ingest(brain, completion), /write failed/);
  assert.deepEqual(brain.snapshot(), before);
  const restored = replay(lines.join('')); ingest(restored, completion);
  assert.equal(restored.snapshot().rpe_count, 1);
});

test('event/tick and task limits stop intake explicitly without evicting dedup', () => {
  const brain = createShadow(), first = stream()(); ingest(brain, first);
  for (let i = 1; i < CONFIG.max_events; i++) tick(brain, i);
  const before = brain.snapshot();
  assert.throws(() => tick(brain, CONFIG.max_events), /event limit/);
  assert.equal(ingest(brain, first).status, 'duplicate');
  assert.deepEqual(brain.snapshot(), before);
  const tasks = createShadow();
  for (let i = 0; i < CONFIG.max_tasks; i++) ingest(tasks, stream()());
  assert.throws(() => ingest(tasks, stream()()), /task limit/);
  assert.equal(tasks.snapshot().task_count, CONFIG.max_tasks);
});

test('corrupt/torn journals, incompatible config and modified result state are refused', () => {
  const lines = [], brain = createShadow({ append: (line) => lines.push(line) }); ingest(brain, stream()());
  const valid = lines.join('');
  assert.throws(() => replay(valid.slice(0, -1)), /torn tail/);
  assert.throws(() => replay(`${valid}garbage\n`), /corrupt/);
  assert.throws(() => replay(valid.replace('"version":1', '"version":2')), /mismatch/);
  assert.throws(() => replay(valid.replace('"stability":1', '"stability":0')), /state mismatch/);
  assert.throws(() => replay(`${valid}${lines[1]}`), /state mismatch/);
  assert.throws(() => replay(valid.replace('"kind":"event"', '"kind":"event","text":"secret"')), /schema|noncanonical/);
  assert.throws(() => replay(valid.replace('"kind":"event"', '"kind":"event","kind":"event"')), /noncanonical/);
});

test('file reopen restores guards and appends without overwriting; torn tail remains untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-brain-'));
  // Keep bounded fixtures for inspection: this task does not delete files.
  const file = path.join(dir, 'journal.ndjson'), brain = openJournal(file), next = stream();
  const first = next(); ingest(brain, first); ingest(brain, next('task_completed'));
  tick(brain, 60000); const original = fs.readFileSync(file, 'utf8');
  const restored = openJournal(file);
  assert.deepEqual(restored.snapshot(), brain.snapshot());
  assert.equal(ingest(restored, first).status, 'duplicate');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  ingest(restored, next('task_completed'));
  assert.equal(restored.snapshot().rpe_count, 1);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(original));
  fs.appendFileSync(file, '{"kind":');
  const torn = fs.readFileSync(file, 'utf8');
  assert.throws(() => openJournal(file), /torn tail/);
  assert.equal(fs.readFileSync(file, 'utf8'), torn);
  assert.throws(() => openJournal('relative.ndjson'), /absolute/);
});

test('file read rejects oversized journals before allocating their contents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-brain-'));
  const file = path.join(dir, 'oversized.ndjson'), fd = fs.openSync(file, 'wx');
  try { fs.ftruncateSync(fd, CONFIG.max_journal_bytes + 1); } finally { fs.closeSync(fd); }
  assert.throws(() => openJournal(file), /journal size/);
});

test('a stale file writer refuses to append after another opened writer advances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-brain-'));
  const file = path.join(dir, 'single-writer.ndjson');
  const first = openJournal(file), stale = openJournal(file);
  ingest(first, stream()());
  const contents = fs.readFileSync(file, 'utf8'), before = stale.snapshot();
  assert.throws(() => ingest(stale, stream()()), /changed since open/);
  assert.deepEqual(stale.snapshot(), before);
  assert.equal(fs.readFileSync(file, 'utf8'), contents);
  assert.throws(() => tick(stale, 1), /poisoned/);
});
