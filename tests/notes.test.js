'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notes = require('../src/main/notes');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'capri-notes-'));

test('a fact becomes a note, an update keeps its date of birth, the index lists them by kind', () => {
  const dir = tmp();
  assert.equal(notes.write(dir, { title: 'Проект GENESIS', type: 'проект', text: 'Ты делаешь Капри.' }, '2026-11-01'), 'Проект GENESIS');
  notes.write(dir, { title: 'Проект GENESIS', type: 'проект', text: 'Ты делаешь Капри на базе Мочи.' }, '2026-11-03');
  notes.write(dir, { title: 'Имя: Даня', type: 'о тебе', text: 'Тебя зовут Даня.' }, '2026-11-03');
  const file = fs.readFileSync(path.join(dir, 'Проект GENESIS.md'), 'utf8');
  assert.match(file, /создано: 2026-11-01/);
  assert.match(file, /обновлено: 2026-11-03/);
  assert.match(file, /на базе Мочи/);
  assert.ok(fs.existsSync(path.join(dir, 'Имя Даня.md')), 'a colon is no good in a file name');
  const index = fs.readFileSync(path.join(dir, notes.INDEX), 'utf8');
  assert.match(index, /## О тебе[\s\S]*\[\[Имя Даня\]\][\s\S]*## Проект[\s\S]*\[\[Проект GENESIS\]\]/);
  assert.equal(notes.list(dir).length, 2, 'the index is not a note');
});

test('she has in mind her notes about you, and the ones that share words with what you said', () => {
  const list = [
    { title: 'Любит синтвейв', type: 'вкус', text: 'Тебе нравится синтвейв.', updated: '2026-11-01' },
    { title: 'Проект GENESIS', type: 'проект', text: 'Ты делаешь Капри.', updated: '2026-11-02' },
    { title: 'Имя', type: 'о тебе', text: 'Тебя зовут Даня.', updated: '2026-11-03' },
  ];
  const titles = (said) => notes.recall(list, said).map((n) => n.title);
  assert.deepEqual(titles('как там проекты?'), ['Проект GENESIS', 'Имя']);
  assert.deepEqual(titles('привет'), ['Имя']);
  assert.match(notes.prompt(notes.recall(list, 'включи синтвейв')), /- about the user, Любит синтвейв: Тебе нравится синтвейв\./);
  assert.equal(notes.prompt([]), '');
});

test('her model\'s facts are checked; an answer that isn\'t JSON gives none', () => {
  assert.deepEqual(notes.parseFacts('{"facts":[{"title":"Кот","type":"о тебе","text":"У тебя кот."},{"title":"","type":"о тебе","text":"x"},{"title":"о тебе","type":"о тебе","text":"x"}]}'),
    [{ title: 'Кот', type: 'о тебе', text: 'У тебя кот.' }]);
  assert.deepEqual(notes.parseFacts('not json'), []);
  const [, user] = notes.extractMessages([{ role: 'user', content: 'у меня кот' }, { role: 'assistant', content: 'мяу' }], ['Имя']);
  assert.match(user.content, /already has: Имя[\s\S]*USER: у меня кот\nCAPRI: мяу/);
});
