"""Her skins: copies of every drawing of hers (assets/capri) with her pink parts in another colour, into
assets/capri-<name>, same names. She wears one while that AI answers for her or works under her watch
(skin.js in the renderer): Claude's orange (#D97757), Codex's violet (#684699). The originals are only read.

Only her pinks and crimsons move (hue around 340 degrees, saturated enough): her green face, blue eyes,
purple shadows, black and white stay. The hue goes to Claude's; saturation and brightness are scaled so
her main pink lands right on the skin's colour and her shading stays as it was. A soft edge on the hue range, so a
pink fading into another colour doesn't leave a seam.

    py tools/build-skin.py            (all of them)
    py tools/build-skin.py codex      (one)
"""

import colorsys
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'assets' / 'capri'
SKINS = {
    'claude': (0xD9, 0x77, 0x57),
    'codex': (0x68, 0x46, 0x99),
}
PINK_HUE = 340.0  # her magenta-crimson
FULL = 50.0       # degrees each side moved all the way
SOFT = 15.0       # then fading out over this many


def hsv(rgb):
    """rgb: float array (..., 3) in 0..1 -> h in degrees, s, v."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    d = mx - mn
    safe = np.where(d == 0, 1, d)
    h = np.where(mx == r, ((g - b) / safe) % 6, np.where(mx == g, (b - r) / safe + 2, (r - g) / safe + 4)) * 60.0
    h = np.where(d == 0, 0, h)
    s = np.where(mx == 0, 0, d / np.where(mx == 0, 1, mx))
    return h, s, mx


def rgb_of(h, s, v):
    c = v * s
    x = c * (1 - np.abs((h / 60.0) % 2 - 1))
    m = v - c
    k = (h // 60).astype(int) % 6
    zero = np.zeros_like(h)
    r = np.choose(k, [c, x, zero, zero, x, c])
    g = np.choose(k, [x, c, c, x, zero, zero])
    b = np.choose(k, [zero, zero, x, c, c, x])
    return np.stack([r + m, g + m, b + m], -1)


def weight(h, s, v):
    """How pink each pixel is, 0..1."""
    dist = np.abs((h - PINK_HUE + 180) % 360 - 180)
    w_hue = np.clip((FULL + SOFT - dist) / SOFT, 0, 1)
    w_sat = np.clip((s - 0.12) / 0.13, 0, 1)
    w_val = np.clip((v - 0.08) / 0.07, 0, 1)
    return w_hue * w_sat * w_val


def load(path):
    img = Image.open(path)
    img.load()
    return img.convert('RGBA')


def reference():
    """Her main pink: the mean saturation and brightness of the pink in her full drawing."""
    a = np.asarray(load(SRC / 'capri-full.png')).astype(np.float64) / 255
    h, s, v = hsv(a[..., :3])
    w = weight(h, s, v) * (a[..., 3] > 0.5)
    return (s * w).sum() / w.sum(), (v * w).sum() / w.sum()


def recolor(img, s_ref, v_ref, colour):
    a = np.asarray(img).astype(np.float64) / 255
    rgb = a[..., :3]
    h, s, v = hsv(rgb)
    w = weight(h, s, v)[..., None]
    th, ts, tv = colorsys.rgb_to_hsv(*(c / 255 for c in colour))
    moved = rgb_of(np.full_like(h, th * 360), np.clip(s * ts / s_ref, 0, 1), np.clip(v * tv / v_ref, 0, 1))
    out = rgb * (1 - w) + moved * w
    return Image.fromarray(np.round(np.concatenate([out, a[..., 3:]], -1) * 255).astype(np.uint8), 'RGBA'), float(w.mean())


def build(name, colour, s_ref, v_ref):
    out = ROOT / 'assets' / f'capri-{name}'
    out.mkdir(exist_ok=True)
    print(f'{name}: her pink s={s_ref:.3f} v={v_ref:.3f} -> #{"".join(f"{c:02X}" for c in colour)}')
    for path in sorted(SRC.iterdir()):
        if path.suffix.lower() not in ('.png', '.webp'):
            continue
        src = Image.open(path)
        src.load()
        img, share = recolor(src.convert('RGBA'), s_ref, v_ref, colour)
        target = out / path.name
        if path.suffix.lower() == '.webp':
            img.save(target, 'WEBP', quality=92, method=6)
        else:
            if src.mode != 'RGBA':
                img = img.convert(src.mode if src.mode in ('RGB', 'L') else 'RGBA')
            img.save(target, 'PNG', optimize=True)
        print(f'  {path.name}: {share:.1%} moved')


def main():
    s_ref, v_ref = reference()
    for name in sys.argv[1:] or SKINS:
        build(name, SKINS[name], s_ref, v_ref)


if __name__ == '__main__':
    main()
