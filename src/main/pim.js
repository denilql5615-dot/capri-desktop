'use strict';

const MAX_RESULTS = 25;
const ID = /^[a-z][a-z0-9_-]{1,63}$/;

function text(value, max) {
  return String(value || '').replace(/\0/g, '').trim().slice(0, max);
}

function limit(value) {
  const n = Number(value);
  return Number.isInteger(n) ? Math.max(1, Math.min(n, MAX_RESULTS)) : 10;
}

function sealSecrets(input, seal) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof seal !== 'function') throw new TypeError('invalid PIM secrets');
  const entries = Object.entries(input);
  if (entries.length > 20) throw new TypeError('too many PIM secrets');
  return Object.fromEntries(entries.map(([key, value]) => {
    if (!ID.test(key) || typeof value !== 'string' || value.length > 4096) throw new TypeError('invalid PIM secret');
    return [key, value ? seal(value) : null];
  }));
}

function publicConfig(config) {
  const { apiKeys, phoneToken, telegramToken, pimSecrets, ...safe } = config || {};
  return safe;
}

function parseLocalEndpoint(value) {
  const match = /^(127\.0\.0\.1|localhost):(\d{1,5})$/i.exec(String(value || '').trim());
  const port = Number(match?.[2]);
  if (!match || port < 1 || port > 65535) throw new TypeError('invalid local PIM endpoint');
  return { host: match[1].toLowerCase(), port };
}

class PimService {
  constructor(adapters = []) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      if (!ID.test(adapter?.id || '') || this.adapters.has(adapter.id)) throw new TypeError('invalid or duplicate PIM account id');
      this.adapters.set(adapter.id, adapter);
    }
  }

  listAccounts() {
    return [...this.adapters.values()].map(({ id, provider, role, searchMail, listEvents }) => ({
      id, provider: text(provider, 40), role: text(role, 40),
      capabilities: [...(searchMail ? ['mail'] : []), ...(listEvents ? ['calendar'] : [])],
    }));
  }

  account(id, method) {
    const adapter = this.adapters.get(String(id || ''));
    if (!adapter) throw new Error('unknown PIM account');
    if (typeof adapter[method] !== 'function') throw new Error('PIM capability unavailable');
    return adapter;
  }

  async searchMail({ accountId, query = '', limit: count } = {}) {
    const adapter = this.account(accountId, 'searchMail');
    const rows = await adapter.searchMail({ query: text(query, 200), limit: limit(count) });
    return (Array.isArray(rows) ? rows : []).slice(0, limit(count)).map((mail) => ({
      id: text(mail.id, 200), accountId: adapter.id, from: text(mail.from, 300), subject: text(mail.subject, 500),
      date: text(mail.date, 80), snippet: text(mail.snippet, 800), unread: Boolean(mail.unread), untrusted: true,
    })).filter((mail) => mail.id);
  }

  async getMail({ accountId, id } = {}) {
    const mailId = text(id, 200);
    if (!mailId) throw new TypeError('mail id is required');
    const adapter = this.account(accountId, 'getMail');
    const mail = await adapter.getMail(mailId);
    if (!mail) return null;
    return {
      id: mailId, accountId: adapter.id, from: text(mail.from, 300), to: text(mail.to, 1000), subject: text(mail.subject, 500),
      date: text(mail.date, 80), body: text(mail.body, 200000), untrusted: true,
    };
  }

  async listEvents({ accountId, from, to, limit: count } = {}) {
    const adapter = this.account(accountId, 'listEvents');
    const rows = await adapter.listEvents({ from: text(from, 80), to: text(to, 80), limit: limit(count) });
    return (Array.isArray(rows) ? rows : []).slice(0, limit(count)).map((event) => ({
      id: text(event.id, 200), accountId: adapter.id, title: text(event.title, 500), start: text(event.start, 80),
      end: text(event.end, 80), location: text(event.location, 500), description: text(event.description, 4000), untrusted: true,
    })).filter((event) => event.id);
  }
}

module.exports = { PimService, MAX_RESULTS, sealSecrets, publicConfig, parseLocalEndpoint };
