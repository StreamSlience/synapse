/**
 * MCP 工具定义
 *
 * 定义 Synapse MCP 服务器暴露的工具。
 */

import type Synapse from '../index';
import { findNearestSynapseRoot } from '../directory';
// 将繁重的 Synapse 调用链延迟加载，脱离 MCP 启动路径——参见
// engine.ts 中的同名辅助函数。ToolHandler 必须加载以响应 tools/list
//（静态 schema），但在守护进程绑定之前，它绝不能拖入 sqlite/query 层；
// Synapse 仅在工具实际打开项目时才被引入。require() 是
// 同步且缓存的（CommonJS 构建）。
const loadSynapse = (): typeof import('../index').default =>
  (require('../index') as typeof import('../index')).default;
import {
  detectWorktreeIndexMismatch,
  worktreeMismatchWarning,
  worktreeMismatchNotice,
  type WorktreeIndexMismatch,
} from '../sync/worktree';
import type { PendingFile } from '../sync';
import type { Node, Edge, SearchResult, Subgraph, NodeKind } from '../types';
import { isTestFile, normalizeNameToken } from '../search/query-utils';
import {
  existsSync,
  readFileSync,
} from 'fs';
import { clamp, validatePathWithinRoot, validateProjectPath, isConfigLeafNode, CONFIG_LEAF_LANGUAGES } from '../utils';
import { isGeneratedFile } from '../extraction/generated-detection';
import { scanDynamicDispatch } from './dynamic-boundaries';

/**
 * 一种预期的、可恢复的"synapse 无法服务"状态——最典型的是项目没有索引。
 * 调度 catch 块将此类错误转换为成功形状的响应（指引文本，无 isError）：
 * 会话初期的 `isError: true` 会让智能体认为工具集损坏并完全停止调用 synapse
 *（多次观测到），而这对于智能体完全可以绕过的情况来说恰恰是错的
 *（使用内置工具处理该代码库 / 传入 projectPath）。
 * isError 保留给"停止尝试"的场景：安全拒绝（{@link PathRefusalError}）
 * 和真实故障。
 */
export class NotIndexedError extends Error {}

/**
 * 安全拒绝（敏感系统路径）。保持 `isError: true` 且不带重试指引——
 * 放弃此路径是期望的智能体反应。
 */
export class PathRefusalError extends Error {}
import { resolve as resolvePath } from 'path';

/** 防止上下文膨胀的最大输出长度（字符数） */
const MAX_OUTPUT_LENGTH = 15000;

/**
 * 自由格式字符串输入（query、task、symbol）的最大长度。
 * 限制内存和 CPU 消耗，防止有缺陷或恶意的 MCP 客户端发送巨型载荷——
 * 没有此限制，攻击者可发送 100MB 字符串并强制触发完整 FTS5 扫描/使服务器 OOM。
 * 10000 个字符远超任何合理的真实查询。
 */
const MAX_INPUT_LENGTH = 10_000;

/**
 * 路径类字符串输入（projectPath、路径过滤器、glob 模式）的最大长度。
 * 超过几千字符的路径从不合法，通常表明滥用或上游 bug。
 */
const MAX_PATH_LENGTH = 4_096;

/**
 * 没有文件系统对应物的 Rust 路径根——`crate` 是当前 crate，
 * `super` 是父模块，`self` 是当前模块。`matchesSymbol` 使用此集合
 * 在文件路径匹配前剥离这些前缀，使 `crate::configurator::stage_apply::run`
 * 与 `configurator::stage_apply::run` 解析为同一符号。
 */
const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

/**
 * 包含其他符号的节点类型。对于这些类型，`synapse_node` 在 `includeCode=true`
 * 时返回结构概要（成员名称 + 签名 + 行号），而非完整正文——
 * 大型类的完整正文是数千字符的源码，会使智能体的上下文膨胀。
 */
const CONTAINER_NODE_KINDS = new Set<NodeKind>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'namespace', 'module',
]);

/** 限定符号最后一段 `::` / `.` / `/` 分隔的部分。 */
function lastQualifierPart(symbol: string): string {
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

/**
 * 根据项目规模计算推荐的 synapse_explore 调用次数。
 * 较大的代码库需要更多探索调用以覆盖其表面积，
 * 较小的代码库应使用更少调用以避免不必要的开销。
 */
export function getExploreBudget(fileCount: number): number {
  if (fileCount < 500) return 1;
  if (fileCount < 5000) return 2;
  if (fileCount < 15000) return 3;
  if (fileCount < 25000) return 4;
  return 5;
}

/**
 * `synapse_explore` 的自适应输出预算，按项目规模缩放。
 *
 * 较小的代码库有更严格的总上限、更少的默认文件数、更小的
 * 单文件上限，以及更紧密的聚类——使对 100 个文件项目的精准查询
 * 不会将整个文件的源码倾倒进智能体上下文。较大的代码库保留宽松的默认值，
 * 因为智能体的原生发现成本（grep + find + 大量 Read）在那种规模下
 * 确实超过一次较大的 explore 调用。
 *
 * 元文本（关系图、"其他相关文件"列表、完整性信号、预算说明）
 * 对于极小项目被关闭——在那里一次丰富调用就是全部，额外的文字只是开销。
 *
 * 分层断点与 `getExploreBudget` 保持一致，使项目在两个参数中处于相同层级。
 */
export interface ExploreOutputBudget {
  /** 总输出字符数的硬上限。 */
  maxOutputChars: number;
  /** 调用方未指定时的默认 `maxFiles`。 */
  defaultMaxFiles: number;
  /** 每文件（跨所有聚类）返回的连续源码上限。 */
  maxCharsPerFile: number;
  /** 聚类间隔阈值（行数）——小项目使用更紧密的聚类。 */
  gapThreshold: number;
  /** 每文件头部（`#### 路径 — 符号(类型), ...`）中列出的最大符号数。 */
  maxSymbolsInFileHeader: number;
  /** 关系部分每种关系类型显示的最大边数。 */
  maxEdgesPerRelationshipKind: number;
  /** 是否包含"关系"章节。 */
  includeRelationships: boolean;
  /** 是否包含"其他相关文件（未显示）"尾部列表。 */
  includeAdditionalFiles: boolean;
  /** 是否包含"以上已包含完整源码…"提示。 */
  includeCompletenessSignal: boolean;
  /** 是否在末尾包含 explore 预算提示。 */
  includeBudgetNote: boolean;
  /**
   * 除非查询本身提到测试，否则从相关文件集合中硬删除测试/spec/图标/i18n 文件。
   * 目前它们只在排序中降权，对于极小的仓库，一个文件仍可能滑入前 N
   *（例如 cobra 的 `command_test.go` 挤掉了 `args.go`，
   * 为"cobra 如何解析命令？"贡献了约 10KB 的纯噪音）。
   * 默认关闭；对极小层级开启，因为一次滑入会主导整个预算。
   */
  excludeLowValueFiles: boolean;
}

export function getExploreOutputBudget(fileCount: number): ExploreOutputBudget {
  // 按项目规模分层的预算。预算是上限（相关性仍决定包含什么），
  // 且必须保持低于智能体的内联工具结果上限（约 25K 字符）。
  // 超过该上限，宿主会将结果外部化为文件，智能体随后读取——
  // 重新引入一次 read 和缓存写入成本——正是 vscode n=4 README A/B 中
  // 35K explore 所做的事。因此即使是大型仓库也上限约 24K：答案是
  // 智能体通过 grep 定位并读取的几个约 100 行流程窗口（原生读取
  // 约 6–9 个文件，中位数约 100 行范围），而非 12 个文件的大杂烩。
  // 聚焦于流程来自此上限 + 命名文件优先排序剔除外围文件。
  // 不变式：较大层级的 `maxCharsPerFile` 绝不能小于较小层级。
  if (fileCount < 150) {
    return {
      // ITER3：回退 iter2 激进的正文收缩（强制 Read 回退——
      // 2.5K 的单文件上限使智能体转而使用 Read 而非 node）。
      // 恢复为 iter1 的形态（13K/4/3.8K），但保留测试文件硬排除。
      // 此层级的成本杠杆在于引导智能体在 1–2 次调用后停止，
      // 而非调整此预算。
      maxOutputChars: 13000,
      defaultMaxFiles: 4,
      maxCharsPerFile: 3800,
      gapThreshold: 7,
      maxSymbolsInFileHeader: 5,
      maxEdgesPerRelationshipKind: 4,
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
      excludeLowValueFiles: true,
    };
  }
  if (fileCount < 500) {
    return {
      // ITER3：与 <150 的回退/保留过滤器模式相同。
      maxOutputChars: 18000,
      defaultMaxFiles: 5,
      maxCharsPerFile: 3800,
      gapThreshold: 8,
      maxSymbolsInFileHeader: 6,
      maxEdgesPerRelationshipKind: 6,
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
      excludeLowValueFiles: true,
    };
  }
  if (fileCount < 5000) {
    return {
      // 约 150 行单文件窗口（原生读取单元）× 约 6 个文件，上限约 24K 内联上限
      // 使响应不被外部化。单文件上限 ≥ <500 层级（3800）——单调递增。
      maxOutputChars: 24000,
      defaultMaxFiles: 8,
      maxCharsPerFile: 6500,
      gapThreshold: 12,
      maxSymbolsInFileHeader: 10,
      maxEdgesPerRelationshipKind: 10,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
      excludeLowValueFiles: false,
    };
  }
  // 大型 + 超大型仓库：相同的约 24K 内联上限（更大的响应只会被外部化——参见 vscode）。
  // 更多索引文件 → 通过 getExploreBudget 增加调用次数，而非更大的单次响应。
  // 单文件 7000（≥ 较小层级）给中心文件约 180 行的定向窗口。
  if (fileCount < 15000) {
    return {
      maxOutputChars: 24000,
      defaultMaxFiles: 8,
      maxCharsPerFile: 7000,
      gapThreshold: 15,
      maxSymbolsInFileHeader: 15,
      maxEdgesPerRelationshipKind: 15,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
      excludeLowValueFiles: false,
    };
  }
  return {
    maxOutputChars: 24000,
    defaultMaxFiles: 8,
    maxCharsPerFile: 7000,
    gapThreshold: 15,
    maxSymbolsInFileHeader: 15,
    maxEdgesPerRelationshipKind: 15,
    includeRelationships: true,
    includeAdditionalFiles: true,
    includeCompletenessSignal: true,
    includeBudgetNote: true,
    excludeLowValueFiles: false,
  };
}

/**
 * `synapse_explore` 是否应为源码行添加行号前缀（cat -n 风格：`<num>\t<code>`）。
 *
 * 行号使智能体能够直接从 explore 结果中引用 `文件:行号`，
 * 而无需重新读取文件来查找行号——这是精准追踪问题上残余的主要成本（#185 跟进）。
 *
 * 默认开启。设置 `SYNAPSE_EXPLORE_LINENUMS=0` 可禁用
 *（用于 A/B 测试框架，衡量载荷成本与读取节省之间的权衡）。
 */
function exploreLineNumbersEnabled(): boolean {
  return process.env.SYNAPSE_EXPLORE_LINENUMS !== '0';
}

/**
 * 自适应 explore 大小（默认开启）。`synapse_explore` 会对"非主干"多态兄弟文件
 * 进行骨架化——其类是共享接口的 ≥3 个可互换实现之一（例如 OkHttp 的 `: Interceptor` 类）——
 * 仅保留类和成员签名（正文省略），同时保留主干示例的完整内容。
 * 这使响应大小适配答案而非预算上限，用于兄弟文件较多的流程
 *（OkHttp 拦截器链 explore 从 28.5k 降至 16.6k，比原生搜索便宜约 28%，读取持平）。
 * 在其他场景下证明为无操作：不同的流程步骤（无 ≥3 个实现者的父类型，
 * 如 Excalidraw 的 `renderStaticScene`）和主干文件保留完整源码——
 * 输出与已发布的 excalidraw/tokio/django/vscode/gin 字节完全相同。
 * 设置 `SYNAPSE_ADAPTIVE_EXPLORE=0` 可禁用。
 */
function adaptiveExploreEnabled(): boolean {
  return process.env.SYNAPSE_ADAPTIVE_EXPLORE !== '0' && process.env.SYNAPSE_ADAPTIVE_EXPLORE !== 'false';
}

/**
 * 为源码片段的每行添加从 1 开始的行号前缀，与 Read 工具的 `cat -n`
 * 惯例（行号 + Tab）保持一致，使智能体以相同方式处理其输出。
 *
 * @param slice  连续的源码文本（已从文件中提取）
 * @param firstLineNumber  片段第一行从 1 开始的行号
 */
function numberSourceLines(slice: string, firstLineNumber: number): string {
  const out: string[] = [];
  const split = slice.split('\n');
  for (let i = 0; i < split.length; i++) {
    out.push(`${firstLineNumber + i}\t${split[i]}`);
  }
  return out.join('\n');
}

/**
 * 当文件监视器对响应引用的文件有待处理事件时，在工具响应顶部
 * 发出的单文件过期横幅。智能体使用此信息直接 Read 这些特定文件，
 * 无需等待防抖同步（issue #403）。
 */
export function formatStaleBanner(stale: PendingFile[]): string {
  const now = Date.now();
  const lines = stale.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    const label = p.indexing ? 'indexing in progress' : 'pending sync';
    return `  - ${p.path} (edited ${ageMs}ms ago, ${label})`;
  });
  return (
    '⚠️ Some files referenced below were edited since the last index sync — ' +
    'their synapse entries may be stale:\n' +
    lines.join('\n') +
    '\nFor accurate content of those specific files, Read them directly. ' +
    'The rest of this response is fresh.'
  );
}

/**
 * 列出本次响应中未引用的待处理文件的紧凑页脚。
 * 为智能体提供完整的项目级新鲜度全貌，
 * 同时不使主横幅膨胀。
 */
export function formatStaleFooter(stale: PendingFile[]): string {
  const MAX = 5;
  const now = Date.now();
  const shown = stale.slice(0, MAX);
  const lines = shown.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    return `  - ${p.path} (edited ${ageMs}ms ago)`;
  });
  const more = stale.length > MAX ? `\n  - …and ${stale.length - MAX} more` : '';
  return (
    `(Note: ${stale.length} file(s) elsewhere in this project are pending index ` +
    `sync but were not referenced above:\n${lines.join('\n')}${more})`
  );
}

/**
 * 全量索引降级横幅（issue #876）。当实时监视永久停止时，在读取工具响应顶部发出——
 * 此时 `getPendingFiles()` 为空，因此上述单文件横幅无法触发，
 * 即使索引现已冻结并静默漂移为过时状态。以智能体可操作的指令开头（直接 Read），
 * 并附带原因，其中已提及操作者的修复措施（`synapse sync` / git hooks）。
 */
export function formatDegradedBanner(reason: string | null): string {
  return (
    '⚠️ Synapse auto-sync is DISABLED — live file watching stopped, so the index is ' +
    'frozen and any file edited since then is stale here. Read files directly to confirm ' +
    'current content before relying on it.' +
    (reason ? `\n  Reason: ${reason}` : '')
  );
}

/**
 * MCP 工具定义
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
}

interface PropertySchema {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

/**
 * 跨项目查询的通用 projectPath 属性
 */
const projectPathProperty: PropertySchema = {
  type: 'string',
  description: '已初始化 .synapse/ 的其他项目路径。省略则使用当前项目。可用于查询其他代码库。',
};

/**
 * 全部 Synapse MCP 工具
 *
 * 设计原则：最小化上下文使用——以 synapse_explore 为主工具
 *（通常一次调用即可回答整个问题），其他工具仅用于有针对性的后续查询。
 *
 * 所有工具均通过可选的 `projectPath` 参数支持跨项目查询。
 */
export const tools: ToolDefinition[] = [
  {
    name: 'synapse_search',
    description: '按名称快速搜索符号。仅返回位置（不含代码）。如需获取实际源码或一次性理解某个区域，请改用 synapse_explore。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '符号名称或部分名称（例如 "auth"、"signIn"、"UserService"）',
        },
        kind: {
          type: 'string',
          description: '按节点类型过滤',
          enum: ['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component'],
        },
        limit: {
          type: 'number',
          description: '最大结果数（默认：10）',
          default: 10,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
  },
  {
    name: 'synapse_callers',
    description: '列出调用 <symbol> 的函数。如需查看完整调用流程，请使用 synapse_explore。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '要查找调用者的函数、方法或类的名称',
        },
        file: {
          type: 'string',
          description: '当存在多个同名符号时（例如单仓库中每个应用各有一个 UserService），通过文件路径或后缀缩小到指定文件中的定义',
        },
        limit: {
          type: 'number',
          description: '返回的最大调用者数量（默认：20）',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'synapse_callees',
    description: '列出 <symbol> 调用的函数。如需查看完整调用流程，请使用 synapse_explore。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '要查找被调用者的函数、方法或类的名称',
        },
        file: {
          type: 'string',
          description: '当存在多个同名符号时，通过文件路径或后缀缩小到指定文件中的定义',
        },
        limit: {
          type: 'number',
          description: '返回的最大被调用者数量（默认：20）',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'synapse_impact',
    description: '列出修改 <symbol> 后受影响的符号。在重构前使用。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '要分析影响范围的符号名称',
        },
        file: {
          type: 'string',
          description: '当存在多个同名符号时，通过文件路径或后缀缩小到指定文件中的定义',
        },
        depth: {
          type: 'number',
          description: '遍历依赖关系的层数（默认：2）',
          default: 2,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'synapse_node',
    description: '两种模式。（1）读取文件——替代 Read 工具：仅传入 `file`（路径或基名），不传 `symbol`，返回该文件当前磁盘源码及行号，格式与 Read 完全一致（`<n>\\t<行>`，可直接用于 Edit），支持 `offset`/`limit` 缩窄，与 Read 用法相同——并附带一行依赖说明。字节与 Read 完全相同，速度更快（由索引提供），并附带影响范围。在需要读取源文件时优先使用此工具。（2）指定一个符号——一次调用即可获得其位置、签名、逐字源码（includeCode=true）及调用者/被调用者路径，方便在修改前了解调用关系和可能受影响的内容。对于有歧义的名称，一次调用即返回所有匹配定义的正文（无需读取文件来找到正确的重载）；可通过 `file`/`line` 精确定位。如需查看多个相关符号或完整调用流程，请使用 synapse_explore。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: '要读取的符号名称（符号模式）。省略此参数并单独传入 `file` 即可像 Read 工具一样读取整个文件。',
        },
        includeCode: {
          type: 'boolean',
          description: '符号模式：是否包含符号的完整正文（默认：false）。文件模式下忽略此参数，文件模式始终返回源码（除非设置了 `symbolsOnly`）。',
          default: false,
        },
        file: {
          type: 'string',
          description: '文件路径或基名（例如 "harness.rs"、"src/auth/session.ts"）。单独传入（不带 symbol）即可像 Read 工具一样读取文件——返回带行号的完整源码及依赖该文件的其他文件。与 symbol 一起传入时，可将同名重载消歧到指定文件中的定义。',
        },
        offset: {
          type: 'number',
          description: '文件模式：从第几行开始读取（1 起计），与 Read 的 offset 用法完全一致。默认从文件开头开始。',
        },
        limit: {
          type: 'number',
          description: '文件模式：最多返回的行数，与 Read 的 limit 用法完全一致。默认返回整个文件（上限 2000 行，与 Read 一致）。',
        },
        symbolsOnly: {
          type: 'boolean',
          description: '文件模式：仅返回文件的符号映射及依赖方（轻量结构概览），而非源码。',
          default: false,
        },
        line: {
          type: 'number',
          description: '仅限符号模式：消歧到指定行号处/附近的定义（与调用链中显示的 file:line 配合使用）。',
        },
        projectPath: projectPathProperty,
      },
      required: [],
    },
  },
  {
    name: 'synapse_explore',
    description: '主工具——几乎任何问题或编辑前都应优先调用：了解 X 的工作原理、查看架构、排查 bug、定位 X 是什么/在哪里、概览某个区域，或查看即将修改的符号。一次调用即返回相关符号的逐字源码（按文件分组，等同于已 Read——不要再重新打开这些文件），以及符号间的调用路径。查询可以是自然语言问题，也可以是一组符号/文件名。通常是唯一需要的调用——比 search/Read/Grep 循环更准确，token 和往返次数大幅减少。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要探索的符号名称、文件名或简短代码术语（例如 "AuthService loginUser session-manager"、"GraphTraverser BFS impact traversal.ts"）。对于流程问题，列出跨越该流程的符号（例如 "mutateElement renderScene"）。也可以直接输入自然语言问题——无需事先调用 synapse_search。',
        },
        maxFiles: {
          type: 'number',
          description: '包含源码的最大文件数（默认：12）',
          default: 12,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
  },
  {
    name: 'synapse_status',
    description: '索引健康检查（文件数 / 节点数 / 边数）。仅在调试时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty,
      },
    },
  },
  {
    name: 'synapse_files',
    description: '带语言和符号数量的已索引文件树。比 Glob 更快地了解项目结构。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '过滤到此目录路径下的文件（例如 "src/components"）。不指定则返回所有文件。',
        },
        pattern: {
          type: 'string',
          description: '过滤匹配此 glob 模式的文件（例如 "*.tsx"、"**/*.test.ts"）',
        },
        format: {
          type: 'string',
          description: '输出格式："tree"（层级树，默认）、"flat"（简单列表）、"grouped"（按语言分组）',
          enum: ['tree', 'flat', 'grouped'],
          default: 'tree',
        },
        includeMetadata: {
          type: 'boolean',
          description: '是否包含语言和符号数量等文件元数据（默认：true）',
          default: true,
        },
        maxDepth: {
          type: 'number',
          description: '显示的最大目录深度（默认：不限）',
        },
        projectPath: projectPathProperty,
      },
    },
  },
];

