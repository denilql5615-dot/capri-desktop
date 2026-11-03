'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { isComputerTask } = require('../src/main/agent');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/js/plans.js')).href);

test('plans: what is ahead, by day, undated last; done and all on their own', async () => {
  const { pick, byDay } = await load();
  const now = new Date(2026, 10, 4, 12, 0).getTime();
  const at = (d, h) => new Date(2026, 10, d, h).getTime();
  const plans = [
    { id: 'old', kind: 'event', title: 'Вчера', start: at(3, 10), status: 'open' },
    { id: 'late', kind: 'task', title: 'Просрочено', due: at(2, 10), status: 'open' },
    { id: 'note', kind: 'note', title: 'Идея', createdAt: at(1, 1), status: 'open' },
    { id: 'tmr', kind: 'reminder', title: 'Позвонить', at: at(5, 9), status: 'open' },
    { id: 'now', kind: 'event', title: 'Созвон', start: at(4, 15), status: 'open' },
    { id: 'done', kind: 'task', title: 'Сделал', due: at(4, 9), status: 'done' },
  ];
  assert.deepEqual(pick(plans, 'soon', now).map((p) => p.id), ['late', 'now', 'tmr', 'note']);
  assert.deepEqual(pick(plans, 'done', now).map((p) => p.id), ['done']);
  assert.equal(pick(plans, 'all', now).length, 6);
  assert.deepEqual(byDay(pick(plans, 'soon', now)).map((d) => d.plans.length), [1, 1, 1, 1]);
  assert.equal(byDay(pick(plans, 'soon', now)).at(-1).day, null);
});

test('protonPhrase: a meeting said so Claude or Codex fill it in Proton, the last click left to you', async () => {
  const { protonPhrase } = await load();
  const said = protonPhrase({ title: 'Созвон «ALTA»', start: Date.parse('2026-11-05T10:00:00Z'), end: Date.parse('2026-11-05T11:00:00Z'), notes: 'про\nпитч' }, 'ru', 'UTC');
  assert.equal(said, 'Открой Proton Calendar и заполни встречу «Созвон ALTA» на 5 ноября 2026 г., с 10:00 до 11:00, в описании: про питч. Не нажимай Создать: последнюю кнопку я нажму сам.');
  assert.equal(isComputerTask(said), true);
  assert.ok(said.length <= 500); // what her chat takes (chats:send)
});
