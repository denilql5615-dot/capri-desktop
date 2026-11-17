'use strict';

const test = require('node:test');
const assert = require('node:assert');
const browser = require('../src/main/browser');
const web = require('../src/main/web');

const app = { getPath: () => 'C:/tmp/userdata' };
const pick = { name: 'LibreWolf', engine: 'firefox', exe: 'C:/x/librewolf.exe' };
const fast = { settleMs: 0, pollMs: 1, challengeWaitMs: 5 };

// a fake browser: one page; titles is a list, one per look (the last one stays)
function fakeLaunch(titles, text, seen = {}) {
  const list = [].concat(titles);
  return async (dir, opts) => {
    seen.dir = dir; seen.opts = opts;
    let n = 0;
    const page = {
      goto: async (url) => { seen.url = url; },
      title: async () => list[Math.min(n++, list.length - 1)],
      evaluate: async () => text,
    };
    return { pages: () => [page], newPage: async () => page, close: async () => { seen.closed = true; } };
  };
}

const long = 'A paragraph about the outage that is long enough to keep in the text.\n'.repeat(8);

test('readRendered: own profile, headless, own protocol, text after scripts, closed afterwards', async () => {
  const seen = {};
  const r = await browser.readRendered('https://news.example/x', { app, pick, ...fast, launch: fakeLaunch('Outage news', long, seen) });
  assert.match(seen.dir.replace(/\\/g, '/'), /userdata\/capri-browser\/librewolf$/);
  assert.strictEqual(seen.opts.headless, true);
  assert.deepStrictEqual(seen.opts.mode, { browser: 'firefox', protocol: 'webDriverBiDi' });
  assert.deepStrictEqual([r.browser, r.blocked, seen.closed], ['LibreWolf', false, true]);
  assert.match(r.text, /about the outage/);
  assert.deepStrictEqual(await browser.readRendered('file:///c:/x', { app, launch: fakeLaunch('', '') }), { text: '', title: '', blocked: false });
});

test('readRendered: a human check that passes by itself is waited out, not cut off', async () => {
  const r = await browser.readRendered('https://x.example/', { app, pick, ...fast, launch: fakeLaunch(['Just a moment...', 'Chase down? Current problems'], long) });
  assert.deepStrictEqual([r.blocked, r.title], [false, 'Chase down? Current problems']);
  assert.match(r.text, /about the outage/);
});

test('readRendered: a check that stays is reported with its link, never solved; the text is kept', async () => {
  const r = await browser.readRendered('https://x.example/', { app, pick, ...fast, launch: fakeLaunch('Just a moment...', 'Checking your browser before accessing the site') });
  assert.deepStrictEqual([r.blocked, r.url], [true, 'https://x.example/']);
  assert.match(r.text, /Checking your browser/);
});

test('start: the first browser that starts wins; Chromium tries CDP, then BiDi', async () => {
  const tried = [];
  const launch = async (dir, o) => {
    tried.push(`${o.browser.name}/${o.mode.protocol}`);
    if (o.browser.name !== 'Brave' || o.mode.protocol !== 'webDriverBiDi') throw new Error('no');
    return fakeLaunch('ok', long)(dir, o);
  };
  const r = await browser.readRendered('https://x.example/', { app, ...fast, launch, pick: [{ name: 'Odd', engine: 'firefox', exe: 'x' }, { name: 'Brave', engine: 'chrome', exe: 'y' }] });
  assert.deepStrictEqual(tried, ['Odd/webDriverBiDi', 'Brave/cdp', 'Brave/webDriverBiDi']);
  assert.strictEqual(r.browser, 'Brave');
  await assert.rejects(browser.readRendered('https://x.example/', { app, ...fast, pick: [pick], launch: async () => { throw new Error('ESET'); } }), /LibreWolf\/webDriverBiDi: ESET/);
});

