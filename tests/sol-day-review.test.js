'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tor = require('../src/main/tor');
const {
  TOR_COOLDOWN_MS,
  TOR_MEDIA_BLOCK_MSG,
  TOR_CLIPBOARD_BLOCK_MSG,
  createTorState,
  guardMediaGeneration,
  guardClipboardWrite,
  guardChatRoute,
  resolveSafeRoute,
} = require('../src/main/tor-guard');
const { createReassessmentPolicy } = require('../src/main/brain/reassessment-policy');
const { createShadowHook } = require('../src/main/brain/shadow-hook');
const { planInfluence, resolveInfluenceAb } = require('../src/main/brain/influence-glue');
const { createRouterJournal, sanitizeRouterRecord } = require('../src/main/brain/router-journal');
const { evaluateRouterJournal } = require('../src/main/brain/router-eval');
const { verdictOf } = require('../src/main/brain/amygdala');

function readNdjson(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

test('Sol review #1: media generation (photo/video) and system clipboard writes are blocked in Tor quarantine/context', () => {
  let clock = 1_000_000;
  const torState = createTorState({ now: () => clock });
  const cleanMsg = [{ role: 'user', content: 'скинь фото кота на диване' }];
  const clipMsg = [{ role: 'user', content: 'скопируй в буфер привет' }];

  // Clean session permits media and clipboard writes
  assert.equal(guardMediaGeneration({ torState, messages: cleanMsg, tor }).ok, true);
  assert.equal(guardClipboardWrite({ torState, messages: clipMsg, tor }).ok, true);

  // Even without Tor words, active quarantine (tainted chat or 10-min cooldown) blocks before ComfyUI/clipboard
  torState.touch({ inChat: true });
  const medBlocked = guardMediaGeneration({ torState, messages: cleanMsg, tor });
  assert.equal(medBlocked.ok, false);
  assert.equal(medBlocked.code, 'tor');
  assert.equal(medBlocked.error, TOR_MEDIA_BLOCK_MSG);

  const clipBlocked = guardClipboardWrite({ torState, messages: clipMsg, tor });
  assert.equal(clipBlocked.ok, false);
  assert.equal(clipBlocked.code, 'tor');
  assert.equal(clipBlocked.error, TOR_CLIPBOARD_BLOCK_MSG);

  // Clean chat resets per-chat taint, cooldown still blocks until expiry
  torState.resetChat();
  assert.equal(guardMediaGeneration({ torState, messages: cleanMsg, tor }).ok, false);
  assert.equal(guardClipboardWrite({ torState, messages: clipMsg, tor }).ok, false);

  // Explicit Tor words in prompt/history block even after cooldown expires
  clock += TOR_COOLDOWN_MS;
  assert.equal(guardMediaGeneration({ torState, messages: cleanMsg, tor }).ok, true);
  assert.equal(guardMediaGeneration({ torState, messages: [{ role: 'user', content: 'нарисуй сайт через тор' }], tor }).ok, false);
  assert.equal(guardClipboardWrite({ torState, messages: [{ role: 'user', content: 'скопируй адрес abc.onion в буфер' }], tor }).ok, false);
});

test('Sol review #2: resolveSafeRoute and guardChatRoute never invoke model router (routeOf) when quarantined or Tor context exists', async () => {
  let clock = 2_000_000;
  const torState = createTorState({ now: () => clock });

  let routeCalls = 0;
  const spyRouteOf = async (text) => {
    routeCalls++;
    return {
      worker: text.includes('Клод') ? 'claude' : 'gemini',
      tier: 'complex',
      computer: true,
      route_path: 'router_model',
      fallback_reason: 'none',
      router_latency_ms: 42,
      router_version: 'router-v1',
      router: { target: 'worker', tier: 'complex' },
    };
  };

  // 1. Tor words in messages/history -> zero routeOf invocations, deterministic local Capri route
  const rByMsg = await resolveSafeRoute({
    torState,
    text: 'Клод, разбери страницу',
    messages: [
      { role: 'user', content: 'открой через тор новости' },
      { role: 'assistant', content: 'читаю' },
      { role: 'user', content: 'Клод, разбери страницу' },
    ],
    tor,
    routeFn: spyRouteOf,
  });
  assert.equal(routeCalls, 0);
  assert.equal(rByMsg.worker, null);
  assert.equal(rByMsg.computer, false);
  assert.equal(rByMsg.localOnly, true);

  // 2. Quarantined state with innocent text (zero Tor words) -> zero routeOf invocations
  torState.touch({ inChat: true });
  const rByQuarantine = await resolveSafeRoute({
    torState,
    text: 'Клод, напиши функцию сортировки',
    messages: [{ role: 'user', content: 'Клод, напиши функцию сортировки' }],
    tor,
    routeFn: spyRouteOf,
  });
  assert.equal(routeCalls, 0);
  assert.equal(rByQuarantine.worker, null);
  assert.equal(rByQuarantine.localOnly, true);

  // Preliminary chat:route guard blocks when either text/recentTurns or torState is tainted
  assert.equal(guardChatRoute({ torState, text: 'Клод, помоги', tor }), true);

  // 3. After quarantine ends cleanly, routeOf runs normally and passes worker through
  torState.resetChat();
  clock += TOR_COOLDOWN_MS;
  assert.equal(guardChatRoute({ torState, text: 'Клод, помоги', tor }), false);
  assert.equal(guardChatRoute({ torState, text: 'помоги', history: [{ role: 'user', content: 'abc.onion' }], tor }), true);

  const rClean = await resolveSafeRoute({
    torState,
    text: 'Клод, напиши код',
    messages: [{ role: 'user', content: 'Клод, напиши код' }],
    tor,
    routeFn: spyRouteOf,
  });
  assert.equal(routeCalls, 1);
  assert.equal(rClean.worker, 'claude');

  // 4. Mid-flight taint while awaiting routeFn still drops worker to null
  const rRace = await resolveSafeRoute({
    torState,
    text: 'Клод, напиши код',
    messages: [{ role: 'user', content: 'Клод, напиши код' }],
    tor,
    routeFn: async (txt) => {
      const res = await spyRouteOf(txt);
      torState.touch({ inChat: true });
      return res;
    },
  });
  assert.equal(routeCalls, 2);
  assert.equal(rRace.worker, null);
  assert.equal(rRace.localOnly, true);
});

test('Sol review #3: A/B mode/group/day frozen once at turn start, survives UTC+5 midnight rollover, and feeds router-journal + router-eval', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rj-ab-midnight-'));
  const cfg = {
    brainShadow: true,
    brainInfluence: 'ab',
    brainInfluenceAbStart: '2026-11-18',
    routerJournal: 'on',
    provider: 'ollama',
    rp: false,
  };

  // Turn 1 starts at 2026-11-18 23:59:59 UTC+5 (= 18:59:59 UTC) -> Group B (mode: reassessment)
  // Generation completes at 2026-11-19 00:00:05 UTC+5 (= 19:00:05 UTC) -> MUST stay Group B / 2026-11-18!
  const tBStart = Date.UTC(2026, 10, 18, 18, 59, 59);
  const tBEnd = Date.UTC(2026, 10, 18, 19, 0, 5);
  // Turn 2 starts at 2026-11-19 00:00:10 UTC+5 (= 19:00:10 UTC) -> Group A (mode: off)
  const tAStart = Date.UTC(2026, 10, 18, 19, 0, 10);

  let clock = tBStart;
  const hotHook = {
    peekChannels: () => ({ reassessment: 0.72, reassessment_active: 1, stability: 0.9, circadian_quiet: 0 }),
  };
  const policy = createReassessmentPolicy({
    getConfig: () => cfg,
    hook: hotHook,
    now: () => clock,
  });
  const routerJournal = createRouterJournal({
    dir,
    now: () => clock,
    tor,
  });

  try {
    // Freeze A/B at turn 1 start BEFORE generation (23:59:59 UTC+5 = Group B)
    const turnAbB = resolveInfluenceAb(cfg, tBStart);
    assert.deepEqual(turnAbB, { mode: 'reassessment', ab_group: 'B', ab_day: '2026-11-18' });

    const planB = planInfluence({
      cfg,
      said: 'нет, ты ошиблась, проверь ещё раз',
      messages: [{ role: 'user', content: 'нет, ты ошиблась, проверь ещё раз' }],
      route: { worker: null },
      hook: hotHook,
      policy,
      ab: turnAbB,
      tor,
      env: { local: true, brainsReady: true, isAuto: true, mainActive: false, now: tBStart },
    });
    assert.equal(planB.escalated, true);
    assert.equal(policy.stats().ab_group, 'B');

    // Clock advances across UTC+5 midnight during generation (00:00:05 UTC+5 next day)
    // Turn record MUST keep Group B / 2026-11-18 / reassessment / shadow
    clock = tBEnd;
    const idB = '00000000-0000-4000-8000-000000000a01';
    routerJournal.recordTurn({
      turnId: idB,
      tsMs: tBStart,
      startedAtMs: tBStart,
      cfg,
      route: { worker: null, tier: 'complex', route_path: 'router_model', fallback_reason: 'none' },
      said: 'нет, ты ошиблась, проверь ещё раз',
      messages: [{ role: 'user', content: 'нет, ты ошиблась, проверь ещё раз' }],
      model: '26b',
      workerClass: 'ordinary',
      stage6Override: 1,
      mode: turnAbB.mode === 'reassessment' ? 'shadow' : 'off',
      abGroup: turnAbB.ab_group,
      abDay: turnAbB.ab_day,
      influenceMode: turnAbB.mode,
    });

    // Turn 2 starts on next UTC+5 day -> Group A
    clock = tAStart;
    const turnAbA = resolveInfluenceAb(cfg, tAStart);
    assert.deepEqual(turnAbA, { mode: 'off', ab_group: 'A', ab_day: '2026-11-19' });

    const planA = planInfluence({
      cfg,
      said: 'нет, проверь ещё раз',
      messages: [{ role: 'user', content: 'нет, проверь ещё раз' }],
      route: { worker: null },
      hook: hotHook,
      policy,
      ab: turnAbA,
      tor,
      env: { local: true, brainsReady: true, isAuto: true, mainActive: false, now: tAStart },
    });
    assert.equal(planA.escalated, false);
    assert.equal(policy.stats().ab_group, 'A');

    const idA = '00000000-0000-4000-8000-000000000a02';
    routerJournal.recordTurn({
      turnId: idA,
      tsMs: tAStart,
      startedAtMs: tAStart,
      cfg,
      route: { worker: null, tier: 'complex', route_path: 'router_model', fallback_reason: 'none' },
      said: 'объясни ещё раз',
      messages: [{ role: 'user', content: 'объясни ещё раз' }],
      model: 'e4b',
      workerClass: 'ordinary',
      stage6Override: 0,
      mode: turnAbA.mode === 'reassessment' ? 'shadow' : 'off',
      abGroup: turnAbA.ab_group,
      abDay: turnAbA.ab_day,
      influenceMode: turnAbA.mode,
    });

    await routerJournal.flush();
    const rows = readNdjson(dir);
    assert.equal(rows.length, 2);

    const recB = rows.find((r) => r.turn_id === idB);
    const recA = rows.find((r) => r.turn_id === idA);
    assert.equal(recB.mode, 'shadow');
    assert.equal(recB.ab_group, 'B');
    assert.equal(recB.ab_day, '2026-11-18');
    assert.equal(recB.influence_mode, 'reassessment');

    assert.equal(recA.mode, 'off');
    assert.equal(recA.ab_group, 'A');
    assert.equal(recA.ab_day, '2026-11-19');
    assert.equal(recA.influence_mode, 'off');

    // Schema sanitizer rejects invalid ab_group, ab_day, or influence_mode
    assert.throws(() => sanitizeRouterRecord({ ...recB, ab_group: 'C' }));
    assert.throws(() => sanitizeRouterRecord({ ...recB, ab_day: '2026/11/18' }));
    assert.throws(() => sanitizeRouterRecord({ ...recB, influence_mode: 'ab' }));

    // Stage 7b evaluator reads both A and B groups cleanly
    const evalRes = evaluateRouterJournal(dir);
    assert.equal(evalRes.volumes.by_ab_group.A.total, 1);
    assert.equal(evalRes.volumes.by_ab_group.B.total, 1);
  } finally {
    await routerJournal.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
