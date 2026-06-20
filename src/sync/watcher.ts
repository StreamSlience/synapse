/**
 * 文件监视器
 *
 * 监视项目目录的文件变更，并触发防抖同步操作以保持代码图最新。
 *
 * 直接使用 Node 内置的 `fs.watch`（无第三方监视器，无原生插件），
 * 并采用按平台选择的策略，将打开的描述符/内核监视开销保持在有界范围内，
 * 而非随文件数量增长：
 *
 *   - macOS / Windows：对根目录使用单个递归 `fs.watch(root, {recursive:true})`。
 *     libuv 将其映射为一个 FSEvents 流（macOS）/ 一个
 *     ReadDirectoryChangesW 句柄（Windows），无论目录树多大都只消耗 O(1) 个描述符。
 *     这是修复 macOS 文件表耗尽问题（#644 / #496 / #555 / #628）的方案：
 *     旧版监视器在 macOS 上对每个被监视文件持有一个打开的 fd
 *     （数万个 REG fd），耗尽了 `kern.maxfiles` 并导致无关进程系统级崩溃。
 *
 *   - Linux：递归 `fs.watch` 不受支持，因此对每个（未被忽略的）
 *     目录使用一个 inotify 监视——O(目录数)，而非 O(文件数)。
 *     新目录会被动态拾取，整体监视上限约束了在异常 monorepo 上的
 *     inotify 用量（#579）。单个目录的 inotify 监视已能报告其直接子文件
 *     的创建/修改/删除，因此从不需要逐文件监视。
 *
 * 排除的目录树（node_modules/、dist/、.git/ 等）通过索引器的
 * `buildScopeIgnore`（内置默认忽略目录 + 项目 .gitignore）过滤——
 * 在 Linux 上不会进入这些目录（因此不产生监视开销），
 * 在 macOS/Windows 上单个递归流仍会覆盖它们，但在调度任何同步之前
 * 会丢弃其事件。两种方式下监视器的范围都与索引器保持一致（#276 / #407）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { isSourceFile, buildScopeIgnore, type ScopeIgnore } from '../extraction';
import { logDebug, logWarn } from '../errors';
import { normalizePath } from '../utils';
import { isSynapseDataDir } from '../directory';
import { watchDisabledReason } from './watch-policy';

/**
 * 监视器在放弃并降级自动同步之前，容忍的连续锁竞争重试次数上限。
 * 短暂的竞争（另一个写入方持续几个周期）低于此值；长期外部写入方则会超过它。
 */
const MAX_LOCK_RETRIES = 5;
/** 指数级锁重试退避上限，避免等待时间过长。 */
const MAX_LOCK_RETRY_DELAY_MS = 30_000;

/** 可操作的降级消息；两条耗尽路径共用同一文本。 */
const EXHAUSTION_REASON =
  'OS watch/file limit exhausted; auto-sync disabled. Run `synapse sync` ' +
  '(or install git sync hooks) to refresh the graph after changes.';

/**
 * Linux inotify 监视计数耗尽时的可操作非致命警告。
 * 与 {@link EXHAUSTION_REASON} 不同，此警告不会禁用监视器——
 * 已安装的监视器仍继续工作——因此它指明了需要调整的内核参数，
 * 而非建议停用监视。
 */
const INOTIFY_LIMIT_REASON =
  'Linux inotify watch limit reached (fs.inotify.max_user_watches); live ' +
  'watching now covers only part of the project, so edits in unwatched ' +
  'directories will not auto-sync. Raise the limit (e.g. `sudo sysctl ' +
  'fs.inotify.max_user_watches=1048576`, persisted in /etc/sysctl.d) and ' +
  'restart, or run `synapse sync` (or install git sync hooks) to refresh.';

/**
 * 当错误为 OS 监视/文件描述符耗尽（EMFILE/ENFILE）时返回 true。
 * 优先使用结构化的 `err.code`；仅在无 code 时才回退到消息匹配
 * （某些平台从 `fs.watch` 抛出裸 Error）。
 */
function isWatchResourceExhaustion(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException | undefined;
  if (e?.code === 'EMFILE' || e?.code === 'ENFILE') return true;
  if (!e?.code && e?.message) {
    return /EMFILE|ENFILE|too many open files/i.test(e.message);
  }
  return false;
}

/**
 * 当错误为 Linux inotify *监视计数*耗尽时返回 true。`fs.watch` 将
 * `fs.inotify.max_user_watches` 耗尽表现为 ENOSPC（"无空间" = 无监视描述符，
 * 而非磁盘空间）。此错误仅在 Linux 逐目录路径上出现；为非致命错误
 * （提高上限后部分监视仍继续工作），因此发出警告而非降级。
 */
