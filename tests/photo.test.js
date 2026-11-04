'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const photo = require('../src/main/photo');
const { workflow, HER } = require('../src/main/comfy');
const { PhoneBridge } = require('../src/main/phone');

test('photo.kind: "скинь фото" and "скинь видео", not every mention of a photo', () => {
  assert.equal(photo.kind('скинь фото'), 'photo');
  assert.equal(photo.kind('Капри, скинь мне своё фото на крыше под дождём'), 'photo');
  assert.equal(photo.kind('пришли селфи'), 'photo');
  assert.equal(photo.kind('нарисуй картинку с котом'), 'photo');
  assert.equal(photo.kind('скинь видео как ты танцуешь'), 'video');
  assert.equal(photo.kind('сними видос'), 'video');
  assert.equal(photo.kind('я вчера смотрел фото с моря'), null);
  assert.equal(photo.kind('как дела'), null);
});

test('photo.parsePlan: her model\'s JSON cleaned; a model that failed: her, your words', () => {
  const plan = photo.parsePlan('{"her":true,"tags":"rooftop, rain,\\nnight <lora:x>","caption":"Лови 😼"}', 'скинь фото');
  assert.equal(plan.her, true);
  assert.equal(plan.tags, 'rooftop, rain, night lora:x');
  assert.equal(plan.caption, 'Лови');
  assert.equal(photo.parsePlan('{"her":false,"tags":"cat","caption":""}', '').her, false);
  assert.deepEqual(photo.parsePlan('not json', 'кот на диване'), { her: true, tags: 'кот на диване', caption: '' });
});

test('gallery names and marks: one format, read back out of her answer', () => {
  const name = photo.galleryName(new Date(2026, 10, 4, 1, 35, 12), 0.5);
  assert.equal(name, '20261104-013512-8000.png');
  assert.ok(photo.GALLERY_FILE.test(name));
  assert.ok(!photo.GALLERY_FILE.test('../config.json'));
  assert.deepEqual(photo.split(`Держи.\n[[photo:${name}]]`), { text: 'Держи.', photos: [name] });
});

test('comfy workflow: her LoRA and looks when it is her, plain NoobAI otherwise', () => {
  const hers = workflow({ prompt: 'rooftop, rain', her: true, seed: 1 });
  assert.equal(hers.graph[8].inputs.lora_name, 'capri_cp.safetensors');
  assert.deepEqual(hers.graph[5].inputs.model, ['8', 0]);
  assert.ok(hers.positive.startsWith(HER) && hers.positive.includes('rooftop, rain'));
  const cat = workflow({ prompt: 'cat on a sofa', her: false, seed: 1 });
  assert.equal(cat.graph[8], undefined);
  assert.deepEqual(cat.graph[2].inputs.clip, ['1', 1]);
  assert.ok(!cat.positive.includes('capri_cp'));
});

test('phone: "скинь фото" comes back with the picture to fetch, the picture behind the token', async () => {
  const name = '20261104-013512-8000.png';
  const bridge = new PhoneBridge({
    token: () => 'k',
    mediaKind: photo.kind,
    photo: async () => `Лови.\n[[photo:${name}]]`,
    galleryFile: (n) => (n === name ? Buffer.from('PNG') : null),
  });
  const port = await bridge.start(0, '127.0.0.1');
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  try {
    const res = await (await fetch(url('/chat'), { method: 'POST', headers: { 'x-capri-token': 'k' }, body: JSON.stringify({ text: 'скинь фото' }) })).json();
    assert.equal(res.reply, 'Лови.');
    assert.equal(res.image, `/gallery/${name}`);
    assert.equal((await fetch(url(`/gallery/${name}`))).status, 401);
    const png = await fetch(url(`/gallery/${name}?token=k`));
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(url('/gallery/nope.png?token=k'))).status, 404);
  } finally {
    await bridge.stop();
  }
});

test('gallery: clips (.webm) beside pictures, in her marks too', () => {
  const { galleryName, GALLERY_FILE, split, isVideo, metaName } = require('../src/main/photo');
  const name = galleryName(new Date(2026, 10, 4, 1, 2, 3), 0.5, 'webm');
  assert.match(name, /^20261104-010203-8000\.webm$/);
  assert.ok(GALLERY_FILE.test(name));
  assert.ok(isVideo(name));
  assert.equal(metaName(name), '20261104-010203-8000.json');
  assert.deepEqual(split(`держи\n[[photo:${name}]]`), { text: 'держи', photos: [name] });
});
