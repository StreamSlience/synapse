#!/usr/bin/env node
'use strict';
//
// Synapse 的 npm 精简安装器启动器。
//
// 重量级产物（内置 Node 运行时 + 应用）以各平台 optionalDependency 发布：
// @colbymchenry/synapse-<platform>-<arch>。npm 通过每个包的 `os`/`cpu` 字段
// 仅安装与宿主匹配的那一个（esbuild 模式）。本 shim——由用户自己的 Node 运行——
// 定位该 bundle 并执行其启动器，使真正的工作始终在打包的 Node 24（含 node:sqlite）
// 上运行，与用户的 Node 版本无关。用户的 Node 仅作为启动器；即使是极旧的版本
// 也能运行本文件。
//
// 自愈（issue #303）：某些注册表——尤其是 npmmirror/cnpm 镜像
// 和一些企业代理——不能可靠地镜像各平台 optionalDependencies。
// npm 将无法拉取的可选依赖视为成功并静默跳过，导致 bundle 缺失、每条命令失败。
// 当已安装 bundle 无法解析时，本 shim 回退到从 GitHub Releases 直接下载
// 匹配的 bundle——与 install.sh 使用的完全相同的归档——到缓存目录，然后运行。
// 调节旋钮：
//   SYNAPSE_NO_DOWNLOAD=1     禁用网络回退（打印指引）
//   SYNAPSE_INSTALL_DIR=DIR   缓存位置（默认：~/.synapse）
//   SYNAPSE_DOWNLOAD_BASE=URL 发布下载基础 URL（用于镜像/离线环境）
//
// 发布时作为主包的 `bin` 接入：
//   "bin": { "synapse": "npm-shim.js" }
// 平台包列于 `optionalDependencies` 中。

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var target = process.platform + '-' + process.arch; // e.g. darwin-arm64, linux-x64
var pkg = '@colbymchenry/synapse-' + target;
var isWindows = process.platform === 'win32';
var REPO = 'colbymchenry/synapse';

