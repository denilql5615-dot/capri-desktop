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

test('she wears Claude\'s drawings only while Claude is thinking, and her own again after', async () => {
  globalThis.document = { documentElement: { dataset: {} } };
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  const { Skin } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/skin.js')));
  const worn = [];
  let claude = false;
  const skin = new Skin({
    capri: { sprite: { setImage: (img) => worn.push(img) } },
    fx: { setDrawings() {} },
    panel: { setFaceDir() {} },
    on: () => claude,
    sets: { capri: { dir: 'capri/', full: 'her' } },
  });
  claude = true;
  skin.check();
  assert.deepEqual(worn, [], 'Claude\'s drawings not loaded yet: she stays herself');
  skin.sets.claude = { dir: 'claude/', full: 'orange' };
  skin.check();
  claude = false;
  skin.check();
  assert.deepEqual(worn, ['orange', 'her']);
  assert.equal(globalThis.document.documentElement.dataset.skin, 'capri');
  globalThis.setInterval = realInterval;
  delete globalThis.document;
});
