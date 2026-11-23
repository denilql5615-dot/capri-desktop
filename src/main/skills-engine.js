'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { estimateTokens } = require('./context-stats');

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,40}$/;
const MAX_LOCAL_SKILL_CHARS = 5500;
const MAX_CLOUD_SKILL_CHARS = 14000;
const MAX_INSTALL_FILE_BYTES = 512 * 1024;
const AUTO_PICK_MIN_HITS = 2;
const SOFT_LIMIT_TOKENS = 4000;

const QUICK_TOGGLES = Object.freeze(['i-have-adhd', 'caveman', 'second-brain']);

const SKILL_CATEGORIES = Object.freeze([
  { id: 'style', title: 'Стиль и мышление' },
  { id: 'memory', title: 'Память и Obsidian' },
  { id: 'docs', title: 'Документы и исследования' },
  { id: 'creative', title: 'Дизайн, маркетинг и геймдев' },
  { id: 'system', title: 'Система и мастерская' },
]);

const CATEGORY_TITLE_MAP = new Map(SKILL_CATEGORIES.map((c) => [c.id, c.title]));

const SKILL_CATEGORY_BY_ID = Object.freeze({
  // 1) style
  caveman: 'style',
  'i-have-adhd': 'style',
  'second-brain': 'style',
  'russian-editor': 'style',
  humanizer: 'style',
  'stop-slop': 'style',
  think: 'style',
  morning: 'style',
  // 2) memory
  'import-memory': 'memory',
  'obsidian-markdown': 'memory',
  'obsidian-bases': 'memory',
  'obsidian-cli': 'memory',
  'json-canvas': 'memory',
  canvas: 'memory',
  defuddle: 'memory',
  knap: 'memory',
  wiki: 'memory',
  'wiki-cli': 'memory',
  'wiki-fold': 'memory',
  'wiki-ingest': 'memory',
  'wiki-lint': 'memory',
  'wiki-mode': 'memory',
  'wiki-query': 'memory',
  'wiki-retrieve': 'memory',
  save: 'memory',
  autoresearch: 'memory',
  // 3) docs
  docx: 'docs',
  pdf: 'docs',
  pptx: 'docs',
  xlsx: 'docs',
  docs: 'docs',
  'google-workspace': 'docs',
  'research-method': 'docs',
  // 4) creative
  'unslop-gemini': 'creative',
  'web-gemini-code': 'creative',
  'impeccable-ui': 'creative',
  marketingskills: 'creative',
  'game-studios-reference': 'creative',
  // 5) system
  'skill-creator': 'system',
  'skill-installer': 'system',
  'computer-use': 'system',
  'agent-desktop': 'system',
  'cli-anything': 'system',
  chapar: 'system',
  kensaku: 'system',
  // Ponytail 5 pack (core in style, companions in system)
  ponytail: 'style',
  'ponytail-audit': 'system',
  'ponytail-review': 'system',
  'ponytail-debt': 'system',
  'ponytail-gain': 'system',
  'ponytail-help': 'system',
});

const SKILL_ICON_BY_CATEGORY = Object.freeze({
  style: 'sparkles',
  memory: 'database',
  docs: 'file-text',
  creative: 'layers',
  system: 'wrench',
});

const EXCLUDED_SKILLS = new Set([
  'blender-model-qa',
  'lowpoly-character-pro',
  'built-in-browser',
  'chrome-browser',
]);

const CLOUD_ONLY_SKILLS = new Set([
  'google-workspace',
  'web-gemini-code',
  'autoresearch',
  'skill-installer',
]);

const VAULT_ONLY_SKILLS = new Set([
  'import-memory',
  'morning',
  'save',
  'obsidian-markdown',
  'obsidian-bases',
  'obsidian-cli',
  'json-canvas',
  'canvas',
  'defuddle',
  'knap',
]);

const VAULT_WRITE_SKILLS = new Set(['save', 'wiki-ingest']);

const STAGE_NOTES = Object.freeze({
  'computer-use': 'Требует инструмент ПК · 2.5',
  'agent-desktop': 'Этап 2.5 (памятка)',
  'cli-anything': 'Этап 2.5 (памятка)',
  chapar: 'Этап 2.5 (памятка)',
  kensaku: 'Этап 2.5 (памятка)',
});

const LIGHTWEIGHT_PINNABLE_IDS = new Set([
  'caveman',
  'i-have-adhd',
  'second-brain',
  'russian-editor',
  'stop-slop',
  'think',
  'ponytail',
]);

// Distilled inline prompts (~180-320 tokens each) so alwaysOn skills never bloat the context window.
const DISTILLED_ALWAYS_ON = Object.freeze({
  caveman: [
    'Навык caveman (активен постоянно):',
    'Отвечай предельно сжато: сначала прямой ответ/результат, потом причина и следующий шаг. Убирай приветствия, воду, вводные обороты, пересказы и вежливые концовки.',
    'Сохраняй дословно пути, команды, код, числа, ошибки и отрицания — ясность важнее сжатия. Для предупреждений о необратимых/опасных действиях переходи на обычный ясный язык.',
  ].join(' '),
  'i-have-adhd': [
    'Навык i-have-adhd (активен постоянно):',
    'Первая строка — конкретное следующее действие (команда, путь или один шаг), без длинного вступления. Многошаговые задачи давай коротким нумерованным списком по одному действию на пункт с реальной оценкой времени в минутах/часах.',
    'Напоминай текущее состояние, не уходи в ответвления и не перегружай стенами текста.',
  ].join(' '),
  'second-brain': [
    'Навык second-brain (активен постоянно):',
    'Оценивай идеи, планы и решения строго по логике, фактам и контексту, без автоматического поддакивания и лести. Начинай с прямого вердикта одной фразой (верно / неверно / частично верно).',
    'Если в логике есть ошибка, когнитивное искажение или скрытый риск — назови его прямо и аргументируй фактами. Если идея сильная — подтверди кратко без выдуманных минусов. Если данных не хватает — скажи каких.',
  ].join(' '),
  'russian-editor': [
    'Навык russian-editor (активен постоянно):',
    'Пиши и правь по-русски живо, конкретно и естественно, без нейросетевых штампов и канцелярита («важно отметить», «стоит подчеркнуть», «является», «данный», «таким образом»).',
    'Избегай искусственных триад, пустых антитез «не А, а Б», симметричных абзацев и финальных пересказов. Режь лишнее и сохраняй авторский тон.',
  ].join(' '),
  'stop-slop': [
    'Навык stop-slop (активен постоянно):',
    'Убирай шаблонные AI-обороты из текста: пустые зачины, наречия-усилители, формулы «not X, it is Y», перечисления по три для ритма, пассивный залог без субъекта и длинные тире без нужды.',
    'Пиши активным залогом, конкретными фактами и с живым чередованием длины фраз.',
  ].join(' '),
  think: [
    'Навык think (активен постоянно для сложных решений):',
    'Перед выводами разделяй факты на: Наблюдаемое (подтверждено кодом/тестом/данными), Выведенное (с мостом логики), Неизвестное (чего не хватает) и Предпочтение.',
    'Не выдумывай ссылки, результаты тестов и уверенность; кратко фиксируй компромиссы и риски.',
  ].join(' '),
  ponytail: [
    'Навык ponytail (активен для кода):',
    'Выбирай минимальное рабочее решение: 1) нужно ли это вообще; 2) есть ли уже в кодовой базе; 3) stdlib/платформа; 4) установленная зависимость; 5) минимальный новый код без лишних обёрток и абстракций.',
    'Никогда не режь валидацию, безопасность, обработку потерь данных и точечный тест для сложной логики. В конце назови в одну строку, что пропущено или не проверено.',
  ].join(' '),
});

