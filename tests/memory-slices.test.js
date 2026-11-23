'use strict';

// 2.7c: memory slices (OpenNotebook mirror + digest for Gemini Notebook) and Google Drive through rclone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemorySlices, dueSlot, indexNotes, parseOnDate } = require('../src/main/memory-slices');
const { RcloneDrive, cleanRemotePath } = require('../src/main/rclone-drive');
const { ConnectorsEngine, sanitizeDigestMarkdown } = require('../src/main/connectors-engine');
const { SlashCommandEngine } = require('../src/main/slash-commands');

const at = (s) => new Date(s).getTime();

test('dueSlot: the latest passed slot runs once; a missed one is caught up', () => {
  const times = ['09:00', '21:00'];
  assert.equal(dueSlot(at('2026-11-23T08:59:00'), at('2026-11-22T21:00:30'), times), null);
  assert.equal(dueSlot(at('2026-11-23T09:01:00'), at('2026-11-22T21:00:30'), times), at('2026-11-23T09:00:00'));
  assert.equal(dueSlot(at('2026-11-23T09:01:00'), at('2026-11-23T09:00:10'), times), null);
  // Capri was off overnight: at 07:00 the 21:00 slot of yesterday is still owed.
  assert.equal(dueSlot(at('2026-11-23T07:00:00'), at('2026-11-22T09:00:05'), times), at('2026-11-22T21:00:00'));
  assert.equal(parseOnDate('2026-11-23 14:34:19.890352+00:00'), Date.parse('2026-11-23T14:34:19.890+00:00'));
});

function vault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slices-'));
  const put = (rel, text, mtime) => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text, 'utf8');
    if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000);
    return f;
  };
  return { root, put };
}

test('indexNotes leaves out private, Tor and raw folders', () => {
  const { root, put } = vault();
  put('Что дальше.md', 'a');
  put('Инструменты/Коннекторы.md', 'b');
  put('Приват/Секрет.md', 'c');
  put('tor-safe/x.md', 'd');
  put('Я/Обо мне.md', 'e');
  assert.deepEqual([...indexNotes(root).keys()].sort(), ['Коннекторы', 'Что дальше']);
});

function fakeOpenNotebook(sources) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method || 'GET', path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null });
    const json = (v) => new Response(JSON.stringify(v), { status: 200 });
    if (u.pathname === '/api/notebooks') return json([{ id: 'notebook:1', name: 'ALTAI:RE — База памяти', archived: false }]);
    if (u.pathname === '/api/sources' && (opts.method || 'GET') === 'GET') return json(sources);
    if (u.pathname === '/api/sources/json') return json({ id: `source:new-${calls.length}` });
    if (opts.method === 'DELETE') return json({ ok: true });
    return new Response('nope', { status: 404 });
  };
  return { fetch, calls };
}

