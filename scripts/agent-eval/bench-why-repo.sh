#!/usr/bin/env bash
# 单个 README 代码库，仅开启 synapse，N 次运行。每次运行追加一条 why-Read
# 诊断提示，让 agent 解释任何 Read/Grep 的原因。（无 synapse 基线独立于
# synapse 且已记录在 README 中——无需重跑。）
# 输出 -> /tmp/ab-why/<repo>/with<n>.jsonl
# 用法：bench-why-repo.sh <repo-path> "<query>" [N]
set -uo pipefail
REPO="$1"; Q="$2"; N="${3:-4}"
NAME="$(basename "$REPO")"
CG="/Users/colby/Development/Personal/synapse/dist/bin/synapse.js"
OUT="/tmp/ab-why/$NAME"; mkdir -p "$OUT"
WHY=$'\n\nIMPORTANT — diagnostic: if you use the Read or Grep tool at ANY point, for EACH such call explain why synapse_explore / synapse_node did not already give you what you needed. End your entire answer with a section titled exactly "## Why I read" listing every Read and Grep you made and the precise reason synapse fell short for it. If you used neither, write "## Why I read" then "none — synapse was sufficient."'
printf '{"mcpServers":{"synapse":{"command":"%s","args":["serve","--mcp","--path","%s"]}}}' "$CG" "$REPO" > "$OUT/cg.json"

for i in $(seq 1 "$N"); do
  pkill -f "serve --mcp" 2>/dev/null; sleep 1; rm -f "$REPO/.synapse/daemon.sock"
  ( cd "$REPO" && claude -p "$Q$WHY" --output-format stream-json --verbose \
      --permission-mode bypassPermissions --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd 4 \
      --strict-mcp-config --mcp-config "$OUT/cg.json" > "$OUT/with$i.jsonl" 2>"$OUT/with$i.err" )
  echo "WITH run $i: exit $? ($(wc -l < "$OUT/with$i.jsonl" | tr -d ' ') lines)"
done
echo "DONE $NAME"
