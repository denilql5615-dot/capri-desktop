'use strict';

// Gemini as an adviser: a second opinion and a researcher for her and your agents, through the Gemini
// site (gemini.google.com) in ONE lasting tab of her window in your browser (Camoufox MAIN), on your own
// Google account and its subscription limits — a dialogue, never access to code or files beyond what is
// attached on purpose.
//   - its tab stays open between questions (pin it once: it is found again after restarts);
//   - one question at a time, a pause between them (a person's pace, not a flood);
//   - a new chat per task, or the same chat continued by its id (the /app/<id> part of its address);
//   - a model by role (Flash-Lite, Hydrogen, Argon), picked in its own model menu; Argon in "Задача" mode;
//   - files attached through its upload field — only from your work folders, never keys or secrets;
//   - nothing from a Tor request is ever sent here (the callers keep it that way).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readUsageIn } = require('./gemini-usage');
const { activityPhase } = require('./activity-phase');

const GEMINI_URL = 'https://gemini.google.com/app';
const GEMINI_TAB = /^https:\/\/gemini\.google\.com\/app(?:[/?#]|$)/i; // its chat, not its hidden helper frames
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// what each model is for (public benchmarks and reviews, Nov 2026 — vault note GENESIS/Модели — роли
// агентов): the role names agents use, and the name in Gemini's menu. Carbon isn't on this account;
// 3.1 Pro is the previous generation.
const MODELS = {
  fast: 'Flash-Lite', // quick facts, summaries, translations
  everyday: 'Hydrogen', // everyday tasks and quick analysis
  code: 'Hydrogen', // code: its coding beats Argon's at the same cost, about twice as fast
  research: 'Neon', // research and analysis: replaced Argon in gemini.google.com (Nov 2026)
  hardest: 'Neon', // the hardest reasoning and a final check
};

let queue = Promise.resolve();
let pending = 0;
let lastAt = 0;

function enqueue(run) {
  pending += 1;
  const p = queue.then(run).finally(() => { pending -= 1; });
  queue = p.catch(() => {});
  return p;
}

function readUsage(open) {
  if (pending) return Promise.resolve(null);
  return enqueue(async () => {
    const session = await open();
    try {
      if (!session.attached) return null;
      const windows = await session.withKept(GEMINI_TAB, GEMINI_URL, readUsageIn);
      return windows.length ? { windows, checkedAt: Date.now() } : null;
    } finally {
      await session.close();
    }
  });
}

/** A chat id from an address or an id: "ccfa5ca0a07a98a5", or null. */
function chatId(value) {
  const m = String(value || '').match(/(?:\/app\/)?([0-9a-f]{8,})\b/i);
  return m ? m[1] : null;
}

// files that may go to Google: from your work folders only; never keys, tokens, configs with secrets
const home = os.homedir();
const ALLOWED_ROOTS = [
  path.join(home, 'Documents'), path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Pictures'),
  'D:\\Capri\\capri-desktop', 'D:\\Capri\\genesis-src', 'D:\\Capri\\capri-android-ref', 'D:\\Capri\\reports', 'D:\\Obsidian\\C.A.P.R.I',
  'D:\\Capri\\styles', // 2.7a: only cloud-allowed styles are sent (styles-engine geminiImageRequest checks it)
].map((p) => path.resolve(p).toLowerCase());
const SECRET = /(^|[\\/])(\.ssh|\.gnupg|\.capri|\.aws|\.azure|\.kube|node_modules|\.git)([\\/]|$)|\.(pem|key|p12|pfx|kdbx|dpapi|ovpn|conf|env|cookies?|sqlite)$|(^|[\\/])(id_[a-z0-9]+|\.env[^\\/]*|credentials[^\\/]*|secrets?[^\\/]*|token[^\\/]*|config\.json|pim-mcp[^\\/]*)$|протон/i;
const MAX_FILES = 10;
const MAX_BYTES = 50 * 1024 * 1024;

/** The files to attach, checked: absolute, existing, in a work folder, not a secret, not too big. */
function checkFiles(list, { exists = fs.existsSync, size = (f) => fs.statSync(f).size } = {}) {
  const files = [].concat(list || []).map((f) => String(f || '').trim()).filter(Boolean);
  if (files.length > MAX_FILES) throw new Error(`не больше ${MAX_FILES} файлов за раз`);
  return files.map((f) => {
    const abs = path.resolve(f);
    const low = abs.toLowerCase();
    if (!ALLOWED_ROOTS.some((r) => low === r || low.startsWith(r + path.sep))) throw new Error(`файл вне рабочих папок, в Gemini не отправляю: ${abs}`);
    if (SECRET.test(abs)) throw new Error(`похоже на ключ или секрет, в Gemini не отправляю: ${path.basename(abs)}`);
    if (!exists(abs)) throw new Error(`нет файла: ${abs}`);
    if (size(abs) > MAX_BYTES) throw new Error(`файл больше 50 МБ: ${path.basename(abs)}`);
    return abs;
  });
}

/**
 * Asks Gemini in its tab: { answer, chat, model, signedIn }. page: a puppeteer page.
 * opts: { chat, model, files, timeoutMs, pollMs, requireSignIn }.
 */
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const DOC = /\.(pdf|docx|xlsx|pptx)$/i;
const TEXT = /\.(txt|md|markdown|json|json5|ya?ml|toml|ini|csv|tsv|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|ps1|sh|bat|cmd|kt|kts|java|c|h|cpp|hpp|cs|go|rs|rb|php|lua|sql|gradle|properties|log|diff|patch|srt|vue|svelte)$/i;
const INLINE_CHARS = 120000;

/** Images (pasted) and the rest (put into the question as text); an unknown type is refused. */
function splitFiles(files) {
  const images = [];
  const inline = [];
  for (const f of files) {
    if (IMAGE.test(f)) images.push(f);
    else if (TEXT.test(f) || DOC.test(f)) inline.push(f);
    else throw new Error(`такой файл в Gemini не передаю (нужна картинка, текст, код или PDF/DOCX/XLSX/PPTX): ${path.basename(f)}`);
  }
  return { images, inline };
}

/** Files as fenced blocks under the question: text as it is, documents through MarkItDown. */
async function inlineFiles(files, { extract, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const parts = [];
  let left = INLINE_CHARS;
  for (const f of files) {
    let body;
    if (DOC.test(f)) {
      const run = extract || require('./hub-artifacts').extractDocumentText;
      body = (await run(f, { maxChars: left })).text || '';
      if (!body.trim()) throw new Error(`не удалось достать текст из документа: ${path.basename(f)}`);
    } else {
      body = read(f);
    }
    body = body.slice(0, Math.max(0, left));
    left -= body.length;
    parts.push(`Файл «${path.basename(f)}»:\n\`\`\`\n${body}\n\`\`\``);
    if (left <= 0) { parts.push('(дальше обрезано: слишком много текста)'); break; }
  }
  return parts.join('\n\n');
}

async function askIn(page, prompt, { chat = null, model = null, task = null, files = [], clipboard = null, extract = null, timeoutMs = 300000, pollMs = 1500, requireSignIn = true, stableTicks = 2, signal, onActivity } = {}) {
  signal?.throwIfAborted();
  const text = String(prompt || '').trim();
  if (!text) throw new Error('пустой вопрос');
  const attach = checkFiles(files);
  const id = chatId(chat);
  await page.goto(id ? `${GEMINI_URL}/${id}` : GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('rich-textarea .ql-editor', { timeout: 30000 });
  const state = () => page.evaluate(() => {
    const labels = [...document.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label') || '');
    const responses = [...document.querySelectorAll('model-response')];
    const last = responses.at(-1);
    const sw = document.querySelector('bard-mode-switcher');
    return {
      signedIn: !labels.some((l) => /^(sign in|войти)$/i.test(l.trim())),
      busy: labels.some((l) => /stop response|остановить/i.test(l)),
      count: responses.length,
      asked: document.querySelectorAll('user-query').length,
      text: last ? (last.querySelector('message-content') || last).innerText : '',
      path: location.pathname,
      model: sw ? sw.innerText.replace(/\s+/g, ' ').trim() : '',
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
  // the model for this question, picked in its own menu (it stays picked for the next ones)
  const want = model ? (MODELS[model] || String(model)) : null;
  // Argon answers in Gemini's "Задача" (Task) mode; in plain chat it drops text questions after minutes
  // of thinking (found 2026-11-17: the same question, 4 min and dropped in chat, 20 s as a task)
  const asTask = task ?? /(?:argon|neon)/i.test(want || '');
  if (asTask) {
    // its button shows up a few seconds after the page
    let on = false;
    for (let i = 0; i < 12 && !on; i++) {
      await pause(1000);
      on = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /^(Задача|Task)$/i.test((x.innerText || '').trim()));
        if (b) b.click();
        return Boolean(b);
      });
    }
    if (!on) throw new Error('у Gemini не нашлось режима «Задача»');
    await pause(2500);
  }
  if (want && !before.model.toLowerCase().includes(want.toLowerCase())) {
    // the page wires its switcher a moment after it shows: open the menu until its items are there
    let opened = false;
    for (let i = 0; i < 4 && !opened; i++) {
      await pause(1500);
      await page.evaluate(() => { const b = document.querySelector('bard-mode-switcher button'); if (b) b.click(); });
      await pause(1200);
      opened = await page.evaluate(() => document.querySelectorAll('[role=menuitemradio], [role=menuitem]').length > 0);
    }
    const picked = await page.evaluate((name) => {
      // its menu: gem-menu[role=menu] > gem-menu-item[role=menuitemradio], one per model
      const want = name.toLowerCase();
      const item = [...document.querySelectorAll('[role=menuitemradio], [role=menuitem]')]
        .find((e) => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').toLowerCase().includes(want));
      if (!item) return false;
      item.click();
      return true;
    }, want);
    if (!picked) {
      await page.keyboard.press('Escape');
      throw new Error(`в меню Gemini нет модели «${want}»`);
    }
    // the switch settles a few seconds after the click: a question sent before it hangs and is dropped
    for (let i = 0; i < 10; i++) {
      await pause(1000);
      const now = await page.evaluate(() => ((document.querySelector('bard-mode-switcher') || {}).innerText || '').replace(/\s+/g, ' '));
      if (now.toLowerCase().includes(want.toLowerCase()) && i >= 2) break;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await pause(1500);
  }
  // files. Gemini ignores files set into its upload fields by automation, so: images go in as a real
  // Ctrl+V from the Windows clipboard (what was on it is put back after); text, code and documents go
  // into the question itself (documents as text, through MarkItDown)
  const { images, inline } = splitFiles(attach);
  const endAttachments = activityPhase(attach.length ? onActivity : null, 'attachments');
  let full = text;
  if (inline.length) full = `${text}\n\n${await inlineFiles(inline, { extract })}`;
  if (images.length) {
    if (!clipboard) throw new Error('картинки передаются через буфер обмена — он здесь недоступен');
    const kept = await clipboard.save();
    try {
      for (const img of images) {
        const before2 = await page.evaluate(() => document.querySelectorAll('uploader-file-preview, gem-media-attachment').length);
        await clipboard.putImage(img);
        await page.click('rich-textarea .ql-editor');
        await page.keyboard.down('Control');
        await page.keyboard.press('v');
        await page.keyboard.up('Control');
        let taken = false;
        for (let i = 0; i < 20 && !taken; i++) {
          await pause(pollMs);
          taken = await page.evaluate((n) => document.querySelectorAll('uploader-file-preview, gem-media-attachment').length > n, before2);
        }
        if (!taken) throw new Error(`Gemini не принял картинку: ${path.basename(img)}`);
      }
      await pause(1500); // its upload of the last one
    } finally {
      await clipboard.restore(kept);
    }
  }
  // the prompt goes in as one paste-like insert (typing it key by key would take minutes for a long one);
  // sent, then checked: your question must show up in the chat, else it is put in and sent once more
  // Gemini keeps a draft in its box across reloads: whatever is there that isn't this question goes first
  const send = async () => {
    signal?.throwIfAborted();
    await page.click('rich-textarea .ql-editor');
    await page.evaluate((t) => {
      const ed = document.querySelector('rich-textarea .ql-editor');
      ed.focus();
      const norm = (s) => s.replace(/\s+/g, ' ').trim();
      if (norm(ed.innerText) === norm(t)) return; // already ours (a retry)
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, t);
    }, full);
    await pause(400);
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button[aria-label]')].find((x) => /send message|отправить/i.test(x.getAttribute('aria-label') || ''));
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    });
    if (!clicked) await page.keyboard.press('Enter');
  };
  endAttachments();
  const endGeneration = activityPhase(onActivity, 'generation');
  await send();
  const checkStop = async (busy) => {
    if (!signal?.aborted) return;
    if (busy) {
      await page.evaluate(() => {
        [...document.querySelectorAll('button[aria-label]')]
          .find((button) => /stop response|остановить/i.test(button.getAttribute('aria-label') || ''))?.click();
      }).catch(() => {});
    }
    signal.throwIfAborted();
  };
  let went = false;
  for (let i = 0; i < 3 && !went; i++) {
    for (let w = 0; w < 8 && !went; w++) {
      await pause(pollMs);
      const s = await state();
      await checkStop(s.busy && s.asked > before.asked);
      went = s.asked > before.asked || s.busy || s.count > before.count;
    }
    if (!went && i < 2) await send();
  }
  if (!went) throw new Error('вопрос не ушёл в Gemini (кнопка отправки не сработала)');
  // done: a new answer is there, Gemini no longer shows "Stop", and its text stopped changing.
  // dropped: the question showed up, then vanished with no answer (Gemini's Argon does that to some
  // plain-text questions after minutes of "thinking") — said at once, so the caller can ask another model
  const started = Date.now();
  let prev = null;
  let same = 0;
  let seen = false;
  let endVerification;
  while (Date.now() - started < timeoutMs) {
    await pause(pollMs);
    const s = await state();
    await checkStop(s.busy && (seen || s.asked > before.asked));
    if (s.asked > before.asked || s.busy) seen = true;
    if (seen && !s.busy && s.asked <= before.asked && s.count <= before.count) {
      const err = new Error(`Gemini сбросил вопрос без ответа (${s.model || want || 'модель'})`);
      err.code = 'DROPPED';
      throw err;
    }
    if (s.count > before.count && !s.busy && s.text.trim()) {
      if (!endVerification) {
        endGeneration();
        endVerification = activityPhase(onActivity, 'responseReady');
      }
      same = s.text === prev ? same + 1 : 0;
      if (same >= stableTicks - 1 && s.text === prev) {
        const answer = s.text.replace(/(?:\s*\n\s*image_[0-9a-f]+\.\w+)+\s*$/i, '').trim(); // pasted images' names, shown under it
        endVerification();
        return { answer, chat: chatId(s.path), model: s.model, signedIn: s.signedIn };
      }
    }
    prev = s.text;
  }
  throw new Error('Gemini не ответил за отведённое время');
}

/**
 * One question at a time across her (and your agents'), a pause between them, in Gemini's lasting tab.
 * open(): a session of her MAIN window (browser.openSession) with withKept() and close().
 */
function ask(prompt, { open, chat, model, files, minGapMs = 4000, onQuota, ...rest } = {}) {
  const run = async () => {
    rest.signal?.throwIfAborted();
    const wait = lastAt + minGapMs - Date.now();
    if (wait > 0) await pause(wait);
    const s = await open();
    const inTab = (m) => {
      const go = async (page) => {
        const said = await askIn(page, prompt, { chat, model: m, files, ...rest });
        if (onQuota && s.attached && !rest.signal?.aborted) {
          const windows = await readUsageIn(page).catch(() => []);
          if (windows.length) onQuota(windows);
        }
        return said;
      };
      return s.withKept ? s.withKept(GEMINI_TAB, GEMINI_URL, go) : s.withTab(go);
    };
    try {
      try {
        return await inTab(model);
      } catch (err) {
        // Argon dropped it: Hydrogen answers instead, and the answer says so
        if (err.code !== 'DROPPED' || !model || MODELS[model] === MODELS.everyday) throw err;
        const said = await inTab('everyday');
        return { ...said, fellBack: `${MODELS[model] || model} сбросил вопрос — ответил ${MODELS.everyday}` };
      }
    } finally {
      lastAt = Date.now();
      await s.close();
    }
  };
  return enqueue(run);
}

/** The Windows clipboard through Electron, for pasting images; what was on it is kept and put back. */
// (this Electron's clipboard is the async web one: read/write with ClipboardItem, as main.js uses it)
function electronClipboard() {
  const { clipboard, nativeImage, ClipboardItem } = require('electron');
  return {
    save: async () => {
      const items = clipboard.read ? await clipboard.read().catch(() => null) : null;
      const text = await Promise.resolve(clipboard.readText()).catch(() => '');
      return { items, text };
    },
    putImage: async (file) => {
      const img = nativeImage.createFromPath(file);
      if (img.isEmpty()) throw new Error(`не читается как картинка: ${path.basename(file)}`);
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([img.toPNG()], { type: 'image/png' }) })]);
    },
    restore: async (kept) => {
      if (kept && kept.items && kept.items.length) {
        try { await clipboard.write(kept.items); return; } catch { /* fall back to its text */ }
      }
      await Promise.resolve(clipboard.writeText(String((kept && kept.text) || ''))).catch(() => {});
    },
  };
}

module.exports = { ask, askIn, readUsage, chatId, checkFiles, splitFiles, inlineFiles, electronClipboard, MODELS, GEMINI_URL, GEMINI_TAB };
