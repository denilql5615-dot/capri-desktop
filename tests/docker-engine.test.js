'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DockerEngine,
  PC_STACKS,
  LENOVO_STACKS,
  NOMAD_PACK_SUBITEMS,
  parseMemMb,
  parseCpuPct,
  parseFreeOutput,
  parseDfOutput,
} = require('../src/main/docker-engine');
const { ConnectorsEngine } = require('../src/main/connectors-engine');
const { SlashCommandEngine } = require('../src/main/slash-commands');
const { PhoneBridge } = require('../src/main/phone');

function makeMockExec({
  pcPs = '',
  pcStats = '',
  lenovoOut = '',
  pcOnline = true,
  lenovoOnline = true,
} = {}) {
  const calls = [];
  const execFileImpl = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts });
    if (cmd === 'docker') {
      if (!pcOnline) throw new Error('Cannot connect to the Docker daemon');
      if (args[0] === 'ps') return { stdout: pcPs, stderr: '' };
      if (args[0] === 'stats') return { stdout: pcStats, stderr: '' };
      if (['start', 'stop', 'restart'].includes(args[0])) {
        return { stdout: args.slice(1).join('\n'), stderr: '' };
      }
      throw new Error(`Unexpected local docker args: ${args.join(' ')}`);
    }
    if (cmd === 'ssh') {
      if (!lenovoOnline) throw new Error('ssh: connect to host 192.168.0.107 port 22: Connection timed out');
      const remoteCmd = args.at(-1) || '';
      if (remoteCmd.includes('===STATS===')) {
        return { stdout: lenovoOut, stderr: '' };
      }
      if (/^docker (start|stop|restart) /.test(remoteCmd)) {
        return { stdout: 'ok', stderr: '' };
      }
      throw new Error(`Unexpected SSH command: ${remoteCmd}`);
    }
    throw new Error(`Unexpected binary: ${cmd}`);
  };
  return { calls, execFileImpl };
}

const SAMPLE_PC_PS = [
  'capri-nomad-local\trunning\tUp 4 hours',
  'capri-tor-netns\trunning\tUp 4 hours',
  'capri-tor-gw\trunning\tUp 4 hours',
  'opennotebook-open_notebook-1\trunning\tUp 2 hours',
  'opennotebook-surrealdb-1\trunning\tUp 2 hours',
  'presenton-presenton-1\texited\tExited (0) 1 day ago',
].join('\n');

const SAMPLE_PC_STATS = [
  'capri-nomad-local\t441MiB / 31.3GiB\t0.35%',
  'capri-tor-netns\t18.5MiB / 31.3GiB\t0.10%',
  'capri-tor-gw\t64.5MiB / 31.3GiB\t0.25%',
  'opennotebook-open_notebook-1\t1.25GiB / 31.3GiB\t2.40%',
  'opennotebook-surrealdb-1\t128MiB / 31.3GiB\t0.50%',
].join('\n');

const SAMPLE_LENOVO_OUT = [
  'searxng-searxng-1\trunning\tUp 3 days',
  'capri-wger\trunning\tUp 3 days',
  'hub-awg-1\trunning\tUp 3 days',
  'nomad_kiwix_server\trunning\tUp 3 days',
  'nomad_stirling_pdf\trunning\tUp 3 days',
  'nomad_kolibri_2\texited\tExited (0) 2 days ago',
  '===STATS===',
  'searxng-searxng-1\t210MiB / 7.7GiB\t1.20%',
  'capri-wger\t310MiB / 7.7GiB\t0.80%',
  'hub-awg-1\t12MiB / 7.7GiB\t0.05%',
  'nomad_kiwix_server\t96MiB / 7.7GiB\t0.15%',
  'nomad_stirling_pdf\t512KiB / 7.7GiB\t0.02%',
  '===FREE===',
  '               total        used        free      shared  buff/cache   available',
  'Mem:            7840        3920         800         120        3120        3500',
  'Swap:           2048         512        1536',
  '===DF===',
  'Filesystem      Size  Used Avail Use% Mounted on',
  '/dev/sda2       110G   42G   63G  40% /',
].join('\n');

