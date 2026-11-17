'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskBuffer } = require('../src/main/brain/task-buffer');
const { createShadow } = require('../src/main/brain');

let id = 9000;
const uuid = () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;
function stream() {
  const source_id = uuid(), task_id = uuid();
  let seq = 0;
  return (type = 'message', extra = {}) => {
    seq++;
    const fields = {
      message: { origin: 'user', route: 'unknown', novelty: 0, uncertainty: 0, contradiction: 0, urgency: 0 },
      tool_result: { outcome: 'ok', duration_ms: 100 },
      error: { error_kind: 'execution' },
      task_completed: { outcome: 'completed', validation: 'verified', utility: 1 },
    };
    const e = { type, schema_version: 1, config_version: 1, event_id: uuid(), task_id, source_id,
      source_seq: seq, task_seq: seq, occurred_at_ms: 0, received_at_ms: 0, ...fields[type], ...extra };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    return e;
  };
}
const trap = (what) => new Proxy({}, { get() { throw new Error(`${what} read`); }, ownKeys() { throw new Error(`${what} keys`); }, getOwnPropertyDescriptor() { throw new Error(`${what} desc`); } });

test('ordinary verified completion publishes one immutable copied batch, then the root is sealed', () => {
  const b = createTaskBuffer(); const next = stream();
  const root = b.open('ordinary');
  const ev = next(); const done = next('task_completed');
  assert.equal(b.add(root, ev).status, 'buffered');
  ev.urgency = 1; // caller mutation after add must not leak in
  assert.equal(b.add(root, done).status, 'buffered');
  const r = b.finish(root);
  assert.equal(r.status, 'published');
  assert.deepEqual(r.batch.map((e) => e.type), ['message', 'task_completed']);
  assert.equal(r.batch[0].urgency, 0);
  assert.ok(Object.isFrozen(r.batch) && Object.isFrozen(r.batch[0]));
  assert.equal(b.add(root, next()).status, 'discarded');
  assert.throws(() => b.child(root), /sealed/);
  assert.equal(b.finish(root).status, 'discarded');
});

test('a proven ordinary failure is published; cancelled, unknown and unverified terminals are not', () => {
  const b = createTaskBuffer();
  const run = (terminal) => { const n = stream(); const r = b.open('ordinary'); b.add(r, n()); b.add(r, n('task_completed', terminal)); return b.finish(r).status; };
  assert.equal(run({ outcome: 'failed', utility: -1 }), 'published');
  assert.equal(run({ outcome: 'cancelled', validation: 'unverified', utility: undefined }) , 'discarded');
  assert.equal(run({ outcome: 'unknown', validation: 'unverified', utility: undefined }), 'discarded');
  assert.equal(run({ outcome: 'completed', validation: 'unverified', utility: undefined }), 'discarded');
  const n = stream(); const r = b.open('ordinary'); b.add(r, n());
  assert.equal(b.finish(r).status, 'discarded'); // no terminal event
  const c = stream(); const r2 = b.open('ordinary'); b.add(r2, c()); b.add(r2, c('task_completed'));
  assert.equal(b.cancel(r2).status, 'discarded');
  assert.equal(b.finish(r2).status, 'discarded');
});

test('root defaults to unknown and never publishes; tor/dark roots retain nothing and read nothing', () => {
  const b = createTaskBuffer({ max_tasks: 1 }); const next = stream();
  for (const c of [undefined, 'unknown', 'tor', 'dark']) {
    const root = c === undefined ? b.open() : b.open(c);
    assert.equal(b.add(root, trap('event')).status, 'discarded');
    assert.equal(b.finish(root).status, 'discarded');
  }
  const root = b.open('ordinary'); // slot still free: non-ordinary roots took none
  assert.equal(b.add(root, next()).status, 'buffered');
});

test('any private or unknown branch, even one asked as ordinary, discards the whole task', () => {
  for (const c of ['unknown', 'tor', 'dark']) {
    const b = createTaskBuffer(); const next = stream();
    const root = b.open('ordinary');
    b.add(root, next());
    const kid = b.child(root, c);
    assert.equal(b.add(kid, trap('child event')).status, 'discarded');
    assert.equal(b.add(root, next('task_completed')).status, 'discarded');
    assert.equal(b.finish(root).status, 'discarded');
  }
  const b = createTaskBuffer(); const next = stream();
  const unknownRoot = b.open('unknown');
  assert.throws(() => b.child(unknownRoot, 'ordinary'), /sealed/); // an unknown parent mints no children
  assert.equal(b.add(unknownRoot, trap('event')).status, 'discarded');
  assert.equal(b.finish(unknownRoot).status, 'discarded');
});

