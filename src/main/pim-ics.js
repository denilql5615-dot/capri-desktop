'use strict';

const ICAL = require('ical.js');

const MAX_ICS_BYTES = 2 * 1024 * 1024;
const MAX_OCCURRENCES = 1000;

function protonUrl(value) {
  const url = new URL(String(value || '').trim());
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !(host === 'proton.me' || host.endsWith('.proton.me')) || url.username || url.password) {
    throw new TypeError('invalid Proton Calendar URL');
  }
  return url;
}

async function download(url, fetcher) {
  let current = protonUrl(url);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const response = await fetcher(current, { redirect: 'manual', headers: { accept: 'text/calendar, text/plain;q=0.9' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      current = protonUrl(new URL(response.headers.get('location'), current));
      continue;
    }
    if (!response.ok) throw new Error('calendar download failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_ICS_BYTES) throw new Error('invalid calendar size');
    return bytes.toString('utf8');
  }
  throw new Error('too many calendar redirects');
}

function eventRow(event, start = event.startDate, end = event.endDate) {
  const startMs = start.toJSDate().getTime();
  const endMs = end.toJSDate().getTime();
  return {
    id: `${event.uid || 'event'}:${startMs}`,
    title: String(event.summary || ''), start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
    location: String(event.location || ''), description: String(event.description || ''),
  };
}

function parseEvents(source, from, to, limit) {
  const root = new ICAL.Component(ICAL.parse(source));
  const rangeStart = ICAL.Time.fromJSDate(new Date(from), true);
  const rows = [];
  for (const component of root.getAllSubcomponents('vevent')) {
    if (component.hasProperty('recurrence-id')) continue;
    const event = new ICAL.Event(component);
    if (!event.isRecurring()) {
      const row = eventRow(event);
      if (Date.parse(row.start) <= to && Date.parse(row.end) >= from) rows.push(row);
      continue;
    }
    const iterator = new ICAL.RecurExpansion({ component: event.component, dtstart: event.startDate, last: rangeStart });
    for (let count = 0; count < MAX_OCCURRENCES; count += 1) {
      const next = iterator.next();
      if (!next || next.toJSDate().getTime() > to) break;
      const occurrence = event.getOccurrenceDetails(next);
      rows.push(eventRow(occurrence.item, occurrence.startDate, occurrence.endDate));
    }
  }
  return rows.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, limit);
}

function createIcsAdapter(options, fetcher = fetch) {
  const { id, provider, role, url } = options || {};
  if (!id || !url || typeof fetcher !== 'function') throw new TypeError('invalid ICS config');
  protonUrl(url);
  return {
    id, provider, role,
    listEvents: async ({ from, to, limit }) => {
      const start = Date.parse(from);
      const end = Date.parse(to);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 366 * 86400000) throw new TypeError('invalid calendar range');
      return parseEvents(await download(url, fetcher), start, end, limit);
    },
  };
}

module.exports = { createIcsAdapter, parseEvents, protonUrl };
