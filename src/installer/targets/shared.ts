/**
 * 各 `AgentTarget` 实现共用的辅助函数。
 *
 * 从原始的 `config-writer.ts` 提取而来，使每个 target 可以组合使用，
 * 而无需继承。刻意保持精简——各 target 差异足够大（JSON vs TOML vs Markdown，
 * 幂等标记各异），基类反而会把不自然的形状强加给所有人。
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  SYNAPSE_INSTRUCTIONS_BLOCK,
  SYNAPSE_SECTION_START,
  SYNAPSE_SECTION_END,
} from '../instructions-template';

/**
 * synapse 注入的 MCP 服务器配置块。在所有 JSON 格式的智能体配置
 * （Claude、Cursor、opencode）中形状相同，只有外层包装不同。
 * Codex（TOML）自行构建配置块。
 */
export function getMcpServerConfig(): { type: string; command: string; args: string[] } {
  return {
    type: 'stdio',
    command: 'synapse',
    args: ['serve', '--mcp'],
  };
}

/**
 * Claude `settings.json` 的权限列表。其他有权限概念的 target 可直接
 * 组合此列表。权限字符串遵循 Claude 的 `mcp__<server>__<tool>` 格式。
 */
export function getSynapsePermissions(): string[] {
  return [
    'mcp__synapse__synapse_explore',
    'mcp__synapse__synapse_search',
    'mcp__synapse__synapse_node',
    'mcp__synapse__synapse_callers',
    'mcp__synapse__synapse_callees',
    'mcp__synapse__synapse_impact',
    'mcp__synapse__synapse_files',
    'mcp__synapse__synapse_status',
  ];
}

/**
 * 读取 JSON 文件，文件不存在或无法解析时返回 `{}`。
 *
 * 无法解析的文件在返回 `{}` 前会被备份到 `<path>.backup`——
 * 这样幂等的重复运行就不会在用户现有配置临时无法解析时悄悄删除它。
 */
export function readJsonFile(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: Could not parse ${path.basename(filePath)}: ${msg}`);
    console.warn(`  A backup will be created before overwriting.`);
    try {
      fs.copyFileSync(filePath, filePath + '.backup');
    } catch { /* 忽略备份失败 */ }
    return {};
  }
}

/**
 * 原子写入文件：先写入 `<path>.tmp.<pid>`，再重命名。
 *
 * 防止进程在写入过程中崩溃导致文件损坏。重命名失败时会清理临时文件。
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* 忽略 */ }
    throw err;
  }
}

/**
 * 原子 JSON 写入。末尾换行符遵循每个现有 target 的惯例——
 * 保持对 diff 友好的文件格式。
 */
export function writeJsonFile(filePath: string, data: Record<string, any>): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * 对两个 JSON 值进行深度相等比较，忽略键的顺序。
 *
 * 用于幂等性判断：当磁盘上的配置已与我们要写入的内容完全一致时，
 * 返回 action=`unchanged` 而非重写（避免输出令人困惑的"Updated"日志行）。
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonDeepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  if (ak.length !== bk.length) return false;
  if (!ak.every((k, i) => k === bk[i])) return false;
  return ak.every((k) => jsonDeepEqual(ao[k], bo[k]));
}

/**
 * 替换或追加 markdown 类文件中的标记分隔章节。
 *
 * 供 Claude / Codex 用于 `<!-- SYNAPSE_START --> ... <!-- SYNAPSE_END -->`
 * 块。逐字保留标记以外的所有内容。
 *
 * 文件不存在时返回 `created`；找到标记并替换内容时返回 `updated`；
 * 未找到标记并在末尾追加章节时返回 `appended`；现有块已与 `body`
 * 完全一致时返回 `unchanged`。
 */
export function replaceOrAppendMarkedSection(
  filePath: string,
  body: string,
  startMarker: string,
  endMarker: string,
): 'created' | 'updated' | 'appended' | 'unchanged' {
  if (!fs.existsSync(filePath)) {
    atomicWriteFileSync(filePath, body + '\n');
    return 'created';
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx !== -1 && endIdx > startIdx) {
    const existingBlock = content.substring(startIdx, endIdx + endMarker.length);
    if (existingBlock === body) {
      return 'unchanged';
    }
    const before = content.substring(0, startIdx);
    const after = content.substring(endIdx + endMarker.length);
    atomicWriteFileSync(filePath, before + body + after);
    return 'updated';
  }

  // 无标记——追加。保留现有内容并以空行分隔。
  const trimmed = content.trimEnd();
  const sep = trimmed.length > 0 ? '\n\n' : '';
  atomicWriteFileSync(filePath, trimmed + sep + body + '\n');
  return 'appended';
}

/**
 * 将 Synapse instructions 块更新插入到智能体 instructions 文件
 * （CLAUDE.md / AGENTS.md / GEMINI.md）中。每个 target 共享的唯一写入操作：
 * 自动修复过时的 #529 前长块（标记匹配则替换为当前短块），否则追加在现有
 * 用户内容之后，字节完全相同的重复运行报告 `unchanged` 以保持幂等性。
 * 参见 `instructions-template.ts`，了解此块存在的原因（#704：子智能体 +
 * 非 MCP 运行环境从不接收 MCP initialize 指令）。
 */
export function upsertInstructionsEntry(file: string): { path: string; action: 'created' | 'updated' | 'unchanged' } {
  const action = replaceOrAppendMarkedSection(
    file,
    SYNAPSE_INSTRUCTIONS_BLOCK,
    SYNAPSE_SECTION_START,
    SYNAPSE_SECTION_END,
  );
  return { path: file, action: action === 'appended' ? 'updated' : action };
}

/**
 * `replaceOrAppendMarkedSection` 的逆操作。若存在标记块则从
 * `filePath` 中移除。移除后文件为空时，完全删除该文件（与现有
 * Claude 卸载行为一致）。
 *
 * 内容被移除时返回 `removed`，标记不存在时返回 `not-found`，
 * 文件本就不存在时返回 `kept`。
 */
export function removeMarkedSection(
  filePath: string,
  startMarker: string,
  endMarker: string,
): 'removed' | 'not-found' | 'kept' {
  if (!fs.existsSync(filePath)) return 'kept';

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 'kept';
  }

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx <= startIdx) return 'not-found';

  const before = content.substring(0, startIdx).trimEnd();
  const after = content.substring(endIdx + endMarker.length).trimStart();
  const joined = before + (before && after ? '\n\n' : '') + after;

  if (joined.trim() === '') {
    try { fs.unlinkSync(filePath); } catch { /* 忽略 */ }
  } else {
    atomicWriteFileSync(filePath, joined.trim() + '\n');
  }
  return 'removed';
}
