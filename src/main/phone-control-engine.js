'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { safeText } = require('./activity-journal');

const DEFAULT_DEVICE_NAME = 'Xiaomi 13T Pro';
const DEFAULT_ANDROID_VERSION = '16';
const ONLINE_TTL_MS = 5 * 60 * 1000;
const ACTION_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_ACTIONS = 20;
const MAX_DISPATCHED_META = 50;

const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;
const VALID_PHONE_RE = /^[+0-9*#() .-]{2,32}$/;
const VALID_MODULE_STATUSES = new Set([
  'ready',
  'connected',
  'installed',
  'needs_setup',
  'missing',
  'offline',
  'unknown',
]);
const CONFIRM_REQUIRED_ACTIONS = new Set(['dial', 'sms']);
// 2.95b: the PC's hands in Termux. Read-only diagnostics run at once; anything else (or any chain,
// redirect or substitution) waits for an explicit confirmation, like a call or an SMS.
const TERMUX_SAFE = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'uname', 'whoami', 'id', 'date', 'uptime',
  'df', 'du', 'free', 'ps', 'pgrep', 'ip', 'ifconfig', 'ping', 'nslookup', 'dig', 'getprop', 'which', 'echo', 'nproc',
  'termux-battery-status', 'termux-wifi-connectioninfo', 'termux-telephony-deviceinfo']);
