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

test('runCouncil: blind round, anonymised cross round, rector verdict; a silent member is noted, not fatal', async () => {
  const seen = {};
  const member = (name, fail) => ({ name, ask: async (p) => { (seen[name] = seen[name] || []).push(p); if (fail) throw new Error('лимит'); return `ответ ${name}`; } });
  const members = [member('Альфа'), member('Бета'), member('Гамма', true)];
  let judged = '';
  const r = await council.runCouncil('Как устроить совет?', {
    members, judge: { name: 'Ректор', ask: async (p) => { judged = p; return VERDICT_TEXT; } },
  });
  assert.deepEqual(r.round1.map((x) => x.member), ['Альфа', 'Бета']);
  assert.deepEqual(r.round2.map((x) => x.member), ['Альфа', 'Бета']);
  // round 1 is blind; round 2 shows the others anonymised, never by name
  assert.doesNotMatch(seen['Альфа'][0], /ответ Бета/);
  assert.match(seen['Альфа'][1], /Ответ A:\nответ Бета/);
  assert.doesNotMatch(seen['Альфа'][1], /Бета:/);
  assert.match(judged, /### Альфа\nответ Альфа/);
  assert.equal(r.judge, 'Ректор');
  assert.deepEqual(r.failed.map((f) => f.member), ['Гамма']);
  assert.deepEqual(council.extractFor(r.verdict), ['Правило один.', 'Правило два.']);
});

test('runCouncil: the rector out → the fallback rector; nobody answering → an error', async () => {
  const ok = { name: 'A', ask: async () => 'a' };
  const r = await council.runCouncil('Вопрос?', { members: [ok], judge: { name: 'Opus', ask: async () => { throw new Error('limit'); } }, fallbackJudge: { name: 'Astra', ask: async () => VERDICT_TEXT } });
  assert.equal(r.judge, 'Astra');
  await assert.rejects(council.runCouncil('Вопрос?', { members: [{ name: 'X', ask: async () => { throw new Error('нет'); } }], judge: ok }), /никто не ответил/);
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
