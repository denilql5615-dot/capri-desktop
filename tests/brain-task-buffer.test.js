'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskBuffer } = require('../src/main/brain/task-buffer');
const { CONFIG, createShadow } = require('../src/main/brain');

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
    const e = { type, schema_version: CONFIG.schema_version, config_version: CONFIG.version, event_id: uuid(), task_id, source_id,
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
  const afterSeal = b.child(root);
  assert.deepEqual(Reflect.ownKeys(afterSeal), []);
  assert.ok(Object.isFrozen(afterSeal));
  assert.equal(b.add(afterSeal, trap('sealed child')).status, 'discarded');
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
  const unknownKid = b.child(unknownRoot, 'ordinary'); // no throw: returns dead closed opaque handle, never softened
  assert.deepEqual(Reflect.ownKeys(unknownKid), []);
  assert.ok(Object.isFrozen(unknownKid));
  assert.equal(b.add(unknownKid, trap('unknown child event')).status, 'discarded');
  assert.equal(b.add(b.child(unknownKid, 'ordinary'), trap('grandchild')).status, 'discarded');
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
  b.add(root2, n('task_completed'));
  assert.equal(b.finish(root2).status, 'published');

  // A step spawned from an already closed step: dead handle, no throw, whole task discarded
  // (its events would otherwise be silently missing from a published batch).
  const m = stream(); const root3 = b.open('ordinary'); const kid3 = b.child(root3);
  b.add(kid3, m()); b.close(kid3);
  const late = b.child(kid3);
  assert.equal(b.add(late, trap('closed child event')).status, 'discarded');
  b.close(late);
  assert.equal(b.add(root3, m('task_completed')).status, 'discarded');
  assert.equal(b.finish(root3).status, 'discarded');
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

test('active task slots are bounded, capacity full degrades to dead unknown without throwing, and options are validated', () => {
  const b = createTaskBuffer({ max_tasks: 2 }); const next = stream();
  const r1 = b.open('ordinary'), r2 = b.open('ordinary');
  const overflow1 = b.open('ordinary');
  assert.deepEqual(Reflect.ownKeys(overflow1), []);
  assert.ok(Object.isFrozen(overflow1));
  assert.equal(b.add(overflow1, trap('overflow event')).status, 'discarded');
  assert.equal(b.finish(overflow1).status, 'discarded');
  assert.equal(b.add(b.child(overflow1, 'ordinary'), trap('overflow child')).status, 'discarded');
  b.cancel(r1); b.cancel(r1);
  const r3 = b.open('ordinary');
  b.add(r2, next()); b.child(r2, 'tor'); // discard frees the slot
  const r4 = b.open('ordinary');
  assert.ok(r3 && r4);
  const overflow2 = b.open('ordinary');
  assert.equal(b.add(overflow2, trap('overflow2')).status, 'discarded');
  assert.equal(b.finish(overflow2).status, 'discarded');
  b.cancel(overflow2);
  b.cancel(r3);
  const r5 = b.open('ordinary');
  assert.equal(b.add(r5, stream()()).status, 'buffered');
  for (const bad of [0, -1, 1.5, '3', 1e9, NaN]) assert.throws(() => createTaskBuffer({ max_tasks: bad }), TypeError);
  assert.throws(() => b.open('Ordinary'), TypeError);
  assert.throws(() => b.child(r4, 'Ordinary'), TypeError);
  assert.throws(() => createTaskBuffer({ max_events: 0 }), TypeError);
});

test('API is frozen and discards expose no counters or private summaries', () => {
  const b = createTaskBuffer();
  assert.ok(Object.isFrozen(b));
  assert.deepEqual(Object.keys(b).sort(), ['add', 'cancel', 'child', 'close', 'finish', 'open', 'withTask']);
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

test('closed, sealed, tainted and unknown parents mint dead closed handles without throwing or softening', () => {
  const b = createTaskBuffer(); const next = stream();
  const root = b.open('ordinary'); const kid = b.child(root); b.close(kid);
  const fromClosed = b.child(kid);
  assert.equal(b.add(fromClosed, trap('closed parent child')).status, 'discarded');
  assert.equal(b.add(b.child(fromClosed, 'ordinary'), trap('closed grandchild')).status, 'discarded');
  b.close(fromClosed);

  const torKid = b.child(root, 'tor'); // taints and seals the task
  assert.equal(b.add(torKid, trap('tor child')).status, 'discarded');
  const fromSealed = b.child(root, 'ordinary');
  assert.equal(b.add(fromSealed, trap('sealed parent child')).status, 'discarded');
  assert.equal(b.add(b.child(torKid, 'ordinary'), trap('softened tor child')).status, 'discarded');
  assert.equal(b.finish(root).status, 'discarded');

  const r2 = b.open('ordinary'); b.add(r2, next()); b.cancel(r2);
  const fromCancelled = b.child(r2, 'ordinary');
  assert.equal(b.add(fromCancelled, trap('cancelled child')).status, 'discarded');

  const r3 = b.open('ordinary');
  assert.throws(() => b.add(r3, { ...next(), text: 'secret' }), /schema/);
  const fromTainted = b.child(r3, 'ordinary');
  assert.equal(b.add(fromTainted, trap('tainted child')).status, 'discarded');

  const fromUnknown = b.child(b.open('unknown'), 'ordinary');
  assert.equal(b.add(fromUnknown, trap('unknown child')).status, 'discarded');
  assert.deepEqual(Reflect.ownKeys(fromUnknown), []);
  assert.ok(Object.isFrozen(fromUnknown));
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

test('withTask validates arguments, defaults to unknown, and seals the root on exit', async () => {
  const b = createTaskBuffer({ max_tasks: 1 }); const next = stream();
  await assert.rejects(b.withTask('ordinary'), TypeError);
  await assert.rejects(b.withTask('ordinary', 'nope'), TypeError);
  await assert.rejects(b.withTask(() => {}, 'extra'), TypeError);
  await assert.rejects(b.withTask('Ordinary', () => {}), TypeError);

  let seenUnknown;
  const val = await b.withTask(async (root) => {
    seenUnknown = root;
    assert.equal(b.add(root, trap('default unknown')).status, 'discarded');
    return 'ok';
  });
  assert.equal(val, 'ok');
  assert.equal(b.finish(seenUnknown).status, 'discarded');

  let leakedRoot;
  await b.withTask('ordinary', async (root) => {
    leakedRoot = root;
    assert.equal(b.add(root, next()).status, 'buffered');
    return 'early';
  });
  assert.equal(b.add(leakedRoot, trap('after withTask')).status, 'discarded');
  assert.equal(b.finish(leakedRoot).status, 'discarded');
});

test('16 failures, aborts and cancellations free every slot so the 17th ordinary task publishes without private counters', async () => {
  const b = createTaskBuffer();
  const discards = [];

  for (let i = 0; i < 16; i++) {
    const mode = i % 4;
    if (mode === 0) {
      await assert.rejects(b.withTask('ordinary', async (root) => {
        assert.equal(b.add(root, stream()()).status, 'buffered');
        b.child(root);
        throw new Error(`boom-${i}`);
      }), new RegExp(`boom-${i}`));
    } else if (mode === 1) {
      const ac = new AbortController();
      await assert.rejects(b.withTask('ordinary', async (root) => {
        assert.equal(b.add(root, stream()()).status, 'buffered');
        ac.abort(new Error('aborted'));
        throw ac.signal.reason;
      }), /aborted/);
    } else if (mode === 2) {
      await b.withTask('ordinary', async (root) => {
        assert.equal(b.add(root, stream()()).status, 'buffered');
        return 'abandoned-without-finish';
      });
    } else {
      const r = await b.withTask('ordinary', async (root) => {
        assert.equal(b.add(root, stream()()).status, 'buffered');
        const kid = b.child(root, i % 8 === 3 ? 'tor' : 'dark');
        assert.equal(b.add(kid, trap('private event')).status, 'discarded');
        return b.finish(root);
      });
      discards.push(r);
    }
  }

  for (const d of discards) assert.deepEqual(d, { status: 'discarded' });
  assert.deepEqual(Object.keys(b).sort(), ['add', 'cancel', 'child', 'close', 'finish', 'open', 'withTask']);

  // Concurrent overflow while 16 are active degrades without throwing; once all 16 fail/abort, 17th ordinary publishes.
  let releaseAll;
  const gate = new Promise((res) => { releaseAll = res; });
  const active16 = Array.from({ length: 16 }, (_, i) => b.withTask('ordinary', async (root) => {
    assert.equal(b.add(root, stream()()).status, 'buffered');
    await gate;
    throw new Error(`concurrent-abort-${i}`);
  }));
  const overflow = await b.withTask('ordinary', async (root) => {
    assert.equal(b.add(root, trap('overflow under load')).status, 'discarded');
    return b.finish(root);
  });
  assert.deepEqual(overflow, { status: 'discarded' });
  releaseAll();
  const settled = await Promise.allSettled(active16);
  assert.ok(settled.every((s) => s.status === 'rejected'));

  const seventeenth = await b.withTask('ordinary', async (root) => {
    const n = stream();
    assert.equal(b.add(root, n()).status, 'buffered');
    assert.equal(b.add(root, n('task_completed')).status, 'buffered');
    return b.finish(root);
  });
  assert.equal(seventeenth.status, 'published');
  assert.equal(seventeenth.batch.length, 2);
});