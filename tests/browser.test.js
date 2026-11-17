'use strict';

const test = require('node:test');
const assert = require('node:assert');
const browser = require('../src/main/browser');
const web = require('../src/main/web');

const app = { getPath: () => 'C:/tmp/userdata' };
const pick = { name: 'LibreWolf', kind: 'firefox', exe: 'C:/x/librewolf.exe' };

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
  const r = await browser.readRendered('https://news.example/x', { app, pick, launch: fakeLaunch('Outage news', long, seen) });
  assert.match(seen.dir.replace(/\\/g, '/'), /userdata\/capri-browser\/librewolf$/);
  assert.strictEqual(seen.opts.headless, true);
  assert.strictEqual(seen.opts.browser, pick);
  assert.strictEqual(r.browser, 'LibreWolf');
  assert.strictEqual(seen.closed, true);
  assert.strictEqual(r.blocked, false);
  assert.match(r.text, /about the outage/);
});

test('readRendered: a human check is reported, never solved', async () => {
  const r = await browser.readRendered('https://x.example/', { app, pick, launch: fakeLaunch('Just a moment...', 'Checking your browser before accessing') });
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

test('resolve: auto follows the Windows default, a name or a path picks, the undrivable fall through', { skip: process.platform !== 'win32' }, () => {
  const has = (want) => (p) => want.some((w) => p.toLowerCase().endsWith(w.toLowerCase()));
  const exists = has([String.raw`LibreWolf\librewolf.exe`, String.raw`BraveSoftware\Brave-Browser\Application\brave.exe`, String.raw`D:\Apps\Floorp\floorp.exe`]);
  assert.strictEqual(browser.resolve('auto', { exists, defaultExe: String.raw`C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe` }).name, 'Brave');
  assert.strictEqual(browser.resolve('librewolf', { exists, defaultExe: null }).kind, 'firefox');
  assert.strictEqual(browser.resolve(String.raw`D:\Apps\Floorp\floorp.exe`, { exists, defaultExe: null }).kind, 'firefox');
  const safari = browser.resolve('auto', { exists, defaultExe: String.raw`C:\x\Safari.exe` });
  assert.strictEqual(safari.name, 'LibreWolf');
  assert.match(safari.note, /нельзя/);
  assert.match(browser.resolve('IronFox', { exists, defaultExe: null }).note, /IronFox/);
  assert.strictEqual(browser.resolve('auto', { exists: () => false, defaultExe: null }), null);
});

test('kindOf: Firefox forks over BiDi, Chromium ones over CDP, Safari/IronFox/Fennec none', () => {
  assert.deepStrictEqual(['firefox.exe', 'librewolf.exe', 'zen.exe', 'brave.exe', 'msedge.exe', 'vivaldi.exe', 'Safari.exe', 'ironfox', 'fennec.exe'].map(browser.kindOf),
    ['firefox', 'firefox', 'firefox', 'chrome', 'chrome', 'chrome', null, null, null]);
});
