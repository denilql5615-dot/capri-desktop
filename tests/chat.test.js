'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function moduleUrl(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${moduleUrl(path.resolve(path.dirname(file), relative))}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

test('temporarily hiding chat does not abort a running task; explicit close does', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  const { Chat } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/chat.js')));
  const stopped = [];
  const make = () => Object.assign(Object.create(Chat.prototype), {
    open: true,
    turn: 42,
    host: { chatStop: (id) => stopped.push(id), focusOverlay() {} },
    capri: {},
  });

  make().close(false);
  assert.deepEqual(stopped, []);

  make().close();
  assert.deepEqual(stopped, [42]);
  delete globalThis.matchMedia;
});

test('an alert cannot replace chat while its task is running', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  const { Panel } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/panel.js')));
  const panel = Object.assign(Object.create(Panel.prototype), {
    current: { kind: 'chat', chat: {} },
    el: { hidden: false },
    suspended: false,
    leaving: false,
    chatBusy: true,
    missed: null,
  });

  assert.equal(panel.say({ kind: 'alert', line: 'permission' }), false);
  assert.equal(panel.current.kind, 'chat');
  assert.equal(panel.missed.kind, 'alert');
  delete globalThis.matchMedia;
});

test('natural Russian requests to inspect the screen are recognized', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  const { isLookRequest } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/chat.js')));
  for (const phrase of [
    'глянь на экран',
    'посмотри пожалуйста что у меня на мониторе',
    'что сейчас открыто на экране',
    'что ты видишь',
    'прочитай текст с экрана',
    'посмотри, что на экране.',
    'Глянь, пожалуйста, на экран!',
    "what's on my screen?",
  ]) assert.equal(isLookRequest(phrase), true, phrase);
  assert.equal(isLookRequest('открой настройки экрана'), false);
  delete globalThis.matchMedia;
});

