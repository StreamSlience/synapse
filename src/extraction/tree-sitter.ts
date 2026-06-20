/**
 * Tree-sitter 解析器封装
 *
 * 负责解析源代码并提取结构化信息。
 */

import { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import * as path from 'path';
import {
  Language,
  Node,
  Edge,
  NodeKind,
  ExtractionResult,
  ExtractionError,
  UnresolvedReference,
} from '../types';
import { getParser, detectLanguage, isLanguageSupported, isFileLevelOnlyLanguage } from './grammars';
import { generateNodeId, getNodeText, getChildByField, getPrecedingDocstring } from './tree-sitter-helpers';
import { FN_REF_SPECS, captureFnRefCandidates, type FnRefSpec, type FnRefCandidate } from './function-ref';
import { isGeneratedFile } from './generated-detection';
import type { LanguageExtractor, ExtractorContext } from './tree-sitter-types';
import { EXTRACTORS } from './languages';
import { LiquidExtractor } from './liquid-extractor';
import { RazorExtractor } from './razor-extractor';
import { SvelteExtractor } from './svelte-extractor';
import { AstroExtractor } from './astro-extractor';
import { DfmExtractor } from './dfm-extractor';
import { VueExtractor } from './vue-extractor';
import { MyBatisExtractor } from './mybatis-extractor';
import {
  getAllFrameworkResolvers,
  getApplicableFrameworks,
} from '../resolution/frameworks';

// 向后兼容重导出
export { generateNodeId } from './tree-sitter-helpers';

/**
 * 根据语言从节点中提取名称
 */
function extractName(node: SyntaxNode, source: string, extractor: LanguageExtractor): string {
  const hookName = extractor.resolveName?.(node, source);
  if (hookName) return hookName;

  // 优先按字段名查找
  const nameNode = getChildByField(node, extractor.nameField);
  if (nameNode) {
    // 展开 C/C++ 指针返回类型的 pointer_declarator
    let resolved = nameNode;
    while (resolved.type === 'pointer_declarator') {
      const inner = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      if (!inner) break;
      resolved = inner;
    }
    // 处理 C/C++ 复杂声明符
    if (resolved.type === 'function_declarator' || resolved.type === 'declarator') {
      const innerName = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      return innerName ? getNodeText(innerName, source) : getNodeText(resolved, source);
    }
    // Lua：`function t.f()` / `function t:m()` — 名称节点是点/方法索引表达式；
    // 简单名称是末尾的字段/方法（表接收器通过 getReceiverType 单独捕获）。
    if (resolved.type === 'dot_index_expression') {
      const field = getChildByField(resolved, 'field');
      if (field) return getNodeText(field, source);
    }
    if (resolved.type === 'method_index_expression') {
      const method = getChildByField(resolved, 'method');
      if (method) return getNodeText(method, source);
    }
    return getNodeText(resolved, source);
  }

  // Dart 的 method_signature：向内部 signature 类型中查找
  if (node.type === 'method_signature') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (
        child.type === 'function_signature' ||
        child.type === 'getter_signature' ||
        child.type === 'setter_signature' ||
        child.type === 'constructor_signature' ||
        child.type === 'factory_constructor_signature'
      )) {
        // 在内部 signature 中查找 identifier
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j);
          if (inner?.type === 'identifier') {
            return getNodeText(inner, source);
          }
        }
      }
    }
  }

  // 箭头函数和函数表达式的名称来自父级 variable_declarator，而非其函数体中的标识符。
  // 若不加此判断，`const fn = () => someIdentifier` 这样的单表达式箭头函数
  // 会被命名为 "someIdentifier" 而非 "fn"，因为下面的回退会找到函数体中的标识符。
  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    return '<anonymous>';
  }

  // 回退：查找第一个 identifier 子节点
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child &&
      (child.type === 'identifier' ||
        child.type === 'type_identifier' ||
        child.type === 'simple_identifier' ||
        child.type === 'constant')
    ) {
      return getNodeText(child, source);
    }
  }

  return '<anonymous>';
}

/**
 * 将 Scala 类型节点解析为用于名称匹配的基础类型名——
 * 展开 `generic_type`（`Monoid[Int]` → `Monoid`），取限定
 * `stable_type_identifier` 的最后一段（`cats.Functor` → `Functor`），
 * 并回退到后代 `type_identifier`。非类型节点返回 null。
 * 供 Scala 继承提取和类型引用提取共用。
 */
function scalaBaseTypeName(node: SyntaxNode | null, source: string): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'type_identifier':
    case 'identifier':
      return getNodeText(node, source);
    case 'generic_type':
      // `<base> type_arguments` — the base type is the first named child.
      return scalaBaseTypeName(node.namedChild(0), source);
    case 'stable_type_identifier':
    case 'stable_identifier': {
      // 限定名 `a.b.C` ——按简单（尾部）段匹配。
      const ids = node.namedChildren.filter(
        (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier'
      );
      const last = ids[ids.length - 1];
      return last ? getNodeText(last, source) : null;
    }
    default: {
      const id = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      return id ? getNodeText(id, source) : null;
    }
  }
}

/**
 * 解析 C 声明符中声明的标识符。`declaration` 的 `declarator` 字段
 * 通过 `init_declarator`（含值）、`pointer_declarator`/`array_declarator`/
 * `parenthesized_declarator` 包装层（各自通过 `declarator` 字段）逐层嵌套，
 * 最终到达 `identifier`。`function_declarator` 表示该声明是函数原型
 * （或函数指针变量）——返回 null，不将其提取为变量。
 */
function cDeclaratorIdentifier(node: SyntaxNode | null): SyntaxNode | null {
  let cur: SyntaxNode | null = node;
  let guard = 0;
  while (cur && guard++ < 12) {
    switch (cur.type) {
      case 'identifier':
        return cur;
      case 'function_declarator':
        return null;
      case 'init_declarator':
      case 'pointer_declarator':
      case 'array_declarator':
      case 'parenthesized_declarator':
        cur = getChildByField(cur, 'declarator');
        break;
      default:
        return null;
    }
  }
  return null;
}

/** 在 `node` 子树中（类广度优先，先找先返）查找第一个 `simple_identifier`。
 * Swift 属性名嵌套路径为 `property_declaration → <name> pattern →
 * bound_identifier → simple_identifier`，此函数可解析它（以及用于
 * 影子剪枝的 Kotlin/Swift 属性声明符绑定名）。
 * 对于元组模式（`let (a, b)`）返回第一个——可接受，常量中这类情况很少见。 */
