'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../src/main/gemini');

// a fake Gemini tab: answers after a few polls, "Stop" shown while it writes
function fakePage({ signedIn = true, polls = 3, reply = 'Париж' } = {}) {
  const seen = { url: null, inserted: '', sent: false, clicks: 0 };
  let n = 0;
  let responses = 0;
  const page = {
    goto: async (u) => { seen.url = u; },
    waitForSelector: async () => {},
    click: async () => { seen.clicks++; },
    keyboard: { press: async () => { seen.sent = true; } },
    evaluate: async (fn, arg) => {
      const src = String(fn);
      if (src.includes('insertText')) { seen.inserted = arg; return undefined; }
      if (src.includes('send message')) { seen.sent = true; responses = 1; return true; }
      // state()
      if (seen.sent) n++;
      const writing = seen.sent && n < polls;
      return { signedIn, busy: writing, count: responses, text: seen.sent ? (writing ? reply.slice(0, 2) : reply) : '', path: seen.sent ? '/app/ccfa5ca0a07a98a5' : '/app' };
    },
  };
  return { page, seen };
}

test('askIn: one insert of the whole prompt, sent, waits for "Stop" to go and the text to settle', async () => {
  const { page, seen } = fakePage();
  const r = await gemini.askIn(page, 'Оцени план:\n1) …', { pollMs: 1 });
  assert.deepEqual(r, { answer: 'Париж', chat: 'ccfa5ca0a07a98a5', signedIn: true });
  assert.equal(seen.url, 'https://gemini.google.com/app');
  assert.equal(seen.inserted, 'Оцени план:\n1) …');
});

test('askIn: a chat id continues that conversation; signed out → told to sign in, nothing sent', async () => {
  const a = fakePage();
  await gemini.askIn(a.page, 'ещё', { chat: 'https://gemini.google.com/app/ccfa5ca0a07a98a5', pollMs: 1 });
  assert.equal(a.seen.url, 'https://gemini.google.com/app/ccfa5ca0a07a98a5');
  const b = fakePage({ signedIn: false });
  await assert.rejects(gemini.askIn(b.page, 'x', { pollMs: 1 }), /не выполнен вход в Google/);
  assert.equal(b.seen.inserted, '');
});

test('ask: one question at a time, a pause between them, the session closed each time', async () => {
  const order = [];
  let closes = 0;
  const open = async () => ({
    withTab: async (fn) => { const { page } = fakePage({ reply: `ответ ${order.length}` }); order.push('start'); const r = await fn(page); order.push('end'); return r; },
    close: async () => { closes++; },
  });
  const [x, y] = await Promise.all([gemini.ask('a', { open, pollMs: 1, minGapMs: 5 }), gemini.ask('b', { open, pollMs: 1, minGapMs: 5 })]);
  assert.deepEqual(order, ['start', 'end', 'start', 'end']); // never two at once
  assert.equal(closes, 2);
  assert.ok(x.answer && y.answer);
});
