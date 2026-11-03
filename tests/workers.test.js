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
