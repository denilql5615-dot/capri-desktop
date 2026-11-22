'use strict';

// Her long memory: notes in your Obsidian vault (<vault>/Capri, else Documents/Capri/Память), one fact per
// note, with what kind of fact it is and when she wrote it, and _Память.md listing them all. She writes
// them herself after a conversation (what's worth keeping about you), or when you say "запомни…"; before
// she answers, the notes that fit what you said are put in her prompt. You read and edit them in
// Obsidian like any note: what's in the files is what she remembers. On this PC only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const memoryRag = require('./memory-rag');
const privateVaultCrypto = require('./private-vault-crypto');

const INDEX = '_Память.md';
const TYPES = ['о тебе', 'проект', 'договорённость', 'вкус'];
const MAX_TEXT = 600;
const ALWAYS = 6; // notes about you she always has in mind
const MATCHED = 5; // and the ones that fit what you just said
const VAULT_MATCHED = 3;
const VAULT_TEXT = 360;
const PENDING_REVIEW_DIR = 'pending_review';
const MEMORY_ARCHIVE_DIR = '90_архив';
const ACTIVE_MEMORY_DIRS = new Set(['10_ствол', '20_крона']);

// Your Obsidian vault, from Obsidian's own list of them: the one opened last among those open (else any)
function obsidianVault(appData) {
  try {
    const { vaults = {} } = JSON.parse(fs.readFileSync(path.join(appData, 'obsidian', 'obsidian.json'), 'utf8'));
    const list = Object.values(vaults).filter((v) => v?.path && fs.existsSync(v.path)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return (list.find((v) => v.open) || list[0])?.path || null;
  } catch {
    return null;
  }
}

// Where her notes are: set in her config, else the Capri folder of your Obsidian vault, else Documents.
function dirOf({ notesDir, appData, documents }) {
  if (notesDir) return notesDir;
  const vault = obsidianVault(appData);
  return vault ? path.join(vault, 'Capri') : path.join(documents, 'Capri', 'Память');
}

// A title as a file name Windows and Obsidian both take (no \ / : * ? " < > | # ^ [ ]).
function fileName(title) {
  const clean = String(title || '').replace(/[\\/:*?"<>|#^[\]\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return clean.replace(/[. ]+$/, '');
}

function parse(source) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([^:]+):\s*(.*)$/.exec(line);
      if (kv) meta[kv[1].trim()] = kv[2].trim();
    }
  }
  return { meta, text: (m ? source.slice(m[0].length) : source).trim() };
}

function unquote(value) {
  const text = String(value || '').trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return String(JSON.parse(text)); } catch { return text.slice(1, -1); }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return text;
}

// All her notes: [{ title, type, text, updated }]
function list(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && !n.startsWith('_'));
  } catch {
    return [];
  }
  return names.map((name) => {
    const { meta, text } = parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (!memoryRag.isCardAllowed({ source: unquote(meta.source), layer: unquote(meta.layer), vault: unquote(meta.vault) === 'true' })) return null;
    return { title: name.slice(0, -3), type: meta['тип'] || 'о тебе', text, updated: meta['обновлено'] || '' };
  }).filter((n) => n?.text);
}

function markdownCandidate(parsed, title, relative, { privateRoot = false, history = false, fallbackDate = '' } = {}) {
  const layer = relative.split(path.sep)[0].toLowerCase();
  const status = unquote(parsed.meta.status);
  if (status === 'conflicted') return null;
  if (history || (!privateRoot && ACTIVE_MEMORY_DIRS.has(layer))) {
    const requiredStatus = history ? 'archived' : 'verified';
    if (status !== requiredStatus) return null;
  }
  const { text } = parsed;
  const excerpt = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 4).join(' ').slice(0, VAULT_TEXT);
  return {
    title,
    text: excerpt,
    body: text.slice(0, 4000),
    file: relative,
    layer: unquote(parsed.meta.layer) || layer,
    status,
    topic: unquote(parsed.meta.topic),
    source: unquote(parsed.meta.source) || (privateRoot ? 'vault' : ''),
    vault: privateRoot || unquote(parsed.meta.vault) === 'true',
    link: unquote(parsed.meta.link),
    quote: unquote(parsed.meta.quote),
    created: unquote(parsed.meta.created || parsed.meta['создано']) || fallbackDate,
    updated: unquote(parsed.meta.updated || parsed.meta['обновлено']) || fallbackDate,
  };
}

