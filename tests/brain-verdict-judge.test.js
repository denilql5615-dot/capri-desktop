'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Brains, FAST, MAIN } = require('../src/main/brains');
const {
  SYSTEM_PROMPT,
  VERDICT_SCHEMA,
  parseJudgeReply,
  messagesForJudge,
  selectLoadedJudgeModel,
  createLoadedModelSelector,
  createVerdictJudge,
} = require('../src/main/brain/verdict-judge');
const { createShadowHook } = require('../src/main/brain/shadow-hook');
const { createChatGlue } = require('../src/main/brain/chat-glue');
const tor = require('../src/main/tor');
const { runJudgeEval, loadJudgeDataset } = require('../scripts/brain-judge-eval');

const mkDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-judge-')), 'brain-journal');

function makeClock(start = Date.UTC(2026, 10, 17, 14, 0, 0), step = 1000) {
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

test('parseJudgeReply handles valid classes, rejects garbage/extra keys to NONE, and blocks PLUS/MINUS on questions', () => {
  assert.equal(parseJudgeReply('{"v":"PLUS"}', 'заработало'), 'PLUS');
  assert.equal(parseJudgeReply('{"v":"MINUS"}', 'опять мимо'), 'MINUS');
  assert.equal(parseJudgeReply('{"v":"CLARIFY"}', 'а если так?'), 'CLARIFY');
  assert.equal(parseJudgeReply('{"v":"NONE"}', 'спасибо'), 'NONE');

  // Garbage / non-JSON / wrong keys / wrong enum -> NONE
  for (const bad of ['', 'PLUS', 'непонятный текст', '{"v":"MAYBE"}', '{"v":"PLUS","extra":1}', '[]', 'null', '123']) {
    assert.equal(parseJudgeReply(bad, 'ну вот норм'), 'NONE', `expected NONE for ${bad}`);
  }

  // Question marks block PLUS/MINUS, allow CLARIFY
  assert.equal(parseJudgeReply('{"v":"PLUS"}', 'это сработало?'), 'NONE');
  assert.equal(parseJudgeReply('{"v":"MINUS"}', 'почему не работает?'), 'NONE');
  assert.equal(parseJudgeReply('{"v":"CLARIFY"}', 'А что насчёт Windows 11, там так же?'), 'CLARIFY');

  // Prompt format check
  const msgs = messagesForJudge('   ну вот, норм   ');
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, SYSTEM_PROMPT);
  assert.equal(msgs[1].content, '<reply>ну вот, норм</reply>');
});

test('passes exact Ollama params, skips on busy/unloaded/bad-length, and enforces 6/min rate limit', async () => {
  let nowMs = Date.UTC(2026, 10, 17, 14, 0, 0);
  let busy = false;
  let ready = true;
  const seenReqs = [];
  const judge = createVerdictJudge({
    now: () => nowMs,
    isBusy: () => busy,
    isModelReady: async () => ready,
    callModel: async (req) => {
      seenReqs.push(req);
      return '{"v":"PLUS"}';
    },
  });

  // Length guards (<2 or >120 chars)
  assert.equal((await judge.judge('а')).status, 'skipped');
  assert.equal((await judge.judge('x'.repeat(121))).status, 'skipped');

  // Busy guard
  busy = true;
  assert.equal((await judge.judge('ну норм')).status, 'skipped_busy');
  busy = false;

  // Not loaded / 26B active guard
  ready = false;
  assert.equal((await judge.judge('ну норм')).status, 'skipped_not_loaded');
  ready = true;

  // 6 calls within 60s succeed, 7th hits rate limit
  for (let i = 0; i < 6; i++) {
    nowMs += 1000;
    const r = await judge.judge('ну вот норм');
    assert.equal(r.status, 'ok');
    assert.equal(r.verdict, 'PLUS');
  }
  assert.equal(seenReqs[0].model, FAST);
  assert.equal(seenReqs[0].temperature, 0);
  assert.equal(seenReqs[0].numPredict, 16);
  assert.equal(seenReqs[0].think, false);
  assert.deepEqual(seenReqs[0].schema, VERDICT_SCHEMA);

  const limited = await judge.judge('ещё одна');
  assert.equal(limited.status, 'skipped_rate');

  // After 60s window expires, next call succeeds
  nowMs += 60000;
  assert.equal((await judge.judge('теперь ок')).status, 'ok');

  const st = judge.stats();
  assert.equal(st.e4b_plus, 7);
  assert.equal(st.skipped_busy, 1);
  assert.equal(st.skipped_not_loaded, 1);
  assert.equal(st.skipped_rate, 1);
});

