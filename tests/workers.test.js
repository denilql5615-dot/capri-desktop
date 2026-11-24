'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { route, handsWorker, workerChain, runWorker, codexBrief, parseAgyEvent, agyModel } = require('../src/main/workers');

test('workerChain and runWorker cascade Claude -> Codex -> Antigravity by tier (Flash last) on limits', async () => {
  assert.deepStrictEqual(workerChain('claude', 'сделай таблицу'), [
    'claude', 'codex', 'gemini-4-hydrogen-medium', 'claude-sonnet-5-5-medium', 'gemini-3.8-flash-high',
  ]);
  assert.deepStrictEqual(workerChain('claude', 'глубокий разбор', 'deep'), [
    'claude', 'codex', 'gemini-4-carbon-high', 'gemini-4-argon-high', 'claude-opus-5-5-high', 'gemini-4-hydrogen-xhigh', 'gemini-3.8-flash-high',
  ]);
  assert.deepStrictEqual(workerChain('gemini', 'Опус, сделай таблицу'), [
    'claude-opus-5-5-medium', 'gemini-4-hydrogen-medium', 'claude-sonnet-5-5-medium', 'gemini-3.8-flash-high',
  ]);

  const tried = [];
  const steps = [];
  let codexModel;
  const answer = await runWorker('claude', {}, [{ role: 'user', content: 'сделай таблицу' }], () => {}, null, {
    onStep: (step, prev) => steps.push([step, prev]), model: 'sonnet', codexModel: 'gpt-6.1-sol', tier: 'routine',
  }, {
    claude: async () => { tried.push('claude'); throw new Error('rate limit'); },
    codex: async (_c, _m, _s, _g, o) => { tried.push('codex'); codexModel = o.model; throw new Error('5h limit'); },
    gemini: async (_cfg, _msgs, _send, _sig, { model }) => {
      tried.push(model);
      if (model !== 'gemini-3.8-flash-high') throw new Error(`Лимит ${model}`);
      return 'готово от стажёра Flash';
    },
  });
  assert.strictEqual(answer, 'готово от стажёра Flash');
  assert.strictEqual(codexModel, 'gpt-6.1-sol'); // Codex's own model, not Claude's "sonnet"
  assert.deepStrictEqual(tried, [
    'claude', 'codex', 'gemini-4-hydrogen-medium', 'claude-sonnet-5-5-medium', 'gemini-3.8-flash-high',
  ]);
  assert.deepStrictEqual(steps.at(-1), [
    'gemini-3.8-flash-high',
    ['claude', 'codex', 'gemini-4-hydrogen-medium', 'claude-sonnet-5-5-medium'],
  ]);
});

test('Antigravity: the tier picks the model; a model named at the start goes first', () => {
  assert.strictEqual(agyModel('сделай', 'routine'), 'gemini-4-hydrogen-medium');
  assert.strictEqual(agyModel('сделай', 'deep'), 'gemini-4-carbon-high');
  assert.strictEqual(agyModel('сделай', 'mechanical'), 'gemini-3.8-flash-medium');
  assert.strictEqual(route('Карбон, ответь'), 'gemini');
  assert.strictEqual(agyModel('Карбон, быстро', 'mechanical'), 'gemini-4-carbon-low');
  assert.strictEqual(agyModel('Карбон, ответь'), 'gemini-4-carbon-medium');
  assert.strictEqual(agyModel('Карбон, разбери', 'deep'), 'gemini-4-carbon-high');
  assert.strictEqual(agyModel('Аргон, ответь'), 'gemini-4-argon-medium');
  assert.strictEqual(agyModel('Аргон, разбери', 'deep'), 'gemini-4-argon-high');
  assert.strictEqual(agyModel('Хидроген, перепиши модуль', 'deep'), 'gemini-4-hydrogen-xhigh');
  assert.strictEqual(route('Хидроген, перепиши модуль'), 'gemini');
  assert.strictEqual(route('Опус, ответь'), 'gemini');
  assert.strictEqual(agyModel('Опус, ответь'), 'claude-opus-5-5-medium');
  assert.strictEqual(route('Флеш, ответь'), 'gemini');
  assert.strictEqual(agyModel('Флеш, ответь'), 'gemini-3.8-flash-high');
  assert.strictEqual(agyModel('ОСС, накидай черновик'), 'gpt-oss-120b-medium');
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
  assert.strictEqual(WORKER_LABELS['gemini-cli-free'], 'Gemini CLI');
  assert.strictEqual(WORKER_LABELS['gemini-4-carbon-low'], 'Gemini Carbon (low)');
  assert.strictEqual(WORKER_LABELS['gemini-4-carbon-medium'], 'Gemini Carbon');
  assert.strictEqual(WORKER_LABELS['gemini-4-carbon-high'], 'Gemini Carbon (high)');
  assert.strictEqual(WORKER_LABELS['gemini-4-hydrogen-xhigh'], 'Gemini Hydrogen (xhigh)');
  assert.strictEqual(WORKER_LABELS['claude-opus-5-5-medium'], 'Claude Opus 5.5');
});

test('transcript preserves up to 40 prior turns without truncating at 8', () => {
  const { transcript } = require('../src/main/workers');
  const msgs = [];
  for (let i = 1; i <= 15; i++) {
    msgs.push({ role: 'user', content: `question-${i}` });
    msgs.push({ role: 'assistant', content: `answer-${i}` });
  }
  msgs.push({ role: 'user', content: 'final-question' });
  const out = transcript(msgs);
  assert.match(out, /User: question-1\b/);
  assert.match(out, /Capri: answer-15\b/);
  assert.match(out, /Task: final-question$/);
});

