'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { LoraTrainer, slugOf, epochsFor } = require('../src/main/lora-trainer');
const { ToolHarness } = require('../src/main/tool-harness');
const { profileWorkflow } = require('../src/main/comfy');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lora-'));
  const template = path.join(dir, 'template.json');
  fs.writeFileSync(template, JSON.stringify({
    epochs: 60,
    concepts: [{ name: '', path: '', enabled: false, image: { resolution_override: '512' }, text: { prompt_source: 'sample' } }],
    samples: [{ prompt: 'old', width: 1024, height: 1024 }],
  }));
  fs.mkdirSync(path.join(dir, 'models', 'loras'), { recursive: true });
  const t = new LoraTrainer({ root: path.join(dir, 'lora'), template, models: path.join(dir, 'models'), oneTrainer: dir });
  return { dir, t };
}
const DRAWERS = { art: { checkpoint: 'noob.safetensors' } };

test('slugOf / epochsFor: a latin id that is also the trigger; about 1500 steps', () => {
  assert.equal(slugOf('Gemini Brigade!'), 'gemini_brigade');
  assert.equal(slugOf('Гемини'), '');
  assert.equal(epochsFor(19), 79);
  assert.equal(epochsFor(3), 120);
  assert.equal(epochsFor(400), 10);
});

test('LoraTrainer.prepare: chat pictures + a folder + a zip → captioned dataset, config on the drawer checkpoint', () => {
  const { dir, t } = sandbox();
  const folder = path.join(dir, 'pics');
  fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'a.png'), PNG);
  fs.writeFileSync(path.join(folder, 'sub', 'b.jpg'), PNG);
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'x');
  const zipSrc = path.join(dir, 'zipsrc');
  fs.mkdirSync(zipSrc);
  fs.writeFileSync(path.join(zipSrc, 'c.png'), PNG);
  const zip = path.join(dir, 'more.zip');
  execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-a', '-cf', zip, '-C', zipSrc, 'c.png']);
  const meta = t.prepare({ name: 'Gemini Brigade', drawer: 'art', subject: '1girl, solo', images: [PNG, PNG], paths: `${folder};${zip}`, drawers: DRAWERS });
  assert.equal(meta.name, 'gemini_brigade');
  assert.equal(meta.images, 5);
  const data = path.join(dir, 'lora', 'gemini_brigade', 'dataset');
  assert.equal(fs.readdirSync(data).filter((f) => f.endsWith('.txt')).length, 5);
  assert.equal(fs.readFileSync(path.join(data, '0001.txt'), 'utf8'), 'gemini_brigade, 1girl, solo');
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'lora', 'gemini_brigade', 'config.json'), 'utf8'));
  assert.match(cfg.base_model_name, /checkpoints[\\/]noob\.safetensors$/);
  assert.match(cfg.output_model_destination, /loras\/gemini_brigade\.safetensors$/);
  assert.equal(cfg.concepts[0].enabled, true);
  assert.equal(cfg.concepts[0].image.resolution_override, '1024');
  assert.equal(cfg.concepts[0].text.keep_tags_count, 1);
  assert.equal(cfg.epochs, epochsFor(5));
  assert.equal(t.list()[0].status, 'prepared');
});

test('LoraTrainer.prepare refuses too few pictures, a bad drawer and a missing path', () => {
  const { t } = sandbox();
  assert.throws(() => t.prepare({ name: 'x', images: [PNG], drawers: DRAWERS }), /Мало картинок/);
  assert.throws(() => t.prepare({ name: 'x', drawer: 'oil', images: [PNG], drawers: DRAWERS }), /рисовальщика/);
  assert.throws(() => t.prepare({ name: 'x', paths: 'Z:\\nope', drawers: DRAWERS }), /Не нашла/);
});

test('profileWorkflow loras: LoraLoader on the checkpoint feeds the sampler and both text encoders', () => {
  const w = profileWorkflow({ prompt: 'x', loras: [{ name: 'gemini_brigade.safetensors', strength: 0.8 }] });
  assert.equal(w.graph[30].class_type, 'LoraLoader');
  assert.deepEqual(w.graph[30].inputs.model, ['1', 0]);
  assert.deepEqual(w.graph[2].inputs.clip, ['30', 1]);
  assert.deepEqual(w.graph[3].inputs.clip, ['30', 1]);
  assert.deepEqual(w.graph[5].inputs.model, ['30', 0]);
  assert.equal(profileWorkflow({ prompt: 'x' }).graph[30], undefined);
});

