# CLAUDE.md

本文件为 Claude Code（claude.ai/code）提供在此代码库工作时的指引。

## 项目概述

Synapse 是一个本地优先的代码智能库 + CLI + MCP 服务器。它使用 tree-sitter 解析任何受支持的代码库，将符号/边/文件存储在 SQLite（FTS5）中，并通过 MCP 向 AI 智能体（Claude Code、Cursor、Codex CLI、opencode）暴露知识图谱。每个项目的数据存放在 `.synapse/` 目录中。提取过程是确定性的——来自 AST，而非 LLM 生成的摘要。

通过 npm 以 `@colbymchenry/synapse` 发布；同一个二进制文件兼作安装器、索引器和 MCP 服务器。

## 构建、测试、运行

```bash
npm run build           # tsc + copy schema.sql and *.wasm into dist/; chmods dist/bin/synapse.js
npm run dev             # tsc --watch
npm run clean           # rm -rf dist

npm test                # vitest run (all)
npm run test:watch
npm run test:eval       # only __tests__/evaluation/
npm run eval            # build then run __tests__/evaluation/runner.ts via tsx

npm run cli             # build then run the local dist binary

# Single test file / pattern
npx vitest run __tests__/installer-targets.test.ts
npx vitest run __tests__/extraction.test.ts -t "TypeScript"
```

`copy-assets`（由 `build` 调用）将 `src/db/schema.sql` 和所有 `src/extraction/wasm/*.wasm` 文件复制到 `dist/`。**任何新的 SQL 或语法 wasm 都必须复制，否则不会被打包发布。**

Node 引擎要求：`>=20.0.0 <27.0.0`。在 Node 25.x 上会强制退出（参见 `src/bin/node-version-check.ts`）。

## 架构

### 分层流水线

```
files → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/files)
              ↓
       ReferenceResolver (imports, name-matching, framework patterns)
              ↓
       GraphQueryManager / GraphTraverser (callers, callees, impact)
              ↓
       ContextBuilder (markdown/JSON for AI consumption)
```

公共 API 入口是 `src/index.ts`——`Synapse` 类串联所有层并重新导出类型。库的使用者只接触这个文件；MCP 服务器和 CLI 也通过它驱动。

### 模块布局

- `src/index.ts` — `Synapse` 类：`init`/`open`/`close`、`indexAll`、`sync`、`searchNodes`、`getCallers`/`getCallees`、`getImpactRadius`、`buildContext`、`watch`/`unwatch`。
- `src/db/` — `DatabaseConnection`、`QueryBuilder`（预编译语句）、`schema.sql`。底层使用 `better-sqlite3`（原生），在不可用时透明地回退到 `node-sqlite3-wasm`。`synapse status` 显示当前使用的后端；wasm 是慢速路径。
- `src/extraction/` — `ExtractionOrchestrator`、tree-sitter 封装、`languages/` 下的各语言提取器（每种语言一个文件），以及非 tree-sitter 格式的独立提取器（`svelte-extractor.ts`、`vue-extractor.ts`、`liquid-extractor.ts`、`dfm-extractor.ts` 用于 Delphi）。`parse-worker.ts` 在主线程之外执行繁重的解析工作。
- `src/resolution/` — `ReferenceResolver` 协调 `import-resolver.ts`（含 `path-aliases.ts`，支持 tsconfig 路径别名和 Cargo 工作区成员 glob）、`name-matcher.ts` 以及 `frameworks/`（Express、Laravel、Rails、FastAPI、Django、Flask、Spring、Gin、Axum、ASP.NET、Vapor、React Router、SvelteKit、Vue/Nuxt、Cargo 工作区）。框架会生成 `route` 节点和 `references` 边。
- `src/graph/` — `GraphTraverser`（BFS/DFS、影响半径、路径查找）和 `GraphQueryManager`（高层查询）。
- `src/context/` — `ContextBuilder` 及 Markdown/JSON 格式化器。
- `src/search/` — 全文查询解析器和 FTS5 辅助工具。
- `src/sync/` — `FileWatcher`（原生 FSEvents/inotify/RDCW）含防抖和过滤，以及 git hook 辅助工具。
- `src/mcp/` — MCP 服务器（`MCPServer`、`tools.ts`、`transport.ts`）。`server-instructions.ts` 是服务器在 MCP `initialize` 响应中返回的内容——请与面向用户的工具指引保持同步。
- `src/installer/` — 见下文。
- `src/bin/synapse.ts` — CLI（commander）。子命令：`install`、`init`、`uninit`、`index`、`sync`、`status`、`query`、`files`、`context`、`affected`、`serve --mcp`。
- `src/ui/` — 终端 UI（shimmer 进度条、worker）。

