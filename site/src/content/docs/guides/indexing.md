---
title: 索引项目
description: 全量索引、增量同步和文件监听器。
---

## 初始化与索引

```bash
cd your-project
synapse init -i      # 初始化 + 全量索引
```

`init` 会创建 `.synapse/` 目录；`-i`/`--index` 会立即构建索引。如需先初始化后再索引，可省略该标志，稍后运行 `synapse index`。

## 全量 vs. 增量

```bash
synapse index           # 全量索引整个项目
synapse index --force   # 从头开始重新索引
synapse sync            # 增量——只处理变更的文件
```

`sync` 速度快，因为它只重新解析发生变更的文件。在切换分支或批量编辑后使用。

## 自动保持最新

**在 agent 会话期间，无需手动运行 `synapse sync`。** 当 agent（Claude Code、Cursor、Codex、opencode、Hermes、Gemini、Antigravity、Kiro）启动 `synapse serve --mcp` 时，三个机制协同工作，确保索引与代码同步——并确保在编辑与下次同步之间的短暂窗口内，agent 不会静默地获取到错误答案。

### 1. 带防抖的自动同步文件监听器（始终启用）

`serve --mcp` 会启动一个原生文件监听器（macOS 上是 FSEvents，Linux 上是 inotify，Windows 上是 ReadDirectoryChangesW）来监听项目根目录。每次源文件的创建、修改或删除都会被捕获。防抖计时器会将短时间内的大量编辑合并为一次同步。

```
agent 写入 src/Widget.ts
  → 监听器触发（事件送达通常 <100ms）
  → 2000ms 防抖
  → 同步执行；Widget.ts 的节点和边进入索引
  → 下一次 agent 查询即可看到更新
```

**可调节**：`SYNAPSE_WATCH_DEBOUNCE_MS` 可覆盖默认的 2000ms，范围限制在 `[100ms, 60s]`。当构建步骤或格式化工具在短时间内写入大量文件时，可将其调大到 `5000` 或 `10000`，让监听器将多次变更合并为一次同步。

### 2. 逐文件过期提示——覆盖防抖窗口

监听器的防抖会引入一个短暂窗口（通常 2 秒），此时文件已在磁盘上修改但尚未被索引。Synapse 通过逐文件过期提示来覆盖这个窗口：如果某个 MCP 工具响应会引用当前正等待重新索引的文件，响应前会加上一个 `⚠️` 提示，列出过期的文件名：

```
⚠️ Some files referenced below were edited since the last index sync —
their synapse entries may be stale:
  - src/Widget.ts (edited 800ms ago, pending sync)
For accurate content of those specific files, Read them directly.
The rest of this response is fresh.

## Code Context
…
```

agent 读到这条提示后，会对指定文件直接执行 `Read`——在 Claude Code 上已端到端验证，agent 会明确说"直接读取文件以获取最新内容"然后打开该文件。因此即使在 2 秒的防抖窗口内，agent 也不会静默地获取到错误答案。

响应中**未**引用的等待中文件会以一个小尾注方式显示（`(Note: N file(s) elsewhere in this project are pending index sync but were not referenced above: …)`）。无论哪种方式，信号都是显式的。

### 3. 连接时补偿同步——覆盖 MCP 服务器未运行期间的变更

当编辑器 / agent（重新）连接到 MCP 服务器时，Synapse 会在响应第一个查询之前执行一次快速的文件系统核对（先用 `(size, mtime)` 进行预过滤，再对其余文件做内容哈希对比）。因此，在没有 MCP 服务器运行期间发生的文件变更——终端中的 `git pull`、其他编辑器的修改、已退出的 agent 所做的改动——都会在下次会话的第一次工具调用时自动补偿同步。

### 验证监听器看到的内容

`synapse_status` 将等待中的文件集作为一等公民暴露出来——让 agent 通过一次调用就能判断"索引是否已同步"：

```
synapse_status →
  ## Synapse Status
  …
  ### Pending sync:
  - src/Widget.ts (edited 1200ms ago)
```

如果响应中没有 `### Pending sync:`，则说明没有任何待处理的同步。

### 何时需要手动运行 `synapse sync`

几乎不需要。边缘情况如下：

- **监听器被禁用。** 沙箱环境限制了本地文件监听器，或者你设置了 `SYNAPSE_NO_DAEMON=1` 以退出共享守护进程模式。此时 `synapse sync` 是手动替代方案。
- **CI 运行前的预检。** 如果你在 agent 会话之外通过脚本使用索引，在脚本开头执行一次 `synapse sync` 可确保索引反映当前工作树的状态。

除此之外：直接使用即可。监听器 + 过期提示 + 连接同步已端到端覆盖了 AI 辅助工作流。如果你发现文件在防抖窗口过后仍未被同步，那是一个 bug——请提交附有复现步骤的 issue。

> 参见 v0.9.5 版本发布说明中的[过期提示 (#403)](https://github.com/colbymchenry/synapse/releases/tag/v0.9.5)和连接时补偿同步 (#414)；两者同时发布。

## 检查状态

```bash
synapse status
```

报告节点/边/文件数量、当前 SQLite 后端和日志模式。在 agent 会话中，MCP 端的 `synapse_status` 还会额外显示上文描述的 `### Pending sync:` 块。

## 哪些内容会被索引

扩展名映射到[支持语言](/synapse/reference/languages/)的所有文件，减去默认排除的依赖/构建目录（`node_modules`、`vendor`、`dist` 等）、`.gitignore` 排除的内容，以及超过 1 MB 的文件。参见[配置](/synapse/getting-started/configuration/)。
