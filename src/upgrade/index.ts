/**
 * `synapse upgrade`
 *
 * CLI 的自我更新，支持所有安装方式：
 *
 *   - **bundle** — 由 `install.sh`（Linux/macOS）或 `install.ps1`（Windows）
 *     安装的包含运行时的自包含包。升级时重新运行同一个规范安装脚本
 *     （单一真实来源），以确保下载/版本解析/PATH 逻辑在首次安装和
 *     升级之间不会出现偏差。
 *   - **npm** — 通过 `npm i -g @colbymchenry/synapse` 安装。升级时调用 npm。
 *   - **npx** — 临时使用；无需升级（下次 `npx` 会自动获取最新版本）。
 *   - **source** — 运行自身 `dist/` 的 git 检出；通过 `git pull` + 重新构建升级。
 *
 * 检测基于结构（参见 `detectInstallMethod`）：bundle 在其 `lib/` 旁边
 * 携带一个内嵌的 `node` 二进制文件和一个 `bin/synapse` 启动器，
 * 因此可以从运行文件的路径识别，无需标记文件。
 *
 * Windows 特殊情况：正在运行的 `node.exe` 被锁定无法删除，
 * 因此 bundle 的 `current\` 目录不能被执行升级的进程原地覆盖。
 * 为此我们派生一个分离的辅助进程，等待当前进程退出（释放锁）后再运行
 * `install.ps1`。这是 Windows 自我更新的惯例做法（rustup/nvm-windows 同样如此）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { spawnSync } from 'child_process';

export const REPO = 'colbymchenry/synapse';
export const NPM_PACKAGE = '@colbymchenry/synapse';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
export const INSTALL_SH_URL = `${RAW_BASE}/install.sh`;

// ---------------------------------------------------------------------------
// 安装方式检测（纯函数——可通过注入的探针完整进行单元测试）
// ---------------------------------------------------------------------------

export type InstallMethod =
  | { kind: 'bundle'; os: 'unix' | 'windows'; bundleRoot: string; installDir: string | null }
  | { kind: 'npm'; scope: 'global' | 'local' }
  | { kind: 'npx' }
  | { kind: 'source'; root: string }
  | { kind: 'unknown'; reason: string };

export interface DetectInput {
  /** 运行中 CLI 模块的 `__filename`——`<…>/dist/bin/synapse.js`。 */
  filename: string;
  platform: NodeJS.Platform;
  cwd: string;
  /** 可注入的存在性探针（默认为 `fs.existsSync`）——用于测试。 */
  exists?: (p: string) => boolean;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * bundle 安装器保存其安装根目录的位置，从 bundle 目录推导，
 * 以便升级时复用自定义的 `SYNAPSE_INSTALL_DIR`。当布局与安装器
 * 创建的不符时返回 null（此时安装器回退到其默认值）。
 *
 *   unix:    <installDir>/versions/<vX.Y.Z>   (bundleRoot)  → <installDir>
 *   windows: <installDir>\current             (bundleRoot)  → <installDir>
 */
export function deriveInstallDir(
  bundleRoot: string,
  os: 'unix' | 'windows',
  exists: (p: string) => boolean
): string | null {
  // 使用目标平台的路径语义（而非宿主平台的），以便在 POSIX 宿主（CI）上
  // 推断 Windows 布局时结果确定性一致，反之亦然。生产环境中 `os` 始终与运行平台匹配。
  const P = os === 'windows' ? path.win32 : path.posix;
  if (os === 'windows') {
    if (P.basename(bundleRoot).toLowerCase() === 'current') {
      return P.dirname(bundleRoot);
    }
    return null;
  }
  // unix：bundleRoot 为 <installDir>/versions/<version>
  const parent = P.dirname(bundleRoot);
  if (P.basename(parent) === 'versions') {
    const installDir = P.dirname(parent);
    return exists(installDir) ? installDir : P.dirname(parent);
  }
  return null;
}

