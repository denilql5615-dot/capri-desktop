'use strict';

// 2.7c: Google Drive through rclone, so Drive works for the local model, Claude and Codex without
// Antigravity's plugin. Only reading and one-way copies to Drive: no `sync`, `delete`, `purge` or `move`.
// Sign-in is Danyal's: `rclone config` opens Google's page in his browser; the token stays in rclone.conf.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const DEFAULT_REMOTE = 'gdrive';
const SAFE_COMMANDS = new Set(['version', 'listremotes', 'about', 'lsjson', 'copyto', 'cat']);
const REMOTE_RE = /^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,40}$/;

const SETUP_STEPS = Object.freeze([
  '1. Скачай rclone для Windows с rclone.org/downloads и распакуй rclone.exe в D:\\Capri\\tools\\rclone\\.',
  '2. В терминале: D:\\Capri\\tools\\rclone\\rclone.exe config → n (new) → имя gdrive → тип drive → client_id/secret пусто → scope 1 (full) → войти в Google в браузере.',
  '3. Вернись сюда и нажми «Проверить» (или /срез статус).',
]);

function defaultCandidates() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [
    'D:\\Capri\\tools\\rclone\\rclone.exe',
    path.join(local, 'Microsoft', 'WinGet', 'Links', 'rclone.exe'),
    'C:\\Program Files\\rclone\\rclone.exe',
    path.join(os.homedir(), 'scoop', 'shims', 'rclone.exe'),
  ];
}

/** A path on the remote: relative, no `..`, no leading dash (so it can never read as a flag). */
function cleanRemotePath(p) {
  const clean = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (clean.split('/').some((part) => part === '..') || clean.startsWith('-')) return null;
  return clean;
}

class RcloneDrive {
  constructor(opts = {}) {
    this.getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({});
    this.execFileImpl = opts.execFile || execFile;
    this.exists = opts.exists || ((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    this.candidates = opts.candidates || defaultCandidates();
    this.cached = null;
  }

  binary() {
    const own = this.getConfig()?.rcloneBin;
    for (const p of [own, ...this.candidates]) if (p && this.exists(p)) return p;
    return null;
  }

  remote() {
    const r = String(this.getConfig()?.rcloneRemote || DEFAULT_REMOTE).replace(/:$/, '');
    return REMOTE_RE.test(r) ? r : DEFAULT_REMOTE;
  }

  /** Runs one allowed rclone command; resolves stdout or rejects with plain words. */
  run(args, { timeoutMs = 60000 } = {}) {
    const bin = this.binary();
    if (!bin) return Promise.reject(new Error('rclone не установлен.'));
    if (!SAFE_COMMANDS.has(args[0])) return Promise.reject(new Error(`rclone ${args[0]} не разрешён.`));
    return new Promise((resolve, reject) => {
      this.execFileImpl(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const line = String(stderr || err.message || '').split(/\r?\n/).filter(Boolean).pop() || 'ошибка';
          reject(new Error(`rclone: ${line.slice(0, 300)}`));
        } else resolve(String(stdout || ''));
      });
    });
  }

  /** Is rclone there and is the Drive remote set up? Cached for the connector panel, which reads synchronously. */
  async status() {
    const bin = this.binary();
    const remote = this.remote();
    if (!bin) {
      this.cached = { installed: false, configured: false, remote, detail: 'rclone не установлен' };
      return this.cached;
    }
    try {
      const list = (await this.run(['listremotes'], { timeoutMs: 15000 })).split(/\r?\n/).map((l) => l.trim().replace(/:$/, '')).filter(Boolean);
      const configured = list.includes(remote);
      this.cached = { installed: true, configured, remote, bin, detail: configured ? `rclone · ${remote}:` : `rclone есть, нет удалённого «${remote}:» — нужен rclone config` };
    } catch (err) {
      this.cached = { installed: true, configured: false, remote, bin, detail: err.message };
    }
    return this.cached;
  }

  cachedStatus() {
    return this.cached;
  }

  /** One-way copy of a local file to a path on Drive (overwrites that one file only). */
  async copyTo(localFile, remotePath) {
    const dest = cleanRemotePath(remotePath);
    if (!dest) throw new Error('Недопустимый путь на Диске.');
    if (!this.exists(localFile)) throw new Error('Нет локального файла для выгрузки.');
    await this.run(['copyto', localFile, `${this.remote()}:${dest}`], { timeoutMs: 5 * 60 * 1000 });
    return { ok: true, remotePath: `${this.remote()}:${dest}` };
  }

  /** Files on Drive whose names contain the words of the query (two levels deep, files only). */
  async search(query = '', { limit = 20, folder = '' } = {}) {
    const base = cleanRemotePath(folder);
    if (base === null) throw new Error('Недопустимая папка.');
    const out = await this.run(['lsjson', `${this.remote()}:${base}`, '--max-depth', '2', '--files-only', '--no-mimetype'], { timeoutMs: 90000 });
    let rows = [];
    try { rows = JSON.parse(out); } catch { rows = []; }
    const words = String(query || '').toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    const hits = rows.filter((r) => !words.length || words.some((w) => String(r.Path || '').toLowerCase().includes(w)));
    hits.sort((a, b) => String(b.ModTime || '').localeCompare(String(a.ModTime || '')));
    return hits.slice(0, limit).map((r) => ({ path: r.Path, size: r.Size, modTime: r.ModTime }));
  }
}

module.exports = { RcloneDrive, cleanRemotePath, SETUP_STEPS, DEFAULT_REMOTE };
