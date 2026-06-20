/**
 * Synapse
 *
 * 本地优先的代码智能系统，从任何代码库构建语义知识图谱。
 */

import * as path from 'path';
import {
  Node,
  Edge,
  FileRecord,
  ExtractionResult,
  Subgraph,
  TraversalOptions,
  SearchOptions,
  SearchResult,
  Context,
  GraphStats,
  TaskInput,
  TaskContext,
  BuildContextOptions,
  FindRelevantContextOptions,
} from './types';
import { DatabaseConnection, getDatabasePath } from './db';
import { QueryBuilder } from './db/queries';
import {
  isInitialized,
  createDirectory,
  removeDirectory,
  validateDirectory,
} from './directory';
import {
  ExtractionOrchestrator,
  IndexProgress,
  IndexResult,
  SyncResult,
  extractFromSource,
  initGrammars,
} from './extraction';
import {
  ReferenceResolver,
  createResolver,
  ResolutionResult,
} from './resolution';
import { GraphTraverser, GraphQueryManager } from './graph';
import { ContextBuilder, createContextBuilder } from './context';
import { Mutex, FileLock } from './utils';
import { FileWatcher, WatchOptions, PendingFile, LockUnavailableError } from './sync';
import { EXTRACTION_VERSION } from './extraction/extraction-version';
import { getSynapseDir } from './directory';
import { deriveProjectNameTokens } from './search/query-utils';
import { SynapsePackageVersion } from './mcp/version';

