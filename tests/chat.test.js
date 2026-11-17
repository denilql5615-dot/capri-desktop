'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function moduleUrl(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${moduleUrl(path.resolve(path.dirname(file), relative))}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

test('temporarily hiding chat does not abort a running task; explicit close does', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  const { Chat } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/chat.js')));
  const stopped = [];
  const make = () => Object.assign(Object.create(Chat.prototype), {
    open: true,
    turn: 42,
    host: { chatStop: (id) => stopped.push(id), focusOverlay() {} },
    capri: {},
  });

  make().close(false);
  assert.deepEqual(stopped, []);

  make().close();
  assert.deepEqual(stopped, [42]);
  delete globalThis.matchMedia;
});

test('an alert cannot replace chat while its task is running', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  const { Panel } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/panel.js')));
  const panel = Object.assign(Object.create(Panel.prototype), {
    current: { kind: 'chat', chat: {} },
    el: { hidden: false },
    suspended: false,
    leaving: false,
    chatBusy: true,
    missed: null,
  });

  assert.equal(panel.say({ kind: 'alert', line: 'permission' }), false);
  assert.equal(panel.current.kind, 'chat');
  assert.equal(panel.missed.kind, 'alert');
  delete globalThis.matchMedia;
});

test('natural Russian requests to inspect the screen are recognized', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  const { isLookRequest } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/chat.js')));
  for (const phrase of [
    'глянь на экран',
    'посмотри пожалуйста что у меня на мониторе',
    'что сейчас открыто на экране',
    'что ты видишь',
    'прочитай текст с экрана',
    'посмотри, что на экране.',
    'Глянь, пожалуйста, на экран!',
    "what's on my screen?",
  ]) assert.equal(isLookRequest(phrase), true, phrase);
  assert.equal(isLookRequest('открой настройки экрана'), false);
  delete globalThis.matchMedia;
});

test('Panel keeps streaming=true until streamStep completes with done and fires onStreamDone / onActionsChange', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: () => ({ type: '', className: '', dataset: {}, textContent: '', addEventListener() {} }),
  };
  try {
    const { Panel } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/panel.js')));
    const classes = new Set();
    const panel = Object.assign(Object.create(Panel.prototype), {
      current: { kind: 'chat', chat: {}, actions: [] },
      el: { hidden: false },
      quote: { textContent: '', hidden: true },
      verdict: { hidden: true },
      photo: { hidden: true },
      clip: { hidden: true },
      actions: { hidden: true, replaceChildren() {} },
      line: {
        textContent: '',
        scrollTop: 0,
        scrollHeight: 0,
        classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      },
      streamTo: [],
      streamDone: false,
      streamTimer: null,
      streamShown: 0,
      streamAt: [],
      streaming: false,
      decodeTimer: null,
      onStreamDone: null,
      onActionsChange: null,
      setFace() {},
      hideClip() {},
      glitchLine() {},
      place() {},
    });

    let streamDoneCalls = 0;
    let actionsCalls = 0;
    panel.onStreamDone = () => { streamDoneCalls++; };
    panel.onActionsChange = () => { actionsCalls++; };

    panel.chatTurn({ quote: 'hi', face: 'aside' });
    assert.equal(panel.streaming, true);

    panel.stream('Привет', { done: false });
    clearInterval(panel.streamTimer);
    panel.streamTimer = null;
    while (panel.streamShown < panel.streamTo.length) panel.streamStep();
    assert.equal(panel.streaming, true);
    assert.equal(streamDoneCalls, 0);

    panel.stream('Привет, мир!', { done: true });
    clearInterval(panel.streamTimer);
    panel.streamTimer = null;
    panel.streamStep();
    assert.equal(panel.streaming, true);
    assert.equal(streamDoneCalls, 0);
    while (panel.streaming) panel.streamStep();
    assert.equal(panel.streaming, false);
    assert.equal(streamDoneCalls, 1);
    assert.equal(panel.line.textContent, 'Привет, мир!');

    panel.setActions([{ id: 'site', label: 'Open' }]);
    assert.equal(panel.current.actions.length, 1);
    panel.setActions([]);
    assert.equal(panel.current.actions.length, 0);
    assert.equal(actionsCalls, 2);
  } finally {
    delete globalThis.matchMedia;
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
});

test('Chat.syncVerdict waits for stream completion, async after(), and empty actions; hides on new turn', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  try {
    const { Chat } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/chat.js')));
    const verdicts = [];
    let releaseAfter;
    const chat = Object.assign(Object.create(Chat.prototype), {
      open: true,
      turn: 0,
      routing: 0,
      agent: false,
      cold: false,
      warm: true,
      opening: null,
      answer: '',
      verdictPending: true,
      afterPending: false,
      afterToken: 0,
      history: [],
      apps: [],
      appsReady: Promise.resolve(),
      shortModel: '',
      brain: { t: { chat: { loading: '' } } },
      bond: null,
      capri: { pulse() {} },
      host: {
        chatLog() {},
        chatRoute: async () => null,
        chatSend: async () => {
          chat.verdictPending = true;
          chat.syncVerdict();
          return { ok: true, text: 'Готово.' };
        },
      },
      panel: {
        current: { chat: {}, actions: [] },
        streaming: true,
        setVerdict(on) { verdicts.push(on); },
        setChatBusy() {},
        setActions(a) { this.current.actions = a; this.onActionsChange?.(); },
        chatTurn() { this.streaming = true; },
        stream() { this.streaming = false; this.onStreamDone?.(); },
        setFace() {},
      },
      asked: () => null,
      persona: () => '',
      languageNote: () => '',
      remember() {},
      listApps() {},
      after: () => new Promise((resolve) => { releaseAfter = resolve; }),
    });
    chat.panel.onStreamDone = () => chat.syncVerdict();
    chat.panel.onActionsChange = () => chat.syncVerdict();

    // 1. Pending arrives while still streaming -> stays hidden until stream finishes
    chat.syncVerdict();
    assert.equal(verdicts.at(-1), false);
    chat.panel.streaming = false;
    chat.panel.onStreamDone();
    assert.equal(verdicts.at(-1), true);

    // 2. Non-empty actions hide verdict; clearing actions reveals it again
    chat.panel.setActions([{ id: 'open', label: 'Open' }]);
    assert.equal(verdicts.at(-1), false);
    chat.panel.setActions([]);
    assert.equal(verdicts.at(-1), true);

    // 3. send(): new turn hides immediately; even if stream finishes synchronously before async after(),
    // verdict stays hidden until after() settles and remains hidden when after() sets actions
    await chat.send('открой сайт');
    assert.equal(verdicts.at(-1), false); // afterPending === true blocks verdict even though panel.streaming === false
    chat.panel.setActions([{ id: 'site', label: 'example.com' }]);
    releaseAfter();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(verdicts.at(-1), false); // actions present -> still hidden
    chat.panel.setActions([]);
    assert.equal(verdicts.at(-1), true); // actions dismissed -> shown
  } finally {
    delete globalThis.matchMedia;
  }
});

