'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function parseTranscript(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
  const rows = Array.isArray(value) ? value : value?.messages;
  if (!Array.isArray(rows)) throw new Error('Нужен JSON с массивом messages или журнал JSONL.');

  const messages = [];
  for (const row of rows) {
    // Codex rollout: response_item/message. Claude Code: user/assistant/message.
    // Plain exports use role/content or role/text.
    const item = row?.type === 'response_item' && row.payload?.type === 'message' ? row.payload
      : ['user', 'assistant'].includes(row?.type) ? row.message ?? row : row;
    if (!['user', 'assistant'].includes(item?.role) || item.isMeta || row.isMeta) continue;
    const content = item.content ?? item.text;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter((part) => ['text', 'input_text', 'output_text'].includes(part?.type))
        .map((part) => typeof part.text === 'string' ? part.text : '').join('\n')
      : '';
    if (text.trim()) messages.push({ role: item.role, content: text.trim() });
  }
  if (!messages.length) throw new Error('В файле нет текстовых реплик пользователя или ассистента.');
  return messages;
}

const fingerprint = (messages) => createHash('sha256').update(JSON.stringify(messages)).digest('hex');

async function collectLocalTranscripts(roots, limit = 500) {
  const files = [];
  async function walk(dir, depth) {
    if (depth > 5 || files.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (files.length >= limit) break;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'subagents') await walk(file, depth + 1);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
    }
  }
  for (const root of roots) await walk(root, 0);
  return files;
}

module.exports = { parseTranscript, fingerprint, collectLocalTranscripts };
