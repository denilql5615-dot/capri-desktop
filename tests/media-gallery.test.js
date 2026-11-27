'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MediaGallery } = require('../src/main/media-gallery');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-'));
  const dirs = { chat: path.join(root, 'gallery'), private: path.join(root, 'media-private'), nsfw: path.join(root, 'media-18') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return { root, dirs, g: new MediaGallery({ dirOf: (s) => dirs[s] }) };
}

test('MediaGallery.list: one section only, pictures and videos, newest first, paged', () => {
  const { dirs, g } = sandbox();
  fs.writeFileSync(path.join(dirs.chat, 'a.png'), 'x');
  fs.utimesSync(path.join(dirs.chat, 'a.png'), 1000, 1000);
  fs.writeFileSync(path.join(dirs.chat, 'b.webm'), 'xx');
  fs.writeFileSync(path.join(dirs.chat, 'b.json'), '{}');
  fs.writeFileSync(path.join(dirs.nsfw, 'n.png'), 'x');
  const r = g.list('chat');
  assert.equal(r.total, 2);
  assert.deepEqual(r.items.map((i) => i.name), ['b.webm', 'a.png']);
  assert.equal(r.items[0].video, true);
  assert.deepEqual(g.list('chat', { offset: 1, limit: 1 }).items.map((i) => i.name), ['a.png']);
  assert.deepEqual(g.list('nsfw').items.map((i) => i.name), ['n.png']);
  assert.equal(g.list('private').total, 0);
  assert.equal(g.list('../etc').total, 0);
});

test('MediaGallery.file: only a plain name inside its own section', () => {
  const { dirs, g } = sandbox();
  fs.writeFileSync(path.join(dirs.private, 'p.jpg'), 'x');
  fs.writeFileSync(path.join(dirs.chat, 'c.png'), 'x');
  assert.equal(g.file('private', 'p.jpg').mime, 'image/jpeg');
  assert.equal(g.file('chat', 'p.jpg'), null); // another section's picture
  assert.equal(g.file('private', '../gallery/c.png'), null);
  assert.equal(g.file('private', 'missing.png'), null);
  assert.equal(g.file('private', 'notes.txt'), null);
  assert.equal(g.file('other', 'p.jpg'), null);
});
