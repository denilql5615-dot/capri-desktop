'use strict';

// Her quick answers (the router's tier 1): a plain question about your schedule ("что у меня завтра?",
// "какие планы на неделю", "я свободен в пятницу?"), reminders ("какие напоминания?"), or fresh mail
// ("что пришло на почту?", "есть новые письма?") is answered from Proton Calendar, Proton Mail, and her
// planner right away, by code: no model, no wait, nothing loaded on the GPU.

const ASK_RE = /^\s*(а\s+|ну\s+|слушай,?\s+|капри,?\s+)*(что\s+у\s+меня|что\s+там\s+у\s+меня|какие\s+(у\s+меня\s+)?(планы|встречи|дела|задачи|события)|мои\s+планы|покажи\s+(мои\s+)?(планы|расписание|встречи)|расписание|я\s+(занят|свобод[еа]н))/i;
const REMINDER_RE = /^\s*(а\s+|ну\s+|слушай,?\s+|капри,?\s+)*(какие\s+(у\s+меня\s+)?напоминания|мои\s+напоминания|покажи\s+(мои\s+)?напоминания|что\s+(там\s+)?по\s+напоминаниям|есть\s+(ли\s+)?напоминания)/i;
const MAIL_RE = /^\s*(а\s+|ну\s+|слушай,?\s+|капри,?\s+)*(что\s+(там\s+)?(пришло|нового|есть)\s+(на\s+почт[уе]|в\s+почт[еу]|в\s+ящик[е]?)|что\s+(там\s+)?в\s+почте|что\s+с\s+почтой|проверь\s+почту|покажи\s+(новые\s+|последние\s+|свежие\s+)?письма|какие\s+(новые\s+|последние\s+|свежие\s+)?письма|есть\s+(ли\s+)?(новые\s+|свежие\s+)?письма|новые\s+письма)/i;
const MUSIC_NOW_RE = /^\s*(а\s+|ну\s+|слушай,?\s+|капри,?\s+)*(что\s+(сейчас\s+|там\s+)?играет|какая\s+(сейчас\s+)?(песня|музыка)\s*(играет)?|какой\s+(сейчас\s+)?трек\s*(играет)?|что\s+по[её]т)/i;
const PC_STATUS_RE = /^\s*(а\s+|ну\s+|слушай,?\s+|капри,?\s+)*(сколько\s+(свободного\s+)?места(\s+на\s+диск[еах])?|сколько\s+(сейчас\s+)?(оперативки|озу|памяти\s+занято|ram|видеопамяти|vram)|какой\s+(сейчас\s+)?(заряд(\s+батареи)?|у\s+меня\s+ip|айпи)|статус\s+(пк|системы|компьютера|пекарни|гпу|gpu|видеокарты)|состояние\s+(пк|системы|компьютера)|кто\s+(сейчас\s+)?жр[её]т\s+(память|озу|оперативку)|топ\s+процессов|нагрузка\s+(на\s+)?(пк|систему)|температура\s+(гпу|gpu|видеокарты))/i;
const FREE_MEM_RE = /^\s*(а\s+|ну\s+|слушай,?\s+|капри,?\s+)*(освободи\s+(память|озу|оперативку|vram|видеопамять)|выгрузи\s+(модели|ollama|олламу)|очисти\s+(память|озу|vram|видеопамять))\s*[.!?]*$/i;
const QUICK_SEARCH_RE = /^\s*(?:капри,?\s+)?(?:найди\s+в\s+(?:обсидиан[е]?|obsidian|баз[е]|заметках)|что\s+в\s+(?:обсидиан[е]?|заметках|баз[е])\s+(?:про|о|об)|найди\s+(?:файл|документ|заметку))\s*[,:—-]?\s*(.+)$/i;
const AGENTS_STATUS_RE = /^\s*(а\s+|ну\s+|слушай,?\s+|капри,?\s+)*(что\s+(там\s+)?в\s+хабе|кто\s+(сейчас\s+)?работает\s+в\s+хабе|какие\s+задачи\s+в\s+(работе|хабе)|статус\s+(агентов|хаба)|чем\s+заняты\s+агенты)/i;
const REMEMBER_RE = /^\s*(?:капри,?\s+)?(?:запомни|запиши\s+в\s+память|сохрани\s+в\s+память|запиши\s+заметку)(?:\s*,?\s*что)?\s*[,:—-]?\s*(.+)$/is;
const MORE_RE = /(?<![а-яё])(перенес|перенос|добав|созда|запланир|назнач|удали|отмени|убери|напомни|измени|поменя|почему|зачем|как\s+лучше|посовету|и\s+ещ[её]|а\s+ещ[её]|потом|затем|напиши|отправ|ответь|сделай|прочитай\s+полностью|о\s+ч[её]м)/i;

