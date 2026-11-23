// The action feed of a turn (2.9 part 3), in the chat right under the question, in place of «Думаю…».
// Gemini's rhythm: the last three steps, older ones fading, the whole chain on a tap of the head line
// (kept open across updates). Codex's details: a step opens its safe command and output. Claude's
// history: errors are red, and the last chain of each chat survives a reopen (localStorage, never the
// model's context). Logos: brand-logos.js.
import { brandSvg } from './brand-logos.js';
import { quotaBrand } from './quota-scale.js';

const phases = {
  memory: 'Подбираю контекст из памяти', tools: 'Готовлю инструменты', connectors: 'Подключаю коннекторы',
  attachments: 'Разбираю вложения', generation: 'Пишу ответ', responseReady: 'Проверяю готовность ответа',
};
const tools = { Read: 'Прочитано', Grep: 'Поиск по файлам', Glob: 'Поиск файлов', WebSearch: 'Google Search', WebFetch: 'Чтение страницы', TodoWrite: 'План задачи' };
const KINDS = new Set(['thinking', 'message', 'command', 'tool', 'file', 'skill', 'connector', 'search', 'worker']);
const states = { running: 'Думаю…', done: 'Готово', failed: 'Ошибка', stopped: 'Остановлено' };
const STORE = 'altai.activity.v1';

export function stepLabel(step) {
  const first = (s) => String(s || '').split('\n')[0].slice(0, 90);
  switch (step.kind) {
    case 'phase': return phases[step.name] || `Этап ${step.name}`;
    case 'thinking': return 'Обрабатываю запрос';
    case 'message': return step.text || '';
    case 'command': return `Выполнено ${first(step.detail?.command) || step.name || 'команда'}`;
    case 'file': return `Изменено ${(step.files || []).join(', ')}`;
    case 'skill': return `Навык: ${step.name}`;
    case 'connector': return `Коннектор: ${step.name}`;
    case 'search': return [tools[step.name] || step.name, step.detail?.input].filter(Boolean).join(' · ');
    case 'tool': return step.files?.length ? `${tools[step.name] || step.name} ${step.files.join(', ')}` : tools[step.name] || `Инструмент: ${step.name}`;
    default: return step.name || '';
  }
}

function logoFor(step) {
  if (step.kind === 'search' && /websearch|google/i.test(step.name || '')) return brandSvg('google');
  return brandSvg(quotaBrand(step.source));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function turnRow(turn) {
  const row = el('li', 'agent-activity');
  const head = el('button', 'agent-activity__head');
  head.type = 'button';
  const status = el('span', 'agent-activity__status');
  status.setAttribute('role', 'status');
  const chevron = el('span', 'agent-activity__chevron');
  head.append(status, chevron);
  head.onclick = () => { turn.expanded = !turn.expanded; render(turn); };
  const list = el('ol', 'agent-activity__list');
  row.append(head, list);
  return { row, head, status, chevron, list };
}

function render(turn) {
  const steps = [...turn.steps.values()];
  const running = [...steps].reverse().find((s) => s.state === 'running' && s.kind !== 'message');
  turn.status.textContent = turn.state === 'running' ? (running ? stepLabel(running) : states.running) : states[turn.state];
  turn.chevron.textContent = steps.length ? (turn.expanded ? '⌄' : '›') : '';
  turn.head.setAttribute('aria-expanded', String(Boolean(turn.expanded)));
  const shown = turn.expanded ? steps : steps.slice(-3);
  turn.list.replaceChildren(...shown.map((step, index) => {
    const item = el('li', `agent-activity__step is-${step.state}${step.kind === 'message' ? ' is-message' : ''}`);
    if (!turn.expanded) item.style && (item.style.opacity = String([1, 0.62, 0.38][shown.length - 1 - index] ?? 0.38));
    const logo = el('span', 'agent-activity__logo');
    const svg = logoFor(step);
    if (svg) logo.innerHTML = svg;
    const caption = el('span', 'agent-activity__caption', stepLabel(step));
    const state = el('span', 'agent-activity__status',
      step.state === 'running' && turn.state !== 'running' ? (turn.state === 'stopped' ? states.stopped : 'Без подтверждения') : (step.kind === 'message' ? '' : states[step.state]));
    item.append(logo, caption, state);
    const detail = step.detail && (step.detail.command || step.detail.output || step.detail.input);
    if (detail || step.error) {
      item.tabIndex = 0;
      item.onclick = () => {
        const open = item.querySelector?.('.agent-activity__detail');
        if (open) return open.remove();
        const box = el('pre', 'agent-activity__detail');
        box.textContent = [step.detail?.command && `$ ${step.detail.command}`, step.detail?.input, step.detail?.output, step.error && `Ошибка: ${step.error}`]
          .filter(Boolean).join('\n\n');
        item.append(box);
      };
    }
    return item;
  }));
}

function load() {
  try { return JSON.parse(globalThis.localStorage?.getItem(STORE) || '{}'); } catch { return {}; }
}

function save(id, turn) {
  try {
    const all = load();
    all[id] = { at: Date.now(), state: turn.state, steps: [...turn.steps.values()].slice(-60).map(({ detail, ...rest }) => ({ ...rest, ...(detail && { detail: {
      ...(detail.command && { command: String(detail.command).slice(0, 300) }), ...(detail.input && { input: String(detail.input).slice(0, 200) }),
    } }) })) };
    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
    for (const key of keys.slice(40)) delete all[key];
    globalThis.localStorage?.setItem(STORE, JSON.stringify(all));
  } catch { /* a full or blocked storage only loses the history marker */ }
}

export function connectAgentActivity(host, lines, currentId, subscribe = host.onAgentActivity) {
  const turns = new Map();
  const attach = () => {
    const id = currentId();
    let turn = turns.get(id);
    if (!turn && id) {
      const kept = load()[id];
      if (kept?.steps?.length) {
        turn = { runId: null, state: kept.state || 'done', expanded: false, steps: new Map(kept.steps.map((s) => [s.id, s])) };
        Object.assign(turn, turnRow(turn));
        turns.set(id, turn);
        render(turn);
      }
    }
    if (turn?.row && turn.row.parentNode !== lines) lines.append(turn.row);
  };
  subscribe(({ id, runId, agent, event }) => {
    let turn = turns.get(id);
    if (event.kind === 'turn' && event.state === 'running' && turn?.runId !== runId) {
      turn?.row.remove();
      turns.delete(id);
      turn = { runId, state: 'running', expanded: false, steps: new Map() };
      Object.assign(turn, turnRow(turn));
      turns.set(id, turn);
      if (turns.size > 24) turns.delete(turns.keys().next().value);
    }
    if (!turn || turn.runId !== runId) return;
    if (event.kind === 'turn') {
      turn.state = event.state;
      if (event.state !== 'running') save(id, turn);
    } else if (KINDS.has(event.kind) || (event.kind === 'phase' && Object.hasOwn(phases, event.name))) {
      const prev = turn.steps.get(event.id);
      turn.steps.set(event.id, { ...prev, ...event, source: event.source || agent || prev?.source, detail: event.detail || prev?.detail });
      if (turn.steps.size > 80) {
        const oldestFinished = [...turn.steps].find(([, step]) => step.state !== 'running');
        turn.steps.delete(oldestFinished?.[0] ?? turn.steps.keys().next().value);
      }
    }
    render(turn);
    if (id === currentId()) attach();
  });
  return attach;
}
