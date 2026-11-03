// Her Chats window (chats.html): your conversations with her (main.js keeps them in chats.json), the
// list on the left, the one picked on the right, a search over both. Read only. What was said is
// put in as text, never as markup: it can hold anything, a page's text she read out included.

const T = {
  ru: {
    title: 'Чаты', search: 'Поиск по чатам…', empty: 'Пока пусто: поговори с ней (правый клик › Поговорить с ней).',
    none: 'Ничего не нашлось.', you: 'Ты', her: 'Capri', messages: (n) => `${n} сообщ.`, today: 'Сегодня', yesterday: 'Вчера',
  },
  en: {
    title: 'Chats', search: 'Search chats…', empty: 'Nothing yet: talk to her (right-click › Talk to her).',
    none: 'Nothing found.', you: 'You', her: 'Capri', messages: (n) => `${n} msg`, today: 'Today', yesterday: 'Yesterday',
  },
};
const lang = new URLSearchParams(location.search).get('lang') || 'en';
const t = T[lang] || T.en;
document.documentElement.lang = lang;

const $ = (sel) => document.querySelector(sel);
const listEl = $('.chats__list');
const linesEl = $('.log__lines');
const metaEl = $('.log__meta');
const emptyEl = $('.chats__empty');
const search = $('.chats__search');

$('.hud__title').textContent = t.title;
search.placeholder = t.search;
$('.hud__close').addEventListener('click', () => window.host.closeChats());
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.host.closeChats();
});

let chats = [];
let current = null;

const time = (at) => new Date(at).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
function day(at) {
  const d = new Date(at);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return t.today;
  if (days === 1) return t.yesterday;
  return d.toLocaleDateString(lang, { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) });
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// the words searched for, marked in a line of text (built from text nodes, never innerHTML)
function marked(text, query) {
  const frag = document.createDocumentFragment();
  if (!query) {
    frag.append(text);
    return frag;
  }
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(query); at !== -1; at = lower.indexOf(query, from)) {
    frag.append(text.slice(from, at), el('mark', '', text.slice(at, at + query.length)));
    from = at + query.length;
  }
  frag.append(text.slice(from));
  return frag;
}

const query = () => search.value.trim().toLowerCase();
const matches = (chat, q) => !q || chat.messages.some((m) => m.content.toLowerCase().includes(q));

function renderList() {
  const q = query();
  const shown = chats.filter((chat) => matches(chat, q));
  listEl.replaceChildren(...shown.map((chat) => {
    const item = el('li', `chats__item${chat.id === current ? ' is-current' : ''}`);
    const when = el('div', 'chats__when');
    when.append(el('span', '', `${day(chat.started)} · ${time(chat.started)}`), el('span', 'chats__n', t.messages(chat.count)));
    const title = el('div', 'chats__title');
    title.append(marked(chat.title, q));
    item.append(when, title);
    item.addEventListener('click', () => pick(chat.id));
    return item;
  }));
  emptyEl.hidden = shown.length > 0;
  emptyEl.textContent = chats.length ? t.none : t.empty;
  $('.hud__count').textContent = chats.length ? String(chats.length) : '';
  if (!shown.some((chat) => chat.id === current)) pick(shown[0]?.id ?? null, { list: false });
}

function renderLog({ keepScroll = false } = {}) {
  const chat = chats.find((c) => c.id === current);
  const q = query();
  const atBottom = linesEl.scrollHeight - linesEl.scrollTop - linesEl.clientHeight < 40;
  if (!chat) {
    metaEl.replaceChildren();
    linesEl.replaceChildren();
    return;
  }
  const meta = el('span');
  meta.append(el('b', '', day(chat.started)), ` · ${time(chat.started)} – ${time(chat.updated)} · ${t.messages(chat.count)}`);
  metaEl.replaceChildren(meta);
  linesEl.replaceChildren(...chat.messages.map((m) => {
    const line = el('li', `line ${m.role === 'user' ? 'is-you' : 'is-her'}`);
    const who = el('div', 'line__who');
    who.append(el('span', 'line__name', m.role === 'user' ? t.you : t.her), el('span', 'line__at', time(m.at)));
    const text = el('p', 'line__text');
    text.append(marked(m.content, q));
    line.append(who, text);
    return line;
  }));
  if (q) linesEl.querySelector('mark')?.scrollIntoView({ block: 'center' });
  else if (!keepScroll || atBottom) linesEl.scrollTop = linesEl.scrollHeight;
}

function pick(id, { list = true } = {}) {
  const changed = id !== current;
  current = id;
  if (list) renderList();
  if (changed || !list) renderLog();
}

async function load() {
  chats = await window.host.chatsList().catch(() => []);
  renderList();
  renderLog({ keepScroll: true });
}

search.addEventListener('input', () => {
  renderList();
  renderLog();
});
window.host.onChatsChanged(() => load());
load();
