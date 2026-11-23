'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const CACHE_TTL_MS = 20 * 1000;
const PROBE_TIMEOUT_MS = 3500;
const EXEC_TIMEOUT_MS = 60 * 1000;
const MEDIA_TIMEOUT_MS = 180 * 1000;
const HTTP_TIMEOUT_MS = 2500;
const TCP_TIMEOUT_MS = 1200;

const SHELL_META_RE = /[|;&`$<>\r\n\0]/;
const SAFE_MODEL_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SAFE_EXT_RE = /^[a-z0-9]{1,10}$/i;

const DEFAULT_PATHS = Object.freeze({
  pythonBin: 'py',
  ytDlpBin: 'yt-dlp',
  ffmpegBin: 'ffmpeg',
  markitdownBin: 'markitdown',
  sofficeBin: 'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  inkscapeBin: 'C:\\Program Files\\Inkscape\\bin\\inkscape.exe',
  kensakuCli: 'D:\\Capri\\tools\\kensaku\\app\\kensaku-cli.exe',
  kensakuGui: 'D:\\Capri\\tools\\kensaku\\app\\kensaku.exe',
  upscaylBin: 'C:\\Program Files\\Upscayl\\resources\\bin\\upscayl-bin.exe',
  upscaylModelsDir: 'C:\\Program Files\\Upscayl\\resources\\models',
  blenderBin: 'D:\\Capri\\tools\\blender-5.2.3-windows-x64\\blender.exe',
  blenderMcpScript: 'D:\\Capri\\tools\\start_blender_mcp.py',
  agentDesktopBin: path.resolve(__dirname, '..', '..', 'vendor', 'agent-desktop', 'agent-desktop.exe'),
  analyzeScript: path.resolve(__dirname, '..', '..', 'scripts', 'capri-data-analyze.py'),
  convertScript: path.resolve(__dirname, '..', '..', 'scripts', 'capri-convert-doc.py'),
});

const PC_TOOLS_CATALOG = Object.freeze([
  {
    id: 'tool-data',
    name: 'Data-анализатор',
    command: '/analyze',
    url: '',
    actions: ['probe'],
    offlineSafe: true,
    privacySafe: true,
    description: 'Локальный анализ CSV, TSV, XLSX и JSON + графики matplotlib',
  },
  {
    id: 'tool-media',
    name: 'Медиа-конспект',
    command: '/transcribe',
    url: '',
    actions: ['probe'],
    offlineSafe: false,
    privacySafe: false,
    description: 'Локальная транскрибация файлов (ffmpeg + Whisper) и загрузка URL (yt-dlp)',
  },
  {
    id: 'tool-docs',
    name: 'Конвейер документов',
    command: '/convert',
    url: '',
    actions: ['probe'],
    offlineSafe: true,
    privacySafe: true,
    description: 'Конвертация MD → DOCX, Office → PDF (LibreOffice), SVG → PNG (Inkscape)',
  },
  {
    id: 'tool-kensaku',
    name: 'Kensaku Поиск по ПК',
    command: '',
    url: '',
    actions: ['probe', 'launch'],
    offlineSafe: true,
    privacySafe: true,
    description: 'Быстрый полнотекстовый и OCR-поиск по документам ПК',
  },
  {
    id: 'tool-upscayl',
    name: 'Upscayl 4x Апскейл',
    command: '/upscale',
    url: '',
    actions: ['probe'],
    offlineSafe: true,
    privacySafe: true,
    description: 'Увеличение чёткости изображений 4x на локальном GPU (Vulkan)',
  },
  {
    id: 'tool-penpot-mcp',
    name: 'Penpot MCP',
    command: '',
    url: 'http://localhost:9001',
    actions: ['probe', 'open'],
    offlineSafe: true,
    privacySafe: true,
    description: 'Локальный дизайн-редактор Penpot и MCP-мост (:4401)',
  },
  {
    id: 'tool-blender-mcp',
    name: 'Blender 5.2.3 + MCP',
    command: '',
    url: '',
    actions: ['probe', 'start', 'stop'],
    offlineSafe: true,
    privacySafe: true,
    description: '3D-сцена Blender с запущенным MCP-сервером (:9876)',
  },
  {
    id: 'tool-comfy',
    name: 'ComfyUI Desktop',
    command: '',
    url: 'http://127.0.0.1:8000',
    actions: ['probe', 'open'],
    offlineSafe: true,
    privacySafe: true,
    description: 'Генерация изображений и апскейл (:8000, делит VRAM с Ollama)',
  },
  {
    id: 'tool-agent-desktop',
    name: 'Управление окнами (agent-desktop)',
    command: '',
    url: '',
    actions: ['probe'],
    offlineSafe: true,
    privacySafe: true,
    description: 'UI-автоматизация и инспекция окон Windows для Капри',
  },
  {
    id: 'tool-whisper',
    name: 'Whisper STT',
    command: '',
    url: '',
    actions: ['probe'],
    offlineSafe: true,
    privacySafe: true,
    description: 'Локальное распознавание речи (127.0.0.1:8765)',
  },
  {
    id: 'tool-proton-sync',
    name: 'Proton Bridge + Syncthing',
    command: '',
    url: 'http://127.0.0.1:8384',
    actions: ['probe', 'open'],
    offlineSafe: false,
    privacySafe: false,
    description: 'Локальный почтовый шлюз Proton (:1143) и синхронизация (:8384)',
  },
]);

const LENOVO_BRIDGES_CATALOG = Object.freeze([
  {
    id: 'bridge-freshrss',
    name: 'FreshRSS Новости',
    url: 'http://192.168.0.107:8082',
    actions: ['probe', 'open'],
    description: 'Серверный агрегатор RSS-подписок на Lenovo .107',
  },
  {
    id: 'bridge-fmd',
    name: 'Find My Device',
    url: 'http://192.168.0.107:8083',
    actions: ['probe', 'open'],
    description: 'Поиск и геолокация Android-устройств на Lenovo .107',
  },
  {
    id: 'bridge-homebox',
    name: 'Homebox Инвентарь',
    url: 'http://192.168.0.107:8470',
    actions: ['probe', 'open'],
    description: 'Учёт вещей, техники и чеков на Lenovo .107',
  },
  {
    id: 'bridge-calibre',
    name: 'Calibre-Web Книги',
    url: 'http://192.168.0.107:8420',
    actions: ['probe', 'open'],
    description: 'Домашняя библиотека электронных книг на Lenovo .107',
  },
]);

const PC_TOOL_MAP = new Map(PC_TOOLS_CATALOG.map((t) => [t.id, t]));
const BRIDGE_MAP = new Map(LENOVO_BRIDGES_CATALOG.map((b) => [b.id, b]));
const ALLOWED_ACTIONS = new Set([
  'probe',
  'launch',
  'start',
  'stop',
  'analyze',
  'convert',
  'transcribe',
  'upscale',
  'search',
]);

function validateHttpUrl(raw) {
  const s = String(raw || '').trim();
  if (!s || SHELL_META_RE.test(s)) {
    throw new Error('Некорректный URL: содержит запрещённые символы или пуст.');
  }
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`Некорректный URL: ${s}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Разрешены только http:// и https:// URL (получено ${parsed.protocol}).`);
  }
  return parsed.toString();
}

