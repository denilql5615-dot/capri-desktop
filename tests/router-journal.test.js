'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const {
  Router,
  ROUTER_VERSION,
  ROUTE_PATHS,
  FALLBACK_REASONS,
  lenBucket,
  computeBinaryPropensity,
} = require('../src/main/router');
const {
  createRouterJournal,
  sanitizeRouterRecord,
  MAX_LINE_BYTES,
} = require('../src/main/brain/router-journal');
const { createShadowHook } = require('../src/main/brain/shadow-hook');
const { createChatGlue } = require('../src/main/brain/chat-glue');
const { createTorState } = require('../src/main/tor-guard');
const { salience } = require('../src/main/brain/amygdala');
const tor = require('../src/main/tor');

const mkDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'router-j-')), 'router-journal', 'v1');

function makeUuid(prefix = 1000) {
  let n = prefix;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

const tok = (dist) => {
  const [best] = Object.entries(dist).sort((a, b) => b[1] - a[1]);
  return {
    token: best[0],
    logprob: Math.log(best[1]),
    top_logprobs: Object.entries(dist).map(([token, p]) => ({ token, logprob: Math.log(p) })),
  };
};

const reply = (who, tiers, risk = '0', claim = '0') => {
  const logprobs = [tok(typeof who === 'string' ? { [who]: 1 } : who), tok(tiers), tok({ [risk]: 1 }), tok({ [claim]: 1 })];
  return { content: logprobs.map((e) => e.token).join(''), logprobs };
};

function readAllNdjsonLines(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort();
  const rows = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) rows.push({ file: f, raw: line, json: JSON.parse(line) });
  }
  return rows;
}

function loadConfigDefaults() {
  const configPath = require.resolve('../src/main/config');
  const origLoad = Module._load;
  delete require.cache[configPath];
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => os.tmpdir() } };
    }
    return origLoad.apply(this, arguments);
  };
  try {
    return require('../src/main/config').DEFAULTS;
  } finally {
    Module._load = origLoad;
    delete require.cache[configPath];
  }
}

test('config default keeps routerJournal off and disabled journal writes nothing on disk', async () => {
  const defaults = loadConfigDefaults();
  assert.equal(defaults.routerJournal, 'off');

  const dir = mkDir();
  let cfg = { routerJournal: 'off', rp: false };
  const journal = createRouterJournal({
    dir,
    now: () => Date.UTC(2026, 10, 18, 12, 0, 0),
    uuid: makeUuid(100),
    isEnabled: () => cfg.routerJournal === 'on',
    tor,
  });

  try {
    const res = journal.recordTurn({
      cfg,
      said: 'обычный вопрос на русском без сохранения',
      messages: [{ role: 'user', content: 'обычный вопрос на русском без сохранения' }],
      model: 'e4b',
      workerClass: 'ordinary',
    });
    assert.equal(res.status, 'disabled');
    await journal.flush();
    assert.equal(fs.existsSync(dir), false);
    assert.equal(journal.stats().decisions_written, 0);
    assert.equal(journal.stats().dropped_disabled, 1);
  } finally {
    await journal.close();
  }
});

