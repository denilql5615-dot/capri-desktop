'use strict';

// Content Disarm & Reconstruction (CDR) for untrusted Tor isolator output.
// Validates strict JSON schema, strips dangerous Unicode/control chars, defangs URLs and Markdown,
// escapes prompt delimiters, enforces size limits, and flags AI-directed injection phrases without deletion.

const LIMITS = Object.freeze({
  results: 10,
  pages: 5,
  title: 200,
  snippet: 300,
  text: 20000,
  error: 500,
});

const NODES = Object.freeze(['tor', 'dark']);

// Control characters excluding \t (0x09) and \n (0x0A), plus C1 controls, zero-width, bidi, and Unicode Tags.
const CONTROL_EXCEPT_TAB_NL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const INVISIBLE_AND_BIDI = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const UNICODE_TAGS = /[\u{E0000}-\u{E007F}]/gu;

const MD_IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const MD_LINK_RE = /\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const BARE_HTTP_URL_RE = /\bhttps?:\/\/[^\s"'<>)\]]+/gi;

const SUSPICIOUS_PATTERNS = Object.freeze([
  /\bignore\s+(?:all\s+|the\s+|any\s+|your\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directions?|context)\b/iu,
  /\bdisregard\s+(?:all\s+|the\s+|any\s+|your\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?)\b/iu,
  /\bforget\s+(?:everything|all|your)\s+(?:above|previous|instructions?|rules?|prompts?)\b/iu,
  /\b(?:new\s+)?system\s+prompt\b/iu,
  /\byou\s+are\s+(?:now\s+)?(?:a|an|my)?\s*(?:helpful\s+)?(?:ai\s+)?(?:assistant|chatgpt|claude|gemini|llm|model)\b/iu,
  /\bact\s+as\s+(?:a|an)?\s*(?:assistant|system|developer|admin|jailbreak)\b/iu,
  /\bdo\s+not\s+(?:mention|tell|reveal|follow)\s+(?:the\s+user|your\s+(?:instructions?|rules?)|these\s+instructions?)\b/iu,
  /игнорируй(?:те)?\s+(?:все\s+|эти\s+|мои\s+)?(?:предыдущ\p{L}*|прошл\p{L}*|верхн\p{L}*|прежн\p{L}*)?\s*(?:инструкци\p{L}*|указани\p{L}*|правил\p{L}*|промпт\p{L}*)/iu,
  /забудь(?:те)?\s+(?:все\s+|всё\s+)?(?:предыдущ\p{L}*|прошл\p{L}*|свои\s+)?(?:инструкци\p{L}*|правил\p{L}*|ограничени\p{L}*)/iu,
  /системн\p{L}*\s+промпт\p{L}*/iu,
  /новые?\s+инструкци\p{L}*\s+для\s+(?:ии|ассистент\p{L}*|модел\p{L}*|бота)/iu,
  /ты\s*[-—–:]?\s*(?:теперь\s+)?(?:ии|ai|нейросет\p{L}*|ассистент\p{L}*|помощник\p{L}*|модель\p{L}*)/iu,
  /выполни\s+(?:эту\s+)?команд\p{L}*\s+(?:вместо|не\s+говоря)/iu,
]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function stripUnsafeUnicode(str) {
  return String(str ?? '')
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_EXCEPT_TAB_NL, '')
    .replace(INVISIBLE_AND_BIDI, '')
    .replace(UNICODE_TAGS, '');
}

function escapeDelimiters(str) {
  return str
    .replace(/<<</g, '\u2039\u2039\u2039')
    .replace(/>{3}/g, '\u203a\u203a\u203a');
}

function truncateSafe(str, maxLen) {
  if (!Number.isFinite(maxLen) || maxLen < 0) return str;
  const limit = Math.trunc(maxLen);
  if (str.length <= limit) return str;
  let cut = str.slice(0, limit);
  if (cut.length > 0) {
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1);
  }
  return cut.trimEnd();
}

/**
 * Defangs a URL: accepts strictly http/https (anything else returns ''), switches scheme to
 * hxxp(s)://, replaces domain dots with [.], strips credentials, and neutralizes Markdown syntax.
 */
function defangUrl(url) {
  if (typeof url !== 'string') return '';
  const cleaned = stripUnsafeUnicode(url).trim();
  if (!cleaned || /\s/.test(cleaned)) return '';
  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (!parsed.hostname) return '';

  const scheme = parsed.protocol === 'https:' ? 'hxxps://' : 'hxxp://';
  const host = parsed.hostname.replace(/\./g, '[.]');
  const port = parsed.port ? `:${parsed.port}` : '';
  const suffix = `${parsed.pathname}${parsed.search}${parsed.hash}`
    .replace(/\[/g, '%5B')
    .replace(/\]/g, '%5D')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
  return escapeDelimiters(`${scheme}${host}${port}${suffix}`);
}

function neutralizeMarkdownAndUrls(str) {
  return str
    .replace(MD_IMAGE_RE, (_m, alt, url) => {
      const safeAlt = alt.trim();
      const safeUrl = defangUrl(url);
      const label = safeUrl ? `image: ${safeUrl}` : 'image: blocked-url';
      return safeAlt ? `${safeAlt} (${label})` : `(${label})`;
    })
    .replace(MD_LINK_RE, (_m, label, url) => {
      const safeLabel = label.trim();
      const safeUrl = defangUrl(url);
      if (safeUrl) return safeLabel ? `${safeLabel} (${safeUrl})` : safeUrl;
      return safeLabel || '(blocked-url)';
    })
    .replace(BARE_HTTP_URL_RE, (raw) => defangUrl(raw) || '(blocked-url)');
}

