/**
 * 函数值捕获（#756）——回调的注册链接。
 *
 * 函数名被用作**值**的情况——作为调用参数传递
 * （`register_handler(target_cb)`、`signal(SIGINT, handler)`）、赋值给
 * 字段或函数指针（`o->cb = target_cb`、`OnFire := TargetCb`）、
 * 放在结构体/对象初始化器中（`{ .recv_cb = my_cb }`、
 * `{ recv: targetCb }`、`Ops{Cb: targetCb}`），或列在函数表中
 * （`static cb_t table[] = { cb_a, cb_b }`）——是静态调用提取完全遗漏的
 * 真实依赖关系：`callers(target_cb)` 只显示直接调用，因此每个回调看起来
 * 都是死代码，其注册位置对影响分析不可见。
 *
 * 本模块在 AST 遍历期间将这些值位置捕获为 `function_ref` 候选。
 * 捕获是按语言驱动的（值位置和包装形式因 grammar 而异——C 中的 `&fn`、
 * Java 中的 `Main::fn`、Kotlin 中的 `::fn`、Swift 中的 `#selector(fn)`、
 * Pascal 中的 `@TargetCb`、Ruby 中的 `method(:fn)`）。候选在文件提取
 * 结束时被门控（见 `TreeSitterExtractor.flushFnRefCandidates`）：只有名称
 * 与同文件函数/方法或已导入绑定匹配的候选才能通过，从而控制数量并保持
 * 高精度。解析器随后仅将通过者与函数/方法节点匹配（`matchFunctionRef` 位于
 * `src/resolution/name-matcher.ts`），并将其持久化为 `references` 边，
 * 供 `callers`/`impact` 遍历。
 *
 * 故意**不涵盖**（解析*分发*——`o->cb(x)` → 注册的函数——需要通过结构体
 * 字段进行数据流分析；错误的边比没有边更糟）：间接调用解析，以及
 * `obj.method` 成员值（`obj` 不是 `this`/`self` 时接收者类型在静态上
 * 不可知，需要局部数据流）。
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from './tree-sitter-helpers';

export interface FnRefCandidate {
  name: string;
  line: number;
  column: number;
  /** 产生此候选的捕获位置（门控策略依赖于此）。 */
  mode: CaptureMode;
  /**
   * 当值为显式引用形式时为 true（`&fn`、`&Cls::m`、`::fn`、`#selector`、
   * `method(:sym)`），而非裸标识符——C++ 的 flush 策略依赖于此。
   */
  explicitRef: boolean;
  /**
   * 跳过此候选的同文件/导入名称门控。针对已知 HOF 位置的 PHP 字符串可调用对象设置：
   * PHP 全局函数无需导入即可跨文件引用（全局命名空间），因此门控无法看到它们——
   * 强位置先验（作为 `usort`/`array_map`/… 参数的字符串）加上解析器的唯一或丢弃
   * 规则来保证精度。
   */
  skipGate?: boolean;
}

/** 如何从已分发的容器节点中提取候选值节点。 */
type CaptureMode =
  | 'args' // 每个命名子节点都是潜在值（调用参数列表）
  | 'rhs' // 赋值右侧（命名字段，否则取最后一个命名子节点）
  | 'value' // 键值对的 `value` 字段（对象/结构体/表初始化器）
  | 'list' // 每个命名子节点（数组 / 初始化列表 / 表位置元素）
  | 'varinit'; // 变量声明符的初始化值

interface CaptureRule {
  mode: CaptureMode;
  /** rhs/value/varinit 持有值的字段（各模式有默认值）。 */
  field?: string;
}