### NodeKind / EdgeKind

定义于 `src/types.ts`。提取器和解析器都必须使用这些确切的字符串。

- **NodeKind**：`file`、`module`、`class`、`struct`、`interface`、`trait`、`protocol`、`function`、`method`、`property`、`field`、`variable`、`constant`、`enum`、`enum_member`、`type_alias`、`namespace`、`parameter`、`import`、`export`、`route`、`component`。
- **EdgeKind**：`contains`、`calls`、`imports`、`exports`、`extends`、`implements`、`references`、`type_of`、`returns`、`instantiates`、`overrides`、`decorates`。

### 多智能体安装器

`src/installer/` 是 `synapse install`（以及裸命令 `synapse`/`npx @colbymchenry/synapse`）的入口。架构：

- `targets/registry.ts` 列出每个受支持的智能体。
- `targets/types.ts` 定义 `AgentTarget` 接口——添加第 5 个智能体（Continue、Zed、Windsurf……）只需**在 `targets/` 中新建一个文件 + 在 `registry.ts` 中添加一条记录**。每个 target 自行管理其配置文件位置和 MCP 服务器 JSON/TOML/JSONC 的写入。（各 target 不再写入 instructions 文件——见下文。）
- 当前 targets：`claude.ts`、`cursor.ts`、`codex.ts`、`opencode.ts`。
- `targets/toml.ts` 是一个手工编写的 TOML 序列化器，范围限定为 `[mcp_servers.synapse]`（供 Codex 使用）。同级表和 `[[array_of_tables]]` 原样保留。无新依赖。
- opencode 默认读取 `opencode.jsonc`；安装器优先使用已有的 `.jsonc`，回退到 `.json`，全新安装时创建 `.jsonc`。编辑通过 `jsonc-parser` 精准进行，用户的注释和格式在安装/重装/卸载的全流程中得以保留。
- `instructions-template.ts` 不再包含 instructions 正文——它只导出 `<!-- SYNAPSE_START -->`/`<!-- SYNAPSE_END -->` 标记。安装器**已停止**向各智能体的 instructions 文件（`CLAUDE.md`/`~/.codex/AGENTS.md`/`~/.config/opencode/AGENTS.md`/`~/.gemini/GEMINI.md`/`.cursor/rules/synapse.mdc`/Kiro steering 文档）写入 `## Synapse` 块，因为那只是对 MCP `initialize` instructions 的逐字重复（issue #529）。每个 target 的 `install`（升级时自愈）和 `uninstall` 使用这些标记来**清除**旧版本遗留的块。`server-instructions.ts` 是面向智能体指引的唯一真实来源。
- 所有安装器变更都需要在 `__tests__/installer-targets.test.ts` 中有相应覆盖——该文件包含约 47 个参数化契约测试，覆盖安装幂等性、同级保留、卸载还原安装、字节级相等的重复运行返回 `unchanged`，以及 Codex 的部分状态恢复。

### Cursor MCP 工作目录问题

Cursor 以错误的 cwd 启动 MCP 子进程，且在 `initialize` 时不传递 `rootUri`。安装器会将 `--path` 注入 Cursor 的 MCP args——本地安装使用绝对路径，全局安装使用 `${workspaceFolder}`。如果修改 Cursor 的连接逻辑，请保留此行为。

### MCP 服务器 instructions

`src/mcp/server-instructions.ts` 在 MCP `initialize` 响应中返回给智能体。这是每个智能体了解如何使用这些工具的**第一手资料**，也是自 issue #529 起面向智能体工具指引的**唯一真实来源**——安装器不再向 `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`.cursor/rules/synapse.mdc` 写入重复的 `## Synapse` instructions 块。如需编辑工具指引，只在此处修改。

## 检索性能与动态分发覆盖（不得回退）