test('answer: an empty page goes to her browser; a checked one is handed back with its link', async () => {
  const fetchImpl = async (url) => (url.includes('/search?')
    ? { ok: true, json: async () => ({ results: [{ title: 'SPA', url: 'https://spa.example/a' }, { title: 'Wall', url: 'https://wall.example/b' }] }) }
    : { ok: true, headers: { get: () => 'text/html' }, text: async () => '<div id=app></div>' });
  const rendered = [];
  const r = await web.answer('q', {
    url: 'http://x', fetchImpl,
    renderMany: async (urls) => { rendered.push(...urls); return urls.map((u) => (u.includes('wall') ? { blocked: true, text: '' } : { blocked: false, text: 'Rendered text of the app page with the actual answer in it. '.repeat(8) })); },
    chat: async (m) => { assert.match(m[1].content, /Rendered text of the app page/); return 'ok [1]'; },
  });
  assert.deepStrictEqual(rendered, ['https://spa.example/a', 'https://wall.example/b']);
  assert.deepStrictEqual(r.blocked, ['https://wall.example/b']);
});

test('readRenderedMany: one browser for all pages, a tab each; a page that never loads is still read', async () => {
  let launches = 0;
  let tabs = 0;
  const launch = async () => {
    launches++;
    return {
      pages: () => [],
      newPage: async () => {
        tabs++;
        const n = tabs;
        return {
          goto: async () => { if (n === 2) throw new Error('Navigation timeout of 15000 ms exceeded'); },
          title: async () => `Page ${n}`,
          evaluate: async () => (n === 2 ? 'Half-loaded page text that is still long enough to keep in.' : long),
          close: async () => {},
        };
      },
      close: async () => {},
    };
  };
  const r = await browser.readRenderedMany(['https://a.example/', 'https://b.example/', 'https://c.example/'], { app, pick, ...fast, launch });
  assert.deepStrictEqual([launches, tabs, r.length], [1, 3, 3]);
  assert.match(r[1].text, /Half-loaded/);
  assert.match(r[2].text, /about the outage/);
});

