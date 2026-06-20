#!/usr/bin/env node
// 使用已构建的 dist 对索引执行 synapse_context（含调用路径）的探针测试。
// 用法：node probe-context.mjs <repo-with-.synapse> <task words...>
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [, , repo, ...taskParts] = process.argv;
const task = taskParts.join(' ');
if (!repo || !task) { console.error('usage: probe-context.mjs <repo> <task...>'); process.exit(1); }

const load = async (rel) => import(pathToFileURL(resolve(rel)).href);
const idx = await load('dist/index.js');
const tools = await load('dist/mcp/tools.js');
const Synapse = idx.default?.default ?? idx.default ?? idx.Synapse;
const ToolHandler = tools.ToolHandler ?? tools.default?.ToolHandler;

const cg = Synapse.openSync(repo);
const h = new ToolHandler(cg);
const res = await h.execute('synapse_context', { task });
console.log(res.content?.[0]?.text ?? '(no text)');
try { cg.close?.(); } catch {}
