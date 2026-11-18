'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createPromotionPilot,
  createVaultPromotionStore,
  parseFrontmatter,
} = require('../src/main/memory-promotion');
const notes = require('../src/main/notes');

function makeTempEnv(t, prefix = 'capri-promo-ind-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const vaultDir = path.join(root, 'vault');
  const journalDir = path.join(root, 'journal');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.mkdirSync(journalDir, { recursive: true });
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, vaultDir, journalDir };
}

function listMdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
}

function listNdjsonFiles(journalDir) {
  if (!fs.existsSync(journalDir)) return [];
  return fs.readdirSync(journalDir).filter((name) => name.endsWith('.ndjson'));
}

function makeSyntheticCards() {
  return [
    {
      id: 'base',
      layer: '10_ствол',
      topic: 'synth-port-demo',
      status: 'verified',
      claim: 'Тестовый порт локального макета: 18080 (сигнатура янтарь42).',
      provenance: { source: 'vault_doc', verifiedAt: '2026-11-18T10:00:00Z' },
      evidence: [
        {
          evidence_id: 'ev-synth-01',
          source_class: 'vault_doc',
          source_ref: 'notes/synth-base.md',
          quote: 'тестовый порт локального макета: 18080',
          captured_at: '2026-11-18T10:00:00Z',
          session_id: 'sess-synth-01',
        },
      ],
    },
    {
      id: 'next',
      layer: '10_ствол',
      topic: 'synth-port-demo',
      status: 'pending_review',
      claim: 'Тестовый порт локального макета: 18090 (сигнатура янтарь42).',
      provenance: { source: 'vault_doc', verifiedAt: '2026-11-18T12:00:00Z' },
      evidence: [
        {
          evidence_id: 'ev-synth-02',
          source_class: 'vault_doc',
          source_ref: 'notes/synth-next.md',
          quote: 'тестовый порт локального макета: 18090',
          captured_at: '2026-11-18T12:00:00Z',
          session_id: 'sess-synth-02',
        },
      ],
    },
    {
      id: 'other-card',
      layer: '10_ствол',
      topic: 'synth-other-topic',
      status: 'pending_review',
      claim: 'Другой синтетический факт (сигнатура гранат77).',
      provenance: { source: 'nomad', verifiedAt: '2026-11-18T12:05:00Z' },
      evidence: [
        {
          evidence_id: 'ev-synth-03',
          source_class: 'nomad',
          source_ref: '/content/synth/other',
          quote: 'другой синтетический факт',
          captured_at: '2026-11-18T12:05:00Z',
          session_id: 'sess-synth-03',
        },
      ],
    },
  ];
}

function seedVaultFiles(vaultDir, { baseName = 'base-card.md', nextName = 'next-card.md', layerFolder = '10_Ствол', layer = '10_ствол' } = {}) {
  fs.mkdirSync(path.join(vaultDir, layerFolder), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, 'pending_review'), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, layerFolder, baseName),
    [
      '---',
      'id: base',
      'status: verified',
      `layer: ${layer}`,
      'topic: synth-port-demo',
      'source: vault_doc',
      'source_ref: notes/synth-base.md',
      'quote: "тестовый порт локального макета: 18080"',
      '---',
      'Тестовый порт локального макета: 18080 (маркер янтарь42).',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(vaultDir, 'pending_review', nextName),
    [
      '---',
      'id: next',
      'status: pending_review',
      `layer: ${layer}`,
      'topic: synth-port-demo',
      'source: vault_doc',
      'source_ref: notes/synth-next.md',
      'quote: "тестовый порт локального макета: 18090"',
      '---',
      'Тестовый порт локального макета: 18090 (маркер топаз88).',
      '',
    ].join('\n'),
    'utf8',
  );
}

// =====================================================================
// Group 1: 5 scenarios from forest-promotion-independent-cases.json
// =====================================================================

