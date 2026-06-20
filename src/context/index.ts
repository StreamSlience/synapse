/**
 * 上下文构建器
 *
 * 结合 FTS 搜索与图遍历，为任务构建丰富的上下文。
 * 输出结构化上下文，可直接注入 Claude。
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Node,
  Edge,
  NodeKind,
  EdgeKind,
  Subgraph,
  CodeBlock,
  TaskContext,
  TaskInput,
  BuildContextOptions,
  FindRelevantContextOptions,
  SearchResult,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from '../graph';
import { formatContextAsMarkdown, formatContextAsJson } from './formatter';
import { logDebug } from '../errors';
import { validatePathWithinRoot, isConfigLeafNode } from '../utils';
import { isTestFile, extractSearchTerms, scorePathRelevance, getStemVariants, isDistinctiveIdentifier } from '../search/query-utils';
import { LOW_CONFIDENCE_MARKER } from './markers';

/**
 * 从自然语言查询中提取可能的符号名
 *
 * 使用以下模式识别潜在代码符号：
 * - CamelCase：UserService、signInWithGoogle
 * - snake_case：user_service、sign_in
 * - SCREAMING_SNAKE：MAX_RETRIES
 * - dot.notation：app.isPackaged（两侧都提取）
 * - 看起来像标识符的单词（无空格、非常见英文词）
 *
 * @param query - 自然语言查询
 * @returns 潜在符号名数组
 */
