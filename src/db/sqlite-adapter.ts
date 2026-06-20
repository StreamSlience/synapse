/**
 * SQLite 适配器
 *
 * 对 Node 内置 `node:sqlite`（`DatabaseSync`）的薄封装，
 * 通过小型 better-sqlite3 风格接口暴露出去，使代码库其余部分与存储无关。
 *
 * Synapse 附带了打包好的 Node 运行时，因此 `node:sqlite`（真正的 SQLite，
 * 支持 WAL + FTS5）始终可用——无需原生构建步骤，也无需 WASM 回退。
 * 从源码运行时，需要 Node >= 22.5。
 */

export interface SqliteStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
  /**
   * 逐行懒惰地产出结果行，而不是用 `all()` 一次性物化整个结果集。
   * 用于无界扫描（例如每个 function/method 节点），
   * 使内存保持 O(1)（相对于行数）而非 O(rows)——
   * 参见 #610，在密集项目上对所有符号调用 `all()` 会导致堆内存 OOM。
   */
  iterate(...params: any[]): IterableIterator<any>;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(str: string, options?: { simple?: boolean }): any;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
  readonly open: boolean;
}

/**
 * 当前活跃的 SQLite 后端。现在只有一个（`node:sqlite`）；保留为具名类型
 * 以便 `synapse status` 和每实例报告具有稳定的形状。
 */
export type SqliteBackend = 'node-sqlite';

/**
 * 封装 Node 内置 `node:sqlite`（`DatabaseSync`），以匹配其余代码期望的
 * better-sqlite3 接口。
 *
 * node:sqlite 是编译进 Node 的真正 SQLite，支持 WAL、FTS5、
 * mmap 和 `@named` 参数——唯一需要的垫片是 node:sqlite 省略的
 * better-sqlite3 便利方法：`.pragma()` 辅助器、`.transaction()` 辅助器
 * 以及 `open`（node:sqlite 暴露的是 `isOpen`）。
 */
class NodeSqliteAdapter implements SqliteDatabase {
  private _db: any;

  constructor(dbPath: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    this._db = new DatabaseSync(dbPath);
  }

  get open(): boolean {
    return this._db.isOpen;
  }

  prepare(sql: string): SqliteStatement {
    // node:sqlite 匹配 better-sqlite3 的调用约定（可变数量的位置参数，
    // 或用于 @named 参数的单个对象），因此参数直接透传。
    const stmt = this._db.prepare(sql);
    return {
      run(...params: any[]) {
        const r = stmt.run(...params);
        return {
          changes: Number(r?.changes ?? 0),
          lastInsertRowid: r?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        return stmt.get(...params);
      },
      all(...params: any[]) {
        return stmt.all(...params);
      },
      iterate(...params: any[]) {
        return stmt.iterate(...params);
      },
    };
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  pragma(str: string, options?: { simple?: boolean }): any {
    const trimmed = str.trim();
    // 写入 pragma（"key = value"）：node:sqlite 是真正的 SQLite，因此每个 pragma
    // （WAL、mmap、synchronous 等）均按原样生效。
    if (trimmed.includes('=')) {
      this._db.exec(`PRAGMA ${trimmed}`);
      return;
    }
    // 读取 pragma。默认：行对象（例如 { journal_mode: 'wal' }）。
    // `{ simple: true }` 只返回单列值，与 better-sqlite3 一致。
    const row = this._db.prepare(`PRAGMA ${trimmed}`).get();
    if (options?.simple) {
      return row && typeof row === 'object' ? Object.values(row)[0] : row;
    }
    return row;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      this._db.exec('BEGIN');
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        return result;
      } catch (error) {
        this._db.exec('ROLLBACK');
        throw error;
      }
    };
  }

  close(): void {
    // node:sqlite 的 DatabaseSync.close() 在已关闭时会抛出异常；将其改为
    // 幂等操作以匹配 better-sqlite3（调用方可能关闭多次）。
    if (this._db.isOpen) this._db.close();
  }
}

/**
 * 创建由 `node:sqlite` 支撑的数据库连接。
 *
 * 将活跃后端与 db 一起返回，以便每个 `DatabaseConnection` 能按实例报告它——
 * MCP 可以在同一进程中打开多个项目数据库，因此进程全局变量会产生竞争。
 */
export function createDatabase(dbPath: string): { db: SqliteDatabase; backend: SqliteBackend } {
  try {
    return { db: new NodeSqliteAdapter(dbPath), backend: 'node-sqlite' };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      'Failed to open SQLite via the built-in node:sqlite module.\n' +
      'Synapse requires node:sqlite (Node.js 22.5+). Install the self-contained\n' +
      'Synapse release (it bundles a compatible Node), or run on Node 22.5+.\n' +
      `Underlying error: ${msg}`
    );
  }
}
