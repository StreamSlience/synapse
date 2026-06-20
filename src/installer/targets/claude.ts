/**
 * Claude Code target。写入：
 *
 *   - MCP 服务器条目到 `~/.claude.json`（全局 = 用户范围，在每个项目中加载）
 *     或 `./.mcp.json`（本地 = 项目范围，Claude Code 实际读取单个项目的文件）。
 *     参见 https://code.claude.com/docs/en/mcp 的范围表。
 *   - 权限到 `~/.claude/settings.json`（全局）或 `./.claude/settings.json`（本地），
 *     受 `autoAllow` 控制。
 *   - Instructions 到 `~/.claude/CLAUDE.md`（全局）或 `./.claude/CLAUDE.md`（本地）。
 *
 * 早期版本将本地 MCP 条目写入 `./.claude.json`——Claude Code 从不读取该文件——
 * 导致服务器始终静默未加载，直到用户手动将其重命名为 `.mcp.json`（issue #207）。
 * 现在改为写入 `./.mcp.json`，并在安装和卸载时将过时的 `./.claude.json` 条目迁移走。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  getSynapsePermissions,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  writeJsonFile,
  upsertInstructionsEntry,
} from './shared';
import {
  SYNAPSE_SECTION_END,
  SYNAPSE_SECTION_START,
} from '../instructions-template';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.claude')
    : path.join(process.cwd(), '.claude');
}
function mcpJsonPath(loc: Location): string {
  // global → ~/.claude.json（用户范围：在每个项目中可见）。
  // local  → ./.mcp.json（项目范围：Claude Code 读取的唯一项目级 MCP
  // 文件——不是 ./.claude.json，后者会被忽略）。
  return loc === 'global'
    ? path.join(os.homedir(), '.claude.json')
    : path.join(process.cwd(), '.mcp.json');
}
/**
 * #207 之前的安装器写入本地 MCP 条目的位置。Claude Code 从不读取项目级
 * `./.claude.json`，因此我们在安装时将 synapse 条目从中迁移出去，
 * 并在卸载时将其清除。只有项目本地路径是遗留路径——全局的 `~/.claude.json`
 * 是正确的用户范围位置，保持不变。
 */
function legacyLocalMcpPath(): string {
  return path.join(process.cwd(), '.claude.json');
}
function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}
function instructionsPath(loc: Location): string {
  return path.join(configDir(loc), 'CLAUDE.md');
}

class ClaudeCodeTarget implements AgentTarget {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly docsUrl = 'https://docs.claude.com/en/docs/claude-code';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.synapse;
    // 对"已安装"的推断来自配置目录（全局）或项目标记文件（本地）是否存在。
    // 开销低，且避免了调用 `claude --version`。
    const installed = loc === 'global'
      ? fs.existsSync(configDir(loc)) || fs.existsSync(mcpPath)
      : fs.existsSync(mcpPath) || fs.existsSync(configDir(loc));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP 服务器条目
    files.push(writeMcpEntry(loc));

    // 1b. 迁移过时的 ./.claude.json（由 #207 之前的本地安装留下），
    // 避免项目同时存在两个相互竞争（其中一个失效）的 MCP 配置。
    if (loc === 'local') {
      const migrated = cleanupLegacyLocalMcp();
      if (migrated) files.push(migrated);
    }

    // 2. 权限（仅当 autoAllow 时）
    if (opts.autoAllow) {
      files.push(writePermissionsEntry(loc));
    }

    // 2b. 清除 0.8 之前安装遗留的自动同步 hooks。这些版本向 settings.json
    // 写入了 `synapse mark-dirty` / `sync-if-dirty` hooks；两个子命令均已
    // 从 CLI 移除，导致 Stop hook 每轮都以"unknown command 'sync-if-dirty'"
    // 失败。在安装时清理可让升级自愈。仅在实际有内容被移除时展示。
    const hookCleanup = cleanupLegacyHooks(loc);
    if (hookCleanup.action === 'removed') files.push(hookCleanup);

