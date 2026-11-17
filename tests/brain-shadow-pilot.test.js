'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runPilot, CASES } = require('../scripts/brain-shadow-pilot');

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-pilot-test-')), 'journal.ndjson');

test('24 fixed cases: decisions, router callback calls and journal all agree', async () => {
  assert.equal(CASES.length, 24);
  const r = await runPilot({ journalFile: file() });
  assert.deepEqual(r.decision_parity, { equal: 24, total: 24, percent: 100 });
  assert.deepEqual(r.router_callback_calls, { baseline: 24, observed: 24, equal: true });
  assert.equal(r.real_model_or_network_calls, 0);
  assert.deepEqual(r.sidecar, { published: 24, discarded: 0, submitted: 72, accepted: 72, duplicate: 0, errors: 0 });
  assert.equal(r.passed, true);
  assert.ok(Object.values(r.checks).every(Boolean));
  assert.equal(r.thresholds.verdict, null);
  assert.equal(r.journal.records, 72);
  assert.equal(r.journal.replay_equal, true);
  assert.equal(r.journal.synthetic_text_in_journal, false);
});

test('the journal holds only IDs, enums and numbers: no synthetic text, schema-valid, one source per task', async () => {
  const f = file();
  await runPilot({ journalFile: f });
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').slice(1).map((l) => JSON.parse(l));
  assert.equal(lines.length, 72);
  const sources = new Set();
  for (const row of lines) {
    for (const [k, v] of Object.entries(row.event)) assert.ok(typeof v === 'number' || /^[a-z0-9_-]+$/.test(v), `${k} is not metadata`);
    sources.add(row.event.source_id);
  }
  assert.equal(sources.size, 24);
});

test('reports are reproducible across runs (decisions, counts) and never claim measurements', async () => {
  const a = await runPilot({ journalFile: file() }), b = await runPilot({ journalFile: file() });
  assert.deepEqual(a.decision_parity, b.decision_parity);
  assert.equal(a.journal.records, b.journal.records);
  assert.equal(a.latency_ms.p95, null); assert.equal(a.latency_ms.p99, null);
  assert.equal(a.rss_delta_bytes, null); assert.equal(a.thresholds.verdict, null);
  assert.match(a.coverage, /incomplete/);
});

test('observer cannot influence decisions even when it mutates its copy; a leaking observer is detected', async () => {
  const mutated = await runPilot({ journalFile: file(), probe: (d) => { d.tier = 'deep'; d.target = 'worker'; } });
  assert.equal(mutated.decision_parity.equal, 24);
  assert.equal(mutated.passed, true);
  const leaked = await runPilot({ journalFile: file(), tamper: (d, i) => (i === 5 ? { ...d, tier: 'deep' } : d) });
  assert.equal(leaked.decision_parity.equal, 23);
  assert.equal(leaked.passed, false);
  const never = await runPilot({ journalFile: file(), compare: () => false });
  assert.equal(never.decision_parity.equal, 0);
  assert.equal(never.passed, false);
});

test('an existing journal is never overwritten: a rerun only redelivers identical IDs as duplicates', async () => {
  const f = file();
  await runPilot({ journalFile: f });
  const before = fs.readFileSync(f, 'utf8');
  const again = await runPilot({ journalFile: f });
  assert.equal(fs.readFileSync(f, 'utf8'), before); // same synthetic IDs: no append, no truncation
  assert.equal(again.journal.records, 72);
  assert.equal(again.journal.replay_equal, true);
  assert.equal(again.sidecar.accepted, 0);
  assert.equal(again.sidecar.duplicate, 72);
});
test('observer failures keep route parity but are counted, invalidate the result and publish nothing', async () => {
  const r = await runPilot({ journalFile: file(), probe: () => { throw new Error('observer boom with synthetic text'); } });
  assert.equal(r.decision_parity.equal, 24);
  assert.equal(r.sidecar.errors, 24);
  assert.equal(r.sidecar.published, 0);
  assert.equal(r.sidecar.submitted, 0);
  assert.equal(r.checks.no_observer_errors, false);
  assert.equal(r.passed, false);
  assert.equal(JSON.stringify(r).includes('boom'), false); // counts only, never raw error text
});

test('the journal handle is closed even when routing throws', async () => {
  const fsp = require('node:fs/promises');
  const realOpen = fsp.open;
  let opened = 0, closed = 0;
  fsp.open = async (...a) => {
    const fh = await realOpen.apply(fsp, a);
    opened++;
    const origClose = fh.close.bind(fh);
    fh.close = async (...ca) => { try { return await origClose(...ca); } finally { closed++; } };
    return fh;
  };
  try {
    await assert.rejects(runPilot({ journalFile: file(), tamper: () => { throw new Error('tamper'); } }), /tamper/);
  } finally { fsp.open = realOpen; }
  assert.ok(opened >= 1);
  assert.equal(closed, opened);
});

test('buffer discard prevents false success (no published credit)', async () => {
  const r = await runPilot({
    journalFile: file(),
    probe: (_d, { root, buffer, i }) => { if (i === 0) buffer.cancel(root); },
  });
  assert.equal(r.decision_parity.equal, 24);
  assert.equal(r.sidecar.discarded, 1);
  assert.equal(r.sidecar.published, 23);
  assert.equal(r.sidecar.submitted, 69);
  assert.equal(r.sidecar.errors, 0);
  assert.equal(r.checks.published_all, false);
  assert.equal(r.checks.events_submitted, false);
  assert.equal(r.passed, false);
});

test('mid-batch journal write failure fails the run without counting the incomplete batch as published', async () => {
  const fsp = require('node:fs/promises');
  const realOpen = fsp.open;
  let appends = 0;
  fsp.open = async (...a) => {
    const fh = await realOpen.apply(fsp, a);
    if (a[1] === 'a') {
      const realAppend = fh.appendFile.bind(fh);
      fh.appendFile = async (...aa) => {
        if (++appends === 5) throw new Error('disk boom with secret');
        return realAppend(...aa);
      };
    }
    return fh;
  };
  let r;
  try {
    r = await runPilot({ journalFile: file() });
  } finally { fsp.open = realOpen; }
  assert.equal(r.decision_parity.equal, 24);
  assert.equal(r.sidecar.published, 1);
  assert.equal(r.sidecar.submitted, 4);
  assert.equal(r.sidecar.accepted, 4);
  assert.ok(r.sidecar.errors > 0);
  assert.equal(r.checks.published_all, false);
  assert.equal(r.checks.no_observer_errors, false);
  assert.equal(r.passed, false);
  assert.equal(r.journal.records, 4);
  assert.equal(r.journal.replay_equal, true);
  assert.equal(JSON.stringify(r).includes('disk boom'), false);
});

test('fixture prompts are pure local factual/chat, none asks for a tool or PC action', () => {
  assert.ok(CASES.length >= 24);
  for (const c of CASES) assert.equal(/музык|открой|включи|калькулятор|календар|почт|громк|что у меня/i.test(c.text), false, c.text);
});