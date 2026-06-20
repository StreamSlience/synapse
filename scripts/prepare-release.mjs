#!/usr/bin/env node
/**
 * 将 CHANGELOG.md 中 `## [Unreleased]` 的内容提升为 `## [<version>]`，
 * 使 release.yml workflow 的 `extract-release-notes.mjs <version>` 调用
 * 能获取到自上次发布以来落地的所有内容。
 *
 * **存在原因：** 以前 release workflow 直接执行
 * `extract-release-notes.mjs <version>` 查找，带 `[Unreleased]` 回退。
 * 回退仅在 `[<version>]` 块完全不存在时触发——而实际上维护者有时
 * 会预先填充一个稀疏的 `[<version>]` 块（如在其余工作落地前就记录了
 * 某个早期修复）。workflow 会提取那个稀疏块，忽略其上方内容丰富的
 * `[Unreleased]` 节——导致已发布说明遗漏了大部分实际内容。
 * 参见 v0.9.5 的典型复盘。
 *
 * **幂等操作内容：**
 *
 *   情况 A — `[<version>]` 尚不存在：
 *     将 `[Unreleased]` 标题重命名为 `[<version>] - <YYYY-MM-DD>`，
 *     并在其上方添加一个新的空 `## [Unreleased]` 块。这是常见情况。
 *
 *   情况 B — `[<version>]` 已存在且 `[Unreleased]` 有内容：
 *     将 `[Unreleased]` 的子节（### Added / ### Fixed /
 *     ### Changed / ### Removed / ### Deprecated / ### Security）
 *     合并到 `[<version>]` 对应子节。未匹配的子节追加到 `[<version>]`。
 *     然后清空 `[Unreleased]` 块。
 *
 *   情况 C — `[Unreleased]` 无内容：
 *     空操作，退出码 0。workflow 重复运行是安全的。
 *
 * **日期来源：** 情况 A 中，`<YYYY-MM-DD>` 为运行时的 UTC 日期，
 * 与现有 CHANGELOG 约定一致。
 *
 * **用法：**
 *
 *   node scripts/prepare-release.mjs                # 从 package.json 读取版本号
 *   node scripts/prepare-release.mjs 1.2.3          # 显式指定版本号
 *
 * **输出：**
 *
 *   原地写入 CHANGELOG.md，并向 stdout 打印摘要行，
 *   如 `prepare-release: 0.9.5 — promoted 6 Unreleased entries`。
 *   解析失败时退出码非零。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CHANGELOG_PATH = resolve(process.cwd(), 'CHANGELOG.md');

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  if (!pkg.version) throw new Error('package.json has no "version" field');
  return pkg.version;
}

function todayUtcIsoDate() {
  // UTC 格式 YYYY-MM-DD。与 CHANGELOG 现有约定一致
  //（现有日期条目未注明时区，但 UTC 在各 runner 上稳定，
  // 也是 workflow runner 默认产生的格式）。
  return new Date().toISOString().slice(0, 10);
}

/**
 * 将 CHANGELOG 拆分为头部前置内容 + 有序的版本块列表 `{ header, body[] }`，
 * 逐字保留行内容，以便重新合并时无意外。
 */
function parseChangelog(text) {
  const lines = text.split('\n');
  const versionHeaderRe = /^## \[([^\]]+)\](?:\s+-\s+(.+))?\s*$/;
  const preface = [];
  const blocks = []; // { header: string, name: string, body: string[] }
  let cur = null;
  for (const line of lines) {
    const m = line.match(versionHeaderRe);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { header: line, name: m[1], date: m[2] ?? null, body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      preface.push(line);
    }
  }
  if (cur) blocks.push(cur);
  return { preface, blocks };
}

function joinChangelog({ preface, blocks }) {
  const parts = [preface.join('\n')];
  for (const b of blocks) {
    // 重建：header + body。块的 body 包含标题后的空行（原样捕获）。
    parts.push([b.header, ...b.body].join('\n'));
  }
  return parts.join('\n');
}

/**
 * 将块的 body 拆分为有序子节，以 `### Heading` 为键。
 * 第一个 `### Heading` 之前的行归入 `leading`。
 * 在每个子节内保留原始（行数组）body，以便合并时能干净地拼接。
 */
function splitSubsections(body) {
  const subsectionRe = /^### (\w+)\s*$/;
  const leading = [];
  const subs = []; // { heading: 'Added' | 'Fixed' | …, headerLine: string, body: string[] }
  let cur = null;
  for (const line of body) {
    const m = line.match(subsectionRe);
    if (m) {
      if (cur) subs.push(cur);
      cur = { heading: m[1], headerLine: line, body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      leading.push(line);
    }
  }
  if (cur) subs.push(cur);
  return { leading, subs };
}

function rebuildBody({ leading, subs }) {
  const parts = [];
  if (leading.length) parts.push(leading.join('\n'));
  for (const s of subs) {
    parts.push([s.headerLine, ...s.body].join('\n'));
  }
  return parts.join('\n').split('\n');
}

/**
 * 当块中含有任何实质性条目（以 `-`、`*` 或数字开头的条目行）时返回 true，
 * 而非空块 / 仅有空白 / 仅有子节标题但无内容的情况。
 */
function blockHasContent(body) {
  for (const line of body) {
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) return true;
  }
  return false;
}