    // 3. CLAUDE.md instructions——简短的标记围栏式 Synapse 块（#704）。
    // MCP initialize 指令只能到达主智能体；CLAUDE.md 才是 Task-tool 子智能体
    // （以及非 MCP 运行环境）实际看到的内容，因此该块在那里存放 synapse 指引。
    // Upsert 可自动修复过时的 #529 前长块。
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP 服务器条目
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    if (config.mcpServers?.synapse) {
      delete config.mcpServers.synapse;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    // 1b. 同时从遗留的 ./.claude.json 中清除 synapse 条目，
    // 以完全还原 #207 之前的本地安装。
    if (loc === 'local') {
      const migrated = cleanupLegacyLocalMcp();
      if (migrated) files.push(migrated);
    }

    // 2. 权限
    const settingsPath = settingsJsonPath(loc);
    const settings = readJsonFile(settingsPath);
    if (Array.isArray(settings.permissions?.allow)) {
      const before = settings.permissions.allow.length;
      settings.permissions.allow = settings.permissions.allow.filter(
        (p: string) => !p.startsWith('mcp__synapse__'),
      );
      if (settings.permissions.allow.length !== before) {
        if (settings.permissions.allow.length === 0) {
          delete settings.permissions.allow;
        }
        if (Object.keys(settings.permissions).length === 0) {
          delete settings.permissions;
        }
        writeJsonFile(settingsPath, settings);
        files.push({ path: settingsPath, action: 'removed' });
      } else {
        files.push({ path: settingsPath, action: 'not-found' });
      }
    } else {
      files.push({ path: settingsPath, action: 'not-found' });
    }

    // 2b. 清除 0.8 之前安装在 settings.json 中遗留的自动同步 hooks。
    // 安装器迁移到按 target 架构时，hook 清理步骤丢失；在此恢复意味着
    // 卸载——以及驱动它的 npm `preuninstall` hook——可完整还原遗留安装。
    const hookCleanup = cleanupLegacyHooks(loc);
    if (hookCleanup.action === 'removed') files.push(hookCleanup);

    // 3. Instructions——若存在则清除遗留的 Synapse 块。
    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { synapse: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), settingsJsonPath(loc), instructionsPath(loc)];
  }
}

/**
 * 各文件写入辅助函数，已导出供遗留的 `config-writer.ts` shim 调用——
 * 仅执行具名操作（writeMcpConfig 只写 MCP 条目等），而非调用会同时写入
 * 三个文件的 `claudeTarget.install()`。若不做此拆分，shim 会静默产生
 * 调用方不期望的副作用。
 */
export function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.synapse;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    // 已与我们要写入的内容完全一致——保留字节完全相同的文件。
    return { path: file, action: 'unchanged' };
  }
  // 此处的 'created' 表示：此次写入前文件本身不存在。
  // 包含其他 MCP 服务器（无 `synapse` 键）的已有 MCP JSON 文件
  // （全局为 `~/.claude.json`，本地为 `./.mcp.json`）是 'updated'，
  // 而非 'created'——我们是在向一个本已存在的文件添加条目。
  // Codex 使用不同的惯例（内容为空则为 'created'），因为其 config.toml
  // 由我们独自管理。
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.synapse = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * 从遗留的项目本地 `./.claude.json`（由 #207 之前的安装器写入，
 * Claude Code 从未读取）中清除 synapse 条目。精确操作：仅移除我们的
 * `synapse` 键，保留同级 MCP 服务器和所有无关键，且仅在移除后文件
 * 完全为空时才删除文件。返回文件 action 用于报告，无需迁移时返回 `null`。
 */
function cleanupLegacyLocalMcp(): WriteResult['files'][number] | null {
  const file = legacyLocalMcpPath();
  if (!fs.existsSync(file)) return null;
  const config = readJsonFile(file);
  if (!config.mcpServers?.synapse) return null;
  delete config.mcpServers.synapse;
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  if (Object.keys(config).length === 0) {
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
  } else {
    writeJsonFile(file, config);
  }
  return { path: file, action: 'removed' };
}

