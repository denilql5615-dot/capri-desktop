'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatGlue, routeClass } = require('../src/main/brain/chat-glue');
const { createShadowHook, TOR_COOLDOWN_MS } = require('../src/main/brain/shadow-hook');
const { salience } = require('../src/main/brain/amygdala');
const tor = require('../src/main/tor');

const mkDir = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-glue-')), 'brain-journal');

function makeClock(start = Date.UTC(2026, 10, 17, 12, 0, 0), step = 1000) {
  let t = start;
  return () => {
    const cur = t;
    t += step;
    return cur;
  };
}

function makeUuid(prefix = 1000) {
  let n = prefix;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

function makeEnv({ onPendingChange } = {}) {
  const dir = mkDir();
  let hook = null;
  const pendingEvents = [];
  const getHook = (create = true) => {
    if (hook) return hook;
    if (!create) return null;
    hook = createShadowHook({
      dir,
      now: makeClock(),
      uuid: makeUuid(2000),
      onPendingChange: (v) => {
        pendingEvents.push(v);
        onPendingChange?.(v);
      },
    });
    return hook;
  };
  const glue = createChatGlue({
    getHook,
    tor,
    salience,
    isLocalModel: (cfg) => cfg.provider === 'ollama',
  });
  return { dir, glue, getHook, pendingEvents };
}

test('flag off does zero work and never creates or invokes hook, salience, or isLocalModel', async () => {
  let hookCalls = 0;
  let salienceCalls = 0;
  let localChecks = 0;
  const glue = createChatGlue({
    getHook: () => { hookCalls++; return null; },
    tor,
    salience: () => { salienceCalls++; return { urgency: 0, contradiction: 0 }; },
    isLocalModel: () => { localChecks++; return true; },
  });

  const cfgOff = { brainShadow: false, provider: 'ollama', rp: false };
  const msgs = [{ role: 'user', content: 'привет' }];
  const ac = new AbortController();

  glue.beforeTurn(msgs, cfgOff);
  const turn = glue.startLocal({ worker: null }, msgs, cfgOff, ac.signal);
  assert.equal(turn, null);
  glue.onModelSwitch(turn);
  glue.afterSuccess(turn);
  glue.afterError(turn, new Error('boom'), ac.signal);

  glue.beforeTurn(msgs, { brainShadow: 'true' }); // must be strictly true
  assert.equal(hookCalls, 0);
  assert.equal(salienceCalls, 0);
  assert.equal(localChecks, 0);
});

test('two rapid messages back-to-back: second arrives before hold of first without losing slots or miscounting', async () => {
  const { dir, glue, getHook, pendingEvents } = makeEnv();
  const cfg = { brainShadow: true, provider: 'ollama', rp: false };
  const route = { worker: null, tier: 'routine' };

  const m1 = [{ role: 'user', content: 'первое сообщение\n\n(Note for you, never repeat it: ru)' }];
  const m2 = [
    ...m1,
    { role: 'user', content: 'срочно второе сообщение' },
  ];

  // Msg 1 starts
  glue.beforeTurn(m1, cfg);
  const t1 = glue.startLocal(route, m1, cfg, new AbortController().signal);
  assert.ok(t1);

  // Msg 2 starts before Msg 1 reaches afterSuccess/hold
  glue.beforeTurn(m2, cfg); // pending is still null, must NOT cancel t1
  const t2 = glue.startLocal(route, m2, cfg, new AbortController().signal);
  assert.ok(t2);

  // Both succeed; t2 replaces t1 in pending -> t1 becomes unverified, t2 waits
  glue.afterSuccess(t1);
  glue.afterSuccess(t2);
  assert.deepEqual(pendingEvents, [true, false, true]);

  const hook = getHook(false);
  assert.equal(hook.stats().completed_turns, 2);
  assert.equal(hook.verdict(1), true);
  assert.deepEqual(pendingEvents, [true, false, true, false]);

  await hook.close();
  assert.deepEqual(hook.stats(), {
    published: 1,
    discarded: 1,
    observer_errors: 0,
    completed_turns: 2,
    verified_pos: 1,
    verified_neg: 0,
    unverified: 1,
  });
  assert.equal(fs.existsSync(dir), true);
});

test('abort mid-reply cancels observation cleanly with zero journal writes and no pending verdict', async () => {
  const { dir, glue, getHook, pendingEvents } = makeEnv();
  const cfg = { brainShadow: true, provider: 'ollama', rp: false };
  const msgs = [{ role: 'user', content: 'объясни быстро' }];

  const ac = new AbortController();
  const t1 = glue.startLocal({ worker: null }, msgs, cfg, ac.signal);
  assert.ok(t1);
  ac.abort(new Error('user aborted'));
  glue.afterError(t1, ac.signal.reason, ac.signal);

  const acStop = new AbortController();
  const t2 = glue.startLocal({ worker: null }, msgs, cfg, acStop.signal);
  glue.afterError(t2, new Error('stopped'), acStop.signal);

  const hook = getHook(false);
  await hook.close();
  assert.deepEqual(pendingEvents, []);
  assert.deepEqual(hook.stats(), {
    published: 0,
    discarded: 2,
    observer_errors: 0,
    completed_turns: 0,
    verified_pos: 0,
    verified_neg: 0,
    unverified: 0,
  });
  assert.equal(fs.existsSync(dir), false);
});

test('model switch mid-turn abandons observation so later afterSuccess does not hold', async () => {
  const { dir, glue, getHook, pendingEvents } = makeEnv();
  const cfg = { brainShadow: true, provider: 'ollama', rp: false };
  const msgs = [{ role: 'user', content: 'помоги с задачей' }];

  const t = glue.startLocal({ worker: null }, msgs, cfg, new AbortController().signal);
  assert.ok(t);
  glue.onModelSwitch(t); // e.g. chatWithFallback fell back to another / cloud model
  glue.afterSuccess(t);  // caller reaches post-chatWithFallback: turn is already cancelled, must NOT hold

  const hook = getHook(false);
  assert.equal(hook.verdict(1), false);
  await hook.close();
  assert.deepEqual(pendingEvents, []);
  assert.deepEqual(hook.stats(), {
    published: 0,
    discarded: 1,
    observer_errors: 0,
    completed_turns: 0,
    verified_pos: 0,
    verified_neg: 0,
    unverified: 0,
  });
  assert.equal(fs.existsSync(dir), false);
});

test('Tor message between reply and verdict drops pending without touching denominator or journal', async () => {
  const { dir, glue, getHook, pendingEvents } = makeEnv();
  const cfg = { brainShadow: true, provider: 'ollama', rp: false };

  // Turn 1: clean local turn reaches hold -> pending = true
  const m1 = [{ role: 'user', content: 'погода сегодня' }];
  const t1 = glue.startLocal({ worker: null }, m1, cfg, new AbortController().signal);
  glue.afterSuccess(t1);
  assert.equal(getHook(false).stats().completed_turns, 1);
  assert.deepEqual(pendingEvents, [true]);

  // Turn 2: contains Tor wording + even "сработало" -> beforeTurn must cancel t1 as Tor without recording/counting it
  const m2 = [
    { role: 'user', content: 'найди через тор, а то прошлое сработало' },
  ];
  glue.beforeTurn(m2, cfg);
  assert.deepEqual(pendingEvents, [true, false]);
  const t2 = glue.startLocal({ worker: null }, m2, cfg, new AbortController().signal);
  assert.equal(t2, null);

  // Turn 3: another clean turn held, then torTouched() fires directly (e.g. from web:search/torReady)
  const t3 = glue.startLocal({ worker: null }, m1, cfg, new AbortController().signal);
  glue.afterSuccess(t3);
  assert.deepEqual(pendingEvents, [true, false, true]);
  getHook(false).torTouched();
  assert.deepEqual(pendingEvents, [true, false, true, false]);
  assert.equal(getHook(false).verdict(1), false);

  await getHook(false).close();
  assert.deepEqual(getHook(false).stats(), {
    published: 0,
    discarded: 2,
    observer_errors: 0,
    completed_turns: 0,
    verified_pos: 0,
    verified_neg: 0,
    unverified: 0,
  });
  assert.equal(fs.existsSync(dir), false);
});

test('rp mode never starts observation and marks prior pending turn unverified', async () => {
  const { dir, glue, getHook, pendingEvents } = makeEnv();
  const ordinaryCfg = { brainShadow: true, provider: 'ollama', rp: false };
  const rpCfg = { brainShadow: true, provider: 'ollama', rp: true };

  // Ordinary turn reaches hold
  const t1 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'проверь текст' }], ordinaryCfg, new AbortController().signal);
  glue.afterSuccess(t1);
  assert.deepEqual(pendingEvents, [true]);

  // Next turn arrives under rp: true -> even with verdict words, RP turn cancels pending as unverified and starts nothing
  const rpMsgs = [{ role: 'user', content: 'сработало' }];
  glue.beforeTurn(rpMsgs, rpCfg);
  const tRp = glue.startLocal({ worker: null }, rpMsgs, rpCfg, new AbortController().signal);
  assert.equal(tRp, null);
  assert.deepEqual(pendingEvents, [true, false]);

  await getHook(false).close();
  assert.deepEqual(getHook(false).stats(), {
    published: 0,
    discarded: 1,
    observer_errors: 0,
    completed_turns: 1,
    verified_pos: 0,
    verified_neg: 0,
    unverified: 1,
  });
  assert.equal(fs.existsSync(dir), false);
});

