'use strict';
// Offline synthetic pilot harness for the brain shadow observer. No model, network, browser or
// live Capri code: the real Router class runs with a deterministic mock "chat" (the router's
// model callback). Outcomes are harness assertions, not evidence of real task usefulness, and
// nothing here measures a running Capri. See docs/BRAIN_PILOT.md.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Router } = require('../src/main/router');
const { replay } = require('../src/main/brain');
const { createTaskBuffer } = require('../src/main/brain/task-buffer');
const { openAsyncJournal } = require('../src/main/brain/async-journal');
const { freezeSnapshot } = require('../src/main/brain/snapshot');

// 24 fixed synthetic local-chat / quick-reply cases: [text, mocked router reply, harness outcome].
const TEXTS = ['привет', 'как дела', 'сколько секунд в минуте', 'расскажи шутку', 'что такое радуга', 'сколько будет шесть на семь',
  'назови столицу Франции', 'порекомендуй фильм на вечер', 'как сказать спасибо по-английски', 'зачем людям нужен сон',
  'сколько ног у паука', 'как называется самая длинная река', 'почему небо голубое', 'придумай название для кота', 'расскажи про осень',
  'как заварить чай', 'спой что-нибудь', 'что ты думаешь о дожде', 'напомни, как тебя зовут', 'скажи что-нибудь доброе',
  'сколько дней в феврале', 'переведи слово дом на английский', 'какая сегодня погода вообще бывает зимой', 'до свидания'];
const REPLIES = ['C100', 'C100', 'C100', 'C200', 'C200', 'C100', 'C100', 'C200', 'C100', 'C100', 'C100', 'C100',
  'C200', 'C200', 'C200', 'C100', 'C100', 'C200', 'C100', 'C100', 'C100', 'C100', 'C200', 'C100'];
const CASES = TEXTS.map((text, i) => ({ text, reply: REPLIES[i], failed: i % 8 === 7 }));
const STEP_MS = 1000;
const canon = (v) => JSON.stringify(v);

function mockChat(counter) { // router model callback: the case is found by its text, no real model
  return async (_model, messages) => {
    counter.calls++;
    const text = /<message>([\s\S]*)<\/message>/.exec(messages.at(-1).content)[1];
    return { content: CASES.find((c) => c.text === text).reply };
  };
}

async function runDecisions({ observe, tamper, onObserverError } = {}) {
  let t = 0;
  const counter = { calls: 0 };
  const router = new Router({ chat: mockChat(counter), now: () => t }); // fresh state, explicit clock
  const decisions = [];
  for (let i = 0; i < CASES.length; i++) {
    t = i * STEP_MS;
    let d = await router.decide(CASES[i].text, { model: 'mock' });
    if (observe) { try { await observe(freezeSnapshot(d), i, t); } catch { onObserverError?.(); /* never affects the decision, but invalidates the harness result */ } }
    if (tamper) d = tamper(d, i); // test-only: simulates an observer leaking into the decision
    decisions.push(d);
  }
  return { decisions, calls: counter.calls };
}

