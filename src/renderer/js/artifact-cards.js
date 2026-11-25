// Rich artifact cards and link chips for chat replies (images, video, audio, code, docs, links).
// Security: SVG/images only via <img>, all text/code via textContent, onion links never clickable.

import { iconSvg } from './step-icons.js';

const KIND_ICON = Object.freeze({
  image: 'image',
  video: 'video',
  audio: 'play',
  code: 'code',
  pdf: 'doc',
  doc: 'doc',
  slides: 'slides',
  sheet: 'sheet',
  file: 'attach',
  link: 'link',
});

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${Math.round(n)} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, '')} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} МБ`;
}

export function firstLines(text, maxLines = 30) {
  const lines = String(text || '').split(/\r?\n/);
  const truncated = lines.length > maxLines;
  return {
    preview: truncated ? `${lines.slice(0, maxLines).join('\n')}\n…` : lines.join('\n'),
    truncated,
    total: lines.length,
  };
}

export function guessKindFromName(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio';
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'kt', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'css', 'html', 'json', 'yaml', 'yml', 'md', 'sh', 'ps1', 'sql'].includes(ext)) return 'code';
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx', 'rtf', 'odt', 'txt'].includes(ext)) return 'doc';
  if (['ppt', 'pptx', 'odp', 'key'].includes(ext)) return 'slides';
  if (['xls', 'xlsx', 'csv', 'tsv', 'ods'].includes(ext)) return 'sheet';
  return 'file';
}

export function isSafeHttpUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
  } catch {
    return false;
  }
}

export function isOnionLink(link) {
  if (!link) return false;
  if (link.kind === 'onion') return true;
  if (/\.onion$/i.test(String(link.domain || ''))) return true;
  try {
    return /\.onion$/i.test(new URL(String(link.url || '')).hostname);
  } catch {
    return /\.onion\b/i.test(String(link.url || ''));
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function setIcon(node, key) {
  const svg = iconSvg(key);
  if (svg) node.innerHTML = svg;
}

async function resolveSrc(art, host) {
  if (art?.id && typeof host?.artifacts?.src === 'function') {
    const resolved = await host.artifacts.src(art.id);
    if (resolved) return resolved;
  }
  const url = String(art?.url || '');
  if (/^(?:capri:|file:|data:|blob:)/i.test(url)) return url;
  return '';
}

function openExternalUrl(url, host) {
  if (!isSafeHttpUrl(url)) return;
  if (typeof host?.chatsOpenLink === 'function') return host.chatsOpenLink(url);
  if (typeof host?.openSite === 'function') return host.openSite(url);
}

function copyText(text, btn, host) {
  const done = () => {
    const prev = btn.textContent;
    btn.textContent = 'Скопировано';
    setTimeout(() => { btn.textContent = prev; }, 1200);
  };
  if (typeof host?.chatsCopy === 'function') {
    host.chatsCopy(text);
    done();
    return;
  }
  globalThis.navigator?.clipboard?.writeText?.(text).then(done).catch(() => {});
}

function makeActionBtn(label, onClick) {
  const btn = el('button', 'artifact-card__btn', label);
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  return btn;
}

function renderArtifactCard(art, host) {
  const kind = art.kind || guessKindFromName(art.name);
  const card = el('div', `artifact-card is-${kind}`);
  const name = art.name || art.id || 'Файл';
  const size = formatBytes(art.size);

  if (kind === 'image') {
    const img = el('img', 'artifact-card__img');
    img.alt = name;
    img.loading = 'lazy';
    if (art.id && host?.artifacts?.open) {
      img.title = 'Открыть';
      img.style && (img.style.cursor = 'pointer');
      img.addEventListener('click', () => host.artifacts.open(art.id));
    }
    card.append(img);
    resolveSrc(art, host).then((src) => { if (src) img.src = src; }).catch(() => {});
    return card;
  }

  if (kind === 'video') {
    const video = el('video', 'artifact-card__video');
    video.controls = true;
    video.preload = 'metadata';
    video.playsInline = true;
    card.append(video);
    resolveSrc(art, host).then((src) => { if (src) video.src = src; }).catch(() => {});
    return card;
  }

  if (kind === 'audio') {
    const head = el('div', 'artifact-card__head');
    const icon = el('span', 'artifact-card__icon');
    setIcon(icon, KIND_ICON.audio);
    head.append(icon, el('span', 'artifact-card__name', name));
    if (size) head.append(el('span', 'artifact-card__size', size));
    const audio = el('audio', 'artifact-card__audio');
    audio.controls = true;
    audio.preload = 'metadata';
    card.append(head, audio);
    resolveSrc(art, host).then((src) => { if (src) audio.src = src; }).catch(() => {});
    return card;
  }

  const head = el('div', 'artifact-card__head');
  const icon = el('span', 'artifact-card__icon');
  setIcon(icon, KIND_ICON[kind] || 'attach');
  head.append(icon, el('span', 'artifact-card__name', name));
  if (size) head.append(el('span', 'artifact-card__size', size));

  const actions = el('div', 'artifact-card__actions');

  if (kind === 'code') {
    const pre = el('pre', 'artifact-card__code');
    pre.textContent = 'Загрузка…';
    let fullText = '';
    const copyBtn = makeActionBtn('Копировать', () => copyText(fullText || pre.textContent, copyBtn, host));
    actions.append(copyBtn);
    if (art.id && host?.artifacts?.open) {
      actions.append(makeActionBtn('Открыть', () => host.artifacts.open(art.id)));
    }
    if (art.id && host?.artifacts?.reveal) {
      actions.append(makeActionBtn('Показать в папке', () => host.artifacts.reveal(art.id)));
    }
    card.append(head, pre, actions);
    resolveSrc(art, host).then(async (src) => {
      if (!src || typeof globalThis.fetch !== 'function') { pre.textContent = ''; return; }
      const res = await globalThis.fetch(src);
      if (!res.ok) { pre.textContent = ''; return; }
      fullText = await res.text();
      pre.textContent = firstLines(fullText, 30).preview;
    }).catch(() => { pre.textContent = ''; });
    return card;
  }

  if (art.id && host?.artifacts?.open) {
    actions.append(makeActionBtn('Открыть', () => host.artifacts.open(art.id)));
  }
  if (art.id && host?.artifacts?.reveal) {
    actions.append(makeActionBtn('Показать в папке', () => host.artifacts.reveal(art.id)));
  }
  if (isSafeHttpUrl(art.editUrl)) {
    actions.append(makeActionBtn('Редактор', () => openExternalUrl(art.editUrl, host)));
  }
  card.append(head);
  if (actions.children.length) card.append(actions);
  return card;
}

function renderLinkChip(link, host) {
  const onion = isOnionLink(link);
  const clickable = !onion && (isSafeHttpUrl(link.url) || (link.kind === 'local' && link.id && host?.artifacts?.open));
  const chip = el(clickable ? 'button' : 'span', `artifact-link${onion ? ' is-onion' : ''}`);
  if (clickable) {
    chip.type = 'button';
    chip.addEventListener('click', () => {
      if (link.kind === 'local' && link.id && host?.artifacts?.open) host.artifacts.open(link.id);
      else openExternalUrl(link.url, host);
    });
  }
  if (link.url) chip.title = onion ? `${link.url} (Tor/onion — не открывается напрямую)` : link.url;
  const icon = el('span', 'artifact-link__icon');
  setIcon(icon, 'link');
  chip.append(icon);
  if (link.domain) chip.append(el('span', 'artifact-link__domain', link.domain));
  if (link.label && link.label !== link.domain) chip.append(el('span', 'artifact-link__label', link.label));
  return chip;
}

export function renderArtifacts(container, artifacts = [], links = [], opts = {}) {
  if (!container) return null;
  const items = Array.isArray(artifacts) ? artifacts.filter(Boolean) : [];
  const refs = Array.isArray(links) ? links.filter(Boolean) : [];
  const host = opts.host || globalThis.window?.host || null;

  if (!items.length && !refs.length) return null;

  const wrap = el('div', 'artifact-cards');
  if (items.length) {
    const grid = el('div', 'artifact-cards__items');
    for (const art of items) grid.append(renderArtifactCard(art, host));
    wrap.append(grid);
  }
  if (refs.length) {
    const row = el('div', 'artifact-cards__links');
    for (const link of refs) row.append(renderLinkChip(link, host));
    wrap.append(row);
  }
  container.append(wrap);
  return wrap;
}