test('caps MINUS at 3 per 10 minutes into NONE with minus_capped counter', async () => {
  let nowMs = Date.UTC(2026, 10, 17, 14, 0, 0);
  const judge = createVerdictJudge({
    now: () => nowMs,
    maxPerMinute: 100,
    callModel: async () => '{"v":"MINUS"}',
  });

  for (let i = 0; i < 3; i++) {
    nowMs += 1000;
    const res = await judge.judge('опять мимо');
    assert.equal(res.verdict, 'MINUS');
  }
  nowMs += 1000;
  const capped = await judge.judge('не то');
  assert.equal(capped.status, 'ok');
  assert.equal(capped.verdict, 'NONE');

  // Advance past 10 minutes -> next MINUS allowed again
  nowMs += 600000;
  const afterWindow = await judge.judge('сломалось');
  assert.equal(afterWindow.verdict, 'MINUS');

  const st = judge.stats();
  assert.equal(st.e4b_minus, 4);
  assert.equal(st.e4b_none, 1);
  assert.equal(st.minus_capped, 1);
});

test('circuit breaker disables after 5 consecutive errors/timeouts and recovers if error streak breaks', async () => {
  const timers = [];
  let modelImpl = async () => { throw new Error('boom'); };
  let calls = 0;
  const judge = createVerdictJudge({
    timeoutMs: 1500,
    maxPerMinute: 100,
    setTimer: (fn, ms) => {
      const h = { fn, ms, cleared: false, unref() {} };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => { if (h) h.cleared = true; },
    callModel: async (req, signal) => {
      calls++;
      return modelImpl(req, signal);
    },
  });

  // 4 errors then 1 success -> streak resets, not disabled
  for (let i = 0; i < 4; i++) assert.equal((await judge.judge('ну норм')).status, 'error');
  assert.equal(judge.stats().disabled, false);
  modelImpl = async () => '{"v":"NONE"}';
  assert.equal((await judge.judge('спасибо')).status, 'ok');
  assert.equal(judge.stats().errors, 4);

  // Timeout aborts hung call after 1500ms, plus 4 more errors -> 5 consecutive trips breaker
  modelImpl = (_req, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
  });
  const pendingTimeout = judge.judge('зависло');
  // the timer starts once the judge model is resolved (async): let that settle first
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.at(-1).ms, 1500);
  timers.at(-1).fn();
  assert.equal((await pendingTimeout).status, 'error');

  modelImpl = async () => { throw new Error('still down'); };
  for (let i = 0; i < 4; i++) assert.equal((await judge.judge('ещё сбой')).status, 'error');
  assert.equal(judge.stats().disabled, true);

  // Disabled judge stops making model calls until restart
  const callsBefore = calls;
  assert.equal((await judge.judge('после отключения')).status, 'skipped');
  assert.equal(calls, callsBefore);
});

