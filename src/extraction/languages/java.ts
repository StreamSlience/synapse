import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * tree-sitter-java 中方法 `type`（返回值）字段的节点类型，
 * 不可作为方法接收者——没有可以链式调用 `.method()` 的类。
 */
const JAVA_NON_CLASS_RETURN_NODES = new Set([
  'void_type',
  'integral_type', // int, long, short, byte, char
  'floating_point_type', // float, double
  'boolean_type',
]);

/**
 * Java 方法的声明返回类型，规范化为可用于链式调用 `Foo.getInstance().bar()`
 * 的裸类名（#645/#608 机制）。读取 `type` 字段：基本类型/void/数组返回 undefined
 *（没有可链式调用的类），`List<Foo>` 解包为其基类型 `List`，
 * 带点的包/外层类限定符（`java.util.List`）缩减为简单名称。
 * 构造函数没有 `type` 字段，返回 undefined。
 */
function extractJavaReturnType(node: SyntaxNode, source: string): string | undefined {
  const typeNode = getChildByField(node, 'type');
  if (!typeNode) return undefined;
  if (JAVA_NON_CLASS_RETURN_NODES.has(typeNode.type)) return undefined;
  // 数组返回值（`Foo[]`）不是可以调用实例方法的接收者。
  if (typeNode.type === 'array_type') return undefined;
  // 去除类型参数（`List<Foo>` → `List`）——链式调用在基类型上解析。
  const raw = getNodeText(typeNode, source).trim().replace(/<[^>]*>/g, '');
  // 去除带点的包 / 外层类限定符（`java.util.List` → `List`）。
  const last = raw.split('.').pop()?.trim();
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

export const javaExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  // `annotation_type_declaration` 即 `@interface Foo { … }`——注解定义。
  // 若不包含这些，注解类型（`@SerializedName`、`@GetMapping`、
  // JPA/Spring 注解）就不是节点，已提取的 `@Foo` 用法无法解析，
  // 注解文件也显示零依赖方。
  interfaceTypes: ['interface_declaration', 'annotation_type_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: [],
  importTypes: ['import_declaration'],
  callTypes: ['method_invocation'],
  variableTypes: ['local_variable_declaration'],
  fieldTypes: ['field_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  getReturnType: extractJavaReturnType,
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'type');
    if (!params) return undefined;
    const paramsText = getNodeText(params, source);
    return returnType ? getNodeText(returnType, source) + ' ' + paramsText : paramsText;
  },
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('protected')) return 'protected';
      }
    }
    return undefined;
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers' && child.text.includes('static')) {
        return true;
      }
    }
    return false;
  },
  // `static final` 字段是 Java 常量（`MAX_ITEMS`、查找表、共享配置）。
  // 驱动 `constant` 类型以便值引用边指向它；
  // 实例 / 仅 `final` / 仅 `static` 字段保持为可变 `field`。
  isConst: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        const text = child.text;
        return /\bstatic\b/.test(text) && /\bfinal\b/.test(text);
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const scopedId = node.namedChildren.find((c: SyntaxNode) => c.type === 'scoped_identifier');
    if (scopedId) {
      const moduleName = source.substring(scopedId.startIndex, scopedId.endIndex);
      return { moduleName, signature: importText };
    }
    return null;
  },
  packageTypes: ['package_declaration'],
  extractPackage: (node, source) => {
    // package_declaration → scoped_identifier 或 identifier（单段）
    const id = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'scoped_identifier' || c.type === 'identifier'
    );
    return id ? source.substring(id.startIndex, id.endIndex).trim() : null;
  },
};
