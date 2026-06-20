import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * 在解析前将 C# 条件编译指令行（`#if` / `#elif` / `#else` / `#endif`）清空。
 * 内置的 tree-sitter-c-sharp 语法对出现在*枚举成员列表内部*的 `#if` 会解析错误——
 * 这是典型的多目标构建形式：
 *
 *   enum ReadType {
 *   #if HAVE_DATE_TIME_OFFSET
 *       ReadAsDateTimeOffset,
 *   #endif
 *       ReadAsDouble,
 *   }
 *
 * 它会产生 ERROR 节点，对于嵌套枚举，该 ERROR 会断开*外层类的*成员列表，
 * 导致类的大部分方法从索引中丢失。删除指令行（保留被守护的代码）可绕过此问题。
 * `#if/#else` 的两个分支都保留——与旧语法的行为一致，也是代码图的正确默认值
 *（无论构建标志如何，对所有符号都进行索引）。替换保留字节偏移量
 *（指令文本 → 空格，换行保留），确保每个符号的行/列位置完全准确。(#237)
 */
export function blankCsharpPreprocessorDirectives(source: string): string {
  if (source.indexOf('#') === -1) return source;
  // 仅处理条件编译指令。`#region`/`#pragma`/`#nullable`
  // 可以正常解析，保持不变。指令必须是其行上的第一个非空格 token
  //（C# 要求），因此锚定到行首。
  const re = /^([ \t]*)#[ \t]*(if|elif|else|endif)\b[^\n]*/gm;
  return source.replace(re, (m, indent) => indent + ' '.repeat(m.length - indent.length));
}

/**
 * C# 方法的声明返回类型，规范化为可用于链式调用 `Foo.Create().Bar()` 的裸类名
 *（#645/#608 机制）。返回类型位于 `returns` 字段中（`static Foo Create()` → `Foo`）；
 * 内置 `predefined_type`（void/int/string/…）和数组返回 undefined，泛型解包为基类型，
 * 可空 `Foo?` 被去除，带点命名空间的类型缩减为简单名称。
 * 构造函数没有 `returns` 字段，返回 undefined。
 */
function extractCsharpReturnType(node: SyntaxNode, source: string): string | undefined {
  const typeNode = node.childForFieldName('returns');
  if (!typeNode) return undefined;
  if (typeNode.type === 'predefined_type' || typeNode.type === 'array_type') return undefined;
  let t = getNodeText(typeNode, source).trim();
  t = t.replace(/\?+$/, ''); // nullable `Foo?`
  t = t.replace(/<[^>]*>/g, ''); // generics `List<Foo>` → `List`
  const last = t.split('.').pop()?.trim(); // namespace `Ns.Foo` → `Foo`
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

export const csharpExtractor: LanguageExtractor = {
  preParse: blankCsharpPreprocessorDirectives,
  functionTypes: [],
  // Record 是现代 C# 中的一等类型声明（DTO、值对象、MediatR/CQRS 消息）。
  // 若不包含这些，对 record 的引用将永远无法解析（#237）。
  // 已发布的语法将所有 record 形式都解析为 record_declaration——
  // 包括 `record struct` / `readonly record struct`（不存在
  // record_struct_declaration 节点；structTypes 中的条目仅为前向兼容）
  // ——因此 classifyClassNode 通过 `struct` 关键字子节点来区分值类型形式。(#831 跟进)
  classTypes: ['class_declaration', 'record_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: ['struct_declaration', 'record_struct_declaration'],
  classifyClassNode: (node) => {
    if (node.type === 'record_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        if (node.child(i)?.type === 'struct') return 'struct';
      }
    }
    return 'class';
  },
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_member_declaration'],
  typeAliasTypes: [],
  // 命名空间限定类型名称，使不同命名空间中同名类型可区分
  //（例如 `ApplicationCore.Entities.CatalogBrand` 与
  // `BlazorShared.Models.CatalogBrand`）。块形式（`namespace Foo { … }`，嵌套类型）
  // 和文件作用域形式（`namespace Foo;`）均支持——
  // extractFilePackage 将命名空间压栈，使嵌套/顶层类型能够获取它。
  packageTypes: ['namespace_declaration', 'file_scoped_namespace_declaration'],
  extractPackage: (node: SyntaxNode, source: string) => {
    const name =
      node.childForFieldName('name') ??
      node.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name' || c.type === 'identifier');
    return name ? getNodeText(name, source) : null;
  },
  importTypes: ['using_directive'],
  callTypes: ['invocation_expression'],
  variableTypes: ['local_declaration_statement'],
  fieldTypes: ['field_declaration'],
  propertyTypes: ['property_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  getReturnType: extractCsharpReturnType,
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifier') {
        const text = child.text;
        if (text === 'public') return 'public';
        if (text === 'private') return 'private';
        if (text === 'protected') return 'protected';
        if (text === 'internal') return 'internal';
      }
    }
    return 'private'; // C# 默认为 private
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifier' && child.text === 'static') {
        return true;
      }
    }
    return false;
  },
  // `const` 和 `static readonly` 字段是 C# 常量（`MaxItems`、查找表、共享配置）。
  // 驱动 `constant` 类型以便值引用边指向它们；实例 `readonly` / 普通 `static` 字段保持为 `field`。
  isConst: (node) => {
    let hasStatic = false;
    let hasReadonly = false;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type !== 'modifier') continue;
      const t = child.text;
      if (t === 'const') return true;
      if (t === 'static') hasStatic = true;
      else if (t === 'readonly') hasReadonly = true;
    }
    return hasStatic && hasReadonly;
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifier' && child.text === 'async') {
        return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    // C# using 指令：using System，using System.Collections.Generic，using static X，using Alias = X
    const qualifiedName = node.namedChildren.find((c: SyntaxNode) => c.type === 'qualified_name');
    if (qualifiedName) {
      return { moduleName: getNodeText(qualifiedName, source), signature: importText };
    }
    // 简单命名空间，如 "using System;" — 获取第一个标识符
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (identifier) {
      return { moduleName: getNodeText(identifier, source), signature: importText };
    }
    return null;
  },
};