test('shadow-hook/chat-glue: runs judge off hot path, ignores off/rp/Tor, aborts on torTouched, and never writes judge to journal', async () => {
  // 1. Flag off -> zero calls
  let judgeCalls = 0;
  const offJudge = createVerdictJudge({
    callModel: async () => { judgeCalls++; return '{"v":"PLUS"}'; },
  });
  const offHook = createShadowHook({ dir: mkDir(), now: makeClock(), uuid: makeUuid(100), verdictJudge: offJudge });
  const offGlue = createChatGlue({ getHook: () => offHook, tor, isLocalModel: () => true });
  const offCfg = { brainShadow: true, brainVerdictJudge: 'off', provider: 'ollama', rp: false };
  const tOff = offGlue.startLocal({ worker: null }, [{ role: 'user', content: 'привет' }], offCfg, new AbortController().signal);
  offGlue.afterSuccess(tOff);
  offGlue.beforeTurn([{ role: 'user', content: 'ну норм' }], offCfg);
  offGlue.afterTurn(offCfg);
  await offHook.close();
  assert.equal(judgeCalls, 0);

  // 2. Shadow mode + matrix + privacy + RP/Tor exclusion
  const dir = mkDir();
  let replies = ['{"v":"PLUS"}', '{"v":"PLUS"}', '{"v":"CLARIFY"}'];
  let idx = 0;
  const observedTexts = [];
  const shadowJudge = createVerdictJudge({
    maxPerMinute: 100,
    callModel: async (req) => {
      observedTexts.push(req.messages[1].content);
      return replies[idx++] || '{"v":"NONE"}';
    },
  });
  const hook = createShadowHook({ dir, now: makeClock(), uuid: makeUuid(500), verdictJudge: shadowJudge });
  const glue = createChatGlue({ getHook: () => hook, tor, isLocalModel: () => true });
  const cfg = { brainShadow: true, brainVerdictJudge: 'shadow', provider: 'ollama', rp: false };

  // Turn 1 -> followed by dict NULL phrase ("ну вот, норм") -> E4B catches PLUS, turn stays unverified
  const t1 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'вопрос 1' }], cfg, new AbortController().signal);
  glue.afterSuccess(t1);
  glue.beforeTurn([{ role: 'user', content: 'ну вот, норм' }], cfg);
  assert.equal(observedTexts.length, 0); // must NOT run synchronously inside beforeTurn
  glue.afterTurn(cfg);

  // Turn 2 -> followed by dict +1 phrase ("сработало") -> E4B agrees (+1), journal gets verified +1
  const t2 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'вопрос 2' }], cfg, new AbortController().signal);
  glue.afterSuccess(t2);
  glue.beforeTurn([{ role: 'user', content: 'сработало' }], cfg);
  glue.afterTurn(cfg);

  // Turn 3 -> followed by dict -1 phrase ("не то") -> mock E4B returns CLARIFY (disagree!) while journal records dict -1
  const t3 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'вопрос 3' }], cfg, new AbortController().signal);
  glue.afterSuccess(t3);
  glue.beforeTurn([{ role: 'user', content: 'не то' }], cfg);
  glue.afterTurn(cfg);
  await hook.flush();

  // Turn 4 -> RP mode next turn never calls judge
  const t4 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'вопрос 4' }], cfg, new AbortController().signal);
  glue.afterSuccess(t4);
  glue.beforeTurn([{ role: 'user', content: 'верно' }], { ...cfg, rp: true });
  glue.afterTurn({ ...cfg, rp: true });

  // Turn 5 -> Tor next turn never calls judge
  const t5 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'вопрос 5' }], cfg, new AbortController().signal);
  glue.afterSuccess(t5);
  glue.beforeTurn([{ role: 'user', content: 'найди через тор сработало' }], cfg);
  glue.afterTurn(cfg);

  await hook.close();

  assert.equal(observedTexts.length, 3);
  assert.equal(observedTexts.some((t) => t.includes('тор')), false);

  const st = hook.stats();
  assert.equal(st.published, 2); // only t2 (+1) and t3 (-1) via dict
  assert.equal(st.completed_turns, 4); // t1, t2, t3, t4; t5 excluded as Tor
  assert.equal(st.verified_pos, 1);
  assert.equal(st.verified_neg, 1);
  assert.equal(st.e4b_plus, 2);
  assert.equal(st.e4b_clarify, 1);
  assert.equal(st.agree, 1);
  assert.equal(st.disagree, 1);

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  assert.equal(files.length, 1);
  const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  for (const forbidden of ['e4b_', 'CLARIFY', 'PLUS', 'MINUS', 'ну вот, норм']) {
    assert.equal(content.includes(forbidden), false, `journal must not contain ${forbidden}`);
  }
});

