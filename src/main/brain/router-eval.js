'use strict';

// Offline Stage 7b evaluation core for router-journal/v1 (CPU-only, read-only, zero text).
// Implements §2 (Gate 7b) and §§10-11 (Lead + Hydrogen review decisions):
// BSS > 0, ROC-AUC >= 0.62 with 90% bootstrap lower bound > 0.55 (1000 draws, fixed seed),
// 5-bin ECE + reliability table as calibration diagnostics, and MNAR observation weights
// by executor x modality bucket with alpha0 = 10 shrinkage and clip M = 10.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_THRESHOLDS = Object.freeze({
  minTurns: 200,
  minVerified: 40,
  minBss: 0,
  minRocAucPoint: 0.62,
  minRocAucLower: 0.55,
  diagMaxEce: 0.08,
});

const DEFAULT_BOOTSTRAP = Object.freeze({
  iterations: 1000,
  seed: 20261118,
  confidence: 0.90,
});

const DEFAULT_MNAR = Object.freeze({
  alpha0: 10,
  maxWeight: 10,
  minProb: 0.05,
});

const round6 = (n) => (Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null);

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeWeights(length, weights) {
  const out = new Array(length);
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const w = weights ? Number(weights[i]) : 1;
    if (!Number.isFinite(w) || w < 0) {
      out[i] = 0;
    } else {
      out[i] = w;
      sum += w;
    }
  }
  return { out, sum };
}

/** Deterministic 32-bit PRNG (Mulberry32). */
function createRng(seed = DEFAULT_BOOTSTRAP.seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weighted Brier score on binary outcomes (0/1). Returns null when empty or zero weight. */
function brier(predictions, outcomes, weights = null) {
  if (!Array.isArray(predictions) || !Array.isArray(outcomes) || predictions.length !== outcomes.length || !predictions.length) {
    return null;
  }
  const { out: w, sum: wSum } = normalizeWeights(predictions.length, weights);
  if (wSum <= 0) return null;
  let sq = 0;
  for (let i = 0; i < predictions.length; i++) {
    if (w[i] <= 0) continue;
    const p = clamp01(predictions[i]);
    const y = outcomes[i] ? 1 : 0;
    if (p === null) return null;
    const diff = p - y;
    sq += w[i] * diff * diff;
  }
  return sq / wSum;
}

/** Brier Skill Score against constant base-rate prediction: 1 - BS / (yBar * (1 - yBar)). */
function bss(predictions, outcomes, weights = null) {
  const score = brier(predictions, outcomes, weights);
  if (score === null) return null;
  const { out: w, sum: wSum } = normalizeWeights(outcomes.length, weights);
  if (wSum <= 0) return null;
  let posW = 0;
  for (let i = 0; i < outcomes.length; i++) {
    if (w[i] > 0 && outcomes[i]) posW += w[i];
  }
  const baseRate = posW / wSum;
  const bsBase = baseRate * (1 - baseRate);
  if (bsBase <= 0) return null;
  return 1 - (score / bsBase);
}

/** Tie-aware weighted ROC-AUC via rank concordance. Returns null if a class has zero weight. */
function rocAuc(scores, outcomes, weights = null) {
  if (!Array.isArray(scores) || !Array.isArray(outcomes) || scores.length !== outcomes.length || !scores.length) {
    return null;
  }
  const { out: w } = normalizeWeights(scores.length, weights);
  const rows = [];
  let totalPos = 0;
  let totalNeg = 0;
  for (let i = 0; i < scores.length; i++) {
    const wi = w[i];
    if (wi <= 0) continue;
    const s = Number(scores[i]);
    if (!Number.isFinite(s)) return null;
    const y = outcomes[i] ? 1 : 0;
    if (y === 1) totalPos += wi;
    else totalNeg += wi;
    rows.push({ s, y, w: wi });
  }
  if (totalPos <= 0 || totalNeg <= 0) return null;

  rows.sort((a, b) => a.s - b.s);
  let negBefore = 0;
  let concordant = 0;
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (j < rows.length && rows[j].s === rows[i].s) j++;
    let grpPos = 0;
    let grpNeg = 0;
    for (let k = i; k < j; k++) {
      if (rows[k].y === 1) grpPos += rows[k].w;
      else grpNeg += rows[k].w;
    }
    concordant += grpPos * (negBefore + 0.5 * grpNeg);
    negBefore += grpNeg;
    i = j;
  }
  return concordant / (totalPos * totalNeg);
}

