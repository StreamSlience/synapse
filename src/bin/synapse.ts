#!/usr/bin/env node
/**
 * Synapse CLI
 *
 * Synapse 代码智能的命令行界面。
 *
 * 用法：
 *   synapse                    运行交互式安装器（无参数时）
 *   synapse install            运行交互式安装器
 *   synapse uninstall          从各智能体中移除 Synapse
 *   synapse init [path]        在项目中初始化 Synapse
 *   synapse uninit [path]      从项目中移除 Synapse
 *   synapse index [path]       对项目中所有文件建立索引
 *   synapse sync [path]        同步自上次索引以来的变更
 *   synapse status [path]      显示索引状态
 *   synapse query <search>     搜索符号
 *   synapse files [options]    显示项目文件结构
 *   synapse context <task>     为任务构建上下文
 *   synapse callers <symbol>   查找调用某函数/方法的调用方
 *   synapse callees <symbol>   查找某函数/方法所调用的被调用方
 *   synapse impact <symbol>    分析修改某符号会影响哪些代码
 *   synapse affected [files]   查找受变更影响的测试文件
 *   synapse upgrade [version]  将 Synapse 更新至最新版本
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { getSynapseDir, isInitialized, unsafeIndexRootReason, findNearestSynapseRoot } from '../directory';
import { detectWorktreeIndexMismatch, worktreeMismatchWarning } from '../sync/worktree';
import { createShimmerProgress } from '../ui/shimmer-progress';
import { getGlyphs } from '../ui/glyphs';

import { buildNode25BlockBanner, buildNodeTooOldBanner, MIN_NODE_MAJOR } from './node-version-check';
import { installFatalHandlers } from './fatal-handler';
import { relaunchWithWasmRuntimeFlagsIfNeeded } from '../extraction/wasm-runtime-flags';
import { EXTRACTION_VERSION } from '../extraction/extraction-version';
import { getTelemetry, TELEMETRY_DOCS, recordIndexEvent } from '../telemetry';

// 延迟加载重量级模块（Synapse、runInstaller）以保持 CLI 启动速度。
async function loadSynapse(): Promise<typeof import('../index')> {
  try {
    return await import('../index');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\x1b[31m${getGlyphs().err}\x1b[0m Failed to load Synapse modules.`);
    console.error(`\n  Node: ${process.version}  Platform: ${process.platform} ${process.arch}`);
    console.error(`\n  Error: ${msg}`);
    console.error('\n  Try reinstalling with: npm install -g @colbymchenry/synapse\n');
    process.exit(1);
  }
}

// 动态 import 辅助函数——tsc 在 CJS 模式下会将 import() 编译为 require()，
// 对纯 ESM 包会失败。此方法绕过该转换。
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<typeof import('@clack/prompts')>;

// 在 Node.js 25.x 上阻断 Synapse——V8 的 turboshaft WASM JIT 存在 Zone
// 分配器 bug，在编译 tree-sitter 语法文件时会可靠地崩溃
//（见 #54、#81、#140）。之前的行为是打印一条柔和的 console.warn，
// 在 OOM 崩溃前 30 秒就已滚出屏幕，导致持续收到"这是什么 OOM"的反馈。
// 在任何 WASM 工作之前强制退出；对于已自行修补 V8 或希望测试未来修复
// 的用户，可通过环境变量覆盖此行为。
const nodeVersion = process.versions.node;
const nodeMajor = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
if (nodeMajor >= 25) {
  process.stderr.write(buildNode25BlockBanner(nodeVersion) + '\n');
  if (!process.env.SYNAPSE_ALLOW_UNSAFE_NODE) {
    process.exit(1);
  }
  // 已启用覆盖——已显示提示横幅，继续运行。
}
// 强制执行受支持的 Node 版本下限。package.json 中的 `engines` 仅在安装时
// *警告*（除非启用了 engine-strict），因此在此处硬性阻断，以真正阻止用户
// 使用不受支持的版本。与上面的 25+ 阻断逻辑一致。参见 package.json `engines`。
if (nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(buildNodeTooOldBanner(nodeVersion) + '\n');
  if (!process.env.SYNAPSE_ALLOW_UNSAFE_NODE) {
    process.exit(1);
  }
  // 已启用覆盖——已显示提示横幅，继续运行。
}

// 如果尚未设置 V8 的 `--liftoff-only` 标志，则以此标志重新执行进程，
// 避免 tree-sitter 的大型 WASM 语法文件在 Node >= 22 上触发 turboshaft
// Zone OOM（`Fatal process out of memory: Zone`）。在已打包的启动器下
// 此操作为空操作，因为该标志已预先传入。必须在任何语法文件被编译之前运行
//（语法在解析 worker 中编译，该 worker 继承本进程的标志）。
// 参见 ../extraction/wasm-runtime-flags。
relaunchWithWasmRuntimeFlagsIfNeeded(__filename);

// 最后防线致命错误处理器：记录一行有界日志并以非零退出码退出。
// 到达此处的错误已逃逸所有边界，进程处于未定义状态——保持其存活
// 正是导致分离的 MCP 守护进程孤立并以无法恢复的状态占满一个 CPU 核心
// 的原因（#799、#850）。在命令分支之前安装，以覆盖启动时的同步异常。
// 参见 ./fatal-handler。
installFatalHandlers();

// 检查是否无参数运行——运行安装器
if (process.argv.length === 2) {
  import('../installer').then(({ runInstaller }) =>
    runInstaller()
  ).catch((err) => {
    console.error('Installation failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  // 正常 CLI 流程
  main();
}

function main() {

const program = new Command();

// 从 package.json 读取版本号
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')
);

// 让版本号触手可及。commander 的 `.version()`（见下方）挂载了
// `--version` 和 `-V`；在解析前拦截它无法处理的拼写——小写 `-v`
// 和单横线 `-version`。（commander 的版本短标志是大写 `-V`，
// 其解析器会拒绝多字符单横线标志。）裸命令 `synapse version`
// 在下方注册为子命令，以便该入口也出现在 `synapse --help` 中。
const firstArg = process.argv[2];
if (firstArg === '-v' || firstArg === '-version') {
  console.log(packageJson.version);
  return;
}

// =============================================================================
// ANSI 颜色辅助工具（避免 chalk ESM 兼容问题）
// =============================================================================

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

const chalk = {
  bold: (s: string) => `${colors.bold}${s}${colors.reset}`,
  dim: (s: string) => `${colors.dim}${s}${colors.reset}`,
  red: (s: string) => `${colors.red}${s}${colors.reset}`,
  green: (s: string) => `${colors.green}${s}${colors.reset}`,
  yellow: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  blue: (s: string) => `${colors.blue}${s}${colors.reset}`,
  cyan: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  white: (s: string) => `${colors.white}${s}${colors.reset}`,
  gray: (s: string) => `${colors.gray}${s}${colors.reset}`,
};

program
  .name('synapse')
  .description('Code intelligence and knowledge graph for any codebase')
  .version(packageJson.version);

// 匿名使用遥测（参见 TELEMETRY.md）：仅记录所调用子命令的名称——
// 不记录参数或路径。计数在本地缓冲；网络发送搭载在那些本就需要长时间
// 运行的命令上（快速命令仅在退出时追加到本地缓冲，零开销）。
// install/uninstall 刻意不在此处——安装器在其自身结束时刷新，
// 在用户看到同意提示之后——若在此处刷新，会在用户看到开关之前
// 触发首次运行通知。
const TELEMETRY_FLUSH_COMMANDS = new Set(['init', 'uninit', 'index', 'sync', 'upgrade']);
program.hook('preAction', (_thisCommand, actionCommand) => {
  try {
    // 分离的守护进程内部会重新调用 `serve --mcp`——不属于用户操作。
    if (process.env.SYNAPSE_DAEMON_INTERNAL) return;
    const name = actionCommand.name();
    if (name === 'telemetry') return; // 管理遥测本身不算使用量
    getTelemetry().recordUsage('cli_command', name, true);
    if (TELEMETRY_FLUSH_COMMANDS.has(name)) getTelemetry().maybeFlush();
  } catch {
    /* 遥测绝不能破坏 CLI */
  }
});

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 从参数或当前目录解析项目路径。
 * 向上遍历父目录，查找最近已初始化的 Synapse 项目
 *（必须包含 .synapse/synapse.db，而不仅是 .synapse/lessons.db）。
 */
