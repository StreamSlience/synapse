#!/usr/bin/env node
// 为样本文件转储 tree-sitter AST，以便编写 LanguageExtractor 映射。
// 通过 web-tree-sitter（与 synapse 使用的相同运行时）直接加载语法 .wasm——
// 无需提前注册语言。
//
// 用法：
//   node scripts/add-lang/dump-ast.mjs <lang|wasm-path> <sample-file> [--depth=N] [--full]
// 示例：
//   node scripts/add-lang/dump-ast.mjs lua sample.lua
//   node scripts/add-lang/dump-ast.mjs src/extraction/wasm/tree-sitter-zig.wasm a.zig --depth=4
//
// 输出：带缩进的 AST（命名节点，带字段名），后跟节点类型频率表。
// 频率表是重点——它告诉你哪些节点类型应映射到
// functionTypes / classTypes / importTypes 等。

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const fail = (msg) => { console.error(`[dump-ast] ${msg}`); process.exit(1); };

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const [langOrWasm, sampleFile] = positional;
const depthFlag = argv.find((a) => a.startsWith('--depth='));
const showAll = argv.includes('--full'); // 同时打印匿名（token）节点
const maxDepth = depthFlag ? parseInt(depthFlag.split('=')[1], 10) : (showAll ? Infinity : 8);

if (!langOrWasm || !sampleFile) {
  fail('usage: dump-ast.mjs <lang|wasm-path> <sample-file> [--depth=N] [--full]');
}
if (!existsSync(sampleFile)) fail(`sample file not found: ${sampleFile}`);

// tree-sitter-wasms 文件名与 token 不同的语言标识符。
const WASM_SPECIAL = { csharp: 'c_sharp', 'c#': 'c_sharp' };

function resolveWasm(token) {
  if (token.endsWith('.wasm')) {
    if (!existsSync(token)) fail(`wasm not found: ${token}`);
    return token;
  }
  const base = WASM_SPECIAL[token.toLowerCase()] ?? token.toLowerCase();
  try {
    return require.resolve(`tree-sitter-wasms/out/tree-sitter-${base}.wasm`);
  } catch {
    /* 不在 tree-sitter-wasms 中——尝试 vendored 副本 */
  }
  const vendored = `src/extraction/wasm/tree-sitter-${base}.wasm`;
  if (existsSync(vendored)) return vendored;
  fail(
    `no grammar for "${token}" — not in tree-sitter-wasms and not vendored at ` +
      `${vendored}. Pass an explicit .wasm path, or vendor one (see SKILL.md "Find a grammar").`
  );
}

const wasmPath = resolveWasm(langOrWasm);
const source = readFileSync(sampleFile, 'utf8');

try {
  await Parser.init();
} catch {
  await Parser.init({ locateFile: () => require.resolve('web-tree-sitter/tree-sitter.wasm') });
}

let language;
try {
  language = await Language.load(wasmPath);
} catch (e) {
  fail(`failed to load grammar ${wasmPath}: ${e.message}`);
}

const parser = new Parser();
parser.setLanguage(language);
const tree = parser.parse(source);

const freq = new Map();
const snippet = (node) => {
  const t = node.text.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? `${t.slice(0, 48)}…` : t;
};

function walk(node, depth, fieldName) {
  if (node.isNamed) freq.set(node.type, (freq.get(node.type) || 0) + 1);
  if ((node.isNamed || showAll) && depth <= maxDepth) {
    const field = fieldName ? `${fieldName}: ` : '';
    const leaf = node.childCount === 0 ? `  "${snippet(node)}"` : '';
    console.log(`${'  '.repeat(depth)}${field}${node.type}  @${node.startPosition.row + 1}:${node.startPosition.column}${leaf}`);
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walk(child, depth + 1, node.fieldNameForChild(i));
  }
}

console.log(`\n# AST for ${sampleFile}  (grammar: ${wasmPath.split('/').pop()})\n`);
walk(tree.rootNode, 0, null);

console.log('\n# 节点类型频率（命名节点）——在提取器中映射相关类型：\n');
[...freq.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([type, n]) => console.log(`  ${String(n).padStart(5)}  ${type}`));
console.log();
