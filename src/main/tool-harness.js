'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { readsNetwork } = require('./terminal-tool');

const DEFAULT_MAX_STEPS = 6;
// Tools whose output is our own (files we made, our containers): everything else (web, RSS, mail, GitHub,
// the phone's messages, notes with saved pages…) may carry someone else's text, so after it the turn is
// "untrusted" and changing terminal commands ask until the turn ends (Danyal 2026-11-25).
const TRUSTED_OUTPUT_TOOLS = new Set([
  'document_create', 'docker_control', 'comfy_generate', 'penpot_run', 'penpot_export', 'presenton_create', 'terminal_run',
]);

/** Who says yes: the phone's own window for a phone turn (never the PC's, nobody may be there), else the PC. */
function askerFor(deps, ctx = {}) {
  if (typeof ctx.askUser === 'function') return ctx.askUser;
  if (ctx.origin === 'phone') return null;
  return typeof deps.askUser === 'function' ? deps.askUser : null;
}
const DEFAULT_MAX_OUTPUT_CHARS = 4500;
const ERROR_PREFIX = '[ОШИБКА ИНСТРУМЕНТА — НЕ ВЫПОЛНЕНО, НЕ ГОВОРИ ЧТО ГОТОВО]: ';

const DEFAULT_CONNECTOR_IDS = [
  'obsidian', 'opennotebook', 'nomad-kiwix', 'gemini-notebook', 'capri-web',
  'proton-pim', 'freshrss', 'freetube', 'youtube', 'penpot', 'presenton',
  'comfyui', 'libreoffice', 'home-server', 'docker', 'github', 'context7',
  'science-search', 'huggingface', 'google-workspace', 'health-connect', 'wger', 'telegram',
];

const CONNECTOR_ICONS = {
  obsidian: 'memory',
  opennotebook: 'book',
  'nomad-kiwix': 'book',
  'gemini-notebook': 'book',
  'capri-web': 'search',
  'science-search': 'search',
  'proton-pim': 'mail',
  telegram: 'mail',
  freshrss: 'news',
  freetube: 'play',
  youtube: 'play',
  penpot: 'design',
  presenton: 'slides',
  comfyui: 'image',
  libreoffice: 'doc',
  context7: 'book',
  github: 'github',
  docker: 'docker',
  'home-server': 'server',
  'health-connect': 'health',
  wger: 'health',
  'google-workspace': 'doc',
  huggingface: 'sparkle',
};

const PENPOT_CHEATSHEET = [
  'Шпаргалка Penpot Plugin API (глобальный объект `penpot`):',
  '- Ellipse: const e = penpot.createEllipse(); e.x=120; e.y=120; e.resize(200,200); e.fills=[{fillColor:"#FFC107",fillOpacity:1}];',
  '- Rectangle: const r = penpot.createRectangle(); r.x=50; r.y=50; r.resize(300,180); r.fills=[{fillColor:"#4285F4",fillOpacity:1}];',
  '- Board: const b = penpot.createBoard(); b.resize(800,600);',
  '- Text: const t = penpot.createText("Title"); t.x=60; t.y=60;',
  'Всегда делай `return { id: e.id }` и не используй `penpot.addShape`.',
].join('\n');

const DOCKER_ACTION_MAP = {
  status: 'status', статус: 'status', состояние: 'status', список: 'status',
  start: 'start', старт: 'start', запусти: 'start', включи: 'start',
  stop: 'stop', стоп: 'stop', останови: 'stop', выключи: 'stop',
  restart: 'restart', рестарт: 'restart', перезапусти: 'restart',
};

function normalizeDockerAction(raw) {
  const key = String(raw || 'status').trim().toLowerCase().replace(/ё/g, 'е');
  return DOCKER_ACTION_MAP[key] || key;
}

function resolveDockerHost(stackId, host) {
  const h = String(host || '').trim().toLowerCase();
  if (h === 'pc' || h === 'lenovo') return h;
  return /^(?:srv-|nomad_)/i.test(String(stackId || '').trim()) ? 'lenovo' : 'pc';
}

function formatFormatIcon(format) {
  const f = String(format || '').toLowerCase();
  if (f === 'pptx') return 'slides';
  if (f === 'xlsx' || f === 'csv') return 'sheet';
  if (f === 'svg' || f === 'png') return 'image';
  if (['py', 'js', 'html', 'json'].includes(f)) return 'code';
  return 'doc';
}

/**
 * Truncates long tool outputs while keeping both head and tail context so
 * local models never blow their context window on large dumps.
 */
function boundToolOutput(text, maxChars = DEFAULT_MAX_OUTPUT_CHARS) {
  const s = String(text ?? '').trim();
  if (!s || s.length <= maxChars) return s;
  const keepHead = Math.floor(maxChars * 0.65);
  const keepTail = Math.max(200, maxChars - keepHead - 48);
  const omitted = s.length - keepHead - keepTail;
  return `${s.slice(0, keepHead)}\n...[обрезано ${omitted} симв.]...\n${s.slice(-keepTail)}`;
}

/**
 * Hermes-style schema-guided argument coercion for local models that sometimes
 * emit numbers/booleans as strings or serialize tool arguments as a JSON string.
 */
