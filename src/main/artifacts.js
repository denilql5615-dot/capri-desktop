'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ARTIFACTS_DIR = 'D:\\Capri\\artifacts';
const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

const registry = new Map();

function artifactsDir() {
  const dir = process.env.CAPRI_ARTIFACTS_DIR
    ? path.resolve(process.env.CAPRI_ARTIFACTS_DIR)
    : DEFAULT_ARTIFACTS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mimeFor(name) {
  const ext = path.extname(name || '').toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    case '.ogg': return 'audio/ogg';
    case '.pdf': return 'application/pdf';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.csv': return 'text/csv; charset=utf-8';
    case '.txt':
    case '.md':
    case '.py':
    case '.js':
    case '.ts':
    case '.kt':
    case '.ps1':
    case '.json':
    case '.html':
    case '.css':
    case '.yml':
    case '.yaml':
    case '.xml':
    case '.sh':
    case '.bat':
    case '.sql':
    case '.log':
      return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function kindOf(name) {
  const ext = path.extname(name || '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(ext)) return 'video';
  if (['.wav', '.mp3', '.ogg', '.flac', '.m4a'].includes(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  if (['.pptx', '.ppt', '.odp'].includes(ext)) return 'slides';
  if (['.xlsx', '.xls', '.csv', '.tsv', '.ods'].includes(ext)) return 'sheet';
  if (['.docx', '.doc', '.rtf', '.odt', '.md', '.txt'].includes(ext)) return 'doc';
  if (['.py', '.js', '.ts', '.kt', '.ps1', '.json', '.html', '.css', '.yml', '.yaml', '.xml', '.sh', '.bat', '.sql'].includes(ext)) return 'code';
  return 'file';
}

function pruneExpired(now = Date.now()) {
  for (const [id, entry] of registry) {
    if (now - entry.createdAt > ARTIFACT_TTL_MS) {
      registry.delete(id);
    }
  }
}

function publicArtifact(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {
    id: a.id,
    kind: a.kind,
    name: a.name,
    mime: a.mime,
    size: a.size,
    url: a.url,
  };
  if (a.target) out.target = a.target;
  if (a.domain) out.domain = a.domain;
  if (a.editUrl) out.editUrl = a.editUrl;
  return out;
}

function registerArtifact(absPath, meta = {}) {
  if (typeof absPath !== 'string' || !absPath.trim()) return null;
  const resolved = path.resolve(absPath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) return null;

  pruneExpired();
  const id = crypto.randomUUID();
  const name = (typeof meta.name === 'string' && meta.name.trim()) ? path.basename(meta.name.trim()) : path.basename(resolved);
  const entry = {
    id,
    path: resolved,
    kind: meta.kind || kindOf(name),
    name,
    mime: meta.mime || mimeFor(name),
    size: stat.size,
    url: `/files/${id}`,
    ...(meta.target ? { target: String(meta.target) } : {}),
    ...(meta.domain ? { domain: String(meta.domain) } : {}),
    ...(meta.editUrl ? { editUrl: String(meta.editUrl) } : {}),
    createdAt: Date.now(),
  };
  registry.set(id, entry);
  return publicArtifact(entry);
}

function getArtifact(id) {
  if (typeof id !== 'string' || !id.trim()) return null;
  pruneExpired();
  const entry = registry.get(id.trim());
  if (!entry) return null;
  try {
    const stat = fs.statSync(entry.path);
    if (!stat.isFile()) {
      registry.delete(entry.id);
      return null;
    }
  } catch {
    registry.delete(entry.id);
    return null;
  }
  return { ...entry };
}

function knownServiceLabel(parsedUrl) {
  const host = parsedUrl.hostname.toLowerCase();
  const port = parsedUrl.port;
  const hostPort = port ? `${host}:${port}` : host;

  if (port === '5100') return 'Presenton';
  if (port === '9001') return 'Penpot';
  if (hostPort === '192.168.0.107:8082') return 'FreshRSS';
  if (port === '8085') return 'Wger';
  if (port === '8400') return 'Stirling-PDF';
  if (port === '8188') return 'ComfyUI';
  if (port === '8502') return 'OpenNotebook';
  if (port === '8090') return 'Kiwix';
  if (host === 'github.com' || host.endsWith('.github.com')) return 'GitHub';
  return null;
}

function linkKindOf(hostname) {
  const h = hostname.toLowerCase();
  if (h === '127.0.0.1' || h === 'localhost' || h.startsWith('192.168.')) return 'local';
  if (h.endsWith('.onion')) return 'onion';
  return 'web';
}

function stripTrailingPunctuation(rawUrl) {
  let u = rawUrl;
  while (u.length > 0) {
    const last = u[u.length - 1];
    if (last === '.' || last === ',' || last === ';' || last === ':' || last === '!' || last === '?' || last === ']' || last === '}') {
      u = u.slice(0, -1);
    } else if (last === ')') {
      const openCount = (u.match(/\(/g) || []).length;
      const closeCount = (u.match(/\)/g) || []).length;
      if (closeCount > openCount) {
        u = u.slice(0, -1);
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return u;
}

function extractLinks(text) {
  if (typeof text !== 'string' || !text) return [];
  const seen = new Set();
  const results = [];

  const addUrl = (rawUrl, explicitLabel = '') => {
    const cleaned = stripTrailingPunctuation(String(rawUrl || '').trim());
    if (!cleaned) return;
    let parsed;
    try {
      parsed = new URL(cleaned);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    const href = parsed.href;
    if (seen.has(href)) return;
    seen.add(href);

    const domain = parsed.host;
    const serviceLabel = knownServiceLabel(parsed);
    const trimmedLabel = String(explicitLabel || '').trim();
    const label = (trimmedLabel && trimmedLabel !== cleaned && trimmedLabel !== href)
      ? trimmedLabel
      : (serviceLabel || domain);
    const kind = linkKindOf(parsed.hostname);
    results.push({ url: href, domain, label, kind });
  };

  // First pass: markdown links [label](url)
  const mdRe = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/gi;
  const masked = text.replace(mdRe, (_m, label, url) => {
    addUrl(url, label);
    return ' ';
  });

  // Second pass: bare http(s) URLs
  const bareRe = /https?:\/\/[^\s<>"'`]+/gi;
  let match;
  while ((match = bareRe.exec(masked)) !== null) {
    addUrl(match[0]);
  }

  return results;
}

module.exports = {
  registerArtifact,
  getArtifact,
  publicArtifact,
  kindOf,
  mimeFor,
  extractLinks,
  artifactsDir,
};
