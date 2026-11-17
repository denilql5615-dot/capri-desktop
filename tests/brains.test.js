'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Brains, FAST, MAIN, RP_PROMPT, wantsMain, wantsLocal, wantsFast, isEmergency, rpCommand, withRp } = require('../src/main/brains');

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

test('the main brain: the fast one out first, then the main one stays for the idle window', async () => {
  const { brains, calls, tick } = fake();
  assert.equal(await brains.use('main'), MAIN);
  assert.deepEqual(calls, [['unload', FAST]]);
  tick(500);
  assert.equal(brains.current(), MAIN); // small things go to the main one while it's in: no swap back and forth
  assert.equal(await brains.use('main'), MAIN);
  assert.equal(calls.length, 1); // already in: nothing unloaded again
});

test('after the idle window the main one goes and the fast one comes back for good', async () => {
  const { brains, calls, tick, fire } = fake();
  await brains.use('main');
  tick(1000);
  await fire();
  assert.equal(brains.current(), FAST);
  assert.deepEqual(calls.slice(1), [['unload', MAIN], ['warm', FAST, -1]]);
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
