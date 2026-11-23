'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildContextStats, estimateTokens } = require('./context-stats');

const ISOLATED_MODES = new Set(['private', 'nsfw', 'tor']);

const DEFAULT_SESSION_STATE = Object.freeze({
  planMode: false,
  focus: false,
  autocompact: true,
  autocompactThreshold: 80,
  effort: 'medium',
  outputStyle: 'default',
  advisor: null,
  pet: true,
  temp: null,
});

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const VALID_OUTPUT_STYLES = new Set(['default', 'concise', 'detailed', 'technical', 'bullets']);

const OUTPUT_STYLE_HINTS = Object.freeze({
  default: '',
  concise: 'Стиль ответа (concise): отвечай максимально коротко, сразу с вывода и фактов, без вступлений.',
  detailed: 'Стиль ответа (detailed): дай подробный пошаговый разбор с примерами и краевыми случаями.',
  technical: 'Стиль ответа (technical): инженерный тон — точные пути, символы, команды, ограничения и метрики без воды.',
  bullets: 'Стиль ответа (bullets): оформляй ответ компактными маркированными списками и краткими тезисами.',
});

const INSTANT_COMMAND_IDS = new Set([
  'status', 'usage', 'quota', 'context', 'tasks', 'tools', 'phone', 'mcp', 'skills', 'reload-skills',
  'plugins', 'hookify', 'connectors', 'docker', 'styles', 'style', 'voice',
  'analyze', 'convert', 'transcribe', 'upscale',
  'doctor', 'storage', 'permissions', 'memory', 'help', 'find', 'free', 'today', 'mail',
  'clip', 'alta', 'agents', 'harness', 'nomad', 'web', 'tor', 'copy', 'export', 'insights', 'stop',
]);

const COMMAND_CATEGORIES = Object.freeze([
  { id: 'chat', title: 'Чат и контекст' },
  { id: 'memory', title: 'Память и заметки' },
  { id: 'modes', title: 'Поиск и режимы' },
  { id: 'system', title: 'Инструменты и диагностика' },
  { id: 'agents', title: 'Агенты и планирование' },
]);

const COMMAND_CATEGORY_TITLE_MAP = new Map([
  ...COMMAND_CATEGORIES.map((c) => [c.id, c.title]),
  ['skills-system', 'Система и мастерская'],
]);

const COMMAND_CATEGORY_BY_ID = Object.freeze({
  compact: 'chat',
  autocompact: 'chat',
  new: 'chat',
  clear: 'chat',
  context: 'chat',
  model: 'chat',
  effort: 'chat',
  temp: 'chat',
  stop: 'chat',
  retry: 'chat',
  fork: 'chat',
  recap: 'chat',
  btw: 'chat',
  focus: 'chat',
  'output-style': 'chat',
  advisor: 'chat',
  copy: 'chat',
  export: 'chat',
  pin: 'chat',
  rename: 'chat',
  archive: 'chat',
  delete: 'chat',
  resume: 'chat',
  remember: 'memory',
  save: 'memory',
  memory: 'memory',
  find: 'memory',
  learn: 'memory',
  nomad: 'memory',
  alta: 'memory',
  web: 'modes',
  tor: 'modes',
  deep: 'modes',
  council: 'modes',
  'plan-mode': 'modes',
  'grill-me': 'modes',
  review: 'modes',
  ultrareview: 'modes',
  verify: 'modes',
  simplify: 'modes',
  goal: 'modes',
  draw: 'modes',
  pet: 'modes',
  status: 'system',
  usage: 'system',
  quota: 'system',
  free: 'system',
  doctor: 'system',
  storage: 'system',
  permissions: 'system',
  tools: 'system',
  phone: 'system',
  mcp: 'system',
  skills: 'system',
  'reload-skills': 'system',
  plugins: 'system',
  hookify: 'system',
  connectors: 'system',
  docker: 'system',
  insights: 'system',
  help: 'system',
  today: 'agents',
  plan: 'agents',
  remind: 'agents',
  mail: 'agents',
  clip: 'agents',
  schedule: 'agents',
  loop: 'agents',
  tasks: 'agents',
  subtask: 'agents',
  agents: 'agents',
  harness: 'agents',
});

const CMD = (id, opts) => {
  const isSkill = opts?.section === 'skills';
  const category = opts?.category || (isSkill ? 'system' : (COMMAND_CATEGORY_BY_ID[id] || 'system'));
  const categoryTitle = opts?.categoryTitle || (isSkill ? 'Система и мастерская' : (COMMAND_CATEGORY_TITLE_MAP.get(category) || 'Инструменты и диагностика'));
  return {
    id,
    name: id,
    slash: `/${id}`,
    aliases: [],
    section: 'commands',
    kind: INSTANT_COMMAND_IDS.has(id) ? 'instant' : 'session',
    icon: 'terminal',
    category,
    categoryTitle,
    description: '',
    badge: null,
    active: false,
    chainable: false,
    confirmRequired: false,
    cloudOnly: false,
    argsHint: '',
    ...opts,
  };
};

// Single source of truth for all 65 built-in commands:
// 28 Core + 6 Antigravity + 11 Codex + 19 Claude + 1 Gemini (genesis-techlead-reviewer) = 65.
const BUILTIN_COMMANDS = Object.freeze([
  // --- Core (28) ---
  CMD('compact', { kind: 'session', icon: 'compress', argsHint: '[фокус]', description: 'Сжать старые реплики в конспект и освободить контекст' }),
  CMD('new', { aliases: ['clear'], kind: 'session', icon: 'plus', description: 'Начать новый диалог с чистого листа' }),
  CMD('context', { icon: 'gauge', description: 'Показать заполнение контекстного окна и разбивку токенов' }),
  CMD('model', { kind: 'session', icon: 'cpu', argsHint: '<модель>', description: 'Переключить активную модель чата или агента' }),
  CMD('temp', { kind: 'session', icon: 'flame', argsHint: '<0..2 | on | off>', description: 'Задать температуру генерации или переключить временный режим' }),
  CMD('stop', { icon: 'stop', description: 'Немедленно остановить текущий ответ модели' }),
  CMD('retry', { kind: 'session', icon: 'refresh', description: 'Повторить последний запрос к модели' }),
  CMD('remember', { kind: 'session', icon: 'bookmark', argsHint: '<факт>', description: 'Сохранить факт в очередь памяти (pending_review)' }),
  CMD('save', { kind: 'session', icon: 'save', argsHint: '[тема]', description: 'Сохранить заметку или конспект диалога в Obsidian' }),
  CMD('export', { icon: 'download', argsHint: '[md|json]', description: 'Экспортировать текущую переписку в Markdown или JSON' }),
  CMD('usage', { aliases: ['quota'], icon: 'chart', description: 'Показать квоты облачных агентов и расход контекста' }),
  CMD('status', { icon: 'activity', description: 'Статус ПК: ОЗУ, VRAM, диски, GPU и загруженные модели' }),
  CMD('free', { icon: 'zap', description: 'Выгрузить локальные модели из VRAM и ОЗУ' }),
  CMD('today', { icon: 'calendar', description: 'Сводка расписания и задач на сегодня' }),
  CMD('plan', { kind: 'session', icon: 'list-check', argsHint: '<задача>', description: 'Добавить задачу в Планировщик и Obsidian' }),
  CMD('remind', { kind: 'session', icon: 'bell', argsHint: '<через N мин текст>', description: 'Поставить напоминание по времени' }),
  CMD('mail', { icon: 'mail', cloudOnly: true, description: 'Проверить свежие письма в Proton Mail' }),
  CMD('clip', { icon: 'clipboard', argsHint: '[текст]', description: 'Прочитать или записать буфер обмена ПК' }),
  CMD('alta', { icon: 'flag', description: 'Сводка по проекту ALTA из Obsidian и Планировщика' }),
  CMD('agents', { icon: 'users', cloudOnly: true, description: 'Список и статус активных облачных агентов в Хабе' }),
  CMD('harness', { icon: 'terminal', cloudOnly: true, argsHint: '[status|start|stop]', description: 'Статус или управление автономным харнессом GENESIS' }),
  CMD('web', { icon: 'globe', cloudOnly: true, argsHint: '<запрос>', description: 'Быстрый поиск в сети через браузер Капри' }),
  CMD('tor', { icon: 'shield', argsHint: '<запрос>', description: 'Поиск через изолированный узел Tor (Ahmia / .onion)' }),
  CMD('nomad', { icon: 'book', argsHint: '<запрос>', description: 'Поиск по офлайн-библиотеке NOMAD / Kiwix' }),
  CMD('deep', { kind: 'prompt', icon: 'sparkles', cloudOnly: true, argsHint: '<тема>', description: 'Глубокое исследование темы советом облачных моделей' }),
  CMD('plan-mode', { kind: 'session', icon: 'compass', argsHint: '[on|off]', description: 'Режим планирования: сначала план и проверка, без правок' }),
  CMD('review', { kind: 'prompt', icon: 'check-circle', chainable: true, argsHint: '[цель]', description: 'Строгое техлид-ревью кода, диффа или решения' }),
  CMD('help', { aliases: ['find'], icon: 'help', argsHint: '[поиск]', description: 'Справка по слеш-командам и быстрый поиск команды' }),

  // --- Antigravity (6) ---
  CMD('btw', { kind: 'prompt', icon: 'message-square', argsHint: '<вопрос>', description: 'Боковой вопрос по текущему контексту без записи в историю' }),
  CMD('grill-me', { kind: 'prompt', icon: 'flame', chainable: true, argsHint: '[тема]', description: 'Жёсткое интервью и разбор слабых мест плана до реализации' }),
  CMD('learn', { icon: 'graduation-cap', argsHint: '[что закрепить]', description: 'Удачную задачу из этого чата — в свой навык (рецепт делает локальная модель)' }),
  CMD('skill-files', { aliases: ['навык-файлы'], icon: 'paperclip', argsHint: '<навык>', description: 'Приложить к своему навыку справочные файлы (md, txt, json, csv…)' }),
  CMD('schedule', { kind: 'prompt', icon: 'clock', argsHint: '<расписание>', description: 'Спроектировать периодическую фоновую задачу по расписанию' }),
  CMD('goal', { kind: 'prompt', icon: 'target', argsHint: '<цель>', description: 'Автономный режим до полного достижения цели без ранней остановки' }),
  CMD('council', { kind: 'prompt', icon: 'layers', cloudOnly: true, argsHint: '<вопрос>', description: 'Созвать совет моделей с перекрёстной критикой и вердиктом' }),

  // --- Codex (11) ---
  CMD('fork', { kind: 'session', icon: 'git-branch', description: 'Создать независимую ветку текущего диалога' }),
  CMD('effort', { kind: 'session', icon: 'sliders', argsHint: '<low|medium|high|xhigh>', description: 'Задать уровень глубины рассуждений модели' }),
  CMD('memory', { icon: 'database', argsHint: '[поиск]', description: 'Проверить память диалога и очередь pending_review' }),
  CMD('tools', { aliases: ['pc', 'инструменты'], icon: 'wrench', description: 'Инструменты ПК и мосты Lenovo .107 — статус и запуск' }),
  CMD('mcp', { icon: 'plug', description: 'Статус локальных MCP-серверов (capri-pim, capri-web)' }),
  CMD('pin', { kind: 'session', icon: 'pin', description: 'Закрепить или открепить текущий чат в списке' }),
  CMD('rename', { kind: 'session', icon: 'edit', argsHint: '<название>', description: 'Переименовать текущий чат или сессию агента' }),
  CMD('archive', { kind: 'session', icon: 'archive', description: 'Убрать или вернуть текущий чат в архив' }),
  CMD('delete', { kind: 'session', icon: 'trash', confirmRequired: true, description: 'Удалить текущий чат или сессию (требует подтверждения)' }),
  CMD('pet', { kind: 'session', icon: 'smile', argsHint: '[on|off]', description: 'Включить или выключить спутника Капри на рабочем столе' }),
  CMD('draw', { kind: 'prompt', icon: 'image', argsHint: '<описание>', description: 'Сгенерировать изображение через локальный ComfyUI' }),

  // --- Claude (19) ---
  CMD('advisor', { kind: 'session', icon: 'award', cloudOnly: true, argsHint: '[модель|off]', description: 'Подключить модель-советника для проверки сложных шагов' }),
  CMD('recap', { kind: 'prompt', icon: 'file-text', description: 'Краткая сводка, на чём остановились в текущей сессии' }),
  CMD('skills', { icon: 'grid', description: 'Показать установленные навыки и открыть каталог' }),
  CMD('reload-skills', { icon: 'refresh-cw', description: 'Пересканировать папки SKILL.md на диске без перезапуска' }),
  CMD('doctor', { icon: 'stethoscope', description: 'Диагностика Ollama, Tor, NOMAD, MCP, браузера и памяти' }),
  CMD('copy', { icon: 'copy', description: 'Скопировать последний ответ ассистента в буфер обмена' }),
  CMD('tasks', { icon: 'check-square', description: 'Показать активные фоновые задачи и очередь Хаба' }),
  CMD('subtask', { kind: 'prompt', icon: 'git-commit', cloudOnly: true, argsHint: '<задача>', description: 'Вынести подзадачу отдельному субагенту без засорения чата' }),
  CMD('focus', { kind: 'session', icon: 'maximize', argsHint: '[on|off]', description: 'Режим фокуса: скрыть лишние элементы вокруг диалога' }),
  CMD('verify', { kind: 'prompt', icon: 'shield-check', chainable: true, argsHint: '[что проверить]', description: 'Проверить факты, дифф или утверждение по первоисточникам' }),
  CMD('simplify', { kind: 'prompt', icon: 'scissors', chainable: true, argsHint: '[цель]', description: 'Упростить код или текст без лишних абстракций и воды' }),
  CMD('output-style', { kind: 'session', icon: 'type', argsHint: '<default|concise|detailed|technical|bullets>', description: 'Задать стиль оформления и подробность ответов' }),
  CMD('autocompact', { kind: 'session', icon: 'minimize', argsHint: '[on|off|порог%]', description: 'Автосжатие контекста при достижении порога (по умолчанию 80%)' }),
  CMD('loop', { kind: 'prompt', icon: 'repeat', argsHint: '<шаг>', description: 'Повторять проверку или шаг цикла по условию' }),
  CMD('resume', { kind: 'session', icon: 'play', argsHint: '[id]', description: 'Продолжить прошлый диалог из истории чатов' }),
  CMD('permissions', { icon: 'lock', description: 'Показать текущие границы изоляции, прав и барьеров чата' }),
  CMD('ultrareview', { kind: 'prompt', icon: 'search', cloudOnly: true, chainable: true, argsHint: '[цель]', description: 'Глубокое многопроходное ревью архитектуры и краевых случаев' }),
  CMD('insights', { icon: 'bar-chart', description: 'Сводка по активности чатов, сессий и использованию моделей' }),
  CMD('storage', { icon: 'hard-drive', description: 'Свободное место на дисках и объём папок данных Капри' }),

  // --- Gemini (1) ---
  CMD('genesis-techlead-reviewer', {
    section: 'skills',
    kind: 'skill',
    icon: 'code',
    chainable: true,
    argsHint: '[цель]',
    description: 'Профиль жёсткого техлида GENESIS для /review: поиск багов, гонок и утечек',
  }),
]);

