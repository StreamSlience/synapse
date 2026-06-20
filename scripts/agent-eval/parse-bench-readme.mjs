#!/usr/bin/env node
// 聚合 README A/B（bench-readme.sh 输出）：每个代码库取 N 次运行的中位数
// → 耗时、工具调用次数、token 数、成本和节省百分比。末行显示总平均值。
//
// Token = 每轮 assistant `usage` 之和（input + output + cache read +
// cache creation）——累计的「已处理 token 总量」。注意：当前 Claude Code 中
// `result.usage` 仅记录最后一轮，严重少计；请勿使用。
// `total_cost_usd` 和 `duration_ms` 已是累计值。
//
// 用法：node parse-bench-readme.mjs [/tmp/ab-readme]
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
const ROOT = process.argv[2] || '/tmp/ab-readme';
const REPOS = ['vscode', 'excalidraw', 'django', 'tokio', 'okhttp', 'gin', 'alamofire'];

function parse(file) {
  if (!existsSync(file)) return null;
  const L = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let tools = 0, reads = 0, grep = 0, cg = 0, tokens = 0, r = null, raced = false;
  for (const l of L) { let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'assistant') {
      const u = e.message?.usage;
      if (u) tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      for (const b of (e.message?.content || [])) if (b.type === 'tool_use') {
        const n = b.name;
        if (n === 'ToolSearch') continue;
        tools++;
        if (n === 'Read') reads++;
        else if (n === 'Grep' || n === 'Glob') grep++;
        else if (/synapse/.test(n)) cg++;
      }
    }
    // MCP 冷启动竞态：无头 agent 在 `synapse serve --mcp` 完成工具注册前就开始执行，
    // 早期调用返回"No such tool available"，agent 随之退回 grep/Read。
    // 这衡量的是 Synapse 的启动延迟，而非稳态表现——标记该运行以便聚合时
    // 可以排除（这是无头首轮时序问题，而非工具本身的问题）。
    if (e.type === 'user') for (const b of (Array.isArray(e.message?.content) ? e.message.content : [])) {
      if (b.type === 'tool_result') {
        const t = Array.isArray(b.content) ? b.content.map(c => c.text || '').join('') : (b.content || '');
        if (/No such tool available/.test(t)) raced = true;
      }
    }
    if (e.type === 'result') r = e;
  }
  if (!r || r.subtype !== 'success') return null;
  return { dur: r.duration_ms / 1000, tools, reads, grep, cg, tokens, cost: r.total_cost_usd || 0, raced };
}
const median = (arr) => { const v = [...arr].sort((a, b) => a - b); const n = v.length; return n === 0 ? 0 : n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2; };
const fmtTime = (s) => s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
const fmtTok = (t) => t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : `${Math.round(t / 1000)}k`;
const pct = (w, wo) => wo > 0 ? Math.round((1 - w / wo) * 100) : 0;

console.log('repo        n(w/wo)  time WITH→WITHOUT      tools W→WO   tokens W→WO (saved)     cost W→WO (saved)');
const savings = { cost: [], tokens: [], time: [], tools: [] };
for (const repo of REPOS) {
  const dir = join(ROOT, repo);
  const runDirs = existsSync(dir) ? readdirSync(dir).filter(d => /^run\d+$/.test(d)) : [];
  // 默认排除 MCP 冷启动竞态的 WITH 运行——它们衡量的是启动竞态而非稳态。
  // `CG_INCLUDE_RACED=1` 保留它们（用于查看原始分布）。
  // WITHOUT 组没有 MCP，因此永远不会发生竞态。
  const includeRaced = process.env.CG_INCLUDE_RACED === '1';
  const W = [], WO = []; let racedExcluded = 0;
  for (const rd of runDirs) {
    const w = parse(join(dir, rd, 'run-headless-with.jsonl'));
    if (w) { if (w.raced && !includeRaced) racedExcluded++; else W.push(w); }
    const wo = parse(join(dir, rd, 'run-headless-without.jsonl')); if (wo) WO.push(wo);
  }
  if (!W.length || !WO.length) { console.log(`${repo.padEnd(11)} (incomplete: w=${W.length} wo=${WO.length})`); continue; }
  const m = (arr, k) => median(arr.map(x => x[k]));
  const wT = m(W, 'dur'), woT = m(WO, 'dur'), wTok = m(W, 'tokens'), woTok = m(WO, 'tokens');
  const wC = m(W, 'cost'), woC = m(WO, 'cost'), wTl = m(W, 'tools'), woTl = m(WO, 'tools');
  savings.time.push(pct(wT, woT)); savings.tokens.push(pct(wTok, woTok)); savings.cost.push(pct(wC, woC)); savings.tools.push(pct(wTl, woTl));
  console.log(
    `${repo.padEnd(11)} ${W.length}/${WO.length}      ` +
    `${(fmtTime(wT) + '→' + fmtTime(woT)).padEnd(22)}` +
    `${(Math.round(wTl) + '→' + Math.round(woTl)).padEnd(12)}` +
    `${(fmtTok(wTok) + '→' + fmtTok(woTok) + ' (' + pct(wTok, woTok) + '%)').padEnd(24)}` +
    `$${wC.toFixed(2)}→$${woC.toFixed(2)} (${pct(wC, woC)}%)` +
    (racedExcluded ? `  [${racedExcluded} raced run${racedExcluded === 1 ? '' : 's'} excluded]` : '')
  );
}
const avg = (a) => a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0;
console.log(`\nAVERAGE saved:  cost ${avg(savings.cost)}%  ·  tokens ${avg(savings.tokens)}%  ·  time ${avg(savings.time)}%  ·  tool calls ${avg(savings.tools)}%`);
