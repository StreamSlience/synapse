import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// include / require（及 _once）表达式节点类型。这些节点携带过程式 PHP 中
// 的文件→文件依赖关系，其中 `include`/`require`——而非命名空间 `use`——
// 是文件引入其他文件的方式（issue #660）。
const PHP_INCLUDE_TYPES = new Set([
  'include_expression',
  'include_once_expression',
  'require_expression',
  'require_once_expression',
]);

/**
 * 从 PHP include/require 表达式中提取静态字符串字面量路径。
 *
 * 动态形式（`include $var`、`require __DIR__ . '/x'`、插值字符串）
 * 返回 null——它们没有可解析的编译期路径，这与
 * issue 中"静态字符串字面量（常见情况）"的范围一致。
 */
function phpStaticIncludePath(node: SyntaxNode, source: string): string | null {
  // 路径参数是表达式的第一个命名子节点；调用形式
  // `require("x")` 将其包装在 parenthesized_expression 中。
  let arg: SyntaxNode | null = node.namedChild(0);
  if (arg?.type === 'parenthesized_expression') arg = arg.namedChild(0);
  if (!arg || (arg.type !== 'string' && arg.type !== 'encapsed_string')) return null;
  // 仅纯字面量：任何非 `string_content` 子节点（插值变量、
  // 转义序列等）都意味着该值不是静态路径。
  const parts = arg.namedChildren;
  if (parts.some((c: SyntaxNode) => c.type !== 'string_content')) return null;
  const content = parts.find((c: SyntaxNode) => c.type === 'string_content');
  return content ? getNodeText(content, source) : null;
}

/** PHP 内置返回类型，不能作为方法接收者（没有可链式调用的类）。 */
const PHP_NON_CLASS_RETURN = new Set([
  'array', 'string', 'int', 'integer', 'float', 'double', 'bool', 'boolean',
  'void', 'mixed', 'never', 'null', 'false', 'true', 'object', 'callable',
  'iterable', 'resource',
]);

/**
 * 方法/函数的声明返回类型，规范化为可用于链式 `->method()` 调用的类
 *（issue #608）。`self` / `static` / `$this` 保留为标记 `self`，
 * 在解析时解析为声明类；具体类型返回其短名称；
 * 基本类型 / 联合类型 / 可空非类类型返回 undefined。
 */
function extractPhpReturnType(node: SyntaxNode, source: string): string | undefined {
  let rt = getChildByField(node, 'return_type');
  if (!rt) return undefined;
  // 解包 `?Type`。联合类型 / 交叉类型有歧义——跳过。
  if (rt.type === 'optional_type') rt = rt.namedChild(0) ?? rt;
  if (!rt || rt.type === 'primitive_type') return undefined;

  const nameNode = rt.type === 'named_type' ? (rt.namedChild(0) ?? rt) : rt;
  const text = getNodeText(nameNode, source).trim().replace(/^\\/, '');
  if (!text) return undefined;
  const last = text.split('\\').pop() ?? text;
  const lc = last.toLowerCase();
  if (lc === 'self' || lc === 'static' || lc === 'this' || lc === '$this') return 'self';
  if (PHP_NON_CLASS_RETURN.has(lc)) return undefined;
  if (!/^[A-Za-z_]\w*$/.test(last)) return undefined; // union/intersection/complex
  return last;
}

export const phpExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_declaration', 'trait_declaration'],
  methodTypes: ['method_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_case'],
  typeAliasTypes: [],
  importTypes: ['namespace_use_declaration', ...PHP_INCLUDE_TYPES],
  callTypes: ['function_call_expression', 'member_call_expression', 'scoped_call_expression'],
  variableTypes: ['const_declaration'],
  fieldTypes: ['property_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getReturnType: extractPhpReturnType,
  classifyClassNode: (node) => {
    return node.type === 'trait_declaration' ? 'trait' : 'class';
  },
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'visibility_modifier') {
        const text = child.text;
        if (text === 'public') return 'public';
        if (text === 'private') return 'private';
        if (text === 'protected') return 'protected';
      }
    }
    return 'public'; // PHP 默认为 public
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'static_modifier') return true;
    }
    return false;
  },
  visitNode: (node, ctx) => {
    // 处理类常量：类内的 const_declaration
    // 主访问器因 variableTypes 检查排除了类似类的上下文，所以这些被跳过
    if (node.type === 'const_declaration') {
      const constElements = node.namedChildren.filter((c: SyntaxNode) => c.type === 'const_element');
      for (const elem of constElements) {
        const nameNode = elem.namedChildren.find((c: SyntaxNode) => c.type === 'name');
        if (!nameNode) continue;
        const name = getNodeText(nameNode, ctx.source);
        ctx.createNode('constant', name, elem, {});
      }
      return true; // handled
    }

    // 处理 trait 使用：类内的 use TraitName, OtherTrait;
    // 创建将解析为 'implements' 边的未解析引用
    if (node.type === 'use_declaration') {
      const names = node.namedChildren.filter((c: SyntaxNode) => c.type === 'name' || c.type === 'qualified_name');
      const parentId = ctx.nodeStack.length > 0 ? ctx.nodeStack[ctx.nodeStack.length - 1] : undefined;
      if (parentId) {
        for (const nameNode of names) {
          const traitName = getNodeText(nameNode, ctx.source);
          ctx.addUnresolvedReference({
            fromNodeId: parentId,
            referenceName: traitName,
            referenceKind: 'implements',
            filePath: ctx.filePath,
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
      return true; // handled
    }

    return false;
  },
  // PHP `namespace Foo\Bar;` 是文件级的（类似 Java/Kotlin 包）。捕获它
  // 将每个类限定在 `Foo\Bar::` 限定名下，使 `use` 导入和同名类型
  //（Laravel 在不同命名空间下有 7 个以上的 `Factory` 接口）能够解析到
  // 正确的定义，而不是任意匹配。
  packageTypes: ['namespace_definition'],
  extractPackage: (node, source) => {
    const nsName = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
    // 跳过花括号形式 `namespace Foo { … }`（有函数体）——仅处理文件级形式。
    const hasBody = node.namedChildren.some((c: SyntaxNode) => c.type === 'compound_statement' || c.type === 'declaration_list');
    if (!nsName || hasBody) return null;
    return getNodeText(nsName, source);
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    // include / require（及 _once）：触发文件→文件依赖。路径在常见情况下
    // 是静态字符串字面量；动态形式解析为 null 并被跳过（无 import 节点，无边）。
    if (PHP_INCLUDE_TYPES.has(node.type)) {
      const includePath = phpStaticIncludePath(node, source);
      return includePath ? { moduleName: includePath, signature: importText } : null;
    }

    // 检查分组导入：use X\{A, B}——返回 null 交由核心处理
    const namespacePrefix = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
    const useGroup = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_use_group');
    if (namespacePrefix && useGroup) {
      return null; // Grouped imports create multiple nodes - let core handle
    }

    // 单一导入——查找 namespace_use_clause
    const useClause = node.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_use_clause');
    if (useClause) {
      const qualifiedName = useClause.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name');
      if (qualifiedName) {
        return { moduleName: getNodeText(qualifiedName, source), signature: importText };
      }
      const name = useClause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
      if (name) {
        return { moduleName: getNodeText(name, source), signature: importText };
      }
    }
    return null;
  },
};
