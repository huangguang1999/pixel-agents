"""Downsample sofa.jpeg → 16x32 SOFA_SIDE.png with preserved outlines.

Two-pass approach:
  1. Mode-filter downsample to get interior colors (cream, red, shadow).
  2. Separately downsample a DARK-OUTLINE mask and OVERLAY it — this keeps
     the silhouette edge and internal cushion seams sharp instead of letting
     mode-filter wash them out."""

from pathlib import Path
from PIL import Image
import numpy as np
from collections import Counter

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SRC = HERE / "input" / "sofa.jpeg"
OUT = REPO / "public" / "assets" / "furniture" / "SOFA" / "SOFA_SIDE.png"
PREVIEW = HERE / "preview" / "sofa_out_16x.png"
PREVIEW.parent.mkdir(parents=True, exist_ok=True)
TARGET_W, TARGET_H = 16, 32
OUTLINE_COLOR = (58, 42, 30, 255)  # warm dark brown
CUSHION_SHADOW = (208, 186, 140, 255)  # darker cream for seat shadow band

img = Image.open(SRC).convert("RGBA")
arr = np.array(img)
H, W = arr.shape[:2]

r_, g_, b_ = arr[:, :, 0].astype(int), arr[:, :, 1].astype(int), arr[:, :, 2].astype(int)

# Background: any near-neutral gray brighter than 180
bg = (np.abs(r_ - g_) < 20) & (np.abs(g_ - b_) < 20) & (np.abs(r_ - b_) < 20) & (r_ > 180)
arr[:, :, 3][bg] = 0

# Dark outline mask: very dark pixels (the nano banana outlines are near-black brown)
dark = (~bg) & (r_ < 110) & (g_ < 85) & (b_ < 70)
print(f"dark pixels: {dark.sum()}")

cropped_img = Image.fromarray(arr, "RGBA")
bbox = cropped_img.getbbox()
print(f"Bbox: {bbox}")
cropped_img = cropped_img.crop(bbox)
dark_crop = dark[bbox[1]:bbox[3], bbox[0]:bbox[2]]
cw, ch = cropped_img.size

# Pad to target aspect 1:2
target_aspect = TARGET_W / TARGET_H
src_aspect = cw / ch
pad_x = pad_y = 0
if src_aspect < target_aspect:
    new_w = int(round(ch * target_aspect))
    pad_x = (new_w - cw) // 2
    padded_rgba = Image.new("RGBA", (new_w, ch), (0, 0, 0, 0))
    padded_rgba.paste(cropped_img, (pad_x, 0))
    padded_dark = np.zeros((ch, new_w), dtype=bool)
    padded_dark[:, pad_x:pad_x + cw] = dark_crop
    cropped_img = padded_rgba
    dark_crop = padded_dark
elif src_aspect > target_aspect:
    new_h = int(round(cw / target_aspect))
    pad_y = (new_h - ch) // 2
    padded_rgba = Image.new("RGBA", (cw, new_h), (0, 0, 0, 0))
    padded_rgba.paste(cropped_img, (0, pad_y))
    padded_dark = np.zeros((new_h, cw), dtype=bool)
    padded_dark[pad_y:pad_y + ch, :] = dark_crop
    cropped_img = padded_rgba
    dark_crop = padded_dark
pw, ph = cropped_img.size
print(f"Padded: {pw}x{ph}")

src_arr = np.array(cropped_img)
bw, bh = pw / TARGET_W, ph / TARGET_H
out = np.zeros((TARGET_H, TARGET_W, 4), dtype=np.uint8)

# Pass 1: mode-filter downsample for body colors.
for ty in range(TARGET_H):
    for tx in range(TARGET_W):
        x0, x1 = int(round(tx * bw)), int(round((tx + 1) * bw))
        y0, y1 = int(round(ty * bh)), int(round((ty + 1) * bh))
        block = src_arr[y0:y1, x0:x1].reshape(-1, 4)
        opaque = block[block[:, 3] > 128]
        if len(opaque) == 0 or len(opaque) / max(len(block), 1) < 0.45:
            out[ty, tx] = (0, 0, 0, 0)
            continue
        keys = [(int(p[0]) >> 4, int(p[1]) >> 4, int(p[2]) >> 4) for p in opaque]
        top = Counter(keys).most_common(1)[0][0]
        members = np.array([p[:3] for p, k in zip(opaque, keys) if k == top])
        avg = members.mean(axis=0).astype(np.uint8)
        out[ty, tx] = (*avg, 255)

# Pass 2: force outline — any target pixel whose block has ≥20% dark pixels
# becomes outline color. Lower threshold than body so thin 1-px lines survive.
for ty in range(TARGET_H):
    for tx in range(TARGET_W):
        x0, x1 = int(round(tx * bw)), int(round((tx + 1) * bw))
        y0, y1 = int(round(ty * bh)), int(round((ty + 1) * bh))
        dblock = dark_crop[y0:y1, x0:x1]
        if dblock.size == 0:
            continue
        if dblock.mean() >= 0.20 and out[ty, tx, 3] > 0:
            out[ty, tx] = OUTLINE_COLOR

# Pass 3: seat cushion shadow band — give the seat area a 3D feel by darkening
# the bottom 1-2 rows of cream pixels just above the base outline.
# Scan each seat column; find where it has a long vertical run of cream, then
# darken the bottom row of that run.
CREAM_HI = (230, 205, 160)  # threshold — anything at or above this is "cream"
for tx in range(6, TARGET_W - 1):
    # Find max-y cream pixel before hitting the base outline
    cream_ys = []
    for ty in range(TARGET_H):
        p = out[ty, tx]
        if p[3] == 0:
            continue
        if (p[0] >= CREAM_HI[0] and p[1] >= CREAM_HI[1] and p[2] >= CREAM_HI[2]):
            cream_ys.append(ty)
    if len(cream_ys) < 4:
        continue
    # darken the bottom-most cream pixel in this column
    bottom_y = cream_ys[-1]
    out[bottom_y, tx] = CUSHION_SHADOW

# Pass 4: silhouette edge enforcement — any opaque target pixel adjacent (4-way)
# to a transparent neighbor becomes outline color. Gives a clean single-pixel
# border all the way around even where pass 2 missed.
alpha = out[:, :, 3]
opaque_mask = alpha > 0
# Neighbor transparency: pad + shift
pad = np.pad(~opaque_mask, 1, mode='constant', constant_values=True)
neighbor_transp = (
    pad[:-2, 1:-1] | pad[2:, 1:-1] | pad[1:-1, :-2] | pad[1:-1, 2:]
)
edge_mask = opaque_mask & neighbor_transp
for y, x in zip(*np.where(edge_mask)):
    out[y, x] = OUTLINE_COLOR

Image.fromarray(out, "RGBA").save(OUT)
Image.fromarray(out, "RGBA").resize(
    (TARGET_W * 16, TARGET_H * 16), Image.Resampling.NEAREST
).save(PREVIEW)
print(f"Saved {OUT}")
print(f"Preview {PREVIEW}")