function coerceValue(propSchema, value) {
  if (value === undefined || value === null || !propSchema || !propSchema.type) return value;
  const target = propSchema.type;
  if (target === 'string') {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  if (target === 'integer' || target === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return target === 'integer' ? Math.trunc(value) : value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value.trim());
      if (Number.isFinite(n)) return target === 'integer' ? Math.trunc(n) : n;
    }
    return value;
  }
  if (target === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const low = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'да'].includes(low)) return true;
      if (['false', '0', 'no', 'нет'].includes(low)) return false;
    }
    if (typeof value === 'number') return Boolean(value);
    return value;
  }
  if ((target === 'object' || target === 'array') && typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (target === 'array' && Array.isArray(parsed)) return parsed;
      if (target === 'object' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return value;
}

function coerceToolArgs(parametersSchema, rawArgs) {
  let obj = rawArgs;
  if (typeof obj === 'string') {
    const trimmed = obj.trim();
    if (!trimmed) {
      obj = {};
    } else {
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return { ok: false, args: {}, error: 'Некорректный JSON в аргументах инструмента.' };
      }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    obj = {};
  }
  const props = parametersSchema?.properties || {};
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    out[key] = coerceValue(props[key], val);
  }
  const required = Array.isArray(parametersSchema?.required) ? parametersSchema.required : [];
  const missing = required.filter((k) => out[k] === undefined || out[k] === null || String(out[k]).trim() === '');
  if (missing.length) {
    return { ok: false, args: out, error: `Не заполнены обязательные поля: ${missing.join(', ')}` };
  }
  return { ok: true, args: out, error: null };
}

