'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  Brains, FAST, MAIN, VISION, RP_PROMPT, ANALYSIS_PREDICT, ANALYSIS_CHARS,
  wantsMain, wantsLocal, wantsFast, wantsAnalysis, analysisMode, isEmergency, rpCommand, withRp,
} = require('../src/main/brains');

function fake() {
  const calls = [];
  let clock = 0;
  let fire = null;
  const brains = new Brains({
    ollama: { unload: async (m) => calls.push(['unload', m]), warm: (m, k) => calls.push(['warm', m, k]) },
    idleMs: 1000,
    now: () => clock,
    setTimer: (fn) => { fire = fn; return 1; },
    clearTimer: () => { fire = null; },
  });
  return { brains, calls, tick: (ms) => { clock += ms; }, fire: () => fire?.() };
}

test('the fast brain answers by default; small things never swap', async () => {
  const { brains, calls } = fake();
  assert.equal(brains.current(), FAST);
  assert.equal(await brains.use('fast'), FAST);
  assert.deepEqual(calls, []);
});

test('phone vision releases the fast model and restores it after the vision model exits', async () => {
  const calls = [];
  const brains = new Brains({ ollama: {
    loadedModels: async () => [FAST],
    unload: async (model) => { calls.push(['unload', model]); return true; },
    chat: async ({ model, messages, numCtx }) => {
      assert.equal(brains.visionRunning, true);
      calls.push(['chat', model, messages[0].images.length, numCtx]);
      return 'red, blue';
    },
    warm: (model, keep) => calls.push(['warm', model, keep]),
  } });
  assert.equal(await brains.see([{ role: 'user', content: 'colors', images: ['red', 'blue'] }]), 'red, blue');
  assert.equal(brains.visionRunning, false);
  assert.deepEqual(calls, [['unload', FAST], ['chat', VISION, 2, 2048], ['unload', VISION], ['warm', FAST, -1]]);
});

test('a requested Qwen runs alone and restores E4B when its inference fails', async () => {
  const { brains, calls } = fake();
  brains.ollama.loadedModels = async () => [MAIN];
  const qwen = 'capri-qwen36-heretic:latest';
  await assert.rejects(brains.withAuxiliaryModel(qwen, async () => {
    assert.deepStrictEqual(calls, [['unload', MAIN]]);
    assert.equal(brains.visionRunning, true);
    throw new Error('synthetic inference failure');
  }), /synthetic inference failure/);
  assert.equal(brains.visionRunning, false);
  assert.equal(brains.current(), FAST);
  assert.deepStrictEqual(calls, [['unload', MAIN], ['unload', qwen], ['warm', FAST, -1]]);
});

test('the main brain: the fast one out first, then the main one stays for the idle window', async () => {
  const { brains, calls, tick } = fake();
  assert.equal(await brains.use('main'), MAIN);
  assert.deepEqual(calls, [['unload', FAST]]);
  tick(500);
  assert.equal(brains.current(), MAIN); // small things go to the main one while it's in: no swap back and forth
  assert.equal(await brains.use('main'), MAIN);
  assert.equal(calls.length, 1); // already in: nothing unloaded again
});

test('a failed text-model unload neither starts the other model nor lets vision enter the swap', async () => {
  const { brains, calls } = fake();
  let finishUnload;
  brains.ollama.unload = () => new Promise((resolve) => { finishUnload = resolve; });
  const switching = brains.use('main');
  await assert.rejects(brains.see([]), /Vision|изображен|занят/i);
  finishUnload(false);
  await assert.rejects(switching, /не выгрузилась/);
  assert.equal(brains.current(), FAST);
  assert.deepStrictEqual(calls, []);
});

test('after the idle window the main one goes and the fast one comes back for good', async () => {
  const { brains, calls, tick, fire } = fake();
  await brains.use('main');
  tick(1000);
  await fire();
  assert.equal(brains.current(), FAST);
  assert.deepEqual(calls.slice(1), [['unload', MAIN], ['warm', FAST, -1]]);
});

test('the idle timer cannot interrupt a long 26B reply', async () => {
  const { brains, calls, tick, fire } = fake();
  await brains.use('main');
  await brains.runMain(async () => {
    tick(2000);
    await fire();
    assert.equal(brains.mainActive(), true);
    assert.deepStrictEqual(calls, [['unload', FAST]]);
  });
  tick(1001);
  await fire();
  assert.deepStrictEqual(calls, [['unload', FAST], ['unload', MAIN], ['warm', FAST, -1]]);
});

test('forget: everything unloaded elsewhere, no main one any more', async () => {
  const { brains } = fake();
  await brains.use('main');
  brains.forget();
  assert.equal(brains.current(), FAST);
});