test('DockerEngine catalog matches all exact PC & Lenovo stacks and NOMAD 10-service pack', () => {
  assert.equal(PC_STACKS.length, 7);
  assert.equal(LENOVO_STACKS.length, 11);
  assert.equal(NOMAD_PACK_SUBITEMS.length, 10);

  const criticalPc = PC_STACKS.filter((s) => s.critical).map((s) => s.id);
  const criticalLenovo = LENOVO_STACKS.filter((s) => s.critical).map((s) => s.id);
  assert.deepEqual(criticalPc, ['pc-nomad', 'pc-tor']);
  assert.deepEqual(criticalLenovo, ['srv-searxng', 'srv-amnezia']);

  const nomadPack = LENOVO_STACKS.find((s) => s.id === 'srv-nomad-pack');
  assert.equal(nomadPack.expandable, true);
  assert.deepEqual(
    nomadPack.subItems.map((s) => [s.container, s.port]),
    [
      ['nomad_kiwix_server', 8090],
      ['nomad_stirling_pdf', 8400],
      ['nomad_calibreweb', 8420],
      ['nomad_homebox', 8470],
      ['nomad_translate', 8460],
      ['nomad_filebrowser', 8410],
      ['nomad_cyberchef', 8100],
      ['nomad_it_tools', 8430],
      ['nomad_qdrant', 6333],
      ['nomad_dozzle', 9999],
    ],
  );
});

test('Memory, CPU, free -m and df -h parsers handle MiB/GiB/KiB/MB and edge inputs cleanly', () => {
  assert.equal(parseMemMb('441MiB / 15.5GiB'), 441);
  assert.equal(parseMemMb('1.5GiB / 31.3GiB'), 1536);
  assert.equal(parseMemMb('512KiB / 8GiB'), 0.5);
  assert.equal(parseMemMb('250MB / 1GB'), 250);
  assert.equal(parseMemMb('-- / --'), 0);
  assert.equal(parseMemMb(''), 0);

  assert.equal(parseCpuPct('0.35%'), 0.35);
  assert.equal(parseCpuPct('--'), 0);

  const free = parseFreeOutput(SAMPLE_LENOVO_OUT.split('===FREE===')[1].split('===DF===')[0]);
  assert.deepEqual(free.hostMem, { totalMb: 7840, usedMb: 3920, freeMb: 800, availableMb: 3500, usedPct: 50 });
  assert.deepEqual(free.hostSwap, { totalMb: 2048, usedMb: 512, freeMb: 1536, usedPct: 25 });

  const df = parseDfOutput(SAMPLE_LENOVO_OUT.split('===DF===')[1]);
  assert.equal(df.size, '110G');
  assert.equal(df.used, '42G');
  assert.equal(df.avail, '63G');
  assert.equal(df.usePct, '40%');
  assert.equal(df.usePctNum, 40);
  assert.equal(df.mount, '/');
});

