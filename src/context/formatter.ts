/**
 * 上下文格式化器
 *
 * 将 TaskContext 格式化为 markdown 或 JSON，供 Claude 消费。
 */

import { Node, Edge, TaskContext, Subgraph } from '../types';
import { isGeneratedFile } from '../extraction/generated-detection';

/**
 * 将上下文格式化为 markdown
 *
 * 生成一份针对 Claude 优化的紧凑 markdown 文档，尽量减少上下文占用：
 * - 简短摘要
 * - 带位置信息的入口点
 * - 仅对关键符号生成代码块
 */
export function formatContextAsMarkdown(context: TaskContext): string {
  const lines: string[] = [];

  // 带查询的标题
  lines.push('## Code Context\n');
  lines.push(`**Query:** ${context.query}\n`);

  // 入口点——紧凑格式。重新排序，使生成文件（.pb.go、
  // .pulsar.go、mock 等）排在最后——流程查询应以手写实现为主，
  // 而非 protobuf 脚手架。
  const orderedEntries = [...context.entryPoints].sort((a, b) => {
    const aGen = isGeneratedFile(a.filePath) ? 1 : 0;
    const bGen = isGeneratedFile(b.filePath) ? 1 : 0;
    return aGen - bGen;
  });
  if (orderedEntries.length > 0) {
    lines.push('### Entry Points\n');
    for (const node of orderedEntries) {
      const location = node.startLine ? `:${node.startLine}` : '';
      lines.push(`- **${node.name}** (${node.kind}) - ${node.filePath}${location}`);
      if (node.signature) {
        lines.push(`  \`${node.signature}\``);
      }
    }
    lines.push('');
  }

  // 相关符号——紧凑列表（跳过冗长的结构树）。过滤掉生成源文件
  // （`.pb.go` / `.pulsar.go` / mock 等）中的节点——追踪流程的智能体
  // 从不需要跳转到 protobuf 脚手架（cosmos-Q3 曾在"相关符号"中
  // 列出 `gov.pulsar.go::GetExpeditedThreshold` 和 `1.pulsar.go::Get`，
  // 纯粹是噪音，占用了真实流程条目的位置）。
  const otherSymbols = Array.from(context.subgraph.nodes.values())
    .filter(n => !context.entryPoints.some(e => e.id === n.id))
    .filter(n => !isGeneratedFile(n.filePath))
    .slice(0, 10); // 最多显示 10 个相关符号

  if (otherSymbols.length > 0) {
    lines.push('### Related Symbols\n');
    const byFile = new Map<string, Node[]>();
    for (const node of otherSymbols) {
      const existing = byFile.get(node.filePath) || [];
      existing.push(node);
      byFile.set(node.filePath, existing);
    }

    for (const [file, nodes] of byFile) {
      const nodeList = nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
      lines.push(`- ${file}: ${nodeList}`);
    }
    lines.push('');
  }

  // 代码块——仅针对关键入口点。重新排序，使非生成块优先显示
  // （与上方入口点重排序保持一致）。
  if (context.codeBlocks.length > 0) {
    const orderedBlocks = [...context.codeBlocks].sort((a, b) => {
      const aGen = isGeneratedFile(a.filePath) ? 1 : 0;
      const bGen = isGeneratedFile(b.filePath) ? 1 : 0;
      return aGen - bGen;
    });
    lines.push('### Code\n');
    for (const block of orderedBlocks) {
      const nodeName = block.node?.name ?? 'Unknown';
      lines.push(`#### ${nodeName} (${block.filePath}:${block.startLine})\n`);
      lines.push('```' + block.language);
      lines.push(block.content);
      lines.push('```\n');
    }
  }

  return lines.join('\n');
}

/**
 * 将上下文格式化为 JSON
 *
 * 返回适合程序化使用的结构化 JSON 表示。
 */
export function formatContextAsJson(context: TaskContext): string {
  // 将 Map 转换为数组以便 JSON 序列化
  const serializable = {
    query: context.query,
    summary: context.summary,
    entryPoints: context.entryPoints.map(serializeNode),
    nodes: Array.from(context.subgraph.nodes.values()).map(serializeNode),
    edges: context.subgraph.edges.map(serializeEdge),
    codeBlocks: context.codeBlocks.map((block) => ({
      filePath: block.filePath,
      startLine: block.startLine,
      endLine: block.endLine,
      language: block.language,
      content: block.content,
      nodeName: block.node?.name,
      nodeKind: block.node?.kind,
    })),
    relatedFiles: context.relatedFiles,
    stats: context.stats,
  };

  return JSON.stringify(serializable, null, 2);
}

