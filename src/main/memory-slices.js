'use strict';

// 2.7c: memory slices twice a day. One memory (the Obsidian notes) feeds two notebooks:
// - OpenNotebook (local, :5055): notes already mirrored there as sources are refreshed when the note changed.
//   A source cannot be rewritten, so a fresh copy is added and the old one is only unlinked from the
//   notebook (the reference goes, the source stays in OpenNotebook) — nothing is deleted.
// - Gemini Notebook: the sanitized digest (buildNotebookDigest) is archived and, only when Danyal turned
//   it on (`notebookSlices.drive`), copied to Google Drive through rclone.
// Never: notes from private / 18+ / Tor places, secrets (sanitizer), anything from chats.

const fs = require('node:fs');
const path = require('node:path');

const OPEN_NOTEBOOK_API = 'http://127.0.0.1:5055';
const DEFAULT_NOTEBOOK_NAME = 'ALTAI:RE — База памяти';
const DEFAULT_TIMES = Object.freeze(['09:00', '21:00']);
const DEFAULT_DRIVE_FILE = 'ALTAI-RE/Gemini Notebook/altai-re-digest.md';
const MAX_REFRESH_PER_RUN = 25;
const KEEP_ARCHIVE = 14;
const PRIVATE_PATH_RE = /(?:^|[\\/])(?:Я|Приват[^\\/]*|private[^\\/]*|18\+[^\\/]*|nsfw[^\\/]*|tor[^\\/]*|onion[^\\/]*|Сырьё)(?:[\\/]|$)/i;

/** OpenNotebook dates look like "2026-11-23 14:34:19.890352+00:00". */
function parseOnDate(s) {
  const t = Date.parse(String(s || '').replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(t) ? t : 0;
}

/** The latest slot (HH:MM, local time) that is due: passed today (or yesterday) and not run since. */
function dueSlot(now, lastRunAt, times = DEFAULT_TIMES) {
  const slots = [];
  for (const back of [1, 0]) {
    for (const hm of times) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm));
      if (!m) continue;
      const d = new Date(now);
      d.setDate(d.getDate() - back);
      d.setHours(Number(m[1]), Number(m[2]), 0, 0);
      slots.push(d.getTime());
    }
  }
  const passed = slots.filter((t) => t <= now).sort((a, b) => b - a);
  const latest = passed[0];
  if (!latest) return null;
  return (Number(lastRunAt) || 0) < latest ? latest : null;
}

/** Markdown notes under a folder by their title (file name without .md); private places are left out. */
function indexNotes(rootDir, maxFiles = 2000) {
  const out = new Map();
  const walk = (dir) => {
    if (out.size >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (PRIVATE_PATH_RE.test(path.relative(rootDir, full))) continue;
      if (e.isDirectory()) walk(full);
      else if (e.name.toLowerCase().endsWith('.md') && !out.has(e.name.slice(0, -3))) out.set(e.name.slice(0, -3), full);
    }
  };
  walk(rootDir);
  return out;
}

class MemorySlices {
  constructor(opts = {}) {
    this.getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({});
    this.saveConfig = typeof opts.saveConfig === 'function' ? opts.saveConfig : () => {};
    this.connectors = opts.connectors || null; // buildNotebookDigest(), notebookDigestFile()
    this.drive = opts.drive || null; // RcloneDrive
    this.sanitize = typeof opts.sanitize === 'function' ? opts.sanitize : (t) => t;
    this.notesRoot = typeof opts.notesRoot === 'function' ? opts.notesRoot : () => opts.notesRoot || '';
    this.fetchImpl = opts.fetch || globalThis.fetch;
    this.api = opts.api || OPEN_NOTEBOOK_API;
    this.archiveDir = opts.archiveDir || null;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.running = null;
  }

