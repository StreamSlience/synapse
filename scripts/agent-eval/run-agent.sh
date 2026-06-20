#!/usr/bin/env bash
# 对带有 synapse MCP 的代码库运行无头 Claude Code，捕获完整的
# stream-json 以查看工具调用 + token 用量。与交互式 itrun.sh 互补：
# 无头模式提供干净的每工具明细 + 精确的 token/费用，
# 但默认使用通用子 agent（非 Explore）。若要强制 Explore 路径，
# 在 prompt 中明确要求。
#
# 用法：run-agent.sh <repo-path> <label> "<prompt>"
# 环境变量：AGENT_EVAL_OUT（默认 /tmp/agent-eval），CG_BIN（synapse dist 二进制）
set -uo pipefail

REPO="$1"; LABEL="$2"; PROMPT="$3"
CG_BIN="${CG_BIN:-$(command -v synapse || echo /usr/local/bin/synapse)}"
OUT_DIR="${AGENT_EVAL_OUT:-/tmp/agent-eval}"; mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/run-${LABEL}.jsonl"

MCP_CONFIG=$(cat <<JSON
{"mcpServers":{"synapse":{"command":"${CG_BIN}","args":["serve","--mcp","--path","${REPO}"]}}}
JSON
)

echo "→ running [$LABEL] in $REPO"
cd "$REPO" || exit 1

claude -p "$PROMPT" \
  --output-format stream-json --verbose \
  --permission-mode bypassPermissions \
  --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" \
  --max-budget-usd 2 \
  --strict-mcp-config --mcp-config "$MCP_CONFIG" \
  > "$OUT" 2>"$OUT_DIR/run-${LABEL}.err"

echo "exit: $? | wrote $OUT ($(wc -l < "$OUT") lines)"
node "$(cd "$(dirname "$0")" && pwd)/parse-run.mjs" "$OUT" 2>/dev/null || true
