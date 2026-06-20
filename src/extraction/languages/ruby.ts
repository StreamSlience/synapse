import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const rubyExtractor: LanguageExtractor = {
  functionTypes: ['method'],
  classTypes: ['class'],
  methodTypes: ['method', 'singleton_method'],
  interfaceTypes: [], // Ruby 使用 module（通过 visitNode 钩子处理）
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['call'], // require/require_relative
  callTypes: ['call', 'method_call'],
  variableTypes: ['assignment'], // Ruby 像 Python 一样使用赋值
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  visitNode: (node, ctx) => {
    // Ruby mixins：`include Mod`、`extend Mod`、`prepend Mod[, Other]`——
    // 主要的组合机制（ActiveSupport concerns、Comparable 等）。
    // 这些解析为对 `include`/`extend`/`prepend` 的裸 `call`，
    // 以 module 为常量参数，若不特殊处理，会被误提取为对名为 "include" 的方法的调用，
    // 被混入的 module 也不会有任何依赖方——即使它被 mixin 到了一个类中。
    // 触发 `implements` 边（外层 class/module → 被混入的 module），
    // 使编辑 concern 时能够展示每个包含它的类。
    if (node.type === 'call' && !node.childForFieldName('receiver')) {
      const method = node.childForFieldName('method');
      const mname = method?.text;
      if (mname === 'include' || mname === 'extend' || mname === 'prepend') {
        const parentId = ctx.nodeStack.length > 0 ? ctx.nodeStack[ctx.nodeStack.length - 1] : undefined;
        const args = node.childForFieldName('arguments')
          ?? node.namedChildren.find((c: SyntaxNode) => c.type === 'argument_list');
        if (parentId && args) {
          for (let i = 0; i < args.namedChildCount; i++) {
            const arg = args.namedChild(i);
            // `Mod` is `constant`, `Foo::Bar` is `scope_resolution`. Skip
            // `extend self` / dynamic args (`include foo()`).
            if (arg && (arg.type === 'constant' || arg.type === 'scope_resolution')) {
              ctx.addUnresolvedReference({
                fromNodeId: parentId,
                referenceName: getNodeText(arg, ctx.source),
                referenceKind: 'implements',
                filePath: ctx.filePath,
                line: node.startPosition.row + 1,
                column: node.startPosition.column,
              });
            }
          }
          return true; // 已处理——不再提取为对 "include" 的调用
        }
      }
    }

    if (node.type !== 'module') return false;

    const nameNode = node.childForFieldName('name');
    if (!nameNode) return false;
    const name = nameNode.text;

    const moduleNode = ctx.createNode('module', name, node);
    if (!moduleNode) return false;

    // 将 module 压栈，使子节点获得正确的限定名
    ctx.pushScope(moduleNode.id);
    const body = node.childForFieldName('body');
    if (body) {
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (child) ctx.visitNode(child);
      }
    }
    ctx.popScope();
    return true; // 已处理
  },
  extractBareCall: (node, _source) => {
    // Ruby 裸方法调用（无括号、无接收者）解析为普通标识符。
    // 例如，方法体中的 `reset` 是 `identifier "reset"` 而非 `call` 节点。
    if (node.type !== 'identifier') return undefined;

    const parent = node.parent;
    if (!parent) return undefined;

    // 仅语句级标识符——块/函数体节点的直接子节点
    const BLOCK_PARENTS = new Set([
      'body_statement', 'then', 'else', 'do', 'begin',
      'rescue', 'ensure', 'when',
    ]);
    if (!BLOCK_PARENTS.has(parent.type)) return undefined;

    const name = node.text;

    // 跳过 Ruby 关键字/字面量
    const SKIP = new Set([
      'true', 'false', 'nil', 'self', 'super',
      '__FILE__', '__LINE__', '__dir__',
    ]);
    if (SKIP.has(name)) return undefined;

    // 跳过常量（大写开头）——这些是 class/module 引用，不是调用
    if (name.length > 0 && name.charCodeAt(0) >= 65 && name.charCodeAt(0) <= 90) return undefined;

    return name;
  },
  getVisibility: (node) => {
    // Ruby 可见性基于前置可见性修饰符
    let sibling = node.previousNamedSibling;
    while (sibling) {
      if (sibling.type === 'call') {
        const methodName = getChildByField(sibling, 'method');
        if (methodName) {
          const text = methodName.text;
          if (text === 'private') return 'private';
          if (text === 'protected') return 'protected';
          if (text === 'public') return 'public';
        }
      }
      sibling = sibling.previousNamedSibling;
    }
    return 'public';
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();

    // 检查这是否是 require/require_relative 调用
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (!identifier) return null;
    const methodName = getNodeText(identifier, source);
    if (methodName !== 'require' && methodName !== 'require_relative') {
      return null; // 不是 import，跳过
    }

    // 查找参数（字符串）
    const argList = node.namedChildren.find((c: SyntaxNode) => c.type === 'argument_list');
    if (argList) {
      const stringNode = argList.namedChildren.find((c: SyntaxNode) => c.type === 'string');
      if (stringNode) {
        const stringContent = stringNode.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
        if (stringContent) {
          return { moduleName: getNodeText(stringContent, source), signature: importText };
        }
      }
    }
    return null;
  },
};
