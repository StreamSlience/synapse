---
title: Your First Graph
description: Build an index and run your first queries against it.
---

Once Synapse is installed, building and exploring a graph takes three commands.

## Index a project

```bash
cd your-project
synapse init -i      # initialize + index in one step
```

`init` creates the `.synapse/` directory; `-i` (or `--index`) immediately builds the full index. For an existing project you can re-index any time:

```bash
synapse index          # full index
synapse sync           # incremental update of changed files
```

## Check it worked

```bash
synapse status
```

This reports the node/edge/file counts, the active SQLite backend, and the journal mode — a quick health check that the index is ready.

## Run a query

```bash
synapse query UserService          # find symbols by name
synapse callers handleRequest      # what calls a function
synapse callees handleRequest      # what a function calls
synapse impact AuthMiddleware      # what a change would affect
synapse context "fix the login flow"   # build task-focused context
```

Each accepts `--json` for machine-readable output. See the full [CLI reference](/synapse/reference/cli/).

## Hand it to your agent

With a `.synapse/` directory present and an agent configured (see [Installation](/synapse/getting-started/installation/)), your agent uses the [MCP tools](/synapse/reference/mcp-server/) automatically — no extra step.
