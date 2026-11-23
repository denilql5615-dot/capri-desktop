'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PcToolsEngine,
  PC_TOOLS_CATALOG,
  LENOVO_BRIDGES_CATALOG,
  parseKensakuResults,
  validateHttpUrl,
  validateLocalPath,
} = require('../src/main/pc-tools-engine');
const { SlashCommandEngine } = require('../src/main/slash-commands');
const { PhoneBridge } = require('../src/main/phone');

function makeMockEngine({
  openPorts = [4401, 9001, 8765, 1143, 8384],
  bridgeStatuses = { 8082: 200, 8083: 200, 8470: 302, 8420: 200 },
  kensakuIndexed = false,
  existingPaths = null,
} = {}) {
  const execCalls = [];
  const spawnCalls = [];
  const openSet = new Set(openPorts);

  const execFileImpl = async (cmd, args, opts) => {
    execCalls.push({ cmd, args: [...args], opts });
    if (cmd === 'py' && args[0] === '-c') {
      return { stdout: 'ok\n', stderr: '' };
    }
    if (cmd === 'yt-dlp') return { stdout: '2026.11.01\n', stderr: '' };
    if (cmd === 'ffmpeg') return { stdout: 'ffmpeg version 7.1\n', stderr: '' };
    if (cmd === 'markitdown') return { stdout: 'usage: markitdown\n', stderr: '' };
    if (String(cmd).includes('kensaku-cli')) {
      if (args[0] === 'state') {
        if (!kensakuIndexed) {
          throw new Error('kensaku-cli: No Kensaku index found.');
        }
        return { stdout: JSON.stringify({ indexed_files: 42 }), stderr: '' };
      }
      if (args[0] === 'search') {
        return {
          stdout: JSON.stringify({
            results: [
              { path: 'D:\\Docs\\report.pdf', title: 'report.pdf', score: 0.95, snippet: 'Квартальный отчёт' },
            ],
          }),
          stderr: '',
        };
      }
    }
    return { stdout: '', stderr: '' };
  };

  const spawnImpl = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args: [...args], opts });
    return {
      pid: 42424,
      killed: false,
      unref() {},
      once() {},
      kill() { this.killed = true; },
    };
  };

  const checkTcpImpl = async (_host, port) => openSet.has(port);

  const checkHttpImpl = async (url) => {
    const u = new URL(url);
    const code = bridgeStatuses[Number(u.port)] || 0;
    if (!code) return { ok: false, httpStatus: 0, latencyMs: 5, error: 'Connection refused' };
    return { ok: code > 0 && code < 500, httpStatus: code, latencyMs: 12 };
  };

  const existsImpl = (p) => {
    if (existingPaths) return existingPaths.has(p);
    return true;
  };
  const readdirImpl = () => ['upscayl-standard-4x.bin', 'upscayl-standard-4x.param'];

  const engine = new PcToolsEngine({
    execFileImpl,
    spawnImpl,
    checkTcpImpl,
    checkHttpImpl,
    existsImpl,
    readdirImpl,
    cacheTtlMs: 20000,
  });

  return { engine, execCalls, spawnCalls };
}