test('askCodex resolves immediately on turn.completed JSONL event without waiting for slow process close', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { askCodex } = require('../src/main/workers');
  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-codex-test-'));

  let spawnedArgs = null;
  let spawnedEnv = null;
  const mockSpawn = (_exe, args, opts) => {
    spawnedArgs = args;
    spawnedEnv = opts.env;
    const child = new EventEmitter();
    child.pid = 999999;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin.on('finish', () => {
      child.stdout.write(`${JSON.stringify({ type: 'thread.started' })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'command', type: 'command_execution', exit_code: 0 } })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } })}\n`);
      child.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1420, cached_input_tokens: 200, output_tokens: 35 } })}\n`);
      // Intentionally do NOT emit 'close' to prove immediate resolution on turn.completed
    });
    return child;
  };

  const deltas = [];
  const usages = [];
  const activity = [];
  const res = await askCodex(
    { workDir: tmpWorkDir },
    [{ role: 'user', content: 'Ответь словом OK' }],
    (d) => deltas.push(d),
    new AbortController().signal,
    { model: 'gpt-6.2-sol', effort: 'low', onUsage: (u) => usages.push(u), onActivity: (step) => activity.push(step) },
    () => 'codex-mock',
    mockSpawn,
  );
  assert.strictEqual(res, 'OK');
  assert.deepStrictEqual(deltas, ['OK']);
  assert.deepStrictEqual(usages, [{ promptTokens: 1420, evalTokens: 35 }]);
  assert.deepStrictEqual(activity, [{ id: 'command', kind: 'command', state: 'done', detail: { exitCode: 0 } }]);
  assert.ok(spawnedArgs.includes('--ephemeral'));
  assert.ok(spawnedArgs.includes('--json'));
  assert.ok(spawnedArgs.includes('mcp_servers.capri-web.enabled=false'));
  assert.ok(spawnedArgs.includes('mcp_servers.blender.enabled=false'));
  assert.ok(spawnedArgs.includes('notify=[]'));
  assert.strictEqual(spawnedEnv.CAPRI_WORKER_SUBPROCESS, '1');
  try { fs.rmSync(tmpWorkDir, { recursive: true, force: true }); } catch {}
});

test('askGemini reuses warm persistent stream-json process for contiguous session turns and resets on provider switch', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { askGemini, stopAgyWorkers } = require('../src/main/workers');
  const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-agy-test-'));

  let spawnCount = 0;
  const receivedPrompts = [];
  const steps = [];
  const mockSpawn = () => {
    spawnCount++;
    const procId = spawnCount;
    const child = new EventEmitter();
    child.pid = 888000 + procId;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    let turnNum = 0;
    let inBuf = '';
    child.stdin.on('data', (chunk) => {
      inBuf += chunk.toString('utf8');
      let nl;
      while ((nl = inBuf.indexOf('\n')) >= 0) {
        const line = inBuf.slice(0, nl).trim();
        inBuf = inBuf.slice(nl + 1);
        if (!line) continue;
        turnNum++;
        const payload = JSON.parse(line);
        receivedPrompts.push(payload.message.content);
        setImmediate(() => {
          child.stdout.write(`${JSON.stringify({ event: 'step_update', step_update: { step_index: turnNum, state: 'DONE', step_type: 'tool', tool_name: 'read_file' } })}\n`);
          child.stdout.write(`${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: `proc${procId}-turn${turnNum}` } })}\n`);
        });
      }
    });
    return child;
  };

  try {
    const sig = new AbortController().signal;
    const r1 = await askGemini(
      { workDir: tmpWorkDir },
      [{ role: 'user', content: 'first question' }],
      () => {},
      sig,
      { model: 'gemini-3.8-flash-high', sessionId: 'sess-1', sameProviderContiguous: false, onActivity: (step) => steps.push(['first', step.id]) },
      () => 'agy-mock',
      mockSpawn,
    );
    assert.strictEqual(r1, 'proc1-turn1');
    assert.strictEqual(spawnCount, 1);

    // Contiguous turn 2 in same session + same model -> reuses warm process 1 without duplicating history
    const r2 = await askGemini(
      { workDir: tmpWorkDir },
      [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'proc1-turn1' },
        { role: 'user', content: 'second question' },
      ],
      () => {},
      sig,
      { model: 'gemini-3.8-flash-high', sessionId: 'sess-1', sameProviderContiguous: true, onActivity: (step) => steps.push(['second', step.id]) },
      () => 'agy-mock',
      mockSpawn,
    );
    assert.strictEqual(r2, 'proc1-turn2');
    assert.deepEqual(steps, [['first', 'agy-1'], ['second', 'agy-2']]);
    assert.strictEqual(spawnCount, 1);
    assert.ok(!receivedPrompts[1].includes('Conversation so far:'));
    assert.match(receivedPrompts[1], /Task: second question$/);

    // Non-contiguous turn (another provider answered in between) -> respawns fresh process with full history
    const r3 = await askGemini(
      { workDir: tmpWorkDir },
      [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'proc1-turn1' },
        { role: 'user', content: 'codex question' },
        { role: 'assistant', content: 'codex answer' },
        { role: 'user', content: 'third question back on agy' },
      ],
      () => {},
      sig,
      { model: 'gemini-3.8-flash-high', sessionId: 'sess-1', sameProviderContiguous: false },
      () => 'agy-mock',
      mockSpawn,
    );
    assert.strictEqual(r3, 'proc2-turn1');
    assert.strictEqual(spawnCount, 2);
    assert.match(receivedPrompts[2], /Conversation so far:/);
    assert.match(receivedPrompts[2], /Capri: codex answer/);
  } finally {
    stopAgyWorkers();
    try { fs.rmSync(tmpWorkDir, { recursive: true, force: true }); } catch {}
  }
});
