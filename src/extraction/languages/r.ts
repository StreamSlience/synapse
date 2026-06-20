import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

/**
 * R 语言提取器（#828）。
 *
 * R 没有声明语法——一切都是表达式，因此图谱需要的每个符号
 * 都通过 visitNode 钩子而非节点类型列表到达：
 *
 *   - 函数：   `name <- function(x) …` / `name = function(x) …` 解析为
 *              binary_operator(lhs: identifier, rhs: function_definition)。
 *              （`function(x) … -> name` 函数的右向赋值在语法的优先级下
 *              不能保留——`->` 绑定在函数体内部——且该风格罕见；故意留空。）
 *   - 变量：   仅顶层赋值（局部变量会使图谱膨胀）；
 *              ALL_CAPS / 带点大写名称提取为常量。
 *   - 导入：   `library(x)` / `require(x)` / `requireNamespace("x")` 是
 *              普通调用；`source("file.R")` 引用项目中的另一个文件。
 *              所有这些都被声明，以避免对 `library` 产生噪音调用边
 *              （与 Lua 的 `require` 相同模式）。
 *   - 类：     S4 `setClass("Name", …)`、R5 `setRefClass("Name", …)` 和
 *              R6 `R6Class("Name", public = list(m = function() …))` 也是调用；
 *              类节点以第一个字符串参数命名，其 list() 参数中的
 *              `name = function` 条目作为方法提取到类作用域中。
 *   - S4 泛型：`setGeneric("name", …)` / `setMethod("name", "Class", fn)`
 *              以第一个字符串参数命名，提取为函数。
 *
 * 调用本身通过通用调用提取（`call` 节点含 `function` 字段）处理。
 * 命名空间限定的 `pkg::fn(…)` 保留其限定文本；
 * `obj$method(…)` 以全文提取（`$` 分发的解析是已知的空白——
 * R 的 S3 分发在运行时通过设计实现）。
 */

const ASSIGN_LEFT = new Set(['<-', '<<-', '=']);
const ASSIGN_RIGHT = new Set(['->', '->>']);
const IMPORT_FNS = new Set(['library', 'require', 'requireNamespace', 'loadNamespace']);
const CLASS_FNS = new Set(['setClass', 'setRefClass', 'R6Class', 'ggproto']);
const GENERIC_FNS = new Set(['setGeneric', 'setMethod']);
/** ALL_CAPS 或 DOTTED.CAPS 顶层赋值 → 常量。 */
const CONSTANT_NAME = /^[A-Z][A-Z0-9._]*$/;

/** 调用的被调用方名称，当它是裸标识符或 `pkg::fn`（→ `fn`）时。 */
function calleeName(call: SyntaxNode, source: string): string | null {
  const fn = getChildByField(call, 'function');
  if (!fn) return null;
  if (fn.type === 'identifier') return getNodeText(fn, source);
  if (fn.type === 'namespace_operator') {
    const rhs = getChildByField(fn, 'rhs');
    if (rhs) return getNodeText(rhs, source);
  }
  return null;
}

/** 调用的第一个位置参数的值节点。 */
function firstArgValue(call: SyntaxNode): SyntaxNode | null {
  const args = getChildByField(call, 'arguments');
  if (!args) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg?.type !== 'argument') continue;
    return getChildByField(arg, 'value');
  }
  return null;
}

/** 字符串节点内容的文本，或标识符的文本。 */
function literalOrIdentifier(node: SyntaxNode | null, source: string): string | null {
  if (!node) return null;
  if (node.type === 'identifier') return getNodeText(node, source);
  if (node.type === 'string') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'string_content') return getNodeText(c, source);
    }
    return ''; // empty string literal
  }
  return null;
}

/** 将一个 `name = function(…)` 参数条目作为方法触发到当前作用域中。 */
function emitMethodArg(entry: SyntaxNode, ctx: ExtractorContext): void {
  const entryName = getChildByField(entry, 'name');
  const entryValue = getChildByField(entry, 'value');
  if (!entryName || entryValue?.type !== 'function_definition') return;
  const params = getChildByField(entryValue, 'parameters');
  const method = ctx.createNode('method', getNodeText(entryName, ctx.source), entry, {
    signature: params ? getNodeText(params, ctx.source) : undefined,
  });
  const body = getChildByField(entryValue, 'body');
  if (method && body) {
    ctx.pushScope(method.id);
    ctx.visitNode(body); // hook-aware walk — see the function-assignment note below
    ctx.popScope();
  }
}

