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

test('parseWake: her name first, what you asked after it', async () => {
  const { parseWake } = await load();
  assert.deepStrictEqual(parseWake('Капри, открой ютуб.'), { rest: 'открой ютуб.' });
  assert.deepStrictEqual(parseWake('эй капри'), { rest: '' });
  assert.deepStrictEqual(parseWake('Capri, привет'), { rest: 'привет' });
  assert.deepStrictEqual(parseWake('ну слушай, Каприя, что на экране'), { rest: 'что на экране' });
  assert.deepStrictEqual(parseWake('алло Гапри открой блокнот'), { rest: 'открой блокнот' });
  assert.deepStrictEqual(parseWake('Kapri, привет'), { rest: 'привет' });
  assert.strictEqual(parseWake('открой ютуб'), null);
  assert.strictEqual(parseWake('капризный ребёнок'), null);
  assert.strictEqual(parseWake('я сказал Капри'), null); // not first: just talking about her
});

test('parseAnswer: yes, for an hour, no, or not an answer', async () => {
  const { parseAnswer } = await load();
  assert.strictEqual(parseAnswer('Да.'), 'yes');
  assert.strictEqual(parseAnswer('давай'), 'yes');
  assert.strictEqual(parseAnswer('Да, на час'), 'hour');
  assert.strictEqual(parseAnswer('разреши на час'), 'hour');
  assert.strictEqual(parseAnswer('Нет!'), 'no');
  assert.strictEqual(parseAnswer('не надо'), 'no');
  assert.strictEqual(parseAnswer('Продолжение следует...'), null);
  assert.strictEqual(parseAnswer('данные'), null);
});

test('parseControl: explicit stop commands only', async () => {
  const { parseControl } = await load();
  assert.strictEqual(parseControl('стоп'), 'stop');
  assert.strictEqual(parseControl('останови задачу!'), 'stop');
  assert.strictEqual(parseControl('прекрати выполнение'), 'stop');
  assert.strictEqual(parseControl('cancel'), 'stop');
  assert.strictEqual(parseControl('стоп музыка'), null);
  assert.strictEqual(parseControl('остановка рядом'), null);
});

test('parseModelCommand: model name after an explicit switch command', async () => {
  const { parseModelCommand } = await load();
  assert.strictEqual(parseModelCommand('переключись на qwen 3 8b'), 'qwen 3 8b');
  assert.strictEqual(parseModelCommand('смени модель на Квен три восемь б.'), 'Квен три восемь б');
  assert.strictEqual(parseModelCommand('switch model to qwen3-vl:4b'), 'qwen3-vl:4b');
  assert.strictEqual(parseModelCommand('используй модель куэн три точка пять четыре б'), 'куэн три точка пять четыре б');
  assert.strictEqual(parseModelCommand('выбери фаун двенадцать б'), 'фаун двенадцать б');
  assert.strictEqual(parseModelCommand('выбери модель основную'), 'основную');
  assert.strictEqual(parseModelCommand('переключись на модель новую'), 'новую');
  assert.strictEqual(parseModelCommand('смени модель на зрение'), 'зрение');
  assert.strictEqual(parseModelCommand('выбери ролевую модель'), 'ролевую');
  assert.strictEqual(parseModelCommand('поставь основную модель'), 'основную');
  assert.strictEqual(parseModelCommand('перейди на модель зрения'), 'зрения');
  assert.strictEqual(parseModelCommand('давай ролевую модель'), 'ролевую');
  assert.strictEqual(parseModelCommand('модель qwen'), null);
});

test('Segmenter: a segment from a little before speech to a pause; a click is not speech', async () => {
  const { Segmenter } = await load();
  const got = [];
  const seg = new Segmenter((chunks) => got.push(chunks.length));
  const quiet = new Float32Array(1600).fill(0.001);
  const loud = new Float32Array(1600).fill(0.3);
  for (let i = 0; i < 10; i++) seg.push(quiet, 100);
  seg.push(loud, 100); // 100 ms: a click
  for (let i = 0; i < 10; i++) seg.push(quiet, 100);
  assert.deepStrictEqual(got, []);
  for (let i = 0; i < 8; i++) seg.push(loud, 100); // 0.8 s of speech
  for (let i = 0; i < 7; i++) seg.push(quiet, 100);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0], 3 + 8 + 7); // 300 ms before, the speech, the pause
});