test('1.1 cancel_preview_no_write: preview + cancel do not write active/archive/NDJSON and block subsequent confirm', (t) => {
  const { vaultDir, journalDir } = makeTempEnv(t, 'capri-case1-');
  seedVaultFiles(vaultDir);
  const store = createVaultPromotionStore({ vaultDir, journalDir });

  const initial = store.read();
  const preview = store.preview('next', 'base');
  assert.equal(preview.candidateId, 'next');
  assert.equal(preview.previousId, 'base');

  // Preview alone leaves disk untouched
  assert.deepEqual(listMdFiles(path.join(vaultDir, '10_Ствол')), ['base-card.md']);
  assert.deepEqual(listMdFiles(path.join(vaultDir, 'pending_review')), ['next-card.md']);
  assert.deepEqual(listMdFiles(path.join(vaultDir, '90_Архив')), []);
  assert.deepEqual(listNdjsonFiles(journalDir), []);

  // Cancel records only audit cancel, keeps active/archive/NDJSON unchanged
  const cancelRes = store.cancel(preview, preview.operationId);
  assert.equal(cancelRes.cancelled, true);
  assert.deepEqual(listMdFiles(path.join(vaultDir, '10_Ствол')), ['base-card.md']);
  assert.deepEqual(listMdFiles(path.join(vaultDir, 'pending_review')), ['next-card.md']);
  assert.deepEqual(listMdFiles(path.join(vaultDir, '90_Архив')), []);
  assert.deepEqual(listNdjsonFiles(journalDir), []);
  assert.deepEqual(store.read(), initial);

  // Subsequent confirm with cancelled operationId must be rejected
  assert.throws(() => store.confirm(preview, preview.operationId), /отменена/);
  assert.deepEqual(listNdjsonFiles(journalDir), []);
  assert.equal(store.read().cards.filter((c) => c.status === 'verified').length, 1);
  assert.equal(store.read().cards.find((c) => c.status === 'verified').id, 'base');
  assert.ok(store.auditEvents().some((e) => e.event === 'confirm_after_cancel' && e.operationId === preview.operationId));
});

test('1.2 explicit_replace_verified_archived_supersedes: next becomes verified with supersedes=base, base archived in 90_Архив/', (t) => {
  const { vaultDir, journalDir } = makeTempEnv(t, 'capri-case2-');
  seedVaultFiles(vaultDir);
  const store = createVaultPromotionStore({ vaultDir, journalDir });

  const preview = store.preview('next', 'base');
  const res = store.confirm(preview, preview.operationId);

  assert.equal(res.next.id, 'next');
  assert.equal(res.next.status, 'verified');
  assert.equal(res.next.supersedes, 'base');
  assert.equal(res.previous.id, 'base');
  assert.equal(res.previous.status, 'archived');
  assert.equal(res.previous.supersededBy, 'next');

  assert.deepEqual(listMdFiles(path.join(vaultDir, '10_Ствол')), ['next-card.md']);
  assert.deepEqual(listMdFiles(path.join(vaultDir, '90_Архив')), ['base-card.md']);
  assert.deepEqual(listMdFiles(path.join(vaultDir, 'pending_review')), []);
  assert.equal(listNdjsonFiles(journalDir).length, 1);

  const activeParsed = parseFrontmatter(fs.readFileSync(path.join(vaultDir, '10_Ствол', 'next-card.md'), 'utf8'));
  const archivedParsed = parseFrontmatter(fs.readFileSync(path.join(vaultDir, '90_Архив', 'base-card.md'), 'utf8'));
  assert.equal(activeParsed.meta.status, 'verified');
  assert.equal(activeParsed.meta.supersedes, 'base');
  assert.equal(archivedParsed.meta.status, 'archived');
  assert.equal(archivedParsed.meta.superseded_by, 'next');
  assert.ok(Array.isArray(archivedParsed.meta.evidence) && archivedParsed.meta.evidence.length >= 1);
});