test('DockerEngine getStatus aggregates PC & Lenovo metrics, caches for 20s, and handles offline hosts gracefully', async () => {
  const mock = makeMockExec({
    pcPs: SAMPLE_PC_PS,
    pcStats: SAMPLE_PC_STATS,
    lenovoOut: SAMPLE_LENOVO_OUT,
  });
  const engine = new DockerEngine({
    execFileImpl: mock.execFileImpl,
    sshKeyPath: 'C:\\Users\\test\\.ssh\\capri_server',
    cacheTtlMs: 20000,
  });

  const status1 = await engine.getStatus();
  assert.equal(status1.pc.online, true);
  assert.equal(status1.pc.runningCount, 3);
  assert.equal(status1.pc.totalCount, 7);
  assert.equal(status1.pc.totalContainerMb, 1932);
  assert.ok(status1.pc.hostMem.totalMb > 0);

  const pcOpenNotebook = status1.pc.stacks.find((s) => s.id === 'pc-opennotebook');
  assert.equal(pcOpenNotebook.running, true);
  assert.equal(pcOpenNotebook.runningCount, 2);
  assert.equal(pcOpenNotebook.memMb, 1408);

  assert.equal(status1.lenovo.online, true);
  assert.equal(status1.lenovo.runningCount, 4);
  assert.equal(status1.lenovo.totalCount, 11);
  assert.equal(status1.lenovo.hostMem.usedMb, 3920);
  assert.equal(status1.lenovo.hostSwap.usedMb, 512);
  assert.equal(status1.lenovo.hostDisk.usePct, '40%');

  const nomadPack = status1.lenovo.stacks.find((s) => s.id === 'srv-nomad-pack');
  assert.equal(nomadPack.running, true);
  assert.equal(nomadPack.runningCount, 2);
  assert.equal(nomadPack.totalCount, 10);
  assert.equal(nomadPack.memMb, 96.5);
  assert.equal(nomadPack.subItems.find((i) => i.container === 'nomad_stirling_pdf').memMb, 0.5);

  const callsAfterFirst = mock.calls.length;
  // Second call without refresh hits 20s cache
  await engine.getStatus({ refresh: false });
  assert.equal(mock.calls.length, callsAfterFirst);

  // refresh: true bypasses cache
  await engine.getStatus({ refresh: true });
  assert.ok(mock.calls.length > callsAfterFirst);

  // Verify SSH flags follow strict non-interactive BatchMode + ConnectTimeout=4 + key path
  const sshCall = mock.calls.find((c) => c.cmd === 'ssh');
  assert.deepEqual(sshCall.args.slice(0, 7), [
    '-o', 'ConnectTimeout=4',
    '-o', 'BatchMode=yes',
    '-i', 'C:\\Users\\test\\.ssh\\capri_server',
    'danyal@192.168.0.107',
  ]);

  // Offline Lenovo should return online: false with all 11 stacks still structured
  const offlineMock = makeMockExec({ pcPs: SAMPLE_PC_PS, pcStats: SAMPLE_PC_STATS, lenovoOnline: false });
  const offlineEngine = new DockerEngine({ execFileImpl: offlineMock.execFileImpl });
  const off = await offlineEngine.getStatus();
  assert.equal(off.pc.online, true);
  assert.equal(off.lenovo.online, false);
  assert.ok(off.lenovo.error.includes('timed out'));
  assert.equal(off.lenovo.stacks.length, 11);
});

