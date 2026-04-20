"""
Turn the nano-banana water cooler JPEG into a game-ready PNG.

Strategy:
1. Remove teal checker background via dark↔light line-distance mask.
2. Crop to sprite bbox.
3. Detect native pixel-art grid (source is already pixel art at some scale).
4. Use mode-filter downsample: each target pixel = dominant color in its block.
5. Quantize to ~12 colors for pixel-art crispness.
"""

from PIL import Image
import numpy as np
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SRC = HERE / "input" / "water.jpeg"
OUT = REPO / "public" / "assets" / "furniture" / "WATER_COOLER" / "WATER_COOLER.png"
PREVIEW = HERE / "preview" / "water_cooler_out_16x.png"
PREVIEW.parent.mkdir(parents=True, exist_ok=True)

img = Image.open(SRC).convert("RGBA")
arr = np.array(img)
H, W = arr.shape[:2]

# --- 1. Background mask ---
rgb = arr[:, :, :3].astype(int)
dark = np.array([130, 151, 154])
light = np.array([230, 240, 241])
rgb_flat = rgb.reshape(-1, 3)
ts = np.linspace(0, 1, 12)[:, None]
line = dark * (1 - ts) + light * ts
diffs = rgb_flat[:, None, :] - line[None, :, :]
min_d = np.sqrt((diffs ** 2).sum(axis=2)).min(axis=1)
checker_mask = (min_d.reshape(H, W) < 55)

alpha = arr[:, :, 3].copy()
alpha[checker_mask] = 0
arr[:, :, 3] = alpha

# --- 2. Crop to sprite bbox ---
clean = Image.fromarray(arr, "RGBA")
bbox = clean.getbbox()
print(f"Bbox: {bbox}")
cropped = clean.crop(bbox)
cw, ch = cropped.size
print(f"Cropped: {cw}x{ch}, aspect={cw/ch:.3f}")

# --- 3. Pick target dims close to source aspect ---
# Source is ~0.89 aspect. Target 16x20 (=0.80) keeps the cooler tall without padding
# too much whitespace. Cooler design will be slightly squished horizontally, which
# is fine at this tile size.
TARGET_W, TARGET_H = 16, 20

# Aspect-preserving pad so we don't stretch
target_aspect = TARGET_W / TARGET_H
src_aspect = cw / ch
if src_aspect < target_aspect:
    new_w = int(round(ch * target_aspect))
    pad = (new_w - cw) // 2
    padded = Image.new("RGBA", (new_w, ch), (0, 0, 0, 0))
    padded.paste(cropped, (pad, 0))
    cropped = padded
elif src_aspect > target_aspect:
    new_h = int(round(cw / target_aspect))
    pad = (new_h - ch) // 2
    padded = Image.new("RGBA", (cw, new_h), (0, 0, 0, 0))
    padded.paste(cropped, (0, pad))
    cropped = padded
pw, ph = cropped.size
print(f"Padded: {pw}x{ph}")

# --- 4. Mode-filter downsample ---
# For each target pixel, look at its source block and pick the most common
# non-transparent color. Preserves hard edges of pixel art much better than BOX.
src_arr = np.array(cropped)
block_w = pw / TARGET_W
block_h = ph / TARGET_H

out = np.zeros((TARGET_H, TARGET_W, 4), dtype=np.uint8)
for ty in range(TARGET_H):
    for tx in range(TARGET_W):
        x0 = int(round(tx * block_w))
        x1 = int(round((tx + 1) * block_w))
        y0 = int(round(ty * block_h))
        y1 = int(round((ty + 1) * block_h))
        block = src_arr[y0:y1, x0:x1]
        # flatten pixels; treat transparent as null
        pixels = block.reshape(-1, 4)
        opaque = pixels[pixels[:, 3] > 128]
        if len(opaque) == 0:
            out[ty, tx] = (0, 0, 0, 0)
            continue
        # quantize to 4-bit RGB buckets so small JPEG noise merges
        keys = [(r >> 4, g >> 4, b >> 4) for r, g, b, _ in opaque]
        most_common_key = Counter(keys).most_common(1)[0][0]
        # average color of all pixels matching that key
        matches = np.array([
            p[:3] for p, k in zip(opaque, keys) if k == most_common_key
        ])
        avg = matches.mean(axis=0).astype(np.uint8)
        # only include this pixel if opaque fraction is large enough
        opaque_frac = len(opaque) / len(pixels)
        if opaque_frac < 0.35:
            out[ty, tx] = (0, 0, 0, 0)
        else:
            out[ty, tx] = (*avg, 255)

# --- 5. Palette quantize for crispness ---
rgb_only = Image.fromarray(out[:, :, :3], "RGB")
alpha_chan = out[:, :, 3]
quantized = rgb_only.quantize(colors=12, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
quantized_rgb = np.array(quantized.convert("RGB"))
alpha_bin = np.where(alpha_chan >= 128, 255, 0).astype(np.uint8)
final = np.dstack([quantized_rgb, alpha_bin])

# Zero-out RGB where alpha is 0 (cleaner PNG)
final[alpha_bin == 0] = (0, 0, 0, 0)

Image.fromarray(final, "RGBA").save(OUT, "PNG")
print(f"Saved {OUT} ({TARGET_W}x{TARGET_H})")

preview = Image.fromarray(final, "RGBA").resize(
    (TARGET_W * 20, TARGET_H * 20), Image.Resampling.NEAREST
)
preview.save(PREVIEW, "PNG")
print(f"Preview {PREVIEW}")