test('PcToolsEngine catalog has exact 11 PC tools and 4 Lenovo bridges with 20s status cache', async () => {
  assert.equal(PC_TOOLS_CATALOG.length, 11);
  assert.equal(LENOVO_BRIDGES_CATALOG.length, 4);

  const expectedToolIds = [
    'tool-data',
    'tool-media',
    'tool-docs',
    'tool-kensaku',
    'tool-upscayl',
    'tool-penpot-mcp',
    'tool-blender-mcp',
    'tool-comfy',
    'tool-agent-desktop',
    'tool-whisper',
    'tool-proton-sync',
  ];
  assert.deepEqual(PC_TOOLS_CATALOG.map((t) => t.id), expectedToolIds);
  assert.deepEqual(
    LENOVO_BRIDGES_CATALOG.map((b) => b.id),
    ['bridge-freshrss', 'bridge-fmd', 'bridge-homebox', 'bridge-calibre'],
  );

  const { engine, execCalls } = makeMockEngine({ kensakuIndexed: false });
  const st1 = await engine.getStatus();
  assert.equal(st1.pc.totalCount, 11);
  assert.equal(st1.bridges.totalCount, 4);
  assert.equal(st1.bridges.online, true);
  assert.equal(st1.bridges.readyCount, 4);

  const kensaku = st1.pc.tools.find((t) => t.id === 'tool-kensaku');
  assert.equal(kensaku.status, 'needs_setup');
  assert.equal(kensaku.detail, 'Индекс не собран — нажмите Запустить');
  assert.deepEqual(kensaku.actions, ['probe', 'launch']);

  const penpot = st1.pc.tools.find((t) => t.id === 'tool-penpot-mcp');
  assert.equal(penpot.status, 'running');
  assert.equal(penpot.url, 'http://127.0.0.1:9001');

  const countAfterFirst = execCalls.length;
  await engine.getStatus({ refresh: false });
  assert.equal(execCalls.length, countAfterFirst, '20s cache must prevent redundant probes');

  await engine.getStatus({ refresh: true });
  assert.ok(execCalls.length > countAfterFirst, 'refresh: true must bypass 20s cache');
});

test('Private/offline privacy boundary blocks external URLs in transcribeMedia while allowing local files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-transcribe-test-'));
  const sampleAudio = path.join(tmpDir, 'voice-note.mp3');
  fs.writeFileSync(sampleAudio, 'dummy audio bytes');

  const execCalls = [];
  const fetchCalls = [];
  const engine = new PcToolsEngine({
    execFileImpl: async (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === 'ffmpeg') {
        const outWav = args.at(-1);
        fs.writeFileSync(outWav, Buffer.from('RIFF0000WAVE'));
      }
      if (cmd === 'yt-dlp') {
        const tpl = args[args.indexOf('-o') + 1];
        const outFile = tpl.replace('%(ext)s', 'wav');
        fs.writeFileSync(outFile, Buffer.from('RIFF0000WAVE'));
      }
      return { stdout: '', stderr: '' };
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, method: init?.method });
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'Локальная расшифровка готова' }),
      };
    },
  });

  try {
    // 1. Private mode MUST block external URL before calling yt-dlp
    const blocked = await engine.transcribeMedia({
      source: 'https://example.com/video.mp4',
      isPrivate: true,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blocked, true);
    assert.equal(execCalls.length, 0);
    assert.equal(fetchCalls.length, 0);

    // 2. Private mode MUST allow local file 100% offline via ffmpeg -> local Whisper
    const localOk = await engine.transcribeMedia({
      source: sampleAudio,
      isPrivate: true,
    });
    assert.equal(localOk.ok, true);
    assert.equal(localOk.localOnly, true);
    assert.equal(localOk.text, 'Локальная расшифровка готова');
    assert.equal(localOk.wrappedText, 'Локальная расшифровка готова');
    assert.equal(execCalls.filter((c) => c.cmd === 'yt-dlp').length, 0);
    assert.equal(execCalls.filter((c) => c.cmd === 'ffmpeg').length, 1);

    // 3. Non-private external URL wraps transcript in untrusted-data fence
    const urlOk = await engine.transcribeMedia({
      source: 'https://example.com/talk',
      isPrivate: false,
    });
    assert.equal(urlOk.ok, true);
    assert.equal(urlOk.localOnly, false);
    assert.match(urlOk.wrappedText, /^<<<UNTRUSTED_MEDIA_TRANSCRIPT source="https:\/\/example\.com\/talk">>>/);
    assert.match(urlOk.wrappedText, /<<<END_UNTRUSTED_MEDIA_TRANSCRIPT>>>$/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Strict allowlist, URL/path validation, and Blender/Kensaku lifecycle prevent command injection', async () => {
  assert.throws(() => validateHttpUrl('file:///etc/passwd'));
  assert.throws(() => validateHttpUrl('javascript:alert(1)'));
  assert.throws(() => validateHttpUrl('https://example.com/?a=1;rm -rf /'));
  assert.equal(validateHttpUrl('http://192.168.0.107:8082'), 'http://192.168.0.107:8082/');

  assert.throws(() => validateLocalPath('file:///C:/secret.txt'));
  assert.throws(() => validateLocalPath('C:\\data.csv & calc.exe'));
  assert.throws(() => validateLocalPath('-rf'));

  const { engine, spawnCalls } = makeMockEngine();

  const badAction = await engine.runAction({ toolId: 'tool-data', action: 'exec_shell' });
  assert.equal(badAction.ok, false);

  const badTool = await engine.runAction({ toolId: 'tool-unknown', action: 'probe' });
  assert.equal(badTool.ok, false);

  const badLaunch = await engine.runAction({ toolId: 'tool-data', action: 'launch' });
  assert.equal(badLaunch.ok, false);

  const launchOk = await engine.runAction({ toolId: 'tool-kensaku', action: 'launch' });
  assert.equal(launchOk.ok, true);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].opts.shell, false);
  assert.equal(spawnCalls[0].opts.detached, true);

  const stopBeforeStart = await engine.runAction({ toolId: 'tool-blender-mcp', action: 'stop' });
  assert.equal(stopBeforeStart.ok, false);

  const startBlender = await engine.runAction({ toolId: 'tool-blender-mcp', action: 'start' });
  assert.equal(startBlender.ok, true);
  assert.equal(spawnCalls.length, 2);
  assert.equal(spawnCalls[1].opts.shell, false);

  const stopBlender = await engine.runAction({ toolId: 'tool-blender-mcp', action: 'stop' });
  assert.equal(stopBlender.ok, true);

  const parsedKensaku = parseKensakuResults(JSON.stringify({
    results: [
      { path: 'D:\\Obsidian\\note.md', score: 0.88, snippet: 'Текст   заметки' },
    ],
  }));
  assert.equal(parsedKensaku.length, 1);
  assert.equal(parsedKensaku[0].name, 'note.md');
  assert.equal(parsedKensaku[0].snippet, 'Текст заметки');
});

