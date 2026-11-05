'use strict';

// "Скинь фото": pictures from ComfyUI, the one Comfy Desktop installed (D:\Comfy-Desktop), started only when
// one is asked for and never shown: its own Python and models, a port of its own on this PC, no manager, no
// window. While it draws, the chat models in Ollama are unloaded (8 GB of VRAM holds one of them at a time);
// once the picture is out its models are unloaded too, and the process itself goes after a few idle minutes.
// The workflow is the one that drew her best (NoobAI XL, her capri_cp LoRA at 0.8): plain JSON through its API.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const PORT = 8189; // not Comfy Desktop's own: the two can't clash
// Comfy Desktop's own ComfyUI, while its window is open: the port it wrote down last (comfy-procs), else its default
function desktopPort(appData) {
  try {
    const dir = path.join(appData, 'Comfy Desktop', 'comfy-procs');
    const last = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
      .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))).sort((a, b) => (b.spawnedAt || 0) - (a.spawnedAt || 0))[0];
    return Number.isInteger(last?.port) && last.port !== PORT ? last.port : 8188;
  } catch {
    return 8188;
  }
}
const IDLE_MS = 5 * 60 * 1000;
const START_MS = 3 * 60 * 1000;
const JOB_MS = 10 * 60 * 1000;

const CHECKPOINT = 'noobaiXLNAIXL_epsilonPred11Version(1).safetensors';
const LORA = 'capri_face_and_figure.safetensors';
// what she looks like, said the way her capri_face_and_figure + capri_body + capri_cp LoRAs learnt her
const HER = 'capri_face, capri_body, capri_cp, 1girl, solo, pink spiky hair, green visor, black bodysuit, red and green panels, angular shapes, sharp lines, stylized';
const STYLE = 'flat colors, purple outline, vibrant colors, masterpiece, best quality';
const NEGATIVE = '3d, photorealistic, realistic skin, human skin, peach skin, nose, lips, glossy, dull, washed out, blank, unfinished, sketch, bad anatomy, bad hands, extra fingers, blurry, text, watermark, signature, worst quality, low quality';

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
      inputs: { seed, steps: 30, cfg: 6.5, sampler_name: 'euler_ancestral', scheduler: 'normal', denoise: 1, model, positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] },
    },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { filename_prefix: 'capri_chat', images: ['6', 0] } },
  };
  if (her) {
    graph[10] = { class_type: 'LoraLoader', inputs: { lora_name: 'capri_cp.safetensors', strength_model: 0.35, strength_clip: 0.8, model: ['1', 0], clip: ['1', 1] } };
    graph[11] = { class_type: 'LoraLoader', inputs: { lora_name: 'capri_body.safetensors', strength_model: 0.45, strength_clip: 0.8, model: ['10', 0], clip: ['10', 1] } };
    graph[8] = { class_type: 'LoraLoader', inputs: { lora_name: LORA, strength_model: 1.05, strength_clip: 1, model: ['11', 0], clip: ['11', 1] } };
  }
  return { graph, positive };
}

// Your own workflow (her menu, "Фото: свой воркфлоу ComfyUI…"): built and tried in ComfyUI with your LoRAs,
// saved with Workflow → Export (API), {prompt} written where her tags go in the positive prompt. Pictures of
// her are drawn with it as it is; only {prompt} is filled and the seed is new each time. Pictures that aren't
// of her keep the plain built-in one (your LoRAs would put her in them).
const PLACEHOLDER = '{prompt}';
const SEED_INPUTS = ['seed', 'noise_seed'];

/** Your workflow checked: { graph } or { error } in plain words. */
function checkWorkflow(json) {
  let graph;
  try {
    graph = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return { error: 'это не JSON' };
  }
  if (Array.isArray(graph?.nodes)) return { error: 'это обычное сохранение, а нужно Workflow → Export (API)' };
  const nodes = graph && typeof graph === 'object' ? Object.values(graph) : [];
  if (!nodes.length || !nodes.every((n) => n && typeof n.class_type === 'string' && n.inputs && typeof n.inputs === 'object')) {
    return { error: 'не похоже на воркфлоу ComfyUI в формате API' };
  }
  if (!nodes.some((n) => Object.values(n.inputs).some((v) => typeof v === 'string' && v.includes(PLACEHOLDER)))) {
    return { error: `в промпте нет метки ${PLACEHOLDER}: поставь её туда, куда Капри подставит, что просили` };
  }
  if (!nodes.some((n) => /SaveImage|PreviewImage/.test(n.class_type))) return { error: 'нет узла Save Image' };
  return { graph };
}