/**
 * 提取类调用的方法。两种形式：
 *  - list() 参数内部——R5 `methods = list(deposit = function(x) …)`，
 *    R6 `public = list(…)` / `private = list(…)`；
 *  - 直接命名函数参数——ggproto 的风格：
 *    `ggproto("GeomPoint", Geom, draw_panel = function(…) …)`。
 * 同时将父类记录为 `extends` 引用：ggproto 的第二个位置标识符参数、
 * R6 的 `inherit = Parent`、S4 的 `contains = "Parent"`。
 */
function extractClassMembers(classCall: SyntaxNode, classId: string, ctx: ExtractorContext): void {
  const args = getChildByField(classCall, 'arguments');
  if (!args) return;
  let positional = 0;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg?.type !== 'argument') continue;
    const argName = getChildByField(arg, 'name');
    const value = getChildByField(arg, 'value');
    if (!argName) {
      positional++;
      // ggproto("Name", Parent, …)——第 2 个位置标识符是父类。
      if (positional === 2 && value?.type === 'identifier') {
        ctx.addUnresolvedReference({
          fromNodeId: classId,
          referenceName: getNodeText(value, ctx.source),
          referenceKind: 'extends',
          line: value.startPosition.row + 1,
          column: value.startPosition.column,
        });
      }
      continue;
    }
    const argNameText = getNodeText(argName, ctx.source);
    // R6 `inherit = Parent` / S4 `contains = "Parent"`。
    if ((argNameText === 'inherit' || argNameText === 'contains') && value) {
      const parent = literalOrIdentifier(value, ctx.source);
      if (parent) {
        ctx.addUnresolvedReference({
          fromNodeId: classId,
          referenceName: parent,
          referenceKind: 'extends',
          line: value.startPosition.row + 1,
          column: value.startPosition.column,
        });
      }
      continue;
    }
      // 直接命名函数参数（ggproto 方法）。
    if (value?.type === 'function_definition') {
      emitMethodArg(arg, ctx);
      continue;
    }
    // list(…) 中的命名函数参数（R5/R6 方法）。
    if (value?.type === 'call' && calleeName(value, ctx.source) === 'list') {
      const listArgs = getChildByField(value, 'arguments');
      if (!listArgs) continue;
      for (let j = 0; j < listArgs.namedChildCount; j++) {
        const entry = listArgs.namedChild(j);
        if (entry?.type === 'argument') emitMethodArg(entry, ctx);
      }
    }
  }
}