// a fake running browser to attach to: pages opened in her window, what got closed
function fakeAttached(seen = {}) {
  seen.opened = []; seen.windows = 0; seen.closed = 0; seen.disconnected = false; seen.browserClosed = false;
  return {
    newPage: async (o = {}) => {
      if (o.type === 'window') seen.windows++;
      return {
        goto: async (url) => { seen.opened.push(url); },
        title: async () => 'Page',
        evaluate: async (fn) => (String(fn).includes('.result') ? [
          { title: 'Ad', href: 'https://duckduckgo.com/y.js?ad_domain=x', snippet: '' },
          { title: 'Real one', href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fa&rut=1', snippet: 'about it' },
        ] : long),
        close: async () => { seen.closed++; },
      };
    },
    disconnect: async () => { seen.disconnected = true; },
    close: async () => { seen.browserClosed = true; },
  };
}

test('your profile: attached over the port, her one window, closed after; your browser left running', async () => {
  const seen = {};
  const s = await browser.openSession({ app, pick, ...fast, profile: 'C:/p/MAIN', connect: async (port) => { seen.port = port; return fakeAttached(seen); } });
  assert.strictEqual(seen.port, browser.DEFAULT_PORT);
  const found = await s.search('кто где');
  assert.deepStrictEqual(found.map((r) => r.url), ['https://real.example/a']);
  const pages = await s.readMany(['https://a.example/', 'https://b.example/']);
  assert.match(pages[1].text, /about the outage/);
  await s.close();
  assert.deepStrictEqual([seen.windows, seen.closed, seen.disconnected, seen.browserClosed], [1, 1, true, false]);
  assert.match(seen.opened[0], /^https:\/\/html\.duckduckgo\.com\/html\/\?q=/);
});

test('your profile: not running → started as itself with the port (never through puppeteer); open without the port → told', async () => {
  let spawned = null;
  let tries = 0;
  const connect = async () => { if (!spawned || ++tries < 2) throw new Error('refused'); return fakeAttached(); };
  const s = await browser.openSession({ app, pick, ...fast, profile: 'C:/p/MAIN', profileBusy: () => false, spawn: (exe, dir, port) => { spawned = { exe, dir, port }; }, connect, startPollMs: 0 });
  assert.deepStrictEqual(spawned, { exe: 'C:/x/librewolf.exe', dir: 'C:/p/MAIN', port: browser.DEFAULT_PORT });
  await s.close();
  await assert.rejects(browser.openSession({ app, pick, profile: 'C:/p/MAIN', profileName: 'MAIN', profileBusy: () => true, connect: async () => { throw new Error('refused'); }, spawn: () => { throw new Error('must not start a 2nd one'); } }), /Профиль «MAIN» открыт без порта управления/);
});

test('answer, browser-only: the search page and the pages come from her browser, nothing is downloaded around it', async () => {
  const fetchImpl = async () => { throw new Error('no plain downloads in browser-only mode'); };
  const r = await web.answer('q', {
    url: 'http://x', fetchImpl,
    browserSearch: async () => [{ title: 'A', url: 'https://a.example/', snippet: 's' }, { title: 'FB', url: 'https://facebook.com/x', snippet: '' }],
    renderMany: async (urls) => urls.map(() => ({ text: 'Rendered page text in her browser. '.repeat(12), blocked: false })),
    chat: async (m) => { assert.match(m[1].content, /Rendered page text/); return 'ok [1]'; },
  });
  assert.deepStrictEqual(r.sources.map((s) => s.url), ['https://a.example/']);
});

// a fake disk: the files that exist; folders are what lies between
function disk(files) {
  const norm = (p) => String(p).toLowerCase().replace(/\//g, '\\');
  const set = new Set(files.map(norm));
  return {
    exists: (p) => set.has(norm(p)),
    dirs: (d) => {
      const pre = norm(d) + '\\';
      const subs = new Set();
      for (const f of set) if (f.startsWith(pre) && f.slice(pre.length).includes('\\')) subs.add(f.slice(pre.length).split('\\')[0]);
      return [...subs].map((s) => `${d}\\${s}`);
    },
  };
}

test('engineOf: by the files next to the exe, so a new browser works without a code change', { skip: process.platform !== 'win32' }, () => {
  const io = disk(['D:\\New\\nova.exe', 'D:\\New\\131.0\\chrome_elf.dll', 'D:\\Fox\\kit.exe', 'D:\\Fox\\xul.dll', 'D:\\Own\\own.exe']);
  assert.deepStrictEqual(['D:\\New\\nova.exe', 'D:\\Fox\\kit.exe', 'D:\\Own\\own.exe', 'C:\\x\\Safari.exe'].map((e) => browser.engineOf(e, io)), ['chrome', 'firefox', 'unknown', null]);
});

test('candidates: your choice or default first, then the rest; the undrivable fall through with a note', { skip: process.platform !== 'win32' }, () => {
  const lw = 'C:\\Program Files\\LibreWolf';
  const br = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application';
  const io = disk([`${lw}\\librewolf.exe`, `${lw}\\xul.dll`, `${br}\\brave.exe`, `${br}\\131.0\\chrome_elf.dll`, 'D:\\New\\nova.exe', 'D:\\New\\131.0\\resources.pak']);
  const extra = [{ name: 'Nova', exe: 'D:\\New\\nova.exe' }];
  const names = (l) => l.map((b) => b.name);
  assert.deepStrictEqual(names(browser.candidates('auto', { io, extra, defaultExe: 'D:\\New\\nova.exe' })), ['Nova', 'LibreWolf', 'Brave']);
  assert.deepStrictEqual(names(browser.candidates('brave', { io, extra, defaultExe: null })), ['Brave', 'LibreWolf', 'Nova']);
  const safari = browser.candidates('auto', { io, extra, defaultExe: 'C:\\x\\Safari.exe' });
  assert.strictEqual(safari[0].name, 'LibreWolf');
  assert.match(safari[0].note, /Safari\.exe.*нельзя управлять/);
  assert.match(browser.candidates('IronFox', { io, extra, defaultExe: null })[0].note, /IronFox/);
  assert.deepStrictEqual(browser.candidates('auto', { io: disk([]), extra: [], defaultExe: null }), []);
});
