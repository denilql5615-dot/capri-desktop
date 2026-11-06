'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { quotaGroup, codexWindows, claudeWindow } = require('../src/main/agent-quotas');

test('Antigravity keeps Argon, Gemini Flash/Pro and Claude/GPT separate', () => {
  assert.equal(quotaGroup('gemini', 'gemini-4-argon-medium'), 'agy-argon');
  assert.equal(quotaGroup('gemini', 'gemini-3.8-flash-high'), 'agy-gemini');
  assert.equal(quotaGroup('gemini', 'claude-opus-5-5-medium'), 'agy-third-party');
  assert.equal(quotaGroup('claude', 'opus'), 'claude');
});

test('provider telemetry preserves zero, weekly reset and optional Claude model scope', () => {
  assert.deepEqual(codexWindows({ rateLimitsByLimitId: { codex: { secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 123 } } } }), [
    { remaining: 0, minutes: 10080, resetsAt: 123 },
  ]);
  const event = (info) => ({ type: 'rate_limit_event', rate_limit_info: info });
  assert.deepEqual(claudeWindow(event({ rateLimitType: 'seven_day_sonnet', utilization: .75, resetsAt: 456 })),
    { remaining: 25, minutes: 10080, resetsAt: 456, scope: 'sonnet' });
  assert.equal(claudeWindow(event({ rateLimitType: 'five_hour', status: 'allowed' })), null);
});
