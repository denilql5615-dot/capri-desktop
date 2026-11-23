'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../src/main/gemini');

// a fake Gemini tab: answers after a few polls, "Stop" shown while it writes
function fakePage({ signedIn = true, polls = 3, reply = 'Париж' } = {}) {
  const seen = { url: null, inserted: '', sent: false, clicks: 0 };
  let n = 0;
  let responses = 0;
  const page = {
    goto: async (u) => { seen.url = u; },
    waitForSelector: async () => {},
    click: async () => { seen.clicks++; },
    keyboard: { press: async () => { seen.sent = true; } },
    evaluate: async (fn, arg) => {
      const src = String(fn);
      if (src.includes('insertText')) { seen.inserted = arg; return undefined; }
      if (src.includes('send message')) { seen.sent = true; responses = 1; return true; }
      // state()
      if (seen.sent) n++;
      const writing = seen.sent && n < polls;
      return { signedIn, busy: writing, count: responses, text: seen.sent ? (writing ? reply.slice(0, 2) : reply) : '', path: seen.sent ? '/app/ccfa5ca0a07a98a5' : '/app' };
    },
  };
  return { page, seen };
}

test('askIn: one insert of the whole prompt, sent, waits for "Stop" to go and the text to settle', async () => {
  const { page, seen } = fakePage();
  const activity = [];
  const r = await gemini.askIn(page, 'Оцени план:\n1) …', { pollMs: 1, onActivity: (step) => activity.push([step.name, step.state]) });
  assert.deepEqual({ answer: r.answer, chat: r.chat, signedIn: r.signedIn }, { answer: 'Париж', chat: 'ccfa5ca0a07a98a5', signedIn: true });
  assert.equal(seen.url, 'https://gemini.google.com/app');
  assert.equal(seen.inserted, 'Оцени план:\n1) …');
  assert.deepEqual(activity, [['generation', 'running'], ['generation', 'done'], ['responseReady', 'running'], ['responseReady', 'done']]);
});

test('a cancelled Web Gemini request waiting in the queue never opens a tab', async () => {
  const signal = AbortSignal.abort();
  let opened = false;
  await assert.rejects(gemini.ask('fixture', { signal, open: async () => { opened = true; } }), { name: 'AbortError' });
  assert.equal(opened, false);
});

test('stopping Web Gemini after inserting a draft prevents sending it', async () => {
  const { page, seen } = fakePage();
  const abort = new AbortController();
  const evaluate = page.evaluate;
  page.evaluate = async (fn, arg) => {
    const result = await evaluate(fn, arg);
    if (String(fn).includes('insertText')) abort.abort();
    return result;
  };
  await assert.rejects(gemini.askIn(page, 'fixture', { signal: abort.signal, pollMs: 1 }), { name: 'AbortError' });
  assert.equal(seen.sent, false);
});

test('askIn: a chat id continues that conversation; signed out → told to sign in, nothing sent', async () => {
  const a = fakePage();
  await gemini.askIn(a.page, 'ещё', { chat: 'https://gemini.google.com/app/ccfa5ca0a07a98a5', pollMs: 1 });
  assert.equal(a.seen.url, 'https://gemini.google.com/app/ccfa5ca0a07a98a5');
  const b = fakePage({ signedIn: false });
  await assert.rejects(gemini.askIn(b.page, 'x', { pollMs: 1 }), /не выполнен вход в Google/);
  assert.equal(b.seen.inserted, '');
});

