'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notes = require('../src/main/notes');
const promotion = require('../src/main/memory-promotion');

function makeTempVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-pending-'));
  const capriDir = path.join(root, 'Capri');
  fs.mkdirSync(capriDir, { recursive: true });
  return { root, capriDir };
}

function parseSimpleFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n([\s\S]*?)\r?\n?$/);
  assert.ok(match, 'Карточка должна содержать валидный блок YAML frontmatter и тело');
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = JSON.parse(val);
    }
    meta[key] = val;
  }
  return { meta, body: match[2].trim() };
}

test('writePendingCandidate создает валидную candidate-карточку в /pending_review без индексации _Память.md', () => {
  const { root, capriDir } = makeTempVault();
  try {
    const savedName = notes.writePendingCandidate(
      capriDir,
      {
        topic: 'Любимый напиток',
        source: 'user_remember',
        link: 'capri://chat/2026-11-19',
        quote: 'Запомни: я пью\nтолько фильтр-кофе без сахара',
        text: 'Пользователь пьёт только фильтр-кофе без сахара.',
      },
      '2026-11-19',
    );

    assert.equal(savedName, 'Любимый напиток');

    const cardPath = path.join(root, 'pending_review', 'Любимый напиток.md');
    assert.equal(fs.existsSync(cardPath), true);
    assert.equal(fs.existsSync(path.join(capriDir, '_Память.md')), false);

    const { meta, body } = parseSimpleFrontmatter(fs.readFileSync(cardPath, 'utf8'));
    assert.ok(meta.id && meta.id.startsWith('любимый-напиток-'));
    assert.equal(meta.status, 'candidate');
    assert.equal(meta.layer, '20_крона');
    assert.equal(meta.topic, 'Любимый напиток');
    assert.equal(meta.source, 'user_remember');
    assert.equal(meta.link, 'capri://chat/2026-11-19');
    assert.equal(meta.quote, 'Запомни: я пью только фильтр-кофе без сахара');
    assert.equal(meta.created, '2026-11-19');
    assert.equal(body, 'Пользователь пьёт только фильтр-кофе без сахара.');

    // Quarantine card stays invisible in searchVault and can be promoted cleanly via memory-promotion
    assert.deepEqual(notes.searchVault(capriDir, 'фильтр-кофе'), []);
    const journalDir = path.join(root, '.journal');
    const store = promotion.createVaultPromotionStore({ vaultDir: root, journalDir });
    const pre = store.findPreview('фильтр-кофе');
    assert.ok(pre);
    assert.equal(pre.candidateId, meta.id);
    const res = store.confirm(pre, pre.operationId);
    assert.equal(res.next.status, 'verified');
    assert.equal(notes.searchVault(capriDir, 'фильтр-кофе').length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writePendingCandidate разрешает коллизии имен файлов через суффиксы -2, -3 и поддерживает layer 10_ствол', () => {
  const { root, capriDir } = makeTempVault();
  try {
    const basePayload = {
      topic: 'Рабочий график',
      source: 'chat_extract',
      link: 'capri://chat/2026-11-19',
      quote: 'Работаю с 10 до 19',
      text: 'Рабочий день с 10:00 до 19:00.',
      layer: '10_ствол',
    };

    const n1 = notes.writePendingCandidate(capriDir, basePayload, '2026-11-19');
    const n2 = notes.writePendingCandidate(capriDir, basePayload, '2026-11-19');
    const n3 = notes.writePendingCandidate(capriDir, basePayload, '2026-11-19');

    assert.equal(n1, 'Рабочий график');
    assert.equal(n2, 'Рабочий график-2');
    assert.equal(n3, 'Рабочий график-3');

    const { meta } = parseSimpleFrontmatter(
      fs.readFileSync(path.join(root, 'pending_review', 'Рабочий график-2.md'), 'utf8'),
    );
    assert.equal(meta.layer, '10_ствол');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writePendingCandidate возвращает null и не создает файл при отсутствии обязательных полей provenance или claim', () => {
  const { root, capriDir } = makeTempVault();
  try {
    const invalidCases = [
      { topic: '', source: 'user_remember', link: 'capri://chat/2026-11-19', quote: 'q', text: 'claim' },
      { topic: 'T', source: '', link: 'capri://chat/2026-11-19', quote: 'q', text: 'claim' },
      { topic: 'T', source: 'user_remember', link: '   ', quote: 'q', text: 'claim' },
      { topic: 'T', source: 'user_remember', link: 'capri://chat/2026-11-19', quote: '', text: 'claim' },
      { topic: 'T', source: 'user_remember', link: 'capri://chat/2026-11-19', quote: 'q', text: '   ' },
    ];

    for (const payload of invalidCases) {
      const res = notes.writePendingCandidate(capriDir, payload, '2026-11-19');
      assert.equal(res, null);
    }

    const pendingDir = path.join(root, 'pending_review');
    const files = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : [];
    assert.equal(files.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseFacts сохраняет опциональное поле quote из JSON ответа LLM', () => {
  const raw = JSON.stringify({
    facts: [
      {
        title: 'Стек проекта',
        type: 'о тебе',
        text: 'Проект написан на Node.js CommonJS.',
        quote: 'У нас обычный CommonJS без ESM',
      },
    ],
  });

  const parsed = notes.parseFacts(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].quote, 'У нас обычный CommonJS без ESM');
});

test('writePendingCandidate ограничивает quote длиной MAX_TEXT и формирует валидный id при спецсимволах', () => {
  const { root, capriDir } = makeTempVault();
  try {
    const longQuote = 'а'.repeat(900);
    const saved = notes.writePendingCandidate(
      capriDir,
      {
        topic: '---',
        source: 'user_remember',
        link: 'capri://chat/2026-11-19',
        quote: longQuote,
        text: 'Краткий факт',
      },
      '2026-11-19',
    );
    assert.equal(saved, '---');
    const { meta } = parseSimpleFrontmatter(
      fs.readFileSync(path.join(root, 'pending_review', '---.md'), 'utf8'),
    );
    assert.ok(meta.id.startsWith('card-'));
    assert.equal(meta.quote.length, 600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
