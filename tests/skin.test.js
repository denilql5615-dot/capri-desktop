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

test('she wears the drawings of the AI thinking, and her own again after', async () => {
  globalThis.document = { documentElement: { dataset: {} } };
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  const { Skin } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/skin.js')));
  const worn = [];
  let who = null;
  const skin = new Skin({
    capri: { sprite: { setImage: (img) => worn.push(img) } },
    fx: { setDrawings() {} },
    panel: { setFaceDir() {} },
    who: () => who,
    sets: { capri: { dir: 'capri/', full: 'her' } },
  });
  who = 'claude';
  skin.check();
  assert.deepEqual(worn, [], 'Claude\'s drawings not loaded yet: she stays herself');
  skin.sets.claude = { dir: 'claude/', full: 'orange' };
  skin.sets.codex = { dir: 'codex/', full: 'violet' };
  skin.check();
  who = 'codex';
  skin.check();
  who = null;
  skin.check();
  assert.deepEqual(worn, ['orange', 'violet', 'her']);
  assert.equal(globalThis.document.documentElement.dataset.skin, 'capri');
  globalThis.setInterval = realInterval;
  delete globalThis.document;
});

test('the AI at work under her hooks: the one heard from last, never the demo', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  const { Brain } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/brain.js')));
  const brain = Object.assign(Object.create(Brain.prototype), {
    sessions: new Map([
      ['a', { working: true, source: 'claude', seen: 1000 }],
      ['codex:b', { working: true, source: 'codex', seen: 2000 }],
      ['demo', { working: true, source: 'demo', seen: 3000 }],
    ]),
  });
  assert.equal(brain.atWork(2500), 'codex');
  brain.sessions.get('codex:b').working = false;
  assert.equal(brain.atWork(2500), 'claude');
  assert.equal(brain.atWork(1000 + 16 * 60 * 1000), null, 'not heard from in a long while');
  delete globalThis.matchMedia;
});
