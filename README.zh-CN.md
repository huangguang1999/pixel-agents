<p align="center">
  <img src="docs/logo/logo-256.png" width="96" alt="Pixel Agents logo">
</p>

<h1 align="center">像素模型（Pixel Agents）</h1>

<p align="center">
  <strong>看一眼就知道你的 AI agent 在干嘛。</strong><br>
  <sub><a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a></sub>
</p>

<p align="center">
  <img src="docs/demo.gif" width="720" alt="Pixel Agents 演示">
</p>

把本机正在运行的 CLI agent（Claude Code、Codex CLI、Grok CLI，Trae 待加）可视化成一只只像素小人，住在一个桌面挂件的迷你办公室里。坐在工位 = 正在工作，去沙发 = 停下来休息，头顶气泡告诉你当前在干啥。

**平台**：仅支持 macOS / Linux。IPC 用 Unix Domain Socket、进程存活检测用 `kill -0`，Windows 需要移植到 named pipes + `OpenProcess` 才能跑。

---

## 这玩意解决什么问题

你同时开了 3 个 Claude Code 窗口跑 task，一个 Codex 跑 refactor，还有个 Trae 在另一个项目里。它们有的在等你按 y 确认权限，有的卡住 30 秒没动，有的刚 stop 了你不知道。传统的解法：开 3 个终端、一个 VSCode，眼睛飞快扫过去。

这个 app 把它们汇成**一屏**：每个 agent 一只像素小人，状态写在动作和位置里——**不需要看数字**，余光扫一眼就够了。

---

## 安装

直接去 [Releases](../../releases) 下对应平台的包：

| 平台    | 文件                 | 说明                                |
| ------- | -------------------- | ----------------------------------- |
| macOS   | `.dmg`               | 通用版——Apple Silicon + Intel 都能跑 |
| Linux   | `.AppImage` / `.deb` | x86_64                              |

> macOS 暂未做公证（notarize），首次打开 Gatekeeper 会拦——右键 → **打开** 绕过，或终端跑 `xattr -cr /Applications/pixel-agents.app`。

装完打开一次，之后任何 Claude / Codex / Grok 会话都会显示成像素小人。

---

## 怎么用

### Claude Code / Codex / Grok 接入

第一次启动 Tauri app，会向存在的 CLI 配置文件里自动写入 hook 入口：`~/.claude/settings.json` / `~/.codex/hooks.json` / `~/.grok/user-settings.json`。每条带 `*-hook-forward.py` marker，不会覆盖你的其他 hook。Codex 还会顺手在 `~/.codex/config.toml` 里启用 `[features] codex_hooks = true`（hook 触发的前置开关），缺什么补什么。装完之后每个 `claude` / `codex` / `grok` 会话都会显示成像素小人，不用任何手动配置。

### 同 repo 多会话的区分

dev 面板和头顶标签用 `basename(cwd)` 作为 agent 名字。两只 agent 同 folder（比如两个 Claude Code 都在 `pixel-agents` 跑）时，label 自动扩成 `pixel-agents·a7b3`——用 session UUID 第 20–24 位 hex（跳过 UUIDv7 毫秒时间戳前缀），同毫秒启动的也能分辨。

<p align="center">
  <img src="docs/screenshots/panel.png" width="680" alt="多 agent dev 面板的 folder 标签">
</p>

### 其他 agent（Trae / 自研 CLI）

参考 `src-tauri/src/adapter/` 写新 adapter：把对方的事件流（log tail、SDK emit、pty wrap 随你）归一成带 `source` 的 `{ session_id, kind, tool?, cwd? }` 投到 UDS `~/.pixel-agents/bus.sock` 即可。

### 行为语言速查

|   | 你看到的动作 | 含义 |
|---|---|---|
| <img src="docs/screenshots/behaviors/editing.png"    width="80" alt="编辑"> | 坐在工位打字 | 在跑 Edit / Write |
| <img src="docs/screenshots/behaviors/running.png"    width="80" alt="执行"> | 同样姿势，"执行" 气泡 | 在跑 Bash |
| <img src="docs/screenshots/behaviors/reading.png"    width="80" alt="阅读"> | 走到图书角翻书 | 在跑 Read / Grep / Glob / WebFetch |
| <img src="docs/screenshots/behaviors/permission.png" width="80" alt="求助"> | 气泡显示"求助" | 等你批权限（Notification 事件） |
| <img src="docs/screenshots/behaviors/working.png"    width="80" alt="工作"> | 气泡显示"工作" | 活跃但还没进具体工具（Codex 思考窗口） |
| <img src="docs/screenshots/behaviors/waiting.png"    width="80" alt="等待"> | 气泡显示"等待" | Stop 但还没闲置 60s |
| <img src="docs/screenshots/behaviors/lounge.png"     width="80" alt="休息"> | 坐到休息区沙发 | Stop + idle > 60s |
| — | 从门口淡入 / 淡出 | SessionStart / SessionEnd（矩阵雨特效） |
| — | 两个小人对峙后绕路 | 角色间碰撞触发 —— A\* 只绕家具，不绕活人 |

