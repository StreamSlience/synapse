/**
 * Kiro CLI / IDE target。写入：
 *
 *   - MCP 服务器条目到 `~/.kiro/settings/mcp.json`（全局）或
 *     `./.kiro/settings/mcp.json`（本地）。标准 `mcpServers.synapse`
 *     格式，与 Claude / Cursor / Gemini 相同。
 *   - Instructions 到 `~/.kiro/steering/synapse.md`（全局）或
 *     `./.kiro/steering/synapse.md`（本地）。Kiro 的"steering"系统
 *     将 steering 目录中的每个 `*.md` 文件加载为智能体上下文，因此
 *     专用的 `synapse.md` 是自然的配置面——我们完全拥有该文件
 *     （无需基于标记的合并），并在卸载时删除它。
 *
 * 无权限概念——Kiro 通过其自有 UI 提示而非外部允许列表控制工具调用。
 * `autoAllow` 会被静默忽略。
 *
 * 路径在 macOS / Linux / Windows 上完全相同，因为 Kiro 在所有三个平台
 * 上都从 `os.homedir()` 解析配置根目录（Windows 的 `~` → `%USERPROFILE%\.kiro`）。
 *
 * 文档：https://kiro.dev/docs/cli/mcp/
 *       https://kiro.dev/docs/cli/steering/
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
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';

function configDir(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.kiro')
    : path.join(process.cwd(), '.kiro');
}
function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings', 'mcp.json');
}
function steeringPath(loc: Location): string {
  return path.join(configDir(loc), 'steering', 'synapse.md');
}

class KiroTarget implements AgentTarget {
  readonly id = 'kiro' as const;
  readonly displayName = 'Kiro';
  readonly docsUrl = 'https://kiro.dev/docs/cli/mcp/';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config.mcpServers?.synapse;
    const installed = loc === 'global'
      ? fs.existsSync(configDir('global')) || fs.existsSync(file)
      : fs.existsSync(file) || fs.existsSync(configDir('local'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));

    // steering 文档不再写入——synapse 使用指南已通过 MCP 服务器的
    // `initialize` 响应传递（issue #529）。删除之前安装创建的 `synapse.md`
    // 以使升级自愈。
    const steeringCleanup = removeSteeringEntry(loc);
    if (steeringCleanup.action === 'removed') files.push(steeringCleanup);

    return {
      files,
      // 仅 IDE 的启用 MCP 步骤是必不可少的：Kiro IDE 默认禁用 MCP 支持，
      // 因此即使在文档路径下存在有效的 `~/.kiro/settings/mcp.json`，
      // 也会被忽略，直到用户切换开关。Kiro CLI 读取同一文件时没有此限制，
      // 因此我们在此说明适用对象。
      notes: [
        'Restart Kiro for MCP changes to take effect.',
        'Kiro IDE: also enable MCP in Settings (search "MCP" → "Enabled"). Kiro CLI users can skip this step.',
      ],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    if (config.mcpServers?.synapse) {
      delete config.mcpServers.synapse;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    files.push(removeSteeringEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { synapse: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), steeringPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing.mcpServers?.synapse;
  const after = getMcpServerConfig();

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
 * 删除我们拥有的 steering 文件。即使用户已将文件改得面目全非，我们仍会
 * 删除它——synapse.md 是我们声明的名称，部分安装留下文件比彻底清除更糟。
 * install（升级时自愈——见 issue #529）和 uninstall 均会使用。
 */
function removeSteeringEntry(loc: Location): WriteResult['files'][number] {
  const file = steeringPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  return { path: file, action: 'removed' };
}

export const kiroTarget: AgentTarget = new KiroTarget();