  settings() {
    const s = this.getConfig()?.notebookSlices || {};
    return {
      enabled: s.enabled !== false,
      times: Array.isArray(s.times) && s.times.length ? s.times : [...DEFAULT_TIMES],
      notebookId: s.notebookId || '',
      notebookName: s.notebookName || DEFAULT_NOTEBOOK_NAME,
      drive: s.drive === true,
      driveFile: s.driveFile || DEFAULT_DRIVE_FILE,
      lastRunAt: Number(s.lastRunAt) || 0,
      last: s.last || null,
    };
  }

  _save(patch) {
    const cur = this.getConfig()?.notebookSlices || {};
    this.saveConfig({ notebookSlices: { ...cur, ...patch } });
  }

  setDrive(on) {
    this._save({ drive: on === true });
    return this.settings();
  }

  /** Called every minute: runs a slice when a slot has come. */
  async tick() {
    const s = this.settings();
    if (!s.enabled || this.running) return null;
    if (!dueSlot(this.now(), s.lastRunAt, s.times)) return null;
    return this.run({ reason: 'schedule' });
  }

  run({ reason = 'manual' } = {}) {
    if (this.running) return this.running;
    this.running = this._run(reason).finally(() => { this.running = null; });
    return this.running;
  }

  async _run(reason) {
    const at = this.now();
    const result = { ok: true, at: new Date(at).toISOString(), reason, openNotebook: null, digest: null, drive: null };
    try {
      result.openNotebook = await this.refreshOpenNotebook();
    } catch (err) {
      result.openNotebook = { ok: false, error: String(err?.message || err) };
    }
    result.digest = this.buildDigest();
    result.drive = await this.uploadDigest(result.digest);
    result.ok = Boolean(result.digest?.ok) && result.openNotebook?.ok !== false;
    const brief = {
      at: result.at,
      reason,
      refreshed: result.openNotebook?.refreshed?.length || 0,
      openNotebookError: result.openNotebook?.error || '',
      digestChars: result.digest?.chars || 0,
      digestError: result.digest?.ok ? '' : (result.digest?.error || ''),
      drive: result.drive?.ok ? result.drive.remotePath : (result.drive?.skipped || result.drive?.error || ''),
    };
    this._save({ lastRunAt: at, last: brief });
    return result;
  }

