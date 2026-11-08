import { appendHubText } from './hub-links.js';

const host = window.host;
const labels = { claude: 'Claude', codex: 'Codex', gemini: 'Antigravity', gemma: 'Gemma', faun: 'Faun RP' };
const $ = (name) => document.querySelector(`.agents__${name}`);
const drafts = new Map();
const attachments = new Map();
const searches = new Map();
const selected = new Map();
const picked = new Map();
const streams = new Map();
const status = new Map();
const submitting = new Set();
let agent = 'claude';
let sessions = [];
let models = {};
let revision = 0;
let historyId;
let history = [];
let historyRevision = 0;
let quotaRevision = 0;
const quotaLabels = { claude: 'Claude', codex: 'Codex', 'agy-argon': 'Argon', 'agy-gemini': 'Gemini Flash / Pro', 'agy-third-party': 'Claude / GPT в Antigravity' };

async function loadQuota(refresh = false) {
  const ticket = ++quotaRevision;
  const model = $('model').value;
  const quota = $('quota');
  quota.hidden = !['claude', 'codex', 'gemini'].includes(agent);
  if (quota.hidden || !models[agent]?.length) return;
  $('quota-group').textContent = '';
  $('quota-values').textContent = 'Проверка квоты…';
  $('quota-refresh').hidden = !['codex', 'gemini'].includes(agent);
  $('quota-edit').hidden = agent !== 'gemini';
  const argon = /^gemini-4-argon/.test(model);
  $('quota-short-label').hidden = argon;
  $('quota-short').required = !argon;
  try {
    const result = await host.agentsQuota({ agent, model, refresh });
    if (ticket !== quotaRevision) return;
    if (!result) throw new Error('Нет данных');
    $('quota-group').textContent = quotaLabels[result.group];
    const windows = result.windows.filter((window) => !window.resetsAt || window.resetsAt * 1000 > Date.now());
    const values = windows.map((window) => {
      const period = window.minutes === 300 ? '5 ч' : window.minutes === 10080 ? 'неделя' : `${window.minutes} мин`;
      const left = new Intl.NumberFormat('ru', { maximumFractionDigits: 2 }).format(window.remaining);
      const reset = window.resetsAt ? ` · сброс ${new Date(window.resetsAt * 1000).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
      return `${window.scope ? window.scope + ' · ' : ''}${period}: ${left}%${reset}`;
    });
    if (result.checkedAt && (agent === 'gemini' || Date.now() - result.checkedAt > 120000)) {
      const tag = result.stale ? 'устарело' : 'снимок';
      values.push(`${tag} ${new Date(result.checkedAt).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
    }
    $('quota-values').textContent = windows.length ? values.join('  /  ') : agent === 'claude'
      ? 'Клиент пока не сообщил остаток' : 'Нет актуальных данных';
  } catch {
    if (ticket === quotaRevision) $('quota-values').textContent = 'Нет актуальных данных';
  }
}

const current = () => sessions.find((session) => session.id === selected.get(agent));
const title = (session) => session.title || 'Новый разговор';

function button(text, action, current = false) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = `panel__action${current ? ' is-primary' : ''}`;
  node.textContent = text;
  node.setAttribute('aria-pressed', String(current));
  node.onclick = action;
  return node;
}

function render() {
  const session = current();
  const id = session?.id;
  const busy = session?.busy || submitting.has(id);
  const visible = sessions.filter((item) => item.agent === agent);
  for (const provider of $('providers').children) {
    const active = provider.dataset.agent === agent;
    provider.classList.toggle('is-primary', active);
    provider.setAttribute('aria-pressed', String(active));
  }
  const search = searches.get(agent) || '';
  $('search').value = search;
  $('count').textContent = visible.length;
  const shown = visible.filter((item) => title(item).toLowerCase().includes(search.trim().toLowerCase()));
  $('list').replaceChildren(...shown.map((item) => button(
    `${item.busy ? '● ' : ''}${title(item)}`,
    () => { selected.set(agent, item.id); render(); loadHistory(); loadQuota(); }, item.id === id)));
  if (!shown.length) {
    const empty = document.createElement('p');
    empty.className = 'agents__empty';
    empty.textContent = visible.length ? 'Ничего не найдено' : 'Пока нет разговоров';
    $('list').append(empty);
  }
  $('label').textContent = labels[agent];
  $('title').textContent = session ? title(session) : 'Разговоры с агентом';
  $('run').hidden = !busy;
  $('welcome').hidden = Boolean(session);
  $('lines').hidden = !session;
  $('compose').hidden = !session;
  const choices = models[agent] || [];
  $('model').replaceChildren(...choices.map(([key, label]) => new Option(label, key)));
  $('model').value = picked.get(id) ?? session?.model ?? choices[0]?.[0] ?? '';
  $('model').disabled = !session || busy;
  $('import').hidden = !['claude', 'codex', 'gemini'].includes(agent);
  $('local').hidden = !['claude', 'codex'].includes(agent);
  $('history-tools').hidden = $('import').hidden;
  $('input').value = drafts.get(id) || '';
  $('input').disabled = !session || busy;
  if ($('attach')) {
    const att = attachments.get(id);
    $('attach').textContent = att ? `📎 ${att.name.slice(0, 18)}` : '📎';
    $('attach').disabled = !session || busy;
  }
  $('send').textContent = busy ? 'Стоп' : 'Отправить';
  $('send').classList.toggle('is-danger', Boolean(busy));
  $('send').disabled = !session;
  $('retry').hidden = !session || busy || !session.canRetry;
  $('status').textContent = status.get(id) || '';
  renderLines();
}

function renderLines() {
  const session = current();
  const lines = $('lines');
  const rows = historyId === session?.id ? [...history] : [];
  const partial = streams.get(session?.id);
  if (partial) rows.push({ role: 'assistant', content: partial });
  lines.replaceChildren(...rows.map(({ role, content, model, artifacts }) => {
    const item = document.createElement('li');
    item.className = `line ${role === 'user' ? 'is-you' : 'is-her'}`;
    const name = document.createElement('span');
    name.className = 'line__name';
    name.textContent = role === 'user' ? 'Ты' : [labels[agent], model].filter(Boolean).join(' · ');
    const body = document.createElement('p');
    body.className = 'line__text';
    appendHubText(body, content);
    item.append(name, body);
    for (const artifact of artifacts || []) {
      const card = document.createElement('div');
      card.className = 'agents__artifact';
      const filename = document.createElement('strong');
      filename.textContent = artifact.name;
      card.append(filename);
      for (const [action, title] of [['open', 'Открыть'], ['obsidian', 'В Obsidian'], ['save', 'Сохранить копию'], ['copy', 'Копировать путь']]) {
        const control = button(title, async () => {
          try {
            await host.agentsArtifact({ id: session.id, ...artifact, action });
            if (action === 'copy') $('status').textContent = 'Путь скопирован.';
            if (action === 'obsidian') $('status').textContent = 'Сохранено в Obsidian (Результаты).';
          } catch (err) {
            $('status').textContent = err.message;
          }
        });
        control.removeAttribute('aria-pressed');
        card.append(control);
      }
      item.append(card);
    }
    return item;
  }));
  lines.scrollTop = lines.scrollHeight;
}

async function loadHistory() {
  const ticket = ++historyRevision;
  const id = current()?.id;
  try {
    const messages = id ? await host.agentsHistory(id) : [];
    if (ticket !== historyRevision || current()?.id !== id) return;
    historyId = id;
    history = messages;
    renderLines();
  } catch (err) {
    if (ticket === historyRevision) $('status').textContent = err.message;
  }
}

export async function loadAgentHub() {
  const ticket = ++revision;
  try {
    const data = await host.agentsList();
    if (ticket !== revision) return;
    ({ sessions, models } = data);
    for (const item of sessions) {
      if (!selected.has(item.agent)) selected.set(item.agent, item.id);
      if (!item.busy) streams.delete(item.id);
    }
    render();
    if (!document.querySelector('[data-tab="agents"].hud__plate').hidden) loadQuota();
    await loadHistory();
  } catch (err) {
    if (ticket === revision) $('status').textContent = err.message;
  }
}

async function newChat() {
  const target = agent;
  try {
    selected.set(target, await host.agentsCreate(target));
    await loadAgentHub();
    if (agent === target) $('input').focus();
  } catch (err) {
    $('status').textContent = err.message;
  }
}

async function send(retry = false) {
  const session = current();
  if (!session) return;
  const { id, busy } = session;
  if (busy || submitting.has(id)) {
    await host.agentsStop(id).catch((err) => { $('status').textContent = err.message; });
    return;
  }
  const att = attachments.get(id);
  const text = $('input').value.trim() || (att ? `Разбери файл ${att.name}` : '');
  if (!retry && !text) return;
  const model = $('model').value;
  const files = !retry && att ? [att] : undefined;
  submitting.add(id);
  status.delete(id);
  render();
  try {
    const result = await host.agentsSend({ id, model, text, retry, files });
    if (!retry) {
      drafts.delete(id);
      attachments.delete(id);
    }
    if (!result.ok) status.set(id, result.stopped ? 'Остановлено.' : result.error);
  } catch (err) {
    status.set(id, err.message);
  } finally {
    submitting.delete(id);
    await loadAgentHub();
  }
}

$('new').onclick = newChat;
$('providers').replaceChildren(...Object.entries(labels).map(([key, label]) => {
  const provider = button(label, () => { agent = key; $('quota-edit').open = false; render(); loadHistory(); loadQuota(); }, key === agent);
  provider.dataset.agent = key;
  return provider;
}));
$('search').oninput = () => { searches.set(agent, $('search').value); render(); };
async function importChats(local) {
  const target = agent;
  try {
    const result = await host.agentsImport(target, local);
    if (!result) return;
    if (result.ids.length) selected.set(target, result.ids[0]);
    await loadAgentHub();
    if (agent === target) $('status').textContent = `Добавлено чатов: ${result.ids.length}.${result.errors.length ? ` Пропущено файлов: ${result.errors.length}.` : ''}${result.limited ? ' Достигнут предел объёма импорта.' : ''}`;
  } catch (err) {
    $('status').textContent = err.message;
  }
}
$('import').onclick = () => importChats(false);
$('local').onclick = () => importChats(true);
$('model').onchange = () => {
  picked.set(current()?.id, $('model').value);
  $('quota-edit').open = false;
  loadQuota();
};
$('quota-refresh').onclick = () => loadQuota(true);
$('quota-form').onsubmit = async (event) => {
  event.preventDefault();
  const model = $('model').value;
  const week = $('quota-week').valueAsNumber;
  const values = /^gemini-4-argon/.test(model) ? [week] : [$('quota-short').valueAsNumber, week];
  try {
    await host.agentsQuotaSnapshot({ model, values });
    $('quota-edit').open = false;
    $('quota-form').reset();
    loadQuota();
  } catch (err) {
    $('status').textContent = err.message;
  }
};
$('input').oninput = () => drafts.set(current()?.id, $('input').value);
$('compose').onsubmit = (event) => { event.preventDefault(); send(); };
$('retry').onclick = () => send(true);

let mediaRecorder = null;
let recordingChunks = [];

async function toggleVoiceRecording() {
  const micBtn = $('mic');
  if (!micBtn) return;
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    micBtn.textContent = '🎤';
    micBtn.classList.remove('is-active');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordingChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recordingChunks, { type: 'audio/wav' });
      const arrayBuffer = await blob.arrayBuffer();
      try {
        micBtn.textContent = '· · ·';
        const recognized = await host.agentsVoiceStt(new Uint8Array(arrayBuffer));
        if (recognized) {
          const prev = $('input').value;
          $('input').value = prev ? `${prev} ${recognized}` : recognized;
          drafts.set(current()?.id, $('input').value);
          $('input').focus();
        }
      } catch (err) {
        console.warn('Voice STT error:', err);
      } finally {
        micBtn.textContent = '🎤';
      }
    };
    mediaRecorder.start();
    micBtn.textContent = '⏺';
    micBtn.classList.add('is-active');
  } catch (err) {
    console.warn('Microphone error:', err);
  }
}

