import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

function getValVarName(node: SyntaxNode, source: string): string | null {
  const patternNode = node.childForFieldName('pattern');
  if (!patternNode) return null;
  if (patternNode.type === 'identifier') return getNodeText(patternNode, source);
  const identChild = patternNode.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
  return identChild ? getNodeText(identChild, source) : null;
}

// 大写的 Scala 原始类型/常用别名，不应创建引用。
const SCALA_BUILTIN_TYPES = new Set([
  'Int', 'Long', 'Short', 'Byte', 'Float', 'Double', 'Boolean', 'Char', 'Unit',
  'String', 'Any', 'AnyRef', 'AnyVal', 'Nothing', 'Null',
]);

/**
 * 为 Scala 类型子树（`val`/`var` 类型注解）中的每个 type_identifier 触发 `references` 边，
 * 解包 `generic_type` 等。镜像核心提取器对方法参数/返回类型运行的通用类型注解提取，
 * 但 Scala `val` 在 visitNode 中创建，因此其类型也在此处遍历。
 * 仅作为字段类型使用的 trait（常见的 `implicit val x: Monoid[Int]` 实例模式）
 * 因此也会获得依赖方。
 */
function emitScalaTypeRefs(typeNode: SyntaxNode, fromId: string, ctx: { addUnresolvedReference: (r: { fromNodeId: string; referenceName: string; referenceKind: 'references'; line: number; column: number }) => void }, source: string): void {
  if (typeNode.type === 'type_identifier') {
    const name = source.substring(typeNode.startIndex, typeNode.endIndex);
    if (name && !SCALA_BUILTIN_TYPES.has(name)) {
      ctx.addUnresolvedReference({
        fromNodeId: fromId,
        referenceName: name,
        referenceKind: 'references',
        line: typeNode.startPosition.row + 1,
        column: typeNode.startPosition.column,
      });
    }
    return;
  }
  for (let i = 0; i < typeNode.namedChildCount; i++) {
    const child = typeNode.namedChild(i);
    if (child) emitScalaTypeRefs(child, fromId, ctx, source);
  }
}

/**
 * 捕获 Scala 方法的声明返回类型为裸类型名，用于链式静态工厂 / 流式调用机制
 *（#750）。`def create(): Bar` 返回 `Bar`；泛型 `List[Bar]` 返回其基类型 `List`
 *（方法在容器上，而非元素上）；限定名 `pkg.Bar` 返回 `Bar`。
 * 单例自类型（`this.type`，流式构建器惯用法）保持 undefined——
 * 其类型无法在此处恢复，链式调用会直通而不是推断错误的接收者。
 */
function extractScalaReturnType(node: SyntaxNode, source: string): string | undefined {
  const rt = node.childForFieldName('return_type');
  if (!rt) return undefined;
  const raw = getNodeText(rt, source).trim();
  if (raw.startsWith('this.')) return undefined; // `this.type` singleton — unhandled
  const base = raw
    .replace(/\[[^\]]*\]/g, '') // strip generic args: List[Bar] → List
    .replace(/\s+/g, '');
  const last = base.split('.').pop(); // qualified pkg.Bar → Bar
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

function extractVisibility(node: SyntaxNode): 'public' | 'private' | 'protected' {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'modifiers' || child.type === 'access_modifier') {
      const text = child.text;
      if (text.includes('private')) return 'private';
      if (text.includes('protected')) return 'protected';
    }
  }
  return 'public';
}

export const scalaExtractor: LanguageExtractor = {
  // 顶层 function_definition 通过 methodTypes 处理（与 Kotlin 相同模式）
  functionTypes: [],
  classTypes: ['class_definition', 'object_definition', 'trait_definition'],
  methodTypes: ['function_definition', 'function_declaration'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_definition'],
  enumMemberTypes: [],        // 在 visitNode 中处理——enum_case_definitions 包装了 case
  typeAliasTypes: ['type_definition'],
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: [],          // val/var 在 visitNode 中处理（使用 `pattern` 字段，而非 `name`）
  fieldTypes: [],
  extraClassNodeTypes: [],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getReturnType: extractScalaReturnType,
  interfaceKind: 'trait',

  classifyClassNode: (node: SyntaxNode) => {
    if (node.type === 'trait_definition') return 'trait';
    return 'class';
  },

  getSignature: (node: SyntaxNode, source: string) => {
    const params = node.childForFieldName('parameters');
    const returnType = node.childForFieldName('return_type');
    if (!params && !returnType) return undefined;
    let sig = params ? getNodeText(params, source) : '';
    if (returnType) sig += ': ' + getNodeText(returnType, source);
    return sig || undefined;
  },

  getVisibility: (node: SyntaxNode) => extractVisibility(node),

  isAsync: () => false,

  isStatic: (node: SyntaxNode) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'modifiers' && child.text.includes('static')) return true;
    }
    return false;
  },

  visitNode: (node: SyntaxNode, ctx) => {
    const t = node.type;

    // val/var：名称在 `pattern` 字段（identifier）中，而非 `name`
    if (t === 'val_definition' || t === 'var_definition') {
      const name = getValVarName(node, ctx.source);
      if (!name) return false;

      // `object` 是单例：其 `val` 是共享常量（Scala 中 `static final` 的惯用法——
      // `object Config { val Timeout = 30 }`），因此将其触发为 `constant`/`variable`，
      // 类似顶层 val，使值引用边能够指向它们。`class`/`trait`/`enum`/`given` 的 val
      // 是每实例不可变字段。`object` 和 `class` 都以 `class` 类型提取，
      // 因此区分它们的是外层定义的 AST 节点类型，而非父节点的 kind。
      let enclosingDef: string | null = null;
      for (let p = node.parent; p; p = p.parent) {
        if (
          p.type === 'class_definition' || p.type === 'trait_definition' ||
          p.type === 'enum_definition' || p.type === 'given_definition' ||
          p.type === 'object_definition'
        ) {
          enclosingDef = p.type;
          break;
        }
      }
      const isInstanceField =
        enclosingDef === 'class_definition' || enclosingDef === 'trait_definition' ||
        enclosingDef === 'enum_definition' || enclosingDef === 'given_definition';

      const kind = isInstanceField ? 'field' : (t === 'val_definition' ? 'constant' : 'variable');
      const typeNode = node.childForFieldName('type');
      const sig = typeNode
        ? `${t === 'val_definition' ? 'val' : 'var'} ${name}: ${getNodeText(typeNode, ctx.source)}`
        : undefined;

      const created = ctx.createNode(kind, name, node, { signature: sig, visibility: extractVisibility(node) });
      if (created && typeNode) emitScalaTypeRefs(typeNode, created.id, ctx, ctx.source);
      return true;
    }

    // enum_case_definitions 包装 simple_enum_case / full_enum_case 子节点
    if (t === 'enum_case_definitions') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'simple_enum_case' || child.type === 'full_enum_case') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) ctx.createNode('enum_member', getNodeText(nameNode, ctx.source), child);
        }
      }
      return true;
    }

    // extension_definition：直接访问函数体子节点，不创建容器节点
    if (t === 'extension_definition') {
      const body = node.childForFieldName('body');
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child) ctx.visitNode(child);
        }
      }
      return true;
    }

    return false;
  },

  extractImport: (node: SyntaxNode, source: string) => {
    const importText = getNodeText(node, source).trim();
    const pathNode = node.childForFieldName('path');
    if (pathNode) return { moduleName: getNodeText(pathNode, source), signature: importText };
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'identifier' || child?.type === 'stable_identifier') {
        return { moduleName: getNodeText(child, source), signature: importText };
      }
    }
    return null;
  },
};
