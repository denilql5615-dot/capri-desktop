'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PhoneControlEngine,
  PHONE_MODULES_CATALOG,
} = require('../src/main/phone-control-engine');
const { ConnectorsEngine } = require('../src/main/connectors-engine');
const { SlashCommandEngine, BUILTIN_COMMANDS } = require('../src/main/slash-commands');
const { PhoneBridge } = require('../src/main/phone');

test('PHONE_MODULES_CATALOG defines exact 8 privacy-safe modules with expected URLs and actions', () => {
  assert.equal(PHONE_MODULES_CATALOG.length, 8);
  assert.deepEqual(
    PHONE_MODULES_CATALOG.map((m) => m.id),
    [
      'phone-health',
      'phone-shizuku',
      'phone-habits',
      'phone-maps',
      'phone-fossify',
      'phone-wger',
      'phone-fmd',
      'phone-termux',
    ],
  );

  const byId = new Map(PHONE_MODULES_CATALOG.map((m) => [m.id, m]));
  for (const mod of PHONE_MODULES_CATALOG) {
    assert.equal(mod.privacySafe, true, `${mod.id} must be privacySafe`);
    assert.ok(Array.isArray(mod.actions) && mod.actions.length > 0);
    assert.ok(mod.description.length > 5);
  }
  assert.deepEqual(byId.get('phone-health').actions, ['sync', 'open']);
  assert.deepEqual(byId.get('phone-shizuku').actions, ['check', 'open']);
  assert.deepEqual(byId.get('phone-habits').actions, ['open']);
  assert.deepEqual(byId.get('phone-maps').actions, ['navigate', 'open']);
  assert.deepEqual(byId.get('phone-fossify').actions, ['dial', 'sms', 'open']);
  assert.equal(byId.get('phone-fossify').confirmRequired, true);
  assert.equal(byId.get('phone-wger').url, 'http://192.168.0.107:8085');
  assert.equal(byId.get('phone-fmd').url, 'http://192.168.0.107:8083');
  assert.deepEqual(byId.get('phone-fmd').actions, ['locate', 'open']);
  assert.deepEqual(byId.get('phone-termux').actions, ['open', 'run']);
});