Synapse 的核心价值在于让智能体能够通过少量**快速** synapse 调用、**零次** Read/Grep，回答**结构/流程**类问题（"X 如何到达 Y"、调用链、影响、调用者）。优化目标是**挂钟延迟 + 工具调用次数**——*不优化 token 成本*。（成本是**降低**的，而非早期表述的"持平"：对 README 中 7 个代码库进行当前版本有无对比的 A/B 测试，取 4 次中位数，平均节省了 **35% 成本、57% token、46% 时间、71% 工具调用**——复现了 README 中发布的数据。机制是**在累积上下文小得多的情况下完成更少轮次**——而非缓存命中率：无 synapse 时庞大的 token 量大多是廉价的缓存读取，这也是为何 token 节省（57%）看起来比成本节省（35%）更大。按**每轮 assistant 用量求和**来统计 token，而非用 `result.usage`（当前 Claude Code 中只记录最后一轮）。参见 `docs/benchmarks/call-sequence-analysis.md`。）推动一切的核心机制：**智能体一旦觉得 synapse 的答案不够用，就会回退到 Read/Grep。** 因此每一项变更都要以一个问题来衡量——synapse 的答案是否足以让智能体**停止读取**？

**目标行为：** 流程类问题在小型代码库中 **1 次 synapse 调用**即可解决，在大型代码库中规模扩展到 **3–5 次**，且 **Read/Grep = 0**。在审查 PR 或尝试新功能时，不得出现回退。

### 适应智能体——不要试图改变智能体

这是决定检索改进能否落地的关键杠杆。**在动手构建之前先测试：这能让智能体_已经会调用_的工具，用它_已经给出_的输入做更多事吗？如果它反而需要智能体改变行为——选择不同的工具、以不同方式查询、从示例中学习——那就会碰上低显著性的壁垒，无法落地。**

Synapse 影响智能体的渠道只有低显著性的两条：MCP `initialize` instructions（`server-instructions.ts`）和工具描述。修改它们**不能**可靠地改变智能体的工具_选择_或查询风格——经过验证：将 trace-first 引导移植到 server-instructions + 工具描述中（3 种措辞变体），始终无法复现通过 CLI `--append-system-prompt` 所达到的效果，且**相比基线出现了回退**。新工具的情况更糟（很少被选用——智能体对 `trace` 的使用率也不够）；"更好的示例"属于同一类引导。随着宿主模型的工具使用能力提升，智能体的工具选择会自然改善——但那不是我们能强制的。

真正有效的是顺势而为：
- **explore-flow** — `synapse_explore` 是智能体可靠调用的**主要**工具；其查询是一组精确的符号名（包括限定名 `Class.method`），涵盖智能体所关注的流程；explore 在这些命名符号中找到调用路径（借助合成边），并在输出的开头呈现。（`buildFlowFromNamedSymbols`：片段/共名消歧；最多 1 个未命名的桥接节点，不会在上帝函数的扇出中迷失。重载感知：查询中出现 PascalCase 类型 token 时，会将重载名称偏向该类型自身的定义——`DataRequest task` → DataRequest 的 `task`，而非抽象基类的；命名符号所在文件优先排序。）
- **充分性** — 让工具输出足够完整，使智能体停止读取。`synapse_node` 返回完整的函数体 + 调用者/被调用者链，对于**有歧义的**名称，会在**一次调用中返回每个重载的完整体**（这样智能体就不需要再读文件来找对应的重载——已在 Alamofire/gin 上验证）。这是 explore 之后的深度工具（标注为 SECONDARY）。
- **错误会导致放弃** — 一两次 `isError: true` 响应过后，智能体就会在整个会话中停止调用 synapse（维护者多次观察到）。`isError` 仅用于真正的"停止尝试"场景：安全拒绝（`PathRefusalError`）和真实故障（附带一次重试提示）。所有预期的/可恢复的情况——项目未索引、符号未找到、文件不在索引中——都返回**形状为成功的响应，内含指引**（`NotIndexedError` → `textResult`，参见 `ToolHandler.execute` 的 catch 块）。同样的原则适用于整个会话：**未索引的工作区返回空的 `tools/list` + 2 行"inactive"instructions 变体**，而非 8 个全部失败的工具——缺席是智能体不会误读的唯一信号，而且索引故意交由用户决定，从不由智能体触发。

失败的反面是将精确答案折叠进**模糊输入**工具：已移除的 `synapse_context` 接收描述而非符号，无法消歧流程的端点，结果呈现的是_错误特性_（这正是它被删除的原因）。精确输出需要精确输入——explore 使用符号包正是出于这个原因。（`synapse_trace` 同样因此被移除：explore-flow 已能完成其工作，而智能体对它的选用率不足。）

