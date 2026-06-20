/**
 * Tree-sitter 共享工具函数
 *
 * 供核心 TreeSitterExtractor 和各语言提取器使用的工具函数。
 * 提取为独立叶模块，避免 tree-sitter.ts 与 languages/ 之间的循环导入。
 */

import { Node as SyntaxNode } from 'web-tree-sitter';
import * as crypto from 'crypto';
import { NodeKind } from '../types';

/**
 * 生成唯一节点 ID
 *
 * 使用 32 字符（128 位）哈希，避免在索引含有大量同名符号文件的
 * 大型代码库时发生冲突。
 */
export function generateNodeId(
  filePath: string,
  kind: NodeKind,
  name: string,
  line: number
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${filePath}:${kind}:${name}:${line}`)
    .digest('hex')
    .substring(0, 32);
  return `${kind}:${hash}`;
}

/**
 * 从语法节点中提取文本
 */
export function getNodeText(node: SyntaxNode, source: string): string {
  return source.substring(node.startIndex, node.endIndex);
}

/**
 * 通过字段名查找子节点
 */
export function getChildByField(node: SyntaxNode, fieldName: string): SyntaxNode | null {
  return node.childForFieldName(fieldName);
}

/**
 * *包裹*声明的节点类型，这类包裹使前置注释成为包裹节点的兄弟节点，
 * 而非内层（被生成的）声明节点的兄弟节点。Synapse 生成内层节点，
 * 因此在查找其前置注释前需先穿越这些包裹层。示例：
 * `export class X {}` (export_statement)、`@dec\ndef f()`
 * (decorated_definition)、`const f = () => {}` (lexical_declaration →
 * variable_declarator)。每层恰好包裹一个声明，因此穿越不会将注释
 * 错误归属于兄弟节点。(#780)
 */
const DOCSTRING_WRAPPER_TYPES = new Set([
  'export_statement', // JS/TS: export class/function/const ...
  'decorated_definition', // Python: @decorator over def/class
  'lexical_declaration', // JS/TS: const/let x = () => {}
  'variable_declaration', // JS/TS: var x = ...
  'variable_declarator', // JS/TS: the `x = () => {}` inside the declaration
  'ambient_declaration', // TS: declare ...
]);

/**
 * 去除原始注释中的注释语法标记，使存储的文档字符串仅保留正文内容。
 * 覆盖所有受支持语言的标记风格：C 系列行注释、块注释及其文档变体，
 * Rust/Swift/Kotlin 三斜杠和感叹号文档行，井号行（Python/Ruby/shell），
 * Lua/Luau 行注释和长括号注释，以及 Pascal 花括号和括号星注释。(#780)
 *
 * 配对的块分隔符仅在注释以其*开头*时才被去除，因此末尾恰好有闭合分隔符
 * 的行注释不会被截断。单行标记锚定在行首，对任何注释都可安全应用。
 */
function cleanCommentMarkers(comment: string): string {
  let c = comment.trim();
  if (c.startsWith('/*')) c = c.replace(/^\/\*+!?/, '').replace(/\*+\/$/, '');
  else if (c.startsWith('--[')) c = c.replace(/^--\[=*\[/, '').replace(/\]=*\]$/, '');
  else if (c.startsWith('(*')) c = c.replace(/^\(\*/, '').replace(/\*\)$/, '');
  else if (c.startsWith('{')) c = c.replace(/^\{/, '').replace(/\}$/, '');
  return c
    .replace(/^\/\/[/!]?\s?/gm, '') // // , 以及 Rust/Swift 文档行 /// //!
    .replace(/^--\s?/gm, '') //        Lua/Luau 行注释
    .replace(/^#\s?/gm, '') //         Python/Ruby/shell 行注释
    .replace(/^\s*\*\s?/gm, '') //     块注释续行（* foo）
    .trim();
}

/**
 * 获取节点前置的文档字符串/注释
 */
export function getPrecedingDocstring(node: SyntaxNode, source: string): string | undefined {
  // 穿越所有包裹层，使整个构造（export-、decorator- 或 const-arrow-wrapped）
  // 前置的注释可作为兄弟节点访问。在这些情况下，被生成节点自身的
  // `previousNamedSibling` 为空（export/const）或为装饰器（Python），
  // 因此若不处理，文档字符串会被丢失。(#780)
  let anchor = node;
  while (anchor.parent && DOCSTRING_WRAPPER_TYPES.has(anchor.parent.type)) {
    anchor = anchor.parent;
  }

  let sibling = anchor.previousNamedSibling;
  const comments: string[] = [];

  while (sibling) {
    if (
      sibling.type === 'comment' ||
      sibling.type === 'line_comment' ||
      sibling.type === 'block_comment' ||
      sibling.type === 'documentation_comment'
    ) {
      comments.unshift(getNodeText(sibling, source));
      sibling = sibling.previousNamedSibling;
    } else {
      break;
    }
  }

  if (comments.length === 0) return undefined;

  // 去除每条注释的语法标记（语言感知），然后拼接。
  return comments.map(cleanCommentMarkers).join('\n').trim();
}