test('router.js exports probabilities, entropies, margin, route_path, fallback_reason and flags without altering target/tier', async () => {
  let clock = 100;
  const r = new Router({
    now: () => clock,
    chat: async () => {
      clock += 42;
      return reply({ C: 0.8, W: 0.15, P: 0.05 }, { 1: 0.1, 2: 0.7, 3: 0.15, 4: 0.05 });
    },
  });

  const d = await r.decide('объясни подробно как устроен кэш процессора', { model: 'gemma-fast' });
  assert.equal(d.target, 'capri');
  assert.equal(d.tier, 'routine');
  assert.equal(d.by, 'model');
  assert.equal(d.router_version, ROUTER_VERSION);
  assert.equal(d.route_path, 'router_model');
  assert.equal(d.fallback_reason, 'none');
  assert.equal(d.router_latency_ms, 42);
  assert.ok(ROUTE_PATHS.includes(d.route_path));
  assert.ok(FALLBACK_REASONS.includes(d.fallback_reason));
  assert.ok(Math.abs(d.who_probs.C - 0.8) < 1e-6);
  assert.ok(Math.abs(d.tier_probs.routine - 0.7) < 1e-6);
  assert.ok(Math.abs(d.tier_margin - 0.55) < 1e-6);
  assert.ok(d.who_entropy > 0 && d.tier_entropy > 0);
  assert.deepEqual(Object.keys(d.top_logprobs_sym[0]).sort(), ['C', 'P', 'W']);
  assert.deepEqual(Object.keys(d.top_logprobs_sym[1]).sort(), ['1', '2', '3', '4']);
  assert.equal(d.flags.pin_used, 0);
  assert.equal(d.flags.bar_step_up, 0);

  // Prefix/bar/pin/fallback_reason checks
  const pinDec = await r.decide('#fast сделай сложный разбор', { model: 'gemma-fast' });
  assert.equal(pinDec.tier, 'mechanical');
  assert.equal(pinDec.flags.pin_used, 1);
  assert.equal(pinDec.fallback_reason, 'prefix_guard');

  const noModelDec = await r.decide('разбери баг в коде', {});
  assert.equal(noModelDec.route_path, 'router_keywords');
  assert.equal(noModelDec.fallback_reason, 'prefix_guard');
  assert.equal(noModelDec.target, null);
  assert.equal(noModelDec.tier, 'complex');

  const slowRouter = new Router({
    timeoutMs: 15,
    chat: (_m, _msgs, sig) => new Promise((_, reject) => sig.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  const warnOrig = console.warn;
  console.warn = () => {};
  try {
    const timedOut = await slowRouter.decide('напиши письмо про проект', { model: 'q' });
    assert.equal(timedOut.route_path, 'router_keywords');
    assert.equal(timedOut.fallback_reason, 'timeout');

    const badRouter = new Router({ chat: async () => ({ content: 'невалид' }) });
    const badDec = await badRouter.decide('напиши письмо другу', { model: 'q' });
    assert.equal(badDec.route_path, 'router_keywords');
    assert.equal(badDec.fallback_reason, 'parse_fail');
  } finally {
    console.warn = warnOrig;
  }

  // Binary propensity helper & len_bucket
  assert.equal(lenBucket('а'), 0);
  assert.equal(lenBucket('длинный вопрос на двадцать символов'), 1);
  assert.equal(lenBucket('x'.repeat(250)), 2);
  assert.equal(lenBucket('x'.repeat(1200)), 3);

  const prop = computeBinaryPropensity({
    routePath: 'router_model',
    tierProbs: { mechanical: 0.1, routine: 0.7, complex: 0.15, deep: 0.05 },
    whoProbs: { C: 0.8, P: 0.05, W: 0.15 },
    model: 'e4b',
  });
  assert.equal(prop.p_e4b, 0.8);
  assert.equal(prop.p_26b, 0.2);
  assert.equal(prop.propensity, 0.8);
  assert.equal(prop.overlapping, 1);

  const propPinned = computeBinaryPropensity({
    routePath: 'router_model',
    tierProbs: { mechanical: 0.1, routine: 0.7, complex: 0.15, deep: 0.05 },
    model: 'e4b',
    flags: { pin_used: 1 },
  });
  assert.equal(propPinned.propensity, 1);
  assert.equal(propPinned.overlapping, 0);
});

test('NDJSON file contains strictly numbers/enums/UUID: no Cyrillic, no spaces, no message text, no paths, no model names, no task_id', async () => {
  const dir = mkDir();
  const baseMs = Date.UTC(2026, 10, 18, 13, 0, 0);
  const router = new Router({
    now: () => 50,
    chat: async () => reply({ C: 0.75, W: 0.2, P: 0.05 }, { 1: 0.1, 2: 0.6, 3: 0.25, 4: 0.05 }),
  });

  const secretUserWords = 'СЕКРЕТНОЕ_СЛОВО_КИРИЛЛИЦА C:\\Users\\Danyal\\secret.txt hf.co/llmfan46/gemma-4-E4B';
  const d = await router.decide(secretUserWords, { model: 'hf.co/llmfan46/gemma-4-E4B-it-uncensored-heretic-GGUF:Q4_K_M' });

  const journal = createRouterJournal({
    dir,
    now: () => baseMs,
    uuid: makeUuid(200),
    tor,
  });

  try {
    const turnId = '00000000-0000-4000-8000-000000000201';
    journal.recordTurn({
      turnId,
      tsMs: baseMs,
      cfg: { rp: false },
      route: { worker: null, tier: d.tier, route_path: d.route_path, fallback_reason: d.fallback_reason, router_latency_ms: d.router_latency_ms, router_version: d.router_version, router: d },
      said: secretUserWords,
      messages: [
        { role: 'user', content: 'предыдущий контекст' },
        { role: 'assistant', content: 'ответ' },
        { role: 'user', content: secretUserWords },
      ],
      voice: true,
      model: '26b',
      workerClass: 'ordinary',
      stage6Override: 1,
      swapLatencyMs: 2400,
      generationLatencyMs: 1800,
      coldSwap26b: true,
      outcome: 'completed',
    });
    journal.recordOutcome({
      turnId,
      verdict: 1,
      verdictSource: 'button',
      tsMs: baseMs + 4000,
    });
    await journal.flush();

    const rows = readAllNdjsonLines(dir);
    assert.equal(rows.length, 2);

    for (const row of rows) {
      assert.ok(Buffer.byteLength(row.raw, 'utf8') <= MAX_LINE_BYTES);
      assert.ok(row.raw.length <= 2048);
      assert.equal(/[а-яёА-ЯЁ]/.test(row.raw), false, 'no Cyrillic allowed on disk');
      assert.equal(row.raw.includes(' '), false, 'no spaces allowed on disk');
      assert.equal(row.raw.includes('task_id'), false, 'task_id must not exist in Stage 7a');
      assert.equal(row.raw.includes('text_len'), false, 'text_len must not exist in Stage 7a');
      assert.equal(row.raw.includes('СЕКРЕТНОЕ'), false);
      assert.equal(row.raw.includes('Danyal'), false);
      assert.equal(row.raw.includes('llmfan46'), false);
      assert.equal(row.raw.includes('gemma'), false);
    }

    const dec = rows[0].json;
    assert.equal(dec.kind, 'decision');
    assert.equal(dec.input_modality, 'voice');
    assert.equal(dec.pre.len_bucket, 1);
    assert.equal(dec.pre.has_context, 1);
    assert.equal(dec.action.model, '26b');
    assert.equal(dec.action.stage6_override, 1);
    assert.equal(dec.action.overlapping, 0); // stage6_override forces deterministic propensity=1, overlapping=0
    assert.equal(dec.action.propensity, 1);
    assert.equal(dec.timing.cold_swap_26b, 1);
    assert.equal(dec.timing.swap_latency_ms, 2400);
    assert.equal(dec.timing.generation_latency_ms, 1800);

    const out = rows[1].json;
    assert.equal(out.kind, 'outcome');
    assert.equal(out.turn_id, turnId);
    assert.equal(out.model, '26b');
    assert.equal(out.verdict, 1);
    assert.equal(out.verdict_source, 'button');
    assert.equal(typeof out.rpe, 'number');

    // Sanitizer rejects any injected raw text / space / disallowed key
    assert.throws(() => sanitizeRouterRecord({ ...dec, text: 'leaked' }));
    assert.throws(() => sanitizeRouterRecord({ ...dec, task_id: turnId }));
    assert.throws(() => sanitizeRouterRecord({ ...dec, action: { ...dec.action, model: 'gemma-4-26b' } }));
  } finally {
    await journal.close();
  }
});

test('Tor and RP isolation: 0 bytes written and mid-turn Tor drops pending outcome', async () => {
  const dir = mkDir();
  let clock = Date.UTC(2026, 10, 18, 14, 0, 0);
  const torState = createTorState({ now: () => clock });
  const routerJournal = createRouterJournal({
    dir,
    now: () => clock,
    uuid: makeUuid(300),
    isTorActive: () => torState.isQuarantined(),
    tor,
  });

  try {
    // 1. Tor keyword or .onion link in context -> skipped
    for (const msg of [
      'найди в даркнете форум',
      'открой http://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion',
      'проверь это через тор',
    ]) {
      const r = routerJournal.recordTurn({
        cfg: { rp: false },
        said: msg,
        messages: [{ role: 'user', content: msg }],
        model: 'e4b',
      });
      assert.equal(r.status, 'skipped_tor');
    }

    // 2. RP turn -> skipped
    const rpRes = routerJournal.recordTurn({
      cfg: { rp: true },
      said: 'опиши сцену',
      messages: [{ role: 'user', content: 'опиши сцену' }],
      model: '26b',
    });
    assert.equal(rpRes.status, 'skipped_rp');

    // 3. Quarantine active -> skipped
    torState.touch({ inChat: true });
    const qRes = routerJournal.recordTurn({
      cfg: { rp: false },
      said: 'обычный вопрос после тора',
      messages: [{ role: 'user', content: 'обычный вопрос после тора' }],
      model: 'e4b',
    });
    assert.equal(qRes.status, 'skipped_tor');

    await routerJournal.flush();
    assert.equal(readAllNdjsonLines(dir).length, 0);

    // 4. Clean turn written, then Tor activates mid-flight BEFORE verdict -> outcome is dropped
    torState.resetChat();
    clock += 11 * 60 * 1000;
    const turnId = '00000000-0000-4000-8000-000000000399';
    const clean = routerJournal.recordTurn({
      turnId,
      tsMs: clock,
      cfg: { rp: false },
      said: 'нормальный вопрос про погоду',
      messages: [{ role: 'user', content: 'нормальный вопрос про погоду' }],
      model: 'e4b',
      workerClass: 'ordinary',
    });
    assert.equal(clean.status, 'queued');

    torState.touch({ inChat: true });
    routerJournal.torTouched();
    const outRes = routerJournal.onVerdict({ turnId, model: 'e4b' }, 1, { source: 'button' });
    assert.equal(outRes.status, 'skipped_tor');
    await routerJournal.flush();

    const rows = readAllNdjsonLines(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].json.kind, 'decision');
  } finally {
    await routerJournal.close();
  }
});

test('double routeOf call (chat:route + chat:send cache hit) produces 1 model call and 1 router-journal record', async () => {
  const dir = mkDir();
  let modelCalls = 0;
  let clock = Date.UTC(2026, 10, 18, 15, 0, 0);
  const router = new Router({
    now: () => clock,
    chat: async () => {
      modelCalls++;
      return reply('C', { 1: 0.2, 2: 0.7, 3: 0.1, 4: 0 });
    },
  });
  const journal = createRouterJournal({
    dir,
    now: () => clock,
    uuid: makeUuid(400),
    tor,
  });

  try {
    const text = 'подскажи рецепт простого супа';
    // Simulate IPC chat:route -> does not record
    const route1 = await router.decide(text, { model: 'fast' });
    // Simulate IPC chat:send -> hits router cache -> records once by turnId
    const route2 = await router.decide(text, { model: 'fast' });
    assert.equal(modelCalls, 1);
    assert.strictEqual(route1, route2);

    const turnId = '00000000-0000-4000-8000-000000000401';
    const first = journal.recordTurn({
      turnId,
      tsMs: clock,
      cfg: { rp: false },
      route: { worker: null, tier: route2.tier, route_path: route2.route_path, fallback_reason: route2.fallback_reason, router: route2 },
      said: text,
      messages: [{ role: 'user', content: text }],
      model: 'e4b',
      workerClass: 'ordinary',
    });
    // Defensive duplicate call with same turnId must not write twice
    const dup = journal.recordTurn({
      turnId,
      tsMs: clock,
      cfg: { rp: false },
      route: { worker: null, tier: route2.tier, route_path: route2.route_path, fallback_reason: route2.fallback_reason, router: route2 },
      said: text,
      messages: [{ role: 'user', content: text }],
      model: 'e4b',
      workerClass: 'ordinary',
    });
    assert.equal(first.status, 'queued');
    assert.equal(dup.status, 'duplicate');
    await journal.flush();

    const rows = readAllNdjsonLines(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].json.turn_id, turnId);
  } finally {
    await journal.close();
  }
});

test('onVerdict appends outcome by turn_id only for ordinary local turns, ignores unverified and worker turns', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-verdict-'));
  const brainDir = path.join(root, 'brain-journal', 'v3');
  const routerDir = path.join(root, 'router-journal', 'v1');
  let clock = Date.UTC(2026, 10, 18, 16, 0, 0);

  const routerJournal = createRouterJournal({
    dir: routerDir,
    now: () => (clock += 1000),
    uuid: makeUuid(500),
    tor,
  });
  const hook = createShadowHook({
    dir: brainDir,
    now: () => (clock += 1000),
    uuid: makeUuid(600),
    onVerdict: (meta, verdict, info) => routerJournal.onVerdict(meta, verdict, info),
  });
  const glue = createChatGlue({
    getHook: () => hook,
    tor,
    salience,
    isLocalModel: () => true,
  });
  const cfg = { brainShadow: true, provider: 'ollama', rp: false };

  try {
    // 1. Ordinary local turn -> button verdict +1 -> outcome record written with rpe = 1 - prediction
    const turnId1 = '00000000-0000-4000-8000-000000000501';
    const st1 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'простой вопрос' }], cfg, new AbortController().signal, {
      meta: { escalated: false, turnId: turnId1 },
    });
    routerJournal.recordTurn({
      turnId: turnId1,
      tsMs: clock,
      cfg,
      route: {
        worker: null,
        tier: 'routine',
        route_path: 'router_model',
        fallback_reason: 'none',
        router: {
          route_path: 'router_model',
          fallback_reason: 'none',
          target: 'capri',
          tier: 'routine',
          who_probs: { C: 0.9, P: 0.05, W: 0.05 },
          tier_probs: { mechanical: 0.1, routine: 0.7, complex: 0.15, deep: 0.05 },
        },
      },
      said: 'простой вопрос',
      messages: [{ role: 'user', content: 'простой вопрос' }],
      model: 'e4b',
      workerClass: 'ordinary',
      prediction: 0.8,
    });
    glue.afterSuccess(st1, { escalated: false, turnId: turnId1, model: 'e4b' });
    assert.equal(hook.verdict(1), true);

    // 2. Ordinary local turn -> dict verdict -1 on next message -> outcome record written
    const turnId2 = '00000000-0000-4000-8000-000000000502';
    const st2 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'второй вопрос' }], cfg, new AbortController().signal, {
      meta: { escalated: true, turnId: turnId2 },
    });
    routerJournal.recordTurn({
      turnId: turnId2,
      tsMs: clock,
      cfg,
      said: 'второй вопрос',
      messages: [{ role: 'user', content: 'второй вопрос' }],
      model: '26b',
      workerClass: 'ordinary',
      stage6Override: 1,
      prediction: 0.9,
    });
    glue.afterSuccess(st2, { escalated: true, turnId: turnId2, model: '26b' });
    glue.beforeTurn([{ role: 'user', content: 'нет, неверно' }], cfg);

    // 3. Ordinary local turn -> unverified (0) -> NO outcome written
    const turnId3 = '00000000-0000-4000-8000-000000000503';
    const st3 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'третий вопрос' }], cfg, new AbortController().signal, {
      meta: { escalated: false, turnId: turnId3 },
    });
    routerJournal.recordTurn({
      turnId: turnId3,
      tsMs: clock,
      cfg,
      said: 'третий вопрос',
      messages: [{ role: 'user', content: 'третий вопрос' }],
      model: 'e4b',
      workerClass: 'ordinary',
    });
    glue.afterSuccess(st3, { escalated: false, turnId: turnId3, model: 'e4b' });
    glue.beforeTurn([{ role: 'user', content: 'а теперь давай дальше' }], cfg);

    // 4. Worker turn -> decision only; even direct recordOutcome is refused
    const turnId4 = '00000000-0000-4000-8000-000000000504';
    routerJournal.recordTurn({
      turnId: turnId4,
      tsMs: clock,
      cfg,
      route: { worker: 'claude', tier: 'complex', route_path: 'pre_named', fallback_reason: 'prefix_guard' },
      said: 'Клод, проверь сборку',
      messages: [{ role: 'user', content: 'Клод, проверь сборку' }],
      model: 'worker',
      workerClass: 'unknown',
    });
    const skippedWorker = routerJournal.recordOutcome({ turnId: turnId4, verdict: 1, verdictSource: 'button' });
    assert.equal(skippedWorker.status, 'skipped_non_local');

    await hook.flush();
    await routerJournal.flush();

    const rows = readAllNdjsonLines(routerDir);
    const decisions = rows.filter((r) => r.json.kind === 'decision');
    const outcomes = rows.filter((r) => r.json.kind === 'outcome');
    assert.equal(decisions.length, 4);
    assert.equal(outcomes.length, 2);

    assert.equal(outcomes[0].json.turn_id, turnId1);
    assert.equal(outcomes[0].json.verdict, 1);
    assert.equal(outcomes[0].json.verdict_source, 'button');
    assert.ok(Math.abs(outcomes[0].json.rpe - 0.2) < 1e-6);

    assert.equal(outcomes[1].json.turn_id, turnId2);
    assert.equal(outcomes[1].json.verdict, -1);
    assert.equal(outcomes[1].json.verdict_source, 'dict');
    assert.equal(outcomes[1].json.stage6_override, 1);
    assert.ok(Math.abs(outcomes[1].json.rpe - (-1.9)) < 1e-6);
  } finally {
    await hook.close();
    await routerJournal.close();
  }
});

