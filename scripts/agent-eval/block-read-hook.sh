#!/usr/bin/env bash
# PreToolUse hook（实验性）：拒绝读取 synapse 已索引的源文件，
# 并将 agent 引导至 synapse_explore/synapse_node。验证一旦移除逃生通道，
# synapse 能否完全替代 Read 来理解代码。
# 非源文件读取（配置、.env、markdown、新文件）直接放行。
#
# 接入方式：claude ... --settings scripts/agent-eval/hook-settings.json
set -uo pipefail
input="$(cat)"
fp="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"

case "$fp" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.py|*.go|*.rs|*.java|*.rb|*.php|*.swift|*.kt|*.kts|*.c|*.cc|*.cpp|*.h|*.hpp|*.cs|*.lua|*.vue|*.svelte)
    msg="Read is disabled for source files in this session — synapse already has this file indexed (with line numbers, kept in sync on every change). Use synapse_explore (several related symbols at once) or synapse_node (one symbol's full source). If a symbol you need wasn't in a prior explore, run ANOTHER synapse_explore with its exact name instead of reading the file."
    jq -n --arg m "$msg" '{reason:$m, hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$m}}'
    exit 0
    ;;
esac
exit 0