function firstSimpleIdentifier(node: SyntaxNode | null): SyntaxNode | null {
  const stack: SyntaxNode[] = node ? [node] : [];
  let guard = 0;
  while (stack.length > 0 && guard++ < 40) {
    const n = stack.shift()!;
    if (n.type === 'simple_identifier') return n;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return null;
}

/** Swift 属性信息：绑定名称、是否为 `let`，以及是否为*计算型*属性
 *（getter 块，无存储值——永远不会是常量）。 */
function swiftPropertyInfo(
  node: SyntaxNode,
  source: string,
): { nameNode: SyntaxNode | null; isLet: boolean; isComputed: boolean } {
  const pattern =
    getChildByField(node, 'name') ??
    node.namedChildren.find((c) => c.type === 'value_binding_pattern' || c.type === 'pattern') ??
    null;
  const binding = node.namedChildren.find((c) => c.type === 'value_binding_pattern');
  const isLet = binding != null && getNodeText(binding, source).trimStart().startsWith('let');
  const isComputed = node.namedChildren.some(
    (c) => c.type === 'computed_property' || c.type === 'protocol_property_requirements',
  );
  return { nameNode: firstSimpleIdentifier(pattern), isLet, isComputed };
}

/** 当 `node` 位于 C 函数体内部（可传递）时返回 true——即为局部声明，
 * 而非文件/命名空间作用域声明。沿父链向上遍历至根节点。 */
function hasFunctionAncestor(node: SyntaxNode): boolean {
  let p = node.parent;
  while (p) {
    if (p.type === 'function_definition') return true;
    p = p.parent;
  }
  return false;
}

/**
 * PHP 类型位置的包装节点类型（类型提示为 `named_type`，
 * `?Foo` 为 `optional_type`，`A|B` 为 `union_type`，`A&B` 为
 * `intersection_type`）。用于在遍历参数/属性/返回位置的类引用前，
 * 定位其中的类型子树。
 */
const PHP_TYPE_NODES: ReadonlySet<string> = new Set([
  'named_type', 'optional_type', 'nullable_type',
  'union_type', 'intersection_type', 'disjunctive_normal_form_type',
  'primitive_type',
]);

/**
 * 成员访问节点类型——当接收器为首字母大写的类型/枚举/类名时，
 * 表示真实的依赖关系，如 `Enum.value`、`Type.CONST`、`Foo::BAR`。
 * 这类值读取（区别于已处理的 `Type.method()` 调用）未产生任何边，
 * 导致仅通过静态成员或枚举值使用的类型看起来没有任何依赖方。
 * 参见 {@link extractStaticMemberRef}。
 */
const MEMBER_ACCESS_TYPES: ReadonlySet<string> = new Set([
  'field_access',                       // java (`Foo.BAR`)
  'member_access_expression',           // c#  (`Foo.Bar`)
  'navigation_expression',              // kotlin / swift (`Foo.bar`)
  'field_expression',                   // scala (`Foo.bar`)
  'class_constant_access_expression',   // php (`Foo::CONST`, `Foo::class`)
  'scoped_property_access_expression',  // php (`Foo::$bar`)
  'qualified_identifier',               // c++ (`Foo::bar`)
]);

/**
 * 按惯例类型名称首字母大写的语言——在这些语言中，首字母大写的成员访问接收器
 * 可靠地表示一个类型（而非局部变量）。静态成员/值读取处理阶段仅限于这些语言——
 * 它们是经确认的残余前沿（枚举值/静态字段读取）。TS/JS/Python 有意排除在外，
 * 经过实测 A/B 确认：将该处理扩展到这些语言覆盖率为零——在基于导入的语言中，
 * 任何 `Type.MEMBER` 读取之前必须先 `import` 类型，import 边已覆盖了这一情况
 * （静态读取纯属重复）——同时还会引入真实的图噪声（excalidraw 上 +1813 条边 /
 * +2448 条 `references`，均指向已覆盖的类型）。不要在此处重新添加
 * `member_expression`/`attribute`。
 */
const STATIC_MEMBER_LANGS: ReadonlySet<string> = new Set([
  'java', 'csharp', 'kotlin', 'swift', 'scala', 'dart', 'php', 'cpp',
]);

/**
 * 表示构造函数调用的 tree-sitter 节点类型
 * （`new Foo()` 及类似形式）。供 extractInstantiation 使用，
 * 以发出指向类名的 `instantiates` 引用。
 */
const INSTANTIATION_KINDS: ReadonlySet<string> = new Set([
  'new_expression',                  // typescript / javascript / tsx / jsx
  'object_creation_expression',      // java / c#
  'instance_creation_expression',    // some grammars
  'composite_literal',               // go — `Widget{...}` / `pkga.Widget{...}`
  'struct_expression',               // rust — `Widget { n: 1 }` / `m::Widget { .. }`
  'instance_expression',             // scala — `new Monoid[Int] { ... }`
]);

/**
 * TreeSitterExtractor — 主提取类
 */
export class TreeSitterExtractor {
  private filePath: string;
  private language: Language;
  private source: string;
  private tree: Tree | null = null;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  // 值引用边（默认开启；设置 SYNAPSE_VALUE_REFS=0 可禁用；参见 flushValueRefs）。
  // 文件作用域 const/var 符号的同文件读取 → `references` 边，使影响分析能捕获
  // 值消费者（"修改此常量/表，影响其读取方"）。
  private static readonly VALUE_REF_LANGS = new Set<string>(['typescript', 'javascript', 'tsx', 'go', 'python', 'rust', 'ruby', 'c', 'java', 'csharp', 'php', 'scala', 'kotlin', 'swift', 'dart', 'pascal']);
  private static readonly MAX_VALUE_REF_NODES = 20_000;
  private readonly valueRefsEnabled = process.env.SYNAPSE_VALUE_REFS !== '0';
  private fileScopeValues = new Map<string, string>();
  private fileScopeValueCounts = new Map<string, number>(); // 每个名称的文件作用域节点数（用于条件定义检测）
  private valueRefScopes: Array<{ id: string; node: SyntaxNode; name: string }> = [];
  private errors: ExtractionError[] = [];
  private extractor: LanguageExtractor | null = null;
  private nodeStack: string[] = []; // 父节点 ID 栈
  private methodIndex: Map<string, string> | null = null; // Pascal defProc 查找用的 lookup key → node ID
  // 函数值捕获（#756）：每语言规格 + 遍历期间收集的候选项，
  // 在文件末尾经门控后写入 unresolvedReferences（参见 flushFnRefCandidates）。
  private fnRefSpec: FnRefSpec | undefined;
  private fnRefCandidates: Array<FnRefCandidate & { fromNodeId: string }> = [];

  constructor(filePath: string, source: string, language?: Language) {
    this.filePath = filePath;
    this.source = source;
    this.language = language || detectLanguage(filePath, source);
    this.extractor = EXTRACTORS[this.language] || null;
    this.fnRefSpec = FN_REF_SPECS[this.language];
  }

  /**
   * 解析源代码并提取信息
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    if (!isLanguageSupported(this.language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Unsupported language: ${this.language}`,
            filePath: this.filePath,
            severity: 'error',
            code: 'unsupported_language',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    const parser = getParser(this.language);
    if (!parser) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to get parser for language: ${this.language}`,
            filePath: this.filePath,
            severity: 'error',
            code: 'parser_error',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    try {
      // 可选的解析前源码变换（保留偏移量），用于规避 grammar 缺陷——
      // 例如 C# 会清空条件编译指令行，这些行在 grammar 解析枚举体时会出错（#237）。
      // 重新赋值 this.source，以便下游 getNodeText 读取解析器所见的相同字节
      // （与被清空的指令行之外的内容相同）。
      if (this.extractor?.preParse) {
        this.source = this.extractor.preParse(this.source);
      }
      this.tree = parser.parse(this.source) ?? null;
      if (!this.tree) {
        throw new Error('Parser returned null tree');
      }

      // 创建表示源文件的文件节点
      const fileNode: Node = {
        id: `file:${this.filePath}`,
        kind: 'file',
        name: path.basename(this.filePath),
        qualifiedName: this.filePath,
        filePath: this.filePath,
        language: this.language,
        startLine: 1,
        endLine: this.source.split('\n').length,
        startColumn: 0,
        endColumn: 0,
        isExported: false,
        updatedAt: Date.now(),
      };
      this.nodes.push(fileNode);

      // 将文件节点压栈，以便顶层声明获得 contains 边
      this.nodeStack.push(fileNode.id);

      // 文件级 package 声明（Kotlin/Java）。创建一个隐式 `namespace` 节点
      // 包裹所有顶层声明，使其 qualifiedName 携带全限定名——
      // JVM 语言跨文件 import 解析时必需，因为文件名 ≠ 类名。
      const packageNodeId = this.extractFilePackage(this.tree.rootNode);
      if (packageNodeId) this.nodeStack.push(packageNodeId);

      this.visitNode(this.tree.rootNode);

      // 在文件节点和 import ref 均已完整、文件节点仍在栈上时，
      // 触发并刷新 function-as-value 候选（#756）。
      this.flushFnRefCandidates();
      this.flushValueRefs();

      if (packageNodeId) this.nodeStack.pop();
      this.nodeStack.pop();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // WASM 内存错误会导致模块进入损坏状态——后续所有解析都会失败。
      // 重新抛出，让 worker 检测到并崩溃，以便用干净的堆重启。
      if (msg.includes('memory access out of bounds') || msg.includes('out of memory')) {
        throw error;
      }

      this.errors.push({
        message: `Parse error: ${msg}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    } finally {
      // 立即释放 tree-sitter WASM 内存——语法树持有 V8 GC 不可见的
      // 原生堆内存，处理数千个文件后会不断累积。
      if (this.tree) {
        this.tree.delete();
        this.tree = null;
      }
      // 释放源码字符串以减轻 GC 压力
      this.source = '';
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Function-as-value 捕获（#756）：若当前节点是该语言的值位置容器
   * （调用参数、赋值右值、结构体/对象初始化器、数组/表字面量），
   * 则从中收集候选函数名。候选在文件末尾通过 flushFnRefCandidates 触发并刷新。
   */
  private maybeCaptureFnRefs(node: SyntaxNode, nodeType: string): void {
    const spec = this.fnRefSpec;
    if (!spec) return;
    const rule = spec.dispatch.get(nodeType);
    if (!rule || this.nodeStack.length === 0) return;
    const fromNodeId = this.nodeStack[this.nodeStack.length - 1];
    if (!fromNodeId) return;
    for (const cand of captureFnRefCandidates(node, rule, spec, this.source)) {
      this.fnRefCandidates.push({ ...cand, fromNodeId });
    }
  }

  /**
   * 仅扫描候选的子树（主游走器不会遍历的顶层变量初始化器）。
   * 无提取副作用。遇到嵌套函数定义时停止——其函数体由 extractFunction
   * 自身的 body walk 游走，候选也归属于它。
   */
  private scanFnRefSubtree(node: SyntaxNode, depth: number): void {
    if (!this.fnRefSpec || depth > 12) return;
    const nodeType = node.type;
    if (depth > 0 && (
      this.extractor?.functionTypes.includes(nodeType) ||
      nodeType === 'arrow_function' ||
      nodeType === 'function_expression' ||
      nodeType === 'lambda_literal' ||
      nodeType === 'lambda_expression'
    )) {
      return;
    }
    this.maybeCaptureFnRefs(node, nodeType);
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.scanFnRefSubtree(child, depth + 1);
    }
  }

  /**
   * 触发 function-as-value 候选并将通过门控的候选推送为
   * `function_ref` 未解析引用。
   *
   * 门控限制体积并保护精度：候选仅在其名称匹配本文件中定义的
   * 函数/方法，或本文件 import/reference 的名称时才能通过。
   * 其余所有内容（局部变量、参数、作为参数传入的字段）在进入数据库之前丢弃。
   * 解析器随后将通过门控的候选与 function/method 节点匹配（matchFunctionRef），
   * 并发出 `references` 边——callers/impact 已对其进行遍历。
   *
   * 已知的 v1 限制，故意为之：在与定义位于不同编译单元的 C/C++ callback
   * （extern，无符号 import 可匹配）不会被捕获。同文件注册——主流 C 模式
   * （静态 callback + 同文件 ops struct）——则会被捕获。
   */
  private flushFnRefCandidates(): void {
    if (this.fnRefCandidates.length === 0) return;
    const candidates = this.fnRefCandidates;
    this.fnRefCandidates = [];

    // 生成/压缩文件（内嵌的 jquery.min.js 等）：其 function-as-value 边是噪声——
    // 单字母压缩符号会在任何地方解析匹配。与 callback 合成器策略相同。
    if (isGeneratedFile(this.filePath)) return;

    const definedHere = new Set<string>();
    for (const n of this.nodes) {
      if (n.kind === 'function' || n.kind === 'method') definedHere.add(n.name);
    }

    // 仅使用 import 绑定名称（所有绑定发射器推送 kind 'imports'）。
    // 故意不使用 'references'：那些携带类型注解和接口成员名，
    // 会让与类型成员同名的局部变量穿过门控（excalidraw A/B 发现）。
    // 点分 import（JVM `import com.example.OtherClass`）也贡献其最后段——
    // Java/Kotlin 代码在 `OtherClass::method` 引用中使用的简单名。
    const SIMPLE_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
    // JVM import 是点分（`com.example.OtherClass`）；PHP `use` import
    // 是反斜杠分（`App\Services\Mailer`）。两者均贡献其最后段——
    // 代码用来引用它们的简单名。
    const QUALIFIED_IMPORT = /^[A-Za-z_$][A-Za-z0-9_$.\\]*[.\\]([A-Za-z_$][A-Za-z0-9_$]*)$/;
    const importedNames = new Set<string>();
    for (const r of this.unresolvedReferences) {
      if (r.referenceKind !== 'imports') continue;
      if (SIMPLE_NAME.test(r.referenceName)) {
        importedNames.add(r.referenceName);
      } else {
        const qualified = r.referenceName.match(QUALIFIED_IMPORT);
        if (qualified) importedNames.add(qualified[1]!);
      }
    }

    const ungated = this.fnRefSpec?.ungatedModes;
    const addressOfOnly = this.fnRefSpec?.addressOfOnly === true;
    const seen = new Set<string>();
    for (const c of candidates) {
      const atFileScope = c.fromNodeId.startsWith('file:');
      // C++（addressOfOnly）：裸标识符仅在文件作用域初始化表内有效。
      // 其他地方——参数、赋值、局部花括号初始化如 `{begin, size}`——
      // 只有显式 `&` 形式有效（fmt A/B 发现：通用名称 `begin`/`out`/`size`
      // 与局部变量和成员冲突）。
      if (
        addressOfOnly &&
        !c.explicitRef &&
        !(atFileScope && (c.mode === 'value' || c.mode === 'list'))
      ) {
        continue;
      }
      // 按候选形状的门控策略：
      //  - `this.<member>`：始终刷新——成员可能继承自另一文件的类
      //    （definedHere 不可见），体积自然受真实 `this.X` 表达式限制，
      //    且解析严格限定在类作用域（自身成员或已验证的超类型通过），
      //    不会有模糊泄漏。
      //  - `Scope::member`（C++ 成员指针、Java/Kotlin 类型限定方法引用、
      //    PHP `'Cls::m'`）：始终刷新——显式引用语法自我筛选，引用类型
      //    往往无需 import（Java/Kotlin 同包、Kotlin companion），
      //    且解析锚定在作用域后缀 + 唯一或丢弃，不同类的同名成员无法匹配。
      //  - C 系文件作用域初始化器完全跳过门控
      //    （常量表达式上下文——见 FnRefSpec.ungatedModes）。
      //  - 其他所有情况：名称 ∈ 同文件 functions/methods ∪ imports。
      if (!c.name.startsWith('this.') && !c.name.includes('::')) {
        const skipGate =
          (ungated?.has(c.mode) === true && atFileScope) ||
          c.skipGate === true; // PHP HOF 位置字符串可调用（见 FnRefCandidate.skipGate）
        if (!skipGate && !definedHere.has(c.name) && !importedNames.has(c.name)) {
          continue;
        }
      }
      const key = `${c.fromNodeId}|${c.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.unresolvedReferences.push({
        fromNodeId: c.fromNodeId,
        referenceName: c.name,
        referenceKind: 'function_ref',
        line: c.line,
        column: c.column,
      });
    }
  }

  /**
   * Record value-reference bookkeeping as nodes are created: file-scope const/var symbols with
   * distinctive names become reference targets; function/method/const/var symbols become reader
   * scopes whose bodies flushValueRefs scans.
   */
  private captureValueRefScope(kind: NodeKind, name: string, id: string, node: SyntaxNode): void {
    // Pascal 仅以 `constant` 为目标：其提取器将函数参数（`Dest: TBufferWriter`）
    // 和类字段（`declField`）在外围作用域中发出为 `variable`，否则会产生噪声目标
    // （跨多个 proc 共享的参数名会折叠为一个文件范围的目标）。
    // Pascal 真正的共享值是 `const`（`constant`），因此限制为此。
    // （单元 `var` 全局变量是少见的代价；参数/字段噪声占主导。）
    const targetKindOk =
      this.language === 'pascal' ? kind === 'constant' : kind === 'constant' || kind === 'variable';
    if (targetKindOk && name.length >= 3 && /[A-Z_]/.test(name)) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      // 文件作用域或类/module/struct/enum 作用域常量为目标。
      // 类/module 作用域对于 Ruby 这类几乎将所有常量置于类或 module 内的语言至关重要；
      // struct/enum 作用域对于 Swift 至关重要——Swift 在 `struct`/`enum`
      // 中命名空间化共享常量（`enum Constants { static let X }`）。
      // 读者是同文件中该类型的方法。
      if (
        parentId &&
        (parentId.startsWith('file:') || parentId.startsWith('class:') ||
          parentId.startsWith('module:') || parentId.startsWith('struct:') ||
          parentId.startsWith('enum:'))
      ) {
        this.fileScopeValues.set(name, id);
        // 携带该名称的目标节点数量。条件定义
        // （`try: X = a; except: X = b`）会使其 >1——
        // 与局部遮蔽不同，后者会添加 prune 必须捕获的绑定（见 flushValueRefs）。
        this.fileScopeValueCounts.set(name, (this.fileScopeValueCounts.get(name) ?? 0) + 1);
      }
    }
    if (kind === 'function' || kind === 'method' || kind === 'constant' || kind === 'variable') {
      this.valueRefScopes.push({ id, node, name });
    }
  }

  /**
   * 从符号向其读取的文件作用域 const/var 发出同文件 `references` 边（TS/JS）。
   * 引擎不会生成 const→consumer 边，导致影响分析遗漏"更改此表会影响其读者"
   * 的场景（ReScript-PR 假阴性）。仅限同文件（解析无歧义），
   * 仅限有辨识度的目标名称（规避 function_ref 记录的局部遮蔽精度陷阱），
   * 按（读者, 目标）去重。默认开启（`SYNAPSE_VALUE_REFS=0` 禁用）+ 累加式。
   * 被遮蔽的目标会被剪除——见下文。
   */
  private flushValueRefs(): void {
    const scopes = this.valueRefScopes;
    const targets = this.fileScopeValues;
    const fileScopeCounts = this.fileScopeValueCounts;
    this.valueRefScopes = [];
    this.fileScopeValues = new Map();
    this.fileScopeValueCounts = new Map();
    if (!this.valueRefsEnabled || !TreeSitterExtractor.VALUE_REF_LANGS.has(this.language)) return;
    if (targets.size === 0 || scopes.length === 0 || isGeneratedFile(this.filePath)) return;

    // 剪除被遮蔽的目标。在内层作用域中重新绑定的目标（内嵌的 Emscripten
    // `const Module` 重声明为嵌套 `var Module`；Go 包级 `const Timeout` 被局部
    // `Timeout := …` 遮蔽；Python 模块 `CONFIG` 被局部 `CONFIG = …` 遮蔽）
    // 对嵌套读者而言解析为内层绑定，因此文件作用域边是假阳性。
    // 内层重绑定不是图节点，需在语法层面检测：统计树中每个名称声明符的出现次数，
    // 与携带该名称的文件作用域节点数量比较。真正的遮蔽使（声明符 >
    // 文件作用域节点）——超出部分是局部绑定。条件式模块级定义
    // （`try: X = a; except: X = b`）使两者相等（两个声明符都是文件作用域节点），
    // 因此会被正确保留。与基于路径的 isGeneratedFile() 检查互补——
    // 后者无法捕获内容压缩的 bundle。
    //
    // 声明符节点类型按 grammar 划分；一个文件只包含自身语言的节点，
    // 因此在一个 switch 中匹配所有类型是安全的。
    if (this.tree) {
      const declCounts = new Map<string, number>();
      const bump = (nameNode: SyntaxNode | null) => {
        // `simple_identifier` is Kotlin's name node (a property declarator's name).
        if (nameNode && (nameNode.type === 'identifier' || nameNode.type === 'simple_identifier')) {
          const nm = getNodeText(nameNode, this.source);
          if (targets.has(nm)) declCounts.set(nm, (declCounts.get(nm) ?? 0) + 1);
        }
      };
      const dstack: SyntaxNode[] = [this.tree.rootNode];
      let dvisited = 0;
      while (dstack.length > 0 && dvisited < TreeSitterExtractor.MAX_VALUE_REF_NODES) {
        const n = dstack.pop()!;
        dvisited++;
        switch (n.type) {
          case 'variable_declarator': // TS/JS/tsx
          case 'const_spec':          // Go  `const X = …`
          case 'var_spec':            // Go  `var X = …`
            bump(n.namedChild(0));
            break;
          case 'const_item':          // Rust  `const X: T = …`
          case 'static_item':         // Rust  `static X: T = …`
            bump(getChildByField(n, 'name'));
            break;
          case 'let_declaration':       // Rust  `let x = …`（局部变量——遮蔽来源）
          case 'short_var_declaration': // Go    `x, Y := …`
          case 'assignment': {          // Python `X = …` / `X: T = …` / `A, B = …`
            const left = getChildByField(n, 'left') ?? getChildByField(n, 'pattern') ?? n.namedChild(0);
            if (left?.type === 'identifier') bump(left);
            else if (left) for (const c of left.namedChildren) bump(c);
            break;
          }
          case 'init_declarator':       // C  `T X = …`（文件作用域 const 及其遮蔽局部变量）
            bump(cDeclaratorIdentifier(n));
            break;
          case 'val_definition':        // Scala  `val X = …`（object/顶层 const 及方法局部遮蔽）
          case 'var_definition': {      // Scala  `var X = …`
            const pat = getChildByField(n, 'pattern');
            if (pat?.type === 'identifier') bump(pat);
            break;
          }
          case 'static_final_declaration':         // Dart  顶层/`static` `const`/`final`（目标本身）
          case 'initialized_identifier':           // Dart  实例字段 / `var`
          case 'initialized_variable_definition': { // Dart  方法局部 `const`/`final`/`var`（遮蔽 const）
            const id = n.namedChildren.find((c) => c.type === 'identifier');
            if (id) bump(id);
            break;
          }
          case 'declConst':  // Pascal  单元/类 `const`（目标本身）及函数局部 `const`（遮蔽目标）
          case 'declVar': {  // Pascal  遮蔽 const 的函数局部 `var`
            bump(getChildByField(n, 'name'));
            break;
          }
          case 'property_declaration': { // Kotlin / Swift  `val`/`let X = …`（object/static const 及方法局部遮蔽）
            // Kotlin：variable_declaration → simple_identifier；Swift：`pattern`
            // （`<name>` 字段）→ simple_identifier。两种形状均解析。
            const vd = n.namedChildren.find((c) => c.type === 'variable_declaration');
            const id = vd
              ? vd.namedChildren.find((c) => c.type === 'simple_identifier')
              : firstSimpleIdentifier(
                  getChildByField(n, 'name') ??
                    n.namedChildren.find((c) => c.type === 'value_binding_pattern' || c.type === 'pattern') ??
                    null,
                );
            if (id) bump(id);
            break;
          }
        }
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i);
          if (c) dstack.push(c);
        }
      }
      for (const [nm, c] of declCounts) if (c > (fileScopeCounts.get(nm) ?? 1)) targets.delete(nm);
      if (targets.size === 0) return;
    }

    for (const scope of scopes) {
      const seen = new Set<string>();
      const stack: SyntaxNode[] = [scope.node];
      // Dart 和 Pascal 将函数/方法 BODY 作为存储为读者作用域的签名节点的
      // *下一个兄弟节点*（Dart `method_signature` ← `function_body`；
      // Pascal `declProc` ← `block`，两者均在 `defProc` 下），而非子节点——
      // 因此作用域子树仅是签名，读取操作位于兄弟节点中。将其纳入。
      // （作用域节点的下一兄弟节点作为 body 在值引用语言中仅 Dart/Pascal 有此特点——
      // 其他所有 grammar 均将 body 嵌套在函数节点内——因此在其他地方此操作无效。）
      const sib = scope.node.nextNamedSibling;
      if (sib && (sib.type === 'function_body' || sib.type === 'block')) stack.push(sib);
      let visited = 0;
      while (stack.length > 0 && visited < TreeSitterExtractor.MAX_VALUE_REF_NODES) {
        const n = stack.pop()!;
        visited++;
        // `constant` 覆盖 Ruby——其常量的定义和引用均为 `constant` 类型节点，
        // 而非 `identifier`。`name` 覆盖 PHP——常量引用（裸 `MAX_ITEMS` 或
        // `self::MAX_ITEMS` / `Foo::MAX_ITEMS` 中的 const 部分）是 `name` 节点
        // （`$var` 局部变量是 `variable_name`，不同命名空间，永远不会遮蔽裸常量——
        // 无需 prune 连线）。`simple_identifier` 覆盖 Kotlin——其每个名称引用
        // （包括 const 读取）均为该节点类型。跨语言安全：一个文件只包含
        // 自身 grammar 的节点；`name` 仅属于 PHP，`simple_identifier` 仅属于 Kotlin。
        if (
          n.type === 'identifier' || n.type === 'constant' ||
          n.type === 'name' || n.type === 'simple_identifier'
        ) {
          const refName = getNodeText(n, this.source);
          const targetId = targets.get(refName);
          // 跳过自身和同名目标：符号引用与自身同名的文件作用域兄弟节点
          // （条件式 `try: X=…; except: X=…` 的两半）永远不是有意义的值读取。
          if (targetId && targetId !== scope.id && refName !== scope.name && !seen.has(targetId)) {
            seen.add(targetId);
            this.edges.push({
              source: scope.id,
              target: targetId,
              kind: 'references',
              metadata: { valueRef: true },
            });
          }
        }
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i);
          if (c) stack.push(c);
        }
      }
    }
  }

  /**
   * 访问节点并提取信息
   */
  private visitNode(node: SyntaxNode): void {
    if (!this.extractor) return;

    const nodeType = node.type;
    let skipChildren = false;

    // 语言专属自定义 visitor hook
    if (this.extractor.visitNode) {
      const ctx = this.makeExtractorContext();
      const handled = this.extractor.visitNode(node, ctx);
      if (handled) {
        // hook 已消费该子树，下方的游走器不会再递归进入——
        // 扫描该子树以查找 function-as-value 候选（#756）。
        // 例如 Scala 的 hook 处理 val/var 定义（`val table = Seq(targetCb)`）。
        // 该扫描仅做捕获，并在遇到嵌套函数时停止。
        this.scanFnRefSubtree(node, 0);
        return;
      }
    }

    // Pascal 专属 AST 处理
    if (this.language === 'pascal') {
      skipChildren = this.visitPascalNode(node);
      if (skipChildren) return;
    }

    // Function-as-value 捕获（#756）——独立于下方的分发梯级
    // （捕获的容器类型在其中没有其他处理器），因此永远不会遮蔽或被提取分支遮蔽。
    this.maybeCaptureFnRefs(node, nodeType);

    // 检查函数声明
    // 对于 Python/Ruby，类内的 function_definition 应视为方法
    if (this.extractor.functionTypes.includes(nodeType)) {
      if (this.isInsideClassLikeNode() && this.extractor.methodTypes.includes(nodeType)) {
        // 类内部——视为方法
        this.extractMethod(node);
        skipChildren = true; // extractMethod 通过 visitFunctionBody 访问子节点
      } else {
        this.extractFunction(node);
        skipChildren = true; // extractFunction 通过 visitFunctionBody 访问子节点
      }
    }
    // 检查类声明
    else if (this.extractor.classTypes.includes(nodeType)) {
      // 部分语言复用 class_declaration 表示 struct/enum（如 Swift）
      const classification = this.extractor.classifyClassNode?.(node) ?? 'class';
      if (classification === 'struct') {
        this.extractStruct(node);
      } else if (classification === 'enum') {
        this.extractEnum(node);
      } else if (classification === 'interface') {
        this.extractInterface(node);
      } else if (classification === 'trait') {
        this.extractClass(node, 'trait');
      } else {
        this.extractClass(node);
      }
      skipChildren = true; // extractClass 访问 body 子节点
    }
    // 额外类节点类型（如 Dart mixin_declaration、extension_declaration）
    else if (this.extractor.extraClassNodeTypes?.includes(nodeType)) {
      this.extractClass(node);
      skipChildren = true;
    }
    // 检查方法声明（仅在未被 functionTypes 处理时）
    else if (this.extractor.methodTypes.includes(nodeType)) {
      // TS/JS 类字段解析为 methodTypes 节点；只有函数值字段是方法——
      // 普通字段（`public fonts: Fonts;`）是属性（#808）。
      // classifyMethodNode 在其他语言中不存在。
      if (this.extractor.classifyMethodNode?.(node) === 'property') {
        const propNode = this.extractProperty(node);
        // 游走初始化器，使其调用/实例化归属于属性
        // （`history = createHistory()` → history 调用 createHistory）。
        // 旧的 field-as-method 路径从未游走这些（resolveBody 只解析函数体），
        // 因此这是累加式的。
        const valueNode = getChildByField(node, 'value');
        if (propNode && valueNode) {
          this.nodeStack.push(propNode.id);
          this.visitFunctionBody(valueNode, '');
          this.nodeStack.pop();
        }
        // 字段初始化器也可以注册 callback
        // （`static handlers = { click: onClick }`）——扫描其中的
        // function-as-value 候选（仅捕获，遇函数定义停止）。
        this.scanFnRefSubtree(node, 0);
        skipChildren = true;
      } else {
        this.extractMethod(node);
        skipChildren = true; // extractMethod 通过 visitFunctionBody 访问子节点
      }
    }
    // 检查 interface/protocol/trait 声明
    else if (this.extractor.interfaceTypes.includes(nodeType)) {
      this.extractInterface(node);
      skipChildren = true; // extractInterface 访问 body 子节点
    }
    // 检查 struct 声明
    else if (this.extractor.structTypes.includes(nodeType)) {
      this.extractStruct(node);
      skipChildren = true; // extractStruct 访问 body 子节点
    }
    // 检查 enum 声明
    else if (this.extractor.enumTypes.includes(nodeType)) {
      this.extractEnum(node);
      skipChildren = true; // extractEnum 访问 body 子节点
    }
    // 检查类型别名声明（如 TypeScript 中的 `type X = ...`）
    // 对于 Go，type_spec 包裹 struct/interface 定义——resolveTypeAliasKind
    // 检测这些情况，extractTypeAlias 创建正确的节点类型。
    else if (this.extractor.typeAliasTypes.includes(nodeType)) {
      skipChildren = this.extractTypeAlias(node);
    }
    // 检查类属性（如 C# property_declaration）
    else if (this.extractor.propertyTypes?.includes(nodeType) && this.isInsideClassLikeNode()) {
      this.extractProperty(node);
      // 属性初始化器不被游走——扫描 function-as-value 候选（#756）：
      // Scala `val table = Seq(targetCb)` 在 object 中，
      // Kotlin `val cb = ::handler` 类属性。
      this.scanFnRefSubtree(node, 0);
      skipChildren = true;
    }
    // 检查类字段（如 Java field_declaration、C# field_declaration）
    else if (this.extractor.fieldTypes?.includes(nodeType) && this.isInsideClassLikeNode()) {
      this.extractField(node);
      // 字段初始化器不被游走——扫描 function-as-value 候选（#756）：
      // Java `List<IntConsumer> table = List.of(Main::cb)`，
      // C# `List<Action<int>> table = new() { TargetCb }`。
      this.scanFnRefSubtree(node, 0);
      skipChildren = true;
    }
    // 检查变量声明（const、let、var 等）
    // 仅提取顶层变量（非函数/方法内部）——加上类/module 作用域常量，
    // Ruby（及其他 const-in-class 语言）几乎将所有常量保存在类或 module 内。
    // Ruby `CONST = …` 的 LHS 是 `constant` 类型；其他语言不在此处放置此类节点，
    // 因此这实际上仅针对 Ruby，不干扰其他语言的类内局部变量。
    else if (
      this.extractor.variableTypes.includes(nodeType) &&
      (!this.isInsideClassLikeNode() || this.isClassScopeConstantAssignment(node))
    ) {
      this.extractVariable(node);
      // extractVariable 不游走每种初始化器形状（对象字面量故意跳过；
      // Python/Ruby 根本不游走），因此扫描声明子树查找 function-as-value 候选——
      // `const routes = { home: renderHome }`、`handlers = {"recv": target_cb}`。
      // 扫描在嵌套函数定义处停止（其函数体被单独游走并归属），
      // 刷新时去重可吸收 extractVariable 确实游走的初始化器的任何重叠。
      this.scanFnRefSubtree(node, 0);
      skipChildren = true; // extractVariable 处理子节点
    }
    // Swift 类型内的存储属性。Swift 实例属性不提取为自身节点，
    // 但属性的 PROPERTY WRAPPER（`@Argument`/`@Published`/`@State`/自定义）
    // 和声明类型是依赖项——将其归属于封闭类型，以便 wrapper/类型文件获得依赖方。
    // 不 skipChildren：初始化器的调用仍有意义。
    // （其他语言通过 property/field 类型提取属性。）
    else if (
      this.language === 'swift' &&
      nodeType === 'property_declaration' &&
      this.isInsideClassLikeNode()
    ) {
      const ownerId = this.nodeStack[this.nodeStack.length - 1];
      // `static let`/`static var` 成员是该类型的共享常量
      // （Swift 的 `static` 命名空间惯用法，尤其在 `enum`/`struct` 中）——
      // 将其提取为 `constant`/`variable`，以便值引用边可以指向它。
      // 实例存储属性保持为 `field`（per-instance；Swift 实例属性
      // 本来就没有自身节点——这一点不变）。*计算型*属性（getter，无存储值）
      // 永远不是常量——跳过该节点。
      const { nameNode, isLet, isComputed } = swiftPropertyInfo(node, this.source);
      if (nameNode && !isComputed) {
        const isStatic = this.extractor.isStatic?.(node) ?? false;
        this.createNode(isStatic ? (isLet ? 'constant' : 'variable') : 'field',
          getNodeText(nameNode, this.source), node, {
            visibility: this.extractor.getVisibility?.(node),
            isStatic,
          });
      }
      if (ownerId) {
        this.extractDecoratorsFor(node, ownerId);
        this.extractVariableTypeAnnotation(node, ownerId);
        // Fluent / SwiftUI 属性包装器（property wrapper）的 attribute 常在其**参数**中
        // 通过 metatype 引用 model 或类型——如 `@Siblings(through: Pivot.self, …)`、
        // `@Group(…)`。extractDecoratorsFor 捕获包装器类型（`Siblings`）；
        // 此处从参数表达式中提取类型（`Pivot.self` → 对 Pivot 的依赖），
        // 避免仅通过关联关系（多对多 pivot/join model）访问的 model 变成孤儿。
        // extractStaticMemberRef 自行过滤为 `Type.member` 导航，
        // 因此 `\.$keypath` 参数和包装器 `user_type` 会被跳过。
        const modifiers = node.namedChildren.find((c: SyntaxNode) => c.type === 'modifiers');
        if (modifiers) {
          const walkAttrArgs = (n: SyntaxNode): void => {
            this.extractStaticMemberRef(n);
            for (let i = 0; i < n.namedChildCount; i++) {
              const c = n.namedChild(i);
              if (c) walkAttrArgs(c);
            }
          };
          walkAttrArgs(modifiers);
        }
      }
    }
    // `export_statement` 本身不被提取——游走器下降至子节点，
    // 内层声明（lexical_declaration、function_declaration、class_declaration 等）
    // 被分发到各自的提取器。`isExported` 游走父链，因此导出标志自动保留。
    //
    // 在此调用 extractExportedVariables 并同时下降，会导致每个
    // `export const X = ...` 产生同一符号的两个节点——
    // 一个来自 extractExportedVariables 的 kind:'variable'，
    // 一个来自 extractVariable 的 kind:'constant'。
    // 专用分发是正确的（它从 isConst 获取 kind，捕获初始化器签名，
    // 并游走类型注解）；export-statement 辅助函数是冗余的。
    // 检查 import
    else if (this.extractor.importTypes.includes(nodeType)) {
      this.extractImport(node);
    }
    // 从另一模块重导出——`export { X } from './y'`（TS/JS）。
    // 重导出是对源模块的依赖，就像 import 一样，但 export_statement
    // 否则只会被下降（没有声明可提取），导致仅重导出的 barrel
    // 产生零边且显示 0 依赖方。将每个重导出名称链接到其定义。
    // 子节点仍会被访问（非重导出的 `export const X = …` 没有 `source`，
    // 会回退到正常的声明提取）。
    else if (
      nodeType === 'export_statement' &&
      (this.language === 'typescript' || this.language === 'tsx' ||
       this.language === 'javascript' || this.language === 'jsx') &&
      getChildByField(node, 'source')
    ) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) this.emitReExportRefs(node, parentId);
    }
    // 检查函数调用
    else if (this.extractor.callTypes.includes(nodeType)) {
      this.extractCall(node);
    }
    // `new Foo(...)` / `Foo::new(...)` / object_creation_expression——
    // 产生 `instantiates` 引用。子节点仍然被游走，
    // 以便构造函数参数内的嵌套调用（`new Foo(bar())`）获得各自的 `calls` 引用。
    else if (INSTANTIATION_KINDS.has(nodeType)) {
      this.extractInstantiation(node);
      // Java/C# `new T(...) { ... }` — 带 body 的匿名类。若不将其提取为
      // 类节点及其方法，interface→impl 合成器（Phase 5.5）无法将 T 的
      // 抽象方法桥接到匿名覆盖，智能体调查通过 T 的调用
      // （`strategy.iterator(...)` 其中 strategy 是 Strategy lambda body）
      // 时不得不 Read 文件查找实际实现。
      const anonBody = this.findAnonymousClassBody(node);
      if (anonBody) {
        this.extractAnonymousClass(node, anonBody);
        skipChildren = true;
      }
    }
    // （Decorator 处理位于符号创建提取器内——extractClass / extractFunction /
    // extractProperty——因为 decorator 节点在 AST 中位于符号之前，
    // 游走器否则会看到错误的 nodeStack 头部。）
    // Rust：`impl Trait for Type { ... }` — 从 Type 到 Trait 创建 implements 边
    else if (nodeType === 'impl_item') {
      this.extractRustImplItem(node);
    }
    // TypeScript interface 成员：property_signature（`foo: T`、`foo?: T`）
    // 和 method_signature（`foo(arg: A): R`）都携带类型注解，
    // interface 游走器否则会丢弃。将它们提取为从 interface 出发的 `references` 边，
    // 以便解析器可以为仅出现在 interface 成员中的类型连线 callers/impact。
    else if (
      (nodeType === 'property_signature' || nodeType === 'method_signature') &&
      this.isInsideClassLikeNode() &&
      this.TYPE_ANNOTATION_LANGUAGES.has(this.language)
    ) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) {
        this.extractTypeAnnotations(node, parentId);
      }
      // 不 skipChildren——嵌套签名仍需遍历
    }

    // 访问子节点（除非提取方法已经访问过它们）
    if (!skipChildren) {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          this.visitNode(child);
        }
      }
    }
  }

  /**
   * 创建节点对象
   */
  private createNode(
    kind: NodeKind,
    name: string,
    node: SyntaxNode,
    extra?: Partial<Node>
  ): Node | null {
    // 跳过名称为空/缺失的节点——它们不是有意义的符号，
    // 且当边引用它们时会导致 FK 违约（见 issue #42）
    if (!name) {
      return null;
    }

    const id = generateNodeId(this.filePath, kind, name, node.startPosition.row + 1);

    // 部分 grammar（如 Dart）将函数/方法 body 建模为签名节点的*兄弟节点*，
    // 因此声明节点自身的范围仅是签名行。当 body 位于节点范围之外时，
    // 将 endLine 扩展到已解析的 body，使节点涵盖其 body——
    // 任何 body 级分析（callees、callback 合成器的 body 扫描、上下文切片）均需此操作。
    // 仅在需要时扩展：对于子 body grammar，body 在范围内（无操作）。
    let endLine = node.endPosition.row + 1;
    if (kind === 'function' || kind === 'method') {
      const body = this.extractor?.resolveBody?.(node, this.extractor.bodyField);
      if (body && body.endPosition.row + 1 > endLine) {
        endLine = body.endPosition.row + 1;
      }
    }

    const newNode: Node = {
      id,
      kind,
      name,
      qualifiedName: this.buildQualifiedName(name),
      filePath: this.filePath,
      language: this.language,
      startLine: node.startPosition.row + 1,
      endLine,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      updatedAt: Date.now(),
      ...extra,
    };

    // 将额外的符号级修饰符（如 Kotlin 的 `expect`/`actual`）持久化到节点的
    // decorators 列表，以便解析器能将多平台声明与其实现配对。
    // 执行合并而非覆盖，因此同时捕获真实注解的语言可以保留两者。
    const mods = this.extractor?.extractModifiers?.(node);
    if (mods && mods.length > 0) {
      newNode.decorators = [...(newNode.decorators ?? []), ...mods];
    }

    this.nodes.push(newNode);

    // 从父节点添加包含边
    if (this.nodeStack.length > 0) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) {
        this.edges.push({
          source: parentId,
          target: id,
          kind: 'contains',
        });
      }
    }

    if (this.valueRefsEnabled) this.captureValueRefScope(kind, name, id, node);

    return newNode;
  }

  /**
   * 查找类型在给定列表中的第一个命名子节点。
   * 用于定位内层类型节点（如 typedef 内的 enum_specifier）。
   */
  private findChildByTypes(node: SyntaxNode, types: string[]): SyntaxNode | null {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && types.includes(child.type)) return child;
    }
    return null;
  }

  /**
   * 在根节点下查找 `packageTypes` 子节点，为其创建 `namespace` 节点，
   * 并返回其 id，以便调用方将顶层声明置于其作用域下。
   * 当不存在 package 头时（脚本文件、不带 package 的 .kts）返回 null。
   */
  private extractFilePackage(rootNode: SyntaxNode): string | null {
    const types = this.extractor?.packageTypes;
    if (!types || types.length === 0 || !this.extractor?.extractPackage) return null;

    let pkgNode: SyntaxNode | null = null;
    for (let i = 0; i < rootNode.namedChildCount; i++) {
      const child = rootNode.namedChild(i);
      if (child && types.includes(child.type)) {
        pkgNode = child;
        break;
      }
    }
    if (!pkgNode) return null;

    const pkgName = this.extractor.extractPackage(pkgNode, this.source);
    if (!pkgName) return null;

    const ns = this.createNode('namespace', pkgName, pkgNode);
    return ns?.id ?? null;
  }

  /**
   * 从节点栈构建限定名称
   */
  private buildQualifiedName(name: string): string {
    // 仅从语义层次结构构建限定名称（不含文件路径）。
    // 文件路径单独存储在 filePath 中，若包含在此会污染 FTS。
    const parts: string[] = [];
    for (const nodeId of this.nodeStack) {
      const node = this.nodes.find((n) => n.id === nodeId);
      if (node && node.kind !== 'file') {
        parts.push(node.name);
      }
    }
    parts.push(name);
    return parts.join('::');
  }

  /**
   * 构建 ExtractorContext，用于传递给语言特定的 visitNode hook。
   */
  private makeExtractorContext(): ExtractorContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      createNode: (kind, name, node, extra) => self.createNode(kind, name, node, extra),
      visitNode: (node) => self.visitNode(node),
      visitFunctionBody: (body, functionId) => self.visitFunctionBody(body, functionId),
      addUnresolvedReference: (ref) => self.unresolvedReferences.push(ref),
      pushScope: (nodeId) => self.nodeStack.push(nodeId),
      popScope: () => self.nodeStack.pop(),
      get filePath() { return self.filePath; },
      get source() { return self.source; },
      get nodeStack() { return self.nodeStack; },
      get nodes() { return self.nodes; },
    };
  }

  /**
   * 检查当前节点栈是否表明我们位于类似类的节点内
   * （class、struct、interface、trait）。文件节点不算类似类的节点。
   */
  private isInsideClassLikeNode(): boolean {
    if (this.nodeStack.length === 0) return false;
    const parentId = this.nodeStack[this.nodeStack.length - 1];
    if (!parentId) return false;
    const parentNode = this.nodes.find((n) => n.id === parentId);
    if (!parentNode) return false;
    return (
      parentNode.kind === 'class' ||
      parentNode.kind === 'struct' ||
      parentNode.kind === 'interface' ||
      parentNode.kind === 'trait' ||
      parentNode.kind === 'enum' ||
      parentNode.kind === 'module'
    );
  }

  /**
   * Ruby `CONST = …` 赋值语句，其 LHS 是 `constant` 节点——
   * 即使在类内部也值得提取为符号的类/module（或顶层）常量。
   * 其他语言不会为赋值语句的 LHS 赋予 `constant` 类型，
   * 因此此门控实际上仅针对 Ruby。
   */
  private isClassScopeConstantAssignment(node: SyntaxNode): boolean {
    if (node.type !== 'assignment') return false;
    const left = getChildByField(node, 'left') ?? node.namedChild(0);
    return left?.type === 'constant';
  }

  /**
   * 提取函数
   */
  private extractFunction(node: SyntaxNode, nameOverride?: string): void {
    if (!this.extractor) return;

    // 若语言提供 getReceiverType 且此函数具有接收者
    // （如 impl 块内的 Rust function_item），则改为提取为 method
    if (this.extractor.getReceiverType?.(node, this.source)) {
      this.extractMethod(node);
      return;
    }

    // nameOverride 仅在调用方自行解析了显式命名匿名函数时提供
    // （如导出 const 对象成员的箭头值——SvelteKit actions）。
    // 由通用游走器到达的内联对象箭头不提供 override，
    // 因此仍会进入下方的 <anonymous> 跳过逻辑。
    let name = nameOverride ?? extractName(node, this.source, this.extractor);
    // 对于赋值给变量的箭头函数和函数表达式，
    // 从父节点 variable_declarator 解析名称。
    // 例如 `export const useAuth = () => { ... }` — arrow_function 节点
    // 没有 `name` 字段；名称位于 variable_declarator 上。
    if (
      !nameOverride &&
      name === '<anonymous>' &&
      (node.type === 'arrow_function' || node.type === 'function_expression')
    ) {
      const parent = node.parent;
      if (parent?.type === 'variable_declarator') {
        const varName = getChildByField(parent, 'name');
        if (varName) {
          name = getNodeText(varName, this.source);
        }
      }
    }
    if (name === '<anonymous>') {
      // 不为匿名包装器本身发出节点，但仍访问其 body：
      // AMD/RequireJS 和 CommonJS 模块包装器（`define([], function(){…})`、
      // `(function(){…})()`）持有命名内层函数和调用，否则会丢失——
      // 分发器设置了 skipChildren，因此没有其他路径下降到此子树。（#528）
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    // 检查误解析产物（如 C++ 宏导致 "namespace detail" 函数）
    // 跳过节点，但仍访问 body 以获取调用和结构节点
    if (this.extractor.isMisparsedFunction?.(name, node)) {
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);
    const returnType = this.extractor.getReturnType?.(node, this.source);

    const funcNode = this.createNode('function', name, node, {
      docstring,
      signature,
      visibility,
      isExported,
      isAsync,
      isStatic,
      returnType,
    });
    if (!funcNode) return;

    // 提取类型注解（参数类型和返回类型）
    this.extractTypeAnnotations(node, funcNode.id);

    // 提取应用于函数的 decorator（在 JS/TS 中罕见，但
    // Python `@decorator def f():` 和 Java/Kotlin 自由函数注解中存在）。
    this.extractDecoratorsFor(node, funcNode.id);

    // 压栈并访问 body
    this.nodeStack.push(funcNode.id);
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, funcNode.id);
    }
    this.nodeStack.pop();
  }

  /**
   * 提取类
   */
  private extractClass(node: SyntaxNode, kind: NodeKind = 'class'): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const classNode = this.createNode(kind, name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!classNode) return;

    // 提取 extends/implements
    this.extractInheritance(node, classNode.id);

    // C# 主构造函数参数依赖（`class Svc(IRepo r, …)`）。
    this.extractCsharpPrimaryCtorParamRefs(node, classNode.id);

    // 提取应用于类的 decorator（`@Foo class X {}`）。
    this.extractDecoratorsFor(node, classNode.id);

    // 压栈并访问 body
    this.nodeStack.push(classNode.id);
    let body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) body = node;

    // 访问所有子节点以获取方法和属性
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a method
   */
  private extractMethod(node: SyntaxNode): void {
    if (!this.extractor) return;

    // 对于带有接收者类型的语言（Go、Rust），在限定名称中包含接收者，
    // 以便 FTS 能匹配 "scrapeLoop.run" → qualified_name "...::scrapeLoop::run"
    const receiverType = this.extractor.getReceiverType?.(node, this.source);

    // 对于大多数语言，仅在类似类的节点内才将其提取为方法
    // methodsAreTopLevel 的语言（如 Go）始终视为方法
    // 带有 getReceiverType 的语言（如 Rust）在找到接收者时提取为方法
    if (!this.isInsideClassLikeNode() && !this.extractor.methodsAreTopLevel && !receiverType) {
      // 跳过对象字面量内的 method_definition 节点（getter/setter/内联对象方法）。
      // 这些是临时的，会产生噪声（如 Svelte context 对象：`ctx.set({ get view() { ... } })`）。
      if (node.parent?.type === 'object' || node.parent?.type === 'object_expression') {
        const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
          ?? getChildByField(node, this.extractor.bodyField);
        if (body) {
          this.visitFunctionBody(body, '');
        }
        return;
      }
      // 不在类似类的节点内且无接收者类型，视为函数
      this.extractFunction(node);
      return;
    }

    const name = extractName(node, this.source, this.extractor);

    // 检查误解析产物（如 C++ 宏混淆类 body 内的 "switch"）
    if (this.extractor.isMisparsedFunction?.(name, node)) {
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);
    const returnType = this.extractor.getReturnType?.(node, this.source);
    const extraProps: Partial<Node> = {
      docstring,
      signature,
      visibility,
      isAsync,
      isStatic,
      returnType,
    };
    if (receiverType) {
      extraProps.qualifiedName = `${receiverType}::${name}`;
    }

    const methodNode = this.createNode('method', name, node, extraProps);
    if (!methodNode) return;

    // 对于有接收者类型但栈上没有类似类父节点的方法（如 Rust impl 块），
    // 从所属 struct/trait 添加 contains 边
    if (receiverType && !this.isInsideClassLikeNode()) {
      const ownerNode = this.nodes.find(
        (n) =>
          n.name === receiverType &&
          n.filePath === this.filePath &&
          (n.kind === 'struct' || n.kind === 'class' || n.kind === 'enum' || n.kind === 'trait')
      );
      if (ownerNode) {
        this.edges.push({
          source: ownerNode.id,
          target: methodNode.id,
          kind: 'contains',
        });
      }
    }

    // 提取类型注解（参数类型和返回类型）
    this.extractTypeAnnotations(node, methodNode.id);

    // 提取 decorator（`@Get('/list') list() {}`）。
    this.extractDecoratorsFor(node, methodNode.id);

    // 压栈并访问 body
    this.nodeStack.push(methodNode.id);
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, methodNode.id);
    }
    this.nodeStack.pop();
  }

  /**
   * 提取 interface/protocol/trait
   */
  private extractInterface(node: SyntaxNode): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';

    const interfaceNode = this.createNode(kind, name, node, {
      docstring,
      isExported,
    });
    if (!interfaceNode) return;

    // 提取 extends（interface 继承）
    this.extractInheritance(node, interfaceNode.id);

    // 访问 body 子节点以获取 interface 方法和嵌套类型
    this.nodeStack.push(interfaceNode.id);
    let body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) body = node;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * 提取 struct
   */
  private extractStruct(node: SyntaxNode): void {
    if (!this.extractor) return;

    // 跳过前向声明和类型引用（无 body = 非定义）
    // ——但 C# 位置记录（`record struct M(decimal Amount);`）例外，
    // 这是不带 body 块的完整定义。（#831）
    const body = getChildByField(node, this.extractor.bodyField);
    if (!body && node.type !== 'record_declaration') return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const structNode = this.createNode('struct', name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!structNode) return;

    // 提取继承（如 Swift：struct HTTPMethod: RawRepresentable）
    this.extractInheritance(node, structNode.id);

    // C# 主构造函数参数依赖（`struct P(int x)` 以及
    // grammar 嵌套于此的 `record struct M(decimal Amount)`）。
    this.extractCsharpPrimaryCtorParamRefs(node, structNode.id);

    // 压栈以提取字段（无 body 的位置记录无成员可访问）
    if (body) {
      this.nodeStack.push(structNode.id);
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (child) {
          this.visitNode(child);
        }
      }
      this.nodeStack.pop();
    }
  }

  /**
   * 提取 enum
   */
  private extractEnum(node: SyntaxNode): void {
    if (!this.extractor) return;

    // 跳过前向声明和类型引用（无 body = 非定义）
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const enumNode = this.createNode('enum', name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!enumNode) return;

    // 提取继承（如 Swift：enum AFError: Error）
    this.extractInheritance(node, enumNode.id);

    // 压栈并访问 body 子节点（enum 成员、嵌套类型、方法）
    this.nodeStack.push(enumNode.id);

    const memberTypes = this.extractor.enumMemberTypes;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (!child) continue;

      if (memberTypes?.includes(child.type)) {
        this.extractEnumMembers(child);
      } else {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * 从 enum 成员节点提取枚举成员名称。
   * 处理多 case 声明（Swift：`case put, delete`）和单 case 模式。
   */
  private extractEnumMembers(node: SyntaxNode): void {
    // 优先尝试字段名（如 Rust enum_variant 有 'name' 字段）
    const nameNode = getChildByField(node, 'name');
    if (nameNode) {
      this.createNode('enum_member', getNodeText(nameNode, this.source), node);
      return;
    }

    // 检查类标识符子节点（Swift：simple_identifier，TS：property_identifier）
    let found = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (child.type === 'simple_identifier' || child.type === 'identifier' || child.type === 'property_identifier')) {
        this.createNode('enum_member', getNodeText(child, this.source), child);
        found = true;
      }
    }

    // 若节点本身就是标识符（如 TS property_identifier 直接在 enum body 中）
    if (!found && node.namedChildCount === 0) {
      this.createNode('enum_member', getNodeText(node, this.source), node);
    }
  }

  /**
   * 提取类属性声明（如 C# `public string Name { get; set; }`）。
   * 在所属类内提取为 'property' 类型节点。
   */
  private extractProperty(node: SyntaxNode): Node | null {
    if (!this.extractor) return null;

    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isStatic = this.extractor.isStatic?.(node) ?? false;

    const hookName = this.extractor.extractPropertyName?.(node, this.source);
    // JS `field_definition` 将其键命名为 `property` 字段（TS 使用 `name`）——
    // 在通用标识符扫描之前先尝试两者（#808）。
    const nameNode = hookName
      ? null
      : getChildByField(node, 'name') ||
        getChildByField(node, 'property') ||
        node.namedChildren.find(c => c.type === 'identifier');
    const name = hookName ?? (nameNode ? getNodeText(nameNode, this.source) : null);
    if (!name) return null;

    // 获取属性类型。TS/JS field 定义携带显式 `type` 字段（type_annotation）；
    // 其他命名子节点是名称和初始化器 VALUE，通用查找器会错误选取——
    // 因此 field 仅使用 type 字段（#808）。其他语言（C# property_declaration）
    // 保留通用扫描。
    const isTsJsField =
      node.type === 'public_field_definition' || node.type === 'field_definition';
    const typeNode = isTsJsField
      ? getChildByField(node, 'type')
      : node.namedChildren.find(
          c => c.type !== 'modifier' && c.type !== 'modifiers'
            && c.type !== 'identifier' && c.type !== 'accessor_list'
            && c.type !== 'accessors' && c.type !== 'equals_value_clause'
        );
    const typeText = typeNode
      ? getNodeText(typeNode, this.source).replace(/^:\s*/, '')
      : undefined;
    const signature = typeText ? `${typeText} ${name}` : name;

    const propNode = this.createNode('property', name, node, {
      docstring,
      signature,
      visibility,
      isStatic,
    });

    // `@Inject() private svc: Foo` 等——也为类属性捕获 decorator→目标关系。
    if (propNode) {
      this.extractDecoratorsFor(node, propNode.id);
      // 从属性向类型注解中命名的类型发出 `references` 边（#381）。
      // 通用游走器处理 TS 风格的 `type_annotation` 子节点；C# 分支游走 `type` 字段。
      this.extractTypeAnnotations(node, propNode.id);
    }
    return propNode;
  }

  /**
   * 提取类字段声明（如 Java field_declaration、C# field_declaration）。
   * 将每个声明符提取为所属类内的 'field' 类型节点。
   */
  private extractField(node: SyntaxNode): void {
    if (!this.extractor) return;

    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isStatic = this.extractor.isStatic?.(node) ?? false;

    // 实际上是常量（Java `static final`、C# `const`/`static readonly`）的类字段
    // 提取为 `constant` 类型而非 `field`，以便值引用边将其视为目标
    // （门控接受 constant/variable，不接受 field）。
    // 仅限 `isConst` 谓词为字段形状的语言——其他语言的字段保持 `field`。
    const fieldKind: NodeKind =
      (this.language === 'java' || this.language === 'csharp') &&
      (this.extractor.isConst?.(node) ?? false)
        ? 'constant'
        : 'field';

    // Java field_declaration："private final String name = value;" → variable_declarator(s) 是直接子节点
    // C# field_declaration：包装在 variable_declaration → variable_declarator(s) 中
    let declarators = node.namedChildren.filter(
      c => c.type === 'variable_declarator'
    );
    // C#：在 variable_declaration 包装器内查找
    if (declarators.length === 0) {
      const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
      if (varDecl) {
        declarators = varDecl.namedChildren.filter(c => c.type === 'variable_declarator');
      }
    }

    // PHP property_declaration：property_element → variable_name → name
    if (declarators.length === 0) {
      const propElements = node.namedChildren.filter(c => c.type === 'property_element');
      if (propElements.length > 0) {
        // 获取类型注解（如 "string"、"int"、"?Foo"）
        const typeNode = node.namedChildren.find(
          c => c.type !== 'visibility_modifier' && c.type !== 'static_modifier'
            && c.type !== 'readonly_modifier' && c.type !== 'property_element'
            && c.type !== 'var_modifier'
        );
        const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;

        for (const elem of propElements) {
          const varName = elem.namedChildren.find(c => c.type === 'variable_name');
          const nameNode = varName?.namedChildren.find(c => c.type === 'name');
          if (!nameNode) continue;
          const name = getNodeText(nameNode, this.source);
          const signature = typeText ? `${typeText} $${name}` : `$${name}`;
          this.createNode('field', name, elem, {
            docstring,
            signature,
            visibility,
            isStatic,
          });
        }
        return;
      }
    }

    if (declarators.length > 0) {
      // 从 type 子节点获取字段类型
      // Java：type 是 field_declaration 的直接子节点
      // C#：type 在 variable_declaration 包装器内
      const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
      const typeSearchNode = varDecl ?? node;
      const typeNode = typeSearchNode.namedChildren.find(
        c => c.type !== 'modifiers' && c.type !== 'modifier' && c.type !== 'variable_declarator'
          && c.type !== 'variable_declaration' && c.type !== 'marker_annotation' && c.type !== 'annotation'
      );
      const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;

      for (const decl of declarators) {
        const nameNode = getChildByField(decl, 'name')
          || decl.namedChildren.find(c => c.type === 'identifier');
        if (!nameNode) continue;
        const name = getNodeText(nameNode, this.source);
        const signature = typeText ? `${typeText} ${name}` : name;
        const fieldNode = this.createNode(fieldKind, name, decl, {
          docstring,
          signature,
          visibility,
          isStatic,
        });
        // Java/Kotlin 注解 / TS field decorator 位于外层 field_declaration 上，
        // 而非各个声明符上。
        if (fieldNode) {
          this.extractDecoratorsFor(node, fieldNode.id);
          // 与属性相同：向字段注解类型发出 `references` 边。
          // 外层 `field_declaration` 是正确的搜索起点——
          // C# 将 `type` 置于 `variable_declaration` 内，
          // `extractTypeAnnotations` 的语言感知路径会下降到该包装器（#381）。
          this.extractTypeAnnotations(node, fieldNode.id);
        }
      }
    } else {
      // 回退：尝试直接查找标识符子节点
      const nameNode = getChildByField(node, 'name')
        || node.namedChildren.find(c => c.type === 'identifier');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        this.createNode(fieldKind, name, node, {
          docstring,
          visibility,
          isStatic,
        });
      }
    }
  }

  /**
   * 将对象字面量中函数值属性提取为命名函数节点（以属性键命名）。
   * 由 extractVariable 中两种对象-函数形状共用：对象作为直接 const 值，
   * 以及 store 初始化器调用返回的对象。处理 `key: () => {}` /
   * `key: function() {}` 对和方法简写 `key() {}`。
   */
  private extractObjectLiteralFunctions(obj: SyntaxNode): void {
    for (let i = 0; i < obj.namedChildCount; i++) {
      const member = obj.namedChild(i);
      if (!member) continue;
      if (member.type === 'pair') {
        const key = getChildByField(member, 'key');
        const value = getChildByField(member, 'value');
        if (key && value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
          this.extractFunction(value, this.objectKeyName(key));
        }
      } else if (member.type === 'method_definition') {
        // 方法简写：`{ fetchUser() {...} }`。extractMethod 故意跳过对象字面量方法，
        // 因此通过 extractFunction 并附带显式名称路由（method_definition 暴露 `body` 字段，
        // 所以 resolveBody 会透传到它，节点涵盖完整方法）。
        const key = getChildByField(member, 'name');
        if (key) this.extractFunction(member, this.objectKeyName(key));
      }
    }
  }

  /** 去除属性键两端引号的文本（`'foo'` → `foo`）。 */
  private objectKeyName(key: SyntaxNode): string {
    return getNodeText(key, this.source).replace(/^['"`]|['"`]$/g, '');
  }

  /**
   * 给定 `call_expression` 初始化器（`create((set, get) => ({...}))`），
   * 查找函数参数返回的对象字面量——下降穿越嵌套 call_expression 参数，
   * 以便解包中间件包装器
   * （`create(persist((set, get) => ({...}), {...}))`、devtools、immer、
   * subscribeWithSelector）。当未找到此类对象时返回 null——
   * 普通调用初始化器的常见情况——以保持廉价且��默，而非猜测。
   * 纯粹基于 AST 形状；不依赖库名称。
   */
  private findInitializerReturnedObject(callNode: SyntaxNode, depth = 0): SyntaxNode | null {
    if (depth > 4) return null;
    const args = getChildByField(callNode, 'arguments');
    if (!args) return null;
    for (let i = 0; i < args.namedChildCount; i++) {
      const arg = args.namedChild(i);
      if (!arg) continue;
      if (arg.type === 'arrow_function' || arg.type === 'function_expression') {
        const obj = this.functionReturnedObject(arg);
        if (obj) return obj;
      } else if (arg.type === 'call_expression') {
        const obj = this.findInitializerReturnedObject(arg, depth + 1);
        if (obj) return obj;
      }
    }
    return null;
  }

  /**
   * 函数表达式返回的对象字面量——可以是 `=> ({...})` 箭头形式
   * （包裹对象的 parenthesized_expression），或 `=> { return {...} }` 块。
   * 对于任何其他 body 形状返回 null。
   */
  private functionReturnedObject(fnNode: SyntaxNode): SyntaxNode | null {
    const body = getChildByField(fnNode, 'body');
    if (!body) return null;
    const asObject = (n: SyntaxNode | null): SyntaxNode | null => {
      if (!n) return null;
      if (n.type === 'object' || n.type === 'object_expression') return n;
      if (n.type === 'parenthesized_expression') {
        for (let i = 0; i < n.namedChildCount; i++) {
          const inner = asObject(n.namedChild(i));
          if (inner) return inner;
        }
      }
      return null;
    };
    // `(set, get) => ({...})` — body 直接是（括号包裹的）对象。
    const direct = asObject(body);
    if (direct) return direct;
    // `(set, get) => { return {...} }` — 扫描顶层 return 语句。
    if (body.type === 'statement_block') {
      for (let i = 0; i < body.namedChildCount; i++) {
        const stmt = body.namedChild(i);
        if (stmt?.type !== 'return_statement') continue;
        for (let j = 0; j < stmt.namedChildCount; j++) {
          const obj = asObject(stmt.namedChild(j));
          if (obj) return obj;
        }
      }
    }
    return null;
  }

  /**
   * 提取变量声明（const、let、var 等）
   *
   * 提取顶层和模块级变量声明。
   * 在 signature 中捕获变量名和初始化器的前 100 个字符以提升可搜索性。
   */
  private extractVariable(node: SyntaxNode): void {
    if (!this.extractor) return;

    // 不同语言有不同的变量声明结构
    // TypeScript/JavaScript：lexical_declaration 包含 variable_declarator 子节点
    // Python：assignment 有 left（identifier）和 right（value）
    // Go：var_declaration、short_var_declaration、const_declaration

    const isConst = this.extractor.isConst?.(node) ?? false;
    const kind: NodeKind = isConst ? 'constant' : 'variable';
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source) ?? false;

    // 按语言提取变量声明符
    if (this.language === 'typescript' || this.language === 'javascript' ||
        this.language === 'tsx' || this.language === 'jsx') {
      // 处理 lexical_declaration 和 variable_declaration
      // 这些包含一个或多个 variable_declarator 子节点
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'variable_declarator') {
          const nameNode = getChildByField(child, 'name');
          const valueNode = getChildByField(child, 'value');

          if (nameNode) {
            // 跳过解构模式（如 Svelte 中的 `let { x, y } = $props()`）
            // 这些会产生丑陋的多行名称，如 "{ class: className }"
            if (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern') {
              continue;
            }
            const name = getNodeText(nameNode, this.source);
            // 箭头函数/函数表达式：提取为 function 而非 variable
            if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
              this.extractFunction(valueNode);
              continue;
            }

            // 捕获初始化器前 100 个字符作为上下文（存储在 signature 中以便搜索）
            const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
            const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

            const varNode = this.createNode(kind, name, child, {
              docstring,
              signature: initSignature,
              isExported,
            });

            // 提取类型注解引用（如 const x: ITextModel = ...）
            if (varNode) {
              this.extractVariableTypeAnnotation(child, varNode.id);
            }

            // 导出 const 对象-函数——将每个函数值属性提取为以键命名的函数
            // 并游走其 body 以捕获其调用。两种形状，均基于 AST 形状（不依赖库名）：
            //   `export const actions = { default: async () => {} }` — 对象是
            //     直接值（SvelteKit form actions / handler 映射 / 路由表）。
            //   `export const useStore = create((set, get) => ({ fetchUser:
            //     async () => {} }))` — 对象由初始化器调用返回，
            //     可能经过中间件包装器（persist/devtools/immer）。
            //     通用覆盖 Zustand/Redux/Pinia/MobX store。若无此处理，
            //     store action 仅作为对象字面量属性存在——永远不是节点——
            //     因此 `node`/`callers` 对 `fetchUser` 返回"未找到"，
            //     智能体会读取 store 来重建流程。
            // 限定于导出 const 以排除 `ctx.set({...})` 类对象方法跳过故意规避的内联对象噪声。
            const objectOfFns =
              valueNode && (valueNode.type === 'object' || valueNode.type === 'object_expression')
                ? valueNode
                : valueNode?.type === 'call_expression'
                  ? this.findInitializerReturnedObject(valueNode)
                  : null;
            const extractObjectMethods = isExported && !!objectOfFns;

            // 访问初始化器 body 以获取调用——除对象字面量外
            // （其函数值属性在下方提取）以及 store 工厂调用
            // （其返回对象在下方逐方法提取——游走整个调用会重新访问这些方法箭头，
            // 并将其内层调用错误归属于文件/模块作用域）。
            if (valueNode &&
                valueNode.type !== 'object' &&
                valueNode.type !== 'object_expression' &&
                !(extractObjectMethods && valueNode.type === 'call_expression')) {
              this.visitFunctionBody(valueNode, '');
            }

            if (extractObjectMethods && objectOfFns) {
              this.extractObjectLiteralFunctions(objectOfFns);
            }
          }
        }
      }
    } else if (this.language === 'python' || this.language === 'ruby') {
      // Python/Ruby 赋值：left = right
      const left = getChildByField(node, 'left') || node.namedChild(0);
      const right = getChildByField(node, 'right') || node.namedChild(1);

      // Ruby 常量赋值（`MAX = 3`）的 LHS 是 `constant` 类型，而非 `identifier`；
      // 若无此处理，它们永远不会被提取为符号。
      if (left && (left.type === 'identifier' || left.type === 'constant')) {
        const name = getNodeText(left, this.source);
        // 如果名称以小写开头且看起来像函数调用结果则跳过
        // Python 常量通常是大写的
        const initValue = right ? getNodeText(right, this.source).slice(0, 100) : undefined;
        const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

        this.createNode(kind, name, node, {
          docstring,
          signature: initSignature,
        });
      }
    } else if (this.language === 'go') {
      // Go：var_declaration、short_var_declaration、const_declaration
      // 这些在左侧可以有多个标识符
      const specs = node.namedChildren.filter(c =>
        c.type === 'var_spec' || c.type === 'const_spec'
      );

      for (const spec of specs) {
        const nameNode = spec.namedChild(0);
        let varNode: Node | null = null;
        if (nameNode && nameNode.type === 'identifier') {
          const name = getNodeText(nameNode, this.source);
          const valueNode = spec.namedChildCount > 1 ? spec.namedChild(spec.namedChildCount - 1) : null;
          const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
          const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

          varNode = this.createNode(node.type === 'const_declaration' ? 'constant' : 'variable', name, spec, {
            docstring,
            signature: initSignature,
          });
        }
        // 游走初始化器，以便包级 `var Query Binding = queryBinding{}`
        // （实现注册表）或 `var c = pkg.New()` 中的复合字面量和调用
        // 被提取为 instantiates/calls 依赖——body 游走器仅覆盖函数内的初始化器，
        // 不覆盖这些顶层声明。
        // 将游走限定在已声明符号，以便匿名 func_literal 初始化器中的调用
        //（cobra `RunE: func(){…}` handler、goroutine 或 callback 闭包）
        // 归属于 var 而非泄漏到文件节点（读者看到的是"无调用者"），issue #693。
        const valueField = getChildByField(spec, 'value');
        if (valueField) {
          if (varNode) this.nodeStack.push(varNode.id);
          this.visitFunctionBody(valueField, varNode?.id ?? '');
          if (varNode) this.nodeStack.pop();
        }
      }

      // 处理 short_var_declaration（:=）
      if (node.type === 'short_var_declaration') {
        const left = getChildByField(node, 'left');
        const right = getChildByField(node, 'right');

        if (left) {
          // 可以是带多个标识符的 expression_list
          const identifiers = left.type === 'expression_list'
            ? left.namedChildren.filter(c => c.type === 'identifier')
            : [left];

          for (const id of identifiers) {
            const name = getNodeText(id, this.source);
            const initValue = right ? getNodeText(right, this.source).slice(0, 100) : undefined;
            const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

            this.createNode('variable', name, node, {
              docstring,
              signature: initSignature,
            });
          }
        }
      }
    } else if (this.language === 'lua' || this.language === 'luau') {
      // Lua/Luau：variable_declaration → assignment_statement → variable_list
      //      （name: identifier...）= expression_list。`local x, y = 1, 2`
      //      声明多个名称；只有普通标识符是局部变量。
      const assign = node.namedChildren.find((c) => c.type === 'assignment_statement') ?? node;
      const varList = assign.namedChildren.find((c) => c.type === 'variable_list');
      const exprList = assign.namedChildren.find((c) => c.type === 'expression_list');
      const values = exprList ? exprList.namedChildren : [];
      const names = varList ? varList.namedChildren.filter((c) => c.type === 'identifier') : [];
      names.forEach((nameNode, i) => {
        const name = getNodeText(nameNode, this.source);
        if (!name) return;
        const valueNode = values[i];
        const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
        const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;
        this.createNode(kind, name, nameNode, { docstring, signature: initSignature, isExported });
      });
    } else if (this.language === 'c') {
      // C：`declaration` 节点的名称嵌套在 `declarator` 字段内——
      // `init_declarator`（有值）或裸/指针/数组声明符（无值）；
      // `function_declarator` 是原型，而非变量。
      // 下方的通用兜底只查找**直接** identifier 子节点，而 C 从不这样用，
      // 导致文件作用域的 const/global 变量完全未被提取（因而无 impact-radius 边）。
      // 仅追踪文件作用域声明——函数 body 内的局部变量跳过
      // （同文件函数读取的 `static const` 表才是 impact graph 所需的值，
      // 而非每个 block 局部）。C 允许每条声明包含多个 declarator
      // （`int a = 1, b = 2;`），因此逐一迭代。
      if (!hasFunctionAncestor(node)) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (!child) continue;
          // 仅接受 `init_declarator`（有值）以及指针/数组声明符。
          // 裸 `identifier` 声明符故意跳过：未知的前置宏（`CURL_EXTERN`、
          // `XXH_PUBLIC_API`）会导致 tree-sitter-c 将原型 `MACRO RetType fn(args);`
          // 误解析为一个"变量"是裸返回类型标识符的声明，将 `fn(args)` 拆分为
          // 虚假表达式——为头文件中每个宏前缀原型铸造一个虚假的类型命名全局变量。
          // 这类误解析始终是裸标识符；真正的常量/表始终带有初始化器。
          // 唯一合理的损失是未初始化的标量全局变量（`static int g;`）。
          if (
            child.type !== 'init_declarator' &&
            child.type !== 'pointer_declarator' &&
            child.type !== 'array_declarator'
          ) {
            continue;
          }
          const nameNode = cDeclaratorIdentifier(child);
          if (!nameNode) continue;
          const name = getNodeText(nameNode, this.source);
          if (!name) continue;
          const valueNode =
            child.type === 'init_declarator' ? getChildByField(child, 'value') : null;
          const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
          const initSignature = initValue
            ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}`
            : undefined;
          this.createNode(kind, name, child, { docstring, signature: initSignature, isExported });
        }
      }
    } else if (this.language === 'swift') {
      // Swift 顶层属性（`let X = …` / `var Y = …`）。名称嵌套在 `pattern` 中，
      // 通用回退无法读取，导致顶层 Swift 常量/全局变量从未被提取。
      // 顶层 `let`→`constant`，`var`→`variable`；计算型属性（getter，无值）跳过。
      const { nameNode, isLet, isComputed } = swiftPropertyInfo(node, this.source);
      if (nameNode && !isComputed) {
        this.createNode(isLet ? 'constant' : 'variable', getNodeText(nameNode, this.source), node, {
          docstring,
          isExported,
        });
      }
    } else {
      // 其他语言的通用回退
      // 尝试查找标识符子节点
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'identifier' || child?.type === 'variable_declarator') {
          const name = child.type === 'identifier'
            ? getNodeText(child, this.source)
            : extractName(child, this.source, this.extractor);

          if (name && name !== '<anonymous>') {
            this.createNode(kind, name, child, {
              docstring,
              isExported,
            });
          }
        }
      }
    }
  }

  /**
   * 提取类型别名（如 TypeScript 中的 `export type X = ...`）。
   * 对于 Go 等语言，resolveTypeAliasKind 检测 type_spec 何时包裹
   * struct 或 interface 定义并创建正确的节点类型。
   * 当子节点应被跳过时返回 true（struct/interface 已处理 body 访问）。
   */
  private extractTypeAlias(node: SyntaxNode): boolean {
    if (!this.extractor) return false;

    const name = extractName(node, this.source, this.extractor);
    if (name === '<anonymous>') return false;
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    // 检查此类型别名是否实际上是 struct 或 interface 定义
    // （如 Go：`type Foo struct { ... }` 是包裹 struct_type 的 type_spec）
    const resolvedKind = this.extractor.resolveTypeAliasKind?.(node, this.source);

    if (resolvedKind === 'struct') {
      const structNode = this.createNode('struct', name, node, { docstring, isExported });
      if (!structNode) return true;
      // 访问 body 子节点以提取字段
      this.nodeStack.push(structNode.id);
      // 优先尝试 Go 风格的 'type' 字段，然后查找内层 struct 子节点（C typedef struct）
      const typeChild = getChildByField(node, 'type')
        || this.findChildByTypes(node, this.extractor.structTypes);
      if (typeChild) {
        // 提取 struct 嵌入（如 Go：`type DB struct { *Head; Queryable }`）
        this.extractInheritance(typeChild, structNode.id);
        const body = getChildByField(typeChild, this.extractor.bodyField) || typeChild;
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child) this.visitNode(child);
        }
      }
      this.nodeStack.pop();
      return true;
    }

    if (resolvedKind === 'enum') {
      const enumNode = this.createNode('enum', name, node, { docstring, isExported });
      if (!enumNode) return true;
      this.nodeStack.push(enumNode.id);
      // 查找内层 enum 类型子节点（如 C：typedef enum { ... } name）
      const innerEnum = this.findChildByTypes(node, this.extractor.enumTypes);
      if (innerEnum) {
        this.extractInheritance(innerEnum, enumNode.id);
        const body = this.extractor.resolveBody?.(innerEnum, this.extractor.bodyField)
          ?? getChildByField(innerEnum, this.extractor.bodyField);
        if (body) {
          const memberTypes = this.extractor.enumMemberTypes;
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (!child) continue;
            if (memberTypes?.includes(child.type)) {
              this.extractEnumMembers(child);
            } else {
              this.visitNode(child);
            }
          }
        }
      }
      this.nodeStack.pop();
      return true;
    }

    if (resolvedKind === 'interface') {
      const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';
      const interfaceNode = this.createNode(kind, name, node, { docstring, isExported });
      if (!interfaceNode) return true;
      // 从内层类型节点提取 interface 继承
      const typeChild = getChildByField(node, 'type');
      if (typeChild) this.extractInheritance(typeChild, interfaceNode.id);
      // Go：将 interface 的方法规格提取为 `method` 节点，以便隐式 interface 满足
      // （struct 的方法集 ⊇ interface 的方法集）和 impl 导航可以看到契约。
      // Go 没有 `implements` 关键字，因此若无 interface 的方法集则无法匹配。
      if (this.language === 'go' && typeChild) {
        this.extractGoInterfaceMethods(typeChild, interfaceNode.id);
      }
      return true;
    }

    const typeAliasNode = this.createNode('type_alias', name, node, {
      docstring,
      isExported,
    });

    // 提取别名值中的类型引用（如 `type X = ITextModel | null`）
    if (typeAliasNode && this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) {
      // 值是 `=` 之后的所有内容，通常是最后一个命名子节点
      // 在 tree-sitter TS 中：type_alias_declaration 有 name + value 子节点
      const value = getChildByField(node, 'value');
      if (value) {
        this.extractTypeRefsFromSubtree(value, typeAliasNode.id);
        // `type X = { foo: T; bar(): T }` — 将成员提升为类型别名下的
        // 一等 property/method 节点，以便 `recorder.stop()` 可以将调用边
        // 附加到 `RecorderHandle.stop`，而非由路径邻近性选取的不相关类方法（#359）。
        if (this.language === 'typescript' || this.language === 'tsx') {
          this.extractTsTypeAliasMembers(value, typeAliasNode);
          // `type List = [ Service<'name', Req, Resp>, … ]` — 将每个条目的
          // 字符串字面量名称提升为可搜索的成员（issue #634）。
          this.extractTsTupleContractNames(value, typeAliasNode);
        }
      }
    }
    return false;
  }

  /**
   * 将 Go `interface_type` body 的方法规格提取为所属 interface 的 `method` 节点
   * （如 `Core` interface 的 `Marshal`、`Unmarshal`）。
   * tree-sitter-go 将这些命名为 `method_elem`（较新）或 `method_spec`（较旧）。
   * 嵌入 interface（`ReadWriter` 内的 `Reader`）是 `type_identifier`，而非方法，
   * 留给继承提取处理。
   */
  private extractGoInterfaceMethods(interfaceType: SyntaxNode, ifaceId: string): void {
    this.nodeStack.push(ifaceId);
    for (let i = 0; i < interfaceType.namedChildCount; i++) {
      const m = interfaceType.namedChild(i);
      if (!m || (m.type !== 'method_elem' && m.type !== 'method_spec')) continue;
      const nameNode = getChildByField(m, 'name') ?? m.namedChild(0);
      if (!nameNode) continue;
      const mname = getNodeText(nameNode, this.source);
      if (mname) {
        this.createNode('method', mname, m, {
          signature: this.extractor?.getSignature?.(m, this.source),
        });
      }
    }
    this.nodeStack.pop();
  }

  /**
   * 将 TypeScript `type X = { ... }`（或其交叉类型）的成员提升为类型别名节点下的
   * `property` / `method` 节点。仅游走直接 object_type / 交叉类型操作数，
   * 以避免泛型参数中的匿名嵌套对象类型（`Promise<{ ok: true }>`）
   * 产生虚假成员。
   */
  private extractTsTypeAliasMembers(value: SyntaxNode, typeAliasNode: Node): void {
    const objectTypes: SyntaxNode[] = [];
    if (value.type === 'object_type') {
      objectTypes.push(value);
    } else if (value.type === 'intersection_type') {
      for (let i = 0; i < value.namedChildCount; i++) {
        const op = value.namedChild(i);
        if (op && op.type === 'object_type') objectTypes.push(op);
      }
    } else {
      return;
    }

    this.nodeStack.push(typeAliasNode.id);
    for (const objType of objectTypes) {
      for (let i = 0; i < objType.namedChildCount; i++) {
        const child = objType.namedChild(i);
        if (!child) continue;
        if (child.type !== 'property_signature' && child.type !== 'method_signature') continue;

        const nameNode = getChildByField(child, 'name');
        const memberName = nameNode ? getNodeText(nameNode, this.source) : '';
        if (!memberName) continue;

        // `foo: () => T` 和 `foo(): T` 在功能上是类型契约上的方法。
        // 也将带有函数类型注解的 property_signature 视为方法，
        // 以便调用点可以解析到它。
        const memberKind: NodeKind = child.type === 'method_signature'
          ? 'method'
          : this.isTsFunctionTypedProperty(child) ? 'method' : 'property';

        const docstring = getPrecedingDocstring(child, this.source);
        const signature = getNodeText(child, this.source);
        this.createNode(memberKind, memberName, child, {
          docstring,
          signature,
          qualifiedName: `${typeAliasNode.name}::${memberName}`,
        });

        // 从类型别名向成员签名中命名的类型发出 `references` 边，
        // 与 #432 中添加的 interface 成员行为一致。
        // 将引用附加到类型别名父节点（与 interface property_signature 处理一致）。
        this.extractTypeAnnotations(child, typeAliasNode.id);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * 将以泛型实例化元组形式编写的 TypeScript 服务/契约注册表的
   * 字符串字面量"名称"提升为可搜索成员：
   *
   *   type MyServiceList = [
   *     Service<'query_apply_record', Req, Resp>,
   *     Service<'apply_confirm', Req, Resp>,
   *   ];
   *
   * 每个 `Service<'name', …>` 用字符串字面量名称标记条目，动态工厂
   * （`createService<MyServiceList>()`）将其转为可调用属性
   * （`api.query_apply_record(…)`）。静态提取本来永远看不到该名称——
   * 它是类型参数，不是声明——因此 `synapse query query_apply_record`
   * 返回空（issue #634）。我们将每个名称作为类型别名下的 `method` 节点发出
   * （qualifiedName `MyServiceList::query_apply_record`），使其可搜索且可作为符号解析。
   * （通过代理的调用 `api.query_apply_record(…)` 仍解析到导入的 `api` 绑定——
   * 接收者类型未知——因此这修复的是可发现性，而非每方法调用边。）
   *
   * 范围故意收窄以避免噪声：仅限直接作为 `generic_type` 类型参数的字符串字面量，
   * 且该 `generic_type` 本身是 `tuple_type` 的直接元素。
   * 这排除实用类型（`Pick`/`Omit`/`Record` 从不写成元组）和嵌套更深的字符串参数
   * （`Service<'a', Pick<U, 'id'>>` 只产出 `a`，不产出 `id`）。
   * 名称必须是有效标识符，这也排除了路由路径/任意字符串。
   */
  private extractTsTupleContractNames(value: SyntaxNode, typeAliasNode: Node): void {
    const tuples: SyntaxNode[] = [];
    const collectTuples = (n: SyntaxNode, depth: number): void => {
      if (depth > 6) return; // a type expression is shallow; cap defensively
      if (n.type === 'tuple_type') tuples.push(n);
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) collectTuples(c, depth + 1);
      }
    };
    collectTuples(value, 0);
    if (tuples.length === 0) return;

    this.nodeStack.push(typeAliasNode.id);
    for (const tuple of tuples) {
      for (let i = 0; i < tuple.namedChildCount; i++) {
        const entry = tuple.namedChild(i);
        if (!entry || entry.type !== 'generic_type') continue;
        const typeArgs = getChildByField(entry, 'type_arguments');
        if (!typeArgs) continue;
        for (let j = 0; j < typeArgs.namedChildCount; j++) {
          const arg = typeArgs.namedChild(j);
          if (!arg || arg.type !== 'literal_type') continue;
          // literal_type 包裹实际字面量；只有字符串才是名称。
          const strNode = arg.namedChild(0);
          if (!strNode || strNode.type !== 'string') continue;
          const name = getNodeText(strNode, this.source)
            .trim()
            .replace(/^['"`]/, '')
            .replace(/['"`]$/, '');
          if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
          const signature = getNodeText(entry, this.source).replace(/\s+/g, ' ').trim().slice(0, 120);
          this.createNode('method', name, entry, {
            signature,
            qualifiedName: `${typeAliasNode.name}::${name}`,
          });
        }
      }
    }
    this.nodeStack.pop();
  }

  /**
   * `foo: () => T` → 其 type_annotation 包含 `function_type` 的 property_signature。
   * 将其视为方法形状的契约成员，因为调用点 `obj.foo()` 与 `bar(): T` 语义相同。
   */
  private isTsFunctionTypedProperty(propertySignature: SyntaxNode): boolean {
    const typeAnno = getChildByField(propertySignature, 'type');
    if (!typeAnno) return false;
    for (let i = 0; i < typeAnno.namedChildCount; i++) {
      const inner = typeAnno.namedChild(i);
      if (inner && inner.type === 'function_type') return true;
    }
    return false;
  }

  // extractExportedVariables 已移除——游走器现在下降到 export_statement 子节点，
  // 内层声明的专用提取器（extractVariable、extractFunction、extractClass 等）
  // 通过语言提取器 isExported 谓词中的父节点游走处理带有 isExported=true 的符号。

  /**
   * 提取 import
   *
   * 创建 import 节点，将完整 import 语句存储在 signature 中以提升可搜索性。
   * 同时为解析目的创建未解析引用。
   */
  private extractImport(node: SyntaxNode): void {
    if (!this.extractor) return;

    const importText = getNodeText(node, this.source).trim();

    // 首先尝试语言特定 hook
    if (this.extractor.extractImport) {
      const info = this.extractor.extractImport(node, this.source);
      if (info) {
        this.createNode('import', info.moduleName, node, {
          signature: info.signature,
        });
        // 除非 hook 已处理，否则创建未解析引用
        if (!info.handledRefs && info.moduleName && this.nodeStack.length > 0) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) {
            this.unresolvedReferences.push({
              fromNodeId: parentId,
              referenceName: info.moduleName,
              referenceKind: 'imports',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
        // 将每个导入绑定链接到其定义，以便导入但未调用/未使用类型的符号
        // 仍然记录跨文件依赖（仅限 TS/JS）。
        if (
          this.language === 'typescript' || this.language === 'tsx' ||
          this.language === 'javascript' || this.language === 'jsx'
        ) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitImportBindingRefs(node, parentId);
        }
        // Python `from module import X, Y` —— 将每个导入名称链接到其定义
        // （覆盖 `__init__.py` 重导出桶，即仅包含 `from .sub import X` 的文件）。
        // 与 TS 相同的召回缺口：以非调用位置导入并使用的名称不会产生依赖边。
        if (this.language === 'python' && node.type === 'import_from_statement') {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitPyFromImportRefs(node, parentId);
        }
        // Rust `use crate::m::Item;` / `pub use self::sub::Item;` —— 将每个
        // 导入叶节点链接到其定义。涵盖 `pub use` 重导出枢纽
        // （重导出子模块项的 `mod.rs`，如 tokio 的 `fs/mod.rs`）
        // 以及以非调用/非类型位置导入并使用的项。
        if (this.language === 'rust' && node.type === 'use_declaration') {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitRustUseBindingRefs(node, parentId);
        }
        // PHP `use Foo\Bar\Baz;` — 链接到命名空间限定的定义，
        // 以便导入但通过 DI 注入的契约（Laravel 模式）记录跨文件依赖。
        // 分组 import 在自己的分支中处理。
        if (this.language === 'php' && node.type === 'namespace_use_declaration') {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitPhpUseRefs(node, parentId);
        }
        // Ruby `require "lib/foo"` / `require_relative "../foo"` — 解析到
        // 被 require 的文件，以便仅通过 `require` 引入的文件（配置加载的组件、
        // 不自动加载的 gem）记录跨文件依赖。
        if (this.language === 'ruby' && node.type === 'call') {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) this.emitRubyRequireRefs(node, parentId);
        }
        return;
      }
      // hook 返回 null——仅回退到多 import 内联处理器
      // （hook 返回 null 表示"我不处理此情况"，针对多 import 场景，
      // 而非"使用通用回退"——hook 已经拒绝了）
    }

    // 创建多个节点的多 import 情况（不能用单返回 hook 表达）

    // Python import_statement：import os, sys（每个模块创建一个 import）
    if (this.language === 'python' && node.type === 'import_statement') {
      const importParentId = this.nodeStack[this.nodeStack.length - 1];
      // 内部模块的裸 `import a.b.c`（标准 Django
      // `AppConfig.ready(): import myapp.signals` 注册模式，以及任何用于副作用的
      // `import pkg.mod`）之前没有到模块文件的边——只有 `from x import y` 被链接。
      // 推送 `imports` 引用（类似 Go），以便解析器将点分路径映射到其文件。
      // stdlib/外部模块自然不会解析（仓库中没有 `os.py` 文件节点）。
      const pushModuleRef = (dotted: SyntaxNode): void => {
        if (!importParentId) return;
        this.unresolvedReferences.push({
          fromNodeId: importParentId,
          referenceName: getNodeText(dotted, this.source),
          referenceKind: 'imports',
          line: dotted.startPosition.row + 1,
          column: dotted.startPosition.column,
        });
      };
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'dotted_name') {
          this.createNode('import', getNodeText(child, this.source), node, {
            signature: importText,
          });
          pushModuleRef(child);
        } else if (child?.type === 'aliased_import') {
          const dottedName = child.namedChildren.find(c => c.type === 'dotted_name');
          if (dottedName) {
            this.createNode('import', getNodeText(dottedName, this.source), node, {
              signature: importText,
            });
            pushModuleRef(dottedName);
          }
        }
      }
      return;
    }

    // Go import：单个或分组（每个 spec 创建一个 import）
    if (this.language === 'go') {
      const parentId = this.nodeStack.length > 0 ? this.nodeStack[this.nodeStack.length - 1] : null;
      const extractFromSpec = (spec: SyntaxNode): void => {
        const stringLiteral = spec.namedChildren.find(c => c.type === 'interpreted_string_literal');
        if (stringLiteral) {
          const importPath = getNodeText(stringLiteral, this.source).replace(/['"]/g, '');
          if (importPath) {
            this.createNode('import', importPath, spec, {
              signature: getNodeText(spec, this.source).trim(),
            });
            // 创建未解析引用，以便解析器可以创建 imports 边
            if (parentId) {
              this.unresolvedReferences.push({
                fromNodeId: parentId,
                referenceName: importPath,
                referenceKind: 'imports',
                line: spec.startPosition.row + 1,
                column: spec.startPosition.column,
              });
            }
          }
        }
      };

      const importSpecList = node.namedChildren.find(c => c.type === 'import_spec_list');
      if (importSpecList) {
        for (const spec of importSpecList.namedChildren.filter(c => c.type === 'import_spec')) {
          extractFromSpec(spec);
        }
      } else {
        const importSpec = node.namedChildren.find(c => c.type === 'import_spec');
        if (importSpec) {
          extractFromSpec(importSpec);
        }
      }
      return;
    }

    // PHP 分组 import：use X\{A, B}（每个条目创建一个 import）
    if (this.language === 'php') {
      const namespacePrefix = node.namedChildren.find(c => c.type === 'namespace_name');
      const useGroup = node.namedChildren.find(c => c.type === 'namespace_use_group');
      if (namespacePrefix && useGroup) {
        const prefix = getNodeText(namespacePrefix, this.source);
        const useClauses = useGroup.namedChildren.filter((c: SyntaxNode) =>
          c.type === 'namespace_use_group_clause' || c.type === 'namespace_use_clause'
        );
        for (const clause of useClauses) {
          const nsName = clause.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
          const name = nsName
            ? nsName.namedChildren.find((c: SyntaxNode) => c.type === 'name')
            : clause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
          if (name) {
            const fullPath = `${prefix}\\${getNodeText(name, this.source)}`;
            this.createNode('import', fullPath, node, {
              signature: importText,
            });
            const parentId = this.nodeStack[this.nodeStack.length - 1];
            if (parentId) this.pushPhpUseRef(fullPath, parentId, node);
          }
        }
        return;
      }
    }

    // 若 hook 存在但返回 null，则表示故意拒绝了该节点——不创建兜底
    if (this.extractor.extractImport) return;

    // 无 hook 语言的通用兜底
    this.createNode('import', importText, node, {
      signature: importText,
    });
  }

  /**
   * 为每个命名/默认 import 绑定（TS/JS 家族）发出一个 `imports` 引用，
   * 归属于文件节点——以便解析器将每个导入符号链接到定义它的文件。
   *
   * 导入符号是一种依赖关系，但提取仅为调用、实例化、类型注解和继承
   * 发出引用。导入后仅重导出（`export { X } from './x'`）、
   * 放入注册表数组（`[expressResolver, …]`）、作为参数传递
   * 或在 JSX 中使用的符号，完全不会产生跨文件边——
   * 导致提供方文件显示假的"0 个依赖方"且对 blast-radius / `affected` 不可见。
   * 解析器将本地名称（支持别名）映射到提供方的定义，并创建跨文件 `imports` 边；
   * `getFileDependents` 会捡取它，而 `getImpactRadius` 将其保留为有界叶节点
   * （导入方文件节点）。
   *
   * 命名空间 import（`import * as NS`）绑定整个模块：`NS.member` 调用
   * 会自行解析，但仅通过值成员读取使用 NS（`NS.SOME_CONST`）的命名空间
   * 不会留下任何边——因此我们也发出命名空间本地名称，
   * 解析器将其链接到模块 FILE 作为依赖后备。
   */
  private emitImportBindingRefs(node: SyntaxNode, fromNodeId: string): void {
    const clause = node.namedChildren.find((c) => c.type === 'import_clause');
    if (!clause) return; // 副作用 import（`import './x'`）——无绑定

    const pushRef = (nameNode: SyntaxNode | null | undefined): void => {
      if (!nameNode) return;
      const name = getNodeText(nameNode, this.source);
      if (!name) return;
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: name,
        referenceKind: 'imports',
        line: nameNode.startPosition.row + 1,
        column: nameNode.startPosition.column,
      });
    };

    for (const child of clause.namedChildren) {
      if (child.type === 'identifier') {
        // 默认 import：`import Foo from './x'`
        pushRef(child);
      } else if (child.type === 'named_imports') {
        // `import { A, B as C } from './x'` — 链接本地名称（别名优先）
        for (const spec of child.namedChildren) {
          if (spec.type !== 'import_specifier') continue;
          pushRef(getChildByField(spec, 'alias') ?? getChildByField(spec, 'name') ?? spec.namedChild(0));
        }
      } else if (child.type === 'namespace_import') {
        // `import * as NS from './x'` — 发出 NS，以便模块 import 后备
        // 即使 NS 仅通过值成员读取使用也能记录文件依赖。
        pushRef(child.namedChildren.find((c) => c.type === 'identifier') ?? child.namedChild(0));
      }
    }
  }

  /**
   * 为 `export { A, B as C } from './y'` 语句的每个重导出绑定
   * 发出一个 `imports` 引用，归属于文件节点——
   * 以便从另一模块重导出的 barrel 记录对它的依赖。
   *
   * 链接源端名称（`A`，`name` 字段——而非本地别名 `C`），
   * 因为那是源模块定义的内容。`export * from './y'`
   * 没有命名绑定可归属，`export { default as X }` 无法按名称匹配，
   * 因此两者均跳过。
   */
  private emitReExportRefs(node: SyntaxNode, fromNodeId: string): void {
    const clause = node.namedChildren.find((c) => c.type === 'export_clause');
    if (!clause) return; // `export * from './y'` — 无命名绑定
    for (const spec of clause.namedChildren) {
      if (spec.type !== 'export_specifier') continue;
      const nameNode = getChildByField(spec, 'name') ?? spec.namedChild(0);
      if (!nameNode) continue;
      const name = getNodeText(nameNode, this.source);
      if (!name || name === 'default') continue;
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: name,
        referenceKind: 'imports',
        line: nameNode.startPosition.row + 1,
        column: nameNode.startPosition.column,
      });
    }
  }

  /**
   * 为 Rust `use` 声明的每个绑定发出一个 `imports` 引用——
   * `use crate::m::Item`、`use crate::m::{A, B as C}`、`pub use self::sub::Item`。
   * 发出完整路径（如 `self::sub::Item`，而非仅 `Item`），以便解析器
   * 将模块前缀解析为文件并在那里找到叶符号——
   * 消歧常见名称重导出（`pub use self::read::read`，其中叶 `read`
   * 与许多同名符号冲突）。当路径无法解析时，回退到对叶节点的名称匹配。
   * `use ...::*` 没有叶绑定。
   */
  private emitRustUseBindingRefs(node: SyntaxNode, fromNodeId: string): void {
    const paths: { text: string; node: SyntaxNode }[] = [];
    const join = (prefix: string, seg: string): string => (prefix ? `${prefix}::${seg}` : seg);
    const collect = (n: SyntaxNode, prefix: string): void => {
      switch (n.type) {
        case 'identifier':
          paths.push({ text: join(prefix, getNodeText(n, this.source)), node: n });
          break;
        case 'scoped_identifier': {
          // 完整的作用域路径（`a::b::C`）；与任何外层组前缀合并。
          const full = getNodeText(n, this.source).trim();
          paths.push({ text: prefix ? `${prefix}::${full}` : full, node: n });
          break;
        }
        case 'scoped_use_list': {
          // `path::{ ... }` — 组的路径成为每个条目的前缀。
          const pathNode = getChildByField(n, 'path');
          const seg = pathNode ? getNodeText(pathNode, this.source).trim() : '';
          const newPrefix = seg ? join(prefix, seg) : prefix;
          const list = getChildByField(n, 'list') ?? n.namedChildren.find((c) => c.type === 'use_list');
          if (list) collect(list, newPrefix);
          break;
        }
        case 'use_list':
          for (let i = 0; i < n.namedChildCount; i++) {
            const c = n.namedChild(i);
            if (c) collect(c, prefix);
          }
          break;
        case 'use_as_clause': {
          // `Path as Alias` → 链接源路径（定义），而非别名。
          const p = getChildByField(n, 'path') ?? n.namedChild(0);
          if (p) collect(p, prefix);
          break;
        }
        // use_wildcard → no specific binding to link.
      }
    };
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c) collect(c, '');
    }
    for (const p of paths) {
      // 叶节点必须是真实名称（跳过仅包含 `self`/`super`/`crate` 的路径）。
      const leaf = p.text.split('::').pop();
      if (!leaf || leaf === 'self' || leaf === 'super' || leaf === 'crate' || leaf === '*') continue;
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: p.text,
        referenceKind: 'imports',
        line: p.node.startPosition.row + 1,
        column: p.node.startPosition.column,
      });
    }
  }

  /**
   * 为单个 PHP `use Foo\Bar\Baz;` 发出 `imports` 引用
   * （分组 import `use Foo\{A, B}` 在创建各条目节点时处理）。
   * 引用指向类存储的命名空间限定 `Foo\Bar::Baz` 形式（见 PHP `namespace` 捕获），
   * 因此解析到正确的定义——Laravel 在各命名空间中有许多同名契约
   * （`Factory`、`Dispatcher`、`Guard`），裸名称匹配无法消歧。
   */
  private emitPhpUseRefs(node: SyntaxNode, fromNodeId: string): void {
    const clause = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_use_clause');
    if (!clause) return;
    const qn = clause.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name')
      ?? clause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
    if (qn) this.pushPhpUseRef(getNodeText(qn, this.source), fromNodeId, node);
  }

  /**
   * Ruby `require`/`require_relative` → 向被 require 的 FILE 发出 `imports` 引用。
   * `require "sidekiq/fetch"` 是加载路径相对的（通过 {@link matchByFilePath} 按文件路径后缀匹配）；
   * `require_relative "../foo"` 相对于此文件的目录解析。
   * 裸 gem/stdlib require（`require "json"`，无斜杠）跳过——它们是外部的。
   * 路径形式（含 `/` + `.rb`）使引用解析到文件节点，
   * 以便仅通过 `require` 引入的文件——而非通过解析的常量/调用——
   * 仍然记录跨文件依赖。
   */
  private emitRubyRequireRefs(node: SyntaxNode, fromNodeId: string): void {
    const method = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    const mname = method ? getNodeText(method, this.source) : '';
    if (mname !== 'require' && mname !== 'require_relative') return;
    const argList = node.namedChildren.find((c: SyntaxNode) => c.type === 'argument_list');
    const str = argList?.namedChildren.find((c: SyntaxNode) => c.type === 'string');
    const content = str?.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
    if (!content) return;
    const req = getNodeText(content, this.source).trim();
    if (!req) return;

    let refPath: string;
    if (mname === 'require_relative') {
      const slash = this.filePath.lastIndexOf('/');
      const dir = slash >= 0 ? this.filePath.slice(0, slash) : '';
      refPath = path.posix.normalize(dir ? `${dir}/${req}` : req);
    } else {
      refPath = req; // load-path require — suffix-matched against the file path
    }
    if (!refPath.includes('/')) return; // 裸 gem/stdlib require——外部
    if (!refPath.endsWith('.rb')) refPath += '.rb';
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName: refPath,
      referenceKind: 'imports',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  /** 将 PHP FQN `Foo\Bar\Baz` 转换为存储形式 `Foo\Bar::Baz` 并发出 `imports` 引用。 */
  private pushPhpUseRef(fqn: string, fromNodeId: string, node: SyntaxNode): void {
    const clean = fqn.replace(/^\\/, '');
    const lastSep = clean.lastIndexOf('\\');
    if (lastSep < 0) return; // 全局命名空间类——已通过简单名称匹配
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName: `${clean.slice(0, lastSep)}::${clean.slice(lastSep + 1)}`,
      referenceKind: 'imports',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  /**
   * 为 Python `from module import A, B as C` 语句中每个导入的名称
   * 发出一个 `imports` 引用，归属于文件节点——
   * 以便解析器将每个导入名称链接到定义它的模块。
   *
   * 与 TS 的召回缺口相同：提取仅为调用、实例化和继承发出引用，
   * 因此导入后用于非调用位置的名称（列表/字典字面量、默认参数、
   * decorator 目标，或仅通过 `__init__.py` barrel 重导出）
   * 不会产生跨文件边——提供方模块显示假的"0 个依赖方"。
   * 链接本地名称（有别名时优先别名，因为这是解析器的 import 映射键）；
   * `from module import *` 没有名称可归属。
   */
  private emitPyFromImportRefs(node: SyntaxNode, fromNodeId: string): void {
    const moduleNameNode = getChildByField(node, 'module_name');
    for (const child of node.namedChildren) {
      // 跳过 `from <module>` 部分本身和 `import *`。
      if (moduleNameNode &&
          child.startIndex === moduleNameNode.startIndex &&
          child.endIndex === moduleNameNode.endIndex) continue;
      if (child.type === 'wildcard_import') continue;

      let nameNode: SyntaxNode | null | undefined = null;
      if (child.type === 'aliased_import') {
        nameNode = getChildByField(child, 'alias') ?? getChildByField(child, 'name') ?? child.namedChild(0);
      } else if (child.type === 'dotted_name') {
        nameNode = child;
      }
      if (!nameNode) continue;

      const raw = getNodeText(nameNode, this.source);
      // 导入名称是简单标识符；防御性地取最后一段。
      const local = raw.includes('.') ? raw.split('.').pop()! : raw;
      if (!local) continue;
      this.unresolvedReferences.push({
        fromNodeId,
        referenceName: local,
        referenceKind: 'imports',
        line: nameNode.startPosition.row + 1,
        column: nameNode.startPosition.column,
      });
    }
  }

  /**
   * 提取函数调用
   */
  private extractCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;

    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    // 获取被调用的函数/方法
    let calleeName = '';

    // Java/Kotlin method_invocation 有 'object' + 'name' 字段而非 'function'
    // PHP member_call_expression 有 'object' + 'name'，scoped_call_expression 有 'scope' + 'name'
    const nameField = getChildByField(node, 'name');
    const objectField = getChildByField(node, 'object') || getChildByField(node, 'scope');

    if (nameField && objectField && (node.type === 'method_invocation' || node.type === 'member_call_expression' || node.type === 'scoped_call_expression')) {
      // 带显式接收者的方法调用：receiver.method() / $receiver->method() / ClassName::method()
      const methodName = getNodeText(nameField, this.source);
      // Java `this.userbo.toLogin2()` 解析为 method_invocation(object=field_access(this, userbo))。
      // 若不解包，receiverName 将是 `this.userbo`，名称匹配器的
      // 单点接收者正则会失败。提取 `this.` 之后的直接字段，
      // 使接收者为字段名（`userbo`），解析器随后可在封闭类的字段声明中查找它。
      // PHP 静态工厂流式链：`Cls::for($x)->method()` — 接收者本身是静态调用，
      // 因此解析必须从 `Cls::for` 的返回类型（`: self` / `: static` / `: Type`）
      // 推断方法的类，#608（镜像 #645 的 C++ 链修复）。
      // 编码为 `<Cls::factory>().<method>`；`().` 标记让 PHP 解析器拆分它。
      // 接收者文本（`Cls::for('x')`）携带参数，若无此处理则降级为不可解析字符串，
      // 调用边被丢弃。
      if (methodName && this.language === 'php' && objectField.type === 'scoped_call_expression') {
        const innerScope = getChildByField(objectField, 'scope');
        const innerName = getChildByField(objectField, 'name');
        if (innerScope && innerName) {
          calleeName = `${getNodeText(innerScope, this.source)}::${getNodeText(innerName, this.source)}().${methodName}`;
        } else {
          calleeName = methodName;
        }
        if (calleeName) {
          this.unresolvedReferences.push({
            fromNodeId: callerId,
            referenceName: calleeName,
            referenceKind: 'calls',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
        return;
      }

      // Java 静态工厂/流式链：`Foo.getInstance().bar()` — 接收者本身是方法调用，
      // 因此解析必须从 `Foo.getInstance` 的返回类型（其声明返回类型）
      // 推断 bar 的类，即 #645/#608 机制。
      // 编码为 `<inner-receiver>.<inner-method>().<method>`；
      // `().` 标记让 Java 链解析器拆分它，
      // 规范化为空括号可丢弃工厂参数（`Foo.create(cfg).bar()`），
      // 否则 `(cfg)` 会留在接收者文本中并破坏拆分。
      if (
        methodName &&
        this.language === 'java' &&
        objectField.type === 'method_invocation'
      ) {
        const innerObj = getChildByField(objectField, 'object');
        const innerName = getChildByField(objectField, 'name');
        if (innerObj && innerName) {
          calleeName = `${getNodeText(innerObj, this.source)}.${getNodeText(innerName, this.source)}().${methodName}`;
          this.unresolvedReferences.push({
            fromNodeId: callerId,
            referenceName: calleeName,
            referenceKind: 'calls',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
          return;
        }
      }

      let receiverName: string;
      if (objectField.type === 'field_access') {
        const inner = getChildByField(objectField, 'object');
        const fld = getChildByField(objectField, 'field');
        if (inner && fld && (inner.type === 'this' || inner.type === 'this_expression')) {
          receiverName = getNodeText(fld, this.source);
        } else {
          receiverName = getNodeText(objectField, this.source);
        }
      } else {
        receiverName = getNodeText(objectField, this.source);
      }
      // 去除变量名中的 PHP $ 前缀
      receiverName = receiverName.replace(/^\$/, '');

      if (methodName) {
        // 跳过 self/this/parent/static 接收者——它们不助于解析
        const SKIP_RECEIVERS = new Set(['self', 'this', 'cls', 'super', 'parent', 'static']);
        if (SKIP_RECEIVERS.has(receiverName)) {
          calleeName = methodName;
        } else {
          calleeName = `${receiverName}.${methodName}`;
        }
      }
    } else if (node.type === 'message_expression') {
      // ObjC 消息表达式每个选择器关键字发出一个 `method` 字段子节点：
      // `[obj a:1 b:2 c:3]` 有三个 `method=identifier` 兄弟节点。
      // 用 `:` 连接它们重建完整选择器，并与 ObjC method_definition 提取器
      // 产生的多部分选择器名称匹配（languages/objc.ts 中的 `extractObjcMethodName`）。
      // 若无此连接，多关键字调用点只发出第一个关键字，
      // 永远无法解析到其目标方法（如 `GET:parameters:headers:...`
      // 尽管明显被调用，却有零个 caller）。
      const methodKeywords: string[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        if (node.fieldNameForNamedChild(i) === 'method') {
          const kw = node.namedChild(i);
          if (kw) methodKeywords.push(getNodeText(kw, this.source));
        }
      }
      if (methodKeywords.length > 0) {
        // 选择器关键字在有参数时带 `:`。单个关键字可以是一元的
        // （`[c reset]` → `reset`）或接受一个参数
        // （`[c storeImage:k]` → `storeImage:`）——通过消息是否有 `:` token 区分。
        // 若无此处理，每个单参数消息（最常见形式：`addObject:`、`storeImage:`……）
        // 命名时不带冒号，永远无法匹配其 `storeImage:` 方法。
        let hasColon = false;
        for (let i = 0; i < node.childCount; i++) {
          if (node.child(i)?.type === ':') { hasColon = true; break; }
        }
        const methodName: string = hasColon
          ? methodKeywords.map((k) => `${k}:`).join('')
          : (methodKeywords[0] as string);
        const receiverField = getChildByField(node, 'receiver');
        const SKIP_RECEIVERS = new Set(['self', 'super']);
        if (receiverField && receiverField.type !== 'message_expression') {
          const receiverName = getNodeText(receiverField, this.source);
          if (receiverName && !SKIP_RECEIVERS.has(receiverName)) {
            calleeName = `${receiverName}.${methodName}`;
            // 类消息接收者（`[SDImageCache alloc]`、`[SDImageCache sharedCache]`）
            // 是大写的类名。调用会解析方法（`alloc`/`sharedCache`），但类本身——
            // 其 @interface 位于头文件中——否则永远不会被引用。
            // 向其发出 `references` 边，使仅通过类消息使用的类
            // （alloc/init、singleton、factory）及其头文件记录依赖方。
            if (/^[A-Z][A-Za-z0-9_]*$/.test(receiverName)) {
              this.unresolvedReferences.push({
                fromNodeId: callerId,
                referenceName: receiverName,
                referenceKind: 'references',
                line: receiverField.startPosition.row + 1,
                column: receiverField.startPosition.column,
              });
            }
          } else {
            calleeName = methodName;
          }
        } else if (receiverField && receiverField.type === 'message_expression' && /^\w+$/.test(methodName)) {
          // 链式消息发送 `[[Foo create] doIt]` —— 接收者本身是类消息。
          // 恢复内层 `Class.selector` 并编码为 `Class.selector().doIt`，
          // 以便解析器从 `Class.selector` 的返回值推断 doIt 的类（#645/#608）。
          // 仅针对 CLASS 工厂链（大写内层接收者）；
          // 需要单选择器的外层方法，因为链解析器的方法部分为 `\w+`（无 `:`）。
          // 实例链（`[[obj foo] bar]`，小写内层）保持裸名。
          const innerRecv = getChildByField(receiverField, 'receiver');
          const innerRecvName = innerRecv ? getNodeText(innerRecv, this.source) : '';
          if (innerRecv?.type === 'identifier' && /^[A-Z]/.test(innerRecvName)) {
            const innerKw: string[] = [];
            for (let i = 0; i < receiverField.namedChildCount; i++) {
              if (receiverField.fieldNameForNamedChild(i) === 'method') {
                const kw = receiverField.namedChild(i);
                if (kw) innerKw.push(getNodeText(kw, this.source));
              }
            }
            let innerColon = false;
            for (let i = 0; i < receiverField.childCount; i++) {
              if (receiverField.child(i)?.type === ':') { innerColon = true; break; }
            }
            const innerSelector = innerColon ? innerKw.map((k) => `${k}:`).join('') : innerKw[0];
            calleeName = innerSelector ? `${innerRecvName}.${innerSelector}().${methodName}` : methodName;
          } else {
            calleeName = methodName;
          }
        } else {
          calleeName = methodName;
        }
      }
    } else {
      const func = getChildByField(node, 'function') || node.namedChild(0);

      if (func) {
        if (func.type === 'member_expression' || func.type === 'attribute' || func.type === 'selector_expression' || func.type === 'navigation_expression' || func.type === 'field_expression') {
          // 方法调用：obj.method() 或 obj.field.method()
          // Go 使用带 'field' 的 selector_expression，JS/TS 使用带 'property' 的 member_expression
          // Kotlin 使用带 navigation_suffix > simple_identifier 的 navigation_expression
          // C/C++ 使用 field_expression 同时表示 `obj.method()` 和 `ptr->method()`
          let property = getChildByField(func, 'property') || getChildByField(func, 'field');
          if (!property) {
            const child1 = func.namedChild(1);
            // Kotlin：navigation_suffix 包裹方法名——从中提取 simple_identifier
            if (child1?.type === 'navigation_suffix') {
              property = child1.namedChildren.find((c: SyntaxNode) => c.type === 'simple_identifier') ?? child1;
            } else {
              property = child1;
            }
          }
          if (property) {
            const methodName = getNodeText(property, this.source);
            // 在限定解析中包含接收者名称（如 console.print → "console.print"）
            // 帮助解析器区分方法调用和裸函数调用
            // （如 Python 的 console.print() vs 内置 print()）
            // 跳过 self/this/cls——它们不助于解析
            const receiver =
              getChildByField(func, 'object') ||
              getChildByField(func, 'operand') ||
              getChildByField(func, 'argument') ||
              func.namedChild(0);
            const SKIP_RECEIVERS = new Set(['self', 'this', 'cls', 'super']);
            if (receiver && (receiver.type === 'identifier' || receiver.type === 'simple_identifier' || receiver.type === 'field_identifier')) {
              const receiverName = getNodeText(receiver, this.source);
              if (!SKIP_RECEIVERS.has(receiverName)) {
                calleeName = `${receiverName}.${methodName}`;
              } else {
                calleeName = methodName;
              }
            } else if (
              (this.language === 'cpp' ||
                this.language === 'c' ||
                this.language === 'kotlin' ||
                this.language === 'swift' ||
                this.language === 'rust' ||
                this.language === 'go' ||
                this.language === 'scala') &&
              receiver &&
              receiver.type === 'call_expression'
            ) {
              // 接收者本身是调用——`Foo::instance().bar()`、
              // `openSession()->run()`、`mgr.view().render()`（C/C++）、
              // `Foo.getInstance().bar()`（Kotlin）/ `Foo.make().draw()`（Swift）、
              // `Foo::new().bar()`（Rust）或 `New().Method()`（Go）。
              // 保留内层调用以便解析从内层调用的返回类型推断 bar() 的类
              // （#645/#608）。编码为 `<innerCallee>().<method>`；`().`
              // 标记在普通引用中从不出现，因此解析器可以检测并拆分它。
              // 其他语言保持裸名称行为。
              let innerCallee: string;
              let reencode: boolean;
              if (this.language === 'kotlin' || this.language === 'swift') {
                // tree-sitter-kotlin/swift 将内层被调用者暴露为
                // call_expression 的第一个命名子节点（navigation_expression
                // `Foo.getInstance`，或自由/构造函数调用的裸标识符）。
                const innerNav = receiver.namedChild(0);
                innerCallee = innerNav ? getNodeText(innerNav, this.source).replace(/\s+/g, '') : '';
                // 仅对 CLASS / companion-factory / constructor 链重新编码，
                // 其接收者链以大写类型开头（`Foo.getInstance().bar()`、`Foo().bar()`）。
                // 实例链（`list.filter{}.map{}`）的接收者类型是小写，我们无法在此处恢复——
                // 重新编码只会丢弃边（无链解析，无裸名称回退），在流式代码库中造成召回回退。
                // 将这些留给裸名称路径。
                reencode = /^[A-Z]/.test(innerCallee);
              } else {
                const innerFn = getChildByField(receiver, 'function');
                innerCallee = innerFn
                  ? getNodeText(innerFn, this.source).replace(/->/g, '.').replace(/\s+/g, '')
                  : '';
                // Rust：仅对关联函数链（`Foo::new().bar()`）重新编码，
                // 其内层被调用者是路径/`scoped_identifier`。
                // Go：仅对裸包级工厂链（`New().Method()`）重新编码，
                // 其内层被调用者是 `identifier`。实例链
                // （Rust `x.foo().bar()`、Go `obj.Method().Other()`）保持裸名称——
                // 解析器无法恢复变量的类型，重新编码只会丢弃边。C/C++ 重新编码任何内层。
                if (this.language === 'rust') reencode = innerFn?.type === 'scoped_identifier';
                else if (this.language === 'go') reencode = innerFn?.type === 'identifier';
                // Scala：仅对 companion-factory / case-class-apply 链重新编码，
                // 其接收者链以大写类型开头（`Foo.create().bar()`、`Foo(args).bar()`）。
                // 实例链（`list.map().filter()`）有小写接收者，类型无法恢复——留给裸名称。
                else if (this.language === 'scala') reencode = /^[A-Z]/.test(innerCallee);
                else reencode = !!innerCallee;
              }
              calleeName = reencode ? `${innerCallee}().${methodName}` : methodName;
            } else {
              calleeName = methodName;
            }
          }
        } else if (func.type === 'scoped_identifier' || func.type === 'scoped_call_expression') {
          // 作用域调用：Module::function()
          calleeName = getNodeText(func, this.source);
        } else if (this.language === 'csharp' && func.type === 'member_access_expression') {
          // C# 成员调用 `recv.Method(...)`。当接收者本身是一个调用——即链式工厂
          // `Foo.Create(args).Bar()`——时，将其编码为 `inner().Bar`（带规范化空括号），
          // 以便解析器可以从 `Foo.Create` 的返回值推断 Bar 所属的类（#645/#608）。
          // 非调用接收者保留完整的成员访问文本（即原有的 `recv.Method` 行为）。
          const recv = getChildByField(func, 'expression');
          const nameNode = getChildByField(func, 'name');
          const methodName = nameNode ? getNodeText(nameNode, this.source) : '';
          if (recv && recv.type === 'invocation_expression' && methodName) {
            const innerFunc = getChildByField(recv, 'function');
            const innerCallee = innerFunc ? getNodeText(innerFunc, this.source).replace(/\s+/g, '') : '';
            calleeName = innerCallee ? `${innerCallee}().${methodName}` : methodName;
          } else {
            calleeName = getNodeText(func, this.source);
          }
        } else {
          calleeName = getNodeText(func, this.source);
        }
      }
    }

    // 括号类型转换——Go 中的 `(*T)(x)` / `(T)(x)`（以及一般括号化被调用者）
    // 被解析为调用，其 "function" 是括号括起的类型/表达式，
    // 被调用者文本为无法解析的字面量 `(*T)`。
    // 将其规范化为内层名称，使其解析为 `T`（对转换目标类型的真实依赖），
    // 而非被直接丢弃。
    if (calleeName) {
      const conv = calleeName.match(/^\(\s*\*?\s*([A-Za-z_][\w.]*)\s*\)$/);
      if (conv && conv[1]) calleeName = conv[1];
    }

    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }

  /**
   * `new Foo(...)` / `Foo::new(...)` / object_creation_expression——
   * 向类名发出 `instantiates` 引用。解析器随后将其关联到类节点，
   * 生成 `instantiates` 边，为"谁创建了 X 的实例"类查询提供支撑。
   *
   * 子节点仍会被游走，以便构造函数参数中的嵌套调用
   * （如 `new Foo(bar())`）能生成各自的 `calls` 引用。
   */
  private extractInstantiation(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const fromId = this.nodeStack[this.nodeStack.length - 1];
    if (!fromId) return;

    // 类名位于 `constructor`/`type`/first-named-child 字段，具体取决于 grammar。
    const ctor =
      getChildByField(node, 'constructor') ||
      getChildByField(node, 'type') ||
      getChildByField(node, 'name') ||
      node.namedChild(0);
    if (!ctor) return;

    // Go 复合字面量：同包的 `Widget{...}` 和跨包的 `pkga.Widget{...}`。
    // 只有直接命名的 struct 类型才是有意义的实例化目标——跳过 slice/map/array
    // 字面量（`[]T{}`、`map[K]V{}`），因为它们的 `type` 字段是复合类型而非命名类型。
    // 与 `new ns.Foo()` 不同，此处保留包限定符（`pkga.Widget`），
    // 以便 Go 跨包解析器能将其消歧到正确包中的类型。
    if (node.type === 'composite_literal') {
      if (ctor.type !== 'type_identifier' && ctor.type !== 'qualified_type') return;
      let goType = getNodeText(ctor, this.source).trim();
      const brIdx = goType.indexOf('['); // strip Go generic args: `Box[T]{}` -> `Box`
      if (brIdx > 0) goType = goType.slice(0, brIdx).trim(); // 去掉 Go 泛型参数：`Box[T]{}` → `Box`
      if (goType) {
        this.unresolvedReferences.push({
          fromNodeId: fromId,
          referenceName: goType,
          referenceKind: 'instantiates',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    // Scala：`new Monoid[Int] { ... }` ——构造函数是使用 `[...]` 类型参数的
    // `generic_type`（或限定的 `stable_type_identifier`），下方的 `<...>` 去除
    // 逻辑无法处理。将其解包为基础类型名称。
    if (node.type === 'instance_expression') {
      const name = scalaBaseTypeName(ctor, this.source);
      if (name) {
        this.unresolvedReferences.push({
          fromNodeId: fromId,
          referenceName: name,
          referenceKind: 'instantiates',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    let className = getNodeText(ctor, this.source);
    // 先去掉类型参数后缀：`new Map<K, V>()` 若不处理，
    // className 会是 'Map<K, V>'（constructor 字段为 `generic_type` 节点），
    // 导致解析失败——因为没有类以尖括号后缀命名。
    const ltIdx = className.indexOf('<');
    if (ltIdx > 0) className = className.slice(0, ltIdx);
    // 对于命名空间/限定构造器（`new ns.Foo()`、`new ns::Foo()`），
    // 保留尾部标识符——这才是与索引中类节点匹配的部分。
    const lastDot = Math.max(
      className.lastIndexOf('.'),
      className.lastIndexOf('::')
    );
    if (lastDot >= 0) className = className.slice(lastDot + 1).replace(/^[:.]/, '');
    className = className.trim();

    if (className) {
      this.unresolvedReferences.push({
        fromNodeId: fromId,
        referenceName: className,
        referenceKind: 'instantiates',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }

  /**
   * 静态成员/值读取阶段。仅通过成员**值**使用的类型/枚举/类——
   * `Enum.value`、`Type.CONST`、`Colors.red`、`Foo::BAR`——不会记录边，
   * 因为 body 游走器只处理调用（`Type.method()`）。这样一来，
   * 只通过枚举值或静态字段引用的类型看起来没有任何依赖
   * （Dart/Java/C#/Swift/Kotlin/PHP 上均存在此残差问题）。
   * 向大写接收者发出 `references` 边。仅在类型按惯例首字母大写的语言中启用，
   * 且当访问是调用的被调用者时跳过（调用提取器已处理该方法链接）。
   */
  private extractStaticMemberRef(node: SyntaxNode): void {
    if (!STATIC_MEMBER_LANGS.has(this.language)) return;
    if (this.nodeStack.length === 0) return;
    const ownerId = this.nodeStack[this.nodeStack.length - 1];
    if (!ownerId) return;

    // Dart 将成员访问结构化为 `identifier` + 兄弟 `selector`，而非单一节点。
    // 无 `argument_part` 的值读取 selector，且前一兄弟为大写标识符，即 `Enum.value`。
    if (this.language === 'dart') {
      if (node.type !== 'selector') return;
      if (node.namedChildren.some((c: SyntaxNode) => c.type === 'argument_part')) return;
      const prev = node.previousNamedSibling;
      if (prev?.type === 'identifier' && /^[A-Z][A-Za-z0-9_]*$/.test(prev.text)) {
        this.pushStaticMemberRef(prev.text, ownerId, prev);
      }
      return;
    }

    if (!MEMBER_ACCESS_TYPES.has(node.type)) return;

    // 跳过 `Type.method()` ——此访问是某调用的被调用者，已被链接。
    const parent = node.parent;
    if (parent && this.extractor!.callTypes.includes(parent.type)) {
      const callee =
        getChildByField(parent, 'function') ??
        getChildByField(parent, 'method') ??
        parent.namedChild(0);
      if (callee && callee.startIndex === node.startIndex) return;
    }

    // 接收者必须是**简单**的大写标识符——`Type.X`，
    // 而非嵌套的 `a.B.c`（其自身的头部成员访问会单独被访问），
    // 也非小写的 `obj.field` / `pkg.func`。
    const recv =
      getChildByField(node, 'object') ??
      getChildByField(node, 'expression') ??
      getChildByField(node, 'scope') ??
      node.namedChild(0);
    if (!recv) return;
    const t = recv.type;
    if (
      t === 'identifier' || t === 'type_identifier' || t === 'simple_identifier' ||
      t === 'name' || t === 'scoped_type_identifier'
    ) {
      const text = getNodeText(recv, this.source);
      if (/^[A-Z][A-Za-z0-9_]*$/.test(text)) this.pushStaticMemberRef(text, ownerId, recv);
    }
  }

  private pushStaticMemberRef(name: string, ownerId: string, node: SyntaxNode): void {
    this.unresolvedReferences.push({
      fromNodeId: ownerId,
      referenceName: name,
      referenceKind: 'references',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  /**
   * 在 `object_creation_expression` 中查找 `class_body` 子节点——
   * 这是匿名类（`new T() { ... }`）的标志。返回 body 节点，
   * 以便调用方将其作为匿名类的成员进行游走。
   */
  private findAnonymousClassBody(node: SyntaxNode): SyntaxNode | null {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      // Java：`class_body`。C# 使用相同的节点类型。
      if (child && (child.type === 'class_body' || child.type === 'declaration_list')) {
        return child;
      }
    }
    return null;
  }

  /**
   * 提取 Java/C# 匿名类——`new T() { ...members }`。发出一个名为 `<T$anon@line>`
   * 的 `class` 节点，以及一条指向 T 的 `extends` 引用（以便阶段 5.5 的
   * interface-impl 桥接），并游走 body，使其 `method_declaration` 成员
   * 成为匿名类下的 method 节点。
   *
   * 为何重要：若没有匿名类提取，lambda 返回的 `new T() { @Override int foo(){...} }`
   * 中的覆盖方法不会成为节点，因此对 T.foo（抽象父类方法）的调用没有静态目标，
   * 智能体不得不读取文件才能找到实现。
   */
  private extractAnonymousClass(node: SyntaxNode, body: SyntaxNode): void {
    if (!this.extractor) return;

    // 被实例化的类型位于 extractInstantiation 读取的相同字段/位置。
    // 使用相同的查找方式，使匿名类的 `extends` 目标与 `instantiates` 边保持一致。
    const typeNode =
      getChildByField(node, 'constructor') ||
      getChildByField(node, 'type') ||
      getChildByField(node, 'name') ||
      node.namedChild(0);
    let typeName = typeNode ? getNodeText(typeNode, this.source) : 'Object';
    const ltIdx = typeName.indexOf('<');
    if (ltIdx > 0) typeName = typeName.slice(0, ltIdx);
    const lastDot = Math.max(typeName.lastIndexOf('.'), typeName.lastIndexOf('::'));
    if (lastDot >= 0) typeName = typeName.slice(lastDot + 1).replace(/^[:.]/, '');
    typeName = typeName.trim() || 'Object';

    const anonName = `<${typeName}$anon@${node.startPosition.row + 1}>`;
    const classNode = this.createNode('class', anonName, node, {});
    if (!classNode) return;

    // 匿名类隐式 extends/implements 命名类型。
    // 提取阶段无法判断 T 是 class 还是 interface，因此发出 `extends`。
    // 解析器仍会将 T 绑定到实际类型，阶段 5.5（已处理 `extends` 和 `implements`）
    // 会将 T 的方法桥接到匿名 body 中找到的覆盖名称。
    this.unresolvedReferences.push({
      fromNodeId: classNode.id,
      referenceName: typeName,
      referenceKind: 'extends',
      line: typeNode?.startPosition.row ?? node.startPosition.row,
      column: typeNode?.startPosition.column ?? node.startPosition.column,
    });

    // 游走 body 的子节点，使内部的 method_declaration 节点
    // 成为归属于匿名类的 method 节点。
    this.nodeStack.push(classNode.id);
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) this.visitNode(child);
    }
    this.nodeStack.pop();
  }

  /**
   * 扫描 `declNode` 及其前置兄弟节点（在父节点的具名子节点范围内）
   * 中的 decorator 节点，从 `decoratedId` 向每个 decorator 的函数名
   * 发出 `decorates` 引用。
   *
   * 为何扫描前置兄弟：在 TypeScript 中，`@Foo class Bar {}` 被解析为
   * `export_statement`（或顶层包裹层），decorator 是 class_declaration
   * **之前**的子节点——因此 decorator 并非类自身的子节点。
   * 对于方法/属性，decorator 确实是声明的直接子节点，
   * 因此也会扫描 `declNode.namedChildren`。
   *
   * 跨 grammar 幂等：若两处均未发现 decorator（大多数不使用 decorator 的语言），
   * 该函数为空操作。
   */
  private extractDecoratorsFor(declNode: SyntaxNode, decoratedId: string): void {
    const consider = (n: SyntaxNode | null): void => {
      if (!n) return;
      // `marker_annotation` 是 Java grammar 中无参注解的节点类型
      // （`@Override`、`@Deprecated`）；`attribute` 是 Swift grammar 中
      // attribute 和属性包装器（property wrapper）的节点类型
      // （`@objc`、`@Argument`、`@Published`、`@State`）。
      // 若不处理这些，上述用法会被静默跳过。
      if (
        n.type !== 'decorator' &&
        n.type !== 'annotation' &&
        n.type !== 'marker_annotation' &&
        n.type !== 'attribute'
      ) {
        return;
      }
      // 找到前导标识符：跳过 `@` 标点；若 decorator 带参数调用，
      // 则解包 call_expression。
      let target: SyntaxNode | null = null;
      for (let i = 0; i < n.namedChildCount; i++) {
        const child = n.namedChild(i);
        if (!child) continue;
        if (child.type === 'call_expression') {
          const fn = getChildByField(child, 'function') ?? child.namedChild(0);
          if (fn) target = fn;
          if (target) break;
        }
        if (
          child.type === 'identifier' ||
          child.type === 'member_expression' ||
          child.type === 'scoped_identifier' ||
          child.type === 'navigation_expression' ||
          child.type === 'user_type' ||      // Swift attribute → user_type（`@Argument`）
          child.type === 'type_identifier'
        ) {
          target = child;
          break;
        }
      }
      if (!target) return;
      let name = getNodeText(target, this.source);
      const lt = name.indexOf('<'); // 去掉泛型参数：`@Argument<T>` → `Argument`
      if (lt > 0) name = name.slice(0, lt);
      const lastDot = Math.max(name.lastIndexOf('.'), name.lastIndexOf('::'));
      if (lastDot >= 0) name = name.slice(lastDot + 1).replace(/^[:.]/, '');
      name = name.trim();
      if (!name) return;
      this.unresolvedReferences.push({
        fromNodeId: decoratedId,
        referenceName: name,
        referenceKind: 'decorates',
        line: n.startPosition.row + 1,
        column: n.startPosition.column,
      });
    };

    // 1. Decorators that are direct children of the declaration
    //    (method/property style, also some grammars for class).
    for (let i = 0; i < declNode.namedChildCount; i++) {
      const child = declNode.namedChild(i);
      consider(child);
      // Java/Kotlin/C# 将注解放在 `modifiers` 节点**内部**
      // （`@MyAnno public class X` → class_declaration → modifiers → annotation），
      // 因此需递归进入——否则每个注解用法会被静默丢弃，注解类型显示零依赖方。
      if (child && child.type === 'modifiers') {
        for (let j = 0; j < child.namedChildCount; j++) {
          consider(child.namedChild(j));
        }
      }
    }

    // 2. 在父节点具名子节点中，声明的**前置兄弟** decorator（TypeScript class 风格）。
    //    从声明节点**向前**遍历，遇到第一个非 decorator 兄弟时停止——
    //    若不停止，属于更早无关声明的 decorator 会泄漏进来
    //    （例如 `@A class Foo {} @B class Bar {}` 在不停止时，
    //    会将 @A 归属到 Bar）。
    //
    //    关于对象同一性：tree-sitter web binding 在通过 `parent`/`namedChild`
    //    导航时会返回新的 JS 包装对象，因此 `sibling === declNode` 不可靠——
    //    改用 `startIndex` 进行匹配。
    const parent = declNode.parent;
    if (parent) {
      const declStart = declNode.startIndex;
      let declIdx = -1;
      for (let i = 0; i < parent.namedChildCount; i++) {
        const sibling = parent.namedChild(i);
        if (sibling && sibling.startIndex === declStart) {
          declIdx = i;
          break;
        }
      }
      if (declIdx > 0) {
        for (let j = declIdx - 1; j >= 0; j--) {
          const sibling = parent.namedChild(j);
          if (!sibling) continue;
          if (sibling.type !== 'decorator' && sibling.type !== 'annotation' && sibling.type !== 'marker_annotation') {
            break; // 非 decorator 分隔符 → 停止消费
          }
          consider(sibling);
        }
      }
    }
  }

  /**
   * 游走函数 body 并提取调用（以及结构性节点）。
   *
   * 除调用表达式外，还会检测函数 body 内的 class/struct/enum 定义。
   * 处理以下两种情况：
   *   1. 局部 class/struct/enum 定义（C++、Java 等语言中合法）
   *   2. C++ 宏误解析——`NLOHMANN_JSON_NAMESPACE_BEGIN` 等宏会导致 tree-sitter
   *      将 namespace 块解析为 function_definition，将真正的 class/struct/enum
   *      节点隐藏在"函数 body"中。
   */
  /**
   * Rocket 路由注册宏——`routes![a::b::handler, c::d::other]`
   * 和 `catchers![not_found]`。tree-sitter 将宏 body 留为原始 token 的平铺
   * `token_tree`（`identifier`、`::`、`,`），因此 handler 路径从未被视为引用，
   * 每个 handler 函数看起来没有调用者——它在运行时由 Rocket 挂载，而非被
   * 仓库内代码调用，导致其文件显示 0 个依赖者。遍历 token tree，重建每条
   * 逗号分隔的路径，并发出 `references` 边；Rust 路径解析器
   * （`resolveRustPathReference`）随后将其关联到 handler 函数。
   * handler 名称在源码中是显式的，因此这是精确的静态提取，而非启发式——
   * 不会产生虚假边（解析器仍会验证每条路径）。
   */
  private extractRustRouteMacro(node: SyntaxNode): void {
    if (this.language !== 'rust') return;
    const macroName = node.namedChild(0);
    if (!macroName) return;
    const name = getNodeText(macroName, this.source);
    if (name !== 'routes' && name !== 'catchers') return;
    const tokenTree = node.namedChildren.find((c: SyntaxNode) => c.type === 'token_tree');
    if (!tokenTree) return;
    const fromId = this.nodeStack[this.nodeStack.length - 1];
    if (!fromId) return;

    // token tree 是平铺流：`[ id :: id :: id , id … ]`。
    // 将连续的 `identifier` token（`::` 连接符为匿名节点）分组为一条路径；
    // `,`（或结尾的 `]`）结束一条路径。
    let parts: string[] = [];
    let line = 0;
    let column = 0;
    const flush = (): void => {
      if (parts.length > 0) {
        this.unresolvedReferences.push({
          fromNodeId: fromId,
          referenceName: parts.join('::'),
          referenceKind: 'references',
          line,
          column,
        });
        parts = [];
      }
    };
    for (let i = 0; i < tokenTree.childCount; i++) {
      const t = tokenTree.child(i);
      if (!t) continue;
      if (t.type === 'identifier') {
        if (parts.length === 0) {
          line = t.startPosition.row + 1;
          column = t.startPosition.column;
        }
        parts.push(getNodeText(t, this.source));
      } else if (t.type === ',') {
        flush();
      }
    }
    flush();
  }

  private visitFunctionBody(body: SyntaxNode, _functionId: string): void {
    if (!this.extractor) return;

    const visitForCallsAndStructure = (node: SyntaxNode): void => {
      const nodeType = node.type;

      // Function-as-value 捕获（#756）——函数 body 在此游走，而非在 visitNode 中，
      // 因此捕获钩子必须在两个游走器中均触发。
      this.maybeCaptureFnRefs(node, nodeType);

      // Rocket 路由注册宏（`routes![…]` / `catchers![…]`）：
      // handler 路径位于调用游走器不可见的原始 token tree 中。
      if (nodeType === 'macro_invocation') this.extractRustRouteMacro(node);

      if (this.extractor!.callTypes.includes(nodeType)) {
        this.extractCall(node);
      } else if (INSTANTIATION_KINDS.has(nodeType)) {
        // 函数 body 内的 `new Foo()`——发出 `instantiates` 引用。
        // 若无此分支，body 游走器只处理 `call_expression`，
        // 构造函数调用不会产生任何图边。
        this.extractInstantiation(node);
        // 带 body 的匿名类：`new T() { ... }`（Java/C#）。将其提取为 class，
        // 以便 interface-impl 合成（阶段 5.5）可将 T 的方法桥接到覆盖——
        // 与 visitNode 中的理由相同。
        const anonBody = this.findAnonymousClassBody(node);
        if (anonBody) {
          this.extractAnonymousClass(node, anonBody);
          return;
        }
      } else if (this.extractor!.extractBareCall) {
        const calleeName = this.extractor!.extractBareCall(node, this.source);
        if (calleeName && this.nodeStack.length > 0) {
          const callerId = this.nodeStack[this.nodeStack.length - 1];
          if (callerId) {
            this.unresolvedReferences.push({
              fromNodeId: callerId,
              referenceName: calleeName,
              referenceKind: 'calls',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
      }

      // 静态成员/值读取：`Enum.value`、`Type.CONST`、`Foo::BAR`。
      this.extractStaticMemberRef(node);

      // body 内的局部变量类型注解——`const items: Foo[] = []`、
      // `const x: SomeType = svc.load()`。我们故意**不**为局部变量创建节点
      // （否则会导致图爆炸——这是我们刻意不覆盖的数据流前沿），
      // 但局部变量所注解的**类型**是外围函数的真实依赖，
      // 因此为其归属一条 `references` 边。若无此处理，
      // 仅在 body 中使用某类型的函数（极为常见——如构建 `const nodes: Node[] = []`
      // 的 resolver）不会产生指向该类型的边，导致 impact / `affected` 完全遗漏该依赖。
      // 后续进入默认递归，以确保初始化器的调用（及嵌套 declarator）仍被游走。
      if (
        nodeType === 'variable_declarator' &&
        this.TYPE_ANNOTATION_LANGUAGES.has(this.language)
      ) {
        const ownerId = this.nodeStack[this.nodeStack.length - 1];
        if (ownerId) this.extractVariableTypeAnnotation(node, ownerId);
      }

      // body 内的**命名**嵌套函数——函数声明及命名函数表达式
      // （如 `.on('mount', function onmount(){})`）——成为各自的节点，
      // 以便图中可以链接到它们（callback handler、局部辅助函数）。
      // 匿名箭头/函数表达式则走默认递归，使其内部调用归属于外围函数：
      // 这将新节点限制为**仅命名函数**（无爆炸，无丢失边）。
      // extractFunction 自行游走嵌套 body，因此在此处返回。
      if (this.extractor!.functionTypes.includes(nodeType)) {
        const nestedName = extractName(node, this.source, this.extractor!);
        if (nestedName && nestedName !== '<anonymous>') {
          this.extractFunction(node);
          return;
        }
      }

      // 提取函数 body 内的结构性节点。
      // 每个提取方法会自行访问其子节点，因此提取后在此处返回。
      if (this.extractor!.classTypes.includes(nodeType)) {
        const classification = this.extractor!.classifyClassNode?.(node) ?? 'class';
        if (classification === 'struct') this.extractStruct(node);
        else if (classification === 'enum') this.extractEnum(node);
        else if (classification === 'interface') this.extractInterface(node);
        else if (classification === 'trait') this.extractClass(node, 'trait');
        else this.extractClass(node);
        return;
      }
      if (this.extractor!.structTypes.includes(nodeType)) {
        this.extractStruct(node);
        return;
      }
      if (this.extractor!.enumTypes.includes(nodeType)) {
        this.extractEnum(node);
        return;
      }
      if (this.extractor!.interfaceTypes.includes(nodeType)) {
        this.extractInterface(node);
        return;
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          visitForCallsAndStructure(child);
        }
      }
    };

    visitForCallsAndStructure(body);
  }

  /**
   * 提取继承关系
   */
  private extractInheritance(node: SyntaxNode, classId: string): void {
    // Objective-C @interface MyClass : NSObject <ProtoA, ProtoB>
    if (node.type === 'class_interface') {
      const superclass = getChildByField(node, 'superclass');
      if (superclass) {
        const name = getNodeText(superclass, this.source);
        this.unresolvedReferences.push({
          fromNodeId: classId,
          referenceName: name,
          referenceKind: 'extends',
          line: superclass.startPosition.row + 1,
          column: superclass.startPosition.column,
        });
      }
      for (let j = 0; j < node.namedChildCount; j++) {
        const argList = node.namedChild(j);
        if (argList?.type !== 'parameterized_arguments') continue;
        for (let k = 0; k < argList.namedChildCount; k++) {
          const typeName = argList.namedChild(k);
          if (!typeName) continue;
          const typeId = typeName.namedChildren.find(
            (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier'
          );
          if (!typeId) continue;
          const protocolName = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: protocolName,
            referenceKind: 'implements',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }
      return;
    }

    // 查找 extends/implements 子句
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (
        child.type === 'extends_clause' ||
        child.type === 'superclass' ||
        child.type === 'base_clause' || // PHP class extends
        child.type === 'extends_interfaces' // Java interface extends
      ) {
        // Scala：`extends A[X] with B with C` 将**所有**父类型打包进
        // 同一个 extends_clause（以 `with` 分隔），每个都是 `generic_type` /
        // `type_identifier` / `stable_type_identifier`。下方的通用路径只取
        // namedChild(0) 并保留完整文本（`A[X]`），导致参数化父类型——
        // cats/algebra 中的每个 typeclass——从不匹配，
        // 且第一个之后通过 `with` 混入的 trait 会被丢弃。
        // 遍历所有父类型并将每个解包为基础类型名称。
        if (this.language === 'scala') {
          for (const target of child.namedChildren) {
            const name = scalaBaseTypeName(target, this.source);
            if (name) {
              this.unresolvedReferences.push({
                fromNodeId: classId,
                referenceName: name,
                referenceKind: 'extends',
                line: target.startPosition.row + 1,
                column: target.startPosition.column,
              });
            }
          }
          continue;
        }
        // Dart：`class C extends Base with M1, M2` —— `superclass` 节点将
        // extends 类型存为直接 `type_identifier`，同时带有列出 `with` mixin 的
        // `mixins` 子节点（`class C with M` 则只有 mixin，无 extends 类型）。
        // 通用的 `namedChild(0)` 路径会将 `mixins` 节点本身读作父类并丢弃所有 mixin——
        // 而 mixin 正是 Dart 的核心组合机制（Flutter 构建于此之上）。
        // 为基础类发出 `extends`，为每个 mixin 发出 `implements`。
        if (this.language === 'dart' && child.type === 'superclass') {
          for (const t of child.namedChildren) {
            if (t.type === 'mixins') {
              for (const m of t.namedChildren) {
                if (m.type === 'type_identifier') {
                  this.unresolvedReferences.push({
                    fromNodeId: classId,
                    referenceName: getNodeText(m, this.source),
                    referenceKind: 'implements',
                    line: m.startPosition.row + 1,
                    column: m.startPosition.column,
                  });
                }
              }
            } else if (t.type === 'type_identifier') {
              this.unresolvedReferences.push({
                fromNodeId: classId,
                referenceName: getNodeText(t, this.source),
                referenceKind: 'extends',
                line: t.startPosition.row + 1,
                column: t.startPosition.column,
              });
            }
          }
          continue;
        }
        // 提取父类/接口名称
        // Java 使用 type_list 包裹层：superclass → type_identifier，extends_interfaces → type_list → type_identifier
        const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
        const targets = typeList ? typeList.namedChildren : [child.namedChild(0)];
        for (const target of targets) {
          if (target) {
            const name = getNodeText(target, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: target.startPosition.row + 1,
              column: target.startPosition.column,
            });
          }
        }
      }

      // C++ 基类：`class Derived : public Base, private Other` →
      // base_class_clause 包含访问限定符 + 基类类型。
      // 为每个基类类型发出 extends 引用（跳过 public/private/protected 关键字）。
      if (child.type === 'base_class_clause') {
        for (const t of child.namedChildren) {
          if (
            t.type === 'type_identifier' ||
            t.type === 'qualified_identifier' ||
            t.type === 'template_type'
          ) {
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: getNodeText(t, this.source),
              referenceKind: 'extends',
              line: t.startPosition.row + 1,
              column: t.startPosition.column,
            });
          }
        }
      }

      if (
        child.type === 'implements_clause' ||
        child.type === 'class_interface_clause' ||
        child.type === 'super_interfaces' || // Java class implements
        child.type === 'interfaces' // Dart
      ) {
        // 提取已实现的接口
        // Java 使用 type_list 包裹层：super_interfaces → type_list → type_identifier
        const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
        const targets = typeList ? typeList.namedChildren : child.namedChildren;
        for (const iface of targets) {
          if (iface) {
            const name = getNodeText(iface, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'implements',
              line: iface.startPosition.row + 1,
              column: iface.startPosition.column,
            });
          }
        }
      }

      // Python 父类列表：`class Flask(Scaffold, Mixin):`
      // argument_list 中每个父类对应一个 identifier 子节点
      if (child.type === 'argument_list' && node.type === 'class_definition') {
        for (const arg of child.namedChildren) {
          if (arg.type === 'identifier' || arg.type === 'attribute') {
            const name = getNodeText(arg, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: arg.startPosition.row + 1,
              column: arg.startPosition.column,
            });
          }
        }
      }

      // Go interface 嵌入：`type Querier interface { LabelQuerier; ... }`
      // constraint_elem 包裹嵌入接口的类型标识符
      if (child.type === 'constraint_elem') {
        const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        if (typeId) {
          const name = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }

      // Go struct 嵌入：无 field_identifier 的 field_declaration
      // 例如 `type DB struct { *Head; Queryable }` —— 无字段名表示嵌入类型
      if (child.type === 'field_declaration') {
        const hasFieldIdentifier = child.namedChildren.some((c: SyntaxNode) => c.type === 'field_identifier');
        if (!hasFieldIdentifier) {
          const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
          if (typeId) {
            const name = getNodeText(typeId, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: typeId.startPosition.row + 1,
              column: typeId.startPosition.column,
            });
          }
        }
      }

      // Rust trait 超 trait：`trait SubTrait: SuperTrait + Display { ... }`
      // trait_bounds 包含 type_identifier、generic_type 或 higher_ranked_trait_bound 子节点
      if (child.type === 'trait_bounds') {
        for (const bound of child.namedChildren) {
          let typeName: string | undefined;
          let posNode: SyntaxNode | undefined;

          if (bound.type === 'type_identifier') {
            typeName = getNodeText(bound, this.source);
            posNode = bound;
          } else if (bound.type === 'generic_type') {
            // 例如 `Deserialize<'de>`
            const inner = bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
            if (inner) { typeName = getNodeText(inner, this.source); posNode = inner; }
          } else if (bound.type === 'higher_ranked_trait_bound') {
            // 例如 `for<'de> Deserialize<'de>`
            const generic = bound.namedChildren.find((c: SyntaxNode) => c.type === 'generic_type');
            const typeId = generic?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
              ?? bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
            if (typeId) { typeName = getNodeText(typeId, this.source); posNode = typeId; }
          }

          if (typeName && posNode) {
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: typeName,
              referenceKind: 'extends',
              line: posNode.startPosition.row + 1,
              column: posNode.startPosition.column,
            });
          }
        }
      }

      // C#：`class Movie : BaseItem, IPlugin` → base_list 包含 identifier 子节点
      // base_list 将基类和接口合并在冒号分隔的单一列表中。
      // 由于语法上无法区分，全部发出为 'extends'。
      if (child.type === 'base_list') {
        for (const baseType of child.namedChildren) {
          if (baseType) {
            // 对于泛型基类（如 `ClientBase<T>`），只提取类型名称
            const name = baseType.type === 'generic_name'
              ? getNodeText(baseType.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') ?? baseType, this.source)
              : getNodeText(baseType, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: baseType.startPosition.row + 1,
              column: baseType.startPosition.column,
            });
          }
        }
      }

      // Kotlin：`class Foo : Bar, Baz` → delegation_specifier > user_type > type_identifier
      // 同时处理 `class Foo : Bar()` → delegation_specifier > constructor_invocation > user_type
      if (child.type === 'delegation_specifier') {
        const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
        const constructorInvocation = child.namedChildren.find((c: SyntaxNode) => c.type === 'constructor_invocation');
        const target = userType ?? constructorInvocation;
        if (target) {
          const typeId = target.type === 'user_type'
            ? target.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier') ?? target
            : target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type')?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
              ?? target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type') ?? target;
          const name = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }

      // Swift：inheritance_specifier > user_type > type_identifier
      // 用于 class 继承、protocol 一致性和 protocol 继承
      if (child.type === 'inheritance_specifier') {
        const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
        const typeId = userType?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        if (typeId) {
          const name = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }

      // JavaScript class_heritage 包含裸标识符，不带 extends_clause 包裹层
      // 例如 `class Foo extends Bar {}` → class_heritage → identifier("Bar")
      if (
        (child.type === 'identifier' || child.type === 'type_identifier') &&
        node.type === 'class_heritage'
      ) {
        const name = getNodeText(child, this.source);
        this.unresolvedReferences.push({
          fromNodeId: classId,
          referenceName: name,
          referenceKind: 'extends',
          line: child.startPosition.row + 1,
          column: child.startPosition.column,
        });
      }

      // 递归进入容器节点（如 Go struct 中的 field_declaration_list，
      // 以及 TypeScript 中包裹 extends_clause/implements_clause 的 class_heritage）
      if (child.type === 'field_declaration_list' || child.type === 'class_heritage') {
        this.extractInheritance(child, classId);
      }
    }
  }

  /**
   * Rust `impl Trait for Type` —— 从 Type 向 Trait 创建 implements 边。
   * 对于普通的 `impl Type { ... }`（无 trait），不需要继承边。
   */
  private extractRustImplItem(node: SyntaxNode): void {
    // 通过查找 `for` 关键字来判断是否为 `impl Trait for Type`
    const hasFor = node.children.some(
      (c: SyntaxNode) => c.type === 'for' && !c.isNamed
    );
    if (!hasFor) return;

    // 在 `impl Trait for Type` 中，type_identifier 的顺序为：
    // 第一个 = Trait 名称，最后一个 = 实现类型名称
    // 同时处理泛型类型，如 `impl<T> Trait for MyStruct<T>`
    const typeIdents = node.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'scoped_type_identifier'
    );
    if (typeIdents.length < 2) return;

    const traitNode = typeIdents[0]!;
    const typeNode = typeIdents[typeIdents.length - 1]!;

    // 获取 trait 名称（处理作用域路径，如 std::fmt::Display）
    const traitName = traitNode.type === 'scoped_type_identifier'
      ? this.source.substring(traitNode.startIndex, traitNode.endIndex)
      : getNodeText(traitNode, this.source);

    // 获取实现类型名称（对泛型提取内层 type_identifier）
    let typeName: string;
    if (typeNode.type === 'generic_type') {
      const inner = typeNode.namedChildren.find(
        (c: SyntaxNode) => c.type === 'type_identifier'
      );
      typeName = inner ? getNodeText(inner, this.source) : getNodeText(typeNode, this.source);
    } else {
      typeName = getNodeText(typeNode, this.source);
    }

    // 查找实现类型对应的 struct/type 节点
    const typeNodeId = this.findNodeByName(typeName);
    if (typeNodeId) {
      this.unresolvedReferences.push({
        fromNodeId: typeNodeId,
        referenceName: traitName,
        referenceKind: 'implements',
        line: traitNode.startPosition.row + 1,
        column: traitNode.startPosition.column,
      });
    }
  }

  /**
   * 通过名称查找之前提取的节点（用于 impl 块等反向引用）
   */
  private findNodeByName(name: string): string | undefined {
    for (const node of this.nodes) {
      if (node.name === name && (node.kind === 'struct' || node.kind === 'enum' || node.kind === 'class')) {
        return node.id;
      }
    }
    return undefined;
  }

  /**
   * 支持类型注解的语言（TypeScript 等）
   */
  private readonly TYPE_ANNOTATION_LANGUAGES = new Set([
    'typescript', 'tsx', 'dart', 'kotlin', 'swift', 'rust', 'go', 'java', 'csharp', 'scala', 'php',
  ]);

  /**
   * PHP 伪类型及 `self`/`static`/`parent`——这些不是项目符号。
   * （标量基础类型解析为 `primitive_type`，在结构层面被跳过。）
   */
  private readonly PHP_PSEUDO_TYPES = new Set([
    'self', 'static', 'parent', 'mixed', 'object', 'iterable', 'callable', 'void',
    'null', 'false', 'true', 'never', 'array', 'int', 'float', 'string', 'bool',
  ]);

  /**
   * 不应创建引用的内置/基础类型名称
   */
  private readonly BUILTIN_TYPES = new Set([
    'string', 'number', 'boolean', 'void', 'null', 'undefined', 'never', 'any', 'unknown',
    'object', 'symbol', 'bigint', 'true', 'false',
    // Rust
    'str', 'bool', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
    'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64', 'char',
    // Java/C#
    'int', 'long', 'short', 'byte', 'float', 'double', 'char',
    // Go
    'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
    'float32', 'float64', 'complex64', 'complex128', 'rune', 'error',
    // Scala（大写基础类型 + 无处不在的 stdlib 别名）
    'Int', 'Long', 'Short', 'Byte', 'Float', 'Double', 'Boolean', 'Char', 'Unit',
    'String', 'Any', 'AnyRef', 'AnyVal', 'Nothing', 'Null',
  ]);

  /**
   * 从函数/方法/字段节点上的类型注解中提取类型引用。
   * 为参数类型、返回类型和字段类型创建 'references' 边。
   */
  private extractTypeAnnotations(node: SyntaxNode, nodeId: string): void {
    if (!this.extractor) return;
    if (!this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) return;

    // C# tree-sitter 不生成 `type_identifier` 叶节点——它使用
    // `identifier`、`predefined_type`、`qualified_name`、`generic_name` 等，
    // 因此下方的通用游走器不会为其发出任何引用。
    // 分发至 C# 感知路径，仅游走类型位置子树
    // （parameter/method/property/field 的 `type` 字段），
    // 以防 parameter 名称意外被当作类型引用（#381）。
    if (this.language === 'csharp') {
      this.extractCsharpTypeRefs(node, nodeId);
      return;
    }

    // PHP 类型提示为 `named_type`/`optional_type`/`union_type` 包裹的
    // `name`/`qualified_name`——从不是 `type_identifier`——因此下方的通用游走器
    // 对其不会发出任何引用。分发至 PHP 感知路径，仅游走类型位置
    // （parameter/return/property 类型），以便记录类型提示依赖
    // （Laravel 中占主导地位的构造函数注入契约），
    // 同时防止 `$events` 这样的 `variable_name` 被误发为引用。
    if (this.language === 'php') {
      this.extractPhpTypeRefs(node, nodeId);
      return;
    }

    // Dart：`method_signature` 包裹真正的 `function_signature`（参数和返回类型所在处），
    // 且返回类型是裸 `type_identifier` 子节点，而非 `type` 字段——
    // 因此下方的 getChildByField 两者均找不到。游走内层签名：
    // 参数名/方法名为 `identifier`（非 `type_identifier`），因此只有类型会浮现。
    if (this.language === 'dart') {
      let sig: SyntaxNode | undefined = node;
      if (node.type === 'method_signature') {
        sig = node.namedChildren.find(
          (c: SyntaxNode) =>
            c.type === 'function_signature' ||
            c.type === 'getter_signature' ||
            c.type === 'setter_signature' ||
            c.type === 'constructor_signature' ||
            c.type === 'factory_constructor_signature'
        ) ?? node;
      }
      this.extractTypeRefsFromSubtree(sig, nodeId);
      return;
    }

    // 提取参数类型注解。Scala 柯里化——`def f(a)(implicit M: TC)` 有**多个**
    // `parameters` 兄弟节点，typeclass 几乎总在尾部的 implicit 列表中——
    // 因此游走每一个参数列表，而非只取 getChildByField 的第一个匹配。
    if (this.language === 'scala') {
      for (const pc of node.namedChildren) {
        if (pc.type === 'parameters') this.extractTypeRefsFromSubtree(pc, nodeId);
      }
    } else {
      const params = getChildByField(node, this.extractor.paramsField || 'parameters');
      if (params) {
        this.extractTypeRefsFromSubtree(params, nodeId);
      }
    }

    // 提取返回类型注解
    const returnType = getChildByField(node, this.extractor.returnField || 'return_type');
    if (returnType) {
      this.extractTypeRefsFromSubtree(returnType, nodeId);
    }

    // Scala context bound / type parameter bound：`def f[A: Monoid]`、
    // `[F[_]: Monad]`、`[A <: Foo]` 将约束类型包含在 `type_parameters` 中。
    // 这是 Scala 中要求 typeclass 的**最常见**方式，但约束从不出现在值参数中。
    // 参数**名称**为 `identifier`（非 `type_identifier`），因此只有约束类型会浮现。
    // 仅限 Scala：在其他语言中，`type_parameters` 子节点以 `type_identifier` 持有
    // 声明名称（TS 的 `<T>`），若在此处理会错误地将其视为引用。
    if (this.language === 'scala') {
      const typeParams = node.namedChildren.find(
        (c: SyntaxNode) => c.type === 'type_parameters'
      );
      if (typeParams) {
        this.extractTypeRefsFromSubtree(typeParams, nodeId);
      }
    }

    // 提取直接类型注解（如类字段 `model: ITextModel`）
    const typeAnnotation = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type_annotation'
    );
    if (typeAnnotation) {
      this.extractTypeRefsFromSubtree(typeAnnotation, nodeId);
    }
  }

  /**
   * 从拥有类型位置的节点（method/constructor 声明、property 声明，
   * 或包裹 `variable_declaration → type` 的 field 声明）中提取 C# 类型引用。
   *
   * **仅**游走已知的类型字段，以防 `Build(UserDto request)` 中的参数名
   * `request` 被误发为类型引用。进入类型子树后，`walkCsharpTypePosition`
   * 识别 C# 实际的类型叶节点类型（`identifier`、`qualified_name`、
   * `generic_name`、`array_type`、`nullable_type`、`tuple_type` 等）——
   * 这些均非 `type_identifier`。解决 #381。
   */
  private extractCsharpTypeRefs(node: SyntaxNode, nodeId: string): void {
    // property 的类型在 `type` 字段下；method/constructor 的**返回**类型在
    // `returns` 字段下（tree-sitter-c-sharp 0.23.x——旧版本两者均使用 `type`）。
    // 节点只携带其中之一，因此同时检查两者即可覆盖返回类型和属性类型，而不会混淆。
    const directType = getChildByField(node, 'type') ?? getChildByField(node, 'returns');
    if (directType) this.walkCsharpTypePosition(directType, nodeId);

    // 字段声明将 declarator 包裹在 `variable_declaration` 中，
    // 该节点的 `type` 字段携带类型。外层 `field_declaration` 自身无 `type` 字段，
    // 因此上方的调用在此为空操作，需向下一层递归。
    const varDecl = node.namedChildren.find((c: SyntaxNode) => c.type === 'variable_declaration');
    if (varDecl) {
      const vdType = getChildByField(varDecl, 'type');
      if (vdType) this.walkCsharpTypePosition(vdType, nodeId);
    }

    // method/constructor 参数。`method_declaration` 的字段名为 `parameters`，
    // 指向 `parameter_list`，其 `parameter` 子节点各自具有 `type` 字段。
    // **仅**游走 type 字段可跳过参数名，避免将其误发为类型引用。
    const params = getChildByField(node, 'parameters');
    if (params) {
      for (let i = 0; i < params.namedChildCount; i++) {
        const child = params.namedChild(i);
        if (!child || child.type !== 'parameter') continue;
        const paramType = getChildByField(child, 'type');
        if (paramType) this.walkCsharpTypePosition(paramType, nodeId);
      }
    }
  }

  /**
   * 记录 C# **主构造函数**（C# 12+，`class Svc(IRepo repo, [FromKeyedServices("k")] ICache cache) { … }`）
   * 声明的依赖项。参数列表作为无字段名的 `parameter_list` 子节点挂在
   * class/struct/record 声明上（与方法使用的 `parameters` 字段不同），
   * 因此通过节点类型查找。每个参数的声明类型成为从所属类型发出的 `references` 边——
   * 这正是 DI 注册类型所依赖的服务，使 impact/blast-radius 和
   * "谁依赖此契约"查询得以覆盖它们。若无主构造函数则为空操作。（#237）
   */
  private extractCsharpPrimaryCtorParamRefs(node: SyntaxNode, ownerId: string): void {
    if (this.language !== 'csharp') return;
    const paramList = node.namedChildren.find((c: SyntaxNode) => c.type === 'parameter_list');
    if (!paramList) return;
    for (let i = 0; i < paramList.namedChildCount; i++) {
      const param = paramList.namedChild(i);
      if (!param || param.type !== 'parameter') continue;
      const paramType = getChildByField(param, 'type');
      if (paramType) this.walkCsharpTypePosition(paramType, ownerId);
    }
  }

  /**
   * 游走**已知**处于类型位置的 C# 子树
   * （返回类型、参数类型、属性类型、字段类型、泛型参数）。
   * 此处的标识符是类型名称，而非参数名称。
   */
  private walkCsharpTypePosition(node: SyntaxNode, fromNodeId: string): void {
    // `predefined_type` 是 int/string/bool 等——从不是项目引用。
    if (node.type === 'predefined_type') return;

    // 裸类型名称：`Foo bar` 中的 `Foo`，或 `List<Foo>` 内的 `Foo`。
    if (node.type === 'identifier') {
      const name = getNodeText(node, this.source);
      if (name && !this.BUILTIN_TYPES.has(name)) {
        this.unresolvedReferences.push({
          fromNodeId,
          referenceName: name,
          referenceKind: 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    // `Namespace.Foo` → 最右侧的标识符是类型。将完整限定名发出为引用；
    // 需要时解析器仍可通过尾部简单名称进行匹配。
    if (node.type === 'qualified_name') {
      const text = getNodeText(node, this.source);
      const last = text.split('.').pop() ?? text;
      if (last && !this.BUILTIN_TYPES.has(last)) {
        this.unresolvedReferences.push({
          fromNodeId,
          referenceName: last,
          referenceKind: 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }

    // `(int Code, Foo Payload)` —— tuple element 同时具有 `type` 和 `name` 字段；
    // 遍历所有具名子节点会将元素名（`Code`、`Payload`）误发为类型引用。
    // 仅游走 type 字段。
    if (node.type === 'tuple_element') {
      const t = getChildByField(node, 'type');
      if (t) this.walkCsharpTypePosition(t, fromNodeId);
      return;
    }

    // 复合类型节点——递归进入具名子节点。涵盖：
    // `generic_name`（头部标识符 + `type_argument_list`）、
    // `nullable_type`、`array_type`、`pointer_type`、`tuple_type`、
    // `ref_type`，以及 grammar 新增的任何包裹形状。
    // 到达此处的标识符均处于类型位置（参数/字段名在递归前已被门控排除）。
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.walkCsharpTypePosition(child, fromNodeId);
    }
  }

  /**
   * 从 method/function/property 声明中提取 PHP 类型引用。
   * **仅**游走类型位置：每个参数的 type 子节点（在 `formal_parameters` 内）、
   * 返回类型，以及属性类型——均为 `named_type` / `optional_type` / `union_type` / …
   * 的直接子节点。参数和属性的**名称**是 `variable_name`（`$x`），从不是类型节点，
   * 因此不会被误发。
   */
  private extractPhpTypeRefs(node: SyntaxNode, nodeId: string): void {
    const params = node.namedChildren.find((c: SyntaxNode) => c.type === 'formal_parameters');
    if (params) {
      for (const p of params.namedChildren) {
        // simple_parameter / property_promotion_parameter / variadic_parameter
        for (const c of p.namedChildren) {
          if (PHP_TYPE_NODES.has(c.type)) this.walkPhpTypePosition(c, nodeId);
        }
      }
    }
    // 方法/函数的返回类型和属性类型是声明的**直接**子节点中的 TYPE 节点。
    for (const c of node.namedChildren) {
      if (PHP_TYPE_NODES.has(c.type)) this.walkPhpTypePosition(c, nodeId);
    }
  }

  /** 游走**已知**处于类型位置的 PHP 子树；发出 class/interface 引用。 */
  private walkPhpTypePosition(node: SyntaxNode, fromNodeId: string): void {
    if (node.type === 'primitive_type') return; // int/string/void/…
    if (node.type === 'name') {
      const name = getNodeText(node, this.source);
      if (name && !this.PHP_PSEUDO_TYPES.has(name)) {
        this.unresolvedReferences.push({
          fromNodeId, referenceName: name, referenceKind: 'references',
          line: node.startPosition.row + 1, column: node.startPosition.column,
        });
      }
      return;
    }
    if (node.type === 'qualified_name') {
      // `App\Contracts\Logger` → 按尾部简单名称匹配（即 class 节点存储的名称，
      // 以及 `use` import 引入作用域的名称）。
      const last = getNodeText(node, this.source).split('\\').pop() ?? '';
      if (last && !this.PHP_PSEUDO_TYPES.has(last)) {
        this.unresolvedReferences.push({
          fromNodeId, referenceName: last, referenceKind: 'references',
          line: node.startPosition.row + 1, column: node.startPosition.column,
        });
      }
      return;
    }
    // optional_type / nullable_type / union_type / intersection_type / named_type → 递归
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.walkPhpTypePosition(child, fromNodeId);
    }
  }

  /**
   * 从变量的类型注解中提取类型引用。
   */
  private extractVariableTypeAnnotation(node: SyntaxNode, nodeId: string): void {
    if (!this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) return;

    // 查找 type_annotation 子节点（涵盖 TS 的 `: Type`、Rust 的 `: Type` 等）
    const typeAnnotation = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type_annotation'
    );
    if (typeAnnotation) {
      this.extractTypeRefsFromSubtree(typeAnnotation, nodeId);
    }
  }

  /**
   * 递归游走子树，提取所有 type_identifier 引用。
   * 处理 union、intersection、泛型、数组等类型。
   */
  private extractTypeRefsFromSubtree(node: SyntaxNode, fromNodeId: string): void {
    if (node.type === 'type_identifier') {
      const typeName = getNodeText(node, this.source);
      if (typeName && !this.BUILTIN_TYPES.has(typeName)) {
        this.unresolvedReferences.push({
          fromNodeId,
          referenceName: typeName,
          referenceKind: 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return; // type_identifier 是叶节点
    }

    // 递归进入子节点（处理 union_type、intersection_type、generic_type 等）
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) {
        this.extractTypeRefsFromSubtree(child, fromNodeId);
      }
    }
  }

  /**
   * 处理 Pascal 专属的 AST 结构。
   * 若节点已被完整处理且子节点应跳过，则返回 true。
   */
  private visitPascalNode(node: SyntaxNode): boolean {
    const nodeType = node.type;

    // Unit/Program/Library → module 节点
    if (nodeType === 'unit' || nodeType === 'program' || nodeType === 'library') {
      const moduleNameNode = node.namedChildren.find(
        (c: SyntaxNode) => c.type === 'moduleName'
      );
      const name = moduleNameNode ? getNodeText(moduleNameNode, this.source) : '';
      // 若模块名为空，则退回到无扩展名的文件名
      const moduleName = name || path.basename(this.filePath).replace(/\.[^.]+$/, '');
      this.createNode('module', moduleName, node);
      // 继续访问子节点（interface/implementation 节）
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // declType 包裹 declClass/declIntf/declEnum/类型别名
    // 名称在 declType 上，内层节点决定 kind
    if (nodeType === 'declType') {
      this.extractPascalDeclType(node);
      return true;
    }

    // declUses → 为每个单元名称创建 import 节点
    if (nodeType === 'declUses') {
      this.extractPascalUses(node);
      return true;
    }

    // declConsts → 容器节点；访问子节点以处理各 declConst
    if (nodeType === 'declConsts') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'declConst') {
          this.extractPascalConst(child);
        }
      }
      return true;
    }

    // 顶层 declConst（在 declConsts 之外）
    if (nodeType === 'declConst') {
      this.extractPascalConst(node);
      return true;
    }

    // declTypes → 类型声明容器
    if (nodeType === 'declTypes') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // declVars → 变量声明容器
    if (nodeType === 'declVars') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'declVar') {
          const nameNode = getChildByField(child, 'name');
          if (nameNode) {
            const name = getNodeText(nameNode, this.source);
            this.createNode('variable', name, child);
          }
        }
      }
      return true;
    }

    // implementation 节中的 defProc → 提取调用，但不创建重复节点
    if (nodeType === 'defProc') {
      this.extractPascalDefProc(node);
      return true;
    }

    // declProp → property 节点
    if (nodeType === 'declProp') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        const visibility = this.extractor!.getVisibility?.(node);
        this.createNode('property', name, node, { visibility });
      }
      return true;
    }

    // declField → field 节点
    if (nodeType === 'declField') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        const visibility = this.extractor!.getVisibility?.(node);
        this.createNode('field', name, node, { visibility });
      }
      return true;
    }

    // declSection → 访问子节点（通过 getVisibility 传递可见性）
    if (nodeType === 'declSection') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // exprCall → 提取函数调用引用
    if (nodeType === 'exprCall') {
      this.extractPascalCall(node);
      return true;
    }

    // interface/implementation 节 → 访问子节点
    if (nodeType === 'interface' || nodeType === 'implementation') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // block（begin..end）→ 访问以提取调用
    if (nodeType === 'block') {
      this.visitPascalBlock(node);
      return true;
    }

    return false;
  }

  /**
   * 提取 Pascal declType 节点（class、interface、enum 或类型别名）
   */
  private extractPascalDeclType(node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);

    // 查找内层类型声明
    const declClass = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declClass'
    );
    const declIntf = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declIntf'
    );
    const typeChild = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type'
    );

    if (declClass) {
      const classNode = this.createNode('class', name, node);
      if (classNode) {
        // 从 declClass 的 typeref 子节点提取继承关系
        this.extractPascalInheritance(declClass, classNode.id);
        // 访问 class body
        this.nodeStack.push(classNode.id);
        for (let i = 0; i < declClass.namedChildCount; i++) {
          const child = declClass.namedChild(i);
          if (child) this.visitNode(child);
        }
        this.nodeStack.pop();
      }
    } else if (declIntf) {
      const ifaceNode = this.createNode('interface', name, node);
      if (ifaceNode) {
        // 访问 interface 成员
        this.nodeStack.push(ifaceNode.id);
        for (let i = 0; i < declIntf.namedChildCount; i++) {
          const child = declIntf.namedChild(i);
          if (child) this.visitNode(child);
        }
        this.nodeStack.pop();
      }
    } else if (typeChild) {
      // 检查是否包含 declEnum
      const declEnum = typeChild.namedChildren.find(
        (c: SyntaxNode) => c.type === 'declEnum'
      );
      if (declEnum) {
        const enumNode = this.createNode('enum', name, node);
        if (enumNode) {
          // 提取 enum 成员
          this.nodeStack.push(enumNode.id);
          for (let i = 0; i < declEnum.namedChildCount; i++) {
            const child = declEnum.namedChild(i);
            if (child?.type === 'declEnumValue') {
              const memberName = getChildByField(child, 'name');
              if (memberName) {
                this.createNode('enum_member', getNodeText(memberName, this.source), child);
              }
            }
          }
          this.nodeStack.pop();
        }
      } else {
        // 简单类型别名：type TFoo = string / type TFoo = Integer
        this.createNode('type_alias', name, node);
      }
    } else {
      // 兜底：可能是前向声明或简单别名
      this.createNode('type_alias', name, node);
    }
  }

  /**
   * 将 Pascal uses 子句提取为各 import 节点
   */
  private extractPascalUses(node: SyntaxNode): void {
    const importText = getNodeText(node, this.source).trim();
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'moduleName') {
        const unitName = getNodeText(child, this.source);
        this.createNode('import', unitName, child, {
          signature: importText,
        });
        // 创建未解析引用供后续解析
        if (this.nodeStack.length > 0) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) {
            this.unresolvedReferences.push({
              fromNodeId: parentId,
              referenceName: unitName,
              referenceKind: 'imports',
              line: child.startPosition.row + 1,
              column: child.startPosition.column,
            });
          }
        }
      }
    }
  }

  /**
   * 提取 Pascal 常量声明
   */
  private extractPascalConst(node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);
    const defaultValue = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'defaultValue'
    );
    const sig = defaultValue ? getNodeText(defaultValue, this.source) : undefined;
    this.createNode('constant', name, node, { signature: sig });
  }

  /**
   * 从 declClass 的 typeref 子节点提取 Pascal 继承关系（extends/implements）
   */
  private extractPascalInheritance(declClass: SyntaxNode, classId: string): void {
    const typerefs = declClass.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'typeref'
    );
    for (let i = 0; i < typerefs.length; i++) {
      const ref = typerefs[i]!;
      const name = getNodeText(ref, this.source);
      this.unresolvedReferences.push({
        fromNodeId: classId,
        referenceName: name,
        referenceKind: i === 0 ? 'extends' : 'implements',
        line: ref.startPosition.row + 1,
        column: ref.startPosition.column,
      });
    }
  }

  /**
   * 从 Pascal defProc（实现体）中提取调用并解析方法上下文。
   * 不创建新节点——声明已从 interface 节中捕获。
   */
  private extractPascalDefProc(node: SyntaxNode): void {
    // 按名称查找匹配的声明节点，用作调用的父节点
    const declProc = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declProc'
    );
    if (!declProc) return;

    const nameNode = getChildByField(declProc, 'name');
    if (!nameNode) return;
    const fullName = getNodeText(nameNode, this.source).trim();
    // fullName 形如 "TAuthService.Create"
    const shortName = fullName.includes('.') ? fullName.split('.').pop()! : fullName;
    const fullNameKey = fullName.toLowerCase();
    const shortNameKey = shortName.toLowerCase();

    // 首次使用时构建方法索引（构建一次 O(n)，之后查找 O(1)）
    if (!this.methodIndex) {
      this.methodIndex = new Map();
      for (const n of this.nodes) {
        if (n.kind === 'method' || n.kind === 'function') {
          const nameKey = n.name.toLowerCase();
          // 保留首次遇到的短名称映射，避免静默覆盖较早的条目。
          if (!this.methodIndex.has(nameKey)) {
            this.methodIndex.set(nameKey, n.id);
          }

          // 对于 Pascal 方法，同时索引限定形式（如 TAuthService.Create）。
          if (n.kind === 'method') {
            const qualifiedParts = n.qualifiedName.split('::');
            if (qualifiedParts.length >= 2) {
              // 创建后缀键，使 "Module.Class.Method" 和 "Class.Method" 均可解析。
              for (let i = 0; i < qualifiedParts.length - 1; i++) {
                const scopedName = qualifiedParts.slice(i).join('.').toLowerCase();
                this.methodIndex.set(scopedName, n.id);
              }
            }
          }
        }
      }
    }

    let parentId =
      this.methodIndex.get(fullNameKey) ||
      this.methodIndex.get(shortNameKey);

    // 无现有节点？这是仅在 implementation 中定义的**自由**过程/函数
    // （`procedure Helper; begin … end;`，无 interface 声明且非 class 方法）。
    // 创建一个 function 节点，使其 body 内的调用归属于它，而非外围 file/module。
    // 方法（`TClass.Method`，带点的名称）始终从其 class 声明中获得节点，
    // 因此此处仅针对自由子程序触发——且上方的 methodIndex 查找
    // 已涵盖 interface 声明的自由子程序，不会产生重复。
    if (!parentId && !fullName.includes('.')) {
      const fnNode = this.createNode('function', fullName, declProc, {
        signature: this.extractor?.getSignature?.(declProc, this.source),
        visibility: this.extractor?.getVisibility?.(declProc),
      });
      if (fnNode) {
        parentId = fnNode.id;
        this.methodIndex.set(fullNameKey, fnNode.id);
        if (!this.methodIndex.has(shortNameKey)) this.methodIndex.set(shortNameKey, fnNode.id);
      }
    }

    if (!parentId) parentId = this.nodeStack[this.nodeStack.length - 1];
    if (!parentId) return;

    // 访问 block 以提取调用
    const block = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'block'
    );
    if (block) {
      this.nodeStack.push(parentId);
      this.visitPascalBlock(block);
      this.nodeStack.pop();
    }
  }

  /**
   * 从 Pascal 表达式中提取函数调用
   */
  private extractPascalCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    // 获取被调用者名称——第一个子节点通常是 identifier 或 exprDot
    const firstChild = node.namedChild(0);
    if (!firstChild) return;

    let calleeName = '';
    if (firstChild.type === 'exprDot') {
      // 链式静态工厂调用：`TFoo.GetInstance().DoIt()` —— exprDot 的接收者本身是
      // `exprCall`，若直接取标识符列表会塌缩为仅 `DoIt`，误解析到无关类的同名方法。
      // 将其编码为 `TFoo.GetInstance().DoIt`，以便解析器从 `TFoo.GetInstance` 的
      // 返回值推断 DoIt 所属的类（#645/#608）。
      // 仅针对大写类工厂链；外层方法为单目。
      const innerCall = firstChild.namedChildren.find((c: SyntaxNode) => c.type === 'exprCall');
      const outerId = firstChild.namedChildren.filter((c: SyntaxNode) => c.type === 'identifier').pop();
      const method = outerId ? getNodeText(outerId, this.source) : '';
      if (innerCall && method && /^\w+$/.test(method)) {
        const innerFirst = innerCall.namedChild(0);
        let innerCallee = '';
        if (innerFirst?.type === 'exprDot') {
          innerCallee = innerFirst.namedChildren
            .filter((c: SyntaxNode) => c.type === 'identifier')
            .map((id: SyntaxNode) => getNodeText(id, this.source))
            .join('.');
        } else if (innerFirst?.type === 'identifier') {
          innerCallee = getNodeText(innerFirst, this.source);
        }
        // 门控于 Delphi 类型命名惯例——`TFoo` 类 / `IFoo` 接口——
        // 使类工厂链重新编码，而大写变量/参数链（Pascal 局部变量也大写：
        // `Curve.X().Y()`、`Self.X().Y()`）保持裸名并沿用现有裸名解析。
        calleeName = innerCallee && /^[TI][A-Z]/.test(innerCallee)
          ? `${innerCallee}().${method}`
          : method;
      } else {
        // 限定调用：Obj.Method(...)
        const identifiers = firstChild.namedChildren.filter(
          (c: SyntaxNode) => c.type === 'identifier'
        );
        if (identifiers.length > 0) {
          calleeName = identifiers.map((id: SyntaxNode) => getNodeText(id, this.source)).join('.');
        }
      }
    } else if (firstChild.type === 'identifier') {
      calleeName = getNodeText(firstChild, this.source);
    }

    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }

    // 同时访问参数以提取嵌套调用
    const args = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'exprArgs'
    );
    if (args) {
      this.visitPascalBlock(args);
    }
  }

  /**
   * 提取**无括号**的 Pascal 方法/过程调用（`Obj.Method;`、`TFoo.GetInstance.DoIt;`）。
   * Pascal 允许无参方法省略括号，因此其解析为裸 `exprDot`（而非 `exprCall`）。
   * 裸 `exprDot` 在语法上与字段/属性访问完全相同，因此此方法仅在**语句级**的
   * exprDot 处被调用（由调用方门控）：语句级的裸 `Obj.Field;` 是空操作，
   * 故语句级点表达式即为调用。（赋值 LHS/RHS 或条件中的 exprDot 原样保留——
   * 那里它真的可能是字段/属性读取。）
   */
  private extractPascalParenlessCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    const receiver = node.namedChild(0);
    const outerId = node.namedChildren.filter((c: SyntaxNode) => c.type === 'identifier').pop();
    const method = outerId ? getNodeText(outerId, this.source) : '';
    if (!method) return;

    let calleeName = '';
    // 链式：接收者本身是调用——无括号的 `TFoo.GetInstance`（内层 exprDot）
    // 或有括号的 `TFoo.GetInstance()`（exprCall）。将链编码为
    // `TFoo.GetInstance().DoIt`，以便解析器从工厂的返回值推断 DoIt 的类（#645/#608），
    // 门控于 Delphi 的 `TFoo`/`IFoo` 类型惯例；
    // 大写变量链保持裸方法名。
    if ((receiver?.type === 'exprDot' || receiver?.type === 'exprCall') && /^\w+$/.test(method)) {
      const innerCalleeNode = receiver.type === 'exprCall' ? receiver.namedChild(0) : receiver;
      const innerCallee = !innerCalleeNode
        ? ''
        : innerCalleeNode.type === 'identifier'
          ? getNodeText(innerCalleeNode, this.source)
          : innerCalleeNode.namedChildren
              .filter((c: SyntaxNode) => c.type === 'identifier')
              .map((id: SyntaxNode) => getNodeText(id, this.source))
              .join('.');
      if (innerCallee && /^[TI][A-Z]/.test(innerCallee)) {
        calleeName = `${innerCallee}().${method}`;
        // T/I 前缀的内层本身是真实调用——也记录它。
        if (receiver.type === 'exprCall') this.extractPascalCall(receiver);
        else this.extractPascalParenlessCall(receiver);
      } else {
        calleeName = method; // 非 class 接收者：裸方法引用（无字段访问引用）
      }
    } else {
      // 简单形式：`Obj.Method` → 带点名称（通过接收者/裸名解析）。
      calleeName = node.namedChildren
        .filter((c: SyntaxNode) => c.type === 'identifier')
        .map((id: SyntaxNode) => getNodeText(id, this.source))
        .join('.');
    }

    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }

  /**
   * 递归访问 Pascal block/statement 树以提取调用表达式
   */
  private visitPascalBlock(node: SyntaxNode): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      // Function-as-value 捕获（#756）：Pascal body 在此游走，而非在
      // visitNode/visitForCallsAndStructure 中，因此捕获钩子在此触发——
      // 赋值 RHS 是 Delphi 事件绑定的惯用法（`OnFire := Handler`）。
      this.maybeCaptureFnRefs(child, child.type);
      if (child.type === 'exprCall') {
        this.extractPascalCall(child);
        // 游走器不下沉到调用参数中——直接分发参数容器
        // （`RegisterHandler(TargetCb)` / `(@Cb)`）。
        const args = child.namedChildren.find((c: SyntaxNode) => c.type === 'exprArgs');
        if (args) this.maybeCaptureFnRefs(args, 'exprArgs');
      } else if (child.type === 'exprDot') {
        // **语句级**裸 exprDot 是无括号调用（`Obj.Free;`、`TFoo.GetInstance.DoIt;`）。
        // 其他位置（赋值侧、条件、表达式）的裸 exprDot 与字段/属性访问语法相同，
        // 因此仅下沉到有括号的内层调用。
        if (node.type === 'statement') {
          this.extractPascalParenlessCall(child);
        } else {
          for (let j = 0; j < child.namedChildCount; j++) {
            const grandchild = child.namedChild(j);
            if (grandchild?.type === 'exprCall') {
              this.extractPascalCall(grandchild);
            }
          }
        }
      } else {
        this.visitPascalBlock(child);
      }
    }
  }
}


