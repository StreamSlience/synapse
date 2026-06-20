/**
 * Synapse 类型定义
 *
 * 语义知识图谱系统的核心类型。
 */

// =============================================================================
// 联合类型
// =============================================================================

/**
 * 知识图谱中节点的类型。
 *
 * 定义为运行时可迭代的 `as const` 数组，使同一来源
 * 同时支撑 TS 类型和任何运行时校验
 * （例如搜索查询解析器）。
 */
export const NODE_KINDS = [
  'file',
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'parameter',
  'import',
  'export',
  'route',
  'component',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * 节点之间的边（关系）类型
 */
export type EdgeKind =
  | 'contains'        // 父节点包含子节点（file→class，class→method）
  | 'calls'           // 函数/方法调用另一个
  | 'imports'         // 文件从另一文件导入
  | 'exports'         // 文件导出某个符号
  | 'extends'         // 类/接口继承另一个
  | 'implements'      // 类实现接口
  | 'references'      // 对另一符号的泛型引用
  | 'type_of'         // 变量/参数具有类型
  | 'returns'         // 函数返回类型
  | 'instantiates'    // 创建类的实例
  | 'overrides'       // 方法覆盖父方法
  | 'decorates';      // 装饰器应用于符号

/**
 * 支持的编程语言。关于为何使用运行时可迭代的 const 数组，参见 NODE_KINDS。
 */
export const LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'razor',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'svelte',
  'vue',
  'astro',
  'liquid',
  'pascal',
  'scala',
  'lua',
  'luau',
  'objc',
  'r',
  'yaml',
  'twig',
  'xml',
  'properties',
  'unknown',
] as const;

export type Language = (typeof LANGUAGES)[number];

// =============================================================================
// 核心图类型
// =============================================================================

/**
 * 知识图谱中表示代码符号的节点
 */
export interface Node {
  /** 唯一标识符（文件路径 + 限定名的哈希值） */
  id: string;

  /** 代码元素的类型 */
  kind: NodeKind;

  /** 简单名称（例如 "calculateTotal"） */
  name: string;

  /** 完全限定名（例如 "src/utils.ts::MathHelper.calculateTotal"） */
  qualifiedName: string;

  /** 相对于项目根目录的文件路径 */
  filePath: string;

  /** 编程语言 */
  language: Language;

  /** 起始行号（从 1 开始） */
  startLine: number;

  /** 结束行号（从 1 开始） */
  endLine: number;

  /** 起始列号（从 0 开始） */
  startColumn: number;

  /** 结束列号（从 0 开始） */
  endColumn: number;

  /** 文档字符串（如有） */
  docstring?: string;

  /** 函数/方法签名 */
  signature?: string;

  /** 可见性修饰符 */
  visibility?: 'public' | 'private' | 'protected' | 'internal';

  /** 符号是否已导出 */
  isExported?: boolean;

  /** 符号是否为异步 */
  isAsync?: boolean;

  /** 符号是否为静态 */
  isStatic?: boolean;

  /** 符号是否为抽象 */
  isAbstract?: boolean;

  /** 应用的装饰器/注解 */
  decorators?: string[];

  /** 泛型类型参数 */
  typeParameters?: string[];

  /**
   * 函数/方法的标准化返回/结果类型名（裸类名，已解包智能指针指向的类型）。
   * 为 C/C++ 捕获，以便解析器可以从内层调用的返回值推断链式接收方的类型——
   * `Foo::instance().bar()` 会将 `bar` 解析到 `Foo` 上（issue #645）。
   * 未捕获该信息的语言/符号此字段为 undefined。
   */
  returnType?: string;

  /** 节点最后更新时间 */
  updatedAt: number;
}

/**
 * 表示两个节点之间关系的边
 */
export interface Edge {
  /** 源节点 ID */
  source: string;

  /** 目标节点 ID */
  target: string;

  /** 关系类型 */
  kind: EdgeKind;

  /** 关系的附加上下文 */
  metadata?: Record<string, unknown>;

  /** 关系发生的行号（例如调用点） */
  line?: number;

  /** 关系发生的列号 */
  column?: number;

  /** 此边的创建方式 */
  provenance?: 'tree-sitter' | 'scip' | 'heuristic';
}

/**
 * 被追踪文件的元数据
 */
export interface FileRecord {
  /** 相对于项目根目录的文件路径 */
  path: string;

  /** 用于变更检测的内容哈希 */
  contentHash: string;

