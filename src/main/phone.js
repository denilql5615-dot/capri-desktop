'use strict';

// ALTAI:RE phone bridge (wire-compatible with Bridge.kt & GENESIS):
//   GET  /ping                    -> { ok, pose, sprites }
//   GET  /suggestions?mode=...    -> { mode, items: [{ title, prompt }], cachedAt } (E4B cached 45m)
//   POST /chat { text, voice, requestId?, ephemeral?, mode?, skills?, tool? } -> { reply, brain, pose, audio?, image? }
//   GET  /chat/status?requestId=... / POST /chat/stop { requestId } -> { state }
//   POST /deep-research { query } -> { reply, workers, rector, obsidianPath? }
//   POST /event { kind }          -> { ok }
//   GET  /audio/<id>              -> mp3
//   GET  /sprites                 -> { pack, version, poses }
//   GET  /control / POST /control -> state

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { MAX_UPLOAD_BYTES } = require('./hub-artifacts');

const MAX_BODY = 64 * 1024;
const MAX_RESEARCH_REPORT_BYTES = 256 * 1024;
const AUDIO_TTL_MS = 10 * 60 * 1000;
const AUDIO_MAX = 20;
const TURNS = 12;
const CHAT_REQUEST_LIMIT = 64;
const CHAT_REQUEST_TTL_MS = 20 * 60 * 1000;
const ISOLATED_CHAT_REQUEST_TTL_MS = 2 * 60 * 1000;
const CHAT_STOPPED = { reply: 'Запрос остановлен.', brain: 'stopped', pose: '' };
const CHAT_ABORTED = { ...CHAT_STOPPED, brain: 'error' };
const { PHONE_MODEL_KEYS } = require('./phone-model');
const { getContextLimits, buildContextStats } = require('./context-stats');
const {
  SlashCommandEngine,
  parseSlashInput,
  compactHistory,
  buildChainPrompt,
  isIsolatedMode,
} = require('./slash-commands');
const { SkillsEngine } = require('./skills-engine');
const { PluginsEngine } = require('./plugins-engine');
const { ConnectorsEngine, parseModelUseTag, stripModelUseTags } = require('./connectors-engine');
const { DockerEngine } = require('./docker-engine');
const { PcToolsEngine } = require('./pc-tools-engine');
const { PhoneControlEngine } = require('./phone-control-engine');
const SUGGESTIONS_TTL_MS = 45 * 60 * 1000; // 45 минут кэша подсказок от E4B
const WORKER_COOLDOWN_MS = 30 * 60 * 1000; // 30 минут кулдауна для уставших воркеров Deep Research
const RESEARCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseModelCommand(text) {
  const t = String(text || '').trim();
  const ru = /^(?:переключись|переключи|смени|поставь|выбери|используй|включи|перейди|давай)(?:\s+модель)?(?:\s+на)?(?:\s+модель)?\s+(.+)$/i.exec(t);
  const en = /^(?:switch|change|use)(?:\s+model)?(?:\s+to)?\s+(.+)$/i.exec(t);
  return (ru?.[1] || en?.[1] || '').replace(/[.!?…]+$/, '').replace(/\s+(?:модель|model)$/i, '').trim() || null;
}

const newToken = () => crypto.randomBytes(18).toString('base64url');

function tokenMatches(got, want) {
  if (!want) return false;
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(got), h(want));
}

function addresses(port) {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  return [...new Set(ips)]
    .sort((a, b) => Number(!a.startsWith('100.')) - Number(!b.startsWith('100.')) || a.localeCompare(b))
    .map((ip) => `http://${ip}:${port}`);
}

const PHONE_NOTE = 'Канал: телефон (ALTAI:RE). Соразмеряй ответ с запросом: бытовая реплика коротко, сложная задача с нужными деталями. '
  + 'Ничего опасного на ПК самовольно не запускай без подтверждения. '
  + 'Никогда не утверждай, что записала заметку, создала задачу, нашла данные в Vault или передала работу агенту, если в контексте нет явного результата этого инструмента.';

const SKILL_NOTES = {
  'i-have-adhd': 'Режим i-have-adhd: сначала дай конкретный следующий шаг, потом нумерованные пункты, без длинных вступлений и отвлечений.',
  'caveman': 'Режим caveman: отвечай максимально сжато, сразу с сути, без вежливых вступлений и итоговых повторов. Код, пути, команды и цифры оставляй дословно. Для предупреждений о необратимых действиях переходи на обычный ясный текст.',
};

