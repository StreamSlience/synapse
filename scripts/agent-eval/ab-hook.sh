#!/usr/bin/env bash
# 对 PreToolUse(Read) 重定向 hook（P1）进行 A/B：引导 Read → synapse_node
# 文件视图是否真的在实现过程中让 agent 放弃 Read？两组均使用
# 当前构建、接入 synapse 并预热；唯一区别是 hook。
# 将 hook 的行为效果与构建/文件视图变更相隔离
#（构建 A/B 请使用 ab-new-vs-baseline.sh）。
#
#   arm [nohook] — synapse 开启，无 hook（更好的文件视图会被自主选用吗？）
#   arm [hook]   — synapse 开启，+ 重定向 hook（路由能弥合差距吗？）
#
# 可靠挂载（支持嵌套）：每组预热持久化守护进程并跳过启动重执行
#（SYNAPSE_WASM_RELAUNCHED=1），使 claude 在 agent 首轮前完成连接。
# 以 parse-run.mjs 的"by type"中实际 synapse 使用情况为准，
# 不要看 claude 的 init 快照（即使随后连接成功也可能读到 pending）。
#
# 用法：ab-hook.sh <indexed-repo> "<implementation task>" [runs-per-arm]
#   <indexed-repo>  带有 .synapse 索引的代码库（每组复制一份，从不修改）
#   "<task>"        全新的实现任务（确认尚未完成）
#   [runs-per-arm]  默认 2（n=1 噪声太大——规范要求 >=2）
# 环境变量：AGENT_EVAL_OUT（默认：/tmp/ab-hook）
set -uo pipefail

TARGET="${1:?usage: ab-hook.sh <indexed-repo> \"<task>\" [runs-per-arm]}"
TASK="${2:?task required}"
RUNS="${3:-2}"
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ENGINE/dist/bin/synapse.js"
HOOK="$ENGINE/scripts/agent-eval/redirect-read-hook.sh"
OUT="${AGENT_EVAL_OUT:-/tmp/ab-hook}"
PARSE="$ENGINE/scripts/agent-eval/parse-run.mjs"

command -v claude >/dev/null || { echo "claude CLI not on PATH"; exit 1; }
command -v jq >/dev/null || { echo "jq not on PATH (the hook needs it)"; exit 1; }
[ -d "$TARGET/.synapse" ] || { echo "target not indexed: run 'synapse init $TARGET' first"; exit 1; }
chmod +x "$HOOK"

cleanup() { pkill -9 -f "serve --mcp --path $OUT/" 2>/dev/null; }
trap cleanup EXIT

mkdir -p "$OUT"
echo "###### engine=$ENGINE"
echo "###### target=$TARGET   runs/arm=$RUNS"
echo "###### task=$TASK"
echo

( cd "$ENGINE" && npm run build >/dev/null 2>&1 ) && echo "built"

# 仅包含 PreToolUse(Read) 重定向 hook 的设置文件。
HOOK_SETTINGS="$OUT/hook-settings.json"
jq -n --arg cmd "bash $HOOK" \
  '{hooks:{PreToolUse:[{matcher:"Read",hooks:[{type:"command",command:$cmd}]}]}}' > "$HOOK_SETTINGS"

prewarm() { # target — 生成持久化守护进程并等待其 socket
  pkill -9 -f "serve --mcp --path $1" 2>/dev/null
  SYNAPSE_DAEMON_IDLE_TIMEOUT_MS=1800000 node "$BIN" serve --mcp --path "$1" </dev/null >/dev/null 2>&1 &
  node -e 'const fs=require("fs");let n=0;const t=setInterval(()=>{if(fs.existsSync(process.argv[1]+"/.synapse/daemon.sock")){clearInterval(t);process.exit(0)}if(n++>150){clearInterval(t);process.exit(1)}},100)' "$1" \
    && echo "  daemon warm: $1" || echo "  WARN: daemon never bound for $1"
}

run_one() { # arm-label, run-index, use-hook(0|1)
  local label="$1" idx="$2" hook="$3"
  local tgt="$OUT/t-$label-$idx" c="$OUT/mcp-$label.json"
  rm -rf "$tgt"
  rsync -a --exclude node_modules --exclude .git --exclude dist --exclude .synapse "$TARGET/" "$tgt/"
  node "$BIN" init "$tgt" >/dev/null 2>&1
  printf '{"mcpServers":{"synapse":{"command":"env","args":["SYNAPSE_WASM_RELAUNCHED=1","node","%s","serve","--mcp","--path","%s"]}}}' "$BIN" "$tgt" > "$c"
  prewarm "$tgt"
  local extra=()
  [ "$hook" = "1" ] && extra=(--settings "$HOOK_SETTINGS")
  echo "----- [$label] run $idx -----"
  # ${extra[@]+...} 保护：bash 3.2（macOS）在 `set -u` 下对空数组展开会报错，
  # 否则会跳过 no-hook 组的 claude 运行。
  ( cd "$tgt" && claude -p "$TASK" \
      --output-format stream-json --verbose --permission-mode bypassPermissions \
      --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd 4 --strict-mcp-config --mcp-config "$c" ${extra[@]+"${extra[@]}"} \
      </dev/null > "$OUT/run-$label-$idx.jsonl" 2>"$OUT/run-$label-$idx.err" )
  node "$PARSE" "$OUT/run-$label-$idx.jsonl" 2>&1 | grep -E "by type|Result" || echo "  (parse failed — see $OUT/run-$label-$idx.jsonl)"
  pkill -9 -f "serve --mcp --path $tgt" 2>/dev/null
  echo
}

for i in $(seq 1 "$RUNS"); do run_one nohook "$i" 0; done
for i in $(seq 1 "$RUNS"); do run_one hook   "$i" 1; done

echo "###### DONE. Compare [nohook] vs [hook] 'by type' — Read should fall and"
echo "###### mcp__synapse__synapse_node should rise in the [hook] arm. Logs: $OUT"
