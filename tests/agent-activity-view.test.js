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

test('the timeline updates one row per step and ignores an earlier turn', async (t) => {
  const { connectAgentActivity } = await import('../src/renderer/js/agent-activity.js');
  global.document = { createElement: () => new Element() };
  t.after(() => { delete global.document; });
  const list = new Element();
  let emit;
  connectAgentActivity({ onAgentActivity: (listener) => { emit = listener; } }, list, () => 'chat');
  const send = (runId, event) => emit({ id: 'chat', runId, event });
  send('old', { kind: 'turn', state: 'running' });
  send('current', { kind: 'turn', state: 'running' });
  send('old', { id: 'late', kind: 'tool', state: 'done' });
  send('current', { id: 'command', kind: 'command', state: 'running' });
  send('current', { id: 'command', kind: 'command', state: 'done' });
  send('current', { id: 'think', kind: 'thinking', state: 'running' });
  send('current', { kind: 'turn', state: 'stopped' });
  assert.equal(list.children.length, 1);
  const [summary, steps] = list.children[0].children[0].children;
  assert.equal(summary.children[0].textContent, 'Остановлено');
  assert.deepEqual(steps.children.map((row) => row.children.map((cell) => cell.textContent)), [
    ['Команда', 'Готово'], ['Обработка запроса', 'Остановлено'],
  ]);
});
