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
  serializeFrontmatter,
} = require('../src/main/memory-promotion');
const notes = require('../src/main/notes');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'capri-mem-promo-'));
}

function makeCards() {
  return [
    {
      id: 'card-old-1',
      layer: '10_ствол',
      topic: 'git-stash',
      status: 'verified',
      claim: 'Старая формулировка правила.',
      provenance: { source: 'nomad', verifiedAt: '2026-11-18T10:00:00Z' },
      evidence: [{ book: 'devdocs_en_git', link: '/content/git/stash', quote: 'Old quote' }],
    },
    {
      id: 'card-cand-1',
      layer: '10_ствол',
      topic: 'git-stash',
      status: 'candidate',
      claim: 'Уточнённая формулировка правила.',
      provenance: { source: 'nomad', verifiedAt: '2026-11-18T12:00:00Z' },
      evidence: [{ book: 'devdocs_en_git', link: '/content/git/stash#push', quote: 'New quote' }],
    },
    {
      id: 'card-cand-other-layer',
      layer: '20_крона',
      topic: 'git-stash',
      status: 'candidate',
      claim: 'Другой слой.',
      provenance: { source: 'obsidian' },
      evidence: [{ link: 'notes/a.md', quote: 'Crown quote' }],
    },
    {
      id: 'card-cand-other-topic',
      layer: '10_ствол',
      topic: 'bash-pipes',
      status: 'candidate',
      claim: 'Другая тема.',
      provenance: { source: 'nomad' },
      evidence: [{ book: 'bash', link: '/content/bash/pipes', quote: 'Pipe quote' }],
    },
    {
      id: 'card-cand-no-prov',
      layer: '10_ствол',
      topic: 'git-stash',
      status: 'candidate',
      claim: 'Без провенанса.',
      evidence: [],
    },
    {
      id: 'card-cand-tor',
      layer: '10_ствол',
      topic: 'git-stash',
      status: 'pending_review',
      claim: 'Из Tor.',
      provenance: { source: 'tor' },
      evidence: [{ link: 'http://exampleonionabcdefgh.onion/doc', quote: 'Tor quote' }],
    },
  ];
}

function runSyntheticClickFlow(pilot, candidateId, previousId, operationId, { approved }) {
  const pre = pilot.preview(candidateId, previousId);
  if (!approved) return { cancelled: true, preview: pre };
  return { cancelled: false, preview: pre, committed: pilot.confirm(pre, operationId) };
}

test('preview does not mutate inputs or write files; cancel leaves state unchanged', () => {
  const journalDir = makeTempDir();
  const inputCards = makeCards();
  const snapshotBefore = structuredClone(inputCards);
  const pilot = createPromotionPilot({ journalDir, cards: inputCards });

  const initial = pilot.read();
  const res = runSyntheticClickFlow(pilot, 'card-cand-1', 'card-old-1', 'op-cancel', { approved: false });

  assert.equal(res.cancelled, true);
  assert.equal(res.preview.version, initial.version);
  assert.equal(res.preview.previous.id, 'card-old-1');
  assert.equal(res.preview.previous.status, 'verified');
  assert.equal(res.preview.next.id, 'card-cand-1');
  assert.equal(res.preview.next.supersedes, 'card-old-1');
  assert.equal(res.preview.next.evidence.length, 2);
  assert.deepEqual(inputCards, snapshotBefore);
  assert.deepEqual(fs.readdirSync(journalDir), []);
  assert.deepEqual(pilot.read(), initial);
});

test('approved click publishes immutable NDJSON atomically, preserves both evidence, archives previous, and recovers across restart', () => {
  const journalDir = makeTempDir();
  const inputCards = makeCards();
  const pilot = createPromotionPilot({ journalDir, cards: inputCards });

  const { committed } = runSyntheticClickFlow(pilot, 'card-cand-1', 'card-old-1', 'op-001', { approved: true });
  assert.equal(committed.previous.status, 'archived');
  assert.equal(committed.previous.supersededBy, 'card-cand-1');
  assert.equal(committed.next.status, 'verified');
  assert.equal(committed.next.supersedes, 'card-old-1');
  assert.equal(committed.next.evidence.length, 2);
  assert.ok(committed.next.evidence.some((e) => e.cardId === 'card-cand-1' && e.quote === 'New quote'));
  assert.ok(committed.next.evidence.some((e) => e.cardId === 'card-old-1' && e.quote === 'Old quote'));

  const files = fs.readdirSync(journalDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^000001-.*\.ndjson$/);

  // Fresh instance derives identical state and enforces single verified card in the lineage
  const reloaded = createPromotionPilot({ journalDir, cards: makeCards() });
  const state = reloaded.read();
  assert.equal(state.version, committed.version);
  const oldCard = state.cards.find((c) => c.id === 'card-old-1');
  const newCard = state.cards.find((c) => c.id === 'card-cand-1');
  assert.equal(oldCard.status, 'archived');
  assert.equal(newCard.status, 'verified');
  assert.equal(state.cards.filter((c) => c.topic === 'git-stash' && c.status === 'verified').length, 1);
});

