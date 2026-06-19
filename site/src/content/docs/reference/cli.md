---
title: CLI
description: Every Synapse command and the flags it accepts.
---

```bash
synapse                         # Run interactive installer
synapse install                 # Run installer (explicit)
synapse uninstall               # Remove Synapse from your agents (inverse of install)
synapse init [path]             # Initialize in a project (--index to also index)
synapse uninit [path]           # Remove Synapse from a project (--force to skip prompt)
synapse index [path]            # Full index (--force to re-index, --quiet for less output)
synapse sync [path]             # Incremental update
synapse status [path]           # Show statistics
synapse query <search>          # Search symbols (--kind, --limit, --json)
synapse files [path]            # Show file structure (--format, --filter, --max-depth, --json)
synapse context <task>          # Build context for AI (--format, --max-nodes)
synapse callers <symbol>        # Find what calls a function/method (--limit, --json)
synapse callees <symbol>        # Find what a function/method calls (--limit, --json)
synapse impact <symbol>         # Analyze what code is affected by changing a symbol (--depth, --json)
synapse affected [files...]     # Find test files affected by changes
synapse serve --mcp             # Start MCP server
```

## Query commands

`query`, `callers`, `callees`, and `impact` all accept `--json` for machine-readable output.

```bash
synapse query UserService --kind class --limit 10
synapse callers handleRequest --json
synapse impact AuthMiddleware --depth 3
```

## affected

Traces import dependencies transitively to find which test files are affected by changed source files. See [Affected Tests in CI](/synapse/guides/affected-tests/) for options and a CI example.
