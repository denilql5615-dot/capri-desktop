'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const tor = require('../src/main/tor');
const web = require('../src/main/web');
const { createApp } = require('../src/main/web-mcp');
const { classifyWebSearch, createAgentWeb } = require('../src/main/tor-guard');

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

  const normal = classifyWebSearch('торговля и рецепт торта', {}, tor);
  assert.equal(normal.torRequested, false);
  assert.equal(normal.dark, false);
  assert.equal(normal.onion, null);
});

test('agentWeb.search with node=main refuses Tor, darknet, and .onion without browser or notes log', async () => {
  for (const q of ['найди через тор новости', 'поищи в даркнете форум', 'проверь abc.onion', `глянь ${V3_ONION}`]) {
    const h = makeHarness();
    await assert.rejects(() => h.agentWeb.search({ query: q, node: 'main' }), /node "tor" или "dark"/i);
    assert.deepEqual(h.events, [['torTouched']]);
    assert.equal(h.appendCalls.length, 0);
  }
});

test('agentWeb.search with node=tor/dark calls torTouched before torReady, uses torOpts, and never logs', async () => {
  const hTor = makeHarness();
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

  const hFail = makeHarness({ failTorReady: true });
  await assert.rejects(() => hFail.agentWeb.search({ query: 'onion', node: 'dark' }), /tor down/);
  assert.deepEqual(hFail.events, [['torTouched'], ['torReady']]);
  assert.equal(hFail.appendCalls.length, 0);
});

test('agentWeb.search with node=main allows clearnet non-Tor queries and logs them', async () => {
  const h = makeHarness();
  const r = await h.agentWeb.search({ query: 'торговля и торт', node: 'main', read: 1 });
  assert.equal(r.node, 'main');
  assert.equal(h.events.some(([kind]) => kind === 'torTouched'), false);
  assert.equal(h.events.some(([kind]) => kind === 'torReady'), false);
  assert.equal(h.appendCalls.length, 1);
  assert.equal(h.appendCalls[0][1].question, 'торговля и торт');
});

test('agentWeb.read refuses Tor/darknet/.onion on node=main, and calls torTouched early on tor/dark', async () => {
  for (const url of [V3_ONION, 'http://fail.onion/page', 'https://example.org/?q=через+тор', 'https://example.org/darknet']) {
    const h = makeHarness();
    await assert.rejects(() => h.agentWeb.read({ url, node: 'main' }), /node "tor" или "dark"/i);
    assert.deepEqual(h.events, [['torTouched']]);
    assert.equal(h.appendCalls.length, 0);
  }

  const hInvalidTor = makeHarness();
  await assert.rejects(() => hInvalidTor.agentWeb.read({ url: 'not-a-url', node: 'tor' }), /нужен адрес/);
  assert.deepEqual(hInvalidTor.events, [['torTouched']]);

  const hOkTor = makeHarness();
  const res = await hOkTor.agentWeb.read({ url: V3_ONION, node: 'dark' });
  assert.equal(res.node, 'dark');
  assert.deepEqual(hOkTor.events.slice(0, 4), [
    ['torTouched'],
    ['torReady'],
    ['openSession', 'tor'],
    ['session.readMany', [V3_ONION]],
  ]);
});

test('agentWeb.askGemini refuses tor/darknet/.onion prompts without calling gemini or logging', async () => {
  for (const prompt of ['найди через тор инфу', 'что такое тор и можно ли там искать', 'поищи в даркнете', V3_ONION]) {
    const h = makeHarness();
    await assert.rejects(() => h.agentWeb.askGemini({ prompt }), /Tor.*Gemini/i);
    assert.deepEqual(h.events, [['torTouched']]);
    assert.equal(h.geminiCalls.length, 0);
    assert.equal(h.appendCalls.length, 0);
  }

  const hClean = makeHarness();
  const ok = await hClean.agentWeb.askGemini({ prompt: 'сравни торт и торговлю' });
  assert.equal(ok.answer, 'ok');
  assert.equal(hClean.geminiCalls.length, 1);
  assert.equal(hClean.events.some(([kind]) => kind === 'torTouched'), false);
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
});
