'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isDue, minutesOf, text, dayOf } = require('../src/main/brief');

const at = (h, m = 0) => new Date(2026, 10, 4, h, m);

test('isDue: from its time for four hours, once a day, only when on', () => {
  const s = { enabled: true, time: '09:00', last: null };
  assert.equal(isDue(s, at(8, 59)), false);
  assert.equal(isDue(s, at(9, 0)), true);
  assert.equal(isDue(s, at(12, 59)), true);
  assert.equal(isDue(s, at(13, 0)), false); // too late: the day goes without one
  assert.equal(isDue({ ...s, last: '2026-11-04' }, at(9, 30)), false); // said today
  assert.equal(isDue({ ...s, last: '2026-11-03' }, at(9, 30)), true);
  assert.equal(isDue({ ...s, enabled: false }, at(9, 30)), false);
  assert.equal(isDue(undefined, at(9, 30)), true); // the defaults
});

test('minutesOf: a time you set, a bad one is 09:00', () => {
  assert.equal(minutesOf('07:45'), 7 * 60 + 45);
  assert.equal(minutesOf('7:05'), 7 * 60 + 5);
  assert.equal(minutesOf('25:00'), 540);
  assert.equal(minutesOf('утром'), 540);
});

test('text: a greeting and your day; dayOf is your local day', () => {
  const t = text('Сегодня у тебя одно дело:\n• 10:00 — Созвон', at(9), (list) => list[0]);
  assert.equal(t, 'Доброе утро. Сегодня у тебя одно дело:\n• 10:00 — Созвон');
  const withMail = text('Сегодня у тебя одно дело:\n• 10:00 — Созвон', at(9), (list) => list[0], 'Непрочитанных писем: 2.');
  assert.equal(withMail, 'Доброе утро. Сегодня у тебя одно дело:\n• 10:00 — Созвон\n\nНепрочитанных писем: 2.');
  assert.equal(dayOf(at(0, 30)), '2026-11-04');
});
