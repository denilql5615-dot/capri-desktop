'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUsage, readUsageIn } = require('../src/main/gemini-usage');

test('reads current and weekly usage with localized reset dates', () => {
  const now = new Date(2026, 10, 23, 21, 0);
  assert.deepEqual(parseUsage([
    { text: 'Текущее использование Использовано 0 % Лимит сбросится в 21:57' },
    { text: 'Недельный лимит Лимит сбросится 26 нояб. в 18:57 Использовано 21 %' },
    { text: 'Дополнительное использование 50 %' },
  ], now), [
    { kind: '5h', remaining: 100, resetsAt: new Date(2026, 10, 23, 21, 57).getTime() },
    { kind: 'week', remaining: 79, resetsAt: new Date(2026, 10, 26, 18, 57).getTime() },
  ]);
});

test('keeps the chat tab and restores its address if Usage fails', async () => {
  const original = 'https://gemini.google.com/app/abcdef123';
  const visits = [];
  const page = {
    url: () => original,
    evaluate: async () => false,
    goto: async (url) => visits.push(url),
    waitForFunction: async () => { throw new Error('unavailable'); },
  };
  await assert.rejects(readUsageIn(page), /unavailable/);
  assert.deepEqual(visits, ['https://gemini.google.com/usage', original]);
});
