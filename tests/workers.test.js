'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { route, codexBrief } = require('../src/main/workers');

test('route: a worker named goes to it, the first named wins', () => {
  assert.strictEqual(route('Клод, разбери этот лог'), 'claude');
  assert.strictEqual(route('спроси клауда'), 'claude');
  assert.strictEqual(route('пусть Кодекс глянет'), 'codex');
  assert.strictEqual(route('ask Codex, not Claude'), 'codex');
  assert.strictEqual(route('Claude или codex?'), 'claude');
});

test('route: no worker named, her chat model answers', () => {
  assert.strictEqual(route('йоу, как дела'), null);
  assert.strictEqual(route('телеклод, суперкодекс'), null); // a letter before: another word
  assert.strictEqual(route('скажи кодексу'), 'codex');      // any ending
  assert.strictEqual(route(''), null);
});

test('codexBrief: persona, the conversation and the task, in one prompt', () => {
  const brief = codexBrief([
    { role: 'system', content: 'You are Capri.' },
    { role: 'user', content: 'привет' },
    { role: 'assistant', content: 'йо' },
    { role: 'user', content: 'кодекс, что такое 2+2' },
  ]);
  assert.match(brief, /^You are Capri\./);
  assert.match(brief, /User: привет\n\nCapri: йо/);
  assert.match(brief, /Task: кодекс, что такое 2\+2$/);
});

test('route: asked to stop one is not a task for it', () => {
  const { route } = require('../src/main/workers');
  assert.strictEqual(route('отмени задачу кодексу'), 'stop');
  assert.strictEqual(route('стоп'), 'stop');
  assert.strictEqual(route('Клод, хватит'), 'stop');
  assert.strictEqual(route('кодекс, сделай документ'), 'codex');
});

test('codexEffort: low for an errand, medium when asked to think or for code', () => {
  const { codexEffort } = require('../src/main/workers');
  assert.strictEqual(codexEffort('кодекс, собери docx с брифом'), 'low');
  assert.strictEqual(codexEffort('кодекс, подумай как следует'), 'medium');
  assert.strictEqual(codexEffort('кодекс, напиши скрипт'), 'medium');
});

test('isWorkerEvent: events from their folder are theirs, not hers to narrate', () => {
  const { isWorkerEvent } = require('../src/main/workers');
  const p = require('node:path');
  const dir = p.resolve('/Users/u/Documents/Capri');
  const cfg = { workDir: dir };
  assert.strictEqual(isWorkerEvent({ cwd: dir }, cfg), true);
  assert.strictEqual(isWorkerEvent({ cwd: p.join(dir, 'sub').toUpperCase() }, cfg), true);
  assert.strictEqual(isWorkerEvent({ cwd: `${dir}Other` }, cfg), false);
  assert.strictEqual(isWorkerEvent({ cwd: p.resolve('/Capri/genesis-src') }, cfg), false);
  assert.strictEqual(isWorkerEvent({}, cfg), false);
});
