'use strict';

// Stage 7a router decision & outcome NDJSON journal.
// Isolated in userData/router-journal/v1: strictly numeric, enum, and UUID v4 fields only —
// zero raw text, file paths, model name strings, non-ASCII characters, or whitespace on disk.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { canonical } = require('./index');
const { ROUTE_PATHS, FALLBACK_REASONS, lenBucket, computeBinaryPropensity } = require('../router');
const { utc5DayKey, MAX_DAY_TIME_MS } = require('./rotating-journal');

const SCHEMA_VERSION = 1;
const MODELS = Object.freeze(['e4b', '26b', 'cloud', 'worker']);
const WORKER_CLASSES = Object.freeze(['ordinary', 'unknown']);
const MODES = Object.freeze(['off', 'shadow', 'on']);
const MODALITIES = Object.freeze(['text', 'voice']);
const TARGETS = Object.freeze(['capri', 'computer', 'worker', 'none']);
const TIERS = Object.freeze(['mechanical', 'routine', 'complex', 'deep']);
const OUTCOMES = Object.freeze(['completed', 'failed', 'cancelled']);
const VERDICT_SOURCES = Object.freeze(['button', 'dict', 'none']);

const DEFAULT_QUEUE = 64;
const DEFAULT_MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const MIN_SEGMENT_BYTES = 2048;
const MAX_LINE_BYTES = 4096;
const MAX_SEEN_DECISIONS = 512;
const MAX_PENDING_LOCAL_TURNS = 256;
const MAX_NON_LOCAL_TURNS = 256;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_TAG = /^[a-z0-9._-]{1,32}$/;
const SEGMENT_RE = /^(\d{4}-\d{2}-\d{2})-(\d{4})\.ndjson$/;
const PRINTABLE_ASCII_LINE = /^[!-~]+\n$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const own = (v, k) => Object.hasOwn(v, k);

function fail(reason) {
  throw new Error(`router-journal: ${reason}`);
}

function assertExactKeys(obj, required) {
  if (!isPlainObject(obj)) fail('expected plain object');
  const keys = Reflect.ownKeys(obj);
  if (keys.length !== required.length || required.some((k) => !own(obj, k))) fail('schema keys');
  for (const k of keys) {
    const desc = Object.getOwnPropertyDescriptor(obj, k);
    if (!desc?.enumerable || !own(desc, 'value')) fail('non-data property');
  }
}

function checkNum(v, min, max, { integer = false } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail('number');
  if (integer && !Number.isSafeInteger(v)) fail('integer');
  return v;
}

function checkChoice(v, allowed) {
  if (!allowed.includes(v)) fail('enum');
  return v;
}

function round6(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0;
}

const bit = (v) => (v ? 1 : 0);

function sanitizeLogprobMap(obj, allowedTokens) {
  if (!isPlainObject(obj)) fail('top_logprobs_sym');
  const out = {};
  for (const k of Object.keys(obj)) {
    if (!allowedTokens.includes(k)) fail('disallowed logprob token');
    out[k] = round6(checkNum(obj[k], -100, 0));
  }
  return out;
}