/** Reliability diagram across uniform probability bins on [0, 1]. */
function reliability(predictions, outcomes, { bins = 5, weights = null } = {}) {
  const nBins = Math.max(1, Math.trunc(Number(bins) || 5));
  const emptyBins = Array.from({ length: nBins }, (_, idx) => ({
    bin_index: idx,
    range: [round6(idx / nBins), round6((idx + 1) / nBins)],
    count: 0,
    weight_sum: 0,
    conf_sum: 0,
    acc_sum: 0,
  }));
  if (!Array.isArray(predictions) || !Array.isArray(outcomes) || predictions.length !== outcomes.length || !predictions.length) {
    return emptyBins.map(({ conf_sum: _c, acc_sum: _a, ...b }) => ({ ...b, avg_confidence: null, avg_accuracy: null, gap: null }));
  }
  const { out: w } = normalizeWeights(predictions.length, weights);
  for (let i = 0; i < predictions.length; i++) {
    const wi = w[i];
    if (wi <= 0) continue;
    const p = clamp01(predictions[i]);
    if (p === null) continue;
    const y = outcomes[i] ? 1 : 0;
    const idx = Math.min(nBins - 1, Math.floor(p * nBins));
    const b = emptyBins[idx];
    b.count++;
    b.weight_sum += wi;
    b.conf_sum += wi * p;
    b.acc_sum += wi * y;
  }
  return emptyBins.map((b) => {
    const populated = b.weight_sum > 0;
    const avgConf = populated ? b.conf_sum / b.weight_sum : null;
    const avgAcc = populated ? b.acc_sum / b.weight_sum : null;
    return {
      bin_index: b.bin_index,
      range: b.range,
      count: b.count,
      weight_sum: round6(b.weight_sum),
      avg_confidence: round6(avgConf),
      avg_accuracy: round6(avgAcc),
      gap: populated ? round6(Math.abs(avgAcc - avgConf)) : null,
    };
  });
}

