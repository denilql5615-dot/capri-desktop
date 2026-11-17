'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runBaselineBench, loadDataset, THRESHOLDS } = require('../scripts/brain-baseline-bench');

test('short N=2 run passes parity, semantic counts, replay, privacy, and timing checks', async () => {
  const dataset = loadDataset();
  assert.equal(dataset.scenarios.length, 30);

  const report = await runBaselineBench({ warmup: 1, runs: 2 });
  assert.equal(report.passed, true);
  assert.equal(report.verdict.status, 'PASS');
  assert.deepEqual(report.thresholds, THRESHOLDS);
  for (const [k, v] of Object.entries(report.checks)) {
    assert.equal(v, true, `check failed: ${k}`);
  }
  assert.deepEqual(report.summary.decision_parity, { equal: 126, total: 126, percent: 100 });
  assert.equal(report.summary.callback_calls.equal, true);
  assert.equal(report.summary.real_model_or_network_calls, 0);
  assert.deepEqual(report.summary.last_run_stats, {
    published: 7,
    discarded: 43, // 40 non-Tor unverified + 3 initial turns cancelled on Tor context in tor-01..03
    observer_errors: 0,
    verified_pos: 4,
    verified_neg: 3,
    unverified: 40,
    completed_turns: 47,
  });
  assert.equal(report.timing.n, 126);
  assert.ok(Number.isFinite(report.timing.p50) && Number.isFinite(report.timing.p95) && Number.isFinite(report.timing.p99));
  assert.ok(report.timing.p50 <= report.timing.p95 && report.timing.p95 <= report.timing.p99);
});

test('decision tampering breaks parity and fails benchmark verdict', async () => {
  const report = await runBaselineBench({
    warmup: 0,
    runs: 1,
    tamper: (d, idx) => (idx === 0 ? { ...d, tier: 'deep' } : d),
  });
  assert.equal(report.checks.decision_parity_100pct, false);
  assert.equal(report.passed, false);
  assert.equal(report.verdict.status, 'FAIL');
  assert.ok(report.summary.decision_parity.equal < report.summary.decision_parity.total);
});

test('Tor scenarios leave zero journal files and zero denominator counts', async () => {
  const torScenarios = loadDataset().scenarios.filter((s) => s.id.startsWith('tor-'));
  assert.equal(torScenarios.length, 3);

  const report = await runBaselineBench({ scenarios: torScenarios, warmup: 0, runs: 2 });
  assert.equal(report.passed, true);
  assert.equal(report.summary.journal_files, 0);
  assert.equal(report.summary.last_run_stats.published, 0);
  assert.equal(report.summary.last_run_stats.completed_turns, 0);
  assert.equal(report.summary.last_run_stats.verified_pos, 0);
  assert.equal(report.summary.last_run_stats.verified_neg, 0);
  assert.equal(report.summary.last_run_stats.unverified, 0);
});
