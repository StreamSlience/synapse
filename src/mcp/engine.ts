/**
 * MCP 共享引擎 — MCP 服务器的重量级*共享*状态：
 * 项目的 {@link Synapse} 实例、文件监视器，以及用于跨项目查询的
 * {@link ToolHandler} 缓存。
 *
 * 一个引擎，多个会话：
 * - 直接模式（单 stdio 会话）实例化一个引擎 + 一个会话；
 * - 守护进程模式实例化一个引擎，每个 socket 连接新建一个会话。
 *   每个会话从同一个 SQLite WAL 和同一组 inotify 监视中读取 —
 *   这正是 issue #411 的全部意义。
 */

import type Synapse from '../index';
import { findNearestSynapseRoot } from '../directory';
import { watchDisabledReason } from '../sync';
import { ToolHandler } from './tools';

// 将重量级 Synapse 链（sqlite + query/graph/context 层）从 MCP 启动路径中
// 惰性加载出去。只有在工具真正打开项目时才需要它 — 而非响应 initialize/tools-list —
// 因此推迟加载让 `serve --mcp`（及其派生的守护进程）能在约 Node 启动时间内
// 完成绑定 + 注册工具，而不是约 800ms，从而消除导致无头智能体失败的
// "No such tool available" 冷启动竞争。require() 在 CommonJS 构建中是同步且有缓存的。
const loadSynapse = (): typeof import('../index').default =>
  (require('../index') as typeof import('../index')).default;

export interface MCPEngineOptions {
  /**
   * 初始化时是否启动文件监视器。守护进程模式和直接模式都需要设为 true；
   * 测试可将其设为 false 以降低引擎开销。无论如何都遵循 {@link watchDisabledReason}。
   */
  watch?: boolean;
}

/**
 * 共享 MCP 引擎。在多会话并发调用其方法的意义上是线程安全的 —
 * 内部通过单个 Promise 将初始化序列化，确保首次连接时互相竞争的多个会话
 * 绝不会重复打开 SQLite 文件。
 */
export class MCPEngine {
  private cg: Synapse | null = null;
  private toolHandler: ToolHandler;
  // 已解析到的项目根目录。在 `ensureInitialized` 成功前为 null
  // （或永远为 null，如果始终找不到 .synapse/ — 这对引擎来说是合法状态，
  // 因为跨项目查询仍然有效）。
  private projectPath: string | null = null;
  // 在首次 `ensureInitialized` 时设置，后续会话无需重复工作。
  private initPromise: Promise<void> | null = null;
  private watcherStarted = false;
  private opts: Required<MCPEngineOptions>;
  private closed = false;

  constructor(opts: MCPEngineOptions = {}) {
    this.opts = { watch: opts.watch ?? true };
    this.toolHandler = new ToolHandler(null);
  }

  /**
   * {@link MCPServer} 兼容性便利方法：预填显式项目路径（来自 `--path` CLI 标志），
   * 但暂不打开。这使同步构造函数保持轻量；实际打开在首次 `ensureInitialized` 调用时发生。
   */
  setProjectPathHint(projectPath: string): void {
    this.projectPath = projectPath;
    this.toolHandler.setDefaultProjectHint(projectPath);
  }

  /** 引擎解析到的项目根目录（若无则为 null）。 */
  getProjectPath(): string | null {
    return this.projectPath;
  }

  /** 共享 ToolHandler — 会话通过它委托工具分发。 */
  getToolHandler(): ToolHandler {
    return this.toolHandler;
  }

  /** 默认项目的 Synapse 是否已打开。 */
  hasDefaultSynapse(): boolean {
    return this.toolHandler.hasDefaultSynapse();
  }

  /**
   * 从 `searchFrom` 向上遍历，找到最近的 `.synapse/` 并打开它。
   * 幂等：并发调用者共享一次进行中的初始化；成功后的后续调用是空操作。
   *
   * 原始的 `MCPServer.tryInitializeDefault` 具有相同的"在后续工具调用时重试"语义；
   * 我们通过在搜索未命中时*不*抛出异常来保留它（只是让 `cg` 保持 null，下次调用可以重试）。
   */
  async ensureInitialized(searchFrom: string): Promise<void> {
    if (this.closed) return;
    if (this.toolHandler.hasDefaultSynapse()) return;
    if (this.initPromise) {
      try { await this.initPromise; } catch { /* let caller retry */ }
      return;
    }

    this.initPromise = this.doInitialize(searchFrom).finally(() => {
      this.initPromise = null;
    });
    try {
      await this.initPromise;
    } catch {
      // 初始化错误在 `doInitialize` 内部已记录日志；在此落穿
      // 与 MCPServer 之前"在下次工具调用时重试"的行为一致。
    }
  }

  /**
   * 当后台 `ensureInitialized` 已完成（或失败），且需要感知引擎启动后出现的项目时，
   * 由每个会话的重试循环调用的同步最后手段初始化。
   */
  retryInitializeSync(searchFrom: string): void {
    if (this.closed) return;
    if (this.toolHandler.hasDefaultSynapse()) return;
    this.toolHandler.setDefaultProjectHint(searchFrom);
    const resolvedRoot = findNearestSynapseRoot(searchFrom);
    if (!resolvedRoot) return;
    try {
      // 关闭任何之前失败的实例以避免资源泄漏。
      if (this.cg) {
        try { this.cg.close(); } catch { /* ignore */ }
        this.cg = null;
      }
      this.cg = loadSynapse().openSync(resolvedRoot);
      this.projectPath = resolvedRoot;
      this.toolHandler.setDefaultSynapse(this.cg);
      this.startWatching();
      this.catchUpSync();
    } catch {
      // 仍然失败 — 调用方将在下次工具调用时重试。
    }
  }

