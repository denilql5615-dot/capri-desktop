'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const tor = require('../src/main/tor');
const web = require('../src/main/web');
const { createApp } = require('../src/main/web-mcp');
const {
  TOR_COOLDOWN_MS,
  classifyWebSearch,
  selectWorkerMessages,
  createTorState,
  createAgentWeb,
} = require('../src/main/tor-guard');

const V3_ONION = 'http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/about';

function makeHarness(overrides = {}) {
  const events = [];
  const appendCalls = [];
  const geminiCalls = [];
  let sessionClosed = 0;

  const agentWeb = createAgentWeb({
    getConfig: () => ({ vaultSearch: true, geminiAdviser: true, capriBrowser: 'Camoufox', ...overrides.cfg }),
    tor,
    web,
    browser: {
      openSession: async (opts) => {
        events.push(['openSession', opts.kind]);
        return {
          browser: 'Camoufox',
          search: async (q, searchOpts) => {
            events.push(['session.search', q, searchOpts?.engine || 'default']);
            return [{ title: 'Res', url: 'https://example.org/a', snippet: 'snippet' }];
          },
          readMany: async (urls) => {
            events.push(['session.readMany', urls]);
            return urls.map(() => ({ title: 'T', blocked: false, text: 'body text' }));
          },
          close: async () => { sessionClosed++; },
        };
      },
    },
    notes: {
      appendSearch: (dir, entry) => {
        appendCalls.push([dir, entry]);
        events.push(['notes.appendSearch', entry.question]);
      },
    },
    kiwix: {
      DEFAULT_URL: 'http://kiwix.local',
      search: async () => [],
      read: async () => '',
      catalog: async () => [],
    },
    gemini: {
      electronClipboard: () => ({}),
      ask: async (prompt) => {
        geminiCalls.push(prompt);
        events.push(['gemini.ask', prompt]);
        return { answer: 'ok', chat: 'c1' };
      },
    },
    hasSecret: () => false,
    torReady: async () => {
      events.push(['torReady']);
      if (overrides.failTorReady) throw new Error('tor down');
    },
    torOpts: () => ({ kind: 'tor' }),
    browserOpts: () => ({ kind: 'main' }),
    notesDir: () => 'D:\\Obsidian\\C.A.P.R.I',
    torState: overrides.torState,
    allowTorMcp: overrides.allowTorMcp,
    onTorTouched: () => { events.push(['torTouched']); },
  });

  return { agentWeb, events, appendCalls, geminiCalls, getSessionClosed: () => sessionClosed };
}

test('classifyWebSearch: dark/onion without tor flag or Tor text in query routes to Tor (never clearnet)', () => {
  assert.deepEqual(classifyWebSearch('утечки', { dark: true }, tor), {
    torRequested: true,
    dark: true,
    onion: null,
    query: 'утечки',
  });
  assert.deepEqual(classifyWebSearch('', { onion: V3_ONION }, tor), {
    torRequested: true,
    dark: true,
    onion: V3_ONION,
    query: V3_ONION,
  });
  assert.equal(classifyWebSearch('новости через тор', {}, tor).torRequested, true);
  assert.equal(classifyWebSearch('форум в даркнете', {}, tor).dark, true);
  assert.equal(classifyWebSearch('глянь abc.onion', {}, tor).torRequested, true);

  const normal = classifyWebSearch('торговля и луковый суп', {}, tor);
  assert.equal(normal.torRequested, false);
  assert.equal(normal.dark, false);
  assert.equal(normal.onion, null);
});

