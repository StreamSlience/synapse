/**
 * Google Antigravity IDE target。Antigravity 是 Google 基于 VS Code 的
 * 多智能体 IDE；Gemini CLI 正在与其整合，统一到单一智能体平台下。
 * Antigravity 从独立于 CLI 的配置文件中读取 MCP 服务器定义。
 *
 * ## 配置路径：统一版 vs 遗留版
 *
 * Antigravity 最近迁移到跨所有 Antigravity 工具共享的**统一** MCP 配置路径：
 *
 *   - **统一版**（迁移后，当前）：`~/.gemini/config/mcp_config.json`
 *     ——由 `~/.gemini/config/.migrated` 标记文件标识。
 *   - **遗留版**（迁移前）：`~/.gemini/antigravity/mcp_config.json`
 *     ——github-mcp-server 安装指南仍记录此路径。
 *
 * 我们在安装时检测标记并写入正确路径。卸载时同时清扫两个路径——
 * 这样，安装在遗留路径后被 Antigravity 自动迁移、再次运行 `synapse install`
 * 的用户不会在两个文件中留下过时的 synapse 条目。
 *
 * ## 条目格式：无 `type: stdio` 字段
 *
 * Antigravity 会拒绝携带其他 target 使用的 `type: "stdio"` 字段的 MCP 条目——
 * 它自身管理的有效条目（如 `code-review-graph`）均省略该字段，
 * 去掉该字段是让 synapse 出现在 Customizations UI 中的关键。
 * 我们在本地构建条目，而非通过 `getMcpServerConfig()` 路由。
 *
 * ## macOS GUI 应用 PATH 解析
 *
 * Antigravity 是 GUI Electron 应用。macOS 给 Dock/Finder 启动的应用
 * 一个精简的 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`）——nvm 管理的工具不在
 * 其中，因此即使 `which synapse` 在用户 shell 中可以解析，裸 `synapse` 命令
 * 也无法派生。我们在安装时将 `synapse` 解析为其在 macOS 上的绝对路径。
 * （Linux GUI 应用继承用户 PATH；Windows 直接使用 `PATH` 环境变量——两者
 * 使用裸命令均无问题。）
 *
 * ## 共享 instructions（此处不写 GEMINI.md）
 *
 * IDE 与 Gemini CLI 共享 `~/.gemini/GEMINI.md` 作为 instructions——由
 * `./gemini.ts` target 写入。我们故意不在此处触碰它，这样卸载 Antigravity
 * 而不卸载 Gemini CLI 时，CLI 的 instructions 保持完整。仅安装了 Antigravity
 * 的用户仍能获得可用的 MCP 集成；只是在未同时安装 gemini target 的情况下，
 * 优先使用 synapse 而非 grep 的指引不会出现。
 *
 * ## 位置
 *
 * `supportsLocation('local')` 返回 false——截至 2026-05，Antigravity 没有
 * 项目范围的配置概念。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

function unifiedConfigDir(): string {
  return path.join(os.homedir(), '.gemini', 'config');
}
function unifiedMcpConfigPath(): string {
  return path.join(unifiedConfigDir(), 'mcp_config.json');
}
function legacyConfigDir(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity');
}
function legacyMcpConfigPath(): string {
  return path.join(legacyConfigDir(), 'mcp_config.json');
}
function migratedMarkerPath(): string {
  return path.join(unifiedConfigDir(), '.migrated');
}

/**
 * 选择要写入的 MCP 配置路径。
 *
 * 当 Antigravity 已发出迁移信号时（`.migrated` 标记存在，或统一文件已存在——
 * Antigravity 在迁移后首次启动时会创建该文件），优先使用统一的
 * `~/.gemini/config/mcp_config.json`。对于使用迁移前 Antigravity 版本的用户，
 * 回退到遗留的 `~/.gemini/antigravity/mcp_config.json`。
 */
function preferredMcpConfigPath(): string {
  if (fs.existsSync(migratedMarkerPath())) return unifiedMcpConfigPath();
  if (fs.existsSync(unifiedMcpConfigPath())) return unifiedMcpConfigPath();
  return legacyMcpConfigPath();
}

/**
 * 解析 `synapse` 二进制的磁盘路径，使从 Dock/Finder 启动的 Mac GUI 应用
 * （PATH 已精简）也能找到它。以下情况回退到裸 `synapse` 名称：
 *
 *  - 非 macOS（Linux GUI 应用继承用户 PATH；Windows 直接使用 env PATH），或
 *  - 因任何原因查找失败（在 `which`/`command -v` 不可用的受限环境中
 *    保留安装能力）。
 *
 * 解析优先使用 `command -v`（内置，不操控 PATH），以 `which` 作为备选。
 * 两者均通过用户交互式 shell 的 PATH 在安装时读取——这正是查找
 * nvm 管理工具（如我们的工具）所需的 PATH。
 */
