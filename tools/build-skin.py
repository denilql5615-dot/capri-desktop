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
GOOGLE_COLORS = {
    'red': (0xEA, 0x43, 0x35),     # #EA4335 — hair / mane
    'yellow': (0xFB, 0xBC, 0x05),  # #FBBC05 — torso & legs
    'green': (0x34, 0xA8, 0x53),   # #34A853 — green mask, shoulder & leg armor
    'blue': (0x42, 0x85, 0xF4),    # #4285F4 — violet silhouette shadows
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


def hue_weight(h, s, v, center, full, soft, s_min=0.15, v_min=0.06):
    dist = np.abs((h - center + 180) % 360 - 180)
    w_hue = np.clip((full + soft - dist) / soft, 0, 1)
    w_sat = np.clip((s - s_min) / 0.12, 0, 1)
    w_val = np.clip((v - v_min) / 0.06, 0, 1)
    return w_hue * w_sat * w_val


def torso_mask_for(name, pink_mask):
    """Separates torso/legs pink pixels from hair/mane pink pixels."""
    H, W = pink_mask.shape
    if name in ('capri-full.png', 'capri-cutout.png'):
        visited = np.zeros_like(pink_mask)
        mask = np.zeros_like(pink_mask, dtype=np.float64)
        for y in range(H):
            for x in range(W):
                if pink_mask[y, x] and not visited[y, x]:
                    q = [(y, x)]
                    visited[y, x] = True
                    pts = []
                    min_y = y
                    while q:
                        cy, cx = q.pop()
                        pts.append((cy, cx))
                        if cy < min_y:
                            min_y = cy
                        for dy in (-1, 0, 1):
                            for dx in (-1, 0, 1):
                                ny, nx = cy + dy, cx + dx
                                if 0 <= ny < H and 0 <= nx < W and pink_mask[ny, nx] and not visited[ny, nx]:
                                    visited[ny, nx] = True
                                    q.append((ny, nx))
                    # Hair component starts at top (min_y = 1); torso & leg components all start at y >= 145
                    if min_y >= 145:
                        for py, px in pts:
                            mask[py, px] = 1.0
        # Dilate by 2px so anti-aliased edges of torso/legs also turn Google Yellow
        dilated = mask.copy()
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                if dy == 0 and dx == 0:
                    continue
                sy = slice(max(0, dy), H + min(0, dy))
                ty = slice(max(0, -dy), H - max(0, dy))
                sx = slice(max(0, dx), W + min(0, dx))
                tx = slice(max(0, -dx), W - max(0, dx))
                dilated[ty, tx] = np.maximum(dilated[ty, tx], mask[sy, sx])
        return dilated
    if name.startswith('intro-'):
        yy, xx = np.meshgrid(np.arange(H), np.arange(W), indexing='ij')
        return ((yy > int(H * 0.52)) & (xx > int(W * 0.46))).astype(np.float64)
    return np.zeros((H, W), dtype=np.float64)


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


def shift_color(h, s, v, s_ref, v_ref, colour, v_floor=0.0):
    th, ts, tv = colorsys.rgb_to_hsv(*(c / 255 for c in colour))
    new_s = np.clip(s * ts / max(s_ref, 1e-4), 0, 1)
    new_v = np.clip(np.maximum(v, v_floor) * tv / max(v_ref, 1e-4), 0, 1)
    return rgb_of(np.full_like(h, th * 360), new_s, new_v)


def recolor_agy(img, name, refs):
    a = np.asarray(img).astype(np.float64) / 255
    rgb = a[..., :3]
    h, s, v = hsv(rgb)

    w_pink = weight(h, s, v)
    pink_core = (a[..., 3] > 0.2) & (w_pink > 0.25)
    t_mask = torso_mask_for(name, pink_core)
    w_torso = (w_pink * t_mask)[..., None]
    w_hair = (w_pink * (1.0 - t_mask))[..., None]
    w_green = hue_weight(h, s, v, center=140.0, full=35.0, soft=14.0, s_min=0.20, v_min=0.12)[..., None]
    w_violet = hue_weight(h, s, v, center=272.0, full=20.0, soft=10.0, s_min=0.35, v_min=0.17)[..., None]

    g_mask = (a[..., 3] > 0.3) & (w_green[..., 0] > 0.3)
    g_v_ref = float(np.median(v[g_mask])) if g_mask.any() else refs['green_v']
    g_s_ref = float(np.median(s[g_mask])) if g_mask.any() else refs['green_s']

    hair_rgb = shift_color(h, s, v, refs['pink_s'], refs['pink_v'], GOOGLE_COLORS['red'])
    torso_rgb = shift_color(h, s, v, refs['pink_s'], refs['pink_v'], GOOGLE_COLORS['yellow'])
    green_rgb = shift_color(h, s, v, g_s_ref, g_v_ref, GOOGLE_COLORS['green'])
    blue_rgb = shift_color(h, s, v, refs['violet_s'], 0.36, GOOGLE_COLORS['blue'])

    out = rgb
    out = out * (1 - w_hair) + hair_rgb * w_hair
    out = out * (1 - w_torso) + torso_rgb * w_torso
    out = out * (1 - w_green) + green_rgb * w_green
    out = out * (1 - w_violet) + blue_rgb * w_violet
    changed = float((w_hair + w_torso + w_green + w_violet).mean())
    return Image.fromarray(np.round(np.concatenate([np.clip(out, 0, 1), a[..., 3:]], -1) * 255).astype(np.uint8), 'RGBA'), changed


def agy_references():
    a = np.asarray(load(SRC / 'capri-full.png')).astype(np.float64) / 255
    h, s, v = hsv(a[..., :3])
    alpha = a[..., 3] > 0.5
    wp = weight(h, s, v) * alpha
    wg = hue_weight(h, s, v, center=140.0, full=35.0, soft=14.0) * alpha
    wv = hue_weight(h, s, v, center=272.0, full=20.0, soft=10.0) * alpha
    return {
        'pink_s': (s * wp).sum() / wp.sum(),
        'pink_v': (v * wp).sum() / wp.sum(),
        'green_s': (s * wg).sum() / wg.sum(),
        'green_v': (v * wg).sum() / wg.sum(),
        'violet_s': (s * wv).sum() / wv.sum(),
        'violet_v': max(0.32, (v * wv).sum() / wv.sum()),
    }


def build_agy():
    out = ROOT / 'assets' / 'capri-agy'
    out.mkdir(exist_ok=True)
    refs = agy_references()
    print('agy: Google 4-color pack (#EA4335 hair, #FBBC05 torso/legs, #34A853 green, #4285F4 blue shadows)')
    for path in sorted(SRC.iterdir()):
        if path.suffix.lower() not in ('.png', '.webp'):
            continue
        src = Image.open(path)
        src.load()
        img, share = recolor_agy(src.convert('RGBA'), path.name, refs)
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
    targets = sys.argv[1:] or [*SKINS.keys(), 'agy']
    for name in targets:
        if name == 'agy':
            build_agy()
        else:
            build(name, SKINS[name], s_ref, v_ref)


if __name__ == '__main__':
    main()