main().catch(function (e) {
  process.stderr.write('synapse: ' + (e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
});

async function main() {
  // 正常路径：npm 已安装的可选依赖。当注册表未能提供时回退到下载。
  var resolved = resolveInstalledBundle() || (await selfHealBundle());
  var res = childProcess.spawnSync(resolved.command, resolved.args, { stdio: 'inherit' });
  if (res.error) {
    process.stderr.write('synapse: ' + res.error.message + '\n');
    process.exit(1);
  }
  process.exit(res.status === null ? 1 : res.status);
}

// 从已安装的各平台 optionalDependency 中解析启动器。
// 返回 {command, args}，若包未安装则返回 null。
function resolveInstalledBundle() {
  try {
    if (isWindows) {
      // 现代 Node 拒绝直接 spawn bundle 的 .cmd（EINVAL，Node 24 的
      // CVE-2024-27980 加固），因此直接调用打包的 node.exe 指向应用
      // 入口点，并在此处传递 --liftoff-only。
      var nodeExe = require.resolve(pkg + '/node.exe');
      var entry = require.resolve(pkg + '/lib/dist/bin/synapse.js');
      return { command: nodeExe, args: liftoff(entry) };
    }
    return { command: require.resolve(pkg + '/bin/synapse'), args: process.argv.slice(2) };
  } catch (e) {
    return null;
  }
}

// 在解压的 GitHub bundle 目录中定位启动器（与 npm 平台包相同的
// node/lib/bin 布局）。返回 {command, args}，
// 若目录中尚无可用 bundle 则返回 null。
function launcherIn(dir) {
  if (isWindows) {
    var nodeExe = path.join(dir, 'node.exe');
    var entry = path.join(dir, 'lib', 'dist', 'bin', 'synapse.js');
    if (fs.existsSync(nodeExe) && fs.existsSync(entry)) {
      return { command: nodeExe, args: liftoff(entry) };
    }
  } else {
    var launcher = path.join(dir, 'bin', 'synapse');
    if (fs.existsSync(launcher)) return { command: launcher, args: process.argv.slice(2) };
  }
  return null;
}

// --liftoff-only 使 tree-sitter 的 WASM 语法远离 V8 turboshaft 层，
// 以避免 Node >= 22 上的 Zone OOM（issues #293/#298）。
// Unix 的 bin/synapse 启动器已传递此标志；Windows 上直接调用 node.exe，
// 因此在此处添加。
function liftoff(entry) {
  return ['--liftoff-only', entry].concat(process.argv.slice(2));
}

// 从 GitHub Releases 下载并缓存平台 bundle。返回 {command, args}；
// 无法下载时以指引信息退出进程。
async function selfHealBundle() {
  var version = readVersion();
  var bundlesDir = path.join(process.env.SYNAPSE_INSTALL_DIR || path.join(os.homedir(), '.synapse'), 'bundles');
  var dest = path.join(bundlesDir, target + '-' + version);

  // 上次运行已下载？即使禁用下载也使用它——
  // SYNAPSE_NO_DOWNLOAD 阻止拉取，不阻止已缓存的 bundle。
  var cached = launcherIn(dest);
  if (cached) return cached;

  if (process.env.SYNAPSE_NO_DOWNLOAD) {
    fail('the network fallback is disabled (SYNAPSE_NO_DOWNLOAD is set).');
  }

  var asset = 'synapse-' + target + (isWindows ? '.zip' : '.tar.gz');
  var base = process.env.SYNAPSE_DOWNLOAD_BASE || ('https://github.com/' + REPO + '/releases/download');
  var url = base + '/v' + version + '/' + asset;

  process.stderr.write(
    'synapse: platform bundle missing (registry did not provide ' + pkg + ').\n' +
    'synapse: downloading ' + asset + ' from GitHub Releases (' + version + ')...\n'
  );

  // 暂存在 bundlesDir 内，使最终重命名在同一文件系统上（原子操作，
  // 不跨 tmpfs 产生 EXDEV）。去除归档顶层的 synapse-<target>/ 目录。
  fs.mkdirSync(bundlesDir, { recursive: true });
  var stage = fs.mkdtempSync(path.join(bundlesDir, '.dl-'));
  try {
    var archivePath = path.join(stage, asset);
    await download(url, archivePath, 6);
    await verifyChecksum(archivePath, asset, base, version);
    var extracted = path.join(stage, 'bundle');
    fs.mkdirSync(extracted);
    extract(archivePath, extracted);

    var raced = launcherIn(dest); // 另一进程可能已在此期间完成
    if (raced) { rmrf(stage); return raced; }
    try {
      fs.renameSync(extracted, dest);
    } catch (e) {
      var other = launcherIn(dest); // 竞争失败但对方的 bundle 有效
      if (other) { rmrf(stage); return other; }
      throw e;
    }
  } catch (e) {
    rmrf(stage);
    fail('download failed (' + e.message + ').\n  URL: ' + url);
  }
  rmrf(stage);

  var ready = launcherIn(dest);
  if (!ready) fail('downloaded bundle is missing its launcher under ' + dest + '.');
  process.stderr.write('synapse: bundle ready.\n');
  return ready;
}

function readVersion() {
  try {
    return require(path.join(__dirname, 'package.json')).version;
  } catch (e) {
    fail('could not read this package\'s version to locate a matching release.');
  }
}

// 手动跟随重定向的 GET（GitHub release URL 会重定向到 CDN）。
function download(url, dest, redirectsLeft) {
  return new Promise(function (resolve, reject) {
    var https = require('https');
    // timeout 是空闲/不活动超时——不会终止缓慢但有进展的下载，
    // 只会终止停滞的连接（使被封锁的镜像快速失败并给出指引，
    // 而非永远挂起用户的命令）。
    var req = https.get(url, { headers: { 'User-Agent': 'synapse-npm-shim' }, timeout: 30000 }, function (res) {
      var status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) { reject(new Error('too many redirects')); return; }
        download(new URL(res.headers.location, url).toString(), dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) { res.resume(); reject(new Error('HTTP ' + status)); return; }
      var file = fs.createWriteStream(dest);
      res.on('error', reject);
      res.pipe(file);
      file.on('error', reject);
      file.on('finish', function () { file.close(function () { resolve(); }); });
    });
    req.on('timeout', function () { req.destroy(new Error('connection timed out')); });
    req.on('error', reject);
  });
}

// 尽力而为的完整性检查。当发布附有 SHA256SUMS 文件时，下载的归档必须
// 与列出的哈希匹配，否则中止。当该文件不存在（旧版本）或无法访问时，
// 继续执行——归档仍然通过 TLS 从 GitHub 到达。
// 因此篡改/损坏能被捕获，而缺少校验和永远不会破坏安装。
async function verifyChecksum(archivePath, asset, base, version) {
  var sumsPath = archivePath + '.SHA256SUMS';
  try {
    await download(base + '/v' + version + '/SHA256SUMS', sumsPath, 6);
  } catch (e) {
    return; // 未发布 / 无法访问 → 跳过
  }
  var expected = null;
  var lines = fs.readFileSync(sumsPath, 'utf8').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && path.basename(m[2].trim()) === asset) { expected = m[1].toLowerCase(); break; }
  }
  if (!expected) return; // asset 未列出 → 无需检查
  var actual = require('crypto').createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
  if (actual !== expected) {
    throw new Error('checksum mismatch for ' + asset +
      ' (expected ' + expected.slice(0, 12) + '…, got ' + actual.slice(0, 12) + '…)');
  }
  process.stderr.write('synapse: checksum verified.\n');
}

// 通过系统 tar 解压——在 macOS、Linux 和 Windows 10+ 上均可用
//（bsdtar 也能读取 .zip）。shim 中无第三方依赖。
function extract(archive, destDir) {
  var args = isWindows
    ? ['-xf', archive, '-C', destDir, '--strip-components=1']
    : ['-xzf', archive, '-C', destDir, '--strip-components=1'];
  var res = childProcess.spawnSync('tar', args, { stdio: 'ignore' });
  if (res.error) throw new Error('tar unavailable: ' + res.error.message);
  if (res.status !== 0) throw new Error('tar exited ' + res.status);
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* 尽力而为 */ }
}

function fail(reason) {
  process.stderr.write(
    'synapse: no prebuilt bundle for ' + target + '.\n' +
    (reason ? 'synapse: ' + reason + '\n' : '') +
    'Expected the optional package ' + pkg + ' to be installed.\n' +
    'A registry mirror (e.g. npmmirror/cnpm) that did not mirror the per-platform\n' +
    'package is the usual cause. Fixes:\n' +
    '  - install from the official registry:\n' +
    '      npm i -g @colbymchenry/synapse --registry=https://registry.npmjs.org\n' +
    '  - or use the standalone installer (no Node required):\n' +
    '      curl -fsSL https://raw.githubusercontent.com/' + REPO + '/main/install.sh | sh\n'
  );
  process.exit(1);
}
