'use strict';

// The phone bridge: the Android client (denilql5615-dot/capri-android, Bridge.kt) reaches her over the home
// network or Tailscale, with the wire contract GENESIS had, so the phone app works as it is:
//   GET  /ping                 -> { ok, pose, sprites }
//   POST /chat  { text, voice } -> { reply, brain, pose, audio? }   (audio = "/audio/<id>", fetched with ?token=)
//   POST /event { kind }        -> { ok }                         (pet, poke, shake, back: she reacts on the PC)
//   GET  /audio/<id>            -> her reply, said (mp3)
//   GET  /sprites               -> { pack, version, poses }        (none: the phone keeps its own rig)
//   GET  /control               -> the phone remote's state   POST /control { voice? } -> the same (whitelist)
// Every request needs the token (X-Capri-Token header or ?token=). From the phone it's talk only: nothing runs
// on the PC, Claude and Codex included. Her voice is kept in memory a few minutes, never on disk.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { MAX_UPLOAD_BYTES } = require('./hub-artifacts');

const MAX_BODY = 64 * 1024;
const AUDIO_TTL_MS = 10 * 60 * 1000;
const AUDIO_MAX = 20;
const TURNS = 12; // her phone conversation: the last few exchanges

// "переключись на ролевую", "смени модель на основную", "use qwen3": the model asked for (listen.js has the same)
function parseModelCommand(text) {
  const t = String(text || '').trim();
  const ru = /^(?:переключись|переключи|смени|поставь|выбери|используй|включи|перейди|давай)(?:\s+модель)?(?:\s+на)?(?:\s+модель)?\s+(.+)$/i.exec(t);
  const en = /^(?:switch|change|use)(?:\s+model)?(?:\s+to)?\s+(.+)$/i.exec(t);
  return (ru?.[1] || en?.[1] || '').replace(/[.!?…]+$/, '').replace(/\s+(?:модель|model)$/i, '').trim() || null;
}

const newToken = () => crypto.randomBytes(18).toString('base64url');

/** Constant-time token check (hashed first, so the length doesn't leak either). */
function tokenMatches(got, want) {
  if (!want) return false;
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(got), h(want));
}

/** This PC's addresses for the phone: Tailscale (100.x) first, then the home network. */
function addresses(port) {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  return [...new Set(ips)]
    .sort((a, b) => Number(!a.startsWith('100.')) - Number(!b.startsWith('100.')) || a.localeCompare(b))
    .map((ip) => `http://${ip}:${port}`);
}

const PHONE_NOTE = 'Канал: телефон. С телефона ты только разговариваешь: ничего на компьютере не открываешь и не запускаешь, '
  + 'Claude и Codex отсюда не зовёшь. Просят что-то сделать на ПК: скажи, что это можно за компьютером.';

// what the phone remote may switch: deliberately short, nothing that widens what she may do on this PC
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

class PhoneBridge {
  // deps: { token(), chat(messages, signal) -> text, speak(text) -> Uint8Array|null, event(kind), persona() -> string,
  //         control() -> state, applyControl(patch) -> state }
  constructor(deps) {
    this.d = deps;
    this.server = null;
    this.audio = new Map();
    this.turns = [];
    this.queue = Promise.resolve(); // one phone turn at a time
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

  async handle(req, res) {
    const url = new URL(req.url || '/', 'http://bridge');
    const got = String(req.headers['x-capri-token'] ?? url.searchParams.get('token') ?? '');
    if (!tokenMatches(got, this.d.token())) return this.send(res, 401, { error: 'bad token' });
    try {
      // her moves as a pack of frames (main.js phonepack.js); none drawn yet: the phone keeps its ragdoll
      const pack = this.d.sprites?.() || null;
      if (req.method === 'GET' && url.pathname === '/ping') return this.send(res, 200, { ok: true, pose: '', sprites: pack?.version || '' });
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
      if (req.method === 'POST' && url.pathname === '/chat') {
        const body = await this.readJson(req);
        const text = String(body.text ?? '').replace(/\u0000/g, '').trim().slice(0, 4000);
        if (!text) return this.send(res, 400, { error: 'empty' });
        this.queue = this.queue.catch(() => {}).then(() => this.turn(text, body.voice === true));
        return this.send(res, 200, await this.queue);
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
      if (status >= 500) console.warn('[capri] phone bridge:', err.message);
      if (!res.headersSent) this.send(res, status, { error: err.message || 'error' });
    }
  }

  async media(text, kind) {
    try {
      const said = await this.d.photo(text, kind, this.turns.slice(-4));
      const m = /\[\[photo:([\w.-]+\.(?:png|webm))\]\]/.exec(said);
      const reply = said.replace(/\[\[photo:[^\]]*\]\]/g, '').trim() || 'Держи.';
      this.turns.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      return { reply, brain: 'comfyui', image: m?.[1] || null };
    } catch (err) {
      return { reply: `Не вышло скинуть: ${err.message}`, brain: 'error' };
    }
  }

  // "переключись на ролевую", "поставь основную": her chat model switched, here and on the PC alike. A
  // phrase that names no model on this PC ("включи музыку") isn't one: null, she answers it as usual.
  async switchModel(text) {
    const wanted = parseModelCommand(text);
    if (!wanted || !this.d.switchModel) return null;
    const r = await this.d.switchModel(wanted).catch(() => null);
    return r?.ok ? { reply: `Переключилась на ${r.model}.`, brain: r.model } : null;
  }

  async reply(text) {
    if (/^новый разговор/i.test(text)) {
      this.turns = [];
      return { reply: 'Начинаем с чистого листа.', brain: 'capri' };
    }
    const messages = [
      { role: 'system', content: `${this.d.persona()}\n${PHONE_NOTE}` },
      ...this.turns.slice(-TURNS * 2),
      { role: 'user', content: text },
    ];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 120000);
    try {
      const { text: said, brain } = await this.d.chat(messages, abort.signal);
      const reply = String(said || '').trim();
      if (!reply) return { reply: 'Модель промолчала. Спроси ещё раз, покороче.', brain };
      this.turns.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      return { reply, brain };
    } catch (err) {
      return { reply: `Не вышло ответить: ${err.message}`, brain: 'error' };
    } finally {
      clearTimeout(timer);
    }
  }

  async turn(text, voice) {
    // "скинь фото" from the phone: drawn on the PC (main.js photoTask), fetched like her voice (/gallery/<file>)
    const media = this.d.photo && this.d.mediaKind?.(text);
    const { reply, brain, image } = media ? await this.media(text, media)
      : (await this.switchModel(text)) || await this.reply(text);
    // kept like a talk on the PC: her hub's Chats (as a phone chat) and your vault (main.js)
    if (brain !== 'error' && !/^новый разговор/i.test(text)) this.d.log?.({ said: text, answer: image ? `${reply}\n[[photo:${image}]]` : reply });
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

module.exports = { PhoneBridge, newToken, tokenMatches, addresses, controlPatch, parseModelCommand };
