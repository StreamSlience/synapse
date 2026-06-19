---
title: 安装
description: 安装 Synapse 并配置你的 AI 编程 agent。
---

## 1. 运行安装器

```bash
npx @colbymchenry/synapse
```

安装器会：

- 询问要配置哪些 agent——自动检测已安装的 **Claude Code**、**Cursor**、**Codex CLI**、**opencode**、**Hermes Agent**、**Gemini CLI**、**Antigravity IDE** 和 **Kiro**。
- 提示是否将 `synapse` 安装到 `PATH`（以便 agent 能启动 MCP 服务器）。
- 询问配置是应用于所有项目还是仅限当前项目。
- 为每个选中的 agent 写入 MCP 服务器配置和说明文件（如 `CLAUDE.md`、`.cursor/rules/synapse.mdc`、`~/.codex/AGENTS.md`）。
- 当 Claude Code 是目标之一时，设置自动授权权限。
- 初始化当前项目（仅限本地安装）。

## 非交互模式（脚本 / CI）

```bash
synapse install --yes                              # 自动检测 agent，全局安装
synapse install --target=cursor,claude --yes       # 指定目标列表
synapse install --target=auto --location=local     # 检测到的 agent，项目本地安装
synapse install --print-config codex               # 打印配置片段，不写入文件
```

| 标志 | 可选值 | 默认值 |
|---|---|---|
| `--target` | `auto`、`all`、`none` 或逗号分隔列表（`claude,cursor,…`） | 交互提示 |
| `--location` | `global`、`local` | 交互提示 |
| `--yes` | （布尔值） | 逐步提示 |
| `--no-permissions` | （布尔值）跳过 Claude 自动授权列表 | 权限开启 |
| `--print-config <id>` | 输出指定 agent 的配置片段并退出 | — |

## 2. 重启你的 agent

重启你的 agent（Claude Code / Cursor / Codex CLI / opencode / Hermes Agent / Gemini CLI / Antigravity IDE / Kiro），以使 MCP 服务器生效。

## 3. 初始化项目

```bash
cd your-project
synapse init -i
```

此步骤会构建每个项目的知识图谱索引，并接入项目本地的 agent 配置，因此一次全局 `synapse install` 即可在你打开的每个项目中生效。

## 支持的平台

每个版本都为全部三种桌面操作系统、x64 和 arm64 两种架构提供自包含构建（内置 Node runtime，无需编译）：

| 平台 | 架构 | 安装方式 |
|---|---|---|
| Windows | x64, arm64 | PowerShell 安装器或 npm |
| macOS | x64, arm64 | Shell 安装器或 npm |
| Linux | x64, arm64 | Shell 安装器或 npm |

## 卸载

改变主意了？一条命令即可从所有已配置的 agent 中移除 Synapse：

```bash
synapse uninstall
```

此操作会逆向安装过程——从每个已配置的 agent 中移除 Synapse 的 MCP 服务器配置、说明文件和权限设置。项目索引（`.synapse/`）不会被删除；如需移除，请在各项目中执行 `synapse uninit`。使用 `--target` 可指定从特定 agent 中移除，`--yes` 可非交互方式运行。
