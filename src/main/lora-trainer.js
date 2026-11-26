'use strict';

// LoRA training for Altair (Danyal 2026-11-26): from pictures he sends (the chat's attachments, folders or
// archives on the PC) she builds a dataset, writes a OneTrainer config and trains a LoRA on the drawer's own
// checkpoint, then draws with it (comfy_generate lora=...). One training at a time: it takes the whole GPU.
// Layout: <root>/<slug>/{dataset/, config.json, train.log, meta.json}; the LoRA lands in ComfyUI's loras.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DEFAULTS = {
  root: 'D:\\Capri\\lora',
  oneTrainer: 'D:\\Capri\\tools\\OneTrainer',
  // the run that trained her own LoRAs on this GPU (NoobAI, rank 16, AdamW 8-bit, 1e-4 cosine, 1024, batch 1)
  template: 'D:\\Capri\\tools\\OneTrainer\\workspace\\run\\config\\2026-11-05_00-00-39.json',
  models: 'D:\\Comfy-Desktop\\ComfyUI-Shared\\models',
};
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const ARCHIVE_RE = /\.(zip|7z|tar|tgz|tar\.gz|rar)$/i;
// Windows' own bsdtar (zip / 7z / rar / tar), not a GNU tar that a Git shell may put first on PATH
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
// a real person's LoRA never draws her undressed or sexual: her consent was for her posts, not this
const REAL_PERSON_NEGATIVE = 'nsfw, nude, naked, topless, nipples, lingerie, underwear, sexual, explicit, child, loli';
const REAL_PERSON_BLOCK = /\b(nsfw|nude|naked|topless|nipples?|lingerie|underwear|sex|sexual|explicit|porn|hentai|undress\w*|bare (breasts?|chest)|loli|child|kid)\b|голая|голой|обнаж|без одежды|секс|эротик|порно|раздет/i;
const MIN_IMAGES = 5;
const MAX_IMAGES = 200;
const TARGET_STEPS = 1500; // about 1500 steps at batch 1 trained her face LoRA well

const slugOf = (name) => String(name || '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
// A small vision model answers in the prompt's shape: "framing (upper body)", "props (none)", "no changes", or
// the bare category names. One clean tag list: the values in brackets, without "none"/"no …"/category words.
const CATEGORY_WORDS = /^(framing|pose|costume|clothes|costume and clothes( with colou?rs)?|wig|hairstyle|wig or hairstyle( with hair colou?r)?|hair colou?r|makeup( that is visible)?|visible makeup|contact lenses( colou?r)?|props?|accessor(y|ies)|background|lighting|photo style|style|hand position|tags?|none|n\/a|no changes?|nothing)$/i;
function cleanCaption(text) {
  const out = [];
  // "costume and clothes with colours (red jacket, yellow pants)" → "red jacket, yellow pants" before splitting
  const flat = String(text || '').replace(/[A-Za-z][A-Za-z /]*\(([^()]*)\)/g, '$1');
  for (let part of flat.split(/[\r\n,;]+/)) {
    part = part.replace(/^[\s\-*•\d.)]+|[\s.]+$/g, '').replace(/\s+/g, ' ').trim();
    const m = part.match(/^[^()]*\(([^()]*)\)\s*$/); // "framing (upper body)" → "upper body"
    if (m) part = m[1].trim();
    part = part.replace(/^(framing|pose|costume|wig|makeup|props?|accessor(y|ies)|background|lighting|photo style)\s*:\s*/i, '');
    if (!part || CATEGORY_WORDS.test(part) || /^no\b/i.test(part) || /\bnone\b/i.test(part) || part.length > 60) continue;
    for (const p of part.split(/\s*\/\s*/)) if (p && !out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  }
  return out.slice(0, 30).join(', ');
}
const epochsFor = (n) => Math.min(120, Math.max(10, Math.round(TARGET_STEPS / Math.max(1, n))));

function walkImages(dir, out = [], depth = 0) {
  if (depth > 6 || out.length > MAX_IMAGES * 2) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '__MACOSX') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkImages(p, out, depth + 1);
    else if (e.isFile() && IMAGE_RE.test(e.name)) out.push(p);
  }
  return out;
}