test('refreshOpenNotebook re-uploads only changed mirrored notes, sanitized, and only unlinks the old copy', async () => {
  const { root, put } = vault();
  const made = at('2026-11-23T14:34:19Z');
  put('Что дальше.md', '# План\nшаг\n## Приватное\nне для облака\n## Дальше\nключ sk-abcdefghijklmnop123', made + 3600e3);
  put('Решения.md', 'старое', made - 3600e3);
  put('Не в блокноте.md', 'x', made + 3600e3);
  const { fetch, calls } = fakeOpenNotebook([
    { id: 'source:a', title: 'Что дальше', created: '2026-11-23 14:34:19.890352+00:00' },
    { id: 'source:b', title: 'Решения', created: '2026-11-23 14:34:19.890352+00:00' },
  ]);
  const slices = new MemorySlices({ fetch, notesRoot: root, sanitize: sanitizeDigestMarkdown });
  const res = await slices.refreshOpenNotebook();
  assert.equal(res.ok, true);
  assert.deepEqual(res.refreshed, ['Что дальше']);
  assert.equal(res.unchanged, 1);
  const post = calls.find((c) => c.path === '/api/sources/json');
  assert.deepEqual(post.body.notebooks, ['notebook:1']);
  assert.equal(post.body.type, 'text');
  assert.doesNotMatch(post.body.content, /не для облака/);
  assert.match(post.body.content, /\[REDACTED\]/);
  const del = calls.filter((c) => c.method === 'DELETE');
  assert.deepEqual(del.map((c) => c.path), ['/api/notebooks/notebook%3A1/sources/source%3Aa']);
  assert.equal(calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/api/sources/')), false);
});

test('OpenNotebook down: a plain error, the digest still gets built', async () => {
  const { root } = vault();
  let built = 0;
  const slices = new MemorySlices({
    fetch: async () => { throw new TypeError('fetch failed'); },
    notesRoot: root,
    connectors: { buildNotebookDigest: () => { built += 1; return { ok: true, chars: 10, path: 'x', includedFiles: [] }; } },
  });
  const r = await slices.run();
  assert.match(r.openNotebook.error, /не отвечает/);
  assert.equal(built, 1);
  assert.match(r.drive.skipped, /выключена/);
});

function sliceWithDrive(drivePatch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slices-d-'));
  const digestPath = path.join(dir, 'digest.md');
  fs.writeFileSync(digestPath, '# d', 'utf8');
  let cfg = {};
  const copies = [];
  const drive = {
    status: async () => ({ configured: true, detail: 'rclone · gdrive:' }),
    copyTo: async (local, remote) => { copies.push([local, remote]); return { ok: true, remotePath: `gdrive:${remote}` }; },
    ...drivePatch,
  };
  const slices = new MemorySlices({
    getConfig: () => cfg,
    saveConfig: (p) => { cfg = { ...cfg, ...p }; },
    fetch: async () => { throw new TypeError('fetch failed'); },
    notesRoot: dir,
    drive,
    archiveDir: path.join(dir, 'slices'),
    connectors: { buildNotebookDigest: () => ({ ok: true, chars: 3, path: digestPath, includedFiles: ['a.md'] }) },
    now: () => at('2026-11-23T21:00:30'),
  });
  return { slices, copies, cfg: () => cfg, dir };
}

test('the digest goes to Drive only after Danyal turns it on', async () => {
  const { slices, copies, dir } = sliceWithDrive();
  await slices.run();
  assert.equal(copies.length, 0);
  slices.setDrive(true);
  const r = await slices.run();
  assert.equal(r.drive.ok, true);
  assert.deepEqual(copies[0][1], 'ALTAI-RE/Gemini Notebook/altai-re-digest.md');
  assert.ok(fs.readdirSync(path.join(dir, 'slices')).some((n) => /^digest-2026-11-23-2100\.md$/.test(n)));
  assert.match(slices.statusText(), /Диск: gdrive:ALTAI-RE/);

  const notReady = sliceWithDrive({ status: async () => ({ configured: false, detail: 'rclone не установлен' }) });
  notReady.slices.setDrive(true);
  assert.equal((await notReady.slices.run()).drive.error, 'rclone не установлен');
});

test('tick runs a slice once per slot and not when switched off', async () => {
  const { slices } = sliceWithDrive();
  assert.ok(await slices.tick());
  assert.equal(await slices.tick(), null);
  const off = sliceWithDrive();
  off.slices._save({ enabled: false });
  assert.equal(await off.slices.tick(), null);
});

test('rclone: only safe commands, clean remote paths, status from listremotes', async () => {
  assert.equal(cleanRemotePath('../x'), null);
  assert.equal(cleanRemotePath('-x'), null);
  assert.equal(cleanRemotePath('\\A\\b.md'), 'A/b.md');
  const calls = [];
  const drive = new RcloneDrive({
    getConfig: () => ({}),
    candidates: ['C:/rclone.exe'],
    exists: (p) => p === 'C:/rclone.exe' || p === 'C:/d.md',
    execFile: (bin, args, opts, cb) => { calls.push(args); cb(null, args[0] === 'listremotes' ? 'gdrive:\nother:\n' : '', ''); },
  });
  assert.equal((await drive.status()).configured, true);
  assert.equal(drive.cachedStatus().detail, 'rclone · gdrive:');
  await assert.rejects(drive.run(['delete', 'gdrive:x']), /не разрешён/);
  await assert.rejects(drive.run(['sync', 'a', 'b']), /не разрешён/);
  await drive.copyTo('C:/d.md', 'ALTAI-RE/d.md');
  assert.deepEqual(calls.at(-1), ['copyto', 'C:/d.md', 'gdrive:ALTAI-RE/d.md']);
  await assert.rejects(drive.copyTo('C:/d.md', '../../x'), /Недопустимый/);
  const none = new RcloneDrive({ candidates: [], exists: () => false });
  assert.equal((await none.status()).installed, false);
});

test('Google Workspace counts as connected through rclone, without Antigravity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slices-c-'));
  const eng = new ConnectorsEngine({
    userDataDir: dir,
    geminiConfigFile: path.join(dir, 'none.json'),
    geminiAccountsFiles: [],
    deps: { rcloneStatus: () => ({ configured: true, detail: 'rclone · gdrive:' }) },
  });
  assert.deepEqual(eng.inspectGoogleWorkspace(), { status: 'connected', detail: 'rclone · gdrive:' });
});

test('/срез: status, drive switch, run', async () => {
  const { slices, copies } = sliceWithDrive();
  const slash = new SlashCommandEngine({ skillRoots: [], deps: { memorySlices: () => slices } });
  assert.match((await slash.run({ text: '/срез статус' })).reply, /Выгрузка дайджеста на Google Диск: выключена/);
  assert.match((await slash.run({ text: '/срез диск вкл' })).reply, /включена/);
  const run = await slash.run({ text: '/срез' });
  assert.match(run.reply, /OpenNotebook: OpenNotebook не отвечает/);
  assert.match(run.reply, /Дайджест для Gemini Notebook: 3 знаков/);
  assert.match(run.reply, /Google Диск: gdrive:ALTAI-RE/);
  assert.equal(copies.length, 1);
  assert.match((await slash.run({ text: '/срез выкл' })).reply, /выключены/);
  assert.match((await slash.run({ text: '/срез ерунда' })).reply, /Варианты/);
});
