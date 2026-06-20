/**
 * 数据库层
 *
 * 处理 SQLite 数据库的初始化和连接管理。
 */

import { SqliteDatabase, SqliteBackend, createDatabase } from './sqlite-adapter';
import * as fs from 'fs';
import * as path from 'path';
import { SchemaVersion } from '../types';
import { runMigrations, getCurrentVersion, CURRENT_SCHEMA_VERSION } from './migrations';
import { getSynapseDir } from '../directory';

export { SqliteDatabase, SqliteBackend } from './sqlite-adapter';

/**
 * 应用连接级 PRAGMA。由 `initialize` 和 `open` 共用，
 * 使两条路径不会产生偏差。
 *
 * `busy_timeout` 必须最先设置，在任何可能触碰数据库文件的 pragma
 * 之前（特别是 `journal_mode`）。如果在打开时另一个进程持有写锁，
 * 后续的 pragma——以及连接的第一个查询——会等待锁释放，
 * 而不是立即抛出"database is locked"。参见 issue #238。
 *
 * 5 秒窗口（原为 120 秒）可撑过正常的增量同步；原来的 2 分钟等待
 * 表现为智能体卡死、挂起。在 WAL 模式下，读取从不阻塞写入方，
 * 因此此超时仅管理跨进程写入竞争
 * （例如 git-hook 的 `synapse sync` 与 MCP 服务器写入同时发生）。
 */
function configureConnection(db: SqliteDatabase): void {
  db.pragma('busy_timeout = 5000');      // 必须最先设置——见上文
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');       // node:sqlite 在所有平台上均支持 WAL
  db.pragma('synchronous = NORMAL');     // WAL 模式下安全
  db.pragma('cache_size = -64000');      // 64 MB 页缓存
  db.pragma('temp_store = MEMORY');      // 临时表存于内存
  db.pragma('mmap_size = 268435456');    // 256 MB 内存映射 I/O
}

/**
 * 带生命周期管理的数据库连接封装
 */
export class DatabaseConnection {
  private db: SqliteDatabase;
  private dbPath: string;
  private backend: SqliteBackend;

  private constructor(db: SqliteDatabase, dbPath: string, backend: SqliteBackend) {
    this.db = db;
    this.dbPath = dbPath;
    this.backend = backend;
  }

  /**
   * 在给定路径初始化一个新数据库
   */
  static initialize(dbPath: string): DatabaseConnection {
    // 确保父目录存在
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 创建并配置数据库
    const { db, backend } = createDatabase(dbPath);

    configureConnection(db);

    // 运行 schema 初始化
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);

    // 记录当前 schema 版本，以便打开时不重复应用迁移
    const currentVersion = getCurrentVersion(db);
    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      db.prepare(
        'INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)'
      ).run(CURRENT_SCHEMA_VERSION, Date.now(), 'Initial schema includes all migrations');
    }

    return new DatabaseConnection(db, dbPath, backend);
  }

  /**
   * 打开一个已有数据库
   */
  static open(dbPath: string): DatabaseConnection {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Database not found: ${dbPath}`);
    }

    const { db, backend } = createDatabase(dbPath);

    configureConnection(db);

    // 检查并在需要时运行迁移
    const conn = new DatabaseConnection(db, dbPath, backend);
    const currentVersion = getCurrentVersion(db);

    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      runMigrations(db, currentVersion);
    }

    return conn;
  }

  /**
   * 获取底层数据库实例
   */
  getDb(): SqliteDatabase {
    return this.db;
  }

  /**
   * 获取服务此连接的 SQLite 后端。按实例返回，以便
   * MCP 跨项目查询在同一进程中打开多个项目数据库时也能报告正确的后端。
   */
  getBackend(): SqliteBackend {
    return this.backend;
  }

  /**
   * 获取数据库文件路径
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * 实际生效的日志模式（例如 'wal'、'delete'）。
   *
   * 若 WAL 无法启用，SQLite 会静默保留原有模式——例如在不支持共享内存的文件系统上
   * （某些网络/虚拟化挂载点、WSL2 /mnt），以及 wasm 后端上始终如此。
   * 因此实际模式可能与 `configureConnection` 请求的不同。通过 `synapse status` 暴露，
   * 以便"database is locked"报告可追溯：'wal' ⇒ 读取从不阻塞写入方；
   * 其他模式 ⇒ 可能阻塞。参见 issue #238。
   */
  getJournalMode(): string {
    const raw = this.db.pragma('journal_mode');
    const row = Array.isArray(raw) ? raw[0] : raw;
    const mode = row && typeof row === 'object'
      ? (row as Record<string, unknown>).journal_mode
      : row;
    return String(mode ?? '').toLowerCase();
  }

  /**
   * 获取当前 schema 版本
   */
  getSchemaVersion(): SchemaVersion | null {
    const row = this.db
      .prepare('SELECT version, applied_at, description FROM schema_versions ORDER BY version DESC LIMIT 1')
      .get() as { version: number; applied_at: number; description: string | null } | undefined;

    if (!row) return null;

    return {
      version: row.version,
      appliedAt: row.applied_at,
      description: row.description ?? undefined,
    };
  }

  /**
   * 在事务中执行函数
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * 获取数据库文件大小（字节）
   */
  getSize(): number {
    const stats = fs.statSync(this.dbPath);
    return stats.size;
  }

  /**
   * 优化数据库（vacuum 和 analyze）
   */
  optimize(): void {
    this.db.exec('VACUUM');
    this.db.exec('ANALYZE');
  }

  /**
   * 批量写入后（indexAll、sync）运行的轻量级非阻塞维护。两个操作：
   *
   *   - `PRAGMA optimize` — 增量 ANALYZE；SQLite 仅对自上次
   *     ANALYZE 以来行数发生显著变化的表重新分析。
   *     若不执行，查询规划器对刚批量加载的表没有统计信息，可能选择次优索引。
   *
   *   - `PRAGMA wal_checkpoint(PASSIVE)` — 将待处理的 WAL 页折叠回
   *     主数据库文件，使 WAL 文件在自动检查点之间不会无限增长
   *     （默认在 1000 页时自动触发；大型 indexAll 运行远超此数）。
   *
   * 两个操作若失败均静默吞掉——它们是尽力优化，不是正确性的保障。
   */
  runMaintenance(): void {
    try {
      this.db.exec('PRAGMA optimize');
    } catch {
      // 忽略
    }
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    } catch {
      // 忽略（例如不在 WAL 模式下）
    }
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    this.db.close();
  }

  /**
   * 检查数据库连接是否已打开
   */
  isOpen(): boolean {
    return this.db.open;
  }
}

/**
 * 默认数据库文件名
 */
export const DATABASE_FILENAME = 'synapse.db';

/**
 * 获取项目的默认数据库路径
 */
export function getDatabasePath(projectRoot: string): string {
  return path.join(getSynapseDir(projectRoot), DATABASE_FILENAME);
}