function parseRememberCommand(said) {
  const m = REMEMBER_RE.exec(String(said || '').trim());
  const text = m?.[1]?.trim();
  return text && text.length >= 3 && text.length <= 1000 ? text : null;
}

function isQuickFreeMemory(said) {
  const t = String(said || '').trim();
  return t.length > 0 && t.length <= 80 && FREE_MEM_RE.test(t);
}

function parseQuickSearchCommand(said) {
  const m = QUICK_SEARCH_RE.exec(String(said || '').trim());
  const q = m?.[1]?.replace(/[.!?]+$/, '').trim();
  return q && q.length >= 2 && q.length <= 120 ? q : null;
}

const REMIND_IN_RE = /^\s*(?:капри,?\s+)?напомни\s+через\s+(\d{1,3})\s*(минут[а-я]*|мин\.?|час[а-я]*|ч\.?)\s*[,:—-]?\s*(.+)$/i;
const REMIND_AT_RE = /^\s*(?:капри,?\s+)?напомни\s+(?:(сегодня|завтра)\s+)?в\s+(\d{1,2})[:.](\d{2})\s*[,:—-]?\s*(.+)$/i;
const QUICK_TASK_RE = /^\s*(?:капри,?\s+)?(?:добавь|создай|запиши)\s+(?:задачу|в\s+планы|план)\s*[,:—-]?\s*(.+)$/i;

function parseQuickPlanCommand(said, now = new Date()) {
  const t = String(said || '').trim();
  const inMatch = REMIND_IN_RE.exec(t);
  if (inMatch) {
    const count = Number(inMatch[1]);
    const isHours = /^ч/i.test(inMatch[2]);
    const title = inMatch[3].replace(/[.!?]+$/, '').trim();
    if (count > 0 && title) {
      const ms = count * (isHours ? 3600_000 : 60_000);
      return { kind: 'reminder', title, at: now.getTime() + ms };
    }
  }
  const atMatch = REMIND_AT_RE.exec(t);
  if (atMatch) {
    const dayWord = (atMatch[1] || '').toLowerCase();
    const h = Number(atMatch[2]);
    const m = Number(atMatch[3]);
    const title = atMatch[4].replace(/[.!?]+$/, '').trim();
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59 && title) {
      const target = new Date(now);
      target.setHours(h, m, 0, 0);
      if (dayWord === 'завтра' || (!dayWord && target.getTime() <= now.getTime())) {
        target.setDate(target.getDate() + 1);
      }
      return { kind: 'reminder', title, at: target.getTime() };
    }
  }
  const taskMatch = QUICK_TASK_RE.exec(t);
  if (taskMatch) {
    const title = taskMatch[1].replace(/[.!?]+$/, '').trim();
    if (title.length >= 2) return { kind: 'task', title };
  }
  return null;
}

function parseQuickRemoteCommand(said) {
  const t = String(said || '').trim();
  if (/^\s*(?:капри,?\s+)?(?:поставь\s+(?:музыку\s+)?на\s+паузу|пауза|стоп\s+музык[ау]|останови\s+музыку)\s*[.!?]*$/i.test(t)) {
    return { type: 'media', action: 'pause', label: 'Поставила плеер на паузу.' };
  }
  if (/^\s*(?:капри,?\s+)?(?:продолжи\s+музыку|сними\s+с\s+паузы|включи\s+плеер)\s*[.!?]*$/i.test(t)) {
    return { type: 'media', action: 'play', label: 'Продолжаю воспроизведение.' };
  }
  if (/^\s*(?:капри,?\s+)?(?:следующий\s+трек|дальше\s+трек|скипни\s+трек|переключи\s+трек)\s*[.!?]*$/i.test(t)) {
    return { type: 'media', action: 'next', label: 'Переключила на следующий трек.' };
  }
  if (/^\s*(?:капри,?\s+)?(?:предыдущий\s+трек|прошлый\s+трек|верни\s+трек)\s*[.!?]*$/i.test(t)) {
    return { type: 'media', action: 'prev', label: 'Вернула предыдущий трек.' };
  }
  const volMatch = /^\s*(?:капри,?\s+)?(?:поставь\s+|сделай\s+)?громкость\s+(?:на\s+)?(\d{1,3})\s*(?:%|процент[а-я]*)?\s*[.!?]*$/i.exec(t);
  if (volMatch) {
    const level = Math.min(100, Math.max(0, Number(volMatch[1])));
    return { type: 'volume', level, label: `Поставила громкость ПК на ${level}%.` };
  }
  if (/^\s*(?:капри,?\s+)?(?:выключи\s+звук|без\s+звука|замуть(?:\s+пк)?)\s*[.!?]*$/i.test(t)) {
    return { type: 'volume', mute: true, label: 'Выключила звук на ПК.' };
  }
  if (/^\s*(?:капри,?\s+)?(?:включи\s+звук|размуть(?:\s+пк)?)\s*[.!?]*$/i.test(t)) {
    return { type: 'volume', mute: false, label: 'Включила звук на ПК.' };
  }
  if (/^\s*(?:капри,?\s+)?заблокируй\s+(?:пк|комп|компьютер|ноутбук|экран)\s*[.!?]*$/i.test(t)) {
    return { type: 'lock', label: 'Заблокировала экран ноутбука.' };
  }
  return null;
}

