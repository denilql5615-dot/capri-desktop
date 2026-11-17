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

test('Panel.hide() protects open chat without force and closes it with { force: true }', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  try {
    const { Panel } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/panel.js')));
    let leaves = 0;
    let talks = 0;
    let stops = 0;
    const classes = new Set();
    const panel = Object.assign(Object.create(Panel.prototype), {
      current: { kind: 'chat', chat: {}, onLeave: () => { leaves++; } },
      el: { hidden: false, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } },
      leaving: false,
      hideTimer: 0,
      decodeTimer: 0,
      missed: null,
      tickerAction: null,
      onTalk: () => { talks++; },
      stopStream: () => { stops++; },
    });

    // Background hide() is a complete no-op while non-guide chat is open
    panel.hide();
    assert.equal(panel.current?.kind, 'chat');
    assert.equal(panel.leaving, false);
    assert.equal(leaves, 0);
    assert.equal(stops, 0);
    assert.equal(talks, 0);

    // Explicit close with { force: true } tears down panel and fires onLeave
    panel.hide({ force: true });
    assert.equal(panel.current, null);
    assert.equal(panel.leaving, true);
    assert.equal(leaves, 1);
    assert.equal(stops, 1);
    assert.equal(classes.has('is-leaving'), true);
  } finally {
    delete globalThis.matchMedia;
  }
});

test('mid-turn stray hide() and SCAN remark do not wipe open chat or drop streamed deltas', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  try {
    const { Chat } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/chat.js')));
    const { Panel } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/panel.js')));
    let releaseSend;
    const streamed = [];

    const panel = Object.assign(Object.create(Panel.prototype), {
      current: { kind: 'chat', chat: {}, actions: [], onLeave: () => chat.close(false) },
      el: { hidden: false, classList: { add() {}, remove() {} } },
      quote: { textContent: '', hidden: true },
      verdict: { hidden: true },
      photo: { hidden: true },
      clip: { hidden: true },
      actions: { hidden: true, replaceChildren() {} },
      line: { textContent: '', scrollTop: 0, scrollHeight: 0, classList: { add() {}, remove() {} } },
      leaving: false,
      suspended: false,
      chatBusy: false,
      missed: null,
      hideTimer: 0,
      decodeTimer: 0,
      streaming: false,
      streamTo: [],
      streamDone: false,
      onTalk: null,
      onDismiss: null,
      setFace() {},
      setVerdict() {},
      setChatBusy(b) { this.chatBusy = Boolean(b); },
      setActions(a) { if (this.current) this.current.actions = a; },
      chatTurn() { this.streaming = true; },
      stopStream() {},
      hideClip() {},
      glitchLine() {},
      place() {},
      stream(txt, opts) {
        if (!this.current?.chat) return;
        streamed.push([txt, Boolean(opts?.done)]);
        if (opts?.done) this.streaming = false;
      },
    });

    const chat = Object.assign(Object.create(Chat.prototype), {
      open: true,
      turn: 0,
      routing: 0,
      agent: false,
      cold: false,
      warm: true,
      opening: null,
      answer: '',
      afterToken: 0,
      verdictPending: false,
      afterPending: false,
      history: [],
      apps: [],
      appsReady: Promise.resolve(),
      shortModel: 'E4B',
      brain: { t: { chat: { loading: '' } } },
      bond: null,
      capri: { pulse() {} },
      panel,
      host: {
        chatLog() {},
        chatRoute: async () => null,
        chatSend: async () => new Promise((r) => { releaseSend = r; }),
      },
      asked: () => null,
      persona: () => '',
      languageNote: () => '',
      remember(e) { this.history.push(e); },
      listApps() {},
      after: async () => {},
    });

    const sending = chat.send('первый вопрос');
    await new Promise((r) => setTimeout(r, 10));

    // Mid-turn background interference: panel.hide() + Look SCAN remark
    panel.hide();
    assert.equal(panel.say({ kind: 'info', badge: 'SCAN', line: 'Task Empire', hold: 6000 }), false);
    assert.equal(panel.current?.kind, 'chat');
    assert.equal(chat.open, true);

    chat.onDelta({ id: chat.turn, text: 'Ответ ', status: '' });
    releaseSend({ ok: true, text: 'Ответ на месте' });
    await sending;

    assert.equal(chat.open, true);
    assert.equal(panel.current?.kind, 'chat');
    assert.ok(streamed.some(([t, d]) => t === 'Ответ на месте' && d === true));
    assert.equal(chat.history[0]?.content, 'первый вопрос');
  } finally {
    delete globalThis.matchMedia;
  }
});

