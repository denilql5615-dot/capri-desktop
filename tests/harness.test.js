'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const harness = require('../src/main/harness');

const SEP = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const winPath = (...parts) => parts.join(SEP);

function makeTempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-harness-test-'));
  const scriptPath = path.join(dir, 'Run-GeminiLeadHarness.ps1');
  const statePath = path.join(dir, 'gemini-harness-state.md');
  const logPath = path.join(dir, 'gemini-harness.log');
  const pidPath = path.join(dir, 'gemini-harness.pid');
  fs.writeFileSync(scriptPath, '# mock harness script' + NL, 'utf8');
  return { dir, scriptPath, statePath, logPath, pidPath };
}

test('harness parseHarnessCommand parses slash, RU and EN commands without false positives', () => {
  assert.deepEqual(harness.parseHarnessCommand('/harness'), { action: 'status' });
  assert.deepEqual(harness.parseHarnessCommand('/harness status'), { action: 'status' });
  assert.deepEqual(harness.parseHarnessCommand('/харнесс статус'), { action: 'status' });
  assert.deepEqual(harness.parseHarnessCommand('Капри, что там с харнессом?'), { action: 'status' });
  assert.deepEqual(harness.parseHarnessCommand('логи харнесса'), { action: 'status' });
  assert.deepEqual(harness.parseHarnessCommand('harness status'), { action: 'status' });

  const start1 = harness.parseHarnessCommand('/harness start -Repo capri-desktop -Goal Починить тесты -MaxWaves 4 -Model research');
  assert.equal(start1.action, 'start');
  assert.equal(start1.repo, 'capri-desktop');
  assert.equal(start1.goal, 'Починить тесты');
  assert.equal(start1.maxWaves, 4);
  assert.equal(start1.model, 'research');

  const start2 = harness.parseHarnessCommand('Капри, запусти харнесс в android: добавить кнопку синка');
  assert.equal(start2.action, 'start');
  assert.equal(start2.repo, 'android');
  assert.equal(start2.goal, 'добавить кнопку синка');

  const start3 = harness.parseHarnessCommand('start harness repo=genesis goal=Обновить раннер');
  assert.equal(start3.action, 'start');
  assert.equal(start3.repo, 'genesis');
  assert.equal(start3.goal, 'Обновить раннер');

  assert.deepEqual(harness.parseHarnessCommand('/harness note не трогай дизайн'), { action: 'note', text: 'не трогай дизайн' });
  assert.deepEqual(harness.parseHarnessCommand('допиши в харнесс: прогнать все тесты'), { action: 'note', text: 'прогнать все тесты' });
  assert.deepEqual(harness.parseHarnessCommand('заметка в харнесс: проверь Windows пути'), { action: 'note', text: 'проверь Windows пути' });
  assert.deepEqual(harness.parseHarnessCommand('harness note: keep diff small'), { action: 'note', text: 'keep diff small' });

  assert.deepEqual(harness.parseHarnessCommand('останови харнесс'), { action: 'stop', reason: undefined });
  assert.deepEqual(harness.parseHarnessCommand('стоп харнесс — пауза на обед'), { action: 'stop', reason: 'пауза на обед' });
  assert.deepEqual(harness.parseHarnessCommand('/harness stop хватит'), { action: 'stop', reason: 'хватит' });
  assert.deepEqual(harness.parseHarnessCommand('stop harness'), { action: 'stop', reason: undefined });

  assert.equal(harness.parseHarnessCommand('что такое харнесс?'), null);
  assert.equal(harness.parseHarnessCommand('привет, как дела?'), null);
  assert.equal(harness.parseHarnessCommand('добавь задачу: купить молоко'), null);
});

test('harness resolveRepo resolves known aliases and preserves explicit paths', () => {
  assert.equal(harness.resolveRepo('capri-desktop'), winPath('D:', 'Capri', 'capri-desktop'));
  assert.equal(harness.resolveRepo('андроид'), winPath('D:', 'Capri', 'capri-android-ref'));
  assert.equal(harness.resolveRepo('genesis'), winPath('D:', 'Capri', 'genesis-src'));
  assert.equal(harness.resolveRepo('obsidian'), winPath('D:', 'Obsidian', 'C.A.P.R.I'));
  assert.equal(harness.resolveRepo(winPath('D:', 'Custom', 'Repo')), winPath('D:', 'Custom', 'Repo'));
  assert.equal(harness.resolveRepo(''), harness.DEFAULT_REPO);
});