const CLIPBOARD_GET_RE = /^\s*(?:капри,?\s+)?(?:что\s+в\s+буфере(?:\s+пк)?|скинь\s+буфер(?:\s+пк)?|покажи\s+буфер(?:\s+пк)?|буфер\s+обмена(?:\s+пк)?)\s*[.!?]*$/i;
const CLIPBOARD_SET_RE = /^\s*(?:капри,?\s+)?(?:скопируй\s+на\s+пк|в\s+буфер\s+пк|запиши\s+в\s+буфер)\s*[,:—-]?\s*(.+)$/is;
const ALTA_STATUS_RE = /^\s*(?:\/alta|(?:а\s+|ну\s+|слушай,?\s+|капри,?\s+)*(?:что\s+(?:там\s+)?по\s+(?:альт[еа]|alta)|статус\s+(?:альт[ыа]|alta)|план\s+(?:альт[ыа]|alta)|сводка\s+(?:по\s+)?(?:альт[еа]|alta)|дедлайны\s+(?:альт[ыа]|alta)))\s*[.!?]*$/i;

function parseClipboardCommand(said) {
  const t = String(said || '').trim();
  if (CLIPBOARD_GET_RE.test(t)) return { type: 'get', action: 'get' };
  const m = CLIPBOARD_SET_RE.exec(t);
  if (m && m[1]?.trim()) return { type: 'set', action: 'set', text: m[1].trim() };
  return null;
}

function isQuickAlta(said) {
  const t = String(said || '').trim();
  return t.length > 0 && t.length <= 80 && ALTA_STATUS_RE.test(t);
}