function resolveProjectPath(pathArg?: string): string {
  const absolutePath = path.resolve(pathArg || process.cwd());

  // 若该精确路径已初始化（存在 synapse.db），直接使用
  if (isInitialized(absolutePath)) {
    return absolutePath;
  }

  // 向上查找最近已初始化 Synapse 的父目录
  // 注意：findNearestSynapseRoot 查找任意 .synapse 文件夹，
  // 但此处需要包含 synapse.db 的那个
  let current = absolutePath;
  const root = path.parse(current).root;

  while (current !== root) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;

    if (isInitialized(current)) {
      return current;
    }
  }

  // 未找到——返回原始路径（稍后会以友好的错误信息失败）
  return absolutePath;
}

/**
 * 将数字格式化为带千位分隔符的字符串
 */
function formatNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * 将毫秒时长格式化为可读字符串
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

// Shimmer 进度渲染器（在 worker 线程中运行以实现流畅动画）
// 在文件顶部从 '../ui/shimmer-progress' 引入

/**
 * 为 --verbose 模式创建纯文本进度回调。
 * 无动画，无 ANSI 特效——仅向 stdout 输出带时间戳的行。
 */
function createVerboseProgress(): (progress: { phase: string; current: number; total: number; currentFile?: string }) => void {
  let lastPhase = '';
  let lastPct = -1;
  const startTime = Date.now();

  return (progress) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (progress.phase !== lastPhase) {
      lastPhase = progress.phase;
      lastPct = -1;
      console.log(`[${elapsed}s] Phase: ${progress.phase}`);
    }

    if (progress.total > 0) {
      const pct = Math.floor((progress.current / progress.total) * 100);
      // 每 5% 记录一次，保持输出可读
      if (pct >= lastPct + 5 || progress.current === progress.total) {
        lastPct = pct;
        console.log(`[${elapsed}s]   ${progress.current}/${progress.total} (${pct}%)${progress.currentFile ? ` ${getGlyphs().dash} ${progress.currentFile}` : ''}`);
      }
    } else if (progress.current > 0) {
      // 扫描阶段（尚无总数）——定期记录
      if (progress.current % 1000 === 0 || progress.current === 1) {
        console.log(`[${elapsed}s]   ${formatNumber(progress.current)} files found`);
      }
    }
  };
}

/**
 * 打印成功消息
 */
function success(message: string): void {
  console.log(chalk.green(getGlyphs().ok) + ' ' + message);
}

/**
 * 打印错误消息
 */
function error(message: string): void {
  console.error(chalk.red(getGlyphs().err) + ' ' + message);
}

/**
 * 打印信息消息
 */
function info(message: string): void {
  console.log(chalk.blue(getGlyphs().info) + ' ' + message);
}

/**
 * 打印警告消息
 */
function warn(message: string): void {
  console.log(chalk.yellow(getGlyphs().warn) + ' ' + message);
}

type IndexResult = {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>;
  durationMs: number;
};

/**
 * 使用 clack log 方法打印索引结果
 */
function printIndexResult(clack: typeof import('@clack/prompts'), result: IndexResult, projectPath?: string): void {
  const hasErrors = result.filesErrored > 0;

  // 在进入文件数量分支之前，先呈现非文件级失败
  //（例如另一个索引器正在运行时获取锁失败）。
  // 若没有此逻辑，CLI 会走到"No files found to index"分支，
  // 给出积极的误导信息——索引确实运行了，只是无法获取锁。
  //
  // 如果 success 为 false 但 result.errors 中不存在 severity:'error' 条目
  //（退化情况——实际上不应发生，但值得防御，因为结果形状会
  // 经过多个调用点传递），则回退到通用消息，而不是继续走
  // 误导性的"No files found"分支或抛出异常。
  if (!result.success && !hasErrors && result.filesIndexed === 0) {
    const generic = result.errors.find((e) => e.severity === 'error');
    clack.log.error(generic?.message ?? `Indexing failed ${getGlyphs().dash} no further details available`);
    return;
  }

  if (result.filesIndexed > 0) {
    if (hasErrors) {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} could not be parsed)`);
    } else {
      clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files`);
    }
    clack.log.info(`${formatNumber(result.nodesCreated)} nodes, ${formatNumber(result.edgesCreated)} edges in ${formatDuration(result.durationMs)}`);
  } else if (hasErrors) {
    clack.log.error(`Indexing failed ${getGlyphs().dash} all ${formatNumber(result.filesErrored)} files had errors`);
  } else {
    clack.log.warn('No files found to index');
  }

  if (hasErrors) {
    const errorsByCode = new Map<string, number>();
    for (const err of result.errors) {
      if (err.severity === 'error') {
        const code = err.code || 'unknown';
        errorsByCode.set(code, (errorsByCode.get(code) || 0) + 1);
      }
    }

    const codeLabels: Record<string, string> = {
      parse_error: 'files failed to parse',
      read_error: 'files could not be read',
      size_exceeded: 'files exceeded size limit',
      path_traversal: 'blocked paths',
      unsupported_language: 'unsupported language',
      parser_error: 'parser initialization failures',
    };

    const breakdown = Array.from(errorsByCode)
      .map(([code, count]) => `${formatNumber(count)} ${codeLabels[code] || code}`)
      .join('\n');
    clack.note(breakdown, 'Error breakdown');

    if (projectPath) {
      writeErrorLog(projectPath, result.errors);
      clack.log.info('See .synapse/errors.log for details');
    }

    if (result.filesIndexed > 0) {
      clack.log.info(`The index is fully usable ${getGlyphs().dash} only the failed files are missing.`);
    }
  } else if (projectPath) {
    const logPath = path.join(getSynapseDir(projectPath), 'errors.log');
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
  }
}

/**
 * 将详细错误日志写入 .synapse/errors.log
 */
function writeErrorLog(projectPath: string, errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>): void {
  const cgDir = getSynapseDir(projectPath);
  if (!fs.existsSync(cgDir)) return;

  const logPath = path.join(cgDir, 'errors.log');

  // 按文件路径分组错误
  const errorsByFile = new Map<string, Array<{ message: string; code?: string }>>();
  const noFileErrors: Array<{ message: string; code?: string }> = [];

  for (const err of errors) {
    if (err.severity !== 'error') continue;
    if (err.filePath) {
      let list = errorsByFile.get(err.filePath);
      if (!list) {
        list = [];
        errorsByFile.set(err.filePath, list);
      }
      list.push({ message: err.message, code: err.code });
    } else {
      noFileErrors.push({ message: err.message, code: err.code });
    }
  }

  const lines: string[] = [
    `Synapse Error Log - ${new Date().toISOString()}`,
    `${errorsByFile.size} files with errors`,
    '',
  ];

  for (const [filePath, fileErrors] of errorsByFile) {
    for (const err of fileErrors) {
      lines.push(`${filePath}: ${err.message}`);
    }
  }

  for (const err of noFileErrors) {
    lines.push(err.message);
  }

  fs.writeFileSync(logPath, lines.join('\n') + '\n');
}

/**
 * 记录一次完整索引的遥测数据（参见 TELEMETRY.md）。有界刷新
 * 使 init/index 保持响应（这些命令本来就已运行了数秒），
 * 同时确保事件能及时发送。
 */
async function recordIndexTelemetry(
  cg: { getStats(): { filesByLanguage: Record<string, number> }; getBackend(): string },
  result: IndexResult,
): Promise<void> {
  recordIndexEvent(cg, result);
  await getTelemetry().flushNow();
}

// =============================================================================
// 命令
// =============================================================================

/**
 * synapse init [path]
 */