export const rExtractor: LanguageExtractor = {
  functionTypes: [], // 命名函数是赋值——在 visitNode 中处理
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [], // library()/require()/source() 是调用——在 visitNode 中处理
  callTypes: ['call'],
  variableTypes: [], // 顶层赋值——在 visitNode 中处理
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  visitNode: (node, ctx) => {
    const source = ctx.source;

    if (node.type === 'call') {
      const fname = calleeName(node, source);
      if (!fname) return false;

      // library(dplyr) / require(stats) / requireNamespace("jsonlite") ——
      // 以及 source("helpers.R")，它引用项目中的另一个文件。
      if (IMPORT_FNS.has(fname) || fname === 'source') {
        const mod = literalOrIdentifier(firstArgValue(node), source);
        if (!mod) return true; // 动态参数——无需记录，也不产生调用边
        const imp = ctx.createNode('import', mod, node, {
          signature: getNodeText(node, source).trim().slice(0, 100),
        });
        if (imp && ctx.nodeStack.length > 0) {
          const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
          if (parentId) {
            ctx.addUnresolvedReference({
              fromNodeId: parentId,
              referenceName: mod,
              referenceKind: 'imports',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
        return true;
      }

      // setClass("Patient", …) / setRefClass("Account", …) / R6Class("Stack", …)
      if (CLASS_FNS.has(fname)) {
        const name = literalOrIdentifier(firstArgValue(node), source);
        if (!name) return false;
        const cls = ctx.createNode('class', name, node, {});
        if (cls) {
          ctx.pushScope(cls.id);
          extractClassMembers(node, cls.id, ctx);
          ctx.popScope();
        }
        return true;
      }

      // setGeneric("describe", …) / setMethod("describe", "Patient", function(obj) …)
      if (GENERIC_FNS.has(fname)) {
        const name = literalOrIdentifier(firstArgValue(node), source);
        if (!name) return false;
        // 其中包含 function_definition 的实现（setMethod 始终有，
        // setGeneric 通常通过 def= 参数有）。
        const args = getChildByField(node, 'arguments');
        let impl: SyntaxNode | null = null;
        if (args) {
          for (let i = 0; i < args.namedChildCount; i++) {
            const v = args.namedChild(i)?.type === 'argument'
              ? getChildByField(args.namedChild(i)!, 'value') : null;
            if (v?.type === 'function_definition') { impl = v; break; }
          }
        }
        const params = impl ? getChildByField(impl, 'parameters') : null;
        const fn = ctx.createNode('function', name, node, {
          signature: params ? getNodeText(params, source) : undefined,
        });
        const body = impl ? getChildByField(impl, 'body') : null;
        if (fn && body) {
          ctx.pushScope(fn.id);
          ctx.visitNode(body); // hook-aware walk — see the function-assignment note below
          ctx.popScope();
        }
        return true;
      }

      return false; // 普通调用——通用提取记录该边
    }

    if (node.type === 'binary_operator') {
      const op = node.childForFieldName('operator')?.text;
      if (!op) return false;
      const lhs = getChildByField(node, 'lhs');
      const rhs = getChildByField(node, 'rhs');

      // name <- function(…) / name = function(…)（任意作用域——嵌套
      // 函数在其外层函数的作用域内提取）。函数体通过 ctx.visitNode 遍历，
      // 而非 ctx.visitFunctionBody：函数体遍历器不调用此钩子，
      // 而在 R 中，每个嵌套定义都是只有此钩子才能识别的赋值表达式。
      // visitNode 在函数位于作用域栈上时分发调用和钩子，
      // 确保归属正确。
      if (ASSIGN_LEFT.has(op) && lhs?.type === 'identifier' && rhs?.type === 'function_definition') {
        const params = getChildByField(rhs, 'parameters');
        const fn = ctx.createNode('function', getNodeText(lhs, source), node, {
          signature: params ? getNodeText(params, source) : undefined,
        });
        const body = getChildByField(rhs, 'body');
        if (fn && body) {
          ctx.pushScope(fn.id);
          ctx.visitNode(body);
          ctx.popScope();
        }
        return true;
      }

      // 顶层值赋值 → variable/constant。局部变量故意跳过
      //（图谱膨胀）；初始化器仍被访问，以便提取其调用和嵌套定义。
      const topLevel = node.parent?.type === 'program';
      if (topLevel && ASSIGN_LEFT.has(op) && lhs?.type === 'identifier' && rhs) {
        // `Account <- setRefClass("Account", …)` 是类定义的惯用法
        //（R6Class / setClass / setGeneric 同理）——调用钩子创建
        // class/function 节点；重复的 variable 节点只是噪音。
        const rhsCallee = rhs.type === 'call' ? calleeName(rhs, source) : null;
        if (!rhsCallee || (!CLASS_FNS.has(rhsCallee) && !GENERIC_FNS.has(rhsCallee))) {
          const name = getNodeText(lhs, source);
          ctx.createNode(CONSTANT_NAME.test(name) ? 'constant' : 'variable', name, node, {});
        }
        ctx.visitNode(rhs);
        return true;
      }
      // value -> name / value ->> name（右向赋值）
      if (topLevel && ASSIGN_RIGHT.has(op) && rhs?.type === 'identifier' && lhs) {
        const name = getNodeText(rhs, source);
        ctx.createNode(CONSTANT_NAME.test(name) ? 'constant' : 'variable', name, node, {});
        ctx.visitNode(lhs);
        return true;
      }

      return false;
    }

    return false;
  },
};
