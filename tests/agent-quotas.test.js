'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { quotaGroup, codexWindows, claudeWindow, parseAgyStatusLineQuota } = require('../src/main/agent-quotas');

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

test('Antigravity statusLine quota parsing maps Argon, Gemini, and 3P windows correctly', () => {
  const samplePayload = {
    quota: {
      'gemini-argon-wtu-weekly': { remaining_fraction: 0.42, reset_time: 1794333000 },
      'gemini-5h': { remaining_fraction: 0.85, reset_time: 1793976000 },
      'gemini-weekly': { remaining_fraction: 0.60, reset_time: 1794333000 },
      '3p-5h': { remaining_fraction: 0.90, reset_time: 1793976000 },
      '3p-weekly': { remaining_fraction: 0.70, reset_time: 1794333000 },
    },
  };
  const parsed = parseAgyStatusLineQuota(samplePayload);
  assert.deepEqual(parsed['agy-argon'], [
    { remaining: 42, minutes: 10080, resetsAt: 1794333000 },
  ]);
  assert.deepEqual(parsed['agy-gemini'], [
    { remaining: 85, minutes: 300, resetsAt: 1793976000 },
    { remaining: 60, minutes: 10080, resetsAt: 1794333000 },
  ]);
  assert.deepEqual(parsed['agy-third-party'], [
    { remaining: 90, minutes: 300, resetsAt: 1793976000 },
    { remaining: 70, minutes: 10080, resetsAt: 1794333000 },
  ]);
});