program
  .command('init [path]')
  .description('Initialize Synapse in a project directory and build the initial index')
  .option('-i, --index', 'Deprecated: indexing now runs by default; flag accepted for backward compatibility')
  .option('-f, --force', 'Initialize even if the path looks like your home directory or a filesystem root')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .action(async (pathArg: string | undefined, options: { index?: boolean; force?: boolean; verbose?: boolean }) => {
    const projectPath = path.resolve(pathArg || process.cwd());
    const clack = await importESM('@clack/prompts');

    clack.intro('Initializing Synapse');

    try {
      // 拒绝对家目录或文件系统根目录建立索引——这会拉入
      // 缓存、其他项目以及整棵目录树（产生数 GB 的索引 + watcher
      // 抖动，在 macOS 1.0 之前版本上甚至会耗尽 fd 导致机器崩溃，#845）。
      const unsafe = unsafeIndexRootReason(projectPath);
      if (unsafe && !options.force) {
        clack.log.error(`Refusing to initialize in ${projectPath} — it looks like ${unsafe}.`);
        clack.log.info('Run this inside a specific project directory, or pass --force if you really mean to index everything under it.');
        clack.outro('');
        process.exitCode = 1;
        return;
      }

      if (isInitialized(projectPath)) {
        clack.log.warn(`Already initialized in ${projectPath}`);
        clack.log.info('Use "synapse index" to re-index or "synapse sync" to update');
        try {
          const { offerWatchFallback } = await import('../installer');
          await offerWatchFallback(clack, projectPath);
        } catch { /* 非致命 */ }
        clack.outro('');
        return;
      }

      const { default: Synapse } = await loadSynapse();
      const cg = await Synapse.init(projectPath, { index: false });
      clack.log.success(`Initialized in ${projectPath}`);

      // 现在默认执行索引。遗留的 -i/--index 标志仍被接受
      //（以免破坏已有的肌肉记忆和脚本），但实际为空操作——
      // 初始化始终会构建初始索引。
      let result: IndexResult;
      if (options.verbose) {
        result = await cg.indexAll({
          onProgress: createVerboseProgress(),
          verbose: true,
        });
      } else {
        process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
        const progress = createShimmerProgress();
        result = await cg.indexAll({
          onProgress: progress.onProgress,
        });
        await progress.stop();
      }
      printIndexResult(clack, result, projectPath);
      await recordIndexTelemetry(cg, result);

      try {
        const { offerWatchFallback } = await import('../installer');
        await offerWatchFallback(clack, projectPath);
      } catch { /* 非致命 */ }

      clack.outro('Done');
      cg.destroy();
    } catch (err) {
      clack.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * synapse uninit [path]
 */
program
  .command('uninit [path]')
  .description('Remove Synapse from a project (deletes .synapse/ directory)')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (pathArg: string | undefined, options: { force?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        warn(`Synapse is not initialized in ${projectPath}`);
        return;
      }

      if (!options.force) {
        // 向用户确认
        const readline = await import('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(
            chalk.yellow(`${getGlyphs().warn} This will permanently delete all Synapse data. Continue? (y/N) `),
            resolve
          );
        });
        rl.close();

        if (answer.toLowerCase() !== 'y') {
          info('Cancelled');
          return;
        }
      }

      const { default: Synapse } = await loadSynapse();
      const cg = Synapse.openSync(projectPath);
      cg.uninitialize();

      // 清理已安装的 git 同步钩子（若无或非 git 仓库则为空操作）。
      try {
        const { removeGitSyncHook } = await import('../sync/git-hooks');
        const removed = removeGitSyncHook(projectPath);
        if (removed.installed.length > 0) {
          info(`Removed git ${removed.installed.join(', ')} sync hook${removed.installed.length > 1 ? 's' : ''}`);
        }
      } catch { /* 非致命 */ }

      success(`Removed Synapse from ${projectPath}`);

      // 流失信号——立即刷新，因为 uninit 之后可能不存在
      // "下次运行"来发送该事件。
      try {
        getTelemetry().recordLifecycle('uninstall', {});
        await getTelemetry().flushNow();
      } catch { /* 非致命 */ }
    } catch (err) {
      error(`Failed to uninitialize: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * synapse index [path]
 */
program
  .command('index [path]')
  .description('Rebuild the full index from scratch (same result as a fresh init)')
  .option('-f, --force', 'Index even if the path looks like your home directory or a filesystem root')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-v, --verbose', 'Show detailed worker lifecycle and memory info')
  .action(async (pathArg: string | undefined, options: { force?: boolean; quiet?: boolean; verbose?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      // 不要对家目录或文件系统根目录进行（重）索引（#845）。
      // --force 同时充当覆盖开关。
      const unsafe = unsafeIndexRootReason(projectPath);
      if (unsafe && !options.force) {
        error(`Refusing to index ${projectPath} — it looks like ${unsafe}. Pass --force to override.`);
        process.exit(1);
      }

      if (!isInitialized(projectPath)) {
        error(`Synapse not initialized in ${projectPath}`);
        info('Run "synapse init" first');
        process.exit(1);
      }

      const { default: Synapse } = await loadSynapse();
      const cg = await Synapse.open(projectPath);

      if (options.quiet) {
        // 静默模式：无 UI，直接运行。`index` 是完整重建索引，
        // 因此先清除已有图再从头重建（见下方说明——#874）。
        cg.clear();
        const result = await cg.indexAll();
        if (!result.success) process.exit(1);
        cg.destroy();
        return;
      }

      const clack = await importESM('@clack/prompts');
      clack.intro('Indexing project');

      // `index` 是完整重建索引：先清除已有图，再从头重建，
      // 使结果与全新的 `init` 完全一致。若不清除，indexAll()
      // 会按内容哈希跳过每个未变更的文件，报告"0 nodes, 0 edges"
      // 但图实际已存在——读起来像是"index 抹掉了我的索引"（#874）。
      // 如需快速增量更新，请使用 `sync`。
      cg.clear();

      let result: IndexResult;

      if (options.verbose) {
        result = await cg.indexAll({
          onProgress: createVerboseProgress(),
          verbose: true,
        });
      } else {
        process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
        const progress = createShimmerProgress();
        result = await cg.indexAll({
          onProgress: progress.onProgress,
        });
        await progress.stop();
      }

      printIndexResult(clack, result, projectPath);
      await recordIndexTelemetry(cg, result);

      if (!result.success) {
        process.exit(1);
      }

      clack.outro('Done');
      cg.destroy();
    } catch (err) {
      error(`Failed to index: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * synapse sync [path]
 */
program
  .command('sync [path]')
  .description('Sync changes since last index')
  .option('-q, --quiet', 'Suppress output (for git hooks)')
  .action(async (pathArg: string | undefined, options: { quiet?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        if (!options.quiet) {
          error(`Synapse not initialized in ${projectPath}`);
        }
        process.exit(1);
      }

      const { default: Synapse } = await loadSynapse();
      const cg = await Synapse.open(projectPath);

      if (options.quiet) {
        await cg.sync();
        cg.destroy();
        return;
      }

      const clack = await importESM('@clack/prompts');
      clack.intro('Syncing Synapse');

      process.stdout.write(`${colors.dim}${getGlyphs().rail}${colors.reset}\n`);
      const progress = createShimmerProgress();

      const result = await cg.sync({
        onProgress: progress.onProgress,
      });

      await progress.stop();

      const totalChanges = result.filesAdded + result.filesModified + result.filesRemoved;

      if (totalChanges === 0) {
        clack.log.info('Already up to date');
      } else {
        clack.log.success(`Synced ${formatNumber(totalChanges)} changed files`);
        const details: string[] = [];
        if (result.filesAdded > 0) details.push(`Added: ${result.filesAdded}`);
        if (result.filesModified > 0) details.push(`Modified: ${result.filesModified}`);
        if (result.filesRemoved > 0) details.push(`Removed: ${result.filesRemoved}`);
        clack.log.info(`${details.join(', ')} ${getGlyphs().dash} ${formatNumber(result.nodesUpdated)} nodes in ${formatDuration(result.durationMs)}`);
      }

      clack.outro('Done');
      cg.destroy();
    } catch (err) {
      if (!options.quiet) {
        error(`Failed to sync: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
  });

/**
 * synapse status [path]
 */
program
  .command('status [path]')
  .description('Show index status and statistics')
  .option('-j, --json', 'Output as JSON')
  .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);
    // 用户实际运行的目录，向上查找索引根目录之前的起始路径。
    // 用于检测解析到的索引是否位于不同的 git 工作树中
    //（例如嵌套 worktree 借用主 checkout 的索引）。
    const startPath = path.resolve(pathArg || process.cwd());
    const worktreeMismatch = detectWorktreeIndexMismatch(startPath, projectPath);

    try {
      if (!isInitialized(projectPath)) {
        if (options.json) {
          console.log(JSON.stringify({
            initialized: false,
            version: packageJson.version,
            projectPath,
            indexPath: getSynapseDir(projectPath),
            lastIndexed: null,
          }));
          return;
        }
        console.log(chalk.bold('\nSynapse Status\n'));
        info(`Project: ${projectPath}`);
        warn('Not initialized');
        info('Run "synapse init" to initialize');
        return;
      }

      const { default: Synapse } = await loadSynapse();
      const cg = await Synapse.open(projectPath);
      const stats = cg.getStats();
      const changes = cg.getChangedFiles();
      const backend = cg.getBackend();
      const journalMode = cg.getJournalMode();

      const buildInfo = cg.getIndexBuildInfo();
      const reindexRecommended = cg.isIndexStale();

      // JSON 输出模式
      if (options.json) {
        const lastIndexedMs = cg.getLastIndexedAt();
        console.log(JSON.stringify({
          initialized: true,
          version: packageJson.version,
          projectPath,
          indexPath: getSynapseDir(projectPath),
          lastIndexed: lastIndexedMs != null ? new Date(lastIndexedMs).toISOString() : null,
          fileCount: stats.fileCount,
          nodeCount: stats.nodeCount,
          edgeCount: stats.edgeCount,
          dbSizeBytes: stats.dbSizeBytes,
          backend,
          journalMode,
          nodesByKind: stats.nodesByKind,
          languages: Object.entries(stats.filesByLanguage).filter(([, count]) => count > 0).map(([lang]) => lang),
          pendingChanges: {
            added: changes.added.length,
            modified: changes.modified.length,
            removed: changes.removed.length,
          },
          worktreeMismatch: worktreeMismatch
            ? { worktreeRoot: worktreeMismatch.worktreeRoot, indexRoot: worktreeMismatch.indexRoot }
            : null,
          index: {
            builtWithVersion: buildInfo.version,
            builtWithExtractionVersion: buildInfo.extractionVersion,
            currentExtractionVersion: EXTRACTION_VERSION,
            reindexRecommended,
          },
        }));
        cg.destroy();
        return;
      }

      console.log(chalk.bold('\nSynapse Status\n'));

      // 项目信息
      console.log(chalk.cyan('Project:'), projectPath);
      if (worktreeMismatch) {
        warn(worktreeMismatchWarning(worktreeMismatch));
      }
      console.log();

      // 索引统计
      console.log(chalk.bold('Index Statistics:'));
      console.log(`  Files:     ${formatNumber(stats.fileCount)}`);
      console.log(`  Nodes:     ${formatNumber(stats.nodeCount)}`);
      console.log(`  Edges:     ${formatNumber(stats.edgeCount)}`);
      console.log(`  DB Size:   ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`);
      // 显示当前活跃的 SQLite 后端（node:sqlite——Node 内置真实
      // SQLite，完整 WAL + FTS5，无需原生构建）。
      const backendLabel = chalk.green(`node:sqlite ${getGlyphs().dash} built-in (full WAL)`);
      console.log(`  Backend:   ${backendLabel}`);
      // 有效日志模式：'wal' 表示并发读取永不会被写入者阻塞；
      // 其他模式则可能被阻塞（"database is locked"）。node:sqlite
      // 在所有平台支持 WAL，因此非 wal 模式意味着文件系统不支持
      //（网络挂载、WSL2 /mnt）。参见 issue #238。
      const journalLabel = journalMode === 'wal'
        ? chalk.green('wal')
        : chalk.yellow(`${journalMode || 'unknown'} ${getGlyphs().dash} WAL inactive; reads can block on writes`);
      console.log(`  Journal:   ${journalLabel}`);
      console.log();

      // 节点分类
      console.log(chalk.bold('Nodes by Kind:'));
      const nodesByKind = Object.entries(stats.nodesByKind)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [kind, count] of nodesByKind) {
        console.log(`  ${kind.padEnd(15)} ${formatNumber(count)}`);
      }
      console.log();

      // 语言分类
      console.log(chalk.bold('Files by Language:'));
      const filesByLang = Object.entries(stats.filesByLanguage)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      for (const [lang, count] of filesByLang) {
        console.log(`  ${lang.padEnd(15)} ${formatNumber(count)}`);
      }
      console.log();

      // 待处理的变更
      const totalChanges = changes.added.length + changes.modified.length + changes.removed.length;
      if (totalChanges > 0) {
        console.log(chalk.bold('Pending Changes:'));
        if (changes.added.length > 0) {
          console.log(`  Added:     ${changes.added.length} files`);
        }
        if (changes.modified.length > 0) {
          console.log(`  Modified:  ${changes.modified.length} files`);
        }
        if (changes.removed.length > 0) {
          console.log(`  Removed:   ${changes.removed.length} files`);
        }
        info('Run "synapse sync" to update the index');
      } else {
        success('Index is up to date');
      }
      console.log();

      // 重建索引提示：索引由比当前引擎更旧的引擎构建，
      // 重建可以获得迁移无法回填的数据。
      if (reindexRecommended) {
        const builtWith = buildInfo.version ? `v${buildInfo.version.replace(/^v/, '')}` : 'an earlier version';
        warn(`Index was built by ${builtWith}; re-index to pick up this engine's improvements.`);
        info('Run "synapse index" (full rebuild) or "synapse sync"');
        console.log();
      }

      cg.destroy();
    } catch (err) {
      error(`Failed to get status: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * synapse query <search>
 */
program
  .command('query <search>')
  .description('Search for symbols in the codebase')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '10')
  .option('-k, --kind <kind>', 'Filter by node kind (function, class, etc.)')
  .option('-j, --json', 'Output as JSON')
  .action(async (search: string, options: { path?: string; limit?: string; kind?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`Synapse not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: Synapse } = await loadSynapse();
      const cg = await Synapse.open(projectPath);

      const limit = parseInt(options.limit || '10', 10);
      const rawResults = cg.searchNodes(search, {
        limit,
        kinds: options.kind ? [options.kind as any] : undefined,
      });

      // 镜像 MCP search 的降权逻辑，使 CLI 在同名符号中
      // 也优先呈现手写实现而非 protobuf/gRPC 脚手架。
      // 参见 extraction/generated-detection.ts。
      const { isGeneratedFile } = await import('../extraction/generated-detection');
      const results = [...rawResults].sort((a, b) => {
        const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
        const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
        return aGen - bGen;
      });

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        if (results.length === 0) {
          info(`No results found for "${search}"`);
        } else {
          console.log(chalk.bold(`\nSearch Results for "${search}":\n`));

          for (const result of results) {
            const node = result.node;
            const location = `${node.filePath}:${node.startLine}`;
            const score = chalk.dim(`(${(result.score * 100).toFixed(0)}%)`);

            console.log(
              chalk.cyan(node.kind.padEnd(12)) +
              chalk.white(node.name) +
              ' ' + score
            );
            console.log(chalk.dim(`  ${location}`));
            if (node.signature) {
              console.log(chalk.dim(`  ${node.signature}`));
            }
            console.log();
          }
        }
      }

      cg.destroy();
    } catch (err) {
      error(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * synapse explore <query...>
 *
 * MCP synapse_explore 工具的 CLI 界面——使用相同的处理器，
 * 输出相同的内容（相关符号的源码按文件分组 + 它们之间的调用路径）。
 * 存在的意义是让没有 MCP 工具的智能体——Task-tool 子智能体
 *（不继承 MCP 工具，#704）和非 MCP 执行环境——
 * 能通过普通的 shell 命令访问知识图谱。
 */
program
  .command('explore <query...>')
  .description('Explore an area: relevant symbols\' source + call paths in one shot (same output as the synapse_explore MCP tool)')
  .option('-p, --path <path>', 'Project path')
  .option('--max-files <number>', 'Maximum number of files to include source from')
  .action(async (queryParts: string[], options: { path?: string; maxFiles?: string }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`Synapse isn't available here — no .synapse/ index exists in ${projectPath}. If you are an AI agent: continue with your usual tools; indexing is the user's decision, do not run it yourself. (The project owner can enable Synapse with 'synapse init'.)`);
        process.exit(1);
      }

      const { default: Synapse } = await loadSynapse();
      const cg = await Synapse.open(projectPath);
      const { ToolHandler } = await import('../mcp/tools');
      const handler = new ToolHandler(cg);

      const args: Record<string, unknown> = { query: queryParts.join(' ') };
      if (options.maxFiles) args.maxFiles = parseInt(options.maxFiles, 10);
      const result = await handler.execute('synapse_explore', args);

      console.log(result.content[0]?.text ?? '');
      cg.destroy();
      if (result.isError) process.exit(1);
    } catch (err) {
      error(`Explore failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * synapse node <name>
 *
 * MCP synapse_node 工具的 CLI 界面：单个符号的源码 +
 * 调用方/被调用方链路，或带行号的整个文件 + 依赖方
 *（Read 等价功能）。与 `explore` 相同的子智能体/非 MCP 使用理由。
 */
program
  .command('node <name>')
  .description('One symbol\'s source + caller/callee trail, or read a file with line numbers + dependents (same output as the synapse_node MCP tool)')
  .option('-p, --path <path>', 'Project path')
  .option('-f, --file <file>', 'Treat as file mode (or disambiguate a symbol to this file)')
  .option('--offset <number>', 'File mode: 1-based start line')
  .option('--limit <number>', 'File mode: maximum lines')
  .option('--symbols-only', 'File mode: just the symbol map + dependents')
  .action(async (name: string, options: { path?: string; file?: string; offset?: string; limit?: string; symbolsOnly?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`Synapse isn't available here — no .synapse/ index exists in ${projectPath}. If you are an AI agent: continue with your usual tools; indexing is the user's decision, do not run it yourself. (The project owner can enable Synapse with 'synapse init'.)`);
        process.exit(1);
      }

      const { default: Synapse } = await loadSynapse();
      const cg = await Synapse.open(projectPath);
      const { ToolHandler } = await import('../mcp/tools');
      const handler = new ToolHandler(cg);

      // 名称中含有路径分隔符的视为文件读取；否则视为符号
      //（使用 --file 进行仅含文件名的文件读取，或指定重载对应的文件）。
      // 两种分隔符都支持：Windows 用户会输入 src\auth\session.ts。
      // 符号不会包含任何分隔符（'/' 在我们索引的任何语言中都不是
      // 标识符字符；C++ 作用域用 '::'，JS 成员用 '.'）。
      const args: Record<string, unknown> = {};
      if (options.file) {
        args.file = options.file;
        if (name && name !== options.file) args.symbol = name;
      } else if (name.includes('/') || name.includes('\\')) {
        args.file = name.replace(/\\/g, '/');
      } else {
        args.symbol = name;
        args.includeCode = true;
      }
      if (options.offset) args.offset = parseInt(options.offset, 10);
      if (options.limit) args.limit = parseInt(options.limit, 10);
      if (options.symbolsOnly) args.symbolsOnly = true;

      const result = await handler.execute('synapse_node', args);

      console.log(result.content[0]?.text ?? '');
      cg.destroy();
      if (result.isError) process.exit(1);
    } catch (err) {
      error(`Node lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * synapse files [path]
 */
program
  .command('files')
  .description('Show project file structure from the index')
  .option('-p, --path <path>', 'Project path')
  .option('--filter <dir>', 'Filter to files under this directory')
  .option('--pattern <glob>', 'Filter files matching this glob pattern')
  .option('--format <format>', 'Output format (tree, flat, grouped)', 'tree')
  .option('--max-depth <number>', 'Maximum directory depth for tree format')
  .option('--no-metadata', 'Hide file metadata (language, symbol count)')
  .option('-j, --json', 'Output as JSON')
  .action(async (options: {
    path?: string;
    filter?: string;
    pattern?: string;
    format?: string;
    maxDepth?: string;
    metadata?: boolean;
    json?: boolean;
  }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`Synapse not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: Synapse } = await loadSynapse();
      const cg = await Synapse.open(projectPath);
      let files = cg.getFiles();

      if (files.length === 0) {
        info('No files indexed. Run "synapse index" first.');
        cg.destroy();
        return;
      }

      // 按路径前缀过滤
      if (options.filter) {
        const filter = options.filter;
        files = files.filter(f => f.path.startsWith(filter) || f.path.startsWith('./' + filter));
      }

      // 按 glob 模式过滤
      if (options.pattern) {
        const regex = globToRegex(options.pattern);
        files = files.filter(f => regex.test(f.path));
      }

      if (files.length === 0) {
        info('No files found matching the criteria.');
        cg.destroy();
        return;
      }

      // JSON 输出
      if (options.json) {
        const output = files.map(f => ({
          path: f.path,
          language: f.language,
          nodeCount: f.nodeCount,
          size: f.size,
        }));
        console.log(JSON.stringify(output, null, 2));
        cg.destroy();
        return;
      }

      const includeMetadata = options.metadata !== false;
      const format = options.format || 'tree';
      const maxDepth = options.maxDepth ? parseInt(options.maxDepth, 10) : undefined;

      // 格式化输出
      switch (format) {
        case 'flat':
          console.log(chalk.bold(`\nFiles (${files.length}):\n`));
          for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
            if (includeMetadata) {
              console.log(`  ${file.path} ${chalk.dim(`(${file.language}, ${file.nodeCount} symbols)`)}`);
            } else {
              console.log(`  ${file.path}`);
            }
          }
          break;

        case 'grouped':
          console.log(chalk.bold(`\nFiles by Language (${files.length} total):\n`));
          const byLang = new Map<string, typeof files>();
          for (const file of files) {
            const existing = byLang.get(file.language) || [];
            existing.push(file);
            byLang.set(file.language, existing);
          }
          const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);
          for (const [lang, langFiles] of sortedLangs) {
            console.log(chalk.cyan(`${lang} (${langFiles.length}):`));
            for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
              if (includeMetadata) {
                console.log(`  ${file.path} ${chalk.dim(`(${file.nodeCount} symbols)`)}`);
              } else {
                console.log(`  ${file.path}`);
              }
            }
            console.log();
          }
          break;

        case 'tree':
        default:
          console.log(chalk.bold(`\nProject Structure (${files.length} files):\n`));
          printFileTree(files, includeMetadata, maxDepth, chalk);
          break;
      }

      console.log();
      cg.destroy();
    } catch (err) {
      error(`Failed to list files: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * 将用户提供的文件路径规范化为 Synapse 索引中存储的
 * 项目相对、正斜杠形式。接受绝对路径、`./` 前缀路径
 * 或 Windows 反斜杠；输入为空时返回空字符串。
 * 供 `synapse affected` 使用，使 `./src/x.ts`、
 * `/abs/repo/src/x.ts` 和 `src/x.ts` 均能匹配同一个已索引文件。（#825）
 */
function normalizeIndexPath(filePath: string, projectPath: string): string {
  let f = filePath.trim();
  if (!f) return '';
  if (path.isAbsolute(f)) f = path.relative(projectPath, f);
  // 折叠 `.`/`..` 段，然后强制使用正斜杠并去掉开头的 `./`
  //（path.normalize 在 POSIX 上已去除；Windows 上需要显式处理）。
  f = path.normalize(f).replace(/\\/g, '/').replace(/^\.\//, '');
  return f;
}

/**
 * 将 glob 模式转换为正则表达式
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(escaped);
}

/**
 * 以树形结构打印文件列表
 */
function printFileTree(
  files: { path: string; language: string; nodeCount: number }[],
  includeMetadata: boolean,
  maxDepth: number | undefined,
  chalk: { dim: (s: string) => string; cyan: (s: string) => string }
): void {
  interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    file?: { language: string; nodeCount: number };
  }

  const root: TreeNode = { name: '', children: new Map() };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      if (!current.children.has(part)) {
        current.children.set(part, { name: part, children: new Map() });
      }
      current = current.children.get(part)!;

      if (i === parts.length - 1) {
        current.file = { language: file.language, nodeCount: file.nodeCount };
      }
    }
  }

  const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
    if (maxDepth !== undefined && depth > maxDepth) return;

    const glyphs = getGlyphs();
    const connector = isLast ? glyphs.treeLast : glyphs.treeBranch;
    const childPrefix = isLast ? '    ' : glyphs.treePipe;

    if (node.name) {
      let line = prefix + connector + node.name;
      if (node.file && includeMetadata) {
        line += chalk.dim(` (${node.file.language}, ${node.file.nodeCount} symbols)`);
      }
      console.log(line);
    }

    const children = [...node.children.values()];
    children.sort((a, b) => {
      const aIsDir = a.children.size > 0 && !a.file;
      const bIsDir = b.children.size > 0 && !b.file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      const nextPrefix = node.name ? prefix + childPrefix : prefix;
      renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
    }
  };

  renderNode(root, '', true, 0);
}

/**
 * synapse daemon——后台守护进程的交互式管理界面。
 * 用方向键选择（当前项目的守护进程会浮至顶部并自动选中），
 * 按 Enter 停止。当输出不是 TTY 时，回退为纯列表模式。
 */
program
  .command('daemon')
  .aliases(['daemons'])
  .description('Manage running Synapse background daemons — pick one and press enter to stop it')
  .action(async () => {
    const { listDaemons, stopDaemonAt, stopAllDaemons } = await import('../mcp/daemon-registry');
    const { runDaemonPicker } = await import('../mcp/daemon-manager');

    const daemons = listDaemons();
    if (daemons.length === 0) {
      info('No Synapse daemons running.');
      return;
    }

    // 无 TTY（管道 / CI / 非交互式）——无法使用方向键选择，
    // 仅打印当前运行状态而不因无输入导致提示崩溃。
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      for (const d of daemons) {
        console.log(`pid ${d.pid}  v${d.version}  up ${formatDuration(Date.now() - d.startedAt)}  ${d.root}`);
      }
      return;
    }

    // 当前项目的守护进程浮至顶部并预选中。
    let cwdRoot: string | null = null;
    const found = findNearestSynapseRoot(process.cwd());
    if (found) { try { cwdRoot = fs.realpathSync(found); } catch { cwdRoot = found; } }

    const clack = await importESM('@clack/prompts');
    clack.intro('Synapse daemons');
    await runDaemonPicker({
      list: listDaemons,
      stop: stopDaemonAt,
      stopAll: stopAllDaemons,
      cwdRoot,
      now: () => Date.now(),
      select: (opts) => clack.select(opts),
      isCancel: (v) => clack.isCancel(v),
      note: (m) => clack.log.success(m),
      done: (m) => clack.outro(m),
    });
  });

/**
 * synapse serve
 */
program
  // 在 `--help` 中隐藏：这是 AI 智能体为自身启动的 stdio 入口点
  //（安装器会在每个智能体的 MCP 配置中写入 `args: ['serve','--mcp']`），
  // 而不是供人类手动运行的命令。但它仍然可以正常使用——
  // 隐藏只是将其从帮助列表中移除。参见下方的 TTY 检测逻辑，
  // 它会向手动运行的用户作出说明。
  .command('serve', { hidden: true })
  .description('Start Synapse as an MCP server for AI assistants')
  .option('-p, --path <path>', 'Project path (optional for MCP mode, uses rootUri from client)')
  .option('--mcp', 'Run as MCP server (stdio transport)')
  .option('--no-watch', 'Disable the file watcher (no auto-sync; useful on slow filesystems like WSL2 /mnt drives)')
  .action(async (options: { path?: string; mcp?: boolean; watch?: boolean }) => {
    const projectPath = options.path ? resolveProjectPath(options.path) : undefined;

    // 当传入 --no-watch 时，Commander 将 watch 设为 false。
    // 通过 watcher 和 MCP 服务器已使用的同一个环境变量检查点路由该标志。
    if (options.watch === false) {
      process.env.SYNAPSE_NO_WATCH = '1';
    }

    try {
      if (options.mcp) {
        // `serve --mcp` 是 AI 智能体为自身启动的 stdio MCP 服务器，
        // 不适合手动运行。在终端中运行会看到它挂起等待 stdin 的 JSON-RPC，
        // 给人已损坏的印象。若 stdin 是交互式 TTY，则给出说明而不是挂起。
        // 智能体的管道和分离的守护进程均为非 TTY stdin，
        // 因此此分支仅对手动输入命令的用户触发。
        if (process.stdin.isTTY && !process.env.SYNAPSE_DAEMON_INTERNAL) {
          console.error(chalk.bold('\nSynapse MCP server\n'));
          console.error("This is the MCP server your AI agent (Claude Code, Cursor, Codex, opencode, …)");
          console.error("starts automatically — you don't run it yourself.");
          console.error(`\nIt's already wired up by ${chalk.cyan('synapse install')}. To check on things:`);
          console.error(`  ${chalk.cyan('synapse status')}   ${chalk.dim('— is this project indexed and healthy?')}`);
          console.error(`  ${chalk.cyan('synapse daemon')}   ${chalk.dim('— list or stop background MCP servers')}`);
          console.error(chalk.dim('\n(Running it directly only does something when an MCP client drives it over stdin.)'));
          return;
        }
        // 启动 MCP 服务器——根据客户端传来的 rootUri 延迟初始化
        const { MCPServer } = await import('../mcp/index');
        const server = new MCPServer(projectPath);
        await server.start();
        // 服务器将持续运行直到被终止
      } else {
        // 默认：显示 MCP 模式的说明信息。
        // 使用 stderr，保持 stdout 干净，适合管道/stdio 使用。
        console.error(chalk.bold('\nSynapse MCP Server\n'));
        console.error(chalk.blue(getGlyphs().info) + ' Use --mcp flag to start the MCP server');
        console.error('\nTo use with Claude Code, add to your MCP configuration:');
        console.error(chalk.dim(`
{
  "mcpServers": {
    "synapse": {
      "command": "synapse",
      "args": ["serve", "--mcp"]
    }
  }
}
`));
        console.error('Available tools:');
        console.error(chalk.cyan('  synapse_explore') + '   - Primary: source of the relevant symbols for any question');
        console.error(chalk.cyan('  synapse_search') + '    - Search for code symbols');
        console.error(chalk.cyan('  synapse_callers') + '   - Find callers of a symbol');
        console.error(chalk.cyan('  synapse_callees') + '   - Find what a symbol calls');
        console.error(chalk.cyan('  synapse_impact') + '    - Analyze impact of changes');
        console.error(chalk.cyan('  synapse_node') + '      - Get symbol details');
        console.error(chalk.cyan('  synapse_files') + '     - Get project file structure');
        console.error(chalk.cyan('  synapse_status') + '    - Get index status');
      }
    } catch (err) {
      error(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * synapse unlock [path]
 */
program
  .command('unlock [path]')
  .description('Remove a stale lock file that is blocking indexing')
  .action(async (pathArg: string | undefined) => {
    const projectPath = resolveProjectPath(pathArg);

    try {
      if (!isInitialized(projectPath)) {
        error(`Synapse not initialized in ${projectPath}`);
        return;
      }

      const lockPath = path.join(getSynapseDir(projectPath), 'synapse.lock');

      if (!fs.existsSync(lockPath)) {
        info(`No lock file found ${getGlyphs().dash} nothing to do`);
        return;
      }

      fs.unlinkSync(lockPath);
      success('Removed lock file. You can now run indexing again.');
    } catch (err) {
      error(`Failed to remove lock: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * synapse callers <symbol>
 *
 * 与 MCP 图谱工具（synapse_callers/callees/impact）的 CLI 等价实现，
 * 使遍历查询可在脚本、CI 和 git hooks 中使用，无需运行 MCP 服务器。
 */
program
  .command('callers <symbol>')
  .description('Find all functions/methods that call a specific symbol')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: { path?: string; limit?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`Synapse not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: Synapse } = await loadSynapse();
      const cg = await Synapse.open(projectPath);
      const limit = parseInt(options.limit || '20', 10);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        info(`Symbol "${symbol}" not found`);
        cg.destroy();
        return;
      }

      const seen = new Set<string>();
      const allCallers: Array<{ name: string; kind: string; filePath: string; startLine?: number }> = [];

      for (const match of matches) {
        const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
        if (!exactMatch && matches.length > 1) continue;
        for (const c of cg.getCallers(match.node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallers.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
        }
      }

      // 回退：若精确过滤后结果为空，则使用得分最高的匹配项
      if (allCallers.length === 0 && matches[0]) {
        for (const c of cg.getCallers(matches[0].node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallers.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
        }
      }

      const limited = allCallers.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify({ symbol, callers: limited }, null, 2));
      } else if (limited.length === 0) {
        info(`No callers found for "${symbol}"`);
      } else {
        console.log(chalk.bold(`\nCallers of "${symbol}" (${limited.length}):\n`));
        for (const node of limited) {
          const loc = node.startLine ? `:${node.startLine}` : '';
          console.log(
            chalk.cyan(node.kind.padEnd(12)) +
            chalk.white(node.name)
          );
          console.log(chalk.dim(`  ${node.filePath}${loc}`));
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`callers failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * synapse callees <symbol>
 */
program
  .command('callees <symbol>')
  .description('Find all functions/methods that a specific symbol calls')
  .option('-p, --path <path>', 'Project path')
  .option('-l, --limit <number>', 'Maximum results', '20')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: { path?: string; limit?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`Synapse not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: Synapse } = await loadSynapse();
      const cg = await Synapse.open(projectPath);
      const limit = parseInt(options.limit || '20', 10);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        info(`Symbol "${symbol}" not found`);
        cg.destroy();
        return;
      }

      const seen = new Set<string>();
      const allCallees: Array<{ name: string; kind: string; filePath: string; startLine?: number }> = [];

      for (const match of matches) {
        const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
        if (!exactMatch && matches.length > 1) continue;
        for (const c of cg.getCallees(match.node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallees.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
        }
      }

      if (allCallees.length === 0 && matches[0]) {
        for (const c of cg.getCallees(matches[0].node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            allCallees.push({ name: c.node.name, kind: c.node.kind, filePath: c.node.filePath, startLine: c.node.startLine });
          }
        }
      }

      const limited = allCallees.slice(0, limit);

      if (options.json) {
        console.log(JSON.stringify({ symbol, callees: limited }, null, 2));
      } else if (limited.length === 0) {
        info(`No callees found for "${symbol}"`);
      } else {
        console.log(chalk.bold(`\nCallees of "${symbol}" (${limited.length}):\n`));
        for (const node of limited) {
          const loc = node.startLine ? `:${node.startLine}` : '';
          console.log(
            chalk.cyan(node.kind.padEnd(12)) +
            chalk.white(node.name)
          );
          console.log(chalk.dim(`  ${node.filePath}${loc}`));
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`callees failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * synapse impact <symbol>
 */
program
  .command('impact <symbol>')
  .description('Analyze what code is affected by changing a symbol')
  .option('-p, --path <path>', 'Project path')
  .option('-d, --depth <number>', 'Traversal depth', '2')
  .option('-j, --json', 'Output as JSON')
  .action(async (symbol: string, options: { path?: string; depth?: string; json?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`Synapse not initialized in ${projectPath}`);
        process.exit(1);
      }

      const { default: Synapse } = await loadSynapse();
      const cg = await Synapse.open(projectPath);
      const depth = Math.min(Math.max(parseInt(options.depth || '2', 10), 1), 10);

      const matches = cg.searchNodes(symbol, { limit: 50 });
      if (matches.length === 0) {
        info(`Symbol "${symbol}" not found`);
        cg.destroy();
        return;
      }

      // 合并所有精确匹配符号的影响子图
      const mergedNodes = new Map<string, { name: string; kind: string; filePath: string; startLine?: number }>();
      const seenEdges = new Set<string>();
      let edgeCount = 0;

      for (const match of matches) {
        const exactMatch = match.node.name === symbol || match.node.name.endsWith(`.${symbol}`) || match.node.name.endsWith(`::${symbol}`);
        if (!exactMatch && matches.length > 1) continue;
        const impact = cg.getImpactRadius(match.node.id, depth);
        for (const [id, n] of impact.nodes) {
          mergedNodes.set(id, { name: n.name, kind: n.kind, filePath: n.filePath, startLine: n.startLine });
        }
        for (const e of impact.edges) {
          const key = `${e.source}->${e.target}:${e.kind}`;
          if (!seenEdges.has(key)) {
            seenEdges.add(key);
            edgeCount++;
          }
        }
      }

      // 若精确过滤后结果为空，回退到得分最高的匹配项
      if (mergedNodes.size === 0 && matches[0]) {
        const impact = cg.getImpactRadius(matches[0].node.id, depth);
        for (const [id, n] of impact.nodes) {
          mergedNodes.set(id, { name: n.name, kind: n.kind, filePath: n.filePath, startLine: n.startLine });
        }
        edgeCount = impact.edges.length;
      }

      if (options.json) {
        console.log(JSON.stringify({
          symbol,
          depth,
          nodeCount: mergedNodes.size,
          edgeCount,
          affected: Array.from(mergedNodes.values()),
        }, null, 2));
      } else if (mergedNodes.size === 0) {
        info(`No affected symbols found for "${symbol}"`);
      } else {
        console.log(chalk.bold(`\nImpact of changing "${symbol}" — ${mergedNodes.size} affected symbols:\n`));

        // 按文件分组
        const byFile = new Map<string, Array<{ name: string; kind: string; startLine?: number }>>();
        for (const node of mergedNodes.values()) {
          const list = byFile.get(node.filePath) || [];
          list.push({ name: node.name, kind: node.kind, startLine: node.startLine });
          byFile.set(node.filePath, list);
        }

        for (const [file, nodes] of byFile) {
          console.log(chalk.cyan(file));
          for (const node of nodes) {
            const loc = node.startLine ? `:${node.startLine}` : '';
            console.log(`  ${chalk.dim(node.kind.padEnd(12))}${node.name}${chalk.dim(loc)}`);
          }
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`impact failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * synapse affected [files...]
 *
 * 查找受给定源文件影响的测试文件。
 * 通过传递依赖边的遍历，找到依赖于变更代码的测试文件。
 *
 * 用法：
 *   git diff --name-only | synapse affected --stdin
 *   synapse affected src/lib/components/Editor.svelte src/routes/+page.svelte
 */
program
  .command('affected [files...]')
  .description('Find test files affected by changed source files')
  .option('-p, --path <path>', 'Project path')
  .option('--stdin', 'Read file list from stdin (one per line)')
  .option('-d, --depth <number>', 'Max dependency traversal depth', '5')
  .option('-f, --filter <glob>', 'Custom glob filter for test files (e.g. "e2e/*.spec.ts")')
  .option('-j, --json', 'Output as JSON')
  .option('-q, --quiet', 'Only output file paths, no decoration')
  .action(async (fileArgs: string[], options: { path?: string; stdin?: boolean; depth?: string; filter?: string; json?: boolean; quiet?: boolean }) => {
    const projectPath = resolveProjectPath(options.path);

    try {
      if (!isInitialized(projectPath)) {
        error(`Synapse not initialized in ${projectPath}`);
        process.exit(1);
      }

      // 从参数或 stdin 收集变更的文件
      let changedFiles: string[] = [...(fileArgs || [])];

      if (options.stdin) {
        const stdinData = fs.readFileSync(0, 'utf-8');
        const stdinFiles = stdinData.split('\n').map(f => f.trim()).filter(Boolean);
        changedFiles.push(...stdinFiles);
      }

      // 将输入规范化为索引存储的项目相对、正斜杠形式。
      // 若无此处理，`affected ./src/x.ts`、绝对路径（包装脚本常用）
      // 或 Windows 反斜杠路径会静默匹配失败，报告 0 个受影响测试。（#825）
      changedFiles = changedFiles
        .map((f) => normalizeIndexPath(f, projectPath))
        .filter(Boolean);

      if (changedFiles.length === 0) {
        if (!options.quiet) info('No files provided. Use file arguments or --stdin.');
        process.exit(0);
      }

      const { default: Synapse } = await loadSynapse();
      const cg = await Synapse.open(projectPath);
      const maxDepth = parseInt(options.depth || '5', 10);

      // 常见测试文件模式
      const defaultTestPatterns = [
        /\.spec\./,
        /\.test\./,
        /\/__tests__\//,
        /\/tests?\//,
        /\/e2e\//,
        /\/spec\//,
      ];

      // 自定义过滤模式
      let customFilter: RegExp | null = null;
      if (options.filter) {
        // 将 glob 转换为正则表达式：** → .+，* → [^/]*，. → \.
        const regex = options.filter
          .replace(/[+[\]{}()^$|\\]/g, '\\$&')
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '.+')
          .replace(/\*/g, '[^/]*');
        customFilter = new RegExp(regex);
      }

      function isTestFile(filePath: string): boolean {
        if (customFilter) return customFilter.test(filePath);
        return defaultTestPatterns.some(p => p.test(filePath));
      }

      // BFS 查找变更文件的所有传递依赖方，过滤为测试文件
      const affectedTests = new Set<string>();
      const allDependents = new Set<string>();

      for (const file of changedFiles) {
        // 若变更的文件本身是测试文件，直接纳入
        if (isTestFile(file)) {
          affectedTests.add(file);
          continue;
        }

        // BFS 遍历依赖方
        const queue: Array<{ file: string; depth: number }> = [{ file, depth: 0 }];
        const visited = new Set<string>();
        visited.add(file);

        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current.depth >= maxDepth) continue;

          const dependents = cg.getFileDependents(current.file);
          for (const dep of dependents) {
            if (visited.has(dep)) continue;
            visited.add(dep);
            allDependents.add(dep);

            if (isTestFile(dep)) {
              affectedTests.add(dep);
            } else {
              queue.push({ file: dep, depth: current.depth + 1 });
            }
          }
        }
      }

      const sortedTests = Array.from(affectedTests).sort();

      // 输出
      if (options.json) {
        console.log(JSON.stringify({
          changedFiles,
          affectedTests: sortedTests,
          totalDependentsTraversed: allDependents.size,
        }, null, 2));
      } else if (options.quiet) {
        for (const t of sortedTests) console.log(t);
      } else {
        if (sortedTests.length === 0) {
          info('No test files affected by the changed files.');
        } else {
          console.log(chalk.bold(`\nAffected test files (${sortedTests.length}):\n`));
          for (const t of sortedTests) {
            console.log('  ' + chalk.cyan(t));
          }
          console.log();
        }
      }

      cg.destroy();
    } catch (err) {
      error(`Affected analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

/**
 * synapse install
 */
program
  .command('install')
  .description('Install synapse MCP server into one or more agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent)')
  .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "auto"|"all"|"none". Default: prompt')
  .option('-l, --location <where>', 'Install location: "global" or "local". Default: prompt')
  .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=auto, auto-allow on')
  .option('--no-permissions', 'Skip writing the auto-allow permissions list (Claude Code only)')
  .option('--print-config <id>', 'Print MCP config snippet for the named agent and exit (no file writes)')
  .action(async (opts: {
    target?: string;
    location?: string;
    yes?: boolean;
    permissions?: boolean;
    printConfig?: string;
  }) => {
    if (opts.printConfig) {
      const { getTarget, listTargetIds } = await import('../installer/targets/registry');
      const target = getTarget(opts.printConfig);
      if (!target) {
        const known = listTargetIds().join(', ');
        error(`Unknown target "${opts.printConfig}". Known: ${known}.`);
        process.exit(1);
      }
      const loc = (opts.location === 'local' ? 'local' : 'global') as 'global' | 'local';
      process.stdout.write(target.printConfig(loc));
      return;
    }

    const { runInstallerWithOptions } = await import('../installer');
    if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
      error(`--location must be "global" or "local" (got "${opts.location}").`);
      process.exit(1);
    }
    try {
      // Commander 的 `--no-permissions` 使 `opts.permissions === false`；
      // 省略该标志时值为 `true`（肯定形式的默认值）。
      // 必须将默认 true 视为"用户未覆盖——让协调器提示"，
      // 只转发显式的 `false`（或 --yes 隐含的 `true`）。
      // 否则，每次交互式运行时自动允许提示都会被静默跳过。
      const explicitNoPermissions = opts.permissions === false;
      const autoAllow: boolean | undefined = explicitNoPermissions
        ? false
        : opts.yes
          ? true
          : undefined;

      await runInstallerWithOptions({
        target: opts.target,
        location: opts.location as 'global' | 'local' | undefined,
        autoAllow,
        yes: opts.yes,
      });
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

/**
 * synapse uninstall
 *
 * `install` 的逆操作。从每个智能体（或 `--target` 指定的子集）
 * 中移除 synapse MCP 服务器条目、instructions 块和权限。
 * 若未指定则提示选择全局或本地。不删除 `.synapse/` 索引——
 * 那是 `synapse uninit` 的职责。
 */
program
  .command('uninstall')
  .description('Remove synapse from your agents (Claude Code, Cursor, Codex CLI, opencode, Hermes Agent)')
  .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "all". Default: all')
  .option('-l, --location <where>', 'Uninstall location: "global" or "local". Default: prompt')
  .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=all')
  .action(async (opts: {
    target?: string;
    location?: string;
    yes?: boolean;
  }) => {
    const { runUninstaller } = await import('../installer');
    if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
      error(`--location must be "global" or "local" (got "${opts.location}").`);
      process.exit(1);
    }
    try {
      await runUninstaller({
        target: opts.target,
        location: opts.location as 'global' | 'local' | undefined,
        yes: opts.yes,
      });
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

/**
 * synapse telemetry [on|off|status]
 */
program
  .command('telemetry [action]')
  .description('Show or change anonymous usage telemetry (status, on, off)')
  .action((action?: string) => {
    const t = getTelemetry();

    if (action === 'on' || action === 'off') {
      t.setEnabled(action === 'on', 'cli');
      if (action === 'on') {
        success('Telemetry enabled — anonymous usage stats only (no code, paths, or names).');
      } else {
        success('Telemetry disabled. Buffered, unsent data was deleted.');
      }
      const effective = t.getStatus();
      if (effective.decidedBy === 'DO_NOT_TRACK' || effective.decidedBy === 'SYNAPSE_TELEMETRY') {
        warn(
          `The ${effective.decidedBy} environment variable overrides this choice — ` +
          `effective state right now: ${effective.enabled ? 'enabled' : 'disabled'}.`
        );
      }
      return;
    }

    if (action !== undefined && action !== 'status') {
      error(`Unknown action: ${action} (expected status, on, or off)`);
      process.exit(1);
    }

    const s = t.getStatus();
    const decidedBy: Record<typeof s.decidedBy, string> = {
      DO_NOT_TRACK: 'DO_NOT_TRACK environment variable',
      SYNAPSE_TELEMETRY: 'SYNAPSE_TELEMETRY environment variable',
      config: 'your saved choice',
      default: 'default',
    };
    console.log(`\nTelemetry: ${s.enabled ? chalk.green('enabled') : chalk.yellow('disabled')} ${chalk.dim(`(${decidedBy[s.decidedBy]})`)}`);
    console.log(`Machine ID: ${s.machineId ?? chalk.dim('(random UUID, created on first use)')}`);
    console.log(`Config:     ${s.configPath}`);
    console.log(chalk.dim(`\nExactly what is collected (and never collected): ${TELEMETRY_DOCS}\n`));
  });

/**
 * synapse upgrade [version]
 *
 * 自更新，无论 Synapse 以何种方式安装
 *（通过 install.sh/.ps1 打包、npm 全局、npx 或源码 checkout）。
 * 检测逻辑和各安装方式的升级逻辑参见 ../upgrade。
 */
program
  .command('upgrade [version]')
  .description('Update Synapse to the latest release (or a specific version)')
  .option('--check', 'Check whether an update is available without installing')
  .option('-f, --force', 'Reinstall even if already on the target version')
  .action(async (versionArg: string | undefined, options: { check?: boolean; force?: boolean }) => {
    const up = await import('../upgrade');
    const method = up.detectInstallMethod({
      filename: __filename,
      platform: process.platform,
      cwd: process.cwd(),
    });
    const pin = versionArg || process.env.SYNAPSE_VERSION || undefined;
    const code = await up.runUpgrade(
      { version: pin, check: options.check, force: options.force },
      {
        currentVersion: packageJson.version,
        method,
        resolveLatest: () => up.resolveLatestVersion(),
        run: up.defaultRun,
        hasCommand: up.hasCommand,
        log: (m: string) => console.log(m),
        warn: (m: string) => warn(m),
        error: (m: string) => error(m),
        platform: process.platform,
      }
    );
    process.exit(code);
  });

/**
 * synapse version
 *
 * `--version` 的裸名词形式。commander 已提供 `--version`
 * 和 `-V`，而 `-v` / `-version` 在解析前已被拦截
 *（见 main 顶部）。此子命令使 `synapse version` 可用，
 * 并在 `synapse --help` 中列出该版本入口。
 */
program
  .command('version')
  .description('Print the installed Synapse version (also: -v, --version)')
  .action(() => {
    console.log(packageJson.version);
  });

// 解析并执行命令
program.parse();

} // end main()
