<div align="center">

# Synapse

## 🎉 1.0 正式发布！

已安装？运行 `synapse upgrade` 即可原地更新。

在 X 上关注 [@getsynapse](https://x.com/getsynapse) 获取最新动态。

### 为 Claude Code、Cursor、Codex、OpenCode、Hermes Agent、Gemini、Antigravity 和 Kiro 注入语义代码智能

**约节省 16% 费用 · 约减少 58% 工具调用 · 100% 本地运行**

### [文档与官网 →](https://colbymchenry.github.io/synapse/)

[![npm version](https://img.shields.io/npm/v/@colbymchenry/synapse.svg)](https://www.npmjs.com/package/@colbymchenry/synapse)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Self-contained](https://img.shields.io/badge/Node.js-bundled%20%C2%B7%20none%20required-brightgreen.svg)](https://nodejs.org/)

[![Windows](https://img.shields.io/badge/Windows-supported-blue.svg)](#supported-platforms)
[![macOS](https://img.shields.io/badge/macOS-supported-blue.svg)](#supported-platforms)
[![Linux](https://img.shields.io/badge/Linux-supported-blue.svg)](#supported-platforms)

[![Claude Code](https://img.shields.io/badge/Claude_Code-supported-blueviolet.svg)](#supported-agents)
[![Cursor](https://img.shields.io/badge/Cursor-supported-blueviolet.svg)](#supported-agents)
[![Codex](https://img.shields.io/badge/Codex-supported-blueviolet.svg)](#supported-agents)
[![opencode](https://img.shields.io/badge/opencode-supported-blueviolet.svg)](#supported-agents)
[![Hermes Agent](https://img.shields.io/badge/Hermes_Agent-supported-blueviolet.svg)](#supported-agents)
[![Gemini](https://img.shields.io/badge/Gemini-supported-blueviolet.svg)](#supported-agents)
[![Antigravity](https://img.shields.io/badge/Antigravity-supported-blueviolet.svg)](#supported-agents)
[![Kiro](https://img.shields.io/badge/Kiro-supported-blueviolet.svg)](#supported-agents)

<br>

**Synapse 平台即将上线** — 针对每个 PR，精确了解需要测试什么、可能影响哪些地方、哪些调用链受影响，以及业务逻辑是否受到影响。

<a href="https://getsynapse.com"><img alt="加入候补名单，提前获取内测资格" src="https://raw.githubusercontent.com/colbymchenry/synapse/main/assets/waitlist.svg?v=2" height="52"></a>

<sub>获取托管产品的<b>早期内测资格</b> · <a href="https://getsynapse.com">getsynapse.com</a></sub>

</div>

## 快速开始

### 1. 安装 CLI

**无需 Node.js** — 一条命令即可获取适合你操作系统的版本：

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/synapse/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/colbymchenry/synapse/main/install.ps1 | iex
```

<details>
<summary><b>已有 Node？改用 npm（支持任何版本）</b></summary>

```bash
npm i -g @colbymchenry/synapse
```

<sub>Synapse 内置自己的运行时——无需编译，无需原生构建，在任何地方运行效果一致。安装器会将 `synapse` 添加到 PATH，但**不会更改当前 shell**——请打开新终端后再执行下一步，以确保命令能被识别。</sub>

<sub>**随时升级**，使用 `synapse upgrade` — 它会检测你的安装方式（bundle、npm 或 npx）并原地更新。加 `--check` 查看是否有可用更新，或用 `synapse upgrade <version>` 固定到指定版本。</sub>

</details>

### 2. 接入你的 agent

在**新终端**中运行安装器，将 Synapse 连接到你使用的 agent：

```bash
synapse install
```

<sub>自动检测并配置 Claude Code、Cursor、Codex CLI、opencode、Hermes Agent、Gemini CLI、Antigravity IDE 和 Kiro——将 Synapse MCP 服务器接入每个 agent。**这一步才是真正将 Synapse 与你的 agent 连接起来；** 第 1 步只是安装 CLI 本身。（快捷方式：`npx @colbymchenry/synapse` 可一步完成下载和运行。）</sub>

### 3. 初始化每个项目

```bash
cd your-project
synapse init
```

<sub>`synapse init` 会在同一步骤中创建本地 `.synapse/` 目录并构建完整图谱——一条命令，搞定。</sub>

<div align="center">

![1_C_VYnhpys0UHrOuOgpgoyw](https://github.com/user-attachments/assets/f168182f-4d9a-44e0-94d7-08d018cc8a3a)

</div>

### 4. 无需手动同步！

自动同步默认启用。Synapse 监听项目并在每次文件变更时更新图谱——无论是 agent 编辑代码，还是你新增、修改或删除文件。**索引永远不会过期，也不需要重新运行任何命令。**

### 卸载

改变主意了？一条命令即可从所有已配置的 agent 中移除 Synapse：

```bash
synapse uninstall
```

<sub>逆向安装过程——从每个已配置的 agent 中移除 Synapse 的 MCP 服务器配置、说明文件和权限设置。项目索引（`.synapse/`）不受影响；如需移除，请在各项目中执行 `synapse uninit`。使用 `--target` 可指定从特定 agent 移除，`--yes` 可非交互方式运行。</sub>

---

## 为什么选择 Synapse？

Claude Code 在探索代码库时会派生 **Explore agent**，通过 grep、glob 和 Read 扫描文件——每次工具调用都在消耗 token。

**Synapse 为这些 agent 提供一个预构建的知识图谱**——符号关系、调用图和代码结构。agent 直接查询图谱，而不是扫描文件。

### 基准测试结果

在涵盖 7 种语言的 **7 个真实开源代码库**上进行测试，对比 agent（Claude Code，无界面模式）在**有 Synapse** 和**无 Synapse** 两种条件下回答一个架构问题的表现。每个格子的数据为**每组 4 次运行取中位数**的节省量。_在当前构建版本（`synapse_explore` 作为主要工具）上使用 Opus 4.8（2026-06-02）重新验证。_

> **平均：节省 16% 费用 · 减少 47% token · 提速 22% · 减少 58% 工具调用**

| 代码库 | 语言 | 费用 | Token | 耗时 | 工具调用 |
|----------|----------|------|--------|------|------------|
| **VS Code** | TypeScript · 约 1 万个文件 | 便宜 18% | 减少 64% | 快 11% | 减少 81% |
| **Excalidraw** | TypeScript · 约 640 个 | 持平 | 减少 25% | 快 27% | 减少 40% |
| **Django** | Python · 约 3 千个 | 便宜 8% | 减少 60% | 快 13% | 减少 77% |
| **Tokio** | Rust · 约 790 个 | 持平 | 减少 38% | 快 18% | 减少 57% |
| **OkHttp** | Java · 约 645 个 | 便宜 25% | 减少 54% | 快 31% | 减少 50% |
| **Gin** | Go · 约 110 个 | 便宜 19% | 减少 23% | 快 24% | 减少 44% |
| **Alamofire** | Swift · 约 110 个 | 便宜 40% | 减少 64% | 快 33% | 减少 58% |

Synapse 在所有代码库上都能减少 **token、工具调用和实际耗时**——无论大中小型代码库——并以**近乎零次文件读取**给出答案，而未使用 Synapse 的 agent 则将预算耗费在 grep/find/Read 发现阶段。`synapse_explore` 完整展示答案——包括机制和你询问的确切方法，即便它们藏在几千行的文件中——同时将可互换的冗余实现折叠为签名，让响应大小匹配*答案*而非文件数量。**费用在各处保持持平至更低**——在小型代码库（Alamofire、OkHttp）上节省最多，在响应最重的代码库（Excalidraw、Tokio）上基本持平，因为 Synapse 将无 Synapse arm 的大量小 grep/read 往返替换为少数几次大型、缓存友好的工具响应。

<details>
<summary><strong>各代码库详细数据 — 有 Synapse vs 无 Synapse（中位数，每组 4 次）</strong></summary>

**VS Code** · 约 1 万个文件
| 指标 | 有 Synapse | 无 Synapse | Δ |
|---|---|---|---|
| 耗时 | 1m 59s | 2m 13s | 快 11% |
| 文件读取 | 0 | 9 | −9 |
| Grep/Bash | 0 | 11 | −11 |
| 工具调用 | 4 | 21 | 减少 81% |
| 总 token | 640k | 1.79M | 减少 64% |
| 费用 | $0.68 | $0.83 | 便宜 18% |

**Excalidraw** · 约 640 个文件
| 指标 | 有 Synapse | 无 Synapse | Δ |
|---|---|---|---|
| 耗时 | 1m 32s | 2m 6s | 快 27% |
| 文件读取 | 0 | 7 | −7 |
| Grep/Bash | 1 | 8 | −7 |
| 工具调用 | 9 | 15 | 减少 40% |
| 总 token | 1.27M | 1.69M | 减少 25% |
| 费用 | $0.78 | $0.78 | 持平 |

**Django** · 约 3 千个文件
| 指标 | 有 Synapse | 无 Synapse | Δ |
|---|---|---|---|
| 耗时 | 1m 43s | 1m 58s | 快 13% |
| 文件读取 | 0 | 9 | −9 |
| Grep/Bash | 0 | 5 | −5 |
| 工具调用 | 3 | 13 | 减少 77% |
| 总 token | 559k | 1.41M | 减少 60% |
| 费用 | $0.57 | $0.62 | 便宜 8% |

**Tokio** · 约 790 个文件
| 指标 | 有 Synapse | 无 Synapse | Δ |
|---|---|---|---|
| 耗时 | 1m 55s | 2m 20s | 快 18% |
| 文件读取 | 0 | 8 | −8 |
| Grep/Bash | 0 | 6 | −6 |
| 工具调用 | 6 | 14 | 减少 57% |
| 总 token | 1.08M | 1.73M | 减少 38% |
| 费用 | $0.82 | $0.82 | 持平 |

**OkHttp** · 约 645 个文件
| 指标 | 有 Synapse | 无 Synapse | Δ |
|---|---|---|---|
| 耗时 | 1m 1s | 1m 29s | 快 31% |
| 文件读取 | 0 | 4 | −4 |
| Grep/Bash | 2 | 6 | −4 |
| 工具调用 | 5 | 10 | 减少 50% |
| 总 token | 502k | 1.10M | 减少 54% |
| 费用 | $0.41 | $0.55 | 便宜 25% |

**Gin** · 约 110 个文件
| 指标 | 有 Synapse | 无 Synapse | Δ |
|---|---|---|---|
| 耗时 | 1m 14s | 1m 37s | 快 24% |
| 文件读取 | 1 | 6 | −5 |
| Grep/Bash | 1 | 2 | −1 |
| 工具调用 | 5 | 9 | 减少 44% |
| 总 token | 651k | 847k | 减少 23% |
| 费用 | $0.46 | $0.57 | 便宜 19% |

**Alamofire** · 约 110 个文件
| 指标 | 有 Synapse | 无 Synapse | Δ |
|---|---|---|---|
| 耗时 | 1m 35s | 2m 21s | 快 33% |
| 文件读取 | 0 | 9 | −9 |
| Grep/Bash | 0 | 4 | −4 |
| 工具调用 | 5 | 12 | 减少 58% |
| 总 token | 766k | 2.10M | 减少 64% |
| 费用 | $0.57 | $0.95 | 便宜 40% |

</details>

<details>
<summary><strong>完整基准测试说明</strong></summary>

**方法论。** 每个 arm 均以 `claude -p`（Claude Opus 4.8）无界面模式运行，并加上 `--strict-mcp-config`：**有 Synapse** = 启用 Synapse MCP 服务器，**无 Synapse** = 空 MCP 配置。两个 arm 均可使用内置的 Read/Grep/Bash。每个代码库使用相同问题，**每组 4 次运行，取中位数**。费用 = 运行的 `total_cost_usd`；Token = 处理的总 token 数（含缓存输入 + 输出）；耗时 = 实际时间；工具调用 = 所有工具调用次数，包括模型派生的子 agent 内部的调用。代码库以 `--depth 1` 克隆，并由提供服务的同一 Synapse 构建进行索引。在当前构建版本上于 2026-06-02 重新验证。这些数字低于之前 Opus 4.7 验证的结果——这不是 Synapse 的退步，而是更强的原生基线：Opus 4.8 在主线程上高效使用 grep/read，而非扇出到大型 Explore 子 agent，所以无 Synapse arm 比以前更精简。各代码库数字会随无 Synapse arm 的抖动程度而变化（中位数-4 已平滑，但尾部依然存在——例如 Django 的 without-arm 有一次运行达到 $2.71/14 分钟）。

**查询内容：**
| 代码库 | 查询 |
|----------|-------|
| VS Code | "扩展宿主如何与主进程通信？" |
| Excalidraw | "Excalidraw 如何渲染和更新画布元素？" |
| Django | "Django ORM 如何从 QuerySet 构建并执行查询？" |
| Tokio | "Tokio 如何在运行时调度和执行异步任务？" |
| OkHttp | "OkHttp 如何通过拦截器链处理请求？" |
| Gin | "gin 如何通过中间件链路由请求？" |
| Alamofire | "Alamofire 如何构建、发送和验证请求？" |

**Synapse 为何更优：** 有索引时，agent 直接给出答案——通常一次 `synapse_explore` 就能返回相关源码——然后停止，通常零次文件读取。没有索引时，agent 在读到正确代码之前会将大部分预算花在发现阶段（find/ls/grep）。Synapse 只在被*直接*查询时才有帮助，因此其说明引导 agent 直接回答，而非将探索委派给读取文件的子 agent——否则子 agent 无论如何都会读文件，Synapse 反而变成额外开销。

</details>

---

## 主要功能

| | |
|---|---|
| **智能上下文构建** | 一次工具调用返回入口点、相关符号和代码片段——无需昂贵的探索 agent |
| **全文搜索** | 由 FTS5 驱动，在整个代码库中按名称即时查找代码 |
| **影响分析** | 在修改前追踪任意符号的调用者、被调用者及完整影响半径 |
| **始终最新** | 文件监听器使用原生 OS 事件（FSEvents/inotify/ReadDirectoryChangesW），带防抖自动同步——图谱随代码实时更新，零配置 |
| **20+ 种语言** | TypeScript、JavaScript、Python、Go、Rust、Java、C#、PHP、Ruby、C、C++、Objective-C、Swift、Kotlin、Scala、Dart、Lua、Luau、R、Svelte、Vue、Astro、Liquid、Pascal/Delphi |
| **框架感知路由** | 识别 17 个框架的路由文件，将 URL 模式与对应的处理函数关联 |
| **混合 iOS / React Native / Expo** | 补全静态解析遗漏的跨语言调用链：Swift ↔ ObjC 桥接、React Native 旧版 bridge + TurboModules + Fabric 视图组件、原生 → JS 事件发射器、Expo Modules |
| **100% 本地** | 数据不离开你的机器，无需 API 密钥，无需外部服务，仅使用 SQLite 数据库 |

<details>
<summary><strong>自动同步原理——以及为何无需手动运行 <code>synapse sync</code></strong></summary>

当 agent（Claude Code、Cursor、Codex、opencode）启动 `synapse serve --mcp` 时，三个机制协同保持索引与代码同步，确保 agent 在编辑与下次同步之间的短暂窗口内不会静默获取到错误答案：

1. **带防抖的自动同步文件监听器。** 原生 FSEvents / inotify / ReadDirectoryChangesW 监听器捕获每次源文件的创建/修改/删除，并在防抖窗口后触发重新索引（默认 `2000ms`，可通过 `SYNAPSE_WATCH_DEBOUNCE_MS` 调节，范围 `[100ms, 60s]`）。短时间内的大量编辑会合并为一次同步。

2. **逐文件过期提示。** 在短暂的防抖窗口内，若 MCP 工具响应会引用仍在等待中的文件，会在前面加上 `⚠️` 提示，告知 agent 直接 `Read` 该文件。响应中未引用的等待中文件以小尾注方式显示。无论哪种方式，agent 都会收到明确信号——在 Claude Code 上已验证，agent 会明确说"直接读取文件以获取最新内容"后再打开文件。

3. **连接时补偿同步。** MCP 服务器（重新）连接时，Synapse 会在响应第一个查询前对工作树执行一次快速的 `(size, mtime)` + 内容哈希核对——在没有 MCP 服务器运行期间发生的变更（终端的 `git pull`、其他编辑器的修改、上一个已退出的 agent 会话）都会在下次会话的第一次工具调用时自动同步。

```
agent 写入 src/Widget.ts
  → 监听器触发 (<100ms)
  → 防抖（默认 2s）
  → 同步；Widget.ts 已进入索引
  → 下一次 agent 查询即可看到
```

**随时验证**，通过 `synapse_status`（MCP）或 `synapse status`（CLI）。如有待处理项，会看到 `### Pending sync:` 段，列出文件名和编辑时间。

需要手动运行 `synapse sync` 的少数情况：监听器被禁用（沙箱环境或设置了 `SYNAPSE_NO_DAEMON=1`），或在 agent 会话之外通过脚本使用索引需要预检同步。

→ 完整说明见[指南 → 索引项目](https://colbymchenry.github.io/synapse/guides/indexing/#stay-fresh-automatically)。

</details>

---

## 框架感知路由

Synapse 检测 Web 框架路由文件，生成 `route` 节点并通过 `references` 边与对应的处理类或函数关联。查询视图/控制器的调用者即可看到绑定它的 URL 模式。

| 框架 | 可识别的形式 |
|---|---|
| **Django** | `urls.py` 中的 `path()`、`re_path()`、`url()`、`include()`（CBV 的 `.as_view()`、点分路径） |
| **Flask** | `@app.route('/path', methods=[...])`, blueprint 路由 |
| **FastAPI** | `@app.get(...)`、`@router.post(...)` 等所有标准方法 |
| **Express** | `app.get(...)`、`router.post(...)` 及中间件链 |
| **NestJS** | `@Controller` + `@Get/@Post/...`、GraphQL `@Resolver` + `@Query/@Mutation`、`@MessagePattern`/`@EventPattern`、`@SubscribeMessage` |
| **Laravel** | `Route::get()`、`Route::resource()`、`Controller@action`、元组语法 |
| **Drupal** | `*.routing.yml` 路由（`_controller`、`_form`、实体处理器）；`.module`/`.theme`/`.install`/`.inc` 中的 `hook_*` 实现 |
| **Rails** | `get '/x', to: 'users#index'`、hash-rocket `=>` 语法 |
| **Spring** | 方法上的 `@GetMapping`、`@PostMapping`、`@RequestMapping` |
| **Play** | `conf/routes` 中的 `GET`/`POST`/… 动词路由 → `Controller.method` 动作（Scala + Java） |
| **Gin / chi / gorilla / mux** | `r.GET(...)`、`router.HandleFunc(...)` |
| **Axum / actix / Rocket** | `.route("/x", get(handler))` |
| **ASP.NET** | action 方法上的 `[HttpGet("/x")]` 特性 |
| **Vapor** | `app.get("x", use: handler)` |
| **React Router** / **SvelteKit** | 路由组件节点 |
| **Vue Router** / **Nuxt** | `pages/` 文件路由、`server/api/` 端点、路由中间件 |
| **Astro** | `src/pages/` 文件路由（`.astro` 页面 + `.ts` 端点、`[param]`/`[...rest]` 语法） |

---

## 混合 iOS / React Native / Expo 桥接

真实的 iOS 和 React Native 代码库跨越多种语言——Swift 调用方调用了已自动桥接的 Objective-C selector，JS 文件通过 React Native bridge 调用原生模块，JSX 组件委托给原生视图管理器。静态 tree-sitter 提取在每个语言边界处停止。Synapse 桥接这些边界，使 `trace`、`callers`、`callees` 和 `impact` 能够跨越语言边界端到端连通。

| 边界 | JS / Swift 侧 | 原生侧 | 方式 |
|---|---|---|---|
| **Swift → ObjC** | Swift `obj.foo(bar:)` | ObjC selector `-fooWithBar:` | `@objc` 自动桥接规则（含 init/property/protocol 形式）+ Cocoa 介词前缀（`With`/`For`/`By`/`In`/`On`/`At`/…） |
| **ObjC → Swift** | ObjC `[obj fooWithBar:]` | Swift `@objc func foo(bar:)` | 反向桥接名称候选；从源码验证 `@objc` 暴露 |
| **React Native 旧版 bridge** | JS `NativeModules.X.fn(...)` | ObjC `RCT_EXPORT_METHOD` / `RCT_REMAP_METHOD` · Java/Kotlin `@ReactMethod` | 解析宏/注解声明，构建 JS 名称 → 原生方法映射 |
| **React Native TurboModules** | JS `import M from './NativeM'; M.fn(...)` | 匹配 Codegen spec 的原生实现 | 将 `Native<X>.ts` spec 接口作为事实来源 |
| **RN 原生 → JS 事件** | JS `new NativeEventEmitter(...).addListener('e', cb)` | ObjC `[self sendEventWithName:@"e" body:...]` · Swift `sendEvent(withName: "e", ...)` · Java/Kotlin `.emit("e", ...)` | 以字面事件名为键的合成跨语言事件通道 |
| **Expo Modules** | JS `requireNativeModule('X').fn(...)` | Swift / Kotlin `Module { Name("X"); AsyncFunction("fn") { ... } }` | 解析 Expo DSL 字面量；合成方法节点通过现有名称匹配解析 |
| **Fabric 视图组件** | JSX `<MyView prop={v}/>` | TS Codegen spec + 原生实现类 | Spec → `component` 节点；基于约定的名称+后缀查找（`View`/`ComponentView`/`Manager`/`ViewManager`）桥接到原生 |
| **旧版 Paper 视图管理器** | JSX `<MyView prop={v}/>` | ObjC `RCT_EXPORT_VIEW_PROPERTY` · Java/Kotlin `@ReactProp` | 与 Fabric 相同——Paper 时代的声明也会生成 `component` + `property` 节点 |

**在真实代码库上验证**（每种桥接均覆盖小型 + 中型 + 大型）：

| 桥接 | 小型 | 中型 | 大型 |
|---|---|---|---|
| Swift ↔ ObjC | [Charts](https://github.com/danielgindi/Charts) | [realm-swift](https://github.com/realm/realm-swift) | [Wikipedia-iOS](https://github.com/wikimedia/wikipedia-ios) |
| RN 旧版 bridge | [AsyncStorage](https://github.com/react-native-async-storage/async-storage) | [react-native-svg](https://github.com/software-mansion/react-native-svg) | [react-native-firebase](https://github.com/invertase/react-native-firebase) |
| RN 原生 → JS 事件 | [RNGeolocation](https://github.com/Agontuk/react-native-geolocation-service) | — | react-native-firebase |
| Expo Modules | expo-haptics | expo-camera | expo SDK sweep（7 个包） |
| Fabric / Paper 视图 | [react-native-segmented-control](https://github.com/react-native-segmented-control/segmented-control) | [react-native-screens](https://github.com/software-mansion/react-native-screens) | [react-native-skia](https://github.com/Shopify/react-native-skia) |

每条桥接边都带有 `provenance:'heuristic'` 标记，`metadata.synthesizedBy:` 设置为稳定的通道名称（如 `swift-objc-bridge`、`rn-event-channel`、`fabric-native-impl`、`expo-module-extract`），让 agent 一眼就能看出某条跳转是如何进入图谱的。

---

## 快速上手

### 1. 运行安装器

```bash
npx @colbymchenry/synapse
```

安装器会：
- 询问要配置哪些 agent——自动检测已安装的：**Claude Code**、**Cursor**、**Codex CLI**、**opencode**、**Hermes Agent**、**Gemini CLI**、**Antigravity IDE**、**Kiro**
- 提示是否将 `synapse` 安装到 PATH（以便 agent 能启动 MCP 服务器）
- 询问配置是应用于所有项目还是仅限当前项目
- 为每个选中的 agent 写入 MCP 服务器配置，并在 agent 说明文件（`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`）中写入带标记围栏的 Synapse 段落——这是子 agent 和非 MCP agent 了解 `synapse explore` / `synapse node` 命令的方式，因为 MCP 服务器自身的指南只能到达主 agent。可通过 `synapse uninstall` 干净移除。
- 当 Claude Code 是目标之一时，设置自动授权权限
- 初始化当前项目（仅限本地安装）

**非交互模式（脚本 / CI）：**

```bash
synapse install --yes                              # 自动检测 agent，全局安装
synapse install --target=cursor,claude --yes       # 指定目标列表
synapse install --target=auto --location=local     # 检测到的 agent，项目本地安装
synapse install --print-config codex               # 打印配置片段，不写入文件
```

| 标志 | 可选值 | 默认值 |
|---|---|---|
| `--target` | `auto`、`all`、`none` 或逗号分隔列表（`claude,cursor,...`） | 交互提示 |
| `--location` | `global`、`local` | 交互提示 |
| `--yes` | （布尔值） | 逐步提示 |
| `--no-permissions` | （布尔值）跳过 Claude 自动授权列表 | 权限开启 |
| `--print-config <id>` | 输出指定 agent 的配置片段并退出 | — |

### 2. 重启你的 agent

重启 agent（Claude Code / Cursor / Codex CLI / opencode / Hermes Agent / Gemini CLI / Antigravity IDE / Kiro）以加载 MCP 服务器。

### 3. 初始化项目

```bash
cd your-project
synapse init
```

构建每个项目的知识图谱索引，并在每次文件变更时自动同步。一次全局 `synapse install` 即可在你打开的每个项目中生效，无需为每个项目重新运行安装器。

至此完成——当 `.synapse/` 目录存在时，你的 agent 会自动使用 Synapse 工具。

<details>
<summary><strong>手动安装（替代方案）</strong></summary>

**全局安装：**
```bash
npm install -g @colbymchenry/synapse
```

**添加到 `~/.claude.json`：**
```json
{
  "mcpServers": {
    "synapse": {
      "type": "stdio",
      "command": "synapse",
      "args": ["serve", "--mcp"]
    }
  }
}
```

**添加到 `~/.claude/settings.json`（可选，用于自动授权）：**
```json
{
  "permissions": {
    "allow": [
      "mcp__synapse__synapse_search",
      "mcp__synapse__synapse_explore",
      "mcp__synapse__synapse_callers",
      "mcp__synapse__synapse_callees",
      "mcp__synapse__synapse_impact",
      "mcp__synapse__synapse_node",
      "mcp__synapse__synapse_status",
      "mcp__synapse__synapse_files"
    ]
  }
}
```

</details>

<details>
<summary><strong>agent 工具说明</strong></summary>

Synapse MCP 服务器在 MCP `initialize` 响应中**自动**向你的 agent 传递使用指南。简而言之，它告诉 agent：

- **直接用 Synapse 回答结构性问题** — 它*就是*预构建索引，grep/read 循环只是在重复它已经做过的工作。把返回的源码视为已读。
- **按意图选择工具：** `synapse_explore` 适用于几乎所有情况——"X 如何工作"、调用链/"X 如何到达 Y"，或对某个区域进行概览（一次调用返回相关符号的源码，按文件分组）；`synapse_search` 仅用于定位符号；`synapse_callers` 获取所有调用点（包括回调注册处）；`synapse_node` 获取一个符号的完整源码 + 调用者，或像 Read 工具一样读取文件。
- **信任结果——不要用 grep 重新验证**，编辑后检查过期提示。
- 在没有索引的工作区中，Synapse 宣布自身处于非活跃状态，不提供任何工具——索引始终由你决定。

确切文本见 `src/mcp/server-instructions.ts`——这是面向主 agent 的单一事实来源。由于子 agent 和非 MCP 运行器从不接收 MCP 指南，安装器还会在 agent 的说明文件中写入带标记围栏的四行段落，指向 `synapse explore` / `synapse node` 的 CLI 等价命令。

</details>

---

## 工作原理

```
┌───────────────────────────────────────────────────────────────────┐
│                            Claude Code                            │
│                                                                   │
│   "请求如何到达数据库？"                                           │
│       直接调用 Synapse 工具——无需 Explore 子 agent               │
│                                 │                                 │
└─────────────────────────────────┬─────────────────────────────────┘
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│                        Synapse MCP Server                        │
│                                                                   │
│       explore · search · callers · callees · impact · node        │
│                                 │                                 │
│                                 ▼                                 │
│                       SQLite 知识图谱                             │
│          符号 · 边 · 文件 · FTS5 全文搜索                        │
└───────────────────────────────────────────────────────────────────┘
```

1. **提取** — [tree-sitter](https://tree-sitter.github.io/) 将源码解析为 AST。针对各语言的查询提取节点（函数、类、方法）和边（调用、导入、继承、实现）。

2. **存储** — 所有数据写入本地 SQLite 数据库（`.synapse/synapse.db`），支持 FTS5 全文搜索。

3. **解析** — 提取后解析引用：函数调用 → 定义，导入 → 源文件，类继承，以及框架特定模式。

4. **自动同步** — MCP 服务器通过原生 OS 文件事件监听项目。变更经过防抖（2 秒静默窗口）和源文件过滤后进行增量同步。图谱随代码实时更新，无需任何配置。

---

## CLI 参考

```bash
synapse                         # 运行交互式安装器
synapse install                 # 运行安装器（显式调用）
synapse uninstall               # 从所有 agent 中移除 Synapse（install 的逆操作）
synapse init [path]             # 在项目中初始化（--index 同时进行索引）
synapse uninit [path]           # 从项目中移除 Synapse（--force 跳过确认提示）
synapse index [path]            # 全量索引（--force 重新索引，--quiet 减少输出）
synapse sync [path]             # 增量更新
synapse status [path]           # 显示统计信息
synapse unlock [path]           # 移除阻塞索引的过期锁文件
synapse query <search>          # 搜索符号（--kind、--limit、--json）
synapse explore <query>         # 一次返回相关符号的源码和调用路径（与 synapse_explore MCP 工具输出相同）
synapse node <symbol|file>      # 一个符号的源码 + 调用者，或带行号读取文件（与 synapse_node 输出相同）
synapse files [path]            # 显示文件结构（--format、--filter、--max-depth、--json）
synapse callers <symbol>        # 查找调用某函数/方法的代码（--limit、--json）
synapse callees <symbol>        # 查找某函数/方法调用的代码（--limit、--json）
synapse impact <symbol>         # 分析修改某符号会影响哪些代码（--depth、--json）
synapse affected [files...]     # 查找受变更影响的测试文件（见下方）
synapse daemon                  # 管理后台守护进程——选择一个停止（别名：daemons）
synapse telemetry [on|off]      # 查看或更改匿名使用遥测设置
synapse upgrade [version]       # 更新到最新版本（--check、--force）
synapse version                 # 打印已安装版本（也可用 -v、--version）
synapse help [command]          # 显示帮助，可选择指定某个命令
```

### `synapse affected`

通过传递性地追踪导入依赖，找出受变更源文件影响的测试文件。

```bash
synapse affected src/utils.ts src/api.ts         # 直接传入文件
git diff --name-only | synapse affected --stdin   # 从 git diff 管道输入
synapse affected src/auth.ts --filter "e2e/*"     # 自定义测试文件匹配模式
```

| 选项 | 说明 | 默认值 |
|--------|-------------|---------|
| `--stdin` | 从标准输入读取文件列表 | `false` |
| `-d, --depth <n>` | 最大依赖遍历深度 | `5` |
| `-f, --filter <glob>` | 用于识别测试文件的自定义 glob | 自动检测 |
| `-j, --json` | 以 JSON 格式输出 | `false` |
| `-q, --quiet` | 仅输出文件路径 | `false` |

**CI/hook 示例：**

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | synapse affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```

---

## MCP 工具

作为 MCP 服务器运行时，Synapse 暴露一组精简的工具——经过实测，更精简的工具列表能引导 agent 选择正确的工具，每次会话都能节省上下文：

| 工具 | 用途 |
|------|---------|
| `synapse_explore` | **主要工具。** 几乎所有问题一次调用即可回答——"X 如何工作"、调用链（"X 如何到达 Y"），或对某个区域进行概览——返回相关符号的完整源码（按文件分组）、关系图和影响半径。能呈现 grep 无法追踪的动态分发跳转（回调、React 重渲染、接口→实现）。 |
| `synapse_node` | 一个符号的完整源码 + 调用者/被调用者链（对于同名的多个重载，一次调用返回所有版本）——或传入文件路径**像 Read 工具一样读取整个文件**（相同的带行号输出，支持 `offset`/`limit`），并附带其依赖者。 |
| `synapse_search` | 按名称在代码库中搜索符号 |
| `synapse_callers` | 某个函数的所有调用点——包括它被注册为回调的地方——当多个定义共享同一名称时，每个定义单独列一段 |

另外四个工具（`synapse_callees`、`synapse_impact`、`synapse_files`、`synapse_status`）默认不在工具列表中，但仍完整可用——经过评估运行测量，agent 从不或极少选择它们，且它们的信息已内联在上述四个工具中（explore 的影响半径段落、node 的依赖者说明、符号的函数体即其被调用者列表）。通过 `SYNAPSE_MCP_TOOLS` 环境变量可重新启用任意工具（如 `SYNAPSE_MCP_TOOLS=explore,node,search,callers,impact`），也可使用对应的 CLI 命令（`synapse callees` / `impact` / `files` / `status`）。

在没有 `.synapse/` 索引的工作区中，服务器宣布自身处于非活跃状态，不列出任何工具——agent 正常使用其内置工具，索引始终由你决定。

---

## 库用法

Synapse 可直接嵌入使用。npm 包重新导出其程序化 API，`import` 和 `require` 均可在你自己的进程中解析 `Synapse` 类——适合嵌入到应用程序中（例如 Electron 主进程）。

```typescript
import Synapse from '@colbymchenry/synapse';
// CommonJS 同样可用：
//   const { Synapse } = require('@colbymchenry/synapse');

const cg = await Synapse.init('/path/to/project');
// 或：const cg = await Synapse.open('/path/to/project');

await cg.indexAll({
  onProgress: (p) => console.log(`${p.phase}: ${p.current}/${p.total}`)
});

const results = cg.searchNodes('UserService');
const callers = cg.getCallers(results[0].node.id);
const context = await cg.buildContext('fix login bug', { maxNodes: 20, includeCode: true, format: 'markdown' });
const impact = cg.getImpactRadius(results[0].node.id, 2);

cg.watch();   // 文件变更时自动同步
cg.unwatch(); // 停止监听
cg.close();
```

同一入口点还导出了底层构建块，供直接操作图谱的调用者使用：`DatabaseConnection`、`QueryBuilder`、`getDatabasePath`、`initGrammars` / `loadGrammarsForLanguages` 和 `FileLock`。

**嵌入要求**

- 通过 npm 安装（`npm i @colbymchenry/synapse`），以便获取携带已编译库及其依赖的对应平台包。
- API 运行在**你的**运行时上，因此需要 **Node 22.5+** 才能使用内置的 `node:sqlite`（Electron 在其内置 Node 为 22.5+ 时同样满足）。CLI 和 MCP 服务器不受影响——它们运行在自包含的内置运行时上。
- TypeScript 类型随包一起发布。与任何面向 Node 的库一样，需保证 `@types/node` 可用，并设置 `skipLibCheck: true`（这是常见默认值）。

---

## 配置

无需任何配置——Synapse 是**零配置**的，**没有配置文件**需要编写或同步维护。语言支持根据文件扩展名自动识别，无需为每种语言做任何设置。

默认跳过的内容：

- **依赖、构建和缓存目录** — `node_modules`、`vendor`、`dist`、`build`、`target`、`.venv`、`Pods`、`.next` 以及各[支持技术栈](#支持的语言)中的类似目录——图谱中只有你自己的代码，而非第三方内容。即使没有 `.gitignore`，这一规则同样生效。
- **`.gitignore` 中的任何内容** — 在 git 仓库中通过 git 读取，在非 git 项目中直接读取 `.gitignore`（包括根目录和嵌套目录）。
- **大于 1 MB 的文件** — 生成的打包文件、压缩后的 JS、vendored 二进制文件。

如需排除其他内容，将其添加到 `.gitignore` 即可。如需把默认排除的目录重新**纳入**索引（比如确实想索引某个 vendored 依赖），可添加取反规则——`!vendor/`。默认规则统一适用，因此提交依赖或构建目录并不会将其强制纳入图谱；`.gitignore` 取反规则是显式的选择加入方式。

## 遥测

Synapse 收集**匿名使用统计数据**——使用了哪些工具和命令、索引了哪些语言——用于指导语言支持和 agent 集成工作的优先级。**绝不**收集任何代码、路径、文件或符号名称、查询内容或 IP 地址；使用数据在本地聚合为每日总计后才会发送，且数据接收端点是[本仓库中的公开代码](telemetry-worker/)，强制执行文档中的字段列表。安装器会在开始时询问；随时关闭：

```bash
synapse telemetry off    # 或：SYNAPSE_TELEMETRY=0，或 DO_NOT_TRACK=1
```

[`TELEMETRY.md`](TELEMETRY.md) 列出了所有字段，以及关闭方式和完整的数据处理说明。

## 支持的平台

每个版本都为全部三种桌面操作系统、x64 和 arm64 两种架构提供自包含构建（内置 Node runtime，无需编译）：

| 平台 | 架构 | 安装方式 |
|----------|---------------|---------|
| Windows | x64, arm64 | PowerShell 安装器或 npm |
| macOS | x64, arm64 | shell 安装器或 npm |
| Linux | x64, arm64 | shell 安装器或 npm |

一键安装命令见[快速开始](#快速开始)。

## 支持的 Agent

交互式安装器会自动检测并配置以下每个 agent——接入 MCP 服务器（服务器会自动传递使用指南，无需写入说明文件）：

- **Claude Code**
- **Cursor**
- **Codex CLI**
- **opencode**
- **Hermes Agent**
- **Gemini CLI**
- **Antigravity IDE**
- **Kiro**

## 支持的语言

| 语言 | 扩展名 | 状态 |
|----------|-----------|--------|
| TypeScript | `.ts`, `.tsx` | 完整支持 |
| JavaScript | `.js`, `.jsx`, `.mjs` | 完整支持 |
| Python | `.py` | 完整支持 |
| Go | `.go` | 完整支持 |
| Rust | `.rs` | 完整支持 |
| Java | `.java` | 完整支持 |
| C# | `.cs` | 完整支持 |
| PHP | `.php` | 完整支持 |
| Ruby | `.rb` | 完整支持 |
| C | `.c`, `.h` | 完整支持 |
| C++ | `.cpp`, `.hpp`, `.cc` | 完整支持 |
| Objective-C | `.m`, `.mm`, `.h` | 部分支持（类、协议、方法、`@property`、`#import`、消息发送；`.mm` ObjC++ 可能解析不完整） |
| Swift | `.swift` | 完整支持 |
| Kotlin | `.kt`, `.kts` | 完整支持 |
| Scala | `.scala`, `.sc` | 完整支持（类、trait、方法、类型别名、Scala 3 枚举） |
| Dart | `.dart` | 完整支持 |
| Svelte | `.svelte` | 完整支持（脚本提取、Svelte 5 runes、SvelteKit 路由） |
| Vue | `.vue` | 完整支持（script + script-setup 提取、Nuxt 页面/API/中间件路由） |
| Astro | `.astro` | 完整支持（frontmatter + 脚本提取、模板组件/调用引用、`src/pages/` 路由） |
| Liquid | `.liquid` | 完整支持 |
| Pascal / Delphi | `.pas`, `.dpr`, `.dpk`, `.lpr` | 完整支持（类、record、接口、枚举、DFM/FMX 窗体文件） |
| Lua | `.lua` | 完整支持（带接收者的函数和方法、局部变量、`require` 导入、调用边） |
| R | `.R` `.r` | 完整支持（所有赋值形式的函数、S4/R5/R6 类及方法、`library`/`require` 导入、`source()` 文件引用、调用边） |
| Luau | `.luau` | 完整支持（Lua 全部特性，加上 `type`/`export type` 别名、类型签名、Roblox 实例路径 `require`） |

## 跨文件覆盖率测量

影响和影响半径查询的质量取决于其背后的依赖图，因此覆盖率是通过测量而非断言得出的。**合理覆盖率** = 含有符号的源文件中，至少有一个*已解析的跨文件依赖者*的文件占比——即有某个文件通过导入、调用、引用或（通过框架约定）路由指向它——基于每种语言的真实基准代码库。剩余部分始终是真实的静态分析边界（运行时动态分发、反射/依赖注入容器、框架约定入口点、vendored 第三方代码），而非通过操纵分母来掩盖。

| 语言 | 基准代码库 | 覆盖率 |
|---|---|---|
| TypeScript / JavaScript | 本仓库 | 95.8% |
| Python | psf/requests | 100% |
| Go | gin-gonic/gin | 96.6% |
| Rust | BurntSushi/ripgrep | 86.7% |
| Java | google/gson | 93.3% |
| C# | jbogard/MediatR | 85.2% |
| PHP | guzzle/guzzle | 100% |
| Ruby | sidekiq/sidekiq | 100% |
| C | redis/redis | 92.2% |
| C++ | google/leveldb | 94.8% |
| Objective-C | SDWebImage | 91.6% |
| Swift | Alamofire | 95.3% |
| Kotlin | square/okhttp | 96.2% |
| Scala | gatling/gatling | 91.2% |
| Dart | flutter/packages | 92.4% |
| Svelte / SvelteKit | sveltejs/realworld | 100% |
| Vue / Nuxt | nuxt/movies | 93.5% |
| Astro | xingwangzhe/stalux | 93.0% |
| Lua | nvim-telescope/telescope.nvim | 84.2% |
| Luau | dphfox/Fusion | 92.2% |
| Liquid | Shopify/dawn | 73.8% |
| Pascal / Delphi | PascalCoin | 77.4% |

框架路由在每个框架的标准应用上以同样方式验证：Express 100%、FastAPI 98%、Flask 100%、NestJS 96.8%、Gin 96.5%、Axum 100%、Rocket 93.8%、Vapor 100%、Laravel 92%、Rails 89.6%、React Router 100%——以及约定/反射较重的框架在其诚实的静态分析上限：ASP.NET 83.9%、Spring 83.3%、Drupal 78.9%、Play 76.3%、Django 74.1%。SvelteKit、Vue/Nuxt 和 Astro 使用基于文件的路由，因此其页面/端点覆盖率即上表中的 Svelte/SvelteKit（100%）、Vue/Nuxt（93.5%）和 Astro（93.0%——在两个验证代码库上，每个 `src/pages/` 文件都映射到一个路由节点）数字。

## 故障排查

**"Synapse not initialized"** — 先在项目目录中运行 `synapse init`。

**索引速度慢** — 检查 `node_modules` 和其他大目录是否已被排除。使用 `--quiet` 可减少输出开销。

**MCP 报 `database is locked`** — 当前版本不应出现此问题：Synapse 内置自己的 Node 运行时，使用 Node 原生的 `node:sqlite` 并以 WAL 模式运行，并发读取不会被写入阻塞。如果仍然遇到：

- **你使用的是旧版（0.9 之前）安装。** 重新安装以获取内置运行时——`curl -fsSL https://raw.githubusercontent.com/colbymchenry/synapse/main/install.sh | sh`（macOS/Linux），`irm https://raw.githubusercontent.com/colbymchenry/synapse/main/install.ps1 | iex`（Windows），或 `npm i -g @colbymchenry/synapse@latest`。
- **`synapse status` 显示 `Journal:` 不是 `wal`**——说明当前文件系统无法启用 WAL（常见于网络共享和 WSL2 的 `/mnt`），读取可能被写入阻塞。将项目（连同 `.synapse/` 目录）移至本地磁盘。

**MCP 服务器无法连接** — agent 会自动启动服务器，无需手动启动。确认项目已初始化并索引（`synapse status`），以及 MCP 配置中的路径正确。如果仍无法连接，重新运行 `synapse install` 以重写配置。

**符号缺失** — MCP 服务器会在保存后自动同步（等待几秒钟）。如有需要，可手动运行 `synapse sync`。检查该文件的语言是否受支持，以及是否在 `.gitignore` 排除的或默认排除的目录（如 `node_modules`、`dist`）中。

**在 Windows 和 WSL 之间共享同一检出** — 不要让两端指向同一个 `.synapse/`：后台服务器锁和 SQLite 索引与写入它们的操作系统绑定，且 SQLite 锁定在 WSL2/Windows 文件系统边界上并不可靠。通过为其中一端设置 `SYNAPSE_DIR` 为不同名称，让每一端在同一目录树中使用自己的索引——例如在 Windows 上设置 `SYNAPSE_DIR=.synapse-win`，让 WSL 保持默认的 `.synapse`。Synapse 在索引和监听时会跳过任何同级的 `.synapse-*` 目录，因此两端互不干扰。

## Star History

<a href="https://www.star-history.com/?repos=colbymchenry%2Fsynapse&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=colbymchenry/synapse&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=colbymchenry/synapse&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=colbymchenry/synapse&type=date&legend=top-left" />
 </picture>
</a>

## License

MIT

---

<div align="center">

**专为 AI 编程 agent 打造——Claude Code、Cursor、Codex CLI、opencode、Hermes Agent、Gemini CLI、Antigravity IDE 和 Kiro**

