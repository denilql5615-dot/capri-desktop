import { appendHubText } from './hub-links.js';
import { openStylesLibrary } from './styles-library.js';
import { mountQuotaStrip } from './quota-view.js';
import { connectAgentActivity } from './agent-activity.js';
import {
  attachSlashMenu,
  openCatalogModal,
  registerCatalogTarget,
  bindQuickSkillToggles,
  isInstantSlashCommand,
  parseLeadingSlash,
  ensureSlashDock,
  showSlashCard,
  showSlashConfirm,
  normalizeSlashAction,
  extractContextPct,
  renderSlashStatePills,
} from './slash-menu.js';

const host = window.host;
const labels = { claude: 'Claude', codex: 'Codex', gemini: 'Antigravity', 'gemini-web': 'Web Gemini', gemma: 'Gemma', faun: 'RP' };
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
let agentSlashState = {};
const sessionContextPct = new Map();
let agentSlashMenu = null;
let agentQuickSkills = null;
const agentLogEl = document.querySelector('[data-tab="agents"] .log');
const agentComposeEl = $('compose');
const agentMetaEl = $('meta');
const agentSlashDock = ensureSlashDock(agentLogEl, agentComposeEl);
const quotaStrip = mountQuotaStrip(agentMetaEl);

function estimateAgentContextPct() {
  const id = current()?.id;
  if (id && sessionContextPct.has(id)) return sessionContextPct.get(id);
  const rows = historyId === id ? history : [];
  if (!rows.length) return 0;
  const chars = rows.reduce((acc, m) => acc + String(m.content || '').length, 0);
  const windowTokens = ['gemma', 'faun'].includes(agent) ? 32768 : 128000;
  return Math.min(100, Math.round((chars / 4 / windowTokens) * 100));
}

function lastAgentAssistantReply() {
  const id = current()?.id;
  const rows = historyId === id ? history : [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === 'assistant' && rows[i].content) return rows[i].content;
  }
  return '';
}

function applyAgentSlashState(nextState) {
  if (!nextState || typeof nextState !== 'object') return;
  agentSlashState = { ...agentSlashState, ...nextState };
  const hud = document.querySelector('.hud');
  if (hud && typeof agentSlashState.focus === 'boolean') {
    hud.classList.toggle('is-slash-focus', agentSlashState.focus);
  }
  renderSlashStatePills(agentMetaEl, agentSlashState);
}

function updateAgentSendButton() {
  const session = current();
  const id = session?.id;
  const busy = Boolean(session?.busy || submitting.has(id));
  const instantReady = busy && isInstantSlashCommand($('input').value);
  $('send').textContent = (busy && !instantReady) ? 'Стоп' : 'Отправить';
  $('send').classList.toggle('is-danger', Boolean(busy && !instantReady));
  $('send').disabled = !session;
}

function loadQuota() {
  const model = $('model').value;
  quotaStrip.select(agent, model);
  $('quota').hidden = agent !== 'gemini';
  $('quota-edit').hidden = agent !== 'gemini';
  const argon = /^gemini-4-argon/.test(model);
  $('quota-short-label').hidden = argon;
  $('quota-short').required = !argon;
}

const current = () => sessions.find((session) => session.id === selected.get(agent));
const attachActivity = connectAgentActivity(host, $('lines'), () => current()?.id);
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
  // Keep input enabled while busy so instant slash commands (/status, /usage, /stop, ...) run immediately.
  $('input').disabled = !session;
  if ($('attach')) {
    const att = attachments.get(id);
    $('attach').textContent = att ? `📎 ${att.name.slice(0, 18)}` : '📎';
    $('attach').disabled = !session || busy;
  }
  updateAgentSendButton();
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
    if (role === 'assistant' && content && content !== partial) {
      const exportsBar = document.createElement('div');
      exportsBar.className = 'agents__artifact';
      for (const [format, label] of [['pdf', '📄 В PDF'], ['docx', '📝 В DOCX'], ['obsidian', '📓 В Obsidian']]) {
        const btn = button(label, async () => {
          try {
            $('status').textContent = `Экспортирую в ${format.toUpperCase()}…`;
            const res = await host.agentsExportMessage({ id: session.id, text: content, format });
            $('status').textContent = res?.message || 'Готово.';
          } catch (err) {
            $('status').textContent = err.message;
          }
        });
        btn.removeAttribute('aria-pressed');
        exportsBar.append(btn);
      }
      item.append(exportsBar);
    }
    return item;
  }));
  attachActivity();
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