右上角图标栈：📖 展开行为图例，🎛 展开 dev / mock 事件面板。面板里能手动 fire 事件，不接真 CLI 也能玩。

---

## 架构概览

```
Claude / Codex / Grok hook (stdin JSON)
        ↓
  scripts/{claude,codex,grok}-hook-forward.py  # Python shim，打 source 戳
        ↓
  ~/.pixel-agents/bus.sock                     # Unix Domain Socket
        ↓
  Tauri Rust host (src-tauri/)
     adapter/mod.rs 按 source 分发 → adapter/{claude,codex,grok}.rs
        ↓   app.emit("agent-event")
  React webview (src/)
        ↓
  OfficeState 单例 (命令式 mutate)
        ↓
  Canvas 2D rAF 循环: update(dt) → render(ctx)
```

**技术栈**：Tauri 2.x + Vite + React 19 + TypeScript + Canvas 2D。**不用 Pixi.js。**

深入开发请读 [`CLAUDE.md`](./CLAUDE.md)（5 分钟版开发者须知）。

---

## 目录结构

```
src/                 React + TypeScript 前端
  office/            游戏核心（引擎 / layout / 精灵 / 编辑器）
    engine/          officeState / characters FSM / renderer / gameLoop
    layout/          furnitureCatalog / layoutSerializer / tileMap (A*)
    sprites/         角色精灵 + 染色缓存
  components/        UI overlay（LangSwitch / Legend / MockEventPanel）
  hooks/             事件桥（Tauri / VSCode ext / mock）
  i18n/              中英字典
  __tests__/         Vitest 单测

src-tauri/           Rust 桌面壳（仅 unix）
  src/ipc.rs         UDS 监听；single-instance 安全（connect 探测后 bind）
  src/adapter/       按 source 分发的 per-CLI hook 归一（claude / codex / grok）
  src/installer.rs   启动时自动写入每个 CLI 的 settings
  src/reaper.rs      CLI 异常退出时合成 session_end

public/assets/       像素贴图（家具 / 地板 / 墙）

scripts/
  pixel-asset/                  ★ nano banana → 像素贴图 workflow
                                （看 scripts/pixel-asset/README.md）
  {claude,codex,grok}-hook-forward.py   Python hook shims
```

---

## 新增家具资产

全流程见 [`scripts/pixel-asset/README.md`](./scripts/pixel-asset/README.md)。核心 3 步：

1. nano banana 生成参考图 → 存 `scripts/pixel-asset/input/<asset>.jpeg`
2. 复制 `process_template.py` → `process_<asset>.py` 改参数 → 跑
3. 在 `src/office/layout/furnitureCatalog.ts` 注册新 entry

脚本自动做 4-pass 降采样：抠背景 → mode-filter 主色 → 深色 mask 描边 → 轮廓收边。产出可直接放进 game。

---

## 开发

只有改代码才需要。普通用户直接去 [Releases](../../releases) 下包即可。

**前提**：Node ≥ 20.19（Vite 7 要求）+ 近期的 Rust toolchain。用 nvm：

```bash
nvm use 22
git clone <this-repo>
cd pixel-agents
npm install
```

```bash
# 方式 A：纯前端（浏览器 + mock 事件循环，不接真 CLI）
npm run dev              # 打开 http://localhost:1420/

# 方式 B：完整桌面 app（Tauri 窗口 + 真 hook IPC）
npm run tauri dev

# 单测
npm test                       # Vitest
(cd src-tauri && cargo test)   # Rust 测试

# 本地打包
npm run tauri build
# 产物 → src-tauri/target/release/bundle/
```

推个 tag（`git tag v0.2.0 && git push --tags`）触发 `.github/workflows/release.yml`，在 macOS / Windows / Linux 并行跑 `tauri build`，把产物挂到 GitHub Release——这就是用户下载的来源。

`test-hook-sandbox/` 是端到端 hook 沙箱，不污染主 `~/.claude/settings.json`。

---

## License & Contribution

本项目仍在 prototype 阶段，API / layout / 事件 schema 都可能变。如果你想加新 agent adapter 或新家具，欢迎 PR。

第三方资源声明见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。
