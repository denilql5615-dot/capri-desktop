'use strict';

// Gemini as an adviser: a second opinion and a researcher for her and your agents, through the Gemini
// site (gemini.google.com) in a tab of HER window in your browser (Camoufox MAIN), on your own Google
// account and its subscription limits — a dialogue, never access to code or files.
//   - one question at a time, a pause between them (a person's pace, not a flood);
//   - a new chat per task, or the same chat continued by its id (the /app/<id> part of its address);
//   - nothing from a Tor request is ever sent here (the callers keep it that way).

const GEMINI_URL = 'https://gemini.google.com/app';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let queue = Promise.resolve();
let lastAt = 0;

/** A chat id from an address or an id: "ccfa5ca0a07a98a5", or null. */
function chatId(value) {
  const m = String(value || '').match(/(?:\/app\/)?([0-9a-f]{8,})\b/i);
  return m ? m[1] : null;
}

/**
 * Asks Gemini in one tab: { answer, chat, signedIn }. page: a puppeteer page (a tab of her window).
 * opts: { chat, timeoutMs, pollMs, requireSignIn }.
 */
async function askIn(page, prompt, { chat = null, timeoutMs = 300000, pollMs = 1500, requireSignIn = true, stableTicks = 2 } = {}) {
  const text = String(prompt || '').trim();
  if (!text) throw new Error('пустой вопрос');
  const id = chatId(chat);
  await page.goto(id ? `${GEMINI_URL}/${id}` : GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('rich-textarea .ql-editor', { timeout: 30000 });
  const state = () => page.evaluate(() => {
    const labels = [...document.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label') || '');
    const responses = [...document.querySelectorAll('model-response')];
    const last = responses.at(-1);
    return {
      signedIn: !labels.some((l) => /^(sign in|войти)$/i.test(l.trim())),
      busy: labels.some((l) => /stop response|остановить/i.test(l)),
      count: responses.length,
      asked: document.querySelectorAll('user-query').length,
      text: last ? (last.querySelector('message-content') || last).innerText : '',
      path: location.pathname,
    };
  });
  // a continued chat loads its history after the page: wait until it stops growing before counting
  let before = await state();
  if (id) {
    for (let i = 0, still = 0; i < 20 && still < 2; i++) {
      await pause(pollMs);
      const s = await state();
      still = s.count === before.count && s.count > 0 ? still + 1 : 0;
      before = s;
    }
  }
  if (requireSignIn && !before.signedIn) {
    throw new Error('в окне Капри (Camoufox MAIN) не выполнен вход в Google на gemini.google.com — войди там один раз сам');
  }
  // the prompt goes in as one paste-like insert (typing it key by key would take minutes for a long one);
  // sent, then checked: your question must show up in the chat, else it is put in and sent once more
  const send = async () => {
    await page.click('rich-textarea .ql-editor');
    await page.evaluate((t) => {
      const ed = document.querySelector('rich-textarea .ql-editor');
      ed.focus();
      if (!ed.innerText.trim()) document.execCommand('insertText', false, t);
    }, text);
    await pause(400);
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button[aria-label]')].find((x) => /send message|отправить/i.test(x.getAttribute('aria-label') || ''));
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    });
    if (!clicked) await page.keyboard.press('Enter');
  };
  await send();
  for (let i = 0; i < 2; i++) {
    let went = false;
    for (let w = 0; w < 8 && !went; w++) {
      await pause(pollMs);
      const s = await state();
      went = s.asked > before.asked || s.busy || s.count > before.count;
    }
    if (went) break;
    await send();
  }
  // done: a new answer is there, Gemini no longer shows "Stop", and its text stopped changing
  const started = Date.now();
  let prev = null;
  let same = 0;
  while (Date.now() - started < timeoutMs) {
    await pause(pollMs);
    const s = await state();
    if (s.count > before.count && !s.busy && s.text.trim()) {
      same = s.text === prev ? same + 1 : 0;
      if (same >= stableTicks - 1 && s.text === prev) return { answer: s.text.trim(), chat: chatId(s.path), signedIn: s.signedIn };
    }
    prev = s.text;
  }
  throw new Error('Gemini не ответил за отведённое время');
}

/**
 * One question at a time across her (and your agents'), a pause between them. open(): a session of her
 * MAIN window (browser.openSession) with pageFor-like newTab() and close().
 */
function ask(prompt, { open, chat, minGapMs = 4000, ...rest } = {}) {
  const run = async () => {
    const wait = lastAt + minGapMs - Date.now();
    if (wait > 0) await pause(wait);
    const s = await open();
    try {
      return await s.withTab((page) => askIn(page, prompt, { chat, ...rest }));
    } finally {
      lastAt = Date.now();
      await s.close();
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

module.exports = { ask, askIn, chatId, GEMINI_URL };