test('validates same layer/topic, provenance, and blocks Tor sources', () => {
  const journalDir = makeTempDir();
  const pilot = createPromotionPilot({ journalDir, cards: makeCards() });

  assert.throws(() => pilot.preview('card-cand-other-layer', 'card-old-1'), /Слои/);
  assert.throws(() => pilot.preview('card-cand-other-topic', 'card-old-1'), /Темы/);
  assert.throws(() => pilot.preview('card-cand-no-prov', 'card-old-1'), /провенанс/);
  assert.throws(() => pilot.preview('card-cand-tor', 'card-old-1'), /Tor/);

  // Forged preview passed directly to confirm is also rejected
  const validPreview = pilot.preview('card-cand-1', 'card-old-1');
  assert.throws(
    () => pilot.confirm({ ...validPreview, candidateId: 'card-cand-tor' }, 'op-tor-bypass'),
    /Tor/,
  );
  assert.deepEqual(fs.readdirSync(journalDir).filter((f) => f.endsWith('.ndjson')), []);
  assert.ok(pilot.auditEvents().some((e) => e.event === 'invalid_origin'));
});

test('error before publish hides partial state and ignores temp files; retry succeeds cleanly', () => {
  const journalDir = makeTempDir();
  let shouldFail = true;
  const pilot = createPromotionPilot({
    journalDir,
    cards: makeCards(),
    beforePublish: () => {
      if (shouldFail) throw new Error('simulated crash before rename');
    },
  });

  const beforeState = pilot.read();
  const pre = pilot.preview('card-cand-1', 'card-old-1');
  assert.throws(() => pilot.confirm(pre, 'op-retry-1'), /simulated crash/);

  // Leftover .tmp file exists on disk, yet read() ignores it and preserves old verified card
  const afterCrashEntries = fs.readdirSync(journalDir);
  assert.ok(afterCrashEntries.some((name) => name.endsWith('.tmp')));
  assert.equal(afterCrashEntries.some((name) => name.endsWith('.ndjson')), false);
  assert.deepEqual(pilot.read(), beforeState);

  // Recovery retry with same operationId publishes cleanly
  shouldFail = false;
  const committed = pilot.confirm(pre, 'op-retry-1');
  assert.equal(committed.next.status, 'verified');
  assert.equal(pilot.read().cards.find((c) => c.id === 'card-old-1').status, 'archived');
});

test('idempotency returns same result without extra record; mismatched retry and stale preview fail', () => {
  const journalDir = makeTempDir();
  const pilot = createPromotionPilot({ journalDir, cards: makeCards() });

  const pre1 = pilot.preview('card-cand-1', 'card-old-1');
  const first = pilot.confirm(pre1, 'op-idem');

  // Matching retry after publication (even using pre1.version before op-idem) is idempotent
  const second = pilot.confirm(pre1, 'op-idem');
  assert.deepEqual(second, first);
  assert.equal(fs.readdirSync(journalDir).filter((f) => f.endsWith('.ndjson')).length, 1);

  // Mismatched operationId reuse is rejected
  assert.throws(
    () => pilot.confirm({ ...pre1, candidateId: 'card-cand-other-topic' }, 'op-idem'),
    /Конфликт operationId/,
  );
  assert.throws(
    () => pilot.confirm({ ...pre1, version: 'v99:deadbeef' }, 'op-idem'),
    /Конфликт operationId/,
  );

  // Stale preview with a new operationId is rejected
  assert.throws(() => pilot.confirm(pre1, 'op-stale-new'), /Устаревший preview/);
  assert.ok(pilot.auditEvents().some((e) => e.event === 'idempotency_conflict'));
  assert.ok(pilot.auditEvents().some((e) => e.event === 'stale_preview'));
});