function isInotifyWatchExhaustion(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC';
}

/**
 * 原生递归 `fs.watch` 仅在 macOS 和 Windows 上可靠；在 Linux
 * （和 AIX）上会抛出 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`。
 * 我们以此为分支，选择递归还是逐目录策略。
 */
function supportsRecursiveWatch(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

/**
 * 对 `fs.watch` 的间接封装，以便测试可注入一个确定性地抛出或触发
 * `EMFILE`/`ENFILE` 的假实现（真实的监视资源耗尽无法可靠地触发，
 * 且 `fs.watch` 是不可配置的属性无法被 spy）。生产环境始终使用真实的 `fs.watch`。
 */
type WatchFn = typeof fs.watch;
let watchImpl: WatchFn = fs.watch;

/** @internal 仅供测试使用：注入假的 fs.watch 实现的接缝。 */
export function __setFsWatchForTests(fn: WatchFn | null): void {
  watchImpl = fn ?? fs.watch;
}

/**
 * Linux 逐目录路径上同时监视的目录数上限。每个目录消耗一个 inotify 监视；
 * 内核的 `fs.inotify.max_user_watches` 是硬限制（通常为 8k–128k）。
 * 超过此值后停止添加监视并记录一次日志——部分实时监视（以 `synapse sync` 作为
 * 兜底）远优于耗尽用户的 inotify 配额并破坏系统级别的监视（#579）。
 * 可通过 SYNAPSE_MAX_DIR_WATCHES 调整。
 */
const DEFAULT_MAX_DIR_WATCHES = 50_000;

function maxDirWatches(): number {
  const raw = process.env.SYNAPSE_MAX_DIR_WATCHES;
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 0) return n;
  }
  return DEFAULT_MAX_DIR_WATCHES;
}

/**
 * 测试接缝（参见 {@link __emitWatchEventForTests}）。将监视器的项目根目录
 * 映射到其活跃实例，以便测试可确定性地合成变更事件——
 * 真实 fs.watch 的传递延迟在并行 vitest 下会产生竞争
 * （这正是之前 chokidar mock 存在的原因）。
 * 仅在测试运行器下填充，因此生产环境不会产生额外的记账或引用保留。
 */
const liveWatchersForTests = new Map<string, FileWatcher>();
const IS_TEST_RUNTIME = !!(process.env.VITEST || process.env.NODE_ENV === 'test');

/**
 * 文件监视器的选项
 */
export interface WatchOptions {
  /**
   * 防抖延迟（毫秒）。
   * 最后一次文件变更后，等待此时长再触发同步。
   * 默认值：2000ms
   */
  debounceMs?: number;

  /**
   * 同步完成时的回调（用于日志/诊断）。
   */
  onSyncComplete?: (result: { filesChanged: number; durationMs: number }) => void;

  /**
   * 同步出错时的回调（用于日志/诊断）。
   */
  onSyncError?: (error: Error) => void;

  /**
   * 当实时监视因终态运行时故障（OS 监视资源耗尽 EMFILE/ENFILE，
   * 或超出重试预算的写锁竞争）永久降级时触发一次的回调。
   * 字符串为可操作的人类可读原因。
   * 让宿主（MCP 服务器、守护进程、CLI）能告知用户索引将不再自动更新，
   * 而不是静默地返回过期结果。
   */
  onDegraded?: (reason: string) => void;

  /**
   * 仅供测试使用。为 true 时，`start()` 不安装任何 OS 级别的 fs.watch——
   * 监视器处于"惰性"状态，只有 {@link __emitWatchEventForTests} /
   * {@link FileWatcher.ingestEventForTests} 接缝驱动其流水线。
   * 这恢复了单元测试所需的确定性、无 OS 的行为
   * （真实 FSEvents/inotify 传递在并行 vitest 下会产生竞争）。
   * 生产环境从不设置此项。
   */
  inertForTests?: boolean;
}

/**
 * 由 `syncFn` 抛出，用于表示底层同步无法获取跨进程写锁（#449）。
 * 监视器将此视为"无进展"——保留 `pendingFiles`，跳过 `onSyncComplete`，
 * `finally` 块重新调度。静默处理（仅调试级别），因为长期运行的外部索引器
 * 可能在每个防抖周期都触发此错误。
 */
