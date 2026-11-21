'use strict';

// ALTAI:RE phone bridge (wire-compatible with Bridge.kt & GENESIS):
//   GET  /ping                    -> { ok, pose, sprites }
//   GET  /suggestions?mode=...    -> { mode, items: [{ title, prompt }], cachedAt } (E4B cached 45m)
//   POST /chat { text, voice, ephemeral?, mode?, skills?, tool? } -> { reply, brain, pose, audio?, image? }
//   POST /deep-research { query } -> { reply, workers, rector, obsidianPath? }
//   POST /event { kind }          -> { ok }
//   GET  /audio/<id>              -> mp3
//   GET  /sprites                 -> { pack, version, poses }
//   GET  /control / POST /control -> state

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { MAX_UPLOAD_BYTES } = require('./hub-artifacts');

const MAX_BODY = 64 * 1024;
const MAX_RESEARCH_REPORT_BYTES = 256 * 1024;
const AUDIO_TTL_MS = 10 * 60 * 1000;
const AUDIO_MAX = 20;
const TURNS = 12;
const { PHONE_MODEL_KEYS } = require('./phone-model');
const SUGGESTIONS_TTL_MS = 45 * 60 * 1000; // 45 минут кэша подсказок от E4B
const WORKER_COOLDOWN_MS = 30 * 60 * 1000; // 30 минут кулдауна для уставших воркеров Deep Research
const RESEARCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseModelCommand(text) {
  const t = String(text || '').trim();
  const ru = /^(?:переключись|переключи|смени|поставь|выбери|используй|включи|перейди|давай)(?:\s+модель)?(?:\s+на)?(?:\s+модель)?\s+(.+)$/i.exec(t);
  const en = /^(?:switch|change|use)(?:\s+model)?(?:\s+to)?\s+(.+)$/i.exec(t);
  return (ru?.[1] || en?.[1] || '').replace(/[.!?…]+$/, '').replace(/\s+(?:модель|model)$/i, '').trim() || null;
}

const newToken = () => crypto.randomBytes(18).toString('base64url');

function tokenMatches(got, want) {
  if (!want) return false;
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(got), h(want));
}

function addresses(port) {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  return [...new Set(ips)]
    .sort((a, b) => Number(!a.startsWith('100.')) - Number(!b.startsWith('100.')) || a.localeCompare(b))
    .map((ip) => `http://${ip}:${port}`);
}

const PHONE_NOTE = 'Канал: телефон (ALTAI:RE). Соразмеряй ответ с запросом: бытовая реплика коротко, сложная задача с нужными деталями. '
  + 'Ничего опасного на ПК самовольно не запускай без подтверждения.';

const SKILL_NOTES = {
  'i-have-adhd': 'Режим i-have-adhd: сначала дай конкретный следующий шаг, потом нумерованные пункты, без длинных вступлений и отвлечений.',
  'caveman': 'Режим caveman: отвечай максимально сжато, сразу с сути, без вежливых вступлений и итоговых повторов. Код, пути, команды и цифры оставляй дословно. Для предупреждений о необратимых действиях переходи на обычный ясный текст.',
};

const DEFAULT_SUGGESTIONS = {
  chat: [
    { title: 'Что горит по делам и календарю', prompt: 'Проверь мои ближайшие планы, календарь и важные заметки в памяти' },
    { title: 'Продолжить последнюю тему из чатов', prompt: 'Вспомни о чём мы говорили в последний раз и предложи следующий шаг' },
    { title: 'Быстрый разбор новой идеи', prompt: 'Разбери мою идею по полочкам: плюсы, риски и что проверить первым' },
  ],
  task: [
    { title: 'Разобрать свежий дифф и тесты проекта', prompt: 'Посмотри последние изменения в репозитории и подскажи, где могут быть баги' },
    { title: 'Собрать план закрытия задач по ALTA', prompt: 'Составь чёткий план действий на сегодня по приоритетам' },
    { title: 'Проверить логи и память за неделю', prompt: 'Подними свежие записи из памяти и выдели главное' },
  ],
  cloud: [
    { title: 'Архитектурное ревью текущего этапа', prompt: 'Проведи жёсткое архитектурное ревью моего текущего решения' },
    { title: 'Проверить свежие релизы и бенчмарки', prompt: 'Найди свежие релизы и сравнения моделей по моей задаче' },
    { title: 'Собрать ТЗ и промпт для агента', prompt: 'Помоги сформулировать точное ТЗ с критериями приёмки' },
  ],
  private: [
    { title: 'Поиск по изолированному Vault', prompt: 'Найди в моём изолированном Vault заметки по теме' },
    { title: 'Разобрать чувствительный вопрос локально', prompt: 'Разберём вопрос строго локально, без выхода в облако' },
    { title: 'Свести личные заметки в один план', prompt: 'Собери мои локальные заметки в структурированный список' },
  ],
  nsfw: [
    { title: 'Продолжить сцену с того же места', prompt: 'Продолжи нашу последнюю сцену, сохраняя характер и тон' },
    { title: 'Задать новый сеттинг и правила', prompt: 'Давай зададим новый сеттинг и персонажей для сцены' },
    { title: 'Свободный разговор без тормозов', prompt: 'Поболтаем свободно, без лишних ограничений' },
  ],
};

