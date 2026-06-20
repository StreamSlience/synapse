/**
 * 提取协调器（Extraction Orchestrator）
 *
 * 协调文件扫描、解析和数据库存储。
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import {
  Language,
  FileRecord,
  ExtractionResult,
  ExtractionError,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { extractFromSource } from './tree-sitter';
import { detectLanguage, isSourceFile, isLanguageSupported, isFileLevelOnlyLanguage, initGrammars, loadGrammarsForLanguages } from './grammars';
import { isSynapseDataDir } from '../directory';
import { logDebug, logWarn } from '../errors';
import { validatePathWithinRoot, normalizePath } from '../utils';
import ignore, { Ignore } from 'ignore';
import { detectFrameworks } from '../resolution/frameworks';
import type { ResolutionContext } from '../resolution/types';

/**
 * 索引期间并行读取的文件数量。
 * 文件读取受 I/O 限制；批处理可将 I/O 等待与 CPU 解析工作重叠执行。
 */
const FILE_IO_BATCH_SIZE = 10;

// PARSER_RESET_INTERVAL 已移至 parse-worker.ts（在 worker 线程中运行）

/**
 * 在 worker 线程中等待单个文件完成解析的最长时间（毫秒）。
 * 若 tree-sitter 挂起或 WASM 内存耗尽，此超时可防止整个索引流程被冻结。
 * 超时后 worker 将被重启。
 */
const PARSE_TIMEOUT_MS = 10_000;

/**
 * 回收 worker 线程前需解析的文件数量。
 * WASM 线性内存只能增长，永远无法缩减（WebAssembly 规范限制）。
 * 回收 tree-sitter WASM 堆的唯一方式是销毁整个 V8 isolate——
 * 即终止 worker 线程并启动新的线程。
 * 此间隔在内存占用与重新加载语法文件的开销之间取得平衡。
 */
const WORKER_RECYCLE_INTERVAL = 250;

/**
 * 索引操作的进度回调
 */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving';
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * 索引操作的结果
 */
export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  durationMs: number;
}

/**
 * 同步操作的结果
 */
export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
  changedFilePaths?: string[];
}

/**
 * 计算文件内容的 SHA256 哈希值
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * 跳过超过此大小（字节）的文件。生成的打包产物、压缩的 JS 以及
 * 第三方二进制 blob 会耗尽 WASM 堆和 worker 回收配额，却提取不到有价值的符号。
 * 1 MB 能覆盖几乎所有手写源代码。
 */
const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Synapse 所支持的语言/框架中，属于依赖、构建、缓存或工具输出的目录名——
 * 整理自 github/gitignore 模板规范。默认排除这些目录，使图谱只反映你的代码，
 * 而非第三方噪音，且无需 `.gitignore`（issue #407）。
 * 排除规则统一适用（无论是否使用 git、是否已跟踪）；唯一的加入方式是
 * 在 `.gitignore` 中显式取反（例如 `!vendor/`）。
 * 可能属于第一方代码或名称过于通用的目录（`packages`、`lib`、`app`、`bin`、
 * `src`、`deps`、`env`、`tmp`、`storage`、`Library`）故意不列入，
 * 以避免隐藏真实源代码。
 *
 * 只有实际包含*可索引源代码*（或体积巨大）的目录才会被纳入——
 * IDE/状态目录如 `.idea`/`.vs` 不列入，因为 Synapse 只索引已识别的源文件扩展名，
 * 这类目录无论如何都不会产生任何符号。
 */
const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  // JS / TS — 依赖目录
  'node_modules', 'bower_components', 'jspm_packages', 'web_modules',
  '.yarn', '.pnpm-store',
  // JS / TS — 框架及打包工具的构建/缓存/部署输出
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.vite', '.parcel-cache', '.angular',
  '.docusaurus', 'storybook-static', '.vinxi', '.nitro', 'out-tsc',
  '.vercel', '.netlify', '.wrangler',
  // 构建输出（跨生态通用）
  'dist', 'build', 'out', '.output',
  // 测试 / 覆盖率
  'coverage', '.nyc_output',
  // Python
  '__pycache__', '__pypackages__', '.venv', 'venv', '.pixi', '.pdm-build',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.nox', '.hypothesis',
  '.ipynb_checkpoints', '.eggs',
  // Rust / JVM（Maven、Gradle、Scala）
  'target', '.gradle',
  // .NET
  'obj',
  // 第三方依赖（Go、PHP/Composer、Ruby/Bundler）
  'vendor',
  // Swift / iOS
  '.build', 'Pods', 'Carthage', 'DerivedData', '.swiftpm',
  // Dart / Flutter
  '.dart_tool', '.pub-cache',
  // 原生平台（Android NDK、C/C++ 依赖）
  '.cxx', '.externalNativeBuild', 'vcpkg_installed',
  // Scala 工具链
  '.bloop', '.metals',
  // Lua / Luau（LuaRocks）
  'lua_modules', '.luarocks',
  // Delphi / RAD Studio IDE 备份（重复的 .pas 源文件——会导致重复计数）
  '__history', '__recovery',
  // 通用缓存
  '.cache',
]);

/** `ignore` 匹配器的 gitignore 风格模式：上述目录加上少量 glob。 */
const DEFAULT_IGNORE_PATTERNS: string[] = [
  ...Array.from(DEFAULT_IGNORE_DIRS, (d) => `${d}/`),
  '*.egg-info/',     // Python 打包元数据
  'cmake-build-*/',  // CLion / CMake 构建目录树
  'bazel-*/',        // Bazel 输出符号链接树
];

/** 若 `buf` 能解码为严格的 UTF-8（无无效字节序列），则返回 true。 */
function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取 `.gitignore` 并返回可安全传递给 `ignore` 匹配器的模式——
 * 即使文件内容不是合法的 gitignore 文本也不会抛出异常。
 * 现实中存在两种失败模式（issue #682）：
 *
 *  - 文件不是合法 UTF-8——例如被企业 DLP/端点安全软件就地加密，
 *    留下 UTF-16 头加密文本。这些内容没有任何有效模式，因此整个文件被跳过。
 *  - 文件是文本，但某一行无法被 `ignore` 库编译为正则——
 *    `\\[` 等字符会抛出 "Unterminated character class"。
 *    关键在于该异常是懒性的（匹配时才抛出，而非 `.add()` 时），
 *    否则会在扫描过程中意外逸出。这条有问题的模式会被丢弃，其余保留。
 *
 * 两种情况都会记录一条包含文件名的警告（报告者无法确定是哪个 `.gitignore` 出了问题），
 * 索引继续执行而不终止。
 * 无可用内容时返回 ''。
 */
function readGitignorePatterns(giPath: string): string {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(giPath);
  } catch {
    return ''; // 不可读（权限问题/竞态条件）——视作文件不存在
  }
  // NUL 字节从不出现在真实的 gitignore 文本中，而严格 UTF-8 解码可捕获其余情况。
  // 含有 NUL 字节的文件根本不是 ignore 模式。
  if (buf.includes(0) || !isValidUtf8(buf)) {
    logWarn(
      'Ignoring a .gitignore that is not valid UTF-8 text — it may have been encrypted ' +
        'in place by endpoint-security software. Indexing continues without it.',
      { file: giPath },
    );
    return '';
  }
  const content = buf.toString('utf-8');
  // 快速路径：调用一次 `.ignores()` 会强制库编译所有规则，
  // 如果不抛出异常，则整个文件可以直接使用。
  try {
    ignore().add(content).ignores('.synapse-probe');
    return content;
  } catch {
    // 回退：某行无法编译——保留有效的，丢弃有问题的。
  }
  const kept: string[] = [];
  let dropped = 0;
  for (const line of content.split(/\r?\n/)) {
    try {
      ignore().add(line).ignores('.synapse-probe');
      kept.push(line);
    } catch {
      dropped++;
    }
  }
  if (dropped > 0) {
    logWarn(
      `Skipped ${dropped} unparseable pattern(s) in a .gitignore; the rest are applied.`,
      { file: giPath },
    );
  }
  return kept.join('\n');
}

