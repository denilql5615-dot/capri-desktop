// Her planner as her hub shows it (hub.js): what's coming, by day, and the words she is asked to put a
// meeting into Proton Calendar with. planner.json is kept in main.js (planner.js); these only read it.

export const when = (p) => p.start ?? p.due ?? p.at ?? p.createdAt;

// the plans to show: 'soon' (open, from today on, and open tasks without a date), 'done', or 'all';
// soonest first, a note or an undated task at the end
export function pick(plans, view = 'soon', now = Date.now()) {
  const today = new Date(now).setHours(0, 0, 0, 0);
  const undated = (p) => p.kind === 'note' || (p.kind === 'task' && p.due == null);
  return plans
    .filter((p) => (view === 'all' ? true : view === 'done' ? p.status === 'done'
      : p.status === 'open' && (undated(p) || when(p) >= today || p.kind === 'task')))
    .sort((a, b) => (undated(a) - undated(b)) || (when(a) - when(b)));
}

// [{ day: start of the day (ms) or null for undated, plans }] in the order given
export function byDay(plans) {
  const days = [];
  for (const p of plans) {
    const dated = !(p.kind === 'note' || (p.kind === 'task' && p.due == null));
    const day = dated ? new Date(when(p)).setHours(0, 0, 0, 0) : null;
    const last = days.at(-1);
    if (last && last.day === day) last.plans.push(p);
    else days.push({ day, plans: [p] });
  }
  return days;
}

// A meeting from her planner into Proton Calendar: said to her like you would, so it goes to Claude or
// Codex driving your PC (agent.js isComputerTask). The final Create stays yours.
export function protonPhrase(p, lang = 'ru', timeZone) {
  const date = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(new Date(p.start));
  const hm = (at) => new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(at));
  const title = String(p.title || '').replace(/[«»"]/g, '').slice(0, 200);
  const notes = String(p.notes || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (lang.startsWith('ru')) {
    return `Открой Proton Calendar и заполни встречу «${title}» на ${date}, с ${hm(p.start)}${p.end ? ` до ${hm(p.end)}` : ''}`
      + `${notes ? `, в описании: ${notes}` : ''}. Не нажимай Создать: последнюю кнопку я нажму сам.`;
  }
  return `Open Proton Calendar and fill in the event "${title}" on ${date}, from ${hm(p.start)}${p.end ? ` to ${hm(p.end)}` : ''}`
    + `${notes ? `, description: ${notes}` : ''}. Don't click Create: I'll press the last button myself.`;
}

// a local "YYYY-MM-DDTHH:MM" (an <input type="datetime-local">) as ms, or null
export function fromInput(value) {
  if (!value) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}