export function detectInstallMethod(input: DetectInput): InstallMethod {
  const exists = input.exists ?? fs.existsSync;
  const isWin = input.platform === 'win32';
  // 路径计算以目标平台为基准，使检测与宿主无关
  // （Windows 布局在 macOS/Linux 单元测试中也能正确解析）。
  const P = isWin ? path.win32 : path.posix;
  const binDir = P.dirname(input.filename); // <…>/bin

  // bundle：<root>/lib/dist/bin/synapse.js → <root> 在 bin/ 上方第 3 层。
  // bundle 在 lib/ 旁边携带内嵌的 node 二进制文件 + 启动脚本。
  const bundleRoot = P.resolve(binDir, '..', '..', '..');
  const vendoredNode = P.join(bundleRoot, isWin ? 'node.exe' : 'node');
  const launcher = P.join(bundleRoot, 'bin', isWin ? 'synapse.cmd' : 'synapse');
  if (exists(vendoredNode) && exists(launcher)) {
    const os = isWin ? 'windows' : 'unix';
    return { kind: 'bundle', os, bundleRoot, installDir: deriveInstallDir(bundleRoot, os, exists) };
  }

  const norm = toPosix(input.filename);

  // npx 缓存路径：<…>/_npx/<hash>/node_modules/@colbymchenry/synapse/…
  if (norm.includes('/_npx/')) {
    return { kind: 'npx' };
  }

  // npm install（全局或本地）：位于 node_modules 树下。
  if (norm.includes('/node_modules/')) {
    const underCwd = norm.startsWith(toPosix(P.resolve(input.cwd)) + '/');
    return { kind: 'npm', scope: underCwd ? 'local' : 'global' };
  }

  // 源码检出：运行 <repo>/dist/bin/synapse.js 且同级目录有 .git。
  const repoRoot = P.resolve(binDir, '..', '..');
  if (exists(P.join(repoRoot, 'package.json')) && exists(P.join(repoRoot, '.git'))) {
    return { kind: 'source', root: repoRoot };
  }

  return { kind: 'unknown', reason: `unrecognized install layout at ${input.filename}` };
}

// ---------------------------------------------------------------------------
// 版本辅助函数（纯函数）
// ---------------------------------------------------------------------------

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

export function parseSemver(version: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!m) return null;
  return {
    major: parseInt(m[1]!, 10),
    minor: parseInt(m[2]!, 10),
    patch: parseInt(m[3]!, 10),
    pre: m[4] ?? null,
  };
}

/** 返回值 >0 表示 a>b，<0 表示 a<b，0 表示相等；输入无法解析时抛出异常。 */
export function compareVersions(a: string, b: string): number {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (!sa || !sb) throw new Error(`cannot compare versions: "${a}" vs "${b}"`);
  if (sa.major !== sb.major) return sa.major - sb.major;
  if (sa.minor !== sb.minor) return sa.minor - sb.minor;
  if (sa.patch !== sb.patch) return sa.patch - sb.patch;
  // 预发布版本"小于"其正式版本（1.0.0-rc < 1.0.0）。
  if (sa.pre && !sb.pre) return -1;
  if (!sa.pre && sb.pre) return 1;
  if (sa.pre && sb.pre) return sa.pre < sb.pre ? -1 : sa.pre > sb.pre ? 1 : 0;
  return 0;
}

export function isUpdateAvailable(current: string, latest: string): boolean {
  try {
    return compareVersions(latest, current) > 0;
  } catch {
    // 若任一版本无法解析（如开发版 `"0.0.0-unknown"`），
    // 将不同的字符串视为"有可用更新"，以免用户卡住。
    return normalizeVersion(current) !== normalizeVersion(latest);
  }
}

/** 规范化版本号：`0.9.9` / `v0.9.9` → `v0.9.9`（发布标签带 `v` 前缀）。 */
export function normalizeVersion(v: string): string {
  const t = v.trim();
  return t.startsWith('v') ? t : `v${t}`;
}

/** 去掉版本号开头的 `v` 前缀：`v0.9.9` → `0.9.9`。 */
export function stripV(v: string): string {
  const t = v.trim();
  return t.startsWith('v') ? t.slice(1) : t;
}

