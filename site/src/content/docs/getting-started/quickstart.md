---
title: 快速上手
description: 几秒内启动并运行 Synapse。
---

几秒内启动并运行 Synapse。

## 无需 Node.js——一条命令即可获取适合你操作系统的版本

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/synapse/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/colbymchenry/synapse/main/install.ps1 | iex
```

## 已有 Node？改用 npm（支持任何版本）

```bash
npx @colbymchenry/synapse        # 零安装，或：
npm i -g @colbymchenry/synapse
```

Synapse 内置自己的运行时——无需编译，无需原生构建，在任何地方运行效果一致。交互式安装器会自动配置你的 agent——Claude Code、Cursor、Codex CLI、opencode、Hermes Agent、Gemini CLI、Antigravity IDE、Kiro。

## 初始化项目

```bash
cd your-project
synapse init -i
```

就这些——只要存在 `.synapse/` 目录，你的 agent 就会自动使用 Synapse 工具。

下一步：构建[你的第一个图谱](/synapse/getting-started/your-first-graph/)，或查看完整的[安装](/synapse/getting-started/installation/)选项。