该轴线下剩余的杠杆是**覆盖度**：每一条新的静态连接流程（新的动态分发合成器，或提取静态解析遗漏的符号——例如 `create((set,get)=>({...}))` 中的对象字面量 store actions）都会被 explore-flow 自动呈现，无需改变智能体行为。响应式/调度器运行时（Halo 的 `ReactiveExtensionClient`、MediatR、Vue Proxy）是前沿——那里的流程没有静态边，因此什么都不会呈现（正确——沉默胜于错误）。完整调查和 A/B 记录：`docs/benchmarks/call-sequence-analysis.md` + 自动记忆 `project_synapse_read_displacement`。

### Explore 预算——保持两个预算单调递增

`src/mcp/tools.ts` 中的两个函数根据已索引文件数来调整 explore 的规模。以下是预期的解析效果（此处回退会悄悄地把智能体推回 Read）：

| 代码库 | 文件数 | explore 调用次数 | 每次字符数 | 每文件字符数 |
|---|---|---|---|---|
| express（小型）| 147 | 1 | 18K | 3800 |
| excalidraw/django（中型）| 643–3043 | 2 | 28K | 6500 |
| vscode（大型）| 10446 | 3 | 35K | 7000 |
| ~20k / ~40k | — | 4 / 5 | 38K | 7000 |

- `getExploreBudget(fileCount)` → **调用**预算：`<500→1, <5000→2, <15000→3, <25000→4, ≥25000→5`（最多 5）。
- `getExploreOutputBudget(fileCount)` → **每次调用**输出（字符数/文件数/每文件字符数）。**不变式：较大档位的 `maxCharsPerFile` 绝不能低于较小档位。**（引发此文档的回退：`<5000` 档的 2500 *低于* `<500` 档的 3800，导致在上帝文件代码库——excalidraw 的 415KB `App.tsx`——上，一次 explore 返回不到 1% 的文件内容，迫使进行 Read。）
- Explore 输出**绝不能让智能体去"使用 Read"**——引导其再次调用 `synapse_explore`，并"将已返回的源码视为已 Read"。

### 动态分发覆盖——流程必须在图中端到端存在

静态 tree-sitter 提取会遗漏计算型/间接调用，导致流程在动态分发处断裂，迫使智能体读取文件来重建。合成器/解析器通过桥接这些断点，让 `synapse_explore` 能够端到端地连接（`src/resolution/callback-synthesizer.ts`、`src/resolution/frameworks/`）。目前已覆盖的通道：callback/observer、EventEmitter、**React 重渲染**（`setState`→`render`）、**JSX 子组件**（`render`→子组件）、django ORM 描述符。所有合成边的 `provenance:'heuristic'`，并附带 `metadata.synthesizedBy` + `registeredAt`（连线位置），在 `synapse_explore` 的 Flow 部分和 `synapse_node` 调用链中内联呈现。

**原则：部分覆盖比没有覆盖更糟。** 桥接了一个边界却没有桥接下一个，反而暴露了智能体需要深入读取才能完成的跳转。在 excalidraw 上的测量结果：仅加 react-render 合成，读取次数_上升_到 5–7；只有完成整条流程（加入 jsx-child 跳转）才降到 0–1。**务必端到端地闭合流程并重新测量**——绝不发布半桥接的流程。

### 验证方法（每种新语言/框架均为必填）

对每种**语言 × 框架**，在**小型、中型和大型**真实代码库上，用 **≥3 个不同流程提示**分别验证：

