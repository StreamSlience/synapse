/**
 * 图查询函数
 *
 * 构建在遍历算法之上的高层查询函数。
 */

import { Node, Edge, Context, Subgraph, EdgeKind } from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from './traversal';

/**
 * 用于复杂查询的图查询管理器
 */
export class GraphQueryManager {
  private queries: QueryBuilder;
  private traverser: GraphTraverser;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
    this.traverser = new GraphTraverser(queries);
  }

  /**
   * 获取节点的完整上下文
   *
   * 返回焦点节点及其祖先、子节点，
   * 以及所有入边和出边引用。
   *
   * @param nodeId - 焦点节点的 ID
   * @returns 包含所有相关信息的 Context 对象
   */
  getContext(nodeId: string): Context {
    const focal = this.queries.getNodeById(nodeId);

    if (!focal) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    // 获取祖先（包含层次结构）
    const ancestors = this.traverser.getAncestors(nodeId);

    // 获取子节点
    const children = this.traverser.getChildren(nodeId);

    // 获取入边引用（引用此节点的内容）
    const incomingEdges = this.queries.getIncomingEdges(nodeId);
    const incomingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of incomingEdges) {
      // 跳过包含边（已在祖先中）
      if (edge.kind === 'contains') {
        continue;
      }
      const node = this.queries.getNodeById(edge.source);
      if (node) {
        incomingRefs.push({ node, edge });
      }
    }

    // 获取出边引用（此节点引用的内容）
    const outgoingEdges = this.queries.getOutgoingEdges(nodeId);
    const outgoingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of outgoingEdges) {
      // 跳过包含边（已在子节点中）
      if (edge.kind === 'contains') {
        continue;
      }
      const node = this.queries.getNodeById(edge.target);
      if (node) {
        outgoingRefs.push({ node, edge });
      }
    }

    // 获取类型信息（type_of、returns 边）
    const types: Node[] = [];
    const typeEdgeKinds: EdgeKind[] = ['type_of', 'returns'];
    for (const kind of typeEdgeKinds) {
      const typeEdges = this.queries.getOutgoingEdges(nodeId, [kind]);
      for (const edge of typeEdges) {
        const typeNode = this.queries.getNodeById(edge.target);
        if (typeNode && !types.some((t) => t.id === typeNode.id)) {
          types.push(typeNode);
        }
      }
    }

    // 获取相关导入
    const imports: Node[] = [];
    const fileNode = ancestors.find((a) => a.kind === 'file');
    if (fileNode) {
      const importEdges = this.queries.getOutgoingEdges(fileNode.id, ['imports']);
      for (const edge of importEdges) {
        const importNode = this.queries.getNodeById(edge.target);
        if (importNode) {
          imports.push(importNode);
        }
      }
    }

    return {
      focal,
      ancestors,
      children,
      incomingRefs,
      outgoingRefs,
      types,
      imports,
    };
  }

  /**
   * 获取文件的依赖项
   *
   * 返回此文件导入的所有文件。
   *
   * @param filePath - 文件路径
   * @returns 此文件依赖的文件路径数组
   */
  getFileDependencies(filePath: string): string[] {
    // 追踪符号级跨文件边图，而非仅追踪 `imports`：
    // 此处的 `imports` 边从文件指向其本地 import 声明（同文件），
    // 因此真正的跨文件依赖存在于已解析的
    // calls/references/instantiates/extends/... 边中。
    return this.queries.getDependencyFilePaths(filePath);
  }

  /**
   * 获取文件的依赖方
   *
   * 返回所有导入此文件的文件。
   *
   * @param filePath - 文件路径
   * @returns 依赖此文件的文件路径数组
   */
  getFileDependents(filePath: string): string[] {
    // 此前仅追踪文件节点或其导出符号的 `imports` 边，
    // 对*每个*文件都返回 0 个依赖方——因为此处的 `imports` 边
    // 将文件连接到其本地 import 声明（始终是同文件），
    // 而非提供方文件。真正的跨文件依赖信号是已解析的符号图
    // （calls/references/instantiates/extends/implements/...），
    // 这正是 blast-radius / `affected` 所需要的。委托给该图的索引投影。
    return this.queries.getDependentFilePaths(filePath);
  }

  /**
   * 获取文件导出的所有符号
   *
   * @param filePath - 文件路径
   * @returns 导出节点数组
   */
  getExportedSymbols(filePath: string): Node[] {
    const nodes = this.queries.getNodesByFile(filePath);
    return nodes.filter((n) => n.isExported);
  }

  /**
   * 通过限定名模式查找符号
   *
   * @param pattern - 匹配模式（支持 * 通配符）
   * @returns 匹配的节点数组
   */
  findByQualifiedName(pattern: string): Node[] {
    // 将 glob 模式转换为正则表达式
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);

    // 对大型图效率较低——需要在 qualified_name 上建立 FTS 索引
    // 目前如有可能先按类型过滤
    const allNodes: Node[] = [];
    const kinds: Node['kind'][] = [
      'class',
      'function',
      'method',
      'interface',
      'type_alias',
      'variable',
      'constant',
    ];

    for (const kind of kinds) {
      const nodes = this.queries.getNodesByKind(kind);
      for (const node of nodes) {
        if (regex.test(node.qualifiedName)) {
          allNodes.push(node);
        }
      }
    }

    return allNodes;
  }

  /**
   * 获取模块/包结构
   *
   * 返回按目录组织的文件树结构。
   *
   * @returns 目录路径到所含文件的映射
   */
  getModuleStructure(): Map<string, string[]> {
    const files = this.queries.getAllFiles();
    const structure = new Map<string, string[]>();

    for (const file of files) {
      const parts = file.path.split('/');
      const dir = parts.slice(0, -1).join('/') || '.';

      if (!structure.has(dir)) {
        structure.set(dir, []);
      }
      structure.get(dir)!.push(file.path);
    }

    return structure;
  }

  /**
   * 查找图中的循环依赖
   *
   * @returns 循环数组，每个循环是一个节点 ID 数组
   */
  findCircularDependencies(): string[][] {
    const files = this.queries.getAllFiles();
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (filePath: string, path: string[]): void => {
      if (recursionStack.has(filePath)) {
      // 发现循环
        const cycleStart = path.indexOf(filePath);
        if (cycleStart !== -1) {
          cycles.push(path.slice(cycleStart));
        }
        return;
      }

      if (visited.has(filePath)) {
        return;
      }

      visited.add(filePath);
      recursionStack.add(filePath);

      const dependencies = this.getFileDependencies(filePath);
      for (const dep of dependencies) {
        dfs(dep, [...path, filePath]);
      }

      recursionStack.delete(filePath);
    };

    for (const file of files) {
      if (!visited.has(file.path)) {
        dfs(file.path, []);
      }
    }

    return cycles;
  }

  /**
   * 获取节点的复杂度指标
   *
   * @param nodeId - 节点的 ID
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
    const incomingEdges = this.queries.getIncomingEdges(nodeId);
    const outgoingEdges = this.queries.getOutgoingEdges(nodeId);

    const callEdges = outgoingEdges.filter((e) => e.kind === 'calls');
    const callerEdges = incomingEdges.filter((e) => e.kind === 'calls');
    const containsEdges = outgoingEdges.filter((e) => e.kind === 'contains');

    const ancestors = this.traverser.getAncestors(nodeId);

    return {
      incomingEdgeCount: incomingEdges.length,
      outgoingEdgeCount: outgoingEdges.length,
      callCount: callEdges.length,
      callerCount: callerEdges.length,
      childCount: containsEdges.length,
      depth: ancestors.length,
    };
  }

  /**
   * 查找死代码（没有入边引用的节点）
   *
   * @param kinds - 要检查的节点类型（默认：函数、方法、类）
   * @returns 未被引用的节点数组
   */
  findDeadCode(kinds?: Node['kind'][]): Node[] {
    const targetKinds = kinds || ['function', 'method', 'class'];
    const deadCode: Node[] = [];

    for (const kind of targetKinds) {
      const nodes = this.queries.getNodesByKind(kind);
      for (const node of nodes) {
        // 跳过导出的符号（它们可能在外部被使用）
        if (node.isExported) {
          continue;
        }

        const incomingEdges = this.queries.getIncomingEdges(node.id);

        // 过滤掉包含边
        const references = incomingEdges.filter((e) => e.kind !== 'contains');

        if (references.length === 0) {
          deadCode.push(node);
        }
      }
    }

    return deadCode;
  }

  /**
   * 获取包含符合过滤条件节点的子图
   *
   * @param filter - 用于筛选节点的过滤函数
   * @param includeEdges - 是否包含匹配节点之间的边
   * @returns 包含匹配节点的子图
   */
  getFilteredSubgraph(
    filter: (node: Node) => boolean,
    includeEdges: boolean = true
  ): Subgraph {
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];

    // 获取所有常见类型的节点
    const kinds: Node['kind'][] = [
      'file',
      'module',
      'class',
      'struct',
      'interface',
      'trait',
      'function',
      'method',
      'variable',
      'constant',
      'enum',
      'type_alias',
    ];

    for (const kind of kinds) {
      const kindNodes = this.queries.getNodesByKind(kind);
      for (const node of kindNodes) {
        if (filter(node)) {
          nodes.set(node.id, node);
        }
      }
    }

    // 包含匹配节点之间的边
    if (includeEdges) {
      for (const nodeId of nodes.keys()) {
        const outgoing = this.queries.getOutgoingEdges(nodeId);
        for (const edge of outgoing) {
          if (nodes.has(edge.target)) {
            edges.push(edge);
          }
        }
      }
    }

    return {
      nodes,
      edges,
      roots: [],
    };
  }

  /**
   * 访问底层遍历器以执行直接遍历操作
   */
  getTraverser(): GraphTraverser {
    return this.traverser;
  }
}
