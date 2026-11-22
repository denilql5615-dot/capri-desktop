'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findSpokenModel, screenModel, unload, retryEmptyVision, visionPrompt, chat, jsonChat, pick, warm, setContextFor, ctxFor,
} = require('../src/main/ollama');
const llm = require('../src/main/llm');

test('findSpokenModel matches spoken punctuation and Russian number words exactly', () => {
  const models = ['qwen3:8b', 'qwen3-vl:4b', 'gemma3:4b'];
  assert.equal(findSpokenModel(models, 'qwen 3 8b'), 'qwen3:8b');
  assert.equal(findSpokenModel(models, 'Квен три восемь б'), 'qwen3:8b');
  assert.equal(findSpokenModel(models, 'Кьюэн три восемь би'), 'qwen3:8b');
  assert.equal(findSpokenModel(models, 'qwen 3 ви эл четыре б'), 'qwen3-vl:4b');
  assert.equal(findSpokenModel(models, 'Квин три с половиной четыре б'), null);
  assert.equal(findSpokenModel(models, 'qwen'), null);
});

test('findSpokenModel still finds a model named the way you say it', () => {
  const models = ['qwen3.5:4b'];
  assert.equal(findSpokenModel(models, 'Квин три с половиной четыре б'), 'qwen3.5:4b');
  assert.equal(findSpokenModel(models, 'Куэн три точка пять четыре б'), 'qwen3.5:4b');
});

test('findSpokenModel accepts short voice-friendly names for her two Heretic brains', () => {
  const { FAST, MAIN } = require('../src/main/brains');
  const models = [FAST, MAIN, 'gemma4:26b-a4b-it-qat'];
  assert.equal(findSpokenModel(models, 'основную'), MAIN);
  assert.equal(findSpokenModel(models, 'большую'), MAIN);
  assert.equal(findSpokenModel(models, 'быструю'), FAST);
  assert.equal(findSpokenModel(models, 'зрения'), FAST);
  assert.equal(findSpokenModel(models, 'ролевую'), null); // a mode now (brains.js), not a model
});

test('screenModel prefers the Heretic brains, then the old Gemma', () => {
  const { FAST, MAIN } = require('../src/main/brains');
  assert.equal(screenModel([MAIN, FAST]), FAST);
  assert.equal(screenModel([MAIN]), MAIN);
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

test('chat accepts a larger prediction budget for vision and keeps selected Qwen models resident', async (t) => {
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
  // The alias still needs think:false before the Ollama model catalogue has been read.
  for (const model of ['capri-qwen36-heretic:latest', 'capri-qwen38-heretic:latest']) {
    await chat({ model, messages: [], numPredict: -1 }, () => {});
    assert.equal(body.model, model);
    assert.equal(body.think, false);
    assert.equal(body.keep_alive, -1);
    assert.equal(body.options.num_ctx, 4096);
    assert.equal(body.options.num_predict, -1);
  }
});

test('chat requires a terminal frame but accepts one without a trailing newline', async (t) => {
  const before = global.fetch;
  t.after(() => { global.fetch = before; });
  let tail = '{"message":';
  global.fetch = async () => ({
    ok: true,
    body: new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"message":{"content":"начало"}}\n' + tail));
      controller.close();
    } }),
  });
  const request = { model: 'capri-qwen36-heretic:latest', messages: [] };
  const pieces = [];
  await assert.rejects(chat(request, (piece) => pieces.push(piece)), { code: 'incomplete' });
  assert.deepEqual(pieces, ['начало']);
  await assert.rejects(chat(request, () => {}, AbortSignal.abort()), { name: 'AbortError' });
  tail = '{"message":{"content":" и конец"},"done":true}';
  assert.equal(await chat(request, () => {}), 'начало и конец');
});

test('setContextFor/ctxFor enforces 16384 across chat, jsonChat, pick, warm for ruled models and leaves E4B unset', async (t) => {
  const { FAST, MAIN } = require('../src/main/brains');
  const before = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    if (String(init.body).includes('"stream":true')) {
      const bytes = new TextEncoder().encode('{"message":{"content":"ок"},"done":true}\n');
      return { ok: true, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
    }
    return { ok: true, json: async () => ({ message: { content: '{"v":"PLUS"}' }, logprobs: [] }) };
  };
  const customRuled = 'test-ruled:latest';
  setContextFor(MAIN, 16384);
  setContextFor(customRuled, 16384);
  t.after(() => {
    global.fetch = before;
    setContextFor(MAIN, null);
    setContextFor(customRuled, null);
  });

  // Rule check helper: explicit overrides lose unless no rule exists
  assert.equal(ctxFor(MAIN), 16384);
  assert.equal(ctxFor(MAIN, 16384), 16384);
  assert.equal(ctxFor(MAIN, 32768), 16384);
  assert.equal(ctxFor(FAST), null);
  assert.equal(ctxFor(FAST, 8192), 8192);

  // 26B receives num_ctx: 16384 in chat, jsonChat, and pick even if different numCtx passed
  await chat({ model: MAIN, messages: [{ role: 'user', content: 'hi' }], numPredict: 2048 }, () => {});
  await chat({ model: MAIN, messages: [{ role: 'user', content: 'hi' }], numCtx: 32768 }, () => {});
  await jsonChat({ model: MAIN, messages: [{ role: 'user', content: 'hi' }], schema: { type: 'object' }, numPredict: 16, think: false });
  await pick({ model: MAIN, messages: [{ role: 'user', content: 'hi' }] });
  // warm skips /26b/i by design, so verify warm rule on a non-26b ruled model
  warm(MAIN);
  warm(customRuled);
  await Promise.resolve();

  // chat x2, jsonChat, pick, warm(customRuled) = 5 fetch calls (warm(MAIN) skipped)
  assert.equal(seen.length, 5);
  for (const call of seen) {
    assert.equal(call.body.options.num_ctx, 16384);
  }
  assert.equal(seen[0].body.options.num_predict, 2048);
  assert.equal(seen[0].body.think, false);

  // E4B has no rule: num_ctx stays absent across chat, jsonChat, pick, warm
  seen.length = 0;
  await chat({ model: FAST, messages: [{ role: 'user', content: 'hi' }] }, () => {});
  await jsonChat({ model: FAST, messages: [{ role: 'user', content: 'hi' }], schema: { type: 'object' }, numPredict: 16, think: false });
  await pick({ model: FAST, messages: [{ role: 'user', content: 'hi' }] });
  warm(FAST);
  await Promise.resolve();

  assert.equal(seen.length, 4);
  for (const call of seen) {
    assert.equal(call.body.options?.num_ctx, undefined);
  }

  // llm.chat forwards numPredict (and optional numCtx) into ollama.chat
  seen.length = 0;
  await llm.chat('ollama', {}, { model: MAIN, messages: [{ role: 'user', content: 'doc' }], numPredict: 2048 }, () => {});
  assert.equal(seen[0].body.options.num_predict, 2048);
  assert.equal(seen[0].body.options.num_ctx, 16384);
});

test('warm skips auxiliary Qwen models', async (t) => {
  const before = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true }; };
  t.after(() => { global.fetch = before; });
  warm('capri-qwen36-heretic:latest');
  warm('capri-qwen38-heretic:latest');
  await Promise.resolve();
  assert.equal(calls, 0);
});
