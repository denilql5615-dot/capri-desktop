'use strict';

const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const CACHE_TTL_MS = 20 * 1000;
const STATUS_EXEC_TIMEOUT_MS = 8000;
const CONTROL_EXEC_TIMEOUT_MS = 35000;
const LENOVO_TARGET = 'danyal@192.168.0.107';
const VALID_ACTIONS = new Set(['start', 'stop', 'restart']);
const CONTAINER_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;

const PC_STACKS = Object.freeze([
  {
    id: 'pc-nomad',
    host: 'pc',
    name: 'NOMAD Библиотека',
    containers: ['capri-nomad-local'],
    port: 8090,
    url: 'http://127.0.0.1:8090',
    alwaysOn: true,
    critical: true,
    expandable: false,
    description: '63 офлайн-книги Kiwix, работает без сети и в Приват',
  },
  {
    id: 'pc-tor',
    host: 'pc',
    name: 'Tor-изолятор Альты',
    containers: ['capri-tor-netns', 'capri-tor-gw'],
    port: null,
    url: '',
    alwaysOn: true,
    critical: true,
    expandable: false,
    description: 'Сетевая изоляция Tor v0 без утечек',
  },
  {
    id: 'pc-penpot',
    host: 'pc',
    name: 'Penpot + MCP',
    containers: [
      'penpot-penpot-frontend-1',
      'penpot-penpot-backend-1',
      'penpot-penpot-exporter-1',
      'penpot-penpot-admin-console-1',
      'penpot-penpot-postgres-1',
      'penpot-penpot-mcp-1',
      'penpot-penpot-mailpit-1',
      'penpot-penpot-valkey-1',
    ],
    port: 9001,
    url: 'http://localhost:9001',
    alwaysOn: true,
    critical: false,
    expandable: false,
    description: 'Open-source замена Figma + встроенный MCP',
  },
  {
    id: 'pc-opennotebook',
    host: 'pc',
    name: 'OpenNotebook',
    containers: ['opennotebook-open_notebook-1', 'opennotebook-surrealdb-1'],
    port: 8502,
    url: 'http://127.0.0.1:8502',
    alwaysOn: true,
    critical: false,
    expandable: false,
    description: 'Локальный NotebookLM и источник срезов памяти',
  },
  {
    id: 'pc-presenton',
    host: 'pc',
    name: 'Presenton',
    containers: ['presenton-presenton-1'],
    port: 5100,
    url: 'http://127.0.0.1:5100',
    alwaysOn: false,
    critical: false,
    expandable: false,
    description: 'Локальный AI-генератор презентаций (по требованию)',
  },
  {
    id: 'pc-postiz',
    host: 'pc',
    name: 'Postiz + Temporal',
    containers: [
      'postiz',
      'temporal',
      'temporal-ui',
      'temporal-admin-tools',
      'temporal-postgresql',
      'temporal-elasticsearch',
      'postiz-postgres',
      'postiz-redis',
    ],
    port: 4007,
    url: 'https://localhost:4007',
    alwaysOn: false,
    critical: false,
    expandable: false,
    description: 'SMM-планировщик и автопостинг (по требованию, ~2.4 ГБ)',
  },
  {
    id: 'pc-aperisolve',
    host: 'pc',
    name: 'AperiSolve + MCP',
    containers: [
      'aperisolve-web',
      'aperisolve-mcp',
      'aperisolve-worker-1',
      'aperisolve-cron',
      'rq-dashboard',
      'postgres',
      'redis',
    ],
    port: 5000,
    url: 'http://127.0.0.1:5000',
    alwaysOn: false,
    critical: false,
    expandable: false,
    description: 'Анализ и стеганография изображений + MCP :5001 (по требованию)',
  },
]);

