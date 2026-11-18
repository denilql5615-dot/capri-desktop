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

// ---- a profile of yours (e.g. Camoufox "MAIN", made for her, with your extensions) ----
// Never launched through puppeteer: that rewrites the profile's prefs (safe browsing, password saving and
// extension updates off) and only puts them back on a clean exit. Instead the browser runs as itself with
// a control port on 127.0.0.1, started by her or by you, and she attaches: her own window, closed after;
// the browser, its tabs and the profile stay as they were.
const DEFAULT_PORT = 9339;

/** The profile is open in a browser right now (Firefox holds parent.lock while running). */
function profileBusy(dir, io = fs) {
  const lock = path.join(dir, 'parent.lock');
  if (!io.existsSync(lock)) return false;
  try { io.closeSync(io.openSync(lock, 'r+')); return false; } catch (e) { return e.code === 'EBUSY' || e.code === 'EPERM'; }
}

const connectTo = (port) => require('puppeteer-core').connect({ browserWSEndpoint: `ws://127.0.0.1:${port}/session`, protocol: 'webDriverBiDi' });

function spawnBrowser(exe, dir, port, { headless = false } = {}) {
  const args = ['--profile', dir, '--remote-debugging-port', String(port)];
  if (headless) args.push('--headless');
  const child = require('child_process').spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: headless });
  child.unref(); // your browser: it stays when she's done or restarts
}

// A control session left behind (a client killed mid-job) locks everyone out until the browser restarts.
// Recovery, at most once per 10 minutes per profile: stop only the browser running THIS profile, start
// it again with the port; Firefox brings the tabs back through its crash recovery (saved every ~15 s).
const RESTART_GAP_MS = 10 * 60 * 1000;
const lastRestart = new Map();

