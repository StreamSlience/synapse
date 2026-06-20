#!/usr/bin/env bash
# F 组（正文内联 trace + trace 优先引导）在与 arms-matrix.sh 相同的 6 个代码库上运行，
# 使 F vs B 能隔离 trace 增强效果（相同工具面，B 为旧的精简 trace，此处为正文内联 trace）。
set -uo pipefail
H="$(cd "$(dirname "$0")" && pwd)"; RUNS="${RUNS:-2}"; C="${CORPUS:-/tmp/synapse-corpus}"
ROWS=(
"$C/flutter-samples/add_to_app/books/flutter_module_books|How does the books UI build and what child widgets does it show?"
"$C/aspnet-realworld|How is creating an article handled? Trace the controller to the service."
"$C/spring-mall|How is a product-list request handled? Trace the controller to the service."
"$C/vapor-spi|How is a package-show request handled? Name the route and controller."
"$C/excalidraw|How does updating an element re-render the canvas on screen? Trace the flow."
"$C/spring-halo|How is publishing a post handled? Trace the controller to the service."
)
ARM="${ARM:-F}"
echo "### ARM $ARM START $(date) RUNS=$RUNS"
for row in "${ROWS[@]}"; do
  repo="${row%%|*}"; q="${row#*|}"
  for r in $(seq 1 "$RUNS"); do bash "$H/run-arms.sh" "$repo" "$q" "$ARM" "$r"; done
done
echo "### ARM $ARM COMPLETE $(date)"
