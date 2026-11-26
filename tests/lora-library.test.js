'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LoraLibrary, parse, render } = require('../src/main/lora-library');
const { LoraTrainer } = require('../src/main/lora-trainer');

const NOTE = `# Лиана (lyana)
- Синонимы: Лиана, Лиану
- Рисовальщик: фото
- Всегда: adult woman
- Запрещено: hat

## Кафка
- Синонимы: kafka
- Теги: long dark red wig, brown coat
- Фото: k1.jpg

## Части костюма
- belt: white belt
`;

test('lora-library parse/render: header slug, keys, looks and costume parts round-trip', () => {
  const lib = parse(NOTE);
  assert.equal(lib.slug, 'lyana');
  assert.deepEqual(lib.aliases, ['лиана', 'лиану']);
  assert.equal(lib.drawer, 'photo');
  assert.equal(lib.always, 'adult woman');
  assert.equal(lib.negative, 'hat');
  assert.equal(lib.looks[0].name, 'Кафка');
  assert.deepEqual(lib.looks[0].photos, ['k1.jpg']);
  assert.equal(lib.parts.belt, 'white belt');
  const again = parse(render(lib));
  assert.deepEqual(again.looks, lib.looks);
  assert.deepEqual(again.parts, lib.parts);
});

test('lora-library: a look by its name in any case form, photos from D:, a new look added into the note', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(path.join(vault, 'GENESIS', 'ComfyUI', 'LoRA'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'GENESIS', 'ComfyUI', 'LoRA', 'Лиана.md'), NOTE);
  const lib = new LoraLibrary({ vaultDir: vault, loraRoot: path.join(dir, 'lora') });
  const l = lib.get('lyana');
  assert.equal(lib.findLook(l, 'нарисуй Лиану в образе Кафки на крыше').name, 'Кафка');
  assert.equal(lib.findLook(l, 'draw her as kafka').name, 'Кафка');
  assert.equal(lib.findLook(l, 'нарисуй её на пляже'), null);
  fs.mkdirSync(lib.lookDir('lyana', 'Кафка'), { recursive: true });
  fs.writeFileSync(path.join(lib.lookDir('lyana', 'Кафка'), 'k1.jpg'), 'jpg');
  assert.equal(lib.lookPhotos('lyana', l.looks[0]).length, 1);
  const added = lib.addLook('lyana', { name: 'Мику', tags: 'teal twin tails', aliases: ['miku'], photos: [Buffer.from('x')] });
  assert.equal(added.photos.length, 1);
  const after = lib.get('lyana');
  assert.equal(after.looks.find((x) => x.name === 'Мику').tags, 'teal twin tails');
  assert.ok(fs.existsSync(path.join(lib.lookDir('lyana', 'Мику'), added.photos[0])));
  assert.ok(!fs.readdirSync(path.join(vault, 'GENESIS', 'ComfyUI', 'LoRA')).some((f) => f.endsWith('.jpg')), 'photos never in the vault');
});

test('LoraTrainer.list: the note wins over meta — aliases, always, never, drawer, looks; a noted LoRA is main', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libt-'));
  fs.mkdirSync(path.join(dir, 'models', 'loras'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'models', 'loras', 'lyana.safetensors'), 'x');
  const notes = { lyana: { ...parse(NOTE), file: 'Лиана.md' } };
  const t = new LoraTrainer({ root: path.join(dir, 'lora'), models: path.join(dir, 'models'), notes: () => notes });
  const l = t.list().find((x) => x.name === 'lyana');
  assert.equal(l.main, true);
  assert.deepEqual(l.aliases, ['лиана', 'лиану']);
  assert.equal(l.tags, 'adult woman');
  assert.equal(l.negative, 'hat');
  assert.equal(l.drawer, 'photo');
  assert.equal(l.looks[0].name, 'Кафка');
});