function getAgentSlashContext() {
  return {
    mode: 'agent',
    ephemeral: false,
    agent,
    sessionId: current()?.id || null,
    model: $('model')?.value || '',
    pct: estimateAgentContextPct(),
  };
}

async function runAgentCompact(sessionId, focus = '', preCompacted = null) {
  let res = preCompacted;
  if (!res && typeof host.agentsCompact === 'function') {
    $('status').textContent = 'Сжимаю контекст…';
    try {
      res = await host.agentsCompact({ id: sessionId, focus });
    } catch (err) {
      $('status').textContent = err.message || 'Не удалось сжать контекст.';
      return;
    }
  }
  if (!res || res.error) {
    $('status').textContent = res?.error || 'Сжатие контекста недоступно.';
    return;
  }
  const pct = extractContextPct(res.context);
  if (pct !== null) sessionContextPct.set(sessionId, pct);
  if (Array.isArray(res.history) && current()?.id === sessionId) {
    historyId = sessionId;
    history = res.history;
    renderLines();
  } else {
    await loadHistory();
  }
  const stats = Number.isFinite(res.droppedCount)
    ? `Сжато сообщений: ${res.droppedCount}, оставлено: ${res.keptCount ?? ''}`.trim()
    : 'Контекст обновлён';
  $('status').textContent = '';
  showSlashCard(agentSlashDock, {
    title: '/compact',
    meta: pct !== null ? `${stats} · ${pct}%` : stats,
    icon: 'compact',
    text: res.summary || 'Ранняя часть разговора свёрнута в конспект.',
    formatBody: (node, txt) => appendHubText(node, txt),
  });
  agentSlashMenu?.refresh();
}