/** Expected Calibration Error (ECE) over uniform bins on [0, 1]. */
function ece(predictions, outcomes, { bins = 5, weights = null } = {}) {
  const table = reliability(predictions, outcomes, { bins, weights });
  let totalW = 0;
  let weightedGap = 0;
  for (const row of table) {
    if (!row.weight_sum || row.gap === null) continue;
    totalW += row.weight_sum;
    weightedGap += row.weight_sum * row.gap;
  }
  return totalW > 0 ? weightedGap / totalW : null;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/** Deterministic bootstrap confidence interval with fixed PRNG seed. */
function bootstrapCi(metricFn, items, {
  iterations = DEFAULT_BOOTSTRAP.iterations,
  seed = DEFAULT_BOOTSTRAP.seed,
  confidence = DEFAULT_BOOTSTRAP.confidence,
} = {}) {
  const n = Array.isArray(items) ? items.length : 0;
  const iters = Math.max(1, Math.trunc(Number(iterations) || DEFAULT_BOOTSTRAP.iterations));
  const conf = Math.max(0.01, Math.min(0.999, Number(confidence) || DEFAULT_BOOTSTRAP.confidence));
  const pointRaw = n > 0 ? metricFn(items) : null;
  const point = Number.isFinite(pointRaw) ? pointRaw : null;

  if (n === 0) {
    return { point, lower: null, upper: null, confidence: conf, iterations: iters, valid_iterations: 0, seed };
  }

  const rng = createRng(seed);
  const samples = [];
  const draw = new Array(n);
  for (let b = 0; b < iters; b++) {
    for (let i = 0; i < n; i++) {
      draw[i] = items[Math.floor(rng() * n)];
    }
    const val = metricFn(draw);
    if (Number.isFinite(val)) samples.push(val);
  }
  if (!samples.length) {
    return { point: round6(point), lower: null, upper: null, confidence: conf, iterations: iters, valid_iterations: 0, seed };
  }
  samples.sort((a, b) => a - b);
  const alpha = (1 - conf) / 2;
  return {
    point: round6(point),
    lower: round6(quantile(samples, alpha)),
    upper: round6(quantile(samples, 1 - alpha)),
    confidence: conf,
    iterations: iters,
    valid_iterations: samples.length,
    seed,
  };
}

/**
 * Computes clipped inverse-observation-probability weights (MNAR, §11 item 5)
 * grouped by `executor x modality` buckets and smoothed toward global rate with `alpha0 = 10`.
 */
function observationWeights(turns, {
  alpha0 = DEFAULT_MNAR.alpha0,
  maxWeight = DEFAULT_MNAR.maxWeight,
  minProb = DEFAULT_MNAR.minProb,
} = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const localEligible = list.filter((t) => t.model === 'e4b' || t.model === '26b');
  const pool = localEligible.length ? localEligible : list;
  const verifiedTotal = pool.filter((t) => t.verified).length;
  const globalRate = pool.length ? verifiedTotal / pool.length : 0.5;

  const bucketStats = new Map();
  for (const t of pool) {
    const executor = t.model || 'unknown';
    const modality = t.modality || t.input_modality || 'text';
    const key = `${executor}:${modality}`;
    if (!bucketStats.has(key)) bucketStats.set(key, { key, executor, modality, total: 0, verified: 0 });
    const entry = bucketStats.get(key);
    entry.total++;
    if (t.verified) entry.verified++;
  }

  const buckets = {};
  for (const entry of [...bucketStats.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const smoothed = (entry.verified + alpha0 * globalRate) / (entry.total + alpha0);
    const weight = Math.min(maxWeight, 1 / Math.max(minProb, smoothed));
    buckets[entry.key] = {
      executor: entry.executor,
      modality: entry.modality,
      total: entry.total,
      verified: entry.verified,
      raw_rate: entry.total ? round6(entry.verified / entry.total) : null,
      smoothed_prob: round6(smoothed),
      weight: round6(weight),
    };
  }

  const weightsByTurnId = new Map();
  for (const t of pool) {
    const key = `${t.model || 'unknown'}:${t.modality || t.input_modality || 'text'}`;
    if (t.turn_id && buckets[key]) weightsByTurnId.set(t.turn_id, buckets[key].weight);
  }

  return {
    method: 'executor_x_modality',
    alpha0,
    max_weight: maxWeight,
    min_prob: minProb,
    eligible_turns: pool.length,
    verified_turns: verifiedTotal,
    global_observation_rate: round6(globalRate),
    buckets,
    weightsByTurnId,
  };
}

/** Evaluates Gate 7b decision ('осмыслен' / 'не осмыслен' / 'мало данных') with explicit reasons. */
function gate7b(stats = {}, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const totalTurns = Number(stats.totalTurns ?? stats.total_turns ?? 0);
  const verifiedTurns = Number(stats.verifiedTurns ?? stats.verified_turns ?? 0);
  const bssVal = stats.bss ?? null;
  const aucVal = stats.rocAuc ?? stats.roc_auc ?? null;
  const aucLower = stats.rocAucLower ?? stats.roc_auc_lower ?? null;
  const eceVal = stats.ece ?? null;
  const negTurns = stats.negativeTurns ?? stats.negative_turns ?? null;

  const insufficientReasons = [];
  if (totalTurns < t.minTurns) {
    insufficientReasons.push(`Мало ходов в журнале: ${totalTurns} < ${t.minTurns}.`);
  }
  if (verifiedTurns < t.minVerified) {
    insufficientReasons.push(`Мало проверенных ходов (verdict +1/-1): ${verifiedTurns} < ${t.minVerified}.`);
  }
  if (verifiedTurns >= t.minVerified && (bssVal === null || aucVal === null || aucLower === null)) {
    insufficientReasons.push('В проверенных ходах присутствует только один исход (+1 или -1), BSS/ROC-AUC не определены.');
  }

  if (insufficientReasons.length) {
    return {
      verdict: 'мало данных',
      status: 'insufficient_data',
      passed: false,
      checks: {
        min_turns_ok: totalTurns >= t.minTurns,
        min_verified_ok: verifiedTurns >= t.minVerified,
        bss_gt_0: false,
        roc_auc_point_ok: false,
        roc_auc_lower_ok: false,
      },
      reasons: insufficientReasons,
      notes: [],
      thresholds: { ...t },
    };
  }

  const bssOk = bssVal > t.minBss;
  const aucPointOk = aucVal >= t.minRocAucPoint;
  const aucLowerOk = aucLower > t.minRocAucLower;
  const passed = bssOk && aucPointOk && aucLowerOk;

  const reasons = [];
  if (bssOk) reasons.push(`BSS > ${t.minBss} (${round6(bssVal)}): прогноз точнее базовой частоты.`);
  else reasons.push(`BSS <= ${t.minBss} (${round6(bssVal)}): прогноз не лучше базовой частоты.`);

  if (aucPointOk) reasons.push(`ROC-AUC >= ${t.minRocAucPoint} (${round6(aucVal)}).`);
  else reasons.push(`ROC-AUC < ${t.minRocAucPoint} (${round6(aucVal)}).`);

  if (aucLowerOk) reasons.push(`Нижняя 90% бутстрап-граница ROC-AUC > ${t.minRocAucLower} (${round6(aucLower)}).`);
  else reasons.push(`Нижняя 90% бутстрап-граница ROC-AUC <= ${t.minRocAucLower} (${round6(aucLower)}).`);

  const notes = [];
  if (eceVal !== null) {
    if (eceVal > t.diagMaxEce) {
      notes.push(`Диагностика ECE = ${round6(eceVal)} (> ${t.diagMaxEce}): заметно смещение уверенности; при шаге 7c нужна калибровка (temperature / Platt).`);
    } else {
      notes.push(`Диагностика ECE = ${round6(eceVal)} (<= ${t.diagMaxEce}): калибровка в норме.`);
    }
  }
  if (negTurns !== null && negTurns < 10) {
    notes.push(`Диагностика: отрицательных вердиктов ${negTurns} (< 10), интервал может быть широким.`);
  }

  return {
    verdict: passed ? 'осмыслен' : 'не осмыслен',
    status: passed ? 'meaningful' : 'not_meaningful',
    passed,
    checks: {
      min_turns_ok: true,
      min_verified_ok: true,
      bss_gt_0: bssOk,
      roc_auc_point_ok: aucPointOk,
      roc_auc_lower_ok: aucLowerOk,
    },
    reasons,
    notes,
    thresholds: { ...t },
  };
}

/** Reads NDJSON journal files from `dirPath` strictly read-only. */
function readRouterJournalDir(dirPath) {
  if (typeof dirPath !== 'string' || !dirPath.trim()) {
    throw new Error('router-eval: path to router-journal directory is required');
  }
  const absDir = path.resolve(dirPath);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    throw new Error(`router-eval: directory does not exist: ${absDir}`);
  }
  const files = fs.readdirSync(absDir)
    .filter((name) => name.endsWith('.ndjson'))
    .sort();

  const records = [];
  let linesTotal = 0;
  let invalidLines = 0;

  for (const name of files) {
    const content = fs.readFileSync(path.join(absDir, name), 'utf8');
    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      linesTotal++;
      try {
        const rec = JSON.parse(line);
        if (!rec || typeof rec !== 'object' || rec.schema_version !== 1 || typeof rec.turn_id !== 'string') {
          invalidLines++;
          continue;
        }
        records.push(rec);
      } catch {
        invalidLines++;
      }
    }
  }

  return {
    dir: absDir,
    files_read: files.length,
    lines_total: linesTotal,
    invalid_lines: invalidLines,
    records,
  };
}

