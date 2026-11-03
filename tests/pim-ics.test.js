'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createIcsAdapter, protonUrl } = require('../src/main/pim-ics');

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Capri Test//EN',
  'BEGIN:VEVENT', 'UID:once', 'DTSTART:20261104T090000Z', 'DTEND:20261104T100000Z', 'SUMMARY:Созвон', 'LOCATION:Proton Meet', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:daily', 'DTSTART:20261103T120000Z', 'DTEND:20261103T123000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Статус', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

test('Proton ICS adapter is read-only, bounded, and expands recurring events', async () => {
  const fetcher = async () => new Response(ICS, { status: 200, headers: { 'content-type': 'text/calendar' } });
  const adapter = createIcsAdapter({ id: 'proton_calendar', provider: 'proton', role: 'calendar', url: 'https://calendar.proton.me/share/test' }, fetcher);
  const rows = await adapter.listEvents({ from: '2026-11-03T00:00:00Z', to: '2026-11-05T23:59:59Z', limit: 10 });
  assert.deepEqual(rows.map(({ title }) => title), ['Статус', 'Созвон', 'Статус', 'Статус']);
  assert.equal(rows[1].location, 'Proton Meet');
  assert.throws(() => protonUrl('http://127.0.0.1/calendar.ics'), /invalid/);
  assert.throws(() => protonUrl('https://evil.test/calendar.ics'), /invalid/);
});
