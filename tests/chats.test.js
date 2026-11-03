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
  const { chats: [newest, oldest], current } = chats.list(store, 2000 + chats.GAP_MS + 2);
  assert.equal(current, newest.id);
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

test('an old chat continued becomes the live one; the live one deleted, the next message starts anew', () => {
  const store = { chats: [] };
  chats.add(store, { role: 'user', content: 'старый' }, 1000);
  chats.add(store, { role: 'user', content: 'новый' }, 1000 + chats.GAP_MS + 1);
  const old = store.chats[0].id;
  const now = 5 * chats.GAP_MS;
  assert.equal(chats.current(store, now), null); // a long pause: the next message would start a new chat
  chats.resume(store, old, now);
  assert.equal(chats.current(store, now), old);
  chats.add(store, { role: 'user', content: 'продолжаю' }, now + 10);
  assert.deepEqual(store.chats.at(-1).messages.map((m) => m.content), ['старый', 'продолжаю']);
  chats.remove(store, old, now + 15);
  assert.equal(store.chats.length, 1);
  assert.equal(store.fresh, true);
  assert.equal(chats.current(store, now + 20), null);
});
