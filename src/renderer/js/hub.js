// Her hub (chats.html): three tabs in one window. Chats (chats-window.js); Plans, her planner (meetings,
// tasks, reminders, notes: what you, Claude and Codex put in it), with a meeting sent on to Proton
// Calendar; Settings, her tray menu laid out by section (main.js menuModel: the same items, clicked
// by their path, so the two never drift apart). Text from the planner goes in as text, never markup.

import { pick, byDay, protonPhrase, fromInput, when } from './plans.js';

const T = {
  ru: {
    tabs: { chats: 'Чаты', plans: 'Планы', gallery: 'Галерея', settings: 'Настройки' },
    kinds: { event: 'Встреча', task: 'Задача', reminder: 'Напоминание', note: 'Заметка' },
    views: { soon: 'Впереди', done: 'Сделано', all: 'Всё' },
    title: 'Что записать', at: 'Когда', end: 'До', notes: 'Подробности', add: 'Добавить',
    empty: 'Пусто. Добавь сверху или попроси Капри, Claude или Codex.', undated: 'Без даты', today: 'Сегодня', tomorrow: 'Завтра',
    done: 'Готово', proton: 'В Proton', sent: 'Отправлено Капри', obsidian: 'Obsidian', isDone: 'сделано',
    galleryNote: 'Что она скинула: попроси в чате «скинь фото» — на ПК или с телефона.', galleryEmpty: 'Пока пусто.',
    needAt: 'Нужно время.', needTitle: 'Нужно название.', failed: 'Не вышло: ', main: 'Главное', settingsNote: 'То же, что в меню у трея и по правому клику на Капри.',
  },
  en: {
    tabs: { chats: 'Chats', plans: 'Plans', gallery: 'Gallery', settings: 'Settings' },
    kinds: { event: 'Meeting', task: 'Task', reminder: 'Reminder', note: 'Note' },
    views: { soon: 'Ahead', done: 'Done', all: 'All' },
    title: 'What to note', at: 'When', end: 'Until', notes: 'Details', add: 'Add',
    empty: 'Nothing here. Add one above, or ask Capri, Claude or Codex.', undated: 'No date', today: 'Today', tomorrow: 'Tomorrow',
    done: 'Done', proton: 'To Proton', sent: 'Sent to Capri', obsidian: 'Obsidian', isDone: 'done',
    galleryNote: 'What she sent: ask her for a photo in chat, here or on the phone.', galleryEmpty: 'Nothing yet.',
    needAt: 'It needs a time.', needTitle: 'It needs a title.', failed: 'Didn’t work: ', main: 'Main', settingsNote: 'The same as her tray menu and her right-click menu.',
  },
};
const lang = new URLSearchParams(location.search).get('lang') || 'en';
const t = T[lang] || T.en;
const host = window.host;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, cls, onClick) {
  const b = el('button', `panel__action ${cls || ''}`.trim(), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

// ---------------------------------------------------------------- tabs

const TABS = ['chats', 'plans', 'gallery', 'settings'];
const tabsEl = document.querySelector('.hud__tabs');
const shown = { plans: false, gallery: false, settings: false };
let tab = 'chats';

function select(name) {
  tab = name;
  for (const b of tabsEl.children) b.classList.toggle('is-current', b.dataset.tab === name);
  for (const plate of document.querySelectorAll('.hud__plate')) plate.hidden = plate.dataset.tab !== name;
  document.querySelector('.hud__title').textContent = t.tabs[name];
  document.querySelector('.hud__new').hidden = name !== 'chats';
  document.querySelector('.hud__count').hidden = name !== 'chats';
  if (name === 'plans') loadPlans();
  if (name === 'gallery') loadGallery();
  if (name === 'settings') loadMenu();
  shown[name] = true;
}

for (const name of TABS) {
  const b = el('button', 'hud__tab', t.tabs[name]);
  b.type = 'button';
  b.dataset.tab = name;
  b.addEventListener('click', () => select(name));
  tabsEl.append(b);
}
addEventListener('keydown', (e) => {
  if (e.ctrlKey && /^[1234]$/.test(e.key)) select(TABS[Number(e.key) - 1]);
});

// ---------------------------------------------------------------- plans

const plansEl = document.querySelector('.plans__list');
const form = document.querySelector('.plans__form');
const kindEl = form.querySelector('.plans__kind');
const titleEl = form.querySelector('.plans__title');
const atEl = form.querySelector('.plans__at');
const endEl = form.querySelector('.plans__end');
const notesEl = form.querySelector('.plans__notes');
const errEl = document.querySelector('.plans__error');
const viewsEl = document.querySelector('.plans__views');
let view = 'soon';
const sent = new Set(); // meetings sent on to Proton this time

for (const [kind, label] of Object.entries(t.kinds)) kindEl.append(Object.assign(el('option', '', label), { value: kind }));
titleEl.placeholder = t.title;
notesEl.placeholder = t.notes;
form.querySelector('.plans__at-label').textContent = t.at;
form.querySelector('.plans__end-label').textContent = t.end;
form.querySelector('.plans__add').textContent = t.add;

function fitForm() {
  const kind = kindEl.value;
  form.querySelector('.plans__when').hidden = kind === 'note';
  form.querySelector('.plans__until').hidden = kind !== 'event';
}
kindEl.addEventListener('change', fitForm);
fitForm();

for (const [name, label] of Object.entries(t.views)) {
  const b = el('button', 'plans__view', label);
  b.type = 'button';
  b.addEventListener('click', () => {
    view = name;
    loadPlans();
  });
  b.dataset.view = name;
  viewsEl.append(b);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errEl.hidden = true;
  const kind = kindEl.value;
  const title = titleEl.value.trim();
  const at = fromInput(atEl.value);
  if (!title) return fail(t.needTitle);
  if ((kind === 'event' || kind === 'reminder') && !at) return fail(t.needAt);
  const input = { kind, title, notes: notesEl.value.trim() };
  if (kind === 'event') Object.assign(input, { start: at, end: fromInput(endEl.value) });
  if (kind === 'task' && at) input.due = at;
  if (kind === 'reminder') input.at = at;
  try {
    await host.createPlan(input);
    titleEl.value = '';
    notesEl.value = '';
    loadPlans();
  } catch (err) {
    fail(t.failed + String(err.message || err).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''));
  }
});

