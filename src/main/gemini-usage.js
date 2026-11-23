'use strict';

const USAGE_URL = 'https://gemini.google.com/usage';
const MONTHS_RU = 'янв фев мар апр май июн июл авг сен окт ноя дек'.split(' ');
const MONTHS_EN = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
const PERIODS = /текущее использование|недельный лимит|current usage|weekly limit/i;

function resetTime(text, datetime, now) {
  if (datetime) {
    const timestamp = Date.parse(datetime);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  const reset = /(?:лимит сбросится|resets?)\s+([^%]*?)(\d{1,2}):(\d{2})(?:\s*([ap]m))?/i.exec(text);
  if (!reset) return null;
  const [, date, hours, minutes, meridiem] = reset;
  const hour = meridiem ? Number(hours) % 12 + (/pm/i.test(meridiem) ? 12 : 0) : Number(hours);
  if (hour > 23 || Number(minutes) > 59) return null;
  const next = new Date(now);
  next.setHours(hour, Number(minutes), 0, 0);
  const dayFirst = /(\d{1,2})\s+([a-zа-я]{3,})/i.exec(date);
  const monthFirst = /([a-zа-я]{3,})\.?\s+(\d{1,2})/i.exec(date);
  const monthPrefix = (dayFirst?.[2] || monthFirst?.[1] || '').slice(0, 3).toLowerCase();
  const month = Math.max(MONTHS_RU.indexOf(monthPrefix), MONTHS_EN.indexOf(monthPrefix));
  if (month >= 0) {
    const day = Number(dayFirst?.[1] || monthFirst?.[2]);
    next.setMonth(month, day);
    if (next.getMonth() !== month) return null;
    if (next < now && now.getMonth() === 11 && month === 0) next.setFullYear(next.getFullYear() + 1);
  } else if (next < now && (date.trim() === 'в' || date.trim() === 'at' || !date.trim())) {
    next.setDate(next.getDate() + 1);
  } else if (date.trim() && !/^(?:в|at|today at|сегодня в)$/i.test(date.trim())) {
    return null;
  }
  return next.getTime();
}

function parseUsage(rows, now = new Date()) {
  const windows = new Map();
  for (const { text, datetime, ariaValue } of rows) {
    const kind = /недельный лимит|weekly limit/i.test(text) ? 'week' : /текущее использование|current usage/i.test(text) ? '5h' : null;
    const usedText = /(?:использовано|used)\s*(\d+(?:[.,]\d+)?)\s*%|(\d+(?:[.,]\d+)?)\s*%\s*used/i.exec(text);
    const used = Number((usedText?.[1] || usedText?.[2] || ariaValue || '').replace(',', '.'));
    if (!kind || (!usedText && !ariaValue) || !Number.isFinite(used) || used < 0 || used > 100) continue;
    windows.set(kind, { kind, remaining: 100 - used, resetsAt: resetTime(text, datetime, now) });
  }
  return [...windows.values()];
}

async function readUsageIn(page) {
  const previous = page.url();
  const busy = await page.evaluate(() => {
    const labels = [...document.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label'));
    return labels.some((label) => /stop response|остановить/i.test(label)) ||
      Boolean(document.querySelector('rich-textarea .ql-editor')?.textContent.trim());
  });
  if (busy) return [];
  const navigation = { waitUntil: 'domcontentloaded', timeout: 8000 };
  try {
    await page.goto(USAGE_URL, navigation);
    await page.waitForFunction((pattern) => {
      return [...document.querySelectorAll('[role="option"], li')].some((row) =>
        new RegExp(pattern, 'i').test(row.textContent) && /%|aria-valuenow/.test(row.innerHTML));
    }, { timeout: 6000 }, PERIODS.source);
    const rows = await page.evaluate(() => [...document.querySelectorAll('[role="option"], li')].map((row) => ({
      text: `${row.getAttribute('aria-label') || ''} ${row.textContent}`.replace(/\s+/g, ' ').trim(),
      datetime: row.querySelector('time[datetime]')?.getAttribute('datetime'),
      ariaValue: row.querySelector('[role="progressbar"][aria-valuenow]')?.getAttribute('aria-valuenow'),
    })));
    return parseUsage(rows);
  } finally {
    await page.goto(previous, navigation).catch(() => {});
  }
}

module.exports = { parseUsage, readUsageIn };
