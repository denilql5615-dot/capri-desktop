'use strict';

// Her hands on your desktop: a whitelisted subset of the agent-desktop CLI (vercel-labs, Apache-2.0), which
// reads and operates apps through the Windows accessibility tree. Every command is one action through
// policy.js; the model looks (snapshot/find), acts on a ref, then looks again. No clipboard, screenshots,
// raw coordinates, notifications, batches or --force: they are not in the list.
// Ported from GENESIS (app/src/main/actions/desktop.ts).

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const READ = ['snapshot', 'find', 'get', 'list_windows', 'list_apps', 'wait'];
const ACT = ['click', 'set_value', 'type', 'clear', 'select', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'scroll', 'scroll_to', 'press', 'focus_window', 'restore', 'minimize', 'maximize'];
const APP = ['launch', 'close_app'];
const CMDS = [...READ, ...ACT, ...APP];

const REF = /^@[a-z0-9]{1,40}:e\d{1,6}$/i;
const WINDOW = /^w-\d{1,12}$/;
const KEYS = /^[a-z0-9]+(\+[a-z0-9]+){0,3}$/i;
const ROLE = /^[a-z_ -]{1,40}$/i;
const NEEDS_REF = ['get', 'click', 'set_value', 'type', 'clear', 'select', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'scroll', 'scroll_to'];

const str = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max;

/** The request, checked: { ok: true, args } or { ok: false, error } in words the model can fix. */
function validate(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  if (!CMDS.includes(a.cmd)) return { ok: false, error: `cmd must be one of: ${CMDS.join(', ')}` };
  const bad = (k, why) => ({ ok: false, error: `${k}: ${why}` });
  if (a.ref !== undefined && !(typeof a.ref === 'string' && REF.test(a.ref))) return bad('ref', 'a qualified ref like @s8f3k2p9:e5 from the latest snapshot');
  if (a.text !== undefined && !(typeof a.text === 'string' && a.text.length <= 2000)) return bad('text', 'a string up to 2000 characters');
  for (const k of ['app', 'title', 'name']) if (a[k] !== undefined && !str(a[k], 160)) return bad(k, 'a string up to 160 characters');
  if (a.window !== undefined && !(typeof a.window === 'string' && WINDOW.test(a.window))) return bad('window', 'an id like w-204749 from list_windows');
  if (a.keys !== undefined && !(typeof a.keys === 'string' && KEYS.test(a.keys))) return bad('keys', 'like "return", "ctrl+s", "shift+tab"');
  if (a.role !== undefined && !(typeof a.role === 'string' && ROLE.test(a.role))) return bad('role', 'a role name like button');
  if (a.property !== undefined && !['text', 'value', 'title', 'role', 'states'].includes(a.property)) return bad('property', 'text, value, title, role or states');
  if (a.direction !== undefined && !['up', 'down', 'left', 'right'].includes(a.direction)) return bad('direction', 'up, down, left or right');
  if (a.amount !== undefined && !(Number.isInteger(a.amount) && a.amount >= 1 && a.amount <= 20)) return bad('amount', 'a whole number 1–20');
  if (a.ms !== undefined && !(Number.isInteger(a.ms) && a.ms >= 0 && a.ms <= 10000)) return bad('ms', 'a whole number 0–10000');
  const need = (k, why = `${a.cmd} needs "${k}"`) => (a[k] === undefined ? { ok: false, error: why } : null);
  const missing = (NEEDS_REF.includes(a.cmd) && need('ref'))
    || (['set_value', 'type', 'select'].includes(a.cmd) && need('text'))
    || (a.cmd === 'press' && need('keys'))
    || (['launch', 'close_app', 'restore', 'minimize', 'maximize'].includes(a.cmd) && need('app'))
    || (a.cmd === 'focus_window' && !a.app && !a.window && !a.title && { ok: false, error: 'focus_window needs "app", "window" or "title"' })
    || (a.cmd === 'wait' && a.ms === undefined && !a.text && { ok: false, error: 'wait needs "ms" or "text"' });
  if (missing) return missing;
  const args = {};
  for (const k of ['cmd', 'ref', 'text', 'app', 'window', 'title', 'keys', 'role', 'name', 'property', 'direction', 'amount', 'ms']) if (a[k] !== undefined) args[k] = a[k];
  return { ok: true, args };
}

const opt = (k, v) => (v === undefined ? [] : [`--${k}=${v}`]);