const percent = (a, b) => Math.round((a / b) * 1000) / 10;
async function runPilot({ journalFile, compare = (a, b) => canon(a) === canon(b), tamper, probe } = {}) {
  const file = journalFile || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-pilot-')), 'journal.ndjson');
  const baseline = await runDecisions();
  const journal = await openAsyncJournal(file);
  const buffer = createTaskBuffer();
  let n = 0; const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const sidecar = { published: 0, discarded: 0, submitted: 0, accepted: 0, duplicate: 0, errors: 0 }, timings = [];
  const observe = async (decision, i, at) => {
    const start = process.hrtime.bigint();
    const source_id = uuid(), task_id = uuid(); // one dedicated source per task
    const base = (type, seq, extra) => ({ type, schema_version: 1, config_version: 1, event_id: uuid(), task_id, source_id,
      source_seq: seq, task_seq: seq, occurred_at_ms: at, received_at_ms: at, ...extra });
    const root = buffer.open('ordinary'); // harness-certified: synthetic local-chat only
    try {
      probe?.(decision, { root, buffer, journal, i }); // test-only: lets a test mutate the copy or inject failures
      const failed = CASES[i].failed;
      buffer.add(root, base('message', 1, { origin: 'user', route: 'unknown', novelty: 0, uncertainty: decision.by === 'model' ? 0 : 1, contradiction: 0, urgency: 0, prediction: 0 }));
      buffer.add(root, base('tool_result', 2, { outcome: 'ok', duration_ms: 0 }));
      buffer.add(root, base('task_completed', 3, { outcome: failed ? 'failed' : 'completed', validation: 'verified', utility: failed ? -1 : 1 }));
      const result = buffer.finish(root);
      if (result.status !== 'published') { sidecar.discarded++; return; }
      for (const event of result.batch) {
        const r = await journal.ingest({ privacy: 'ordinary', event });
        if (r?.status !== 'accepted' && r?.status !== 'duplicate') throw new Error('journal_ingest_rejected');
        sidecar.submitted++; sidecar[r.status]++;
      }
      sidecar.published++; // counted only after the whole batch reached the journal
      timings.push(Number(process.hrtime.bigint() - start) / 1e6);
    } finally { buffer.cancel(root); } // frees the slot on any failure
  };
  let observed, live;
  try {
    observed = await runDecisions({ observe, tamper, onObserverError: () => { sidecar.errors++; } });
    live = journal.snapshot();
  } finally { await journal.close(); }
  const text = fs.readFileSync(file, 'utf8');
  const restored = replay(text).snapshot();
  const equal = observed.decisions.filter((d, i) => compare(baseline.decisions[i], d)).length;
  const mean = timings.length ? timings.reduce((a, b) => a + b, 0) / timings.length : null;
  const total = CASES.length;
  const checks = {
    decision_parity: equal === total, callback_parity: baseline.calls === observed.calls, no_observer_errors: sidecar.errors === 0,
    published_all: sidecar.published === total, events_submitted: sidecar.submitted === total * 3,
    replay_equal: canon(restored) === canon(live), no_synthetic_text: !CASES.some((c) => text.includes(c.text)) };
  return {
    passed: Object.values(checks).every(Boolean), checks, passed_note: 'harness criteria only; thresholds unevaluated; not a live pass',
    harness: 'synthetic offline; router model callback is a deterministic mock; not a running-Capri measurement',
    cases: CASES.length,
    decision_parity: { equal, total: CASES.length, percent: percent(equal, CASES.length) },
    router_callback_calls: { baseline: baseline.calls, observed: observed.calls, equal: baseline.calls === observed.calls },
    real_model_or_network_calls: 0, // by construction: only the mock callback exists in this harness
    sidecar,
    journal: { file, records: live.record_count, replay_equal: canon(restored) === canon(live),
      synthetic_text_in_journal: CASES.some((c) => text.includes(c.text)) },
    latency_ms: { n: timings.length, sidecar_mean: mean, sidecar_max: timings.length ? Math.max(...timings) : null,
      p95: null, p99: null, note: 'n=24 harness timings only; no p95/p99 claim, no hardware baseline' },
    rss_delta_bytes: null, rss_note: 'not meaningful at 24 in-process cases; not reported',
    thresholds: { p95_ms: 5, p99_ms: 20, rss_mib: 16, verdict: null, note: 'predeclared in docs; unevaluated here; agreement does not authorize live hooks' },
    coverage: 'incomplete: mocked router replies, local-chat only, no live integration',
  };
}

if (require.main === module) {
  runPilot().then((r) => { console.log(JSON.stringify(r, null, 2)); if (!r.passed) process.exitCode = 1; }, (err) => { console.error(err.message); process.exitCode = 1; });
}
module.exports = { runPilot, CASES, freezeSnapshot };