async function sendAgentText(text, { retry = false } = {}) {
  const session = current();
  if (!session) return;
  const { id } = session;
  const att = attachments.get(id);
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

async function executeAgentSlashCommand(rawText, { confirm = false } = {}) {
  const parsed = parseLeadingSlash(rawText);
  if (!parsed) return false;
  const cmdName = parsed.cmd;
  const isInstant = isInstantSlashCommand(rawText);
  const session = current();
  const id = session?.id || null;
  const model = $('model')?.value || '';

  if (typeof host.commandsRun !== 'function') {
    if (cmdName === 'stop' && id) {
      await host.agentsStop(id).catch((err) => { $('status').textContent = err.message; });
      return true;
    }
    if (cmdName === 'new' || cmdName === 'clear') { await newChat(); return true; }
    if (cmdName === 'focus') { applyAgentSlashState({ focus: !agentSlashState.focus }); return true; }
    if (cmdName === 'copy') {
      const reply = lastAgentAssistantReply();
      if (reply) {
        host.chatsCopy?.(reply);
        $('status').textContent = 'Скопировано.';
      }
      return true;
    }
    if (cmdName === 'compact' && id) {
      await runAgentCompact(id, parsed.rest, null);
      return true;
    }
    if (cmdName === 'help' || cmdName === 'skills' || cmdName === 'plugins' || cmdName === 'plugin' || cmdName === 'hookify' || cmdName === 'connectors' || cmdName === 'connector' || cmdName === 'docker' || cmdName === 'tools' || cmdName === 'pc' || cmdName === 'инструменты' || cmdName === 'phone' || cmdName === 'телефон' || cmdName === 'xiaomi') {
      const targetTab = cmdName === 'skills'
        ? 'skills'
        : (['plugins', 'plugin', 'hookify'].includes(cmdName)
          ? 'plugins'
          : (['connectors', 'connector'].includes(cmdName)
            ? 'connectors'
            : (cmdName === 'docker'
              ? 'docker'
              : (['tools', 'pc', 'инструменты'].includes(cmdName)
                ? 'tools'
                : (['phone', 'телефон', 'xiaomi'].includes(cmdName) ? 'phone' : 'commands')))));
      openCatalogModal({
        initialTab: targetTab,
        focusPluginId: cmdName === 'hookify' ? 'hookify' : null,
        getContext: getAgentSlashContext,
        onRunCommand: handleAgentCatalogSelect,
        onSkillsChanged: handleAgentSkillsChanged,
        onPluginsChanged: handleAgentPluginsChanged,
        onConnectorsChanged: handleAgentConnectorsChanged,
      });
      return true;
    }
    return false;
  }

  const rows = historyId === id ? history.map((m) => ({ role: m.role, content: m.content })) : [];
  let result;
  try {
    result = await host.commandsRun({
      text: rawText,
      mode: 'agent',
      ephemeral: false,
      agent,
      sessionId: id,
      model,
      history: rows,
      confirm,
    });
  } catch (err) {
    $('status').textContent = err.message || 'Не удалось выполнить команду.';
    return true;
  }

  if (!result) return false;
  if (result.error) {
    $('status').textContent = result.error;
    return true;
  }

  if (result.state) applyAgentSlashState(result.state);
  const nextPct = extractContextPct(result.context);
  if (nextPct !== null && id) sessionContextPct.set(id, nextPct);

  if (result.confirmRequired) {
    showSlashConfirm(agentSlashDock, {
      text: result.reply || 'Удалить текущий разговор агента навсегда?',
      confirmLabel: 'Удалить',
      cancelLabel: 'Отмена',
      onConfirm: () => { executeAgentSlashCommand(rawText, { confirm: true }); },
      onCancel: () => { $('status').textContent = 'Удаление отменено.'; },
    });
    return true;
  }

  const act = normalizeSlashAction(result.action);
  const actType = act?.type || '';

  // /learn and /навык-файлы change the skills on disk: the slash menu re-reads them, the reply still shows.
  if (actType === 'skills-changed') window.dispatchEvent(new CustomEvent('capri:skills-changed', { detail: null }));

  if (actType === 'open-styles') {
    openStylesLibrary();
    return true;
  }

  if (actType === 'open-catalog') {
    openCatalogModal({
      initialTab: act.tab || result.tab || 'commands',
      focusPluginId: act.focusPlugin || act.pluginId || act.focusPluginId || result.focusPlugin || result.pluginId || null,
      focusConnectorId: act.focusConnector || act.connectorId || act.focusConnectorId || result.focusConnector || result.connectorId || null,
      getContext: getAgentSlashContext,
      onRunCommand: handleAgentCatalogSelect,
      onSkillsChanged: handleAgentSkillsChanged,
      onPluginsChanged: handleAgentPluginsChanged,
      onConnectorsChanged: handleAgentConnectorsChanged,
    });
    return true;
  }

  if (cmdName === 'docker' && !result.handled) {
    openCatalogModal({
      initialTab: 'docker',
      getContext: getAgentSlashContext,
      onRunCommand: handleAgentCatalogSelect,
      onSkillsChanged: handleAgentSkillsChanged,
      onPluginsChanged: handleAgentPluginsChanged,
      onConnectorsChanged: handleAgentConnectorsChanged,
    });
    return true;
  }

  if ((cmdName === 'tools' || cmdName === 'pc' || cmdName === 'инструменты') && !result.handled) {
    openCatalogModal({
      initialTab: 'tools',
      getContext: getAgentSlashContext,
      onRunCommand: handleAgentCatalogSelect,
      onSkillsChanged: handleAgentSkillsChanged,
      onPluginsChanged: handleAgentPluginsChanged,
      onConnectorsChanged: handleAgentConnectorsChanged,
    });
    return true;
  }

  if ((cmdName === 'phone' || cmdName === 'телефон' || cmdName === 'xiaomi') && !result.handled) {
    openCatalogModal({
      initialTab: 'phone',
      getContext: getAgentSlashContext,
      onRunCommand: handleAgentCatalogSelect,
      onSkillsChanged: handleAgentSkillsChanged,
      onPluginsChanged: handleAgentPluginsChanged,
      onConnectorsChanged: handleAgentConnectorsChanged,
    });
    return true;
  }

  if (actType === 'stop') {
    if (id) await host.agentsStop(id).catch((err) => { $('status').textContent = err.message; });
    if (result.reply) $('status').textContent = result.reply;
    return true;
  }

  if (actType === 'new' || actType === 'clear') {
    await newChat();
    if (result.reply) $('status').textContent = result.reply;
    return true;
  }

  if (actType === 'retry') {
    const busy = Boolean(session?.busy || submitting.has(id));
    if (!busy && id) await send(true);
    return true;
  }

  if (actType === 'copy') {
    const toCopy = act.text || lastAgentAssistantReply() || result.reply || '';
    if (toCopy) {
      host.chatsCopy?.(toCopy);
      $('status').textContent = result.reply || 'Скопировано.';
    } else {
      $('status').textContent = 'Нечего копировать.';
    }
    return true;
  }

  if ((actType === 'compact' || result.compacted) && id) {
    await runAgentCompact(id, act?.focus || parsed.rest, result.compacted || null);
    return true;
  }

  if (actType === 'focus') {
    const nextFocus = typeof act.value === 'boolean' ? act.value : (typeof result.state?.focus === 'boolean' ? result.state.focus : !agentSlashState.focus);
    applyAgentSlashState({ focus: nextFocus });
    if (result.reply) $('status').textContent = result.reply;
    return true;
  }

  if (['plan-mode', 'effort', 'temp', 'output-style', 'advisor', 'autocompact', 'pet'].includes(actType)) {
    if (result.reply) $('status').textContent = result.reply;
    agentSlashMenu?.refresh();
    return true;
  }

  if (actType === 'model') {
    const targetModel = act.model || act.value || '';
    if (targetModel) {
      const sel = $('model');
      const opt = Array.from(sel.options).find((o) =>
        o.value === targetModel || o.value.toLowerCase().includes(targetModel.toLowerCase()) ||
        o.textContent.toLowerCase().includes(targetModel.toLowerCase()));
      if (opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    if (result.reply) $('status').textContent = result.reply;
    agentSlashMenu?.refresh();
    return true;
  }

  if (['rename', 'pin', 'archive', 'delete', 'fork'].includes(actType)) {
    const targetId = act.sessionId || act.id;
    if (actType === 'fork' && targetId) selected.set(agent, targetId);
    if (actType === 'delete' && id === selected.get(agent)) selected.delete(agent);
    await loadAgentHub();
    if (result.reply) $('status').textContent = result.reply;
    return true;
  }

  if (actType === 'btw' || cmdName === 'btw') {
    showSlashCard(agentSlashDock, {
      title: '/btw',
      meta: 'В стороне · без записи в историю',
      icon: 'message',
      text: result.reply || 'Запрос в стороне выполнен.',
      formatBody: (node, txt) => appendHubText(node, txt),
    });
    return true;
  }

  if (result.promptRewrite) {
    const rewriteText = typeof result.promptRewrite === 'string'
      ? result.promptRewrite
      : (result.promptRewrite.text || result.promptRewrite.prompt || '');
    if (rewriteText) {
      const busy = Boolean(session?.busy || submitting.has(id));
      if (busy) {
        $('status').textContent = 'Агент ещё отвечает. Мгновенные команды работают сразу.';
        return true;
      }
      await sendAgentText(rewriteText);
      return true;
    }
  }

  if (result.handled) {
    if (result.reply) {
      if (isInstant || result.instant || result.reply.includes('\n') || result.reply.length > 100) {
        showSlashCard(agentSlashDock, {
          title: `/${cmdName}`,
          meta: nextPct !== null ? `Контекст: ${nextPct}%` : '',
          icon: cmdName,
          text: result.reply,
          formatBody: (node, txt) => appendHubText(node, txt),
        });
        $('status').textContent = '';
      } else {
        $('status').textContent = result.reply;
      }
    }
    if (cmdName === 'reload-skills') {
      agentSlashMenu?.refresh();
      agentQuickSkills?.sync();
    }
    return true;
  }

  return false;
}

function handleAgentCatalogSelect(it) {
  if (it?.kind === 'plugin') {
    openCatalogModal({
      initialTab: 'plugins',
      focusPluginId: it.id || it.name || null,
      getContext: getAgentSlashContext,
      onRunCommand: handleAgentCatalogSelect,
      onSkillsChanged: handleAgentSkillsChanged,
      onPluginsChanged: handleAgentPluginsChanged,
      onConnectorsChanged: handleAgentConnectorsChanged,
    });
    return;
  }
  const inputEl = $('input');
  const id = current()?.id;
  if (it?.kind === 'connector') {
    const mention = it.mention || `@${it.id || it.name}`;
    const prev = inputEl.value.trim();
    inputEl.value = prev ? `${prev} ${mention} ` : `${mention} `;
    if (id) drafts.set(id, inputEl.value);
    inputEl.focus();
    updateAgentSendButton();
    return;
  }
  const slash = it.slash || `/${it.name}`;
  const needsArgs = it.kind === 'skill' || it.kind === 'prompt' || (it.argsHint && String(it.argsHint).trim().startsWith('<'));
  if (needsArgs) {
    const prev = inputEl.value.trim();
    inputEl.value = prev ? `${slash} ${prev}` : `${slash} `;
    if (id) drafts.set(id, inputEl.value);
    inputEl.focus();
    updateAgentSendButton();
    return;
  }
  inputEl.value = '';
  if (id) drafts.delete(id);
  updateAgentSendButton();
  executeAgentSlashCommand(slash);
}

async function send(retry = false) {
  const session = current();
  if (!session) return;
  const { id, busy } = session;
  const isBusy = Boolean(busy || submitting.has(id));
  const rawInput = $('input').value.trim();

  // CRITICAL: Instant slash commands execute immediately without stopping or waiting for busy streams!
  if (!retry && rawInput && isInstantSlashCommand(rawInput)) {
    $('input').value = '';
    drafts.delete(id);
    agentSlashMenu?.close();
    updateAgentSendButton();
    await executeAgentSlashCommand(rawInput);
    return;
  }

  if (isBusy) {
    if (!rawInput) {
      await host.agentsStop(id).catch((err) => { $('status').textContent = err.message; });
      return;
    }
    $('status').textContent = 'Агент ещё отвечает. Мгновенные команды (/status, /usage, /stop) работают сразу.';
    return;
  }

  if (!retry && rawInput.startsWith('/')) {
    $('input').value = '';
    drafts.delete(id);
    agentSlashMenu?.close();
    updateAgentSendButton();
    const handled = await executeAgentSlashCommand(rawInput);
    if (handled) return;
  }

  const att = attachments.get(id);
  const text = rawInput || (att ? `Разбери файл ${att.name}` : '');
  if (!retry && !text) return;
  await sendAgentText(text, { retry });
}

function handleAgentSkillsChanged(data) {
  if (data) agentQuickSkills?.applyData(data);
  else agentQuickSkills?.sync();
  agentSlashMenu?.refresh();
}

function handleAgentPluginsChanged() {
  agentQuickSkills?.sync();
  agentSlashMenu?.refresh();
}

function handleAgentConnectorsChanged() {
  agentSlashMenu?.refresh();
}

agentSlashMenu = attachSlashMenu({
  input: $('input'),
  container: agentComposeEl,
  getContext: getAgentSlashContext,
  onSelectItem: (it, { runImmediately }) => {
    const id = current()?.id;
    if (id) drafts.set(id, $('input').value);
    updateAgentSendButton();
    if (runImmediately) {
      const cmdText = $('input').value.trim() || it.slash || `/${it.name}`;
      $('input').value = '';
      if (id) drafts.delete(id);
      updateAgentSendButton();
      executeAgentSlashCommand(cmdText);
    }
  },
  onOpenCatalog: (tabId, opts) => {
    openCatalogModal({
      initialTab: tabId,
      focusPluginId: opts?.focusPluginId || null,
      focusConnectorId: opts?.focusConnectorId || null,
      getContext: getAgentSlashContext,
      onRunCommand: handleAgentCatalogSelect,
      onSkillsChanged: handleAgentSkillsChanged,
      onPluginsChanged: handleAgentPluginsChanged,
      onConnectorsChanged: handleAgentConnectorsChanged,
    });
  },
});

registerCatalogTarget('agents', {
  getContext: getAgentSlashContext,
  onRunCommand: handleAgentCatalogSelect,
  onSkillsChanged: handleAgentSkillsChanged,
  onPluginsChanged: handleAgentPluginsChanged,
  onConnectorsChanged: handleAgentConnectorsChanged,
});

agentQuickSkills = bindQuickSkillToggles({
  root: document.querySelector('[data-popover="agents-plus"]'),
  triggerBtn: document.querySelector('[data-menu="agents-plus"]'),
  getContext: getAgentSlashContext,
  onChanged: () => {
    agentSlashMenu?.refresh();
  },
});

$('new').onclick = newChat;
$('providers').replaceChildren(...Object.entries(labels).map(([key, label]) => {
  const provider = button(label, () => { agent = key; $('quota-edit').open = false; render(); loadHistory(); loadQuota(); agentSlashMenu?.refresh(); }, key === agent);
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
  agentSlashMenu?.refresh();
};
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
$('input').oninput = () => {
  drafts.set(current()?.id, $('input').value);
  updateAgentSendButton();
};
$('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !agentSlashMenu?.isOpen()) {
    const val = $('input').value.trim();
    if (val.startsWith('/') && !val.includes('\n')) {
      event.preventDefault();
      send();
    }
  }
});
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
  ['📐 Excalidraw', '[Создай схему в формате Obsidian Excalidraw (NAME.excalidraw.md)]: '],
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
function attachBrowserFile(file) {
  const id = current()?.id;
  if (!id || !file) return;
  if (file.size > 2 * 1024 * 1024) {
    $('status').textContent = 'Файл должен быть меньше 2 МБ.';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const result = String(reader.result || '');
    const comma = result.indexOf(',');
    if (comma < 0) return;
    const ext = (file.type === 'image/png' ? '.png' : file.type === 'image/jpeg' ? '.jpg' : '');
    const name = file.name && file.name !== 'image.png' ? file.name : `clipboard-${Date.now()}${ext || '.png'}`;
    attachments.set(id, { name, data: result.slice(comma + 1) });
    render();
    $('input').focus();
  };
  reader.readAsDataURL(file);
}

const agentsPlate = document.querySelector('.hud__plate[data-tab="agents"]');
if (agentsPlate) {
  agentsPlate.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
  agentsPlate.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      e.preventDefault();
      attachBrowserFile(file);
    }
  });
}
$('input').addEventListener('paste', (e) => {
  const file = e.clipboardData?.files?.[0];
  if (file) {
    e.preventDefault();
    attachBrowserFile(file);
  }
});

if ($('mic')) $('mic').onclick = toggleVoiceRecording;
if ($('free-vram')) {
  $('free-vram').onclick = async () => {
    try {
      $('status').textContent = 'Выгружаю модели из VRAM…';
      const msg = await host.agentsFreeVram();
      $('status').textContent = msg || 'VRAM очищена.';
    } catch (err) {
      $('status').textContent = err.message;
    }
  };
}
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
