/**
 * 目录管理
 *
 * 管理 Synapse 数据所用的 .synapse/ 目录结构。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 每个项目默认的数据目录名。 */
const DEFAULT_SYNAPSE_DIR = '.synapse';

let warnedBadDirName = false;

/**
 * 解析每个项目的数据目录名，支持通过 `SYNAPSE_DIR` 环境变量覆盖
 * （默认为 `.synapse`）。覆盖值是一个位于项目根目录的单一路径段。
 *
 * 存在原因：共享同一工作树的两个环境绝不能共享同一个 `.synapse/`——
 * 最典型的场景是 Windows 原生与 WSL（issue #636）。守护进程锁文件
 * （`.synapse/daemon.pid`）记录的是平台特定的 pid 和 socket 路径
 * （Windows 命名管道 vs WSL Unix socket），而 WSL2 ↔ Windows 文件系统
 * 边界上的 SQLite 文件锁不可靠，两个守护进程共享同一索引有损坏风险。
 * 在一侧设置 `SYNAPSE_DIR=.synapse-win` 可让各环境在同一工作树中
 * 拥有各自独立的索引。
 *
 * 每次调用时实时读取（非启动时捕获），既保证进程级准确性，也便于测试。
 * 若覆盖值不是合法的普通目录名——为空、包含路径分隔符、为 `.`、
 * 含 `..`/路径穿越，或为绝对路径——则忽略该值（保留默认），以免
 * 将索引写到项目外部或项目根目录本身；我们向 stderr 警告一次，
 * 以便用户发现配置错误。
 */
export function synapseDirName(): string {
  const raw = process.env.SYNAPSE_DIR?.trim();
  if (!raw) return DEFAULT_SYNAPSE_DIR;
  const invalid =
    raw === '.' ||
    raw.includes('..') ||
    raw.includes('/') ||
    raw.includes('\\') ||
    path.isAbsolute(raw);
  if (invalid) {
    if (!warnedBadDirName) {
      warnedBadDirName = true;
      // 仅写入 stderr——stdout 是 MCP 协议通道。
      console.warn(
        `[synapse] Ignoring invalid SYNAPSE_DIR="${raw}" — it must be a plain ` +
          `directory name (no path separators, no "..", not absolute). Using "${DEFAULT_SYNAPSE_DIR}".`
      );
    }
    return DEFAULT_SYNAPSE_DIR;
  }
  return raw;
}

/**
 * Synapse 目录名——{@link synapseDirName} 在加载时的快照。
 * 运行中进程的环境是固定的，因此此值与实时值相等；
 * 保留为稳定字符串导出以向后兼容。内部代码通过
 * {@link synapseDirName} / {@link getSynapseDir} 解析目录名，
 * 以确保 `SYNAPSE_DIR` 覆盖始终生效。
 */
export const SYNAPSE_DIR = synapseDirName();

/**
 * `name`（单个路径段）是否为 Synapse 数据目录？匹配默认的
 * `.synapse`、当前激活的 `SYNAPSE_DIR` 覆盖值，以及所有
 * `.synapse-*` 同级目录。文件监视器和索引器会跳过所有这些目录，
 * 从而确保当两个环境共享同一工作树时（Windows + WSL，issue #636），
 * 互不索引或监视对方的索引目录。
 */
export function isSynapseDataDir(name: string): boolean {
  return (
    name === DEFAULT_SYNAPSE_DIR ||
    name === synapseDirName() ||
    name.startsWith(DEFAULT_SYNAPSE_DIR + '-')
  );
}

/**
 * 获取项目的 .synapse 目录路径
 */
export function getSynapseDir(projectRoot: string): string {
  return path.join(projectRoot, synapseDirName());
}

/**
 * 检查项目是否已通过 Synapse 初始化
 * 需要 .synapse/ 目录和 synapse.db 同时存在
 */
export function isInitialized(projectRoot: string): boolean {
  const synapseDir = getSynapseDir(projectRoot);
  if (!fs.existsSync(synapseDir) || !fs.statSync(synapseDir).isDirectory()) {
    return false;
  }
  // 必须有 synapse.db，仅有 .synapse 文件夹还不够
  const dbPath = path.join(synapseDir, 'synapse.db');
  return fs.existsSync(dbPath);
}

