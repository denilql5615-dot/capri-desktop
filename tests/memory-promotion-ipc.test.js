'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const notes = require('../src/main/notes');
const tor = require('../src/main/tor');
const { createTorState, shouldSkipChatPersistence, TOR_PERSIST_BLOCK_MSG } = require('../src/main/tor-guard');
const {
  createPromotionPilot,
  createVaultPromotionStore,
  parseFrontmatter,
  registerMemoryPromotionIpc,
} = require('../src/main/memory-promotion');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'capri-promo-ipc-'));
}

function makeVaultFixture(t) {
  const vault = makeTempDir();
  const journalDir = makeTempDir();
  t.after(() => {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(journalDir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(vault, '10_Ствол'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'pending_review'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, '10_Ствол', 'Порт демо.md'),
    '---\nid: card-ipc-v1\nstatus: verified\nlayer: 10_ствол\ntopic: ipc-demo-port\nsource: nomad\nlink: /content/demo/old\nquote: старый порт 18100\n---\nПорт демо-сервиса равен 18100.\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(vault, 'pending_review', 'Порт демо.md'),
    '---\nid: card-ipc-v2\nstatus: candidate\nlayer: 10_ствол\ntopic: ipc-demo-port\nsource: nomad\nlink: /content/demo/new\nquote: новый порт 18101\n---\nПорт демо-сервиса обновлён до 18101.\n',
    'utf8',
  );
  return { vault, journalDir };
}

function makeIpcHarness(vault, journalDir, { quarantined = false } = {}) {
  const handlers = new Map();
  const overlaySender = { id: 'overlay' };
  const otherSender = { id: 'other' };
  const torState = createTorState();
  if (quarantined) torState.touch({ inChat: true });

  registerMemoryPromotionIpc({
    ipcMain: {
      handle(channel, fn) {
        handlers.set(channel, fn);
      },
    },
    isOverlaySender: (event) => event?.sender === overlaySender,
    notesDir: () => vault,
    memoryJournalDir: () => journalDir,
    torState,
    tor,
    shouldSkipChatPersistence,
    torBlockMsg: TOR_PERSIST_BLOCK_MSG,
  });

  const invoke = (channel, arg, sender = overlaySender) => {
    const fn = handlers.get(channel);
    assert.ok(fn, `Missing handler for ${channel}`);
    return fn({ sender }, arg);
  };

  return { handlers, overlaySender, otherSender, torState, invoke };
}

test('memory promotion IPC enforces sender, Tor boundary, cancel, confirm idempotency, searchVault and rollback', (t) => {
  const { vault, journalDir } = makeVaultFixture(t);
  const { otherSender, torState, invoke } = makeIpcHarness(vault, journalDir);

  for (const ch of ['chat:memory-preview', 'chat:memory-confirm', 'chat:memory-cancel', 'chat:memory-rollback']) {
    assert.throws(() => invoke(ch, {}, otherSender), /только из диалога Капри/);
  }

  // Tor query blocked before touching vault
  const torQueryRes = invoke('chat:memory-preview', 'http://exampleonionabcdef.onion');
  assert.equal(torQueryRes.ok, false);
  assert.equal(torQueryRes.blocked, true);
  assert.equal(torQueryRes.text, TOR_PERSIST_BLOCK_MSG);

  // Tainted/quarantined Tor state blocks all 4 channels
  torState.touch({ inChat: true });
  assert.equal(invoke('chat:memory-preview', 'ipc-demo-port').blocked, true);
  assert.equal(invoke('chat:memory-confirm', {}).text, TOR_PERSIST_BLOCK_MSG);
  assert.equal(invoke('chat:memory-cancel', {}).text, TOR_PERSIST_BLOCK_MSG);
  assert.equal(invoke('chat:memory-rollback', {}).text, TOR_PERSIST_BLOCK_MSG);

  // Fresh clean IPC harness on same vault
  const clean = makeIpcHarness(vault, journalDir);

  // Cancel path leaves vault and NDJSON untouched
  const preCancel = clean.invoke('chat:memory-preview', 'ipc-demo-port');
  assert.equal(preCancel.ok, true);
  assert.match(preCancel.text, /Что изменится при подтверждении/);
  assert.match(preCancel.text, /card-ipc-v2/);
  assert.match(preCancel.text, /card-ipc-v1/);

  const cancelled = clean.invoke('chat:memory-cancel', preCancel.preview);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.result.cancelled, true);
  assert.equal(fs.existsSync(path.join(vault, '90_Архив', 'Порт демо.md')), false);

  // Late confirm with cancelled operationId is rejected
  const lateConfirm = clean.invoke('chat:memory-confirm', preCancel.preview);
  assert.equal(lateConfirm.ok, false);
  assert.match(lateConfirm.text, /отменена/);

  // Explicit preview -> confirm -> idempotent repeat -> searchVault -> rollback
  const preConfirm = clean.invoke('chat:memory-preview', 'ipc-demo-port');
  assert.equal(preConfirm.ok, true);

  const confirmed1 = clean.invoke('chat:memory-confirm', preConfirm.preview);
  assert.equal(confirmed1.ok, true);
  assert.equal(confirmed1.result.next.status, 'verified');
  assert.equal(confirmed1.result.next.supersedes, 'card-ipc-v1');
  assert.equal(confirmed1.result.previous.status, 'archived');

  const confirmed2 = clean.invoke('chat:memory-confirm', preConfirm.preview);
  assert.equal(confirmed2.ok, true);
  assert.deepEqual(confirmed2.result, confirmed1.result);

  const opFiles = fs.readdirSync(journalDir).filter((f) => f.endsWith('.ndjson'));
  assert.equal(opFiles.length, 1);

  const activeHits = notes.searchVault(vault, '18101', 4, { history: false, journalDir });
  assert.equal(activeHits.length, 1);
  assert.match(activeHits[0].file, /^10_Ствол[/\\]Порт демо\.md$/);
  assert.match(activeHits[0].text, /18101/);

  const historyHits = notes.searchVault(vault, '18100', 4, { history: true, journalDir });
  assert.equal(historyHits.length, 1);
  assert.match(historyHits[0].file, /^90_Архив[/\\]/i);

  const rb = clean.invoke('chat:memory-rollback', {
    rollbackOperationId: 'op-ipc-rb-1',
    targetOperationId: preConfirm.preview.operationId,
  });
  assert.equal(rb.ok, true);
  assert.equal(rb.result.restored.id, 'card-ipc-v1');
  assert.equal(rb.result.archived.id, 'card-ipc-v2');

  const restoredParsed = parseFrontmatter(fs.readFileSync(path.join(vault, '10_Ствол', 'Порт демо.md'), 'utf8'));
  assert.equal(restoredParsed.meta.status, 'verified');

  const activeAfterRb = notes.searchVault(vault, '18100', 4, { history: false, journalDir });
  assert.equal(activeAfterRb.length, 1);
});

test('promotion guards block tor:// origin scheme, quote-less evidence, and audit forged store confirms', (t) => {
  const torSchemeCards = [
    {
      id: 'cand-tor-scheme',
      layer: '10_ствол',
      topic: 'tor-scheme',
      status: 'candidate',
      origin: 'tor://valid-onion-service.onion',
      claim: 'Из Tor-схемы.',
      evidence: [{ source_ref: 'notes/a.md', quote: 'цитата' }],
    },
  ];
  const pilotTor = createPromotionPilot({ journalDir: makeTempDir(), cards: torSchemeCards });
  assert.throws(() => pilotTor.preview('cand-tor-scheme', null), /Tor-источник|origin/i);
  assert.ok(pilotTor.auditEvents().some((e) => e.event === 'invalid_origin'));

  const noQuoteCards = [
    {
      id: 'cand-no-quote',
      layer: '10_ствол',
      topic: 'no-quote',
      status: 'candidate',
      claim: 'Без цитаты.',
      provenance: { source: 'vault_doc' },
      evidence: [{ source_ref: 'notes/a.md' }],
    },
  ];
  const pilotNoQuote = createPromotionPilot({ journalDir: makeTempDir(), cards: noQuoteCards });
  assert.throws(() => pilotNoQuote.preview('cand-no-quote', null), /провенанс|evidence/i);

  // Direct store.confirm() on forged Tor candidate logs invalid_origin to audit.jsonl
  const vault = makeTempDir();
  const journalDir = makeTempDir();
  t.after(() => {
    fs.rmSync(vault, { recursive: true, force: true });
    fs.rmSync(journalDir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(vault, 'pending_review'), { recursive: true });
  fs.writeFileSync(
    path.join(vault, 'pending_review', 'Подлог.md'),
    '---\nid: card-forged\nstatus: candidate\nlayer: 10_ствол\ntopic: forged\nsource: vault_doc\norigin: tor://hidden.onion\nlink: https://clearnet.example/a\nquote: подлог\n---\nТекст.\n',
    'utf8',
  );
  const store = createVaultPromotionStore({ vaultDir: vault, journalDir });
  const initialVersion = store.read().version;
  assert.throws(
    () => store.confirm({ candidateId: 'card-forged', previousId: null, version: initialVersion }, 'op-forged-1'),
    /origin|Tor/i,
  );
  assert.ok(store.auditEvents().some((e) => e.event === 'invalid_origin' && e.operationId === 'op-forged-1'));
});