const NOMAD_PACK_SUBITEMS = Object.freeze([
  {
    id: 'nomad_kiwix_server',
    container: 'nomad_kiwix_server',
    name: 'Kiwix Резерв',
    port: 8090,
    url: 'http://192.168.0.107:8090',
    description: 'Резервный сервер офлайн-библиотеки Kiwix',
  },
  {
    id: 'nomad_stirling_pdf',
    container: 'nomad_stirling_pdf',
    name: 'Stirling-PDF',
    port: 8400,
    url: 'http://192.168.0.107:8400',
    description: 'Редактор и инструменты для PDF',
  },
  {
    id: 'nomad_calibreweb',
    container: 'nomad_calibreweb',
    name: 'Calibre-Web',
    port: 8420,
    url: 'http://192.168.0.107:8420',
    description: 'Веб-библиотека книг Calibre',
  },
  {
    id: 'nomad_homebox',
    container: 'nomad_homebox',
    name: 'Homebox',
    port: 8470,
    url: 'http://192.168.0.107:8470',
    description: 'Учёт домашнего инвентаря',
  },
  {
    id: 'nomad_translate',
    container: 'nomad_translate',
    name: 'Translate',
    port: 8460,
    url: 'http://192.168.0.107:8460',
    description: 'Локальный офлайн-переводчик',
  },
  {
    id: 'nomad_filebrowser',
    container: 'nomad_filebrowser',
    name: 'FileBrowser',
    port: 8410,
    url: 'http://192.168.0.107:8410',
    description: 'Веб-менеджер файлов NOMAD',
  },
  {
    id: 'nomad_cyberchef',
    container: 'nomad_cyberchef',
    name: 'CyberChef',
    port: 8100,
    url: 'http://192.168.0.107:8100',
    description: 'Инструмент декодирования и анализа данных',
  },
  {
    id: 'nomad_it_tools',
    container: 'nomad_it_tools',
    name: 'IT-Tools',
    port: 8430,
    url: 'http://192.168.0.107:8430',
    description: 'Набор утилит для разработчиков',
  },
  {
    id: 'nomad_qdrant',
    container: 'nomad_qdrant',
    name: 'Qdrant',
    port: 6333,
    url: 'http://192.168.0.107:6333',
    description: 'Векторная база знаний NOMAD',
  },
  {
    id: 'nomad_dozzle',
    container: 'nomad_dozzle',
    name: 'Dozzle Логи',
    port: 9999,
    url: 'http://192.168.0.107:9999',
    description: 'Просмотр логов контейнеров в реальном времени',
  },
]);

const LENOVO_STACKS = Object.freeze([
  {
    id: 'srv-searxng',
    host: 'lenovo',
    name: 'SearXNG Поиск',
    containers: ['searxng-searxng-1'],
    port: 8888,
    url: 'http://192.168.0.107:8888',
    alwaysOn: true,
    critical: true,
    expandable: false,
    description: 'Метапоисковик для Капри (Google CSE, DDG, Brave)',
  },
  {
    id: 'srv-fmd',
    host: 'lenovo',
    name: 'Find My Device',
    containers: ['capri-stack-fmd-server-1'],
    port: 8083,
    url: 'http://192.168.0.107:8083',
    alwaysOn: true,
    critical: false,
    expandable: false,
    description: 'Поиск и геолокация Android-устройств',
  },
  {
    id: 'srv-kuma',
    host: 'lenovo',
    name: 'Uptime Kuma',
    containers: ['capri-stack-uptime-kuma-1'],
    port: 3001,
    url: 'http://192.168.0.107:3001',
    alwaysOn: true,
    critical: false,
    expandable: false,
    description: 'Мониторинг доступности сервисов сервера',
  },
  {
    id: 'srv-freshrss',
    host: 'lenovo',
    name: 'FreshRSS Новости',
    containers: ['capri-stack-freshrss-1'],
    port: 8082,
    url: 'http://192.168.0.107:8082',
    alwaysOn: true,
    critical: false,
    expandable: false,
    description: 'Агрегатор RSS-подписок и новостей',
  },
  {
    id: 'srv-homeassistant',
    host: 'lenovo',
    name: 'Home Assistant',
    containers: ['capri-stack-homeassistant-1'],
    port: 8123,
    url: 'http://192.168.0.107:8123',
    alwaysOn: true,
    critical: false,
    expandable: false,
    description: 'Умный дом и локальная автоматизация',
  },
  {
    id: 'srv-amnezia',
    host: 'lenovo',
    name: 'AmneziaWG VPN',
    containers: ['hub-awg-1'],
    port: null,
    url: '',
    alwaysOn: true,
    critical: true,
    expandable: false,
    description: 'Защищённый VPN-шлюз сервера',
  },
  {
    id: 'srv-wger',
    host: 'lenovo',
    name: 'Wger Тренировки',
    containers: ['capri-wger', 'capri-wger-nginx', 'capri-wger-db', 'capri-wger-powersync'],
    port: 8085,
    url: 'http://192.168.0.107:8085',
    alwaysOn: true,
    critical: false,
    expandable: false,
    description: 'Self-hosted трекер тренировок и питания',
  },
  {
    id: 'srv-nomad-pack',
    host: 'lenovo',
    name: 'Пакет NOMAD (10 сервисов)',
    containers: NOMAD_PACK_SUBITEMS.map((s) => s.container),
    port: 8090,
    url: 'http://192.168.0.107:8090',
    alwaysOn: true,
    critical: false,
    expandable: true,
    subItems: NOMAD_PACK_SUBITEMS,
    description: 'Офлайн-библиотека, PDF, книги, переводы и утилиты',
  },
  {
    id: 'srv-nomad-admin',
    host: 'lenovo',
    name: 'NOMAD Admin + MySQL',
    containers: [
      'nomad_admin',
      'nomad_mysql',
      'nomad_redis',
      'nomad_disk_collector',
      'nomad_updater',
    ],
    port: 8080,
    url: 'http://192.168.0.107:8080',
    alwaysOn: false,
    critical: false,
    expandable: false,
    description: 'Панель управления NOMAD, БД и автообновление',
  },
  {
    id: 'srv-kolibri',
    host: 'lenovo',
    name: 'Kolibri Курсы',
    containers: ['nomad_kolibri_2'],
    port: 8310,
    url: 'http://192.168.0.107:8310',
    alwaysOn: false,
    critical: false,
    expandable: false,
    description: 'Офлайн-курсы и учебные материалы Kolibri',
  },
  {
    id: 'srv-meshtastic',
    host: 'lenovo',
    name: 'Meshtastic Web',
    containers: ['nomad_meshtastic_web'],
    port: 8450,
    url: 'http://192.168.0.107:8450',
    alwaysOn: false,
    critical: false,
    expandable: false,
    description: 'Веб-клиент LoRa-сети Meshtastic',
  },
]);

