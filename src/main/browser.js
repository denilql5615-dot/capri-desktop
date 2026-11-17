'use strict';

// Her own browser, for pages a plain download can't read (built by scripts). Any browser on the PC:
// 'auto' follows your Windows default, or a name, or a path to an exe. She takes the FIRST technically
// compatible one, in this order: your choice → your default → the rest found on the PC.
// Two ways to drive it, both through puppeteer-core:
//   1. the engine's own protocol — Chromium over CDP, Gecko (Firefox and forks) over WebDriver BiDi;
//   2. WebDriver BiDi for everything else that speaks it (a Chromium build with CDP shut, a new engine).
// The engine is told by the files next to the exe, not by its name, so a new browser on Chromium or
// Gecko works without a code change. What stays the same whichever browser she sits in:
//   - profile: her own one per browser ("Капри"), never yours; you sign in there yourself, only to
//     services you trust her with; banks, Proton and mail never go in it;
//   - network: no proxy or route of her own, the PC's (all of it through the VPN);
//   - task limits: read only — open, let the scripts run, take the text.
// A human check is not solved and not cut off either: many pass by themselves in a real browser, so she
// waits a little; if it is still there she says so and gives you the link, keeping whatever text she got.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CHALLENGE = /(just a moment|attention required|verify you are human|are you a robot|captcha|access denied|checking your browser|one moment|please wait|один момент|подождите|подтвердите, что вы не робот|проверка браузера|проверяем|выполняется проверка)/i;

const PF = [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.LOCALAPPDATA].filter(Boolean);

// where the usual ones live (Windows folders under Program Files / LocalAppData, then Linux)
const KNOWN = [
  { name: 'Firefox', rel: ['Mozilla Firefox\\firefox.exe'], unix: ['/usr/bin/firefox'] },
  { name: 'LibreWolf', rel: ['LibreWolf\\librewolf.exe'], unix: ['/usr/bin/librewolf'] },
  { name: 'Waterfox', rel: ['Waterfox\\waterfox.exe'], unix: ['/usr/bin/waterfox'] },
  { name: 'Floorp', rel: ['Ablaze Floorp\\floorp.exe', 'Floorp\\floorp.exe'], unix: ['/usr/bin/floorp'] },
  { name: 'Zen', rel: ['Zen Browser\\zen.exe'], unix: ['/usr/bin/zen-browser'] },
  { name: 'Mullvad Browser', rel: ['Mullvad Browser\\Browser\\mullvadbrowser.exe'], unix: [] },
  { name: 'Brave', rel: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'], unix: ['/usr/bin/brave-browser', '/usr/bin/brave'] },
  { name: 'Chromium', rel: ['Chromium\\Application\\chrome.exe'], unix: ['/usr/bin/chromium', '/usr/bin/chromium-browser'] },
  { name: 'Chrome', rel: ['Google\\Chrome\\Application\\chrome.exe'], unix: ['/usr/bin/google-chrome'] },
  { name: 'Edge', rel: ['Microsoft\\Edge\\Application\\msedge.exe'], unix: ['/usr/bin/microsoft-edge'] },
  { name: 'Vivaldi', rel: ['Vivaldi\\Application\\vivaldi.exe'], unix: ['/usr/bin/vivaldi'] },
  { name: 'Yandex', rel: ['Yandex\\YandexBrowser\\Application\\browser.exe'], unix: ['/usr/bin/yandex-browser'] },
  { name: 'Thorium', rel: ['Thorium\\Application\\thorium.exe'], unix: ['/usr/bin/thorium-browser'] },
];
// no build for this OS she can drive (Safari: Apple only; IronFox, Fennec: Android only)
const UNDRIVABLE = /safari|ironfox|fennec/i;

const fsio = {
  exists: (p) => fs.existsSync(p),
  dirs: (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; } },
};

/** 'chrome' | 'firefox' | 'unknown' | null (can't be driven). By the files next to the exe, then by its name. */
function engineOf(exe, io = fsio) {
  const file = String(exe || '');
  if (!file || UNDRIVABLE.test(path.basename(file))) return null;
  const dir = path.dirname(file);
  if (['xul.dll', 'omni.ja', 'libxul.so'].some((f) => io.exists(path.join(dir, f)))) return 'firefox';
  const chromium = (d) => ['chrome_elf.dll', 'resources.pak', 'chrome_100_percent.pak'].some((f) => io.exists(path.join(d, f)));
  if (chromium(dir) || io.dirs(dir).some(chromium)) return 'chrome'; // Chromium keeps them in a version folder
  const b = path.basename(file).toLowerCase();
  if (/firefox|librewolf|waterfox|floorp|zen|mullvadbrowser/.test(b)) return 'firefox';
  if (/chrome|chromium|brave|msedge|vivaldi|thorium|opera|yandex/.test(b)) return 'chrome';
  return 'unknown';
}
const kindOf = (exe) => { const e = engineOf(exe, { exists: () => false, dirs: () => [] }); return e === 'unknown' ? null : e; };

