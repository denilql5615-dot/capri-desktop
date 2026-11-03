'use strict';

const { ImapFlow } = require('imapflow');

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function addresses(list) {
  return (list || []).map((item) => item.address || item.name || '').filter(Boolean).join(', ');
}

function findPart(node, type) {
  if (!node) return null;
  if (node.type === type) return node.part || '1';
  for (const child of node.childNodes || []) {
    const found = findPart(child, type);
    if (found) return found;
  }
  return null;
}

const textPart = (node) => findPart(node, 'text/plain') || findPart(node, 'text/html');

async function readText(client, uid, structure, maxBytes) {
  const part = textPart(structure);
  if (!part) return '';
  const download = await client.download(String(uid), part, { uid: true, maxBytes, decodeText: true });
  if (!download.content) return '';
  let body = '';
  for await (const chunk of download.content) body += chunk.toString('utf8');
  if (download.meta?.contentType === 'text/html') body = body.replace(/<[^>]*>/g, ' ');
  return body.replace(/\s+/g, ' ').trim().slice(0, maxBytes);
}

function createImapAdapter(options, clientFactory = (config) => new ImapFlow(config)) {
  const { id, provider, role, host, port, secure = false, user, password, mailbox = 'INBOX', localOnly = true } = options || {};
  if (!id || !host || !Number.isInteger(port) || port < 1 || port > 65535 || !user || !password) throw new TypeError('invalid IMAP config');
  if (localOnly && !LOOPBACK.has(String(host).toLowerCase())) throw new TypeError('remote IMAP host is not allowed');
  if (!localOnly && !(String(host).toLowerCase() === 'imap.gmail.com' && port === 993 && secure)) throw new TypeError('remote IMAP config is not allowed');

  const run = async (task) => {
    const client = clientFactory({
      host, port, secure: Boolean(secure), auth: { user, pass: password }, logger: false,
      doSTARTTLS: localOnly && !secure, tls: { rejectUnauthorized: !localOnly },
    });
    await client.connect();
    try {
      await client.mailboxOpen(mailbox, { readOnly: true });
      return await task(client);
    } finally {
      await client.logout().catch(() => {});
    }
  };

  return {
    id, provider, role,
    searchMail: ({ query, limit }) => run(async (client) => {
      const found = await client.search(query ? { text: query } : { all: true }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).slice(-limit).reverse();
      if (!uids.length) return [];
      const rows = await client.fetchAll(uids, { uid: true, envelope: true, flags: true, bodyStructure: true }, { uid: true });
      const byUid = new Map(rows.map((row) => [row.uid, row]));
      const out = [];
      for (const uid of uids) {
        const row = byUid.get(uid);
        if (!row) continue;
        out.push({
          id: String(uid), from: addresses(row.envelope?.from), subject: row.envelope?.subject || '',
          date: row.envelope?.date?.toISOString?.() || String(row.envelope?.date || ''),
          snippet: await readText(client, uid, row.bodyStructure, 1000), unread: !row.flags?.has('\\Seen'),
        });
      }
      return out;
    }),
    getMail: (uid) => run(async (client) => {
      if (!/^\d+$/.test(String(uid))) throw new TypeError('invalid IMAP uid');
      const row = await client.fetchOne(String(uid), { uid: true, envelope: true, bodyStructure: true }, { uid: true });
      if (!row) return null;
      return {
        from: addresses(row.envelope?.from), to: addresses(row.envelope?.to), subject: row.envelope?.subject || '',
        date: row.envelope?.date?.toISOString?.() || String(row.envelope?.date || ''),
        body: await readText(client, uid, row.bodyStructure, 200000),
      };
    }),
  };
}

module.exports = { createImapAdapter, textPart };
