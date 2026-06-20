#!/usr/bin/env node
// 单次探针：使用已构建的 dist 对现有索引运行 handleExplore，
// 打印输出 + 若干统计信息。用于在无需完整 agent 运行的情况下
// 验证 explore 的覆盖修复。用法：node probe-explore.mjs <repo-with-.synapse> "<query>"
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [, , repo, query] = process.argv;
if (!repo || !query) {
  console.error('usage: probe-explore.mjs <repo> "<query>"');
  process.exit(1);
}

const load = async (rel) => import(pathToFileURL(resolve(rel)).href);
const idx = await load('dist/index.js');
const tools = await load('dist/mcp/tools.js');

// esModuleInterop：对 CJS 进行动态 import 会得到 { default: module.exports, ...named }
const Synapse = idx.default?.default ?? idx.default ?? idx.Synapse;
const ToolHandler = tools.ToolHandler ?? tools.default?.ToolHandler;

if (typeof Synapse?.openSync !== 'function') {
  console.error('could not resolve Synapse.openSync; index keys:', Object.keys(idx), 'default keys:', idx.default && Object.keys(idx.default));
  process.exit(2);
}
if (typeof ToolHandler !== 'function') {
  console.error('could not resolve ToolHandler; tools keys:', Object.keys(tools));
  process.exit(2);
}

const cg = Synapse.openSync(repo);
const h = new ToolHandler(cg);
const res = await h.execute('synapse_explore', { query });
const text = res.content?.[0]?.text ?? '(no text)';
console.log(text);
console.error('\n--- PROBE STATS ---');
console.error('output chars:', text.length);
console.error('triggerRender body present (-> setState({})):', /triggerRender[\s\S]{0,400}setState\(\{\}\)/.test(text));
console.error('App.tsx in source section:', /#### .*App\.tsx —/.test(text));
try { cg.close?.(); } catch {}
