/**
 * 数据库查询
 *
 * 知识图谱 CRUD 操作的预编译语句。
 */

import { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import {
  Node,
  Edge,
  FileRecord,
  UnresolvedReference,
  NodeKind,
  EdgeKind,
  Language,
  GraphStats,
  SearchOptions,
  SearchResult,
} from '../types';
import { safeJsonParse } from '../utils';
import { kindBonus, nameMatchBonus, scorePathRelevance } from '../search/query-utils';
import { parseQuery, boundedEditDistance } from '../search/query-parser';
import { isGeneratedFile } from '../extraction/generated-detection';

/**
 * 文件低价值路径启发式：不应作为"主导文件"检测候选的文件：
 * 测试/spec 文件以及工具生成的文件。
 * 生成文件（`*.pb.go`、`*.pulsar.go`、mock 输出等）通常拥有
 * 庞大的文件内边数，会使真实源码相形见绌——etcd 的
 * `rpc.pb.go` 的文件内边数是 `server.go` 的 4 倍。
 */
function isLowValueFile(filePath: string): boolean {
  const lp = filePath.toLowerCase();
  return (
    /(?:^|\/)(tests?|__tests?__|spec)\//.test(lp) ||
    /_test\.go$/.test(lp) ||
    /(?:^|\/)test_[^/]+\.py$/.test(lp) ||
    /_test\.py$/.test(lp) ||
    /_spec\.rb$/.test(lp) ||
    /_test\.rb$/.test(lp) ||
    /\.(test|spec)\.[jt]sx?$/.test(lp) ||
    /(test|spec|tests)\.(java|kt|scala)$/.test(lp) ||
    /(tests?|spec)\.cs$/.test(lp) ||
    /tests?\.swift$/.test(lp) ||
    /_test\.dart$/.test(lp) ||
    isGeneratedFile(filePath)
  );
}

const SQLITE_PARAM_CHUNK_SIZE = 500;

/**
 * 数据库行类型（SQLite 返回的 snake_case 格式）
 */
interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  docstring: string | null;
  signature: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
  decorators: string | null;
  type_parameters: string | null;
  return_type: string | null;
  updated_at: number;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  provenance: string | null;
}

interface FileRow {
  path: string;
  content_hash: string;
  language: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  errors: string | null;
}

interface UnresolvedRefRow {
  id: number;
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  line: number;
  col: number;
  candidates: string | null;
  file_path: string;
  language: string;
}

/**
 * 将数据库行转换为 Node 对象
 */
function rowToNode(row: NodeRow): Node {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language as Language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    docstring: row.docstring ?? undefined,
    signature: row.signature ?? undefined,
    visibility: row.visibility as Node['visibility'],
    isExported: row.is_exported === 1,
    isAsync: row.is_async === 1,
    isStatic: row.is_static === 1,
    isAbstract: row.is_abstract === 1,
    decorators: row.decorators ? safeJsonParse(row.decorators, undefined) : undefined,
    typeParameters: row.type_parameters ? safeJsonParse(row.type_parameters, undefined) : undefined,
    returnType: row.return_type ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * 将数据库行转换为 Edge 对象
 */
function rowToEdge(row: EdgeRow): Edge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: row.provenance as Edge['provenance'],
  };
}

/**
 * 将数据库行转换为 FileRecord 对象
 */
function rowToFileRecord(row: FileRow): FileRecord {
  return {
    path: row.path,
    contentHash: row.content_hash,
    language: row.language as Language,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    errors: row.errors ? safeJsonParse(row.errors, undefined) : undefined,
  };
}

/**
 * 知识图谱数据库的查询构建器
 */
export class QueryBuilder {
  private db: SqliteDatabase;

  // 项目名称 token（go.mod / package.json / 仓库目录），已规范化。
  // 若查询词与某个 token 匹配，则将其从路径相关性打分中排除——
  // 它命名的是整个项目，而非某个符号，因此没有判别信号（#720）。
  // 由 Synapse 实例在打开时设置一次；默认为空（不降权）。
  private projectNameTokens: Set<string> = new Set();

  // 高频访问节点的节点缓存（LRU 风格，最多 1000 条）
  private nodeCache: Map<string, Node> = new Map();
  private readonly maxCacheSize = 1000;

  // 预编译语句（懒初始化）
  private stmts: {
    insertNode?: SqliteStatement;
    updateNode?: SqliteStatement;
    deleteNode?: SqliteStatement;
    deleteNodesByFile?: SqliteStatement;
    getNodeById?: SqliteStatement;
    getNodesByFile?: SqliteStatement;
    getNodesByKind?: SqliteStatement;
    insertEdge?: SqliteStatement;
    upsertFile?: SqliteStatement;
    deleteEdgesBySource?: SqliteStatement;
    deleteEdgesByTarget?: SqliteStatement;
    getEdgesBySource?: SqliteStatement;
    getEdgesByTarget?: SqliteStatement;
    insertFile?: SqliteStatement;
    updateFile?: SqliteStatement;
    deleteFile?: SqliteStatement;
    getFileByPath?: SqliteStatement;
    getAllFiles?: SqliteStatement;
    insertUnresolved?: SqliteStatement;
    deleteUnresolvedByNode?: SqliteStatement;
    getUnresolvedByName?: SqliteStatement;
    getNodesByName?: SqliteStatement;
    getNodesByQualifiedNameExact?: SqliteStatement;
    getNodesByLowerName?: SqliteStatement;
    getUnresolvedCount?: SqliteStatement;
    getUnresolvedBatch?: SqliteStatement;
    getAllFilePaths?: SqliteStatement;
    getAllNodeNames?: SqliteStatement;
    getDominantFile?: SqliteStatement;
    getTopRouteFile?: SqliteStatement;
    getRoutingManifest?: SqliteStatement;
  } = {};

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  /** 设置用于在路径打分中降权非判别性查询词的规范化项目名称 token（#720）。
   * 在项目打开时由 Synapse 实例调用一次。 */
  setProjectNameTokens(tokens: Set<string>): void {
    this.projectNameTokens = tokens;
  }

  /** 规范化的项目名称 token（#720）；若未派生则为空。 */
  getProjectNameTokens(): Set<string> {
    return this.projectNameTokens;
  }

  // ===========================================================================
  // 节点操作
  // ===========================================================================