  /**
   * 关闭所有内容。用于守护进程优雅关闭（SIGTERM/空闲超时）
   * 和直接模式停止。幂等。
   */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.toolHandler.closeAll();
    if (this.cg) {
      try { this.cg.close(); } catch { /* ignore */ }
      this.cg = null;
    }
  }

  private async doInitialize(searchFrom: string): Promise<void> {
    this.toolHandler.setDefaultProjectHint(searchFrom);

    const resolvedRoot = findNearestSynapseRoot(searchFrom);
    if (!resolvedRoot) {
      // searchFrom 上方没有 .synapse/。会话稍后可能通过 roots/list 发现一个
      this.projectPath = searchFrom;
      return;
    }

    this.projectPath = resolvedRoot;
    try {
      this.cg = await loadSynapse().open(resolvedRoot);
      this.toolHandler.setDefaultSynapse(this.cg);
      this.startWatching();
      this.catchUpSync();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[Synapse MCP] Failed to open project at ${resolvedRoot}: ${msg}\n`);
    }
  }

  /**
   * 在活跃的 Synapse 实例上启动文件监视。幂等 — 监视器是按引擎而非按会话的，
   * 这正是守护进程路径能将 N 个 inotify 集合并为一个的原因。
   * 禁用原因日志的措辞与之前的内树实现完全一致，以保持日志驱动的仪表板正常工作。
   */
  private startWatching(): void {
    if (!this.cg || this.watcherStarted || !this.opts.watch) return;

    const disabledReason = watchDisabledReason(this.projectPath ?? process.cwd());
    if (disabledReason) {
      process.stderr.write(
        `[Synapse MCP] File watcher disabled — ${disabledReason}. ` +
        `The graph will not auto-update; run \`synapse sync\` (or install the git sync hooks via \`synapse init\`) to refresh.\n`
      );
      this.watcherStarted = true;
      return;
    }

    // 通过环境变量可选覆盖防抖窗口（issue #403）。
    // 对于有大量突发写入的工作区（保存时格式化链、大量生成输出）很有用，
    // 默认的 2s 触发过于频繁。限制在 [100ms, 60s]；超出范围/非数字值
    // 回退到 FileWatcher 默认值。我们记录实际值以便可发现。
    const debounceMs = parseDebounceEnv(process.env.SYNAPSE_WATCH_DEBOUNCE_MS);
    if (debounceMs !== undefined) {
      process.stderr.write(`[Synapse MCP] File watcher debounce: ${debounceMs}ms (SYNAPSE_WATCH_DEBOUNCE_MS)\n`);
    }

    const started = this.cg.watch({
      debounceMs,
      onSyncComplete: (result) => {
        if (result.filesChanged > 0) {
          process.stderr.write(
            `[Synapse MCP] Auto-synced ${result.filesChanged} file(s) in ${result.durationMs}ms\n`
          );
        }
      },
      onSyncError: (err) => {
        process.stderr.write(`[Synapse MCP] Auto-sync error: ${err.message}\n`);
      },
      onDegraded: (reason) => {
        // 实时监视永久放弃（监视资源耗尽或写锁超过重试预算）。
        // 大声地且仅一次地报告 — 图谱将不再自动更新，
        // 因此长期运行的 MCP 会话不应继续假设它是最新的。
        // 原因中已注明解决方法（`synapse sync` / git sync hooks）。
        process.stderr.write(`[Synapse MCP] File watcher degraded — ${reason}\n`);
      },
    });

    this.watcherStarted = true;
    if (started) {
      process.stderr.write('[Synapse MCP] File watcher active — graph will auto-sync on changes\n');
    } else {
      process.stderr.write(
        '[Synapse MCP] File watcher unavailable on this platform — run `synapse sync` to refresh the graph after changes.\n'
      );
    }
  }

  /**
   * 打开后立即将索引与当前文件系统同步一次 — 捕获在没有监视器运行期间发生的
   * 编辑、添加、删除以及 `git pull`/`checkout` 变更。在后台运行，但返回的 Promise
   * 被推入 ToolHandler 作为一次性门控，使*第一次*工具调用在完成同步后再响应
   * （若没有这个机制，在同步完成前的工具调用将返回磁盘上已不存在的文件的行 —
   * 且每文件的过期横幅也无法帮助，因为 `getPendingFiles()` 由监视器而非追赶同步填充）。
   */
  private catchUpSync(): void {
    const cg = this.cg;
    if (!cg) return;
    const p = cg
      .sync()
      .then((result) => {
        const changed = result.filesAdded + result.filesModified + result.filesRemoved;
        if (changed > 0) {
          process.stderr.write(`[Synapse MCP] Caught up ${changed} file(s) changed since last run\n`);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[Synapse MCP] Catch-up sync failed: ${msg}\n`);
      });
    this.toolHandler.setCatchUpGate(p);
  }
}

/**
 * 解析并限制 SYNAPSE_WATCH_DEBOUNCE_MS 环境变量覆盖值。
 *
 * Issue #403：有大量突发写入的工作区（保存时格式化、多文件重构）有时需要
 * 更长的安静窗口才同步。对于未设置/空/非数字/超出范围的值返回 `undefined`，
 * 让 FileWatcher 默认值（2000ms）接管 — 永不抛出异常。
 *
 * 限制范围：100ms（更短意味着每次击键都触发同步）到 60s（更长会让监视器感觉坏掉）。
 * 超出范围的值被视为"忽略此错误配置"而非截断，因为静默截断 0 或拼写错误的值
 * 会掩盖真实的配置 bug。
 */
export function parseDebounceEnv(raw: string | undefined): number | undefined {
  if (!raw || !raw.trim()) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (n < 100 || n > 60000) return undefined;
  return n;
}
