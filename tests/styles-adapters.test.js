'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { styledWorkflow } = require('../src/main/comfy');
const { callTool, parseReply } = require('../src/main/penpot-mcp');

test('styledWorkflow without pictures is plain NoobAI with the style words', () => {
  const { graph, positive } = styledWorkflow({ prompt: 'portrait', recipe: { positive: 'art deco', negative: 'yellow' }, seed: 1 });
  assert.match(positive, /^portrait, art deco/);
  assert.match(graph[3].inputs.text, /^yellow/);
  assert.deepEqual(graph[5].inputs.model, ['1', 0]);
  assert.equal(Object.values(graph).some((n) => n.class_type.startsWith('IPAdapter')), false);
});

test('styledWorkflow chains IP-Adapter: refs as style transfer, object as linear, sampler on the last one', () => {
  const { graph } = styledWorkflow({ prompt: 'p', recipe: { refWeight: 0.7, objectWeight: 0.5 }, refImages: ['a.png', 'b.png', 'c.png'], objectImages: ['o.png'], seed: 1 });
  const adapters = Object.entries(graph).filter(([, n]) => n.class_type === 'IPAdapterAdvanced');
  assert.equal(adapters.length, 3); // two refs at most + one object
  assert.deepEqual(adapters.map(([, n]) => n.inputs.weight_type), ['style transfer', 'style transfer', 'linear']);
  assert.equal(adapters[2][1].inputs.weight, 0.5);
  assert.deepEqual(adapters[0][1].inputs.model, ['1', 0]);
  assert.deepEqual(adapters[0][1].inputs.clip_vision, ['21', 0]);
  assert.equal(graph[20].class_type, 'IPAdapterModelLoader');
  assert.deepEqual(graph[5].inputs.model, [adapters[2][0], 0]);
  const loads = Object.values(graph).filter((n) => n.class_type === 'LoadImage').map((n) => n.inputs.image);
  assert.deepEqual(loads, ['a.png', 'b.png', 'o.png']);
});

test('parseReply reads plain JSON and server-sent events', () => {
  assert.equal(parseReply('{"jsonrpc":"2.0","id":1,"result":{"x":1}}').result.x, 1);
  assert.equal(parseReply('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"y":2}}\n\n').result.y, 2);
  assert.throws(() => parseReply('event: ping\n'), /пустой/);
});

test('callTool does the handshake and returns the text result', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ method: body.method, session: opts.headers['mcp-session-id'] });
    if (body.method === 'initialize') return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200, headers: { 'mcp-session-id': 'S1' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'done' }] } })}\n\n`, { status: 200 });
  };
  const out = await callTool('execute_code', { code: 'return 1' }, { fetchImpl });
  assert.equal(out, 'done');
  assert.deepEqual(calls.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(calls[2].session, 'S1');
});

test('callTool turns a tool error into a plain error', async () => {
  const fetchImpl = async (url, opts) => {
    const { method } = JSON.parse(opts.body);
    if (method === 'tools/call') return new Response('{"jsonrpc":"2.0","id":2,"result":{"isError":true,"content":[{"type":"text","text":"no file open"}]}}', { status: 200 });
    return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200 });
  };
  await assert.rejects(callTool('execute_code', { code: 'x' }, { fetchImpl }), /no file open/);
});