test('cancel records audit event and blocks late confirm; primary promotion works without replacement when topic is free', () => {
  const journalDir = makeTempDir();
  const base = makeCards();
  base.push({
    id: 'card-primary-1',
    layer: '20_крона',
    topic: 'new-topic',
    status: 'pending_review',
    claim: 'Новый факт без старой карточки.',
    provenance: { source: 'nomad' },
    evidence: [{ book: 'manual', link: '/content/manual/x', quote: 'Primary quote' }],
  });
  const pilot = createPromotionPilot({ journalDir, cards: base });

  const preReplace = pilot.preview('card-cand-1', 'card-old-1');
  const cancelRes = pilot.cancel(preReplace, 'op-cancelled-1');
  assert.equal(cancelRes.cancelled, true);
  assert.throws(() => pilot.confirm(preReplace, 'op-cancelled-1'), /отменена/);
  assert.equal(pilot.read().cards.find((c) => c.id === 'card-old-1').status, 'verified');

  // Topic already exists in 10_ствол -> previousId=null is rejected
  assert.throws(() => pilot.preview('card-cand-1', null), /требуется замена/);

  // Free topic in 20_крона -> previousId=null succeeds
  const prePrimary = pilot.preview('card-primary-1', null);
  assert.equal(prePrimary.previousId, null);
  const committedPrimary = pilot.confirm(prePrimary, 'op-primary-1');
  assert.equal(committedPrimary.next.status, 'verified');
  assert.equal(committedPrimary.previous, null);

  // Origin spoofing (tor_vault mixed with https URL) is blocked and audited
  const spoofPilot = createPromotionPilot({
    journalDir: makeTempDir(),
    cards: [{
      id: 'card-spoof',
      layer: '10_ствол',
      topic: 't',
      status: 'pending_review',
      claim: 'Поддельный origin.',
      provenance: { source: 'tor_vault' },
      evidence: [{ link: 'https://clearnet.example/x', quote: 'spoof' }],
    }],
  });
  assert.throws(() => spoofPilot.preview('card-spoof', null), /origin/i);
  assert.ok(spoofPilot.auditEvents().some((e) => e.event === 'invalid_origin'));
});

test('rollback restores previous card, archives erroneous new card keeping evidence, and is idempotent', () => {
  const journalDir = makeTempDir();
  const pilot = createPromotionPilot({ journalDir, cards: makeCards() });

  const pre = pilot.preview('card-cand-1', 'card-old-1');
  pilot.confirm(pre, 'op-fwd-1');

  const rb1 = pilot.rollback('op-rb-1', 'op-fwd-1');
  assert.equal(rb1.archived.id, 'card-cand-1');
  assert.equal(rb1.archived.status, 'archived');
  assert.equal(rb1.archived.rollbackOf, 'op-rb-1');
  assert.equal(rb1.archived.evidence.length, 2);
  assert.equal(rb1.restored.id, 'card-old-1');
  assert.equal(rb1.restored.status, 'verified');

  // Retry with same rollbackOperationId is idempotent; second rollback with different id fails
  assert.deepEqual(pilot.rollback('op-rb-1', 'op-fwd-1'), rb1);
  assert.throws(() => pilot.rollback('op-rb-2', 'op-fwd-1'), /уже откачена/);
});

test('YAML frontmatter round-trip handles CRLF, BOM, colons, quotes, hashes, body rules, and preserves unknown fields', () => {
  const raw = '\uFEFF---\r\nid: card-yaml-1\r\nstatus: verified\r\nlayer: 10_ствол\r\ntopic: "yaml: edge #1"\r\ncustom_owner: "Дарья \\"A\\""\r\n---\r\nТекст карточки\r\n\r\n---\r\n\r\nВторая строка после разделителя.\r\n';
  const parsed = parseFrontmatter(raw);
  assert.equal(parsed.meta.id, 'card-yaml-1');
  assert.equal(parsed.meta.topic, 'yaml: edge #1');
  assert.equal(parsed.meta.custom_owner, 'Дарья "A"');
  assert.match(parsed.body, /---\n\nВторая строка/);

  const serialized = serializeFrontmatter(parsed.meta, parsed.body, parsed.keyOrder);
  assert.equal(serialized.startsWith('---\n'), true);
  assert.equal(serialized.includes('\r'), false);
  const reparsed = parseFrontmatter(serialized);
  assert.deepEqual(reparsed.meta, parsed.meta);
  assert.equal(reparsed.body, parsed.body);
});