export interface FnRefSpec {
  /** 可充当函数值的裸标识符节点类型。 */
  idTypes: Set<string>;
  /** 容器节点类型 → 从中提取候选值的方式。 */
  dispatch: Map<string, CaptureRule>;
  /**
   * 容器与值之间的透明包装层
   * （`argument`、`value_argument`、`literal_element`、`expression_list`…）。
   * 值：要下降进入的字段，或 null 表示"命名子节点"。
   * `expression_list` 展开为所有命名子节点（Go 多赋值）。
   */
  layers?: Map<string, string | null>;
  /**
   * 操作数为函数值的一元包装——C/C++ `&fn`（pointer_expression）、
   * Pascal `@Fn`（exprUnary）、Scala eta `fn _`（postfix_expression）。
   * 值：操作数字段，或 null 表示第一个命名子节点。
   */
  unwrap?: Map<string, string | null>;
  /**
   * 需要特殊名称提取的整节点引用形式——
   * `method_reference`（Java）、`callable_reference` / `navigation_expression`
   * （Kotlin）、`selector_expression`（Swift `#selector` / ObjC `@selector`）、
   * Ruby `method(:sym)` 调用，以及 `this.method` 成员形式。
   */
  special?: Set<string>;
  /**
   * 候选跳过同文件/导入门控、依赖解析器唯一或丢弃规则的捕获模式。
   * 仅限 C 系列：初始化器值、函数指针赋值 RHS 或表元素在构造上就是
   * 函数指针位置，且 C 没有符号导入——否则跨文件的主流仓库模式
   * （`server.c` 的命令表命名来自 `t_*.c` 的处理函数）将不可见。
   * 调用参数在所有地方都保持门控（作为参数传递的局部变量远多于回调）。
   */
  ungatedModes?: Set<CaptureMode>;
  /**
   * 仅限 C++：在 args/rhs/varinit 位置，只接受显式引用形式（`&fn`、
   * `&Cls::method`）——不接受裸标识符。C++ 代码库中充斥着通用自由函数/
   * 访问器名称（`begin`、`end`、`out`、`size`、`data`），这些名称与参数和
   * 局部变量冲突，而行外成员定义被提取为函数类型节点——对 fmt 的裸 id
   * 匹配大多产生错误边。文件作用域初始化表（value/list）仍接受裸标识符，
   * 与 C 相同。
   */
  addressOfOnly?: boolean;
}

/** 即使 grammar 将其标记为标识符，这些名称也永远不是函数引用。 */
const NAME_STOPLIST = new Set([
  'this',
  'self',
  'super',
  'null',
  'nil',
  'true',
  'false',
  'undefined',
  'new',
  'NULL',
  'nullptr',
  'None',
]);

// ---------------------------------------------------------------------------
// 各语言规范。节点类型已针对各 grammar 进行验证（#756 调查中的探针固件；
// 见 docs/design/function-ref-capture.md）。
// ---------------------------------------------------------------------------

/** C / C++ / Objective-C 共用 C 系列初始化器 & 赋值形状。 */
function cFamilySpec(extra?: { special?: string[]; addressOfOnly?: boolean }): FnRefSpec {
  return {
    idTypes: new Set(['identifier']),
    dispatch: new Map<string, CaptureRule>([
      ['argument_list', { mode: 'args' }],
      ['assignment_expression', { mode: 'rhs', field: 'right' }],
      ['init_declarator', { mode: 'varinit', field: 'value' }],
      ['initializer_list', { mode: 'list' }],
      ['initializer_pair', { mode: 'value', field: 'value' }],
    ]),
    unwrap: new Map([['pointer_expression', 'argument']]),
    special: new Set(extra?.special ?? []),
    // C 没有符号导入，且回调在仓库规模下跨文件注册（redis：server.c 的命令表
    // 命名来自 t_*.c 的处理函数）——因此初始化器位置绕过门控，依赖解析器的
    // 唯一或丢弃规则。仅 'value'/'list'（结构体/数组初始化器），
    // 且 flush 额外要求文件作用域：C 文件作用域初始化器是常量表达式上下文，
    // 因此其中的裸标识符只能是函数地址（或枚举/宏，会被函数类型过滤器丢弃）——
    // 永远不会是变量。'rhs'/'varinit' 曾被尝试过，但产生了错误边
    // （`prev = next`、`*str = field`——数据赋值匹配了其他地方唯一的同名函数），
    // 因此赋值仍对同文件/导入保持门控。
    ungatedModes: new Set<CaptureMode>(['value', 'list']),
    addressOfOnly: extra?.addressOfOnly,
  };
}

// `this.handleClick` 捕获（member_expression）生成带 `this.` 前缀的候选名：
// 解析器将其限定到包含符号的类（限定名前缀），因此 `this.fonts`（属性，
// post-#808）和继承/未知成员不产生边，而同类方法——
// `btn.on('click', this.handleClick)`，即观察者注册惯用法——可精确解析。
// 裸标识符仍仅限函数类型（JS 中裸 id 永远不可能是方法值）。
const TS_JS_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['arguments', { mode: 'args' }],
    ['assignment_expression', { mode: 'rhs', field: 'right' }],
    ['variable_declarator', { mode: 'varinit', field: 'value' }],
    ['pair', { mode: 'value', field: 'value' }],
    ['array', { mode: 'list' }],
  ]),
  special: new Set(['member_expression']),
};