/** A copy of your workflow for one picture: {prompt} filled, every seed new, saved under her prefix. */
function fillWorkflow(graph, { prompt, seed = Math.floor(Math.random() * 2 ** 48) }) {
  const out = JSON.parse(JSON.stringify(graph));
  const tags = String(prompt || '').trim();
  let positive = '';
  for (const node of Object.values(out)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      if (typeof value === 'string' && value.includes(PLACEHOLDER)) {
        node.inputs[key] = value.split(PLACEHOLDER).join(tags).replace(/,(\s*,)+/g, ',').replace(/^[\s,]+|[\s,]+$/g, '');
        positive = positive || node.inputs[key];
      }
      if (SEED_INPUTS.includes(key) && typeof value === 'number') node.inputs[key] = seed;
    }
    if (node.class_type === 'SaveImage') node.inputs.filename_prefix = 'capri_chat';
  }
  return { graph: out, positive };
}

/** Your workflow from its file: the graph, or null (none, or it no longer checks out). */
function loadWorkflow(file) {
  if (!file) return null;
  try {
    const { graph, error } = checkWorkflow(fs.readFileSync(file, 'utf8'));
    if (error) console.warn(`[capri] your ComfyUI workflow: ${error}`);
    return graph || null;
  } catch {
    return null;
  }
}

// "Скинь видео": Wan 2.1 VACE 1.3B (Comfy-Org's repack, in ComfyUI's own models: diffusion_models,
// text_encoders, vae), her still as the reference, two seconds at 16 fps, portrait 480×832, saved as
// WebM (VP9: Electron and Android both play it). ~11 GB on disk; on 8 GB of VRAM it takes a few minutes.
const VIDEO_MODELS = {
  unet: 'wan2.1_vace_1.3B_fp16.safetensors',
  clip: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  vae: 'wan_2.1_vae.safetensors',
};
const VIDEO_MS = 25 * 60 * 1000;
const VIDEO_HER = '2D flat cartoon animation, stylized geometric character, pitch-black face with glowing green rectangular visor and concentric blue circular eyes, sharp white triangular grin, spiky starry neon pink hair with black tips, red and green geometric bodysuit, purple outline';
const VIDEO_NEGATIVE = 'anime girl face, human face, human skin, peach skin, pale skin, flesh, nose, lips, 3d, photorealistic, character morphing, changing character, white flash, overexposed, static, frozen, still image, blurry, low quality, distorted face, deformed hands, extra limbs, flicker, watermark, text, subtitles';

/** The Wan VACE graph: `image` (in ComfyUI's input folder) brought to life as `prompt` says. 21 frames fit inside
 * 8 GB VRAM without system RAM spill (~2x faster) and stay inside the zero-drift window; `shift: 4.2` locks her
 * green visor, blue ring eyes, and triangular grin. Uses RTX 4060 Ada FP8 Tensor Cores (`fp8_e4m3fn_fast`). */
