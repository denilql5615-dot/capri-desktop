'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CONFIG, createShadow, replay, canonical } = require('../src/main/brain');
const { openRotatingJournal, utc5DayKey, MAX_DAY_TIME_MS } = require('../src/main/brain/rotating-journal');

let id = 9000;
const uuid = () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;

function makeTaskBatch(count = 2, baseMs = 0, overrides = {}) {
  const task_id = overrides.task_id || uuid();
  const source_id = overrides.source_id || uuid();
  const events = [];
  for (let i = 1; i <= count; i++) {
    const t = baseMs + (i - 1) * 1000;
    let event;
    if (i === 1) {
      event = {
        type: 'message', schema_version: 1, config_version: 1,
        event_id: uuid(), task_id, source_id, source_seq: i, task_seq: i,
        occurred_at_ms: t, received_at_ms: t,
        origin: 'user', route: 'unknown',
        novelty: 0, uncertainty: 0, contradiction: 0, urgency: 0, prediction: 0.25,
        ...(overrides.first || {}),
      };
    } else if (i === count) {
      event = {
        type: 'task_completed', schema_version: 1, config_version: 1,
        event_id: uuid(), task_id, source_id, source_seq: i, task_seq: i,
        occurred_at_ms: t, received_at_ms: t,
        outcome: 'completed', validation: 'verified', utility: 1,
        ...(overrides.last || {}),
      };
    } else {
      const midType = overrides.midType || 'tool_result';
      const midFields = midType === 'error'
        ? { error_kind: 'execution' }
        : { outcome: 'ok', duration_ms: 50 };
      event = {
        type: midType, schema_version: 1, config_version: 1,
        event_id: uuid(), task_id, source_id, source_seq: i, task_seq: i,
        occurred_at_ms: t, received_at_ms: t, ...midFields,
        ...(overrides.mid || {}),
      };
    }
    events.push({ privacy: 'ordinary', event });
  }
  return events;
}

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'brain-rot-'));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function patchAppend(hook) {
  const probe = await fsp.open(__filename, 'r');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const orig = proto.appendFile;
  const calls = [];
  proto.appendFile = async function (data, enc) {
    calls.push(data);
    await hook(calls.length, data);
    return orig.call(this, data, enc);
  };
  return { calls, restore: () => { proto.appendFile = orig; } };
}

test('UTC+5 day boundary rotates segments and keeps closed archives untouched', async () => {
  const dir = mkDir();
  const j = await openRotatingJournal(dir);
  // 2026-11-17 23:59:00 UTC+5 = 2026-11-17T18:59:00Z
  const day1Ms = Date.UTC(2026, 10, 17, 18, 59, 0);
  // 2026-11-18 00:01:00 UTC+5 = 2026-11-17T19:01:00Z
  const day2Ms = Date.UTC(2026, 10, 17, 19, 1, 0);
  assert.equal(utc5DayKey(day1Ms), '2026-11-17');
  assert.equal(utc5DayKey(day2Ms), '2026-11-18');

  await j.appendBatch(makeTaskBatch(2, day1Ms));
  const f1 = path.join(dir, '2026-11-17-0001.ndjson');
  const bytes1 = fs.readFileSync(f1, 'utf8');

  await j.appendBatch(makeTaskBatch(2, day2Ms));
  const f2 = path.join(dir, '2026-11-18-0001.ndjson');
  assert.equal(fs.readFileSync(f1, 'utf8'), bytes1);
  assert.ok(fs.existsSync(f2));
  assert.equal(replay(bytes1).snapshot().task_count, 1);
  assert.equal(replay(fs.readFileSync(f2, 'utf8')).snapshot().task_count, 1);
  assert.equal(j.snapshot().rpe_count, 2);
  await j.close();
});

