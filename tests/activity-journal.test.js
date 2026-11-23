'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ActivityJournal, safeText } = require('../src/main/activity-journal');

const ID = 'turn-0123456789';

test('the journal upserts by key and a reconnect reads only what changed since its version', () => {
  const j = new ActivityJournal();
  j.begin(ID);
  j.add(ID, 'r1:turn', { kind: 'turn', agent: 'claude', group: 'claude', state: 'running' });
  j.add(ID, 'r1:t1', { kind: 'command', name: 'git', state: 'running', detail: { command: 'git status' } });
  const first = j.read(ID, 0);
  assert.equal(first.entries.length, 2);
  j.add(ID, 'r1:t1', { kind: 'command', name: 'git', state: 'done', detail: { output: 'clean' } });
  const later = j.read(ID, first.version);
  assert.deepEqual(later.entries.map((e) => [e.key, e.state]), [['r1:t1', 'done']]);
  assert.deepEqual(later.entries[0].detail, { output: 'clean' });
});

test('finish settles running steps, drops the trailing answer message and persists the chain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  const j = new ActivityJournal({ dir });
  j.begin(ID);
  j.add(ID, 'a', { kind: 'message', text: 'Смотрю файлы.' });
  j.add(ID, 'b', { kind: 'tool', name: 'Read', state: 'running' });
  j.add(ID, 'c', { kind: 'message', text: 'Готовый ответ' });
  j.finish(ID, 'stopped');
  const again = new ActivityJournal({ dir });
  const feed = again.read(ID, 0);
  assert.equal(feed.done, true);
  assert.deepEqual(feed.entries.map((e) => [e.key, e.state]), [['a', 'done'], ['b', 'stopped'], ['c', 'done']]);
  const done = new ActivityJournal({ dir });
  done.begin('turn-done-000001');
  done.add('turn-done-000001', 'm', { kind: 'message', text: 'Промежуточное' });
  done.add('turn-done-000001', 't', { kind: 'tool', name: 'Read', state: 'done' });
  done.add('turn-done-000001', 'ans', { kind: 'message', text: 'Ответ' });
  done.finish('turn-done-000001', 'done');
  assert.deepEqual(done.read('turn-done-000001').entries.map((e) => e.key), ['m', 't']);
});

test('an isolated turn keeps phases only and never reaches the disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  const j = new ActivityJournal({ dir });
  j.begin(ID, { isolated: true });
  j.add(ID, 'p', { kind: 'phase', name: 'memory', state: 'done' });
  j.add(ID, 't', { kind: 'tool', name: 'tor_search', text: 'onion text', detail: { command: 'x' } });
  j.finish(ID);
  const entries = j.read(ID).entries;
  assert.deepEqual(entries.map((e) => [e.kind, e.name]), [['phase', 'memory'], ['tool', undefined]]);
  assert.ok(!JSON.stringify(entries).includes('onion'));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('secrets are masked and long output keeps its tail', () => {
  assert.equal(safeText('key sk-abcdefghijklmnopqrstuv end'), 'key «скрыто» end');
  assert.equal(safeText('password=hunter22 ok'), '«скрыто» ok');
  assert.equal(safeText('x'.repeat(10) + 'END', 5, { tail: true }), '…xxEND');
  assert.equal(safeText('\u001b[31mred\u001b[0m'), 'red');
});

test('unknown kinds and bad ids are ignored', () => {
  const j = new ActivityJournal();
  assert.equal(j.begin('../x'), null);
  j.begin(ID);
  assert.equal(j.add(ID, 'k', { kind: 'eval', name: 'x' }), null);
  assert.equal(j.read('nothing-here-123'), null);
});