const PRESETS = [
  ['📄 В PDF', '[Собери результат в готовый PDF-документ (NAME.pdf.md -> NAME.pdf)]: '],
  ['📝 В DOCX', '[Собери результат в готовый Word-документ (NAME.docx.md -> NAME.docx)]: '],
  ['📊 Схема PNG', '[Нарисуй чистую векторную схему в NAME.png.svg (сконвертируется в NAME.png)]: '],
  ['🎮 GDD / Баланс', '[Опирайся на референсы геймдизайна C:\\Capri_Tools\\game-studios-reference]: '],
  ['🚀 Питч / Store', '[Используй фреймворки C:\\Capri_Tools\\marketingskills и напиши без ИИ-штампов]: '],
];
if ($('presets')) {
  $('presets').replaceChildren(...PRESETS.map(([label, prefix]) => {
    const chip = button(label, () => {
      const id = current()?.id;
      if (!id) return;
      const cur = $('input').value;
      $('input').value = cur.includes(prefix.trim()) ? cur : `${prefix}${cur}`;
      drafts.set(id, $('input').value);
      $('input').focus();
    });
    chip.removeAttribute('aria-pressed');
    return chip;
  }));
}
if ($('mic')) $('mic').onclick = toggleVoiceRecording;
if ($('attach')) {
  $('attach').onclick = async () => {
    const id = current()?.id;
    if (!id) return;
    if (attachments.has(id)) {
      attachments.delete(id);
      render();
      return;
    }
    try {
      const pickedFile = await host.agentsPickFile();
      if (pickedFile) {
        attachments.set(id, pickedFile);
        render();
        $('input').focus();
      }
    } catch (err) {
      $('status').textContent = err.message;
    }
  };
}

host.onAgentsUpdate(({ id, delta }) => {
  if (typeof delta === 'string') {
    streams.set(id, (streams.get(id) || '') + delta);
    if (current()?.id === id) renderLines();
  } else {
    loadAgentHub();
  }
});
