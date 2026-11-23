'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentSessions } = require('../src/main/agent-sessions');
const { parseTranscript } = require('../src/main/agent-import');

function make(run, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-session-test-'));
  const file = path.join(dir, 'sessions.json');
  return { file, hub: new AgentSessions(file, run, () => {}, options) };
}

test('activity for a stopped turn ends once and drops late worker events', async () => {
  const events = [];
  const started = Promise.withResolvers();
  const { hub } = make(async (_agent, _model, _messages, signal, _delta, meta) => {
    meta.onActivity({ kind: 'thinking', state: 'running' });
    started.resolve();
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    meta.onActivity({ kind: 'tool', state: 'done' });
    return 'late answer';
  }, { notifyActivity: (event) => events.push(event) });
  const id = hub.create('claude');
  const sending = hub.send(id, 'sonnet', 'fixture request');
  await started.promise;
  hub.stop(id);
  assert.equal((await sending).stopped, true);
  assert.deepEqual(events.map(({ event }) => [event.kind, event.state]), [
    ['turn', 'running'], ['thinking', 'running'], ['turn', 'stopped'],
  ]);
  assert.ok(events.every((entry) => entry.id === id && entry.runId === events[0].runId));
});

test('queued work survives reopening and runs once when the bridge starts again', async () => {
  const { hub, file } = make(async () => 'unused');
  const id = hub.create('claude');
  hub.active.set('other', new AbortController());
  hub.enqueue(id, 'sonnet', 'queued prompt');
  assert.equal(hub.summaries()[0].queued, true);
  let calls = 0;
  const reopened = new AgentSessions(file, async () => { calls++; return 'answer'; }, () => {});
  await reopened.drain();
  await reopened.drain();
  assert.equal(calls, 1);
  assert.deepEqual(reopened.history(id).map((m) => m.content), ['queued prompt', 'answer']);
  assert.equal(reopened.summaries()[0].queued, false);
});

test('a stopped run affects only its own chat; the other history survives reopening', async () => {
  const { hub, file } = make((agent, model, messages, signal) => agent === 'codex'
    ? new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    : Promise.resolve(messages.at(-1).content));
  const a = hub.create('codex');
  const b = hub.create('claude');
  const running = hub.send(a, 'gpt-6.1-sol', 'first');
  assert.deepEqual(await hub.send(b, 'sonnet', 'second'), { ok: true });
  assert.equal(hub.list().find((row) => row.id === a).busy, true);
  hub.stop(a);
  assert.equal((await running).stopped, true);
  const reopened = new AgentSessions(file, () => {}, () => {});
  assert.deepEqual(reopened.list().find((row) => row.id === a).messages.map((m) => m.content), ['first']);
  assert.deepEqual(reopened.list().find((row) => row.id === b).messages.map((m) => m.content), ['second', 'second']);
});

test('switching model after a limit retries the same prompt once in the same chat', async () => {
  const { hub } = make(async (_agent, model) => {
    if (model === 'gemini-4-argon-medium') throw new Error('rate limit');
    return 'answered';
  });
  const id = hub.create('gemini');
  assert.match((await hub.send(id, 'gemini-4-argon-medium', 'same prompt')).error, /limit/);
  assert.deepEqual(await hub.send(id, 'gemini-3.8-flash-high', '', true), { ok: true });
  assert.deepEqual(hub.list()[0].messages.map((m) => m.content), ['same prompt', 'answered']);
  assert.equal(hub.list()[0].model, 'gemini-3.8-flash-high');
});

test('import keeps visible turns, skips tools and does not duplicate an existing transcript', async () => {
  const { hub } = make(() => {});
  const codex = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }] } },
    { type: 'response_item', payload: { type: 'function_call' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] } },
  ].map((row) => JSON.stringify(row)).join('\n');
  const messages = parseTranscript(codex);
  assert.deepEqual(messages.map((m) => m.content), ['Question', 'Answer']);
  assert.equal(hub.import('codex', [messages, messages]).length, 1);
  assert.deepEqual(hub.import('codex', [messages]), []);
  assert.equal(hub.list()[0].agent, 'codex');
  const [pendingImport] = hub.import('codex', [[{ role: 'user', content: 'An unfinished external request' }]]);
  assert.equal(hub.summaries().find((s) => s.id === pendingImport).canRetry, false);
  await assert.rejects(hub.send(pendingImport, '', '', true), /Нет запроса/);
  assert.equal(parseTranscript(JSON.stringify([{ type: 'user', message: { role: 'user', content: 'Claude' } }]))[0].content, 'Claude');
  assert.equal(parseTranscript(JSON.stringify({ messages: [{ role: 'assistant', text: 'Antigravity' }] }))[0].content, 'Antigravity');
});