export class LockUnavailableError extends Error {
  constructor(message = 'Synapse file lock unavailable; another process is writing') {
    super(message);
    this.name = 'LockUnavailableError';
  }
}

/**
 * 每文件的待处理条目——记录监视器已收到事件但尚未同步到索引的源文件。
 * 通过 {@link FileWatcher.getPendingFiles} 暴露，使 MCP 工具响应可在
 * 不强制等待同步的情况下标记过期结果。
 */
export interface PendingFile {
  /** 项目相对的 POSIX 路径（如 "src/foo.ts"）。 */
  path: string;
  /** 自上次同步以来，首次收到此路径事件时的挂钟毫秒时间戳。 */
  firstSeenMs: number;
  /** 最近一次收到此路径事件时的挂钟毫秒时间戳。 */
  lastSeenMs: number;
  /**
   * 当某个同步正在进行且其开始时间晚于此文件最近一次事件时为 true——
   * 即下一次成功的同步将处理此文件。为 false 表示文件仍在防抖窗口内
   * （还没有同步启动）。
   */
  indexing: boolean;
}

/**
 * FileWatcher 监视项目目录的变更，并通过提供的回调触发防抖同步操作。
 *
 * 设计目标：
 * - 有界的资源使用：macOS/Windows 上 O(1) 个描述符（一个递归监视），
 *   Linux 上 O(目录数) 个 inotify 监视——永远不会是 O(文件数)，
 *   后者曾是 macOS 上导致系统崩溃的 fd 泄漏（#644/#496/#555/#628）。
 * - 防抖以避免在快速保存时频繁触发
 * - 按扩展名过滤支持的源文件
 * - 无论 .gitignore 如何，始终忽略 .synapse/ 和 .git/
 * - 跟踪每文件的待处理状态，使 MCP 工具可在不阻塞同步的情况下
 *   标记过期结果（issue #403）
 */
export class FileWatcher {
  /** macOS/Windows：单个递归监视器。Linux 上为 null。 */
  private recursiveWatcher: fs.FSWatcher | null = null;
  /** Linux：每个被监视目录一个监视器（以绝对路径为键）。 */
  private dirWatchers = new Map<string, fs.FSWatcher>();
  /** 触发逐目录监视上限后设置，以确保只记录一次日志。 */
  private dirCapWarned = false;
  /**
   * Linux inotify 监视上限（ENOSPC）触发后设置。双重作用：
   * 只警告一次，并在本次会话中停止尝试新的目录监视——
   * 一旦内核配额耗尽，后续每次 `inotify_add_watch` 都会失败，
   * 因此继续尝试目录树的其余部分纯属浪费。非致命（不降级）：
   * 已安装的监视器继续工作。
   */
  private inotifyLimitWarned = false;
  /**
   * 单向锁存：实时监视因运行时终态故障（监视资源耗尽或超出重试预算的
   * 锁竞争）而被永久禁用的原因，健康时为 null。
   * 由 {@link degrade} 设置；仅在新的 start() 时清除。
   */
  private degradedReason: string | null = null;
  /** 监视器触发同步时的连续锁竞争重试次数。 */
  private lockRetryCount = 0;
  /** 仅供测试的惰性模式：已启动，但未安装 OS 监视器。 */
  private inert = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 自上次成功同步以来监视器见过的文件——在每次变更事件时填充，
   * 在同步开始时清空，由同步进行中到达的事件（或同步失败时恢复）重新填充。
   * 以整个代码库使用的项目相对 POSIX 路径为键，
   * 调用方可以低成本地将工具响应的文件路径与此 map 求交集。
   */
  private pendingFiles = new Map<string, { firstSeenMs: number; lastSeenMs: number }>();
  /**
   * 正在进行的同步开始时的挂钟毫秒时间戳。结合
   * {@link pendingFiles} 的 `lastSeenMs`，可区分"仍在防抖窗口内"
   * （lastSeen > syncStarted，此次编辑还没有同步启动）和
   * "正在索引中"（lastSeen <= syncStarted）两种状态。
   */
  private syncStartedMs = 0;
  private syncing = false;
  private stopped = false;
  /**
   * 初始监视集建立后置为 true。与之前的 chokidar 实现不同，
   * 这里没有异步初始"扫描"为每个已有文件发出 `add` 事件——
   * `fs.watch` 只报告安装后的变更——因此此标志在 `start()` 末尾同步翻转。
   * 对磁盘状态的启动协调由引擎的追赶同步处理，而非监视器。
   */
  private ready = false;
  /**
   * 监视集建立时解析的回调列表。供测试（以及任何需要干净基线的生产调用方）
   * 用于确定性地等待监视器就绪。
   */
  private readyWaiters: Array<() => void> = [];
  // 共享的范围匹配器（内置默认值 + 项目 .gitignore，嵌套子仓库按其
  // 自身规则匹配——#514），在 start() 时构建一次。与索引器使用相同的
  // 真实来源，确保监视器范围永远不会偏离索引范围。
  // start() 后创建的嵌套仓库在下次监视器重启/重新索引时加入范围。
  private ignoreMatcher: ScopeIgnore | null = null;

