#!/usr/bin/env bash
# 在当前构建上重跑 README「Benchmark Results」A/B（有/无 synapse）：
# 7 个 README 代码库，相同查询，每组 RUNS 次运行（默认 4）。
# 输出 → /tmp/ab-readme/<repo>/run<n>/run-headless-{with,without}.jsonl
# 聚合结果使用 parse-bench-readme.mjs。代码库必须由待测构建
# 在 $CORPUS（默认 /tmp/synapse-corpus）下克隆并已索引。
set -uo pipefail
H="$(cd "$(dirname "$0")" && pwd)"
C="${CORPUS:-/tmp/synapse-corpus}"
RUNS="${RUNS:-4}"
ROWS=(
"vscode|How does the extension host communicate with the main process?"
"excalidraw|How does Excalidraw render and update canvas elements?"
"django|How does Django's ORM build and execute a query from a QuerySet?"
"tokio|How does tokio schedule and run async tasks on its runtime?"
"okhttp|How does OkHttp process a request through its interceptor chain?"
"gin|How does gin route requests through its middleware chain?"
"alamofire|How does Alamofire build, send, and validate a request?"
)
echo "### README A/B START $(date) RUNS=$RUNS"
for row in "${ROWS[@]}"; do
  repo="${row%%|*}"; q="${row#*|}"
  echo "===== $repo ====="
  for run in $(seq 1 "$RUNS"); do
    AGENT_EVAL_OUT="/tmp/ab-readme/$repo/run$run" bash "$H/run-all.sh" "$C/$repo" "$q" headless 2>&1 | grep -E "exit [0-9]" || echo "  run$run: (no exit line)"
  done
done
echo "### README A/B DONE $(date)"
