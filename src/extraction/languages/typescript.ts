import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';
import type { Node as SyntaxNode } from 'web-tree-sitter';

/**
 * TS/JS 类字段（`public_field_definition` / `field_definition`）仅当其值可调用时
 * 才是方法——箭头函数、函数表达式，或包装它们的高阶函数调用
 *（`onScroll = throttle(() => {…})`），精确镜像下方 `resolveBody` 知道如何遍历的内容。
 * 其余情况（`public fonts: Fonts;`、`count = 0`、`static defaults = {…}`）是属性。
 * 之前每个字段都以 method 类型提取（#808），这错误表示了类的形状，
 * 并破坏了基于类型的过滤——这是 #756 的函数引用解析不得不将
 * TS/JS 裸标识符限制为函数目标的原因。
 */
export function classifyTsClassMember(node: SyntaxNode): 'method' | 'property' {
  if (node.type !== 'public_field_definition' && node.type !== 'field_definition') {
    return 'method'; // method_definition, getters/setters — untouched
  }
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'arrow_function' || child.type === 'function_expression') {
      return 'method';
    }
    if (child.type === 'call_expression') {
      const args = getChildByField(child, 'arguments');
      if (args) {
        for (let j = 0; j < args.namedChildCount; j++) {
          const arg = args.namedChild(j);
          if (arg && (arg.type === 'arrow_function' || arg.type === 'function_expression')) {
            return 'method';
          }
        }
      }
    }
  }
  return 'property';
}

export const typescriptExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration', 'arrow_function', 'function_expression'],
  classTypes: ['class_declaration', 'abstract_class_declaration'],
  methodTypes: ['method_definition', 'public_field_definition'],
  classifyMethodNode: classifyTsClassMember,
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['property_identifier', 'enum_assignment'],
  typeAliasTypes: ['type_alias_declaration'],
  importTypes: ['import_statement'],
  callTypes: ['call_expression'],
  variableTypes: ['lexical_declaration', 'variable_declaration'],
  nameField: 'name',
  bodyField: 'body',
  resolveBody: (node, bodyField) => {
    // public_field_definition（箭头函数类字段）将函数体嵌套在
    // arrow_function 或 function_expression 子节点中：
    //   public_field_definition → arrow_function → body (statement_block)
    // 同样处理包装模式，如：field = withBatchedUpdates((e) => { ... })
    //   public_field_definition → call_expression → arguments → arrow_function → body
    if (node.type === 'public_field_definition') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'arrow_function' || child.type === 'function_expression') {
          return getChildByField(child, bodyField);
        }
        // 检查 call_expression 参数内部（HOF 包装器，如 throttle、debounce）
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
  returnField: 'return_type',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source).replace(/^:\s*/, '');
    }
    return sig;
  },
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'accessibility_modifier') {
        const text = child.text;
        if (text === 'public') return 'public';
        if (text === 'private') return 'private';
        if (text === 'protected') return 'protected';
      }
    }
    return undefined;
  },
  isExported: (node, _source) => {
    // 遍历父链，查找 export_statement 祖先节点。
    // 这正确处理了深层嵌套节点，如变量声明中的箭头函数：
    // `export const X = () => { ... }`
    // 其中 arrow_function 在 export_statement 下深 3 层。
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
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'static') return true;
    }
    return false;
  },
  isConst: (node) => {
    // 对于 lexical_declaration，检查是 'const' 还是 'let'
    // 对于 variable_declaration，始终是 'var'
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