/** The PIDs of the browser's main processes that run this profile (not its content processes). */
function profilePids(exe, dir, run = (args) => require('child_process').execFileSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 })) {
  const name = path.basename(String(exe || ''));
  if (!name || process.platform !== 'win32') return [];
  const want = path.resolve(dir).toLowerCase();
  const out = run(['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='${name.replace(/'/g, "''")}'" | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`]);
  return String(out).split(/\r?\n/).map((l) => l.split('\t')).filter(([pid, cmd]) => pid && cmd
    && !/-contentproc/i.test(cmd) && cmd.toLowerCase().replace(/\//g, '\\').includes(want)).map(([pid]) => Number(pid)).filter(Boolean);
}

async function restartProfileBrowser(b, dir, port, opts) {
  const key = path.resolve(dir).toLowerCase();
  if (Date.now() - (lastRestart.get(key) || 0) < RESTART_GAP_MS) return false;
  lastRestart.set(key, Date.now());
  const pids = (opts.findPids || profilePids)(b.exe, dir);
  if (!pids.length) return false;
  const kill = opts.killPid || ((pid) => { try { process.kill(pid); } catch { /* gone */ } });
  for (const pid of pids) kill(pid);
  const busy = opts.profileBusy || profileBusy;
  for (let i = 0; i < 40 && busy(dir); i++) await pause(opts.startPollMs ?? 500);
  console.warn(`[capri] ${b.name}: снята брошенная сессия управления — браузер с профилем перезапущен (${pids.join(',')})`);
  (opts.spawn || spawnBrowser)(b.exe, dir, port, { headless: false });
  return true;
}

/** Attaches to the browser on your profile, starting it (visible, as your browser) if it isn't running. */
async function attach(opts, { visible = false } = {}) {
  const dir = opts.profile;
  const port = Number(opts.port) || DEFAULT_PORT;
  const connect = opts.connect || connectTo;
  const busy = opts.profileBusy || profileBusy;
  const spawnIt = opts.spawn || spawnBrowser;
  const b = (opts.pick ? [].concat(opts.pick) : candidates(opts.browser))[0];
  const name = path.basename(dir);
  let refused = null;
  try { return { ctx: await connect(port), b, attached: true }; } catch (e) { refused = e; /* not running with the port */ }
  // the port answers but won't take her: Firefox allows one control session, and one is still held
  if (/Maximum number of active sessions/i.test(String(refused && refused.message))) {
    if (opts.autoRestart !== false && b && await restartProfileBrowser(b, dir, port, opts)) {
      for (let i = 0; i < (opts.startTries || 80); i++) {
        await pause(opts.startPollMs ?? 250);
        try { return { ctx: await connect(port), b, attached: true, restarted: true }; } catch { /* still starting */ }
      }
    }
    throw new Error(`К ${b ? b.name : 'браузеру'} уже подключена другая сессия управления (прошлая Капри не успела отключиться или другая программа). Перезапусти браузер с профилем «${opts.profileName || name}» — это её снимет.`);
  }
  if (busy(dir)) {
    throw new Error(`Профиль «${opts.profileName || name}» открыт без порта управления. Закрой этот браузер — Капри откроет его сама (или запускай его из трея: «Браузер Капри → Открыть профиль»).`);
  }
  if (!b) throw new Error('Нет браузера для этого профиля');
  spawnIt(b.exe, dir, port, { headless: !visible && opts.headlessStart === true });
  for (let i = 0; i < (opts.startTries || 80); i++) {
    await pause(opts.startPollMs ?? 250);
    try { return { ctx: await connect(port), b, attached: true }; } catch { /* still starting */ }
  }
  throw new Error(`${b.name} с профилем «${opts.profileName || name}» не открыл порт управления ${port}`);
}

// Her one window in your browser, kept open between jobs: each job opens its tabs in it and closes only
// them, so neither the browser nor the window starts again; it's found again by its page each time, and
// opened again if you close it. The control connection lives only while a job runs (shared by jobs at
// the same time) and is ended right after: Firefox allows one such session, and one left behind by a
// killed or crashed Capri would lock her out until the browser restarts.
const WINDOW_MARK = 'capri-window';
const WINDOW_URL = `data:text/html;charset=utf-8,${encodeURIComponent(`<!--${WINDOW_MARK}--><title>Окно Капри</title><body style="background:#111;color:#bbb;font:15px sans-serif;padding:2em">Окно Капри: здесь она открывает свои вкладки и закрывает их, когда прочитала. Его можно свернуть.</body>`)}`;
const kept = new Map(); // port → { ctx, b, bc, anchor, users, ready }

/** Her window, connected for one job: { ctx, b, bc, anchor, release() }. */
async function herWindow(opts, { visible = false } = {}) {
  const port = Number(opts.port) || DEFAULT_PORT;
  let k = kept.get(port);
  if (!k || k.ctx?.connected === false) {
    k = { users: 0 };
    kept.set(port, k);
    k.ready = (async () => {
      const { ctx, b } = await attach(opts, { visible });
      Object.assign(k, { ctx, b, bc: ctx.defaultBrowserContext() });
      if (ctx.once) ctx.once('disconnected', () => { if (kept.get(port) === k) kept.delete(port); }); // you closed the browser
    })().catch((e) => { if (kept.get(port) === k) kept.delete(port); throw e; });
  }
  k.users++;
  try {
    await k.ready;
    if (!k.anchor || (k.anchor.isClosed && k.anchor.isClosed())) {
      const pages = await k.bc.pages().catch(() => []);
      k.anchor = pages.find((p) => decodeURIComponent(p.url()).includes(WINDOW_MARK));
      if (!k.anchor) {
        k.anchor = await k.bc.newPage({ type: 'window', background: true });
        await k.anchor.goto(WINDOW_URL).catch(() => {});
      }
    }
  } catch (e) {
    k.users--;
    throw e;
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    if (--k.users > 0) return; // another job still on it
    if (kept.get(port) === k) kept.delete(port);
    await Promise.resolve().then(() => k.ctx.disconnect()).catch(() => {}); // ends the session; window and browser stay
  };
  return { ctx: k.ctx, b: k.b, bc: k.bc, anchor: k.anchor, release };
}

function hasSession(port) {
  const k = kept.get(Number(port) || DEFAULT_PORT);
  return Boolean(k && k.ctx?.connected !== false);
}

/** Ends every control session she holds (on quit). */
async function releaseAll() {
  const all = [...kept.values()];
  kept.clear();
  await Promise.all(all.map((k) => Promise.resolve().then(() => k.ctx && k.ctx.disconnect()).catch(() => {})));
}

/** A new tab in her window (next to it, in the background), for one page. */
async function tabIn(w) {
  const made = await w.bc.userContext.createBrowsingContext('tab', { referenceContext: w.anchor.mainFrame().browsingContext, background: true });
  const page = (await w.bc.pages()).find((p) => p.mainFrame().browsingContext === made);
  if (!page) throw new Error('вкладка в окне Капри не открылась');
  return page;
}

/**
 * Her browser for one job: { browser, readMany(urls), search(query), close() }.
 * Her own profile: headless, pages in parallel tabs, closed after. Your profile: her kept window in your
 * browser, a tab per page side by side; the tabs are closed after, the window and the browser stay.
 */
async function openSession(opts = {}) {
  const { chars = 4000, timeoutMs = 15000, settleMs = 2500, challengeWaitMs = 10000, pollMs = 1500 } = opts;
  const w = opts.profile ? await herWindow(opts) : null;
  const { ctx, b } = w || await start(opts, true);
  const attached = Boolean(w);
  const tabs = new Set(); // this job's tabs in her window
  const pageFor = async () => {
    if (!attached) return ctx.newPage();
    const tab = await tabIn(w);
    tabs.add(tab);
    return tab;
  };
  const done = async (page) => { tabs.delete(page); await Promise.resolve().then(() => page.close()).catch(() => {}); };
  // a node that must be on Tor proves it first, from inside this very browser; else nothing is sent
  if (opts.verifyUrl) {
    const page = await pageFor();
    let ok = false;
    try {
      await page.goto(opts.verifyUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 30000) }).catch(() => {});
      const said = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      ok = /"IsTor"\s*:\s*true/.test(said);
    } finally {
      await done(page);
    }
    if (!ok) {
      if (attached) await w.release();
      throw new Error('окно Tor не подтвердило, что идёт через Tor — запрос не отправлен');
    }
  }
  const empty = () => ({ text: '', title: '', blocked: false });
  const read = async (url) => {
    if (!/^https?:\/\//i.test(url)) return empty();
    const page = await pageFor();
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
      let finalUrl = url;
      if (typeof page.url === 'function') {
        try {
          const current = String(page.url() || '');
          if (current && current !== 'about:blank') {
            if (!/^https?:\/\//i.test(current)) return empty();
            finalUrl = current;
          }
        } catch {}
      }
      return { text: seen.clean.slice(0, chars), title: seen.title, blocked: seen.check, browser: b.name, url: finalUrl };
    } catch {
      return empty();
    } finally {
      await done(page); // the tab goes, her window stays
    }
  };
  const readMany = async (urls) => Promise.all([].concat(urls || []).map(String).map(read)); // a tab each, side by side
  /** Results from a search page opened in this browser: [{ title, url, snippet, engine }]. engine 'ahmia': onion sites. */
  const search = async (query, { limit = 8, engine } = {}) => {
    const q = String(query || '').trim().slice(0, 300);
    if (!q) return [];
    const page = await pageFor();
    if (engine === 'ahmia') {
      try {
        // its form carries a one-time hidden field against bots: read it from the home page, as a browser does
        const base = String(opts.ahmiaUrl || '').replace(/\/$/, '');
        const wait = { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 45000) };
        await page.goto(`${base}/`, wait).catch(() => {});
        const hidden = await page.evaluate(() => [...document.querySelectorAll('#searchForm input[type=hidden]')].map((i) => [i.name, i.value])).catch(() => []);
        const extra = (hidden || []).map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('');
        await page.goto(`${base}/search/?q=${encodeURIComponent(q)}${extra}`, wait).catch(() => {});
        const raw = await page.evaluate(() => [...document.querySelectorAll('li.result')].map((li) => {
          const a = li.querySelector('h4 a');
          return a ? { title: a.innerText, href: a.getAttribute('href'), snippet: (li.querySelector('p') || {}).innerText || '', cite: (li.querySelector('cite') || {}).innerText || '' } : null;
        }).filter(Boolean)).catch(() => []);
        return ahmiaResults(raw).slice(0, limit);
      } finally {
        await done(page);
      }
    }
    try {
      const at = (opts.searchUrl || 'https://html.duckduckgo.com/html/?q={q}').replace('{q}', encodeURIComponent(q));
      await page.goto(at, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, opts.verifyUrl ? 30000 : 0) }).catch(() => {});
      const raw = await page.evaluate(() => [...document.querySelectorAll('.result')].map((r) => {
        const a = r.querySelector('a.result__a');
        const s = r.querySelector('.result__snippet');
        return a ? { title: a.innerText, href: a.href, snippet: s ? s.innerText : '' } : null;
      }).filter(Boolean)).catch(() => []);
      return duckResults(raw).slice(0, limit);
    } finally {
      await done(page);
    }
  };
  const close = async () => {
    for (const t of [...tabs]) await done(t); // left over by a job that broke off
    // your profile: her window stays for the next job, the session ends; her own: the browser goes
    if (attached) await w.release();
    else await Promise.resolve().then(() => ctx.close()).catch(() => {});
  };
  /** A tab of this session for your own steps (e.g. a dialogue with Gemini); closed after. */
  const withTab = async (fn) => {
    const page = await pageFor();
    try { return await fn(page); } finally { await done(page); }
  };
  /**
   * A tab that stays (your profile): the first open one whose address matches `match` (pin it, and it
   * survives restarts), else a new one in her window opened at `url`. Not closed after. Her own
   * profile has no lasting window: a passing tab instead.
   */
  const withKept = async (match, url, fn) => {
    if (!attached) return withTab(fn);
    // only in HER window: a tab of the same site in your own windows stays yours
    const hers = w.anchor.mainFrame().browsingContext.windowId;
    const pages = await w.bc.pages().catch(() => []);
    let page = pages.find((p) => {
      try { return match.test(p.url()) && p.mainFrame().browsingContext.windowId === hers; } catch { return false; }
    });
    if (!page) {
      page = await tabIn(w);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 60000) }).catch(() => {});
    }
    return fn(page);
  };
  return { browser: b && b.name, attached: Boolean(attached), read, readMany, search, withTab, withKept, close };
}

