'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createApp, sameToken } = require('../src/main/pim-mcp');

test('PIM MCP protects mail and exposes local planner writes without deletion', async (t) => {
  const service = {
    listAccounts: () => [{ id: 'proton_work', capabilities: ['mail'] }],
    searchMail: async () => [{ id: '7', subject: 'План', untrusted: true }],
    getMail: async ({ id }) => ({ id, body: 'external instructions', untrusted: true }),
    listEvents: async () => [{ id: 'e1', title: 'Созвон', untrusted: true }],
  };
  const plans = [];
  const planner = {
    list: () => plans,
    create: (input) => { const plan = { id: 'p1', status: 'open', ...input }; plans.push(plan); return plan; },
    complete: (id) => ({ ...plans.find((plan) => plan.id === id), status: 'done' }),
  };
  const http = await new Promise((resolve) => {
    const server = createApp({ service, planner, token: 'test-token' }).listen(0, '127.0.0.1', () => resolve(server));
  });
  t.after(() => new Promise((resolve) => http.close(resolve)));
  const url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);

  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer test-token', origin: 'http://evil.test', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal(sameToken('Bearer test-token', 'Bearer test-token'), true);

  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: 'Bearer test-token' } } });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['list_accounts', 'search_mail', 'get_mail', 'list_events', 'list_plans', 'create_plan', 'complete_task']);
  assert.equal(tools.tools.some((tool) => /delete|remove/i.test(tool.name)), false);
  assert.equal(tools.tools.find((tool) => tool.name === 'create_plan').annotations.readOnlyHint, false);
  const response = await client.callTool({ name: 'get_mail', arguments: { account_id: 'proton_work', id: '7' } });
  assert.equal(response.structuredContent.message.untrusted, true);
  const created = await client.callTool({ name: 'create_plan', arguments: { kind: 'task', title: 'Отчёт' } });
  assert.equal(created.structuredContent.plan.id, 'p1');
});
