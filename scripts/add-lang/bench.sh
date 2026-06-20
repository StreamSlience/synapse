#!/usr/bin/env bash
# 针对单个代码库的新语言基准测试：
#   克隆 -> 清除+索引（使用 PATH 上的 synapse）-> 验证提取 ->
#   有无 synapse 的检索 A/B 对比（复用 scripts/agent-eval/run-all.sh）。
#
# 假设 synapse 开发构建已构建并链接到 PATH——技能在循环各代码库前
# 运行一次 `npm run build && ./scripts/local-install.sh`。
# 若提取未通过关键检查则跳过 A/B（避免在损坏的提取器上消耗费用）；
# 设置 FORCE_AB=1 可强制运行。
#
# 用法：bench.sh <lang> <repo-name> <repo-url> "<question>" [headless|tmux|all]
# 环境变量：CORPUS   语料库目录（默认 /tmp/synapse-corpus，与 agent-eval 共享）
set -uo pipefail

LANG_TOKEN="${1:?usage: bench.sh <lang> <repo-name> <repo-url> \"<question>\" [mode]}"
NAME="${2:?repo-name required}"
URL="${3:?repo-url required}"
Q="${4:?question required}"
MODE="${5:-headless}"

HARNESS="$(cd "$(dirname "$0")" && pwd)"
AGENT_EVAL="$(cd "$HARNESS/../agent-eval" && pwd)"
CORPUS="${CORPUS:-/tmp/synapse-corpus}"
REPO="$CORPUS/$NAME"

command -v synapse >/dev/null || { echo "no synapse on PATH (build + ./scripts/local-install.sh first)"; exit 1; }

echo "==================== add-lang bench: $NAME ($LANG_TOKEN) ===================="
echo "synapse: $(command -v synapse) -> $(synapse --version 2>/dev/null || echo '?')"

# 1. 确保代码库存在（浅克隆，若已有则复用）。
mkdir -p "$CORPUS"
if [ -d "$REPO/.git" ]; then
  echo "→ reusing checkout: $REPO"
else
  echo "→ cloning $URL"
  git clone --depth 1 "$URL" "$REPO" || { echo "git clone failed"; exit 1; }
fi

# 2. 清除 + 用待测二进制索引。
echo "→ wiping .synapse and indexing"
rm -rf "$REPO/.synapse"
( cd "$REPO" && synapse init -i ) || { echo "indexing failed"; exit 1; }

# 3. 验证提取（付费 A/B 前的廉价守卫）。
echo "→ verifying extraction"
node "$HARNESS/verify-extraction.mjs" "$REPO" "$LANG_TOKEN"
VERIFY=$?

# 4. 检索 A/B（若提取损坏则跳过，除非 FORCE_AB=1）。
if [ "$VERIFY" -ne 0 ] && [ "${FORCE_AB:-0}" != "1" ]; then
  echo "→ SKIPPING A/B — extraction failed critical checks (set FORCE_AB=1 to override)"
else
  echo "→ retrieval A/B (mode=$MODE)"
  bash "$AGENT_EVAL/run-all.sh" "$REPO" "$Q" "$MODE"
fi

echo "==================== bench complete: $NAME (verify exit=$VERIFY) ===================="
# 退出码反映提取结果：0 = 通过/警告，1 = 关键失败，2 = 无法读取状态。
exit "$VERIFY"