function extractAbGroup(decision) {
  const candidate = decision?.ab_group ?? decision?.action?.ab_group ?? decision?.pre?.ab_group ?? null;
  return candidate === 'A' || candidate === 'B' ? candidate : null;
}

function extractPrediction(decision, outcome) {
  const raw = Number.isFinite(decision?.action?.prediction)
    ? decision.action.prediction
    : (Number.isFinite(outcome?.prediction) ? outcome.prediction : null);
  if (raw !== null) return clamp01(raw);
  if (decision?.action?.model === 'e4b' && Number.isFinite(decision?.action?.p_e4b)) {
    return clamp01(decision.action.p_e4b);
  }
  if (Number.isFinite(decision?.raw_router?.risk)) {
    return clamp01(1 - Math.min(1, Math.max(0, decision.raw_router.risk)) * 0.5);
  }
  return null;
}

/** Stitches `decision` and `outcome` records by `turn_id`; outcomes without decision are ignored. */
function stitchRouterRecords(records) {
  const decisions = new Map();
  const outcomes = new Map();
  let duplicateDecisions = 0;
  let duplicateOutcomes = 0;
  let orphanOutcomes = 0;

  for (const rec of records || []) {
    if (!rec || typeof rec !== 'object' || typeof rec.turn_id !== 'string') continue;
    if (rec.kind === 'decision') {
      if (decisions.has(rec.turn_id)) {
        duplicateDecisions++;
        continue;
      }
      decisions.set(rec.turn_id, rec);
    } else if (rec.kind === 'outcome') {
      if (outcomes.has(rec.turn_id)) {
        duplicateOutcomes++;
        continue;
      }
      outcomes.set(rec.turn_id, rec);
    }
  }

  const turns = [];
  for (const [turnId, d] of decisions.entries()) {
    const o = outcomes.get(turnId) || null;
    const verdict = o && (o.verdict === 1 || o.verdict === -1) ? o.verdict : null;
    const verified = verdict !== null;
    turns.push({
      turn_id: turnId,
      ts_ms: Number(d.ts_ms) || 0,
      model: d.action?.model || o?.model || 'unknown',
      modality: d.input_modality || 'text',
      route_path: d.route_path || 'unknown',
      ab_group: extractAbGroup(d),
      overlapping: d.action?.overlapping === 1,
      propensity: Number.isFinite(d.action?.propensity) ? d.action.propensity : null,
      prediction: extractPrediction(d, o),
      verdict,
      verified,
      success: verified ? (verdict === 1 ? 1 : 0) : null,
      verdict_source: o?.verdict_source || null,
      decision: d,
      outcome: o,
    });
  }

  for (const turnId of outcomes.keys()) {
    if (!decisions.has(turnId)) orphanOutcomes++;
  }

  return {
    turns,
    diagnostics: {
      duplicate_decisions: duplicateDecisions,
      duplicate_outcomes: duplicateOutcomes,
      orphan_outcomes: orphanOutcomes,
    },
  };
}

