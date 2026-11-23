'use strict';

const path = require('node:path');
const { safeText } = require('./activity-journal');
const identifier = /^[\w.-]{1,96}$/;
const privateFile = /(?:^|[\\/])(?:\.git|\.ssh|\.aws|\.capri|\.env(?:\.[^\\/]*)?|auth\.json|credentials?[^\\/]*)(?:[\\/]|$)|\.(?:pem|pfx|key|dpapi)$/i;
const validId = (value) => typeof value === 'string' && identifier.test(value);
const executable = /^(?:&\s*)?(?:["'][^"']*[\\/])?(pwsh|powershell|cmd|bash|sh|git|rg|node|npm|python|py|cat|ls|Get-Content|Get-ChildItem)(?:\.exe)?(?=["'\s]|$)/i;

function commandName(command) {
  return typeof command === 'string' ? executable.exec(command.trim())?.[1] : undefined;
}

function workspaceFile(file, cwd) {
  if (typeof file !== 'string' || !file || privateFile.test(file)) return null;
  const relative = path.relative(cwd, path.resolve(cwd, file)).replace(/\\/g, '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return /^[\p{L}\p{N} ./_@()+-]{1,240}$/u.test(relative) ? relative : null;
}

// Details for the activity feed (2.9 part 3): cut, secrets masked (activity-journal.safeText). The
// model's own reasoning never leaves: thinking is a state only.
const commandDetail = (command, output, exitCode) => {
  const detail = {
    ...(safeText(command, 600) && { command: safeText(command, 600) }),
    ...(safeText(output, 2000, { tail: true }) && { output: safeText(output, 2000, { tail: true }) }),
    ...(Number.isInteger(exitCode) && { exitCode }),
  };
  return Object.keys(detail).length ? { detail } : {};
};
const resultText = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
const mcpName = (raw) => {
  const m = /^mcp__([\w.-]+?)__([\w.-]+)$/.exec(String(raw || ''));
  return m ? `${m[1]} · ${m[2]}` : null;
};

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
    case 'agent_message': {
      const text = safeText(item.text, 800);
      return text && msg.type === 'item.completed' ? { ...event, kind: 'message', text } : null;
    }
    case 'command_execution': {
      const name = commandName(item.command);
      return { ...event, kind: 'command', ...(name && { name }),
        ...commandDetail(item.command, msg.type === 'item.completed' ? item.aggregated_output : '', msg.type === 'item.completed' ? item.exit_code : undefined) };
    }
    case 'mcp_tool_call': {
      const tool = validId(item.tool) ? item.tool : 'MCP';
      return { ...event, kind: 'tool', name: validId(item.server) ? `${item.server} · ${tool}` : tool };
    }
    case 'web_search':
      return { ...event, kind: 'search', name: 'WebSearch', ...(safeText(item.query, 200) && { detail: { input: safeText(item.query, 200) } }) };
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
  const said = new Set();
  let messageNumber = 0;
  let thoughts = new Set();
  function tool(block) {
    if (block?.type !== 'tool_use' || !validId(block.id) || !validId(block.name)) return;
    const previous = tools.get(block.id);
    const kind = block.name === 'Bash' || block.name === 'PowerShell' ? 'command'
      : block.name === 'Skill' ? 'skill' : /^Web(Search|Fetch)$/.test(block.name) ? 'search' : 'tool';
    const event = previous || { id: block.id, kind, name: mcpName(block.name) || block.name };
    const input = block.input || {};
    if (event.kind === 'command') {
      event.name = commandName(input.command) || event.name;
      if (input.command) event.detail = commandDetail(input.command).detail;
    }
    if (event.kind === 'skill' && validId(input.skill)) event.name = input.skill;
    const query = input.query || input.url || input.pattern || input.prompt;
    if (event.kind !== 'command' && typeof query === 'string' && block.name !== 'Agent') event.detail = { input: safeText(query, 300) };
    const read = block.name === 'Read' ? workspaceFile(input.file_path, cwd) || (typeof input.file_path === 'string' && !privateFile.test(input.file_path) ? path.basename(input.file_path) : null) : null;
    if (read) event.files = [read];
    if (['Edit', 'Write', 'MultiEdit'].includes(block.name)) {
      const file = workspaceFile(input.file_path, cwd);
      if (file) event.file = file;
    }
    tools.set(block.id, event);
    const hasInput = Object.keys(input).length > 0; // the stream starts a tool with {}, the full input comes after
    if (!previous || (!previous.sent && hasInput)) {
      event.sent = hasInput;
      publish({ id: event.id, kind: event.kind, name: event.name, state: 'running', ...(event.files && { files: event.files }), ...(event.detail && { detail: event.detail }) });
    }
  }
  function text(block, index, id) {
    if (block?.type !== 'text') return;
    const value = safeText(block.text, 800);
    if (!value) return;
    // one message may come as several events, each with its own content array: the text tells them apart
    const key = `text-${id || messageNumber}-${index}-${value.length}-${value.slice(0, 24).replace(/[^\p{L}\p{N}]/gu, '')}`;
    if (said.has(key)) return;
    said.add(key);
    publish({ id: key, kind: 'message', text: value, state: 'done' });
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
      msg.message.content.forEach((block, index) => { tool(block); text(block, index, validId(msg.message.id) ? msg.message.id : null); });
    } else if (msg?.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block?.type !== 'tool_result') continue;
        const event = tools.get(block.tool_use_id);
        if (!event) continue;
        tools.delete(block.tool_use_id);
        const state = block.is_error ? 'failed' : 'done';
        const output = safeText(resultText(block.content), 2000, { tail: true });
        const detail = event.detail || output ? { ...event.detail, ...(output && { output }) } : null;
        publish({ id: event.id, kind: event.kind, name: event.name, state, ...(event.files && { files: event.files }), ...(detail && { detail }) });
        if (event.file && state === 'done') publish({ id: `file-${event.id}`, kind: 'file', files: [event.file], state });
      }
    }
  };
}

function agyActivity(message, cwd) {
  if (message?.event !== 'step_update') return null;
  const step = message.step_update;
  if (!Number.isSafeInteger(step?.step_index) || step.step_index < 0) return null;
  const states = { ACTIVE: 'running', DONE: 'done', ERROR: 'failed', CANCELLED: 'stopped' };
  const state = typeof step.state === 'string' && Object.hasOwn(states, step.state) ? states[step.state] : null;
  if (!state) return null;
  const id = `agy-${step.step_index}`;
  if (step.step_type === 'agent_response') {
    return state === 'done' && step.usage?.thinking_tokens > 0
      ? { id, state, kind: 'thinking' } : { id, state, kind: 'phase', name: 'generation' };
  }
  if (step.step_type !== 'tool' || !validId(step.tool_name)) return null;
  const name = step.tool_name;
  if (state === 'done' && ['write_file', 'edit_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'apply_patch'].includes(name)) {
    const input = step.tool_info?.parameters;
    const file = workspaceFile(input?.TargetFile ?? input?.Path, cwd);
    if (file) return { id, state, kind: 'file', name, files: [file] };
  }
  if (name === 'run_command') {
    const line = step.tool_info?.parameters?.CommandLine;
    return { id, state, kind: 'command', name: commandName(line) || name, ...commandDetail(line) };
  }
  return { id, state, kind: 'tool', name };
}

module.exports = { codexActivity, claudeActivity, agyActivity };