function fail(text) {
  errEl.textContent = text;
  errEl.hidden = false;
}

function dayLabel(day) {
  if (day === null) return t.undated;
  const today = new Date().setHours(0, 0, 0, 0);
  if (day === today) return t.today;
  if (day === today + 86400000) return t.tomorrow;
  return new Date(day).toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long' });
}

function planRow(p) {
  const row = el('li', `plan plan--${p.kind}${p.status === 'done' ? ' is-done' : ''}`);
  const dated = p.kind !== 'note' && !(p.kind === 'task' && p.due == null);
  const hm = (at) => new Date(at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  row.append(el('span', 'plan__time', dated ? `${hm(when(p))}${p.end ? `–${hm(p.end)}` : ''}` : ''));
  row.append(el('span', 'plan__kind', t.kinds[p.kind] || p.kind));
  const body = el('span', 'plan__body');
  body.append(el('span', 'plan__title', p.title));
  if (p.notes) body.append(el('span', 'plan__notes', p.notes));
  row.append(body);
  const actions = el('span', 'plan__actions');
  if (p.status === 'done') actions.append(el('span', 'plan__state', t.isDone));
  else if (p.kind === 'task' || p.kind === 'reminder') {
    actions.append(button(t.done, '', async () => {
      await host.completePlan(p.id);
      loadPlans();
    }));
  }
  if (p.kind === 'event' && p.status === 'open') {
    actions.append(sent.has(p.id) ? el('span', 'plan__state', t.sent) : button(t.proton, 'is-primary', () => {
      // to her chat, as if you said it: Claude or Codex opens Proton and fills it, you press Create
      host.chatsSend(protonPhrase(p, lang));
      sent.add(p.id);
      select('chats');
    }));
  }
  if (p.kind === 'note' && p.obsidian) actions.append(button(t.obsidian, '', () => host.openPlanNote(p.id)));
  row.append(actions);
  return row;
}

async function loadPlans() {
  for (const b of viewsEl.children) b.classList.toggle('is-current', b.dataset.view === view);
  let plans = [];
  try {
    plans = await host.listPlans({});
  } catch (err) {
    fail(t.failed + err.message);
  }
  plansEl.replaceChildren();
  const list = pick(plans, view);
  if (!list.length) plansEl.append(el('li', 'plans__empty', t.empty));
  for (const { day, plans: of } of byDay(list)) {
    plansEl.append(el('li', 'plans__day', dayLabel(day)));
    for (const p of of) plansEl.append(planRow(p));
  }
}

host.onPlansChanged(() => {
  if (tab === 'plans') loadPlans();
});

// ---------------------------------------------------------------- gallery: what she sent (main.js photoTask)

const gridEl = document.querySelector('.gallery__grid');
const bigEl = document.querySelector('.gallery__big');
document.querySelector('.gallery__note').textContent = t.galleryNote;
bigEl.addEventListener('click', () => { bigEl.hidden = true; });

async function loadGallery() {
  const list = await host.galleryList().catch(() => []);
  gridEl.replaceChildren();
  if (!list.length) gridEl.append(el('li', 'plans__empty', t.galleryEmpty));
  for (const p of list) {
    const item = el('li', 'gallery__item');
    const img = el('img');
    img.src = `capri://gallery/${p.name}`;
    img.loading = 'lazy';
    img.alt = p.said;
    item.title = p.said;
    item.append(img);
    item.addEventListener('click', () => {
      bigEl.querySelector('img').src = img.src;
      bigEl.querySelector('figcaption').textContent = p.said;
      bigEl.hidden = false;
    });
    gridEl.append(item);
  }
}

host.onGalleryChanged(() => {
  if (tab === 'gallery') loadGallery();
});

// ---------------------------------------------------------------- settings: her tray menu, by section

const settingsEl = document.querySelector('.settings');

// a row for one item: a toggle, a choice, a button, or a line to read
function itemRow(item) {
  if (item.type === 'separator') return null;
  if (item.items) return section(item.label, item.items, true);
  const click = () => host.hubClick(item.id);
  if (!item.enabled) return el('p', 'setting setting--info', item.label);
  if (item.type === 'checkbox') {
    const b = button(`${item.checked ? '■' : '□'} ${item.label}`, `setting setting--toggle${item.checked ? ' is-on' : ''}`, click);
    b.setAttribute('aria-pressed', String(Boolean(item.checked)));
    return b;
  }
  if (item.type === 'radio') {
    const b = button(item.label, `setting setting--choice${item.checked ? ' is-on' : ''}`, click);
    b.setAttribute('aria-pressed', String(Boolean(item.checked)));
    return b;
  }
  return button(item.label, 'setting setting--action', click);
}

function section(title, items, nested = false) {
  const box = el(nested ? 'div' : 'section', nested ? 'settings__sub' : 'settings__card');
  box.append(el(nested ? 'h3' : 'h2', 'settings__head', title));
  let group = null; // radios side by side
  for (const item of items) {
    const row = itemRow(item);
    if (!row) {
      group = null;
      continue;
    }
    if (item.type === 'radio') {
      if (!group) box.append(group = el('div', 'settings__choices'));
      group.append(row);
    } else {
      group = null;
      box.append(row);
    }
  }
  return box;
}

async function loadMenu() {
  const menu = await host.hubMenu();
  const scroll = settingsEl.scrollTop;
  settingsEl.replaceChildren(el('p', 'settings__note', t.settingsNote));
  // what isn't in a submenu, in one card up top; each submenu, a card of its own
  const loose = menu.filter((i) => !i.items && i.type !== 'separator');
  const grid = el('div', 'settings__grid');
  if (loose.length) grid.append(section(t.main, loose));
  for (const item of menu.filter((i) => i.items)) grid.append(section(item.label, item.items));
  settingsEl.append(grid);
  settingsEl.scrollTop = scroll;
}

// her window style (her menu: Night City, Classic, Arasaka × Nothing), the same as on the overlay
async function applyTheme() {
  const { theme } = await host.getConfig();
  document.documentElement.dataset.theme = theme || 'nightcity';
}

host.onHubMenu(() => {
  applyTheme(); // the menu is rebuilt on every change of hers, a new style included
  if (tab === 'settings') loadMenu();
});
applyTheme();

select(new URLSearchParams(location.search).get('tab') || 'chats');
