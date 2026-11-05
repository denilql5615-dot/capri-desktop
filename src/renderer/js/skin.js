// Her skins: her drawings with her pink in another AI's colour (assets/capri-<name>, made by
// tools/build-skin.py), worn while that AI is the one thinking: answering her chat ("Клод, …" or
// "Кодекс, …", or Claude Code picked as her AI), or at work in a session she watches through its hooks.
// So you see at a glance whether it's her, Claude or Codex. Everything else about her stays the same:
// only which drawings she's made of changes (her body, her faces in her panel, her cut-ins, her intro).

export const SKINS = {
  capri: '../../assets/capri/',
  claude: '../../assets/capri-claude/', // Claude's orange, #D97757
  codex: '../../assets/capri-codex/',   // Codex's violet, #684699
  agy: '../../assets/capri-agy/',       // Antigravity / Google 4-color (#EA4335, #FBBC05, #34A853, #4285F4)
};
// how her body's shader treats her pink (sprite.js grade()): the show's hot red, or the skin's colour as
// it is in the drawings, neither pulled further nor brightened (hue unwrapped past 1 around red; Codex's
// violet is outside what the shader counts as pink, so it's left as drawn anyway)
const GRADES = {
  capri: null,
  claude: { hue: 1.0411, sat: 0.6, lift: [1, 0] },
  codex: { hue: 0.7349, sat: 0.54, lift: [1, 0] },
  agy: { hue: 1.012, sat: 0.77, lift: [1, 0], rim: [0.259, 0.522, 0.957] },
};
const CHECK_MS = 500;

// One skin's drawings: her full body (the rig's texture), her cut-ins, her intro's close-up frames.
export async function loadSkin(dir, { cutins, frames, loadImage }) {
  const [full, intro, ...cuts] = await Promise.all([
    loadImage(`${dir}capri-full.png`),
    // decoded now, not the first time each one shows up (a hitch right on "hi", on the wave)
    Promise.all(frames.map((name) => loadImage(`${dir}intro-${name}.webp`).catch(() => null)))
      .then((cels) => Promise.all(cels.map((cel) => cel && createImageBitmap(cel))))
      .then((cels) => (cels[0] ? Object.fromEntries(frames.map((name, i) => [name, cels[i]])) : null)),
    ...cutins.map((name) => loadImage(`${dir}cutin-${name}.png`)),
  ]);
  return { dir, full, intro, cutins: Object.fromEntries(cutins.map((name, i) => [name, cuts[i]])) };
}

export class Skin {
  // who: () => 'claude', 'codex' or null, the one thinking now; sets: { capri } now, the others once
  // loaded (load())
  constructor({ capri, fx, panel, who, sets }) {
    this.capri = capri;
    this.fx = fx;
    this.panel = panel;
    this.who = who;
    this.sets = sets;
    this.name = 'capri';
    setInterval(() => this.check(), CHECK_MS);
  }

  // the other AIs' drawings, in the background after her start (she doesn't wait for them)
  async load(names) {
    await Promise.all(['claude', 'codex', 'agy'].map(async (name) => {
      this.sets[name] = await loadSkin(SKINS[name], names).catch((err) => {
        console.warn(`[capri] ${name} skin unavailable:`, err?.message || err);
        return null;
      });
    }));
    this.check();
  }

  check() {
    const who = this.who();
    const want = who && this.sets[who] ? who : 'capri';
    if (want !== this.name) this.wear(want);
  }

  wear(name) {
    const set = this.sets[name];
    if (!set) return;
    this.name = name;
    this.capri.sprite.setImage(set.full, GRADES[name] || undefined);
    this.fx.setDrawings({ cutins: set.cutins, intro: set.intro });
    this.panel.setFaceDir(set.dir);
    document.documentElement.dataset.skin = name;
  }
}
