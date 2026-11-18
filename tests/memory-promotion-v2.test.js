'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const promotion = require('../src/main/memory-promotion');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-promo-v2-'));
}

function makeCard(overrides = {}) {
  return {
    id: 'card-1',
    layer: '20_крона',
    topic: 'architecture',
    status: 'candidate',
    claim: 'Default claim',
    provenance: { source: 'local_nomad' },
    evidence: [{ source: 'local_nomad', link: 'nomad://book/1', quote: 'verified quote' }],
    ...overrides,
  };
}

function writeVaultCard(vaultDir, relPath, meta, body) {
  const full = path.join(vaultDir, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, promotion.serializeFrontmatter(meta, body), 'utf8');
}

describe('memory-promotion v2 (branching, cancel guard, audit tail, conflicted)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Branch A -> B -> rollback(B to A) -> C -> rollback(C to A) preserves supersedes invariant in pilot and vault', () => {
    const cardA = makeCard({ id: 'card-A', status: 'verified', claim: 'v1' });
    const cardB = makeCard({ id: 'card-B', status: 'pending_review', claim: 'v2' });
    const cardC = makeCard({ id: 'card-C', status: 'pending_review', claim: 'v3' });

    const pilot = promotion.createPromotionPilot({
      journalDir: path.join(tmpDir, 'pilot-journal'),
      cards: [cardA, cardB, cardC],
    });

    const prevB = pilot.preview('card-B', 'card-A');
    pilot.confirm(prevB, 'op-B');

    // Rolling back A while superseded by B is rejected
    assert.throws(() => pilot.rollback('rb-bad', 'op-B-nonexistent'), /не найдена/);

    pilot.rollback('rb-B', 'op-B');
    const afterRbB = pilot.read().cards;
    const aAfterRbB = afterRbB.find((c) => c.id === 'card-A');
    const bAfterRbB = afterRbB.find((c) => c.id === 'card-B');
    assert.equal(aAfterRbB.status, 'verified');
    assert.equal(aAfterRbB.restoredByRollbackId, 'rb-B');
    assert.equal(bAfterRbB.status, 'archived');
    assert.equal(bAfterRbB.rollbackOf, 'rb-B');

    const prevC = pilot.preview('card-C', 'card-A');
    pilot.confirm(prevC, 'op-C');

    const afterC = pilot.read().cards;
    const aAfterC = afterC.find((c) => c.id === 'card-A');
    const cAfterC = afterC.find((c) => c.id === 'card-C');
    assert.equal(cAfterC.status, 'verified');
    assert.equal(cAfterC.supersedes, 'card-A');
    assert.equal(aAfterC.status, 'archived');
    assert.equal(aAfterC.supersededBy, 'card-C');
    assert.equal(aAfterC.restoredByRollbackId, undefined);

    pilot.rollback('rb-C', 'op-C');
    const afterRbC = pilot.read().cards;
    const aFinal = afterRbC.find((c) => c.id === 'card-A');
    assert.equal(aFinal.status, 'verified');
    assert.equal(aFinal.restoredByRollbackId, 'rb-C');

    // Vault disk store mode + reconcile
    const vaultDir = path.join(tmpDir, 'vault');
    const journalDir = path.join(tmpDir, 'vault-journal');
    writeVaultCard(vaultDir, '20_Крона/card-A.md', {
      id: 'card-A', status: 'verified', layer: '20_крона', topic: 'architecture',
      source: 'local_nomad', link: 'nomad://book/1', quote: 'quote A',
    }, 'v1');
    writeVaultCard(vaultDir, 'pending_review/card-B.md', {
      id: 'card-B', status: 'pending_review', layer: '20_крона', topic: 'architecture',
      source: 'local_nomad', link: 'nomad://book/2', quote: 'quote B',
    }, 'v2');
    writeVaultCard(vaultDir, 'pending_review/card-C.md', {
      id: 'card-C', status: 'pending_review', layer: '20_крона', topic: 'architecture',
      source: 'local_nomad', link: 'nomad://book/3', quote: 'quote C',
    }, 'v3');

    const store = promotion.createVaultPromotionStore({ vaultDir, journalDir });
    const vPrevB = store.preview('card-B', 'card-A');
    store.confirm(vPrevB, 'v-op-B');
    store.rollback('v-rb-B', 'v-op-B');

    const vPrevC = store.preview('card-C', 'card-A');
    store.confirm(vPrevC, 'v-op-C');

    const reopened = promotion.createVaultPromotionStore({ vaultDir, journalDir });
    reopened.reconcile();
    const cardsAfterReconcile = reopened.read().cards;
    assert.equal(cardsAfterReconcile.find((c) => c.id === 'card-C').status, 'verified');
    assert.equal(cardsAfterReconcile.find((c) => c.id === 'card-C').supersedes, 'card-A');
    assert.equal(cardsAfterReconcile.find((c) => c.id === 'card-A').status, 'archived');
    assert.equal(cardsAfterReconcile.find((c) => c.id === 'card-A').restoredByRollbackId, undefined);

    reopened.rollback('v-rb-C', 'v-op-C');
    const finalVaultCards = reopened.read().cards;
    assert.equal(finalVaultCards.find((c) => c.id === 'card-A').status, 'verified');
    assert.equal(finalVaultCards.find((c) => c.id === 'card-A').restoredByRollbackId, 'v-rb-C');
  });

  it('2. cancel() validates opId and enforces single-writer guard in pilot and vault', () => {
    const journalDir = path.join(tmpDir, 'cancel-journal');
    let pilot;
    pilot = promotion.createPromotionPilot({
      journalDir,
      cards: [makeCard({ id: 'c1', status: 'pending_review' })],
      beforePublish: () => {
        assert.throws(() => pilot.cancel({ candidateId: 'c1' }, 'op-reentrant'), /single-writer/);
      },
    });

    assert.throws(() => pilot.cancel(null, ''), /operationId/);
    assert.throws(() => pilot.cancel(null, 'bad\nid'), /operationId/);

    const prev = pilot.preview('c1');
    // Re-entrant cancel during confirm hits single-writer guard
    pilot.confirm(prev, 'op-confirm-1');

    const res = pilot.cancel({ candidateId: 'c1' }, 'op-cancel-1');
    assert.equal(res.cancelled, true);
    assert.equal(pilot.cancel({ candidateId: 'c1' }, 'op-cancel-1').cancelled, true);

    // Vault store re-entrant cancel guard
    const vaultDir = path.join(tmpDir, 'cancel-vault');
    const vJournal = path.join(tmpDir, 'cancel-vjournal');
    writeVaultCard(vaultDir, 'pending_review/c1.md', {
      id: 'c1', status: 'pending_review', layer: '20_крона', topic: 't1',
      source: 'local_nomad', link: 'nomad://1', quote: 'q1',
    }, 'claim 1');
    let store;
    store = promotion.createVaultPromotionStore({
      vaultDir,
      journalDir: vJournal,
      beforeDiskStep: (step) => {
        if (step === 'before_journal') {
          assert.throws(() => store.cancel({ candidateId: 'c1' }, 'v-cancel-reentrant'), /single-writer/);
        }
      },
    });
    const vPrev = store.preview('c1');
    store.confirm(vPrev, 'v-confirm-1');
    assert.equal(store.cancel({ candidateId: 'c1' }, 'v-cancel-ok').cancelled, true);
  });

  it('3. readAuditLog ignores truncated trailing JSONL line but throws on corrupted middle line', () => {
    const journalDir = path.join(tmpDir, 'audit-journal');
    fs.mkdirSync(journalDir, { recursive: true });
    const auditPath = path.join(journalDir, 'audit.jsonl');

    fs.writeFileSync(
      auditPath,
      '{"event":"cancelled","operationId":"op-1"}\n{"event":"cancelled","operationId":"op-2',
      'utf8',
    );
    const entries = promotion.readAuditLog(journalDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].operationId, 'op-1');

    fs.writeFileSync(
      auditPath,
      '{"event":"cancelled","operationId":"op-1"}\n{broken_json}\n{"event":"cancelled","operationId":"op-3"}\n',
      'utf8',
    );
    assert.throws(() => promotion.readAuditLog(journalDir), SyntaxError);
  });

  it('4. conflicted status blocks promotion with conflicted_card audit error and enforces lineage invariant', () => {
    const journalDir = path.join(tmpDir, 'conflict-journal');
    const cardA = makeCard({ id: 'card-A', status: 'verified' });
    const cardB = makeCard({ id: 'card-B', status: 'pending_review' });

    const pilot = promotion.createPromotionPilot({
      journalDir,
      cards: [cardA, cardB],
    });

    const marked = pilot.markConflicted('card-B', 'Manual contradiction detected', 'op-conf-1');
    assert.equal(marked.card.status, 'conflicted');
    const markedAgain = pilot.markConflicted('card-B', 'Duplicate call', 'op-conf-2');
    assert.equal(markedAgain.alreadyConflicted, true);
    assert.equal(pilot.read().cards.find((c) => c.id === 'card-B').status, 'conflicted');

    assert.throws(
      () => pilot.preview('card-B', 'card-A'),
      (err) => err.auditCode === 'conflicted_card' && /conflicted/.test(err.message),
    );

    const log = promotion.readAuditLog(journalDir);
    assert.ok(log.some((e) => e.event === 'card_conflicted' && e.cardId === 'card-B'));
    assert.ok(log.some((e) => e.event === 'conflicted_card' && e.candidateId === 'card-B'));

    assert.throws(
      () => promotion.assertSingleActivePerLineage([
        makeCard({ id: 'v1', status: 'verified', supersedes: 'c1' }),
        makeCard({ id: 'c1', status: 'conflicted', topic: 'other' }),
      ]),
      /Инвариант/,
    );

    // Vault store markConflicted moves verified card to pending_review with status conflicted
    const vaultDir = path.join(tmpDir, 'conflict-vault');
    const vJournal = path.join(tmpDir, 'conflict-vjournal');
    writeVaultCard(vaultDir, '20_Крона/card-A.md', {
      id: 'card-A', status: 'verified', layer: '20_крона', topic: 'arch',
      source: 'local_nomad', link: 'nomad://1', quote: 'qA',
    }, 'vA');
    const store = promotion.createVaultPromotionStore({ vaultDir, journalDir: vJournal });
    const res = store.markConflicted('card-A', 'Conflict in vault', 'op-vconf');
    assert.equal(res.card.status, 'conflicted');
    assert.equal(fs.existsSync(path.join(vaultDir, '20_Крона', 'card-A.md')), false);
    assert.equal(fs.existsSync(path.join(vaultDir, 'pending_review', 'card-A.md')), true);
    assert.equal(store.read().cards.find((c) => c.id === 'card-A').status, 'conflicted');
    assert.throws(() => store.preview('card-A'), /conflicted/);
  });
});