  /** 检测到的语言 */
  language: Language;

  /** 文件大小（字节） */
  size: number;

  /** 最后修改时间戳 */
  modifiedAt: number;

  /** 最后索引时间 */
  indexedAt: number;

  /** 提取的节点数量 */
  nodeCount: number;

  /** 提取时的任何错误 */
  errors?: ExtractionError[];
}

// =============================================================================
// 提取类型
// =============================================================================

/**
 * 解析源文件的结果
 */
export interface ExtractionResult {
  /** 提取的节点 */
  nodes: Node[];

  /** 提取的边 */
  edges: Edge[];

  /** 尚未解析的引用 */
  unresolvedReferences: UnresolvedReference[];

  /** 提取过程中的任何错误 */
  errors: ExtractionError[];

  /** 提取耗时（毫秒） */
  durationMs: number;
}

/**
 * 代码提取过程中的错误
 */
export interface ExtractionError {
  /** 错误信息 */
  message: string;

  /** 发生错误的文件路径 */
  filePath?: string;

  /** 行号（如有） */
  line?: number;

  /** 列号（如有） */
  column?: number;

  /** 错误严重程度 */
  severity: 'error' | 'warning';

  /** 用于分类的错误码 */
  code?: string;
}

/**
 * 未解析引用可携带的类型。`function_ref` 仅供内部使用——
 * 函数名作为值使用（回调注册，#756）。它永远不会变成边类型：
 * 解析器将其映射为仅指向 function/method 节点的 `references` 边
 *（参见 `matchFunctionRef`）。
 */
export type ReferenceKind = EdgeKind | 'function_ref';

/**
 * 提取过程中无法解析的引用
 */
export interface UnresolvedReference {
  /** 包含该引用的节点 ID */
  fromNodeId: string;

  /** 被引用的名称 */
  referenceName: string;

  /** 引用类型（调用、类型、导入等） */
  referenceKind: ReferenceKind;

  /** 引用的位置 */
  line: number;
  column: number;

  /** 引用所在的文件路径（反规范化以提高性能） */
  filePath?: string;

  /** 源文件的语言（反规范化以提高性能） */
  language?: Language;

  /** 可能解析到的候选限定名 */
  candidates?: string[];
}

// =============================================================================
// 查询类型
// =============================================================================

/**
 * 包含知识图谱子集的子图
 */
export interface Subgraph {
  /** 此子图中的节点 */
  nodes: Map<string, Node>;

  /** 此子图中的边 */
  edges: Edge[];

  /** 根节点 ID（入口点） */
  roots: string[];

  /**
   * 上下文风格查询的检索置信度。`'low'` 表示查询
   * 只解析到孤立的常用词匹配（没有被 2 个以上不同查询词佐证的入口点）——
   * 调用方应给出诚实的衔接提示，引导使用 explore/trace，
   * 而非将结果呈现为全面的答案。对于不走搜索排名路径的图遍历，此字段为 undefined。
   */
  confidence?: 'high' | 'low';
}

/**
 * 图遍历选项
 */
export interface TraversalOptions {
  /** 最大遍历深度（默认：Infinity） */
  maxDepth?: number;

  /** 要跟随的边类型（默认：全部） */
  edgeKinds?: EdgeKind[];

  /** 要包含的节点类型（默认：全部） */
  nodeKinds?: NodeKind[];

  /** 遍历方向 */
  direction?: 'outgoing' | 'incoming' | 'both';

  /** 最多返回的节点数 */
  limit?: number;

  /** 是否包含起始节点 */
  includeStart?: boolean;
}

/**
 * 图搜索选项
 */
export interface SearchOptions {
  /** 要搜索的节点类型 */
  kinds?: NodeKind[];

  /** 要包含的语言 */
  languages?: Language[];

  /** 要包含的文件路径模式 */
  includePatterns?: string[];

  /** 要排除的文件路径模式 */
  excludePatterns?: string[];

  /** 最多返回的结果数 */
  limit?: number;

  /** 分页偏移量 */
  offset?: number;

  /** 搜索是否区分大小写 */
  caseSensitive?: boolean;
}

/**
 * 带相关性评分的搜索结果
 */
export interface SearchResult {
  /** 匹配的节点 */
  node: Node;

  /** 相关性评分（0-1） */
  score: number;

  /** 用于高亮显示的匹配文本片段 */
  highlights?: string[];
}

// =============================================================================
// 上下文类型
// =============================================================================

