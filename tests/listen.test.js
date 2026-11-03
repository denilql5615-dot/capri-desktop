'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'listen.js')).href);

test('encodeWav writes a 16 kHz mono 16-bit header and clamps samples', async () => {
  const { encodeWav } = await load();
  const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
  const v = new DataView(wav.buffer);
  assert.strictEqual(Buffer.from(wav.slice(0, 4)).toString(), 'RIFF');
  assert.strictEqual(v.getUint16(22, true), 1);      // mono
  assert.strictEqual(v.getUint32(24, true), 16000);  // rate
  assert.strictEqual(v.getUint16(34, true), 16);     // bits
  assert.strictEqual(v.getUint32(40, true), 8);      // 4 samples
  assert.strictEqual(v.getInt16(46, true), 0x7fff);
  assert.strictEqual(v.getInt16(48, true), -0x8000);
  assert.strictEqual(v.getInt16(50, true), 0x7fff);  // 2 clamped to 1
});

test('resample halves the length from 32 kHz to 16 kHz', async () => {
  const { resample } = await load();
  assert.strictEqual(resample(new Float32Array(3200), 32000, 16000).length, 1600);
  const same = new Float32Array(10);
  assert.strictEqual(resample(same, 16000, 16000), same);
});

test('Endpointer stops after a pause once you spoke, or when nothing was said', async () => {
  const { Endpointer } = await load();
  const talk = new Endpointer();
  let done = false;
  for (let i = 0; i < 10 && !done; i++) done = talk.push(0.3, 100); // a second of speech
  assert.strictEqual(done, false);
  let ms = 0;
  while (!done) { done = talk.push(0.001, 100); ms += 100; }
  assert.ok(ms >= 1300 && ms <= 1400, `stopped after ${ms} ms of quiet`);

  const quiet = new Endpointer();
  ms = 0;
  done = false;
  while (!done) { done = quiet.push(0.001, 100); ms += 100; }
  assert.strictEqual(ms, 6000);
});