/**
 * 将子图格式化为 ASCII 树结构
 */
export function formatSubgraphTree(subgraph: Subgraph, entryPoints: Node[]): string {
  const lines: string[] = [];
  const printed = new Set<string>();

  // 构建出边邻接表
  const outgoing = new Map<string, Edge[]>();
  for (const edge of subgraph.edges) {
    const existing = outgoing.get(edge.source) ?? [];
    existing.push(edge);
    outgoing.set(edge.source, existing);
  }

  // 将每个入口点作为树的根节点输出
  for (const entry of entryPoints) {
    formatNodeTree(entry, subgraph, outgoing, printed, lines, 0, '');
    lines.push(''); // 树之间留空行
  }

  // 输出未从入口点可达的其余节点
  const remaining: Node[] = [];
  for (const node of subgraph.nodes.values()) {
    if (!printed.has(node.id)) {
      remaining.push(node);
    }
  }

  if (remaining.length > 0 && remaining.length <= 10) {
    lines.push('Other relevant symbols:');
    for (const node of remaining) {
      const location = node.startLine ? `:${node.startLine}` : '';
      lines.push(`  ${node.kind}: ${node.name} (${node.filePath}${location})`);
    }
  } else if (remaining.length > 10) {
    lines.push(`... and ${remaining.length} more related symbols`);
  }

  return lines.join('\n').trim();
}

/**
 * 格式化单个节点及其关系
 */
function formatNodeTree(
  node: Node,
  subgraph: Subgraph,
  outgoing: Map<string, Edge[]>,
  printed: Set<string>,
  lines: string[],
  depth: number,
  prefix: string
): void {
  if (printed.has(node.id)) {
    return;
  }
  printed.add(node.id);

  // 节点标题
  const location = node.startLine ? `:${node.startLine}` : '';
  const signature = node.signature ? ` - ${truncate(node.signature, 50)}` : '';
  lines.push(`${prefix}${node.kind}: ${node.name} (${node.filePath}${location})${signature}`);

  // 出边
  const edges = outgoing.get(node.id) ?? [];
  const significantEdges = edges.filter((e) =>
    ['calls', 'extends', 'implements', 'imports', 'references'].includes(e.kind)
  );

  // 按类型分组
  const edgesByKind = new Map<string, Edge[]>();
  for (const edge of significantEdges) {
    const existing = edgesByKind.get(edge.kind) ?? [];
    existing.push(edge);
    edgesByKind.set(edge.kind, existing);
  }

  // 按类型分组输出边
  const newPrefix = prefix + '  ';
  for (const [kind, kindEdges] of edgesByKind) {
    if (kindEdges.length > 3) {
      // 数量过多时汇总显示
      const names = kindEdges
        .slice(0, 3)
        .map((e) => {
          const target = subgraph.nodes.get(e.target);
          return target?.name ?? 'unknown';
        })
        .join(', ');
      lines.push(`${newPrefix}├── ${kind}: ${names} and ${kindEdges.length - 3} more`);
    } else {
      for (let i = 0; i < kindEdges.length; i++) {
        const edge = kindEdges[i]!;
        const target = subgraph.nodes.get(edge.target);
        const targetName = target?.name ?? 'unknown';
        const connector = i === kindEdges.length - 1 ? '└──' : '├──';
        lines.push(`${newPrefix}${connector} ${kind} → ${targetName}`);
      }
    }
  }

  // 对直接相连的节点递归处理（限制深度）
  if (depth < 1) {
    for (const edge of significantEdges.slice(0, 3)) {
      const target = subgraph.nodes.get(edge.target);
      if (target && !printed.has(target.id)) {
        formatNodeTree(target, subgraph, outgoing, printed, lines, depth + 1, newPrefix);
      }
    }
  }
}

/**
 * 将节点序列化为 JSON 输出
 */
function serializeNode(node: Node): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    signature: node.signature,
    docstring: node.docstring,
    visibility: node.visibility,
    isExported: node.isExported,
    isAsync: node.isAsync,
    isStatic: node.isStatic,
  };
}

/**
 * 将边序列化为 JSON 输出
 */
function serializeEdge(edge: Edge): Record<string, unknown> {
  return {
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    line: edge.line,
    column: edge.column,
  };
}

/**
 * 截断字符串并加省略号
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * 将字节数格式化为人类可读的字符串
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
