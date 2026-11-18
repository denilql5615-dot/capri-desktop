'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  brier,
  bss,
  rocAuc,
  reliability,
  ece,
  bootstrapCi,
  observationWeights,
  gate7b,
  stitchRouterRecords,
  evaluateRouterJournal,
} = require('../src/main/brain/router-eval');
const {
  buildDecisionRecord,
  sanitizeRouterRecord,
} = require('../src/main/brain/router-journal');

const BENCH_SCRIPT = path.join(__dirname, '..', 'scripts', 'router-eval-bench.js');

function makeUuid(start = 1000) {
  let n = start;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

function createPrng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Writes a valid synthetic `router-journal/v1` NDJSON dataset into a temporary directory. */
function writeSyntheticJournalDir({
  totalTurns = 240,
  verifiedCount = 80,
  signal = 'meaningful',
  includeAb = false,
  orphanOutcomes = 3,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-router-eval-'));
  const uuid = makeUuid(5000);
  const rng = createPrng(1337);
  const lines = [];
  const startMs = Date.UTC(2026, 10, 18, 8, 0, 0);

  for (let i = 0; i < totalTurns; i++) {
    const turnId = uuid();
    const tsMs = startMs + i * 30_000;
    const isVoice = i % 4 === 0;
    const is26b = i % 5 === 0;
    const model = is26b ? '26b' : 'e4b';

    // Generate latent success + router prediction matched to schema
    const trueQuality = rng();
    const success = signal === 'random'
      ? (rng() < 0.7 ? 1 : 0)
      : (trueQuality >= 0.30 ? 1 : 0);

    let pred;
    if (signal === 'perfect') {
      pred = success ? 0.94 : 0.06;
    } else if (signal === 'meaningful') {
      // Strong signal with mild noise
      pred = Math.max(0.05, Math.min(0.95, (success ? 0.78 : 0.28) + (rng() - 0.5) * 0.25));
    } else {
      // Random noise prediction around 0.5 (orthogonal to success)
      pred = 0.2 + rng() * 0.6;
    }

    const p26b = is26b ? 0.72 : 0.18;
    const pE4b = 1 - p26b;
    const rawDecision = buildDecisionRecord({
      turnId,
      tsMs,
      model,
      voice: isVoice,
      route: {
        route_path: 'router_model',
        fallback_reason: 'none',
        tier: is26b ? 'complex' : 'routine',
        router: {
          router_version: 'router-v1',
          route_path: 'router_model',
          fallback_reason: 'none',
          target: 'capri',
          tier: is26b ? 'complex' : 'routine',
          risk: Number((1 - pred).toFixed(4)),
          self_claim: 0,
          who_probs: { C: 0.92, P: 0.03, W: 0.05 },
          tier_probs: is26b
            ? { mechanical: 0.05, routine: 0.23, complex: 0.58, deep: 0.14 }
            : { mechanical: 0.22, routine: 0.60, complex: 0.15, deep: 0.03 },
          top_logprobs_sym: [{ C: -0.08, W: -3.0 }, is26b ? { 3: -0.54, 2: -1.47 } : { 2: -0.51, 1: -1.51 }],
          who_entropy: 0.32,
          tier_entropy: 0.95,
          tier_margin: 0.38,
          flags: {},
        },
      },
      prediction: pred,
    });

    const sanitizedDecision = sanitizeRouterRecord(rawDecision).record;
    // Allow keeping propensity / p_e4b / p_26b explicitly populated
    sanitizedDecision.action.p_e4b = Number(pE4b.toFixed(6));
    sanitizedDecision.action.p_26b = Number(p26b.toFixed(6));
    sanitizedDecision.action.propensity = Number((is26b ? p26b : pE4b).toFixed(6));
    sanitizedDecision.action.overlapping = sanitizedDecision.action.propensity >= 0.03 ? 1 : 0;
    if (includeAb) sanitizedDecision.ab_group = i % 2 === 0 ? 'A' : 'B';

    lines.push(JSON.stringify(sanitizedDecision));

    if (i < verifiedCount) {
      const outcomeRec = sanitizeRouterRecord({
        schema_version: 1,
        kind: 'outcome',
        router_version: 'router-v1',
        turn_id: turnId,
        ts_ms: tsMs + 4000,
        model,
        verdict: success ? 1 : -1,
        verdict_source: i % 3 === 0 ? 'button' : 'dict',
        prediction: pred,
        rpe: Number(((success ? 1 : 0) - pred).toFixed(6)),
        stage6_override: 0,
      }).record;
      lines.push(JSON.stringify(outcomeRec));
    }
  }

  // Orphan outcomes without any matching decision must be ignored cleanly
  for (let j = 0; j < orphanOutcomes; j++) {
    const orphanRec = sanitizeRouterRecord({
      schema_version: 1,
      kind: 'outcome',
      router_version: 'router-v1',
      turn_id: uuid(),
      ts_ms: startMs + 999_000 + j * 1000,
      model: 'e4b',
      verdict: -1,
      verdict_source: 'button',
      prediction: 0.9,
      rpe: -0.9,
      stage6_override: 0,
    }).record;
    lines.push(JSON.stringify(orphanRec));
  }

  fs.writeFileSync(path.join(dir, '2026-11-18-0001.ndjson'), `${lines.join('\n')}\n`, 'utf8');
  return dir;
}

test('metrics core: perfect vs random predictions give AUC 1 / ~0.5 and expected BSS sign', () => {
  const outcomes = [1, 1, 1, 0, 0, 0, 1, 0, 1, 0];
  const perfect = outcomes.map((y) => (y ? 0.98 : 0.02));
  assert.equal(rocAuc(perfect, outcomes), 1);
  assert.ok(brier(perfect, outcomes) < 0.001);
  assert.ok(bss(perfect, outcomes) > 0.99);

  // Constant 0.5 prediction vs skewed outcomes or anti-correlated predictions -> BSS <= 0
  const skewedOutcomes = [1, 1, 1, 1, 1, 1, 1, 1, 0, 0];
  const badPreds = skewedOutcomes.map(() => 0.5);
  assert.ok(bss(badPreds, skewedOutcomes) < 0);

  // Random uniform predictions over larger balanced sample -> AUC close to 0.5
  const rng = createPrng(999);
  const randOutcomes = Array.from({ length: 400 }, () => (rng() < 0.5 ? 1 : 0));
  const randPreds = Array.from({ length: 400 }, () => rng());
  const auc = rocAuc(randPreds, randOutcomes);
  assert.ok(auc > 0.42 && auc < 0.58, `expected random AUC ~0.5, got ${auc}`);
  assert.ok(bss(randPreds, randOutcomes) < 0);

  // ECE & 5-bin reliability sanity check
  const rel = reliability(perfect, outcomes, { bins: 5 });
  assert.equal(rel.length, 5);
  assert.ok(ece(perfect, outcomes, { bins: 5 }) <= 0.03);
});

test('bootstrapCi is strictly deterministic for a fixed seed and produces a 90% interval around the point estimate', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({
    s: i / 60 + (i % 3 === 0 ? 0.15 : 0),
    y: i >= 22 ? 1 : 0,
  }));
  const metric = (sample) => rocAuc(sample.map((x) => x.s), sample.map((x) => x.y));
  const ci1 = bootstrapCi(metric, items, { iterations: 1000, seed: 20261118, confidence: 0.90 });
  const ci2 = bootstrapCi(metric, items, { iterations: 1000, seed: 20261118, confidence: 0.90 });
  const ciDiffSeed = bootstrapCi(metric, items, { iterations: 1000, seed: 777, confidence: 0.90 });

  assert.deepEqual(ci1, ci2);
  assert.notEqual(ci1.lower, null);
  assert.ok(ci1.lower <= ci1.point && ci1.point <= ci1.upper);
  assert.ok(ciDiffSeed.lower <= ciDiffSeed.point && ciDiffSeed.point <= ciDiffSeed.upper);
});

