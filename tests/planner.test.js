'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Planner, syncReminders } = require('../src/main/planner');

test('syncReminders: open planner reminders go to her list; once rung, done; a save race puts one back', () => {
  const plans = [
    { id: 'a', kind: 'reminder', title: 'Позвонить', at: 5000, status: 'open', createdAt: 1 },
    { id: 'b', kind: 'reminder', title: 'Уже было', at: 500, status: 'open', createdAt: 1 }, // came due while she was off
    { id: 'c', kind: 'reminder', title: 'Прозвенело', at: 500, status: 'open', pushed: true, createdAt: 1 },
    { id: 'd', kind: 'reminder', title: 'Гонка', at: 5000, status: 'open', pushed: true, createdAt: 1 },
    { id: 'e', kind: 'reminder', title: 'В списке', at: 5000, status: 'open', pushed: true, createdAt: 1 },
    { id: 'f', kind: 'reminder', title: 'Сделано', at: 500, status: 'done', createdAt: 1 },
    { id: 'g', kind: 'task', title: 'Задача', due: 500, status: 'open', createdAt: 1 },
  ];
  const { add, done } = syncReminders(plans, [{ id: 'plan-e', planId: 'e', at: 5000 }, { id: 'x', at: 1 }], 1000);
  assert.deepEqual(add.map((r) => r.planId), ['a', 'b', 'd']);
  assert.deepEqual(add[0], { id: 'plan-a', at: 5000, text: 'Позвонить', made: 1, planId: 'a' });
  assert.deepEqual(done, ['c']);
});

test('planner: reminders complete, pushed is kept, every write is reported', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-planner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let writes = 0;
  const planner = new Planner(path.join(dir, 'planner.json'), { id: () => 'r1', now: () => 1000, onChange: () => { writes++; } });
  planner.create({ kind: 'reminder', title: 'Позвонить', at: 5000 });
  planner.markPushed(['r1']);
  assert.equal(planner.list()[0].pushed, true);
  assert.equal(planner.complete('r1').status, 'done');
  assert.equal(writes, 3);
});

test('local planner validates, persists, filters, and completes plans', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-planner-'));
  const ids = ['event-1', 'task-1', 'reminder-1', 'note-1'];
  const planner = new Planner(path.join(dir, 'planner.json'), { id: () => ids.shift(), now: () => 1000 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  planner.create({ kind: 'event', title: 'Встреча', start: '2026-11-04T09:00:00Z', end: '2026-11-04T10:00:00Z' });
  planner.create({ kind: 'task', title: 'Отчёт', due: '2026-11-03T18:00:00Z' });
  planner.create({ kind: 'reminder', title: 'Позвонить', at: '2026-11-03T17:00:00Z' });
  planner.create({ kind: 'note', title: 'Идея', notes: 'Сохранить локально' });

  assert.deepEqual(planner.list({ kinds: ['task'] }).map(({ id }) => id), ['task-1']);
  assert.equal(planner.complete('task-1').status, 'done');
  assert.deepEqual(planner.list({ status: 'done' }).map(({ id }) => id), ['task-1']);
  assert.throws(() => planner.create({ kind: 'event', title: 'Назад', start: 20, end: 10 }), /follow start/);
  assert.throws(() => planner.create({ kind: 'reminder', title: 'Без времени' }), /required/);
});