test('1.3 repeat_operation_id_no_second_record: repeating confirm with same operationId and params creates no second NDJSON or audit event', (t) => {
  const { journalDir } = makeTempEnv(t, 'capri-case3-');
  const pilot = createPromotionPilot({ journalDir, cards: makeSyntheticCards() });

  const pre = pilot.preview('next', 'base');
  const first = pilot.confirm(pre, 'op-repeat-001');
  const ndjsonBefore = listNdjsonFiles(journalDir);
  const auditsBefore = pilot.auditEvents();

  const second = pilot.confirm(pre, 'op-repeat-001');
  assert.deepEqual(second, first);
  assert.deepEqual(listNdjsonFiles(journalDir), ndjsonBefore);
  assert.equal(listNdjsonFiles(journalDir).length, 1);
  assert.deepEqual(pilot.auditEvents(), auditsBefore);
});

test('1.4 failure_before_atomic_publish_keeps_visible_state: failure before NDJSON publish keeps base verified and archive empty', (t) => {
  const { vaultDir, journalDir } = makeTempEnv(t, 'capri-case4-');
  seedVaultFiles(vaultDir);

  const store = createVaultPromotionStore({
    vaultDir,
    journalDir,
    beforeDiskStep: (stage) => {
      if (stage === 'before_journal') throw new Error('simulated failure before atomic publish');
    },
  });

  const before = store.read();
  const pre = store.preview('next', 'base');
  assert.throws(() => store.confirm(pre, pre.operationId), /simulated failure before atomic publish/);

  assert.deepEqual(listNdjsonFiles(journalDir), []);
  assert.deepEqual(listMdFiles(path.join(vaultDir, '10_Ствол')), ['base-card.md']);
  assert.deepEqual(listMdFiles(path.join(vaultDir, 'pending_review')), ['next-card.md']);
  assert.deepEqual(listMdFiles(path.join(vaultDir, '90_Архив')), []);
  assert.deepEqual(store.read(), before);

  // Also verify via createPromotionPilot beforePublish hook (temp file left behind is ignored)
  const pilotJournal = path.join(path.dirname(journalDir), 'pilot-journal');
  const pilot = createPromotionPilot({
    journalDir: pilotJournal,
    cards: makeSyntheticCards(),
    beforePublish: () => {
      throw new Error('simulated crash before rename');
    },
  });
  const pilotPre = pilot.preview('next', 'base');
  assert.throws(() => pilot.confirm(pilotPre, 'op-fail-pilot'), /simulated crash before rename/);
  assert.deepEqual(listNdjsonFiles(pilotJournal), []);
  assert.equal(pilot.read().cards.find((c) => c.id === 'base').status, 'verified');
  assert.equal(pilot.read().cards.find((c) => c.id === 'next').status, 'pending_review');
});

test('1.5 stale_preview_does_not_overwrite_newer_version: stale preview is rejected, logs stale_preview, and leaves next active', (t) => {
  const { journalDir } = makeTempEnv(t, 'capri-case5-');
  const cards = [
    ...makeSyntheticCards(),
    {
      id: 'newer-cand',
      layer: '10_ствол',
      topic: 'synth-port-demo',
      status: 'pending_review',
      claim: 'Ещё более новая формулировка.',
      provenance: { source: 'vault_doc' },
      evidence: [{ source_ref: 'notes/newer.md', quote: 'newer quote' }],
    },
  ];
  const pilot = createPromotionPilot({ journalDir, cards });

  // Stale preview built against base -> next, and another stale preview base -> newer-cand
  const stalePreview = pilot.preview('newer-cand', 'base');
  const freshPreview = pilot.preview('next', 'base');
  pilot.confirm(freshPreview, 'op-fresh-001');

  assert.throws(() => pilot.confirm(stalePreview, 'op-stale-002'), /Устаревший preview/);
  const state = pilot.read();
  assert.equal(state.cards.find((c) => c.id === 'next').status, 'verified');
  assert.equal(state.cards.find((c) => c.id === 'base').status, 'archived');
  assert.equal(state.cards.find((c) => c.id === 'newer-cand').status, 'pending_review');
  assert.equal(listNdjsonFiles(journalDir).length, 1);
  assert.ok(pilot.auditEvents().some((e) => e.event === 'stale_preview' && e.operationId === 'op-stale-002'));
});