test('Stage 5-min: worker routes always classify as unknown, never start observation, and reset pending verdict', async () => {
  const { dir, glue, getHook, pendingEvents } = makeEnv();
  const cfg = { brainShadow: true, provider: 'ollama', rp: false };

  // Ordinary turn reaches hold -> pending ✓/✗ shown
  const local = glue.startLocal({ worker: null, tier: 'routine' }, [{ role: 'user', content: 'подскажи шаг' }], cfg, new AbortController().signal);
  assert.equal(routeClass({ worker: null }), 'ordinary');
  assert.ok(local);
  glue.afterSuccess(local);
  assert.deepEqual(pendingEvents, [true]);

  // Next turn goes to a non-local worker/computer/photo/video -> drops pending and opens NO worker turn
  for (const nonLocalRoute of [
    { worker: 'claude', tier: 'code' },
    { worker: 'codex', tier: 'hard' },
    { worker: 'gemini', tier: 'routine' },
    { worker: 'computer', computer: true },
    { worker: 'photo' },
    { worker: 'video' },
  ]) {
    assert.equal(routeClass(nonLocalRoute), 'unknown');
    assert.equal(glue.onNonLocalTurn(nonLocalRoute), null);
    assert.equal(glue.startLocal(nonLocalRoute, [{ role: 'user', content: 'сработало' }], cfg, new AbortController().signal), null);
  }
  assert.deepEqual(pendingEvents, [true, false]);

  // Simulated chats:new / chats:resume clears any newly pending turn cleanly
  const local2 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'ещё вопрос' }], cfg, new AbortController().signal);
  glue.afterSuccess(local2);
  assert.deepEqual(pendingEvents, [true, false, true]);
  glue.dropPending();
  assert.deepEqual(pendingEvents, [true, false, true, false]);
  assert.equal(getHook(false).verdict(1), false);

  await getHook(false).close();
  assert.deepEqual(getHook(false).stats(), {
    published: 0,
    discarded: 2,
    observer_errors: 0,
    completed_turns: 2,
    verified_pos: 0,
    verified_neg: 0,
    unverified: 2,
  });
  assert.equal(fs.existsSync(dir), false);
});