const STACKS_BY_HOST = {
  pc: new Map(PC_STACKS.map((s) => [s.id, s])),
  lenovo: new Map(LENOVO_STACKS.map((s) => [s.id, s])),
};

const REMOTE_STATUS_CMD = [
  "docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}'",
  "echo '===STATS==='",
  "docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}'",
  "echo '===FREE==='",
  'LC_ALL=C free -m',
  "echo '===DF==='",
  'LC_ALL=C df -h /',
].join(' ; ');

function parseMemMb(raw) {
  const head = String(raw || '').split('/')[0].trim();
  if (!head || head === '--') return 0;
  const match = head.match(/^(\d+(?:[.,]\d+)?)\s*(GiB|GB|MiB|MB|KiB|kB|KB|B)$/i);
  if (!match) return 0;
  const val = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(val) || val <= 0) return 0;
  const unit = match[2].toLowerCase();
  let mb = 0;
  if (unit === 'gib') mb = val * 1024;
  else if (unit === 'gb') mb = val * 1000;
  else if (unit === 'mib' || unit === 'mb') mb = val;
  else if (unit === 'kib') mb = val / 1024;
  else if (unit === 'kb') mb = val / 1000;
  else if (unit === 'b') mb = val / (1024 * 1024);
  return Math.round(mb * 10) / 10;
}

function parseCpuPct(raw) {
  const s = String(raw || '').trim().replace('%', '');
  if (!s || s === '--') return 0;
  const val = Number(s.replace(',', '.'));
  if (!Number.isFinite(val) || val < 0) return 0;
  return Math.round(val * 100) / 100;
}

function parseDockerPs(stdout) {
  const map = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, state = '', status = ''] = trimmed.split('\t');
    if (!name) continue;
    const cleanName = name.trim();
    const cleanState = state.trim().toLowerCase();
    map.set(cleanName, {
      name: cleanName,
      state: cleanState,
      status: status.trim(),
      running: cleanState === 'running',
    });
  }
  return map;
}

function parseDockerStats(stdout) {
  const map = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, memUsage = '', cpuPerc = ''] = trimmed.split('\t');
    if (!name) continue;
    map.set(name.trim(), {
      memMb: parseMemMb(memUsage),
      cpuPct: parseCpuPct(cpuPerc),
    });
  }
  return map;
}

