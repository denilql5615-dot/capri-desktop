'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findSpokenModel, screenModel, unload, retryEmptyVision, visionPrompt, chat } = require('../src/main/ollama');

test('findSpokenModel matches spoken punctuation and Russian number words exactly', () => {
  const models = ['qwen3:8b', 'qwen3-vl:4b', 'gemma3:4b'];
  assert.equal(findSpokenModel(models, 'qwen 3 8b'), 'qwen3:8b');
  assert.equal(findSpokenModel(models, 'Квен три восемь б'), 'qwen3:8b');
  assert.equal(findSpokenModel(models, 'Кьюэн три восемь би'), 'qwen3:8b');
  assert.equal(findSpokenModel(models, 'qwen 3 ви эл четыре б'), 'qwen3-vl:4b');
  assert.equal(findSpokenModel(models, 'Квин три с половиной четыре б'), null);
  assert.equal(findSpokenModel(models, 'qwen'), null);
});

test('findSpokenModel knows aliases for the models installed with Capri', () => {
  const faun = 'hf.co/limloop/MN-12B-Faun-RP-RU-GGUF:Q3_K_M';
  const models = ['qwen3.5:4b', faun];
  assert.equal(findSpokenModel(models, 'Квин три с половиной четыре б'), 'qwen3.5:4b');
  assert.equal(findSpokenModel(models, 'Куэн три точка пять четыре б'), 'qwen3.5:4b');
  assert.equal(findSpokenModel(models, 'фаун двенадцать б'), faun);
  assert.equal(findSpokenModel(models, 'эм эн двенадцать б'), faun);
});

test('findSpokenModel accepts short voice-friendly names', () => {
  const faun = 'hf.co/limloop/MN-12B-Faun-RP-RU-GGUF:Q3_K_M';
  const models = ['qwen3:8b', 'qwen3.5:4b', 'qwen3-vl:4b', faun];
  models.push('gemma4:26b-a4b-it-qat');
  assert.equal(findSpokenModel(models, 'основную'), 'gemma4:26b-a4b-it-qat');
  assert.equal(findSpokenModel(models, 'новую'), 'gemma4:26b-a4b-it-qat');
  assert.equal(findSpokenModel(models, 'зрения'), 'gemma4:26b-a4b-it-qat');
  assert.equal(findSpokenModel(models, 'ролевую'), faun);
});

test('screenModel selects Gemma for vision', () => {
  assert.equal(screenModel(['qwen3:8b', 'gemma4:26b-a4b-it-qat']), 'gemma4:26b-a4b-it-qat');
  assert.equal(screenModel(['qwen3:8b']), null);
});

test('unload asks Ollama to release the model immediately', async (t) => {
  const before = global.fetch;
  let body;
  global.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true };
  };
  t.after(() => { global.fetch = before; });
  assert.equal(await unload('qwen3:8b'), true);
  assert.deepEqual(body, { model: 'qwen3:8b', keep_alive: 0 });
});

test('an empty cold vision answer is retried only once', () => {
  assert.equal(retryEmptyVision('', 0), true);
  assert.equal(retryEmptyVision('   ', 1), false);
  assert.equal(retryEmptyVision('вижу экран', 0), false);
});

test('visionPrompt passes the request to Gemma unchanged', () => {
  assert.equal(visionPrompt('что на экране?'), 'что на экране?');
});

test('chat accepts a larger prediction budget for the vision model', async (t) => {
  const before = global.fetch;
  let body;
  global.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    const bytes = new TextEncoder().encode('{"message":{"content":"вижу"},"done":true}\n');
    return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  };
  t.after(() => { global.fetch = before; });
  assert.equal(await chat({ model: 'gemma4:26b-a4b-it-qat', messages: [], numPredict: 900 }, () => {}), 'вижу');
  assert.equal(body.think, false);
  assert.equal(body.options.num_predict, 900);
});