test('proactive rotation on max_tasks, max_events, and max_journal_bytes never splits tasks', async () => {
  const dirTasks = mkDir();
  const jt = await openRotatingJournal(dirTasks, { max_tasks: 2 });
  const dayMs = Date.UTC(2026, 10, 17, 5, 0, 0);
  for (let i = 0; i < 5; i++) {
    await jt.appendBatch(makeTaskBatch(2, dayMs + i * 70000));
  }
  await jt.close();
  const filesT = fs.readdirSync(dirTasks).sort();
  assert.deepEqual(filesT, ['2026-11-17-0001.ndjson', '2026-11-17-0002.ndjson', '2026-11-17-0003.ndjson']);
  assert.equal(replay(fs.readFileSync(path.join(dirTasks, filesT[0]), 'utf8')).snapshot().task_count, 2);
  assert.equal(replay(fs.readFileSync(path.join(dirTasks, filesT[1]), 'utf8')).snapshot().task_count, 2);
  assert.equal(replay(fs.readFileSync(path.join(dirTasks, filesT[2]), 'utf8')).snapshot().task_count, 1);

  const dirEvents = mkDir();
  const je = await openRotatingJournal(dirEvents, { max_events: 5 });
  await je.appendBatch(makeTaskBatch(3, dayMs));
  await je.appendBatch(makeTaskBatch(3, dayMs + 70000)); // 3+3=6 > 5 -> proactively rotates before batch 2
  await je.close();
  const filesE = fs.readdirSync(dirEvents).sort();
  assert.deepEqual(filesE, ['2026-11-17-0001.ndjson', '2026-11-17-0002.ndjson']);
  assert.equal(replay(fs.readFileSync(path.join(dirEvents, filesE[0]), 'utf8')).snapshot().record_count, 3);
  assert.equal(replay(fs.readFileSync(path.join(dirEvents, filesE[1]), 'utf8')).snapshot().record_count, 3);

  const dirBytes = mkDir();
  const jb = await openRotatingJournal(dirBytes, { max_journal_bytes: 3400 });
  try {
    // Negative RPE (-1.8) + decay into tiny 0.00000... decimal expansion must never under-project
    await jb.appendBatch(makeTaskBatch(2, dayMs, {
      first: { urgency: 1, contradiction: 1, prediction: 0.9 },
      last: { utility: -0.9, outcome: 'failed' },
    }));
    await jb.tick({ privacy: 'ordinary', at_ms: dayMs + 6900000 });
    assert.ok(jb.snapshot().reassessment > 0 && jb.snapshot().reassessment < 1e-4);
    assert.ok(jb.snapshot().last_rpe < -1.7);
    await jb.appendBatch(makeTaskBatch(2, dayMs + 6970000, {
      first: { urgency: 1, prediction: 0.95 },
      last: { utility: -0.85, outcome: 'failed' },
    }));
  } finally {
    await jb.close();
  }
  const filesB = fs.readdirSync(dirBytes).sort();
  assert.equal(filesB.length, 2);
  for (const fn of filesB) {
    assert.ok(fs.statSync(path.join(dirBytes, fn)).size <= 3400);
  }
});

test('checkpoint carries channels, hysteresis gates, 60s cooldowns, decay, and RPE across rotation and restart', async () => {
  const dir = mkDir();
  const ref = createShadow();
  const t0 = Date.UTC(2026, 10, 17, 5, 0, 0); // 10:00 UTC+5
  const b1 = makeTaskBatch(3, t0, {
    first: { novelty: 1, uncertainty: 1, contradiction: 1, urgency: 1, prediction: 0.4 },
    midType: 'error',
    last: { utility: -0.2, outcome: 'failed' },
  });
  // Cooldown check at +30s across segment boundary: must still be throttled by carried timestamps
  const b2 = makeTaskBatch(3, t0 + 30000, {
    first: { urgency: 1, contradiction: 1, prediction: 0.2 },
    midType: 'error',
    last: { utility: 0.8 },
  });
  // Cooldown expired at +90s after segment 2 + restart
  const b3 = makeTaskBatch(3, t0 + 90000, {
    first: { urgency: 1, novelty: 1, prediction: 0.1 },
    midType: 'error',
    last: { utility: 0.9 },
  });

  for (const b of [b1, b2, b3]) {
    for (const env of b) ref.ingest(env);
  }
  ref.tick({ privacy: 'ordinary', at_ms: t0 + 690000 });

  let j = await openRotatingJournal(dir, { max_tasks: 1 });
  await j.appendBatch(b1);
  await j.appendBatch(b2);
  await j.close();

  j = await openRotatingJournal(dir, { max_tasks: 1 });
  await j.appendBatch(b3);
  await j.tick({ privacy: 'ordinary', at_ms: t0 + 690000 });

  const got = j.snapshot();
  const want = ref.snapshot();
  assert.equal(got.rpe_count, want.rpe_count);
  assert.equal(got.last_rpe, want.last_rpe);
  assert.equal(got.reassessment_active, want.reassessment_active);
  assert.equal(got.evidence_need_active, want.evidence_need_active);
  assert.equal(got.stability_active, want.stability_active);
  assert.equal(got.circadian_quiet, want.circadian_quiet);
  assert.ok(Math.abs(got.reassessment - want.reassessment) < 1e-12);
  assert.ok(Math.abs(got.evidence_need - want.evidence_need) < 1e-12);
  assert.ok(Math.abs(got.stability - want.stability) < 1e-12);
  assert.equal(got.task_count, 1); // per-segment count reset
  await j.close();
});

