'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

class Element {
  children = [];
  parentNode = null;
  textContent = '';
  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  setAttribute() {}
}

test('the feed updates one row per step, ignores an earlier turn, shows the last three, opens the whole chain', async (t) => {
  const { connectAgentActivity } = await import('../src/renderer/js/agent-activity.js');
  global.document = { createElement: () => new Element() };
  t.after(() => { delete global.document; });
  const list = new Element();
  let emit;
  connectAgentActivity({ onAgentActivity: (listener) => { emit = listener; } }, list, () => 'chat');
  const send = (runId, event) => emit({ id: 'chat', runId, agent: 'codex', event });
  send('old', { kind: 'turn', state: 'running' });
  send('current', { kind: 'turn', state: 'running' });
  send('old', { id: 'late', kind: 'tool', state: 'done' });
  send('current', { id: 'm', kind: 'message', text: 'Смотрю тесты.', state: 'done' });
  send('current', { id: 'command', kind: 'command', name: 'git', state: 'running', detail: { command: 'git status' } });
  send('current', { id: 'command', kind: 'command', name: 'git', state: 'failed' });
  send('current', { id: 'skill', kind: 'skill', name: 'wiki-query', state: 'done' });
  send('current', { id: 'think', kind: 'thinking', state: 'running' });
  send('current', { kind: 'turn', state: 'stopped' });
  assert.equal(list.children.length, 1);
  const [head, steps] = list.children[0].children;
  assert.equal(head.children[0].textContent, 'Остановлено');
  const rows = () => steps.children.map((row) => [row.className, row.children[1].textContent, row.children[2].textContent]);
  assert.deepEqual(rows(), [
    ['agent-activity__step is-failed', 'Выполнено git status', 'Ошибка'],
    ['agent-activity__step is-done', 'Навык: wiki-query', 'Готово'],
    ['agent-activity__step is-running', 'Обрабатываю запрос', 'Остановлено'],
  ]);
  head.onclick();
  assert.equal(steps.children.length, 4);
  assert.equal(rows()[0][1], 'Смотрю тесты.');
});

test('step.icon, step.label, awaiting state, and expanded detail with target/exitCode render safely', async (t) => {
  const { connectAgentActivity } = await import('../src/renderer/js/agent-activity.js');
  global.document = { createElement: () => new Element() };
  t.after(() => { delete global.document; });
  const list = new Element();
  let emit;
  connectAgentActivity({ onAgentActivity: (listener) => { emit = listener; } }, list, () => 'chat');
  emit({ id: 'chat', runId: 'r1', agent: 'local', event: { kind: 'turn', state: 'running' } });
  emit({
    id: 'chat',
    runId: 'r1',
    agent: 'local',
    event: {
      id: 't1',
      kind: 'command',
      name: 'terminal_run',
      icon: 'terminal',
      label: 'Терминал',
      state: 'awaiting',
      detail: { command: 'rm -rf temp', target: 'D:\\Capri\\temp', exitCode: 1, output: 'denied' },
    },
  });
  const [head, steps] = list.children[0].children;
  assert.equal(head.children[0].textContent, 'Терминал · Ждёт подтверждения');
  const row = steps.children[0];
  assert.ok(row.children[0].innerHTML.includes('<svg'));
  assert.equal(row.children[1].textContent, 'Терминал');
  assert.equal(row.children[2].textContent, 'Ждёт подтверждения');
  row.onclick();
  const detailBox = row.children[3];
  assert.ok(detailBox.textContent.includes('$ rm -rf temp'));
  assert.ok(detailBox.textContent.includes('→ D:\\Capri\\temp'));
  assert.ok(detailBox.textContent.includes('exit 1'));
  assert.ok(detailBox.textContent.includes('denied'));
});