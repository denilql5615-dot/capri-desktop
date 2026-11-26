'use strict';

// His LoRAs as Obsidian notes he edits by hand (Danyal 2026-11-26): one note per LoRA in GENESIS/ComfyUI/LoRA,
// with what she always adds or forbids, the costume part by part, and LOOKS — a cosplayer's characters, each with
// its tags and reference photos. A new look needs no retraining: the LoRA knows the face, a look is tags + photos.
// The note wins over meta.json. Photos of a real person stay on D: (D:\Capri\lora\<slug>\looks\<look>), not in the
// synced vault.
//
//   # Лиана (lyana)
//   - Синонимы: лиана, lyana
//   - Рисовальщик: фото
//   - Всегда: adult woman
//   - Запрещено: nsfw
//   - Костюм: gemini_outfit            (a tag the LoRA learnt for her costume, optional)
//
//   ## Части костюма                    (optional: kept by code on a redraw)
//   - jacket: white cropped puffer jacket
//
//   ## Кафка
//   - Синонимы: kafka, кафка
//   - Теги: long dark red wig, white shirt, brown vest
//   - Фото: kafka1.jpg, kafka2.jpg

const fs = require('fs');
const path = require('path');

const DIR = path.join('GENESIS', 'ComfyUI', 'LoRA');
const DRAWER_BY_WORD = { 'арт': 'art', art: 'art', 'фото': 'photo', photo: 'photo', 'портрет': 'portrait', portrait: 'portrait' };
const list = (s) => String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
const SPECIAL = /^части костюма$/i;

