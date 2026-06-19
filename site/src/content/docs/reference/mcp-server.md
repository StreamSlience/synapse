---
title: MCP Server
description: The tools Synapse exposes to AI agents over MCP.
---

Synapse runs as a [Model Context Protocol](https://modelcontextprotocol.io/) server. Start it with:

```bash
synapse serve --mcp
```

Agents configured by the installer launch this automatically. When a `.synapse/` index exists, the agent uses the tools below.

## Tools

| Tool | Purpose |
|---|---|
| `synapse_search` | Find symbols by name across the codebase |
| `synapse_callers` | Find what calls a function |
| `synapse_callees` | Find what a function calls |
| `synapse_impact` | Analyze what code is affected by changing a symbol |
| `synapse_node` | Get details about a specific symbol (optionally with source code) |
| `synapse_explore` | Return source for several related symbols grouped by file, plus a relationship map, in one call |
| `synapse_files` | Get the indexed file structure (faster than filesystem scanning) |
| `synapse_status` | Check index health and statistics |

## How agents should use it

Synapse *is* the pre-built search index. For "how does X work?", architecture, trace, or where-is-X questions, an agent should answer in a handful of Synapse calls and stop — typically with **zero file reads** — rather than re-deriving the answer with `grep` + `Read`. A direct Synapse answer is a handful of calls; a grep/read exploration is dozens.

The installer writes this guidance into each agent's instructions file automatically.