const DEFAULT_SUGGESTIONS = {
  chat: [
    [
      { title: 'Что горит по делам и календарю', prompt: 'Проверь мои ближайшие планы, календарь и важные заметки в памяти' },
      { title: 'Продолжить последнюю тему из чатов', prompt: 'Вспомни о чём мы говорили в последний раз и предложи следующий шаг' },
      { title: 'Быстрый разбор новой идеи', prompt: 'Разбери мою идею по полочкам: плюсы, риски и что проверить первым' },
    ],
    [
      { title: 'Сводка свежих писем и встреч', prompt: 'Покажи свежие письма и что запланировано на сегодня' },
      { title: 'Проверить активные напоминания', prompt: 'Какие у меня сейчас активные напоминания и задачи в планировщике' },
      { title: 'Короткий план на вечер', prompt: 'Помоги набросать короткий реалистичный план на остаток дня' },
    ],
    [
      { title: 'Что нового в заметках памяти', prompt: 'Найди в обсидиане последние заметки по моим текущим проектам' },
      { title: 'Разобрать спорное решение', prompt: 'Проверь моё решение на слабые места и скрытые допущения' },
      { title: 'Статус ноутбука и ресурсов', prompt: 'Покажи статус ПК: память, видеокарта и свободное место на дисках' },
    ],
    [
      { title: 'Сформулировать короткое сообщение', prompt: 'Помоги написать короткое деловое сообщение без воды и штампов' },
      { title: 'Сравнить два варианта действий', prompt: 'Сравни два варианта: что быстрее, что надёжнее и где меньше рисков' },
      { title: 'Что сейчас играет на ПК', prompt: 'Какая сейчас музыка играет на ноутбуке' },
    ],
    [
      { title: 'Быстрая проверка факта', prompt: 'Объясни простыми словами суть вопроса и выдели проверенные факты' },
      { title: 'Напомнить о важном деле', prompt: 'Напомни через 30 минут проверить сборку и тесты' },
      { title: 'Разгрузить голову на три шага', prompt: 'Разбей мою текущую загрузку на три простых последовательных шага' },
    ],
    [
      { title: 'Итоги дня по проектам', prompt: 'Помоги подвести короткий итог того, что сделано за сегодня' },
      { title: 'Проверить свободные окна завтра', prompt: 'Какие планы у меня на завтра и когда есть свободное окно' },
      { title: 'Оценить идею без поддакивания', prompt: 'Критически оцени идею: где логика хромает и что может пойти не так' },
    ],
    [
      { title: 'Найти договорённости в базе', prompt: 'Найди в обсидиане мои последние договорённости и правила' },
      { title: 'Собрать вопросы к созвону', prompt: 'Помоги составить 5 точных вопросов для предстоящего обсуждения' },
      { title: 'Проверить очередь агентов в Хабе', prompt: 'Чем сейчас заняты агенты в Хабе' },
    ],
    [
      { title: 'Краткий конспект длинной мысли', prompt: 'Сожми мою мысль до трёх ясных тезисов без потери смысла' },
      { title: 'Что по плану ALTA', prompt: 'Что там по плану ALTA и какие ближайшие вехи' },
      { title: 'Освободить память видеокарты', prompt: 'Освободи память и проверь сколько свободно VRAM' },
    ],
    [
      { title: 'Разобрать плюсы и минусы покупки', prompt: 'Сделай трезвый разбор характеристик и слабых мест перед покупкой' },
      { title: 'Планы на ближайшую неделю', prompt: 'Покажи моё расписание и задачи на ближайшую неделю' },
      { title: 'Зафиксировать новую заметку', prompt: 'Запомни ключевой факт из нашего сегодняшнего разговора' },
    ],
    [
      { title: 'Быстрый старт рабочего спринта', prompt: 'Выдели одну главную задачу на ближайший час, чтобы не распыляться' },
      { title: 'Проверить буфер обмена ПК', prompt: 'Что сейчас лежит в буфере обмена ПК' },
      { title: 'Сверить аргументы перед спором', prompt: 'Проверь мои аргументы на логические дыры и подскажи контрдоводы' },
    ],
  ],
  task: [
    [
      { title: 'Разобрать свежий дифф и тесты проекта', prompt: 'Посмотри последние изменения в репозитории и подскажи, где могут быть баги' },
      { title: 'Собрать план закрытия задач по ALTA', prompt: 'Составь чёткий план действий на сегодня по приоритетам' },
      { title: 'Проверить логи и память за неделю', prompt: 'Подними свежие записи из памяти и выдели главное' },
    ],
    [
      { title: 'Найти причину падения теста', prompt: 'Разбери стек ошибки и назови точную причину падения и минимальный фикс' },
      { title: 'Проверить краевые случаи модуля', prompt: 'Перечисли узкие места и пограничные случаи, которые нужно покрыть тестами' },
      { title: 'Сверить контракт API и типов', prompt: 'Проверь совместимость полей запроса и ответа между клиентом и сервером' },
    ],
    [
      { title: 'Декомпозировать фичу на диффы', prompt: 'Разбей задачу на маленькие независимые шаги без лишнего рефакторинга' },
      { title: 'Аудит утечек памяти и таймеров', prompt: 'Проверь жизненный цикл подписок, таймеров и кэшей на утечки' },
      { title: 'Собрать чек-лист приёмки этапа', prompt: 'Составь конкретный список проверок для приёмки текущей задачи' },
    ],
    [
      { title: 'Ревью обработки сетевых ошибок', prompt: 'Проверь таймауты, повторы и отмену запросов при обрыве соединения' },
      { title: 'Упростить сложную функцию', prompt: 'Предложи как упростить логику без создания лишних абстракций' },
      { title: 'Проверить изоляцию состояний чата', prompt: 'Убедись, что переключение режимов и моделей не смешивает состояние' },
    ],
    [
      { title: 'Написать минимальный регрессионный тест', prompt: 'Набросай точечный тест, который воспроизводит баг и страхует фикс' },
      { title: 'Разобрать узкое место по VRAM/ОЗУ', prompt: 'Оцени расход памяти и предложи как избежать двойной загрузки моделей' },
      { title: 'Сверить правила безопасности и путей', prompt: 'Проверь валидацию путей, границ каталогов и экранирование ввода' },
    ],
    [
      { title: 'Подготовить сводку по коммитам', prompt: 'Собери краткую техническую сводку изменений для рабочего журнала' },
      { title: 'Проверить кодировку и парсинг JSON', prompt: 'Проверь обработку неполных чанков, UTF-8 и пустых ответов в потоке' },
      { title: 'Оценить риски миграции конфига', prompt: 'Проверь обратную совместимость новых полей конфига со старыми данными' },
    ],
    [
      { title: 'Разобрать гонку асинхронных вызовов', prompt: 'Найди потенциальную гонку между очередью запросов и кнопкой отмены' },
      { title: 'Сверить UI-состояния с бэкендом', prompt: 'Проверь, чтобы индикаторы загрузки и ошибок точно отражали ответ сервера' },
      { title: 'Отфильтровать устаревшие задачи', prompt: 'Сверь список открытых задач с тем, что уже закрыто в коде' },
    ],
    [
      { title: 'Проверить работу офлайн-сборки', prompt: 'Что нужно проверить перед запуском профильной офлайн-сборки и тестов' },
      { title: 'Анализ производительности рендера', prompt: 'Найди лишние перерисовки и блокировки главного потока в интерфейсе' },
      { title: 'Собрать ТЗ на исправление бага', prompt: 'Оформи чёткое описание бага: файл, строка, причина и ожидаемое поведение' },
    ],
    [
      { title: 'Проверить идемпотентность повтора', prompt: 'Убедись, что повтор запроса с тем же ID не создаёт дублей в истории' },
      { title: 'Ревью структуры хранения заметок', prompt: 'Проверь атомарность записи файлов и защиту от повреждения при сбое' },
      { title: 'Сформировать план стендовых проверок', prompt: 'Составь порядок проверки сценариев на живом стенде ПК и телефона' },
    ],
    [
      { title: 'Найти расхождения со спецификацией', prompt: 'Сравни текущую реализацию с требованиями этапа и выпиши пробелы' },
      { title: 'Проверить очистку временных ресурсов', prompt: 'Проверь удаление временных файлов и закрытие дескрипторов в finally' },
      { title: 'Подготовить финальный отчёт этапа', prompt: 'Собери итог: что исправлено, какие тесты прошли и что осталось проверить' },
    ],
  ],
  cloud: [
    [
      { title: 'Архитектурное ревью текущего этапа', prompt: 'Проведи жёсткое архитектурное ревью моего текущего решения' },
      { title: 'Проверить свежие релизы и бенчмарки', prompt: 'Найди свежие релизы и сравнения моделей по моей задаче' },
      { title: 'Собрать ТЗ и промпт для агента', prompt: 'Помоги сформулировать точное ТЗ с критериями приёмки' },
    ],
    [
      { title: 'Глубокий аудит безопасности кода', prompt: 'Проверь архитектуру на векторы атак, утечки данных и обход границ' },
      { title: 'Сравнить подходы в индустрии', prompt: 'Сравни как эта задача решается в современных продакшен-системах' },
      { title: 'Спроектировать контракт протокола', prompt: 'Разработай минималистичный и надёжный протокол обмена с обработкой сбоев' },
    ],
    [
      { title: 'Найти корневую причину сложного бага', prompt: 'Проанализируй симптомы и выдвини ранжированные гипотезы причины сбоя' },
      { title: 'Оптимизировать пайплайн инференса', prompt: 'Предложи настройки контекста, батчинга и квантования под 8 ГБ VRAM' },
      { title: 'Составить план рефакторинга модуля', prompt: 'Напиши пошаговый план распутывания зависимостей без поломки тестов' },
    ],
    [
      { title: 'Проверить математику и алгоритмы', prompt: 'Проверь формулы скоринга, весов и ранжирования на вырожденные случаи' },
      { title: 'Синтез выводов из нескольких докладов', prompt: 'Сведи разные точки зрения в один проверенный отчёт с таблицей рисков' },
      { title: 'Ревью UX и сценариев отказа', prompt: 'Проверь пользовательский путь при потере сети, таймауте и нехватке квот' },
    ],
    [
      { title: 'Разбор документации нового API', prompt: 'Выдели главное из спецификации API: лимиты, форматы и подводные камни' },
      { title: 'Подготовить питч или описание релиза', prompt: 'Напиши живое и точное описание проекта без рекламных штампов' },
      { title: 'Оценить сложность и риски фичи', prompt: 'Оцени трудоёмкость, скрытые зависимости и точки возможного отказа' },
    ],
    [
      { title: 'Сравнить модели под конкретную роль', prompt: 'Сравни точность, стоимость квот и скорость моделей для моей задачи' },
      { title: 'Построить матрицу тестовых сценариев', prompt: 'Составь полную матрицу позитивных, негативных и нагрузочных тестов' },
      { title: 'Проверить устойчивость к инъекциям', prompt: 'Оцени защиту пайплайна от prompt-injection при чтении внешних текстов' },
    ],
    [
      { title: 'Разработать схему миграции данных', prompt: 'Предложи безопасную схему обновления формата хранения с откатом' },
      { title: 'Анализ геймдизайна и баланса', prompt: 'Разбери механику, кривую сложности и удержание игрока на узкие места' },
      { title: 'Сформировать контракт для роя агентов', prompt: 'Опиши роли, входные данные и критерии готовности для параллельных воркеров' },
    ],
    [
      { title: 'Найти узкие места в сетевом стеке', prompt: 'Проанализируй задержки, ретраи и сериализацию между телефоном и ПК' },
      { title: 'Критическая проверка бизнес-логики', prompt: 'Найди противоречия в правилах и случаях пересечения нескольких режимов' },
      { title: 'Собрать эталонный системный промпт', prompt: 'Напиши компактный системный промпт с жёсткими границами и без воды' },
    ],
    [
      { title: 'Проверить совместимость Android 16', prompt: 'Какие ограничения фоновой работы, сети и разрешений нужно учесть на Android 16' },
      { title: 'Разбор архитектуры RAG и памяти', prompt: 'Оцени схему индексации, дедупликации и фильтрации карточек памяти' },
      { title: 'Подготовить план релизной сборки', prompt: 'Составь чек-лист подписи, проверки APK и валидации перед установкой' },
    ],
    [
      { title: 'Постмортем прошедшего инцидента', prompt: 'Собери структурный постмортем: хронология, корень проблемы и защита на будущее' },
      { title: 'Сравнить библиотеки и зависимости', prompt: 'Оцени стоит ли брать внешнюю зависимость или проще написать 30 строк' },
      { title: 'Итоговое ревью перед слиянием ветки', prompt: 'Проверь чистоту диффа, покрытие тестами и соблюдение всех инвариантов' },
    ],
  ],
  private: [
    [
      { title: 'Поиск по изолированному Vault', prompt: 'Найди в моём изолированном Vault заметки по теме' },
      { title: 'Разобрать чувствительный вопрос локально', prompt: 'Разберём вопрос строго локально, без выхода в облако' },
      { title: 'Свести личные заметки в один план', prompt: 'Собери мои локальные заметки в структурированный список' },
    ],
    [
      { title: 'Проверить закрытые записи по проекту', prompt: 'Подними из приватного Vault материалы и выдели ключевые даты' },
      { title: 'Анализ документа в закрытом контуре', prompt: 'Разбери текст строго на локальной модели без внешней отправки' },
      { title: 'Сверить факты внутри приватного архива', prompt: 'Найди противоречия или устаревшие пункты в моих закрытых заметках' },
    ],
    [
      { title: 'Составить приватную сводку решений', prompt: 'Собери принятые решения из изолированного Vault в короткую памятку' },
      { title: 'Оценить риски opsec и утечек', prompt: 'Проверь мой план на возможные точки утечки метаданных или ключей' },
      { title: 'Структурировать черновик в карточку', prompt: 'Оформи мои сырые мысли в чистую локальную карточку для приватного Vault' },
    ],
    [
      { title: 'Найти связанные темы в закрытой базе', prompt: 'Какие ещё записи в приватном Vault связаны с этим вопросом' },
      { title: 'Локальный разбор личной дилеммы', prompt: 'Помоги взвесить за и против в личном вопросе без сохранения в общий лог' },
      { title: 'Проверить полноту приватного конспекта', prompt: 'Чего не хватает в моих закрытых заметках по этой теме' },
    ],
    [
      { title: 'Сжать приватные записи до тезисов', prompt: 'Выжми главные выводы из найденных в приватном Vault заметок' },
      { title: 'Локальная проверка конфигов и путей', prompt: 'Проверь настройки на отсутствие пересечений с общими папками и облаком' },
      { title: 'Подготовить закрытый список вопросов', prompt: 'Составь список вопросов для личной проверки без внешних ссылок' },
    ],
    [
      { title: 'Поиск по старым записям сейфа', prompt: 'Найди в приватном Vault упоминания и контекст по ключевому слову' },
      { title: 'Разобрать финансовый или личный расчёт', prompt: 'Проверь цифры и логику расчёта строго на локальной модели' },
      { title: 'Собрать хронологию из закрытых заметок', prompt: 'Выстрой события и заметки из приватного Vault в хронологическом порядке' },
    ],
    [
      { title: 'Аудит границ приватного хранения', prompt: 'Перечисли какие данные остаются только в приватном Vault и что блокируется' },
      { title: 'Редактура личного текста офлайн', prompt: 'Вычитай и улучши мой черновик локально без отправки на внешние серверы' },
      { title: 'Выделить приоритеты из личного архива', prompt: 'Отранжируй мои закрытые задачи по важности и срочности' },
    ],
    [
      { title: 'Сравнить две версии приватной заметки', prompt: 'Покажи в чём разница между подходами в моих локальных записях' },
      { title: 'Локальный мозговой штурм в тишине', prompt: 'Предложи три нетривиальных хода по моей задаче внутри закрытого контура' },
      { title: 'Проверить зависимости личного плана', prompt: 'Какие шаги в моём приватном плане блокируют друг друга' },
    ],
    [
      { title: 'Подготовить тезисы для закрытой памятки', prompt: 'Сформулируй чёткие правила и памятку для сохранения в приватный Vault' },
      { title: 'Найти пробелы в локальной базе знаний', prompt: 'Какие темы в моём приватном Vault описаны неполно и требуют уточнения' },
      { title: 'Разбор чувствительного лога офлайн', prompt: 'Проанализируй фрагмент лога локально и укажи на аномалии' },
    ],
    [
      { title: 'Итоговая выжимка по закрытой теме', prompt: 'Собери финальную сводку по теме только из материалов приватного Vault' },
      { title: 'Проверить гипотезу на локальных данных', prompt: 'Подтверждают ли записи в моём приватном Vault эту гипотезу' },
      { title: 'Очистить план от лишних деталей', prompt: 'Оставь в моём локальном плане только конкретные проверяемые действия' },
    ],
  ],
  nsfw: [
    [
      { title: 'Продолжить сцену с того же места', prompt: 'Продолжи нашу последнюю сцену, сохраняя характер и тон' },
      { title: 'Задать новый сеттинг и правила', prompt: 'Давай зададим новый сеттинг и персонажей для сцены' },
      { title: 'Свободный разговор без тормозов', prompt: 'Поболтаем свободно, без лишних ограничений' },
    ],
    [
      { title: 'Ночной бар в Нео-Токио', prompt: 'Запустим сцену: поздний вечер в закрытом неоновом баре, мы остались вдвоём' },
      { title: 'Сменить темп и добавить напряжения', prompt: 'Сделай сцену медленнее, детальнее и добавь больше живых эмоций' },
      { title: 'Отыграть дерзкий диалог наедине', prompt: 'Отвечай дерзко, с иронией и притяжением, без лишней скромности' },
    ],
    [
      { title: 'Закрытая квартира после дождя', prompt: 'Сеттинг: за окном ливень, мы в тёмной квартире, никаких дел до утра' },
      { title: 'Описать сцену от первого лица', prompt: 'Веди повествование ярко и чувственно, описывая взгляды, жесты и атмосферу' },
      { title: 'Предложить три смелых сценария', prompt: 'Предложи три разных ролевых завязки на выбор: от лёгкого флирта до страсти' },
    ],
    [
      { title: 'Игра на желания без отказов', prompt: 'Сыграем в игру на откровенные вопросы и желания один на один' },
      { title: 'Усилить характер и инициативу', prompt: 'Возьми инициативу в сцене на себя и задай более смелый поворот' },
      { title: 'Киберпанк-отель на верхнем этаже', prompt: 'Сцена: пентхаус с видом на ночной мегаполис, тишина и полное доверие' },
    ],
    [
      { title: 'Секретная встреча после долгой разлуки', prompt: 'Отыграем встречу после долгого перерыва, когда оба ждали этого момента' },
      { title: 'Больше деталей в описании действий', prompt: 'Не спеши с сюжетом: описывай прикосновения, дыхание и реакцию подробно' },
      { title: 'Ночной разговор на грани фола', prompt: 'Поговорим откровенно о фантазиях и том, чего хочется прямо сейчас' },
    ],
    [
      { title: 'Сменить роли и расстановку сил', prompt: 'Давай поменяем динамику в сцене: теперь ты ведёшь и диктуешь условия' },
      { title: 'Уютный вечер с вином и музыкой', prompt: 'Начнём со спокойного тёплого вечера наедине, который постепенно накаляется' },
      { title: 'Импровизация по одному слову', prompt: 'Я задаю настроение одним предложением, а ты разворачиваешь полноценную сцену' },
    ],
    [
      { title: 'Случайное знакомство в закрытом клубе', prompt: 'Завязка: взгляды пересеклись в полумраке закрытого лаунжа, подойди первой' },
      { title: 'Сделать диалог живее и острее', prompt: 'Убери шаблонные фразы, говори естественно, прямо и с характером' },
      { title: 'Продолжить без пауз и цензуры', prompt: 'Развивай текущую сцену дальше прямо и подробно, не обрывая на полуслове' },
    ],
    [
      { title: 'Сцена в купе ночного экспресса', prompt: 'Сеттинг: ночной поезд, закрытое купе на двоих и долгая дорога впереди' },
      { title: 'Флирт и провокация с порога', prompt: 'Начни с лёгкой провокации и дразнящего тона, проверяя мою реакцию' },
      { title: 'Свободная фантазия по моим правилам', prompt: 'Сейчас я опишу обстановку и роли, а ты сразу войдёшь в образ' },
    ],
    [
      { title: 'После напряжённого дня — только мы', prompt: 'Сбросим напряжение рабочего дня: переключись на тёплый и близкий тон' },
      { title: 'Добавить неожиданный поворот в сцену', prompt: 'Внеси в наш текущий сюжет внезапную искру, которая изменит обстановку' },
      { title: 'Откровенный монолог без масок', prompt: 'Скажи прямо, чего бы тебе хотелось в этой сцене, не сглаживая углы' },
    ],
    [
      { title: 'Новый персонаж и закрытая локация', prompt: 'Придумай яркий образ и атмосферное место для новой сцены 18+' },
      { title: 'Максимум внимания к атмосфере и темпу', prompt: 'Держи плотный контакт и атмосферу сцены, реагируя на каждую деталь' },
      { title: 'Разговор наедине в полной темноте', prompt: 'Сеттинг: свет погас, остались только голос, шёпот и прикосновения' },
    ],
  ],
};

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

