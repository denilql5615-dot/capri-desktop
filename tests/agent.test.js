'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decide, grantable, Grant, GRANT_MS } = require('../src/main/policy');
const desktop = require('../src/main/desktop');
const { runTask, isComputerTask } = require('../src/main/agent');

test('policy: floors, the phone, the hour', () => {
  assert.strictEqual(decide('READ_ONLY'), 'allow');
  assert.strictEqual(decide('UI_CONTROL'), 'confirm');
  assert.strictEqual(decide('DELETE', { wanted: 'allow' }), 'confirm');
  assert.strictEqual(decide('READ_ONLY', { ask: 'a warning' }), 'confirm');
  assert.strictEqual(decide('UI_CONTROL', { origin: 'phone' }), 'deny');
  assert.strictEqual(decide('NOPE'), 'deny');
  assert.strictEqual(grantable('UI_CONTROL'), true);
  assert.strictEqual(grantable('UI_CONTROL', 'closing'), false);
  assert.strictEqual(grantable('DELETE'), false);
  const g = new Grant();
  assert.strictEqual(g.covers('UI_CONTROL', undefined, 0), false);
  g.grant(0);
  assert.strictEqual(g.covers('UI_CONTROL', undefined, GRANT_MS - 1), true);
  assert.strictEqual(g.covers('DELETE', undefined, 1), false);
  assert.strictEqual(g.covers('UI_CONTROL', undefined, GRANT_MS), false);
});

test('desktop: validation, argv that model text can\'t turn into flags, risk', () => {
  assert.strictEqual(desktop.validate({ cmd: 'rm' }).ok, false);
  assert.strictEqual(desktop.validate({ cmd: 'click' }).ok, false);
  assert.strictEqual(desktop.validate({ cmd: 'click', ref: '--force' }).ok, false);
  const t = desktop.validate({ cmd: 'type', ref: '@abc:e1', text: '--help' });
  assert.deepStrictEqual(desktop.argv(t.args), ['--headed', 'type', '--', '@abc:e1', '--help']);
  const refs = new Map([['@abc:e1', { role: 'button', name: 'Удалить' }], ['@abc:e2', { role: 'edit', name: 'Пароль' }], ['@abc:e3', { role: 'button', name: 'OK' }], ['@abc:e4', { role: 'button', name: 'Создать' }]]);
  assert.deepStrictEqual(desktop.classify({ cmd: 'snapshot' }, refs), { cls: 'READ_ONLY' });
  assert.strictEqual(desktop.classify({ cmd: 'click', ref: '@abc:e1' }, refs).cls, 'DELETE');
  assert.strictEqual(desktop.classify({ cmd: 'type', ref: '@abc:e2', text: 'x' }, refs).cls, 'CREDENTIAL_ACCESS');
  assert.deepStrictEqual(desktop.classify({ cmd: 'click', ref: '@abc:e3' }, refs), { cls: 'UI_CONTROL' });
  assert.ok(desktop.classify({ cmd: 'click', ref: '@abc:e4' }, refs).ask);
  assert.ok(desktop.classify({ cmd: 'click', ref: '@abc:e9' }, refs).ask); // never seen: asked
  assert.strictEqual(desktop.classify({ cmd: 'launch', app: 'C:\\x\\setup.exe' }, refs).cls, 'TERMINAL_EXEC');
});

test('isComputerTask: said plainly, not any mention of a computer', () => {
  assert.strictEqual(isComputerTask('на компьютере открой блокнот'), true);
  assert.strictEqual(isComputerTask('нажми кнопку ОК'), true);
  assert.strictEqual(isComputerTask('Открой блокнот, напиши там привет, как дела'), true);
  assert.strictEqual(isComputerTask('запусти калькулятор и посчитай 2+2'), true);
  assert.strictEqual(isComputerTask('напиши в блокнот список покупок'), true);
  // Danyal's exact words, 2026-11-03: went to chat and opened Proton Mail instead
  assert.strictEqual(isComputerTask('открой протон-календарь и заполни тестовую встречу завтра в 15.00.'), true);
  assert.strictEqual(isComputerTask('Открой Proton Calendar и создай встречу'), true);
  assert.strictEqual(isComputerTask('назначь встречу в Proton Calendar'), true);
  assert.strictEqual(isComputerTask('заполни встречу в календаре'), true);
  assert.strictEqual(isComputerTask('в календаре создай встречу на пятницу'), true);
  assert.strictEqual(isComputerTask('открой Proton Calendar'), false); // just opening
  assert.strictEqual(isComputerTask('что у меня в календаре завтра?'), false);
  assert.strictEqual(isComputerTask('мой компьютер старый'), false);
  assert.strictEqual(isComputerTask('напиши мне стих про осень'), false);
  assert.strictEqual(isComputerTask('открой ютуб'), false); // just opening: her own [[open]]
  assert.strictEqual(isComputerTask('привет'), false);
});