function summarizeGroupCounts(turns) {
  let total = 0;
  let verified = 0;
  let positive = 0;
  let negative = 0;
  for (const t of turns) {
    total++;
    if (t.verified) {
      verified++;
      if (t.verdict === 1) positive++;
      else if (t.verdict === -1) negative++;
    }
  }
  return {
    total,
    verified,
    verified_rate: total ? round6(verified / total) : 0,
    positive,
    negative,
  };
}

function summarizePropensity(turns) {
  const vals = turns.map((t) => t.propensity).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!vals.length) {
    return {
      count: 0,
      min: null,
      p10: null,
      p25: null,
      median: null,
      p75: null,
      p90: null,
      max: null,
      mean: null,
      below_overlap_floor_003: 0,
      exact_1: 0,
      bins: { '[0,0.03)': 0, '[0.03,0.2)': 0, '[0.2,0.5)': 0, '[0.5,0.8)': 0, '[0.8,1)': 0, '1': 0 },
    };
  }
  let sum = 0;
  let below003 = 0;
  let exact1 = 0;
  const bins = { '[0,0.03)': 0, '[0.03,0.2)': 0, '[0.2,0.5)': 0, '[0.5,0.8)': 0, '[0.8,1)': 0, '1': 0 };
  for (const v of vals) {
    sum += v;
    if (v < 0.03) below003++;
    if (v === 1) exact1++;
    if (v < 0.03) bins['[0,0.03)']++;
    else if (v < 0.2) bins['[0.03,0.2)']++;
    else if (v < 0.5) bins['[0.2,0.5)']++;
    else if (v < 0.8) bins['[0.5,0.8)']++;
    else if (v < 1) bins['[0.8,1)']++;
    else bins['1']++;
  }
  return {
    count: vals.length,
    min: round6(vals[0]),
    p10: round6(quantile(vals, 0.10)),
    p25: round6(quantile(vals, 0.25)),
    median: round6(quantile(vals, 0.50)),
    p75: round6(quantile(vals, 0.75)),
    p90: round6(quantile(vals, 0.90)),
    max: round6(vals[vals.length - 1]),
    mean: round6(sum / vals.length),
    below_overlap_floor_003: below003,
    exact_1: exact1,
    bins,
  };
}

