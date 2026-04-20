# CLAUDE.md — Pixel Agents 项目开发者须知

> 这份文档给 Claude Code（和未来的 AI agent）看。写人话，不要写机器说明。目标：下一位来改代码的 agent 5 分钟内读完就能干活。

---

## 这是什么

Tauri 2.x 桌面 app：把本机正在运行的 **CLI agent**（Claude Code、Codex、Trae…）可视化成**像素办公室**里一只只小人。坐在工位 = 正在工作，举手 + `!` = 在等你确认权限，去沙发 = 已经 stop & idle。**不展示数值**，全部用位置和动作传达状态。

视觉基准：To Pixelia 风格的 16×16 tile 像素图，角色 16×24，家具按 tile 拼。

---

## Stack

| 层 | 选型 | 所在目录 |
|---|---|---|
| 桌面壳 | Tauri 2.x（Rust host） | `src-tauri/` |
| 前端 | Vite + React 19 + TypeScript | `src/` |
| 渲染 | **Canvas 2D**（不是 Pixi.js，注意！） | `src/office/engine/renderer.ts` |
| 状态 | 自写单例 `OfficeState` + 少量 Zustand | `src/office/engine/officeState.ts` |
| IPC | Unix Domain Socket @ `~/.pixel-agents/bus.sock` | `src-tauri/src/ipc.rs` |
| Hook 桥 | Python shim 从 Claude hook stdin 转 UDS | `scripts/claude-hook-forward.py` |

**重要：渲染用原生 Canvas 2D，不是 Pixi。** 老的 plan 文档里写的是 Pixi，但实际落地改成了 Canvas 2D（更轻、关掉 `imageSmoothingEnabled` 即像素完美）。不要引入 Pixi。

**平台**：仅 macOS / Linux。`ipc.rs` 用 UDS，`reaper.rs` 用 `kill -0`，都是 unix-only；`lib.rs` 有 `#[cfg(not(unix))] compile_error!` 在编译时拦下 Windows。移植 Windows 需要改成 named pipes + `OpenProcess`，不是顺手能做的事。

Node 版本：Vite 7 要求 **Node ≥ 20.19**。`launchd` 子进程和默认 shell 可能还是 Node 18，要跑 `npm run dev` 之前确保：
```bash
export PATH=~/.nvm/versions/node/v22.22.0/bin:$PATH
```

---

## 代码地图