// a model that looks, then clicks, then answers; the driver records what ran
function fake(calls) {
  let i = 0;
  const ran = [];
  return {
    ran,
    chat: async () => JSON.stringify(calls[i++] || { done: true, answer: 'Готово, чум.' }),
    driver: {
      refs: new Map(),
      exec: async (argv) => {
        ran.push(argv);
        return argv[0] === 'snapshot'
          ? { ok: true, data: { tree: { ref_id: '@s1:e1', role: 'button', name: 'OK' } } }
          : { ok: true, data: {} };
      },
    },
  };
}
const look = { done: false, cmd: 'snapshot', app: 'Notepad', ref: '' }; // empty fields, as a schema reply has them
const click = { done: false, cmd: 'click', ref: '@s1:e1' };

test('runTask: looks without asking, asks before a click, the hour skips the next ask', async () => {
  const f = fake([look, click, click]);
  const asked = [];
  const g = new Grant();
  const deps = {
    ...f, origin: 'pc',
    confirm: async (q) => { asked.push(q.line); return 'hour'; },
    covered: (cls, ask) => g.covers(cls, ask),
    grant: () => g.grant(),
  };
  const said = await runTask('на компьютере нажми OK', [], deps, new AbortController().signal);
  assert.strictEqual(said, 'Готово, чум.');
  assert.deepStrictEqual(asked, ['Нажать «OK» (button)']); // once: the second click rides the hour
  assert.deepStrictEqual(f.ran.map((a) => a[0]), ['snapshot', 'click', 'click']);
});

test('runTask: a no stops it, nothing runs', async () => {
  const f = fake([look, click]);
  const said = await runTask('нажми OK', [], { ...f, origin: 'pc', confirm: async () => 'no', covered: () => false, grant: () => {} }, new AbortController().signal);
  assert.match(said, /не трогаю/);
  assert.deepStrictEqual(f.ran.map((a) => a[0]), ['snapshot']);
});

test('runTask: from the phone a click is denied without asking', async () => {
  const f = fake([look, click]);
  let asked = false;
  await runTask('нажми OK', [], { ...f, origin: 'phone', confirm: async () => { asked = true; return 'yes'; }, covered: () => false, grant: () => {} }, new AbortController().signal);
  assert.strictEqual(asked, false);
  assert.deepStrictEqual(f.ran.map((a) => a[0]), ['snapshot']);
});

test('runTask: a made-up ref goes back to looking, without asking you; Блокнот is notepad', async () => {
  const f = fake([{ done: false, cmd: 'launch', app: 'Блокнот' }, { done: false, cmd: 'type', ref: '@zz:e5', text: 'hi' }, look, { done: false, cmd: 'type', ref: '@s1:e1', text: 'hi' }]);
  const asked = [];
  await runTask('на компьютере открой блокнот', [], { ...f, origin: 'pc', confirm: async (q) => { asked.push(q.line); return 'yes'; }, covered: () => false, grant: () => {} }, new AbortController().signal);
  assert.deepStrictEqual(f.ran.map((a) => a.slice(0, 2).join(' ')), ['launch --activate', 'snapshot -i', '--headed type']);
  assert.strictEqual(f.ran[0].at(-1), 'notepad');
  assert.deepStrictEqual(asked, ['Открыть notepad', 'Ввести «hi» в «OK» (button)']);
});
