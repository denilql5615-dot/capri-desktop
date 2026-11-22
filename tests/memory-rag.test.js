'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memoryRag = require('../src/main/memory-rag');
const notes = require('../src/main/notes');

const NOW_MS = Date.parse('2026-11-19T00:00:00Z');

function buildFixtureVault() {
  const cards = [];

  // 30 карточек для полки 10_ствол (факты, документация, NOMAD/Kiwix)
  for (let i = 1; i <= 30; i += 1) {
    cards.push({
      id: `trunk_${i}`,
      layer: '10_ствол',
      status: 'verified',
      topic: `protocol_trunk_${i}`,
      title: `Справочник протокол альфа_${i} и регламент узла_${i}`,
      body: `Официальная спецификация модуля nomad_spec_${i} с параметром калибровки const_val_${i * 10}.`,
      source: i % 2 === 0 ? 'local_nomad' : 'kiwix',
      link: i % 2 === 0 ? `nomad://docs/spec_${i}` : `https://kiwix.local/wiki/node_${i}`,
      quote: `Параметр const_val_${i * 10} обязателен для инициализации узла_${i}.`,
      created: '2026-10-01',
      updated: '2026-11-01',
    });
  }

  // 20 карточек для полки 20_крона (личные/проектные заметки)
  for (let i = 1; i <= 20; i += 1) {
    cards.push({
      id: `crown_${i}`,
      layer: '20_крона',
      status: 'verified',
      topic: `project_crown_${i}`,
      title: `Заметка проекта Капри ветка_${i} и настройка_${i}`,
      body: `Решение пользователя по модулю capri_task_${i} с локальным ключом user_flag_${i * 7}.`,
      source: i % 2 === 0 ? 'user_remember' : 'chat_extract',
      link: `capri://chat/session_${i}`,
      quote: `Выбрана конфигурация user_flag_${i * 7} для ветки_${i}.`,
      created: '2026-11-10',
      updated: '2026-11-18',
    });
  }

  // Карантинные карточки (никогда не должны попадать в выдачу)
  cards.push({
    id: 'quarantine_pending',
    layer: 'pending_review',
    status: 'pending_review',
    topic: 'protocol_trunk_1',
    title: 'Справочник протокол альфа_1 карантинная копия',
    body: 'Официальная спецификация модуля nomad_spec_1 const_val_10',
    source: 'local_nomad',
    link: 'nomad://docs/spec_1',
    quote: 'Параметр const_val_10',
    created: '2026-11-19',
  });

  cards.push({
    id: 'quarantine_conflicted',
    layer: '10_ствол',
    status: 'conflicted',
    topic: 'project_crown_1',
    title: 'Заметка проекта Капри ветка_1 конфликт',
    body: 'Решение пользователя по модулю capri_task_1 user_flag_7',
    source: 'user_remember',
    link: 'capri://chat/session_1',
    quote: 'Конфликтная запись',
    created: '2026-11-19',
  });

  return cards;
}

test('60 контрольных запросов: 30 по 10_ствол, 20 по 20_крона, 10 нерелевантных отказов', () => {
  const cards = buildFixtureVault();

  // 30 запросов по 10_ствол
  for (let i = 1; i <= 30; i += 1) {
    const query = `протокол альфа_${i} nomad_spec_${i} const_val_${i * 10}`;
    const res = memoryRag.rankCards(cards, query, { limit: 3, nowMs: NOW_MS });
    assert.ok(res.length >= 1, `Ожидался результат для ствола #${i}`);
    assert.equal(res[0].id, `trunk_${i}`);
    assert.equal(res[0].layer, '10_ствол');
    assert.ok(res[0].score > 0.5);
    assert.equal(res[0].factors.provenance, 1.0);
    assert.equal(res[0].factors.layer, 1.0);
  }

  // 20 запросов по 20_крона
  for (let i = 1; i <= 20; i += 1) {
    const query = `Капри ветка_${i} capri_task_${i} user_flag_${i * 7}`;
    const res = memoryRag.rankCards(cards, query, { limit: 3, nowMs: NOW_MS });
    assert.ok(res.length >= 1, `Ожидался результат для кроны #${i}`);
    assert.equal(res[0].id, `crown_${i}`);
    assert.equal(res[0].layer, '20_крона');
    assert.ok(res[0].score > 0.45);
    assert.equal(res[0].factors.layer, 0.95);
  }

  // 10 нерелевантных запросов -> строго 0 результатов
  const irrelevantQueries = [
    'рецепт шарлотки с корицей и яблоками',
    'расписание поездов ташкент самарканд',
    'квантовая запутанность фотонов в вакууме',
    'как пересадить фикус бенджамина весной',
    'курс валют евро к доллару на бирже',
    'история древнего рима эпоха принципата',
    'ремонт карбюратора мотоцикла урал',
    'правила игры в керлинг на олимпиаде',
    'симфония моцарта номер сорок соль минор',
    'выращивание клубники на гидропонике дома',
  ];

  for (const badQuery of irrelevantQueries) {
    const res = memoryRag.rankCards(cards, badQuery, { limit: 3, nowMs: NOW_MS });
    assert.equal(res.length, 0, `Ожидался отказ (0 результатов) для: ${badQuery}`);
  }
});