function rankAndFormat(candidates, said, { limit = VAULT_MATCHED, vaultOnly = false } = {}) {
  return memoryRag.rankCards(candidates, said, { limit, vaultOnly }).map((item) => ({
    title: item.title,
    text: item.text,
    score: item.score,
    file: item.file,
    factors: item.factors,
    updated: item.updated || '',
    created: item.created || '',
    source: item.source || '',
    layer: item.layer || '',
  }));
}

// The rest of the Obsidian vault: only a few notes that match this message. Her own Capri/ notes are
// still handled by list()/recall(), so their metadata and index keep their old meaning.
function searchVault(dir, said, limit = VAULT_MATCHED, { history = false, journalDir = null, vaultOnly = false } = {}) {
  const words = stems(said);
  if (!words.size) return [];
  const root = path.basename(dir).toLowerCase() === 'capri' ? path.dirname(dir) : dir;
  if (journalDir) {
    require('./memory-promotion').reconcileVaultJournal(root, journalDir);
  }
  const files = [];
  const walk = (folder) => {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const entryName = entry.name.toLowerCase();
      if (entryName === '.obsidian') continue;
      if (folder === root) {
        if (entryName === RAW_DIR.toLowerCase() || entryName === PENDING_REVIEW_DIR) continue;
        if (history !== (entryName === MEMORY_ARCHIVE_DIR)) continue;
      }
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(file);
    }
  };
  walk(root);
  const candidates = files.map((file) => {
    let parsed;
    try { parsed = parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    const relative = path.relative(root, file);
    const title = path.basename(file, path.extname(file));
    return markdownCandidate(parsed, title, relative, { history });
  }).filter(Boolean);
  return rankAndFormat(candidates, said, { limit, vaultOnly });
}

function privateVaultRoot(dir, commonNotesDir) {
  const unavailable = () => new Error('Приватный Vault недоступен.');
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw unavailable();
  const common = path.basename(commonNotesDir).toLowerCase() === 'capri' ? path.dirname(commonNotesDir) : commonNotesDir;
  const within = (parent, child) => {
    const relative = path.relative(parent, child);
    return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  try {
    const root = fs.realpathSync(dir);
    let sharedRoot = path.resolve(common);
    try { sharedRoot = fs.realpathSync(sharedRoot); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (within(sharedRoot, root) || within(root, sharedRoot)) throw unavailable();
    fs.accessSync(root, fs.constants.R_OK);
    if (!fs.statSync(root).isDirectory()) throw unavailable();
    return root;
  } catch {
    throw unavailable();
  }
}

function assertPrivateKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== privateVaultCrypto.KEY_BYTES) {
    throw new Error('Приватный Vault недоступен.');
  }
}

function writeAtomic(file, data, encoding) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, data, encoding ? { encoding, flag: 'wx' } : { flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch {
    try { fs.unlinkSync(temporary); } catch {}
    throw new Error('Приватный Vault недоступен.');
  }
}