class LoraTrainer {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.job = null; // { slug, proc, startedAt, log }
  }

  dir(slug) { return path.join(this.o.root, slug); }
  loraFile(slug) { return path.join(this.o.models, 'loras', `${slug}.safetensors`); }
  busy() { return Boolean(this.job); }

  readMeta(slug) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir(slug), 'meta.json'), 'utf8')); } catch { return null; }
  }

  writeMeta(slug, patch) {
    const meta = { ...(this.readMeta(slug) || {}), ...patch };
    fs.writeFileSync(path.join(this.dir(slug), 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  /** LoRAs she can draw with: trained here (meta) and any other file in ComfyUI's loras folder. */
  list() {
    const out = [];
    const seen = new Set();
    try {
      for (const slug of fs.readdirSync(this.o.root)) {
        const meta = this.readMeta(slug);
        if (!meta) continue;
        const name = meta.name || slug; // a folder may hold a LoRA of another name (gemini → gemini_brigade_v2)
        seen.add(name);
        out.push({ name, trigger: meta.trigger, outfit: meta.outfit || null, tags: meta.tags || null, main: Boolean(meta.main), aliases: Array.isArray(meta.aliases) ? meta.aliases : [], note: meta.note || null, real_person: Boolean(meta.real_person), kind: meta.kind || null, parts: meta.outfit_parts && typeof meta.outfit_parts === 'object' ? meta.outfit_parts : null, drawer: meta.drawer, status: meta.status, images: meta.images, ready: fs.existsSync(this.loraFile(name)) });
      }
    } catch {}
    try {
      for (const f of fs.readdirSync(path.join(this.o.models, 'loras'))) {
        const slug = f.replace(/\.safetensors$/i, '');
        if (!/\.safetensors$/i.test(f) || seen.has(slug) || /^ip-adapter|^capri_/i.test(f)) continue;
        // trained elsewhere (no meta): the file name is the trigger by our convention; "_e60" / "_v3" = a copy
        // of another epoch or version
        out.push({ name: slug, trigger: slug.replace(/_(e|v)\d+$/i, ''), drawer: null, status: 'file', ready: true });
      }
    } catch {}
    // his notes (lora-library.js, GENESIS/ComfyUI/LoRA) win over meta.json: what he edits by hand is what she uses
    const notes = (() => { try { return typeof this.o.notes === 'function' ? this.o.notes() || {} : {}; } catch { return {}; } })();
    for (const l of out) {
      const n = notes[l.name];
      if (!n) continue;
      Object.assign(l, {
        title: n.title || l.title || null,
        aliases: [...new Set([...(l.aliases || []), ...(n.aliases || [])])],
        tags: n.always || l.tags || null,
        negative: n.negative || null,
        drawer: n.drawer || l.drawer,
        outfit: n.outfit !== null && n.outfit !== undefined ? n.outfit : l.outfit,
        parts: n.parts && Object.keys(n.parts).length ? n.parts : (l.parts || null),
        looks: n.looks || [],
        note: n.file,
        main: true, // a LoRA he keeps a note for is the one to draw that character with
      });
    }
    // other files of a character that has a main LoRA are its old versions (kept, not offered first)
    const mains = new Set(out.filter((l) => l.main).map((l) => l.trigger));
    for (const l of out) if (!l.main && l.status === 'file' && mains.has(l.trigger)) l.alt = true;
    // an old version of a real person's LoRA (lyana.safetensors next to lyana_v2) is still her: same guard
    const people = new Map(out.filter((l) => l.real_person).map((l) => [l.trigger, l]));
    for (const l of out) {
      const p = l.status === 'file' && people.get(l.trigger);
      if (p) Object.assign(l, { real_person: true, kind: p.kind || 'person', negative: l.negative || p.negative || null });
    }
    return out;
  }

  /**
   * Dataset: pictures (Buffers from the chat) + paths (image files, folders, archives) → <slug>/dataset,
   * a caption per picture: "<trigger>, <subject>". Fixed traits stay untagged so they bind to the trigger.
   */
  prepare({ name, drawer = 'art', subject = '', outfit = '', kind = 'character', images = [], paths = [], drawers = {} } = {}) {
    const slug = slugOf(name);
    if (!slug) throw new Error('Нужно имя LoRA латиницей или цифрами (например gemini_brigade).');
    if (this.job?.slug === slug) throw new Error(`LoRA ${slug} сейчас обучается.`);
    const checkpoint = drawers[drawer]?.checkpoint;
    if (!checkpoint) throw new Error(`Нет рисовальщика ${drawer}: art, photo или portrait.`);
    const root = this.dir(slug);
    const data = path.join(root, 'dataset');
    fs.rmSync(data, { recursive: true, force: true });
    fs.mkdirSync(data, { recursive: true });
    const raw = path.join(root, 'incoming');
    fs.rmSync(raw, { recursive: true, force: true });

    // collect: buffers first, then files / folders / archives (each archive into its own empty folder)
    const files = [];
    for (const p of (Array.isArray(paths) ? paths : String(paths || '').split(/[;\n]|,(?=\s*[A-Za-z]:)/)).map((s) => String(s).trim().replace(/^"|"$/g, '')).filter(Boolean)) {
      if (!fs.existsSync(p)) throw new Error(`Не нашла: ${p}`);
      const st = fs.statSync(p);
      if (st.isDirectory()) walkImages(p, files);
      else if (IMAGE_RE.test(p)) files.push(p);
      else if (ARCHIVE_RE.test(p)) {
        const dest = path.join(raw, `a${files.length}_${path.basename(p).replace(/[^\w.-]/g, '_')}`);
        fs.mkdirSync(dest, { recursive: true });
        // Windows bsdtar reads zip / 7z / tar / rar; it refuses absolute and ".." paths by default
        execFileSync(TAR, ['-xf', p, '-C', dest], { windowsHide: true, timeout: 600000 });
        walkImages(dest, files);
      } else throw new Error(`Не картинка, не папка и не архив: ${p}`);
    }
    const total = images.length + files.length;
    if (total < MIN_IMAGES) throw new Error(`Мало картинок: ${total}. Для LoRA нужно хотя бы ${MIN_IMAGES}, лучше 15–40 разных ракурсов и эмоций.`);
    // outfit: a tag of its own for the costume on these pictures, so "<trigger>, <outfit>" calls it whole and
    // other clothes replace it cleanly (Danyal 2026-11-26: the jacket stuck to the trigger without it)
    const outfitTag = slugOf(outfit);
    const caption = [slug, outfitTag, String(subject || '').trim()].filter(Boolean).join(', ');
    let n = 0;
    const put = (buf, ext) => {
      if (n >= MAX_IMAGES) return;
      n += 1;
      const base = String(n).padStart(4, '0');
      fs.writeFileSync(path.join(data, `${base}${ext}`), buf);
      fs.writeFileSync(path.join(data, `${base}.txt`), caption);
    };
    for (const b of images) put(b, b[0] === 0xff ? '.jpg' : (b.slice(8, 12).toString() === 'WEBP' ? '.webp' : '.png'));
    for (const f of files) put(fs.readFileSync(f), path.extname(f).toLowerCase().replace('.jpeg', '.jpg'));
    fs.rmSync(raw, { recursive: true, force: true });

    const epochs = epochsFor(n);
    this.writeConfig(slug, path.join(this.o.models, 'checkpoints', checkpoint), epochs, caption, kind);
    // a real person (kind "person"): captions per photo before training, and her pictures stay private
    return this.writeMeta(slug, { name: slug, trigger: slug, outfit: outfitTag || null, drawer, subject, kind, real_person: kind === 'person', images: n, epochs, status: 'prepared', preparedAt: new Date().toISOString() });
  }

  writeConfig(slug, checkpointPath, epochs, caption, kind = 'character') {
    const base = JSON.parse(fs.readFileSync(this.o.template, 'utf8'));
    const root = this.dir(slug);
    const fwd = (p) => p.replace(/\\/g, '/');
    const concept = JSON.parse(JSON.stringify(base.concepts[0]));
    Object.assign(concept, { name: slug, path: fwd(path.join(root, 'dataset')), enabled: true });
    Object.assign(concept.image, { resolution_override: '1024', enable_resolution_override: false });
    Object.assign(concept.text, { prompt_source: 'sample', enable_tag_shuffling: true, keep_tags_count: 1, tag_delimiter: ',' });
    // a real person's samples: dressed, nothing explicit (a bare "1girl" prompt on a photo model drew a nude)
    const person = kind === 'person';
    const sample = { ...JSON.parse(JSON.stringify(base.samples[0])), prompt: `${caption}${person ? ', adult woman, fully clothed, cosplay costume' : ''}, looking at viewer`, negative_prompt: `lowres, worst quality, bad anatomy, blurry, watermark, text${person ? ', ' + REAL_PERSON_NEGATIVE : ''}`, width: 832, height: 1216, seed: 42 };
    const cfg = {
      ...base,
      base_model_name: checkpointPath,
      output_model_destination: fwd(this.loraFile(slug)),
      workspace_dir: fwd(path.join(root, 'workspace')),
      cache_dir: fwd(path.join(root, 'cache')),
      concept_file_name: fwd(path.join(root, 'concepts.json')),
      sample_definition_file_name: fwd(path.join(root, 'samples.json')),
      concepts: [concept],
      samples: [sample],
      epochs,
      save_every: Math.max(10, Math.round(epochs / 4)), save_every_unit: 'EPOCH',
      sample_after: Math.max(10, Math.round(epochs / 4)), sample_after_unit: 'EPOCH',
      backup_after: 9999, backup_after_unit: 'EPOCH', continue_last_backup: false,
    };
    fs.writeFileSync(path.join(root, 'concepts.json'), JSON.stringify([concept], null, 2));
    fs.writeFileSync(path.join(root, 'samples.json'), JSON.stringify([sample], null, 2));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg, null, 2));
  }

  /**
   * Captions for a person LoRA: what changes from photo to photo, said by describe(buffer) → "tags", so the
   * trigger keeps only her face and body. "<trigger>, <subject>, <tags>" per photo.
   */
  async caption(slug, describe, { onProgress } = {}) {
    const meta = this.readMeta(slug);
    const data = path.join(this.dir(slug), 'dataset');
    const pics = fs.readdirSync(data).filter((f) => IMAGE_RE.test(f)).sort();
    let i = 0;
    for (const f of pics) {
      i += 1;
      let tags = '';
      try { tags = String(await describe(fs.readFileSync(path.join(data, f))) || ''); } catch {}
      tags = cleanCaption(tags);
      const cap = [meta.trigger, String(meta.subject || '').trim(), tags].filter(Boolean).join(', ');
      fs.writeFileSync(path.join(data, f.replace(/\.[^.]+$/, '.txt')), cap);
      onProgress?.(i, pics.length);
    }
    return pics.length;
  }

  /** Starts training in the background; onDone({ ok, slug, file, error }) when it ends. */
  async start(slug, { beforeTrain, onDone, describe } = {}) {
    slug = slugOf(slug);
    if (this.job) throw new Error(`Уже обучается ${this.job.slug}: дождись конца (одно обучение за раз, видеокарта одна).`);
    const meta = this.readMeta(slug);
    if (!meta || !fs.existsSync(path.join(this.dir(slug), 'config.json'))) throw new Error(`LoRA ${slug} не подготовлена: сначала собери датасет.`);
    const log = path.join(this.dir(slug), 'train.log');
    const captioning = meta.kind === 'person' && typeof describe === 'function';
    this.job = { slug, proc: null, startedAt: Date.now(), log, epochs: meta.epochs, phase: captioning ? 'captioning' : 'training', captioned: 0, toCaption: meta.images };
    const fail = (error) => {
      this.writeMeta(slug, { status: 'failed', endedAt: new Date().toISOString(), error });
      this.job = null;
      try { onDone?.({ ok: false, slug, file: null, error }); } catch {}
    };
    (async () => {
      if (captioning) {
        this.writeMeta(slug, { status: 'captioning' });
        await this.caption(slug, describe, { onProgress: (i) => { if (this.job) this.job.captioned = i; } });
      }
      if (typeof beforeTrain === 'function') await beforeTrain(); // the chat and vision models out of VRAM
      const out = fs.openSync(log, 'w');
      const py = path.join(this.o.oneTrainer, 'venv', 'Scripts', 'python.exe');
      const proc = spawn(py, ['scripts/train.py', '--config-path', path.join(this.dir(slug), 'config.json')], {
        cwd: this.o.oneTrainer, windowsHide: true, stdio: ['ignore', out, out],
      });
      Object.assign(this.job, { proc, phase: 'training', startedAt: Date.now() });
      this.writeMeta(slug, { status: 'training', startedAt: new Date().toISOString() });
      proc.on('exit', (code) => {
        try { fs.closeSync(out); } catch {}
        const ok = code === 0 && fs.existsSync(this.loraFile(slug));
        this.writeMeta(slug, { status: ok ? 'ready' : 'failed', endedAt: new Date().toISOString(), ...(ok ? {} : { error: this.tail(log) }) });
        this.job = null;
        try { onDone?.({ ok, slug, file: this.loraFile(slug), error: ok ? null : this.tail(log) }); } catch {}
      });
    })().catch((err) => fail(err.message));
    return { slug, epochs: meta.epochs, images: meta.images, captioning, etaMin: Math.round(meta.epochs * meta.images * 1.9 / 60) + 3 + (captioning ? Math.ceil(meta.images / 6) : 0) };
  }

  tail(log, chars = 600) {
    try {
      const t = fs.readFileSync(log, 'utf8').replace(/\r/g, '\n');
      const err = t.lastIndexOf('Traceback');
      return (err >= 0 ? t.slice(err) : t).trim().slice(-chars);
    } catch { return ''; }
  }

  /** Progress of the running training, from OneTrainer's own bars. */
  status() {
    if (!this.job) return { running: false };
    if (this.job.phase === 'captioning') return { running: true, slug: this.job.slug, phase: 'captioning', captioned: this.job.captioned, toCaption: this.job.toCaption, epoch: 0, epochs: this.job.epochs, minutes: Math.round((Date.now() - this.job.startedAt) / 60000), etaMin: null };
    const t = (() => { try { return fs.readFileSync(this.job.log, 'utf8').slice(-20000).replace(/\r/g, '\n'); } catch { return ''; } })();
    const epochs = [...t.matchAll(/epoch:\s*\d+%\|[^|]*\|\s*(\d+)\/(\d+)/g)].at(-1);
    const done = epochs ? Number(epochs[1]) : 0;
    const all = epochs ? Number(epochs[2]) : this.job.epochs;
    const min = (Date.now() - this.job.startedAt) / 60000;
    return { running: true, slug: this.job.slug, epoch: done, epochs: all, minutes: Math.round(min), etaMin: done ? Math.round(min / done * (all - done)) : null };
  }

  stop() {
    if (!this.job) return false;
    if (!this.job.proc) return false; // still captioning: it ends by itself in a few minutes
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(this.job.proc.pid), '/T', '/F'], { windowsHide: true });
      else this.job.proc.kill();
    } catch {}
    return true;
  }
}

module.exports = { LoraTrainer, slugOf, epochsFor, cleanCaption, REAL_PERSON_NEGATIVE, REAL_PERSON_BLOCK, DEFAULTS };