async function waitForHttpReady(url, { timeoutMs = 15000, intervalMs = 600, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
      if (res && res.status > 0 && res.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/**
 * Builds the curated, schema-validated tool registry for local/bridge agents.
 */
function buildToolRegistry(deps = {}, ctx = {}) {
  const {
    penpotMcp,
    dockerEngine,
    connectorsEngine,
    pcToolsEngine,
    phoneControlEngine,
    terminal,
    askUser,
    torState,
    openSite,
    webSearch,
    obsidianSearch,
    generateImage,
    saveGalleryBuffer,
    resolveGalleryFile,
    getPresentonConfig,
    createDocument,
    registerArtifact,
    extractLinks,
    artifactsDir,
    fetchImpl = fetch,
  } = deps;
  const isolated = Boolean(ctx.isolated);
  const torQuarantined = Boolean(torState?.isQuarantined?.());
  const items = [];

  const ensureStackRunning = async (stackId, readyUrl) => {
    if (readyUrl && await waitForHttpReady(readyUrl, { timeoutMs: 1200, intervalMs: 300, fetchImpl })) {
      return { ok: true, startedNow: false };
    }
    if (!dockerEngine || typeof dockerEngine.controlStack !== 'function') {
      return { ok: false, error: `Контейнер ${stackId} не отвечает и Docker-управление недоступно.` };
    }
    const startRes = await dockerEngine.controlStack({ host: 'pc', stackId, action: 'start' });
    if (!startRes?.ok && !/already running|started|is running/i.test(String(startRes?.detail || startRes?.message || ''))) {
      return { ok: false, error: startRes?.error || startRes?.message || startRes?.detail || `Не удалось запустить ${stackId}.` };
    }
    if (readyUrl) {
      const ready = await waitForHttpReady(readyUrl, { timeoutMs: 16000, intervalMs: 700, fetchImpl });
      if (!ready) return { ok: false, error: `${stackId} запустился, но HTTP порт ещё не отвечает.` };
    }
    return { ok: true, startedNow: true };
  };

  if (penpotMcp) {
    items.push({
      name: 'penpot_run',
      connectorId: 'penpot',
      icon: 'design',
      label: 'Penpot MCP',
      description: 'Execute JavaScript in Penpot MCP (:4401) using global `penpot` to create or edit shapes and return `{ id }`.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Valid Penpot Plugin API JavaScript body using global `penpot`.' },
        },
        required: ['code'],
      },
      async execute(args) {
        const up = await ensureStackRunning('pc-penpot', 'http://127.0.0.1:4401/mcp');
        if (!up.ok) return { ok: false, output: up.error, error: up.error };
        try {
          const res = await penpotMcp.callToolRaw('execute_code', { code: args.code });
          return { ok: true, output: res.text || 'Код выполнен в Penpot.' };
        } catch (err) {
          const msg = String(err?.message || err);
          if (/No userToken found|authentication|plugin/i.test(msg)) {
            try { openSite?.('http://localhost:9001'); } catch {}
            const hint = 'Penpot MCP (:4401) активен, но в браузере не подключён макет (нет userToken). Я открыла http://localhost:9001 — открой там проект/файл и убедись, что включён Penpot MCP плагин, затем повтори.';
            return { ok: false, output: hint, error: 'В Penpot не открыт макет с MCP-плагином' };
          }
          return { ok: false, output: `Ошибка Penpot execute_code: ${msg}\n\n${PENPOT_CHEATSHEET}`, error: msg };
        }
      },
    });

    items.push({
      name: 'penpot_export',
      connectorId: 'penpot',
      icon: 'design',
      label: 'Penpot Экспорт',
      description: 'Export the active Penpot page, selection, or shapeId as PNG or SVG and attach it to the chat.',
      parameters: {
        type: 'object',
        properties: {
          shapeId: { type: 'string', description: '"selection", "page", or concrete shape UUID. Default: "page".' },
          format: { type: 'string', enum: ['png', 'svg'], description: 'Export format: "png" or "svg". Default: "png".' },
        },
        required: [],
      },
      async execute(args) {
        const up = await ensureStackRunning('pc-penpot', 'http://127.0.0.1:4401/mcp');
        if (!up.ok) return { ok: false, output: up.error, error: up.error };
        const shapeId = args.shapeId || 'page';
        const format = args.format === 'svg' ? 'svg' : 'png';
        try {
          const res = await penpotMcp.callToolRaw('export_shape', { shapeId, format, mode: 'shape' });
          let imageName = null;
          const outArtifacts = [];
          if (Array.isArray(res.images) && res.images.length) {
            const first = res.images[0];
            const ext = /svg/i.test(first.mimeType || '') || format === 'svg' ? 'svg' : 'png';
            const buf = Buffer.from(first.data, 'base64');
            if (ext === 'png' && typeof saveGalleryBuffer === 'function') {
              imageName = saveGalleryBuffer(buf, 'png');
              if (imageName && typeof resolveGalleryFile === 'function' && typeof registerArtifact === 'function') {
                const art = registerArtifact(resolveGalleryFile(imageName), { target: 'Penpot Экспорт' });
                if (art) outArtifacts.push(art);
              }
            } else if (ext === 'svg' && typeof registerArtifact === 'function') {
              const dir = typeof artifactsDir === 'function' ? artifactsDir() : 'D:\\Capri\\artifacts';
              fs.mkdirSync(dir, { recursive: true });
              const svgPath = path.join(dir, `penpot-${Date.now()}.svg`);
              fs.writeFileSync(svgPath, buf);
              const art = registerArtifact(svgPath, { target: 'Penpot Экспорт SVG' });
              if (art) outArtifacts.push(art);
            }
          }
          const summary = imageName || outArtifacts.length
            ? `Экспорт выполнен (${format}): файл сохранён и прикреплён (${imageName || outArtifacts[0].name}).`
            : (res.text || `Экспорт (${format}) выполнен.`);
          return {
            ok: true,
            output: summary,
            ...(imageName && { image: imageName }),
            ...(outArtifacts.length && { artifacts: outArtifacts }),
          };
        } catch (err) {
          const msg = String(err?.message || err);
          if (/No userToken found|authentication|plugin/i.test(msg)) {
            try { openSite?.('http://localhost:9001'); } catch {}
            const hint = 'Нельзя экспортировать из Penpot: не открыт макет с активным MCP-плагином (открыла http://localhost:9001).';
            return { ok: false, output: hint, error: 'Нет активного макета Penpot' };
          }
          return { ok: false, output: `Ошибка экспорта Penpot: ${msg}`, error: msg };
        }
      },
    });
  }

  items.push({
    name: 'presenton_create',
    connectorId: 'presenton',
    icon: 'slides',
    label: 'Presenton',
    description: 'Create a web presentation ONLY when the user explicitly names Presenton / презентон. For generic .pptx / slides / presentation file requests (or if Presenton returns an auth error), use document_create with format="pptx" instead.',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Detailed topic, structure, or prompt for the presentation slides.' },
        n_slides: { type: 'integer', description: 'Number of slides (typically 5-10).' },
        language: { type: 'string', description: 'Presentation language, e.g. "Russian" or "English". Default: "Russian".' },
        tone: { type: 'string', enum: ['default', 'casual', 'professional', 'funny', 'educational', 'sales_pitch'], description: 'Presentation tone.' },
      },
      required: ['topic'],
    },
    async execute(args) {
      const cfg = typeof getPresentonConfig === 'function' ? (getPresentonConfig() || {}) : {};
      const baseUrl = String(cfg.url || 'http://127.0.0.1:5100').replace(/\/+$/, '');
      const up = await ensureStackRunning('pc-presenton', `${baseUrl}/api/v1/auth/status`);
      if (!up.ok) return { ok: false, output: up.error, error: up.error };

      const apiKey = String(cfg.apiKey || process.env.PRESENTON_API_KEY || '').trim();
      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      let statusJson = null;
      try {
        const stRes = await fetchImpl(`${baseUrl}/api/v1/auth/status`, { headers, signal: AbortSignal.timeout(4000) });
        if (stRes.ok) statusJson = await stRes.json();
      } catch {}

      if (statusJson && statusJson.configured && !statusJson.authenticated && !apiKey) {
        try { openSite?.(baseUrl); } catch {}
        const msg = `Presenton (${baseUrl}) запущен, но требует API-ключ или вход (аккаунт ${statusJson.username || 'Den'}). Открой ${baseUrl}, войди и выпусти API-ключ для Альтаир.`;
        return { ok: false, output: msg, error: 'Presenton требует авторизацию (API-ключ)' };
      }

      const payload = {
        content: String(args.topic),
        ...(Number.isInteger(args.n_slides) && args.n_slides > 0 && args.n_slides <= 30 && { n_slides: args.n_slides }),
        language: args.language || 'Russian',
        tone: args.tone || 'default',
        template: 'general',
        export_as: 'pptx',
      };

      try {
        const res = await fetchImpl(`${baseUrl}/api/v1/ppt/presentation/generate`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(300000),
        });
        const bodyText = await res.text();
        let data = null;
        try { data = JSON.parse(bodyText); } catch {}
        if (!res.ok) {
          if (res.status === 401 || res.status === 403 || res.status === 428) {
            try { openSite?.(baseUrl); } catch {}
            const msg = `Presenton (${baseUrl}) ответил ${res.status} (требуется API-ключ в config.apiKeys.presenton или DISABLE_AUTH=true).`;
            return { ok: false, output: msg, error: `HTTP ${res.status} Unauthorized` };
          }
          const detail = data?.detail || bodyText.slice(0, 220) || `HTTP ${res.status}`;
          return { ok: false, output: `Ошибка генерации Presenton: ${detail}`, error: String(detail) };
        }
        const editPath = data?.edit_path ? (String(data.edit_path).startsWith('http') ? data.edit_path : `${baseUrl}${data.edit_path}`) : baseUrl;
        const rawPath = String(data?.path || '');
        const filePath = rawPath ? (rawPath.startsWith('http') ? rawPath : `${baseUrl}${rawPath}`) : '';
        const outArtifacts = [];
        if (rawPath && typeof registerArtifact === 'function') {
          let rel = rawPath;
          try { if (rel.startsWith('http')) rel = new URL(rel).pathname; } catch {}
          if (rel.startsWith('/app_data/')) {
            const hostFile = path.join('D:\\Capri\\docker\\presenton\\app_data', rel.slice('/app_data/'.length));
            const art = registerArtifact(hostFile, { target: 'Presenton PPTX', editUrl: editPath });
            if (art) outArtifacts.push(art);
          }
        }
        try { openSite?.(editPath); } catch {}
        const summary = [
          'Презентация создана в локальном Presenton!',
          `ID: ${data?.presentation_id || 'создана'}`,
          `Редактор: ${editPath}`,
          ...(filePath ? [`Файл PPTX: ${filePath}`] : []),
        ].join('\n');
        const outLinks = [{ url: editPath, domain: '127.0.0.1:5100', label: 'Presenton · Редактор', kind: 'local' }];
        return {
          ok: true,
          output: summary,
          links: outLinks,
          ...(outArtifacts.length && { artifacts: outArtifacts }),
        };
      } catch (err) {
        const msg = String(err?.message || err);
        return { ok: false, output: `Presenton не завершил генерацию: ${msg}`, error: msg };
      }
    },
  });

  if (dockerEngine && typeof dockerEngine.controlStack === 'function') {
    items.push({
      name: 'docker_control',
      connectorId: 'docker',
      icon: 'docker',
      label: 'Docker Контейнеры',
      description: 'Check PC or Lenovo (.107) Docker containers status or start/stop/restart a stack (pc-penpot, pc-presenton, srv-freshrss, etc.).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'start', 'stop', 'restart'], description: 'Action to execute.' },
          stackId: { type: 'string', description: 'Stack ID, e.g. "pc-presenton", "pc-penpot", "srv-freshrss".' },
          host: { type: 'string', enum: ['pc', 'lenovo'], description: 'Host: "pc" or "lenovo" (auto-detected for srv-*/nomad_*).' },
        },
        required: ['action'],
      },
      async execute(args, execCtx = {}) {
        const action = normalizeDockerAction(args.action);
        if (action === 'status' || !args.stackId) {
          const st = await dockerEngine.getStatus?.({ refresh: true });
          const pcRows = (st?.pc?.stacks || st?.stacks || []).map((s) => `[pc] ${s.id} (${s.name}): ${s.status}`);
          const lenovoRows = (st?.lenovo?.stacks || []).map((s) => `[lenovo] ${s.id} (${s.name}): ${s.status}`);
          const all = [...pcRows, ...lenovoRows];
          return { ok: true, output: all.join('\n') || 'Стеки Docker не найдены.' };
        }
        const stackId = String(args.stackId).trim();
        const host = resolveDockerHost(stackId, args.host);
        let res = await dockerEngine.controlStack({ host, stackId, action });
        if (res?.confirmRequired && askerFor(deps, ctx)) {
          const answer = await askerFor(deps, ctx)({
            line: res.message || `Остановить критичный стек ${stackId}?`,
            why: `Docker (${host}): ${stackId}`,
            grantable: false,
          }, execCtx.signal);
          if (answer === 'yes') {
            res = await dockerEngine.controlStack({ host, stackId, action, confirm: true });
          } else {
            return { ok: false, output: 'Пользователь отменил остановку критичного стека.', error: 'Cancelled' };
          }
        }
        return {
          ok: Boolean(res?.ok),
          output: res?.message || res?.detail || res?.error || JSON.stringify(res),
          ...(res?.ok ? {} : { error: res?.error || res?.message || 'Docker error' }),
        };
      },
    });
  }

  if (!isolated && typeof webSearch === 'function') {
    items.push({
      name: 'web_search',
      connectorId: 'capri-web',
      icon: 'search',
      label: 'Веб-поиск Capri',
      description: 'Search the live web using Capri local browser + SearXNG when up-to-date online facts are needed.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query in natural words.' },
        },
        required: ['query'],
      },
      async execute(args) {
        const found = await webSearch(args.query);
        const rows = (found?.results || []).slice(0, 4).map((r) => `- ${r.title || r.url}: ${r.url}${r.snippet ? `\n  ${r.snippet}` : ''}`);
        const text = rows.join('\n') || 'Поиск ничего не нашёл.';
        return { ok: true, output: text };
      },
    });
  }

  if (!isolated && typeof openSite === 'function') {
    items.push({
      name: 'web_open',
      connectorId: 'capri-web',
      icon: 'link',
      label: 'Браузер Capri',
      description: 'Open an http/https or localhost URL directly in the browser on the PC.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http:// or https:// URL to open.' },
        },
        required: ['url'],
      },
      async execute(args) {
        let parsed;
        try { parsed = new URL(String(args.url)); } catch {
          return { ok: false, output: 'Некорректный URL.', error: 'Invalid URL' };
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return { ok: false, output: 'Разрешены только http/https ссылки.', error: 'Forbidden scheme' };
        }
        await openSite(parsed.href);
        return { ok: true, output: `Открыла в браузере: ${parsed.href}` };
      },
    });
  }

  if (typeof obsidianSearch === 'function') {
    items.push({
      name: 'obsidian_search',
      connectorId: 'obsidian',
      icon: 'memory',
      label: 'Obsidian Vault',
      description: 'Search the user personal Obsidian vault notes.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search topic or keywords.' },
        },
        required: ['query'],
      },
      async execute(args) {
        const hits = await obsidianSearch(args.query);
        const text = Array.isArray(hits) && hits.length
          ? hits.slice(0, 5).map((h) => `[${h.title || h.file || 'Заметка'}]\n${h.text || h.excerpt || ''}`).join('\n\n')
          : 'В заметках Obsidian по этому запросу совпадений нет.';
        return { ok: true, output: text };
      },
    });
  }

  if (!torQuarantined && typeof generateImage === 'function') {
    items.push({
      name: 'comfy_generate',
      connectorId: 'comfyui',
      icon: 'image',
      label: 'ComfyUI Генерация',
      description: 'Generate an AI raster image / artwork using local ComfyUI GPU workflow.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Detailed visual description of the image to generate.' },
        },
        required: ['prompt'],
      },
      async execute(args) {
        const res = await generateImage(args.prompt);
        const image = typeof res === 'object' ? res?.image : null;
        const reply = typeof res === 'string' ? res : (res?.reply || 'Изображение сгенерировано.');
        const outArtifacts = [];
        if (image && typeof registerArtifact === 'function') {
          const abs = res?.path || (typeof resolveGalleryFile === 'function' ? resolveGalleryFile(image) : null);
          if (abs) {
            const art = registerArtifact(abs, { target: 'ComfyUI' });
            if (art) outArtifacts.push(art);
          }
        }
        return {
          ok: true,
          output: reply,
          ...(image && { image }),
          ...(outArtifacts.length && { artifacts: outArtifacts }),
        };
      },
    });
  }

  if (terminal && typeof terminal.isAvailable === 'function' && terminal.isAvailable(ctx)) {
    items.push({
      name: 'terminal_run',
      kind: 'command',
      connectorId: 'terminal',
      icon: 'terminal',
      label: 'Терминал PowerShell',
      description: 'Run PowerShell commands on the PC with full developer workspace access (inspecting files/system, running node/python/npm/gradle/git/docker, creating or editing files). Destructive deletes, secrets access, package installs, and git push require user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'PowerShell command to execute.' },
          cwd: { type: 'string', description: 'Optional working directory (default D:\\Capri).' },
          timeout_sec: { type: 'integer', description: 'Timeout in seconds (default 30, max 120).' },
        },
        required: ['command'],
      },
      gate: (args, runCtx) => terminal.gate(args, runCtx),
      execute: (args, { signal }) => terminal.run(args, signal),
    });
  }

  if (typeof createDocument === 'function') {
    items.push({
      name: 'document_create',
      connectorId: 'libreoffice',
      icon: 'doc',
      label: 'Создание файла',
      description: 'Create a real file on disk (.docx, .pdf, .xlsx, .csv, .pptx, .svg, .png, .md, .txt, .py, .js, .html, .json) and attach it to the reply.',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['docx', 'pdf', 'xlsx', 'csv', 'pptx', 'svg', 'png', 'md', 'txt', 'py', 'js', 'html', 'json'], description: 'Output file format.' },
          title: { type: 'string', description: 'Short file title or slug.' },
          content: { type: 'string', description: 'Text, markdown, SVG, or code content.' },
          rows: { type: 'array', description: 'Optional 2D array of rows for xlsx/csv.' },
          slides: { type: 'array', description: 'Optional array of {title, bullets} for pptx.' },
        },
        required: ['format', 'title'],
      },
      async execute(args) {
        const res = await createDocument(args, { pcToolsEngine });
        if (!res?.ok) return { ok: false, output: res?.error || 'Не удалось создать файл.', error: res?.error || 'createDocument failed' };
        const art = res.path && typeof registerArtifact === 'function'
          ? registerArtifact(res.path, { target: args.title })
          : null;
        return {
          ok: true,
          output: res.output || `Файл создан: ${path.basename(res.path || '')}`,
          ...(art && { artifacts: [art] }),
        };
      },
    });
  }

  if (pcToolsEngine) {
    items.push({
      name: 'pc_tool_run',
      connectorId: 'pc-tools',
      icon: 'pc',
      label: 'Инструменты ПК',
      description: 'Run local PC tools: analyze data file, convert document (docx/pdf/xlsx), transcribe audio/video, upscale image, or search files with Kensaku.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['analyze', 'convert', 'transcribe', 'upscale', 'kensaku'], description: 'PC tool action.' },
          input: { type: 'string', description: 'File path or media URL.' },
          format: { type: 'string', description: 'Target format for convert (e.g. "pdf", "docx", "xlsx").' },
          query: { type: 'string', description: 'Query for analyze or kensaku.' },
        },
        required: ['action'],
      },
      async execute(args) {
        let res;
        if (args.action === 'analyze') res = await pcToolsEngine.analyzeData({ filePath: args.input, query: args.query || '' });
        else if (args.action === 'convert') res = await pcToolsEngine.convertDocument({ inputPath: args.input, targetFormat: args.format || 'pdf' });
        else if (args.action === 'transcribe') res = await pcToolsEngine.transcribeMedia({ source: args.input });
        else if (args.action === 'upscale') res = await pcToolsEngine.upscaleImage({ inputPath: args.input });
        else if (args.action === 'kensaku') res = await pcToolsEngine.searchKensaku({ query: args.query || args.input || '' });
        else return { ok: false, output: `Неизвестное действие pc_tool_run: ${args.action}`, error: 'Invalid action' };

        const outPath = res?.outputPath || res?.path;
        const art = outPath && typeof registerArtifact === 'function' ? registerArtifact(outPath, { target: args.action }) : null;
        return {
          ok: Boolean(res?.ok),
          output: res?.summary || res?.text || res?.message || (res?.results ? JSON.stringify(res.results.slice(0, 8)) : res?.error) || JSON.stringify(res),
          ...(res?.ok ? {} : { error: res?.error || 'PC tool error' }),
          ...(art && { artifacts: [art] }),
        };
      },
    });
  }

  if (phoneControlEngine) {
    items.push({
      name: 'phone_action',
      connectorId: 'phone-control',
      icon: 'phone',
      label: 'Телефон',
      description: 'Read Xiaomi phone status/health or queue an action (phone-health, phone-shizuku, phone-maps, phone-wger, phone-fmd, phone-termux, phone-fossify).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"status" to read phone state, or module action ("sync", "open", "navigate", "locate", "run", "dial", "sms").' },
          moduleId: { type: 'string', description: 'Module ID when queuing an action, e.g. "phone-health", "phone-termux".' },
          payload: { type: 'object', description: 'Optional payload, e.g. { command: "termux-battery-status" }.' },
        },
        required: ['action'],
      },
      async execute(args, execCtx = {}) {
        if (args.action === 'status' || !args.moduleId) {
          const st = phoneControlEngine.getStatus();
          return { ok: true, output: JSON.stringify({ online: st.online, device: st.deviceName, health: st.healthSummary }, null, 2) };
        }
        let res = phoneControlEngine.queueAction({ moduleId: args.moduleId, action: args.action, payload: args.payload || {} });
        if (res?.confirmRequired && askerFor(deps, ctx)) {
          const answer = await askerFor(deps, ctx)({
            line: res.error || `Подтвердить действие ${args.action} на телефоне?`,
            why: `${args.moduleId}: ${args.action}`,
            grantable: false,
          }, execCtx.signal);
          if (answer === 'yes') {
            res = phoneControlEngine.queueAction({ moduleId: args.moduleId, action: args.action, payload: args.payload || {}, confirmed: true });
          } else {
            return { ok: false, output: 'Пользователь отменил действие на телефоне.', error: 'Cancelled' };
          }
        }
        return {
          ok: Boolean(res?.ok),
          output: res?.message || res?.error || JSON.stringify(res),
          ...(res?.ok ? {} : { error: res?.error || 'Phone action error' }),
        };
      },
    });
  }

  if (connectorsEngine && typeof connectorsEngine.queryConnector === 'function') {
    const connectorEnum = Array.isArray(connectorsEngine.CONNECTOR_IDS) && connectorsEngine.CONNECTOR_IDS.length
      ? connectorsEngine.CONNECTOR_IDS
      : DEFAULT_CONNECTOR_IDS;
    items.push({
      name: 'connector_query',
      connectorId: 'capri-web',
      icon: 'attach',
      label: 'Коннектор',
      description: 'Query any connected integration by ID (proton-pim, opennotebook, nomad-kiwix, freshrss, freetube, libreoffice, home-server, health-connect, wger, google-workspace, youtube, github, context7, science-search, huggingface).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', enum: connectorEnum, description: 'Connector ID, e.g. "proton-pim", "nomad-kiwix", "freshrss", "opennotebook", "freetube".' },
          query: { type: 'string', description: 'Query or instruction for that connector.' },
        },
        required: ['id', 'query'],
      },
      async execute(args) {
        const rawId = String(args.id).trim();
        const resolvedId = typeof connectorsEngine.resolveConnectorAlias === 'function'
          ? (connectorsEngine.resolveConnectorAlias(rawId) || rawId)
          : rawId;
        const res = await connectorsEngine.queryConnector({
          id: resolvedId,
          query: String(args.query || ''),
          mode: ctx.mode || 'chat',
          ephemeral: Boolean(ctx.ephemeral),
          isCloud: false,
        });
        return {
          ok: Boolean(res?.ok),
          connectorId: resolvedId,
          icon: CONNECTOR_ICONS[resolvedId] || 'attach',
          output: res?.ok ? String(res.reply || '') : `Коннектор ${resolvedId} вернул ошибку: ${res?.error || 'недоступен'}`,
          ...(res?.ok ? {} : { error: res?.error || 'Connector error' }),
        };
      },
    });
  }

  return items;
}