/**
 * 若某个 Claude Code hook `command` 是 0.8 之前安装写入的自动同步 hook，
 * 则返回 true。这些安装器添加了
 * `PostToolUse(Edit|Write) → synapse mark-dirty` 和
 * `Stop → synapse sync-if-dirty`（本地构建使用
 * `npx @colbymchenry/synapse …` 形式，其中仍包含 `synapse <subcommand>`
 * 子字符串）。两个子命令后来均从 CLI 移除，导致 Stop hook 每轮都以
 * "unknown command 'sync-if-dirty'" 失败。通过匹配 synapse 范围的子命令，
 * 保持无关的用户 hook（例如 GitKraken 的 `gk ai hook run`）不受影响。
 */
function isLegacySynapseHookCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  return (
    command.includes('synapse mark-dirty') ||
    command.includes('synapse sync-if-dirty')
  );
}

/**
 * 从 Claude `settings.json` 中移除过时的 synapse 自动同步 hooks。
 *
 * 精确到单个命令级别：仅删除匹配 `isLegacySynapseHookCommand` 的条目，
 * 因此与我们共享 matcher 组（或 Stop 事件）的同级 hook 得以保留。
 * 仅当 `hooks` 数组为空时才剪除 matcher 组，仅当没有组剩余时才剪除事件，
 * 仅当每个事件都已消失时才剪除顶层 `hooks`——而且只有在我们实际移除了某个
 * synapse 命令的情况下才执行上述操作，因此不含遗留 hooks 的 settings.json
 * 保持字节完全不变并报告 `unchanged`。
 *
 * 已导出，可直接单元测试，并可被 `install`（升级时自愈）和 `uninstall`
 * 复用。
 */
export function cleanupLegacyHooks(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };

  const settings = readJsonFile(file);
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { path: file, action: 'unchanged' };
  }

  // 第一轮：从每个 matcher 组内部删除遗留命令。
  let removedAny = false;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter(
        (h: any) => !isLegacySynapseHookCommand(h?.command),
      );
      if (group.hooks.length !== before) removedAny = true;
    }
  }

  if (!removedAny) return { path: file, action: 'unchanged' };

  // 第二轮：剪除空的 matcher 组，再剪除没有组剩余的事件，
  // 最后剪除空的顶层 `hooks`。由 `removedAny` 保护，
  // 确保对没有 synapse hooks 的 settings.json 不做任何重构。
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    hooks[event] = groups.filter(
      (g: any) => !(g && Array.isArray(g.hooks) && g.hooks.length === 0),
    );
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;

  writeJsonFile(file, settings);
  return { path: file, action: 'removed' };
}

export function writePermissionsEntry(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  const settings = readJsonFile(file);
  const created = !fs.existsSync(file);

  if (!settings.permissions) settings.permissions = {};
  if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

  const want = getSynapsePermissions();
  const before = [...settings.permissions.allow];
  for (const perm of want) {
    if (!settings.permissions.allow.includes(perm)) {
      settings.permissions.allow.push(perm);
    }
  }
  if (jsonDeepEqual(before, settings.permissions.allow) && !created) {
    return { path: file, action: 'unchanged' };
  }
  writeJsonFile(file, settings);
  return { path: file, action: created ? 'created' : 'updated' };
}

/**
 * 若存在则从 CLAUDE.md 中清除标记分隔的 Synapse 块。Synapse 不再维护
 * instructions 文件（issue #529）——MCP 服务器的 `initialize` 指令是唯一
 * 真实来源——因此 install（升级时自愈）和 uninstall 均会调用此函数。
 * 无内容可清除时 `removeMarkedSection` 返回 `not-found`/`kept`；
 * install 调用方会将这些从报告中过滤掉，使全新安装保持静默。
 */
export function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, SYNAPSE_SECTION_START, SYNAPSE_SECTION_END);
  return { path: file, action };
}

export const claudeTarget: AgentTarget = new ClaudeCodeTarget();
