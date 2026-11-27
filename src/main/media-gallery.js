'use strict';

// Her pictures for the phone's gallery (Danyal 2026-11-27): three sections that never mix — the ordinary chat
// gallery, private (media-private) and 18+ (media-18). Only pictures and short videos, newest first, by file name
// inside the section's own folder (no paths from the phone). Thumbnails are made by the caller (Electron).

const fs = require('fs');
const path = require('path');

const SCOPES = ['chat', 'private', 'nsfw'];
const MEDIA_RE = /^[\w.-]+\.(png|jpe?g|webp|gif|webm|mp4)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', webm: 'video/webm', mp4: 'video/mp4' };

class MediaGallery {
  /** dirOf(scope) → the folder of that section (or null). */
  constructor({ dirOf }) {
    this.dirOf = dirOf;
  }

  dir(scope) {
    return SCOPES.includes(scope) ? this.dirOf(scope) : null;
  }

  /** Pictures of a section, newest first: [{ name, at, size, video }], a page at a time. */
  list(scope, { offset = 0, limit = 60 } = {}) {
    const d = this.dir(scope);
    if (!d) return { scope, total: 0, items: [] };
    let names = [];
    try { names = fs.readdirSync(d).filter((n) => MEDIA_RE.test(n)); } catch { return { scope, total: 0, items: [] }; }
    const all = names.map((name) => {
      try {
        const st = fs.statSync(path.join(d, name));
        return st.isFile() ? { name, at: st.mtimeMs, size: st.size, video: /\.(webm|mp4)$/i.test(name) } : null;
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.at - a.at);
    const from = Math.max(0, Number(offset) || 0);
    const n = Math.min(200, Math.max(1, Number(limit) || 60));
    return { scope, total: all.length, items: all.slice(from, from + n) };
  }

  /** One file of a section: { path, mime } or null (a bad name, another folder, not there). */
  file(scope, name) {
    const d = this.dir(scope);
    const n = String(name || '');
    if (!d || !MEDIA_RE.test(n) || path.basename(n) !== n) return null;
    const p = path.join(d, n);
    try {
      if (!fs.statSync(p).isFile()) return null;
    } catch { return null; }
    return { path: p, mime: MIME[path.extname(n).slice(1).toLowerCase()] || 'application/octet-stream' };
  }
}

module.exports = { MediaGallery, SCOPES, MEDIA_RE };