/** DuckDuckGo's HTML results: its /l/?uddg= redirect unwrapped, ads (y.js) out, one per site. */
function duckResults(raw) {
  const seen = new Set();
  const out = [];
  for (const r of raw || []) {
    let url = String(r.href || '');
    try {
      const u = new URL(url, 'https://duckduckgo.com');
      const ddg = /duckduckgo\.com$|^duckduckgogg42\w*\.onion$/.test(u.hostname); // its site or its onion
      if (ddg && u.pathname === '/l/') url = u.searchParams.get('uddg') || '';
      else if (ddg) continue; // y.js ads and its own links
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (!/^https?:/.test(url) || seen.has(host)) continue;
      seen.add(host);
    } catch { continue; }
    out.push({ title: String(r.title || '').trim().slice(0, 160), url, snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 300), engine: 'duckduckgo (браузер)' });
  }
  return out;
}

/** Ahmia's results: the onion address out of its /search/redirect link (or its <cite>), one per site. */
function ahmiaResults(raw) {
  const seen = new Set();
  const out = [];
  for (const r of raw || []) {
    let url = '';
    try { url = new URL(String(r.href || ''), 'http://ahmia.local').searchParams.get('redirect_url') || ''; } catch { /* below */ }
    if (!url && r.cite) url = `http://${String(r.cite).trim()}`;
    let host;
    try { host = new URL(url).hostname; } catch { continue; }
    if (!/\.onion$/i.test(host) || seen.has(host)) continue;
    seen.add(host);
    out.push({ title: String(r.title || '').replace(/\s+/g, ' ').trim().slice(0, 160), url, snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 300), engine: 'ahmia (onion)' });
  }
  return out;
}