```
src/
├── App.tsx                      入口：造 OfficeState 单例，挂在 window.__PA_OFFICE_STATE__
├── main.tsx                     ReactDOM mount
├── runtime.ts                   vscode vs browser 运行环境检测
├── browserMock.ts               纯浏览器模式下派发假事件（开发调试用）
├── constants.ts                 全部可调参数（tile 尺寸、动画时序、颜色…）
├── notificationSound.ts         权限气泡弹出时的 beep
│
├── office/                      ★ 核心游戏引擎
│   ├── types.ts                 Character / Seat / FurnitureInstance / OfficeLayout…
│   ├── colorize.ts              sprite 染色（给角色换发色衣服色）
│   ├── floorTiles.ts            9 种地板贴图
│   ├── wallTiles.ts             墙顶贴图
│   ├── toolUtils.ts             工具分类（Edit/Write=打字，Read/Grep=翻书…）
│   │
│   ├── engine/
│   │   ├── officeState.ts       ★ 944 行，状态中枢。addAgent / sendToLounge
│   │   │                        / sendToLibrary / setAgentActive / setAgentTool /
│   │   │                        update(dt) / getCharacterAt(x,y)
│   │   ├── characters.ts        ★ 364 行，per-char FSM：TYPE / WALK / IDLE
│   │   │                        每帧跑 updateCharacter(ch, dt, ...)
│   │   ├── renderer.ts          ★ 856 行，renderScene(ctx, ...)
│   │   │                        z-sort 地板→家具→角色→矩阵特效→overlay
│   │   ├── gameLoop.ts          rAF 驱动 update + render 循环
│   │   ├── matrixEffect.ts      角色 spawn/despawn 的矩阵雨特效
│   │   ├── agentLabel.ts        头顶 name tag 的定位计算
│   │   └── index.ts             桶装文件
│   │
│   ├── layout/
│   │   ├── furnitureCatalog.ts  家具 catalog（footprint / sprite / orientation）
│   │   │                        含 rotation group（一个 side 自动生成 left 镜像）
│   │   ├── layoutSerializer.ts  OfficeLayout → seats + blockedTiles +
│   │   │                        walkableTiles + furnitureInstances
│   │   ├── tileMap.ts           A* findPath / isWalkable
│   │   └── index.ts
│   │
│   ├── sprites/
│   │   ├── spriteData.ts        角色四方向 walk/typing/reading 帧
│   │   ├── spriteCache.ts       染色后的 ImageBitmap 缓存
│   │   └── logo-claude.json     logo 像素数据
│   │
│   ├── components/
│   │   └── OfficeCanvas.tsx     Canvas DOM 挂载 + pointer 事件
│   │
│   └── editor/                  layout 编辑器（用户在 app 里改布局）
│       ├── editorState.ts       当前工具 / 选中对象 / 笔刷色
│       └── editorActions.ts
│
├── components/
│   ├── LangSwitch.tsx           中 / EN 切换
│   ├── Legend.tsx               底部图例面板
│   ├── MockEventPanel.tsx       右下 "+ 生成 / → 休息区" 手动触发面板
│   └── ui/types.ts              ColorValue 等共享 UI 类型
│
├── hooks/
│   ├── agentEventDispatch.ts    统一事件 → OfficeState 方法的分发器
│   ├── useExtensionMessages.ts  VSCode Extension postMessage 监听
│   └── useTauriAgentEvents.ts   Tauri event("agent-event") 监听
│
├── i18n/                        中英字典
└── __tests__/                   vitest 单测（agent 行为 / 工具集合）

src-tauri/src/
├── main.rs / lib.rs             Tauri app 启动；lib.rs 有 unix-only 编译护栏
├── ipc.rs                       UDS listener：accept → 逐行读 JSON → emit
│                                启动时先 connect 探测避免抢占已存在的实例
├── events.rs                    统一事件 schema（session_id, kind, tool, source…）
├── adapter/mod.rs               按 source 字段分发到三个 CLI 归一器
├── adapter/claude.rs            Claude Code hook JSON → 归一事件
├── adapter/codex.rs             Codex CLI hook（tool 名做 shell→Bash 等映射）
├── adapter/grok.rs              Grok CLI hook（PostToolUseFailure 等变体折叠）
├── installer.rs                 启动时改三个 CLI 的 settings（~/.claude、~/.codex、~/.grok），
│                                Codex 会额外检查 config.toml `[features] codex_hooks = true`
└── reaper.rs                    清理死掉的 session（kill -0 检测 PID）

scripts/
├── claude-hook-forward.py       Claude hook shim：stdin → UDS（加 source: "claude"）
├── codex-hook-forward.py        Codex hook shim
├── grok-hook-forward.py         Grok hook shim
├── claude-settings.sample.json  参考配置
└── pixel-asset/                 ★ nano banana → 像素贴图 workflow
    ├── README.md                ← 读这个
    ├── process_template.py      ← 新 asset 复制这个
    ├── process_sofa.py          范例：中性灰背景 + 座面阴影带
    └── process_water_cooler.py  范例：彩色棋盘格背景

public/assets/furniture/<TYPE>/<TYPE>_<ORIENT>.png    所有家具贴图

shared/assets/                   跨客户端共享（Tauri + 未来的 VSCode ext）
```

---

## 关键数据流

### 真实运行：Claude Code hook → 小人动作

```
Claude Code 执行工具
  │
  ├─ stdin JSON 发到 ~/.claude/settings.json 里配置的 hook command
  │
  ▼
scripts/claude-hook-forward.py       # Python shim
  │ 原样转发到 UDS ~/.pixel-agents/bus.sock
  ▼
src-tauri/src/ipc.rs                 # Rust listener
  │ 逐行读 JSON → adapter/claude.rs 归一化
  │ app.emit("agent-event", payload)
  ▼
src/hooks/useTauriAgentEvents.ts     # React hook
  │ listen("agent-event", …)
  ▼
src/hooks/agentEventDispatch.ts      # 分发
  │ SessionStart → officeState.addAgent
  │ PreToolUse(Edit/Write/Bash) → setAgentActive(true) + setAgentTool('Edit')
  │ PreToolUse(Read/Grep) → sendToLibrary
  │ Notification → showPermissionBubble
  │ Stop + idle > 60s → setAgentActive(false) + sendToLounge
  │ SessionEnd → removeAgent
  ▼
OfficeState 方法 mutate 状态
  │
  ▼
gameLoop 每帧 update(dt) → render(ctx)
```

### 纯浏览器调试模式

没装 Tauri / 跑 `npm run dev` 直接开浏览器时，`runtime.ts` 检测到 `browser`，App.tsx 自动 import `browserMock.ts` 派发假事件，这样不接 Claude 也能看到所有行为。