const STAGE_25_BUILTIN_SKILLS = Object.freeze([
  {
    id: 'agent-desktop',
    name: 'agent-desktop',
    description: 'CLI автоматизации интерфейса Windows (окна, UI Automation, клики, ввод) — памятка этапа 2.5',
    body: [
      '# agent-desktop (Памятка, Этап 2.5)',
      'Назначение: управление окнами и элементами интерфейса Windows через одобренный CLI `agent-desktop` (дерево доступности UI Automation, фокус, клики, ввод текста).',
      'Правила: не придумывай ссылки на элементы — сначала сними дерево/снимок окна; для отправки сообщений, удаления и необратимых действий обязательно спрашивай подтверждение пользователя.',
      'Фактический запуск на ПК подключается на этапе 2.5.',
    ].join('\n'),
  },
  {
    id: 'cli-anything',
    name: 'cli-anything',
    description: 'Генератор CLI-обёрток (harness) для десктопных программ без готового API — памятка этапа 2.5',
    body: [
      '# cli-anything (Памятка, Этап 2.5)',
      'Назначение: генерация структурированных CLI-обёрток и сценариев автоматизации для локальных десктопных приложений.',
      'Используй для задач интеграции программ без встроенного CLI/MCP; не путай с прямым управлением GUI (`agent-desktop`). Фактический запуск подключается на этапе 2.5.',
    ].join('\n'),
  },
  {
    id: 'chapar',
    name: 'chapar',
    description: 'Локальный CLI-клиент API (`C:\\Capri_Tools\\chapar\\chapar-cli.exe`: HTTP/gRPC/GraphQL/WS) — памятка этапа 2.5',
    body: [
      '# chapar (Памятка, Этап 2.5)',
      'Путь: `C:\\Capri_Tools\\chapar\\chapar-cli.exe`.',
      'Назначение: лёгкий локальный терминальный клиент для проверки HTTP/REST, GraphQL, gRPC и WebSocket эндпоинтов без запуска браузера или тяжёлых GUI-клиентов.',
      'Секреты и токены в логи и историю не печатать. Полная интеграция в исполнение — этап 2.5.',
    ].join('\n'),
  },
  {
    id: 'kensaku',
    name: 'kensaku',
    description: 'Быстрый локальный поиск по файлам и документам (`D:\\Capri\\tools\\kensaku\\kensaku-cli-windows-x86_64.exe`) — памятка этапа 2.5',
    body: [
      '# kensaku (Памятка, Этап 2.5)',
      'Путь: `D:\\Capri\\tools\\kensaku\\kensaku-cli-windows-x86_64.exe`.',
      'Назначение: быстрый локальный индексный/полнотекстовый поиск по файлам и документам на ПК.',
      'В изолированных режимах (`private`, `nsfw`, `tor`, `ephemeral`) результаты локальных документов не передавать в облако. Полное подключение — этап 2.5.',
    ].join('\n'),
  },
]);

const DEFAULT_PACK_DEFS = Object.freeze([
  {
    id: 'impeccable-ui',
    dir: 'C:\\Capri_Tools\\impeccable-ui',
    category: 'creative',
    description: 'Пак UI/UX-дизайна (impeccable): аудит, полировка, типографика, цвет, анимация и адаптив',
  },
  {
    id: 'marketingskills',
    dir: 'C:\\Capri_Tools\\marketingskills',
    category: 'creative',
    description: 'Пак маркетинга и роста: копирайтинг, лендинги, SEO, запуск, воронки и позиционирование',
  },
  {
    id: 'game-studios-reference',
    dir: 'C:\\Capri_Tools\\game-studios-reference',
    category: 'creative',
    description: 'Пак разработки игр: баланс, GDD, дизайн уровней, экономика, QA и архитектура',
  },
]);

// Bilingual keyword hints for Russian user requests matching English sub-skill slugs inside Smart Packs.
const PACK_KEYWORD_ALIASES = Object.freeze({
  // impeccable-ui
  ui: ['impeccable', 'shape', 'layout', 'polish', 'design'],
  ux: ['critique', 'clarify', 'onboard', 'shape'],
  интерфейс: ['impeccable', 'layout', 'polish', 'shape', 'audit'],
  дизайн: ['impeccable', 'new-work', 'shape', 'colorize', 'typeset'],
  полировк: ['polish', 'craft-floor', 'critique'],
  анимац: ['animate', 'delight'],
  шрифт: ['typeset'],
  типограф: ['typeset'],
  цвет: ['colorize'],
  верстк: ['layout', 'adapt'],
  адаптив: ['adapt', 'layout'],
  мобил: ['adapt', 'android', 'ios'],
  аудит: ['audit', 'critique'],
  критик: ['critique', 'audit'],
  оптимиз: ['optimize'],
  текст: ['clarify', 'copywriting', 'copy-editing'],
  онбординг: ['onboard'],
  // marketingskills
  маркетинг: ['marketing-ideas', 'launch-strategy', 'gtm', 'copywriting'],
  лендинг: ['page-cro', 'copywriting', 'signup-flow-cro'],
  конверс: ['page-cro', 'signup-flow-cro', 'onboarding-cro', 'ab-test-setup'],
  копирайт: ['copywriting', 'copy-editing', 'ad-creative'],
  реклам: ['paid-ads', 'ad-creative'],
  письм: ['email-sequence', 'cold-email'],
  рассыл: ['email-sequence'],
  цена: ['pricing-strategy', 'paywall-upgrade-cro'],
  тариф: ['pricing-strategy', 'paywall-upgrade-cro'],
  сео: ['seo-audit', 'ai-seo', 'programmatic-seo', 'schema-markup'],
  seo: ['seo-audit', 'ai-seo', 'programmatic-seo', 'schema-markup'],
  запуск: ['launch-strategy', 'product-hunt', 'marketing-ideas'],
  соцсет: ['social-content'],
  аналитик: ['analytics-tracking', 'ab-test-setup'],
  // game-studios-reference
  игр: ['game-design', 'gdd', 'balance-check', 'level-design', 'playtest'],
  геймдев: ['game-design', 'gdd', 'balance-check', 'architecture-review'],
  баланс: ['balance-check', 'economy-design', 'progression'],
  экономик: ['economy-design', 'balance-check'],
  уровен: ['level-design', 'encounter-design'],
  уровн: ['level-design', 'encounter-design'],
  глд: ['gdd'],
  gdd: ['gdd'],
  сюжет: ['narrative-design', 'worldbuilding', 'dialogue'],
  нарратив: ['narrative-design', 'worldbuilding'],
  баг: ['bug-report', 'bug-triage', 'qa'],
  архитектур: ['architecture-decision', 'architecture-review'],
  производительн: ['performance-budget', 'profiling', 'optimize'],
});

const PACK_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'tests',
  'test',
  'oracle',
  'dist',
  'build',
  'target',
  'degraded',
  '.tmp',
]);