function computeMetricBlock(items, { bins = 5, iterations = DEFAULT_BOOTSTRAP.iterations, seed = DEFAULT_BOOTSTRAP.seed, confidence = DEFAULT_BOOTSTRAP.confidence, weighted = false } = {}) {
  const preds = items.map((x) => x.pred);
  const ys = items.map((x) => x.outcome);
  const weights = weighted ? items.map((x) => x.weight) : null;
  const posCount = ys.filter((y) => y === 1).length;
  const negCount = ys.length - posCount;
  const { out: normW, sum: wSum } = normalizeWeights(ys.length, weights);
  let posW = 0;
  for (let i = 0; i < ys.length; i++) if (normW[i] > 0 && ys[i] === 1) posW += normW[i];
  const baseRate = wSum > 0 ? posW / wSum : null;
  const bsBase = baseRate !== null ? baseRate * (1 - baseRate) : null;

  const bsVal = brier(preds, ys, weights);
  const bssVal = bss(preds, ys, weights);
  const aucCi = bootstrapCi(
    (sample) => rocAuc(
      sample.map((x) => x.pred),
      sample.map((x) => x.outcome),
      weighted ? sample.map((x) => x.weight) : null,
    ),
    items,
    { iterations, seed, confidence },
  );
  const relTable = reliability(preds, ys, { bins, weights });
  const eceVal = ece(preds, ys, { bins, weights });

  return {
    n: items.length,
    positive: posCount,
    negative: negCount,
    base_rate: round6(baseRate),
    brier: round6(bsVal),
    brier_base: round6(bsBase),
    bss: round6(bssVal),
    roc_auc: aucCi.point,
    roc_auc_ci: aucCi,
    ece: round6(eceVal),
    ece_bins: bins,
    reliability: relTable,
  };
}