const PLUGIN_COMMANDS = Object.freeze([
  CMD('plugins', {
    aliases: ['plugin'],
    icon: 'plug',
    description: 'Показать установленные плагины и открыть каталог на вкладке «Плагины»',
  }),
  CMD('hookify', {
    icon: 'shield',
    description: 'Показать активные правила Hookify и открыть управление в плагинах',
  }),
]);

const CONNECTOR_COMMANDS = Object.freeze([
  CMD('connectors', {
    aliases: ['connector'],
    icon: 'plug',
    description: 'Показать статус коннекторов и открыть каталог на вкладке «Коннекторы»',
  }),
  CMD('docker', {
    aliases: ['containers', 'stacks'],
    icon: 'server',
    description: 'Пульт Docker (ПК и сервер Lenovo .107) — статус и управление стеками',
  }),
]);

const TOOLS_COMMANDS = Object.freeze([
  CMD('analyze', {
    icon: 'bar-chart',
    argsHint: '<файл> [вопрос]',
    description: 'Локальный анализ CSV/TSV/XLSX/JSON и построение графика PNG',
  }),
  CMD('convert', {
    icon: 'file-text',
    argsHint: '<файл> [docx|pdf|png|txt]',
    description: 'Конвертация документов (MD → DOCX, Office → PDF, SVG → PNG)',
  }),
  CMD('transcribe', {
    icon: 'mic',
    argsHint: '<файл или URL>',
    description: 'Транскрибация аудио/видео в текст через локальный Whisper',
  }),
  CMD('upscale', {
    icon: 'image',
    argsHint: '<изображение> [выход]',
    description: 'Локальный 4x апскейл изображения через Upscayl',
  }),
]);

const PHONE_COMMANDS = Object.freeze([
  CMD('phone', {
    aliases: ['телефон', 'xiaomi'],
    icon: 'smartphone',
    description: 'Телефон (Xiaomi 13T Pro) — Health Connect, Shizuku, Organic Maps, Fossify и Find My Device',
  }),
]);

// 2.7a: the Library of styles and writing voices (styles-engine.js)
const STYLES_COMMANDS = Object.freeze([
  CMD('styles', { aliases: ['стили', 'библиотека', 'library'], icon: 'palette', description: 'Библиотека: стили (бренд, личность, маскот) и образы письма' }),
  CMD('style', { aliases: ['стиль'], icon: 'palette', argsHint: '<имя|выкл>', description: 'Включить стиль для всех чатов (или выключить); без имени — какой включён' }),
  CMD('voice', { aliases: ['образ'], icon: 'type', argsHint: '<имя|выкл>', description: 'Включить образ письма — манеру, в которой пишет любая модель' }),
]);

const DRAFT_PLUGINS = Object.freeze([
  {
    id: 'plugin-obsidian-pro',
    name: 'Obsidian Pro Bundle',
    slash: '',
    aliases: [],
    section: 'plugins',
    kind: 'draft',
    icon: 'book',
    description: 'Автоматическая синхронизация графа, заметок и тегов с Vault',
    badge: 'Этап 2.3',
    active: false,
    chainable: false,
    confirmRequired: false,
    cloudOnly: false,
    argsHint: '',
  },
  {
    id: 'plugin-voice-studio',
    name: 'VoiceStudio & Wake Pack',
    slash: '',
    aliases: [],
    section: 'plugins',
    kind: 'draft',
    icon: 'mic',
    description: 'Дополнительные голосовые профили и потоковое озвучивание',
    badge: 'Этап 2.3',
    active: false,
    chainable: false,
    confirmRequired: false,
    cloudOnly: false,
    argsHint: '',
  },
  {
    id: 'plugin-media-comfy',
    name: 'ComfyUI Media Pack',
    slash: '',
    aliases: [],
    section: 'plugins',
    kind: 'draft',
    icon: 'image',
    description: 'Пресеты генерации изображений, анимаций и апскейла',
    badge: 'Этап 2.3',
    active: false,
    chainable: false,
    confirmRequired: false,
    cloudOnly: false,
    argsHint: '',
  },
]);

const DRAFT_CONNECTORS = Object.freeze([
  {
    id: 'connector-proton',
    name: 'Proton Mail / Calendar',
    slash: '',
    aliases: [],
    section: 'connectors',
    kind: 'draft',
    icon: 'mail',
    description: 'Прямой доступ к рабочей почте и расписанию Proton',
    badge: 'Этап 2.4',
    active: false,
    chainable: false,
    confirmRequired: false,
    cloudOnly: true,
    argsHint: '',
  },
  {
    id: 'connector-google-workspace',
    name: 'Google Workspace',
    slash: '',
    aliases: [],
    section: 'connectors',
    kind: 'draft',
    icon: 'globe',
    description: 'Резервная интеграция с Google Docs, Sheets и Calendar',
    badge: 'Этап 2.4',
    active: false,
    chainable: false,
    confirmRequired: false,
    cloudOnly: true,
    argsHint: '',
  },
  {
    id: 'connector-obsidian',
    name: 'Obsidian',
    slash: '',
    aliases: [],
    section: 'connectors',
    kind: 'draft',
    icon: 'database',
    description: 'Быстрый индекс и карточки основного и приватного Vault',
    badge: 'Этап 2.4',
    active: false,
    chainable: false,
    confirmRequired: false,
    cloudOnly: false,
    argsHint: '',
  },
  {
    id: 'connector-github',
    name: 'GitHub',
    slash: '',
    aliases: [],
    section: 'connectors',
    kind: 'draft',
    icon: 'git-branch',
    description: 'Репозитории, pull request, ветки и ревью диффов',
    badge: 'Этап 2.4',
    active: false,
    chainable: false,
    confirmRequired: false,
    cloudOnly: true,
    argsHint: '',
  },
]);

const DRAFT_STYLES = Object.freeze([
  {
    id: 'style-concise',
    name: 'Краткий',
    slash: '',
    aliases: [],
    section: 'styles',
    kind: 'draft',
    icon: 'zap',
    description: 'Ответ сразу по существу, минимум вводных слов',
    badge: 'Этап 2.7',
    active: false,
    chainable: false,
    confirmRequired: false,
    cloudOnly: false,
    argsHint: '',
  },
  {
    id: 'style-technical',
    name: 'Инженерный',
    slash: '',
    aliases: [],
    section: 'styles',
    kind: 'draft',
    icon: 'code',
    description: 'Точные пути, команды, типы и ограничения без воды',
    badge: 'Этап 2.7',
    active: false,
    chainable: false,
    confirmRequired: false,
    cloudOnly: false,
    argsHint: '',
  },
  {
    id: 'style-bullets',
    name: 'Тезисный',
    slash: '',
    aliases: [],
    section: 'styles',
    kind: 'draft',
    icon: 'list-check',
    description: 'Структурированные списки и таблицы для быстрого чтения',
    badge: 'Этап 2.7',
    active: false,
    chainable: false,
    confirmRequired: false,
    cloudOnly: false,
    argsHint: '',
  },
  {
    id: 'style-detailed',
    name: 'Развёрнутый',
    slash: '',
    aliases: [],
    section: 'styles',
    kind: 'draft',
    icon: 'file-text',
    description: 'Подробный разбор с примерами и пограничными случаями',
    badge: 'Этап 2.7',
    active: false,
    chainable: false,
    confirmRequired: false,
    cloudOnly: false,
    argsHint: '',
  },
]);