test('Real end-to-end smoke: capri-data-analyze.py (CSV -> stats + PNG) and capri-convert-doc.py (MD -> DOCX)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-py-smoke-'));
  const csvPath = path.join(tmpDir, 'sales.csv');
  const mdPath = path.join(tmpDir, 'report.md');
  const docxPath = path.join(tmpDir, 'report.docx');
  const chartsDir = path.join(tmpDir, 'charts');

  fs.writeFileSync(
    csvPath,
    'month,revenue,orders\nJan,1200,14\nFeb,1850,21\nMar,1640,19\n',
    'utf8',
  );
  fs.writeFileSync(
    mdPath,
    '# Итоги недели\n\n## Основные пункты\n\n- Выручка выросла на **15%**\n- Запущен `PcToolsEngine`\n\n```js\nconsole.log("ok");\n```\n',
    'utf8',
  );

  try {
    const realEngine = new PcToolsEngine({ artifactsDir: tmpDir });

    const dataRes = await realEngine.analyzeData({
      filePath: csvPath,
      query: 'revenue',
      outDir: chartsDir,
    });
    assert.equal(dataRes.ok, true, dataRes.error || 'analyzeData failed');
    assert.equal(dataRes.rows, 3);
    assert.equal(dataRes.cols, 3);
    assert.equal(dataRes.numericSummary.revenue.sum, 4690);
    assert.equal(dataRes.numericSummary.orders.max, 21);
    assert.equal(dataRes.previewRows.length, 3);
    assert.ok(dataRes.chartPath && fs.existsSync(dataRes.chartPath), 'PNG chart must exist');
    assert.ok(fs.statSync(dataRes.chartPath).size > 1000, 'PNG chart should be non-empty');

    const missingData = await realEngine.analyzeData({
      filePath: path.join(tmpDir, 'missing.csv'),
      outDir: chartsDir,
    });
    assert.equal(missingData.ok, false);

    const docRes = await realEngine.convertDocument({
      inputPath: mdPath,
      targetFormat: 'docx',
      outDir: tmpDir,
    });
    assert.equal(docRes.ok, true, docRes.error || 'convertDocument failed');
    assert.equal(path.resolve(docRes.outputPath), path.resolve(docxPath));
    assert.ok(fs.existsSync(docxPath), 'DOCX output must exist');
    assert.ok(docRes.bytes > 2000, 'DOCX should have valid zip/xml payload');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Slash commands (/tools, /pc, /инструменты, /analyze, /convert, /transcribe, /upscale), PhoneBridge, and IPC contracts work together', async () => {
  const { engine: pcTools } = makeMockEngine();
  const slash = new SlashCommandEngine({
    skillRoots: [],
    pcToolsEngine: pcTools,
  });

  // /tools and its aliases open the tools tab
  for (const cmd of ['/tools', '/pc', '/инструменты']) {
    const res = await slash.run({ text: cmd, mode: 'chat' });
    assert.equal(res.handled, true, `${cmd} must be handled`);
    assert.equal(res.instant, true);
    assert.equal(res.action, 'open-catalog');
    assert.equal(res.tab, 'tools');
  }

  // Listed commands include /analyze, /convert, /transcribe, /upscale
  const listed = slash.listCommands({ mode: 'chat' });
  const cmdIds = new Set(listed.sections[0].items.map((i) => i.id));
  for (const id of ['tools', 'analyze', 'convert', 'transcribe', 'upscale']) {
    assert.ok(cmdIds.has(id), `Slash commands missing /${id}`);
  }

  // /transcribe in private mode blocks external URL
  const blockedTranscribe = await slash.run({
    text: '/transcribe https://example.com/audio.mp3',
    mode: 'private',
  });
  assert.equal(blockedTranscribe.handled, true);
  assert.ok(blockedTranscribe.error);

  // PhoneBridge endpoints & /ping
  const bridge = new PhoneBridge({
    token: () => 'tok',
    persona: () => 'Персона.',
    pcToolsEngine: pcTools,
    slashEngine: slash,
  });
  const port = await bridge.start(0, '127.0.0.1');
  const api = (urlPath, body) => fetch(`http://127.0.0.1:${port}${urlPath}`, {
    headers: { 'x-capri-token': 'tok' },
    ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }),
  });

  try {
    const ping = await (await api('/ping')).json();
    assert.equal(ping.pcToolsEngine, true);

    const status = await (await api('/tools/status?refresh=1')).json();
    assert.equal(status.pc.totalCount, 11);
    assert.equal(status.bridges.totalCount, 4);

    const probeRes = await (await api('/tools/action', {
      toolId: 'tool-kensaku',
      action: 'probe',
    })).json();
    assert.equal(probeRes.ok, true);
    assert.equal(probeRes.item.id, 'tool-kensaku');

    const blockedPhone = await api('/tools/action', {
      toolId: 'tool-media',
      action: 'transcribe',
      payload: { source: 'https://example.com/test.mp4', isPrivate: true },
    });
    assert.equal(blockedPhone.status, 403);
  } finally {
    await bridge.stop();
  }

  // IPC contracts in main.js and preload.js
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.ok(preloadSrc.includes('toolsStatus:'), 'preload.js missing toolsStatus');
  assert.ok(preloadSrc.includes('toolsAction:'), 'preload.js missing toolsAction');

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.ok(mainSrc.includes('ensurePcToolsEngine'), 'main.js missing ensurePcToolsEngine');
  assert.ok(mainSrc.includes("'tools:status'"), 'main.js missing tools:status IPC');
  assert.ok(mainSrc.includes("'tools:action'"), 'main.js missing tools:action IPC');
});