/**
 * 以内置默认值为种子的 `ignore` 匹配器，并与项目根目录的 .gitignore 合并，
 * 使其中的取反规则（例如 `!vendor/`）能覆盖默认值。
 * 两条枚举路径共用此匹配器，确保有无 git 时行为一致——
 * 同时也使默认规则对已跟踪文件生效（将依赖目录提交并不使其成为项目代码；
 * 显式的 `.gitignore` 取反是唯一的加入方式）。
 */
export function buildDefaultIgnore(rootDir: string): Ignore {
  const ig = ignore().add(DEFAULT_IGNORE_PATTERNS);
  const rootGitignore = path.join(rootDir, '.gitignore');
  if (fs.existsSync(rootGitignore)) ig.add(readGitignorePatterns(rootGitignore));
  return ig;
}

/**
 * 仅含内置默认值的 ignore 匹配器（不合并根目录 `.gitignore`）。
 * 用于父仓库的 ignore 规则不应生效的场合——即嵌套子仓库内部，
 * 子仓库的 gitignore 语义已由其自身的 `git ls-files` 执行（#514）。
 */
function defaultsOnlyIgnore(): Ignore {
  return ignore().add(DEFAULT_IGNORE_PATTERNS);
}

/**
 * 列出仓库中被 gitignore 的目录（折叠后带尾部斜杠的形式），
 * 路径相对于 `repoDir`。这些目录对所有其他 `git ls-files`/`git status` 模式均不可见——
 * 而在多仓库工作区中，嵌套项目仓库恰好就住在这些地方（父仓库将子仓库加入 `.gitignore`
 * 以保持 `git status` 清洁；这并不使它们成为第三方代码）。（#514）
 */
function listIgnoredDirs(repoDir: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '-o', '-i', '--exclude-standard', '--directory'],
      { cwd: repoDir, encoding: 'utf-8' as const, timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    return out.split('\0').filter((e) => e.endsWith('/'));
  } catch {
    return [];
  }
}

/** 在被忽略目录下搜索嵌套 `.git` 根节点的最大目录深度。 */
const EMBEDDED_REPO_SEARCH_DEPTH = 4;
/** 每次搜索最多检查的目录数——体积巨大的被忽略数据目录绝不能拖慢扫描/同步。 */
const EMBEDDED_REPO_SEARCH_ENTRIES = 2000;

/**
 * 对目录的 `.git` 条目进行分类，用于嵌套仓库发现。
 *
 * - `.git` 为**目录**时：这是一个嵌套克隆——父仓库仅在 git 层面隐藏的独立第一方代码；
 *   应为其建立索引（#193、#514）。
 * - `.git` 为**文件**时：这是一个指针（`gitdir: …`）。git **工作树**指向
 *   宿主仓库自身的 `.git/worktrees/<name>`，因此它是某个已被 Synapse 索引仓库的
 *   第二个工作视图——为其建立索引只会将整个图谱重复 N 遍；跳过（#848）。
 *   **子模块**指向 `.git/modules/`，属于独立代码，因此照常建立索引。
 *
 * 当此处没有 `.git` 条目时返回 `'none'`。
 */
function classifyGitDir(absDir: string): 'embedded' | 'worktree' | 'none' {
  let st: fs.Stats;
  try {
    st = fs.statSync(path.join(absDir, '.git'));
  } catch {
    return 'none';
  }
  if (st.isDirectory()) return 'embedded';
  if (!st.isFile()) return 'none';
  try {
    const gitdir = fs.readFileSync(path.join(absDir, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    // 链接工作树的 gitdir 位于某个仓库的 `.git/worktrees/` 下。
    // 同时匹配两种分隔符，以识别 Windows 风格的指针。
    if (gitdir && /(^|[\\/])\.git[\\/]worktrees[\\/]/.test(gitdir)) return 'worktree';
  } catch {
    // `.git` 指针不可读——回退到之前"为其建立索引"的行为。
  }
  return 'embedded';
}

/**
 * 在 `absDir` 下（含自身）查找嵌套的 git 仓库，进行浅层有界 BFS。
 * 找到每个仓库根节点后停止向下递归——其内容由该仓库自身的枚举处理。
 * 跳过默认忽略目录（`node_modules` 可能因 npm git 依赖而包含 `.git`——
 * 这永远不会使其成为项目代码）以及 Synapse 数据目录。
 * 通过深度和条目数上限，确保体积巨大的被忽略目录树不会拖慢扫描。
 */
function findNestedGitRepos(absDir: string, relPrefix: string): string[] {
  const found: string[] = [];
  const defaults = defaultsOnlyIgnore();
  const queue: Array<{ abs: string; rel: string; depth: number }> = [
    { abs: absDir, rel: relPrefix, depth: 0 },
  ];
  let examined = 0;
  while (queue.length > 0) {
    const { abs, rel, depth } = queue.shift()!;
    if (++examined > EMBEDDED_REPO_SEARCH_ENTRIES) {
      logDebug('嵌套仓库搜索条目数上限已达到——更深层的仓库（如有）未被发现', { under: relPrefix });
      break;
    }
    const cls = classifyGitDir(abs);
    if (cls === 'worktree') {
      continue; // git 工作树会重复已索引的仓库（#848）——跳过
    }
    if (cls === 'embedded') {
      found.push(rel);
      continue; // 由其自身的 git 处理下层所有内容
    }
    if (depth >= EMBEDDED_REPO_SEARCH_DEPTH) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || isSynapseDataDir(entry.name)) continue;
      const childRel = rel + entry.name + '/';
      if (defaults.ignores(childRel)) continue;
      queue.push({ abs: path.join(abs, entry.name), rel: childRel, depth: depth + 1 });
    }
  }
  return found;
}

/**
 * 工作区范围的 ignore 匹配器。普通路径使用根目录的匹配器
 * （内置默认值 + 根 `.gitignore`）；嵌套仓库内部的路径使用
 * 该仓库自己的匹配器（默认值 + 其根 `.gitignore`）——父仓库的
 * `.gitignore` 隐藏的是子仓库在 git 中的可见性，而非其在索引中的可见性（#514）。
 * 对于作为嵌套根节点祖先的目录路径（带尾部斜杠），永远不忽略，
 * 以使逐目录剪枝的调用方（Linux 每目录 watcher）能够向下遍历到达嵌套仓库。
 *
 * 索引器和 watcher 范围的单一真实来源——两者不得出现分歧。
 */
export class ScopeIgnore {
  private embedded: Array<{ root: string; matcher: Ignore }>;
  private defaults: Ignore = defaultsOnlyIgnore();
  constructor(private rootMatcher: Ignore, embedded: Array<{ root: string; matcher: Ignore }>) {
    // 最长根节点优先，使嵌套仓库中的路径命中最内层的匹配器。
    this.embedded = [...embedded].sort((a, b) => b.root.length - a.root.length);
  }

  ignores(rel: string): boolean {
    for (const { root, matcher } of this.embedded) {
      if (rel.startsWith(root)) {
        const inner = rel.slice(root.length);
        if (inner === '') return false;
        // 内置默认值对完整路径统一生效（#407）——
        // node_modules 内的嵌套仓库（npm git 依赖）即使其自身规则不忽略其文件，
        // 也必须保持被排除状态。
        return this.defaults.ignores(rel) || matcher.ignores(inner);
      }
    }
    // 不剪枝通往嵌套仓库路径上的目录。
    if (rel.endsWith('/') && this.embedded.some(({ root }) => root.startsWith(rel))) {
      return false;
    }
    return this.rootMatcher.ignores(rel);
  }
}

/**
 * 构建工作区范围的匹配器。若调用方已知嵌套根节点（扫描器在收集过程中会发现它们），
 * 可传入以跳过重新发现；否则在此处发现（watcher 路径使用此方式）。
 */