test('cannot finish while a descendant is open; closed descendants allow publication', () => {
  const b = createTaskBuffer(); const next = stream();
  const root = b.open('ordinary');
  const kid = b.child(root);
  b.add(kid, next()); b.add(root, next('task_completed'));
  assert.equal(b.finish(root).status, 'discarded'); // early finish seals and discards
  assert.equal(b.add(kid, next()).status, 'discarded');

  const n = stream(); const root2 = b.open('ordinary'); const kid2 = b.child(root2);
  b.add(kid2, n()); b.close(kid2); b.close(kid2);
  assert.equal(b.add(kid2, trap('event')).status, 'discarded'); // closed handle is dead, event unread
  assert.throws(() => b.child(kid2), /closed/); // a closed parent mints nothing
  b.add(root2, n('task_completed'));
  assert.equal(b.finish(root2).status, 'published');
});

test('forged, cloned, string and foreign-buffer handles have no authority', () => {
  const a = createTaskBuffer(), other = createTaskBuffer(); const next = stream();
  const real = a.open('ordinary');
  const fakes = [undefined, null, 'ordinary', {}, { ...real }, structuredClone({}), Object.create(real), other.open('ordinary')];
  for (const f of fakes) {
    assert.equal(a.add(f, trap('event')).status, 'discarded');
    assert.equal(a.finish(f).status, 'discarded');
    assert.equal(a.cancel(f).status, 'discarded');
    assert.throws(() => a.child(f), TypeError);
    assert.throws(() => a.close(f), TypeError);
  }
  assert.throws(() => a.close(real), TypeError); // root is finished, not closed
  assert.equal(a.add(real, next()).status, 'buffered');
});

test('strict schema, bounds and overflow: bad events throw, overflow discards the whole task', () => {
  const b = createTaskBuffer({ max_events: 2 }); const next = stream();
  const root = b.open('ordinary');
  assert.throws(() => b.add(root, { ...next(), text: 'secret' }), /schema/);
  assert.equal(b.add(root, next()).status, 'discarded'); // the failed add tainted the whole task
  assert.equal(b.finish(root).status, 'discarded');
  const n2 = stream(); const root2 = b.open('ordinary');
  assert.throws(() => b.add(root2, 'hello'), /event type/);
  assert.equal(b.finish(root2).status, 'discarded');
  const n3 = stream(); const root3 = b.open('ordinary');
  b.add(root3, n3()); b.add(root3, n3('tool_result'));
  assert.equal(b.add(root3, n3('error')).status, 'discarded'); // overflow
  assert.equal(b.add(root3, n3('task_completed')).status, 'discarded');
  assert.equal(b.finish(root3).status, 'discarded');
  assert.equal(n2().type, 'message');
  const small = createTaskBuffer({ max_bytes: 500 }); const n = stream();
  const r = small.open('ordinary');
  assert.equal(small.add(r, n()).status, 'buffered');
  assert.equal(small.add(r, n()).status, 'discarded'); // bytes bound
  const c = createTaskBuffer(); const x = stream(), y = stream(); const rr = c.open('ordinary');
  c.add(rr, x());
  assert.equal(c.add(rr, y()).status, 'discarded'); // mixed task IDs
});

test('active task slots are bounded, freed on finish/cancel/discard, and options are validated', () => {
  const b = createTaskBuffer({ max_tasks: 2 }); const next = stream();
  const r1 = b.open('ordinary'), r2 = b.open('ordinary');
  assert.throws(() => b.open('ordinary'), /too many active tasks/);
  b.cancel(r1); b.cancel(r1);
  const r3 = b.open('ordinary');
  b.add(r2, next()); b.child(r2, 'tor'); // discard frees the slot
  const r4 = b.open('ordinary');
  assert.ok(r3 && r4);
  assert.throws(() => b.open('ordinary'), /too many active tasks/);
  for (const bad of [0, -1, 1.5, '3', 1e9, NaN]) assert.throws(() => createTaskBuffer({ max_tasks: bad }), TypeError);
  assert.throws(() => b.open('Ordinary'), TypeError);
  assert.throws(() => createTaskBuffer({ max_events: 0 }), TypeError);
});