// =====================================================================
// Group 2: 3 scenarios from forest-promotion-gemini-cases.json
// =====================================================================

test('2.1 promo-idempotency-key-payload-mismatch: reusing operationId with different card is rejected and preserves next', (t) => {
  const { journalDir } = makeTempEnv(t, 'capri-gemini1-');
  const pilot = createPromotionPilot({ journalDir, cards: makeSyntheticCards() });

  const pre1 = pilot.preview('next', 'base');
  pilot.confirm(pre1, 'op-promote-001');

  assert.throws(
    () => pilot.confirm({ ...pre1, candidateId: 'other-card', previousId: null }, 'op-promote-001'),
    /Конфликт operationId/,
  );

  const state = pilot.read();
  assert.equal(state.cards.find((c) => c.id === 'next').status, 'verified');
  assert.equal(state.cards.find((c) => c.id === 'other-card').status, 'pending_review');
  assert.equal(listNdjsonFiles(journalDir).length, 1);
  assert.ok(pilot.auditEvents().some((e) => e.event === 'idempotency_conflict' && e.operationId === 'op-promote-001'));
});

test('2.2 promo-invalid-tor-origin: Tor/.onion source and spoofed https+Tor origin are rejected and preserve base', (t) => {
  const { journalDir } = makeTempEnv(t, 'capri-gemini2-');
  const cards = [
    ...makeSyntheticCards(),
    {
      id: 'cand-onion',
      layer: '10_ствол',
      topic: 'synth-port-demo',
      status: 'pending_review',
      claim: 'Текст из onion.',
      provenance: { source: 'tor' },
      evidence: [{ source_ref: 'http://validonionservice2345.onion/page', quote: 'onion quote' }],
    },
    {
      id: 'cand-onion-only-url',
      layer: '10_ствол',
      topic: 'synth-port-demo',
      status: 'pending_review',
      claim: 'Текст со ссылкой на onion без явного флага.',
      provenance: { source: 'web' },
      evidence: [{ link: 'https://hiddenservice777.onion/info', quote: 'hidden quote' }],
    },
    {
      id: 'cand-spoofed-https-tor',
      layer: '10_ствол',
      topic: 'synth-port-demo',
      status: 'pending_review',
      claim: 'Подделанное происхождение: https + tor_vault.',
      tor: true,
      provenance: { source: 'tor_vault' },
      evidence: [{ source_ref: 'https://clearnet.example.com/article', quote: 'clearnet quote' }],
    },
  ];
  const pilot = createPromotionPilot({ journalDir, cards });

  assert.throws(() => pilot.preview('cand-onion', 'base'), /Tor|origin/i);
  assert.throws(() => pilot.preview('cand-onion-only-url', 'base'), /Tor|origin/i);
  assert.throws(() => pilot.preview('cand-spoofed-https-tor', 'base'), /origin|Tor/i);

  const validPre = pilot.preview('next', 'base');
  assert.throws(() => pilot.confirm({ ...validPre, candidateId: 'cand-spoofed-https-tor' }, 'op-promote-002'), /origin|Tor/i);

  const state = pilot.read();
  assert.equal(state.cards.find((c) => c.id === 'base').status, 'verified');
  assert.equal(listNdjsonFiles(journalDir).length, 0);
  const invalidAudits = pilot.auditEvents().filter((e) => e.event === 'invalid_origin');
  assert.equal(invalidAudits.length, 4);
});

test('2.3 promo-lost-response-after-commit: retry after dropped commit response succeeds idempotently with no duplicate events', (t) => {
  const { vaultDir, journalDir } = makeTempEnv(t, 'capri-gemini3-');
  seedVaultFiles(vaultDir);

  const store = createVaultPromotionStore({ vaultDir, journalDir });
  const pre = store.preview('next', 'base');

  // Simulate server commit succeeding while client lost the response
  const serverCommitted = store.confirm(pre, 'op-promote-003');
  const ndjsonAfterCommit = listNdjsonFiles(journalDir);
  const auditsAfterCommit = store.auditEvents();

  // Client retries with same preview and same operationId (even through a fresh store instance)
  const freshStore = createVaultPromotionStore({ vaultDir, journalDir });
  const retried = freshStore.confirm(pre, 'op-promote-003');

  assert.deepEqual(retried, serverCommitted);
  assert.deepEqual(listNdjsonFiles(journalDir), ndjsonAfterCommit);
  assert.equal(listNdjsonFiles(journalDir).length, 1);
  assert.deepEqual(freshStore.auditEvents(), auditsAfterCommit);
  assert.equal(freshStore.read().cards.find((c) => c.id === 'next').status, 'verified');
});