/**
 * 无引擎时的白名单过滤工具定义——代理在任何项目打开前
 * 用于回答 `tools/list` 的静态接口。与无 Synapse 情况下的
 * `ToolHandler.getTools()` 保持一致（描述中的动态每仓库预算说明
 * 仅在 `cg` 加载后添加；schema 是静态的）。
 */
export function getStaticTools(): ToolDefinition[] {
  const raw = process.env.SYNAPSE_MCP_TOOLS;
  if (!raw || !raw.trim()) {
    return tools.filter(t => DEFAULT_MCP_TOOLS.has(t.name.replace(/^synapse_/, '')));
  }
  const allow = new Set(raw.split(',').map(s => s.trim().replace(/^synapse_/, '')).filter(Boolean));
  return allow.size ? tools.filter(t => allow.has(t.name.replace(/^synapse_/, ''))) : tools;
}

/**
 * 默认提供给智能体的 MCP 工具（短名称）。其他已定义的工具
 *（callees、impact、files、status）仍然完全可用——处理器保留，
 * 库 API 和 CLI 不受影响，`SYNAPSE_MCP_TOOLS` 可重新启用其中任何工具——
 * 只是不再对智能体列出。
 *
 * 删减的依据（"适配工具到智能体"原则——
 * 工具越少 = 误选越少，工具的存在本身就会引导行为）：
 * - `synapse_impact` 在所有已记录的 eval 运行中从未出现过——
 *   其影响半径信息已内联在 explore（"Blast radius"节）和 node
 *（依赖方说明）中，因此智能体从不需要独立工具。
 * - `synapse_callees` 在构造上是冗余的：符号的正文（node 返回的）
 *   本身就是其被调用列表，加上调用者/被调用者路径。
 * - `synapse_files` / `synapse_status`：小型仓库审计（参见 getTools）
 *   发现它们"归结为一次 grep"；每次读取工具上的过期横幅
 *   已内联待同步信息，CLI 已覆盖诊断需求。
 * - `synapse_callers` 保留：穷举调用点枚举（每个调用者含文件:行号、
 *   回调注册标记、每个同名定义一节）是 explore/node 不重复的唯一功能。
 */
const DEFAULT_MCP_TOOLS = new Set(['explore', 'node', 'search', 'callers']);

/**
 * 针对 Synapse 实例执行工具的工具处理器
 *
 * 通过 projectPath 参数支持跨项目查询。
 * 其他项目按需打开并缓存以提升性能。
 */
export class ToolHandler {
  // 跨项目查询已打开的 Synapse 实例缓存
  private projectCache: Map<string, Synapse> = new Map();
  // 服务器上次搜索默认项目的目录。在"未初始化"错误中暴露，
  // 使用户可以看到为何检测未能找到项目。
  private defaultProjectHint: string | null = null;
  // 按起始路径缓存 git worktree/index 不匹配（issue #155）。
  // 不匹配是（请求来源 → 解析到哪个 .synapse/）的固定属性，
  // 因此最多两次 `git rev-parse` 调用只执行一次，之后所有工具调用复用结果——
  // 在热路径上不再 shell 出 git。`undefined` = 尚未计算；`null` = 无不匹配。
  private worktreeMismatchCache: Map<string, WorktreeIndexMismatch | null> = new Map();
  // MCP 引擎在 `cg.open()` 后触发的门控，使第一次工具调用
  // 阻塞于打开后的文件系统对账（追赶同步）。没有此门控，
  // 竞争跨越 `catchUpSync()` 的工具调用会返回已删除（或已编辑）文件的行——
  // 因为 `getPendingFiles()` 由监视器填充，而非追赶同步。
  // 首次 await 后清除，使后续调用无额外开销。
  private catchUpGate: Promise<void> | null = null;

  constructor(private cg: Synapse | null) {}

  /**
   * 更新默认 Synapse 实例（例如延迟初始化后）
   */
  setDefaultSynapse(cg: Synapse): void {
    this.cg = cg;
  }

  /**
   * 仅限引擎：注册追赶同步 Promise，使下一次 `execute()` 调用
   * 在响应前等待它。处理器会吞掉拒绝（引擎会记录），使同步失败
   * 不会作为工具错误传播；我们仍希望在潜在过时的数据上提供尽力而为的结果，
   * 这与没有门控时的行为一致。
   */
  setCatchUpGate(p: Promise<void> | null): void {
    this.catchUpGate = p;
  }

  /**
   * 记录服务器尝试解析默认项目的目录。
   * 仅用于使"无默认项目"错误可操作。
   */
  setDefaultProjectHint(searchedPath: string): void {
    this.defaultProjectHint = searchedPath;
  }

  /**
   * 是否有可用的默认 Synapse 实例
   */
  hasDefaultSynapse(): boolean {
    return this.cg !== null;
  }

  /**
   * 暴露工具的可选白名单，从 SYNAPSE_MCP_TOOLS 环境变量解析
   *（逗号分隔的短名称，例如 "trace,search,node,context"）。
   * 未设置/为空 → 暴露所有工具。允许操作者（或 A/B 测试框架）
   * 在无需重建客户端配置的情况下裁剪工具接口；被裁剪的工具
   * 将真正从 ListTools 中缺席，而非仅在调用时被拒绝。
   * 匹配基于短名称形式，因此 "node" 和 "synapse_node" 均有效。
   */
  private toolAllowlist(): Set<string> | null {
    const raw = process.env.SYNAPSE_MCP_TOOLS;
    if (!raw || !raw.trim()) return null;
    const short = (s: string) => s.trim().replace(/^synapse_/, '');
    const set = new Set(raw.split(',').map(short).filter(Boolean));
    return set.size ? set : null;
  }

  /** 工具名称是否通过 SYNAPSE_MCP_TOOLS 白名单（如果有）。 */
  private isToolAllowed(name: string): boolean {
    const allow = this.toolAllowlist();
    return !allow || allow.has(name.replace(/^synapse_/, ''));
  }

  /**
   * 根据项目规模获取带有动态描述的工具定义。
   * synapse_explore 工具描述中包含根据已索引文件数缩放的预算建议。
   * 遵循 SYNAPSE_MCP_TOOLS 白名单，使 ListTools 反映裁剪后的接口。
   */
  getTools(): ToolDefinition[] {
    const allow = this.toolAllowlist();
    // 无明确白名单 → 默认 4 工具接口（参见 DEFAULT_MCP_TOOLS 的依据）。
    // 白名单完全替换默认接口，因此任何已定义的工具均可重新启用。
    let visible = allow
      ? tools.filter(t => allow.has(t.name.replace(/^synapse_/, '')))
      : tools.filter(t => DEFAULT_MCP_TOOLS.has(t.name.replace(/^synapse_/, '')));
    if (!this.cg) return visible;

    try {
      const stats = this.cg.getStats();
      const budget = getExploreBudget(stats.fileCount);

      // 极小仓库工具门控：对于文件数低于 TINY_REPO_FILE_THRESHOLD 的项目，
      // 仅暴露核心三件套（search、node、explore）——比默认 4 工具少一个：
      // 在这种规模下，callers 也可以归结为一次 grep。
      //（历史说明：以下审计在 context 和 trace 仍存在时进行；其"5 个核心工具"
      // 对应今天的三件套。）
      //
      // n=2 审计排除了减到 5 工具以下的方案：
      // - 3 工具门控（search + context + trace）：成本在 cobra/ky/sinatra 上回退。
      //   智能体退回到原始 Read 来覆盖 synapse_node + synapse_explore 本可回答的内容。
      // - 1 工具门控（仅 search）：灾难性回退——express 从 -43% 胜利变为 +107% 失败。
      //   仅有 search 时，智能体无法在结构上导航调用图，只能读取所有内容。
      //
      // 5 是经验下限。超出 search/context/node/explore/trace 的工具
      // 在极小仓库流程问题上产生智能体无法收回的开销。
      // ITER4：将阈值从 150 提升至 500，使单文件框架
      //（sinatra 约 159 个文件，slim_framework 约 200 个）也获得 5 工具接口。
      // 经验 5 工具下限基于 <150 的探测；iter3 测量显示 sinatra
      // 在结构上与 cobra（单文件无 synapse 时 Read 胜出）是同一问题，
      // 因此应采用相同的门控。
      const TINY_REPO_FILE_THRESHOLD = 500;
      const TINY_REPO_CORE_TOOLS = new Set([
        'synapse_explore',
        'synapse_search',
        'synapse_node',
      ]);
      if (stats.fileCount < TINY_REPO_FILE_THRESHOLD) {
        visible = visible.filter(t => TINY_REPO_CORE_TOOLS.has(t.name));
      }

      return visible.map(tool => {
        if (tool.name === 'synapse_explore') {
          return {
            ...tool,
            description: `${tool.description} 预算：本项目最多调用 ${budget} 次（已索引 ${stats.fileCount.toLocaleString()} 个文件）。`,
          };
        }
        return tool;
      });
    } catch {
      return visible;
    }
  }

  /**
   * 获取项目的 Synapse 实例
   *
   * 若提供了 projectPath，则打开该项目的 Synapse（已缓存）。
   * 否则返回默认 Synapse 实例。
   *
   * 向上遍历父目录查找最近的 .synapse/ 文件夹，
   * 类似 git 查找 .git/ 目录的方式。
   */
  private getSynapse(projectPath?: string): Synapse {
    if (!projectPath) {
      if (!this.cg) {
        const searched = this.defaultProjectHint ?? process.cwd();
        throw new NotIndexedError(
          'No Synapse project is loaded for this session.\n' +
          `Searched for a .synapse/ directory starting from: ${searched}\n` +
          'If this project IS indexed, this is a working-directory detection issue: ' +
          "the MCP client launched the server outside your project and didn't report the " +
          'workspace root. Fix it either way:\n' +
          '  • Pass projectPath to the tool call, e.g. projectPath: "/absolute/path/to/your/project"\n' +
          '  • Or add --path to the server\'s MCP config args: ["serve", "--mcp", "--path", "/absolute/path/to/your/project"]\n' +
          'If the project simply has no index, continue with your built-in tools (Read/Grep/Glob) ' +
          "and don't call synapse again this session — the user can run 'synapse init' to enable it."
        );
      }
      return this.cg;
    }

    // 先检查缓存（使用原始路径作为键）
    if (this.projectCache.has(projectPath)) {
      return this.projectCache.get(projectPath)!;
    }

    // 在打开之前拒绝敏感系统目录。仅对实际存在的路径进行验证——
    // 真实项目的嵌套或尚未创建的子路径仍必须允许向上解析到其
    // .synapse/ 根（issue #238），因此我们不对旨在向上遍历的路径
    // 运行存在性检查验证器。
    if (existsSync(projectPath)) {
      const pathError = validateProjectPath(projectPath);
      if (pathError) {
        throw new PathRefusalError(pathError);
      }
    }

    // 向上遍历父目录查找最近的 .synapse/
    const resolvedRoot = findNearestSynapseRoot(projectPath);

    if (!resolvedRoot) {
      throw new NotIndexedError(
        `The project at ${projectPath} isn't indexed with synapse (no .synapse/ directory found ` +
        'walking up from it), so synapse cannot query it. Use your built-in tools (Read/Grep/Glob) ' +
        "for that codebase instead, and don't call synapse for it again this session. " +
        "Indexing is the user's decision — they can run 'synapse init' in that project to enable it."
      );
    }

    // 若路径解析到默认项目，复用已打开的默认实例，
    // 而非对同一数据库打开第二个连接。
    // 重复连接会将读操作与监视器自动同步写操作序列化；
    // 在 wasm 后端（无 WAL）上，这会在并发工具调用时表现为
    // 间歇性"数据库被锁定"错误。参见 issue #238。
    // 故意不在 projectPath 下缓存——服务器拥有并关闭默认实例，
    // 通过 projectCache.closeAll() 路由会导致双重关闭。
    if (this.cg && this.cg.getProjectRoot() === resolvedRoot) {
      return this.cg;
    }

    // 检查已解析根路径是否已缓存（不同路径，相同项目）
    if (this.projectCache.has(resolvedRoot)) {
      const cg = this.projectCache.get(resolvedRoot)!;
      // 也在原始路径下缓存，加速未来查找
      this.projectCache.set(projectPath, cg);
      return cg;
    }

    // 打开并在两个路径下缓存
    const cg = loadSynapse().openSync(resolvedRoot);
    this.projectCache.set(resolvedRoot, cg);
    if (projectPath !== resolvedRoot) {
      this.projectCache.set(projectPath, cg);
    }
    return cg;
  }

  /**
   * 关闭所有已缓存的项目连接
   */
  closeAll(): void {
    for (const cg of this.projectCache.values()) {
      cg.close();
    }
    this.projectCache.clear();
    this.worktreeMismatchCache.clear();
  }

  /**
   * 校验值是否为非空字符串且在长度限制之内。
   *
   * `maxLength` 上限用于防止 MCP 客户端发送巨型载荷
   *（无论是意外还是恶意的 10MB+ 查询字符串）。
   * 没有此限制，单个超大输入可能在任何实际工作开始之前
   * 就使 FTS5 索引挂起或耗尽内存。
   */
  private validateString(
    value: unknown,
    name: string,
    maxLength: number = MAX_INPUT_LENGTH
  ): string | ToolResult {
    if (typeof value !== 'string' || value.length === 0) {
      return this.errorResult(`${name} must be a non-empty string`);
    }
    if (value.length > maxLength) {
      return this.errorResult(
        `${name} exceeds maximum length of ${maxLength} characters (got ${value.length})`
      );
    }
    return value;
  }