test('ToolHarness lora_train: attached pictures by number go to the trainer', async () => {
  const calls = [];
  const harness = new ToolHarness({
    loraTrainer: {
      train: async (a) => { calls.push(a); return { slug: 'gemini_brigade', images: a.images.length, epochs: 80, etaMin: 45 }; },
      list: async () => [], status: async () => ({ running: false }), stop: async () => false,
    },
  });
  let step = 0;
  const res = await harness.runLoop({
    messages: [{ role: 'user', content: 'обучи лору' }],
    ctx: { attachedImages: ['a', 'b', 'c', 'd'] },
    async runTurn() {
      step += 1;
      return step === 1
        ? { text: '', toolCalls: [{ function: { name: 'lora_train', arguments: { action: 'train', name: 'gemini_brigade', subject: '1girl, solo', images: '2-4' } } }] }
        : { text: 'Запустила.', toolCalls: [] };
    },
  });
  assert.deepEqual(calls[0].images, ['b', 'c', 'd']);
  assert.equal(calls[0].drawer, 'art');
  assert.equal(res.text, 'Запустила.');
});

test('LoraTrainer.prepare outfit: its own tag right after the trigger, in the meta for drawing', () => {
  const { t } = sandbox();
  const meta = t.prepare({ name: 'gemini_brigade', outfit: 'Gemini Outfit', subject: '1girl, solo', images: [PNG, PNG, PNG, PNG, PNG], drawers: DRAWERS });
  assert.equal(meta.outfit, 'gemini_outfit');
  const cap = fs.readFileSync(path.join(t.dir('gemini_brigade'), 'dataset', '0001.txt'), 'utf8');
  assert.equal(cap, 'gemini_brigade, gemini_outfit, 1girl, solo');
  assert.equal(t.list()[0].outfit, 'gemini_outfit');
});

