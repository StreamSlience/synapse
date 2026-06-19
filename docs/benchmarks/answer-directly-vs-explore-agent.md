# 直接回答 vs. 委派给 Explore agent（交互式 A/B 对比）

**问题：** 在主会话中直接使用 Synapse 回答"X 是如何工作的？"类问题，是否会导致主会话上下文膨胀——将探索任务委派给一次性 **Explore agent**（通过子转录吸收文件读取，使主上下文保持精简）效果是否更好？更关键的问题是：**这个结论在更大规模的代码库上是否会改变**？

**简短结论：** 不会。使用 Synapse 后，主会话上下文大致**与规模无关（约 50k）**，因为检索是精准且有预算上限的——在大 16 倍的代码库上不会膨胀。**在任何规模下**，直接回答都胜出：主上下文与委派路径持平甚至更精简，**零次文件读取**，token 用量减少约 28%。即使在大型代码库上，"为了整洁而委派"的优势也仍然微乎其微。

## 方法论

- **测试工具：** 通过 `scripts/agent-eval/itrun.sh`（tmux）驱动的交互式 Claude Code TUI，**非**无头模式 `claude -p`。这一点很重要：无头模式会派生 **0** 个 Explore agent，因此完全无法衡量委派行为；只有交互式 TUI 才可以。
- **对照组：** `WITH` = MCP 配置中包含 Synapse；`WITHOUT` = 空 MCP 配置（`--strict-mcp-config`）。
- **模型：** `opus`。**每组 n = 3 次运行。** 解析主 agent 和子 agent 转录（`scripts/agent-eval/parse-session.mjs`）；主 agent + 子 agent 的读取次数求和。
- **代码库：** Excalidraw（643 个文件，中型）和 VS Code（约 10.7k 个文件，大型——约为 Excalidraw 的 16 倍）。
- **构建版本：** 0.9.4。**日期：** 2026-05-24。
- "主会话上下文"是 TUI 中主线程报告的 `Context X/Y`（子 agent 上下文不计入）。"计费 token"= 每轮 assistant 用量之和（input + output + cache read + cache creation）。

## Excalidraw（643 个文件，中型）

问题：*"Excalidraw 如何渲染和更新画布元素？"*

| 指标 | 有 Synapse | 无 Synapse |
|---|---|---|
| 派生的 Explore agent 数量 | 0 / 0 / 0 | 0 / 1 / 1（3 次中委派了 2 次）|
| 主会话上下文 | 51k / 49k / 50k（约 50k）| 48k / 34k / 26k（约 36k）|
| 总工具调用次数 | 4 / 4 / 4 | 16 / 55 / 37 |
| 文件读取次数（主 + 子）| 0 / 0 / 0 | 6 / 25 / 16 |
| 计费 token | 约 127k | 约 175k |

## VS Code（约 10.7k 个文件，大型——约为 Excalidraw 的 16 倍）

问题：*"扩展宿主如何与主进程通信？"*

| 指标 | 有 Synapse | 无 Synapse |
|---|---|---|
| 主会话上下文 | 47k / 43k / 50k（约 47k）| 54k / 29k / 31k（约 38k）|
| Explore agent 数量 | 0 / 0 / 0 | 0 / 1 / 1（3 次中委派了 2 次）|
| synapse 调用次数 | 约 8 次（search + explore×2–3 + context）| 0 |
| 文件读取次数（主 + 子）| 0 / 1 / 0 | 6 / 26 / 19 |
| 计费 token | 约 126k | 约 176k |

## 发现

**使用 Synapse 后，主会话上下文与规模无关。** 有 Synapse 时，VS Code 的主会话上下文为 **约 47k——与 Excalidraw 的约 50k 基本相同**，尽管代码库大了 16 倍，上下文并未膨胀。原因：synapse 的 `explore` 输出有**预算上限**，且检索是**精准的**——回答一个问题只拉取相关的*流程/区域*，不会因为代码库更大就拉取更多。因此 Synapse 使主会话上下文大致与规模无关（约 50k）。即使在大型代码库上，"为了整洁而委派"的优势也仍然微乎其微——与"规模越大越有用"的预期恰恰相反。

*真正*会随规模膨胀的是直接把大文件读入主会话——没有 Synapse 时，Claude Code 通过委派给 Explore agent 来规避这个问题（主会话 29–31k），但代价是 **17–26 次文件读取**以及约 28% 的额外 token。Synapse 以*更好*的方式保持主会话精简：有上限的精准输出——无需委派，**0 次文件读取**。

**关于"Explore agent 使用 Synapse"的说法。** 无法复现：在**全部 6 次**有 Synapse 的运行中（两个代码库），Claude Code **从未委派**——每次都直接回答。Explore agent 路径只出现在 `without` 组（使用 grep/read，因为该配置中没有 Synapse）。因此，在当前指引 + Synapse 存在的情况下，Claude Code 始终停留在主会话——"通过 Explore agent 保持主会话精简"的最优情形在实践中并不会发生；实际发生的是"通过有上限的 Synapse 保持主会话精简"，而且成本更低。

## 结论

**"使用 Synapse 直接回答"对 Claude Code 而言同样是最优策略——在任何规模下皆如此。** 无需按 agent 拆分；统一的"直接回答"指令对 Claude Code、Codex、Cursor 和 opencode 都是正确的（后三者没有 Explore agent 机制，否则会直接读取文件）。这一结论驱动了 README 中 `## Synapse` 示例块的更新——该块此前告知 agent "永远不要直接调用 `synapse_explore` / 始终派生一个 Explore agent"，也就是说，它将 Claude Code 引向了*更差*的路径（17–26 次读取，约多 28% 的 token）。

**注意事项 / 后续工作（非阻塞）：** 一个*自身也使用 Synapse* 的 Explore agent 原则上可以同时实现精简主会话和低工作量。但"直接回答"指令在实践中阻止了委派（6 次运行中委派次数为 0），主上下文的收益也很有限（约 50k → 约 30k，均为 1M 窗口的几个百分点），且会额外增加子 agent 往返延迟。值得未来探索，不应作为默认行为。
