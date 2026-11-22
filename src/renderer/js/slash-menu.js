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

// ---------------------------------------------------------------- fallback catalog

function item(name, description, opts = {}) {
  return {
    id: opts.id || `${opts.section || 'commands'}:${name}`,
    name,
    slash: `/${name}`,
    aliases: opts.aliases || [],
    section: opts.section || 'commands',
    kind: opts.kind || (INSTANT_COMMANDS.has(name) ? 'instant' : 'session'),
    icon: opts.icon || name,
    description,
    badge: opts.badge ?? null,
    active: Boolean(opts.active),
    chainable: Boolean(opts.chainable),
    confirmRequired: Boolean(opts.confirmRequired),
    cloudOnly: opts.cloudOnly ?? CLOUD_ONLY_FALLBACK.has(name),
    argsHint: opts.argsHint || '',
  };
}

export const FALLBACK_SECTIONS = [
  {
    id: 'commands',
    title: 'Команды',
    allLabel: 'Все команды',
    items: [
      item('compact', 'Сжать раннюю часть разговора в конспект', { kind: 'session', argsHint: '[фокус]' }),
      item('status', 'Состояние локального мозга, очереди и памяти'),
      item('usage', 'Остаток квот и лимиты моделей', { aliases: ['quota'] }),
      item('context', 'Заполнение контекстного окна'),
      item('new', 'Начать новый чистый разговор', { aliases: ['clear'], kind: 'session' }),
      item('btw', 'Быстрый вопрос в стороне без записи в историю', { kind: 'prompt', argsHint: '<вопрос>' }),
      item('stop', 'Остановить текущий ответ'),
      item('retry', 'Повторить последний запрос', { kind: 'session' }),
      item('model', 'Переключить активную модель или режим', { kind: 'session', argsHint: '[имя]' }),
      item('effort', 'Уровень глубины рассуждения (low/medium/high/xhigh)', { kind: 'session', argsHint: '[уровень]' }),
      item('focus', 'Режим фокуса без боковых панелей', { kind: 'session' }),
      item('plan-mode', 'Сначала план, потом выполнение', { kind: 'session' }),
      item('deep', 'Глубокое исследование темы', { kind: 'prompt', cloudOnly: true, argsHint: '<тема>', chainable: true }),
      item('council', 'Спросить совет моделей', { kind: 'prompt', cloudOnly: true, argsHint: '<вопрос>', chainable: true }),
      item('review', 'Проверка и ревью решения или кода', { kind: 'prompt', argsHint: '[цель]', chainable: true }),
      item('grill-me', 'Уточняющие вопросы по плану и решениям', { kind: 'prompt', argsHint: '[тема]', chainable: true }),
      item('fork', 'Создать ответвление текущего разговора', { kind: 'session' }),
      item('rename', 'Переименовать текущий разговор', { kind: 'session', argsHint: '<название>' }),
      item('pin', 'Закрепить или открепить разговор', { kind: 'session' }),
      item('archive', 'Убрать разговор в архив', { kind: 'session' }),
      item('delete', 'Удалить текущий разговор с подтверждением', { kind: 'session', confirmRequired: true }),
      item('copy', 'Скопировать последний ответ в буфер'),
      item('export', 'Сохранить разговор в файл или Obsidian'),
      item('remember', 'Запомнить факт в локальную память', { kind: 'session', argsHint: '<факт>' }),
      item('save', 'Сохранить результат в заметку Obsidian', { kind: 'session', argsHint: '[заголовок]' }),
      item('today', 'Сводка планов на сегодня'),
      item('mail', 'Проверить входящую почту Proton'),
      item('nomad', 'Поиск по локальной базе знаний Kiwix'),
      item('web', 'Поиск в интернете через браузер Капри', { cloudOnly: true, argsHint: '<запрос>' }),
      item('tor', 'Поиск через изолированный узел Tor', { argsHint: '<запрос>' }),
      item('free', 'Выгрузить модели из VRAM'),
      item('tasks', 'Активные и фоновые задачи'),
      item('tools', 'Список доступных инструментов'),
      item('mcp', 'Статус MCP-подключений'),
      item('skills', 'Список установленных навыков'),
      item('doctor', 'Быстрая диагностика систем Капри'),
      item('storage', 'Использование диска и базы'),
      item('output-style', 'Стиль ответа (default/concise/detailed/technical/bullets)', { kind: 'session', argsHint: '[стиль]' }),
      item('autocompact', 'Автосжатие контекста по порогу', { kind: 'session', argsHint: '[on|off|%]' }),
      item('help', 'Справка по командам и навыкам', { aliases: ['find'] }),
    ],
  },
  {
    id: 'skills',
    title: 'Навыки',
    allLabel: 'Все навыки',
    items: [
      item('second-brain', 'Проверка идеи по логике и фактам без поддакивания', { section: 'skills', kind: 'skill', icon: 'sparkles', chainable: true }),
      item('russian-editor', 'Живой русский текст без нейросетевых штампов', { section: 'skills', kind: 'skill', icon: 'edit', chainable: true }),
      item('think', 'Глубокий 10-шаговый разбор сложного решения', { section: 'skills', kind: 'skill', icon: 'sparkles', chainable: true }),
      item('i-have-adhd', 'Краткий шаг за шагом, сначала следующее действие', { section: 'skills', kind: 'skill', icon: 'list', chainable: true }),
      item('genesis-techlead-reviewer', 'Строгое ревью архитектуры и кода техлидом', { section: 'skills', kind: 'skill', icon: 'check', chainable: true }),
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
    subtitle: 'Подключаемые инструкции, которые можно комбинировать в одном сообщении.',
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
      .filter((it) => !(isolated && it.cloudOnly))
      .map((it) => {
        if (it.name === 'compact' && pct !== null) {
          return { ...it, badge: `${pct}%` };
        }
        return { ...it };
      }),
  }));
  return { sections, state: {} };
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
  const name = (it.name || '').toLowerCase();
  const slash = (it.slash || `/${name}`).toLowerCase();
  const aliases = (it.aliases || []).map((a) => String(a).toLowerCase());
  const desc = (it.description || '').toLowerCase();

  if (name === query || slash === `/${query}` || aliases.includes(query)) return 100;
  if (name.startsWith(query) || aliases.some((a) => a.startsWith(query))) return 80;
  if (name.includes(query) || aliases.some((a) => a.includes(query))) return 50;
  if (desc.includes(query)) return 25;
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
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `slash-menu__row${it.kind === 'draft' ? ' is-draft' : ''}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');

    const iconWrap = document.createElement('span');
    iconWrap.className = 'slash-menu__icon';
    iconWrap.appendChild(createIconSvg(it.icon || it.name, 18));

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

  input.addEventListener('input', onInputEvent);
  input.addEventListener('keyup', onKeyUp);
  input.addEventListener('click', onClickInput);
  input.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keydown', onWindowKeyDown, true);
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
      document.removeEventListener('mousedown', onDocMouseDown);
      menu.remove();
    },
  };
}

// ---------------------------------------------------------------- Draft Catalog Modal

let activeModalCleanup = null;

export async function openCatalogModal({ initialTab = 'commands', getContext, onRunCommand } = {}) {
  if (activeModalCleanup) {
    activeModalCleanup();
    activeModalCleanup = null;
  }

  const ctx = getContext?.() || {};
  const ctxPct = Number.isFinite(ctx.pct) ? Math.round(ctx.pct) : null;
  let catalog = buildFallbackCatalog(ctx);
  let activeTab = initialTab || 'commands';
  let searchQuery = '';

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
  searchInput.placeholder = 'Поиск по командам, навыкам и коннекторам…';
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

  let noticeText = '';

  function cleanup() {
    window.removeEventListener('keydown', onEscape, true);
    backdrop.remove();
    if (activeModalCleanup === cleanup) activeModalCleanup = null;
  }

  function onEscape(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
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
      count.textContent = String((sec.items || []).length);

      btn.append(label, count);
      btn.addEventListener('click', () => {
        activeTab = sec.id;
        noticeText = '';
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
    const h2 = document.createElement('h2');
    h2.className = 'slash-catalog__title';
    h2.textContent = heroInfo.title;
    const sub = document.createElement('p');
    sub.className = 'slash-catalog__subtitle';
    sub.textContent = heroInfo.subtitle;
    hero.append(h2, sub);
    frag.appendChild(hero);

    if (noticeText) {
      const notice = document.createElement('p');
      notice.className = 'slash-catalog__notice';
      notice.textContent = noticeText;
      frag.appendChild(notice);
    }

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

  const liveData = await fetchCatalog(ctx);
  if (document.body.contains(backdrop)) {
    catalog = liveData;
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
  });
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