function sanitizeDecisionRecord(r) {
  assertExactKeys(r, [
    'schema_version', 'kind', 'router_version', 'weights_version', 'turn_id', 'ts_ms',
    'mode', 'input_modality', 'route_path', 'fallback_reason',
    'pre', 'raw_router', 'action', 'timing',
  ]);
  if (r.schema_version !== SCHEMA_VERSION) fail('schema_version');
  if (r.kind !== 'decision') fail('kind');
  if (typeof r.router_version !== 'string' || !SAFE_TAG.test(r.router_version)) fail('router_version');
  if (typeof r.weights_version !== 'string' || !SAFE_TAG.test(r.weights_version)) fail('weights_version');
  if (typeof r.turn_id !== 'string' || !UUID_V4.test(r.turn_id)) fail('turn_id');
  checkNum(r.ts_ms, 0, MAX_DAY_TIME_MS, { integer: true });
  checkChoice(r.mode, MODES);
  checkChoice(r.input_modality, MODALITIES);
  checkChoice(r.route_path, ROUTE_PATHS);
  checkChoice(r.fallback_reason, FALLBACK_REASONS);

  const p = r.pre;
  assertExactKeys(p, [
    'len_bucket', 'short_trivial', 'has_context', 'urgency', 'contradiction',
    'risky_by_code', 'claims_by_code', 'secret_guard', 'pin_used', 'sticky_applied',
    'bar_step_up', 'risk_raised', 'claim_raised', 'open_only_guard', 'reference_tier',
    'brains_ready', 'is_auto', 'main_active', 'reassessment', 'evidence_need',
    'stability', 'circadian_quiet',
  ]);
  checkNum(p.len_bucket, 0, 3, { integer: true });
  for (const k of [
    'short_trivial', 'has_context', 'urgency', 'contradiction', 'risky_by_code',
    'claims_by_code', 'secret_guard', 'pin_used', 'sticky_applied', 'bar_step_up',
    'risk_raised', 'claim_raised', 'open_only_guard', 'brains_ready', 'is_auto',
    'main_active', 'circadian_quiet',
  ]) {
    checkChoice(p[k], [0, 1]);
  }
  checkNum(p.reference_tier, 1, 4, { integer: true });
  for (const k of ['reassessment', 'evidence_need', 'stability']) checkNum(p[k], 0, 1);

  const raw = r.raw_router;
  assertExactKeys(raw, [
    'target', 'tier', 'risk', 'self_claim', 'who_probs', 'tier_probs',
    'top_logprobs_sym', 'who_entropy', 'tier_entropy', 'tier_margin',
  ]);
  checkChoice(raw.target, TARGETS);
  checkChoice(raw.tier, TIERS);
  checkNum(raw.risk, 0, 1);
  checkNum(raw.self_claim, 0, 1);

  assertExactKeys(raw.who_probs, ['C', 'P', 'W']);
  for (const k of ['C', 'P', 'W']) checkNum(raw.who_probs[k], 0, 1);

  assertExactKeys(raw.tier_probs, TIERS);
  for (const k of TIERS) checkNum(raw.tier_probs[k], 0, 1);

  if (!Array.isArray(raw.top_logprobs_sym) || raw.top_logprobs_sym.length !== 2) fail('top_logprobs_sym length');
  const topLogprobs = [
    sanitizeLogprobMap(raw.top_logprobs_sym[0], ['C', 'P', 'W']),
    sanitizeLogprobMap(raw.top_logprobs_sym[1], ['1', '2', '3', '4']),
  ];
  checkNum(raw.who_entropy, 0, 5);
  checkNum(raw.tier_entropy, 0, 5);
  checkNum(raw.tier_margin, 0, 1);

  const act = r.action;
  assertExactKeys(act, [
    'model', 'worker_class', 'p_e4b', 'p_26b', 'propensity',
    'overlapping', 'stage6_override', 'explore_up', 'prediction',
  ]);
  checkChoice(act.model, MODELS);
  checkChoice(act.worker_class, WORKER_CLASSES);
  checkNum(act.p_e4b, 0, 1);
  checkNum(act.p_26b, 0, 1);
  checkNum(act.propensity, 1e-9, 1);
  checkChoice(act.overlapping, [0, 1]);
  checkChoice(act.stage6_override, [0, 1]);
  checkChoice(act.explore_up, [0, 1]);
  if (act.prediction !== null) checkNum(act.prediction, -1, 1);

  const tm = r.timing;
  assertExactKeys(tm, [
    'router_latency_ms', 'swap_latency_ms', 'generation_latency_ms',
    'cold_swap_26b', 'outcome',
  ]);
  checkNum(tm.router_latency_ms, 0, MAX_DAY_TIME_MS, { integer: true });
  checkNum(tm.swap_latency_ms, 0, MAX_DAY_TIME_MS, { integer: true });
  checkNum(tm.generation_latency_ms, 0, MAX_DAY_TIME_MS, { integer: true });
  checkChoice(tm.cold_swap_26b, [0, 1]);
  checkChoice(tm.outcome, OUTCOMES);

  return {
    schema_version: SCHEMA_VERSION,
    kind: 'decision',
    router_version: r.router_version,
    weights_version: r.weights_version,
    turn_id: r.turn_id,
    ts_ms: r.ts_ms,
    mode: r.mode,
    input_modality: r.input_modality,
    route_path: r.route_path,
    fallback_reason: r.fallback_reason,
    pre: { ...p },
    raw_router: {
      target: raw.target,
      tier: raw.tier,
      risk: round6(raw.risk),
      self_claim: round6(raw.self_claim),
      who_probs: { C: round6(raw.who_probs.C), P: round6(raw.who_probs.P), W: round6(raw.who_probs.W) },
      tier_probs: {
        mechanical: round6(raw.tier_probs.mechanical),
        routine: round6(raw.tier_probs.routine),
        complex: round6(raw.tier_probs.complex),
        deep: round6(raw.tier_probs.deep),
      },
      top_logprobs_sym: topLogprobs,
      who_entropy: round6(raw.who_entropy),
      tier_entropy: round6(raw.tier_entropy),
      tier_margin: round6(raw.tier_margin),
    },
    action: {
      model: act.model,
      worker_class: act.worker_class,
      p_e4b: round6(act.p_e4b),
      p_26b: round6(act.p_26b),
      propensity: round6(act.propensity),
      overlapping: act.overlapping,
      stage6_override: act.stage6_override,
      explore_up: act.explore_up,
      prediction: act.prediction === null ? null : round6(act.prediction),
    },
    timing: { ...tm },
  };
}

