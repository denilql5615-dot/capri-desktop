'use strict';

// Her own browser, for pages a plain download can't read (built by scripts): your installed Firefox,
// driven over WebDriver BiDi, with its own profile ("Капри"), never your Firefox profile. You sign in
// there yourself, only to the services you trust her with; banks, Proton and mail never go in it.
// For now it only reads: open, let the scripts run, take the text. A page that asks "are you human?"
// is not solved: she reports it and you open it yourself. All PC traffic already leaves through Proton.

const fs = require('fs');
const path = require('path');

const CHALLENGE = /(just a moment|attention required|verify you are human|are you a robot|captcha|access denied|checking your browser|подтвердите, что вы не робот|проверка браузера)/i;

const FIREFOX = [
  process.env.CAPRI_FIREFOX,
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Mozilla Firefox', 'firefox.exe'),
  '/usr/bin/firefox',
].filter(Boolean);

function firefoxPath(exists = fs.existsSync) {
  return FIREFOX.find((p) => exists(p)) || null;
}

const profileDir = (app) => path.join(app.getPath('userData'), 'capri-browser');

function defaultLaunch(dir, { headless }) {
  const exe = firefoxPath();
  if (!exe) throw new Error('Firefox не найден');
  fs.mkdirSync(dir, { recursive: true });
  return require('puppeteer-core').launch({
    browser: 'firefox', executablePath: exe, userDataDir: dir, headless,
    defaultViewport: headless ? { width: 1280, height: 900 } : null,
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Text of a page after its scripts ran: { text, title, blocked }. Read-only, headless. */
async function readRendered(url, { app, chars = 4000, timeoutMs = 25000, launch = defaultLaunch } = {}) {
  if (!/^https?:\/\//i.test(String(url))) return { text: '', title: '', blocked: false };
  const ctx = await launch(profileDir(app), { headless: true });
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
    return { text: blocked ? '' : clean.slice(0, chars), title, blocked };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Opens her profile in a visible window, for you to sign in to the services you trust her with. */
async function openForSignIn(url, { app, launch = defaultLaunch } = {}) {
  const ctx = await launch(profileDir(app), { headless: false });
  const page = (await ctx.pages())[0] || (await ctx.newPage());
  await page.goto(/^https?:\/\//i.test(String(url)) ? url : 'about:blank').catch(() => {});
  return ctx; // closed by you, with the window
}

module.exports = { readRendered, openForSignIn, profileDir, firefoxPath, CHALLENGE };