function validateLocalPath(raw, { mustExist = false } = {}) {
  const s = String(raw || '').trim();
  if (!s || SHELL_META_RE.test(s)) {
    throw new Error('Некорректный путь к файлу.');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^file:/i.test(s)) {
    throw new Error('Сетевые и file:// URI не допускаются вместо локального пути.');
  }
  if (s.startsWith('-')) {
    throw new Error('Путь не может начинаться с дефиса.');
  }
  const resolved = path.resolve(s);
  if (mustExist && !fs.existsSync(resolved)) {
    throw new Error(`Файл не найден: ${resolved}`);
  }
  return resolved;
}

function validateCleanText(raw, maxLen = 400) {
  const s = String(raw || '').replace(/[\0\r\n]/g, ' ').trim();
  if (s.length > maxLen) return s.slice(0, maxLen);
  return s;
}

function isUrlLike(raw) {
  const s = String(raw || '').trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^file:/i.test(s);
}

function defaultExecFile(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      windowsHide: true,
      shell: false,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      ...opts,
    }, (err, stdout, stderr) => {
      if (err) {
        const wrapped = new Error(String(stderr || err.message || 'Command failed').trim());
        wrapped.code = err.code;
        wrapped.stdout = String(stdout || '');
        wrapped.stderr = String(stderr || '');
        return reject(wrapped);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function defaultCheckTcp(host, port, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const sock = new net.Socket();
    const finish = (open) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(open);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try {
      sock.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

async function defaultCheckHttp(url, { timeoutMs = HTTP_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const safeUrl = validateHttpUrl(url);
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(safeUrl, { method: 'HEAD', redirect: 'manual', signal: ctrl.signal });
    } catch {
      res = await fetchImpl(safeUrl, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    }
    const latencyMs = Date.now() - startedAt;
    const status = Number(res?.status || 0);
    const ok = status > 0 && status < 500;
    return { ok, httpStatus: status, latencyMs };
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      latencyMs: Date.now() - startedAt,
      error: err?.name === 'AbortError' ? 'Таймаут 2.5с' : String(err?.message || 'Нет ответа'),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseKensakuResults(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return [];
  const normalizeItem = (entry) => {
    if (!entry) return null;
    if (typeof entry === 'string') {
      const p = entry.trim();
      if (!p) return null;
      return {
        path: p,
        name: path.basename(p),
        folder: path.basename(path.dirname(p)),
        score: null,
        snippet: '',
      };
    }
    const p = String(entry.path || entry.file_path || entry.filePath || entry.file || '').trim();
    if (!p) return null;
    return {
      path: p,
      name: String(entry.name || entry.title || path.basename(p)),
      folder: path.basename(path.dirname(p)),
      score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : null,
      snippet: String(entry.snippet || entry.excerpt || entry.content || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    };
  };

  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.results)
        ? parsed.results
        : Array.isArray(parsed?.hits)
          ? parsed.hits
          : Array.isArray(parsed?.items)
            ? parsed.items
            : [];
    return list.map(normalizeItem).filter(Boolean);
  } catch {
    // Support JSONL lines fallback
    const items = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const obj = JSON.parse(trimmed);
        const norm = normalizeItem(obj);
        if (norm) items.push(norm);
      } catch {}
    }
    return items;
  }
}

class PcToolsEngine {
  constructor(opts = {}) {
    this.execFileImpl = typeof opts.execFileImpl === 'function' ? opts.execFileImpl : defaultExecFile;
    this.spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn;
    this.checkTcpImpl = typeof opts.checkTcpImpl === 'function' ? opts.checkTcpImpl : defaultCheckTcp;
    this.fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
    this.checkHttpImpl = typeof opts.checkHttpImpl === 'function'
      ? opts.checkHttpImpl
      : (url, cfg) => defaultCheckHttp(url, { ...cfg, fetchImpl: this.fetchImpl });
    this.existsImpl = typeof opts.existsImpl === 'function' ? opts.existsImpl : (p) => fs.existsSync(p);
    this.readdirImpl = typeof opts.readdirImpl === 'function' ? opts.readdirImpl : (p) => fs.readdirSync(p);
    this.paths = { ...DEFAULT_PATHS, ...(opts.paths || {}) };
    this.cacheTtlMs = Number.isFinite(Number(opts.cacheTtlMs)) ? Number(opts.cacheTtlMs) : CACHE_TTL_MS;
    this.artifactsDir = opts.artifactsDir || path.join(os.tmpdir(), 'capri-pc-tools');
    this.cache = null;
    this.inflightStatus = null;
    this.blenderProcess = null;
  }

  getCachedStatus() {
    return this.cache ? this.cache.data : null;
  }

  invalidateCache() {
    this.cache = null;
  }

  async safeExec(cmd, args, timeout = PROBE_TIMEOUT_MS) {
    try {
      const res = await this.execFileImpl(cmd, args, { timeout });
      return { ok: true, stdout: res.stdout || '', stderr: res.stderr || '' };
    } catch (err) {
      return {
        ok: false,
        code: err?.code,
        stdout: String(err?.stdout || ''),
        stderr: String(err?.stderr || ''),
        error: String(err?.message || 'failed'),
      };
    }
  }

  async probePcTool(def) {
    const base = {
      id: def.id,
      name: def.name,
      description: def.description,
      command: def.command || '',
      url: def.url || '',
      actions: [...def.actions],
      offlineSafe: Boolean(def.offlineSafe),
      privacySafe: Boolean(def.privacySafe),
      running: false,
      ready: false,
      status: 'missing',
      detail: '',
    };

    switch (def.id) {
      case 'tool-data': {
        const scriptOk = this.existsImpl(this.paths.analyzeScript);
        const pyRes = await this.safeExec(this.paths.pythonBin, [
          '-c',
          'import pandas, matplotlib, openpyxl; print("ok")',
        ]);
        const ready = scriptOk && pyRes.ok;
        return {
          ...base,
          ready,
          status: ready ? 'ready' : 'missing',
          detail: ready
            ? 'pandas + matplotlib + openpyxl'
            : (!scriptOk ? 'Скрипт capri-data-analyze.py не найден' : 'Нет pandas/matplotlib/openpyxl'),
        };
      }

      case 'tool-media': {
        const [ytRes, ffRes, whisperUp] = await Promise.all([
          this.safeExec(this.paths.ytDlpBin, ['--version']),
          this.safeExec(this.paths.ffmpegBin, ['-version']),
          this.checkTcpImpl('127.0.0.1', 8765),
        ]);
        const ready = ytRes.ok && ffRes.ok && whisperUp;
        const partial = ffRes.ok && (ytRes.ok || whisperUp);
        const parts = [
          ytRes.ok ? 'yt-dlp' : 'нет yt-dlp',
          ffRes.ok ? 'ffmpeg' : 'нет ffmpeg',
          whisperUp ? 'Whisper :8765' : 'Whisper выкл',
        ];
        return {
          ...base,
          ready,
          running: Boolean(whisperUp),
          status: ready ? 'ready' : (partial ? 'needs_setup' : 'missing'),
          detail: parts.join(' · '),
        };
      }

      case 'tool-docs': {
        const sofficeOk = this.existsImpl(this.paths.sofficeBin);
        const inkscapeOk = this.existsImpl(this.paths.inkscapeBin);
        const scriptOk = this.existsImpl(this.paths.convertScript);
        const [docxRes, mdBinRes, mdPyRes] = await Promise.all([
          this.safeExec(this.paths.pythonBin, ['-c', 'import docx; print("ok")']),
          this.safeExec(this.paths.markitdownBin, ['--help']),
          this.safeExec(this.paths.pythonBin, ['-c', 'import markitdown; print("ok")']),
        ]);
        const mdOk = mdBinRes.ok || mdPyRes.ok;
        const allOk = scriptOk && docxRes.ok && sofficeOk && inkscapeOk && mdOk;
        const coreOk = scriptOk && docxRes.ok;
        const missing = [];
        if (!sofficeOk) missing.push('LibreOffice');
        if (!inkscapeOk) missing.push('Inkscape');
        if (!mdOk) missing.push('markitdown');
        if (!docxRes.ok) missing.push('python-docx');
        if (!scriptOk) missing.push('capri-convert-doc.py');
        return {
          ...base,
          ready: allOk || coreOk,
          status: allOk ? 'ready' : (coreOk ? 'needs_setup' : 'missing'),
          detail: allOk ? 'LibreOffice + Inkscape + markitdown + python-docx' : `Не найдено: ${missing.join(', ')}`,
        };
      }

      case 'tool-kensaku': {
        if (!this.existsImpl(this.paths.kensakuCli)) {
          return { ...base, status: 'missing', detail: 'kensaku-cli не найден' };
        }
        const st = await this.safeExec(this.paths.kensakuCli, ['state', '--json']);
        const combined = `${st.stdout}\n${st.stderr}\n${st.error}`;
        const noIndex = !st.ok || /no kensaku index/i.test(combined);
        if (noIndex) {
          return {
            ...base,
            ready: false,
            status: 'needs_setup',
            detail: 'Индекс не собран — нажмите Запустить',
          };
        }
        let indexedInfo = 'Индекс готов';
        try {
          const parsed = JSON.parse(st.stdout || '{}');
          const count = parsed.indexed_files ?? parsed.file_count ?? parsed.documents ?? parsed.totalFiles;
          if (Number.isFinite(Number(count))) indexedInfo = `Индекс: ${count} файлов`;
        } catch {}
        return { ...base, ready: true, status: 'ready', detail: indexedInfo };
      }

      case 'tool-upscayl': {
        const binOk = this.existsImpl(this.paths.upscaylBin);
        const dirOk = this.existsImpl(this.paths.upscaylModelsDir);
        let modelCount = 0;
        if (dirOk) {
          try {
            modelCount = this.readdirImpl(this.paths.upscaylModelsDir).filter((f) => f.endsWith('.bin')).length;
          } catch {}
        }
        const ready = binOk && dirOk && modelCount > 0;
        return {
          ...base,
          ready,
          status: ready ? 'ready' : 'missing',
          detail: ready ? `upscayl-bin · ${modelCount} моделей` : 'Upscayl CLI или модели не найдены',
        };
      }

      case 'tool-penpot-mcp': {
        const [mcpOpen, uiOpen] = await Promise.all([
          this.checkTcpImpl('127.0.0.1', 4401),
          this.checkTcpImpl('127.0.0.1', 9001),
        ]);
        const running = Boolean(mcpOpen);
        return {
          ...base,
          running,
          ready: running,
          status: running ? 'running' : 'offline',
          detail: running
            ? (uiOpen ? 'MCP :4401 · UI :9001' : 'MCP :4401 активен')
            : 'Порт :4401 не отвечает',
        };
      }

      case 'tool-blender-mcp': {
        const binOk = this.existsImpl(this.paths.blenderBin);
        const scriptOk = this.existsImpl(this.paths.blenderMcpScript);
        const mcpOpen = await this.checkTcpImpl('127.0.0.1', 9876);
        if (!binOk || !scriptOk) {
          return {
            ...base,
            running: Boolean(mcpOpen),
            ready: false,
            status: 'missing',
            detail: !binOk ? 'blender.exe не найден' : 'start_blender_mcp.py не найден',
          };
        }
        return {
          ...base,
          running: Boolean(mcpOpen),
          ready: true,
          status: mcpOpen ? 'running' : 'idle',
          detail: mcpOpen ? 'MCP :9876 активен' : 'Готов к запуску (:9876 выкл)',
        };
      }

      case 'tool-comfy': {
        const open = await this.checkTcpImpl('127.0.0.1', 8000);
        return {
          ...base,
          running: Boolean(open),
          ready: Boolean(open),
          status: open ? 'running' : 'idle',
          detail: open ? 'Запущен :8000 · делит VRAM с Ollama' : 'Порт :8000 выключен',
        };
      }

      case 'tool-agent-desktop': {
        const ok = this.existsImpl(this.paths.agentDesktopBin);
        return {
          ...base,
          ready: ok,
          status: ok ? 'ready' : 'missing',
          detail: ok ? 'agent-desktop.exe готов' : 'vendor/agent-desktop/agent-desktop.exe не найден',
        };
      }

      case 'tool-whisper': {
        const open = await this.checkTcpImpl('127.0.0.1', 8765);
        return {
          ...base,
          running: Boolean(open),
          ready: Boolean(open),
          status: open ? 'running' : 'idle',
          detail: open ? '127.0.0.1:8765 активен' : 'Порт :8765 выключен',
        };
      }

      case 'tool-proton-sync': {
        const [protonOpen, syncOpen] = await Promise.all([
          this.checkTcpImpl('127.0.0.1', 1143),
          this.checkTcpImpl('127.0.0.1', 8384),
        ]);
        const both = protonOpen && syncOpen;
        const any = protonOpen || syncOpen;
        return {
          ...base,
          running: any,
          ready: both,
          status: both ? 'running' : (any ? 'needs_setup' : 'offline'),
          detail: `Proton :1143 ${protonOpen ? 'вкл' : 'выкл'} · Syncthing :8384 ${syncOpen ? 'вкл' : 'выкл'}`,
        };
      }

      default:
        return base;
    }
  }

  async probeBridge(def) {
    const res = await this.checkHttpImpl(def.url, { timeoutMs: HTTP_TIMEOUT_MS });
    const ready = Boolean(res.ok);
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      url: def.url,
      actions: [...def.actions],
      ready,
      status: ready ? 'ready' : 'offline',
      httpStatus: res.httpStatus || 0,
      latencyMs: Number.isFinite(res.latencyMs) ? res.latencyMs : null,
      detail: ready
        ? `HTTP ${res.httpStatus} · ${res.latencyMs} мс`
        : (res.error || 'Нет связи'),
    };
  }

  async getStatus({ refresh = false } = {}) {
    if (!refresh && this.cache && Date.now() - this.cache.checkedAt < this.cacheTtlMs) {
      return this.cache.data;
    }
    if (this.inflightStatus) {
      return this.inflightStatus;
    }

    this.inflightStatus = (async () => {
      const [pcTools, bridgeItems] = await Promise.all([
        Promise.all(PC_TOOLS_CATALOG.map((def) => this.probePcTool(def))),
        Promise.all(LENOVO_BRIDGES_CATALOG.map((def) => this.probeBridge(def))),
      ]);

      const pcReady = pcTools.filter((t) => t.ready || t.running).length;
      const bridgeReady = bridgeItems.filter((b) => b.ready).length;
      const checkedAt = Date.now();
      const data = {
        checkedAt,
        pc: {
          tools: pcTools,
          readyCount: pcReady,
          totalCount: pcTools.length,
        },
        bridges: {
          online: bridgeReady > 0,
          items: bridgeItems,
          readyCount: bridgeReady,
          totalCount: bridgeItems.length,
        },
      };
      this.cache = { data, checkedAt };
      return data;
    })();

    try {
      return await this.inflightStatus;
    } finally {
      this.inflightStatus = null;
    }
  }

  async analyzeData({ filePath, query = '', outDir } = {}) {
    try {
      const cleanFile = validateLocalPath(filePath, { mustExist: true });
      const ext = path.extname(cleanFile).toLowerCase();
      if (!['.csv', '.tsv', '.xlsx', '.xls', '.json'].includes(ext)) {
        return { ok: false, error: `Неподдерживаемый формат данных: ${ext || 'неизвестен'}` };
      }
      const cleanOutDir = validateLocalPath(outDir || path.join(this.artifactsDir, 'data'));
      const cleanQuery = validateCleanText(query, 240);
      const args = [this.paths.analyzeScript, cleanFile, '--out-dir', cleanOutDir];
      if (cleanQuery) args.push('--query', cleanQuery);

      const res = await this.execFileImpl(this.paths.pythonBin, args, { timeout: EXEC_TIMEOUT_MS });
      const parsed = JSON.parse(String(res.stdout || '{}').trim());
      return parsed;
    } catch (err) {
      return { ok: false, error: String(err?.message || 'Ошибка анализа данных') };
    }
  }

  async convertDocument({ inputPath, targetFormat = 'docx', outDir } = {}) {
    try {
      const cleanIn = validateLocalPath(inputPath, { mustExist: true });
      const fmt = String(targetFormat || 'docx').trim().toLowerCase().replace(/^\./, '');
      if (!['docx', 'txt', 'pdf', 'png'].includes(fmt)) {
        return { ok: false, error: `Недопустимый формат конвертации: ${targetFormat}` };
      }
      const resolvedOutDir = validateLocalPath(outDir || path.dirname(cleanIn));
      fs.mkdirSync(resolvedOutDir, { recursive: true });
      const stem = path.basename(cleanIn, path.extname(cleanIn));
      const outPath = path.join(resolvedOutDir, `${stem}.${fmt}`);

      if (fmt === 'docx' || fmt === 'txt') {
        const res = await this.execFileImpl(
          this.paths.pythonBin,
          [this.paths.convertScript, cleanIn, '--to', fmt, '--out', outPath],
          { timeout: EXEC_TIMEOUT_MS },
        );
        const parsed = JSON.parse(String(res.stdout || '{}').trim());
        return { ...parsed, format: fmt };
      }

      if (fmt === 'pdf') {
        if (!this.existsImpl(this.paths.sofficeBin)) {
          return { ok: false, error: 'LibreOffice (soffice.exe) не найден.' };
        }
        await this.execFileImpl(
          this.paths.sofficeBin,
          ['--headless', '--convert-to', 'pdf', '--outdir', resolvedOutDir, cleanIn],
          { timeout: EXEC_TIMEOUT_MS },
        );
        const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
        return { ok: fs.existsSync(outPath), outputPath: outPath, format: 'pdf', bytes: size };
      }

      if (fmt === 'png') {
        if (path.extname(cleanIn).toLowerCase() !== '.svg') {
          return { ok: false, error: 'Конвертация в PNG через Inkscape поддерживает только .svg файлы.' };
        }
        if (!this.existsImpl(this.paths.inkscapeBin)) {
          return { ok: false, error: 'Inkscape (inkscape.exe) не найден.' };
        }
        await this.execFileImpl(
          this.paths.inkscapeBin,
          [cleanIn, '--export-type=png', `--export-filename=${outPath}`],
          { timeout: EXEC_TIMEOUT_MS },
        );
        const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
        return { ok: fs.existsSync(outPath), outputPath: outPath, format: 'png', bytes: size };
      }

      return { ok: false, error: `Формат ${fmt} не поддерживается.` };
    } catch (err) {
      return { ok: false, error: String(err?.message || 'Ошибка конвертации документа') };
    }
  }

  async transcribeMedia({ source, outDir, whisperUrl = 'http://127.0.0.1:8765', isPrivate = false } = {}) {
    const rawSource = String(source || '').trim();
    if (!rawSource) {
      return { ok: false, error: 'Не указан локальный файл или URL для транскрибации.' };
    }

    const sourceIsUrl = isUrlLike(rawSource);
    if (sourceIsUrl && isPrivate) {
      return {
        ok: false,
        blocked: true,
        error: 'В приватном/изолированном режиме скачивание внешних URL запрещено. Укажи локальный аудио- или видеофайл.',
      };
    }

    let safeWhisperBase;
    try {
      safeWhisperBase = validateHttpUrl(whisperUrl).replace(/\/+$/, '');
    } catch (err) {
      return { ok: false, error: err.message };
    }

    const workDir = fs.mkdtempSync(path.join(outDir ? validateLocalPath(outDir) : os.tmpdir(), 'capri-media-'));
    try {
      let mediaFile;
      let cleanUrl = '';
      if (sourceIsUrl) {
        cleanUrl = validateHttpUrl(rawSource);
        const outTemplate = path.join(workDir, 'download.%(ext)s');
        await this.execFileImpl(
          this.paths.ytDlpBin,
          ['--no-playlist', '-x', '--audio-format', 'wav', '-o', outTemplate, '--', cleanUrl],
          { timeout: MEDIA_TIMEOUT_MS },
        );
        const files = fs.readdirSync(workDir).map((f) => path.join(workDir, f));
        mediaFile = files.find((f) => fs.statSync(f).isFile());
        if (!mediaFile) {
          return { ok: false, error: 'yt-dlp не сохранил аудиофайл.' };
        }
      } else {
        mediaFile = validateLocalPath(rawSource, { mustExist: true });
      }

      const wavPath = path.join(workDir, 'normalized-16k.wav');
      await this.execFileImpl(
        this.paths.ffmpegBin,
        ['-y', '-i', mediaFile, '-ar', '16000', '-ac', '1', wavPath],
        { timeout: MEDIA_TIMEOUT_MS },
      );

      const wavBuf = fs.readFileSync(wavPath);
      const form = new FormData();
      form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'audio.wav');
      form.append('response_format', 'json');

      const res = await this.fetchImpl(`${safeWhisperBase}/v1/audio/transcriptions`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        return { ok: false, error: `Whisper вернул HTTP ${res.status}` };
      }
      const data = await res.json();
      const text = String(data?.text || '').trim();
      const wrappedText = sourceIsUrl
        ? `<<<UNTRUSTED_MEDIA_TRANSCRIPT source="${cleanUrl}">>>\n${text}\n<<<END_UNTRUSTED_MEDIA_TRANSCRIPT>>>`
        : text;

      return {
        ok: true,
        text,
        wrappedText,
        source: sourceIsUrl ? cleanUrl : mediaFile,
        localOnly: !sourceIsUrl,
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || 'Ошибка транскрибации медиа') };
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {}
    }
  }

  async upscaleImage({ inputPath, outputPath, model = 'upscayl-standard-4x' } = {}) {
    try {
      if (!this.existsImpl(this.paths.upscaylBin)) {
        return { ok: false, error: 'upscayl-bin.exe не найден.' };
      }
      const cleanIn = validateLocalPath(inputPath, { mustExist: true });
      const cleanModel = String(model || 'upscayl-standard-4x').trim();
      if (!SAFE_MODEL_RE.test(cleanModel)) {
        return { ok: false, error: `Недопустимое имя модели Upscayl: ${model}` };
      }
      const defaultOut = path.join(
        path.dirname(cleanIn),
        `${path.basename(cleanIn, path.extname(cleanIn))}-4x.png`,
      );
      const cleanOut = validateLocalPath(outputPath || defaultOut);
      fs.mkdirSync(path.dirname(cleanOut), { recursive: true });

      await this.execFileImpl(
        this.paths.upscaylBin,
        ['-i', cleanIn, '-o', cleanOut, '-m', this.paths.upscaylModelsDir, '-n', cleanModel, '-z', '4'],
        { timeout: MEDIA_TIMEOUT_MS },
      );

      const bytes = fs.existsSync(cleanOut) ? fs.statSync(cleanOut).size : 0;
      return { ok: fs.existsSync(cleanOut), outputPath: cleanOut, model: cleanModel, bytes };
    } catch (err) {
      return { ok: false, error: String(err?.message || 'Ошибка апскейла изображения') };
    }
  }

  async searchKensaku({ query, limit = 8, ext = '' } = {}) {
    try {
      if (!this.existsImpl(this.paths.kensakuCli)) {
        return { ok: false, results: [], error: 'kensaku-cli не найден' };
      }
      const cleanQuery = validateCleanText(query, 200);
      if (!cleanQuery) {
        return { ok: false, results: [], error: 'Пустой поисковый запрос.' };
      }
      const cleanLimit = Math.max(1, Math.min(30, Math.round(Number(limit) || 8)));
      const args = ['search', cleanQuery, '--json', '--limit', String(cleanLimit)];
      const cleanExt = String(ext || '').trim().replace(/^\./, '');
      if (cleanExt) {
        if (!SAFE_EXT_RE.test(cleanExt)) {
          return { ok: false, results: [], error: `Недопустимое расширение: ${ext}` };
        }
        args.push('--ext', cleanExt);
      }

      const res = await this.execFileImpl(this.paths.kensakuCli, args, { timeout: PROBE_TIMEOUT_MS });
      const results = parseKensakuResults(res.stdout);
      return { ok: true, results };
    } catch (err) {
      return { ok: false, results: [], error: String(err?.message || 'Ошибка поиска Kensaku') };
    }
  }

  async runAction({ toolId, action, payload = {} } = {}) {
    const cleanId = String(toolId || '').trim();
    const cleanAction = String(action || '').trim().toLowerCase();
    const safePayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};

    if (!ALLOWED_ACTIONS.has(cleanAction)) {
      return { ok: false, error: `Недопустимое действие «${action}».` };
    }

    if (cleanAction === 'probe') {
      if (PC_TOOL_MAP.has(cleanId)) {
        const item = await this.probePcTool(PC_TOOL_MAP.get(cleanId));
        this.invalidateCache();
        const status = await this.getStatus({ refresh: true });
        return { ok: true, toolId: cleanId, action: 'probe', item, status };
      }
      if (BRIDGE_MAP.has(cleanId)) {
        const item = await this.probeBridge(BRIDGE_MAP.get(cleanId));
        this.invalidateCache();
        const status = await this.getStatus({ refresh: true });
        return { ok: true, toolId: cleanId, action: 'probe', item, status };
      }
      return { ok: false, error: `Неизвестный инструмент или мост: «${cleanId}».` };
    }

    if (cleanAction === 'launch') {
      if (cleanId !== 'tool-kensaku') {
        return { ok: false, error: `Действие launch разрешено только для tool-kensaku.` };
      }
      if (!this.existsImpl(this.paths.kensakuGui)) {
        return { ok: false, error: 'kensaku.exe не найден.' };
      }
      const child = this.spawnImpl(this.paths.kensakuGui, [], {
        detached: true,
        shell: false,
        windowsHide: false,
        stdio: 'ignore',
      });
      if (typeof child?.unref === 'function') child.unref();
      this.invalidateCache();
      return { ok: true, toolId: cleanId, action: 'launch', message: 'Kensaku запущен.' };
    }

    if (cleanAction === 'start') {
      if (cleanId !== 'tool-blender-mcp') {
        return { ok: false, error: 'Действие start разрешено только для tool-blender-mcp.' };
      }
      if (!this.existsImpl(this.paths.blenderBin) || !this.existsImpl(this.paths.blenderMcpScript)) {
        return { ok: false, error: 'Blender или скрипт start_blender_mcp.py не найден.' };
      }
      const alreadyOpen = await this.checkTcpImpl('127.0.0.1', 9876);
      if (alreadyOpen) {
        const status = await this.getStatus({ refresh: true });
        return { ok: true, toolId: cleanId, action: 'start', message: 'Blender MCP уже работает (:9876).', status };
      }
      const child = this.spawnImpl(this.paths.blenderBin, ['--python', this.paths.blenderMcpScript], {
        detached: false,
        shell: false,
        windowsHide: false,
        stdio: 'ignore',
      });
      this.blenderProcess = child;
      child?.once?.('exit', () => {
        if (this.blenderProcess === child) this.blenderProcess = null;
      });
      this.invalidateCache();
      const status = await this.getStatus({ refresh: true });
      return { ok: true, toolId: cleanId, action: 'start', message: 'Blender MCP запускается…', status };
    }

    if (cleanAction === 'stop') {
      if (cleanId !== 'tool-blender-mcp') {
        return { ok: false, error: 'Действие stop разрешено только для tool-blender-mcp.' };
      }
      if (!this.blenderProcess || this.blenderProcess.killed) {
        return {
          ok: false,
          error: 'Blender MCP не запущен из Капри (запущенный вручную Blender закрой отдельно).',
        };
      }
      try {
        this.blenderProcess.kill();
      } catch (err) {
        return { ok: false, error: String(err?.message || 'Не удалось остановить Blender MCP') };
      }
      this.blenderProcess = null;
      this.invalidateCache();
      const status = await this.getStatus({ refresh: true });
      return { ok: true, toolId: cleanId, action: 'stop', message: 'Blender MCP остановлен.', status };
    }

    if (cleanAction === 'analyze') {
      if (cleanId && cleanId !== 'tool-data') {
        return { ok: false, error: 'analyze поддерживается только для tool-data.' };
      }
      return this.analyzeData(safePayload);
    }

    if (cleanAction === 'convert') {
      if (cleanId && cleanId !== 'tool-docs') {
        return { ok: false, error: 'convert поддерживается только для tool-docs.' };
      }
      return this.convertDocument(safePayload);
    }

    if (cleanAction === 'transcribe') {
      if (cleanId && cleanId !== 'tool-media') {
        return { ok: false, error: 'transcribe поддерживается только для tool-media.' };
      }
      return this.transcribeMedia(safePayload);
    }

    if (cleanAction === 'upscale') {
      if (cleanId && cleanId !== 'tool-upscayl') {
        return { ok: false, error: 'upscale поддерживается только для tool-upscayl.' };
      }
      return this.upscaleImage(safePayload);
    }

    if (cleanAction === 'search') {
      if (cleanId && cleanId !== 'tool-kensaku') {
        return { ok: false, error: 'search поддерживается только для tool-kensaku.' };
      }
      return this.searchKensaku(safePayload);
    }

    return { ok: false, error: `Действие «${cleanAction}» не обработано.` };
  }
}

module.exports = {
  PcToolsEngine,
  PC_TOOLS_CATALOG,
  LENOVO_BRIDGES_CATALOG,
  CACHE_TTL_MS,
  parseKensakuResults,
  validateHttpUrl,
  validateLocalPath,
};
