'use strict';

// 2.8a: one snapshot of all cloud limits, micro-labels, pace per source, swarm plate linger.

const test = require('node:test');
const assert = require('node:assert/strict');
const { QuotaHub, GROUPS, groupFor, toBars } = require('../src/main/quota-hub');
const { snapshot: statusSnapshot, line: statusLine } = require('../scripts/claude-statusline');

test('groups: Argon shares the Neon/Hydrogen pool; Opus/Sonnet in Antigravity is its own group', () => {
  const byId = Object.fromEntries(GROUPS.map((g) => [g.id, g]));
  assert.equal(byId['agy-argon'], undefined);
  assert.equal(byId['agy-gemini'].label, 'Antigravity Neon/Hydrogen/Argon');
  assert.equal(byId['agy-third-party'].label, 'Antigravity Opus/Sonnet');
  assert.equal(groupFor('claude'), 'claude');
  assert.equal(groupFor('codex', 'gpt-6.2-sol'), 'codex');
  assert.equal(groupFor('gemini', 'gemini-4-argon-high'), 'agy-gemini');
  assert.equal(groupFor('gemini', 'claude-opus-5-5'), 'agy-third-party');
  assert.equal(groupFor('gemini', 'gemini-4-hydrogen'), 'agy-gemini');
  assert.equal(groupFor('gemini-web'), 'web-gemini');
  assert.equal(groupFor('ollama'), null);
});

test('bars: micro-labels, order, seconds or ms resets, a rolled-over window reads full', () => {
  const now = 1_800_000_000_000;
  const bars = toBars('claude', [
    { remaining: 12.34, minutes: 10080, resetsAt: (now + 3600e3) / 1000 },
    { remaining: 40, minutes: 300, resetsAt: now - 1000 },
  ], now);
  assert.deepEqual(bars.map((b) => b.label), ['Claude 5 часов', 'Claude Неделя']);
  assert.equal(bars[0].remaining, 100);
  assert.equal(bars[0].rolledOver, true);
  assert.equal(bars[1].remaining, 12.3);
  assert.equal(bars[1].resetsAt, now + 3600e3);
  const unknownReset = toBars('claude', [{ remaining: 40, minutes: 300, resetsAt: null }], now)[0];
  assert.equal(unknownReset.remaining, 40);
  assert.equal(unknownReset.resetsAt, null);
  assert.deepEqual(toBars('agy-gemini', [{ remaining: 50, minutes: 300 }, { remaining: 70, minutes: 10080 }], now).map((b) => b.label),
    ['Antigravity Neon/Hydrogen/Argon 5 часов', 'Antigravity Neon/Hydrogen/Argon Неделя']);
});

function hub({ shown = [] } = {}) {
  let now = 1_800_000_000_000;
  const asked = { claude: 0, codex: 0, agy: 0, webGemini: 0 };
  const updates = [];
  const h = new QuotaHub({
    now: () => now,
    onUpdate: (s) => updates.push(s),
    readers: {
      claude: async () => { asked.claude += 1; return { windows: [{ remaining: 66, minutes: 300 }, { remaining: 88, minutes: 10080 }], checkedAt: now - 1000 }; },
      codex: async () => { asked.codex += 1; return [{ remaining: 50, minutes: 300 }, { remaining: 75, minutes: 10080 }]; },
      agy: async () => { asked.agy += 1; return { 'agy-gemini': [{ remaining: 30, minutes: 10080 }], checkedAt: {} }; },
      webGemini: async () => { asked.webGemini += 1; return null; },
    },
  });
  h.setShown(shown);
  return { h, asked, updates, tick: (ms) => { now += ms; } };
}

test('refresh asks each source at its own pace and faster while its bar is shown', async () => {
  const { h, asked, updates, tick } = hub({ shown: ['codex'] });
  const first = await h.refresh();
  assert.deepEqual(asked, { claude: 1, codex: 1, agy: 1, webGemini: 0 });
  assert.equal(updates.length, 1);
  const codex = first.groups.find((g) => g.id === 'codex');
  assert.deepEqual(codex.bars.map((b) => [b.label, b.remaining]), [['Codex 5 часов', 50], ['Codex Неделя', 75]]);
  assert.equal(first.groups.find((g) => g.id === 'web-gemini').stale, true);

  tick(61e3);
  await h.refresh();
  assert.equal(asked.codex, 2); // shown: every minute
  assert.equal(asked.agy, 1); // hidden: 15 minutes
  assert.equal(asked.claude, 2); // a file: every minute

  h.setShown(['web-gemini']);
  await h.refresh({ groups: ['web-gemini'] });
  assert.equal(asked.webGemini, 1);
  await h.refresh({ force: true });
  assert.equal(asked.webGemini, 2);
  assert.equal(asked.agy, 2);
});

test('live push and the swarm plate: active groups stay 6 s after the end', async () => {
  const { h, tick } = hub();
  assert.equal(h.push('codex', [{ remaining: 20, minutes: 300 }], 'live'), true);
  assert.equal(h.push('nope', [{ remaining: 20, minutes: 300 }]), false);
  h.track('agy-gemini', 'swarm');
  const finishCodex = h.track('codex', 'swarm');
  const finishOtherCodex = h.track('codex', 'swarm');
  h.track('claude', 'chat');
  assert.deepEqual(h.snapshot().active.sort(), ['agy-gemini', 'codex']);
  assert.deepEqual(h.snapshot().activity.chat, ['claude']);
  finishCodex();
  tick(7000);
  assert.deepEqual(h.snapshot().active.sort(), ['agy-gemini', 'codex']);
  finishOtherCodex();
  tick(5000);
  assert.deepEqual(h.snapshot().active.sort(), ['agy-gemini', 'codex']);
  tick(1500);
  assert.deepEqual(h.snapshot().active, ['agy-gemini']);
});

test('a failing source does not break the snapshot; old data is marked stale', async () => {
  const { h, tick } = hub();
  h.readers.codex = async () => { throw new Error('codex is gone'); };
  const snap = await h.refresh();
  assert.equal(snap.groups.find((g) => g.id === 'codex').bars.length, 0);
  assert.equal(snap.groups.find((g) => g.id === 'claude').stale, false);
  tick(31 * 60e3);
  assert.equal(h.snapshot().groups.find((g) => g.id === 'claude').stale, true);
});

test('Claude status line: keeps only limit numbers and prints remaining', () => {
  const snap = statusSnapshot({
    session_id: 'secret-session', cwd: 'D:/private', model: { id: 'x' },
    rate_limits: { five_hour: { used_percentage: 34.2, resets_at: 1795460000 }, seven_day: { used_percentage: 12 }, spend_limit: { used_usd: 5 } },
  });
  assert.deepEqual(Object.keys(snap.windows).sort(), ['five_hour', 'seven_day']);
  assert.equal(JSON.stringify(snap).includes('secret'), false);
  assert.equal(statusLine(snap), '5ч 66% · нед 88%');
  assert.equal(statusSnapshot({ model: {} }), null);
});