const PROMPT_INSTRUCTIONS = Object.freeze({
  'review': 'Проведи жёсткое техлид-ревью по профилю genesis-techlead-reviewer: сначала баги, гонки, утечки, нарушения изоляции и краевые случаи со строками/символами; без воды и похвалы.',
  'genesis-techlead-reviewer': 'Профиль genesis-techlead-reviewer: оценивай код и архитектуру как строгий техлид GENESIS. Проверяй инварианты приватности/Tor/ephemeral, гонки асинхронности, валидацию и отсутствие дублирования.',
  'grill-me': 'Режим /grill-me: жёстко допроси замысел — найди скрытые допущения, слабые места, несостыковки и задай острые вопросы до начала реализации.',
  'verify': 'Режим /verify: проверь утверждения, факты, пути и поведение по реальным данным и первоисточникам; явно отметь, что подтверждено, а что не проверено.',
  'simplify': 'Режим /simplify: упрости решение или текст, убери лишние абстракции, повторы и воду, сохранив корректность и краевые проверки.',
  'ultrareview': 'Режим /ultrareview: выполни глубокое многопроходное ревью архитектуры, безопасности, производительности и всех пограничных сценариев.',
  'recap': 'Режим /recap: дай краткую структурированную сводку текущего разговора — цель, что уже решено, на чём остановились и какой следующий шаг.',
  'schedule': 'Режим /schedule: помоги спроектировать надёжную периодическую задачу или расписание с учётом интервала, условий остановки и безопасности.',
  'goal': 'Режим /goal: работай последовательно до полного и проверяемого достижения поставленной цели, не обрываясь на полумерах.',
  'loop': 'Режим /loop: опиши и выполни повторяемый шаг/проверку до выполнения явного критерия выхода.',
  'subtask': 'Режим /subtask: выдели чёткую изолированную подзадачу с входами, границами и критерием готовности.',
  'caveman': 'Режим caveman: отвечай максимально сжато, сразу с сути, без вежливых вступлений и итоговых повторов. Код, пути, команды и цифры оставляй дословно.',
  'i-have-adhd': 'Режим i-have-adhd: сначала дай конкретный следующий шаг, потом нумерованные пункты с оценкой времени, без длинных вступлений и отвлечений.',
  'second-brain': 'Режим second-brain: оценивай идею и план по логике и фактам, без поддакивания; сразу отмечай слабые места и противоречия.',
  'russian-editor': 'Режим russian-editor: пиши естественным, живым и точным русским языком без нейросетевых штампов и канцелярита.',
});

function defaultSkillRoots() {
  const home = os.homedir();
  return [
    path.join(home, '.gemini', 'config', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.codex', 'skills'),
  ];
}

function unquoteYaml(val) {
  const s = String(val || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return s;
}

function parseSkillFrontmatter(markdown) {
  const text = String(markdown || '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!match) return { name: '', description: '', body: text.trim() };
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
    body,
  };
}

function scanSkillsOnDisk(roots = defaultSkillRoots()) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    if (!root) continue;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const skillFile = path.join(root, entry.name, 'SKILL.md');
      let raw;
      try {
        raw = fs.readFileSync(skillFile, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseSkillFrontmatter(raw);
      const id = (parsed.name || entry.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: id,
        slash: `/${id}`,
        aliases: [],
        section: 'skills',
        kind: 'skill',
        icon: 'sparkles',
        category: parsed.category || 'system',
        categoryTitle: 'Система и мастерская',
        description: String(parsed.description || `Навык ${id}`).replace(/\s+/g, ' ').trim().slice(0, 180),
        badge: null,
        active: false,
        chainable: true,
        confirmRequired: false,
        cloudOnly: false,
        argsHint: '[запрос]',
        skillPath: skillFile,
        promptBody: parsed.body.slice(0, 1200),
        tokens: estimateTokens(parsed.body || raw),
        alwaysOnTokens: 0,
        enabled: true,
        alwaysOn: false,
        canPinAlways: false,
        quickSlot: null,
        pausedInMode: false,
        pauseReason: null,
        isPack: false,
        subCount: 0,
        isCustom: false,
        stageNote: null,
      });
    }
  }
  return out;
}

function isIsolatedMode({ mode = 'chat', ephemeral = false } = {}) {
  return ephemeral === true || ISOLATED_MODES.has(String(mode || '').toLowerCase());
}

function normalizeState(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const threshold = Number(src.autocompactThreshold);
  const temp = src.temp === null || src.temp === undefined || src.temp === ''
    ? null
    : Number.isFinite(Number(src.temp)) ? Math.min(2, Math.max(0, Number(src.temp))) : null;
  const effort = typeof src.effort === 'string' && VALID_EFFORTS.has(src.effort.toLowerCase())
    ? src.effort.toLowerCase()
    : DEFAULT_SESSION_STATE.effort;
  const outputStyle = typeof src.outputStyle === 'string' && VALID_OUTPUT_STYLES.has(src.outputStyle.toLowerCase())
    ? src.outputStyle.toLowerCase()
    : DEFAULT_SESSION_STATE.outputStyle;
  return {
    planMode: Boolean(src.planMode),
    focus: Boolean(src.focus),
    autocompact: src.autocompact === undefined ? DEFAULT_SESSION_STATE.autocompact : Boolean(src.autocompact),
    autocompactThreshold: Number.isFinite(threshold) ? Math.min(98, Math.max(30, Math.round(threshold))) : DEFAULT_SESSION_STATE.autocompactThreshold,
    effort,
    outputStyle,
    advisor: typeof src.advisor === 'string' && src.advisor.trim() ? src.advisor.trim() : null,
    pet: src.pet === undefined ? DEFAULT_SESSION_STATE.pet : Boolean(src.pet),
    temp,
  };
}

function buildRegistry(dynamicSkills = []) {
  const builtinCmdIds = new Set([
    ...BUILTIN_COMMANDS.filter((c) => c.section === 'commands').map((c) => c.id),
    ...PLUGIN_COMMANDS.map((c) => c.id),
    ...CONNECTOR_COMMANDS.map((c) => c.id),
    ...TOOLS_COMMANDS.map((c) => c.id),
    ...PHONE_COMMANDS.map((c) => c.id),
    ...STYLES_COMMANDS.map((c) => c.id),
  ]);
  const diskById = new Map();
  for (const sk of dynamicSkills) {
    if (!sk || !sk.id) continue;
    diskById.set(sk.id, sk);
  }

  const items = [];
  for (const c of [...BUILTIN_COMMANDS, ...PLUGIN_COMMANDS, ...CONNECTOR_COMMANDS, ...TOOLS_COMMANDS, ...PHONE_COMMANDS, ...STYLES_COMMANDS]) {
    if (c.id === 'genesis-techlead-reviewer' && diskById.has(c.id)) {
      const disk = diskById.get(c.id);
      items.push({ ...c, promptBody: disk.promptBody || '', skillPath: disk.skillPath || '' });
    } else {
      items.push({ ...c });
    }
  }
  for (const sk of dynamicSkills) {
    if (builtinCmdIds.has(sk.id) || sk.id === 'genesis-techlead-reviewer') continue;
    items.push({ ...sk });
  }

  const bySlash = new Map();
  for (const item of items) {
    bySlash.set(item.id.toLowerCase(), item);
    for (const alias of item.aliases || []) {
      bySlash.set(String(alias).toLowerCase(), item);
    }
  }
  return { items, bySlash };
}

function parseSlashInput(rawText, registry = null) {
  const text = String(rawText || '').trim();
  if (!text.startsWith('/')) {
    return {
      isSlash: false,
      chain: [],
      remainder: text,
      primary: null,
      instant: false,
      btw: false,
      unknown: [],
    };
  }
  const reg = registry?.bySlash ? registry : buildRegistry(Array.isArray(registry) ? registry : []);
  const chain = [];
  const seen = new Set();
  const unknown = [];
  let pos = 0;

  while (pos < text.length) {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
    if (text[pos] !== '/') break;
    const m = /^\/([\p{L}\p{N}_-]+)(?=\s|$)/u.exec(text.slice(pos));
    if (!m) break;
    const tok = m[1].toLowerCase();
    const item = reg.bySlash.get(tok);
    if (!item) {
      if (chain.length === 0) unknown.push(tok);
      break;
    }
    if (!seen.has(item.id)) {
      seen.add(item.id);
      chain.push(item);
    }
    pos += m[0].length;
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
    // Allow chaining skills/prompt modifiers after a chainable item or after /btw.
    const canContinue = item.chainable === true || item.id === 'btw';
    if (!canContinue) break;
    // If the next token starts with '/', only consume it if it's a known command/skill; otherwise keep it in remainder.
    if (text[pos] === '/') {
      const peek = /^\/([\p{L}\p{N}_-]+)(?=\s|$)/u.exec(text.slice(pos));
      if (!peek || !reg.bySlash.has(peek[1].toLowerCase())) break;
    } else {
      break;
    }
  }

  const remainder = text.slice(pos).trim();
  const primary = chain[0] || null;
  const btw = chain.some((c) => c.id === 'btw');
  const instant = chain.length === 1 && primary?.kind === 'instant';

  return {
    isSlash: true,
    chain,
    remainder,
    primary,
    instant,
    btw,
    unknown,
  };
}

function buildExtractiveSummary(messages, focus = '') {
  const focusTokens = String(focus || '')
    .toLowerCase()
    .split(/[^a-zа-яё0-9_-]+/i)
    .filter((w) => w.length >= 3);

  const lines = [];
  for (const m of messages) {
    if (!m || !m.content) continue;
    const roleLabel = m.role === 'user' ? 'Пользователь' : m.role === 'assistant' ? 'Ассистент' : 'Система';
    const raw = String(m.content).replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    if (raw.startsWith('[Конспект предыдущей части разговора]')) {
      const inner = raw.replace('[Конспект предыдущей части разговора]', '').trim();
      if (inner) lines.push(inner.slice(0, 600));
      continue;
    }
    const isFocused = focusTokens.length > 0 && focusTokens.some((tok) => raw.toLowerCase().includes(tok));
    const maxLen = isFocused ? 240 : 140;
    lines.push(`- ${roleLabel}: ${raw.slice(0, maxLen)}${raw.length > maxLen ? '…' : ''}`);
  }

  const header = focus
    ? `[Конспект предыдущей части разговора · фокус: ${focus}]`
    : '[Конспект предыдущей части разговора]';

  // Keep within 3200 chars to respect per-message caps across chats.js and phone.js.
  const body = [];
  let len = header.length + 1;
  const maxTotal = 3000;
  for (const line of lines) {
    if (len + line.length + 1 > maxTotal) break;
    body.push(line);
    len += line.length + 1;
  }
  return [header, ...body].join('\n');
}

function pickKeepCount(total, requestedKeep) {
  if (Number.isFinite(Number(requestedKeep)) && Number(requestedKeep) > 0) {
    return Math.min(6, Math.max(4, Math.round(Number(requestedKeep))));
  }
  return total <= 8 ? 4 : 6;
}