test('createTorState tracks lastTorAt 10-minute cooldown, live 9340 browser, and per-chat taint reset', () => {
  assert.equal(TOR_COOLDOWN_MS, 5 * 60 * 1000);
  const { cooldownFromConfig } = require('../src/main/tor-guard');
  assert.equal(cooldownFromConfig({}), 5 * 60 * 1000);
  assert.equal(cooldownFromConfig({ torCooldownMin: 1 }), 60 * 1000);
  assert.equal(cooldownFromConfig({ torCooldownMin: 0 }), 60 * 1000);
  assert.equal(cooldownFromConfig({ torCooldownMin: 99 }), 30 * 60 * 1000);
  let clock = 1_000_000;
  let browserOpen = false;
  const state = createTorState({ now: () => clock, isBrowserActive: () => browserOpen });

  assert.equal(state.inCooldown(), false);
  assert.equal(state.isChatTainted(), false);

  state.touch();
  assert.equal(state.lastTouchedAt(), 1_000_000);
  assert.equal(state.inCooldown(), true);
  assert.equal(state.isChatTainted(), true);

  // resetChat clears per-chat taint (chats:new / chats:resume) WITHOUT lifting the 10-minute cooldown
  state.resetChat();
  assert.equal(state.isChatTainted(), false);
  assert.equal(state.inCooldown(), true);

  clock += TOR_COOLDOWN_MS - 1;
  assert.equal(state.inCooldown(), true);
  clock += 1;
  assert.equal(state.inCooldown(), false);

  // Open TOR browser on 9340 keeps quarantine alive beyond 10 min and refreshes lastTorAt
  browserOpen = true;
  assert.equal(state.isActive(), true);
  assert.equal(state.inCooldown(), true);
  clock += TOR_COOLDOWN_MS + 5000;
  assert.equal(state.inCooldown(), true);
  browserOpen = false;
  assert.equal(state.inCooldown(), true); // cooldown ticks from the last active check
  clock += TOR_COOLDOWN_MS;
  assert.equal(state.inCooldown(), false);

  // enterSession holds active state until release()
  const release = state.enterSession({ inChat: false });
  clock += TOR_COOLDOWN_MS + 1000;
  assert.equal(state.inCooldown(), true);
  release();
  assert.equal(state.inCooldown(), true);
  clock += TOR_COOLDOWN_MS;
  assert.equal(state.inCooldown(), false);
});

test('agentWeb.search with node=main refuses Tor, darknet, and .onion without browser or notes log', async () => {
  for (const q of ['найди через тор новости', 'поищи в даркнете форум', 'проверь abc.onion', `глянь ${V3_ONION}`]) {
    const h = makeHarness();
    await assert.rejects(() => h.agentWeb.search({ query: q, node: 'main' }), /node "tor" или "dark"/i);
    assert.deepEqual(h.events, [['torTouched']]);
    assert.equal(h.appendCalls.length, 0);
  }
});

test('agentWeb (default allowTorMcp=false) refuses Tor/darknet/.onion over MCP for cloud agents', async () => {
  const h = makeHarness();
  await assert.rejects(() => h.agentWeb.search({ query: 'bitcoin', node: 'tor', read: 1 }), /временно отключена/i);
  await assert.rejects(() => h.agentWeb.search({ query: 'bitcoin', node: 'dark', read: 1 }), /временно отключена/i);
  await assert.rejects(() => h.agentWeb.read({ url: V3_ONION, node: 'dark' }), /временно отключена/i);
  await assert.rejects(() => h.agentWeb.read({ url: 'https://example.org/', node: 'tor' }), /временно отключена/i);
  assert.equal(h.events.some(([kind]) => kind === 'torReady' || kind === 'openSession'), false);
  assert.equal(h.appendCalls.length, 0);
});

