/**
 * 向后兼容的 shim——原始仅针对 Claude 的写入函数。
 *
 * 安装器现已采用 `./targets/` 下的多目标架构。保留此文件是为了让现有的
 * 导入（测试套件、下游工具）保持不变。每个函数均委托给 Claude target。
 * 新代码应直接从 `./targets/registry` 导入 target 注册表。
 *
 * @deprecated 请改用 `targets/registry.ts` 和 `AgentTarget` 抽象。
 */

import * as path from 'path';
import * as os from 'os';
import {
  writeMcpEntry,
  writePermissionsEntry,
} from './targets/claude';
import { readJsonFile } from './targets/shared';

export type InstallLocation = 'global' | 'local';

/**
 * 每个 shim 仅调用指定的单文件辅助函数——writeMcpConfig 只写 MCP JSON，
 * writePermissions 只写 settings.json。完整的多文件安装逻辑位于
 * `claudeTarget.install()` 中，由新的编排器调用。
 *
 * 不再存在 `writeClaudeMd` shim：自从 MCP 服务器的 `initialize` 指令成为
 * 唯一真实来源后，synapse 已停止向 CLAUDE.md 写入 instructions 块（issue #529）。
 */
export function writeMcpConfig(location: InstallLocation): void {
  writeMcpEntry(location);
}

export function writePermissions(location: InstallLocation): void {
  writePermissionsEntry(location);
}

export function hasMcpConfig(location: InstallLocation): boolean {
  // 本地作用域存放于 ./.mcp.json（项目范围）；全局为用户范围的 ~/.claude.json。
  // 与 Claude target 的路径保持镜像。
  const file = location === 'global'
    ? path.join(os.homedir(), '.claude.json')
    : path.join(process.cwd(), '.mcp.json');
  const config = readJsonFile(file);
  return !!config.mcpServers?.synapse;
}

export function hasPermissions(location: InstallLocation): boolean {
  const file = location === 'global'
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(process.cwd(), '.claude', 'settings.json');
  const settings = readJsonFile(file);
  const allow = settings.permissions?.allow;
  if (!Array.isArray(allow)) return false;
  return allow.some((p: string) => p.startsWith('mcp__synapse__'));
}