async function compactHistory({
  history = [],
  keepTurns = null,
  focus = '',
  mode = 'chat',
  ephemeral = false,
  model = '',
  provider = '',
  summarizer = null,
  signal = null,
} = {}) {
  const clean = (Array.isArray(history) ? history : [])
    .filter((m) => m && ['user', 'assistant', 'system'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ ...m, content: m.content.trim() }));

  const isolated = isIsolatedMode({ mode, ephemeral });
  const targetKeep = pickKeepCount(clean.length, keepTurns);

  if (clean.length <= 4 || clean.length <= targetKeep) {
    const context = buildContextStats({ model, provider, messages: clean });
    return {
      ok: true,
      summary: '',
      history: clean,
      droppedCount: 0,
      keptCount: clean.length,
      skipped: true,
      context,
    };
  }

  let splitAt = clean.length - targetKeep;
  // Align kept tail on a user message within [4, 6] kept turns when possible.
  if (clean[splitAt]?.role !== 'user') {
    if (clean.length - (splitAt - 1) <= 6 && splitAt - 1 > 0 && clean[splitAt - 1]?.role === 'user') {
      splitAt -= 1;
    } else if (clean.length - (splitAt + 1) >= 4 && clean[splitAt + 1]?.role === 'user') {
      splitAt += 1;
    }
  }

  const older = clean.slice(0, splitAt);
  const kept = clean.slice(splitAt);
  let summary = '';

  if (typeof summarizer === 'function') {
    try {
      const candidate = await summarizer({
        older,
        kept,
        focus: String(focus || '').trim(),
        isolated,
        mode,
        ephemeral,
        signal,
      });
      if (typeof candidate === 'string' && candidate.trim()) {
        const raw = candidate.trim().slice(0, 3200);
        summary = raw.startsWith('[Конспект предыдущей части разговора]')
          ? raw
          : `[Конспект предыдущей части разговора]\n${raw}`;
      }
    } catch {
      summary = '';
    }
  }

  if (!summary) {
    summary = buildExtractiveSummary(older, focus);
  }

  const summaryTurn = { role: 'assistant', content: summary, compacted: true };
  const nextHistory = [summaryTurn, ...kept];
  const context = buildContextStats({ model, provider, messages: nextHistory });

  return {
    ok: true,
    summary,
    history: nextHistory,
    droppedCount: older.length,
    keptCount: kept.length,
    context,
  };
}

function buildChainPrompt({ chain, remainder, state, mode, skipSkillHints = false }) {
  const skills = [];
  const hints = [];
  const actions = [];
  let deepResearch = false;
  let council = false;
  let review = false;
  let draw = false;
  let btw = false;

  for (const item of chain) {
    if (item.id === 'btw') btw = true;
    if (item.id === 'deep') deepResearch = true;
    if (item.id === 'council') council = true;
    if (item.id === 'review' || item.id === 'ultrareview' || item.id === 'genesis-techlead-reviewer') review = true;
    if (item.id === 'draw') draw = true;
    if (item.kind === 'skill') skills.push(item.id);
    if (!(skipSkillHints && item.kind === 'skill' && item.id !== 'genesis-techlead-reviewer')) {
      if (PROMPT_INSTRUCTIONS[item.id]) {
        hints.push(PROMPT_INSTRUCTIONS[item.id]);
      } else if (item.promptBody) {
        hints.push(`Навык /${item.id}: ${item.promptBody.slice(0, 600)}`);
      } else if (item.description) {
        hints.push(`Команда /${item.id}: ${item.description}`);
      }
    }
    actions.push(item.id);
  }

  if (state?.planMode) {
    hints.push('Активен режим планирования (plan-mode): сначала представь пошаговый план и риски, ничего не меняй до подтверждения.');
  }
  if (state?.outputStyle && OUTPUT_STYLE_HINTS[state.outputStyle]) {
    hints.push(OUTPUT_STYLE_HINTS[state.outputStyle]);
  }
  if (state?.advisor && !isIsolatedMode({ mode })) {
    hints.push(`Советник: учитывай проверку модели ${state.advisor}.`);
  }

  const defaultPrompts = {
    recap: 'Сделай краткую сводку текущего диалога: главная цель, что уже сделано и следующий шаг.',
    review: 'Проведи техлид-ревью текущего контекста, кода или решения.',
    ultrareview: 'Проведи глубокое многопроходное ревью текущего решения и краевых случаев.',
    'genesis-techlead-reviewer': 'Проведи жёсткое техлид-ревью GENESIS по текущему контексту.',
    'grill-me': 'Разбери наш текущий план и задай самые сложные вопросы.',
    verify: 'Проверь утверждения и детали из последнего контекста.',
    simplify: 'Упрости текущее решение без потери корректности.',
    goal: 'Продолжай шаг за шагом до полного достижения цели.',
    loop: 'Выполни повторяемую проверку текущего состояния.',
  };

  const primary = chain.find((c) => c.id !== 'btw' && c.kind === 'prompt') || chain.at(-1);
  const text = remainder || defaultPrompts[primary?.id] || 'Выполни запрос с учётом выбранных навыков.';

  return {
    text,
    skills: [...new Set(skills)],
    systemHint: hints.join('\n'),
    chain: actions,
    btw,
    deepResearch,
    council,
    review,
    draw,
    effort: state?.effort,
    advisor: state?.advisor,
    mode,
  };
}

function splitFirstArg(rawArgs) {
  const s = String(rawArgs || '').trim();
  if (!s) return { first: '', rest: '' };
  if (s.startsWith('"') || s.startsWith("'")) {
    const q = s[0];
    const end = s.indexOf(q, 1);
    if (end > 1) {
      return { first: s.slice(1, end).trim(), rest: s.slice(end + 1).trim() };
    }
  }
  if (fs.existsSync(s)) return { first: s, rest: '' };
  const sp = s.search(/\s/);
  if (sp === -1) return { first: s, rest: '' };
  return { first: s.slice(0, sp).trim(), rest: s.slice(sp + 1).trim() };
}

class SlashCommandEngine {
  constructor(opts = {}) {
    this.skillRoots = opts.skillRoots || defaultSkillRoots();
    this.skillsEngine = opts.skillsEngine || opts.deps?.skillsEngine || null;
    this.pluginsEngine = opts.pluginsEngine || opts.deps?.pluginsEngine || null;
    this.connectorsEngine = opts.connectorsEngine || opts.deps?.connectorsEngine || null;
    this.dockerEngine = opts.dockerEngine || opts.deps?.dockerEngine || null;
    this.pcToolsEngine = opts.pcToolsEngine || opts.deps?.pcToolsEngine || null;
    this.phoneControlEngine = opts.phoneControlEngine || opts.deps?.phoneControlEngine || null;
    this.stylesEngine = opts.stylesEngine || opts.deps?.stylesEngine || null;
    this.getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({});
    this.saveConfig = typeof opts.saveConfig === 'function' ? opts.saveConfig : () => {};
    this.deps = opts.deps || {};
    this.sessionStates = new Map();
    this.skillCache = null;
  }

  getSkills(force = false) {
    if (this.skillsEngine) {
      return force ? this.skillsEngine.reload() : this.skillsEngine.getSkills(false);
    }
    if (!this.skillCache || force) {
      this.skillCache = scanSkillsOnDisk(this.skillRoots);
    }
    return this.skillCache;
  }

  reloadSkills() {
    if (this.skillsEngine) {
      return this.skillsEngine.reload();
    }
    this.skillCache = scanSkillsOnDisk(this.skillRoots);
    return this.skillCache;
  }

  registry() {
    return buildRegistry(this.getSkills(false));
  }

  getState(sessionId = null) {
    const base = normalizeState(this.getConfig()?.slashState || {});
    if (!sessionId) return base;
    const override = this.sessionStates.get(sessionId);
    return override ? normalizeState({ ...base, ...override }) : base;
  }

  updateState(sessionId, patch) {
    const next = normalizeState({ ...this.getState(sessionId), ...patch });
    if (sessionId) {
      this.sessionStates.set(sessionId, next);
    } else {
      const cfg = this.getConfig() || {};
      this.saveConfig({ slashState: next, ...(typeof cfg === 'object' ? {} : {}) });
    }
    return next;
  }