test('harness manager full lifecycle: start, duplicate guard, note, status, stop', async () => {
  const env = makeTempEnv();
  let alivePid = null;
  const spawnCalls = [];
  const killedPids = [];
  const fixedNow = () => new Date('2026-11-19T16:30:00.000Z');

  const mgr = harness.createHarnessManager({
    scriptPath: env.scriptPath,
    statePath: env.statePath,
    logPath: env.logPath,
    pidPath: env.pidPath,
    now: fixedNow,
    isPidAlive: (pid) => alivePid === pid,
    killProcess: async (pid) => {
      killedPids.push(pid);
      if (alivePid === pid) alivePid = null;
    },
    spawn: (cmd, args, options) => {
      spawnCalls.push({ cmd, args, options });
      alivePid = 4242;
      return { pid: 4242, unref() {} };
    },
  });

  try {
    const badStart = await mgr.run({ action: 'start', repo: 'desktop', goal: '' });
    assert.equal(badStart.ok, false);
    assert.match(badStart.error, /-Goal/);

    const androidRepo = winPath('D:', 'Capri', 'capri-android-ref');
    const started = await mgr.run({
      action: 'start',
      repo: 'android',
      goal: 'Добавить экран статуса',
      maxWaves: 5,
      model: 'research',
    });
    assert.equal(started.ok, true);
    assert.equal(started.pid, 4242);
    assert.equal(started.repo, androidRepo);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].cmd, 'powershell.exe');
    assert.ok(spawnCalls[0].args.includes('-File'));
    assert.ok(spawnCalls[0].args.includes(env.scriptPath));
    assert.ok(spawnCalls[0].args.includes('-Repo'));
    assert.ok(spawnCalls[0].args.includes(androidRepo));
    assert.ok(spawnCalls[0].args.includes('-Goal'));
    assert.ok(spawnCalls[0].args.includes('Добавить экран статуса'));
    assert.ok(spawnCalls[0].args.includes('-MaxWaves'));
    assert.ok(spawnCalls[0].args.includes('5'));
    assert.ok(spawnCalls[0].args.includes('-Model'));
    assert.ok(spawnCalls[0].args.includes('research'));

    const dup = await mgr.run({ action: 'start', goal: 'Другая цель' });
    assert.equal(dup.ok, false);
    assert.equal(dup.alreadyRunning, true);
    assert.equal(dup.pid, 4242);

    fs.writeFileSync(
      env.statePath,
      [
        'HARNESS_STATUS: IN_PROGRESS',
        'REPO: ' + androidRepo,
        'GOAL: Добавить экран статуса',
        '',
        '## Сделано',
        '- Изучена структура проекта',
        '',
        '## Осталось',
        '- Написать unit-тесты',
      ].join(NL),
      'utf8',
    );
    fs.writeFileSync(env.logPath, 'wave 1 started' + NL + 'wave 1 edit applied' + NL, 'utf8');

    const note1 = await mgr.run({ action: 'note', text: 'Не трогай навигацию' });
    assert.equal(note1.ok, true);
    const note2 = await mgr.run({ action: 'note', text: 'Проверь тёмную тему' });
    assert.equal(note2.ok, true);

    const st = await mgr.run({ action: 'status', logLines: 5 });
    assert.equal(st.ok, true);
    assert.equal(st.running, true);
    assert.equal(st.pid, 4242);
    assert.equal(st.harnessStatus, 'IN_PROGRESS');
    assert.equal(st.doneItems.length, 1);
    assert.equal(st.remainingItems.length, 1);
    assert.equal(st.notes.length, 2);
    assert.match(st.notes[0], /Не трогай навигацию/);
    assert.match(st.notes[1], /Проверь тёмную тему/);
    assert.deepEqual(st.logTail, ['wave 1 started', 'wave 1 edit applied']);

    const formattedStatus = harness.formatHarnessAnswer(st);
    assert.match(formattedStatus, /PID 4242/);
    assert.match(formattedStatus, /IN_PROGRESS/);
    assert.match(formattedStatus, /wave 1 edit applied/);

    const stopped = await mgr.run({ action: 'stop', reason: 'проверка завершена' });
    assert.equal(stopped.ok, true);
    assert.equal(stopped.wasRunning, true);
    assert.equal(stopped.stateUpdated, true);
    assert.deepEqual(killedPids, [4242]);
    assert.equal(fs.existsSync(env.pidPath), false);

    const stateAfterStop = fs.readFileSync(env.statePath, 'utf8');
    assert.match(stateAfterStop, /^HARNESS_STATUS: STOPPED/m);
    assert.match(stateAfterStop, /проверка завершена/);

    const stoppedAgain = await mgr.run({ action: 'stop' });
    assert.equal(stoppedAgain.ok, true);
    assert.equal(stoppedAgain.wasRunning, false);

    const unknown = await mgr.run({ action: 'reboot' });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /Неизвестное действие/);
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});

test('harness manager reports missing script and empty note cleanly', async () => {
  const env = makeTempEnv();
  fs.unlinkSync(env.scriptPath);
  const mgr = harness.createHarnessManager({
    scriptPath: env.scriptPath,
    statePath: env.statePath,
    logPath: env.logPath,
    pidPath: env.pidPath,
  });
  try {
    const res = await mgr.start({ goal: 'Тестовая цель' });
    assert.equal(res.ok, false);
    assert.match(res.error, /Скрипт харнесса не найден/);

    const emptyNote = await mgr.note({ text: '   ' });
    assert.equal(emptyNote.ok, false);
    assert.match(emptyNote.error, /Пустая заметка/);

    assert.equal(harness.HARNESS_TOOL_SPEC.name, 'harness_control');
    assert.deepEqual(harness.HARNESS_TOOL_SPEC.actions, ['start', 'status', 'note', 'stop']);
  } finally {
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
});
