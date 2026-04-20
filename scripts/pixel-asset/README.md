# Pixel Asset Workflow — nano banana → 游戏内像素贴图

这套脚本把 nano banana（或其他 AI 图像模型）生成的参考 JPEG 降采样成可直接放进 `public/assets/furniture/` 的像素贴图。**目标保真度对齐 To Pixelia 风格**：保留粗描边、内部色块清晰、轮廓单像素收边。

---

## 目录

```
scripts/pixel-asset/
├── README.md                       ← 本文档
├── process_template.py             ← 复制这个改参数
├── process_sofa.py                 ← 范例：中性灰背景 + 座面阴影带
├── process_water_cooler.py         ← 范例：棋盘格背景 + 12 色量化
├── input/                          ← 原始 nano banana JPEG（git-ignored）
└── preview/                        ← 16× 放大预览（git-ignored）
```

新 asset 的做法：

```bash
cp process_template.py process_<asset>.py
# 把 nano banana 图放到 input/<asset>.jpeg
# 改 SRC / OUT / TARGET_W / TARGET_H / 背景策略
python3 process_<asset>.py
open preview/<asset>_out_16x.png       # 眼睛校对
```

---

## 工作流

### 1. 用 nano banana 出图

Prompt 模板（中英都能用，nano banana 中英都吃）：

```
Isometric flat-lit pixel-art-style <家具名>, front view,
solid black 1px outline, 6-8 color palette,
neutral grey background (#c8c8c8), no shadow,
centered, no text, square composition
```

关键要点（不做就后面脚本难救）：

| 必须 | 原因 |
|---|---|
| **单体家具**，无其他物件 | 否则抠背景会把相邻物件一起当前景 |
| **固定朝向**（front / side / back 之一） | 每个 orientation 跑一次，最后放进对应 png |
| **粗黑描边 + 高饱和色块** | pass 2 dark-mask 需要明显的深色像素 |
| **纯色背景**（中性灰或棋盘格任选一种） | 背景抠不干净，前景会糊 |
| 不要透明、不要渐变、不要阴影 | 降采样会把这些变成脏像素 |

出来后存到 `scripts/pixel-asset/input/<asset>.jpeg`。

### 2. 降采样（4-pass 流水线）

`process_template.py` 的 pipeline，每一 pass 补前一 pass 漏的东西：

| Pass | 做什么 | 为什么不能省 |
|---|---|---|
| 0 | 背景像素 `alpha=0` | 不抠干净，pass 1 会把背景色当前景均值掺进来 |
| 1 | **Mode-filter 降采样**：每个目标像素 = 原图对应 block 里 4-bit 量化后最频繁颜色的平均 RGB | BOX / bilinear 会糊边；mode filter 保住色块 |
| 2 | **深色像素 mask 叠加**：block 里 ≥20% 深色 → 强制成 `OUTLINE_COLOR` | 1px 黑线在 pass 1 里会被大面积浅色冲掉 |
| 3 | **轮廓收边**：任何不透明像素只要邻居透明，就强制描边色 | 保证 silhouette 四周都是干净的 1px border |

可选 pass 4（`process_sofa.py` 里的 `CUSHION_SHADOW`）：扫奶油色长条的最底行，替换成深一度的阴影色，给座面一点 3D 感。

### 3. tile 尺寸参考

| 类型 | TARGET_W × H | 说明 |
|---|---|---|
| 小摆件（植物、杯子） | 16×16 | 单格 |
| 标准家具（椅子、灯、饮水机） | 16×20 或 16×32 | 比 tile 高 |
| 沙发侧视 | 16×32 | 单格深度，两格高 |
| 长桌 / 大型家具 | 按 footprint 算，如 64×32 | 多格宽 |

⚠ sprite 比 tile 矮时（例如 SOFA_FRONT 16px sprite 放进 32px tile），**不用在 png 里加 padding**。`layoutSerializer` 读到 `orientation==='front' && spriteH < TILE_SIZE` 会自动给 seat 塞 `renderYOffsetPx`，角色坐下时会对齐到沙发面。

### 4. 注册到 catalog

产出 png 后改 `src/office/furniture/manifest.ts`（或 rotation group 配置）：

```ts
{
  type: 'SOFA_SIDE',
  label: '沙发·侧',
  footprintW: 1,
  footprintH: 2,
  orientation: 'side',        // 'front' | 'back' | 'side' | 'left' | 'right'
  mirrorSide: true,           // side 变体自动生成镜像 left
  isDesk: false,
  canPlaceOnSurfaces: false,
}
```

### 5. 游戏内验收

```bash
npm run dev                          # Node ≥ 20.19
# 打开 http://localhost:1420/
# 右下 + 生成 spawn 一个 agent
# 点对应行为按钮（→ 休息区 / → 工位咖啡 …）触发坐/走/翻书
```

与 nano banana 参考图对比。不满意 → 回到 pass 1-3 的参数调（`DARK_THRESHOLD`、`OPAQUE_BLOCK_FRACTION`、`OUTLINE_COLOR`）。

---

## 两个背景策略

### A. 中性灰背景（`process_sofa.py`）

nano banana 默认出图常是 near-neutral 灰（r≈g≈b 且 >180）。一行 numpy 搞定：

```python
bg = (np.abs(r_-g_)<20) & (np.abs(g_-b_)<20) & (np.abs(r_-b_)<20) & (r_>180)
```

### B. 彩色棋盘格背景（`process_water_cooler.py`）

有的风格（Alpha transparency 示意、web assets）会用蒂芙尼青色棋盘格。用"dark ↔ light 端点之间的线性插值距离"做 mask：

```python
dark = np.array([130, 151, 154])
light = np.array([230, 240, 241])
# 任何离 dark-light 线段 <55 距离的像素都是背景
```

这种策略会顺带把"有点像棋盘色的前景像素"抠掉，所以不适用于冷色调家具。

---

## 常见问题

**Q: 图像边缘有断开的像素**
A: `OPAQUE_BLOCK_FRACTION` 太高（默认 0.45），降到 0.30–0.35 试试；或把 pass 3 的 4-邻域扩张改成 8-邻域。

**Q: 描边全没了**
A: `DARK_THRESHOLD` 太严，放宽到 `r<130, g<100, b<80`；或把 `DARK_BLOCK_FRACTION` 从 0.20 降到 0.12。

**Q: 目标色被量化洗成灰蒙蒙**
A: nano banana 出图本身饱和度不够。要么 prompt 加 "vibrant / high saturation / flat colours"，要么在 pass 1 后面加一层 HSV 饱和度增强。

**Q: side 沙发的上半格生成了"站在沙发上"的幽灵座**
A: 已在 `src/office/layout/layoutSerializer.ts` 修过：orientation 是 `side/left/right` 且 `footprintH>1` 时，只在最底格创建座位。新增多格高的 side 家具不用再操心。

---

## 历史沿革

- **2026-04-19** 首次沉淀成 scripts/pixel-asset/（沙发、饮水机两个范例）