export function buildScopeIgnore(rootDir: string, embeddedRoots?: Iterable<string>): ScopeIgnore {
  const roots = embeddedRoots ? [...embeddedRoots] : discoverEmbeddedRepoRoots(rootDir);
  return new ScopeIgnore(
    buildDefaultIgnore(rootDir),
    roots.map((root) => ({ root, matcher: buildDefaultIgnore(path.join(rootDir, root)) })),
  );
}

/**
 * 独立发现 `rootDir` 下所有嵌套仓库根节点（相对路径，带尾部斜杠）——
 * 包括未跟踪类型（#193）和被 gitignore 类型（#514），递归处理
 * （嵌套仓库本身还可以再嵌套仓库）。
 * 对于非 git 根目录返回 []：文件系统遍历已在那里处理了嵌套仓库。
 */
export function discoverEmbeddedRepoRoots(rootDir: string): string[] {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  const defaults = defaultsOnlyIgnore();
  const visit = (repoAbs: string, prefix: string): void => {
    const candidates: string[] = [];
    try {
      const o = execFileSync(
        'git',
        ['ls-files', '-z', '-o', '--exclude-standard', '--directory'],
        { cwd: repoAbs, encoding: 'utf-8', timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      for (const e of o.split('\0')) {
        if (e.endsWith('/') && !defaults.ignores(e)) {
          candidates.push(...findNestedGitRepos(path.join(repoAbs, e), e));
        }
      }
    } catch { /* 未跟踪文件列举失败——被忽略侧的发现仍继续执行 */ }
    candidates.push(...findIgnoredEmbeddedRepos(repoAbs));
    for (const rel of candidates) {
      const full = normalizePath(prefix + rel);
      out.push(full);
      visit(path.join(repoAbs, rel), full);
    }
  };
  visit(rootDir, '');
  return out;
}

/**
 * 发现被 `repoDir` 自身的 ignore 规则隐藏的嵌套仓库：对每个被 gitignore 的目录
 * （跳过内置默认排除项），搜索其中的嵌套 `.git` 根节点。
 * 返回相对于 `repoDir` 的仓库路径，带尾部斜杠。
 */
function findIgnoredEmbeddedRepos(repoDir: string): string[] {
  const defaults = defaultsOnlyIgnore();
  const repos: string[] = [];
  for (const dir of listIgnoredDirs(repoDir)) {
    if (defaults.ignores(dir)) continue;
    repos.push(...findNestedGitRepos(path.join(repoDir, dir), dir));
  }
  return repos;
}

/**
 * 从根目录为 `repoDir` 的 git 仓库收集 git 可见文件（已跟踪 + 未跟踪，遵循 .gitignore），
 * 将每个文件加入 `files`，并在路径前添加 `prefix`，使路径保持相对于原始扫描根目录。
 *
 * 递归处理嵌套 git 仓库——不是子模块的嵌套克隆（在工作区中独立存在的克隆，
 * 常见于 CMake "super-repo" 布局）。父仓库的 `git ls-files` 无法进入它们：
 * 已跟踪输出完全跳过它们，未跟踪输出只将它们报告为不透明的 "subdir/" 条目
 * （带尾部斜杠），而非展开其文件。每个嵌套仓库都是自己的 git 边界，
 * 因此需要在其内部重新运行 `git ls-files`。（参见 issue #193。）
 * 被 GITIGNORED 的嵌套仓库对此也不可见——
 * 它们通过 `findIgnoredEmbeddedRepos` 单独发现（#514）；
 * 所有嵌套仓库根节点（无论以何种方式发现）都记录在 `embeddedRoots` 中，
 * 使调用方可以豁免其文件不受父仓库 gitignore 规则的约束。
 */
function collectGitFiles(repoDir: string, prefix: string, files: Set<string>, embeddedRoots?: Set<string>): void {
  const gitOpts = { cwd: repoDir, encoding: 'utf-8' as const, timeout: 30000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], windowsHide: true };

  // 已跟踪文件。--recurse-submodules 会拉取活跃子模块中的文件，
  // 否则索引只会将它们表示为提交指针。
  // 没有此选项，使用子模块的 monorepo 将索引 0 个文件。（参见 issue #147。）
  // 注意：--recurse-submodules 仅支持 -c/--cached 和 --stage 模式——
  // 不能与 -o 组合使用，因此未跟踪文件在下方单独收集。
  // -z 给出以 NUL 分隔的、未转义的输出，使非 ASCII（例如 CJK）路径
  // 能够原样保留。若不使用此选项，git 会对此类路径进行八进制转义并加双引号
  // （core.quotepath 默认行为），而带引号的形式与磁盘上的真实文件不匹配，
  // 导致这些文件被静默地丢弃出索引。（#541）
  const tracked = execFileSync('git', ['ls-files', '-z', '-c', '--recurse-submodules'], gitOpts);
  for (const rel of tracked.split('\0')) {
    if (rel) files.add(normalizePath(prefix + rel));
  }

  // 未跟踪文件（子模块管理其自身的未跟踪状态）。嵌套 git 仓库
  // 在此处以单个 "subdir/" 条目出现，git 拒绝向下展开——
  // 将其作为独立仓库递归处理，以便对其源代码建立索引。
  const untracked = execFileSync('git', ['ls-files', '-z', '-o', '--exclude-standard'], gitOpts);
  for (const rel of untracked.split('\0')) {
    if (!rel) continue;
    if (rel.endsWith('/')) {
      // git 只为嵌套仓库发出带尾部斜杠的目录条目。
      // 无论如何都先用 .git 检查加以防护，其他情况完全按照
      // git 本身的跳过方式处理（不递归进入非仓库的不透明目录）。
      // 绝不递归进入默认忽略位置——node_modules 中的嵌套仓库
      // 是 npm git 依赖，不是项目代码。
      const childDir = path.join(repoDir, rel);
      // git 工作树在此处也以不透明的未跟踪目录出现——跳过，
      // 它是已索引仓库的重复工作视图（#848）。
      if (classifyGitDir(childDir) === 'embedded' && !defaultsOnlyIgnore().ignores(rel)) {
        embeddedRoots?.add(normalizePath(prefix + rel));
        collectGitFiles(childDir, prefix + rel, files, embeddedRoots);
      }
      continue;
    }
    files.add(normalizePath(prefix + rel));
  }

  // 被本仓库 ignore 规则隐藏的嵌套仓库（父仓库 .gitignore 中的 `/packages/`）
  // 在上述任何列举中都不会出现——同样对其进行发现和递归处理。（#514）
  for (const rel of findIgnoredEmbeddedRepos(repoDir)) {
    embeddedRoots?.add(normalizePath(prefix + rel));
    collectGitFiles(path.join(repoDir, rel), prefix + rel, files, embeddedRoots);
  }
}

/**
 * 获取 git 可见的所有文件（已跟踪 + 未跟踪但未被忽略）。
 * 在所有层级（根目录、子目录）遵循 .gitignore，并递归进入
 * 嵌套（非子模块）的 git 仓库。失败时（非 git 项目）返回 null，
 * 使调用方可以回退到文件系统遍历。
 */
function getGitVisibleFiles(rootDir: string): Set<string> | null {
  try {
    // 检查项目目录是否被父仓库 gitignore。
    // 当 rootDir 位于某个父 git 仓库内且被其忽略时，
    // `git ls-files` 返回空——回退到文件系统遍历。
    const gitRoot = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    ).trim();

    if (path.resolve(gitRoot) !== path.resolve(rootDir)) {
      try {
        // git check-ignore 在路径被忽略时退出码为 0，未被忽略时为 1
        execFileSync(
          'git',
          ['check-ignore', '-q', path.resolve(rootDir)],
          { cwd: rootDir, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
        );
        // 目录被父仓库 gitignore——回退到文件系统遍历
        return null;
      } catch {
        // 未被忽略——可以安全使用 git ls-files
      }
    }

    const files = new Set<string>();
    const embeddedRoots = new Set<string>();
    collectGitFiles(rootDir, '', files, embeddedRoots);
    // 对已跟踪文件也统一应用内置默认 ignore——
    // 将依赖/构建目录提交并不使其成为项目代码。
    // `.gitignore` 取反（例如 `!vendor/`）是显式的加入方式。（issue #407）
    // 嵌套仓库内的文件根据该仓库自身的规则匹配，
    // 而非父仓库的规则：父仓库的 .gitignore 隐藏的是子仓库在 git 中的可见性，
    // 而非其在索引中的可见性。（#514）
    const ig = buildScopeIgnore(rootDir, embeddedRoots);
    return new Set([...files].filter((f) => !ig.ignores(f)));
  } catch {
    return null;
  }
}

/**
 * git 变更检测的结果。
 * 当 git 不可用时（非 git 项目或命令失败）返回 null，
 * 通知调用方回退到完整的文件系统扫描。
 */
interface GitChanges {
  modified: string[];  // M、MM、AM——需要重新哈希 + 重新索引的文件
  added: string[];     // ??——需要索引的新未跟踪文件
  deleted: string[];   // D——需要从数据库删除的文件
}

/**
 * 使用 `git status` 检测已变更的文件，而非扫描每个文件。
 * 失败时返回 null，使调用方回退到完整扫描。
 *
 * 递归处理嵌套仓库——包括未跟踪类型（#193：父仓库的 status 将它们
 * 折叠为不透明的 `?? subdir/` 条目）和被 gitignore 类型（#514：它们
 * 完全不出现在父仓库的 status 中）——在各自内部运行 `git status`，
 * 使多仓库工作区中的变更无需完整重扫即可同步。
 * 删除整个嵌套仓库目录是此方案无法感知的唯一情况（负责报告删除的
 * 子 status 随目录一同消失）；完整的 `synapse index` 可以对此进行协调。
 */
function getGitChangedFiles(rootDir: string): GitChanges | null {
  try {
    const changes: GitChanges = { modified: [], added: [], deleted: [] };
    collectGitStatus(rootDir, '', changes);
    return changes;
  } catch {
    return null;
  }
}

function collectGitStatus(repoDir: string, prefix: string, out: GitChanges): void {
  const output = execFileSync(
    'git',
    ['status', '--porcelain', '--no-renames'],
    { cwd: repoDir, encoding: 'utf-8', timeout: 10000, maxBuffer: 50 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );

  const untrackedDirs: string[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue; // 最短格式："XY file"

    const statusCode = line.substring(0, 2);
    const rel = normalizePath(line.substring(3));

    // 未跟踪目录条目（带尾部斜杠）可能隐藏嵌套仓库——
    // 收集起来在下方递归处理，而非当作普通文件处理。
    if (statusCode === '??' && rel.endsWith('/')) {
      untrackedDirs.push(rel);
      continue;
    }

    const filePath = normalizePath(prefix + rel);
    // Skip non-source files (git status already omits .gitignored paths).
    if (!isSourceFile(filePath)) continue;

    if (statusCode === '??') {
      out.added.push(filePath);
    } else if (statusCode.includes('D')) {
      out.deleted.push(filePath);
    } else {
      // M、MM、AM、A（已暂存）等——均视作已修改
      out.modified.push(filePath);
    }
  }

  // 递归处理未跟踪目录下的嵌套仓库（直接在该目录下或更深层），
  // 以及本仓库被 gitignore 目录下的嵌套仓库。
  for (const rel of untrackedDirs) {
    for (const repoRel of findNestedGitRepos(path.join(repoDir, rel), rel)) {
      collectGitStatus(path.join(repoDir, repoRel), prefix + repoRel, out);
    }
  }
  for (const rel of findIgnoredEmbeddedRepos(repoDir)) {
    collectGitStatus(path.join(repoDir, rel), prefix + rel, out);
  }
}

/**
 * 递归扫描目录以查找源文件。
 *
 * 在 git 仓库中，使用 `git ls-files`（在所有层级自动遵循 .gitignore），
 * 然后保留具有受支持源文件扩展名的文件。对于非 git 项目，
 * 回退到自行解析 .gitignore 的文件系统遍历。
 */
export function scanDirectory(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): string[] {
  // 快速路径：使用 git 获取所有可见文件（在各处遵循 .gitignore）
  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (isSourceFile(filePath)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
      }
    }
    return files;
  }

  // 回退：对非 git 项目进行文件系统遍历
  return scanDirectoryWalk(rootDir, onProgress);
}

