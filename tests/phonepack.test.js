'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const phonepack = require('../src/main/phonepack');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

test('phone pack: saved whole, loaded as the phone wants it, zipped so a zip reader finds every file', (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'capri-pack-')), 'phone-pack');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  assert.equal(phonepack.load(dir), null); // not drawn yet: the phone keeps its ragdoll
  phonepack.save(dir, {
    version: 'abcdef012345',
    poses: [
      { id: 'stand', meta: { fps: 12, scale: 1.23 }, frames: [PNG, PNG, PNG] },
      { id: 'sit', meta: { fps: 12 }, frames: [PNG] },
    ],
  });
  const pack = phonepack.load(dir);
  assert.equal(pack.pack, 'capri_pc');
  assert.equal(pack.version, 'abcdef012345');
  assert.deepEqual(pack.poses, [{ id: 'pack:capri_pc/sit', frames: 1, fps: 12 }, { id: 'pack:capri_pc/stand', frames: 3, fps: 12 }]);
  // the central directory lists all six entries, the first one stored as is
  const zip = pack.zip;
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), 6);
  const name = zip.slice(30, 30 + zip.readUInt16LE(26)).toString();
  assert.equal(name, 'sit/pose.json');
  assert.equal(zip.readUInt32LE(14), zlib.crc32(fs.readFileSync(path.join(dir, 'sit', 'pose.json'))) >>> 0);
});

test('phone pack: nothing odd gets written', (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'capri-pack-')), 'phone-pack');
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  assert.throws(() => phonepack.save(dir, { version: 'nope', poses: [{ id: 'a', frames: [PNG] }] }), /invalid/);
  assert.throws(() => phonepack.save(dir, { version: 'abcdef012345', poses: [{ id: '../evil', frames: [PNG] }] }), /invalid/);
  assert.equal(fs.existsSync(dir), false);
});

test('phone pack version: follows what draws her', () => {
  const root = path.join(__dirname, '..');
  assert.match(phonepack.version(root), /^[0-9a-f]{12}$/);
  assert.equal(phonepack.version(root), phonepack.version(root));
});
