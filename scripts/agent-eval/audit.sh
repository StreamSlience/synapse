#!/usr/bin/env bash
# 一次性 Synapse 质量审计：
#   设置版本 -> 确保语料库代码库存在 -> 用该版本清除+重索引 ->
#   运行有/无 A/B -> 恢复本地开发链接。
#
# 用法：audit.sh <version> <repo-name> <repo-url> "<question>" [headless|all]
#   <version>    "local"（构建 + npm link 本仓库）| "latest" | 版本号（如 0.7.10）
#   <repo-name>  语料库目录下的目录名
#   <repo-url>   git URL（目录不存在时浅克隆）
#   [mode]       headless（默认）| all（同时运行交互式 tmux 分组）
# 环境变量：CORPUS  语料库目录（默认：/tmp/synapse-corpus）
set -uo pipefail

VERSION="${1:?usage: audit.sh <version> <repo-name> <repo-url> \"<question>\" [mode]}"
NAME="${2:?repo-name required}"
URL="${3:?repo-url required}"
Q="${4:?question required}"
MODE="${5:-headless}"

HARNESS="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS/../.." && pwd)"     # synapse repo root
CORPUS="${CORPUS:-/tmp/synapse-corpus}"
REPO="$CORPUS/$NAME"
PKG="@colbymchenry/synapse"

echo "==================== Synapse audit ===================="
echo "version=$VERSION  repo=$NAME  mode=$MODE  corpus=$CORPUS"
echo

# 1. 设置待测 synapse 版本（会修改全局安装）。
if [ "$VERSION" = local ]; then
  echo "→ [1/4] building + linking local dev build (local-install.sh)"
  ( cd "$REPO_ROOT" && ./scripts/local-install.sh ) || { echo "local-install.sh failed"; exit 1; }
else
  echo "→ [1/4] installing $PKG@$VERSION globally"
  npm install -g "$PKG@$VERSION" || { echo "npm install -g $PKG@$VERSION failed"; exit 1; }
fi
ACTUAL="$(synapse --version 2>/dev/null || echo '?')"
echo "  synapse on PATH: $(command -v synapse) -> $ACTUAL"

# 2. 确保语料库代码库存在（缺失时浅克隆，存在时复用）。
mkdir -p "$CORPUS"
if [ -d "$REPO/.git" ]; then
  echo "→ [2/4] reusing existing checkout: $REPO"
else
  echo "→ [2/4] cloning $URL"
  git clone --depth 1 "$URL" "$REPO" || { echo "git clone failed"; exit 1; }
fi

# 3. 清除 + 用当前版本重索引（索引必须由提供服务的同一二进制构建——
#    不同版本的提取结果不同）。
echo "→ [3/4] wiping .synapse and re-indexing with $ACTUAL"
rm -rf "$REPO/.synapse"
( cd "$REPO" && synapse init -i ) || { echo "indexing failed"; exit 1; }

# 4. 运行有/无 A/B 对比。
echo "→ [4/4] running A/B harness (mode=$MODE)"
bash "$HARNESS/run-all.sh" "$REPO" "$Q" "$MODE"

# 恢复开发链接（本仓库的正常工作状态）。
echo
echo "→ restoring local dev link (local-install.sh)"
if ( cd "$REPO_ROOT" && ./scripts/local-install.sh >/dev/null 2>&1 ); then
  echo "  global synapse restored to dev build"
else
  echo "  WARN: restore failed — run ./scripts/local-install.sh manually"
fi
echo "==================== audit complete ===================="
