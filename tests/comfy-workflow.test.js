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
