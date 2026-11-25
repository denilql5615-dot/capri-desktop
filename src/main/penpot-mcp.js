'use strict';

// A minimal client for the local Penpot MCP server (127.0.0.1:4401, streamable HTTP): one session per call,
// then a tool. Used by styles (2.7a) to put a style's colours and text styles into the open Penpot file.
// Penpot runs the code through its plugin in the browser tab, so a Penpot file must be open there.

const BASE = 'http://127.0.0.1:4401/mcp';
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

/** The JSON-RPC message out of a reply that is either plain JSON or server-sent events. */
function parseReply(text) {
  const body = String(text || '').trim();
  if (body.startsWith('{')) return JSON.parse(body);
  const data = body.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
  for (let i = data.length - 1; i >= 0; i -= 1) {
    try {
      const msg = JSON.parse(data[i]);
      if (msg && (msg.result || msg.error)) return msg;
    } catch {}
  }
  throw new Error('Penpot MCP: пустой ответ');
}

async function post(fetchImpl, body, session, timeoutMs) {
  const headers = session ? { ...HEADERS, 'mcp-session-id': session } : HEADERS;
  const res = await fetchImpl(BASE, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok && res.status !== 202) throw new Error(`Penpot MCP: HTTP ${res.status}`);
  return { res, text: res.status === 202 ? '' : await res.text() };
}

/** Calls one Penpot MCP tool: its text result, or throws in plain words. */
async function callTool(name, args = {}, { fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  let first;
  try {
    first = await post(fetchImpl, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'altai-re-styles', version: '1' } },
    }, null, 8000);
  } catch (err) {
    throw new Error(`Penpot MCP на :4401 не отвечает — запусти Penpot в /docker (${err.message})`);
  }
  const session = first.res.headers.get('mcp-session-id') || '';
  await post(fetchImpl, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, 8000);
  const { text } = await post(fetchImpl, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, session, timeoutMs);
  const msg = parseReply(text);
  if (msg.error) throw new Error(`Penpot MCP: ${msg.error.message || 'ошибка'}`);
  const out = (msg.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  if (msg.result?.isError) throw new Error(`Penpot: ${out || 'ошибка выполнения'}`);
  return out;
}

async function listTools({ fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  let first;
  try {
    first = await post(fetchImpl, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'altai-re-tools', version: '1' } },
    }, null, 6000);
  } catch (err) {
    throw new Error(`Penpot MCP на :4401 не отвечает (${err.message})`);
  }
  const session = first.res.headers.get('mcp-session-id') || '';
  await post(fetchImpl, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, 6000);
  const { text } = await post(fetchImpl, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, session, timeoutMs);
  const msg = parseReply(text);
  if (msg.error) throw new Error(`Penpot MCP: ${msg.error.message || 'ошибка'}`);
  return Array.isArray(msg.result?.tools) ? msg.result.tools : [];
}

module.exports = { callTool, listTools, parseReply };
