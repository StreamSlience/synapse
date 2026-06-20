import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * 携带方法返回类型的 `function_signature`——从 `method_signature` 包装器中解包
 *（Dart 对方法的签名嵌套了一层）。
 */
function dartInnerSignature(node: SyntaxNode): SyntaxNode {
  if (node.type === 'method_signature') {
    const inner = node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature'
    );
    if (inner) return inner;
  }
  return node;
}

/**
 * 节点内的工厂/命名构造函数签名（如有）。构造函数解析为
 * `method_signature > {factory_,}constructor_signature`（例如
 * `factory Foo.create()` 或 `Foo._()`），其子节点为类标识符，
 * 以及命名构造函数的构造函数名标识符（如有）。
 */
function dartConstructorSignature(node: SyntaxNode): SyntaxNode | undefined {
  if (node.type === 'factory_constructor_signature' || node.type === 'constructor_signature') {
    return node;
  }
  if (node.type === 'method_signature') {
    return node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'factory_constructor_signature' || c.type === 'constructor_signature'
    );
  }
  return undefined;
}

/** 词法上包含 `node` 的 class/mixin/extension/enum 的名称。 */
function dartEnclosingTypeName(node: SyntaxNode): string | undefined {
  let p = node.parent;
  while (p) {
    if (
      p.type === 'class_definition' || p.type === 'mixin_declaration' ||
      p.type === 'extension_declaration' || p.type === 'enum_declaration'
    ) {
      return p.childForFieldName('name')?.text;
    }
    p = p.parent;
  }
  return undefined;
}

/**
 * `node` 经过验证的构造函数信息，如果它不是真正的构造函数则返回 undefined。
 * 构造函数签名在结构上为 `<Class>` 或 `<Class>.<name>`，但 tree-sitter-dart
 * 会误解析 `@override (T) m()`——注解吞掉了 record 返回类型 `(T)`，
 * 使 `m()` 看起来像一个单标识符 constructor_signature。
 * 我们通过类名来消歧：真实构造函数的类标识符与外层类型匹配；
 * 误解析的方法（`Action` 类中的 `reduce`）不匹配，会被当作方法处理。
 */
function dartCtorInfo(node: SyntaxNode): { className: string; ctorName: string } | undefined {
  const ctor = dartConstructorSignature(node);
  if (!ctor) return undefined;
  const ids = ctor.namedChildren.filter((c: SyntaxNode) => c.type === 'identifier');
  const className = dartEnclosingTypeName(node);
  if (!className || !ids[0]) return undefined;
  if (ids[0].text !== className) return undefined; // misparsed method, not a ctor
  // `<Class>.<name>` is a named ctor; bare `<Class>` is the unnamed ctor.
  return { className, ctorName: ids[1]?.text ?? className };
}

/**
 * 捕获 Dart 方法/函数的声明返回类型为裸类型名，用于链式静态工厂 / 流式调用机制
 *（#750）。`Bar makeBar()` 返回 `Bar`；泛型 `List<Foo>` 返回其容器 `List`
 *（方法在容器上，而非元素上）；带前缀的 `prefix.Bar` 返回 `Bar`。
 * 工厂 / 命名构造函数隐式返回其外层类，因此其"返回类型"就是该类。
 */