function sanitizeOutcomeRecord(r) {
  assertExactKeys(r, [
    'schema_version', 'kind', 'router_version', 'turn_id', 'ts_ms',
    'model', 'verdict', 'verdict_source', 'prediction', 'rpe', 'stage6_override',
  ]);
  if (r.schema_version !== SCHEMA_VERSION) fail('schema_version');
  if (r.kind !== 'outcome') fail('kind');
  if (typeof r.router_version !== 'string' || !SAFE_TAG.test(r.router_version)) fail('router_version');
  if (typeof r.turn_id !== 'string' || !UUID_V4.test(r.turn_id)) fail('turn_id');
  checkNum(r.ts_ms, 0, MAX_DAY_TIME_MS, { integer: true });
  checkChoice(r.model, ['e4b', '26b']);
  checkChoice(r.verdict, [1, -1]);
  checkChoice(r.verdict_source, VERDICT_SOURCES);
  if (r.prediction !== null) checkNum(r.prediction, -1, 1);
  if (r.rpe !== null) checkNum(r.rpe, -2, 2);
  checkChoice(r.stage6_override, [0, 1]);
  return {
    schema_version: SCHEMA_VERSION,
    kind: 'outcome',
    router_version: r.router_version,
    turn_id: r.turn_id,
    ts_ms: r.ts_ms,
    model: r.model,
    verdict: r.verdict,
    verdict_source: r.verdict_source,
    prediction: r.prediction === null ? null : round6(r.prediction),
    rpe: r.rpe === null ? null : round6(r.rpe),
    stage6_override: r.stage6_override,
  };
}