test('LoraTrainer.list: the main LoRA of a character first, other files of it marked as old versions', () => {
  const { dir, t } = sandbox();
  fs.mkdirSync(path.join(dir, 'lora', 'gemini'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lora', 'gemini', 'meta.json'), JSON.stringify({ name: 'gemini_brigade_v2', trigger: 'gemini_brigade', main: true, tags: 'blue hair' }));
  for (const n of ['gemini_brigade_v2', 'gemini_brigade', 'gemini_brigade_e60', 'gemini_brigade_v3', 'other_style']) fs.writeFileSync(path.join(dir, 'models', 'loras', `${n}.safetensors`), 'x');
  const by = Object.fromEntries(t.list().map((l) => [l.name, l]));
  assert.equal(by.gemini_brigade_v2.main, true);
  assert.equal(by.gemini_brigade_v2.tags, 'blue hair');
  assert.equal(by.gemini_brigade.alt, true);
  assert.equal(by.gemini_brigade_e60.alt, true);
  assert.equal(by.gemini_brigade_v3.alt, true);
  assert.equal(by.other_style.alt, undefined);
});

test('inpaintWorkflow: SAM 3 mask by words, grown, LoRA on the drawer, original pasted back outside the mask', () => {
  const { inpaintWorkflow, SAM3 } = require('../src/main/comfy');
  const w = inpaintWorkflow({ image: 'src.png', target: 'jacket', prompt: 'sleeveless bodysuit', loras: [{ name: 'gemini_brigade_v2.safetensors' }], denoise: 0.85, grow: 30, seed: 7 });
  const g = w.graph;
  assert.equal(g[20].inputs.ckpt_name, SAM3);
  assert.equal(g[100].inputs.text, 'jacket');
  assert.deepEqual(g[101].inputs.conditioning, ['100', 0]);
  assert.deepEqual(g[23].inputs.mask, ['101', 0]);
  assert.equal(g[52].inputs.type, 'openpose');
  assert.deepEqual(g[5].inputs.model, ['60', 0]);
  assert.deepEqual(g[60].inputs.model, ['30', 0]);
  const kept = inpaintWorkflow({ image: 's.png', target: 'left leg, right leg', keep: 'shoes', fill: 0xffffff, prompt: 'x' }).graph;
  assert.equal(kept[70].inputs.text, 'shoes');
  assert.equal(kept[73].inputs.operation, 'subtract');
  assert.deepEqual(kept[24].inputs.pixels, ['62', 0]);
  const two = inpaintWorkflow({ image: 's.png', target: 'left leg, right leg', prompt: 'x' }).graph;
  assert.equal(two[103].inputs.text, 'right leg');
  assert.equal(two[105].inputs.operation, 'add');
  assert.deepEqual(two[23].inputs.mask, ['105', 0]);
  const six = inpaintWorkflow({ image: 's.png', target: 'jacket, sleeves, collar, puffer jacket, vest', prompt: 'x' }).graph;
  assert.equal(six[112].inputs.text, 'vest');
  assert.equal(six[52].class_type, 'SetUnionControlNetType');
  assert.equal(g[23].inputs.expand, 30);
  assert.equal(g[5].inputs.denoise, 0.85);
  assert.deepEqual(g[25].inputs.destination, ['10', 0]);
  assert.deepEqual(g[25].inputs.mask, ['29', 0]);
  assert.deepEqual(g[7].inputs.images, ['25', 0]);
  assert.equal(w.seed, 7);
});

test('ToolHarness comfy_inpaint: target, prompt and the attached pictures go to the inpainter', async () => {
  const calls = [];
  const harness = new ToolHarness({ comfyInpaint: async (a, o) => { calls.push([a, o]); return { ok: true, path: null, image: 'p.png', prompt: a.prompt, seed: 3, target: a.target, drawerLabel: 'NoobAI', lora: 'gemini_brigade_v2' }; } });
  let step = 0;
  const res = await harness.runLoop({
    messages: [{ role: 'user', content: 'сними с неё куртку' }],
    ctx: { attachedImages: ['a'] },
    async runTurn() {
      step += 1;
      return step === 1
        ? { text: '', toolCalls: [{ function: { name: 'comfy_inpaint', arguments: { target: 'jacket', prompt: 'sleeveless bodysuit, bare arms', negative: 'jacket' } } }] }
        : { text: 'Сняла.', toolCalls: [] };
    },
  });
  assert.equal(calls[0][0].target, 'jacket');
  assert.deepEqual(calls[0][1].images, ['a']);
  assert.equal(res.text, 'Сняла.');
});

test('comfy_generate: "нарисуй Gemini" without a lora picks the main LoRA by its alias; the tool lists it', async () => {
  const drawn = [];
  const harness = new ToolHarness({
    comfyDraw: async (a) => { drawn.push(a); return { ok: true, path: null, image: 'p.png', prompt: a.prompt, negative: '', seed: 1, width: 832, height: 1216, steps: 30, cfg: 6.5 }; },
    loraTrainer: { list: () => [{ name: 'gemini_brigade_v2', trigger: 'gemini_brigade', aliases: ['gemini', 'гемини'], main: true, ready: true, note: 'Gemini из Бригады' }], train: async () => ({}), status: async () => ({}), stop: async () => false },
  });
  let step = 0;
  let toolDesc = '';
  await harness.runLoop({
    messages: [{ role: 'user', content: 'Нарисуй Gemini на ночной улице' }],
    ctx: { userText: 'Нарисуй Gemini на ночной улице' },
    async runTurn({ tools }) {
      step += 1;
      toolDesc = toolDesc || JSON.stringify((tools || []).find((t) => (t.function?.name || t.name) === 'comfy_generate') || '');
      return step === 1
        ? { text: '', toolCalls: [{ function: { name: 'comfy_generate', arguments: { prompt: 'girl on a night street', drawer: 'art' } } }] }
        : { text: 'Готово.', toolCalls: [] };
    },
  });
  assert.equal(drawn[0].lora, 'gemini_brigade_v2');
  assert.match(toolDesc, /gemini_brigade_v2 = gemini_brigade \/ gemini/);
});