/** CLI argv for a checked request. Flags use --k=v and positionals follow "--": model text never parses as a flag. */
function argv(a) {
  const target = [...opt('app', a.app), ...opt('window-id', a.window)];
  const pos = (...p) => ['--', ...p.filter((x) => x !== undefined)];
  switch (a.cmd) {
    case 'snapshot': return ['snapshot', '-i', '--compact', ...target, ...opt('root', a.ref)];
    case 'find': return ['find', ...target, ...opt('role', a.role), ...opt('name', a.name), ...opt('text', a.text), '--limit=30'];
    case 'get': return ['get', ...opt('property', a.property), ...pos(a.ref)];
    case 'list_windows': return ['list-windows', ...opt('app', a.app)];
    case 'list_apps': return ['list-apps', ...opt('app', a.app)];
    case 'wait': return a.text ? ['wait', ...opt('app', a.app), `--text=${a.text}`, '--timeout=10000'] : ['wait', ...pos(String(a.ms))];
    case 'set_value': case 'select': return [a.cmd.replace('_', '-'), ...pos(a.ref, a.text)];
    // keystrokes and focus are physical input on Windows: agent-desktop refuses them headless
    case 'type': return ['--headed', 'type', ...pos(a.ref, a.text)];
    case 'scroll': return ['scroll', ...opt('direction', a.direction), ...opt('amount', a.amount), ...pos(a.ref)];
    case 'press': return ['--headed', 'press', ...opt('app', a.app), ...pos(a.keys.toLowerCase())];
    case 'focus_window': return ['--headed', 'focus-window', ...target, ...opt('title', a.title)];
    case 'restore': case 'minimize': case 'maximize': return [a.cmd, ...target];
    case 'launch': return ['launch', '--activate', ...pos(a.app)];
    case 'close_app': return ['close-app', ...pos(a.app)]; // graceful only: the app may still ask to save
    default: return [a.cmd.replace('_', '-'), ...pos(a.ref)];
  }
}

const DELETE_RE = /удал|стер|очист|корзин|delete|remove|erase|trash|uninstall|format|wipe/i;
const SEND_RE = /отправ|переслать|опубликов|ответить|купить|оплат|заказ|перевест|перевод средств|send|submit|publish|post\b|reply|forward|buy|pay\b|payment|checkout|order|transfer/i;
const INSTALL_RE = /установ|инсталл|install|setup|\.msi\b/i;
const SECRET_RE = /парол|пин-?код|\bpin\b|секрет|токен|cvv|cvc|номер карты|password|passcode|passphrase|secret|token|api.?key|card number/i;

/**
 * The class of one command: { cls, ask? }. READ_ONLY/UI_CONTROL can ride the hour; `ask` (or a higher
 * class) means asked every time: deleting, sending/paying, installing, passwords, closing apps, and
 * elements she hasn't seen in a snapshot. Name-based, so it errs towards asking.
 */
function classify(a, refs) {
  if (READ.includes(a.cmd)) return { cls: 'READ_ONLY' };
  if (a.cmd === 'launch') {
    if (/[\\/:]/.test(a.app) || INSTALL_RE.test(a.app)) return { cls: 'TERMINAL_EXEC', ask: 'запускает программу по пути или установщик' };
    return { cls: 'UI_CONTROL' };
  }
  if (a.cmd === 'close_app') return { cls: 'UI_CONTROL', ask: 'при закрытии можно потерять несохранённое' };
  if (a.cmd === 'press') {
    if (/(^|\+)(delete|del)$/.test(a.keys.toLowerCase())) return { cls: 'DELETE', ask: 'клавиша Delete' };
    return { cls: 'UI_CONTROL' };
  }
  if (!a.ref) return { cls: 'UI_CONTROL' };
  const target = refs.get(a.ref);
  if (!target) return { cls: 'UI_CONTROL', ask: 'элемент, которого я ещё не видела' };
  const label = [target.name, target.role, target.value, ...(target.states || [])].filter(Boolean).join(' ');
  if (['set_value', 'type'].includes(a.cmd)) {
    if (SECRET_RE.test(label) || target.states?.some((s) => /protected|password|secure/i.test(s))) return { cls: 'CREDENTIAL_ACCESS', ask: 'поле пароля или секрета' };
    return { cls: 'UI_CONTROL' };
  }
  const named = `${target.name || ''} ${target.value || ''}`;
  if (DELETE_RE.test(named)) return { cls: 'DELETE', ask: 'похоже на удаление' };
  if (INSTALL_RE.test(named)) return { cls: 'TERMINAL_EXEC', ask: 'похоже на установку программы' };
  if (SEND_RE.test(named)) return { cls: 'NETWORK_SEND', ask: 'похоже на отправку или оплату' };
  return { cls: 'UI_CONTROL' };
}

const q = (s, n = 60) => (s ? `«${s.length > n ? `${s.slice(0, n - 1)}…` : s}»` : '');
const el = (r, ref) => (r ? `${q(r.name) || 'без названия'} (${r.role || 'элемент'})` : ref || '');

