/**
 * 安装器写入各智能体 instructions 文件（CLAUDE.md / AGENTS.md / GEMINI.md）
 * 的标记围栏式智能体指令块。
 *
 * 历史背景：#529 之前，安装器在此处写入了完整的使用说明手册，这与主智能体的
 * MCP `initialize` 指令重复，因此被移除，`mcp/server-instructions.ts` 成为
 * 唯一真实来源。#704 时一个小得多的块重新加入，原因是 MCP 指令无法触达
 * instructions 文件能覆盖的两类受众：
 *
 *  - **Task-tool 子智能体** — 它们在上下文中接收项目 instructions 文件，
 *    但不接收 MCP initialize 指令。它们仅以延迟名称持有 synapse MCP 工具，
 *    很少主动加载：在强制委托的流程问题（excalidraw，sonnet，high effort）上
 *    实测，没有此块时子智能体在约 9 次运行中只有 1 次加载并使用了 synapse，
 *    而有此块时则稳定使用——包括零 Read/grep 回退的运行。
 *  - **非 MCP 运行环境** — 完全没有 MCP 客户端的智能体仍然可以运行
 *    `synapse explore` / `synapse node` CLI，其输出与 MCP 工具相同。
 *
 * 保持此块简短。主智能体每轮都会在服务器指令之上读取它——#529 的重复成本
 * 论述依然限制其体积。仅包含命令名和两个入口，别无其他。
 */

/** 标记式章节写入/删除所用的边界标记。 */
export const SYNAPSE_SECTION_START = '<!-- SYNAPSE_START -->';
export const SYNAPSE_SECTION_END = '<!-- SYNAPSE_END -->';

/**
 * 完整块内容，包含边界标记，与写入磁盘时完全一致。
 *
 * 措辞故意使用条件句（"在由 Synapse 索引的仓库中……"）：
 * 全局安装会将此内容写入用户范围文件（~/.claude/CLAUDE.md、
 * ~/.codex/AGENTS.md），该文件适用于用户打开的每个项目——
 * 包括未索引的项目，在那里一个绝对化的"此仓库已索引"声明
 * 会让子智能体陷入失败的 synapse 调用（这正是未索引会话策略
 * 所要防止的噪声）。
 */
export const SYNAPSE_INSTRUCTIONS_BLOCK = `${SYNAPSE_SECTION_START}
## Synapse

在由 Synapse 索引的仓库中（仓库根目录存在 \`.synapse/\` 目录），需要理解或定位代码时，请优先使用 Synapse，而非 grep/find 或直接读取文件：

- **MCP 工具**（可用时）：\`synapse_explore\` 一次调用即可回答大多数代码问题——返回相关符号的完整源码及其调用路径。\`synapse_node\` 返回单个符号的源码及其调用者/被调用者，或带行号读取整个文件。若工具已列出但处于延迟加载状态，请通过工具搜索按名称加载。
- **Shell**（始终可用）：\`synapse explore "<符号名或问题>"\` 和 \`synapse node <符号或文件>\` 输出相同结果。

若不存在 \`.synapse/\` 目录，请完全跳过 Synapse——是否建立索引由用户决定。
${SYNAPSE_SECTION_END}`;
