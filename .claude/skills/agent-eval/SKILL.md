---
name: agent-eval
description: 通过对比 agent 在有/无 Synapse 两种情况下的行为，对真实代码库上的 Synapse 检索质量进行基准测试。当用户运行 /agent-eval 或要求测试、基准测试、审计或验证某个 synapse 版本（本地开发构建或已发布的 npm 版本）在某种语言仓库上的表现时使用。
---

# Synapse 质量审计

测量 Synapse 对比纯 grep/read 方案对 agent 的提升幅度，针对所选 synapse 版本在所选真实仓库上进行测量。驱动 `scripts/agent-eval/` 中的测试框架。

## 前置条件
- 需要 `tmux` 3+、已登录的 `claude` CLI、`node`、`git`（macOS/Linux）。
- 在 synapse 仓库根目录下运行。

## 工作流程

复制此检查清单：
```
- [ ] 1. 选择版本（本地或 npm）
- [ ] 2. 选择语言
- [ ] 3. 按规模选择仓库
- [ ] 4. 选择测试框架（无界面 / tmux / 两者）
- [ ] 5. 在后台运行 audit.sh
- [ ] 6. 汇报结果
```

**第 1 步 — 版本。** 通过 `AskUserQuestion` 询问：要测试哪个 synapse 版本。提供"本地开发构建"和"最新发布版本"两个选项；自由输入的"其他"允许用户输入具体版本（例如 `0.7.10`）。将答案映射为 VERSION token：
- "本地开发构建" → `local`
- "最新发布版本" → `latest`
- 用户输入的版本号 → 该字符串（例如 `0.7.10`）

**第 2 步 — 语言。** 读取 `.claude/skills/agent-eval/corpus.json`。通过 `AskUserQuestion` 询问要测试哪种语言，列出其中有条目的语言。

**第 3 步 — 仓库。** 从所选语言的条目中，询问选择哪个仓库。每个选项标注其规模和文件数，例如 `excalidraw — Medium（约 600 个文件）`。每个条目包含 `repo` URL 和一个有代表性的 `question`。

**第 4 步 — 测试框架。** 通过 `AskUserQuestion` 询问使用哪种框架，并将答案映射为 MODE token：
- "无界面" → `headless` — 使用 stream-json 的 `claude -p`：精确的 token/成本统计和干净的工具调用序列（2 次运行，速度快，无 TTY）。
- "交互式（tmux）" → `tmux` — 在 tmux 中驱动真实的 Claude TUI：忠实呈现 Explore 子 agent 行为，从会话日志获取指标（2 次运行，速度较慢）。
- "两者都用" → `all` — 无界面 + 交互式（4 次运行）。

**第 5 步 — 运行。** 在后台启动（设置版本、如有必要则克隆仓库、清空并重新建索引、运行所选 arm——需要数分钟）：
```bash
scripts/agent-eval/audit.sh <VERSION> <repo-name> <repo-url> "<question>" <MODE>
```

**第 6 步 — 汇报。** 任务完成后，读取日志并按 arm 汇报：
- 无界面（`parse-run.mjs`）：总工具调用次数、文件 `Read` 次数、Grep/Bash 次数、synapse 工具调用次数、耗时、**总成本**。
- 交互式（`parse-session.mjs`）：`VERDICT: synapse_explore used Nx | Read N | Grep/Bash N` 和 `TOKENS:` 行。

以成本 + 工具/Read 次数为重点——它们是可靠的信号；原始 token 输入/输出受子 agent 委托和提示缓存的干扰较大。说明 synapse 是否降低了工作量，以及两个 arm 是否都得到了正确答案。

## 注意事项
- 每次运行都会重新构建索引（`audit.sh` 会清空 `.synapse`）——不同版本的提取方式不同，因此索引必须由构建它的同一个二进制文件提供服务。
- `audit.sh` 会临时修改全局 `synapse` 安装用于测试，然后通过 `local-install.sh` 恢复开发链接。
- 语料库仓库克隆到 `/tmp/synapse-corpus`（已存在则复用）。
- 在 `corpus.json` 中添加或编辑仓库（字段：`name`、`repo`、`size`、`files`、`question`）。
