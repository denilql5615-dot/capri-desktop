// Reusable Gemini Dark Slash Command Autocomplete & Draft Catalog Modal for Capri Desktop.
// Built strictly with createElement / createElementNS (zero innerHTML with untrusted text).

const SVG_NS = 'http://www.w3.org/2000/svg';

export const INSTANT_COMMANDS = new Set([
  'status', 'usage', 'quota', 'context', 'tasks', 'tools', 'mcp',
  'skills', 'reload-skills', 'plugin', 'plugins', 'hookify',
  'connector', 'connectors', 'docker',
  'doctor', 'storage', 'permissions',
  'memory', 'help', 'find', 'free', 'today', 'mail', 'clip',
  'alta', 'agents', 'harness', 'nomad', 'web', 'tor', 'copy',
  'export', 'insights', 'stop',
]);

const CLOUD_ONLY_FALLBACK = new Set([
  'deep', 'council', 'web', 'agents', 'harness', 'ultrareview',
]);

export function parseLeadingSlash(rawText) {
  const trimmed = String(rawText || '').trimStart();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)/);
  if (!match) return null;
  const cmd = match[1].toLowerCase();
  const rest = trimmed.slice(match[0].length).trim();
  return { cmd, rest, raw: trimmed };
}

export function isInstantSlashCommand(rawText) {
  const parsed = parseLeadingSlash(rawText);
  return Boolean(parsed && INSTANT_COMMANDS.has(parsed.cmd));
}

// ---------------------------------------------------------------- monochrome SVG icon factory