const PYTHON_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['argument_list', { mode: 'args' }],
    ['assignment', { mode: 'rhs', field: 'right' }],
    ['keyword_argument', { mode: 'value', field: 'value' }], // Thread(target=worker)
    ['pair', { mode: 'value', field: 'value' }],
    ['list', { mode: 'list' }],
  ]),
  special: new Set(['attribute']),
};

const GO_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['argument_list', { mode: 'args' }],
    ['assignment_statement', { mode: 'rhs', field: 'right' }],
    ['short_var_declaration', { mode: 'rhs', field: 'right' }],
    ['var_spec', { mode: 'varinit', field: 'value' }],
    ['keyed_element', { mode: 'value' }], // value = 最后一个 literal_element 子节点
    ['literal_value', { mode: 'list' }], // 位置复合字面量
  ]),
  layers: new Map<string, string | null>([
    ['literal_element', null],
    ['expression_list', null],
  ]),
};

const RUST_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['arguments', { mode: 'args' }],
    ['assignment_expression', { mode: 'rhs', field: 'right' }],
    ['field_initializer', { mode: 'value', field: 'value' }],
    ['array_expression', { mode: 'list' }],
    ['static_item', { mode: 'varinit', field: 'value' }],
    ['let_declaration', { mode: 'varinit', field: 'value' }],
  ]),
};

const JAVA_SPEC: FnRefSpec = {
  // Java 中没有裸标识符函数值——只有方法引用。
  idTypes: new Set<string>(),
  dispatch: new Map<string, CaptureRule>([
    ['argument_list', { mode: 'args' }],
    ['assignment_expression', { mode: 'rhs', field: 'right' }],
    ['variable_declarator', { mode: 'varinit', field: 'value' }],
  ]),
  special: new Set(['method_reference']),
};

const KOTLIN_SPEC: FnRefSpec = {
  idTypes: new Set<string>(),
  dispatch: new Map<string, CaptureRule>([
    ['value_arguments', { mode: 'args' }],
    ['assignment', { mode: 'rhs' }], // RHS = 最后一个命名子节点（grammar 中无字段）
  ]),
  layers: new Map<string, string | null>([['value_argument', null]]),
  special: new Set(['callable_reference', 'navigation_expression']),
};

const CSHARP_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['argument_list', { mode: 'args' }],
    ['assignment_expression', { mode: 'rhs', field: 'right' }], // 涵盖 `+=` 事件订阅
    ['initializer_expression', { mode: 'list' }],
    ['variable_declarator', { mode: 'varinit' }],
  ]),
  layers: new Map<string, string | null>([['argument', null]]),
  special: new Set(['member_access_expression']),
};

const RUBY_SPEC: FnRefSpec = {
  // Ruby 参数中的裸标识符是方法**调用**或局部变量，而非函数值——
  // 只有 `method(:name)` 惯用法（以及 `&method(:name)`）和
  // hook-DSL 符号（`before_action :authenticate`）才符合条件。
  idTypes: new Set<string>(),
  dispatch: new Map<string, CaptureRule>([
    ['argument_list', { mode: 'args' }],
    ['pair', { mode: 'value', field: 'value' }],
  ]),
  layers: new Map<string, string | null>([['block_argument', null]]),
  special: new Set(['call', 'simple_symbol']),
};

/**
 * Rails/ActiveSupport 风格 hook DSL，其符号参数命名包含类的方法：
 * 生命周期回调（`before_action`、`after_save`、`around_create`、
 * `skip_before_action`…）、`validate :method`、`set_callback`、
 * `helper_method`，以及 `rescue_from(..., with: :handler)`。
 * 不包括 `validates`（复数）——其符号命名的是**属性**，而非方法。
 */
const RUBY_HOOK_RE = /^(skip_)?(before|after|around)_[a-z_]+$/;
const RUBY_HOOK_NAMES = new Set(['validate', 'set_callback', 'helper_method', 'rescue_from']);
function isRubyHookCall(name: string): boolean {
  return RUBY_HOOK_RE.test(name) || RUBY_HOOK_NAMES.has(name);
}

