/**
 * 引用解析类型
 *
 * 引用解析系统所使用的类型定义。
 */

import { Language, Node, ReferenceKind } from '../types';

/**
 * 提取阶段产生的未解析引用
 */
export interface UnresolvedRef {
  /** 包含该引用的源节点 ID */
  fromNodeId: string;
  /** 被引用的名称 */
  referenceName: string;
  /** 引用类型 */
  referenceKind: ReferenceKind;
  /** 引用所在行号 */
  line: number;
  /** 引用所在列号 */
  column: number;
  /** 引用所在文件路径 */
  filePath: string;
  /** 源文件语言 */
  language: Language;
  /** 可能解析到的限定名候选列表 */
  candidates?: string[];
}

/**
 * 已解析的引用
 */
export interface ResolvedRef {
  /** 原始未解析引用 */
  original: UnresolvedRef;
  /** 目标节点 ID */
  targetNodeId: string;
  /** 置信度（0-1） */
  confidence: number;
  /** 解析方式 */
  resolvedBy: 'exact-match' | 'import' | 'qualified-name' | 'framework' | 'fuzzy' | 'instance-method' | 'file-path' | 'function-ref';
}

/**
 * 解析尝试的结果
 */
export interface ResolutionResult {
  /** 成功解析的引用 */
  resolved: ResolvedRef[];
  /** 未能解析的引用 */
  unresolved: UnresolvedRef[];
  /** 统计信息 */
  stats: {
    total: number;
    resolved: number;
    unresolved: number;
    byMethod: Record<string, number>;
  };
}

/**
 * 解析上下文——提供对图的访问
 */
export interface ResolutionContext {
  /** 获取文件中的所有节点 */
  getNodesInFile(filePath: string): Node[];
  /** 按名称获取所有节点 */
  getNodesByName(name: string): Node[];
  /** 按限定名获取所有节点 */
  getNodesByQualifiedName(qualifiedName: string): Node[];
  /** 按类型获取所有节点 */
  getNodesByKind(kind: Node['kind']): Node[];
  /** 检查文件是否存在 */
  fileExists(filePath: string): boolean;
  /** 读取文件内容 */
  readFile(filePath: string): string | null;
  /** 获取项目根目录 */
  getProjectRoot(): string;
  /** 获取所有文件 */
  getAllFiles(): string[];
  /** 按小写名称获取节点（O(1) 查找，用于模糊匹配） */
  getNodesByLowerName(lowerName: string): Node[];
  /**
   * 指定类型名称的直接父类型（同语言）：该类型继承的类以及
   * 它实现/遵循的接口/协议/trait 的简单名称。
   * 由已解析的 `implements`/`extends` 边支撑，因此在第一次解析过程中
   * 为空（边尚未建立），之后才有内容——一致性检查过程使用此方法来解析
   * 定义在接收方类型所遵循的父类型上的链式方法
   * （例如协议扩展方法）。声明为可选，以便外部/测试上下文无需实现即可编译。
   */
  getSupertypes?(typeName: string, language: Language): string[];
  /**
   * 按 id 查找节点。让匹配器能够推导出 FROM 符号所在的
   * 封闭类作用域（Swift 隐式 self 方法作用域、`this.X` 成员解析）。
   * 声明为可选，以便外部/测试上下文无需实现即可编译。
   */
  getNodeById?(id: string): Node | null;
  /** 获取文件的已缓存导入映射 */
  getImportMappings(filePath: string, language: Language): ImportMapping[];
  /**
   * 项目导入路径别名（tsconfig/jsconfig `paths`）。当项目未定义任何别名时
   * 返回 `null`。在解析器实例级别缓存——可在任意解析器代码路径中安全调用。
   * 声明为可选，以便现有测试夹具和外部上下文实现无需修改即可编译；
   * 生产环境解析器实现了此方法。
   */
  getProjectAliases?(): import('./path-aliases').AliasMap | null;
  /**
   * 项目根目录下 `go.mod` 中的 Go 模块信息。当项目没有 `go.mod`
   * 时返回 `null`（非 Go 项目、pre-modules Go 代码，或模块位于子目录的项目）。
   * 供导入解析的 Go 分支使用，以区分模块内跨包导入与第三方包。
   */
  getGoModule?(): import('./go-module').GoModule | null;
  /**
   * Monorepo 工作区成员包，以声明的包名为键。
   * 对于单包仓库（无 `workspaces` 字段）返回 `null`。
   * 让解析器将 `@scope/ui/sub` 视为本地导入到成员目录，
   * 而非外部 npm 包（#629）。
   */
  getWorkspacePackages?(): import('./workspace-packages').WorkspacePackages | null;
  /**
   * 文件声明的重导出（`export { x } from './other'`、
   * `export * from './other'`）。当文件没有重导出时返回空数组。
   * 声明为可选，以便旧版调用方可以编译；当提供此方法时，
   * 导入解析器会跟踪重导出链。
   */
  getReExports?(filePath: string, language: Language): ReExport[];
  /**
   * 列出 `relativePath`（相对于项目根目录）的直接子目录。
   * 当路径不存在或不是目录时返回空数组。
   * 供需要遍历构建系统元数据的框架解析器使用
   * （例如 Cargo 工作区 glob）。声明为可选，以便外部上下文实现
   * 和测试夹具无需修改即可编译。
   */
  listDirectories?(relativePath: string): string[];
  /**
   * C/C++ 头文件搜索目录（相对于项目根目录），
   * 从 compile_commands.json 提取或通过启发式方法发现。
   * 供 resolveCppIncludePath 在相对路径解析失败时搜索 -I 目录。
   * 声明为可选，以便现有调用方可以编译。
   */
  getCppIncludeDirs?(): string[];
}

