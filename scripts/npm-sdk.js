'use strict';
//
// @colbymchenry/synapse 的编程/嵌入式 SDK 入口（issue #354）。
//
// CLI/MCP `bin`（npm-shim.js）会执行各平台 bundle 自带的 Node 24，
// 使工具永远不依赖用户的运行时。嵌入式库消费者是相反的情况：
// 他们已经运行自己的 Node，只需要编译后的 API——
// `require("@colbymchenry/synapse")` 返回 Synapse 类等。
//
// 编译后的库及其生产依赖（web-tree-sitter、tree-sitter-wasms……）
// 随各平台 bundle 一起发布，位于
//   @colbymchenry/synapse-<platform>-<arch>/lib/dist/index.js
//（依赖在同级的 lib/node_modules 中）。重导出该 bundle 使主包保持精简——
// 无需第二份 50 MB 语法文件副本——同时让 SDK 在消费者进程中工作。
// 类型是独立关注点：主包随附自己的 dist/**/*.d.ts 树（由 `types` 指向），
// 由同一次发布构建，因此永远不会与重导出的运行时产生偏差。
//
// node:sqlite（Node >= 22.5）是打开图所必需的，但仅在 SQLite 适配器内部
// 懒加载——因此在旧版 Node 上加载本模块是安全的，node:sqlite 需求仅在
// 实际打开 DB 时才会以可操作的错误浮现。大型提取还需要打包启动器的
// --liftoff-only 标志（WASM Zone-OOM 防护，issues #293/#298）；
// 驱动大规模索引的嵌入式宿主应将该标志传递给自己的 Node。

var path = require('path');
var os = require('os');
var fs = require('fs');

var target = process.platform + '-' + process.arch; // e.g. darwin-arm64, linux-x64
var pkg = '@colbymchenry/synapse-' + target;

module.exports = require(resolveLibrary());

// 在已安装的各平台 bundle 中定位编译库入口。
// 当没有 bundle 时抛出可操作错误（而非裸 MODULE_NOT_FOUND），
// 使嵌入式消费者确切知道需要安装什么。
function resolveLibrary() {
  // 1) npm 安装的可选依赖——正常情况。
  try {
    return require.resolve(pkg + '/lib/dist/index.js');
  } catch (e) {
    /* 继续尝试自愈缓存 */
  }

  // 2) CLI shim 从 GitHub Releases 自愈到缓存的 bundle（issue #303）。
  //    与 npm 包相同的 node/lib/bin 布局。此处仅复用缓存 bundle——
  //    与 CLI shim 不同，我们不会在 require() 内部触发网络下载，
  //    该操作必须保持同步且轻量。
  var cached = cachedLibrary();
  if (cached) return cached;

  throw new Error(
    'synapse: the programmatic API is unavailable because the platform bundle\n' +
    '(' + pkg + ') is not installed.\n' +
    'The compiled library ships inside that per-platform optional dependency.\n' +
    'Fixes:\n' +
    '  - install from the official npm registry so the matching bundle is fetched:\n' +
    '      npm i @colbymchenry/synapse --registry=https://registry.npmjs.org\n' +
    '  - or run the CLI once (e.g. `npx @colbymchenry/synapse status`) to\n' +
    '    self-heal the bundle into ~/.synapse, then require() will find it.'
  );
}

function cachedLibrary() {
  try {
    var version = require(path.join(__dirname, 'package.json')).version;
    var base = process.env.SYNAPSE_INSTALL_DIR || path.join(os.homedir(), '.synapse');
    var lib = path.join(base, 'bundles', target + '-' + version, 'lib', 'dist', 'index.js');
    if (fs.existsSync(lib)) return lib;
  } catch (e) {
    /* 无可读缓存 → 由调用方报告安装指引 */
  }
  return null;
}
