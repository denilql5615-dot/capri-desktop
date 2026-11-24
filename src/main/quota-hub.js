'use strict';

// 2.8a: one place for the plan limits of every cloud model. Each group has its bars (5 hours, week; Argon shares
// the Neon/Hydrogen pool since 2026-11-24), every bar is "remaining %" with its reset time and a micro-label ("Claude 5 часов").
// Sources stay where they are (agent-quotas.js, the Claude status line, the Antigravity status line, the
// web Gemini /usage page); this hub only asks them at their own pace, merges and tells the windows.

const GROUPS = Object.freeze([
  { id: 'claude', label: 'Claude', kinds: ['5h', 'week'] },
  { id: 'codex', label: 'Codex', kinds: ['5h', 'week'] },
  // 2026-11-24: Carbon, Neon, Hydrogen, Argon and Flash share one Antigravity Gemini pool
  { id: 'agy-gemini', label: 'Antigravity Carbon/Neon/Hydrogen/Argon', kinds: ['5h', 'week'] },
  { id: 'agy-third-party', label: 'Antigravity Opus/Sonnet', kinds: ['5h', 'week'] },
  { id: 'web-gemini', label: 'Web Gemini', kinds: ['5h', 'week'] },
]);
const GROUP_BY_ID = new Map(GROUPS.map((g) => [g.id, g]));
const KIND_LABEL = { '5h': '5 часов', week: 'Неделя' };

// How often a source may be asked: cheap ones every minute while their bar is on screen, costly ones less.
const INTERVAL_MS = Object.freeze({
  claude: { shown: 60e3, hidden: 60e3 }, // re-read the file, and poll /usage only when stale
  codex: { shown: 60e3, hidden: 5 * 60e3 }, // a short `codex app-server` call
  agy: { shown: 5 * 60e3, hidden: 15 * 60e3 }, // a short hidden `agy` start (2.8b)
  'web-gemini': { shown: 60e3, hidden: Infinity }, // Usage shares the conversation tab
});
const STALE_MS = 30 * 60e3;

function kindOf(minutes) {
  if (minutes === 300) return '5h';
  if (minutes === 10080) return 'week';
  return null;
}

/** Which bars a chat shows: the group of the cloud model it uses. */
function groupFor(agent, model = '') {
  if (agent === 'claude') return 'claude';
  if (agent === 'codex') return 'codex';
  if (agent === 'gemini-web' || agent === 'web-gemini') return 'web-gemini';
  if (agent === 'gemini' || agent === 'antigravity' || agent === 'agy') {
    if (/claude|opus|sonnet|gpt|oss/i.test(model)) return 'agy-third-party';
    return 'agy-gemini';
  }
  return null;
}

/** Source windows ({remaining, minutes, resetsAt}) as bars of a group, in the group's order. */
function toBars(groupId, windows = [], now = Date.now()) {
  const g = GROUP_BY_ID.get(groupId);
  if (!g) return [];
  const byKind = new Map();
  for (const w of Array.isArray(windows) ? windows : []) {
    const kind = w?.kind || kindOf(Number(w?.minutes));
    if (!kind || !g.kinds.includes(kind)) continue;
    const remaining = Number(w.remaining);
    if (!Number.isFinite(remaining)) continue;
    // resetsAt may come in seconds or milliseconds
    let resetsAt = w.resetsAt == null ? NaN : Number(w.resetsAt);
    if (Number.isFinite(resetsAt) && resetsAt < 1e12) resetsAt *= 1000;
    if (!Number.isFinite(resetsAt)) resetsAt = null;
    const reset = resetsAt !== null && resetsAt <= now; // the window has rolled over since the reading
    byKind.set(kind, {
      kind,
      label: `${g.label} ${groupId === 'web-gemini' && kind === '5h' ? 'Текущий лимит' : KIND_LABEL[kind]}`,
      remaining: reset ? 100 : Math.max(0, Math.min(100, Math.round(remaining * 10) / 10)),
      resetsAt: reset ? null : resetsAt,
      rolledOver: reset,
    });
  }
  return g.kinds.map((k) => byKind.get(k)).filter(Boolean);
}

class QuotaHub {
  /**
   * readers: { claude(), codex(), agy(), webGemini() } — each resolves source data or null:
   *   claude/codex/webGemini → windows [{remaining, minutes|kind, resetsAt}]; agy → { 'agy-gemini': windows, ... }.
   */
  constructor({ readers = {}, now = () => Date.now(), onUpdate = () => {} } = {}) {
    this.readers = readers;
    this.now = now;
    this.onUpdate = onUpdate;
    this.state = new Map(); // group → { windows, checkedAt, source }
    this.lastAsked = new Map(); // source → ms
    this.shown = new Map(); // window → groups on screen
    this.active = new Map(); // scope → groups with running turns or a short linger
    this.pending = new Map(); // source → promise
  }

