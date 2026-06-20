#!/usr/bin/env node
// probe-sweep — 直接跨 N 个代码库 × N 个工具进行 MCP 测试，无需 claude。
//
// 针对已构建的 dist/ 测量每个（repo, query）对的响应特征（大小、存在的章节、触发的信号）。
// 每个探针亚秒级完成；下方的完整扫描约耗时 10-30s，而真实 claude 审计需数小时。
//
// 用此工具快速迭代后端变更：修改 tools.ts / context-builder，运行 npm run build，
// 重跑 probe-sweep 并对比。一旦变更在探针指标上表现良好，
// 针对关键代码库运行专项 claude 审计，确认端到端成本行为。
//
// 用法：node scripts/agent-eval/probe-sweep.mjs [--tool=context|explore|trace] [--repos=a,b,c]
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map(a => a.startsWith('--') ? a.slice(2).split('=') : [a, true])
);
const TOOL = args.tool ?? 'context';

const load = (rel) => import(pathToFileURL(resolve(rel)).href);
const idx = await load('dist/index.js');
const tools = await load('dist/mcp/tools.js');
const Synapse = idx.default?.default ?? idx.default ?? idx.Synapse;
const ToolHandler = tools.ToolHandler ?? tools.default?.ToolHandler;

// 每条记录：repo、查询、可选的 trace 第二参数（from, to）。
// 查询与真实 claude 审计中使用的提示词相同，因此探针输出
// 可直接与 agent 的预期输入对比。
const SWEEP = [
  // 小型真实世界模板代码库（跨语言扫描中的失败案例）
  { id: 'gin-rw',        repo: '/tmp/synapse-corpus/gin-realworld',         q: 'How does this Gin app route a request through its middleware chain to a handler?' },
  { id: 'go-mux',        repo: '/tmp/synapse-corpus/go-mux',                q: 'How does this gorilla/mux app route a request to its handler?' },
  { id: 'fastapi-rw',    repo: '/tmp/synapse-corpus/fastapi-realworld',     q: 'How does FastAPI route a request through its dependencies to a handler?' },
  { id: 'spring-pc',     repo: '/tmp/synapse-corpus/spring-petclinic',      q: 'How does Spring route an HTTP request to a controller method?' },
  { id: 'axum-rw',       repo: '/tmp/synapse-corpus/rust-axum-realworld',   q: 'How does Axum route a request to its handler in this app?' },
  { id: 'express-rw',    repo: '/tmp/synapse-corpus/express-realworld',     q: 'How does this Express app route a request through middleware to a handler?' },
  { id: 'kotlin-pc',     repo: '/tmp/synapse-corpus/kotlin-petclinic',      q: 'How does the Kotlin Spring app route an HTTP request to its handler?' },
  { id: 'flask-mb',      repo: '/tmp/synapse-corpus/flask-microblog',       q: 'How does this Flask app route a request to a view function?' },
  { id: 'vapor-tpl',     repo: '/tmp/synapse-corpus/vapor-template',        q: 'How does Vapor route an HTTP request to its handler?' },
  { id: 'cpp-leveldb',   repo: '/tmp/synapse-corpus/cpp-leveldb',           q: 'How does LevelDB handle a Put operation through to disk?' },
  { id: 'lualine',       repo: '/tmp/synapse-corpus/lualine.nvim',          q: 'How does lualine assemble and render the statusline?' },
  { id: 'drupal-admin',  repo: '/tmp/synapse-corpus/drupal-admintoolbar',   q: 'How does the Drupal admin toolbar module render its toolbar?' },
  { id: 'svelte-rw',     repo: '/tmp/synapse-corpus/svelte-realworld',      q: 'How does this SvelteKit app route a request to a handler?' },
  { id: 'react-rw',      repo: '/tmp/synapse-corpus/react-realworld',       q: 'How does this React app fetch and display articles?' },
  { id: 'rails-rw',      repo: '/tmp/synapse-corpus/rails-realworld',       q: 'How does Rails route a request to a controller action?' },
  { id: 'flask-rest',    repo: '/tmp/synapse-corpus/flask-restful-realworld', q: 'How does Flask-RESTful route a request to a resource method?' },
  { id: 'laravel-rw',    repo: '/tmp/synapse-corpus/laravel-realworld',     q: 'How does Laravel route a request to the controller method?' },
  { id: 'aspnet-rw',     repo: '/tmp/synapse-corpus/aspnet-realworld',      q: 'How does ASP.NET route a request to the controller action?' },
  // iter7 的胜出/平局项（确保不出现回退）
  { id: 'cobra',         repo: '/tmp/synapse-corpus/cobra',                 q: 'How does cobra parse commands and flags?' },
  { id: 'sinatra',       repo: '/tmp/synapse-corpus/sinatra',               q: 'How does sinatra route a request to its handler?' },
  { id: 'slim',          repo: '/tmp/synapse-corpus/slim',                  q: 'How does slim route a request and apply middleware?' },
];

