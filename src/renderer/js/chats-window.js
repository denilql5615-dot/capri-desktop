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
    researchPrompt: 'Введите тему исследования…', researching: 'Облачные агенты исследуют тему…',
    stopping: 'Останавливаю исследование…', stopped: 'Исследование остановлено.',
    chatMode: 'Чат', privateMode: 'Приват', taskMode: 'Задача', temporary: 'Временный чат', localWorking: 'Локальная модель отвечает…',
    localStopping: 'Останавливаю ответ…', localStopped: 'Ответ остановлен.',
    webTool: 'Поиск в сети', pimTool: 'Почта и календарь', checking: 'Запрашиваю данные…',
  },
  en: {
    title: 'Chats', search: 'Search chats…', empty: 'Nothing yet: write to her below.', none: 'Nothing found.',
    you: 'You', her: 'Capri', messages: (n) => `${n} msg`, today: 'Today', yesterday: 'Yesterday',
    newChat: 'New chat', live: 'Now', placeholder: 'Write to her…', send: 'Send', stop: 'Stop', mic: 'Voice',
    copy: 'Copy', copied: 'Copied', del: 'Delete', delSure: 'Delete for good?',
    resumeNote: 'An old chat: she doesn’t remember it.', resume: 'Continue this chat',
    newNote: 'A new chat: she starts with a clean slate.', yes: 'Yes', hour: 'For an hour', no: 'No', typing: 'typing…',
    busy: 'She’s still answering: wait, or press Stop.', closed: 'Couldn’t open her chat: she’s busy with something important. Try again.',
    researchPrompt: 'Enter a research topic…', researching: 'Cloud agents are researching…',
    stopping: 'Stopping research…', stopped: 'Research stopped.',
    chatMode: 'Chat', privateMode: 'Private', taskMode: 'Task', temporary: 'Temporary chat', localWorking: 'Local model is answering…',
    localStopping: 'Stopping reply…', localStopped: 'Reply stopped.',
    webTool: 'Web search', pimTool: 'Mail and calendar', checking: 'Fetching results…',
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
let chatMode = 'capri';
let temporary = false;
let toolBusy = false;
let toolStopping = false;
const drafts = new Map();
const toolTurns = new Map();
const modeItems = document.querySelectorAll('[data-chat-mode]:not([data-chat-mode="agents"])');
const temporaryItem = $('[data-plus-action="temporary"]');
const imageItem = $('[data-plus-action="images"]');
const connectedItems = document.querySelectorAll('[data-plus-action="search"], [data-plus-action="pim"]');
const imageInput = $('.log__images');
const imageList = $('.log__image-list');
let attachedImages = [];
let imageSelection = 0;
const toolKey = () => temporary ? `${chatMode}-temporary` : chatMode;
const usesTool = () => chatMode !== 'capri' || temporary;
const readOnlyTool = () => chatMode === 'search' || chatMode === 'pim';
const connectedTool = () => chatMode === 'research' || readOnlyTool();
const modeLabels = {
  capri: t.chatMode, private: t.privateMode, task: t.taskMode, nsfw: '18+',
  research: 'Deep Research', search: t.webTool, pim: t.pimTool,
};
const modeLabel = () => modeLabels[chatMode];
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

function line(role, content, at, q, isolated = false) {
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
  if (isolated) text.append(marked(content, q));
  else appendHubText(text, content.replace(PHOTO_MARK, '').trim(), (part) => marked(part, q));
  item.append(who, text);
  for (const name of isolated ? [] : photos) {
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
  const separate = usesTool();
  const chat = separate ? null : chats.find((c) => c.id === current);
  const q = query();
  const atBottom = linesEl.scrollHeight - linesEl.scrollTop - linesEl.clientHeight < 40;
  $('.log__when').replaceChildren(...(chat
    ? [el('b', '', day(chat.started)), ` · ${time(chat.started)} – ${time(chat.updated)} · ${t.messages(chat.count)}`]
    : [separate ? [modeLabel(), temporary ? t.temporary : ''].filter(Boolean).join(' · ') : t.newNote]));
  $('.log__live').hidden = !chat || chat.id !== live;
  delBtn.hidden = !chat;
  sure = false;
  delBtn.textContent = t.del;
  delBtn.classList.remove('is-danger');
  // an old chat: your message would go elsewhere, so it asks to continue this one first
  $('.log__resume').hidden = !chat || chat.id === live;
  const turn = toolTurns.get(toolKey());
  const messages = separate ? [turn?.question, turn?.answer].filter(Boolean) : chat?.messages || [];
  const plainText = separate && !['research', 'search'].includes(chatMode);
  const lines = messages.map((m) => line(m.role, m.content, m.at, q, plainText));
  // her answer coming, under the live chat (or the new one)
  if (!separate && busy && streamed && (current === live || (!current && !live))) lines.push(line('assistant', streamed, null, ''));
  const isEmpty = lines.length === 0;
  const logMain = linesEl.closest('.log');
  if (logMain) logMain.classList.toggle('is-empty', isEmpty);
  const welcomeEl = $('.log__welcome');
  if (welcomeEl) welcomeEl.hidden = separate || !isEmpty;
  linesEl.replaceChildren(...lines);
  if (q) linesEl.querySelector('mark')?.scrollIntoView({ block: 'center' });
  else if (!keepScroll || atBottom) linesEl.scrollTop = linesEl.scrollHeight;
}

function renderControls() {
  const separate = usesTool();
  const active = separate ? toolBusy : busy;
  input.disabled = active;
  input.placeholder = chatMode === 'research' ? t.researchPrompt : t.placeholder;
  sendBtn.textContent = active ? (readOnlyTool() ? t.checking : t.stop) : t.send;
  sendBtn.disabled = separate && (toolStopping || (readOnlyTool() && active));
  sendBtn.classList.toggle('is-danger', active && !readOnlyTool());
  $('.log__mic').disabled = separate;
  $('.log__ask').hidden = separate || !asking;
  for (const mode of modeItems) {
    const selected = mode.dataset.chatMode === chatMode;
    mode.classList.toggle('is-selected', selected);
    mode.setAttribute('aria-checked', String(selected));
    mode.disabled = toolBusy || (temporary && mode.dataset.chatMode === 'research');
  }
  temporaryItem.disabled = toolBusy || connectedTool();
  imageItem.disabled = toolBusy || connectedTool();
  for (const item of connectedItems) item.disabled = toolBusy || temporary || chatMode === 'private';
  imageList.hidden = !attachedImages.length;
  imageList.disabled = toolBusy;
  imageList.textContent = attachedImages.map(({ name }) => name).join(', ') + ' ×';
  imageList.title = lang === 'ru' ? 'Убрать изображения' : 'Remove images';
  temporaryItem.classList.toggle('is-selected', temporary);
  temporaryItem.setAttribute('aria-checked', String(temporary));
  $('[data-menu="chats-models"] .gem-model-btn__label').textContent =
    temporary && chatMode === 'capri' ? t.temporary : modeLabel();
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
  if (toolBusy) return;
  setChatMode('capri', false);
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

function setChatMode(mode, nextTemporary) {
  if (toolBusy || (['research', 'search', 'pim'].includes(mode) && nextTemporary) ||
      (mode === chatMode && nextTemporary === temporary)) return;
  if (usesTool() && chatMode !== 'research') toolTurns.delete(toolKey());
  else drafts.set(toolKey(), input.value);
  attachedImages = [];
  imageSelection++;
  chatMode = mode;
  temporary = nextTemporary;
  input.value = drafts.get(toolKey()) || '';
  hint(null);
  renderControls();
  renderLog();
  input.focus();
}

for (const mode of modeItems) {
  mode.addEventListener('click', () => setChatMode(mode.dataset.chatMode, temporary));
}
temporaryItem.addEventListener('click', () => setChatMode(chatMode, !temporary));
for (const item of connectedItems) item.addEventListener('click', () => setChatMode(item.dataset.plusAction, false));
imageItem.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', async () => {
  const files = Array.from(imageInput.files);
  imageInput.value = '';
  if (!files.length || toolBusy || connectedTool()) return;
  if (files.length > 4 || files.some((file) =>
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024)) {
    hint(lang === 'ru' ? 'Выбери до четырёх PNG, JPEG или WebP, каждый до 4 МБ.' : 'Select up to four PNG, JPEG or WebP files of up to 4 MB each.');
    return;
  }
  setChatMode(chatMode, true);
  const selection = ++imageSelection;
  try {
    const images = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(',')[1] });
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    })));
    if (selection !== imageSelection || toolBusy) return;
    attachedImages = images;
    hint(null);
    renderControls();
    input.focus();
  } catch {
    if (selection === imageSelection) hint(lang === 'ru' ? 'Не удалось прочитать изображения.' : 'Could not read images.');
  }
});
imageList.addEventListener('click', () => {
  attachedImages = [];
  imageSelection++;
  renderControls();
});