1. **选取该框架的典型流程**（"X 如何到达 Y"：state→render、request→handler→view、query→SQL、action→reducer→store……）。
2. **确定性探针**（`scripts/agent-eval/probe-{node,explore}.mjs` 针对已构建的 `dist/`）：`synapse_explore` 以流程的符号名作为输入，能端到端地从 from→to 连通，不出现断裂（其 Flow 部分显示路径）；**节点无爆炸**（`select count(*) from nodes` 在重新索引前后保持稳定）；对合成边的**精度**进行抽查（`select … where provenance='heuristic'`）。
3. **智能体 A/B**（`scripts/agent-eval/run-all.sh <repo> "<Q>"`）：有无 synapse 对比，**每组 ≥2 次运行**（单次运行方差较大——绝不从 n=1 下结论）。记录**耗时、总工具调用次数、Read 次数、Grep 次数**。可通过 block-read hook（`scripts/agent-eval/hook-settings.json`）强制 Read=0 来进行充分性证明（可选）。
   - **模型策略——每个 A/B 组都使用 `--model sonnet --effort high` 运行 Claude。永远如此。绝不用 Opus/Fable。** 所有 `scripts/agent-eval/*.sh` 均以此为默认值（存在 `MODEL`/`EFFORT` 环境变量覆盖——未经维护者明确指示不得提高）。原因有两条，第二条比成本更重要：(a) Sonnet 不会大量消耗 token；(b) **Sonnet 是刻意选择的基准模型**——synapse 的真实用户会将它接入他们已有的任何智能体（Cursor Composer、Gemini 等），所以我们故意在"较弱"的模型上验证：较强的模型的工具使用能力会掩盖较弱模型会暴露的显著性/充分性问题。一个在 Sonnet 上能落地的功能，会向上泛化到每个宿主；只在 Opus/Fable 上才有效的功能，不会向下泛化到大多数用户实际使用的智能体。两组始终使用同一模型。
   - **MCP 挂载是启动延迟问题，不是硬性阻塞。** 在多步骤任务中，智能体会在 synapse 完成约 2–3 秒的启动之前就开始 Read/grep（在已嵌套于 Claude 会话中运行 eval 的情况下，CPU 竞争会更严重），结果完全不使用 synapse。解决方法：**为目标预热一个持久化守护进程**（`SYNAPSE_DAEMON_IDLE_TIMEOUT_MS` 设高；派生 `serve --mcp --path <target> </dev/null &`；等待 `.synapse/daemon.sock`），并**跳过启动重执行**（`SYNAPSE_WASM_RELAUNCHED=1`），使 claude 在智能体第一轮之前完成连接。不要信任 claude 的 `init` 快照——即便它随后成功连接，也可能读取到 `status:"pending"` / 0 工具；应通过 `parse-run.mjs` 的 `by type` 中的实际 synapse 使用情况来判断。要隔离某项变更——**新构建 vs 基线构建，均开启 synapse**（与 run-all.sh 的有无对比不同）——使用 `scripts/agent-eval/ab-new-vs-baseline.sh <indexed-repo> "<task>" [baseline-ref]`（内置了预热）。
4. **通过标准：** 正常流程问题在代码库的 explore 调用预算内达到 **~0 次 Read/Grep**，运行**比无 synapse 时更快**，且在对照代码库上**无回退**。将数据记录在 `docs/design/dynamic-dispatch-coverage-playbook.md`（覆盖矩阵）中。

完整 playbook + 各机制设计：`docs/design/dynamic-dispatch-coverage-playbook.md` 和 `docs/design/callback-edge-synthesis.md`。

### 典型案例——Excalidraw（TS/React，中型，643 个文件）

这是每种语言/框架需要复现的模板。问题：*"更新一个元素后，画布是如何在屏幕上重新渲染的？"*（完整流程跨越三个 React 边界：observer callback、`setState`→`render`、JSX 子组件。）

| 阶段 | 耗时 | Read | Grep | synapse |
|---|---|---|---|---|
| 无 synapse | 115–139s | 9–10 | 10–11 | 0 |
| 有回退（explore 预算回退）| 131–139s | 5–10 | 3–5 | 6–14 |
| 修复后（预算 + 消息 + 合成）| 64–112s | 0–2 | 2–4 | 3–**10** |
| + trace-first 引导 | **51–74s** | **0–2** | 0–4 | **3–4** |

每阶段 n=4 次未挂钩运行，相同提示。将流程问题引导至优先调用 `synapse_trace` 后：**最佳单次运行 0 Read / 0 Grep / 3 synapse / 51s**；**4 次中有 2 次完全干净**（0 Read，0 Grep）。引导消除了过度深入的方差——调用次数从 3–10 收紧到 3–4，trace 采用率从 3/4 升至 4/4，`search`+`callers` 路径重建的徘徊降至 0。单次运行方差仍然存在；报告范围，不要用单次运行。**残余的 Read/Grep 全部来自 nonce 数据流**（`canvasNonce`——一个无图边的局部 prop）；那是 def-use/数据流的前沿，刻意不覆盖（跟踪每个局部变量会导致图爆炸）。已验证：`trace(mutateElement, renderStaticScene)` 跨三个边界以 **6 跳**连通（`mutateElement → triggerUpdate → [callback] triggerRender → [react-render] render → [jsx] StaticCanvas → renderStaticScene`），每跳内联显示源码 + 连线位置；节点数稳定在 9,289；合成边：1 条 callback + 46 条 react-render + 280 条 jsx-render（无爆炸，已精度抽查）。

## 测试

测试位于 `__tests__/`，镜像其所覆盖的模块。除显而易见的测试外，值得关注的有：

