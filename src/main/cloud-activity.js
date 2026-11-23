'use strict';

const path = require('node:path');
const identifier = /^[\w.-]{1,96}$/;
const privateFile = /(?:^|[\\/])(?:\.git|\.ssh|\.aws|\.capri|\.env(?:\.[^\\/]*)?|auth\.json|credentials?[^\\/]*)(?:[\\/]|$)|\.(?:pem|pfx|key|dpapi)$/i;
const validId = (value) => typeof value === 'string' && identifier.test(value);

function workspaceFile(file, cwd) {
  if (typeof file !== 'string' || !file || privateFile.test(file)) return null;
  const relative = path.relative(cwd, path.resolve(cwd, file)).replace(/\\/g, '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return /^[\p{L}\p{N} ./_@()+-]{1,240}$/u.test(relative) ? relative : null;
}

function codexActivity(msg, cwd) {
  const item = msg?.item;
  if (!validId(item?.id) || !['item.started', 'item.updated', 'item.completed'].includes(msg.type)) return null;
  const state = msg.type === 'item.completed'
    ? (item.status === 'failed' || (item.type === 'command_execution' && Number.isInteger(item.exit_code) && item.exit_code !== 0) ? 'failed' : 'done')
    : 'running';
  const event = { id: item.id, state };
  switch (item.type) {
    case 'reasoning':
      return { ...event, kind: 'thinking' };
    case 'command_execution':
      return { ...event, kind: 'command' };
    case 'mcp_tool_call':
      return { ...event, kind: 'tool', name: validId(item.tool) ? item.tool : 'MCP' };
    case 'web_search':
      return { ...event, kind: 'tool', name: 'WebSearch' };
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const files = [...new Set(changes.slice(0, 32).map((change) => workspaceFile(change?.path, cwd)).filter(Boolean))];
      return files.length ? { ...event, kind: 'file', files } : null;
    }
    default:
      return null;
  }
}

function claudeActivity(cwd, publish) {
  const tools = new Map();
  let messageNumber = 0;
  let thoughts = new Set();
  function tool(block) {
    if (block?.type !== 'tool_use' || !validId(block.id) || !validId(block.name)) return;
    const previous = tools.get(block.id);
    const event = previous || { id: block.id, kind: block.name === 'Bash' ? 'command' : 'tool', name: block.name };
    if (['Edit', 'Write', 'MultiEdit'].includes(block.name)) {
      const file = workspaceFile(block.input?.file_path, cwd);
      if (file) event.file = file;
    }
    tools.set(block.id, event);
    if (!previous) publish({ id: event.id, kind: event.kind, name: event.name, state: 'running' });
  }

  return (msg) => {
    if (msg?.type === 'stream_event') {
      const event = msg.event;
      if (event?.type === 'message_start') {
        messageNumber += 1;
        thoughts = new Set();
      } else if (event?.type === 'content_block_start' && Number.isInteger(event.index)) {
        if (event.content_block?.type === 'thinking') {
          thoughts.add(event.index);
          publish({ id: `thinking-${messageNumber}-${event.index}`, kind: 'thinking', state: 'running' });
        } else tool(event.content_block);
      } else if (event?.type === 'content_block_stop' && thoughts.delete(event.index)) {
        publish({ id: `thinking-${messageNumber}-${event.index}`, kind: 'thinking', state: 'done' });
      }
    } else if (msg?.type === 'assistant' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) tool(block);
    } else if (msg?.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block?.type !== 'tool_result') continue;
        const event = tools.get(block.tool_use_id);
        if (!event) continue;
        tools.delete(block.tool_use_id);
        const state = block.is_error ? 'failed' : 'done';
        publish({ id: event.id, kind: event.kind, name: event.name, state });
        if (event.file && state === 'done') publish({ id: `file-${event.id}`, kind: 'file', files: [event.file], state });
      }
    }
  };
}

module.exports = { codexActivity, claudeActivity };