function videoGraph({ prompt, image, seed = Math.floor(Math.random() * 2 ** 48), width = 480, height = 832, frames = 21, steps = 15 }) {
  const text = [String(prompt || '').trim(), 'anime style, cel shading, crisp lineart, smooth natural motion, lively expression, consistent character', VIDEO_HER].filter(Boolean).join(', ');
  const empty = (batch, color) => ({ class_type: 'EmptyImage', inputs: { width, height, batch_size: batch, color } });
  return {
    13: { class_type: 'ImageScale', inputs: { image: ['6', 0], upscale_method: 'lanczos', width, height, crop: 'center' } },
    14: empty(frames - 1, 0x7f7f7f),
    15: { class_type: 'ImageBatch', inputs: { image1: ['13', 0], image2: ['14', 0] } }, // the control video
    16: empty(1, 0x000000),
    17: empty(frames - 1, 0xffffff),
    18: { class_type: 'ImageBatch', inputs: { image1: ['16', 0], image2: ['17', 0] } },
    19: { class_type: 'ImageToMask', inputs: { image: ['18', 0], channel: 'red' } }, // 0: keep, 1: draw
    1: { class_type: 'UNETLoader', inputs: { unet_name: VIDEO_MODELS.unet, weight_dtype: 'fp8_e4m3fn_fast' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: VIDEO_MODELS.clip, type: 'wan', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: VIDEO_MODELS.vae } },
    4: { class_type: 'CLIPTextEncode', inputs: { text, clip: ['2', 0] } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: VIDEO_NEGATIVE, clip: ['2', 0] } },
    6: { class_type: 'LoadImage', inputs: { image } },
    7: {
      class_type: 'WanVaceToVideo',
      inputs: {
        positive: ['4', 0], negative: ['5', 0], vae: ['3', 0], width, height, length: frames, batch_size: 1, strength: 1,
        control_video: ['15', 0], control_masks: ['19', 0], reference_image: ['13', 0],
      },
    },
    8: { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 4.2 } },
    9: {
      class_type: 'KSampler',
      inputs: { seed, steps, cfg: 5.0, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1, model: ['8', 0], positive: ['7', 0], negative: ['7', 1], latent_image: ['7', 2] },
    },
    10: { class_type: 'TrimVideoLatent', inputs: { samples: ['9', 0], trim_amount: ['7', 3] } },
    11: { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
    12: { class_type: 'SaveWEBM', inputs: { images: ['11', 0], filename_prefix: 'capri_video', codec: 'vp9', fps: 16, crf: 20 } },
  };
}

