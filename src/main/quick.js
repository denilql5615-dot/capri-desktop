'use strict';

// Her quick answers (the router's tier 1): a plain question about your schedule ("что у меня завтра?",
// "какие планы на неделю", "я свободен в пятницу?") is answered from Proton Calendar and her planner
// right away, by code: no model, no wait, nothing loaded on the GPU. Anything more ("перенеси",
// "добавь", "почему", a question with a second part) still goes to her model with the same calendar.

// asks what's there: the start of the question
const ASK_RE = /^\s*(а\s+|ну\s+|слушай,?\s+|капри,?\s+)*(что\s+у\s+меня|что\s+там\s+у\s+меня|какие\s+(у\s+меня\s+)?(планы|встречи|дела|задачи|события|напоминания)|мои\s+планы|покажи\s+(мои\s+)?(планы|расписание|встречи)|расписание|я\s+(занят|свобод[еа]н))/i;
// wants something done or explained, or asks two things: her model
const MORE_RE = /(?<![а-яё])(перенес|перенос|добав|созда|запланир|назнач|удали|отмени|убери|напомни|измени|поменя|почему|зачем|как\s+лучше|посовету|и\s+ещ[её]|а\s+ещ[её]|потом|затем|напиши|отправ|сделай)/i;

/** A plain question about your schedule, answered by code (Russian only: her lines here are Russian). */
function isQuick(said) {
  const t = String(said || '').trim();
  return t.length > 0 && t.length <= 90 && /[а-яё]/i.test(t) && ASK_RE.test(t) && !MORE_RE.test(t);
}

const DAY_MS = 24 * 3600 * 1000;

// "сегодня", "завтра", "в пятницу 7 нояб.", "на этой неделе": how she names the days asked about
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
    ...plans.filter((p) => p.kind !== 'note').map((p) => {
      const at = p.start ?? p.due ?? p.at;
      const kind = { task: 'задача: ', reminder: 'напоминание: ' }[p.kind] || '';
      return { at, line: `${when(at)} — ${kind}${clip(p.title, 120)}${p.status === 'done' ? ' (сделано)' : ''}` };
    }),
  ].filter((r) => Number.isFinite(r.at)).sort((a, b) => a.at - b.at);
  const name = spanName(from, to, now, timeZone);
  if (!rows.length) return `${name} у тебя ничего не запланировано. Свободен.`;
  const shown = rows.slice(0, 8).map((r) => `• ${r.line}`);
  const more = rows.length > 8 ? `\n…и ещё ${rows.length - 8}.` : '';
  const count = rows.length === 1 ? 'одно дело' : rows.length < 5 ? `${rows.length} дела` : `${rows.length} дел`;
  return `${name} у тебя ${count}:\n${shown.join('\n')}${more}`;
}

module.exports = { isQuick, scheduleAnswer };
