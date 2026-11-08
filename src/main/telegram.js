'use strict';

const path = require('node:path');

const LONG_MS = 8 * 60 * 1000;
const LONG_ACTIONS = 50;
const NEEDS_USER = new Set(['permission_prompt', 'elicitation_dialog', 'agent_needs_input']);

const clip = (text, max = 500) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
const assistant = (evt) => String(evt.session_id || '').startsWith('codex:') ? 'Codex'
  : String(evt.session_id || '').startsWith('agy:') ? 'Antigravity' : 'Claude';
const project = (evt) => path.basename(String(evt.cwd || '').replace(/[\\/]+$/, '')) || 'задаче';

function eventNotice(sessions, evt, now = Date.now()) {
  const id = String(evt.session_id || 'unknown');
  if (evt.hook_event_name === 'UserPromptSubmit') sessions.set(id, { started: now, actions: 0 });
  if (evt.hook_event_name === 'PreToolUse') {
    const state = sessions.get(id) || { started: now, actions: 0 };
    state.actions += 1;
    sessions.set(id, state);
  }
  if (evt.hook_event_name === 'Notification' && NEEDS_USER.has(evt.notification_type)) {
    const detail = clip(evt.message, 300);
    return `${assistant(evt)} ждёт твоего ответа в ${project(evt)}.${detail ? ` ${detail}` : ''}`;
  }
  if (evt.hook_event_name !== 'Stop') return '';
  const state = sessions.get(id);
  sessions.delete(id);
  if (!state || (now - state.started < LONG_MS && state.actions < LONG_ACTIONS)) return '';
  const detail = clip(evt.last_assistant_message);
  return `${assistant(evt)} закончил долгую задачу в ${project(evt)}.${detail ? ` ${detail}` : ''}`;
}

class TelegramBot {
  constructor({ token, chatId, saveChatId, fetchImpl = global.fetch }) {
    this.token = token;
    this.chatId = chatId ? String(chatId) : '';
    this.saveChatId = saveChatId;
    this.fetch = fetchImpl;
  }

  async request(method, body = {}) {
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(this.token || '')) return null;
    try {
      const res = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.ok ? data.result : null;
    } catch {
      return null;
    }
  }

  async link() {
    if (this.chatId) return true;
    const updates = await this.request('getUpdates', { allowed_updates: ['message'] });
    const message = Array.isArray(updates) && [...updates].reverse().find((u) => u.message?.text === '/start' && u.message.chat?.type === 'private')?.message;
    if (!message) return false;
    this.chatId = String(message.chat.id);
    this.saveChatId?.(this.chatId);
    return true;
  }

  async send(text) {
    if (!this.chatId || !clip(text)) return false;
    return Boolean(await this.request('sendMessage', { chat_id: this.chatId, text: clip(text, 900) }));
  }

  async pollCommands(onCommand) {
    if (!this.chatId || typeof onCommand !== 'function') return 0;
    const params = { allowed_updates: ['message'] };
    if (this.offset) params.offset = this.offset;
    const updates = await this.request('getUpdates', params);
    if (!Array.isArray(updates) || !updates.length) return 0;
    let handled = 0;
    for (const u of updates) {
      if (Number.isFinite(u.update_id)) this.offset = u.update_id + 1;
      const msg = u.message;
      if (!msg || msg.chat?.type !== 'private' || String(msg.chat?.id) !== this.chatId) continue;
      const text = String(msg.text || '').trim();
      if (!text || text === '/start') continue;
      const reply = await Promise.resolve(onCommand(text)).catch(() => null);
      if (reply) await this.send(reply);
      handled += 1;
    }
    return handled;
  }
}

function hubNotice({ agent, model, task, text, artifacts = [] } = {}) {
  const who = [agent, model].filter(Boolean).join(' · ') || 'HUB';
  const files = Array.isArray(artifacts) && artifacts.length
    ? `\n📎 Файлы: ${artifacts.map((a) => (typeof a === 'string' ? a : a.name)).join(', ')}`
    : '';
  return `✅ [HUB · ${who}] ${clip(task, 90)}\n${clip(text, 400)}${files}`;
}

module.exports = { TelegramBot, eventNotice, hubNotice, LONG_MS, LONG_ACTIONS };
