// Reusable Gemini Dark Slash Command Autocomplete & Draft Catalog Modal for Capri Desktop.
// Built strictly with createElement / createElementNS (zero innerHTML with untrusted text).

const SVG_NS = 'http://www.w3.org/2000/svg';

export const INSTANT_COMMANDS = new Set([
  'status', 'usage', 'quota', 'context', 'tasks', 'tools', 'mcp',
  'skills', 'reload-skills', 'doctor', 'storage', 'permissions',
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
  terminal: [
    ['path', { d: 'M7 19l10-14' }],
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

const COMMAND_CATEGORY_TITLES = Object.fromEntries(COMMAND_CATEGORIES.map((c) => [c.id, c.title]));
const SKILL_CATEGORY_TITLES = Object.fromEntries(SKILL_CATEGORIES.map((c) => [c.id, c.title]));

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
    stage: '2.3',
    items: [
      item('obsidian-suite', 'Набор инструментов и правил для Obsidian Vault', { section: 'plugins', kind: 'draft', icon: 'puzzle', badge: 'Этап 2.3' }),
      item('dev-workbench', 'Плагин ревью, отладки и профильных проверок', { section: 'plugins', kind: 'draft', icon: 'puzzle', badge: 'Этап 2.3' }),
      item('research-pack', 'Сбор источников и структурированные досье', { section: 'plugins', kind: 'draft', icon: 'puzzle', badge: 'Этап 2.3' }),
    ],
  },
  {
    id: 'connectors',
    title: 'Коннекторы',
    allLabel: 'Все коннекторы',
    stage: '2.4',
    items: [
      item('proton-pim', 'Proton Mail и Proton Calendar (только чтение без подтверждения)', { section: 'connectors', kind: 'draft', icon: 'mail', badge: 'Этап 2.4' }),
      item('obsidian-vault', 'Прямой доступ к заметкам D:\\Obsidian\\C.A.P.R.I', { section: 'connectors', kind: 'draft', icon: 'book', badge: 'Этап 2.4' }),
      item('github-sync', 'Репозитории, коммиты и ревью через GitHub', { section: 'connectors', kind: 'draft', icon: 'branch', badge: 'Этап 2.4' }),
      item('google-workspace', 'Документы и таблицы при явном подключении', { section: 'connectors', kind: 'draft', icon: 'plug', badge: 'Этап 2.4' }),
    ],
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
    subtitle: 'Внешние подключения к почте, календарю, хранилищам и сервисам.',
  },
  styles: {
    title: 'Стили',
    subtitle: 'Готовые профили формата и тона ответов для разных задач.',
  },
};

function isIsolatedContext(ctx) {
  return Boolean(ctx?.ephemeral || ['private', 'nsfw', 'tor'].includes(ctx?.mode));
}

function buildFallbackCatalog(ctx) {
  const isolated = isIsolatedContext(ctx);
  const pct = Number.isFinite(ctx?.pct) ? Math.round(ctx.pct) : null;
  const sections = FALLBACK_SECTIONS.map((sec) => ({
    ...sec,
    items: sec.items
      .filter((it) => !(isolated && sec.id !== 'skills' && it.cloudOnly))
      .map((it) => {
        if (it.name === 'compact' && pct !== null) {
          return { ...it, badge: `${pct}%` };
        }
        return { ...it };
      }),
  }));
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
    start,
    end: pos,
    token,
    query: token.slice(1).toLowerCase(),
    isChained: prevTokens.length > 0,
    prevTokens,
  };
}

function scoreItem(it, query) {
  if (!query) return 10;
  const id = (it.id || '').toLowerCase();
  const name = (it.name || '').toLowerCase();
  const title = (it.title || '').toLowerCase();
  const slash = (it.slash || `/${name}`).toLowerCase();
  const aliases = (it.aliases || []).map((a) => String(a).toLowerCase());
  const desc = (it.description || '').toLowerCase();
  const cat = (it.category || '').toLowerCase();
  const catTitle = (it.categoryTitle || '').toLowerCase();

  if (name === query || id === query || slash === `/${query}` || aliases.includes(query)) return 100;
  if (name.startsWith(query) || id.startsWith(query) || title.startsWith(query) || aliases.some((a) => a.startsWith(query))) return 80;
  if (name.includes(query) || id.includes(query) || title.includes(query) || slash.includes(query) || aliases.some((a) => a.includes(query))) return 50;
  if (desc.includes(query)) return 25;
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
  plugins: 2,
  connectors: 2,
  styles: 2,
};

