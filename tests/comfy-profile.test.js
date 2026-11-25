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