/**
 * 用于代码理解的上下文信息
 */
export interface Context {
  /** 被检查的主要节点 */
  focal: Node;

  /** 包含主节点的节点（文件、类等） */
  ancestors: Node[];

  /** 主节点直接包含的节点 */
  children: Node[];

  /** 入向引用（谁调用/使用了这个） */
  incomingRefs: Array<{ node: Node; edge: Edge }>;

  /** 出向引用（这个调用/使用了什么） */
  outgoingRefs: Array<{ node: Node; edge: Edge }>;

  /** 相关类型信息 */
  types: Node[];

  /** 相关导入 */
  imports: Node[];
}

/**
 * 带上下文的代码块
 */
export interface CodeBlock {
  /** 代码内容 */
  content: string;

  /** 文件路径 */
  filePath: string;

  /** 起始行 */
  startLine: number;

  /** 结束行 */
  endLine: number;

  /** 用于语法高亮的语言 */
  language: Language;

  /** 关联的节点（如已提取） */
  node?: Node;
}

// =============================================================================
// 数据库类型
// =============================================================================

/**
 * 数据库 schema 版本信息
 */
export interface SchemaVersion {
  /** 当前 schema 版本 */
  version: number;

  /** schema 创建/更新时间 */
  appliedAt: number;

  /** 此版本的描述 */
  description?: string;
}

/**
 * 知识图谱的统计信息
 */
export interface GraphStats {
  /** 节点总数 */
  nodeCount: number;

  /** 边总数 */
  edgeCount: number;

  /** 被追踪的文件数 */
  fileCount: number;

  /** 按类型统计的节点数 */
  nodesByKind: Record<NodeKind, number>;

  /** 按类型统计的边数 */
  edgesByKind: Record<EdgeKind, number>;

  /** 按语言统计的文件数 */
  filesByLanguage: Record<Language, number>;

  /** 数据库大小（字节） */
  dbSizeBytes: number;

  /** 最后更新时间戳 */
  lastUpdated: number;
}

// =============================================================================
// 任务上下文类型（用于 buildContext）
// =============================================================================

/**
 * 构建任务上下文的输入
 */
export type TaskInput = string | { title: string; description?: string };

/**
 * 构建任务上下文的选项
 */
export interface BuildContextOptions {
  /** 最多包含的节点数（默认：50） */
  maxNodes?: number;

  /** 最多包含的代码块数（默认：10） */
  maxCodeBlocks?: number;

  /** 每个代码块的最大字符数（默认：2000） */
  maxCodeBlockSize?: number;

  /** 是否包含代码块（默认：true） */
  includeCode?: boolean;

  /** 输出格式（默认：'markdown'） */
  format?: 'markdown' | 'json';

  /** 语义搜索结果数量（默认：5） */
  searchLimit?: number;

  /** 从入口点开始的图遍历深度（默认：2） */
  traversalDepth?: number;

  /** 最低语义相似度分数（默认：0.3） */
  minScore?: number;
}

/**
 * 任务的完整上下文，已准备好供 Claude 使用
 */
export interface TaskContext {
  /** 原始查询/任务 */
  query: string;

  /** 相关节点和边的子图 */
  subgraph: Subgraph;

  /** 入口点节点（来自语义搜索） */
  entryPoints: Node[];

  /** 从关键节点提取的代码块 */
  codeBlocks: CodeBlock[];

  /** 此上下文涉及的文件 */
  relatedFiles: string[];

  /** 上下文的简要摘要 */
  summary: string;

  /** 上下文的统计数据 */
  stats: {
    /** 包含的节点数 */
    nodeCount: number;
    /** 包含的边数 */
    edgeCount: number;
    /** 涉及的文件数 */
    fileCount: number;
    /** 包含的代码块数 */
    codeBlockCount: number;
    /** 代码块的总字符数 */
    totalCodeSize: number;
  };
}

/**
 * 查找相关上下文的选项
 */
export interface FindRelevantContextOptions {
  /** 语义搜索结果数量（默认：5） */
  searchLimit?: number;

  /** 图遍历深度（默认：2） */
  traversalDepth?: number;

  /** 结果中的最大节点数（默认：50） */
  maxNodes?: number;

  /** 最低语义相似度分数（默认：0.3） */
  minScore?: number;

  /** 遍历时跟随的边类型 */
  edgeKinds?: EdgeKind[];

  /** 要包含的节点类型 */
  nodeKinds?: NodeKind[];
}
