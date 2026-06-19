---
title: 集成
description: 支持的 agent 及手动配置 MCP 的方式。
---

交互式安装器会自动检测并配置每个受支持的 agent——接入 MCP 服务器并写入其说明文件。

## 支持的 agent

- **Claude Code**
- **Cursor**
- **Codex CLI**
- **opencode**
- **Hermes Agent**
- **Gemini CLI**
- **Antigravity IDE**
- **Kiro**

运行 `npx @colbymchenry/synapse` 并选择你的 agent；非交互模式的标志请参见[安装](/synapse/getting-started/installation/)。

## 手动配置

如果想自行配置，先全局安装：

```bash
npm install -g @colbymchenry/synapse
```

将 MCP 服务器添加到 `~/.claude.json`：

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

可选：在 `~/.claude/settings.json` 中自动授权只读工具：

```json
{
  "permissions": {
    "allow": [
      "mcp__synapse__synapse_search",
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

:::tip
Cursor 启动 MCP 子进程时会使用错误的工作目录。安装器会通过注入 `--path` 参数来处理这个问题；如果手动配置 Cursor，需要显式传入项目路径。
:::