function unquoteYaml(val) {
  const s = String(val || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return s;
}

function parseSkillFrontmatter(markdown) {
  const text = String(markdown || '').replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!match) return { name: '', description: '', category: '', body: text.trim() };
  const yaml = match[1];
  const body = (match[2] || '').trim();
  const lines = yaml.split(/\r?\n/);
  const meta = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const rawVal = kv[2].trim();
    if (rawVal === '>' || rawVal === '|' || rawVal === '>-' || rawVal === '|-') {
      const block = [];
      let j = i + 1;
      while (j < lines.length && (/^\s+/.test(lines[j]) || lines[j].trim() === '')) {
        block.push(lines[j].replace(/^\s+/, ''));
        j += 1;
      }
      i = j - 1;
      meta[key] = block.join(' ').replace(/\s+/g, ' ').trim();
    } else {
      meta[key] = unquoteYaml(rawVal);
    }
  }
  return {
    name: String(meta.name || '').trim(),
    description: String(meta.description || '').trim(),
    category: String(meta.category || '').trim().toLowerCase(),
    source: String(meta.source || '').trim().toLowerCase(),
    body,
  };
}

function normalizeSlug(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, '-')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

function isValidSlug(slug) {
  return SLUG_RE.test(String(slug || ''));
}

function isVaultOnlySkill(id) {
  return VAULT_ONLY_SKILLS.has(id) || /^wiki(?:-|$)/.test(id);
}

function resolveCategory(id, explicitCategory = '') {
  if (explicitCategory && CATEGORY_TITLE_MAP.has(explicitCategory)) return explicitCategory;
  if (Object.hasOwn(SKILL_CATEGORY_BY_ID, id)) return SKILL_CATEGORY_BY_ID[id];
  if (/^wiki(?:-|$)|obsidian/.test(id)) return 'memory';
  return 'system';
}

function defaultStandaloneRoots({ home = os.homedir(), userDataDir = null, customSkillsDir = null } = {}) {
  const roots = [];
  const customDir = customSkillsDir || (userDataDir ? path.join(userDataDir, 'skills') : null);
  if (customDir) roots.push({ dir: customDir, isCustom: true });

  // 2) Antigravity / canonical root
  roots.push({ dir: path.join(home, '.gemini', 'config', 'skills'), isCustom: false });

  // 3) Codex / Claude fallback + synced/*
  roots.push({ dir: path.join(home, '.codex', 'skills'), isCustom: false });
  const claudeSkills = path.join(home, '.claude', 'skills');
  roots.push({ dir: claudeSkills, isCustom: false });

  const syncedRoot = path.join(claudeSkills, 'synced');
  try {
    const syncedEntries = fs.readdirSync(syncedRoot, { withFileTypes: true });
    for (const entry of syncedEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      roots.push({ dir: path.join(syncedRoot, entry.name), isCustom: false });
    }
  } catch {}

  return roots;
}

function readSkillEntriesFromRoot(rootDir, isCustom = false) {
  if (!rootDir) return [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillFile = path.join(rootDir, entry.name, 'SKILL.md');
    let raw;
    try {
      raw = fs.readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseSkillFrontmatter(raw);
    // A Cyrillic name normalises to nothing: then the folder name is the id.
    const fromName = normalizeSlug(parsed.name);
    const id = isValidSlug(fromName) ? fromName : normalizeSlug(entry.name);
    if (!id) continue;
    out.push({
      id,
      entryName: entry.name,
      skillFile,
      raw,
      parsed,
      isCustom: Boolean(isCustom),
      files: listSkillFiles(path.join(rootDir, entry.name)),
    });
  }
  return out;
}

function walkPackSkillFiles(rootDir, maxDepth = 5) {
  const found = [];
  const queue = [{ dir: rootDir, depth: 0, priority: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Check SKILL.md directly in dir first
    const hasSkillMd = entries.some((e) => e.isFile() && e.name === 'SKILL.md');
    if (hasSkillMd) {
      found.push(path.join(dir, 'SKILL.md'));
    }
    if (depth >= maxDepth) continue;

    // Sort so canonical directories (`skills`, `.claude`, `plugin`) come before mirror dot-folders
    const dirs = entries
      .filter((e) => e.isDirectory() && !PACK_SKIP_DIRS.has(e.name.toLowerCase()))
      .sort((a, b) => {
        const rank = (name) => {
          if (name === 'skills') return 0;
          if (name === '.claude') return 1;
          if (name === 'plugin') return 2;
          if (!name.startsWith('.')) return 3;
          return 4;
        };
        return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
      });
    for (const sub of dirs) {
      queue.push({ dir: path.join(dir, sub.name), depth: depth + 1 });
    }
  }
  return found;
}

function scanPackSubSkills(packDir) {
  if (!packDir) return [];
  try {
    if (!fs.statSync(packDir).isDirectory()) return [];
  } catch {
    return [];
  }
  const files = walkPackSkillFiles(packDir, 5);
  const bySlug = new Map();

  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseSkillFrontmatter(raw);
    const folderSlug = normalizeSlug(path.basename(path.dirname(file)));
    const slug = normalizeSlug(parsed.name || folderSlug);
    if (!slug || bySlug.has(slug)) continue;
    bySlug.set(slug, {
      slug,
      name: parsed.name || slug,
      description: String(parsed.description || '').replace(/\s+/g, ' ').trim(),
      body: parsed.body || raw,
      filePath: file,
    });
  }

  // Some packs (e.g. impeccable-ui v4.8.1) consolidate sub-commands into `reference/*.md` next to their main SKILL.md.
  if (bySlug.size === 1) {
    const primary = [...bySlug.values()][0];
    const refDir = path.join(path.dirname(primary.filePath), 'reference');
    try {
      const refEntries = fs.readdirSync(refDir, { withFileTypes: true });
      for (const entry of refEntries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const slug = normalizeSlug(entry.name.replace(/\.md$/i, ''));
        if (!slug || bySlug.has(slug)) continue;
        const refFile = path.join(refDir, entry.name);
        let raw;
        try {
          raw = fs.readFileSync(refFile, 'utf8');
        } catch {
          continue;
        }
        const parsed = parseSkillFrontmatter(raw);
        const firstLine = (parsed.body || raw)
          .split(/\r?\n/)
          .map((l) => l.replace(/^#+\s*/, '').replace(/^>\s*/, '').trim())
          .find((l) => l && !l.startsWith('**Additional context')) || slug;
        bySlug.set(slug, {
          slug,
          name: parsed.name || slug,
          description: parsed.description || firstLine.slice(0, 180),
          body: parsed.body || raw,
          filePath: refFile,
        });
      }
    } catch {}
  }

  return [...bySlug.values()];
}

// ---------------------------------------------------------------- 2.7b: attached files, auto-pick, /learn

const SKILL_FILE_EXT = new Set(['.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.xml', '.html']);
const MAX_SKILL_FILES = 12;
const MAX_ATTACH_BYTES = 512 * 1024;

/** Text files that come with a skill (references, templates, examples), next to SKILL.md, two levels deep. */
function listSkillFiles(dir) {
  const out = [];
  const walk = (cur, depth) => {
    if (depth > 2 || out.length >= MAX_SKILL_FILES) return;
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_SKILL_FILES || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (depth === 0 && e.name === 'SKILL.md') continue;
      if (!SKILL_FILE_EXT.has(path.extname(e.name).toLowerCase())) continue;
      let size = 0;
      try { size = fs.statSync(full).size; } catch { continue; }
      if (size > MAX_ATTACH_BYTES) continue;
      out.push({ rel: path.relative(dir, full).replace(/\\/g, '/'), path: full, size });
    }
  };
  walk(dir, 0);
  return out;
}

/** The skill's files as a prompt block within a char budget: every path is listed, contents go in while they fit. */
function skillFilesBlock(skill, budget) {
  const files = Array.isArray(skill?.files) ? skill.files : [];
  if (!files.length || budget < 200) return '';
  const parts = [`Файлы навыка /${skill.id} (${files.length}):`];
  let left = budget - parts[0].length;
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
    const head = `--- ${f.rel} ---`;
    if (left < head.length + 80) { parts.push(`--- ${f.rel} (не влез, путь: ${f.path})`); continue; }
    const room = left - head.length - 1;
    const body = text.length > room ? `${text.slice(0, room - 20)}\n…(обрезано)` : text;
    parts.push(`${head}\n${body}`);
    left -= head.length + body.length + 2;
  }
  return parts.join('\n');
}

const AUTO_STOP = new Set(['сделай', 'сделать', 'можешь', 'нужно', 'чтобы', 'который', 'которые', 'этого', 'этот',
  'пожалуйста', 'какой', 'какие', 'просто', 'давай', 'будет', 'всего', 'навык', 'skill', 'please', 'with', 'that',
  'this', 'from', 'have', 'what', 'когда', 'потом', 'сейчас', 'очень', 'можно', 'надо', 'тебя', 'меня']);

/** Rough stems for matching a request with a skill: Russian endings vary, so the first 5 letters of each word. */
function matchStems(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^a-zа-яё0-9]+/i)) {
    if (w.length < 4 || AUTO_STOP.has(w)) continue;
    out.add(w.slice(0, 5));
  }
  return out;
}

