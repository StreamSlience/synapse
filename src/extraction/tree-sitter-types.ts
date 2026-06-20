/**
 * Tree-sitter 提取类型
 *
 * 定义核心 TreeSitterExtractor 和各语言提取配置所使用的
 * LanguageExtractor 接口及相关类型。
 * 提取为独立叶模块，避免循环导入。
 */

import { Node as SyntaxNode } from 'web-tree-sitter';
import {
  Node,
  NodeKind,
  UnresolvedReference,
} from '../types';

/**
 * 语言的 extractImport 钩子返回的信息。
 */
export interface ImportInfo {
  /** 被导入的模块/包名称 */
  moduleName: string;
  /** 用于显示的完整导入语句文本 */
  signature: string;
  /** 若为 true，则钩子已自行创建未解析引用 */
  handledRefs?: boolean;
}

/**
 * 声明中单个变量的信息。
 * 由语言的 extractVariables 钩子返回。
 */
export interface VariableInfo {
  /** 变量名 */
  name: string;
  /** 节点类型：'variable' 或 'constant' */
  kind: NodeKind;
  /** 可选的签名字符串 */
  signature?: string;
  /** 若设置，则此声明符实际上是函数，应按函数方式提取 */
  delegateToFunction?: SyntaxNode;
  /** 用于定位的 AST 节点（可能与声明节点不同） */
  positionNode?: SyntaxNode;
}

/**
 * 传递给需要回调核心提取器的语言钩子的上下文对象。
 * 提供受控的 API 接口——钩子可以创建节点、访问子节点并添加引用，
 * 而无需访问完整的 TreeSitterExtractor 内部状态。
 */
export interface ExtractorContext {
  /** 创建节点并将其添加到提取结果中 */
  createNode(kind: NodeKind, name: string, node: SyntaxNode, extra?: Partial<Node>): Node | null;
  /** 访问子节点（通过标准 visitNode 逻辑分发） */
  visitNode(node: SyntaxNode): void;
  /** 访问函数体以提取调用关系 */
  visitFunctionBody(body: SyntaxNode, functionId: string): void;
  /** 添加未解析引用 */
  addUnresolvedReference(ref: UnresolvedReference): void;
  /** 将节点 ID 压入作用域栈（用于构建包含关系/限定名） */
  pushScope(nodeId: string): void;
  /** 从作用域栈弹出最后一个节点 ID */
  popScope(): void;
  /** 当前文件路径 */
  readonly filePath: string;
  /** 当前源码文本 */
  readonly source: string;
  /** 父节点 ID 栈（当前作用域） */
  readonly nodeStack: readonly string[];
  /** 目前已提取的所有节点 */
  readonly nodes: readonly Node[];
}

/**
 * 语言专属提取配置。
 *
 * 每种受支持的语言提供此接口的实现，配置要查找的 AST 节点类型
 * 以及如何提取语言专属细节（如签名、可见性和导入）。
 */
export interface LanguageExtractor {
  /**
   * 在 grammar 解析文件前立即应用的可选源码变换。用于规避 grammar 缺陷
   * 导致的解析树损坏（例如 C# 将 enum 体内 grammar 误解析的条件编译
   * 指令行置空）。必须保留字节偏移（用空格替换删除的文本，保留换行），
   * 使节点位置和 getNodeText 保持正确；返回的字符串同时用于解析和提取。
   */
  preParse?: (source: string) => string;

  // --- 节点类型映射 ---

  /** 表示函数的节点类型 */
  functionTypes: string[];
  /** 表示类的节点类型 */
  classTypes: string[];
  /** 表示方法的节点类型 */
  methodTypes: string[];
  /** 表示接口/协议/trait 的节点类型 */
  interfaceTypes: string[];
  /** 表示结构体的节点类型 */
  structTypes: string[];
  /** 表示枚举的节点类型 */
  enumTypes: string[];
  /** 表示枚举成员/case 的节点类型（例如 Swift: 'enum_entry'，Rust: 'enum_variant'） */
  enumMemberTypes?: string[];
  /** 表示类型别名的节点类型（例如 `type X = ...`） */
  typeAliasTypes: string[];
  /** 表示导入的节点类型 */
  importTypes: string[];
  /** 表示函数调用的节点类型 */
  callTypes: string[];
  /** 表示变量声明的节点类型（const、let、var 等） */
  variableTypes: string[];
  /** 表示类字段的节点类型（在类体内提取为 'field' 类型） */
  fieldTypes?: string[];
  /** 表示类属性的节点类型（在类体内提取为 'property' 类型） */
  propertyTypes?: string[];

  // --- 字段名映射 ---

  /** 标识符/名称的字段名 */
  nameField: string;
  /** 函数体的字段名 */
  bodyField: string;
  /** 参数的字段名 */
  paramsField: string;
  /** 返回类型的字段名 */
  returnField?: string;

  // --- 现有钩子 ---

  /** 覆盖符号名称提取（例如 ObjC 多段选择器）。 */
  resolveName?: (node: SyntaxNode, source: string) => string | undefined;

  /** 在通用名称遍历失败时提取属性名（例如 ObjC @property）。 */
  extractPropertyName?: (node: SyntaxNode, source: string) => string | null;

