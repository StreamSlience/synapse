#!/usr/bin/env bash
# 构建当前分支并将其链接为全局 `synapse`，用于手动测试。
# 在符号链接存在期间替换任何已有的全局安装。
#
# 用法：
#   ./scripts/local-install.sh           # 构建 + 链接
#   ./scripts/local-install.sh --undo    # 取消链接 + 恢复已发布版本

set -euo pipefail

cd "$(dirname "$0")/.."

PKG=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [ "${1:-}" = "--undo" ]; then
  echo "→ unlinking ${PKG}"
  npm unlink -g "${PKG}" >/dev/null 2>&1 || true
  echo "→ reinstalling published ${PKG}"
  npm install -g "${PKG}"
  echo "done: global synapse -> $(command -v synapse)"
  exit 0
fi

echo "→ building ${PKG} ${VERSION} (${BRANCH})"
npm run build

echo "→ linking globally"
npm link

LINKED=$(command -v synapse || echo "(not on PATH)")
echo
echo "✓ global synapse now points to this branch"
echo "  binary:  ${LINKED}"
echo "  branch:  ${BRANCH}"
echo "  version: ${VERSION}"
echo
echo "To restore the published version:"
echo "  ./scripts/local-install.sh --undo"
