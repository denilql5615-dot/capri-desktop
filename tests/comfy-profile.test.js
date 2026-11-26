'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = require('../src/main/comfy-profile');
const { ToolHarness } = require('../src/main/tool-harness');

test('profile learns from updates, keeps scopes apart and clamps settings', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  profile.update(vault, 'chat', { positive_add: 'soft light, film grain', negative_add: 'text', width: 999, note: 'любит тёплый свет' });
  let p = profile.update(vault, 'chat', { positive_add: 'Soft Light, pastel', positive_remove: 'film grain', steps: 500 });
  assert.deepEqual(p.positive, ['soft light', 'pastel']);
  assert.equal(p.width, 1024);
  assert.equal(p.steps, 60);
  assert.match(profile.describe(p), /тёплый свет/);
  p = profile.read(vault, 'chat');
  assert.deepEqual(p.negative, ['text']);
  assert.deepEqual(profile.read(vault, 'nsfw').positive, []);
  assert.ok(fs.existsSync(path.join(vault, '20_Крона', 'Ветки', 'nsfw')) === false);
  profile.update(vault, 'nsfw', { positive_add: 'x' });
  assert.ok(fs.existsSync(profile.fileOf(vault, 'nsfw')));
  assert.deepEqual(profile.read(vault, 'chat').positive, ['soft light', 'pastel']);
});

test('harness: comfy tools use the profile of the current mode and return seed for variations', async () => {
  const calls = [];
  const harness = new ToolHarness({
    comfyProfile: { read: async (s) => { calls.push(['read', s]); return { ...profile.DEFAULT, positive: [], negative: [], notes: [] }; }, update: async (s, a) => { calls.push(['update', s, a.positive_add]); return { ...profile.DEFAULT, positive: ['x'], negative: [], notes: [] }; } },
    comfyDraw: async (args, opts) => { calls.push(['draw', opts.scope, args.seed]); return { ok: true, path: null, image: null, prompt: 'cat, x', negative: 'n', seed: 42, width: 832, height: 1216, steps: 30, cfg: 6.5 }; },
  });
  const tools = harness.getTools({ mode: 'nsfw', webNode: 'main' });
  await tools.find((t) => t.name === 'comfy_profile').execute({ action: 'update', positive_add: 'x' });
  const out = await tools.find((t) => t.name === 'comfy_generate').execute({ prompt: 'cat', seed: 7 });
  assert.match(out.output, /seed 42/);
  assert.deepEqual(calls, [['update', 'nsfw', 'x'], ['draw', 'nsfw', 7]]);
  assert.ok(harness.getTools({}).some((t) => t.name === 'comfy_profile'));
});

test('drawers: photo and portrait use their own checkpoints and samplers; a face adds the FaceID chain', () => {
  const { profileWorkflow, DRAWERS, FRAMES } = require('../src/main/comfy');
  const photo = profileWorkflow({ prompt: 'man on a street', ...DRAWERS.photo, negativeBase: DRAWERS.photo.negative, width: FRAMES.full_body[0], height: FRAMES.full_body[1] });
  assert.equal(photo.graph[1].inputs.ckpt_name, DRAWERS.photo.checkpoint);
  assert.equal(photo.graph[5].inputs.sampler_name, 'dpmpp_2m');
  assert.match(photo.negative, /cartoon/);
  assert.deepEqual([photo.width, photo.height], [768, 1344]);
  assert.equal(photo.graph[45], undefined);
  const face = profileWorkflow({ prompt: 'portrait', ...DRAWERS.portrait, faceImage: 'me.png' });
  assert.equal(face.graph[45].class_type, 'IPAdapterFaceID');
  assert.deepEqual(face.graph[5].inputs.model, ['45', 0]);
  assert.equal(face.graph[43].inputs.model_name, 'buffalo_l');
});

test('profile keeps a default drawer in plain words', () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cpd-'));
  profile.update(vault, 'chat', { drawer: 'фото' });
  assert.equal(profile.read(vault, 'chat').drawer, 'photo');
  assert.match(fs.readFileSync(profile.fileOf(vault, 'chat'), 'utf8'), /\*\*Рисовальщик\*\*: фото/);
});

