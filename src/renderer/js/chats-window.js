// Her Chats window (chats.html): your conversations with her (main.js keeps them in chats.json), the
// list on the left, the one picked on the right, a search over both, and a line to talk to her. What
// you type goes to her chat on the overlay (chat.js): the same brain, Claude and Codex named, her looks,
// her questions before an action on your PC (answered here with buttons). What was said is put in as
// text, never as markup: it can hold anything, a page's text she read out included.

import { appendHubText } from './hub-links.js';

const T = {
  ru: {
    title: 'Чаты', search: 'Поиск по чатам…', empty: 'Пока пусто: напиши ей внизу.', none: 'Ничего не нашлось.',
    you: 'Ты', her: 'Capri', messages: (n) => `${n} сообщ.`, today: 'Сегодня', yesterday: 'Вчера',
    newChat: 'Новый чат', live: 'Сейчас', placeholder: 'Напиши ей…', send: 'Отправить', stop: 'Стоп', mic: 'Голос',
    copy: 'Копировать', copied: 'Скопировано', del: 'Удалить', delSure: 'Удалить навсегда?',
    resumeNote: 'Это старый чат: она его не помнит.', resume: 'Продолжить этот чат',
    newNote: 'Новый чат: она начнёт с чистого листа.', yes: 'Да', hour: 'На час', no: 'Нет', typing: 'печатает…',
    busy: 'Она ещё отвечает: подожди или нажми «Стоп».', closed: 'Не получилось открыть её чат: она занята чем-то важным. Попробуй ещё раз.',
  },
  en: {
    title: 'Chats', search: 'Search chats…', empty: 'Nothing yet: write to her below.', none: 'Nothing found.',
    you: 'You', her: 'Capri', messages: (n) => `${n} msg`, today: 'Today', yesterday: 'Yesterday',
    newChat: 'New chat', live: 'Now', placeholder: 'Write to her…', send: 'Send', stop: 'Stop', mic: 'Voice',
    copy: 'Copy', copied: 'Copied', del: 'Delete', delSure: 'Delete for good?',
    resumeNote: 'An old chat: she doesn’t remember it.', resume: 'Continue this chat',
    newNote: 'A new chat: she starts with a clean slate.', yes: 'Yes', hour: 'For an hour', no: 'No', typing: 'typing…',
    busy: 'She’s still answering: wait, or press Stop.', closed: 'Couldn’t open her chat: she’s busy with something important. Try again.',
  },
};
const lang = new URLSearchParams(location.search).get('lang') || 'en';
const t = T[lang] || T.en;
document.documentElement.lang = lang;

const host = window.host;
const $ = (sel) => document.querySelector(sel);
const listEl = $('.chats__list');
const linesEl = $('.log__lines');
const emptyEl = $('.chats__empty');
const search = $('.chats__search');
const input = $('.log__input');
const sendBtn = $('.log__send');
const delBtn = $('.log__delete');
const hintEl = $('.log__hint');

$('.hud__title').textContent = t.title;
$('.hud__new').textContent = t.newChat;
search.placeholder = t.search;
input.placeholder = t.placeholder;
$('.log__mic').textContent = t.mic;
$('.log__live').textContent = t.live;
$('.log__resume-note').textContent = t.resumeNote;
$('.log__resume-go').textContent = t.resume;

let chats = [];
let live = null;      // the chat your next message goes into (null: a new one)
let current = null;   // the one shown: a chat's id, or null for "new chat"
let following = true; // showing the live chat: a new message there keeps it shown
let busy = false;     // she's answering
let streamed = '';    // her answer as it comes
let asking = null;    // her question before an action on your PC: { line, grantable }
let sure = false;     // delete clicked once

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

function button(label, cls, onClick) {
  const b = el('button', `panel__action ${cls || ''}`.trim(), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
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
    const item = el('li', `chats__item${chat.id === current ? ' is-current' : ''}${chat.id === live ? ' is-live' : ''}`);
    const when = el('div', 'chats__when');
    when.append(el('span', '', `${day(chat.started)} · ${time(chat.started)}`), el('span', 'chats__n', t.messages(chat.count)));
    const title = el('div', 'chats__title');
    title.append(marked(chat.title, q));
    item.append(when, title);
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-pressed', String(chat.id === current));
    item.addEventListener('click', () => show(chat.id));
    item.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      show(chat.id);
    });
    return item;
  }));
  emptyEl.hidden = shown.length > 0;
  emptyEl.textContent = chats.length ? t.none : t.empty;
  $('.hud__count').textContent = chats.length ? String(chats.length) : '';
}

