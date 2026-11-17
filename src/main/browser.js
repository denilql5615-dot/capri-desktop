'use strict';

// Her own browser, for pages a plain download can't read (built by scripts). It is any browser on the
// PC you pick: 'auto' follows your Windows default, or a name from the list below, or a path to an exe.
// Firefox and its forks (LibreWolf, Waterfox, Floorp, Zen, Mullvad) are driven over WebDriver BiDi,
// Chromium ones (Brave, Chrome, Edge, Vivaldi, Yandex…) over CDP, both by puppeteer-core.
// Each browser gets its own profile for her ("Капри"), never yours: you sign in there yourself, only to
// services you trust her with; banks, Proton and mail never go in it. For now it only reads: open, let
// the scripts run, take the text. A page that asks "are you human?" is not solved: she reports it and
// you open it yourself. Safari (Apple only), IronFox and Fennec (Android only) have no Windows build
// that can be driven: with one of them as the default she takes the next browser she can drive.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CHALLENGE = /(just a moment|attention required|verify you are human|are you a robot|captcha|access denied|checking your browser|подтвердите, что вы не робот|проверка браузера)/i;

const PF = [process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.LOCALAPPDATA].filter(Boolean);

// name → kind and where it usually lives (Windows folders under Program Files / LocalAppData, then Linux)
const KNOWN = [
  { name: 'Firefox', kind: 'firefox', rel: ['Mozilla Firefox\\firefox.exe'], unix: ['/usr/bin/firefox'] },
  { name: 'LibreWolf', kind: 'firefox', rel: ['LibreWolf\\librewolf.exe'], unix: ['/usr/bin/librewolf'] },
  { name: 'Waterfox', kind: 'firefox', rel: ['Waterfox\\waterfox.exe'], unix: ['/usr/bin/waterfox'] },
  { name: 'Floorp', kind: 'firefox', rel: ['Ablaze Floorp\\floorp.exe', 'Floorp\\floorp.exe'], unix: ['/usr/bin/floorp'] },
  { name: 'Zen', kind: 'firefox', rel: ['Zen Browser\\zen.exe'], unix: ['/usr/bin/zen-browser'] },
  { name: 'Mullvad Browser', kind: 'firefox', rel: ['Mullvad Browser\\Browser\\mullvadbrowser.exe'], unix: [] },
  { name: 'Brave', kind: 'chrome', rel: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'], unix: ['/usr/bin/brave-browser', '/usr/bin/brave'] },
  { name: 'Chromium', kind: 'chrome', rel: ['Chromium\\Application\\chrome.exe'], unix: ['/usr/bin/chromium', '/usr/bin/chromium-browser'] },
  { name: 'Chrome', kind: 'chrome', rel: ['Google\\Chrome\\Application\\chrome.exe'], unix: ['/usr/bin/google-chrome'] },
  { name: 'Edge', kind: 'chrome', rel: ['Microsoft\\Edge\\Application\\msedge.exe'], unix: ['/usr/bin/microsoft-edge'] },
  { name: 'Vivaldi', kind: 'chrome', rel: ['Vivaldi\\Application\\vivaldi.exe'], unix: ['/usr/bin/vivaldi'] },
  { name: 'Yandex', kind: 'chrome', rel: ['Yandex\\YandexBrowser\\Application\\browser.exe'], unix: ['/usr/bin/yandex-browser'] },
  { name: 'Thorium', kind: 'chrome', rel: ['Thorium\\Application\\thorium.exe'], unix: ['/usr/bin/thorium-browser'] },
];
// no Windows build she can drive (Safari: Apple only; IronFox, Fennec: Android only)
const UNDRIVABLE = /safari|ironfox|fennec/i;

/** 'firefox' | 'chrome' | null, by the exe name. */
function kindOf(exe) {
  const b = path.basename(String(exe || '')).toLowerCase();
  if (UNDRIVABLE.test(b)) return null;
  if (/firefox|librewolf|waterfox|floorp|zen|mullvadbrowser/.test(b)) return 'firefox';
  if (/chrome|chromium|brave|msedge|vivaldi|thorium|opera|yandex|^browser\.exe$/.test(b)) return 'chrome';
  return null;
}

/** Browsers on this PC she can drive: [{ name, kind, exe }]. */
function installed(exists = fs.existsSync) {
  const out = [];
  for (const k of KNOWN) {
    const tries = process.platform === 'win32' ? PF.flatMap((root) => k.rel.map((r) => path.join(root, r))) : k.unix;
    const exe = tries.find((p) => exists(p));
    if (exe) out.push({ name: k.name, kind: k.kind, exe });
  }
  return out;
}

/** The exe of your Windows default browser, or null. */
function systemDefault(run = (args) => execFileSync('reg', args, { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })) {
  if (process.platform !== 'win32') return null;
  const base = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https';
  for (const key of [`${base}\\UserChoiceLatest`, `${base}\\UserChoice`]) {
    try {
      const prog = (run(['query', key, '/v', 'ProgId']).match(/ProgId\s+REG_SZ\s+(\S+)/) || [])[1];
      if (!prog) continue;
      const cmd = run(['query', `HKCR\\${prog}\\shell\\open\\command`, '/ve']);
      const exe = (cmd.match(/"([^"]+\.exe)"/i) || cmd.match(/REG_SZ\s+(\S+\.exe)/i) || [])[1];
      if (exe) return exe;
    } catch { /* next key */ }
  }
  return null;
}

/**
 * Which browser she uses: { name, kind, exe, note } or null when there is none she can drive.
 * setting: 'auto' (your default; if it can't be driven, the first one found), a name, or a path.
 */
function resolve(setting = 'auto', { exists = fs.existsSync, defaultExe = systemDefault } = {}) {
  const found = installed(exists);
  const s = String(setting || 'auto').trim();
  const byExe = (exe) => found.find((b) => b.exe.toLowerCase() === exe.toLowerCase())
    || (kindOf(exe) && exists(exe) ? { name: path.basename(exe, path.extname(exe)), kind: kindOf(exe), exe } : null);
  if (s && s.toLowerCase() !== 'auto') {
    const named = found.find((b) => b.name.toLowerCase() === s.toLowerCase());
    if (named) return named;
    if (/[\\/]/.test(s)) { const b = byExe(s); if (b) return b; }
    const first = found[0];
    return first ? { ...first, note: `«${s}» не найден или им нельзя управлять — беру ${first.name}` } : null;
  }
  const def = typeof defaultExe === 'function' ? defaultExe() : defaultExe;
  const mine = def && byExe(def);
  if (mine) return mine;
  const first = found[0];
  if (!first) return null;
  return def ? { ...first, note: `${path.basename(def)} по умолчанию, но им управлять нельзя — беру ${first.name}` } : first;
}

// her profile, one per browser (a Firefox profile can't be opened by Chromium and back)
const profileDir = (app, b) => path.join(app.getPath('userData'), 'capri-browser', b ? b.name.toLowerCase().replace(/\W+/g, '-') : '');

function defaultLaunch(dir, { headless, browser: b }) {
  fs.mkdirSync(dir, { recursive: true });
  return require('puppeteer-core').launch({
    browser: b.kind, executablePath: b.exe, userDataDir: dir, headless,
    defaultViewport: headless ? { width: 1280, height: 900 } : null,
  });
}

function pick(opts) {
  const b = opts.pick || resolve(opts.browser);
  if (!b) throw new Error('Нет браузера, которым Капри может управлять (Firefox, LibreWolf, Brave, Chrome, Edge…)');
  return b;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Text of a page after its scripts ran: { text, title, blocked, browser }. Read-only, headless. */
async function readRendered(url, opts = {}) {
  const { app, chars = 4000, timeoutMs = 25000, launch = defaultLaunch } = opts;
  if (!/^https?:\/\//i.test(String(url))) return { text: '', title: '', blocked: false };
  const b = pick(opts);
  const ctx = await launch(profileDir(app, b), { headless: true, browser: b });
  try {
    const page = (await ctx.pages())[0] || (await ctx.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await pause(1500);
    const title = await page.title();
    const text = await page.evaluate(() => {
      const root = document.querySelector('article, main, [role=main]') || document.body;
      return root ? root.innerText : '';
    });
    const clean = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l.length > 30).join('\n');
    const blocked = CHALLENGE.test(title) || (clean.length < 400 && CHALLENGE.test(clean));
    return { text: blocked ? '' : clean.slice(0, chars), title, blocked, browser: b.name };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Opens her profile in a visible window, for you to sign in to the services you trust her with. */
async function openForSignIn(url, opts = {}) {
  const { app, launch = defaultLaunch } = opts;
  const b = pick(opts);
  const ctx = await launch(profileDir(app, b), { headless: false, browser: b });
  const page = (await ctx.pages())[0] || (await ctx.newPage());
  await page.goto(/^https?:\/\//i.test(String(url)) ? url : 'about:blank').catch(() => {});
  return ctx; // closed by you, with the window
}

module.exports = { readRendered, openForSignIn, profileDir, resolve, installed, systemDefault, kindOf, CHALLENGE, KNOWN };