function parse(md) {
  const out = { title: null, slug: null, aliases: [], drawer: null, always: '', negative: '', outfit: null, parts: null, looks: [] };
  let section = null;
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^#\s+(.+?)\s*\(([a-z0-9_]+)\)\s*$/i))) { out.title = m[1].trim(); out.slug = m[2].toLowerCase(); section = null; continue; }
    if ((m = line.match(/^##\s+(.+?)\s*$/))) {
      const name = m[1].trim();
      if (SPECIAL.test(name)) { section = { kind: 'parts' }; out.parts = out.parts || {}; } else { section = { kind: 'look', look: { name, aliases: [], tags: '', photos: [] } }; out.looks.push(section.look); }
      continue;
    }
    if (!(m = line.match(/^[-*]\s*([^:]+):\s*(.*)$/))) continue;
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (!section) {
      if (key === 'синонимы') out.aliases = list(value).map((x) => x.toLowerCase());
      else if (key === 'рисовальщик') out.drawer = DRAWER_BY_WORD[value.toLowerCase().split(/[\s(]/)[0]] || null;
      else if (key === 'всегда') out.always = value;
      else if (key === 'запрещено') out.negative = value;
      else if (key === 'костюм') out.outfit = value.toLowerCase() || null;
    } else if (section.kind === 'parts') {
      out.parts[key] = value;
    } else {
      const look = section.look;
      if (key === 'синонимы') look.aliases = list(value).map((x) => x.toLowerCase());
      else if (key === 'теги') look.tags = value;
      else if (key === 'фото') look.photos = list(value);
    }
  }
  return out;
}

function render(lib) {
  const lines = [`# ${lib.title || lib.slug} (${lib.slug})`, ''];
  lines.push('Альтаир читает эту заметку перед каждой картинкой с этой LoRA. Правь как хочешь: строки «- Ключ: значение», образы — разделы «##».', '');
  lines.push(`- Синонимы: ${(lib.aliases || []).join(', ')}`);
  if (lib.drawer) lines.push(`- Рисовальщик: ${{ art: 'арт', photo: 'фото', portrait: 'портрет' }[lib.drawer]}`);
  lines.push(`- Всегда: ${lib.always || ''}`);
  lines.push(`- Запрещено: ${lib.negative || ''}`);
  if (lib.outfit) lines.push(`- Костюм: ${lib.outfit}`);
  if (lib.parts && Object.keys(lib.parts).length) {
    lines.push('', '## Части костюма', ...Object.entries(lib.parts).map(([k, v]) => `- ${k}: ${v}`));
  }
  for (const look of lib.looks || []) {
    lines.push('', `## ${look.name}`, `- Синонимы: ${(look.aliases || []).join(', ')}`, `- Теги: ${look.tags || ''}`);
    if (look.photos?.length) lines.push(`- Фото: ${look.photos.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

class LoraLibrary {
  constructor({ vaultDir, loraRoot = 'D:\\Capri\\lora' } = {}) {
    this.vaultDir = vaultDir;
    this.loraRoot = loraRoot;
  }

  dir() { return this.vaultDir ? path.join(this.vaultDir, DIR) : null; }

  /** slug → parsed note (with its file), from every note in the folder. */
  all() {
    const out = {};
    const d = this.dir();
    if (!d) return out;
    let files = [];
    try { files = fs.readdirSync(d).filter((f) => f.endsWith('.md')); } catch { return out; }
    for (const f of files) {
      try {
        const lib = parse(fs.readFileSync(path.join(d, f), 'utf8'));
        if (lib.slug) out[lib.slug] = { ...lib, file: path.join(d, f) };
      } catch {}
    }
    return out;
  }

  get(slug) { return this.all()[String(slug || '').toLowerCase()] || null; }

  /** The note of a LoRA, written (a new one, or a whole rewrite after adding a look). */
  save(lib) {
    const d = this.dir();
    if (!d) throw new Error('Хранилище Obsidian недоступно.');
    fs.mkdirSync(d, { recursive: true });
    const file = lib.file || path.join(d, `${String(lib.title || lib.slug).replace(/[<>:"/\\|?*]/g, '_')}.md`);
    fs.writeFileSync(file, render(lib));
    return file;
  }

  /** A look's photo folder on D: (never the vault). */
  lookDir(slug, look) {
    return path.join(this.loraRoot, String(slug), 'looks', String(look).replace(/[<>:"/\\|?*\s]+/g, '_'));
  }

  /** The look he named in his words or the prompt (its name or a synonym), or null. */
  findLook(lib, text) {
    const t = ` ${String(text || '').toLowerCase()} `;
    for (const look of lib?.looks || []) {
      for (const a of [look.name.toLowerCase(), ...(look.aliases || [])]) {
        const stem = a.length >= 4 && /[а-яё]$/i.test(a) ? a.slice(0, -1) : a; // Russian cases: "кафка" / "кафки" / "кафку"
        if (stem && t.includes(stem)) return look;
      }
    }
    return null;
  }

  /** The photos of a look as Buffers (up to 3), from D:. */
  lookPhotos(slug, look) {
    const d = this.lookDir(slug, look.name);
    return (look.photos || []).slice(0, 3).map((f) => { try { return fs.readFileSync(path.join(d, path.basename(f))); } catch { return null; } }).filter(Boolean);
  }

  /** A new look (or new photos and tags for one): photos saved on D:, the section written into the note. */
  addLook(slug, { name, tags = '', aliases = [], photos = [] } = {}) {
    const lib = this.get(slug);
    if (!lib) throw new Error(`Нет заметки для LoRA ${slug} в ${DIR}.`);
    const lookName = String(name || '').trim();
    if (!lookName) throw new Error('Нужно название образа.');
    let look = lib.looks.find((l) => l.name.toLowerCase() === lookName.toLowerCase());
    if (!look) { look = { name: lookName, aliases: [], tags: '', photos: [] }; lib.looks.push(look); }
    if (tags) look.tags = String(tags).trim();
    look.aliases = [...new Set([...look.aliases, ...aliases.map((a) => String(a).toLowerCase().trim()).filter(Boolean)])];
    if (photos.length) {
      const d = this.lookDir(slug, look.name);
      fs.mkdirSync(d, { recursive: true });
      photos.forEach((buf, i) => {
        const fname = `${String(look.name).replace(/[^\p{L}\p{N}]+/gu, '_').toLowerCase()}_${Date.now()}_${i + 1}.jpg`;
        fs.writeFileSync(path.join(d, fname), buf);
        look.photos.push(fname);
      });
    }
    this.save(lib);
    return look;
  }
}

module.exports = { LoraLibrary, parse, render, DIR };