function chatCandidate(rows, relative, queryWords, fallbackDate) {
  const lines = rows
    .filter((row) => row && ['user', 'assistant'].includes(row.role) && typeof row.content === 'string' && row.content.trim())
    .map((row) => `${row.role === 'user' ? 'Ты' : 'Капри'}: ${row.content.trim().replace(/\s+/g, ' ')}`);
  if (!lines.length) return null;
  const matched = lines.filter((line) => {
    const lineStems = stems(line);
    for (const w of queryWords) {
      if (lineStems.has(w)) return true;
    }
    return false;
  });
  const excerpt = (matched.length ? matched : lines.slice(-4)).join(' ').slice(0, VAULT_TEXT);
  const fullText = lines.join('\n');
  const idMatch = /^altair-chat-([0-9a-f-]+)\.enc$/i.exec(path.basename(relative));
  const title = idMatch ? `Приватный чат (${idMatch[1].slice(0, 8)})` : path.basename(relative, '.enc');
  return {
    title,
    text: excerpt,
    body: fullText.slice(-16000),
    file: relative,
    layer: 'vault',
    status: 'verified',
    topic: '',
    source: 'vault',
    vault: true,
    link: '',
    quote: '',
    created: fallbackDate,
    updated: fallbackDate,
  };
}

function searchPrivateVault(dir, commonNotesDir, said, { key = null } = {}) {
  const root = privateVaultRoot(dir, commonNotesDir);
  if (key !== null && key !== undefined) assertPrivateKey(key);
  const words = stems(said);
  if (!words.size) return [];
  const files = [];
  const walk = (folder) => {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { throw new Error('Приватный Vault недоступен.'); }
    for (const entry of entries) {
      const entryName = entry.name.toLowerCase();
      if (entryName === '.obsidian') continue;
      if (folder === root) {
        if (entryName === RAW_DIR.toLowerCase() || entryName === PENDING_REVIEW_DIR || entryName === MEMORY_ARCHIVE_DIR) continue;
      }
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        if (entryName.endsWith('.md')) files.push({ file, kind: 'md' });
        else if (key && entryName.endsWith('.md.enc')) files.push({ file, kind: 'md.enc' });
        else if (key && /^altair-chat-[0-9a-f-]+\.enc$/i.test(entryName)) files.push({ file, kind: 'chat.enc' });
      }
    }
  };
  walk(root);

  const candidates = files.map(({ file, kind }) => {
    const relative = path.relative(root, file);
    let mtimeDate = '';
    try { mtimeDate = fs.statSync(file).mtime.toISOString().slice(0, 10); } catch {}
    if (kind === 'md') {
      let parsed;
      try { parsed = parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Приватный Vault недоступен.'); }
      const title = path.basename(file, path.extname(file));
      return markdownCandidate(parsed, title, relative, { privateRoot: true });
    }
    let raw;
    try { raw = fs.readFileSync(file); } catch { throw new Error('Приватный Vault недоступен.'); }
    const decrypted = privateVaultCrypto.decryptBuffer(key, raw);
    if (kind === 'md.enc') {
      const parsed = parse(decrypted);
      const title = unquote(parsed.meta.title) || path.basename(file).slice(0, -'.md.enc'.length);
      return markdownCandidate(parsed, title, relative, { privateRoot: true, fallbackDate: mtimeDate });
    }
    let rows;
    try { rows = JSON.parse(decrypted); } catch { throw new Error('Приватный Vault недоступен.'); }
    if (!Array.isArray(rows)) throw new Error('Приватный Vault недоступен.');
    return chatCandidate(rows, relative, words, mtimeDate);
  }).filter(Boolean);
  return rankAndFormat(candidates, said, { limit: VAULT_MATCHED, vaultOnly: true });
}