test('API is frozen and discards expose no counters or private summaries', () => {
  const b = createTaskBuffer();
  assert.ok(Object.isFrozen(b));
  assert.deepEqual(Object.keys(b).sort(), ['add', 'cancel', 'child', 'close', 'finish', 'open']);
  const root = b.open('tor');
  assert.deepEqual(b.finish(root), { status: 'discarded' });
  assert.deepEqual(Reflect.ownKeys(root), []);
  assert.ok(Object.isFrozen(root));
});

test('a malformed add taints the task: a later valid terminal never publishes a partial batch', () => {
  const b = createTaskBuffer(); const next = stream();
  const root = b.open('ordinary');
  b.add(root, next());
  assert.throws(() => b.add(root, { ...next('tool_result'), duration_ms: -1 }), /number/);
  assert.equal(b.add(root, next('task_completed')).status, 'discarded');
  assert.equal(b.finish(root).status, 'discarded');
});

test('children cannot be minted from closed, sealed, tainted or unknown parents', () => {
  const b = createTaskBuffer(); const next = stream();
  const root = b.open('ordinary'); const kid = b.child(root); b.close(kid);
  assert.throws(() => b.child(kid), /closed/);
  b.child(root, 'tor'); // taints and seals
  assert.throws(() => b.child(root), /sealed/);
  const r2 = b.open('ordinary'); b.add(r2, next()); b.cancel(r2);
  assert.throws(() => b.child(r2), /sealed/);
  assert.throws(() => b.child(b.open('unknown')), /sealed/);
});

test('batch consistency: bad ordering discards the whole task, even if the rest looks valid', () => {
  const run = (build) => {
    const b = createTaskBuffer(); const next = stream(); const root = b.open('ordinary');
    for (const make of build(next)) b.add(root, make);
    return b.finish(root).status;
  };
  const dup = (next) => { const a = next(); const x = next(); const dupe = { ...next('task_completed'), event_id: a.event_id }; return [a, x, dupe]; };
  assert.equal(run((n) => [n(), n('tool_result'), n('task_completed')]), 'published');
  assert.equal(run(dup), 'discarded'); // duplicate ID
  assert.equal(run((n) => { const a = n(); n('tool_result'); return [a, n('task_completed')]; }), 'discarded'); // gap
  assert.equal(run((n) => { const a = n(); return [a, { ...n('tool_result'), task_seq: 1, source_seq: 1 }, n('task_completed')]; }), 'discarded'); // regression
  assert.equal(run((n) => [n(), { ...n('tool_result'), source_id: uuid() }, n('task_completed')]), 'discarded'); // new source
  assert.equal(run((n) => [n(), { ...n('tool_result'), task_id: uuid() }, n('task_completed')]), 'discarded'); // new task
  assert.equal(run((n) => [n(), n('message', { prediction: 0.5 }), n('task_completed')]), 'discarded'); // late prediction
  assert.equal(run((n) => [n(), n('task_completed'), n()]), 'discarded'); // event after terminal
  assert.equal(run((n) => [n('tool_result'), n('task_completed')]), 'discarded'); // no initial message
  assert.equal(run((n) => [n('message', { route: 'local' }), n('task_completed')]), 'discarded'); // route before unknown
  assert.equal(run((n) => { n(); return [n(), n('task_completed')]; }), 'discarded'); // starts at seq 2
});

test('a published batch replays in the core shadow in order', () => {
  const b = createTaskBuffer(); const next = stream(); const root = b.open('ordinary');
  const kid = b.child(root);
  b.add(root, next('message', { prediction: 0.25 })); b.add(kid, next('tool_result')); b.close(kid);
  b.add(root, next('error')); b.add(root, next('task_completed'));
  const { status, batch } = b.finish(root);
  assert.equal(status, 'published');
  const shadow = createShadow();
  for (const event of batch) assert.equal(shadow.ingest({ privacy: 'ordinary', event }).status, 'accepted');
  assert.equal(shadow.snapshot().event_count, 4);
  assert.equal(shadow.snapshot().rpe_count, 1);
});