$('.log__compose').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (usesTool()) {
    const research = chatMode === 'research';
    if (toolBusy) {
      if (toolStopping || readOnlyTool()) return;
      toolStopping = true;
      hint(research ? t.stopping : t.localStopping);
      renderControls();
      host.chatsStopTool();
      return;
    }
    const text = input.value.trim();
    if (!text && !attachedImages.length) return;
    const images = attachedImages.map(({ data }) => data);
    const content = [text, attachedImages.map(({ name }) => name).join(', ')].filter(Boolean).join('\n');
    attachedImages = [];
    imageSelection++;
    input.value = '';
    const turn = { question: { role: 'user', content, at: Date.now() } };
    toolTurns.set(toolKey(), turn);
    toolBusy = true;
    hint(research ? t.researching : readOnlyTool() ? t.checking : t.localWorking);
    renderControls();
    renderLog();
    try {
      const result = await host.chatsRunTool({ text, mode: chatMode, ephemeral: temporary, images });
      if (result.stopped) hint(research ? t.stopped : t.localStopped);
      else {
        turn.answer = { role: 'assistant', content: result.reply, at: Date.now() };
        hint(null);
      }
    } catch (err) {
      hint(err.message);
    } finally {
      toolBusy = false;
      toolStopping = false;
      renderControls();
      renderLog();
      input.focus();
    }
    return;
  }
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
  if (toolBusy) return;
  if (usesTool() && chatMode !== 'research') {
    toolTurns.delete(toolKey());
    attachedImages = [];
    imageSelection++;
    input.value = '';
    hint(null);
    renderControls();
    renderLog();
    input.focus();
    return;
  }
  setChatMode('capri', false);
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
  if (!usesTool() && state?.refused) hint(state.refused === 'busy' ? t.busy : t.closed);
  if (was && !busy) streamed = '';
  renderControls();
  renderLog({ keepScroll: true });
});

renderControls();
load();
input.focus();