const reg = (args) => execFileSync('reg', args, { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
const exeIn = (text) => (String(text).match(/"([^"]+\.exe)"/i) || String(text).match(/REG_SZ\s+(\S+\.exe)/i) || [])[1] || null;

/** Browsers registered with Windows (Start menu "Internet" clients): [{ name, exe }]. */
function registered(run = reg) {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (const root of ['HKLM\\SOFTWARE\\Clients\\StartMenuInternet', 'HKCU\\SOFTWARE\\Clients\\StartMenuInternet', 'HKLM\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet']) {
    let keys = [];
    // reg prints full hive names (HKEY_LOCAL_MACHINE\…): keep each subkey, query it by our short name
    const tail = root.slice(root.indexOf('\\')).toUpperCase() + '\\';
    try {
      keys = run(['query', root]).split(/\r?\n/).map((l) => l.trim())
        .filter((l) => l.toUpperCase().includes(tail))
        .map((l) => root + l.slice(l.toUpperCase().indexOf(tail) + tail.length - 1));
    } catch { continue; }
    for (const key of keys) {
      try { const exe = exeIn(run(['query', `${key}\\shell\\open\\command`, '/ve'])); if (exe) out.push({ name: key.split('\\').pop().replace(/\.exe$/i, ''), exe }); } catch { /* next */ }
    }
  }
  return out;
}

/** Browsers on this PC she can drive: [{ name, engine, exe }], one per exe. */
function installed({ io = fsio, extra = registered } = {}) {
  const out = [];
  const seen = new Set();
  const add = (name, exe) => {
    const key = exe.toLowerCase();
    if (seen.has(key) || !io.exists(exe)) return;
    const engine = engineOf(exe, io);
    if (!engine || engine === 'unknown') return; // only what is surely compatible goes in the list
    seen.add(key);
    out.push({ name, engine, exe });
  };
  for (const k of KNOWN) {
    const tries = process.platform === 'win32' ? PF.flatMap((root) => k.rel.map((r) => path.join(root, r))) : k.unix;
    const exe = tries.find((p) => io.exists(p));
    if (exe) add(k.name, exe);
  }
  for (const r of (typeof extra === 'function' ? extra() : extra) || []) add(r.name, r.exe);
  return out;
}

/** The exe of your Windows default browser, or null. */
function systemDefault(run = reg) {
  if (process.platform !== 'win32') return null;
  const base = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https';
  for (const key of [`${base}\\UserChoiceLatest`, `${base}\\UserChoice`]) {
    try {
      const prog = (run(['query', key, '/v', 'ProgId']).match(/ProgId\s+REG_SZ\s+(\S+)/) || [])[1];
      const exe = prog && exeIn(run(['query', `HKCR\\${prog}\\shell\\open\\command`, '/ve']));
      if (exe) return exe;
    } catch { /* next key */ }
  }
  return null;
}

/**
 * Browsers to try, first one first: your choice (a name or a path) or your default, then the rest found.
 * Each: { name, engine, exe, note? } — note says why it isn't the one asked for.
 */
function candidates(setting = 'auto', { io = fsio, defaultExe = systemDefault, extra = registered } = {}) {
  const found = installed({ io, extra });
  const s = String(setting || 'auto').trim();
  const fromExe = (exe) => {
    if (!exe) return null;
    const known = found.find((b) => b.exe.toLowerCase() === String(exe).toLowerCase());
    if (known) return known;
    const engine = io.exists(exe) ? engineOf(exe, io) : null;
    return engine ? { name: path.basename(exe, path.extname(exe)), engine, exe } : null;
  };
  let first = null;
  let want = '';
  if (s.toLowerCase() !== 'auto') {
    want = s;
    first = found.find((b) => b.name.toLowerCase() === s.toLowerCase()) || (/[\\/]/.test(s) ? fromExe(s) : null);
  } else {
    const def = typeof defaultExe === 'function' ? defaultExe() : defaultExe;
    want = def ? `${path.basename(def)} (по умолчанию)` : '';
    first = fromExe(def);
  }
  const list = first ? [first, ...found.filter((b) => b.exe.toLowerCase() !== first.exe.toLowerCase())] : found.slice();
  if (!first && want && list.length) list[0] = { ...list[0], note: `${want}: нет или им нельзя управлять — беру ${list[0].name}` };
  return list;
}

/** The browser she would use now (for the tray), or null. */
const resolve = (setting, opts) => candidates(setting, opts)[0] || null;

// her profile, one per browser (a Firefox profile can't be opened by Chromium and back)
const profileDir = (app, b) => path.join(app.getPath('userData'), 'capri-browser', b ? b.name.toLowerCase().replace(/\W+/g, '-') : '');

// ways to drive an engine, own protocol first, then BiDi
const MODES = {
  chrome: [{ browser: 'chrome', protocol: 'cdp' }, { browser: 'chrome', protocol: 'webDriverBiDi' }],
  firefox: [{ browser: 'firefox', protocol: 'webDriverBiDi' }],
  unknown: [{ browser: 'firefox', protocol: 'webDriverBiDi' }, { browser: 'chrome', protocol: 'webDriverBiDi' }, { browser: 'chrome', protocol: 'cdp' }],
};

// no proxy, no extra flags: the PC's own network and route
function defaultLaunch(dir, { headless, browser: b, mode }) {
  fs.mkdirSync(dir, { recursive: true });
  return require('puppeteer-core').launch({
    browser: mode.browser, protocol: mode.protocol, executablePath: b.exe, userDataDir: dir, headless,
    defaultViewport: headless ? { width: 1280, height: 900 } : null,
  });
}

const working = new Map(); // setting → { b, mode } that started last time: tried first

/** Starts the first compatible browser: { ctx, b, mode }. */
async function start(opts, headless) {
  const { app, launch = defaultLaunch } = opts;
  const list = opts.pick ? [].concat(opts.pick) : candidates(opts.browser);
  const key = String(opts.browser || 'auto');
  const tries = [];
  const last = !opts.pick && working.get(key);
  if (last) tries.push(last);
  for (const b of list) for (const mode of MODES[b.engine] || []) tries.push({ b, mode });
  const errors = [];
  for (const t of tries) {
    try {
      const ctx = await launch(profileDir(app, t.b), { headless, browser: t.b, mode: t.mode });
      if (!opts.pick) working.set(key, t);
      return { ctx, ...t };
    } catch (e) {
      errors.push(`${t.b.name}/${t.mode.protocol}: ${String(e && e.message || e).split('\n')[0]}`);
    }
  }
  throw new Error(errors.length ? `Ни один браузер не запустился — ${errors.join('; ')}` : 'Нет браузера, которым Капри может управлять (Firefox, LibreWolf, Brave, Chrome, Edge…)');
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Text of a page after its scripts ran: { text, title, blocked, browser, url }. Read-only, headless.
 * blocked: a human check is still on the page after waiting; the text she got is kept anyway.
 */
async function readRendered(url, opts = {}) {
  return (await readRenderedMany([url], opts))[0];
}

/**
 * Several pages in ONE browser, each in its own tab, side by side: [{ text, title, blocked, browser, url }].
 * A page that doesn't finish loading in time is still read for what it has; one that fails reads empty.
 */
async function readRenderedMany(urls, opts = {}) {
  const { chars = 4000, timeoutMs = 15000, settleMs = 2500, challengeWaitMs = 10000, pollMs = 1500 } = opts;
  const empty = () => ({ text: '', title: '', blocked: false });
  const list = [].concat(urls || []).map(String);
  if (!list.some((u) => /^https?:\/\//i.test(u))) return list.map(empty);
  const { ctx, b } = await start(opts, true);
  const one = async (url) => {
    if (!/^https?:\/\//i.test(url)) return empty(url);
    const page = await ctx.newPage();
    try {
      // slow pages: whatever arrived by the deadline is read, the wait isn't a failure
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
      await pause(settleMs);
      const look = async () => {
        const title = await page.title().catch(() => '');
        const text = await page.evaluate(() => {
          const main = document.querySelector('article, main, [role=main]');
          const body = document.body ? document.body.innerText : '';
          const inMain = main ? main.innerText : '';
          return inMain && inMain.length > 300 ? inMain : body; // an empty <main> shell: the whole page
        }).catch(() => '');
        const clean = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 30).join('\n');
        return { title, clean, check: CHALLENGE.test(title) || (clean.length < 400 && CHALLENGE.test(clean)) };
      };
      let seen = await look();
      // many checks pass by themselves in a real browser: wait, don't solve, don't cut off
      for (let waited = 0; seen.check && waited < challengeWaitMs; waited += pollMs) {
        await pause(pollMs);
        seen = await look();
      }
      return { text: seen.clean.slice(0, chars), title: seen.title, blocked: seen.check, browser: b.name, url };
    } catch {
      return empty(url);
    } finally {
      await Promise.resolve().then(() => page.close()).catch(() => {});
    }
  };
  try {
    return await Promise.all(list.map(one));
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Opens her profile in a visible window, for you to sign in to the services you trust her with. */
async function openForSignIn(url, opts = {}) {
  const { ctx } = await start(opts, false);
  const page = (await ctx.pages())[0] || (await ctx.newPage());
  await page.goto(/^https?:\/\//i.test(String(url)) ? url : 'about:blank').catch(() => {});
  return ctx; // closed by you, with the window
}

module.exports = {
  readRendered, readRenderedMany, openForSignIn, profileDir, candidates, resolve, installed, registered, systemDefault,
  engineOf, kindOf, CHALLENGE, KNOWN, MODES,
};
