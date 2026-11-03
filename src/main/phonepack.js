'use strict';

// Her moves for the phone (capri-android, PackManager.kt): the overlay draws them as frames (renderer
// phonepack.js), they're kept in her data folder (<userData>/phone-pack/<pose>/{pose.json, 0000.webp…})
// and handed to the phone bridge as one zip (phone.js /sprites, /sprites/pack.zip). The version is a hash
// of what draws them: her picture, her renderer, her acts. Change any and the overlay draws them again.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PACK = 'capri_pc';
const SOURCES = ['assets/capri/capri-full.png', 'src/renderer/js/sprite.js', 'src/renderer/js/acting.js', 'src/renderer/js/phonepack.js'];

/** What the frames would be drawn from now: changes when any of SOURCES does. */
function version(root) {
  const hash = crypto.createHash('sha1');
  for (const file of SOURCES) {
    try { hash.update(fs.readFileSync(path.join(root, file))); } catch { hash.update(file); }
  }
  return hash.digest('hex').slice(0, 12);
}

/** Minimal ZIP writer, stored entries (the frames are compressed already). */
function zipStore(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = zlib.crc32(f.data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); // utf-8 names
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(f.data.length, 18); head.writeUInt32LE(f.data.length, 22);
    head.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(f.data.length, 20); dir.writeUInt32LE(f.data.length, 24);
    dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(head, name, f.data);
    central.push(dir, name);
    offset += head.length + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const POSE_ID = /^[a-z][a-z0-9_]{0,40}$/;

/** The overlay's frames, written down: a fresh folder, swapped in only once it's whole. */
function save(dir, { version: v, poses } = {}) {
  if (!/^[0-9a-f]{12}$/.test(String(v)) || !Array.isArray(poses) || !poses.length) throw new TypeError('invalid phone pack');
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const pose of poses) {
    if (!POSE_ID.test(String(pose?.id)) || !Array.isArray(pose.frames) || !pose.frames.length || pose.frames.length > 200) throw new TypeError('invalid phone pose');
    const at = path.join(tmp, pose.id);
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, 'pose.json'), JSON.stringify(pose.meta || {}, null, 2));
    pose.frames.forEach((frame, i) => fs.writeFileSync(path.join(at, `${String(i).padStart(4, '0')}.webp`), Buffer.from(frame)));
  }
  fs.writeFileSync(path.join(tmp, 'version.txt'), v);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
}

/** The pack as the phone gets it: { pack, version, poses: [{ id, frames, fps }], zip }, or null if not drawn yet. */
function load(dir) {
  let v;
  try { v = fs.readFileSync(path.join(dir, 'version.txt'), 'utf8').trim(); } catch { return null; }
  const files = [];
  const poses = [];
  for (const id of fs.readdirSync(dir).filter((n) => POSE_ID.test(n)).sort()) {
    const at = path.join(dir, id);
    const frames = fs.readdirSync(at).filter((f) => /^\d{4}\.(png|webp)$/.test(f)).sort();
    if (!frames.length) continue;
    const meta = fs.readFileSync(path.join(at, 'pose.json'));
    files.push({ name: `${id}/pose.json`, data: meta });
    for (const f of frames) files.push({ name: `${id}/${f}`, data: fs.readFileSync(path.join(at, f)) });
    poses.push({ id: `pack:${PACK}/${id}`, frames: frames.length, fps: JSON.parse(meta).fps ?? 12 });
  }
  return poses.length ? { pack: PACK, version: v, poses, zip: zipStore(files) } : null;
}

module.exports = { PACK, SOURCES, version, zipStore, save, load };