/**
 * 从 GitHub 为 `/releases/latest` 返回的 `Location` 响应头中解析发布标签，
 * 格式为 `…/releases/tag/v0.9.9`。纯函数，便于单元测试。
 */
export function parseLatestTagFromLocation(location: string | undefined): string | null {
  if (!location) return null;
  const m = /\/releases\/tag\/([^/?#]+)/.exec(location);
  return m ? decodeURIComponent(m[1]!) : null;
}

// ---------------------------------------------------------------------------
// 最新版本解析（需网络）
// ---------------------------------------------------------------------------

function httpsGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
  });
}

/**
 * 解析最新发布标签（如 `v0.9.9`）。
 *
 * 主要方式：读取 `github.com/<repo>/releases/latest` 返回的重定向 `Location` 头——
 * 与 install.sh 使用的技巧相同，因为未认证的 GitHub API 限速为 60 次/小时/IP，
 * 在共享/云主机上会返回 403（issue #325）。重定向无此限制。
 * 仅在无法读取重定向时才回退到 API。
 */
export async function resolveLatestVersion(repo = REPO, timeoutMs = 12000): Promise<string> {
  try {
    const res = await httpsGet(
      `https://github.com/${repo}/releases/latest`,
      { 'User-Agent': 'synapse-upgrade' },
      timeoutMs
    );
    const loc = res.headers.location;
    const tag = parseLatestTagFromLocation(Array.isArray(loc) ? loc[0] : loc);
    if (tag) return normalizeVersion(tag);
  } catch {
    /* 回退到 API */
  }
  try {
    const res = await httpsGet(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { 'User-Agent': 'synapse-upgrade', Accept: 'application/vnd.github+json' },
      timeoutMs
    );
    const tag = JSON.parse(res.body)?.tag_name;
    if (typeof tag === 'string' && tag) return normalizeVersion(tag);
  } catch {
    /* 回退到错误处理 */
  }
  throw new Error(
    'could not resolve the latest version from GitHub. Check your network, or pin a version: `synapse upgrade <version>`.'
  );
}

// ---------------------------------------------------------------------------
// 编排器
// ---------------------------------------------------------------------------

export interface UpgradeOptions {
  /** 指定特定版本（位置参数或 SYNAPSE_VERSION）。 */
  version?: string;
  /** 报告当前版本与最新版本，不做任何修改。 */
  check?: boolean;
  /** 即使已是目标版本也强制重新安装。 */
  force?: boolean;
}