// 为消费者重新导出类型
export * from './types';
// 供嵌入式/SDK 消费者直接驱动图（打开数据库、执行预编译查询）
// 而非通过 Synapse 门面时使用的存储构建块。
// 从包入口暴露，使其不再需要深度导入 dist/ 内部（issue #354）。
export { getDatabasePath, DatabaseConnection } from './db';
export { QueryBuilder } from './db/queries';
export {
  getSynapseDir,
  isInitialized,
  findNearestSynapseRoot,
  SYNAPSE_DIR,
} from './directory';
export { IndexProgress, IndexResult, SyncResult } from './extraction';
export { detectLanguage, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './extraction';
export { ResolutionResult } from './resolution';
export {
  SynapseError,
  FileError,
  ParseError,
  DatabaseError,
  SearchError,
  VectorError,
  ConfigError,
  Logger,
  setLogger,
  getLogger,
  silentLogger,
  defaultLogger,
} from './errors';
export { Mutex, FileLock, processInBatches, debounce, throttle, MemoryMonitor } from './utils';
export { FileWatcher, WatchOptions, PendingFile, LockUnavailableError } from './sync';
export { MCPServer } from './mcp';

/**
 * 初始化新 Synapse 项目的选项
 */
export interface InitOptions {
  /** 初始化后是否运行初始索引 */
  index?: boolean;

  /** 索引进度回调 */
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * 打开已有 Synapse 项目的选项
 */
export interface OpenOptions {
  /** 若文件有变更是否运行同步 */
  sync?: boolean;

  /** 是否以只读模式运行 */
  readOnly?: boolean;
}

/**
 * 索引选项
 */
export interface IndexOptions {
  /** 进度回调 */
  onProgress?: (progress: IndexProgress) => void;

  /** 用于取消的中止信号 */
  signal?: AbortSignal;

  /** 启用详细日志（worker 生命周期、内存、超时） */
  verbose?: boolean;
}

/**
 * Synapse 主类
 *
 * 提供与代码知识图谱交互的主要接口。
 */
export class Synapse {
  private db: DatabaseConnection;
  private queries: QueryBuilder;
  private projectRoot: string;
  private orchestrator: ExtractionOrchestrator;
  private resolver: ReferenceResolver;
  private graphManager: GraphQueryManager;
  private traverser: GraphTraverser;
  private contextBuilder: ContextBuilder;

  // 防止并发索引操作的 mutex（进程内）
  private indexMutex = new Mutex();

  // 防止跨进程并发写入的文件锁（CLI、MCP、git hooks）
  private fileLock: FileLock;

  // 用于文件变更自动同步的文件监视器
  private watcher: FileWatcher | null = null;

  private constructor(
    db: DatabaseConnection,
    queries: QueryBuilder,
    projectRoot: string
  ) {
    this.db = db;
    this.queries = queries;
    this.projectRoot = projectRoot;
    // 将项目名称降权为查询词——它命名的是整个仓库，
    // 而非某个符号，因此没有判别价值（#720）。
    try {
      this.queries.setProjectNameTokens(deriveProjectNameTokens(projectRoot));
    } catch {
      // 尽力而为：即使没有也不影响排名正常工作。
    }
    this.fileLock = new FileLock(
      path.join(getSynapseDir(projectRoot), 'synapse.lock')
    );
    this.orchestrator = new ExtractionOrchestrator(projectRoot, queries);
    this.resolver = createResolver(projectRoot, queries);
    this.graphManager = new GraphQueryManager(queries);
    this.traverser = new GraphTraverser(queries);
    this.contextBuilder = createContextBuilder(
      projectRoot,
      queries,
      this.traverser
    );
  }

  // ===========================================================================
  // 生命周期方法
  // ===========================================================================

  /**
   * 初始化新 Synapse 项目
   *
   * 创建 .synapse/ 目录、数据库和配置。
   *
   * @param projectRoot - 项目根目录路径
   * @param options - 初始化选项
   * @returns 新 Synapse 实例
   */
  static async init(projectRoot: string, options: InitOptions = {}): Promise<Synapse> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // 检查是否已初始化
    if (isInitialized(resolvedRoot)) {
      throw new Error(`Synapse already initialized in ${resolvedRoot}`);
    }

    // 创建目录结构
    createDirectory(resolvedRoot);

    // 初始化数据库
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new Synapse(db, queries, resolvedRoot);

    // 若有请求则运行初始索引
    if (options.index) {
      await instance.indexAll({ onProgress: options.onProgress });
    }

    return instance;
  }

  /**
   * 同步初始化（不运行索引）
   */
  static initSync(projectRoot: string): Synapse {
    const resolvedRoot = path.resolve(projectRoot);

    // 检查是否已初始化
    if (isInitialized(resolvedRoot)) {
      throw new Error(`Synapse already initialized in ${resolvedRoot}`);
    }

    // 创建目录结构
    createDirectory(resolvedRoot);

    // 初始化数据库
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new Synapse(db, queries, resolvedRoot);
  }

  /**
   * 打开已有 Synapse 项目
   *
   * @param projectRoot - 项目根目录路径
   * @param options - 打开选项
   * @returns Synapse 实例
   */
  static async open(projectRoot: string, options: OpenOptions = {}): Promise<Synapse> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // 检查是否已初始化
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`Synapse not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // 校验目录结构
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid Synapse directory: ${validation.errors.join(', ')}`);
    }

    // 打开数据库
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new Synapse(db, queries, resolvedRoot);

    // 若有请求则同步
    if (options.sync) {
      await instance.sync();
    }

    return instance;
  }

  /**
   * 同步打开（不运行同步）
   */
  static openSync(projectRoot: string): Synapse {
    const resolvedRoot = path.resolve(projectRoot);

    // 检查是否已初始化
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`Synapse not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // 校验目录结构
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid Synapse directory: ${validation.errors.join(', ')}`);
    }

    // 打开数据库
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new Synapse(db, queries, resolvedRoot);
  }

  /**
   * 检查目录是否已初始化为 Synapse 项目
   */
  static isInitialized(projectRoot: string): boolean {
    return isInitialized(path.resolve(projectRoot));
  }

  /**
   * 关闭 Synapse 实例并释放资源
   */
  close(): void {
    this.unwatch();
    // 若持有文件锁则释放
    this.fileLock.release();
    this.db.close();
  }

  /**
   * 获取项目根目录
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  // ===========================================================================
  // 索引
  // ===========================================================================

  /**
   * 索引项目中的所有文件
   *
   * 使用 mutex 防止并发索引操作。
   */
  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        const before = this.queries.getNodeAndEdgeCount();
        const result = await this.orchestrator.indexAll(options.onProgress, options.signal, options.verbose);

        // 重新检测框架——现在索引已填充完毕。解析器
        // 在任何文件存在之前用 createResolver() 构造，所以
        // 框架解析器中 detect() 会查询已索引文件列表的
        // （例如 UIKit/SwiftUI 扫描 imports、swift-objc-bridge 查找
        // Swift 和 ObjC 文件）在那次初始扫描中都返回 false，
        // 从而静默地把自己排除掉。在这里重新初始化，
        // 让它们在解析运行前看到真实项目。
        if (result.success && result.filesIndexed > 0) {
          this.resolver.initialize();
          // 跨文件后处理（例如 NestJS RouterModule 前缀）。在解析前运行，
          // 使更新后的名称出现在后续读取中。
          this.resolver.runPostExtract();
        }

        // 解析引用以创建调用/导入/继承边
        if (result.success && result.filesIndexed > 0) {
          // 不把所有引用加载到内存中直接获取计数
          const unresolvedCount = this.queries.getUnresolvedReferencesCount();

          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: unresolvedCount,
          });

          await this.resolveReferencesBatched((current, total) => {
            options.onProgress?.({
              phase: 'resolving',
              current,
              total,
            });
          });

          // 第二遍：链式调用——其方法位于接收方所遵从的超类型上
          // （protocol-extension / 继承 / 默认接口）。
          // 需要主遍刚构建的 implements/extends 边，因此在解析之后运行（#750）。
          this.resolver.resolveChainedCallsViaConformance();
          // `this.<member>` 回调注册（其成员继承自超类型）同理（#808）。
          this.resolver.resolveDeferredThisMemberRefs();
        }

        // 批量写入后刷新规划器统计信息并检查点 WAL。
        // 开销小、非阻塞；对正确性无影响。
        if (result.success && result.filesIndexed > 0) {
          this.db.runMaintenance();
        }

        // orchestrator 只能看到提取阶段的计数；解析和
        // 合成器边（在 JVM 仓库上通常占图的 50% 以上）在后续产生。
        // 对数据库重新计算，使 CLI 汇总报告真实总数。
        if (result.success && result.filesIndexed > 0) {
          const after = this.queries.getNodeAndEdgeCount();
          result.nodesCreated = after.nodes - before.nodes;
          result.edgesCreated = after.edges - before.edges;
        }

        // 用构建该索引的引擎为其打戳，以便 `synapse status`
        // 和 `synapse upgrade` 在运行引擎比磁盘上的引擎
        // 能提取更丰富内容时推荐重新索引。仅对真正的完整索引执行——
        // sync 只触及子集，因此绝不能推进提取戳记（大量内容仍为旧版）。
        // 参见 extraction-version.ts。
        if (result.success && result.filesIndexed > 0) {
          try {
            this.queries.setMetadata('indexed_with_version', SynapsePackageVersion);
            this.queries.setMetadata('indexed_with_extraction_version', String(EXTRACTION_VERSION));
          } catch { /* 元数据是建议性的——绝不因此使索引失败 */ }
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * 索引指定文件
   *
   * 使用 mutex 防止并发索引操作。
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        return this.orchestrator.indexFiles(filePaths);
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * 与当前文件状态同步（增量更新）
   *
   * 使用 mutex 防止并发索引操作。
   */
  async sync(options: IndexOptions = {}): Promise<SyncResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 0 };
      }
      try {
        const result = await this.orchestrator.sync(options.onProgress);

        // 跨文件后处理（例如 NestJS RouterModule 前缀）。每次
        // 触及文件的 sync 都运行，确保对 `app.module.ts` 的编辑
        // 能传播到未变更文件中的控制器。该遍历是幂等且廉价的
        // （仅对 *.module.ts 进行正则匹配）。
        if (result.filesAdded > 0 || result.filesModified > 0) {
          this.resolver.runPostExtract();
        }

        // 若有文件更新则解析引用
        if (result.filesAdded > 0 || result.filesModified > 0) {
          if (result.changedFilePaths) {
            // 将解析范围限定在已变更文件（git 快速路径——有界集合）
            const unresolvedRefs = this.queries.getUnresolvedReferencesByFiles(result.changedFilePaths);

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedRefs.length,
            });

            this.resolver.resolveAndPersist(unresolvedRefs, (current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });
          } else {
            // 无 git 信息——使用批量解析以避免 OOM
            const unresolvedCount = this.queries.getUnresolvedReferencesCount();

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedCount,
            });

            await this.resolveReferencesBatched((current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });
          }

          // 第二遍：链式调用——其方法位于接收方所遵从的超类型上
          // （protocol-extension / 继承）。需要上面构建的 implements/extends 边（#750）。
          this.resolver.resolveChainedCallsViaConformance();
          // `this.<member>` 回调注册（其成员继承自超类型）同理（#808）。
          this.resolver.resolveDeferredThisMemberRefs();
        }

        // 批量写入后刷新规划器统计信息并检查点 WAL。
        if (result.filesAdded > 0 || result.filesModified > 0 || result.filesRemoved > 0) {
          this.db.runMaintenance();
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * 检查索引操作是否正在进行
   */
  isIndexing(): boolean {
    return this.indexMutex.isLocked();
  }

  // ===========================================================================
  // 文件监视
  // ===========================================================================

  /**
   * 开始监视文件变更并自动同步。
   *
   * 使用原生 OS 文件事件（macOS 上的 FSEvents、Linux 19+ 上的 inotify、
   * Windows 上的 ReadDirectoryChangesW），并带防抖以避免颠簸。
   *
   * @param options - 监视选项（防抖延迟、回调）
   * @returns true 表示监视成功启动
   */
  watch(options: WatchOptions = {}): boolean {
    if (this.watcher?.isActive()) return true;

    this.watcher = new FileWatcher(
      this.projectRoot,
      async () => {
        const result = await this.sync();
        // sync() 在无法获取文件锁时返回此精确的零值形状
        // （真正的空 sync 始终有 filesChecked > 0，因为 scanDirectory 已运行）。
        // 将其作为类型化错误暴露给 watcher，
        // 使其保留 pendingFiles 并重新调度，而不是清除它们（#449）。
        if (result.filesChecked === 0 && result.durationMs === 0) {
          throw new LockUnavailableError();
        }
        const filesChanged = result.filesAdded + result.filesModified + result.filesRemoved;
        return { filesChanged, durationMs: result.durationMs };
      },
      options
    );

    return this.watcher.start();
  }

  /**
   * 停止监视文件变更。
   */
  unwatch(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }

  /**
   * 检查文件监视器是否处于活跃状态。
   */
  isWatching(): boolean {
    return this.watcher?.isActive() ?? false;
  }

  /**
   * 实时监视已永久降级（OS 监视资源耗尽，或写锁
   * 持续超过重试预算）且自动同步已禁用直到下一次 {@link watch} 调用。
   * 与 `!isWatching()` 不同：已停止/从未启动的监视器是非活跃的，
   * 但 NOT 降级。MCP 工具用此字段显示全索引"结果可能已过期"通知，
   * 因为一旦监视停止 `getPendingFiles()` 就会变空（#876）。
   */
  isWatcherDegraded(): boolean {
    return this.watcher?.isDegraded() ?? false;
  }

  /** 实时监视降级的原因，若运行正常则为 null（#876）。 */
  getWatcherDegradedReason(): string | null {
    return this.watcher?.getDegradedReason() ?? null;
  }

  /**
   * 文件监视器自上次成功同步以来看到的文件——
   * MCP 工具附加到响应中的每文件"过期"信号，
   * 使智能体无需等待防抖同步完成就能对受影响的单个文件
   * 回退到 {@link Read}（issue #403）。
   *
   * 当监视器未活跃或无事件到来时返回空列表。
   * 每个条目包含 `firstSeenMs` 和 `lastSeenMs`（wall-clock `Date.now()` 值），
   * 供调用方渲染"N 毫秒前编辑"，以及 `indexing` 标志，
   * 指示是否有正在进行的同步会处理该文件。
   */
  getPendingFiles(): PendingFile[] {
    return this.watcher?.getPendingFiles() ?? [];
  }

  /**
   * 文件监视器完成其监视集安装后解决的 Promise。
   * 用于在断言 `getPendingFiles()` 之前需要确定性边界的测试。
   * 若无活跃监视器则立即解决。
   */
  waitUntilWatcherReady(timeoutMs?: number): Promise<void> {
    return this.watcher ? this.watcher.waitUntilReady(timeoutMs) : Promise.resolve();
  }

  /**
   * 获取自上次索引以来发生变更的文件
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return this.orchestrator.getChangedFiles();
  }

  /**
   * 所有已追踪文件中最近一次索引时间戳（自 epoch 起的毫秒数），
   * 若尚无任何索引则为 null。让库消费者无需执行 `synapse status --json`
   * 就能检查索引新鲜度。（#329）
   */
  getLastIndexedAt(): number | null {
    return this.queries.getLastIndexedAt();
  }

  /**
   * 构建当前索引的引擎信息：上次完整 `indexAll` 时打下的包版本 +
   * 提取版本戳记。任一字段为 null 表示索引在打戳记功能存在之前构建
   * （视为已过期）。参见 `extraction-version.ts` 和 `isIndexStale()`。
   */
  getIndexBuildInfo(): { version: string | null; extractionVersion: number | null } {
    const version = this.queries.getMetadata('indexed_with_version');
    const ev = this.queries.getMetadata('indexed_with_extraction_version');
    const parsed = ev != null ? parseInt(ev, 10) : NaN;
    return { version, extractionVersion: Number.isFinite(parsed) ? parsed : null };
  }

  /**
   * 当磁盘上的索引由提取能力比当前运行引擎更旧的引擎构建时为 true——
   * 即重新索引会添加迁移无法回填的数据。
   * 若尚无索引则为 false（无需刷新）或戳记已是最新。
   * 这是 `synapse status` 重新索引提示和 `synapse upgrade` 提醒背后的信号。
   */
  isIndexStale(): boolean {
    if (this.queries.getLastIndexedAt() == null) return false;
    const { extractionVersion } = this.getIndexBuildInfo();
    return extractionVersion == null || extractionVersion < EXTRACTION_VERSION;
  }

  /**
   * 从源代码提取节点和边（不存储）
   */
  extractFromSource(filePath: string, source: string): ExtractionResult {
    return extractFromSource(filePath, source);
  }

  // ===========================================================================
  // 引用解析
  // ===========================================================================

  /**
   * 解析未解析的引用并创建边
   *
   * 此方法获取提取产生的未解析引用，并尝试用多种策略解析：
   * - 框架特定模式（React、Express、Laravel）
   * - 基于导入的解析
   * - 基于名称的符号匹配
   */
  resolveReferences(onProgress?: (current: number, total: number) => void): ResolutionResult {
    // 从数据库获取所有未解析的引用
    const unresolvedRefs = this.queries.getUnresolvedReferences();
    return this.resolver.resolveAndPersist(unresolvedRefs, onProgress);
  }

  /**
   * 批量解析引用，以在大型代码库上保持内存有界。
   * 分块处理未解析引用，每批后持久化结果。
   */
  async resolveReferencesBatched(onProgress?: (current: number, total: number) => void): Promise<ResolutionResult> {
    return this.resolver.resolveAndPersistBatched(onProgress);
  }

  /**
   * 获取项目中检测到的框架
   */
  getDetectedFrameworks(): string[] {
    return this.resolver.getDetectedFrameworks();
  }

  /**
   * 重新初始化解析器（添加新文件后有用）
   */
  reinitializeResolver(): void {
    this.resolver.initialize();
  }

  // ===========================================================================
  // 图统计
  // ===========================================================================

  /**
   * 获取知识图谱的统计信息
   */
  getStats(): GraphStats {
    const stats = this.queries.getStats();
    stats.dbSizeBytes = this.db.getSize();
    return stats;
  }

  /**
   * 此项目连接的活跃 SQLite 后端（`node-sqlite`——Node 内置的真 SQLite 模块）。
   * 通过 `synapse status` 和 `synapse_status` MCP 工具与有效日志模式一起暴露。
   */
  getBackend(): import('./db').SqliteBackend {
    return this.db.getBackend();
  }

  /**
   * 实际生效的日志模式（'wal'、'delete' 等）。'wal' 表示读取从不阻塞
   * 并发写入方；其他模式表示可能阻塞，这是 issue #238 中
   * "database is locked"失败的前提条件。
   * 通过 `synapse status` 和 `synapse_status` MCP 工具暴露。
   */
  getJournalMode(): string {
    return this.db.getJournalMode();
  }

  // ===========================================================================
  // 节点操作
  // ===========================================================================

  /**
   * 按 ID 获取节点
   */
  getNode(id: string): Node | null {
    return this.queries.getNodeById(id);
  }

  /**
   * 获取文件中的所有节点
   */
  getNodesInFile(filePath: string): Node[] {
    return this.queries.getNodesByFile(filePath);
  }

  /**
   * 获取指定类型的所有节点
   */
  getNodesByKind(kind: Node['kind']): Node[] {
    return this.queries.getNodesByKind(kind);
  }

  /**
   * 获取所有具有精确名称的节点（直接索引查找，非 FTS 排名/上限）。
   * 用于枚举重载名称的每个重载，确保调用方想要的特定定义
   * 不会被丢弃到搜索截断以下。
   */
  getNodesByName(name: string): Node[] {
    return this.queries.getNodesByName(name);
  }

  /**
   * 按文本搜索节点
   */
  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    return this.queries.searchNodes(query, options);
  }

  /**
   * 规范化的项目名称 token（go.mod / package.json / 仓库目录），用于
   * 在搜索排名中降权非判别性的项目名称（#720）。
   * 暴露供 explore 在 PascalCase 类型消歧偏置中排除，
   * 否则会将重载 token 拉向恰好包含项目名称的堆栈。
   */
  getProjectNameTokens(): Set<string> {
    return this.queries.getProjectNameTokens();
  }

  /**
   * 查找项目的"主路由文件"——持有框架发出的 `route` 节点
   * 最密集的文件（≥3 条路由，占所有非测试路由的 ≥30%）。
   * 用于在小型 realworld 模板仓库（rails-realworld、laravel-realworld、
   * drupal-admintoolbar 等）的 `synapse_explore` 响应中内联路由配置，
   * 否则 Glob+Read `routes.rb`/`urls.py` 等会胜过 synapse。
   */
  getTopRouteFile(): { filePath: string; routeCount: number; totalRoutes: number } | null {
    return this.queries.getTopRouteFile();
  }

  /**
   * 从索引构建 URL → handler 路由清单。每个条目将
   * 路由节点（URL + 方法）与框架解析器发出的 `references` 边
   * 所指向的 handler 函数/方法配对。
   * 当有效（非测试）路由少于 3 条时返回 null。
   */
  getRoutingManifest(limit?: number): {
    entries: Array<{ url: string; handler: string; handlerFile: string; handlerLine: number; handlerKind: string }>;
    topHandlerFile: string | null;
    topHandlerFileCount: number;
    totalRoutes: number;
  } | null {
    return this.queries.getRoutingManifest(limit);
  }

  // ===========================================================================
  // 边操作
  // ===========================================================================

  /**
   * 获取节点的出向边
   */
  getOutgoingEdges(nodeId: string): Edge[] {
    return this.queries.getOutgoingEdges(nodeId);
  }

  /**
   * 获取节点的入向边
   */
  getIncomingEdges(nodeId: string): Edge[] {
    return this.queries.getIncomingEdges(nodeId);
  }

  // ===========================================================================
  // 文件操作
  // ===========================================================================

  /**
   * 按路径获取文件记录
   */
  getFile(filePath: string): FileRecord | null {
    return this.queries.getFileByPath(filePath);
  }

  /**
   * 获取所有已追踪文件
   */
  getFiles(): FileRecord[] {
    return this.queries.getAllFiles();
  }

  // ===========================================================================
  // 图查询方法
  // ===========================================================================

  /**
   * 获取节点的上下文（祖先、子节点、引用）
   *
   * 返回关于节点的全面上下文，包括其包含层次结构、
   * 子节点、入向/出向引用、类型信息和相关导入。
   *
   * @param nodeId - 焦点节点的 ID
   * @returns 包含所有相关信息的 Context 对象
   */
  getContext(nodeId: string): Context {
    return this.graphManager.getContext(nodeId);
  }

  /**
   * 从起始节点遍历图
   *
   * 默认使用广度优先搜索。支持按边类型、节点类型和遍历方向过滤。
   *
   * @param startId - 起始节点 ID
   * @param options - 遍历选项
   * @returns 包含已遍历节点和边的子图
   */
  traverse(startId: string, options?: TraversalOptions): Subgraph {
    return this.traverser.traverseBFS(startId, options);
  }

  /**
   * 获取函数的调用图
   *
   * 返回调用者（调用此函数的函数）和被调用者
   * （此函数调用的函数），最多到指定深度。
   *
   * @param nodeId - 函数/方法节点的 ID
   * @param depth - 每个方向的最大深度（默认：2）
   * @returns 包含调用图的子图
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    return this.traverser.getCallGraph(nodeId, depth);
  }

  /**
   * 获取类/接口的类型层次结构
   *
   * 返回祖先类型（此类型扩展/实现的）和
   * 后代类型（扩展/实现此类型的）。
   *
   * @param nodeId - 类/接口节点的 ID
   * @returns 包含类型层次结构的子图
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    return this.traverser.getTypeHierarchy(nodeId);
  }

  /**
   * 查找符号的所有用法
   *
   * 通过任意边类型（calls、references、type_of 等）
   * 返回所有引用指定符号的节点。
   *
   * @param nodeId - 符号节点的 ID
   * @returns 引用此符号的节点和边数组
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    return this.traverser.findUsages(nodeId);
  }

  /**
   * 获取函数/方法的调用者
   *
   * @param nodeId - 函数/方法节点的 ID
   * @param maxDepth - 最大遍历深度（默认：1）
   * @returns 调用此函数的节点数组
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallers(nodeId, maxDepth);
  }

  /**
   * 获取函数/方法的被调用者
   *
   * @param nodeId - 函数/方法节点的 ID
   * @param maxDepth - 最大遍历深度（默认：1）
   * @returns 此函数调用的节点数组
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallees(nodeId, maxDepth);
  }

  /**
   * 计算节点的影响半径
   *
   * 返回可能受此节点变更影响的所有节点。
   *
   * @param nodeId - 节点 ID
   * @param maxDepth - 最大遍历深度（默认：3）
   * @returns 包含潜在受影响节点的子图
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    return this.traverser.getImpactRadius(nodeId, maxDepth);
  }

  /**
   * 查找两个节点之间的最短路径
   *
   * @param fromId - 起始节点 ID
   * @param toId - 目标节点 ID
   * @param edgeKinds - 要考虑的边类型（空则考虑全部）
   * @returns 组成路径的节点和边数组，若无路径则为 null
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds?: Edge['kind'][]
  ): Array<{ node: Node; edge: Edge | null }> | null {
    return this.traverser.findPath(fromId, toId, edgeKinds);
  }

  /**
   * 获取节点在包含层次结构中的祖先
   *
   * @param nodeId - 节点 ID
   * @returns 从直接父节点到根节点的祖先节点数组
   */
  getAncestors(nodeId: string): Node[] {
    return this.traverser.getAncestors(nodeId);
  }

  /**
   * 获取节点的直接子节点
   *
   * @param nodeId - 节点 ID
   * @returns 子节点数组
   */
  getChildren(nodeId: string): Node[] {
    return this.traverser.getChildren(nodeId);
  }

  /**
   * 获取文件的依赖项
   *
   * @param filePath - 文件路径
   * @returns 此文件所依赖的文件路径数组
   */
  getFileDependencies(filePath: string): string[] {
    return this.graphManager.getFileDependencies(filePath);
  }

  /**
   * 获取文件的被依赖方
   *
   * @param filePath - 文件路径
   * @returns 依赖此文件的文件路径数组
   */
  getFileDependents(filePath: string): string[] {
    return this.graphManager.getFileDependents(filePath);
  }

  /**
   * 查找代码库中的循环依赖
   *
   * @returns 循环数组，每个循环是一个文件路径数组
   */
  findCircularDependencies(): string[][] {
    return this.graphManager.findCircularDependencies();
  }

  /**
   * 查找死代码（未被引用的符号）
   *
   * @param kinds - 要检查的节点类型（默认：函数、方法、类）
   * @returns 未被引用的节点数组
   */
  findDeadCode(kinds?: Node['kind'][]): Node[] {
    return this.graphManager.findDeadCode(kinds);
  }

  /**
   * 获取节点的复杂度指标
   *
   * @param nodeId - 节点 ID
   * @returns 包含各种复杂度指标的对象
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    return this.graphManager.getNodeMetrics(nodeId);
  }

  // ===========================================================================
  // 上下文构建
  // ===========================================================================

  /**
   * 获取节点的源代码
   *
   * 读取文件并提取 startLine 到 endLine 之间的代码。
   *
   * @param nodeId - 节点 ID
   * @returns 代码字符串，若未找到则为 null
   */
  async getCode(nodeId: string): Promise<string | null> {
    return this.contextBuilder.getCode(nodeId);
  }

  /**
   * 为查询查找相关子图
   *
   * 将语义搜索与图遍历结合，找到给定查询最相关的
   * 节点及其关系。
   *
   * @param query - 描述任务的自然语言查询
   * @param options - 搜索和遍历选项
   * @returns 相关节点和边的子图
   */
  async findRelevantContext(
    query: string,
    options?: FindRelevantContextOptions
  ): Promise<Subgraph> {
    return this.contextBuilder.findRelevantContext(query, options);
  }

  /**
   * 为任务构建上下文
   *
   * 通过以下步骤创建全面上下文：
   * 1. 运行 FTS 搜索找到入口点
   * 2. 围绕入口点扩展图
   * 3. 从关键节点提取代码块
   * 4. 格式化输出供 Claude 使用
   *
   * @param input - 任务描述（字符串或 {title, description}）
   * @param options - 构建选项（maxNodes、includeCode、format 等）
   * @returns TaskContext 对象或格式化字符串（markdown/JSON）
   */
  async buildContext(
    input: TaskInput,
    options?: BuildContextOptions
  ): Promise<TaskContext | string> {
    return this.contextBuilder.buildContext(input, options);
  }

  // ===========================================================================
  // 数据库管理
  // ===========================================================================

  /**
   * 优化数据库（vacuum 和 analyze）
   */
  optimize(): void {
    this.db.optimize();
  }

  /**
   * 清空图中的所有数据
   */
  clear(): void {
    this.queries.clear();
  }

  /**
   * close() 的别名，用于向后兼容。
   * @deprecated 请使用 close() 代替
   */
  destroy(): void {
    this.close();
  }

  /**
   * 从项目中完全移除 Synapse。
   * 关闭数据库并删除 .synapse/ 目录。
   *
   * 警告：这会永久删除项目的所有 Synapse 数据。
   */
  uninitialize(): void {
    this.close();
    removeDirectory(this.projectRoot);
  }
}

// Default export
export default Synapse;
