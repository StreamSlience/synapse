/**
 * 图遍历算法
 *
 * 代码知识图的 BFS 和 DFS 遍历。
 */

import { Node, Edge, Subgraph, TraversalOptions, EdgeKind } from '../types';
import { QueryBuilder } from '../db/queries';

/**
 * 默认遍历选项
 */
const DEFAULT_OPTIONS: Required<TraversalOptions> = {
  maxDepth: Infinity,
  edgeKinds: [],
  nodeKinds: [],
  direction: 'outgoing',
  limit: 1000,
  includeStart: true,
};

/**
 * 单次遍历步骤的结果
 */
interface TraversalStep {
  node: Node;
  edge: Edge | null;
  depth: number;
}

/**
 * 用于 BFS 和 DFS 遍历的图遍历器
 */
export class GraphTraverser {
  private queries: QueryBuilder;

  constructor(queries: QueryBuilder) {
    this.queries = queries;
  }

  /**
   * 使用广度优先搜索遍历图
   *
   * @param startId - 起始节点 ID
   * @param options - 遍历选项
   * @returns 包含已遍历节点和边的子图
   */
  traverseBFS(startId: string, options: TraversalOptions = {}): Subgraph {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startNode = this.queries.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();
    const queue: TraversalStep[] = [{ node: startNode, edge: null, depth: 0 }];

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    while (queue.length > 0 && nodes.size < opts.limit) {
      const step = queue.shift()!;
      const { node, edge, depth } = step;

      if (visited.has(node.id)) {
        continue;
      }
      visited.add(node.id);

      // 将边加入结果
      if (edge) {
        edges.push(edge);
      }

      // 检查深度限制
      if (depth >= opts.maxDepth) {
        continue;
      }

      // 获取相邻边，优先处理结构性边（contains、calls），
      // 再处理引用边，使 BFS 先发现内部结构，然后再扩散到外部引用
      // （如模板中的组件用法）。
      const adjacentEdges = this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);
      adjacentEdges.sort((a, b) => {
        const priority = (e: Edge) => e.kind === 'contains' ? 0 : e.kind === 'calls' ? 1 : 2;
        return priority(a) - priority(b);
      });

      // 批量获取未访问的邻居节点，一次查询完成（原来每个 BFS 步骤都是 N+1 次）。
      const wantIds = adjacentEdges
        .map((e) => (e.source === node.id ? e.target : e.source))
        .filter((id) => !visited.has(id));
      const neighborNodes = wantIds.length > 0 ? this.queries.getNodesByIds(wantIds) : new Map();

      for (const adjEdge of adjacentEdges) {
        const nextNodeId = adjEdge.source === node.id ? adjEdge.target : adjEdge.source;
        if (visited.has(nextNodeId)) continue;

        const nextNode = neighborNodes.get(nextNodeId);
        if (!nextNode) continue;

        if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
          continue;
        }

        nodes.set(nextNode.id, nextNode);
        queue.push({ node: nextNode, edge: adjEdge, depth: depth + 1 });
      }
    }

    return {
      nodes,
      edges,
      roots: [startId],
    };
  }

  /**
   * 使用深度优先搜索遍历图
   *
   * @param startId - 起始节点 ID
   * @param options - 遍历选项
   * @returns 包含已遍历节点和边的子图
   */
  traverseDFS(startId: string, options: TraversalOptions = {}): Subgraph {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startNode = this.queries.getNodeById(startId);

    if (!startNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    if (opts.includeStart) {
      nodes.set(startNode.id, startNode);
    }

    this.dfsRecursive(startNode, 0, opts, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [startId],
    };
  }

  /**
   * DFS 递归辅助函数
   */
  private dfsRecursive(
    node: Node,
    depth: number,
    opts: Required<TraversalOptions>,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): void {
    if (visited.has(node.id) || nodes.size >= opts.limit || depth >= opts.maxDepth) {
      return;
    }

    visited.add(node.id);

    // 获取相邻边
    const adjacentEdges = this.getAdjacentEdges(node.id, opts.direction, opts.edgeKinds);

    // 批量获取未访问的邻居节点（原来每个 DFS 步骤都是 N+1 次）。
    const wantIds = adjacentEdges
      .map((e) => (e.source === node.id ? e.target : e.source))
      .filter((id) => !visited.has(id));
    const neighborNodes = wantIds.length > 0 ? this.queries.getNodesByIds(wantIds) : new Map();

    for (const edge of adjacentEdges) {
      const nextNodeId = edge.source === node.id ? edge.target : edge.source;
      if (visited.has(nextNodeId)) continue;

      const nextNode = neighborNodes.get(nextNodeId);
      if (!nextNode) continue;

      // 应用节点类型过滤器
      if (opts.nodeKinds && opts.nodeKinds.length > 0 && !opts.nodeKinds.includes(nextNode.kind)) {
        continue;
      }

      // 将节点和边加入结果
      nodes.set(nextNode.id, nextNode);
      edges.push(edge);

      // 递归
      this.dfsRecursive(nextNode, depth + 1, opts, nodes, edges, visited);
    }
  }

  /**
   * 根据方向获取相邻边
   */
  private getAdjacentEdges(
    nodeId: string,
    direction: 'outgoing' | 'incoming' | 'both',
    edgeKinds?: EdgeKind[]
  ): Edge[] {
    const kinds = edgeKinds && edgeKinds.length > 0 ? edgeKinds : undefined;

    if (direction === 'outgoing') {
      return this.queries.getOutgoingEdges(nodeId, kinds);
    } else if (direction === 'incoming') {
      return this.queries.getIncomingEdges(nodeId, kinds);
    } else {
      // 双向
      const outgoing = this.queries.getOutgoingEdges(nodeId, kinds);
      const incoming = this.queries.getIncomingEdges(nodeId, kinds);
      return [...outgoing, ...incoming];
    }
  }

  /**
   * 查找函数/方法的所有调用者
   *
   * @param nodeId - 函数/方法节点的 ID
   * @param maxDepth - 最大遍历深度（默认：1）
   * @returns 调用此函数的节点数组
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    const result: Array<{ node: Node; edge: Edge }> = [];
    const visited = new Set<string>();

    this.getCallersRecursive(nodeId, maxDepth, 0, result, visited);

    return result;
  }

  private getCallersRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    result: Array<{ node: Node; edge: Edge }>,
    visited: Set<string>
  ): void {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    // `instantiates` 视为调用者：构造一个类（`Foo(...)` /
    // `new Foo()`）就是调用其构造函数，因此实例化位置是该类的调用者。
    // 没有它，`callers <Class>` 只会呈现导入该类的文件（通过 `imports`），
    // 而遗漏每一个构造位置——与"我改这个类会影响什么？"的目的完全相反（#774）。
    const incomingEdges = this.queries.getIncomingEdges(nodeId, ['calls', 'references', 'imports', 'instantiates']);
    if (incomingEdges.length === 0) return;

    // 一次批量获取所有调用者节点，而非每条边调用一次
    // getNodeById（原来是 N+1——在有很多调用者的函数上影响显著）。
    const sourceIds = incomingEdges.map((e) => e.source);
    const callerNodes = this.queries.getNodesByIds(sourceIds);

    for (const edge of incomingEdges) {
      const callerNode = callerNodes.get(edge.source);
      if (callerNode && !visited.has(callerNode.id)) {
        result.push({ node: callerNode, edge });
        this.getCallersRecursive(callerNode.id, maxDepth, currentDepth + 1, result, visited);
      }
    }
  }

  /**
   * 查找函数调用的所有函数/方法
   *
   * @param nodeId - 函数/方法节点的 ID
   * @param maxDepth - 最大遍历深度（默认：1）
   * @returns 此函数调用的节点数组
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    const result: Array<{ node: Node; edge: Edge }> = [];
    const visited = new Set<string>();

    this.getCalleesRecursive(nodeId, maxDepth, 0, result, visited);

    return result;
  }

  private getCalleesRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    result: Array<{ node: Node; edge: Edge }>,
    visited: Set<string>
  ): void {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    // 与 getCallers 对称：构造了某个类的函数
    // （`Foo(...)` / `new Foo()`）将该类视为被调用者，从而使
    // 调用者与被调用者互为逆关系，`trace` 可以跨越实例化边界
    // （函数 → 类 → 其方法）（#774）。
    const outgoingEdges = this.queries.getOutgoingEdges(nodeId, ['calls', 'references', 'imports', 'instantiates']);
    if (outgoingEdges.length === 0) return;

    // 批量获取被调用者节点（原来是 N+1——参见 getCallersRecursive 注释）。
    const targetIds = outgoingEdges.map((e) => e.target);
    const calleeNodes = this.queries.getNodesByIds(targetIds);

    for (const edge of outgoingEdges) {
      const calleeNode = calleeNodes.get(edge.target);
      if (calleeNode && !visited.has(calleeNode.id)) {
        result.push({ node: calleeNode, edge });
        this.getCalleesRecursive(calleeNode.id, maxDepth, currentDepth + 1, result, visited);
      }
    }
  }

  /**
   * 获取函数的调用图（调用者和被调用者）
   *
   * @param nodeId - 函数/方法节点的 ID
   * @param depth - 每个方向的最大深度（默认：2）
   * @returns 包含调用图的子图
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    const focalNode = this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];

    // 添加焦点节点
    nodes.set(focalNode.id, focalNode);

    // 获取调用者
    const callers = this.getCallers(nodeId, depth);
    for (const { node, edge } of callers) {
      nodes.set(node.id, node);
      edges.push(edge);
    }

    // 获取被调用者
    const callees = this.getCallees(nodeId, depth);
    for (const { node, edge } of callees) {
      nodes.set(node.id, node);
      edges.push(edge);
    }

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  /**
   * 获取类/接口的类型层次结构
   *
   * @param nodeId - 类/接口节点的 ID
   * @returns 包含类型层次结构的子图
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    const focalNode = this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    // 添加焦点节点
    nodes.set(focalNode.id, focalNode);

    // 获取祖先（此节点继承/实现的内容）
    this.getTypeAncestors(nodeId, nodes, edges, visited);

    // 获取后代（继承/实现此节点的内容）
    this.getTypeDescendants(nodeId, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  private getTypeAncestors(
    nodeId: string,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): void {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const outgoingEdges = this.queries.getOutgoingEdges(nodeId, ['extends', 'implements']);
    if (outgoingEdges.length === 0) return;
    const parents = this.queries.getNodesByIds(outgoingEdges.map((e) => e.target));

    for (const edge of outgoingEdges) {
      const parentNode = parents.get(edge.target);
      if (parentNode && !nodes.has(parentNode.id)) {
        nodes.set(parentNode.id, parentNode);
        edges.push(edge);
        this.getTypeAncestors(parentNode.id, nodes, edges, visited);
      }
    }
  }

  private getTypeDescendants(
    nodeId: string,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): void {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const incomingEdges = this.queries.getIncomingEdges(nodeId, ['extends', 'implements']);
    if (incomingEdges.length === 0) return;
    const children = this.queries.getNodesByIds(incomingEdges.map((e) => e.source));

    for (const edge of incomingEdges) {
      const childNode = children.get(edge.source);
      if (childNode && !nodes.has(childNode.id)) {
        nodes.set(childNode.id, childNode);
        edges.push(edge);
        this.getTypeDescendants(childNode.id, nodes, edges, visited);
      }
    }
  }

  /**
   * 查找符号的所有用法
   *
   * @param nodeId - 符号节点的 ID
   * @returns 引用此符号的节点和边数组
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    const result: Array<{ node: Node; edge: Edge }> = [];

    // 获取所有入边（references、calls、type_of 等）
    const incomingEdges = this.queries.getIncomingEdges(nodeId);
    if (incomingEdges.length === 0) return result;

    // 批量获取源节点（原来是 N+1）。
    const sources = this.queries.getNodesByIds(incomingEdges.map((e) => e.source));
    for (const edge of incomingEdges) {
      const sourceNode = sources.get(edge.source);
      if (sourceNode) result.push({ node: sourceNode, edge });
    }

    return result;
  }

  /**
   * 计算节点的影响半径
   *
   * 返回所有可能受此节点变更影响的节点。
   *
   * @param nodeId - 节点的 ID
   * @param maxDepth - 最大遍历深度（默认：3）
   * @returns 包含可能受影响节点的子图
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    const focalNode = this.queries.getNodeById(nodeId);
    if (!focalNode) {
      return { nodes: new Map(), edges: [], roots: [] };
    }

    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const visited = new Set<string>();

    // 添加焦点节点
    nodes.set(focalNode.id, focalNode);

    // 遍历入边以找到所有依赖项
    this.getImpactRecursive(nodeId, maxDepth, 0, nodes, edges, visited);

    return {
      nodes,
      edges,
      roots: [nodeId],
    };
  }

  private getImpactRecursive(
    nodeId: string,
    maxDepth: number,
    currentDepth: number,
    nodes: Map<string, Node>,
    edges: Edge[],
    visited: Set<string>
  ): void {
    if (currentDepth >= maxDepth || visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    // 对于容器节点（类、接口、结构体等），同时遍历其子节点，
    // 使包含方法的调用者也出现在影响半径中
    const focalNode = this.queries.getNodeById(nodeId);
    if (focalNode) {
      const containerKinds = new Set(['class', 'interface', 'struct', 'trait', 'protocol', 'module', 'enum']);
      if (containerKinds.has(focalNode.kind)) {
        const containsEdges = this.queries.getOutgoingEdges(nodeId, ['contains']);
        if (containsEdges.length > 0) {
          const children = this.queries.getNodesByIds(containsEdges.map((e) => e.target));
          for (const edge of containsEdges) {
            const childNode = children.get(edge.target);
            if (childNode && !visited.has(childNode.id)) {
              nodes.set(childNode.id, childNode);
              edges.push(edge);
              // 以相同深度递归遍历子节点（它们属于同一符号）
              this.getImpactRecursive(childNode.id, maxDepth, currentDepth, nodes, edges, visited);
            }
          }
        }
      }
    }

    // 获取所有入边（依赖此节点的内容）。排除
    // `contains`：容器"包含"其成员但并不*依赖*它们，
    // 因此向上追踪会爬到父类，然后重新展开每个兄弟成员——
    // 导致叶符号的影响半径爆炸。(#536)
    const incomingEdges = this.queries.getIncomingEdges(nodeId).filter((e) => e.kind !== 'contains');
    if (incomingEdges.length === 0) return;
    const sources = this.queries.getNodesByIds(incomingEdges.map((e) => e.source));

    for (const edge of incomingEdges) {
      const sourceNode = sources.get(edge.source);
      if (sourceNode && !nodes.has(sourceNode.id)) {
        nodes.set(sourceNode.id, sourceNode);
        edges.push(edge);
        this.getImpactRecursive(sourceNode.id, maxDepth, currentDepth + 1, nodes, edges, visited);
      }
    }
  }

  /**
   * 查找两个节点之间的最短路径
   *
   * @param fromId - 起始节点 ID
   * @param toId - 目标节点 ID
   * @param edgeKinds - 考虑的边类型（空则考虑所有类型）
   * @returns 构成路径的节点和边数组，若无路径则返回 null
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds: EdgeKind[] = []
  ): Array<{ node: Node; edge: Edge | null }> | null {
    const fromNode = this.queries.getNodeById(fromId);
    const toNode = this.queries.getNodeById(toId);

    if (!fromNode || !toNode) {
      return null;
    }

    // BFS 查找最短路径
    const visited = new Set<string>();
    const queue: Array<{ nodeId: string; path: Array<{ node: Node; edge: Edge | null }> }> = [
      { nodeId: fromId, path: [{ node: fromNode, edge: null }] },
    ];

    while (queue.length > 0) {
      const { nodeId, path } = queue.shift()!;

      if (nodeId === toId) {
        return path;
      }

      if (visited.has(nodeId)) {
        continue;
      }
      visited.add(nodeId);

      // 获取出边
      const outgoingEdges = this.queries.getOutgoingEdges(
        nodeId,
        edgeKinds.length > 0 ? edgeKinds : undefined
      );
      if (outgoingEdges.length === 0) continue;

      // 仅批量获取未访问的目标节点（原来每个 BFS 前沿都是 N+1）。
      const wantIds = outgoingEdges
        .map((e) => e.target)
        .filter((id) => !visited.has(id));
      const nextNodes = wantIds.length > 0 ? this.queries.getNodesByIds(wantIds) : new Map();

      for (const edge of outgoingEdges) {
        if (!visited.has(edge.target)) {
          const nextNode = nextNodes.get(edge.target);
          if (nextNode) {
            queue.push({
              nodeId: edge.target,
              path: [...path, { node: nextNode, edge }],
            });
          }
        }
      }
    }

    return null; // 未找到路径
  }

  /**
   * 获取节点的包含层次结构（祖先）
   *
   * @param nodeId - 节点的 ID
   * @returns 从直接父节点到根节点的祖先节点数组
   */
  getAncestors(nodeId: string): Node[] {
    const ancestors: Node[] = [];
    const visited = new Set<string>();
    let currentId = nodeId;

    while (true) {
      if (visited.has(currentId)) {
        break;
      }
      visited.add(currentId);

      // 查找指向此节点的 'contains' 边
      const containingEdges = this.queries.getIncomingEdges(currentId, ['contains']);

      const firstEdge = containingEdges[0];
      if (!firstEdge) {
        break;
      }

      // 通常最多只有一个包含父节点
      const parentNode = this.queries.getNodeById(firstEdge.source);
      if (parentNode) {
        ancestors.push(parentNode);
        currentId = parentNode.id;
      } else {
        break;
      }
    }

    return ancestors;
  }

  /**
   * 获取节点的直接子节点
   *
   * @param nodeId - 节点的 ID
   * @returns 子节点数组
   */
  getChildren(nodeId: string): Node[] {
    const containsEdges = this.queries.getOutgoingEdges(nodeId, ['contains']);
    if (containsEdges.length === 0) return [];

    // 批量获取（原来是 N+1）。
    const childNodes = this.queries.getNodesByIds(containsEdges.map((e) => e.target));
    const children: Node[] = [];
    for (const edge of containsEdges) {
      const childNode = childNodes.get(edge.target);
      if (childNode) children.push(childNode);
    }
    return children;
  }
}
