# 让智能体真正使用 synapse（而非 Read）——设计笔记与交接

> 新会话工作文档。需要解决两个问题：
> **(P1)** 智能体在实现过程中仍然使用 `Read`/`grep` 而非 synapse；
> **(P2)** 启动时 synapse MCP 服务器可能处于 `pending` 状态，导致智能体在第一轮时完全没有 synapse。
>
> 先阅读 `synapse/CLAUDE.md` → "检索性能与动态分发覆盖"——那里是这些思路必须遵守的原则。

---

## 上下文——已发布内容（避免重复）

- **#733（`7175dc4`）** — 重构了面向智能体的引导（`src/mcp/server-instructions.ts` + `src/mcp/tools.ts` 中的 `synapse_node`/`synapse_explore` 描述），使其覆盖*实现*，而不仅是问答；并添加了**文件视图模式**：`synapse_node` 现在接受裸 `file`（无 `symbol`）→ 返回该文件的符号映射 + 其依赖项（影响半径）+ 逐字体（`includeCode`）。`handleFileView` 位于 `src/mcp/tools.ts`。
- **干净的 A/B 结果**（新构建 vs 基线构建，均连接 synapse，相同的完整实现任务——向 `synapse_search` 添加 `kindExclude`）：
  - **基线：** 0 次 synapse 调用，8 次 Read（智能体*忽略*了可用的 synapse）。
  - **新：** 2 次 `synapse_explore` 调用，5 次 Read。
  - 所以重构*确实*改变了工具选择——但智能体使用了 `synapse_explore`，**从未使用文件视图**，仍然 Read 了 5 次。n=1/组。
- **评估框架修复**（`#735`）：嵌套附加是*启动延迟*问题，而非硬性阻塞。`scripts/agent-eval/ab-new-vs-baseline.sh` 现在预热守护进程 + 跳过重执行；使用它（非嵌套运行以获得最干净的结果）。

**原则约束（来自 CLAUDE.md——不要重新争论）：**

- *让工具适应智能体。* 修改工具描述 / `server-instructions.ts` 是**低显著性**的，之前*出现过回退*。仅靠措辞不能可靠地改变工具选择。
- *新工具的效果比扩展现有工具更差*（智能体对 `trace` 的选用率也不够；`synapse_context` 已被移除）。
- 历史上真正有效的杠杆：**覆盖**（更多流程静态连接 → `explore` 呈现它们）和**充分性**（输出完整到让智能体*停止*阅读）。
- 优化目标是**挂钟时间 + 工具调用次数 + Read=0**，而非 token 成本（成本降低是副作用）。

---

## P1——智能体在实现过程中使用 synapse 不足

### 状态——2026-06-08（已通过 Read 等价方案解决，而非钩子）

**修复方案：让 `synapse_node` 读取文件的方式与 Read 工具*完全一致*，但更快——从而让智能体自然地使用它。无需强制。** 维护者明确了方向：*"synapse 应该能像 Read 工具一样读取文件……让它和 Read 一样好。Read 又慢又老；查询索引更快。你一直在偏离使用 synapse，而不是追求修复。"*

**已完成——`handleFileView`（`src/mcp/tools.ts`）现在与 Read 完全等价：**

- 不带 `symbol` 的 `file` 以与 Read **完全相同的字节格式返回文件当前源码——`<n>\t<line>`，无填充，保留末尾空行**（通过同时用两者读取同一文件并 diff 验证）。唯一的新增是一行**影响半径标头**（`used by N files: …`）。
- **`offset` / `limit` 与 Read 上的含义完全相同**（从 1 开始；最大行数；默认整个文件，上限 2000 行，与 Read 相同）。大文件诚实分页（`(lines X–Y of N — pass offset/limit…)`），绝不截断到 15k。
- 内容是**默认项**（无需 `includeCode`）；`symbolsOnly: true` 返回廉价的结构映射。安全性保留：`yaml`/`properties` 按键摘要，不直接输出（#383）；通过 `validatePathWithinRoot` 读取（#527）。
- 测试：`__tests__/node-file-view.test.ts`（9 个，含严格格式等价性 `^1000\t  const v998 = 998;` 和无填充 `^1\timport …`）。完整套件通过（1270 个）。描述 / `server-instructions.ts` / CHANGELOG 重构：" 用 synapse_node 代替 Read 读取源文件——字节相同，更快。"