function extractDartReturnType(node: SyntaxNode, source: string): string | undefined {
  const ctor = dartCtorInfo(node);
  if (ctor) return ctor.className;
  const sig = dartInnerSignature(node);
  // 返回类型先于方法名；它是第一个 type_identifier
  // （泛型参数位于兄弟节点 `type_arguments` 中，所以这是容器）。
  const retType = sig.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
  if (!retType) return undefined;
  const text = getNodeText(retType, source).replace(/<[^>]*>/g, '').trim();
  const last = text.split('.').pop(); // prefixed `p.Bar` → `Bar`
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

/**
 * `argPart` 的 argument_part 选择器所对应的 Dart 调用的被调用方名称
 * ——镜像主 extractBareCall 访问器逻辑，使链式接收者
 *（`Foo.create().bar()` 中的 `Foo.create()`）可以被重建。
 * 返回 `Foo.create`、裸 `create` 或 `Foo`（构造函数），或 undefined。
 */
function dartCalleeOfArgPart(argPart: SyntaxNode): string | undefined {
  const prev = argPart.previousNamedSibling;
  if (!prev) return undefined;
  if (prev.type === 'identifier') return prev.text; // 裸 `Foo()` / `create()`
  if (prev.type === 'selector') {
    const accessor = prev.namedChildren.find((c: SyntaxNode) =>
      c.type === 'unconditional_assignable_selector' || c.type === 'conditional_assignable_selector'
    );
    const methodId = accessor?.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (methodId) {
      const accessorPrev = prev.previousNamedSibling;
      if (accessorPrev?.type === 'identifier') return accessorPrev.text + '.' + methodId.text;
      return methodId.text;
    }
  }
  return undefined;
}

export const dartExtractor: LanguageExtractor = {
  functionTypes: ['function_signature'],
  classTypes: ['class_definition'],
  // `method_signature` 涵盖普通方法和工厂构造函数（解析为
  // method_signature > factory_constructor_signature）。普通命名构造函数
  // `Foo._()` 解析为裸 `constructor_signature`，也包含进来——
  // resolveName 以构造函数名命名，getReturnType 给它类作为返回类型，
  // 使 `Foo._().bar()` 的链式调用能够解析（#750）。
  methodTypes: ['method_signature', 'constructor_signature'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: ['type_alias'],
  importTypes: ['import_or_export'],
  callTypes: [],  // Dart 调用使用 identifier+selector，通过 extractBareCall 处理
  variableTypes: [],
  extraClassNodeTypes: ['mixin_declaration', 'extension_declaration'],
  // Dart `static_final_declaration` 正是顶层或类 `static` 的
  // `const`/`final`——共享常量的惯用法——因此将其提取为 `constant`
  // 以用于值引用边。实例字段、`var` 和带类型声明使用
  // `initialized_identifier`，方法局部变量使用
  // `initialized_variable_definition`；两者均不是此节点，
  // 因此不存在实例/局部泄漏风险。名称为第一个 `identifier`；
  // 其父作用域（`file:` 顶层 / `class:` 静态成员）来自节点栈，
  // 两者均被值引用目标门接受。
  visitNode: (node, ctx) => {
    if (node.type === 'static_final_declaration') {
      const nameNode = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (nameNode) {
        const valueNode = nameNode.nextNamedSibling;
        const initValue = valueNode ? getNodeText(valueNode, ctx.source).slice(0, 100) : undefined;
        ctx.createNode('constant', getNodeText(nameNode, ctx.source), node, {
          signature: initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined,
        });
      }
      return true;
    }
    return false;
  },
  resolveBody: (node, bodyField) => {
    // Dart：function_body 是 function_signature/method_signature 的下一个兄弟节点
    if (node.type === 'function_signature' || node.type === 'method_signature') {
      const next = node.nextNamedSibling;
      if (next?.type === 'function_body') return next;
      return null;
    }
    // 对于 class/mixin/extension：尝试标准字段，再尝试 class_body/extension_body
    const standard = node.childForFieldName(bodyField);
    if (standard) return standard;
    return node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'class_body' || c.type === 'extension_body'
    ) || null;
  },
  nameField: 'name',
  bodyField: 'body', // class_definition 使用 'body' 字段
  paramsField: 'formal_parameter_list',
  returnField: 'type',
  getReturnType: extractDartReturnType,
  isMisparsedFunction: (_name, node) => {
    // 跳过无名构造函数 `Foo()`（其构造函数名等于类名）。这是
    // 普通的实例化——对类 `Foo` 的 `instantiates` 边——因此将其提取为
    // `Foo::Foo` 方法节点会劫持实例化解析（`Foo(...)` 调用会解析到构造函数
    // 方法，而非类）。命名构造函数 `Foo.create()` / `Foo._()` 保留，
    // 以便其链式调用能够解析（#750）。dartCtorInfo 会对类名进行校验，
    // 所以 tree-sitter 误解析为构造函数的方法（`@override (T) m()`）
    // 不会在此处被跳过。
    //（isMisparsedFunction 跳过节点创建，但仍会访问函数体。）
    const ctor = dartCtorInfo(node);
    return ctor != null && ctor.ctorName === ctor.className;
  },
  getSignature: (node, source) => {
    // 对于 function_signature：提取参数 + 返回类型
    // 对于 method_signature：委托给内部 function_signature
    let sig = node;
    if (node.type === 'method_signature') {
      const inner = node.namedChildren.find((c: SyntaxNode) =>
        c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature'
      );
      if (inner) sig = inner;
    }
    const params = sig.namedChildren.find((c: SyntaxNode) => c.type === 'formal_parameter_list');
    const retType = sig.namedChildren.find((c: SyntaxNode) =>
      c.type === 'type_identifier' || c.type === 'void_type'
    );
    if (!params && !retType) return undefined;
    let result = '';
    if (retType) result += getNodeText(retType, source) + ' ';
    if (params) result += getNodeText(params, source);
    return result.trim() || undefined;
  },
  getVisibility: (node) => {
    // Dart 约定：_ 前缀表示私有，否则为公开
    let nameNode: SyntaxNode | null = null;
    if (node.type === 'method_signature') {
      const inner = node.namedChildren.find((c: SyntaxNode) =>
        c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature'
      );
      if (inner) nameNode = inner.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') || null;
    } else {
      nameNode = node.childForFieldName('name');
    }
    if (nameNode && nameNode.text.startsWith('_')) return 'private';
    return 'public';
  },
  isAsync: (node) => {
    // 在 Dart 中，'async' 位于 function_body（下一个兄弟节点）上，而非签名上
    const nextSibling = node.nextNamedSibling;
    if (nextSibling?.type === 'function_body') {
      for (let i = 0; i < nextSibling.childCount; i++) {
        const child = nextSibling.child(i);
        if (child?.type === 'async') return true;
      }
    }
    return false;
  },
  isStatic: (node) => {
    // 对于 method_signature，检查是否有 'static' 子节点
    if (node.type === 'method_signature') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'static') return true;
      }
    }
    return false;
  },
  resolveName: (node) => {
    // 以构造函数名命名工厂 / 命名构造函数——第二个标识符
    //（`factory Foo.create()` 中的 `create`，`Foo._()` 中的 `_`）——
    // 而非类名，使调用 `Foo.create()` 解析到 `Foo::create`（#750）。
    // 默认 Dart 命名返回第一个标识符（类名），会将每个命名构造函数
    // 都折叠到 `Foo::Foo`，导致 `Foo.create()` 无法解析。
    // 无名构造函数 `Foo()` 只有一个标识符——直通（undefined）到默认类名。
    // 让核心的 extractMethod 拥有工厂（而非自定义 visitNode），
    // 保证函数体归属正确：`factory Foo.create() { … }` 内的调用
    // 归属于 `Foo::create`，getReturnType 给它返回类型 Foo。
    const ctor = dartCtorInfo(node);
    // 命名构造函数 `Foo.create` → `create`；无名构造函数 `Foo()` → undefined
    //（默认命名给出类名 `Foo`，这是正确的）。
    if (ctor && ctor.ctorName !== ctor.className) return ctor.ctorName;
    return undefined;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    let moduleName = '';

    // Dart imports：import 'dart:async'; import 'package:foo/bar.dart' as bar;
    const libraryImport = node.namedChildren.find((c: SyntaxNode) => c.type === 'library_import');
    if (libraryImport) {
      const importSpec = libraryImport.namedChildren.find((c: SyntaxNode) => c.type === 'import_specification');
      if (importSpec) {
        const configurableUri = importSpec.namedChildren.find((c: SyntaxNode) => c.type === 'configurable_uri');
        if (configurableUri) {
          const uri = configurableUri.namedChildren.find((c: SyntaxNode) => c.type === 'uri');
          if (uri) {
            const stringLiteral = uri.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
            if (stringLiteral) {
              moduleName = getNodeText(stringLiteral, source).replace(/['"]/g, '');
            }
          }
        }
      }
    }

    // 同样处理 exports：export 'src/foo.dart';
    if (!moduleName) {
      const libraryExport = node.namedChildren.find((c: SyntaxNode) => c.type === 'library_export');
      if (libraryExport) {
        const configurableUri = libraryExport.namedChildren.find((c: SyntaxNode) => c.type === 'configurable_uri');
        if (configurableUri) {
          const uri = configurableUri.namedChildren.find((c: SyntaxNode) => c.type === 'uri');
          if (uri) {
            const stringLiteral = uri.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
            if (stringLiteral) {
              moduleName = getNodeText(stringLiteral, source).replace(/['"]/g, '');
            }
          }
        }
      }
    }

    if (moduleName) {
      return { moduleName, signature: importText };
    }
    return null;
  },
  extractBareCall: (node, _source) => {
    // Dart 调用形式为：identifier + selector(argument_part)，而非专用调用节点。
    // 匹配包含 argument_part 的 selector 节点。
    if (node.type === 'selector') {
      const hasArgPart = node.namedChildren.some((c: SyntaxNode) => c.type === 'argument_part');
      if (!hasArgPart) return undefined;

      const prev = node.previousNamedSibling;
      if (!prev) return undefined;

      // 简单函数/构造函数调用：prev 是 identifier（例如 runApp(...)、MyWidget(...)）
      if (prev.type === 'identifier') {
        return prev.text;
      }

      // 方法调用：prev 是带访问器的 selector（例如 obj.method(...)、Navigator.push(...)）
      if (prev.type === 'selector') {
        const accessor = prev.namedChildren.find((c: SyntaxNode) =>
          c.type === 'unconditional_assignable_selector' || c.type === 'conditional_assignable_selector'
        );
        if (accessor) {
          const methodId = accessor.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
          if (methodId) {
            // 包含链首的接收者（接收者是直接 identifier）
            const accessorPrev = prev.previousNamedSibling;
            if (accessorPrev?.type === 'identifier') {
              return accessorPrev.text + '.' + methodId.text;
            }
            // 链式静态工厂 / 流式调用：接收者本身是一次调用
            //（`Foo.create().bar()` 中的接收者），所以 accessorPrev 是该调用的
            // argument_part selector。编码为 `<innerCallee>().<method>` 使解析可以
            // 从 `Foo.create` 的返回值推断 bar 的类（#645/#608 机制）——
            // 但仅当链以大写类型开头时（伴生工厂 / 静态方法 / 构造函数）；
            // 实例链（`obj.foo().bar()`）保持裸名（其接收者的类型无法在此恢复）。
            if (accessorPrev?.type === 'selector' &&
                accessorPrev.namedChildren.some((c: SyntaxNode) => c.type === 'argument_part')) {
              const innerCallee = dartCalleeOfArgPart(accessorPrev);
              if (innerCallee && /^[A-Z]/.test(innerCallee)) {
                return `${innerCallee}().${methodId.text}`;
              }
            }
            return methodId.text;
          }
        }
      }

      // super.method() / this.method()：prev 是裸 unconditional_assignable_selector
      if (prev.type === 'unconditional_assignable_selector' || prev.type === 'conditional_assignable_selector') {
        const methodId = prev.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
        if (methodId) return methodId.text;
      }

      return undefined;
    }

    // new MyWidget() — 显式构造函数调用
    if (node.type === 'new_expression') {
      const typeId = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      if (typeId) return typeId.text;
      return undefined;
    }

    // const EdgeInsets.all(8.0) — const 构造函数调用
    if (node.type === 'const_object_expression') {
      const typeId = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      const nameId = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (typeId && nameId) return typeId.text + '.' + nameId.text;
      if (typeId) return typeId.text;
      return undefined;
    }

    return undefined;
  },
};
