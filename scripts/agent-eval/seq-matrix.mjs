#!/usr/bin/env node
// 从留存的 A/B stream-json 日志（/tmp/ab-matrix/<Cell>/run-headless-*.jsonl）中挖掘
// 聚合矩阵无法呈现的信息：调用顺序（SEQUENCE）和单次调用的输出大小（SIZE）。
//
// 回答三个问题：
//   1. trace 采用率——在流程类问题上，with 组是否真的调用了 synapse_trace？
//   2. payload 大小 vs 代码库规模——trace 是路径范围（小，与规模无关），
//      而 explore 是广度范围（随代码库增长 / 在小代码库上过度返回）？
//   3. 轮次数——有 vs 无 synapse 的 num_turns 对比（真正的挂钟耗时驱动因素）。
//
// 用法：node scripts/agent-eval/seq-matrix.mjs [/tmp/ab-matrix]
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const AB = process.argv[2] || '/tmp/ab-matrix';
const MD = new URL('../../docs/benchmarks/synapse-ab-matrix.md', import.meta.url).pathname;

// repo -> {lang,size,files} 来自已发布矩阵表格
const repoMeta = {};
if (existsSync(MD)) for (const line of readFileSync(MD, 'utf8').split('\n')) {
  const m = line.match(/^\|\s*([^|]+?)\s*\|\s*(S|M|L)\s*\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|/);
  if (m) repoMeta[m[3]] = { lang: m[1].trim(), size: m[2], files: +m[4] };
}

const cgShort = (n) => n.replace('mcp__synapse__synapse_', '').replace('mcp__synapse__', '');
const tag = (n) => n === 'Read' ? 'R' : n === 'Grep' ? 'G' : n === 'Glob' ? 'Gl'
  : n === 'Bash' ? 'B' : n === 'Task' ? 'Ag' : n === 'ToolSearch' ? 'TS'
  : n.includes('synapse') ? cgShort(n) : n;

function parse(file) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const calls = []; let result = null, initCg = 0;
  for (const l of lines) {
    let ev; try { ev = JSON.parse(l); } catch { continue; }
    if (ev.type === 'system' && ev.subtype === 'init') initCg = (ev.tools || []).filter(t => /synapse/.test(t)).length;
    if (ev.type === 'assistant') for (const b of (ev.message?.content || [])) if (b.type === 'tool_use') {
      const i = b.input || {};
      const q = i.query ?? i.symbol ?? i.task ?? (i.from && i.to ? `${i.from}->${i.to}` : (i.file_path || i.command || ''));
      calls.push({ id: b.id, name: b.name, q: String(q ?? '').slice(0, 38), out: 0 });
    }
    if (ev.type === 'user') for (const b of (ev.message?.content || [])) if (b.type === 'tool_result') {
      const c = b.content;
      const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x?.text || '').join('') : '';
      const call = calls.find(k => k.id === b.tool_use_id); if (call) call.out = txt.length;
    }
    if (ev.type === 'result') result = ev;
  }
  const cg = calls.filter(c => c.name.includes('synapse'));
  const perTool = {};
  for (const c of cg) { const k = cgShort(c.name); (perTool[k] ??= { n: 0, out: 0 }); perTool[k].n++; perTool[k].out += c.out; }
  const traceIdx = cg.findIndex(c => c.name.includes('trace'));
  const u = result?.usage || {};
  return {
    initCg, cg, perTool,
    cgSeq: cg.map(c => cgShort(c.name)),
    seq: calls.map(c => tag(c.name)),
    reads: calls.filter(c => c.name === 'Read').length,
    greps: calls.filter(c => c.name === 'Grep').length,
    cgOut: cg.reduce((s, c) => s + c.out, 0),
    traceUsed: traceIdx >= 0,
    afterTrace: traceIdx >= 0 ? cg.slice(traceIdx + 1).map(c => cgShort(c.name)) : null,
    turns: result?.num_turns ?? null,
    dur: result?.duration_ms ? Math.round(result.duration_ms / 1000) : null,
    cost: result?.total_cost_usd || 0,
  };
}