test('cloud catalog matches HZ-1 target table, resolves default Codex to gpt-6.2-sol, and replaces failed user turn on next send', async () => {
  const { MODELS, CATALOG } = require('../src/main/agent-sessions');
  const codexKeys = MODELS.codex.map(([k]) => k);
  assert.deepEqual(codexKeys, ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', '']);
  const agyKeys = MODELS.gemini.map(([k]) => k);
  assert.ok(agyKeys.includes('gemini-4-neon-high'));
  assert.ok(agyKeys.includes('gemini-4-argon-low'));
  assert.ok(agyKeys.includes('gemini-4-hydrogen-high'));
  assert.ok(agyKeys.includes('gemini-pro-orchestrator-neon'));
  assert.ok(agyKeys.includes('gemini-pro-orchestrator-g1-pro'));
  assert.ok(agyKeys.includes('orchestrator-claude-opus'));
  assert.ok(!agyKeys.includes('gpt-oss-120b-medium'));
  assert.ok(!agyKeys.includes('gemini-cli-free'));
  assert.deepEqual(MODELS['gemini-web'].map(([k]) => k), ['gemini-web-neon', 'gemini-web-hydrogen']);
  assert.ok(Array.isArray(CATALOG) && CATALOG.some((c) => c.provider === 'gemini-web'));

  let shouldFail = true;
  const { hub } = make(async (_agent, model, messages, _signal, _delta, meta) => {
    if (shouldFail) throw new Error('temporary network error');
    return { text: `ok:${messages.length}`, actualModel: meta.actualModel, effort: meta.effort };
  });
  const id = hub.create('codex');
  const failed = await hub.send(id, '', 'first broken prompt', false, false, true, { effort: 'high' });
  assert.equal(failed.ok, false);
  assert.equal(failed.provider, 'codex');
  assert.equal(failed.actualModel, 'gpt-6.2-sol');
  assert.equal(failed.effort, 'high');

  shouldFail = false;
  const recovered = await hub.send(id, '', 'second clean prompt', false, false, true, { effort: 'xhigh' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.provider, 'codex');
  assert.equal(recovered.actualModel, 'gpt-6.2-sol');
  assert.equal(recovered.effort, 'xhigh');
  assert.deepEqual(hub.history(id).map((m) => `${m.role}:${m.content}`), [
    'user:second clean prompt',
    'assistant:ok:1',
  ]);
});

test('multi-provider cloud session preserves full history across Codex -> Antigravity -> Gemini Web -> Claude and tracks contiguous webChatId', async () => {
  const seenCalls = [];
  const { hub } = make(async (agent, model, messages, _signal, _delta, meta) => {
    seenCalls.push({
      agent,
      model,
      count: messages.length,
      sameProviderContiguous: meta.sameProviderContiguous,
      hydratedFromHistory: meta.hydratedFromHistory,
      webChatId: meta.session?.webChatId || null,
    });
    return {
      text: `reply-${seenCalls.length}-${agent}`,
      actualModel: meta.actualModel,
      effort: meta.effort,
      ...(agent === 'gemini-web' && { webChatId: 'webchat-12345678' }),
    };
  });

  const id = hub.create('codex');
  const r1 = await hub.send(id, 'gpt-6.2-sol', 'turn 1 on codex', false, false, true, {
    agent: 'codex',
    effort: 'low',
    history: [
      { role: 'user', content: 'local turn 1' },
      { role: 'assistant', content: 'local reply 1' },
    ],
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.provider, 'codex');
  assert.equal(seenCalls[0].count, 3);
  assert.equal(seenCalls[0].hydratedFromHistory, true);
  assert.equal(seenCalls[0].sameProviderContiguous, false);

  const r2 = await hub.send(id, 'gemini-4-neon-high', 'turn 2 on agy neon', false, false, true, {
    agent: 'gemini',
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.provider, 'gemini');
  assert.equal(seenCalls[1].count, 5);
  assert.equal(seenCalls[1].sameProviderContiguous, false);

  const r3 = await hub.send(id, 'gemini-web-neon', 'turn 3 on gemini web', false, false, true, {
    agent: 'gemini-web',
  });
  assert.equal(r3.ok, true);
  assert.equal(r3.provider, 'gemini-web');
  assert.equal(seenCalls[2].count, 7);
  assert.equal(seenCalls[2].sameProviderContiguous, false);
  assert.equal(seenCalls[2].webChatId, null);

  const r4 = await hub.send(id, 'gemini-web-neon', 'turn 4 contiguous on gemini web', false, false, true, {
    agent: 'gemini-web',
  });
  assert.equal(r4.ok, true);
  assert.equal(seenCalls[3].count, 9);
  assert.equal(seenCalls[3].sameProviderContiguous, true);
  assert.equal(seenCalls[3].webChatId, 'webchat-12345678');

  const r5 = await hub.send(id, 'sonnet', 'turn 5 on claude', false, false, true, {
    agent: 'claude',
    effort: 'medium',
  });
  assert.equal(r5.ok, true);
  assert.equal(r5.provider, 'claude');
  assert.equal(seenCalls[4].count, 11);
  assert.equal(seenCalls[4].sameProviderContiguous, false);
  assert.equal(seenCalls[4].webChatId, null);

  const finalHistory = hub.history(id);
  assert.equal(finalHistory.length, 12);
  assert.equal(hub.list()[0].agent, 'claude');

  await assert.rejects(
    hub.send(id, 'sonnet', 'blocked ephemeral', false, false, true, { ephemeral: true }),
    /недоступны в этом режиме/,
  );
  await assert.rejects(
    hub.send(id, 'sonnet', 'blocked nsfw', false, false, true, { mode: 'nsfw' }),
    /недоступны в этом режиме/,
  );
  const id2 = hub.create('codex');
  await assert.rejects(
    hub.send(id2, 'gpt-6.2-sol', 'blocked private seed', false, false, true, {
      history: [{ role: 'user', content: 'secret', mode: 'private' }],
    }),
    /Изолированная история/,
  );
});

test('AgentSessions forwards useVault flag through send, enqueue and drain metadata', async () => {
  const seenMeta = [];
  const { hub, file } = make(async (_agent, _model, _messages, _signal, _delta, meta) => {
    seenMeta.push({ useVault: meta.useVault });
    return { text: 'ok', actualModel: meta.actualModel };
  });
  const id = hub.create('codex');
  await hub.send(id, 'gpt-6.2-sol', 'default vault', false, false, true, {});
  await hub.send(id, 'gpt-6.2-sol', 'disabled vault', false, false, true, { useVault: false });
  assert.deepEqual(seenMeta, [{ useVault: true }, { useVault: false }]);

  hub.active.set('blocker', new AbortController());
  hub.enqueue(id, 'gpt-6.2-sol', 'queued without vault', { useVault: false });
  const reopened = new AgentSessions(file, async (_a, _m, _msgs, _s, _d, meta) => {
    seenMeta.push({ useVault: meta.useVault });
    return { text: 'ok-queued', actualModel: meta.actualModel };
  }, () => {});
  await reopened.drain();
  assert.deepEqual(seenMeta.at(-1), { useVault: false });
});

test('AgentSessions.send returns context stats when includeReply is true (runner actual or estimated fallback)', async () => {
  const { buildContextStats } = require('../src/main/context-stats');
  let mode = 'actual';
  const { hub } = make(async (agent, _model, messages, _signal, _delta, meta) => {
    const text = 'Облачный ответ с контекстом.';
    if (mode === 'actual') {
      return {
        text,
        actualModel: meta.actualModel,
        context: buildContextStats({
          model: meta.actualModel,
          provider: agent,
          memoryText: 'Заметка из Obsidian',
          messages: [...messages, { role: 'assistant', content: text }],
          actualPromptTokens: 900,
          actualEvalTokens: 100,
        }),
      };
    }
    return { text, actualModel: meta.actualModel };
  });

  const id = hub.create('codex');
  const withActual = await hub.send(id, 'gpt-6.2-astra', 'первый ход', false, false, true, {});
  assert.equal(withActual.ok, true);
  assert.equal(withActual.context.source, 'actual');
  assert.equal(withActual.context.maxTokens, 272000);
  assert.equal(withActual.context.usedTokens, 1000);
  assert.equal(withActual.context.freeTokens, 271000);

  mode = 'fallback';
  const withFallback = await hub.send(id, 'sonnet', 'второй ход', false, false, true, { agent: 'claude' });
  assert.equal(withFallback.ok, true);
  assert.equal(withFallback.context.source, 'estimated');
  assert.equal(withFallback.context.maxTokens, 1000000);
  assert.ok(withFallback.context.usedTokens > 0);
  assert.equal(withFallback.context.breakdown.free, withFallback.context.freeTokens);
});