test('stitchRouterRecords ignores outcome records without a matching decision', () => {
  const idMatched = '00000000-0000-4000-8000-000000000001';
  const idOrphan = '00000000-0000-4000-8000-000000000002';
  const decision = {
    schema_version: 1,
    kind: 'decision',
    turn_id: idMatched,
    ts_ms: 100,
    input_modality: 'text',
    action: { model: 'e4b', propensity: 0.7, overlapping: 1, prediction: 0.8 },
  };
  const outcomeMatched = {
    schema_version: 1,
    kind: 'outcome',
    turn_id: idMatched,
    ts_ms: 200,
    model: 'e4b',
    verdict: 1,
  };
  const outcomeOrphan = {
    schema_version: 1,
    kind: 'outcome',
    turn_id: idOrphan,
    ts_ms: 300,
    model: 'e4b',
    verdict: -1,
  };

  const { turns, diagnostics } = stitchRouterRecords([decision, outcomeOrphan, outcomeMatched]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turn_id, idMatched);
  assert.equal(turns[0].verdict, 1);
  assert.equal(diagnostics.orphan_outcomes, 1);
});

test('observationWeights computes executor x modality smoothed probabilities (alpha0=10) and clips weights at M=10', () => {
  const turns = [];
  // Bucket 1: e4b:text — 100 turns, 50 verified (high obs rate 0.5)
  for (let i = 0; i < 100; i++) {
    turns.push({ turn_id: `t1-${i}`, model: 'e4b', modality: 'text', verified: i < 50 });
  }
  // Bucket 2: 26b:voice — 100 turns, 0 verified (low obs rate -> shrunk toward global=0.25 with alpha0=10, and test clip M=10 on tiny global rate)
  for (let i = 0; i < 100; i++) {
    turns.push({ turn_id: `t2-${i}`, model: '26b', modality: 'voice', verified: false });
  }

  const res = observationWeights(turns, { alpha0: 10, maxWeight: 10, minProb: 0.05 });
  assert.equal(res.global_observation_rate, 0.25);
  // 26b:voice smoothed: (0 + 10 * 0.25) / (100 + 10) = 2.5 / 110 = 0.022727... -> below minProb=0.05 -> clipped to M=10!
  const bLow = res.buckets['26b:voice'];
  assert.ok(Math.abs(bLow.smoothed_prob - (2.5 / 110)) < 1e-5);
  assert.equal(bLow.weight, 10);

  // e4b:text smoothed: (50 + 2.5) / 110 = 52.5 / 110 = 0.477273 -> weight = 110 / 52.5 ≈ 2.095238
  const bHigh = res.buckets['e4b:text'];
  assert.ok(Math.abs(bHigh.weight - (110 / 52.5)) < 1e-5);
});

