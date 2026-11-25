'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { artifactsDir } = require('./artifacts');

const TEXT_FORMATS = new Set(['md', 'txt', 'py', 'js', 'html', 'json', 'csv']);
const ALL_FORMATS = new Set([...TEXT_FORMATS, 'svg', 'png', 'docx', 'pdf', 'xlsx', 'pptx']);

const DEFAULT_INKSCAPE_BIN = 'C:\\Program Files\\Inkscape\\bin\\inkscape.exe';
const DEFAULT_SOFFICE_BIN = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe';
const EXEC_TIMEOUT_MS = 60000;

function defaultExecFile(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function findBinary(preferred, envVar, defaultPath, exeName) {
  const candidates = [
    preferred,
    envVar ? process.env[envVar] : '',
    defaultPath,
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, exeName)),
  ];
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

function slugify(title) {
  const raw = String(title || 'document').trim().toLowerCase();
  const ascii = raw
    .replace(/[^a-z0-9а-яё_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return ascii || 'document';
}

function timestampSlug() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

function hasUnsafeSvg(svgText) {
  if (typeof svgText !== 'string') return false;
  if (/<script\b/i.test(svgText)) return true;
  if (/\bon[a-z]+\s*=/i.test(svgText)) return true;
  return false;
}

function csvEscape(cell) {
  const s = cell == null ? '' : String(cell);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows) {
  return rows.map((row) => (Array.isArray(row) ? row : [row]).map(csvEscape).join(',')).join('\r\n');
}

async function createDocument(
  { format, title = 'document', content = '', rows = null, slides = null } = {},
  { pcToolsEngine = null, execFileImpl = defaultExecFile } = {},
) {
  const fmt = String(format || '').trim().toLowerCase().replace(/^\./, '');
  if (!ALL_FORMATS.has(fmt)) {
    return { ok: false, path: '', output: '', error: `Неподдерживаемый формат документа: ${format || '(пусто)'}` };
  }

  let dir;
  try {
    dir = artifactsDir();
  } catch (err) {
    return { ok: false, path: '', output: '', error: `Не удалось создать папку артефактов: ${err.message}` };
  }

  const baseName = `${slugify(title)}-${timestampSlug()}`;
  const outPath = path.join(dir, `${baseName}.${fmt}`);

  try {
    if (TEXT_FORMATS.has(fmt)) {
      let textContent;
      if (fmt === 'json') {
        textContent = typeof content === 'string' ? content : JSON.stringify(content ?? {}, null, 2);
      } else if (fmt === 'csv' && !content && Array.isArray(rows)) {
        textContent = rowsToCsv(rows);
      } else {
        textContent = String(content ?? '');
      }
      await fsp.writeFile(outPath, textContent, 'utf8');
      const stat = await fsp.stat(outPath);
      return { ok: true, path: outPath, output: `Создан ${path.basename(outPath)} (${stat.size} байт)`, error: '' };
    }

    if (fmt === 'svg') {
      const svgText = String(content ?? '');
      if (!svgText.trim()) {
        return { ok: false, path: '', output: '', error: 'Пустой SVG-контент.' };
      }
      if (hasUnsafeSvg(svgText)) {
        return { ok: false, path: '', output: '', error: 'SVG отклонен: содержит <script> или обработчики on*.' };
      }
      await fsp.writeFile(outPath, svgText, 'utf8');
      const stat = await fsp.stat(outPath);
      return { ok: true, path: outPath, output: `Создан ${path.basename(outPath)} (${stat.size} байт)`, error: '' };
    }

    if (fmt === 'png') {
      const svgText = String(content ?? '');
      if (!svgText.trim()) {
        return { ok: false, path: '', output: '', error: 'Для создания PNG нужен SVG-контент.' };
      }
      if (hasUnsafeSvg(svgText)) {
        return { ok: false, path: '', output: '', error: 'SVG отклонен: содержит <script> или обработчики on*.' };
      }
      const inkscapeBin = findBinary(
        pcToolsEngine?.paths?.inkscapeBin,
        'CAPRI_INKSCAPE_PATH',
        DEFAULT_INKSCAPE_BIN,
        process.platform === 'win32' ? 'inkscape.exe' : 'inkscape',
      );
      if (!inkscapeBin) {
        return { ok: false, path: '', output: '', error: 'Inkscape (inkscape.exe) не найден для конвертации SVG в PNG.' };
      }
      const tmpSvg = path.join(os.tmpdir(), `${baseName}.svg`);
      try {
        await fsp.writeFile(tmpSvg, svgText, 'utf8');
        await execFileImpl(inkscapeBin, [tmpSvg, '--export-type=png', `--export-filename=${outPath}`], {
          timeout: EXEC_TIMEOUT_MS,
          windowsHide: true,
        });
      } finally {
        await fsp.rm(tmpSvg, { force: true }).catch(() => {});
      }
      if (!fs.existsSync(outPath)) {
        return { ok: false, path: '', output: '', error: 'Inkscape не создал PNG-файл.' };
      }
      const stat = await fsp.stat(outPath);
      return { ok: true, path: outPath, output: `Создан ${path.basename(outPath)} (${stat.size} байт)`, error: '' };
    }

    if (fmt === 'docx' || fmt === 'pdf') {
      const rawText = String(content ?? '');
      const isHtml = /^\s*<(?:!doctype|html|body|div|h1|p|table)\b/i.test(rawText);
      const srcExt = isHtml ? '.html' : '.md';
      const tmpSrc = path.join(dir, `${baseName}${srcExt}`);
      try {
        await fsp.writeFile(tmpSrc, rawText, 'utf8');
        if (pcToolsEngine && typeof pcToolsEngine.convertDocument === 'function') {
          const res = await pcToolsEngine.convertDocument({
            inputPath: tmpSrc,
            targetFormat: fmt,
            outDir: dir,
          });
          if (!res?.ok) {
            return { ok: false, path: '', output: '', error: res?.error || `Ошибка конвертации в ${fmt}` };
          }
          const finalPath = res.outputPath || outPath;
          const bytes = res.bytes ?? (fs.existsSync(finalPath) ? fs.statSync(finalPath).size : 0);
          return { ok: true, path: finalPath, output: `Создан ${path.basename(finalPath)} (${bytes} байт)`, error: '' };
        }

        const sofficeBin = findBinary(
          pcToolsEngine?.paths?.sofficeBin,
          'CAPRI_SOFFICE_PATH',
          DEFAULT_SOFFICE_BIN,
          process.platform === 'win32' ? 'soffice.exe' : 'soffice',
        );
        if (!sofficeBin) {
          return { ok: false, path: '', output: '', error: 'LibreOffice (soffice.exe) не найден.' };
        }
        await execFileImpl(sofficeBin, ['--headless', '--convert-to', fmt, '--outdir', dir, tmpSrc], {
          timeout: EXEC_TIMEOUT_MS,
          windowsHide: true,
        });
        if (!fs.existsSync(outPath)) {
          return { ok: false, path: '', output: '', error: `LibreOffice не создал ${fmt}-файл.` };
        }
        const stat = await fsp.stat(outPath);
        return { ok: true, path: outPath, output: `Создан ${path.basename(outPath)} (${stat.size} байт)`, error: '' };
      } finally {
        await fsp.rm(tmpSrc, { force: true }).catch(() => {});
      }
    }

    if (fmt === 'xlsx' || fmt === 'pptx') {
      const scriptName = fmt === 'xlsx' ? 'capri-make-xlsx.py' : 'capri-make-pptx.py';
      const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', scriptName);
      if (!fs.existsSync(scriptPath)) {
        return { ok: false, path: '', output: '', error: `Скрипт ${scriptName} не найден.` };
      }
      const payload = fmt === 'xlsx'
        ? { title, rows: Array.isArray(rows) ? rows : [] }
        : { title, slides: Array.isArray(slides) ? slides : [] };
      const tmpJson = path.join(os.tmpdir(), `${baseName}.json`);
      try {
        await fsp.writeFile(tmpJson, JSON.stringify(payload), 'utf8');
        const pyBin = process.platform === 'win32' ? 'py' : 'python3';
        await execFileImpl(pyBin, [scriptPath, '--input', tmpJson, '--out', outPath], {
          timeout: 30000,
          windowsHide: true,
        });
      } finally {
        await fsp.rm(tmpJson, { force: true }).catch(() => {});
      }
      if (!fs.existsSync(outPath)) {
        return { ok: false, path: '', output: '', error: `Не удалось создать ${fmt}-файл.` };
      }
      const stat = await fsp.stat(outPath);
      return { ok: true, path: outPath, output: `Создан ${path.basename(outPath)} (${stat.size} байт)`, error: '' };
    }

    return { ok: false, path: '', output: '', error: `Формат ${fmt} не поддерживается.` };
  } catch (err) {
    return { ok: false, path: '', output: '', error: String(err?.message || `Ошибка создания документа (${fmt})`) };
  }
}

module.exports = { createDocument };
