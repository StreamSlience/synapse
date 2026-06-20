import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const pascalExtractor: LanguageExtractor = {
  functionTypes: ['declProc'],
  classTypes: ['declClass'],
  methodTypes: ['declProc'],
  interfaceTypes: ['declIntf'],
  structTypes: [],
  enumTypes: ['declEnum'],
  typeAliasTypes: ['declType'],
  importTypes: ['declUses'],
  callTypes: ['exprCall'],
  variableTypes: ['declField', 'declConst'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'args',
  returnField: 'type',
  // Pascal/Delphi `function GetInstance: TBar`——返回类型是 `typeref` 子节点。
  // 捕获其裸类名用于链式静态工厂调用机制（#750）。
  // 过程（无返回值）没有 typeref，返回 undefined。
  getReturnType: (node, source) => {
    const typeref = node.namedChildren.find((c: SyntaxNode) => c.type === 'typeref');
    if (!typeref) return undefined;
    const id = typeref.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') ?? typeref;
    const name = getNodeText(id, source).trim();
    return /^[A-Za-z_]\w*$/.test(name) ? name : undefined;
  },
  getSignature: (node, source) => {
    const args = getChildByField(node, 'args');
    const returnType = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'typeref'
    );
    if (!args && !returnType) return undefined;
    let sig = '';
    if (args) sig = getNodeText(args, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source);
    }
    return sig || undefined;
  },
  getVisibility: (node) => {
    let current = node.parent;
    while (current) {
      if (current.type === 'declSection') {
        for (let i = 0; i < current.childCount; i++) {
          const child = current.child(i);
          if (child?.type === 'kPublic' || child?.type === 'kPublished')
            return 'public';
          if (child?.type === 'kPrivate') return 'private';
          if (child?.type === 'kProtected') return 'protected';
        }
      }
      current = current.parent;
    }
    return undefined;
  },
  isExported: (_node, _source) => {
    // 在 Pascal 中，接口节中声明的符号被导出
    return false;
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i)?.type === 'kClass') return true;
    }
    return false;
  },
  isConst: (node) => {
    return node.type === 'declConst';
  },
};