/**
 * Normalizes untrusted text via NFKC, strips control/zero-width/bidi/tag code points,
 * turns Markdown images/links & URLs into inert text, escapes <<< / >>>, and collapses whitespace.
 */
function cleanText(s, maxLen) {
  if (s === null || s === undefined) return '';
  const raw = typeof s === 'string' ? s : String(s);
  const prepared = neutralizeMarkdownAndUrls(stripUnsafeUnicode(raw));
  const collapsed = escapeDelimiters(prepared)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncateSafe(collapsed, maxLen);
}

function detectSuspicious(text) {
  return SUSPICIOUS_PATTERNS.some((re) => re.test(text));
}

function normalizeFetchedAt(raw) {
  if (typeof raw === 'string') {
    const cleaned = cleanText(raw, 64);
    if (!cleaned || Number.isNaN(Date.parse(cleaned))) return null;
    return cleaned;
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    try {
      return new Date(Math.trunc(raw)).toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

function failResult(message) {
  return { ok: false, error: cleanText(message || 'invalid isolator result', LIMITS.error) };
}

function defangItemUrl(item) {
  if (typeof item.url === 'string') return defangUrl(item.url);
  if (typeof item.url_defanged !== 'string') return null;
  const s = item.url_defanged.trim();
  const norm = /^hxxps?:\/\//i.test(s)
    ? s.replace(/^hxxp(s?):\/\//i, 'http$1://').replace(/\[\.\]/g, '.')
    : s;
  return defangUrl(norm);
}

/**
 * Validates raw isolator JSON against the strict schema and applies CDR sanitization.
 * Never throws; returns `{ ok: false, error }` on isolator failure or any schema violation.
 */
function sanitizeIsolatorResult(raw) {
  if (!isPlainObject(raw)) {
    return failResult('invalid schema: expected plain object');
  }
  if (typeof raw.ok !== 'boolean') {
    return failResult('invalid schema: ok must be boolean');
  }
  if (raw.ok === false) {
    if (raw.error !== undefined && raw.error !== null && typeof raw.error !== 'string') {
      return failResult('invalid schema: error must be string');
    }
    return failResult(typeof raw.error === 'string' && raw.error ? raw.error : 'isolator job failed');
  }

  if (typeof raw.node !== 'string' || !NODES.includes(raw.node)) {
    return failResult('invalid schema: node must be tor or dark');
  }
  const fetchedAt = normalizeFetchedAt(raw.fetched_at);
  if (!fetchedAt) {
    return failResult('invalid schema: invalid fetched_at');
  }
  if (!Array.isArray(raw.results) || !Array.isArray(raw.pages)) {
    return failResult('invalid schema: results and pages must be arrays');
  }
  if (raw.error !== undefined && raw.error !== null && typeof raw.error !== 'string') {
    return failResult('invalid schema: error must be string or null');
  }

  const results = [];
  for (const item of raw.results.slice(0, LIMITS.results)) {
    if (!isPlainObject(item)) return failResult('invalid schema: result entry must be object');
    if (typeof item.title !== 'string') return failResult('invalid schema: result.title must be string');
    const urlDefanged = defangItemUrl(item);
    if (urlDefanged === null) return failResult('invalid schema: result.url must be string');
    if (item.snippet !== undefined && typeof item.snippet !== 'string') {
      return failResult('invalid schema: result.snippet must be string');
    }

    results.push({
      title: cleanText(item.title, LIMITS.title),
      url_defanged: urlDefanged,
      snippet: cleanText(item.snippet || '', LIMITS.snippet),
    });
  }

  const pages = [];
  for (const item of raw.pages.slice(0, LIMITS.pages)) {
    if (!isPlainObject(item)) return failResult('invalid schema: page entry must be object');
    const urlDefanged = defangItemUrl(item);
    if (urlDefanged === null) return failResult('invalid schema: page.url must be string');
    if (typeof item.title !== 'string') return failResult('invalid schema: page.title must be string');
    if (typeof item.text !== 'string') return failResult('invalid schema: page.text must be string');
    if (item.truncated !== undefined && typeof item.truncated !== 'boolean') {
      return failResult('invalid schema: page.truncated must be boolean');
    }
    if (item.flags !== undefined && (!Array.isArray(item.flags) || item.flags.some((f) => typeof f !== 'string'))) {
      return failResult('invalid schema: page.flags must be string array');
    }

    const title = cleanText(item.title, LIMITS.title);
    const fullText = cleanText(item.text);
    const truncated = Boolean(item.truncated) || fullText.length > LIMITS.text;
    const text = truncateSafe(fullText, LIMITS.text);

    const flags = [];
    const seenFlags = new Set();
    for (const f of item.flags || []) {
      const cleanFlag = cleanText(f, 32).toLowerCase();
      if (cleanFlag && /^[a-z0-9_-]+$/.test(cleanFlag) && !seenFlags.has(cleanFlag)) {
        seenFlags.add(cleanFlag);
        flags.push(cleanFlag);
      }
    }
    if ((detectSuspicious(title) || detectSuspicious(fullText)) && !seenFlags.has('suspicious')) {
      seenFlags.add('suspicious');
      flags.push('suspicious');
    }

    pages.push({
      url_defanged: urlDefanged,
      title,
      text,
      truncated,
      flags,
    });
  }

  return {
    ok: true,
    node: raw.node,
    fetched_at: fetchedAt,
    results,
    pages,
    error: typeof raw.error === 'string' && raw.error ? cleanText(raw.error, LIMITS.error) : null,
  };
}

module.exports = {
  LIMITS,
  NODES,
  sanitizeIsolatorResult,
  defangUrl,
  cleanText,
};
