'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkWorkflow, fillWorkflow } = require('../src/main/comfy');

// a workflow as ComfyUI's Workflow → Export (API) writes it: two LoRAs, {prompt} in the positive text
const yours = () => ({
  1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'noobai.safetensors' } },
  10: { class_type: 'LoraLoader', inputs: { lora_name: 'capri_cp.safetensors', strength_model: 0.8, strength_clip: 1, model: ['1', 0], clip: ['1', 1] } },
  11: { class_type: 'LoraLoader', inputs: { lora_name: 'capri_body.safetensors', strength_model: 0.6, strength_clip: 1, model: ['10', 0], clip: ['10', 1] } },
  2: { class_type: 'CLIPTextEncode', inputs: { text: 'capri_cp, capri_body, {prompt}, masterpiece', clip: ['11', 1] } },
  3: { class_type: 'CLIPTextEncode', inputs: { text: 'bad hands', clip: ['11', 1] } },
  5: { class_type: 'KSampler', inputs: { seed: 42, steps: 30, cfg: 5.5, model: ['11', 0], positive: ['2', 0], negative: ['3', 0] } },
  7: { class_type: 'SaveImage', inputs: { filename_prefix: 'mine', images: ['6', 0] } },
});

test('checkWorkflow: an API export with {prompt} and a Save Image passes', () => {
  assert.ok(checkWorkflow(JSON.stringify(yours())).graph);
});

test('checkWorkflow: says plainly what is wrong', () => {
  assert.match(checkWorkflow('{oops').error, /не JSON/);
  assert.match(checkWorkflow({ nodes: [], links: [] }).error, /Export \(API\)/);
  assert.match(checkWorkflow({ a: 1 }).error, /формате API/);
  const noMark = yours();
  noMark[2].inputs.text = 'capri_cp, masterpiece';
  assert.match(checkWorkflow(noMark).error, /\{prompt\}/);
  const noSave = yours();
  delete noSave[7];
  assert.match(checkWorkflow(noSave).error, /Save Image/);
});

test('fillWorkflow: her tags in, a new seed, her prefix; your settings and LoRAs untouched', () => {
  const graph = yours();
  const { graph: out, positive } = fillWorkflow(graph, { prompt: 'beach, smile', seed: 7 });
  assert.equal(out[2].inputs.text, 'capri_cp, capri_body, beach, smile, masterpiece');
  assert.equal(positive, out[2].inputs.text);
  assert.equal(out[5].inputs.seed, 7);
  assert.equal(out[7].inputs.filename_prefix, 'capri_chat');
  assert.equal(out[11].inputs.lora_name, 'capri_body.safetensors');
  assert.equal(out[5].inputs.steps, 30);
  assert.equal(graph[2].inputs.text.includes('{prompt}'), true); // the original stays as it was
});

test('fillWorkflow: an empty request leaves no stray commas', () => {
  assert.equal(fillWorkflow(yours(), { prompt: '' }).graph[2].inputs.text, 'capri_cp, capri_body, masterpiece');
});

const { videoGraph, missingVideoModels, has14BVideoModels } = require('../src/main/comfy');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('videoGraph: Wan VACE fallback and 14B AniSora I2V from her still, saved as WebM', () => {
  const g = videoGraph({ prompt: 'waving, beach', image: 'capri_still_1.png', seed: 3 });
  assert.equal(g[6].inputs.image, 'capri_still_1.png');
  assert.deepEqual(g[7].inputs.reference_image, ['13', 0]);
  assert.equal(g[7].inputs.length, 49);
  assert.equal(g[7].inputs.strength, 0.85);
  assert.deepEqual(g[7].inputs.control_video, ['15', 0]);
  assert.deepEqual(g[7].inputs.control_masks, ['19', 0]);
  assert.equal(g[8].inputs.shift, 3.8);
  assert.equal(g[9].inputs.seed, 3);
  assert.deepEqual(g[10].inputs.trim_amount, ['7', 3]);
  assert.equal(g[12].class_type, 'SaveWEBM');
  assert.match(g[4].inputs.text, /^waving, beach, anime style/);
  for (const node of Object.values(g)) {
    for (const v of Object.values(node.inputs)) if (Array.isArray(v)) assert.ok(g[v[0]], `link to ${v[0]}`);
  }

  const g14 = videoGraph({ prompt: 'waving, beach', image: 'capri_still_1.png', seed: 9, mode: '14b' });
  assert.equal(g14[1].inputs.unet_name, 'Wan2_1-Anisora-I2V-480P-14B_fp8_e4m3fn.safetensors');
  assert.equal(g14[10].class_type, 'LoraLoaderModelOnly');
  assert.equal(g14[7].class_type, 'WanImageToVideo');
  assert.equal(g14[7].inputs.length, 49);
  assert.equal(g14[9].inputs.steps, 8);
  assert.equal(g14[9].inputs.cfg, 1.0);
  for (const node of Object.values(g14)) {
    for (const v of Object.values(node.inputs)) if (Array.isArray(v)) assert.ok(g14[v[0]], `14b link to ${v[0]}`);
  }
});

test('missingVideoModels: the files not in the models folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-models-'));
  assert.equal(has14BVideoModels(root), false);
  assert.equal(missingVideoModels(root).length, 3);
  fs.mkdirSync(path.join(root, 'vae'));
  fs.writeFileSync(path.join(root, 'vae', 'wan_2.1_vae.safetensors'), '');
  assert.deepEqual(missingVideoModels(root), ['wan2.1_vace_1.3B_fp16.safetensors', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors']);
});
