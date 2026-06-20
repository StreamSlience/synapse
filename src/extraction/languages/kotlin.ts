import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/** 不能作为链式调用接收者的 Kotlin 返回类型（没有可链式调用的类）。 */
const KOTLIN_NON_CLASS_RETURN = new Set(['Unit', 'Nothing']);

/**
 * Kotlin 函数的声明返回类型，规范化为可用于链式调用 `Foo.getInstance().bar()`
 * 的裸类名（#645/#608 机制）。tree-sitter-kotlin 不暴露字段名，
 * 因此返回类型通过位置确定：`function_value_parameters` 之后的第一个
 * `user_type` / `nullable_type`（扩展接收者的类型位于参数之前，
 * 永远不会被误认为是返回值）。推断返回值（表达式体，无 `: Type`）、
 * lambda 返回类型，或 `Unit` / `Nothing` → undefined。
 */
function extractKotlinReturnType(node: SyntaxNode, source: string): string | undefined {
  let seenParams = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'function_value_parameters') {
      seenParams = true;
      continue;
    }
    if (!seenParams) continue;
    // 返回类型是紧跟参数之后的类型节点。如果先遇到
    // 函数体或 `where` 子句，则没有声明的返回类型。
    if (child.type === 'function_body' || child.type === 'type_constraints') return undefined;
    if (child.type === 'user_type' || child.type === 'nullable_type') {
      const ut =
        child.type === 'nullable_type'
          ? (child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type') ?? child)
          : child;
      const typeId = ut.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      const name = getNodeText(typeId ?? ut, source).trim();
      if (!name || !/^[A-Za-z_]\w*$/.test(name)) return undefined;
      if (KOTLIN_NON_CLASS_RETURN.has(name)) return undefined;
      return name;
    }
  }
  return undefined;
}

/** 检查节点是否匹配 `fun interface` 误解析模式 */
function isFunInterfaceNode(node: SyntaxNode): boolean {
  let hasFun = false;
  let hasInterfaceType = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'fun' && !child.isNamed) hasFun = true;
    if (child.type === 'user_type') {
      const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      if (typeId && typeId.text === 'interface') hasInterfaceType = true;
    }
    // 模式 2b：user_type("interface") 在 ERROR 子节点内
    if (child.type === 'ERROR') {
      for (let j = 0; j < child.childCount; j++) {
        const gc = child.child(j);
        if (gc && gc.type === 'user_type') {
          const typeId = gc.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
          if (typeId && typeId.text === 'interface') hasInterfaceType = true;
        }
      }
    }
  }
  return hasFun && hasInterfaceType;
}