const SWIFT_SPEC: FnRefSpec = {
  idTypes: new Set(['simple_identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['value_arguments', { mode: 'args' }],
    ['assignment', { mode: 'rhs', field: 'result' }],
    ['array_literal', { mode: 'list' }],
    ['property_declaration', { mode: 'varinit', field: 'value' }],
  ]),
  layers: new Map<string, string | null>([['value_argument', 'value']]),
  special: new Set(['selector_expression']),
};

const SCALA_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['arguments', { mode: 'args' }],
    ['assignment_expression', { mode: 'rhs', field: 'right' }],
    ['val_definition', { mode: 'varinit', field: 'value' }],
  ]),
  unwrap: new Map<string, string | null>([['postfix_expression', null]]), // eta-expansion `fn _`
};

const DART_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['arguments', { mode: 'args' }],
    ['assignment_expression', { mode: 'rhs', field: 'right' }],
    ['pair', { mode: 'value', field: 'value' }],
    ['list_literal', { mode: 'list' }],
    ['static_final_declaration', { mode: 'varinit' }],
  ]),
  layers: new Map<string, string | null>([['argument', null]]),
};

const LUA_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['arguments', { mode: 'args' }],
    ['assignment_statement', { mode: 'rhs' }], // RHS expression_list 子节点带 `value` 字段
    ['field', { mode: 'value', field: 'value' }], // 表字段，包括键值形式和位置形式
  ]),
  layers: new Map<string, string | null>([['expression_list', null]]),
};

const PASCAL_SPEC: FnRefSpec = {
  idTypes: new Set(['identifier']),
  dispatch: new Map<string, CaptureRule>([
    ['exprArgs', { mode: 'args' }],
    ['assignment', { mode: 'rhs', field: 'rhs' }], // OnClick := Handler
  ]),
  unwrap: new Map<string, string | null>([['exprUnary', 'operand']]), // @Handler
};

/**
 * 以字符串作为可调用参数的 PHP 核心函数——正是这种位置先验使裸字符串
 * 可信地用作函数引用。刻意仅限核心 PHP；框架注册表
 * （WordPress 的 `add_action`）如需添加应放入 frameworks/ 解析器中。
 */
const PHP_CALLABLE_HOFS = new Set([
  'array_map', 'array_filter', 'array_walk', 'array_walk_recursive', 'array_reduce',
  'usort', 'uasort', 'uksort',
  'array_udiff', 'array_udiff_assoc', 'array_uintersect', 'array_uintersect_assoc',
  'call_user_func', 'call_user_func_array',
  'forward_static_call', 'forward_static_call_array',
  'preg_replace_callback', 'preg_replace_callback_array',
  'register_shutdown_function', 'register_tick_function',
  'set_error_handler', 'set_exception_handler', 'spl_autoload_register',
  'ob_start', 'iterator_apply', 'header_register_callback',
  'is_callable',
]);

const PHP_SPEC: FnRefSpec = {
  // PHP 没有裸标识符函数值（一等可调用 `fn(...)` 已以 `calls` 边的形式提取）。
  // 以下情形符合条件：
  //  - 作为已知可调用核心函数参数的字符串（`usort($a, 'cmp_items')`）——见 PHP_CALLABLE_HOFS
  //  - 数组可调用：`[$this, 'method']`（类作用域）和
  //    `[Foo::class, 'method']`（限定形式），出现在任意调用的参数中
  idTypes: new Set<string>(),
  dispatch: new Map<string, CaptureRule>([['arguments', { mode: 'args' }]]),
  layers: new Map<string, string | null>([['argument', null]]),
  special: new Set(['encapsed_string', 'string', 'array_creation_expression']),
};

/**
 * 各语言的捕获规范。
 */
export const FN_REF_SPECS: Record<string, FnRefSpec | undefined> = {
  c: cFamilySpec(),
  cpp: cFamilySpec({ addressOfOnly: true }),
  objc: cFamilySpec({ special: ['selector_expression'] }),
  typescript: TS_JS_SPEC,
  tsx: TS_JS_SPEC,
  javascript: TS_JS_SPEC,
  jsx: TS_JS_SPEC,
  python: PYTHON_SPEC,
  go: GO_SPEC,
  rust: RUST_SPEC,
  java: JAVA_SPEC,
  kotlin: KOTLIN_SPEC,
  csharp: CSHARP_SPEC,
  php: PHP_SPEC,
  ruby: RUBY_SPEC,
  swift: SWIFT_SPEC,
  scala: SCALA_SPEC,
  dart: DART_SPEC,
  lua: LUA_SPEC,
  luau: LUA_SPEC,
  pascal: PASCAL_SPEC,
};