test('rotation across size limit and UTC+5 day rollover, plus disk failure resilience without throwing', async () => {
  const dir = mkDir();
  let clock = Date.UTC(2026, 10, 18, 18, 59, 0); // 23:59 UTC+5 on 2026-11-18
  const j = createRouterJournal({
    dir,
    now: () => clock,
    maxSegmentBytes: 2048,
    tor,
  });

  try {
    j.recordTurn({ turnId: '00000000-0000-4000-8000-000000000701', tsMs: clock, said: 'первый', model: 'e4b' });
    j.recordTurn({ turnId: '00000000-0000-4000-8000-000000000702', tsMs: clock, said: 'второй', model: 'e4b' });
    // Roll into 2026-11-19 UTC+5 (19:01 UTC = 00:01 UTC+5 next day)
    clock += 2 * 60 * 1000;
    j.recordTurn({ turnId: '00000000-0000-4000-8000-000000000703', tsMs: clock, said: 'третий', model: '26b' });
    await j.flush();

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort();
    assert.deepEqual(files, [
      '2026-11-18-0001.ndjson',
      '2026-11-18-0002.ndjson',
      '2026-11-19-0001.ndjson',
    ]);
    assert.equal(j.stats().decisions_written, 3);
    assert.equal(j.stats().rotations, 2);
  } finally {
    await j.close();
  }

  // Disk failure: dir points to an existing regular file -> mkdir throws ENOTDIR/EEXIST -> never throws/rejects
  const blockingFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rj-fail-')), 'not-a-dir');
  fs.writeFileSync(blockingFile, 'x');
  const broken = createRouterJournal({ dir: blockingFile, tor });
  try {
    assert.doesNotThrow(() => {
      broken.recordTurn({
        turnId: '00000000-0000-4000-8000-000000000801',
        tsMs: clock,
        said: 'вопрос при отказе диска',
        model: 'e4b',
      });
    });
    await broken.flush();
    assert.equal(broken.stats().write_errors, 1);
    assert.equal(broken.stats().decisions_written, 0);
  } finally {
    await broken.close();
  }

  // Queue limit: bounded async queue drops excess writes safely without throwing
  const qDir = mkDir();
  let releaseWrite;
  const blocker = new Promise((resolve) => { releaseWrite = resolve; });
  const slowFs = {
    mkdir: () => blocker,
    readdir: async () => [],
    stat: async () => ({ size: 0 }),
    open: async () => ({ appendFile: async () => {}, close: async () => {} }),
  };
  const qJournal = createRouterJournal({ dir: qDir, maxQueue: 2, fsApi: slowFs, tor });
  try {
    const r1 = qJournal.recordTurn({ turnId: '00000000-0000-4000-8000-000000000901', tsMs: clock, said: 'раз', model: 'e4b' });
    const r2 = qJournal.recordTurn({ turnId: '00000000-0000-4000-8000-000000000902', tsMs: clock, said: 'два', model: 'e4b' });
    const r3 = qJournal.recordTurn({ turnId: '00000000-0000-4000-8000-000000000903', tsMs: clock, said: 'три', model: 'e4b' });
    assert.equal(r1.status, 'queued');
    assert.equal(r2.status, 'queued');
    assert.equal(r3.status, 'dropped_queue');
    assert.equal(qJournal.stats().dropped_queue, 1);
  } finally {
    releaseWrite();
    await qJournal.close();
  }
});