function line(role, content, at, q) {
  const item = el('li', `line ${role === 'user' ? 'is-you' : 'is-her'}`);
  const who = el('div', 'line__who');
  who.append(el('span', 'line__name', role === 'user' ? t.you : t.her), el('span', 'line__at', at ? time(at) : t.typing));
  if (at) {
    const copy = button(t.copy, 'line__copy', () => {
      host.chatsCopy(content);
      copy.textContent = t.copied;
      setTimeout(() => { copy.textContent = t.copy; }, 1200);
    });
    who.append(copy);
  }
  // a picture she sent ("скинь фото"): its mark becomes the picture under her words
  const photos = [...content.matchAll(PHOTO_MARK)].map((m) => m[1]);
  const text = el('p', 'line__text');
  appendHubText(text, content.replace(PHOTO_MARK, '').trim(), (part) => marked(part, q));
  item.append(who, text);
  for (const name of photos) {
    const clip = /\.webm$/i.test(name); // a clip she sent ("скинь видео"): looped, silent
    const img = el(clip ? 'video' : 'img', 'line__photo');
    img.src = `capri://gallery/${name}`;
    if (clip) Object.assign(img, { muted: true, loop: true, autoplay: true, playsInline: true });
    else img.alt = '';
    item.append(img);
  }
  return item;
}

const PHOTO_MARK = /\[\[photo:(\d{8}-\d{6}-[0-9a-f]{4}\.(?:png|webm))\]\]/g;

function renderLog({ keepScroll = false } = {}) {
  const chat = chats.find((c) => c.id === current);
  const q = query();
  const atBottom = linesEl.scrollHeight - linesEl.scrollTop - linesEl.clientHeight < 40;
  $('.log__when').replaceChildren(...(chat
    ? [el('b', '', day(chat.started)), ` · ${time(chat.started)} – ${time(chat.updated)} · ${t.messages(chat.count)}`]
    : [t.newNote]));
  $('.log__live').hidden = !chat || chat.id !== live;
  delBtn.hidden = !chat;
  sure = false;
  delBtn.textContent = t.del;
  delBtn.classList.remove('is-danger');
  // an old chat: your message would go elsewhere, so it asks to continue this one first
  $('.log__resume').hidden = !chat || chat.id === live;
  const lines = (chat?.messages || []).map((m) => line(m.role, m.content, m.at, q));
  // her answer coming, under the live chat (or the new one)
  if (busy && streamed && (current === live || (!current && !live))) lines.push(line('assistant', streamed, null, ''));
  linesEl.replaceChildren(...lines);
  if (q) linesEl.querySelector('mark')?.scrollIntoView({ block: 'center' });
  else if (!keepScroll || atBottom) linesEl.scrollTop = linesEl.scrollHeight;
}

function renderControls() {
  input.disabled = busy;
  sendBtn.textContent = busy ? t.stop : t.send;
  sendBtn.classList.toggle('is-danger', busy);
  $('.log__ask').hidden = !asking;
  if (asking) {
    $('.log__ask-line').textContent = `${asking.line}?`;
    $('.log__ask-actions').replaceChildren(
      button(t.yes, 'is-primary', () => host.chatsAnswer('yes')),
      ...(asking.grantable ? [button(t.hour, '', () => host.chatsAnswer('hour'))] : []),
      button(t.no, '', () => host.chatsAnswer('no')),
    );
  }
}

function hint(text) {
  hintEl.hidden = !text;
  hintEl.textContent = text || '';
}

function show(id) {
  current = id;
  following = id === live;
  renderList();
  renderLog();
  input.focus();
}

async function load() {
  const res = await host.chatsList().catch(() => ({ chats: [], current: null }));
  chats = res.chats;
  const was = live;
  live = res.current;
  // following the live chat (or a new one that just began): stay on it
  if (following || (current === null && was === null)) current = live;
  if (current && !chats.some((c) => c.id === current)) {
    current = live;
    following = true;
  }
  renderList();
  renderLog({ keepScroll: true });
}

$('.log__compose').addEventListener('submit', (e) => {
  e.preventDefault();
  if (busy) return host.chatsStop();
  const text = input.value.trim();
  if (!text) return;
  // on an old chat: your message goes to the live one (or a new one): shown there
  input.value = '';
  hint(null);
  current = live;
  following = true;
  streamed = '';
  host.chatsSend(text);
});
$('.log__mic').addEventListener('click', () => host.chatsListen());
$('.log__resume-go').addEventListener('click', () => {
  if (!current) return;
  following = true;
  host.chatsResume(current);
});
$('.hud__new').addEventListener('click', () => {
  current = null;
  following = true;
  host.chatsNew();
  renderList();
  renderLog();
  input.focus();
});
delBtn.addEventListener('click', () => {
  if (!current) return;
  if (!sure) {
    sure = true;
    delBtn.textContent = t.delSure;
    delBtn.classList.add('is-danger');
    return;
  }
  host.chatsDelete(current);
  current = null;
  following = true;
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') host.closeChats();
});
search.addEventListener('input', () => {
  renderList();
  renderLog();
});

host.onChatsChanged(() => load());
host.onChatsDelta((piece) => {
  streamed += piece;
  if (current === live || current === null) renderLog({ keepScroll: true });
});
host.onChatsState((state) => {
  const was = busy;
  busy = Boolean(state?.busy);
  asking = state?.asking || null;
  if (state?.refused) hint(state.refused === 'busy' ? t.busy : t.closed);
  if (was && !busy) streamed = '';
  renderControls();
  renderLog({ keepScroll: true });
});

renderControls();
load();
input.focus();