  /**
   * 插入新节点
   */
  insertNode(node: Node): void {
    if (!this.stmts.insertNode) {
      this.stmts.insertNode = this.db.prepare(`
        INSERT OR REPLACE INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract,
          decorators, type_parameters, return_type, updated_at
        ) VALUES (
          @id, @kind, @name, @qualifiedName, @filePath, @language,
          @startLine, @endLine, @startColumn, @endColumn,
          @docstring, @signature, @visibility,
          @isExported, @isAsync, @isStatic, @isAbstract,
          @decorators, @typeParameters, @returnType, @updatedAt
        )
      `);
    }

    // 校验必填字段，防止 SQLite 绑定错误
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[Synapse] Skipping node with missing required fields:', {
        id: node.id,
        kind: node.kind,
        name: node.name,
        filePath: node.filePath,
        language: node.language,
      });
      return;
    }

    // INSERT OR REPLACE 可能会覆盖缓存中的节点。删除
    // 过期条目，使下一次 getNodeById 读到新行而非旧行
    //（与 updateNode 和 deleteNode 使用的缓存失效模式一致）。
    this.nodeCache.delete(node.id);

    this.stmts.insertNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine ?? 0,
      endLine: node.endLine ?? 0,
      startColumn: node.startColumn ?? 0,
      endColumn: node.endColumn ?? 0,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      visibility: node.visibility ?? null,
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : null,
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      returnType: node.returnType ?? null,
      updatedAt: node.updatedAt ?? Date.now(),
    });
  }

  /**
   * 在事务中插入多个节点
   */
  insertNodes(nodes: Node[]): void {
    this.db.transaction(() => {
      for (const node of nodes) {
        this.insertNode(node);
      }
    })();
  }

  /**
   * 更新已有节点
   */
  updateNode(node: Node): void {
    if (!this.stmts.updateNode) {
      this.stmts.updateNode = this.db.prepare(`
        UPDATE nodes SET
          kind = @kind,
          name = @name,
          qualified_name = @qualifiedName,
          file_path = @filePath,
          language = @language,
          start_line = @startLine,
          end_line = @endLine,
          start_column = @startColumn,
          end_column = @endColumn,
          docstring = @docstring,
          signature = @signature,
          visibility = @visibility,
          is_exported = @isExported,
          is_async = @isAsync,
          is_static = @isStatic,
          is_abstract = @isAbstract,
          decorators = @decorators,
          type_parameters = @typeParameters,
          return_type = @returnType,
          updated_at = @updatedAt
        WHERE id = @id
      `);
    }

    // 更新前使缓存失效
    this.nodeCache.delete(node.id);

    // 校验必填字段
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[Synapse] Skipping node update with missing required fields:', node.id);
      return;
    }

    this.stmts.updateNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine ?? 0,
      endLine: node.endLine ?? 0,
      startColumn: node.startColumn ?? 0,
      endColumn: node.endColumn ?? 0,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      visibility: node.visibility ?? null,
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : null,
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      returnType: node.returnType ?? null,
      updatedAt: node.updatedAt ?? Date.now(),
    });
  }

  /**
   * 按 ID 删除节点
   */
  deleteNode(id: string): void {
    if (!this.stmts.deleteNode) {
      this.stmts.deleteNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    }
    // 使缓存失效
    this.nodeCache.delete(id);
    this.stmts.deleteNode.run(id);
  }

  /**
   * 删除某文件的所有节点
   */
  deleteNodesByFile(filePath: string): void {
    if (!this.stmts.deleteNodesByFile) {
      this.stmts.deleteNodesByFile = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
    }
    // 使该文件中所有节点的缓存失效
    for (const [id, node] of this.nodeCache) {
      if (node.filePath === filePath) {
        this.nodeCache.delete(id);
      }
    }
    this.stmts.deleteNodesByFile.run(filePath);
  }

  /**
   * 按 ID 获取节点
   */
  getNodeById(id: string): Node | null {
    // 先检查缓存
    if (this.nodeCache.has(id)) {
      const cached = this.nodeCache.get(id)!;
      // 移到末尾实现 LRU（删除再重新插入）
      this.nodeCache.delete(id);
      this.nodeCache.set(id, cached);
      return cached;
    }

    if (!this.stmts.getNodeById) {
      this.stmts.getNodeById = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    }
    const row = this.stmts.getNodeById.get(id) as NodeRow | undefined;
    if (!row) {
      return null;
    }

    const node = rowToNode(row);
    this.cacheNode(node);
    return node;
  }

  /**
   * 批量查询：单次 SQL 往返获取多个节点。
   *
   * 替代图遍历中每条边都触发独立 `getNodeById` 调用的 N+1 模式。
   * 对于有 50 个调用者的函数，这将 50 次点读合并为一次 IN 列表查询
   * （端到端快约 10-50 倍）。
   *
   * 返回以 id 为键的 Map，使调用方能保留自己的排序顺序
   * （通常是边从图中返回的顺序）。缺失的 ID 在 Map 中不会出现。
   *
   * 缓存感知：已在 LRU 缓存中的 id 直接从内存取，
   * SQL 查询只处理未命中的部分。
   */
  getNodesByIds(ids: readonly string[]): Map<string, Node> {
    const out = new Map<string, Node>();
    if (ids.length === 0) return out;

    // 先处理缓存命中；为 SQL 构建未命中列表。
    const misses: string[] = [];
    for (const id of ids) {
      const cached = this.nodeCache.get(id);
      if (cached !== undefined) {
        // LRU 触碰
        this.nodeCache.delete(id);
        this.nodeCache.set(id, cached);
        out.set(id, cached);
      } else {
        misses.push(id);
      }
    }
    if (misses.length === 0) return out;

    // 在 SQLite 参数限制下分块（better-sqlite3 构建中默认 999，上限 32766——
    // 为安全起见在两个后端之间都按 500 分块，并使查询计划保持简单）。
    for (let i = 0; i < misses.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = misses.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
        .all(...chunk) as NodeRow[];
      for (const row of rows) {
        const node = rowToNode(row);
        out.set(node.id, node);
        this.cacheNode(node);
      }
    }
    return out;
  }

  private getExistingNodeIds(ids: readonly string[]): Set<string> {
    const out = new Set<string>();
    if (ids.length === 0) return out;

    const uniqueIds = [...new Set(ids)];
    for (let i = 0; i < uniqueIds.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = uniqueIds.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT id FROM nodes WHERE id IN (${placeholders})`)
        .all(...chunk) as { id: string }[];
      for (const row of rows) {
        out.add(row.id);
      }
    }

    return out;
  }

  /**
   * 向缓存添加节点，若需要则驱逐最老的条目
   */
  private cacheNode(node: Node): void {
    if (this.nodeCache.size >= this.maxCacheSize) {
      // 驱逐最老（第一个）条目
      const firstKey = this.nodeCache.keys().next().value;
      if (firstKey) {
        this.nodeCache.delete(firstKey);
      }
    }
    this.nodeCache.set(node.id, node);
  }

  /**
   * 清空节点缓存
   */
  clearCache(): void {
    this.nodeCache.clear();
  }

  /**
   * 获取文件中的所有节点
   */
  getNodesByFile(filePath: string): Node[] {
    if (!this.stmts.getNodesByFile) {
      this.stmts.getNodesByFile = this.db.prepare(
        'SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line'
      );
    }
    const rows = this.stmts.getNodesByFile.all(filePath) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * 查找持有项目内部调用图最密集的文件——"核心"文件。
   * 被 context-builder 用于提升该文件目录中符号的排名（例如
   * sinatra 查询能优先显示 `lib/sinatra/base.rb` 的 `route!`
   * 而非 `sinatra-contrib/lib/sinatra/multi_route.rb` 的 `route` 扩展）。
   *
   * 若无文件具有有意义的集中度（例如分散在许多文件或索引为空），返回 null。
   *
   * "内部"= source 和 target 在同一文件。跨文件边在此无用——
   * 它们无法告诉我们哪个文件是功能中心。
   *
   * 通过路径模式排除测试/spec 文件。智能体的典型问题是
   * "X 如何工作"，而非"X 如何被测试"，因此提升测试文件目录会是误判。
   */
  getDominantFile(): { filePath: string; edgeCount: number; nextEdgeCount: number } | null {
    if (!this.stmts.getDominantFile) {
      // 获取前 20 个候选；随后在代码中过滤测试/生成文件
      // （SQL LIKE 无法表达的正则级匹配）。
      // 生成文件过滤至关重要——若不过滤，etcd 的
      // `api/etcdserverpb/rpc.pb.go`（1916 条文件内边，生成的 protobuf stub）
      // 会以 4 倍优势超过真正的 `server/etcdserver/server.go`
      // （470 条边），boost 会把智能体引导向生成代码。
      this.stmts.getDominantFile = this.db.prepare(`
        SELECT n.file_path AS file_path, COUNT(*) AS edge_count
        FROM edges e
        JOIN nodes n ON e.source = n.id
        JOIN nodes m ON e.target = m.id
        WHERE n.file_path = m.file_path
        GROUP BY n.file_path
        ORDER BY edge_count DESC
        LIMIT 20
      `);
    }
    const rows = this.stmts.getDominantFile.all() as Array<{ file_path: string; edge_count: number }>;
    const filtered = rows.filter(r => !isLowValueFile(r.file_path));
    if (filtered.length === 0 || filtered[0]!.edge_count < 20) return null;
    return {
      filePath: filtered[0]!.file_path,
      edgeCount: filtered[0]!.edge_count,
      nextEdgeCount: filtered[1]?.edge_count ?? 0,
    };
  }

  /**
   * 查找持有项目 `route` 节点最密集的文件
   * （框架发出：Express/Gin/Flask/Rails/Drupal 等）。
   * 在小型仓库上被 handleContext 用于当智能体的查询关于请求流时
   * 内联项目的路由配置——消除 "Glob + Read routes.rb" 模式
   * 在小型 realworld 模板仓库上胜过 synapse 的情况。
   *
   * 排除测试/生成文件。若非测试路由总数少于 3，或
   * 没有单个文件持有至少 30%（分散路由→无单一答案文件），返回 null。
   */
  getTopRouteFile(): { filePath: string; routeCount: number; totalRoutes: number } | null {
    if (!this.stmts.getTopRouteFile) {
      this.stmts.getTopRouteFile = this.db.prepare(`
        SELECT file_path, COUNT(*) AS cnt
        FROM nodes
        WHERE kind = 'route'
        GROUP BY file_path
        ORDER BY cnt DESC
        LIMIT 20
      `);
    }
    const rows = this.stmts.getTopRouteFile.all() as Array<{ file_path: string; cnt: number }>;
    const filtered = rows.filter(r => !isLowValueFile(r.file_path));
    if (filtered.length === 0) return null;
    const totalRoutes = filtered.reduce((sum, r) => sum + r.cnt, 0);
    const top = filtered[0]!;
    if (totalRoutes < 3 || top.cnt < 3) return null;
    if (top.cnt / totalRoutes < 0.30) return null;
    return { filePath: top.file_path, routeCount: top.cnt, totalRoutes };
  }

  /**
   * 从索引构建 URL → handler 路由清单。每个路由节点的
   * `references` 边指向处理请求的函数/方法。
   * 单次遍历完成联接；智能体无需自己解析框架的路由 DSL
   * 就能得到规范的路由答案（"POST /users/login → AuthController#login"）。
   *
   * 同时返回拥有最多 handler 端点的文件——用作内联源码的
   * "顶级 handler 文件"，使智能体同时拥有映射关系和 handler 实现。
   */
  getRoutingManifest(limit: number = 40): {
    entries: Array<{ url: string; handler: string; handlerFile: string; handlerLine: number; handlerKind: string }>;
    topHandlerFile: string | null;
    topHandlerFileCount: number;
    totalRoutes: number;
  } | null {
    if (!this.stmts.getRoutingManifest) {
      // 边类型因框架解析器而异：Spring/Rails/
      // Laravel/Drupal 发出 `references`，Express 发出 `calls`。
      // 两者均接受——语义相同（路由→其 handler）。
      this.stmts.getRoutingManifest = this.db.prepare(`
        SELECT
          r.name AS url,
          h.name AS handler,
          h.file_path AS handler_file,
          h.start_line AS handler_line,
          h.kind AS handler_kind
        FROM nodes r
        JOIN edges e ON e.source = r.id
        JOIN nodes h ON e.target = h.id
        WHERE r.kind = 'route'
          AND e.kind IN ('references', 'calls')
          AND h.kind IN ('function', 'method', 'class')
        ORDER BY r.file_path, r.start_line
        LIMIT ?
      `);
    }
    const rows = this.stmts.getRoutingManifest.all(limit) as Array<{
      url: string; handler: string; handler_file: string; handler_line: number; handler_kind: string;
    }>;
    // 过滤测试/生成 handler——与其他地方保持一致的卫生处理。
    const filtered = rows.filter(r => !isLowValueFile(r.handler_file));
    if (filtered.length < 3) return null;
    // 识别持有最多 handler 的文件（"主 handler 文件"）。
    const fileCounts = new Map<string, number>();
    for (const r of filtered) {
      fileCounts.set(r.handler_file, (fileCounts.get(r.handler_file) ?? 0) + 1);
    }
    let topHandlerFile: string | null = null;
    let topHandlerFileCount = 0;
    for (const [file, count] of fileCounts) {
      if (count > topHandlerFileCount) {
        topHandlerFile = file;
        topHandlerFileCount = count;
      }
    }
    return {
      entries: filtered.map(r => ({
        url: r.url,
        handler: r.handler,
        handlerFile: r.handler_file,
        handlerLine: r.handler_line,
        handlerKind: r.handler_kind,
      })),
      topHandlerFile,
      topHandlerFileCount,
      totalRoutes: filtered.length,
    };
  }

  /**
   * 获取指定类型的所有节点
   */
  getNodesByKind(kind: NodeKind): Node[] {
    if (!this.stmts.getNodesByKind) {
      this.stmts.getNodesByKind = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
    }
    const rows = this.stmts.getNodesByKind.all(kind) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * 按类型懒惰地逐个流式传输节点，而非像 {@link getNodesByKind} 那样一次性物化。
   * 对于符号密集项目上的无界类型（`function`、`method`），完整数组会占用数 GB；
   * 动态边合成器只需扫描过滤，因此使用迭代方式将内存保持在 O(1)
   * 而非 O(nodes)（#610）。
   */
  *iterateNodesByKind(kind: NodeKind): IterableIterator<Node> {
    // 每次调用创建新语句（不复用缓存语句）：迭代器持有一个开放游标，
    // 因此共享语句会在重叠扫描之间产生冲突。
    const stmt = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
    for (const row of stmt.iterate(kind)) {
      yield rowToNode(row as NodeRow);
    }
  }

  /**
   * 获取数据库中的所有节点
   */
  getAllNodes(): Node[] {
    const rows = this.db.prepare('SELECT * FROM nodes').all() as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * 按精确名称匹配获取节点（使用 idx_nodes_name 索引）
   */
  getNodesByName(name: string): Node[] {
    if (!this.stmts.getNodesByName) {
      this.stmts.getNodesByName = this.db.prepare('SELECT * FROM nodes WHERE name = ?');
    }
    const rows = this.stmts.getNodesByName.all(name) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * 按精确限定名匹配获取节点（使用 idx_nodes_qualified_name 索引）
   */
  getNodesByQualifiedNameExact(qualifiedName: string): Node[] {
    if (!this.stmts.getNodesByQualifiedNameExact) {
      this.stmts.getNodesByQualifiedNameExact = this.db.prepare(
        'SELECT * FROM nodes WHERE qualified_name = ?'
      );
    }
    const rows = this.stmts.getNodesByQualifiedNameExact.all(qualifiedName) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * 按小写名称匹配获取节点（使用 idx_nodes_lower_name 表达式索引）
   */
  getNodesByLowerName(lowerName: string): Node[] {
    if (!this.stmts.getNodesByLowerName) {
      this.stmts.getNodesByLowerName = this.db.prepare(
        'SELECT * FROM nodes WHERE lower(name) = ?'
      );
    }
    const rows = this.stmts.getNodesByLowerName.all(lowerName) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * 使用 FTS 搜索节点名称，不匹配时回退到 LIKE 以提升匹配率
   *
   * 搜索策略：
   * 1. 尝试 FTS5 前缀匹配（query*）进行词首匹配
   * 2. 若无结果，尝试基于 LIKE 的子串匹配（例如 "signIn" 找到 "signInWithGoogle"）
   * 3. 根据匹配质量对结果打分
   */
  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    const { limit = 100, offset = 0 } = options;

    // 从原始查询中解析字段限定部分（kind:、lang:、path:、name:）。
    // 未识别的部分保留在 `text` 中并原样传给 FTS。
    // 过滤器与 SearchOptions 参数组合——两者均被应用（交集风格）。
    const parsed = parseQuery(query);
    const mergedKinds =
      parsed.kinds.length > 0
        ? Array.from(new Set([...(options.kinds ?? []), ...parsed.kinds]))
        : options.kinds;
    const mergedLanguages =
      parsed.languages.length > 0
        ? Array.from(new Set([...(options.languages ?? []), ...parsed.languages]))
        : options.languages;
    const pathFilters = parsed.pathFilters;
    const nameFilters = parsed.nameFilters;
    // 文本部分驱动 FTS/LIKE；若用户只输入了过滤器（`kind:function`），
    // 我们仍需要某种候选集，因此合成一条返回所有匹配过滤器条目的空文本路径。
    const text = parsed.text;
    const kinds = mergedKinds;
    const languages = mergedLanguages;

    // 先尝试 FTS5 前缀匹配
    let results = text
      ? this.searchNodesFTS(text, { kinds, languages, limit, offset })
      // 仅过滤器运行时过度获取 5 倍。后评分路径中的
      // path: + name: 过滤器可能非常严格，
      // 因此较小的倍数会在数据库有大量匹配的情况下返回少于 `limit` 的结果。
      : this.searchAllByFilters({ kinds, languages, limit: limit * 5 });

    // 若无 FTS 结果，尝试基于 LIKE 的子串搜索
    if (results.length === 0 && text.length >= 2) {
      results = this.searchNodesLike(text, { kinds, languages, limit, offset });
    }

    // 最终模糊回退：当 FTS 和 LIKE 均无结果且文本部分足够长时，
    // 扫描所有已知名称，保留在紧 Levenshtein 距离内的。
    // 仅在文本长度 ≥ 3 时触发（1 字符查询匹配太多）。
    if (results.length === 0 && text.length >= 3) {
      results = this.searchNodesFuzzy(text, { kinds, languages, limit });
    }

    // 补充：确保精确名称匹配始终是候选。
    // BM25 可能在大型代码库中将短精确匹配名称（例如 "getBean"）
    // 淹没在数百个复合名称（例如 "getBeanDescriptor"）中，
    // 使其在后期评分介入之前就超过 FTS 获取限制。
    // 以最大 BM25 分数为基准，使 nameMatchBonus（精确=30 vs 前缀=20）
    // 在重新评分后真正能区分它们。
    if (results.length > 0 && query) {
      const existingIds = new Set(results.map(r => r.node.id));
      const maxFtsScore = Math.max(...results.map(r => r.score));
      const terms = query.split(/\s+/).filter(t => t.length >= 2);
      for (const term of terms) {
        let sql = 'SELECT * FROM nodes WHERE name = ? COLLATE NOCASE';
        const params: (string | number)[] = [term];
        if (kinds && kinds.length > 0) {
          sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
          params.push(...kinds);
        }
        if (languages && languages.length > 0) {
          sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
          params.push(...languages);
        }
        sql += ' LIMIT 20';
        const rows = this.db.prepare(sql).all(...params) as NodeRow[];
        for (const row of rows) {
          if (!existingIds.has(row.id)) {
            results.push({ node: rowToNode(row), score: maxFtsScore });
            existingIds.add(row.id);
          }
        }
      }
    }

    // 应用多信号打分
    if (results.length > 0 && (text || query)) {
      const scoringQuery = text || query;
      results = results.map(r => ({
        ...r,
        score: r.score
          + kindBonus(r.node.kind)
          + scorePathRelevance(r.node.filePath, scoringQuery, this.projectNameTokens)
          + nameMatchBonus(r.node.name, scoringQuery),
      }));
      results.sort((a, b) => b.score - a.score);
      // 重新评分后裁剪到请求的限制
      if (results.length > limit) {
        results = results.slice(0, limit);
      }
    }

    // 在打分后应用 path: + name: 过滤器。打分已将路径/名称作为软信号使用；
    // 此处的显式过滤器是硬性门槛。放在最后，以便 FTS 限制能获取足够多的候选。
    if (pathFilters.length > 0) {
      const lowered = pathFilters.map((p) => p.toLowerCase());
      results = results.filter((r) => {
        const fp = r.node.filePath.toLowerCase();
        return lowered.some((p) => fp.includes(p));
      });
    }
    if (nameFilters.length > 0) {
      const lowered = nameFilters.map((n) => n.toLowerCase());
      results = results.filter((r) => {
        const nm = r.node.name.toLowerCase();
        return lowered.some((n) => nm.includes(n));
      });
    }

    return results;
  }

  /**
   * 用户只提供字段过滤器（`kind:function lang:typescript`）而无文本时的全匹配路径。
   * 返回按名称排序的候选；调用方的过滤遍历会缩小到所需内容。
   */
  private searchAllByFilters(options: {
    kinds?: NodeKind[];
    languages?: Language[];
    limit: number;
  }): SearchResult[] {
    const { kinds, languages, limit } = options;
    let sql = 'SELECT * FROM nodes WHERE 1=1';
    const params: (string | number)[] = [];
    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }
    sql += ' ORDER BY name LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    return rows.map((row) => ({ node: rowToNode(row), score: 1 }));
  }

  /**
   * 模糊回退：当 FTS/LIKE 零命中时，对不同符号名称集做编辑距离扫描。
   * 将 `maxDist` 上限设为 2，使 `getUssr` 能找到 `getUser`
   * 但 `process` 不会匹配 `prosody`。
   * 有界编辑距离使每次比较开销低；每查询扫描为 O(不同名称数)，
   * 任何真实代码库上都远小于总节点数。
   */
  private searchNodesFuzzy(
    text: string,
    options: { kinds?: NodeKind[]; languages?: Language[]; limit: number }
  ): SearchResult[] {
    const { kinds, languages, limit } = options;
    const lowered = text.toLowerCase();
    const maxDist = lowered.length <= 4 ? 1 : 2;

    // 拉取一次不同名称列表。该集合由 getAllNodeNames() 缓存在 QueryBuilder 上；
    // 即使在 20 万节点的项目上，不同名称集通常也是 O(1 万)，
    // 因为大多数名称会重复。下面的候选上限无论如何都会限制内存。
    const allNames = this.getAllNodeNames();
    const candidates: Array<{ name: string; dist: number }> = [];
    for (const name of allNames) {
      const dist = boundedEditDistance(name.toLowerCase(), lowered, maxDist);
      if (dist <= maxDist) candidates.push({ name, dist });
    }
    candidates.sort((a, b) => a.dist - b.dist);

    // 限制每名称的后续查询数量。每个幸存者都会触发一次
    // 独立的 `SELECT * FROM nodes WHERE name = ?`；若没有此上限，
    // 拥有大量相似名称（`getUser1`、`getUser2`...）的项目可能
    // 在内循环限制生效前就远超 `limit` 次查询。
    const FUZZY_FOLLOWUP_CAP = Math.max(limit * 2, 50);
    const cappedCandidates = candidates.slice(0, FUZZY_FOLLOWUP_CAP);

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const c of cappedCandidates) {
      if (results.length >= limit) break;
      let sql = 'SELECT * FROM nodes WHERE name = ?';
      const params: (string | number)[] = [c.name];
      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }
      if (languages && languages.length > 0) {
        sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
        params.push(...languages);
      }
      sql += ' LIMIT 5';
      const rows = this.db.prepare(sql).all(...params) as NodeRow[];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        // 每编辑步骤降低分数，使精确匹配回退（dist 0）优于 dist-2 拼写错误。
        results.push({ node: rowToNode(row), score: 1 / (1 + c.dist) });
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /**
   * FTS5 前缀匹配搜索
   */
  private searchNodesFTS(query: string, options: SearchOptions): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    // 为更好的匹配添加前缀通配符（例如 "auth" 匹配 "AuthService"、"authenticate"）
    // 转义 FTS5 特殊字符并添加前缀通配符。
    //
    // `::` 是 Rust/C++/Ruby 中的限定符分隔符，而非 token 字符，
    // 因此在剥离步骤之前将其视为空白。否则 `stage_apply::run` 这样的查询
    // 会坍缩为 `stage_applyrun`（冒号被剥离时未拆分），什么都找不到。参见 #173。
    const ftsQuery = query
      .replace(/::/g, ' ') // Rust/C++/Ruby qualifier separator
      .replace(/['"*():^]/g, '') // Remove FTS5 special chars
      .split(/\s+/)
      .filter(term => term.length > 0)
      // 剥离 FTS5 布尔运算符以防止查询操纵
      .filter(term => !/^(AND|OR|NOT|NEAR)$/i.test(term))
      .map(term => `"${term}"*`) // 对每个词进行前缀匹配
      .join(' OR ');

    if (!ftsQuery) {
      return [];
    }

    // BM25 列权重：id=0, name=20, qualified_name=5, docstring=1, signature=2
    // 重name权重确保精确/前缀名称匹配排在长 docstring 或嵌套符号限定名
    // 中的偶然提及之上。
    // 获取请求限制的 5 倍，以便后期重新评分（kindBonus、pathRelevance、
    // nameMatchBonus）能提升 BM25 单独排名不足的结果。
    const ftsLimit = Math.max(limit * 5, 100);

    let sql = `
      SELECT nodes.*, bm25(nodes_fts, 0, 20, 5, 1, 2) as score
      FROM nodes_fts
      JOIN nodes ON nodes_fts.id = nodes.id
      WHERE nodes_fts MATCH ?
    `;

    const params: (string | number)[] = [ftsQuery];

    if (kinds && kinds.length > 0) {
      sql += ` AND nodes.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND nodes.language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY score LIMIT ? OFFSET ?';
    params.push(ftsLimit, offset);

    try {
      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      return rows.map((row) => ({
        node: rowToNode(row),
        score: Math.abs(row.score), // bm25 返回负分
      }));
    } catch {
      // FTS 查询失败，返回空
      return [];
    }
  }

  /**
   * FTS 不匹配时的基于 LIKE 子串搜索
   * 用于驼峰命名匹配（例如 "signIn" 找到 "signInWithGoogle"）
   */
  private searchNodesLike(query: string, options: SearchOptions): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0 } = options;

    let sql = `
      SELECT nodes.*,
        CASE
          WHEN name = ? THEN 1.0
          WHEN name LIKE ? THEN 0.9
          WHEN name LIKE ? THEN 0.8
          WHEN qualified_name LIKE ? THEN 0.7
          ELSE 0.5
        END as score
      FROM nodes
      WHERE (
        name LIKE ? OR
        qualified_name LIKE ? OR
        name LIKE ?
      )
    `;

    // 不同匹配变体，提升匹配效果
    const exactMatch = query;
    const startsWith = `${query}%`;
    const contains = `%${query}%`;

    const params: (string | number)[] = [
      exactMatch,     // 精确匹配分数
      startsWith,     // 前缀匹配分数
      contains,       // 包含匹配分数
      contains,       // 限定名匹配分数
      contains,       // WHERE: name 包含
      contains,       // WHERE: qualified_name 包含
      startsWith,     // WHERE: name 前缀
    ];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY score DESC, length(name) ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];

    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  /**
   * 按精确名称查找节点
   *
   * 用于混合搜索——按精确名称或不区分大小写匹配查找符号。
   * 对从查询中提取的已知符号名返回高置信度匹配。
   *
   * @param names - 待查找的符号名数组
   * @param options - 搜索选项（kinds、languages、limit）
   * @returns 精确匹配分数为 1.0 的 SearchResult 数组
   */
  findNodesByExactName(names: string[], options: SearchOptions = {}): SearchResult[] {
    if (names.length === 0) return [];

    const { kinds, languages, limit = 50 } = options;

    // 两遍方法处理常见名称（例如 "run" 有 40+ 个匹配）：
    // 第一遍：找出哪些文件包含查询中的独特（稀有）符号。
    // 第二遍：查询每个名称，对与独特符号共同定位的结果加权。

    // 第一遍：找出包含每个查询名称的文件，识别独特名称
    const nameToFiles = new Map<string, Set<string>>();
    for (const name of names) {
      let sql = 'SELECT DISTINCT file_path FROM nodes WHERE name COLLATE NOCASE = ?';
      const params: (string | number)[] = [name];
      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }
      sql += ' LIMIT 100';
      const rows = this.db.prepare(sql).all(...params) as { file_path: string }[];
      nameToFiles.set(name.toLowerCase(), new Set(rows.map(r => r.file_path)));
    }

    // 独特名称是文件匹配数少于 10 的名称（例如 "scrapeLoop" = 1 个文件）
    const distinctiveFiles = new Set<string>();
    for (const [, files] of nameToFiles) {
      if (files.size > 0 && files.size < 10) {
        for (const f of files) distinctiveFiles.add(f);
      }
    }

    // 第二遍：按每名称限制查询，按共同定位打分
    const perNameLimit = Math.max(8, Math.ceil(limit / names.length));
    const allResults: SearchResult[] = [];
    const seenIds = new Set<string>();

    for (const name of names) {
      let sql = `
        SELECT nodes.*, 1.0 as score
        FROM nodes
        WHERE name COLLATE NOCASE = ?
      `;
      const params: (string | number)[] = [name];

      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }

      if (languages && languages.length > 0) {
        sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
        params.push(...languages);
      }

      // Fetch enough to find co-located results among common names
      sql += ' LIMIT ?';
      params.push(Math.max(perNameLimit * 3, 50));

      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      const nameResults: SearchResult[] = [];
      for (const row of rows) {
        const node = rowToNode(row);
        if (seenIds.has(node.id)) continue;
        // Boost results in files that also contain distinctive symbols
        const coLocationBoost = distinctiveFiles.has(node.filePath) ? 20 : 0;
        nameResults.push({ node, score: row.score + coLocationBoost });
      }

      // 按分数排序（共同定位的优先），取每名称限制
      nameResults.sort((a, b) => b.score - a.score);
      for (const r of nameResults.slice(0, perNameLimit)) {
        seenIds.add(r.node.id);
        allResults.push(r);
      }
    }

    // 按分数排序所有结果，使共同定位的结果上浮
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
  }

  /**
   * 查找名称中包含子串的节点（基于 LIKE）。
   * 用于 CamelCase 部分匹配，FTS 无法处理的情况——
   * 例如 "TransportSearchAction" 是一个 FTS token，无法通过 "Search"* 匹配。
   *
   * 结果按名称长度排序（越短越可能是核心类型）。
   */
  findNodesByNameSubstring(
    substring: string,
    options: SearchOptions & { excludePrefix?: boolean } = {}
  ): SearchResult[] {
    const { kinds, languages, limit = 30, excludePrefix } = options;

    let sql = `
      SELECT nodes.*, 1.0 as score
      FROM nodes
      WHERE name LIKE ?
    `;
    const params: (string | number)[] = [`%${substring}%`];

    // 排除前缀匹配（由步骤 2b 中基于 FTS 的前缀搜索处理）
    if (excludePrefix) {
      sql += ` AND name NOT LIKE ?`;
      params.push(`${substring}%`);
    }

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY length(name) ASC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  // ===========================================================================
  // 边操作
  // ===========================================================================

  /**
   * 插入新边
   */
  insertEdge(edge: Edge): void {
    if (!this.stmts.insertEdge) {
      this.stmts.insertEdge = this.db.prepare(`
        INSERT OR IGNORE INTO edges (source, target, kind, metadata, line, col, provenance)
        VALUES (@source, @target, @kind, @metadata, @line, @col, @provenance)
      `);
    }

    this.stmts.insertEdge.run({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      metadata: edge.metadata ? JSON.stringify(edge.metadata) : null,
      line: edge.line ?? null,
      col: edge.column ?? null,
      provenance: edge.provenance ?? null,
    });
  }

  /**
   * 在事务中插入多条边
   */
  insertEdges(edges: Edge[]): void {
    if (edges.length === 0) return;

    this.db.transaction(() => {
      const endpointIds = new Set<string>();
      for (const edge of edges) {
        endpointIds.add(edge.source);
        endpointIds.add(edge.target);
      }
      const existingNodeIds = this.getExistingNodeIds([...endpointIds]);

      for (const edge of edges) {
        if (!existingNodeIds.has(edge.source) || !existingNodeIds.has(edge.target)) {
          continue;
        }
        this.insertEdge(edge);
      }
    })();
  }

  /**
   * 删除来自源节点的所有边
   */
  deleteEdgesBySource(sourceId: string): void {
    if (!this.stmts.deleteEdgesBySource) {
      this.stmts.deleteEdgesBySource = this.db.prepare('DELETE FROM edges WHERE source = ?');
    }
    this.stmts.deleteEdgesBySource.run(sourceId);
  }

  /**
   * 获取节点的出向边
   */
  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[] {
    if ((kinds && kinds.length > 0) || provenance) {
      let sql = 'SELECT * FROM edges WHERE source = ?';
      const params: (string | number)[] = [sourceId];

      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }

      if (provenance) {
        sql += ' AND provenance = ?';
        params.push(provenance);
      }

      const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesBySource) {
      this.stmts.getEdgesBySource = this.db.prepare('SELECT * FROM edges WHERE source = ?');
    }
    const rows = this.stmts.getEdgesBySource.all(sourceId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * 获取节点的入向边
   */
  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    if (kinds && kinds.length > 0) {
      const sql = `SELECT * FROM edges WHERE target = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
      const rows = this.db.prepare(sql).all(targetId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesByTarget) {
      this.stmts.getEdgesByTarget = this.db.prepare('SELECT * FROM edges WHERE target = ?');
    }
    const rows = this.stmts.getEdgesByTarget.all(targetId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * 查找给定节点集中两两之间的所有边。
   * 用于 BFS 后恢复节点间的连通性。
   */
  findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
    if (nodeIds.length === 0) return [];

    const idsJson = JSON.stringify(nodeIds);
    let sql = `SELECT * FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?))`;
    const params: string[] = [idsJson, idsJson];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * 依赖 `filePath` 的不同文件路径：包含符号的每个文件，
   * 该符号与此文件的某个符号之间有跨文件边（`contains` 除外）。
   * 这是符号依赖图的文件级投影，也是爆炸半径 / `affected` 测试选择的基础。
   *
   * 故意不限制为 `imports` 边。在此图中，`imports` 边连接文件
   * 与其自身的本地 import 声明（始终同文件），
   * 因此 imports-only 查找对每个文件都返回零个跨文件依赖方。
   * 真正的跨文件依赖信号是已解析的调用/引用图——
   * calls、references、instantiates、extends、implements、overrides、
   * type_of、returns、decorates——正是 {@link GraphTraverser.getImpactRadius} 遍历的内容。
   * 排除 `contains`：父节点包含某个符号并不*依赖*它。
   * 单次索引查询（idx_nodes_file_path + idx_edges_target_kind）。
   */
  getDependentFilePaths(filePath: string): string[] {
    const sql = `SELECT DISTINCT src.file_path AS fp
      FROM edges e
      JOIN nodes tgt ON tgt.id = e.target
      JOIN nodes src ON src.id = e.source
      WHERE tgt.file_path = ?
        AND e.kind != 'contains'
        AND src.file_path != ?`;
    const rows = this.db.prepare(sql).all(filePath, filePath) as Array<{ fp: string }>;
    return rows.map((r) => r.fp);
  }

  /**
   * `filePath` 所依赖的不同文件路径——{@link getDependentFilePaths} 的逆：
   * 包含此文件的某个符号指向的跨文件边目标符号的每个文件。
   * 边类型规则相同（`contains` 除外）；imports-only 不足的原因相同。
   */
  getDependencyFilePaths(filePath: string): string[] {
    const sql = `SELECT DISTINCT tgt.file_path AS fp
      FROM edges e
      JOIN nodes src ON src.id = e.source
      JOIN nodes tgt ON tgt.id = e.target
      WHERE src.file_path = ?
        AND e.kind != 'contains'
        AND tgt.file_path != ?`;
    const rows = this.db.prepare(sql).all(filePath, filePath) as Array<{ fp: string }>;
    return rows.map((r) => r.fp);
  }

  // ===========================================================================
  // 文件操作
  // ===========================================================================

  /**
   * 插入或更新文件记录
   */
  upsertFile(file: FileRecord): void {
    if (!this.stmts.upsertFile) {
      this.stmts.upsertFile = this.db.prepare(`
        INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
        VALUES (@path, @contentHash, @language, @size, @modifiedAt, @indexedAt, @nodeCount, @errors)
        ON CONFLICT(path) DO UPDATE SET
          content_hash = @contentHash,
          language = @language,
          size = @size,
          modified_at = @modifiedAt,
          indexed_at = @indexedAt,
          node_count = @nodeCount,
          errors = @errors
      `);
    }

    this.stmts.upsertFile.run({
      path: file.path,
      contentHash: file.contentHash,
      language: file.language,
      size: file.size,
      modifiedAt: file.modifiedAt,
      indexedAt: file.indexedAt,
      nodeCount: file.nodeCount,
      errors: file.errors ? JSON.stringify(file.errors) : null,
    });
  }

  /**
   * 删除文件记录及其节点
   */
  deleteFile(filePath: string): void {
    this.db.transaction(() => {
      this.deleteNodesByFile(filePath);
      if (!this.stmts.deleteFile) {
        this.stmts.deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
      }
      this.stmts.deleteFile.run(filePath);
    })();
  }

  /**
   * 按路径获取文件记录
   */
  getFileByPath(filePath: string): FileRecord | null {
    if (!this.stmts.getFileByPath) {
      this.stmts.getFileByPath = this.db.prepare('SELECT * FROM files WHERE path = ?');
    }
    const row = this.stmts.getFileByPath.get(filePath) as FileRow | undefined;
    return row ? rowToFileRecord(row) : null;
  }

  /**
   * 获取所有已追踪文件
   */
  getAllFiles(): FileRecord[] {
    if (!this.stmts.getAllFiles) {
      this.stmts.getAllFiles = this.db.prepare('SELECT * FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFiles.all() as FileRow[];
    return rows.map(rowToFileRecord);
  }

  /**
   * 所有已追踪文件中最近一次索引时间戳（自 epoch 起的毫秒数），
   * 若尚无任何索引则为 null。单次聚合查询，无需逐行扫描。（#329）
   */
  getLastIndexedAt(): number | null {
    const row = this.db
      .prepare('SELECT MAX(indexed_at) AS last FROM files')
      .get() as { last: number | null } | undefined;
    return row?.last ?? null;
  }

  /**
   * 获取需要重新索引的文件（哈希值已变更）
   */
  getStaleFiles(currentHashes: Map<string, string>): FileRecord[] {
    const files = this.getAllFiles();
    return files.filter((f) => {
      const currentHash = currentHashes.get(f.path);
      return currentHash && currentHash !== f.contentHash;
    });
  }

  // ===========================================================================
  // 未解析引用
  // ===========================================================================

  /**
   * 插入未解析引用
   */
  insertUnresolvedRef(ref: UnresolvedReference): void {
    if (!this.stmts.insertUnresolved) {
      this.stmts.insertUnresolved = this.db.prepare(`
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
        VALUES (@fromNodeId, @referenceName, @referenceKind, @line, @col, @candidates, @filePath, @language)
      `);
    }

    this.stmts.insertUnresolved.run({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      col: ref.column,
      candidates: ref.candidates ? JSON.stringify(ref.candidates) : null,
      filePath: ref.filePath ?? '',
      language: ref.language ?? 'unknown',
    });
  }

  /**
   * 在事务中批量插入未解析引用
   */
  insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void {
    if (refs.length === 0) return;
    const insert = this.db.transaction(() => {
      for (const ref of refs) {
        this.insertUnresolvedRef(ref);
      }
    });
    insert();
  }

  /**
   * 从节点删除未解析引用
   */
  deleteUnresolvedByNode(nodeId: string): void {
    if (!this.stmts.deleteUnresolvedByNode) {
      this.stmts.deleteUnresolvedByNode = this.db.prepare(
        'DELETE FROM unresolved_refs WHERE from_node_id = ?'
      );
    }
    this.stmts.deleteUnresolvedByNode.run(nodeId);
  }

  /**
   * 按名称获取未解析引用（用于解析）
   */
  getUnresolvedByName(name: string): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedByName) {
      this.stmts.getUnresolvedByName = this.db.prepare(
        'SELECT * FROM unresolved_refs WHERE reference_name = ?'
      );
    }
    const rows = this.stmts.getUnresolvedByName.all(name) as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * 获取所有未解析引用
   */
  getUnresolvedReferences(): UnresolvedReference[] {
    const rows = this.db.prepare('SELECT * FROM unresolved_refs').all() as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * 不将未解析引用加载到内存中直接获取其计数
   */
  getUnresolvedReferencesCount(): number {
    if (!this.stmts.getUnresolvedCount) {
      this.stmts.getUnresolvedCount = this.db.prepare(
        'SELECT COUNT(*) as count FROM unresolved_refs'
      );
    }
    const row = this.stmts.getUnresolvedCount.get() as { count: number };
    return row.count;
  }

  /**
   * 使用 LIMIT/OFFSET 分页获取一批未解析引用。
   * 用于在有界内存块中处理引用。
   */
  getUnresolvedReferencesBatch(offset: number, limit: number): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedBatch) {
      this.stmts.getUnresolvedBatch = this.db.prepare(
        'SELECT * FROM unresolved_refs LIMIT ? OFFSET ?'
      );
    }
    const rows = this.stmts.getUnresolvedBatch.all(limit, offset) as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * 获取所有已追踪文件路径（轻量级——不含完整 FileRecord 对象）
   */
  getAllFilePaths(): string[] {
    if (!this.stmts.getAllFilePaths) {
      this.stmts.getAllFilePaths = this.db.prepare('SELECT path FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFilePaths.all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /**
   * 获取所有不同节点名称（轻量级——仅名称字符串，用于预过滤）
   */
  getAllNodeNames(): string[] {
    if (!this.stmts.getAllNodeNames) {
      this.stmts.getAllNodeNames = this.db.prepare('SELECT DISTINCT name FROM nodes');
    }
    const rows = this.stmts.getAllNodeNames.all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /**
   * 获取限定于特定文件路径的未解析引用。
   * 使用 idx_unresolved_file_path 索引进行高效查找。
   */
  getUnresolvedReferencesByFiles(filePaths: string[]): UnresolvedReference[] {
    if (filePaths.length === 0) return [];

    // 在 SQLite 参数限制下分块：非常大的仓库首次同步时
    // 会将每个变更文件传入此处，若不限制 `IN (...)` 会绑定
    // 超过 MAX_VARIABLE_NUMBER 的参数，以"too many SQL variables"终止。（#540）
    const rows: UnresolvedRefRow[] = [];
    for (let i = 0; i < filePaths.length; i += SQLITE_PARAM_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + SQLITE_PARAM_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const chunkRows = this.db
        .prepare(`SELECT * FROM unresolved_refs WHERE file_path IN (${placeholders})`)
        .all(...chunk) as UnresolvedRefRow[];
      rows.push(...chunkRows);
    }

    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * 删除所有未解析引用（解析后调用）
   */
  clearUnresolvedReferences(): void {
    this.db.exec('DELETE FROM unresolved_refs');
  }

  /**
   * 按 ID 删除已解析的引用
   */
  deleteResolvedReferences(fromNodeIds: string[]): void {
    if (fromNodeIds.length === 0) return;
    const placeholders = fromNodeIds.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM unresolved_refs WHERE from_node_id IN (${placeholders})`).run(...fromNodeIds);
  }

  /**
   * 按（fromNodeId, referenceName, referenceKind）元组删除特定已解析引用。
   * 比 deleteResolvedReferences 更精确——只移除真正已解析的引用。
   */
  deleteSpecificResolvedReferences(refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>): void {
    if (refs.length === 0) return;
    const stmt = this.db.prepare(
      'DELETE FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ?'
    );
    const deleteMany = this.db.transaction((items: typeof refs) => {
      for (const ref of items) {
        stmt.run(ref.fromNodeId, ref.referenceName, ref.referenceKind);
      }
    });
    deleteMany(refs);
  }

  // ===========================================================================
  // 统计
  // ===========================================================================

  /**
   * 轻量级（nodes、edges）计数快照。用于索引/同步运行前后，
   * 计算提取 + 解析 + 合成的真实增量——
   * orchestrator 中的各阶段计数器只能看到提取阶段的贡献，
   * 这就是为什么 CLI 汇总少报了边数（解析 + 合成器边不可见）。
   */
  getNodeAndEdgeCount(): { nodes: number; edges: number } {
    return this.db
      .prepare('SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM edges) AS edges')
      .get() as { nodes: number; edges: number };
  }

  /**
   * 获取图统计信息
   */
  getStats(): GraphStats {
    // 单次查询获取所有三个聚合计数
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT COUNT(*) FROM files) AS file_count
    `).get() as { node_count: number; edge_count: number; file_count: number };

    const nodesByKind = {} as Record<NodeKind, number>;
    const nodeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of nodeKindRows) {
      nodesByKind[row.kind as NodeKind] = row.count;
    }

    const edgesByKind = {} as Record<EdgeKind, number>;
    const edgeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM edges GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of edgeKindRows) {
      edgesByKind[row.kind as EdgeKind] = row.count;
    }

    const filesByLanguage = {} as Record<Language, number>;
    const languageRows = this.db
      .prepare('SELECT language, COUNT(*) as count FROM files GROUP BY language')
      .all() as Array<{ language: string; count: number }>;
    for (const row of languageRows) {
      filesByLanguage[row.language as Language] = row.count;
    }

    return {
      nodeCount: counts.node_count,
      edgeCount: counts.edge_count,
      fileCount: counts.file_count,
      nodesByKind,
      edgesByKind,
      filesByLanguage,
      dbSizeBytes: 0, // 由调用方通过 DatabaseConnection.getSize() 设置
      lastUpdated: Date.now(),
    };
  }

  // ===========================================================================
  // 项目元数据
  // ===========================================================================

  /**
   * 按键获取元数据值
   */
  getMetadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * 设置元数据键值对（upsert）
   */
  setMetadata(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, value, Date.now());
  }

  /**
   * 以键值记录形式获取所有元数据
   */
  getAllMetadata(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM project_metadata').all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  /**
   * 清除数据库中的所有数据
   */
  clear(): void {
    this.nodeCache.clear();
    this.db.transaction(() => {
      this.db.exec('DELETE FROM unresolved_refs');
      this.db.exec('DELETE FROM edges');
      this.db.exec('DELETE FROM nodes');
      this.db.exec('DELETE FROM files');
    })();
  }
}