test('pose reference: a photo goes through DWPose (openpose), a sketch through scribble; frame follows the reference', () => {
  const { profileWorkflow, frameFor, CONTROLNET_UNION } = require('../src/main/comfy');
  const pose = profileWorkflow({ prompt: 'knight', poseImage: 'ref.png', width: 768, height: 1344 });
  assert.equal(pose.graph[51].class_type, 'DWPreprocessor');
  assert.equal(pose.graph[51].inputs.scale_stick_for_xinsr_cn, 'enable');
  assert.equal(pose.graph[52].inputs.control_net_name, CONTROLNET_UNION);
  assert.equal(pose.graph[53].inputs.type, 'openpose');
  assert.deepEqual(pose.graph[5].inputs.positive, ['54', 0]);
  assert.deepEqual(pose.graph[5].inputs.negative, ['54', 1]);
  const sketch = profileWorkflow({ prompt: 'knight', poseImage: 'ref.png', poseMode: 'sketch' });
  assert.equal(sketch.graph[51].class_type, 'ScribblePreprocessor');
  assert.equal(frameFor(1080, 1920), 'full_body');
  assert.equal(frameFor(1920, 1080), 'wide');
  assert.equal(frameFor(1000, 1000), 'square');
  assert.equal(profileWorkflow({ prompt: 'x' }).graph[54], undefined);
});

test('three references in one picture: face → look (lighter with a pose) → pose through ControlNet', () => {
  const { profileWorkflow } = require('../src/main/comfy');
  const w = profileWorkflow({ prompt: 'x', faceImage: 'face.png', lookImage: 'look.png', poseImage: 'pose.png' });
  assert.deepEqual(w.graph[63].inputs.model, ['45', 0]);
  assert.deepEqual(w.graph[5].inputs.model, ['63', 0]);
  assert.equal(w.graph[63].inputs.weight, 0.55);
  assert.equal(w.graph[63].inputs.end_at, 0.65);
  assert.deepEqual(w.graph[5].inputs.positive, ['54', 0]);
  const lookOnly = profileWorkflow({ prompt: 'x', lookImage: 'look.png' });
  assert.deepEqual(lookOnly.graph[63].inputs.model, ['1', 0]);
  assert.equal(lookOnly.graph[63].inputs.weight, 0.7);
});

test('several angles: faces and looks are batched and averaged', () => {
  const { profileWorkflow } = require('../src/main/comfy');
  const w = profileWorkflow({ prompt: 'x', faceImages: ['f1', 'f2', 'f3'], lookImages: ['l1', 'l2'] });
  assert.equal(w.graph[45].inputs.combine_embeds, 'average');
  assert.equal(w.graph[82].class_type, 'ImageBatch');
  assert.deepEqual(w.graph[45].inputs.image, ['82', 0]);
  assert.deepEqual(w.graph[63].inputs.image, ['101', 0]);
  assert.equal(w.graph[63].inputs.combine_embeds, 'average');
  const one = profileWorkflow({ prompt: 'x', faceImages: ['f1'] });
  assert.equal(one.graph[45].inputs.combine_embeds, 'concat');
  assert.deepEqual(one.graph[45].inputs.image, ['70', 0]);
});

test('profileWorkflow facePad: a gray margin around each face photo before FaceID (retry for close-ups)', () => {
  const { profileWorkflow } = require('../src/main/comfy');
  const w = profileWorkflow({ prompt: 'x', faceImages: ['a.png', 'b.png'], facePad: 384 });
  assert.equal(w.graph[570].class_type, 'ImagePadForOutpaint');
  assert.deepEqual(w.graph[570].inputs.image, ['70', 0]);
  assert.deepEqual(w.graph[81].inputs, { image1: ['570', 0], image2: ['571', 0] });
  assert.equal(profileWorkflow({ prompt: 'x', faceImages: ['a.png'] }).graph[570], undefined);
});
