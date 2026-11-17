'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { replay } = require('../src/main/brain');
const { createShadowHook, classifyError, contextMentionsTor, MAX_PENDING_WRITES } = require('../src/main/brain/shadow-hook');
const tor = require('../src/main/tor');

const mkDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-hook-')), 'brain-journal');

function makeClock(start = Date.UTC(2026, 10, 17, 10, 0, 0), step = 1000) {
  let t = start;
  return () => {
    const cur = t;
    t += step;
    return cur;
  };
}

function makeUuid(prefix = 1000) {
  let n = prefix;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

test('non-local routes never open a root, touch disk, or change counters', async () => {
  const dir = mkDir();
  const hook = createShadowHook({ dir, now: makeClock(), uuid: makeUuid() });

  const skippedRoutes = [
    null,
    undefined,
    { worker: 'claude', tier: 'routine' },
    { worker: 'codex', tier: 'deep' },
    { worker: 'gemini', tier: 'routine' },
    { worker: 'computer', computer: true },
    { worker: 'photo' },
    { worker: 'video' },
    { worker: 'stop' },
    { worker: null, computer: true },
  ];
  for (const r of skippedRoutes) {
    const turn = hook.start(r);
    turn.complete();
    turn.fail(new Error('ignored'));
    turn.cancel();
  }

  for (const opts of [{ rp: true }, { quick: true }, { cloudFallback: true }, { local: false }]) {
    const turn = hook.start({ worker: null, tier: 'routine' }, opts);
    turn.fail(new Error('ignored'));
  }

  const ac = new AbortController();
  ac.abort();
  const abortedTurn = hook.start({ worker: null }, { signal: ac.signal });
  abortedTurn.fail(new Error('ignored'));

  await hook.close();
  assert.deepEqual(hook.stats(), { published: 0, discarded: 0, observer_errors: 0 });
  assert.equal(fs.existsSync(dir), false);
});

test('local success with unverified completion is discarded by buffer and writes no journal', async () => {
  const dir = mkDir();
  let openCalled = 0;
  const hook = createShadowHook({
    dir,
    now: makeClock(),
    uuid: makeUuid(),
    openJournal: async () => { openCalled++; throw new Error('must not open'); },
  });

  const route = { worker: null, tier: 'routine', meta: { ok: true } };
  const turn = hook.start(route);
  assert.equal(Object.isFrozen(route), false);
  assert.equal(Object.isFrozen(route.meta), false);
  turn.complete();
  turn.cancel(); // idempotent after complete

  const reply = await hook.withTurn({ worker: null }, async () => 'локальный ответ');
  assert.equal(reply, 'локальный ответ');

  await hook.close();
  assert.equal(openCalled, 0);
  assert.deepEqual(hook.stats(), { published: 0, discarded: 2, observer_errors: 0 });
  assert.equal(fs.existsSync(dir), false);
});

test('local model failure is unverified and discarded without writing journal; classifyError prioritizes 429 quota over BUSY', async () => {
  assert.equal(classifyError({ code: 'busy', status: 429 }), 'quota');
  assert.equal(classifyError({ code: 'BUSY' }), 'unavailable');
  assert.equal(classifyError({ code: 'QUOTA' }), 'quota');
  assert.equal(classifyError({ code: 'ETIMEDOUT' }), 'timeout');
  assert.equal(classifyError({ code: 'ECONNREFUSED' }), 'unavailable');
  assert.equal(classifyError(new Error('other')), 'execution');

  const dir = mkDir();
  let openCalled = 0;
  const hook = createShadowHook({
    dir,
    now: makeClock(),
    uuid: makeUuid(2000),
    openJournal: async () => { openCalled++; throw new Error('must not open on unverified failure'); },
  });

  hook.start({ worker: null, tier: 'routine' }).fail(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
  hook.start({ worker: null, tier: 'routine' }).fail(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
  hook.start({ worker: null, tier: 'routine' }).fail(Object.assign(new Error('rate limited'), { code: 'busy', status: 429 }));

  await hook.flush();
  await hook.close();
  assert.equal(openCalled, 0);
  assert.deepEqual(hook.stats(), { published: 0, discarded: 3, observer_errors: 0 });
  assert.equal(fs.existsSync(dir), false);
});

test('explicit verified completion publishes asynchronously and replays cleanly without blocking reply path', async () => {
  const dir = mkDir();
  let resolveOpenGate;
  const openGate = new Promise((r) => { resolveOpenGate = r; });
  const { openRotatingJournal } = require('../src/main/brain/rotating-journal');

  const hook = createShadowHook({
    dir,
    now: makeClock(),
    uuid: makeUuid(2100),
    openJournal: async (d) => {
      await openGate;
      return openRotatingJournal(d);
    },
  });

  const t1 = hook.start({ worker: null, tier: 'routine' });
  t1.complete({ verified: true, utility: 1 }); // must return synchronously without awaiting openJournal/disk
  assert.equal(hook.stats().published, 0);

  const t2 = hook.start({ worker: null, tier: 'routine' });
  t2.complete({ verified: true, utility: -0.5 });

  resolveOpenGate();
  await hook.flush();
  await hook.close();

  assert.deepEqual(hook.stats(), { published: 2, discarded: 0, observer_errors: 0 });
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  assert.equal(files.length, 1);

  const ndjson = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  const rows = ndjson.trim().split('\n').slice(1).map((line) => JSON.parse(line));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.event.type), ['message', 'task_completed', 'message', 'task_completed']);
  assert.equal(rows[0].event.route, 'unknown');
  assert.equal('prediction' in rows[0].event, false);
  assert.equal(rows[1].event.outcome, 'completed');
  assert.equal(rows[1].event.validation, 'verified');
  assert.equal(rows[1].event.utility, 1);
  assert.equal(rows[3].event.utility, -0.5);

  const replayed = replay(ndjson).snapshot();
  assert.deepEqual(replayed, rows[3].state);
  assert.equal(replayed.rpe_count, 0);
  assert.equal(replayed.task_count, 2);
  assert.equal(replayed.event_count, 4);
});

test('aborts and mid-task exceptions free every slot so the 17th task succeeds', async () => {
  const dir = mkDir();
  const hook = createShadowHook({ dir, now: makeClock(), uuid: makeUuid(3000) });

  // 8 aborted turns + 8 throwing withTurn turns = 16 failures/aborts (default buffer max_tasks = 16)
  for (let i = 0; i < 8; i++) {
    const ac = new AbortController();
    const turn = hook.start({ worker: null }, { signal: ac.signal });
    ac.abort(new Error(`aborted-${i}`));
    turn.fail(ac.signal.reason);
  }
  for (let i = 0; i < 8; i++) {
    await assert.rejects(
      hook.withTurn({ worker: null }, async () => { throw new Error('stopped'); }),
      /stopped/,
    );
  }

  // Also test 16 concurrent active turns aborted/cancelled simultaneously
  const controllers = [];
  for (let i = 0; i < 16; i++) {
    const ac = new AbortController();
    controllers.push(ac);
    hook.start({ worker: null }, { signal: ac.signal });
  }
  for (const ac of controllers) ac.abort();

  // 17th (33rd overall) genuine ordinary turn must still have a free slot and publish when explicitly verified
  const t17 = hook.start({ worker: null });
  t17.complete({ verified: true, utility: 1 });
  await hook.close();

  assert.equal(hook.stats().published, 1);
  assert.equal(hook.stats().discarded, 32);
  assert.equal(hook.stats().observer_errors, 0);
});

test('journal, buffer, and non-plain route failures never throw and increment observer_errors', async () => {
  // 1. openJournal throws synchronously -> disables hook until restart
  let syncCalls = 0;
  const hSync = createShadowHook({
    dir: mkDir(),
    now: makeClock(),
    uuid: makeUuid(4000),
    openJournal: () => { syncCalls++; throw new Error('sync open boom'); },
  });
  hSync.start({ worker: null }).complete({ verified: true, utility: 1 });
  await hSync.flush();
  hSync.start({ worker: null }).complete({ verified: true, utility: 1 }); // disabled after open error
  await hSync.close();
  assert.equal(syncCalls, 1);
  assert.equal(hSync.stats().observer_errors, 1);
  assert.equal(hSync.stats().published, 0);

  // 2. openJournal rejects asynchronously -> disables hook until restart
  let asyncCalls = 0;
  const hAsync = createShadowHook({
    dir: mkDir(),
    now: makeClock(),
    uuid: makeUuid(5000),
    openJournal: async () => { asyncCalls++; throw new Error('async open boom'); },
  });
  hAsync.start({ worker: null }).complete({ verified: true, utility: 1 });
  await hAsync.flush();
  hAsync.start({ worker: null }).complete({ verified: true, utility: 1 });
  await hAsync.close();
  assert.equal(asyncCalls, 1);
  assert.equal(hAsync.stats().observer_errors, 1);
  assert.equal(hAsync.stats().published, 0);

  // 3. appendBatch rejects
  const hWrite = createShadowHook({
    dir: mkDir(),
    now: makeClock(),
    uuid: makeUuid(6000),
    openJournal: async () => ({
      appendBatch: async () => { throw new Error('disk write failed'); },
      close: async () => {},
    }),
  });
  hWrite.start({ worker: null }).complete({ verified: true, utility: 1 });
  await hWrite.close();
  assert.equal(hWrite.stats().observer_errors, 1);
  assert.equal(hWrite.stats().published, 0);

  // 4. buffer/uuid error and non-plain route types (function, Date, Map, Set)
  const hBuf = createShadowHook({
    dir: mkDir(),
    now: makeClock(),
    uuid: () => 'invalid-uuid',
  });
  assert.doesNotThrow(() => {
    const turn = hBuf.start({ worker: null });
    turn.fail(new Error('fail'));
    hBuf.start({ worker: null, fn: () => {} }).complete();
    hBuf.start({ worker: null, when: new Date(0) }).complete();
    hBuf.start({ worker: null, map: new Map() }).complete();
    hBuf.start({ worker: null, set: new Set() }).complete();
  });
  await hBuf.close();
  assert.equal(hBuf.stats().observer_errors, 5);
  assert.equal(hBuf.stats().published, 0);
});

test('withTurn cancels when aborted before normal return, and close cancels live turns', async () => {
  const hook = createShadowHook({ dir: mkDir(), now: makeClock(), uuid: makeUuid(6500) });

  const ac = new AbortController();
  const out = await hook.withTurn({ worker: null }, { signal: ac.signal }, async () => {
    ac.abort();
    return 'partial-ok';
  });
  assert.equal(out, 'partial-ok');
  assert.deepEqual(hook.stats(), { published: 0, discarded: 1, observer_errors: 0 });

  // Open two live turns and call close() while they are still active
  const live1 = hook.start({ worker: null });
  const live2 = hook.start({ worker: null });
  await hook.close();
  // Later settlements on already-cancelled turns or starting after close are safe no-ops
  live1.complete({ verified: true, utility: 1 });
  live2.fail(new Error('late'));
  hook.start({ worker: null }).complete();
  assert.deepEqual(hook.stats(), { published: 0, discarded: 3, observer_errors: 0 });
});

test('journal never contains message text, error messages, file paths, or renderer IDs', async () => {
  const dir = mkDir();
  const hook = createShadowHook({ dir, now: makeClock(), uuid: makeUuid(7000) });

  const secrets = [
    'секретный текст пользователя',
    'renderer-chat-id-xyz-987',
    'C:\\Users\\Danyal\\secret.txt',
    'http://127.0.0.1:11434/secret-model-leak',
  ];

  // Even if caller passes extra route metadata or rich Error, none of those strings reach the journal.
  const tFail = hook.start({ worker: null, tier: 'routine', note: secrets[0], rendererId: secrets[1] });
  tFail.fail(Object.assign(new Error(`${secrets[2]} ${secrets[3]}`), {
    code: 'ETIMEDOUT',
    stack: `Error: ${secrets[0]}\n at ${secrets[2]}`,
  }));

  const tVerified = hook.start({ worker: null, tier: 'routine', note: secrets[0], rendererId: secrets[1] });
  tVerified.complete({ verified: true, utility: 1 });
  await hook.close();

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  assert.equal(files.length, 1);
  const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  for (const s of secrets) {
    assert.equal(content.includes(s), false, `journal leaked: ${s}`);
  }
  const rows = content.trim().split('\n').slice(1).map((l) => JSON.parse(l));
  assert.ok(rows.every((r) => r.event.task_id.startsWith('00000000-0000-4000-8000-')));
});

test('Tor screen covers the whole context, every role, and fails closed on unreadable content', () => {
  const clean = [
    { role: 'system', content: 'Ты Капри.' },
    { role: 'user', content: 'Привет, как дела?' },
    { role: 'assistant', content: [{ type: 'text', text: 'Хорошо!' }, { type: 'image', image: 'x' }] },
    { role: 'user', content: 'Расскажи про погоду' },
  ];
  assert.equal(contextMentionsTor(clean, tor), false);
  // Tor wording in an earlier turn, last message innocent: still excluded
  assert.equal(contextMentionsTor([{ role: 'user', content: 'найди через тор новости' }, ...clean], tor), true);
  // .onion link only in an assistant reply
  const onion = `http://${'a'.repeat(56)}.onion/page`;
  assert.equal(contextMentionsTor([...clean.slice(0, 2), { role: 'assistant', content: onion }, clean[3]], tor), true);
  assert.equal(contextMentionsTor([{ role: 'user', content: [{ type: 'text', text: 'зайди в даркнет' }] }], tor), true);
  // unreadable shapes fail closed
  assert.equal(contextMentionsTor(null, tor), true);
  assert.equal(contextMentionsTor([{ role: 'user', content: 42 }], tor), true);
  assert.equal(contextMentionsTor([{ role: 'user', content: [{ type: 'text', text: null }] }], tor), true);
});

test('own publish chain is bounded: overflow beyond MAX_PENDING_WRITES is discarded, never queued', async () => {
  let releaseAppend;
  const gate = new Promise((r) => { releaseAppend = r; });
  let appended = 0;
  const hook = createShadowHook({
    dir: mkDir(),
    now: makeClock(),
    uuid: makeUuid(7000),
    openJournal: async () => ({
      appendBatch: async () => { await gate; appended++; return { status: 'accepted' }; },
      close: async () => {},
    }),
  });
  const total = MAX_PENDING_WRITES + 10;
  for (let i = 0; i < total; i++) hook.start({ worker: null }).complete({ verified: true, utility: 1 });
  assert.equal(hook.stats().discarded, 10);
  releaseAppend();
  await hook.close();
  assert.equal(appended, MAX_PENDING_WRITES);
  assert.deepEqual(hook.stats(), { published: MAX_PENDING_WRITES, discarded: 10, observer_errors: 0 });
});