export function attachSlashMenu({ input, container, getContext, onSelectItem, onOpenCatalog }) {
  if (!input || !container) return null;

  const menu = document.createElement('div');
  menu.className = 'slash-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', 'Команды и навыки');
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

  function buildItemRow(it, sectionId, ctxPct) {
    const isSkill = sectionId === 'skills' || it.kind === 'skill';
    const isPaused = Boolean(it.pausedInMode);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `slash-menu__row${it.kind === 'draft' ? ' is-draft' : ''}${isPaused ? ' is-paused' : ''}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');

    const iconWrap = document.createElement('span');
    iconWrap.className = 'slash-menu__icon';
    iconWrap.appendChild(createIconSvg(it.icon || (it.isPack ? 'layers' : (isSkill ? 'sparkles' : it.name)), 18));

    const main = document.createElement('span');
    main.className = 'slash-menu__main';

    const title = document.createElement('span');
    title.className = 'slash-menu__title';
    title.textContent = it.slash || `/${it.name}`;
    main.appendChild(title);

    if (it.argsHint) {
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

    if (isSkill) {
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

  function buildAllRow(sec) {
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
    count.textContent = String((sec.items || []).length);

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
    const isChained = activeToken.isChained;
    const ctxPct = Number.isFinite(ctx.pct) ? Math.round(ctx.pct) : null;

    flatRows = [];
    const frag = document.createDocumentFragment();

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
      let items = Array.isArray(sec.items) ? sec.items : [];
      if (sec.id === 'skills') {
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
    const token = extractActiveSlashToken(input.value, caret);
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

export async function openCatalogModal({ initialTab = 'commands', getContext, onRunCommand, onSkillsChanged } = {}) {
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
  let activeTab = initialTab || 'commands';
  let searchQuery = '';
  let noticeText = '';
  let activeForm = null; // null | 'create' | 'install'
  let formBusy = false;
  let formError = '';
  let reloadingSkills = false;
  const pendingToggles = new Set();
  const collapsedGroups = new Set();

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

  const backdrop = document.createElement('div');
  backdrop.className = 'slash-catalog-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Каталог команд и навыков');

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
  searchInput.placeholder = 'Поиск по командам, навыкам и категориям…';
  searchInput.setAttribute('aria-label', 'Поиск по каталогу');
  searchWrap.appendChild(searchInput);

  bar.append(closeBtn, searchWrap);

  const tabsEl = document.createElement('div');
  tabsEl.className = 'slash-catalog__tabs';
  tabsEl.setAttribute('role', 'tablist');

  top.append(bar, tabsEl);

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

  function cleanup() {
    window.removeEventListener('keydown', onEscape, true);
    backdrop.remove();
    if (activeModalCleanup === cleanup) activeModalCleanup = null;
  }

  function onEscape(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (activeForm) {
        activeForm = null;
        formError = '';
        installDraft.preview = null;
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

  function renderTabs() {
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
      const itemCount = sec.id === 'skills'
        ? (skillsData.items || []).length
        : (sec.items || []).length;
      count.textContent = String(itemCount);

      btn.append(label, count);
      btn.addEventListener('click', () => {
        activeTab = sec.id;
        noticeText = '';
        if (sec.id !== 'skills') {
          activeForm = null;
          formError = '';
        }
        renderModal();
      });
      return btn;
    }));
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
        formError = '';
        renderModal();
      });

      const installBtn = document.createElement('button');
      installBtn.type = 'button';
      installBtn.className = `slash-catalog__action-btn${activeForm === 'install' ? ' is-active' : ''}`;
      installBtn.append(createIconSvg('download', 16), document.createTextNode('Установить'));
      installBtn.addEventListener('click', () => {
        activeForm = activeForm === 'install' ? null : 'install';
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

  const [liveCatalog, liveSkills] = await Promise.all([
    fetchCatalog(ctx),
    fetchSkills(ctx, catalog.sections.find((s) => s.id === 'skills')?.items || []),
  ]);
  if (document.body.contains(backdrop)) {
    catalog = liveCatalog;
    skillsData = liveSkills;
    syncSkillsIntoCatalog();
    renderModal();
  }
}

// ---------------------------------------------------------------- shared catalog target registry

const catalogTargets = new Map();

export function registerCatalogTarget(tabName, handler) {
  catalogTargets.set(tabName, handler);
}

export function openActiveCatalog(initialTab = 'commands') {
  const agentsPlate = document.querySelector('.hud__plate[data-tab="agents"]');
  const activeTab = agentsPlate && !agentsPlate.hidden ? 'agents' : 'chats';
  const target = catalogTargets.get(activeTab) || catalogTargets.get('chats') || catalogTargets.get('agents');
  if (!target) {
    openCatalogModal({ initialTab });
    return;
  }
  openCatalogModal({
    initialTab,
    getContext: target.getContext,
    onRunCommand: target.onRunCommand,
    onSkillsChanged: target.onSkillsChanged,
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