test('checkFiles: work folders only, never keys or secrets, not too many', () => {
  const os = require('node:os');
  const path = require('node:path');
  const ok = { exists: () => true, size: () => 1000 };
  const doc = path.join(os.homedir(), 'Documents', 'Capri', 'план.pdf');
  assert.deepEqual(gemini.checkFiles([doc], ok), [path.resolve(doc)]);
  assert.deepEqual(gemini.checkFiles(['D:\\Capri\\capri-desktop\\src\\main\\web.js'], ok).length, 1);
  assert.throws(() => gemini.checkFiles([path.join(os.homedir(), '.ssh', 'capri_server')], ok), /вне рабочих папок|секрет/);
  assert.throws(() => gemini.checkFiles(['C:\\Windows\\System32\\drivers\\etc\\hosts'], ok), /вне рабочих папок/);
  assert.throws(() => gemini.checkFiles([path.join(os.homedir(), 'Downloads', 'tj-02.protonvpn.tcp.ovpn')], ok), /секрет/);
  assert.throws(() => gemini.checkFiles([path.join(os.homedir(), 'Documents', 'Capri', '.env')], ok), /секрет/);
  assert.throws(() => gemini.checkFiles(['D:\\Capri\\capri-desktop\\node_modules\\x\\a.js'], ok), /секрет/);
  assert.throws(() => gemini.checkFiles(Array(11).fill(doc), ok), /не больше 10/);
  assert.throws(() => gemini.checkFiles([doc], { exists: () => true, size: () => 60 * 1024 * 1024 }), /больше 50 МБ/);
});

test('files: images pasted, text and documents put into the question, other types refused', async () => {
  const { images, inline } = gemini.splitFiles(['a.png', 'b.JPG', 'c.js', 'd.md', 'e.pdf']);
  assert.deepEqual(images, ['a.png', 'b.JPG']);
  assert.deepEqual(inline, ['c.js', 'd.md', 'e.pdf']);
  assert.throws(() => gemini.splitFiles(['x.exe']), /такой файл в Gemini не передаю/);
  const text = await gemini.inlineFiles(['D:/w/c.js', 'D:/w/e.pdf'], { read: () => 'const a = 1;', extract: async () => ({ text: 'PDF text' }) });
  assert.match(text, /Файл «c\.js»:\n```\nconst a = 1;\n```/);
  assert.match(text, /Файл «e\.pdf»:\n```\nPDF text\n```/);
});

test('askIn with an image: pasted from the clipboard with a real Ctrl+V, then the clipboard put back', async () => {
  const { page, seen } = fakePage();
  const keys = [];
  page.keyboard = { down: async (k) => keys.push(`down:${k}`), up: async (k) => keys.push(`up:${k}`), press: async (k) => { keys.push(k); } };
  let previews = 0;
  const ev = page.evaluate;
  page.evaluate = async (fn, arg) => {
    const src = String(fn);
    if (src.includes('uploader-file-preview')) {
      if (src.includes('> n')) return previews > arg;
      return previews;
    }
    return ev(fn, arg);
  };
  const log = [];
  const clipboard = { save: () => { log.push('save'); return { text: 'мой буфер' }; }, putImage: (f) => { log.push(`put:${f}`); previews++; }, restore: (k) => log.push(`restore:${k.text}`) };
  const os = require('node:os');
  const path = require('node:path');
  const img = path.join(os.homedir(), 'Pictures', 'shot.png');
  const fs = require('node:fs');
  const real = fs.existsSync;
  fs.existsSync = (f) => (f === img ? true : real(f));
  const realStat = fs.statSync;
  fs.statSync = (f) => (f === img ? { size: 10 } : realStat(f));
  try {
    await gemini.askIn(page, 'что на картинке?', { files: [img], clipboard, pollMs: 1 });
  } finally {
    fs.existsSync = real;
    fs.statSync = realStat;
  }
  assert.deepEqual(log, ['save', `put:${img}`, 'restore:мой буфер']);
  assert.deepEqual(keys.slice(0, 3), ['down:Control', 'v', 'up:Control']);
  assert.equal(seen.inserted, 'что на картинке?');
});