test('repeat older than 1 day and after restart is deduplicated with zero write and zero new RPE', async () => {
  const dir = mkDir();
  const day1 = Date.UTC(2026, 10, 15, 5, 0, 0);
  const day2 = Date.UTC(2026, 10, 16, 5, 0, 0);
  const day3 = Date.UTC(2026, 10, 17, 5, 0, 0);
  const oldBatch = makeTaskBatch(2, day1, { first: { prediction: 0.2 }, last: { utility: 1 } });

  let j = await openRotatingJournal(dir);
  await j.appendBatch(oldBatch);
  await j.appendBatch(makeTaskBatch(2, day2));
  await j.appendBatch(makeTaskBatch(2, day3));
  await j.close();

  j = await openRotatingJournal(dir);
  const before = j.snapshot();
  const sizesBefore = fs.readdirSync(dir).sort().map((f) => fs.statSync(path.join(dir, f)).size);
  const dup = await j.appendBatch(oldBatch);
  assert.equal(dup.status, 'duplicate');
  assert.deepEqual(j.snapshot(), before);
  const sizesAfter = fs.readdirSync(dir).sort().map((f) => fs.statSync(path.join(dir, f)).size);
  assert.deepEqual(sizesAfter, sizesBefore);
  await j.close();
});

test('cross-archive ID conflicts, timestamp mutation on same ID, reused task/source, and partial overlap are rejected', async () => {
  const dir = mkDir();
  const day1 = Date.UTC(2026, 10, 16, 5, 0, 0);
  const day2 = Date.UTC(2026, 10, 17, 5, 0, 0);
  const b1 = makeTaskBatch(3, day1);
  const j = await openRotatingJournal(dir);
  await j.appendBatch(b1);
  await j.appendBatch(makeTaskBatch(2, day2));

  // Same event_ids with newer timestamp
  const newerTs = b1.map((env) => ({
    privacy: 'ordinary',
    event: { ...env.event, occurred_at_ms: day2 + 5000, received_at_ms: day2 + 5000 },
  }));
  await assert.rejects(j.appendBatch(newerTs), /conflicting event ID/);

  // Reused task_id / source_id with fresh event_ids
  const reusedTask = makeTaskBatch(2, day2, { task_id: b1[0].event.task_id });
  await assert.rejects(j.appendBatch(reusedTask), /conflicting\/reused ID/);
  const reusedSource = makeTaskBatch(2, day2, { source_id: b1[0].event.source_id });
  await assert.rejects(j.appendBatch(reusedSource), /conflicting\/reused ID/);

  // Partial overlap (subset of archived task)
  const subset = [b1[0], { ...b1[2], event: { ...b1[2].event, source_seq: 2, task_seq: 2 } }];
  await assert.rejects(j.appendBatch(subset), /conflicting/);

  // Writer stays healthy after rejected conflict batches
  const ok = await j.appendBatch(makeTaskBatch(2, day2 + 60000));
  assert.equal(ok.status, 'accepted');
  await j.close();
});

test('corrupt, torn, checkpoint-mismatched, and legacy-incompatible directories are refused untouched', async () => {
  const dir = mkDir();
  const day1 = Date.UTC(2026, 10, 17, 5, 0, 0);
  const j = await openRotatingJournal(dir, { max_tasks: 1 });
  await j.appendBatch(makeTaskBatch(2, day1));
  await j.appendBatch(makeTaskBatch(2, day1 + 5000));
  await j.close();

  const f1 = path.join(dir, '2026-11-17-0001.ndjson');
  const f2 = path.join(dir, '2026-11-17-0002.ndjson');
  const orig2 = fs.readFileSync(f2, 'utf8');

  // Corrupt checkpoint in header of segment 2
  const lines2 = orig2.split('\n');
  const head2 = JSON.parse(lines2[0]);
  head2.checkpoint.state.rpe_count = 99;
  const tampered2 = [JSON.stringify(head2), ...lines2.slice(1)].join('\n');
  fs.writeFileSync(f2, tampered2);
  await assert.rejects(openRotatingJournal(dir), /checkpoint mismatch|state mismatch/);
  assert.equal(fs.readFileSync(f2, 'utf8'), tampered2);

  // Torn tail on segment 2
  fs.writeFileSync(f2, orig2.slice(0, -4));
  await assert.rejects(openRotatingJournal(dir), /torn tail/);
  assert.equal(fs.readFileSync(f2, 'utf8'), orig2.slice(0, -4));

  // Restore valid f2, test non-checkpoint on segment 2 and checkpoint on segment 1
  fs.writeFileSync(f2, orig2);
  const re = await openRotatingJournal(dir);
  assert.equal(re.snapshot().task_count, 1);
  await re.close();

  // Bad directory / unexpected file
  const dirGap = mkDir();
  fs.writeFileSync(path.join(dirGap, '2026-11-17-0002.ndjson'), orig2);
  await assert.rejects(openRotatingJournal(dirGap), /sequence gap/);
  assert.equal(fs.existsSync(f1), true);
  await assert.rejects(openRotatingJournal('relative-dir'), /absolute/);
});

