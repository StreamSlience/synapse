import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * 在 declarator 内查找函数名称的 `qualified_identifier`（`Foo::bar`），
 * 跳过 `parameter_list`——带限定类型的参数（`const std::string& x`）
 * 绝不能被误认为是方法名。若不跳过，像
 * `std::string TableFileName(const std::string&...)` 这样的普通自由函数
 * 会被命名为 `string`（来自参数类型），导致对它的调用无法解析，
 * 其所在文件看起来没有任何依赖方。
 */
function findDeclaratorQualifiedId(declarator: SyntaxNode): SyntaxNode | undefined {
  const queue: SyntaxNode[] = [declarator];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.type === 'qualified_identifier') return current;
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      // 不要深入参数列表或尾置返回类型——它们的类型
      // （`const std::string&`、`-> std::string`）不是函数名。
      if (child && child.type !== 'parameter_list' && child.type !== 'trailing_return_type') {
        queue.push(child);
      }
    }
  }
  return undefined;
}

function extractCppQualifiedMethodName(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator');
  if (!declarator) return undefined;
  const qid = findDeclaratorQualifiedId(declarator);
  if (!qid) return undefined;
  const parts = getNodeText(qid, source).trim().split('::').filter(Boolean);
  return parts[parts.length - 1];
}

function extractCppReceiverType(node: SyntaxNode, source: string): string | undefined {
  const declarator = getChildByField(node, 'declarator');
  if (!declarator) return undefined;
  const qid = findDeclaratorQualifiedId(declarator);
  if (!qid) return undefined;
  const parts = getNodeText(qid, source).trim().split('::').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('::') : undefined;
}

/**
 * 内置/非类返回类型，永远不能作为方法接收者。
 * 对这些类型不存储 `returnType`，以免解析器尝试在 `void` / `int` 等类型上解析方法。
 */
const CPP_NON_CLASS_RETURN = new Set([
  'void', 'bool', 'char', 'short', 'int', 'long', 'float', 'double', 'unsigned',
  'signed', 'size_t', 'ssize_t', 'auto', 'wchar_t', 'char8_t', 'char16_t',
  'char32_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t',
  'uint32_t', 'uint64_t', 'intptr_t', 'uintptr_t', 'nullptr_t',
]);

/**
 * 将 C++ 返回类型规范化为可以在其上调用方法的裸类名。
 * 解包智能指针 / optional 包装器到其元素类型
 *（`std::unique_ptr<Widget>` → `Widget`），使工厂的 `->method()` 可以在
 * 被指向对象上解析。去除 cv 限定符、`&`/`*`、命名空间限定符及其他模板参数。
 * 对基本类型 / void / `auto` / 空值返回 undefined。
 */
export function normalizeCppReturnType(raw: string): string | undefined {
  let t = raw.trim();
  if (!t) return undefined;
  // 解包智能指针 / optional 到其被指向对象（即调用 `->` 的对象）。
  const wrapper = t.match(/\b(?:std\s*::\s*)?(?:unique_ptr|shared_ptr|weak_ptr|optional)\s*<\s*([^,>]+?)\s*>/);
  if (wrapper && wrapper[1]) t = wrapper[1];
  t = t
    .replace(/\b(?:const|volatile|typename|struct|class|enum)\b/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return undefined;
  const last = t.split('::').filter(Boolean).pop();
  if (!last) return undefined;
  if (CPP_NON_CLASS_RETURN.has(last)) return undefined;
  if (!/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

/**
 * 函数/方法的返回类型位于 `function_definition` 的 `type` 字段中
 *（`Metrics& Metrics::instance()` → `Metrics`）。构造函数、析构函数
 * 和转换运算符没有 `type` 字段，返回 undefined。
 */
function extractCppReturnType(node: SyntaxNode, source: string): string | undefined {
  const typeNode = getChildByField(node, 'type');
  if (!typeNode) return undefined;
  return normalizeCppReturnType(getNodeText(typeNode, source));
}

export const cExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition'], // typedef
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  // `const`/`static const` 文件作用域声明带有值为 "const" 的 `type_qualifier` 子节点——
  // 将其提取为 `constant`，普通全局变量提取为 `variable`。
  isConst: (node) =>
    node.namedChildren.some(
      (c: SyntaxNode) => c.type === 'type_qualifier' && c.text === 'const'
    ),
  getReturnType: extractCppReturnType,
  resolveTypeAliasKind: (node, _source) => {
    // C typedef：`typedef enum { ... } name;` 或 `typedef struct { ... } name;`
    // 内部的 enum_specifier/struct_specifier 是匿名的，但我们希望 typedef 名称
    // 成为 enum/struct 节点的名称。
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct';
    }
    return undefined;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C includes：#include <stdio.h>，#include "myheader.h"
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },
};

export const cppExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_specifier'],
  methodTypes: ['function_definition'],
  interfaceTypes: [],
  structTypes: ['struct_specifier'],
  enumTypes: ['enum_specifier'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: ['type_definition', 'alias_declaration'], // typedef 和 using
  importTypes: ['preproc_include'],
  callTypes: ['call_expression'],
  variableTypes: ['declaration'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  resolveName: extractCppQualifiedMethodName,
  getReceiverType: extractCppReceiverType,
  getReturnType: extractCppReturnType,
  getVisibility: (node) => {
    // 检查父节点中的访问说明符
    const parent = node.parent;
    if (parent) {
      for (let i = 0; i < parent.childCount; i++) {
        const child = parent.child(i);
        if (child?.type === 'access_specifier') {
          const text = child.text;
          if (text.includes('public')) return 'public';
          if (text.includes('private')) return 'private';
          if (text.includes('protected')) return 'protected';
        }
      }
    }
    return undefined;
  },
  resolveTypeAliasKind: (node, _source) => {
    // C++ typedef：`typedef enum { ... } name;` 或 `typedef struct { ... } name;`
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'enum_specifier' && getChildByField(child, 'body')) return 'enum';
      if (child.type === 'struct_specifier' && getChildByField(child, 'body')) return 'struct';
    }
    return undefined;
  },
  isMisparsedFunction: (name) => {
    // C++ 宏（如 NLOHMANN_JSON_NAMESPACE_BEGIN）会导致 tree-sitter 将
    // namespace 块误解析为 function_definitions（例如 name = "namespace detail"）。
    // 同样过滤 C++ 关键字，tree-sitter 偶尔在宏混淆的作用域内将其误解析为
    // function/method 名称（例如 switch 语句）。
    if (name.startsWith('namespace')) return true;
    const cppKeywords = ['switch', 'if', 'for', 'while', 'do', 'case', 'return'];
    return cppKeywords.includes(name);
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C++ includes：#include <iostream>，#include "myheader.h"
    const systemLib = node.namedChildren.find((c: SyntaxNode) => c.type === 'system_lib_string');
    if (systemLib) {
      return { moduleName: getNodeText(systemLib, source).replace(/^<|>$/g, ''), signature: importText };
    }
    const stringLiteral = node.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
    if (stringLiteral) {
      const stringContent = stringLiteral.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
      if (stringContent) {
        return { moduleName: getNodeText(stringContent, source), signature: importText };
      }
    }
    return null;
  },
};