- `installer-targets.test.ts` — 覆盖全部 4 个智能体 target 的参数化契约套件（见安装器说明）。
- `evaluation/` — `runner.ts` + `test-cases.ts` 针对合成项目运行 synapse 并评分结果；通过 `npm run eval` 运行（会先构建）。不属于 `npm test`。
- `sqlite-backend.test.ts` — 覆盖原生 + wasm 后端选择和回退。
- `pr19-improvements.test.ts`、`frameworks-integration.test.ts` — 针对特定历史 PR/事故的回归覆盖；不要重命名这些文件，其名称锚定于 git 历史。

测试使用 `fs.mkdtempSync` 创建临时目录，并在 `afterEach` 中清理。它们写入真实文件并使用真实 SQLite——没有数据库 mock。

### Windows 门控测试

因平台而异的行为（路径解析、盘符、`SENSITIVE_PATHS`、`%APPDATA%` 配置目录、CRLF）必须进行门控，而不是假设一致。对 Windows 专属断言使用 `it.runIf(process.platform === 'win32')(...)`，对 POSIX 专属断言使用 `it.runIf(process.platform !== 'win32')(...)`——例如，`/etc` 在 POSIX 上是敏感路径，但在 Windows 上解析为 `C:\etc`（不存在），因此未门控的 `/etc` 断言在 Windows 上会失败。要在 Windows 上真实验证（见下文）；不要合并一个 Windows 门控测试却没有亲眼看到它通过。

## 跨平台验证

开发机器——以及默认的 `npm test` 目标——是 **macOS**，所以本地运行覆盖 macOS 路径。另外两个平台不在这里；当变更涉及平台敏感内容（文件监视、套接字/命名管道、路径和符号链接处理、进程生命周期、inotify 预算）时，要真实验证，而不是猜测。

### Linux（Docker）

需要在 Linux 上测试或验证时，使用 **Docker**——没有 Linux 机器，但 Docker 可在 macOS 宿主上运行。从代码库构建一次性镜像并在其中运行测试套件：

- `FROM node:22-bookworm`；使用含 `.dockerignore`（排除 `node_modules`/`dist`/`.git`/`.synapse`）的 `COPY` 复制代码库；`RUN npm ci && npm run build`。不要复用 Mac 的 `node_modules`——`esbuild`/`rollup` 携带平台专属二进制文件。
- 使用 **`docker run --rm --init`** 运行。`--init` 对任何进程生命周期测试（守护进程回收、#277 PPID 看门狗、空闲超时）都是必要的：没有负责回收僵尸进程的 PID 1，被 SIGKILL/退出的进程会以僵尸状态残留，`process.kill(pid, 0)` 仍会报告其*存活*，导致退出检测断言即便进程已退出也会假失败。
- Linux 是 inotify 监视预算真正会耗尽的地方：通过 `/proc/<pid>/fdinfo/*`（对 `readlink` 为 `anon_inode:inotify` 的 fd，统计其中 `^inotify ` 行数）来计算进程的监视数量。

### Windows（Parallels 虚拟机 + SSH）

对于任何 Windows 专属的 PR、bug 或实现，应在真实的 Windows 虚拟机上验证，而非猜测。连接详情保存在代码库根目录下被 gitignore 的 **`.parallels`** 文件中（虚拟机名称、客户机 IP、SSH 用户/密钥）。`prlctl exec` 需要 Parallels Pro 且不可用，因此 SSH 是唯一通道。

- 从 Mac 宿主连接/运行：`ssh <user>@<guest_ip> "..."`。对于多行操作，通过 stdin 传递 PowerShell，并**先从注册表刷新 PATH**（sshd 会话在 winget 安装后 PATH 已失效）：

```powershell
ssh colby@10.211.55.3 "powershell -NoProfile -ExecutionPolicy Bypass -Command -" <<'PS'
$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
Set-Location C:\dev\synapse
PS
```