test('privacy discards before queue/counters, prevalidation rejects bad batches, and caller mutation is isolated', async () => {
  const dir = mkDir();
  const j = await openRotatingJournal(dir);
  const badPriv = [
    { privacy: 'ordinary', event: makeTaskBatch(2, 0)[0].event },
    { privacy: 'tor', get event() { throw new Error('must not read event'); } },
  ];
  assert.deepEqual(await j.appendBatch(badPriv), { status: 'discarded' });
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.equal(j.snapshot().record_count, 0);

  // Prevalidation errors before queue/disk (including non-initial prediction)
  const base3 = makeTaskBatch(3, 0);
  const badPredBatch = [
    base3[0],
    { privacy: 'ordinary', event: { ...base3[0].event, event_id: uuid(), source_seq: 2, task_seq: 2, route: 'local', prediction: 0.5 } },
    base3[2],
  ];
  const nonTerminal = { ...base3[0].event, task_seq: 2, source_seq: 2, route: 'local', event_id: uuid() };
  delete nonTerminal.prediction;
  await assert.rejects(j.appendBatch([]), /non-empty/);
  await assert.rejects(j.appendBatch([base3[0]]), /at least 2/);
  await assert.rejects(j.appendBatch([base3[2], base3[0]]), /sequence/);
  await assert.rejects(j.appendBatch([{ privacy: 'ordinary', event: { ...base3[0].event, route: 'local' } }, base3[2]]), /start with unrouted/);
  await assert.rejects(j.appendBatch([base3[0], { privacy: 'ordinary', event: nonTerminal }]), /end with task_completed/);
  await assert.rejects(j.appendBatch(badPredBatch), /initial only/);
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.equal(j.snapshot().record_count, 0);
  assert.equal((await j.appendBatch(makeTaskBatch(2, 0))).status, 'accepted');

  // Caller mutation after appendBatch does not affect journaled state
  const mutBatch = makeTaskBatch(2, 0);
  const gate = deferred();
  const p = await patchAppend(() => gate.promise);
  try {
    const op = j.appendBatch(mutBatch);
    mutBatch[0].event.urgency = 1;
    mutBatch[0].event.event_id = uuid();
    gate.resolve();
    await op;
    assert.equal(j.snapshot().reassessment, 0);
  } finally {
    p.restore();
    await j.close();
  }
});