/** The question's text: what will happen, in words, with the element as last seen. */
function describe(a, refs) {
  const t = a.ref ? el(refs.get(a.ref), a.ref) : '';
  const where = a.app ? ` в ${a.app}` : '';
  switch (a.cmd) {
    case 'click': return `Нажать ${t}`;
    case 'set_value': case 'type': return `Ввести ${q(a.text, 80)} в ${t}`;
    case 'clear': return `Очистить ${t}`;
    case 'select': return `Выбрать ${q(a.text)} в ${t}`;
    case 'toggle': case 'check': case 'uncheck': return `Переключить ${t}`;
    case 'expand': return `Раскрыть ${t}`;
    case 'collapse': return `Свернуть ${t}`;
    case 'scroll': return `Прокрутить ${a.direction || 'вниз'} в ${t}`;
    case 'scroll_to': return `Прокрутить к ${t}`;
    case 'press': return `Нажать ${a.keys}${where}`;
    case 'focus_window': return `Вывести вперёд ${a.title ? q(a.title) : a.app || a.window}`;
    case 'restore': case 'maximize': return `Развернуть ${a.app}`;
    case 'minimize': return `Свернуть ${a.app}`;
    case 'launch': return `Открыть ${a.app}`;
    case 'close_app': return `Закрыть ${a.app}`;
    default: return `${a.cmd} ${t || a.app || ''}`.trim();
  }
}

const MAX_REFS = 3000;
function remember(refs, n) {
  if (!n.ref_id) return;
  refs.delete(n.ref_id);
  refs.set(n.ref_id, { role: n.role, name: n.name, value: typeof n.value === 'string' ? n.value.slice(0, 200) : undefined, states: n.states });
  while (refs.size > MAX_REFS) refs.delete(refs.keys().next().value);
}
const qe = (s, n = 60) => (s ? `"${s.length > n ? `${s.slice(0, n - 1)}…` : s}"` : '');
const line = (n, depth) => {
  const v = typeof n.value === 'string' && n.value ? ` = ${qe(n.value, 80)}` : '';
  const st = n.states?.length ? ` [${n.states.join(',')}]` : '';
  const more = n.children_count ? ` (+${n.children_count})` : '';
  return `${'  '.repeat(Math.min(depth, 12))}${n.ref_id || '-'} ${n.role || '?'} ${qe(n.name) || ''}${v}${st}${more}`.trimEnd();
};

/** An envelope as compact text for the model, the refs it saw recorded. ~6000 characters at most. */
function digest(env, refs, limit = 6000) {
  if (!env.ok) {
    const e = env.error || {};
    return `${e.code || 'ERROR'}: ${e.message || 'agent-desktop failed'}${e.suggestion ? ` — ${String(e.suggestion).slice(0, 300)}` : ''}`;
  }
  const d = env.data || {};
  const out = [];
  if (d.tree) {
    out.push(`snapshot ${d.snapshot_id || ''} ${d.app || ''}${d.window?.title ? ` — ${qe(d.window.title)}` : ''}`.trim());
    const walk = (n, depth) => {
      remember(refs, n);
      // unnamed containers without a ref only add noise; their children still print
      if (n.ref_id || n.name || n.value) out.push(line(n, depth));
      for (const c of n.children || []) walk(c, n.ref_id || n.name ? depth + 1 : depth);
    };
    walk(d.tree, 0);
  } else if (Array.isArray(d.matches)) {
    for (const m of d.matches) {
      remember(refs, m);
      out.push(line(m, 0));
    }
    if (!d.matches.length) out.push('no matches');
  } else if (Array.isArray(env.data) || Array.isArray(d.apps)) {
    // list_windows / list_apps: one line each instead of bounds and process ids
    const items = Array.isArray(env.data) ? env.data : d.apps;
    const seen = new Set();
    for (const w of items.slice(0, 60)) {
      const s = [w.id, w.app_name || w.name, qe(w.title, 80), w.is_focused ? '[focused]' : '', w.minimized ? '[minimized]' : ''].filter(Boolean).join(' ');
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    if (!items.length) out.push('none');
  } else {
    out.push(JSON.stringify(env.data || {}).slice(0, 1500));
  }
  const text = out.join('\n');
  return text.length > limit ? `${text.slice(0, limit)}\n… (cut: snapshot a smaller part with "ref" as the root)` : text;
}

const BIN = path.join(__dirname, '..', '..', 'vendor', 'agent-desktop', 'agent-desktop.exe').replace('app.asar', 'app.asar.unpacked');

/** The real CLI: one process per command, killed on stop (abort) or after 45 s. */
class Cli {
  constructor(bin = BIN, home = null) {
    this.bin = bin;
    this.home = home;
    this.refs = new Map();
  }

  get installed() {
    return fs.existsSync(this.bin);
  }

  exec(args, signal) {
    return new Promise((resolve) => {
      const env = { ...process.env, ...(this.home && { AGENT_DESKTOP_HOME: this.home }) };
      execFile(this.bin, args, { timeout: 45000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, signal, env }, (err, stdout) => {
        const raw = String(stdout || '').trim();
        try {
          return resolve(JSON.parse(raw.slice(raw.indexOf('{'))));
        } catch {
          // not JSON: said below
        }
        const why = signal?.aborted ? 'stopped' : err?.code === 'ENOENT' ? 'agent-desktop is not installed' : err?.message || 'no output';
        resolve({ ok: false, error: { code: 'CAPRI_EXEC', message: why } });
      });
    });
  }
}

module.exports = { CMDS, READ, validate, argv, classify, describe, digest, Cli, BIN };