---

## 关键不变量（改代码前必读）

1. **OfficeState 是单例**，挂在 `window.__PA_OFFICE_STATE__`（dev 调试用）。**不要**用 React state 管 agent 列表，会每帧重渲染整个 canvas。
2. **游戏循环不碰 React**：`gameLoop.ts` 的 rAF 里只调 `officeState.update(dt)` 和 `renderer.renderScene(ctx, …)`，完全旁路 React。
3. **状态变更是命令式的**：`officeState.addAgent(id)` 直接 mutate，不走 setState。React 只在"layout 就绪"这种粗粒度事件重绘。
4. **坐标系**：tile coords `(col, row)` 是主坐标。像素坐标 `x, y` = tile 中心 ×16。renderer 之外尽量用 tile coords。
5. **Character.seatId vs tempSeatId**：`seatId` = 长期工位（持续到 removeAgent），`tempSeatId` = 临时座（沙发、图书角阅读桌）。去休息区 / 去图书角都走 tempSeatId。
6. **character 的 state 机**：
   - `TYPE` = 坐着打字/翻书（静态 + 2 帧抖动）
   - `WALK` = 移动中（沿 `path[]` 走，`moveProgress` 插值）
   - `IDLE` = 站着发呆（wander 之间的 pause）
   - 转换集中在 `characters.ts:updateCharacter`，**不要在 officeState 里直接写 ch.state**，出事就是状态机错乱。
7. **blockedTiles**：座位 tile 对其他人是 blocked，但**对自己不 blocked**（否则会站在座位外）。所有 `findPath` 调用前都要 `withOwnSeatUnblocked` 或手动 delete/add targetKey。
8. **多格家具的 seat 收缩**：orientation 是 `side/left/right` 的多格高家具，只有**最底格**生成 seat（`layoutSerializer.ts`）。否则会出"站在沙发上"的幽灵座。
9. **Front 短 sprite 的 Y 偏移**：`orientation==='front'` 且 `spriteH < TILE_SIZE` 时，seat 自动带 `renderYOffsetPx`，角色坐下时 renderer 会再下沉一段。改这段代码看 `SOFA_FRONT` 就明白为什么。
10. **Claude hook 自愈**：app 启动时 `installer.rs` 会把 `~/.claude/settings.json` 里的 hook 路径改成当前 app bundle 路径（dev vs release 不同），但只改带 `claude-hook-forward.py` 标记的那一行，不碰用户其他 hook。同样的策略也用在 Codex (`~/.codex/hooks.json`) 和 Grok (`~/.grok/user-settings.json`) 上。
11. **Single-instance IPC**：`ipc.rs:spawn_listener` 先 `UnixStream::connect` 探测，命中则直接 return 不抢 socket。两个 app 同时跑不会互相拉黑，但只有先起的那个能收事件。
12. **Agent identity**：`Character.folderName` = `basename(ev.cwd)`，`Character.sessionShortId` = UUID 的第 20–24 位 hex（跳过 UUIDv7 时间戳前缀）。`agentDisplayLabel(ch, roster)` 仅在 folder 撞车时才拼 `·<shortId>`。源头在 `officeState.setAgentIdentity`，被 `agentEventDispatch` 在 session_start + pre_tool_use 两处调用。
13. **角色间碰撞**：A* 只绕家具，不绕活人。`characters.ts:WALK` 每帧扫 `liveCharacters`：下一格被占住且 `moveProgress < 0.5` 时不推进、累加 `stallSec`；超过 `WALK_STALL_MAX_SEC`（1.5s）就清 `path` 让 FSM 重规划，打破头对头死锁。
14. **Codex feature flag**：Codex hook 要开 `[features] codex_hooks = true` 才会触发。`installer.rs:warn_if_codex_feature_missing` 只警告不自动改文件——不 own 用户配置。

---

## 常用调试套路

### 实时 inspect 一个 agent

```js
// devtools console
const s = window.__PA_OFFICE_STATE__;
[...s.characters.values()].map(c => ({id:c.id, state:c.state, pos:[c.tileCol,c.tileRow], active:c.isActive, seat:c.seatId, temp:c.tempSeatId}));
```

### 手动触发行为（不需要真 Claude hook）

```js
const s = window.__PA_OFFICE_STATE__;
s.addAgent(1);
s.setAgentActive(1, false);
s.setAgentTool(1, null);
s.sendToLounge(1);     // → 去沙发
s.sendToLibrary(1);    // → 去图书角
s.setAgentTool(1, 'Edit');  s.setAgentActive(1, true);  // → 回工位打字
```