- 将代码库克隆到 **Windows 本地**路径（`C:\dev\synapse`）并在那里 `npm ci`——绝不对共享的 Mac 代码库运行 npm，因为 `esbuild`/`rollup` 携带平台专属二进制文件。
- 客户机工具链（winget）：Node LTS、Git 以及 **VC++ ARM64 可再发行组件**（`@rollup/rollup-win32-arm64-msvc` 所需，vitest 会拉取该依赖）。
- 直接从贡献者的 fork 获取 PR head，绕过 `pull/<n>/head` 的延迟：`git fetch <fork-url> <branch>` 再 `git checkout -f FETCH_HEAD`。
- 已知的预先存在的 Windows 失败（它们在 `main` 上可复现，与你的变更无关——在归咎你的 PR 之前先对照 `origin/main` 确认，且不要让它们掩盖新的回退）：`security.test.ts > Session marker symlink resistance > does not follow a pre-planted symlink`（Windows 上创建符号链接需要权限）；以及 `mcp-initialize.test.ts`/`mcp-roots.test.ts` 套件，它们在 `afterEach` 时以 `EPERM` 失败，原因是派生的 `serve --mcp`（其 `--liftoff-only` 重执行的孙进程）仍持有 cwd/SQLite 文件——这是 Windows 文件锁定的特性，不是逻辑 bug。

## 发布