/**
 * Text of a page after its scripts ran: { text, title, blocked, browser, url }. Read-only.
 * blocked: a human check is still on the page after waiting; the text she got is kept anyway.
 */
async function readRendered(url, opts = {}) {
  return (await readRenderedMany([url], opts))[0];
}

/** Several pages in one browser: [{ text, title, blocked, browser, url }]; a page that fails reads empty. */
async function readRenderedMany(urls, opts = {}) {
  const list = [].concat(urls || []).map(String);
  if (!list.some((u) => /^https?:\/\//i.test(u))) return list.map(() => ({ text: '', title: '', blocked: false }));
  const s = await openSession(opts);
  try {
    return await s.readMany(list);
  } finally {
    await s.close();
  }
}

/** Opens her browser in a visible window: to sign in, or (your profile) to start it with her control port. */
async function openForSignIn(url, opts = {}) {
  const target = /^https?:\/\//i.test(String(url)) ? url : 'about:blank';
  if (opts.profile) {
    const w = await herWindow(opts, { visible: true }); // started with her port if it wasn't; her window kept
    try {
      if (target !== 'about:blank') await (await w.bc.newPage()).goto(target).catch(() => {}); // a tab of yours
    } finally {
      await w.release();
    }
    return true;
  }
  const { ctx } = await start(opts, false);
  const page = (await ctx.pages())[0] || (await ctx.newPage());
  await page.goto(target).catch(() => {});
  return ctx; // closed by you, with the window
}

module.exports = {
  readRendered, readRenderedMany, openSession, attach, herWindow, hasSession, releaseAll, ahmiaResults, profilePids, forgetWindows: () => kept.clear(), WINDOW_MARK, profileBusy, duckResults, DEFAULT_PORT, openForSignIn, profileDir, candidates, resolve, installed, registered, systemDefault,
  engineOf, kindOf, CHALLENGE, KNOWN, MODES,
};
