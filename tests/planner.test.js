'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Planner } = require('../src/main/planner');

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
