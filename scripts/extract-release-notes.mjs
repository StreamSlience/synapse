#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 中提取指定版本的发布说明块
 *（或展开 stdin 传入的文本），然后合并硬换行段落。
 *
 * 原因：GitHub 用 GFM 硬换行渲染发布说明，每个 `\n` 都会变成 `<br>`。
 * CHANGELOG 为了使 diff 可读而在约 75 个字符处硬换行，这在发布页面上
 * 会渲染成令人尴尬的可见换行。本脚本将缩进的续行合并为每个条目一行，
 * 使 GFM 渲染器产生干净的段落。
 *
 * 仓库级 CHANGELOG.md 的查看不受影响（CommonMark 在那里将换行视为空格）。
 *
 * 用法：
 *   extract-release-notes.mjs <version>     # 读取 CHANGELOG.md
 *   extract-release-notes.mjs --stdin       # 从 stdin 读取（任意文本）
 */

import { readFileSync } from 'fs';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: extract-release-notes.mjs <version> | --stdin');
  process.exit(1);
}

let block;
if (arg === '--stdin') {
  block = readFileSync(0, 'utf8').replace(/\r\n?/g, '\n').split('\n');
} else {
  const version = arg;
  const escaped = version.replace(/\./g, '\\.');
  const headerRe = new RegExp(`^## \\[${escaped}\\]`);
  const anyHeaderRe = /^## \[/;
  const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n');
  const start = lines.findIndex((l) => headerRe.test(l));
  if (start === -1) {
    console.error(`no '## [${version}]' entry found in CHANGELOG.md`);
    process.exit(1);
  }
  const after = lines.findIndex((l, i) => i > start && anyHeaderRe.test(l));
  block = lines.slice(start, after === -1 ? lines.length : after);
}

// 追踪 `{ indent: number }` 帧的栈，使续行能附加到正确的祖先节点。
// 处理嵌套列表后的续行模式：
//
//     - 顶层
//         - 嵌套
//       回到顶层  <- 2 空格缩进，合并到顶层条目
const out = [];
let buf = '';
let stack = [];

function flushBuf() {
  if (buf !== '') {
    out.push(buf);
    buf = '';
  }
}

function leadingSpaces(s) {
  const m = s.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

// 条目符号仅限 `-`、`*`、`数字.`。`+` 被有意排除——
// CHANGELOG 行内使用字面 `+`（如 `config + instructions`），
// 不希望将其误识别为嵌套条目。
const listItemRe = /^(\s*)([-*]|\d+\.)\s+/;
const fenceRe = /^\s*```/;

let inFence = false;

for (const line of block) {
  // 围栏代码块：原样透传，不合并。
  if (fenceRe.test(line)) {
    flushBuf();
    stack = [];
    out.push(line);
    inFence = !inFence;
    continue;
  }
  if (inFence) {
    out.push(line);
    continue;
  }
  if (/^\s*$/.test(line)) {
    flushBuf();
    out.push('');
    continue;
  }
  if (/^#/.test(line)) {
    flushBuf();
    stack = [];
    out.push(line);
    continue;
  }
  const itemMatch = line.match(listItemRe);
  if (itemMatch) {
    flushBuf();
    const indent = itemMatch[1].length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    stack.push({ indent });
    buf = line;
    continue;
  }
  if (/^\s/.test(line)) {
    const indent = leadingSpaces(line);
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      flushBuf();
      stack.pop();
    }
    const trimmed = line.replace(/^\s+/, '');
    buf = buf === '' ? trimmed : `${buf} ${trimmed}`;
    continue;
  }
  flushBuf();
  stack = [];
  out.push(line);
}
flushBuf();

process.stdout.write(out.join('\n'));
if (!out[out.length - 1]?.endsWith('\n')) process.stdout.write('\n');
