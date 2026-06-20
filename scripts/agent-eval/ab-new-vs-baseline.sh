#!/usr/bin/env bash
# 对 synapse 检索/引导变更进行 A/B 测试：新构建（当前 HEAD）vs
# 基线构建（一个 git ref）——两者均接入 synapse——在相同的实现任务上，
# 测量 agent 发起多少 Read 调用 vs synapse 调用。
# 隔离该变更（不同于 run-all.sh 的有无对比）。
# agent 在目标的临时副本上工作，不会触及你的代码库。
#
# 可靠挂载（即便本脚本本身嵌套在 Claude 会话中运行也有效）：
# 每组预热一个持久化 synapse 守护进程，使 claude 在 agent 首轮开始前
# 即时连接到已绑定、索引已加载的守护进程，并通过
# SYNAPSE_WASM_RELAUNCHED=1 跳过 synapse 的启动重执行。
# 否则在多步骤任务中，agent 会在 synapse 完成约 2-3 秒启动之前
# 就开始 Read/grep（嵌套运行的 CPU 竞争会更严重），最终完全不使用 synapse。
#
# 注意：claude 的 `system/init` 快照可能读到 status:"pending" / 0 工具，
# 即使服务器随后连接成功——以 parse-run.mjs 的"by type"中
# 实际 synapse 使用情况为准，不要看 init 行。
#
# 用法：ab-new-vs-baseline.sh <indexed-repo> "<task>" [baseline-ref]
#   <indexed-repo>  带有 .synapse 索引的代码库（每组复制一份）
#   "<task>"        实现任务，如"将 X 添加到 Y 并完整接入"
#   [baseline-ref]  BEFORE 构建的 git ref（默认：HEAD~1）
# 环境变量：AGENT_EVAL_OUT（默认：/tmp/ab-new-vs-baseline）
set -uo pipefail

TARGET="${1:?usage: ab-new-vs-baseline.sh <indexed-repo> \"<task>\" [baseline-ref]}"
TASK="${2:?task required}"
BASE_REF="${3:-HEAD~1}"
ENGINE="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$ENGINE/dist/bin/synapse.js"
OUT="${AGENT_EVAL_OUT:-/tmp/ab-new-vs-baseline}"
PARSE="$ENGINE/scripts/agent-eval/parse-run.mjs"

command -v claude >/dev/null || { echo "claude CLI not on PATH"; exit 1; }
[ -d "$TARGET/.synapse" ] || { echo "target not indexed: run 'synapse init $TARGET' first"; exit 1; }
if ! git -C "$ENGINE" diff --quiet || ! git -C "$ENGINE" diff --cached --quiet; then
  echo "engine repo has uncommitted changes — commit or stash first (this script checks files out)"; exit 1
fi
CHANGED=$(git -C "$ENGINE" diff --name-only "$BASE_REF" HEAD -- src 2>/dev/null)
[ -n "$CHANGED" ] || { echo "no src/ changes between $BASE_REF and HEAD — nothing to A/B"; exit 1; }

# 退出时：杀死所有评估守护进程 + 将引擎恢复到 HEAD。
cleanup() {
  pkill -9 -f "serve --mcp --path $OUT/" 2>/dev/null
  git -C "$ENGINE" checkout HEAD -- $CHANGED 2>/dev/null
  ( cd "$ENGINE" && npm run build >/dev/null 2>&1 )
}
trap cleanup EXIT

mkdir -p "$OUT"
echo "###### engine=$ENGINE  baseline=$BASE_REF"
echo "###### changed: $(echo "$CHANGED" | tr '\n' ' ')"
echo "###### target=$TARGET"
echo "###### task=$TASK"
echo

# 两份全新副本，使每组以干净状态启动（agent 编辑自己的副本）。
rm -rf "$OUT/t-new" "$OUT/t-base"
rsync -a --exclude node_modules --exclude .git --exclude dist --exclude .synapse "$TARGET/" "$OUT/t-new/"
cp -R "$OUT/t-new" "$OUT/t-base"

prewarm() { # target — 生成持久化守护进程（当前 $BIN）并等待其 socket
  pkill -9 -f "serve --mcp --path $1" 2>/dev/null
  SYNAPSE_DAEMON_IDLE_TIMEOUT_MS=1800000 node "$BIN" serve --mcp --path "$1" </dev/null >/dev/null 2>&1 &
  node -e 'const fs=require("fs");let n=0;const t=setInterval(()=>{if(fs.existsSync(process.argv[1]+"/.synapse/daemon.sock")){clearInterval(t);process.exit(0)}if(n++>150){clearInterval(t);process.exit(1)}},100)' "$1" \
    && echo "  daemon warm: $1" || echo "  WARN: daemon never bound for $1 (arm may run without synapse)"
}

run_arm() { # label, target-copy
  local label="$1" tgt="$2" c="$OUT/mcp-$1.json"
  # 连接到预热的守护进程；跳过启动重执行以快速挂载。
  printf '{"mcpServers":{"synapse":{"command":"env","args":["SYNAPSE_WASM_RELAUNCHED=1","node","%s","serve","--mcp","--path","%s"]}}}' "$BIN" "$tgt" > "$c"
  prewarm "$tgt"
  echo "############## ARM [$label] ##############"
  ( cd "$tgt" && claude -p "$TASK" \
      --output-format stream-json --verbose --permission-mode bypassPermissions \
      --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" --max-budget-usd 4 --strict-mcp-config --mcp-config "$c" \
      </dev/null > "$OUT/run-$label.jsonl" 2>"$OUT/run-$label.err" )
  node "$PARSE" "$OUT/run-$label.jsonl" 2>&1 | grep -E "by type|Result" || echo "  (parse failed — see $OUT/run-$label.jsonl)"
  pkill -9 -f "serve --mcp --path $tgt" 2>/dev/null
  echo
}

echo "== NEW build (HEAD) =="
( cd "$ENGINE" && npm run build >/dev/null 2>&1 ) && echo "  built"
node "$BIN" init "$OUT/t-new" >/dev/null 2>&1 && echo "  indexed t-new"
run_arm new "$OUT/t-new"

echo "== BASELINE build ($BASE_REF) =="
# 逐文件处理：自基线以来新增的文件在该 ref 上没有路径规范——
# 而包含一个错误路径规范的多文件单次 checkout 会 checkout 零内容，
# 导致基线组静默地运行了新构建。基线上不存在的文件 → 删除。
for f in $CHANGED; do
  git -C "$ENGINE" checkout "$BASE_REF" -- "$f" 2>/dev/null || rm -f "$ENGINE/$f"
done
( cd "$ENGINE" && npm run build >/dev/null 2>&1 ) && echo "  built"
node "$BIN" init "$OUT/t-base" >/dev/null 2>&1 && echo "  indexed t-base"
run_arm baseline "$OUT/t-base"

echo "###### DONE. Compare the [new] vs [baseline] 'by type' counts above"
echo "###### (especially Read vs mcp__synapse__*). Full logs in: $OUT"