const PRIVATE_CHAT_BYTES = 2 * 1024 * 1024;
function savePrivateChat(dir, commonNotesDir, chatId, messages, { append = false, key = null } = {}) {
  if (typeof chatId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(chatId)
      || !Array.isArray(messages) || !messages.length || messages.length > 1000
      || messages.some(row => !row || !['user', 'assistant'].includes(row.role) || typeof row.content !== 'string')) {
    throw Object.assign(new Error('Некорректная история приватного чата.'), { status: 400 });
  }
  const root = privateVaultRoot(dir, commonNotesDir);
  if (key !== null && key !== undefined) assertPrivateKey(key);
  const encrypted = Boolean(key);
  const file = path.join(root, `altair-chat-${chatId.toLowerCase()}.${encrypted ? 'enc' : 'json'}`);
  const incoming = messages.map(({ role, content }) => ({ role, content }));
  const previous = (() => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > PRIVATE_CHAT_BYTES + (encrypted ? 128 : 0)) throw new Error('Invalid private chat file');
      const rawText = encrypted
        ? privateVaultCrypto.decryptBuffer(key, fs.readFileSync(file))
        : fs.readFileSync(file, 'utf8');
      const saved = JSON.parse(rawText);
      if (!Array.isArray(saved)) throw new Error('Invalid private chat file');
      return saved;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw new Error('Приватный Vault недоступен.');
    }
  })();
  if (!append) {
    const sharedLength = Math.min(previous.length, incoming.length);
    const samePrefix = previous.slice(0, sharedLength).every((row, index) =>
      row?.role === incoming[index].role && row?.content === incoming[index].content);
    if (!samePrefix) throw Object.assign(new Error('История приватного чата расходится с сохранённой копией.'), { status: 409 });
    if (previous.length >= incoming.length) return true;
  }
  const data = JSON.stringify(append ? previous.concat(incoming) : incoming);
  if (Buffer.byteLength(data, 'utf8') > PRIVATE_CHAT_BYTES) {
    throw Object.assign(new Error('Приватный чат превышает лимит сохранения.'), { status: 413 });
  }
  const payload = encrypted ? privateVaultCrypto.encryptBuffer(key, data) : data;
  writeAtomic(file, payload, encrypted ? undefined : 'utf8');
  return true;
}

