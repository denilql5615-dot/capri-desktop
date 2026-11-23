'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUsage, mergeClaudeWindows } = require('../src/main/quota-claude');

test('official Claude Usage view supplies both windows and the latest stream event can update one', () => {
  const now = new Date(2026, 10, 23, 22, 30);
  const windows = parseUsage([
    'Current session', '99% used', 'Resets 12:39am',
    'Current week (all models)', '13% used', 'Resets Nov 30, 12:59am',
    'Current week (Sonnet only)', '4% used',
  ].join('\n'), now);
  assert.deepEqual(windows.map(({ remaining, minutes, resetsAt }) => [remaining, minutes, resetsAt]), [
    [1, 300, new Date(2026, 10, 24, 0, 39).getTime()],
    [87, 10080, new Date(2026, 10, 30, 0, 59).getTime()],
  ]);
  const next = { ...windows[0], checkedAt: now.getTime() + 500, remaining: 0 };
  assert.deepEqual(mergeClaudeWindows([next, ...windows]), {
    windows: [next, windows[1]], checkedAt: now.getTime(),
  });
});