test('Tor cooldown quarantine blocks startLocal and beforeTurn verdict reading for TOR_COOLDOWN_MS', async () => {
  const dir = mkDir();
  let clock = Date.UTC(2026, 10, 18, 0, 0, 0);
  let externalTorOpen = false;
  const pendingEvents = [];
  const hook = createShadowHook({
    dir,
    now: () => clock,
    uuid: makeUuid(4000),
    isTorActive: () => externalTorOpen,
    onPendingChange: (v) => pendingEvents.push(v),
  });
  const glue = createChatGlue({
    getHook: () => hook,
    tor,
    salience,
    isLocalModel: (cfg) => cfg.provider === 'ollama',
    isTorBlocked: () => externalTorOpen,
  });
  const cfg = { brainShadow: true, provider: 'ollama', rp: false };

  // Ordinary turn is held waiting for verdict
  const t1 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'обычный вопрос' }], cfg, new AbortController().signal);
  glue.afterSuccess(t1);
  assert.deepEqual(pendingEvents, [true]);

  // Real Tor event happens -> drops pending, activates 10-min quarantine
  hook.torTouched();
  assert.deepEqual(pendingEvents, [true, false]);
  assert.equal(hook.verdict(1), false);

  // During quarantine (< 10 min): startLocal returns null, verdict word doesn't resolve anything
  clock += TOR_COOLDOWN_MS - 1000;
  assert.equal(glue.startLocal({ worker: null }, [{ role: 'user', content: 'чистый вопрос' }], cfg, new AbortController().signal), null);

  // Hold test across isTorBlocked: beforeTurn resets pending without reading verdict
  clock += 2000; // cooldown elapsed -> clean turn can start
  const t2 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'после карантина' }], cfg, new AbortController().signal);
  assert.ok(t2);
  glue.afterSuccess(t2);
  externalTorOpen = true; // 9340 TOR browser active -> beforeTurn discards pending without touching verdict
  glue.beforeTurn([{ role: 'user', content: 'сработало' }], cfg);
  assert.equal(hook.verdict(1), false);
  externalTorOpen = false;
  clock += TOR_COOLDOWN_MS; // quarantine lifts after active TOR browser closed + 10 min

  const t3 = glue.startLocal({ worker: null }, [{ role: 'user', content: 'снова чистый вопрос' }], cfg, new AbortController().signal);
  assert.ok(t3);
  glue.afterSuccess(t3);
  assert.equal(hook.verdict(1), true);

  await hook.close();
  assert.equal(hook.stats().published, 1);
  assert.equal(hook.stats().verified_pos, 1);
  assert.equal(hook.stats().unverified, 0);
});
