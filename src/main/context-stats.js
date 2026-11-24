'use strict';

const { FAST, MAIN, VISION } = require('./brains');
const { QWEN_MODELS, isAuxiliaryModel } = require('./phone-model');
const ollama = require('./ollama');

// Local Ollama context defaults (Вариант Б). Single source of truth for main.js and phone telemetry,
// easy to adjust after live RAM/VRAM measurements.
const LOCAL_CONTEXT_DEFAULTS = Object.freeze({
  fast: 32768,
  main: 32768,
  qwen36: ollama.QWEN36_DEFAULT_CTX || 32768,
  aux: ollama.AUX_DEFAULT_CTX || 16384,
  vision: 2048,
});

// Verified context windows:
// - Local Ollama: configured num_ctx under Вариант Б (live ollama.ctxFor(model) overrides at runtime).
// - Codex: ~/.codex/models_cache.json (gpt-6.2-sol=500000, gpt-6.2-astra=272000, gpt-6.1-terra=500000).
// - Claude 5.5 CLI (claude.exe v2.1.321 registry): native_1m=true, context.window=1000000 for opus/sonnet/haiku 5.5.
// - Antigravity: Gemini 4 / 3.8 Flash / Orchestrator = 1048576 (1M), Claude 5.5 Vertex = 1000000.
// - Gemini Web: 1048576 (1M).
const CONTEXT_LIMITS = Object.freeze({
  // Local aliases & full Ollama model names
  auto: LOCAL_CONTEXT_DEFAULTS.fast,
  e4b: LOCAL_CONTEXT_DEFAULTS.fast,
  '26b': LOCAL_CONTEXT_DEFAULTS.main,
  qwen36: LOCAL_CONTEXT_DEFAULTS.qwen36,
  qwen38: LOCAL_CONTEXT_DEFAULTS.aux,
  [FAST]: LOCAL_CONTEXT_DEFAULTS.fast,
  [MAIN]: LOCAL_CONTEXT_DEFAULTS.main,
  [VISION]: LOCAL_CONTEXT_DEFAULTS.vision,
  [QWEN_MODELS.qwen36]: LOCAL_CONTEXT_DEFAULTS.qwen36,
  [QWEN_MODELS.qwen38]: LOCAL_CONTEXT_DEFAULTS.aux,

  // Codex (~/.codex/models_cache.json)
  codex: 500000,
  'gpt-6.2-sol': 500000,
  'gpt-6.2-astra': 272000,
  'gpt-6.1-terra': 500000,
  'gpt-6.1-sol': 500000,

  // Claude 5.5 CLI (native 1M in Claude Code 2.1.321)
  claude: 1000000,
  opus: 1000000,
  sonnet: 1000000,
  haiku: 1000000,
  'claude-opus-5-5': 1000000,
  'claude-sonnet-5-5': 1000000,
  'claude-haiku-5-5': 1000000,

  // Antigravity (Gemini + Claude 5.5 Vertex reserve)
  'gemini-4-carbon-low': 1048576,
  'gemini-4-carbon-medium': 1048576,
  'gemini-4-carbon-high': 1048576,
  'gemini-4-neon-low': 1048576,
  'gemini-4-neon-medium': 1048576,
  'gemini-4-neon-high': 1048576,
  'gemini-4-neon-xhigh': 1048576,
  'gemini-4-argon-low': 1048576,
  'gemini-4-argon-medium': 1048576,
  'gemini-4-argon-high': 1048576,
  'gemini-4-hydrogen-low': 1048576,
  'gemini-4-hydrogen-medium': 1048576,
  'gemini-4-hydrogen-high': 1048576,
  'gemini-4-hydrogen-xhigh': 1048576,
  'gemini-3.8-flash-low': 1048576,
  'gemini-3.8-flash-medium': 1048576,
  'gemini-3.8-flash-high': 1048576,
  'gemini-pro-orchestrator-neon': 1048576,
  'gemini-pro-orchestrator-g1-pro': 1048576,
  'claude-opus-5-5-low': 1000000,
  'claude-opus-5-5-medium': 1000000,
  'claude-opus-5-5-high': 1000000,
  'claude-sonnet-5-5-low': 1000000,
  'claude-sonnet-5-5-medium': 1000000,
  'claude-sonnet-5-5-high': 1000000,
  'orchestrator-claude-opus': 1000000,

  // Gemini Web
  'gemini-web-neon': 1048576,
  'gemini-web-hydrogen': 1048576,
  'gemini-4-neon': 1048576,
  'gemini-4-hydrogen': 1048576,
});