test('torTouched aborts in-flight E4B judge call cleanly without errors or counter pollution', async () => {
  let aborted = false;
  let startedResolve;
  const started = new Promise((r) => { startedResolve = r; });

  const judge = createVerdictJudge({
    callModel: (_req, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('tor aborted judge'));
      }, { once: true });
      startedResolve();
    }),
  });

  const hook = createShadowHook({ dir: mkDir(), now: makeClock(), uuid: makeUuid(900), verdictJudge: judge });
  hook.hold(hook.start({ worker: null }));
  hook.resolvePending([{ role: 'user', content: 'ну норм' }], {
    said: 'ну норм',
    tor,
    rp: false,
    judge: 'shadow',
    deferJudge: true,
  });
  hook.runDeferredJudge();
  await started;

  hook.torTouched();
  await hook.close();

  assert.equal(aborted, true);
  assert.equal(hook.stats().errors, 0);
  assert.equal(hook.stats().e4b_plus, 0);
  assert.equal(hook.stats().e4b_none, 0);
});

test('offline 70-phrase eval passes with deterministic stub and flags broken model predictions', async () => {
  const ds = loadJudgeDataset();
  assert.equal(ds.cases.length, 70);

  const stubReport = await runJudgeEval({ dataset: ds });
  assert.equal(stubReport.passed, true);
  assert.equal(stubReport.total, 70);
  assert.equal(stubReport.correct, 70);
  assert.equal(stubReport.accuracy, 1);
  assert.equal(stubReport.metrics.dict_inversions, 0);

  // Simulated biased model predicting MINUS on everything must fail gates
  const badReport = await runJudgeEval({
    dataset: ds,
    callModel: async () => '{"v":"MINUS"}',
  });
  assert.equal(badReport.passed, false);
  assert.equal(badReport.gates.false_minus_on_clarify_le_5pct, false);
  assert.equal(badReport.gates.false_minus_on_none_le_5pct, false);
});

test('fresh /api/ps selector picks loaded 26B or E4B without cache or brains.current(), skipping both/empty/foreign', async () => {
  assert.equal(selectLoadedJudgeModel([MAIN]), MAIN);
  assert.equal(selectLoadedJudgeModel([FAST]), FAST);
  assert.equal(selectLoadedJudgeModel([FAST, MAIN]), null);
  assert.equal(selectLoadedJudgeModel([]), null);
  assert.equal(selectLoadedJudgeModel(['qwen3:8b']), null);
  assert.equal(selectLoadedJudgeModel([FAST, 'qwen3:8b']), null);
  assert.equal(selectLoadedJudgeModel(null), null);

  let nowMs = Date.UTC(2026, 10, 18, 4, 0, 0);
  let loadedList = [FAST];
  let psCalls = 0;
  let lastPsSignal = null;
  const seenModels = [];

  const brains = new Brains({
    ollama: { unload: async () => true, warm() {} },
    fast: FAST,
    main: MAIN,
    idleMs: 300000,
    now: () => nowMs,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
  });
  // Intentionally flip brains.current() to MAIN even though /api/ps only has FAST -> selector MUST ignore brains.current()!
  await brains.use('main');
  assert.equal(brains.current(), MAIN);

  const judge = createVerdictJudge({
    fastModel: FAST,
    mainModel: MAIN,
    now: () => nowMs,
    maxPerMinute: 100,
    resolveModel: createLoadedModelSelector({
      fastModel: FAST,
      mainModel: MAIN,
      timeoutMs: 300,
      loadedModels: async (psSignal) => {
        psCalls++;
        lastPsSignal = psSignal;
        return loadedList;
      },
    }),
    callModel: async (req) => {
      seenModels.push(req.model);
      return '{"v":"PLUS"}';
    },
  });

  // 1. Only E4B loaded -> judges with FAST regardless of brains.current() === MAIN
  const rFast = await judge.judge('да, сработало', { dictVerdict: 1 });
  assert.deepEqual(rFast, { status: 'ok', verdict: 'PLUS', model: FAST });
  assert.equal(psCalls, 1);
  assert.ok(lastPsSignal instanceof AbortSignal);

  // 2. Back-to-back (<1ms later, zero cache!) swap in /api/ps to [MAIN] -> immediately queries fresh /api/ps and picks MAIN
  loadedList = [MAIN];
  const rMain = await judge.judge('отлично, подошло', { dictVerdict: 1 });
  assert.deepEqual(rMain, { status: 'ok', verdict: 'PLUS', model: MAIN });
  assert.equal(psCalls, 2);

  // 3. Both loaded -> skipped_not_loaded (fresh check)
  loadedList = [FAST, MAIN];
  const rBoth = await judge.judge('ну норм');
  assert.deepEqual(rBoth, { status: 'skipped_not_loaded', verdict: null, model: null });
  assert.equal(psCalls, 3);

  // 4. Foreign model loaded -> skipped_not_loaded
  loadedList = ['qwen3:8b'];
  assert.deepEqual(await judge.judge('норм вроде'), { status: 'skipped_not_loaded', verdict: null, model: null });
  assert.equal(psCalls, 4);

  // 5. Nothing loaded -> skipped_not_loaded
  loadedList = [];
  assert.deepEqual(await judge.judge('помогло'), { status: 'skipped_not_loaded', verdict: null, model: null });
  assert.equal(psCalls, 5);

  assert.deepEqual(seenModels, [FAST, MAIN]);
  const st = judge.stats();
  assert.equal(st.judged_fast, 1);
  assert.equal(st.judged_main, 1);
  assert.equal(st.e4b_plus, 2);
  assert.equal(st.skipped_not_loaded, 3);
});

