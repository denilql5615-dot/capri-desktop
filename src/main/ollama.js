'use strict';

// Talking to her: a local model through Ollama (https://ollama.com). Done from here, not from
// the overlay's page, which can't reach other local ports. Everything stays on this machine
// unless OLLAMA_HOST points somewhere else, or you pick one of Ollama's cloud models ("beam:cloud"):
// those run on its servers, with the account you're signed in with in Ollama.

function base() {
  let host = process.env.OLLAMA_HOST || '127.0.0.1:11434';
  if (!/^https?:\/\//.test(host)) host = `http://${host}`;
  return host.replace('://0.0.0.0', '://127.0.0.1').replace(/\/+$/, '');
}

// Ollama's errors come as {"error": "..."}. A cloud model can also say you're signed out (401) or
// out of free use for now (429): her chat moves on to another model then (main.js).
async function failure(res) {
  const body = await res.text().catch(() => '');
  let message = body || `Ollama answered ${res.status}`;
  try {
    message = JSON.parse(body).error || message;
  } catch {
    // not JSON: the body says it
  }
  const code = res.status === 429 || res.status === 503 ? 'busy'
    : res.status === 401 ? 'signin'
      : [402, 403, 404].includes(res.status) ? 'gone' : null;
  return Object.assign(new Error(message), { status: res.status, code });
}

// What Ollama said about each model it lists: { cloud, thinking }
const known = new Map();

// The models installed, by name ("llama3.2:latest", "beam:cloud"...).
async function models() {
  const res = await fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw await failure(res);
  const { models: list = [] } = await res.json();
  for (const m of list) known.set(m.name, { cloud: Boolean(m.remote_host), thinking: Boolean(m.capabilities?.includes('thinking')) });
  return list.map((m) => m.name);
}

// Run on Ollama's servers rather than this PC
const isCloud = (model) => known.get(model)?.cloud ?? /[:-]cloud$/.test(model || '');
const canThink = (model) => known.get(model)?.thinking ?? /^(gemma4|qwen3)/i.test(model || '');

// Your Ollama account, when you're signed in to it on this PC: { name, plan }. Signed out: { signin },
// the page that links this PC to an account. null when Ollama can't tell (asleep, cloud turned off).
async function account() {
  const res = await fetch(`${base()}/api/me`, { method: 'POST', signal: AbortSignal.timeout(6000) }).catch(() => null);
  if (!res) return null;
  const body = await res.json().catch(() => ({}));
  if (res.ok && body.name) return { name: body.name, plan: body.plan || '' };
  const url = String(body.signin_url || '');
  return url.startsWith('https://ollama.com/') ? { signin: url } : null;
}

// The cloud models you can use for free ("beam:cloud"). There's no API for prices: this reads the
// "free" badges on Ollama's list of cloud models, a few times a day at most.
let free = { at: 0, names: [] };
async function freeModels() {
  if (Date.now() - free.at < 6 * 3600e3) return free.names;
  const res = await fetch('https://ollama.com/search?c=cloud', { signal: AbortSignal.timeout(8000) }).catch(() => null);
  const page = res?.ok ? await res.text().catch(() => '') : '';
  if (!page) return free.names;
  const names = [];
  for (const [card] of page.matchAll(/<li\b[\s\S]*?<\/li>/g)) {
    const slug = /href="\/library\/([\w.-]+)/.exec(card)?.[1];
    if (slug && />\s*free\s*</i.test(card)) names.push(`${slug}:cloud`);
  }
  free = { at: Date.now(), names: [...new Set(names)] };
  return free.names;
}

// Loads the model into memory ahead of the first message (the first answer after a fresh start
// otherwise waits for it to load, which can take a while). Nothing to load for a cloud model.
function warm(model) {
  if (isCloud(model)) return;
  fetch(`${base()}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: '15m' }),
  }).catch(() => {});
}

// Free its VRAM before loading another large local model.
async function unload(model) {
  if (!model || isCloud(model)) return true;
  const res = await fetch(`${base()}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 }),
  }).catch(() => null);
  return Boolean(res?.ok);
}

// Every model Ollama has in memory out of it (her chat model, a roleplay one, a vision one): the GPU free
// for something else (comfy.js). They load again by themselves on the next message.
async function unloadAll() {
  const res = await fetch(`${base()}/api/ps`).catch(() => null);
  if (!res?.ok) return [];
  const { models = [] } = await res.json().catch(() => ({}));
  const names = models.map((m) => m.name || m.model).filter((name) => name && !isCloud(name));
  await Promise.all(names.map(unload));
  return names;
}