const LOCAL_ALIAS_TO_MODEL = Object.freeze({
  auto: FAST,
  e4b: FAST,
  '26b': MAIN,
  qwen36: QWEN_MODELS.qwen36,
  qwen38: QWEN_MODELS.qwen38,
});

const CYRILLIC_RE = /[а-яёА-ЯЁ]/g;
const CODE_SYMBOL_RE = /[{}[\]();:=<>+\-*/\\|&^%$#@!~`"']/g;

function toNonNegInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function toPosInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

/**
 * Estimates token count for mixed Cyrillic, Latin, and code text.
 * ~3.2 chars/token for Cyrillic, ~2.6 chars/token for code symbols, ~4.0 chars/token for Latin/digits/spaces.
 */
function estimateTokens(text) {
  if (text == null) return 0;
  const str = typeof text === 'string' ? text : String(text);
  if (!str.length) return 0;
  const cyrillic = (str.match(CYRILLIC_RE) || []).length;
  const codeSymbols = (str.match(CODE_SYMBOL_RE) || []).length;
  const rest = Math.max(0, str.length - cyrillic - codeSymbols);
  return Math.max(1, Math.ceil((cyrillic / 3.2) + (codeSymbols / 2.6) + (rest / 4.0)));
}

function resolveContextLimit(model, provider = '', { ctxFor = ollama.ctxFor } = {}) {
  const raw = typeof model === 'string' ? model.trim() : '';
  const mappedLocal = Object.hasOwn(LOCAL_ALIAS_TO_MODEL, raw) ? LOCAL_ALIAS_TO_MODEL[raw] : raw;

  if (mappedLocal && typeof ctxFor === 'function') {
    const live = toPosInt(ctxFor(mappedLocal));
    if (live) return live;
  }
  if (raw && Object.hasOwn(CONTEXT_LIMITS, raw)) return CONTEXT_LIMITS[raw];
  if (mappedLocal && Object.hasOwn(CONTEXT_LIMITS, mappedLocal)) return CONTEXT_LIMITS[mappedLocal];
  if (raw && isAuxiliaryModel(raw)) return LOCAL_CONTEXT_DEFAULTS.aux;

  const lower = raw.toLowerCase();
  if (lower.startsWith('gemini-')) return 1048576;
  if (/^claude-(?:opus|sonnet|haiku)-5-5(?:-|$)/.test(lower)) return 1000000;
  if (lower.startsWith('claude-')) return 200000;
  if (lower === 'gpt-6.2-astra' || lower === 'gpt-6-astra') return 272000;
  if (lower.startsWith('gpt-6.2-') || lower.startsWith('gpt-6.1-')) return 500000;

  const prov = String(provider || '').toLowerCase();
  if (prov === 'codex') return CONTEXT_LIMITS.codex;
  if (prov === 'claude') return CONTEXT_LIMITS.claude;
  if (prov === 'gemini' || prov === 'gemini-web') return 1048576;
  return LOCAL_CONTEXT_DEFAULTS.fast;
}

function getContextLimits({ ctxFor = ollama.ctxFor } = {}) {
  const limits = { ...CONTEXT_LIMITS };
  if (typeof ctxFor === 'function') {
    const fastLive = toPosInt(ctxFor(FAST));
    const mainLive = toPosInt(ctxFor(MAIN));
    const qwen36Live = toPosInt(ctxFor(QWEN_MODELS.qwen36));
    const qwen38Live = toPosInt(ctxFor(QWEN_MODELS.qwen38));
    if (fastLive) {
      limits.auto = fastLive;
      limits.e4b = fastLive;
      limits[FAST] = fastLive;
    }
    if (mainLive) {
      limits['26b'] = mainLive;
      limits[MAIN] = mainLive;
    }
    if (qwen36Live) {
      limits.qwen36 = qwen36Live;
      limits[QWEN_MODELS.qwen36] = qwen36Live;
    }
    if (qwen38Live) {
      limits.qwen38 = qwen38Live;
      limits[QWEN_MODELS.qwen38] = qwen38Live;
    }
  }
  return limits;
}

function estimateMessagesTokens(messages, includeSystemInMessages = false) {
  if (!Array.isArray(messages) || !messages.length) return { messagesTokens: 0, systemTokens: 0 };
  let messagesTokens = 0;
  let systemTokens = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const textTokens = estimateTokens(typeof m.content === 'string' ? m.content : '');
    const imageTokens = Array.isArray(m.images) ? m.images.length * 256 : 0;
    const total = textTokens + imageTokens + (textTokens > 0 || imageTokens > 0 ? 4 : 0);
    if (m.role === 'system') {
      if (includeSystemInMessages) systemTokens += total;
    } else {
      messagesTokens += total;
    }
  }
  return { messagesTokens, systemTokens };
}