function parseFreeOutput(stdout) {
  let hostMem = null;
  let hostSwap = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Mem:') || trimmed.startsWith('Память:')) {
      const cols = trimmed.split(/\s+/).slice(1).map((n) => Number(n));
      if (cols.length >= 3 && Number.isFinite(cols[0]) && cols[0] > 0) {
        const totalMb = cols[0];
        const usedMb = Number.isFinite(cols[1]) ? cols[1] : 0;
        const freeMb = Number.isFinite(cols[2]) ? cols[2] : Math.max(0, totalMb - usedMb);
        const availableMb = Number.isFinite(cols[5]) ? cols[5] : freeMb;
        hostMem = {
          totalMb,
          usedMb,
          freeMb,
          availableMb,
          usedPct: Math.round((usedMb / totalMb) * 100),
        };
      }
    } else if (trimmed.startsWith('Swap:') || trimmed.startsWith('Подкачка:')) {
      const cols = trimmed.split(/\s+/).slice(1).map((n) => Number(n));
      if (cols.length >= 3 && Number.isFinite(cols[0])) {
        const totalMb = cols[0];
        const usedMb = Number.isFinite(cols[1]) ? cols[1] : 0;
        const freeMb = Number.isFinite(cols[2]) ? cols[2] : Math.max(0, totalMb - usedMb);
        hostSwap = {
          totalMb,
          usedMb,
          freeMb,
          usedPct: totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0,
        };
      }
    }
  }
  return { hostMem, hostSwap };
}

function parseDfOutput(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 1; i < lines.length; i += 1) {
    const cols = lines[i].split(/\s+/);
    if (cols.length >= 6) {
      const pctNum = Number(String(cols[4]).replace('%', ''));
      return {
        filesystem: cols[0],
        size: cols[1],
        used: cols[2],
        avail: cols[3],
        usePct: cols[4],
        usePctNum: Number.isFinite(pctNum) ? pctNum : 0,
        mount: cols[5],
      };
    }
  }
  return null;
}

function decorateStacks(definitions, psMap, statsMap) {
  let runningStacks = 0;
  let totalContainerMb = 0;

  const stacks = definitions.map((def) => {
    let runningCount = 0;
    let stackMemMb = 0;
    let stackCpuPct = 0;

    for (const container of def.containers) {
      const ps = psMap.get(container);
      const st = statsMap.get(container);
      if (ps?.running) runningCount += 1;
      if (st) {
        stackMemMb += st.memMb;
        stackCpuPct += st.cpuPct;
      }
    }

    const memMb = Math.round(stackMemMb * 10) / 10;
    const cpuPct = Math.round(stackCpuPct * 100) / 100;
    const running = runningCount > 0;
    if (running) runningStacks += 1;
    totalContainerMb += memMb;

    const base = {
      id: def.id,
      host: def.host,
      name: def.name,
      description: def.description,
      containers: [...def.containers],
      running,
      runningCount,
      totalCount: def.containers.length,
      memMb,
      cpuPct,
      port: def.port,
      url: def.url,
      alwaysOn: Boolean(def.alwaysOn),
      critical: Boolean(def.critical),
      expandable: Boolean(def.expandable),
    };

    if (def.expandable && Array.isArray(def.subItems)) {
      base.subItems = def.subItems.map((sub) => {
        const ps = psMap.get(sub.container);
        const st = statsMap.get(sub.container);
        return {
          id: sub.id,
          container: sub.container,
          name: sub.name,
          description: sub.description,
          running: Boolean(ps?.running),
          memMb: st ? st.memMb : 0,
          cpuPct: st ? st.cpuPct : 0,
          port: sub.port,
          url: sub.url,
        };
      });
    }

    return base;
  });

  return {
    stacks,
    runningCount: runningStacks,
    totalCount: stacks.length,
    totalContainerMb: Math.round(totalContainerMb * 10) / 10,
  };
}

function defaultExecFile(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      windowsHide: true,
      timeout: STATUS_EXEC_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      ...opts,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || 'Command failed').trim();
        const wrapped = new Error(msg);
        wrapped.code = err.code;
        wrapped.stdout = String(stdout || '');
        wrapped.stderr = String(stderr || '');
        return reject(wrapped);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