  /**
   * 校验可选路径类字符串输入。若有效则返回值（或 undefined），
   * 否则返回含错误信息的 ToolResult。
   */
  private validateOptionalPath(
    value: unknown,
    name: string
  ): string | undefined | ToolResult {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      return this.errorResult(`${name} must be a string`);
    }
    if (value.length > MAX_PATH_LENGTH) {
      return this.errorResult(
        `${name} exceeds maximum length of ${MAX_PATH_LENGTH} characters (got ${value.length})`
      );
    }
    return value;
  }

  /**
   * 工具调用有效项目的已缓存 git worktree/index 不匹配。
   *
   * "有效项目"是请求的目标：显式 `projectPath` 参数，否则为服务器
   * 解析其默认项目的目录（`defaultProjectHint`），否则为 cwd。
   * 按起始路径记忆——参见 `worktreeMismatchCache`。尽力而为：
   * 若项目无法解析（例如尚未初始化），报告"无不匹配"，
   * 使工具不因此检查而损坏。
   */
  private worktreeMismatchFor(projectPath?: string): WorktreeIndexMismatch | null {
    const startPath = projectPath ?? this.defaultProjectHint ?? process.cwd();
    const cached = this.worktreeMismatchCache.get(startPath);
    if (cached !== undefined) return cached;

    let mismatch: WorktreeIndexMismatch | null = null;
    try {
      mismatch = detectWorktreeIndexMismatch(startPath, this.getSynapse(projectPath).getProjectRoot());
    } catch {
      // 无可解析的项目（或任何其他解析错误）→ 无需警告。
      mismatch = null;
    }
    this.worktreeMismatchCache.set(startPath, mismatch);
    return mismatch;
  }

  /**
   * 当已解析索引属于与调用方不同的 git 工作树时，在成功的读取工具结果前
   * 添加紧凑的 worktree 不匹配提示（issue #155）。没有此提示，嵌套 worktree
   * 中的智能体会静默信任主分支结果。对错误结果和无不匹配时为无操作。
   * `synapse_status` 被排除——它嵌入了自己的详细警告——因此不走此路径。
   */
  private withWorktreeNotice(result: ToolResult, projectPath?: string): ToolResult {
    if (result.isError) return result;
    const mismatch = this.worktreeMismatchFor(projectPath);
    if (!mismatch) return result;

    const notice = worktreeMismatchNotice(mismatch);
    const [first, ...rest] = result.content;
    if (first && first.type === 'text') {
      return { ...result, content: [{ type: 'text', text: `${notice}\n\n${first.text}` }, ...rest] };
    }
    return result;
  }

  /**
   * 为成功的读取工具结果标注单文件过期信息——issue #403 的非阻塞解决方案。
   * 文件监视器按路径跟踪每个事件；此处我们将"此响应引用的文件"
   * 与待处理集合取交集，并在前面添加紧凑横幅，使智能体能够对*特定*文件
   * 直接使用 Read，而无需等待防抖同步触发。项目中其他待处理文件
   *（本次响应未引用）在页脚中显示，使智能体获得完整信息而不使横幅膨胀。
   *
   * 无待处理时（常见情况）的成本——仅一次布尔值检查。
   * 无 I/O，无 markdown 解析，仅针对每个待处理文件进行子字符串扫描。
   */
  private withStalenessNotice(result: ToolResult, projectPath?: string): ToolResult {
    if (result.isError) return result;

    let cg: Synapse;
    try {
      cg = this.getSynapse(projectPath);
    } catch {
      return result; // 无默认项目——保持原样
    }

    // 跨项目 `projectPath` 调用打开的是无监视器的缓存 Synapse
    //（监视器仅附加到默认会话项目）。
    // 当跨项目路径恰好与默认 cg 是同一项目时，缓存实例不正确——
    // 其 pendingFiles 永远为空。检测等路径情况并优先使用默认 cg，
    // 使智能体以显式 projectPath 形式传入其自身项目时，过期信号仍能触发。
    if (this.cg && cg !== this.cg) {
      try {
        const sameProject =
          resolvePath(this.cg.getProjectRoot()) === resolvePath(cg.getProjectRoot());
        if (sameProject) cg = this.cg;
      } catch {
        /* getProjectRoot 可能在已关闭的实例上抛出——保持 cg 原样 */
      }
    }

    // 全量索引降级（#876）：一旦实时监视永久停止，
    // getPendingFiles() 为空，下方的单文件横幅无法触发——
    // 但索引现已冻结并静默漂移为过时状态。改为显示一条全局提示，
    // 使智能体读取最新内容，而非信任一个不再更新的索引的响应。
    //（跨项目调用打开无监视器的 Synapse，因此此处为 false——正确：
    // 我们只知道默认会话项目的降级状态。）
    let degraded = false;
    try {
      degraded = cg.isWatcherDegraded?.() ?? false;
    } catch {
      degraded = false;
    }
    if (degraded) {
      const [head, ...tail] = result.content;
      if (!head || head.type !== 'text') return result;
      let reason: string | null = null;
      try {
        reason = cg.getWatcherDegradedReason?.() ?? null;
      } catch {
        reason = null;
      }
      const composed = `${formatDegradedBanner(reason)}\n\n${head.text}`;
      return { ...result, content: [{ type: 'text', text: composed }, ...tail] };
    }

    // 防御性措施：某些测试 fake 注入了不含较新待处理文件 API 的
    // 部分 Synapse stub。将缺失/抛出视为"无待处理文件"。
    let pending: PendingFile[] = [];
    try {
      pending = cg.getPendingFiles?.() ?? [];
    } catch {
      return result;
    }
    if (pending.length === 0) return result;

    const [first, ...rest] = result.content;
    if (!first || first.type !== 'text') return result;

    const text = first.text;
    const inResponse: PendingFile[] = [];
    const elsewhere: PendingFile[] = [];
    for (const p of pending) {
      // 对响应内容中的项目相对 POSIX 路径进行子字符串匹配——
      // 这正是监视器和每个 synapse 响应发出的格式，
      // 因此简单的 includes() 就足够了，避免了正则的坑。
      if (text.includes(p.path)) inResponse.push(p);
      else elsewhere.push(p);
    }

    let banner = '';
    if (inResponse.length > 0) {
      banner = formatStaleBanner(inResponse);
    }
    let footer = '';
    if (elsewhere.length > 0) {
      footer = formatStaleFooter(elsewhere);
    }
    if (!banner && !footer) return result;

    const composed = [banner, text, footer].filter(Boolean).join('\n\n');
    return { ...result, content: [{ type: 'text', text: composed }, ...rest] };
  }

  /**
   * 按名称执行工具
   */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      // 阻塞第一次工具调用，等待引擎打开后的对账，
      // 确保我们不会为在 MCP 服务器未运行期间被删除/编辑的文件返回行。
      // 门控在首次 await 后清除——后续调用无开销。
      // 追赶失败由引擎记录；无论如何我们都继续，使瞬时同步错误不会导致工具损坏。
      if (this.catchUpGate) {
        const gate = this.catchUpGate;
        this.catchUpGate = null;
        try { await gate; } catch { /* 引擎已记录 */ }
      }
      // 遵循可选工具白名单（SYNAPSE_MCP_TOOLS）：裁剪后的接口
      // 会防御性地拒绝已被删除的工具，即使客户端缓存了它们。
      if (!this.isToolAllowed(toolName)) {
        return this.errorResult(`Tool ${toolName} is disabled via SYNAPSE_MCP_TOOLS`);
      }
      // 横切输入校验。所有工具均接受可选的 `projectPath`，大多数工具接受
      // `query`、`task` 或 `symbol` 之一——在此集中限制其长度，
      // 使各处理器能专注于工具特定的逻辑。
      const pathCheck = this.validateOptionalPath(args.projectPath, 'projectPath');
      if (typeof pathCheck === 'object' && pathCheck !== undefined) {
        return pathCheck;
      }
      // synapse_files 使用的 `path` 和 `pattern` 属性也是路径形态——
      // 应用相同的上限。
      if (args.path !== undefined) {
        const check = this.validateOptionalPath(args.path, 'path');
        if (typeof check === 'object' && check !== undefined) return check;
      }
      if (args.pattern !== undefined) {
        const check = this.validateOptionalPath(args.pattern, 'pattern');
        if (typeof check === 'object' && check !== undefined) return check;
      }

      // 读取工具通过单个 result 变量解析，使横切通知——
      // worktree/index 不匹配（issue #155）和单文件过期（issue #403）——
      // 可在一处应用。status 嵌入了自己的详细 worktree 警告，
      // 但仍流经过期封装器，使其待处理文件节与读取工具一致。
      let result: ToolResult;
      switch (toolName) {
        case 'synapse_search':
          result = await this.handleSearch(args); break;
        case 'synapse_callers':
          result = await this.handleCallers(args); break;
        case 'synapse_callees':
          result = await this.handleCallees(args); break;
        case 'synapse_impact':
          result = await this.handleImpact(args); break;
        case 'synapse_explore':
          result = await this.handleExplore(args); break;
        case 'synapse_node':
          result = await this.handleNode(args); break;
        case 'synapse_status':
          // status 将待处理文件列表作为一级章节内嵌（参见 handleStatus），
          // 因此此处跳过自动横幅封装器，避免在响应顶部重复相同信息。
          return await this.handleStatus(args);
        case 'synapse_files':
          result = await this.handleFiles(args); break;
        default:
          return this.errorResult(`Unknown tool: ${toolName}`);
      }
      const withWorktree = this.withWorktreeNotice(result, args.projectPath as string | undefined);
      return this.withStalenessNotice(withWorktree, args.projectPath as string | undefined);
    } catch (err) {
      // 预期状态，非故障：以成功形式响应，使智能体对已索引的项目
      // 继续信任工具集。（此处的 isError 会导致整个会话的放弃——参见 NotIndexedError。）
      if (err instanceof NotIndexedError) {
        return this.textResult(err.message);
      }
      // 安全拒绝：干净的错误，不鼓励重试。
      if (err instanceof PathRefusalError) {
        return this.errorResult(err.message);
      }
      return this.errorResult(
        `Tool execution failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'This is an internal synapse error — retry the call once; if it persists, ' +
        'continue without synapse for this task.'
      );
    }
  }

  /**
   * 处理 synapse_search
   */
  private async handleSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const cg = this.getSynapse(args.projectPath as string | undefined);
    const rawKind = args.kind as string | undefined;
    // schema 枚举使用 'type'（智能体自然会用的值）；
    // NodeKind 是 'type_alias'。没有此映射，kind: "type" 会静默匹配不到任何内容——
    // 我们公示的过滤器值必须有效。
    const kind = rawKind === 'type' ? 'type_alias' : rawKind;
    const rawLimit = Number(args.limit) || 10;
    const limit = clamp(rawLimit, 1, 100);

    const results = cg.searchNodes(query, {
      limit,
      kinds: kind ? [kind as NodeKind] : undefined,
    });

    if (results.length === 0) {
      return this.textResult(`No results found for "${query}"`);
    }

    // 在 FTS 返回集合中降权生成文件，使搜索 "Send" 时
    // 手写的目标文件排在共享该名称的 .pb.go 桩文件之前。稳定：仅重排生成与非生成文件。
    const ranked = [...results].sort((a, b) => {
      const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
      const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
      return aGen - bGen;
    });

    const formatted = this.formatSearchResults(ranked);
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * 将符号匹配分组为不同的定义——每组对应一个
   *（filePath, qualifiedName）对，使同文件重载保持在一起，
   * 而单仓库各应用中无关的同名类（#764：每个 NestJS 应用一个 `UserService`）
   * 保持分离。可先通过 `file` 路径/后缀缩小范围。
   */
  private groupDefinitions(
    nodes: Node[],
    fileFilter: string | undefined
  ): { groups: Node[][]; filteredOut: boolean } {
    let pool = nodes;
    let filteredOut = false;
    if (fileFilter) {
      const wanted = fileFilter.replace(/^\.\//, '');
      const narrowed = pool.filter(
        (n) => n.filePath === wanted || n.filePath.endsWith(wanted) || n.filePath.endsWith(`/${wanted}`)
      );
      if (narrowed.length > 0) {
        pool = narrowed;
      } else {
        filteredOut = true;
      }
    }
    const byDef = new Map<string, Node[]>();
    for (const n of pool) {
      const key = `${n.filePath}|${n.qualifiedName}`;
      const group = byDef.get(key);
      if (group) group.push(n);
      else byDef.set(key, [n]);
    }
    return { groups: [...byDef.values()], filteredOut };
  }

  /** 分组输出中单个不同定义的节标题。 */
  private definitionHeading(group: Node[]): string {
    const head = group[0]!;
    const line = head.startLine ? `:${head.startLine}` : '';
    return `### ${head.qualifiedName} (${head.kind}) — ${head.filePath}${line}`;
  }

  /**
   * 处理 synapse_callers
   */
  private async handleCallers(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getSynapse(args.projectPath as string | undefined);
    const limit = clamp((args.limit as number) || 20, 1, 100);
    const fileFilter = typeof args.file === 'string' ? args.file : undefined;

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    const { groups, filteredOut } = this.groupDefinitions(allMatches.nodes, fileFilter);
    const filterNote = filteredOut
      ? `\n\n> **Note:** no definition of "${symbol}" matches file "${fileFilter}" — showing all definitions instead.`
      : '';

    const collect = (defNodes: Node[]) => {
      const seen = new Set<string>();
      const callers: Node[] = [];
      const labels = new Map<string, string>();
      for (const node of defNodes) {
        for (const c of cg.getCallers(node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            callers.push(c.node);
            const label = this.edgeLabel(c.edge);
            if (label) labels.set(c.node.id, label);
          }
        }
      }
      return { callers, labels };
    };

    // 单一定义（或同文件重载）：熟悉的平铺列表。
    if (groups.length === 1) {
      const { callers, labels } = collect(groups[0]!);
      if (callers.length === 0) {
        return this.textResult(`No callers found for "${symbol}"${allMatches.note}${filterNote}`);
      }
      // 成功的 `file` 缩小使多符号聚合说明失效——抑制它。
      const note = fileFilter && !filteredOut ? '' : allMatches.note;
      const formatted = this.formatNodeList(callers.slice(0, limit), `Callers of ${symbol}`, labels) + note + filterNote;
      return this.textResult(this.truncateOutput(formatted));
    }

    // 多个不同定义（#764）：每个定义一节，使智能体不会将一个应用的调用者
    // 误认为另一个应用的。使用 `file` 聚焦单一定义。
    const lines: string[] = [
      `## Callers of ${symbol} — ${groups.length} distinct definitions (narrow with \`file\`)`,
    ];
    for (const group of groups) {
      const { callers, labels } = collect(group);
      lines.push('', this.definitionHeading(group));
      if (callers.length === 0) {
        lines.push('- (no callers)');
        continue;
      }
      for (const node of callers.slice(0, limit)) {
        const location = node.startLine ? `:${node.startLine}` : '';
        const label = labels.get(node.id);
        lines.push(`- ${node.name} (${node.kind}) - ${node.filePath}${location}${label ? ` — via ${label}` : ''}`);
      }
    }
    return this.textResult(this.truncateOutput(lines.join('\n') + filterNote));
  }

  /**
   * 处理 synapse_callees
   */
  private async handleCallees(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getSynapse(args.projectPath as string | undefined);
    const limit = clamp((args.limit as number) || 20, 1, 100);
    const fileFilter = typeof args.file === 'string' ? args.file : undefined;

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    const { groups, filteredOut } = this.groupDefinitions(allMatches.nodes, fileFilter);
    const filterNote = filteredOut
      ? `\n\n> **Note:** no definition of "${symbol}" matches file "${fileFilter}" — showing all definitions instead.`
      : '';

    const collect = (defNodes: Node[]) => {
      const seen = new Set<string>();
      const callees: Node[] = [];
      const labels = new Map<string, string>();
      for (const node of defNodes) {
        for (const c of cg.getCallees(node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            callees.push(c.node);
            const label = this.edgeLabel(c.edge);
            if (label) labels.set(c.node.id, label);
          }
        }
      }
      return { callees, labels };
    };

    if (groups.length === 1) {
      const { callees, labels } = collect(groups[0]!);
      if (callees.length === 0) {
        return this.textResult(`No callees found for "${symbol}"${allMatches.note}${filterNote}`);
      }
      // 成功的 `file` 缩小使多符号聚合说明失效——抑制它。
      const note = fileFilter && !filteredOut ? '' : allMatches.note;
      const formatted = this.formatNodeList(callees.slice(0, limit), `Callees of ${symbol}`, labels) + note + filterNote;
      return this.textResult(this.truncateOutput(formatted));
    }

    // 多个不同定义（#764）：每个定义一节。
    const lines: string[] = [
      `## Callees of ${symbol} — ${groups.length} distinct definitions (narrow with \`file\`)`,
    ];
    for (const group of groups) {
      const { callees, labels } = collect(group);
      lines.push('', this.definitionHeading(group));
      if (callees.length === 0) {
        lines.push('- (no callees)');
        continue;
      }
      for (const node of callees.slice(0, limit)) {
        const location = node.startLine ? `:${node.startLine}` : '';
        const label = labels.get(node.id);
        lines.push(`- ${node.name} (${node.kind}) - ${node.filePath}${location}${label ? ` — via ${label}` : ''}`);
      }
    }
    return this.textResult(this.truncateOutput(lines.join('\n') + filterNote));
  }

  /**
   * 处理 synapse_impact
   */
  private async handleImpact(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getSynapse(args.projectPath as string | undefined);
    const depth = clamp((args.depth as number) || 2, 1, 10);
    const fileFilter = typeof args.file === 'string' ? args.file : undefined;

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    const { groups, filteredOut } = this.groupDefinitions(allMatches.nodes, fileFilter);
    const filterNote = filteredOut
      ? `\n\n> **Note:** no definition of "${symbol}" matches file "${fileFilter}" — showing all definitions instead.`
      : '';

    const impactOf = (defNodes: Node[]) => {
      const mergedNodes = new Map<string, Node>();
      const mergedEdges: Edge[] = [];
      const seenEdges = new Set<string>();
      for (const node of defNodes) {
        const impact = cg.getImpactRadius(node.id, depth);
        for (const [id, n] of impact.nodes) {
          mergedNodes.set(id, n);
        }
        for (const e of impact.edges) {
          const key = `${e.source}->${e.target}:${e.kind}`;
          if (!seenEdges.has(key)) {
            seenEdges.add(key);
            mergedEdges.push(e);
          }
        }
      }
      return { nodes: mergedNodes, edges: mergedEdges, roots: defNodes.map((n) => n.id) };
    };

    // 单一定义（或同文件重载）：熟悉的合并报告。
    if (groups.length === 1) {
      const formatted = this.formatImpact(symbol, impactOf(groups[0]!)) + (fileFilter && !filteredOut ? "" : allMatches.note) + filterNote;
      return this.textResult(this.truncateOutput(formatted));
    }

    // 多个不同定义（#764）：每个定义一个影响半径——
    // 合并无关的同名类（每个单仓库应用一个 UserService）
    // 会夸大影响并混淆智能体。使用 `file` 缩小。
    const sections: string[] = [
      `## Impact of ${symbol} — ${groups.length} distinct definitions (each with its own blast radius; narrow with \`file\`)`,
    ];
    for (const group of groups) {
      const head = group[0]!;
      const line = head.startLine ? `:${head.startLine}` : '';
      sections.push(
        '',
        this.formatImpact(`${head.qualifiedName} (${head.filePath}${line})`, impactOf(group))
      );
    }
    return this.textResult(this.truncateOutput(sections.join('\n') + filterNote));
  }

  /**
   * 为人类可读输出描述合成（动态分发）边：回调是如何关联的——
   * 这是静态解析无法看到的桥接。对普通静态边返回 null。
   * 用于 trace + 节点路径，使合成跳转呈现为
   * "registered via onUpdate at App.tsx:3148"，而非裸箭头。
   */
  private synthEdgeNote(edge: Edge | null): { label: string; compact: string; registeredAt?: string } | null {
    if (!edge || edge.provenance !== 'heuristic') return null;
    const m = edge.metadata as Record<string, unknown> | undefined;
    const registeredAt = typeof m?.registeredAt === 'string' ? m.registeredAt : undefined;
    const at = registeredAt ? ` @${registeredAt}` : '';
    if (m?.synthesizedBy === 'callback') {
      const via = m.via ? `\`${String(m.via)}\`` : 'a registrar';
      const field = m.field ? ` on .${String(m.field)}` : '';
      return {
        label: `callback — registered via ${via}${field} (dynamic dispatch)`,
        compact: `dynamic: callback via ${via}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'event-emitter') {
      const ev = m.event ? `\`${String(m.event)}\`` : 'an event';
      return {
        label: `event ${ev} — emit → handler (dynamic dispatch)`,
        compact: `dynamic: event ${ev}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'react-render') {
      return {
        label: `React re-render — \`setState\` re-runs render() (dynamic dispatch)`,
        compact: `dynamic: React re-render via setState${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'jsx-render') {
      const child = m.via ? `<${String(m.via)}>` : 'a child component';
      return {
        label: `renders ${child} (JSX child — dynamic dispatch)`,
        compact: `dynamic: renders ${child}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'vue-handler') {
      const ev = m.event ? `@${String(m.event)}` : 'a template event';
      return {
        label: `Vue template handler — bound to ${ev} (dynamic dispatch)`,
        compact: `dynamic: Vue ${ev} handler`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'interface-impl') {
      return {
        label: `interface/abstract dispatch — runs the implementation override (dynamic dispatch)`,
        compact: `dynamic: interface → impl${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'closure-collection') {
      const field = m.field ? `\`${String(m.field)}\`` : 'a collection';
      return {
        label: `closure collection — runs handlers appended to ${field} (dynamic dispatch)`,
        compact: `dynamic: runs ${field} handlers${at}`,
        registeredAt,
      };
    }
    return null;
  }

  /**
   * 从命名符号中构建流程：智能体的 synapse_explore 查询是一组符号名称，
   * 通常跨越其正在调查的流程（例如
   * "PmsProductController getList PmsProductService list PmsProductServiceImpl"）。
   * 在这些命名符号之间找出最长的调用链——范围限定于智能体明确命名的内容，
   * 因此（与模糊相关性集合不同）不会迷失到错误的功能中。
   * 依赖合成边，因此 controller→service-interface→impl 能呈现出来。
   * 若不存在 >=3 个节点的链，返回 ''。
   *
   * 歧义 token（Java 的 `list` → 数十个节点）通过
   * 共同命名消歧：智能体同时命名了类，因此我们只保留
   * qualifiedName 中包含另一个命名 token 的 `list` 候选
   *（`PmsProductServiceImpl::list`），丢弃无关的 `OmsOrderService::list`。
   */
  private buildFlowFromNamedSymbols(cg: Synapse, query: string): { text: string; pathNodeIds: Set<string>; namedNodeIds: Set<string>; uniqueNamedNodeIds: Set<string> } {
    const EMPTY = { text: '', pathNodeIds: new Set<string>(), namedNodeIds: new Set<string>(), uniqueNamedNodeIds: new Set<string>() };
    try {
      const CALLABLE = new Set(['method', 'function', 'component', 'constructor']);
      // 只剥离真正的文件扩展名（Create.cs → Create）；保留限定名
      // （Class.method / Class::method）——智能体最精确的输入，
      // 由 findAllSymbols 精确解析。（旧的剥离方法会将 Class.method
      // 错误地截断为 Class，丢掉方法名。）
      const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte|astro)$/i;
      const tokens = [...new Set(
        query.split(/[\s,()[\]]+/)
          .map((t) => t.replace(FILE_EXT, '').trim())
          .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t))
      )].slice(0, 16);
      if (tokens.length < 2) return EMPTY;
      // 名称段池（每个 token 的类名 + 方法名），用于消歧歧义的简单名：
      // 只保留容器类本身在查询中被命名的候选。
      const segPool = new Set<string>();
      for (const t of tokens) for (const s of t.toLowerCase().split(/::|\./)) if (s) segPool.add(s);
      const named = new Map<string, Node>();
      // 其 token 为特定的节点——整个图中（近）唯一的可调用名称（定义数 <=3）。
      // 这些节点可以安全地为一个文件保留：智能体命名了 THIS
      // 方法（`getResponseWithInterceptorChain`，1 个定义）。超多态名称
      //（`as_sql`，跨每个 Expression/Compiler 子类共 110 个定义）不在此处，
      // 因此命名它不会让每个后端变体都保留完整正文而淹没预算。
      const uniqueNamedNodeIds = new Set<string>();
      // token → 已解析的节点 id：驱动 token 覆盖检查，该检查
      // 门控动态边界扫描（当某 token 的任意节点落在主链上时即为已覆盖——
      // 链外的重载不计入未覆盖）。
      const tokenNodes = new Map<string, string[]>();
      for (const t of tokens) {
        const cands = this.findAllSymbols(cg, t).nodes.filter((n) => CALLABLE.has(n.kind));
        // 一个限定名或其他特定名称（命中数 <=3）保留全部；
        // 歧义的简单名只保留容器在命名中的候选。
        const specific = cands.length <= 3;
        const pick = specific
          ? cands
          : cands.filter((n) => {
              const segs = (n.qualifiedName || '').toLowerCase().split(/::|\./).filter(Boolean);
              const container = segs.length >= 2 ? segs[segs.length - 2] : '';
              return !!container && segPool.has(container);
            });
        const kept = pick.slice(0, 6);
        tokenNodes.set(t, kept.map((n) => n.id));
        for (const n of kept) {
          named.set(n.id, n);
          if (specific) uniqueNamedNodeIds.add(n.id);
        }
        if (named.size > 40) break;
      }
      if (named.size < 2) {
        // 智能体命名了一个流程，但只有一侧解析成功（另一端是
        // 匿名的/运行时注册的/未被提取的）。已解析一侧的正文
        // 可能仍包含解释这一缺口的动态分发点——
        // 将其呈现出来，而非静默返回空。
        if (named.size === 0) return EMPTY;
        const boundaries = this.buildDynamicBoundaries(cg, [...named.values()], named);
        if (!boundaries) return EMPTY;
        const text = boundaries + '> Full source for these symbols is below.\n';
        return { text, pathNodeIds: new Set(), namedNodeIds: new Set(named.keys()), uniqueNamedNodeIds };
      }
      const MAX_HOPS = 7;
      let best: Array<{ node: Node; edge: Edge | null }> | null = null;
      // 对完整调用图（含合成边）从每个命名种子进行 BFS，
      // 但只接受也是命名的汇点——两端都锚定于智能体命名的符号，
      // 使链保持在主题上，同时桥接 token 解析遗漏的中间节点
      //（例如确切的接口重载）。
      for (const seed of [...named.values()].slice(0, 8)) {
        const parent = new Map<string, { prev: string | null; edge: Edge | null; node: Node }>();
        parent.set(seed.id, { prev: null, edge: null, node: seed });
        const q: Array<{ id: string; depth: number; streak: number }> = [{ id: seed.id, depth: 0, streak: 0 }];
        let deep: string | null = null, deepDepth = 0;
        const MAX_BRIDGE = 1; // ≤1 个连续未命名跳：桥接一个缺失的中间节点，不在上帝函数的扇出中迷失
        for (let h = 0; h < q.length && parent.size < 1500; h++) {
          const { id, depth, streak } = q[h]!;
          if (id !== seed.id && named.has(id) && depth > deepDepth) { deep = id; deepDepth = depth; }
          if (depth >= MAX_HOPS - 1) continue;
          for (const c of cg.getCallees(id)) {
            if (c.edge.kind !== 'calls' || parent.has(c.node.id)) continue;
            const newStreak = named.has(c.node.id) ? 0 : streak + 1;
            if (newStreak > MAX_BRIDGE) continue;
            parent.set(c.node.id, { prev: id, edge: c.edge, node: c.node });
            q.push({ id: c.node.id, depth: depth + 1, streak: newStreak });
          }
        }
        if (!deep) continue;
        const chain: Array<{ node: Node; edge: Edge | null }> = [];
        let cur: string | null = deep;
        while (cur) { const p = parent.get(cur); if (!p) break; chain.push({ node: p.node, edge: p.edge }); cur = p.prev; }
        chain.reverse();
        if (!best || chain.length > best.length) best = chain;
      }
      const hasMain = !!best && best.length >= 3;
      const pathIds = new Set((best ?? []).map((s) => s.node.id));

      // 动态边界扫描（#687）——仅当智能体询问的流程未完全连通时触发：
      // 某个 token 解析到了节点，但没有一个节点落在主链上（或根本没有链）。
      // 健康的流程完全跳过此步。扫描顺序：链的断点优先
      //（部分流程停止的地方），然后是断开的符号，智能体特定的
      //（唯一命名的）符号优先。
      let boundaryText = '';
      {
        const uncovered: Node[] = [];
        if (!hasMain) {
          // 无已渲染的链——但 2 节点链仍然连接了其两个端点
          //（例如通过一条合成跳，如下所示为动态分发链接）。
          // 只有不在该短链上的节点才是值得扫描的未解释断点。
          for (const n of named.values()) if (!pathIds.has(n.id)) uncovered.push(n);
        } else {
          for (const ids of tokenNodes.values()) {
            if (ids.length === 0 || ids.some((id) => pathIds.has(id))) continue;
            for (const id of ids) { const n = named.get(id); if (n) uncovered.push(n); }
          }
        }
        if (uncovered.length > 0) {
          const scanList: Node[] = [];
          if (hasMain) scanList.push(best![best!.length - 1]!.node);
          scanList.push(...uncovered.sort((a, b) =>
            (uniqueNamedNodeIds.has(b.id) ? 1 : 0) - (uniqueNamedNodeIds.has(a.id) ? 1 : 0)));
          boundaryText = this.buildDynamicBoundaries(cg, scanList, named);
        }
      }

      // 补充：与命名符号相关的动态分发（合成）边——
      // 智能体原本需要 grep/Read 重建的间接跳转
      //（"附加的 `validators` 实际在哪里运行？"）。
      // 合成边本身就是答案，因此即使另一端未被命名也要呈现它
      //（例如智能体命名了 `validate` 但未命名消耗集合的 `didCompleteTask`）。
      // 构造上在主题内：仅触及智能体命名符号的启发式边；
      // 当跳转已在主链中时跳过。
      const synthLines: string[] = [];
      const synthSeen = new Set<string>();
      for (const n of named.values()) {
        if (synthLines.length >= 6) break;
        for (const { node: other, edge } of [...cg.getCallers(n.id), ...cg.getCallees(n.id)]) {
          if (synthLines.length >= 6) break;
          if (edge.provenance !== 'heuristic' || other.id === n.id) continue;
          // "已在主链中"只在链已渲染（hasMain）时适用。
          // 2 节点链会填充 pathIds 但不渲染任何内容，
          // 因此两个命名符号之间的直接合成跳（自定义 EventBus emit→handler，#687）
          // 是不可见的——对于 Flow 来说太短，此处作为链内跳被跳过。将其呈现出来。
          if (hasMain && pathIds.has(edge.source) && pathIds.has(edge.target)) continue;
          const src = edge.source === n.id ? n : other;
          const tgt = edge.source === n.id ? other : n;
          const key = `${src.name}>${tgt.name}`;
          if (synthSeen.has(key)) continue;
          synthSeen.add(key);
          const note = this.synthEdgeNote(edge);
          synthLines.push(`- ${src.name} → ${tgt.name}   [${note ? note.compact : edge.kind}]`);
        }
      }

      if (!hasMain && synthLines.length === 0 && !boundaryText) return EMPTY;
      const out: string[] = [];
      if (hasMain) {
        out.push('## Flow (call path among the symbols you queried)', '');
        for (let i = 0; i < best!.length; i++) {
          const step = best![i]!;
          if (step.edge) { const sy = this.synthEdgeNote(step.edge); out.push(`   ↓ ${sy ? sy.compact : step.edge.kind}`); }
          out.push(`${i + 1}. ${step.node.name} (${step.node.filePath}:${step.node.startLine})`);
        }
        out.push('');
      }
      if (synthLines.length) {
        out.push(
          '## Dynamic-dispatch links among your symbols',
          '(synthesized — the indirect hops grep/Read would reconstruct; the `@file:line` is the wiring site)',
          '',
          ...synthLines,
          ''
        );
      }
      if (boundaryText) out.push(boundaryText);
      out.push('> Full source for these symbols is below — the call flow among them, followed by their bodies.', '');
      // namedNodeIds = 智能体显式命名的每个可调用符号（主干的超集）。
      // 持有其中一个的文件是智能体要求查看的，因此即使是非主干的多态兄弟，
      // 也必须保留完整源码——智能体命名了 `getResponseWithInterceptorChain` /
      // `SQLCompiler.execute_sql` 作为机制，而非可互换的叶节点。参见骨架化门控。
      return { text: out.join('\n'), pathNodeIds: pathIds, namedNodeIds: new Set(named.keys()), uniqueNamedNodeIds };
    } catch {
      return EMPTY;
    }
  }

  /**
   * 动态边界呈现（#687）：当智能体命名符号之间的流程未完全连通时，
   * 扫描断开符号的正文，查找动态分发点（计算型成员调用、getattr、
   * 反射、类型化消息总线、运行时键值 emit），并公示边界——
   * 确切位置、形式，以及（当键在静态上可见时）候选目标——
   * 而非猜测边。当不存在静态路径时，"A 如何到达 B"的答案
   * 就是分发点：那是流程在运行时继续的地方。
   * 查询时执行，确定性，零图变更；完全连通的流程永远不会到达此方法。
   */
  private buildDynamicBoundaries(cg: Synapse, scanList: Node[], named: Map<string, Node>): string {
      const MAX_NOTES = 4;       // 每次 explore 的边界条目数
      const MAX_SCAN = 8;        // 扫描的正文数量
    const MAX_TOTAL_CHARS = 200_000;
    let projectRoot: string;
    try { projectRoot = cg.getProjectRoot(); } catch { return ''; }
    const notes: string[] = [];
    const seenNode = new Set<string>();
    const seenSite = new Set<string>();
    let scanned = 0, charsScanned = 0;
    for (const node of scanList) {
      if (notes.length >= MAX_NOTES || scanned >= MAX_SCAN || charsScanned > MAX_TOTAL_CHARS) break;
      if (seenNode.has(node.id) || !node.startLine || !node.endLine) continue;
      seenNode.add(node.id);
      const absPath = validatePathWithinRoot(projectRoot, node.filePath);
      if (!absPath || !existsSync(absPath)) continue;
      let content: string;
      try { content = readFileSync(absPath, 'utf-8'); } catch { continue; }
      const body = content.split('\n').slice(node.startLine - 1, node.endLine).join('\n');
      scanned++;
      charsScanned += body.length;
      for (const m of scanDynamicDispatch(body, node.language || '', node.startLine)) {
        if (notes.length >= MAX_NOTES) break;
        const siteKey = `${node.filePath}:${m.line}:${m.form}`;
        if (seenSite.has(siteKey)) continue;
        seenSite.add(siteKey);
        const more = m.moreSites ? ` (+${m.moreSites} more such site${m.moreSites > 1 ? 's' : ''} in this body)` : '';
        notes.push(`- \`${node.name}\` (${node.filePath}:${m.line}) — ${m.label}: \`${m.snippet}\`${more}`);
        if (m.key) {
          const cand = this.boundaryCandidates(cg, m.key, !!m.keyIsType, named, node.id);
          if (cand) notes.push(`  ${cand}`);
        }
      }
    }
    if (notes.length === 0) return '';
    return [
      '## Dynamic boundaries (the static path ends at runtime dispatch)',
      '',
      ...notes,
      '',
      '> These sites choose their call target at runtime (registry / bus / reflection) — the site shown IS where the flow continues. To follow it, run synapse_explore or synapse_node on a candidate; source for the sites above is included below.',
      '',
    ].join('\n');
  }

  /**
   * 为 {@link buildDynamicBoundaries} 呈现的分发键提供候选运行时目标的短列表。
   * 先是精确的惯例名称（`save` → `onSave`/`handleSave`；
   * `CreateCmd` → `CreateCmdHandler`），再是 FTS，并带有
   * 规范化包含的后过滤器（FTS 驼峰分词比候选列表应有的更模糊）。
   * 智能体已命名的符号排在最前并标记——这是"你说对了，这是连线方式"的情况。
   */
  private boundaryCandidates(cg: Synapse, key: string, keyIsType: boolean, named: Map<string, Node>, selfId: string): string {
    const CALLABLE = new Set(['method', 'function', 'component', 'constructor', 'class']);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const keyNorm = norm(key);
    if (keyNorm.length < 3) return '';
    const cands = new Map<string, Node>();
    const consider = (n: Node | undefined | null) => {
      if (!n || n.id === selfId || !CALLABLE.has(n.kind) || cands.has(n.id)) return;
      const nameNorm = norm(n.name || '');
      if (nameNorm.length < 3) return;
      if (!nameNorm.includes(keyNorm) && !keyNorm.includes(nameNorm)) return;
      cands.set(n.id, n);
    };
    const cap = key.charAt(0).toUpperCase() + key.slice(1);
    const probes = keyIsType
      ? [`${key}Handler`, key]
      : [key, `on${cap}`, `handle${cap}`, `${key}Handler`, `handle_${key}`];
    for (const p of probes) {
      try { for (const n of cg.getNodesByName(p)) consider(n); } catch { /* exact probe miss is fine */ }
    }
    let raw = 0;
    try {
      const results = cg.searchNodes(key, { limit: 12 });
      raw = results.length;
      for (const r of results) consider(r.node);
    } catch { /* FTS syntax edge — exact probes already ran */ }
    if (cands.size === 0) {
      return raw >= 12 && key.length < 5 ? `key \`${key}\` is too generic to shortlist (${raw}+ matches)` : '';
    }
    // 构造函数候选与其类重复：提取器将构造函数作为
    // 与类同名的 METHOD 节点生成（C#/Java `Foo::Foo`）——保留类。
    const all = [...cands.values()];
    const classKey = new Set(all.filter((n) => n.kind === 'class').map((n) => `${n.name}|${n.filePath}`));
    const namedNames = new Set([...named.values()].map((n) => n.name));
    const isNamed = (n: Node) => named.has(n.id) || namedNames.has(n.name); // 流程命名集合只包含可调用节点——将标记传递给类
    const list = all
      .filter((n) => !(n.kind !== 'class' && classKey.has(`${n.name}|${n.filePath}`)))
      .sort((a, b) => (isNamed(b) ? 1 : 0) - (isNamed(a) ? 1 : 0))
      .slice(0, 4)
      .map((n) => {
        // 类型总线惯例：运行时目标是候选类的
        // Handle/Execute/Consume 方法——命名确切的节点，而非仅命名类。
        let display = n.qualifiedName || n.name;
        let at = `${n.filePath}:${n.startLine}`;
        if (keyIsType && n.kind === 'class') {
          try {
            const HANDLER_METHODS = /^(handle|handleAsync|execute|executeAsync|consume|consumeAsync|run|__invoke)$/i;
            const method = cg.getOutgoingEdges(n.id)
              .filter((e) => e.kind === 'contains')
              .map((e) => { try { return cg.getNode(e.target); } catch { return null; } })
              .find((c): c is Node => !!c && c.kind === 'method' && HANDLER_METHODS.test(c.name));
            if (method) { display = `${n.name}.${method.name}`; at = `${method.filePath}:${method.startLine}`; }
          } catch { /* 无可解析成员的类——显示类本身 */ }
        }
        return `\`${display}\` (${at})${isNamed(n) ? ' ← you named this' : ''}`;
      });
    return `candidates for key \`${key}\`: ${list.join(', ')}`;
  }

  /**
   * explore 结果入口符号的紧凑"影响半径"：谁依赖于每个符号（调用者）
   * 以及哪些测试文件覆盖它——仅位置，无源码，使智能体在编辑前
   * 了解需要更新/重新验证的内容，无需额外的 impact 调用。
   * 始终开启，但跳过没有依赖者的符号（无需警告），
   * 当无符号符合条件时返回 ''，使纯叶节点探索保持整洁。
   */
  private buildBlastRadiusSection(cg: Synapse, subgraph: Subgraph): string {
    const ROOT_CAP = 5; // 仅限查询实际针对的符号
    const FILE_CAP = 4; // 每个符号列出的调用者文件数，超出则显示 "+N more"
    const MEANINGFUL = new Set<string>([
      'function', 'method', 'class', 'interface', 'struct', 'trait', 'protocol',
      'enum', 'type_alias', 'component', 'constant', 'variable', 'property', 'field',
    ]);
    const rel = (p: string) => p.replace(/\\/g, '/');

    const roots = subgraph.roots
      .map((id) => subgraph.nodes.get(id))
      .filter((n): n is Node => !!n && MEANINGFUL.has(n.kind))
      .slice(0, ROOT_CAP);
    if (roots.length === 0) return '';

    const entries: string[] = [];
    for (const root of roots) {
      let callers: Array<{ node: Node }> = [];
      try { callers = cg.getCallers(root.id) as Array<{ node: Node }>; } catch { /* skip this root */ }

      const seen = new Set<string>();
      const uniq: Node[] = [];
      for (const c of callers) {
        if (c?.node && !seen.has(c.node.id)) { seen.add(c.node.id); uniq.push(c.node); }
      }
      if (uniq.length === 0) continue; // 无影响半径 → 无需标记

      const callerFiles = [...new Set(uniq.map((n) => rel(n.filePath)))];
      const testFiles = callerFiles.filter((f) => isTestFile(f));
      const nonTest = callerFiles.filter((f) => !isTestFile(f));

      const shown = nonTest.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ');
      const more = nonTest.length > FILE_CAP ? ` +${nonTest.length - FILE_CAP} more` : '';
      const where = nonTest.length > 0 ? ` in ${shown}${more}` : '';
      const tests = testFiles.length > 0
        ? `; tests: ${testFiles.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ')}${testFiles.length > FILE_CAP ? ` +${testFiles.length - FILE_CAP}` : ''}`
        : '; ⚠️ no covering tests found';

      entries.push(
        `- \`${root.name}\` (${rel(root.filePath)}:${root.startLine}) — ${uniq.length} caller${uniq.length === 1 ? '' : 's'}${where}${tests}`,
      );
    }
    if (entries.length === 0) return '';

    return [
      '### Blast radius — what depends on these (update/verify before editing)',
      '',
      ...entries,
      '',
    ].join('\n');
  }

  /**
   * 通过随机游走重启（个性化 PageRank）从查询匹配的种子节点出发，
   * 在调用/引用图上计算图连通性相关度。
   *
   * 这是文本搜索（FTS/bm25）无法提供的排名信号，也是 synapse 的主场优势：
   * 基于结构的相关性，而非词语。符号与匹配簇通过调用关联的文件
   * 积累游走质量并排名靠前；纯文本匹配——例如 `LensSwitcher.swift`
   * 匹配了 `switchOrganization` 中的词 "switch"，但未调用
   * `setUser`/`fetchUser` 中的任何一个——仅获得自身的重启概率，排名约为 0。
   * 对欺骗词项匹配的分词陷阱免疫，确定性，无向量嵌入。
   *
   * 无向邻接（双向可达），重启 α=0.25 指向种子，
   * 迭代到收敛。限定在已相关的子图内，因此
   * 约几百节点 × 约 25 次迭代——可忽略的开销。
   */
  private computeGraphRelevance(
    nodeIds: string[],
    edges: Edge[],
    seedIds: Set<string>,
  ): Map<string, number> {
    const out = new Map<string, number>();
    const n = nodeIds.length;
    if (n === 0) return out;
    const idx = new Map<string, number>();
    for (let i = 0; i < n; i++) idx.set(nodeIds[i]!, i);

    const RANK_EDGES = new Set<string>([
      'calls', 'references', 'extends', 'implements', 'overrides',
      'instantiates', 'returns', 'type_of', 'imports',
    ]);
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const e of edges) {
      if (!RANK_EDGES.has(e.kind)) continue;
      const i = idx.get(e.source);
      const j = idx.get(e.target);
      if (i === undefined || j === undefined || i === j) continue;
      adj[i]!.push(j);
      adj[j]!.push(i); // 无向——双向可达
    }

    // 重启向量：在候选集中存在的种子上均匀分布。
    //（若无种子落入集合，回退到全部均匀——确保永远不返回全零。）
    const r = new Array<number>(n).fill(0);
    let rsum = 0;
    for (const id of seedIds) {
      const i = idx.get(id);
      if (i !== undefined) { r[i] = 1; rsum += 1; }
    }
    if (rsum === 0) { for (let i = 0; i < n; i++) r[i] = 1; rsum = n; }
    for (let i = 0; i < n; i++) r[i]! /= rsum;

    const alpha = 0.25;
    let s = r.slice();
    for (let iter = 0; iter < 25; iter++) {
      const next = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        const si = s[i]!;
        if (si === 0) continue;
        const d = adj[i]!.length;
        if (d === 0) { next[i]! += si; continue; } // 悬挂节点：保留其质量
        const share = si / d;
        for (const j of adj[i]!) next[j]! += share;
      }
      for (let i = 0; i < n; i++) s[i] = (1 - alpha) * next[i]! + alpha * r[i]!;
    }
    for (let i = 0; i < n; i++) out.set(nodeIds[i]!, s[i]!);
    return out;
  }

  /**
   * 处理 synapse_explore——单次调用的深度探索
   *
   * 策略：通过图遍历找到相关符号，按文件分组，
   * 然后读取每个文件中覆盖所有符号的连续区段。
   * 此方法取代多次 synapse_node + Read 调用。
   *
   * 输出大小通过 `getExploreOutputBudget` 自适应于项目文件数——
   * 参见 #185 了解为何固定 35k 上限对小项目是税收
   * 而对大型项目确实有其价值。
   */
  private async handleExplore(args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const cg = this.getSynapse(args.projectPath as string | undefined);
    const projectRoot = cg.getProjectRoot();

    // 从项目规模解析自适应输出预算。若统计不可用，
    // 回退到最大层级默认值，保留 #185 之前的行为。
    let budget: ExploreOutputBudget;
    try {
      budget = getExploreOutputBudget(cg.getStats().fileCount);
    } catch {
      budget = getExploreOutputBudget(Infinity);
    }
    const maxFiles = clamp((args.maxFiles as number) || budget.defaultMaxFiles, 1, 20);

    // 步骤 1：以宽松参数查找相关上下文。
    // 使用较大的 maxNodes 预算——explore 有自己的 35k 字符输出限制
    // 防止上下文膨胀，因此更多节点意味着更好的入口点覆盖
    //（尤其对于大型文件，如 Svelte 组件）。
    const subgraph = await cg.findRelevantContext(query, {
      searchLimit: 8,
      traversalDepth: 3,
      maxNodes: 200,
      minScore: 0.2,
    });

    if (subgraph.nodes.size === 0) {
      return this.textResult(`No relevant code found for "${query}"`);
    }

    // 图感知胶合：findRelevantContext 从名称/文本搜索构建子图，
    // 因此桥接命名符号的方法——例如 App.tsx 的 triggerRender，
    // 它调用命名的 triggerUpdate——从不是搜索命中，会被遗漏，
    // 迫使智能体读取文件来追踪它。拉入入口（根）节点的调用者/被调用者，
    // 但仅限于子图已呈现的文件中的节点（智能体读取来填补空白的文件），
    // 这样我们添加了连线而不引入无关文件。
    // 这些节点在下方获得重要性加成，使其能在单文件聚类预算内存活。
    const glueNodeIds = new Set<string>();
    const subgraphFiles = new Set<string>();
    for (const n of subgraph.nodes.values()) subgraphFiles.add(n.filePath);
    const GLUE_NODE_CAP = 60;
    for (const rootId of subgraph.roots) {
      if (glueNodeIds.size >= GLUE_NODE_CAP) break;
      let neighbors: Node[] = [];
      try {
        neighbors = [
          ...cg.getCallers(rootId).map(c => c.node),
          ...cg.getCallees(rootId).map(c => c.node),
        ];
      } catch {
        continue;
      }
      for (const nb of neighbors) {
        if (glueNodeIds.size >= GLUE_NODE_CAP) break;
        if (subgraph.nodes.has(nb.id)) continue;
        if (!subgraphFiles.has(nb.filePath)) continue;
        subgraph.nodes.set(nb.id, nb);
        glueNodeIds.add(nb.id);
      }
    }

    // 命名符号种子注入：findRelevantContext 是 FTS/文本排名，因此
    // 由符号名称包组成的查询若偏向某一阶段（Alamofire：5 个 build 术语，
    // 每个都是高频名称，vs 3 个 validate 术语），低频名称会落在搜索截止线以下——
    // 它们的定义和整个文件（Validation.swift）永远不会被收集，
    // 因此无法渲染，智能体只好读取它们。将每个命名 token 解析到其
    // 实质性定义（跳过空桩 + 测试文件，与 trace 端点选择器相同的相关性）
    // 并作为入口注入，使智能体明确命名的每个符号都在子图中，且其文件被评分。
    const namedSeedIds = new Set<string>();
    {
      const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte|astro)$/i;
      const CALLABLE = new Set(['method', 'function', 'component', 'constructor']);
      const isTestPath = (p: string) => /(^|\/)(tests?|specs?|__tests__|testdata|mocks?|fixtures?)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p);
      const bodyLines = (n: Node) => Math.max(0, (n.endLine ?? n.startLine) - n.startLine);
      const tokens = [...new Set(
        query.split(/[\s,()[\]]+/)
          .map((t) => t.replace(FILE_EXT, '').trim())
          .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t))
      )].slice(0, 16);
      // 查询中的 PascalCase token 是类型/文件消歧符——当智能体
      // 写 "DataRequest task validate" 时，它想要的 `task`/`validate`
      // 是 DataRequest 的，而非 Validation.swift/Concurrency.swift/抽象基类
      // 中同名的重载。用于将重载名称偏向查询同时命名的文件/类。
      // 排除项目名称（用户自然包含的 PascalCase token）——
      // 它命名整个仓库，因此偏向它只会将重载拉到嵌入它的那个栈，
      // 重新埋没其余部分（#720）。
      const projectNameTokens = cg.getProjectNameTokens();
      const typeTokens = tokens.filter(
        (o) => /^[A-Z][A-Za-z0-9]{3,}/.test(o) && !projectNameTokens.has(normalizeNameToken(o)),
      );
      const inNamedContext = (n: Node) =>
        typeTokens.some((ct) => {
          const lc = ct.toLowerCase();
          return n.filePath.toLowerCase().includes(lc) || n.qualifiedName.toLowerCase().includes(lc);
        });
      for (const t of tokens) {
        // 通过直接索引枚举裸 token 的所有定义，而非 FTS——
        // 50+ 重载名称（tokio `poll`）会将期望的定义（`Harness::poll`）
        // 排在 FTS 截止线以下，使 findAllSymbols 永远看不到它，
        // 且下方的类型 token 偏向无法选择 harness.rs 中的那个。
        //（与 synapse_node 的 findSymbolMatches 相同的修复。）限定 token 保留 findAllSymbols。
        const isQual = /[.\/]|::/.test(t);
        const raw = isQual ? this.findAllSymbols(cg, t).nodes : cg.getNodesByName(t);
        const cands = raw
          .filter((n) => CALLABLE.has(n.kind) && !isTestPath(n.filePath))
          .sort((a, b) => (bodyLines(b) > 1 ? 1 : 0) - (bodyLines(a) > 1 ? 1 : 0) || bodyLines(b) - bodyLines(a));
        // 特定名称（定义数 <=3）注入其所有定义。重载名称
        //（`validate` = 10，`request` = 44）会淹没子图，因此仅注入：
        // 文件/类在查询中也被命名的重载（智能体告诉了我们它想要哪个——
        // DataRequest 的，而非 Validation.swift 的），加上上限；
        // 否则回退到唯一最实质性的定义。
        // 这是 synapse_node 重载消歧的 explore 侧镜像。
        let picks: Node[];
        if (cands.length <= 3) {
          picks = cands;
        } else {
          const ctx = cands.filter(inNamedContext);
          picks = ctx.length > 0 ? ctx.slice(0, 4) : cands.slice(0, 1);
        }
        for (const n of picks) {
          if (!subgraph.nodes.has(n.id)) subgraph.nodes.set(n.id, n);
          // 将其标记为命名种子，即使 FTS 收集已经包含了它——
          // "被智能体命名"独立于搜索是否恰好呈现了它，
          // 且它驱动 +50 评分、门控，以及下方的命名文件排序。
          //（此前只有新注入的节点被标记，因此 FTS 已收集的命名符号从不排至顶部。）
          namedSeedIds.add(n.id);
        }
      }
    }

    // 步骤 2：按文件分组节点，按相关性评分
    const fileGroups = new Map<string, { nodes: Node[]; score: number }>();
    const entryNodeIds = new Set([...subgraph.roots, ...namedSeedIds]);

    // 构建与入口点直接连接的节点集合（深度 1）
    const connectedToEntry = new Set<string>();
    for (const edge of subgraph.edges) {
      if (entryNodeIds.has(edge.source)) connectedToEntry.add(edge.target);
      if (entryNodeIds.has(edge.target)) connectedToEntry.add(edge.source);
    }

    for (const node of subgraph.nodes.values()) {
      // 跳过 import/export 节点——它们增加噪音而无信息
      if (node.kind === 'import' || node.kind === 'export') continue;
      // 安全性（#383）：永远不渲染配置叶节点
      //（Spring application.{yml,properties} 键）的磁盘源——
      // 其行是 `key = <secret>`，因此此处的全文件/聚类渲染
      // 会将密钥不经意地推入上下文。该键仍会出现在上方的流程/符号列表中。
      if (isConfigLeafNode(node)) continue;

      const group = fileGroups.get(node.filePath) || { nodes: [], score: 0 };
      group.nodes.push(node);
      // 评分：命名种子节点（智能体命名但 FTS 遗漏、现被注入的符号）
      // 的价值远超一个普通引用——其文件是答案所在的地方。没有此评分，
      // 偶然提到流程的文件（Combine.swift 引用 request/task → 来自连接节点 23 分）
      // 会超过定义命名符号的文件（Validation.swift 的 `validate` → 10 分），
      // 抢占其渲染槽。定义 ≫ 引用。
      if (namedSeedIds.has(node.id)) {
        group.score += 50;
      } else if (entryNodeIds.has(node.id)) {
        group.score += 10;
      } else if (connectedToEntry.has(node.id)) {
        group.score += 3;
      } else {
        group.score += 1;
      }
      fileGroups.set(node.filePath, group);
    }

    // 仅包含含有入口点或与入口点直接连接的节点的文件
    let relevantFiles = [...fileGroups.entries()].filter(([, group]) => group.score >= 3);

    // 提取查询词以进行相关性检查
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);

    // 测试/spec/图标/i18n 文件检测器——用于预排序硬过滤
    //（极小层级）和比较器降权（所有层级）。
    const isLowValue = (p: string) => {
      const lp = p.toLowerCase();
      return (
        /\/(tests?|__tests?__|spec)\//.test(lp) ||
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
        /\bicons?\b/.test(lp) ||
        /\bi18n\b/.test(lp)
      );
    };

    // 硬排除测试/spec 文件（所有层级，不仅限于极小层级）。一个漏入的测试
    // 文件会主导小型仓库的单文件预算（cobra 的 `command_test.go`
    // 挤掉了 `args.go`），且在大型仓库上也浪费预算（Django 的
    // `custom_lookups/tests.py` 消耗了 28 KB 上限中的约 2.3 KB，
    // 挤占了智能体随后读取的 SQLCompiler 机制）。测试文件几乎从不能回答
    // 架构问题。当查询本身关于测试时跳过——这是合理的"探索测试"情况——
    // 且仅在还剩 ≥2 个非测试候选时才删除（否则测试是该区域的唯一信号）。
    {
      const queryMentionsTests = /\b(test|tests|testing|spec|verify|verifies)\b/i.test(query);
      if (!queryMentionsTests) {
        const nonLow = relevantFiles.filter(([p]) => !isLowValue(p));
        if (nonLow.length >= 2) {
          relevantFiles = nonLow;
        }
      }
    }

    // 次要信号：每个文件匹配的不同查询词数量（路径 + 符号名）。
    // 仅作为决胜信号保留——主要相关性是下方的图连通性。
    //（单独词项计数将真正的中心文件与偶然的同词匹配并列；
    // 这是弱文本信号，不是排名器。）
    const uniqueQueryTerms = [...new Set(queryTerms)].filter(t => t.length >= 3);
    const fileTermHits = new Map<string, number>();
    for (const [fp, group] of relevantFiles) {
      const hay = fp.toLowerCase() + ' ' + group.nodes.map(n => n.name.toLowerCase()).join(' ');
      let hits = 0;
      for (const t of uniqueQueryTerms) if (hay.includes(t)) hits++;
      fileTermHits.set(fp, hits);
    }

    // 主要相关性：图连通性（从匹配种子出发的随机游走重启——
    // 参见 computeGraphRelevance）。汇总每个文件节点的游走质量。
    // 这是文本搜索缺少的信号：真正的簇（org-user.storage.ts，与匹配
    // 调用连接）积累质量；孤立的文本匹配（LensSwitcher.swift，
    // 匹配了"switch"但未调用流程中的任何内容）仅获得其重启概率 → ~0，
    // 被门控过滤掉。
    const nodeRwr = this.computeGraphRelevance(
      [...subgraph.nodes.keys()], subgraph.edges, entryNodeIds,
    );
    const fileGraphScore = new Map<string, number>();
    for (const node of subgraph.nodes.values()) {
      fileGraphScore.set(
        node.filePath,
        (fileGraphScore.get(node.filePath) ?? 0) + (nodeRwr.get(node.id) ?? 0),
      );
    }
    const maxGraph = Math.max(0, ...fileGraphScore.values());

    // 中心文件：1–2 个图连通性最高且也在文本上匹配查询的文件
    //（使无词项匹配的连接枢纽工具文件不被误认为主题）。
    // 答案的核心——它们在下方赢得更大的全文件上限
    //（上帝文件的中心文件仍会超过该上限，
    // 回退到宽松的全方法节——永远不全量转储）。
    const centralFiles = new Set(
      [...fileGraphScore.entries()]
        .filter(([fp, g]) => g > 0 && (fileTermHits.get(fp) ?? 0) >= 1)
        .sort((a, b) => b[1] - a[1] || (fileTermHits.get(b[0]) ?? 0) - (fileTermHits.get(a[0]) ?? 0))
        .slice(0, 2)
        .map(([f]) => f),
    );

    // 定义了智能体命名符号（或子图根）的文件。这些是相关性最高的文件——
    // 智能体按名称请求了它们——因此下方的连通性门控绝不能删除它们，
    // 即使其 RWR 质量较低（叶族文件如 codec.ts 与其他文件的调用连接很少，
    // 但正是智能体查询的内容）。没有此保护，门控会剪掉命名文件，
    // 智能体只好读回它。
    const entryFiles = new Set<string>();
    for (const id of entryNodeIds) {
      const n = subgraph.nodes.get(id);
      if (n) entryFiles.add(n.filePath);
    }

    // 相关性门控（使宽松的预算成为上限而非目标）：仅保留满足以下任一条件的文件：
    //   - 图分数在顶部的某个比例内（位于流程上/附近），或
    //   - 中心文件（查询入口点在此处），或
    //   - 定义了智能体命名的符号（entryFiles），或
    //   - 匹配 >= 2 个不同命名查询词——一个强文本信号，
    //     表明智能体在询问此文件，即使没有任何东西调用它
    //（codec.ts：智能体命名了 `encode`/`Codec`/`JsonCodec`，
    //     所有都是 RWR 质量为零的叶类——仅图会错误地删除它）。
    // 单一共享词的文本匹配（LensSwitcher：词数=1，g~0）仍被删除，
    // 因此预算不会被偶然文件填满。已保护，从不将文件削减到 2 以下。
    if (maxGraph > 0) {
      const gated = relevantFiles.filter(([fp]) =>
        (fileGraphScore.get(fp) ?? 0) >= maxGraph * 0.06
        || centralFiles.has(fp)
        || entryFiles.has(fp)
        || (fileTermHits.get(fp) ?? 0) >= 2,
      );
      if (gated.length >= 2) relevantFiles = gated;
    }

    // 文件排序：图中心文件优先，然后是不同词项匹配，
    // 然后是现有的低价值/生成/分数决胜机制。
    // 定义了智能体命名符号的文件。这些排在最前——优于图连通性——
    // 因为智能体按名称请求了它们。没有此排序，仅通过动态分发到达的
    // 命名叶重载（Alamofire 的 `DataRequest.task`/`validate`，低 RWR 质量）
    // 会排在高连通性抽象基类（`Request.swift`）和其他文件中同名重载
    //（`Validation.swift`）之下，落在预算之外，智能体只好读取它。
    // 命名文件就是答案——将其排在最前。
    const namedSeedFiles = new Set<string>();
    for (const id of namedSeedIds) {
      const n = subgraph.nodes.get(id);
      if (n) namedSeedFiles.add(n.filePath);
    }

    const sortedFiles = relevantFiles.sort((a, b) => {
      const aPath = a[0].toLowerCase();
      const bPath = b[0].toLowerCase();

      // 智能体命名的文件优先（它按名称请求了此处定义的符号）。
      const aNamed = namedSeedFiles.has(a[0]) ? 1 : 0;
      const bNamed = namedSeedFiles.has(b[0]) ? 1 : 0;
      if (aNamed !== bNamed) return bNamed - aNamed;

      // 图连通性是下一个关键（小 epsilon 使近似平分回落到
      // 文本信号，而非在浮点噪音上随机翻转）。
      const aG = fileGraphScore.get(a[0]) ?? 0;
      const bG = fileGraphScore.get(b[0]) ?? 0;
      if (Math.abs(aG - bG) > maxGraph * 0.01) return bG - aG;

      const aHits = fileTermHits.get(a[0]) ?? 0;
      const bHits = fileTermHits.get(b[0]) ?? 0;
      if (aHits !== bHits) return bHits - aHits;

      const aLow = isLowValue(aPath);
      const bLow = isLowValue(bPath);
      if (aLow !== bLow) return aLow ? 1 : -1;

      // 降权生成源文件（.pb.go / .pulsar.go / _mocks.go / …）——
      // 智能体在询问真实流程时很少需要看 protobuf 脚手架或 gomock 输出，
      // 而转储其正文会使响应膨胀（cosmos Q3 explore 否则会以
      // `expected_keepers_mocks.go` 打头，挤占真实的 `tally.go` 内容，
      // 迫使智能体读取 tally.go）。
      const aGen = isGeneratedFile(a[0]);
      const bGen = isGeneratedFile(b[0]);
      if (aGen !== bGen) return aGen ? 1 : -1;

      if (a[1].score !== b[1].score) return b[1].score - a[1].score;
      return b[1].nodes.length - a[1].nodes.length;
    });

    // 步骤 3：构建关系图
    const lines: string[] = [
      `## Exploration: ${query}`,
      '',
      `Found ${subgraph.nodes.size} symbols across ${fileGroups.size} files.`,
      '',
    ];

    // 影响半径（始终开启，紧凑型）：对于入口符号，谁依赖它们
    // + 哪些测试覆盖它们——仅位置，无源码——使智能体在编辑前
    // 了解需要更新/验证的内容，无需单独调用。
    const blastRadius = this.buildBlastRadiusSection(cg, subgraph);
    if (blastRadius) lines.push(blastRadius);

    // 关系图——显示符号如何连接
    const significantEdges = subgraph.edges.filter(e =>
      e.kind !== 'contains' // 跳过 contains——文件分组已隐含了它
    );

    if (budget.includeRelationships && significantEdges.length > 0) {
      lines.push('### Relationships');
      lines.push('');

      // 按类型分组边以提高可读性
      const byKind = new Map<string, Array<{ source: string; target: string }>>();
      for (const edge of significantEdges) {
        const sourceNode = subgraph.nodes.get(edge.source);
        const targetNode = subgraph.nodes.get(edge.target);
        if (!sourceNode || !targetNode) continue;

        const group = byKind.get(edge.kind) || [];
        group.push({ source: sourceNode.name, target: targetNode.name });
        byKind.set(edge.kind, group);
      }

      for (const [kind, edges] of byKind) {
        const cap = budget.maxEdgesPerRelationshipKind;
        const shown = edges.slice(0, cap);
        lines.push(`**${kind}:**`);
        for (const e of shown) {
          lines.push(`- ${e.source} → ${e.target}`);
        }
        if (edges.length > cap) {
          lines.push(`- ... and ${edges.length - cap} more`);
        }
        lines.push('');
      }
    }

    // 步骤 4：读取连续文件区段
    // 一次性计算流程主干——用于在前面添加 Flow 节（下方），
    // 并门控自适应源码大小：主干上的文件获得完整源码，
    // 非主干的同类文件进行骨架化。
    const flow = this.buildFlowFromNamedSymbols(cg, query);

    // 自适应大小的多态兄弟检测器。实现/继承共享父类且实现者 >= MIN_SIBLINGS 的类
    // 是许多可互换实现之一（OkHttp 的 14 个 `: Interceptor` 类——
    // 显示一个加其余的签名就足够了），而非不同的流程步骤
    //（Excalidraw 的 `renderStaticScene`，它没有共享父类，
    // 必须保留完整，否则智能体会丢失真实内容）。
    // 只有非主干的兄弟文件进行骨架化；不同步骤和主干文件保留完整源码。
    // 缓存父类→（有 ≥N 个实现者）使其保持为少量边查询。
    const MIN_SIBLINGS = 3;
    const siblingSuper = new Map<string, boolean>();
    const isPolymorphicSibling = (nodes: Node[]): boolean => {
      for (const n of nodes) {
        for (const e of cg.getOutgoingEdges(n.id)) {
          if (e.kind !== 'implements' && e.kind !== 'extends') continue;
          let many = siblingSuper.get(e.target);
          if (many === undefined) {
            many = cg.getIncomingEdges(e.target)
              .filter((x) => x.kind === 'implements' || x.kind === 'extends').length >= MIN_SIBLINGS;
            siblingSuper.set(e.target, many);
          }
          if (many) return true;
        }
      }
      return false;
    };

    // 定义多态父类的文件（有 >=MIN_SIBLINGS 实现者的类/接口）
    // 且与其子类并列的是冗余的"族"文件——
    // Django 的 compiler.py 在 2266 行中包含 `SQLCompiler` 及其 4 个子类
    //（SQLInsert/Update/Delete/AggregateCompiler）。此类文件
    // 体量巨大且无论如何都会被读取，因此即使智能体在其中命名了一个方法，
    // 也应仍然进行骨架化：一个完整文件消耗约 6.5K 的 explore 预算
    //（Django 被钉在 28K 上限，截断），使智能体随后读取的兄弟文件挨饿。
    // 此标志会覆盖下方的命名可调用保留——它本身不会保留一个文件。
    //（OkHttp 的 RealCall 实现了 `Lockable` mixin 但没有定义 ≥3 实现者的父类，
    // 因此命名保留使其保持完整。）
    const superMany = new Map<string, boolean>();
    const definesPolymorphicSupertype = (nodes: Node[]): boolean => {
      for (const n of nodes) {
        if (n.kind !== 'class' && n.kind !== 'interface' && n.kind !== 'struct'
            && n.kind !== 'trait' && n.kind !== 'protocol' && n.kind !== 'type_alias') continue;
        let many = superMany.get(n.id);
        if (many === undefined) {
          many = cg.getIncomingEdges(n.id)
            .filter((x) => x.kind === 'implements' || x.kind === 'extends').length >= MIN_SIBLINGS;
          superMany.set(n.id, many);
        }
        if (many) return true;
      }
      return false;
    };

    lines.push('### Source Code');
    lines.push('');
    lines.push('> The code below is the **verbatim, current on-disk source** of these files — re-read from disk on this call and line-numbered, byte-for-byte identical to what the Read tool returns. It is NOT a summary, outline, or stale cache. Treat each block as a Read you have already performed: do not Read a file shown here.');
    lines.push('');

    let totalChars = lines.join('\n').length;
    let filesIncluded = 0;
    let anyFileTrimmed = false;

    for (const [filePath, group] of sortedFiles) {
      if (filesIncluded >= maxFiles) break;
      // 文件定义了一个命名/主干符号（答案）vs 仅引用了流程。
      // 超过 90% 预算后，停止引入非必要文件——但继续扫描必要文件，
      // 这些文件即使超过上限也会渲染（受 maxFiles 限制）。
      // 没有此 `continue`（之前是无条件 `break`），循环在
      // build + validators-exec 文件后停止，从未到达排名靠前的
      // validate-logic 文件（Alamofire 的 Validation.swift）。
      const fileNecessary = group.nodes.some(n =>
        entryNodeIds.has(n.id) || flow.pathNodeIds.has(n.id) || flow.uniqueNamedNodeIds.has(n.id));
      if (!fileNecessary && totalChars > budget.maxOutputChars * 0.9) continue;

      const absPath = validatePathWithinRoot(projectRoot, filePath);
      if (!absPath || !existsSync(absPath)) continue;

      let fileContent: string;
      try {
        fileContent = readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      const fileLines = fileContent.split('\n');
      const lang = group.nodes[0]?.language || '';

      // 自适应大小（SYNAPSE_ADAPTIVE_EXPLORE，默认开启）：当文件是多态族的
      // 冗余成员时，将其折叠为每符号视图。
      // 当以下所有条件成立时触发：
      //   1. 存在流程主干，
      //   2. 文件中没有符号在该主干上（不是机制路径），
      //   3. 它是多态兄弟（共享父类的 >= MIN_SIBLINGS 实现），
      //   4. 它未被保留，其中文件被保留当且仅当智能体命名了其中的
      //      一个（近）唯一的可调用符号（`getResponseWithInterceptorChain`，1 个定义 →
      //      保持 RealCall.kt 完整），除非文件定义了族父类（
      //      像 Django 的 compiler.py 这样的 base+子类"族"文件——折叠它）。
      //      唯一性很重要：`as_sql` 在每个 Compiler/Expression 子类中有 110 个定义；
      //      命名它绝不能让每个后端变体 + 测试文件保持完整并淹没预算。
      //      这就是保留读取 uniqueNamedNodeIds 的原因。
      // 在折叠文件中，渲染是每符号的（条件 B）：智能体命名或在主干上的
      // 方法显示其完整正文（使智能体不再读取文件来查找它——
      // Django 的 SQLCompiler.execute_sql/as_sql）；每个其他符号只显示签名。
      // 因此基本机制得以保留，而文件其他约 80 个符号 + 冗余子类
      // 各折叠为一行。
      const spareNamed = group.nodes.some(n => flow.uniqueNamedNodeIds.has(n.id));
      const fileDefinesSuper = definesPolymorphicSupertype(group.nodes);
      const spared = spareNamed && !fileDefinesSuper;
      const CALLABLE_BODY = new Set(['method', 'function', 'constructor', 'component']);
      const hasSpineNode = group.nodes.some(n => flow.pathNodeIds.has(n.id));
      // 主干上帝文件：流程路径穿过此文件，但它还包含许多其他命名方法，
      // 全部完整渲染会超过单文件预算并使其他流程文件挨饿
      //（Alamofire：智能体命名了约 7 个 Session.swift 方法——
      // build 主干加上路径外的 task/didCompleteTask——远超整个响应预算）。
      // 启用每符号视图，保持主干完整并将路径外的命名方法折叠为签名。
      // 仅当存在可以去除的路径外内容时才启用——
      // 否则主干不可再简化（顺序流程无冗余），留给正常完整渲染。
      const namedBodyChars = group.nodes
        .filter(n => CALLABLE_BODY.has(n.kind) && (flow.pathNodeIds.has(n.id) || flow.uniqueNamedNodeIds.has(n.id)))
        .reduce((s, n) => s + fileLines.slice(n.startLine - 1, n.endLine).join('\n').length, 0);
      const onSpineGodFile = hasSpineNode
        && namedBodyChars > budget.maxCharsPerFile
        && group.nodes.some(n => CALLABLE_BODY.has(n.kind) && flow.uniqueNamedNodeIds.has(n.id) && !flow.pathNodeIds.has(n.id));
      if (adaptiveExploreEnabled() && flow.pathNodeIds.size > 0
          && (onSpineGodFile || (!hasSpineNode && isPolymorphicSibling(group.nodes) && !spared))) {
        const syms = group.nodes
          .filter(n => n.kind !== 'import' && n.kind !== 'export' && n.startLine > 0)
          .sort((a, b) => a.startLine - b.startLine);
        // 第 1 轮：按优先级贪婪地在单文件正文上限内选择哪些符号获得完整正文——
        // 防止一个庞大的族文件将每个命名方法全量展示而挤占其他流程文件
        //（Django 的 query.py）。符号获得正文若：在主干上，或唯一命名
        //（`SQLCompiler.execute_sql`），或文件定义了族父类时的共命名方法
        //（使基础 `SQLCompiler.as_sql` 正文显示，但 110 个叶 `as_sql` 重载——
        // 以及智能体命名 `intercept` 时 OkHttp 的 5 个 `intercept`——保持签名）。
        const prio = (n: Node) => !CALLABLE_BODY.has(n.kind) ? 99
          : flow.pathNodeIds.has(n.id) ? 0
          : flow.uniqueNamedNodeIds.has(n.id) ? 1
          : (fileDefinesSuper && flow.namedNodeIds.has(n.id)) ? 2 : 99;
        // 每个文件约 250 行的窗口。符号按优先级获取（主干优先，
        // 然后唯一命名，然后族基），且上限适用于所有符号——包括主干——
        // 防止庞大的主干上帝文件（tokio 的 worker.rs：
        // run→run_task→next_task→steal_work）消耗整个响应并使
        // 协流文件（harness.rs 的 poll）挨饿。原生智能体窗口也是如此
        //（每次约 190 行），所以这是模拟，不是截断。
        // 至少总发出 ≥1（绝不为空节）。
        const bodyCap = budget.maxCharsPerFile * 1.5;
        const bodyIds = new Set<string>();
        let bodyChars = 0;
        for (const n of syms.filter(n => prio(n) < 99 && n.endLine >= n.startLine).sort((a, b) => prio(a) - prio(b))) {
          const sz = fileLines.slice(n.startLine - 1, n.endLine).join('\n').length;
          if (bodyChars + sz > bodyCap && bodyIds.size > 0) continue;
          bodyIds.add(n.id);
          bodyChars += sz;
        }
        // 第 2 轮：按行序渲染——选中的符号给出完整正文，其余给出签名行
        //（有上限，带 "+N more" 尾，使上帝文件的结构图不本身膨胀预算）。
        const skel: string[] = [];        let coveredUntil = 0; // 跳过已在已发出正文内的符号
        let sigCount = 0, sigDropped = 0;
        const SIG_MAX = Math.max(12, budget.maxSymbolsInFileHeader * 2);
        for (const n of syms) {
          if (n.startLine <= coveredUntil) continue;
          if (bodyIds.has(n.id)) {
            const end = n.endLine;
            const body = fileLines.slice(n.startLine - 1, end).join('\n');
            skel.push(exploreLineNumbersEnabled() ? numberSourceLines(body, n.startLine) : body);
            coveredUntil = end;
          } else {
            // 省略正文，发出签名。node.startLine 可能指向装饰器/注解，
            // 因此向前扫描以找到命名该符号的行。
            let lineNo = n.startLine;
            for (let k = 0; k < 4; k++) {
              if ((fileLines[n.startLine - 1 + k] || '').includes(n.name)) { lineNo = n.startLine + k; break; }
            }
            if (lineNo <= coveredUntil) continue;
            if (sigCount >= SIG_MAX) { sigDropped++; continue; }
            const sig = (fileLines[lineNo - 1] || '').trim();
            if (sig) { skel.push(exploreLineNumbersEnabled() ? `${lineNo}\t${sig}` : sig); sigCount++; }
          }
        }
        if (sigDropped > 0) skel.push(`… +${sigDropped} more (signatures elided)`);
        if (skel.length > 0) {
          const names = [...new Set(group.nodes.filter(n => n.kind !== 'import' && n.kind !== 'export').map(n => n.name))]
            .slice(0, budget.maxSymbolsInFileHeader).join(', ');
          // 将智能体引导到 synapse_explore 以获取已省略的正文——绝不引导到 Read。
          // 旧的 "Read for more" / "Read for a full body" 标签会邀请
          // 对刚刚骨架化的文件进行 Read；对于中心、需要的文件
          //（Session.swift、DataRequest.swift），这会触发过度调查的螺旋
          //（智能体读取骨架化文件，然后继续深挖）。
          // CLAUDE.md：explore 输出绝不能告诉智能体去 Read。
          const tag = bodyIds.size > 0
            ? 'focused (the methods you named in full, the rest as signatures — synapse_explore a signature by name for its body; do NOT Read)'
            : 'skeleton (signatures only — synapse_explore a name for its full body; do NOT Read)';
          lines.push(`#### ${filePath} — ${names} · ${tag}`, '', '```' + lang, skel.join('\n'), '```', '');
          totalChars += skel.join('\n').length + 120;
          filesIncluded++;
          continue;
        }
      }

      // 全文件规则：若相关文件足够小可以承受，则完整返回它，
      // 而非聚类。聚类的目的是驯服上帝文件
      //（App.tsx 约 13k 行）；对于约 134 行的组件，聚类是
      // 智能体无论如何都会完整读取的文件的有损子集——
      // 每次后续轮次都会花费一次往返和重读。将聚类保留给
      // 太大而无法完整发送的文件。仍受总 maxOutputChars 检查约束。
      //
      // 中心文件（查询入口点所在处）获得更大——但有界——的上限：
      // 它们是答案的核心，是智能体会完整读取的文件，
      // 因此真正较小的文件会完整返回，而非作为稀薄的聚类。
      // 大型中心文件（791 行的 org-user store）超过上限，
      // 回退到下方的分节/聚类——完整方法正文 + 签名——
      // 因此我们永远不会转储（或溢出）整个上帝文件。
      const isCentralFile = centralFiles.has(filePath);
      // 中心文件获得比外围文件稍大的全文件窗口，
      // 但是紧凑的（约 1.5× 单文件上限）：中心文件的原生读取
      // 是约 150–250 行的定向窗口，而非整个文件。
      // 一个单纯的"完整中心文件"既溢出了内联上限，
      // 又使协流文件挨饿（worker.rs 消耗了预算，丢掉了 harness.rs 的 poll）。
      // 较大的中心文件回退到下方的每方法窗口/聚类。
      const WHOLE_FILE_MAX_LINES = isCentralFile ? 280 : 220;
      const WHOLE_FILE_MAX_CHARS = isCentralFile
        ? Math.min(Math.max(0, budget.maxOutputChars - totalChars - 200), Math.round(budget.maxCharsPerFile * 1.5))
        : budget.maxCharsPerFile * 3;
      if (fileLines.length <= WHOLE_FILE_MAX_LINES && fileContent.length <= WHOLE_FILE_MAX_CHARS) {
        const body = fileContent.replace(/\n+$/, '');
        let wholeSection = exploreLineNumbersEnabled() ? numberSourceLines(body, 1) : body;
        const uniqSymbols = [...new Set(
          group.nodes
            .filter(n => n.kind !== 'import' && n.kind !== 'export')
            .map(n => `${n.name}(${n.kind})`)
        )];
        const headerNames = uniqSymbols.slice(0, budget.maxSymbolsInFileHeader);
        const omitted = uniqSymbols.length - headerNames.length;
        const wholeHeader = `#### ${filePath} — ${omitted > 0 ? `${headerNames.join(', ')}, +${omitted} more` : headerNames.join(', ')}`;

        if (!fileNecessary && totalChars + wholeSection.length + 200 > budget.maxOutputChars) {
          // 不要从中间切断整个文件：不适合的非必要文件被跳过；
          // 必要的文件（下方）完整渲染。半个文件会迫使
          // 本应防止的 Read。
          anyFileTrimmed = true;
          continue;
        }
        lines.push(wholeHeader, '', '```' + lang, wholeSection, '```', '');
        totalChars += wholeSection.length + 200;
        filesIncluded++;
        continue;
      }

      // 聚类附近的符号，避免读取相距甚远的符号之间的巨大空隙。
      // 按起始行排序，然后合并重叠/相邻范围（在
      // 自适应间隔阈值内）。同时包含节点范围和边源
      // 位置，使带有组件使用/调用的模板节也被覆盖
      //（不仅限于脚本块符号）。
      //
      // 每个范围带有 `importance` 分数，以便在单文件预算
      // 迫使我们删除某些聚类时对其排名：入口点节点
      // 价值 10，直接连接节点 3，外围节点 1，
      // 裸边源行 2（少于连接节点但多于外围节点——
      // 它们暗示引用，但不是定义）。
      // 正文可能覆盖文件大部分/全部的容器类型。当这样的
      // 节点覆盖文件大部分时，我们从范围中删除它：保留它
      // 会将其中每个方法合并成一个跨越整个文件的巨大聚类，
      // 然后尾部截断到只剩容器的开头行（其头部/声明），
      // 埋没了查询实际询问的方法（#185 跟进——Alamofire 中
      // Session.swift 是典型案例：`Session` 类跨越约 1400 行）。
      // 我们想要其中的细粒度符号，而非外壳。
      const ENVELOPE_KINDS = new Set(['file', 'module', 'class', 'struct', 'interface', 'enum', 'namespace', 'protocol', 'trait', 'component']);
      // 从此文件收集的节点加上智能体命名的任何在此处的可调用符号中进行聚类。
      // Explore 的相关性收集可能错过大型非兄弟文件中的命名方法定义——
      // Django 的 query.py 有 3040 行，`_fetch_all`（L2237）
      // 仅作为调用引用边被收集，从未作为定义，因此没有形成聚类，
      // 智能体只好读取它。直接注入命名定义，并将其重要性排在
      // 连接/胶合节点之上（重要性 9），使其聚类在单文件预算中胜出——
      // 智能体明确请求了这些符号。
      const rangeNodes = new Map<string, Node>();
      for (const n of group.nodes) if (n.startLine > 0 && n.endLine > 0) rangeNodes.set(n.id, n);
      for (const id of flow.namedNodeIds) {
        if (rangeNodes.has(id)) continue;
        const n = cg.getNode(id);
        if (n && n.filePath === filePath && n.startLine > 0 && n.endLine > 0) rangeNodes.set(id, n);
      }
      const ranges: Array<{ start: number; end: number; name: string; kind: string; importance: number }> = [...rangeNodes.values()]
        // 删除全文件外壳节点（覆盖 >50% 文件的容器）。
        .filter(n => !(ENVELOPE_KINDS.has(n.kind) && (n.endLine - n.startLine + 1) > fileLines.length * 0.5))
        .map(n => {
          let importance = 1;
          if (entryNodeIds.has(n.id)) importance = 10;
          else if (flow.namedNodeIds.has(n.id)) importance = 9; // 智能体命名它→保留其聚类
          else if (glueNodeIds.has(n.id)) importance = 6; // 入口点的桥接调用者/被调用者
          else if (connectedToEntry.has(n.id)) importance = 3;
          return { start: n.startLine, end: n.endLine, name: n.name, kind: n.kind, importance };
        });

      // 添加此文件中的边源位置——捕获模板引用
      // （组件使用、事件处理器），这些本身不是节点。
      // 直接从数据库查询边（不仅限于子图），因为 BFS
      // 遍历可能因节点预算而剪掉了模板引用目标。
      const edgeLines = new Set<string>(); // 按 "行:名称" 去重
      for (const node of group.nodes) {
        const outgoing = cg.getOutgoingEdges(node.id);
        for (const edge of outgoing) {
          if (!edge.line || edge.line <= 0 || edge.kind === 'contains') continue;
          const key = `${edge.line}:${edge.target}`;
          if (edgeLines.has(key)) continue;
          edgeLines.add(key);
          // 先从子图查找目标名称，回退到边类型
          const targetNode = subgraph.nodes.get(edge.target);
          const targetName = targetNode?.name ?? edge.kind;
          ranges.push({ start: edge.line, end: edge.line, name: targetName, kind: edge.kind, importance: 2 });
        }
      }

      ranges.sort((a, b) => a.start - b.start);

      if (ranges.length === 0) continue;

      const gapThreshold = budget.gapThreshold;
      const clusters: Array<{ start: number; end: number; symbols: string[]; score: number; maxImportance: number }> = [];
      let current = {
        start: ranges[0]!.start,
        end: ranges[0]!.end,
        symbols: [`${ranges[0]!.name}(${ranges[0]!.kind})`],
        score: ranges[0]!.importance,
        maxImportance: ranges[0]!.importance,
      };

      for (let i = 1; i < ranges.length; i++) {
        const r = ranges[i]!;
        if (r.start <= current.end + gapThreshold) {
          current.end = Math.max(current.end, r.end);
          current.symbols.push(`${r.name}(${r.kind})`);
          current.score += r.importance;
          current.maxImportance = Math.max(current.maxImportance, r.importance);
        } else {
          clusters.push(current);
          current = {
            start: r.start,
            end: r.end,
            symbols: [`${r.name}(${r.kind})`],
            score: r.importance,
            maxImportance: r.importance,
          };
        }
      }
      clusters.push(current);

      // 从聚类构建文件节输出，受单文件预算限制。
      // 病理案例（#185）：像 Session.swift 这样每个方法都相邻的文件
      // 折叠成一个跨越整个文件的聚类，将其倾倒进智能体上下文
      // 是小型项目上的大部分 token 开销。我们按优先级顺序
      // 选取聚类，直到单文件字符上限被触及。真正巨大的单一聚类
      // 会进行尾部截断并带有标记。
      const contextPadding = 3;
      const withLineNumbers = exploreLineNumbersEnabled();
      const buildSection = (c: { start: number; end: number }): string => {
        const startIdx = Math.max(0, c.start - 1 - contextPadding);
        const endIdx = Math.min(fileLines.length, c.end + contextPadding);
        const slice = fileLines.slice(startIdx, endIdx).join('\n');
        // startIdx 是基于 0 的，所以片段的第一行是 startIdx + 1 行。
        return withLineNumbers ? numberSourceLines(slice, startIdx + 1) : slice;
      };
      // 语言中立分隔符（不是 `//`——在 Python、Ruby 等中不是注释）。
      // 开启行号后，行号跳转也表明了间隙。
      const GAP_MARKER = '\n\n... (gap) ...\n\n';

      // 对单文件上限下的包含聚类进行排名。入口点聚类优先：
      // 包含查询入口点的聚类（重要性 10）必须优于密集的
      // 纯声明块，否则在 Session.swift 这样的大文件中，
      // 文件顶部的类头 + 属性列表（许多相邻的低重要性节点，高密度）
      // 会赢得预算，埋没查询询问的实际方法
      //（perform/didCreateURLRequest/task 深藏在文件中）。
      // 在相同重要性层级内，优先选密度（每行分数），
      // 我们仍然倾向集中的聚类而非分散的聚类，然后以
      // 较小的跨度作为包含廉价的决胜。
      const rankedClusters = clusters
        .map((c, i) => ({ idx: i, span: c.end - c.start + 1, c }))
        .sort((a, b) => {
          if (b.c.maxImportance !== a.c.maxImportance) return b.c.maxImportance - a.c.maxImportance;
          const densityA = a.c.score / a.span;
          const densityB = b.c.score / b.span;
          if (densityB !== densityA) return densityB - densityA;
          if (b.c.score !== a.c.score) return b.c.score - a.c.score;
          return a.span - b.span;
        });

      // 单文件预算是单文件上限与总输出上限剩余量中较小的那个——
      // 因此选择（按重要性排名）保留高重要性聚类并删除外围聚类，
      // 而非下游的源序截断切断文件最后的内容。
      // 那个源序切断正是使 Django 的 `_fetch_all`（L2237，重要性
      // 9——智能体命名的）被删除的原因，当 query.py 是四个大文件中
      // 最后发出的时候。
      const fileBudget = Math.min(budget.maxCharsPerFile, Math.max(0, budget.maxOutputChars - totalChars - 200));
      const chosenIndices = new Set<number>();
      let projectedChars = 0;
      for (const rc of rankedClusters) {
        const sectionLen = buildSection(rc.c).length + (chosenIndices.size > 0 ? GAP_MARKER.length : 0);
        // 始终取排名最高的聚类，即使超大，使我们不会
        // 返回空文件节（智能体随后会重新读取文件，
        // 抵消节省）。
        if (chosenIndices.size === 0) {
          chosenIndices.add(rc.idx);
          projectedChars += sectionLen;
          continue;
        }
        if (projectedChars + sectionLen > fileBudget) continue;
        chosenIndices.add(rc.idx);
        projectedChars += sectionLen;
      }

      // 按源序发出选定的聚类，使文件从上到下阅读。
      let fileSection = '';
      const allSymbols: string[] = [];
      for (let i = 0; i < clusters.length; i++) {
        if (!chosenIndices.has(i)) continue;
        const cluster = clusters[i]!;
        const section = buildSection(cluster);
        if (fileSection.length > 0) fileSection += GAP_MARKER;
        fileSection += section;
        allSymbols.push(...cluster.symbols);
      }

      // 选定的聚类是完整的方法范围——我们从不截断正文中间。
      // 超大的单一聚类（一个长的单体函数）完整渲染：
      // 半个方法毫无用处（智能体只会为另一半读取其余内容），
      // 这正是 explore 存在要防止的回退。病理文件受
      // 上方的单文件聚类选择 + 总硬上限约束。
      if (chosenIndices.size < clusters.length) {
        anyFileTrimmed = true;
      }

      // 去重 + 限制单文件头部显示的符号列表。某些
      // 文件（Alamofire 中的 Session.swift）从聚类评分 + 边源行
      // 产生了 3.4KB 的符号列表，远超单文件正文上限。
      // 按频率显示顶部名称，带 "+N more" 尾部。
      const symbolCounts = new Map<string, number>();
      for (const s of allSymbols) {
        symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
      }
      const sortedSymbols = [...symbolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);
      const headerCap = budget.maxSymbolsInFileHeader;
      const headerSymbols = sortedSymbols.slice(0, headerCap);
      const omittedCount = sortedSymbols.length - headerSymbols.length;
      const headerSuffix = omittedCount > 0
        ? `${headerSymbols.join(', ')}, +${omittedCount} more`
        : headerSymbols.join(', ');
      const fileHeader = `#### ${filePath} — ${headerSuffix}`;

      // 总上限仅约束非必要文件。定义了智能体命名的符号
      //（或在流程主干上）的文件即使名义上的总量已用完也会渲染——
      // 它是答案，且集合由 maxFiles 以及真正主干/命名种子注入
      // 已将每个文件裁剪到必要内容来约束。仅引用流程的文件
      //（Combine.swift 提到了 request/task）是非必要的→仍受上限约束，
      // 释放的预算不会泄漏到噪音中。这是最后的上帝文件层：
      // build（Session，真正主干）+ validators-exec（Request）+ validate
      //（DataRequest/Validation）全部渲染，而非上限删除
      // 文件顺序碰巧排在最后的那个阶段。
      if (!fileNecessary && totalChars + fileSection.length + 200 > budget.maxOutputChars) {
        // 不适合的非必要文件：完整跳过——绝不截断方法中间。
        // 继续扫描必要文件（绕过此上限并完整渲染，
        // 受硬上限约束）。
        anyFileTrimmed = true;
        continue;
      }

      lines.push(fileHeader);
      lines.push('');
      lines.push('```' + lang);
      lines.push(fileSection);
      lines.push('```');
      lines.push('');

      totalChars += fileSection.length + 200;
      filesIncluded++;
    }

    // 将剩余文件作为引用添加（来自相关和外围文件）。
    // 小型项目（按预算）跳过此步——相关内容已适合源码节，
    // 末尾的指针列表纯属开销。
    if (budget.includeAdditionalFiles) {
      const remainingRelevant = sortedFiles.slice(filesIncluded);
      const peripheralFiles = [...fileGroups.entries()]
        .filter(([, group]) => group.score < 3)
        .sort((a, b) => b[1].score - a[1].score);
      const remainingFiles = [...remainingRelevant, ...peripheralFiles];
      if (remainingFiles.length > 0) {
        lines.push('### Not shown above — explore these names for their source');
        lines.push('');
        for (const [filePath, group] of remainingFiles.slice(0, 10)) {
          const symbols = group.nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
          lines.push(`- ${filePath}: ${symbols}`);
        }
        if (remainingFiles.length > 10) {
          lines.push(`- ... and ${remainingFiles.length - 10} more files`);
        }
      }
    }

    // 添加完整性信号，使智能体知道无需重新读取这些文件。
    // 在小型项目上，预算会关闭此功能——但若确实需要
    // 截断或删除聚类，呈现一条简短说明，使智能体知道
    // 仍然可以 Read 以获取更多细节。
    if (budget.includeCompletenessSignal) {
      lines.push('');
      lines.push('---');
      lines.push(`> **Complete source for ${filesIncluded} files is included above — do NOT re-read them.** If your question also needs files/symbols listed under "Not shown above" (or any area this call didn't cover), make ANOTHER synapse_explore targeting those names — it returns the same source with line numbers and is cheaper and more complete than reading. Reserve Read for a single specific line range explore can't surface.`);
    } else if (anyFileTrimmed) {
      lines.push('');
      lines.push(`> Some file sections were trimmed for size. For a specific symbol you still need, run another \`synapse_explore\` (or \`synapse_node\`) with its exact name — line-numbered source, cheaper and more complete than Read.`);
    }

    // 根据项目规模添加 explore 预算说明
    if (budget.includeBudgetNote) {
      try {
        const stats = cg.getStats();
        const callBudget = getExploreBudget(stats.fileCount);
        lines.push('');
        lines.push(`> **Explore budget: ${callBudget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).** Each call covers ~6 files; if your question spans more, spend your remaining calls on the uncovered area BEFORE falling back to Read — another explore is cheaper and more complete than reading those files. Synthesize once you've used ${callBudget}.`);
      } catch {
        // 统计不可用——跳过预算说明
      }
    }

    // 最终上限——绝对的内联上限，不是预算的倍数。
    // 渲染循环在 maxOutputChars 之外渲染必要（命名/主干）文件，
    // 仅限制非必要文件，因此这是最后的安全措施。
    // 它必须低于宿主的内联工具结果限制（约 25K 字符）：
    // 超过该限制，结果将外部化为智能体读回的文件
    //（35K 的 vscode explore 在 n=4 A/B 中正是这样做的）。
    // 因此允许在 24K 预算之上有少量必要溢出，但硬停在 25K——
    // 永远不进入外部化领域。
    const output = flow.text + lines.join('\n');
    const hardCeiling = Math.min(Math.round(budget.maxOutputChars * 1.5), 25000);
    if (output.length > hardCeiling) {
      // 在文件节边界（上限前的最后一个 `#### ` 头部）切断，
      // 以便删除整个尾部文件节，而非截断方法正文中间——
      // 半渲染的方法只会迫使此工具本应防止的 Read。
      // 仅在没有节头位于后半部分时回退到行边界（退化的单巨大节情况）。
      const cut = output.slice(0, hardCeiling);
      const lastSection = cut.lastIndexOf('\n#### ');
      const boundary = lastSection > hardCeiling * 0.5 ? lastSection : cut.lastIndexOf('\n');
      const safe = boundary > 0 ? cut.slice(0, boundary) : cut;
      return this.textResult(safe + '\n\n... (output truncated to budget; the source above is complete and verbatim — treat it as already Read. For any area not covered, run another synapse_explore with the specific names — do NOT Read these files.)');
    }
    return this.textResult(output);
  }

  /**
   * 处理 synapse_node
   */
  private async handleNode(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getSynapse(args.projectPath as string | undefined);
    // 默认为 false 以最小化上下文使用
    const includeCode = args.includeCode === true;
    const fileHint = typeof args.file === 'string' && args.file.trim() ? args.file.trim() : undefined;
    const lineHint = typeof args.line === 'number' && args.line > 0 ? args.line : undefined;
    const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : undefined;
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : undefined;
    const symbolsOnly = args.symbolsOnly === true;
    const symbolRaw = typeof args.symbol === 'string' ? args.symbol.trim() : '';

    // 文件读取模式：无 `symbol` 的 `file` 像 Read 工具一样读取该文件——
    // 带行号的当前磁盘源，可用 `offset`/`limit` 缩窄，与 Read 完全相同——
    // 加上一行影响半径头部（哪些文件依赖它）。
    // `symbolsOnly` 仅返回结构图。由索引支撑：与 Read 给出的字节相同。
    if (!symbolRaw && fileHint) {
      return this.handleFileView(cg, fileHint, { offset, limit, symbolsOnly });
    }

    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    let matches = this.findSymbolMatches(cg, symbol);
    if (matches.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    // 将重度重载的名称消歧为调用方通过文件/行确定的特定定义
    //（路径或另一工具显示的 `file:line`）——
    // 使其能从 50+ 个 `poll` 中获取例如 harness.rs:153 的 `Harness::poll`，
    // 而非读取文件。file 按路径后缀/子字符串匹配；line 优先选择
    // 正文包含该行的定义，否则选择最近的起始位置。
    // 只缩小（从不清空——若提示不匹配任何内容则忽略它）。
    if (matches.length > 1 && (fileHint || lineHint !== undefined)) {
      const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
      let narrowed = matches;
      if (fileHint) {
        const fh = norm(fileHint);
        const byFile = narrowed.filter((n) => norm(n.filePath).endsWith(fh) || norm(n.filePath).includes(fh));
        if (byFile.length > 0) narrowed = byFile;
      }
      if (lineHint !== undefined && narrowed.length > 1) {
        const containing = narrowed.filter((n) => n.startLine <= lineHint && (n.endLine ?? n.startLine) >= lineHint);
        narrowed = containing.length > 0
          ? containing
          : [...narrowed].sort((a, b) => Math.abs(a.startLine - lineHint) - Math.abs(b.startLine - lineHint)).slice(0, 1);
      }
      if (narrowed.length > 0) matches = narrowed;
    }

    // 单一定义——常见情况。
    if (matches.length === 1) {
      return this.textResult(this.truncateOutput(await this.renderNodeSection(cg, matches[0]!, includeCode)));
    }

    // 多个定义共享此名称——重载，或不同类型上的同名方法
    //（Alamofire 的 `didCompleteTask`/`task`/`validate`，gin 的 `reset`）。
    // 仅返回一个会迫使智能体猜测，当猜错时它会读取文件来找到正确的重载——
    // 这是 Swift/Go 中 synapse_node 读取的主要原因。因此返回全部：
    // 在字符预算内尽可能打包完整正文（智能体在这一次调用中获得它需要的，
    // 无需学习后续参数），并将任何剩余的以 file:line 形式列出，
    // 使大型重载集不会溢出单工具上限。
    const header = `**${matches.length} definitions named "${symbol}"**`;
    if (!includeCode) {
      const list = matches.map((n) => `- \`${n.name}\` (${n.kind}) — ${n.filePath}:${n.startLine}`);
      return this.textResult(this.truncateOutput(
        [header, '', 'Re-query with `includeCode: true` to get every body in one call — no need to pick one first.', '', ...list].join('\n'),
      ));
    }

    const BODY_BUDGET = 12000; // 在 MAX_OUTPUT_LENGTH 下留出头部 + 列表的空间
    // 字符预算是真正的限制器——保持计数上限较高，使一组
    // 短重载（Alamofire 的 10 个 `validate` 变体，每个只有几行）
    // 全部完整渲染，而非将智能体想要的那个降为无正文列表。
    // 只有一组许多大型正文才会先触及字符预算。
    const HARD_CAP = 16;
    const rendered: string[] = [];
    const listed: Node[] = [];
    let used = 0;
    for (const n of matches) {
      if (rendered.length >= HARD_CAP) { listed.push(n); continue; }
      const section = await this.renderNodeSection(cg, n, true);
      // 始终发出第一个；仅在字符预算内发出其余的。
      if (rendered.length === 0 || used + section.length <= BODY_BUDGET) {
        rendered.push(section);
        used += section.length;
      } else {
        listed.push(n);
      }
    }

    const out: string[] = [
      header,
      `Returning ${rendered.length} in full${listed.length ? `; ${listed.length} more listed below` : ''} — pick the one you need (no Read required).`,
      '',
      rendered.join('\n\n---\n\n'),
    ];
    if (listed.length) {
      const LIST_CAP = 20;
      const shownList = listed.slice(0, LIST_CAP);
      out.push(
        '',
        '### Other definitions',
        ...shownList.map((n) => `- \`${n.name}\` (${n.kind}) — ${n.filePath}:${n.startLine}`),
      );
      if (listed.length > LIST_CAP) out.push(`- … +${listed.length - LIST_CAP} more`);
      out.push(
        '',
        `> Need one of these in full? Call synapse_node again with \`file\` (e.g. \`"${listed[0]!.filePath.split('/').pop()}"\`) or \`line\` — do NOT Read it.`,
      );
    }
    return this.textResult(this.truncateOutput(out.join('\n')));
  }

  /**
   * 文件读取模式：将 `fileArg`（路径或基名）解析为已索引文件，
   * 像 Read 工具一样读取它——带行号的当前磁盘源，可用 `offset`/`limit`
   * 精确缩窄，与 Read 完全相同——前面加一行影响半径头部（哪些文件依赖它）。
   * `symbolsOnly` 仅返回结构图（符号 + 依赖者），而非源码。
   *
   * 奇偶目标：编号源块与 Read 返回的形状字节完全相同
   *（`<n>\t<line>`，无填充），使智能体将其视为 Read——
   * 只是更快（由索引提供）且带影响半径。安全性：
   * yaml/properties 文件按键汇总，从不转储（#383）；
   * 读取通过 validatePathWithinRoot（#527）进行。
   */
  private async handleFileView(
    cg: Synapse,
    fileArg: string,
    opts: { offset?: number; limit?: number; symbolsOnly?: boolean } = {},
  ): Promise<ToolResult> {
    const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^(?:\.?\/+)+/, '').replace(/\/+$/, '');
    const wantLower = normalize(fileArg).toLowerCase();
    const allFiles = cg.getFiles();
    if (allFiles.length === 0) return this.textResult('No files indexed. Run `synapse index` first.');

    let resolved = allFiles.find((f) => f.path.toLowerCase() === wantLower);
    let candidates: typeof allFiles = [];
    if (!resolved) {
      candidates = allFiles.filter((f) => f.path.toLowerCase().endsWith('/' + wantLower));
      if (candidates.length === 1) resolved = candidates[0];
    }
    if (!resolved && candidates.length === 0) {
      candidates = allFiles.filter((f) => f.path.toLowerCase().includes(wantLower));
      if (candidates.length === 1) resolved = candidates[0];
    }
    if (!resolved && candidates.length > 1) {
      return this.textResult(
        [`"${fileArg}" matches ${candidates.length} indexed files — pass a longer path:`, '',
          ...candidates.slice(0, 25).map((f) => `- ${f.path}`)].join('\n'),
      );
    }
    if (!resolved) {
      return this.textResult(
        `No indexed file matches "${fileArg}". Synapse indexes source files; configs/docs it doesn't parse won't appear — Read those directly.`,
      );
    }

    const filePath = resolved.path;
    const nodes = cg.getNodesInFile(filePath)
      .filter((n) => n.kind !== 'file' && n.kind !== 'import' && n.kind !== 'export')
      .sort((a, b) => a.startLine - b.startLine);
    const dependents = cg.getFileDependents(filePath);

    // 紧凑的单行影响半径（synapse 相较于纯 Read 的增值点）。
    const depSummary = dependents.length
      ? `used by ${dependents.length} file${dependents.length === 1 ? '' : 's'}: ${dependents.slice(0, 8).join(', ')}${dependents.length > 8 ? `, +${dependents.length - 8} more` : ''}`
      : 'no other indexed file depends on it';

    // 符号图渲染器——用于 symbolsOnly、配置回退和读取错误。
    const symbolMap = (heading: string, limit = 200): string[] => {
      const lines: string[] = [heading];
      for (const n of nodes.slice(0, limit)) {
        const sig = n.signature ? ` ${n.signature.replace(/\s+/g, ' ').trim()}` : '';
        lines.push(`- \`${n.name}\` (${n.kind})${sig} — :${n.startLine}`);
      }
      if (nodes.length > limit) lines.push(`- … +${nodes.length - limit} more`);
      return lines;
    };

    // symbolsOnly → 廉价的结构概览，不含源码。
    if (opts.symbolsOnly) {
      const out = [`**${filePath}** — ${nodes.length} symbol${nodes.length === 1 ? '' : 's'}, ${depSummary}`, ''];
      if (nodes.length) out.push(...symbolMap('### Symbols'));
      else out.push('_No indexed symbols in this file._');
      out.push('', '> Drop `symbolsOnly` (or pass `offset`/`limit`) to read the source, like Read.');
      return this.textResult(this.truncateOutput(out.join('\n')));
    }

    // 安全性（#383）：绝不转储原始配置/数据文件——yaml/properties 行的格式为
    // `key: <secret>`。按键汇总并指向真实的 Read 操作。
    if (CONFIG_LEAF_LANGUAGES.has(resolved.language)) {
      const out = [`**${filePath}** — configuration/data file, ${depSummary}`, ''];
      if (nodes.length) out.push(...symbolMap('### Keys (values withheld for safety)'));
      out.push('', '> Values may be secrets, so synapse indexes keys only. Read the file directly if you need a value.');
      return this.textResult(this.truncateOutput(out.join('\n')));
    }

    // 通过安全检查点从磁盘读取当前字节
    //（validatePathWithinRoot：阻止 `../` 穿越和符号链接逃逸，#527）。
    const abs = validatePathWithinRoot(cg.getProjectRoot(), filePath);
    let content: string | null = null;
    if (abs) {
      try { content = readFileSync(abs, 'utf-8'); } catch { content = null; }
    }
    if (content === null) {
      const out = [`**${filePath}** — could not read from disk (it may have moved since indexing). ${depSummary}`, ''];
      if (nodes.length) out.push(...symbolMap('### Symbols'));
      out.push('', `> Read \`${filePath}\` directly for its current content.`);
      return this.textResult(this.truncateOutput(out.join('\n')));
    }

    // 与 Read 完全相同地拆分——保留末尾换行产生的空行
    //（Read 也会对它编号），使行号字节完全对应。
    const fileLines = content.split('\n');
    const total = fileLines.length;

    // 与 Read 完全一致的窗口化：`offset`/`limit` 的含义与 Read 中完全相同
    //（从 1 开始的行号；最大行数）。默认：整个文件，上限与 Read 一样为
    // 2000 行，并受字符预算约束（跟踪 explore 经过验证的安全上限约 38K 字符）。
    // 溢出会明确说明（Read 也会分页）——永远不进行静默的 15K truncateOutput 截断。
    const CHAR_BUDGET = 38000;
    const DEFAULT_LIMIT = 2000;
    const offset = Math.max(1, opts.offset ?? 1);
    if (offset > total) {
      return this.textResult(`**${filePath}** has ${total} line${total === 1 ? '' : 's'} — offset ${offset} is past the end. ${depSummary}`);
    }
    const maxLines = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
    const start = offset - 1; // 0-based
    const header = `**${filePath}** — ${total} lines, ${nodes.length} symbol${nodes.length === 1 ? '' : 's'} · ${depSummary}`;

    // 编号行，与 Read 输出格式完全相同：`<n>\t<line>`，不左填充。
    const numbered: string[] = [];
    let used = header.length + 8;
    let i = start;
    for (; i < total && numbered.length < maxLines; i++) {
      const ln = `${i + 1}\t${fileLines[i]}`;
      if (used + ln.length + 1 > CHAR_BUDGET && numbered.length > 0) break;
      numbered.push(ln);
      used += ln.length + 1;
    }
    const shownEnd = start + numbered.length;
    const complete = offset === 1 && shownEnd >= total;

    const out: string[] = [header, '', ...numbered];
    if (!complete) {
      out.push(
        '',
        `(lines ${offset}–${shownEnd} of ${total} — pass \`offset\`/\`limit\` for another range, or \`synapse_node <symbol>\` for one symbol in full)`,
      );
    }
    // 自行受 CHAR_BUDGET 约束——不要经过 truncateOutput（15K）。
    return this.textResult(out.join('\n'));
  }

  /** 渲染单个符号：详情 + （可选）正文/概要 + 调用者/被调用者路径。 */
  private async renderNodeSection(cg: Synapse, node: Node, includeCode: boolean): Promise<string> {
    let code: string | null = null;
    let outline: string | null = null;
    if (includeCode) {
      // 对于容器符号（class/interface/struct/……），完整正文是每个方法正文之和——
      // 是一堵源码之墙。改为返回结构概要（成员 + 签名 + 行号）；
      // 叶节点符号则返回完整正文。
      if (CONTAINER_NODE_KINDS.has(node.kind)) {
        outline = this.buildContainerOutline(cg, node);
      }
      if (!outline) {
        code = await cg.getCode(node.id);
      }
    }
    return this.formatNodeDetails(node, code, outline) + this.formatTrail(cg, node);
  }

  /**
   * 构建符号的"路径"：其直接被调用者（它调用什么）和调用者（什么调用它），
   * 每项附带 file:line——使 synapse_node 同时充当结构化的 Grep→Read→展开
   * 原语：一个位置加上后续的跳转方向。上限保持廉价。通过对路径条目调用
   * synapse_node 来遍历图；已覆盖的跳转无需 Read。非叶节点的空边通常意味着
   * 静态图无法解析的动态分发——这种缺失本身就是一个信号（读那一跳），
   * 而非死路。
   */
  private formatTrail(cg: Synapse, node: Node): string {
    const TRAIL_CAP = 12;
    const fmt = (e: { node: Node; edge: Edge }) => {
      const base = `${e.node.name} (${e.node.filePath}:${e.node.startLine})`;
      const synth = this.synthEdgeNote(e.edge);
      return synth ? `${base} [${synth.compact}]` : base;
    };
    const collect = (edges: Array<{ node: Node; edge: Edge }>): Array<{ node: Node; edge: Edge }> => {
      const seen = new Set<string>([node.id]);
      const out: Array<{ node: Node; edge: Edge }> = [];
      for (const e of edges) {
        if (seen.has(e.node.id)) continue;
        seen.add(e.node.id);
        out.push(e);
      }
      return out;
    };
    const callees = collect(cg.getCallees(node.id));
    const callers = collect(cg.getCallers(node.id));
    if (callees.length === 0 && callers.length === 0) return '';
    const lines: string[] = ['', '### Trail — synapse_node any of these to follow it (no Read needed)'];
    if (callees.length > 0) {
      lines.push(`**Calls →** ${callees.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callees.length > TRAIL_CAP ? `, +${callees.length - TRAIL_CAP} more` : ''}`);
    }
    if (callers.length > 0) {
      lines.push(`**Called by ←** ${callers.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callers.length > TRAIL_CAP ? `, +${callers.length - TRAIL_CAP} more` : ''}`);
    }
    return lines.join('\n');
  }

  /**
   * 处理 synapse_status
   */
  private async handleStatus(args: Record<string, unknown>): Promise<ToolResult> {
    let cg = this.getSynapse(args.projectPath as string | undefined);
    // 与 withStalenessNotice 相同的技巧——当显式 projectPath 解析到与默认会话 cg
    // 相同的项目时，优先使用默认实例，使 getPendingFiles()（仅由默认实例的
    // 监视器填充）在有待处理编辑时为非空。
    if (this.cg && cg !== this.cg) {
      try {
        if (resolvePath(this.cg.getProjectRoot()) === resolvePath(cg.getProjectRoot())) {
          cg = this.cg;
        }
      } catch { /* 已关闭的实例——保持原样 */ }
    }
    const stats = cg.getStats();

    // 当此索引实际上属于不同的 git 工作树时发出警告
    //（例如服务器从嵌套 worktree 向上解析到主检出）。
    // 此时查询反映的是那棵树的分支，而非正在编辑的 worktree。
    // status 显示详细的多行形式；读取工具通过 withWorktreeNotice 获取紧凑的单行提示。
    // 两者共享缓存的检测结果。
    const mismatch = this.worktreeMismatchFor(args.projectPath as string | undefined);

    const lines: string[] = [
      '## Synapse Status',
      '',
    ];
    if (mismatch) {
      lines.push(`> ⚠ ${worktreeMismatchWarning(mismatch).replace(/\n/g, '\n> ')}`, '');
    }
    lines.push(
      `**Files indexed:** ${stats.fileCount}`,
      `**Total nodes:** ${stats.nodeCount}`,
      `**Total edges:** ${stats.edgeCount}`,
      `**Database size:** ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
    );

    // 显示当前活跃的 SQLite 后端（node:sqlite，Node 内置的真实
    // SQLite——完整的 WAL + FTS5，无需原生构建）。
    lines.push(`**Backend:** node:sqlite (Node built-in) — full WAL + FTS5`);

    // 有效的日志模式。'wal' ⇒ 并发读取永不阻塞写入；
    // 其他模式 ⇒ 可能阻塞（"数据库被锁定"）。node:sqlite 在所有平台都支持 WAL，
    // 因此非 wal 模式意味着文件系统不支持（网络挂载/虚拟化挂载、WSL2 /mnt）。
    // 参见 issue #238。
    const journalMode = cg.getJournalMode();
    if (journalMode === 'wal') {
      lines.push(`**Journal mode:** wal (concurrent reads safe)`);
    } else {
      lines.push(
        `**Journal mode:** ⚠ ${journalMode || 'unknown'} — WAL not active, so reads ` +
        `can block on a concurrent write (WAL appears unsupported on this filesystem)`
      );
    }

    lines.push('', '### Nodes by Kind:');

    for (const [kind, count] of Object.entries(stats.nodesByKind)) {
      if ((count as number) > 0) {
        lines.push(`- ${kind}: ${count}`);
      }
    }

    lines.push('', '### Languages:');
    for (const [lang, count] of Object.entries(stats.filesByLanguage)) {
      if ((count as number) > 0) {
        lines.push(`- ${lang}: ${count}`);
      }
    }

    // 全量索引降级（#876）：当实时监视永久停止时，getPendingFiles() 为空
    //（因此下方无"待处理同步"节），但索引已冻结——在此明确指出，
    // 这是智能体询问"索引是否最新？"的唯一位置。
    if (cg.isWatcherDegraded()) {
      lines.push(
        '',
        '### Auto-sync disabled:',
        `- ${cg.getWatcherDegradedReason() ?? 'live file watching stopped'}`,
        '- The index is frozen; Read files directly for current content.'
      );
    }

    // 单文件新鲜度——是自动前置过期横幅（issue #403）的对立面。
    // 在 `status` 中呈现，为智能体提供一个统一的位置来询问
    // "索引是否已跟上？"，而无需从其他工具调用的横幅中推断。
    const pending = cg.getPendingFiles();
    if (pending.length > 0) {
      lines.push('', '### Pending sync:');
      const now = Date.now();
      for (const p of pending) {
        const ageMs = Math.max(0, now - p.lastSeenMs);
        const label = p.indexing ? 'indexing in progress' : 'pending sync';
        lines.push(`- ${p.path} (edited ${ageMs}ms ago, ${label})`);
      }
    }

    return this.textResult(lines.join('\n'));
  }

  /**
   * 处理 synapse_files——从索引获取项目文件结构
   */
  private async handleFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getSynapse(args.projectPath as string | undefined);
    const pathFilter = args.path as string | undefined;
    const pattern = args.pattern as string | undefined;
    const format = (args.format as 'tree' | 'flat' | 'grouped') || 'tree';
    const includeMetadata = args.includeMetadata !== false;
    const maxDepth = args.maxDepth != null ? clamp(args.maxDepth as number, 1, 20) : undefined;

    // 从索引获取所有文件
    const allFiles = cg.getFiles();

    if (allFiles.length === 0) {
      return this.textResult('No files indexed. Run `synapse index` first.');
    }

    // 按路径前缀过滤。存储路径是项目相对 POSIX 格式（如 "src/foo.ts"），
    // 但智能体通常传入项目根目录的变体，如 "/"、"."、"./"、"" 或
    // Windows 风格的 "src\foo"——以及带前导 "/"、"./" 或 "\" 的前缀。
    // 在匹配前对所有这些情况进行归一化，使智能体能获得结果，
    // 而非回退到 Read/Glob（参见 #426）。
    const normalizedFilter = pathFilter
      ? pathFilter
          .replace(/\\/g, '/')
          .replace(/^(?:\.?\/+)+/, '')
          .replace(/^\.$/, '')
          .replace(/\/+$/, '')
      : '';
    let files = normalizedFilter
      ? allFiles.filter(f => f.path === normalizedFilter || f.path.startsWith(normalizedFilter + '/'))
      : allFiles;

    // 按 glob 模式过滤
    if (pattern) {
      const regex = this.globToRegex(pattern);
      files = files.filter(f => regex.test(f.path));
    }

    if (files.length === 0) {
      return this.textResult(`No files found matching the criteria.`);
    }

    // 格式化输出
    let output: string;
    switch (format) {
      case 'flat':
        output = this.formatFilesFlat(files, includeMetadata);
        break;
      case 'grouped':
        output = this.formatFilesGrouped(files, includeMetadata);
        break;
      case 'tree':
      default:
        output = this.formatFilesTree(files, includeMetadata, maxDepth);
        break;
    }

    return this.textResult(this.truncateOutput(output));
  }

  /**
   * 将 glob 模式转换为正则表达式
   */
  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // 转义特殊正则字符，* 和 ? 除外
      .replace(/\*\*/g, '{{GLOBSTAR}}')       // ** 的临时占位符
      .replace(/\*/g, '[^/]*')                // * 匹配除 / 以外的任何内容
      .replace(/\?/g, '[^/]')                 // ? 匹配除 / 以外的单个字符
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');    // ** 匹配包括 / 在内的任何内容
    return new RegExp(escaped);
  }

  /**
   * 将文件格式化为平铺列表
   */
  private formatFilesFlat(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
    const lines: string[] = [`## Files (${files.length})`, ''];

    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      if (includeMetadata) {
        lines.push(`- ${file.path} (${file.language}, ${file.nodeCount} symbols)`);
      } else {
        lines.push(`- ${file.path}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 将文件按语言分组格式化
   */
  private formatFilesGrouped(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
    const byLang = new Map<string, typeof files>();

    for (const file of files) {
      const existing = byLang.get(file.language) || [];
      existing.push(file);
      byLang.set(file.language, existing);
    }

    const lines: string[] = [`## Files by Language (${files.length} total)`, ''];

    // 按文件数降序排列语言
    const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [lang, langFiles] of sortedLangs) {
      lines.push(`### ${lang} (${langFiles.length})`);
      for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
        if (includeMetadata) {
          lines.push(`- ${file.path} (${file.nodeCount} symbols)`);
        } else {
          lines.push(`- ${file.path}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 将文件格式化为树形结构
   */
  private formatFilesTree(
    files: { path: string; language: string; nodeCount: number }[],
    includeMetadata: boolean,
    maxDepth?: number
  ): string {
    // 构建树形结构
    interface TreeNode {
      name: string;
      children: Map<string, TreeNode>;
      file?: { language: string; nodeCount: number };
    }

    const root: TreeNode = { name: '', children: new Map() };

    for (const file of files) {
      const parts = file.path.split('/');
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;

        if (!current.children.has(part)) {
          current.children.set(part, { name: part, children: new Map() });
        }
        current = current.children.get(part)!;

        // 若这是最后一段，则为文件
        if (i === parts.length - 1) {
          current.file = { language: file.language, nodeCount: file.nodeCount };
        }
      }
    }

    // 渲染树形结构
    const lines: string[] = [`## Project Structure (${files.length} files)`, ''];

    const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
      if (maxDepth !== undefined && depth > maxDepth) return;

      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (node.name) {
        let line = prefix + connector + node.name;
        if (node.file && includeMetadata) {
          line += ` (${node.file.language}, ${node.file.nodeCount} symbols)`;
        }
        lines.push(line);
      }

      const children = [...node.children.values()];
      // 排序：目录在前，文件在后，均按字母顺序
      children.sort((a, b) => {
        const aIsDir = a.children.size > 0 && !a.file;
        const bIsDir = b.children.size > 0 && !b.file;
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        const nextPrefix = node.name ? prefix + childPrefix : prefix;
        renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
      }
    };

    renderNode(root, '', true, 0);

    return lines.join('\n');
  }

  // =========================================================================
  // 符号解析辅助方法
  // =========================================================================

  /**
   * 按名称查找符号，当存在多个匹配时进行消歧。
   * 返回最佳匹配以及可选的候选说明。
   */
  /**
   * 检查节点是否匹配符号查询。
   *
   * 接受简单名称（`run`）和三种限定符形式：
   *   - 点号     `Session.request`         （TS/JS/Python）
   *   - 双冒号   `stage_apply::run`        （Rust、C++、Ruby）
   *   - 斜杠     `configurator/stage_apply`（路径形式）
   *
   * 多层限定符可组合：`crate::configurator::stage_apply::run`
   * 有效。Rust 路径前缀（`crate`、`super`、`self`）会被剥离，
   * 使规范的 `crate::module::symbol` 形式能够正确解析。
   *
   * 解析顺序，最后一段必须始终等于 `node.name`：
   *   1. 对 `qualifiedName` 进行后缀匹配（处理类范围的方法——
   *      提取器从 AST 栈构建限定名）
   *   2. 文件路径包含检查（处理 Rust/Python 的文件派生模块——
   *      `stage_apply::run` 匹配 `stage_apply.rs` 中的 `run`）
   */
  private matchesSymbol(node: Node, symbol: string): boolean {
    // 简单名称匹配
    if (node.name === symbol) return true;
    // 文件基名匹配（例如 "product-card" 匹配 "product-card.liquid"）
    if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;

    // 限定名查找：按任意支持的分隔符拆分。`\w` 保留标识符字符（含 `_`）；
    // 其他一切均视为可容忍的分隔符。
    if (!/[.\/]|::/.test(symbol)) return false;
    const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
    if (parts.length < 2) return false;

    const lastPart = parts[parts.length - 1]!;
    if (node.name !== lastPart) return false;

    // 阶段 1：限定名后缀匹配。提取器用 `::` 连接语义层次，
    // 因此 `Session.request` 和 `Session::request` 在此均变为 `Session::request`。
    const colonSuffix = parts.join('::');
    if (node.qualifiedName.includes(colonSuffix)) return true;

    // 阶段 2：文件路径包含检查。Rust 模块和 Python 包
    // 不在 `qualifiedName` 中——它们编码在文件路径里。因此
    // `stage_apply::run` 匹配路径中包含 `stage_apply` 段（有无扩展名均可）的
    // 任意文件中的 `run`。
    //
    // 过滤掉无文件系统对应物的 Rust 路径前缀。
    const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
    if (containerHints.length === 0) return false;

    const segments = node.filePath.split('/').filter((s) => s.length > 0);
    return containerHints.every((hint) =>
      segments.some((seg) => seg === hint || seg.replace(/\.[^.]+$/, '') === hint)
    );
  }

  /**
   * 查找与名称匹配的所有定义（已排名），使 synapse_node 能返回每个重载
   * 而非猜测其中一个（猜错 → 触发 Read）。非生成文件排在生成桩文件
   *（.pb.go 等）之前；组内稳定保留 FTS 顺序。无匹配时返回 []；
   * 限定名查找若无精确匹配，返回 [] 而非误导性的模糊文件命中（#173）；
   * 无精确匹配的裸名称回退到单个最高模糊结果。
   */
  private findSymbolMatches(cg: Synapse, symbol: string): Node[] {
    const isQualified = /[.\/]|::/.test(symbol);

    // 对于裸名称，通过直接索引枚举每个精确名称的定义
    //（非 FTS，FTS 会加上限 + 排名）：tokio 的 `poll` 有 50+ 个定义，
    // 调用方想要的那个（harness.rs:153 的 `Harness::poll`）排在任何搜索截止线以下，
    // 因此既无法被渲染，也无法被 file/line 消歧器定位——智能体只好读取文件。
    // 有了完整集合，多重载渲染 + file/line 过滤器均可到达它。
    if (!isQualified) {
      const exact = cg.getNodesByName(symbol);
      if (exact.length > 0) {
        return [...exact].sort((a, b) => (isGeneratedFile(a.filePath) ? 1 : 0) - (isGeneratedFile(b.filePath) ? 1 : 0));
      }
      // 无精确匹配——使用单个最高模糊结果（例如文件基名）。
      const fuzzy = cg.searchNodes(symbol, { limit: 10 });
      return fuzzy[0] ? [fuzzy[0].node] : [];
    }

    // 限定名查找（`Session.request`、`stage_apply::run`）：FTS + matchesSymbol。
    const limit = 50;
    let results = cg.searchNodes(symbol, { limit });

    // FTS 会剥离冒号，因此 `stage_apply::run` 搜索字面量 `stage_applyrun`
    // 并找不到任何内容。改为按裸尾部重搜，让 `matchesSymbol` 按限定符过滤。
    if (isQualified && results.length === 0) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit });
    }

    if (results.length === 0) return [];

    const exactMatches = results.filter((r) => this.matchesSymbol(r.node, symbol));
    if (exactMatches.length === 0) {
      // 无精确匹配——限定名查找不得回退到模糊文件命中（#173）；
      // 裸名称可使用单个最高模糊结果。
      return isQualified ? [] : results[0] ? [results[0].node] : [];
    }

    // 降权生成文件（.pb.go、.pulsar.go、_grpc.pb.go……），使流程查询
    // 优先选择手写实现而非 protobuf 生成的桩文件。
    return [...exactMatches]
      .sort((a, b) => (isGeneratedFile(a.node.filePath) ? 1 : 0) - (isGeneratedFile(b.node.filePath) ? 1 : 0))
      .map((r) => r.node);
  }

  /**
   * 查找与名称匹配的所有符号。用于 callers/callees/impact，
   * 在所有匹配符号上聚合结果（例如多个类中都有 `execute` 方法）。
   */
  private findAllSymbols(cg: Synapse, symbol: string): { nodes: Node[]; note: string } {
    let results = cg.searchNodes(symbol, { limit: 50 });

    // 镜像 `findSymbol` 中限定名查询的回退——FTS 剥离冒号，
    // 因此模块限定的查找需要按裸尾部进行第二次搜索。
    if (results.length === 0 && /[.\/]|::/.test(symbol)) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
    }

    if (results.length === 0) {
      return { nodes: [], note: '' };
    }

    const exactMatches = results.filter(r => this.matchesSymbol(r.node, symbol));

    if (exactMatches.length <= 1) {
      const node = exactMatches[0]?.node ?? results[0]!.node;
      return { nodes: [node], note: '' };
    }

    // 与 findSymbol 相同的生成文件降权——保持 callers/callees/impact
    // 聚合一致（对 "Send" 的查询在 protobuf 脚手架之前返回手写实现）。
    const ranked = [...exactMatches].sort((a, b) => {
      const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
      const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
      return aGen - bGen;
    });

    const locations = ranked.map(r =>
      `${r.node.kind} at ${r.node.filePath}:${r.node.startLine}`
    );
    const note = `\n\n> **Note:** Aggregated results across ${ranked.length} symbols named "${symbol}": ${locations.join(', ')}`;
    return { nodes: ranked.map(r => r.node), note };
  }

  /**
   * 若输出超过最大长度则截断
   */
  private truncateOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_LENGTH) return text;
    const truncated = text.slice(0, MAX_OUTPUT_LENGTH);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastNewline > MAX_OUTPUT_LENGTH * 0.8 ? lastNewline : MAX_OUTPUT_LENGTH;
    return truncated.slice(0, cutPoint) + '\n\n... (output truncated)';
  }

  // =========================================================================
  // 格式化辅助方法（默认紧凑，以减少上下文使用量）
  // =========================================================================

  private formatSearchResults(results: SearchResult[]): string {
    const lines: string[] = [`## Search Results (${results.length} found)`, ''];

    for (const result of results) {
      const { node } = result;
      const location = node.startLine ? `:${node.startLine}` : '';
      // 紧凑格式：每个结果一行，包含关键信息
      lines.push(`### ${node.name} (${node.kind})`);
      lines.push(`${node.filePath}${location}`);
      if (node.signature) lines.push(`\`${node.signature}\``);
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatNodeList(nodes: Node[], title: string, labels?: Map<string, string>): string {
    const lines: string[] = [`## ${title} (${nodes.length} found)`, ''];

    for (const node of nodes) {
      const location = node.startLine ? `:${node.startLine}` : '';
      // 紧凑：仅名称、类型、位置——加上非普通调用时的关系说明
      //（回调注册、实例化……）。
      const label = labels?.get(node.id);
      lines.push(
        `- ${node.name} (${node.kind}) - ${node.filePath}${location}${label ? ` — via ${label}` : ''}`
      );
    }

    return lines.join('\n');
  }

  /**
   * callers/callees 列表中非 `calls` 边的关系标签。函数即值边（#756）
   * 是高信号的那种：`callers(cb)` 显示"via callback registration"
   * 告知智能体这是回调被连线的地方，而非被调用的地方。
   */
  private edgeLabel(edge: Edge): string | null {
    if (edge.kind === 'calls') return null;
    if (edge.metadata?.fnRef === true) return 'callback registration';
    if (edge.kind === 'instantiates') return 'instantiation';
    if (edge.kind === 'imports') return 'import';
    if (edge.kind === 'references') return 'reference';
    return edge.kind;
  }

  private formatImpact(symbol: string, impact: Subgraph): string {
    const nodeCount = impact.nodes.size;

    // 紧凑格式：仅列出按文件分组的受影响符号
    const lines: string[] = [
      `## Impact: "${symbol}" affects ${nodeCount} symbols`,
      '',
    ];

    // 按文件分组
    const byFile = new Map<string, Node[]>();
    for (const node of impact.nodes.values()) {
      const existing = byFile.get(node.filePath) || [];
      existing.push(node);
      byFile.set(node.filePath, existing);
    }

    for (const [file, nodes] of byFile) {
      lines.push(`**${file}:**`);
      // 紧凑：内联列表
      const nodeList = nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
      lines.push(nodeList);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 从已索引的子节点（方法、字段、属性……）构建容器符号的紧凑结构概要——
   * 包含名称、类型、行号和签名——使智能体能了解类的结构，
   * 而无需获取每个方法的完整源码。当容器没有已索引的子节点时返回 ''，
   * 使调用方可以回退到完整源码。
   */
  private buildContainerOutline(cg: Synapse, node: Node): string {
    const children = cg.getChildren(node.id)
      .filter(c => c.kind !== 'import' && c.kind !== 'export')
      .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
    if (children.length === 0) return '';

    const lines = [`**Members (${children.length}):**`, ''];
    for (const c of children) {
      const loc = c.startLine ? `:${c.startLine}` : '';
      const sig = c.signature ? ` — \`${c.signature}\`` : '';
      lines.push(`- ${c.name} (${c.kind})${loc}${sig}`);
    }
    return lines.join('\n');
  }

  private formatNodeDetails(node: Node, code: string | null, outline?: string | null): string {
    const location = node.startLine ? `:${node.startLine}` : '';
    const lines: string[] = [
      `## ${node.name} (${node.kind})`,
      '',
      `**Location:** ${node.filePath}${location}`,
    ];

    if (node.signature) {
      lines.push(`**Signature:** \`${node.signature}\``);
    }

    // 仅在文档字符串较短且有用时才包含
    if (node.docstring && node.docstring.length < 200) {
      lines.push('', node.docstring);
    }

    if (outline) {
      lines.push('', outline, '',
        `> Structural outline only. Read \`${node.filePath}\` or call synapse_node on a specific member for its body.`);
    } else if (code) {
      // 行号标注（cat -n 风格，与 synapse_explore 和 Read 一致），
      // 使智能体无需重新读取文件即可引用/编辑精确行。
      const numbered = node.startLine ? numberSourceLines(code, node.startLine) : code;
      lines.push('', '```' + node.language, numbered, '```');
    }

    return lines.join('\n');
  }

  private textResult(text: string): ToolResult {
    return {
      content: [{ type: 'text', text }],
    };
  }

  private errorResult(message: string): ToolResult {
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}
