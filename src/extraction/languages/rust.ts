import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Rust 函数的声明返回类型，规范化为可用于链式调用 `Foo::new().bar()`
 * 的裸类型（#645/#608 机制）。读取 `return_type` 字段：
 * `-> Self` 返回标记 `self`（在解析时解析为 impl 自身的类型，类似 PHP 的 `self`/`static`）；
 * 具体的 `-> Foo` / `-> FooBuilder` 返回其名称；引用（`&Foo`）被解包；
 * 泛型缩减为基类型（`Vec<Foo>` → `Vec`）；基本类型 / unit / tuple 返回 undefined。
 * 不在图中的标准库类型在后续存在性检查中自然失败。
 */
function extractRustReturnType(node: SyntaxNode, source: string): string | undefined {
  let rt = getChildByField(node, 'return_type');
  if (!rt) return undefined;
  if (rt.type === 'reference_type') {
    rt =
      rt.namedChildren.find(
        (c: SyntaxNode) =>
          c.type === 'type_identifier' ||
          c.type === 'scoped_type_identifier' ||
          c.type === 'generic_type',
      ) ?? rt;
  }
  if (!rt || rt.type === 'primitive_type' || rt.type === 'unit_type' || rt.type === 'tuple_type') {
    return undefined;
  }
  const text = getNodeText(rt, source).trim().replace(/<[^>]*>/g, '');
  const last = text.split('::').pop()?.trim();
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last === 'Self' ? 'self' : last;
}

export const rustExtractor: LanguageExtractor = {
  // `function_signature_item` 是 trait 方法声明（`fn render(&self);`，无函数体）。
  // 提取它使 trait 的方法集成为一等公民，这是 impl 导航和 trait 分发合成所需要的
  //（结构体的方法集与 trait 的方法集进行匹配）。
  functionTypes: ['function_item', 'function_signature_item'],
  classTypes: [], // Rust 有 impl 块
  methodTypes: ['function_item', 'function_signature_item'],
  interfaceTypes: ['trait_item'],
  structTypes: ['struct_item'],
  enumTypes: ['enum_item'],
  enumMemberTypes: ['enum_variant'],
  typeAliasTypes: ['type_item'], // Rust 类型别名
  importTypes: ['use_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['let_declaration', 'const_item', 'static_item'],
  interfaceKind: 'trait',
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getReturnType: extractRustReturnType,
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'async') return true;
    }
    return false;
  },
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'visibility_modifier') {
        return child.text.includes('pub') ? 'public' : 'private';
      }
    }
    return 'private'; // Rust 默认为 private
  },
  getReceiverType: (node, source) => {
    // 沿 tree-sitter AST 向上查找父 impl_item
    let parent = node.parent;
    while (parent) {
      if (parent.type === 'impl_item') {
        // 对于 `impl Type { ... }` — 类型是直接的 type_identifier 子节点
        // 对于 `impl Trait for Type { ... }` — 类型是最后一个 type_identifier
        //（第一个是 trait 路径的一部分）
        const children = parent.namedChildren;
        // 查找所有直接的 type_identifier 子节点（不嵌套在 scoped 路径中）
        const typeIdents = children.filter(
          (c: SyntaxNode) => c.type === 'type_identifier'
        );
        if (typeIdents.length > 0) {
          // 最后一个 type_identifier 始终是实现类型
          const typeNode = typeIdents[typeIdents.length - 1]!;
          return source.substring(typeNode.startIndex, typeNode.endIndex);
        }
        // 处理泛型类型：impl<T> MyStruct<T> { ... }
        const genericType = children.find(
          (c: SyntaxNode) => c.type === 'generic_type'
        );
        if (genericType) {
          const innerType = genericType.namedChildren.find(
            (c: SyntaxNode) => c.type === 'type_identifier'
          );
          if (innerType) {
            return source.substring(innerType.startIndex, innerType.endIndex);
          }
        }
        return undefined;
      }
      parent = parent.parent;
    }
    return undefined;
  },

  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    // 帮助函数：从 scoped 路径获取根 crate/module
    const getRootModule = (scopedNode: SyntaxNode): string => {
      const firstChild = scopedNode.namedChild(0);
      if (!firstChild) return source.substring(scopedNode.startIndex, scopedNode.endIndex);
      if (firstChild.type === 'identifier' ||
          firstChild.type === 'crate' ||
          firstChild.type === 'super' ||
          firstChild.type === 'self') {
        return source.substring(firstChild.startIndex, firstChild.endIndex);
      } else if (firstChild.type === 'scoped_identifier') {
        return getRootModule(firstChild);
      }
      return source.substring(firstChild.startIndex, firstChild.endIndex);
    };

    // 查找 use 参数（scoped_use_list 或 scoped_identifier）
    const useArg = node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'scoped_use_list' ||
      c.type === 'scoped_identifier' ||
      c.type === 'use_list' ||
      c.type === 'identifier'
    );

    if (useArg) {
      return { moduleName: getRootModule(useArg), signature: importText };
    }
    return null;
  },
};