### 用 agent-browser CLI 自动化（推荐）

```bash
agent-browser open http://localhost:1420/
agent-browser eval "(() => { const s = window.__PA_OFFICE_STATE__; s.addAgent(1); return 'ok'; })()"
agent-browser screenshot /tmp/verify.png
```

### 每帧追 path / state 变化

用 officeState.update 的 monkeypatch 例子：

```js
const s = window.__PA_OFFICE_STATE__;
const orig = s.update.bind(s);
s.update = (dt) => {
  orig(dt);
  const ch = s.characters.get(1);
  if (ch.state !== window._last) {
    console.log(ch.state, [ch.tileCol, ch.tileRow], ch.path.length);
    window._last = ch.state;
  }
};
```

---

## 新增家具资产

看 `scripts/pixel-asset/README.md`。要点：

1. nano banana 出图 → `scripts/pixel-asset/input/<name>.jpeg`
2. 复制 `process_template.py` → `process_<name>.py`，改 `SRC/OUT/TARGET_W/H`
3. `python3 scripts/pixel-asset/process_<name>.py`
4. 在 `src/office/layout/furnitureCatalog.ts` 加 entry
5. `npm run dev` → 手动放一个验收

---

## Build / Test

```bash
npm install
npm run dev                # 纯前端开发（Canvas mock）http://localhost:1420/
npm run tauri dev          # 完整桌面 app（含 Rust 后端 + hook IPC）
npm test                   # vitest 单测（不开窗口）
npm run build              # tsc + vite build（产 dist/）
```

`test-hook-sandbox/` 是一个隔离沙箱，跑 hook 端到端不影响主 ~/.claude/settings.json。

---

## 项目命题 + 设计哲学

- **"看一眼就知道这 agent 在干嘛"**：所有状态通过位置/动作传达，禁止文字数值条（name tag 只是 id，不是状态）。
- **不做任何预测性设计**：agent 真实的 stop idle 就让它去沙发；真的在跑 Edit 就让它打字。hook 说什么，画什么。
- **像素保真度是第一性的**：渲染可以掉帧，但不能有亚像素模糊。`imageSmoothingEnabled = false` 所有 canvas 路径必须保证。

---

## 历史 gotcha 存档

| 踩过的坑 | 位置 | 一句话 |
|---|---|---|
| SOFA_FRONT 角色飘在沙发上方 | `layoutSerializer.ts` | front 短 sprite 要给 seat 补 `renderYOffsetPx` |
| SOFA_SIDE 出现"站在沙发上" | `layoutSerializer.ts` | side 多格高只在最底格开 seat |
| SOFA_SIDE:left 没修到 | `layoutSerializer.ts` | rotation group 产的镜像 orientation='left' 不是 'side'，要 cover |
| "→ 休息区" 点了不去沙发 | `officeState.ts:sendToLounge` | 正则 `/^SOFA(_\|$\|:)/`，以前 `^SOFA` 把别的椅子也当沙发了 |
| 去了沙发马上站起来走掉 | `characters.ts` WALK→TYPE 分支 | 到达 tempSeat 时要设 `seatTimer`，否则 `-1` 哨兵立刻 IDLE |
| `npm run dev` 报 `crypto.hash is not a function` | — | Node < 20.19，切到 v22 |
| 角色坐到别人工位上 | — | blockedTiles 自己的座位要 `withOwnSeatUnblocked` |
| 两个 app 同时跑，第一个收不到事件 | `ipc.rs` | 后启动的 `remove_file + bind` 会把先前的 listener 架空。现已加 connect 探测 |
| 接了 Codex 但看不到事件 | `~/.codex/config.toml` | 要手动加 `[features]\ncodex_hooks = true`，installer 只警告不自动写 |
| 角色走到工位途中"假装在打字" | `officeState.ts:routeToSeat` | 无路径且未到座位时保持原状态，不要进 TYPE |
| 同 repo 两个 Claude 看不清哪个是哪个 | `agentLabel.ts:agentDisplayLabel` | folder 撞车时自动追加 `·<sessionShortId>` |
| Codex 思考窗口（UserPromptSubmit → PreToolUse 之间）显示"空闲" | `agentLabel.ts:verbKeyFor` | `isActive` 为真时兜底为 "working" |
| 两个角色走一起穿模 | `characters.ts:WALK` | 加 `stallSec` + next-tile 占用检查，1.5s 超时弃 path |
