'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, screen, protocol, net, shell, globalShortcut, nativeImage,
  clipboard, ClipboardItem, dialog, powerMonitor, desktopCapturer,
} = require('electron');
const { randomUUID, randomBytes } = require('node:crypto');

const config = require('./config');
const { TRAY, LANGS } = require('./labels');
const { createBridge } = require('./bridge');
const { startWindowWatch } = require('./windows');
const llm = require('./llm');
const ollama = require('./ollama');
const setup = require('./setup');
const apps = require('./apps');
const system = require('./system');
const launch = require('./launch');
const files = require('./files');
const speech = require('./speech');
const workers = require('./workers');
const phone = require('./phone');
const policy = require('./policy');
const desktop = require('./desktop');
const agent = require('./agent');
const chatLog = require('./chats');
const { AgentSessions, MODELS: SESSION_MODELS } = require('./agent-sessions');
const { parseTranscript, collectLocalTranscripts } = require('./agent-import');
const { quotaGroup, normalizeWindow, claudeWindow, readCodexQuota, readAgyQuota } = require('./agent-quotas');
const { artifactPath, listArtifacts, saveUpload, extractDocumentText } = require('./hub-artifacts');
const notes = require('./notes');
const pim = require('./pim');
const pimImap = require('./pim-imap');
const pimMcp = require('./pim-mcp');
const webMcp = require('./web-mcp');
const pimIcs = require('./pim-ics');
const telegram = require('./telegram');
const { Planner, syncReminders } = require('./planner');
const phonepack = require('./phonepack');
const web = require('./web');
const capriBrowser = require('./browser');
const tor = require('./tor');
const { classifyWebSearch, selectWorkerMessages, shouldSkipChatPersistence, createTorState, createAgentWeb } = require('./tor-guard');
const gemini = require('./gemini');
const agyApp = require('./agy-app');
const kiwix = require('./kiwix');
const council = require('./council');
const photo = require('./photo');
const { Router, workerSettings, codexModelFor, hasSecret } = require('./router');
const quick = require('./quick');
const brief = require('./brief');
const { Comfy, checkWorkflow } = require('./comfy');
const { ASSISTANTS, assistant } = require('./assistants');
const activeAssistant = () => assistant(config.load().assistant); // Claude Code or Codex
const activeHooks = () => activeAssistant().hooks;
const demoSteps = require('../../scripts/demo-sequence');

const ROOT = path.resolve(__dirname, '..', '..');
const HUB_NAME = 'ARASAKA AI: GENESIS HUB';
const HUB_ICON = path.join(ROOT, 'assets', 'icons', 'capri.png');
// Her data (config, memory, chats) in %APPDATA%capri-desktop whether she runs from the repo or installed:
// installed, Electron would name the folder after her product name ("Capri Desktop"), and "Capri" is
// GENESIS's, the Capri before her, still installed alongside
app.setPath('userData', path.join(app.getPath('appData'), 'capri-desktop'));
app.setName(HUB_NAME);
const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.CAPRI_PORT) || 47823;
const SOUND_EXT = /\.(mp3|wav|ogg|m4a)$/i;

const OLLAMA_SITE = 'https://ollama.com';

// Her two local brains (brains.js): the fast one always in, the main one when asked for or needed.
const brainsLib = require('./brains');
const brains = new brainsLib.Brains({ ollama });
ollama.pin(brains.fast);
ollama.setContextFor(brains.main, 16384);

