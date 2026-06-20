import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';
import { classifyTsClassMember } from './typescript';

export const javascriptExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration', 'arrow_function', 'function_expression'],
  classTypes: ['class_declaration'],
  methodTypes: ['method_definition', 'field_definition'],
  // JS `field_definition` ≙ TS `public_field_definition`：普通字段是
  // 属性，函数值字段是方法（#808）。
  classifyMethodNode: classifyTsClassMember,
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement'],
  callTypes: ['call_expression'],
  variableTypes: ['lexical_declaration', 'variable_declaration'],
  nameField: 'name',
  // JS `field_definition` 的键名使用 `property` 字段（TS 的
  // public_field_definition 使用 `name`）。若不处理，JS 类字段——
  // 包括箭头函数处理器字段——提取不到名称，完全不产生节点（#808）。
  resolveName: (node, source) => {
    if (node.type === 'field_definition') {
      const prop = getChildByField(node, 'property');
      if (prop) return getNodeText(prop, source);
    }
    return undefined;
  },
  bodyField: 'body',
  resolveBody: (node, bodyField) => {
    // field_definition（箭头函数类字段）将函数体嵌套在
    // arrow_function 或 function_expression 子节点中：
    //   field_definition → arrow_function → body (statement_block)
    // 同样处理包装模式，如：field = throttle((e) => { ... })
    //   field_definition → call_expression → arguments → arrow_function → body
    if (node.type === 'field_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'arrow_function' || child.type === 'function_expression') {
          return getChildByField(child, bodyField);
        }
        if (child.type === 'call_expression') {
          const args = getChildByField(child, 'arguments');
          if (args) {
            for (let j = 0; j < args.namedChildCount; j++) {
              const arg = args.namedChild(j);
              if (arg && (arg.type === 'arrow_function' || arg.type === 'function_expression')) {
                return getChildByField(arg, bodyField);
              }
            }
          }
        }
      }
    }
    return null;
  },
  paramsField: 'parameters',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    return params ? getNodeText(params, source) : undefined;
  },
  isExported: (node, _source) => {
    let current = node.parent;
    while (current) {
      if (current.type === 'export_statement') return true;
      current = current.parent;
    }
    return false;
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'async') return true;
    }
    return false;
  },
  isConst: (node) => {
    if (node.type === 'lexical_declaration') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'const') return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const sourceField = node.childForFieldName('source');
    if (sourceField) {
      const moduleName = source.substring(sourceField.startIndex, sourceField.endIndex).replace(/['"]/g, '');
      if (moduleName) {
        return { moduleName, signature: source.substring(node.startIndex, node.endIndex).trim() };
      }
    }
    return null;
  },
};