class DockerEngine {
  constructor(opts = {}) {
    this.execFileImpl = typeof opts.execFileImpl === 'function' ? opts.execFileImpl : defaultExecFile;
    this.osImpl = opts.osImpl || os;
    this.sshKeyPath = opts.sshKeyPath || path.join(this.osImpl.homedir(), '.ssh', 'capri_server');
    this.sshTarget = opts.sshTarget || LENOVO_TARGET;
    this.cacheTtlMs = Number.isFinite(Number(opts.cacheTtlMs)) ? Number(opts.cacheTtlMs) : CACHE_TTL_MS;
    this.cache = null;
    this.inflightStatus = null;
  }

  sshArgs(remoteCommand) {
    return [
      '-o', 'ConnectTimeout=4',
      '-o', 'BatchMode=yes',
      '-i', this.sshKeyPath,
      this.sshTarget,
      remoteCommand,
    ];
  }

  getCachedStatus() {
    if (!this.cache) return null;
    return this.cache.data;
  }

  invalidateCache() {
    this.cache = null;
  }

  localHostMem() {
    try {
      const totalMb = Math.round(this.osImpl.totalmem() / (1024 * 1024));
      const freeMb = Math.round(this.osImpl.freemem() / (1024 * 1024));
      const usedMb = Math.max(0, totalMb - freeMb);
      return {
        totalMb,
        usedMb,
        freeMb,
        usedPct: totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0,
      };
    } catch {
      return null;
    }
  }

  async fetchPcStatus() {
    const hostMem = this.localHostMem();
    try {
      const psRes = await this.execFileImpl('docker', [
        'ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}',
      ], { timeout: STATUS_EXEC_TIMEOUT_MS });
      const psMap = parseDockerPs(psRes.stdout);

      let statsMap = new Map();
      const anyRunning = Array.from(psMap.values()).some((c) => c.running);
      if (anyRunning) {
        const stRes = await this.execFileImpl('docker', [
          'stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}',
        ], { timeout: STATUS_EXEC_TIMEOUT_MS }).catch(() => ({ stdout: '' }));
        statsMap = parseDockerStats(stRes.stdout);
      }

      const decorated = decorateStacks(PC_STACKS, psMap, statsMap);
      return {
        online: true,
        hostMem,
        ...decorated,
      };
    } catch (err) {
      const empty = decorateStacks(PC_STACKS, new Map(), new Map());
      return {
        online: false,
        hostMem,
        ...empty,
        error: String(err?.message || 'Docker на ПК недоступен'),
      };
    }
  }

  async fetchLenovoStatus() {
    try {
      const res = await this.execFileImpl('ssh', this.sshArgs(REMOTE_STATUS_CMD), {
        timeout: STATUS_EXEC_TIMEOUT_MS,
      });
      const out = String(res.stdout || '');
      const [psPart = '', rest1 = ''] = out.split('===STATS===');
      const [statsPart = '', rest2 = ''] = rest1.split('===FREE===');
      const [freePart = '', dfPart = ''] = rest2.split('===DF===');

      const psMap = parseDockerPs(psPart);
      const statsMap = parseDockerStats(statsPart);
      const { hostMem, hostSwap } = parseFreeOutput(freePart);
      const hostDisk = parseDfOutput(dfPart);
      const decorated = decorateStacks(LENOVO_STACKS, psMap, statsMap);

      const dockerMissing = psMap.size === 0 && /cannot connect to the docker daemon/i.test(String(res.stderr || out));
      if (dockerMissing) {
        return {
          online: false,
          hostMem,
          hostSwap,
          hostDisk,
          ...decorateStacks(LENOVO_STACKS, new Map(), new Map()),
          error: 'Docker daemon на Lenovo .107 не отвечает',
        };
      }

      return {
        online: true,
        hostMem,
        hostSwap,
        hostDisk,
        ...decorated,
      };
    } catch (err) {
      const empty = decorateStacks(LENOVO_STACKS, new Map(), new Map());
      return {
        online: false,
        hostMem: null,
        hostSwap: null,
        hostDisk: null,
        ...empty,
        error: String(err?.message || 'Lenovo .107 недоступен по SSH'),
      };
    }
  }