/** Runs complete offline Gate 7b evaluation on already stitched turns. */
function evaluateStitchedTurns(turns, {
  iterations = DEFAULT_BOOTSTRAP.iterations,
  seed = DEFAULT_BOOTSTRAP.seed,
  confidence = DEFAULT_BOOTSTRAP.confidence,
  bins = 5,
  alpha0 = DEFAULT_MNAR.alpha0,
  maxWeight = DEFAULT_MNAR.maxWeight,
  minProb = DEFAULT_MNAR.minProb,
  thresholds = {},
} = {}) {
  const obs = observationWeights(turns, { alpha0, maxWeight, minProb });

  const byModel = {};
  for (const m of ['e4b', '26b']) {
    byModel[m] = summarizeGroupCounts(turns.filter((t) => t.model === m));
  }
  const extraModels = [...new Set(turns.map((t) => t.model).filter((m) => m !== 'e4b' && m !== '26b'))].sort();
  for (const m of extraModels) {
    byModel[m] = summarizeGroupCounts(turns.filter((t) => t.model === m));
  }

  const byModality = {
    text: summarizeGroupCounts(turns.filter((t) => t.modality === 'text')),
    voice: summarizeGroupCounts(turns.filter((t) => t.modality === 'voice')),
  };

  const abGroups = [...new Set(turns.map((t) => t.ab_group).filter(Boolean))].sort();
  const byAbGroup = abGroups.length
    ? Object.fromEntries(abGroups.map((g) => [g, summarizeGroupCounts(turns.filter((t) => t.ab_group === g))]))
    : null;

  const overallCounts = summarizeGroupCounts(turns);
  const localTurns = turns.filter((t) => t.model === 'e4b' || t.model === '26b');
  const overlappingCount = turns.filter((t) => t.overlapping).length;
  const overlappingLocalCount = localTurns.filter((t) => t.overlapping).length;

  const evalItems = turns
    .filter((t) => t.verified && t.prediction !== null)
    .map((t) => ({
      turn_id: t.turn_id,
      pred: t.prediction,
      outcome: t.success,
      weight: obs.weightsByTurnId.get(t.turn_id) ?? 1,
    }));

  const unweighted = computeMetricBlock(evalItems, { bins, iterations, seed, confidence, weighted: false });
  const weighted = computeMetricBlock(evalItems, { bins, iterations, seed, confidence, weighted: true });

  const gate = gate7b({
    totalTurns: overallCounts.total,
    verifiedTurns: overallCounts.verified,
    positiveTurns: overallCounts.positive,
    negativeTurns: overallCounts.negative,
    bss: weighted.bss,
    rocAuc: weighted.roc_auc,
    rocAucLower: weighted.roc_auc_ci.lower,
    ece: weighted.ece,
  }, thresholds);

  return {
    schema: 'router-eval/v1',
    volumes: {
      total_turns: overallCounts.total,
      verified_turns: overallCounts.verified,
      verified_rate: overallCounts.verified_rate,
      positive_turns: overallCounts.positive,
      negative_turns: overallCounts.negative,
      evaluated_verified_turns: evalItems.length,
      by_model: byModel,
      by_modality: byModality,
      by_ab_group: byAbGroup,
    },
    overlap: {
      count: overlappingCount,
      rate: overallCounts.total ? round6(overlappingCount / overallCounts.total) : 0,
      local_count: overlappingLocalCount,
      local_rate: localTurns.length ? round6(overlappingLocalCount / localTurns.length) : 0,
    },
    propensity_distribution: summarizePropensity(turns),
    observation_weights: {
      method: obs.method,
      alpha0: obs.alpha0,
      max_weight: obs.max_weight,
      min_prob: obs.min_prob,
      eligible_turns: obs.eligible_turns,
      verified_turns: obs.verified_turns,
      global_observation_rate: obs.global_observation_rate,
      buckets: obs.buckets,
    },
    metrics: {
      primary: weighted,
      weighted_mnar: weighted,
      unweighted,
    },
    gate_7b: gate,
  };
}