  /** Live readings (a rate_limit_event in a stream, a status line file): straight in, no asking. */
  push(groupId, windows, source = 'live', checkedAt = this.now()) {
    if (!GROUP_BY_ID.has(groupId) || !Array.isArray(windows) || !windows.length) return false;
    this.state.set(groupId, { windows, checkedAt, source });
    if (groupId === 'web-gemini') this.lastAsked.set(groupId, this.now());
    this.onUpdate(this.snapshot());
    return true;
  }

  /** The windows tell which groups they show, so their sources are asked more often. */
  setShown(groups = [], windowId = 0) {
    const visible = (Array.isArray(groups) ? groups : []).filter((g) => GROUP_BY_ID.has(g));
    if (visible.length) this.shown.set(windowId, visible);
    else this.shown.delete(windowId);
  }

  /** Track overlapping turns on the same quota and keep its bars for six seconds after the last one. */
  track(groupId, scope) {
    if (!GROUP_BY_ID.has(groupId)) return () => {};
    const groups = this.active.get(scope) || new Map();
    this.active.set(scope, groups);
    const entry = groups.get(groupId) || { count: 0, until: Infinity };
    groups.set(groupId, entry);
    clearTimeout(entry.timer);
    entry.count += 1;
    entry.until = Infinity;
    this.onUpdate(this.snapshot());
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      entry.count -= 1;
      if (entry.count) return;
      entry.until = this.now() + 6000;
      entry.timer = setTimeout(() => this.onUpdate(this.snapshot()), 6000);
      entry.timer.unref();
    };
  }

  activity() {
    const now = this.now();
    const out = {};
    for (const [scope, groups] of this.active) {
      for (const [group, { until }] of groups) {
        if (until <= now) groups.delete(group);
      }
      if (groups.size) out[scope] = [...groups.keys()];
      else this.active.delete(scope);
    }
    return out;
  }

  _sourceOf(groupId) {
    return groupId.startsWith('agy-') ? 'agy' : groupId;
  }

  _due(source, force) {
    if (force) return true;
    const interval = INTERVAL_MS[source];
    if (!interval) return false;
    const groups = source === 'agy' ? ['agy-gemini', 'agy-third-party'] : [source];
    const visible = [...this.shown.values(), ...Object.values(this.activity())];
    const shown = visible.some((list) => groups.some((g) => list.includes(g)));
    return this.now() - (this.lastAsked.get(source) || 0) >= (shown ? interval.shown : interval.hidden);
  }

  async _ask(source, force) {
    if (this.pending.has(source)) return this.pending.get(source);
    const reader = this.readers[source === 'web-gemini' ? 'webGemini' : source];
    if (typeof reader !== 'function') return null;
    this.lastAsked.set(source, this.now());
    const p = (async () => {
      let data = null;
      try { data = await reader({ force }); } catch { data = null; }
      if (!data) return false;
      const at = this.now();
      if (source === 'agy') {
        let any = false;
        for (const [g, windows] of Object.entries(data)) {
          if (GROUP_BY_ID.has(g) && Array.isArray(windows) && windows.length) {
            this.state.set(g, { windows, checkedAt: data.checkedAt?.[g] || at, source });
            any = true;
          }
        }
        return any;
      }
      const windows = Array.isArray(data) ? data : data.windows;
      if (!Array.isArray(windows) || !windows.length) return false;
      this.state.set(source, { windows, checkedAt: Number(data.checkedAt) || at, source });
      return true;
    })().finally(() => this.pending.delete(source));
    this.pending.set(source, p);
    return p;
  }

  /** Asks the sources that are due (all of them with force, e.g. when the limits window opens). */
  async refresh({ force = false, groups = null } = {}) {
    const wanted = new Set((groups || GROUPS.map((g) => g.id)).map((g) => this._sourceOf(g)));
    const due = [...wanted].filter((s) => this._due(s, force));
    if (!due.length) return this.snapshot();
    const changed = await Promise.all(due.map((s) => this._ask(s, force)));
    const snap = this.snapshot();
    if (changed.some(Boolean)) this.onUpdate(snap);
    return snap;
  }

  /** Every group with its bars, age and whether it is old; plus the groups at work now. */
  snapshot() {
    const now = this.now();
    const groups = GROUPS.map((g) => {
      const st = this.state.get(g.id);
      const bars = st ? toBars(g.id, st.windows, now) : [];
      return {
        id: g.id,
        label: g.label,
        kinds: g.kinds,
        bars,
        checkedAt: st?.checkedAt || null,
        source: st?.source || null,
        stale: st ? now - st.checkedAt > STALE_MS : true,
      };
    });
    const activity = this.activity();
    return { at: now, groups, active: activity.swarm || [], activity };
  }
}

module.exports = { QuotaHub, GROUPS, groupFor, toBars, kindOf, INTERVAL_MS, STALE_MS };
