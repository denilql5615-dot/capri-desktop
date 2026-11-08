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
  let actualDir, stat;
  try {
    [actualDir, stat] = await Promise.all([fs.realpath(dir), fs.lstat(target)]);
  } catch {
    throw new Error('Вложение недоступно.');
  }
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

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

async function saveUpload(root, sessionId, files) {
  const file = files?.[0];
  if (!validRun(sessionId) || !Array.isArray(files) || files.length !== 1 ||
      !validName(file?.name) || /[<>|"\x00-\x1f?*]/.test(file.name) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(file.name) ||
      typeof file.data !== 'string' || file.data.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4) {
    throw new Error('Недопустимое вложение.');
  }
  const bytes = Buffer.from(file.data, 'base64');
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES || bytes.toString('base64') !== file.data) {
    throw new Error('Недопустимое вложение.');
  }
  await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root);
  const uploads = path.join(realRoot, 'uploads');
  const dir = path.join(uploads, sessionId);
  for (const folder of [uploads, dir]) {
    await fs.mkdir(folder, { recursive: true });
    if (await fs.realpath(folder) !== folder) throw new Error('Папка вложений недоступна.');
  }
  const target = path.join(await fs.mkdtemp(path.join(dir, 'file-')), file.name);
  await fs.writeFile(target, bytes, { flag: 'wx' });
  return target;
}

module.exports = { artifactPath, listArtifacts, saveUpload, MAX_UPLOAD_BYTES };