test('DockerEngine enforces strict allowlist, blocks injection & docker rm, and guards critical 24/7 stops', async () => {
  const mock = makeMockExec({
    pcPs: SAMPLE_PC_PS,
    pcStats: SAMPLE_PC_STATS,
    lenovoOut: SAMPLE_LENOVO_OUT,
  });
  const engine = new DockerEngine({
    execFileImpl: mock.execFileImpl,
    sshKeyPath: '/home/test/.ssh/capri_server',
  });

  // 1. Disallowed actions (e.g. rm / kill / exec)
  for (const badAction of ['rm', 'kill', 'exec', 'stop && whoami', '']) {
    const res = await engine.controlStack({ host: 'pc', stackId: 'pc-presenton', action: badAction });
    assert.equal(res.ok, false);
  }

  // 2. Disallowed hosts & stackIds & container injections
  const badHost = await engine.controlStack({ host: 'cloud', stackId: 'pc-presenton', action: 'start' });
  assert.equal(badHost.ok, false);

  const badStack = await engine.controlStack({ host: 'pc', stackId: 'pc-presenton; rm -rf /', action: 'start' });
  assert.equal(badStack.ok, false);

  const badContainer = await engine.controlStack({
    host: 'lenovo',
    stackId: 'srv-nomad-pack',
    container: 'nomad_kiwix_server && id',
    action: 'restart',
  });
  assert.equal(badContainer.ok, false);

  const wrongContainerForStack = await engine.controlStack({
    host: 'lenovo',
    stackId: 'srv-nomad-pack',
    container: 'capri-wger',
    action: 'restart',
  });
  assert.equal(wrongContainerForStack.ok, false);

  // Zero commands were executed for all invalid attempts
  assert.equal(mock.calls.length, 0);

  // 3. Critical 24/7 stacks require confirm: true before stop
  for (const [host, stackId] of [
    ['pc', 'pc-nomad'],
    ['pc', 'pc-tor'],
    ['lenovo', 'srv-searxng'],
    ['lenovo', 'srv-amnezia'],
  ]) {
    const guard = await engine.controlStack({ host, stackId, action: 'stop' });
    assert.equal(guard.ok, false);
    assert.equal(guard.confirmRequired, true);
    assert.match(guard.message, /критичен|Подтверди/i);
  }
  assert.equal(mock.calls.length, 0);

  // 4. Confirming critical stop executes docker stop + refreshes status
  const confirmedStop = await engine.controlStack({
    host: 'pc',
    stackId: 'pc-tor',
    action: 'stop',
    confirm: true,
  });
  assert.equal(confirmedStop.ok, true);
  assert.equal(confirmedStop.action, 'stop');
  assert.ok(confirmedStop.status.pc);
  assert.deepEqual(mock.calls[0], {
    cmd: 'docker',
    args: ['stop', 'capri-tor-netns', 'capri-tor-gw'],
    opts: { timeout: 35000 },
  });

  // 5. Non-critical stack stops without confirm: true
  const nonCritStop = await engine.controlStack({ host: 'pc', stackId: 'pc-presenton', action: 'stop' });
  assert.equal(nonCritStop.ok, true);

  // 6. NOMAD 10-service pack sub-item control via SSH execFile
  const subRestart = await engine.controlStack({
    host: 'lenovo',
    stackId: 'srv-nomad-pack',
    container: 'nomad_stirling_pdf',
    action: 'restart',
  });
  assert.equal(subRestart.ok, true);
  assert.equal(subRestart.container, 'nomad_stirling_pdf');
  const sshActionCall = mock.calls.find((c) => c.cmd === 'ssh' && String(c.args.at(-1)).startsWith('docker restart '));
  assert.ok(sshActionCall);
  assert.equal(sshActionCall.args.at(-1), 'docker restart nomad_stirling_pdf');
});