  async getStatus({ refresh = false } = {}) {
    if (!refresh && this.cache && Date.now() - this.cache.checkedAt < this.cacheTtlMs) {
      return this.cache.data;
    }
    if (this.inflightStatus) {
      return this.inflightStatus;
    }

    this.inflightStatus = (async () => {
      const [pc, lenovo] = await Promise.all([
        this.fetchPcStatus(),
        this.fetchLenovoStatus(),
      ]);
      const checkedAt = Date.now();
      const data = { pc, lenovo, checkedAt };
      this.cache = { data, checkedAt };
      return data;
    })();

    try {
      return await this.inflightStatus;
    } finally {
      this.inflightStatus = null;
    }
  }

  validateControlRequest({ host, stackId, container = null, action }) {
    const cleanHost = String(host || '').trim();
    const cleanStackId = String(stackId || '').trim();
    const cleanAction = String(action || '').trim().toLowerCase();
    const cleanContainer = container !== null && container !== undefined && String(container).trim() !== ''
      ? String(container).trim()
      : null;

    if (!VALID_ACTIONS.has(cleanAction)) {
      return { ok: false, error: `Недопустимое действие «${action}». Разрешены только start, stop, restart.` };
    }

    const hostMap = STACKS_BY_HOST[cleanHost];
    if (!hostMap) {
      return { ok: false, error: `Неизвестный хост «${host}».` };
    }

    const stack = hostMap.get(cleanStackId);
    if (!stack) {
      return { ok: false, error: `Стек «${stackId}» не найден в списке разрешённых для ${cleanHost}.` };
    }

    let targets = [...stack.containers];
    if (cleanContainer !== null) {
      if (!CONTAINER_NAME_RE.test(cleanContainer) || !stack.containers.includes(cleanContainer)) {
        return { ok: false, error: `Контейнер «${cleanContainer}» не разрешён для стека «${stack.id}».` };
      }
      targets = [cleanContainer];
    }

    // Double-check every target against strict safe container name format.
    for (const c of targets) {
      if (!CONTAINER_NAME_RE.test(c)) {
        return { ok: false, error: `Некорректное имя контейнера «${c}».` };
      }
    }

    return {
      ok: true,
      host: cleanHost,
      stack,
      container: cleanContainer,
      action: cleanAction,
      targets,
    };
  }

  async controlStack({ host, stackId, container = null, action, confirm = false } = {}) {
    const validated = this.validateControlRequest({ host, stackId, container, action });
    if (!validated.ok) return validated;

    const { host: cleanHost, stack, container: cleanContainer, action: cleanAction, targets } = validated;

    if (cleanAction === 'stop' && stack.critical && confirm !== true) {
      const targetLabel = cleanContainer ? `${stack.name} (${cleanContainer})` : stack.name;
      return {
        ok: false,
        confirmRequired: true,
        host: cleanHost,
        stackId: stack.id,
        container: cleanContainer,
        action: cleanAction,
        message: `Стек «${targetLabel}» критичен (24/7). Подтверди остановку.`,
      };
    }

    try {
      if (cleanHost === 'pc') {
        await this.execFileImpl('docker', [cleanAction, ...targets], {
          timeout: CONTROL_EXEC_TIMEOUT_MS,
        });
      } else {
        // Every element of targets is strictly verified against the hardcoded allowlist.
        const remoteCmd = `docker ${cleanAction} ${targets.join(' ')}`;
        await this.execFileImpl('ssh', this.sshArgs(remoteCmd), {
          timeout: CONTROL_EXEC_TIMEOUT_MS,
        });
      }
    } catch (err) {
      return {
        ok: false,
        host: cleanHost,
        stackId: stack.id,
        container: cleanContainer,
        action: cleanAction,
        error: String(err?.message || `Не удалось выполнить ${cleanAction} для ${stack.id}`),
      };
    }

    this.invalidateCache();
    const status = await this.getStatus({ refresh: true });
    const actionLabel = cleanAction === 'start' ? 'запущен' : cleanAction === 'stop' ? 'остановлен' : 'перезапущен';
    const targetName = cleanContainer || stack.name;
    return {
      ok: true,
      action: cleanAction,
      host: cleanHost,
      stackId: stack.id,
      container: cleanContainer,
      message: `${targetName} ${actionLabel}.`,
      status,
    };
  }
}

module.exports = {
  DockerEngine,
  PC_STACKS,
  LENOVO_STACKS,
  NOMAD_PACK_SUBITEMS,
  CACHE_TTL_MS,
  parseMemMb,
  parseCpuPct,
  parseDockerPs,
  parseDockerStats,
  parseFreeOutput,
  parseDfOutput,
};