function resolveSynapseCommand(): string {
  if (process.platform !== 'darwin') return 'synapse';
  try {
    const resolved = execSync('command -v synapse || which synapse', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: '/bin/bash',
      windowsHide: true,
    }).trim();
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {
    /* fall through to bare name */
  }
  return 'synapse';
}

/**
 * 构建 Antigravity 的 synapse MCP 服务器条目。与 `getMcpServerConfig()`
 * 不同，原因在于 Antigravity (a) 拒绝 `type` 字段，(b) 在 macOS 上需要
 * 命令的绝对路径——见文件头注释。
 */
function buildAntigravityEntry(): { command: string; args: string[] } {
  return {
    command: resolveSynapseCommand(),
    args: ['serve', '--mcp'],
  };
}

class AntigravityTarget implements AgentTarget {
  readonly id = 'antigravity' as const;
  readonly displayName = 'Antigravity IDE';
  readonly docsUrl = 'https://antigravity.google';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = preferredMcpConfigPath();
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.synapse;
    // "已安装"启发式：统一配置目录、遗留配置目录或配置文件之一存在。
    // Antigravity 在首次启动时即会创建 ~/.gemini/，早于任何 MCP 配置。
    const installed =
      fs.existsSync(unifiedConfigDir()) ||
      fs.existsSync(legacyConfigDir()) ||
      fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Antigravity IDE has no project-local config — re-run with --location=global.'],
      };
    }
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry());
    // 若用户最初在遗留路径上安装了 synapse，而 Antigravity 此后已完成迁移，
    // 则清除遗留的过时条目，避免留下两个相互竞争的 synapse 配置。
    const legacyCleanup = cleanupLegacyEntry();
    if (legacyCleanup) files.push(legacyCleanup);
    return {
      files,
      notes: ['Restart Antigravity for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const files: WriteResult['files'] = [];

    // 删除首选路径中的条目。
    const preferred = preferredMcpConfigPath();
    files.push(removeSynapseFromFile(preferred));

    // 同时清扫另一个路径（首选为统一版时清扫遗留版，反之亦然）——
    // 处理 synapse 写入一个文件但 Antigravity 现在从另一个读取的半迁移状态。
    const other = preferred === unifiedMcpConfigPath()
      ? legacyMcpConfigPath()
      : unifiedMcpConfigPath();
    if (preferred !== other) {
      const otherResult = removeSynapseFromFile(other);
      // 仅在实际触碰了次要文件时展示它——
      // 用户从未有过的文件出现 `not-found` 只是噪声。
      if (otherResult.action === 'removed') files.push(otherResult);
    }

    return { files };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Antigravity IDE has no project-local config — use --location=global.\n';
    }
    const file = preferredMcpConfigPath();
    const snippet = JSON.stringify({ mcpServers: { synapse: buildAntigravityEntry() } }, null, 2);
    return `# Add to ${file}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc !== 'global') return [];
    return [preferredMcpConfigPath()];
  }
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = preferredMcpConfigPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.synapse;
  const after = buildAntigravityEntry();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' =
    before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.synapse = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * 若遗留的 `~/.gemini/antigravity/mcp_config.json` 中存在 synapse 条目，
 * 且我们正在写入统一路径，则清除该条目。用于在 Antigravity 迁移配置后，
 * 将在遗留路径上配置了 synapse 的用户迁移过来。返回文件 action 用于报告，
 * 无需清理时返回 `null`。
 */
function cleanupLegacyEntry(): WriteResult['files'][number] | null {
  if (preferredMcpConfigPath() !== unifiedMcpConfigPath()) return null;
  const legacy = legacyMcpConfigPath();
  if (!fs.existsSync(legacy)) return null;
  const config = readJsonFile(legacy);
  if (!config.mcpServers?.synapse) return null;
  delete config.mcpServers.synapse;
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  writeJsonFile(legacy, config);
  return { path: legacy, action: 'removed' };
}

function removeSynapseFromFile(file: string): WriteResult['files'][number] {
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const config = readJsonFile(file);
  if (!config.mcpServers?.synapse) return { path: file, action: 'not-found' };
  delete config.mcpServers.synapse;
  if (Object.keys(config.mcpServers).length === 0) {
    delete config.mcpServers;
  }
  // 保留现在为空的 `{}` 不删除——Antigravity 管理此文件，
  // 一个多余的空文件比意外删除更不令人惊讶。
  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

export const antigravityTarget: AgentTarget = new AntigravityTarget();