function parsePromptFlags(rawText, body = {}) {
  const validMode = Object.hasOwn(DEFAULT_SUGGESTIONS, body.mode) || body.mode === 'tor';
  if ((body.mode !== undefined && (typeof body.mode !== 'string' || !validMode))
    || (body.ephemeral !== undefined && typeof body.ephemeral !== 'boolean')
    || (body.useVault !== undefined && typeof body.useVault !== 'boolean')) {
    throw Object.assign(new Error('Некорректный режим чата.'), { status: 400 });
  }
  let text = String(rawText || '');
  const skills = new Set(Array.isArray(body.skills) ? body.skills : []);
  let ephemeral = body.ephemeral === true;
  let privateMode = body.mode === 'private';
  let deepResearch = body.tool === 'deep_research';

  const stripTag = (tag, onMatch) => {
    if (text.includes(tag)) {
      onMatch();
      text = text.split(tag).join(' ').trim();
    }
  };
  stripTag('[VAULT_LOCAL_ONLY]', () => { privateMode = true; });
  stripTag('[NO_MEMORY]', () => { ephemeral = true; });
  stripTag('[DEEP_RESEARCH]', () => { deepResearch = true; });
  text = text.replace(/\[SKILL:([a-z0-9][a-z0-9_-]{0,40})\]/gi, (_match, slug) => {
    skills.add(String(slug).toLowerCase());
    return ' ';
  }).replace(/\s{2,}/g, ' ').trim();

  return {
    text: text.trim(),
    ephemeral,
    privateMode,
    deepResearch,
    skills: [...skills],
    ...(body.mode === 'nsfw' && { localMode: 'nsfw', localOnly: true }),
    ...(body.mode === 'tor' && { localMode: 'tor', localOnly: true }),
    ...(body.mode === 'task' && { localMode: 'task' }),
    ...(body.useVault === false && { useVault: false }),
  };
}

class PhoneBridge {
  constructor(deps) {
    this.d = deps;
    this.server = null;
    this.audio = new Map();
    this.turns = [];
    this.suggestionsCache = new Map(); // mode -> { sets, cachedAt }
    this.suggestionIndices = new Map(); // mode -> last setIndex
    this.privateSuggestionsCache = null; // isolated private Vault pool cache
    this.privateSuggestionIndex = -1;
    this.workerCooldowns = new Map(); // workerId -> untilMs
    this.researchRequests = new Map();
    this.researchActivity = new Map();
    this.researchResults = new Map();
    this.queue = Promise.resolve();
    this.chatRequests = new Map();
    this._fallbackSlash = null;
    this._fallbackSkills = null;
    this._fallbackPlugins = null;
    this._fallbackConnectors = null;
    this._fallbackDocker = null;
    this._fallbackPhoneControl = null;
  }

  skillsEngine() {
    if (this.d.skillsEngine) return this.d.skillsEngine;
    if (this.d.slashEngine?.skillsEngine) return this.d.slashEngine.skillsEngine;
    if (!this._fallbackSkills) {
      this._fallbackSkills = new SkillsEngine();
    }
    return this._fallbackSkills;
  }

  pluginsEngine() {
    if (this.d.pluginsEngine) return this.d.pluginsEngine;
    if (this.d.slashEngine?.pluginsEngine) return this.d.slashEngine.pluginsEngine;
    if (!this._fallbackPlugins) {
      this._fallbackPlugins = new PluginsEngine({ skillsEngine: this.skillsEngine() });
    }
    return this._fallbackPlugins;
  }

  connectorsEngine() {
    if (this.d.connectorsEngine) return this.d.connectorsEngine;
    if (this.d.slashEngine?.connectorsEngine) return this.d.slashEngine.connectorsEngine;
    if (!this._fallbackConnectors) {
      this._fallbackConnectors = new ConnectorsEngine({
        deps: {
          pim: this.d.readPim ? { read: this.d.readPim } : null,
          webSearch: this.d.webSearch || null,
        },
      });
    }
    return this._fallbackConnectors;
  }

  dockerEngine() {
    if (this.d.dockerEngine) return this.d.dockerEngine;
    if (this.d.slashEngine?.dockerEngine) return this.d.slashEngine.dockerEngine;
    if (!this._fallbackDocker) {
      this._fallbackDocker = new DockerEngine();
    }
    return this._fallbackDocker;
  }

  pcToolsEngine() {
    if (this.d.pcToolsEngine) return this.d.pcToolsEngine;
    if (this.d.slashEngine?.pcToolsEngine) return this.d.slashEngine.pcToolsEngine;
    if (!this._fallbackPcTools) {
      this._fallbackPcTools = new PcToolsEngine();
    }
    return this._fallbackPcTools;
  }

  phoneControlEngine() {
    if (this.d.phoneControlEngine) return this.d.phoneControlEngine;
    if (this.d.slashEngine?.phoneControlEngine) return this.d.slashEngine.phoneControlEngine;
    if (!this._fallbackPhoneControl) {
      this._fallbackPhoneControl = new PhoneControlEngine({
        onHealthSummary: (summary) => {
          try {
            this.connectorsEngine().saveHealthSummary(summary);
          } catch {}
        },
      });
    }
    return this._fallbackPhoneControl;
  }

  slashEngine() {
    if (this.d.slashEngine) return this.d.slashEngine;
    if (!this._fallbackSlash) {
      this._fallbackSlash = new SlashCommandEngine({
        deps: this.buildSlashDeps(),
        skillsEngine: this.skillsEngine(),
        pluginsEngine: this.pluginsEngine(),
        connectorsEngine: this.connectorsEngine(),
        dockerEngine: this.dockerEngine(),
        pcToolsEngine: this.pcToolsEngine(),
        phoneControlEngine: this.phoneControlEngine(),
        stylesEngine: this.d.stylesEngine || null,
      });
    }
    return this._fallbackSlash;
  }

  buildSlashDeps() {
    return {
      statusText: async () => {
        const s = await this.d.status?.();
        if (!s) return 'Статус ПК недоступен.';
        return `ОЗУ: ${s.ramUsedGb ?? '?'} / ${s.ramTotalGb ?? '?'} ГБ · VRAM: ${s.vramUsedMb ?? '?'} / ${s.vramTotalMb ?? '?'} МБ · Диск D: ${s.diskDFreeGb ?? '?'} ГБ · Активных агентов: ${s.busyAgents ?? 0}.`;
      },
      freeVramText: async () => {
        const r = await this.d.freeVram?.();
        return r?.text || 'Память освобождена.';
      },
      contextStats: ({ mode, ephemeral, agent, sessionId, model, history }) => {
        const isolated = isIsolatedMode({ mode, ephemeral });
        const rows = Array.isArray(history) ? history : (isolated ? [] : this.turns);
        return buildContextStats({
          model: model || 'auto',
          provider: agent || 'ollama',
          messages: rows,
        });
      },
      usageText: async ({ mode, ephemeral, agent, model, history }) => {
        const isolated = isIsolatedMode({ mode, ephemeral });
        const rows = Array.isArray(history) ? history : (isolated ? [] : this.turns);
        const ctx = buildContextStats({ model: model || 'auto', provider: agent || 'ollama', messages: rows });
        const lines = [`Контекст (${ctx.model || 'auto'}): ${ctx.usedTokens}/${ctx.maxTokens} (${ctx.percent}%).`];
        if (!isolated && typeof this.d.agentQuota === 'function') {
          for (const prov of ['claude', 'codex', 'gemini']) {
            try {
              const q = await this.d.agentQuota({ agent: prov, model: '', refresh: false });
              if (q?.windows?.length) {
                lines.push(`${prov}: ${q.windows.map((w) => `${Math.round(w.remaining)}%`).join(' / ')}`);
              }
            } catch {}
          }
        }
        return lines.join('\n');
      },
      agentsText: async () => {
        const list = await this.d.agentSessions?.('');
        if (!Array.isArray(list) || !list.length) return 'Сессий агентов пока нет.';
        return list.slice(0, 8).map((s) => `• ${s.agent}${s.model ? ` (${s.model})` : ''}: ${s.busy ? 'работает' : 'ожидание'} — ${s.title || 'без названия'}`).join('\n');
      },
      clipText: async (text) => {
        if (text) {
          await this.d.setClipboard?.(text);
          return `Скопировано в буфер: «${text.slice(0, 120)}».`;
        }
        const cur = String((await this.d.getClipboard?.()) || '').trim();
        return cur ? `Буфер обмена:\n${cur.slice(0, 1500)}` : 'Буфер обмена пуст.';
      },
      setClipboard: (text) => this.d.setClipboard?.(text),
      webText: async (query) => {
        const found = await this.d.webSearch?.(query);
        const links = (found?.results || []).slice(0, 5).map((item) => `${item.title || item.url} — ${item.url}`);
        return links.join('\n') || 'В сети ничего не найдено.';
      },
      mailText: async (query) => {
        const res = await this.d.readPim?.(query || 'покажи свежие письма');
        return res?.reply || 'Почта недоступна.';
      },
      todayText: async ({ isolated }) => {
        if (isolated) return 'Календарь Proton недоступен в изолированном режиме.';
        const res = await this.d.readPim?.('что у меня сегодня');
        return res?.reply || 'Расписание недоступно.';
      },
      switchModel: (wanted) => this.d.switchModel?.(wanted),
      newChat: ({ mode, ephemeral }) => {
        if (!isIsolatedMode({ mode, ephemeral })) this.turns = [];
      },
      stop: async ({ sessionId, requestId }) => {
        if (requestId && this.chatRequests.has(requestId)) {
          const entry = this.chatRequests.get(requestId);
          entry.state = 'stopped';
          entry.abort?.abort();
        }
        for (const entry of this.chatRequests.values()) {
          if (entry.state === 'queued' || entry.state === 'running') {
            entry.state = 'stopped';
            entry.abort?.abort();
          }
        }
        if (sessionId && typeof this.d.agentStop === 'function') {
          await this.d.agentStop(sessionId).catch(() => {});
        }
      },
      compact: (opts) => this.compactChat(opts),
      answerBtw: async ({ text, systemHint, skills, mode, ephemeral, agent, sessionId, model, history }) => {
        const isolated = isIsolatedMode({ mode, ephemeral });
        if (sessionId && agent && !isolated && typeof this.d.agentSend === 'function') {
          const enriched = systemHint ? `[Системные указания: ${systemHint}]\n\n${text}` : text;
          const res = await this.d.agentSend({ id: sessionId, agent, model, text: enriched, btw: true, history });
          return { reply: res?.text || res?.reply || '', context: res?.context, error: res?.error };
        }
        if (typeof this.d.chat !== 'function') return { reply: 'Чат недоступен.' };
        const baseHistory = Array.isArray(history) ? history : (isolated ? [] : this.turns.slice(-TURNS * 2));
        const sys = [this.d.persona?.({ isolated, ephemeral, privateMode: mode === 'private', localMode: mode, useVault: !isolated }) || '', systemHint].filter(Boolean).join('\n');
        const out = await this.d.chat([
          ...(sys ? [{ role: 'system', content: sys }] : []),
          ...baseHistory,
          { role: 'user', content: text },
        ], new AbortController().signal, {
          ephemeral: true,
          localOnly: isolated,
          skills: skills || [],
          requestedModel: model || undefined,
          useVault: false,
          mobile: true,
        });
        return { reply: String(out?.text || '').trim(), context: out?.context };
      },
    };
  }