test('PhoneControlEngine tracks 5m online window, persists non-sensitive state only, and forwards healthSummary to ConnectorsEngine', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-phone-ctrl-'));
  const statePath = path.join(tmpDir, 'phone-control-state.json');
  let nowMs = Date.UTC(2026, 10, 23, 12, 0, 0);

  try {
    const connectors = new ConnectorsEngine({ userDataDir: tmpDir });
    const engine = new PhoneControlEngine({
      statePath,
      now: () => nowMs,
      onHealthSummary: (summary) => connectors.saveHealthSummary(summary),
    });

    const initial = engine.getStatus();
    assert.equal(initial.online, false);
    assert.equal(initial.totalCount, 8);
    assert.equal(initial.readyCount, 0);
    assert.equal(initial.modules.length, 8);

    // Queue sensitive dial & sms actions before persisting state
    const dialQueued = engine.queueAction({
      moduleId: 'phone-fossify',
      action: 'dial',
      payload: { phone: '+7 999 123-45-67' },
      confirmed: true,
    });
    assert.equal(dialQueued.ok, true);

    const smsQueued = engine.queueAction({
      moduleId: 'phone-fossify',
      action: 'sms',
      payload: { phone: '+7 999 765-43-21', text: 'Секретное сообщение' },
      confirmed: true,
    });
    assert.equal(smsQueued.ok, true);

    // Non-numeric healthSummary should not trigger ConnectorsEngine save
    engine.updateState({
      deviceName: 'Xiaomi 13T Pro',
      androidVersion: '16',
      healthSummary: { notes: 'no numbers' },
    });
    assert.equal(fs.existsSync(connectors.healthSummaryFile()), false);

    // Real numeric healthSummary + module status update
    const updated = engine.updateState({
      deviceName: 'Xiaomi 13T Pro',
      androidVersion: '16',
      modules: [
        { id: 'phone-health', installed: true, ready: true, detail: 'Zepp Life подключён' },
        { id: 'phone-shizuku', installed: true, ready: false, status: 'needs_setup', detail: 'Запустите сервис' },
        { id: 'phone-wger', installed: true, ready: true, detail: '.107:8085' },
        { id: 'unknown-module', installed: true, ready: true },
      ],
      healthSummary: { steps: 9320, sleepHours: 7.5, avgHr: 66 },
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.status.online, true);
    assert.equal(updated.status.readyCount, 2);
    assert.equal(updated.status.totalCount, 8);
    assert.equal(updated.status.healthSummary.steps, 9320);
    assert.equal(updated.status.pendingCount, 2);

    // ConnectorsEngine received healthSummary automatically
    assert.equal(fs.existsSync(connectors.healthSummaryFile()), true);
    const savedHealth = JSON.parse(fs.readFileSync(connectors.healthSummaryFile(), 'utf8'));
    assert.equal(savedHealth.steps, 9320);
    assert.equal(savedHealth.sleepHours, 7.5);
    assert.equal(savedHealth.avgHr, 66);

    // Persisted phone-control-state.json must NEVER contain phone numbers, SMS bodies, or pendingActions
    const persistedRaw = fs.readFileSync(statePath, 'utf8');
    assert.equal(persistedRaw.includes('999'), false);
    assert.equal(persistedRaw.includes('Секретное сообщение'), false);
    assert.equal(persistedRaw.includes('pendingActions'), false);
    assert.equal(persistedRaw.includes('unknown-module'), false);

    // Reload from disk with fresh instance
    const reloaded = new PhoneControlEngine({ statePath, now: () => nowMs });
    const reloadedStatus = reloaded.getStatus();
    assert.equal(reloadedStatus.online, true);
    assert.equal(reloadedStatus.readyCount, 2);
    assert.equal(reloadedStatus.pendingCount, 0);
    assert.equal(reloadedStatus.healthSummary.steps, 9320);

    // Advance 6 minutes -> online drops to false
    nowMs += 6 * 60 * 1000;
    assert.equal(reloaded.getStatus().online, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PhoneControlEngine enforces allowlist, confirmRequired on dial/sms, sanitization, queue cap (20) & TTL (5m)', () => {
  let nowMs = Date.UTC(2026, 10, 23, 12, 0, 0);
  const engine = new PhoneControlEngine({ now: () => nowMs });

  // Unknown module & disallowed action
  assert.equal(engine.queueAction({ moduleId: 'phone-evil', action: 'open' }).ok, false);
  assert.equal(engine.queueAction({ moduleId: 'phone-habits', action: 'dial' }).ok, false);

  // Confirm guard on dial and sms
  const dialBlocked = engine.queueAction({
    moduleId: 'phone-fossify',
    action: 'dial',
    payload: { phone: '+79991112233' },
  });
  assert.equal(dialBlocked.ok, false);
  assert.equal(dialBlocked.confirmRequired, true);
  assert.ok(dialBlocked.error);

  const smsBlocked = engine.queueAction({
    moduleId: 'phone-fossify',
    action: 'sms',
    payload: { phone: '+79991112233', text: 'Привет' },
    confirmed: false,
  });
  assert.equal(smsBlocked.ok, false);
  assert.equal(smsBlocked.confirmRequired, true);
  assert.ok(smsBlocked.error);

  // Fossify open does not require confirm
  const fossifyOpen = engine.queueAction({ moduleId: 'phone-fossify', action: 'open' });
  assert.equal(fossifyOpen.ok, true);

  // Sanitization rejects invalid phone and cleans control chars
  const badPhone = engine.queueAction({
    moduleId: 'phone-fossify',
    action: 'dial',
    payload: { phone: 'rm -rf /' },
    confirmed: true,
  });
  assert.equal(badPhone.ok, false);

  const cleanPhone = engine.queueAction({
    moduleId: 'phone-fossify',
    action: 'dial',
    payload: { phone: '+7 999\r\n111-22-33\u0000' },
    confirmed: true,
  });
  assert.equal(cleanPhone.ok, true);
  assert.equal(cleanPhone.item.payload.phone, '+7 999 111-22-33');

  // Geo query sanitization (length cap 200, no control chars, empty rejected)
  const emptyGeo = engine.queueAction({
    moduleId: 'phone-maps',
    action: 'navigate',
    payload: { query: '\u0000\r\n  ' },
  });
  assert.equal(emptyGeo.ok, false);

  const longGeo = engine.queueAction({
    moduleId: 'phone-maps',
    action: 'navigate',
    payload: { query: `Казань\n${'А'.repeat(250)}` },
  });
  assert.equal(longGeo.ok, true);
  assert.equal(longGeo.item.payload.query.length, 200);
  assert.equal(/[\r\n\u0000]/.test(longGeo.item.payload.query), false);

  // wger / fmd open returns URL directly without queuing
  const wgerOpen = engine.queueAction({ moduleId: 'phone-wger', action: 'open' });
  assert.equal(wgerOpen.ok, true);
  assert.equal(wgerOpen.url, 'http://192.168.0.107:8085');

  const fmdOpen = engine.queueAction({ moduleId: 'phone-fmd', action: 'open' });
  assert.equal(fmdOpen.ok, true);
  assert.equal(fmdOpen.url, 'http://192.168.0.107:8083');

  // Drain clears queue
  const drained1 = engine.drainPendingActions();
  assert.equal(drained1.length, 3);
  assert.deepEqual(engine.drainPendingActions(), []);

  // Report action result records lastAction
  const resReport = engine.reportActionResult({
    actionId: cleanPhone.actionId,
    ok: true,
    message: 'Набор открыт',
  });
  assert.equal(resReport.ok, true);
  assert.equal(resReport.lastAction.moduleId, 'phone-fossify');
  assert.equal(resReport.lastAction.action, 'dial');
  assert.equal(engine.getStatus().lastAction.message, 'Набор открыт');

  // Queue cap (max 20)
  for (let i = 0; i < 25; i += 1) {
    const q = engine.queueAction({ moduleId: 'phone-health', action: 'sync', payload: { seq: i } });
    assert.equal(q.ok, true);
  }
  assert.equal(engine.getStatus().pendingCount, 20);

  // TTL 5 minutes prunes expired actions
  nowMs += 5 * 60 * 1000 + 1;
  assert.equal(engine.getStatus().pendingCount, 0);
  assert.deepEqual(engine.drainPendingActions(), []);
});

test('/phone slash command, PhoneBridge endpoints, and IPC contracts in main.js & preload.js', async () => {
  assert.equal(BUILTIN_COMMANDS.length, 67);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-phone-bridge-'));
  try {
    const connectors = new ConnectorsEngine({ userDataDir: tmpDir });
    const phoneControl = new PhoneControlEngine({
      statePath: path.join(tmpDir, 'phone-control-state.json'),
      onHealthSummary: (summary) => connectors.saveHealthSummary(summary),
    });
    const slash = new SlashCommandEngine({
      skillRoots: [],
      connectorsEngine: connectors,
      phoneControlEngine: phoneControl,
    });

    // /phone and aliases /телефон, /xiaomi
    for (const cmd of ['/phone', '/телефон', '/xiaomi']) {
      const res = await slash.run({ text: cmd, mode: 'chat' });
      assert.equal(res.handled, true, `${cmd} must be handled`);
      assert.equal(res.instant, true);
      assert.equal(res.action, 'open-catalog');
      assert.equal(res.tab, 'phone');
    }

    // Also works in isolated mode without leaking
    const privRes = await slash.run({ text: '/phone', mode: 'private', ephemeral: true });
    assert.equal(privRes.handled, true);
    assert.equal(privRes.tab, 'phone');

    const listed = slash.listCommands({ mode: 'chat' });
    const cmdIds = new Set(listed.sections[0].items.map((i) => i.id));
    assert.ok(cmdIds.has('phone'), 'Slash commands must include /phone');

    // PhoneBridge HTTP routes
    const bridge = new PhoneBridge({
      token: () => 'tok',
      persona: () => 'Персона.',
      connectorsEngine: connectors,
      phoneControlEngine: phoneControl,
      slashEngine: slash,
    });
    const port = await bridge.start(0, '127.0.0.1');
    const api = (urlPath, body) => fetch(`http://127.0.0.1:${port}${urlPath}`, {
      headers: { 'x-capri-token': 'tok' },
      ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
    });

    try {
      const ping = await (await api('/ping')).json();
      assert.equal(ping.phoneControlEngine, true);

      const statusBefore = await (await api('/phone-control/status')).json();
      assert.equal(statusBefore.totalCount, 8);
      assert.equal(statusBefore.online, false);

      // Confirmation guard over HTTP
      const unconfirmedSms = await (await api('/phone-control/action', {
        moduleId: 'phone-fossify',
        action: 'sms',
        payload: { phone: '+79990001122', text: 'Тест' },
      })).json();
      assert.equal(unconfirmedSms.ok, false);
      assert.equal(unconfirmedSms.confirmRequired, true);

      // Queue confirmed action
      const confirmedSms = await (await api('/phone-control/action', {
        moduleId: 'phone-fossify',
        action: 'sms',
        payload: { phone: '+79990001122', text: 'Тест' },
        confirmed: true,
      })).json();
      assert.equal(confirmedSms.ok, true);
      assert.ok(confirmedSms.actionId);

      // Phone pushes state + healthSummary (incl. Android heartRate alias) AND receives pendingActions in ONE round-trip
      const syncRes = await (await api('/phone-control/state', {
        deviceName: 'Xiaomi 13T Pro',
        androidVersion: '16',
        modules: {
          'phone-health': { status: 'ready', installed: true, detail: 'Health Connect OK' },
        },
        healthSummary: { steps: 10500, sleepHours: 8, heartRate: 64 },
      })).json();
      assert.equal(syncRes.ok, true);
      assert.equal(syncRes.status.online, true);
      assert.equal(syncRes.status.readyCount, 1);
      assert.equal(syncRes.pendingActions.length, 1);
      assert.equal(syncRes.pendingActions[0].id, confirmedSms.actionId);
      assert.equal(syncRes.pendingActions[0].action, 'sms');

      // Health summary reached ConnectorsEngine
      const savedHealth = JSON.parse(fs.readFileSync(connectors.healthSummaryFile(), 'utf8'));
      assert.equal(savedHealth.steps, 10500);
      assert.equal(savedHealth.avgHr, 64);

      // Report action result
      const actionResultRes = await (await api('/phone-control/action-result', {
        actionId: confirmedSms.actionId,
        ok: true,
        message: 'Открыто в Fossify SMS',
      })).json();
      assert.equal(actionResultRes.ok, true);
      assert.equal(actionResultRes.lastAction.actionId, confirmedSms.actionId);

      const statusAfter = await (await api('/phone-control/status')).json();
      assert.equal(statusAfter.pendingCount, 0);
      assert.equal(statusAfter.lastAction.message, 'Открыто в Fossify SMS');
    } finally {
      await bridge.stop();
    }

    // IPC contracts in main.js and preload.js
    const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
    assert.ok(preloadSrc.includes('phoneControlStatus:'), 'preload.js missing phoneControlStatus');
    assert.ok(preloadSrc.includes('phoneControlAction:'), 'preload.js missing phoneControlAction');

    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    assert.ok(mainSrc.includes('ensurePhoneControlEngine'), 'main.js missing ensurePhoneControlEngine');
    assert.ok(mainSrc.includes("'phone-control:status'"), 'main.js missing phone-control:status IPC');
    assert.ok(mainSrc.includes("'phone-control:action'"), 'main.js missing phone-control:action IPC');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Termux run: read-only commands go at once, others need a confirmation; the worker takes the job and returns masked output', () => {
  const engine = new PhoneControlEngine();
  const safe = engine.queueAction({ moduleId: 'phone-termux', action: 'run', payload: { command: 'uname -a' } });
  assert.equal(safe.queued, true);
  for (const command of ['rm -rf ~', 'ls; rm x', 'cat a > b', 'echo $(id)', 'ping 8.8.8.8', 'pkg install nmap']) {
    const r = engine.queueAction({ moduleId: 'phone-termux', action: 'run', payload: { command } });
    assert.equal(r.confirmRequired, true, command);
  }
  const confirmed = engine.queueAction({ moduleId: 'phone-termux', action: 'run', payload: { command: 'pkg install nmap' }, confirmed: true });
  assert.equal(confirmed.queued, true);
  assert.equal(engine.queueAction({ moduleId: 'phone-termux', action: 'run', payload: { command: 'ping -c 3 1.1.1.1' } }).queued, true);
  assert.equal(engine.termuxResult(safe.actionId).state, 'queued');
  const job = engine.nextTermuxJob();
  assert.equal(job.command, 'uname -a');
  assert.equal(engine.termuxResult(safe.actionId).state, 'running');
  assert.equal(engine.drainPendingActions().length, 0); // the Altair app never sees Termux jobs
  engine.reportTermuxResult({ id: job.id, exitCode: 0, stdout: 'Linux token=supersecret42 ok' });
  const done = engine.termuxResult(safe.actionId);
  assert.equal(done.state, 'done');
  assert.equal(done.exitCode, 0);
  assert.equal(done.stdout, 'Linux «скрыто» ok');
  assert.equal(engine.reportTermuxResult({ id: 'nope' }).ok, false);
  assert.equal(engine.termuxResult('nope').state, 'missing');
});