export const kotlinExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['function_declaration'], // 方法是类内部的函数
  interfaceTypes: [], // 通过 classifyClassNode 处理
  structTypes: [], // Kotlin 使用数据类
  enumTypes: [], // 通过 classifyClassNode 处理
  enumMemberTypes: ['enum_entry'],
  typeAliasTypes: ['type_alias'],
  importTypes: ['import_header'],
  callTypes: ['call_expression'],
  variableTypes: ['property_declaration'],
  fieldTypes: ['property_declaration'],
  extraClassNodeTypes: ['object_declaration'],
  nameField: 'simple_identifier',
  bodyField: 'function_body',
  visitNode: (node, ctx) => {
    // Kotlin 属性（`val` / `var` / `const val`）。名称嵌套为
    // property_declaration → variable_declaration → simple_identifier，
    // 通用 variable/field 路径无法读取——因此之前什么都没有提取。
    // 按外层作用域分类：单例 `object` / `companion object`（以及顶层属性）
    // 持有*共享*值——`val`→`constant`，`var`→`variable`（Scala object 规则；
    // `const val` 也是 `val`）。`class`/`interface`/`enum` 的实例 `val`/`var`
    // 是每实例状态 → `field`（永远不是值引用目标，类似 Java 实例 `final`）。
    // 函数体 / `init` 块 / lambda 内的属性是局部变量，完全跳过。
    if (node.type === 'property_declaration') {
      const varDecl = node.namedChildren.find((c) => c.type === 'variable_declaration');
      const nameNode = varDecl?.namedChildren.find((c) => c.type === 'simple_identifier');
      if (!nameNode) return false; // destructuring `val (a,b)` etc. — leave to default
      const name = getNodeText(nameNode, ctx.source);
      if (!name) return false;

      // 走到最近的外层定义：函数体 / init / lambda
      // 表示这是局部变量；`object`/`companion object` 是常量作用域；
      // `class_declaration`（涵盖 class/interface/enum）是实例作用域。
      let scope: 'local' | 'const' | 'instance' = 'const';
      for (let p = node.parent; p; p = p.parent) {
        const pt = p.type;
        if (
          pt === 'function_body' || pt === 'function_declaration' ||
          pt === 'lambda_literal' || pt === 'anonymous_initializer' ||
          pt === 'control_structure_body' || pt === 'getter' || pt === 'setter'
        ) { scope = 'local'; break; }
        if (pt === 'companion_object' || pt === 'object_declaration') { scope = 'const'; break; }
        if (pt === 'class_declaration') { scope = 'instance'; break; }
      }
      if (scope === 'local') return true; // a local — don't extract

      const binding = node.namedChildren.find((c) => c.type === 'binding_pattern_kind');
      const isVal = binding != null && getNodeText(binding, ctx.source) === 'val';
      const kind = scope === 'instance' ? 'field' : isVal ? 'constant' : 'variable';

      const typeNode = node.childForFieldName('type');
      const sig = typeNode
        ? `${isVal ? 'val' : 'var'} ${name}: ${getNodeText(typeNode, ctx.source)}`
        : undefined;
      ctx.createNode(kind, name, node, { signature: sig });
      return true;
    }

    // 处理 Kotlin `fun interface` 声明。
    // tree-sitter-kotlin 不支持 `fun interface` 语法（Kotlin 1.4+）。
    // 它产生两种不同的误解析模式：
    //   模式 1（简单）：ERROR 节点 + 兄弟 lambda_literal 作为函数体
    //   模式 2（复杂）：function_declaration 误解析，含 ERROR 子节点
    // 跳过已被 fun interface ERROR 节点消费的 lambda_literal 函数体
    if (node.type === 'lambda_literal') {
      const prev = node.previousSibling;
      if (prev && prev.type === 'ERROR' && isFunInterfaceNode(prev)) return true;
      return false;
    }

    if (node.type !== 'ERROR' && node.type !== 'function_declaration') return false;

    // 跳过类体的 ERROR 节点（以 `{` 开头）。这些节点包含父类
    // 的方法 + 尾部 `fun interface` token。方法通过 resolveBody 提取；
    // 在此处理 ERROR 会消费整个函数体。
    if (node.type === 'ERROR') {
      const firstChild = node.child(0);
      if (firstChild && firstChild.type === '{') return false;
    }

    if (!isFunInterfaceNode(node)) return false;

    // 提取接口名称。
    // 对于 function_declaration 误解析（模式 2a/2b），真实名称在
    // ERROR 子节点内——直接的 simple_identifier 子节点是被误解析的方法名。
    let nameText: string | null = null;
    if (node.type === 'function_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === 'ERROR') {
          for (let j = 0; j < child.childCount; j++) {
            const gc = child.child(j);
            if (gc && gc.type === 'simple_identifier') {
              nameText = gc.text;
              break;
            }
          }
          if (nameText) break;
        }
      }
    }
    // 回退：直接的 simple_identifier 子节点（模式 1：顶层 ERROR 节点）
    if (!nameText) {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child && child.type === 'simple_identifier') {
          nameText = child.text;
          break;
        }
      }
    }
    if (!nameText) return false;

    // 创建接口节点
    const ifaceNode = ctx.createNode('interface', nameText, node);
    if (!ifaceNode) return false;

    ctx.pushScope(ifaceNode.id);

    if (node.type === 'ERROR') {
      // 模式 1：函数体在下一个兄弟 lambda_literal 中
      const nextSibling = node.nextSibling;
      if (nextSibling && nextSibling.type === 'lambda_literal') {
        for (let i = 0; i < nextSibling.namedChildCount; i++) {
          const child = nextSibling.namedChild(i);
          if (child && child.type === 'statements') {
            for (let j = 0; j < child.namedChildCount; j++) {
              const stmt = child.namedChild(j);
              if (stmt) ctx.visitNode(stmt);
            }
          }
        }
      }
    }
    // 模式 2（function_declaration）：嵌套类是 source_file 级别的兄弟节点，
    // 已由正常遍历访问。单个抽象方法被误解析，无法可靠恢复，
    // 但接口节点本身是关键值。

    ctx.popScope();
    return true;
  },
  paramsField: 'function_value_parameters',
  returnField: 'type',
  getReturnType: extractKotlinReturnType,
  resolveBody: (node, _bodyField) => {
    // Kotlin tree-sitter 语法不使用字段名，因此 getChildByField 会失败。
    // 按类型查找函数体：函数/方法用 function_body，类用 class_body，
    // 枚举用 enum_class_body。
    //
    // 特殊情况：当 class/interface 包含嵌套的 `fun interface` 时，tree-sitter
    // 将父类的函数体误解析为 ERROR 节点（以 `{` 开头），并为嵌套接口的函数体
    // 创建一个 class_body 兄弟节点。优先使用 ERROR 函数体，
    // 以便父类的方法能被正确提取。
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === 'ERROR') {
        const firstChild = child.child(0);
        if (firstChild && firstChild.type === '{') {
          return child;
        }
      }
      if (child && (child.type === 'function_body' || child.type === 'class_body' || child.type === 'enum_class_body')) {
        return child;
      }
    }
    return null;
  },
  classifyClassNode: (node) => {
    // Kotlin 对 class、interface 和 enum 复用 class_declaration。
    // 通过检查关键字子节点来区分：
    //   interface Foo { }       → 含 'interface' 关键字子节点
    //   enum class Level { }    → 含 'enum' 关键字子节点
    //   class / data class / abstract class → 默认 'class'
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.type === 'interface') return 'interface';
      if (child.type === 'enum') return 'enum';
    }
    return 'class';
  },
  getReceiverType: (node, source) => {
    // Kotlin 扩展函数：fun Type.method() { }
    // AST：function_declaration > user_type, ".", simple_identifier
    // 点前的 user_type 是接收者类型。
    let foundUserType: SyntaxNode | null = null;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.type === 'user_type') {
        foundUserType = child;
      } else if (child.type === '.' && foundUserType) {
        // 点前的 user_type 是接收者类型
        const typeId = foundUserType.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        return typeId ? getNodeText(typeId, source) : getNodeText(foundUserType, source);
      } else if (child.type === 'simple_identifier' || child.type === 'function_value_parameters') {
        // 已过函数名——无接收者
        break;
      }
    }
    return undefined;
  },
  getSignature: (node, source) => {
    // Kotlin 函数签名：fun name(params): ReturnType
    const params = getChildByField(node, 'function_value_parameters');
    const returnType = getChildByField(node, 'type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source);
    }
    return sig;
  },
  getVisibility: (node) => {
    // 检查 Kotlin 中的可见性修饰符
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('protected')) return 'protected';
        if (text.includes('internal')) return 'internal';
      }
    }
    return 'public'; // Kotlin 默认为 public
  },
  isStatic: (_node) => {
    // Kotlin 没有 static，使用 companion object
    return false;
  },
  isAsync: (node) => {
    // Kotlin 使用 suspend 关键字实现协程
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers' && child.text.includes('suspend')) {
        return true;
      }
    }
    return false;
  },
  extractModifiers: (node) => {
    // Kotlin Multiplatform 的 `expect`/`actual` 标记位于
    //   modifiers > platform_modifier > (expect | actual)
    // 捕获它们可以让解析器将公共源集中的 `expect` 声明
    // 链接到平台源集中的 `actual` 实现（否则这些实现没有依赖方——
    // 调用方会解析到 `expect`）。匹配 AST 节点而非原始文本，
    // 防止注解参数或名为 "actual" 的标识符产生误报。
    const mods: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type !== 'modifiers') continue;
      for (let j = 0; j < child.childCount; j++) {
        const pm = child.child(j);
        if (pm?.type !== 'platform_modifier') continue;
        for (let k = 0; k < pm.childCount; k++) {
          const kw = pm.child(k);
          if (kw && (kw.type === 'expect' || kw.type === 'actual')) mods.push(kw.type);
        }
      }
    }
    return mods.length > 0 ? mods : undefined;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (identifier) {
      return { moduleName: source.substring(identifier.startIndex, identifier.endIndex), signature: importText };
    }
    return null;
  },
  packageTypes: ['package_header'],
  extractPackage: (node, source) => {
    // package_header → identifier（带点：`com.example.foo`）
    const id = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    return id ? source.substring(id.startIndex, id.endIndex).trim() : null;
  },
};
