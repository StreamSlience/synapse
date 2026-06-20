import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// 节点名称遵循内置 ABI-15 语法（@tree-sitter-grammars/
// tree-sitter-lua），而非旧版 tree-sitter-wasms 构建版本——参见 grammars.ts。

/** 给定类型的第一个后代节点（广度优先），或 null。 */
function findDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  const queue: SyntaxNode[] = [...node.namedChildren];
  while (queue.length) {
    const n = queue.shift()!;
    if (n.type === type) return n;
    queue.push(...n.namedChildren);
  }
  return null;
}

/**
 * 如果 `callNode` 是 `require(...)` 调用，返回模块名；否则返回 null。
 * Lua/Luau 没有 import 语句——模块通过调用全局 `require` 加载。支持两种形式：
 *   - 字符串 require：`require("net.http")` / `require "net.http"` → "net.http"
 *   - Roblox/Luau 路径 require：`require(script.Parent.Signal)` → "Signal"
 *     （Roblox 代码中的主流用法，参数是实例路径而非字符串——
 *     使用路径的最后一个字段作为模块名）。
 */
function requireModule(callNode: SyntaxNode, source: string): string | null {
  // function_call > name: <callee>, arguments: arguments
  const name = getChildByField(callNode, 'name');
  // 带点/冒号的被调用方（如 `socket.connect`）是 dot/method_index_expression，
  // 永远不是裸 `require`。
  if (!name || name.type !== 'identifier') return null;
  if (getNodeText(name, source) !== 'require') return null;

  const args = getChildByField(callNode, 'arguments');
  if (!args) return null;

  // 字符串 require——`string > content: string_content` 给出裸名。
  const content = findDescendant(args, 'string_content');
  if (content) return getNodeText(content, source).trim() || null;
  const str = findDescendant(args, 'string');
  if (str) {
    const mod = getNodeText(str, source)
      .trim()
      .replace(/^\[\[/, '')
      .replace(/\]\]$/, '')
      .replace(/^["']/, '')
      .replace(/["']$/, '');
    if (mod) return mod;
  }

  // Roblox/Luau 实例路径 require：`require(script.Parent.Signal)` → "Signal"。
  const idx = findDescendant(args, 'dot_index_expression') ?? findDescendant(args, 'method_index_expression');
  if (idx) {
    const field = getChildByField(idx, 'field') ?? getChildByField(idx, 'method');
    if (field) return getNodeText(field, source).trim() || null;
  }
  return null;
}

export const luaExtractor: LanguageExtractor = {
  // function_declaration 涵盖全局（`function f`）、表（`function t.f`）、
  // 方法（`function t:m`）和局部（`local function f`）形式——形式
  // 由 `name:` 子节点（identifier / dot_index_expression /
  // method_index_expression）和 `local` token 区分，而非独立的节点类型。
  // 匿名 `function() ... end`（function_definition）没有名称，
  // 通过其外层变量捕获。
  functionTypes: ['function_declaration'],
  classTypes: [], // Lua 没有类/结构体/接口/枚举——一切都用表实现
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [], // `require` 是 function_call——在下方 visitNode 中处理
  callTypes: ['function_call'],
  variableTypes: ['variable_declaration'], // 参见 extractVariable 中的 `lua` 分支
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    return params ? getNodeText(params, source) : undefined;
  },

  // `function t.f()` / `function t:m()` 是表 `t` 上的方法：返回
  // 表作为接收者，使其以 `t::f` 限定名被提取为方法。
  // 普通 `function f()` / `local function f()` 没有接收者，保持为函数。
  //（对于 `a.b.c`，接收者是嵌套的 `a.b`。）
  getReceiverType: (node, source) => {
    const name = getChildByField(node, 'name');
    if (name && (name.type === 'dot_index_expression' || name.type === 'method_index_expression')) {
      const table = getChildByField(name, 'table');
      if (table) return getNodeText(table, source);
    }
    return undefined;
  },

  // 为 `require(...)` 触发 import 节点。局部声明形式在此显式处理，
  // 因为 variable 分支会跳过初始化器子树；裸 require 和全局 require 调用
  // 在遍历器到达 function_call 节点时被捕获。
  visitNode: (node, ctx) => {
    const source = ctx.source;

    const emit = (callNode: SyntaxNode): void => {
      const mod = requireModule(callNode, source);
      if (!mod) return;
      const imp = ctx.createNode('import', mod, callNode, {
        signature: getNodeText(callNode, source).trim().slice(0, 100),
      });
      if (imp && ctx.nodeStack.length > 0) {
        const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (parentId) {
          ctx.addUnresolvedReference({
            fromNodeId: parentId,
            referenceName: mod,
            referenceKind: 'imports',
            line: callNode.startPosition.row + 1,
            column: callNode.startPosition.column,
          });
        }
      }
    };

    // 裸 / 全局 `require("x")`——声明它，使其不被重复计为一次调用。
    if (node.type === 'function_call') {
      if (requireModule(node, source)) {
        emit(node);
        return true;
      }
      return false;
    }

    // `local x = require("x")`——variable_declaration 包装了一个 assignment_statement，
    // 其初始化器子树会被 variable 分支跳过，因此在此处挖出。
    if (node.type === 'variable_declaration') {
      const assign = node.namedChildren.find((c) => c.type === 'assignment_statement');
      const exprList = assign?.namedChildren.find((c) => c.type === 'expression_list');
      if (exprList) {
        for (const val of exprList.namedChildren) {
          if (val.type === 'function_call') emit(val);
        }
      }
      return false;
    }

    return false;
  },
};
