#!/usr/bin/env node
'use strict';

// A stdio bridge to Capri's web MCP (src/main/web-mcp.js, http://127.0.0.1:47825/mcp) for agents that
// can't fetch a header themselves (Gemini CLI, Antigravity). It reads the sealed capability Capri publishes
// in ~/.capri (through scripts/pim-headers.ps1, your Windows account only), then forwards the tool list and
// tool calls. Nothing else: no tools of its own, nothing written.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sdk = (p) => require(path.join(__dirname, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', p));
const { Server } = sdk('server/index.js');
const { StdioServerTransport } = sdk('server/stdio.js');
const { Client } = sdk('client/index.js');
const { StreamableHTTPClientTransport } = sdk('client/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = sdk('types.js');

const URL_ = process.env.CAPRI_WEB_MCP_URL || 'http://127.0.0.1:47825/mcp';

function token() {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'pim-headers.ps1'), '-TokenOnly'], { encoding: 'utf8', windowsHide: true }).trim();
}

let client = null;
async function upstream() {
  if (client) return client;
  const c = new Client({ name: 'capri-web-bridge', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { authorization: `Bearer ${token()}` } } }));
  client = c;
  return c;
}

const down = (e) => ({ isError: true, content: [{ type: 'text', text: `Capri's web is not reachable (is Capri running?): ${e.message}` }] });

(async () => {
  const server = new Server({ name: 'capri-web', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try { return await (await upstream()).listTools(); } catch { client = null; return { tools: [] }; }
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try { return await (await upstream()).callTool(req.params, undefined, { timeout: 600000 }); } catch (e) { client = null; return down(e); }
  });
  await server.connect(new StdioServerTransport());
})();