test('string model parameter remains backwards-compatible and sets result.model + judged_fast/main', async () => {
  const rFastJudge = createVerdictJudge({
    model: FAST,
    callModel: async () => '{"v":"CLARIFY"}',
  });
  const resFast = await rFastJudge.judge('а если так?');
  assert.deepEqual(resFast, { status: 'ok', verdict: 'CLARIFY', model: FAST });
  assert.equal(rFastJudge.stats().judged_fast, 1);
  assert.equal(rFastJudge.stats().judged_main, 0);
  assert.equal(rFastJudge.stats().e4b_clarify, 1);

  const customJudge = createVerdictJudge({
    resolveModel: () => MAIN,
    callModel: async () => '{"v":"MINUS"}',
  });
  const resMain = await customJudge.judge('не сработало', { dictVerdict: -1 });
  assert.deepEqual(resMain, { status: 'ok', verdict: 'MINUS', model: MAIN });
  assert.equal(customJudge.stats().judged_fast, 0);
  assert.equal(customJudge.stats().judged_main, 1);
  assert.equal(customJudge.stats().e4b_minus, 1);
});

test('judging with the 26B gets the longer timeout (it sits partly in RAM), the E4B keeps the short one', async () => {
  const seen = [];
  const make = (model) => createVerdictJudge({
    model,
    callModel: async () => '{"v":"PLUS"}',
    isModelReady: async () => true,
    setTimer: (fn, ms) => { seen.push(ms); return { unref() {} }; },
    clearTimer: () => {},
  });
  await make(MAIN).judge('верно');
  await make(FAST).judge('верно');

  // Selector-resolved models also get 6000 ms for 26B and 1500 ms for E4B
  const makeFromPs = (psList) => createVerdictJudge({
    resolveModel: createLoadedModelSelector({ loadedModels: async () => psList }),
    callModel: async () => '{"v":"PLUS"}',
    setTimer: (_fn, ms) => { seen.push(ms); return { unref() {} }; },
    clearTimer: () => {},
  });
  await makeFromPs([MAIN]).judge('верно');
  await makeFromPs([FAST]).judge('верно');
  assert.deepEqual(seen, [6000, 1500, 6000, 1500]);
});