const TERMUX_UNSAFE_CHARS = /[;&|><`]|\$\(|\n/;
const TERMUX_JOB_TTL_MS = 10 * 60 * 1000;
const MAX_TERMUX_RESULTS = 50;
function termuxSafe(command) {
  if (TERMUX_UNSAFE_CHARS.test(command)) return false;
  const first = command.trim().split(/\s+/)[0];
  if (first === 'ping') return /\s-c\s*\d{1,2}\b/.test(command); // a bounded ping only
  return TERMUX_SAFE.has(first);
}

const PHONE_MODULES_CATALOG = Object.freeze([
  Object.freeze({
    id: 'phone-health',
    name: 'Health Connect',
    actions: Object.freeze(['sync', 'open']),
    privacySafe: true,
    confirmRequired: false,
    url: '',
    description: 'Локальный сон, шаги и пульс с Android 16 (без облаков)',
  }),
  Object.freeze({
    id: 'phone-shizuku',
    name: 'Shizuku',
    actions: Object.freeze(['check', 'open']),
    privacySafe: true,
    confirmRequired: false,
    url: '',
    description: 'Системный API Android без root для управления приложениями',
  }),
  Object.freeze({
    id: 'phone-habits',
    name: 'Loop Habits',
    actions: Object.freeze(['open']),
    privacySafe: true,
    confirmRequired: false,
    url: '',
    description: 'Офлайн-трекер привычек и локальный экспорт',
  }),
  Object.freeze({
    id: 'phone-maps',
    name: 'Organic Maps',
    actions: Object.freeze(['navigate', 'open']),
    privacySafe: true,
    confirmRequired: false,
    url: '',
    description: 'Офлайн-навигация и маршруты geo:',
  }),
  Object.freeze({
    id: 'phone-fossify',
    name: 'Fossify (Звонки и SMS)',
    actions: Object.freeze(['dial', 'sms', 'open']),
    confirmRequired: true,
    privacySafe: true,
    url: '',
    description: 'Звонки и SMS только через подтверждение',
  }),
  Object.freeze({
    id: 'phone-wger',
    name: 'Wger Тренировки',
    actions: Object.freeze(['open']),
    privacySafe: true,
    confirmRequired: false,
    url: 'http://192.168.0.107:8085',
    description: 'Тренировки и питание с сервером .107:8085',
  }),
  Object.freeze({
    id: 'phone-fmd',
    name: 'Find My Device',
    actions: Object.freeze(['locate', 'open']),
    privacySafe: true,
    confirmRequired: false,
    url: 'http://192.168.0.107:8083',
    description: 'Поиск и прозвон телефона через .107:8083',
  }),
  Object.freeze({
    id: 'phone-termux',
    name: 'Termux + TermuxHub',
    actions: Object.freeze(['open', 'run']),
    privacySafe: true,
    confirmRequired: false,
    url: '',
    description: 'Локальный Linux-терминал на телефоне; run — команда с ПК, вывод возвращается (2.95b)',
  }),
]);

const CATALOG_BY_ID = new Map(PHONE_MODULES_CATALOG.map((m) => [m.id, m]));

function sanitizeText(value, maxLen = 160) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function toBoundedNumber(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

function normalizeHealthSummary(raw, fallbackIso) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { summary: null, hasNumeric: false };
  }
  const steps = toBoundedNumber(raw.steps, 0, 200000);
  const sleepHours = toBoundedNumber(raw.sleepHours, 0, 24);
  const avgHr = toBoundedNumber(raw.avgHr ?? raw.heartRate, 25, 240);
  const restingHr = toBoundedNumber(raw.restingHr, 25, 200);
  // 2.7d: HRV, SpO2, calories, distance and weight from Health Connect.
  const hrvMs = toBoundedNumber(raw.hrvMs, 1, 400);
  const spo2 = toBoundedNumber(raw.spo2, 50, 100);
  const activeKcal = toBoundedNumber(raw.activeKcal, 0, 20000);
  const totalKcal = toBoundedNumber(raw.totalKcal, 0, 30000);
  const distanceKm = toBoundedNumber(raw.distanceKm, 0, 500);
  const weightKg = toBoundedNumber(raw.weightKg, 20, 400);
  const workouts = Array.isArray(raw.workouts)
    ? raw.workouts.slice(0, 20).map((w) => ({
      title: sanitizeText(w?.title || w?.type || 'Тренировка', 80) || 'Тренировка',
      type: w?.type ? sanitizeText(w.type, 40) : null,
      minutes: toBoundedNumber(w?.minutes ?? w?.durationMin, 0, 1440),
      kcal: toBoundedNumber(w?.kcal ?? w?.calories, 0, 10000),
      distanceKm: toBoundedNumber(w?.distanceKm, 0, 500),
      at: w?.at ? sanitizeText(w.at, 32) : null,
    }))
    : [];

  const hasNumeric = [steps, sleepHours, avgHr, restingHr, hrvMs, spo2, activeKcal, totalKcal, distanceKm, weightKg]
    .some((v) => v !== null)
    || workouts.some((w) => w.minutes !== null || w.kcal !== null);

  if (!hasNumeric) {
    return { summary: null, hasNumeric: false };
  }

  return {
    hasNumeric: true,
    summary: {
      steps,
      sleepHours,
      avgHr,
      restingHr,
      hrvMs,
      spo2,
      activeKcal,
      totalKcal,
      distanceKm,
      weightKg,
      workouts,
      notes: sanitizeText(raw.notes || '', 300),
      source: sanitizeText(raw.source || 'health-connect', 60) || 'health-connect',
      updatedAt: sanitizeText(raw.updatedAt || fallbackIso, 40) || fallbackIso,
    },
  };
}

function normalizeModuleEntry(entry, syncedIso) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const rawStatus = sanitizeText(entry.status || '', 32).toLowerCase();
  const statusHint = VALID_MODULE_STATUSES.has(rawStatus) ? rawStatus : '';
  const installed = typeof entry.installed === 'boolean'
    ? entry.installed
    : (statusHint === 'ready' || statusHint === 'connected' || statusHint === 'installed' || statusHint === 'needs_setup');
  const ready = typeof entry.ready === 'boolean'
    ? entry.ready
    : (statusHint === 'ready' || statusHint === 'connected' || (installed && !statusHint));
  const status = statusHint === 'connected'
    ? 'ready'
    : (statusHint || (ready ? 'ready' : (installed ? 'needs_setup' : 'missing')));
  const detail = sanitizeText(entry.detail || '', 160);
  const updatedAt = sanitizeText(entry.updatedAt || syncedIso, 40) || syncedIso;
  return { status, installed: Boolean(installed || ready), ready: Boolean(ready), detail, updatedAt };
}

function normalizeModulesInput(rawModules, syncedIso) {
  const out = {};
  if (!rawModules) return out;
  if (Array.isArray(rawModules)) {
    for (const item of rawModules) {
      const id = sanitizeText(item?.id || item?.moduleId || '', 64);
      if (!CATALOG_BY_ID.has(id)) continue;
      const normalized = normalizeModuleEntry(item, syncedIso);
      if (normalized) out[id] = normalized;
    }
    return out;
  }
  if (typeof rawModules === 'object') {
    for (const [id, entry] of Object.entries(rawModules)) {
      if (!CATALOG_BY_ID.has(id)) continue;
      const normalized = normalizeModuleEntry(entry, syncedIso);
      if (normalized) out[id] = normalized;
    }
  }
  return out;
}

class PhoneControlEngine {
  constructor(opts = {}) {
    this.statePath = opts.statePath
      || (opts.userDataDir ? path.join(opts.userDataDir, 'phone-control-state.json') : null);
    this.onHealthSummary = typeof opts.onHealthSummary === 'function' ? opts.onHealthSummary : null;
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.onlineTtlMs = Number.isFinite(Number(opts.onlineTtlMs)) ? Number(opts.onlineTtlMs) : ONLINE_TTL_MS;
    this.actionTtlMs = Number.isFinite(Number(opts.actionTtlMs)) ? Number(opts.actionTtlMs) : ACTION_TTL_MS;
    this.maxQueue = Number.isFinite(Number(opts.maxQueue)) ? Math.max(1, Number(opts.maxQueue)) : MAX_PENDING_ACTIONS;

    this.state = {
      deviceName: DEFAULT_DEVICE_NAME,
      androidVersion: DEFAULT_ANDROID_VERSION,
      syncedAt: null,
      syncedAtMs: 0,
      modules: {},
      healthSummary: null,
    };
    this.pendingActions = [];
    this.dispatchedMeta = new Map();
    this.termuxJobs = []; // taken by the Termux worker itself (capri_brain.py), not by the Altair app
    this.termuxResults = new Map();
    this.lastAction = null;

    this._loadPersistedState();
  }

  _loadPersistedState() {
    if (!this.statePath) return;
    try {
      if (!fs.existsSync(this.statePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const syncedAt = sanitizeText(raw.syncedAt || '', 40) || null;
      const parsedMs = syncedAt ? Date.parse(syncedAt) : 0;
      const syncedAtMs = Number.isFinite(parsedMs) && parsedMs > 0 ? parsedMs : 0;
      this.state = {
        deviceName: sanitizeText(raw.deviceName || DEFAULT_DEVICE_NAME, 80) || DEFAULT_DEVICE_NAME,
        androidVersion: sanitizeText(raw.androidVersion || DEFAULT_ANDROID_VERSION, 32) || DEFAULT_ANDROID_VERSION,
        syncedAt,
        syncedAtMs,
        modules: normalizeModulesInput(raw.modules, syncedAt || ''),
        healthSummary: normalizeHealthSummary(raw.healthSummary, syncedAt || '').summary,
      };
    } catch {
      // Ignore corrupt or unreadable persisted status snapshot
    }
  }

  _persistNonSensitiveState() {
    if (!this.statePath) return;
    const safeSnapshot = {
      deviceName: this.state.deviceName,
      androidVersion: this.state.androidVersion,
      syncedAt: this.state.syncedAt,
      modules: this.state.modules,
      healthSummary: this.state.healthSummary,
    };
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(safeSnapshot, null, 2), 'utf8');
    } catch {
      // Non-fatal persistence error
    }
  }

  _prunePendingActions(nowMs = this._now()) {
    if (!this.pendingActions.length) return;
    this.pendingActions = this.pendingActions.filter(
      (item) => (nowMs - item.createdAtMs) <= this.actionTtlMs,
    );
  }

  _buildStatus(nowMs = this._now()) {
    this._prunePendingActions(nowMs);
    const online = this.state.syncedAtMs > 0 && (nowMs - this.state.syncedAtMs) <= this.onlineTtlMs;
    const modules = PHONE_MODULES_CATALOG.map((mod) => {
      const saved = this.state.modules[mod.id] || null;
      const ready = Boolean(saved?.ready);
      const installed = Boolean(saved?.installed || ready);
      const status = saved?.status || (mod.url ? 'ready' : 'offline');
      const detail = saved?.detail || (
        online
          ? (ready ? 'Готов' : 'Не настроен')
          : (mod.url ? `Сервер ${mod.url}` : 'Ожидание синхронизации с телефоном')
      );
      return {
        id: mod.id,
        name: mod.name,
        description: mod.description,
        actions: [...mod.actions],
        privacySafe: Boolean(mod.privacySafe),
        confirmRequired: Boolean(mod.confirmRequired),
        url: mod.url || '',
        status,
        installed,
        ready,
        detail,
        updatedAt: saved?.updatedAt || null,
      };
    });

    const readyCount = modules.filter((m) => m.ready).length;
    return {
      online,
      deviceName: this.state.deviceName,
      androidVersion: this.state.androidVersion,
      syncedAt: this.state.syncedAt,
      modules,
      readyCount,
      totalCount: PHONE_MODULES_CATALOG.length,
      healthSummary: this.state.healthSummary ? { ...this.state.healthSummary } : null,
      pendingCount: this.pendingActions.length,
      ...(this.lastAction && { lastAction: { ...this.lastAction } }),
    };
  }

  getStatus() {
    return this._buildStatus(this._now());
  }

  updateState(snapshot = {}) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return { ok: false, error: 'Некорректный снимок состояния телефона.' };
    }
    const nowMs = this._now();
    const syncedIso = new Date(nowMs).toISOString();
    const nextDevice = sanitizeText(snapshot.deviceName, 80);
    const nextAndroid = sanitizeText(snapshot.androidVersion, 32);

    if (nextDevice) this.state.deviceName = nextDevice;
    if (nextAndroid) this.state.androidVersion = nextAndroid;
    this.state.syncedAt = syncedIso;
    this.state.syncedAtMs = nowMs;

    if (snapshot.modules !== undefined) {
      const normalizedModules = normalizeModulesInput(snapshot.modules, syncedIso);
      this.state.modules = {
        ...this.state.modules,
        ...normalizedModules,
      };
    }

    if (snapshot.healthSummary !== undefined) {
      const { summary, hasNumeric } = normalizeHealthSummary(snapshot.healthSummary, syncedIso);
      if (hasNumeric && summary) {
        this.state.healthSummary = summary;
        if (this.onHealthSummary) {
          try {
            Promise.resolve(this.onHealthSummary(summary)).catch(() => {});
          } catch {
            // Keep state sync resilient if callback throws synchronously
          }
        }
      }
    }

    this._persistNonSensitiveState();
    return { ok: true, status: this._buildStatus(nowMs) };
  }

  _sanitizeActionPayload(mod, action, rawPayload) {
    const src = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload : {};

    if (action === 'dial' || action === 'sms') {
      const rawPhone = src.phone ?? src.number ?? src.to ?? '';
      const phone = sanitizeText(rawPhone, 32);
      const digitCount = (phone.match(/\d/g) || []).length;
      if (!phone || digitCount < 2 || !VALID_PHONE_RE.test(phone)) {
        return { ok: false, error: 'Укажи корректный номер телефона (только цифры и +() -).' };
      }
      if (action === 'sms') {
        const text = sanitizeText(src.text ?? src.body ?? src.message ?? '', 500);
        return { ok: true, payload: text ? { phone, text } : { phone } };
      }
      return { ok: true, payload: { phone } };
    }

    if (mod.id === 'phone-maps' && action === 'navigate') {
      const query = sanitizeText(src.query ?? src.destination ?? src.address ?? src.geo ?? '', 200);
      const lat = toBoundedNumber(src.lat, -90, 90);
      const lon = toBoundedNumber(src.lon, -180, 180);
      if (!query && (lat === null || lon === null)) {
        return { ok: false, error: 'Укажи адрес, место или координаты для маршрута.' };
      }
      const payload = {};
      if (query) payload.query = query;
      if (lat !== null && lon !== null) {
        payload.lat = lat;
        payload.lon = lon;
      }
      return { ok: true, payload };
    }

    const clean = {};
    for (const [k, v] of Object.entries(src).slice(0, 5)) {
      const key = sanitizeText(k, 32);
      if (!key) continue;
      if (typeof v === 'string') clean[key] = sanitizeText(v, 160);
      else if (typeof v === 'number' && Number.isFinite(v)) clean[key] = v;
      else if (typeof v === 'boolean') clean[key] = v;
    }
    return { ok: true, payload: clean };
  }

  queueAction({ moduleId, action, payload, confirmed } = {}) {
    const id = sanitizeText(moduleId, 64);
    const mod = CATALOG_BY_ID.get(id);
    if (!mod) {
      return { ok: false, error: 'Неизвестный модуль телефона.' };
    }

    const act = sanitizeText(action, 32).toLowerCase();
    if (!act || !mod.actions.includes(act)) {
      return { ok: false, error: `Недопустимое действие "${act || ''}" для модуля ${mod.name}.` };
    }

    if (CONFIRM_REQUIRED_ACTIONS.has(act) && confirmed !== true) {
      return {
        ok: false,
        confirmRequired: true,
        moduleId: mod.id,
        action: act,
        error: act === 'dial'
          ? 'Звонок через Fossify требует явного подтверждения.'
          : 'Отправка SMS через Fossify требует явного подтверждения.',
      };
    }

    if (mod.id === 'phone-termux' && act === 'run') return this._queueTermux(payload, confirmed === true);

    const sanitized = this._sanitizeActionPayload(mod, act, payload);
    if (!sanitized.ok) {
      return { ok: false, moduleId: mod.id, action: act, error: sanitized.error };
    }

    if ((mod.id === 'phone-wger' || mod.id === 'phone-fmd') && act === 'open' && mod.url) {
      return {
        ok: true,
        moduleId: mod.id,
        action: act,
        url: mod.url,
        openUrl: mod.url,
        message: `Открытие ${mod.name}: ${mod.url}`,
      };
    }

    const nowMs = this._now();
    this._prunePendingActions(nowMs);
    while (this.pendingActions.length >= this.maxQueue) {
      this.pendingActions.shift();
    }

    const entry = {
      id: crypto.randomUUID(),
      moduleId: mod.id,
      action: act,
      payload: sanitized.payload,
      createdAt: new Date(nowMs).toISOString(),
      createdAtMs: nowMs,
    };
    this.pendingActions.push(entry);

    return {
      ok: true,
      queued: true,
      actionId: entry.id,
      item: {
        id: entry.id,
        moduleId: entry.moduleId,
        action: entry.action,
        payload: { ...entry.payload },
        createdAt: entry.createdAt,
      },
      ...(mod.url && { url: mod.url, openUrl: mod.url }),
      pendingCount: this.pendingActions.length,
      message: `Команда "${act}" для ${mod.name} поставлена в очередь.`,
    };
  }

  _queueTermux(payload, confirmed) {
    const src = payload && typeof payload === 'object' ? payload : {};
    const command = String(src.command ?? '').replace(/\r/g, '').trim().slice(0, 2000);
    if (!command) return { ok: false, moduleId: 'phone-termux', action: 'run', error: 'Пустая команда для Termux.' };
    if (!termuxSafe(command) && !confirmed) {
      return { ok: false, confirmRequired: true, moduleId: 'phone-termux', action: 'run', command,
        error: 'Эта команда в Termux меняет телефон или выходит за чтение — нужна явная команда подтверждения.' };
    }
    const nowMs = this._now();
    this.termuxJobs = this.termuxJobs.filter((j) => nowMs - j.createdAtMs < TERMUX_JOB_TTL_MS).slice(-(this.maxQueue - 1));
    const timeoutSec = Math.min(300, Math.max(5, Number(src.timeoutSec) || 60));
    const job = { id: crypto.randomUUID(), command, timeoutSec, createdAtMs: nowMs };
    this.termuxJobs.push(job);
    this._rememberTermux(job.id, { state: 'queued', command });
    return { ok: true, queued: true, moduleId: 'phone-termux', action: 'run', actionId: job.id,
      message: 'Команда передана в Termux; результат — по actionId.' };
  }

  /** The Termux worker asks for its next job (GET /termux/next). */
  nextTermuxJob() {
    const nowMs = this._now();
    this.termuxJobs = this.termuxJobs.filter((j) => nowMs - j.createdAtMs < TERMUX_JOB_TTL_MS);
    const job = this.termuxJobs.shift();
    if (!job) return null;
    this._rememberTermux(job.id, { state: 'running', command: job.command });
    return { id: job.id, command: job.command, timeoutSec: job.timeoutSec };
  }

  /** The worker's answer (POST /termux/result): output cut and masked before it is kept. */
  reportTermuxResult({ id, exitCode, stdout, stderr, error } = {}) {
    const key = sanitizeText(id, 64);
    const prev = this.termuxResults.get(key);
    if (!prev) return { ok: false, error: 'Неизвестное задание Termux.' };
    this._rememberTermux(key, {
      state: 'done', command: prev.command,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      stdout: safeText(String(stdout ?? ''), 4000, { tail: true }),
      stderr: safeText(String(stderr ?? ''), 2000, { tail: true }),
      ...(error && { error: safeText(String(error), 300) }),
    });
    return { ok: true };
  }

  termuxResult(id) {
    return this.termuxResults.get(sanitizeText(id, 64)) || { state: 'missing' };
  }

  _rememberTermux(id, value) {
    this.termuxResults.set(id, { ...value, at: new Date(this._now()).toISOString() });
    while (this.termuxResults.size > MAX_TERMUX_RESULTS) this.termuxResults.delete(this.termuxResults.keys().next().value);
  }

  drainPendingActions() {
    const nowMs = this._now();
    this._prunePendingActions(nowMs);
    if (!this.pendingActions.length) return [];

    const drained = this.pendingActions.map((entry) => {
      if (this.dispatchedMeta.size >= MAX_DISPATCHED_META) {
        const oldestKey = this.dispatchedMeta.keys().next().value;
        if (oldestKey) this.dispatchedMeta.delete(oldestKey);
      }
      this.dispatchedMeta.set(entry.id, {
        id: entry.id,
        moduleId: entry.moduleId,
        action: entry.action,
        dispatchedAt: new Date(nowMs).toISOString(),
      });
      return {
        id: entry.id,
        moduleId: entry.moduleId,
        action: entry.action,
        payload: { ...entry.payload },
        createdAt: entry.createdAt,
      };
    });
    this.pendingActions = [];
    return drained;
  }

  reportActionResult({ actionId, ok, message } = {}) {
    const cleanId = sanitizeText(actionId, 64);
    if (!cleanId) {
      return { ok: false, error: 'Не указан actionId.' };
    }
    const meta = this.dispatchedMeta.get(cleanId) || null;
    const nowIso = new Date(this._now()).toISOString();
    this.lastAction = {
      actionId: cleanId,
      moduleId: meta?.moduleId || null,
      action: meta?.action || null,
      ok: Boolean(ok),
      message: sanitizeText(message || (ok ? 'Выполнено' : 'Ошибка выполнения'), 240),
      at: nowIso,
    };
    return { ok: true, lastAction: { ...this.lastAction } };
  }
}

module.exports = {
  PhoneControlEngine,
  PHONE_MODULES_CATALOG,
  ONLINE_TTL_MS,
  ACTION_TTL_MS,
  MAX_PENDING_ACTIONS,
};