  async compactChat({ mode = 'chat', ephemeral = false, history, focus = '', model = '' } = {}) {
    const isolated = isIsolatedMode({ mode, ephemeral });
    const baseHistory = Array.isArray(history) ? history : (isolated ? [] : this.turns);
    if (!Array.isArray(baseHistory)) {
      throw Object.assign(new Error('Некорректная история разговора.'), { status: 400 });
    }
    const summarizer = typeof this.d.chat === 'function'
      ? async ({ older, focus: f, signal }) => {
        const transcript = older.map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`).join('\n\n').slice(0, 12000);
        const prompt = [
          'Сожми предыдущие реплики диалога в плотный структурированный конспект на русском языке.',
          f ? `Фокус: ${f}.` : '',
          'Начни со строки "[Конспект предыдущей части разговора]", далее 3-7 коротких пунктов с фактами, решениями и следующими шагами.',
          '',
          transcript,
        ].filter(Boolean).join('\n');
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 12000);
        try {
          const reqSig = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
          const res = await this.d.chat([
            { role: 'system', content: 'Ты сжимаешь историю диалога в короткий конспект. Только факты из текста.' },
            { role: 'user', content: prompt },
          ], reqSig, { fastLocal: true, localOnly: true, ephemeral: true, useVault: false });
          return String(res?.text || '').trim();
        } finally {
          clearTimeout(timer);
        }
      }
      : null;

    const result = await compactHistory({
      history: baseHistory,
      focus,
      mode,
      ephemeral,
      model: model || 'auto',
      provider: 'ollama',
      summarizer,
    });
    if (history === undefined && !isolated && result.droppedCount > 0) {
      this.turns = result.history;
    }
    return result;
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
    for (const entry of this.chatRequests.values()) {
      clearTimeout(entry.timer);
      entry.abort?.abort();
    }
    this.chatRequests.clear();
    for (const active of this.researchRequests.values()) active.abort();
    if (!s) return Promise.resolve();
    return new Promise((r) => { s.closeAllConnections(); s.close(() => r()); });
  }

  researchStatus(id) {
    const running = this.researchRequests.get(id);
    if (running) return { state: running.signal.aborted ? 'stopping' : 'running' };
    return this.researchResults.get(id) || { state: 'missing' };
  }

  rememberResearch(id, result, status = 200) {
    const state = result.stopped ? 'stopped' : result.error ? 'failed' : 'done';
    const entry = { state, result, status };
    this.researchResults.set(id, entry);
    setTimeout(() => {
      if (this.researchResults.get(id) === entry) this.researchResults.delete(id);
    }, 24 * 60 * 60 * 1000).unref();
  }

  expireChatRequest(id, entry, ttl) {
    if (this.chatRequests.get(id) === entry) {
      entry.timer = setTimeout(() => this.chatRequests.delete(id), ttl).unref();
    }
  }

  freeChatRequestSlot() {
    if (this.chatRequests.size < CHAT_REQUEST_LIMIT) return true;
    for (const [id, entry] of this.chatRequests) {
      if (entry.state !== 'queued' && entry.state !== 'running') {
        clearTimeout(entry.timer);
        this.chatRequests.delete(id);
        if (this.chatRequests.size < CHAT_REQUEST_LIMIT) return true;
      }
    }
    return false;
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

  async getSuggestions(mode = 'chat', force = false) {
    const m = Object.hasOwn(DEFAULT_SUGGESTIONS, mode) ? mode : 'chat';
    const isPrivate = m === 'private';
    const baseSets = DEFAULT_SUGGESTIONS[m];
    const cached = isPrivate ? this.privateSuggestionsCache : this.suggestionsCache.get(m);
    const prevIndex = isPrivate ? this.privateSuggestionIndex : (this.suggestionIndices.get(m) ?? -1);
    const now = Date.now();

    const pickRotated = (sets, cachedFlag, stamp) => {
      const pool = Array.isArray(sets) && sets.length ? sets : baseSets;
      const nextIndex = (prevIndex + 1) % pool.length;
      if (isPrivate) this.privateSuggestionIndex = nextIndex;
      else this.suggestionIndices.set(m, nextIndex);
      return {
        mode: m,
        items: pool[nextIndex],
        sets: pool,
        setIndex: nextIndex,
        cachedAt: stamp,
        cached: cachedFlag,
      };
    };

    if (!force && cached && (now - cached.cachedAt) < SUGGESTIONS_TTL_MS) {
      return pickRotated(cached.sets, true, cached.cachedAt);
    }

    let generatedSet = null;
    if (typeof this.d.suggestions === 'function') {
      try {
        const res = await this.d.suggestions(m);
        if (Array.isArray(res) && res.length >= 3) generatedSet = res.slice(0, 3);
      } catch {}
    } else if (typeof this.d.chat === 'function') {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 12000);
      try {
        const prompt = `Сгенерируй ровно 3 короткие стартовые подсказки (до 6 слов в заголовке) для режима "${m}" ассистента ALTAI:RE. `
          + 'Верни строго JSON-массив вида [{"title":"...","prompt":"..."}] без пояснений.';
        const chatOpts = isPrivate
          ? { fastLocal: true, localOnly: true, ephemeral: true, source: 'vault', useVault: false }
          : { fastLocal: true, ephemeral: true };
        const { text } = await this.d.chat([
          { role: 'system', content: 'Ты генератор коротких UI-подсказок. Отвечай только валидным JSON-массивом.' },
          { role: 'user', content: prompt },
        ], abort.signal, chatOpts);
        const jsonMatch = /\[[\s\S]*\]/.exec(String(text || ''));
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const valid = parsed.filter((x) => x && x.title && x.prompt).slice(0, 3);
          if (valid.length === 3) generatedSet = valid;
        }
      } catch {} finally {
        clearTimeout(timer);
      }
    }

    const sets = generatedSet ? [generatedSet, ...baseSets.slice(1)] : baseSets;
    const cacheEntry = { mode: m, sets, cachedAt: now };
    if (isPrivate) this.privateSuggestionsCache = cacheEntry;
    else this.suggestionsCache.set(m, cacheEntry);
    return pickRotated(sets, false, now);
  }

  async runMobileCouncil(query, opts = {}) {
    opts.signal?.throwIfAborted();
    if (!query.trim()) throw Object.assign(new Error('Укажи вопрос для совета.'), { status: 400 });
    if (opts.privateMode || opts.ephemeral || opts.localOnly || this.d.externalBlocked?.(query)) {
      throw Object.assign(new Error('Совет недоступен в этом режиме.'), { status: 403 });
    }
    if (!this.d.runMobileCouncil) throw Object.assign(new Error('Совет недоступен на ПК.'), { status: 503 });
    return this.d.runMobileCouncil(query, opts);
  }

  async runDeepResearch(query, opts = {}) {
    const { signal } = opts;
    signal?.throwIfAborted();
    const q = String(query || '').trim();
    if (!q) throw new Error('empty query');
    if (opts.privateMode || opts.ephemeral || opts.localOnly || this.d.externalBlocked?.(q)) {
      throw Object.assign(new Error('Облачный Deep Research недоступен в этом режиме.'), { status: 403 });
    }
    if (typeof this.d.deepResearch === 'function') {
      return await this.d.deepResearch({ query: q, ...opts });
    }

    const sendResearch = async (request, readReport = false) => {
      signal?.throwIfAborted();
      if (this.d.externalBlocked?.(q)) throw new Error('Облачный Deep Research остановлен.');
      const stop = () => { void Promise.resolve().then(() => this.d.agentStop?.(request.id)).catch(() => {}); };
      signal?.addEventListener('abort', stop, { once: true });
      let response;
      try {
        response = await this.d.agentSend({ ...request, signal, quotaScope: 'swarm', notifyActivity: opts.notifyActivity });
      } finally {
        signal?.removeEventListener('abort', stop);
      }
      signal?.throwIfAborted();
      if (response?.ok === false) throw new Error(response.error || 'Воркер не ответил');
      if (response?.text || response?.reply) return String(response.text || response.reply).trim();
      if (!response?.ok) return '';
      const history = await this.d.agentHistory?.(request.id);
      const answer = history?.at(-1);
      if (answer?.role !== 'assistant') return '';
      if (readReport && this.d.agentArtifact) {
        const markdown = answer.artifacts?.filter((item) => /\.md$/i.test(item.name));
        if (markdown?.length === 1) {
          try {
            const file = await this.d.agentArtifact({ id: request.id, ...markdown[0] });
            if (file && (await fs.promises.stat(file)).size <= MAX_RESEARCH_REPORT_BYTES) {
              const report = (await fs.promises.readFile(file, 'utf8')).trim();
              if (report) return report;
            }
          } catch { /* Keep the worker's message if its artifact is unavailable. */ }
        }
      }
      return String(answer.content || '').trim();
    };

    // Встроенный оркестратор «Совет выживших» поверх живых облачных агентов (models: { claude, codex, gemini })
    const now = Date.now();
    const agentsRes = await this.d.agentsList?.().catch(() => ({}));
    signal?.throwIfAborted();
    const rawAgents = [];
    if (Array.isArray(agentsRes?.agents)) {
      rawAgents.push(...agentsRes.agents);
    } else if (agentsRes?.models && typeof agentsRes.models === 'object') {
      for (const id of ['claude', 'codex', 'gemini']) {
        const list = agentsRes.models[id];
        if (Array.isArray(list) && list.length) {
          rawAgents.push({ id, defaultModel: Array.isArray(list[0]) ? list[0][0] : String(list[0] || '') });
        }
      }
    }
    const liveWorkers = rawAgents.filter((a) => {
      const id = String(a?.id || a?.name || '');
      if (!id) return false;
      const until = this.workerCooldowns.get(id) || 0;
      return now >= until;
    });

    if (!liveWorkers.length || typeof this.d.agentCreate !== 'function' || typeof this.d.agentSend !== 'function') {
      throw Object.assign(new Error('Сейчас нет доступных облачных воркеров.'), { status: 503 });
    }

    // Параллельный опрос всех живых воркеров
    const workerResults = await Promise.all(liveWorkers.map(async (w) => {
      const id = String(w.id || w.name);
      const model = String(w.defaultModel || w.model || '');
      try {
        const sid = await this.d.agentCreate(id);
        const out = await sendResearch({
          id: sid,
          model,
          text: `Deep Research (независимый доклад по теме, с источниками и проверкой фактов):\n${q}`,
          retry: false,
        });
        if (!out) return null;
        return { id, model, text: out };
      } catch (error) {
        if (/лимит|rate\s*limit|quota/i.test(error.message)) this.workerCooldowns.set(id, Date.now() + WORKER_COOLDOWN_MS);
        return null;
      }
    }));

    const okWorkers = workerResults.filter(Boolean);
    signal?.throwIfAborted();
    if (!okWorkers.length) {
      throw Object.assign(new Error('Ни один облачный воркер не вернул доклад.'), { status: 503 });
    }

    // Иерархия Ректора: Astra -> Claude Opus -> Antigravity Neon -> Web Gemini Neon -> первый живой
    const rectorPriority = ['astra', 'claude', 'antigravity', 'gemini'];
    const rector = rectorPriority
      .map((p) => okWorkers.find((w) => w.id.toLowerCase().includes(p)))
      .find(Boolean) || okWorkers[0];

    const synthesisPrompt = [
      `Тема Deep Research: ${q}`,
      '',
      'Доклады совета агентов:',
      ...okWorkers.map((w) => `### ${w.id}\n${w.text}`),
      '',
      'Верни полный проверенный отчёт прямо в ответе в Markdown. Выдели подтверждённые факты, расхождения и выводы.',
    ].join('\n');

    let finalReport = '';
    try {
      const sid = await this.d.agentCreate(rector.id);
      finalReport = await sendResearch({ id: sid, model: rector.model, text: synthesisPrompt, retry: false }, true);
    } catch {}
    if (!finalReport) {
      finalReport = okWorkers.map((w) => `## ${w.id}\n${w.text}`).join('\n\n');
    }

    // Попытка сохранить в Obsidian через deps, если подключено
    signal?.throwIfAborted();
    let obsidianSaved = false;
    if (typeof this.d.saveObsidianResearch === 'function') {
      obsidianSaved = await this.d.saveObsidianResearch({ query: q, markdown: finalReport }).catch(() => false);
    }

    return {
      reply: finalReport,
      brain: `deep_research:${rector.id}`,
      workers: okWorkers.map((w) => w.id),
      rector: rector.id,
      obsidianSaved,
    };
  }

