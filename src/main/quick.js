'use strict';

// Her quick answers (the router's tier 1): a plain question about your schedule ("что у меня завтра?",
// "какие планы на неделю", "я свободен в пятницу?"), reminders ("какие напоминания?"), or fresh mail
// ("что пришло на почту?", "есть новые письма?") is answered from Proton Calendar, Proton Mail, and her
// planner right away, by code: no model, no wait, nothing loaded on the GPU.

const ASK_RE = /^\s*(а\s+|ну\s+|слушай,?\s+|капри,?\s+)*(что\s+у\s+меня|что\s+там\s+у\s+меня|какие\s+(у\s+меня\s+)?(планы|встречи|дела|задачи|события)|мои\s+планы|покажи\s+(мои\s+)?(планы|расписание|встречи)|расписание|я\s+(занят|свобод[еа]н))/i;
const REMINDER_RE = /^\s*(а\s+|ну\s+|слушай,?\s+|капри,?\s+)*(какие\s+(у\s+меня\s+)?напоминания|мои\s+напоминания|покажи\s+(мои\s+)?напоминания|что\s+(там\s+)?по\s+напоминаниям|есть\s+(ли\s+)?напоминания)/i;
const MAIL_RE = /^\s*(а\s+|ну\s+|слушай,?\s+|капри,?\s+)*(что\s+(там\s+)?(пришло|нового|есть)\s+(на\s+почт[уе]|в\s+почт[еу]|в\s+ящик[е]?)|что\s+(там\s+)?в\s+почте|что\s+с\s+почтой|проверь\s+почту|покажи\s+(новые\s+|последние\s+|свежие\s+)?письма|какие\s+(новые\s+|последние\s+|свежие\s+)?письма|есть\s+(ли\s+)?(новые\s+|свежие\s+)?письма|новые\s+письма)/i;
const MORE_RE = /(?<![а-яё])(перенес|перенос|добав|созда|запланир|назнач|удали|отмени|убери|напомни|измени|поменя|почему|зачем|как\s+лучше|посовету|и\s+ещ[её]|а\s+ещ[её]|потом|затем|напиши|отправ|ответь|сделай|прочитай\s+полностью|о\s+ч[её]м)/i;

function isQuickReminders(said) {
  const t = String(said || '').trim();
  return t.length > 0 && t.length <= 90 && /[а-яё]/i.test(t) && REMINDER_RE.test(t) && !MORE_RE.test(t);
}

function isQuickMail(said) {
  const t = String(said || '').trim();
  return t.length > 0 && t.length <= 90 && /[а-яё]/i.test(t) && MAIL_RE.test(t) && !MORE_RE.test(t);
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

module.exports = { isQuick, isQuickReminders, isQuickMail, scheduleAnswer, remindersAnswer, mailAnswer };
