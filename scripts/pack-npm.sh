#!/usr/bin/env bash
#
# 从已构建的 bundle 组装 npm 精简安装器包（esbuild 模式）。
#
# 在 release/npm/ 下产出：
#   synapse-<target>/   每个已构建 bundle 对应一个——内置 Node + 应用，
#                         附带 os/cpu 标记，使 npm 仅安装匹配的平台包。
#   main/                 @colbymchenry/synapse shim 包：一个小型 bin，
#                         负责执行匹配的平台 bundle，所有平台包位于
#                         optionalDependencies 中。
#
# 发布流水线随后对每个目录执行 `npm publish`。本脚本不修改仓库的
# package.json——开发/从源码路径保持正常工作；*已发布*主包的结构在此生成。
#
# 前提：先为每个 target 运行 build-bundle.sh（release/synapse-*.tar.gz）。
# 用法：scripts/pack-npm.sh [version]    （默认：从 package.json 读取版本）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:-$(node -p "require('$ROOT/package.json').version")}"
SCOPE="@colbymchenry"
REL="$ROOT/release"
NPM="$REL/npm"

rm -rf "$NPM"
mkdir -p "$NPM/main"

shopt -s nullglob
archives=("$REL"/synapse-*.tar.gz "$REL"/synapse-*.zip)
[ ${#archives[@]} -gt 0 ] || { echo "[pack-npm] no bundles in $REL — run build-bundle.sh first" >&2; exit 1; }

targets=()
for archive in "${archives[@]}"; do
  fname="$(basename "$archive")"
  case "$fname" in
    *.tar.gz) base="${fname%.tar.gz}" ;;   # synapse-<target>
    *.zip)    base="${fname%.zip}" ;;
  esac
  target="${base#synapse-}"             # <target>, e.g. darwin-arm64 / win32-x64
  os="${target%-*}"                       # darwin | linux | win32
  arch="${target##*-}"                    # arm64 | x64
  pkgdir="$NPM/$base"
  mkdir -p "$pkgdir"
  case "$fname" in
    *.zip)
      tmpx="$(mktemp -d)"
      unzip -q "$archive" -d "$tmpx"
      mv "$tmpx/synapse-${target}"/* "$pkgdir"/
      rm -rf "$tmpx"
      nodefile="node.exe"
      ;;
    *)
      tar -xzf "$archive" -C "$pkgdir" --strip-components=1
      nodefile="node"
      ;;
  esac
  VERSION="$VERSION" SCOPE="$SCOPE" TARGET="$target" OSV="$os" ARCHV="$arch" NODEFILE="$nodefile" \
    node -e '
      const fs=require("fs");
      fs.writeFileSync(process.argv[1], JSON.stringify({
        name: `${process.env.SCOPE}/synapse-${process.env.TARGET}`,
        version: process.env.VERSION,
        description: `Synapse self-contained bundle for ${process.env.TARGET}`,
        os: [process.env.OSV], cpu: [process.env.ARCHV],
        files: [process.env.NODEFILE, "lib", "bin"],
        license: "MIT"
      }, null, 2) + "\n");
    ' "$pkgdir/package.json"
  targets+=("$target")
  echo "[pack-npm] ${SCOPE}/synapse-${target}@${VERSION}"
done

# 主 shim 包。
#   npm-shim.js  CLI/MCP 启动器（执行打包的 Node）——`bin` 入口。
#   npm-sdk.js   编程/嵌入式入口（#354）：重导出已安装平台 bundle
#                的编译库——`main` 入口。
#   dist/        仅包含 .d.ts 类型树。运行时 .js 留在各平台 bundle 中，
#                避免在此处重复依赖。
cp "$ROOT/scripts/npm-shim.js" "$NPM/main/npm-shim.js"
cp "$ROOT/scripts/npm-sdk.js" "$NPM/main/npm-sdk.js"
[ -f "$ROOT/README.md" ] && cp "$ROOT/README.md" "$NPM/main/README.md"

# 随包发布类型声明，使 `types`/`exports.types` 能正确解析。
# 由同一次发布构建，因此不会与运行时 npm-sdk.js 重导出内容产生偏差。
[ -f "$ROOT/dist/index.d.ts" ] || ( echo "[pack-npm] building dist for .d.ts" >&2 && cd "$ROOT" && npm run build >/dev/null )
ROOT="$ROOT" DEST="$NPM/main" node -e '
  const fs=require("fs"), path=require("path");
  const src=path.join(process.env.ROOT,"dist"), dest=path.join(process.env.DEST,"dist");
  fs.cpSync(src, dest, { recursive:true, filter(s){
    try { return fs.statSync(s).isDirectory() || s.endsWith(".d.ts"); } catch (e) { return false; }
  }});
'

VERSION="$VERSION" SCOPE="$SCOPE" TARGETS="${targets[*]}" \
  node -e '
    const fs=require("fs");
    const opt={};
    for (const t of process.env.TARGETS.split(/\s+/).filter(Boolean))
      opt[`${process.env.SCOPE}/synapse-${t}`]=process.env.VERSION;
    fs.writeFileSync(process.argv[1], JSON.stringify({
      name: `${process.env.SCOPE}/synapse`,
      version: process.env.VERSION,
      description: "Local-first code intelligence for AI agents (MCP). Self-contained — bundles its own runtime.",
      bin: { synapse: "npm-shim.js" },
      main: "npm-sdk.js",
      types: "dist/index.d.ts",
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./npm-sdk.js" },
        "./package.json": "./package.json"
      },
      optionalDependencies: opt,
      files: ["npm-shim.js","npm-sdk.js","dist","README.md"],
      license: "MIT"
    }, null, 2) + "\n");
  ' "$NPM/main/package.json"

echo "[pack-npm] ${SCOPE}/synapse@${VERSION} (${#targets[@]} platform packages in optionalDependencies)"
echo "[pack-npm] output: $NPM"