  /** 从节点中提取签名 */
  getSignature?: (node: SyntaxNode, source: string) => string | undefined;
  /** 从节点中提取可见性 */
  getVisibility?: (node: SyntaxNode) => 'public' | 'private' | 'protected' | 'internal' | undefined;
  /** 检查节点是否已导出 */
  isExported?: (node: SyntaxNode, source: string) => boolean;
  /** 检查节点是否为异步 */
  isAsync?: (node: SyntaxNode) => boolean;
  /** 检查节点是否为静态 */
  isStatic?: (node: SyntaxNode) => boolean;
  /** 检查变量声明是否为常量（const vs let/var） */
  isConst?: (node: SyntaxNode) => boolean;
  /**
   * 提取需要持久化到节点 `decorators` 列表中的额外符号级修饰符关键字
   * （例如 Kotlin 的 `expect`/`actual` 多平台标记）。
   * 对每个创建的节点都会泛化调用；无修饰符时返回 undefined/[]。
   * 解析器使用此信息将 `expect` 声明跨源码集链接到对应的 `actual` 实现。
   */
  extractModifiers?: (node: SyntaxNode) => string[] | undefined;

  // --- 新增配置属性 ---

  /** 视为类声明的额外节点类型（例如 Dart: 'mixin_declaration'） */
  extraClassNodeTypes?: string[];
  /** 方法是否可以不在类内而出现在顶层（Go: true） */
  methodsAreTopLevel?: boolean;
  /** 接口类声明使用的 NodeKind（Rust: 'trait'）。默认：'interface' */
  interfaceKind?: NodeKind;

  // --- 新增钩子 ---

  /**
   * 自定义节点访问器。若节点已被完整处理则返回 true（跳过默认分发）。
   * 用于 AST 结构根本不同的语言（例如 Pascal）。
   */
  visitNode?: (node: SyntaxNode, ctx: ExtractorContext) => boolean;

  /**
   * 当 grammar 将一种节点类型复用于多种概念时，对 class_declaration 节点进行分类
   * （例如 Swift 的 class_declaration 同时用于类、结构体和枚举）。
   */
  classifyClassNode?: (node: SyntaxNode) => 'class' | 'struct' | 'enum' | 'interface' | 'trait';

  /**
   * 当 grammar 将一种节点类型复用于可调用成员和数据成员时，对 methodTypes 节点分类
   * (#808)：TS/JS 类字段（`public_field_definition` / `field_definition`）
   * 仅在其值可调用时（`onClick = () => {}`）才是方法；
   * 普通字段（`public fonts: Fonts;`、`count = 0`）是属性。默认：'method'。
   */
  classifyMethodNode?: (node: SyntaxNode) => 'method' | 'property';

  /**
   * 当函数/方法/类的 body 节点不是子字段时，解析该 body 节点。
   * （例如 Dart 将 function_body 作为兄弟节点而非子节点。）
   */
  resolveBody?: (node: SyntaxNode, bodyField: string) => SyntaxNode | null;

  /**
   * 从导入节点中提取导入信息。
   * 若节点不是已识别的导入形式则返回 null。
   */
  extractImport?: (node: SyntaxNode, source: string) => ImportInfo | null;

  /**
   * 从变量声明节点中提取变量声明信息。
   * 返回每个声明变量的信息，供核心创建节点使用。
   */
  extractVariables?: (node: SyntaxNode, source: string) => VariableInfo[];

  /**
   * 从方法声明中提取接收者/所有者类型名。
   * 供 Go 使用，获取结构体接收者（例如从 "func (sl *scrapeLoop) run()" 获取 "scrapeLoop"）。
   * 存在时，接收者类型会包含在限定名中，提高可搜索性。
   */
  getReceiverType?: (node: SyntaxNode, source: string) => string | undefined;

  /**
   * 提取函数/方法的规范化返回类型名（裸类名，智能指针指向类型已解包），
   * 存储在节点的 `returnType` 上。供 C/C++ 使用，让解析器能从内层调用的
   * 返回值推断链式接收者的类型（`Foo::instance().bar()` → 在 `Foo` 上解析
   * `bar`，issue #645）。原始类型 / void / 构造函数返回 undefined。
   */
  getReturnType?: (node: SyntaxNode, source: string) => string | undefined;

  /**
   * 解析类型别名声明的实际节点类型。
   * 供 Go 使用，其中 `type_spec` 是结构体/接口的命名声明包装器：
   *   `type Foo struct { ... }` → type_spec (name: "Foo") → struct_type
   * 返回 'struct'、'interface' 等以覆盖默认的 'type_alias' 类型，
   * 或返回 undefined 保持为类型别名。
   */
  resolveTypeAliasKind?: (node: SyntaxNode, source: string) => NodeKind | undefined;

  /**
   * 检查函数/方法名是否为应被跳过的误解析产物。
   * 供 C/C++ 使用，其中宏（例如 NLOHMANN_JSON_NAMESPACE_BEGIN）会导致 tree-sitter
   * 将命名空间块误解析为 function_definitions。返回 true 时不创建函数节点，
   * 但仍会访问函数体以提取调用关系和结构节点（类、结构体、枚举）。
   */
  isMisparsedFunction?: (name: string, node: SyntaxNode) => boolean;

  /**
   * 检测不使用调用表达式语法的裸方法调用。
   * 供 Ruby 使用，其中 `reset`（无括号、无接收者）是方法调用，但
   * tree-sitter 将其解析为普通的 `identifier` 节点而非 `call`/`method_call`。
   * 若此节点是裸调用则返回被调用者名称，否则返回 undefined。
   */
  extractBareCall?: (node: SyntaxNode, source: string) => string | undefined;

  /**
   * 表示文件级包/命名空间声明的节点类型
   * （例如 Kotlin `package_header`，Java `package_declaration`）。设置后，
   * 核心会将每个顶层声明包裹在一个携带 FQN 的隐式 `namespace` 节点中，
   * 使跨文件导入解析能通过 qualifiedName 而非文件名进行匹配
   * （Kotlin 文件名 ≠ 类名）。
   */
  packageTypes?: string[];

  /** 从包声明节点中提取点分隔的包名。 */
  extractPackage?: (node: SyntaxNode, source: string) => string | null;
}