/**
 * 去除行数组末尾的空行并返回。
 * 使合并时的输出保持整洁。
 */
function trimTrailingBlank(arr) {
  let i = arr.length;
  while (i > 0 && /^\s*$/.test(arr[i - 1])) i--;
  return arr.slice(0, i);
}

function main() {
  const versionArg = process.argv[2];
  const version = versionArg || readPackageVersion();

  const text = readFileSync(CHANGELOG_PATH, 'utf8');
  const parsed = parseChangelog(text);

  const unrelIdx = parsed.blocks.findIndex((b) => b.name === 'Unreleased');
  const verIdx = parsed.blocks.findIndex((b) => b.name === version);

  if (unrelIdx === -1) {
    console.log(`prepare-release: no [Unreleased] block — nothing to do`);
    return;
  }

  const unrel = parsed.blocks[unrelIdx];
  if (!blockHasContent(unrel.body)) {
    console.log(`prepare-release: [Unreleased] is empty — nothing to do`);
    return;
  }

  if (verIdx === -1) {
    // 情况 A — 将 Unreleased 提升为 [version]。
    const today = todayUtcIsoDate();
    const promoted = {
      header: `## [${version}] - ${today}`,
      name: version,
      date: today,
      body: trimTrailingBlank(unrel.body).concat(['']), // single trailing blank
    };
    const emptied = {
      header: `## [Unreleased]`,
      name: 'Unreleased',
      date: null,
      body: ['', ''], // two blank lines for the next round of entries
    };
    parsed.blocks.splice(unrelIdx, 1, emptied, promoted);
    const next = joinChangelog(parsed);
    writeFileSync(CHANGELOG_PATH, appendLinkRef(next, version));
    console.log(`prepare-release: ${version} — renamed [Unreleased] to [${version}] - ${today}`);
    return;
  }

  // 情况 B — 将 Unreleased 子节合并到已有的 [version] 子节中。
  // Unreleased 中出现但 [version] 中不存在的子节标题，追加到末尾。
  const ver = parsed.blocks[verIdx];
  const unrelSubs = splitSubsections(unrel.body);
  const verSubs = splitSubsections(ver.body);

  let merged = 0;
  for (const us of unrelSubs.subs) {
    const target = verSubs.subs.find((s) => s.heading === us.heading);
    const usBody = trimTrailingBlank(us.body);
    if (usBody.length === 0) continue;
    if (target) {
      // 将 Unreleased 的条目追加到 version 匹配子节的末尾，保留原始顺序。
      // 若现有子节末尾不是空行，则插入一个分隔空行。
      const existing = trimTrailingBlank(target.body);
      const sep = existing.length && !/^\s*$/.test(existing[existing.length - 1]) ? [''] : [];
      target.body = existing.concat(sep, usBody, ['']);
    } else {
      // Append the whole sub-section to the end.
      verSubs.subs.push({
        heading: us.heading,
        headerLine: us.headerLine,
        body: usBody.concat(['']),
      });
    }
    merged += usBody.filter((l) => /^\s*([-*]|\d+\.)\s+/.test(l)).length;
  }

  ver.body = rebuildBody(verSubs);
  // 清空 Unreleased。
  unrel.body = ['', ''];

  const merged_text = joinChangelog(parsed);
  writeFileSync(CHANGELOG_PATH, appendLinkRef(merged_text, version));
  console.log(`prepare-release: ${version} — merged ${merged} Unreleased entries into existing [${version}] block`);
}

/**
 * 如果文件末尾尚无 `[X.Y.Z]: https://github.com/colbymchenry/synapse/releases/tag/vX.Y.Z`
 * 链接引用，则追加一个。该链接引用使 `## [X.Y.Z]` 标题文本在 GitHub 渲染器中
 * 自动链接到对应 tag；没有它标题仍会渲染，但不会超链接。
 *
 * 幂等。现有 CHANGELOG 混合了分散在文件中的链接引用和底部的有序块——
 * 我们直接追加到最末尾，CommonMark 无论如何都接受。
 */
function appendLinkRef(text, version) {
  const refLine = `[${version}]: https://github.com/colbymchenry/synapse/releases/tag/v${version}`;
  // 已存在？在文件任意位置查找与此完全相等的行，
  // 使幂等性对分散 vs 块状布局均健壮。
  const lines = text.split('\n');
  if (lines.some((l) => l.trim() === refLine)) return text;
  // 追加，与前面内容之间用空行分隔。保留 EOF 处的单个换行符。
  const trailingNewline = text.endsWith('\n') ? '' : '\n';
  return text + trailingNewline + refLine + '\n';
}

try {
  main();
} catch (err) {
  console.error(`prepare-release: ${err?.message ?? err}`);
  process.exit(1);
}
