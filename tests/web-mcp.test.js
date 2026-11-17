'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createApp } = require('../src/main/web-mcp');

test('web MCP: token and no browser origins; search/read through her nodes, main by default, read-only tools', async (t) => {
  const calls = [];
  const web = {
    search: async (a) => { calls.push(['search', a]); return { node: a.node, results: [{ title: 'A', url: 'https://a.example/' }], pages: [] }; },
    read: async (a) => { calls.push(['read', a]); if (a.url.includes('fail')) throw new Error('Через Tor не вышло'); return { node: a.node, url: a.url, text: 'page' }; },
  };
  const http = await new Promise((resolve) => {
    const server = createApp({ web, token: 'tok' }).listen(0, '127.0.0.1', () => resolve(server));
  });
  t.after(() => new Promise((resolve) => http.close(resolve)));
  const url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer tok', origin: 'http://evil.test', 'content-type': 'application/json' }, body: '{}' })).status, 403);

  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: 'Bearer tok' } } }));
  t.after(() => client.close());
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((x) => x.name), ['web_search', 'read_page']);
  assert.ok(tools.every((x) => x.annotations.readOnlyHint === true && x.annotations.destructiveHint === false));
  assert.deepEqual(tools[0].inputSchema.properties.node.enum, ['main', 'tor', 'dark']);

  const r = await client.callTool({ name: 'web_search', arguments: { query: 'x' } });
  assert.equal(r.structuredContent.node, 'main');
  assert.deepEqual(calls[0], ['search', { query: 'x', node: 'main', read: 3 }]);
  await client.callTool({ name: 'web_search', arguments: { query: 'y', node: 'dark', read: 0 } });
  assert.deepEqual(calls[1], ['search', { query: 'y', node: 'dark', read: 0 }]);
  const bad = await client.callTool({ name: 'read_page', arguments: { url: 'http://fail.onion/', node: 'tor' } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Через Tor не вышло/);
});