发布至 npm，并在 [GitHub Releases](https://github.com/colbymchenry/synapse/releases) 上同步镜像。`CHANGELOG.md` 是唯一真实来源；GitHub Release 说明从中提取。

### 编写 changelog 条目

**默认：在 `## [Unreleased]` 下编写条目**——该节专门保留用于两次发布之间的工作。**不要预先创建 `## [X.Y.Z]` 块**用于下一个版本：Release workflow 的第一步是 `scripts/prepare-release.mjs`，它会在发布时自动将 `[Unreleased]` 下的所有内容提升为新的 `## [X.Y.Z] - <YYYY-MM-DD>` 块（如果已存在 `[X.Y.Z]` 块则合并进去——但你不需要预先创建它）。预先暂存正是导致 v0.9.5 发布说明稀疏事故的原因：在其余工作落地之前就手动添加了一个稀疏的 `[0.9.5]` 块，提取器选择了它而非上方内容更丰富的 `[Unreleased]` 节。不要这样做。

所有条目（无论位置——`[Unreleased]` 还是其他）的格式规则：

1. **编写面向用户的友好说明，而非面向工程师的说明。** 分组方式：`### New Features` 和 `### Fixes`（句首大写）。仅当版本中有对应内容时，才单独设立 `### Breaking Changes` 和 `### Security` 节；将改进类变更折叠进 New Features。省略空节。（这取代了旧的 Keep-a-Changelog `Added/Changed/Fixed/Removed/Deprecated` 分组：GitHub Release 页面通过 `scripts/extract-release-notes.mjs` **逐字**提取每个版本块，而旧的密集、以实现为中心的条目渲染为难以阅读的文字墙——因此整个 CHANGELOG 已按此格式重写，所有已发布版本的说明也已重新整理。）
2. **每条一句通俗语言的描述：** 变更内容及对用户的意义。以功能开头，或以已修复的症状开头。
3. **去掉内部细节。** 不写内部文件路径（`src/...`）、内部符号/函数/类名、基准数字/百分比/节点或边的计数。**保留：** 语言和框架名称（Go、Spring、NestJS……）、用户会输入或设置的内容（`synapse install`、`synapse_explore`、`SYNAPSE_*` 环境变量）、智能体/IDE 名称（Claude Code、Cursor、opencode、Kiro……），以及贡献者署名时的简短 `Thanks @user`。
4. 条目中的 issue/PR 引用使用编号格式（`(#403)` 等）；GitHub 渲染器会在发布说明中自动将其转为链接。
5. **不要自行添加 `[X.Y.Z]: https://...` 链接引用**——`prepare-release.mjs` 在提升版本时会自动追加（幂等：重复运行是空操作）。

多词标题如 `### New Features` 在正常发布路径上是安全的：`prepare-release.mjs` 的 **Case A** 会将整个 `[Unreleased]` 正文逐字移入 `[X.Y.Z]`。（只有其很少使用的 **Case B** *合并*会用单词正则 `^### (\w+)$` 拆分子节，该正则不匹配多词标题——但 Case B 只在预先创建了 `[X.Y.Z]` 块时才触发，而上面的规则已禁止这样做。）

### 发布流程（由用户执行）

发布版本由 **GitHub Actions "Release" workflow**（`.github/workflows/release.yml`）构建和发布。它运行 `scripts/prepare-release.mjs` 将 `[Unreleased]` 提升为 `[<version>]`（并将该 CHANGELOG 变更自动提交并推送回 `main`，使磁盘上的内容与已发布说明一致），然后为每个平台打包 Node 运行时（`scripts/build-bundle.sh`），并发布 GitHub Release 和 npm 精简安装器（`scripts/pack-npm.sh`：一个 shim 包 + 各平台包）。**手动发布现在是错误的**——直接 `npm publish` 会发布根包（非 bundle 版本），导致 Node < 22.5 的用户无法使用。

**Claude 不得在未明确被要求时自行升级版本号。** 维护者通常自己操作——通常通过 GitHub Web UI 直接编辑 `package.json`。不要在无关工作中主动提交版本升级，也不要在总结 PR 时提议升级。

维护者升级版本时，严格来说只需编辑 `package.json`——workflow 的"Sync package-lock.json"步骤会检测 `package.json` 与 `package-lock.json` 之间的版本不匹配，运行 `npm install --package-lock-only --ignore-scripts` 重写 lock 文件中的版本字段（顶层 + `packages.""`），并以 `[skip ci]` 自动提交并推送回 `main`。因此，在 GitHub Web UI 中单文件编辑 `package.json` 就足以触发一次干净的发布。（如果他们在本地同时编辑了两个文件，也没问题——同步步骤会跳过。）

一旦 `main` 上的 `package.json` 达到目标版本，触发 **Actions → Release → Run workflow**（在 `main` 上）。workflow 会：

1. 如果 `package-lock.json` 与 `package.json` 版本不同步，将其同步；提交并推送该变更。
2. 运行 `prepare-release.mjs <X.Y.Z>` → 在 `CHANGELOG.md` 中将 `[Unreleased]` 提升为 `[X.Y.Z] - <today>`，追加链接引用，以 `[skip ci]` 提交并推送。
3. 在单个 runner 上构建每个平台的 bundle，生成 `SHA256SUMS`。
4. 创建 GitHub Release，说明来自刚刚提升的 `[X.Y.Z]` 块。
5. 发布 npm shim 包和各平台包。需要 `NPM_TOKEN` 仓库密钥。

**不要自行运行 `npm publish`、`git push` 或 `git tag`**——这些是对共享状态的发布操作。写好文件，把命令交给用户执行。

## 工作规范

- `0.7.x` 系列正处于活跃的多智能体推广阶段。任何对 `src/installer/`（尤其是 `targets/`）的变更都需要相应的测试覆盖和 CHANGELOG 条目——安装器回退会悄无声息地破坏每一次新安装。
- 修改 MCP 工具的行为或智能体的使用方式时，编辑 `src/mcp/server-instructions.ts`——它是面向智能体工具指引的**唯一真实来源**（issue #529）。安装器不再向 `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`.cursor/rules/synapse.mdc`/Kiro steering 写入重复的 instructions 块，因此不需要再保持同步。（本仓库自带的 `.cursor/rules/synapse.mdc` 是 dogfooding 配置——如果你在此仓库上使用 Cursor，也一并更新它，但它不会被打包发布。）
- Synapse 提供**代码上下文**，而非产品需求。对于新功能，请向用户询问 UX、边界情况和验收标准——图谱不会告诉你这些。
- **当用户引用 issue、PR 评论或外部报告时，在得出结论前先将其锚定到日期和版本。** 对照以下内容检查评论的 `createdAt`：
  - **最后发布的版本**——`grep -m1 '^## \[' CHANGELOG.md` 显示文件顶部的版本（旧版本在后）。在最新 `## [X.Y.Z] - YYYY-MM-DD` 之前的评论是在反应*已发布*的状态——仅在 `main` 上或未合并分支上的工作对其不适用。
  - **main 的最新提交**——`git log --first-parent main -1 --format='%ai %h %s'`。在最后一次发布之后但在 main 上某个修复之前的评论，可能已在那里解决但尚未发布。
  - **当前分支的最新提交**——你自己的未合并工作显然不可能是评论所反应的内容。
  在同意某个用户报告的问题未被修复（或修复不完整）之前，始终区分"已发布"、"已合并但未发布"和"进行中"。用户对最近 PR 说"你的修复只覆盖了 X"，通常是在指向*已发布版本*的不足——你正在进行的分支可能已经解决了这些问题，但对方无从得知。
- **为 `README.md` 中引用的每张图片标注版本标签。** GitHub 会缓存 README 图片（`raw.githubusercontent.com` 有 5 分钟 TTL；第三方托管的图片经过长效缓存的 camo 代理），因此原地更新资源可能持续显示旧版本。为每个 README 图片 URL 添加 `?v=N` 查询标签，并在**同一次提交中修改资源字节时同步递增 `N`**——例如 `assets/waitlist.svg?v=2`。修改后的 URL 会绕过所有缓存，让新图片立即生效，而无需等待 TTL 到期。