/** How well a request fits an own skill: distinct stems shared with its name, description and "when" list. */
function autoPickScore(skill, reqStems) {
  const target = matchStems(`${skill.name || ''} ${String(skill.id || '').replace(/[-_]/g, ' ')} ${skill.description || ''} ${skill.when || ''}`);
  let hits = 0;
  for (const st of reqStems) if (target.has(st)) hits += 1;
  return hits;
}

const LEARN_SYSTEM = [
  'Ты превращаешь удачно решённую задачу из диалога в переиспользуемый навык (рецепт) для ассистента.',
  'Бери только то, что реально было в диалоге: шаги, которые сработали, и ошибки, на которых споткнулись.',
  'Обобщи: убери частные имена файлов, даты и личные данные, оставь сам приём. Пиши по-русски, коротко.',
  'Ответь ТОЛЬКО JSON-объектом без пояснений:',
  '{"name":"Короткое имя","slug":"latin-slug","description":"Одна фраза: что делает и когда звать",',
  '"when":["признак задачи"],"steps":["шаг"],"pitfalls":["ловушка и как обойти"],"check":["как проверить результат"]}',
].join('\n');

/** The tail of a dialogue as plain text for /learn. */
function learnTranscript(history = [], maxChars = 12000) {
  const rows = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim());
  const lines = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0 && used < maxChars; i -= 1) {
    const line = `${rows[i].role === 'user' ? 'Пользователь' : 'Ассистент'}: ${String(rows[i].content).trim()}`.slice(0, 3000);
    lines.unshift(line);
    used += line.length;
  }
  return lines.join('\n\n').slice(-maxChars);
}

/** The model's JSON (maybe wrapped in prose or a code fence) as a clean recipe, or null. */
function parseLearned(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  const list = (v) => (Array.isArray(v) ? v : (v ? [v] : []))
    // Models often number the items themselves; the body numbers them again.
    .map((x) => String(x || '').replace(/\s+/g, ' ').trim().replace(/^(?:\d+[.)]|[-*•])\s+/, '')).filter(Boolean).slice(0, 12);
  const name = String(obj.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const steps = list(obj.steps);
  if (!name || !steps.length) return null;
  return {
    name,
    slug: normalizeSlug(obj.slug),
    description: String(obj.description || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    when: list(obj.when),
    steps,
    pitfalls: list(obj.pitfalls),
    check: list(obj.check),
  };
}

function learnedBody(r) {
  const sec = (title, items, numbered = false) => (items.length
    ? [`## ${title}`, ...items.map((x, i) => (numbered ? `${i + 1}. ${x}` : `- ${x}`)), ''] : []);
  return [
    `# ${r.name}`, '', r.description, '',
    ...sec('Когда применять', r.when),
    ...sec('Шаги', r.steps, true),
    ...sec('Подводные камни', r.pitfalls),
    ...sec('Проверка результата', r.check),
  ].join('\n').trim();
}

const RU_LAT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

function latinSlug(text) {
  return normalizeSlug(String(text || '').toLowerCase().replace(/[а-яё]/g, (c) => RU_LAT[c] ?? '')).slice(0, 40).replace(/[-_]+$/, '');
}

function tokenizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-zа-яё0-9_-]+/i)
    .filter((w) => w.length >= 2);
}

function matchPackSubSkills(pack, userText = '', limit = 2) {
  const subs = Array.isArray(pack?.subSkills) ? pack.subSkills : [];
  if (!subs.length) return [];
  const rawTokens = tokenizeForMatch(userText);
  const expanded = new Set(rawTokens);
  for (const tok of rawTokens) {
    for (const [prefix, aliases] of Object.entries(PACK_KEYWORD_ALIASES)) {
      if (tok.startsWith(prefix)) {
        for (const a of aliases) expanded.add(a);
      }
    }
  }

  const scored = subs.map((sub, idx) => {
    const slugLower = sub.slug.toLowerCase();
    const descLower = (sub.description || '').toLowerCase();
    const bodyPreview = (sub.body || '').slice(0, 800).toLowerCase();
    let score = 0;
    for (const tok of expanded) {
      if (slugLower === tok) score += 12;
      else if (slugLower.includes(tok)) score += 6;
      if (descLower.includes(tok)) score += 3;
      if (bodyPreview.includes(tok)) score += 1;
    }
    return { sub, score, idx };
  });

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const matched = scored.filter((s) => s.score > 0).slice(0, limit).map((s) => s.sub);
  if (matched.length > 0) return matched;
  return subs.slice(0, Math.min(1, limit));
}

function evaluateModePause(skill, { mode = 'chat', ephemeral = false } = {}) {
  const normMode = String(mode || 'chat').toLowerCase();
  const isolated = ephemeral === true || normMode === 'private' || normMode === 'nsfw' || normMode === 'tor';
  if (skill.cloudOnly && isolated) {
    return { pausedInMode: true, pauseReason: 'Пауза в изолированном режиме' };
  }
  if (skill.vaultOnly) {
    if (ephemeral === true || normMode === 'nsfw') {
      return { pausedInMode: true, pauseReason: 'Пауза во временном/18+ режиме' };
    }
    if (normMode === 'tor') {
      return { pausedInMode: true, pauseReason: 'Пауза в режиме Tor' };
    }
    if (normMode === 'private' && VAULT_WRITE_SKILLS.has(skill.id)) {
      return { pausedInMode: true, pauseReason: 'Пауза в приватном режиме' };
    }
  }
  return { pausedInMode: false, pauseReason: null };
}

function defaultSkillStateEntry(id) {
  if (id === 'second-brain') return { enabled: true, alwaysOn: true };
  return { enabled: true, alwaysOn: false };
}

class SkillsEngine {
  constructor(opts = {}) {
    this.userDataDir = opts.userDataDir || null;
    this.customSkillsDir = opts.customSkillsDir || (this.userDataDir ? path.join(this.userDataDir, 'skills') : null);
    this.explicitSkillRoots = Array.isArray(opts.skillRoots) ? opts.skillRoots : null;
    this.homeDir = opts.homeDir || os.homedir();
    this.packDefs = Array.isArray(opts.packDefs)
      ? opts.packDefs
      : DEFAULT_PACK_DEFS.map((p) => ({
        ...p,
        dir: opts.packRoots?.[p.id] ?? p.dir,
      }));
    this.includeBuiltInMemos = opts.includeBuiltInMemos !== false;
    this.getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({});
    this.saveConfig = typeof opts.saveConfig === 'function' ? opts.saveConfig : () => {};
    this._cache = null;
  }

