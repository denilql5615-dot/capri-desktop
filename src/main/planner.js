'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const KINDS = new Set(['event', 'task', 'reminder', 'note']);
const STATUSES = new Set(['open', 'done']);
const MAX_ITEMS = 10000;

function clean(value, max) {
  return String(value || '').replace(/\0/g, '').trim().slice(0, max);
}

function time(value, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new TypeError('planner time is required');
    return null;
  }
  const at = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(at) || at <= 0) throw new TypeError('invalid planner time');
  return Math.trunc(at);
}

function item(input, id = randomUUID(), now = Date.now()) {
  const kind = String(input?.kind || '');
  const title = clean(input?.title, 300);
  if (!KINDS.has(kind) || !title) throw new TypeError('invalid planner item');
  const out = { id, kind, title, notes: clean(input?.notes, 10000), status: 'open', createdAt: now, updatedAt: now };
  if (kind === 'event') {
    out.start = time(input.start, true);
    out.end = time(input.end);
    if (out.end !== null && out.end <= out.start) throw new TypeError('event end must follow start');
  } else if (kind === 'task') {
    out.due = time(input.due);
  } else if (kind === 'reminder') {
    out.at = time(input.at, true);
  }
  return out;
}

class Planner {
  constructor(file, deps = {}) {
    if (!path.isAbsolute(file)) throw new TypeError('planner path must be absolute');
    this.file = file;
    this.id = deps.id || randomUUID;
    this.now = deps.now || Date.now;
    this.onChange = deps.onChange || null; // after every write (main.js: her reminders follow)
  }

  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error('invalid planner data');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  write(items) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(items, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.onChange?.();
  }

  list(filter = {}) {
    const kinds = filter.kinds === undefined ? null : new Set(filter.kinds);
    const status = filter.status === undefined ? null : String(filter.status);
    if (kinds && (!Array.isArray(filter.kinds) || [...kinds].some((kind) => !KINDS.has(kind)))) throw new TypeError('invalid planner kinds');
    if (status && !STATUSES.has(status)) throw new TypeError('invalid planner status');
    const when = (entry) => entry.start ?? entry.due ?? entry.at ?? entry.createdAt;
    return this.read().filter((entry) => (!kinds || kinds.has(entry.kind)) && (!status || entry.status === status))
      .sort((a, b) => when(a) - when(b));
  }

  create(input) {
    const items = this.read();
    if (items.length >= MAX_ITEMS) throw new Error('planner is full');
    const created = item(input, this.id(), this.now());
    this.write([...items, created]);
    return created;
  }

  complete(id) {
    const items = this.read();
    const index = items.findIndex((entry) => entry.id === String(id || ''));
    if (index < 0 || !['task', 'reminder'].includes(items[index].kind)) throw new Error('planner task not found');
    items[index] = { ...items[index], status: 'done', updatedAt: this.now() };
    this.write(items);
    return items[index];
  }

  /** Reminders handed to her reminders list, so one gone from it later has fired. */
  markPushed(ids) {
    const set = new Set(ids);
    if (!set.size) return;
    this.write(this.read().map((entry) => (set.has(entry.id) ? { ...entry, pushed: true } : entry)));
  }
}

/** Her planner's reminders in her reminders list (config.reminders; reminders.js fires them): an open one
 * not there yet goes in (one that came due while she was off too, she says she missed it); one handed over
 * and gone from the list once due has fired, and is done. Gone before it's due is a save race: back in. */
function syncReminders(plans, list, now = Date.now()) {
  const listed = new Set((list || []).map((r) => r.planId).filter(Boolean));
  const add = [];
  const done = [];
  for (const p of plans || []) {
    if (p.kind !== 'reminder' || p.status !== 'open' || listed.has(p.id)) continue;
    if (p.pushed && p.at <= now) done.push(p.id);
    else add.push({ id: `plan-${p.id}`, at: p.at, text: p.title, made: p.createdAt, planId: p.id });
  }
  return { add, done };
}

module.exports = { Planner, KINDS, item, syncReminders };
