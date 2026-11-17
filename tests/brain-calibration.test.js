'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CONFIG, createShadow, replay } = require('../src/main/brain');

let id = 5000;
const uuid = () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;

function makeFactory() {
  const source_id = uuid();
  let source_seq = 0;
  return function makeTask() {
    const task_id = uuid();
    let task_seq = 0;
    return (type, atMs, extra = {}) => {
      source_seq++;
      task_seq++;
      const defaults = {
        message: { origin: 'user', route: 'unknown', novelty: 0, uncertainty: 0, contradiction: 0, urgency: 0 },
        tool_result: { outcome: 'ok', duration_ms: 0 },
        error: { error_kind: 'execution' },
        task_completed: { outcome: 'completed', validation: 'verified', utility: 1 },
      };
      return {
        type,
        schema_version: CONFIG.schema_version,
        config_version: CONFIG.version,
        event_id: uuid(),
        task_id,
        source_id,
        source_seq,
        task_seq,
        occurred_at_ms: atMs,
        received_at_ms: atMs,
        ...defaults[type],
        ...extra,
      };
    };
  };
}

test('calibration S1: 2 errors in 30s stay below enter; 3rd error activates reassessment in same window', () => {
  const shadow = createShadow();
  const task = makeFactory()();
  shadow.ingest({ privacy: 'ordinary', event: task('message', 0) });

  const e1 = shadow.ingest({ privacy: 'ordinary', event: task('error', 0) }).state;
  assert.equal(e1.reassessment, 0.25);
  assert.equal(e1.reassessment_active, 0);

  const e2 = shadow.ingest({ privacy: 'ordinary', event: task('error', 10000) }).state;
  assert.ok(e2.reassessment < CONFIG.enter);
  assert.equal(e2.reassessment_active, 0);

  const e3 = shadow.ingest({ privacy: 'ordinary', event: task('error', 20000) }).state;
  assert.ok(e3.reassessment >= CONFIG.enter);
  assert.equal(e3.reassessment_active, 1);
});

test('calibration S2: 2+2 error bursts near 60s window boundary activate on 3rd error; 4th across boundary opens next window', () => {
  const run = (times) => {
    const shadow = createShadow();
    const task = makeFactory()();
    shadow.ingest({ privacy: 'ordinary', event: task('message', 0) });
    return times.map((t) => shadow.ingest({ privacy: 'ordinary', event: task('error', t) }).state);
  };

  const same = run([0, 5000, 55000, 58000]);
  const cross = run([0, 5000, 55000, 62000]);

  // Inside one 60s window, 3rd error activates (0.6581) and 4th hits 0.70 cap without extra jump.
  assert.equal(same[1].reassessment_active, 0);
  assert.equal(same[2].reassessment_active, 1);
  assert.ok(same[3].reassessment < same[2].reassessment);

  // Crossing t=60s opens a fresh window for the 4th error (+0.25 -> ~0.9005).
  assert.equal(cross[2].reassessment_active, 1);
  assert.ok(cross[3].reassessment > 0.85);
});

test('calibration S3: alternating +1 verified / error every 10s for 5 min prevents reassessment saturation', () => {
  const shadow = createShadow();
  const mkTask = makeFactory();
  let peakReassess = 0;
  let lastState = null;

  for (let k = 0; k <= 30; k++) {
    const t = k * 10000;
    const task = mkTask();
    shadow.ingest({ privacy: 'ordinary', event: task('message', t) });
    const ev = k % 2 === 0
      ? task('task_completed', t, { outcome: 'completed', validation: 'verified', utility: 1 })
      : task('error', t);
    lastState = shadow.ingest({ privacy: 'ordinary', event: ev }).state;
    if (lastState.reassessment > peakReassess) peakReassess = lastState.reassessment;
  }

  // With verified_reassessment_relief=0.2, net per error+success pair is +0.05 (not +0.35),
  // so after 5 min reassessment stays far below 1.0 saturation (observed ~0.5505; peak ~0.7631).
  assert.ok(lastState.reassessment <= 0.60, `expected <= 0.60, got ${lastState.reassessment}`);
  assert.ok(peakReassess < 0.85, `expected peak < 0.85, got ${peakReassess}`);
  assert.equal(lastState.stability_active, 1);

  // Failed or non-positive verified completions must never reduce reassessment.
  const neg = createShadow();
  const tFail = makeFactory()();
  neg.ingest({ privacy: 'ordinary', event: tFail('message', 0) });
  const afterErr = neg.ingest({ privacy: 'ordinary', event: tFail('error', 0) }).state.reassessment;
  const afterFailedDone = neg.ingest({
    privacy: 'ordinary',
    event: tFail('task_completed', 0, { outcome: 'failed', validation: 'verified', utility: -1 }),
  }).state.reassessment;
  assert.equal(afterFailedDone, afterErr);

  const zero = createShadow();
  const tZero = makeFactory()();
  zero.ingest({ privacy: 'ordinary', event: tZero('message', 0) });
  const beforeZero = zero.ingest({ privacy: 'ordinary', event: tZero('error', 0) }).state.reassessment;
  const afterZero = zero.ingest({
    privacy: 'ordinary',
    event: tZero('task_completed', 0, { outcome: 'completed', validation: 'verified', utility: 0 }),
  }).state.reassessment;
  assert.equal(afterZero, beforeZero);
});

test('calibration S4 & v3 schema: 1 error every 2 min accumulates across windows, and v2 journals are refused', () => {
  const shadow = createShadow();
  const mkTask = makeFactory();
  let at4m;
  let at6m;
  let at8m;
  let at60m;

  for (let m = 0; m <= 60; m += 2) {
    const t = m * 60000;
    const task = mkTask();
    shadow.ingest({ privacy: 'ordinary', event: task('message', t) });
    const st = shadow.ingest({ privacy: 'ordinary', event: task('error', t) }).state;
    if (m === 4) at4m = st;
    if (m === 6) at6m = st;
    if (m === 8) at8m = st;
    if (m === 60) at60m = st;
  }

  assert.equal(at4m.reassessment_active, 0);
  assert.equal(at6m.reassessment_active, 1);
  assert.equal(at8m.stability_active, 1);
  assert.equal(at60m.reassessment, 1);
  assert.equal(at60m.stability, 0);

  assert.equal(CONFIG.version, 3);
  assert.equal(CONFIG.schema_version, 3);
  const lines = [];
  const rec = createShadow({ append: (line) => lines.push(line) });
  rec.ingest({ privacy: 'ordinary', event: makeFactory()()('message', 0) });
  const v2Journal = lines.join('').replace('"schema_version":3', '"schema_version":2').replace('"version":3', '"version":2');
  assert.throws(() => replay(v2Journal), /mismatch/);
});