/**
 * scanDirectory 的异步变体，定期让出事件循环控制权，
 * 允许 worker 线程接收并渲染进度消息。
 */
export async function scanDirectoryAsync(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): Promise<string[]> {
  const gitFiles = getGitVisibleFiles(rootDir);
  if (gitFiles) {
    const files: string[] = [];
    let count = 0;
    for (const filePath of gitFiles) {
      if (isSourceFile(filePath)) {
        files.push(filePath);
        count++;
        onProgress?.(count, filePath);
        // 每 100 个文件让出一次控制权，以便 worker 线程能渲染进度
        if (count % 100 === 0) {
          await new Promise<void>(r => setImmediate(r));
        }
      }
    }
    return files;
  }

  return scanDirectoryWalk(rootDir, onProgress);
}

/**
 * 非 git 项目的文件系统遍历回退实现。
 */
function scanDirectoryWalk(
  rootDir: string,
  onProgress?: (current: number, file: string) => void
): string[] {
  const files: string[] = [];
  let count = 0;
  const visitedDirs = new Set<string>();

  // 作用域限定在声明它的目录的 .gitignore 匹配器。嵌套 .gitignore 中的
  // 模式是相对于该目录的，因此我们将目录与匹配器一同保存，
  // 并测试相对于该目录的路径——与 git 在每个层级应用 .gitignore 文件的方式相同。
  interface ScopedIgnore {
    dir: string;
    ig: Ignore;
  }

  const loadIgnore = (dir: string): ScopedIgnore | null => {
    const giPath = path.join(dir, '.gitignore');
    if (!fs.existsSync(giPath)) return null;
    // readGitignorePatterns 是防御性的：非 UTF-8（DLP 加密）或
    // 无法编译的 .gitignore 会被跳过/过滤并记录警告，而不会抛出异常
    // （issue #682）——因此下面逐文件的 `.ignores()` 调用不会崩溃。
    const patterns = readGitignorePatterns(giPath);
    return patterns ? { dir, ig: ignore().add(patterns) } : null;
  };

  const isIgnored = (fullPath: string, isDir: boolean, matchers: ScopedIgnore[]): boolean => {
    for (const { dir, ig } of matchers) {
      let rel = normalizePath(path.relative(dir, fullPath));
      if (!rel || rel.startsWith('..')) continue; // 不在此匹配器目录下
      if (isDir) rel += '/'; // 仅目录规则（例如 `build/`）只有带斜杠时才匹配
      if (ig.ignores(rel)) return true;
    }
    return false;
  };

  function walk(dir: string, matchers: ScopedIgnore[]): void {
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      logDebug('跳过无法解析的目录', { dir });
      return;
    }

    if (visitedDirs.has(realDir)) {
      logDebug('跳过已访问目录（符号链接循环）', { dir, realDir });
      return;
    }
    visitedDirs.add(realDir);

    // 本目录自身的 .gitignore（如存在）适用于其下的所有内容。
    // 根目录的 .gitignore 已合并入初始基础匹配器（使其中的取反规则可覆盖内置默认值），
    // 因此在此处跳过根目录。
    const own = dir === rootDir ? null : loadIgnore(dir);
    const active = own ? [...matchers, own] : matchers;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      logDebug('跳过不可读目录', { dir, error: String(error) });
      return;
    }

    for (const entry of entries) {
      // 永不递归进入 git 内部目录或任何 Synapse 数据目录
      // （当前活跃的或其他环境创建的兄弟目录——#636）。
      if (entry.name === '.git' || isSynapseDataDir(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = normalizePath(path.relative(rootDir, fullPath));

      if (entry.isSymbolicLink()) {
        try {
          const realTarget = fs.realpathSync(fullPath);
          const stat = fs.statSync(realTarget);
          if (stat.isDirectory()) {
            if (!isIgnored(fullPath, true, active)) {
              walk(fullPath, active);
            }
          } else if (stat.isFile()) {
            if (!isIgnored(fullPath, false, active) && isSourceFile(relativePath)) {
              files.push(relativePath);
              count++;
              onProgress?.(count, relativePath);
            }
          }
        } catch {
          logDebug('跳过损坏的符号链接', { path: fullPath });
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (!isIgnored(fullPath, true, active)) {
          walk(fullPath, active);
        }
      } else if (entry.isFile()) {
        if (!isIgnored(fullPath, false, active) && isSourceFile(relativePath)) {
          files.push(relativePath);
          count++;
          onProgress?.(count, relativePath);
        }
      }
    }
  }

  // 以内置默认 ignore 规则（合并根 .gitignore 以允许取反覆盖）初始化基础匹配器。
  // 嵌套 .gitignore 仍按目录逐层叠加。
  walk(rootDir, [{ dir: rootDir, ig: buildDefaultIgnore(rootDir) }]);
  return files;
}

/**
 * 提取协调器
 */
export class ExtractionOrchestrator {
  private rootDir: string;
  private queries: QueryBuilder;
  /**
   * 该项目检测到的框架名称，由 indexAll() 填充。
   * 传递给 extractFromSource，以便框架专属提取器（路由节点、中间件等）
   * 在 tree-sitter 解析后运行。检测未运行时清除，
   * 使单文件重新索引路径能够当场执行检测。
   */
  private detectedFrameworkNames: string[] | null = null;

  constructor(rootDir: string, queries: QueryBuilder) {
    this.rootDir = rootDir;
    this.queries = queries;
  }

  /**
   * 构建一个基于文件系统的 ResolutionContext，足以用于框架检测。
   * 图查询方法（getNodesByName 等）返回空，因为数据库尚未填充，
   * 但 detect() 只使用 readFile、fileExists 和 getAllFiles，因此没有问题。
   */
  private buildDetectionContext(files: string[]): ResolutionContext {
    const rootDir = this.rootDir;
    return {
      getNodesInFile: () => [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      getAllFiles: () => files,
      getProjectRoot: () => rootDir,
      fileExists: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return false;
        try {
          return fs.existsSync(full);
        } catch {
          return false;
        }
      },
      readFile: (relativePath: string) => {
        const full = validatePathWithinRoot(rootDir, relativePath);
        if (!full) return null;
        try {
          return fs.readFileSync(full, 'utf-8');
        } catch {
          return null;
        }
      },
      // monorepo 支持——框架 detect() 需要探测子包清单时使用
      // （例如 fabric-view 在根清单只是工作区声明时，
      // 会查看 packages/<sub>/package.json）。与 resolver-context 形状匹配。
      listDirectories: (relativePath: string) => {
        const target =
          relativePath === '.' || relativePath === ''
            ? rootDir
            : path.join(rootDir, relativePath);
        try {
          return fs
            .readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch {
          return [];
        }
      },
    };
  }

  /**
   * 按需使用当前已扫描文件（或未提供时进行新扫描）检测框架。
   * 缓存在协调器上，使单次运行内的重复调用不会重新扫描。
   */
  private ensureDetectedFrameworks(files?: string[]): string[] {
    if (this.detectedFrameworkNames !== null) return this.detectedFrameworkNames;
    const fileList = files ?? scanDirectory(this.rootDir);
    const context = this.buildDetectionContext(fileList);
    this.detectedFrameworkNames = detectFrameworks(context).map((r) => r.name);
    return this.detectedFrameworkNames;
  }

  /**
   * 索引项目中的所有文件
   */
  async indexAll(
    onProgress?: (progress: IndexProgress) => void,
    signal?: AbortSignal,
    verbose?: boolean
  ): Promise<IndexResult> {
    await initGrammars();
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    const log = verbose
      ? (msg: string) => { console.log(`[worker] ${msg}`); }
      : (_msg: string) => {};

    // 阶段一：扫描文件
    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const files = await scanDirectoryAsync(this.rootDir, (current, file) => {
      onProgress?.({
        phase: 'scanning',
        current,
        total: 0,
        currentFile: file,
      });
    });

    // 在每次 indexAll 运行时使用已扫描的文件列表进行一次框架检测。
    // 名称传递给每个解析调用，使框架专属提取器（路由节点、中间件等）
    // 在 tree-sitter 解析后运行。
    // 每次运行时重置框架检测，使两次运行之间添加（例如）requirements.txt
    // 也能被检测到，无需重启进程。
    this.detectedFrameworkNames = null;
    const frameworkNames = this.ensureDetectedFrameworks(files);

    if (signal?.aborted) {
      return {
        success: false,
        filesIndexed: 0,
        filesSkipped: 0,
        filesErrored: 0,
        nodesCreated: 0,
        edgesCreated: 0,
        errors: [{ message: 'Aborted', severity: 'error' }],
        durationMs: Date.now() - startTime,
      };
    }

    // 阶段二：在 worker 线程中解析文件（保持主线程不被阻塞以响应 UI）
    const total = files.length;
    let processed = 0;

    // 立即发出解析阶段事件，使进度条在 worker 启动期间就能显示。
    // 让出控制权可使 shimmer worker 在主线程开始同步语法检测工作前
    // 将阶段切换信息刷新到 stdout。
    onProgress?.({
      phase: 'parsing',
      current: 0,
      total,
    });
    await new Promise(resolve => setImmediate(resolve));

    // 检测所需语言并在解析 worker 中加载语法文件
    const neededLanguages = [...new Set(files.map((f) => detectLanguage(f)))];
    // .h 文件默认为 'c' 但可能是 C++——当需要 c 时确保加载 cpp 语法文件
    if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
      neededLanguages.push('cpp');
    }

    // 尝试使用 worker 线程解析（保持主线程不被阻塞以响应 UI）。
    // 当编译后的 worker 不可用时（例如测试环境），回退到进程内解析。
    const parseWorkerPath = path.join(__dirname, 'parse-worker.js');
    const useWorker = fs.existsSync(parseWorkerPath);
    let WorkerClass: typeof import('worker_threads').Worker | null = null;

    if (useWorker) {
      const { Worker } = await import('worker_threads');
      WorkerClass = Worker;
    } else {
      // 进程内回退：在本地加载语法文件
      await loadGrammarsForLanguages(neededLanguages);
    }

    // --- Worker 生命周期管理 ---
    // worker 可能崩溃（WASM OOM）或在病态文件上挂起。
    // 我们跟踪待处理的解析 Promise 并处理两种情况：
    //   - 超时：终止 + 重启 worker，拒绝超时的请求
    //   - 崩溃：拒绝所有待处理 Promise，为剩余文件重启 worker
    let parseWorker: import('worker_threads').Worker | null = null;
    let nextId = 0;
    let workerParseCount = 0;
    const pendingParses = new Map<number, {
      resolve: (result: ExtractionResult) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>();

    function rejectAllPending(reason: string): void {
      for (const [id, pending] of pendingParses) {
        clearTimeout(pending.timer);
        pendingParses.delete(id);
        pending.reject(new Error(reason));
      }
    }

    function attachWorkerHandlers(w: import('worker_threads').Worker): void {
      w.on('message', (msg: { type: string; id?: number; result?: ExtractionResult }) => {
        if (msg.type === 'parse-result' && msg.id !== undefined) {
          const pending = pendingParses.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            pendingParses.delete(msg.id);
            pending.resolve(msg.result!);
          }
        }
      });

      w.on('error', (err) => {
        logWarn('Parse worker error', { error: err.message });
        rejectAllPending(`Worker error: ${err.message}`);
      });

      w.on('exit', (code) => {
        if (code !== 0 && pendingParses.size > 0) {
          logWarn('Parse worker exited unexpectedly', { code });
          rejectAllPending(`Worker exited with code ${code}`);
        }
        // Clear reference so we know to respawn, reset count so
        // the fresh worker gets a full cycle before recycling.
        if (parseWorker === w) {
          parseWorker = null;
          workerParseCount = 0;
        }
      });
    }

    async function ensureWorker(): Promise<import('worker_threads').Worker> {
      if (parseWorker) return parseWorker;
      log('Spawning new parse worker...');
      parseWorker = new WorkerClass!(parseWorkerPath);
      attachWorkerHandlers(parseWorker);

      // 在新 worker 中加载语法文件
      await new Promise<void>((resolve, reject) => {
        parseWorker!.once('message', (msg: { type: string }) => {
          if (msg.type === 'grammars-loaded') resolve();
          else reject(new Error(`Unexpected message: ${msg.type}`));
        });
        parseWorker!.postMessage({ type: 'load-grammars', languages: neededLanguages });
      });

      return parseWorker;
    }

    if (WorkerClass) {
      await ensureWorker();
    }

    /**
     * 回收 worker 线程以释放 WASM 内存。
     * 终止当前 worker 并清除引用，使
     * ensureWorker() 在下次调用时生成新的 worker。
     */
    function recycleWorker(): void {
      if (!parseWorker) return;
      log(`Recycling worker after ${workerParseCount} parses (heap: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS)`);
      const w = parseWorker;
      parseWorker = null;
      workerParseCount = 0;
      // 即发即忘：若 WASM 卡住，worker.terminate() 可能会挂起
      w.terminate().catch(() => {});
    }

    async function requestParse(filePath: string, content: string): Promise<ExtractionResult> {
      if (!WorkerClass) {
        // 进程内回退
        return extractFromSource(
          filePath,
          content,
          detectLanguage(filePath, content),
          frameworkNames
        );
      }

      // 在下次解析之前回收 worker（如果已达到阈值）。
      // 这会销毁 WASM 线性内存（只能增长永不缩减）
      // 并用一个干净堆的新 worker 替换。
      if (workerParseCount >= WORKER_RECYCLE_INTERVAL) {
        await recycleWorker();
      }

      const worker = await ensureWorker();
      const id = nextId++;
      workerParseCount++;

      // 针对大文件缩放超时时间：基础 10s + 每 100KB 增加 10s
      const timeoutMs = PARSE_TIMEOUT_MS + Math.floor(content.length / 100_000) * 10_000;

      return new Promise<ExtractionResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingParses.delete(id);
          log(`TIMEOUT: ${filePath} exceeded ${timeoutMs}ms — killing worker`);
          // 先拒绝——若 WASM 卡住，worker.terminate() 可能会挂起
          parseWorker = null;
          workerParseCount = 0;
          reject(new Error(`Parse timed out after ${timeoutMs}ms`));
          // 即发即忘：在后台终止卡住的 worker
          worker.terminate().catch(() => {});
        }, timeoutMs);

        pendingParses.set(id, { resolve, reject, timer });
        worker.postMessage({ type: 'parse', id, filePath, content, frameworkNames });
      });
    }

    for (let i = 0; i < files.length; i += FILE_IO_BATCH_SIZE) {
      if (signal?.aborted) {
        if (parseWorker) (parseWorker as import('worker_threads').Worker).terminate().catch(() => {});
        return {
          success: false,
          filesIndexed,
          filesSkipped,
          filesErrored,
          nodesCreated: totalNodes,
          edgesCreated: totalEdges,
          errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
          durationMs: Date.now() - startTime,
        };
      }

      const batch = files.slice(i, i + FILE_IO_BATCH_SIZE);

      // 并行读取文件（在任何 I/O 之前先验证路径）
      const fileContents = await Promise.all(
        batch.map(async (fp) => {
          try {
            const fullPath = validatePathWithinRoot(this.rootDir, fp);
            if (!fullPath) {
              logWarn('Path traversal blocked in batch reader', { filePath: fp });
              return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: new Error('Path traversal blocked') };
            }
            const content = await fsp.readFile(fullPath, 'utf-8');
            const stats = await fsp.stat(fullPath);
            return { filePath: fp, content, stats, error: null as Error | null };
          } catch (err) {
            return { filePath: fp, content: null as string | null, stats: null as fs.Stats | null, error: err as Error };
          }
        })
      );

      // 发送给 worker 解析，在主线程存储结果
      for (const { filePath, content, stats, error } of fileContents) {
        if (signal?.aborted) {
          if (parseWorker) (parseWorker as import('worker_threads').Worker).terminate().catch(() => {});
          return {
            success: false,
            filesIndexed,
            filesSkipped,
            filesErrored,
            nodesCreated: totalNodes,
            edgesCreated: totalEdges,
            errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
            durationMs: Date.now() - startTime,
          };
        }

        // 在解析前报告进度（显示当前正在处理的文件）
        onProgress?.({
          phase: 'parsing',
          current: processed,
          total,
          currentFile: filePath,
        });

        if (error || content === null || stats === null) {
          processed++;
          filesErrored++;
          errors.push({
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath,
            severity: 'error',
            code: 'read_error',
          });
          continue;
        }

        // 执行 MAX_FILE_SIZE 限制。若不检查，第三方生成的头文件、
        // 压缩打包产物以及其他多 MB 文件会被索引，
        // 浪费 WASM 堆和 worker 回收配额，却提取不到有价值的符号。
        // 单文件 extractFile 路径已执行此检查；批量路径以前静默跳过了该检查。
        if (stats.size > MAX_FILE_SIZE) {
          processed++;
          filesSkipped++;
          errors.push({
            message: `File exceeds max size (${stats.size} > ${MAX_FILE_SIZE})`,
            filePath,
            severity: 'warning',
            code: 'size_exceeded',
          });
          onProgress?.({ phase: 'parsing', current: processed, total });
          continue;
        }

        // 在 worker 线程中解析（主线程保持不被阻塞）。
        // 包裹在 try/catch 中，以优雅处理 worker 超时和崩溃。
        let result: ExtractionResult;
        try {
          result = await requestParse(filePath, content);
        } catch (parseErr) {
          processed++;
          filesErrored++;
          errors.push({
            message: parseErr instanceof Error ? parseErr.message : String(parseErr),
            filePath,
            severity: 'error',
            code: 'parse_error',
          });
          continue;
        }

        processed++;

        // 在主线程存储到数据库（SQLite 不是线程安全的）
        if (result.nodes.length > 0 || result.errors.length === 0) {
          const language = detectLanguage(filePath, content);
          this.storeExtractionResult(filePath, content, language, stats, result);
        }

        if (result.errors.length > 0) {
          for (const err of result.errors) {
            if (!err.filePath) err.filePath = filePath;
          }
          errors.push(...result.errors);
        }

        if (result.nodes.length > 0) {
          filesIndexed++;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;
        } else if (result.errors.some((e) => e.severity === 'error')) {
          filesErrored++;
        } else {
          // 没有符号但没有错误的文件（yaml、twig、properties）在文件级别被跟踪——
          // 将它们计为已索引，以免 CLI 误报"未找到可索引文件"。
          const lang = detectLanguage(filePath, content);
          if (isFileLevelOnlyLanguage(lang)) {
            filesIndexed++;
          } else {
            filesSkipped++;
          }
        }
      }
    }

    // 报告 100% 进度，使进度条不会卡在 99%
    onProgress?.({
      phase: 'parsing',
      current: total,
      total,
    });

    // 让出控制权，使 shimmer worker 缓冲的 stdout 写入能够刷新。
    // worker 线程的 stdout 通过主线程事件循环代理，
    // 因此此处的同步工作会阻止动画渲染。
    await new Promise(resolve => setImmediate(resolve));

    // 重试阶段：因 WASM 内存损坏而失败的文件，在干净堆的新 worker 上可能成功。
    // 在每次尝试前回收，使每个文件都能获得尽可能干净的 WASM 状态。
    const retryableErrors = errors.filter(
      (e) => e.code === 'parse_error' && e.filePath &&
        (e.message.includes('Worker exited') || e.message.includes('memory access out of bounds'))
    );

    if (retryableErrors.length > 0 && WorkerClass) {
      log(`Retrying ${retryableErrors.length} files that failed due to WASM memory errors...`);

      const stillFailing: typeof retryableErrors = [];

      for (const errEntry of retryableErrors) {
        const filePath = errEntry.filePath!;
        if (signal?.aborted) break;

        // 每次重试都使用新 worker——最大化 WASM 可用空间
        recycleWorker();

        let content: string;
        try {
          const fullPath = validatePathWithinRoot(this.rootDir, filePath);
          if (!fullPath) continue;
          content = await fsp.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }

        let result: ExtractionResult;
        try {
          result = await requestParse(filePath, content);
        } catch {
          stillFailing.push(errEntry);
          continue;
        }

        if (result.nodes.length > 0 || result.errors.length === 0) {
          const language = detectLanguage(filePath, content);
          const stats = await fsp.stat(path.join(this.rootDir, filePath));
          this.storeExtractionResult(filePath, content, language, stats, result);

          const idx = errors.indexOf(errEntry);
          if (idx >= 0) errors.splice(idx, 1);
          filesErrored--;
          filesIndexed++;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;
          log(`Retry OK: ${filePath} (${result.nodes.length} nodes)`);
        }
      }

      // 最后手段：对在干净 worker 上仍然崩溃的文件，
      // 剥离纯注释行以降低 WASM 内存压力。许多编译器测试文件
      // 90% 以上都是注释（CHECK 指令），不产生代码节点却消耗解析器内存。
      if (stillFailing.length > 0) {
        log(`${stillFailing.length} files still failing — retrying with comments stripped...`);

        for (const errEntry of stillFailing) {
          const filePath = errEntry.filePath!;
          if (signal?.aborted) break;

          recycleWorker();

          let fullContent: string;
          try {
            const fullPath = validatePathWithinRoot(this.rootDir, filePath);
            if (!fullPath) continue;
            fullContent = await fsp.readFile(fullPath, 'utf-8');
          } catch {
            continue;
          }

          // 剥离纯注释行（通过替换为空行来保留行号，
          // 以确保节点位置保持正确）
          const stripped = fullContent
            .split('\n')
            .map(line => /^\s*\/\//.test(line) ? '' : line)
            .join('\n');

          let result: ExtractionResult;
          try {
            result = await requestParse(filePath, stripped);
          } catch {
            continue;
          }

          if (result.nodes.length > 0 || result.errors.length === 0) {
            const language = detectLanguage(filePath, fullContent);
            const stats = await fsp.stat(path.join(this.rootDir, filePath));
            this.storeExtractionResult(filePath, fullContent, language, stats, result);

            const idx = errors.indexOf(errEntry);
            if (idx >= 0) errors.splice(idx, 1);
            filesErrored--;
            filesIndexed++;
            totalNodes += result.nodes.length;
            totalEdges += result.edges.length;
            log(`Retry (stripped) OK: ${filePath} (${result.nodes.length} nodes)`);
          }
        }
      }
    }

    // 关闭解析 worker 并清除所有待处理的定时器
    rejectAllPending('Indexing complete');
    if (parseWorker) {
      (parseWorker as import('worker_threads').Worker).terminate().catch(() => {});
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 索引指定的文件
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let filesErrored = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    for (const filePath of filePaths) {
      const result = await this.indexFile(filePath);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }

      if (result.nodes.length > 0) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else if (result.errors.some((e) => e.severity === 'error')) {
        filesErrored++;
      } else {
        const tracked = this.queries.getFileByPath(filePath);
        if (tracked && isFileLevelOnlyLanguage(tracked.language)) {
          filesIndexed++;
        } else {
          filesSkipped++;
        }
      }
    }

    return {
      success: filesIndexed > 0 || errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      filesErrored,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 索引单个文件
   */
  async indexFile(relativePath: string): Promise<ExtractionResult> {
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath);

    if (!fullPath) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: `Path traversal blocked: ${relativePath}`, filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    // 读取文件内容和 stats
    let content: string;
    let stats: fs.Stats;
    try {
      stats = await fsp.stat(fullPath);
      content = await fsp.readFile(fullPath, 'utf-8');
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            filePath: relativePath,
            severity: 'error',
            code: 'read_error',
          },
        ],
        durationMs: 0,
      };
    }

    return this.indexFileWithContent(relativePath, content, stats);
  }

  /**
   * 索引单个文件，使用预读的内容和 stats。
   * 由并行批量读取器调用，避免重复的文件 I/O。
   */
  async indexFileWithContent(
    relativePath: string,
    content: string,
    stats: fs.Stats
  ): Promise<ExtractionResult> {
    // 防止路径穿越攻击
    const fullPath = validatePathWithinRoot(this.rootDir, relativePath);
    if (!fullPath) {
      logWarn('Path traversal blocked in indexFileWithContent', { relativePath });
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: 'Path traversal blocked', filePath: relativePath, severity: 'error', code: 'path_traversal' }],
        durationMs: 0,
      };
    }

    // 检查文件大小
    if (stats.size > MAX_FILE_SIZE) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `File exceeds max size (${stats.size} > ${MAX_FILE_SIZE})`,
            filePath: relativePath,
            severity: 'warning',
            code: 'size_exceeded',
          },
        ],
        durationMs: 0,
      };
    }

    // 检测语言
    const language = detectLanguage(relativePath, content);
    if (!isLanguageSupported(language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [],
        durationMs: 0,
      };
    }

    // 从源码提取。若 indexAll 已运行则使用缓存的框架名称，
    // 否则就地检测，确保单文件重新索引路径仍能生成
    // 路由节点、中间件等。
    const frameworkNames = this.ensureDetectedFrameworks();
    const result = extractFromSource(relativePath, content, language, frameworkNames);

    // Store in database
    if (result.nodes.length > 0 || result.errors.length === 0) {
      this.storeExtractionResult(relativePath, content, language, stats, result);
    }

    return result;
  }

  /**
   * 将提取结果存入数据库
   */
  private storeExtractionResult(
    filePath: string,
    content: string,
    language: Language,
    stats: fs.Stats,
    result: ExtractionResult
  ): void {
    const contentHash = hashContent(content);

    // 检查文件是否已存在且未变更
    const existingFile = this.queries.getFileByPath(filePath);
    if (existingFile && existingFile.contentHash === contentHash) {
      return; // 无变更
    }

    // 删除该文件的旧数据
    if (existingFile) {
      this.queries.deleteFile(filePath);
    }

    // 过滤掉缺少必填字段的节点再插入。
    // 防止边引用被 insertNode() 静默跳过的节点时产生外键违规（参见 issue #42）。
    const validNodes = result.nodes.filter((n) => n.id && n.kind && n.name && n.filePath && n.language);

    // 插入节点
    if (validNodes.length > 0) {
      this.queries.insertNodes(validNodes);
    }

    // 过滤边，只保留引用了实际已插入节点的边
    if (result.edges.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const validEdges = result.edges.filter(
        (e) => insertedIds.has(e.source) && insertedIds.has(e.target)
      );
      if (validEdges.length > 0) {
        this.queries.insertEdges(validEdges);
      }
    }

    // 批量插入未解析引用，附带非规范化的 filePath/language
    if (result.unresolvedReferences.length > 0) {
      const insertedIds = new Set(validNodes.map((n) => n.id));
      const refsWithContext = result.unresolvedReferences
        .filter((ref) => insertedIds.has(ref.fromNodeId))
        .map((ref) => ({
          ...ref,
          filePath: ref.filePath ?? filePath,
          language: ref.language ?? language,
        }));
      if (refsWithContext.length > 0) {
        this.queries.insertUnresolvedRefsBatch(refsWithContext);
      }
    }

    // 插入文件记录
    const fileRecord: FileRecord = {
      path: filePath,
      contentHash,
      language,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      indexedAt: Date.now(),
      nodeCount: result.nodes.length,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
    this.queries.upsertFile(fileRecord);
  }

  /**
   * 将索引与当前文件状态同步。
   *
   * 变更检测基于文件系统，而非 git：先通过 (size, mtime) stat
   * 预过滤跳过未变更文件，再用内容哈希确认真实变更。
   * 这在非 git 项目中同样有效，并能捕获 `git status` 看不到的
   * `git pull`/`checkout`/`merge`/`rebase` 提交变更。
   */
  async sync(onProgress?: (progress: IndexProgress) => void): Promise<SyncResult> {
    await initGrammars(); // 初始化 WASM 运行时（语法按需延迟加载）
    const startTime = Date.now();
    let filesChecked = 0;
    let filesAdded = 0;
    let filesModified = 0;
    let filesRemoved = 0;
    let nodesUpdated = 0;
    const changedFilePaths: string[] = [];

    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const filesToIndex: string[] = [];
    // === 文件系统对账（与 git 无关）===
    // "变更了什么"的真实来源是文件系统 vs 索引状态——而非 git。
    // 我们枚举当前源文件并逐一与 DB 对账。
    // 廉价的 (size, mtime) stat 预过滤无需读取或哈希即可跳过未变更文件，
    // 因此昂贵的 read+hash+parse 只对真正变更的文件运行。
    // 无论项目是否使用 git 均可捕获编辑/添加/删除，
    // 关键还能捕获 `git status` 看不到的
    // `git pull`/`checkout`/`merge`/`rebase` 提交变更——
    // 因为这些操作后工作区是干净的。
    const currentFiles = scanDirectory(this.rootDir);
    filesChecked = currentFiles.length;
    const currentSet = new Set(currentFiles);

    const trackedFiles = this.queries.getAllFiles();
    const trackedMap = new Map<string, FileRecord>();
    for (const f of trackedFiles) {
      trackedMap.set(f.path, f);
    }

    // 删除：在 DB 中有记录但源文件已不存在。直接检查文件系统——
    // `scanDirectory`（通过 `git ls-files`）仍会列出已从磁盘删除
    // 但尚未暂存的文件，因此仅靠集合成员判断会漏掉这种情况。
    for (const tracked of trackedFiles) {
      if (!currentSet.has(tracked.path) || !fs.existsSync(path.join(this.rootDir, tracked.path))) {
        this.queries.deleteFile(tracked.path);
        filesRemoved++;
      }
    }

    // 添加 / 修改。
    for (const filePath of currentFiles) {
      const fullPath = path.join(this.rootDir, filePath);
      const tracked = trackedMap.get(filePath);

      // 廉价预过滤：已索引文件的 size 和 mtime 均与 DB 匹配则视为未变更——
      // 无需读取或哈希即可跳过。（同时保留两者的内容变更是所有
      // 基于 mtime 增量工具的盲点；`index --force` 是逃生口。
      // Git 在 checkout/merge 时会更新每个写入文件的 mtime，因此 pull 可被捕获。）
      if (tracked) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size === tracked.size && Math.floor(stat.mtimeMs) === Math.floor(tracked.modifiedAt)) {
            continue;
          }
        } catch (error) {
          logDebug('Skipping unstattable file during sync', { filePath, error: String(error) });
          continue;
        }
      }

      // 新文件或 size/mtime 已变更——读取并哈希以确认内容真实变更。
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file during sync', { filePath, error: String(error) });
        continue;
      }
      const contentHash = hashContent(content);

      if (!tracked) {
        filesToIndex.push(filePath);
        changedFilePaths.push(filePath);
        filesAdded++;
      } else if (tracked.contentHash !== contentHash) {
        filesToIndex.push(filePath);
        changedFilePaths.push(filePath);
        filesModified++;
      }
    }

    // 仅加载变更文件所需的语法
    if (filesToIndex.length > 0) {
      const neededLanguages = [...new Set(filesToIndex.map((f) => detectLanguage(f)))];
      // .h 文件默认识别为 'c' 但可能是 C++——确保同时加载 cpp 语法
      if (neededLanguages.includes('c') && !neededLanguages.includes('cpp')) {
        neededLanguages.push('cpp');
      }
      await loadGrammarsForLanguages(neededLanguages);
    }

    // 索引变更文件
    const total = filesToIndex.length;
    for (let i = 0; i < filesToIndex.length; i++) {
      const filePath = filesToIndex[i]!;
      onProgress?.({
        phase: 'parsing',
        current: i + 1,
        total,
        currentFile: filePath,
      });

      const result = await this.indexFile(filePath);
      nodesUpdated += result.nodes.length;
    }

    return {
      filesChecked,
      filesAdded,
      filesModified,
      filesRemoved,
      nodesUpdated,
      durationMs: Date.now() - startTime,
      changedFilePaths: changedFilePaths.length > 0 ? changedFilePaths : undefined,
    };
  }

  /**
   * 获取自上次索引以来已变更的文件。
   * 优先使用 git status 快速路径，失败时回退到全量扫描。
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    const gitChanges = getGitChangedFiles(this.rootDir);

    if (gitChanges) {
      // === Git 快速路径 ===
      const added: string[] = [];
      const modified: string[] = [];
      const removed: string[] = [];

      // 已删除文件——仅当在 DB 中有记录时才报告
      for (const filePath of gitChanges.deleted) {
        const tracked = this.queries.getFileByPath(filePath);
        if (tracked) {
          removed.push(filePath);
        }
      }

      // 已修改 + 已添加文件——读取并哈希，与 DB 对比。未跟踪（`??`）
      // 文件在索引后仍在 git 中保持未跟踪状态，因此必须像已修改文件
      // 一样进行哈希对比，而不是始终计为添加——
      // 否则 status 会永远将它们报告为待处理。（参见 issue #206。）
      for (const filePath of [...gitChanges.modified, ...gitChanges.added]) {
        const fullPath = path.join(this.rootDir, filePath);
        let content: string;
        try {
          content = fs.readFileSync(fullPath, 'utf-8');
        } catch (error) {
          logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
          continue;
        }

        const contentHash = hashContent(content);
        const tracked = this.queries.getFileByPath(filePath);

        if (!tracked) {
          added.push(filePath);
        } else if (tracked.contentHash !== contentHash) {
          modified.push(filePath);
        }
      }

      return { added, modified, removed };
    }

    // === 回退：全量扫描（非 git 项目或 git 失败）===
    const currentFiles = new Set(scanDirectory(this.rootDir));
    const trackedFiles = this.queries.getAllFiles();

    // 构建 Map 以实现 O(1) 查找
    const trackedMap = new Map<string, FileRecord>();
    for (const f of trackedFiles) {
      trackedMap.set(f.path, f);
    }

    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];

    // 查找已删除文件
    for (const tracked of trackedFiles) {
      if (!currentFiles.has(tracked.path)) {
        removed.push(tracked.path);
      }
    }

    // 查找已添加和已修改文件
    for (const filePath of currentFiles) {
      const fullPath = path.join(this.rootDir, filePath);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
        continue;
      }

      const contentHash = hashContent(content);
      const tracked = trackedMap.get(filePath);

      if (!tracked) {
        added.push(filePath);
      } else if (tracked.contentHash !== contentHash) {
        modified.push(filePath);
      }
    }

    return { added, modified, removed };
  }
}

// Re-export useful types and functions
export { extractFromSource } from './tree-sitter';
export { detectLanguage, isSourceFile, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './grammars';