class ToolHarness {
  constructor(deps = {}) {
    this.deps = deps;
  }

  getTools(ctx = {}) {
    return buildToolRegistry(this.deps, ctx);
  }

  getOllamaSchemas(ctx = {}) {
    return this.getTools(ctx).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async runLoop({
    messages,
    ctx = {},
    runTurn,
    onActivity = null,
    onDelta = null,
    onStreamReset = null,
    parseUseTag = null,
    stripUseTags = null,
    fallbackQuery = '',
    signal = null,
    maxSteps = DEFAULT_MAX_STEPS,
  }) {
    const registry = this.getTools(ctx);
    const byName = new Map(registry.map((t) => [t.name, t]));
    const schemas = registry.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const usedConnectors = Array.isArray(ctx.initialConnectors) ? [...ctx.initialConnectors] : [];
    const artifacts = { images: [], items: [], links: [] };
    const seenArtifactKeys = new Set();
    const pushArtifact = (art) => {
      if (!art || typeof art !== 'object') return;
      const key = art.id || art.url || art.name;
      if (!key || seenArtifactKeys.has(key)) return;
      seenArtifactKeys.add(key);
      artifacts.items.push(art);
    };

    let loopMessages = Array.isArray(messages) ? [...messages] : [];
    let lastTurn = null;
    let finalReply = '';
    let lastCallKey = '';
    let repeatCount = 0;
    let untrusted = Boolean(ctx.untrusted);
    const declined = new Set(); // calls Danyal refused in this turn

    for (let step = 0; step <= maxSteps; step += 1) {
      signal?.throwIfAborted();
      const canCallMore = step < maxSteps;
      let turnRes = await runTurn({
        messages: loopMessages,
        tools: canCallMore ? schemas : [],
        onDelta: typeof onDelta === 'function' ? onDelta : () => {},
        signal,
      });
      signal?.throwIfAborted();
      let text = String(turnRes?.text || '').trim();
      let toolCalls = Array.isArray(turnRes?.toolCalls) ? turnRes.toolCalls.filter((tc) => tc?.function?.name) : [];
      if (!text && toolCalls.length === 0) {
        onStreamReset?.();
        turnRes = await runTurn({
          messages: loopMessages,
          tools: canCallMore ? schemas : [],
          onDelta: typeof onDelta === 'function' ? onDelta : () => {},
          signal,
        });
        signal?.throwIfAborted();
        text = String(turnRes?.text || '').trim();
        toolCalls = Array.isArray(turnRes?.toolCalls) ? turnRes.toolCalls.filter((tc) => tc?.function?.name) : [];
      }
      lastTurn = turnRes;

      if (canCallMore && toolCalls.length > 0) {
        if (text) onStreamReset?.();
        loopMessages = [
          ...loopMessages,
          { role: 'assistant', content: text, tool_calls: toolCalls },
        ];
        for (let idx = 0; idx < toolCalls.length; idx += 1) {
          const tc = toolCalls[idx];
          const fnName = String(tc.function.name).trim();
          const toolDef = byName.get(fnName);
          const coerced = toolDef
            ? coerceToolArgs(toolDef.parameters, tc.function.arguments)
            : { ok: false, args: {}, error: `Неизвестный инструмент: ${fnName}` };
          const stepConnId = fnName === 'connector_query' && coerced.args?.id
            ? (this.deps.connectorsEngine?.resolveConnectorAlias?.(coerced.args.id) || String(coerced.args.id).trim())
            : (toolDef?.connectorId || fnName);
          const stepIcon = fnName === 'document_create'
            ? formatFormatIcon(coerced.args?.format)
            : (fnName === 'connector_query' ? (CONNECTOR_ICONS[stepConnId] || 'attach') : (toolDef?.icon || 'attach'));
          const detail = {
            tool: fnName,
            input: JSON.stringify(coerced.args || {}).slice(0, 200),
            ...(coerced.args?.command && { command: String(coerced.args.command).slice(0, 300) }),
            ...(coerced.args?.stackId && { target: `${resolveDockerHost(coerced.args.stackId, coerced.args.host)}:${coerced.args.stackId}` }),
            ...(coerced.args?.cwd && { target: String(coerced.args.cwd) }),
          };
          const activityItem = {
            id: `tool-${fnName}-${step}-${idx}`,
            kind: toolDef?.kind || 'tool',
            name: stepConnId,
            icon: stepIcon,
            label: toolDef?.label || fnName,
            detail,
          };
          onActivity?.({ ...activityItem, state: 'running' });

          const callKey = `${fnName}:${JSON.stringify(coerced.args || {})}`;
          if (callKey === lastCallKey) repeatCount += 1;
          else { lastCallKey = callKey; repeatCount = 1; }

          let execRes;
          if (repeatCount >= 3) {
            execRes = {
              ok: false,
              output: 'Этот же вызов с теми же аргументами повторился 3 раза подряд. Остановись и ответь пользователю по имеющимся данным.',
              error: 'Doom loop detected',
            };
          } else if (!toolDef) {
            execRes = { ok: false, output: `Инструмент "${fnName}" не зарегистрирован.`, error: 'Unknown tool' };
          } else if (!coerced.ok) {
            execRes = { ok: false, output: coerced.error, error: coerced.error };
          } else {
            let blockedByGate = false;
            if (typeof toolDef.gate === 'function') {
              const g = await toolDef.gate(coerced.args, { ...ctx, untrusted });
              if (g.decision === 'deny') {
                blockedByGate = true;
                execRes = { ok: false, output: `Запрещено политикой (${g.cls}): ${g.why}`, error: 'Policy denied' };
              } else if (g.decision === 'confirm') {
                // Danyal said no once: the same call in this turn is refused without a second window.
                let answer = 'no';
                if (!declined.has(callKey)) {
                  onActivity?.({ ...activityItem, state: 'awaiting' });
                  const asker = askerFor(this.deps, ctx);
                  answer = asker
                    ? await asker({ line: g.line, why: g.why, grantable: false }, signal)
                    : 'no';
                }
                if (answer !== 'yes') {
                  declined.add(callKey);
                  blockedByGate = true;
                  execRes = {
                    ok: false,
                    output: 'ОТКАЗАНО ПОЛЬЗОВАТЕЛЕМ: Даня сам нажал «нет» в окне подтверждения. Это не ошибка инструмента и не сбой. '
                      + 'Не повторяй это действие и не пытайся сделать то же другим путём (cmd, администратор, другая команда). '
                      + 'Прямо скажи, что он отказал, и спроси, что делать дальше.',
                    error: 'User declined',
                  };
                }
              }
            }
            if (!blockedByGate) {
              try {
                execRes = await toolDef.execute(coerced.args, { signal });
              } catch (err) {
                const msg = String(err?.message || err);
                execRes = { ok: false, output: `Ошибка выполнения ${fnName}: ${msg}`, error: msg };
              }
              // Only a call that brought something back can carry someone else's text into the turn.
              if (execRes?.ok && (!TRUSTED_OUTPUT_TOOLS.has(fnName) || (fnName === 'terminal_run' && readsNetwork(coerced.args?.command)))) {
                untrusted = true;
              }
            }
          }

          const finalConnId = execRes?.connectorId || stepConnId;
          const finalIcon = execRes?.icon || stepIcon;
          onActivity?.({
            ...activityItem,
            name: finalConnId,
            icon: finalIcon,
            state: execRes.ok ? 'done' : 'failed',
            detail: {
              ...detail,
              ...(Number.isInteger(execRes?.exitCode) && { exitCode: execRes.exitCode }),
              ...(execRes?.output && { output: String(execRes.output).slice(0, 1500) }),
            },
            ...(execRes.ok ? {} : { error: execRes.error || 'failed' }),
          });
          if (execRes.ok && finalConnId && !usedConnectors.includes(finalConnId)) {
            usedConnectors.push(finalConnId);
          }
          if (execRes.image) artifacts.images.push(execRes.image);
          if (Array.isArray(execRes.artifacts)) execRes.artifacts.forEach(pushArtifact);
          if (execRes.artifact) pushArtifact(execRes.artifact);
          if (Array.isArray(execRes.links)) artifacts.links.push(...execRes.links);

          const rawOut = boundToolOutput(execRes.output || (execRes.ok ? 'Выполнено.' : 'Ошибка.'));
          loopMessages.push({
            role: 'tool',
            tool_name: fnName,
            content: execRes.ok ? rawOut : `${ERROR_PREFIX}${rawOut}`,
          });
        }
        continue;
      }

      // Compatibility fallback if model outputs legacy `[[use:<id> <query>]]` instead of native tool_calls
      const useTag = canCallMore && typeof parseUseTag === 'function' ? parseUseTag(text) : null;
      if (useTag && byName.has('connector_query')) {
        onStreamReset?.();
        const stepQuery = useTag.query || fallbackQuery;
        const stepItem = {
          id: `tool-use-${useTag.id}-${step}`,
          kind: 'connector',
          name: useTag.id,
          icon: CONNECTOR_ICONS[useTag.id] || 'attach',
          detail: { input: stepQuery.slice(0, 200) },
        };
        onActivity?.({ ...stepItem, state: 'running' });
        const qTool = byName.get('connector_query');
        untrusted = true;
        const execRes = await qTool.execute({ id: useTag.id, query: stepQuery }, { signal }).catch((e) => ({
          ok: false,
          output: `Ошибка ${useTag.id}: ${e.message}`,
          error: e.message,
        }));
        onActivity?.({
          ...stepItem,
          state: execRes.ok ? 'done' : 'failed',
          ...(execRes.ok ? {} : { error: execRes.error }),
        });
        if (execRes.ok && !usedConnectors.includes(useTag.id)) usedConnectors.push(useTag.id);
        loopMessages = [
          ...loopMessages,
          { role: 'assistant', content: text },
          {
            role: 'user',
            content: `[Результат коннектора ${useTag.id}]\n${boundToolOutput(execRes.output)}\n\nДай чёткий ответ пользователю на русском без тега [[use:...]].`,
          },
        ];
        continue;
      }

      finalReply = typeof stripUseTags === 'function' ? stripUseTags(text) : text;
      break;
    }

    if (typeof this.deps.extractLinks === 'function' && finalReply) {
      const seenUrls = new Set(artifacts.links.map((l) => l.url));
      for (const link of this.deps.extractLinks(finalReply)) {
        if (link?.url && !seenUrls.has(link.url)) {
          seenUrls.add(link.url);
          artifacts.links.push(link);
        }
      }
    }

    return {
      text: finalReply,
      brain: lastTurn?.brain,
      context: lastTurn?.context,
      usage: lastTurn?.usage,
      connectors: usedConnectors,
      image: artifacts.images.at(-1) || null,
      images: artifacts.images,
      artifacts: artifacts.items,
      links: artifacts.links,
    };
  }
}

module.exports = { ToolHarness, buildToolRegistry, coerceToolArgs, boundToolOutput, CONNECTOR_ICONS, resolveDockerHost, normalizeDockerAction };