function savePrivateNote(dir, commonNotesDir, title, content, { key } = {}) {
  const root = privateVaultRoot(dir, commonNotesDir);
  assertPrivateKey(key);
  const cleanTitle = String(title || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const body = String(content || '').trim();
  if (!cleanTitle || !body) {
    throw Object.assign(new Error('Некорректная приватная заметка.'), { status: 400 });
  }
  const base = fileName(cleanTitle);
  const slug = base.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'note';
  const shortId = crypto.randomBytes(4).toString('hex');
  const name = `${slug}-${shortId}.md.enc`;
  const today = new Date().toISOString().slice(0, 10);
  const markdown = [
    '---',
    `title: ${sanitizeYamlLine(cleanTitle)}`,
    `created: ${sanitizeYamlLine(today)}`,
    `updated: ${sanitizeYamlLine(today)}`,
    'source: vault',
    '---',
    '',
    body,
    '',
  ].join('\n');
  const payload = privateVaultCrypto.encryptBuffer(key, markdown);
  writeAtomic(path.join(root, name), payload);
  return name;
}

function vaultPrompt(matches) {
  if (!matches.length) return '';
  return [
    'Relevant excerpts from the user\'s C.A.P.R.I knowledge base. Use only when they answer the request; do not claim they are facts about the user. Fresh user corrections in the current chat and newer dated notes take priority over older archive descriptions; cite source and date when answering from memory:',
    ...matches.map((n) => {
      const src = n.file || n.source || 'Vault';
      const date = n.updated || n.created || 'н/д';
      return `- ${n.title}: ${n.text.replace(/\s+/g, ' ')} [источник: ${src}, дата: ${date}]`;
    }),
  ].join('\n');
}

// _Память.md: every note, by kind, as links Obsidian follows
function writeIndex(dir, notes = list(dir)) {
  const lines = ['# Что я помню', '', 'Это мои заметки о тебе. Правь или удаляй любую: что в файлах, то я и помню. — Капри', ''];
  for (const type of TYPES) {
    const of = notes.filter((n) => n.type === type);
    if (!of.length) continue;
    lines.push(`## ${type[0].toUpperCase()}${type.slice(1)}`, '');
    for (const n of of) lines.push(`- [[${n.title}]] — ${n.text.split('\n')[0].slice(0, 120)}`);
    lines.push('');
  }
  fs.writeFileSync(path.join(dir, INDEX), lines.join('\n'), 'utf8');
}

// A fact kept: a new note, or the one with that title brought up to date. Returns its title (null: nothing).
function write(dir, { title, type, text }, today = new Date().toISOString().slice(0, 10)) {
  const name = fileName(title);
  const body = String(text || '').trim().slice(0, MAX_TEXT);
  if (!name || !body) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  let created = today;
  try {
    created = parse(fs.readFileSync(file, 'utf8')).meta['создано'] || today;
  } catch {
    // a new one
  }
  const kind = TYPES.includes(type) ? type : 'о тебе';
  fs.writeFileSync(file, `---\nтип: ${kind}\nсоздано: ${created}\nобновлено: ${today}\n---\n${body}\n`, 'utf8');
  writeIndex(dir);
  return name;
}

// Notes from her planner (kind 'note', from you, Claude or Codex): a branch of their own in the vault,
// <vault>/Планировщик, next to her Capri/ memory and not in it, one note each, _Планировщик.md linking them.
const PLAN_DIR = 'Планировщик';
const PLAN_INDEX = '_Планировщик.md';
const vaultRoot = (dir) => (path.basename(dir).toLowerCase() === 'capri' ? path.dirname(dir) : dir);

function writePlanIndex(folder) {
  const notes = fs.readdirSync(folder).filter((n) => n.endsWith('.md') && !n.startsWith('_')).map((name) => {
    const { meta, text } = parse(fs.readFileSync(path.join(folder, name), 'utf8'));
    return { title: name.slice(0, -3), created: meta['создано'] || '', text };
  }).sort((a, b) => b.created.localeCompare(a.created));
  const lines = ['# Заметки планировщика', '', 'Что ты, Claude или Codex записали в планировщик Капри. Правь как обычные заметки.', ''];
  for (const n of notes) lines.push(`- ${n.created} [[${n.title}]] — ${n.text.split('\n').find((l) => l && !l.startsWith('[['))?.slice(0, 120) || ''}`);
  fs.writeFileSync(path.join(folder, PLAN_INDEX), `${lines.join('\n')}\n`, 'utf8');
}

/** A planner note as an Obsidian note; a title already taken gets a number. Returns its path in the vault. */
function writePlanNote(dir, { title, notes: text, createdAt }) {
  const base = fileName(title);
  if (!base) return null;
  const folder = path.join(vaultRoot(dir), PLAN_DIR);
  fs.mkdirSync(folder, { recursive: true });
  let name = base;
  for (let n = 2; fs.existsSync(path.join(folder, `${name}.md`)); n++) name = `${base} (${n})`;
  const d = new Date(createdAt || Date.now()); // your day, not UTC's: after midnight here is still yesterday there
  const created = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const body = String(text || '').trim() || String(title).trim();
  fs.writeFileSync(path.join(folder, `${name}.md`), `---\nтип: заметка планировщика\nсоздано: ${created}\n---\n${body}\n\n[[${PLAN_INDEX.slice(0, -3)}]]\n`, 'utf8');
  writePlanIndex(folder);
  return `${PLAN_DIR}/${name}.md`;
}

// The vault laid out the Karpathy way, next to what's there: <vault>/Сырьё (raw: your talks with her, a
// file a day; her Capri/ notes are what she makes of them, the wiki) and <vault>/Результаты (outputs:
// what Claude and Codex made for you, a note each, _Результаты.md linking them; her vault search finds them).
const RAW_DIR = 'Сырьё';
const OUT_DIR = 'Результаты';
const OUT_INDEX = '_Результаты.md';
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** One exchange with her, added to today's file in <vault>/Сырьё/Чаты. Returns its path in the vault. */
function appendChat(dir, { said, answer, by = 'Капри', at = Date.now() }) {
  const you = String(said || '').trim();
  const her = String(answer || '').trim();
  if (!you || !her) return null;
  const d = new Date(at);
  const folder = path.join(vaultRoot(dir), RAW_DIR, 'Чаты');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${localDay(d)}.md`);
  const head = fs.existsSync(file) ? '' : `---\nтип: разговор\nдата: ${localDay(d)}\n---\n# Разговоры ${localDay(d)}\n`;
  fs.appendFileSync(file, `${head}\n### ${localTime(d)} · Ты\n${you.slice(0, 4000)}\n\n**${by}:** ${her.slice(0, 8000)}\n`, 'utf8');
  return `${RAW_DIR}/Чаты/${localDay(d)}.md`;
}

/**
 * Her web search, written down for you to look through later: <vault>/Сырьё/Поиск/<day>.md, one entry per
 * question — when, how (browser/profile or search server), every result she got, which pages she read,
 * which asked "are you human?", what she answered or why she couldn't. Returns its path in the vault.
 */
function appendSearch(dir, { question, via, results = [], read = [], blocked = [], answer = '', error = '', at = Date.now() }) {
  const q = String(question || '').trim();
  if (!q) return null;
  const d = new Date(at);
  const folder = path.join(vaultRoot(dir), RAW_DIR, 'Поиск');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${localDay(d)}.md`);
  const head = fs.existsSync(file) ? '' : `---\nтип: поиск\nдата: ${localDay(d)}\n---\n# Поиск Капри ${localDay(d)}\n\nЧто она искала в интернете, где и что прочитала. Пишется само; правь и удаляй как хочешь.\n`;
  const readSet = new Set(read);
  const blockedSet = new Set(blocked);
  const mark = (u) => (blockedSet.has(u) ? '⛔ проверка «не робот»' : readSet.has(u) ? '📖 прочитана' : '· только описание');
  const list = results.map((r, i) => `${i + 1}. [${String(r.title || r.url).replace(/[[\]]/g, '')}](${r.url}) — ${mark(r.url)}`).join('\n');
  const said = error ? `**Не вышло:** ${String(error).slice(0, 500)}` : `**Ответ:** ${String(answer || '—').trim().slice(0, 6000)}`;
  fs.appendFileSync(file, `${head}\n## ${localTime(d)} · ${q.slice(0, 300)}\n*Через:* ${via}\n\n${list || '_результатов нет_'}\n\n${said}\n`, 'utf8');
  return `${RAW_DIR}/Поиск/${localDay(d)}.md`;
}

function writeOutIndex(folder) {
  const rows = fs.readdirSync(folder).filter((n) => n.endsWith('.md') && !n.startsWith('_')).sort().reverse()
    .map((name) => `- [[${name.slice(0, -3)}]]`);
  fs.writeFileSync(path.join(folder, OUT_INDEX), `# Результаты\n\nЧто Claude, Codex и Antigravity сделали по твоим просьбам через Капри и GENESIS HUB.\n\n${rows.join('\n')}\n`, 'utf8');
}

/** What a worker did for you, as a note in <vault>/Результаты. Returns its path in the vault. */
function writeOutput(dir, { worker, task, answer, folder: workFolder, artifacts = [], at = Date.now() }) {
  const body = String(answer || '').trim();
  const asked = String(task || '').trim();
  if (!body || !asked) return null;
  const d = new Date(at);
  const folder = path.join(vaultRoot(dir), OUT_DIR);
  fs.mkdirSync(folder, { recursive: true });
  const base = fileName(`${localDay(d)} ${pad(d.getHours())}-${pad(d.getMinutes())} ${asked.slice(0, 50)}`);
  let name = base;
  for (let n = 2; fs.existsSync(path.join(folder, `${name}.md`)); n++) name = `${base} (${n})`;
  const artLines = Array.isArray(artifacts) && artifacts.length
    ? `\n\n**Созданные файлы:**\n${artifacts.map((a) => `- \`${typeof a === 'string' ? a : a.name}\``).join('\n')}`
    : '';
  const files = workFolder ? `\n\nФайлы — в папке ${workFolder}` : '';
  fs.writeFileSync(path.join(folder, `${name}.md`),
    `---\nтип: результат\nкто: ${worker}\nсоздано: ${localDay(d)}\n---\n**Задача:** ${asked.slice(0, 2000)}\n\n${body.slice(0, 20000)}${artLines}${files}\n\n[[${OUT_INDEX.slice(0, -3)}]]\n`, 'utf8');
  writeOutIndex(folder);
  return `${OUT_DIR}/${name}.md`;
}

// Russian words are matched on their first five letters ("проекта", "проекту" -> "проек")
const stems = (s) => new Set(String(s || '').toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я0-9]{3,}/g)?.map((w) => w.slice(0, 5)) || []);

// What she has in mind for this message: her notes about you, and the ones that share words with it
function recall(notes, said, { matchedOnly = false } = {}) {
  const words = stems(said);
  const scored = notes.map((n) => {
    const title = stems(n.title);
    const text = stems(n.text);
    let score = 0;
    for (const w of words) score += (title.has(w) ? 2 : 0) + (text.has(w) ? 1 : 0);
    return { n, score };
  });
  const matched = scored.filter((s) => s.score >= (matchedOnly ? 2 : 1)).sort((a, b) => b.score - a.score).slice(0, MATCHED).map((s) => s.n);
  if (matchedOnly) return matched;
  const about = notes.filter((n) => n.type === 'о тебе' && !matched.includes(n))
    .sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, ALWAYS);
  return [...matched, ...about];
}

// Her notes, as said in her prompt
function prompt(notes) {
  if (!notes.length) return '';
  return [
    // written to the user ("ты"): said plainly that "ты" there is them, or her model takes the facts as hers
    'Facts about the USER from your notes (in them "ты" means the user, never you). Fresh user corrections in the current conversation override older notes; use them when they fit and answer from them, e.g. "your favourite X is Y"; never read them out as a list:',
    ...notes.map((n) => `- about the user, ${n.title}: ${n.text.replace(/\s+/g, ' ')} [источник: Capri/${n.title}.md, дата: ${n.updated || 'н/д'}]`),
  ].join('\n');
}

// After a conversation: what's worth keeping, asked of her own model as JSON. Only what the user said
// counts (not what she read off the screen or a page: that's not theirs to vouch for).
const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, type: { type: 'string', enum: TYPES }, text: { type: 'string' }, quote: { type: 'string' } },
        required: ['title', 'type', 'text'],
      },
    },
  },
  required: ['facts'],
};

function extractMessages(conversation, known, today = new Date().toISOString().slice(0, 10)) {
  const said = conversation.filter((m) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .map((m) => `${m.role === 'user' ? 'USER' : 'CAPRI'}: ${m.content.slice(0, 800)}`).join('\n');
  return [
    {
      role: 'system',
      content: [
        'You keep the long-term memory of Capri, a desktop companion, as short notes in Russian.',
        'From the conversation, pick at most 3 concrete facts worth remembering for weeks: the user name, work, projects, people and pets in their life, plans and dates, agreements with Capri, things they like or dislike.',
        'Only what the USER said or clearly confirmed, stated plainly. Never guesses about their mood, character or intentions. Never facts from text Capri read on the screen, in files or on the web. Skip small talk, jokes, tests, one-off requests, anything already known unchanged.',
        'title: 2-5 words in Russian naming the fact itself, not its kind (reuse an existing title exactly to update that note). type: one of "о тебе", "проект", "договорённость", "вкус". text: 1-2 short sentences in Russian addressed to the user as "ты" (never "пользователь").',
        'Example: {"facts": [{"title": "Кот Барсик", "type": "о тебе", "text": "У тебя кот Барсик, рыжий, ему три года."}, {"title": "Любит синтвейв", "type": "вкус", "text": "Тебе нравится синтвейв, особенно под работу."}]}',
        `Today is ${today}: write dates as dates ("4 ноября 2026"), never "завтра" or "на следующей неделе", which mean nothing a week later.`,
        'Nothing concrete worth keeping: {"facts": []}. That is the usual answer.',
      ].join('\n'),
    },
    { role: 'user', content: `Notes she already has: ${known.length ? known.join('; ') : 'none'}\n\nConversation:\n${said}` },
  ];
}

// The facts in her model's answer, checked: [{ title, type, text, quote? }]
function parseFacts(answer) {
  try {
    const { facts } = JSON.parse(answer);
    return (Array.isArray(facts) ? facts : [])
      .filter((f) => f && typeof f.title === 'string' && typeof f.text === 'string' && fileName(f.title) && f.text.trim())
      .filter((f) => !TYPES.includes(f.title.trim().toLowerCase())) // a title that's only its kind says nothing
      .map((f) => ({
        ...f,
        ...(typeof f.quote === 'string' && f.quote.trim() ? { quote: f.quote.trim() } : {}),
      }))
      .slice(0, 3);
  } catch {
    return [];
  }
}

function sanitizeYamlLine(val) {
  const oneLine = String(val ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return JSON.stringify(oneLine);
}

function writeUniquePendingFile(pendingDir, baseName, content) {
  for (let index = 1; index < 1000; index += 1) {
    const candidate = index === 1 ? baseName : `${baseName}-${index}`;
    const fullPath = path.join(pendingDir, `${candidate}.md`);
    try {
      fs.writeFileSync(fullPath, content, { encoding: 'utf8', flag: 'wx' });
      return { name: candidate, filePath: fullPath };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`Too many pending_review name collisions for ${baseName}`);
}

function writePendingCandidate(dir, payload = {}, today = new Date().toISOString().slice(0, 10)) {
  if (!dir || !payload || typeof payload !== 'object') return null;
  const topic = String(payload.topic || payload.title || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const source = String(payload.source || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const link = String(payload.link || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  const quote = String(payload.quote || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const claim = String(payload.text || payload.claim || '').trim().slice(0, MAX_TEXT);

  if (!topic || !source || !link || !quote || !claim) return null;

  const baseName = fileName(topic);
  if (!baseName) return null;

  const pendingDir = path.join(vaultRoot(dir), PENDING_REVIEW_DIR);
  fs.mkdirSync(pendingDir, { recursive: true });

  const layer = memoryRag.classifyShelf(payload);
  const created = String(today || new Date().toISOString().slice(0, 10)).trim();
  const uid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const slug = baseName.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'card';
  const id = String(payload.id || `${slug}-${uid}`).trim();

  const frontmatter = [
    '---',
    `id: ${sanitizeYamlLine(id)}`,
    'status: candidate',
    `layer: ${sanitizeYamlLine(layer)}`,
    `topic: ${sanitizeYamlLine(topic)}`,
    `source: ${sanitizeYamlLine(source)}`,
    `link: ${sanitizeYamlLine(link)}`,
    `quote: ${sanitizeYamlLine(quote)}`,
    `created: ${sanitizeYamlLine(created)}`,
    '---',
    '',
    claim,
    '',
  ].join('\n');

  const { name } = writeUniquePendingFile(pendingDir, baseName, frontmatter);
  return name;
}

module.exports = {
  INDEX, TYPES, EXTRACT_SCHEMA, PLAN_DIR, RAW_DIR, OUT_DIR, PENDING_REVIEW_DIR, dirOf, fileName, list, searchVault, searchPrivateVault, savePrivateChat, savePrivateNote, write, writePendingCandidate, writeIndex, writePlanNote,
  appendChat, appendSearch, writeOutput,
  recall, prompt, vaultPrompt, extractMessages, parseFacts,
};
