#!/usr/bin/env node
// 解析某项目最新的 Claude Code 会话日志及其子智能体日志，
// 并报告工具调用摘要（主线程 + 子智能体）。适用于交互式运行（通过 itrun.sh 驱动）——
// Claude Code 将完整记录写入 ~/.claude/projects/<escaped-cwd>/<session>.jsonl，
// 子智能体日志存放在同级的 subagents/ 目录下。
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const projectArg = process.argv[2];
if (!projectArg) { console.error('usage: parse-session.mjs <project-dir>'); process.exit(1); }

// Claude Code 通过将每个 "/" 替换为 "-" 来转义（真实的）cwd。
const real = realpathSync(projectArg);
const escaped = real.replace(/\//g, '-');
const projDir = join(homedir(), '.claude', 'projects', escaped);
if (!existsSync(projDir)) { console.error('no session logs at', projDir); process.exit(1); }

// 最新的顶层会话 .jsonl
const sessions = readdirSync(projDir)
  .filter(f => f.endsWith('.jsonl'))
  .map(f => ({ f, m: statSync(join(projDir, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
if (sessions.length === 0) { console.error('no .jsonl sessions in', projDir); process.exit(1); }
const sessionId = sessions[0].f.replace('.jsonl', '');

function tally(file) {
  const counts = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_use') counts[b.name] = (counts[b.name] || 0) + 1;
    }
  }
  return counts;
}

// 汇总记录文件中的 token 用量。TUI 的 "Done (…Xk tokens…)" 行仅覆盖
// 子智能体的吞吐量；此函数对主线程运行同样有效，两条路径结果一致。
// `gen` = 输出，`fresh` = 未缓存的输入（input + cache_creation），
// `cached` = 缓存读取（约等于免费），`total` = 全部。
function sumTokens(file) {
  const t = { gen: 0, fresh: 0, cached: 0 };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const u = ev.message?.usage;
    if (!u) continue;
    t.gen += u.output_tokens || 0;
    t.fresh += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    t.cached += u.cache_read_input_tokens || 0;
  }
  return t;
}

const mainCounts = tally(join(projDir, sessionId + '.jsonl'));

// 子智能体记录位于 <session>/subagents/*.jsonl
const subDir = join(projDir, sessionId, 'subagents');
const subCounts = {};
let subAgentFiles = 0;
if (existsSync(subDir)) {
  for (const f of readdirSync(subDir).filter(f => f.endsWith('.jsonl'))) {
    subAgentFiles++;
    const c = tally(join(subDir, f));
    for (const [k, v] of Object.entries(c)) subCounts[k] = (subCounts[k] || 0) + v;
  }
}

const fmt = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `    ${String(v).padStart(3)}  ${k}`).join('\n') || '    (none)';

console.log(`session: ${sessionId}`);
console.log(`\nMAIN thread tools:\n${fmt(mainCounts)}`);
console.log(`\nSUBAGENT tools (${subAgentFiles} subagent transcript${subAgentFiles === 1 ? '' : 's'}):\n${fmt(subCounts)}`);

const explore = subCounts['mcp__synapse__synapse_explore'] || mainCounts['mcp__synapse__synapse_explore'] || 0;
const reads = (subCounts['Read'] || 0) + (mainCounts['Read'] || 0);
const greps = (subCounts['Grep'] || 0) + (mainCounts['Grep'] || 0) + (subCounts['Bash'] || 0) + (mainCounts['Bash'] || 0);
console.log(`\nVERDICT: synapse_explore used ${explore}x | Read ${reads} | Grep/Bash ${greps}`);

// Token 总量（主线程 + 子智能体），在主线程和子智能体运行中均保持一致。
const tok = { gen: 0, fresh: 0, cached: 0 };
const addTok = (t) => { tok.gen += t.gen; tok.fresh += t.fresh; tok.cached += t.cached; };
addTok(sumTokens(join(projDir, sessionId + '.jsonl')));
if (existsSync(subDir)) {
  for (const f of readdirSync(subDir).filter(f => f.endsWith('.jsonl'))) addTok(sumTokens(join(subDir, f)));
}
const k = (n) => (n / 1000).toFixed(1) + 'k';
console.log(`TOKENS: gen ${k(tok.gen)} | fresh-in ${k(tok.fresh)} | cached-in ${k(tok.cached)} | billable≈ ${k(tok.gen + tok.fresh)}`);
