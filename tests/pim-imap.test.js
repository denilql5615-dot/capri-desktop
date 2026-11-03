'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createImapAdapter, textPart } = require('../src/main/pim-imap');

test('IMAP adapter reads summaries and full text through a read-only loopback connection', async () => {
  const calls = [];
  const row = {
    uid: 7, envelope: { from: [{ address: 'work@example.test' }], to: [{ address: 'me@example.test' }], subject: 'План', date: new Date('2026-11-03T12:00:00Z') },
    flags: new Set(), bodyStructure: { type: 'multipart/alternative', childNodes: [{ type: 'text/plain', part: '1' }] },
  };
  const clientFactory = (config) => ({
    connect: async () => calls.push(['connect', config]),
    mailboxOpen: async (...args) => calls.push(['open', ...args]),
    search: async () => [7], fetchAll: async () => [row], fetchOne: async () => row,
    download: async (_uid, part, options) => ({ meta: { contentType: 'text/plain' }, content: Readable.from([`текст ${part} ${options.maxBytes}`]) }),
    logout: async () => calls.push(['logout']),
  });
  const adapter = createImapAdapter({ id: 'proton_work', provider: 'proton', role: 'work', host: '127.0.0.1', port: 1143, user: 'bridge', password: 'secret' }, clientFactory);

  const found = await adapter.searchMail({ query: 'план', limit: 10 });
  assert.deepEqual(found[0], { id: '7', from: 'work@example.test', subject: 'План', date: '2026-11-03T12:00:00.000Z', snippet: 'текст 1 1000', unread: true });
  assert.equal((await adapter.getMail('7')).body, 'текст 1 200000');
  assert.equal(calls[0][1].logger, false);
  assert.deepEqual(calls[1], ['open', 'INBOX', { readOnly: true }]);
});

test('IMAP adapter rejects remote hosts by default and prefers plain text', () => {
  assert.throws(() => createImapAdapter({ id: 'x', host: 'imap.example.test', port: 993, user: 'u', password: 'p' }), /remote/);
  assert.equal(textPart({ type: 'multipart/alternative', childNodes: [{ type: 'text/html', part: '2' }, { type: 'text/plain', part: '1' }] }), '1');
});