// ---------------------------------------------------------------------------
// 捕获
// ---------------------------------------------------------------------------

/**
 * 从已分发的容器节点中提取候选名称。返回所有函数值形式的表达式
 * 的（名称、位置）对。
 */
export function captureFnRefCandidates(
  container: SyntaxNode,
  rule: CaptureRule,
  spec: FnRefSpec,
  source: string
): FnRefCandidate[] {
  const valueNodes: SyntaxNode[] = [];

  switch (rule.mode) {
    case 'args':
    case 'list': {
      for (let i = 0; i < container.namedChildCount; i++) {
        const child = container.namedChild(i);
        if (child) valueNodes.push(child);
      }
      break;
    }
    case 'rhs': {
      const rhs = rule.field
        ? getChildByField(container, rule.field)
        : container.namedChild(container.namedChildCount - 1);
      if (rhs) {
        // 参数存储跳过：`this.status = status` / `o->cb = cb`——当被赋值成员名
        // 与 RHS 标识符相同时，RHS 是被存储的局部变量/参数，其持有的函数（如果有）
        // 在静态上不可知。其他地方同名的函数会解析到错误目标（excalidraw A/B 发现），
        // 因此跳过。
        const lhs =
          getChildByField(container, 'left') ??
          getChildByField(container, 'lhs') ??
          getChildByField(container, 'target') ??
          (container.namedChildCount >= 2 ? container.namedChild(0) : null);
        const lhsText = lhs ? getNodeText(lhs, source) : '';
        const lhsLastName = lhsText.match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*$/)?.[1];
        const rhsText = getNodeText(rhs, source).trim();
        if (lhsLastName && lhsLastName === rhsText) break;
        valueNodes.push(rhs);
      }
      break;
    }
    case 'value': {
      let value = rule.field ? getChildByField(container, rule.field) : null;
      // 无 value 字段的键值容器（Go 的 keyed_element）：值是最后一个命名子节点
      // （第一个是键）。
      if (!value && container.namedChildCount > 0) {
        value = container.namedChild(container.namedChildCount - 1);
      }
      if (value) valueNodes.push(value);
      break;
    }
    case 'varinit': {
      // 解构赋值（`const { center } = ellipse`）从 RHS 中提取数据——
      // 永远不是函数别名。若不跳过，遮蔽同名导入函数的参数会产生错误边。
      const nameNode =
        getChildByField(container, 'name') ?? getChildByField(container, 'pattern');
      if (nameNode && (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern' ||
                       nameNode.type === 'tuple_pattern' || nameNode.type === 'struct_pattern')) {
        break;
      }
      if (rule.field) {
        const value = getChildByField(container, rule.field);
        if (value) valueNodes.push(value);
      } else {
        // 此 grammar 中没有 value 字段（C# 的 variable_declarator、Dart 的
        // static_final_declaration）：初始化值是最后一个命名子节点——
        // 但没有初始化器的声明符其名称就在那里。
        // 要求 ≥2 个命名子节点，且绝不选取 name/pattern 子节点。
        const value = container.namedChild(container.namedChildCount - 1);
        const nameChild =
          getChildByField(container, 'name') ?? getChildByField(container, 'pattern');
        if (
          value &&
          container.namedChildCount >= 2 &&
          (!nameChild || value.id !== nameChild.id)
        ) {
          valueNodes.push(value);
        }
      }
      break;
    }
  }

  const out: FnRefCandidate[] = [];
  for (const v of valueNodes) {
    // 裸标识符是指在规范化过程中未经过 unwrap/special 引用形式的标识符。
    // C++ 的 addressOfOnly 策略（在 flush 阶段，文件作用域已知）会丢弃
    // 文件作用域初始化表之外的裸标识符。
    const explicitRef = !spec.idTypes.has(v.type);
    for (const { name, node, skipGate } of normalizeValue(v, spec, source, 0)) {
      if (!name || NAME_STOPLIST.has(name)) continue;
      out.push({
        name,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        mode: rule.mode,
        explicitRef,
        skipGate,
      });
    }
  }
  return out;
}

