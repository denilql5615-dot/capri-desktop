'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshot, line } = require('../scripts/claude-statusline');

test('Claude status line keeps observed quotas and leaves missing limits and resets unknown', () => {
  assert.equal(snapshot({ model: 'Claude' }), null);
  const snap = snapshot({ rate_limits: {
    five_hour: { used_percentage: 0, resets_at: null },
    seven_day: { used_percentage: 73.5, resets_at: 1795564800 },
    seven_day_sonnet: { used_percentage: null },
  } });
  assert.deepEqual(snap.windows, {
    five_hour: { used: 0, resetsAt: null },
    seven_day: { used: 73.5, resetsAt: 1795564800 },
  });
  assert.equal(line(snap), '5ч 100% · нед 27%');
});
