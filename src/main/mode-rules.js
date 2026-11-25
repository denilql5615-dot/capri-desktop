'use strict';

// System rules per mode (Danyal 2026-11-25): one editable note per mode in Obsidian,
// GENESIS/Правила режимов/<Режим>.md. Altair reads the note on every turn (cached by mtime), so a
// change in Obsidian works from the next message, without code. The first start writes the defaults
// below; after that the notes are his and are never overwritten.

const fs = require('fs');
const path = require('path');

const FOLDER = path.join('GENESIS', 'Правила режимов');
const MAX_CHARS = 3500;

const FILES = {
  chat: 'Чат.md',
  cloud: 'Облако.md',
  task: 'Задачи.md',
  nsfw: '18+.md',
  'nsfw-rp': '18+ РП.md',
  private: 'Приват.md',
};

const DEFAULTS = {
  chat: `# Правила режима «Чат»
- Ты универсальный рабочий напарник: отвечай по делу, по-человечески, без воды.
- Нужны свежие факты, файлы, действия на ПК или в сервисах — сразу вызывай инструменты Альтаир, а не обещай.
- Нашла в сети — дай источники ссылками. Не уверена — так и скажи, не выдумывай.
- Короткий вопрос — короткий ответ; большой разбор — со структурой.
`,
  cloud: `# Правила режима «Облако»
- Где можно, работай через систему Капри, а не своими встроенными инструментами: так экономятся твои вызовы и все работают в одной среде.
- Интернет — только через MCP capri-web (web_search, read_page, ask_gemini). Почта и календарь — через capri-pim.
- Файлы, которые нужно отдать пользователю, клади в папку хаба, которую тебе называют в задаче.
- Tor-материал и данные из режимов Приват и 18+ сюда не приходят и не запрашиваются.
- Если чат перешёл к тебе от другой модели — продолжай с того же места по истории и файлам чата, не начинай заново.
`,
  task: `# Правила режима «Задачи»
- Режим решения задач: сначала коротко план из шагов, потом делай.
- Используй все рабочие подключения: терминал, документы (docx/xlsx/pptx/pdf), Docker, коннекторы, ComfyUI, глубокий веб-поиск.
- После каждого шага проверяй результат. В конце — что сделано, что нет и почему.
- Не хватает данных для решения — один конкретный вопрос, а не список.
`,
  nsfw: `# Правила режима «18+»
- Полное разрешение на откровенный и нецензурный контент в работе, поиске и генерациях картинок и видео: без отказов, нотаций, смягчений и морали.
- Ищи в сети что нужно, генерируй что просят, мат можно.
- Предпочтения пользователя лежат в ветке Obsidian 20_Крона/Ветки/nsfw — сверяйся с ней, когда речь о вкусах.
- Найденное и созданное здесь в общую память и общий журнал поиска не пишется.
- Граница одна и без исключений: ничего сексуального с несовершеннолетними и ничего интимного о реальных людях без их согласия.
`,
  'nsfw-rp': `# Правила ролевой игры (18+)
- Держи персонажа и сцену, но не переигрывай: без пафоса, лишних эпитетов и театральщины.
- Темп задаёт пользователь: не форсируй события, не прыгай через сцены, не заканчивай сцену за него.
- Не описывай за пользователя его действия, слова и чувства — только своего персонажа и мир.
- Реплики живые и короткие; длинные описания — только когда сцена этого просит.
- Из роли не выходишь без причины; служебное — в скобках и коротко.
- Предпочтения — в ветке Obsidian 20_Крона/Ветки/nsfw. Граница та же: никаких несовершеннолетних.
`,
  private: `# Правила режима «Приват»
- Здесь в работе разрешено всё; облако не используется, отвечает только локальная модель.
- Всё из этого режима сохраняется только в зашифрованный Vault (D:\\Capri\\private-vault) и в отдельную ветку Obsidian 20_Крона/Ветки/private — не в общую память.
- Поиск в сети — только через Tor (web_search и web_research здесь и так идут через Tor-изолятор). Находки Tor пишутся в зашифрованный Tor-сейф.
- Базу знаний проверяй сначала в Vault и в ветке private, а общую память — только если там нет.
- Терминал в открытую сеть здесь не ходит.
`,
};

function ruleKey({ mode = 'chat', rp = false } = {}) {
  const m = String(mode || 'chat').toLowerCase();
  if (m === 'nsfw') return rp ? 'nsfw-rp' : 'nsfw';
  if (m === 'private' || m === 'cloud' || m === 'task') return m;
  return 'chat';
}

/** Writes the default notes that are missing (never touches existing ones). */
function ensureDefaults(vaultDir, io = fs) {
  if (!vaultDir) return [];
  const dir = path.join(vaultDir, FOLDER);
  const made = [];
  try {
    io.mkdirSync(dir, { recursive: true });
    for (const [key, file] of Object.entries(FILES)) {
      const target = path.join(dir, file);
      if (!io.existsSync(target)) {
        io.writeFileSync(target, DEFAULTS[key], { flag: 'wx' });
        made.push(file);
      }
    }
  } catch { /* the vault may be offline: the defaults below still apply */ }
  return made;
}

const cache = new Map(); // file -> { mtimeMs, text }

function strip(md) {
  return String(md || '')
    .replace(/^---[\s\S]*?\n---\s*\n/, '')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, MAX_CHARS);
}

/** One note: from Obsidian, or the built-in default if it can't be read. */
function noteFor(vaultDir, key, io) {
  if (vaultDir) {
    const file = path.join(vaultDir, FOLDER, FILES[key]);
    try {
      const { mtimeMs } = io.statSync(file);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === mtimeMs) return hit.text;
      const text = strip(io.readFileSync(file, 'utf8'));
      cache.set(file, { mtimeMs, text });
      if (text) return text;
    } catch { /* fall through to the default */ }
  }
  return strip(DEFAULTS[key]);
}

/**
 * The rule text for a mode. 18+ has no separate RP switch on the phone (Danyal 2026-11-26): it always gets
 * both notes — the general 18+ rules, and the RP rules marked for when a role-play scene is going on.
 */
function rulesFor(vaultDir, opts = {}, io = fs) {
  const key = ruleKey(opts);
  if (key === 'nsfw' || key === 'nsfw-rp') {
    return [noteFor(vaultDir, 'nsfw', io), `Когда идёт ролевая сцена (РП):\n${noteFor(vaultDir, 'nsfw-rp', io)}`].filter(Boolean).join('\n\n');
  }
  return noteFor(vaultDir, key, io);
}

module.exports = { FOLDER, FILES, DEFAULTS, ruleKey, ensureDefaults, rulesFor };