// Her answer, streamed: onDelta(piece) as it comes, resolves with all of it.
async function chat({ model, messages, numPredict = 240, keepAlive = '15m' }, onDelta, signal) {
  // cloud models think before they answer, and that counts in num_predict: kept short, with room for it
  const thinking = canThink(model);
  const thinks = isCloud(model) && thinking;
  const res = await fetch(`${base()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      keep_alive: keepAlive,
      // a local thinking model (gemma4, qwen3, qwen3.5) thinks by default and spends all 240 tokens on it: she'd answer "…"
      ...(thinking && { think: thinks ? 'low' : false }),
      options: { temperature: 0.85, num_predict: thinks ? 1200 : numPredict },
    }),
    signal,
  });
  if (!res.ok) throw await failure(res);
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let thinkingChars = 0;
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      thinkingChars += String(msg.message?.thinking || '').length;
      const piece = msg.message?.content || ''; // a thinking model's reasoning comes apart, and is left out
      if (piece) {
        text += piece;
        onDelta(piece);
      }
      if (msg.done) {
        if (!text.trim()) console.warn('[capri] empty Ollama answer', model, {
          thinkingChars, doneReason: msg.done_reason || '', evalCount: msg.eval_count || 0,
        });
        return text;
      }
    }
  }
  return text;
}

// One step of a task (agent.js): her answer as JSON held to `schema`. Not streamed, no thinking aloud
// (it would eat the turn); a long context, as the snapshots pile up.
async function jsonChat({ model, messages, schema }, signal) {
  const res = await fetch(`${base()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, messages, format: schema, stream: false, keep_alive: '15m',
      ...(canThink(model) && { think: false }),
      options: { temperature: 0.2, num_predict: 400 },
    }),
    signal,
  });
  if (!res.ok) throw await failure(res);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.message?.content || '';
}

// A few tokens with how sure the model was of each (her router, router.js): { content, logprobs }.
// No thinking; her usual context, so she isn't loaded again between chat turns.
async function pick({ model, messages, numPredict = 8, topLogprobs = 10 }, signal) {
  const res = await fetch(`${base()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model, messages, stream: false, keep_alive: '15m', logprobs: true, top_logprobs: topLogprobs,
      ...(canThink(model) && { think: false }),
      options: { temperature: 0, num_predict: numPredict },
    }),
    signal,
  });
  if (!res.ok) throw await failure(res);
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return { content: json.message?.content || '', logprobs: json.logprobs || [] };
}

// Whether a model can look at pictures (gemma3 can, llama3.2 can't). Can't tell: yes, try it.
async function canSee(model) {
  const res = await fetch(`${base()}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (!res?.ok) return true;
  const info = await res.json().catch(() => ({}));
  return !Array.isArray(info.capabilities) || info.capabilities.includes('vision');
}

function spokenModelKey(name) {
  return String(name || '').toLowerCase()
    .replace(/кьюэн|кьюен|кьювен|квэн|квен|куэн|куен|квин|куин/g, 'qwen')
    .replace(/три\s+с\s+половиной/g, '3.5')
    .replace(/двенадцать/g, '12').replace(/восемь/g, '8').replace(/пять/g, '5').replace(/четыре/g, '4').replace(/три/g, '3')
    .replace(/точка/g, '.').replace(/ви\s*[- ]?эл|вл/g, 'vl').replace(/би/g, 'b').replace(/б/g, 'b')
    .replace(/фаун/g, 'faun').replace(/эм\s*эн/g, 'mn')
    .replace(/[^a-z0-9]/g, '');
}

const SPOKEN_MODELS = {
  основная: 'gemma4:26b-a4b-it-qat',
  основную: 'gemma4:26b-a4b-it-qat',
  новая: 'gemma4:26b-a4b-it-qat',
  новую: 'gemma4:26b-a4b-it-qat',
  зрение: 'gemma4:26b-a4b-it-qat',
  зрения: 'gemma4:26b-a4b-it-qat',
  зрительную: 'gemma4:26b-a4b-it-qat',
  ролевая: 'hf.co/limloop/MN-12B-Faun-RP-RU-GGUF:Q3_K_M',
  ролевую: 'hf.co/limloop/MN-12B-Faun-RP-RU-GGUF:Q3_K_M',
  qwen38b: 'qwen3:8b',
  qwen3vl4b: 'qwen3-vl:4b',
  qwen354b: 'qwen3.5:4b',
  faun12b: 'hf.co/limloop/MN-12B-Faun-RP-RU-GGUF:Q3_K_M',
  mn12b: 'hf.co/limloop/MN-12B-Faun-RP-RU-GGUF:Q3_K_M',
};

function findSpokenModel(list, wanted) {
  const key = spokenModelKey(wanted);
  const said = String(wanted || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const named = SPOKEN_MODELS[said] || SPOKEN_MODELS[key];
  return key || named ? list.find((model) => model.toLowerCase() === named?.toLowerCase() || spokenModelKey(model) === key) || null : null;
}

function screenModel(list = []) {
  return list.find((model) => model.toLowerCase() === 'gemma4:26b-a4b-it-qat') || null;
}

const retryEmptyVision = (text, attempt) => attempt === 0 && !String(text || '').trim();
const visionPrompt = (text) => String(text || '');

module.exports = { base, models, isCloud, account, freeModels, warm, unload, unloadAll, chat, jsonChat, pick, canSee, findSpokenModel, screenModel, retryEmptyVision, visionPrompt };
