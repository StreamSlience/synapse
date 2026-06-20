import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Swift 函数的声明返回类型，规范化为可用于链式调用 `Foo.make().draw()`
 * 的裸类名（#645/#608 机制）。tree-sitter-swift 对函数名（`simple_identifier`）
 * 和返回类型（`user_type`）都使用字段名 `name`，因此 `childForFieldName` 返回的是名称；
 * 返回类型通过位置确定——名称的 `simple_identifier` 之后、函数体之前的第一个类型节点。
 * 可选值（`Foo?`）被解包；数组/元组/函数类型和 `Void` 返回 undefined。
 */
function extractSwiftReturnType(node: SyntaxNode, source: string): string | undefined {
  let seenName = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'simple_identifier' && !seenName) {
      seenName = true;
      continue;
    }
    if (!seenName) continue;
    if (child.type === 'function_body') return undefined; // 到达函数体：无返回类型
    let typeNode: SyntaxNode | null = null;
    if (child.type === 'user_type') typeNode = child;
    else if (child.type === 'optional_type') {
      typeNode = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type') ?? null;
    }
    if (typeNode) {
      // 使用整个类型节点的文本，去除泛型，然后取最后的带点段——
      // 成员类型 `KF.Builder` 解析为 `Builder`（其第一个 type_identifier 是外层的 `KF`，那是错的）。
      const name = getNodeText(typeNode, source).trim().replace(/<[^>]*>/g, '');
      const last = name.split('.').pop()?.trim();
      if (!last || !/^[A-Za-z_]\w*$/.test(last) || last === 'Void') return undefined;
      return last;
    }
  }
  return undefined;
}

export const swiftExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['function_declaration'], // 方法是类内部的函数
  interfaceTypes: ['protocol_declaration'],
  structTypes: ['struct_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_entry'],
  typeAliasTypes: ['typealias_declaration'],
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['property_declaration', 'constant_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameter',
  returnField: 'return_type',
  getReturnType: extractSwiftReturnType,
  resolveName: (node, source) => {
    // 嵌套类型扩展 `extension KF.Builder { … }` 解析为
    // class_declaration，其 `name` 是多段 `user_type`（`KF.Builder`
    // = type_identifiers `KF`、`Builder`）。以最后一段（`Builder`）命名节点，
    // 使其与被扩展类型自身声明（`struct Builder` → `KF::Builder`）共享简单名称，
    // 而不是成为独立的 `KF.Builder` 节点。否则，扩展的协议一致性和成员
    // 对该类型的链式调用不可见——超类型查找和方法匹配都以简单名称为键（#750）。
    // 简单名称（普通 class/struct/enum 或 `extension Plain`）直通到默认提取。
    if (node.type !== 'class_declaration') return undefined;
    const nameNode = getChildByField(node, 'name');
    if (!nameNode || nameNode.type !== 'user_type') return undefined;
    const ids = nameNode.namedChildren.filter((c: SyntaxNode) => c.type === 'type_identifier');
    return ids.length > 1 ? getNodeText(ids[ids.length - 1]!, source) : undefined;
  },
  getSignature: (node, source) => {
    // Swift 函数签名：func name(params) -> ReturnType
    const params = getChildByField(node, 'parameter');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  getVisibility: (node) => {
    // 检查 Swift 中的可见性修饰符
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('internal')) return 'internal';
        if (text.includes('fileprivate')) return 'private';
      }
    }
    return 'internal'; // Swift 默认为 internal
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        if (child.text.includes('static') || child.text.includes('class')) {
          return true;
        }
      }
    }
    return false;
  },
  classifyClassNode: (node) => {
    // Swift 对 class、struct 和 enum 复用 class_declaration
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'struct') return 'struct';
      if (child?.type === 'enum') return 'enum';
    }
    return 'class';
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers' && child.text.includes('async')) {
        return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (identifier) {
      return { moduleName: source.substring(identifier.startIndex, identifier.endIndex), signature: importText };
    }
    return null;
  },
};
