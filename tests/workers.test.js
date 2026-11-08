'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { route, handsWorker, workerChain, runWorker, codexBrief, parseAgyEvent, agyModel } = require('../src/main/workers');

test('workerChain and runWorker cascade Claude -> Codex -> Argon -> Opus -> Flash on limits', async () => {
  assert.deepStrictEqual(workerChain('claude', 'сделай таблицу'), [
    'claude', 'codex', 'gemini-4-argon-medium', 'claude-opus-5-5-medium', 'gemini-3.8-flash-high',
  ]);
  assert.deepStrictEqual(workerChain('gemini', 'Опус, сделай таблицу'), [
    'claude-opus-5-5-medium', 'gemini-3.8-flash-high',
  ]);

  const tried = [];
  const steps = [];
  const answer = await runWorker('claude', {}, [{ role: 'user', content: 'сделай таблицу' }], () => {}, null, {
    onStep: (step, prev) => steps.push([step, prev]),
  }, {
    claude: async () => { tried.push('claude'); throw new Error('rate limit'); },
    codex: async () => { tried.push('codex'); throw new Error('5h limit'); },
    gemini: async (_cfg, _msgs, _send, _sig, { model }) => {
      tried.push(model);
      if (model !== 'gemini-3.8-flash-high') throw new Error(`Лимит ${model}`);
      return 'готово от стажёра Flash';
    },
  });
  assert.strictEqual(answer, 'готово от стажёра Flash');
  assert.deepStrictEqual(tried, [
    'claude', 'codex', 'gemini-4-argon-medium', 'claude-opus-5-5-medium', 'gemini-3.8-flash-high',
  ]);
  assert.deepStrictEqual(steps.at(-1), [
    'gemini-3.8-flash-high',
    ['claude', 'codex', 'gemini-4-argon-medium', 'claude-opus-5-5-medium'],
  ]);
});

test('Antigravity worker defaults to Argon Medium and requires an explicit reserve address', () => {
  assert.strictEqual(agyModel('Аргон, ответь'), 'gemini-4-argon-medium');
  assert.strictEqual(route('Опус, ответь'), 'gemini');
  assert.strictEqual(agyModel('Опус, ответь'), 'claude-opus-5-5-medium');
  assert.strictEqual(route('Флеш, ответь'), 'gemini');
  assert.strictEqual(agyModel('Флеш, ответь'), 'gemini-3.8-flash-high');
  assert.strictEqual(route('Расскажи про Flash'), null);
});

test('handsWorker: your choice drives the PC, the other if it is missing, her own agent if neither', () => {
  const both = { claude: () => 'c', codex: () => 'x' };
  const onlyCodex = { claude: () => null, codex: () => 'x' };
  assert.strictEqual(handsWorker('claude', both), 'claude');
  assert.strictEqual(handsWorker(undefined, both), 'claude');
  assert.strictEqual(handsWorker('codex', both), 'codex');
  assert.strictEqual(handsWorker('claude', onlyCodex), 'codex');
  assert.strictEqual(handsWorker('claude', { claude: () => null, codex: () => null }), null);
  assert.strictEqual(handsWorker('capri', both), null);
});

test('route: a worker named goes to it, the first named wins', () => {
  assert.strictEqual(route('Клод, разбери этот лог'), 'claude');
  assert.strictEqual(route('спроси клауда'), 'claude');
  assert.strictEqual(route('пусть Кодекс глянет'), 'codex');
  assert.strictEqual(route('ask Codex, not Claude'), 'codex');
  assert.strictEqual(route('Claude или codex?'), 'claude');
  assert.strictEqual(route('Гемини, проверь документ'), 'gemini');
  assert.strictEqual(route('Аргон, подумай ещё раз'), 'gemini');
  assert.strictEqual(route('Gemini then Codex'), 'gemini');
});

test('parseAgyEvent: accepts only the terminal result event', () => {
  assert.deepStrictEqual(parseAgyEvent('{"event":"result","result":{"status":"SUCCESS","response":"готово"}}'), { status: 'SUCCESS', response: 'готово' });
  assert.strictEqual(parseAgyEvent('{"event":"step_update"}'), null);
  assert.strictEqual(parseAgyEvent('not json'), null);
});

test('route: no worker named, her chat model answers', () => {
  assert.strictEqual(route('йоу, как дела'), null);
  assert.strictEqual(route('телеклод, суперкодекс'), null); // a letter before: another word
  assert.strictEqual(route('скажи кодексу'), 'codex');      // any ending
  assert.strictEqual(route(''), null);
});

test('codexBrief: persona, the conversation and the task, in one prompt', () => {
  const brief = codexBrief([
    { role: 'system', content: 'You are Capri.' },
    { role: 'user', content: 'привет' },
    { role: 'assistant', content: 'йо' },
    { role: 'user', content: 'кодекс, что такое 2+2' },
  ]);
  assert.match(brief, /^You are Capri\./);
  assert.match(brief, /User: привет\n\nCapri: йо/);
  assert.match(brief, /Task: кодекс, что такое 2\+2$/);
});

test('route: asked to stop one is not a task for it', () => {
  const { route } = require('../src/main/workers');
  assert.strictEqual(route('отмени задачу кодексу'), 'stop');
  assert.strictEqual(route('стоп'), 'stop');
  assert.strictEqual(route('Клод, хватит'), 'stop');
  assert.strictEqual(route('кодекс, сделай документ'), 'codex');
});

test('codexEffort: low for an errand, medium when asked to think or for code', () => {
  const { codexEffort } = require('../src/main/workers');
  assert.strictEqual(codexEffort('кодекс, собери docx с брифом'), 'low');
  assert.strictEqual(codexEffort('кодекс, подумай как следует'), 'medium');
  assert.strictEqual(codexEffort('кодекс, напиши скрипт'), 'medium');
});

test('isWorkerEvent: events from their folder are theirs, not hers to narrate', () => {
  const { isWorkerEvent } = require('../src/main/workers');
  const p = require('node:path');
  const dir = p.resolve('/Users/u/Documents/Capri');
  const cfg = { workDir: dir };
  assert.strictEqual(isWorkerEvent({ cwd: dir }, cfg), true);
  assert.strictEqual(isWorkerEvent({ cwd: p.join(dir, 'sub').toUpperCase() }, cfg), true);
  assert.strictEqual(isWorkerEvent({ cwd: `${dir}Other` }, cfg), false);
  assert.strictEqual(isWorkerEvent({ cwd: p.resolve('/Capri/genesis-src') }, cfg), false);
  assert.strictEqual(isWorkerEvent({}, cfg), false);
});

test('skillHints and cheatsheet include domain references, anti-slop rules, and document compilers', () => {
  const { skillHints, cheatsheet, WORKER_LABELS } = require('../src/main/workers');
  assert.match(skillHints('Собери GDD и баланс для ALTA'), /game-studios-reference/);
  assert.match(skillHints('Напиши питч и лендинг для Steam store page'), /marketingskills/);
  assert.match(skillHints('Сделай UI/UX и CSS вёрстку экрана'), /impeccable-ui/);
  assert.match(skillHints('Экспортируй отчёт в PDF и схему в SVG'), /NAME\.pdf\.md/);
  assert.match(cheatsheet(), /NAME\.pdf\.md/);
  assert.match(cheatsheet(), /NAME\.png\.svg/);
  assert.strictEqual(WORKER_LABELS['gemini-cli-free'], 'Gemini CLI (Free)');
});