const cells = [];
for (const d of readdirSync(AB)) {
  const dir = join(AB, d);
  if (!existsSync(join(dir, 'run-headless-with.jsonl'))) continue;
  const log = existsSync(join(AB, d + '.log')) ? readFileSync(join(AB, d + '.log'), 'utf8') : '';
  const repo = (log.match(/repo:\s*\S*\/([^\s/]+)/) || [])[1] || d;
  const question = (log.match(/question:\s*(.+)/) || [])[1] || '';
  cells.push({ cell: d, repo, question, ...(repoMeta[repo] || {}),
    with: parse(join(dir, 'run-headless-with.jsonl')),
    without: parse(join(dir, 'run-headless-without.jsonl')) });
}
cells.sort((a, b) => (a.files || 0) - (b.files || 0));

const k = (n) => (n / 1000).toFixed(1);
const pad = (s, n) => String(s).padEnd(n);

// ---- 每个 cell 的调用序列表 ----
console.log('\n=== PER-CELL: with-arm synapse sequence + payload (sorted by repo size) ===');
console.log(pad('repo', 22), pad('files', 6), 'trace', pad('cg-call sequence', 40), pad('cgOutK', 7), 'turns(w/wo)');
for (const c of cells) {
  const w = c.with;
  console.log(
    pad(c.repo, 22), pad(c.files ?? '?', 6),
    pad(w.traceUsed ? 'YES' : 'no', 5),
    pad(w.cgSeq.join(',') || '(none)', 40),
    pad(k(w.cgOut), 7),
    `${w.turns}/${c.without?.turns}`,
  );
}

// ---- trace 采用率 ----
const flow = cells; // 矩阵中的每个问题按设计均为规范流程问题
const used = flow.filter(c => c.with.traceUsed);
console.log(`\n=== TRACE ADOPTION (all ${flow.length} cells are flow questions) ===`);
console.log(`trace called in ${used.length}/${flow.length} cells`);
console.log('used trace:', used.map(c => c.repo).join(', ') || '(none)');
if (used.length) console.log('after-trace follow-ups:', used.map(c => `${c.repo}[${c.with.afterTrace.join(',') || 'none'}]`).join('  '));

// ---- payload 大小按代码库规模分级 ----
const tier = (f) => f < 200 ? 'S(<200)' : f < 2000 ? 'M(<2000)' : 'L(>=2000)';
const byTier = {};
for (const c of cells) { (byTier[tier(c.files || 0)] ??= []).push(c.with.cgOut); }
console.log('\n=== with-arm TOTAL synapse payload by repo-size tier ===');
for (const t of ['S(<200)', 'M(<2000)', 'L(>=2000)']) {
  const a = byTier[t] || []; if (!a.length) continue;
  const avg = a.reduce((s, x) => s + x, 0) / a.length;
  console.log(`  ${pad(t, 10)} n=${a.length}  avg cgOut=${k(avg)}K  range ${k(Math.min(...a))}-${k(Math.max(...a))}K`);
}

// ---- 各工具使用量 + 平均 payload（广度 vs 路径的证据）----
const tot = {};
for (const c of cells) for (const [name, v] of Object.entries(c.with.perTool)) {
  (tot[name] ??= { n: 0, out: 0 }); tot[name].n += v.n; tot[name].out += v.out;
}
console.log('\n=== synapse tool usage across all cells (n calls, avg payload/call) ===');
for (const [name, v] of Object.entries(tot).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${pad(name, 10)} calls=${pad(v.n, 4)} avg=${k(v.out / v.n)}K/call  total=${k(v.out)}K`);
}

// ---- 轮次数 ----
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
const wTurns = sum(cells, c => c.with.turns), woTurns = sum(cells, c => c.without?.turns);
const wCalls = sum(cells, c => c.with.cg.length);
const tsAll = cells.every(c => c.with.seq[0] === 'TS');
console.log('\n=== ROUND-TRIPS ===');
console.log(`turns: with=${wTurns}  without=${woTurns}  (${((1 - wTurns / woTurns) * 100).toFixed(0)}% fewer with)`);
console.log(`avg turns/cell: with=${(wTurns / cells.length).toFixed(1)}  without=${(woTurns / cells.length).toFixed(1)}`);
console.log(`total synapse calls=${wCalls} (avg ${(wCalls / cells.length).toFixed(1)}/cell)`);
console.log(`每个 with-arm 是否以 ToolSearch 轮次（延迟工具）开始：${tsAll ? 'YES — 每次运行固定消耗 1 轮' : 'no'}`);