**钩子（方案 1）——A/B 测试后已**拒绝**。请勿发布。** 仅作为评估产物保留（`scripts/agent-eval/redirect-read-hook.sh` + `ab-hook.sh`）。

- 干净 A/B（2 次/组，devpit "添加 `dp ping`，构建它"；两组均连接 synapse）：
  - **无钩子：** 0 次 synapse 调用，1 次 Read，**5–7 次工具调用，6–8 轮，55–77s。**（复现了 P1：智能体忽略 synapse——但"读一次再编辑"在这里*是高效的*。）
  - **有钩子（拒绝重定向）：** 0 次*成功* Read + 1 次文件视图调用（等价方案有效，编辑已编译），但**8–9 次工具调用，9–10 轮，200–239s**，智能体**对拒绝发起反击**——`ToolSearch` 查找工具，反射性重 Read（被拒），然后用 **`Bash python3` 绕过拦截读取文件**。
  - 结论：全面 Read 拒绝**在简单编辑上会使目标指标回退（约 2 倍工具调用、更多轮次）**，且智能体会绕过它。强制是错误的杠杆；让工具真正优于 Read 才是正确的。
- 若将来重新考虑路由：不要用全面钩子。要么使用窄触发（仅限大文件 / N 次 Read 后）**并在 Read 密集的多文件任务上做干净 A/B**（钩子的最佳情况，未经测试），要么继续扩大覆盖 + 充分性。

---

**症状：** 即使连接了 synapse + 新引导，智能体在实现中途仍会反射性地 `Read`/`grep`，从不主动使用文件视图。描述无法修复这一点（低显著性壁垒）。

### 方案排序（按预期杠杆）

1. **PreToolUse(Read/Grep) 钩子，重定向到 synapse** — *杠杆最大；唯一真正能改变行为的渠道。*
   - Claude Code **钩子**可以拦截工具调用并注入上下文或拦截——不同于描述，这*不是*低显著性的。我们已有 `scripts/agent-eval/block-read-hook.sh` + `hook-settings.json`（评估中用于强制 Read=0）。
   - 发布一个**推荐（可选）钩子**：对已*索引*路径的 `Read`（或 `Grep`），注入"此文件已索引——`synapse_node {file}` 以更少 token 返回它及其影响半径；将其输出视为已 Read。"软提示（不硬拦截，否则会让未索引配置/文档的用户感到受挫）。
   - 安装器（`src/installer/targets/claude.ts`）可以在安装时提供添加此钩子的选项（可选，类似自动允许权限）。
   - **通过 `ab-new-vs-baseline.sh` 验证**（Read 次数，有钩子 vs 无钩子）。这是最可能产生效果的实验。
   - 待解问题：如何从钩子内部判断路径是否已索引（查询 `synapse files`/`status`，或快速本地检查 `.synapse`）；避免非索引文件的噪声；各语言的假正例。

2. **充分性：让文件视图成为显而易见的 Read 替代品，使智能体*主动*选用它。**
   - A/B 显示智能体从未将 `file` 传给 `synapse_node`。为什么？它不会联想到"读这个文件" → "synapse_node file=X"。深入调查：文件视图的价值（符号 + 依赖项 + 体）对智能体的下一步（`Edit`）是否*真的优于 Read*？它返回体——但是否返回了足够的周围上下文以便有把握地 `Edit`？如果没有，智能体还是会 Read。
   - 思考：当智能体*确实* Read 了一个已索引文件时，有没有办法让 synapse 之前的 `explore`/`node` 输出*早已*给了它所需的内容？（即修复上游充分性，而不是 Read 本身。）

