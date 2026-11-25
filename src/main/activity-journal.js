'use strict';

// The activity journal (stage 2.9, part 3): what happened during one turn — real pipeline phases, the
// public in-between messages of an agent, and calls of skills, tools, connectors and services — kept
// apart from the messages that go to a model. One turn = one id (the phone's requestId / activityId).
//   - an event is upserted by its key (runId:id); every change bumps the turn's version, so a client
//     that lost the connection asks `since` its last version and gets only what changed;
//   - text is cut and stripped of secrets before it is stored; an isolated turn (private, temporary,
//     18+, anything touching Tor) keeps no names, texts or details and never touches the disk;
//   - a finished turn is written to <dir>/<id>.json (newest MAX_TURNS kept, MAX_AGE_MS at most), so
//     a chat opened again days later still shows its chain.

const fs = require('node:fs');
const path = require('node:path');

const TURN_ID = /^[A-Za-z0-9_-]{8,80}$/;
const MAX_ENTRIES = 160;
const MAX_TURNS = 400;
const MAX_AGE_MS = 30 * 24 * 3600e3;
const LIVE_MS = 15 * 60e3;
const KINDS = new Set(['turn', 'phase', 'thinking', 'message', 'command', 'tool', 'file', 'skill', 'connector', 'service', 'search', 'worker']);
const STATES = new Set(['running', 'awaiting', 'done', 'failed', 'stopped']);

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|AIza|ya29)[-_A-Za-z0-9]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\b(?:password|passwd|pwd|token|secret|api[-_]?key|apikey|authorization|cookie)\s*[:=]\s*["']?[^\s"'&;]{4,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b[0-9a-f]{40,}\b/gi,
  /\b(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]{48,}={0,2}/g,
];
// eslint-disable-next-line no-control-regex
const CONTROL = /\x1b\[[0-9;?]*[ -/]*[@-~]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Text safe to keep and show: no control codes, secrets masked, cut to max (the tail for output). */
function safeText(value, max = 600, { tail = false } = {}) {
  if (typeof value !== 'string' || !value) return '';
  let text = value.replace(CONTROL, '');
  for (const re of SECRET_PATTERNS) text = text.replace(re, '«скрыто»');
  text = text.trim();
  if (text.length <= max) return text;
  return tail ? `…${text.slice(-max)}` : `${text.slice(0, max)}…`;
}

const name = (value) => (typeof value === 'string' && /^[\p{L}\p{N} ._:/@()+-]{1,80}$/u.test(value) ? value : undefined);

/** One event as it is kept: only known fields, everything cut and cleaned. */
function clean(event, { isolated }) {
  const kind = KINDS.has(event?.kind) ? event.kind : null;
  if (!kind) return null;
  const out = { kind, state: STATES.has(event.state) ? event.state : 'done' };
  if (isolated) {
    if (kind === 'phase') out.name = name(event.name);
    return out;
  }
  for (const key of ['name', 'agent', 'group', 'model', 'icon']) {
    const v = name(event[key]);
    if (v) out[key] = v;
  }
  const label = safeText(event.label, 120);
  if (label) out.label = label;
  if (Array.isArray(event.files)) {
    const files = event.files.slice(0, 16).map((f) => name(String(f || '').split(/[\\/]/).slice(-3).join('/'))).filter(Boolean);
    if (files.length) out.files = files;
  }
  if (Number.isFinite(event.added)) out.added = Math.max(0, Math.round(event.added));
  if (Number.isFinite(event.removed)) out.removed = Math.max(0, Math.round(event.removed));
  const text = safeText(event.text, 800);
  if (text) out.text = text;
  const detail = event.detail && typeof event.detail === 'object' ? event.detail : null;
  if (detail) {
    const d = {};
    const tool = safeText(detail.tool, 120);
    const target = safeText(detail.target, 300);
    const command = safeText(detail.command, 600);
    const input = safeText(detail.input, 600);
    const output = safeText(detail.output, 1500, { tail: true });
    if (tool) d.tool = tool;
    if (target) d.target = target;
    if (command) d.command = command;
    if (input) d.input = input;
    if (output) d.output = output;
    if (Number.isInteger(detail.exitCode)) d.exitCode = detail.exitCode;
    if (Object.keys(d).length) out.detail = d;
  }
  const error = safeText(event.error, 300);
  if (error) out.error = error;
  return out;
}

class ActivityJournal {
  constructor({ dir = null, now = () => Date.now() } = {}) {
    this.dir = dir;
    this.now = now;
    this.turns = new Map();
    if (dir) this.prune();
  }

  /** Starts (or continues) a turn. isolated: kept in memory only, without names or texts. */
  begin(id, { isolated = false } = {}) {
    if (!TURN_ID.test(String(id || ''))) return null;
    let turn = this.turns.get(id);
    if (!turn) {
      turn = { id, isolated: Boolean(isolated), version: 0, seq: 0, done: false, entries: new Map(), at: this.now() };
      this.turns.set(id, turn);
    } else if (isolated) turn.isolated = true; // once isolated, always isolated
    this.evict();
    return turn;
  }

  /** Records an event: { key, agent, group, kind, name, state, text, files, detail, error }. */
  add(id, key, event) {
    const turn = this.turns.get(id) || this.begin(id);
    if (!turn || turn.done) return null;
    const cleaned = clean(event, turn);
    if (!cleaned) return null;
    const k = String(key || `e${turn.entries.size}`).slice(0, 160);
    const prev = turn.entries.get(k);
    const entry = { ...(prev || { key: k, at: this.now(), seq: ++turn.seq }), ...cleaned, v: ++turn.version };
    if (prev?.text && !cleaned.text) entry.text = prev.text;
    if (prev?.detail && !cleaned.detail) entry.detail = prev.detail;
    turn.entries.set(k, entry);
    if (turn.entries.size > MAX_ENTRIES) {
      const old = [...turn.entries.values()].find((e) => e.state !== 'running') || turn.entries.values().next().value;
      turn.entries.delete(old.key);
    }
    return entry;
  }

  /** The turn ended: running steps become stopped/failed, a trailing message (the answer itself) goes. */
  finish(id, state = 'done') {
    const turn = this.turns.get(id);
    if (!turn || turn.done) return;
    for (const e of turn.entries.values()) {
      if (e.state === 'running' || e.state === 'awaiting') { e.state = state === 'done' ? 'done' : state; e.v = ++turn.version; }
    }
    const last = [...turn.entries.values()].filter((e) => e.kind !== 'turn').at(-1);
    if (last?.kind === 'message' && state === 'done') turn.entries.delete(last.key);
    turn.done = true;
    turn.state = state;
    turn.version += 1;
    turn.finishedAt = this.now();
    if (!turn.isolated) this.save(turn);
  }

  /** What changed after `since`: { id, version, done, state, entries } — or null when unknown. */
  read(id, since = 0) {
    const turn = this.turns.get(id) || this.load(id);
    if (!turn) return null;
    const after = Number.isFinite(Number(since)) ? Number(since) : 0;
    const entries = [...turn.entries.values()].filter((e) => e.v > after).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    return { id, version: turn.version, done: turn.done, state: turn.state || (turn.done ? 'done' : 'running'), entries };
  }

  file(id) { return this.dir && TURN_ID.test(id) ? path.join(this.dir, `${id}.json`) : null; }

  save(turn) {
    const file = this.file(turn.id);
    if (!file) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const body = { id: turn.id, version: turn.version, state: turn.state, at: turn.at, finishedAt: turn.finishedAt, entries: [...turn.entries.values()] };
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(body));
      fs.renameSync(`${file}.tmp`, file);
    } catch { /* the journal never breaks a turn */ }
  }

  load(id) {
    const file = this.file(id);
    if (!file) return null;
    try {
      const body = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (body.id !== id || !Array.isArray(body.entries)) return null;
      return { id, isolated: false, version: body.version, done: true, state: body.state, entries: new Map(body.entries.map((e) => [e.key, e])) };
    } catch { return null; }
  }

  evict() {
    const now = this.now();
    for (const [id, t] of this.turns) {
      if ((t.done && now - (t.finishedAt || 0) > LIVE_MS) || now - t.at > 6 * 3600e3) this.turns.delete(id);
    }
  }

  prune() {
    try {
      const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'))
        .map((f) => ({ f, t: fs.statSync(path.join(this.dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      const now = this.now();
      files.forEach(({ f, t }, i) => { if (i >= MAX_TURNS || now - t > MAX_AGE_MS) fs.rmSync(path.join(this.dir, f), { force: true }); });
    } catch { /* no folder yet */ }
  }
}

module.exports = { ActivityJournal, safeText, clean, TURN_ID };