/** 一个规范化的函数值：其名称、源节点及门控策略。 */
interface NormalizedRef {
  name: string;
  node: SyntaxNode;
  skipGate?: boolean;
}

/**
 * 将一个值表达式规范化为零个或多个函数名。递归有界（仅限包装层）；
 * 不属于已识别函数值形式的节点返回 []。
 */
function normalizeValue(
  node: SyntaxNode,
  spec: FnRefSpec,
  source: string,
  depth: number
): NormalizedRef[] {
  if (depth > 4) return [];
  const type = node.type;

  // 裸标识符
  if (spec.idTypes.has(type)) {
    return [{ name: getNodeText(node, source), node }];
  }

  // 透明层（argument、value_argument、literal_element、
  // expression_list、block_argument）。expression_list 展开（Go `a, b = f, g`）。
  const layerField = spec.layers?.get(type);
  if (spec.layers?.has(type)) {
    // 标签参数前传跳过（Swift/Kotlin）：`value: value` / `delay: delay`——
    // 当标签与值标识符相同时，该值是被转发的局部变量/参数，而非函数引用
    // （Alamofire A/B 发现；与 `this.x = x` 赋值跳过的理由相同）。
    if (type === 'value_argument') {
      const label = getChildByField(node, 'name');
      const value = getChildByField(node, 'value') ?? node.namedChild(node.namedChildCount - 1);
      if (
        label &&
        value &&
        getNodeText(label, source).trim() === getNodeText(value, source).trim()
      ) {
        return [];
      }
    }
    if (layerField) {
      const inner = getChildByField(node, layerField);
      return inner ? normalizeValue(inner, spec, source, depth + 1) : [];
    }
    const results: NormalizedRef[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) results.push(...normalizeValue(child, spec, source, depth + 1));
    }
    return results;
  }

  // 一元包装器：&fn / @Fn / `fn _`
  const unwrapField = spec.unwrap?.get(type);
  if (spec.unwrap?.has(type)) {
    // C 系列的 `pointer_expression` 同时覆盖 `&x`（取地址——函数值）
    // 和 `*x`（解引用——数据读取，永远不是函数值）。
    // 只有 `&` 符合条件；否则 fmt 的 `*begin` 会解析到其自由函数 `begin()`。
    if (type === 'pointer_expression' && node.child(0)?.type !== '&') return [];
    const inner = unwrapField ? getChildByField(node, unwrapField) : node.namedChild(0);
    if (!inner) return [];
    // C++ `&Widget::on_click`——保留限定名。解析会将方法限定到对应类
    // （比裸名匹配更精确，且因为 `&Cls::m` 是显式成员指针，
    // 豁免于 cpp 的裸标识符视为自由函数规则）。
    if (inner.type === 'qualified_identifier') {
      const text = getNodeText(inner, source).trim();
      return /^[A-Za-z_][\w:]*$/.test(text) ? [{ name: text, node: inner }] : [];
    }
    return normalizeValue(inner, spec, source, depth + 1);
  }

  // 特殊整节点引用形式
  if (spec.special?.has(type)) {
    return normalizeSpecial(node, type, source);
  }

  return [];
}

/** 属于给定类型之一的最右侧后代（含自身）命名子节点。 */
function lastNamedOfType(node: SyntaxNode, types: Set<string>): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (types.has(child.type)) found = child;
    const deeper = lastNamedOfType(child, types);
    if (deeper) found = deeper;
  }
  return found;
}