test('agentWeb.search with node=tor/dark (when allowTorMcp=true) calls torTouched before torReady, uses torOpts, and never logs', async () => {
  const hTor = makeHarness({ allowTorMcp: true });
  const r1 = await hTor.agentWeb.search({ query: 'bitcoin', node: 'tor', read: 1 });
  assert.equal(r1.node, 'tor');
  assert.equal(hTor.appendCalls.length, 0);
  assert.deepEqual(hTor.events.slice(0, 4), [
    ['torTouched'],
    ['torReady'],
    ['openSession', 'tor'],
    ['session.search', 'bitcoin', 'default'],
  ]);
  assert.equal(hTor.getSessionClosed(), 1);

  const hFail = makeHarness({ failTorReady: true, allowTorMcp: true });
  await assert.rejects(() => hFail.agentWeb.search({ query: 'onion', node: 'dark' }), /tor down/);
  assert.deepEqual(hFail.events, [['torTouched'], ['torReady']]);
  assert.equal(hFail.appendCalls.length, 0);
});

test('agentWeb.search with node=main allows clearnet non-Tor queries (including луковый суп) and logs them', async () => {
  const h = makeHarness();
  const r = await h.agentWeb.search({ query: 'луковый суп и торт', node: 'main', read: 1 });
  assert.equal(r.node, 'main');
  assert.equal(h.events.some(([kind]) => kind === 'torTouched'), false);
  assert.equal(h.events.some(([kind]) => kind === 'torReady'), false);
  assert.equal(h.appendCalls.length, 1);
  assert.equal(h.appendCalls[0][1].question, 'луковый суп и торт');
});

test('agentWeb.read refuses Tor/darknet/.onion on node=main, and calls torTouched early on tor/dark', async () => {
  for (const url of [V3_ONION, 'http://fail.onion/page', 'https://example.org/?q=через+тор', 'https://example.org/darknet']) {
    const h = makeHarness();
    await assert.rejects(() => h.agentWeb.read({ url, node: 'main' }), /node "tor" или "dark"/i);
    assert.deepEqual(h.events, [['torTouched']]);
    assert.equal(h.appendCalls.length, 0);
  }

  const hInvalidTor = makeHarness({ allowTorMcp: true });
  await assert.rejects(() => hInvalidTor.agentWeb.read({ url: 'not-a-url', node: 'tor' }), /нужен адрес/);
  assert.deepEqual(hInvalidTor.events, [['torTouched']]);

  const hOkTor = makeHarness({ allowTorMcp: true });
  const res = await hOkTor.agentWeb.read({ url: V3_ONION, node: 'dark' });
  assert.equal(res.node, 'dark');
  assert.deepEqual(hOkTor.events.slice(0, 4), [
    ['torTouched'],
    ['torReady'],
    ['openSession', 'tor'],
    ['session.readMany', [V3_ONION]],
  ]);

  // Embedded .onion in foreign query param must keep the full URL intact when opened via Tor node (not stripped to bare .onion)
  const hQueryOnion = makeHarness({ allowTorMcp: true });
  const wrapped = `https://evil.example/?next=${V3_ONION}`;
  const res2 = await hQueryOnion.agentWeb.read({ url: wrapped, node: 'tor' });
  assert.equal(res2.url, wrapped);
  assert.deepEqual(hQueryOnion.events.find(([k]) => k === 'session.readMany'), ['session.readMany', [wrapped]]);
});

test('agentWeb.askGemini two-circuit filter: circuit (b) blocks commands/.onion/dark in clean session, allows bare Tor', async () => {
  let clock = 5_000_000;
  const torState = createTorState({ now: () => clock });
  const hClean = makeHarness({ torState });

  // Bare discussion of Tor and unrelated topics are allowed in clean session without touching Tor
  const ok1 = await hClean.agentWeb.askGemini({ prompt: 'Как работает сеть Tor и модуль tor.js?' });
  assert.equal(ok1.answer, 'ok');
  const ok2 = await hClean.agentWeb.askGemini({ prompt: 'Что такое тор? Расскажи про луковый суп' });
  assert.equal(ok2.answer, 'ok');
  assert.equal(hClean.geminiCalls.length, 2);
  assert.equal(torState.inCooldown(), false);

  // Circuit (b): explicit prepositional Tor commands, darknet, and .onion are refused even in clean session
  for (const bad of [
    'найди через тор новости',
    'проверь по тору курс',
    'search via tor',
    'fetch over tor please',
    'look up using tor',
    'поищи в даркнете',
    'глянь abc.onion',
    V3_ONION,
  ]) {
    const tState = createTorState({ now: () => clock });
    const h = makeHarness({ torState: tState });
    await assert.rejects(() => h.agentWeb.askGemini({ prompt: bad }), /Gemini не отправляются/i);
    assert.equal(h.geminiCalls.length, 0);
    assert.deepEqual(h.events, [['torTouched']]);
    assert.equal(tState.inCooldown(), true);
  }
});