function scaleBreakdown(rawCounts, targetTotal) {
  const keys = ['messages', 'systemPrompt', 'skills', 'memory', 'tools'];
  const estTotal = keys.reduce((sum, k) => sum + rawCounts[k], 0);
  if (targetTotal <= 0) {
    return { messages: 0, systemPrompt: 0, skills: 0, memory: 0, tools: 0 };
  }
  if (estTotal <= 0) {
    return { messages: targetTotal, systemPrompt: 0, skills: 0, memory: 0, tools: 0 };
  }
  const scaled = {};
  const remainders = [];
  let assigned = 0;
  for (const k of keys) {
    const exact = (rawCounts[k] / estTotal) * targetTotal;
    const floored = Math.floor(exact);
    scaled[k] = floored;
    assigned += floored;
    remainders.push({ k, frac: exact - floored, weight: rawCounts[k] });
  }
  let left = targetTotal - assigned;
  remainders.sort((a, b) => b.frac - a.frac || b.weight - a.weight);
  for (let i = 0; left > 0 && i < remainders.length; i++, left--) {
    scaled[remainders[i].k] += 1;
  }
  return scaled;
}

function buildContextStats({
  model = '',
  provider = '',
  maxTokens = null,
  systemPrompt = '',
  skillsText = '',
  memoryText = '',
  toolsText = '',
  messages = [],
  actualPromptTokens = null,
  actualEvalTokens = null,
  ctxFor = ollama.ctxFor,
} = {}) {
  const resolvedMax = toPosInt(maxTokens) || resolveContextLimit(model, provider, { ctxFor });
  const explicitSystem = typeof systemPrompt === 'string' && systemPrompt.length > 0;
  const msgEst = estimateMessagesTokens(messages, !explicitSystem);
  const rawCounts = {
    messages: msgEst.messagesTokens,
    systemPrompt: explicitSystem ? estimateTokens(systemPrompt) : msgEst.systemTokens,
    skills: estimateTokens(skillsText),
    memory: estimateTokens(memoryText),
    tools: estimateTokens(toolsText),
  };

  const promptActual = toNonNegInt(actualPromptTokens);
  const evalActual = toNonNegInt(actualEvalTokens);
  const hasActual = (promptActual !== null && promptActual > 0) || (evalActual !== null && evalActual > 0);

  let usedTokens;
  let source;
  let parts;
  if (hasActual) {
    usedTokens = (promptActual || 0) + (evalActual || 0);
    source = 'actual';
    parts = scaleBreakdown(rawCounts, usedTokens);
  } else {
    usedTokens = rawCounts.messages + rawCounts.systemPrompt + rawCounts.skills + rawCounts.memory + rawCounts.tools;
    source = 'estimated';
    parts = rawCounts;
  }

  const freeTokens = Math.max(0, resolvedMax - usedTokens);
  const percent = resolvedMax > 0 ? Math.min(100, Math.round((usedTokens / resolvedMax) * 1000) / 10) : 0;

  return {
    model: String(model || ''),
    provider: String(provider || ''),
    maxTokens: resolvedMax,
    usedTokens,
    freeTokens,
    percent,
    source,
    breakdown: {
      messages: parts.messages,
      systemPrompt: parts.systemPrompt,
      skills: parts.skills,
      memory: parts.memory,
      tools: parts.tools,
      free: freeTokens,
    },
  };
}

module.exports = {
  LOCAL_CONTEXT_DEFAULTS,
  CONTEXT_LIMITS,
  estimateTokens,
  resolveContextLimit,
  getContextLimits,
  buildContextStats,
};