test('Проверка факторов: свежесть (F2), источник (F3) и анти-дубль штраф (F5)', () => {
  const freshCard = {
    id: 'c_fresh',
    layer: '20_крона',
    status: 'verified',
    topic: 'arch_decision',
    title: 'Архитектура шины событий',
    body: 'Используем единый журнал событий',
    source: 'user_remember',
    updated: '2026-11-18',
  };

  const staleCard = {
    id: 'c_stale',
    layer: '20_крона',
    status: 'verified',
    topic: 'arch_legacy',
    title: 'Архитектура шины событий',
    body: 'Используем единый журнал событий',
    source: 'user_remember',
    updated: '2026-01-01',
  };

  const rankedFreshness = memoryRag.rankCards([staleCard, freshCard], 'архитектура шины событий', {
    limit: 2,
    nowMs: NOW_MS,
  });
  assert.equal(rankedFreshness[0].id, 'c_fresh');
  assert.ok(rankedFreshness[0].factors.freshness > rankedFreshness[1].factors.freshness);
  assert.equal(rankedFreshness[1].factors.dedupPenalty, 0.10);
  assert.ok(rankedFreshness[0].score - rankedFreshness[1].score > 0.10);

  // Проверка F3 provenance
  const nomadCard = {
    id: 'p_nomad',
    layer: '10_ствол',
    status: 'verified',
    title: 'Протокол SQLite WAL',
    body: 'Режим журналирования WAL ускоряет чтение',
    source: 'local_nomad',
    link: 'nomad://sqlite/wal',
    quote: 'PRAGMA journal_mode=WAL;',
    updated: '2026-11-15',
  };
  const chatCard = {
    id: 'p_chat',
    layer: '10_ствол',
    status: 'verified',
    title: 'Протокол SQLite WAL',
    body: 'Режим журналирования WAL ускоряет чтение',
    source: 'chat_extract',
    updated: '2026-11-15',
  };

  const rankedProv = memoryRag.rankCards([chatCard, nomadCard], 'протокол sqlite wal', {
    limit: 2,
    nowMs: NOW_MS,
  });
  assert.equal(rankedProv[0].id, 'p_nomad');
  assert.equal(rankedProv[0].factors.provenance, 1.0);
  assert.equal(rankedProv[1].factors.provenance, 0.55);
});

test('Защита карантина: pending_review и conflicted получают score = 0', () => {
  const cards = buildFixtureVault();
  const res = memoryRag.rankCards(cards, 'карантинная копия конфликтная запись', {
    limit: 5,
    nowMs: NOW_MS,
    minScore: 0.01,
  });
  assert.equal(res.length, 0);
});

test('classifyShelf: раскладка по 10_ствол и 20_крона', () => {
  assert.equal(memoryRag.classifyShelf({ layer: '10_ствол', source: 'chat_extract' }), '10_ствол');
  assert.equal(memoryRag.classifyShelf({ layer: '20_крона', source: 'local_nomad' }), '20_крона');
  assert.equal(memoryRag.classifyShelf({ source: 'local_nomad' }), '10_ствол');
  assert.equal(memoryRag.classifyShelf({ source: 'kiwix' }), '10_ствол');
  assert.equal(memoryRag.classifyShelf({ source: 'docs' }), '10_ствол');
  assert.equal(memoryRag.classifyShelf({ link: 'https://example.org/spec' }), '10_ствол');
  assert.equal(memoryRag.classifyShelf({ link: 'nomad://zim/ruwiki' }), '10_ствол');
  assert.equal(memoryRag.classifyShelf({ link: 'kiwix://wiki/article' }), '10_ствол');
  assert.equal(memoryRag.classifyShelf({ source: 'user_remember' }), '20_крона');
  assert.equal(memoryRag.classifyShelf({ source: 'chat_extract', link: 'capri://chat/12' }), '20_крона');
  assert.equal(memoryRag.classifyShelf({}), '20_крона');
});

