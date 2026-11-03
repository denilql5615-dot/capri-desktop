// Her moves as frames for the phone (capri-android, PackManager.kt): the phone draws poses from image frames,
// she is one cut-out bent by a shader (sprite.js). So each pose here is played through acting.js on her
// own renderer, off screen, at 12 or 24 frames a second, and every drawing kept as a WebP, her body turns,
// bobs and squashes included. main.js zips them for the phone bridge (phone.js /sprites).
//
// pose.json sizes the frames to the phone's ragdoll, so the two packs stand the same height: its standing
// rig has its eyes at y≈413 and its feet at 1440 of a 1024-wide canvas (1027 units); hers, at 1x, eyes at
// SPRITE.head.y and feet at SPRITE.feet.y. "classic" lists the ragdoll poses each one stands in for.

import { SpriteRenderer, SPRITE } from './sprite.js';
import { ACTS, NEUTRAL, Player, SHEET_FPS } from './acting.js';

export const PACK_VERSION = 2; // raise it when what's drawn here changes: the phone fetches it again

const RENDER_SCALE = 1.1;
const RIG_EYES_TO_FEET = 1027;
const ALL = ['chat', 'room', 'overlay'];

// id, the stance underneath, the act on top (none: the stance's loop), where the phone uses it, and the
// ragdoll poses it replaces while her PC pack is the one on
export const POSES = [
  { id: 'stand', base: 'stand', where: ALL, classic: ['standing', 'hips', '15_float', '12_wall_lean'] },
  { id: 'talk', base: 'stand', act: 'talk', where: ['chat', 'overlay'], scenes: ['обычная'] },
  { id: 'look', base: 'stand', act: 'look', where: ALL, classic: ['11_closeup_glass'] },
  { id: 'curious', base: 'stand', act: 'curious', where: ALL, classic: ['think', 'shrug'], scenes: ['ролевая'] },
  { id: 'point', base: 'stand', act: 'point', where: ['chat', 'overlay'], classic: ['point'] },
  { id: 'victory', base: 'stand', act: 'victory', where: ALL, classic: ['wave', 'peace'], scenes: ['угар', 'флирт'] },
  { id: 'stretch', base: 'stand', act: 'stretch', where: ALL, classic: ['stretch'] },
  { id: 'petted', base: 'stand', act: 'petted', where: ALL, scenes: ['флирт', 'забота'] },
  { id: 'huff', base: 'stand', act: 'huff', where: ALL, classic: ['angry'], scenes: ['ссора'] },
  { id: 'glare', base: 'stand', act: 'glare', where: ['chat', 'overlay'], scenes: ['ссора'] },
  { id: 'hop', base: 'stand', act: 'hop', where: ['overlay'] },
  { id: 'sit', base: 'sit', sit: true, where: ALL, room: 'bed',
    classic: ['01_sit_edge', '02_sit_crosslegged', '03_sit_hug_knees', '14_crouch', '13_floor_lean_bed', '07_bed_lean_back', '10_bed_kneel'] },
  { id: 'sleep', base: 'sleep', where: ALL, room: 'bed', scenes: ['ночь', 'грусть'],
    classic: ['06_sleep_curled', '04_lie_side', '05_lie_belly', '08_bed_hug_pillow', '09_bed_lie_back_phone'] },
];

const MAX_FRAMES = 72;

// how many frames a pose takes: one go of its act, or one cycle of its stance
function length(def) {
  const act = ACTS[def.act || def.base];
  const fps = act.fps || SHEET_FPS;
  const frames = act.keys.reduce((n, [hold]) => n + hold, 0);
  return { fps, count: Math.min(MAX_FRAMES, frames) };
}

// WebP with its alpha: her boiling line makes every PNG a big one, a fifth of it this way (the phone reads both)
const toWebp = (canvas) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? b.arrayBuffer().then(resolve, reject) : reject(new Error('no frame'))), 'image/webp', 0.9));

/** One pose as frames: { id, meta (its pose.json), frames: [ArrayBuffer WebP] }. */
export async function renderPose(image, def, redGrade) {
  const gl = document.createElement('canvas');
  const sprite = new SpriteRenderer(gl, image);
  if (redGrade) sprite.setImage(image, redGrade);
  sprite.resize(RENDER_SCALE);
  const out = document.createElement('canvas');
  out.width = gl.width;
  out.height = gl.height;
  const ctx = out.getContext('2d');
  const k = gl.width / (SPRITE.width + SPRITE.pad * 2); // canvas px per sprite px
  const pivot = { x: (SPRITE.pad + SPRITE.feet.x) * k, y: (SPRITE.pad + (def.sit ? SPRITE.hip : SPRITE.feet.y)) * k };

  const { fps, count } = length(def);
  const base = new Player(def.base, { at: 0 });
  const act = def.act ? new Player(def.act, { dir: 1, at: 0 }) : null;
  const p = {
    seed: 0, boil: 0.9, hair: 0, head: 0, mane: 0, armL: 0, armR: 0, longL: 1, longR: 1, sit: def.sit ? 1 : 0, bend: 0, kickL: 0, kickR: 0,
    smear: [0, 0], echo: [0, 0], glitch: 0, glitchSeed: 0, split: 0, collapse: 0, dissolve: 0, sparkle: 1, grade: 1,
    sil: [0.08, 0.06, 0.11], silAmount: 0, misreg: [-2.6, 2.2], alpha: 1,
  };
  const frames = [];
  for (let i = 0; i < count; i++) {
    const t = (i * 1000) / fps + 1;
    const under = base.sample(t);
    const top = act?.sample(t);
    const pose = { ...NEUTRAL, ...(under ? base.resolve(under.pose, 1) : {}), ...(top ? act.resolve(top.pose, 1) : {}) };
    Object.assign(p, {
      seed: (i * 37.17) % 100, head: pose.head, mane: pose.mane, hair: pose.hair, armL: pose.armL, armR: pose.armR,
      longL: pose.longL, longR: pose.longR, kickL: pose.kickL, kickR: pose.kickR, bend: pose.bend, smear: pose.smear, echo: pose.echo,
    });
    sprite.draw(p);
    // her body, as capri.js turns it on screen: bobbing, leaning around her feet (her hips seated), squashed
    ctx.clearRect(0, 0, out.width, out.height);
    ctx.save();
    ctx.translate(pivot.x, pivot.y + (def.sit ? Math.max(-3, Math.min(2, pose.bob)) : pose.bob) * k);
    ctx.rotate((pose.tilt * Math.PI) / 180);
    ctx.scale(pose.sx, pose.sy);
    ctx.translate(-pivot.x, -pivot.y);
    ctx.drawImage(gl, 0, 0);
    ctx.restore();
    frames.push(await toWebp(out));
  }
  sprite.gl.getExtension('WEBGL_lose_context')?.loseContext();

  const eyes = (SPRITE.pad + SPRITE.head.y) * k;
  const feet = (SPRITE.pad + SPRITE.feet.y) * k;
  const meta = {
    _: 'Capri on the PC, drawn off screen by capri-desktop (phonepack.js) for the phone.',
    fps, loop: true,
    scale: +(RIG_EYES_TO_FEET * out.width / (1024 * (feet - eyes))).toFixed(4),
    anchor_y: +(pivot.y / out.height).toFixed(4),
    head_w: 317,
    where: def.where,
    ...(def.room && { room: def.room }),
    ...(def.scenes && { scenes: def.scenes }),
    ...(def.classic && { classic: def.classic }),
  };
  return { id: def.id, meta, frames };
}
