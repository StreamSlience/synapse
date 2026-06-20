import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Go 函数声明的返回类型，规范化为可用于链式调用 `New().Method()` 的裸类型
 *（#645/#608 机制）。读取 `result` 字段：指针 `*Foo` 解包为 `Foo`，
 * 多返回值 `(*Foo, error)` 取第一个结果（惯用的 value-or-error 形式），
 * 限定名 `pkg.Foo` 缩减为最后一段，泛型缩减为基类型。
 * 内置类型 / 无名返回值在后续存在性检查中自然失败。
 */
function extractGoReturnType(node: SyntaxNode, source: string): string | undefined {
  let result = getChildByField(node, 'result');
  if (!result) return undefined;
  // 多返回值 `(T, error)` → 第一个 result 的类型。
  if (result.type === 'parameter_list') {
    const first = result.namedChildren.find((c: SyntaxNode) => c.type === 'parameter_declaration');
    if (!first) return undefined;
    result = getChildByField(first, 'type') ?? first;
  }
  // 解包指针 `*Foo` → `Foo`。
  if (result?.type === 'pointer_type') {
    result =
      result.namedChildren.find(
        (c: SyntaxNode) =>
          c.type === 'type_identifier' || c.type === 'qualified_type' || c.type === 'generic_type',
      ) ?? result;
  }
  if (!result) return undefined;
  const text = getNodeText(result, source)
    .trim()
    .replace(/^\*/, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[[^\]]*\]/g, ''); // strip generic args `Foo[T]`
  const last = text.split('.').pop()?.trim(); // qualified `pkg.Foo` → `Foo`
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

export const goExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: [], // Go 没有类
  methodTypes: ['method_declaration'],
  interfaceTypes: [],  // 通过 type_spec → resolveTypeAliasKind 处理
  structTypes: [],     // 通过 type_spec → resolveTypeAliasKind 处理
  enumTypes: [],
  typeAliasTypes: ['type_spec'], // Go 类型声明
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['var_declaration', 'short_var_declaration', 'const_declaration'],
  methodsAreTopLevel: true,
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'result',
  getReturnType: extractGoReturnType,
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const result = getChildByField(node, 'result');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (result) {
      sig += ' ' + getNodeText(result, source);
    }
    return sig;
  },
  resolveTypeAliasKind: (node, _source) => {
    // Go type_spec：`type Foo struct { ... }` 或 `type Bar interface { ... }`
    // 内部类型位于 type_spec 节点的 'type' 字段中
    const typeChild = getChildByField(node, 'type');
    if (!typeChild) return undefined;
    if (typeChild.type === 'struct_type') return 'struct';
    if (typeChild.type === 'interface_type') return 'interface';
    return undefined;
  },
  isExported: (node, source) => {
    // Go：符号标识符以大写字母开头时即为导出。
    // 直接查看 `name` 字段（适用于 function_declaration、
    // method_declaration、type_spec 以及通过提取器流程处理的 var_spec / const_spec）。
    const nameNode = getChildByField(node, 'name');
    if (nameNode) {
      const text = getNodeText(nameNode, source);
      const first = text.charCodeAt(0);
      return first >= 65 && first <= 90; // A-Z
    }
    return false;
  },
  getReceiverType: (node, source) => {
    // Go method_declaration 有 "receiver" 字段：func (sl *scrapeLoop) run(...)
    // receiver 是一个 parameter_list，包含一个 parameter_declaration，
    // 其类型可以是 pointer_type (*scrapeLoop) 或普通类型 (scrapeLoop)
    const receiver = getChildByField(node, 'receiver');
    if (!receiver) return undefined;
    // 从 receiver 中提取类型标识符
    const text = getNodeText(receiver, source);
    // 从 "(sl *Type)"、"(sl Type)"、"(*Type)"、"(Type)" 以及
    // 泛型 receiver "(s *Stack[T])" 中提取类型名称。锚定到开头的 "("，
    // 跳过可选的 receiver 变量名；旧的 `name)` 锚定模式从未匹配
    // `[T])` 后缀，导致泛型类型的方法与其类型孤立（无 struct→method 的 `contains` 边）。(#583)
    const match = text.match(/\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)/);
    return match?.[1];
  },
};