  private readonly projectRoot: string;
  private readonly debounceMs: number;
  private readonly syncFn: () => Promise<{ filesChanged: number; durationMs: number }>;
  private readonly onSyncComplete?: WatchOptions['onSyncComplete'];
  private readonly onSyncError?: WatchOptions['onSyncError'];
  private readonly onDegraded?: WatchOptions['onDegraded'];
  private readonly inertForTests: boolean;

  constructor(
    projectRoot: string,
    syncFn: () => Promise<{ filesChanged: number; durationMs: number }>,
    options: WatchOptions = {}
  ) {
    this.projectRoot = projectRoot;
    this.syncFn = syncFn;
    this.debounceMs = options.debounceMs ?? 2000;
    this.onSyncComplete = options.onSyncComplete;
    this.onSyncError = options.onSyncError;
    this.onDegraded = options.onDegraded;
    this.inertForTests = options.inertForTests ?? false;
  }

  /**
   * 开始监视文件变更。
   * 成功启动返回 true，否则返回 false。
   */
  start(): boolean {
    if (this.recursiveWatcher || this.dirWatchers.size > 0 || this.inert) return true; // Already watching
    this.stopped = false;
    this.degradedReason = null;
    this.lockRetryCount = 0;

    // 某些环境使文件系统监视不可用——最典型的是 WSL2 /mnt/ 驱动器，
    // 其中 fs.watch 调用会阻塞足够长的时间以破坏 MCP 启动握手（issue #199）。
    // 在那里跳过监视；调用方回退到手动 `synapse sync` 或 git 同步钩子。
    const disabledReason = watchDisabledReason(this.projectRoot);
    if (disabledReason) {
      logDebug('File watcher disabled', { reason: disabledReason, projectRoot: this.projectRoot });
      return false;
    }

    // 复用索引器的忽略集，确保监视器和索引器的范围一致。
    this.ignoreMatcher = buildScopeIgnore(this.projectRoot);

    try {
      if (this.inertForTests) {
        // 仅供测试：不安装 OS 监视器；由接缝驱动事件。
        this.inert = true;
      } else if (supportsRecursiveWatch()) {
        this.startRecursive();
      } else {
        this.startPerDirectory();
      }

      // 逐目录（Linux）路径在 watchTree 内部同步捕获监视资源耗尽并降级，
      // 而非抛出异常，因此永远不会到达下面的 catch。在此将其表现为启动失败，
      // 使两种策略以相同方式报告耗尽（start() === false）。
      if (this.degradedReason) return false;

      // 无异步扫描需要等待：一旦监视集安装完毕，我们就有了干净的基线
      // （pendingFiles 只由 start() 后的事件填充）。防御性清空并翻转 ready。
      this.pendingFiles.clear();
      this.ready = true;
      for (const cb of this.readyWaiters) cb();
      this.readyWaiters.length = 0;
      if (IS_TEST_RUNTIME) liveWatchersForTests.set(this.projectRoot, this);

      logDebug('File watcher started', {
        projectRoot: this.projectRoot,
        debounceMs: this.debounceMs,
        mode: this.inertForTests ? 'inert' : supportsRecursiveWatch() ? 'recursive' : 'per-directory',
        watchedDirs: this.dirWatchers.size || undefined,
      });
      return true;
    } catch (err) {
      // 监视器设置失败。监视资源耗尽（递归路径上的 EMFILE/ENFILE）是终态——
      // 以一条可操作的警告干净地降级，而非留下半损坏的监视器。
      // 其他所有情况（权限拒绝、目录不存在）保持之前的静默停止行为。
      if (isWatchResourceExhaustion(err)) {
        this.degrade(EXHAUSTION_REASON, { error: String(err) });
      } else {
        logWarn('Could not start file watcher', { error: String(err) });
        this.stop();
      }
      return false;
    }
  }