/** 可注入的副作用接口，使编排器保持可单元测试。 */
export interface UpgradeDeps {
  currentVersion: string;
  method: InstallMethod;
  resolveLatest: (pin?: string) => Promise<string>;
  /** 继承 stdio 运行命令；返回退出码（-1 表示派生失败）。 */
  run: (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => number;
  hasCommand: (cmd: string) => boolean;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  platform: NodeJS.Platform;
}

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/** 成功升级后显示的诚实、附加式重新索引提醒。 */
export function reindexAdvisory(): string {
  return [
    c.dim('Your existing project indexes keep working, but were built by the previous version.'),
    c.dim("To pick up this version's extraction improvements, refresh each project:"),
    `  ${c.cyan('synapse sync')}        ${c.dim('# incremental, fast')}`,
    `  ${c.cyan('synapse index -f')}    ${c.dim('# full rebuild')}`,
    c.dim("(`synapse status` flags any index that predates the engine you're running.)"),
  ].join('\n');
}

/**
 * 返回进程退出码（0 = 成功/无需操作，1 = 失败）。
 */
export async function runUpgrade(opts: UpgradeOptions, deps: UpgradeDeps): Promise<number> {
  const { currentVersion, method } = deps;

  // 解析目标版本（固定版本或最新版本）。
  let latest: string;
  try {
    latest = normalizeVersion(opts.version || (await deps.resolveLatest()));
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const currentDisplay = normalizeVersion(currentVersion);
  deps.log(`${c.bold('Synapse')}  current ${c.cyan(currentDisplay)}  ${opts.version ? 'target' : 'latest'} ${c.cyan(latest)}`);

  const updateAvailable = isUpdateAvailable(currentVersion, latest);

  if (opts.check) {
    if (updateAvailable) {
      deps.log(c.yellow(`An update is available: ${currentDisplay} → ${latest}`));
      deps.log(c.dim('Run `synapse upgrade` to install it.'));
    } else {
      deps.log(c.green(`You're on the latest version (${currentDisplay}).`));
    }
    return 0;
  }

  if (!updateAvailable && !opts.force && !opts.version) {
    deps.log(c.green(`Already up to date (${currentDisplay}).`));
    deps.log(c.dim('Use `--force` to reinstall, or `synapse upgrade <version>` to change versions.'));
    return 0;
  }

  // 按安装方式分发到对应升级函数。
  switch (method.kind) {
    case 'bundle':
      return method.os === 'windows'
        ? upgradeWindowsBundle(method, latest, deps)
        : upgradeUnixBundle(method, opts.version ? latest : undefined, deps);
    case 'npm':
      // npm 版本规范不带 `v` 前缀（`@0.9.8` 而非 `@v0.9.8`——
      // 带 `v` 前缀会被解析为不存在的 dist-tag）。
      return upgradeNpm(method, opts.version ? stripV(latest) : 'latest', deps);
    case 'npx':
      deps.log(c.green('npx always runs the latest version on demand — nothing to upgrade.'));
      deps.log(c.dim(`Force a fresh fetch with: npx ${NPM_PACKAGE}@latest`));
      return 0;
    case 'source':
      deps.warn(`Running from a source checkout at ${method.root}.`);
      deps.log(c.dim('Upgrade it with: git pull && npm run build'));
      return 0;
    default:
      deps.error(`Couldn't determine how Synapse was installed (${method.reason}).`);
      deps.log(c.dim(`Reinstall manually — see https://github.com/${REPO}#install`));
      return 1;
  }
}

function upgradeUnixBundle(
  method: Extract<InstallMethod, { kind: 'bundle' }>,
  pinned: string | undefined,
  deps: UpgradeDeps
): number {
  const downloader = deps.hasCommand('curl')
    ? `curl -fsSL ${INSTALL_SH_URL}`
    : deps.hasCommand('wget')
      ? `wget -qO- ${INSTALL_SH_URL}`
      : null;
  if (!downloader) {
    deps.error('Neither curl nor wget is available to download the installer.');
    deps.log(c.dim(`Install curl, or run manually:  ${INSTALL_SH_URL} | sh`));
    return 1;
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (method.installDir) env.SYNAPSE_INSTALL_DIR = method.installDir;
  if (pinned) env.SYNAPSE_VERSION = pinned;

  deps.log(c.dim(`Running the installer (${downloader} | sh)…`));
  const code = deps.run('sh', ['-c', `${downloader} | sh`], env);
  if (code !== 0) {
    deps.error(`Installer exited with code ${code}.`);
    return 1;
  }
  deps.log('');
  deps.log(c.green('✓ Upgrade complete.') + c.dim(' Open a new terminal if the version looks unchanged (PATH cache).'));
  deps.log(reindexAdvisory());
  return 0;
}

/** 构建 Windows 原地升级脚本（导出供单元测试使用）。 */
export function buildWindowsUpgradeScript(bundleRoot: string, version: string, arch: string): string {
  const target = `win32-${arch}`;
  const url = `https://github.com/${REPO}/releases/download/${version}/synapse-${target}.zip`;
  // Windows 无法删除正在运行的 exe，但可以重命名，因此采用原地升级方式：
  // 下载 → 将被锁定的 node.exe 重命名为备份 → 将新 bundle 解压覆盖到 current\ 目录。
  // 同步操作，无需分离辅助进程（在 SSH/job 对象下不稳定，且用户体验较差）。
  // 运行中的进程仍持有已重命名的 node.exe 映射；
  // 下次调用 `synapse` 时将使用新版本。
  // 此处无法复用 install.ps1——它会 `Remove-Item` current\ 目录，而被锁定的 exe 会导致失败。
  return [
    `$ErrorActionPreference='Stop'`,
    `$dest='${bundleRoot}'`,
    `$url='${url}'`,
    `Write-Host "Downloading $url"`,
    `$tmp=Join-Path $env:TEMP ('cg-up-'+[guid]::NewGuid().ToString('N'))`,
    `New-Item -ItemType Directory -Force -Path $tmp | Out-Null`,
    `$zip=Join-Path $tmp 'cg.zip'`,
    `Invoke-WebRequest -Uri $url -OutFile $zip`,
    `$stage=Join-Path $tmp 'stage'`,
    `Expand-Archive -Path $zip -DestinationPath $stage -Force`,
    `$inner=Join-Path $stage 'synapse-${target}'`,
    `$src=if(Test-Path $inner){$inner}else{$stage}`,
    `$node=Join-Path $dest 'node.exe'`,
    `if(Test-Path $node){Rename-Item -Path $node -NewName ('node.exe.old-'+[guid]::NewGuid().ToString('N')) -Force}`,
    `Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force`,
    `Get-ChildItem -Path $dest -Filter 'node.exe.old-*' -ErrorAction SilentlyContinue | ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch {} }`,
    `Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue`,
    `Write-Host "Installed Synapse ${version} to $dest"`,
  ].join(';');
}

function upgradeWindowsBundle(
  method: Extract<InstallMethod, { kind: 'bundle' }>,
  latest: string,
  deps: UpgradeDeps
): number {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const script = buildWindowsUpgradeScript(method.bundleRoot, latest, arch);
  // 使用 `-EncodedCommand`（base64 UTF-16LE）而非 `-Command`：Node 在 Windows 上的
  // argv → 命令行引号转义会破坏长的多语句脚本，导致 PowerShell 无法解析。
  // base64 编码绕过了所有 shell 引号问题——这是 PowerShell 的标准做法。
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  deps.log(c.dim(`Downloading and installing ${latest}…`));
  const code = deps.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
  if (code !== 0) {
    deps.error(`Installer exited with code ${code}.`);
    return 1;
  }
  deps.log('');
  deps.log(c.green('✓ Upgrade complete.') + c.dim(' Open a new terminal to be safe (PATH/version cache).'));
  deps.log(reindexAdvisory());
  return 0;
}

function upgradeNpm(
  method: Extract<InstallMethod, { kind: 'npm' }>,
  versionSpec: string,
  deps: UpgradeDeps
): number {
  const npm = deps.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = method.scope === 'global'
    ? ['install', '-g', `${NPM_PACKAGE}@${versionSpec}`]
    : ['install', `${NPM_PACKAGE}@${versionSpec}`];
  deps.log(c.dim(`Running: ${npm} ${args.join(' ')}`));
  const code = deps.run(npm, args, process.env);
  if (code !== 0) {
    deps.error(`npm 以退出码 ${code} 终止。`);
    if (method.scope === 'global') {
      deps.log(c.dim('如果这是权限错误（EACCES），可对全局前缀使用 sudo，'));
      deps.log(c.dim('或改用 Node 版本管理器（nvm/fnm），避免全局安装需要 root 权限。'));
    }
    return 1;
  }
  deps.log('');
  deps.log(c.green('✓ Upgrade complete.'));
  deps.log(reindexAdvisory());
  return 0;
}

// ---------------------------------------------------------------------------
// 生产依赖注入（供 CLI 调用）
// ---------------------------------------------------------------------------

/**
 * 检查 `cmd` 是否能在 PATH 上解析为可执行文件。采用纯 Node PATH 扫描——
 * 不派生 `command -v`/`which`：`command` 是 shell 内建命令（Debian 上没有
 * 独立二进制文件，尽管 macOS 自带），`which` 在精简镜像上也不保证存在，
 * 因此两种方式均不可靠。自行扫描 PATH 在所有平台上行为一致。
 */
export function hasCommand(cmd: string): boolean {
  const isWin = process.platform === 'win32';
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (isWin) return true;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        /* 不在此处/不可执行——继续扫描 */
      }
    }
  }
  return false;
}

export function defaultRun(cmd: string, args: string[], env?: NodeJS.ProcessEnv): number {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: env ?? process.env });
  if (r.error) return -1;
  return r.status ?? -1;
}