  listCommands({ mode = 'chat', ephemeral = false, agent = null, contextPct = null, pct = null, sessionId = null, state: stateOverride = null } = {}) {
    const isolated = isIsolatedMode({ mode, ephemeral });
    const reg = this.registry();
    const state = stateOverride ? normalizeState({ ...this.getState(sessionId), ...stateOverride }) : this.getState(sessionId);
    const rawPct = contextPct !== null && contextPct !== undefined ? contextPct : pct;
    const pctNum = rawPct !== null && rawPct !== undefined && rawPct !== '' && Number.isFinite(Number(rawPct))
      ? Math.max(0, Math.min(100, Math.round(Number(rawPct))))
      : null;

    const decorate = (item) => {
      const copy = {
        id: item.id,
        name: item.name,
        slash: item.slash,
        aliases: item.aliases || [],
        section: item.section,
        kind: item.kind,
        icon: item.icon,
        category: item.category || (item.section === 'skills' ? 'system' : 'system'),
        categoryTitle: item.categoryTitle || (item.section === 'skills' ? 'Система и мастерская' : 'Инструменты и диагностика'),
        description: item.description,
        badge: item.badge || null,
        active: Boolean(item.active),
        chainable: Boolean(item.chainable),
        confirmRequired: Boolean(item.confirmRequired),
        cloudOnly: Boolean(item.cloudOnly),
        argsHint: item.argsHint || '',
      };
      if (item.section === 'skills') {
        copy.enabled = item.enabled !== undefined ? Boolean(item.enabled) : true;
        copy.alwaysOn = Boolean(item.alwaysOn);
        copy.canPinAlways = Boolean(item.canPinAlways);
        copy.quickSlot = item.quickSlot ?? null;
        copy.pausedInMode = Boolean(item.pausedInMode);
        copy.pauseReason = item.pauseReason || null;
        copy.isPack = Boolean(item.isPack);
        copy.subCount = Number(item.subCount) || 0;
        copy.isCustom = Boolean(item.isCustom);
        copy.stageNote = item.stageNote || null;
        copy.tokens = Number(item.tokens) || estimateTokens(item.promptBody || item.description || '');
        copy.alwaysOnTokens = Number(item.alwaysOnTokens) || 0;
      }
      if (copy.id === 'compact' && pctNum !== null) copy.badge = `${pctNum}%`;
      if (copy.id === 'plan-mode') copy.active = state.planMode;
      if (copy.id === 'focus') copy.active = state.focus;
      if (copy.id === 'autocompact') {
        copy.active = state.autocompact;
        copy.badge = state.autocompact ? `${state.autocompactThreshold}%` : 'off';
      }
      if (copy.id === 'pet') copy.active = state.pet;
      if (copy.id === 'effort') copy.badge = state.effort;
      if (copy.id === 'output-style' && state.outputStyle !== 'default') copy.badge = state.outputStyle;
      if (copy.id === 'advisor' && state.advisor) copy.badge = state.advisor;
      if (copy.id === 'temp' && state.temp !== null) copy.badge = String(state.temp);
      return copy;
    };

    const allow = (item) => !(isolated && item.cloudOnly);
    const commandItems = reg.items.filter((i) => i.section === 'commands' && allow(i)).map(decorate);
    const commandCategories = COMMAND_CATEGORIES
      .map((cat) => ({
        id: cat.id,
        title: cat.title,
        items: commandItems.filter((item) => item.category === cat.id),
      }))
      .filter((cat) => cat.items.length > 0);

    let skillItems;
    let skillCategories = null;
    let skillBudget = null;
    let quickToggles = null;

    if (this.skillsEngine) {
      const catalog = this.skillsEngine.listSkills({ mode, ephemeral });
      const engineItems = catalog.items.map((item) => ({ ...item }));
      const hasTechlead = engineItems.some((i) => i.id === 'genesis-techlead-reviewer');
      if (!hasTechlead) {
        const builtinTechlead = reg.items.find((i) => i.id === 'genesis-techlead-reviewer');
        if (builtinTechlead) {
          engineItems.push(decorate(builtinTechlead));
        }
      }
      skillItems = engineItems;
      skillCategories = catalog.categories.map((cat) => ({
        id: cat.id,
        title: cat.title,
        items: cat.id === 'system' && !hasTechlead
          ? skillItems.filter((i) => i.category === 'system')
          : cat.items,
      }));
      skillBudget = catalog.budget;
      quickToggles = catalog.quickToggles;
    } else {
      skillItems = reg.items.filter((i) => i.section === 'skills' && allow(i)).map(decorate);
    }

    let pluginsSection;
    if (this.pluginsEngine) {
      const pluginsCatalog = this.pluginsEngine.listPlugins({ mode, ephemeral });
      const pluginItems = pluginsCatalog.items.map((p) => ({
        id: p.id,
        name: p.name,
        slash: p.slash || '',
        aliases: p.aliases || [],
        section: 'plugins',
        kind: 'plugin',
        icon: p.icon || 'plug',
        category: p.category,
        categoryTitle: p.categoryTitle,
        description: p.description,
        badge: p.badge || null,
        active: Boolean(p.active),
        chainable: false,
        confirmRequired: false,
        cloudOnly: Boolean(p.cloudOnly),
        vaultOnly: Boolean(p.vaultOnly),
        argsHint: '',
        enabled: Boolean(p.enabled),
        pausedInMode: Boolean(p.pausedInMode),
        pauseReason: p.pauseReason || null,
        statusNote: p.statusNote || '',
        skills: Array.isArray(p.skills) ? [...p.skills] : [],
        rules: Array.isArray(p.rules) ? [...p.rules] : [],
        hooks: Array.isArray(p.hooks) ? [...p.hooks] : [],
        commands: Array.isArray(p.commands) ? [...p.commands] : [],
        health: p.health || 'ok',
        source: p.source || 'builtin',
        isCustom: Boolean(p.isCustom),
      }));
      pluginsSection = {
        id: 'plugins',
        title: 'Плагины',
        allLabel: 'Все плагины',
        categories: pluginsCatalog.categories,
        items: pluginItems,
        stats: pluginsCatalog.stats,
        hookifyRules: pluginsCatalog.hookifyRules,
      };
    } else {
      const pluginItems = DRAFT_PLUGINS.filter(allow).map((i) => ({ ...i }));
      pluginsSection = { id: 'plugins', title: 'Плагины', allLabel: 'Все плагины', stage: '2.3', items: pluginItems };
    }

    let connectorsSection;
    if (this.connectorsEngine) {
      const connCatalog = this.connectorsEngine.listConnectors({ mode, ephemeral });
      const connItems = connCatalog.items.map((c) => ({
        id: c.id,
        name: c.name,
        slash: '',
        aliases: Array.isArray(c.aliases) ? [...c.aliases] : [],
        section: 'connectors',
        kind: 'connector',
        icon: c.icon || 'plug',
        category: c.category,
        categoryTitle: c.categoryTitle,
        description: c.description,
        badge: c.pausedInMode ? 'Пауза' : (c.statusLabel || null),
        active: Boolean(c.enabled && !c.pausedInMode),
        chainable: false,
        confirmRequired: false,
        cloudOnly: Boolean(c.cloudOnly),
        localOnly: Boolean(c.localOnly),
        offlineSafe: Boolean(c.offlineSafe),
        argsHint: '',
        enabled: Boolean(c.enabled),
        pausedInMode: Boolean(c.pausedInMode),
        pauseReason: c.pauseReason || null,
        status: c.status,
        statusLabel: c.statusLabel,
        latencyMs: c.latencyMs ?? null,
        detail: c.detail || '',
        isCustom: Boolean(c.isCustom),
        transport: c.transport || 'http',
        url: c.url || '',
        ...(c.lastDigestAt !== undefined && { lastDigestAt: c.lastDigestAt }),
      }));
      connectorsSection = {
        id: 'connectors',
        title: 'Коннекторы',
        allLabel: 'Все коннекторы',
        categories: connCatalog.categories,
        items: connItems,
        stats: connCatalog.stats,
      };
    } else {
      const connectorItems = DRAFT_CONNECTORS.filter(allow).map((i) => ({ ...i }));
      connectorsSection = { id: 'connectors', title: 'Коннекторы', allLabel: 'Все коннекторы', stage: '2.4', items: connectorItems };
    }
    const styleItems = DRAFT_STYLES.filter(allow).map((i) => ({ ...i }));

    return {
      mode,
      ephemeral: Boolean(ephemeral),
      agent: agent || null,
      state,
      sections: [
        { id: 'commands', title: 'Команды', allLabel: 'Все команды', categories: commandCategories, items: commandItems },
        {
          id: 'skills',
          title: 'Навыки',
          allLabel: 'Все навыки',
          items: skillItems,
          ...(skillCategories && { categories: skillCategories }),
          ...(skillBudget && { budget: skillBudget }),
          ...(quickToggles && { quickToggles }),
        },
        pluginsSection,
        connectorsSection,
        { id: 'styles', title: 'Стили', allLabel: 'Посмотреть все стили', stage: '2.7', items: styleItems },
      ],
    };
  }

