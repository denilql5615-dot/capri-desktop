const stepNames = { thinking: 'Обработка запроса', command: 'Команда', tool: 'Инструмент', file: 'Изменение файлов' };
const states = { running: 'В работе', done: 'Готово', failed: 'Ошибка', stopped: 'Остановлено' };

function turnRow() {
  const row = document.createElement('li');
  row.className = 'agent-activity';
  const details = document.createElement('details');
  details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = 'Ход задачи';
  const status = document.createElement('span');
  status.className = 'agent-activity__status';
  status.setAttribute('role', 'status');
  summary.append(status);
  const list = document.createElement('ol');
  details.append(summary, list);
  row.append(details);
  return { row, status, list };
}

function render(turn) {
  turn.status.textContent = states[turn.state];
  const nodes = [...turn.steps.values()].map((step) => {
    const item = document.createElement('li');
    const caption = document.createElement('span');
    caption.textContent = [stepNames[step.kind], step.name, step.files?.join(', ')].filter(Boolean).join(' · ');
    const status = document.createElement('span');
    status.className = 'agent-activity__status';
    status.textContent = step.state === 'running' && turn.state !== 'running'
      ? (turn.state === 'stopped' ? states.stopped : 'Без подтверждения')
      : states[step.state];
    item.append(caption, status);
    return item;
  });
  turn.list.replaceChildren(...nodes);
}

export function connectAgentActivity(host, lines, currentId) {
  const turns = new Map();
  const attach = () => {
    const row = turns.get(currentId())?.row;
    if (row && row.parentNode !== lines) lines.append(row);
  };
  host.onAgentActivity(({ id, runId, event }) => {
    let turn = turns.get(id);
    if (event.kind === 'turn' && event.state === 'running') {
      turn?.row.remove();
      turns.delete(id);
      turn = { ...turnRow(), runId, state: 'running', steps: new Map() };
      turns.set(id, turn);
      if (turns.size > 24) turns.delete(turns.keys().next().value);
    }
    if (!turn || turn.runId !== runId) return;
    if (event.kind === 'turn') {
      turn.state = event.state;
    } else if (Object.hasOwn(stepNames, event.kind)) {
      turn.steps.set(event.id, event);
      if (turn.steps.size > 20) turn.steps.delete(turn.steps.keys().next().value);
    }
    render(turn);
    if (id === currentId()) attach();
  });
  return attach;
}