  async handle(req, res) {
    const url = new URL(req.url || '/', 'http://bridge');
    const got = String(req.headers['x-capri-token'] ?? url.searchParams.get('token') ?? '');
    if (!tokenMatches(got, this.d.token())) return this.send(res, 401, { error: 'bad token' });
    try {
      const pack = this.d.sprites?.() || null;
      if (req.method === 'GET' && url.pathname === '/ping') {
        const contextLimits = typeof this.d.contextLimits === 'function' ? this.d.contextLimits() : getContextLimits();
        return this.send(res, 200, {
          ok: true,
          pose: '',
          sprites: pack?.version || '',
          isolatedChat: true,
          modelSelection: true,
          chatRecovery: true,
          slashCommands: true,
          skillsEngine: true,
          pluginsEngine: true,
          connectorsEngine: true,
          dockerEngine: true,
          pcToolsEngine: true,
          phoneControlEngine: true,
          privateVaultSave: Boolean(this.d.savePrivateChat),
          contextLimits,
        });
      }
      if (req.method === 'GET' && url.pathname === '/skills') {
        const mode = url.searchParams.get('mode') || 'chat';
        const epRaw = url.searchParams.get('ephemeral');
        const ephemeral = epRaw === 'true' || epRaw === '1';
        return this.send(res, 200, this.skillsEngine().listSkills({ mode, ephemeral }));
      }
      if (req.method === 'POST' && url.pathname === '/skills/toggle') {
        const body = await this.readJson(req);
        const result = this.skillsEngine().toggleSkill({
          id: body.id,
          enabled: body.enabled,
          alwaysOn: body.alwaysOn,
          mode: body.mode || 'chat',
          ephemeral: body.ephemeral === true,
        });
        return this.send(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/skills/create') {
        const body = await this.readJson(req, MAX_BODY * 4);
        const result = this.skillsEngine().createSkill({
          name: body.name,
          slug: body.slug,
          category: body.category,
          description: body.description,
          body: body.body,
          alwaysOn: body.alwaysOn,
          mode: body.mode || 'chat',
          ephemeral: body.ephemeral === true,
        });
        return this.send(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/skills/install') {
        const body = await this.readJson(req, MAX_BODY * 8);
        const result = this.skillsEngine().installSkill({
          sourcePath: body.sourcePath,
          markdown: body.markdown,
          slug: body.slug,
          category: body.category,
          confirm: body.confirm === true,
          mode: body.mode || 'chat',
          ephemeral: body.ephemeral === true,
        });
        return this.send(res, (result.ok || result.confirmRequired) ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/skills/reload') {
        const body = await this.readJson(req).catch(() => ({}));
        this.skillsEngine().reload();
        return this.send(res, 200, this.skillsEngine().listSkills({
          mode: body.mode || 'chat',
          ephemeral: body.ephemeral === true,
        }));
      }
      if (req.method === 'GET' && url.pathname === '/plugins') {
        const mode = url.searchParams.get('mode') || 'chat';
        const epRaw = url.searchParams.get('ephemeral');
        const ephemeral = epRaw === 'true' || epRaw === '1';
        return this.send(res, 200, this.pluginsEngine().listPlugins({ mode, ephemeral }));
      }
      if (req.method === 'POST' && url.pathname === '/plugins/toggle') {
        const body = await this.readJson(req);
        const result = this.pluginsEngine().togglePlugin({
          id: body.id,
          enabled: body.enabled,
          cascade: body.cascade !== false,
          mode: body.mode || 'chat',
          ephemeral: body.ephemeral === true,
        });
        return this.send(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/plugins/create') {
        const body = await this.readJson(req, MAX_BODY * 4);
        const result = this.pluginsEngine().createPlugin({
          name: body.name,
          slug: body.slug,
          category: body.category,
          description: body.description,
          skills: body.skills,
          rules: body.rules,
          commands: body.commands,
          cloudOnly: body.cloudOnly,
          vaultOnly: body.vaultOnly,
          mode: body.mode || 'chat',
          ephemeral: body.ephemeral === true,
        });
        return this.send(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/plugins/install') {
        const body = await this.readJson(req, MAX_BODY * 8);
        const result = this.pluginsEngine().installPlugin({
          sourcePath: body.sourcePath,
          manifestJson: body.manifestJson,
          slug: body.slug,
          confirm: body.confirm === true,
          mode: body.mode || 'chat',
          ephemeral: body.ephemeral === true,
        });
        return this.send(res, (result.ok || result.confirmRequired) ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/plugins/hookify') {
        const body = await this.readJson(req, MAX_BODY * 2);
        const result = this.pluginsEngine().manageHookify({
          op: body.op,
          id: body.id,
          name: body.name,
          triggerPattern: body.triggerPattern,
          action: body.action,
          message: body.message,
          enabled: body.enabled,
          mode: body.mode || 'chat',
          ephemeral: body.ephemeral === true,
        });
        return this.send(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/plugins/reload') {
        const body = await this.readJson(req).catch(() => ({}));
        this.pluginsEngine().reload();
        return this.send(res, 200, this.pluginsEngine().listPlugins({
          mode: body.mode || 'chat',
          ephemeral: body.ephemeral === true,
        }));
      }
      if (req.method === 'GET' && url.pathname === '/connectors') {
        const mode = url.searchParams.get('mode') || 'chat';
        const epRaw = url.searchParams.get('ephemeral');
        const ephemeral = epRaw === 'true' || epRaw === '1';
        const refreshRaw = url.searchParams.get('refresh');
        const refresh = refreshRaw === '1' || refreshRaw === 'true';
        if (refresh) {
          return this.send(res, 200, await this.connectorsEngine().checkAll({ mode, ephemeral }));
        }
        return this.send(res, 200, this.connectorsEngine().listConnectors({ mode, ephemeral }));
      }
      if (req.method === 'POST' && url.pathname === '/connectors/toggle') {
        const body = await this.readJson(req);
        const result = this.connectorsEngine().toggleConnector({
          id: body.id,
          enabled: body.enabled,
          mode: body.mode || 'chat',
          ephemeral: body.ephemeral === true,
        });
        return this.send(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/connectors/check') {
        const body = await this.readJson(req).catch(() => ({}));
        const result = body.id
          ? await this.connectorsEngine().checkConnector(body.id, { mode: body.mode || 'chat', ephemeral: body.ephemeral === true })
          : await this.connectorsEngine().checkAll({ mode: body.mode || 'chat', ephemeral: body.ephemeral === true });
        return this.send(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/connectors/query') {
        const body = await this.readJson(req);
        const result = await this.connectorsEngine().queryConnector({
          id: body.id,
          query: body.query || '',
          mode: body.mode || 'chat',
          ephemeral: body.ephemeral === true,
          isCloud: false,
        });
        return this.send(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/connectors/add') {
        const body = await this.readJson(req, MAX_BODY * 2);
        const result = this.connectorsEngine().addConnector({
          name: body.name,
          slug: body.slug,
          category: body.category,
          transport: body.transport,
          url: body.url,
          command: body.command,
          args: body.args,
          token: body.token,
          cloudOnly: body.cloudOnly,
          localOnly: body.localOnly,
          confirm: body.confirm === true,
          mode: body.mode || 'chat',
          ephemeral: body.ephemeral === true,
        });
        return this.send(res, (result.ok || result.confirmRequired) ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/connectors/remove') {
        const body = await this.readJson(req);
        const result = this.connectorsEngine().removeConnector({
          id: body.id,
          confirm: body.confirm === true,
          mode: body.mode || 'chat',
          ephemeral: body.ephemeral === true,
        });
        return this.send(res, (result.ok || result.confirmRequired) ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/connectors/notebook-digest') {
        const body = await this.readJson(req).catch(() => ({}));
        const result = this.connectorsEngine().buildNotebookDigest(body || {});
        return this.send(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/connectors/health-sync') {
        const body = await this.readJson(req, MAX_BODY * 2);
        const result = this.connectorsEngine().saveHealthSummary(body || {});
        return this.send(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/connectors/configure') {
        const body = await this.readJson(req, MAX_BODY * 2);
        if (!body || typeof body !== 'object' || Array.isArray(body) || !String(body.id || '').trim()) {
          return this.send(res, 400, { ok: false, error: 'Не указан id коннектора.' });
        }
        const result = await this.connectorsEngine().configureConnector(body);
        if (result.ok) this.d.onConnectorsChanged?.(body);
        return this.send(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'GET' && url.pathname === '/docker/status') {
        const refreshRaw = url.searchParams.get('refresh');
        const refresh = refreshRaw === '1' || refreshRaw === 'true';
        return this.send(res, 200, await this.dockerEngine().getStatus({ refresh }));
      }
      if (req.method === 'POST' && url.pathname === '/docker/action') {
        const body = await this.readJson(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return this.send(res, 400, { ok: false, error: 'Некорректное тело запроса.' });
        }
        const result = await this.dockerEngine().controlStack({
          host: body.host,
          stackId: body.stackId,
          container: body.container,
          action: body.action,
          confirm: body.confirm === true,
        });
        return this.send(res, (result.ok || result.confirmRequired) ? 200 : 400, result);
      }
      if (req.method === 'GET' && url.pathname === '/tools/status') {
        const refreshRaw = url.searchParams.get('refresh');
        const refresh = refreshRaw === '1' || refreshRaw === 'true';
        return this.send(res, 200, await this.pcToolsEngine().getStatus({ refresh }));
      }
      if (req.method === 'POST' && url.pathname === '/tools/action') {
        const body = await this.readJson(req, MAX_BODY * 2);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return this.send(res, 400, { ok: false, error: 'Некорректное тело запроса.' });
        }
        const result = await this.pcToolsEngine().runAction({
          toolId: body.toolId,
          action: body.action,
          payload: body.payload,
        });
        return this.send(res, result.ok ? 200 : (result.blocked ? 403 : 400), result);
      }
      if (req.method === 'GET' && url.pathname === '/phone-control/status') {
        return this.send(res, 200, this.phoneControlEngine().getStatus());
      }
      if (req.method === 'POST' && url.pathname === '/phone-control/state') {
        const body = await this.readJson(req, MAX_BODY * 2);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return this.send(res, 400, { ok: false, error: 'Некорректное тело запроса.' });
        }
        const updated = this.phoneControlEngine().updateState(body);
        if (!updated.ok) return this.send(res, 400, updated);
        const pendingActions = this.phoneControlEngine().drainPendingActions();
        return this.send(res, 200, {
          ok: true,
          status: updated.status,
          pendingActions,
        });
      }
      if (req.method === 'POST' && url.pathname === '/phone-control/action') {
        const body = await this.readJson(req, MAX_BODY * 2);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return this.send(res, 400, { ok: false, error: 'Некорректное тело запроса.' });
        }
        const result = this.phoneControlEngine().queueAction({
          moduleId: body.moduleId,
          action: body.action,
          payload: body.payload,
          confirmed: body.confirmed === true,
        });
        return this.send(res, (result.ok || result.confirmRequired) ? 200 : 400, result);
      }
      if (req.method === 'POST' && url.pathname === '/phone-control/action-result') {
        const body = await this.readJson(req, MAX_BODY);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return this.send(res, 400, { ok: false, error: 'Некорректное тело запроса.' });
        }
        const result = this.phoneControlEngine().reportActionResult({
          actionId: body.actionId,
          ok: body.ok,
          message: body.message,
        });
        return this.send(res, result.ok ? 200 : 400, result);
      }
      if (req.method === 'GET' && url.pathname === '/commands') {
        const mode = url.searchParams.get('mode') || 'chat';
        const ephemeral = url.searchParams.get('ephemeral') === 'true';
        const agent = url.searchParams.get('agent') || null;
        const pct = url.searchParams.get('pct') ?? url.searchParams.get('contextPct');
        const sessionId = url.searchParams.get('sessionId') || null;
        return this.send(res, 200, this.slashEngine().listCommands({ mode, ephemeral, agent, pct, sessionId }));
      }
      if (req.method === 'POST' && url.pathname === '/commands/run') {
        const body = await this.readJson(req, MAX_BODY * 4);
        const mode = String(body.mode || 'chat');
        const ephemeral = body.ephemeral === true;
        if (this.d.externalBlocked?.(String(body.text || '')) && !isIsolatedMode({ mode, ephemeral })) {
          // Enforce Tor/secret guard if text triggers external block and calls cloudOnly command.
          const parsed = parseSlashInput(body.text, this.slashEngine().registry());
          if (parsed.chain.some((c) => c.cloudOnly)) {
            const msg = 'Команда недоступна в режиме Tor-изоляции или при наличии секретов.';
            return this.send(res, 403, { handled: true, instant: true, error: msg, reply: msg });
          }
        }
        const result = await this.slashEngine().run(body);
        if (result?.error && isIsolatedMode({ mode, ephemeral }) && /недоступна в изолированном режиме/i.test(result.error)) {
          return this.send(res, 403, result);
        }
        return this.send(res, 200, result);
      }
      if (req.method === 'POST' && url.pathname === '/chat/compact') {
        const body = await this.readJson(req, MAX_BODY * 8);
        if (body.history !== undefined) {
          if (!Array.isArray(body.history) || body.history.length > 120 || body.history.some((row) =>
            !row || !['user', 'assistant', 'system'].includes(row.role) || typeof row.content !== 'string' || row.content.length > 24000)) {
            return this.send(res, 400, { ok: false, error: 'Некорректная история разговора.' });
          }
        }
        const result = await this.compactChat(body);
        return this.send(res, 200, result);
      }
      if (req.method === 'POST' && url.pathname === '/agents/compact') {
        const body = await this.readJson(req);
        if (typeof body.id !== 'string' || !body.id.trim()) {
          return this.send(res, 400, { ok: false, error: 'Укажи идентификатор сессии.' });
        }
        if (typeof this.d.agentCompact !== 'function') {
          return this.send(res, 503, { ok: false, error: 'Сжатие сессий агентов недоступно.' });
        }
        const result = await this.d.agentCompact({ id: body.id.trim(), focus: String(body.focus || '').trim() });
        return this.send(res, 200, result);
      }
      if (req.method === 'GET' && url.pathname === '/suggestions') {
        const mode = url.searchParams.get('mode') || 'chat';
        const force = url.searchParams.get('refresh') === 'true';
        return this.send(res, 200, await this.getSuggestions(mode, force));
      }
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
      if (req.method === 'POST' && url.pathname === '/free-vram') {
        const r = await this.d.freeVram?.();
        return this.send(res, 200, r || { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/clipboard') {
        const text = await this.d.getClipboard?.();
        return this.send(res, 200, { text: String(text || '') });
      }
      if (req.method === 'POST' && url.pathname === '/clipboard') {
        const body = await this.readJson(req);
        await this.d.setClipboard?.(String(body.text ?? '').slice(0, 20000));
        return this.send(res, 200, { ok: true });
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
      if (req.method === 'POST' && url.pathname === '/tool') {
        const body = await this.readJson(req);
        if (!['search', 'pim'].includes(body.tool) || typeof body.text !== 'string' ||
            !body.text.trim() || body.text.length > 4000) {
          return this.send(res, 400, { error: 'Неверный инструмент или текст запроса.' });
        }
        const flags = parsePromptFlags(body.text, body);
        if (!flags.text) return this.send(res, 400, { error: 'Введите запрос.' });
        if (flags.ephemeral || flags.privateMode || flags.localOnly || flags.deepResearch || this.d.externalBlocked?.(flags.text)) {
          return this.send(res, 403, { error: 'Инструмент недоступен для этого запроса.' });
        }
        if (body.tool === 'search') {
          const result = await this.turn({ ...flags, text: `найди в сети: ${flags.text}` }, false);
          return this.send(res, result.brain === 'error' ? 503 : 200, result.brain === 'error' ? { error: result.reply } : result);
        }
        if (!this.d.readPim) return this.send(res, 503, { error: 'Почта и календарь недоступны.' });
        return this.send(res, 200, await this.d.readPim(flags.text));
      }
      if (req.method === 'POST' && url.pathname === '/deep-research/stop') {
        const { requestId } = await this.readJson(req);
        if (typeof requestId !== 'string' || !RESEARCH_ID.test(requestId)) {
          return this.send(res, 400, { error: 'Неверный идентификатор исследования.' });
        }
        const active = this.researchRequests.get(requestId);
        if (active) {
          active.abort();
        } else if (!this.researchResults.has(requestId)) {
          if (this.researchResults.size + this.researchRequests.size >= 128) {
            return this.send(res, 429, { error: 'Хранилище недавних задач заполнено.' });
          }
          this.rememberResearch(requestId, { stopped: true });
        }
        return this.send(res, 200, { ok: true, state: active ? 'stopping' : this.researchResults.get(requestId).state });
      }
      if (req.method === 'GET' && url.pathname === '/deep-research/result') {
        const id = url.searchParams.get('requestId') || '';
        if (!RESEARCH_ID.test(id)) return this.send(res, 400, { error: 'Неверный идентификатор исследования.' });
        return this.send(res, 200, this.researchStatus(id));
      }
      if (req.method === 'GET' && url.pathname === '/deep-research/activity') {
        const id = url.searchParams.get('requestId') || '';
        if (!RESEARCH_ID.test(id)) return this.send(res, 400, { error: 'Неверный идентификатор исследования.' });
        const trace = this.researchActivity.get(id);
        const groups = this.d.quotaSnapshot?.().groups || [];
        const now = Date.now();
        const visible = trace && trace.until > now;
        const pools = visible ? new Set([...trace.groups].filter(([, until]) => until > now).map(([pool]) => pool)) : new Set();
        return this.send(res, 200, { running: Boolean(visible && trace.until === Infinity),
          steps: visible ? [...trace.steps.values()] : [], groups: groups.filter((group) => pools.has(group.id)) });
      }
      if (req.method === 'POST' && url.pathname === '/deep-research') {
        const body = await this.readJson(req);
        const flags = parsePromptFlags(String(body.query ?? body.text ?? '').slice(0, 4000), body);
        const { requestId } = body;
        const kind = body.kind ?? 'deep';
        if (kind !== 'deep' && kind !== 'council') return this.send(res, 400, { error: 'Неизвестный тип исследования.' });
        if (requestId !== undefined && (typeof requestId !== 'string' || !RESEARCH_ID.test(requestId))) {
          return this.send(res, 400, { error: 'Неверный идентификатор исследования.' });
        }
        const background = body.background === true;
        if (background && !requestId) return this.send(res, 400, { error: 'Требуется идентификатор исследования.' });
        if (requestId && this.researchStatus(requestId).state !== 'missing') {
          const current = this.researchStatus(requestId);
          if (background || !current.result) return this.send(res, 200, current);
          return this.send(res, current.status, current.result);
        }
        if (requestId && this.researchResults.size + this.researchRequests.size >= 128) {
          return this.send(res, 429, { error: 'Хранилище недавних задач заполнено.' });
        }
        const abort = new AbortController();
        if (requestId) this.researchRequests.set(requestId, abort);
        for (const [id, trace] of this.researchActivity) {
          if (trace.until <= Date.now()) this.researchActivity.delete(id);
        }
        const trace = { until: Infinity, steps: new Map(), groups: new Map(), workers: new Map() };
        if (requestId) this.researchActivity.set(requestId, trace);
        const notifyActivity = ({ runId, agent, model, event, pool }) => {
          if (!requestId || abort.signal.aborted) return;
          const group = pool || this.d.quotaGroup?.(agent, model);
          if (group && event.kind === 'turn') {
            if (event.state === 'running') trace.workers.set(runId, group);
            else trace.workers.delete(runId);
            trace.groups.set(group, [...trace.workers.values()].includes(group) ? Infinity : Date.now() + 6000);
          }
          const key = event.kind === 'turn' ? runId : `${runId}:${event.id}`;
          trace.steps.set(key, { agent, ...event });
          if (trace.steps.size > 32) trace.steps.delete(trace.steps.keys().next().value);
        };
        const disconnect = () => { if (!res.writableEnded) abort.abort(); };
        if (!requestId) res.once('close', disconnect);
        const run = async () => {
          let result;
          let status = 200;
          try {
            const options = { ...flags, signal: abort.signal, notifyActivity };
            result = kind === 'council'
              ? await this.runMobileCouncil(flags.text, options)
              : await this.runDeepResearch(flags.text, options);
          } catch (error) {
            status = Number.isInteger(error.status) ? error.status : 500;
            result = { error: status === 500 ? 'Исследование завершилось ошибкой.' : error.message };
          }
          if (abort.signal.aborted) {
            result = { stopped: true };
            status = 200;
          }
          trace.until = Date.now() + 6000;
          for (const [group, until] of trace.groups) {
            if (until > Date.now()) trace.groups.set(group, trace.until);
          }
          if (abort.signal.aborted) {
            for (const step of trace.steps.values()) {
              if (step.state === 'running') step.state = 'stopped';
            }
          }
          if (requestId) {
            const expiry = setTimeout(() => {
              if (this.researchActivity.get(requestId) === trace) this.researchActivity.delete(requestId);
            }, 6000);
            expiry.unref();
          }
          res.off('close', disconnect);
          if (requestId) {
            this.rememberResearch(requestId, result, status);
            this.researchRequests.delete(requestId);
          }
          return { result, status };
        };
        if (background) {
          void run();
          return this.send(res, 202, this.researchStatus(requestId));
        }
        const { result, status } = await run();
        if (!res.destroyed) return this.send(res, status, result);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/chat/private/save') {
        if (!this.d.savePrivateChat) return this.send(res, 503, { error: 'Приватный Vault недоступен.' });
        const { chatId, history } = await this.readJson(req, 2 * 1024 * 1024);
        try {
          await this.d.savePrivateChat(chatId, history);
          return this.send(res, 200, { saved: true });
        } catch (err) {
          const status = [400, 403, 409, 413].includes(err?.status) ? err.status : 503;
          return this.send(res, status, { error: status === 503 ? 'Приватный Vault недоступен.' : err.message });
        }
      }
      const chatStatus = req.method === 'GET' && url.pathname === '/chat/status';
      const chatStop = req.method === 'POST' && url.pathname === '/chat/stop';
      if (chatStatus || chatStop) {
        const requestId = chatStatus ? url.searchParams.get('requestId') : (await this.readJson(req)).requestId;
        if (typeof requestId !== 'string' || !RESEARCH_ID.test(requestId)) {
          return this.send(res, 400, { error: 'Некорректный идентификатор сообщения.' });
        }
        const entry = this.chatRequests.get(requestId);
        const owner = crypto.createHash('sha256').update(got).digest('hex');
        if (chatStop && !entry) {
          if (!this.freeChatRequestSlot()) return this.send(res, 503, { error: 'ПК занят. Повтори отправку позже.' });
          const tombstone = { owner, fingerprint: null, state: 'stopped', result: Promise.resolve(CHAT_STOPPED) };
          this.chatRequests.set(requestId, tombstone);
          this.expireChatRequest(requestId, tombstone, ISOLATED_CHAT_REQUEST_TTL_MS);
          return this.send(res, 200, { state: 'stopped' });
        }
        if (entry?.owner !== owner) return this.send(res, 404, { error: 'Запрос не найден.' });
        if (chatStop && entry.abort) {
          entry.state = 'stopped';
          entry.abort.abort();
        }
        return this.send(res, 200, { state: entry.state });
      }
      if (req.method === 'POST' && url.pathname === '/chat') {
        const body = await this.readJson(req, MAX_BODY + Math.ceil(MAX_UPLOAD_BYTES / 3) * 4);
        if (body.text != null && typeof body.text !== 'string') return this.send(res, 400, { error: 'Некорректный текст сообщения.' });
        const rawText = (body.text ?? '').replace(/\u0000/g, '').trim();
        if (rawText.length > 24000) return this.send(res, 400, { error: 'Сообщение длиннее 24 000 символов.' });
        const images = Array.isArray(body.files)
          ? body.files.filter((f) => f && String(f.mime || '').startsWith('image/') && f.data).map((f) => String(f.data)).slice(0, 4)
          : [];
        if (!rawText && !images.length) return this.send(res, 400, { error: 'empty' });
        const imagePrompt = images.length > 1
          ? 'Кратко опиши каждое прикреплённое изображение по порядку.'
          : 'Кратко опиши прикреплённое изображение.';
        const flags = parsePromptFlags(rawText, body);
        if (body.model !== undefined && !PHONE_MODEL_KEYS.includes(body.model)) {
          return this.send(res, 400, { error: 'Выбранная модель недоступна на ПК.' });
        }
        flags.requestedModel = body.model;
        if (flags.text.startsWith('/')) {
          const parsedSlash = parseSlashInput(flags.text, this.slashEngine().registry());
          if (parsedSlash.chain.length > 0) {
            const isolatedMode = flags.ephemeral || flags.privateMode || flags.localOnly;
            const blockedCloud = isolatedMode ? parsedSlash.chain.find((c) => c.cloudOnly) : null;
            if (blockedCloud) {
              return this.send(res, 403, { error: `Команда ${blockedCloud.slash} недоступна в изолированном режиме.` });
            }
            const built = buildChainPrompt({
              chain: parsedSlash.chain,
              remainder: parsedSlash.remainder,
              state: this.slashEngine().getState(),
              mode: body.mode || 'chat',
              skipSkillHints: Boolean(this.skillsEngine()),
            });
            for (const sk of built.skills) {
              if (!flags.skills.includes(sk)) flags.skills.push(sk);
            }
            if (built.systemHint) flags.slashSystemHint = built.systemHint;
            if (built.btw) flags.btw = true;
            if (built.deepResearch) flags.deepResearch = true;
            if (built.draw) flags.forceDraw = true;
            flags.text = built.text;
          }
        }
        if (body.btw === true) flags.btw = true;
        if (body.history !== undefined) {
          if (!Array.isArray(body.history) || body.history.length > TURNS * 2 || body.history.some((row) =>
            !row || !['user', 'assistant'].includes(row.role) || typeof row.content !== 'string' || row.content.length > 4000)) {
            return this.send(res, 400, { error: 'Некорректная история разговора.' });
          }
          flags.history = body.history.map(({ role, content }) => ({ role, content }));
        }
        flags.images = images;
        if (!flags.text && !images.length) return this.send(res, 400, { error: 'empty' });
        if (!flags.text) flags.text = imagePrompt;
        if (body.privateChatId !== undefined) {
          if (!flags.privateMode || flags.ephemeral || typeof body.privateChatId !== 'string' || !RESEARCH_ID.test(body.privateChatId)) {
            return this.send(res, 400, { error: 'Некорректный идентификатор приватного чата.' });
          }
          if (!this.d.savePrivateChat) return this.send(res, 503, { error: 'Приватный Vault недоступен.' });
          flags.privateChatId = body.privateChatId;
        }
        if (body.privateUserText !== undefined) {
          if (!flags.privateChatId || typeof body.privateUserText !== 'string' || body.privateUserText.length > 24000) {
            return this.send(res, 400, { error: 'Некорректный текст приватного чата.' });
          }
          flags.privateUserText = body.privateUserText.replace(/\u0000/g, '');
        }
        const requestId = body.requestId;
        if (requestId !== undefined && (typeof requestId !== 'string' || !RESEARCH_ID.test(requestId))) {
          return this.send(res, 400, { error: 'Некорректный идентификатор сообщения.' });
        }
        const isolated = flags.ephemeral || flags.privateMode || flags.localOnly;
        let entry = null;
        let ttl;
        if (requestId) {
          const owner = crypto.createHash('sha256').update(got).digest('hex');
          const fingerprint = crypto.createHmac('sha256', got).update(JSON.stringify(body)).digest('hex');
          const previous = this.chatRequests.get(requestId);
          if (previous) {
            if (previous.owner !== owner) return this.send(res, 404, { error: 'Запрос не найден.' });
            if (previous.fingerprint !== null && previous.fingerprint !== fingerprint) {
              return this.send(res, 409, { error: 'Этот идентификатор уже используется для другого запроса.' });
            }
            const result = await previous.result;
            if (!res.destroyed) return this.send(res, 200, result);
            return;
          }
          if (!this.freeChatRequestSlot()) return this.send(res, 503, { error: 'ПК занят. Повтори отправку позже.' });
          ttl = isolated || this.d.externalBlocked?.(flags.text) ? ISOLATED_CHAT_REQUEST_TTL_MS : CHAT_REQUEST_TTL_MS;
          entry = { owner, fingerprint, state: 'queued', abort: new AbortController(), timer: null, result: null };
          this.chatRequests.set(requestId, entry);
        }
        const signal = entry?.abort.signal;
        const turn = this.queue.then(() => {
          signal?.throwIfAborted();
          if (entry) entry.state = 'running';
          if (body.reset === true && flags.history === undefined && !isolated) this.turns = [];
          return this.turn(flags, body.voice === true, signal);
        });
        // Keep the queue independent of response data, including after the last recovery TTL.
        this.queue = turn.then(() => {}, () => {});
        let response = turn;
        if (entry) {
          response = turn.catch(() => ({ reply: 'Не удалось завершить запрос.', brain: 'error', pose: '' })).then((result) => {
            const stopped = signal.aborted;
            entry.state = stopped ? 'stopped' : result.brain === 'error' ? 'error' : 'complete';
            entry.abort = null;
            this.expireChatRequest(requestId, entry, ttl);
            return stopped ? CHAT_STOPPED : result;
          });
          entry.result = response;
        }
        const result = await response;
        if (!res.destroyed) return this.send(res, 200, result);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/agents') {
        const data = (await this.d.agentsList?.()) || { agents: [] };
        const contextLimits = data.contextLimits || (typeof this.d.contextLimits === 'function' ? this.d.contextLimits() : getContextLimits());
        return this.send(res, 200, { ...data, contextLimits });
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
        const body = await this.readJson(req, MAX_BODY * 4 + Math.ceil(MAX_UPLOAD_BYTES / 3) * 4);
        const rawText = typeof body.text === 'string' ? body.text : '';
        if (body.useVault !== undefined && typeof body.useVault !== 'boolean') {
          return this.send(res, 400, { ok: false, error: 'Некорректный режим чата.' });
        }
        if (body.ephemeral === true || body.privateMode === true || body.localOnly === true
            || body.mode === 'private' || body.mode === 'nsfw'
            || /\[VAULT_LOCAL_ONLY\]|\[NO_MEMORY\]/i.test(rawText)) {
          return this.send(res, 403, { ok: false, error: 'Облачные модели недоступны в этом режиме.' });
        }
        if (body.history !== undefined) {
          if (!Array.isArray(body.history) || body.history.length > 60 || body.history.some((row) =>
            !row || !['user', 'assistant'].includes(row.role) || typeof row.content !== 'string'
            || !row.content.trim() || row.content.length > 24000
            || row.ephemeral === true || row.private === true || row.privateMode === true || row.localOnly === true
            || row.mode === 'private' || row.mode === 'nsfw'
            || /\[VAULT_LOCAL_ONLY\]|\[NO_MEMORY\]/i.test(row.content))) {
            return this.send(res, 400, { ok: false, error: 'Некорректная история разговора.' });
          }
        }
        if (this.d.externalBlocked?.(rawText)
            || (Array.isArray(body.history) && body.history.some((row) => this.d.externalBlocked?.(String(row?.content || ''))))) {
          return this.send(res, 403, { ok: false, error: 'Облачные модели недоступны для этого запроса.' });
        }
        let sendPayload = { ...body, quotaScope: undefined, notifyActivity: undefined, useVault: body.useVault !== false };
        if (rawText.trim().startsWith('/')) {
          const parsedSlash = parseSlashInput(rawText, this.slashEngine().registry());
          if (parsedSlash.chain.length > 0) {
            const built = buildChainPrompt({
              chain: parsedSlash.chain,
              remainder: parsedSlash.remainder,
              state: this.slashEngine().getState(body.id),
              mode: 'agent',
              skipSkillHints: Boolean(this.skillsEngine()),
            });
            const finalPrompt = built.systemHint
              ? `[Указания режима:\n${built.systemHint}]\n\n${built.text}`
              : built.text;
            sendPayload = {
              ...sendPayload,
              text: finalPrompt,
              ...(built.skills.length && { skills: built.skills }),
              ...(built.btw && { btw: true }),
            };
          }
        }
        const result = await this.d.agentSend?.(sendPayload);
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
      if (req.method === 'GET' && url.pathname === '/quotas/activity') {
        return this.send(res, 200, { groups: this.d.quotaActivity?.() || [] });
      }
      if (req.method === 'GET' && url.pathname === '/quotas') {
        const quotas = url.searchParams.get('refresh') === 'true'
          ? await this.d.quotaRefresh?.() : this.d.quotaSnapshot?.();
        return this.send(res, 200, quotas || { groups: [] });
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
      if (status >= 500) console.warn('[altair] phone bridge:', err.message);
      if (!res.headersSent) this.send(res, status, { error: err.message || 'error' });
    }
  }

  async media(text, kind, opts = {}) {
    try {
      const said = await this.d.photo(text, kind, opts.ephemeral ? [] : (opts.history ?? this.turns).slice(-4));
      const m = /\[\[photo:([\w.-]+\.(?:png|webm))\]\]/.exec(said);
      const reply = said.replace(/\[\[photo:[^\]]*\]\]/g, '').trim() || 'Держи.';
      if (!opts.ephemeral && opts.history === undefined) this.turns.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      return { reply, brain: 'comfyui', image: m?.[1] || null };
    } catch (err) {
      return { reply: `Не вышло скинуть: ${err.message}`, brain: 'error' };
    }
  }

  async switchModel(text) {
    const wanted = parseModelCommand(text);
    if (!wanted || !this.d.switchModel) return null;
    const r = await this.d.switchModel(wanted).catch(() => null);
    return r?.ok ? { reply: `Переключилась на ${r.model}.`, brain: r.model } : null;
  }

  async reply(flags, signal) {
    const { text, ephemeral, privateMode, deepResearch, skills } = flags;
    const isolated = ephemeral || privateMode || flags.localOnly === true;
    if (/^новый разговор/i.test(text)) {
      if (!isolated && flags.history === undefined) this.turns = [];
      return { reply: 'Начинаем с чистого листа.', brain: 'altair' };
    }
    if (deepResearch) {
      try {
        const res = await this.runDeepResearch(text, { ...flags, signal });
        signal?.throwIfAborted();
        if (flags.history === undefined) this.turns.push({ role: 'user', content: text }, { role: 'assistant', content: res.reply });
        return { reply: res.reply, brain: res.brain };
      } catch (err) {
        return { reply: `Deep Research не прошёл: ${err.message}`, brain: 'error' };
      }
    }

    const baseSysParts = [this.d.persona({
      isolated,
      ephemeral,
      privateMode,
      localMode: flags.localMode,
      useVault: flags.useVault !== false,
      requestedModel: flags.requestedModel,
    }), PHONE_NOTE];
    baseSysParts.push('Поддерживай тему текущего диалога. Не упоминай личные факты, числа, расписание и технические детали из памяти без прямой связи с вопросом. Если данных не хватает, скажи об этом.');
    if (ephemeral) baseSysParts.push('Временный чат: не ссылайся на долговременную память и не сохраняй факты.');
    if (privateMode) baseSysParts.push('Режим Приват (Vault): строго локальная обработка, данные и контекст только из Vault, выход в облако запрещён.');
    const skillMode = flags.localMode || (privateMode ? 'private' : 'chat');
    const pluginCtx = this.pluginsEngine().buildPromptContext({
      mode: skillMode,
      ephemeral: Boolean(ephemeral),
      userText: text,
    });
    if (pluginCtx.blocked) {
      return {
        reply: pluginCtx.blockReason || 'Запрос заблокирован правилом безопасности.',
        brain: 'guard',
        ...(pluginCtx.warnings?.length && { warnings: pluginCtx.warnings }),
      };
    }
    const skillCtx = this.skillsEngine().buildPromptContext({
      mode: skillMode,
      ephemeral: Boolean(ephemeral),
      explicitSkills: flags.skills,
      userText: text,
      isCloud: false,
    });
    const connCtx = await this.connectorsEngine().resolveTurnContext({
      text,
      mode: skillMode,
      ephemeral: Boolean(ephemeral),
      isCloud: false,
    });
    // 2.7a: the phone chat runs on local models only, so local-only styles and voices are fine here
    const styleTurn = this.d.stylesEngine?.resolveTurn({ text: connCtx.cleanedText || text, isCloud: false }) || null;
    const effectiveText = styleTurn?.cleanedText || connCtx.cleanedText || text;
    const missingFallback = (Array.isArray(flags.skills) ? flags.skills : [])
      .filter((sk) => !skillCtx.activeSkillIds.includes(sk) && !skillCtx.pausedSkillIds.includes(sk) && SKILL_NOTES[sk])
      .map((sk) => SKILL_NOTES[sk]);
    const baseSystemPrompt = baseSysParts.filter(Boolean).join('\n');
    const skillsText = [
      styleTurn?.block,
      skillCtx.text,
      pluginCtx.text,
      connCtx.contextBlock,
      connCtx.hintsBlock,
      ...missingFallback,
      flags.slashSystemHint,
    ].filter(Boolean).join('\n\n');
    const sysContent = [baseSystemPrompt, skillsText].filter(Boolean).join('\n');

    const historySlice = flags.history ?? (isolated ? [] : this.turns.slice(-TURNS * 2));
    const userMsg = { role: 'user', content: effectiveText, ...(flags.images?.length ? { images: flags.images } : {}) };
    const messages = [
      { role: 'system', content: sysContent },
      ...historySlice,
      userMsg,
    ];
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('Модель не завершила ответ за 10 минут.')), 10 * 60 * 1000);
    try {
      const opts = {
        ephemeral: ephemeral || flags.btw === true,
        localOnly: isolated,
        source: privateMode ? 'vault' : undefined,
        skills,
        requestedModel: flags.requestedModel,
        useVault: flags.btw === true ? false : flags.useVault !== false,
        mobile: true,
        numPredict: -1,
        contextParts: { systemPrompt: baseSystemPrompt, skillsText },
        ...(flags.requireVision && { requireVision: true }),
        ...(flags.localMode && { localMode: flags.localMode }),
      };
      opts.onActivity = flags.onActivity;
      const requestSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      const firstChat = await this.d.chat(messages, requestSignal, opts);
      requestSignal.throwIfAborted();
      let brain = firstChat?.brain;
      let context = firstChat?.context;
      let reply = String(firstChat?.text || '').trim();
      const usedConnectors = [...connCtx.usedConnectorIds];

      const useTag = parseModelUseTag(reply);
      if (useTag) {
        const followRes = await this.connectorsEngine().queryConnector({
          id: useTag.id,
          query: useTag.query || effectiveText,
          mode: skillMode,
          ephemeral: Boolean(ephemeral),
          isCloud: false,
        });
        const followPayload = followRes.ok
          ? followRes.reply
          : `Коннектор ${useTag.id} не ответил: ${followRes.error || 'ошибка'}`;
        const followMessages = [
          ...messages,
          { role: 'assistant', content: reply },
          {
            role: 'user',
            content: `[Результат коннектора ${useTag.id} (только чтение)]\n${followPayload}\n\nДай итоговый ответ пользователю по этим данным, без тега [[use:...]].`,
          },
        ];
        const secondChat = await this.d.chat(followMessages, requestSignal, opts);
        requestSignal.throwIfAborted();
        const cleanedFollow = stripModelUseTags(secondChat?.text || '');
        if (cleanedFollow) {
          reply = cleanedFollow;
          brain = secondChat?.brain || brain;
          context = secondChat?.context || context;
        } else {
          reply = stripModelUseTags(reply) || followPayload;
        }
        if (followRes.ok && !usedConnectors.includes(useTag.id)) {
          usedConnectors.push(useTag.id);
        }
      }

      if (!reply) return { reply: 'Модель промолчала. Спроси ещё раз, покороче.', brain };
      if (!isolated && flags.btw !== true && flags.history === undefined) {
        this.turns.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
      }
      const contextStats = context || buildContextStats({
        model: brain || flags.requestedModel || 'auto',
        provider: 'ollama',
        systemPrompt: baseSystemPrompt,
        skillsText,
        messages: [...historySlice, userMsg, { role: 'assistant', content: reply }],
      });
      return {
        reply,
        brain,
        context: contextStats,
        ...(usedConnectors.length && { connectors: usedConnectors }),
        ...(pluginCtx.warnings?.length && { warnings: pluginCtx.warnings }),
        ...(flags.btw === true && { btw: true }),
      };
    } catch (err) {
      return { reply: `Не вышло ответить: ${err.message}`, brain: 'error' };
    } finally {
      clearTimeout(timer);
    }
  }

  async turn(flags, voice, signal) {
    if (signal?.aborted) return CHAT_ABORTED;
    const text = flags.text;
    const isolated = flags.ephemeral || flags.privateMode || flags.localOnly === true;
    const isBtw = flags.btw === true;
    const search = /^найди в сети:\s*([\s\S]+)$/i.exec(text)?.[1].trim();
    if (search && !flags.deepResearch) {
      if (isolated || this.d.externalBlocked?.(search)) {
        return { reply: 'Обычный веб-поиск недоступен в этом режиме.', brain: 'error', pose: '' };
      }
      try {
        const found = await this.d.webSearch?.(search);
        if (!found) throw new Error('browser unavailable');
        const links = (found.results || []).slice(0, 3).map((item) => `${item.title || item.url} — ${item.url}`);
        return { reply: links.join('\n\n') || 'По этому запросу в браузере ничего не нашлось.', brain: 'web', pose: '' };
      } catch {
        return { reply: 'Браузерный поиск сейчас недоступен. Результатов нет.', brain: 'error', pose: '' };
      }
    }
    const media = !isolated && !isBtw && !flags.deepResearch && this.d.photo && (flags.forceDraw ? 'photo' : this.d.mediaKind?.(text));
    const { reply, brain, image, context, warnings } = media ? await this.media(text, media, flags)
      : (!isolated && !isBtw && !flags.deepResearch && (!flags.requestedModel || flags.requestedModel === 'auto') && await this.switchModel(text))
        || await this.reply(flags, signal);
    if (signal?.aborted) return CHAT_ABORTED;

    // Временные чаты (ephemeral), приватный Vault (privateMode), 18+ (localOnly), btw и useVault: false не утекают в общий лог чатов
    if (brain !== 'error' && brain !== 'guard' && !isolated && !isBtw && flags.useVault !== false && !/^новый разговор/i.test(text)) {
      this.d.log?.({ said: text, answer: image ? `${reply}\n[[photo:${image}]]` : reply });
    }
    const out = {
      reply,
      brain,
      pose: '',
      ...(isBtw && { btw: true }),
      ...(image && { image: `/gallery/${image}` }),
      ...(context && { context }),
      ...(warnings?.length && { warnings }),
    };
    if (voice && brain !== 'error') {
      const data = await this.d.speak(reply).catch(() => null);
      if (signal?.aborted) return CHAT_ABORTED;
      if (data) {
        const id = `${crypto.randomUUID().replace(/-/g, '')}.mp3`;
        this.audio.set(id, { data, at: Date.now() });
        this.pruneAudio();
        out.audio = `/audio/${id}`;
      }
    }
    if (flags.privateChatId && !isBtw && brain !== 'error' && !signal?.aborted) {
      try {
        await this.d.savePrivateChat(flags.privateChatId, [
          { role: 'user', content: flags.privateUserText ?? text },
          { role: 'assistant', content: reply },
        ], { append: true });
        out.vaultSaved = true;
      } catch (err) {
        out.vaultSaved = false;
        out.vaultError = [403, 409, 413].includes(err?.status) ? err.message : 'Приватный Vault недоступен.';
      }
    }
    return out;
  }
}

module.exports = {
  PhoneBridge,
  newToken,
  tokenMatches,
  addresses,
  controlPatch,
  parseModelCommand,
  parsePromptFlags,
  DEFAULT_SUGGESTIONS,
};
