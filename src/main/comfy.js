'use strict';

// "Скинь фото": pictures from ComfyUI, the one Comfy Desktop installed (D:\Comfy-Desktop), started only when
// one is asked for and never shown: its own Python and models, a port of its own on this PC, no manager, no
// window. While it draws, the chat models in Ollama are unloaded (8 GB of VRAM holds one of them at a time);
// once the picture is out its models are unloaded too, and the process itself goes after a few idle minutes.
// The workflow is the one that drew her best (NoobAI XL, her capri_cp LoRA at 0.8): plain JSON through its API.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 8189; // not Comfy Desktop's own: the two can't clash
const IDLE_MS = 5 * 60 * 1000;
const START_MS = 3 * 60 * 1000;
const JOB_MS = 10 * 60 * 1000;

const CHECKPOINT = 'noobaiXLNAIXL_epsilonPred11Version(1).safetensors';
const LORA = 'capri_cp.safetensors';
// what she looks like, said the way the LoRA learnt her
const HER = 'capri_cp, 1girl, solo, slender body, black bodysuit, neon green panels, glossy plating, pink spiky hair, green visor';
const STYLE = 'cel shading, rim lighting, neon glow, glossy highlights, vibrant colors, masterpiece, best quality';
const NEGATIVE = 'flat color, dull, washed out, blank, unfinished, sketch, bad anatomy, bad hands, extra fingers, blurry, text, watermark, signature, worst quality, low quality';

/** Where Comfy Desktop put ComfyUI: its install, Python, model paths, input and output. null: not installed. */
function locate(appData) {
  try {
    const dir = path.join(appData, 'Comfy Desktop');
    const installs = JSON.parse(fs.readFileSync(path.join(dir, 'installations.json'), 'utf8'));
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    const inst = installs.find((i) => i.installPath && i.status === 'installed' && fs.existsSync(path.join(i.installPath, 'ComfyUI', 'main.py')));
    if (!inst) return null;
    const python = path.join(inst.installPath, 'ComfyUI', '.venv', 'Scripts', 'python.exe');
    if (!fs.existsSync(python)) return null;
    return {
      root: inst.installPath,
      python,
      models: path.join(dir, 'instance-model-paths', `${inst.id}.yaml`),
      input: settings.inputDir,
      output: settings.outputDir,
    };
  } catch {
    return null;
  }
}

/** The workflow for one picture: her LoRA in when it's her, plain NoobAI otherwise. */
function workflow({ prompt, her = true, seed = Math.floor(Math.random() * 2 ** 48), width = 832, height = 1216 }) {
  const positive = [her ? HER : '', String(prompt || '').trim(), STYLE].filter(Boolean).join(', ');
  const model = her ? ['8', 0] : ['1', 0];
  const clip = her ? ['8', 1] : ['1', 1];
  const graph = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CHECKPOINT } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: positive, clip } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: NEGATIVE, clip } },
    4: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    5: {
      class_type: 'KSampler',
      inputs: { seed, steps: 28, cfg: 5, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1, model, positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] },
    },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { filename_prefix: 'capri_chat', images: ['6', 0] } },
  };
  if (her) graph[8] = { class_type: 'LoraLoader', inputs: { lora_name: LORA, strength_model: 0.8, strength_clip: 1, model: ['1', 0], clip: ['1', 1] } };
  return { graph, positive };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Comfy {
  /** deps: { appData, beforeJob() (frees the GPU: chat models out), log(line) } */
  constructor(deps) {
    this.d = deps;
    this.proc = null;
    this.starting = null;
    this.idleTimer = null;
    this.queue = Promise.resolve(); // one picture at a time
    this.base = `http://127.0.0.1:${PORT}`;
  }

  get installed() {
    return Boolean(locate(this.d.appData));
  }

  async api(route, { method = 'GET', body, timeout = 15000 } = {}) {
    const res = await fetch(this.base + route, {
      method, signal: AbortSignal.timeout(timeout),
      ...(body && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`ComfyUI ${route}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async alive() {
    try {
      await this.api('/system_stats', { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Up and answering: already running, or started now (a minute or so the first time). */
  async up() {
    clearTimeout(this.idleTimer);
    if (await this.alive()) return;
    if (this.starting) return this.starting;
    const where = locate(this.d.appData);
    if (!where) throw new Error('ComfyUI не найден: поставь Comfy Desktop');
    this.starting = (async () => {
      const args = ['-s', path.join('ComfyUI', 'main.py'), '--listen', '127.0.0.1', '--port', String(PORT), '--disable-auto-launch',
        '--extra-model-paths-config', where.models, '--input-directory', where.input, '--output-directory', where.output];
      this.proc = spawn(where.python, args, { cwd: where.root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let tail = '';
      this.proc.stderr.setEncoding('utf8');
      this.proc.stderr.on('data', (d) => { tail = (tail + d).slice(-2000); });
      this.proc.on('exit', () => { this.proc = null; });
      const until = Date.now() + START_MS;
      while (Date.now() < until) {
        if (!this.proc) throw new Error(`ComfyUI не запустился: ${tail.trim().split('\n').at(-1) || 'без ответа'}`);
        if (await this.alive()) return;
        await wait(1500);
      }
      this.stop();
      throw new Error('ComfyUI не поднялся за три минуты');
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  stop() {
    clearTimeout(this.idleTimer);
    if (!this.proc) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], { windowsHide: true });
      else this.proc.kill();
    } catch {}
    this.proc = null;
  }

  /** One picture: { png (Buffer), prompt (what was drawn) }. In turn with any other. */
  draw(request) {
    const job = this.queue.catch(() => {}).then(() => this.run(request));
    this.queue = job;
    return job;
  }

  async run({ prompt, her = true }) {
    await this.d.beforeJob?.();
    await this.up();
    try {
      const { graph, positive } = workflow({ prompt, her });
      const { prompt_id: id } = await (await this.api('/prompt', { method: 'POST', body: { prompt: graph, client_id: 'capri' } })).json();
      const until = Date.now() + JOB_MS;
      while (Date.now() < until) {
        await wait(1500);
        const history = (await (await this.api(`/history/${id}`)).json())[id];
        if (!history) continue;
        if (history.status?.status_str === 'error') {
          const msg = history.status.messages?.find(([kind]) => kind === 'execution_error')?.[1]?.exception_message;
          throw new Error(`ComfyUI: ${msg || 'ошибка'}`);
        }
        const image = Object.values(history.outputs || {}).flatMap((o) => o.images || [])[0];
        if (!image) continue;
        const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' });
        const png = Buffer.from(await (await this.api(`/view?${q}`, { timeout: 30000 })).arrayBuffer());
        return { png, prompt: positive };
      }
      throw new Error('ComfyUI рисовал дольше десяти минут');
    } finally {
      // the GPU back at once; the process goes after a few idle minutes (the next picture starts faster)
      this.api('/free', { method: 'POST', body: { unload_models: true, free_memory: true } }).catch(() => {});
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
    }
  }
}

module.exports = { Comfy, locate, workflow, PORT, HER };
