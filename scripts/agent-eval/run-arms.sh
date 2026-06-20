#!/usr/bin/env bash
# 工具面消融——在单一分组下对一个代码库+问题进行一次运行。
#
# 各组的差异在于（暴露的 synapse 工具、trace 优先引导）。工具通过
# MCP 配置 `env` 块中的 SYNAPSE_MCP_TOOLS 在服务端裁剪，因此被消融的
# 工具真实地从 ListTools 中缺席——无延迟 ToolSearch 或拒绝调用的干扰
#（--disallowedTools 会引入这些问题）。引导通过 --append-system-prompt
# 注入，无需重建已发布的 server-instructions 即可 A/B。
#
#   A control       所有工具            无引导
#   B steer         所有工具            trace 优先
#   C no-explore    隐藏 explore        trace 优先
#   D trace-centric 隐藏 explore+context trace 优先
#   E control-probe 隐藏 explore+context trace 优先（调用方传入非流程问题）
#
# 用法：run-arms.sh <repo-path> "<question>" <A|B|C|D|E> [run-id]
set -uo pipefail
REPO="${1:?repo path}"; Q="${2:?question}"; ARM="${3:?arm A-E}"; RID="${4:-1}"
CG_BIN="${CG_BIN:-$(command -v synapse)}"
OUT="${ARMS_OUT:-/tmp/arms}/$(basename "$REPO")"
mkdir -p "$OUT"
[ -n "$CG_BIN" ] || { echo "no synapse binary (set CG_BIN)"; exit 1; }
[ -d "$REPO/.synapse" ] || { echo "no .synapse index at $REPO"; exit 1; }

STEER='Flow questions ("how does X reach/become Y", "trace the flow", request to handler, state to render): call synapse_trace(from,to) FIRST — one call returns the whole path. Use synapse_context/search only to locate the two endpoint symbols if you do not know them. Do NOT reconstruct the path with repeated search/callers/explore.'
KEEP_NO_EXPLORE="trace,search,node,context,callers,callees,impact,files,status"
KEEP_TRACE_CENTRIC="trace,search,node,callers,callees,impact,files,status"

case "$ARM" in
  A|G|H|I) TOOLS="";            STEERING="" ;;  # 无引导；H = 正文 trace，I = 正文 trace + 目标被调用者（充分性）
  B|F) TOOLS="";                STEERING="$STEER" ;;  # F = B 的工具面，在正文内联 trace 构建上运行
  C) TOOLS="$KEEP_NO_EXPLORE";  STEERING="$STEER" ;;
  D|E) TOOLS="$KEEP_TRACE_CENTRIC"; STEERING="$STEER" ;;
  *) echo "bad arm '$ARM' (want A|B|C|D|E)"; exit 1 ;;
esac

CFG="$OUT/mcp-$ARM.json"
if [ -n "$TOOLS" ]; then
  cat > "$CFG" <<JSON
{"mcpServers":{"synapse":{"command":"$CG_BIN","args":["serve","--mcp","--path","$REPO"],"env":{"SYNAPSE_MCP_TOOLS":"$TOOLS"}}}}
JSON
else
  cat > "$CFG" <<JSON
{"mcpServers":{"synapse":{"command":"$CG_BIN","args":["serve","--mcp","--path","$REPO"]}}}
JSON
fi

LOG="$OUT/$ARM-r$RID.jsonl"; ERR="$OUT/$ARM-r$RID.err"
ARGS=( -p "$Q" --output-format stream-json --verbose
       --permission-mode bypassPermissions --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd 4
       --strict-mcp-config --mcp-config "$CFG" )
[ -n "$STEERING" ] && ARGS+=( --append-system-prompt "$STEERING" )

( cd "$REPO" && claude "${ARGS[@]}" > "$LOG" 2>"$ERR" )
echo "[$(basename "$REPO") $ARM r$RID] exit $? -> $LOG ($(wc -l < "$LOG" | tr -d ' ') lines)"