const CONTROL_KEYS = { voice: 'boolean', router: 'boolean', worker: 'string' };
function controlPatch(body) {
  if (!body || typeof body !== 'object') return null;
  for (const [k, v] of Object.entries(body)) if (typeof v !== CONTROL_KEYS[k]) return null;
  return body;
}

function mimeFor(name) {
  const ext = path.extname(name || '').toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.pdf': return 'application/pdf';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.md': return 'text/markdown; charset=utf-8';
    case '.csv': return 'text/csv; charset=utf-8';
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function parsePromptFlags(rawText, body = {}) {
  if ((body.mode !== undefined && (typeof body.mode !== 'string' || !Object.hasOwn(DEFAULT_SUGGESTIONS, body.mode)))
    || (body.ephemeral !== undefined && typeof body.ephemeral !== 'boolean')
    || (body.useVault !== undefined && typeof body.useVault !== 'boolean')) {
    throw Object.assign(new Error('Некорректный режим чата.'), { status: 400 });
  }
  let text = String(rawText || '');
  const skills = new Set(Array.isArray(body.skills) ? body.skills : []);
  let ephemeral = body.ephemeral === true;
  let privateMode = body.mode === 'private';
  let deepResearch = body.tool === 'deep_research';

  const stripTag = (tag, onMatch) => {
    if (text.includes(tag)) {
      onMatch();
      text = text.split(tag).join(' ').trim();
    }
  };
  stripTag('[VAULT_LOCAL_ONLY]', () => { privateMode = true; });
  stripTag('[NO_MEMORY]', () => { ephemeral = true; });
  stripTag('[SKILL:i-have-adhd]', () => { skills.add('i-have-adhd'); });
  stripTag('[SKILL:caveman]', () => { skills.add('caveman'); });
  stripTag('[DEEP_RESEARCH]', () => { deepResearch = true; });

  return {
    text: text.trim(),
    ephemeral,
    privateMode,
    deepResearch,
    skills: [...skills],
    ...(body.mode === 'nsfw' && { localMode: 'nsfw', localOnly: true }),
    ...(body.mode === 'task' && { localMode: 'task' }),
    ...(body.useVault === false && { useVault: false }),
  };
}

class PhoneBridge {
  constructor(deps) {
    this.d = deps;
    this.server = null;
    this.audio = new Map();
    this.turns = [];
    this.suggestionsCache = new Map(); // mode -> { items, cachedAt }
    this.workerCooldowns = new Map(); // workerId -> untilMs
    this.researchRequests = new Map();
    this.earlyResearchStops = new Map();
    this.queue = Promise.resolve();
    this.chatRequests = new Map();
  }

  get running() {
    return Boolean(this.server?.listening);
  }

  start(port, host = '0.0.0.0') {
    if (this.server) return Promise.resolve(this.server.address().port);
    const server = http.createServer((req, res) => { this.handle(req, res); });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        this.server = server;
        resolve(server.address().port);
      });
    });
  }

  stop() {
    const s = this.server;
    this.server = null;
    this.audio.clear();
    if (!s) return Promise.resolve();
    return new Promise((r) => { s.closeAllConnections(); s.close(() => r()); });
  }

  send(res, code, body) {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
    res.end(buf);
  }

  readJson(req, limit = MAX_BODY) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error('too large'), { status: 413 }));
          chunks.length = 0;
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (size > limit) return;
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        } catch {
          reject(Object.assign(new Error('bad json'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  pruneAudio(now = Date.now()) {
    for (const [k, v] of this.audio) if (now - v.at > AUDIO_TTL_MS) this.audio.delete(k);
    while (this.audio.size > AUDIO_MAX) this.audio.delete(this.audio.keys().next().value);
  }

  async getSuggestions(mode = 'chat', force = false) {
    const m = DEFAULT_SUGGESTIONS[mode] ? mode : 'chat';
    const cached = this.suggestionsCache.get(m);
    const now = Date.now();
    if (!force && cached && (now - cached.cachedAt) < SUGGESTIONS_TTL_MS) {
      return { mode: m, items: cached.items, cachedAt: cached.cachedAt, cached: true };
    }

    let items = null;
    if (typeof this.d.suggestions === 'function') {
      try {
        const res = await this.d.suggestions(m);
        if (Array.isArray(res) && res.length >= 3) items = res.slice(0, 3);
      } catch {}
    } else if (typeof this.d.chat === 'function') {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 12000);
      try {
        const prompt = `Сгенерируй ровно 3 короткие стартовые подсказки (до 6 слов в заголовке) для режима "${m}" ассистента ALTAI:RE. `
          + 'Верни строго JSON-массив вида [{"title":"...","prompt":"..."}] без пояснений.';
        const { text } = await this.d.chat([
          { role: 'system', content: 'Ты генератор коротких UI-подсказок. Отвечай только валидным JSON-массивом.' },
          { role: 'user', content: prompt },
        ], abort.signal, { fastLocal: true, ephemeral: true });
        const jsonMatch = /\[[\s\S]*\]/.exec(String(text || ''));
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const valid = parsed.filter((x) => x && x.title && x.prompt).slice(0, 3);
          if (valid.length === 3) items = valid;
        }
      } catch {} finally {
        clearTimeout(timer);
      }
    }

    const finalItems = items || DEFAULT_SUGGESTIONS[m];
    const entry = { mode: m, items: finalItems, cachedAt: now, cached: false };
    this.suggestionsCache.set(m, entry);
    return entry;
  }

  async runDeepResearch(query, opts = {}) {
    const { signal } = opts;
    signal?.throwIfAborted();
    const q = String(query || '').trim();
    if (!q) throw new Error('empty query');
    if (opts.privateMode || opts.ephemeral || opts.localOnly || this.d.externalBlocked?.(q)) {
      throw Object.assign(new Error('Облачный Deep Research недоступен в этом режиме.'), { status: 403 });
    }
    if (typeof this.d.deepResearch === 'function') {
      return await this.d.deepResearch({ query: q, ...opts });
    }

    const sendResearch = async (request, readReport = false) => {
      signal?.throwIfAborted();
      if (this.d.externalBlocked?.(q)) throw new Error('Облачный Deep Research остановлен.');
      const stop = () => { void Promise.resolve().then(() => this.d.agentStop?.(request.id)).catch(() => {}); };
      signal?.addEventListener('abort', stop, { once: true });
      let response;
      try {
        response = await this.d.agentSend({ ...request, signal });
      } finally {
        signal?.removeEventListener('abort', stop);
      }
      signal?.throwIfAborted();
      if (response?.ok === false) throw new Error(response.error || 'Воркер не ответил');
      if (response?.text || response?.reply) return String(response.text || response.reply).trim();
      if (!response?.ok) return '';
      const history = await this.d.agentHistory?.(request.id);
      const answer = history?.at(-1);
      if (answer?.role !== 'assistant') return '';
      if (readReport && this.d.agentArtifact) {
        const markdown = answer.artifacts?.filter((item) => /\.md$/i.test(item.name));
        if (markdown?.length === 1) {
          try {
            const file = await this.d.agentArtifact({ id: request.id, ...markdown[0] });
            if (file && (await fs.promises.stat(file)).size <= MAX_RESEARCH_REPORT_BYTES) {
              const report = (await fs.promises.readFile(file, 'utf8')).trim();
              if (report) return report;
            }
          } catch { /* Keep the worker's message if its artifact is unavailable. */ }
        }
      }
      return String(answer.content || '').trim();
    };

    // Встроенный оркестратор «Совет выживших» поверх живых облачных агентов (models: { claude, codex, gemini })
    const now = Date.now();
    const agentsRes = await this.d.agentsList?.().catch(() => ({}));
    signal?.throwIfAborted();
    const rawAgents = [];
    if (Array.isArray(agentsRes?.agents)) {
      rawAgents.push(...agentsRes.agents);
    } else if (agentsRes?.models && typeof agentsRes.models === 'object') {
      for (const id of ['claude', 'codex', 'gemini']) {
        const list = agentsRes.models[id];
        if (Array.isArray(list) && list.length) {
          rawAgents.push({ id, defaultModel: Array.isArray(list[0]) ? list[0][0] : String(list[0] || '') });
        }
      }
    }
    const liveWorkers = rawAgents.filter((a) => {
      const id = String(a?.id || a?.name || '');
      if (!id) return false;
      const until = this.workerCooldowns.get(id) || 0;
      return now >= until;
    });

    if (!liveWorkers.length || typeof this.d.agentCreate !== 'function' || typeof this.d.agentSend !== 'function') {
      throw Object.assign(new Error('Сейчас нет доступных облачных воркеров.'), { status: 503 });
    }

    // Параллельный опрос всех живых воркеров
    const workerResults = await Promise.all(liveWorkers.map(async (w) => {
      const id = String(w.id || w.name);
      const model = String(w.defaultModel || w.model || '');
      try {
        const sid = await this.d.agentCreate(id);
        const out = await sendResearch({
          id: sid,
          model,
          text: `Deep Research (независимый доклад по теме, с источниками и проверкой фактов):\n${q}`,
          retry: false,
        });
        if (!out) return null;
        return { id, model, text: out };
      } catch (error) {
        if (/лимит|rate\s*limit|quota/i.test(error.message)) this.workerCooldowns.set(id, Date.now() + WORKER_COOLDOWN_MS);
        return null;
      }
    }));

    const okWorkers = workerResults.filter(Boolean);
    signal?.throwIfAborted();
    if (!okWorkers.length) {
      throw Object.assign(new Error('Ни один облачный воркер не вернул доклад.'), { status: 503 });
    }

    // Иерархия Ректора: Astra -> Claude Opus -> Antigravity Neon -> Web Gemini Neon -> первый живой
    const rectorPriority = ['astra', 'claude', 'antigravity', 'gemini'];
    const rector = rectorPriority
      .map((p) => okWorkers.find((w) => w.id.toLowerCase().includes(p)))
      .find(Boolean) || okWorkers[0];

    const synthesisPrompt = [
      `Тема Deep Research: ${q}`,
      '',
      'Доклады совета агентов:',
      ...okWorkers.map((w) => `### ${w.id}\n${w.text}`),
      '',
      'Верни полный проверенный отчёт прямо в ответе в Markdown. Выдели подтверждённые факты, расхождения и выводы.',
    ].join('\n');

    let finalReport = '';
    try {
      const sid = await this.d.agentCreate(rector.id);
      finalReport = await sendResearch({ id: sid, model: rector.model, text: synthesisPrompt, retry: false }, true);
    } catch {}
    if (!finalReport) {
      finalReport = okWorkers.map((w) => `## ${w.id}\n${w.text}`).join('\n\n');
    }

    // Попытка сохранить в Obsidian через deps, если подключено
    signal?.throwIfAborted();
    let obsidianSaved = false;
    if (typeof this.d.saveObsidianResearch === 'function') {
      obsidianSaved = await this.d.saveObsidianResearch({ query: q, markdown: finalReport }).catch(() => false);
    }

    return {
      reply: finalReport,
      brain: `deep_research:${rector.id}`,
      workers: okWorkers.map((w) => w.id),
      rector: rector.id,
      obsidianSaved,
    };
  }

  async handle(req, res) {
    const url = new URL(req.url || '/', 'http://bridge');
    const got = String(req.headers['x-capri-token'] ?? url.searchParams.get('token') ?? '');
    if (!tokenMatches(got, this.d.token())) return this.send(res, 401, { error: 'bad token' });
    try {
      const pack = this.d.sprites?.() || null;
      if (req.method === 'GET' && url.pathname === '/ping') return this.send(res, 200, { ok: true, pose: '', sprites: pack?.version || '', isolatedChat: true, modelSelection: true });
      if (req.method === 'GET' && url.pathname === '/suggestions') {
        const mode = url.searchParams.get('mode') || 'chat';
        const force = url.searchParams.get('refresh') === 'true';
        return this.send(res, 200, await this.getSuggestions(mode, force));
      }
      if (req.method === 'GET' && url.pathname === '/sprites') {
        return this.send(res, 200, { pack: pack?.pack || 'capri_pc', version: pack?.version || '', poses: pack?.poses || [] });
      }
      if (req.method === 'GET' && url.pathname === '/sprites/pack.zip') {
        if (!pack) return this.send(res, 404, { error: 'no sprites' });
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': pack.zip.length });
        return res.end(pack.zip);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/gallery/')) {
        const name = decodeURIComponent(url.pathname.slice('/gallery/'.length));
        const file = this.d.galleryFile?.(name);
        if (!file) return this.send(res, 404, { error: 'no picture' });
        res.writeHead(200, { 'content-type': /\.webm$/i.test(name) ? 'video/webm' : 'image/png', 'content-length': file.length });
        return res.end(file);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
        this.pruneAudio();
        const a = this.audio.get(url.pathname.slice('/audio/'.length));
        if (!a) return this.send(res, 404, { error: 'no audio' });
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': a.data.byteLength });
        return res.end(Buffer.from(a.data));
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        const s = await this.d.status?.();
        return this.send(res, 200, s || {});
      }
      if (req.method === 'POST' && url.pathname === '/free-vram') {
        const r = await this.d.freeVram?.();
        return this.send(res, 200, r || { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/clipboard') {
        const text = await this.d.getClipboard?.();
        return this.send(res, 200, { text: String(text || '') });
      }
      if (req.method === 'POST' && url.pathname === '/clipboard') {
        const body = await this.readJson(req);
        await this.d.setClipboard?.(String(body.text ?? '').slice(0, 20000));
        return this.send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/control') return this.send(res, 200, this.d.control());
      if (req.method === 'POST' && url.pathname === '/control') {
        const patch = controlPatch(await this.readJson(req));
        if (!patch) return this.send(res, 400, { error: 'not allowed from the phone' });
        return this.send(res, 200, this.d.applyControl(patch));
      }
      if (req.method === 'POST' && url.pathname === '/event') {
        const kind = String((await this.readJson(req)).kind ?? '').trim();
        if (/^[a-z_]{1,32}$/.test(kind)) this.d.event(kind);
        return this.send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/tool') {
        const body = await this.readJson(req);
        if (!['search', 'pim'].includes(body.tool) || typeof body.text !== 'string' ||
            !body.text.trim() || body.text.length > 4000) {
          return this.send(res, 400, { error: 'Неверный инструмент или текст запроса.' });
        }
        const flags = parsePromptFlags(body.text, body);
        if (!flags.text) return this.send(res, 400, { error: 'Введите запрос.' });
        if (flags.ephemeral || flags.privateMode || flags.localOnly || flags.deepResearch || this.d.externalBlocked?.(flags.text)) {
          return this.send(res, 403, { error: 'Инструмент недоступен для этого запроса.' });
        }
        if (body.tool === 'search') {
          const result = await this.turn({ ...flags, text: `найди в сети: ${flags.text}` }, false);
          return this.send(res, result.brain === 'error' ? 503 : 200, result.brain === 'error' ? { error: result.reply } : result);
        }
        if (!this.d.readPim) return this.send(res, 503, { error: 'Почта и календарь недоступны.' });
        return this.send(res, 200, await this.d.readPim(flags.text));
      }
      if (req.method === 'POST' && url.pathname === '/deep-research/stop') {
        const { requestId } = await this.readJson(req);
        if (typeof requestId !== 'string' || !RESEARCH_ID.test(requestId)) {
          return this.send(res, 400, { error: 'Неверный идентификатор исследования.' });
        }
        const active = this.researchRequests.get(requestId);
        if (active) {
          active.abort();
        } else {
          const now = Date.now();
          for (const [id, expires] of this.earlyResearchStops) {
            if (expires <= now) this.earlyResearchStops.delete(id);
          }
          if (this.earlyResearchStops.size >= 64) {
            this.earlyResearchStops.delete(this.earlyResearchStops.keys().next().value);
          }
          this.earlyResearchStops.set(requestId, now + 15_000);
        }
        return this.send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/deep-research') {
        const body = await this.readJson(req);
        const flags = parsePromptFlags(String(body.query ?? body.text ?? '').slice(0, 4000), body);
        const { requestId } = body;
        if (requestId !== undefined && (typeof requestId !== 'string' || !RESEARCH_ID.test(requestId))) {
          return this.send(res, 400, { error: 'Неверный идентификатор исследования.' });
        }
        if (this.researchRequests.has(requestId)) return this.send(res, 409, { error: 'Исследование уже выполняется.' });
        if (requestId) {
          const expires = this.earlyResearchStops.get(requestId);
          this.earlyResearchStops.delete(requestId);
          if (expires > Date.now()) return this.send(res, 200, { stopped: true });
        }
        const abort = new AbortController();
        if (requestId) this.researchRequests.set(requestId, abort);
        const disconnect = () => { if (!res.writableEnded) abort.abort(); };
        res.once('close', disconnect);
        if (res.destroyed) disconnect();
        try {
          const result = await this.runDeepResearch(flags.text, { ...flags, signal: abort.signal });
          if (!res.destroyed) return this.send(res, 200, abort.signal.aborted ? { stopped: true } : result);
        } catch (error) {
          if (!abort.signal.aborted) throw error;
          if (!res.destroyed) return this.send(res, 200, { stopped: true });
        } finally {
          res.off('close', disconnect);
          if (requestId) this.researchRequests.delete(requestId);
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/chat') {
        const body = await this.readJson(req, MAX_BODY + Math.ceil(MAX_UPLOAD_BYTES / 3) * 4);
        if (body.text != null && typeof body.text !== 'string') return this.send(res, 400, { error: 'Некорректный текст сообщения.' });
        const rawText = (body.text ?? '').replace(/\u0000/g, '').trim();
        if (rawText.length > 24000) return this.send(res, 400, { error: 'Сообщение длиннее 24 000 символов.' });
        const images = Array.isArray(body.files)
          ? body.files.filter((f) => f && String(f.mime || '').startsWith('image/') && f.data).map((f) => String(f.data)).slice(0, 4)
          : [];
        if (!rawText && !images.length) return this.send(res, 400, { error: 'empty' });
        const imagePrompt = images.length > 1
          ? 'Кратко опиши каждое прикреплённое изображение по порядку.'
          : 'Кратко опиши прикреплённое изображение.';
        const flags = parsePromptFlags(rawText, body);
        if (body.model !== undefined && !PHONE_MODEL_KEYS.includes(body.model)) {
          return this.send(res, 400, { error: 'Выбранная модель недоступна на ПК.' });
        }
        flags.requestedModel = body.model;
        if (body.history !== undefined) {
          if (!Array.isArray(body.history) || body.history.length > TURNS * 2 || body.history.some((row) =>
            !row || !['user', 'assistant'].includes(row.role) || typeof row.content !== 'string' || row.content.length > 4000)) {
            return this.send(res, 400, { error: 'Некорректная история разговора.' });
          }
          flags.history = body.history.map(({ role, content }) => ({ role, content }));
        }
        flags.images = images;
        if (!flags.text && !images.length) return this.send(res, 400, { error: 'empty' });
        if (!flags.text) flags.text = imagePrompt;
        const requestId = body.requestId;
        if (requestId !== undefined && (typeof requestId !== 'string' || !RESEARCH_ID.test(requestId))) {
          return this.send(res, 400, { error: 'Некорректный идентификатор сообщения.' });
        }
        const canRetry = requestId && !flags.ephemeral && !flags.privateMode && !flags.localOnly;
        if (canRetry) {
          for (const [id, result] of this.chatRequests) {
            if (result.expires !== null && result.expires <= Date.now()) this.chatRequests.delete(id);
          }
          if (this.chatRequests.has(requestId)) {
            return this.send(res, 200, await this.chatRequests.get(requestId).result);
          }
          if (this.chatRequests.size >= 64) {
            const finished = [...this.chatRequests].find(([, entry]) => entry.expires !== null);
            if (!finished) return this.send(res, 503, { error: 'ПК занят. Повтори отправку позже.' });
            this.chatRequests.delete(finished[0]);
          }
        }
        const turn = this.queue.catch(() => {}).then(() => {
          if (body.reset === true && flags.history === undefined && !flags.ephemeral && !flags.privateMode) this.turns = [];
          return this.turn(flags, body.voice === true);
        });
        this.queue = turn;
        if (canRetry) {
          this.chatRequests.set(requestId, { expires: null, result: turn });
        }
        try {
          const result = await turn;
          if (canRetry) {
            if (result.brain === 'error') this.chatRequests.delete(requestId);
            else this.chatRequests.get(requestId).expires = Date.now() + 20 * 60 * 1000;
          }
          return this.send(res, 200, result);
        } catch (err) {
          this.chatRequests.delete(requestId);
          throw err;
        }
      }
      if (req.method === 'GET' && url.pathname === '/agents') {
        const data = await this.d.agentsList?.();
        return this.send(res, 200, data || { agents: [] });
      }
      if (req.method === 'GET' && url.pathname === '/agents/sessions') {
        const agent = url.searchParams.get('agent') || '';
        const list = await this.d.agentSessions?.(agent);
        return this.send(res, 200, list || []);
      }
      if (req.method === 'POST' && url.pathname === '/agents/sessions') {
        const body = await this.readJson(req);
        const id = await this.d.agentCreate?.(body.agent);
        return this.send(res, 200, { id });
      }
      if (req.method === 'GET' && url.pathname === '/agents/session') {
        const id = url.searchParams.get('id') || '';
        const history = await this.d.agentHistory?.(id);
        return this.send(res, 200, { id, messages: history || [] });
      }
      if (req.method === 'POST' && url.pathname === '/agents/send') {
        const body = await this.readJson(req, MAX_BODY + Math.ceil(MAX_UPLOAD_BYTES / 3) * 4);
        const result = await this.d.agentSend?.(body);
        return this.send(res, 200, result || { ok: false });
      }
      if (req.method === 'POST' && url.pathname === '/agents/stop') {
        const body = await this.readJson(req);
        await this.d.agentStop?.(body.id);
        return this.send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/agents/quota') {
        const agent = url.searchParams.get('agent') || '';
        const model = url.searchParams.get('model') || '';
        const refresh = url.searchParams.get('refresh') === 'true';
        const q = await this.d.agentQuota?.({ agent, model, refresh });
        return this.send(res, 200, q || {});
      }
      if (req.method === 'POST' && url.pathname === '/agents/artifact') {
        const body = await this.readJson(req);
        const result = await this.d.agentArtifactAction?.(body);
        return this.send(res, 200, result || { ok: false });
      }
      if (req.method === 'GET' && url.pathname === '/agents/artifact') {
        const id = url.searchParams.get('id') || '';
        const run = url.searchParams.get('run') || '';
        const name = url.searchParams.get('name') || '';
        const file = await this.d.agentArtifact?.({ id, run, name });
        if (!file || !fs.existsSync(file)) return this.send(res, 404, { error: 'file not found' });
        const buf = fs.readFileSync(file);
        res.writeHead(200, { 'content-type': mimeFor(name), 'content-length': buf.length });
        return res.end(buf);
      }
      return this.send(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err.status || 400;
      if (status >= 500) console.warn('[altair] phone bridge:', err.message);
      if (!res.headersSent) this.send(res, status, { error: err.message || 'error' });
    }
  }

  async media(text, kind, opts = {}) {
    try {
      const said = await this.d.photo(text, kind, opts.ephemeral ? [] : (opts.history ?? this.turns).slice(-4));
      const m = /\[\[photo:([\w.-]+\.(?:png|webm))\]\]/.exec(said);
      const reply = said.replace(/\[\[photo:[^\]]*\]\]/g, '').trim() || 'Держи.';
      if (!opts.ephemeral && opts.history === undefined) this.turns.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      return { reply, brain: 'comfyui', image: m?.[1] || null };
    } catch (err) {
      return { reply: `Не вышло скинуть: ${err.message}`, brain: 'error' };
    }
  }

  async switchModel(text) {
    const wanted = parseModelCommand(text);
    if (!wanted || !this.d.switchModel) return null;
    const r = await this.d.switchModel(wanted).catch(() => null);
    return r?.ok ? { reply: `Переключилась на ${r.model}.`, brain: r.model } : null;
  }

  async reply(flags, signal) {
    const { text, ephemeral, privateMode, deepResearch, skills } = flags;
    const isolated = ephemeral || privateMode || flags.localOnly === true;
    if (/^новый разговор/i.test(text)) {
      if (!isolated && flags.history === undefined) this.turns = [];
      return { reply: 'Начинаем с чистого листа.', brain: 'altair' };
    }
    if (deepResearch) {
      try {
        const res = await this.runDeepResearch(text, flags);
      if (flags.history === undefined) this.turns.push({ role: 'user', content: text }, { role: 'assistant', content: res.reply });
        return { reply: res.reply, brain: res.brain };
      } catch (err) {
        return { reply: `Deep Research не прошёл: ${err.message}`, brain: 'error' };
      }
    }

    const sysParts = [this.d.persona(), PHONE_NOTE];
    sysParts.push('Поддерживай тему текущего диалога. Не упоминай личные факты, числа, расписание и технические детали из памяти без прямой связи с вопросом. Если данных не хватает, скажи об этом.');
    if (ephemeral) sysParts.push('Временный чат: не ссылайся на долговременную память и не сохраняй факты.');
    if (privateMode) sysParts.push('Режим Приват (Vault): строго локальная обработка, данные и контекст только из Vault, выход в облако запрещён.');
    for (const sk of skills) {
      if (SKILL_NOTES[sk]) sysParts.push(SKILL_NOTES[sk]);
    }

    const historySlice = flags.history ?? (isolated ? [] : this.turns.slice(-TURNS * 2));
    const userMsg = { role: 'user', content: text, ...(flags.images?.length ? { images: flags.images } : {}) };
    const messages = [
      { role: 'system', content: sysParts.filter(Boolean).join('\n') },
      ...historySlice,
      userMsg,
    ];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 120000);
    try {
      const opts = {
        ephemeral,
        localOnly: isolated,
        source: privateMode ? 'vault' : undefined,
        skills,
        requestedModel: flags.requestedModel,
        useVault: flags.useVault !== false,
        mobile: true,
        ...(flags.requireVision && { requireVision: true }),
        ...(flags.localMode && { localMode: flags.localMode }),
      };
      const requestSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      const { text: said, brain } = await this.d.chat(messages, requestSignal, opts);
      const reply = String(said || '').trim();
      if (!reply) return { reply: 'Модель промолчала. Спроси ещё раз, покороче.', brain };
      if (!isolated && flags.history === undefined) {
        this.turns.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      }
      return { reply, brain };
    } catch (err) {
      return { reply: `Не вышло ответить: ${err.message}`, brain: 'error' };
    } finally {
      clearTimeout(timer);
    }
  }

  async turn(flags, voice, signal) {
    const text = flags.text;
    const isolated = flags.ephemeral || flags.privateMode || flags.localOnly === true;
    const search = /^найди в сети:\s*([\s\S]+)$/i.exec(text)?.[1].trim();
    if (search && !flags.deepResearch) {
      if (isolated || this.d.externalBlocked?.(search)) {
        return { reply: 'Обычный веб-поиск недоступен в этом режиме.', brain: 'error', pose: '' };
      }
      try {
        const found = await this.d.webSearch?.(search);
        if (!found) throw new Error('browser unavailable');
        const links = (found.results || []).slice(0, 3).map((item) => `${item.title || item.url} — ${item.url}`);
        return { reply: links.join('\n\n') || 'По этому запросу в браузере ничего не нашлось.', brain: 'web', pose: '' };
      } catch {
        return { reply: 'Браузерный поиск сейчас недоступен. Результатов нет.', brain: 'error', pose: '' };
      }
    }
    const media = !isolated && !flags.deepResearch && this.d.photo && this.d.mediaKind?.(text);
    const { reply, brain, image } = media ? await this.media(text, media, flags)
      : (!isolated && !flags.deepResearch && (!flags.requestedModel || flags.requestedModel === 'auto') && await this.switchModel(text))
        || await this.reply(flags, signal);

    // Временные чаты (ephemeral) и приватный Vault (privateMode) не утекают в общий лог чатов
    if (brain !== 'error' && !isolated && flags.history === undefined && !/^новый разговор/i.test(text)) {
      this.d.log?.({ said: text, answer: image ? `${reply}\n[[photo:${image}]]` : reply });
    }
    const out = { reply, brain, pose: '', ...(image && { image: `/gallery/${image}` }) };
    if (voice && brain !== 'error') {
      const data = await this.d.speak(reply).catch(() => null);
      if (data) {
        const id = `${crypto.randomUUID().replace(/-/g, '')}.mp3`;
        this.audio.set(id, { data, at: Date.now() });
        this.pruneAudio();
        out.audio = `/audio/${id}`;
      }
    }
    return out;
  }
}

module.exports = {
  PhoneBridge,
  newToken,
  tokenMatches,
  addresses,
  controlPatch,
  parseModelCommand,
  parsePromptFlags,
  DEFAULT_SUGGESTIONS,
};
