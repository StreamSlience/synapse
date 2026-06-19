---
title: Integrations
description: Supported agents, and manual MCP setup.
---

The interactive installer auto-detects and configures each supported agent — wiring up the MCP server and writing its instructions file.

## Supported agents

- **Claude Code**
- **Cursor**
- **Codex CLI**
- **opencode**
- **Hermes Agent**
- **Gemini CLI**
- **Antigravity IDE**
- **Kiro**

Run `npx @colbymchenry/synapse` and pick your agent(s); see [Installation](/synapse/getting-started/installation/) for the non-interactive flags.

## Manual setup

If you'd rather wire it up yourself, install globally:

```bash
npm install -g @colbymchenry/synapse
```

Add the MCP server to `~/.claude.json`:

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

Optionally auto-allow the read-only tools in `~/.claude/settings.json`:

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
Cursor launches MCP subprocesses with the wrong working directory. The installer handles this for you by injecting a `--path` argument; if you wire Cursor up by hand, pass the project path explicitly.
:::