test('roles are on only with both models installed; old stored names read as auto', () => {
  const { brains } = fake();
  assert.equal(brains.ready([FAST, MAIN]), true);
  assert.equal(brains.ready([FAST]), false);
  assert.equal(brains.isAuto('auto', [FAST, MAIN]), true);
  assert.equal(brains.isAuto('gemma4:26b-a4b-it-qat', [FAST, MAIN, 'gemma4:26b-a4b-it-qat']), true);
  assert.equal(brains.isAuto('beam:cloud', [FAST, MAIN, 'beam:cloud']), false); // picked by hand: hers
});

test('trigger words: main, local, fast', () => {
  assert.equal(wantsMain('ответь основной моделью'), true);
  assert.equal(wantsMain('подумай как следует над планом'), true);
  assert.equal(wantsMain('привет, как дела'), false);
  assert.equal(wantsLocal('сделай это локально'), true);
  assert.equal(wantsLocal('посчитай без облака'), true);
  assert.equal(wantsLocal('что в облаке на завтра'), false);
  assert.equal(wantsFast('переключись на быструю модель'), true);
});

test('roleplay on and off is a command, not a message', () => {
  assert.equal(rpCommand('включи ролевой режим'), true);
  assert.equal(rpCommand('выключи ролевой режим'), false);
  assert.equal(rpCommand('давай rp'), true);
  assert.equal(rpCommand('что такое ролевая игра'), null);
});

test('the roleplay prompt goes into the system message, and never on an emergency', () => {
  const out = withRp([{ role: 'system', content: 'Ты Капри.' }, { role: 'user', content: 'сцена' }]);
  assert.match(out[0].content, /^Ты Капри\.\n\n/);
  assert.ok(out[0].content.endsWith(RP_PROMPT));
  assert.equal(withRp([{ role: 'user', content: 'x' }])[0].content, RP_PROMPT);
  assert.equal(isEmergency('у друга сильное кровотечение из ноги'), true);
  assert.equal(isEmergency('он без сознания и не дышит'), true);
  assert.equal(isEmergency('продолжи сцену в баре'), false);
});

test('wantsAnalysis matches explicit long-task phrases without over-triggering on bare "разбери"', () => {
  for (const hit of [
    'включи режим аналитика',
    'в режиме аналитика проверь смету',
    'разбери документ ниже',
    'разбери этот документ внимательно',
    'это длинная задача, не торопись',
    'сделай подробный разбор логики',
    'напиши подробный отчёт по кварталу',
    'подробный отчет пожалуйста',
  ]) {
    assert.equal(wantsAnalysis(hit), true, `expected wantsAnalysis=true for: ${hit}`);
  }

  for (const miss of [
    'разбери код выше',
    'разбери почему тест упал',
    'привет, где документ?',
    'сделай краткий отчёт',
    'разбор ситуации',
    'анализ логов',
  ]) {
    assert.equal(wantsAnalysis(miss), false, `expected wantsAnalysis=false for: ${miss}`);
  }
});

test('analysisMode triggers at >4000 chars or phrase, uses 2048 budget, and obeys rp/fast/tor/provider guards', () => {
  const baseCfg = { provider: 'ollama', rp: false };
  const opts = { rolesReady: true, auto: true, tor: false };

  // Threshold: 4000 chars stays ordinary; 4001 enables analyst mode
  assert.deepEqual(analysisMode(baseCfg, { ...opts, text: 'а'.repeat(ANALYSIS_CHARS) }), { active: false, numPredict: undefined });
  assert.deepEqual(analysisMode(baseCfg, { ...opts, text: 'а'.repeat(ANALYSIS_CHARS + 1) }), { active: true, numPredict: ANALYSIS_PREDICT });
  assert.deepEqual(analysisMode(baseCfg, { ...opts, text: 'разбери документ' }), { active: true, numPredict: ANALYSIS_PREDICT });

  // Guards disable analyst mode cleanly
  assert.deepEqual(analysisMode({ provider: 'ollama', rp: true }, { ...opts, text: 'разбери документ' }), { active: false, numPredict: undefined });
  assert.deepEqual(analysisMode(baseCfg, { ...opts, tor: true, text: 'разбери документ' }), { active: false, numPredict: undefined });
  assert.deepEqual(analysisMode(baseCfg, { ...opts, text: 'быстрая модель, ' + 'а'.repeat(ANALYSIS_CHARS + 50) }), { active: false, numPredict: undefined });
  assert.deepEqual(analysisMode({ provider: 'openai', rp: false }, { ...opts, text: 'разбери документ' }), { active: false, numPredict: undefined });
  assert.deepEqual(analysisMode(baseCfg, { rolesReady: false, auto: true, tor: false, text: 'разбери документ' }), { active: false, numPredict: undefined });
  assert.deepEqual(analysisMode(baseCfg, { rolesReady: true, auto: false, tor: false, text: 'разбери документ' }), { active: false, numPredict: undefined });
});