function extractSymbolsFromQuery(query: string): string[] {
  const symbols = new Set<string>();

  // 提取 CamelCase 标识符（2 个字符以上，以字母开头）
  const camelCasePattern = /\b([A-Z][a-z]+(?:[A-Z][a-z]*)*|[a-z]+(?:[A-Z][a-z]*)+)\b/g;
  let match;
  while ((match = camelCasePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 2) {
      symbols.add(match[1]);
    }
  }

  // 提取 snake_case 标识符
  const snakeCasePattern = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi;
  while ((match = snakeCasePattern.exec(query)) !== null) {
    if (match[1] && match[1].length >= 3) {
      symbols.add(match[1]);
    }
  }

  // 提取 SCREAMING_SNAKE_CASE 标识符
  const screamingPattern = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;
  while ((match = screamingPattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // 提取全大写缩写词（2 个字符以上，例如 REST、HTTP、LRU、API）
  const acronymPattern = /\b([A-Z]{2,})\b/g;
  while ((match = acronymPattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // 提取点号连接的标识符并拆分为各部分（例如 "app.isPackaged" -> ["app", "isPackaged"]）
  const dotPattern = /\b([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+)\b/g;
  while ((match = dotPattern.exec(query)) !== null) {
    if (match[1]) {
      // 同时添加完整路径和各个部分
      symbols.add(match[1]);
      const parts = match[1].split('.');
      for (const part of parts) {
        if (part.length >= 2) {
          symbols.add(part);
        }
      }
    }
  }

  // 提取纯小写标识符（3 个字符以上，且尚未匹配）
  // 可捕获如 "undo"、"redo"、"history"、"render"、"parse" 等符号名
  const lowercasePattern = /\b([a-z][a-z0-9]{2,})\b/g;
  while ((match = lowercasePattern.exec(query)) !== null) {
    if (match[1]) {
      symbols.add(match[1]);
    }
  }

  // 过滤掉不太可能是符号名的常见英文单词
  const commonWords = new Set([
    'the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'been',
    'will', 'would', 'could', 'should', 'does', 'done', 'make', 'made',
    'use', 'used', 'using', 'work', 'works', 'find', 'found', 'show',
    'call', 'called', 'calling', 'get', 'set', 'add', 'all', 'any',
    'how', 'what', 'when', 'where', 'which', 'who', 'why',
    'not', 'but', 'are', 'was', 'were', 'has', 'had', 'its',
    'can', 'did', 'may', 'also', 'into', 'than', 'then', 'them',
    'each', 'other', 'some', 'such', 'only', 'same', 'about',
    'after', 'before', 'between', 'through', 'during', 'without',
    'again', 'further', 'once', 'here', 'there', 'both', 'just',
    'more', 'most', 'very', 'being', 'having', 'doing',
    'system', 'need', 'needs', 'want', 'wants', 'like', 'look',
    'change', 'changes', 'changed', 'changing',
    // 与大量不相关代码符号匹配的常见英文名词/动词
    'layer', 'handle', 'handles', 'handling', 'incoming', 'outgoing',
    'data', 'flow', 'flows', 'level', 'levels', 'request', 'requests',
    'response', 'responses', 'implement', 'implements', 'implementation',
    'interface', 'interfaces', 'class', 'classes', 'method', 'methods',
    'trigger', 'triggers', 'affected', 'affect', 'affects',
    'else', 'code', 'failing', 'failed', 'silently', 'decide', 'decides',
    'return', 'returns', 'returned', 'take', 'takes', 'taken',
    'check', 'checks', 'checked', 'create', 'creates', 'created',
    'read', 'reads', 'write', 'writes', 'written',
    'start', 'starts', 'stop', 'stops', 'run', 'runs', 'running',
  ]);

  return Array.from(symbols).filter(s => !commonWords.has(s.toLowerCase()));
}

/**
 * 上下文构建的默认选项
 *
 * 在保证实用性的前提下，经过调优以最小化上下文消耗：
 * - 默认更少的节点和代码块
 * - 更小的代码块大小限制
 * - 更浅的图遍历深度
 */
const DEFAULT_BUILD_OPTIONS: Required<BuildContextOptions> = {
  maxNodes: 20,           // 从 50 降低——大多数任务不需要 50 个符号
  maxCodeBlocks: 5,       // 从 10 降低——仅展示最相关的代码
  maxCodeBlockSize: 1500, // 从 2000 降低
  includeCode: true,
  format: 'markdown',
  searchLimit: 3,         // 从 5 降低——减少入口点数量
  traversalDepth: 1,      // 从 2 降低——更浅的图扩展
  minScore: 0.3,
};

/**
 * 在上下文结果中具有高信息价值的节点类型。
 * 排除了导入/导出，因为它们的信息密度几乎为零——
 * 它们只说明某物存在，而不说明其工作方式。
 */
const HIGH_VALUE_NODE_KINDS: NodeKind[] = [
  'function', 'method', 'class', 'interface', 'type_alias', 'struct', 'trait',
  'component', 'route', 'variable', 'constant', 'enum', 'module', 'namespace',
];

/**
 * 查找相关上下文的默认选项
 */
const DEFAULT_FIND_OPTIONS: Required<FindRelevantContextOptions> = {
  searchLimit: 3,        // 从 5 降低
  traversalDepth: 1,     // 从 2 降低
  maxNodes: 20,          // 从 50 降低
  minScore: 0.3,
  edgeKinds: [],
  nodeKinds: HIGH_VALUE_NODE_KINDS, // 默认过滤掉导入/导出
};

// 重新导出低置信度哨兵值（定义在无依赖的叶子模块中，
// 使 MCP 层可以导入它，而不会将本模块的依赖拖入冷启动路径）。
// 下方构建器代码直接使用导入的绑定。
export { LOW_CONFIDENCE_MARKER } from './markers';

/**
 * 上下文构建器
 *
 * 协调语义搜索与图遍历，为任务构建全面的上下文。
 */
export class ContextBuilder {
  private projectRoot: string;
  private queries: QueryBuilder;
  private traverser: GraphTraverser;

  constructor(
    projectRoot: string,
    queries: QueryBuilder,
    traverser: GraphTraverser
  ) {
    this.projectRoot = projectRoot;
    this.queries = queries;
    this.traverser = traverser;
  }

  /**
   * 为任务构建上下文
   *
   * 流水线：
   * 1. 解析任务输入（字符串或 {title, description}）
   * 2. 运行语义搜索以找到入口点
   * 3. 围绕入口点扩展图
   * 4. 提取关键节点的代码块
   * 5. 为 Claude 格式化输出
   *
   * @param input - 任务描述或包含 title/description 的对象
   * @param options - 构建选项
   * @returns TaskContext（结构化对象）或格式化字符串
   */
  async buildContext(
    input: TaskInput,
    options: BuildContextOptions = {}
  ): Promise<TaskContext | string> {
    const opts = { ...DEFAULT_BUILD_OPTIONS, ...options };

    // 解析输入
    const query = typeof input === 'string' ? input : `${input.title}${input.description ? `: ${input.description}` : ''}`;

    // 查找相关上下文（语义搜索 + 图扩展）
    const subgraph = await this.findRelevantContext(query, {
      searchLimit: opts.searchLimit,
      traversalDepth: opts.traversalDepth,
      maxNodes: opts.maxNodes,
      minScore: opts.minScore,
    });

    // 获取入口点（来自语义搜索的节点）
    const entryPoints = this.getEntryPoints(subgraph);

    // 提取关键节点的代码块
    const codeBlocks = opts.includeCode
      ? await this.extractCodeBlocks(subgraph, opts.maxCodeBlocks, opts.maxCodeBlockSize)
      : [];

    // 获取相关文件
    const relatedFiles = this.getRelatedFiles(subgraph);

    // 生成摘要
    const summary = this.generateSummary(query, subgraph, entryPoints);

    // 计算统计数据
    const stats = {
      nodeCount: subgraph.nodes.size,
      edgeCount: subgraph.edges.length,
      fileCount: relatedFiles.length,
      codeBlockCount: codeBlocks.length,
      totalCodeSize: codeBlocks.reduce((sum, block) => sum + block.content.length, 0),
    };

    const context: TaskContext = {
      query,
      subgraph,
      entryPoints,
      codeBlocks,
      relatedFiles,
      summary,
      stats,
    };

    // 返回格式化输出或原始上下文
    if (opts.format === 'markdown') {
      return formatContextAsMarkdown(context)
        + this.buildCallPathsSection(subgraph)
        + (subgraph.confidence === 'low' ? this.buildLowConfidenceNote(entryPoints) : '');
    } else if (opts.format === 'json') {
      return formatContextAsJson(context);
    }

    return context;
  }

  /**
   * 当检索置信度较低时（查询主要匹配到常见词）追加的诚实衔接提示。
   * 与通常的"这已覆盖相关内容"措辞不同——那种说法一旦有误会让智能体
   * 转去 Read/Grep——此处直接承认不确定性，并将智能体引导至精确工具
   * （用真实符号名调用 explore、使用 search，或浏览我们确实找到的最近区域的文件）。
   */
  private buildLowConfidenceNote(entryPoints: Node[]): string {
    const dirs: string[] = [];
    const seen = new Set<string>();
    for (const n of entryPoints) {
      const slash = n.filePath.lastIndexOf('/');
      const dir = slash > 0 ? n.filePath.slice(0, slash) : n.filePath;
      if (!seen.has(dir)) { seen.add(dir); dirs.push(dir); }
      if (dirs.length >= 4) break;
    }
    const dirLine = dirs.length
      ? `\n- \`synapse_files\` a likely area: ${dirs.map(d => `\`${d}\``).join(', ')}`
      : '';
    return `\n\n${LOW_CONFIDENCE_MARKER}\n\n`
      + 'This query matched mostly on common words, so the entry points above may '
      + 'be off-target — treat them as a starting point, not a complete answer. '
      + 'For a reliable result:\n'
      + '- `synapse_explore` with the **exact symbol names** you are after '
      + '(class / function / method names), or\n'
      + '- `synapse_search <name>` for one specific symbol'
      + dirLine
      + '\n\nDo not assume the list above is comprehensive.';
  }

  /**
   * 在本次上下文已找到的符号中呈现短调用路径，
   * 直接从子图的 `calls` 边在内存中推导（无需额外查询）。
   *
   * 这将路径查找的价值内嵌到始终加载的 `context` 工具中。
   * 智能体能可靠地读取 context 的输出，但不会发现/采用独立的 trace 工具
   * （在延迟加载 MCP 的环境中，它们只会 ToolSearch 已知工具）。
   * 在此交付流程意味着"X 如何到达 Y"无需智能体寻找、加载或选择新工具即可作答。
   * 调用链在静态调用图结束处截断（例如动态分发）——
   * 该截断是诚实的，智能体可用 synapse_node 在最后一跳处桥接。
   */
  private buildCallPathsSection(subgraph: Subgraph): string {
    const adj = new Map<string, string[]>();
    for (const e of subgraph.edges) {
      if (e.kind !== 'calls') continue;
      if (!subgraph.nodes.has(e.source) || !subgraph.nodes.has(e.target)) continue;
      const list = adj.get(e.source);
      if (list) list.push(e.target);
      else adj.set(e.source, [e.target]);
    }
    if (adj.size === 0) return '';

    const MAX_HOPS = 6;
    const chains: string[][] = [];
    let budget = 2000; // 限制 DFS 在稠密子图上的工作量
    const dfs = (id: string, path: string[], seen: Set<string>): void => {
      if (budget-- <= 0) return;
      const next = (adj.get(id) ?? []).filter((t) => !seen.has(t));
      if (next.length === 0 || path.length >= MAX_HOPS) {
        if (path.length >= 3) chains.push([...path]); // >=3 个节点 = 真实的流程，而非单次调用
        return;
      }
      for (const t of next) {
        seen.add(t);
        dfs(t, [...path, t], seen);
        seen.delete(t);
      }
    };
    const starts = (subgraph.roots.length > 0
      ? subgraph.roots.filter((id) => adj.has(id))
      : [...adj.keys()]
    ).slice(0, 5);
    for (const s of starts) dfs(s, [s], new Set([s]));
    if (chains.length === 0) return '';

    // 仅保留连接两个或更多与查询相关符号（根节点）的链。
    // 从根节点到任意被调用者（render → onMagicFrameGenerate）的链在结构上有效，
    // 但与问题关联不大；要求 ≥2 个根节点可让链锚定在用户真正关心的内容上。
    // 按根节点数量再按长度排名，并丢弃较长保留链的子路径。
    const rootSet = new Set(subgraph.roots);
    const rootCount = (c: string[]): number => c.reduce((n, id) => n + (rootSet.has(id) ? 1 : 0), 0);
    const relevant = chains.filter((c) => rootCount(c) >= 2);
    relevant.sort((a, b) => rootCount(b) - rootCount(a) || b.length - a.length);
    const kept: string[][] = [];
    for (const c of relevant) {
      const key = c.join('>');
      if (kept.some((k) => k.join('>').includes(key))) continue;
      kept.push(c);
      if (kept.length >= 3) break;
    }
    if (kept.length === 0) return '';
    const name = (id: string): string => subgraph.nodes.get(id)?.name ?? id;

    // 合成（动态分发）跳转是真实的 `calls` 边，但对静态解析不可见——
    // 将其内联标注，让智能体看到回调在哪里连线（`registered @file:line`），
    // 而无需 grep 搜索。以 "source>target" 为键。
    const synthByPair = new Map<string, string>();
    for (const e of subgraph.edges) {
      if (e.kind !== 'calls' || e.provenance !== 'heuristic') continue;
      const m = e.metadata as Record<string, unknown> | undefined;
      if (!m?.synthesizedBy) continue;
      const at = typeof m.registeredAt === 'string' ? ` @${m.registeredAt}` : '';
      const label = m.synthesizedBy === 'callback'
        ? `callback via ${m.via ? `\`${String(m.via)}\`` : 'registrar'}${at}`
        : m.synthesizedBy === 'react-render'
        ? `React re-render via setState${at}`
        : m.synthesizedBy === 'jsx-render'
        ? `renders <${String(m.via || 'child')}>`
        : m.synthesizedBy === 'vue-handler'
        ? `Vue @${String(m.event || 'event')} handler`
        : `event ${m.event ? `\`${String(m.event)}\`` : ''}${at}`;
      synthByPair.set(`${e.source}>${e.target}`, label);
    }
    const renderChain = (c: string[]): string => {
      let s = name(c[0]!);
      for (let i = 1; i < c.length; i++) {
        const synth = synthByPair.get(`${c[i - 1]}>${c[i]}`);
        s += synth ? ` →[${synth}] ${name(c[i]!)}` : ` → ${name(c[i]!)}`;
      }
      return s;
    };
    const hasSynth = kept.some((c) => c.some((_, i) => i > 0 && synthByPair.has(`${c[i - 1]}>${c[i]}`)));
    const lines = [
      '',
      '## Call paths',
      '',
      'Execution flow among the key symbols (traced through the call graph):',
      '',
      ...kept.map((c) => `- ${renderChain(c)}`),
      '',
      hasSynth
        ? '_Hops marked `[callback/event …]` are dynamic dispatch bridged by synapse (with the registration site); the rest are direct calls. synapse_node any symbol for its body._'
        : '_synapse_node any symbol above for its source + its own callers/callees._',
    ];
    return '\n' + lines.join('\n') + '\n';
  }

  /**
   * 为查询查找相关子图
   *
   * 使用混合搜索，将精确符号查找与语义搜索相结合：
   * 1. 从查询中提取潜在符号名
   * 2. 查找这些符号的精确匹配（高置信度）
   * 3. 使用语义搜索进行概念匹配
   * 4. 合并结果，优先采用精确匹配
   * 5. 从入口点遍历图
   *
   * @param query - 自然语言查询
   * @param options - 搜索和遍历选项
   * @returns 相关节点和边的子图
   */
  async findRelevantContext(
    query: string,
    options: FindRelevantContextOptions = {}
  ): Promise<Subgraph> {
    const opts = { ...DEFAULT_FIND_OPTIONS, ...options };

    // 从空子图开始
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const roots: string[] = [];

    // 处理空查询——返回空子图
    if (!query || query.trim().length === 0) {
      return { nodes, edges, roots };
    }

    // === 混合搜索 ===

    // 第 1 步：从查询中提取潜在符号名
    const symbolsFromQuery = extractSymbolsFromQuery(query);
    logDebug('Extracted symbols from query', { query, symbols: symbolsFromQuery });

    // 第 2 步：查找提取到的符号的精确匹配
    let exactMatches: SearchResult[] = [];
    if (symbolsFromQuery.length > 0) {
      try {
        // 获取更多结果，以便在截断前应用共现位置提升
        exactMatches = this.queries.findNodesByExactName(symbolsFromQuery, {
          limit: Math.ceil(opts.searchLimit * 5),
          kinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
        });

        // 共现位置提升：当多个提取到的符号出现在同一文件时，
        // 这些结果更有可能正是用户所需。
        // 例如 "scrapeLoop" + "run" 都在 scrape/scrape.go → 两者都提升。
        if (exactMatches.length > 1) {
          // 构建 文件 → 匹配到该文件的不同符号名数量 的映射
          const fileSymbolCounts = new Map<string, Set<string>>();
          for (const r of exactMatches) {
            const names = fileSymbolCounts.get(r.node.filePath) || new Set();
            names.add(r.node.name.toLowerCase());
            fileSymbolCounts.set(r.node.filePath, names);
          }
          // 对多个查询符号共现的文件中的结果进行提升
          exactMatches = exactMatches.map(r => {
            const symbolCount = fileSymbolCounts.get(r.node.filePath)?.size || 1;
            return {
              ...r,
              score: symbolCount > 1 ? r.score + (symbolCount - 1) * 20 : r.score,
            };
          });
          exactMatches.sort((a, b) => b.score - a.score);
        }

        // 截断回合理大小
        exactMatches = exactMatches.slice(0, Math.ceil(opts.searchLimit * 2));
        logDebug('Exact symbol matches', { count: exactMatches.length });
      } catch (error) {
        logDebug('Exact symbol lookup failed', { error: String(error) });
      }
    }

    // 第 2b 步：将提取到的符号作为定义（class/interface）的前缀进行搜索。
    // 当用户写 "REST"、"bulk" 或 "allocation" 时，通常指的是
    // RestController、BulkRequest、AllocationService 等类，而非同名节点。
    // 同时尝试词干变体：如 "caching" → "cache" 可找到 Cache、CacheBuilder。
    if (symbolsFromQuery.length > 0) {
      const definitionKinds: NodeKind[] = ['class', 'interface', 'struct', 'trait',
        'protocol', 'enum', 'type_alias'];
      // 用词干变体扩展符号，以进行更广泛的定义匹配
      const expandedSymbols = new Set(symbolsFromQuery);
      for (const sym of symbolsFromQuery) {
        for (const variant of getStemVariants(sym)) {
          expandedSymbols.add(variant);
        }
      }
      for (const sym of expandedSymbols) {
        // 将符号首字母大写：如 "REST" → "Rest"、"bulk" → "Bulk"、"allocation" → "Allocation"
        const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
        if (titleCased === sym) continue; // 已是首字母大写（如 "Engine"）——由精确匹配处理
        // 获取更多结果，因为常见前缀匹配数量众多
        const prefixResults = this.queries.searchNodes(titleCased, {
          limit: 30,
          kinds: definitionKinds,
        });
        const matched: SearchResult[] = [];
        for (const r of prefixResults) {
          if (r.node.name.toLowerCase().startsWith(titleCased.toLowerCase())) {
            // 偏向更短的名称：如 "AllocationService"（18 个字符）优于
            // "AllocationBalancingRoundMetrics"（31 个字符）。核心类倾向于
            // 使用简洁的名称，而测试/辅助类名称更冗长。
            const brevityBonus = Math.max(0, 10 - (r.node.name.length - titleCased.length) / 3);
            matched.push({ ...r, score: r.score + 15 + brevityBonus });
          }
        }
        matched.sort((a, b) => b.score - a.score);
        for (const r of matched.slice(0, Math.ceil(opts.searchLimit))) {
          const existing = exactMatches.find(e => e.node.id === r.node.id);
          if (!existing) {
            exactMatches.push(r);
          }
        }
      }
      exactMatches.sort((a, b) => b.score - a.score);
      exactMatches = exactMatches.slice(0, Math.ceil(opts.searchLimit * 3));
    }

    // 第 3 步：运行文本搜索以匹配自然语言词汇
    // 可捕获语义搜索可能遗漏的文件名和节点名匹配，
    // 这对以模板为主的代码库（如 Liquid/Shopify 主题）至关重要——
    // 在这些代码库中，文件名是主要标识符。
    let textResults: SearchResult[] = [];
    try {
      const searchTerms = extractSearchTerms(query);
      if (searchTerms.length > 0) {
        // 逐个搜索每个词以获得更广的覆盖，
        // 再对匹配多个词的结果进行提升
        const termResultsMap = new Map<string, { result: SearchResult; termHits: number }>();
        // 未设置显式类型过滤时，排除导入——它们会用限定名匹配
        // 淹没 FTS 结果（如 "REST" 匹配 445K 条导入路径），
        // 但几乎永远不是探索性查询想要的内容。
        const searchKinds = opts.nodeKinds && opts.nodeKinds.length > 0
          ? opts.nodeKinds
          : ['file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol',
             'function', 'method', 'property', 'field', 'variable', 'constant',
             'enum', 'enum_member', 'type_alias', 'namespace', 'export',
             'route', 'component'] as NodeKind[];
        for (const term of searchTerms) {
          const termResults = this.queries.searchNodes(term, {
            limit: opts.searchLimit * 2,
            kinds: searchKinds,
          });
          for (const r of termResults) {
            const existing = termResultsMap.get(r.node.id);
            if (existing) {
              existing.termHits++;
              existing.result.score = Math.max(existing.result.score, r.score);
            } else {
              termResultsMap.set(r.node.id, { result: r, termHits: 1 });
            }
          }
        }
        // 对匹配多个词的结果进行提升并排序
        textResults = Array.from(termResultsMap.values())
          .map(({ result, termHits }) => ({
            ...result,
            score: result.score + (termHits - 1) * 5,
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, opts.searchLimit * 2);
      }
      logDebug('Text search results', { count: textResults.length });
    } catch (error) {
      logDebug('Text search failed', { query, error: String(error) });
    }

    // 第 4 步：合并结果，当跨搜索通道出现重复时取最高分。
    // 精确匹配的分数可能低于 FTS 对同一节点的结果——
    // 使用任意通道中的最佳分数。
    const resultById = new Map<string, SearchResult>();
    let searchResults: SearchResult[] = [];

    // 首先添加精确匹配
    for (const result of exactMatches) {
      const existing = resultById.get(result.node.id);
      if (existing) {
        existing.score = Math.max(existing.score, result.score);
      } else {
        resultById.set(result.node.id, result);
        searchResults.push(result);
      }
    }

    // 添加文本搜索结果，对重复项升级分数
    for (const result of textResults) {
      const existing = resultById.get(result.node.id);
      if (existing) {
        existing.score = Math.max(existing.score, result.score);
      } else {
        resultById.set(result.node.id, result);
        searchResults.push(result);
      }
    }

    const queryLower = query.toLowerCase();
    const isTestQuery = queryLower.includes('test') || queryLower.includes('spec');

    // 提前降低测试文件的优先级，防止其占用多词提升的名额
    if (!isTestQuery) {
      for (const result of searchResults) {
        if (isTestFile(result.node.filePath)) {
          result.score *= 0.3;
        }
      }
    }

    // Iter7——核心目录提升。对于拥有一个文件集中了绝大多数内部调用边的项目
    // （例如 sinatra 的 `lib/sinatra/base.rb` 占所有内部边的 85%），
    // 智能体的任务通常围绕框架核心展开。没有这个提升时，排名会倾向于
    // 小型聚焦的扩展文件（例如文本搜索会选中
    // `sinatra-contrib/lib/sinatra/multi_route.rb` 中的 10 行 `route` 方法，
    // 而非 `base.rb` 中的 `route!`——因为扩展文件的 `route` 精确匹配查询词，
    // 且文件很小，使 1500 行文件中较长的 `route!` 黯然失色）。
    // 对与主导文件目录同前缀的结果进行提升，使核心文件的同级文件排名
    // 高于同级包中的扩展文件。
    try {
      const dominant = this.queries.getDominantFile?.();
      if (dominant && dominant.edgeCount >= 3 * dominant.nextEdgeCount) {
        // 取主导文件的目录（最后一个斜杠之前的部分）。
        // 如 `lib/sinatra/base.rb` → `lib/sinatra/`。
        const slash = dominant.filePath.lastIndexOf('/');
        if (slash > 0) {
          const coreDir = dominant.filePath.slice(0, slash + 1);
          for (const result of searchResults) {
            if (result.node.filePath.startsWith(coreDir)) {
              result.score += 25;
            }
          }
        }
      }
    } catch {
      // SQL 查询失败——继续，评分在没有此提升的情况下仍然有效
    }

    // 第 5a 步：多词共现重排（在截断前应用）。
    // 对于 "search execution from request to shard" 等多词查询，
    // 在名称或路径中匹配 2 个以上查询词的节点，比仅匹配一个通用词的节点
    // 相关性高得多。没有这个步骤，"ExecutionUtils"（仅匹配 "execution"）
    // 会抢占本应分给 "ShardSearchRequest"（匹配 "shard"+"search"+"request"）的名额。
    const queryTermsForBoost = extractSearchTerms(query);
    if (queryTermsForBoost.length >= 2) {
      // 将互为子串的词归为一组（同一词根的词干变体）。
      // "indexed"、"indexe"、"index" 应算作 ONE 个概念匹配，
      // 而非三个。否则词干变体会虚增 matchCount，对仅匹配一个词根
      // 多次的符号给出错误的多词提升。
      const termGroups: string[][] = [];
      const sorted = [...queryTermsForBoost].sort((a, b) => b.length - a.length);
      const assigned = new Set<string>();
      for (const term of sorted) {
        if (assigned.has(term)) continue;
        const group = [term];
        assigned.add(term);
        for (const other of sorted) {
          if (assigned.has(other)) continue;
          if (term.includes(other) || other.includes(term)) {
            group.push(other);
            assigned.add(other);
          }
        }
        termGroups.push(group);
      }

      // 构建精确匹配节点 ID 集合，以便在降权时对其豁免。
      // 当查询为 "LiveEditMode DevServerPreview" 时，这些是用户明确点名的符号——
      // 因为它们只匹配 1 个词组就对其降权是适得其反的。
      const exactMatchIds = new Set(exactMatches.map(r => r.node.id));

      // ……但只豁免用户*以标识符形式命名*的精确匹配
      // （camelCase/snake_case/缩写词）。一个恰好精确匹配
      // 无关符号的普通词——如查询 "flat object" → 常量 FLAT——
      // 绝不应豁免，否则 +精确名称奖励会将其浮到查询顶部，
      // 而无任何其他词的佐证。按查询词令牌（用户输入的内容）分类，
      // 而非匹配到的符号名称。
      const distinctiveTokens = new Set(
        symbolsFromQuery.filter(isDistinctiveIdentifier).map(s => s.toLowerCase())
      );
      const distinctiveExactMatchIds = new Set(
        exactMatches
          .filter(r => distinctiveTokens.has(r.node.name.toLowerCase()))
          .map(r => r.node.id)
      );

      for (const result of searchResults) {
        // 检查名称中的词匹配（子串）和路径目录中的词匹配（精确）。
        // 目录段必须精确匹配——"search" 匹配目录 "search/"
        // 但不匹配 "elasticsearch/"。类名通过节点名的子串匹配单独检查。
        const nameLower = result.node.name.toLowerCase();
        const dirSegments = path.dirname(result.node.filePath).toLowerCase().split('/');
        let matchCount = 0;
        for (const group of termGroups) {
          const groupMatches = group.some(term => {
            const inName = nameLower.includes(term);
            const inDir = dirSegments.some(seg => seg === term);
            return inName || inDir;
          });
          if (groupMatches) matchCount++;
        }
        if (matchCount >= 2) {
          // 乘法提升——2 个词 → 2x，3 个词 → 2.5x
          result.score *= 1 + matchCount * 0.5;
        } else if (distinctiveExactMatchIds.has(result.node.id)) {
          // 对用户明确命名的标识符的精确匹配——保持全分（如 "LiveEditMode DevServerPreview"）
        } else if (exactMatchIds.has(result.node.id)) {
          // 对常见词的精确匹配（如 "flat" → FLAT）：被 +精确名称奖励虚增的高分噪声，
          // 无任何其他查询词佐证。大幅降权，让有佐证的匹配胜出。
          result.score *= 0.3;
        } else {
          // 对通用单词匹配的温和降权——它们可能是通用的，
          // 但也可能是正确结果（如 IPC 查询的 "Protocol" 类）。
          result.score *= 0.6;
        }
      }
      searchResults.sort((a, b) => b.score - a.score);
    }

    // 第 5b 步：通过 LIKE 查询进行 CamelCase 边界匹配。
    // FTS 无法在 "TransportSearchAction"（一个 FTS 令牌）中找到 "Search"。
    // LIKE 能可靠地找到这些子串匹配。结果以保证名额追加，
    // 不与分数更高的前缀匹配竞争。
    if (symbolsFromQuery.length > 0) {
      const camelDefinitionKinds: NodeKind[] = ['class', 'interface', 'struct', 'trait',
        'protocol', 'enum', 'type_alias'];
      const camelSearchedTerms = new Set<string>();
      const searchIdSet = new Set(searchResults.map(r => r.node.id));
      // 跟踪每个节点的词命中数，用于多词提升
      const camelNodeTerms = new Map<string, { result: SearchResult; termCount: number }>();
      const maxCamelPerTerm = Math.ceil(opts.searchLimit / 2);

      for (const sym of symbolsFromQuery) {
        const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
        if (titleCased.length < 3) continue;
        const termKey = titleCased.toLowerCase();
        if (camelSearchedTerms.has(termKey)) continue;
        camelSearchedTerms.add(termKey);

        // 获取大批量结果——Elasticsearch 中的 "Search" 等热门词有数百个子串匹配。
        // LIKE 扫描成本与 LIMIT 无关（SQLite 扫描所有匹配后排序），
        // 因此大量获取，让路径相关性评分选出最佳结果。
        const likeResults = this.queries.findNodesByNameSubstring(titleCased, {
          limit: 200,
          kinds: camelDefinitionKinds,
          excludePrefix: true,
        });

        // 过滤到 CamelCase 边界，按路径相关性评分，并取前 N 个
        const termCandidates: SearchResult[] = [];
        for (const r of likeResults) {
          const name = r.node.name;
          const idx = name.indexOf(titleCased);
          if (idx <= 0) continue;
          // 接受 CamelCase 边界（匹配前为小写）或
          // 缩写词��界（匹配前为大写，如 RPCProtocol）
          if (!/[a-zA-Z]/.test(name.charAt(idx - 1))) continue;
          if (searchIdSet.has(r.node.id)) continue;
          if (isTestFile(r.node.filePath) && !isTestQuery) continue;

          const pathScore = scorePathRelevance(r.node.filePath, query);
          const brevityBonus = Math.max(0, 6 - (name.length - titleCased.length) / 4);
          termCandidates.push({ node: r.node, score: 8 + brevityBonus + pathScore });
        }
        termCandidates.sort((a, b) => b.score - a.score);

        // 扩大每词的积累池，以发现多词共现情况。
        // 在 CamelCase 边界匹配 3 个查询词的类，远比仅匹配 1 个词的类更相关，
        // 但它需要在每个词的截断中存活，才能积累其计数。
        const accumPerTerm = maxCamelPerTerm * 4;
        for (const r of termCandidates.slice(0, accumPerTerm)) {
          const existing = camelNodeTerms.get(r.node.id);
          if (existing) {
            existing.termCount++;
          } else {
            camelNodeTerms.set(r.node.id, {
              result: r,
              termCount: 1,
            });
          }
        }
      }

      // 追加带多词提升的 CamelCase 匹配。
      // 这些匹配在结构上很重要（类名在 CamelCase 边界包含查询词），
      // 但分数远低于 FTS 结果。放大分数，使多词 CamelCase 匹配
      // 能与 FTS 结果竞争。
      const camelResults: SearchResult[] = [];
      for (const [, info] of camelNodeTerms) {
        // 多词 CamelCase 匹配极为相关——名称中匹配 3 个以上查询词的类
        // （如 ExtensionHostProcess）几乎肯定是用户想要的。积极放大分数。
        info.result.score = info.result.score * (1 + info.termCount) + (info.termCount - 1) * 30;
        camelResults.push(info.result);
      }
      camelResults.sort((a, b) => b.score - a.score);
      const maxCamelTotal = opts.searchLimit;
      for (const r of camelResults.slice(0, maxCamelTotal)) {
        searchResults.push(r);
        searchIdSet.add(r.node.id);
      }

      // 第 5c 步：复合词匹配——查找名称在任意位置（不仅限于 CamelCase 边界）
      // 包含 2 个以上查询词的类。上面的 CamelCase 步骤要求 idx > 0，
      // 会遗漏以查询词开头的类（如 "SearchShardsRequest" 以 "Search" 开头）。
      // 对于多词查询，名称中匹配多个查询词的类，无论位置如何几乎都是相关的。
      if (symbolsFromQuery.length >= 2) {
        // 收集每个词的所有 LIKE 结果（复用 findNodesByNameSubstring），
        // 但不使用 CamelCase 边界或前缀排除过滤器。
        const compoundTermMap = new Map<string, { node: Node; terms: Set<string> }>();
        for (const sym of symbolsFromQuery) {
          const titleCased = sym.charAt(0).toUpperCase() + sym.slice(1).toLowerCase();
          if (titleCased.length < 3) continue;

          const likeResults = this.queries.findNodesByNameSubstring(titleCased, {
            limit: 200,
            kinds: camelDefinitionKinds,
            excludePrefix: false,
          });

          for (const r of likeResults) {
            if (searchIdSet.has(r.node.id)) continue;
            if (isTestFile(r.node.filePath) && !isTestQuery) continue;
            const entry = compoundTermMap.get(r.node.id);
            if (entry) {
              entry.terms.add(titleCased);
            } else {
              compoundTermMap.set(r.node.id, { node: r.node, terms: new Set([titleCased]) });
            }
          }
        }

        // 仅保留匹配 2 个以上不同词的节点
        const compoundResults: SearchResult[] = [];
        for (const [, entry] of compoundTermMap) {
          if (entry.terms.size >= 2) {
            const pathScore = scorePathRelevance(entry.node.filePath, query);
            const brevityBonus = Math.max(0, 6 - entry.node.name.length / 8);
            compoundResults.push({
              node: entry.node,
              score: 10 + (entry.terms.size - 1) * 20 + pathScore + brevityBonus,
            });
          }
        }
        compoundResults.sort((a, b) => b.score - a.score);
        const maxCompound = Math.ceil(opts.searchLimit / 2);
        for (const r of compoundResults.slice(0, maxCompound)) {
          searchResults.push(r);
          searchIdSet.add(r.node.id);
        }
      }
    }

    // 最终排序和截断——所有搜索通道（精确匹配、文本、CamelCase、
    // 复合词）均已贡献。按分数排序，使后续步骤中的多词匹配
    // 能超越前面步骤中被降权的单词匹配。
    searchResults.sort((a, b) => b.score - a.score);
    searchResults = searchResults.slice(0, opts.searchLimit * 3);

    // 按最低分数过滤
    let filteredResults = searchResults.filter((r) => r.score >= opts.minScore);

    // 将导入/导出解析为其实际定义。
    // 当有人搜索 "terminal" 并找到 `import { TerminalPanel }` 时，
    // 他们想要的是 TerminalPanel 类，而非导入语句。
    filteredResults = this.resolveImportsToDefinitions(filteredResults);

    // 限制入口点数量，避免遍历预算过于分散。
    // 36 个入口点加上 maxNodes=120，每个只能获得 3 个节点——毫无意义。
    // 限制为 searchLimit，使每个入口点获得有意义的遍历预算。
    if (filteredResults.length > opts.searchLimit) {
      filteredResults = filteredResults.slice(0, opts.searchLimit);
    }

    // 诚实衔接尾注（由 buildContext 使用）的置信度信号。
    // 一个多词散文查询，若只解析到孤立的常用词匹配——
    // 没有被 2 个以上不同查询词佐证的入口点，且没有用户明确命名的
    // 标识性标识符——则为低置信度：结果是尽力而为，而非已定位的答案，
    // 应告知智能体用 explore/trace 深入查找，而非将列表视为全面答案。
    // 单关键词和符号名查询豁免（其单一匹配就是答案），因此衔接提示不会对其触发。
    let confidence: 'high' | 'low' = 'high';
    const confTerms = extractSearchTerms(query, { stems: false }).filter(t => t.length >= 3);
    if (confTerms.length >= 2 && filteredResults.length > 0) {
      const distinctive = new Set(
        symbolsFromQuery.filter(isDistinctiveIdentifier).map(s => s.toLowerCase())
      );
      const anyStrong = filteredResults.some(r => {
        if (distinctive.has(r.node.name.toLowerCase())) return true;
        const nameLower = r.node.name.toLowerCase();
        const dirSegs = path.dirname(r.node.filePath).toLowerCase().split('/');
        let hits = 0;
        for (const t of confTerms) {
          if (nameLower.includes(t) || dirSegs.includes(t)) {
            if (++hits >= 2) return true;
          }
        }
        return false;
      });
      if (!anyStrong) confidence = 'low';
    }

    // 将入口点添加到子图
    for (const result of filteredResults) {
      nodes.set(result.node.id, result.node);
      roots.push(result.node.id);
    }

    // 展开 class/interface 入口点的类型层次结构。
    // BFS 往往在到达 extends/implements 邻居之前，就将每个入口点的预算
    // 耗尽在其包含的方法上。这个专用步骤确保子类和父类始终出现在结果中。
    // 预算：最多 maxNodes/4 个层次结构节点，避免泛滥。
    const typeHierarchyKinds = new Set<string>(['class', 'interface', 'struct', 'trait', 'protocol']);
    const maxHierarchyNodes = Math.ceil(opts.maxNodes / 4);
    let hierarchyNodesAdded = 0;
    for (const result of filteredResults) {
      if (hierarchyNodesAdded >= maxHierarchyNodes) break;
      if (typeHierarchyKinds.has(result.node.kind)) {
        const hierarchy = this.traverser.getTypeHierarchy(result.node.id);
        for (const [id, node] of hierarchy.nodes) {
          if (!nodes.has(id)) {
            nodes.set(id, node);
            hierarchyNodesAdded++;
          }
        }
        for (const edge of hierarchy.edges) {
          const exists = edges.some(
            (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
          );
          if (!exists) {
            edges.push(edge);
          }
        }
      }
    }

    // 第 2 遍：展开新发现父类型的层次结构以找到兄弟类型。
    // 例如 InternalEngine → Engine（父类，来自第 1 遍）→ ReadOnlyEngine（兄弟类）。
    if (hierarchyNodesAdded > 0) {
      const pass2Candidates = [...nodes.values()].filter(
        n => typeHierarchyKinds.has(n.kind) && !roots.includes(n.id)
      );
      for (const candidate of pass2Candidates) {
        if (hierarchyNodesAdded >= maxHierarchyNodes) break;
        const siblingHierarchy = this.traverser.getTypeHierarchy(candidate.id);
        for (const [id, node] of siblingHierarchy.nodes) {
          if (!nodes.has(id) && hierarchyNodesAdded < maxHierarchyNodes) {
            nodes.set(id, node);
            hierarchyNodesAdded++;
          }
        }
        for (const edge of siblingHierarchy.edges) {
          if (nodes.has(edge.source) && nodes.has(edge.target)) {
            const exists = edges.some(
              (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
            );
            if (!exists) {
              edges.push(edge);
            }
          }
        }
      }
    }

    // 从每个入口点出发进行遍历
    for (const result of filteredResults) {
      const traversalResult = this.traverser.traverseBFS(result.node.id, {
        maxDepth: opts.traversalDepth,
        edgeKinds: opts.edgeKinds && opts.edgeKinds.length > 0 ? opts.edgeKinds : undefined,
        nodeKinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
        direction: 'both',
        limit: Math.ceil(opts.maxNodes / Math.max(1, filteredResults.length)),
      });

      // 合并节点
      for (const [id, node] of traversalResult.nodes) {
        if (!nodes.has(id)) {
          nodes.set(id, node);
        }
      }

      // 合并边（避免重复）
      for (const edge of traversalResult.edges) {
        const exists = edges.some(
          (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
        );
        if (!exists) {
          edges.push(edge);
        }
      }
    }

    // 必要时截断到最大节点数
    let finalNodes = nodes;
    let finalEdges = edges;
    if (nodes.size > opts.maxNodes) {
      // 优先保留入口点及其直接邻居
      const priorityIds = new Set(roots);
      for (const edge of edges) {
        if (priorityIds.has(edge.source)) {
          priorityIds.add(edge.target);
        }
        if (priorityIds.has(edge.target)) {
          priorityIds.add(edge.source);
        }
      }

      // 保留优先节点，再填充剩余名额
      finalNodes = new Map<string, Node>();
      for (const id of priorityIds) {
        const node = nodes.get(id);
        if (node && finalNodes.size < opts.maxNodes) {
          finalNodes.set(id, node);
        }
      }

      // 从其他节点填充剩余名额
      for (const [id, node] of nodes) {
        if (finalNodes.size >= opts.maxNodes) break;
        if (!finalNodes.has(id)) {
          finalNodes.set(id, node);
        }
      }

      // 只保留已选节点之间的边
      finalEdges = edges.filter(
        (e) => finalNodes.has(e.source) && finalNodes.has(e.target)
      );
    }

    // 单文件多样性上限：防止任何一个文件独占节点预算。
    // 当 BFS 从一个方法出发时，会沿 `contains` 追溯到父类，
    // 再往下到所有兄弟方法。若同一个类有多个入口点，
    // 一个文件可能消耗 30-40% 的 maxNodes。
    // 将每个文件限制为约 20%，以确保跨文件的多样性。
    const maxPerFile = Math.max(5, Math.ceil(opts.maxNodes * 0.2));
    const fileCounts = new Map<string, string[]>();
    for (const [id, node] of finalNodes) {
      const ids = fileCounts.get(node.filePath) || [];
      ids.push(id);
      fileCounts.set(node.filePath, ids);
    }
    const rootSet = new Set(roots);
    for (const [, nodeIds] of fileCounts) {
      if (nodeIds.length <= maxPerFile) continue;
      // 排序：入口点优先，其次是 class/interface，最后是其他
      const kindPriority: Record<string, number> = {
        class: 3, interface: 3, struct: 3, trait: 3, protocol: 3, enum: 3,
        method: 1, function: 1, property: 0, field: 0, variable: 0,
      };
      nodeIds.sort((a, b) => {
        const aRoot = rootSet.has(a) ? 10 : 0;
        const bRoot = rootSet.has(b) ? 10 : 0;
        const aKind = kindPriority[finalNodes.get(a)!.kind] ?? 0;
        const bKind = kindPriority[finalNodes.get(b)!.kind] ?? 0;
        return (bRoot + bKind) - (aRoot + aKind);
      });
      // 移除多余节点（保留优先级最高的）
      for (const id of nodeIds.slice(maxPerFile)) {
        finalNodes.delete(id);
      }
    }
    // 非生产节点上限：将测试/样本/集成/示例文件限制在预算的 15% 以内。
    // 许多代码库有数十个几乎相同的测试实现（如集成测试中的 6 个 Guard 类），
    // 它们单独都能通过评分降权，但合在一起会淹没结果。
    // 测试文件入口点不豁免——同样应被驱逐。
    if (!isTestQuery) {
      const maxNonProd = Math.max(3, Math.ceil(opts.maxNodes * 0.15));
      const nonProdIds: string[] = [];
      for (const [id, node] of finalNodes) {
        if (isTestFile(node.filePath)) {
          nonProdIds.push(id);
        }
      }
      if (nonProdIds.length > maxNonProd) {
        for (const id of nonProdIds.slice(maxNonProd)) {
          finalNodes.delete(id);
          // 同样从根节点中移除——测试文件入口点不应作为锚点
          const rootIdx = roots.indexOf(id);
          if (rootIdx !== -1) roots.splice(rootIdx, 1);
        }
      }
    }

    // 在单文件上限和非生产上限之后重新过滤边
    finalEdges = finalEdges.filter(
      (e) => finalNodes.has(e.source) && finalNodes.has(e.target)
    );

    // 边恢复：拥有大量入口点的 BFS 会使大多数节点失去连接。
    // 在已选节点之间发现边，以恢复连通性。
    const recoveryKinds: EdgeKind[] = ['calls', 'extends', 'implements', 'references', 'overrides'];
    const recoveredEdges = this.queries.findEdgesBetweenNodes(
      [...finalNodes.keys()],
      recoveryKinds,
    );
    const existingEdgeKeys = new Set(
      finalEdges.map((e) => `${e.source}:${e.target}:${e.kind}`)
    );
    for (const edge of recoveredEdges) {
      const key = `${edge.source}:${edge.target}:${edge.kind}`;
      if (!existingEdgeKeys.has(key)) {
        finalEdges.push(edge);
        existingEdgeKeys.add(key);
      }
    }

    return { nodes: finalNodes, edges: finalEdges, roots, confidence };
  }

  /**
   * 获取节点的源代码
   *
   * 读取文件并提取 startLine 到 endLine 之间的代码。
   *
   * @param nodeId - 节点 ID
   * @returns 代码字符串，若未找到则为 null
   */
  async getCode(nodeId: string): Promise<string | null> {
    const node = this.queries.getNodeById(nodeId);
    if (!node) {
      return null;
    }

    return this.extractNodeCode(node);
  }

  /**
   * 从节点的源文件中提取代码
   */
  private async extractNodeCode(node: Node): Promise<string | null> {
    // 安全性（#383）：配置叶节点在磁盘上的行格式为 `key = <secret>`。
    // 仅返回键名——绝不从磁盘读取值。这关闭了 includeCode / buildContext
    // 代码块路径，与 explore 源码渲染器保持一致；
    // 真正需要该值的智能体可以自行读取文件。
    if (isConfigLeafNode(node)) {
      return node.signature || node.qualifiedName || node.name;
    }

    const filePath = validatePathWithinRoot(this.projectRoot, node.filePath);

    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      // 提取行（从 1 开始的索引转为 0 开始的索引）
      const startIdx = Math.max(0, node.startLine - 1);
      const endIdx = Math.min(lines.length, node.endLine);

      return lines.slice(startIdx, endIdx).join('\n');
    } catch (error) {
      logDebug('Failed to extract code from node', { nodeId: node.id, filePath: node.filePath, error: String(error) });
      return null;
    }
  }

  /**
   * 从子图中获取入口点（根节点）
   */
  private getEntryPoints(subgraph: Subgraph): Node[] {
    return subgraph.roots
      .map((id) => subgraph.nodes.get(id))
      .filter((n): n is Node => n !== undefined);
  }

  /**
   * 提取子图中关键节点的代码块
   */
  private async extractCodeBlocks(
    subgraph: Subgraph,
    maxBlocks: number,
    maxBlockSize: number
  ): Promise<CodeBlock[]> {
    const blocks: CodeBlock[] = [];

    // 优先入口点，其次是函数/方法
    const priorityNodes: Node[] = [];

    // 首先：入口点
    for (const id of subgraph.roots) {
      const node = subgraph.nodes.get(id);
      if (node) {
        priorityNodes.push(node);
      }
    }

    // 其次：函数和方法
    for (const node of subgraph.nodes.values()) {
      if (!subgraph.roots.includes(node.id)) {
        if (node.kind === 'function' || node.kind === 'method') {
          priorityNodes.push(node);
        }
      }
    }

    // 最后：类
    for (const node of subgraph.nodes.values()) {
      if (!subgraph.roots.includes(node.id)) {
        if (node.kind === 'class') {
          priorityNodes.push(node);
        }
      }
    }

    // 提取优先节点的代码
    for (const node of priorityNodes) {
      if (blocks.length >= maxBlocks) break;

      const code = await this.extractNodeCode(node);
      if (code) {
        // 过长时截断。使用语言中立的标记（不用 `//`——
        // 在 Python、Ruby 等语言中不是注释）；此标记在
        // 语言各异的围栏代码块内渲染。
        const truncated = code.length > maxBlockSize
          ? code.slice(0, maxBlockSize) + '\n... (truncated) ...'
          : code;

        blocks.push({
          content: truncated,
          filePath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
          language: node.language,
          node,
        });
      }
    }

    return blocks;
  }

  /**
   * 从子图中获取去重后的文件列表
   */
  private getRelatedFiles(subgraph: Subgraph): string[] {
    const files = new Set<string>();
    for (const node of subgraph.nodes.values()) {
      files.add(node.filePath);
    }
    return Array.from(files).sort();
  }

  /**
   * 生成上下文的摘要
   */
  private generateSummary(_query: string, subgraph: Subgraph, entryPoints: Node[]): string {
    const nodeCount = subgraph.nodes.size;
    const edgeCount = subgraph.edges.length;
    const files = this.getRelatedFiles(subgraph);

    const entryPointNames = entryPoints
      .slice(0, 3)
      .map((n) => n.name)
      .join(', ');

    const remaining = entryPoints.length > 3 ? ` and ${entryPoints.length - 3} more` : '';

    return `Found ${nodeCount} relevant code symbols across ${files.length} files. ` +
      `Key entry points: ${entryPointNames}${remaining}. ` +
      `${edgeCount} relationships identified.`;
  }

  /**
   * 将导入/导出节点解析为其实际定义
   *
   * 当搜索返回 `import { TerminalPanel }` 时，用户想要的是
   * TerminalPanel 类定义，而非导入语句。此方法沿 `imports` 边
   * 查找并返回实际定义。
   *
   * @param results - 可能包含导入/导出节点的搜索结果
   * @returns 将导入解析为定义后的结果（尽可能解析）
   */
  private resolveImportsToDefinitions(results: SearchResult[]): SearchResult[] {
    const resolved: SearchResult[] = [];
    const seenIds = new Set<string>();

    for (const result of results) {
      const { node, score } = result;

      // 若不是导入/导出，保持原样
      if (node.kind !== 'import' && node.kind !== 'export') {
        if (!seenIds.has(node.id)) {
          seenIds.add(node.id);
          resolved.push(result);
        }
        continue;
      }

      // 对于导入/导出，尝试找到它们所引用的内容
      // 导入具有指向定义的出向 'imports' 边
      // 导出具有指向定义的出向 'exports' 边
      const edgeKind = node.kind === 'import' ? 'imports' : 'exports';
      const outgoingEdges = this.queries.getOutgoingEdges(node.id, [edgeKind as EdgeKind]);

      let foundDefinition = false;
      for (const edge of outgoingEdges) {
        const targetNode = this.queries.getNodeById(edge.target);
        if (targetNode && !seenIds.has(targetNode.id)) {
          // 找到定义——用它代替导入
          seenIds.add(targetNode.id);
          resolved.push({
            node: targetNode,
            score: score, // 保留原始分数
          });
          foundDefinition = true;
          logDebug('Resolved import to definition', {
            import: node.name,
            definition: targetNode.name,
            kind: targetNode.kind,
          });
        }
      }

      // 若无法解析导入，跳过它（单独存在时价值很低）
      if (!foundDefinition) {
        logDebug('Skipping unresolved import', { name: node.name, file: node.filePath });
      }
    }

    return resolved;
  }
}

/**
 * 创建上下文构建器
 */
export function createContextBuilder(
  projectRoot: string,
  queries: QueryBuilder,
  traverser: GraphTraverser
): ContextBuilder {
  return new ContextBuilder(projectRoot, queries, traverser);
}

// 重新导出格式化器
export { formatContextAsMarkdown, formatContextAsJson } from './formatter';