/**
 * 从源码中提取节点和边。
 *
 * 若提供了 `frameworkNames`，将在 tree-sitter 阶段完成后，
 * 运行与这些名称及文件语言匹配的框架专属提取器，
 * 并将其节点/引用/错误合并到返回结果中。
 */
export function extractFromSource(
  filePath: string,
  source: string,
  language?: Language,
  frameworkNames?: string[]
): ExtractionResult {
  const detectedLanguage = language || detectLanguage(filePath, source);
  const fileExtension = path.extname(filePath).toLowerCase();

  let result: ExtractionResult;

  // 使用 Svelte 的自定义提取器
  if (detectedLanguage === 'svelte') {
    const extractor = new SvelteExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'vue') {
    // 使用 Vue 的自定义提取器
    const extractor = new VueExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'astro') {
    // 使用 Astro 的自定义提取器（frontmatter + template 委托）
    const extractor = new AstroExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'liquid') {
    // 使用 Liquid 的自定义提取器
    const extractor = new LiquidExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'razor') {
    // 使用 ASP.NET Razor（.cshtml）/ Blazor（.razor）标记的自定义提取器
    const extractor = new RazorExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'xml') {
    // MyBatis mapper XML 的自定义提取器。非 mapper XML 仅返回文件节点，
    // 以供 watcher 追踪而不发出符号。
    const extractor = new MyBatisExtractor(filePath, source);
    result = extractor.extract();
  } else if (isFileLevelOnlyLanguage(detectedLanguage)) {
    // 此阶段不提取符号——文件仅在文件记录级别追踪。
    // 框架提取器（Drupal 路由 yml、针对 application.yml/application.properties
    // 的 Spring `@Value` 解析）在之后运行，并在适用时添加各文件的节点/引用。
    result = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
  } else if (
    detectedLanguage === 'pascal' &&
    (fileExtension === '.dfm' || fileExtension === '.fmx')
  ) {
    // 使用 DFM/FMX 表单文件的自定义提取器
    const extractor = new DfmExtractor(filePath, source);
    result = extractor.extract();
  } else {
    const extractor = new TreeSitterExtractor(filePath, source, detectedLanguage);
    result = extractor.extract();
  }

  // 框架专属提取（路由、middleware 等）
  if (frameworkNames && frameworkNames.length > 0) {
    const allResolvers = getAllFrameworkResolvers();
    const applicable = getApplicableFrameworks(
      allResolvers.filter((r) => frameworkNames.includes(r.name)),
      detectedLanguage
    );
    for (const fw of applicable) {
      if (!fw.extract) continue;
      try {
        const fwResult = fw.extract(filePath, source);
        result.nodes.push(...fwResult.nodes);
        result.unresolvedReferences.push(...fwResult.references);
      } catch (err) {
        result.errors.push({
          message: `Framework extractor '${fw.name}' failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          filePath,
          severity: 'warning',
        });
      }
    }
  }

  return result;
}