  /**
   * macOS/Windows：对整个目录树使用一个递归监视器。O(1) 个描述符。
   * `filename` 相对于项目根目录到达（含子目录），可直接映射为项目相对路径。
   */
  private startRecursive(): void {
    this.recursiveWatcher = watchImpl(
      this.projectRoot,
      { recursive: true, persistent: true },
      (_event, filename) => {
        if (this.stopped || filename == null) return;
        this.handleChange(normalizePath(String(filename)));
      }
    );
    this.recursiveWatcher.on('error', (err: unknown) => {
      if (isWatchResourceExhaustion(err)) {
        this.degrade(EXHAUSTION_REASON, { error: String(err) });
        return;
      }
      logWarn('File watcher error', { error: String(err) });
    });
  }

  /**
   * Linux：遍历（未被忽略的）目录树并监视每个目录。每个目录一个 inotify
   * 监视，报告该目录直接子文件的创建/修改/删除，因此永远不需要监视单个文件。
   */
  private startPerDirectory(): void {
    this.watchTree(this.projectRoot, /* markExisting */ false);
  }

  /**
   * 为 `dir` 添加 inotify 监视并递归进入其未被忽略的子目录。
   * 当 `markExisting` 为 true 时（启动后出现的目录），目录内已有的源文件
   * 会被记录为待处理——这关闭了"mkdir + write"竞争：在新目录的监视安装之前
   * 创建的文件否则会被遗漏，直到下次完整同步。初始启动遍历传入 false
   * （引擎的追赶同步负责初始基线）。
   */
  private watchTree(dir: string, markExisting: boolean): void {
    // 遍历中途 degrade()（某个目录上的耗尽）会调用 stop()，
    // 将 `stopped` 置为 true；在此退出以让递归展开，避免向正在关闭的监视器
    // 继续添加监视。`inotifyLimitWarned` 在 ENOSPC 后起相同作用——
    // 内核配额已耗尽，继续尝试目录树其余部分的每次添加都会失败，
    // 停止尝试同时保留已安装的监视。
    if (this.stopped || this.degradedReason || this.inotifyLimitWarned) return;
    if (this.dirWatchers.has(dir)) return;
    if (this.dirWatchers.size >= maxDirWatches()) {
      if (!this.dirCapWarned) {
        this.dirCapWarned = true;
        logWarn('File watcher hit directory-watch cap; remaining subtrees rely on manual/periodic sync', {
          cap: maxDirWatches(),
        });
      }
      return;
    }

    let w: fs.FSWatcher;
    try {
      w = watchImpl(dir, { persistent: true }, (_event, filename) =>
        this.handleDirEvent(dir, filename)
      );
    } catch (err) {
      // EMFILE/ENFILE 意味着进程已耗尽描述符——后续每个目录都会失败，
      // 因此降级整个监视器，而非以部分监视集勉强继续。
      if (isWatchResourceExhaustion(err)) {
        this.degrade(EXHAUSTION_REASON, { error: String(err), dir });
      } else if (isInotifyWatchExhaustion(err)) {
        // ENOSPC = inotify 监视配额耗尽。非致命：保留已有的监视，
        // 并告知用户需要调整的内核参数（仅警告一次）。
        this.warnInotifyLimit({ error: String(err), dir });
      }
      // 单个目录上的 ENOENT / EACCES 为非致命：静默跳过。
      return;
    }
    w.on('error', (err: unknown) => {
      if (isWatchResourceExhaustion(err)) {
        this.degrade(EXHAUSTION_REASON, { error: String(err), dir });
        return;
      }
      if (isInotifyWatchExhaustion(err)) {
        this.warnInotifyLimit({ error: String(err), dir });
      }
      this.unwatchDir(dir);
    });
    this.dirWatchers.set(dir, w);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (this.shouldIgnoreDir(child)) continue;
        this.watchTree(child, markExisting);
      } else if (markExisting && entry.isFile()) {
        this.handleChange(normalizePath(path.relative(this.projectRoot, child)));
      }
    }
  }

  /**
   * Linux 逐目录事件处理器。`filename` 相对于 `dir`。
   * 新建子目录通过扩展监视树来处理；其他所有内容路由到共享的变更处理器。
   */
  private handleDirEvent(dir: string, filename: string | Buffer | null): void {
    if (this.stopped || filename == null) return;
    const full = path.join(dir, String(filename));

    // 新建目录需要自己的监视（Linux 不支持递归）。
    // statSync 开销小且这类事件相比文件编辑较少。
    // 若路径已消失（快速创建/删除），stat 抛出异常，
    // 我们进入下面的变更处理器，对非源文件路径为空操作。
    try {
      if (fs.statSync(full).isDirectory()) {
        if (!this.shouldIgnoreDir(full)) this.watchTree(full, /* markExisting */ true);
        return;
      }
    } catch {
      // 已删除或无法访问——当作普通变更事件处理
    }

    this.handleChange(normalizePath(path.relative(this.projectRoot, full)));
  }

  /**
   * 两种监视策略共享的变更处理器。`rel` 为项目相对的 POSIX 路径。
   * 应用忽略 + 源文件过滤器，对于真实的源文件变更，将其记录为待处理（#403）
   * 并调度防抖同步。
   *
   * 递归（macOS/Windows）监视器也会报告被忽略目录树的事件
   * （一个流覆盖整个仓库），因此此处的忽略检查是关键——
   * 它在调度任何同步之前丢弃 node_modules/dist/.git 的抖动。
   */
  private handleChange(rel: string): void {
    if (!rel || rel === '.' || rel.startsWith('..')) return;
    if (this.isAlwaysIgnored(rel)) return;
    if (this.ignoreMatcher && this.ignoreMatcher.ignores(rel)) return;
    if (!isSourceFile(rel)) return;

    logDebug('File change detected', { file: rel });
    if (this.ready) {
      const now = Date.now();
      const existing = this.pendingFiles.get(rel);
      this.pendingFiles.set(rel, {
        firstSeenMs: existing?.firstSeenMs ?? now,
        lastSeenMs: now,
      });
    }
    this.scheduleSync();
  }

  /** 关闭并忘记出错/已被删除的目录的监视。 */
  private unwatchDir(dir: string): void {
    const w = this.dirWatchers.get(dir);
    if (w) {
      try {
        w.close();
      } catch {
        /* 已关闭 */
      }
      this.dirWatchers.delete(dir);
    }
  }

  /** 无论 .gitignore 如何，我们自己的目录始终被忽略。 */
  private isAlwaysIgnored(rel: string): boolean {
    // 路径的第一段。忽略所有 Synapse 数据目录——活跃的那个以及
    // 另一个环境（Windows/WSL）在同一目录树中创建的兄弟目录
    // （如 `.synapse-win`），以防两边互相监视对方的索引（#636）。
    const top = rel.split('/')[0] ?? rel;
    return (
      isSynapseDataDir(top) ||
      rel === '.git' || rel.startsWith('.git/')
    );
  }

  /**
   * 对任何不应被监视的目录返回 true（用于构建 Linux 逐目录监视树时）。
   * 测试路径的目录形式，以便仅目录的忽略规则（如 `build/`）能正确匹配。
   */
  private shouldIgnoreDir(dirPath: string): boolean {
    const rel = normalizePath(path.relative(this.projectRoot, dirPath));
    if (!rel || rel === '.' || rel.startsWith('..')) return false; // 根目录/外部
    if (this.isAlwaysIgnored(rel)) return true;
    if (!this.ignoreMatcher) return false;
    return this.ignoreMatcher.ignores(rel + '/');
  }

  /**
   * 在终态运行时故障（监视资源耗尽或超出重试预算的锁竞争）后
   * 永久禁用实时监视。幂等：记录一条可操作的警告，触发一次
   * {@link WatchOptions.onDegraded}，并停止监视器。后续的 start() 会清除锁存。
   */
  private degrade(reason: string, context: Record<string, unknown> = {}): void {
    if (this.degradedReason) return;
    this.degradedReason = reason;
    logWarn('File watcher disabled', { projectRoot: this.projectRoot, reason, ...context });
    this.onDegraded?.(reason);
    this.stop();
  }

  /**
   * 仅警告一次 Linux inotify 监视配额耗尽（ENOSPC），并在本次会话中
   * 停止添加新监视——后续每次 `inotify_add_watch` 都会失败，
   * 继续遍历目录树是浪费。与 {@link degrade} 不同，此为非致命：
   * 已安装的监视器继续触发，`synapse sync` 覆盖未监视的部分。
   * 消息中指明了需要调整的内核参数（`fs.inotify.max_user_watches`）。
   */
  private warnInotifyLimit(context: Record<string, unknown> = {}): void {
    if (this.inotifyLimitWarned) return;
    this.inotifyLimitWarned = true;
    logWarn(INOTIFY_LIMIT_REASON, { watchedDirs: this.dirWatchers.size, ...context });
  }

  /**
   * 实时监视是否已永久降级（直到下次 start()）。
   * 与 {@link isActive} 不同：已降级的监视器是非活跃的，但非活跃的监视器
   * 不一定已降级（可能只是已停止或从未启动）。宿主使用此方法告知用户自动同步已关闭。
   */
  isDegraded(): boolean {
    return this.degradedReason !== null;
  }

  /** 实时监视降级的原因，健康时为 null。 */
  getDegradedReason(): string | null {
    return this.degradedReason;
  }

  /**
   * 停止监视文件变更。
   */
  stop(): void {
    this.stopped = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.recursiveWatcher) {
      try {
        this.recursiveWatcher.close();
      } catch {
        /* 已关闭 */
      }
      this.recursiveWatcher = null;
    }
    for (const w of this.dirWatchers.values()) {
      try {
        w.close();
      } catch {
        /* 已关闭 */
      }
    }
    this.dirWatchers.clear();
    this.dirCapWarned = false;
    this.inotifyLimitWarned = false;
    this.lockRetryCount = 0;
    // 注意：degradedReason 在此处故意不重置——它必须在 degrade() 触发的
    // stop() 之后仍保持，以让 isDegraded() 返回 true。start() 会清除它。
    this.inert = false;

    this.pendingFiles.clear();
    this.ready = false;
    this.ignoreMatcher = null;
    if (IS_TEST_RUNTIME) liveWatchersForTests.delete(this.projectRoot);
    logDebug('File watcher stopped');
  }

  /**
   * @internal 仅供测试：将一个合成的项目相对路径变更送入与真实 fs.watch
   * 事件相同的"过滤 → pendingFiles → 防抖同步"流水线。
   * 让监视器/过期标记测试套件保持确定性，而非与 OS 监视传递延迟竞争。
   * 参见 {@link __emitWatchEventForTests}。
   */
  ingestEventForTests(relPath: string): void {
    this.handleChange(normalizePath(relPath));
  }

  /**
   * 监视器当前是否处于活跃状态。
   */
  isActive(): boolean {
    return (this.recursiveWatcher !== null || this.dirWatchers.size > 0 || this.inert) && !this.stopped;
  }

  /**
   * 在监视集安装完毕后解析（若已安装则立即解析）。
   * 对需要在断言 `pendingFiles` 前有确定性边界的测试很有用。
   *
   * 生产调用方不需要此方法：`pendingFiles` 持续被读取，
   * 过期标记始终正确（空或已填充），且使用 `fs.watch` 没有
   * 异步初始扫描窗口。
   */
  waitUntilReady(timeoutMs = 10000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = this.readyWaiters.indexOf(handler);
        if (idx >= 0) this.readyWaiters.splice(idx, 1);
        reject(new Error(`FileWatcher.waitUntilReady timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = () => { clearTimeout(t); resolve(); };
      this.readyWaiters.push(handler);
    });
  }

  /**
   * 源文件编辑后调度一次正常的防抖同步。
   */
  private scheduleSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flush();
    }, this.debounceMs);
  }

  /**
   * 可恢复的同步失败（锁竞争）后调度重试。与 {@link scheduleSync} 分开，
   * 以便持续竞争时以指数退避，而非每个防抖周期都锤击锁。
   */
  private scheduleRetrySync(delayMs: number): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flush();
    }, delayMs);
  }

  /**
   * 通过运行同步来刷新待处理变更。
   *
   * pendingFiles 在同步开始时不会清空——条目仅在同步成功提交后、
   * 且仅对 lastSeenMs <= syncStartedMs 的条目才会被移除。
   * 这样，同步进行中到达的查询仍能看到受影响文件被标记为过期
   * （DB 尚未更新），而同步进行中落地的事件也会持久化到后续同步中。
   *
   * 同步失败时 pendingFiles 保持不变——每次编辑仍未被索引，
   * 重新调度的同步下次将处理同一组文件。
   */
  private async flush(): Promise<void> {
    // 若已在同步中，同步后的检查会重新触发
    if (this.syncing || this.stopped) return;

    this.syncStartedMs = Date.now();
    this.syncing = true;

    try {
      const result = await this.syncFn();
      this.lockRetryCount = 0; // 干净的同步清除所有竞争退避
      // 移除最近事件早于本次同步的条目——这些编辑现已入库。
      // lastSeenMs > syncStartedMs 的条目在同步进行中到达；
      // 正在进行的同步是否捕获到它们取决于同步读取该文件的时机，
      // 因此保留它们为待处理，让后续同步处理。我们更倾向假阳性
      // （"显示为过期，实际已新鲜"→最多多一次 Read）而非假阴性
      // （"显示为新鲜，实际已过期"→误导智能体）。
      for (const [filePath, info] of this.pendingFiles) {
        if (info.lastSeenMs <= this.syncStartedMs) {
          this.pendingFiles.delete(filePath);
        }
      }
      this.onSyncComplete?.(result);
    } catch (err) {
      if (err instanceof LockUnavailableError) {
        this.lockRetryCount += 1;
        // 锁失败空操作（另一个写入方持有锁）。pendingFiles 保持完整，
        // `finally` 块以退避重新调度。对短暂竞争保持静默（仅调试级别——
        // 长期外部索引器否则会每个周期都刷屏 stderr），但不无限重试：
        // 一旦写入方持锁超过预算，明确降级自动同步。
        logDebug('Watch sync skipped: file lock unavailable', {
          pendingFiles: this.pendingFiles.size,
          retryCount: this.lockRetryCount,
        });
        if (this.lockRetryCount > MAX_LOCK_RETRIES) {
          this.degrade(
            'Synapse file lock held by another process past the retry budget; ' +
              'auto-sync disabled. Run `synapse sync` once the other writer finishes ' +
              '(or install git sync hooks) to refresh the graph.',
            { pendingFiles: this.pendingFiles.size, retryCount: this.lockRetryCount }
          );
        }
      } else {
        this.lockRetryCount = 0; // 非锁失败不是竞争；重置退避
        const error = err instanceof Error ? err : new Error(String(err));
        logWarn('Watch sync failed', { error: error.message });
        this.onSyncError?.(error);
      }
      // 失败：pendingFiles 保持不变。它跟踪的每次编辑仍未被索引；
      // 重新调度的同步会看到同一组文件。
    } finally {
      this.syncing = false;

      // 若仍有待处理文件（同步进行中的事件，或本次同步失败），
      // 调度下一轮处理。锁竞争后以指数退避（debounceMs · 2^(n-1)，有上限），
      // 而非以正常防抖节奏重试；干净的同步会重置 lockRetryCount，
      // 使正常编辑保持快速防抖。上面的 degrade() 已设置 `stopped`，
      // 因此不会重新调度已放弃的监视器。
      if (this.pendingFiles.size > 0 && !this.stopped) {
        if (this.lockRetryCount > 0) {
          const retryDelayMs = Math.min(
            this.debounceMs * 2 ** Math.max(0, this.lockRetryCount - 1),
            MAX_LOCK_RETRY_DELAY_MS
          );
          this.scheduleRetrySync(retryDelayMs);
        } else {
          this.scheduleSync();
        }
      }
    }
  }

  /**
   * 自上次成功同步以来监视器见过的文件快照。
   *
   * 供 MCP 工具响应在不阻塞同步的情况下标记过期结果使用：
   * 当工具在 `src/foo.ts` 中返回一个命中，而 `src/foo.ts` 在此列表中时，
   * 告知智能体"直接 Read 此文件，索引存在延迟。"
   *
   * 当某个同步正在进行且其开始时间晚于此文件最近一次事件时，
   * `indexing` 为 true——即该同步将处理此编辑。
   * false 表示文件仍在防抖窗口内且还没有同步启动
   * （几百毫秒后的后续调用可能显示 `indexing: true`，或文件已不在列表中）。
   *
   * 开销低：O(pendingFiles.size)，无 I/O，无锁。
   */
  getPendingFiles(): PendingFile[] {
    const result: PendingFile[] = [];
    for (const [filePath, info] of this.pendingFiles) {
      result.push({
        path: filePath,
        firstSeenMs: info.firstSeenMs,
        lastSeenMs: info.lastSeenMs,
        indexing: this.syncing && this.syncStartedMs >= info.lastSeenMs,
      });
    }
    return result;
  }
}

/**
 * 仅供测试：为运行在 `projectRoot` 的活跃监视器合成一次源文件变更，
 * 经过真实的"过滤 → pendingFiles → 防抖同步"逻辑，无需依赖 fs.watch
 * 传递时机（在并行 vitest 下会产生竞争）。`relPath` 为项目相对 POSIX 路径
 * （如 "src/foo.ts"）。若该根目录没有注册活跃监视器（如在测试运行时之外，
 * 注册表故意不填充）则返回 false。
 */
export function __emitWatchEventForTests(projectRoot: string, relPath: string): boolean {
  const w = liveWatchersForTests.get(projectRoot);
  if (!w) return false;
  w.ingestEventForTests(relPath);
  return true;
}