/**
 * 查找包含 .synapse/ 的最近父目录
 *
 * 从给定路径向上遍历，查找已初始化 Synapse 的项目，
 * 类似于 git 查找 .git/ 目录的方式。
 *
 * @param startPath - 开始搜索的目录
 * @returns 包含 .synapse/ 的项目根目录，未找到则返回 null
 */
/**
 * 该目录作为索引根目录不安全的原因，安全时返回 null。
 *
 * 将主目录或文件系统根作为索引会拖入缓存、`Library`、所有其他项目等——
 * 导致数 GB 的索引、持续的文件监视器抖动，以及（macOS 1.0 之前）耗尽
 * `kern.maxfiles` 并拖垮不相关应用甚至整个机器的文件描述符爆炸（#845）。
 * 典型触发场景：从 `$HOME` 运行安装器或 `synapse init`，会自动索引当前目录。
 * 这些目录从来就不是预期的项目根，因此安装器和 `init`/`index` 会拒绝它们
 * （可用 `--force` 覆盖）。
 *
 * 基本纯函数（仅读取 `os.homedir()` + realpath），便于单元测试。
 * 返回的字符串是人类可读的短语，可嵌入"… looks like {reason}"。
 */
export function unsafeIndexRootReason(projectRoot: string): string | null {
  const resolve = (p: string): string => {
    try {
      return fs.realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  const resolved = resolve(projectRoot);

  // 文件系统根：POSIX 上为 `/`，Windows 上为盘符根如 `C:\`。
  if (path.parse(resolved).root === resolved) {
    return 'the filesystem root';
  }

  const home = resolve(os.homedir());
  // macOS/Windows 上大小写不敏感（保留大小写但不区分大小写的文件系统）。
  const norm = (p: string): string =>
    process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p;
  const r = norm(resolved);
  const h = norm(home);

  if (r === h) {
    return 'your home directory';
  }
  // 主目录的上级（如 `/Users`、`/home`）——范围比主目录更广。
  if (h.startsWith(r + path.sep)) {
    return 'a parent of your home directory';
  }
  return null;
}

export function findNearestSynapseRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    if (isInitialized(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // 已到达文件系统根
    current = parent;
  }

  // 同样检查根目录
  if (isInitialized(current)) {
    return current;
  }

  return null;
}

/**
 * `.synapse/.gitignore` 的内容。单个通配符忽略规则将索引目录中的所有
 * 临时文件——数据库、`daemon.pid`、socket、日志、缓存，以及未来版本
 * 可能新增的任何文件——排除在 git 之外，而无需逐一列举每个文件名
 * （issue #788、#492、#484）。旧版本写的是显式白名单，从未列出
 * `daemon.pid` 或 socket，导致这些运行时文件被静默提交。
 */
const GITIGNORE_CONTENT = `# Synapse data files — local to each machine, not for committing.
# Ignore everything in .synapse/ except this file itself, so transient
# files (the database, daemon.pid, sockets, logs) never show up in git.
*
!.gitignore
`;

/** 前缀行，标识 Synapse 自动生成的每个 .gitignore。 */
const GITIGNORE_MARKER = '# Synapse data files';

/**
 * `content` 是否为一个过时的 Synapse 生成的 `.gitignore`，需要原地
 * 重新生成？当它带有我们的标头但早于通配符忽略（没有裸 `*` 行）时
 * 返回 true——即旧版显式白名单（`*.db`、`cache/`、`.dirty`……），
 * 它们从未忽略 `daemon.pid` 或 socket（issue #788）。没有我们标头的
 * 文件是用户自定义的，保持不动；已包含通配符的文件是最新的。
 * 通过匹配标头（而非逐字节比对历史默认值）可修复所有旧变体——
 * v0.7.x 到 0.9.9——且升级后幂等。
 */
function isStaleDefaultGitignore(content: string): boolean {
  if (!content.trimStart().startsWith(GITIGNORE_MARKER)) return false;
  return !content.split('\n').some((line) => line.trim() === '*');
}

/**
 * 若 `.synapse/.gitignore` 不存在则写入，若为过时的 Synapse 生成
 * 默认值则原地升级；用户自定义文件保持不动。
 * 尽力而为——仅在必要的写入失败时返回 `false`。
 */
function ensureGitignore(gitignorePath: string): boolean {
  let existing: string | null;
  try {
    existing = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    existing = null; // 不存在（ENOENT）或不可读——在下方（重新）创建
  }
  // 当前默认值或用户自定义文件：无需操作。
  if (existing !== null && !isStaleDefaultGitignore(existing)) return true;
  try {
    fs.writeFileSync(gitignorePath, GITIGNORE_CONTENT, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建 .synapse 目录结构
 * 注意：仅当 synapse.db 已存在时抛出异常，仅有 .synapse/ 目录不会抛出。
 */
export function createDirectory(projectRoot: string): void {
  const synapseDir = getSynapseDir(projectRoot);
  const dbPath = path.join(synapseDir, 'synapse.db');

  // 仅当 Synapse 已实际初始化（db 存在）时才抛出异常
  // 仅有 .synapse/ 文件夹是允许的
  if (fs.existsSync(dbPath)) {
    throw new Error(`Synapse already initialized in ${projectRoot}`);
  }

  // 创建主目录（如果不存在）
  fs.mkdirSync(synapseDir, { recursive: true });

  // 在 .synapse 内写入 .gitignore（不存在则创建，若为旧版本遗留的
  // 过时预通配符默认值则升级——issue #788）。
  ensureGitignore(path.join(synapseDir, '.gitignore'));
}

/**
 * 删除 .synapse 目录
 */
export function removeDirectory(projectRoot: string): void {
  const synapseDir = getSynapseDir(projectRoot);

  if (!fs.existsSync(synapseDir)) {
    return;
  }

  // 验证 .synapse 是真实目录，而非指向其他位置的符号链接
  const lstat = fs.lstatSync(synapseDir);
  if (lstat.isSymbolicLink()) {
    // 仅删除符号链接本身，绝不跟随它进行递归删除
    fs.unlinkSync(synapseDir);
    return;
  }

  if (!lstat.isDirectory()) {
    // 不是目录——删除单个文件
    fs.unlinkSync(synapseDir);
    return;
  }

  // 递归删除目录
  fs.rmSync(synapseDir, { recursive: true, force: true });
}

/**
 * 获取 .synapse 目录中的所有文件
 */
export function listDirectoryContents(projectRoot: string): string[] {
  const synapseDir = getSynapseDir(projectRoot);

  if (!fs.existsSync(synapseDir)) {
    return [];
  }

  const files: string[] = [];

  function walkDir(dir: string, prefix: string = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // 跳过符号链接，以防跟随链接到 .synapse 外部
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walkDir(synapseDir);
  return files;
}

/**
 * 获取 .synapse 目录的总大小（字节）
 */
export function getDirectorySize(projectRoot: string): number {
  const synapseDir = getSynapseDir(projectRoot);

  if (!fs.existsSync(synapseDir)) {
    return 0;
  }

  let totalSize = 0;

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // 跳过符号链接，以防跟随链接到 .synapse 外部
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        const stats = fs.statSync(fullPath);
        totalSize += stats.size;
      }
    }
  }

  walkDir(synapseDir);
  return totalSize;
}

/**
 * 确保 .synapse 内的子目录存在
 */
export function ensureSubdirectory(projectRoot: string, subdirName: string): string {
  if (subdirName.includes('..') || subdirName.includes(path.sep) || subdirName.includes('/')) {
    throw new Error(`Invalid subdirectory name: ${subdirName}`);
  }

  const subdirPath = path.join(getSynapseDir(projectRoot), subdirName);

  if (!fs.existsSync(subdirPath)) {
    fs.mkdirSync(subdirPath, { recursive: true });
  }

  return subdirPath;
}

/**
 * 检查 .synapse 目录结构是否有效
 */
export function validateDirectory(projectRoot: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const synapseDir = getSynapseDir(projectRoot);

  if (!fs.existsSync(synapseDir)) {
    errors.push('Synapse directory does not exist');
    return { valid: false, errors };
  }

  if (!fs.statSync(synapseDir).isDirectory()) {
    errors.push('.synapse exists but is not a directory');
    return { valid: false, errors };
  }

  // 自动修复/升级 .gitignore（非关键文件）。缺失时重新创建；
  // 从未忽略 daemon.pid 的过时预通配符默认值原地重新生成
  // （issue #788）；用户自定义文件保持不动。
  const gitignorePath = path.join(synapseDir, '.gitignore');
  const existedBefore = fs.existsSync(gitignorePath);
  if (!ensureGitignore(gitignorePath) && !existedBefore) {
    // 仅在文件缺失且无法创建时上报错误；对现有文件的原地升级失败
    // 是非致命的——索引仍可正常工作。
    errors.push('.gitignore missing in .synapse directory and could not be created');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
