#!/usr/bin/env bash
# 针对某个代码库上某个 synapse 版本的有/无 A/B 对比（及可选的交互式）评估。
# Codegraph 是唯一变量：两组均以 --strict-mcp-config 启动 claude——
# with 组 = 仅 synapse MCP（指向 $CG_BIN），without 组 = 空 MCP。
# 内置的 Read/Grep/Bash 在两组中均可用。
#
# 用法：run-all.sh <repo-path> "<question>" [headless|tmux|all]
# 环境变量：CG_BIN          synapse 二进制（默认：command -v synapse）
#           AGENT_EVAL_OUT  输出目录（默认：/tmp/agent-eval）
#           MODEL / EFFORT  claude 模型/努力程度（默认：sonnet / high——
#                           既定 A/B 策略；参见 CLAUDE.md，不得调高）
set -uo pipefail

REPO="${1:?usage: run-all.sh <repo-path> \"<question>\" [headless|tmux|all]}"
Q="${2:?question required}"
MODE="${3:-headless}"
CG_BIN="${CG_BIN:-$(command -v synapse)}"
OUT="${AGENT_EVAL_OUT:-/tmp/agent-eval}"
HARNESS="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"

[ -n "$CG_BIN" ] || { echo "no synapse binary on PATH (set CG_BIN)"; exit 1; }
[ -d "$REPO/.synapse" ] || { echo "no .synapse index at $REPO — index it first"; exit 1; }
case "$MODE" in headless|tmux|all) ;; *) echo "mode must be headless|tmux|all (got '$MODE')"; exit 1;; esac

# MCP 配置文件（路径形式避免通过 tmux 传递内联 JSON 的引号问题）。
cat > "$OUT/mcp-synapse.json" <<JSON
{"mcpServers":{"synapse":{"command":"$CG_BIN","args":["serve","--mcp","--path","$REPO"]}}}
JSON
echo '{"mcpServers":{}}' > "$OUT/mcp-empty.json"

echo "###### synapse: $CG_BIN"
echo "###### repo:      $REPO"
echo "###### question:  $Q"
echo

# 无头模式：claude -p 使用 stream-json -> 精确工具序列 + token/费用。
headless() {
  local label="$1" cfg="$2"
  echo "############################## HEADLESS [$label] ##############################"
  ( cd "$REPO" && claude -p "$Q" \
      --output-format stream-json --verbose \
      --permission-mode bypassPermissions \
      --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" \
      --max-budget-usd 4 \
      --strict-mcp-config --mcp-config "$cfg" \
      > "$OUT/run-$label.jsonl" 2>"$OUT/run-$label.err" )
  echo "exit $? -> $OUT/run-$label.jsonl ($(wc -l < "$OUT/run-$label.jsonl" | tr -d ' ') lines)"
  tail -2 "$OUT/run-$label.err" 2>/dev/null
  node "$HARNESS/parse-run.mjs" "$OUT/run-$label.jsonl" 2>&1 || true
  echo
}

if [ "$MODE" = headless ] || [ "$MODE" = all ]; then
  headless "headless-with"    "$OUT/mcp-synapse.json"
  headless "headless-without" "$OUT/mcp-empty.json"
fi

if [ "$MODE" = tmux ] || [ "$MODE" = all ]; then
  echo "############################## INTERACTIVE [with] ##############################"
  CLAUDE_EXTRA_ARGS="--model ${MODEL:-sonnet} --effort ${EFFORT:-high} --strict-mcp-config --mcp-config $OUT/mcp-synapse.json" \
    bash "$HARNESS/itrun.sh" "$REPO" "int-with" "$Q" 2>&1 || echo "[itrun WITH failed]"
  echo
  echo "############################## INTERACTIVE [without] ##############################"
  CLAUDE_EXTRA_ARGS="--model ${MODEL:-sonnet} --effort ${EFFORT:-high} --strict-mcp-config --mcp-config $OUT/mcp-empty.json" \
    bash "$HARNESS/itrun.sh" "$REPO" "int-without" "$Q" 2>&1 || echo "[itrun WITHOUT failed]"
  echo
fi
echo "############################## RUN-ALL COMPLETE ##############################"
