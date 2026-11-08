'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.mp4', '.webm', '.mov',
  '.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.wav', '.mp3']);
const TEXT_EXTS = new Set(['.txt', '.md', '.csv']);
const MARKITDOWN_EXTS = new Set(['.pdf', '.docx', '.xlsx', '.pptx']);
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

function findMarkItDown() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const exe = process.platform === 'win32' ? 'markitdown.exe' : 'markitdown';
  const candidates = [
    process.env.CAPRI_MARKITDOWN_PATH,
    path.join(appData, 'Python', 'Python313', 'Scripts', exe),
    path.join(localAppData, 'Programs', 'Python', 'Python313', 'Scripts', exe),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, exe)),
  ];
  return candidates.find((c) => c && fsSync.existsSync(c)) || null;
}

async function extractDocumentText(filePath, { maxChars = 12000, markitdownBin = findMarkItDown() } = {}) {
  if (typeof filePath !== 'string' || !filePath) return { text: '', extractedFile: null };
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTS.has(ext)) {
    try {
      const raw = (await fs.readFile(filePath, 'utf8')).trim();
      return { text: raw.slice(0, maxChars), extractedFile: null };
    } catch {
      return { text: '', extractedFile: null };
    }
  }
  if (!MARKITDOWN_EXTS.has(ext) || !markitdownBin) return { text: '', extractedFile: null };
  const stdout = await new Promise((resolve) => {
    execFile(markitdownBin, [filePath], {
      windowsHide: true,
      timeout: 25000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    }, (err, out) => {
      resolve(err ? '' : String(out || '').trim());
    });
  });
  if (!stdout) return { text: '', extractedFile: null };
  const extractedFile = `${filePath}.extracted.md`;
  try {
    await fs.writeFile(extractedFile, stdout, 'utf8');
  } catch {
    return { text: stdout.slice(0, maxChars), extractedFile: null };
  }
  return { text: stdout.slice(0, maxChars), extractedFile };
}

module.exports = { artifactPath, listArtifacts, saveUpload, extractDocumentText, findMarkItDown, MAX_UPLOAD_BYTES };
