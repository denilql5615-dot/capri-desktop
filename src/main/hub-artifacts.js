'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov',
  '.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.wav', '.mp3']);
const validRun = (run) => typeof run === 'string' && /^[0-9a-f-]{36}$/i.test(run);
const validName = (name) => typeof name === 'string' && !/[\\/:]/.test(name) && ALLOWED.has(path.extname(name).toLowerCase());

async function artifactPath(root, run, name) {
  if (!validRun(run) || !validName(name)) throw new Error('Недопустимое вложение.');
  const realRoot = await fs.realpath(root);
  const dir = path.join(realRoot, run);
  const target = path.join(dir, name);
  const [actualDir, stat] = await Promise.all([fs.realpath(dir), fs.lstat(target)]);
  if (actualDir !== dir || !stat.isFile() || !stat.size) throw new Error('Вложение недоступно.');
  return target;
}

async function listArtifacts(root, run) {
  if (!validRun(run)) return [];
  const entries = await fs.readdir(path.join(root, run), { withFileTypes: true }).catch(() => []);
  const artifacts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !validName(entry.name)) continue;
    try {
      await artifactPath(root, run, entry.name);
      artifacts.push({ run, name: entry.name });
    } catch { /* Broken or redirected output. */ }
    if (artifacts.length >= 20) break;
  }
  return artifacts;
}

module.exports = { artifactPath, listArtifacts };
