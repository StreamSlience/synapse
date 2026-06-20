#!/usr/bin/env bash
# 在选定代码库 × 分组（A–E）上运行工具面消融实验。
# A–D 组提问规范的流程问题；E 组提非流程的概览问题
#（对照探针——在无 explore+context 时应退化）。
# 输出：/tmp/arms/<repo>/<arm>-r<n>.jsonl（用 parse-arms.mjs 解析）。
set -uo pipefail
HARNESS="$(cd "$(dirname "$0")" && pwd)"
RUNS="${RUNS:-2}"
C="${CORPUS:-/tmp/synapse-corpus}"
NFQ='What are the main modules/components of this codebase and what does each one do? Give an overview of how it is organized.'

# repo-path|flow-question  （2 小型、2 中型、2 大型——覆盖规模范围）
ROWS=(
"$C/flutter-samples/add_to_app/books/flutter_module_books|How does the books UI build and what child widgets does it show?"
"$C/aspnet-realworld|How is creating an article handled? Trace the controller to the service."
"$C/spring-mall|How is a product-list request handled? Trace the controller to the service."
"$C/vapor-spi|How is a package-show request handled? Name the route and controller."
"$C/excalidraw|How does updating an element re-render the canvas on screen? Trace the flow."
"$C/spring-halo|How is publishing a post handled? Trace the controller to the service."
)

echo "### ARMS MATRIX START $(date) RUNS=$RUNS"
for row in "${ROWS[@]}"; do
  repo="${row%%|*}"; q="${row#*|}"
  for arm in A B C D; do
    for r in $(seq 1 "$RUNS"); do
      bash "$HARNESS/run-arms.sh" "$repo" "$q" "$arm" "$r"
    done
  done
done
# E：在两个代码库上的非流程对照探针（在无 explore+context 时必须退化）
for repo in "$C/excalidraw" "$C/spring-mall"; do
  for r in $(seq 1 "$RUNS"); do
    bash "$HARNESS/run-arms.sh" "$repo" "$NFQ" E "$r"
  done
done
echo "### ARMS MATRIX COMPLETE $(date)"