3. **覆盖——持久性杠杆。** 每一个静态连接的流程都是智能体无需阅读文件来重建的。继续闭合动态分发空洞（`src/resolution/`）。与其"停止阅读"，不如"根本不需要阅读"。

4. **命名 / 可见性实验（置信度低，成本低）。** 文件视图隐藏在 `synapse_node` 内部。专用的、名称明显的入口可能被选用更多——但"新工具效果更差"，所以这可能不行。如果尝试，请 A/B；不要臆测。

**建议：** 先实现**方案 1（Read 重定向钩子）**并 A/B 测试。这是真正有机会改变行为的杠杆。其他一切都是渐进式改进。

---

## P2——因启动时服务器处于 `pending` 状态，智能体在没有 synapse 的情况下运行

**症状：** `serve --mcp` 在智能体第一轮触发时尚未就绪（宿主将 MCP 服务器标记为 `status:"pending"` / 0 个工具），导致智能体开始 Read/grep 后再也不使用 synapse。在嵌套评估中这一问题非常明显（约 2–3s 启动时间 vs 智能体第一轮）；**真实用户也会遇到较轻微的版本**——会话的第一次查询可能没有 synapse。

### 根本原因

`serve --mcp` 在工具可用前会做一次 `--liftoff-only` **重执行**（用于 node 内存标志），**并**派生/绑定一个脱离的**守护进程**。在高负载下会超出宿主的 MCP 启动窗口。（`SYNAPSE_WASM_RELAUNCHED=1` 跳过重执行；预热守护进程消除绑定延迟——两者均在 `ab-new-vs-baseline.sh` 中得到验证。但真实用户无法预热。）

### 方案排序

1. **SYNAPSE 侧——立即暴露静态工具列表，与守护进程解耦。*最大的可发布改进；对所有用户有帮助。***
   - 假设：宿主将 synapse 标记为 `pending` 是因为 `tools/list`（工具暴露）等待守护进程连接。本地握手已经能快速回答 `initialize`（约 107ms；`src/mcp/proxy.ts` 中的 `runLocalHandshakeProxy`，`getStaticTools` 在那里被导入）。**调查：`serve --mcp` 是否*本地且立即*从 `getStaticTools` 回答 `tools/list`，还是转发给仍在连接的守护进程？** 如果是后者，则解耦：客户端一请求就立即广播静态工具，标记为已连接，并在后台完成守护进程解析，仅用于实际的工具*调用*。
   - 验证方式：`printf '<initialize>\n<initialized>\n<tools/list>\n' | node dist/bin/synapse.js serve --mcp --path <repo>`，计时 `tools/list` 响应，对比守护进程模式与进程内模式。进程内约 165ms；守护进程模式是疑点。
   - 如果此方案落地，启动时的 `pending` 问题基本消失，无需宿主侧改动。

2. **SYNAPSE 侧——加快/跳过 MCP serve 路径上的重执行。** 重执行是为了 V8 内存标志（`src/extraction/wasm-runtime-flags.ts`，`RELAUNCH_GUARD_ENV = SYNAPSE_WASM_RELAUNCHED`）。对于普通代码库上的 MCP 服务，该标志可能不必要，或可在不做完整进程重执行的情况下设置。从冷启动路径中去掉一个进程 spawn 可缩短启动窗口。

3. **SYNAPSE 侧——预热守护进程的 SessionStart 钩子。** 提供一个可选的 Claude Code `SessionStart` 钩子（安装器添加），在会话开始时为项目 spawn/预热守护进程，使其在第一次查询前已绑定。方案 1 难以实现时的缓解措施。