test('gate7b distinguishes "мало данных", "не осмыслен", and "осмыслен" with explicit reasons', () => {
  const tooFewTurns = gate7b({ totalTurns: 199, verifiedTurns: 60, bss: 0.3, rocAuc: 0.85, rocAucLower: 0.72, ece: 0.04 });
  assert.equal(tooFewTurns.verdict, 'мало данных');
  assert.match(tooFewTurns.reasons.join(' '), /199 < 200/);

  const tooFewVerified = gate7b({ totalTurns: 250, verifiedTurns: 39, bss: 0.3, rocAuc: 0.85, rocAucLower: 0.72, ece: 0.04 });
  assert.equal(tooFewVerified.verdict, 'мало данных');
  assert.match(tooFewVerified.reasons.join(' '), /39 < 40/);

  const noise = gate7b({ totalTurns: 250, verifiedTurns: 80, bss: -0.05, rocAuc: 0.60, rocAucLower: 0.50, ece: 0.12 });
  assert.equal(noise.verdict, 'не осмыслен');
  assert.equal(noise.passed, false);

  const borderlineCi = gate7b({ totalTurns: 250, verifiedTurns: 80, bss: 0.08, rocAuc: 0.63, rocAucLower: 0.54, ece: 0.09 });
  assert.equal(borderlineCi.verdict, 'не осмыслен');
  assert.match(borderlineCi.reasons.join(' '), /<= 0\.55/);

  // Even when ECE > 0.08, BSS > 0 + ROC-AUC >= 0.62 + CI lower > 0.55 passes Gate 7b with calibration note
  const good = gate7b({ totalTurns: 250, verifiedTurns: 80, bss: 0.18, rocAuc: 0.76, rocAucLower: 0.65, ece: 0.11 });
  assert.equal(good.verdict, 'осмыслен');
  assert.equal(good.passed, true);
  assert.match(good.notes.join(' '), /ECE/);
});

test('CLI scripts/router-eval-bench.js runs end-to-end on synthetic journals (JSON + --md) without modifying disk', (t) => {
  const dirGood = writeSyntheticJournalDir({
    totalTurns: 240,
    verifiedCount: 90,
    signal: 'meaningful',
    includeAb: true,
    orphanOutcomes: 4,
  });
  t.after(() => fs.rmSync(dirGood, { recursive: true, force: true }));

  const beforeFiles = fs.readdirSync(dirGood);
  const stdoutJson = execFileSync(process.execPath, [BENCH_SCRIPT, dirGood], { encoding: 'utf8' });
  const afterFiles = fs.readdirSync(dirGood);
  assert.deepEqual(beforeFiles, afterFiles);

  const report = JSON.parse(stdoutJson);
  assert.equal(report.schema, 'router-eval/v1');
  assert.equal(report.volumes.total_turns, 240);
  assert.equal(report.volumes.verified_turns, 90);
  assert.equal(report.journal.orphan_outcomes, 4);
  assert.ok(report.volumes.by_ab_group && report.volumes.by_ab_group.A.total > 0 && report.volumes.by_ab_group.B.total > 0);
  assert.equal(report.metrics.primary.reliability.length, 5);
  assert.equal(report.gate_7b.verdict, 'осмыслен');

  const stdoutMd = execFileSync(process.execPath, [BENCH_SCRIPT, dirGood, '--md'], { encoding: 'utf8' });
  assert.match(stdoutMd, /# Отчёт Gate 7b/);
  assert.match(stdoutMd, /`осмыслен`/);
  assert.match(stdoutMd, /## Reliability \(5 бинов\)/);

  // Random noisy journal -> "не осмыслен"
  const dirNoise = writeSyntheticJournalDir({
    totalTurns: 220,
    verifiedCount: 75,
    signal: 'random',
    includeAb: false,
    orphanOutcomes: 0,
  });
  t.after(() => fs.rmSync(dirNoise, { recursive: true, force: true }));
  const reportNoise = evaluateRouterJournal(dirNoise);
  assert.equal(reportNoise.volumes.by_ab_group, null);
  assert.equal(reportNoise.gate_7b.verdict, 'не осмыслен');

  // Small journal -> "мало данных"
  const dirSmall = writeSyntheticJournalDir({ totalTurns: 50, verifiedCount: 20, signal: 'meaningful' });
  t.after(() => fs.rmSync(dirSmall, { recursive: true, force: true }));
  const reportSmall = evaluateRouterJournal(dirSmall);
  assert.equal(reportSmall.gate_7b.verdict, 'мало данных');
});