  async _json(url, opts = {}) {
    const res = await this.fetchImpl(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 20000) });
    if (!res.ok) throw new Error(`OpenNotebook: HTTP ${res.status} на ${url.replace(this.api, '')}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async findNotebook() {
    const s = this.settings();
    const list = await this._json(`${this.api}/api/notebooks`);
    const nb = (Array.isArray(list) ? list : []).find((n) => (s.notebookId ? n.id === s.notebookId : n.name === s.notebookName && !n.archived));
    if (!nb) throw new Error(`В OpenNotebook нет блокнота «${s.notebookId || s.notebookName}».`);
    return nb;
  }

  /** Re-uploads notes that changed after their copy in OpenNotebook was made. */
  async refreshOpenNotebook() {
    const root = this.notesRoot();
    if (!root || !fs.existsSync(root)) return { ok: false, error: 'Папка заметок Obsidian не найдена.' };
    let nb;
    try {
      nb = await this.findNotebook();
    } catch (err) {
      const msg = String(err?.message || err);
      return { ok: false, error: /fetch failed|ECONNREFUSED|timeout|aborted/i.test(msg) ? 'OpenNotebook не отвечает (:5055) — запусти его в /docker.' : msg };
    }
    // The API gives at most 100 sources a page.
    const sources = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = await this._json(`${this.api}/api/sources?notebook_id=${encodeURIComponent(nb.id)}&limit=100&offset=${offset}`);
      if (!Array.isArray(page) || !page.length) break;
      sources.push(...page);
      if (page.length < 100) break;
    }
    const newest = new Map();
    for (const src of sources) {
      const prev = newest.get(src.title);
      const t = Math.max(parseOnDate(src.created), parseOnDate(src.updated));
      if (!prev || t > prev.t) newest.set(src.title, { id: src.id, t });
    }
    const notes = indexNotes(root);
    const refreshed = [];
    const failed = [];
    let unchanged = 0;
    for (const [title, src] of newest) {
      const file = notes.get(title);
      if (!file) continue;
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
      if (mtime <= src.t) { unchanged += 1; continue; }
      if (refreshed.length >= MAX_REFRESH_PER_RUN) break;
      const content = this.sanitize(fs.readFileSync(file, 'utf8'));
      if (!content.trim()) continue;
      try {
        const created = await this._json(`${this.api}/api/sources/json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'text', notebooks: [nb.id], title, content, embed: false, async_processing: false }),
          timeoutMs: 60000,
        });
        if (!created?.id) throw new Error('нет id нового источника');
        // Unlink only: the old copy stays in OpenNotebook and can be linked back.
        await this._json(`${this.api}/api/notebooks/${encodeURIComponent(nb.id)}/sources/${encodeURIComponent(src.id)}`, { method: 'DELETE' });
        refreshed.push(title);
      } catch (err) {
        failed.push(`${title}: ${String(err?.message || err).slice(0, 120)}`);
      }
    }
    return { ok: failed.length === 0, notebook: nb.name, refreshed, unchanged, failed, error: failed[0] };
  }

  /** The sanitized digest for Gemini Notebook, plus a dated copy (the last 14 are kept). */
  buildDigest() {
    if (!this.connectors?.buildNotebookDigest) return { ok: false, error: 'Нет сборщика дайджеста.' };
    const digest = this.connectors.buildNotebookDigest();
    if (!digest?.ok || !this.archiveDir) return digest;
    try {
      fs.mkdirSync(this.archiveDir, { recursive: true });
      const d = new Date(this.now());
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
      fs.copyFileSync(digest.path, path.join(this.archiveDir, `digest-${stamp}.md`));
      // Our own archive copies: the digest itself stays, only the oldest dated copies beyond 14 go.
      const old = fs.readdirSync(this.archiveDir).filter((n) => /^digest-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(n)).sort().slice(0, -KEEP_ARCHIVE);
      for (const n of old) fs.rmSync(path.join(this.archiveDir, n), { force: true });
    } catch {}
    return digest;
  }

  async uploadDigest(digest) {
    const s = this.settings();
    if (!digest?.ok) return { ok: false, skipped: 'нет дайджеста' };
    if (!s.drive) return { ok: false, skipped: 'выгрузка на Диск выключена (/срез диск вкл)' };
    if (!this.drive) return { ok: false, error: 'Нет rclone.' };
    const st = await this.drive.status();
    if (!st.configured) return { ok: false, error: st.detail };
    try {
      return await this.drive.copyTo(digest.path, s.driveFile);
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  statusText() {
    const s = this.settings();
    const l = s.last;
    const lines = [
      `Срезы памяти: ${s.enabled ? `включены, ${s.times.join(' и ')}` : 'выключены'} · блокнот OpenNotebook «${s.notebookName}».`,
      `Выгрузка дайджеста на Google Диск: ${s.drive ? `включена → ${s.driveFile}` : 'выключена'}.`,
    ];
    if (l) {
      const d = new Date(l.at);
      const local = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      lines.push(`Последний срез: ${local} (${l.reason === 'schedule' ? 'по расписанию' : 'вручную'}) — `
        + `обновлено в OpenNotebook: ${l.refreshed}${l.openNotebookError ? ` (${l.openNotebookError})` : ''}; `
        + `дайджест: ${l.digestChars ? `${l.digestChars} знаков` : l.digestError}; Диск: ${l.drive || '—'}.`);
    } else lines.push('Срезов ещё не было.');
    return lines.join('\n');
  }
}

module.exports = { MemorySlices, dueSlot, indexNotes, parseOnDate, DEFAULT_TIMES, OPEN_NOTEBOOK_API };