function normalizeSpecial(
  node: SyntaxNode,
  type: string,
  source: string
): NormalizedRef[] {
  switch (type) {
    // Java 方法引用。接收者决定解析路由（#808）：
    //   `this::run0` / `super::close` → `this.<m>`（类作用域解析器；
    //     super 走继承成员超类型通道）
    //   `Type::method`（大写字母开头）→ 限定名 `Type::method`（与该类型成员进行后缀匹配，支持跨文件）
    //   `variable::method` → 无（接收者类型在静态上不可知——属于延迟的 obj.method 类）
    case 'method_reference': {
      let last: SyntaxNode | null = null;
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child.type === 'identifier') last = child;
      }
      if (!last) return [];
      const m = getNodeText(last, source);
      const text = getNodeText(node, source);
      if (text.startsWith('this::') || text.startsWith('super::')) {
        return [{ name: `this.${m}`, node: last }];
      }
      const recv = text.match(/^([A-Z][A-Za-z0-9_]*)\s*::/);
      if (recv) {
        // `Type::method`——但 `Type::new`（构造函数引用）没有方法节点可落地；
        // 让停用词表通过裸名将其丢弃。
        return m === 'new' ? [] : [{ name: `${recv[1]}::${m}`, node: last }];
      }
      return [];
    }

    // Kotlin `::targetCb`（单段）/ `OtherClass::handle`（两段——
    // 接收者为 type_identifier；小写接收者是变量，属于延迟的 obj.method 类）。
    case 'callable_reference': {
      let receiver: SyntaxNode | null = null;
      let member: SyntaxNode | null = null;
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'type_identifier') receiver = child;
        if (child.type === 'simple_identifier') member = child;
      }
      if (!member) return [];
      const m = getNodeText(member, source);
      if (!receiver) return [{ name: m, node: member }]; // ::topLevelFn
      const recvText = getNodeText(receiver, source);
      return /^[A-Z]/.test(recvText)
        ? [{ name: `${recvText}::${m}`, node: member }]
        : []; // variable::method——接收者类型未知
    }

    // Kotlin `this::fire` 解析为带 `::fire` navigation_suffix 的 navigation_expression——
    // 路由到类作用域的 `this.` 解析器。
    // 普通的 `a.b` 导航（以及任何非 `this` 的接收者）必须返回空。
    case 'navigation_expression': {
      if (!getNodeText(node, source).startsWith('this::')) return [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && child.type === 'navigation_suffix' && getNodeText(child, source).startsWith('::')) {
          const id = child.namedChild(child.namedChildCount - 1);
          if (id) return [{ name: `this.${getNodeText(id, source)}`, node: id }];
        }
      }
      return [];
    }

    // Swift `#selector(Holder.fire)` → fire。ObjC `@selector(storeImage:)` →
    // 原样输出 `storeImage:`（ObjC 方法节点保留选择器冒号）。
    case 'selector_expression': {
      const inner = node.namedChild(0);
      if (!inner) return [];
      if (inner.type === 'identifier' || inner.type === 'simple_identifier') {
        return [{ name: getNodeText(inner, source), node: inner }];
      }
      // Swift 点分隔形式：最右侧的 simple_identifier。ObjC 关键字选择器：原样输出。
      const last = lastNamedOfType(node, new Set(['simple_identifier']));
      if (last) return [{ name: getNodeText(last, source), node: last }];
      return [{ name: getNodeText(inner, source).trim(), node: inner }];
    }

    // Ruby `method(:target_cb)`——方法字面量为 `method`、带单个符号参数的 `call`。
    case 'call': {
      const method = getChildByField(node, 'method');
      if (!method || getNodeText(method, source) !== 'method') return [];
      const args = getChildByField(node, 'arguments');
      if (!args || args.namedChildCount !== 1) return [];
      const sym = args.namedChild(0);
      if (!sym || sym.type !== 'simple_symbol') return [];
      const name = getNodeText(sym, source).replace(/^:/, '');
      return name ? [{ name, node: sym }] : [];
    }

    // `this.handleClick`（TS/JS）——对象必须恰好是 `this`。名称保留 `this.` 前缀，
    // 以便解析器将其限定到所在类（见 resolveThisMemberFnRef），而非裸名匹配。
    case 'member_expression': {
      const obj = getChildByField(node, 'object');
      const prop = getChildByField(node, 'property');
      if (obj && prop && obj.type === 'this' && prop.type === 'property_identifier') {
        return [{ name: `this.${getNodeText(prop, source)}`, node: prop }];
      }
      return [];
    }

    // `self.handle_click`（Python）——对象必须恰好是 `self`。
    case 'attribute': {
      const obj = getChildByField(node, 'object');
      const attr = getChildByField(node, 'attribute');
      if (obj && attr && obj.type === 'identifier' && getNodeText(obj, source) === 'self') {
        return [{ name: getNodeText(attr, source), node: attr }];
      }
      return [];
    }

    // `this.Run0`（C#）——接收者必须恰好是 `this`。两种 grammar 形态：
    // 新版 tree-sitter-c-sharp 暴露包含 `this_expression` 的 `expression` 字段；
    // 旧版 grammar 将 `this` 保留为匿名 token（只有 `name` 字段是命名子节点），
    // 因此回退到节点文本。
    case 'member_access_expression': {
      const name = getChildByField(node, 'name');
      if (!name) return [];
      const expr = getChildByField(node, 'expression');
      const isThisReceiver = expr
        ? expr.type === 'this_expression' || expr.type === 'this'
        : getNodeText(node, source).startsWith('this.');
      return isThisReceiver ? [{ name: getNodeText(name, source), node: name }] : [];
    }

    // PHP 字符串可调用对象——仅作为已知可调用核心函数的参数时才可信
    // （`usort($a, 'cmp_items')`）。PHP 全局函数无需导入即可跨文件引用，
    // 因此跳过名称门控，依赖解析器的唯一或丢弃规则。
    // `'Cls::method'` 字符串成为限定候选。
    case 'encapsed_string':
    case 'string': {
      const callee = phpEnclosingCallName(node);
      if (!callee || !PHP_CALLABLE_HOFS.has(callee)) return [];
      const content = phpStringContent(node, source);
      if (!content) return [];
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(content)) {
        return [{ name: content, node, skipGate: true }];
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/.test(content)) {
        return [{ name: content, node, skipGate: true }];
      }
      return [];
    }

    // PHP 数组可调用对象，在任意调用的参数中均有效（形式本身无歧义）：
    // `[$this, 'method']` → 类作用域 `this.method`；
    // `[Foo::class, 'method']` → 限定名 `Foo::method`。
    case 'array_creation_expression': {
      if (node.namedChildCount !== 2) return [];
      const recv = node.namedChild(0)?.namedChild(0);
      const strEl = node.namedChild(1)?.namedChild(0);
      if (!recv || !strEl) return [];
      if (strEl.type !== 'encapsed_string' && strEl.type !== 'string') return [];
      const member = phpStringContent(strEl, source);
      if (!member || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(member)) return [];
      if (recv.type === 'variable_name' && getNodeText(recv, source) === '$this') {
        return [{ name: `this.${member}`, node: strEl }];
      }
      if (recv.type === 'class_constant_access_expression') {
        const cls = recv.namedChild(0);
        const kw = recv.namedChild(1);
        if (cls && kw && getNodeText(kw, source) === 'class') {
          return [{ name: `${getNodeText(cls, source)}::${member}`, node: strEl }];
        }
      }
      return [];
    }

    // Ruby hook-DSL 符号（`before_action :authenticate`、
    // `rescue_from E, with: :render_404`）：符号命名的是所在类的方法——
    // 路由到类作用域的 `this.` 解析器（同时遍历超类，涵盖 ApplicationController
    // 风格的继承）。其他调用下的符号返回空。
    case 'simple_symbol': {
      const call = rubyEnclosingCall(node);
      if (!call) return [];
      const method = getChildByField(call, 'method');
      if (!method || !isRubyHookCall(getNodeText(method, source))) return [];
      const sym = getNodeText(node, source).replace(/^:/, '');
      if (!/^[A-Za-z_][A-Za-z0-9_?!]*$/.test(sym)) return [];
      return [{ name: `this.${sym}`, node }];
    }

    default:
      return [];
  }
}

/** PHP 字符串字面量节点（单引号或双引号）的内容。 */
function phpStringContent(node: SyntaxNode, source: string): string | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'string_content') return getNodeText(child, source).trim();
  }
  return null;
}

/** 包含 `node` 的 PHP 调用的函数名（如有）。 */
function phpEnclosingCallName(node: SyntaxNode): string | null {
  let cur: SyntaxNode | null = node.parent;
  for (let hops = 0; cur && hops < 4; hops++, cur = cur.parent) {
    if (cur.type === 'function_call_expression') {
      const fn = getChildByField(cur, 'function');
      return fn ? fn.text : null;
    }
    if (cur.type === 'member_call_expression' || cur.type === 'scoped_call_expression') {
      return null; // 方法调用不是核心 HOF
    }
  }
  return null;
}

/** argument_list（或关键字对）包含 `node` 的 Ruby `call` 节点。 */
function rubyEnclosingCall(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node.parent;
  for (let hops = 0; cur && hops < 4; hops++, cur = cur.parent) {
    if (cur.type === 'call') return cur;
  }
  return null;
}
