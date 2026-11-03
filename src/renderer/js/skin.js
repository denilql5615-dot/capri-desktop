// Her Claude skin: her drawings with her pink in Claude's orange (assets/capri-claude, made by
// tools/build-claude-skin.py), worn while Claude is the one thinking: answering her chat ("Клод, …",
// or Claude Code picked as her AI), or at work in a Claude Code session she watches through its hooks.
// So you see at a glance whether it's her or Claude. Everything else about her stays the same: only
// which drawings she's made of changes (her body, her faces in her panel, her cut-ins, her intro).

export const SKINS = { capri: '../../assets/capri/', claude: '../../assets/capri-claude/' };
// how her body's shader treats her pink (sprite.js grade()): the show's hot red, or Claude's orange as it
// is in the drawings (#D97757: hue 15 degrees, unwrapped past 1), neither pulled further nor brightened
const GRADES = { capri: null, claude: { hue: 1.0411, sat: 0.6, lift: [1, 0] } };
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
  // on: () => true while Claude is the one thinking; sets: { capri } now, claude once loaded (load())
  constructor({ capri, fx, panel, on, sets }) {
    this.capri = capri;
    this.fx = fx;
    this.panel = panel;
    this.on = on;
    this.sets = sets;
    this.name = 'capri';
    setInterval(() => this.check(), CHECK_MS);
  }

  // her Claude drawings, in the background after her start (she doesn't wait for them)
  async load(names) {
    this.sets.claude = await loadSkin(SKINS.claude, names).catch((err) => {
      console.warn('[capri] Claude skin unavailable:', err?.message || err);
      return null;
    });
    this.check();
  }

  check() {
    const want = this.sets.claude && this.on() ? 'claude' : 'capri';
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