test('bounded queue, concurrent close, and partial write poison + crash-retry recovery', async () => {
  const dir = mkDir();
  const j = await openRotatingJournal(dir, { max_queue: 2 });
  const gate = deferred();
  const p1 = await patchAppend(() => gate.promise);
  try {
    const a = j.appendBatch(makeTaskBatch(2, 0));
    const b = j.appendBatch(makeTaskBatch(2, 5000));
    await assert.rejects(j.appendBatch(makeTaskBatch(2, 10000)), /queue full/);
    gate.resolve();
    await Promise.all([a, b]);
  } finally {
    p1.restore();
  }
  await Promise.all([j.close(), j.close()]);
  await assert.rejects(j.appendBatch(makeTaskBatch(2, 20000)), /closed/);

  // Partial batch write failure poisons writer; restart allows exact retry without duplicate RPE
  const dirCrash = mkDir();
  const jc = await openRotatingJournal(dirCrash, { max_tasks: 1 });
  const crashBatch = makeTaskBatch(3, Date.UTC(2026, 10, 17, 5, 0, 0));
  const p2 = await patchAppend((n) => { if (n === 2) throw new Error('disk full'); });
  try {
    const failOp = jc.appendBatch(crashBatch);
    const queuedOp = jc.appendBatch(makeTaskBatch(2, Date.UTC(2026, 10, 17, 6, 0, 0)));
    await assert.rejects(failOp, /poisoned/);
    await assert.rejects(queuedOp, /poisoned/);
  } finally {
    p2.restore();
    await jc.close();
  }

  const jr = await openRotatingJournal(dirCrash, { max_tasks: 1 });
  assert.equal(jr.snapshot().record_count, 1); // only event 1 of crashBatch survived
  const fCrash = path.join(dirCrash, '2026-11-17-0001.ndjson');
  const bytesBeforeReject = fs.readFileSync(fCrash, 'utf8');
  // Unrelated same-day batch, tick, and cross-day batch must all reject with zero append while incomplete
  await assert.rejects(jr.appendBatch(makeTaskBatch(2, Date.UTC(2026, 10, 17, 7, 0, 0))), /incomplete task/);
  await assert.rejects(jr.tick({ privacy: 'ordinary', at_ms: Date.UTC(2026, 10, 17, 7, 1, 0) }), /incomplete task/);
  await assert.rejects(jr.appendBatch(makeTaskBatch(2, Date.UTC(2026, 10, 18, 5, 0, 0))), /incomplete task/);
  assert.equal(fs.readFileSync(fCrash, 'utf8'), bytesBeforeReject);
  // Exact retry completes crashBatch safely (event 1 deduplicated, events 2..3 written)
  const retried = await jr.appendBatch(crashBatch);
  assert.equal(retried.status, 'accepted');
  assert.equal(jr.snapshot().record_count, 3);
  assert.equal(jr.snapshot().rpe_count, 1);
  await jr.close();

  // Archived segment with incomplete task + next checkpointed segment must be refused on open
  const dirBadArch = mkDir();
  const ja = await openRotatingJournal(dirBadArch);
  await ja.appendBatch(makeTaskBatch(2, Date.UTC(2026, 10, 17, 5, 0, 0)));
  await ja.close();
  const seg1Path = path.join(dirBadArch, '2026-11-17-0001.ndjson');
  const seg1Lines = fs.readFileSync(seg1Path, 'utf8').trimEnd().split('\n');
  const partialSeg1 = `${seg1Lines.slice(0, 2).join('\n')}\n`; // header + initial message only
  const partialBrain = replay(partialSeg1);
  const seg2Header = `${canonical({
    kind: 'header', schema_version: CONFIG.schema_version, config: CONFIG, checkpoint: partialBrain.exportCheckpoint(),
  })}\n`;
  fs.writeFileSync(seg1Path, partialSeg1);
  fs.writeFileSync(path.join(dirBadArch, '2026-11-17-0002.ndjson'), seg2Header);
  await assert.rejects(openRotatingJournal(dirBadArch), /incomplete task in archived segment/);
});

test('UTC+5 date range validates up to year 9999 and rejects overflow before any file writes', async () => {
  assert.equal(utc5DayKey(Date.UTC(2026, 10, 17, 18, 59, 59, 999)), '2026-11-17');
  assert.equal(utc5DayKey(Date.UTC(2026, 10, 17, 19, 0, 0, 0)), '2026-11-18');
  assert.equal(utc5DayKey(MAX_DAY_TIME_MS), '9999-12-31');
  assert.throws(() => utc5DayKey(MAX_DAY_TIME_MS + 1), /supported year range/);
  assert.throws(() => utc5DayKey(CONFIG.max_time_ms), /supported year range/);

  const dir = mkDir();
  const j = await openRotatingJournal(dir);
  try {
    await assert.rejects(j.appendBatch(makeTaskBatch(2, MAX_DAY_TIME_MS + 1)), /supported year range/);
    await assert.rejects(j.appendBatch(makeTaskBatch(2, CONFIG.max_time_ms - 2000)), /supported year range/);
    await assert.rejects(j.tick({ privacy: 'ordinary', at_ms: MAX_DAY_TIME_MS + 1 }), /supported year range/);
    assert.equal(fs.readdirSync(dir).length, 0);
    await j.appendBatch(makeTaskBatch(2, MAX_DAY_TIME_MS - 2000));
    assert.deepEqual(fs.readdirSync(dir), ['9999-12-31-0001.ndjson']);
  } finally {
    await j.close();
  }
});