test('createVaultPromotionStore executes WAL steps cleanly, recovers from crash at every stage, and integrates with notes.searchVault', (t) => {
  const makeVaultFixture = () => {
    const vault = makeTempDir();
    const journalDir = makeTempDir();
    t.after(() => {
      fs.rmSync(vault, { recursive: true, force: true });
      fs.rmSync(journalDir, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(vault, '10_Ствол'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'pending_review'), { recursive: true });
    fs.writeFileSync(
      path.join(vault, '10_Ствол', 'Порт макета.md'),
      '\uFEFF---\r\nid: card-v1\r\nstatus: verified\r\nlayer: 10_ствол\r\ntopic: demo-port\r\nsource: vault_doc\r\nlink: notes/v1.md\r\nquote: порт 18080\r\ncustom_note: keep-me\r\n---\r\nЛокальный порт макета опал99 равен 18080.\r\n',
    );
    fs.writeFileSync(
      path.join(vault, 'pending_review', 'Порт макета.md'),
      '---\nid: card-v2\nstatus: candidate\nlayer: 10_ствол\ntopic: demo-port\nsource: vault_doc\nlink: notes/v2.md\nquote: порт 18090\n---\nЛокальный порт макета опал99 равен 18090.\n',
    );
    return { vault, journalDir };
  };

  // Crash before journal leaves disk untouched
  {
    const { vault, journalDir } = makeVaultFixture();
    const store = createVaultPromotionStore({
      vaultDir: vault,
      journalDir,
      beforeDiskStep: (stage) => {
        if (stage === 'before_journal') throw new Error('crash before_journal');
      },
    });
    const pre = store.preview('card-v2', 'card-v1');
    assert.throws(() => store.confirm(pre, 'op-bj'), /before_journal/);
    assert.equal(fs.existsSync(path.join(vault, '10_Ствол', 'Порт макета.md')), true);
    assert.equal(fs.existsSync(path.join(vault, 'pending_review', 'Порт макета.md')), true);
    assert.equal(fs.existsSync(path.join(vault, '90_Архив')), false);
  }

  // Crash at every physical WAL step recovers via reconcile() without double verified cards
  for (const crashStage of ['before_archive_write', 'before_old_active_unlink', 'before_active_write', 'before_candidate_unlink']) {
    const { vault, journalDir } = makeVaultFixture();
    let failOnce = true;
    const crashing = createVaultPromotionStore({
      vaultDir: vault,
      journalDir,
      beforeDiskStep: (stage) => {
        if (failOnce && stage === crashStage) {
          failOnce = false;
          throw new Error(`simulated crash at ${crashStage}`);
        }
      },
    });
    const pre = crashing.preview('card-v2', 'card-v1');
    assert.throws(() => crashing.confirm(pre, `op-${crashStage}`), new RegExp(crashStage));

    // Reopen fresh store -> reconcile() completes promotion deterministically
    const recovered = createVaultPromotionStore({ vaultDir: vault, journalDir });
    const state = recovered.read();
    const activeSameTopic = state.cards.filter((c) => c.topic === 'demo-port' && c.status === 'verified');
    assert.equal(activeSameTopic.length, 1);
    assert.equal(activeSameTopic[0].id, 'card-v2');
    assert.equal(activeSameTopic[0].evidence.length, 2);
    assert.equal(state.cards.find((c) => c.id === 'card-v1').status, 'archived');
    assert.equal(fs.existsSync(path.join(vault, 'pending_review', 'Порт макета.md')), false);

    // notes.searchVault sees only the promoted verified card in active mode, and old in history mode
    assert.deepEqual(
      notes.searchVault(path.join(vault, 'Capri'), 'опал99', 5, { journalDir }).map((r) => r.file),
      [path.join('10_Ствол', 'Порт макета.md')],
    );
    assert.deepEqual(
      notes.searchVault(path.join(vault, 'Capri'), 'опал99', 5, { history: true, journalDir }).map((r) => r.file),
      [path.join('90_Архив', 'Порт макета.md')],
    );

    // Crash during rollback recovers cleanly via reconcile() too
    if (crashStage === 'before_active_write') {
      const rbCrash = createVaultPromotionStore({
        vaultDir: vault,
        journalDir,
        beforeDiskStep: (stage) => {
          if (stage === 'before_rollback_restore_write') throw new Error('crash rollback restore');
        },
      });
      assert.throws(() => rbCrash.rollback('op-rb-crash', `op-${crashStage}`), /rollback restore/);
      const rbRecovered = createVaultPromotionStore({ vaultDir: vault, journalDir });
      const rbState = rbRecovered.read();
      assert.equal(rbState.cards.find((c) => c.id === 'card-v1').status, 'verified');
      assert.equal(rbState.cards.find((c) => c.id === 'card-v2').status, 'archived');
      assert.equal(rbState.cards.find((c) => c.id === 'card-v2').evidence.length, 2);
    }
  }
});