test('agentWeb.askGemini circuit (a): blocks ALL prompts while Tor is active, in cooldown, or tainted in current chat', async () => {
  let clock = 10_000_000;
  let browserOpen = false;
  const torState = createTorState({ now: () => clock, isBrowserActive: () => browserOpen });
  const h = makeHarness({ torState, allowTorMcp: true });

  // After real Tor search, even a completely innocent prompt is refused
  await h.agentWeb.search({ query: 'bitcoin', node: 'tor', read: 0 });
  await assert.rejects(() => h.agentWeb.askGemini({ prompt: 'сравни два алгоритма сортировки' }), /карантин|использовался Tor/i);
  assert.equal(h.geminiCalls.length, 0);

  // Even after chats:new resets chatTainted, 10-minute cooldown still blocks askGemini
  torState.resetChat();
  clock += TOR_COOLDOWN_MS - 10;
  await assert.rejects(() => h.agentWeb.askGemini({ prompt: 'привет' }), /карантин|использовался Tor/i);

  // Once cooldown expires AND chat was reset, clean prompt is allowed again
  clock += 10;
  const ok = await h.agentWeb.askGemini({ prompt: 'привет, как работает Tor?' });
  assert.equal(ok.answer, 'ok');

  // If 9340 browser opens while clean, circuit (a) blocks again
  browserOpen = true;
  await assert.rejects(() => h.agentWeb.askGemini({ prompt: 'обычный вопрос' }), /карантин|использовался Tor/i);
});

test('selectWorkerMessages strips prior history when Tor isolated, keeping system messages and latest user reply', () => {
  const history = [
    { role: 'system', content: 'Ты Капри.' },
    { role: 'user', content: 'предыдущий вопрос' },
    { role: 'assistant', content: 'секретный ответ из истории' },
    { role: 'user', content: 'сделай таблицу по новым числам' },
  ];

  assert.deepEqual(selectWorkerMessages(history, false), history);
  assert.deepEqual(selectWorkerMessages(history, true), [
    { role: 'system', content: 'Ты Капри.' },
    { role: 'user', content: 'сделай таблицу по новым числам' },
  ]);
  assert.deepEqual(selectWorkerMessages([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }], true), [
    { role: 'user', content: 'b' },
  ]);
});

test('capri-web MCP end-to-end propagates agentWeb main-node Tor refusal cleanly', async (t) => {
  const h = makeHarness();
  const http = await new Promise((resolve) => {
    const server = createApp({ web: h.agentWeb, token: 'tok' }).listen(0, '127.0.0.1', () => resolve(server));
  });
  t.after(() => new Promise((resolve) => http.close(resolve)));

  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${http.address().port}/mcp`),
    { requestInit: { headers: { authorization: 'Bearer tok' } } },
  ));
  t.after(() => client.close());

  const res = await client.callTool({ name: 'web_search', arguments: { query: 'курс через тор', node: 'main' } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /node "tor" или "dark"/i);
  assert.deepEqual(h.events, [['torTouched']]);
  assert.equal(h.appendCalls.length, 0);

  const torBlocked = await client.callTool({ name: 'web_search', arguments: { query: 'news', node: 'tor' } });
  assert.equal(torBlocked.isError, true);
  assert.match(torBlocked.content[0].text, /временно отключена/i);
});