function altaStatusAnswer({ planMarkdown = '', tasks = [] } = {}) {
  const lines = [];
  const bullets = String(planMarkdown || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .slice(0, 7)
    .map((l) => `• ${l.slice(2).replace(/\[\[([^\]]+)\]\]/g, '$1')}`);
  if (bullets.length) {
    lines.push('Ключевые вехи ALTA (из Obsidian):', ...bullets);
  }
  const altaTasks = tasks.filter((t) => /alta|альт/i.test(`${t.title} ${t.notes || ''}`) && t.status !== 'done');
  if (altaTasks.length) {
    lines.push('Задачи в Планировщике:', ...altaTasks.slice(0, 5).map((t) => `• ${clip(t.title, 100)}`));
  }
  return lines.length ? lines.join('\n') : 'В базе Obsidian не найден файл ALTA/План ALTA.md.';
}

function isQuickReminders(said) {
  const t = String(said || '').trim();
  return t.length > 0 && t.length <= 90 && /[а-яё]/i.test(t) && REMINDER_RE.test(t) && !MORE_RE.test(t);
}

function isQuickMail(said) {
  const t = String(said || '').trim();
  return t.length > 0 && t.length <= 90 && /[а-яё]/i.test(t) && MAIL_RE.test(t) && !MORE_RE.test(t);
}

function isQuickMusic(said) {
  const t = String(said || '').trim();
  return t.length > 0 && t.length <= 80 && /[а-яё]/i.test(t) && MUSIC_NOW_RE.test(t) && !MORE_RE.test(t);
}

function isQuickPcStatus(said) {
  const t = String(said || '').trim();
  return t.length > 0 && t.length <= 90 && /[а-яё]/i.test(t) && PC_STATUS_RE.test(t) && !MORE_RE.test(t);
}

function isQuickAgentsStatus(said) {
  const t = String(said || '').trim();
  return t.length > 0 && t.length <= 90 && /[а-яё]/i.test(t) && AGENTS_STATUS_RE.test(t) && !MORE_RE.test(t);
}

/** A plain question about your schedule, answered by code (Russian only: her lines here are Russian). */
function isQuick(said) {
  const t = String(said || '').trim();
  return (t.length > 0 && t.length <= 90 && /[а-яё]/i.test(t) && ASK_RE.test(t) && !MORE_RE.test(t))
    || isQuickReminders(t);
}

const DAY_MS = 24 * 3600 * 1000;

function spanName(from, to, now, timeZone) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const offset = Math.round((from.getTime() - midnight.getTime()) / DAY_MS);
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS);
  if (days <= 1) {
    if (offset === 0) return 'Сегодня';
    if (offset === 1) return 'Завтра';
    if (offset === 2) return 'Послезавтра';
    return new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone }).format(from).replace(/^./, (c) => c.toUpperCase());
  }
  return days > 8 ? 'В ближайший месяц' : 'На ближайшей неделе';
}

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Her answer from what's on the calendar and in her planner for [from, to), or the plain "nothing". */
function scheduleAnswer({ events = [], plans = [], from, to, now = new Date(), timeZone } = {}) {
  const oneDay = to.getTime() - from.getTime() <= DAY_MS;
  const hm = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone });
  const dayHm = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone });
  const when = (at) => (oneDay ? hm : dayHm).format(new Date(at));
  const rows = [
    ...events.map((e) => ({ at: Date.parse(e.start), line: `${when(e.start)} — ${clip(e.title, 120)}${e.location ? ` (${clip(e.location, 60)})` : ''}` })),
    ...plans.filter((p) => p.kind !== 'note' && p.status !== 'done').map((p) => {
      const at = p.start ?? p.due ?? p.at;
      const kind = { task: 'задача: ', reminder: 'напоминание: ' }[p.kind] || '';
      return { at, line: `${when(at)} — ${kind}${clip(p.title, 120)}` };
    }),
  ].filter((r) => Number.isFinite(r.at)).sort((a, b) => a.at - b.at);
  const name = spanName(from, to, now, timeZone);
  if (!rows.length) return `${name} у тебя ничего не запланировано. Свободен.`;
  const shown = rows.slice(0, 8).map((r) => `• ${r.line}`);
  const more = rows.length > 8 ? `\n…и ещё ${rows.length - 8}.` : '';
  const count = rows.length === 1 ? 'одно дело' : rows.length < 5 ? `${rows.length} дела` : `${rows.length} дел`;
  return `${name} у тебя ${count}:\n${shown.join('\n')}${more}`;
}

/** Active reminders from config.reminders and open planner reminders. */
function remindersAnswer({ reminders = [], plans = [], timeZone } = {}) {
  const dayHm = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone });
  const seen = new Set();
  const rows = [];
  for (const r of reminders) {
    if (!Number.isFinite(r.at)) continue;
    const key = r.planId || `${r.at}:${r.text}`;
    seen.add(key);
    rows.push({ at: r.at, line: `${dayHm.format(new Date(r.at))} — ${clip(r.text, 120)}` });
  }
  for (const p of plans) {
    if (p.kind !== 'reminder' || p.status === 'done' || !Number.isFinite(p.at) || seen.has(p.id)) continue;
    rows.push({ at: p.at, line: `${dayHm.format(new Date(p.at))} — ${clip(p.title, 120)}` });
  }
  rows.sort((a, b) => a.at - b.at);
  if (!rows.length) return 'Активных напоминаний сейчас нет.';
  const shown = rows.slice(0, 8).map((r) => `• ${r.line}`);
  const count = rows.length === 1 ? 'одно напоминание' : rows.length < 5 ? `${rows.length} напоминания` : `${rows.length} напоминаний`;
  return `У тебя ${count}:\n${shown.join('\n')}`;
}

