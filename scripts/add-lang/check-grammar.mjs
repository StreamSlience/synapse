#!/usr/bin/env node
// 在编写提取器之前，验证 tree-sitter 语法 wasm 在项目的 web-tree-sitter
// 运行时下是否健康。打印 ABI 版本，并在多语法上下文中多次解析有效样本，
// 以捕获会在首次解析后静默丢失节点的堆损坏 bug。
//
// 存在原因：tree-sitter-wasms 的 Lua 语法是 ABI 13，会在 web-tree-sitter 0.25
// 下损坏共享 WASM 堆——Lua 提取在首个文件之后的每个文件上都退化
//（嵌套调用/导入消失）。修复方案是使用上游 ABI-15 wasm。
// 对任何新语法先运行此脚本；若 FAIL 则使用更新的构建而非 tree-sitter-wasms。
//
// 用法：node scripts/add-lang/check-grammar.mjs <lang|wasm-path> <valid-sample> [iterations]
// 退出码：0 健康，1 损坏/解析错误，2 无法运行。
// 注意：样本必须语法上有效——损坏的样本会因错误原因而失败。

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const fail = (code, msg) => { console.error(`[check-grammar] ${msg}`); process.exit(code); };

const [token, sample, iterArg] = process.argv.slice(2);
if (!token || !sample) fail(2, 'usage: check-grammar.mjs <lang|wasm-path> <valid-sample> [iterations]');
if (!existsSync(sample)) fail(2, `sample not found: ${sample}`);
const iters = iterArg ? parseInt(iterArg, 10) : 20;

const SPECIAL = { csharp: 'c_sharp', 'c#': 'c_sharp' };
function resolveWasm(t) {
  if (t.endsWith('.wasm')) return existsSync(t) ? t : fail(2, `wasm not found: ${t}`);
  const base = SPECIAL[t.toLowerCase()] ?? t.toLowerCase();
  try { return require.resolve(`tree-sitter-wasms/out/tree-sitter-${base}.wasm`); } catch { /* try vendored */ }
  const vendored = `src/extraction/wasm/tree-sitter-${base}.wasm`;
  if (existsSync(vendored)) return vendored;
  return fail(2, `no grammar for "${t}" — not in tree-sitter-wasms and not vendored`);
}

const wasmPath = resolveWasm(token);
const source = readFileSync(sample, 'utf8');

try { await Parser.init(); }
catch { await Parser.init({ locateFile: () => require.resolve('web-tree-sitter/tree-sitter.wasm') }); }

// 加载第二个已知无误的语法——损坏在真实索引使用的多语法运行时中
// 才会暴露，单一语法隔离运行时不会出现。
try { await Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm')); } catch { /* ok */ }

let language;
try { language = await Language.load(wasmPath); }
catch (e) { fail(2, `failed to load ${wasmPath}: ${e.message}`); }

const parser = new Parser();
parser.setLanguage(language);

let ok = 0, err = 0;
for (let i = 0; i < iters; i++) {
  const tree = parser.parse(source);
  if (tree.rootNode.hasError) err++; else ok++;
}

console.log(`grammar: ${wasmPath.split('/').pop()}`);
console.log(`  ABI version: ${language.abiVersion}`);
console.log(`  parses: ${ok} clean / ${err} with errors (of ${iters})`);
if (err > 0) {
  console.log(
    `RESULT: FAIL — ${err}/${iters} parses produced ERROR trees on a valid sample. ` +
    `This grammar corrupts under web-tree-sitter; vendor a newer (ABI 14/15) wasm ` +
    `(see SKILL.md "Find a grammar"). Confirm your sample is syntactically valid first.`
  );
  process.exit(1);
}
console.log('RESULT: PASS — grammar parses cleanly and reuses safely.');
process.exit(0);
