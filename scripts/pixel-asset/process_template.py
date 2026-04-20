"""Template: downsample a nano-banana reference JPEG → pixel-art PNG.

Copy this file, rename it `process_<asset>.py`, then:
  1. set SRC / OUT / PREVIEW / TARGET_W / TARGET_H
  2. pick a background-removal strategy (section 1) — use the one that matches
     how the reference was generated (neutral grey vs teal checker vs …)
  3. tune OUTLINE_COLOR and the dark-mask threshold for the asset's palette
  4. run `python3 process_<asset>.py` and eyeball PREVIEW

The pipeline has four passes, each compensating for what the previous one
drops on the floor:

  Pass 0  background → alpha=0
  Pass 1  mode-filter downsample for body colors (kills JPEG noise,
          keeps big color regions)
  Pass 2  dark-mask overlay → force outline color on blocks that had enough
          dark pixels (mode-filter alone washes out 1px black lines)
  Pass 3  silhouette closure → any opaque pixel touching a transparent
          neighbour becomes outline color (clean 1px border everywhere)

Optional Pass 4 (cushion shadow) is demonstrated in process_sofa.py.
"""

from pathlib import Path
from PIL import Image
import numpy as np
from collections import Counter

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

# --- CONFIGURE ME ---
SRC = HERE / "input" / "TODO.jpeg"
OUT = REPO / "public" / "assets" / "furniture" / "TODO" / "TODO.png"
PREVIEW = HERE / "preview" / "todo_out_16x.png"
TARGET_W, TARGET_H = 16, 32
OUTLINE_COLOR = (58, 42, 30, 255)
DARK_THRESHOLD = dict(r=110, g=85, b=70)   # pixels below all three count as outline
DARK_BLOCK_FRACTION = 0.20                 # ≥20% dark in block → force outline
OPAQUE_BLOCK_FRACTION = 0.45               # <45% opaque → leave transparent

PREVIEW.parent.mkdir(parents=True, exist_ok=True)

img = Image.open(SRC).convert("RGBA")
arr = np.array(img)
H, W = arr.shape[:2]
r_ = arr[:, :, 0].astype(int)
g_ = arr[:, :, 1].astype(int)
b_ = arr[:, :, 2].astype(int)

# --- Pass 0: background mask ---
# Strategy A (neutral grey background, e.g. nano banana default):
bg = (
    (np.abs(r_ - g_) < 20)
    & (np.abs(g_ - b_) < 20)
    & (np.abs(r_ - b_) < 20)
    & (r_ > 180)
)
# Strategy B (teal/coloured checker): see process_water_cooler.py for a
# line-distance mask between (dark_bg, light_bg) endpoints.
arr[:, :, 3][bg] = 0

dark = (~bg) & (r_ < DARK_THRESHOLD["r"]) & (g_ < DARK_THRESHOLD["g"]) & (b_ < DARK_THRESHOLD["b"])

# Crop + pad to target aspect
cropped = Image.fromarray(arr, "RGBA")
bbox = cropped.getbbox()
cropped = cropped.crop(bbox)
dark_crop = dark[bbox[1]:bbox[3], bbox[0]:bbox[2]]
cw, ch = cropped.size

target_aspect = TARGET_W / TARGET_H
src_aspect = cw / ch
if src_aspect < target_aspect:
    new_w = int(round(ch * target_aspect))
    pad_x = (new_w - cw) // 2
    padded = Image.new("RGBA", (new_w, ch), (0, 0, 0, 0))
    padded.paste(cropped, (pad_x, 0))
    padded_dark = np.zeros((ch, new_w), dtype=bool)
    padded_dark[:, pad_x:pad_x + cw] = dark_crop
    cropped, dark_crop = padded, padded_dark
elif src_aspect > target_aspect:
    new_h = int(round(cw / target_aspect))
    pad_y = (new_h - ch) // 2
    padded = Image.new("RGBA", (cw, new_h), (0, 0, 0, 0))
    padded.paste(cropped, (0, pad_y))
    padded_dark = np.zeros((new_h, cw), dtype=bool)
    padded_dark[pad_y:pad_y + ch, :] = dark_crop
    cropped, dark_crop = padded, padded_dark

src_arr = np.array(cropped)
pw, ph = cropped.size
bw, bh = pw / TARGET_W, ph / TARGET_H
out = np.zeros((TARGET_H, TARGET_W, 4), dtype=np.uint8)

# --- Pass 1: mode-filter downsample ---
for ty in range(TARGET_H):
    for tx in range(TARGET_W):
        x0, x1 = int(round(tx * bw)), int(round((tx + 1) * bw))
        y0, y1 = int(round(ty * bh)), int(round((ty + 1) * bh))
        block = src_arr[y0:y1, x0:x1].reshape(-1, 4)
        opaque = block[block[:, 3] > 128]
        if len(opaque) == 0 or len(opaque) / max(len(block), 1) < OPAQUE_BLOCK_FRACTION:
            out[ty, tx] = (0, 0, 0, 0)
            continue
        keys = [(int(p[0]) >> 4, int(p[1]) >> 4, int(p[2]) >> 4) for p in opaque]
        top = Counter(keys).most_common(1)[0][0]
        members = np.array([p[:3] for p, k in zip(opaque, keys) if k == top])
        avg = members.mean(axis=0).astype(np.uint8)
        out[ty, tx] = (*avg, 255)

# --- Pass 2: dark-mask overlay ---
for ty in range(TARGET_H):
    for tx in range(TARGET_W):
        x0, x1 = int(round(tx * bw)), int(round((tx + 1) * bw))
        y0, y1 = int(round(ty * bh)), int(round((ty + 1) * bh))
        dblock = dark_crop[y0:y1, x0:x1]
        if dblock.size == 0:
            continue
        if dblock.mean() >= DARK_BLOCK_FRACTION and out[ty, tx, 3] > 0:
            out[ty, tx] = OUTLINE_COLOR

# --- Pass 3: silhouette closure ---
alpha = out[:, :, 3]
opaque_mask = alpha > 0
pad = np.pad(~opaque_mask, 1, mode='constant', constant_values=True)
neighbor_transp = pad[:-2, 1:-1] | pad[2:, 1:-1] | pad[1:-1, :-2] | pad[1:-1, 2:]
edge_mask = opaque_mask & neighbor_transp
for y, x in zip(*np.where(edge_mask)):
    out[y, x] = OUTLINE_COLOR

OUT.parent.mkdir(parents=True, exist_ok=True)
Image.fromarray(out, "RGBA").save(OUT)
Image.fromarray(out, "RGBA").resize(
    (TARGET_W * 16, TARGET_H * 16), Image.Resampling.NEAREST
).save(PREVIEW)
print(f"Saved {OUT}")
print(f"Preview {PREVIEW}")