  async run(payload = {}) {
    const rawText = String(payload.text || '').trim();
    const mode = String(payload.mode || 'chat').toLowerCase();
    const ephemeral = payload.ephemeral === true;
    const isolated = isIsolatedMode({ mode, ephemeral });
    const sessionId = payload.sessionId || payload.id || null;
    const chatId = payload.chatId || null;
    const agent = payload.agent || null;
    const model = payload.model || '';
    const history = Array.isArray(payload.history) ? payload.history : undefined;
    const confirm = payload.confirm === true;

    const reg = this.registry();
    const parsed = parseSlashInput(rawText, reg);
    if (!parsed.isSlash) {
      return { handled: false, instant: false, reply: '' };
    }
    if (parsed.chain.length === 0) {
      const unknownName = parsed.unknown[0] || '';
      return {
        handled: false,
        instant: true,
        error: `Неизвестная команда /${unknownName}. Напиши /help для списка команд.`,
        reply: `Неизвестная команда /${unknownName}. Напиши /help для списка команд.`,
      };
    }

    // Enforce privacy / Tor / 18+ / ephemeral barriers on cloudOnly commands.
    const blockedCloud = isolated ? parsed.chain.find((c) => c.cloudOnly) : null;
    if (blockedCloud) {
      const msg = `Команда ${blockedCloud.slash} недоступна в изолированном режиме (${ephemeral ? 'временный чат' : mode}).`;
      return { handled: true, instant: true, error: msg, reply: msg };
    }

    // Enforce non-destructive mode auto-pause on skills when skillsEngine is active.
    if (this.skillsEngine && parsed.chain.some((c) => c.kind === 'skill')) {
      const catalog = this.skillsEngine.listSkills({ mode, ephemeral });
      const byId = new Map(catalog.items.map((i) => [i.id, i]));
      const paused = parsed.chain.map((c) => byId.get(c.id)).find((item) => item?.pausedInMode);
      if (paused) {
        const msg = `Навык ${paused.slash} недоступен в этом режиме (${paused.pauseReason || 'пауза'}).`;
        return { handled: true, instant: true, error: msg, reply: msg };
      }
    }

    const state = this.getState(sessionId);
    const primary = parsed.primary;
    const args = parsed.remainder;

    // Multi-command skill/prompt chain OR single prompt command (e.g. /caveman /second-brain /grill-me ..., /btw ..., /deep ..., /review ...)
    if (parsed.chain.length > 1 || primary.kind === 'prompt' || primary.kind === 'skill') {
      if (primary.id === 'btw' && parsed.chain.length === 1 && !args) {
        return {
          handled: true,
          instant: true,
          action: 'btw',
          reply: 'Укажи вопрос после /btw, например: /btw почему падает сборка?',
        };
      }
      const built = buildChainPrompt({
        chain: parsed.chain,
        remainder: args,
        state,
        mode,
        skipSkillHints: Boolean(this.skillsEngine),
      });
      let skillPromptBlock = '';
      if (this.skillsEngine && built.skills.length > 0) {
        const skillCtx = this.skillsEngine.buildPromptContext({
          mode,
          ephemeral,
          explicitSkills: built.skills,
          userText: built.text,
          isCloud: mode === 'agent',
        });
        skillPromptBlock = skillCtx.explicitText || '';
      }
      const combinedHint = [built.systemHint, skillPromptBlock].filter(Boolean).join('\n\n');
      const promptRewriteStr = built.btw
        ? built.text
        : built.deepResearch
          ? `[DEEP_RESEARCH] ${built.text}`
          : combinedHint
            ? `[Указания режима:\n${combinedHint}]\n\n${built.text}`
            : built.text;
      if (primary.id === 'btw' && typeof this.deps.answerBtw === 'function') {
        try {
          const btwRes = await this.deps.answerBtw({
            text: built.text,
            systemHint: built.systemHint,
            skills: built.skills,
            mode,
            ephemeral,
            agent,
            sessionId,
            model,
            history,
          });
          if (btwRes?.error) {
            return { handled: true, instant: false, action: 'btw', btw: true, error: btwRes.error, reply: btwRes.error, promptRewrite: promptRewriteStr, rewriteMeta: built };
          }
          return {
            handled: true,
            instant: false,
            action: 'btw',
            btw: true,
            reply: String(btwRes?.reply || btwRes?.text || '').trim(),
            context: btwRes?.context,
            promptRewrite: promptRewriteStr,
            rewriteMeta: built,
          };
        } catch (err) {
          return { handled: true, instant: false, action: 'btw', btw: true, error: err.message, reply: err.message, promptRewrite: promptRewriteStr, rewriteMeta: built };
        }
      }
      return {
        handled: true,
        instant: false,
        action: built.deepResearch ? 'deep' : built.council ? 'council' : built.draw ? 'draw' : built.btw ? 'btw' : undefined,
        btw: built.btw,
        promptRewrite: promptRewriteStr,
        rewriteMeta: built,
        state,
        reply: '',
      };
    }

    // Single instant or session command
    const id = primary.id;
    const deps = this.deps;

    switch (id) {
      case 'help': {
        const q = args.toLowerCase();
        const catalog = this.listCommands({ mode, ephemeral, agent, sessionId });
        const all = [...catalog.sections[0].items, ...catalog.sections[1].items];
        const matched = q
          ? all.filter((i) => i.name.includes(q) || i.aliases.some((a) => a.includes(q)) || i.description.toLowerCase().includes(q))
          : all.slice(0, 18);
        const lines = matched.length
          ? matched.map((i) => `${i.slash}${i.argsHint ? ` ${i.argsHint}` : ''} — ${i.description}`)
          : [`По запросу «${args}» команды не найдены.`];
        if (!q && all.length > 18) lines.push(`…и ещё ${all.length - 18}. Открой каталог (/skills) или ищи через /find <слово>.`);
        return { handled: true, instant: true, action: q ? undefined : 'help', reply: lines.join('\n') };
      }

      case 'skills': {
        const skills = this.skillsEngine
          ? this.skillsEngine.listSkills({ mode, ephemeral }).items
          : this.getSkills(false);
        const lines = skills.length
          ? [`Загружено навыков: ${skills.length}`, ...skills.slice(0, 15).map((s) => `${s.slash} — ${s.description}`)]
          : ['Локальные навыки SKILL.md не найдены.'];
        return { handled: true, instant: true, action: 'open-catalog', tab: 'skills', reply: lines.join('\n') };
      }

      case 'reload-skills': {
        const refreshed = this.reloadSkills();
        return {
          handled: true,
          instant: true,
          action: 'reload-skills',
          count: refreshed.length,
          reply: `Каталог навыков обновлён: найдено ${refreshed.length} навыков.`,
        };
      }

      case 'plugins': {
        if (this.pluginsEngine) {
          const catalog = this.pluginsEngine.listPlugins({ mode, ephemeral });
          const lines = [
            `Плагинов активно: ${catalog.stats.activeInMode} / ${catalog.stats.total} (правил Hookify: ${catalog.stats.hookifyRulesCount})`,
            ...catalog.items.slice(0, 12).map((p) => {
              const stateTag = p.pausedInMode ? 'пауза' : (p.enabled ? 'вкл' : 'выкл');
              return `• ${p.name} [${stateTag}] — ${p.statusNote || p.description}`;
            }),
          ];
          return { handled: true, instant: true, action: 'open-catalog', tab: 'plugins', reply: lines.join('\n') };
        }
        return { handled: true, instant: true, action: 'open-catalog', tab: 'plugins', reply: 'Открываю каталог плагинов.' };
      }

      case 'hookify': {
        if (this.pluginsEngine) {
          const catalog = this.pluginsEngine.listPlugins({ mode, ephemeral });
          const rules = catalog.hookifyRules || [];
          const activeCount = rules.filter((r) => r.enabled).length;
          const lines = rules.length
            ? [
                `Правила Hookify (${activeCount} активных из ${rules.length}):`,
                ...rules.map((r) => `• [${r.enabled ? 'вкл' : 'выкл'}] ${r.name} (${r.action}: ${r.triggerPattern})`),
              ]
            : ['Правила Hookify пока не настроены. Открой вкладку «Плагины» → Hookify Rules, чтобы добавить.'];
          return {
            handled: true,
            instant: true,
            action: 'open-catalog',
            tab: 'plugins',
            focusPlugin: 'hookify',
            reply: lines.join('\n'),
          };
        }
        return { handled: true, instant: true, action: 'open-catalog', tab: 'plugins', focusPlugin: 'hookify', reply: 'Открываю управление правилами Hookify.' };
      }

      case 'connectors': {
        if (this.connectorsEngine) {
          const catalog = this.connectorsEngine.listConnectors({ mode, ephemeral });
          const lines = [
            `Коннекторов активно: ${catalog.stats.activeInMode} / ${catalog.stats.total} · Подключено: ${catalog.stats.connected}`,
            ...catalog.items.slice(0, 15).map((c) => {
              const stateTag = c.pausedInMode ? 'пауза' : (c.enabled ? (c.statusLabel || 'вкл') : 'выкл');
              return `• @${c.id} (${c.name}) [${stateTag}] — ${c.detail || c.description}`;
            }),
          ];
          return { handled: true, instant: true, action: 'open-catalog', tab: 'connectors', reply: lines.join('\n') };
        }
        return { handled: true, instant: true, action: 'open-catalog', tab: 'connectors', reply: 'Открываю каталог коннекторов.' };
      }

      case 'docker': {
        if (this.dockerEngine && typeof this.dockerEngine.getStatus === 'function') {
          const st = await this.dockerEngine.getStatus({ refresh: false }).catch(() => null);
          if (st) {
            const pcLine = st.pc?.online
              ? `ПК: ${st.pc.runningCount}/${st.pc.totalCount} стеков · ${Math.round(st.pc.totalContainerMb || 0)} МБ`
              : `ПК: недоступен${st.pc?.error ? ` (${st.pc.error})` : ''}`;
            const srvLine = st.lenovo?.online
              ? `Lenovo .107: ${st.lenovo.runningCount}/${st.lenovo.totalCount} стеков · ${Math.round(st.lenovo.totalContainerMb || 0)} МБ`
              : `Lenovo .107: недоступен${st.lenovo?.error ? ` (${st.lenovo.error})` : ''}`;
            return {
              handled: true,
              instant: true,
              action: 'open-catalog',
              tab: 'docker',
              reply: `Пульт Docker:\n• ${pcLine}\n• ${srvLine}`,
            };
          }
        }
        return { handled: true, instant: true, action: 'open-catalog', tab: 'docker', reply: 'Открываю пульт Docker.' };
      }

      case 'status': {
        const reply = typeof deps.statusText === 'function' ? await deps.statusText() : 'Статус ПК недоступен.';
        return { handled: true, instant: true, reply };
      }

      case 'free': {
        const reply = typeof deps.freeVramText === 'function' ? await deps.freeVramText() : 'Выгрузка VRAM недоступна.';
        return { handled: true, instant: true, reply };
      }

      case 'usage': {
        const text = typeof deps.usageText === 'function'
          ? await deps.usageText({ mode, ephemeral, agent, sessionId, model, history })
          : 'Квоты и расход контекста недоступны.';
        return { handled: true, instant: true, reply: text };
      }

      case 'context': {
        const stats = typeof deps.contextStats === 'function'
          ? await deps.contextStats({ mode, ephemeral, agent, sessionId, model, history })
          : buildContextStats({ model: model || 'auto', provider: agent || 'ollama', messages: history || [] });
        const b = stats.breakdown || {};
        const reply = [
          `Контекст (${stats.model || 'auto'}): ${stats.usedTokens} / ${stats.maxTokens} токенов (${stats.percent}%, свободно ${stats.freeTokens}).`,
          `Разбивка: сообщения ${b.messages || 0} · системный ${b.systemPrompt || 0} · навыки ${b.skills || 0} · память ${b.memory || 0} · инструменты ${b.tools || 0}.`,
        ].join('\n');
        return { handled: true, instant: true, context: stats, reply };
      }

      case 'tasks': {
        const reply = typeof deps.tasksText === 'function' ? await deps.tasksText() : 'Список задач пуст.';
        return { handled: true, instant: true, reply };
      }

      case 'tools': {
        if (this.pcToolsEngine && typeof this.pcToolsEngine.getStatus === 'function') {
          const st = await this.pcToolsEngine.getStatus({ refresh: false }).catch(() => null);
          if (st) {
            const pcLine = `ПК: ${st.pc?.readyCount ?? 0}/${st.pc?.totalCount ?? 0} инструментов готово`;
            const brLine = `Мосты .107: ${st.bridges?.readyCount ?? 0}/${st.bridges?.totalCount ?? 0} доступно`;
            return {
              handled: true,
              instant: true,
              action: 'open-catalog',
              tab: 'tools',
              reply: `Инструменты ПК и мосты .107:\n• ${pcLine}\n• ${brLine}`,
            };
          }
        }
        return {
          handled: true,
          instant: true,
          action: 'open-catalog',
          tab: 'tools',
          reply: 'Открываю каталог инструментов ПК и мостов .107.',
        };
      }

      case 'styles':
        return { handled: true, instant: true, action: 'open-styles', reply: this.stylesEngine && !this.stylesEngine.visualOn ? 'Открываю Образы письма.' : 'Открываю Библиотеку стилей.' };

      case 'style':
      case 'voice': {
        const eng = this.stylesEngine;
        if (!eng) return { handled: true, instant: true, reply: 'Библиотека стилей недоступна.' };
        const isStyle = id === 'style';
        if (isStyle && !eng.visualOn) return { handled: true, instant: true, reply: 'Визуальные стили — отдельный этап на будущее. Сейчас работают Образы письма: /образ.' };
        const what = isStyle ? 'Стиль' : 'Образ письма';
        const items = isStyle ? eng.listStyles() : eng.listVoices();
        const active = eng.getActive()[isStyle ? 'style' : 'voice'];
        const arg = args.trim().replace(/^@/, '').toLowerCase();
        if (!arg) {
          const list = items.map((s) => `@${s.id} — ${s.name}`).join('\n') || 'пока ни одного';
          return { handled: true, instant: true, action: isStyle ? 'open-styles' : undefined, reply: `${what}: ${active ? `@${active}` : 'выключен'}.\n${list}` };
        }
        if (['выкл', 'off', 'нет', 'none', '-'].includes(arg)) {
          eng.setActive(isStyle ? { style: '' } : { voice: '' });
          return { handled: true, instant: true, reply: `${what} выключен.` };
        }
        const hit = items.find((s) => s.id === arg || s.name.toLowerCase() === arg);
        if (!hit) return { handled: true, instant: true, reply: `Нет такого: «${args.trim()}». Есть: ${items.map((s) => `@${s.id}`).join(', ') || 'ничего'}.` };
        const res = eng.setActive(isStyle ? { style: hit.id } : { voice: hit.id });
        return { handled: true, instant: true, reply: res.ok ? `${what} «${hit.name}» включён для всех чатов. Выключить: /${isStyle ? 'стиль' : 'образ'} выкл.` : res.error };
      }

      case 'phone': {
        if (this.phoneControlEngine && typeof this.phoneControlEngine.getStatus === 'function') {
          const st = this.phoneControlEngine.getStatus();
          const statusLine = st.online
            ? `${st.deviceName} · Android ${st.androidVersion}: онлайн (${st.readyCount}/${st.totalCount} модулей готово)`
            : `${st.deviceName} · Android ${st.androidVersion}: офлайн (${st.readyCount}/${st.totalCount} модулей)`;
          return {
            handled: true,
            instant: true,
            action: 'open-catalog',
            tab: 'phone',
            reply: statusLine,
          };
        }
        return {
          handled: true,
          instant: true,
          action: 'open-catalog',
          tab: 'phone',
          reply: 'Открываю панель управления телефоном (Xiaomi 13T Pro).',
        };
      }

      case 'analyze': {
        if (!args) {
          return {
            handled: true,
            instant: true,
            action: 'analyze',
            reply: 'Укажи файл данных: /analyze <путь к CSV/TSV/XLSX/JSON> [вопрос]',
          };
        }
        if (!this.pcToolsEngine || typeof this.pcToolsEngine.analyzeData !== 'function') {
          return { handled: true, instant: true, error: 'Движок инструментов ПК не подключён.', reply: 'Движок инструментов ПК не подключён.' };
        }
        const { first: filePath, rest: query } = splitFirstArg(args);
        const res = await this.pcToolsEngine.analyzeData({ filePath, query });
        if (!res.ok) {
          return { handled: true, instant: true, action: 'analyze', error: res.error, reply: `Ошибка анализа: ${res.error}` };
        }
        const summaryLines = [
          `Анализ ${path.basename(res.file || filePath)}: ${res.rows} строк, ${res.cols} колонок.`,
          ...Object.entries(res.numericSummary || {}).slice(0, 5).map(([k, v]) => `• ${k}: min ${v.min}, max ${v.max}, mean ${v.mean}, sum ${v.sum}`),
        ];
        if (res.chartPath) summaryLines.push(`График: ${res.chartPath}`);
        return { handled: true, instant: true, action: 'analyze', result: res, reply: summaryLines.join('\n') };
      }

      case 'convert': {
        if (!args) {
          return {
            handled: true,
            instant: true,
            action: 'convert',
            reply: 'Укажи файл и формат: /convert <путь> [docx|pdf|png|txt]',
          };
        }
        if (!this.pcToolsEngine || typeof this.pcToolsEngine.convertDocument !== 'function') {
          return { handled: true, instant: true, error: 'Движок инструментов ПК не подключён.', reply: 'Движок инструментов ПК не подключён.' };
        }
        const { first: inputPath, rest } = splitFirstArg(args);
        const targetFormat = (rest || 'docx').replace(/^--to\s+/i, '').trim().split(/\s+/)[0] || 'docx';
        const res = await this.pcToolsEngine.convertDocument({ inputPath, targetFormat });
        if (!res.ok) {
          return { handled: true, instant: true, action: 'convert', error: res.error, reply: `Ошибка конвертации: ${res.error}` };
        }
        return {
          handled: true,
          instant: true,
          action: 'convert',
          result: res,
          reply: `Готово (${res.format}): ${res.outputPath} (${res.bytes} байт).`,
        };
      }

      case 'transcribe': {
        if (!args) {
          return {
            handled: true,
            instant: true,
            action: 'transcribe',
            reply: 'Укажи локальный аудио/видеофайл или URL: /transcribe <путь или URL>',
          };
        }
        if (!this.pcToolsEngine || typeof this.pcToolsEngine.transcribeMedia !== 'function') {
          return { handled: true, instant: true, error: 'Движок инструментов ПК не подключён.', reply: 'Движок инструментов ПК не подключён.' };
        }
        const { first: source } = splitFirstArg(args);
        const res = await this.pcToolsEngine.transcribeMedia({ source: source || args, isPrivate: isolated });
        if (!res.ok) {
          return { handled: true, instant: true, action: 'transcribe', error: res.error, reply: res.error };
        }
        return {
          handled: true,
          instant: true,
          action: 'transcribe',
          result: res,
          reply: res.wrappedText || res.text || 'Пустая расшифровка.',
        };
      }

      case 'upscale': {
        if (!args) {
          return {
            handled: true,
            instant: true,
            action: 'upscale',
            reply: 'Укажи изображение: /upscale <путь к PNG/JPG/WebP> [выходной путь]',
          };
        }
        if (!this.pcToolsEngine || typeof this.pcToolsEngine.upscaleImage !== 'function') {
          return { handled: true, instant: true, error: 'Движок инструментов ПК не подключён.', reply: 'Движок инструментов ПК не подключён.' };
        }
        const { first: inputPath, rest: outputPath } = splitFirstArg(args);
        const res = await this.pcToolsEngine.upscaleImage({ inputPath, outputPath: outputPath || undefined });
        if (!res.ok) {
          return { handled: true, instant: true, action: 'upscale', error: res.error, reply: `Ошибка апскейла: ${res.error}` };
        }
        return {
          handled: true,
          instant: true,
          action: 'upscale',
          result: res,
          reply: `Изображение увеличено 4x: ${res.outputPath} (${res.bytes} байт).`,
        };
      }

      case 'mcp': {
        const reply = typeof deps.mcpText === 'function'
          ? await deps.mcpText({ isolated })
          : `MCP-серверы: ${isolated ? 'внешние вызовы заблокированы изоляцией' : 'capri-pim (:47824), capri-web (:47825)'}.`;
        return { handled: true, instant: true, reply };
      }

      case 'doctor': {
        const reply = typeof deps.doctorText === 'function' ? await deps.doctorText() : 'Диагностика систем недоступна.';
        return { handled: true, instant: true, reply };
      }

      case 'storage': {
        const reply = typeof deps.storageText === 'function' ? await deps.storageText() : 'Данные о хранилище недоступны.';
        return { handled: true, instant: true, reply };
      }

      case 'permissions': {
        const lines = [
          `Режим: ${mode}${ephemeral ? ' (временный чат)' : ''}`,
          `Изоляция облака: ${isolated ? 'ВКЛ (облако и внешние агенты запрещены)' : 'ВЫКЛ (облако разрешено с защитой секретов/Tor)'}`,
          `Запись в общую память/Obsidian: ${isolated ? 'ЗАПРЕЩЕНА' : 'разрешена (с проверкой Tor)'}`,
          `Режим планирования (plan-mode): ${state.planMode ? 'включён' : 'выключен'}`,
        ];
        return { handled: true, instant: true, reply: lines.join('\n') };
      }

      case 'memory': {
        if (isolated && mode !== 'private') {
          return { handled: true, instant: true, reply: 'В изолированном режиме долговременная память отключена.' };
        }
        const reply = typeof deps.memoryText === 'function' ? await deps.memoryText(args, { mode, ephemeral }) : 'Память пуста.';
        return { handled: true, instant: true, reply };
      }

      case 'today': {
        const reply = typeof deps.todayText === 'function' ? await deps.todayText({ isolated, mode }) : 'Расписание недоступно.';
        return { handled: true, instant: true, reply };
      }

      case 'mail': {
        const reply = typeof deps.mailText === 'function' ? await deps.mailText(args) : 'Почта недоступна.';
        return { handled: true, instant: true, reply };
      }

      case 'clip': {
        if (isolated && args) {
          return { handled: true, instant: true, error: 'Запись в общий буфер обмена из изолированного режима заблокирована.', reply: 'Запись в общий буфер обмена из изолированного режима заблокирована.' };
        }
        const reply = typeof deps.clipText === 'function' ? await deps.clipText(args) : 'Буфер обмена недоступен.';
        return { handled: true, instant: true, reply };
      }

      case 'alta': {
        if (ephemeral || mode === 'nsfw' || mode === 'tor') {
          return { handled: true, instant: true, reply: 'Чтение Obsidian выключено для этого режима чата.' };
        }
        const reply = typeof deps.altaText === 'function' ? await deps.altaText() : 'Сводка ALTA недоступна.';
        return { handled: true, instant: true, reply };
      }

      case 'agents': {
        const reply = typeof deps.agentsText === 'function' ? await deps.agentsText() : 'Список агентов Хаба недоступен.';
        return { handled: true, instant: true, reply };
      }

      case 'harness': {
        const reply = typeof deps.harnessText === 'function' ? await deps.harnessText(args) : 'Харнесс недоступен.';
        return { handled: true, instant: true, reply };
      }

      case 'web': {
        if (!args) return { handled: true, instant: true, reply: 'Укажи поисковый запрос: /web <запрос>' };
        const reply = typeof deps.webText === 'function' ? await deps.webText(args) : 'Веб-поиск недоступен.';
        return { handled: true, instant: true, reply };
      }

      case 'tor': {
        if (!args) return { handled: true, instant: true, reply: 'Укажи запрос для Tor: /tor <запрос>' };
        const reply = typeof deps.torText === 'function' ? await deps.torText(args) : 'Tor-поиск недоступен.';
        return { handled: true, instant: true, reply };
      }

      case 'nomad': {
        if (!args) return { handled: true, instant: true, reply: 'Укажи запрос для библиотеки NOMAD: /nomad <запрос>' };
        const reply = typeof deps.nomadText === 'function' ? await deps.nomadText(args) : 'Библиотека NOMAD/Kiwix недоступна.';
        return { handled: true, instant: true, reply };
      }

      case 'copy': {
        const lastAssistant = Array.isArray(history) ? history.findLast((m) => m?.role === 'assistant')?.content : '';
        const textToCopy = args || lastAssistant || '';
        if (textToCopy && typeof deps.setClipboard === 'function' && !isolated) {
          await deps.setClipboard(textToCopy);
        }
        return {
          handled: true,
          instant: true,
          action: 'copy',
          copied: Boolean(textToCopy),
          reply: textToCopy ? 'Скопировала последний ответ в буфер обмена.' : 'Нет ответа для копирования.',
        };
      }

      case 'export': {
        const fmt = args.toLowerCase() === 'json' ? 'json' : 'md';
        const rows = Array.isArray(history) ? history : [];
        const exportContent = fmt === 'json'
          ? JSON.stringify(rows, null, 2)
          : rows.map((m) => `### ${m.role === 'user' ? 'Пользователь' : 'Ассистент'}\n${m.content}`).join('\n\n');
        return {
          handled: true,
          instant: true,
          action: 'export',
          format: fmt,
          exportContent,
          reply: rows.length
            ? `Экспорт готов (${fmt.toUpperCase()}, ${rows.length} сообщ.).`
            : 'История пуста — нечего экспортировать.',
        };
      }

      case 'insights': {
        const reply = typeof deps.insightsText === 'function' ? await deps.insightsText({ isolated }) : 'Статистика недоступна.';
        return { handled: true, instant: true, reply };
      }

      case 'stop': {
        if (typeof deps.stop === 'function') await deps.stop({ sessionId, requestId: payload.requestId });
        return { handled: true, instant: true, action: 'stop', reply: 'Останавливаю текущую генерацию.' };
      }

      // --- Session & Mutating commands ---
      case 'new': {
        if (typeof deps.newChat === 'function') await deps.newChat({ mode, ephemeral, sessionId });
        return { handled: true, instant: true, action: 'new', reply: 'Начинаем новый разговор.' };
      }

      case 'retry': {
        return { handled: true, instant: true, action: 'retry', reply: 'Повторяю последний запрос.' };
      }

      case 'compact': {
        const compacted = typeof deps.compact === 'function'
          ? await deps.compact({ mode, ephemeral, agent, sessionId, model, history, focus: args })
          : await compactHistory({ history: history || [], focus: args, mode, ephemeral, model, provider: agent || 'ollama' });
        const reply = compacted.droppedCount > 0
          ? `Сжала ${compacted.droppedCount} старых реплик (оставлено ${compacted.keptCount}). Контекст: ${compacted.context?.percent ?? 0}%.`
          : 'История ещё короткая — сжимать нечего.';
        return {
          handled: true,
          instant: false,
          action: 'compact',
          compacted,
          context: compacted.context,
          reply,
        };
      }

      case 'learn': {
        if (isolated) return { handled: true, instant: true, error: 'В изолированном режиме навыки из диалога не сохраняю.', reply: 'В изолированном режиме навыки из диалога не сохраняю.' };
        if (typeof deps.learnSkill !== 'function') return { handled: true, instant: true, reply: '/learn недоступен.' };
        const res = await deps.learnSkill({ mode, ephemeral, agent, sessionId, history, hint: args });
        if (!res?.ok) return { handled: true, instant: false, error: res?.error, reply: res?.error || 'Навык не сохранён.' };
        return {
          handled: true,
          instant: false,
          action: 'skills-changed',
          learned: { id: res.id, name: res.name, path: res.path },
          reply: `Выучила навык /${res.id} — «${res.name}»: ${res.description || ''}\n`
            + `Теперь он подбирается сам, когда запрос похож; вызвать вручную — /${res.id}. Файл: ${res.path}\n`
            + `Приложить справочные файлы — /навык-файлы ${res.id}.`,
        };
      }

      case 'skill-files': {
        const id = args.trim().replace(/^\//, '');
        if (!id) return { handled: true, instant: true, reply: 'Укажи навык: /навык-файлы <имя>.' };
        if (typeof deps.attachSkillFiles !== 'function') return { handled: true, instant: true, reply: 'Приложить файлы можно только на ПК.' };
        const res = await deps.attachSkillFiles({ id });
        const tail = res?.skipped?.length ? `\nПропущено: ${res.skipped.join('; ')}.` : '';
        if (!res?.ok) return { handled: true, instant: true, error: res?.error, reply: `${res?.error || 'Не вышло.'}${tail}` };
        return { handled: true, instant: true, action: 'skills-changed', reply: `К /${id} приложено: ${res.added.join(', ')}. Всего файлов: ${res.files.length}.${tail}` };
      }

      case 'remember': {
        if (isolated) {
          return { handled: true, instant: true, error: 'В изолированном режиме запись в общую память запрещена.', reply: 'В изолированном режиме запись в общую память запрещена.' };
        }
        if (!args) return { handled: true, instant: true, reply: 'Укажи, что запомнить: /remember <факт>' };
        const reply = typeof deps.remember === 'function' ? await deps.remember(args) : 'Сохранение в память недоступно.';
        return { handled: true, instant: true, reply };
      }

      case 'save': {
        if (isolated) {
          return { handled: true, instant: true, error: 'В изолированном режиме сохранение в общий Obsidian запрещено.', reply: 'В изолированном режиме сохранение в общий Obsidian запрещено.' };
        }
        const reply = typeof deps.saveNote === 'function' ? await deps.saveNote(args, history) : 'Сохранение заметки недоступно.';
        return { handled: true, instant: true, reply };
      }

      case 'plan': {
        if (isolated) {
          return { handled: true, instant: true, error: 'В изолированном режиме запись в Планировщик/Obsidian отключена.', reply: 'В изолированном режиме запись в Планировщик/Obsidian отключена.' };
        }
        if (!args) return { handled: true, instant: true, reply: 'Укажи задачу: /plan <текст>' };
        const reply = typeof deps.createPlan === 'function' ? await deps.createPlan(args) : 'Планировщик недоступен.';
        return { handled: true, instant: true, reply };
      }

      case 'remind': {
        if (isolated) {
          return { handled: true, instant: true, error: 'В изолированном режиме напоминания отключены.', reply: 'В изолированном режиме напоминания отключены.' };
        }
        if (!args) return { handled: true, instant: true, reply: 'Формат: /remind через 15 минут проверить сборку' };
        const reply = typeof deps.createReminder === 'function' ? await deps.createReminder(args) : 'Напоминания недоступны.';
        return { handled: true, instant: true, reply };
      }

      case 'model': {
        if (!args) {
          return { handled: true, instant: true, action: 'model', state, reply: `Текущая модель: ${model || 'auto'}. Укажи имя: /model <имя>.` };
        }
        if (typeof deps.switchModel === 'function') {
          const r = await deps.switchModel(args, { agent, sessionId, mode, ephemeral });
          if (r?.ok) {
            return { handled: true, instant: true, action: 'model', model: r.model, state, reply: `Модель переключена на ${r.model}.` };
          }
          return { handled: true, instant: true, action: 'model', error: r?.error || `Модель «${args}» не найдена.`, reply: r?.error || `Модель «${args}» не найдена.` };
        }
        return { handled: true, instant: true, action: 'model', model: args, state, reply: `Выбрана модель ${args}.` };
      }

      case 'temp': {
        if (!args) {
          const nextState = this.updateState(sessionId, { temp: state.temp === null ? 0.7 : null });
          return { handled: true, instant: true, action: 'temp', state: nextState, reply: nextState.temp === null ? 'Температура сброшена к значению по умолчанию.' : `Температура установлена: ${nextState.temp}.` };
        }
        if (/^(off|reset|default|сброс)$/i.test(args)) {
          const nextState = this.updateState(sessionId, { temp: null });
          return { handled: true, instant: true, action: 'temp', state: nextState, reply: 'Температура сброшена к значению по умолчанию.' };
        }
        const num = Number(args.replace(',', '.'));
        if (!Number.isFinite(num) || num < 0 || num > 2) {
          return { handled: true, instant: true, error: 'Укажи температуру от 0 до 2 (например: /temp 0.3).', reply: 'Укажи температуру от 0 до 2 (например: /temp 0.3).' };
        }
        const nextState = this.updateState(sessionId, { temp: Math.round(num * 100) / 100 });
        return { handled: true, instant: true, action: 'temp', state: nextState, reply: `Температура установлена: ${nextState.temp}.` };
      }

      case 'effort': {
        const val = args.toLowerCase();
        if (!val) {
          return { handled: true, instant: true, action: 'effort', state, reply: `Текущий effort: ${state.effort}. Доступно: low, medium, high, xhigh.` };
        }
        if (!VALID_EFFORTS.has(val)) {
          return { handled: true, instant: true, error: 'Допустимые значения effort: low, medium, high, xhigh.', reply: 'Допустимые значения effort: low, medium, high, xhigh.' };
        }
        const nextState = this.updateState(sessionId, { effort: val });
        return { handled: true, instant: true, action: 'effort', state: nextState, reply: `Уровень effort: ${nextState.effort}.` };
      }

      case 'output-style': {
        const val = args.toLowerCase();
        if (!val) {
          return { handled: true, instant: true, action: 'output-style', state, reply: `Текущий стиль ответа: ${state.outputStyle}. Доступно: default, concise, detailed, technical, bullets.` };
        }
        if (!VALID_OUTPUT_STYLES.has(val)) {
          return { handled: true, instant: true, error: 'Допустимые стили: default, concise, detailed, technical, bullets.', reply: 'Допустимые стили: default, concise, detailed, technical, bullets.' };
        }
        const nextState = this.updateState(sessionId, { outputStyle: val });
        return { handled: true, instant: true, action: 'output-style', state: nextState, reply: `Стиль ответа: ${nextState.outputStyle}.` };
      }

      case 'plan-mode': {
        const nextVal = /^on|вкл$/i.test(args) ? true : /^off|выкл$/i.test(args) ? false : !state.planMode;
        const nextState = this.updateState(sessionId, { planMode: nextVal });
        return { handled: true, instant: true, action: 'plan-mode', state: nextState, reply: nextVal ? 'Режим планирования включён.' : 'Режим планирования выключен.' };
      }

      case 'focus': {
        const nextVal = /^on|вкл$/i.test(args) ? true : /^off|выкл$/i.test(args) ? false : !state.focus;
        const nextState = this.updateState(sessionId, { focus: nextVal });
        return { handled: true, instant: true, action: 'focus', state: nextState, reply: nextVal ? 'Режим фокуса включён.' : 'Режим фокуса выключен.' };
      }

      case 'autocompact': {
        let patch;
        const pctMatch = /^(\d{2,3})%?$/.exec(args);
        if (pctMatch) {
          patch = { autocompact: true, autocompactThreshold: Number(pctMatch[1]) };
        } else if (/^on|вкл$/i.test(args)) {
          patch = { autocompact: true };
        } else if (/^off|выкл$/i.test(args)) {
          patch = { autocompact: false };
        } else {
          patch = { autocompact: !state.autocompact };
        }
        const nextState = this.updateState(sessionId, patch);
        return {
          handled: true,
          instant: true,
          action: 'autocompact',
          state: nextState,
          reply: nextState.autocompact
            ? `Автосжатие включено (порог ${nextState.autocompactThreshold}%).`
            : 'Автосжатие выключено.',
        };
      }

      case 'advisor': {
        const nextVal = (!args || /^(off|none|выкл)$/i.test(args)) ? null : args;
        const nextState = this.updateState(sessionId, { advisor: nextVal });
        return {
          handled: true,
          instant: true,
          action: 'advisor',
          state: nextState,
          reply: nextState.advisor ? `Модель-советник: ${nextState.advisor}.` : 'Советник отключён.',
        };
      }

      case 'pet': {
        const nextVal = /^on|вкл$/i.test(args) ? true : /^off|выкл$/i.test(args) ? false : !state.pet;
        const nextState = this.updateState(sessionId, { pet: nextVal });
        if (typeof deps.setPet === 'function') await deps.setPet(nextVal);
        return { handled: true, instant: true, action: 'pet', state: nextState, reply: nextVal ? 'Спутник Капри показан.' : 'Спутник Капри скрыт.' };
      }

      case 'fork': {
        const forked = typeof deps.forkSession === 'function' ? await deps.forkSession({ sessionId, chatId, mode }) : null;
        return {
          handled: true,
          instant: true,
          action: 'fork',
          forked,
          reply: forked?.id ? `Создана ветка диалога (${forked.id}).` : 'Создана ветка текущего диалога.',
        };
      }

      case 'rename': {
        if (!args) return { handled: true, instant: true, action: 'rename', reply: 'Укажи новое название: /rename <название>' };
        if (typeof deps.renameSession === 'function') await deps.renameSession({ sessionId, chatId, title: args, mode });
        return { handled: true, instant: true, action: 'rename', title: args, reply: `Чат переименован: «${args}».` };
      }

      case 'pin': {
        const pinned = /^off|unpin|открепить$/i.test(args) ? false : /^on|pin|закрепить$/i.test(args) ? true : undefined;
        const res = typeof deps.pinSession === 'function' ? await deps.pinSession({ sessionId, chatId, pinned, mode }) : { pinned: pinned ?? true };
        return { handled: true, instant: true, action: 'pin', pinned: Boolean(res?.pinned), reply: res?.pinned ? 'Чат закреплён.' : 'Чат откреплён.' };
      }

      case 'archive': {
        const archived = /^off|unarchive|вернуть$/i.test(args) ? false : /^on|archive|архив$/i.test(args) ? true : undefined;
        const res = typeof deps.archiveSession === 'function' ? await deps.archiveSession({ sessionId, chatId, archived, mode }) : { archived: archived ?? true };
        return { handled: true, instant: true, action: 'archive', archived: Boolean(res?.archived), reply: res?.archived ? 'Чат убран в архив.' : 'Чат возвращён из архива.' };
      }

      case 'delete': {
        if (!confirm) {
          return {
            handled: true,
            instant: true,
            confirmRequired: true,
            action: 'delete',
            reply: 'Удаление чата необратимо. Подтверди удаление.',
          };
        }
        if (typeof deps.deleteSession === 'function') await deps.deleteSession({ sessionId, chatId, mode });
        return { handled: true, instant: true, action: 'delete', deleted: true, reply: 'Чат удалён.' };
      }

      case 'resume': {
        return {
          handled: true,
          instant: true,
          action: 'resume',
          sessionId: args || sessionId || null,
          reply: args ? `Продолжаем диалог ${args}.` : 'Выбери чат из списка для продолжения.',
        };
      }

      default:
        return { handled: true, instant: true, reply: `Команда /${id} выполнена.` };
    }
  }
}

module.exports = {
  BUILTIN_COMMANDS,
  PLUGIN_COMMANDS,
  CONNECTOR_COMMANDS,
  TOOLS_COMMANDS,
  PHONE_COMMANDS,
  STYLES_COMMANDS,
  COMMAND_CATEGORIES,
  DRAFT_PLUGINS,
  DRAFT_CONNECTORS,
  DRAFT_STYLES,
  DEFAULT_SESSION_STATE,
  INSTANT_COMMAND_IDS,
  PROMPT_INSTRUCTIONS,
  SlashCommandEngine,
  buildRegistry,
  buildChainPrompt,
  parseSlashInput,
  compactHistory,
  buildExtractiveSummary,
  scanSkillsOnDisk,
  parseSkillFrontmatter,
  isIsolatedMode,
  normalizeState,
  defaultSkillRoots,
};