test('Интеграция с notes.writePendingCandidate и notes.searchVault', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-rag-test-'));
  try {
    const trunkName = notes.writePendingCandidate(
      tmpDir,
      {
        topic: 'sqlite_fts5',
        source: 'local_nomad',
        link: 'nomad://sqlite/fts5',
        quote: 'FTS5 supports BM25 ranking.',
        text: 'Индекс FTS5 использует BM25 для полнотекстового поиска.',
      },
      '2026-11-19',
    );

    const crownName = notes.writePendingCandidate(
      tmpDir,
      {
        topic: 'capri_ui_theme',
        source: 'user_remember',
        link: 'capri://chat/99',
        quote: 'Используем темную тему.',
        text: 'Пользователь предпочел темную тему интерфейса Капри.',
      },
      '2026-11-19',
    );

    const rawTrunk = fs.readFileSync(path.join(tmpDir, 'pending_review', `${trunkName}.md`), 'utf8');
    assert.match(rawTrunk, /layer:\s*"?10_ствол"?/);

    const rawCrown = fs.readFileSync(path.join(tmpDir, 'pending_review', `${crownName}.md`), 'utf8');
    assert.match(rawCrown, /layer:\s*"?20_крона"?/);

    // Файлы в pending_review не должны находиться через searchVault
    const quarantinedHits = notes.searchVault(tmpDir, 'FTS5 BM25 полнотекстового');
    assert.equal(quarantinedHits.length, 0);

    // Верифицированная карточка в 10_Ствол должна находиться и содержать factors
    const trunkDir = path.join(tmpDir, '10_Ствол');
    fs.mkdirSync(trunkDir, { recursive: true });
    fs.writeFileSync(
      path.join(trunkDir, 'fts5.md'),
      '---\ntopic: sqlite_fts5\nlayer: 10_ствол\nstatus: verified\nsource: local_nomad\nlink: nomad://sqlite/fts5\nquote: FTS5 supports BM25 ranking.\ncreated: 2026-11-19\n---\n# SQLite FTS5\nИндекс FTS5 использует BM25 для полнотекстового поиска.\n',
      'utf8',
    );

    const hits = notes.searchVault(tmpDir, 'FTS5 BM25 полнотекстового');
    assert.equal(hits.length, 1);
    assert.ok(hits[0].score > 0.5);
    assert.ok(hits[0].factors && typeof hits[0].factors.lexical === 'number');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Защита карантина: статус quarantined получает score = 0', () => {
  const quarantinedCard = {
    id: 'q_1',
    layer: '10_ствол',
    status: 'quarantined',
    title: 'Протокол SQLite WAL',
    body: 'Режим журналирования WAL ускоряет чтение',
    source: 'local_nomad',
    updated: '2026-11-18',
  };
  const scored = memoryRag.scoreCard(quarantinedCard, 'протокол sqlite wal', NOW_MS);
  assert.equal(scored.score, 0);
  const ranked = memoryRag.rankCards([quarantinedCard], 'протокол sqlite wal', { limit: 5, nowMs: NOW_MS, minScore: 0.01 });
  assert.equal(ranked.length, 0);
});

test('scoreCard поддерживает строку query вторым аргументом с обратной совместимостью', () => {
  const card = {
    id: 's_1',
    layer: '10_ствол',
    status: 'verified',
    title: 'Протокол SQLite WAL',
    body: 'Режим журналирования WAL ускоряет чтение',
    source: 'local_nomad',
    link: 'nomad://sqlite/wal',
    quote: 'WAL accelerates reads.',
    updated: '2026-11-18',
  };
  const byString = memoryRag.scoreCard(card, 'протокол sqlite wal', NOW_MS);
  const bySet = memoryRag.scoreCard(card, memoryRag.stems('протокол sqlite wal'), NOW_MS, 'протокол sqlite wal');
  assert.ok(byString.score > 0.5);
  assert.equal(byString.score, bySet.score);
  assert.deepEqual(byString.factors, bySet.factors);
});

test('stems сохраняет короткие коды и дефисные идентификаторы (HZ-1, ALTA, 26B, E4B, v3, API, MCP, CLI, 13T)', () => {
  for (const code of ['HZ-1', 'ALTA', '26B', 'E4B', 'v3', 'API', 'MCP', 'CLI', '13T']) {
    const out = memoryRag.stems(code);
    assert.ok(out.size >= 1, `Ожидался токен для ${code}`);
  }
  assert.ok(memoryRag.stems('HZ-1').has('hz-1'));
  assert.ok(memoryRag.stems('v3').has('v3'));
  assert.deepEqual([...memoryRag.stems('что по альта')], ['альта']);
});

test('rankCards ставит совпадение в title/file выше более свежих совпадений только в теле заметки', () => {
  const planAlta = {
    id: 'plan-alta',
    title: 'План ALTA',
    file: 'ALTA\\План ALTA.md',
    body: 'Дорожная карта переговоров со студиями.',
    created: '',
    updated: '',
  };
  const songOfAshes = {
    id: 'soa-1',
    title: 'GDD демо — костяк',
    file: 'Song of Ashes\\GDD демо — костяк.md',
    body: 'Учебный план демонстрации на встрече ALTA Alliance.',
    updated: '2026-11-18',
  };
  const hzNote = {
    id: 'hz-1-doc',
    title: 'Паспорт теста',
    file: 'GENESIS\\Altair\\HZ-1\\Паспорт теста.md',
    body: 'Проверки мобильного чата.',
    updated: '2026-11-18',
  };

  const planHits = memoryRag.rankCards([songOfAshes, planAlta], 'План ALTA', { limit: 2, nowMs: NOW_MS });
  assert.equal(planHits[0].id, 'plan-alta');

  const hzHits = memoryRag.rankCards([songOfAshes, hzNote], 'HZ-1', { limit: 2, nowMs: NOW_MS });
  assert.equal(hzHits.length, 1);
  assert.equal(hzHits[0].id, 'hz-1-doc');
});
