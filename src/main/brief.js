'use strict';

// Her morning brief (a task on a schedule): once a day at the time you set (config morningBrief.time,
// 09:00 by default) she comes out and says your day: what's on the calendar and in her planner.
// The PC on later: still that morning, up to LATE_HOURS after; past that, the day goes without one.

const LATE_HOURS = 4;
const DEFAULTS = { enabled: true, time: '09:00', last: null };

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "09:00" -> minutes after midnight (bad: the default's). */
function minutesOf(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  const h = m ? Number(m[1]) : NaN;
  const min = m ? Number(m[2]) : NaN;
  return h >= 0 && h < 24 && min >= 0 && min < 60 ? h * 60 + min : 9 * 60;
}

/** Whether it's time for today's brief: on, past its time, not too late, not said yet today. */
function isDue(settings, now = new Date()) {
  const s = { ...DEFAULTS, ...settings };
  if (!s.enabled || s.last === dayOf(now)) return false;
  const at = minutesOf(s.time);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= at && nowMin < at + LATE_HOURS * 60;
}

const GREETINGS = ['Доброе утро.', 'Утро. Я тут.', 'Доброе утро, проснулся?'];

/** Her brief: a greeting and your day (quick.scheduleAnswer's lines for today). */
function text(schedule, now = new Date(), pick = (list) => list[now.getDate() % list.length]) {
  return `${pick(GREETINGS)} ${String(schedule || '').trim()}`.trim();
}

module.exports = { DEFAULTS, LATE_HOURS, isDue, minutesOf, text, dayOf };