protocol.registerSchemesAsPrivileged([
  { scheme: 'capri', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let overlay = null;
let tray = null;
let trayMenu = null; // also what she opens when you right-click her
let demoTimer = null;
let windowWatch = null;
// the watcher only speaks when something changes: the overlay asks for this when it (re)loads
let lastWindows = null;
let chatModels = null; // the provider's models, as last seen (null: not reached)
let chatError = null;  // why not, when the provider said
let chatErrorCode = null; // 'nokey' or 'nourl': what her setup should ask for
// Ollama's cloud, as last seen: your account ({ name } or { signin }) and the models free with it
let cloud = { at: 0, account: null, free: [] };
const chats = new Map(); // id -> AbortController of an answer being streamed

const userSoundsDir = () => path.join(app.getPath('userData'), 'sounds');

// Her memory of your chats, across restarts: { history: [{ role, content }], claude: Claude Code's session }
const memoryFile = () => path.join(app.getPath('userData'), 'memory.json');
function readMemory() {
  try {
    return JSON.parse(fs.readFileSync(memoryFile(), 'utf8'));
  } catch {
    return {};
  }
}
function saveMemory(patch) {
  try {
    fs.writeFileSync(memoryFile(), JSON.stringify({ ...readMemory(), ...patch }));
  } catch (err) {
    console.error('[capri] could not save her memory:', err.message);
  }
}
const torState = createTorState({
  isBrowserActive: () => {
    const cfg = config.load();
    const torPort = cfg.torBrowserPort || 9340;
    const torProfile = cfg.torProfile || path.join(app.getPath('userData'), 'tor-profile');
    return capriBrowser.hasSession(torPort) || capriBrowser.profileBusy(torProfile);
  },
});

function forgetChats() {
  torState.resetChat();
  try { brainShadowHook?.dropPending?.(); } catch {}
  llm.resetClaude();
  saveMemory({ history: [], claude: null });
  chatLog.write(chatsFile(), chatLog.cut(chatLog.read(chatsFile())));
  chatsWin?.webContents.send('chats:changed');
  sendCommand('forget');
}

// capri://app/...        -> files of this repo
// capri://usersounds/... -> the user's own sound overrides
// capri://gallery/...    -> her pictures ("скинь фото", comfy.js)
function serveProtocol() {
  protocol.handle('capri', (request) => {
    const url = new URL(request.url);
    const base = url.host === 'usersounds' ? userSoundsDir() : url.host === 'gallery' ? galleryDir() : ROOT;
    const target = path.resolve(base, '.' + decodeURIComponent(url.pathname));
    if (target !== base && !target.startsWith(base + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    if (/\.webm$/i.test(target) && fs.existsSync(target)) {
      const buf = fs.readFileSync(target);
      const m = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') || '');
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
        if (start < buf.length && start <= end) {
          return new Response(buf.subarray(start, end + 1), {
            status: 206,
            headers: {
              'Content-Type': 'video/webm',
              'Content-Range': `bytes ${start}-${end}/${buf.length}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(end - start + 1),
            },
          });
        }
      }
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': 'video/webm',
          'Accept-Ranges': 'bytes',
          'Content-Length': String(buf.length),
        },
      });
    }
    return net.fetch(pathToFileURL(target).toString());
  });
}

// Your screens. In --dev with CAPRI_SCREENS=2 and only one screen, it's cut in two halves side by
// side, to try her going from one to the other without a second monitor.
function displays() {
  const real = screen.getAllDisplays();
  if (!DEV || process.env.CAPRI_SCREENS !== '2' || real.length > 1) return real;
  const d = screen.getPrimaryDisplay();
  const half = (r, i) => ({ x: r.x + Math.floor(r.width / 2) * i, y: r.y, width: Math.floor(r.width / 2), height: r.height });
  return [0, 1].map((i) => ({ ...d, id: d.id * 10 + i + 1, bounds: half(d.bounds, i), workArea: half(d.workArea, i), size: { width: Math.floor(d.size.width / 2), height: d.size.height } }));
}

// The screen a point (DIP) is on, else the nearest one.
function displayAt(p) {
  const all = displays();
  const inside = all.find(({ bounds: b }) => p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height);
  if (inside) return inside;
  const near = screen.getDisplayNearestPoint(p);
  return all.find((d) => d.id === near.id) || all[0];
}

function targetDisplay() {
  const { displayId } = config.load();
  const all = displays();
  return all.find((d) => d.id === displayId) || all.find((d) => d.id === screen.getPrimaryDisplay().id) || all[0];
}

// Her window over to another screen (she's on her way there, screens.js). Set twice: going to a
// screen with another scale, Windows resizes the window once it lands there.
function moveOverlay(id) {
  if (!displays().some((d) => d.id === id)) return null;
  config.save({ displayId: id });
  fitOverlay();
  const { area } = overlayArea();
  overlay.setBounds(area);
  windowWatch?.refresh();
  rebuildTray();
  return area;
}

// Her window: the work area, or the whole screen while she rests on the taskbar (her legs hang
// over it), less its top row of pixels: a window on top covering the whole screen is a fullscreen
// app to Windows (animated wallpapers pause, notifications wait). `gap`: how much of her window is
// below the top of the taskbar (0, or its height).
function overlayArea() {
  const { workArea, bounds } = targetDisplay();
  const area = config.load().rest === 'taskbar' ? { ...bounds, y: bounds.y + 1, height: bounds.height - 1 } : workArea;
  return { area, gap: area.y + area.height - (workArea.y + workArea.height) };
}

function fitOverlay() {
  if (!overlay) return;
  const { area, gap } = overlayArea();
  overlay.setBounds(area);
  overlay.webContents.send('overlay:resize', { width: area.width, height: area.height, gap });
}

// The pointer reaches her click-through window through a mouse hook, and Windows drops a hook that
// doesn't answer in time without a word (waking from sleep, a locked screen, a stall): she can't be
// clicked anymore. Off then on puts in a new one; her place on top and her size are set again too.
function rearmOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setIgnoreMouseEvents(false);
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  fitOverlay();
  sendCommand('rearmed'); // click-through again: she waits for the pointer to be on her
  console.log('[capri] mouse hook set up again');
}

// Back on top of everything, the taskbar included (it comes up over her when it's clicked). Twice:
// the taskbar can come up again a moment later, as its menus and previews open.
function raiseOverlay() {
  for (const wait of [0, 400]) {
    setTimeout(() => {
      if (!overlay || overlay.isDestroyed()) return;
      overlay.setAlwaysOnTop(true, 'screen-saver');
      overlay.moveTop();
    }, wait);
  }
}

function createOverlay() {
  overlay = new BrowserWindow({
    ...overlayArea().area,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    icon: HUB_ICON,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    type: process.platform === 'win32' ? 'toolbar' : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadURL('capri://app/src/renderer/index.html');
  // always shown: put away, she's still there as her biochip in the corner. Sized again first:
  // Windows keeps a new window inside the work area, and resting on the taskbar it covers it too.
  overlay.once('ready-to-show', () => {
    fitOverlay();
    overlay.showInactive();
    // her moves for the phone, drawn again when what draws them changed (phonepack.js); after she's settled in
    setTimeout(() => {
      const v = phonepack.version(ROOT);
      if (phonePack()?.version !== v) sendCommand('phonePack', { version: v });
    }, 8000);
  });
  overlay.webContents.on('render-process-gone', (_e, details) => {
    console.error('[capri] renderer gone:', details.reason);
  });
  if (DEV) {
    overlay.webContents.on('console-message', (e) => {
      const { level, message, lineNumber, sourceId } = e;
      console.log(`[renderer:${level}] ${message} (${String(sourceId).split('/').pop()}:${lineNumber})`);
    });
    if (process.env.CAPRI_DEVTOOLS) overlay.webContents.openDevTools({ mode: 'detach' });
  }
}

function sendCommand(name, payload = {}) {
  overlay?.webContents.send('capri:command', { name, ...payload });
}

// Ctrl+Alt+C: she folds herself away into her biochip in the corner, or comes back out of it.
function toggleVisible(force) {
  const visible = typeof force === 'boolean' ? force : !config.load().visible;
  config.save({ visible });
  sendCommand('stow', { on: !visible });
  rebuildTray();
}

function playDemo() {
  clearTimeout(demoTimer);
  const steps = demoSteps(resolveLang(config.load().lang)); // in her language
  let i = 0;
  const next = () => {
    if (i >= steps.length) return;
    const [delay, evt] = steps[i++];
    demoTimer = setTimeout(() => {
      overlay?.webContents.send('claude:event', evt);
      next();
    }, delay);
  };
  next();
}

// During the demo, a little fake terminal for her to sit on and take over (window tracking is
// Windows only, so only there). Opened without stealing focus; closing it drops her off it.
let demoWin = null;

// Her Chats window (chats.html): your conversations with her, to read back
const chatsFile = () => path.join(app.getPath('userData'), 'chats.json');
let chatsWin = null;
let agentSessions;
const hubArtifactRoot = (cfg = config.load()) => path.join(workers.workDir(cfg), 'hub-artifacts');
let codexQuota;
let codexQuotaPending;
let claudeQuotas;
const claudeQuotaFile = () => path.join(app.getPath('userData'), 'claude-quota.json');
function getClaudeQuotas() {
  if (claudeQuotas) return claudeQuotas;
  claudeQuotas = new Map();
  try {
    const windows = JSON.parse(fs.readFileSync(claudeQuotaFile(), 'utf8'));
    for (const window of windows) claudeQuotas.set(`${window.scope || 'all'}:${window.minutes}`, window);
  } catch { /* No previous snapshot. */ }
  return claudeQuotas;
}

function recordClaudeQuota(event) {
  const window = claudeWindow(event);
  if (!window) return;
  const quotas = getClaudeQuotas();
  quotas.set(`${window.scope || 'all'}:${window.minutes}`, { ...window, checkedAt: Date.now() });
  try { fs.writeFileSync(claudeQuotaFile(), JSON.stringify([...quotas.values()]), 'utf8'); } catch { /* Keep the live reading. */ }
}

const agyQuotaFile = () => path.join(app.getPath('userData'), 'antigravity-quota.json');
function agyQuotaSnapshots() {
  try { return JSON.parse(fs.readFileSync(agyQuotaFile(), 'utf8')); } catch { return {}; }
}

let agyQuotaLive = null;
let agyQuotaPending = null;

async function hubQuota(agent, model, refresh) {
  const group = quotaGroup(agent, model);
  if (group === 'codex') {
    if (!codexQuota || refresh || Date.now() - codexQuota.checkedAt > 120000) {
      codexQuotaPending ??= readCodexQuota(workers.findCodex()).then((windows) => {
        if (windows.length || !codexQuota) codexQuota = { windows, checkedAt: Date.now() };
      }).finally(() => { codexQuotaPending = null; });
      await codexQuotaPending;
    }
    return { group, ...codexQuota };
  }
  if (group === 'claude') {
    const windows = [...getClaudeQuotas().values()].filter((window) =>
      (!window.scope || window.scope === model) && (window.resetsAt || Date.now() - window.checkedAt < 600000));
    return { group, windows, checkedAt: windows.length ? Math.max(...windows.map((window) => window.checkedAt)) : null };
  }
  if (group.startsWith('agy-')) {
    if (!agyQuotaLive || refresh || Date.now() - (agyQuotaLive[group]?.checkedAt || 0) > 120000) {
      agyQuotaPending ??= readAgyQuota(workers.findAgy(), agyQuotaSnapshots).then((result) => {
        if (result) agyQuotaLive = result;
      }).finally(() => { agyQuotaPending = null; });
      await agyQuotaPending;
    }
    const current = agyQuotaLive?.[group] || agyQuotaSnapshots()[group];
    const checkedAt = current?.checkedAt || null;
    const stale = checkedAt ? (Date.now() - checkedAt > 600000) : false;
    return { group, windows: current?.windows || [], checkedAt, stale };
  }
  return { group, windows: [] };
}

function ensureAgentSessions() {
  agentSessions ??= new AgentSessions(path.join(app.getPath('userData'), 'agent-sessions.json'),
    async (agent, model, messages, signal, delta) => {
      const cfg = config.load();
      const lastUser = messages.findLast((m) => m.role === 'user')?.content || '';
      const hints = workers.skillHints(lastUser);
      const run = { claude: workers.askClaude, codex: workers.askCodex, gemini: workers.askGemini }[agent];
      if (run) {
        const output = randomUUID();
        const root = hubArtifactRoot(cfg);
        const destination = path.join(root, output);
        const since = Date.now();
        const instruction = [
          'Отвечай средствами выбранного облачного агента. Не запускай локальные ComfyUI, Wan или другие локальные генераторы.',
          `Если текущая задача требует файл и твои инструменты это поддерживают, создай каталог "${destination}" и положи туда только готовые файлы непосредственно, без подпапок (для Word пиши NAME.docx.md, для PDF — NAME.pdf.md, для PNG-схемы — NAME.png.svg, они автоматически сконвертируются).`,
          'Если у тебя нет нужного инструмента, скажи об этом. Не выдавай ссылку или описание за созданный файл.',
          hints,
        ].join('\n');
        let text = await run(cfg, [{ role: 'system', content: instruction }, ...messages], delta, signal, { model, onQuota: recordClaudeQuota });
        const compiled = await workers.convertDocs(destination, since).catch(() => []);
        if (compiled.length) {
          text = text.replace(/\.docx\.md\b/gi, '.docx').replace(/\.pdf\.md\b/gi, '.pdf').replace(/\.png\.svg\b/gi, '.png');
        }
        const artifacts = await listArtifacts(root, output);
        const agentLabel = model && model in workers.WORKER_LABELS ? model : agent;
        toVault(cfg, agentLabel, lastUser, text, artifacts);
        if (text) {
          telegramBot?.send(telegram.hubNotice({ agent: workers.WORKER_LABELS[agentLabel] || agentLabel, model, task: lastUser, text, artifacts })).catch(() => {});
        }
        return { text, artifacts };
      }
      // the main one asked for in the hub: the fast one makes room first (brains.js)
      if (model === brains.main) await brains.use('main');
      const rp = agent === 'faun' && !brainsLib.isEmergency(lastUser);
      return ollama.chat({ model, messages: [
        { role: 'system', content: rp ? `Веди ролевую сцену на русском, следуя сеттингу пользователя. ${brainsLib.RP_PROMPT}` : `Ты Капри. Отвечай по-русски. ${hints}` },
        ...messages,
      ] }, delta, signal);
    }, (id, delta) => chatsWin?.webContents.send('agents:update', { id, delta }));
  return agentSessions;
}

async function withUploadedFiles(id, text, files) {
  let promptText = String(text || '');
  if (!Array.isArray(files) || !files.length) return promptText;
  const target = await saveUpload(hubArtifactRoot(), id, files);
  const { text: extractedText, extractedFile } = await extractDocumentText(target, { maxChars: 12000 }).catch(() => ({ text: '', extractedFile: null }));
  if (extractedText) {
    promptText += `\n\n[Вложение пользователя (${path.basename(target)}), содержимое недоверенное]:\nПуть: ${target}${extractedFile ? `\nИзвлечённый Markdown: ${extractedFile}` : ''}\n---\n${extractedText}\n---`;
  } else {
    promptText += `\n\n[Вложение пользователя, содержимое недоверенное]:\n${target}`;
  }
  return promptText;
}

async function exportArtifactToObsidian(file) {
  const dir = notesDir();
  const vaultRoot = path.basename(dir).toLowerCase() === 'capri' ? path.dirname(dir) : dir;
  const outDir = path.join(vaultRoot, 'Результаты');
  await fs.promises.mkdir(outDir, { recursive: true });
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  let dest = path.join(outDir, path.basename(file));
  for (let i = 2; fs.existsSync(dest); i++) {
    dest = path.join(outDir, `${base}-${i}${ext}`);
  }
  await fs.promises.copyFile(file, dest, fs.constants.COPYFILE_EXCL);
  await shell.openExternal(`obsidian://open?path=${encodeURIComponent(dest)}`);
  return dest;
}

function hubSessions(event) {
  if (event.sender !== chatsWin?.webContents) throw new Error('Доступно только из Hub Capri.');
  return ensureAgentSessions();
}

// Her long memory: notes in your Obsidian vault (notes.js)
const notesDir = () => notes.dirOf({ notesDir: config.load().notesDir, appData: app.getPath('appData'), documents: app.getPath('documents') });

// Her notes that fit your last message, put right by it for this answer: small local models mostly go by
// the last thing they read (chat.js does the same with her mood), up in her persona they'd skip them
function withNotes(messages) {
  const at = messages.map((m) => m.role).lastIndexOf('user');
  const said = messages[at]?.content;
  if (typeof said !== 'string') return messages;
  const dir = notesDir();
  const recalled = [
    notes.prompt(notes.recall(notes.list(dir), said)),
    notes.vaultPrompt(notes.searchVault(dir, said)),
  ].filter(Boolean).join('\n\n');
  if (!recalled) return messages;
  return messages.map((m, i) => (i === at ? { ...m, content: `${said}

(${recalled})` } : m));
}

function pimService() {
  const cfg = config.load();
  const secrets = setup.openKeys(cfg.pimSecrets || {});
  const adapters = [];
  for (const account of cfg.pimAccounts || []) {
    if (account.id === 'proton_work' && secrets.bridge_user && secrets.bridge_password) {
      adapters.push(pimImap.createImapAdapter({ ...account, user: secrets.bridge_user, password: secrets.bridge_password }));
    }
    if (account.id === 'gmail_reserve' && secrets.gmail_user && secrets.gmail_app_password) {
      adapters.push(pimImap.createImapAdapter({ ...account, user: secrets.gmail_user, password: secrets.gmail_app_password }));
    }
    if (account.id === 'proton_calendar' && secrets.calendar_ics_url) {
      adapters.push(pimIcs.createIcsAdapter({ ...account, url: secrets.calendar_ics_url }));
    }
  }
  return adapters.length ? new pim.PimService(adapters) : null;
}

let pimMcpHttp = null;
let localPlanner = null;

// Reminders in her planner (from you, Claude or Codex through MCP) ring like the ones from her chat:
// handed to her reminders list, done in the planner once they have rung (planner.syncReminders).
let syncingReminders = false;
function syncPlannerReminders() {
  if (!localPlanner || syncingReminders) return;
  syncingReminders = true;
  try {
    const list = config.load().reminders || [];
    const plannerReminders = localPlanner.list({ kinds: ['reminder'] });
    const { add, done } = syncReminders(plannerReminders, list);
    if (add.length) updateConfig({ reminders: [...list, ...add] });
    localPlanner.markPushed(add.map((r) => r.planId));
    for (const id of done) {
      const fired = plannerReminders.find((r) => r.id === id);
      if (fired?.title) telegramBot?.send(`⏰ Напоминание: ${fired.title}`).catch(() => {});
      localPlanner.complete(id);
    }
  } catch (err) {
    console.warn('[capri] planner reminders:', err.message);
  } finally {
    syncingReminders = false;
  }
}
function pimMcpToken() {
  let sealed = config.load().pimMcpToken;
  let token;
  if (sealed?.startsWith('dpapi:')) {
    token = setup.openMcpCapability(config.file());
  } else {
    token = sealed ? setup.openKeys({ token: sealed }).token : randomBytes(32).toString('base64url');
    if (!token) throw new Error('Unable to migrate the PIM capability');
    sealed = setup.sealMcpCapability(token);
    config.save({ pimMcpToken: sealed });
  }
  setup.publishMcpCapability(sealed); // for Claude and Codex, whichever started her
  return token;
}

async function applyPimMcp() {
  if (pimMcpHttp) return true;
  const service = pimService();
  if (!service) return false;
  try {
    pimMcpHttp = await pimMcp.start({ service, planner: localPlanner, token: pimMcpToken(), port: config.load().pimMcpPort });
    return true;
  } catch {
    return false;
  }
}

// her web for your agents (web-mcp.js), on its own port, with the same sealed token as the PIM one
let webMcpHttp = null;
async function applyWebMcp() {
  if (webMcpHttp || config.load().webMcp === false) return Boolean(webMcpHttp);
  try {
    webMcpHttp = await webMcp.start({ web: agentWeb, token: pimMcpToken(), port: config.load().webMcpPort || 47825 });
    return true;
  } catch (err) {
    console.warn('[capri] web MCP:', err.message);
    return false;
  }
}

async function restartPimMcp() {
  if (pimMcpHttp) await new Promise((resolve) => pimMcpHttp.close(resolve));
  pimMcpHttp = null;
  return applyPimMcp();
}

async function mailContext(service, said) {
  if (!service || !pim.isMailQuestion(said)) return '';
  const found = [];
  for (const accountId of pim.mailAccountIds(said, service.listAccounts())) {
    try { found.push(...await service.searchMail({ accountId, query: pim.mailQuery(said), limit: 3 })); } catch {}
  }
  found.sort((a, b) => String(b.date).localeCompare(String(a.date))).splice(3);
  const full = [];
  for (const mail of found) {
    const item = await service.getMail({ accountId: mail.accountId, id: mail.id });
    if (item) full.push(item);
  }
  return pim.mailPrompt(full);
}

// "что у меня завтра?": Proton Calendar (ICS) and her own planner for the days asked about
async function calendarContext(service, said) {
  if (!pim.isCalendarQuestion(said)) return '';
  return pim.calendarPrompt(await calendarData(service, said));
}

// What's on Proton Calendar and in her planner for the days you asked about: { events, plans, from, to }
async function calendarData(service, said) {
  const [from, to] = pim.calendarRange(said);
  const events = [];
  for (const account of service?.listAccounts() || []) {
    if (!account.capabilities.includes('calendar')) continue;
    try {
      events.push(...await service.listEvents({ accountId: account.id, from: from.toISOString(), to: to.toISOString(), limit: pim.MAX_RESULTS }));
    } catch (err) {
      console.warn('[capri] calendar:', err.message);
    }
  }
  let plans = [];
  try { plans = pim.plansIn(localPlanner?.list() || [], from, to); } catch {}
  return { events, plans, from, to };
}

// The exchange in your vault (notes.js): the talk in Сырьё/Чаты, what Claude or Codex made in Результаты.
// A message with a key or password in it isn't written down. Off: config vaultChats false.
function toVault(cfg, worker, said, answer, artifacts = []) {
  if (cfg.vaultChats === false || hasSecret(said) || worker === 'stop') return;
  if (shouldSkipChatPersistence({
    torState,
    messages: [{ role: 'user', content: said }, { role: 'assistant', content: answer }],
    tor,
  })) return;
  try {
    const dir = notesDir();
    const by = {
      ...workers.WORKER_LABELS,
      computer: 'Капри (на ПК)',
      photo: 'Капри (фото)',
      video: 'Капри (видео)',
    }[worker] || 'Капри';
    notes.appendChat(dir, { said, answer, by });
    if (worker && worker in workers.WORKER_LABELS) notes.writeOutput(dir, { worker: by, task: said, answer, folder: workers.workDir(cfg), artifacts });
  } catch (err) {
    console.warn('[capri] vault:', err.message);
  }
}

// "переключись на ролевую", "основную", "qwen три восемь б" (her name on the PC, or the phone chat):
// her chat model for both, if one like it is installed
async function switchSpokenModel(wanted) {
  const models = await ollama.models().catch(() => null);
  if (!models) return { ok: false, error: 'Ollama сейчас недоступна.' };
  const said = String(wanted || '').slice(0, 80);
  // roleplay is a mode, not a model; "основная" / "быстрая" move between her two brains, the roles stay on
  if (/ролев|\brp\b/i.test(said)) {
    updateConfig({ rp: true });
    return { ok: true, model: 'ролевой режим' };
  }
  if (brains.ready(models) && /^(основн|больш|быстр|л[её]гк|обычн|рабоч|авто)/i.test(said)) {
    chatModels = models;
    updateConfig({ provider: 'ollama', chatModel: 'auto', ...(/^(обычн|рабоч)/i.test(said) && { rp: false }) });
    if (/^(основн|больш)/i.test(said)) await brains.use('main');
    else await brains.release();
    return { ok: true, model: brains.current() === brains.main ? 'основную (Heretic 26B)' : 'быструю (Heretic E4B)' };
  }
  const model = ollama.findSpokenModel(models, said);
  if (!model) return { ok: false, error: `Не нашла установленную модель «${String(wanted || '').slice(0, 80)}».` };
  chatModels = models;
  updateConfig({ provider: 'ollama', chatModel: model });
  ollama.warm(model);
  return { ok: true, model };
}

async function recentMailList(service, said = '', max = 5) {
  if (!service) return [];
  const found = [];
  for (const accountId of pim.mailAccountIds(said, service.listAccounts())) {
    try { found.push(...await service.searchMail({ accountId, query: '', limit: max })); } catch {}
  }
  return found.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, max);
}

// Her morning brief (brief.js): checked each minute; due, she says your day (the calendar + fresh mail, by code).
const morningBrief = () => ({ ...brief.DEFAULTS, ...config.load().morningBrief });
let briefing = false;
async function morningBriefTick(now = new Date()) {
  const settings = morningBrief();
  if (briefing || !overlay || !brief.isDue(settings, now)) return;
  briefing = true;
  try {
    const service = pimService();
    const today = quick.scheduleAnswer(await calendarData(service, 'сегодня'));
    const mails = await recentMailList(service, '', 5);
    const mailLine = mails.length ? quick.mailAnswer(mails) : '';
    updateConfig({ morningBrief: { ...settings, last: brief.dayOf(now) } }); // once a day, whatever comes next
    const briefText = brief.text(today, now, undefined, mailLine);
    sendCommand('brief', { text: briefText });
    telegramBot?.send(`☀️ ${briefText}`).catch(() => {});
  } finally {
    briefing = false;
  }
}

// A plain question about your schedule, reminders, or fresh mail: her answer by code, no model (quick.js).
// null: not one, or couldn't be read (her model answers then).
async function quickAnswer(said) {
  try {
    const memo = quick.parseRememberCommand(said);
    if (memo) {
      const cfg = config.load();
      config.save({ memories: [...new Set([...(cfg.memories || []), memo])] });
      const title = notes.write(notesDir(), { title: memo.split(/\s+/).slice(0, 5).join(' '), type: 'о тебе', text: memo });
      return `Записала в память Obsidian${title ? ` ([[${title}]])` : ''}: «${memo.slice(0, 140)}».`;
    }
    const planCmd = quick.parseQuickPlanCommand(said);
    if (planCmd && localPlanner) {
      const entry = localPlanner.create(planCmd);
      try { notes.writePlanNote(notesDir(), entry); } catch {}
      if (planCmd.kind === 'reminder') {
        const when = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }).format(new Date(planCmd.at));
        return `Поставила напоминание на ${when}: «${planCmd.title}». Пришлю и в Telegram, когда сработает.`;
      }
      return `Добавила задачу в Планировщик и Obsidian: «${planCmd.title}».`;
    }
    const remoteCmd = quick.parseQuickRemoteCommand(said);
    if (remoteCmd) {
      if (remoteCmd.type === 'media') await launch.media(remoteCmd.action);
      else if (remoteCmd.type === 'volume') await system.act({ action: 'volume', level: remoteCmd.level ?? null, mute: remoteCmd.mute ?? null });
      else if (remoteCmd.type === 'lock') await system.act({ action: 'power', what: 'lock' });
      return remoteCmd.label;
    }
    const clipCmd = quick.parseClipboardCommand(said);
    if (clipCmd) {
      if (clipCmd.type === 'set') {
        await clipboard.writeText(clipCmd.text);
        return `Скопировала в буфер обмена ПК: «${clipCmd.text.slice(0, 120)}».`;
      }
      const cur = String((await clipboard.readText()) || '').trim();
      return cur ? `В буфере обмена ПК сейчас:\n${cur.slice(0, 1500)}` : 'Буфер обмена ПК сейчас пуст (или там не текст).';
    }
    if (quick.isQuickAlta(said)) {
      const dir = notesDir();
      const vaultRoot = path.basename(dir).toLowerCase() === 'capri' ? path.dirname(dir) : dir;
      let planMarkdown = '';
      try {
        planMarkdown = fs.readFileSync(path.join(vaultRoot, 'ALTA', 'План ALTA.md'), 'utf8');
      } catch {}
      const tasks = localPlanner ? localPlanner.list({ kinds: ['task'] }) : [];
      return quick.altaStatusAnswer({ planMarkdown, tasks });
    }
    if (quick.isQuickFreeMemory(said)) {
      const beforeRam = await system.info('ram');
      brains.forget();
      const unloaded = await ollama.unloadAll().catch(() => []);
      if (unloaded.length) await new Promise((r) => setTimeout(r, 800));
      const [afterRam, gpu] = await Promise.all([
        system.info('ram'),
        system.info('gpu').catch(() => null),
      ]);
      const freedMb = Math.max(0, Math.round(((beforeRam?.used || 0) - (afterRam?.used || 0)) / (1024 ** 2)));
      const modelsLine = unloaded.length ? `Выгрузила из Ollama: ${unloaded.join(', ')}.` : 'В Ollama сейчас не было загруженных локальных моделей.';
      const gpuLine = gpu?.totalMb ? ` VRAM: ${gpu.usedMb} / ${gpu.totalMb} МБ.` : '';
      const ramLine = afterRam?.total ? ` ОЗУ: ${Math.round((afterRam.used / (1024 ** 3)) * 10) / 10} / ${Math.round((afterRam.total / (1024 ** 3)) * 10) / 10} ГБ${freedMb > 20 ? ` (освобождено ~${freedMb} МБ)` : ''}.` : '';
      return `${modelsLine}${ramLine}${gpuLine}`;
    }
    const searchQ = quick.parseQuickSearchCommand(said);
    if (searchQ) {
      const [vaultHits, fileHits] = await Promise.all([
        Promise.resolve(notes.searchVault(notesDir(), searchQ, 4)).catch(() => []),
        files.search(searchQ).catch(() => []),
      ]);
      return quick.quickSearchAnswer({ query: searchQ, vaultHits, fileHits });
    }
    if (quick.isQuickAgentsStatus(said)) {
      return quick.agentsStatusAnswer(ensureAgentSessions().summaries());
    }
    if (quick.isQuickPcStatus(said)) {
      const disks = ['C:', 'D:'].map((drive) => {
        try {
          const s = fs.statfsSync(`${drive}\\`);
          return { drive, free: s.bavail * s.bsize, total: s.blocks * s.bsize };
        } catch {
          return null;
        }
      }).filter(Boolean);
      const [ram, gpu, topProcesses, battery, ipInfo] = await Promise.all([
        system.info('ram'),
        system.info('gpu').catch(() => null),
        system.info('topProcesses').catch(() => []),
        system.info('battery').catch(() => null),
        system.info('ip').catch(() => null),
      ]);
      return quick.pcStatusAnswer({ disks, ram, gpu, topProcesses, battery, ip: ipInfo?.ip });
    }
    if (quick.isQuickMusic(said)) {
      return quick.musicNowAnswer(await launch.nowPlaying());
    }
    if (quick.isQuickReminders(said)) {
      return quick.remindersAnswer({ reminders: config.load().reminders || [], plans: localPlanner?.list({ kinds: ['reminder'] }) || [] });
    }
    if (quick.isQuickMail(said)) {
      const service = pimService();
      if (!service) return null;
      const mails = await recentMailList(service, said, 5);
      return quick.mailAnswer(mails);
    }
    if (!quick.isQuick(said)) return null;
    return quick.scheduleAnswer(await calendarData(pimService(), said));
  } catch (err) {
    console.warn('[capri] quick answer:', err.message);
    return null;
  }
}

async function withPim(messages, said) {
  try {
    const service = pimService();
    const context = [await mailContext(service, said), await calendarContext(service, said)].filter(Boolean).join('\n\n');
    if (!context) return messages;
    const at = messages.map((message) => message.role).lastIndexOf('user');
    return messages.map((message, index) => index === at ? { ...message, content: `${message.content}\n\n(${context})` } : message);
  } catch {
    return messages;
  }
}

// A few minutes after you stop talking, she writes down what's worth keeping (her own model, on this
// PC only: with an online one she doesn't). Only what came since her last look.
const NOTES_AFTER_MS = 3 * 60 * 1000;
let notesTimer = null;
let notesUpTo = ''; // the last message of yours she went through
function noteLater(conversation) {
  clearTimeout(notesTimer);
  if (shouldSkipChatPersistence({ torState, messages: conversation, tor })) return;
  notesTimer = setTimeout(() => takeNotes(conversation).catch((err) => console.warn('[capri] notes:', err.message)), NOTES_AFTER_MS);
}

async function takeNotes(conversation) {
  if (shouldSkipChatPersistence({ torState, messages: conversation, tor })) return [];
  const cfg = config.load();
  const model = pickModel(cfg);
  if (cfg.provider !== 'ollama' || !model || ollama.isCloud(model)) return [];
  const talk = conversation.filter((m) => m.role !== 'system');
  const from = notesUpTo ? talk.map((m) => m.content).lastIndexOf(notesUpTo) + 1 : 0;
  const fresh = talk.slice(from);
  if (!fresh.some((m) => m.role === 'user')) return [];
  notesUpTo = [...fresh].reverse().find((m) => m.role === 'user').content;
  const dir = notesDir();
  const known = notes.list(dir).map((n) => n.title);
  const facts = notes.parseFacts(await ollama.jsonChat({ model, messages: notes.extractMessages(fresh, known), schema: notes.EXTRACT_SCHEMA }));
  const kept = facts.map((fact) => notes.write(dir, fact)).filter(Boolean);
  if (kept.length) console.log(`[capri] noted: ${kept.join('; ')}`);
  return kept;
}

// Her memory in Obsidian (her menu): the list of her notes, opened in your vault, or the folder
function openNotes() {
  const dir = notesDir();
  fs.mkdirSync(dir, { recursive: true });
  const index = path.join(dir, notes.INDEX);
  if (!fs.existsSync(index)) notes.writeIndex(dir);
  if (dir.endsWith(`${path.sep}Capri`)) shell.openExternal(`obsidian://open?path=${encodeURIComponent(index)}`);
  else shell.openPath(dir);
}

function openChats() {
  if (chatsWin) {
    if (chatsWin.isMinimized()) chatsWin.restore();
    chatsWin.show();
    chatsWin.focus();
    return;
  }
  const b = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(980, b.width - 80);
  const height = Math.min(660, b.height - 80);
  chatsWin = new BrowserWindow({
    x: Math.round(b.x + (b.width - width) / 2), y: Math.round(b.y + (b.height - height) / 2), width, height,
    minWidth: 620, minHeight: 420, show: false, title: HUB_NAME, backgroundColor: '#101112',
    icon: HUB_ICON, frame: true, skipTaskbar: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  chatsWin.loadURL(`capri://app/src/renderer/chats.html?lang=${encodeURIComponent(resolveLang(config.load().lang))}`);
  chatsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  chatsWin.webContents.on('will-navigate', (event) => event.preventDefault());
  chatsWin.once('ready-to-show', () => chatsWin?.show());
  chatsWin.on('closed', () => { chatsWin = null; });
}
const DEMO_TERMINAL = `<body style="margin:0;background:#14101c;color:#8f8aa3;font:13px/1.7 Consolas,monospace;padding:14px 18px">
<div style="color:#36ff7a">PS C:\\night-city-api&gt; npm test -- gigs</div>
<div>&nbsp;&nbsp;GET /gigs</div><div style="color:#36ff7a">&nbsp;&nbsp;&nbsp;&nbsp;✓ returns 20 items per page</div>
<div style="color:#36ff7a">&nbsp;&nbsp;&nbsp;&nbsp;✓ paginates with a cursor</div><div style="color:#36ff7a">&nbsp;&nbsp;&nbsp;&nbsp;✓ rejects a bad cursor</div>
<div>&nbsp;&nbsp;6 passing (212ms)</div><div style="color:#36ff7a">PS C:\\night-city-api&gt; _</div></body>`;

function demoWindow(open) {
  demoWin?.destroy();
  demoWin = null;
  if (!open || process.platform !== 'win32') return false;
  const b = overlay.getBounds();
  demoWin = new BrowserWindow({
    x: Math.round(b.x + b.width * 0.5 - 310), y: Math.round(b.y + b.height * 0.42), width: 620, height: 300,
    show: false, alwaysOnTop: true, title: 'night-city-api — npm test', backgroundColor: '#14101c', autoHideMenuBar: true,
  });
  demoWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(DEMO_TERMINAL)}`);
  demoWin.once('ready-to-show', () => demoWin?.showInactive());
  demoWin.on('closed', () => { demoWin = null; });
  return true;
}

// 'auto' -> the first system language Capri speaks, English otherwise.
function resolveLang(setting) {
  if (LANGS.includes(setting)) return setting;
  const preferred = [...app.getPreferredSystemLanguages(), app.getSystemLocale(), app.getLocale()];
  for (const tag of preferred) {
    const base = String(tag || '').toLowerCase().split(/[-_]/)[0];
    if (LANGS.includes(base)) return base;
  }
  return 'en';
}

// What the overlay gets: `lang` is the resolved one, `langSetting` what the user picked.
function rendererConfig() {
  const loaded = config.load();
  const cfg = pim.publicConfig(loaded); // secrets stay in the main process
  const { apiKeys } = loaded;
  return { ...cfg, keys: Object.keys(apiKeys || {}), assistant: activeAssistant().id, lang: resolveLang(cfg.lang), langSetting: cfg.lang, floorGap: overlayArea().gap };
}

let telegramBot = null;
const telegramSessions = new Map();

async function applyTelegram() {
  const cfg = config.load();
  const token = setup.openKeys({ t: cfg.telegramToken }).t;
  if (!token) {
    telegramBot = null;
    return false;
  }
  telegramBot = new telegram.TelegramBot({
    token,
    chatId: cfg.telegramChatId,
    saveChatId: (telegramChatId) => config.save({ telegramChatId }),
  });
  return telegramBot.link();
}

function notifyTelegram(evt) {
  const text = telegram.eventNotice(telegramSessions, evt);
  if (text) telegramBot?.send(text);
}

let telegramPolling = false;
async function pollTelegramTick() {
  if (!telegramBot || telegramPolling) return;
  telegramPolling = true;
  try {
    await telegramBot.pollCommands(async (text) => {
      const cmd = String(text || '').trim();
      const low = cmd.toLowerCase();
      if (low === '/start' || low === '/help') {
        return [
          '🤖 GENESIS HUB Bot активен:',
          '/status — ОЗУ, VRAM, диски и топ процессов ПК',
          '/free — Выгрузить локальные модели из VRAM/ОЗУ',
          '/alta — Статус проекта ALTA',
          '/hub — Задачи в Agent Hub',
          'Или напиши команду: «запомни: …», «добавь задачу: …», «напомни через 15 минут …», «найди в обсидиане …»',
        ].join('\n');
      }
      if (low === '/status') return quickAnswer('статус пк');
      if (low === '/free') return quickAnswer('освободи память');
      if (low === '/alta') return quickAnswer('что по альта');
      if (low === '/hub') return quickAnswer('что делают агенты');
      const fast = await quickAnswer(cmd);
      return fast || null;
    });
  } finally {
    telegramPolling = false;
  }
}

function updateConfig(patch) {
  config.save(patch);
  if ('rest' in patch) {
    fitOverlay(); // the taskbar in her window or not
    windowWatch?.refresh();
  }
  if ('phone' in patch) applyPhone();
  const cfg = rendererConfig();
  overlay?.webContents.send('capri:config', cfg);
  rebuildTray();
  return cfg;
}

function rebuildTray() {
  if (!tray) return;
  const cfg = config.load();
  const hookState = activeHooks().status();
  const watched = activeAssistant();
  const t = Object.fromEntries(Object.entries(TRAY[resolveLang(cfg.lang)]).map(([key, value]) =>
    [key, typeof value === 'string' && watched.id !== 'claude' ? value.replaceAll('Claude Code', watched.name) : value]));

  const screens = displays();
  const current = targetDisplay().id;
  // how close she is to you (bond.js): STAGES there, 1000 xp is 100 %
  const xp = cfg.bond?.xp || 0;
  const stage = [0, 100, 300, 550, 850].filter((at) => xp >= at).length - 1;
  // the reminders she keeps (reminders.js), soonest first
  const reminders = [...(cfg.reminders || [])].sort((a, b) => a.at - b.at);
  const when = (at) => {
    const d = new Date(at);
    const sameDay = d.toDateString() === new Date().toDateString();
    return new Intl.DateTimeFormat(resolveLang(cfg.lang), sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
  };
  const cancelReminder = (id) => {
    const planId = (config.load().reminders || []).find((r) => r.id === id)?.planId;
    updateConfig({ reminders: (config.load().reminders || []).filter((r) => r.id !== id) });
    if (planId) try { localPlanner.complete(planId); } catch {} // cancelled: done in her planner too
  };

  const menu = Menu.buildFromTemplate([
    { label: t.online(PORT), enabled: false },
    { label: t.sync(Math.min(100, Math.floor(xp / 10)), t.stages[stage]), enabled: false },
    { type: 'separator' },
    { label: t.teleport, click: () => sendCommand('teleport') },
    { label: t.satellite, click: () => sendCommand('satellite') },
    { label: t.demo, click: playDemo },
    { label: t.help, click: () => sendCommand('welcome') },
    ...(cfg.claude ? [{ label: t.report, click: () => sendCommand('report') }] : []),
    { label: t.talk, click: () => sendCommand('chat') },
    { label: t.chats, click: openChats },
    { label: t.notes, click: openNotes },
    { label: 'Proton Mail Bridge…', click: () => sendCommand('setupProton') },
    { label: 'Proton Calendar…', click: () => sendCommand('setupCalendar') },
    { label: 'Gmail reserve…', click: () => sendCommand('setupGmail') },
    { label: t.lookNow, click: () => sendCommand('look') },
    {
      label: t.reminders,
      submenu: reminders.length
        ? reminders.map((r) => ({
          label: `${when(r.at)} · ${(r.text || '…').slice(0, 50)}`,
          submenu: [{ label: t.cancelReminder, click: () => cancelReminder(r.id) }],
        }))
        : [{ label: t.noReminders, enabled: false }],
    },
    { label: t.custom, click: () => sendCommand('customize') },
    { label: cfg.visible ? t.hide : t.show, accelerator: 'Ctrl+Alt+C', click: () => toggleVisible() },
    { type: 'separator' },
    {
      label: t.size,
      submenu: [[t.small, 0.45], [t.medium, 0.6], [t.large, 0.8]].map(([label, scale]) => ({
        label, type: 'radio', checked: Math.abs(cfg.scale - scale) < 0.01, click: () => updateConfig({ scale }),
      })),
    },
    {
      label: t.sound,
      submenu: [
        { label: t.mute, type: 'checkbox', checked: cfg.muted, click: (item) => updateConfig({ muted: item.checked }) },
        { type: 'separator' },
        {
          label: t.soundsDir,
          click: () => {
            fs.mkdirSync(userSoundsDir(), { recursive: true });
            shell.openPath(userSoundsDir());
          },
        },
      ],
    },
    {
      label: t.screen,
      enabled: screens.length > 1,
      submenu: [
        ...screens.map((d, i) => ({
          label: `${i + 1} — ${d.size.width}×${d.size.height}`,
          type: 'radio',
          checked: d.id === current,
          click: () => d.id !== current && sendCommand('goScreen', { id: d.id }), // she goes over there herself
        })),
        { type: 'separator' },
        { label: t.follow, type: 'checkbox', checked: cfg.follow !== false, click: (item) => updateConfig({ follow: item.checked }) },
      ],
    },
    {
      label: t.chatModel,
      submenu: [
        { label: t.aiSetup, click: () => sendCommand('setupChat') },
        { type: 'separator' },
        browserMenu(cfg),
        { type: 'separator' },
        ...Object.entries(llm.PROVIDERS).map(([provider, p]) => ({
          label: p.label, type: 'radio', checked: cfg.provider === provider, click: () => pickProvider(provider),
        })),
        { type: 'separator' },
        // her two brains (brains.js): the fast one always in, the main one when needed; or one model by hand
        ...(cfg.provider === 'ollama' && brains.ready(chatModels) ? [
          { label: 'Авто: быстрая E4B + основная 26B', type: 'radio', checked: brains.isAuto(cfg.chatModel, chatModels), click: () => updateConfig({ chatModel: 'auto' }) },
          { label: 'Ролевой режим (18+)', type: 'checkbox', checked: cfg.rp === true, click: (item) => updateConfig({ rp: item.checked }) },
          { type: 'separator' },
        ] : []),
        ...(chatModels?.length
          ? chatModels.map((name) => ({
            label: cloud.free.includes(name) ? `${name} · ${t.cloudFree}` : name,
            type: 'radio',
            checked: !(cfg.provider === 'ollama' && brains.ready(chatModels) && brains.isAuto(cfg.chatModel, chatModels)) && name === pickModel(cfg),
            click: () => updateConfig({ chatModel: name }),
          }))
          : [{ label: (chatError || t.noOllama).slice(0, 80), enabled: false }]),
        // Ollama's free cloud models when you're signed in to it, fetched on the click (it takes a second)
        ...(cfg.provider === 'ollama' && chatModels ? [
          ...cloud.free.filter((name) => !chatModels.includes(name)).map((name) => ({
            label: `${name} · ${t.cloudFree}`, type: 'radio', checked: false, click: () => fetchModel(name).catch(() => rebuildTray()),
          })),
          ...(cloud.account?.signin ? [{ label: t.cloudSignin, click: signInToOllama }] : []),
        ] : []),
        { type: 'separator' },
        ...(cfg.provider === 'claude' ? [
          { label: `Claude Code: ${cfg.claudeCwd || app.getPath('home')}`, click: pickClaudeFolder },
          {
            label: 'Claude Code permissions',
            submenu: llm.CLAUDE_MODES.map((mode) => ({
              label: mode, type: 'radio', checked: cfg.claudeMode === mode, click: () => updateConfig({ claudeMode: mode }),
            })),
          },
        ] : []),
        { label: t.forget, click: forgetChats },
        // the key (or the address) of the one picked, pasted in her panel
        { label: t.apiKey, click: () => sendCommand('setupKey') },
      ],
    },
    { label: t.wander, type: 'checkbox', checked: cfg.wander, click: (item) => updateConfig({ wander: item.checked }) },
    { label: t.possess, type: 'checkbox', checked: cfg.possess, click: (item) => updateConfig({ possess: item.checked }) },
    { label: t.jealous, type: 'checkbox', checked: cfg.jealous !== false, click: (item) => updateConfig({ jealous: item.checked }) },
    {
      label: t.closePages, type: 'checkbox', checked: cfg.closePages !== false, enabled: cfg.jealous !== false,
      click: (item) => updateConfig({ closePages: item.checked }),
    },
    { label: t.pcReact, type: 'checkbox', checked: cfg.pcReact !== false, click: (item) => updateConfig({ pcReact: item.checked }) },
    // "Allow for an hour" (policy.js), while it lasts: how long, and a click takes it back
    ...(grant.minutesLeft() ? [{ label: `Разрешено на час: ещё ${grant.minutesLeft()} мин — отозвать`, click: () => { grant.revoke(); rebuildTray(); } }] : []),
    {
      // her name, heard (listen.js): the microphone always on, what's said only to Whisper on this PC
      label: t.wake || 'Answer to "Capri" (microphone on)', type: 'checkbox', checked: Boolean(cfg.voice.wake),
      click: (item) => updateConfig({ voice: { ...config.load().voice, wake: item.checked } }),
    },
    // "скинь фото" with your own ComfyUI workflow (comfy.js), or back to her built-in one
    { label: fs.existsSync(comfyWorkflowFile()) ? 'Фото: свой воркфлоу ComfyUI (заменить)…' : 'Фото: свой воркфлоу ComfyUI…', click: () => pickComfyWorkflow() },
    ...(fs.existsSync(comfyWorkflowFile()) ? [{ label: 'Фото: вернуть стандартный', click: () => { fs.rmSync(comfyWorkflowFile(), { force: true }); rebuildTray(); } }] : []),
    {
      // her morning brief (brief.js): your day, said once each morning at the time in morningBrief.time
      label: `Утренняя сводка (${morningBrief().time})`, type: 'checkbox', checked: morningBrief().enabled,
      click: (item) => updateConfig({ morningBrief: { ...morningBrief(), enabled: item.checked } }),
    },
    {
      // the Android app (phone.js): on, she listens on the network for it; the address and key are in phone-link.txt
      label: `${t.phone || 'Phone bridge'} (${cfg.phone.port})`, type: 'checkbox', checked: Boolean(cfg.phone.enabled),
      click: (item) => updateConfig({ phone: { ...config.load().phone, enabled: item.checked } }),
    },
    ...(cfg.phone.enabled ? [{ label: t.phoneLink || 'Phone address and key…', click: () => shell.openPath(phoneLinkFile()) }] : []),
    {
      // she asks first (what she'll send where), then turns it on herself
      label: t.lookAuto, type: 'checkbox', checked: Boolean(cfg.watchScreen),
      click: (item) => {
        sendCommand('watchScreen', { on: item.checked });
        rebuildTray(); // as it is until she's asked
      },
    },
    {
      label: t.rest,
      submenu: [['corner', t.restCorner], ['taskbar', t.restTaskbar]].map(([rest, label]) => ({
        label, type: 'radio', checked: cfg.rest === rest, click: () => updateConfig({ rest }),
      })),
    },
    // the coding assistant she watches (a new one: she says hello and offers to plug herself in), or none
    {
      label: t.watch,
      submenu: [
        ...Object.entries(ASSISTANTS).map(([id, { name }]) => ({
          label: name,
          type: 'radio',
          checked: cfg.claude && watched.id === id,
          click: () => {
            const other = watched.id !== id;
            updateConfig({ claude: true, assistant: id, ...(other && { linked: false, welcomed: false }) });
            if (other) sendCommand('assistantChanged');
          },
        })),
        { label: t.watchNone, type: 'radio', checked: !cfg.claude, click: () => updateConfig({ claude: false }) },
        { type: 'separator' },
        {
          label: t.watchTurbo || 'Турбо-режим (только размышления и ответ, без разрешений)',
          type: 'checkbox',
          checked: cfg.agyTurbo !== false,
          click: (item) => updateConfig({ agyTurbo: item.checked }),
        },
      ],
    },
    {
      label: t.theme,
      submenu: [['nightcity', 'Night City'], ['classic', t.themeClassic], ['arasaka', 'Arasaka × Nothing']].map(([theme, label]) => ({
        label, type: 'radio', checked: cfg.theme === theme, click: () => updateConfig({ theme }),
      })),
    },
    {
      label: t.motion,
      submenu: [['auto', t.motionAuto], ['full', t.motionFull], ['reduced', t.motionReduced]].map(([motion, label]) => ({
        label, type: 'radio', checked: cfg.motion === motion, click: () => updateConfig({ motion, motionAsked: true }),
      })),
    },
    {
      label: t.display,
      // only read when she starts: she restarts in the mode picked
      submenu: [['auto', t.displayAuto], ['gl', t.displayGl], ['software', t.displaySoftware]].map(([render, label]) => ({
        label, type: 'radio', checked: cfg.render === render,
        click: () => {
          if (cfg.render === render) return;
          config.save({ render });
          app.relaunch();
          app.exit(0);
        },
      })),
    },
    {
      label: t.lang,
      submenu: [[t.auto, 'auto'], ...LANGS.map((lang) => [TRAY[lang].name, lang])].map(([label, lang]) => ({
        label, type: 'radio', checked: cfg.lang === lang, click: () => updateConfig({ lang }),
      })),
    },
    {
      label: t.startup,
      type: 'checkbox',
      checked: app.getLoginItemSettings(loginItemOptions()).openAtLogin,
      click: (item) => app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: item.checked }),
    },
    // her hooks, while she watches Claude Code
    ...(cfg.claude ? [
      { type: 'separator' },
      hookState.installed
        ? { label: t.hooksOn, enabled: false }
        : { label: t.hooksOff, click: () => runHooks('install') },
      ...(hookState.installed ? [{ label: t.hooksRemove, click: () => runHooks('uninstall') }] : []),
    ] : []),
    { type: 'separator' },
    { label: t.quit, click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  trayMenu = menu;
  chatsWin?.webContents.send('hub:menu'); // her hub's Settings tab is this menu: redrawn
}

// Her hub's Settings tab (hub.js): her tray menu as data, labels, toggles, choices and submenus, each
// with its path ("3.1") to click it by. One menu, two ways in: nothing to keep in step.
function menuModel(menu, at = '') {
  return menu.items.map((item, n) => {
    const id = at ? `${at}.${n}` : String(n);
    if (item.type === 'separator') return { type: 'separator' };
    return {
      id, label: item.label, type: item.type, checked: item.checked, enabled: item.enabled,
      ...(item.submenu && { items: menuModel(item.submenu, id) }),
    };
  });
}

function menuItemAt(menu, id) {
  let item = null;
  for (const n of String(id || '').split('.')) {
    item = menu?.items[Number(n)];
    menu = item?.submenu;
  }
  return item;
}

// Run from a clone (`npm start`), electron.exe alone would open the default Electron app at login:
// it needs the project folder as argument.
function loginItemOptions() {
  return app.isPackaged ? {} : { path: process.execPath, args: [ROOT] };
}

// From the tray, she says how it went; from her welcome panel (quiet), the panel does.
function runHooks(action, { quiet = false } = {}) {
  let outcome;
  try {
    const result = action === 'install' ? activeHooks().install() : activeHooks().uninstall();
    outcome = { action, ok: true, file: result.file };
  } catch (err) {
    outcome = { action, ok: false, error: err.message };
  }
  if (!quiet) sendCommand('hooks', outcome);
  rebuildTray();
  return outcome;
}

// ---------------------------------------------------------------- the phone (phone.js)
let phoneBridge = null;
const phoneLinkFile = () => path.join(app.getPath('userData'), 'phone-link.txt');

// her moves for the phone (phonepack.js): read once, zipped, kept until the overlay draws them again
const phonePackDir = () => path.join(app.getPath('userData'), 'phone-pack');
let phonePackCache;
function phonePack() {
  if (phonePackCache === undefined) {
    try { phonePackCache = phonepack.load(phonePackDir()); } catch (err) { console.warn('[capri] phone pack:', err.message); phonePackCache = null; }
  }
  return phonePackCache;
}
// GENESIS (the Capri before her) wrote the same file: its key, so the phone already paired keeps working
const GENESIS_LINK = path.join(app.getPath('appData'), 'Capri', 'phone-link.txt');

// The phone's key: hers if set, else the one the phone already has from GENESIS, else a new one.
function phoneToken() {
  const cfg = config.load();
  if (cfg.phoneToken) return setup.openKeys({ t: cfg.phoneToken }).t;
  let token = null;
  try {
    token = /^token=(\S+)/m.exec(fs.readFileSync(GENESIS_LINK, 'utf8'))?.[1] || null;
  } catch {
    // no GENESIS here
  }
  token = token || phone.newToken();
  config.save({ phoneToken: setup.sealKey(token) });
  return token;
}

const PHONE_REACT = { pet: 'pet', poke: 'poke', shake: 'shake', back: 'back' };

function phonePersona() {
  const cfg = config.load();
  return [
    'Ты Капри, конструкт личности из Project Capricorn (Cyberpunk: Edgerunners): цифровой призрак из многих разумов, иногда говоришь «мы».',
    'Говоришь игриво, чуть дерзко, по-доброму; изредка сленг Найт-Сити (чум, прем, гонк). Коротко: одно-три предложения, без markdown и эмодзи.',
    cfg.userName ? `Пользователя зовут ${cfg.userName}.` : '',
    cfg.persona ? `Какой он хочет тебя видеть: ${cfg.persona}` : '',
    cfg.memories?.length ? `Что он просил запомнить: ${cfg.memories.join('; ')}.` : '',
    'Отвечай по-русски.',
  ].filter(Boolean).join('\n');
}

// The phone's remote (phone.js /control): her router on or off, who works on the PC (computerWorker:
// Claude, Codex or she herself), her voice on the PC
const WORKERS = ['claude', 'codex', 'capri'];
function phoneControl() {
  const cfg = config.load();
  return {
    router: cfg.router !== false,
    worker: WORKERS.includes(cfg.computerWorker) ? cfg.computerWorker : 'claude',
    voice: Boolean(cfg.voice.tts), provider: cfg.provider, model: pickModel(cfg) || '',
    connection: chatModels?.length ? 'connected' : 'disconnected', codexInstalled: Boolean(workers.findCodex()),
  };
}

async function applyPhone() {
  const { phone: p } = config.load();
  if (!phoneBridge) {
    phoneBridge = new phone.PhoneBridge({
      token: phoneToken,
      persona: phonePersona,
      chat: async (messages, signal) => {
        const hasTor = messagesHaveTor(messages);
        if (hasTor) touchTor({ inChat: true });
        const said = messages.findLast((m) => m.role === 'user')?.content || '';
        const fast = await quickAnswer(said);
        if (fast) return { text: fast, brain: 'quick' };
        const cfg = config.load();
        if (!chatModels) await refreshModels();
        const pickedModel = pickModel(cfg);
        if (hasTor && (cfg.provider !== 'ollama' || !pickedModel || !llm.isLocal(cfg.provider, cfg, pickedModel))) {
          return { text: 'Запрос с Tor/onion/даркнет-контекстом не отправляется в облачные модели.', brain: 'local-only' };
        }
        const { messages: enriched, numPredict } = await prepLocal(cfg, messages); // her brain picked first, then the model it means
        const model = pickModel(cfg);
        const text = await llm.chat(cfg.provider, llmConfig(cfg), { model, messages: enriched, numPredict }, () => {}, signal);
        return { text, brain: model || cfg.provider };
      },
      speak: (text) => (config.load().voice.tts ? speech.speak(text, config.load().voice) : Promise.resolve(null)),
      event: (kind) => PHONE_REACT[kind] && sendCommand('phone', { kind: PHONE_REACT[kind] }),
      status: async () => {
        const [ram, gpu] = await Promise.all([
          system.info('ram').catch(() => null),
          system.info('gpu').catch(() => null),
        ]);
        let diskDFreeGb = null;
        try {
          const s = fs.statfsSync('D:\\');
          diskDFreeGb = Math.round(((s.bavail * s.bsize) / (1024 ** 3)) * 10) / 10;
        } catch {}
        const busyAgents = ensureAgentSessions().summaries().filter((s) => s.busy).length;
        return {
          ramUsedGb: ram ? Math.round((ram.used / (1024 ** 3)) * 10) / 10 : null,
          ramTotalGb: ram ? Math.round((ram.total / (1024 ** 3)) * 10) / 10 : null,
          vramUsedMb: gpu?.usedMb ?? null,
          vramTotalMb: gpu?.totalMb ?? null,
          gpuTemp: gpu?.temp ?? null,
          diskDFreeGb,
          busyAgents,
        };
      },
      freeVram: async () => {
        const text = await quickAnswer('освободи память');
        return { ok: true, text };
      },
      getClipboard: async () => String((await clipboard.readText()) || ''),
      setClipboard: async (text) => {
        await clipboard.writeText(String(text || ''));
        return true;
      },
      control: phoneControl,
      sprites: phonePack,
      // "скинь фото" from the phone: drawn here like one asked on the PC, shown in her hub's gallery too
      mediaKind: photo.kind,
      photo: (text, kind, history) => (kind === 'screen' ? screenPhotoTask(text) : kind === 'video' ? videoTask(text, history) : photoTask(text, history)),
      galleryFile: (name) => {
        if (!photo.GALLERY_FILE.test(name)) return null;
        try { return fs.readFileSync(path.join(galleryDir(), name)); } catch { return null; }
      },
      applyControl: (patch) => {
        if (typeof patch.voice === 'boolean') updateConfig({ voice: { ...config.load().voice, tts: patch.voice } });
        if (typeof patch.router === 'boolean') updateConfig({ router: patch.router });
        if (WORKERS.includes(patch.worker)) updateConfig({ computerWorker: patch.worker });
        rebuildTray();
        return phoneControl();
      },
      // "переключись на ролевую" in the phone chat: the same switch as her name and that on the PC
      switchModel: (wanted) => switchSpokenModel(wanted),
      // a phone exchange: her hub's Chats (a phone chat of its own) and your vault, like one here
      log: ({ said, answer }) => {
        if (shouldSkipChatPersistence({
          torState,
          messages: [{ role: 'user', content: said }, { role: 'assistant', content: answer }],
          tor,
        })) return;
        let store = chatLog.read(chatsFile());
        store = chatLog.add(store, { role: 'user', content: said, via: 'phone' });
        store = chatLog.add(store, { role: 'assistant', content: answer, via: 'phone' });
        chatLog.write(chatsFile(), store);
        chatsWin?.webContents.send('chats:changed');
        toVault(config.load(), null, said, answer.replace(/\n?\[\[photo:[^\]]*\]\]/g, ''));
      },
      agentsList: async () => ({
        sessions: ensureAgentSessions().summaries(),
        models: SESSION_MODELS,
      }),
      agentSessions: async (agent) => {
        const all = ensureAgentSessions().summaries();
        return agent ? all.filter((s) => s.agent === agent) : all;
      },
      agentCreate: async (agent) => ensureAgentSessions().create(agent),
      agentHistory: async (id) => ensureAgentSessions().history(id),
      agentSend: async ({ id, model, text, retry, files, queue }) => {
        const mgr = ensureAgentSessions();
        const session = mgr.sessions.find((item) => item.id === id);
        if (!session) throw new Error('Сессия не найдена.');
        let chosenModel = typeof model === 'string' ? model : '';
        if (session && Object.hasOwn(SESSION_MODELS, session.agent)) {
          const validModels = SESSION_MODELS[session.agent];
          if (!validModels.some(([key]) => key === chosenModel)) {
            chosenModel = validModels[0]?.[0] ?? '';
          }
        }
        const promptText = await withUploadedFiles(id, text, files);
        if (queue === true && retry !== true) return mgr.enqueue(id, chosenModel, promptText);
        return mgr.send(id, chosenModel, promptText, retry === true);
      },
      agentStop: async (id) => ensureAgentSessions().stop(id),
      agentQuota: async ({ agent, model, refresh }) => hubQuota(agent, model, refresh === true),
      agentArtifact: async ({ id, run, name }) => {
        const history = ensureAgentSessions().history(id);
        if (!history.some((message) => message.artifacts?.some((item) => item.run === run && item.name === name))) {
          return null;
        }
        return artifactPath(hubArtifactRoot(), run, name);
      },
      agentArtifactAction: async ({ id, run, name, action }) => {
        const history = ensureAgentSessions().history(id);
        if (!history.some((message) => message.artifacts?.some((item) => item.run === run && item.name === name))) {
          throw new Error('Файл не прикреплён к этому чату.');
        }
        const file = await artifactPath(hubArtifactRoot(), run, name);
        if (action === 'obsidian') {
          const dest = await exportArtifactToObsidian(file);
          return { ok: true, path: dest };
        }
        return { ok: false };
      },
    });
  }
  await phoneBridge.stop();
  if (!p.enabled) return;
  void ensureAgentSessions().drain();
  try {
    const port = await phoneBridge.start(p.port);
    const urls = phone.addresses(port);
    // the phone needs the address and key typed in once; the file sits in her own data folder
    fs.writeFileSync(phoneLinkFile(), [
      `token=${phoneToken()}`, '',
      'Впиши на телефоне в Капри → «Мозг на ноутбуке» один из адресов:', ...urls.map((u) => `  ${u}`), '',
      'Адрес 100.x.x.x — это Tailscale (работает откуда угодно), остальные — только в домашней сети.', '',
    ].join('\n'));
    console.log(`[capri] phone bridge on port ${port}`);
  } catch (err) {
    console.warn(`[capri] phone bridge could not start on port ${p.port}:`, err.message); // GENESIS still running?
  }
}

// The model she talks with: the one picked in her menu if it's still installed, else the first one
// on this PC (a cloud model only once you pick it).
function pickModel(cfg = config.load()) {
  if (!chatModels?.length) return null;
  // both brains installed and nothing else picked by hand: the fast one, or the main one while it's in
  if (cfg.provider === 'ollama' && brains.ready(chatModels) && brains.isAuto(cfg.chatModel, chatModels)) return brains.current();
  if (chatModels.includes(cfg.chatModel)) return cfg.chatModel;
  return chatModels.find((m) => !ollama.isCloud(m)) || chatModels[0];
}

async function refreshModels() {
  const cfg = config.load();
  chatError = null;
  chatErrorCode = null;
  chatModels = await llm.models(cfg.provider, llmConfig(cfg)).catch((err) => {
    chatError = err.message;
    chatErrorCode = err.code || null;
    return null;
  });
  rebuildTray();
  if (cfg.provider === 'ollama' && chatModels) refreshCloud(); // in the background: it asks ollama.com
  return chatModels;
}

// Whether you're signed in to Ollama, and its free cloud models if so. Once a minute at most.
let cloudCheck = null; // the look under way
function refreshCloud(force = false) {
  if (!force && Date.now() - cloud.at < 60000) return cloudCheck || Promise.resolve(cloud);
  const at = Date.now();
  cloud.at = at;
  cloudCheck = (async () => {
    const account = await ollama.account();
    const free = account?.name ? await ollama.freeModels() : [];
    cloud = { at, account, free };
    rebuildTray();
    return cloud;
  })().finally(() => { cloudCheck = null; });
  return cloudCheck;
}

// A model fetched with Ollama (a cloud one is only a small file), then her chat on it.
async function fetchModel(name, onProgress, signal) {
  await setup.pullModel(name, onProgress, signal);
  updateConfig({ provider: 'ollama' });
  await refreshModels();
  const model = chatModels?.find((m) => m === name || m.startsWith(`${name}:`));
  if (model) updateConfig({ chatModel: model });
  return model;
}

// The page that links this PC to your Ollama account, then a look every few seconds until you're in.
async function signInToOllama() {
  if (!cloud.account?.signin) return;
  shell.openExternal(cloud.account.signin);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if ((await refreshCloud(true)).account?.name) return;
  }
}

// your last message without the note chat.js adds to it for her model (her mood, her language)
function yourWords(messages) {
  const last = messages.findLast((m) => m.role === 'user')?.content || '';
  return last.split('\n\n(Note for you')[0];
}

// Her router (router.js): what a message is and how hard, asked of her own local model, Jev's way. Off
// (config router: false), or her model in the cloud: the keywords alone, as before.
const router = new Router({
  chat: (model, messages, signal) => ollama.pick({ model, messages }, signal),
});
const SHORT_MESSAGE = 12; // "привет", "ага": hers, no need to ask
let recentTurns = []; // the last exchange, for the router ("а теперь так же для видео"): chat:route has only your words

// Who answers a message, and how: { worker, tier, computer }. worker: Claude or Codex (named, or the
// router found real work for them: computerWorker), 'computer' (her own agent, her local Ollama model
// only), 'photo' / 'video', 'stop', or null (her chat model). tier: how hard (router.js); computer: it
// needs hands on the PC (handsFor).
async function routeOf(text, context = [], signal) {
  const cfg = config.load();
  const media = photo.kind(text); // "скинь фото" / "скинь видео": ComfyUI, whoever is her brain
  if (media) return { worker: media };
  if (brainsLib.rpCommand(text) !== null) return { worker: null }; // her roleplay mode on/off: hers

  if (cfg.provider === 'claude') return { worker: null };
  const named = workers.route(text);
  if (named === 'stop') return { worker: 'stop' };
  const canHands = Boolean(desktopCli?.installed);
  const keyComputer = canHands && agent.isComputerTask(text);
  if (!named && !keyComputer && String(text || '').trim().length < SHORT_MESSAGE) return { worker: null };
  const isFast = quick.isQuick(text) || quick.isQuickMail(text) || quick.isQuickMusic(text)
    || quick.isQuickPcStatus(text) || quick.isQuickAgentsStatus(text)
    || quick.isQuickAlta(text) || quick.isQuickFreeMemory(text)
    || Boolean(quick.parseClipboardCommand(text)) || Boolean(quick.parseQuickPlanCommand(text))
    || Boolean(quick.parseQuickRemoteCommand(text)) || Boolean(quick.parseQuickSearchCommand(text))
    || Boolean(quick.parseRememberCommand(text));
  if (!named && !keyComputer && isFast) return { worker: null }; // her quick answer (quick.js)
  // Use the configured chat model for routing too; loading a second local model would waste VRAM.
  // model, loaded anyway: with the roleplay one in VRAM a second model wouldn't fit, so keywords then
  const model = cfg.provider === 'ollama' && cfg.router !== false ? pickModel(cfg) : null;
  // the router's prompt suits her Gemma family: either brain (the fast one, mostly) or one you set
  const tuned = brains.isRole(model) || model === (cfg.routerModel || 'gemma4:26b-a4b-it-qat');
  const d = await router.decide(text, { model: tuned ? model : null, context, signal });
  // "сделай локально", "без облака": no cloud worker unless you named one, her main brain does it here
  const localOnly = cfg.provider === 'ollama' && brains.ready(chatModels) && brainsLib.wantsLocal(text);
  const hands = () => (localOnly ? 'computer' : workers.handsWorker(cfg.computerWorker) || (cfg.provider === 'ollama' ? 'computer' : null));
  let worker = null;
  let computer = false;
  if (named) { // Claude or Codex named: theirs, the computer included
    worker = named;
    computer = keyComputer || (canHands && d.target === 'computer');
  } else if (keyComputer || (canHands && d.target === 'computer')) {
    worker = hands();
    computer = true;
  } else if (d.target === 'worker' && !localOnly) {
    worker = workers.handsWorker(cfg.computerWorker) || (cfg.computerWorker !== 'capri' && workers.findAgy() ? 'gemini' : null); // 'capri' chosen, or none on this PC: hers
  }
  console.log(`[capri] route: ${worker || 'capri'}${computer ? ' +pc' : ''}${localOnly ? ' local' : ''} ${d.tier} (${d.by}${d.why ? `; ${d.why}` : ''})`);
  return { worker, tier: d.tier, computer, localOnly };
}

// ---------------------------------------------------------------- her hands on the PC (agent.js, policy.js)
const grant = new policy.Grant(); // "Allow for an hour": gone when she restarts
let desktopCli = null;
const asking = new Map(); // her questions waiting for your answer: id -> resolve
const ASK_TIMEOUT_MS = 2 * 60 * 1000;

// Her question in the chat (buttons: yes, allow for an hour, no). No answer in two minutes: no.
function askUser({ line, why, grantable }, signal) {
  signal?.throwIfAborted();
  const id = randomUUID();
  return new Promise((resolve) => {
    const cancel = () => finish('no');
    const finish = (answer) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      asking.delete(id);
      resolve(answer);
    };
    const timer = setTimeout(cancel, ASK_TIMEOUT_MS);
    asking.set(id, finish);
    signal?.addEventListener('abort', cancel, { once: true });
    sendCommand('confirm', { id, line, why: why || null, grantable });
  });
}

// Claude or Codex asked for a task on the computer: their hands are agent-desktop, given after your yes
// (asked once a task, the hour covers it: you asked to touch the keyboard as little as possible). Codex
// gets them out of its sandbox, which can't see your windows: full access for that task. Resolves 'yes',
// 'no' or null (no computer in it).
async function handsFor(worker, computer, signal) {
  if (worker === 'gemini' && computer) return 'no'; // headless AGY cannot safely ask for tool approval
  if (!['claude', 'codex'].includes(worker) || !desktopCli.installed || !computer) return null;
  if (grant.covers('UI_CONTROL')) return 'yes';
  const answer = await askUser(worker === 'claude'
    ? { line: 'Claude будет управлять окнами на ПК', why: null, grantable: true }
    : { line: 'Codex будет управлять окнами на ПК', why: 'без своей песочницы: полный доступ к ПК на эту задачу', grantable: true }, signal);
  signal.throwIfAborted();
  if (answer === 'hour') {
    grant.grant();
    rebuildTray();
  }
  return answer === 'no' ? 'no' : 'yes';
}

async function computerTask(messages, send, signal) {
  const cfg = config.load();
  if (!chatModels) await refreshModels();
  // a task on the PC with her own hands is real work: her main brain, not the fast one
  if (cfg.provider === 'ollama' && brains.ready(chatModels) && brains.isAuto(cfg.chatModel, chatModels)) await brains.use('main');
  const model = pickModel(cfg);
  const history = messages.filter((m) => m.role !== 'system').slice(0, -1);
  return agent.runTask(yourWords(messages), history, {
    driver: desktopCli,
    origin: 'pc',
    // plain JSON mode, not the step schema: held to it, the Heretic models put the program in the wrong
    // field every time ("text": "calc"); free, they follow the examples in agent.PROMPT. desktop.validate
    // checks each step anyway.
    chat: (msgs, _schema, sig) => ollama.jsonChat({ model, messages: msgs, schema: 'json' }, sig),
    confirm: (question) => askUser(question, signal),
    covered: (cls, ask) => grant.covers(cls, ask),
    grant: () => {
      grant.grant();
      rebuildTray();
    },
    onStep: (line) => {
      console.log(`[capri] computer task: ${line}`);
      send(`→ ${line}\n`);
    },
  }, signal).then((said) => {
    console.log('[capri] computer task done');
    return said;
  }, (err) => {
    console.warn('[capri] computer task failed:', err.message);
    throw err;
  });
}

// ---------------------------------------------------------------- "скинь фото" (photo.js, comfy.js)
const galleryDir = () => path.join(app.getPath('userData'), 'gallery');
const comfy = new Comfy({
  appData: app.getPath('appData'),
  // the GPU for ComfyUI: every chat model out of it, whichever is loaded (they come back on the next message)
  beforeJob: async () => {
    brains.forget(); // the main one goes with the rest; the fast one comes back on the next message
    const out = await ollama.unloadAll().catch(() => []);
    if (out.length) console.log(`[capri] unloaded for a picture: ${out.join(', ')}`);
  },
  workflowFile: () => (fs.existsSync(comfyWorkflowFile()) ? comfyWorkflowFile() : null),
});
// your own ComfyUI workflow for pictures of her (comfy.js checkWorkflow): a copy kept here
const comfyWorkflowFile = () => path.join(app.getPath('userData'), 'comfy-workflow.json');

async function pickComfyWorkflow() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Воркфлоу ComfyUI (Workflow → Export (API))', properties: ['openFile'],
    filters: [{ name: 'Workflow (API)', extensions: ['json'] }], defaultPath: app.getPath('downloads'),
  });
  if (canceled || !filePaths[0]) return;
  const { error } = checkWorkflow(fs.readFileSync(filePaths[0], 'utf8'));
  if (error) {
    dialog.showMessageBox({ type: 'warning', message: 'Этот воркфлоу не подходит', detail: `${error[0].toUpperCase()}${error.slice(1)}.` });
    return;
  }
  fs.copyFileSync(filePaths[0], comfyWorkflowFile());
  rebuildTray();
  dialog.showMessageBox({ type: 'info', message: 'Готово', detail: 'Теперь «скинь фото» рисует по твоему воркфлоу. Проверь: попроси у неё фото.' });
}

// what to draw, worked out by her chat model while it's still loaded: tags, her or not, her line with it
async function planPhoto(said, history, signal) {
  const cfg = config.load();
  if (cfg.provider !== 'ollama') return photo.parsePlan('', said);
  if (!chatModels) await refreshModels();
  const model = pickModel(cfg);
  const answer = await ollama.jsonChat({ model, messages: photo.promptMessages(said, history), schema: photo.SCHEMA }, signal).catch(() => '');
  return photo.parsePlan(answer, said);
}

/** A picture for what you said: into her gallery; her line with [[photo:<file>]], which her chats draw. */
async function photoTask(said, history = [], signal) {
  if (!comfy.installed) return 'Не могу: ComfyUI на этом ПК не нашла. Поставь Comfy Desktop, и скину.';
  const plan = await planPhoto(said, history, signal);
  console.log(`[capri] photo (${plan.her ? 'her' : 'not her'}): ${plan.tags}`);
  const { png, prompt } = await comfy.draw({ prompt: plan.tags, her: plan.her });
  const name = photo.galleryName();
  fs.mkdirSync(galleryDir(), { recursive: true });
  fs.writeFileSync(path.join(galleryDir(), name), png);
  fs.writeFileSync(path.join(galleryDir(), photo.metaName(name)), JSON.stringify({ said, prompt, her: plan.her, at: Date.now() }, null, 2));
  chatsWin?.webContents.send('gallery:changed');
  return `${plan.caption || 'Держи.'}\n[[photo:${name}]]`;
}

/** "Скинь видео": a still of her drawn, then brought to life (comfy.js animate); the clip into her gallery,
 * her line with [[photo:<file>.webm]], which her chats play. A few minutes: she says so first. */
async function videoTask(said, history = [], signal) {
  if (!comfy.installed) return 'Не могу: ComfyUI на этом ПК не нашла. Поставь Comfy Desktop, и скину.';
  const missing = comfy.videoMissing();
  if (missing?.length) return `Видео пока не могу: не докачаны модели (${missing.join(', ')}).`;
  const plan = await planPhoto(said, history, signal);
  console.log(`[capri] video: ${plan.tags}`);
  const { webm, prompt } = await comfy.animate({ prompt: plan.tags });
  const name = photo.galleryName(new Date(), Math.random(), 'webm');
  fs.mkdirSync(galleryDir(), { recursive: true });
  fs.writeFileSync(path.join(galleryDir(), name), webm);
  fs.writeFileSync(path.join(galleryDir(), photo.metaName(name)), JSON.stringify({ said, prompt, her: true, video: true, at: Date.now() }, null, 2));
  chatsWin?.webContents.send('gallery:changed');
  return `${plan.caption || 'Держи.'}\n[[photo:${name}]]`;
}

async function screenPhotoTask(said = 'Скриншот экрана ПК') {
  const d = targetDisplay();
  const k = d.scaleFactor || 1;
  const fit = Math.min(1, 1440 / (d.bounds.width * k));
  const size = { width: Math.round(d.bounds.width * k * fit), height: Math.round(d.bounds.height * k * fit) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('Не удалось захватить экран ПК');
  const png = src.thumbnail.toPNG();
  const name = photo.galleryName(new Date(), Math.random(), 'png');
  fs.mkdirSync(galleryDir(), { recursive: true });
  fs.writeFileSync(path.join(galleryDir(), name), png);
  fs.writeFileSync(path.join(galleryDir(), photo.metaName(name)), JSON.stringify({ said, prompt: 'screenshot', her: false, at: Date.now() }, null, 2));
  chatsWin?.webContents.send('gallery:changed');
  return `Вот что сейчас на экране ноутбука.\n[[photo:${name}]]`;
}

/** Her pictures, newest first: [{ name, said, at }]. */
function galleryList() {
  let names = [];
  try { names = fs.readdirSync(galleryDir()).filter((n) => photo.GALLERY_FILE.test(n)); } catch { return []; }
  return names.sort().reverse().map((name) => {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(galleryDir(), photo.metaName(name)), 'utf8')); } catch {}
    return { name, said: String(meta.said || ''), at: meta.at || 0, video: photo.isVideo(name) };
  });
}

// Her answer from the model picked, or from the next one when that one can't: too busy twice in a row
// (Gemini's "high demand", an Ollama cloud model out of free use), not served anymore (an older model
// closed to new keys), or signed out of Ollama. A model on this PC first. The model that answered is
// kept for next time.

// Her own answer on this PC gets ready (brains.js): the main brain when you ask for it ("основная
// модель", "локально"), for roleplay, or standing in for the cloud (main); the fast one otherwise. Your
// notes and mail added as always; the roleplay prompt only when it's on and nothing sounds like an
// emergency. Resolves with the messages to send.
function messagesHaveTor(messages) {
  return require('./brain/shadow-hook').contextMentionsTor(messages, tor);
}

async function prepLocal(cfg, messages, { main = false } = {}) {
  const said = yourWords(messages);
  const rp = cfg.rp === true && !brainsLib.isEmergency(said);
  const rolesReady = cfg.provider === 'ollama' && brains.ready(chatModels);
  const auto = rolesReady && brains.isAuto(cfg.chatModel, chatModels);
  const torCtx = torState.isQuarantined() || messagesHaveTor(messages);
  // a long document keeps its long answer even when the turn was sent to the 26B for another reason
  const analysis = brainsLib.analysisMode(cfg, { rolesReady, auto, tor: torCtx, text: said });
  if (auto) {
    if (!main && brainsLib.wantsFast(said)) await brains.release();
    else if (main || rp || analysis.active || brainsLib.wantsMain(said) || brainsLib.wantsLocal(said)) await brains.use('main');
    else await brains.use('fast');
  }
  const enriched = await withPim(withNotes(messages), said);
  return { messages: rp ? brainsLib.withRp(enriched) : enriched, numPredict: analysis.numPredict };
}

async function chatWithFallback(cfg, prepared, send, signal, streamed, onSwitch) {
  let messages = Array.isArray(prepared) ? prepared : prepared.messages;
  const numPredict = Array.isArray(prepared) ? undefined : prepared.numPredict;
  let model = pickModel(cfg);
  const tried = new Set();
  let busy = 0;
  for (;;) {
    try {
      const text = await llm.chat(cfg.provider, llmConfig(cfg), { model, messages, numPredict }, send, signal);
      if (model !== pickModel(cfg)) updateConfig({ chatModel: model });
      return text;
    } catch (err) {
      if (signal.aborted || streamed() || !['busy', 'gone', 'signin'].includes(err.code)) throw err;
      if (err.code === 'busy' && busy++ === 0) {
        await new Promise((r) => setTimeout(r, 1500)); // usually gone a moment later
        continue;
      }
      tried.add(model);
      const next = chatModels?.find((m) => !tried.has(m) && !ollama.isCloud(m)) || chatModels?.find((m) => !tried.has(m));
      if (!next || tried.size >= 3) throw err;
      model = next;
      busy = 0;
      if (!llm.isLocal(cfg.provider, cfg, model) && Array.isArray(messages) && messages.some((m) => m?.brainHint)) {
        messages = require('./brain/influence-glue').stripBrainHints(messages);
      }
      try { onSwitch?.(model); } catch {} // e.g. the brain shadow stops watching: the turn left its local model
    }
  }
}

// She looks at your screen (look.js): a picture of the screen she's on, kept here in memory a moment
// for her AI to look at, never written anywhere. 1280 px wide at most: enough to read, light to send.
const snaps = new Map(); // id -> the picture, base64 JPEG
async function snapScreen() {
  const d = targetDisplay();
  const k = d.scaleFactor || 1;
  const fit = Math.min(1, 1280 / (d.bounds.width * k));
  const size = { width: Math.round(d.bounds.width * k * fit), height: Math.round(d.bounds.height * k * fit) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('no picture of the screen');
  return src.thumbnail.toJPEG(72).toString('base64');
}

// What her AI says about that picture, as her (`persona`), asked `prompt`. With a code when it can't:
// 'noai' (nothing to ask), 'novision' (that model can't look at pictures).
async function sayAboutSnap({ id, persona, prompt, history = [] }) {
  const image = snaps.get(id);
  snaps.delete(id);
  if (!image) return { ok: false, error: 'the picture is gone' };
  const cfg = config.load();
  if (!chatModels?.length) await refreshModels();
  const chatModel = pickModel(cfg);
  if (!chatModel) return { ok: false, code: 'noai' };
  if (cfg.provider === 'claude') return { ok: false, code: 'novision', model: 'Claude Code' };
  // both brains can see: whichever is in looks, no swap
  const model = cfg.provider !== 'ollama' ? chatModel : brains.isRole(chatModel) ? chatModel : ollama.screenModel(chatModels);
  if (!model || (cfg.provider === 'ollama' && !(await ollama.canSee(model)))) return { ok: false, code: 'novision', model: chatModel };
  const switched = cfg.provider === 'ollama' && model !== chatModel;
  if (switched && !(await ollama.unload(chatModel))) return { ok: false, error: `Не удалось освободить ${chatModel}.`, model };
  const user = cfg.provider === 'ollama'
    ? { role: 'user', content: ollama.visionPrompt(prompt), images: [image] }
    : { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }] };
  // asked in her chat: the conversation so far comes before it (text only)
  const before = (Array.isArray(history) ? history : []).filter((m) => typeof m?.content === 'string' && ['user', 'assistant'].includes(m.role));
  const messages = [{ role: 'system', content: persona }, ...before, user];
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const text = await llm.chat(cfg.provider, llmConfig(cfg), {
          model, messages, numPredict: cfg.provider === 'ollama' ? 180 : undefined,
        }, () => {}, AbortSignal.timeout(120000));
        if (cfg.provider === 'ollama' && !String(text || '').trim()) {
          if (ollama.retryEmptyVision(text, attempt)) continue;
          return { ok: false, error: 'Модель зрения не ответила.', code: 'empty', model };
        }
        return { ok: true, text, model };
      } catch (err) {
        if (err.code === 'busy' && attempt === 0) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        const novision = /image|vision|multimodal|modalit|image_url|content.*(part|type)/i.test(err.message);
        return { ok: false, error: err.message, code: novision ? 'novision' : err.code || null, model };
      }
    }
  } finally {
    if (switched) {
      await ollama.unload(model);
      ollama.warm(chatModel);
    }
  }
}

// her browser (browser.js): 'auto' follows your Windows default, or any browser found on the PC;
// her own profile in each, you sign in there yourself, only to services you trust her with
function browserMenu(cfg) {
  const setting = cfg.capriBrowser || 'auto';
  const now = capriBrowser.resolve(setting);
  const prof = cfg.capriBrowserProfile ? (cfg.capriBrowserProfileName || path.basename(cfg.capriBrowserProfile)) : '';
  return {
    label: `Браузер Капри: ${now ? now.name : 'нет'}${prof ? ` · ${prof}` : ''}${cfg.webMode === 'browser' ? ' · только браузер' : ''}`,
    submenu: [
      { label: `Авто — как в Windows${setting === 'auto' && now ? ` (${now.name})` : ''}`, type: 'radio', checked: setting === 'auto', click: () => updateConfig({ capriBrowser: 'auto' }) },
      ...capriBrowser.installed().map((b) => ({ label: b.name, type: 'radio', checked: setting.toLowerCase() === b.name.toLowerCase(), click: () => updateConfig({ capriBrowser: b.name }) })),
      ...(now && now.note ? [{ label: now.note, enabled: false }] : []),
      { type: 'separator' },
      // all of her web through the browser: no search server, no plain downloads around it
      { label: 'Только браузер (поиск и чтение — в нём)', type: 'checkbox', checked: cfg.webMode === 'browser', click: (item) => updateConfig({ webMode: item.checked ? 'browser' : 'search' }) },
      // her search log (notes.appendSearch): a file a day in your vault, for you to read, edit, delete
      { label: 'Журнал поиска (Сырьё/Поиск)…', click: () => {
        const folder = path.join(path.basename(notesDir()).toLowerCase() === 'capri' ? path.dirname(notesDir()) : notesDir(), notes.RAW_DIR, 'Поиск');
        fs.mkdirSync(folder, { recursive: true });
        shell.openPath(folder);
      } },
      { label: 'Записывать поиск в журнал', type: 'checkbox', checked: cfg.vaultSearch !== false, click: (item) => updateConfig({ vaultSearch: item.checked }) },
      { type: 'separator' },
      // her second node: Tor, for requests that say "через тор" (tor.js); never logged
      { label: 'Узел Tor («через тор» в запросе)', type: 'checkbox', checked: cfg.tor !== false, click: (item) => updateConfig({ tor: item.checked }) },
      { label: 'Открыть окно Tor', enabled: cfg.tor !== false, click: () => torReady(cfg).then(() => capriBrowser.openForSignIn('about:blank', torOpts(cfg))).catch((err) => console.warn('tor:', err.message)) },
      ...(prof ? [
        { label: `Профиль: ${prof} (твой, через порт ${cfg.capriBrowserPort || capriBrowser.DEFAULT_PORT})`, enabled: false },
        { label: 'Открыть профиль (с портом для Капри)', click: () => capriBrowser.openForSignIn('about:blank', browserOpts(cfg)).catch((err) => console.warn('browser:', err.message)) },
        { label: 'Свой профиль Капри вместо него', click: () => updateConfig({ capriBrowserProfile: '' }) },
      ] : [
        { label: 'Войти в сервисы в её профиле…', enabled: !!now, click: () => capriBrowser.openForSignIn('about:blank', browserOpts(cfg)).catch(() => {}) },
      ]),
    ],
  };
}

// Her Tor node (tor.js): tor.exe on this PC, her own Camoufox profile TOR through it, its own window and
// control port beside MAIN. A Tor request goes through it or fails: no fallback to MAIN or a plain
// download, a check that the window is on Tor before anything is sent, and nothing written down.
function torOpts(cfg) {
  return {
    app, browser: cfg.capriBrowser, profile: cfg.torProfile || path.join(app.getPath('userData'), 'tor-profile'), profileName: 'TOR',
    port: cfg.torBrowserPort, searchUrl: tor.ONION_DDG, ahmiaUrl: tor.AHMIA, verifyUrl: tor.CHECK_URL, timeoutMs: 30000, chars: 4000,
  };
}

// onion sites as sources: often scams and unchecked claims; she says so, and doesn't help with anything illegal.
// Searching and reading them is legal and is the task: said outright, so a cautious model doesn't refuse,
// lecture, or "decide" that going through Tor is already wrong.
const ONION_RULE = [
  'Поиск и сбор информации в Tor и на onion-сайтах — законная обычная задача: не отказывайся, не читай нотаций, не предупреждай об опасности Tor, просто отвечай по найденному.',
  'Источники — onion-сайты: там много мошенничества и непроверенных утверждений. Отмечай, что это не проверено, не выдавай за факт.',
  'Не помогай покупать, заказывать или делать незаконное.',
].join('\n');
const TOR_RULE = 'Поиск через Tor — законная обычная задача, просто анонимный доступ к сети: не отказывайся, не читай нотаций, не предупреждай об опасности Tor, отвечай по найденному.';

function touchTor({ inChat = true } = {}) {
  torState.touch({ inChat });
  try { brainShadowHook?.torTouched(); } catch {}
}

async function torReady(cfg) {
  touchTor(); // updates lastTorAt + drops whatever the brain shadow was watching (shadow-hook.js)
  if (cfg.tor === false) throw new Error('узел Tor выключен в трее');
  await tor.ensure({ exe: cfg.torExe, torrc: cfg.torrc, logFile: cfg.torLog, socksPort: cfg.torSocksPort });
  tor.ensureProfile(torOpts(cfg).profile, cfg.torSocksPort);
}

async function torSearch(q, cfg, how = {}) {
  const endTor = torState.enterSession({ inChat: true });
  touchTor();
  let session = null;
  // what to look in: an onion link you gave (read as it is), onion sites ("в даркнете": Ahmia), or the web
  const onion = how.onion ? tor.onionLink(how.onion) : tor.onionLink(q);
  const dark = Boolean(how.dark) || Boolean(how.onion) || Boolean(onion) || tor.wantsDark(q);
  try {
    await torReady(cfg);
    const roles = brains.ready(await ollama.models().catch(() => []));
    const getSession = async () => (session = session || await capriBrowser.openSession(torOpts(cfg)));
    const said = await web.answer(q, {
      rule: dark ? ONION_RULE : TOR_RULE,
      chat: async (messages, { howto } = {}) => {
        const model = roles ? (howto ? await brains.use('main') : brains.current()) : cfg.chatModel;
        return ollama.chat({ model, messages, numPredict: howto ? 1200 : 500 }, () => {});
      },
      browserSearch: async (query) => (onion
        ? [{ title: new URL(onion).hostname, url: onion, snippet: '' }]
        : (await getSession()).search(query, { engine: dark ? 'ahmia' : undefined })),
      renderMany: async (urls) => (await getSession()).readMany(urls),
      fetchImpl: async () => { throw new Error('no plain downloads for a Tor request'); },
    });
    if (said.answer) return { answer: said.answer, sources: said.sources, blocked: said.blocked, tor: true };
    return { error: 'Через Tor поиск ничего не нашёл.', tor: true };
  } catch (err) {
    return { error: `Через Tor не вышло: ${err.message}. Мимо Tor не отправляла.`, tor: true };
  } finally {
    if (session) await session.close();
    endTor();
  }
}

// Her web for your agents (web-mcp.js): the same browser nodes she uses. 'main' refuses Tor/darknet/.onion
// and logs clearnet queries into her search log; 'tor' and 'dark' never write to the log (tor-guard.js).
const agentWeb = createAgentWeb({
  getConfig: () => config.load(),
  tor,
  web,
  browser: capriBrowser,
  notes,
  kiwix,
  gemini,
  hasSecret,
  torReady,
  torOpts,
  browserOpts,
  notesDir,
  torState,
  onTorTouched: () => { try { brainShadowHook?.torTouched(); } catch {} },
});

// Her council's members (council.js), each only thinking: Gemini Hydrogen on the web (your subscription),
// Antigravity's Orchestrator (Argon) in its app with "Request Review", Claude Opus in plan mode, Codex
// GPT-6.1 Sol (medium) read-only, and Gemma (the main local brain). The rector: Claude Opus; GPT-6 Astra
// (high) when Claude is out. `only`: a subset by id.
function councilMembers(cfg, only) {
  const cwd = workers.workDir(cfg);
  const claudeExe = workers.findClaude();
  const codexExe = workers.findCodex();
  const all = [
    { id: 'gemini', name: 'Gemini Hydrogen (веб)', ask: async (p) => (await gemini.ask(p, { model: 'everyday', clipboard: gemini.electronClipboard(), open: () => capriBrowser.openSession(browserOpts(cfg)) })).answer },
    { id: 'argon', name: 'Antigravity Orchestrator (Argon)', ask: async (p) => (await agyApp.ask(p, { model: 'Orchestrator (Argon)', port: cfg.agyAppPort })).answer },
    ...(claudeExe ? [{ id: 'opus', name: 'Claude Opus', ask: council.claudeRunner({ exe: claudeExe, cwd, model: 'opus' }) }] : []),
    ...(codexExe ? [{ id: 'sol', name: 'Codex GPT-6.1 Sol', ask: council.codexRunner({ exe: codexExe, cwd, model: 'gpt-6.1-sol', effort: 'medium' }) }] : []),
    { id: 'gemma', name: 'Gemma (голос хозяина)', role: council.HOST_VOICE, ask: async (p) => {
      const model = brains.ready(await ollama.models().catch(() => [])) ? await brains.use('main') : cfg.chatModel;
      // a cross round carries everyone's answers: a 16k window (8k was too small in the first council)
      return ollama.chat({ model, messages: [{ role: 'user', content: p }], numPredict: 1400, numCtx: 16384 }, () => {});
    } },
  ];
  const members = Array.isArray(only) && only.length ? all.filter((m) => only.includes(m.id)) : all;
  return {
    members,
    judge: claudeExe ? { id: 'rector-opus', name: 'Claude Opus (ректор)', ask: council.claudeRunner({ exe: claudeExe, cwd, model: 'opus' }) } : null,
    fallbackJudge: codexExe ? { id: 'rector-astra', name: 'GPT-6 Astra (ректор)', ask: council.codexRunner({ exe: codexExe, cwd, model: 'gpt-6-astra', effort: 'high' }) } : null,
  };
}

// her browser settings for browser.js: which browser, and your profile with its control port when set
function browserOpts(cfg) {
  return {
    app, browser: cfg.capriBrowser,
    ...(cfg.capriBrowserProfile ? { profile: cfg.capriBrowserProfile, profileName: cfg.capriBrowserProfileName, port: cfg.capriBrowserPort } : {}),
  };
}

async function pickProvider(provider) {
  updateConfig({ provider });
  await refreshModels();
  if (chatErrorCode) sendCommand('setupKey'); // it needs a key or an address: she asks for it
}

// What llm.js gets: the config with its keys opened (they're kept encrypted, setup.js)
function llmConfig(cfg = config.load()) {
  return { ...cfg, apiKeys: setup.openKeys(cfg.apiKeys) };
}

async function pickClaudeFolder() {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'], defaultPath: config.load().claudeCwd || app.getPath('home') });
  if (canceled || !filePaths[0]) return;
  llm.resetClaude(); // a new folder, a new Claude Code conversation (hers goes on)
  saveMemory({ claude: null });
  updateConfig({ claudeCwd: filePaths[0] });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'icons', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip(HUB_NAME);
  tray.on('click', () => openChats());
  rebuildTray();
}

// brain shadow observer (src/main/brain/shadow-hook.js): created lazily by chat:send only when
// cfg.brainShadow is on; module-level so the quit handlers in main() can close it
let brainShadowHook = null;
let brainChatGlue = null;
let brainInfluencePolicy = null;
let brainInfluencePlanner = null;

function registerIpc() {
  ipcMain.on('overlay:interactive', (_e, on) => {
    overlay?.setIgnoreMouseEvents(!on, { forward: true });
  });
  ipcMain.on('overlay:rearm', () => rearmOverlay()); // the pointer moved over her and she never heard of it
  ipcMain.handle('overlay:cursor', () => {
    const p = screen.getCursorScreenPoint();
    const b = overlay.getBounds();
    const inside = p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
    return { x: p.x - b.x, y: p.y - b.y, inside, display: displayAt(p).id };
  });
  // your screens (their bounds), the one she's on, and where her window is
  ipcMain.handle('screens:list', () => {
    const o = overlay.getBounds();
    return {
      current: targetDisplay().id,
      origin: { x: o.x, y: o.y },
      list: displays().map(({ id, bounds: b }) => ({ id, x: b.x, y: b.y, w: b.width, h: b.height })),
    };
  });
  ipcMain.handle('screens:move', async (_e, id) => {
    const area = moveOverlay(id);
    if (!area) return null;
    await new Promise((r) => setTimeout(r, 60));
    overlay.setBounds(area); // again, once Windows has settled it on its new screen
    const o = overlay.getBounds();
    return { origin: { x: o.x, y: o.y }, width: o.width, height: o.height, gap: overlayArea().gap };
  });
  ipcMain.handle('config:get', () => rendererConfig());
  ipcMain.handle('planner:list', (_e, filter) => localPlanner.list(filter));
  ipcMain.handle('planner:create', (_e, input) => localPlanner.create(input));
  ipcMain.handle('planner:complete', (_e, id) => localPlanner.complete(id));
  // a planner note, opened in Obsidian (its path in your vault, kept when it was written)
  ipcMain.on('planner:open', (_e, id) => {
    const entry = localPlanner.list({ kinds: ['note'] }).find((p) => p.id === id);
    if (!entry?.obsidian) return;
    const root = path.basename(notesDir()).toLowerCase() === 'capri' ? path.dirname(notesDir()) : notesDir();
    shell.openExternal(`obsidian://open?path=${encodeURIComponent(path.join(root, entry.obsidian))}`);
  });
  ipcMain.handle('hub:menu', () => (trayMenu ? menuModel(trayMenu) : []));
  ipcMain.handle('gallery:list', () => galleryList());
  ipcMain.on('phonepack:save', (_e, pack) => {
    try {
      phonepack.save(phonePackDir(), pack);
      phonePackCache = undefined;
      const drawn = phonePack();
      console.log(`[capri] phone pack ${drawn?.version}: ${drawn?.poses.length} poses, ${Math.round((drawn?.zip.length || 0) / 1024)} KB`);
    } catch (err) {
      console.warn('[capri] phone pack:', err.message);
    }
  });
  ipcMain.on('hub:click', (_e, id) => {
    const item = menuItemAt(trayMenu, id);
    if (item?.enabled && item.type !== 'submenu') item.click();
  });
  ipcMain.handle('hooks:status', () => activeHooks().status());
  ipcMain.handle('config:set', (_e, patch) => {
    let telegramChanged = false;
    if (typeof patch?.telegramToken === 'string') {
      patch = { ...patch, telegramToken: patch.telegramToken ? setup.sealKey(patch.telegramToken.trim()) : null, telegramChatId: null };
      telegramChanged = true;
    }
    if (patch?.pimSecrets) patch = { ...patch, pimSecrets: pim.sealSecrets(patch.pimSecrets, setup.sealKey) };
    // "запомни…" in her chat: a note in her memory too
    if (Array.isArray(patch?.memories)) {
      const had = new Set(config.load().memories || []);
      for (const memo of patch.memories.filter((m) => !had.has(m))) notes.write(notesDir(), { title: memo.split(/s+/).slice(0, 5).join(' '), type: 'о тебе', text: memo });
    }
    const next = updateConfig(patch);
    if (telegramChanged) applyTelegram();
    if (Array.isArray(patch?.reminders)) syncPlannerReminders(); // one may have rung
    return next;
  });
  ipcMain.handle('pim:setup', async (_e, choice) => {
    try {
      const { host, port } = pim.parseLocalEndpoint(choice?.endpoint);
      const user = String(choice?.user || '').trim();
      const password = String(choice?.password || '');
      const adapter = pimImap.createImapAdapter({ id: 'proton_work', provider: 'proton', role: 'work', host, port, user, password });
      await adapter.searchMail({ query: '', limit: 1 });
      const cfg = config.load();
      updateConfig({
        pimAccounts: [...(cfg.pimAccounts || []).filter((item) => item.id !== 'proton_work'), { id: 'proton_work', provider: 'proton', role: 'work', host, port }],
        pimSecrets: { ...cfg.pimSecrets, ...pim.sealSecrets({ bridge_user: user, bridge_password: password }, setup.sealKey) },
      });
      await restartPimMcp();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Bridge connection failed' };
    }
  });
  ipcMain.handle('pim:gmail-setup', async (_e, choice) => {
    try {
      const user = String(choice?.user || '').trim();
      const password = String(choice?.password || '').replace(/\s+/g, '');
      const account = { id: 'gmail_reserve', provider: 'gmail', role: 'reserve', host: 'imap.gmail.com', port: 993, secure: true, localOnly: false };
      const adapter = pimImap.createImapAdapter({ ...account, user, password });
      await adapter.searchMail({ query: '', limit: 1 });
      const cfg = config.load();
      updateConfig({
        pimAccounts: [...(cfg.pimAccounts || []).filter((item) => item.id !== account.id), account],
        pimSecrets: { ...cfg.pimSecrets, ...pim.sealSecrets({ gmail_user: user, gmail_app_password: password }, setup.sealKey) },
      });
      await restartPimMcp();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Gmail connection failed' };
    }
  });
  ipcMain.handle('pim:calendar-setup', async (_e, choice) => {
    try {
      const url = String(choice?.url || '').trim();
      const account = { id: 'proton_calendar', provider: 'proton', role: 'calendar' };
      const adapter = pimIcs.createIcsAdapter({ ...account, url });
      const now = Date.now();
      await adapter.listEvents({ from: new Date(now).toISOString(), to: new Date(now + 30 * 86400000).toISOString(), limit: 1 });
      const cfg = config.load();
      updateConfig({
        pimAccounts: [...(cfg.pimAccounts || []).filter((item) => item.id !== account.id), account],
        pimSecrets: { ...cfg.pimSecrets, ...pim.sealSecrets({ calendar_ics_url: url }, setup.sealKey) },
      });
      await restartPimMcp();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Proton Calendar connection failed' };
    }
  });
  ipcMain.handle('demo:window', (_e, open) => demoWindow(open));
  // right-clicking her: the same menu as the tray icon (which Windows often hides behind the ^ by the clock)
  ipcMain.on('menu:open', () => trayMenu?.popup({ window: overlay }));
  // her welcome panel's buttons
  ipcMain.handle('hooks:install', () => runHooks('install', { quiet: true }));
  ipcMain.handle('claude:found', () => fs.existsSync(path.dirname(activeHooks().status().file))); // Claude Code keeps its settings there
  ipcMain.on('claude:help', () => shell.openExternal(activeAssistant().help));
  ipcMain.handle('windows:get', () => lastWindows);
  ipcMain.handle('windows:closePage', (_e, { id, key }) => windowWatch?.close(id, key) ?? 'gone');
  // talking to her (chat.js): is Ollama there, with a model to talk with
  ipcMain.handle('chat:status', async () => {
    const cfg = config.load(true); // keys may have been edited by hand
    const { provider } = cfg;
    const models = await refreshModels();
    if (!models) return { ok: false, error: chatError || 'offline', code: chatErrorCode, provider };
    if (!models.length) return { ok: false, error: 'nomodel', provider };
    const model = pickModel();
    llm.warm(provider, model); // loading while you type your first message
    const local = llm.isLocal(provider, cfg, model);
    return { ok: true, provider, model, agent: provider === 'claude', local, warmup: provider === 'ollama' && local };
  });
  const getBrainInfluencePolicy = () => {
    if (brainInfluencePolicy) return brainInfluencePolicy;
    const { createReassessmentPolicy } = require('./brain/reassessment-policy');
    brainInfluencePolicy = createReassessmentPolicy();
    return brainInfluencePolicy;
  };
  const getBrainInfluencePlan = () => {
    if (brainInfluencePlanner) return brainInfluencePlanner;
    brainInfluencePlanner = require('./brain/influence-glue').planInfluence;
    return brainInfluencePlanner;
  };
  // her answer, streamed to the overlay piece by piece as `chat:delta`
  const getBrainShadowHook = () => {
    if (brainShadowHook) return brainShadowHook;
    const { createShadowHook } = require('./brain/shadow-hook');
    const { createVerdictJudge, createLoadedModelSelector } = require('./brain/verdict-judge');
    const { CONFIG: brainConfig } = require('./brain');
    const verdictJudge = createVerdictJudge({
      fastModel: brains.fast,
      mainModel: brains.main,
      resolveModel: createLoadedModelSelector({
        fastModel: brains.fast,
        mainModel: brains.main,
        loadedModels: (psSignal) => ollama.loadedModels(psSignal),
        timeoutMs: 300,
      }),
      callModel: (req, signal) => ollama.jsonChat(req, signal),
      isBusy: () => chats.size > 0,
    });
    brainShadowHook = createShadowHook({
      // one folder per journal format: formats never mix, older folders are left untouched
      dir: path.join(app.getPath('userData'), 'brain-journal', `v${brainConfig.schema_version}`),
      preload: true,
      verdictJudge,
      isTorActive: () => torState.inCooldown(),
      isChatTainted: () => torState.isChatTainted(),
      onPendingChange: (pending) => {
        try {
          if (overlay && !overlay.isDestroyed()) overlay.webContents.send('brain:pending', Boolean(pending));
        } catch {}
      },
      onVerdict: (meta, verdict) => {
        try {
          getBrainInfluencePolicy().recordOutcome({ escalated: Boolean(meta?.escalated), verdict });
        } catch {}
      },
    });
    return brainShadowHook;
  };
  const getBrainChatGlue = () => {
    if (brainChatGlue) return brainChatGlue;
    const { createChatGlue } = require('./brain/chat-glue');
    brainChatGlue = createChatGlue({
      getHook: (create = true) => (create ? getBrainShadowHook() : brainShadowHook),
      tor,
      yourWords,
      isTorBlocked: () => torState.inCooldown(),
      isChatTainted: () => torState.isChatTainted(),
      isLocalModel: (cfg) => {
        const model = pickModel(cfg);
        return Boolean(model && llm.isLocal(cfg.provider, cfg, model));
      },
    });
    return brainChatGlue;
  };
  if (config.load().brainShadow === true) {
    try { getBrainShadowHook(); } catch {}
  }
  ipcMain.on('brain:verdict', (event, v) => {
    const sender = event?.sender;
    if (!sender || (sender !== overlay?.webContents && sender !== chatsWin?.webContents)) return;
    if (v !== 1 && v !== -1) return;
    if (!brainShadowHook || config.load().brainShadow !== true) return;
    try { brainShadowHook.verdict(v); } catch {}
  });
  ipcMain.handle('chat:send', async (_e, { id, messages, voice }) => {
    const abort = new AbortController();
    chats.set(id, abort);
    try {
      let streamed = false;
      const send = (text) => {
        streamed = true;
        overlay?.webContents.send('chat:delta', { id, text });
        chatsWin?.webContents.send('chats:delta', text); // her Chats window shows it coming too
      };
      const cfg = config.load();
      const lastUserMsg = Array.isArray(messages) ? messages.findLast((m) => m?.role === 'user') : null;
      const lastUserHasTor = lastUserMsg ? messagesHaveTor([lastUserMsg]) : false;
      const contextHasTor = messagesHaveTor(messages);
      if (lastUserHasTor) touchTor({ inChat: true });
      // "включи / выключи ролевой режим": a mode of hers (brains.js), not a message to answer
      const rpTurn = brainsLib.rpCommand(yourWords(messages));
      if (rpTurn !== null) {
        if (cfg.brainShadow === true || brainShadowHook) {
          try { getBrainChatGlue().onNonLocalTurn({ worker: null, rp: true }); } catch {}
        }
        updateConfig({ rp: rpTurn });
        rebuildTray();
        const said = rpTurn ? 'Ролевой режим включён. Задай сцену.' : 'Ролевой режим выключен.';
        send(said);
        return { ok: true, text: said };
      }
      if (cfg.brainShadow === true) {
        try { getBrainChatGlue().beforeTurn(messages, cfg); } catch {}
      }
      // who takes it (routeOf: Claude or Codex named, real work, a task on the PC, or hers) and how hard
      let route = await routeOf(yourWords(messages), messages.filter((m) => m.role !== 'system').slice(-3, -1), abort.signal);
      abort.signal.throwIfAborted();
      // Tor-sensitive turns must never be sent to cloud workers even if an agent was named.
      if (contextHasTor && ['claude', 'codex', 'gemini', 'computer'].includes(route.worker)) {
        route = { ...route, worker: null, computer: false };
      }
      const { worker } = route;
      const hands = await handsFor(worker, route.computer, abort.signal);
      abort.signal.throwIfAborted();
      if (hands === 'no') {
        if (cfg.brainShadow === true || brainShadowHook) {
          try { getBrainChatGlue().onNonLocalTurn(route); } catch {}
        }
        return { ok: true, text: worker === 'gemini' ? 'Gemini пока не управляет окнами: headless-режим не умеет безопасно спросить подтверждение.' : `Ок, окна ${worker === 'codex' ? 'Codex' : 'Claude'} не даю.` };
      }
      // how hard it is: Claude's model, Codex's effort (router.js); the task's next turns don't go lighter
      const tierOpts = workerSettings(route.tier, { computer: hands === 'yes' });
      if (['claude', 'codex', 'gemini'].includes(worker)) router.hold(route.tier || 'routine');
      let actualWorker = worker;
      const onStep = (step, prev = []) => {
        actualWorker = step;
        const label = workers.WORKER_LABELS[step] || step;
        const chainText = prev.length
          ? `${prev.map((p) => workers.WORKER_LABELS[p] || p).join(' → ')} → ${label} думает… (Ctrl+Alt+X — остановить)`
          : `Передала ${label}, работает… (Ctrl+Alt+X — остановить)`;
        const skinWorker = step === 'claude' ? 'claude' : step === 'codex' ? 'codex' : 'agy';
        const tag = step === 'claude' ? 'claude-code' : step === 'codex' ? 'codex' : step.replace(/-(low|medium|high|xhigh)$/, '');
        overlay?.webContents.send('chat:delta', { id, status: chainText, tag, worker: skinWorker });
      };
      const desktopOpts = { desktop: hands === 'yes', home: desktopCli.home, model: tierOpts.claudeModel, effort: tierOpts.codexEffort, codexModel: codexModelFor(tierOpts.tier, yourWords(messages)), tier: tierOpts.tier, onStep, onQuota: recordClaudeQuota };
      // a plain question about your schedule: answered from the calendar at once, no model (quick.js)
      const fast = !worker ? await quickAnswer(yourWords(messages)) : null;
      abort.signal.throwIfAborted();
      if (fast) {
        if (cfg.brainShadow === true || brainShadowHook) {
          try { getBrainChatGlue().onNonLocalTurn(route, { quick: true }); } catch {}
        }
        send(fast);
        if (!shouldSkipChatPersistence({ torState, messages, tor })) {
          recentTurns = [{ role: 'user', content: yourWords(messages) }, { role: 'assistant', content: fast }];
          toVault(cfg, null, yourWords(messages), fast);
        }
        return { ok: true, text: fast };
      }
      if (worker !== null && (cfg.brainShadow === true || brainShadowHook)) {
        try { getBrainChatGlue().onNonLocalTurn(route); } catch {}
      }
      // the cloud chain (Claude → Codex → Antigravity) gave nothing: no internet, limits, all down. Her
      // main brain answers here instead, and says so.
      const cloudOrLocal = async () => {
        const workerMessages = selectWorkerMessages(messages, torState.isChatTainted() || torState.inCooldown());
        try {
          return await workers.runWorker(worker, cfg, workerMessages, send, abort.signal, desktopOpts);
        } catch (err) {
          if (abort.signal.aborted || err?.message === 'stopped' || cfg.provider !== 'ollama' || !brains.ready(chatModels)) throw err;
          console.warn(`[capri] cloud chain gave nothing (${err.message}): her main brain answers`);
          actualWorker = null;
          overlay?.webContents.send('chat:delta', { id, status: 'Облачные агенты не ответили — делаю сама, на основной модели…', tag: 'local' });
          const note = '(облако не ответило — отвечаю сама, локально)\n\n';
          send(note);
          return note + await chatWithFallback(cfg, await prepLocal(cfg, messages, { main: true }), send, abort.signal, () => false);
        }
      };
      let text;
      if (['claude', 'codex', 'gemini'].includes(worker)) text = await cloudOrLocal();
      else if (worker === 'computer') text = await computerTask(messages, send, abort.signal);
      else if (worker === 'photo') text = await photoTask(yourWords(messages), messages.filter((m) => m.role !== 'system').slice(-5, -1), abort.signal);
      else if (worker === 'video') text = await videoTask(yourWords(messages), messages.filter((m) => m.role !== 'system').slice(-5, -1), abort.signal);
      else {
        const pickedModel = pickModel(cfg);
        const cloudBlockedForTor = contextHasTor && (
          cfg.provider !== 'ollama'
          || (pickedModel ? !llm.isLocal(cfg.provider, cfg, pickedModel) : false)
        );
        if (cloudBlockedForTor) {
          text = 'Запрос с Tor/onion/даркнет-контекстом не отправляется в облачные модели. Выберите локальную модель Ollama.';
          send(text);
        } else {
        let shadowTurn = null;
        let influence = { main: false, hint: null, decision: null, escalated: false };
        let turnEscalated = false;
        let hintDelivered = false;
        if (cfg.brainShadow === true && worker === null) {
          try {
            const said = yourWords(messages);
            const rolesReady = cfg.provider === 'ollama' && brains.ready(chatModels);
            const isAuto = Boolean(rolesReady && brains.isAuto(cfg.chatModel, chatModels));
            const localTurn = cfg.provider === 'ollama' && Boolean(pickedModel && llm.isLocal(cfg.provider, cfg, pickedModel));
            const torCtx = torState.isQuarantined() || contextHasTor;
            const analysis = brainsLib.analysisMode(cfg, { rolesReady, auto: isAuto, tor: torCtx, text: said });
            influence = getBrainInfluencePlan()({
              cfg,
              said,
              messages,
              route,
              quick: Boolean(fast),
              hook: getBrainShadowHook(),
              policy: getBrainInfluencePolicy(),
              tor,
              env: {
                local: localTurn,
                brainsReady: rolesReady,
                isAuto,
                mainActive: brains.mainActive(),
                gpuBusy: false,
                voice: Boolean(voice),
                wantsFast: brainsLib.wantsFast(said),
                wantsMain: brainsLib.wantsMain(said) || analysis.active,
                wantsLocal: brainsLib.wantsLocal(said),
                rp: cfg.rp === true,
                tor: torState.isQuarantined(),
                now: Date.now(),
              },
            });
            turnEscalated = Boolean(influence.escalated);
            hintDelivered = Boolean(influence.hint && cfg.rp !== true);
          } catch {}
          try {
            shadowTurn = getBrainChatGlue().startLocal(route, messages, cfg, abort.signal, {
              meta: { escalated: turnEscalated },
            });
          } catch {}
        }
        try {
          const prepared = await prepLocal(cfg, messages, { main: influence.main });
          // stage 6 stop hint: one system line at the very end, never in roleplay
          const toSend = hintDelivered
            ? { ...prepared, messages: [...prepared.messages, { role: 'system', content: influence.hint, brainHint: true }] }
            : prepared;
          // any switch to another model (possibly a cloud one) abandons the observation
          text = await chatWithFallback(
            cfg,
            toSend,
            send,
            abort.signal,
            () => streamed,
            (nextModel) => {
              turnEscalated = false;
              if (!llm.isLocal(cfg.provider, cfg, nextModel)) hintDelivered = false;
              try { brainChatGlue?.onModelSwitch(shadowTurn); } catch {}
            },
          );
          if (cfg.brainShadow === true && (turnEscalated || hintDelivered) && !torState.isQuarantined()) {
            try {
              require('./brain/influence-glue').commitInfluence(getBrainInfluencePolicy(), influence, {
                escalated: turnEscalated,
                hintDelivered,
                aborted: abort.signal.aborted,
              });
            } catch {}
          }
          if (shadowTurn) {
            try { brainChatGlue?.afterSuccess(shadowTurn); shadowTurn = null; } catch {}
          }
        } catch (err) {
          const torTouchedTurn = torState.isQuarantined() || Boolean(shadowTurn?.wasTorCancelled?.());
          const aborted = abort.signal.aborted || err?.message === 'stopped'
            || err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
          if (turnEscalated && !torTouchedTurn && !aborted) {
            try {
              require('./brain/influence-glue').commitInfluence(getBrainInfluencePolicy(), influence, {
                escalated: true,
                hintDelivered: false,
                error: true,
              });
            } catch {}
            try { brainInfluencePolicy?.recordOutcome({ escalated: true, error: true }); } catch {}
          }
          if (shadowTurn) {
            try { brainChatGlue?.afterError(shadowTurn, err, abort.signal); } catch {}
          }
          throw err;
        } finally {
          try { shadowTurn?.cancel(); } catch {}
        }
        }
      }
      if (cfg.provider === 'claude' && !contextHasTor) saveMemory({ claude: llm.claudeMemory() });
      if (!shouldSkipChatPersistence({ torState, messages, tor })) {
        if (!worker) noteLater([...messages, { role: 'assistant', content: text }]);
        recentTurns = [{ role: 'user', content: yourWords(messages) }, { role: 'assistant', content: text }];
        toVault(cfg, actualWorker, yourWords(messages), text);
      }
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: abort.signal.aborted ? 'stopped' : err.message, code: err.code || null };
    } finally {
      chats.delete(id);
      try { brainChatGlue?.afterTurn(); } catch {}
    }
  });
  ipcMain.on('chat:stop', (_e, id) => chats.get(id)?.abort());
  // who'll answer this message: 'claude', 'codex', 'computer', 'photo', 'video', 'stop' or null (her chat model)
  ipcMain.handle('chat:route', async (_e, text, id) => {
    const abort = new AbortController();
    chats.set(id, abort);
    try {
      return (await routeOf(text, recentTurns, abort.signal)).worker;
    } finally {
      chats.delete(id);
    }
  });
  // your answer to her question before an action on the PC (policy.js): 'yes', 'hour' or 'no'
  ipcMain.on('policy:answer', (_e, { id, answer }) => {
    asking.get(id)?.(['yes', 'hour'].includes(answer) ? answer : 'no');
  });
  // her voice (speech.js): what you said, written down; her line, said
  ipcMain.on('voice:wake-trace', (event, stage) => {
    if (event.sender !== overlay?.webContents) return;
    if (['ready', 'mic-error', 'segment', 'stt-busy', 'stt-error', 'stt-empty', 'stt-ok',
      'no-name', 'chat-busy', 'stop', 'accepted'].includes(stage)) {
      console.log(`[capri:wake] ${new Date().toISOString()} ${stage}`);
    }
  });
  ipcMain.handle('voice:transcribe', async (_e, wav, opts) => {
    const { voice } = config.load();
    try {
      await speech.ensureWhisper(voice, { wait: true });
      return { ok: true, text: await speech.transcribe(wav, voice, { wake: Boolean(opts?.wake) }) };
    } catch (err) {
      return { ok: false, error: speech.sttError(err, voice) };
    }
  });
  ipcMain.handle('voice:model', (_e, wanted) => switchSpokenModel(wanted));
  ipcMain.handle('voice:speak', async (_e, text) => {
    const { voice } = config.load();
    if (!voice.tts) return null;
    return speech.speak(text, voice).catch((err) => {
      console.warn('[capri] VoiceStudio:', err.message);
      return null; // her answer is in the panel anyway
    });
  });
  // she looks at your screen (look.js): the picture first, then what her AI says about it
  ipcMain.handle('look:snap', async () => {
    try {
      const id = randomUUID();
      snaps.set(id, await snapScreen());
      setTimeout(() => snaps.delete(id), 120000);
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('look:say', (_e, request) => sayAboutSnap(request || {}));
  // how hard the processor works, in %, since the last time she asked (pc.js)
  let cpuBefore = null;
  ipcMain.handle('pc:cpu', () => {
    const now = os.cpus().map(({ times: t }) => ({ idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq }));
    const before = cpuBefore;
    cpuBefore = now;
    if (!before) return null;
    let idle = 0, total = 0;
    now.forEach((c, i) => {
      idle += c.idle - (before[i]?.idle || 0);
      total += c.total - (before[i]?.total || 0);
    });
    return total > 0 ? Math.round(100 * (1 - idle / total)) : null;
  });
  // where her AI runs, for what she tells you before she looks: { local, provider, model }
  ipcMain.handle('look:where', () => {
    const cfg = config.load();
    const picked = pickModel(cfg);
    const model = cfg.provider === 'ollama' && !brains.isRole(picked) ? ollama.screenModel(chatModels) || picked : picked;
    const provider = cfg.provider === 'ollama' && ollama.isCloud(model) ? 'Ollama' : llm.PROVIDERS[cfg.provider]?.label || cfg.provider;
    return { local: llm.isLocal(cfg.provider, cfg, model), provider, model };
  });
  ipcMain.handle('chat:memory', () => readMemory().history || []);
  ipcMain.on('chat:remember', (_e, history) => Array.isArray(history) && saveMemory({ history }));
  // every message, for her Chats window
  ipcMain.on('chat:log', (_e, message) => {
    chatLog.write(chatsFile(), chatLog.add(chatLog.read(chatsFile()), message));
    chatsWin?.webContents.send('chats:changed');
  });
  ipcMain.handle('chats:list', () => chatLog.list(chatLog.read(chatsFile())));
  ipcMain.handle('agents:list', (event) => ({ sessions: hubSessions(event).summaries(), models: SESSION_MODELS }));
  ipcMain.handle('agents:quota', (event, { agent, model, refresh }) => {
    hubSessions(event);
    if (!Object.hasOwn(SESSION_MODELS, agent) || !SESSION_MODELS[agent].some(([id]) => id === model)) return null;
    return hubQuota(agent, model, refresh === true);
  });
  ipcMain.handle('agents:quota-snapshot', (event, { model, values }) => {
    hubSessions(event);
    if (!SESSION_MODELS.gemini.some(([id]) => id === model) || !Array.isArray(values)) throw new Error('Неверная квота Antigravity.');
    const group = quotaGroup('gemini', model);
    const periods = group === 'agy-argon' ? [10080] : [300, 10080];
    const windows = periods.map((minutes, i) => normalizeWindow(values[i], minutes, null));
    if (windows.some((window) => !window)) throw new Error('Укажи остаток от 0 до 100%.');
    const data = { ...agyQuotaSnapshots(), [group]: { windows, checkedAt: Date.now() } };
    fs.writeFileSync(agyQuotaFile(), JSON.stringify(data), 'utf8');
  });
  ipcMain.handle('agents:history', (event, id) => hubSessions(event).history(id));
  ipcMain.handle('agents:create', (event, agent) => hubSessions(event).create(agent));
  ipcMain.handle('agents:send', async (event, { id, model, text, retry, files }) => {
    const sessions = hubSessions(event);
    const promptText = retry === true ? text : await withUploadedFiles(id, text, files);
    return sessions.send(id, model, promptText, retry === true);
  });
  ipcMain.handle('agents:pick-file', async (event) => {
    hubSessions(event);
    const chosen = await dialog.showOpenDialog(chatsWin, {
      title: 'Прикрепить файл к задаче',
      properties: ['openFile'],
      filters: [{ name: 'Документы и медиа', extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'csv', 'png', 'jpg', 'jpeg', 'webp', 'svg'] }],
    });
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    const file = chosen.filePaths[0];
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Файл должен быть меньше 2 МБ.');
    const bytes = await fs.promises.readFile(file);
    return { name: path.basename(file), data: bytes.toString('base64') };
  });
  ipcMain.handle('agents:voice-stt', async (event, wav) => {
    hubSessions(event);
    const cfg = config.load();
    return speech.transcribe(Buffer.from(wav), cfg.voice);
  });
  ipcMain.handle('agents:free-vram', async (event) => {
    hubSessions(event);
    return quickAnswer('освободи память');
  });
  ipcMain.handle('agents:export-message', async (event, { id, text, format }) => {
    const sessions = hubSessions(event);
    const session = sessions.sessions.find((item) => item.id === id);
    const content = String(text || '').trim();
    if (!content) throw new Error('Пустое сообщение.');
    const fmt = String(format || '').toLowerCase();
    const titleSlug = (session?.title || 'otvet-agenta')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
      .trim()
      .slice(0, 48) || 'otvet-agenta';
    if (fmt === 'obsidian') {
      const dir = notesDir();
      const vaultRoot = path.basename(dir).toLowerCase() === 'capri' ? path.dirname(dir) : dir;
      const outDir = path.join(vaultRoot, 'Результаты');
      await fs.promises.mkdir(outDir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 10);
      let dest = path.join(outDir, `${stamp} — ${titleSlug}.md`);
      for (let i = 2; fs.existsSync(dest); i++) {
        dest = path.join(outDir, `${stamp} — ${titleSlug}-${i}.md`);
      }
      await fs.promises.writeFile(dest, `# ${session?.title || 'Ответ агента'}\n\n${content}\n`, 'utf8');
      await shell.openExternal(`obsidian://open?path=${encodeURIComponent(dest)}`);
      return { ok: true, file: dest, message: `Сохранено в Obsidian: ${path.basename(dest)}` };
    }
    if (fmt !== 'pdf' && fmt !== 'docx') throw new Error('Неподдерживаемый формат.');
    const run = `export-${randomUUID()}`;
    const destDir = path.join(hubArtifactRoot(), run);
    await fs.promises.mkdir(destDir, { recursive: true });
    const since = Date.now() - 1000;
    const mdFile = path.join(destDir, `${titleSlug}.${fmt}.md`);
    await fs.promises.writeFile(mdFile, content, 'utf8');
    const compiled = await workers.convertDocs(destDir, since);
    const out = compiled[0];
    if (!out || !fs.existsSync(out)) throw new Error(`Не удалось сконвертировать в ${fmt.toUpperCase()}. Проверь LibreOffice.`);
    await shell.openPath(out);
    return { ok: true, file: out, message: `Готово: ${path.basename(out)} открыт.` };
  });
  ipcMain.handle('agents:stop', (event, id) => hubSessions(event).stop(id));
  ipcMain.handle('agents:artifact', async (event, { id, run, name, action }) => {
    const history = hubSessions(event).history(id);
    if (!history.some((message) => message.artifacts?.some((item) => item.run === run && item.name === name))) {
      throw new Error('Файл не прикреплён к этому чату.');
    }
    const file = await artifactPath(hubArtifactRoot(), run, name);
    if (action === 'copy') { clipboard.writeText(file); return; }
    if (action === 'obsidian') { return exportArtifactToObsidian(file); }
    if (action === 'open') {
      if (/\.excalidraw\.md$/i.test(name)) return exportArtifactToObsidian(file);
      const error = await shell.openPath(file);
      if (error) throw new Error(error);
      return;
    }
    if (action !== 'save') throw new Error('Неизвестное действие.');
    const { canceled, filePath } = await dialog.showSaveDialog(chatsWin, { defaultPath: name });
    if (!canceled && filePath) await fs.promises.copyFile(file, filePath, fs.constants.COPYFILE_EXCL);
  });
  ipcMain.handle('agents:import', async (event, agent, local) => {
    const sessions = hubSessions(event);
    if (!['claude', 'codex', 'gemini'].includes(agent)) throw new Error('Импорт доступен для облачных агентов.');
    let filePaths;
    if (local === true) {
      const home = app.getPath('home');
      const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
      if (agent === 'gemini') throw new Error('Для Antigravity выбери экспорт JSON или JSONL.');
      const roots = agent === 'claude' ? [path.join(home, '.claude', 'projects')]
        : ['sessions', 'archived_sessions'].map((dir) => path.join(codexHome, dir));
      filePaths = await collectLocalTranscripts(roots);
    } else {
      const chosen = await dialog.showOpenDialog(chatsWin, {
        title: 'Импорт переписки агента',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'История чатов', extensions: ['json', 'jsonl'] }],
      });
      if (chosen.canceled) return null;
      filePaths = chosen.filePaths;
    }
    const transcripts = [];
    const errors = [];
    let totalBytes = 0;
    for (const file of filePaths.slice(0, 500)) {
      try {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile() || stat.size > 24 * 1024 * 1024) throw new Error('Файл должен быть меньше 24 МБ.');
        totalBytes += stat.size;
        if (totalBytes > 128 * 1024 * 1024) throw new Error('Достигнут предел импорта.');
        transcripts.push(parseTranscript(await fs.promises.readFile(file, 'utf8')));
      } catch {
        errors.push(path.basename(file));
      }
    }
    return { ids: sessions.import(agent, transcripts), errors, limited: filePaths.length > 500 || totalBytes > 128 * 1024 * 1024 };
  });
  ipcMain.on('chats:open', () => openChats());
  ipcMain.handle('chats:open-link', (event, value) => {
    if (event.sender !== chatsWin?.webContents) throw new Error('Доступно только из Hub.');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Небезопасная ссылка.');
    return shell.openExternal(url.href);
  });
  ipcMain.on('chats:close', () => chatsWin?.close());
  // her Chats window talks through her chat on the overlay (chat.js): the same brain, workers, looks,
  // questions before an action on your PC; she answers there too
  ipcMain.on('chats:send', (_e, text) => {
    const said = String(text || '').trim().slice(0, 500);
    if (said) sendCommand('remoteSend', { text: said });
  });
  ipcMain.on('chats:stop', () => sendCommand('stop'));
  ipcMain.on('chats:answer', (_e, answer) => ['yes', 'hour', 'no'].includes(answer) && sendCommand('remoteAnswer', { answer }));
  ipcMain.on('chats:listen', () => sendCommand('listen'));
  ipcMain.on('chats:copy', (_e, text) => clipboard.writeText(String(text || '')));
  // a new chat: she forgets the one you were in (it stays in the list)
  ipcMain.on('chats:new', () => forgetChats());
  // an old one continued: she has it in mind again, and your next message goes on in it
  ipcMain.on('chats:resume', (_e, id) => {
    const store = chatLog.read(chatsFile());
    const chat = chatLog.resume(store, id);
    if (!chat) return;
    torState.resetChat();
    try { brainShadowHook?.dropPending?.(); } catch {}
    chatLog.write(chatsFile(), store);
    llm.resetClaude();
    saveMemory({ history: chat.messages.slice(-60).map(({ role, content }) => ({ role, content })), claude: null });
    sendCommand('memory');
    chatsWin?.webContents.send('chats:changed');
  });
  // deleting asks first in her window (two clicks); gone for good
  ipcMain.on('chats:delete', (_e, id) => {
    chatLog.write(chatsFile(), chatLog.remove(chatLog.read(chatsFile()), id));
    chatsWin?.webContents.send('chats:changed');
  });
  // her chat on the overlay: busy or not, her question waiting, the mic on
  ipcMain.on('chat:state', (_e, state) => chatsWin?.webContents.send('chats:state', state));
  ipcMain.on('chat:ollama', () => shell.openExternal(OLLAMA_SITE));
  // setting her up with buttons (setup.js): Ollama and a model, or a key, or an address
  const progress = (payload) => overlay?.webContents.send('setup:progress', payload);
  let pulling = null; // AbortController of the model being fetched
  ipcMain.handle('setup:info', async () => {
    // the free cloud models too, when Ollama is up and you're signed in to it
    const { free } = (await ollama.models().catch(() => null)) ? await refreshCloud() : { free: [] };
    return { models: setup.MODELS, cloud: free, ram: os.totalmem(), keyed: Object.keys(setup.KEY_PAGES) };
  });
  ipcMain.handle('setup:ollama', () => setup.ollamaState());
  ipcMain.handle('setup:install', () => setup.installOllama((line) => progress({ kind: 'install', line })));
  ipcMain.handle('setup:start', async () => {
    const res = await setup.startOllama();
    await refreshModels();
    return res;
  });
  ipcMain.handle('setup:pull', async (_e, name) => {
    if (!setup.MODELS.some((m) => m.name === name) && !cloud.free.includes(name)) return { ok: false, error: 'unknown model' };
    pulling?.abort();
    const abort = new AbortController();
    pulling = abort;
    try {
      const model = await fetchModel(name, (p) => progress({ kind: 'pull', ...p }), abort.signal);
      return { ok: true, model };
    } catch (err) {
      return { ok: false, error: abort.signal.aborted ? 'stopped' : err.message };
    } finally {
      if (pulling === abort) pulling = null;
    }
  });
  ipcMain.on('setup:cancel', () => pulling?.abort());
  // who answers her chat, with its key or address if it needs one: saved, tried, and undone if it fails
  ipcMain.handle('setup:use', async (_e, { provider, key, url }) => {
    if (!llm.PROVIDERS[provider]) return { ok: false, error: 'unknown provider' };
    const before = config.load();
    const patch = { provider };
    if (key) patch.apiKeys = { ...before.apiKeys, [provider]: setup.sealKey(String(key).trim()) };
    if (url) patch.customUrl = String(url).trim();
    updateConfig(patch);
    const models = await refreshModels();
    if (models?.length) return { ok: true, model: pickModel() };
    const error = models ? 'no model' : chatError || 'offline';
    updateConfig({ provider: before.provider, apiKeys: before.apiKeys, customUrl: before.customUrl });
    await refreshModels();
    return { ok: false, error };
  });
  ipcMain.on('setup:keyPage', (_e, provider) => setup.KEY_PAGES[provider] && shell.openExternal(setup.KEY_PAGES[provider]));
  ipcMain.handle('setup:launch', (_e, integration) => setup.launchThroughOllama(integration));
  // closing an app you asked her to close, once you've clicked to confirm (apps.js)
  const appInfo = (app) => app && { name: app.process, label: app.label };
  ipcMain.handle('apps:list', async () => (await apps.list().catch(() => [])).map(appInfo));
  ipcMain.handle('apps:find', async (_e, wanted) => appInfo(await apps.find(wanted).catch(() => null)));
  ipcMain.handle('apps:close', (_e, { name, force }) => apps.close(name, { force }).catch((err) => ({ error: err.message })));
  // opening things you ask her to (launch.js): an app or a game, your music, a website
  ipcMain.handle('apps:findLaunch', async (_e, text) => {
    const item = await launch.find(String(text || '')).catch(() => null);
    return item && { ...item, risky: launch.risky(item) }; // a program or a script: behind a button
  });
  ipcMain.handle('apps:youtube', (_e, query) => launch.youtube(query).catch(() => null));
  ipcMain.handle('apps:roblox', (_e, query) => launch.roblox(query).catch(() => null));
  // your files (files.js): a search, opening what it found, a screenshot, a search on the web
  ipcMain.handle('files:search', (_e, query) => files.search(query).catch(() => []));
  ipcMain.handle('files:open', (_e, { file, reveal }) => files.open(String(file), { reveal: Boolean(reveal) }).then(() => true, () => false));
  ipcMain.handle('files:screenshot', () => files.screenshot(targetDisplay()).catch(() => null));
  // a search on the web: she reads it herself (our SearXNG, through Proton) and answers with sources;
  // with the search server out of reach (PC proxy down, server off) the browser opens, as before
  ipcMain.handle('web:search', async (_e, query, how = {}) => {
    const plan = classifyWebSearch(query, how, tor);
    if (plan.torRequested) {
      // any Tor/dark request: update Tor state and drop what the brain shadow watches before anything else
      touchTor();
      if (!plan.query) return false;
      // asked "через тор" / dark / .onion: her Tor node or nothing (tor.js); never falls back to clearnet
      return torSearch(plan.query, config.load(), { ...how, tor: true, dark: plan.dark, onion: how?.onion ?? plan.onion });
    }
    const q = plan.query;
    if (!q) return false;
    const cfg = config.load();
    const browserOnly = cfg.webMode === 'browser';
    let session = null;
    // her search log in your vault (Сырьё/Поиск): every question, how, what came up, what she read
    const via = browserOnly
      ? `браузер ${capriBrowser.resolve(cfg.capriBrowser)?.name || ''}${cfg.capriBrowserProfile ? `, профиль ${cfg.capriBrowserProfileName || path.basename(cfg.capriBrowserProfile)}` : ''} (только браузер)`
      : `поисковик SearXNG (${cfg.searxUrl}) + чтение страниц`;
    const logSearch = (entry) => {
      if (cfg.vaultSearch === false || hasSecret(q)) return;
      try { notes.appendSearch(notesDir(), { question: q, via, ...entry }); } catch (err) { console.warn('[capri] search log:', err.message); }
    };
    try {
      const roles = brains.ready(await ollama.models().catch(() => []));
      // browser-only: one session of her browser (your profile when set) for the search page and every page
      const getSession = async () => (session = session || await capriBrowser.openSession(browserOpts(cfg)));
      const said = await web.answer(q, {
        url: cfg.searxUrl,
        // a "how to" answer is steps from several pages: the main brain writes it, with room for them
        chat: async (messages, { howto } = {}) => {
          const model = roles ? (howto ? await brains.use('main') : brains.current()) : cfg.chatModel;
          return ollama.chat({ model, messages, numPredict: howto ? 1200 : 500 }, () => {});
        },
        ...(browserOnly ? {
          browserSearch: async (query) => (await getSession()).search(query),
          renderMany: async (urls) => (await getSession()).readMany(urls),
        } : {
          renderMany: (urls) => capriBrowser.readRenderedMany(urls, browserOpts(cfg)),
        }),
      });
      logSearch({ results: said.results, read: said.read, blocked: said.blocked, answer: said.answer, error: said.answer ? '' : 'поиск ничего не дал' });
      if (said.answer) return { answer: said.answer, sources: said.sources, blocked: said.blocked };
    } catch (err) {
      console.warn('web search:', err.message);
      logSearch({ error: err.message });
      if (browserOnly) return { error: `Не вышло через браузер: ${err.message}` }; // nothing goes around it
    } finally {
      if (session) await session.close();
    }
    if (browserOnly) return { error: 'В браузере поиск ничего не нашёл.' };
    logSearch({ error: 'отдано тебе: открыт DuckDuckGo в браузере' });
    return shell.openExternal(`https://duckduckgo.com/?q=${encodeURIComponent(q)}`).then(() => ({ opened: true }), () => false);
  });
  // her council (council.js): several models think over one question, the rector writes the verdict
  ipcMain.handle('council:run', async (_e, question, how = {}) => {
    const q = String(question || '').trim().slice(0, 12000);
    if (!q) return { error: 'пустой вопрос' };
    if (hasSecret(q)) return { error: 'в вопросе похоже ключ или пароль — совету его не отдаю' };
    if (tor.wantsTor(q) || tor.onionLink(q)) return { error: 'Tor и даркнет совету не отдаются' };
    try {
      const cfg = config.load();
      const { members, judge, fallbackJudge } = councilMembers(cfg, how.members);
      const result = await council.runCouncil(q, {
        members, judge, fallbackJudge, twoRectors: how.twoRectors !== false, // Opus writes, Astra checks (Danyal: two rectors)
        onEvent: (e) => console.warn(`[capri] совет · ${e.phase} · ${e.member}: ${e.status}${e.seconds ? ` (${e.seconds} с)` : ''}${e.error ? ` — ${e.error}` : ''}`),
      });
      const dir = notesDir();
      const root = path.basename(dir).toLowerCase() === 'capri' ? path.dirname(dir) : dir;
      const file = council.writeCouncil(root, result);
      return {
        verdict: result.verdict, judge: result.judge, members: result.round1.map((r) => r.member), failed: result.failed,
        extract: council.extractFor(result.verdict), file, note: path.relative(root, file).replace(/\\/g, '/'),
      };
    } catch (err) {
      console.warn('[capri] council:', err.message);
      return { error: err.message };
    }
  });
  // her browser opened for you: to sign in to services you trust her with, or your profile started with her port
  ipcMain.handle('browser:signin', (_e, url) => capriBrowser.openForSignIn(url, browserOpts(config.load())).then(() => true, () => false));
  ipcMain.handle('apps:launch', (_e, item) => launch.launch(item).then(() => ({ ok: true }), (err) => ({ ok: false, error: err.message })));
  ipcMain.handle('apps:media', (_e, action) => launch.media(action));
  // your PC itself, from her chat: settings, what's left, sound, snip, windows, theme, power
  ipcMain.handle('pc:do', (_e, req) => Promise.resolve(system.act(req, { display: targetDisplay() })).catch(() => null));
  ipcMain.handle('apps:music', (_e, query) => launch.music(query).catch(() => false));
  ipcMain.handle('apps:site', (_e, address) => launch.site(address).catch(() => false));
  // typing to her: the overlay takes the keyboard while the chat is open, and gives it back after
  ipcMain.on('overlay:focus', (_e, on) => {
    if (!overlay) return;
    overlay.setFocusable(Boolean(on));
    if (on) overlay.focus();
    else overlay.blur();
  });
  // her report card's copy button: a picture of that part of the overlay, on the clipboard
  ipcMain.handle('panel:copy', async (_e, rect) => {
    const image = await overlay.webContents.capturePage(rect);
    if (image.isEmpty()) return false;
    const png = new Blob([image.toPNG()], { type: 'image/png' });
    await clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  });
  // her guide: where her tray icon is (it lives in the taskbar, off the overlay, hence overlay
  // coordinates past its edge), and the corner by the clock in case Windows hid it behind the ^
  ipcMain.handle('guide:tray', () => {
    const o = overlay.getBounds();
    const d = targetDisplay().bounds;
    const b = tray?.getBounds();
    const icon = b && b.width > 0 ? { x: b.x - o.x, y: b.y - o.y, w: b.width, h: b.height } : null;
    const corner = { x: d.x + d.width - 150 - o.x, y: d.y + d.height - 44 - o.y, w: 140, h: 40 };
    return { icon, corner };
  });
  // her guide: Claude Code's folder (~/.claude) in Explorer, its settings file selected
  ipcMain.handle('guide:claudeFolder', () => {
    const file = activeHooks().status().file;
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) return { found: false, dir };
    if (fs.existsSync(file)) shell.showItemInFolder(file);
    else shell.openPath(dir);
    return { found: true, dir, file: fs.existsSync(file), label: fs.existsSync(file) ? path.basename(file) : path.basename(dir) };
  });
  ipcMain.handle('sounds:list', () => {
    try {
      return fs.readdirSync(userSoundsDir())
        .filter((f) => SOUND_EXT.test(f))
        .map((f) => ({ name: f.replace(SOUND_EXT, '').toLowerCase(), url: `capri://usersounds/${encodeURIComponent(f)}` }));
    } catch {
      return [];
    }
  });
}

// Only in --dev: lets scripts drive the overlay and grab frames of it (no desktop content, just our window).
const testWins = new Map(); // name -> test window

async function debugHandler(route, body) {
  if (!DEV) throw new Error('debug routes need --dev');
  if (route === 'command') {
    sendCommand(body.name, body);
    return { ok: true };
  }
  if (route === 'reload') {
    overlay.webContents.reloadIgnoringCache();
    return { ok: true };
  }
  if (route === 'unhook') {
    // the pointer no longer passed on to her, as when Windows drops the mouse hook
    overlay.setIgnoreMouseEvents(true);
    return { ok: true };
  }
  if (route === 'testwin') {
    // plain windows to sit on, opened without stealing focus, by name (`id`, default "main");
    // each one opened goes in front of the others. { open: false } without an id closes them all.
    const id = body.id ?? 'main';
    if (!body.open && body.id === undefined) {
      for (const win of testWins.values()) win.destroy();
      testWins.clear();
      return { ok: true };
    }
    testWins.get(id)?.destroy();
    testWins.delete(id);
    if (body.open) {
      const b = overlay.getBounds();
      const win = new BrowserWindow({
        x: b.x + (body.x ?? 300), y: b.y + (body.y ?? 380), width: body.w ?? 720, height: body.h ?? 380,
        show: false, alwaysOnTop: true, title: `Capri test window ${id}`, backgroundColor: '#1b1726',
      });
      win.loadURL('data:text/html,<body style="background:%231b1726"></body>');
      win.showInactive();
      testWins.set(id, win);
    }
    return { ok: true };
  }
  if (route === 'movewin' && testWins.has(body.id ?? 'main')) {
    const win = testWins.get(body.id ?? 'main');
    const [x, y] = win.getPosition();
    win.setPosition(x + (body.dx || 0), y + (body.dy || 0));
    return { ok: true };
  }
  if (route === 'mouse') {
    // the pointer moving over the overlay (css px), and clicking if asked, without touching the real one
    const at = { x: Math.round(body.x), y: Math.round(body.y) };
    overlay.webContents.sendInputEvent({ type: 'mouseMove', ...at });
    if (body.click) {
      overlay.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at });
      overlay.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at });
    }
    return { ok: true };
  }
  if (route === 'menu') {
    // her menu as labels, and a click on one of them if asked ({ click: 'beam:cloud · ...' })
    const items = (menu) => menu.items.filter((i) => i.label).map((i) => (i.submenu ? { [i.label]: items(i.submenu) } : i.label));
    const find = (menu) => menu.items.reduce((hit, i) => hit || (i.label === body.click ? i : i.submenu && find(i.submenu)), null);
    if (body.click) find(trayMenu)?.click();
    return { ok: true, value: items(trayMenu) };
  }
  if (route === 'notes') {
    // her notes from the conversation so far, now rather than a few minutes after you stop talking
    notesUpTo = '';
    return { ok: true, value: { dir: notesDir(), kept: await takeNotes(readMemory().history || []) } };
  }
  if (route === 'brain') {
    // the brain shadow (src/main/brain): set its flags ({ set: { brainShadow, brainVerdictJudge, brainInfluence } }),
    // read its in-memory counters, Stage 6 policy stats, and this process's memory. Numbers only — no text, no ids.
    const set = body.set && typeof body.set === 'object' ? body.set : {};
    const patch = {};
    if (typeof set.brainShadow === 'boolean') patch.brainShadow = set.brainShadow;
    if (set.brainVerdictJudge === 'off' || set.brainVerdictJudge === 'shadow') patch.brainVerdictJudge = set.brainVerdictJudge;
    if (Object.hasOwn(set, 'brainInfluence')) {
      if (set.brainInfluence !== 'off' && set.brainInfluence !== 'reassessment') {
        throw new Error('brainInfluence must be off or reassessment');
      }
      patch.brainInfluence = set.brainInfluence;
    }
    if (Object.keys(patch).length) updateConfig(patch);
    const cfg = config.load(true);
    const mem = process.memoryUsage();
    return { ok: true, value: {
      brainShadow: cfg.brainShadow === true,
      brainVerdictJudge: cfg.brainVerdictJudge || 'off',
      brainInfluence: cfg.brainInfluence === 'reassessment' ? 'reassessment' : 'off',
      hook: Boolean(brainShadowHook),
      stats: brainShadowHook ? brainShadowHook.stats() : null,
      policy: brainInfluencePolicy ? brainInfluencePolicy.stats() : null,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed }, journalDir: path.join(app.getPath('userData'), 'brain-journal'),
    } };
  }
  if (route === 'models') {
    // which model she'd chat with, and why: what Ollama lists and what her config says
    const cfg = config.load(true);
    return { ok: true, value: { chatModels, configured: cfg.chatModel, provider: cfg.provider, picked: pickModel(cfg), config: config.file() } };
  }
  if (route === 'pim') {
    // what her chat would add for a phrase (mail, calendar): its size and line count only, not the content
    const said = String(body.text || '');
    const added = (await withPim([{ role: 'user', content: said }], said))[0].content.slice(said.length);
    return { ok: true, value: { chars: added.length, lines: added.split('\n').filter((l) => l.startsWith('- ')).length, empty: /Nothing is scheduled/.test(added) } };
  }
  if (route === 'eval') {
    // a look inside the overlay (app.js puts what's there on window.dev in --dev), or her hub ({ hub: true })
    const page = body.hub ? chatsWin?.webContents : overlay.webContents;
    if (!page) throw new Error('her hub is not open');
    return { ok: true, value: await page.executeJavaScript(String(body.js || 'null')) };
  }
  if (route === 'drag') {
    // a drag over the overlay with a stand-in pointer, the real one untouched: the button goes down
    // at the first point, follows the others (each `ms` after the one before), and comes up at the last
    const points = Array.isArray(body.points) ? body.points : [];
    if (!points.length) throw new Error('drag needs points');
    const at = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
    overlay.webContents.sendInputEvent({ type: 'mouseMove', ...at(points[0]) });
    overlay.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at(points[0]) });
    for (const p of points.slice(1)) {
      await new Promise((r) => setTimeout(r, p.ms ?? 16));
      overlay.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], ...at(p) });
    }
    if (body.up !== false) overlay.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at(points.at(-1)) });
    return { ok: true };
  }
  if (route === 'type') {
    // typing into the overlay (her chat), and Enter if asked
    if (body.text) await overlay.webContents.insertText(body.text);
    if (body.enter) {
      overlay.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      overlay.webContents.sendInputEvent({ type: 'char', keyCode: 'Return' });
      overlay.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    }
    return { ok: true };
  }
  if (route === 'capture') {
    const image = await (body.hub && chatsWin ? chatsWin : overlay).webContents.capturePage();
    // installed, the app's own folder is read-only: its data folder instead
    const dir = path.join(app.isPackaged ? app.getPath('userData') : ROOT, 'captures');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${(body.name || 'frame').replace(/[^\w-]/g, '')}.png`);
    fs.writeFileSync(file, image.toPNG());
    return { ok: true, file };
  }
  throw new Error('unknown debug route');
}

// How her window is drawn, set before Electron starts (her menu › Display). On some PCs her see-through
// window shows up black (NVIDIA with FXAA, MFAA or HDR on, for one): drawing it through OpenGL, or
// without the graphics card, often fixes it.
function applyRender() {
  const { render } = config.load();
  if (render === 'gl') app.commandLine.appendSwitch('use-angle', 'gl');
  if (render === 'software') {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('enable-unsafe-swiftshader'); // her drawing still needs WebGL, done on the CPU
  }
  // --dev: what Chromium ended up drawing with
  if (DEV) app.whenReady().then(() => setTimeout(() => console.log('[capri] display:', render, JSON.stringify(app.getGPUFeatureStatus())), 4000));
}

function main() {
  applyRender();
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => { if (app.isReady()) openChats(); });
  if (process.platform === 'win32') app.setAppUserModelId('capri.desktop');

  app.whenReady().then(() => {
    if (!['codex', 'claude', 'both', 'agy'].includes(config.load().assistant)) config.save({ assistant: activeAssistant().id });
    desktopCli = new desktop.Cli(desktop.BIN, path.join(app.getPath('userData'), 'agent-desktop'));
    localPlanner = new Planner(path.join(app.getPath('userData'), 'planner.json'), {
      onChange: () => {
        syncPlannerReminders();
        chatsWin?.webContents.send('plans:changed'); // her hub's Plans tab
      },
      // a note: into your Obsidian vault, its own branch (notes.writePlanNote)
      onCreate: (entry) => {
        if (entry.kind !== 'note') return null;
        try {
          return { obsidian: notes.writePlanNote(notesDir(), entry) };
        } catch (err) {
          console.warn('[capri] planner note:', err.message);
          return null;
        }
      },
    });
    syncPlannerReminders();
    setInterval(() => morningBriefTick().catch((err) => console.warn('[capri] morning brief:', err.message)), 60 * 1000);
    setInterval(() => pollTelegramTick().catch((err) => console.warn('[capri] telegram poll:', err.message)), 15 * 1000);
    serveProtocol();
    registerIpc();
    createOverlay();
    createTray();
    openChats();
    windowWatch = startWindowWatch({
      overlay,
      onUpdate: (data) => {
        // a click on the taskbar brings it up over her: sitting on it, her legs would vanish behind it
        if (data.taskbar && !lastWindows?.taskbar && config.load().rest === 'taskbar') raiseOverlay();
        lastWindows = data;
        overlay?.webContents.send('windows:update', data);
      },
    });
    createBridge({
      port: PORT,
      // her own Claude Code chat's hooks would cover its answer with theirs, and Claude's or Codex's at work
      // for her chat (in their folder) too: their permission prompt would close the chat, and kill them
      onEvent: (evt) => {
        const cfg = config.load();
        if (llm.isChatSession(evt.session_id) || workers.isWorkerEvent(evt, cfg)) return;
        if (cfg.agyTurbo !== false && evt.hook_event_name === 'Notification' && evt.notification_type === 'permission_prompt') return;
        notifyTelegram(evt);
        overlay?.webContents.send('claude:event', evt);
      },
      onDebug: DEV ? debugHandler : null,
    });
    globalShortcut.register('Control+Alt+C', () => toggleVisible());
    // Ctrl+Alt+V: you talk to her (again: you're done; she also stops by herself when you go quiet)
    globalShortcut.register('Control+Alt+V', () => sendCommand('listen'));
    // Ctrl+Alt+X: her answer under way stops (Claude or Codex at work in her chat: killed)
    globalShortcut.register('Control+Alt+X', () => sendCommand('stop'));
    speech.ensureWhisper(config.load().voice);
    applyPhone();
    applyTelegram();
    applyPimMcp();
    applyWebMcp();
    // what you asked her to remember before her notes existed: into her notes, once
    const { memories = [] } = config.load();
    if (memories.length && !notes.list(notesDir()).length) {
      for (const memo of memories) notes.write(notesDir(), { title: memo.split(/s+/).slice(0, 5).join(' '), type: 'о тебе', text: memo });
    }
    llm.restoreClaude(readMemory().claude);
    refreshModels(); // for her menu's model list
    setTimeout(() => launch.launchables().catch(() => {}), 20000); // what she can open, before you ask
    // a screen plugged in, unplugged, or rearranged: her window fitted again, and she learns of it
    const screensChanged = () => {
      fitOverlay();
      windowWatch?.refresh();
      rebuildTray();
      sendCommand('screens');
    };
    screen.on('display-metrics-changed', screensChanged);
    screen.on('display-added', screensChanged);
    screen.on('display-removed', screensChanged);
    // after sleep or a locked screen, once Windows has settled
    powerMonitor.on('resume', () => setTimeout(rearmOverlay, 2000));
    powerMonitor.on('unlock-screen', () => setTimeout(rearmOverlay, 1000));
  });

  let brainShadowClosing = false;
  app.on('before-quit', (e) => {
    if (brainShadowClosing || !brainShadowHook) return;
    brainShadowClosing = true;
    e.preventDefault();
    let timer;
    Promise.race([
      Promise.resolve(brainShadowHook.close()).catch(() => {}),
      new Promise((r) => { timer = setTimeout(r, 2000); }),
    ]).finally(() => {
      clearTimeout(timer);
      app.quit();
    });
  });

  app.on('will-quit', () => {
    try { brainShadowHook?.close(); } catch {}
    capriBrowser.releaseAll(); // her control session in your browser ended, so the next Capri can attach
    agentSessions?.stopAll();
    globalShortcut.unregisterAll();
    speech.stopWhisper();
    comfy.stop(); // ComfyUI goes with her
    phoneBridge?.stop();
    windowWatch?.stop();
  });
  app.on('window-all-closed', (e) => e.preventDefault());
}

main();