/** Instant summary of recent/unread emails from Proton Mail / Gmail reserve (read-only, no LLM needed). */
function mailAnswer(mails = []) {
  if (!mails.length) return 'В почте пока пусто — свежих писем не нашла.';
  const unread = mails.filter((m) => m.unread);
  const list = (unread.length ? unread : mails).slice(0, 5);
  const header = unread.length
    ? `Непрочитанных писем: ${unread.length}. Последние:`
    : 'Новых непрочитанных нет. Последние письма в ящике:';
  const lines = list.map((m) => {
    const sender = clip(String(m.from || '').replace(/<[^>]+>/g, '').replace(/"/g, ''), 50) || 'неизвестно';
    const subj = clip(m.subject || '(без темы)', 90);
    return `• ${sender} — ${subj}`;
  });
  return `${header}\n${lines.join('\n')}`;
}

function musicNowAnswer(np) {
  if (!np) return 'Сейчас ни один плеер (Riff, AIMP, Spotify) не запущен.';
  if (np.playing && np.track) return `Сейчас в ${np.player} играет: ${clip(np.track, 140)}.`;
  return `${np.player} открыт, но сейчас на паузе.`;
}

function gb(bytes) {
  return Math.round((Number(bytes || 0) / (1024 ** 3)) * 10) / 10;
}

function pcStatusAnswer({ disks = [], ram = null, gpu = null, topProcesses = [], battery = null, ip = null } = {}) {
  const parts = [];
  if (disks.length) {
    parts.push(`Диски: ${disks.map((d) => `${d.drive} свободно ${gb(d.free)} ГБ из ${gb(d.total)} ГБ`).join('; ')}.`);
  }
  if (ram?.total) {
    const pct = Math.round((ram.used / ram.total) * 100);
    parts.push(`ОЗУ: занято ${gb(ram.used)} из ${gb(ram.total)} ГБ (${pct}%).`);
  }
  if (gpu?.totalMb) {
    parts.push(`GPU (${gpu.name || 'RTX'}): VRAM ${gpu.usedMb} / ${gpu.totalMb} МБ (нагрузка ${gpu.util}%, ${gpu.temp}°C).`);
  }
  if (topProcesses.length) {
    parts.push(`Топ ОЗУ: ${topProcesses.slice(0, 5).map((p) => `${p.name} (${p.mb} МБ)`).join(', ')}.`);
  }
  if (battery && !battery.none && Number.isFinite(battery.percent)) {
    parts.push(`Батарея: ${battery.percent}% (${battery.charging ? 'на зарядке' : 'от аккумулятора'}).`);
  }
  if (ip) parts.push(`Локальный IP: ${ip}.`);
  return parts.join(' ') || 'Не удалось прочитать метрики ПК.';
}

function quickSearchAnswer({ query, vaultHits = [], fileHits = [] } = {}) {
  if (!vaultHits.length && !fileHits.length) {
    return `По запросу «${query}» в Obsidian и документах ничего не нашлось.`;
  }
  const lines = [];
  for (const v of vaultHits.slice(0, 4)) {
    lines.push(`• [Obsidian] ${v.title} (${v.file}): ${clip(v.text, 140)}`);
  }
  for (const f of fileHits.slice(0, 4)) {
    const snip = f.snippet ? ` — ${clip(f.snippet, 120)}` : '';
    lines.push(`• [Файл] ${f.name} (${f.folder})${snip}`);
  }
  return `Нашла по запросу «${query}»:\n${lines.join('\n')}`;
}

function agentsStatusAnswer(summaries = []) {
  const busy = summaries.filter((s) => s.busy);
  const queued = summaries.filter((s) => s.queued);
  if (!busy.length && !queued.length) {
    const recent = summaries.slice(0, 3).map((s) => `• ${s.agent}: ${clip(s.title || 'Новый разговор', 60)}`);
    return recent.length
      ? `Сейчас в Хабе активных задач нет. Последние чаты:\n${recent.join('\n')}`
      : 'В Хабе пока нет активных задач.';
  }
  const lines = [
    ...busy.map((s) => `• В работе (${s.agent}): ${clip(s.title || 'Задача', 70)}`),
    ...queued.map((s) => `• В очереди (${s.agent}): ${clip(s.title || 'Задача', 70)}`),
  ];
  return `Задачи в Хабе (${lines.length}):\n${lines.join('\n')}`;
}

module.exports = {
  isQuick, isQuickReminders, isQuickMail, isQuickMusic, isQuickPcStatus, isQuickAgentsStatus,
  isQuickFreeMemory, isQuickAlta, parseRememberCommand, parseQuickSearchCommand, parseQuickPlanCommand, parseQuickRemoteCommand, parseClipboardCommand,
  scheduleAnswer, remindersAnswer, mailAnswer, musicNowAnswer, pcStatusAnswer, quickSearchAnswer, agentsStatusAnswer, altaStatusAnswer,
};
