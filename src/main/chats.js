'use strict';

// Your chats with her, kept for her Chats window (chats.html): every message, in conversations split
// by a long pause or by "Forget our conversations". Her memory for answering is memory.json; this is
// only for you to read back. On this PC, in her data folder (chats.json), never sent anywhere.

const fs = require('node:fs');

const GAP_MS = 30 * 60 * 1000; // a pause this long: the next message starts a new chat
const MAX_CHATS = 200;
const MAX_MESSAGES = 400;      // in one chat
const MAX_CHARS = 4000;        // in one message

function read(file) {
  try {
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(store?.chats) ? store : { chats: [] };
  } catch {
    return { chats: [] };
  }
}

function write(file, store) {
  try {
    fs.writeFileSync(file, JSON.stringify(store));
  } catch (err) {
    console.error('[capri] could not save her chats:', err.message);
  }
}

// One message more ({ role, content }), in the last chat or a new one. Returns the store.
function add(store, message, now = Date.now()) {
  const content = String(message?.content || '').trim().slice(0, MAX_CHARS);
  if (!content || !['user', 'assistant'].includes(message?.role)) return store;
  let last = store.chats.at(-1);
  if (!last || store.fresh || now - last.updated > GAP_MS || last.messages.length >= MAX_MESSAGES) {
    last = { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, started: now, updated: now, messages: [] };
    store.chats.push(last);
    delete store.fresh;
  }
  last.messages.push({ role: message.role, content, at: now });
  last.updated = now;
  store.chats = store.chats.slice(-MAX_CHATS);
  return store;
}

// "Forget our conversations": she forgets, the next message starts a new chat here
function cut(store) {
  store.fresh = true;
  return store;
}

// The list for her window, newest first: titled by what you said first
function list(store) {
  return store.chats.slice().reverse().map((chat) => {
    const first = chat.messages.find((m) => m.role === 'user') || chat.messages[0];
    return {
      id: chat.id,
      started: chat.started,
      updated: chat.updated,
      count: chat.messages.length,
      title: String(first?.content || '…').replace(/\s+/g, ' ').slice(0, 80),
      messages: chat.messages,
    };
  });
}

module.exports = { GAP_MS, read, write, add, cut, list };