// =====================================================================
// Group 3: Mid-write crash across 3 Markdown files (createVaultPromotionStore)
// =====================================================================

for (const crashStage of ['before_old_active_unlink', 'before_active_write', 'before_candidate_unlink']) {
  test(`3. mid-write crash at ${crashStage}: searchVault never sees 2 verified cards, reconcile() restores consistent state`, (t) => {
    const { vaultDir, journalDir } = makeTempEnv(t, `capri-crash-${crashStage}-`);
    // Use distinct filenames so active/archive/pending are 3 separate Markdown files
    seedVaultFiles(vaultDir, {
      baseName: 'base-card.md',
      nextName: 'next-card.md',
      layerFolder: '10_Ствол',
      layer: '10_ствол',
    });

    let crashedOnce = false;
    const crashingStore = createVaultPromotionStore({
      vaultDir,
      journalDir,
      beforeDiskStep: (stage) => {
        if (!crashedOnce && stage === crashStage) {
          crashedOnce = true;
          throw new Error(`crash injected at ${crashStage}`);
        }
      },
    });

    const pre = crashingStore.preview('next', 'base');
    assert.throws(() => crashingStore.confirm(pre, `op-${crashStage}`), new RegExp(crashStage));

    // Even before reconcile(), raw disk never has two verified active files simultaneously
    const rawActiveFiles = listMdFiles(path.join(vaultDir, '10_Ствол'));
    const rawVerifiedCount = rawActiveFiles.filter((file) => {
      const parsed = parseFrontmatter(fs.readFileSync(path.join(vaultDir, '10_Ствол', file), 'utf8'));
      return parsed.meta.status === 'verified';
    }).length;
    assert.ok(rawVerifiedCount <= 1, `Expected <= 1 verified card on raw disk at ${crashStage}, got ${rawVerifiedCount}`);

    // searchVault with journalDir auto-reconciles and never sees two verified cards
    const activeHitsDuringRecovery = notes.searchVault(path.join(vaultDir, 'Capri'), 'тестовый порт', 10, { journalDir });
    assert.equal(activeHitsDuringRecovery.length, 1);
    assert.equal(activeHitsDuringRecovery[0].file, path.join('10_Ствол', 'next-card.md'));

    // Reopening store + explicit reconcile() guarantees converged disk and state
    const recoveredStore = createVaultPromotionStore({ vaultDir, journalDir });
    recoveredStore.reconcile();
    const state = recoveredStore.read();

    assert.equal(state.cards.filter((c) => c.status === 'verified').length, 1);
    assert.equal(state.cards.find((c) => c.id === 'next').status, 'verified');
    assert.equal(state.cards.find((c) => c.id === 'base').status, 'archived');
    assert.deepEqual(listMdFiles(path.join(vaultDir, '10_Ствол')), ['next-card.md']);
    assert.deepEqual(listMdFiles(path.join(vaultDir, '90_Архив')), ['base-card.md']);
    assert.deepEqual(listMdFiles(path.join(vaultDir, 'pending_review')), []);

    // Normal searchVault finds next (топаз88) and not base (янтарь42)
    const nextSearch = notes.searchVault(path.join(vaultDir, 'Capri'), 'топаз88', 5, { journalDir });
    assert.deepEqual(nextSearch.map((h) => h.file), [path.join('10_Ствол', 'next-card.md')]);
    assert.deepEqual(notes.searchVault(path.join(vaultDir, 'Capri'), 'янтарь42', 5, { journalDir }), []);

    // History searchVault finds base (янтарь42) and not next (топаз88)
    const historySearch = notes.searchVault(path.join(vaultDir, 'Capri'), 'янтарь42', 5, { history: true, journalDir });
    assert.deepEqual(historySearch.map((h) => h.file), [path.join('90_Архив', 'base-card.md')]);
    assert.deepEqual(notes.searchVault(path.join(vaultDir, 'Capri'), 'топаз88', 5, { history: true, journalDir }), []);
  });
}

