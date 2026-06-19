---
title: Get Started
description: Get up and running with Synapse in seconds.
---

Get up and running with Synapse in seconds.

## No Node.js required — one command grabs the right build for your OS

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/colbymchenry/synapse/main/install.sh | sh

# Windows (PowerShell)
irm https://raw.githubusercontent.com/colbymchenry/synapse/main/install.ps1 | iex
```

## Already have Node? Use npm instead (works on any version)

```bash
npx @colbymchenry/synapse        # zero-install, or:
npm i -g @colbymchenry/synapse
```

Synapse bundles its own runtime — nothing to compile, no native build, works the same everywhere. The interactive installer auto-configures your agent(s) — Claude Code, Cursor, Codex CLI, opencode, Hermes Agent, Gemini CLI, Antigravity IDE, Kiro.

## Initialize Projects

```bash
cd your-project
synapse init -i
```

That's it — your agent will use Synapse tools automatically when a `.synapse/` directory exists.

Next: build [Your First Graph](/synapse/getting-started/your-first-graph/), or see the full [Installation](/synapse/getting-started/installation/) options.