  _scanRoots() {
    if (this.explicitSkillRoots) {
      const roots = [];
      if (this.customSkillsDir) roots.push({ dir: this.customSkillsDir, isCustom: true });
      for (const r of this.explicitSkillRoots) {
        if (r && r !== this.customSkillsDir) roots.push({ dir: r, isCustom: false });
      }
      return roots;
    }
    return defaultStandaloneRoots({
      home: this.homeDir,
      userDataDir: this.userDataDir,
      customSkillsDir: this.customSkillsDir,
    });
  }

  _loadSkills() {
    const roots = this._scanRoots();
    const rawEntries = [];
    for (const root of roots) {
      for (const entry of readSkillEntriesFromRoot(root.dir, root.isCustom)) {
        rawEntries.push(entry);
      }
    }

    const hasResearchMethod = rawEntries.some((e) => e.id === 'research-method');
    const seen = new Set();
    const items = [];

    for (const entry of rawEntries) {
      const id = entry.id;
      if (!entry.isCustom && EXCLUDED_SKILLS.has(id)) continue;
      if (id === 'deep-research' && hasResearchMethod) continue;
      if (seen.has(id)) continue;
      seen.add(id);

      const category = resolveCategory(id, entry.isCustom ? entry.parsed.category : '');
      const fullBody = entry.parsed.body || entry.raw || '';
      const rawTokens = estimateTokens(fullBody);
      const distilled = DISTILLED_ALWAYS_ON[id] || '';
      const canPinAlways = LIGHTWEIGHT_PINNABLE_IDS.has(id) || (entry.isCustom && rawTokens <= 1200);
      const alwaysOnPrompt = distilled || (canPinAlways ? fullBody.slice(0, 1200) : '');
      const alwaysOnTokens = canPinAlways ? estimateTokens(alwaysOnPrompt) : 0;

      items.push({
        id,
        name: entry.parsed.name || id,
        slash: `/${id}`,
        aliases: [],
        section: 'skills',
        kind: 'skill',
        icon: SKILL_ICON_BY_CATEGORY[category] || 'sparkles',
        category,
        categoryTitle: CATEGORY_TITLE_MAP.get(category) || 'Система и мастерская',
        description: String(entry.parsed.description || `Навык ${id}`).replace(/\s+/g, ' ').trim().slice(0, 180),
        chainable: true,
        confirmRequired: false,
        cloudOnly: CLOUD_ONLY_SKILLS.has(id),
        vaultOnly: isVaultOnlySkill(id),
        argsHint: '[запрос]',
        skillPath: entry.skillFile,
        body: fullBody,
        promptBody: fullBody.slice(0, 1200),
        tokens: rawTokens,
        canPinAlways,
        alwaysOnPrompt,
        alwaysOnTokens,
        quickSlot: QUICK_TOGGLES.includes(id) ? QUICK_TOGGLES.indexOf(id) + 1 : null,
        isPack: false,
        subCount: 0,
        subSkills: [],
        isCustom: entry.isCustom,
        learned: entry.parsed.source === 'learned',
        files: entry.files || [],
        when: (/## Когда применять\r?\n([\s\S]*?)(?:\r?\n## |$)/.exec(fullBody)?.[1] || '').slice(0, 400),
        isBuiltInMemo: false,
        stageNote: STAGE_NOTES[id] || null,
      });
    }

    // Smart Pack Skills from C:\Capri_Tools
    for (const pack of this.packDefs) {
      if (!pack?.id || !pack?.dir || seen.has(pack.id)) continue;
      const subSkills = scanPackSubSkills(pack.dir);
      if (subSkills.length === 0) continue;
      seen.add(pack.id);
      const category = resolveCategory(pack.id, pack.category);
      const primarySub = subSkills[0];
      const previewTokens = estimateTokens(primarySub?.body || pack.description);
      items.push({
        id: pack.id,
        name: pack.id,
        slash: `/${pack.id}`,
        aliases: [],
        section: 'skills',
        kind: 'skill',
        icon: SKILL_ICON_BY_CATEGORY[category] || 'layers',
        category,
        categoryTitle: CATEGORY_TITLE_MAP.get(category) || 'Дизайн, маркетинг и геймдев',
        description: pack.description,
        chainable: true,
        confirmRequired: false,
        cloudOnly: false,
        vaultOnly: false,
        argsHint: '[задача]',
        skillPath: pack.dir,
        body: primarySub?.body || pack.description,
        promptBody: (primarySub?.body || pack.description).slice(0, 1200),
        tokens: previewTokens,
        canPinAlways: false,
        alwaysOnPrompt: '',
        alwaysOnTokens: 0,
        quickSlot: null,
        isPack: true,
        subCount: subSkills.length,
        subSkills,
        isCustom: false,
        isBuiltInMemo: false,
        stageNote: null,
      });
    }

    // 4 lightweight Stage-2.5 tool reminder skills
    if (this.includeBuiltInMemos) {
      for (const memo of STAGE_25_BUILTIN_SKILLS) {
        if (seen.has(memo.id)) continue;
        seen.add(memo.id);
        const category = 'system';
        items.push({
          id: memo.id,
          name: memo.name,
          slash: `/${memo.id}`,
          aliases: [],
          section: 'skills',
          kind: 'skill',
          icon: 'wrench',
          category,
          categoryTitle: CATEGORY_TITLE_MAP.get(category),
          description: memo.description,
          chainable: true,
          confirmRequired: false,
          cloudOnly: false,
          vaultOnly: false,
          argsHint: '[запрос]',
          skillPath: '',
          body: memo.body,
          promptBody: memo.body,
          tokens: estimateTokens(memo.body),
          canPinAlways: false,
          alwaysOnPrompt: '',
          alwaysOnTokens: 0,
          quickSlot: null,
          isPack: false,
          subCount: 0,
          subSkills: [],
          isCustom: false,
          isBuiltInMemo: true,
          stageNote: STAGE_NOTES[memo.id],
        });
      }
    }

    const catOrder = new Map(SKILL_CATEGORIES.map((c, idx) => [c.id, idx]));
    items.sort((a, b) => {
      const ca = catOrder.get(a.category) ?? 99;
      const cb = catOrder.get(b.category) ?? 99;
      if (ca !== cb) return ca - cb;
      const qa = a.quickSlot ?? 99;
      const qb = b.quickSlot ?? 99;
      if (qa !== qb) return qa - qb;
      return a.name.localeCompare(b.name);
    });

    this._cache = items;
    return items;
  }

  getSkills(force = false) {
    if (!this._cache || force) return this._loadSkills();
    return this._cache;
  }

  reload() {
    return this._loadSkills();
  }

  _persistedStateMap() {
    const cfg = this.getConfig() || {};
    const raw = cfg.skillsState && typeof cfg.skillsState === 'object' ? cfg.skillsState : {};
    return raw;
  }

  getSkillToggleState(id) {
    const map = this._persistedStateMap();
    const def = defaultSkillStateEntry(id);
    const entry = map[id];
    if (!entry || typeof entry !== 'object') return def;
    const enabled = entry.enabled === undefined ? def.enabled : Boolean(entry.enabled);
    const alwaysOn = enabled && (entry.alwaysOn === undefined ? def.alwaysOn : Boolean(entry.alwaysOn));
    return { enabled, alwaysOn };
  }

  _decorateSkill(skill, { mode = 'chat', ephemeral = false } = {}) {
    const st = this.getSkillToggleState(skill.id);
    const alwaysOn = skill.canPinAlways ? (st.enabled && st.alwaysOn) : false;
    const { pausedInMode, pauseReason } = evaluateModePause(skill, { mode, ephemeral });
    return {
      id: skill.id,
      name: skill.name,
      slash: skill.slash,
      aliases: skill.aliases,
      section: 'skills',
      kind: 'skill',
      icon: skill.icon,
      category: skill.category,
      categoryTitle: skill.categoryTitle,
      description: skill.description,
      badge: skill.isPack ? `Пак · ${skill.subCount}` : (alwaysOn && !pausedInMode ? 'Всегда' : null),
      active: alwaysOn && !pausedInMode,
      chainable: true,
      confirmRequired: false,
      cloudOnly: skill.cloudOnly,
      vaultOnly: skill.vaultOnly,
      argsHint: skill.argsHint,
      enabled: st.enabled,
      alwaysOn,
      canPinAlways: skill.canPinAlways,
      quickSlot: skill.quickSlot,
      pausedInMode,
      pauseReason,
      isPack: skill.isPack,
      subCount: skill.subCount,
      isCustom: skill.isCustom,
      isBuiltInMemo: skill.isBuiltInMemo,
      learned: Boolean(skill.learned),
      filesCount: skill.files?.length || 0,
      // The menu shows stageNote as a badge: own skills say whether /learn made them and how many files they carry.
      stageNote: skill.stageNote || (skill.isCustom && (skill.learned || skill.files?.length)
        ? [skill.learned ? 'Выучен' : 'Свой', skill.files?.length ? `файлов: ${skill.files.length}` : ''].filter(Boolean).join(' · ')
        : null),
      tokens: skill.tokens,
      alwaysOnTokens: skill.alwaysOnTokens,
    };
  }

  listSkills({ mode = 'chat', ephemeral = false } = {}) {
    const rawSkills = this.getSkills(false);
    const items = rawSkills.map((sk) => this._decorateSkill(sk, { mode, ephemeral }));

    const categories = SKILL_CATEGORIES.map((cat) => ({
      id: cat.id,
      title: cat.title,
      items: items.filter((item) => item.category === cat.id),
    })).filter((cat) => cat.items.length > 0);

    const activeAlwaysOnLines = [];
    const activeIndexLines = [];
    const pinnedIds = [];

function compactIndexDesc(desc) {
  const s = String(desc || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const first = s.split(/(?<=[.!?])\s+/)[0] || s;
  return first.length <= 68 ? first : `${first.slice(0, 65).trimEnd()}…`;
}

    for (const item of items) {
      if (!item.enabled || item.pausedInMode) continue;
      if (item.alwaysOn) {
        pinnedIds.push(item.id);
        const raw = rawSkills.find((s) => s.id === item.id);
        if (raw?.alwaysOnPrompt) activeAlwaysOnLines.push(raw.alwaysOnPrompt);
      } else {
        activeIndexLines.push(`/${item.id}: ${compactIndexDesc(item.description)}`);
      }
    }

    const alwaysOnTokens = estimateTokens(activeAlwaysOnLines.join('\n\n'));
    const indexTokens = estimateTokens(activeIndexLines.join('\n'));
    const totalAutoTokens = alwaysOnTokens + indexTokens;

    return {
      mode,
      ephemeral: Boolean(ephemeral),
      categories,
      items,
      budget: {
        alwaysOnTokens,
        indexTokens,
        totalAutoTokens,
        softLimitTokens: SOFT_LIMIT_TOKENS,
        overSoftLimit: totalAutoTokens > SOFT_LIMIT_TOKENS,
        pinnedIds,
      },
      quickToggles: [...QUICK_TOGGLES],
    };
  }

  toggleSkill({ id, enabled, alwaysOn, mode = 'chat', ephemeral = false } = {}) {
    const slug = normalizeSlug(id);
    const skill = this.getSkills(false).find((s) => s.id === slug);
    if (!skill) {
      return { ok: false, error: `Навык «${id || ''}» не найден.` };
    }
    const prev = this.getSkillToggleState(slug);
    let nextEnabled = enabled === undefined ? prev.enabled : Boolean(enabled);
    let nextAlwaysOn = alwaysOn === undefined ? prev.alwaysOn : Boolean(alwaysOn);

    if (alwaysOn === true) {
      if (!skill.canPinAlways) {
        return {
          ok: false,
          error: `Навык «${skill.id}» слишком объёмный для постоянного включения — используй его точечно через /${skill.id}.`,
        };
      }
      if (enabled === undefined) nextEnabled = true;
    }
    if (!nextEnabled) {
      nextAlwaysOn = false;
    }

    const currentMap = this._persistedStateMap();
    const nextMap = {
      ...currentMap,
      [slug]: { enabled: nextEnabled, alwaysOn: nextAlwaysOn },
    };
    this.saveConfig({ skillsState: nextMap });

    const catalog = this.listSkills({ mode, ephemeral });
    const updatedItem = catalog.items.find((i) => i.id === slug);
    return {
      ok: true,
      skill: updatedItem,
      ...catalog,
    };
  }

  buildPromptContext({ mode = 'chat', ephemeral = false, explicitSkills = [], userText = '', isCloud = false } = {}) {
    const rawSkills = this.getSkills(false);
    const byId = new Map(rawSkills.map((s) => [s.id, s]));
    const decorated = rawSkills.map((s) => this._decorateSkill(s, { mode, ephemeral }));
    const decoratedById = new Map(decorated.map((d) => [d.id, d]));

    const pausedSkillIds = new Set();
    const alwaysOnBlocks = [];
    const indexLines = [];
    const activeSkillIds = new Set();

    for (const item of decorated) {
      if (!item.enabled) continue;
      if (item.pausedInMode) {
        pausedSkillIds.add(item.id);
        continue;
      }
      const raw = byId.get(item.id);
      if (item.alwaysOn && raw?.alwaysOnPrompt) {
        alwaysOnBlocks.push(raw.alwaysOnPrompt);
        activeSkillIds.add(item.id);
      } else {
        const shortDesc = String(item.description || '').replace(/\s+/g, ' ').trim();
        const first = shortDesc.split(/(?<=[.!?])\s+/)[0] || shortDesc;
        const clipped = first.length <= 68 ? first : `${first.slice(0, 65).trimEnd()}…`;
        indexLines.push(`/${item.id}: ${clipped}`);
      }
    }

    const explicitCap = isCloud ? MAX_CLOUD_SKILL_CHARS : MAX_LOCAL_SKILL_CHARS;
    const seenExplicit = new Set();
    const chosen = [];

    for (const rawSlug of Array.isArray(explicitSkills) ? explicitSkills : []) {
      const slug = normalizeSlug(rawSlug);
      if (!slug || seenExplicit.has(slug)) continue;
      seenExplicit.add(slug);

      const raw = byId.get(slug);
      const dec = decoratedById.get(slug);
      if (!raw || !dec) continue;
      if (dec.pausedInMode) {
        pausedSkillIds.add(slug);
        continue;
      }
      if (!dec.enabled) continue;
      activeSkillIds.add(slug);
      chosen.push(raw);
    }

    // 2.7b auto-pick: with no skill called by hand, own skills (made by the user or by /learn) whose
    // description fits the request come in by themselves. Built-in ones stay in the index only.
    const autoIds = [];
    if (!chosen.length && userText && this.getConfig()?.skillsAutoPick !== false) {
      const reqStems = matchStems(userText);
      if (reqStems.size >= 2) {
        const scored = decorated
          .filter((d) => d.enabled && !d.pausedInMode && !activeSkillIds.has(d.id) && byId.get(d.id)?.isCustom && !byId.get(d.id)?.isPack)
          .map((d) => ({ raw: byId.get(d.id), score: autoPickScore(byId.get(d.id), reqStems) }))
          .filter((x) => x.score >= AUTO_PICK_MIN_HITS)
          .sort((a, b) => b.score - a.score || a.raw.id.localeCompare(b.raw.id))
          .slice(0, isCloud ? 2 : 1);
        for (const { raw } of scored) {
          activeSkillIds.add(raw.id);
          autoIds.push(raw.id);
          chosen.push(raw);
        }
      }
    }

    // Stacking: several skills share one budget, so three skills never take three times the context.
    const perSkill = chosen.length ? Math.max(1200, Math.floor(explicitCap / chosen.length)) : 0;
    const blocks = chosen.map((raw) => {
      if (raw.isPack) {
        const matched = matchPackSubSkills(raw, userText, 2);
        const perSubCap = Math.max(600, Math.floor((perSkill - 200) / Math.max(1, matched.length)));
        const packParts = matched.map((sub) => (
          `## ${raw.id} / ${sub.slug}\n${String(sub.body || sub.description || '').trim().slice(0, perSubCap)}`
        ));
        return `Навык /${raw.id} (подобрано по запросу):\n${packParts.join('\n\n')}`.slice(0, perSkill);
      }
      const hasFiles = Array.isArray(raw.files) && raw.files.length > 0;
      const bodyCap = hasFiles ? Math.floor(perSkill * 0.6) : perSkill;
      const fullText = String(raw.body || raw.alwaysOnPrompt || raw.description || '').trim().slice(0, bodyCap);
      const files = hasFiles ? skillFilesBlock(raw, perSkill - fullText.length - 40) : '';
      return [`Режим ${raw.id} (/${raw.id}):\n${fullText}`, files].filter(Boolean).join('\n\n');
    });
    const explicitBlocks = blocks.slice(0, chosen.length - autoIds.length);
    const autoBlocks = blocks.slice(chosen.length - autoIds.length);
    const stackNote = explicitBlocks.length > 1
      ? 'Навыки сложены в порядке вызова; если их правила спорят, главнее тот, что вызван раньше.\n\n'
      : '';

    const alwaysOnText = alwaysOnBlocks.length
      ? `[Постоянные навыки]\n${alwaysOnBlocks.join('\n\n')}`
      : '';
    const indexText = indexLines.length
      ? `[Доступные навыки (вызов через /<имя>)]\n${indexLines.join('\n')}`
      : '';
    const explicitText = explicitBlocks.length
      ? `[Вызванные навыки]\n${stackNote}${explicitBlocks.join('\n\n')}`
      : '';
    const autoText = autoBlocks.length
      ? `[Подобранные навыки — свои, по описанию; применяй, если подходят к запросу]\n${autoBlocks.join('\n\n')}`
      : '';

    const text = [alwaysOnText, indexText, explicitText, autoText].filter(Boolean).join('\n\n');

    return {
      text,
      alwaysOnText,
      indexText,
      explicitText,
      autoText,
      autoSkillIds: autoIds,
      activeSkillIds: [...activeSkillIds],
      pausedSkillIds: [...pausedSkillIds],
      tokens: {
        alwaysOn: estimateTokens(alwaysOnText),
        index: estimateTokens(indexText),
        explicit: estimateTokens(explicitText),
        auto: estimateTokens(autoText),
        total: estimateTokens(text),
      },
    };
  }

  _requireCustomDir() {
    if (!this.customSkillsDir) {
      throw new Error('Каталог пользовательских навыков не настроен.');
    }
    fs.mkdirSync(this.customSkillsDir, { recursive: true });
    return this.customSkillsDir;
  }

  createSkill({ name, slug, category = 'system', description = '', body = '', alwaysOn = false, source = '', mode = 'chat', ephemeral = false } = {}) {
    const cleanName = String(name || '').replace(/[\r\n]+/g, ' ').trim();
    const explicitSlug = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
    const resolvedSlug = explicitSlug ? explicitSlug : normalizeSlug(cleanName);
    if (!isValidSlug(resolvedSlug)) {
      return {
        ok: false,
        error: 'Некорректный slug навыка: используй латиницу, цифры, "-" или "_" (от 2 до 41 символа).',
      };
    }
    const cleanBody = String(body || '').trim();
    if (!cleanBody) {
      return { ok: false, error: 'Инструкция навыка (body) не может быть пустой.' };
    }
    const cleanDesc = String(description || `Пользовательский навык ${cleanName || resolvedSlug}`)
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, 220);
    const normCategory = CATEGORY_TITLE_MAP.has(String(category || '').toLowerCase())
      ? String(category).toLowerCase()
      : 'system';

    const root = this._requireCustomDir();
    const dir = path.join(root, resolvedSlug);
    const file = path.join(dir, 'SKILL.md');
    fs.mkdirSync(dir, { recursive: true });

    const yamlSafe = (v) => JSON.stringify(String(v || ''));
    const md = [
      '---',
      `name: ${yamlSafe(cleanName || resolvedSlug)}`,
      `description: ${yamlSafe(cleanDesc)}`,
      `category: ${yamlSafe(normCategory)}`,
      ...(source ? [`source: ${yamlSafe(String(source).toLowerCase())}`] : []),
      '---',
      '',
      cleanBody,
      '',
    ].join('\n');

    fs.writeFileSync(file, md, 'utf8');
    this.reload();

    if (alwaysOn === true) {
      const toggled = this.toggleSkill({ id: resolvedSlug, enabled: true, alwaysOn: true, mode, ephemeral });
      if (toggled?.ok) {
        return { ok: true, path: file, ...toggled };
      }
    }

    const catalog = this.listSkills({ mode, ephemeral });
    const skill = catalog.items.find((i) => i.id === resolvedSlug);
    return {
      ok: true,
      skill,
      path: file,
      ...catalog,
    };
  }

  /** A free slug for a new own skill: never overwrites an existing skill of any kind. */
  _freeSlug(base) {
    const taken = new Set(this.getSkills(false).map((s) => s.id));
    const root = (isValidSlug(base) ? base : 'learned-skill').slice(0, 36);
    if (!taken.has(root) && !fs.existsSync(path.join(this._requireCustomDir(), root))) return root;
    for (let i = 2; i < 100; i += 1) {
      const cand = `${root}-${i}`;
      if (!taken.has(cand) && !fs.existsSync(path.join(this._requireCustomDir(), cand))) return cand;
    }
    return `${root}-${Date.now().toString(36)}`;
  }

  /** The request /learn sends to the local model. */
  learnMessages({ history = [], hint = '' } = {}) {
    const transcript = learnTranscript(history);
    return [
      { role: 'system', content: LEARN_SYSTEM },
      {
        role: 'user',
        content: [
          hint ? `Что именно закрепить: ${hint}` : 'Закрепи главный удачный приём из этого диалога.',
          '',
          '<<<диалог',
          transcript,
          'диалог>>>',
        ].join('\n'),
      },
    ];
  }

  /**
   * /learn: a successful task from the chat becomes an own skill (SKILL.md with source "learned").
   * `chat(messages)` must be a local model: the dialogue may hold private things. Isolated modes refuse.
   */
  async learnFromHistory({ history = [], hint = '', chat, mode = 'chat', ephemeral = false } = {}) {
    const normMode = String(mode || 'chat').toLowerCase();
    if (ephemeral === true || ['private', 'nsfw', 'tor'].includes(normMode)) {
      return { ok: false, error: 'В изолированном режиме навыки из диалога не сохраняю.' };
    }
    if (typeof chat !== 'function') return { ok: false, error: 'Нет локальной модели для /learn.' };
    if (!learnTranscript(history).trim()) return { ok: false, error: 'Диалог пуст — учиться не на чем.' };
    let reply;
    try {
      reply = await chat(this.learnMessages({ history, hint }));
    } catch (err) {
      return { ok: false, error: `Модель не ответила: ${err?.message || err}` };
    }
    const recipe = parseLearned(typeof reply === 'string' ? reply : reply?.content || reply?.text || '');
    if (!recipe) return { ok: false, error: 'Модель не собрала рецепт (нет имени или шагов). Попробуй /learn с подсказкой, что закрепить.' };
    const slug = this._freeSlug(recipe.slug || latinSlug(recipe.name));
    const res = this.createSkill({
      name: recipe.name,
      slug,
      description: recipe.description || `Выученный навык: ${recipe.name}`,
      body: learnedBody(recipe),
      category: 'system',
      source: 'learned',
      mode,
      ephemeral,
    });
    if (!res.ok) return res;
    return { ok: true, id: slug, name: recipe.name, description: recipe.description, path: res.path, recipe };
  }

  /** Copies text files into an own skill's references/ folder; they reach the model when the skill is used. */
  attachFiles({ id, paths = [] } = {}) {
    const skill = this.getSkills(false).find((s) => s.id === normalizeSlug(id));
    if (!skill) return { ok: false, error: `Навыка /${id} нет.` };
    if (!skill.isCustom) return { ok: false, error: `/${skill.id} — встроенный навык, файлы прикладываются только к своим.` };
    const dir = path.join(path.dirname(skill.skillPath), 'references');
    const added = [];
    const skipped = [];
    for (const src of Array.isArray(paths) ? paths : []) {
      const name = path.basename(String(src || ''));
      const ext = path.extname(name).toLowerCase();
      let size = -1;
      try { size = fs.statSync(src).size; } catch {}
      if (!SKILL_FILE_EXT.has(ext)) { skipped.push(`${name}: не текстовый файл`); continue; }
      if (size < 0 || size > MAX_ATTACH_BYTES) { skipped.push(`${name}: нет файла или больше 512 КБ`); continue; }
      fs.mkdirSync(dir, { recursive: true });
      let target = path.join(dir, name);
      for (let i = 2; fs.existsSync(target); i += 1) target = path.join(dir, `${path.basename(name, ext)}-${i}${ext}`);
      fs.copyFileSync(src, target);
      added.push(path.basename(target));
    }
    this.reload();
    const fresh = this.getSkills(false).find((s) => s.id === skill.id);
    if (fresh && (fresh.files?.length || 0) >= MAX_SKILL_FILES) skipped.push(`в подсказку попадут первые ${MAX_SKILL_FILES} файлов`);
    return { ok: added.length > 0, added, skipped, files: fresh?.files || [], error: added.length ? undefined : (skipped[0] || 'Файлы не выбраны.') };
  }

  installSkill({ sourcePath, markdown, slug, category = 'system', confirm = false, mode = 'chat', ephemeral = false } = {}) {
    let rawMarkdown = '';
    let sourceLabel = 'markdown';

    if (typeof sourcePath === 'string' && sourcePath.trim()) {
      const target = path.resolve(sourcePath.trim());
      if (!/\.md$/i.test(target)) {
        return { ok: false, error: 'Можно устанавливать только файлы Markdown (.md / SKILL.md).' };
      }
      let stat;
      try {
        stat = fs.statSync(target);
      } catch {
        return { ok: false, error: `Файл не найден: ${target}` };
      }
      if (!stat.isFile() || stat.size > MAX_INSTALL_FILE_BYTES) {
        return { ok: false, error: 'Файл навыка должен быть обычным файлом размером до 512 КБ.' };
      }
      rawMarkdown = fs.readFileSync(target, 'utf8');
      sourceLabel = target;
    } else if (typeof markdown === 'string' && markdown.trim()) {
      rawMarkdown = markdown;
    } else {
      return { ok: false, error: 'Укажи путь к SKILL.md или вставь текст Markdown.' };
    }

    const parsed = parseSkillFrontmatter(rawMarkdown);
    const parentSlug = typeof sourcePath === 'string' && sourcePath.trim()
      ? path.basename(path.dirname(path.resolve(sourcePath.trim())))
      : '';
    const explicitSlug = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
    const resolvedSlug = explicitSlug ? explicitSlug : normalizeSlug(parsed.name || parentSlug);
    if (!isValidSlug(resolvedSlug)) {
      return {
        ok: false,
        error: 'Не удалось определить корректный slug навыка (нужно 2–41 символ: a-z, 0-9, -, _).',
      };
    }

    const cleanName = parsed.name || resolvedSlug;
    const cleanDesc = String(parsed.description || `Установленный навык ${cleanName}`).replace(/\s+/g, ' ').trim().slice(0, 220);
    const bodyText = parsed.body || rawMarkdown.trim();
    if (!bodyText) {
      return { ok: false, error: 'Содержимое навыка пустое.' };
    }
    const tokens = estimateTokens(rawMarkdown);

    if (confirm !== true) {
      return {
        ok: false,
        confirmRequired: true,
        preview: {
          slug: resolvedSlug,
          name: cleanName,
          description: cleanDesc,
          tokens,
          source: sourceLabel,
        },
        message: `Подтверди установку навыка «${resolvedSlug}» (~${tokens} ток).`,
      };
    }

    const normCategory = CATEGORY_TITLE_MAP.has(String(category || parsed.category || '').toLowerCase())
      ? String(category || parsed.category).toLowerCase()
      : 'system';

    const root = this._requireCustomDir();
    const dir = path.join(root, resolvedSlug);
    const file = path.join(dir, 'SKILL.md');
    fs.mkdirSync(dir, { recursive: true });

    const yamlSafe = (v) => JSON.stringify(String(v || ''));
    const normalizedMd = [
      '---',
      `name: ${yamlSafe(cleanName)}`,
      `description: ${yamlSafe(cleanDesc)}`,
      `category: ${yamlSafe(normCategory)}`,
      '---',
      '',
      bodyText,
      '',
    ].join('\n');

    fs.writeFileSync(file, normalizedMd, 'utf8');
    this.reload();

    const catalog = this.listSkills({ mode, ephemeral });
    const skill = catalog.items.find((i) => i.id === resolvedSlug);
    return {
      ok: true,
      skill,
      path: file,
      ...catalog,
    };
  }
}

module.exports = {
  SkillsEngine,
  SKILL_CATEGORIES,
  QUICK_TOGGLES,
  CLOUD_ONLY_SKILLS,
  VAULT_ONLY_SKILLS,
  VAULT_WRITE_SKILLS,
  EXCLUDED_SKILLS,
  DISTILLED_ALWAYS_ON,
  STAGE_25_BUILTIN_SKILLS,
  DEFAULT_PACK_DEFS,
  SOFT_LIMIT_TOKENS,
  MAX_LOCAL_SKILL_CHARS,
  MAX_CLOUD_SKILL_CHARS,
  parseSkillFrontmatter,
  normalizeSlug,
  isValidSlug,
  matchPackSubSkills,
  evaluateModePause,
  defaultStandaloneRoots,
  scanPackSubSkills,
  parseLearned,
  learnedBody,
  latinSlug,
  matchStems,
  listSkillFiles,
};
