'use strict';

const test = require('node:test');
const assert = require('node:assert');
const browser = require('../src/main/browser');
const web = require('../src/main/web');

const app = { getPath: () => 'C:/tmp/userdata' };

// a fake Playwright persistent context: one page whose title and text we choose
function fakeLaunch(title, text, seen = {}) {
  return async (dir, opts) => {
    seen.dir = dir; seen.opts = opts;
    const page = {
      goto: async (url) => { seen.url = url; },
      title: async () => title,
      evaluate: async () => text,
    };
    return { pages: () => [page], newPage: async () => page, close: async () => { seen.closed = true; } };
  };
}

test('readRendered: own profile, headless, text after scripts, closed afterwards', async () => {
  const seen = {};
  const long = 'A paragraph about the outage that is long enough to keep in the text.\n'.repeat(8);
  const r = await browser.readRendered('https://news.example/x', { app, launch: fakeLaunch('Outage news', long, seen) });
  assert.match(seen.dir.replace(/\\/g, '/'), /userdata\/capri-browser$/);
  assert.strictEqual(seen.opts.headless, true);
  assert.strictEqual(seen.closed, true);
  assert.strictEqual(r.blocked, false);
  assert.match(r.text, /about the outage/);
});

test('readRendered: a human check is reported, never solved', async () => {
  const r = await browser.readRendered('https://x.example/', { app, launch: fakeLaunch('Just a moment...', 'Checking your browser before accessing') });
  assert.deepStrictEqual([r.blocked, r.text], [true, '']);
  assert.deepStrictEqual(await browser.readRendered('file:///c:/x', { app, launch: fakeLaunch('', '') }), { text: '', title: '', blocked: false });
});

test('answer: an empty page goes to her browser; a blocked one is handed back', async () => {
  const fetchImpl = async (url) => (url.includes('/search?')
    ? { ok: true, json: async () => ({ results: [{ title: 'SPA', url: 'https://spa.example/a' }, { title: 'Wall', url: 'https://wall.example/b' }] }) }
    : { ok: true, headers: { get: () => 'text/html' }, text: async () => '<div id=app></div>' });
  const rendered = [];
  const r = await web.answer('q', {
    url: 'http://x', fetchImpl,
    render: async (url) => { rendered.push(url); return url.includes('wall') ? { blocked: true, text: '' } : { blocked: false, text: 'Rendered text of the app page with the actual answer in it.' }; },
    chat: async (m) => { assert.match(m[1].content, /Rendered text of the app page/); return 'ok [1]'; },
  });
  assert.deepStrictEqual(rendered, ['https://spa.example/a', 'https://wall.example/b']);
  assert.deepStrictEqual(r.blocked, ['https://wall.example/b']);
});
