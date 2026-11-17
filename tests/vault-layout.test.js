'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const notes = require('../src/main/notes');

const vault = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-vault-'));
  const dir = path.join(root, 'Capri');
  fs.mkdirSync(dir);
  return { root, dir };
};

test('appendChat: a file a day in Сырьё/Чаты, exchanges added in order', () => {
  const { root, dir } = vault();
  const at = new Date(2026, 10, 4, 14, 5).getTime();
  assert.equal(notes.appendChat(dir, { said: 'привет', answer: 'йо', at }), 'Сырьё/Чаты/2026-11-04.md');
  notes.appendChat(dir, { said: 'сделай отчёт', answer: 'готово', by: 'Claude', at: at + 60000 });
  const text = fs.readFileSync(path.join(root, 'Сырьё', 'Чаты', '2026-11-04.md'), 'utf8');
  assert.match(text, /^---\nтип: разговор/);
  assert.equal(text.match(/^---$/gm).length, 2); // one header
  assert.ok(text.indexOf('привет') < text.indexOf('сделай отчёт'));
  assert.match(text, /### 14:06 · Ты\nсделай отчёт\n\n\*\*Claude:\*\* готово/);
  assert.equal(notes.appendChat(dir, { said: '', answer: 'x' }), null);
});

test('appendSearch: her search log in Сырьё/Поиск — how, every result marked read / check / snippet, answer or failure', () => {
  const { root, dir } = vault();
  const at = new Date(2026, 10, 17, 13, 40).getTime();
  const results = [{ title: 'Wiki', url: 'https://w.example/a' }, { title: 'Wall', url: 'https://c.example/b' }, { title: 'Other', url: 'https://o.example/c' }];
  assert.equal(notes.appendSearch(dir, { question: 'кто написал Пикник', via: 'браузер Camoufox, профиль MAIN', results, read: ['https://w.example/a'], blocked: ['https://c.example/b'], answer: 'Стругацкие [1].', at }), 'Сырьё/Поиск/2026-11-17.md');
  notes.appendSearch(dir, { question: 'второй', via: 'x', error: 'Профиль открыт без порта', at: at + 60000 });
  const text = fs.readFileSync(path.join(root, 'Сырьё', 'Поиск', '2026-11-17.md'), 'utf8');
  assert.match(text, /^---\nтип: поиск/);
  assert.equal(text.match(/^---$/gm).length, 2);
  assert.match(text, /## 13:40 · кто написал Пикник\n\*Через:\* браузер Camoufox, профиль MAIN/);
  assert.match(text, /1\. \[Wiki\]\(https:\/\/w\.example\/a\) — 📖 прочитана/);
  assert.match(text, /2\. \[Wall\]\(https:\/\/c\.example\/b\) — ⛔ проверка «не робот»/);
  assert.match(text, /3\. \[Other\]\(https:\/\/o\.example\/c\) — · только описание/);
  assert.match(text, /\*\*Ответ:\*\* Стругацкие \[1\]\./);
  assert.match(text, /## 13:41 · второй[\s\S]*\*\*Не вышло:\*\* Профиль открыт без порта/);
  assert.equal(notes.appendSearch(dir, { question: ' ' }), null);
});

test('writeOutput: a note per task in Результаты, an index linking them, no overwrite', () => {
  const { root, dir } = vault();
  const at = new Date(2026, 10, 4, 9, 30).getTime();
  const one = notes.writeOutput(dir, { worker: 'Claude', task: 'сделай план тренировок', answer: 'Готово: plan.docx', folder: 'C:\\Docs\\Capri', artifacts: [{ name: 'plan.docx' }], at });
  const two = notes.writeOutput(dir, { worker: 'Codex', task: 'сделай план тренировок', answer: 'ещё раз', at });
  assert.equal(one, 'Результаты/2026-11-04 09-30 сделай план тренировок.md');
  assert.equal(two, 'Результаты/2026-11-04 09-30 сделай план тренировок (2).md');
  const note = fs.readFileSync(path.join(root, one), 'utf8');
  assert.match(note, /кто: Claude/);
  assert.match(note, /\*\*Задача:\*\* сделай план тренировок/);
  assert.match(note, /\*\*Созданные файлы:\*\*\n- `plan\.docx`/);
  assert.match(note, /Файлы — в папке C:\\Docs\\Capri/);
  const index = fs.readFileSync(path.join(root, 'Результаты', '_Результаты.md'), 'utf8');
  assert.ok(index.includes('[[2026-11-04 09-30 сделай план тренировок]]'));
  assert.ok(index.includes('[[2026-11-04 09-30 сделай план тренировок (2)]]'));
});

test('searchVault: finds what workers made, skips raw talk', () => {
  const { dir } = vault();
  notes.appendChat(dir, { said: 'расскажи про бонсай', answer: 'бонсай это дерево' });
  notes.writeOutput(dir, { worker: 'Claude', task: 'сравни бонсай и qwen', answer: 'бонсай слабее в инструкциях' });
  const found = notes.searchVault(dir, 'бонсай');
  assert.equal(found.length >= 1, true);
  assert.ok(found.every((f) => !f.file.startsWith('Сырьё')));
  assert.ok(found.some((f) => f.file.startsWith('Результаты')));
});