/**
 * 框架特定文件提取的结果。
 */
export interface FrameworkExtractionResult {
  /** 框架特定节点（例如路由） */
  nodes: Node[];
  /** 框架特定的未解析引用（例如路由 → 处理器） */
  references: UnresolvedRef[];
}

/**
 * 框架特定解析器
 */
export interface FrameworkResolver {
  /** 框架名称 */
  name: string;
  /** 该框架适用的语言。若省略，则适用于所有语言。 */
  languages?: Language[];
  /** 检测项目是否使用此框架（项目级别，启动时调用一次） */
  detect(context: ResolutionContext): boolean;
  /** 使用框架特定模式解析引用 */
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null;
  /**
   * 让指定引用名称绕过解析器的"名称存在"预过滤，即使没有节点以该名称命名。
   * 用于动态分发场景——调用目标是属性/描述符而非声明的符号
   * （例如 Django 的 `self._iterable_class(...)`、React effect 回调）。
   * 返回 true 可让该引用进入 `resolve()`，而不因名称无匹配而被丢弃。
   */
  claimsReference?(name: string): boolean;
  /**
   * 从文件中提取框架特定的节点和引用。
   *
   * 返回路由节点、中间件节点等，以及将这些节点链接到处理器
   * （视图类、控制器方法、包含的模块）的未解析引用。
   * 未解析引用会流入正常解析流水线；框架自身的 `resolve()` 是其中一种策略。
   */
  extract?(filePath: string, content: string): FrameworkExtractionResult;
  /**
   * 跨文件最终处理过程，在所有逐文件提取完成后调用一次
   * （每次增量同步时也会再次调用）。用于符号的最终表示依赖于
   * 逐文件 `extract()` 未见过的兄弟文件的框架——例如 NestJS 的
   * `RouterModule.register([...])` 为在其他地方声明的控制器设置路由前缀。
   *
   * 实现返回字段已变更的路由等节点（通常是 `name`）；
   * 协调器通过 `updateNode` 持久化每个节点。节点 `id` 必须保留，
   * 以确保现有边（路由 → 处理器等）保持完整；
   * `qualifiedName` 应当保留，以使该过程保持幂等——
   * 第二次运行可从 `qualifiedName` 恢复原始的逐文件形式。
   */
  postExtract?(context: ResolutionContext): Node[];
}

/**
 * 文件的导入映射
 */
export interface ImportMapping {
  /** 文件中使用的本地名称 */
  localName: string;
  /** 原始导出名称（可能因别名而不同） */
  exportedName: string;
  /** 来源模块/路径 */
  source: string;
  /** 是否为默认导入 */
  isDefault: boolean;
  /** 是否为命名空间导入（import * as X） */
  isNamespace: boolean;
  /** 已解析的文件路径（若为本地导入） */
  resolvedPath?: string;
}

/**
 * 文件的重导出：`export { x } from './other'` 或
 * `export * from './other'`。供解析器追踪
 * 符号穿越桶文件（barrel file）的路径。
 */
export type ReExport =
  | {
      kind: 'named';
      /** 本文件导出时使用的名称。 */
      exportedName: string;
      /** 上游模块中的名称（重命名时与上者不同：`as`）。 */
      originalName: string;
      /** 上游模块的模块说明符。 */
      source: string;
    }
  | {
      kind: 'wildcard';
      /** 上游模块的模块说明符。 */
      source: string;
    };