/** Reads a `router-journal/v1` directory read-only and computes the full Gate 7b report. */
function evaluateRouterJournal(dirPath, options = {}) {
  const loaded = readRouterJournalDir(dirPath);
  const stitched = stitchRouterRecords(loaded.records);
  const result = evaluateStitchedTurns(stitched.turns, options);
  return {
    ...result,
    journal: {
      dir: loaded.dir,
      files_read: loaded.files_read,
      lines_total: loaded.lines_total,
      invalid_lines: loaded.invalid_lines,
      duplicate_decisions: stitched.diagnostics.duplicate_decisions,
      duplicate_outcomes: stitched.diagnostics.duplicate_outcomes,
      orphan_outcomes: stitched.diagnostics.orphan_outcomes,
    },
  };
}

function fmt(v, digits = 3) {
  return v === null || v === undefined || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(digits);
}

/** Renders a concise Russian Markdown summary of the Gate 7b report. */
function formatMarkdownReport(report) {
  const v = report.volumes;
  const m = report.metrics.primary;
  const g = report.gate_7b;
  const lines = [
    '# Отчёт Gate 7b — оценка роутера Капри',
    '',
    `**Вердикт:** \`${g.verdict}\``,
    ...g.reasons.map((r) => `- ${r}`),
    ...(g.notes || []).map((n) => `- ${n}`),
    '',
    '## Объёмы',
    `- Всего ходов: **${v.total_turns}**, проверенных: **${v.verified_turns}** (${fmt(v.verified_rate * 100, 1)}%), +1 / -1: ${v.positive_turns} / ${v.negative_turns}`,
    `- По модели: e4b=${v.by_model.e4b.total} (пров. ${v.by_model.e4b.verified}), 26b=${v.by_model['26b'].total} (пров. ${v.by_model['26b'].verified})`,
    `- По модальности: text=${v.by_modality.text.total} (пров. ${v.by_modality.text.verified}), voice=${v.by_modality.voice.total} (пров. ${v.by_modality.voice.verified})`,
  ];
  if (v.by_ab_group) {
    const abText = Object.entries(v.by_ab_group).map(([k, val]) => `${k}=${val.total} (пров. ${val.verified})`).join(', ');
    lines.push(`- По группе A/B: ${abText}`);
  }
  lines.push(
    `- Overlapping: **${report.overlap.count}** (${fmt(report.overlap.rate * 100, 1)}%); propensity median=${fmt(report.propensity_distribution.median)}, p10=${fmt(report.propensity_distribution.p10)}, p90=${fmt(report.propensity_distribution.p90)}`,
    '',
    '## Метрики (с MNAR-весами наблюдения)',
    `- Brier: **${fmt(m.brier, 4)}** (base: ${fmt(m.brier_base, 4)}), BSS: **${fmt(m.bss, 4)}**`,
    `- ROC-AUC: **${fmt(m.roc_auc, 4)}** (90% CI: [${fmt(m.roc_auc_ci.lower, 4)}, ${fmt(m.roc_auc_ci.upper, 4)}], n_boot=${m.roc_auc_ci.iterations}, seed=${m.roc_auc_ci.seed})`,
    `- Диагностика ECE (5 бинов): **${fmt(m.ece, 4)}**`,
    '',
    '## Reliability (5 бинов)',
    '| Бин | N | Уверенность | Успех | Зазор |',
    '|---|---|---|---|---|',
    ...m.reliability.map((b) => `| [${b.range[0]}, ${b.range[1]}] | ${b.count} | ${fmt(b.avg_confidence)} | ${fmt(b.avg_accuracy)} | ${fmt(b.gap)} |`),
  );
  return `${lines.join('\n')}\n`;
}

module.exports = {
  DEFAULT_THRESHOLDS,
  DEFAULT_BOOTSTRAP,
  DEFAULT_MNAR,
  brier,
  bss,
  rocAuc,
  reliability,
  ece,
  bootstrapCi,
  observationWeights,
  gate7b,
  readRouterJournalDir,
  stitchRouterRecords,
  evaluateStitchedTurns,
  evaluateRouterJournal,
  formatMarkdownReport,
};