function sanitizeRouterRecord(raw) {
  if (!isPlainObject(raw)) fail('record must be plain object');
  const clean = raw.kind === 'outcome' ? sanitizeOutcomeRecord(raw) : sanitizeDecisionRecord(raw);
  const line = `${canonical(clean)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) fail('line too long');
  if (!PRINTABLE_ASCII_LINE.test(line)) fail('disallowed characters or whitespace');
  return { record: clean, line };
}

function buildDecisionRecord({
  turnId,
  tsMs,
  cfg = {},
  route = {},
  text = '',
  said,
  messages,
  voice = false,
  features = {},
  channels = null,
  model = 'e4b',
  workerClass = 'ordinary',
  stage6Override = 0,
  explicitMain = false,
  wantsFast = false,
  analysisActive = false,
  mainActive = false,
  brainsReady = false,
  isAuto = false,
  routerLatencyMs,
  swapLatencyMs = 0,
  generationLatencyMs = 0,
  coldSwap26b = false,
  outcome = 'completed',
  prediction,
  mode = 'off',
  weightsVersion = 'v0',
} = {}) {
  const userText = typeof said === 'string' ? said : String(text || '');
  const d = route?.router && typeof route.router === 'object' ? route.router : null;
  const routePath = ROUTE_PATHS.includes(route?.route_path)
    ? route.route_path
    : (d && ROUTE_PATHS.includes(d.route_path) ? d.route_path : 'router_keywords');
  const fallbackReason = FALLBACK_REASONS.includes(route?.fallback_reason)
    ? route.fallback_reason
    : (d && FALLBACK_REASONS.includes(d.fallback_reason) ? d.fallback_reason : 'prefix_guard');

  const whoProbs = d?.who_probs && isPlainObject(d.who_probs)
    ? { C: Number(d.who_probs.C) || 0, P: Number(d.who_probs.P) || 0, W: Number(d.who_probs.W) || 0 }
    : { C: 0, P: 0, W: 0 };
  const tierProbs = d?.tier_probs && isPlainObject(d.tier_probs)
    ? {
        mechanical: Number(d.tier_probs.mechanical) || 0,
        routine: Number(d.tier_probs.routine) || 0,
        complex: Number(d.tier_probs.complex) || 0,
        deep: Number(d.tier_probs.deep) || 0,
      }
    : { mechanical: 0, routine: 0, complex: 0, deep: 0 };
  const flags = d?.flags && isPlainObject(d.flags) ? d.flags : {};

  const { p_e4b, p_26b, propensity, overlapping } = computeBinaryPropensity({
    routePath,
    tierProbs,
    whoProbs,
    model,
    flags,
    stage6Override: bit(stage6Override),
    explicitMain: Boolean(explicitMain),
    wantsFast: Boolean(wantsFast),
    analysisActive: Boolean(analysisActive),
  });

  const nonSystemCount = Array.isArray(messages)
    ? messages.filter((m) => m && m.role !== 'system').length
    : 0;
  const hasContext = bit(nonSystemCount > 1);
  const targetVal = TARGETS.includes(d?.target) ? d.target : 'none';
  const tierVal = TIERS.includes(d?.tier) ? d.tier : (TIERS.includes(route?.tier) ? route.tier : 'routine');
  const riskVal = round6(Math.max(0, Math.min(1, Number(d?.risk) || 0)));

  let pred = null;
  if (prediction !== undefined) {
    pred = prediction === null ? null : round6(Math.max(-1, Math.min(1, Number(prediction) || 0)));
  } else if (model === 'e4b' || model === '26b') {
    pred = model === 'e4b' && routePath === 'router_model'
      ? round6(p_e4b)
      : round6(1 - Math.min(1, riskVal) * 0.5);
  }

  return {
    schema_version: SCHEMA_VERSION,
    kind: 'decision',
    router_version: typeof d?.router_version === 'string' ? d.router_version : (typeof route?.router_version === 'string' ? route.router_version : 'router-v1'),
    weights_version: SAFE_TAG.test(String(weightsVersion)) ? String(weightsVersion) : 'v0',
    turn_id: turnId,
    ts_ms: Math.max(0, Math.trunc(Number(tsMs) || 0)),
    mode: MODES.includes(mode) ? mode : 'off',
    input_modality: voice ? 'voice' : 'text',
    route_path: routePath,
    fallback_reason: fallbackReason,
    pre: {
      len_bucket: lenBucket(userText),
      short_trivial: bit(userText.trim().length < 12),
      has_context: hasContext,
      urgency: bit(features?.urgency === 1),
      contradiction: bit(features?.contradiction === 1),
      risky_by_code: bit(flags.risky_by_code),
      claims_by_code: bit(flags.claims_by_code),
      secret_guard: bit(flags.secret_guard),
      pin_used: bit(flags.pin_used),
      sticky_applied: bit(flags.sticky_applied),
      bar_step_up: bit(flags.bar_step_up),
      risk_raised: bit(flags.risk_raised),
      claim_raised: bit(flags.claim_raised),
      open_only_guard: bit(flags.open_only_guard),
      reference_tier: Number.isSafeInteger(flags.reference_tier) ? Math.max(1, Math.min(4, flags.reference_tier)) : 2,
      brains_ready: bit(brainsReady),
      is_auto: bit(isAuto),
      main_active: bit(mainActive),
      reassessment: round6(Math.max(0, Math.min(1, Number(channels?.reassessment) || 0))),
      evidence_need: round6(Math.max(0, Math.min(1, Number(channels?.evidence_need) || 0))),
      stability: round6(Math.max(0, Math.min(1, channels && Number.isFinite(channels.stability) ? channels.stability : 1))),
      circadian_quiet: bit(channels?.circadian_quiet === 1),
    },
    raw_router: {
      target: targetVal,
      tier: tierVal,
      risk: riskVal,
      self_claim: round6(Math.max(0, Math.min(1, Number(d?.self_claim) || 0))),
      who_probs: { C: round6(whoProbs.C), P: round6(whoProbs.P), W: round6(whoProbs.W) },
      tier_probs: {
        mechanical: round6(tierProbs.mechanical),
        routine: round6(tierProbs.routine),
        complex: round6(tierProbs.complex),
        deep: round6(tierProbs.deep),
      },
      top_logprobs_sym: Array.isArray(d?.top_logprobs_sym) && d.top_logprobs_sym.length === 2
        ? [d.top_logprobs_sym[0] || {}, d.top_logprobs_sym[1] || {}]
        : [{}, {}],
      who_entropy: round6(Math.max(0, Math.min(5, Number(d?.who_entropy) || 0))),
      tier_entropy: round6(Math.max(0, Math.min(5, Number(d?.tier_entropy) || 0))),
      tier_margin: round6(Math.max(0, Math.min(1, Number(d?.tier_margin) || 0))),
    },
    action: {
      model: MODELS.includes(model) ? model : 'e4b',
      worker_class: WORKER_CLASSES.includes(workerClass) ? workerClass : 'unknown',
      p_e4b,
      p_26b,
      propensity,
      overlapping,
      stage6_override: bit(stage6Override),
      explore_up: 0,
      prediction: pred,
    },
    timing: {
      router_latency_ms: Math.max(0, Math.trunc(Number(routerLatencyMs ?? route?.router_latency_ms ?? d?.router_latency_ms ?? 0) || 0)),
      swap_latency_ms: Math.max(0, Math.trunc(Number(swapLatencyMs) || 0)),
      generation_latency_ms: Math.max(0, Math.trunc(Number(generationLatencyMs) || 0)),
      cold_swap_26b: bit(coldSwap26b),
      outcome: OUTCOMES.includes(outcome) ? outcome : 'completed',
    },
  };
}

function rememberBounded(set, key, cap) {
  if (set.has(key)) return;
  set.add(key);
  if (set.size > cap) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

function createRouterJournal({
  dir,
  now = Date.now,
  uuid = crypto.randomUUID,
  isTorActive,
  isEnabled = () => true,
  contextMentionsTor,
  tor,
  maxSegmentBytes = DEFAULT_MAX_SEGMENT_BYTES,
  maxQueue = DEFAULT_QUEUE,
  fsApi = fsp,
} = {}) {
  const segLimit = Math.max(MIN_SEGMENT_BYTES, Number.isSafeInteger(maxSegmentBytes) ? maxSegmentBytes : DEFAULT_MAX_SEGMENT_BYTES);
  const queueLimit = Math.max(1, Number.isSafeInteger(maxQueue) ? maxQueue : DEFAULT_QUEUE);

  const counts = {
    decisions_written: 0,
    outcomes_written: 0,
    dropped_tor: 0,
    dropped_rp: 0,
    dropped_disabled: 0,
    dropped_duplicate: 0,
    dropped_queue: 0,
    validation_errors: 0,
    write_errors: 0,
    rotations: 0,
  };

  const seenDecisions = new Set();
  const seenOutcomes = new Set();
  const pendingLocalTurns = new Map();
  const nonLocalTurns = new Set();

  let writeChain = Promise.resolve();
  let pendingWrites = 0;
  let closed = false;
  let closing = null;
  let fh = null;
  let currentDay = null;
  let currentSeq = 0;
  let segmentSize = 0;
  let currentFile = null;

  function checkTor() {
    try { return Boolean(isTorActive?.()); } catch { return true; }
  }

  function hasTorContext(messages) {
    if (messages === undefined) return false;
    if (typeof contextMentionsTor === 'function' && tor) {
      try { return Boolean(contextMentionsTor(messages, tor)); } catch { return true; }
    }
    if (tor && typeof tor.wantsTor === 'function' && typeof tor.onionLink === 'function') {
      try {
        const { contextMentionsTor: screen } = require('./shadow-hook');
        return Boolean(screen(messages, tor));
      } catch {
        return true;
      }
    }
    return false;
  }

  function dropPending() {
    pendingLocalTurns.clear();
  }

  function torTouched() {
    dropPending();
  }

  async function closeHandle() {
    if (!fh) return;
    const handle = fh;
    fh = null;
    try { await handle.close(); } catch {}
  }

  async function ensureSegmentFor(day, lineBytes) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) fail('absolute dir required');
    const needRotate = !fh || currentDay !== day || segmentSize + lineBytes > segLimit;
    if (!needRotate) return;

    const wasOpen = Boolean(fh);
    await closeHandle();
    await fsApi.mkdir(dir, { recursive: true });

    let nextSeq = 1;
    let openExisting = false;
    let existingSize = 0;

    if (!wasOpen) {
      const entries = await fsApi.readdir(dir, { withFileTypes: true }).catch(() => []);
      const daySegs = [];
      for (const entry of entries) {
        if (!entry?.isFile?.()) continue;
        const m = SEGMENT_RE.exec(entry.name);
        if (!m || m[1] !== day) continue;
        const seq = Number(m[2]);
        if (seq >= 1) daySegs.push({ name: entry.name, file: path.join(dir, entry.name), seq });
      }
      daySegs.sort((a, b) => a.seq - b.seq);
      const last = daySegs.at(-1);
      if (last) {
        const st = await fsApi.stat(last.file);
        if (st.size + lineBytes <= segLimit) {
          nextSeq = last.seq;
          existingSize = st.size;
          openExisting = true;
        } else {
          nextSeq = last.seq + 1;
        }
      }
    } else if (currentDay === day) {
      nextSeq = currentSeq + 1;
      counts.rotations++;
    } else {
      const entries = await fsApi.readdir(dir, { withFileTypes: true }).catch(() => []);
      let maxSeq = 0;
      for (const entry of entries) {
        if (!entry?.isFile?.()) continue;
        const m = SEGMENT_RE.exec(entry.name);
        if (m && m[1] === day) maxSeq = Math.max(maxSeq, Number(m[2]));
      }
      nextSeq = maxSeq + 1;
      counts.rotations++;
    }

    const file = path.join(dir, `${day}-${String(nextSeq).padStart(4, '0')}.ndjson`);
    const nextFh = await fsApi.open(file, openExisting ? 'a' : 'wx');
    fh = nextFh;
    currentDay = day;
    currentSeq = nextSeq;
    currentFile = file;
    segmentSize = existingSize;
  }

  function enqueueLine(clean, line) {
    if (closed) return { status: 'closed' };
    if (pendingWrites >= queueLimit) {
      counts.dropped_queue++;
      return { status: 'dropped_queue' };
    }
    const lineBytes = Buffer.byteLength(line, 'utf8');
    const day = utc5DayKey(clean.ts_ms);
    pendingWrites++;
    writeChain = writeChain.then(async () => {
      if (closed) return;
      try {
        await ensureSegmentFor(day, lineBytes);
        await fh.appendFile(line, 'utf8');
        segmentSize += lineBytes;
        if (clean.kind === 'decision') counts.decisions_written++;
        else counts.outcomes_written++;
      } catch {
        counts.write_errors++;
        await closeHandle();
      }
    }).catch(() => {
      counts.write_errors++;
    }).finally(() => {
      pendingWrites--;
    });
    return { status: 'queued', turnId: clean.turn_id };
  }

  function recordDecision(rawRecord, { torActive = false, rp = false, messages } = {}) {
    try {
      if (closed) return { status: 'closed' };
      if (!isEnabled()) {
        counts.dropped_disabled++;
        return { status: 'disabled' };
      }
      if (torActive || checkTor() || hasTorContext(messages)) {
        dropPending();
        counts.dropped_tor++;
        return { status: 'skipped_tor' };
      }
      if (rp) {
        counts.dropped_rp++;
        return { status: 'skipped_rp' };
      }
      let sanitized;
      try {
        sanitized = sanitizeRouterRecord(rawRecord);
      } catch {
        counts.validation_errors++;
        return { status: 'invalid' };
      }
      const { record, line } = sanitized;
      if (record.kind !== 'decision') {
        counts.validation_errors++;
        return { status: 'invalid' };
      }
      if (seenDecisions.has(record.turn_id)) {
        counts.dropped_duplicate++;
        return { status: 'duplicate' };
      }
      rememberBounded(seenDecisions, record.turn_id, MAX_SEEN_DECISIONS);

      if (record.action.worker_class === 'ordinary' && (record.action.model === 'e4b' || record.action.model === '26b')) {
        if (pendingLocalTurns.size >= MAX_PENDING_LOCAL_TURNS) {
          const oldestKey = pendingLocalTurns.keys().next().value;
          if (oldestKey !== undefined) pendingLocalTurns.delete(oldestKey);
        }
        pendingLocalTurns.set(record.turn_id, {
          router_version: record.router_version,
          model: record.action.model,
          prediction: record.action.prediction,
          stage6_override: record.action.stage6_override,
        });
      } else {
        rememberBounded(nonLocalTurns, record.turn_id, MAX_NON_LOCAL_TURNS);
      }
      return enqueueLine(record, line);
    } catch {
      counts.validation_errors++;
      return { status: 'error' };
    }
  }

  function recordTurn(input = {}) {
    try {
      if (closed) return { status: 'closed' };
      if (!isEnabled()) {
        counts.dropped_disabled++;
        return { status: 'disabled' };
      }
      const rpFlag = Boolean(input.rp ?? (input.cfg?.rp === true));
      if (input.tor || checkTor() || hasTorContext(input.messages)) {
        dropPending();
        counts.dropped_tor++;
        return { status: 'skipped_tor' };
      }
      if (rpFlag) {
        counts.dropped_rp++;
        return { status: 'skipped_rp' };
      }
      const turnId = typeof input.turnId === 'string' && UUID_V4.test(input.turnId) ? input.turnId : uuid();
      const tsMs = input.tsMs !== undefined ? input.tsMs : now();
      const record = buildDecisionRecord({ ...input, turnId, tsMs });
      return recordDecision(record, { torActive: false, rp: false });
    } catch {
      counts.validation_errors++;
      return { status: 'error' };
    }
  }

  function recordOutcome({
    turnId,
    verdict,
    verdictSource = 'none',
    tsMs,
    model,
    prediction,
    stage6Override,
    routerVersion,
  } = {}) {
    try {
      if (closed) return { status: 'closed' };
      if (!isEnabled()) {
        counts.dropped_disabled++;
        return { status: 'disabled' };
      }
      if (checkTor()) {
        dropPending();
        counts.dropped_tor++;
        return { status: 'skipped_tor' };
      }
      if (typeof turnId !== 'string' || !UUID_V4.test(turnId)) return { status: 'skipped_no_turn' };
      if (nonLocalTurns.has(turnId)) {
        pendingLocalTurns.delete(turnId);
        return { status: 'skipped_non_local' };
      }
      const tracked = pendingLocalTurns.get(turnId);
      pendingLocalTurns.delete(turnId);
      if (verdict !== 1 && verdict !== -1) return { status: 'unverified' };
      if (!tracked && model !== 'e4b' && model !== '26b') return { status: 'skipped_non_local' };

      if (seenOutcomes.has(turnId)) {
        counts.dropped_duplicate++;
        return { status: 'duplicate' };
      }
      rememberBounded(seenOutcomes, turnId, MAX_SEEN_DECISIONS);

      const usedModel = tracked ? tracked.model : model;
      const usedPrediction = tracked ? tracked.prediction : (prediction ?? null);
      const rpe = usedPrediction === null ? null : round6(verdict - usedPrediction);
      const raw = {
        schema_version: SCHEMA_VERSION,
        kind: 'outcome',
        router_version: tracked?.router_version || routerVersion || 'router-v1',
        turn_id: turnId,
        ts_ms: Math.max(0, Math.trunc(Number(tsMs !== undefined ? tsMs : now()) || 0)),
        model: usedModel,
        verdict,
        verdict_source: VERDICT_SOURCES.includes(verdictSource) ? verdictSource : 'none',
        prediction: usedPrediction === null ? null : round6(usedPrediction),
        rpe,
        stage6_override: bit(tracked ? tracked.stage6_override : stage6Override),
      };
      let sanitized;
      try {
        sanitized = sanitizeRouterRecord(raw);
      } catch {
        counts.validation_errors++;
        return { status: 'invalid' };
      }
      return enqueueLine(sanitized.record, sanitized.line);
    } catch {
      counts.validation_errors++;
      return { status: 'error' };
    }
  }

  function onVerdict(meta, verdict, info) {
    if (!meta || typeof meta !== 'object') return { status: 'skipped_no_meta' };
    return recordOutcome({
      turnId: meta.turnId,
      verdict,
      verdictSource: info?.source || 'none',
      model: meta.model,
      prediction: meta.prediction,
      stage6Override: meta.escalated ? 1 : 0,
    });
  }

  async function flush() {
    try { await writeChain; } catch {}
  }

  function close() {
    if (closing) return closing;
    closing = (async () => {
      pendingLocalTurns.clear();
      await flush();
      closed = true;
      await closeHandle();
    })();
    return closing;
  }

  return Object.freeze({
    recordDecision,
    recordTurn,
    recordOutcome,
    onVerdict,
    torTouched,
    dropPending,
    flush,
    close,
    stats: () => ({
      ...counts,
      pending_writes: pendingWrites,
      tracked_turns: pendingLocalTurns.size,
      segment_size: segmentSize,
      closed,
    }),
    getCurrentFile: () => currentFile,
  });
}

module.exports = {
  SCHEMA_VERSION,
  MODELS,
  WORKER_CLASSES,
  MODES,
  MODALITIES,
  TARGETS,
  TIERS,
  OUTCOMES,
  VERDICT_SOURCES,
  MAX_LINE_BYTES,
  DEFAULT_MAX_SEGMENT_BYTES,
  DEFAULT_QUEUE,
  sanitizeDecisionRecord,
  sanitizeOutcomeRecord,
  sanitizeRouterRecord,
  buildDecisionRecord,
  createRouterJournal,
};
