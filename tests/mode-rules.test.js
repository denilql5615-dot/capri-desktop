'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ruleKey, ensureDefaults, rulesFor, FOLDER } = require('../src/main/mode-rules');

test('ruleKey maps phone modes, with RP only inside 18+', () => {
  assert.equal(ruleKey({ mode: 'nsfw', rp: true }), 'nsfw-rp');
  assert.equal(ruleKey({ mode: 'nsfw' }), 'nsfw');
  assert.equal(ruleKey({ mode: 'private', rp: true }), 'private');
  assert.equal(ruleKey({ mode: 'task' }), 'task');
  assert.equal(ruleKey({ mode: 'tor' }), 'chat');
  assert.equal(ruleKey({}), 'chat');
});

test('defaults are written once and the user edits win from the next read', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
  const made = ensureDefaults(vault);
  assert.equal(made.length, 6);
  assert.match(rulesFor(vault, { mode: 'private' }), /Tor/);
  const file = path.join(vault, FOLDER, 'Приват.md');
  fs.writeFileSync(file, '---\ntags: [x]\n---\nМоё правило привата');
  const t = new Date(Date.now() + 2000);
  fs.utimesSync(file, t, t);
  assert.equal(rulesFor(vault, { mode: 'private' }), 'Моё правило привата');
  assert.equal(ensureDefaults(vault).length, 0);
  assert.equal(fs.readFileSync(file, 'utf8').includes('Моё правило'), true);
});

test('without a vault the built-in rules still apply; 18+ keeps the hard line on minors', () => {
  assert.match(rulesFor(null, { mode: 'nsfw' }), /несовершеннолет/);
  assert.match(rulesFor(null, { mode: 'cloud' }), /capri-web/);
});

test('18+ always gets both notes: the general rules and the RP rules for role-play scenes', () => {
  const text = rulesFor(null, { mode: 'nsfw' });
  assert.match(text, /Правила режима «18\+»/);
  assert.match(text, /Когда идёт ролевая сцена \(РП\):\n# Правила ролевой игры/);
  assert.equal(rulesFor(null, { mode: 'nsfw', rp: true }), text);
});
