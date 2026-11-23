'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshot } = require('../scripts/agy-statusline');
const { poolsToGroups } = require('../src/main/quota-agy');

test('AGY status line maps the Gemini and 3P pools (Argon shares Gemini) and ignores disabled or absent quotas', () => {
  const reset = '2026-11-24T00:00:00Z';
  const snap = snapshot({ quota: {
    'gemini-5h': { remaining_fraction: 0, reset_time: reset },
    'gemini-weekly': { remaining_fraction: null },
    'gemini-argon-wtu-weekly': { remaining_fraction: 0.754 },
    '3p-5h': { remaining_fraction: 1, disabled: true },
    '3p-weekly': { remaining_fraction: 0.5 },
  } });
  assert.deepEqual(poolsToGroups(snap), {
    'agy-gemini': [{ remaining: 0, minutes: 300, resetsAt: Date.parse(reset) }],
    'agy-third-party': [{ remaining: 50, minutes: 10080, resetsAt: null }],
    checkedAt: { 'agy-gemini': snap.checkedAt, 'agy-third-party': snap.checkedAt },
  });
});