test('ConnectorsEngine probes Wger fallback .107:8085 honestly and notes OpenNotebook in buildNotebookDigest', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-docker-conn-'));
  try {
    const userDataDir = path.join(base, 'userData');
    const docPath = path.join(base, 'Что дальше.md');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(docPath, '# Что дальше\n- Проверить Docker и OpenNotebook.\n', 'utf8');

    let cfg = {};
    let wgerStatus = 401;
    let wgerReachable = true;

    const mock = makeMockExec({
      pcPs: SAMPLE_PC_PS,
      pcStats: SAMPLE_PC_STATS,
      lenovoOut: SAMPLE_LENOVO_OUT,
    });
    const dockerEngine = new DockerEngine({ execFileImpl: mock.execFileImpl });
    await dockerEngine.getStatus(); // populates cache with pc-opennotebook running

    const connectors = new ConnectorsEngine({
      userDataDir,
      getConfig: () => cfg,
      saveConfig: (patch) => { cfg = { ...cfg, ...patch }; },
      notebookAllowlist: [docPath],
      probeTcp: async (host, port) => {
        if (host === '192.168.0.107' && port === 8085) {
          return { ok: wgerReachable, latencyMs: 6, detail: wgerReachable ? 'ok' : 'refused' };
        }
        return { ok: false, latencyMs: 10, detail: 'refused' };
      },
      fetchImpl: async (url) => {
        if (String(url).startsWith('http://192.168.0.107:8085/api/v2/workout')) {
          return { ok: wgerStatus >= 200 && wgerStatus < 300, status: wgerStatus, json: async () => ({ results: [] }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      },
      deps: { dockerEngine },
    });

    // 1. Default fallback to 192.168.0.107:8085 -> HTTP 401 reports auth_required
    const res401 = await connectors.checkConnector('wger');
    assert.equal(res401.connector.status, 'auth_required');
    assert.match(res401.connector.detail, /192\.168\.0\.107:8085/);

    // 2. If 192.168.0.107:8085 responds 200 -> reports connected
    wgerStatus = 200;
    const res200 = await connectors.checkConnector('wger');
    assert.equal(res200.connector.status, 'connected');

    // 3. If unreachable without custom URL -> reports not_configured
    wgerReachable = false;
    const resOff = await connectors.checkConnector('wger');
    assert.equal(resOff.connector.status, 'not_configured');

    // 4. buildNotebookDigest notes OpenNotebook availability in metadata when running
    const digest = connectors.buildNotebookDigest({ allowlistPaths: [docPath] });
    assert.equal(digest.ok, true);
    assert.deepEqual(digest.openNotebook, { available: true, url: 'http://127.0.0.1:8502' });
    assert.deepEqual(cfg.notebookDigestMeta.openNotebook, { available: true, url: 'http://127.0.0.1:8502' });
    assert.ok(fs.readFileSync(digest.path, 'utf8').includes('http://127.0.0.1:8502'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('SlashCommandEngine /docker, PhoneBridge HTTP routes, and main.js/preload.js IPC contracts', async () => {
  const mock = makeMockExec({
    pcPs: SAMPLE_PC_PS,
    pcStats: SAMPLE_PC_STATS,
    lenovoOut: SAMPLE_LENOVO_OUT,
  });
  const dockerEngine = new DockerEngine({ execFileImpl: mock.execFileImpl });
  const slash = new SlashCommandEngine({ skillRoots: [], dockerEngine });

  const cmdRes = await slash.run({ text: '/docker', mode: 'chat' });
  assert.equal(cmdRes.handled, true);
  assert.equal(cmdRes.instant, true);
  assert.equal(cmdRes.action, 'open-catalog');
  assert.equal(cmdRes.tab, 'docker');
  assert.match(cmdRes.reply, /Пульт Docker/);
  assert.match(cmdRes.reply, /ПК: 3\/7/);
  assert.match(cmdRes.reply, /Lenovo \.107: 4\/11/);

  const bridge = new PhoneBridge({
    token: () => 'tok-docker',
    dockerEngine,
    slashEngine: slash,
    chat: async () => ({ reply: 'ok', brain: 'e4b', pose: '' }),
  });
  const port = await bridge.start(0);
  const req = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: {
        'X-Capri-Token': 'tok-docker',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };

  try {
    const ping = await req('GET', '/ping');
    assert.equal(ping.status, 200);
    assert.equal(ping.data.dockerEngine, true);

    const status = await req('GET', '/docker/status?refresh=1');
    assert.equal(status.status, 200);
    assert.equal(status.data.pc.online, true);
    assert.equal(status.data.lenovo.online, true);

    const guard = await req('POST', '/docker/action', { host: 'lenovo', stackId: 'srv-searxng', action: 'stop' });
    assert.equal(guard.status, 200);
    assert.equal(guard.data.confirmRequired, true);

    const bad = await req('POST', '/docker/action', { host: 'pc', stackId: 'pc-nomad', action: 'rm' });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.ok, false);

    const okAction = await req('POST', '/docker/action', { host: 'pc', stackId: 'pc-presenton', action: 'start' });
    assert.equal(okAction.status, 200);
    assert.equal(okAction.data.ok, true);
    assert.equal(okAction.data.action, 'start');
  } finally {
    await bridge.stop();
  }

  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.ok(preloadSrc.includes('dockerStatus:'));
  assert.ok(preloadSrc.includes('dockerAction:'));

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.ok(mainSrc.includes("'docker:status'"));
  assert.ok(mainSrc.includes("'docker:action'"));
  assert.ok(mainSrc.includes('ensureDockerEngine'));
});