4. **宿主侧——"等待/重试 pending"——这是你问到的内容，但这是 Claude Code（MCP 客户端）的行为，不是 synapse 能修复的。** synapse 无法让智能体重试。选项：(a) 将其作为 MCP 客户端改进提给 Anthropic（配置的 MCP 服务器完成连接前不让智能体第一轮开始，或重试 `pending` 服务器）；(b) 注意 `MCP_TIMEOUT` 存在，但对此**没有帮助**，因为问题是*工具暴露时机*，而非连接超时。将此作为请求提出，并依赖方案 1–3 中我们能控制的部分。

**建议：** 追求**方案 1**（解耦 `tools/list` 与守护进程）。这是让 synapse 对所有人"立即连接"的修复。同时作为廉价缓解措施并行发布**方案 3**（预热 SessionStart 钩子）。提交宿主侧请求（4）但不依赖它。

---

## 关键文件 / 指引

- **引导 / 工具：** `src/mcp/server-instructions.ts`（`initialize` 指令——唯一真实来源），`src/mcp/tools.ts`（工具描述 + 处理器；`handleNode`/`handleFileView`/`handleSearch`，`getStaticTools`）。
- **启动 / 守护进程 / 代理：** `src/mcp/proxy.ts`（`runProxy`、`connectWithHello`、`runLocalHandshakeProxy`、PPID 看门狗），`src/mcp/index.ts`（`runProxyWithLocalHandshake`、`spawnDetachedDaemon`），`src/mcp/daemon.ts`。
- **运行时标志：** `src/extraction/wasm-runtime-flags.ts`（`RELAUNCH_GUARD_ENV=SYNAPSE_WASM_RELAUNCHED`，`HOST_PPID_ENV=SYNAPSE_HOST_PPID`）。
- **钩子（现有）：** `scripts/agent-eval/block-read-hook.sh`，`scripts/agent-eval/hook-settings.json`（评估的强制 Read=0 钩子——P1 重定向钩子的基础）。
- **安装器（添加推荐钩子的位置）：** `src/installer/targets/claude.ts`。
- **评估框架：** `scripts/agent-eval/ab-new-vs-baseline.sh`（新 vs 基线，已内置预热），`run-all.sh`（有 vs 无 synapse），`parse-run.mjs`（按类型统计工具；`synapse tools exposed: 0` + 0 次 synapse 调用 = 未使用 synapse 运行）。
- **原则：** `CLAUDE.md` → "检索性能与动态分发覆盖" + "验证方法"下的智能体评估说明。

## 如何验证

- **P1（Read 置换）：** `bash scripts/agent-eval/ab-new-vs-baseline.sh <indexed-repo> "<实现任务>" [baseline-ref]` — 对比 `Read` vs `mcp__synapse__*` 计数。≥2 次/组（n=1 噪声大）。非嵌套运行以获得最干净的结果。使用*真正的新*功能任务（确认它尚未实现——第一次 A/B 尝试因任务已实现的 `--quiet` 而浪费了一次运行）。
- **P2（启动）：** 对 `serve --mcp` 的 `tools/list` 计时（见上）；统计冷启动中 `init` 显示 `connected` + tools > 0 的次数。不要信任单次 `pending` init 快照——通过智能体是否实际调用了 synapse 来判断。

## 约束 / 注意事项

- 描述/指令是低显著性的——**对每个行为声明做 A/B**，不要凭信念发布措辞。
- 新工具 < 扩展现有工具。
- 宿主的 `init` 快照可能显示 `pending`，即便服务器随后成功连接——以实际使用情况为准。
- 非预热的嵌套评估数据不可用于"干净"数字；即便预热了，真实终端也更好。

## 新会话建议启动顺序

1. **P2 方案 1** — 验证 `serve --mcp` 是否本地/即时回答 `tools/list`；如果不是，将其与守护进程解耦。（价值最高，可发布，对所有用户有帮助，无行为猜测。）
2. **P1 方案 1** — 原型化 PreToolUse(Read) 重定向钩子；A/B 测试它。（价值最高的行为杠杆。）
3. 发布 P2 SessionStart 预热钩子作为缓解措施；提交宿主侧等待/重试请求。