test('Look.now() aborts without chat.seen, panel.say, or onAnswer if chat opens during lookSay', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  try {
    const { Look } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/look.js')));
    let releaseLookSay;
    const says = [];
    const answers = [];
    const look = Object.assign(Object.create(Look.prototype), {
      auto: true,
      asked: true,
      looking: false,
      lastFg: null,
      lastAt: 0,
      capri: {
        busy: false, dragging: false, stowed: false, dormant: false, hidden: false, act: false, pointing: false,
        stance: 'stand', mode: 'idle',
        windows: { wins: [], fg: 1 },
        view: { w: 1920, floor: 1080 },
        pos: { x: 100 },
        towardCenter: () => 1,
        cutinAt: () => [0, 0],
        perform() {},
      },
      panel: {
        visible: false,
        say(m) { says.push(m); return true; },
      },
      brain: { t: { look: { failed: '', noVision: '', noAI: '' } } },
      chat: {
        open: false,
        seen: null,
        lookPersona: () => '',
        languageNote: () => '',
        onAnswer: (t) => answers.push(t),
      },
      guide: { running: false },
      fx: { cutin() {}, scan() {} },
      voice: { play() {} },
      host: {
        lookSnap: async () => ({ ok: true, id: 'snap1' }),
        lookSay: () => new Promise((r) => { releaseLookSay = r; }),
      },
    });

    const p = look.now();
    await new Promise((r) => setTimeout(r, 0));
    look.chat.open = true; // chat opened while VLM call was in flight
    releaseLookSay({ ok: true, text: 'Task Empire tab' });
    await p;

    assert.equal(look.chat.seen, null);
    assert.equal(says.length, 0);
    assert.equal(answers.length, 0);
  } finally {
    delete globalThis.matchMedia;
  }
});

test('Brain.onStop() and Jealousy.chase() do not hide panel when chat is open', async () => {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  try {
    const { Brain } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/brain.js')));
    const { Jealousy } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/bond.js')));
    const { Panel } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/panel.js')));
    const { linesFor } = await import(moduleUrl(path.join(__dirname, '../src/renderer/js/lines.js')));

    // 1. Brain.onStop while chat is open queues into panel.missed and skips hide/teleport/celebrate
    let hides = 0;
    let teleports = 0;
    let celebrates = 0;
    const panel = Object.assign(Object.create(Panel.prototype), {
      current: { kind: 'chat', chat: {} },
      el: { hidden: false },
      suspended: false,
      leaving: false,
      chatBusy: false,
      missed: null,
      setTicker() {},
      hide() { hides++; },
    });
    const brain = Object.assign(Object.create(Brain.prototype), {
      lang: 'ru',
      assistant: 'claude',
      source: 'claude',
      panel,
      bond: null,
      mission: null,
      replyFor: null,
      sessions: new Map(),
      capri: {
        windows: { fg: 1 },
        setMode() {},
        spot: () => ({ x: 0 }),
        teleport: async () => { teleports++; },
        celebrate: ({ onSpeak }) => { celebrates++; onSpeak(); },
        earnUplink() {},
      },
    });
    Object.defineProperty(brain, 't', { get: () => linesFor('ru', 'claude') });

    await brain.onStop({ last_assistant_message: 'готово' }, {
      id: 's1', project: 'proj', taskStart: Date.now() - 5000, count: 4, files: new Set(), working: true, window: 1,
    });
    assert.equal(hides, 0);
    assert.equal(teleports, 0);
    assert.equal(celebrates, 0);
    assert.equal(panel.current.kind, 'chat');
    assert.equal(panel.missed?.kind, 'done');

    // 2. Jealousy.chase rechecks chat.open after await warn() and skips hide()/shut()
    let chaseHides = 0;
    let shuts = 0;
    let releaseWarn;
    const jealousy = Object.assign(Object.create(Jealousy.prototype), {
      enabled: true,
      closePages: true,
      front: { id: 9, key: 'chatgpt', page: 'site' },
      noticed: {},
      wait: {},
      brain: { t: linesFor('ru', 'claude') },
      chat: { open: false },
      guide: { running: false },
      panel: { hide() { chaseHides++; }, say() {} },
      capri: {
        windows: { wins: [{ id: 9 }] },
        jealous: async () => true,
        zapShut: async (_w, fn) => fn(),
      },
      warn: () => new Promise((r) => { releaseWarn = r; }),
      shut: async () => { shuts++; return ''; },
    });

    const chasing = jealousy.chase({ id: 9, key: 'chatgpt', page: 'site' }, { id: 9 });
    await new Promise((r) => setTimeout(r, 0));
    jealousy.chat.open = true;
    jealousy.front = null; // tab even left in meantime -> still must NOT call panel.hide()
    releaseWarn(false);
    await chasing;

    assert.equal(chaseHides, 0);
    assert.equal(shuts, 0);
  } finally {
    delete globalThis.matchMedia;
  }
});

