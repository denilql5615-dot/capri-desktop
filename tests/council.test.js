'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const council = require('../src/main/council');
const agyApp = require('../src/main/agy-app');

function moduleUrl(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${moduleUrl(path.resolve(path.dirname(file), relative))}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

const VERDICT_TEXT = '## Решение\nДелать так.\n\n## Выжимка для Геммы\n- Правило один.\n- Правило два.\n\n## Что проверить\n- x';

test('runCouncil: blind round, anonymised cross round (when asked), rector verdict; a silent member is noted, not fatal', async () => {
  const seen = {};
  const member = (name, fail) => ({ name, ask: async (p) => { (seen[name] = seen[name] || []).push(p); if (fail) throw new Error('лимит'); return `ответ ${name}`; } });
  const members = [member('Альфа'), member('Бета'), member('Гамма', true)];
  let judged = '';
  const r = await council.runCouncil('Как устроить совет?', {
    members, crossRound: true, judge: { name: 'Ректор', ask: async (p) => { judged = p; return VERDICT_TEXT; } },
  });
  assert.deepEqual(r.round1.map((x) => x.member), ['Альфа', 'Бета']);
  assert.deepEqual(r.round2.map((x) => x.member), ['Альфа', 'Бета']);
  // round 1 is blind; round 2 shows the others anonymised, never by name
  assert.doesNotMatch(seen['Альфа'][0], /ответ Бета/);
  assert.match(seen['Альфа'][1], /Ответ A:\nответ Бета/);
  assert.doesNotMatch(seen['Альфа'][1], /Бета:/);
  // the rector sees no names (it may be a member itself); the note keeps who was who
  assert.match(judged, /### Участник A\nответ Альфа/);
  assert.doesNotMatch(judged, /### Альфа|### Бета/);
  assert.deepEqual(r.letters, ['Участник A — Альфа', 'Участник B — Бета']);
  assert.equal(r.judge, 'Ректор');
  assert.deepEqual(r.failed.map((f) => f.member), ['Гамма']);
  assert.deepEqual(council.extractFor(r.verdict), ['Правило один.', 'Правило два.']);
});

test('ordinary council: one blind round, every member asked once, exactly one rector call', async () => {
  const calls = [];
  const members = ['A', 'B', 'C', 'D', 'E'].map((name) => ({ name, ask: async () => { calls.push(name); return `ответ ${name}`; } }));
  let rectorCalls = 0;
  const r = await council.runCouncil('Вопрос?', { members, judge: { name: 'Opus', ask: async () => { rectorCalls += 1; return VERDICT_TEXT; } } });
  assert.deepEqual(calls.sort(), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(r.round2, []);
  assert.equal(rectorCalls, 1);
  assert.equal(r.judge, 'Opus');
});

test('the one rector fails: its status and the members\' answers, no second rector', async () => {
  const ok = { name: 'A', ask: async () => 'ответ A' };
  let calls = 0;
  const r = await council.runCouncil('Вопрос?', { members: [ok], judge: { name: 'Opus', ask: async () => { calls += 1; throw new Error('limit'); } } });
  assert.equal(calls, 1);
  assert.equal(r.verdict, null);
  assert.equal(r.rector, 'Opus');
  assert.equal(r.rectorError, 'limit');
  const reply = council.rectorFailedReply(r);
  assert.match(reply, /ректор Opus не смог \(limit\)\. Второго ректора не запускаю/);
  assert.match(reply, /### A\n\nответ A/);
  await assert.rejects(council.runCouncil('Вопрос?', { members: [{ name: 'X', ask: async () => { throw new Error('нет'); } }], judge: ok }), /никто не ответил/);
});

test('a stopped council does not report the rector as failed', async () => {
  const abort = new AbortController();
  const judge = { name: 'Opus', ask: async () => { abort.abort(new Error('stopped')); throw new Error('killed'); } };
  await assert.rejects(council.runCouncil('Вопрос?', { members: [{ name: 'A', ask: async () => 'a' }], judge, signal: abort.signal }), /stopped/);
});

test('pickRector: an explicit seat wins; auto takes the pool with the most quota left; unknown ranks as 20%', () => {
  const seats = [{ id: 'opus', pool: 'claude' }, { id: 'sol', pool: 'codex' }, { id: 'agy-neon-high', pool: 'agy-gemini' }, { id: 'web-neon', pool: 'web-gemini' }];
  const groups = [
    { id: 'claude', bars: [{ remaining: 0 }, { remaining: 86 }] },
    { id: 'codex', bars: [{ remaining: 28 }, { remaining: 20 }] },
    { id: 'agy-gemini', bars: [{ remaining: 60 }] },
    { id: 'web-gemini', bars: [{ remaining: 99 }, { remaining: 79 }] },
  ];
  assert.equal(council.pickRector(seats, groups, 'sol').id, 'sol');
  assert.equal(council.pickRector(seats, groups, 'auto').id, 'web-neon');
  assert.equal(council.pickRector(seats, [], 'auto').id, 'opus'); // nothing known: the agreed order
  assert.equal(council.pickRector(seats, [{ id: 'claude', bars: [{ remaining: 3 }] }], 'auto').id, 'sol'); // unknown 20 > known 3
  assert.equal(council.pickRector(seats.slice(1), groups, 'opus').id, 'web-neon'); // the asked seat isn't here: auto
  assert.equal(council.pickRector([], groups), null);
});
test('writeCouncil: a note in Результаты/Совет, verdict first, rounds after', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-council-'));
  const file = council.writeCouncil(root, { question: 'Как устроить совет?', round1: [{ member: 'A', text: 'r1' }], round2: [{ member: 'A', text: 'r2' }], verdict: VERDICT_TEXT, judge: 'Ректор', failed: [] }, { at: new Date(2026, 10, 17, 20, 5).getTime() });
  assert.match(file.replace(/\\/g, '/'), /Результаты\/Совет\/2026-11-17 20-05 Как устроить совет\.md$/);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.indexOf('## Решение') < text.indexOf('## Раунд 2') && text.indexOf('## Раунд 2') < text.indexOf('## Раунд 1'));
});

test('agy-app answerAfter: the text after the question mark, without status lines and the input area', () => {
  const page = 'Conversation\nВопрос…\n[конец вопроса abc]\nThought for 12s\nОтвет первой строкой.\nВторая строка.\nWorked for 1m\nMessage input\nOrchestrator (Argon)';
  assert.equal(agyApp.answerAfter(page, '[конец вопроса abc]'), 'Ответ первой строкой.\nВторая строка.');
  assert.equal(agyApp.answerAfter(page, '[нет метки]'), '');
});

test('chat: "созови совет: …" is a council question', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  const { councilAsked } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/chat.js')));
  assert.equal(councilAsked('созови совет: как обучать Гемму на ответах моделей?'), 'как обучать Гемму на ответах моделей?');
  assert.equal(councilAsked('Капри, собери совет — что лучше для кода'), 'что лучше для кода');
  assert.equal(councilAsked('дай совет по коду'), null);
});
