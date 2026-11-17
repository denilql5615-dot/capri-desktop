'use strict';

// Offline Stage 3 benchmark for Capri's shadow brain observer (no Ollama, Electron, network, or live IPC).
// Measures synchronous glue/hook overhead (beforeTurn + startLocal + afterSuccess), decision parity,
// RSS delta (with --expose-gc), denominator counts, replay consistency, and privacy isolation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Router } = require('../src/main/router');
const { rpCommand } = require('../src/main/brains');
const tor = require('../src/main/tor');
const { CONFIG, canonical, replay } = require('../src/main/brain');
const { salience, verdictOf } = require('../src/main/brain/amygdala');
const { createChatGlue } = require('../src/main/brain/chat-glue');
const { createShadowHook } = require('../src/main/brain/shadow-hook');
const { openRotatingJournal } = require('../src/main/brain/rotating-journal');

const FIXTURE_PATH = path.join(__dirname, '..', 'tests', 'fixtures', 'brain-baseline-set.json');
const THRESHOLDS = Object.freeze({ p95: 5, p99: 20, rss_mib: 16 });
const PENDING_TTL_MS = 120000;
const SCENARIO_GAP_MS = PENDING_TTL_MS + 1000;

function loadDataset(file = FIXTURE_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function createVirtualClock(startMs = Date.UTC(2026, 10, 17, 12, 0, 0)) {
  let nowMs = startMs;
  let nextId = 1;
  const timers = new Map();
  const setTimer = (fn, ms) => {
    const id = nextId++;
    const due = nowMs + Math.max(0, Number(ms) || 0);
    timers.set(id, { id, fn, due });
    return { id, unref() {} };
  };
  const clearTimer = (handle) => {
    if (handle && handle.id !== undefined) timers.delete(handle.id);
  };
  const advance = (ms) => {
    const target = nowMs + Math.max(0, Number(ms) || 0);
    for (;;) {
      let earliest = null;
      for (const entry of timers.values()) {
        if (entry.due <= target && (!earliest || entry.due < earliest.due)) earliest = entry;
      }
      if (!earliest) break;
      nowMs = earliest.due;
      timers.delete(earliest.id);
      earliest.fn();
    }
    nowMs = target;
  };
  return { now: () => nowMs, setTimer, clearTimer, advance };
}

function makeUuid(prefix = 1000) {
  let n = prefix;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

function mockChat(counter) {
  return async (_model, messages) => {
    counter.calls++;
    const raw = String(messages.at(-1)?.content || '');
    const tierSym = /JSON|конфиг|скрипт|архитект|лог|индекс|прокси/i.test(raw) ? '2' : '1';
    return { content: `C${tierSym}00` };
  };
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function roundMs(value) {
  return Math.round(value * 10000) / 10000;
}

function readHeadCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function deriveExpectedCounts(scenarios) {
  let completedTurns = 0;
  let verifiedPos = 0;
  let verifiedNeg = 0;
  for (const scenario of scenarios) {
    if (scenario.expected_observed !== true) continue;
    let hasLivePending = false;
    for (const turn of scenario.turns) {
      if (hasLivePending) {
        if (turn.expected_verdict === 1) verifiedPos++;
        else if (turn.expected_verdict === -1) verifiedNeg++;
        hasLivePending = false;
      }
      if (turn.expected_turn_observed === true) {
        completedTurns++;
        hasLivePending = (Number(turn.pause_after_sec) || 0) * 1000 < PENDING_TTL_MS;
      }
    }
  }
  return { completed_turns: completedTurns, verified_pos: verifiedPos, verified_neg: verifiedNeg };
}

async function runBaselinePass(scenarios, startMs) {
  const clock = createVirtualClock(startMs);
  const counter = { calls: 0 };
  const router = new Router({ chat: mockChat(counter), now: clock.now });
  const decisions = [];

  for (const scenario of scenarios) {
    const history = [];
    for (const turn of scenario.turns) {
      const rpTurn = rpCommand(turn.text);
      if (rpTurn !== null) {
        decisions.push({ rpCommand: rpTurn, route: null });
      } else {
        const d = await router.decide(turn.text, { model: 'mock', context: history.slice(-2) });
        decisions.push({ rpCommand: null, route: d });
      }
      history.push({ role: 'user', content: turn.text }, { role: 'assistant', content: 'ok' });
      clock.advance((Number(turn.pause_after_sec) || 0) * 1000);
    }
    clock.advance(SCENARIO_GAP_MS);
  }
  return { decisions, calls: counter.calls };
}

async function runObservedPass(scenarios, startMs, { tamper, uuidSeed = 1000 } = {}) {
  const clock = createVirtualClock(startMs);
  const counter = { calls: 0 };
  const router = new Router({ chat: mockChat(counter), now: clock.now });
  const journalDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-bench-')), `v${CONFIG.schema_version}`);
  let openedJournal = null;

  const hook = createShadowHook({
    dir: journalDir,
    now: clock.now,
    uuid: makeUuid(uuidSeed),
    pendingTtlMs: PENDING_TTL_MS,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    openJournal: async (d) => {
      openedJournal = await openRotatingJournal(d);
      return openedJournal;
    },
  });

  const glue = createChatGlue({
    getHook: (create = true) => (create ? hook : hook),
    tor,
    salience,
    isLocalModel: (cfg) => cfg.provider === 'ollama',
  });

  const decisions = [];
  const timingsMs = [];
  const allTexts = [];
  const rendererIds = [];
  let salienceOk = true;
  let verdictOk = true;
  let turnObservedOk = true;
  let torOrRpObserved = false;

  try {
    let globalTurn = 0;
    for (const scenario of scenarios) {
      const cfg = { brainShadow: true, provider: 'ollama', rp: false };
      const messages = [{ role: 'system', content: 'Capri offline bench.' }];

      for (let ti = 0; ti < scenario.turns.length; ti++) {
        const turn = scenario.turns[ti];
        globalTurn++;
        allTexts.push(turn.text);
        const rendererId = `renderer-bench-${globalTurn}`;
        rendererIds.push(rendererId);
        messages.push({ role: 'user', content: turn.text, rendererId });

        const actualSal = salience(turn.text);
        const actualVerdict = verdictOf(turn.text);
        if (actualSal.urgency !== turn.expected_salience.urgency ||
            actualSal.contradiction !== turn.expected_salience.contradiction) {
          salienceOk = false;
        }
        if (actualVerdict !== turn.expected_verdict) verdictOk = false;

        let syncNs = 0n;
        const t0 = process.hrtime.bigint();
        glue.beforeTurn(messages, cfg);
        syncNs += process.hrtime.bigint() - t0;

        const rpTurn = rpCommand(turn.text);
        let shadowTurn = null;
        if (rpTurn !== null) {
          cfg.rp = rpTurn;
          decisions.push({ rpCommand: rpTurn, route: null });
          if (turn.expected_turn_observed !== false) turnObservedOk = false;
        } else {
          let d = await router.decide(turn.text, { model: 'mock', context: messages.slice(-3, -1) });
          if (tamper) d = tamper(d, globalTurn - 1, scenario);
          decisions.push({ rpCommand: null, route: d });

          const route = {
            worker: d.target === 'worker' ? 'claude' : d.target === 'computer' ? 'computer' : null,
            tier: d.tier,
            computer: d.target === 'computer',
            rendererId,
          };
          const ac = new AbortController();
          const t1 = process.hrtime.bigint();
          shadowTurn = glue.startLocal(route, messages, cfg, ac.signal);
          glue.afterSuccess(shadowTurn);
          syncNs += process.hrtime.bigint() - t1;

          const wasObserved = Boolean(shadowTurn);
          if (wasObserved !== turn.expected_turn_observed) turnObservedOk = false;
          if (!turn.expected_turn_observed && wasObserved) torOrRpObserved = true;
        }

        timingsMs.push(Number(syncNs) / 1e6);
        messages.push({ role: 'assistant', content: 'ok' });
        clock.advance((Number(turn.pause_after_sec) || 0) * 1000);
      }
      clock.advance(SCENARIO_GAP_MS);
    }

    await hook.flush();
    const liveSnapshot = openedJournal ? openedJournal.snapshot() : null;
    await hook.close();

    const files = fs.existsSync(journalDir)
      ? fs.readdirSync(journalDir).filter((f) => f.endsWith('.ndjson')).sort()
      : [];
    let replayOk = true;
    let journalContent = '';
    if (files.length) {
      for (const f of files) {
        journalContent += fs.readFileSync(path.join(journalDir, f), 'utf8');
      }
      const lastContent = fs.readFileSync(path.join(journalDir, files[files.length - 1]), 'utf8');
      if (!liveSnapshot || canonical(replay(lastContent).snapshot()) !== canonical(liveSnapshot)) {
        replayOk = false;
      }
    }

    const leakedText = allTexts.some((txt) => journalContent.includes(txt));
    const leakedRenderer = rendererIds.some((id) => journalContent.includes(id));
    const leakedTor = /(?:через тор|\.onion|даркнет)/i.test(journalContent);

    return {
      decisions,
      calls: counter.calls,
      timingsMs,
      stats: hook.stats(),
      journalFiles: files.length,
      salienceOk,
      verdictOk,
      turnObservedOk,
      torOrRpObserved,
      replayOk,
      leaked: leakedText || leakedRenderer || leakedTor,
    };
  } finally {
    await hook.close();
  }
}

async function runBaselineBench({
  scenarios = loadDataset().scenarios,
  warmup = 2,
  runs = 30,
  tamper,
} = {}) {
  const startMs = Date.UTC(2026, 10, 17, 12, 0, 0);
  const expected = deriveExpectedCounts(scenarios);
  const turnsPerRun = scenarios.reduce((sum, s) => sum + s.turns.length, 0);

  for (let w = 0; w < warmup; w++) {
    await runBaselinePass(scenarios, startMs);
    await runObservedPass(scenarios, startMs, { uuidSeed: (w + 1) * 10000 });
  }

  const gcAvailable = typeof global.gc === 'function';
  if (gcAvailable) global.gc();
  const rssBefore = gcAvailable ? process.memoryUsage().rss : null;
  let rssPeak = rssBefore;

  const timingsAll = [];
  let equalDecisions = 0;
  let totalTurns = 0;
  let totalBaselineCalls = 0;
  let totalObservedCalls = 0;
  let totalObserverErrors = 0;
  let allSalienceOk = true;
  let allVerdictOk = true;
  let allTurnObservedOk = true;
  let anyTorOrRpObserved = false;
  let anyLeak = false;
  let allReplayOk = true;
  let allVerifiedCountsExact = true;
  let lastStats = null;
  let totalJournalFiles = 0;

  for (let r = 0; r < runs; r++) {
    const base = await runBaselinePass(scenarios, startMs);
    const obs = await runObservedPass(scenarios, startMs, { tamper, uuidSeed: (warmup + r + 1) * 10000 });

    totalBaselineCalls += base.calls;
    totalObservedCalls += obs.calls;
    totalObserverErrors += obs.stats.observer_errors;
    totalJournalFiles += obs.journalFiles;
    if (!obs.salienceOk) allSalienceOk = false;
    if (!obs.verdictOk) allVerdictOk = false;
    if (!obs.turnObservedOk) allTurnObservedOk = false;
    if (obs.torOrRpObserved) anyTorOrRpObserved = true;
    if (obs.leaked) anyLeak = true;
    if (!obs.replayOk) allReplayOk = false;
    if (obs.stats.verified_pos !== expected.verified_pos ||
        obs.stats.verified_neg !== expected.verified_neg ||
        obs.stats.completed_turns !== expected.completed_turns) {
      allVerifiedCountsExact = false;
    }
    lastStats = obs.stats;

    for (let i = 0; i < base.decisions.length; i++) {
      totalTurns++;
      if (canonical(base.decisions[i]) === canonical(obs.decisions[i])) equalDecisions++;
    }
    for (const ms of obs.timingsMs) timingsAll.push(ms);
    if (gcAvailable) rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }

  if (gcAvailable) global.gc();
  const rssAfter = gcAvailable ? process.memoryUsage().rss : null;
  const rssDeltaBytes = gcAvailable ? rssAfter - rssBefore : null;
  const rssDeltaMib = gcAvailable ? Math.round((rssDeltaBytes / (1024 * 1024)) * 1000) / 1000 : null;

  const sorted = [...timingsAll].sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
  const timing = {
    n: sorted.length,
    p50: sorted.length ? roundMs(percentile(sorted, 0.5)) : null,
    p95: sorted.length ? roundMs(percentile(sorted, 0.95)) : null,
    p99: sorted.length ? roundMs(percentile(sorted, 0.99)) : null,
    mean: mean !== null ? roundMs(mean) : null,
    max: sorted.length ? roundMs(sorted[sorted.length - 1]) : null,
    unit: 'ms',
  };

  const checks = {
    decision_parity_100pct: totalTurns > 0 && equalDecisions === totalTurns && totalBaselineCalls === totalObservedCalls,
    no_observer_errors: totalObserverErrors === 0,
    no_text_or_renderer_id_in_journal: !anyLeak,
    tor_and_rp_unobserved: allTurnObservedOk && !anyTorOrRpObserved,
    salience_and_verdict_match: allSalienceOk && allVerdictOk,
    verified_counts_exact: allVerifiedCountsExact,
    replay_equal: allReplayOk,
  };

  const p95Ok = timing.p95 !== null && timing.p95 <= THRESHOLDS.p95;
  const p99Ok = timing.p99 !== null && timing.p99 <= THRESHOLDS.p99;
  const rssOk = gcAvailable ? rssDeltaBytes <= THRESHOLDS.rss_mib * 1024 * 1024 : null;
  const checksOk = Object.values(checks).every(Boolean);
  const passed = checksOk && p95Ok && p99Ok && (rssOk !== false);

  const rss_delta = gcAvailable
    ? {
        gc_exposed: true,
        before_bytes: rssBefore,
        after_bytes: rssAfter,
        delta_bytes: rssDeltaBytes,
        delta_mib: rssDeltaMib,
        peak_bytes: rssPeak,
        note: 'offline gc-stabilized RSS delta across measured runs only; not a live Capri Electron reading',
      }
    : {
        gc_exposed: false,
        before_bytes: null,
        after_bytes: null,
        delta_bytes: null,
        delta_mib: null,
        peak_bytes: null,
        note: 'RSS delta unavailable: pass --expose-gc to evaluate rss_mib threshold',
      };

  const cpus = os.cpus();
  return {
    passed,
    note: 'Офлайн-стенд этапа 3 с заглушкой модели; числа отражают только накладные расходы обвязки в Node и не являются замерами живой Капри.',
    checks,
    timing,
    rss_delta,
    thresholds: { ...THRESHOLDS },
    verdict: {
      status: passed ? 'PASS' : 'FAIL',
      checks_ok: checksOk,
      p95_ok: p95Ok,
      p99_ok: p99Ok,
      rss_ok: rssOk,
      note: rssOk === null
        ? 'offline bench criteria passed; RSS threshold unverified without --expose-gc; does not authorize enabling brainShadow automatically'
        : 'offline bench criteria evaluated against predeclared thresholds; does not measure live Electron/Ollama and does not authorize enabling brainShadow automatically',
    },
    summary: {
      warmup,
      runs,
      scenarios_per_run: scenarios.length,
      turns_per_run: turnsPerRun,
      total_turns_measured: totalTurns,
      decision_parity: { equal: equalDecisions, total: totalTurns, percent: totalTurns ? Math.round((equalDecisions / totalTurns) * 10000) / 100 : 0 },
      callback_calls: { baseline: totalBaselineCalls, observed: totalObservedCalls, equal: totalBaselineCalls === totalObservedCalls },
      expected_per_run: expected,
      last_run_stats: lastStats,
      journal_files: totalJournalFiles,
      real_model_or_network_calls: 0,
    },
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      cpu_model: cpus[0]?.model || null,
      cpu_cores: cpus.length,
      total_mem_mib: Math.round(os.totalmem() / (1024 * 1024)),
      head_commit: readHeadCommit(),
      pending_ttl_ms: PENDING_TTL_MS,
      buffer_config: { schema_version: CONFIG.schema_version, version: CONFIG.version },
    },
  };
}

if (require.main === module) {
  runBaselineBench()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (!report.passed) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}

module.exports = { runBaselineBench, loadDataset, createVirtualClock, THRESHOLDS };
