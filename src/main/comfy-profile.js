'use strict';

// Danyal's image preferences for ComfyUI (2026-11-25): a note Altair reads before every picture and refines
// from his answers ("всегда добавляй…", "убери…", "по умолчанию вертикально"), like a person learning his taste.
// Three separate profiles, never mixed: ordinary chat (GENESIS), 18+ and private (their own branches).
// The note is plain Markdown: the settings block on top is machine-read, the notes below are history.

const fs = require('fs');
const path = require('path');

const FILES = {
  chat: path.join('GENESIS', 'ComfyUI', 'Профиль генерации.md'),
  nsfw: path.join('20_Крона', 'Ветки', 'nsfw', 'ComfyUI профиль 18+.md'),
  private: path.join('20_Крона', 'Ветки', 'private', 'ComfyUI профиль.md'),
};

const DEFAULT = Object.freeze({
  positive: [],
  negative: [],
  width: 832,
  height: 1216,
  steps: 30,
  cfg: 6.5,
  drawer: 'art',
  notes: [],
});
const DRAWER_NAMES = { art: 'арт', photo: 'фото', portrait: 'портрет' };
const DRAWER_BY_WORD = { 'арт': 'art', art: 'art', 'фото': 'photo', photo: 'photo', 'портрет': 'portrait', portrait: 'portrait' };

const LIMITS = { width: [512, 1536], height: [512, 1536], steps: [8, 60], cfg: [1, 15] };
const KEYS = { 'позитив': 'positive', 'негатив': 'negative', 'ширина': 'width', 'высота': 'height', 'шаги': 'steps', 'cfg': 'cfg', 'рисовальщик': 'drawer' };

function scopeOf(mode) {
  const m = String(mode || '').toLowerCase();
  return m === 'nsfw' || m === 'private' ? m : 'chat';
}

function fileOf(vaultDir, scope) {
  return path.join(vaultDir, FILES[scopeOf(scope)]);
}

const tags = (s) => String(s || '').split(/[,\n]/).map((t) => t.trim()).filter(Boolean);
const clamp = (key, v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const [lo, hi] = LIMITS[key];
  const c = Math.min(hi, Math.max(lo, n));
  return key === 'width' || key === 'height' ? Math.round(c / 64) * 64 : (key === 'steps' ? Math.round(c) : Math.round(c * 10) / 10);
};

function parse(md) {
  const out = { ...DEFAULT, positive: [], negative: [], notes: [] };
  for (const line of String(md || '').split(/\r?\n/)) {
    const m = line.match(/^-\s*\*\*([^*]+)\*\*:\s*(.*)$/);
    if (m) {
      const key = KEYS[m[1].trim().toLowerCase()];
      if (!key) continue;
      if (key === 'positive' || key === 'negative') out[key] = tags(m[2]);
      else if (key === 'drawer') out.drawer = DRAWER_BY_WORD[m[2].trim().toLowerCase().split(/[\s(]/)[0]] || 'art';
      else {
        const v = clamp(key, m[2]);
        if (v !== undefined) out[key] = v;
      }
      continue;
    }
    const n = line.match(/^-\s+(\d{4}-\d{2}-\d{2}.*)$/);
    if (n) out.notes.push(n[1].trim());
  }
  return out;
}

function render(p, scope) {
  const title = { chat: 'общий', nsfw: '18+', private: 'Приват' }[scopeOf(scope)];
  return [
    `# Профиль генерации ComfyUI (${title})`,
    '',
    'Альтаир читает этот профиль перед каждой картинкой и дописывает его по твоим ответам. Править можно и руками.',
    '',
    '## Настройки',
    `- **Позитив**: ${p.positive.join(', ')}`,
    `- **Негатив**: ${p.negative.join(', ')}`,
    `- **Ширина**: ${p.width}`,
    `- **Высота**: ${p.height}`,
    `- **Шаги**: ${p.steps}`,
    `- **CFG**: ${p.cfg}`,
    `- **Рисовальщик**: ${DRAWER_NAMES[p.drawer] || 'арт'} (арт / фото / портрет — по умолчанию, если из запроса не ясно)`,
    '',
    '## Что выяснили о твоём вкусе',
    ...(p.notes.length ? p.notes.slice(-40).map((n) => `- ${n}`) : ['- (пока ничего)']),
    '',
  ].join('\n');
}

function read(vaultDir, scope, io = fs) {
  if (!vaultDir) return { ...DEFAULT, positive: [], negative: [], notes: [] };
  try {
    return parse(io.readFileSync(fileOf(vaultDir, scope), 'utf8'));
  } catch {
    return { ...DEFAULT, positive: [], negative: [], notes: [] };
  }
}

/**
 * patch: { positive_add, positive_remove, negative_add, negative_remove, width, height, steps, cfg, note }
 * Lists are comma-separated tags. Returns the new profile.
 */
function update(vaultDir, scope, patch = {}, { io = fs, now = new Date() } = {}) {
  if (!vaultDir) throw new Error('Хранилище Obsidian недоступно: профиль не сохранить.');
  const p = read(vaultDir, scope, io);
  const lower = (arr) => new Set(arr.map((t) => t.toLowerCase()));
  for (const key of ['positive', 'negative']) {
    const drop = lower(tags(patch[`${key}_remove`]));
    p[key] = p[key].filter((t) => !drop.has(t.toLowerCase()));
    const have = lower(p[key]);
    for (const t of tags(patch[`${key}_add`])) if (!have.has(t.toLowerCase())) { p[key].push(t); have.add(t.toLowerCase()); }
  }
  for (const key of ['width', 'height', 'steps', 'cfg']) {
    if (patch[key] !== undefined && patch[key] !== null && patch[key] !== '') {
      const v = clamp(key, patch[key]);
      if (v !== undefined) p[key] = v;
    }
  }
  if (patch.drawer && DRAWER_BY_WORD[String(patch.drawer).toLowerCase()]) p.drawer = DRAWER_BY_WORD[String(patch.drawer).toLowerCase()];
  if (patch.note) p.notes.push(`${now.toISOString().slice(0, 10)} — ${String(patch.note).replace(/\s+/g, ' ').trim().slice(0, 300)}`);
  const file = fileOf(vaultDir, scope);
  io.mkdirSync(path.dirname(file), { recursive: true });
  io.writeFileSync(file, render(p, scope));
  return p;
}

/** The text the model sees: the profile, short. */
function describe(p) {
  return [
    `Позитив (добавляется всегда): ${p.positive.join(', ') || '—'}`,
    `Негатив: ${p.negative.join(', ') || '—'}`,
    `Размер: ${p.width}×${p.height}, шаги ${p.steps}, CFG ${p.cfg}; рисовальщик по умолчанию: ${DRAWER_NAMES[p.drawer] || 'арт'}`,
    p.notes.length ? `О вкусе: ${p.notes.slice(-8).join(' | ')}` : 'О вкусе пока ничего не записано.',
  ].join('\n');
}

module.exports = { FILES, DEFAULT, scopeOf, fileOf, parse, render, read, update, describe, clamp };