// =====================================================================
// Group 4: Reversible targeted rollback
// =====================================================================

test('4. targeted rollback archives next with full evidence, restores base to verified, is idempotent, and updates searchVault', (t) => {
  const { vaultDir, journalDir } = makeTempEnv(t, 'capri-rollback-');
  seedVaultFiles(vaultDir, {
    baseName: 'base-card.md',
    nextName: 'next-card.md',
    layerFolder: '20_Крона',
    layer: '20_крона',
  });

  const store = createVaultPromotionStore({ vaultDir, journalDir });
  const pre = store.preview('next', 'base');
  const promoOpId = pre.operationId;
  const promoted = store.confirm(pre, promoOpId);
  const expectedMergedEvidence = promoted.next.evidence;
  assert.equal(expectedMergedEvidence.length, 2);

  // Perform targeted rollback
  const rbOpId = 'op-rb-independent-001';
  const rb1 = store.rollback(rbOpId, promoOpId);
  assert.equal(rb1.archived.id, 'next');
  assert.equal(rb1.archived.status, 'archived');
  assert.equal(rb1.archived.rollbackOf, rbOpId);
  assert.deepEqual(rb1.archived.evidence, expectedMergedEvidence);
  assert.equal(rb1.restored.id, 'base');
  assert.equal(rb1.restored.status, 'verified');

  // Verify Markdown files on disk
  assert.deepEqual(listMdFiles(path.join(vaultDir, '20_Крона')), ['base-card.md']);
  assert.deepEqual(listMdFiles(path.join(vaultDir, '90_Архив')), ['next-card.md']);
  const archivedNextMd = parseFrontmatter(fs.readFileSync(path.join(vaultDir, '90_Архив', 'next-card.md'), 'utf8'));
  const restoredBaseMd = parseFrontmatter(fs.readFileSync(path.join(vaultDir, '20_Крона', 'base-card.md'), 'utf8'));
  assert.equal(archivedNextMd.meta.status, 'archived');
  assert.equal(archivedNextMd.meta.rollback_of, rbOpId);
  assert.deepEqual(archivedNextMd.meta.evidence, expectedMergedEvidence);
  assert.equal(restoredBaseMd.meta.status, 'verified');

  // Repeated rollback with same rbOpId is idempotent (no 3rd NDJSON record)
  const ndjsonBeforeRepeat = listNdjsonFiles(journalDir);
  assert.equal(ndjsonBeforeRepeat.length, 2);
  const rb2 = store.rollback(rbOpId, promoOpId);
  assert.deepEqual(rb2, rb1);
  assert.deepEqual(listNdjsonFiles(journalDir), ndjsonBeforeRepeat);

  // searchVault sees base again in normal mode, and next in history mode
  assert.deepEqual(
    notes.searchVault(path.join(vaultDir, 'Capri'), 'янтарь42', 5, { journalDir }).map((r) => r.file),
    [path.join('20_Крона', 'base-card.md')],
  );
  assert.deepEqual(
    notes.searchVault(path.join(vaultDir, 'Capri'), 'топаз88', 5, { journalDir }),
    [],
  );
  assert.deepEqual(
    notes.searchVault(path.join(vaultDir, 'Capri'), 'топаз88', 5, { history: true, journalDir }).map((r) => r.file),
    [path.join('90_Архив', 'next-card.md')],
  );
  assert.deepEqual(
    notes.searchVault(path.join(vaultDir, 'Capri'), 'янтарь42', 5, { history: true, journalDir }),
    [],
  );
});
