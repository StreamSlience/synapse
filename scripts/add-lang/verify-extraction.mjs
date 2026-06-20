#!/usr/bin/env node
// 健全性检查：确认 synapse 从代码库中为指定语言提取了真实符号
//（而非仅 file/import 节点）。关键失败时退出码非零，
// 可驱动"编写提取器 -> 构建 -> 重新检查"循环。
//
// 用法：node scripts/add-lang/verify-extraction.mjs <repo-path> <lang>
// 使用 PATH 上的任意 synapse 读取 `synapse status <repo> --json`，
// 因此反映的是构建了索引的二进制。
//
// 退出码：0 = 通过或软警告，1 = 关键失败，2 = 无法运行。

import { execFileSync } from 'node:child_process';

const [repo, lang] = process.argv.slice(2);
if (!repo || !lang) {
  console.error('usage: verify-extraction.mjs <repo-path> <lang>');
  process.exit(2);
}

let status;
try {
  const out = execFileSync('synapse', ['status', repo, '--json'], { encoding: 'utf8' });
  status = JSON.parse(out);
} catch (e) {
  console.error(`[verify] could not read synapse status for ${repo}: ${e.message}`);
  process.exit(2);
}

// 能证明提取器已映射 AST 节点类型的 kind（除 'file' 和 'import' 之外，
// 这两者由 synapse 为任意语言结构性创建）。
const SYMBOL_KINDS = new Set([
  'module', 'class', 'struct', 'interface', 'trait', 'protocol', 'function',
  'method', 'property', 'field', 'variable', 'constant', 'enum', 'enum_member',
  'type_alias', 'namespace', 'route', 'component',
]);

const byKind = status.nodesByKind || {};
const langs = status.languages || [];
const files = status.fileCount || 0;
const edges = status.edgeCount || 0;
const symbolKinds = Object.keys(byKind).filter((k) => SYMBOL_KINDS.has(k));
const symbolCount = symbolKinds.reduce((s, k) => s + byKind[k], 0);

const checks = [];
const add = (severity, ok, label, detail) => checks.push({ severity, ok, label, detail });

add('critical', status.initialized === true, 'index initialized', `initialized=${status.initialized}`);
add('critical', langs.includes(lang), `language "${lang}" detected`, `languages=[${langs.join(', ')}]`);
add('critical', symbolCount > 0, 'structural symbols extracted', `${symbolCount} symbols (${symbolKinds.join(', ') || 'NONE — only file/import nodes!'})`);
add('soft', symbolCount >= files, 'symbol density >= 1/file', `${symbolCount} symbols across ${files} files`);
add('soft', edges > files, 'edges resolved', `${edges} edges across ${files} files`);

console.log(`\n# Extraction check — ${repo}  (lang=${lang}, backend=${status.backend})`);
console.log(`  files=${files} nodes=${status.nodeCount} edges=${edges}`);
console.log(`  nodesByKind: ${JSON.stringify(byKind)}\n`);
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label} — ${c.detail}`);

const critical = checks.filter((c) => !c.ok && c.severity === 'critical');
const soft = checks.filter((c) => !c.ok && c.severity === 'soft');
console.log();
if (critical.length) {
  console.log(`RESULT: FAIL (${critical.length} critical) — extractor or grammar wiring is broken. Re-run dump-ast.mjs and fix the node-type mappings.`);
  process.exit(1);
}
if (soft.length) {
  console.log(`RESULT: WARN (${soft.length} soft) — extraction works but looks thin; inspect the counts above.`);
  process.exit(0);
}
console.log('RESULT: PASS — extraction looks healthy.');
process.exit(0);