// 检测响应文本中的信号——这些是我们添加的杠杆，
// 否则只能通过下游的「agent 多调用了 X 次工具」才能体现。
const detect = (text) => ({
  hasEntryPoints: /^### Entry Points/m.test(text),
  hasRelatedSymbols: /^### Related Symbols/m.test(text),
  hasFlowTrace: /^## Inline flow trace/m.test(text),
  hasRouteManifest: /^## Routing manifest/m.test(text),
  hasTopHandler: /^### Top handler file/m.test(text),
  hasSmallRepoTail: /This project is small/.test(text),
});

const filterRepos = args.repos ? new Set(String(args.repos).split(',')) : null;
const subjects = SWEEP.filter(s => !filterRepos || filterRepos.has(s.id));

const t0 = Date.now();
const rows = [];
for (const s of subjects) {
  try {
    const cg = Synapse.openSync(s.repo);
    const handler = new ToolHandler(cg);
    const t1 = Date.now();
    const res = await handler.execute('synapse_' + TOOL,
      TOOL === 'context' ? { task: s.q } :
      TOOL === 'explore' ? { query: s.q } : { from: 'main', to: 'main' });
    const text = res.content?.[0]?.text ?? '';
    const signals = detect(text);
    rows.push({
      id: s.id,
      ms: Date.now() - t1,
      chars: text.length,
      lines: text.split('\n').length,
      ...signals,
    });
    try { cg.close?.(); } catch {}
  } catch (e) {
    rows.push({ id: s.id, error: String(e).slice(0, 80) });
  }
}

// 以紧凑表格格式打印。
const fmt = (r) =>
  r.error
    ? `  ${r.id.padEnd(13)} ERROR: ${r.error}`
    : `  ${r.id.padEnd(13)} ${String(r.chars).padStart(6)}c ${String(r.lines).padStart(4)}L ${String(r.ms).padStart(4)}ms` +
      ` ${r.hasEntryPoints ? 'EP ' : '   '}` +
      `${r.hasFlowTrace ? 'TRC ' : '    '}` +
      `${r.hasRouteManifest ? 'MAN ' : '    '}` +
      `${r.hasTopHandler ? 'HND ' : '    '}` +
      `${r.hasSmallRepoTail ? 'TAIL' : '    '}`;
console.log(`=== probe-sweep tool=${TOOL} n=${subjects.length} (${Date.now() - t0}ms total) ===`);
console.log('  id            chars  lines    ms signals');
console.log('  ' + '-'.repeat(56));
for (const r of rows) console.log(fmt(r));

// 大小维度的求和 + 中位数
const sizes = rows.filter(r => !r.error).map(r => r.chars);
sizes.sort((a, b) => a - b);
const median = sizes[Math.floor(sizes.length / 2)];
const sum = sizes.reduce((a, b) => a + b, 0);
console.log(`  ${'-'.repeat(64)}`);
console.log(`  median=${median}c  total=${sum}c  ` +
  `manifest=${rows.filter(r => r.hasRouteManifest).length}/${rows.filter(r => !r.error).length}  ` +
  `top-handler=${rows.filter(r => r.hasTopHandler).length}/${rows.filter(r => !r.error).length}`);