const ICON_PATHS = {
  grid: [
    ['rect', { x: 3.5, y: 3.5, width: 6.5, height: 6.5, rx: 1.5 }],
    ['rect', { x: 14, y: 3.5, width: 6.5, height: 6.5, rx: 1.5 }],
    ['rect', { x: 3.5, y: 14, width: 6.5, height: 6.5, rx: 1.5 }],
    ['rect', { x: 14, y: 14, width: 6.5, height: 6.5, rx: 1.5 }],
  ],
  compact: [
    ['path', { d: 'M4 14h6v6' }],
    ['path', { d: 'M20 10h-6V4' }],
    ['path', { d: 'M14 10l7-7' }],
    ['path', { d: 'M3 21l7-7' }],
  ],
  plus: [
    ['path', { d: 'M12 5v14' }],
    ['path', { d: 'M5 12h14' }],
  ],
  gauge: [
    ['path', { d: 'M12 14l4-4' }],
    ['path', { d: 'M3.34 19a10 10 0 1 1 17.32 0' }],
  ],
  cpu: [
    ['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }],
    ['path', { d: 'M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4' }],
  ],
  sliders: [
    ['path', { d: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3' }],
    ['path', { d: 'M2 14h4M10 8h4M18 16h4' }],
  ],
  stop: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['rect', { x: 9, y: 9, width: 6, height: 6, rx: 1 }],
  ],
  refresh: [
    ['path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }],
    ['path', { d: 'M21 3v6h-6' }],
  ],
  bookmark: [
    ['path', { d: 'M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1z' }],
  ],
  download: [
    ['path', { d: 'M12 3v12' }],
    ['path', { d: 'M7 10l5 5 5-5' }],
    ['path', { d: 'M4 19h16' }],
  ],
  activity: [
    ['path', { d: 'M3 12h4l2.5-7 5 14 2.5-7H21' }],
  ],
  trash: [
    ['path', { d: 'M4 7h16' }],
    ['path', { d: 'M9 7V4h6v3' }],
    ['path', { d: 'M6 7l1 13h10l1-13' }],
  ],
  calendar: [
    ['rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2 }],
    ['path', { d: 'M8 3v4M16 3v4M3.5 10h17' }],
  ],
  bell: [
    ['path', { d: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9' }],
    ['path', { d: 'M10 21h4' }],
  ],
  mail: [
    ['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }],
    ['path', { d: 'M4 7l8 6 8-6' }],
  ],
  clipboard: [
    ['rect', { x: 6, y: 4, width: 12, height: 16, rx: 2 }],
    ['path', { d: 'M9 4V3h6v1' }],
  ],
  globe: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M3 12h18' }],
    ['path', { d: 'M12 3a13 13 0 0 1 0 18 13 13 0 0 1 0-18z' }],
  ],
  shield: [
    ['path', { d: 'M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z' }],
  ],
  book: [
    ['path', { d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22V5.5z' }],
    ['path', { d: 'M4 18.5A2.5 2.5 0 0 1 6.5 16H20' }],
  ],
  search: [
    ['circle', { cx: 11, cy: 11, r: 7 }],
    ['path', { d: 'M20 20l-3.8-3.8' }],
  ],
  list: [
    ['path', { d: 'M9 6h11M9 12h11M9 18h11' }],
    ['path', { d: 'M4 6h1M4 12h1M4 18h1' }],
  ],
  check: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M8.5 12.5l2.5 2.5 5-5.5' }],
  ],
  help: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M9.5 9.5a2.5 2.5 0 0 1 4.8.8c0 1.7-2.3 2.1-2.3 3.4' }],
    ['path', { d: 'M12 17h.01' }],
  ],
  message: [
    ['path', { d: 'M20 14a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z' }],
  ],
  sparkles: [
    ['path', { d: 'M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3z' }],
  ],
  branch: [
    ['circle', { cx: 6, cy: 6, r: 2.5 }],
    ['circle', { cx: 18, cy: 8, r: 2.5 }],
    ['circle', { cx: 6, cy: 18, r: 2.5 }],
    ['path', { d: 'M6 8.5v7M15.5 8H11a5 5 0 0 0-5 5' }],
  ],
  wrench: [
    ['path', { d: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.3 2.3-2.5-.5-.5-2.5 2.3-2.3z' }],
  ],
  plug: [
    ['path', { d: 'M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0V8zM12 16v5' }],
  ],
  puzzle: [
    ['path', { d: 'M5 8h4V5.5a1.5 1.5 0 1 1 3 0V8h4a2 2 0 0 1 2 2v3h-2.5a1.5 1.5 0 1 0 0 3H18v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z' }],
  ],
  palette: [
    ['path', { d: 'M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 1.4-3.4 2 2 0 0 1 1.4-3.4H18a3 3 0 0 0 3-3A8.2 8.2 0 0 0 12 3z' }],
  ],
  edit: [
    ['path', { d: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z' }],
  ],
  archive: [
    ['rect', { x: 3, y: 4, width: 18, height: 4, rx: 1 }],
    ['path', { d: 'M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8' }],
    ['path', { d: 'M10 12h4' }],
  ],
  eye: [
    ['path', { d: 'M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z' }],
    ['circle', { cx: 12, cy: 12, r: 2.5 }],
  ],
  database: [
    ['ellipse', { cx: 12, cy: 6, rx: 7.5, ry: 3 }],
    ['path', { d: 'M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6' }],
    ['path', { d: 'M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3' }],
  ],
  users: [
    ['circle', { cx: 9, cy: 8, r: 3 }],
    ['path', { d: 'M3.5 19a5.5 5.5 0 0 1 11 0' }],
    ['circle', { cx: 16.5, cy: 9.5, r: 2.2 }],
    ['path', { d: 'M16.5 14a4.5 4.5 0 0 1 4 4.5' }],
  ],
  clock: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 7v5l3.5 2' }],
  ],
  target: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['circle', { cx: 12, cy: 12, r: 5 }],
    ['circle', { cx: 12, cy: 12, r: 1.5 }],
  ],
  close: [
    ['path', { d: 'M6 6l12 12M18 6L6 18' }],
  ],
  'chevron-down': [
    ['path', { d: 'M6 9l6 6 6-6' }],
  ],
  layers: [
    ['path', { d: 'M12 3l9 4.5-9 4.5-9-4.5L12 3z' }],
    ['path', { d: 'M3 12l9 4.5 9-4.5' }],
    ['path', { d: 'M3 16.5l9 4.5 9-4.5' }],
  ],
  heart: [
    ['path', { d: 'M12 20.5l-1.35-1.23C5.4 14.56 2.5 11.9 2.5 8.6A4.6 4.6 0 0 1 7.1 4c1.9 0 3.6.98 4.9 2.54C13.3 4.98 15 4 16.9 4a4.6 4.6 0 0 1 4.6 4.6c0 3.3-2.9 5.96-8.15 10.67L12 20.5z' }],
  ],
  play: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M10 8.5l6 3.5-6 3.5v-7z' }],
  ],
  server: [
    ['rect', { x: 3, y: 4, width: 18, height: 6, rx: 1.5 }],
    ['rect', { x: 3, y: 14, width: 18, height: 6, rx: 1.5 }],
    ['path', { d: 'M7 7h.01M7 17h.01' }],
  ],
  send: [
    ['path', { d: 'M21 3L10 14' }],
    ['path', { d: 'M21 3l-7 18-4-7-7-4 18-7z' }],
  ],
  'file-text': [
    ['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z' }],
    ['path', { d: 'M14 3v5h5' }],
    ['path', { d: 'M9 13h6M9 17h4' }],
  ],
  terminal: [
    ['path', { d: 'M7 19l10-14' }],
  ],
  box: [
    ['path', { d: 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z' }],
    ['path', { d: 'M12 12l8-4.5M12 12v9M12 12L4 7.5' }],
  ],
  external: [
    ['path', { d: 'M14 4h6v6' }],
    ['path', { d: 'M10 14L20 4' }],
    ['path', { d: 'M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5' }],
  ],
  monitor: [
    ['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }],
    ['path', { d: 'M8 20h8M12 16v4' }],
  ],
};

const ICON_ALIAS = {
  compress: 'compact',
  new: 'plus',
  clear: 'plus',
  context: 'gauge',
  usage: 'gauge',
  quota: 'gauge',
  model: 'cpu',
  temp: 'sliders',
  effort: 'sliders',
  retry: 'refresh',
  'reload-skills': 'refresh',
  remember: 'bookmark',
  save: 'bookmark',
  pin: 'bookmark',
  export: 'download',
  status: 'activity',
  doctor: 'activity',
  delete: 'trash',
  free: 'trash',
  today: 'calendar',
  plan: 'calendar',
  schedule: 'calendar',
  remind: 'bell',
  clip: 'clipboard',
  copy: 'clipboard',
  web: 'globe',
  tor: 'shield',
  permissions: 'shield',
  nomad: 'book',
  memory: 'book',
  recap: 'book',
  deep: 'search',
  find: 'search',
  tasks: 'list',
  'plan-mode': 'list',
  verify: 'check',
  review: 'check',
  ultrareview: 'check',
  btw: 'message',
  skill: 'sparkles',
  skills: 'sparkles',
  alta: 'sparkles',
  council: 'users',
  agents: 'users',
  fork: 'branch',
  tools: 'wrench',
  mcp: 'plug',
  connector: 'plug',
  connectors: 'plug',
  plugin: 'puzzle',
  plugins: 'puzzle',
  hookify: 'shield',
  style: 'palette',
  styles: 'palette',
  'output-style': 'palette',
  draw: 'palette',
  rename: 'edit',
  focus: 'eye',
  storage: 'database',
  loop: 'clock',
  resume: 'clock',
  goal: 'target',
  simplify: 'sparkles',
  advisor: 'cpu',
  autocompact: 'compact',
  insights: 'activity',
  learn: 'book',
  'grill-me': 'message',
  harness: 'clock',
  subtask: 'branch',
  pet: 'sparkles',
  docker: 'box',
};

export function createIconSvg(name, size = 18) {
  const key = ICON_PATHS[name] ? name : (ICON_ALIAS[name] || 'terminal');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of ICON_PATHS[key]) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.appendChild(node);
  }
  return svg;
}

export function createProgressRingSvg(pct, size = 16) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = 6;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');

  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('cx', '8');
  track.setAttribute('cy', '8');
  track.setAttribute('r', String(r));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'rgba(255,255,255,0.16)');
  track.setAttribute('stroke-width', '2');

  const arc = document.createElementNS(SVG_NS, 'circle');
  arc.setAttribute('cx', '8');
  arc.setAttribute('cy', '8');
  arc.setAttribute('r', String(r));
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke', clamped >= 85 ? '#F2B8B5' : '#A8C7FA');
  arc.setAttribute('stroke-width', '2');
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('stroke-dasharray', c.toFixed(2));
  arc.setAttribute('stroke-dashoffset', offset.toFixed(2));
  arc.setAttribute('transform', 'rotate(-90 8 8)');

  svg.append(track, arc);
  return svg;
}

// ---------------------------------------------------------------- categories & fallback catalog

export const COMMAND_CATEGORIES = [
  { id: 'chat', title: 'Чат и контекст' },
  { id: 'memory', title: 'Память и заметки' },
  { id: 'modes', title: 'Поиск и режимы' },
  { id: 'system', title: 'Инструменты и диагностика' },
  { id: 'agents', title: 'Агенты и планирование' },
];

export const SKILL_CATEGORIES = [
  { id: 'style', title: 'Стиль и мышление' },
  { id: 'memory', title: 'Память и Obsidian' },
  { id: 'docs', title: 'Документы и исследования' },
  { id: 'creative', title: 'Дизайн, маркетинг и геймдев' },
  { id: 'system', title: 'Система и мастерская' },
];

export const PLUGIN_CATEGORIES = [
  { id: 'knowledge', title: 'Знания и документы' },
  { id: 'creative', title: 'Дизайн, маркетинг и геймдев' },
  { id: 'dev', title: 'Разработка и ревью' },
  { id: 'safety', title: 'Безопасность и автоматизация' },
];

export const CONNECTOR_CATEGORIES = [
  { id: 'comms', title: 'Почта, календарь и связь' },
  { id: 'knowledge', title: 'Память, знания и медиа' },
  { id: 'dev', title: 'Код, модели и инфраструктура' },
  { id: 'health', title: 'Здоровье и личный спорт' },
];

const COMMAND_CATEGORY_TITLES = Object.fromEntries(COMMAND_CATEGORIES.map((c) => [c.id, c.title]));
const SKILL_CATEGORY_TITLES = Object.fromEntries(SKILL_CATEGORIES.map((c) => [c.id, c.title]));
const PLUGIN_CATEGORY_TITLES = Object.fromEntries(PLUGIN_CATEGORIES.map((c) => [c.id, c.title]));
const CONNECTOR_CATEGORY_TITLES = Object.fromEntries(CONNECTOR_CATEGORIES.map((c) => [c.id, c.title]));

const PLUGIN_ICON_BY_ID = {
  'obsidian-wiki-pack': 'book',
  'docs-office-pack': 'clipboard',
  'impeccable-ui-pack': 'palette',
  'marketing-pack': 'target',
  'gamedev-pack': 'layers',
  'genesis-review-pack': 'check',
  'capri-hooks-pack': 'plug',
  'chrome-devtools': 'globe',
  'android-dev': 'cpu',
  'developer-docs': 'book',
  'security-guard': 'shield',
  hookify: 'sliders',
};

const PLUGIN_ICON_BY_CAT = {
  knowledge: 'book',
  creative: 'palette',
  dev: 'wrench',
  safety: 'shield',
};

function pluginIconName(p) {
  if (p?.icon && (ICON_PATHS[p.icon] || ICON_ALIAS[p.icon])) return p.icon;
  return PLUGIN_ICON_BY_ID[p?.id] || PLUGIN_ICON_BY_CAT[p?.category] || 'puzzle';
}

function makeFallbackPlugin(id, name, category, description, opts = {}) {
  return {
    id,
    name,
    version: opts.version || '1.0.0',
    category,
    categoryTitle: PLUGIN_CATEGORY_TITLES[category] || '',
    description,
    enabled: opts.enabled !== false,
    pausedInMode: false,
    pauseReason: '',
    cloudOnly: Boolean(opts.cloudOnly),
    vaultOnly: Boolean(opts.vaultOnly),
    skills: opts.skills || [],
    commands: opts.commands || [],
    hooks: opts.hooks || [],
    rules: opts.rules || [],
    statusNote: opts.statusNote || '',
    health: opts.health || 'ok',
    source: opts.source || 'builtin',
    isCustom: Boolean(opts.isCustom),
    kind: 'plugin',
    section: 'plugins',
    icon: opts.icon || PLUGIN_ICON_BY_ID[id] || PLUGIN_ICON_BY_CAT[category] || 'puzzle',
  };
}

export const FALLBACK_PLUGINS = [
  makeFallbackPlugin(
    'obsidian-wiki-pack',
    'Obsidian Wiki Pack',
    'knowledge',
    'База знаний, заметки, холсты и транзакционная работа с Obsidian Vault',
    {
      vaultOnly: true,
      skills: [
        'obsidian-markdown', 'obsidian-bases', 'obsidian-cli', 'json-canvas',
        'canvas', 'defuddle', 'knap', 'wiki', 'wiki-cli', 'wiki-fold',
        'wiki-ingest', 'wiki-lint', 'wiki-mode', 'wiki-query', 'wiki-retrieve', 'save',
      ],
      commands: ['/remember', '/save', '/memory', '/find'],
      rules: ['Не перезаписывай заметки Obsidian без проверки.'],
      statusNote: '16 скиллов',
    },
  ),
  makeFallbackPlugin(
    'docs-office-pack',
    'Документы и таблицы',
    'knowledge',
    'Работа с Word (.docx), PDF, презентациями (.pptx), таблицами (.xlsx) и документами',
    {
      skills: ['docx', 'pdf', 'pptx', 'xlsx', 'docs'],
      rules: ['Проверяй верстку и кодировку при создании офисных документов.'],
      statusNote: '5 скиллов',
    },
  ),
  makeFallbackPlugin(
    'impeccable-ui-pack',
    'Impeccable UI & Gemini',
    'creative',
    'Полировка интерфейса по сетке 4px, тихий хром и строгий anti-slop',
    {
      skills: ['impeccable-ui', 'unslop-gemini'],
      rules: ['Соблюдай сетку 4px/4dp, тихий хром и запрет на визуальный слоп.'],
      statusNote: '2 скилла',
    },
  ),
  makeFallbackPlugin(
    'marketing-pack',
    'Маркетинг и питчи',
    'creative',
    'Фреймворки позиционирования, описаний, лендингов и питчей',
    {
      skills: ['marketingskills'],
      statusNote: '1 пак',
    },
  ),
  makeFallbackPlugin(
    'gamedev-pack',
    'Геймдев и баланс',
    'creative',
    'Справочник игровых студий, системного геймдизайна и баланса',
    {
      skills: ['game-studios-reference'],
      statusNote: '1 пак',
    },
  ),
  makeFallbackPlugin(
    'genesis-review-pack',
    'GENESIS Review Pack',
    'dev',
    'Код-ревью, верификация, упрощение и контроль минимальных диффов',
    {
      skills: ['genesis-techlead-reviewer', 'unslop-gemini', 'stop-slop', 'second-brain'],
      commands: ['/review', '/ultrareview', '/verify', '/simplify'],
      rules: ['Минимальный обозримый дифф: одна задача — один точечный патч.'],
      statusNote: '4 скилла',
    },
  ),
  makeFallbackPlugin(
    'ponytail-pack',
    'Ponytail 5 Pack',
    'dev',
    'Минимальные диффы (YAGNI), аудит репо, код-ревью и реестр техдолга',
    {
      skills: ['ponytail', 'ponytail-audit', 'ponytail-review', 'ponytail-debt', 'ponytail-gain', 'ponytail-help'],
      commands: ['/review', '/simplify', '/verify'],
      rules: ['Ponytail: минимальное решение — сначала существующий код, stdlib и установленные пакеты.'],
      statusNote: '6 скиллов',
    },
  ),
  makeFallbackPlugin(
    'capri-hooks-pack',
    'Capri Agent Hooks',
    'dev',
    'Локальные хуки синхронизации агентов Claude, Codex и Antigravity',
    {
      hooks: ['capri-hook.js', 'capri-codex-hook.js', 'capri-agy-hook.js'],
      statusNote: '3 хука',
    },
  ),
  makeFallbackPlugin(
    'chrome-devtools',
    'Chrome DevTools',
    'dev',
    'Инспекция, отладка и профилирование веб-страниц в браузере',
    {
      statusNote: 'Плагин IDE',
    },
  ),
  makeFallbackPlugin(
    'android-dev',
    'Android CLI',
    'dev',
    'Сборка, диагностика и работа с Android-клиентом Капри',
    {
      statusNote: 'Плагин IDE',
    },
  ),
  makeFallbackPlugin(
    'developer-docs',
    'Developer Docs',
    'dev',
    'Справочная документация Google Developer Knowledge',
    {
      cloudOnly: true,
      statusNote: 'Облако',
    },
  ),
  makeFallbackPlugin(
    'security-guard',
    'Security Guard',
    'safety',
    'Защита от утечки секретов, разрушительных команд и prompt-injection',
    {
      rules: ['Всегда проверять секреты, разрушительные команды и prompt-injection.'],
      statusNote: 'Всегда активен',
    },
  ),
  makeFallbackPlugin(
    'hookify',
    'Hookify',
    'safety',
    'Пользовательские правила предупреждений, дополнений и блокировки по шаблону',
    {
      commands: ['/hookify'],
      statusNote: '0 правил',
    },
  ),
];

const CONNECTOR_ICON_BY_ID = {
  'proton-pim': 'mail',
  'google-workspace': 'layers',
  telegram: 'send',
  obsidian: 'book',
  'nomad-kiwix': 'database',
  'capri-web': 'globe',
  'science-search': 'search',
  youtube: 'play',
  'gemini-notebook': 'file-text',
  github: 'branch',
  huggingface: 'cpu',
  context7: 'book',
  'home-server': 'server',
  'health-connect': 'heart',
  wger: 'activity',
};

const CONNECTOR_ICON_BY_CAT = {
  comms: 'mail',
  knowledge: 'book',
  dev: 'plug',
  health: 'heart',
};

const CONFIGURABLE_CONNECTOR_IDS = new Set([
  'telegram',
  'wger',
  'health-connect',
  'google-workspace',
  'gemini-notebook',
]);

const DEFAULT_GOOGLE_WORKSPACE_STEPS = [
  '1. Открой Antigravity → Plugins Manager.',
  '2. В разделе Google Drive / Docs / Sheets / Slides нажми Sign in.',
  '3. Вернись сюда и нажми «Проверить вход».',
];

function connectorIconName(c) {
  if (c?.icon && (ICON_PATHS[c.icon] || ICON_ALIAS[c.icon])) return c.icon;
  return CONNECTOR_ICON_BY_ID[c?.id] || CONNECTOR_ICON_BY_CAT[c?.category] || 'plug';
}

function connectorStatusDotClass(c) {
  if (!c || c.enabled === false || c.pausedInMode) return 'is-paused';
  if (c.status === 'connected') return 'is-connected';
  if (c.status === 'auth_required') return 'is-auth';
  if (c.status === 'offline' || c.status === 'error') return 'is-offline';
  return 'is-paused';
}

function defaultConnectorStatusLabel(status) {
  if (status === 'connected') return 'Подключено';
  if (status === 'auth_required') return 'Нужен вход';
  if (status === 'offline' || status === 'error') return 'Нет связи';
  return 'Не настроено';
}

function makeFallbackConnector(id, name, category, description, opts = {}) {
  const status = opts.status || 'not_configured';
  return {
    id,
    name,
    aliases: opts.aliases || [],
    category,
    categoryTitle: CONNECTOR_CATEGORY_TITLES[category] || '',
    description,
    enabled: opts.enabled !== false,
    pausedInMode: false,
    pauseReason: '',
    cloudOnly: Boolean(opts.cloudOnly),
    localOnly: Boolean(opts.localOnly),
    vaultOnly: Boolean(opts.vaultOnly),
    offlineSafe: Boolean(opts.offlineSafe),
    status,
    statusLabel: opts.statusLabel || defaultConnectorStatusLabel(status),
    latencyMs: Number.isFinite(opts.latencyMs) ? opts.latencyMs : null,
    detail: opts.detail || '',
    isCustom: Boolean(opts.isCustom),
    configurable: typeof opts.configurable === 'boolean' ? opts.configurable : CONFIGURABLE_CONNECTOR_IDS.has(id),
    transport: opts.transport || 'builtin',
    url: opts.url || '',
    command: opts.command || '',
    lastDigestAt: opts.lastDigestAt || null,
    kind: 'connector',
    section: 'connectors',
    mention: `@${id}`,
    icon: opts.icon || CONNECTOR_ICON_BY_ID[id] || CONNECTOR_ICON_BY_CAT[category] || 'plug',
  };
}

export const FALLBACK_CONNECTORS = [
  makeFallbackConnector(
    'proton-pim',
    'Proton Mail и Календарь',
    'comms',
    'Письма и события Proton (только чтение без подтверждения)',
    { cloudOnly: true, aliases: ['proton', 'mail', 'calendar'], status: 'connected', statusLabel: 'Локальный мост' },
  ),
  makeFallbackConnector(
    'google-workspace',
    'Google Workspace',
    'comms',
    'Drive, Docs, Sheets, Slides, Calendar, Gmail и Contacts',
    { cloudOnly: true, aliases: ['google', 'gdrive', 'gdocs', 'gsheets', 'gslides', 'gmail', 'contacts'], status: 'auth_required' },
  ),
  makeFallbackConnector(
    'telegram',
    'Telegram',
    'comms',
    'Чтение сообщений и уведомлений (отправка с подтверждением)',
    { cloudOnly: true, aliases: ['tg'], status: 'not_configured' },
  ),
  makeFallbackConnector(
    'obsidian',
    'Obsidian Vault',
    'knowledge',
    'Поиск и чтение заметок в D:\\Obsidian\\C.A.P.R.I',
    { vaultOnly: true, offlineSafe: true, aliases: ['vault', 'notes'], status: 'connected' },
  ),
  makeFallbackConnector(
    'nomad-kiwix',
    'NOMAD / Kiwix',
    'knowledge',
    '63 офлайн-книги и справочники локально и на сервере',
    { offlineSafe: true, aliases: ['nomad', 'kiwix'], status: 'connected' },
  ),
  makeFallbackConnector(
    'capri-web',
    'Capri Web и Tor',
    'knowledge',
    'Поиск и чтение веб-страниц через браузер Капри и SearXNG',
    { cloudOnly: true, aliases: ['web', 'search'], status: 'connected' },
  ),
  makeFallbackConnector(
    'science-search',
    'Наука и медицина',
    'knowledge',
    'Публикации и исследования в OpenAlex, PubMed и arXiv',
    { cloudOnly: true, aliases: ['science', 'pubmed', 'openalex', 'arxiv', 'consensus'], status: 'connected' },
  ),
  makeFallbackConnector(
    'youtube',
    'YouTube',
    'knowledge',
    'Поиск, метаданные и разбор роликов YouTube без API-ключа',
    { cloudOnly: true, aliases: ['yt', 'video'], status: 'connected' },
  ),
  makeFallbackConnector(
    'gemini-notebook',
    'Gemini Notebook',
    'knowledge',
    'Очищенный дайджест памяти для синхронизации с веб-Gemini',
    { cloudOnly: true, aliases: ['notebook', 'notebooklm'], status: 'connected' },
  ),
  makeFallbackConnector(
    'github',
    'Git и GitHub',
    'dev',
    'Локальные репозитории Капри, ветки, статусы и коммиты',
    { offlineSafe: true, aliases: ['git', 'repo'], status: 'connected' },
  ),
  makeFallbackConnector(
    'huggingface',
    'Hugging Face Hub',
    'dev',
    'Поиск моделей, GGUF-весов, загрузок и тегов',
    { cloudOnly: true, aliases: ['hf', 'gguf', 'models'], status: 'connected' },
  ),
  makeFallbackConnector(
    'context7',
    'Context7',
    'dev',
    'Актуальная документация библиотек и API',
    { cloudOnly: true, aliases: ['c7', 'docs-api'], status: 'connected' },
  ),
  makeFallbackConnector(
    'home-server',
    'Сервер Lenovo .107',
    'dev',
    'Проверка доступности сервисов домашнего сервера',
    { cloudOnly: true, aliases: ['server', 'lenovo', '107'], status: 'connected' },
  ),
  makeFallbackConnector(
    'health-connect',
    'Health Connect / Zepp',
    'health',
    'Шаги, сон, пульс и тренировки — строго локально',
    { localOnly: true, offlineSafe: true, aliases: ['health', 'sleep', 'steps', 'zepp'], status: 'not_configured' },
  ),
  makeFallbackConnector(
    'wger',
    'Wger',
    'health',
    'Локальный дневник тренировок и питания (self-hosted)',
    { localOnly: true, offlineSafe: true, aliases: ['workout', 'gym'], status: 'not_configured' },
  ),
];

const DOCKER_STACK_ICON_BY_ID = {
  'pc-nomad': 'book',
  'pc-tor': 'shield',
  'pc-penpot': 'palette',
  'pc-opennotebook': 'file-text',
  'pc-presenton': 'layers',
  'pc-postiz': 'send',
  'pc-aperisolve': 'eye',
  'srv-searxng': 'search',
  'srv-fmd': 'target',
  'srv-kuma': 'activity',
  'srv-freshrss': 'globe',
  'srv-homeassistant': 'sliders',
  'srv-amnezia': 'shield',
  'srv-wger': 'heart',
  'srv-nomad-pack': 'layers',
  'srv-nomad-admin': 'server',
  'srv-kolibri': 'book',
  'srv-meshtastic': 'globe',
};

function dockerStackIconName(stack) {
  return DOCKER_STACK_ICON_BY_ID[stack?.id] || 'box';
}

function makeFallbackDockerStack(id, host, name, description, opts = {}) {
  const containers = Array.isArray(opts.containers) ? opts.containers : [];
  const subItems = Array.isArray(opts.subItems) ? opts.subItems : undefined;
  const totalCount = subItems ? subItems.length : Math.max(1, containers.length);
  return {
    id,
    host,
    name,
    description,
    containers,
    running: false,
    runningCount: 0,
    totalCount,
    memMb: 0,
    cpuPct: 0,
    port: opts.port ?? null,
    url: opts.url || '',
    alwaysOn: Boolean(opts.alwaysOn),
    critical: Boolean(opts.critical),
    expandable: Boolean(opts.expandable),
    ...(subItems ? { subItems } : {}),
  };
}

function makeFallbackNomadSub(id, container, name, description, port) {
  return {
    id,
    container,
    name,
    description,
    running: false,
    memMb: 0,
    cpuPct: 0,
    port,
    url: port ? `http://192.168.0.107:${port}` : '',
  };
}

export const FALLBACK_DOCKER_STATUS = {
  pc: {
    online: false,
    hostMem: null,
    totalContainerMb: 0,
    runningCount: 0,
    totalCount: 7,
    error: 'Ожидание связи с Docker на ПК',
    stacks: [
      makeFallbackDockerStack('pc-nomad', 'pc', 'NOMAD Библиотека', '63 офлайн-книги Kiwix, работает без сети и в Приват', {
        containers: ['capri-nomad-local'],
        port: 8090,
        url: 'http://127.0.0.1:8090',
        alwaysOn: true,
        critical: true,
      }),
      makeFallbackDockerStack('pc-tor', 'pc', 'Tor-изолятор Альты', 'Сетевая изоляция Tor v0 без утечек', {
        containers: ['capri-tor-netns', 'capri-tor-gw'],
        alwaysOn: true,
        critical: true,
      }),
      makeFallbackDockerStack('pc-penpot', 'pc', 'Penpot + MCP', 'Open-source замена Figma + встроенный MCP', {
        containers: [
          'penpot-penpot-frontend-1', 'penpot-penpot-backend-1', 'penpot-penpot-exporter-1',
          'penpot-penpot-admin-console-1', 'penpot-penpot-postgres-1', 'penpot-penpot-mcp-1',
          'penpot-penpot-mailpit-1', 'penpot-penpot-valkey-1',
        ],
        port: 9001,
        url: 'http://127.0.0.1:9001',
        alwaysOn: true,
      }),
      makeFallbackDockerStack('pc-opennotebook', 'pc', 'OpenNotebook', 'Локальный NotebookLM и источник срезов памяти', {
        containers: ['opennotebook-open_notebook-1', 'opennotebook-surrealdb-1'],
        port: 8502,
        url: 'http://127.0.0.1:8502',
        alwaysOn: true,
      }),
      makeFallbackDockerStack('pc-presenton', 'pc', 'Presenton', 'Локальный AI-генератор презентаций (по требованию)', {
        containers: ['presenton-presenton-1'],
        port: 5000,
        url: 'http://127.0.0.1:5000',
      }),
      makeFallbackDockerStack('pc-postiz', 'pc', 'Postiz + Temporal', 'SMM-планировщик и автопостинг (по требованию, ~2.4 ГБ)', {
        containers: [
          'postiz', 'temporal', 'temporal-ui', 'temporal-admin-tools',
          'temporal-postgresql', 'temporal-elasticsearch', 'postiz-postgres', 'postiz-redis',
        ],
        port: 4007,
        url: 'http://127.0.0.1:4007',
      }),
      makeFallbackDockerStack('pc-aperisolve', 'pc', 'AperiSolve + MCP', 'Анализ и стеганография изображений + MCP :5001 (по требованию)', {
        containers: ['aperisolve-web', 'aperisolve-mcp', 'aperisolve-worker-1', 'aperisolve-cron', 'rq-dashboard', 'postgres', 'redis'],
        port: 5000,
        url: 'http://127.0.0.1:5000',
      }),
    ],
  },
  lenovo: {
    online: false,
    hostMem: null,
    hostSwap: null,
    hostDisk: null,
    totalContainerMb: 0,
    runningCount: 0,
    totalCount: 11,
    error: 'Ожидание связи с сервером Lenovo (.107)',
    stacks: [
      makeFallbackDockerStack('srv-searxng', 'lenovo', 'SearXNG Поиск', 'Локальный метапоиск для веба Капри', {
        containers: ['searxng-searxng-1'],
        port: 8888,
        url: 'http://192.168.0.107:8888',
        alwaysOn: true,
        critical: true,
      }),
      makeFallbackDockerStack('srv-fmd', 'lenovo', 'Find My Device', 'Поиск устройств в локальной сети', {
        containers: ['capri-stack-fmd-server-1'],
        port: 8083,
        url: 'http://192.168.0.107:8083',
        alwaysOn: true,
      }),
      makeFallbackDockerStack('srv-kuma', 'lenovo', 'Uptime Kuma', 'Мониторинг доступности сервисов сервера', {
        containers: ['capri-stack-uptime-kuma-1'],
        port: 3001,
        url: 'http://192.168.0.107:3001',
        alwaysOn: true,
      }),
      makeFallbackDockerStack('srv-freshrss', 'lenovo', 'FreshRSS Новости', 'Агрегатор RSS-лент и источников', {
        containers: ['capri-stack-freshrss-1'],
        port: 8082,
        url: 'http://192.168.0.107:8082',
        alwaysOn: true,
      }),
      makeFallbackDockerStack('srv-homeassistant', 'lenovo', 'Home Assistant', 'Управление умным домом и датчиками', {
        containers: ['capri-stack-homeassistant-1'],
        port: 8123,
        url: 'http://192.168.0.107:8123',
        alwaysOn: true,
      }),
      makeFallbackDockerStack('srv-amnezia', 'lenovo', 'AmneziaWG VPN', 'Защищённый VPN-шлюз сервера', {
        containers: ['hub-awg-1'],
        alwaysOn: true,
        critical: true,
      }),
      makeFallbackDockerStack('srv-wger', 'lenovo', 'Wger Тренировки', 'Дневник тренировок и питания (self-hosted)', {
        containers: ['capri-wger'],
        port: 8085,
        url: 'http://192.168.0.107:8085',
        alwaysOn: true,
      }),
      makeFallbackDockerStack('srv-nomad-pack', 'lenovo', 'Пакет NOMAD (10 сервисов)', 'Резервная офлайн-библиотека и утилиты сервера', {
        containers: [
          'nomad_kiwix_server', 'nomad_stirling_pdf', 'nomad_calibreweb', 'nomad_homebox',
          'nomad_translate', 'nomad_filebrowser', 'nomad_cyberchef', 'nomad_it_tools',
          'nomad_qdrant', 'nomad_dozzle',
        ],
        alwaysOn: true,
        expandable: true,
        subItems: [
          makeFallbackNomadSub('kiwix', 'nomad_kiwix_server', 'Kiwix Резерв', '63 офлайн-книги и справочники на сервере', 8090),
          makeFallbackNomadSub('stirling-pdf', 'nomad_stirling_pdf', 'Stirling-PDF', 'Сборка, конвертация и OCR PDF-файлов', 8400),
          makeFallbackNomadSub('calibre-web', 'nomad_calibreweb', 'Calibre-Web', 'Каталог и чтение электронных книг', 8420),
          makeFallbackNomadSub('homebox', 'nomad_homebox', 'Homebox', 'Домашний учёт вещей и инвентаря', 8470),
          makeFallbackNomadSub('translate', 'nomad_translate', 'Translate', 'Локальный офлайн-переводчик', 8460),
          makeFallbackNomadSub('filebrowser', 'nomad_filebrowser', 'FileBrowser', 'Веб-менеджер файлов сервера', 8410),
          makeFallbackNomadSub('cyberchef', 'nomad_cyberchef', 'CyberChef', 'Кодирование, разбор и преобразование данных', 8100),
          makeFallbackNomadSub('it-tools', 'nomad_it_tools', 'IT-Tools', 'Набор утилит для разработчиков', 8430),
          makeFallbackNomadSub('qdrant', 'nomad_qdrant', 'Qdrant', 'Векторная база данных для поиска', 6333),
          makeFallbackNomadSub('dozzle', 'nomad_dozzle', 'Dozzle Логи', 'Просмотр живых логов контейнеров Docker', 9999),
        ],
      }),
      makeFallbackDockerStack('srv-nomad-admin', 'lenovo', 'NOMAD Admin + MySQL', 'Панель управления NOMAD и база данных', {
        containers: ['nomad_admin', 'nomad_mysql', 'nomad_redis', 'nomad_disk_collector', 'nomad_updater'],
        port: 8080,
        url: 'http://192.168.0.107:8080',
      }),
      makeFallbackDockerStack('srv-kolibri', 'lenovo', 'Kolibri Курсы', 'Офлайн-курсы и учебные материалы', {
        containers: ['nomad_kolibri_2'],
        port: 8310,
        url: 'http://192.168.0.107:8310',
      }),
      makeFallbackDockerStack('srv-meshtastic', 'lenovo', 'Meshtastic Web', 'Веб-клиент LoRa-сети Meshtastic', {
        containers: ['nomad_meshtastic_web'],
        port: 8450,
        url: 'http://192.168.0.107:8450',
      }),
    ],
  },
  checkedAt: null,
};

function formatDockerMem(mb) {
  const n = Number(mb);
  if (!Number.isFinite(n) || n <= 0) return '0 МБ';
  if (n >= 1024) return `${(n / 1024).toFixed(1)} ГБ`;
  return `${Math.round(n)} МБ`;
}

function formatDockerCpu(cpuPct) {
  const n = Number(cpuPct);
  if (!Number.isFinite(n) || n < 0) return '0.0%';
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
}

function formatDockerStackStat(memMb, cpuPct, running) {
  if (!running) return 'Выкл';
  return `${formatDockerMem(memMb)} · ${formatDockerCpu(cpuPct)}`;
}

function formatHostMetric(metric, label, { warnPct = 80, isSwap = false } = {}) {
  if (!metric) return null;
  if (typeof metric === 'string') {
    const trimmed = metric.trim();
    if (!trimmed) return null;
    const pctMatch = trimmed.match(/(\d+(?:\.\d+)?)\s*%/);
    const pct = pctMatch ? Number(pctMatch[1]) : null;
    const warn = pct !== null ? pct >= warnPct : false;
    return {
      text: trimmed.toLowerCase().startsWith(label.toLowerCase()) ? trimmed : `${label}: ${trimmed}`,
      warn,
    };
  }
  if (typeof metric === 'object') {
    let pct = Number.isFinite(Number(metric.pct))
      ? Math.round(Number(metric.pct))
      : (Number.isFinite(Number(metric.usedPct)) ? Math.round(Number(metric.usedPct)) : null);
    let valueText = '';
    if (typeof metric.text === 'string' && metric.text.trim()) {
      valueText = metric.text.trim();
    } else if (Number.isFinite(Number(metric.usedMb)) && Number.isFinite(Number(metric.totalMb)) && Number(metric.totalMb) > 0) {
      const usedMb = Number(metric.usedMb);
      const totalMb = Number(metric.totalMb);
      if (pct === null) pct = Math.round((usedMb / totalMb) * 100);
      valueText = `${formatDockerMem(usedMb)} / ${formatDockerMem(totalMb)}`;
    } else if (Number.isFinite(Number(metric.usedGb)) && Number.isFinite(Number(metric.totalGb)) && Number(metric.totalGb) > 0) {
      const usedGb = Number(metric.usedGb);
      const totalGb = Number(metric.totalGb);
      if (pct === null) pct = Math.round((usedGb / totalGb) * 100);
      valueText = `${usedGb.toFixed(1)} / ${totalGb.toFixed(1)} ГБ`;
    } else if (metric.used !== undefined && metric.total !== undefined) {
      valueText = `${metric.used} / ${metric.total}`;
    } else if (pct !== null) {
      valueText = `${pct}%`;
    }
    if (!valueText) return null;
    const suffix = pct !== null && !valueText.includes('%') ? ` (${pct}%)` : '';
    const swapHigh = isSwap && (
      (pct !== null && pct >= 50)
      || (Number.isFinite(Number(metric.usedMb)) && Number(metric.usedMb) >= 512)
    );
    const warn = swapHigh || (pct !== null && pct >= warnPct);
    return { text: `${label}: ${valueText}${suffix}`, warn };
  }
  return null;
}

function normalizeDockerSubItem(raw, fallback = null) {
  const base = fallback || {};
  return {
    id: raw?.id || base.id || raw?.container || '',
    container: raw?.container || base.container || '',
    name: raw?.name || base.name || raw?.container || '',
    description: raw?.description ?? base.description ?? '',
    running: Boolean(raw?.running),
    memMb: Number.isFinite(Number(raw?.memMb)) ? Number(raw.memMb) : 0,
    cpuPct: Number.isFinite(Number(raw?.cpuPct)) ? Number(raw.cpuPct) : 0,
    port: raw?.port ?? base.port ?? null,
    url: raw?.url ?? base.url ?? '',
  };
}

function normalizeDockerHost(raw, fallbackHost) {
  const fb = fallbackHost || { online: false, stacks: [], totalContainerMb: 0, runningCount: 0, totalCount: 0 };
  if (!raw || typeof raw !== 'object') {
    return {
      ...fb,
      stacks: (fb.stacks || []).map((s) => ({
        ...s,
        ...(Array.isArray(s.subItems) ? { subItems: s.subItems.map((sub) => ({ ...sub })) } : {}),
      })),
    };
  }
  const fbMap = new Map((fb.stacks || []).map((s) => [s.id, s]));
  const rawStacks = Array.isArray(raw.stacks) && raw.stacks.length ? raw.stacks : (fb.stacks || []);
  const stacks = rawStacks.map((st) => {
    const base = fbMap.get(st?.id) || {};
    const rawSubs = Array.isArray(st?.subItems) ? st.subItems : base.subItems;
    const baseSubMap = new Map((base.subItems || []).map((sub) => [sub.container || sub.id, sub]));
    const subItems = Array.isArray(rawSubs)
      ? rawSubs.map((sub) => normalizeDockerSubItem(sub, baseSubMap.get(sub?.container || sub?.id)))
      : undefined;
    const totalCount = Number.isFinite(Number(st?.totalCount))
      ? Number(st.totalCount)
      : (subItems ? subItems.length : Math.max(1, (st?.containers || base.containers || []).length));
    const runningCount = Number.isFinite(Number(st?.runningCount))
      ? Number(st.runningCount)
      : (subItems ? subItems.filter((x) => x.running).length : (st?.running ? totalCount : 0));
    return {
      id: st?.id || base.id || '',
      host: st?.host || base.host || '',
      name: st?.name || base.name || st?.id || '',
      description: st?.description ?? base.description ?? '',
      containers: Array.isArray(st?.containers) ? st.containers : (base.containers || []),
      running: typeof st?.running === 'boolean' ? st.running : runningCount > 0,
      runningCount,
      totalCount,
      memMb: Number.isFinite(Number(st?.memMb)) ? Number(st.memMb) : 0,
      cpuPct: Number.isFinite(Number(st?.cpuPct)) ? Number(st.cpuPct) : 0,
      port: st?.port ?? base.port ?? null,
      url: st?.url ?? base.url ?? '',
      alwaysOn: typeof st?.alwaysOn === 'boolean' ? st.alwaysOn : Boolean(base.alwaysOn),
      critical: typeof st?.critical === 'boolean' ? st.critical : Boolean(base.critical),
      expandable: typeof st?.expandable === 'boolean' ? st.expandable : Boolean(base.expandable || subItems?.length),
      ...(subItems ? { subItems } : {}),
    };
  });
  const totalContainerMb = Number.isFinite(Number(raw.totalContainerMb))
    ? Number(raw.totalContainerMb)
    : stacks.reduce((sum, s) => sum + (Number(s.memMb) || 0), 0);
  const runningCount = Number.isFinite(Number(raw.runningCount))
    ? Number(raw.runningCount)
    : stacks.filter((s) => s.running).length;
  const totalCount = Number.isFinite(Number(raw.totalCount))
    ? Number(raw.totalCount)
    : stacks.length;
  return {
    online: Boolean(raw.online),
    hostMem: raw.hostMem ?? null,
    hostSwap: raw.hostSwap ?? null,
    hostDisk: raw.hostDisk ?? null,
    totalContainerMb,
    runningCount,
    totalCount,
    stacks,
    error: raw.error ? String(raw.error) : '',
  };
}

function normalizeDockerStatus(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      pc: normalizeDockerHost(null, FALLBACK_DOCKER_STATUS.pc),
      lenovo: normalizeDockerHost(null, FALLBACK_DOCKER_STATUS.lenovo),
      checkedAt: null,
      isFallback: true,
    };
  }
  return {
    pc: normalizeDockerHost(raw.pc, FALLBACK_DOCKER_STATUS.pc),
    lenovo: normalizeDockerHost(raw.lenovo, FALLBACK_DOCKER_STATUS.lenovo),
    checkedAt: raw.checkedAt || Date.now(),
    isFallback: false,
  };
}

async function fetchDockerStatus({ refresh = false } = {}) {
  const host = window.host;
  if (typeof host?.dockerStatus === 'function') {
    try {
      const res = await host.dockerStatus({ refresh: Boolean(refresh) });
      if (res && (res.pc || res.lenovo)) {
        return normalizeDockerStatus(res);
      }
    } catch (err) {
      const fb = normalizeDockerStatus(null);
      const msg = err?.message || 'Не удалось получить статус Docker';
      fb.pc.error = msg;
      fb.lenovo.error = msg;
      return fb;
    }
  }
  const fb = normalizeDockerStatus(null);
  fb.pc.error = 'Модуль Docker ещё не подключён в приложении';
  fb.lenovo.error = 'Модуль Docker ещё не подключён в приложении';
  return fb;
}

function openExternalUrl(url) {
  if (!url) return;
  try {
    if (typeof window.host?.chatsOpenLink === 'function') {
      window.host.chatsOpenLink(url);
      return;
    }
  } catch {
    // ignore IPC error and fall through
  }
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    // ignore popup restrictions
  }
}

function item(name, description, opts = {}) {
  const section = opts.section || 'commands';
  const category = opts.category || (section === 'skills' ? 'style' : 'chat');
  const categoryTitle = opts.categoryTitle
    || (section === 'skills' ? SKILL_CATEGORY_TITLES[category] : COMMAND_CATEGORY_TITLES[category])
    || '';
  return {
    id: opts.id || (section === 'skills' ? name : `${section}:${name}`),
    name: opts.displayName || name,
    slash: opts.slash || `/${name}`,
    aliases: opts.aliases || [],
    section,
    category,
    categoryTitle,
    kind: opts.kind || (INSTANT_COMMANDS.has(name) ? 'instant' : 'session'),
    icon: opts.icon || name,
    description,
    badge: opts.badge ?? null,
    active: Boolean(opts.active),
    chainable: Boolean(opts.chainable),
    confirmRequired: Boolean(opts.confirmRequired),
    cloudOnly: opts.cloudOnly ?? CLOUD_ONLY_FALLBACK.has(name),
    argsHint: opts.argsHint || '',
    ...(section === 'skills' ? {
      enabled: opts.enabled !== false,
      alwaysOn: Boolean(opts.alwaysOn),
      canPinAlways: Boolean(opts.canPinAlways),
      quickSlot: Boolean(opts.quickSlot),
      pausedInMode: Boolean(opts.pausedInMode),
      pauseReason: opts.pauseReason || '',
      isPack: Boolean(opts.isPack),
      subCount: Number.isFinite(opts.subCount) ? opts.subCount : 0,
      isCustom: Boolean(opts.isCustom),
      stageNote: opts.stageNote || '',
      tokens: Number.isFinite(opts.tokens) ? opts.tokens : 240,
      alwaysOnTokens: Number.isFinite(opts.alwaysOnTokens) ? opts.alwaysOnTokens : 240,
    } : {}),
  };
}

export const FALLBACK_SECTIONS = [
  {
    id: 'commands',
    title: 'Команды',
    allLabel: 'Все команды',
    items: [
      item('compact', 'Сжать раннюю часть разговора в конспект', { kind: 'session', category: 'chat', argsHint: '[фокус]' }),
      item('autocompact', 'Автосжатие контекста по порогу', { kind: 'session', category: 'chat', argsHint: '[on|off|%]' }),
      item('new', 'Начать новый чистый разговор', { aliases: ['clear'], kind: 'session', category: 'chat' }),
      item('context', 'Заполнение контекстного окна', { category: 'chat' }),
      item('model', 'Переключить активную модель или режим', { kind: 'session', category: 'chat', argsHint: '[имя]' }),
      item('effort', 'Уровень глубины рассуждения (low/medium/high/xhigh)', { kind: 'session', category: 'chat', argsHint: '[уровень]' }),
      item('stop', 'Остановить текущий ответ', { category: 'chat' }),
      item('retry', 'Повторить последний запрос', { kind: 'session', category: 'chat' }),
      item('fork', 'Создать ответвление текущего разговора', { kind: 'session', category: 'chat' }),
      item('btw', 'Быстрый вопрос в стороне без записи в историю', { kind: 'prompt', category: 'chat', argsHint: '<вопрос>' }),
      item('focus', 'Режим фокуса без боковых панелей', { kind: 'session', category: 'chat' }),
      item('output-style', 'Стиль ответа (default/concise/detailed/technical/bullets)', { kind: 'session', category: 'chat', argsHint: '[стиль]' }),
      item('copy', 'Скопировать последний ответ в буфер', { category: 'chat' }),
      item('export', 'Сохранить разговор в файл или Obsidian', { category: 'chat' }),
      item('pin', 'Закрепить или открепить разговор', { kind: 'session', category: 'chat' }),
      item('rename', 'Переименовать текущий разговор', { kind: 'session', category: 'chat', argsHint: '<название>' }),
      item('archive', 'Убрать разговор в архив', { kind: 'session', category: 'chat' }),
      item('delete', 'Удалить текущий разговор с подтверждением', { kind: 'session', category: 'chat', confirmRequired: true }),
      item('remember', 'Запомнить факт в локальную память', { kind: 'session', category: 'memory', argsHint: '<факт>' }),
      item('save', 'Сохранить результат в заметку Obsidian', { kind: 'session', category: 'memory', argsHint: '[заголовок]' }),
      item('nomad', 'Поиск по локальной базе знаний Kiwix', { category: 'memory' }),
      item('web', 'Поиск в интернете через браузер Капри', { cloudOnly: true, category: 'modes', argsHint: '<запрос>' }),
      item('tor', 'Поиск через изолированный узел Tor', { category: 'modes', argsHint: '<запрос>' }),
      item('deep', 'Глубокое исследование темы', { kind: 'prompt', cloudOnly: true, category: 'modes', argsHint: '<тема>', chainable: true }),
      item('council', 'Спросить совет моделей', { kind: 'prompt', cloudOnly: true, category: 'modes', argsHint: '<вопрос>', chainable: true }),
      item('plan-mode', 'Сначала план, потом выполнение', { kind: 'session', category: 'modes' }),
      item('grill-me', 'Уточняющие вопросы по плану и решениям', { kind: 'prompt', category: 'modes', argsHint: '[тема]', chainable: true }),
      item('review', 'Проверка и ревью решения или кода', { kind: 'prompt', category: 'modes', argsHint: '[цель]', chainable: true }),
      item('status', 'Состояние локального мозга, очереди и памяти', { category: 'system' }),
      item('usage', 'Остаток квот и лимиты моделей', { aliases: ['quota'], category: 'system' }),
      item('free', 'Выгрузить модели из VRAM', { category: 'system' }),
      item('tools', 'Список доступных инструментов', { category: 'system' }),
      item('mcp', 'Статус MCP-подключений', { category: 'system' }),
      item('skills', 'Список установленных навыков', { category: 'system' }),
      item('plugins', 'Каталог локальных плагинов и правил', { aliases: ['plugin'], category: 'system' }),
      item('connectors', 'Каталог коннекторов, статусы и свои MCP', { aliases: ['connector'], category: 'system' }),
      item('docker', 'Пульт Docker: контейнеры на ПК и сервере .107', { category: 'system', icon: 'box' }),
      item('hookify', 'Пользовательские правила Hookify', { category: 'system' }),
      item('doctor', 'Быстрая диагностика систем Капри', { category: 'system' }),
      item('storage', 'Использование диска и базы', { category: 'system' }),
      item('help', 'Справка по командам и навыкам', { aliases: ['find'], category: 'system' }),
      item('today', 'Сводка планов на сегодня', { category: 'agents' }),
      item('mail', 'Проверить входящую почту Proton', { category: 'agents' }),
      item('tasks', 'Активные и фоновые задачи', { category: 'agents' }),
    ],
  },
  {
    id: 'skills',
    title: 'Навыки',
    allLabel: 'Все навыки',
    items: [
      item('second-brain', 'Проверка идеи по логике и фактам без поддакивания', { section: 'skills', category: 'style', kind: 'skill', icon: 'sparkles', chainable: true, alwaysOn: true, canPinAlways: true, quickSlot: true, tokens: 260, alwaysOnTokens: 260 }),
      item('i-have-adhd', 'Краткий шаг за шагом, сначала следующее действие', { section: 'skills', category: 'style', kind: 'skill', icon: 'list', chainable: true, canPinAlways: true, quickSlot: true, tokens: 220, alwaysOnTokens: 220 }),
      item('caveman', 'Предельно кратко: ответ первым, без воды, все факты на месте', { section: 'skills', category: 'style', kind: 'skill', icon: 'compact', chainable: true, canPinAlways: true, quickSlot: true, tokens: 210, alwaysOnTokens: 210 }),
      item('russian-editor', 'Живой русский текст без нейросетевых штампов', { section: 'skills', category: 'style', kind: 'skill', icon: 'edit', chainable: true, canPinAlways: true, tokens: 280, alwaysOnTokens: 280 }),
      item('think', 'Глубокий 10-шаговый разбор сложного решения', { section: 'skills', category: 'style', kind: 'skill', icon: 'sparkles', chainable: true, canPinAlways: true, tokens: 320, alwaysOnTokens: 320 }),
      item('obsidian-markdown', 'Синтаксис и оформление заметок Obsidian', { section: 'skills', category: 'memory', kind: 'skill', icon: 'book', chainable: true, tokens: 420 }),
      item('wiki', 'Работа с базой знаний и структурой Obsidian Vault', { section: 'skills', category: 'memory', kind: 'skill', icon: 'book', chainable: true, tokens: 480 }),
      item('research-method', 'Глубокий многоисточниковый разбор и синтез отчёта', { section: 'skills', category: 'docs', kind: 'skill', icon: 'search', chainable: true, tokens: 520 }),
      item('unslop-gemini', 'Строгий anti-slop UI по эталону Google Gemini', { section: 'skills', category: 'creative', kind: 'skill', icon: 'palette', chainable: true, tokens: 460 }),
      item('impeccable-ui', 'Пакет приёмов UI-полировки и визуальной проверки', { section: 'skills', category: 'creative', kind: 'skill', icon: 'layers', chainable: true, isPack: true, subCount: 20, tokens: 380 }),
      item('marketingskills', 'Фреймворки позиционирования, питчей и страниц продуктов', { section: 'skills', category: 'creative', kind: 'skill', icon: 'layers', chainable: true, isPack: true, subCount: 26, tokens: 410 }),
      item('game-studios-reference', 'Справочник и практики геймдизайна и баланса', { section: 'skills', category: 'creative', kind: 'skill', icon: 'layers', chainable: true, isPack: true, subCount: 12, tokens: 390 }),
      item('agent-desktop', 'Автоматизация окон Windows через одобренные команды', { section: 'skills', category: 'system', kind: 'skill', icon: 'wrench', chainable: true, stageNote: 'Этап 2.5 (памятка)', tokens: 160 }),
    ],
  },
  {
    id: 'plugins',
    title: 'Плагины',
    allLabel: 'Все плагины',
    items: FALLBACK_PLUGINS,
  },
  {
    id: 'connectors',
    title: 'Коннекторы',
    allLabel: 'Все коннекторы',
    items: FALLBACK_CONNECTORS,
  },
  {
    id: 'styles',
    title: 'Стили',
    allLabel: 'Посмотреть все стили',
    stage: '2.7',
    items: [
      item('style-concise', 'Коротко и по делу, без воды', { section: 'styles', kind: 'draft', icon: 'palette', badge: 'Этап 2.7' }),
      item('style-technical', 'Точный технический разбор с деталями', { section: 'styles', kind: 'draft', icon: 'palette', badge: 'Этап 2.7' }),
      item('style-bullets', 'Структурированные списки и ключевые тезисы', { section: 'styles', kind: 'draft', icon: 'palette', badge: 'Этап 2.7' }),
    ],
  },
];

const CATALOG_HERO = {
  commands: {
    title: 'Команды',
    subtitle: 'Управление разговором, контекстом, моделями и локальными инструментами.',
  },
  skills: {
    title: 'Навыки',
    subtitle: 'Подключаемые инструкции: включай на постоянку или вызывай через / в одном сообщении.',
  },
  plugins: {
    title: 'Плагины',
    subtitle: 'Тематические наборы команд, навыков и правил для рабочих сценариев.',
  },
  connectors: {
    title: 'Коннекторы',
    subtitle: 'Подключения к почте, базе знаний, вебу, коду и личным данным. Упоминай через @ в чате.',
  },
  docker: {
    title: 'Пульт Docker',
    subtitle: 'Контейнеры на ПК и старом ноуте (.107): запуск, рестарт и расход памяти.',
  },
  styles: {
    title: 'Стили',
    subtitle: 'Готовые профили формата и тона ответов для разных задач.',
  },
};

function isIsolatedContext(ctx) {
  return Boolean(ctx?.ephemeral || ['private', 'nsfw', 'tor'].includes(ctx?.mode));
}

function applyPluginModePause(plugin, ctx) {
  if (!plugin) return plugin;
  if (plugin.id === 'security-guard') {
    return { ...plugin, pausedInMode: false, pauseReason: '' };
  }
  const isolated = isIsolatedContext(ctx);
  const noVault = Boolean(ctx?.ephemeral || ctx?.mode === 'nsfw');
  if (plugin.cloudOnly && isolated) {
    return {
      ...plugin,
      pausedInMode: true,
      pauseReason: plugin.pauseReason || 'Пауза в изолированном режиме',
    };
  }
  if (plugin.vaultOnly && noVault) {
    return {
      ...plugin,
      pausedInMode: true,
      pauseReason: plugin.pauseReason || 'Пауза во временном/18+ режиме',
    };
  }
  return { ...plugin };
}

function applyConnectorModePause(connector, ctx) {
  if (!connector) return connector;
  const isolated = isIsolatedContext(ctx);
  const noVault = Boolean(ctx?.ephemeral || ctx?.mode === 'nsfw');
  const isCloudAgent = Boolean(ctx?.mode === 'agent' || ctx?.agent);
  if (connector.localOnly && isCloudAgent) {
    return {
      ...connector,
      pausedInMode: true,
      pauseReason: connector.pauseReason || 'Только локально (скрыто для облачных агентов)',
    };
  }
  if (connector.cloudOnly && isolated) {
    return {
      ...connector,
      pausedInMode: true,
      pauseReason: connector.pauseReason || 'Пауза в изолированном режиме',
    };
  }
  if (connector.vaultOnly && noVault) {
    return {
      ...connector,
      pausedInMode: true,
      pauseReason: connector.pauseReason || 'Пауза во временном/18+ режиме',
    };
  }
  return { ...connector };
}

function buildFallbackCatalog(ctx) {
  const isolated = isIsolatedContext(ctx);
  const pct = Number.isFinite(ctx?.pct) ? Math.round(ctx.pct) : null;
  const sections = FALLBACK_SECTIONS.map((sec) => {
    if (sec.id === 'plugins') {
      return {
        ...sec,
        items: sec.items.map((p) => applyPluginModePause(p, ctx)),
      };
    }
    if (sec.id === 'connectors') {
      return {
        ...sec,
        items: sec.items.map((c) => applyConnectorModePause(c, ctx)),
      };
    }
    return {
      ...sec,
      items: sec.items
        .filter((it) => !(isolated && sec.id !== 'skills' && it.cloudOnly))
        .map((it) => {
          if (it.name === 'compact' && pct !== null) {
            return { ...it, badge: `${pct}%` };
          }
          return { ...it };
        }),
    };
  });
  return { sections, state: {} };
}

function groupByCategories(items, canonicalList) {
  const order = new Map();
  canonicalList.forEach((c, idx) => order.set(c.id, idx));
  const titleById = new Map(canonicalList.map((c) => [c.id, c.title]));
  const buckets = new Map();

  for (const it of items || []) {
    const id = it.category || 'other';
    const title = it.categoryTitle || titleById.get(id) || 'Прочее';
    if (!buckets.has(id)) {
      buckets.set(id, { id, title, items: [] });
    }
    buckets.get(id).items.push(it);
  }

  return Array.from(buckets.values()).sort((a, b) => {
    const ai = order.has(a.id) ? order.get(a.id) : 999;
    const bi = order.has(b.id) ? order.get(b.id) : 999;
    if (ai !== bi) return ai - bi;
    return a.title.localeCompare(b.title, 'ru');
  });
}

function normalizeSkillsResponse(res, fallbackItems = []) {
  const items = Array.isArray(res?.items)
    ? res.items
    : (Array.isArray(res?.categories) ? res.categories.flatMap((c) => c.items || []) : fallbackItems);
  const categories = Array.isArray(res?.categories) && res.categories.length
    ? res.categories
    : groupByCategories(items, SKILL_CATEGORIES);
  const alwaysOnTokens = Number.isFinite(res?.budget?.alwaysOnTokens)
    ? res.budget.alwaysOnTokens
    : items.filter((s) => s.enabled !== false && s.alwaysOn && !s.pausedInMode)
      .reduce((acc, s) => acc + (Number(s.alwaysOnTokens || s.tokens) || 240), 0);
  const indexTokens = Number.isFinite(res?.budget?.indexTokens)
    ? res.budget.indexTokens
    : items.filter((s) => s.enabled !== false && !s.pausedInMode).length * 14;
  const totalAutoTokens = Number.isFinite(res?.budget?.totalAutoTokens)
    ? res.budget.totalAutoTokens
    : (alwaysOnTokens + indexTokens);
  const softLimitTokens = Number.isFinite(res?.budget?.softLimitTokens) ? res.budget.softLimitTokens : 4000;
  const pinnedIds = Array.isArray(res?.budget?.pinnedIds)
    ? res.budget.pinnedIds
    : items.filter((s) => s.enabled !== false && s.alwaysOn && !s.pausedInMode).map((s) => s.id);
  const budget = {
    alwaysOnTokens,
    indexTokens,
    totalAutoTokens,
    softLimitTokens,
    overSoftLimit: typeof res?.budget?.overSoftLimit === 'boolean'
      ? res.budget.overSoftLimit
      : totalAutoTokens > softLimitTokens,
    pinnedIds,
  };
  const quickToggles = Array.isArray(res?.quickToggles)
    ? res.quickToggles
    : ['i-have-adhd', 'caveman', 'second-brain'];
  return { categories, items, budget, quickToggles };
}

async function fetchSkills(ctx, fallbackItems = []) {
  const host = window.host;
  if (typeof host?.skillsList === 'function') {
    try {
      const res = await host.skillsList({
        mode: ctx?.mode || 'capri',
        ephemeral: Boolean(ctx?.ephemeral),
      });
      if (res && (Array.isArray(res.categories) || Array.isArray(res.items))) {
        return normalizeSkillsResponse(res, fallbackItems);
      }
    } catch {
      // fall back cleanly
    }
  }
  const base = fallbackItems.length
    ? fallbackItems
    : (FALLBACK_SECTIONS.find((s) => s.id === 'skills')?.items || []);
  return normalizeSkillsResponse({ items: base }, base);
}

function normalizePluginsResponse(res, fallbackItems = [], ctx = null) {
  const rawItems = Array.isArray(res?.items)
    ? res.items
    : (Array.isArray(res?.categories) ? res.categories.flatMap((c) => c.items || []) : fallbackItems);
  const items = (rawItems || []).map((p) => ({
    ...p,
    id: p.id || p.slug || p.name,
    name: p.name || p.title || p.id,
    category: p.category || 'safety',
    categoryTitle: p.categoryTitle || PLUGIN_CATEGORY_TITLES[p.category] || 'Прочее',
    enabled: p.enabled !== false,
    pausedInMode: Boolean(p.pausedInMode),
    pauseReason: p.pauseReason || '',
    skills: Array.isArray(p.skills) ? p.skills : [],
    commands: Array.isArray(p.commands) ? p.commands : [],
    hooks: Array.isArray(p.hooks) ? p.hooks : [],
    rules: Array.isArray(p.rules) ? p.rules : [],
    statusNote: p.statusNote || '',
    health: p.health || 'ok',
    source: p.source || (p.isCustom ? 'custom' : 'builtin'),
    isCustom: Boolean(p.isCustom),
    kind: 'plugin',
    section: 'plugins',
    icon: pluginIconName(p),
  }));
  const finalItems = ctx && !Array.isArray(res?.items) && !Array.isArray(res?.categories)
    ? items.map((p) => applyPluginModePause(p, ctx))
    : items;
  const categories = Array.isArray(res?.categories) && res.categories.length
    ? res.categories.map((c) => ({
      id: c.id,
      title: c.title || PLUGIN_CATEGORY_TITLES[c.id] || 'Прочее',
      items: (c.items || []).map((p) => finalItems.find((x) => x.id === (p.id || p.slug || p.name)) || p),
    }))
    : groupByCategories(finalItems, PLUGIN_CATEGORIES);
  const hookifyRules = Array.isArray(res?.hookifyRules) ? res.hookifyRules : [];
  const total = Number.isFinite(res?.stats?.total) ? res.stats.total : finalItems.length;
  const enabled = Number.isFinite(res?.stats?.enabled)
    ? res.stats.enabled
    : finalItems.filter((p) => p.enabled !== false).length;
  const activeInMode = Number.isFinite(res?.stats?.activeInMode)
    ? res.stats.activeInMode
    : finalItems.filter((p) => p.enabled !== false && !p.pausedInMode).length;
  const customCount = Number.isFinite(res?.stats?.customCount)
    ? res.stats.customCount
    : finalItems.filter((p) => p.isCustom).length;
  const hookifyRulesCount = Number.isFinite(res?.stats?.hookifyRulesCount)
    ? res.stats.hookifyRulesCount
    : hookifyRules.length;
  return {
    categories,
    items: finalItems,
    stats: { total, enabled, activeInMode, customCount, hookifyRulesCount },
    hookifyRules,
  };
}

async function fetchPlugins(ctx, fallbackItems = []) {
  const host = window.host;
  if (typeof host?.pluginsList === 'function') {
    try {
      const res = await host.pluginsList({
        mode: ctx?.mode || 'capri',
        ephemeral: Boolean(ctx?.ephemeral),
      });
      if (res && (Array.isArray(res.categories) || Array.isArray(res.items))) {
        return normalizePluginsResponse(res, fallbackItems, ctx);
      }
    } catch {
      // fall back cleanly
    }
  }
  const base = fallbackItems.length
    ? fallbackItems
    : FALLBACK_PLUGINS;
  return normalizePluginsResponse({}, base, ctx);
}

function normalizeConnectorsResponse(res, fallbackItems = [], ctx = null) {
  const rawItems = Array.isArray(res?.items)
    ? res.items
    : (Array.isArray(res?.categories) ? res.categories.flatMap((c) => c.items || []) : fallbackItems);
  const items = (rawItems || []).map((c) => {
    const id = c.id || c.slug || c.name;
    const status = c.status || 'not_configured';
    return {
      ...c,
      id,
      name: c.name || c.title || id,
      aliases: Array.isArray(c.aliases) ? c.aliases : [],
      category: c.category || 'dev',
      categoryTitle: c.categoryTitle || CONNECTOR_CATEGORY_TITLES[c.category] || 'Прочее',
      description: c.description || '',
      enabled: c.enabled !== false,
      pausedInMode: Boolean(c.pausedInMode),
      pauseReason: c.pauseReason || '',
      cloudOnly: Boolean(c.cloudOnly),
      localOnly: Boolean(c.localOnly),
      vaultOnly: Boolean(c.vaultOnly),
      offlineSafe: Boolean(c.offlineSafe),
      status,
      statusLabel: c.statusLabel || defaultConnectorStatusLabel(status),
      latencyMs: Number.isFinite(Number(c.latencyMs)) ? Math.round(Number(c.latencyMs)) : null,
      detail: c.detail || '',
      isCustom: Boolean(c.isCustom),
      configurable: typeof c.configurable === 'boolean' ? c.configurable : CONFIGURABLE_CONNECTOR_IDS.has(id),
      transport: c.transport || (c.isCustom ? 'http' : 'builtin'),
      url: c.url || '',
      command: c.command || '',
      lastDigestAt: c.lastDigestAt || null,
      kind: 'connector',
      section: 'connectors',
      mention: `@${id}`,
      icon: connectorIconName(c),
    };
  });
  const finalItems = ctx && !Array.isArray(res?.items) && !Array.isArray(res?.categories)
    ? items.map((c) => applyConnectorModePause(c, ctx))
    : items;
  const categories = Array.isArray(res?.categories) && res.categories.length
    ? res.categories.map((cat) => ({
      id: cat.id,
      title: cat.title || CONNECTOR_CATEGORY_TITLES[cat.id] || 'Прочее',
      items: (cat.items || []).map((c) => finalItems.find((x) => x.id === (c.id || c.slug || c.name)) || c),
    }))
    : groupByCategories(finalItems, CONNECTOR_CATEGORIES);
  const total = Number.isFinite(res?.stats?.total) ? res.stats.total : finalItems.length;
  const enabled = Number.isFinite(res?.stats?.enabled)
    ? res.stats.enabled
    : finalItems.filter((c) => c.enabled !== false).length;
  const connected = Number.isFinite(res?.stats?.connected)
    ? res.stats.connected
    : finalItems.filter((c) => c.enabled !== false && c.status === 'connected').length;
  const activeInMode = Number.isFinite(res?.stats?.activeInMode)
    ? res.stats.activeInMode
    : finalItems.filter((c) => c.enabled !== false && !c.pausedInMode).length;
  const customCount = Number.isFinite(res?.stats?.customCount)
    ? res.stats.customCount
    : finalItems.filter((c) => c.isCustom).length;
  return {
    categories,
    items: finalItems,
    stats: { total, enabled, connected, activeInMode, customCount },
  };
}

async function fetchConnectors(ctx, { fallbackItems = [], refresh = false } = {}) {
  const host = window.host;
  if (typeof host?.connectorsList === 'function') {
    try {
      const res = await host.connectorsList({
        mode: ctx?.mode || 'capri',
        ephemeral: Boolean(ctx?.ephemeral),
        refresh: Boolean(refresh),
      });
      if (res && (Array.isArray(res.categories) || Array.isArray(res.items))) {
        return normalizeConnectorsResponse(res, fallbackItems, ctx);
      }
    } catch {
      // fall back cleanly
    }
  }
  const base = fallbackItems.length ? fallbackItems : FALLBACK_CONNECTORS;
  return normalizeConnectorsResponse({}, base, ctx);
}

async function fetchCatalog(ctx) {
  const host = window.host;
  if (typeof host?.commandsList === 'function') {
    try {
      const res = await host.commandsList({
        mode: ctx?.mode || 'capri',
        ephemeral: Boolean(ctx?.ephemeral),
        agent: ctx?.agent || undefined,
        pct: Number.isFinite(ctx?.pct) ? Math.round(ctx.pct) : undefined,
      });
      if (res && Array.isArray(res.sections) && res.sections.length) {
        return res;
      }
    } catch {
      // fall back cleanly
    }
  }
  return buildFallbackCatalog(ctx);
}

// ---------------------------------------------------------------- token detection & matching

/**
 * Finds the active `/token` at the caret position when the input starts with `/`
 * and every token before the active one is also a `/token` (enabling skill chaining
 * like `/caveman /se...` without triggering on file paths in prose).
 */
export function extractActiveSlashToken(value, caretPos) {
  const text = String(value || '');
  const pos = Number.isFinite(caretPos) ? caretPos : text.length;
  const before = text.slice(0, pos);
  if (!before.trimStart().startsWith('/')) return null;

  const match = before.match(/(?:^|\s)(\/[^\s]*)$/);
  if (!match) return null;

  const token = match[1];
  const start = pos - token.length;
  const prefix = before.slice(0, start).trim();
  const prevTokens = prefix ? prefix.split(/\s+/) : [];
  if (prevTokens.some((tok) => !tok.startsWith('/'))) return null;

  return {
    trigger: '/',
    start,
    end: pos,
    token,
    query: token.slice(1).toLowerCase(),
    isChained: prevTokens.length > 0,
    prevTokens,
  };
}

/**
 * Finds the active `@connector` token at the caret position when `@` appears at
 * start-of-string or immediately after whitespace (ignoring emails like `user@gmail.com`).
 */
export function extractActiveMentionToken(value, caretPos) {
  const text = String(value || '');
  const pos = Number.isFinite(caretPos) ? caretPos : text.length;
  const before = text.slice(0, pos);
  const match = before.match(/(?:^|\s)(@[^\s@]*)$/);
  if (!match) return null;

  const token = match[1];
  const start = pos - token.length;
  return {
    trigger: '@',
    start,
    end: pos,
    token,
    query: token.slice(1).toLowerCase(),
    isChained: false,
    prevTokens: [],
  };
}

function scoreItem(it, query) {
  if (!query) return 10;
  const id = (it.id || '').toLowerCase();
  const name = (it.name || '').toLowerCase();
  const title = (it.title || '').toLowerCase();
  const slash = (it.slash || `/${name}`).toLowerCase();
  const mention = (it.mention || (id ? `@${id}` : '')).toLowerCase();
  const aliases = (it.aliases || []).map((a) => String(a).toLowerCase());
  const desc = (it.description || '').toLowerCase();
  const cat = (it.category || '').toLowerCase();
  const catTitle = (it.categoryTitle || '').toLowerCase();
  const skills = Array.isArray(it.skills) ? it.skills.map((s) => String(s).toLowerCase()) : [];
  const commands = Array.isArray(it.commands) ? it.commands.map((c) => String(c).toLowerCase()) : [];
  const hooks = Array.isArray(it.hooks) ? it.hooks.map((h) => String(h).toLowerCase()) : [];
  const rules = Array.isArray(it.rules) ? it.rules.map((r) => String(r).toLowerCase()) : [];
  const statusNote = (it.statusNote || it.statusLabel || '').toLowerCase();
  const detail = (it.detail || '').toLowerCase();
  const url = (it.url || '').toLowerCase();

  if (name === query || id === query || slash === `/${query}` || mention === `@${query}` || aliases.includes(query)) return 100;
  if (name.startsWith(query) || id.startsWith(query) || title.startsWith(query) || aliases.some((a) => a.startsWith(query))) return 80;
  if (name.includes(query) || id.includes(query) || title.includes(query) || slash.includes(query) || mention.includes(query) || aliases.some((a) => a.includes(query))) return 50;
  if (skills.some((s) => s.includes(query)) || commands.some((c) => c.includes(query)) || hooks.some((h) => h.includes(query))) return 35;
  if (desc.includes(query) || statusNote.includes(query) || detail.includes(query) || url.includes(query) || rules.some((r) => r.includes(query))) return 25;
  if (cat.includes(query) || catTitle.includes(query)) return 15;
  return 0;
}

function shouldInsertOnly(it, isChained) {
  if (isChained) return true;
  if (it.kind === 'skill' || it.kind === 'prompt') return true;
  if (it.argsHint && String(it.argsHint).trim().startsWith('<')) return true;
  return false;
}

function parsePctFromBadge(badge, fallbackPct) {
  if (typeof badge === 'string') {
    const m = badge.match(/(\d+)\s*%/);
    if (m) return Number(m[1]);
  }
  if (Number.isFinite(fallbackPct)) return Math.round(fallbackPct);
  return null;
}

function applyTokenReplacement(input, range, slashText) {
  const val = input.value;
  const before = val.slice(0, range.start);
  const after = val.slice(range.end);
  const spacer = after.startsWith(' ') ? '' : ' ';
  const next = `${before}${slashText}${spacer}${after}`;
  const cursor = before.length + slashText.length + spacer.length;
  input.value = next;
  input.focus();
  if (typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(cursor, cursor);
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------------------------------------------------------------- floating autocomplete menu

const INITIAL_LIMITS = {
  commands: 8,
  skills: 5,
  plugins: 3,
  connectors: 4,
  styles: 2,
};

export function attachSlashMenu({ input, container, getContext, onSelectItem, onOpenCatalog }) {
  if (!input || !container) return null;

  const menu = document.createElement('div');
  menu.className = 'slash-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', 'Команды, навыки и коннекторы');
  menu.hidden = true;
  container.appendChild(menu);

  let catalog = null;
  let lastCtxKey = '';
  let fetchSeq = 0;
  let open = false;
  let activeToken = null;
  let flatRows = [];
  let activeIndex = 0;

  function ctxKey(ctx) {
    return `${ctx?.mode || 'capri'}|${Boolean(ctx?.ephemeral)}|${ctx?.agent || ''}`;
  }

  async function ensureCatalog(force = false) {
    const ctx = getContext?.() || {};
    const key = ctxKey(ctx);
    if (!force && catalog && key === lastCtxKey) {
      return catalog;
    }
    const seq = ++fetchSeq;
    const loaded = await fetchCatalog(ctx);
    const sections = Array.isArray(loaded?.sections) ? loaded.sections : [];

    const pluginsSec = sections.find((s) => s.id === 'plugins');
    const needsLivePlugins = !pluginsSec
      || pluginsSec.stage
      || (Array.isArray(pluginsSec.items) && pluginsSec.items.some((it) => it.kind === 'draft'));

    const connectorsSec = sections.find((s) => s.id === 'connectors');
    const needsLiveConnectors = force
      || !connectorsSec
      || connectorsSec.stage
      || (Array.isArray(connectorsSec.items) && connectorsSec.items.some((it) => it.kind === 'draft'));

    const [livePlugins, liveConnectors] = await Promise.all([
      needsLivePlugins && typeof window.host?.pluginsList === 'function' ? fetchPlugins(ctx) : Promise.resolve(null),
      needsLiveConnectors && typeof window.host?.connectorsList === 'function' ? fetchConnectors(ctx) : Promise.resolve(null),
    ]);

    if (livePlugins && pluginsSec && Array.isArray(livePlugins.items) && livePlugins.items.length) {
      delete pluginsSec.stage;
      pluginsSec.items = livePlugins.items;
    }
    if (liveConnectors && Array.isArray(liveConnectors.items) && liveConnectors.items.length) {
      if (connectorsSec) {
        delete connectorsSec.stage;
        connectorsSec.items = liveConnectors.items;
      } else {
        sections.push({
          id: 'connectors',
          title: 'Коннекторы',
          allLabel: 'Все коннекторы',
          items: liveConnectors.items,
        });
      }
    }
    if (seq !== fetchSeq) return catalog || loaded;
    catalog = loaded;
    lastCtxKey = key;
    if (open && activeToken) render();
    return catalog;
  }

  function close() {
    open = false;
    activeToken = null;
    flatRows = [];
    activeIndex = 0;
    menu.hidden = true;
  }

  function highlight(idx) {
    if (!flatRows.length) return;
    activeIndex = ((idx % flatRows.length) + flatRows.length) % flatRows.length;
    for (let i = 0; i < flatRows.length; i++) {
      const entry = flatRows[i];
      const active = i === activeIndex;
      entry.el.classList.toggle('is-active', active);
      entry.el.setAttribute('aria-selected', String(active));
      if (active) entry.el.scrollIntoView({ block: 'nearest' });
    }
  }

  function chooseEntry(entry, { forceInsert = false } = {}) {
    if (!entry) return;
    const range = activeToken;
    if (entry.type === 'all') {
      close();
      onOpenCatalog?.(entry.sectionId);
      return;
    }
    const it = entry.item;
    const isConnector = entry.sectionId === 'connectors' || it.kind === 'connector';

    if (range?.trigger === '@') {
      const mention = `@${it.id || it.name}`;
      close();
      applyTokenReplacement(input, range, mention);
      onSelectItem?.(it, { inserted: true, runImmediately: false, range, isMention: true });
      return;
    }

    if (isConnector) {
      if (forceInsert && range) {
        const mention = `@${it.id || it.name}`;
        close();
        applyTokenReplacement(input, range, mention);
        onSelectItem?.(it, { inserted: true, runImmediately: false, range, isMention: true });
        return;
      }
      close();
      onOpenCatalog?.('connectors', { focusConnectorId: it.id || it.name });
      return;
    }

    if (entry.sectionId === 'plugins' || it.kind === 'plugin') {
      close();
      onOpenCatalog?.('plugins', { focusPluginId: it.id || it.name });
      return;
    }
    if (it.kind === 'draft') {
      close();
      onOpenCatalog?.(it.section || entry.sectionId);
      return;
    }

    const slash = it.slash || `/${it.name}`;
    const insertOnly = forceInsert || shouldInsertOnly(it, Boolean(range?.isChained));
    close();

    if (insertOnly && range) {
      applyTokenReplacement(input, range, slash);
      onSelectItem?.(it, { inserted: true, runImmediately: false, range });
      return;
    }

    if (range && range.isChained) {
      applyTokenReplacement(input, range, slash);
      onSelectItem?.(it, { inserted: true, runImmediately: false, range });
      return;
    }

    input.value = slash;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    onSelectItem?.(it, { inserted: false, runImmediately: true, range });
  }

  function buildItemRow(it, sectionId, ctxPct, { isMentionMode = false } = {}) {
    const isSkill = sectionId === 'skills' || it.kind === 'skill';
    const isPlugin = sectionId === 'plugins' || it.kind === 'plugin';
    const isConnector = sectionId === 'connectors' || it.kind === 'connector';
    const isPaused = Boolean(it.pausedInMode);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `slash-menu__row${it.kind === 'draft' ? ' is-draft' : ''}${isPaused ? ' is-paused' : ''}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');

    const iconWrap = document.createElement('span');
    iconWrap.className = 'slash-menu__icon';
    const iconName = isConnector
      ? connectorIconName(it)
      : (isPlugin
        ? pluginIconName(it)
        : (it.icon || (it.isPack ? 'layers' : (isSkill ? 'sparkles' : it.name))));
    iconWrap.appendChild(createIconSvg(iconName, 18));

    const main = document.createElement('span');
    main.className = 'slash-menu__main';

    if (isConnector) {
      const chip = document.createElement('span');
      chip.className = 'slash-mention-chip';
      chip.textContent = `@${it.id || it.name}`;
      main.appendChild(chip);

      if (it.name && it.name !== it.id) {
        const nameSpan = document.createElement('span');
        nameSpan.className = 'slash-menu__mention-name';
        nameSpan.textContent = it.name;
        main.appendChild(nameSpan);
      }

      if (it.description) {
        const desc = document.createElement('span');
        desc.className = 'slash-menu__desc';
        desc.textContent = it.description;
        main.appendChild(desc);
      }
    } else {
      const title = document.createElement('span');
      title.className = 'slash-menu__title';
      title.textContent = isPlugin ? (it.name || it.id) : (it.slash || `/${it.name}`);
      main.appendChild(title);

      if (it.argsHint && !isPlugin) {
        const args = document.createElement('span');
        args.className = 'slash-menu__args';
        args.textContent = it.argsHint;
        main.appendChild(args);
      }

      if (it.description) {
        const desc = document.createElement('span');
        desc.className = 'slash-menu__desc';
        desc.textContent = it.description;
        main.appendChild(desc);
      }
    }

    row.append(iconWrap, main);

    const right = document.createElement('span');
    right.className = 'slash-menu__right';

    if (isPaused) {
      const pausedBadge = document.createElement('span');
      pausedBadge.className = 'slash-menu__badge slash-menu__badge--paused';
      pausedBadge.textContent = 'Пауза';
      if (it.pauseReason) pausedBadge.title = it.pauseReason;
      right.appendChild(pausedBadge);
    }

    if (isConnector) {
      const dot = document.createElement('span');
      dot.className = `slash-status-dot ${connectorStatusDotClass(it)}`;
      dot.title = it.statusLabel || defaultConnectorStatusLabel(it.status);
      right.appendChild(dot);
      if (!isPaused && it.statusLabel) {
        const stBadge = document.createElement('span');
        stBadge.className = 'slash-menu__badge slash-menu__badge--meta';
        stBadge.textContent = String(it.statusLabel);
        right.appendChild(stBadge);
      }
    } else if (isPlugin) {
      if (it.statusNote) {
        const metaBadge = document.createElement('span');
        metaBadge.className = 'slash-menu__badge slash-menu__badge--meta';
        metaBadge.textContent = String(it.statusNote);
        right.appendChild(metaBadge);
      } else if (it.isCustom) {
        const customBadge = document.createElement('span');
        customBadge.className = 'slash-menu__badge slash-menu__badge--meta';
        customBadge.textContent = 'Свой';
        right.appendChild(customBadge);
      }
    } else if (isSkill) {
      if (it.isPack && it.subCount) {
        const packBadge = document.createElement('span');
        packBadge.className = 'slash-menu__badge slash-menu__badge--meta';
        packBadge.textContent = `Пак · ${it.subCount}`;
        right.appendChild(packBadge);
      } else if (it.alwaysOn) {
        const alwaysBadge = document.createElement('span');
        alwaysBadge.className = 'slash-menu__badge slash-menu__badge--always';
        if (!isPaused) {
          const dot = document.createElement('span');
          dot.className = 'slash-menu__dot slash-menu__dot--green';
          alwaysBadge.appendChild(dot);
        }
        const lbl = document.createElement('span');
        lbl.textContent = 'Всегда';
        alwaysBadge.appendChild(lbl);
        right.appendChild(alwaysBadge);
      } else if (it.stageNote) {
        const stageBadge = document.createElement('span');
        stageBadge.className = 'slash-menu__badge slash-menu__badge--meta';
        stageBadge.textContent = String(it.stageNote);
        right.appendChild(stageBadge);
      } else if (Number.isFinite(it.tokens) && it.tokens > 0) {
        const tokBadge = document.createElement('span');
        tokBadge.className = 'slash-menu__badge slash-menu__badge--meta';
        tokBadge.textContent = `~${it.tokens} ток`;
        right.appendChild(tokBadge);
      }
    } else {
      if (it.active) {
        const dot = document.createElement('span');
        dot.className = 'slash-menu__dot';
        dot.title = 'Активно';
        right.appendChild(dot);
      }

      const isCompact = it.name === 'compact';
      const livePct = isCompact ? parsePctFromBadge(it.badge, ctxPct) : null;
      if (isCompact && livePct !== null) {
        const badge = document.createElement('span');
        badge.className = 'slash-menu__badge';
        const ring = document.createElement('span');
        ring.className = 'slash-menu__ring';
        ring.appendChild(createProgressRingSvg(livePct, 16));
        const pctText = document.createElement('span');
        pctText.textContent = `${livePct}%`;
        badge.append(ring, pctText);
        right.appendChild(badge);
      } else if (it.badge) {
        const badge = document.createElement('span');
        badge.className = 'slash-menu__badge';
        badge.textContent = String(it.badge);
        right.appendChild(badge);
      }
    }

    if (right.childNodes.length) row.appendChild(right);

    const entry = { type: 'item', item: it, sectionId, el: row };
    const rowIdx = flatRows.length;
    flatRows.push(entry);

    row.addEventListener('mouseenter', () => highlight(rowIdx));
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      chooseEntry(entry);
    });
    return row;
  }

  function buildAllRow(sec, totalOverride = null) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'slash-menu__all-row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');

    const iconWrap = document.createElement('span');
    iconWrap.className = 'slash-menu__icon';
    iconWrap.appendChild(createIconSvg('grid', 18));

    const label = document.createElement('span');
    label.textContent = sec.allLabel || `Все ${sec.title.toLowerCase()}`;

    const count = document.createElement('span');
    count.className = 'slash-menu__all-count';
    count.textContent = String(totalOverride ?? (sec.items || []).length);

    row.append(iconWrap, label, count);

    const entry = { type: 'all', sectionId: sec.id, el: row };
    const rowIdx = flatRows.length;
    flatRows.push(entry);

    row.addEventListener('mouseenter', () => highlight(rowIdx));
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      chooseEntry(entry);
    });
    return row;
  }

  function render() {
    if (!activeToken) {
      close();
      return;
    }
    const ctx = getContext?.() || {};
    const data = catalog || buildFallbackCatalog(ctx);
    const q = activeToken.query;
    const isMention = activeToken.trigger === '@';
    const isChained = activeToken.isChained;
    const ctxPct = Number.isFinite(ctx.pct) ? Math.round(ctx.pct) : null;

    flatRows = [];
    const frag = document.createDocumentFragment();

    if (isMention) {
      const connSec = (data.sections || []).find((s) => s.id === 'connectors') || {
        id: 'connectors',
        title: 'Коннекторы',
        allLabel: 'Все коннекторы',
        items: FALLBACK_CONNECTORS.map((c) => applyConnectorModePause(c, ctx)),
      };
      const allConn = Array.isArray(connSec.items) ? connSec.items : [];
      let items = allConn.filter((it) => it.enabled !== false && it.kind !== 'draft');
      if (q) {
        items = items
          .map((it) => ({ it, score: scoreItem(it, q) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.it);
      }

      if (items.length) {
        const secEl = document.createElement('div');
        secEl.className = 'slash-menu__section';

        const head = document.createElement('div');
        head.className = 'slash-menu__section-head';
        const headTitle = document.createElement('span');
        headTitle.textContent = 'Коннекторы';
        const hint = document.createElement('span');
        hint.className = 'slash-menu__section-stage';
        hint.textContent = 'Упоминание @';
        head.append(headTitle, hint);
        secEl.appendChild(head);

        const visible = q ? items : items.slice(0, 10);
        for (const it of visible) {
          secEl.appendChild(buildItemRow(it, 'connectors', ctxPct, { isMentionMode: true }));
        }

        if (!q) {
          secEl.appendChild(buildAllRow(connSec, allConn.length));
        }

        frag.appendChild(secEl);
      }

      if (!flatRows.length) {
        const empty = document.createElement('div');
        empty.className = 'slash-menu__empty';
        empty.textContent = 'Подходящий коннектор не найден';
        frag.appendChild(empty);
      }

      menu.replaceChildren(frag);
      menu.hidden = false;
      open = true;
      activeIndex = 0;
      if (flatRows.length) highlight(0);
      return;
    }

    if (isChained) {
      const chainBar = document.createElement('div');
      chainBar.className = 'slash-menu__chain-bar';
      const left = document.createElement('span');
      left.textContent = `Цепочка: ${activeToken.prevTokens.join(' ')}`;
      const right = document.createElement('span');
      right.textContent = 'Tab — добавить навык';
      chainBar.append(left, right);
      frag.appendChild(chainBar);
    }

    for (const sec of data.sections || []) {
      if (sec.id === 'docker') continue;
      let items = Array.isArray(sec.items) ? sec.items : [];
      if (sec.id === 'skills' || sec.id === 'plugins' || sec.id === 'connectors') {
        items = items.filter((it) => it.enabled !== false);
      }
      if (isChained) {
        items = items.filter((it) => it.chainable || it.kind === 'skill' || it.kind === 'prompt');
      }
      if (q) {
        items = items
          .map((it) => ({ it, score: scoreItem(it, q) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.it);
      }

      if (!items.length && q) continue;
      if (!items.length && isChained) continue;

      const secEl = document.createElement('div');
      secEl.className = 'slash-menu__section';

      const head = document.createElement('div');
      head.className = 'slash-menu__section-head';
      const headTitle = document.createElement('span');
      headTitle.textContent = sec.title;
      head.appendChild(headTitle);
      if (sec.stage) {
        const st = document.createElement('span');
        st.className = 'slash-menu__section-stage';
        st.textContent = `Этап ${sec.stage}`;
        head.appendChild(st);
      }
      secEl.appendChild(head);

      const limit = q ? items.length : (INITIAL_LIMITS[sec.id] ?? 6);
      const visible = items.slice(0, limit);
      for (const it of visible) {
        secEl.appendChild(buildItemRow(it, sec.id, ctxPct));
      }

      if (!q && !isChained && sec.allLabel) {
        secEl.appendChild(buildAllRow(sec));
      }

      frag.appendChild(secEl);
    }

    if (!flatRows.length) {
      const empty = document.createElement('div');
      empty.className = 'slash-menu__empty';
      empty.textContent = 'Ничего не найдено';
      frag.appendChild(empty);
    }

    menu.replaceChildren(frag);
    menu.hidden = false;
    open = true;
    activeIndex = 0;
    if (flatRows.length) highlight(0);
  }

  function updateFromInput() {
    const caret = input.selectionStart ?? input.value.length;
    const token = extractActiveSlashToken(input.value, caret)
      || extractActiveMentionToken(input.value, caret);
    if (!token) {
      if (open) close();
      return;
    }
    activeToken = token;
    render();
    ensureCatalog(false);
  }

  function onInputEvent() {
    updateFromInput();
  }

  function onKeyUp(e) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      updateFromInput();
    }
  }

  function onClickInput() {
    updateFromInput();
  }

  function onKeyDown(e) {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlight(activeIndex + 1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlight(activeIndex - 1);
      return;
    }
    if (e.key === 'Tab') {
      if (!flatRows.length) return;
      e.preventDefault();
      chooseEntry(flatRows[activeIndex], { forceInsert: true });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (!flatRows.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      chooseEntry(flatRows[activeIndex], { forceInsert: false });
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  }

  function onWindowKeyDown(e) {
    if (open && e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  }

  function onDocMouseDown(e) {
    if (!open) return;
    if (menu.contains(e.target) || e.target === input) return;
    close();
  }

  function onSkillsChangedEvent() {
    ensureCatalog(true);
  }

  input.addEventListener('input', onInputEvent);
  input.addEventListener('keyup', onKeyUp);
  input.addEventListener('click', onClickInput);
  input.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keydown', onWindowKeyDown, true);
  window.addEventListener('capri:skills-changed', onSkillsChangedEvent);
  window.addEventListener('capri:plugins-changed', onSkillsChangedEvent);
  window.addEventListener('capri:connectors-changed', onSkillsChangedEvent);
  document.addEventListener('mousedown', onDocMouseDown);

  return {
    close,
    isOpen: () => open,
    refresh: () => ensureCatalog(true),
    destroy() {
      close();
      input.removeEventListener('input', onInputEvent);
      input.removeEventListener('keyup', onKeyUp);
      input.removeEventListener('click', onClickInput);
      input.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keydown', onWindowKeyDown, true);
      window.removeEventListener('capri:skills-changed', onSkillsChangedEvent);
      window.removeEventListener('capri:plugins-changed', onSkillsChangedEvent);
      window.removeEventListener('capri:connectors-changed', onSkillsChangedEvent);
      document.removeEventListener('mousedown', onDocMouseDown);
      menu.remove();
    },
  };
}

// ---------------------------------------------------------------- Catalog Modal (Commands, Skills, Draft Sections)

let activeModalCleanup = null;

function createToggleSwitch(checked, { label, disabled = false, onToggle }) {
  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = `slash-switch${checked ? ' is-on' : ''}`;
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(Boolean(checked)));
  if (label) sw.setAttribute('aria-label', label);
  sw.disabled = Boolean(disabled);

  const thumb = document.createElement('span');
  thumb.className = 'slash-switch__thumb';
  thumb.setAttribute('aria-hidden', 'true');
  sw.appendChild(thumb);

  if (typeof onToggle === 'function') {
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggle(e);
    });
  }
  return sw;
}

export async function openCatalogModal({
  initialTab = 'commands',
  focusPluginId = null,
  focusConnectorId = null,
  getContext,
  onRunCommand,
  onSkillsChanged,
  onPluginsChanged,
  onConnectorsChanged,
} = {}) {
  if (activeModalCleanup) {
    activeModalCleanup();
    activeModalCleanup = null;
  }

  const ctx = getContext?.() || {};
  const ctxPct = Number.isFinite(ctx.pct) ? Math.round(ctx.pct) : null;
  let catalog = buildFallbackCatalog(ctx);
  let skillsData = normalizeSkillsResponse({
    items: catalog.sections.find((s) => s.id === 'skills')?.items || [],
  });
  let pluginsData = normalizePluginsResponse({}, catalog.sections.find((s) => s.id === 'plugins')?.items || FALLBACK_PLUGINS, ctx);
  let connectorsData = normalizeConnectorsResponse({}, catalog.sections.find((s) => s.id === 'connectors')?.items || FALLBACK_CONNECTORS, ctx);
  let dockerData = normalizeDockerStatus(null);
  let dockerLoaded = false;
  let dockerLoading = false;
  let dockerRefreshing = false;
  let dockerConfirmStop = null; // { host, stackId, container?, name, message }
  let openNomadStackId = null;
  let nomadSubmodalBackdrop = null;
  const pendingDockerOps = new Set();
  let activeTab = initialTab || 'commands';
  let searchQuery = '';
  let noticeText = '';
  let activeForm = null; // null | 'create' | 'install' | 'plugin-create' | 'plugin-install' | 'hookify-add' | 'connector-add'
  let plusPanelOpen = false;
  let inlineHookifyFormOpen = false;
  let formBusy = false;
  let formError = '';
  let hookifyError = '';
  let reloadingSkills = false;
  let reloadingPlugins = false;
  let reloadingConnectors = false;
  let checkingAllConnectors = false;
  let digestBusy = false;
  let digestResult = null; // { path, chars, generatedAt, preview, markdown } | null
  let openSetupConnectorId = null;
  let confirmRemoveConnectorId = null;
  let pendingFocusPluginId = focusPluginId || null;
  let pendingFocusConnectorId = focusConnectorId || null;
  const pendingToggles = new Set();
  const pendingPluginToggles = new Set();
  const pendingConnectorToggles = new Set();
  const pendingConnectorChecks = new Set();
  const pendingConnectorRemoves = new Set();
  const pendingConnectorConfigs = new Set();
  const connectorConfigFeedback = new Map(); // id -> { ok: boolean, text: string }
  const pendingHookifyOps = new Set();
  const collapsedGroups = new Set();
  const expandedPlugins = new Set(focusPluginId ? [focusPluginId] : []);

  const createDraft = {
    name: '',
    slug: '',
    category: 'system',
    description: '',
    body: '',
    alwaysOn: false,
  };
  const installDraft = {
    sourceType: 'path', // 'path' | 'markdown'
    sourcePath: '',
    markdown: '',
    slug: '',
    category: 'system',
    preview: null,
    previewMessage: '',
  };
  const pluginCreateDraft = {
    name: '',
    slug: '',
    category: 'dev',
    description: '',
    skills: '',
    rules: '',
    cloudOnly: false,
    vaultOnly: false,
  };
  const pluginInstallDraft = {
    sourceType: 'path', // 'path' | 'json'
    sourcePath: '',
    manifestJson: '',
    slug: '',
    preview: null,
    previewMessage: '',
  };
  const hookifyDraft = {
    name: '',
    triggerPattern: '',
    action: 'warn', // 'warn' | 'inject' | 'block'
    message: '',
  };
  const connectorAddDraft = {
    name: '',
    slug: '',
    category: 'dev',
    transport: 'http', // 'http' | 'stdio'
    url: '',
    command: '',
    args: '',
    token: '',
    scope: 'cloud', // 'cloud' | 'local'
    preview: null,
    previewMessage: '',
  };
  const connectorSetupDrafts = {
    telegram: { token: '' },
    wger: { url: '', token: '' },
    'health-connect': { steps: '', sleepHours: '', avgHr: '', notes: '' },
    'google-workspace': { setupSteps: [...DEFAULT_GOOGLE_WORKSPACE_STEPS] },
  };

  const backdrop = document.createElement('div');
  backdrop.className = 'slash-catalog-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Каталог команд, навыков, плагинов и коннекторов');

  const modal = document.createElement('div');
  modal.className = 'slash-catalog';

  const top = document.createElement('div');
  top.className = 'slash-catalog__top';

  const bar = document.createElement('div');
  bar.className = 'slash-catalog__bar';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'slash-catalog__close';
  closeBtn.setAttribute('aria-label', 'Закрыть каталог');
  closeBtn.title = 'Закрыть';
  closeBtn.appendChild(createIconSvg('close', 20));

  const searchWrap = document.createElement('div');
  searchWrap.className = 'slash-catalog__search-wrap';
  searchWrap.appendChild(createIconSvg('search', 18));

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'slash-catalog__search';
  searchInput.placeholder = 'Поиск по командам, навыкам, плагинам, коннекторам и Docker…';
  searchInput.setAttribute('aria-label', 'Поиск по каталогу');
  searchWrap.appendChild(searchInput);

  const plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'slash-catalog__plus-btn';
  plusBtn.setAttribute('aria-label', 'Создать или установить');
  plusBtn.title = 'Создать или установить';
  plusBtn.appendChild(createIconSvg('plus', 18));
  plusBtn.addEventListener('click', () => {
    if (activeTab === 'connectors') {
      if (activeForm === 'connector-add') {
        activeForm = null;
        formError = '';
        connectorAddDraft.preview = null;
        connectorAddDraft.previewMessage = '';
      } else {
        activeForm = 'connector-add';
        plusPanelOpen = false;
        formError = '';
        connectorAddDraft.preview = null;
        connectorAddDraft.previewMessage = '';
      }
      renderModal();
      return;
    }
    if (activeForm) {
      activeForm = null;
      formError = '';
      installDraft.preview = null;
      pluginInstallDraft.preview = null;
      connectorAddDraft.preview = null;
      plusPanelOpen = false;
    } else {
      plusPanelOpen = !plusPanelOpen;
    }
    renderModal();
  });

  bar.append(closeBtn, searchWrap, plusBtn);

  const plusPanelEl = document.createElement('div');
  plusPanelEl.className = 'slash-catalog__plus-panel';
  plusPanelEl.hidden = true;

  const tabsEl = document.createElement('div');
  tabsEl.className = 'slash-catalog__tabs';
  tabsEl.setAttribute('role', 'tablist');

  top.append(bar, plusPanelEl, tabsEl);

  const body = document.createElement('div');
  body.className = 'slash-catalog__body';

  modal.append(top, body);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  function syncSkillsIntoCatalog() {
    const sections = catalog.sections || [];
    const skillSec = sections.find((s) => s.id === 'skills');
    if (skillSec && Array.isArray(skillsData?.items)) {
      skillSec.items = skillsData.items;
    }
  }

  function syncPluginsIntoCatalog() {
    const sections = catalog.sections || [];
    const pluginSec = sections.find((s) => s.id === 'plugins');
    if (pluginSec && Array.isArray(pluginsData?.items)) {
      delete pluginSec.stage;
      pluginSec.items = pluginsData.items;
    }
  }

  function syncConnectorsIntoCatalog() {
    const sections = catalog.sections || [];
    const connSec = sections.find((s) => s.id === 'connectors');
    if (connSec && Array.isArray(connectorsData?.items)) {
      delete connSec.stage;
      connSec.items = connectorsData.items;
    }
  }

  function ensureDockerSectionInCatalog() {
    if (!Array.isArray(catalog.sections)) catalog.sections = [];
    if (catalog.sections.some((s) => s.id === 'docker')) return;
    const dockerSec = {
      id: 'docker',
      title: 'Docker',
      allLabel: 'Пульт Docker',
      items: [],
    };
    const stylesIdx = catalog.sections.findIndex((s) => s.id === 'styles');
    if (stylesIdx >= 0) {
      catalog.sections.splice(stylesIdx, 0, dockerSec);
    } else {
      catalog.sections.push(dockerSec);
    }
  }

  ensureDockerSectionInCatalog();

  function emitSkillsChanged(nextData) {
    skillsData = normalizeSkillsResponse(nextData, skillsData.items);
    syncSkillsIntoCatalog();
    try {
      onSkillsChanged?.(skillsData);
    } catch {
      // ignore listener errors
    }
    window.dispatchEvent(new CustomEvent('capri:skills-changed', { detail: skillsData }));
  }

  async function emitPluginsChanged(nextData, { refreshSkills = false } = {}) {
    pluginsData = normalizePluginsResponse(nextData, pluginsData.items, ctx);
    syncPluginsIntoCatalog();
    try {
      onPluginsChanged?.(pluginsData);
    } catch {
      // ignore listener errors
    }
    window.dispatchEvent(new CustomEvent('capri:plugins-changed', { detail: pluginsData }));
    if (refreshSkills) {
      const refreshedSkills = await fetchSkills(ctx, skillsData.items);
      emitSkillsChanged(refreshedSkills);
    }
  }

  function emitConnectorsChanged(nextData) {
    connectorsData = normalizeConnectorsResponse(nextData, connectorsData.items, ctx);
    syncConnectorsIntoCatalog();
    try {
      onConnectorsChanged?.(connectorsData);
    } catch {
      // ignore listener errors
    }
    window.dispatchEvent(new CustomEvent('capri:connectors-changed', { detail: connectorsData }));
  }

  function closeNomadPackModal() {
    openNomadStackId = null;
    if (nomadSubmodalBackdrop) {
      nomadSubmodalBackdrop.remove();
      nomadSubmodalBackdrop = null;
    }
  }

  function cleanup() {
    closeNomadPackModal();
    window.removeEventListener('keydown', onEscape, true);
    backdrop.remove();
    if (activeModalCleanup === cleanup) activeModalCleanup = null;
  }

  function onEscape(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (openNomadStackId) {
        if (dockerConfirmStop && dockerConfirmStop.stackId === openNomadStackId) {
          dockerConfirmStop = null;
          renderNomadPackModal();
          return;
        }
        closeNomadPackModal();
        return;
      }
      if (dockerConfirmStop) {
        dockerConfirmStop = null;
        renderModal();
        return;
      }
      if (activeForm || plusPanelOpen || inlineHookifyFormOpen || confirmRemoveConnectorId || openSetupConnectorId) {
        activeForm = null;
        plusPanelOpen = false;
        inlineHookifyFormOpen = false;
        confirmRemoveConnectorId = null;
        openSetupConnectorId = null;
        formError = '';
        hookifyError = '';
        installDraft.preview = null;
        pluginInstallDraft.preview = null;
        connectorAddDraft.preview = null;
        connectorAddDraft.previewMessage = '';
        renderModal();
        return;
      }
      cleanup();
    }
  }

  activeModalCleanup = cleanup;
  closeBtn.addEventListener('click', cleanup);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) cleanup();
  });
  window.addEventListener('keydown', onEscape, true);

  function renderTopPlusControls() {
    const supportsPlus = activeTab === 'skills' || activeTab === 'plugins' || activeTab === 'connectors';
    plusBtn.hidden = !supportsPlus;
    if (!supportsPlus) {
      plusPanelEl.hidden = true;
      return;
    }
    const labelText = activeTab === 'skills'
      ? 'Создать или установить навык'
      : (activeTab === 'plugins'
        ? 'Создать, установить плагин или добавить правило Hookify'
        : 'Добавить MCP-коннектор');
    plusBtn.title = labelText;
    plusBtn.setAttribute('aria-label', labelText);
    plusBtn.setAttribute('aria-expanded', String(plusPanelOpen || Boolean(activeForm)));
    plusBtn.classList.toggle('is-active', plusPanelOpen || Boolean(activeForm));

    if (!plusPanelOpen || activeTab === 'connectors') {
      plusPanelEl.hidden = true;
      return;
    }

    plusPanelEl.hidden = false;
    const panelLabel = document.createElement('span');
    panelLabel.className = 'slash-catalog__plus-panel-label';
    panelLabel.textContent = activeTab === 'skills' ? 'Добавить навык' : 'Добавить плагин или правило';

    const panelActions = document.createElement('div');
    panelActions.className = 'slash-catalog__plus-panel-actions';

    const items = activeTab === 'skills'
      ? [
        { id: 'create', icon: 'plus', label: 'Создать навык' },
        { id: 'install', icon: 'download', label: 'Установить навык' },
      ]
      : [
        { id: 'plugin-create', icon: 'plus', label: 'Создать плагин' },
        { id: 'plugin-install', icon: 'download', label: 'Установить плагин' },
        { id: 'hookify-add', icon: 'shield', label: 'Добавить правило Hookify' },
      ];

    for (const act of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `slash-catalog__action-btn${activeForm === act.id ? ' is-active' : ''}`;
      btn.append(createIconSvg(act.icon, 15), document.createTextNode(act.label));
      btn.addEventListener('click', () => {
        activeForm = act.id;
        plusPanelOpen = false;
        formError = '';
        hookifyError = '';
        installDraft.preview = null;
        pluginInstallDraft.preview = null;
        renderModal();
      });
      panelActions.appendChild(btn);
    }

    plusPanelEl.replaceChildren(panelLabel, panelActions);
  }

  function renderTabs() {
    ensureDockerSectionInCatalog();
    const sections = catalog.sections || [];
    if (!sections.some((s) => s.id === activeTab) && sections.length) {
      activeTab = sections[0].id;
    }
    tabsEl.replaceChildren(...sections.map((sec) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `slash-catalog__tab${sec.id === activeTab ? ' is-active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(sec.id === activeTab));

      const label = document.createElement('span');
      label.textContent = sec.title;
      const count = document.createElement('span');
      count.className = 'slash-catalog__tab-count';
      let countText = '';
      if (sec.id === 'skills') {
        countText = String((skillsData.items || []).length);
      } else if (sec.id === 'plugins') {
        countText = String((pluginsData.items || []).length);
      } else if (sec.id === 'connectors') {
        countText = String((connectorsData.items || []).length);
      } else if (sec.id === 'docker') {
        const pcRun = Number(dockerData?.pc?.runningCount) || 0;
        const pcTot = Number(dockerData?.pc?.totalCount) || (dockerData?.pc?.stacks?.length || 0);
        const srvRun = Number(dockerData?.lenovo?.runningCount) || 0;
        const srvTot = Number(dockerData?.lenovo?.totalCount) || (dockerData?.lenovo?.stacks?.length || 0);
        const tot = pcTot + srvTot;
        const run = pcRun + srvRun;
        countText = dockerLoaded && !dockerData?.isFallback ? `${run}/${tot}` : String(tot);
      } else {
        countText = String((sec.items || []).length);
      }
      count.textContent = countText;

      btn.append(label, count);
      btn.addEventListener('click', () => {
        activeTab = sec.id;
        noticeText = '';
        plusPanelOpen = false;
        activeForm = null;
        confirmRemoveConnectorId = null;
        dockerConfirmStop = null;
        formError = '';
        hookifyError = '';
        renderModal();
        if (sec.id === 'docker' && !dockerLoaded && !dockerLoading) {
          loadDockerStatus({ refresh: false });
        }
      });
      return btn;
    }));
    renderTopPlusControls();
  }

  function buildCatalogItem(it, secStage) {
    const isDraft = it.kind === 'draft';
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `slash-catalog__item${isDraft ? ' is-draft' : ''}`;

    const avatar = document.createElement('span');
    avatar.className = 'slash-catalog__avatar';
    avatar.appendChild(createIconSvg(it.icon || it.name, 18));

    const main = document.createElement('span');
    main.className = 'slash-catalog__item-main';

    const topLine = document.createElement('span');
    topLine.className = 'slash-catalog__item-top';

    const nameEl = document.createElement('span');
    nameEl.className = 'slash-catalog__item-name';
    nameEl.textContent = it.title || it.name;
    topLine.appendChild(nameEl);

    if (!isDraft) {
      const slashEl = document.createElement('span');
      slashEl.className = 'slash-catalog__item-slash';
      slashEl.textContent = it.slash || `/${it.name}`;
      topLine.appendChild(slashEl);
    }

    const descEl = document.createElement('span');
    descEl.className = 'slash-catalog__item-desc';
    descEl.textContent = it.description || '';

    main.append(topLine, descEl);

    const right = document.createElement('span');
    right.className = 'slash-catalog__item-right';

    if (it.active) {
      const dot = document.createElement('span');
      dot.className = 'slash-menu__dot';
      dot.title = 'Активно';
      right.appendChild(dot);
    }

    const isCompact = it.name === 'compact';
    const livePct = isCompact ? parsePctFromBadge(it.badge, ctxPct) : null;
    if (isCompact && livePct !== null) {
      const badge = document.createElement('span');
      badge.className = 'slash-menu__badge';
      const ring = document.createElement('span');
      ring.className = 'slash-menu__ring';
      ring.appendChild(createProgressRingSvg(livePct, 16));
      const pctText = document.createElement('span');
      pctText.textContent = `${livePct}%`;
      badge.append(ring, pctText);
      right.appendChild(badge);
    } else if (isDraft) {
      const stage = document.createElement('span');
      stage.className = 'slash-catalog__stage';
      stage.textContent = it.badge || (secStage ? `Этап ${secStage}` : 'Скоро');
      right.appendChild(stage);
    } else if (it.badge) {
      const badge = document.createElement('span');
      badge.className = 'slash-menu__badge';
      badge.textContent = String(it.badge);
      right.appendChild(badge);
    }

    row.append(avatar, main, right);

    row.addEventListener('click', () => {
      if (isDraft) {
        const tag = it.badge || (secStage ? `Этап ${secStage}` : 'в ближайшем обновлении');
        noticeText = `${it.title || it.name} — запланировано (${tag}).`;
        renderModal();
        return;
      }
      cleanup();
      onRunCommand?.(it);
    });
    return row;
  }

  async function handleSkillToggle(skill, patch) {
    const id = skill.id || skill.name;
    if (!id || pendingToggles.has(id)) return;
    pendingToggles.add(id);

    const host = window.host;
    if (typeof host?.skillsToggle === 'function') {
      try {
        const res = await host.skillsToggle({ id, ...patch });
        if (res && res.ok !== false) {
          if (Array.isArray(res.categories) || Array.isArray(res.items)) {
            emitSkillsChanged(res);
          } else {
            const refreshed = await fetchSkills(ctx, skillsData.items);
            emitSkillsChanged(refreshed);
          }
          noticeText = '';
        } else {
          noticeText = res?.error || 'Не удалось обновить состояние навыка.';
        }
      } catch (err) {
        noticeText = err?.message || 'Не удалось обновить состояние навыка.';
      }
    } else {
      // Local fallback update when backend IPC is unavailable
      const nextItems = (skillsData.items || []).map((s) => {
        if ((s.id || s.name) !== id) return s;
        return {
          ...s,
          ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
          ...(typeof patch.alwaysOn === 'boolean' ? { alwaysOn: patch.alwaysOn } : {}),
        };
      });
      emitSkillsChanged({ items: nextItems });
    }

    pendingToggles.delete(id);
    if (document.body.contains(backdrop)) renderModal();
  }

  function buildSkillRow(it) {
    const id = it.id || it.name;
    const enabled = it.enabled !== false;
    const alwaysOn = Boolean(it.alwaysOn);
    const paused = Boolean(it.pausedInMode);
    const busy = pendingToggles.has(id);

    const row = document.createElement('div');
    row.className = `slash-catalog__item slash-catalog__skill-row${enabled ? '' : ' is-disabled'}`;

    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'slash-catalog__skill-hit';
    hit.disabled = !enabled;
    hit.title = enabled ? `Вставить ${it.slash || `/${id}`}` : 'Навык выключен';

    const avatar = document.createElement('span');
    avatar.className = 'slash-catalog__avatar';
    avatar.appendChild(createIconSvg(it.icon || (it.isPack ? 'layers' : 'sparkles'), 18));

    const main = document.createElement('span');
    main.className = 'slash-catalog__item-main';

    const topLine = document.createElement('span');
    topLine.className = 'slash-catalog__item-top';

    const nameEl = document.createElement('span');
    nameEl.className = 'slash-catalog__item-name';
    nameEl.textContent = it.name || id;
    topLine.appendChild(nameEl);

    const slashEl = document.createElement('span');
    slashEl.className = 'slash-catalog__item-slash';
    slashEl.textContent = it.slash || `/${id}`;
    topLine.appendChild(slashEl);

    if (it.isPack && it.subCount) {
      const packChip = document.createElement('span');
      packChip.className = 'slash-skill-chip';
      packChip.textContent = `Пак · ${it.subCount}`;
      topLine.appendChild(packChip);
    }
    if (it.stageNote) {
      const stageChip = document.createElement('span');
      stageChip.className = 'slash-skill-chip';
      stageChip.textContent = String(it.stageNote);
      topLine.appendChild(stageChip);
    }
    if (it.isCustom) {
      const customChip = document.createElement('span');
      customChip.className = 'slash-skill-chip';
      customChip.textContent = 'Свой';
      topLine.appendChild(customChip);
    }

    const descEl = document.createElement('span');
    descEl.className = 'slash-catalog__item-desc';
    descEl.textContent = it.description || '';

    main.append(topLine, descEl);

    if (paused) {
      const metaRow = document.createElement('span');
      metaRow.className = 'slash-catalog__meta-row';
      const pauseChip = document.createElement('span');
      pauseChip.className = 'slash-skill-chip slash-skill-chip--paused';
      pauseChip.textContent = 'Пауза в этом режиме';
      if (it.pauseReason) pauseChip.title = it.pauseReason;
      metaRow.appendChild(pauseChip);
      main.appendChild(metaRow);
    }

    hit.append(avatar, main);
    hit.addEventListener('click', () => {
      if (!enabled) return;
      cleanup();
      onRunCommand?.({ ...it, kind: 'skill', slash: it.slash || `/${id}` });
    });

    const right = document.createElement('span');
    right.className = 'slash-catalog__item-right';

    if (it.canPinAlways) {
      const pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.className = `slash-skill-pin${alwaysOn ? ' is-pinned' : ''}`;
      pinBtn.setAttribute('aria-pressed', String(alwaysOn));
      pinBtn.disabled = busy;
      pinBtn.title = alwaysOn
        ? 'Убрать из автоматического промпта'
        : 'Добавлять автоматически в каждое сообщение';

      const dot = document.createElement('span');
      dot.className = 'slash-skill-pin__dot';
      dot.setAttribute('aria-hidden', 'true');

      const lbl = document.createElement('span');
      lbl.textContent = 'Всегда';

      pinBtn.append(dot, lbl);
      const tokWeight = Number(it.alwaysOnTokens || it.tokens);
      if (Number.isFinite(tokWeight) && tokWeight > 0) {
        const tok = document.createElement('span');
        tok.className = 'slash-skill-pin__tokens';
        tok.textContent = `~${tokWeight} ток`;
        pinBtn.appendChild(tok);
      }

      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nextAlways = !alwaysOn;
        handleSkillToggle(it, {
          enabled: nextAlways ? true : enabled,
          alwaysOn: nextAlways,
        });
      });
      right.appendChild(pinBtn);
    }

    const sw = createToggleSwitch(enabled, {
      label: `${enabled ? 'Выключить' : 'Включить'} навык ${it.name || id}`,
      disabled: busy,
      onToggle: () => {
        handleSkillToggle(it, { enabled: !enabled });
      },
    });
    right.appendChild(sw);

    row.append(hit, right);
    return row;
  }

  function buildBudgetBar() {
    const b = skillsData.budget || {};
    const alwaysTok = Number.isFinite(b.alwaysOnTokens) ? Math.round(b.alwaysOnTokens) : 0;
    const indexTok = Number.isFinite(b.indexTokens) ? Math.round(b.indexTokens) : 0;
    const totalTok = Number.isFinite(b.totalAutoTokens) ? Math.round(b.totalAutoTokens) : (alwaysTok + indexTok);
    const limitTok = Number.isFinite(b.softLimitTokens) ? Math.round(b.softLimitTokens) : 4000;
    const over = Boolean(b.overSoftLimit);

    const strip = document.createElement('div');
    strip.className = `slash-budget${over ? ' is-over-limit' : ''}`;

    const main = document.createElement('span');
    main.className = 'slash-budget__main';

    const dot = document.createElement('span');
    dot.className = 'slash-budget__dot';
    dot.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.textContent = `Авто в промпте: ~${alwaysTok} ток · Индекс: ~${indexTok} ток`;

    main.append(dot, text);

    const meta = document.createElement('span');
    meta.className = 'slash-budget__meta';
    meta.textContent = over
      ? `Выше мягкого лимита (~${totalTok} / ${limitTok} ток)`
      : `Всего ~${totalTok} / ${limitTok} ток`;

    strip.append(main, meta);
    return strip;
  }

  function buildCreateSkillForm() {
    const form = document.createElement('form');
    form.className = 'slash-skill-form';
    form.autocomplete = 'off';

    const head = document.createElement('div');
    head.className = 'slash-skill-form__head';
    const title = document.createElement('h3');
    title.className = 'slash-skill-form__title';
    title.textContent = 'Создать навык';
    const closeFormBtn = document.createElement('button');
    closeFormBtn.type = 'button';
    closeFormBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--icon';
    closeFormBtn.setAttribute('aria-label', 'Закрыть форму');
    closeFormBtn.appendChild(createIconSvg('close', 16));
    closeFormBtn.addEventListener('click', () => {
      activeForm = null;
      formError = '';
      renderModal();
    });
    head.append(title, closeFormBtn);
    form.appendChild(head);

    if (formError) {
      const err = document.createElement('p');
      err.className = 'slash-skill-form__error';
      err.textContent = formError;
      form.appendChild(err);
    }

    const grid = document.createElement('div');
    grid.className = 'slash-skill-form__grid';

    // Name
    const nameField = document.createElement('label');
    nameField.className = 'slash-skill-form__field';
    const nameLbl = document.createElement('span');
    nameLbl.className = 'slash-skill-form__label';
    nameLbl.textContent = 'Название';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'slash-skill-form__input';
    nameInput.placeholder = 'Например, Редактор питчей';
    nameInput.value = createDraft.name;
    nameInput.required = true;
    nameInput.addEventListener('input', () => { createDraft.name = nameInput.value; });
    nameField.append(nameLbl, nameInput);

    // Slug (optional)
    const slugField = document.createElement('label');
    slugField.className = 'slash-skill-form__field';
    const slugLbl = document.createElement('span');
    slugLbl.className = 'slash-skill-form__label';
    slugLbl.textContent = 'Команда /slug (необязательно)';
    const slugInput = document.createElement('input');
    slugInput.type = 'text';
    slugInput.className = 'slash-skill-form__input';
    slugInput.placeholder = 'pitch-editor';
    slugInput.value = createDraft.slug;
    slugInput.addEventListener('input', () => { createDraft.slug = slugInput.value; });
    slugField.append(slugLbl, slugInput);

    // Category
    const catField = document.createElement('label');
    catField.className = 'slash-skill-form__field';
    const catLbl = document.createElement('span');
    catLbl.className = 'slash-skill-form__label';
    catLbl.textContent = 'Категория';
    const catSelect = document.createElement('select');
    catSelect.className = 'slash-skill-form__select';
    for (const c of SKILL_CATEGORIES) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.title;
      catSelect.appendChild(opt);
    }
    catSelect.value = createDraft.category || 'system';
    catSelect.addEventListener('change', () => { createDraft.category = catSelect.value; });
    catField.append(catLbl, catSelect);

    // Description
    const descField = document.createElement('label');
    descField.className = 'slash-skill-form__field';
    const descLbl = document.createElement('span');
    descLbl.className = 'slash-skill-form__label';
    descLbl.textContent = 'Краткое описание';
    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.className = 'slash-skill-form__input';
    descInput.placeholder = 'В одну строку: когда и зачем применять навык';
    descInput.value = createDraft.description;
    descInput.required = true;
    descInput.addEventListener('input', () => { createDraft.description = descInput.value; });
    descField.append(descLbl, descInput);

    // Body
    const bodyField = document.createElement('label');
    bodyField.className = 'slash-skill-form__field slash-skill-form__field--full';
    const bodyLbl = document.createElement('span');
    bodyLbl.className = 'slash-skill-form__label';
    bodyLbl.textContent = 'Инструкция навыка (Markdown)';
    const bodyArea = document.createElement('textarea');
    bodyArea.className = 'slash-skill-form__textarea';
    bodyArea.rows = 5;
    bodyArea.placeholder = 'Опиши правила, шаги и ограничения для модели…';
    bodyArea.value = createDraft.body;
    bodyArea.required = true;
    bodyArea.addEventListener('input', () => { createDraft.body = bodyArea.value; });
    bodyField.append(bodyLbl, bodyArea);

    grid.append(nameField, slugField, catField, descField, bodyField);
    form.appendChild(grid);

    // alwaysOn row
    const checkRow = document.createElement('div');
    checkRow.className = 'slash-skill-form__check-row';
    const checkCopy = document.createElement('span');
    checkCopy.className = 'slash-skill-form__check-copy';
    const checkStrong = document.createElement('strong');
    checkStrong.textContent = 'Всегда в промпте';
    const checkSmall = document.createElement('small');
    checkSmall.textContent = 'Подключать автоматически в каждом сообщении (для лёгких навыков)';
    checkCopy.append(checkStrong, checkSmall);
    const alwaysSwitch = createToggleSwitch(createDraft.alwaysOn, {
      label: 'Всегда в промпте',
      disabled: formBusy,
      onToggle: () => {
        createDraft.alwaysOn = !createDraft.alwaysOn;
        alwaysSwitch.classList.toggle('is-on', createDraft.alwaysOn);
        alwaysSwitch.setAttribute('aria-checked', String(createDraft.alwaysOn));
      },
    });
    checkRow.append(checkCopy, alwaysSwitch);
    form.appendChild(checkRow);

    const actions = document.createElement('div');
    actions.className = 'slash-skill-form__actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'slash-catalog__action-btn';
    cancelBtn.textContent = 'Отмена';
    cancelBtn.disabled = formBusy;
    cancelBtn.addEventListener('click', () => {
      activeForm = null;
      formError = '';
      renderModal();
    });

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--primary';
    submitBtn.textContent = formBusy ? 'Сохраняю…' : 'Сохранить навык';
    submitBtn.disabled = formBusy;

    actions.append(cancelBtn, submitBtn);
    form.appendChild(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (formBusy) return;
      const name = createDraft.name.trim();
      const description = createDraft.description.trim();
      const bodyText = createDraft.body.trim();
      if (!name || !description || !bodyText) {
        formError = 'Заполни название, краткое описание и текст инструкции.';
        renderModal();
        return;
      }
      if (typeof window.host?.skillsCreate !== 'function') {
        formError = 'Создание навыков недоступно в текущем режиме.';
        renderModal();
        return;
      }
      formBusy = true;
      formError = '';
      renderModal();
      try {
        const res = await window.host.skillsCreate({
          name,
          slug: createDraft.slug.trim() || undefined,
          category: createDraft.category || 'system',
          description,
          body: bodyText,
          alwaysOn: Boolean(createDraft.alwaysOn),
        });
        if (!res || res.ok === false) {
          formError = res?.error || 'Не удалось создать навык.';
        } else {
          if (Array.isArray(res.categories) || Array.isArray(res.items)) {
            emitSkillsChanged(res);
          } else {
            const refreshed = await fetchSkills(ctx, skillsData.items);
            emitSkillsChanged(refreshed);
          }
          const createdSlash = res.skill?.slash || (res.skill?.id ? `/${res.skill.id}` : '');
          noticeText = `Навык «${res.skill?.name || name}» создан${createdSlash ? ` (${createdSlash})` : ''}.`;
          activeForm = null;
          createDraft.name = '';
          createDraft.slug = '';
          createDraft.description = '';
          createDraft.body = '';
          createDraft.alwaysOn = false;
        }
      } catch (err) {
        formError = err?.message || 'Ошибка при создании навыка.';
      } finally {
        formBusy = false;
        if (document.body.contains(backdrop)) renderModal();
      }
    });

    return form;
  }

  function buildInstallSkillForm() {
    const form = document.createElement('form');
    form.className = 'slash-skill-form';
    form.autocomplete = 'off';

    const head = document.createElement('div');
    head.className = 'slash-skill-form__head';
    const title = document.createElement('h3');
    title.className = 'slash-skill-form__title';
    title.textContent = 'Установить навык';
    const closeFormBtn = document.createElement('button');
    closeFormBtn.type = 'button';
    closeFormBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--icon';
    closeFormBtn.setAttribute('aria-label', 'Закрыть форму');
    closeFormBtn.appendChild(createIconSvg('close', 16));
    closeFormBtn.addEventListener('click', () => {
      activeForm = null;
      formError = '';
      installDraft.preview = null;
      renderModal();
    });
    head.append(title, closeFormBtn);
    form.appendChild(head);

    if (formError) {
      const err = document.createElement('p');
      err.className = 'slash-skill-form__error';
      err.textContent = formError;
      form.appendChild(err);
    }

    const modeTabs = document.createElement('div');
    modeTabs.className = 'slash-skill-form__tabs';
    for (const [key, label] of [['path', 'Локальный файл'], ['markdown', 'Вставить Markdown']]) {
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = `slash-skill-form__tab${installDraft.sourceType === key ? ' is-active' : ''}`;
      tabBtn.textContent = label;
      tabBtn.disabled = formBusy;
      tabBtn.addEventListener('click', () => {
        installDraft.sourceType = key;
        installDraft.preview = null;
        formError = '';
        renderModal();
      });
      modeTabs.appendChild(tabBtn);
    }
    form.appendChild(modeTabs);

    const grid = document.createElement('div');
    grid.className = 'slash-skill-form__grid';

    if (installDraft.sourceType === 'path') {
      const pathField = document.createElement('label');
      pathField.className = 'slash-skill-form__field slash-skill-form__field--full';
      const pathLbl = document.createElement('span');
      pathLbl.className = 'slash-skill-form__label';
      pathLbl.textContent = 'Путь к файлу SKILL.md на ПК';
      const pathInput = document.createElement('input');
      pathInput.type = 'text';
      pathInput.className = 'slash-skill-form__input';
      pathInput.placeholder = 'D:\\path\\to\\skill\\SKILL.md';
      pathInput.value = installDraft.sourcePath;
      pathInput.addEventListener('input', () => {
        installDraft.sourcePath = pathInput.value;
        installDraft.preview = null;
      });
      pathField.append(pathLbl, pathInput);
      grid.appendChild(pathField);
    } else {
      const mdField = document.createElement('label');
      mdField.className = 'slash-skill-form__field slash-skill-form__field--full';
      const mdLbl = document.createElement('span');
      mdLbl.className = 'slash-skill-form__label';
      mdLbl.textContent = 'Содержимое SKILL.md (с YAML frontmatter или обычным Markdown)';
      const mdArea = document.createElement('textarea');
      mdArea.className = 'slash-skill-form__textarea';
      mdArea.rows = 6;
      mdArea.placeholder = '---\nname: my-skill\ndescription: Краткое описание\n---\n\nИнструкции…';
      mdArea.value = installDraft.markdown;
      mdArea.addEventListener('input', () => {
        installDraft.markdown = mdArea.value;
        installDraft.preview = null;
      });
      mdField.append(mdLbl, mdArea);
      grid.appendChild(mdField);
    }

    const slugField = document.createElement('label');
    slugField.className = 'slash-skill-form__field';
    const slugLbl = document.createElement('span');
    slugLbl.className = 'slash-skill-form__label';
    slugLbl.textContent = 'Команда /slug (необязательно)';
    const slugInput = document.createElement('input');
    slugInput.type = 'text';
    slugInput.className = 'slash-skill-form__input';
    slugInput.placeholder = 'Определяется автоматически';
    slugInput.value = installDraft.slug;
    slugInput.addEventListener('input', () => {
      installDraft.slug = slugInput.value;
      installDraft.preview = null;
    });
    slugField.append(slugLbl, slugInput);

    const catField = document.createElement('label');
    catField.className = 'slash-skill-form__field';
    const catLbl = document.createElement('span');
    catLbl.className = 'slash-skill-form__label';
    catLbl.textContent = 'Категория';
    const catSelect = document.createElement('select');
    catSelect.className = 'slash-skill-form__select';
    for (const c of SKILL_CATEGORIES) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.title;
      catSelect.appendChild(opt);
    }
    catSelect.value = installDraft.category || 'system';
    catSelect.addEventListener('change', () => { installDraft.category = catSelect.value; });
    catField.append(catLbl, catSelect);

    grid.append(slugField, catField);
    form.appendChild(grid);

    if (installDraft.preview) {
      const pv = installDraft.preview;
      const previewBox = document.createElement('div');
      previewBox.className = 'slash-skill-form__preview';

      const pvTitle = document.createElement('div');
      pvTitle.className = 'slash-skill-form__preview-title';
      const pvName = document.createElement('span');
      pvName.textContent = pv.name || pv.slug || 'Навык';
      pvTitle.appendChild(pvName);
      if (pv.slug) {
        const pvSlug = document.createElement('span');
        pvSlug.className = 'slash-catalog__item-slash';
        pvSlug.textContent = `/${pv.slug}`;
        pvTitle.appendChild(pvSlug);
      }

      const pvDesc = document.createElement('p');
      pvDesc.className = 'slash-skill-form__preview-desc';
      pvDesc.textContent = pv.description || installDraft.previewMessage || 'Готово к установке.';

      const pvMeta = document.createElement('div');
      pvMeta.className = 'slash-skill-form__preview-meta';
      const parts = [];
      if (Number.isFinite(pv.tokens)) parts.push(`Размер: ~${pv.tokens} ток`);
      if (pv.source) parts.push(`Источник: ${pv.source}`);
      if (installDraft.previewMessage && pv.description) parts.push(installDraft.previewMessage);
      pvMeta.textContent = parts.join(' · ');

      previewBox.append(pvTitle, pvDesc);
      if (pvMeta.textContent) previewBox.appendChild(pvMeta);
      form.appendChild(previewBox);
    }

    const actions = document.createElement('div');
    actions.className = 'slash-skill-form__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'slash-catalog__action-btn';
    cancelBtn.textContent = installDraft.preview ? 'Сбросить' : 'Отмена';
    cancelBtn.disabled = formBusy;
    cancelBtn.addEventListener('click', () => {
      if (installDraft.preview) {
        installDraft.preview = null;
        installDraft.previewMessage = '';
        formError = '';
        renderModal();
        return;
      }
      activeForm = null;
      formError = '';
      renderModal();
    });

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--primary';
    if (installDraft.preview) {
      submitBtn.textContent = formBusy ? 'Устанавливаю…' : 'Подтвердить установку';
    } else {
      submitBtn.textContent = formBusy ? 'Проверяю…' : 'Проверить навык';
    }
    submitBtn.disabled = formBusy;

    actions.append(cancelBtn, submitBtn);
    form.appendChild(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (formBusy) return;
      const isPath = installDraft.sourceType === 'path';
      const sourcePath = isPath ? installDraft.sourcePath.trim() : '';
      const markdown = !isPath ? installDraft.markdown.trim() : '';
      if (isPath && !sourcePath) {
        formError = 'Укажи путь к файлу SKILL.md.';
        renderModal();
        return;
      }
      if (!isPath && !markdown) {
        formError = 'Вставь содержимое Markdown для навыка.';
        renderModal();
        return;
      }
      if (typeof window.host?.skillsInstall !== 'function') {
        formError = 'Установка навыков недоступна в текущем режиме.';
        renderModal();
        return;
      }

      const confirm = Boolean(installDraft.preview);
      formBusy = true;
      formError = '';
      renderModal();
      try {
        const res = await window.host.skillsInstall({
          ...(sourcePath ? { sourcePath } : {}),
          ...(markdown ? { markdown } : {}),
          slug: (confirm && installDraft.preview?.slug) ? installDraft.preview.slug : (installDraft.slug.trim() || undefined),
          category: installDraft.category || 'system',
          confirm,
        });
        if (!confirm && res?.confirmRequired) {
          installDraft.preview = res.preview || { slug: installDraft.slug.trim(), name: installDraft.slug.trim() || 'Навык' };
          installDraft.previewMessage = res.message || '';
        } else if (!res || res.ok === false) {
          formError = res?.error || res?.message || 'Не удалось установить навык.';
        } else {
          if (Array.isArray(res.categories) || Array.isArray(res.items)) {
            emitSkillsChanged(res);
          } else {
            const refreshed = await fetchSkills(ctx, skillsData.items);
            emitSkillsChanged(refreshed);
          }
          const installedName = res.skill?.name || res.skill?.id || installDraft.preview?.name || 'Навык';
          noticeText = `Навык «${installedName}» установлен.`;
          activeForm = null;
          installDraft.sourcePath = '';
          installDraft.markdown = '';
          installDraft.slug = '';
          installDraft.preview = null;
          installDraft.previewMessage = '';
        }
      } catch (err) {
        formError = err?.message || 'Ошибка при установке навыка.';
      } finally {
        formBusy = false;
        if (document.body.contains(backdrop)) renderModal();
      }
    });

    return form;
  }

  function buildCollapsibleGroup(groupKey, titleText, items, renderItem, forceExpanded) {
    const isCollapsed = !forceExpanded && collapsedGroups.has(groupKey);
    const group = document.createElement('section');
    group.className = `slash-catalog__group${isCollapsed ? ' is-collapsed' : ''}`;

    const head = document.createElement('div');
    head.className = 'slash-catalog__group-head';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'slash-catalog__group-toggle';
    toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));

    const titleSpan = document.createElement('span');
    titleSpan.textContent = `${titleText} (${items.length})`;

    const chev = document.createElement('span');
    chev.className = 'slash-catalog__group-chevron';
    chev.appendChild(createIconSvg('chevron-down', 16));

    toggleBtn.append(titleSpan, chev);
    toggleBtn.addEventListener('click', () => {
      if (collapsedGroups.has(groupKey)) collapsedGroups.delete(groupKey);
      else collapsedGroups.add(groupKey);
      const nowCollapsed = collapsedGroups.has(groupKey);
      group.classList.toggle('is-collapsed', nowCollapsed);
      toggleBtn.setAttribute('aria-expanded', String(!nowCollapsed));
    });

    head.appendChild(toggleBtn);

    const list = document.createElement('div');
    list.className = 'slash-catalog__list';
    for (const it of items) list.appendChild(renderItem(it));

    group.append(head, list);
    return group;
  }

  async function handleReloadSkills() {
    if (reloadingSkills) return;
    reloadingSkills = true;
    renderModal();
    try {
      const res = typeof window.host?.skillsReload === 'function'
        ? await window.host.skillsReload()
        : await fetchSkills(ctx, skillsData.items);
      if (res && (Array.isArray(res.categories) || Array.isArray(res.items))) {
        emitSkillsChanged(res);
      } else {
        const refreshed = await fetchSkills(ctx, skillsData.items);
        emitSkillsChanged(refreshed);
      }
      noticeText = `Список навыков обновлён (${skillsData.items.length}).`;
    } catch (err) {
      noticeText = err?.message || 'Не удалось обновить список навыков.';
    } finally {
      reloadingSkills = false;
      if (document.body.contains(backdrop)) renderModal();
    }
  }

  async function handleReloadPlugins() {
    if (reloadingPlugins) return;
    reloadingPlugins = true;
    renderModal();
    try {
      const res = typeof window.host?.pluginsReload === 'function'
        ? await window.host.pluginsReload()
        : await fetchPlugins(ctx, pluginsData.items);
      if (res && (Array.isArray(res.categories) || Array.isArray(res.items))) {
        await emitPluginsChanged(res, { refreshSkills: true });
      } else {
        const refreshed = await fetchPlugins(ctx, pluginsData.items);
        await emitPluginsChanged(refreshed, { refreshSkills: true });
      }
      noticeText = `Список плагинов обновлён (${pluginsData.items.length}).`;
    } catch (err) {
      noticeText = err?.message || 'Не удалось обновить список плагинов.';
    } finally {
      reloadingPlugins = false;
      if (document.body.contains(backdrop)) renderModal();
    }
  }

  async function handlePluginToggle(plugin, nextEnabled) {
    const id = plugin.id || plugin.name;
    if (!id || pendingPluginToggles.has(id)) return;
    pendingPluginToggles.add(id);
    renderModal();

    const host = window.host;
    if (typeof host?.pluginsToggle === 'function') {
      try {
        const res = await host.pluginsToggle({ id, enabled: Boolean(nextEnabled), cascade: true });
        if (res && res.ok !== false) {
          if (Array.isArray(res.categories) || Array.isArray(res.items)) {
            await emitPluginsChanged(res, { refreshSkills: true });
          } else {
            const refreshed = await fetchPlugins(ctx, pluginsData.items);
            await emitPluginsChanged(refreshed, { refreshSkills: true });
          }
          noticeText = '';
        } else {
          noticeText = res?.error || 'Не удалось переключить плагин.';
        }
      } catch (err) {
        noticeText = err?.message || 'Не удалось переключить плагин.';
      }
    } else {
      const nextItems = (pluginsData.items || []).map((p) => (
        p.id === id ? { ...p, enabled: Boolean(nextEnabled) } : p
      ));
      await emitPluginsChanged({ items: nextItems, hookifyRules: pluginsData.hookifyRules }, { refreshSkills: true });
    }

    pendingPluginToggles.delete(id);
    if (document.body.contains(backdrop)) renderModal();
  }

  async function handleHookifyToggle(rule) {
    const id = rule?.id;
    if (!id || pendingHookifyOps.has(id)) return;
    pendingHookifyOps.add(id);
    hookifyError = '';
    renderModal();

    const nextEnabled = rule.enabled === false;
    const host = window.host;
    if (typeof host?.pluginsHookify === 'function') {
      try {
        const res = await host.pluginsHookify({ op: 'toggle', id, enabled: nextEnabled });
        if (res && res.ok !== false) {
          await emitPluginsChanged(res);
        } else {
          hookifyError = res?.error || 'Не удалось обновить правило Hookify.';
        }
      } catch (err) {
        hookifyError = err?.message || 'Не удалось обновить правило Hookify.';
      }
    } else {
      const nextRules = (pluginsData.hookifyRules || []).map((r) => (
        r.id === id ? { ...r, enabled: nextEnabled } : r
      ));
      await emitPluginsChanged({ items: pluginsData.items, hookifyRules: nextRules });
    }

    pendingHookifyOps.delete(id);
    if (document.body.contains(backdrop)) renderModal();
  }

  async function handleHookifyDelete(rule) {
    const id = rule?.id;
    if (!id || pendingHookifyOps.has(id)) return;
    pendingHookifyOps.add(id);
    hookifyError = '';
    renderModal();

    const host = window.host;
    if (typeof host?.pluginsHookify === 'function') {
      try {
        const res = await host.pluginsHookify({ op: 'delete', id });
        if (res && res.ok !== false) {
          await emitPluginsChanged(res);
        } else {
          hookifyError = res?.error || 'Не удалось удалить правило Hookify.';
        }
      } catch (err) {
        hookifyError = err?.message || 'Не удалось удалить правило Hookify.';
      }
    } else {
      const nextRules = (pluginsData.hookifyRules || []).filter((r) => r.id !== id);
      await emitPluginsChanged({ items: pluginsData.items, hookifyRules: nextRules });
    }

    pendingHookifyOps.delete(id);
    if (document.body.contains(backdrop)) renderModal();
  }

  async function submitHookifyAdd({ inline = false } = {}) {
    if (formBusy) return;
    const name = hookifyDraft.name.trim();
    const triggerPattern = hookifyDraft.triggerPattern.trim();
    const action = ['warn', 'inject', 'block'].includes(hookifyDraft.action) ? hookifyDraft.action : 'warn';
    const message = hookifyDraft.message.trim();
    if (!name || !triggerPattern || !message) {
      const msg = 'Заполни название, триггер и текст правила/сообщения.';
      if (inline) hookifyError = msg;
      else formError = msg;
      renderModal();
      return;
    }

    formBusy = true;
    if (inline) hookifyError = '';
    else formError = '';
    renderModal();

    try {
      const host = window.host;
      if (typeof host?.pluginsHookify === 'function') {
        const res = await host.pluginsHookify({
          op: 'add',
          name,
          triggerPattern,
          action,
          message,
          enabled: true,
        });
        if (!res || res.ok === false) {
          const msg = res?.error || 'Не удалось добавить правило Hookify.';
          if (inline) hookifyError = msg;
          else formError = msg;
        } else {
          await emitPluginsChanged(res);
          hookifyDraft.name = '';
          hookifyDraft.triggerPattern = '';
          hookifyDraft.action = 'warn';
          hookifyDraft.message = '';
          if (inline) inlineHookifyFormOpen = false;
          else activeForm = null;
          expandedPlugins.add('hookify');
          noticeText = `Правило Hookify «${name}» добавлено.`;
        }
      } else {
        const nextRules = [
          ...(pluginsData.hookifyRules || []),
          { id: `rule-${Date.now()}`, name, triggerPattern, action, message, enabled: true },
        ];
        await emitPluginsChanged({ items: pluginsData.items, hookifyRules: nextRules });
        hookifyDraft.name = '';
        hookifyDraft.triggerPattern = '';
        hookifyDraft.action = 'warn';
        hookifyDraft.message = '';
        if (inline) inlineHookifyFormOpen = false;
        else activeForm = null;
        expandedPlugins.add('hookify');
        noticeText = `Правило Hookify «${name}» добавлено.`;
      }
    } catch (err) {
      const msg = err?.message || 'Ошибка при добавлении правила Hookify.';
      if (inline) hookifyError = msg;
      else formError = msg;
    } finally {
      formBusy = false;
      if (document.body.contains(backdrop)) renderModal();
    }
  }

  function buildHookifyAddForm({ inline = false } = {}) {
    const form = document.createElement('form');
    form.className = inline ? 'slash-hookify__form' : 'slash-skill-form';
    form.autocomplete = 'off';

    const head = document.createElement('div');
    head.className = 'slash-skill-form__head';
    const title = document.createElement('h3');
    title.className = 'slash-skill-form__title';
    title.textContent = 'Добавить правило Hookify';
    const closeFormBtn = document.createElement('button');
    closeFormBtn.type = 'button';
    closeFormBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--icon';
    closeFormBtn.setAttribute('aria-label', 'Закрыть форму правила');
    closeFormBtn.appendChild(createIconSvg('close', 16));
    closeFormBtn.addEventListener('click', () => {
      if (inline) {
        inlineHookifyFormOpen = false;
        hookifyError = '';
      } else {
        activeForm = null;
        formError = '';
      }
      renderModal();
    });
    head.append(title, closeFormBtn);
    form.appendChild(head);

    const errText = inline ? hookifyError : formError;
    if (errText) {
      const err = document.createElement('p');
      err.className = 'slash-skill-form__error';
      err.textContent = errText;
      form.appendChild(err);
    }

    const grid = document.createElement('div');
    grid.className = 'slash-skill-form__grid';

    const nameField = document.createElement('label');
    nameField.className = 'slash-skill-form__field';
    const nameLbl = document.createElement('span');
    nameLbl.className = 'slash-skill-form__label';
    nameLbl.textContent = 'Название';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'slash-skill-form__input';
    nameInput.placeholder = 'Например, Запрет force-push';
    nameInput.value = hookifyDraft.name;
    nameInput.required = true;
    nameInput.addEventListener('input', () => { hookifyDraft.name = nameInput.value; });
    nameField.append(nameLbl, nameInput);

    const actionField = document.createElement('label');
    actionField.className = 'slash-skill-form__field';
    const actionLbl = document.createElement('span');
    actionLbl.className = 'slash-skill-form__label';
    actionLbl.textContent = 'Действие';
    const actionSelect = document.createElement('select');
    actionSelect.className = 'slash-skill-form__select';
    for (const [val, lbl] of [
      ['warn', 'Предупредить'],
      ['inject', 'Добавить правило'],
      ['block', 'Заблокировать'],
    ]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      actionSelect.appendChild(opt);
    }
    actionSelect.value = hookifyDraft.action || 'warn';
    actionSelect.addEventListener('change', () => { hookifyDraft.action = actionSelect.value; });
    actionField.append(actionLbl, actionSelect);

    const patField = document.createElement('label');
    patField.className = 'slash-skill-form__field slash-skill-form__field--full';
    const patLbl = document.createElement('span');
    patLbl.className = 'slash-skill-form__label';
    patLbl.textContent = 'Триггер (текст/шаблон)';
    const patInput = document.createElement('input');
    patInput.type = 'text';
    patInput.className = 'slash-skill-form__input';
    patInput.placeholder = 'Например, git push --force или /prod|delete\\s+all/i';
    patInput.value = hookifyDraft.triggerPattern;
    patInput.required = true;
    patInput.addEventListener('input', () => { hookifyDraft.triggerPattern = patInput.value; });
    patField.append(patLbl, patInput);

    const msgField = document.createElement('label');
    msgField.className = 'slash-skill-form__field slash-skill-form__field--full';
    const msgLbl = document.createElement('span');
    msgLbl.className = 'slash-skill-form__label';
    msgLbl.textContent = 'Текст правила/сообщения';
    const msgArea = document.createElement('textarea');
    msgArea.className = 'slash-skill-form__textarea';
    msgArea.rows = 3;
    msgArea.placeholder = 'Что показать пользователю или добавить в системную инструкцию…';
    msgArea.value = hookifyDraft.message;
    msgArea.required = true;
    msgArea.addEventListener('input', () => { hookifyDraft.message = msgArea.value; });
    msgField.append(msgLbl, msgArea);

    grid.append(nameField, actionField, patField, msgField);
    form.appendChild(grid);

    const actions = document.createElement('div');
    actions.className = 'slash-skill-form__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'slash-catalog__action-btn';
    cancelBtn.textContent = 'Отмена';
    cancelBtn.disabled = formBusy;
    cancelBtn.addEventListener('click', () => {
      if (inline) {
        inlineHookifyFormOpen = false;
        hookifyError = '';
      } else {
        activeForm = null;
        formError = '';
      }
      renderModal();
    });

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--primary';
    submitBtn.textContent = formBusy ? 'Сохраняю…' : 'Сохранить правило';
    submitBtn.disabled = formBusy;

    actions.append(cancelBtn, submitBtn);
    form.appendChild(actions);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitHookifyAdd({ inline });
    });

    return form;
  }

  function buildHookifyManager() {
    const rules = Array.isArray(pluginsData.hookifyRules) ? pluginsData.hookifyRules : [];
    const wrap = document.createElement('div');
    wrap.className = 'slash-hookify';

    const head = document.createElement('div');
    head.className = 'slash-hookify__head';

    const title = document.createElement('h4');
    title.className = 'slash-hookify__title';
    title.textContent = `Правила Hookify (${rules.length})`;

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = `slash-catalog__action-btn${inlineHookifyFormOpen ? ' is-active' : ''}`;
    addBtn.append(createIconSvg('plus', 14), document.createTextNode('Добавить правило'));
    addBtn.addEventListener('click', () => {
      inlineHookifyFormOpen = !inlineHookifyFormOpen;
      hookifyError = '';
      renderModal();
    });

    head.append(title, addBtn);
    wrap.appendChild(head);

    if (hookifyError && !inlineHookifyFormOpen) {
      const err = document.createElement('p');
      err.className = 'slash-skill-form__error';
      err.textContent = hookifyError;
      wrap.appendChild(err);
    }

    if (inlineHookifyFormOpen) {
      wrap.appendChild(buildHookifyAddForm({ inline: true }));
    }

    if (!rules.length) {
      const empty = document.createElement('div');
      empty.className = 'slash-hookify__empty';
      empty.textContent = 'Правил пока нет. Добавь первое правило для предупреждений, подсказок или блокировки.';
      wrap.appendChild(empty);
      return wrap;
    }

    const ACTION_LABELS = {
      warn: 'Предупредить',
      inject: 'Добавить правило',
      block: 'Заблокировать',
    };

    const list = document.createElement('div');
    list.className = 'slash-hookify__list';

    for (const r of rules) {
      const isEnabled = r.enabled !== false;
      const busy = pendingHookifyOps.has(r.id);
      const actKey = ['warn', 'inject', 'block'].includes(r.action) ? r.action : 'warn';

      const row = document.createElement('div');
      row.className = `slash-hookify__row${isEnabled ? '' : ' is-disabled'}`;

      const main = document.createElement('div');
      main.className = 'slash-hookify__main';

      const topLine = document.createElement('div');
      topLine.className = 'slash-hookify__top';

      const nameEl = document.createElement('span');
      nameEl.className = 'slash-hookify__name';
      nameEl.textContent = r.name || 'Правило';

      const patEl = document.createElement('span');
      patEl.className = 'slash-hookify__pattern';
      patEl.textContent = r.triggerPattern || '';

      const actEl = document.createElement('span');
      actEl.className = `slash-hookify__action slash-hookify__action--${actKey}`;
      actEl.textContent = ACTION_LABELS[actKey];

      topLine.append(nameEl, patEl, actEl);
      main.appendChild(topLine);

      if (r.message) {
        const msgEl = document.createElement('p');
        msgEl.className = 'slash-hookify__msg';
        msgEl.textContent = r.message;
        main.appendChild(msgEl);
      }

      const controls = document.createElement('div');
      controls.className = 'slash-hookify__controls';

      const sw = createToggleSwitch(isEnabled, {
        label: `${isEnabled ? 'Выключить' : 'Включить'} правило ${r.name || ''}`,
        disabled: busy,
        onToggle: () => handleHookifyToggle(r),
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'slash-hookify__delete';
      delBtn.setAttribute('aria-label', `Удалить правило ${r.name || ''}`);
      delBtn.title = 'Удалить правило';
      delBtn.disabled = busy;
      delBtn.appendChild(createIconSvg('trash', 15));
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleHookifyDelete(r);
      });

      controls.append(sw, delBtn);
      row.append(main, controls);
      list.appendChild(row);
    }

    wrap.appendChild(list);
    return wrap;
  }

  function buildCreatePluginForm() {
    const form = document.createElement('form');
    form.className = 'slash-skill-form';
    form.autocomplete = 'off';

    const head = document.createElement('div');
    head.className = 'slash-skill-form__head';
    const title = document.createElement('h3');
    title.className = 'slash-skill-form__title';
    title.textContent = 'Создать плагин';
    const closeFormBtn = document.createElement('button');
    closeFormBtn.type = 'button';
    closeFormBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--icon';
    closeFormBtn.setAttribute('aria-label', 'Закрыть форму');
    closeFormBtn.appendChild(createIconSvg('close', 16));
    closeFormBtn.addEventListener('click', () => {
      activeForm = null;
      formError = '';
      renderModal();
    });
    head.append(title, closeFormBtn);
    form.appendChild(head);

    if (formError) {
      const err = document.createElement('p');
      err.className = 'slash-skill-form__error';
      err.textContent = formError;
      form.appendChild(err);
    }

    const grid = document.createElement('div');
    grid.className = 'slash-skill-form__grid';

    const nameField = document.createElement('label');
    nameField.className = 'slash-skill-form__field';
    const nameLbl = document.createElement('span');
    nameLbl.className = 'slash-skill-form__label';
    nameLbl.textContent = 'Название';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'slash-skill-form__input';
    nameInput.placeholder = 'Например, Набор для релизов';
    nameInput.value = pluginCreateDraft.name;
    nameInput.required = true;
    nameInput.addEventListener('input', () => { pluginCreateDraft.name = nameInput.value; });
    nameField.append(nameLbl, nameInput);

    const catField = document.createElement('label');
    catField.className = 'slash-skill-form__field';
    const catLbl = document.createElement('span');
    catLbl.className = 'slash-skill-form__label';
    catLbl.textContent = 'Категория';
    const catSelect = document.createElement('select');
    catSelect.className = 'slash-skill-form__select';
    for (const c of PLUGIN_CATEGORIES) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.title;
      catSelect.appendChild(opt);
    }
    catSelect.value = pluginCreateDraft.category || 'dev';
    catSelect.addEventListener('change', () => { pluginCreateDraft.category = catSelect.value; });
    catField.append(catLbl, catSelect);

    const descField = document.createElement('label');
    descField.className = 'slash-skill-form__field slash-skill-form__field--full';
    const descLbl = document.createElement('span');
    descLbl.className = 'slash-skill-form__label';
    descLbl.textContent = 'Краткое описание';
    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.className = 'slash-skill-form__input';
    descInput.placeholder = 'В одну строку: какие задачи закрывает плагин';
    descInput.value = pluginCreateDraft.description;
    descInput.required = true;
    descInput.addEventListener('input', () => { pluginCreateDraft.description = descInput.value; });
    descField.append(descLbl, descInput);

    const skillsField = document.createElement('label');
    skillsField.className = 'slash-skill-form__field slash-skill-form__field--full';
    const skillsLbl = document.createElement('span');
    skillsLbl.className = 'slash-skill-form__label';
    skillsLbl.textContent = 'Входящие скиллы (через запятую, необязательно)';
    const skillsInput = document.createElement('input');
    skillsInput.type = 'text';
    skillsInput.className = 'slash-skill-form__input';
    skillsInput.placeholder = 'second-brain, russian-editor, research-method';
    skillsInput.value = pluginCreateDraft.skills;
    skillsInput.addEventListener('input', () => { pluginCreateDraft.skills = skillsInput.value; });
    skillsField.append(skillsLbl, skillsInput);

    const rulesField = document.createElement('label');
    rulesField.className = 'slash-skill-form__field slash-skill-form__field--full';
    const rulesLbl = document.createElement('span');
    rulesLbl.className = 'slash-skill-form__label';
    rulesLbl.textContent = 'Правила плагина (по одному на строку, необязательно)';
    const rulesArea = document.createElement('textarea');
    rulesArea.className = 'slash-skill-form__textarea';
    rulesArea.rows = 4;
    rulesArea.placeholder = 'Короткие системные правила, которые подключаются, пока плагин включён…';
    rulesArea.value = pluginCreateDraft.rules;
    rulesArea.addEventListener('input', () => { pluginCreateDraft.rules = rulesArea.value; });
    rulesField.append(rulesLbl, rulesArea);

    grid.append(nameField, catField, descField, skillsField, rulesField);
    form.appendChild(grid);

    const cloudRow = document.createElement('div');
    cloudRow.className = 'slash-skill-form__check-row';
    const cloudCopy = document.createElement('span');
    cloudCopy.className = 'slash-skill-form__check-copy';
    const cloudStrong = document.createElement('strong');
    cloudStrong.textContent = 'Только с облаком';
    const cloudSmall = document.createElement('small');
    cloudSmall.textContent = 'Автоматически ставить на паузу в приватном, временном, 18+ и Tor режимах';
    cloudCopy.append(cloudStrong, cloudSmall);
    const cloudSwitch = createToggleSwitch(pluginCreateDraft.cloudOnly, {
      label: 'Только с облаком',
      disabled: formBusy,
      onToggle: () => {
        pluginCreateDraft.cloudOnly = !pluginCreateDraft.cloudOnly;
        cloudSwitch.classList.toggle('is-on', pluginCreateDraft.cloudOnly);
        cloudSwitch.setAttribute('aria-checked', String(pluginCreateDraft.cloudOnly));
      },
    });
    cloudRow.append(cloudCopy, cloudSwitch);
    form.appendChild(cloudRow);

    const actions = document.createElement('div');
    actions.className = 'slash-skill-form__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'slash-catalog__action-btn';
    cancelBtn.textContent = 'Отмена';
    cancelBtn.disabled = formBusy;
    cancelBtn.addEventListener('click', () => {
      activeForm = null;
      formError = '';
      renderModal();
    });

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--primary';
    submitBtn.textContent = formBusy ? 'Создаю…' : 'Сохранить плагин';
    submitBtn.disabled = formBusy;

    actions.append(cancelBtn, submitBtn);
    form.appendChild(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (formBusy) return;
      const name = pluginCreateDraft.name.trim();
      const description = pluginCreateDraft.description.trim();
      if (!name || !description) {
        formError = 'Заполни название и краткое описание плагина.';
        renderModal();
        return;
      }
      if (typeof window.host?.pluginsCreate !== 'function') {
        formError = 'Создание плагинов недоступно в текущем режиме.';
        renderModal();
        return;
      }

      const skills = pluginCreateDraft.skills
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const rules = pluginCreateDraft.rules
        .split(/\r?\n/)
        .map((r) => r.trim())
        .filter(Boolean);

      formBusy = true;
      formError = '';
      renderModal();
      try {
        const res = await window.host.pluginsCreate({
          name,
          slug: pluginCreateDraft.slug.trim() || undefined,
          category: pluginCreateDraft.category || 'dev',
          description,
          skills,
          rules,
          cloudOnly: Boolean(pluginCreateDraft.cloudOnly),
          vaultOnly: Boolean(pluginCreateDraft.vaultOnly),
        });
        if (!res || res.ok === false) {
          formError = res?.error || 'Не удалось создать плагин.';
        } else {
          if (Array.isArray(res.categories) || Array.isArray(res.items)) {
            await emitPluginsChanged(res, { refreshSkills: true });
          } else {
            const refreshed = await fetchPlugins(ctx, pluginsData.items);
            await emitPluginsChanged(refreshed, { refreshSkills: true });
          }
          noticeText = `Плагин «${res.plugin?.name || name}» создан.`;
          if (res.plugin?.id) expandedPlugins.add(res.plugin.id);
          activeForm = null;
          pluginCreateDraft.name = '';
          pluginCreateDraft.slug = '';
          pluginCreateDraft.description = '';
          pluginCreateDraft.skills = '';
          pluginCreateDraft.rules = '';
          pluginCreateDraft.cloudOnly = false;
          pluginCreateDraft.vaultOnly = false;
        }
      } catch (err) {
        formError = err?.message || 'Ошибка при создании плагина.';
      } finally {
        formBusy = false;
        if (document.body.contains(backdrop)) renderModal();
      }
    });

    return form;
  }

  function buildInstallPluginForm() {
    const form = document.createElement('form');
    form.className = 'slash-skill-form';
    form.autocomplete = 'off';

    const head = document.createElement('div');
    head.className = 'slash-skill-form__head';
    const title = document.createElement('h3');
    title.className = 'slash-skill-form__title';
    title.textContent = 'Установить плагин';
    const closeFormBtn = document.createElement('button');
    closeFormBtn.type = 'button';
    closeFormBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--icon';
    closeFormBtn.setAttribute('aria-label', 'Закрыть форму');
    closeFormBtn.appendChild(createIconSvg('close', 16));
    closeFormBtn.addEventListener('click', () => {
      activeForm = null;
      formError = '';
      pluginInstallDraft.preview = null;
      renderModal();
    });
    head.append(title, closeFormBtn);
    form.appendChild(head);

    if (formError) {
      const err = document.createElement('p');
      err.className = 'slash-skill-form__error';
      err.textContent = formError;
      form.appendChild(err);
    }

    const modeTabs = document.createElement('div');
    modeTabs.className = 'slash-skill-form__tabs';
    for (const [key, label] of [['path', 'Локальный plugin.json'], ['json', 'Вставить JSON']]) {
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = `slash-skill-form__tab${pluginInstallDraft.sourceType === key ? ' is-active' : ''}`;
      tabBtn.textContent = label;
      tabBtn.disabled = formBusy;
      tabBtn.addEventListener('click', () => {
        pluginInstallDraft.sourceType = key;
        pluginInstallDraft.preview = null;
        formError = '';
        renderModal();
      });
      modeTabs.appendChild(tabBtn);
    }
    form.appendChild(modeTabs);

    const grid = document.createElement('div');
    grid.className = 'slash-skill-form__grid';

    if (pluginInstallDraft.sourceType === 'path') {
      const pathField = document.createElement('label');
      pathField.className = 'slash-skill-form__field slash-skill-form__field--full';
      const pathLbl = document.createElement('span');
      pathLbl.className = 'slash-skill-form__label';
      pathLbl.textContent = 'Путь к файлу plugin.json на ПК';
      const pathInput = document.createElement('input');
      pathInput.type = 'text';
      pathInput.className = 'slash-skill-form__input';
      pathInput.placeholder = 'D:\\path\\to\\plugin\\plugin.json';
      pathInput.value = pluginInstallDraft.sourcePath;
      pathInput.addEventListener('input', () => {
        pluginInstallDraft.sourcePath = pathInput.value;
        pluginInstallDraft.preview = null;
      });
      pathField.append(pathLbl, pathInput);
      grid.appendChild(pathField);
    } else {
      const jsonField = document.createElement('label');
      jsonField.className = 'slash-skill-form__field slash-skill-form__field--full';
      const jsonLbl = document.createElement('span');
      jsonLbl.className = 'slash-skill-form__label';
      jsonLbl.textContent = 'Манифест плагина (JSON)';
      const jsonArea = document.createElement('textarea');
      jsonArea.className = 'slash-skill-form__textarea';
      jsonArea.rows = 6;
      jsonArea.placeholder = '{\n  "id": "my-pack",\n  "name": "Мой набор",\n  "category": "dev",\n  "description": "Описание",\n  "skills": [],\n  "rules": []\n}';
      jsonArea.value = pluginInstallDraft.manifestJson;
      jsonArea.addEventListener('input', () => {
        pluginInstallDraft.manifestJson = jsonArea.value;
        pluginInstallDraft.preview = null;
      });
      jsonField.append(jsonLbl, jsonArea);
      grid.appendChild(jsonField);
    }

    const slugField = document.createElement('label');
    slugField.className = 'slash-skill-form__field slash-skill-form__field--full';
    const slugLbl = document.createElement('span');
    slugLbl.className = 'slash-skill-form__label';
    slugLbl.textContent = 'Идентификатор slug (необязательно)';
    const slugInput = document.createElement('input');
    slugInput.type = 'text';
    slugInput.className = 'slash-skill-form__input';
    slugInput.placeholder = 'Определяется из манифеста';
    slugInput.value = pluginInstallDraft.slug;
    slugInput.addEventListener('input', () => {
      pluginInstallDraft.slug = slugInput.value;
      pluginInstallDraft.preview = null;
    });
    slugField.append(slugLbl, slugInput);
    grid.appendChild(slugField);

    form.appendChild(grid);

    if (pluginInstallDraft.preview) {
      const pv = pluginInstallDraft.preview;
      const previewBox = document.createElement('div');
      previewBox.className = 'slash-skill-form__preview';

      const pvTitle = document.createElement('div');
      pvTitle.className = 'slash-skill-form__preview-title';
      const pvName = document.createElement('span');
      pvName.textContent = pv.name || pv.id || 'Плагин';
      pvTitle.appendChild(pvName);
      if (pv.id) {
        const pvId = document.createElement('span');
        pvId.className = 'slash-catalog__item-slash';
        pvId.textContent = pv.id;
        pvTitle.appendChild(pvId);
      }

      const pvDesc = document.createElement('p');
      pvDesc.className = 'slash-skill-form__preview-desc';
      pvDesc.textContent = pv.description || pluginInstallDraft.previewMessage || 'Готово к установке.';

      const pvMeta = document.createElement('div');
      pvMeta.className = 'slash-skill-form__preview-meta';
      const parts = [];
      if (pv.category) parts.push(`Категория: ${PLUGIN_CATEGORY_TITLES[pv.category] || pv.category}`);
      if (Number.isFinite(pv.skillsCount)) parts.push(`Скиллов: ${pv.skillsCount}`);
      if (Number.isFinite(pv.rulesCount)) parts.push(`Правил: ${pv.rulesCount}`);
      if (pv.source) parts.push(`Источник: ${pv.source}`);
      if (pluginInstallDraft.previewMessage && pv.description) parts.push(pluginInstallDraft.previewMessage);
      pvMeta.textContent = parts.join(' · ');

      previewBox.append(pvTitle, pvDesc);
      if (pvMeta.textContent) previewBox.appendChild(pvMeta);
      form.appendChild(previewBox);
    }

    const actions = document.createElement('div');
    actions.className = 'slash-skill-form__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'slash-catalog__action-btn';
    cancelBtn.textContent = pluginInstallDraft.preview ? 'Сбросить' : 'Отмена';
    cancelBtn.disabled = formBusy;
    cancelBtn.addEventListener('click', () => {
      if (pluginInstallDraft.preview) {
        pluginInstallDraft.preview = null;
        pluginInstallDraft.previewMessage = '';
        formError = '';
        renderModal();
        return;
      }
      activeForm = null;
      formError = '';
      renderModal();
    });

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--primary';
    if (pluginInstallDraft.preview) {
      submitBtn.textContent = formBusy ? 'Устанавливаю…' : 'Подтвердить установку';
    } else {
      submitBtn.textContent = formBusy ? 'Проверяю…' : 'Проверить плагин';
    }
    submitBtn.disabled = formBusy;

    actions.append(cancelBtn, submitBtn);
    form.appendChild(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (formBusy) return;
      const isPath = pluginInstallDraft.sourceType === 'path';
      const sourcePath = isPath ? pluginInstallDraft.sourcePath.trim() : '';
      const manifestJson = !isPath ? pluginInstallDraft.manifestJson.trim() : '';
      if (isPath && !sourcePath) {
        formError = 'Укажи путь к файлу plugin.json.';
        renderModal();
        return;
      }
      if (!isPath && !manifestJson) {
        formError = 'Вставь JSON манифеста плагина.';
        renderModal();
        return;
      }
      if (typeof window.host?.pluginsInstall !== 'function') {
        formError = 'Установка плагинов недоступна в текущем режиме.';
        renderModal();
        return;
      }

      const confirm = Boolean(pluginInstallDraft.preview);
      formBusy = true;
      formError = '';
      renderModal();
      try {
        const res = await window.host.pluginsInstall({
          ...(sourcePath ? { sourcePath } : {}),
          ...(manifestJson ? { manifestJson } : {}),
          slug: (confirm && pluginInstallDraft.preview?.id)
            ? pluginInstallDraft.preview.id
            : (pluginInstallDraft.slug.trim() || undefined),
          confirm,
        });
        if (!confirm && res?.confirmRequired) {
          pluginInstallDraft.preview = res.preview || {
            id: pluginInstallDraft.slug.trim(),
            name: pluginInstallDraft.slug.trim() || 'Плагин',
          };
          pluginInstallDraft.previewMessage = res.message || '';
        } else if (!res || res.ok === false) {
          formError = res?.error || res?.message || 'Не удалось установить плагин.';
        } else {
          if (Array.isArray(res.categories) || Array.isArray(res.items)) {
            await emitPluginsChanged(res, { refreshSkills: true });
          } else {
            const refreshed = await fetchPlugins(ctx, pluginsData.items);
            await emitPluginsChanged(refreshed, { refreshSkills: true });
          }
          const installedName = res.plugin?.name || res.plugin?.id || pluginInstallDraft.preview?.name || 'Плагин';
          noticeText = `Плагин «${installedName}» установлен.`;
          if (res.plugin?.id) expandedPlugins.add(res.plugin.id);
          activeForm = null;
          pluginInstallDraft.sourcePath = '';
          pluginInstallDraft.manifestJson = '';
          pluginInstallDraft.slug = '';
          pluginInstallDraft.preview = null;
          pluginInstallDraft.previewMessage = '';
        }
      } catch (err) {
        formError = err?.message || 'Ошибка при установке плагина.';
      } finally {
        formBusy = false;
        if (document.body.contains(backdrop)) renderModal();
      }
    });

    return form;
  }

  function buildPluginsStatsBar() {
    const st = pluginsData.stats || {};
    const active = Number.isFinite(st.activeInMode)
      ? st.activeInMode
      : (pluginsData.items || []).filter((p) => p.enabled !== false && !p.pausedInMode).length;
    const total = Number.isFinite(st.total) ? st.total : (pluginsData.items || []).length;
    const hookifyCount = Number.isFinite(st.hookifyRulesCount)
      ? st.hookifyRulesCount
      : (pluginsData.hookifyRules || []).length;
    const customCount = Number.isFinite(st.customCount)
      ? st.customCount
      : (pluginsData.items || []).filter((p) => p.isCustom).length;

    const strip = document.createElement('div');
    strip.className = 'slash-budget';

    const main = document.createElement('span');
    main.className = 'slash-budget__main';

    const dot = document.createElement('span');
    dot.className = 'slash-budget__dot';
    dot.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.textContent = `Активно: ${active} / ${total} · Правил Hookify: ${hookifyCount}`;

    main.append(dot, text);

    const meta = document.createElement('span');
    meta.className = 'slash-budget__meta';
    meta.textContent = customCount > 0 ? `Своих: ${customCount}` : 'Локальный движок';

    strip.append(main, meta);
    return strip;
  }

  function buildPluginCard(p) {
    const id = p.id || p.name;
    const enabled = p.enabled !== false;
    const paused = Boolean(p.pausedInMode);
    const busy = pendingPluginToggles.has(id);
    const expanded = expandedPlugins.has(id);
    const isHookify = id === 'hookify';
    const isFocused = pendingFocusPluginId === id;

    const card = document.createElement('div');
    card.className = `slash-plugin-card${enabled ? '' : ' is-disabled'}${expanded ? ' is-expanded' : ''}${isFocused ? ' is-focused' : ''}`;
    card.dataset.pluginId = id;

    const row = document.createElement('div');
    row.className = 'slash-plugin-row';

    const toggleExpand = () => {
      if (expandedPlugins.has(id)) expandedPlugins.delete(id);
      else expandedPlugins.add(id);
      renderModal();
    };

    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'slash-plugin-hit';
    hit.setAttribute('aria-expanded', String(expanded));
    hit.title = expanded ? 'Свернуть состав плагина' : 'Показать входящие скиллы и правила';
    hit.addEventListener('click', toggleExpand);

    const avatar = document.createElement('span');
    avatar.className = 'slash-catalog__avatar';
    avatar.appendChild(createIconSvg(pluginIconName(p), 18));

    const main = document.createElement('span');
    main.className = 'slash-catalog__item-main';

    const topLine = document.createElement('span');
    topLine.className = 'slash-catalog__item-top';

    const nameEl = document.createElement('span');
    nameEl.className = 'slash-catalog__item-name';
    nameEl.textContent = p.name || id;
    topLine.appendChild(nameEl);

    const statusText = p.statusNote
      || (p.hooks?.length ? `${p.hooks.length} хука` : (p.skills?.length ? `${p.skills.length} скиллов` : ''));
    if (statusText) {
      const statusChip = document.createElement('span');
      statusChip.className = 'slash-skill-chip';
      statusChip.textContent = String(statusText);
      topLine.appendChild(statusChip);
    }

    if (p.isCustom) {
      const customChip = document.createElement('span');
      customChip.className = 'slash-skill-chip';
      customChip.textContent = 'Свой';
      topLine.appendChild(customChip);
    }

    if (p.health && p.health !== 'ok') {
      const healthEl = document.createElement('span');
      healthEl.className = 'slash-plugin-health slash-plugin-health--degraded';
      const hDot = document.createElement('span');
      hDot.className = 'slash-plugin-health__dot';
      const hText = document.createElement('span');
      hText.textContent = p.health === 'degraded' ? 'Неполный' : String(p.health);
      healthEl.append(hDot, hText);
      topLine.appendChild(healthEl);
    } else if (p.hooks?.length || ['chrome-devtools', 'android-dev', 'developer-docs'].includes(id)) {
      const healthEl = document.createElement('span');
      healthEl.className = 'slash-plugin-health';
      const hDot = document.createElement('span');
      hDot.className = 'slash-plugin-health__dot';
      const hText = document.createElement('span');
      hText.textContent = 'OK';
      healthEl.append(hDot, hText);
      topLine.appendChild(healthEl);
    }

    const descEl = document.createElement('span');
    descEl.className = 'slash-catalog__item-desc';
    descEl.textContent = p.description || '';

    main.append(topLine, descEl);

    if (paused) {
      const metaRow = document.createElement('span');
      metaRow.className = 'slash-catalog__meta-row';
      const pauseChip = document.createElement('span');
      pauseChip.className = 'slash-skill-chip slash-skill-chip--paused';
      pauseChip.textContent = 'Пауза в этом режиме';
      if (p.pauseReason) pauseChip.title = p.pauseReason;
      metaRow.appendChild(pauseChip);
      main.appendChild(metaRow);
    }

    hit.append(avatar, main);

    const right = document.createElement('span');
    right.className = 'slash-catalog__item-right';

    const chevBtn = document.createElement('button');
    chevBtn.type = 'button';
    chevBtn.className = 'slash-plugin-chevron';
    chevBtn.setAttribute('aria-label', expanded ? 'Свернуть детали' : 'Развернуть детали');
    chevBtn.setAttribute('aria-expanded', String(expanded));
    chevBtn.appendChild(createIconSvg('chevron-down', 16));
    chevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleExpand();
    });

    const sw = createToggleSwitch(enabled, {
      label: `${enabled ? 'Выключить' : 'Включить'} плагин ${p.name || id}`,
      disabled: busy,
      onToggle: () => handlePluginToggle(p, !enabled),
    });

    right.append(chevBtn, sw);
    row.append(hit, right);
    card.appendChild(row);

    if (expanded) {
      const drawer = document.createElement('div');
      drawer.className = 'slash-plugin-drawer';

      const div = document.createElement('div');
      div.className = 'slash-plugin-drawer__divider';
      drawer.appendChild(div);

      const hasDetails = Boolean(
        p.skills?.length || p.commands?.length || p.hooks?.length || p.rules?.length || isHookify,
      );

      if (p.skills?.length) {
        const block = document.createElement('div');
        block.className = 'slash-plugin-detail-block';
        const lbl = document.createElement('span');
        lbl.className = 'slash-plugin-detail-label';
        lbl.textContent = `Входящие скиллы (${p.skills.length})`;
        const chips = document.createElement('div');
        chips.className = 'slash-plugin-detail-chips';
        for (const s of p.skills) {
          const ch = document.createElement('span');
          ch.className = 'slash-plugin-detail-chip';
          ch.textContent = String(s);
          chips.appendChild(ch);
        }
        block.append(lbl, chips);
        drawer.appendChild(block);
      }

      if (p.commands?.length) {
        const block = document.createElement('div');
        block.className = 'slash-plugin-detail-block';
        const lbl = document.createElement('span');
        lbl.className = 'slash-plugin-detail-label';
        lbl.textContent = `Команды (${p.commands.length})`;
        const chips = document.createElement('div');
        chips.className = 'slash-plugin-detail-chips';
        for (const c of p.commands) {
          const ch = document.createElement('span');
          ch.className = 'slash-plugin-detail-chip';
          ch.textContent = String(c);
          chips.appendChild(ch);
        }
        block.append(lbl, chips);
        drawer.appendChild(block);
      }

      if (p.hooks?.length) {
        const block = document.createElement('div');
        block.className = 'slash-plugin-detail-block';
        const lbl = document.createElement('span');
        lbl.className = 'slash-plugin-detail-label';
        lbl.textContent = `Хуки (${p.hooks.length})`;
        const chips = document.createElement('div');
        chips.className = 'slash-plugin-detail-chips';
        for (const h of p.hooks) {
          const ch = document.createElement('span');
          ch.className = 'slash-plugin-detail-chip';
          ch.textContent = String(h);
          chips.appendChild(ch);
        }
        block.append(lbl, chips);
        drawer.appendChild(block);
      }

      if (p.rules?.length) {
        const block = document.createElement('div');
        block.className = 'slash-plugin-detail-block';
        const lbl = document.createElement('span');
        lbl.className = 'slash-plugin-detail-label';
        lbl.textContent = `Входящие правила (${p.rules.length})`;
        const ul = document.createElement('ul');
        ul.className = 'slash-plugin-rules-list';
        for (const r of p.rules) {
          const li = document.createElement('li');
          li.textContent = String(r);
          ul.appendChild(li);
        }
        block.append(lbl, ul);
        drawer.appendChild(block);
      }

      if (isHookify) {
        drawer.appendChild(buildHookifyManager());
      }

      if (!hasDetails) {
        const emptyDet = document.createElement('div');
        emptyDet.className = 'slash-plugin-source';
        emptyDet.textContent = 'Отдельных скиллов и правил не объявлено.';
        drawer.appendChild(emptyDet);
      }

      const metaParts = [];
      if (p.version) metaParts.push(`v${p.version}`);
      if (p.source && p.source !== 'builtin') metaParts.push(`Источник: ${p.source}`);
      if (p.cloudOnly) metaParts.push('Только с облаком');
      if (p.vaultOnly) metaParts.push('Только с Obsidian Vault');
      if (metaParts.length) {
        const srcEl = document.createElement('div');
        srcEl.className = 'slash-plugin-source';
        srcEl.textContent = metaParts.join(' · ');
        drawer.appendChild(srcEl);
      }

      card.appendChild(drawer);
    }

    return card;
  }

  async function handleReloadConnectors() {
    if (reloadingConnectors) return;
    reloadingConnectors = true;
    renderModal();
    try {
      const refreshed = await fetchConnectors(ctx, { fallbackItems: connectorsData.items, refresh: true });
      emitConnectorsChanged(refreshed);
      noticeText = `Список коннекторов обновлён (${connectorsData.items.length}).`;
    } catch (err) {
      noticeText = err?.message || 'Не удалось обновить список коннекторов.';
    } finally {
      reloadingConnectors = false;
      if (document.body.contains(backdrop)) renderModal();
    }
  }

  async function handleConnectorToggle(connector, nextEnabled) {
    const id = connector.id || connector.name;
    if (!id || pendingConnectorToggles.has(id)) return;
    pendingConnectorToggles.add(id);
    renderModal();

    const host = window.host;
    if (typeof host?.connectorsToggle === 'function') {
      try {
        const res = await host.connectorsToggle({ id, enabled: Boolean(nextEnabled) });
        if (res && res.ok !== false) {
          if (Array.isArray(res.categories) || Array.isArray(res.items)) {
            emitConnectorsChanged(res);
          } else {
            const refreshed = await fetchConnectors(ctx, { fallbackItems: connectorsData.items });
            emitConnectorsChanged(refreshed);
          }
          noticeText = '';
        } else {
          noticeText = res?.error || 'Не удалось переключить коннектор.';
        }
      } catch (err) {
        noticeText = err?.message || 'Не удалось переключить коннектор.';
      }
    } else {
      const nextItems = (connectorsData.items || []).map((c) => (
        c.id === id ? { ...c, enabled: Boolean(nextEnabled) } : c
      ));
      emitConnectorsChanged({ items: nextItems });
    }

    pendingConnectorToggles.delete(id);
    if (document.body.contains(backdrop)) renderModal();
  }

  async function handleConnectorCheck(connectorId = null) {
    if (connectorId) {
      if (pendingConnectorChecks.has(connectorId)) return;
      pendingConnectorChecks.add(connectorId);
    } else {
      if (checkingAllConnectors) return;
      checkingAllConnectors = true;
    }
    renderModal();

    const host = window.host;
    if (typeof host?.connectorsCheck === 'function') {
      try {
        const res = await host.connectorsCheck(connectorId ? { id: connectorId } : {});
        if (res && res.ok !== false) {
          if (Array.isArray(res.categories) || Array.isArray(res.items)) {
            emitConnectorsChanged(res);
          } else {
            const refreshed = await fetchConnectors(ctx, { fallbackItems: connectorsData.items, refresh: true });
            emitConnectorsChanged(refreshed);
          }
          if (connectorId && res.connector) {
            const lat = Number.isFinite(Number(res.connector.latencyMs)) ? ` (${Math.round(Number(res.connector.latencyMs))} мс)` : '';
            noticeText = `${res.connector.name || connectorId}: ${res.connector.statusLabel || res.connector.status}${lat}.`;
          } else {
            noticeText = `Проверка завершена. Подключено: ${connectorsData.stats?.connected ?? 0} из ${connectorsData.stats?.total ?? connectorsData.items.length}.`;
          }
        } else {
          noticeText = res?.error || 'Не удалось проверить коннектор.';
        }
      } catch (err) {
        noticeText = err?.message || 'Ошибка при проверке коннектора.';
      }
    } else {
      noticeText = 'Проверка связи недоступна в офлайн-режиме.';
    }

    if (connectorId) pendingConnectorChecks.delete(connectorId);
    else checkingAllConnectors = false;
    if (document.body.contains(backdrop)) renderModal();
  }

  async function handleConnectorRemove(connector) {
    const id = connector?.id;
    if (!id || pendingConnectorRemoves.has(id)) return;
    pendingConnectorRemoves.add(id);
    renderModal();

    const host = window.host;
    if (typeof host?.connectorsRemove === 'function') {
      try {
        const res = await host.connectorsRemove({ id, confirm: true });
        if (res && res.ok !== false) {
          if (Array.isArray(res.categories) || Array.isArray(res.items)) {
            emitConnectorsChanged(res);
          } else {
            const refreshed = await fetchConnectors(ctx, { fallbackItems: connectorsData.items });
            emitConnectorsChanged(refreshed);
          }
          confirmRemoveConnectorId = null;
          noticeText = `Коннектор «${connector.name || id}» удалён.`;
        } else {
          noticeText = res?.error || 'Не удалось удалить коннектор.';
        }
      } catch (err) {
        noticeText = err?.message || 'Ошибка при удалении коннектора.';
      }
    } else {
      const nextItems = (connectorsData.items || []).filter((c) => c.id !== id);
      emitConnectorsChanged({ items: nextItems });
      confirmRemoveConnectorId = null;
      noticeText = `Коннектор «${connector.name || id}» удалён.`;
    }

    pendingConnectorRemoves.delete(id);
    if (document.body.contains(backdrop)) renderModal();
  }

  async function copyPlainText(text) {
    const value = String(text || '');
    if (!value) return false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      // fall through to host clipboard helper
    }
    if (typeof window.host?.chatsCopy === 'function') {
      window.host.chatsCopy(value);
      return true;
    }
    return false;
  }

  async function applyConnectorConfigureResponse(res) {
    if (res && (Array.isArray(res.categories) || Array.isArray(res.items))) {
      emitConnectorsChanged(res);
      return;
    }
    const refreshed = await fetchConnectors(ctx, { fallbackItems: connectorsData.items, refresh: true });
    emitConnectorsChanged(refreshed);
  }

  function extractDigestPayload(res) {
    const d = (res && typeof res.digest === 'object' && res.digest) ? res.digest : res;
    if (!d || typeof d !== 'object') return null;
    const preview = String(d.preview || '');
    const markdown = String(d.markdown || d.content || d.text || preview);
    const chars = Number.isFinite(Number(d.chars)) ? Math.round(Number(d.chars)) : markdown.length;
    return {
      path: String(d.path || ''),
      chars,
      generatedAt: d.generatedAt || new Date().toISOString(),
      preview,
      markdown,
    };
  }

  async function handleConnectorConfigure(id, payload = {}) {
    if (!id || pendingConnectorConfigs.has(id)) return null;
    const host = window.host;
    const hasConfigure = typeof host?.connectorsConfigure === 'function';
    const canFallback = (
      (id === 'health-connect' && typeof host?.connectorsHealthSync === 'function')
      || (id === 'google-workspace' && typeof host?.connectorsCheck === 'function')
      || (id === 'gemini-notebook' && typeof host?.connectorsNotebookDigest === 'function')
    );

    if (!hasConfigure && !canFallback) {
      const msg = 'Настройка этого коннектора недоступна в текущем режиме.';
      connectorConfigFeedback.set(id, { ok: false, text: msg });
      noticeText = msg;
      renderModal();
      return null;
    }

    pendingConnectorConfigs.add(id);
    connectorConfigFeedback.delete(id);
    renderModal();

    let result = null;
    try {
      let res;
      if (hasConfigure) {
        res = await host.connectorsConfigure({ id, ...payload });
      } else if (id === 'health-connect') {
        res = await host.connectorsHealthSync(payload);
      } else if (id === 'google-workspace') {
        res = await host.connectorsCheck({ id: 'google-workspace' });
      } else {
        res = await host.connectorsNotebookDigest();
      }
      result = res;

      if (id === 'google-workspace' && Array.isArray(res?.setupSteps) && res.setupSteps.length) {
        connectorSetupDrafts['google-workspace'].setupSteps = res.setupSteps.map((s) => String(s));
      }

      if (!res || res.ok === false) {
        const errMsg = res?.error || res?.message || 'Не удалось сохранить настройки коннектора.';
        connectorConfigFeedback.set(id, { ok: false, text: errMsg });
        noticeText = errMsg;
      } else {
        if (id === 'telegram') {
          connectorSetupDrafts.telegram.token = '';
        } else if (id === 'wger') {
          connectorSetupDrafts.wger.token = '';
          if (payload.url) connectorSetupDrafts.wger.url = payload.url;
        } else if (id === 'gemini-notebook') {
          const parsed = extractDigestPayload(res);
          if (parsed) digestResult = parsed;
        }

        await applyConnectorConfigureResponse(res);

        let okMsg = res.message || '';
        if (!okMsg) {
          if (id === 'telegram') {
            const botTag = res.botUsername ? ` (@${String(res.botUsername).replace(/^@/, '')})` : '';
            okMsg = res.linked
              ? `Telegram-бот${botTag} подключён и связан.`
              : `Токен сохранён${botTag}. Напиши боту /start и нажми «Сохранить и связать».`;
          } else if (id === 'wger') {
            okMsg = res.connected || res.reachable
              ? 'Wger сохранён и доступен.'
              : 'Настройки Wger сохранены (проверь доступность сервера).';
          } else if (id === 'health-connect') {
            okMsg = 'Локальные данные здоровья сохранены.';
          } else if (id === 'google-workspace') {
            const conn = res.connector || (connectorsData.items || []).find((x) => x.id === 'google-workspace');
            okMsg = res.detail || conn?.detail || (conn?.status === 'connected' ? 'Вход в Google Workspace подтверждён.' : 'Вход в Google Workspace пока не обнаружен.');
          } else if (id === 'gemini-notebook') {
            okMsg = `Дайджест Gemini Notebook собран (${digestResult?.chars ?? 0} симв.).`;
          } else {
            okMsg = 'Настройки сохранены.';
          }
        }
        connectorConfigFeedback.set(id, { ok: true, text: okMsg });
        noticeText = okMsg;
      }
    } catch (err) {
      const errMsg = err?.message || 'Ошибка при настройке коннектора.';
      connectorConfigFeedback.set(id, { ok: false, text: errMsg });
      noticeText = errMsg;
    } finally {
      pendingConnectorConfigs.delete(id);
      if (document.body.contains(backdrop)) renderModal();
    }
    return result;
  }

  async function handleNotebookDigest({ copyAfter = false } = {}) {
    if (digestBusy || pendingConnectorConfigs.has('gemini-notebook')) return;
    const host = window.host;
    if (typeof host?.connectorsConfigure !== 'function' && typeof host?.connectorsNotebookDigest !== 'function') {
      const msg = 'Сборка дайджеста Gemini Notebook недоступна в текущем режиме.';
      connectorConfigFeedback.set('gemini-notebook', { ok: false, text: msg });
      noticeText = msg;
      renderModal();
      return;
    }
    digestBusy = true;
    openSetupConnectorId = 'gemini-notebook';
    renderModal();
    try {
      const res = typeof host?.connectorsConfigure === 'function'
        ? await host.connectorsConfigure({ id: 'gemini-notebook' })
        : await host.connectorsNotebookDigest();
      if (!res || res.ok === false) {
        const errMsg = res?.error || 'Не удалось собрать дайджест Gemini Notebook.';
        connectorConfigFeedback.set('gemini-notebook', { ok: false, text: errMsg });
        noticeText = errMsg;
      } else {
        const parsed = extractDigestPayload(res);
        if (parsed) digestResult = parsed;
        await applyConnectorConfigureResponse(res);
        let msg = res.message || `Дайджест Gemini Notebook собран (${digestResult?.chars ?? 0} симв.).`;
        if (copyAfter && digestResult) {
          const copied = await copyPlainText(digestResult.markdown || digestResult.preview);
          if (copied) msg = `Дайджест собран (${digestResult.chars} симв.) и скопирован в буфер обмена.`;
        }
        connectorConfigFeedback.set('gemini-notebook', { ok: true, text: msg });
        noticeText = msg;
      }
    } catch (err) {
      const errMsg = err?.message || 'Ошибка при сборке дайджеста.';
      connectorConfigFeedback.set('gemini-notebook', { ok: false, text: errMsg });
      noticeText = errMsg;
    } finally {
      digestBusy = false;
      if (document.body.contains(backdrop)) renderModal();
    }
  }

  function buildConnectorsStatsBar() {
    const st = connectorsData.stats || {};
    const total = Number.isFinite(st.total) ? st.total : (connectorsData.items || []).length;
    const connected = Number.isFinite(st.connected)
      ? st.connected
      : (connectorsData.items || []).filter((c) => c.enabled !== false && c.status === 'connected').length;
    const activeInMode = Number.isFinite(st.activeInMode)
      ? st.activeInMode
      : (connectorsData.items || []).filter((c) => c.enabled !== false && !c.pausedInMode).length;
    const customCount = Number.isFinite(st.customCount)
      ? st.customCount
      : (connectorsData.items || []).filter((c) => c.isCustom).length;

    const strip = document.createElement('div');
    strip.className = 'slash-budget';

    const main = document.createElement('span');
    main.className = 'slash-budget__main';

    const dot = document.createElement('span');
    dot.className = `slash-status-dot ${connected > 0 ? 'is-connected' : 'is-paused'}`;
    dot.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.textContent = `Подключено: ${connected} · Активно: ${activeInMode} / ${total}`;

    main.append(dot, text);

    const meta = document.createElement('span');
    meta.className = 'slash-budget__meta';
    meta.textContent = customCount > 0 ? `Своих MCP: ${customCount}` : 'Упоминание через @';

    strip.append(main, meta);
    return strip;
  }

  function buildAddConnectorForm() {
    const form = document.createElement('form');
    form.className = 'slash-skill-form';
    form.autocomplete = 'off';

    const head = document.createElement('div');
    head.className = 'slash-skill-form__head';
    const title = document.createElement('h3');
    title.className = 'slash-skill-form__title';
    title.textContent = 'Добавить MCP-коннектор';
    const closeFormBtn = document.createElement('button');
    closeFormBtn.type = 'button';
    closeFormBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--icon';
    closeFormBtn.setAttribute('aria-label', 'Закрыть форму');
    closeFormBtn.appendChild(createIconSvg('close', 16));
    closeFormBtn.addEventListener('click', () => {
      activeForm = null;
      formError = '';
      connectorAddDraft.preview = null;
      connectorAddDraft.previewMessage = '';
      renderModal();
    });
    head.append(title, closeFormBtn);
    form.appendChild(head);

    if (formError) {
      const err = document.createElement('p');
      err.className = 'slash-skill-form__error';
      err.textContent = formError;
      form.appendChild(err);
    }

    const transportTabs = document.createElement('div');
    transportTabs.className = 'slash-skill-form__tabs';
    for (const [key, label] of [['http', 'HTTP / SSE'], ['stdio', 'Локальный stdio']]) {
      const tabBtn = document.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = `slash-skill-form__tab${connectorAddDraft.transport === key ? ' is-active' : ''}`;
      tabBtn.textContent = label;
      tabBtn.disabled = formBusy;
      tabBtn.addEventListener('click', () => {
        connectorAddDraft.transport = key;
        connectorAddDraft.preview = null;
        connectorAddDraft.previewMessage = '';
        formError = '';
        renderModal();
      });
      transportTabs.appendChild(tabBtn);
    }
    form.appendChild(transportTabs);

    const grid = document.createElement('div');
    grid.className = 'slash-skill-form__grid';

    const nameField = document.createElement('label');
    nameField.className = 'slash-skill-form__field';
    const nameLbl = document.createElement('span');
    nameLbl.className = 'slash-skill-form__label';
    nameLbl.textContent = 'Название';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'slash-skill-form__input';
    nameInput.placeholder = 'Например, Notion MCP';
    nameInput.value = connectorAddDraft.name;
    nameInput.required = true;
    nameInput.addEventListener('input', () => {
      connectorAddDraft.name = nameInput.value;
      connectorAddDraft.preview = null;
    });
    nameField.append(nameLbl, nameInput);

    const slugField = document.createElement('label');
    slugField.className = 'slash-skill-form__field';
    const slugLbl = document.createElement('span');
    slugLbl.className = 'slash-skill-form__label';
    slugLbl.textContent = 'Тег @slug (необязательно)';
    const slugInput = document.createElement('input');
    slugInput.type = 'text';
    slugInput.className = 'slash-skill-form__input';
    slugInput.placeholder = 'notion-mcp';
    slugInput.value = connectorAddDraft.slug;
    slugInput.addEventListener('input', () => {
      connectorAddDraft.slug = slugInput.value;
      connectorAddDraft.preview = null;
    });
    slugField.append(slugLbl, slugInput);

    const catField = document.createElement('label');
    catField.className = 'slash-skill-form__field';
    const catLbl = document.createElement('span');
    catLbl.className = 'slash-skill-form__label';
    catLbl.textContent = 'Категория';
    const catSelect = document.createElement('select');
    catSelect.className = 'slash-skill-form__select';
    for (const c of CONNECTOR_CATEGORIES) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.title;
      catSelect.appendChild(opt);
    }
    catSelect.value = connectorAddDraft.category || 'dev';
    catSelect.addEventListener('change', () => {
      connectorAddDraft.category = catSelect.value;
      connectorAddDraft.preview = null;
    });
    catField.append(catLbl, catSelect);

    const scopeField = document.createElement('div');
    scopeField.className = 'slash-skill-form__field';
    const scopeLbl = document.createElement('span');
    scopeLbl.className = 'slash-skill-form__label';
    scopeLbl.textContent = 'Режим доступа';
    const scopeTabs = document.createElement('div');
    scopeTabs.className = 'slash-skill-form__tabs';
    for (const [key, label] of [['cloud', 'Облачный'], ['local', 'Только локальный']]) {
      const sBtn = document.createElement('button');
      sBtn.type = 'button';
      sBtn.className = `slash-skill-form__tab${connectorAddDraft.scope === key ? ' is-active' : ''}`;
      sBtn.textContent = label;
      sBtn.disabled = formBusy;
      sBtn.addEventListener('click', () => {
        connectorAddDraft.scope = key;
        connectorAddDraft.preview = null;
        renderModal();
      });
      scopeTabs.appendChild(sBtn);
    }
    scopeField.append(scopeLbl, scopeTabs);

    grid.append(nameField, slugField, catField, scopeField);

    if (connectorAddDraft.transport === 'http') {
      const urlField = document.createElement('label');
      urlField.className = 'slash-skill-form__field slash-skill-form__field--full';
      const urlLbl = document.createElement('span');
      urlLbl.className = 'slash-skill-form__label';
      urlLbl.textContent = 'URL сервера MCP (HTTP / SSE)';
      const urlInput = document.createElement('input');
      urlInput.type = 'url';
      urlInput.className = 'slash-skill-form__input';
      urlInput.placeholder = 'http://127.0.0.1:8080/mcp или https://example.com/sse';
      urlInput.value = connectorAddDraft.url;
      urlInput.required = true;
      urlInput.addEventListener('input', () => {
        connectorAddDraft.url = urlInput.value;
        connectorAddDraft.preview = null;
      });
      urlField.append(urlLbl, urlInput);
      grid.appendChild(urlField);
    } else {
      const cmdField = document.createElement('label');
      cmdField.className = 'slash-skill-form__field';
      const cmdLbl = document.createElement('span');
      cmdLbl.className = 'slash-skill-form__label';
      cmdLbl.textContent = 'Команда запуска';
      const cmdInput = document.createElement('input');
      cmdInput.type = 'text';
      cmdInput.className = 'slash-skill-form__input';
      cmdInput.placeholder = 'node или npx';
      cmdInput.value = connectorAddDraft.command;
      cmdInput.required = true;
      cmdInput.addEventListener('input', () => {
        connectorAddDraft.command = cmdInput.value;
        connectorAddDraft.preview = null;
      });
      cmdField.append(cmdLbl, cmdInput);

      const argsField = document.createElement('label');
      argsField.className = 'slash-skill-form__field';
      const argsLbl = document.createElement('span');
      argsLbl.className = 'slash-skill-form__label';
      argsLbl.textContent = 'Аргументы (через пробел, необязательно)';
      const argsInput = document.createElement('input');
      argsInput.type = 'text';
      argsInput.className = 'slash-skill-form__input';
      argsInput.placeholder = 'server.js --readonly';
      argsInput.value = connectorAddDraft.args;
      argsInput.addEventListener('input', () => {
        connectorAddDraft.args = argsInput.value;
        connectorAddDraft.preview = null;
      });
      argsField.append(argsLbl, argsInput);

      grid.append(cmdField, argsField);
    }

    const tokenField = document.createElement('label');
    tokenField.className = 'slash-skill-form__field slash-skill-form__field--full';
    const tokenLbl = document.createElement('span');
    tokenLbl.className = 'slash-skill-form__label';
    tokenLbl.textContent = 'API-токен / ключ (необязательно) · Шифруется через Windows DPAPI';
    const tokenInput = document.createElement('input');
    tokenInput.type = 'password';
    tokenInput.autocomplete = 'new-password';
    tokenInput.className = 'slash-skill-form__input';
    tokenInput.placeholder = 'Оставь пустым, если авторизация не нужна';
    tokenInput.value = connectorAddDraft.token;
    tokenInput.addEventListener('input', () => {
      connectorAddDraft.token = tokenInput.value;
      connectorAddDraft.preview = null;
    });
    const tokenHint = document.createElement('span');
    tokenHint.className = 'slash-skill-form__hint';
    tokenHint.textContent = connectorAddDraft.scope === 'local'
      ? 'Только локальный: никогда не передаётся облачным агентам (работает только в локальной Ollama).'
      : 'Облачный: автоматически ставится на паузу в приватном, временном, 18+ и Tor режимах.';
    tokenField.append(tokenLbl, tokenInput, tokenHint);
    grid.appendChild(tokenField);

    form.appendChild(grid);

    if (connectorAddDraft.preview) {
      const pv = connectorAddDraft.preview;
      const previewBox = document.createElement('div');
      previewBox.className = 'slash-skill-form__preview';

      const pvTitle = document.createElement('div');
      pvTitle.className = 'slash-skill-form__preview-title';
      const pvName = document.createElement('span');
      pvName.textContent = pv.name || connectorAddDraft.name.trim() || 'MCP-коннектор';
      pvTitle.appendChild(pvName);
      if (pv.id || pv.slug) {
        const pvTag = document.createElement('span');
        pvTag.className = 'slash-mention-chip';
        pvTag.textContent = `@${pv.id || pv.slug}`;
        pvTitle.appendChild(pvTag);
      }

      const pvDesc = document.createElement('p');
      pvDesc.className = 'slash-skill-form__preview-desc';
      pvDesc.textContent = connectorAddDraft.previewMessage || 'Проверь параметры подключения и подтверди добавление.';

      const pvMeta = document.createElement('div');
      pvMeta.className = 'slash-skill-form__preview-meta';
      const parts = [];
      parts.push(`Транспорт: ${pv.transport || connectorAddDraft.transport}`);
      if (pv.url || connectorAddDraft.url.trim()) parts.push(`URL: ${pv.url || connectorAddDraft.url.trim()}`);
      if (pv.command || connectorAddDraft.command.trim()) parts.push(`Команда: ${pv.command || connectorAddDraft.command.trim()}`);
      parts.push(connectorAddDraft.scope === 'local' ? 'Только локальный' : 'Облачный');
      if (connectorAddDraft.token.trim()) parts.push('Токен: DPAPI');
      pvMeta.textContent = parts.join(' · ');

      previewBox.append(pvTitle, pvDesc, pvMeta);
      form.appendChild(previewBox);
    }

    const actions = document.createElement('div');
    actions.className = 'slash-skill-form__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'slash-catalog__action-btn';
    cancelBtn.textContent = connectorAddDraft.preview ? 'Сбросить' : 'Отмена';
    cancelBtn.disabled = formBusy;
    cancelBtn.addEventListener('click', () => {
      if (connectorAddDraft.preview) {
        connectorAddDraft.preview = null;
        connectorAddDraft.previewMessage = '';
        formError = '';
        renderModal();
        return;
      }
      activeForm = null;
      formError = '';
      renderModal();
    });

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--primary';
    if (connectorAddDraft.preview) {
      submitBtn.textContent = formBusy ? 'Сохраняю…' : 'Подтвердить добавление';
    } else {
      submitBtn.textContent = formBusy ? 'Проверяю…' : 'Проверить коннектор';
    }
    submitBtn.disabled = formBusy;

    actions.append(cancelBtn, submitBtn);
    form.appendChild(actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (formBusy) return;
      const name = connectorAddDraft.name.trim();
      const transport = connectorAddDraft.transport === 'stdio' ? 'stdio' : 'http';
      const url = transport === 'http' ? connectorAddDraft.url.trim() : '';
      const command = transport === 'stdio' ? connectorAddDraft.command.trim() : '';
      const args = transport === 'stdio'
        ? connectorAddDraft.args.trim().split(/\s+/).filter(Boolean)
        : [];

      if (!name) {
        formError = 'Укажи название коннектора.';
        renderModal();
        return;
      }
      if (transport === 'http' && !url) {
        formError = 'Укажи URL MCP-сервера.';
        renderModal();
        return;
      }
      if (transport === 'stdio' && !command) {
        formError = 'Укажи команду запуска stdio-сервера.';
        renderModal();
        return;
      }
      if (typeof window.host?.connectorsAdd !== 'function') {
        formError = 'Добавление MCP-коннекторов недоступно в текущем режиме.';
        renderModal();
        return;
      }

      const confirm = Boolean(connectorAddDraft.preview);
      const isLocal = connectorAddDraft.scope === 'local';
      formBusy = true;
      formError = '';
      renderModal();
      try {
        const res = await window.host.connectorsAdd({
          name,
          slug: (confirm && (connectorAddDraft.preview?.id || connectorAddDraft.preview?.slug))
            ? (connectorAddDraft.preview.id || connectorAddDraft.preview.slug)
            : (connectorAddDraft.slug.trim() || undefined),
          category: connectorAddDraft.category || 'dev',
          transport,
          ...(url ? { url } : {}),
          ...(command ? { command, args } : {}),
          ...(connectorAddDraft.token.trim() ? { token: connectorAddDraft.token.trim() } : {}),
          cloudOnly: !isLocal,
          localOnly: isLocal,
          confirm,
        });
        if (!confirm && res?.confirmRequired) {
          connectorAddDraft.preview = res.preview || {
            name,
            slug: connectorAddDraft.slug.trim(),
            transport,
            url,
            command,
          };
          connectorAddDraft.previewMessage = res.message || '';
        } else if (!res || res.ok === false) {
          formError = res?.error || res?.message || 'Не удалось добавить MCP-коннектор.';
        } else {
          if (Array.isArray(res.categories) || Array.isArray(res.items)) {
            emitConnectorsChanged(res);
          } else {
            const refreshed = await fetchConnectors(ctx, { fallbackItems: connectorsData.items });
            emitConnectorsChanged(refreshed);
          }
          const createdId = res.connector?.id || connectorAddDraft.preview?.id || '';
          const createdName = res.connector?.name || name;
          noticeText = `Коннектор «${createdName}» добавлен${createdId ? ` (@${createdId})` : ''}.`;
          if (createdId) pendingFocusConnectorId = createdId;
          activeForm = null;
          connectorAddDraft.name = '';
          connectorAddDraft.slug = '';
          connectorAddDraft.url = '';
          connectorAddDraft.command = '';
          connectorAddDraft.args = '';
          connectorAddDraft.token = '';
          connectorAddDraft.preview = null;
          connectorAddDraft.previewMessage = '';
        }
      } catch (err) {
        formError = err?.message || 'Ошибка при добавлении MCP-коннектора.';
      } finally {
        formBusy = false;
        if (document.body.contains(backdrop)) renderModal();
      }
    });

    return form;
  }

  function buildConnectorSetupPanel(c) {
    const id = c.id || c.name;
    const busy = pendingConnectorConfigs.has(id) || (id === 'gemini-notebook' && digestBusy);
    const feedback = connectorConfigFeedback.get(id) || null;

    const panel = document.createElement('div');
    panel.className = 'slash-connector-setup';
    panel.addEventListener('click', (e) => e.stopPropagation());

    const head = document.createElement('div');
    head.className = 'slash-connector-setup__head';
    const title = document.createElement('h4');
    title.className = 'slash-connector-setup__title';
    const titles = {
      telegram: 'Настройка Telegram-бота',
      wger: 'Настройка Wger',
      'health-connect': 'Локальный чек-ин здоровья',
      'google-workspace': 'Вход в Google Workspace',
      'gemini-notebook': 'Дайджест Gemini Notebook',
    };
    title.textContent = titles[id] || `Настройка ${c.name || id}`;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'slash-card__btn slash-card__btn--icon';
    closeBtn.setAttribute('aria-label', 'Скрыть панель настройки');
    closeBtn.appendChild(createIconSvg('close', 14));
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSetupConnectorId = null;
      renderModal();
    });
    head.append(title, closeBtn);
    panel.appendChild(head);

    const appendFeedback = () => {
      if (!feedback?.text) return;
      const fb = document.createElement('p');
      fb.className = `slash-connector-setup__feedback ${feedback.ok ? 'is-ok' : 'is-error'}`;
      fb.textContent = feedback.text;
      panel.appendChild(fb);
    };

    const makeField = (labelText, inputEl, hintText = '', full = false) => {
      const wrap = document.createElement('label');
      wrap.className = `slash-skill-form__field${full ? ' slash-skill-form__field--full' : ''}`;
      const lbl = document.createElement('span');
      lbl.className = 'slash-skill-form__label';
      lbl.textContent = labelText;
      wrap.append(lbl, inputEl);
      if (hintText) {
        const hint = document.createElement('span');
        hint.className = 'slash-skill-form__hint';
        hint.textContent = hintText;
        wrap.appendChild(hint);
      }
      return wrap;
    };

    if (id === 'telegram') {
      const steps = document.createElement('ul');
      steps.className = 'slash-connector-setup__steps';
      for (const line of [
        '1. Получи токен у @BotFather → вставь ниже.',
        '2. Напиши боту /start и нажми «Сохранить и связать».',
      ]) {
        const li = document.createElement('li');
        li.textContent = line;
        steps.appendChild(li);
      }
      panel.appendChild(steps);

      const form = document.createElement('form');
      form.className = 'slash-connector-setup__form';
      form.autocomplete = 'off';

      const tokenInput = document.createElement('input');
      tokenInput.type = 'password';
      tokenInput.className = 'slash-skill-form__input';
      tokenInput.autocomplete = 'off';
      tokenInput.placeholder = '123456789:AA...';
      tokenInput.value = connectorSetupDrafts.telegram.token;
      tokenInput.disabled = busy;
      tokenInput.addEventListener('input', () => {
        connectorSetupDrafts.telegram.token = tokenInput.value;
      });
      form.appendChild(makeField('Токен бота', tokenInput, 'Шифруется через Windows DPAPI', true));

      if (feedback?.text) {
        const fb = document.createElement('p');
        fb.className = `slash-connector-setup__feedback ${feedback.ok ? 'is-ok' : 'is-error'}`;
        fb.textContent = feedback.text;
        form.appendChild(fb);
      }

      const actions = document.createElement('div');
      actions.className = 'slash-connector-setup__actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'slash-connector-btn';
      cancelBtn.disabled = busy;
      cancelBtn.textContent = 'Скрыть';
      cancelBtn.addEventListener('click', () => {
        openSetupConnectorId = null;
        renderModal();
      });

      const submitBtn = document.createElement('button');
      submitBtn.type = 'submit';
      submitBtn.className = 'slash-connector-btn slash-connector-btn--primary';
      submitBtn.disabled = busy;
      submitBtn.textContent = busy ? 'Связываю…' : 'Сохранить и связать';

      actions.append(cancelBtn, submitBtn);
      form.appendChild(actions);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const tok = connectorSetupDrafts.telegram.token.trim();
        if (!tok && c.status === 'not_configured') {
          connectorConfigFeedback.set('telegram', { ok: false, text: 'Вставь токен бота от @BotFather.' });
          renderModal();
          return;
        }
        await handleConnectorConfigure('telegram', tok ? { token: tok, link: true } : { link: true });
      });

      panel.appendChild(form);
      return panel;
    }

    if (id === 'wger') {
      const form = document.createElement('form');
      form.className = 'slash-connector-setup__form';
      form.autocomplete = 'off';

      const grid = document.createElement('div');
      grid.className = 'slash-connector-setup__grid';

      const urlInput = document.createElement('input');
      urlInput.type = 'url';
      urlInput.className = 'slash-skill-form__input';
      urlInput.placeholder = 'http://192.168.0.107:8000 или https://wger.de';
      urlInput.value = connectorSetupDrafts.wger.url;
      urlInput.disabled = busy;
      urlInput.addEventListener('input', () => {
        connectorSetupDrafts.wger.url = urlInput.value;
      });

      const tokenInput = document.createElement('input');
      tokenInput.type = 'password';
      tokenInput.className = 'slash-skill-form__input';
      tokenInput.autocomplete = 'off';
      tokenInput.placeholder = 'API Key (необязательно для открытого сервера)';
      tokenInput.value = connectorSetupDrafts.wger.token;
      tokenInput.disabled = busy;
      tokenInput.addEventListener('input', () => {
        connectorSetupDrafts.wger.token = tokenInput.value;
      });

      grid.append(
        makeField('URL сервера', urlInput, 'Локальный сервер или wger.de'),
        makeField('API Key', tokenInput, 'Wger → Профиль → API Key, шифруется через DPAPI'),
      );
      form.appendChild(grid);

      if (feedback?.text) {
        const fb = document.createElement('p');
        fb.className = `slash-connector-setup__feedback ${feedback.ok ? 'is-ok' : 'is-error'}`;
        fb.textContent = feedback.text;
        form.appendChild(fb);
      }

      const actions = document.createElement('div');
      actions.className = 'slash-connector-setup__actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'slash-connector-btn';
      cancelBtn.disabled = busy;
      cancelBtn.textContent = 'Скрыть';
      cancelBtn.addEventListener('click', () => {
        openSetupConnectorId = null;
        renderModal();
      });

      const submitBtn = document.createElement('button');
      submitBtn.type = 'submit';
      submitBtn.className = 'slash-connector-btn slash-connector-btn--primary';
      submitBtn.disabled = busy;
      submitBtn.textContent = busy ? 'Проверяю…' : 'Сохранить и проверить';

      actions.append(cancelBtn, submitBtn);
      form.appendChild(actions);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const cleanUrl = connectorSetupDrafts.wger.url.trim().replace(/\/+$/, '');
        const cleanTok = connectorSetupDrafts.wger.token.trim();
        if (!/^https?:\/\/\S+/i.test(cleanUrl)) {
          connectorConfigFeedback.set('wger', { ok: false, text: 'Укажи корректный URL, начиная с http:// или https://.' });
          renderModal();
          return;
        }
        await handleConnectorConfigure('wger', { url: cleanUrl, ...(cleanTok ? { token: cleanTok } : {}) });
      });

      panel.appendChild(form);
      return panel;
    }

    if (id === 'health-connect') {
      const draft = connectorSetupDrafts['health-connect'];
      const form = document.createElement('form');
      form.className = 'slash-connector-setup__form';
      form.autocomplete = 'off';

      const grid = document.createElement('div');
      grid.className = 'slash-connector-setup__grid';

      const stepsInput = document.createElement('input');
      stepsInput.type = 'number';
      stepsInput.min = '0';
      stepsInput.max = '200000';
      stepsInput.step = '1';
      stepsInput.className = 'slash-skill-form__input';
      stepsInput.placeholder = '8500';
      stepsInput.value = draft.steps;
      stepsInput.disabled = busy;
      stepsInput.addEventListener('input', () => { draft.steps = stepsInput.value; });

      const sleepInput = document.createElement('input');
      sleepInput.type = 'number';
      sleepInput.min = '0';
      sleepInput.max = '24';
      sleepInput.step = '0.1';
      sleepInput.className = 'slash-skill-form__input';
      sleepInput.placeholder = '7.5';
      sleepInput.value = draft.sleepHours;
      sleepInput.disabled = busy;
      sleepInput.addEventListener('input', () => { draft.sleepHours = sleepInput.value; });

      const hrInput = document.createElement('input');
      hrInput.type = 'number';
      hrInput.min = '25';
      hrInput.max = '240';
      hrInput.step = '1';
      hrInput.className = 'slash-skill-form__input';
      hrInput.placeholder = '68';
      hrInput.value = draft.avgHr;
      hrInput.disabled = busy;
      hrInput.addEventListener('input', () => { draft.avgHr = hrInput.value; });

      const notesInput = document.createElement('input');
      notesInput.type = 'text';
      notesInput.className = 'slash-skill-form__input';
      notesInput.placeholder = 'Силовая 45 мин, ровный сон';
      notesInput.value = draft.notes;
      notesInput.disabled = busy;
      notesInput.addEventListener('input', () => { draft.notes = notesInput.value; });

      grid.append(
        makeField('Шаги', stepsInput),
        makeField('Сон (ч)', sleepInput),
        makeField('Средний пульс', hrInput),
        makeField('Тренировка / заметка', notesInput),
      );
      form.appendChild(grid);

      const note = document.createElement('p');
      note.className = 'slash-connector-setup__note';
      note.textContent = 'Данные хранятся строго локально. Для автосинхронизации с Android Health Connect / Zepp Life открой раздел «Коннекторы» в мобильной Капри.';
      form.appendChild(note);

      if (feedback?.text) {
        const fb = document.createElement('p');
        fb.className = `slash-connector-setup__feedback ${feedback.ok ? 'is-ok' : 'is-error'}`;
        fb.textContent = feedback.text;
        form.appendChild(fb);
      }

      const actions = document.createElement('div');
      actions.className = 'slash-connector-setup__actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'slash-connector-btn';
      cancelBtn.disabled = busy;
      cancelBtn.textContent = 'Скрыть';
      cancelBtn.addEventListener('click', () => {
        openSetupConnectorId = null;
        renderModal();
      });

      const submitBtn = document.createElement('button');
      submitBtn.type = 'submit';
      submitBtn.className = 'slash-connector-btn slash-connector-btn--primary';
      submitBtn.disabled = busy;
      submitBtn.textContent = busy ? 'Сохраняю…' : 'Сохранить локально';

      actions.append(cancelBtn, submitBtn);
      form.appendChild(actions);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const parseNum = (raw) => {
          const s = String(raw || '').trim().replace(',', '.');
          if (!s) return null;
          const n = Number(s);
          return Number.isFinite(n) ? n : null;
        };
        const steps = parseNum(draft.steps);
        const sleepHours = parseNum(draft.sleepHours);
        const avgHr = parseNum(draft.avgHr);
        const notes = String(draft.notes || '').trim();
        if (steps === null && sleepHours === null && avgHr === null && !notes) {
          connectorConfigFeedback.set('health-connect', { ok: false, text: 'Заполни хотя бы одно поле.' });
          renderModal();
          return;
        }
        await handleConnectorConfigure('health-connect', {
          ...(steps !== null ? { steps } : {}),
          ...(sleepHours !== null ? { sleepHours } : {}),
          ...(avgHr !== null ? { avgHr } : {}),
          ...(notes ? { notes } : {}),
          source: 'desktop-local',
        });
      });

      panel.appendChild(form);
      return panel;
    }

    if (id === 'google-workspace') {
      const stepsList = document.createElement('ul');
      stepsList.className = 'slash-connector-setup__steps';
      const lines = connectorSetupDrafts['google-workspace'].setupSteps?.length
        ? connectorSetupDrafts['google-workspace'].setupSteps
        : DEFAULT_GOOGLE_WORKSPACE_STEPS;
      for (const line of lines) {
        const li = document.createElement('li');
        li.textContent = line;
        stepsList.appendChild(li);
      }
      panel.appendChild(stepsList);

      appendFeedback();

      const actions = document.createElement('div');
      actions.className = 'slash-connector-setup__actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'slash-connector-btn';
      cancelBtn.disabled = busy;
      cancelBtn.textContent = 'Скрыть';
      cancelBtn.addEventListener('click', () => {
        openSetupConnectorId = null;
        renderModal();
      });

      const checkSignInBtn = document.createElement('button');
      checkSignInBtn.type = 'button';
      checkSignInBtn.className = 'slash-connector-btn slash-connector-btn--primary';
      checkSignInBtn.disabled = busy;
      checkSignInBtn.append(
        createIconSvg('check', 13),
        document.createTextNode(busy ? 'Проверяю…' : 'Проверить вход'),
      );
      checkSignInBtn.addEventListener('click', () => {
        handleConnectorConfigure('google-workspace', { action: 'check' });
      });

      actions.append(cancelBtn, checkSignInBtn);
      panel.appendChild(actions);
      return panel;
    }

    if (id === 'gemini-notebook') {
      const note = document.createElement('p');
      note.className = 'slash-connector-setup__note';
      note.textContent = 'Собирает очищенный дайджест рабочих заметок GENESIS (без секретов и Tor). Скопируй текст и вставь прямо в Gemini Notebook.';
      panel.appendChild(note);

      appendFeedback();

      if (digestResult) {
        const metaRow = document.createElement('div');
        metaRow.className = 'slash-connector-digest__head';
        const dMeta = document.createElement('span');
        dMeta.className = 'slash-connector-digest__meta';
        dMeta.textContent = `Собрано: ${digestResult.chars} симв.`;
        metaRow.appendChild(dMeta);
        panel.appendChild(metaRow);

        if (digestResult.path) {
          const pathEl = document.createElement('div');
          pathEl.className = 'slash-connector-digest__path';
          pathEl.textContent = digestResult.path;
          panel.appendChild(pathEl);
        }

        if (digestResult.preview) {
          const prevEl = document.createElement('pre');
          prevEl.className = 'slash-connector-digest__preview';
          prevEl.textContent = digestResult.preview;
          panel.appendChild(prevEl);
        }
      }

      const actions = document.createElement('div');
      actions.className = 'slash-connector-setup__actions';

      if (digestResult?.path) {
        const copyPathBtn = document.createElement('button');
        copyPathBtn.type = 'button';
        copyPathBtn.className = 'slash-connector-btn';
        copyPathBtn.textContent = 'Копировать путь';
        copyPathBtn.addEventListener('click', async () => {
          const ok = await copyPlainText(digestResult?.path || '');
          if (!ok) return;
          copyPathBtn.textContent = 'Скопировано';
          setTimeout(() => { copyPathBtn.textContent = 'Копировать путь'; }, 1200);
        });
        actions.appendChild(copyPathBtn);
      }

      const buildBtn = document.createElement('button');
      buildBtn.type = 'button';
      buildBtn.className = `slash-connector-btn${digestResult ? '' : ' slash-connector-btn--primary'}`;
      buildBtn.disabled = busy || c.enabled === false;
      buildBtn.append(
        createIconSvg('file-text', 13),
        document.createTextNode(busy ? 'Собираю…' : 'Собрать дайджест'),
      );
      buildBtn.addEventListener('click', () => handleNotebookDigest());
      actions.appendChild(buildBtn);

      const copyTextBtn = document.createElement('button');
      copyTextBtn.type = 'button';
      copyTextBtn.className = `slash-connector-btn${digestResult ? ' slash-connector-btn--primary' : ''}`;
      copyTextBtn.disabled = busy || c.enabled === false;
      copyTextBtn.append(
        createIconSvg('clipboard', 13),
        document.createTextNode('Копировать текст'),
      );
      copyTextBtn.addEventListener('click', async () => {
        const text = digestResult?.markdown || digestResult?.preview || '';
        if (!text) {
          await handleNotebookDigest({ copyAfter: true });
          return;
        }
        const ok = await copyPlainText(text);
        if (!ok) return;
        copyTextBtn.replaceChildren(createIconSvg('check', 13), document.createTextNode('Скопировано'));
        setTimeout(() => {
          copyTextBtn.replaceChildren(createIconSvg('clipboard', 13), document.createTextNode('Копировать текст'));
        }, 1200);
      });
      actions.appendChild(copyTextBtn);

      panel.appendChild(actions);
      return panel;
    }

    return null;
  }

  function buildConnectorCard(c) {
    const id = c.id || c.name;
    const enabled = c.enabled !== false;
    const paused = Boolean(c.pausedInMode);
    const toggleBusy = pendingConnectorToggles.has(id);
    const checkBusy = pendingConnectorChecks.has(id) || checkingAllConnectors;
    const removeBusy = pendingConnectorRemoves.has(id);
    const configBusy = pendingConnectorConfigs.has(id);
    const isConfirmingRemove = confirmRemoveConnectorId === id;
    const isFocused = pendingFocusConnectorId === id;
    const isConfigurable = Boolean(c.configurable) || CONFIGURABLE_CONNECTOR_IDS.has(id);
    const isSetupOpen = isConfigurable && openSetupConnectorId === id;
    const dotCls = connectorStatusDotClass(c);

    const card = document.createElement('div');
    card.className = `slash-connector-card${enabled ? '' : ' is-disabled'}${isFocused ? ' is-focused' : ''}${isSetupOpen ? ' is-setup-open' : ''}`;
    card.dataset.connectorId = id;

    const row = document.createElement('div');
    row.className = 'slash-connector-row';

    const avatar = document.createElement('span');
    avatar.className = 'slash-catalog__avatar';
    avatar.appendChild(createIconSvg(connectorIconName(c), 18));

    const main = document.createElement('div');
    main.className = 'slash-connector-main';

    const topLine = document.createElement('div');
    topLine.className = 'slash-catalog__item-top';

    const nameEl = document.createElement('span');
    nameEl.className = 'slash-catalog__item-name';
    nameEl.textContent = c.name || id;
    topLine.appendChild(nameEl);

    const mentionBtn = document.createElement('button');
    mentionBtn.type = 'button';
    mentionBtn.className = 'slash-mention-chip slash-mention-chip--btn';
    mentionBtn.textContent = `@${id}`;
    mentionBtn.disabled = !enabled;
    mentionBtn.title = enabled ? `Вставить @${id} в поле ввода` : 'Коннектор выключен';
    mentionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!enabled) return;
      cleanup();
      onRunCommand?.({ ...c, kind: 'connector', mention: `@${id}` });
    });
    topLine.appendChild(mentionBtn);

    const descEl = document.createElement('span');
    descEl.className = 'slash-catalog__item-desc';
    descEl.textContent = c.description || '';

    const metaRow = document.createElement('div');
    metaRow.className = 'slash-catalog__meta-row';

    const statusPill = document.createElement('span');
    statusPill.className = `slash-connector-status ${dotCls}`;
    const dot = document.createElement('span');
    dot.className = `slash-status-dot ${dotCls}`;
    dot.setAttribute('aria-hidden', 'true');
    const stText = document.createElement('span');
    const latencyPart = Number.isFinite(c.latencyMs) && c.latencyMs >= 0 ? ` · ${c.latencyMs} мс` : '';
    stText.textContent = `${c.statusLabel || defaultConnectorStatusLabel(c.status)}${latencyPart}`;
    statusPill.append(dot, stText);
    metaRow.appendChild(statusPill);

    if (c.localOnly) {
      const localChip = document.createElement('span');
      localChip.className = 'slash-skill-chip';
      localChip.textContent = 'Только локально';
      metaRow.appendChild(localChip);
    }

    if (paused) {
      const pauseChip = document.createElement('span');
      pauseChip.className = 'slash-skill-chip slash-skill-chip--paused';
      pauseChip.textContent = 'Пауза в этом режиме';
      if (c.pauseReason) pauseChip.title = c.pauseReason;
      metaRow.appendChild(pauseChip);
    }

    if (c.isCustom) {
      const customChip = document.createElement('span');
      customChip.className = 'slash-skill-chip';
      customChip.textContent = 'Свой MCP';
      metaRow.appendChild(customChip);
    }

    if (c.detail) {
      const detailEl = document.createElement('span');
      detailEl.className = 'slash-connector-detail';
      detailEl.textContent = String(c.detail);
      detailEl.title = String(c.detail);
      metaRow.appendChild(detailEl);
    }

    const actionsRow = document.createElement('div');
    actionsRow.className = 'slash-connector-actions';

    if (isConfigurable) {
      if (id === 'gemini-notebook') {
        const digestBtn = document.createElement('button');
        digestBtn.type = 'button';
        digestBtn.className = `slash-connector-btn${isSetupOpen ? ' is-active' : ''}`;
        digestBtn.disabled = digestBusy || configBusy || !enabled;
        digestBtn.append(
          createIconSvg('file-text', 13),
          document.createTextNode(digestBusy ? 'Собираю…' : 'Собрать дайджест'),
        );
        digestBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleNotebookDigest();
        });
        actionsRow.appendChild(digestBtn);

        const copyDigestBtn = document.createElement('button');
        copyDigestBtn.type = 'button';
        copyDigestBtn.className = 'slash-connector-btn';
        copyDigestBtn.disabled = digestBusy || configBusy || !enabled;
        copyDigestBtn.append(
          createIconSvg('clipboard', 13),
          document.createTextNode('Копировать'),
        );
        copyDigestBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const text = digestResult?.markdown || digestResult?.preview || '';
          if (!text) {
            await handleNotebookDigest({ copyAfter: true });
            return;
          }
          const ok = await copyPlainText(text);
          if (!ok) return;
          copyDigestBtn.replaceChildren(createIconSvg('check', 13), document.createTextNode('Скопировано'));
          setTimeout(() => {
            copyDigestBtn.replaceChildren(createIconSvg('clipboard', 13), document.createTextNode('Копировать'));
          }, 1200);
        });
        actionsRow.appendChild(copyDigestBtn);
      } else {
        const needsSetup = c.status === 'not_configured' || c.status === 'auth_required';
        const setupBtn = document.createElement('button');
        setupBtn.type = 'button';
        setupBtn.className = `slash-connector-btn${isSetupOpen ? ' is-active' : (needsSetup ? ' slash-connector-btn--primary' : '')}`;
        setupBtn.disabled = configBusy || removeBusy;
        setupBtn.setAttribute('aria-expanded', String(isSetupOpen));
        const isGoogle = id === 'google-workspace';
        setupBtn.append(
          createIconSvg(isGoogle ? 'plug' : 'sliders', 13),
          document.createTextNode(isGoogle ? 'Войти' : 'Настроить'),
        );
        setupBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (openSetupConnectorId === id) {
            openSetupConnectorId = null;
          } else {
            openSetupConnectorId = id;
            if (id === 'wger' && !connectorSetupDrafts.wger.url && c.url) {
              connectorSetupDrafts.wger.url = c.url;
            }
          }
          renderModal();
        });
        actionsRow.appendChild(setupBtn);
      }
    }

    const checkBtn = document.createElement('button');
    checkBtn.type = 'button';
    checkBtn.className = 'slash-connector-btn';
    checkBtn.disabled = checkBusy || removeBusy || configBusy;
    checkBtn.append(
      createIconSvg('refresh', 13),
      document.createTextNode(pendingConnectorChecks.has(id) ? 'Проверяю…' : 'Проверить'),
    );
    checkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleConnectorCheck(id);
    });
    actionsRow.appendChild(checkBtn);

    if (c.isCustom) {
      if (isConfirmingRemove) {
        const lbl = document.createElement('span');
        lbl.className = 'slash-connector-confirm-label';
        lbl.textContent = 'Удалить?';

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'slash-connector-btn slash-connector-btn--danger is-confirming';
        okBtn.disabled = removeBusy;
        okBtn.textContent = removeBusy ? 'Удаляю…' : 'Подтвердить';
        okBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleConnectorRemove(c);
        });

        const noBtn = document.createElement('button');
        noBtn.type = 'button';
        noBtn.className = 'slash-connector-btn';
        noBtn.disabled = removeBusy;
        noBtn.textContent = 'Отмена';
        noBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          confirmRemoveConnectorId = null;
          renderModal();
        });

        actionsRow.append(lbl, okBtn, noBtn);
      } else {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'slash-connector-btn slash-connector-btn--danger';
        delBtn.disabled = removeBusy;
        delBtn.append(createIconSvg('trash', 13), document.createTextNode('Удалить'));
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          confirmRemoveConnectorId = id;
          renderModal();
        });
        actionsRow.appendChild(delBtn);
      }
    }

    main.append(topLine, descEl, metaRow, actionsRow);

    const right = document.createElement('span');
    right.className = 'slash-catalog__item-right';

    const sw = createToggleSwitch(enabled, {
      label: `${enabled ? 'Выключить' : 'Включить'} коннектор ${c.name || id}`,
      disabled: toggleBusy || removeBusy,
      onToggle: () => handleConnectorToggle(c, !enabled),
    });
    right.appendChild(sw);

    row.append(avatar, main, right);
    card.appendChild(row);

    if (isSetupOpen) {
      const setupPanel = buildConnectorSetupPanel(c);
      if (setupPanel) card.appendChild(setupPanel);
    }

    return card;
  }

  function dockerOpKey(host, stackId, container = '') {
    return `${host}:${stackId}:${container || ''}`;
  }

  function findDockerStack(hostKey, stackId) {
    const list = dockerData?.[hostKey]?.stacks || [];
    return list.find((s) => s.id === stackId) || null;
  }

  async function loadDockerStatus({ refresh = false } = {}) {
    if (refresh) {
      if (dockerRefreshing) return;
      dockerRefreshing = true;
    } else {
      if (dockerLoading) return;
      dockerLoading = true;
    }
    renderModal();
    if (openNomadStackId) renderNomadPackModal();
    try {
      const next = await fetchDockerStatus({ refresh });
      if (!document.body.contains(backdrop)) return;
      dockerData = next;
      dockerLoaded = true;
      if (refresh && !next.isFallback) {
        noticeText = 'Статус Docker обновлён.';
      }
    } finally {
      dockerLoading = false;
      dockerRefreshing = false;
      if (document.body.contains(backdrop)) {
        renderModal();
        if (openNomadStackId) renderNomadPackModal();
      }
    }
  }

  async function handleDockerAction({ host, stackId, container = undefined, action, confirm = false, label = '' }) {
    const opKey = dockerOpKey(host, stackId, container || '');
    if (pendingDockerOps.has(opKey)) return;
    const hostApi = window.host;
    if (typeof hostApi?.dockerAction !== 'function') {
      noticeText = 'Управление Docker пока не подключено в приложении.';
      renderModal();
      if (openNomadStackId) renderNomadPackModal();
      return;
    }

    pendingDockerOps.add(opKey);
    if (confirm) dockerConfirmStop = null;
    noticeText = '';
    renderModal();
    if (openNomadStackId) renderNomadPackModal();

    try {
      const payload = { host, stackId, action };
      if (container) payload.container = container;
      if (confirm) payload.confirm = true;
      const res = await hostApi.dockerAction(payload);
      if (!document.body.contains(backdrop)) return;

      if (res?.confirmRequired) {
        dockerConfirmStop = {
          host,
          stackId,
          container: container || '',
          name: label || stackId,
          message: res.message || `Остановить критический сервис ${label || stackId}?`,
        };
      } else if (res?.ok) {
        dockerConfirmStop = null;
        if (res.status && (res.status.pc || res.status.lenovo)) {
          dockerData = normalizeDockerStatus(res.status);
          dockerLoaded = true;
        } else {
          const fresh = await fetchDockerStatus({ refresh: true });
          if (document.body.contains(backdrop)) {
            dockerData = fresh;
            dockerLoaded = true;
          }
        }
        if (res.message) noticeText = res.message;
      } else {
        noticeText = res?.error || res?.message || 'Не удалось выполнить действие Docker.';
      }
    } catch (err) {
      if (document.body.contains(backdrop)) {
        noticeText = err?.message || 'Ошибка при обращении к Docker.';
      }
    } finally {
      pendingDockerOps.delete(opKey);
      if (document.body.contains(backdrop)) {
        renderModal();
        if (openNomadStackId) renderNomadPackModal();
      }
    }
  }

  function matchesDockerStack(stack, q) {
    if (!q) return true;
    const hay = [
      stack.name,
      stack.description,
      stack.id,
      stack.port ? String(stack.port) : '',
      ...(Array.isArray(stack.containers) ? stack.containers : []),
    ].join(' ').toLowerCase();
    if (hay.includes(q)) return true;
    if (Array.isArray(stack.subItems)) {
      return stack.subItems.some((sub) => [
        sub.name,
        sub.description,
        sub.id,
        sub.container,
        sub.port ? String(sub.port) : '',
      ].join(' ').toLowerCase().includes(q));
    }
    return false;
  }

  function buildDockerConfirmBar(conf, { insideSubmodal = false } = {}) {
    const barEl = document.createElement('div');
    barEl.className = 'slash-docker-confirm';

    const textEl = document.createElement('span');
    textEl.className = 'slash-docker-confirm__text';
    textEl.textContent = conf.message || `Остановить ${conf.name}?`;

    const actions = document.createElement('div');
    actions.className = 'slash-docker-confirm__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'slash-docker-btn';
    cancelBtn.textContent = 'Отмена';
    cancelBtn.addEventListener('click', () => {
      dockerConfirmStop = null;
      if (insideSubmodal) renderNomadPackModal();
      renderModal();
    });

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'slash-docker-btn slash-docker-btn--danger';
    stopBtn.textContent = 'Остановить';
    stopBtn.addEventListener('click', () => {
      handleDockerAction({
        host: conf.host,
        stackId: conf.stackId,
        container: conf.container || undefined,
        action: 'stop',
        confirm: true,
        label: conf.name,
      });
    });

    actions.append(cancelBtn, stopBtn);
    barEl.append(textEl, actions);
    return barEl;
  }

  function renderNomadPackModal() {
    if (!openNomadStackId) {
      closeNomadPackModal();
      return;
    }
    const stack = findDockerStack('lenovo', openNomadStackId) || findDockerStack('pc', openNomadStackId);
    if (!stack) {
      closeNomadPackModal();
      return;
    }

    if (!nomadSubmodalBackdrop) {
      nomadSubmodalBackdrop = document.createElement('div');
      nomadSubmodalBackdrop.className = 'slash-docker-submodal-backdrop';
      nomadSubmodalBackdrop.setAttribute('role', 'dialog');
      nomadSubmodalBackdrop.setAttribute('aria-modal', 'true');
      nomadSubmodalBackdrop.setAttribute('aria-label', stack.name || 'Пакет NOMAD');
      nomadSubmodalBackdrop.addEventListener('mousedown', (e) => {
        if (e.target === nomadSubmodalBackdrop) closeNomadPackModal();
      });
      document.body.appendChild(nomadSubmodalBackdrop);
    }

    const subItems = Array.isArray(stack.subItems) ? stack.subItems : [];
    const runningSubs = subItems.filter((s) => s.running).length;
    const totalMem = subItems.reduce((acc, s) => acc + (s.running ? (Number(s.memMb) || 0) : 0), 0);
    const hostKey = stack.host || 'lenovo';
    const hostOnline = Boolean(dockerData?.[hostKey]?.online);

    const dialog = document.createElement('div');
    dialog.className = 'slash-docker-submodal';

    const head = document.createElement('div');
    head.className = 'slash-docker-submodal__head';

    const copy = document.createElement('div');
    copy.className = 'slash-docker-submodal__copy';

    const titleRow = document.createElement('div');
    titleRow.className = 'slash-docker-submodal__title-row';

    const title = document.createElement('h3');
    title.className = 'slash-docker-submodal__title';
    title.textContent = stack.name || `Пакет NOMAD (${subItems.length})`;

    const summaryPill = document.createElement('span');
    summaryPill.className = 'slash-docker-pill';
    summaryPill.textContent = `${runningSubs} / ${subItems.length} работает · ${formatDockerMem(totalMem || stack.memMb)}`;

    titleRow.append(title, summaryPill);

    const subtitle = document.createElement('p');
    subtitle.className = 'slash-docker-submodal__subtitle';
    subtitle.textContent = 'Отдельное управление сервисами пакета NOMAD на сервере .107';

    copy.append(titleRow, subtitle);

    const headActions = document.createElement('div');
    headActions.className = 'slash-docker-submodal__actions';

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'slash-docker-btn slash-docker-btn--icon';
    refreshBtn.title = 'Обновить статус';
    refreshBtn.setAttribute('aria-label', 'Обновить статус пакета NOMAD');
    refreshBtn.disabled = dockerRefreshing || dockerLoading;
    refreshBtn.appendChild(createIconSvg('refresh', 15));
    refreshBtn.addEventListener('click', () => loadDockerStatus({ refresh: true }));

    const closeSubBtn = document.createElement('button');
    closeSubBtn.type = 'button';
    closeSubBtn.className = 'slash-catalog__close';
    closeSubBtn.title = 'Закрыть';
    closeSubBtn.setAttribute('aria-label', 'Закрыть окно пакета NOMAD');
    closeSubBtn.appendChild(createIconSvg('close', 18));
    closeSubBtn.addEventListener('click', closeNomadPackModal);

    headActions.append(refreshBtn, closeSubBtn);
    head.append(copy, headActions);

    const listWrap = document.createElement('div');
    listWrap.className = 'slash-docker-submodal__body';

    if (noticeText) {
      const subNotice = document.createElement('p');
      subNotice.className = 'slash-catalog__notice';
      subNotice.textContent = noticeText;
      listWrap.appendChild(subNotice);
    }

    for (const sub of subItems) {
      const opKey = dockerOpKey(hostKey, stack.id, sub.container);
      const isBusy = pendingDockerOps.has(opKey) || pendingDockerOps.has(dockerOpKey(hostKey, stack.id, ''));
      const isConfirming = Boolean(
        dockerConfirmStop
        && dockerConfirmStop.host === hostKey
        && dockerConfirmStop.stackId === stack.id
        && dockerConfirmStop.container === sub.container,
      );

      const card = document.createElement('div');
      card.className = 'slash-docker-subrow';

      const inner = document.createElement('div');
      inner.className = 'slash-docker-subrow__inner';

      const main = document.createElement('div');
      main.className = 'slash-docker-subrow__main';

      const topLine = document.createElement('div');
      topLine.className = 'slash-docker-subrow__top';

      const dot = document.createElement('span');
      dot.className = `slash-status-dot ${sub.running ? 'is-connected' : 'is-paused'}`;

      const nameEl = document.createElement('span');
      nameEl.className = 'slash-docker-subrow__name';
      nameEl.textContent = sub.name || sub.container;

      topLine.append(dot, nameEl);
      if (sub.port) {
        const portEl = document.createElement('span');
        portEl.className = 'slash-docker-subrow__port';
        portEl.textContent = `:${sub.port}`;
        topLine.appendChild(portEl);
      }

      main.appendChild(topLine);
      if (sub.description) {
        const descEl = document.createElement('span');
        descEl.className = 'slash-docker-subrow__desc';
        descEl.textContent = sub.description;
        main.appendChild(descEl);
      }

      const controls = document.createElement('div');
      controls.className = 'slash-docker-item__controls';

      const statPill = document.createElement('span');
      statPill.className = `slash-docker-pill slash-docker-pill--stat${sub.running ? '' : ' slash-docker-pill--off'}`;
      statPill.textContent = isBusy ? 'Выполняю…' : formatDockerStackStat(sub.memMb, sub.cpuPct, sub.running);
      controls.appendChild(statPill);

      if (sub.running && sub.url) {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'slash-docker-btn';
        openBtn.append(createIconSvg('external', 13), document.createTextNode('Открыть'));
        openBtn.addEventListener('click', () => openExternalUrl(sub.url));
        controls.appendChild(openBtn);
      }

      const restartBtn = document.createElement('button');
      restartBtn.type = 'button';
      restartBtn.className = 'slash-docker-btn slash-docker-btn--icon';
      restartBtn.title = `Перезапустить ${sub.name || sub.container}`;
      restartBtn.setAttribute('aria-label', `Перезапустить ${sub.name || sub.container}`);
      restartBtn.disabled = isBusy || !hostOnline;
      restartBtn.appendChild(createIconSvg('refresh', 14));
      restartBtn.addEventListener('click', () => {
        handleDockerAction({
          host: hostKey,
          stackId: stack.id,
          container: sub.container,
          action: 'restart',
          label: sub.name || sub.container,
        });
      });
      controls.appendChild(restartBtn);

      const sw = createToggleSwitch(Boolean(sub.running), {
        label: `${sub.running ? 'Выключить' : 'Включить'} ${sub.name || sub.container}`,
        disabled: isBusy || !hostOnline,
        onToggle: () => {
          handleDockerAction({
            host: hostKey,
            stackId: stack.id,
            container: sub.container,
            action: sub.running ? 'stop' : 'start',
            label: sub.name || sub.container,
          });
        },
      });
      controls.appendChild(sw);

      inner.append(main, controls);
      card.appendChild(inner);

      if (isConfirming) {
        card.appendChild(buildDockerConfirmBar(dockerConfirmStop, { insideSubmodal: true }));
      }

      listWrap.appendChild(card);
    }

    dialog.append(head, listWrap);
    nomadSubmodalBackdrop.replaceChildren(dialog);
  }

  function openNomadPackModal(stackId) {
    openNomadStackId = stackId;
    renderNomadPackModal();
  }

  function buildDockerStackItem(stack, hostKey, hostOnline) {
    const opKey = dockerOpKey(hostKey, stack.id, '');
    const isBusy = pendingDockerOps.has(opKey);
    const isConfirming = Boolean(
      dockerConfirmStop
      && dockerConfirmStop.host === hostKey
      && dockerConfirmStop.stackId === stack.id
      && !dockerConfirmStop.container,
    );
    const isPartial = stack.running && stack.totalCount > 1 && stack.runningCount < stack.totalCount;

    const itemEl = document.createElement('div');
    itemEl.className = `slash-docker-item${stack.running ? '' : ' is-stopped'}${isConfirming ? ' is-confirming' : ''}`;
    itemEl.dataset.stackId = stack.id;

    const row = document.createElement('div');
    row.className = 'slash-docker-row';

    const iconWrap = document.createElement('span');
    iconWrap.className = 'slash-docker-item__icon';
    iconWrap.appendChild(createIconSvg(dockerStackIconName(stack), 17));

    const main = document.createElement('div');
    main.className = 'slash-docker-item__main';

    const topLine = document.createElement('div');
    topLine.className = 'slash-docker-item__top';

    const dot = document.createElement('span');
    dot.className = `slash-status-dot ${stack.running ? (isPartial ? 'is-auth' : 'is-connected') : 'is-paused'}`;

    const nameEl = document.createElement('span');
    nameEl.className = 'slash-docker-item__name';
    nameEl.textContent = stack.name || stack.id;

    topLine.append(dot, nameEl);

    if (stack.alwaysOn) {
      const alwaysPill = document.createElement('span');
      alwaysPill.className = 'slash-docker-pill slash-docker-pill--always';
      alwaysPill.textContent = '24/7';
      topLine.appendChild(alwaysPill);
    }

    if (stack.totalCount > 1) {
      const cntPill = document.createElement('span');
      cntPill.className = 'slash-docker-pill slash-docker-pill--quiet';
      cntPill.textContent = `${stack.runningCount}/${stack.totalCount}`;
      topLine.appendChild(cntPill);
    }

    main.appendChild(topLine);
    if (stack.description) {
      const descEl = document.createElement('span');
      descEl.className = 'slash-docker-item__desc';
      descEl.textContent = stack.description;
      main.appendChild(descEl);
    }

    const controls = document.createElement('div');
    controls.className = 'slash-docker-item__controls';

    const statPill = document.createElement('span');
    statPill.className = `slash-docker-pill slash-docker-pill--stat${stack.running ? '' : ' slash-docker-pill--off'}`;
    statPill.textContent = isBusy ? 'Выполняю…' : formatDockerStackStat(stack.memMb, stack.cpuPct, stack.running);
    controls.appendChild(statPill);

    if (stack.expandable && Array.isArray(stack.subItems) && stack.subItems.length) {
      const packBtn = document.createElement('button');
      packBtn.type = 'button';
      packBtn.className = 'slash-docker-btn slash-docker-btn--pack';
      packBtn.append(
        createIconSvg('layers', 14),
        document.createTextNode(`Открыть пакет (${stack.subItems.length})`),
      );
      packBtn.addEventListener('click', () => openNomadPackModal(stack.id));
      controls.appendChild(packBtn);
    } else if (stack.running && stack.url) {
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'slash-docker-btn';
      openBtn.append(createIconSvg('external', 13), document.createTextNode('Открыть'));
      openBtn.addEventListener('click', () => openExternalUrl(stack.url));
      controls.appendChild(openBtn);
    }

    const restartBtn = document.createElement('button');
    restartBtn.type = 'button';
    restartBtn.className = 'slash-docker-btn slash-docker-btn--icon';
    restartBtn.title = `Перезапустить ${stack.name || stack.id}`;
    restartBtn.setAttribute('aria-label', `Перезапустить ${stack.name || stack.id}`);
    restartBtn.disabled = isBusy || !hostOnline;
    restartBtn.appendChild(createIconSvg('refresh', 14));
    restartBtn.addEventListener('click', () => {
      handleDockerAction({
        host: hostKey,
        stackId: stack.id,
        action: 'restart',
        label: stack.name || stack.id,
      });
    });
    controls.appendChild(restartBtn);

    const sw = createToggleSwitch(Boolean(stack.running), {
      label: `${stack.running ? 'Выключить' : 'Включить'} ${stack.name || stack.id}`,
      disabled: isBusy || !hostOnline,
      onToggle: () => {
        handleDockerAction({
          host: hostKey,
          stackId: stack.id,
          action: stack.running ? 'stop' : 'start',
          label: stack.name || stack.id,
        });
      },
    });
    controls.appendChild(sw);

    row.append(iconWrap, main, controls);
    itemEl.appendChild(row);

    if (isConfirming) {
      itemEl.appendChild(buildDockerConfirmBar(dockerConfirmStop));
    }

    return itemEl;
  }

  function buildDockerServerBlock(hostKey, titleText, iconName, hostData, q) {
    const allStacks = Array.isArray(hostData?.stacks) ? hostData.stacks : [];
    const filtered = q ? allStacks.filter((st) => matchesDockerStack(st, q)) : allStacks;
    if (q && !filtered.length) return null;

    const section = document.createElement('section');
    section.className = 'slash-docker-server';
    section.dataset.dockerHost = hostKey;

    const head = document.createElement('div');
    head.className = 'slash-docker-server__head';

    const meta = document.createElement('div');
    meta.className = 'slash-docker-server__meta';

    const titleRow = document.createElement('div');
    titleRow.className = 'slash-docker-server__title-row';

    const dot = document.createElement('span');
    dot.className = `slash-status-dot ${hostData?.online ? 'is-connected' : (dockerLoading ? 'is-auth' : 'is-offline')}`;

    const icon = document.createElement('span');
    icon.className = 'slash-docker-server__icon';
    icon.appendChild(createIconSvg(iconName, 18));

    const h3 = document.createElement('h3');
    h3.className = 'slash-docker-server__title';
    h3.textContent = titleText;

    const countPill = document.createElement('span');
    countPill.className = 'slash-docker-server__count';
    countPill.textContent = hostData?.online
      ? `${hostData.runningCount} / ${hostData.totalCount} работает`
      : (dockerLoading ? 'Загрузка…' : 'Нет связи');

    titleRow.append(dot, icon, h3, countPill);

    const metrics = document.createElement('div');
    metrics.className = 'slash-docker-server__metrics';

    const contPill = document.createElement('span');
    contPill.className = 'slash-docker-pill slash-docker-pill--stat';
    contPill.textContent = `Контейнеры: ${formatDockerMem(hostData?.totalContainerMb || 0)}`;
    metrics.appendChild(contPill);

    const memInfo = formatHostMetric(hostData?.hostMem, 'RAM', { warnPct: 85 });
    if (memInfo) {
      const p = document.createElement('span');
      p.className = `slash-docker-pill slash-docker-pill--stat${memInfo.warn ? ' is-warn' : ''}`;
      p.textContent = memInfo.text;
      metrics.appendChild(p);
    }

    const swapInfo = formatHostMetric(hostData?.hostSwap, 'Swap', { warnPct: 50, isSwap: true });
    if (swapInfo) {
      const p = document.createElement('span');
      p.className = `slash-docker-pill slash-docker-pill--stat${swapInfo.warn ? ' is-warn' : ''}`;
      p.textContent = swapInfo.text;
      metrics.appendChild(p);
    }

    const diskInfo = formatHostMetric(hostData?.hostDisk, 'Диск', { warnPct: 85 });
    if (diskInfo) {
      const p = document.createElement('span');
      p.className = `slash-docker-pill slash-docker-pill--stat${diskInfo.warn ? ' is-warn' : ''}`;
      p.textContent = diskInfo.text;
      metrics.appendChild(p);
    }

    meta.append(titleRow, metrics);

    const actions = document.createElement('div');
    actions.className = 'slash-docker-server__actions';

    if (hostKey === 'lenovo') {
      const kumaStack = allStacks.find((s) => s.id === 'srv-kuma');
      const kumaUrl = kumaStack?.url || 'http://192.168.0.107:3001';
      const kumaBtn = document.createElement('button');
      kumaBtn.type = 'button';
      kumaBtn.className = 'slash-docker-btn';
      kumaBtn.title = 'Открыть Uptime Kuma (:3001)';
      kumaBtn.append(createIconSvg('external', 13), document.createTextNode('Uptime Kuma'));
      kumaBtn.addEventListener('click', () => openExternalUrl(kumaUrl));
      actions.appendChild(kumaBtn);
    }

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'slash-docker-btn slash-docker-btn--icon';
    refreshBtn.title = `Обновить ${titleText}`;
    refreshBtn.setAttribute('aria-label', `Обновить ${titleText}`);
    refreshBtn.disabled = dockerRefreshing || dockerLoading;
    refreshBtn.appendChild(createIconSvg('refresh', 14));
    refreshBtn.addEventListener('click', () => loadDockerStatus({ refresh: true }));
    actions.appendChild(refreshBtn);

    head.append(meta, actions);
    section.appendChild(head);

    if (hostData?.error && !hostData?.online && !dockerLoading) {
      const errEl = document.createElement('p');
      errEl.className = 'slash-docker-server__error';
      errEl.textContent = hostData.error;
      section.appendChild(errEl);
    }

    const list = document.createElement('div');
    list.className = 'slash-docker-list';
    for (const stack of filtered) {
      list.appendChild(buildDockerStackItem(stack, hostKey, Boolean(hostData?.online)));
    }
    section.appendChild(list);

    return section;
  }

  function renderModal() {
    renderTabs();
    const sections = catalog.sections || [];
    const sec = sections.find((s) => s.id === activeTab) || sections[0];
    if (!sec) return;

    const q = searchQuery.trim().toLowerCase();
    const heroInfo = CATALOG_HERO[sec.id] || { title: sec.title, subtitle: '' };

    const frag = document.createDocumentFragment();

    const hero = document.createElement('div');
    hero.className = 'slash-catalog__hero';

    if (sec.id === 'skills') {
      const heroRow = document.createElement('div');
      heroRow.className = 'slash-catalog__hero-row';

      const copy = document.createElement('div');
      copy.className = 'slash-catalog__hero-copy';
      const h2 = document.createElement('h2');
      h2.className = 'slash-catalog__title';
      h2.textContent = heroInfo.title;
      const sub = document.createElement('p');
      sub.className = 'slash-catalog__subtitle';
      sub.textContent = heroInfo.subtitle;
      copy.append(h2, sub);

      const actions = document.createElement('div');
      actions.className = 'slash-catalog__hero-actions';

      const createBtn = document.createElement('button');
      createBtn.type = 'button';
      createBtn.className = `slash-catalog__action-btn${activeForm === 'create' ? ' is-active' : ''}`;
      createBtn.append(createIconSvg('plus', 16), document.createTextNode('Создать навык'));
      createBtn.addEventListener('click', () => {
        activeForm = activeForm === 'create' ? null : 'create';
        plusPanelOpen = false;
        formError = '';
        renderModal();
      });

      const installBtn = document.createElement('button');
      installBtn.type = 'button';
      installBtn.className = `slash-catalog__action-btn${activeForm === 'install' ? ' is-active' : ''}`;
      installBtn.append(createIconSvg('download', 16), document.createTextNode('Установить'));
      installBtn.addEventListener('click', () => {
        activeForm = activeForm === 'install' ? null : 'install';
        plusPanelOpen = false;
        formError = '';
        installDraft.preview = null;
        renderModal();
      });

      const reloadBtn = document.createElement('button');
      reloadBtn.type = 'button';
      reloadBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--icon';
      reloadBtn.setAttribute('aria-label', 'Обновить список навыков');
      reloadBtn.title = 'Обновить список навыков';
      reloadBtn.disabled = reloadingSkills;
      reloadBtn.appendChild(createIconSvg('refresh', 16));
      reloadBtn.addEventListener('click', handleReloadSkills);

      actions.append(createBtn, installBtn, reloadBtn);
      heroRow.append(copy, actions);
      hero.appendChild(heroRow);
    } else if (sec.id === 'plugins') {
      const heroRow = document.createElement('div');
      heroRow.className = 'slash-catalog__hero-row';

      const copy = document.createElement('div');
      copy.className = 'slash-catalog__hero-copy';
      const h2 = document.createElement('h2');
      h2.className = 'slash-catalog__title';
      h2.textContent = heroInfo.title;
      const sub = document.createElement('p');
      sub.className = 'slash-catalog__subtitle';
      sub.textContent = heroInfo.subtitle;
      copy.append(h2, sub);

      const actions = document.createElement('div');
      actions.className = 'slash-catalog__hero-actions';

      const createBtn = document.createElement('button');
      createBtn.type = 'button';
      createBtn.className = `slash-catalog__action-btn${activeForm === 'plugin-create' ? ' is-active' : ''}`;
      createBtn.append(createIconSvg('plus', 16), document.createTextNode('Создать плагин'));
      createBtn.addEventListener('click', () => {
        activeForm = activeForm === 'plugin-create' ? null : 'plugin-create';
        plusPanelOpen = false;
        formError = '';
        renderModal();
      });

      const installBtn = document.createElement('button');
      installBtn.type = 'button';
      installBtn.className = `slash-catalog__action-btn${activeForm === 'plugin-install' ? ' is-active' : ''}`;
      installBtn.append(createIconSvg('download', 16), document.createTextNode('Установить'));
      installBtn.addEventListener('click', () => {
        activeForm = activeForm === 'plugin-install' ? null : 'plugin-install';
        plusPanelOpen = false;
        formError = '';
        pluginInstallDraft.preview = null;
        renderModal();
      });

      const reloadBtn = document.createElement('button');
      reloadBtn.type = 'button';
      reloadBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--icon';
      reloadBtn.setAttribute('aria-label', 'Обновить список плагинов');
      reloadBtn.title = 'Обновить список плагинов';
      reloadBtn.disabled = reloadingPlugins;
      reloadBtn.appendChild(createIconSvg('refresh', 16));
      reloadBtn.addEventListener('click', handleReloadPlugins);

      actions.append(createBtn, installBtn, reloadBtn);
      heroRow.append(copy, actions);
      hero.appendChild(heroRow);
    } else if (sec.id === 'connectors') {
      const heroRow = document.createElement('div');
      heroRow.className = 'slash-catalog__hero-row';

      const copy = document.createElement('div');
      copy.className = 'slash-catalog__hero-copy';
      const h2 = document.createElement('h2');
      h2.className = 'slash-catalog__title';
      h2.textContent = heroInfo.title;
      const sub = document.createElement('p');
      sub.className = 'slash-catalog__subtitle';
      sub.textContent = heroInfo.subtitle;
      copy.append(h2, sub);

      const actions = document.createElement('div');
      actions.className = 'slash-catalog__hero-actions';

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = `slash-catalog__action-btn${activeForm === 'connector-add' ? ' is-active' : ''}`;
      addBtn.append(createIconSvg('plus', 16), document.createTextNode('Добавить MCP'));
      addBtn.addEventListener('click', () => {
        activeForm = activeForm === 'connector-add' ? null : 'connector-add';
        plusPanelOpen = false;
        formError = '';
        connectorAddDraft.preview = null;
        connectorAddDraft.previewMessage = '';
        renderModal();
      });

      const checkAllBtn = document.createElement('button');
      checkAllBtn.type = 'button';
      checkAllBtn.className = 'slash-catalog__action-btn';
      checkAllBtn.disabled = checkingAllConnectors || reloadingConnectors;
      checkAllBtn.append(
        createIconSvg('check', 16),
        document.createTextNode(checkingAllConnectors ? 'Проверяю…' : 'Проверить все'),
      );
      checkAllBtn.addEventListener('click', () => handleConnectorCheck(null));

      const reloadBtn = document.createElement('button');
      reloadBtn.type = 'button';
      reloadBtn.className = 'slash-catalog__action-btn slash-catalog__action-btn--icon';
      reloadBtn.setAttribute('aria-label', 'Обновить список коннекторов');
      reloadBtn.title = 'Обновить список коннекторов';
      reloadBtn.disabled = reloadingConnectors || checkingAllConnectors;
      reloadBtn.appendChild(createIconSvg('refresh', 16));
      reloadBtn.addEventListener('click', handleReloadConnectors);

      actions.append(addBtn, checkAllBtn, reloadBtn);
      heroRow.append(copy, actions);
      hero.appendChild(heroRow);
    } else if (sec.id === 'docker') {
      const heroRow = document.createElement('div');
      heroRow.className = 'slash-catalog__hero-row';

      const copy = document.createElement('div');
      copy.className = 'slash-catalog__hero-copy';
      const h2 = document.createElement('h2');
      h2.className = 'slash-catalog__title';
      h2.textContent = heroInfo.title;
      const sub = document.createElement('p');
      sub.className = 'slash-catalog__subtitle';
      sub.textContent = heroInfo.subtitle;
      copy.append(h2, sub);

      const actions = document.createElement('div');
      actions.className = 'slash-catalog__hero-actions';

      const refreshAllBtn = document.createElement('button');
      refreshAllBtn.type = 'button';
      refreshAllBtn.className = 'slash-catalog__action-btn';
      refreshAllBtn.disabled = dockerRefreshing || dockerLoading;
      refreshAllBtn.append(
        createIconSvg('refresh', 16),
        document.createTextNode(dockerRefreshing || dockerLoading ? 'Обновляю…' : 'Обновить'),
      );
      refreshAllBtn.addEventListener('click', () => loadDockerStatus({ refresh: true }));

      actions.appendChild(refreshAllBtn);
      heroRow.append(copy, actions);
      hero.appendChild(heroRow);
    } else {
      const h2 = document.createElement('h2');
      h2.className = 'slash-catalog__title';
      h2.textContent = heroInfo.title;
      const sub = document.createElement('p');
      sub.className = 'slash-catalog__subtitle';
      sub.textContent = heroInfo.subtitle;
      hero.append(h2, sub);
    }
    frag.appendChild(hero);

    if (sec.id === 'skills') {
      frag.appendChild(buildBudgetBar());
    } else if (sec.id === 'plugins') {
      frag.appendChild(buildPluginsStatsBar());
    } else if (sec.id === 'connectors') {
      frag.appendChild(buildConnectorsStatsBar());
    }

    if (noticeText) {
      const notice = document.createElement('p');
      notice.className = 'slash-catalog__notice';
      notice.textContent = noticeText;
      frag.appendChild(notice);
    }

    if (sec.id === 'skills' && activeForm === 'create') {
      frag.appendChild(buildCreateSkillForm());
    } else if (sec.id === 'skills' && activeForm === 'install') {
      frag.appendChild(buildInstallSkillForm());
    } else if (sec.id === 'plugins' && activeForm === 'plugin-create') {
      frag.appendChild(buildCreatePluginForm());
    } else if (sec.id === 'plugins' && activeForm === 'plugin-install') {
      frag.appendChild(buildInstallPluginForm());
    } else if (sec.id === 'plugins' && activeForm === 'hookify-add') {
      frag.appendChild(buildHookifyAddForm({ inline: false }));
    } else if (sec.id === 'connectors' && activeForm === 'connector-add') {
      frag.appendChild(buildAddConnectorForm());
    }

    if (sec.id === 'docker') {
      const serversWrap = document.createElement('div');
      serversWrap.className = 'slash-docker-servers';

      const pcBlock = buildDockerServerBlock('pc', 'Docker на ПК', 'monitor', dockerData.pc, q);
      const lenovoBlock = buildDockerServerBlock('lenovo', 'Docker на старом ноуте (.107)', 'server', dockerData.lenovo, q);

      if (pcBlock) serversWrap.appendChild(pcBlock);
      if (lenovoBlock) serversWrap.appendChild(lenovoBlock);

      if (serversWrap.childElementCount) {
        frag.appendChild(serversWrap);
      } else {
        const empty = document.createElement('div');
        empty.className = 'slash-catalog__empty';
        empty.textContent = q ? 'По запросу контейнеры Docker не нашлись.' : 'Контейнеры Docker не найдены.';
        frag.appendChild(empty);
      }

      body.replaceChildren(frag);
      return;
    }

    if (sec.id === 'connectors') {
      const cats = Array.isArray(connectorsData.categories) && connectorsData.categories.length
        ? connectorsData.categories
        : groupByCategories(connectorsData.items || [], CONNECTOR_CATEGORIES);
      let renderedCount = 0;
      for (const cat of cats) {
        let items = Array.isArray(cat.items) ? cat.items : [];
        if (q) {
          const catMatch = (cat.title || '').toLowerCase().includes(q) || (cat.id || '').toLowerCase().includes(q);
          items = items
            .map((it) => ({ it, score: catMatch ? Math.max(15, scoreItem(it, q)) : scoreItem(it, q) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((x) => x.it);
        }
        if (!items.length) continue;
        renderedCount += items.length;
        const hasFocused = Boolean(pendingFocusConnectorId && items.some((it) => it.id === pendingFocusConnectorId));
        frag.appendChild(
          buildCollapsibleGroup(`connectors:${cat.id}`, cat.title, items, buildConnectorCard, Boolean(q) || hasFocused),
        );
      }
      if (!renderedCount) {
        const empty = document.createElement('div');
        empty.className = 'slash-catalog__empty';
        empty.textContent = q ? 'По запросу коннекторы не нашлись.' : 'Коннекторов пока нет.';
        frag.appendChild(empty);
      }
      body.replaceChildren(frag);
      if (pendingFocusConnectorId) {
        const targetCard = Array.from(body.querySelectorAll('.slash-connector-card'))
          .find((el) => el.dataset.connectorId === pendingFocusConnectorId);
        if (targetCard) {
          targetCard.scrollIntoView({ block: 'nearest' });
          pendingFocusConnectorId = null;
        }
      }
      return;
    }

    if (sec.id === 'plugins') {
      const cats = Array.isArray(pluginsData.categories) && pluginsData.categories.length
        ? pluginsData.categories
        : groupByCategories(pluginsData.items || [], PLUGIN_CATEGORIES);
      let renderedCount = 0;
      for (const cat of cats) {
        let items = Array.isArray(cat.items) ? cat.items : [];
        if (q) {
          const catMatch = (cat.title || '').toLowerCase().includes(q) || (cat.id || '').toLowerCase().includes(q);
          items = items
            .map((it) => ({ it, score: catMatch ? Math.max(15, scoreItem(it, q)) : scoreItem(it, q) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((x) => x.it);
        }
        if (!items.length) continue;
        renderedCount += items.length;
        const hasFocused = Boolean(pendingFocusPluginId && items.some((it) => it.id === pendingFocusPluginId));
        frag.appendChild(
          buildCollapsibleGroup(`plugins:${cat.id}`, cat.title, items, buildPluginCard, Boolean(q) || hasFocused),
        );
      }
      if (!renderedCount) {
        const empty = document.createElement('div');
        empty.className = 'slash-catalog__empty';
        empty.textContent = q ? 'По запросу плагины не нашлись.' : 'Плагинов пока нет.';
        frag.appendChild(empty);
      }
      body.replaceChildren(frag);
      if (pendingFocusPluginId) {
        const targetCard = Array.from(body.querySelectorAll('.slash-plugin-card'))
          .find((el) => el.dataset.pluginId === pendingFocusPluginId);
        if (targetCard) {
          targetCard.scrollIntoView({ block: 'nearest' });
          pendingFocusPluginId = null;
        }
      }
      return;
    }

    if (sec.id === 'skills') {
      const cats = Array.isArray(skillsData.categories) && skillsData.categories.length
        ? skillsData.categories
        : groupByCategories(skillsData.items || [], SKILL_CATEGORIES);
      let renderedCount = 0;
      for (const cat of cats) {
        let items = Array.isArray(cat.items) ? cat.items : [];
        if (q) {
          const catMatch = (cat.title || '').toLowerCase().includes(q) || (cat.id || '').toLowerCase().includes(q);
          items = items
            .map((it) => ({ it, score: catMatch ? Math.max(15, scoreItem(it, q)) : scoreItem(it, q) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((x) => x.it);
        }
        if (!items.length) continue;
        renderedCount += items.length;
        frag.appendChild(
          buildCollapsibleGroup(`skills:${cat.id}`, cat.title, items, buildSkillRow, Boolean(q)),
        );
      }
      if (!renderedCount) {
        const empty = document.createElement('div');
        empty.className = 'slash-catalog__empty';
        empty.textContent = q ? 'По запросу навыки не нашлись.' : 'Навыков пока нет.';
        frag.appendChild(empty);
      }
      body.replaceChildren(frag);
      return;
    }

    if (sec.id === 'commands') {
      let items = Array.isArray(sec.items) ? sec.items : [];
      if (q) {
        items = items
          .map((it) => ({ it, score: scoreItem(it, q) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((x) => x.it);
      }
      const groups = groupByCategories(items, COMMAND_CATEGORIES);
      if (groups.length) {
        for (const g of groups) {
          frag.appendChild(
            buildCollapsibleGroup(`commands:${g.id}`, g.title, g.items, (it) => buildCatalogItem(it, sec.stage), Boolean(q)),
          );
        }
      } else {
        const empty = document.createElement('div');
        empty.className = 'slash-catalog__empty';
        empty.textContent = q ? 'По запросу команды не нашлись.' : 'В этом разделе пока пусто.';
        frag.appendChild(empty);
      }
      body.replaceChildren(frag);
      return;
    }

    // Draft / future sections (plugins, connectors, styles)
    let items = Array.isArray(sec.items) ? sec.items : [];
    if (q) {
      items = items
        .map((it) => ({ it, score: scoreItem(it, q) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.it);
    }

    const installed = items.filter((it) => it.kind !== 'draft');
    const upcoming = items.filter((it) => it.kind === 'draft');

    if (installed.length) {
      const group = document.createElement('section');
      group.className = 'slash-catalog__group';
      const head = document.createElement('div');
      head.className = 'slash-catalog__group-head';
      const title = document.createElement('h3');
      title.className = 'slash-catalog__group-title';
      title.textContent = `Установлено (${installed.length})`;
      head.appendChild(title);
      const list = document.createElement('div');
      list.className = 'slash-catalog__list';
      for (const it of installed) list.appendChild(buildCatalogItem(it, sec.stage));
      group.append(head, list);
      frag.appendChild(group);
    }

    if (upcoming.length) {
      const group = document.createElement('section');
      group.className = 'slash-catalog__group';
      const head = document.createElement('div');
      head.className = 'slash-catalog__group-head';
      const title = document.createElement('h3');
      title.className = 'slash-catalog__group-title';
      title.textContent = sec.stage ? `Доступно / Скоро (Этап ${sec.stage})` : 'Доступно / Скоро';
      head.appendChild(title);
      const list = document.createElement('div');
      list.className = 'slash-catalog__list';
      for (const it of upcoming) list.appendChild(buildCatalogItem(it, sec.stage));
      group.append(head, list);
      frag.appendChild(group);
    }

    if (!installed.length && !upcoming.length) {
      const empty = document.createElement('div');
      empty.className = 'slash-catalog__empty';
      empty.textContent = q ? 'По запросу ничего не нашлось.' : 'В этом разделе пока пусто.';
      frag.appendChild(empty);
    }

    body.replaceChildren(frag);
  }

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderModal();
  });

  renderModal();
  searchInput.focus();

  if (activeTab === 'docker') {
    loadDockerStatus({ refresh: false });
  }

  const [liveCatalog, liveSkills, livePlugins, liveConnectors] = await Promise.all([
    fetchCatalog(ctx),
    fetchSkills(ctx, catalog.sections.find((s) => s.id === 'skills')?.items || []),
    fetchPlugins(ctx, catalog.sections.find((s) => s.id === 'plugins')?.items || FALLBACK_PLUGINS),
    fetchConnectors(ctx, { fallbackItems: catalog.sections.find((s) => s.id === 'connectors')?.items || FALLBACK_CONNECTORS }),
  ]);
  if (document.body.contains(backdrop)) {
    catalog = liveCatalog;
    skillsData = liveSkills;
    pluginsData = livePlugins;
    connectorsData = liveConnectors;
    syncSkillsIntoCatalog();
    syncPluginsIntoCatalog();
    syncConnectorsIntoCatalog();
    ensureDockerSectionInCatalog();
    renderModal();
  }
}

// ---------------------------------------------------------------- shared catalog target registry

const catalogTargets = new Map();

export function registerCatalogTarget(tabName, handler) {
  catalogTargets.set(tabName, handler);
}

export function openActiveCatalog(initialTab = 'commands', opts = {}) {
  const agentsPlate = document.querySelector('.hud__plate[data-tab="agents"]');
  const activeTab = agentsPlate && !agentsPlate.hidden ? 'agents' : 'chats';
  const target = catalogTargets.get(activeTab) || catalogTargets.get('chats') || catalogTargets.get('agents');
  if (!target) {
    openCatalogModal({
      initialTab,
      focusPluginId: opts?.focusPluginId || null,
      focusConnectorId: opts?.focusConnectorId || null,
    });
    return;
  }
  openCatalogModal({
    initialTab,
    focusPluginId: opts?.focusPluginId || null,
    focusConnectorId: opts?.focusConnectorId || null,
    getContext: target.getContext,
    onRunCommand: target.onRunCommand,
    onSkillsChanged: target.onSkillsChanged,
    onPluginsChanged: target.onPluginsChanged,
    onConnectorsChanged: target.onConnectorsChanged,
  });
}

// ---------------------------------------------------------------- 2-way '+' menu quick-skill sync

export function bindQuickSkillToggles({ root, triggerBtn, getContext, onChanged } = {}) {
  const buttons = root ? Array.from(root.querySelectorAll('[data-quick-skill]')) : [];
  if (!buttons.length) {
    return { sync: async () => {}, applyData: () => {} };
  }

  const pending = new Set();

  function applyData(skillsData) {
    if (!skillsData) return;
    const list = Array.isArray(skillsData.items)
      ? skillsData.items
      : (Array.isArray(skillsData.categories) ? skillsData.categories.flatMap((c) => c.items || []) : []);
    if (!list.length) return;
    const byId = new Map(list.map((s) => [s.id || s.name, s]));

    for (const btn of buttons) {
      const id = btn.dataset.quickSkill;
      const skill = byId.get(id);
      if (!skill) continue;
      const active = Boolean(skill.enabled !== false && skill.alwaysOn);
      const paused = Boolean(skill.pausedInMode);
      btn.setAttribute('aria-checked', String(active));
      btn.classList.toggle('is-skill-on', active);
      btn.classList.toggle('is-skill-paused', paused);
      const sw = btn.querySelector('.slash-switch');
      if (sw) sw.classList.toggle('is-on', active);
      const pausedEl = btn.querySelector('.gem-skill-toggle__paused');
      if (pausedEl) {
        pausedEl.hidden = !paused;
        if (skill.pauseReason) pausedEl.title = skill.pauseReason;
      }
    }
  }

  async function sync() {
    const ctx = getContext?.() || {};
    const data = await fetchSkills(ctx);
    applyData(data);
    return data;
  }

  for (const btn of buttons) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.quickSkill;
      if (!id || pending.has(id)) return;
      const prevOn = btn.getAttribute('aria-checked') === 'true';
      const nextOn = !prevOn;

      pending.add(id);
      btn.setAttribute('aria-checked', String(nextOn));
      btn.classList.toggle('is-skill-on', nextOn);
      btn.querySelector('.slash-switch')?.classList.toggle('is-on', nextOn);

      const host = window.host;
      if (typeof host?.skillsToggle === 'function') {
        try {
          const res = await host.skillsToggle({
            id,
            ...(nextOn ? { enabled: true } : {}),
            alwaysOn: nextOn,
          });
          if (res && res.ok !== false) {
            const normalized = (Array.isArray(res.categories) || Array.isArray(res.items))
              ? normalizeSkillsResponse(res)
              : await sync();
            applyData(normalized);
            window.dispatchEvent(new CustomEvent('capri:skills-changed', { detail: normalized }));
            onChanged?.(normalized);
          } else {
            btn.setAttribute('aria-checked', String(prevOn));
            btn.classList.toggle('is-skill-on', prevOn);
            btn.querySelector('.slash-switch')?.classList.toggle('is-on', prevOn);
          }
        } catch {
          btn.setAttribute('aria-checked', String(prevOn));
          btn.classList.toggle('is-skill-on', prevOn);
          btn.querySelector('.slash-switch')?.classList.toggle('is-on', prevOn);
        }
      } else {
        window.dispatchEvent(new CustomEvent('capri:skills-changed', { detail: null }));
        onChanged?.(null);
      }

      pending.delete(id);
    });
  }

  if (triggerBtn) {
    triggerBtn.addEventListener('click', () => {
      sync();
    });
  }

  window.addEventListener('capri:skills-changed', (e) => {
    if (e.detail && (Array.isArray(e.detail.items) || Array.isArray(e.detail.categories))) {
      applyData(e.detail);
    } else {
      sync();
    }
  });

  window.addEventListener('capri:plugins-changed', () => {
    sync();
  });

  sync();

  return { sync, applyData };
}

// ---------------------------------------------------------------- shared UI cards & helpers

export function ensureSlashDock(logEl, composeEl) {
  if (!logEl) return null;
  let dock = logEl.querySelector('.slash-dock');
  if (!dock) {
    dock = document.createElement('div');
    dock.className = 'slash-dock';
    if (composeEl && composeEl.parentNode === logEl) {
      logEl.insertBefore(dock, composeEl);
    } else {
      logEl.appendChild(dock);
    }
  }
  return dock;
}

export function showSlashCard(dock, { title, meta, icon = 'terminal', text = '', formatBody, onCopy }) {
  if (!dock) return null;
  dock.querySelectorAll('.slash-card').forEach((node) => node.remove());

  const card = document.createElement('div');
  card.className = 'slash-card';

  const head = document.createElement('div');
  head.className = 'slash-card__head';

  const iconEl = document.createElement('span');
  iconEl.className = 'slash-card__icon';
  iconEl.appendChild(createIconSvg(icon, 16));

  const titleEl = document.createElement('span');
  titleEl.className = 'slash-card__title';
  titleEl.textContent = title || 'Команда';

  head.append(iconEl, titleEl);

  if (meta) {
    const metaEl = document.createElement('span');
    metaEl.className = 'slash-card__meta';
    metaEl.textContent = meta;
    head.appendChild(metaEl);
  }

  const actions = document.createElement('div');
  actions.className = 'slash-card__actions';

  if (text) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'slash-card__btn';
    copyBtn.textContent = 'Копировать';
    copyBtn.addEventListener('click', () => {
      if (typeof onCopy === 'function') onCopy(text);
      else if (window.host?.chatsCopy) window.host.chatsCopy(text);
      else navigator.clipboard?.writeText?.(text).catch(() => {});
      copyBtn.textContent = 'Скопировано';
      setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1200);
    });
    actions.appendChild(copyBtn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'slash-card__btn slash-card__btn--icon';
  closeBtn.setAttribute('aria-label', 'Скрыть');
  closeBtn.title = 'Скрыть';
  closeBtn.appendChild(createIconSvg('close', 14));
  closeBtn.addEventListener('click', () => card.remove());
  actions.appendChild(closeBtn);

  head.appendChild(actions);

  const body = document.createElement('div');
  body.className = 'slash-card__body';
  if (typeof formatBody === 'function') formatBody(body, text);
  else body.textContent = text;

  card.append(head, body);
  dock.appendChild(card);
  return card;
}

export function showSlashConfirm(dock, { text, confirmLabel = 'Удалить', cancelLabel = 'Отмена', onConfirm, onCancel }) {
  if (!dock) return null;
  dock.querySelectorAll('.slash-confirm').forEach((node) => node.remove());

  const bar = document.createElement('div');
  bar.className = 'slash-confirm';

  const msg = document.createElement('span');
  msg.className = 'slash-confirm__text';
  msg.textContent = text || 'Подтвердить действие?';

  const actions = document.createElement('div');
  actions.className = 'slash-confirm__actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'panel__action';
  cancelBtn.textContent = cancelLabel;
  cancelBtn.addEventListener('click', () => {
    bar.remove();
    onCancel?.();
  });

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'panel__action is-danger';
  confirmBtn.textContent = confirmLabel;
  confirmBtn.addEventListener('click', () => {
    bar.remove();
    onConfirm?.();
  });

  actions.append(cancelBtn, confirmBtn);
  bar.append(msg, actions);
  dock.appendChild(bar);
  return bar;
}

export function normalizeSlashAction(action) {
  if (!action) return null;
  if (typeof action === 'string') return { type: action };
  if (typeof action === 'object') {
    return { ...action, type: action.type || action.name || action.action || '' };
  }
  return null;
}

export function extractContextPct(context) {
  if (!context || typeof context !== 'object') return null;
  const candidate = context.pct ?? context.percent ?? context.usedPct ?? context.usagePct;
  if (Number.isFinite(Number(candidate))) return Math.round(Number(candidate));
  if (Number.isFinite(context.used) && Number.isFinite(context.limit) && context.limit > 0) {
    return Math.round((context.used / context.limit) * 100);
  }
  return null;
}

export function renderSlashStatePills(metaEl, state) {
  if (!metaEl) return;
  let wrap = metaEl.querySelector('.slash-state-pills');
  if (!wrap) {
    wrap = document.createElement('span');
    wrap.className = 'slash-state-pills';
    metaEl.appendChild(wrap);
  }
  const pills = [];
  if (state?.planMode) pills.push('Режим плана');
  if (state?.focus) pills.push('Фокус');
  if (state?.effort && state.effort !== 'medium') pills.push(`Усилие: ${state.effort}`);
  if (state?.outputStyle && state.outputStyle !== 'default') pills.push(`Стиль: ${state.outputStyle}`);
  if (state?.advisor) pills.push(`Советник: ${state.advisor}`);
  if (state?.autocompact === false) pills.push('Автосжатие: выкл');

  wrap.replaceChildren(...pills.map((label) => {
    const chip = document.createElement('span');
    chip.className = 'slash-state-pill';
    chip.textContent = label;
    return chip;
  }));
}
