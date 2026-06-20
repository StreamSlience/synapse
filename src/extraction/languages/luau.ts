import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';
import { luaExtractor } from './lua';

// Luau（https://luau.org）是 Lua 的渐进类型超集。
// tree-sitter-luau 语法复用与内置 Lua 语法相同的节点名称
//（function_declaration、variable_declaration、function_call、
// dot/method_index_expression 等），因此 Luau 提取器扩展 Lua 提取器，
// 并添加 Luau 引入的类型系统部分：
//   - `type X = ...` / `export type X = ...`  → type_definition（类型别名）
//   - 带类型的参数和返回类型                  → 更丰富的签名
//
// require 检测、接收者拆分（t.f / t:m → 方法）和局部变量提取
// 均从 luaExtractor 原样继承。共享的 `extractVariable` 核心分支
// 通过 `lua` || `luau` 进行门控。
export const luauExtractor: LanguageExtractor = {
  ...luaExtractor,

  // `type X = ...` 和 `export type X = ...`
  typeAliasTypes: ['type_definition'],

  // 仅 Luau `export type` 被导出；关键字在节点开头。
  isExported: (node, source) => source.slice(node.startIndex, node.startIndex + 7) === 'export ',

  // 参数 + Luau 返回类型（`parameters` 之后、函数体之前的命名子节点）。
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    const kids = node.namedChildren;
    const idx = kids.findIndex((c) => c.startIndex === params.startIndex);
    const ret = idx >= 0 ? kids[idx + 1] : null;
    if (ret && ret.type !== 'block') sig += `: ${getNodeText(ret, source)}`;
    return sig;
  },
};
