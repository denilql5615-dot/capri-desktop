'use strict';

// Antigravity through its own app window (its Orchestrator only works there, not in the agy CLI): the app is
// Electron and keeps a Chrome DevTools port on 127.0.0.1 (8793 here); she attaches, opens a New Conversation,
// picks the model, sets the permission preset to "Request Review" (nothing runs without your yes — a council
// member only thinks and answers), types the question, waits until "Stop execution" is gone, reads the answer,
// and puts your preset and model back. One question at a time.

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_PORT = 8793;

let queue = Promise.resolve();

async function connect(port) {
  const puppeteer = require('puppeteer-core');
  const br = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  const page = (await br.pages()).find((p) => /^https:\/\/127\.0\.0\.1:\d+\//.test(p.url()) && !/plugin:/.test(p.url()));
  if (!page) { br.disconnect(); throw new Error('окно Antigravity не найдено (открой приложение Antigravity)'); }
  return { br, page };
}

const current = (page, label) => page.evaluate((l) => {
  const b = [...document.querySelectorAll('button, [role=button], [role=combobox]')].find((x) => (x.getAttribute('aria-label') || '').startsWith(l));
  return b ? (b.getAttribute('aria-label') || '').replace(/^.*current:\s*/, '').trim() : null;
}, label);

async function pick(page, label, option) {
  await page.evaluate((l) => {
    const b = [...document.querySelectorAll('button, [role=button], [role=combobox]')].find((x) => (x.getAttribute('aria-label') || '').startsWith(l));
    if (b) b.click();
  }, label);
  await pause(1000);
  const ok = await page.evaluate((o) => {
    const e = [...document.querySelectorAll('[role=option], [role=menuitem], [role=menuitemradio]')]
      .find((x) => (x.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase().startsWith(o.toLowerCase()));
    if (e) { e.click(); return true; }
    return false;
  }, option);
  await pause(800);
  if (!ok) await page.keyboard.press('Escape');
  return ok;
}

/** The answer: the page text after the question's end mark, without its status lines and the input area. */
function answerAfter(text, mark) {
  const s = String(text || '');
  const at = s.lastIndexOf(mark);
  if (at < 0) return '';
  const lines = s.slice(at + mark.length).split('\n').map((l) => l.trim());
  const stop = lines.findIndex((l) => /^(Message input|Add context|Select model|Agent permissions)/i.test(l));
  return (stop >= 0 ? lines.slice(0, stop) : lines)
    .filter((l) => l && !/^(Worked for|Thought for|Thinking|Stop execution|Cancel \(Ctrl\+D\)|Request Review|Turbo|Copy|Retry|Good response|Bad response|Orchestrator \(|Gemini 4|Claude (Opus|Sonnet)|GPT-OSS)\b/i.test(l))
    .join('\n').trim();
}

/** Asks Antigravity in a new conversation: { answer, model }. */
function ask(prompt, { model = 'Orchestrator (Argon)', preset = 'Request Review', port = DEFAULT_PORT, timeoutMs = 20 * 60 * 1000, connectTo = connect, signal } = {}) {
  const run = async () => {
    signal?.throwIfAborted();
    const { br, page } = await connectTo(port);
    const presetBefore = await current(page, 'Agent permissions preset');
    const modelBefore = await current(page, 'Select model');
    try {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button, [role=button], a')].find((x) => (x.innerText || '').trim() === 'New Conversation');
        if (b) b.click();
      });
      await pause(2500);
      if (!(await pick(page, 'Select model', model))) throw new Error(`в Antigravity нет модели «${model}»`);
      if (!(await pick(page, 'Agent permissions preset', preset))) throw new Error(`в Antigravity нет режима прав «${preset}»`);
      const input = await page.$('[contenteditable=true][aria-label="Message input"], [contenteditable=true][placeholder="Message input"], [contenteditable=true][data-placeholder="Message input"]');
      if (!input) throw new Error('в Antigravity не нашлось поля ввода');
      await input.click();
      // a mark at the end of the question: the answer is what follows it on the page
      const mark = `[конец вопроса ${Date.now().toString(36)}]`;
      await page.evaluate((t) => { document.execCommand('insertText', false, t); }, `${String(prompt).trim()}\n\n${mark}`);
      await pause(600);
      signal?.throwIfAborted();
      await page.keyboard.press('Enter');
      const busy = () => page.evaluate(() => [...document.querySelectorAll('button, [role=button]')]
        .some((b) => /^(Stop execution|Cancel \(Ctrl\+D\))/i.test(b.getAttribute('aria-label') || (b.innerText || '').trim())));
      const started = Date.now();
      let seenBusy = false;
      let idle = 0;
      while (Date.now() - started < timeoutMs) {
        await pause(3000);
        if (signal?.aborted) {
          await page.evaluate(() => [...document.querySelectorAll('button, [role=button]')]
            .find((b) => /^(Stop execution|Cancel \(Ctrl\+D\))/i.test(b.getAttribute('aria-label') || (b.innerText || '').trim()))?.click()).catch(() => {});
          signal.throwIfAborted();
        }
        const b = await busy();
        if (b) { seenBusy = true; idle = 0; continue; }
        if (seenBusy || Date.now() - started > 15000) idle++;
        if (idle >= 2) break; // twice in a row not busy: done
      }
      if (Date.now() - started >= timeoutMs) throw new Error('Antigravity не ответил за отведённое время');
      const text = await page.evaluate(() => document.body.innerText);
      const answer = answerAfter(text, mark);
      if (!answer) throw new Error('Antigravity закончил, но ответ не прочитался');
      return { answer, model };
    } finally {
      // your settings back as they were
      if (presetBefore) await pick(page, 'Agent permissions preset', presetBefore.replace(/\s+Default$/, '')).catch(() => {});
      if (modelBefore) await pick(page, 'Select model', modelBefore).catch(() => {});
      br.disconnect();
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

module.exports = { ask, answerAfter, DEFAULT_PORT };