test('askIn: a question that shows up and then vanishes without an answer is "dropped" at once', async () => {
  const { page } = fakePage();
  let n = 0;
  const ev = page.evaluate;
  page.evaluate = async (fn, arg) => {
    const src = String(fn);
    if (src.includes('user-query') && src.includes('model-response')) { // state()
      n++;
      if (n === 1) return { signedIn: true, busy: false, count: 0, asked: 0, text: '', path: '/app', model: 'Gemini Argon' };
      if (n < 4) return { signedIn: true, busy: true, count: 0, asked: 1, text: '', path: '/app', model: 'Gemini Argon' };
      return { signedIn: true, busy: false, count: 0, asked: 0, text: '', path: '/app', model: 'Gemini Argon' };
    }
    return ev(fn, arg);
  };
  await assert.rejects(gemini.askIn(page, 'вопрос', { pollMs: 1 }), (e) => e.code === 'DROPPED');
});

test('ask: one question at a time, a pause between them, the session closed each time', async () => {
  const order = [];
  let closes = 0;
  const open = async () => ({
    withTab: async (fn) => { const { page } = fakePage({ reply: `ответ ${order.length}` }); order.push('start'); const r = await fn(page); order.push('end'); return r; },
    close: async () => { closes++; },
  });
  const [x, y] = await Promise.all([gemini.ask('a', { open, pollMs: 1, minGapMs: 5 }), gemini.ask('b', { open, pollMs: 1, minGapMs: 5 })]);
  assert.deepEqual(order, ['start', 'end', 'start', 'end']); // never two at once
  assert.equal(closes, 2);
  assert.ok(x.answer && y.answer);
});

test('MODELS maps research and hardest roles to Neon', () => {
  assert.equal(gemini.MODELS.research, 'Neon');
  assert.equal(gemini.MODELS.hardest, 'Neon');
  assert.equal(gemini.MODELS.code, 'Hydrogen');
});

test('pair: two Web Gemini models in ONE MAIN session at once; the second tab opens after the first question went out', async () => {
  const log = [];
  let opened = 0;
  let closed = 0;
  const tab = (name) => {
    const { page, seen } = fakePage({ reply: `ответ ${name}`, polls: 4 });
    const evaluate = page.evaluate;
    page.evaluate = async (fn, arg) => {
      const out = await evaluate(fn, arg);
      if (String(fn).includes('send message')) log.push(`${name} sent`);
      return out && typeof out === 'object' && 'signedIn' in out ? { ...out, model: 'Hydrogen Neon' } : out;
    };
    return { page, seen };
  };
  const session = {
    attached: true,
    withKept: async (_match, _url, fn) => { log.push('kept tab'); return fn(tab('kept').page); },
    withTab: async (fn) => { log.push('passing tab'); return fn(tab('passing').page); },
    close: async () => { closed += 1; },
  };
  const [hydrogen, neon] = gemini.pair(['everyday', 'research'], {
    open: async () => { opened += 1; return session; }, minGapMs: 0, pollMs: 1, task: false,
  });
  const [a, b] = await Promise.all([hydrogen('вопрос'), neon('вопрос')]);
  assert.equal(a.answer, 'ответ kept');
  assert.equal(b.answer, 'ответ passing');
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.ok(log.indexOf('passing tab') > log.indexOf('kept sent'), log.join(' → '));
});

test('pair: a failing first tab still lets the second one run, and each caller gets its own result', async () => {
  const session = {
    attached: true,
    withKept: async () => { throw new Error('вкладка недоступна'); },
    withTab: async (fn) => {
      const { page } = fakePage({ reply: 'ок' });
      const evaluate = page.evaluate;
      page.evaluate = async (f, arg) => { const out = await evaluate(f, arg); return out && typeof out === 'object' && 'signedIn' in out ? { ...out, model: 'Neon' } : out; };
      return fn(page);
    },
    close: async () => {},
  };
  const [first, second] = gemini.pair(['everyday', 'research'], { open: async () => session, minGapMs: 0, pollMs: 1, task: false });
  const [x, y] = await Promise.allSettled([first('q'), second('q')]);
  assert.equal(x.status, 'rejected');
  assert.equal(y.value.answer, 'ок');
});