/** Whether the video models are in ComfyUI's models folder (`modelsRoot`): the ones missing. */
function missingVideoModels(modelsRoot) {
  const where = { unet: 'diffusion_models', clip: 'text_encoders', vae: 'vae' };
  return Object.entries(VIDEO_MODELS).filter(([k, file]) => !fs.existsSync(path.join(modelsRoot, where[k], file))).map(([, file]) => file);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Comfy {
  /** deps: { appData, beforeJob() (frees the GPU: chat models out), workflowFile() (yours, or null) } */
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

  /** The video models not in ComfyUI's models folder yet ([] : ready; null: no ComfyUI). */
  videoMissing() {
    const where = locate(this.d.appData);
    if (!where) return null;
    let root = path.join(where.root, 'ComfyUI', 'models');
    try {
      // the real line, not the commented example above it ("#     base_path: '...'")
      const m = /^[ \t]+base_path:[ \t]*'([^']+)'/m.exec(fs.readFileSync(where.models, 'utf8'));
      if (m) root = m[1];
    } catch {}
    return missingVideoModels(root);
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
    return this.aliveAt(this.base);
  }

  async aliveAt(base) {
    try {
      return (await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(2000) })).ok;
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
    return this.enqueue(() => this.session(() => this.picture(request)));
  }

  /** A short clip of her: { png (the still it starts from), webm, prompt }. The still is drawn like a picture
   * (your workflow if you set one), then Wan 2.1 VACE brings it to life. In turn with any other. */
  animate({ prompt }) {
    return this.enqueue(() => this.session(async () => {
      const still = await this.picture({ prompt, her: true });
      await this.api('/free', { method: 'POST', body: { unload_models: true, free_memory: true } }).catch(() => {});
      const image = await this.upload(still.png);
      const rawWebm = await this.submit(videoGraph({ prompt, image }), VIDEO_MS);
      const webm = this.smoothLoop(rawWebm);
      return { png: still.png, webm, prompt: still.prompt };
    }));
  }

  /** Trims the initial VACE mask-transition frames and builds a seamless ping-pong WebM loop (~2s at 16fps). */
  smoothLoop(webm) {
    const where = locate(this.d.appData);
    if (!where?.python) return webm;
    const tmpIn = path.join(os.tmpdir(), `capri_v_in_${Date.now()}.webm`);
    const tmpOut = path.join(os.tmpdir(), `capri_v_out_${Date.now()}.webm`);
    try {
      fs.writeFileSync(tmpIn, webm);
      const script = [
        'import sys, av',
        'cin = av.open(sys.argv[1])',
        'imgs = [f.to_image() for f in cin.decode(video=0)]',
        'cin.close()',
        'core = imgs[4:] if len(imgs) >= 12 else imgs',
        'seq = core + core[-2:0:-1]',
        'cout = av.open(sys.argv[2], mode="w", format="webm")',
        's = cout.add_stream("libvpx-vp9", rate=16)',
        's.width, s.height, s.pix_fmt = seq[0].width, seq[0].height, "yuv420p"',
        's.options = {"crf": "20", "b": "0"}',
        'for im in seq:',
        '    for p in s.encode(av.VideoFrame.from_image(im)): cout.mux(p)',
        'for p in s.encode(): cout.mux(p)',
        'cout.close()',
      ].join('\n');
      execFileSync(where.python, ['-c', script, tmpIn, tmpOut], { timeout: 20000, windowsHide: true });
      return fs.readFileSync(tmpOut);
    } catch {
      return webm;
    } finally {
      try { fs.unlinkSync(tmpIn); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}
    }
  }

  enqueue(work) {
    const job = this.queue.catch(() => {}).then(work);
    this.queue = job;
    return job;
  }

  async picture({ prompt, her = true }) {
    const yours = her ? loadWorkflow(this.d.workflowFile?.()) : null;
    const { graph, positive } = yours ? fillWorkflow(yours, { prompt }) : workflow({ prompt, her });
    return { png: await this.submit(graph), prompt: positive };
  }

  /** A picture into ComfyUI's input folder (for LoadImage): its name there. */
  async upload(png) {
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), `capri_still_${Date.now()}.png`);
    form.append('overwrite', 'true');
    const res = await fetch(`${this.base}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`ComfyUI /upload/image: ${res.status}`);
    const { name, subfolder } = await res.json();
    return subfolder ? `${subfolder}/${name}` : name;
  }

  /** A graph run to its first saved file (a picture or a video): that file. */
  async submit(graph, timeout = JOB_MS) {
    const { prompt_id: id } = await (await this.api('/prompt', { method: 'POST', body: { prompt: graph, client_id: 'capri' } })).json();
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      await wait(1500);
      const history = (await (await this.api(`/history/${id}`)).json())[id];
      if (!history) continue;
      if (history.status?.status_str === 'error') {
        const msg = history.status.messages?.find(([kind]) => kind === 'execution_error')?.[1]?.exception_message;
        throw new Error(`ComfyUI: ${msg || 'ошибка'}`);
      }
      const file = Object.values(history.outputs || {}).flatMap((o) => o.images || [])[0];
      if (!file) continue;
      const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
      return Buffer.from(await (await this.api(`/view?${q}`, { timeout: 60000 })).arrayBuffer());
    }
    throw new Error(`ComfyUI работал дольше ${Math.round(timeout / 60000)} минут`);
  }

  // the GPU for the job, from ComfyUI: Comfy Desktop's while it's open (you trying your workflow: the same
  // models and nodes, a second one wouldn't fit in 8 GB beside it), else her own, started now
  async session(work) {
    await this.d.beforeJob?.();
    const desktop = `http://127.0.0.1:${desktopPort(this.d.appData)}`;
    const own = this.base;
    if (!this.proc && await this.aliveAt(desktop)) this.base = desktop;
    else await this.up();
    try {
      return await work();
    } finally {
      // the GPU back at once; the process goes after a few idle minutes (the next picture starts faster)
      this.api('/free', { method: 'POST', body: { unload_models: true, free_memory: true } }).catch(() => {});
      const borrowed = this.base !== own;
      this.base = own;
      if (!borrowed) {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.stop(), IDLE_MS);
      }
    }
  }
}

module.exports = {
  Comfy, locate, workflow, checkWorkflow, fillWorkflow, loadWorkflow, videoGraph, missingVideoModels, VIDEO_MODELS, PLACEHOLDER, PORT, HER,
};
