#!/usr/bin/env bash
#
# 构建自包含的 Synapse bundle：官方 Node 运行时 + 编译后的应用 + 生产依赖，
# 使 Synapse 无需系统 Node、无需原生构建即可运行——node:sqlite 已内置于
# 打包的 Node 中。每个平台产出一个归档文件。
#
# 由于移除 better-sqlite3 后原生插件为零，打包流程纯粹是文件打包
#（下载目标平台 Node、复制应用、归档）——任何平台的 bundle 都可在任意
# 操作系统上构建，无需交叉编译，无需原生 runner。
#
# 用法：
#   scripts/build-bundle.sh <target> [node-version]
#     target:        darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64
#                  | win32-x64 | win32-arm64
#     node-version:  如 v24.16.0（默认见下方；固定版本以实现可重现构建）
#
# 输出：
#   unix:    release/synapse-<target>.tar.gz   （启动器：bin/synapse）
#   windows: release/synapse-<target>.zip      （启动器：bin/synapse.cmd）
set -euo pipefail

TARGET="${1:?usage: build-bundle.sh <target> [node-version]}"
NODE_VERSION="${2:-v24.16.0}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/release"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ARCH="${TARGET##*-}"   # x64 | arm64
OSFAM="${TARGET%-*}"   # darwin | linux | win32

echo "[bundle] target=${TARGET} node=${NODE_VERSION}"

# 1. 下载并解压目标平台的官方 Node 运行时。
if [ "$OSFAM" = "win32" ]; then
  NODE_DIST="node-${NODE_VERSION}-win-${ARCH}"
  NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.zip"
  echo "[bundle] downloading ${NODE_URL}"
  curl -fsSL "$NODE_URL" -o "$WORK/node.zip"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$WORK/node.zip" -d "$WORK"
  else
    tar -xf "$WORK/node.zip" -C "$WORK"   # bsdtar can read zip
  fi
  NODE_BIN="$WORK/${NODE_DIST}/node.exe"
else
  NODE_DIST="node-${NODE_VERSION}-${TARGET}"
  NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.gz"
  echo "[bundle] downloading ${NODE_URL}"
  curl -fsSL "$NODE_URL" -o "$WORK/node.tar.gz"
  tar -xzf "$WORK/node.tar.gz" -C "$WORK"
  NODE_BIN="$WORK/${NODE_DIST}/bin/node"
fi
[ -f "$NODE_BIN" ] || { echo "[bundle] error: node binary not found ($NODE_BIN)" >&2; exit 1; }

# 2. 构建应用（编译后的 JS + 复制 wasm/schema 资源）。
echo "[bundle] building app"
( cd "$ROOT" && npm run build >/dev/null )

# 3. 暂存：应用 + 仅生产依赖（纯 JS/wasm，可跨平台移植）。
STAGE="$WORK/synapse-${TARGET}"
mkdir -p "$STAGE/lib" "$STAGE/bin"
cp -R "$ROOT/dist" "$STAGE/lib/dist"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/lib/"
echo "[bundle] installing production dependencies"
( cd "$STAGE/lib" && npm ci --omit=dev --ignore-scripts >/dev/null 2>&1 )
rm -f "$STAGE/lib/package-lock.json"

# 4. 内置 Node + 启动器（启动器通过相对路径使用打包的 Node，
#    因此永远不需要系统 Node）。
#
# `--liftoff-only`：将 tree-sitter 的大型 WASM 语法锁定在 V8 Liftoff 基线
# 编译器上，使其永远不会进入 turboshaft 优化层。turboshaft 的每次编译 Zone
# 分配器会导致整个进程 OOM（`Fatal process out of memory: Zone`），在
# Node >= 22 上即便有数十 GB 可用内存也会如此。该标志在 V8 引擎初始化时
# 读取，因此必须放在 node 命令行上；parse worker 会继承它。
# 参见 issues #293/#298 和 src/extraction/wasm-runtime-flags.ts。
#（CLI 在未带此标志启动时也会自我重启，因此非 bundle 运行也有保障；
# 在此处传递可避免额外的 spawn。）
if [ "$OSFAM" = "win32" ]; then
  cp "$NODE_BIN" "$STAGE/node.exe"
  printf '@"%%~dp0..\\node.exe" --liftoff-only "%%~dp0..\\lib\\dist\\bin\\synapse.js" %%*\r\n' \
    > "$STAGE/bin/synapse.cmd"
else
  cp "$NODE_BIN" "$STAGE/node"
  cat > "$STAGE/bin/synapse" <<'LAUNCH'
#!/bin/sh
# 解析符号链接（如 install.sh 创建的 ~/.local/bin/synapse 链接），
# 以找到真实的 bundle 目录而非符号链接所在位置。
SELF="$0"
while [ -L "$SELF" ]; do
  target="$(readlink "$SELF")"
  case "$target" in
    /*) SELF="$target" ;;
    *) SELF="$(dirname "$SELF")/$target" ;;
  esac
done
DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
# --liftoff-only：避免 V8 turboshaft WASM Zone OOM（issues #293/#298）。
exec "$DIR/node" --liftoff-only "$DIR/lib/dist/bin/synapse.js" "$@"
LAUNCH
  chmod +x "$STAGE/bin/synapse"
fi

# 5. 归档（Windows 用 .zip，其他平台用 .tar.gz）。
mkdir -p "$OUT"
if [ "$OSFAM" = "win32" ]; then
  ARCHIVE="$OUT/synapse-${TARGET}.zip"
  rm -f "$ARCHIVE"
  ( cd "$WORK" && zip -rqX "$ARCHIVE" "synapse-${TARGET}" )
else
  ARCHIVE="$OUT/synapse-${TARGET}.tar.gz"
  # --no-xattrs：不嵌入会导致 GNU tar 在 Linux 上发出警告的 macOS xattrs。
  tar --no-xattrs -czf "$ARCHIVE" -C "$WORK" "synapse-${TARGET}"
fi
echo "[bundle] wrote ${ARCHIVE} ($(du -h "$ARCHIVE" | cut -f1))"
