'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const chats = require('../src/main/chats');

test('messages go into one chat until a long pause', () => {
  const store = { chats: [] };
  chats.add(store, { role: 'user', content: 'привет' }, 1000);
  chats.add(store, { role: 'assistant', content: 'хей, чум' }, 2000);
  chats.add(store, { role: 'user', content: 'снова я' }, 2000 + chats.GAP_MS + 1);
  assert.equal(store.chats.length, 2);
  assert.deepEqual(store.chats[0].messages.map((m) => m.content), ['привет', 'хей, чум']);
  const [newest, oldest] = chats.list(store);
  assert.equal(newest.title, 'снова я');
  assert.equal(oldest.count, 2);
});

test('"forget our conversations" starts a new chat; empty or odd messages are left out', () => {
  const store = { chats: [] };
  chats.add(store, { role: 'user', content: 'раз' }, 1000);
  chats.cut(store);
  chats.add(store, { role: 'system', content: 'persona' }, 1100);
  chats.add(store, { role: 'assistant', content: '   ' }, 1200);
  chats.add(store, { role: 'user', content: 'два' }, 1300);
  assert.equal(store.chats.length, 2);
  assert.equal(store.chats[1].messages.length, 1);
  assert.equal(store.fresh, undefined);
});
