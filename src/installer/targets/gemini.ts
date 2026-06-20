/**
 * Gemini CLI target（同时覆盖更名后的"Antigravity CLI"——
 * Google 正在将其 CLI 工具统一到 Antigravity 下，新 CLI 继续读取
 * `~/.gemini/settings.json` 和项目本地的 `.gemini/settings.json`）。写入：
 *
 *   - MCP 服务器条目到 `~/.gemini/settings.json`（全局）或
 *     `./.gemini/settings.json`（本地），使用标准 `mcpServers.synapse` 键。
 *     与 Claude / Cursor 格式相同。
 *   - Instructions 到 `~/.gemini/GEMINI.md`（全局）或 `./GEMINI.md`
 *     （本地——Gemini 直接读取项目根目录的文件，而非 `.gemini/` 下的文件）。
 *
 * 无权限概念——Gemini CLI 通过每个服务器的 `trust` 字段控制工具调用，
 * 而非外部允许列表。我们不设置 `trust`，由用户自行控制确认提示。
 *
 * Antigravity IDE 共享 `~/.gemini/GEMINI.md` 作为 instructions，但使用
 * 独立的 MCP 配置文件（`~/.gemini/antigravity/mcp_config.json`）——
 * 参见 `./antigravity.ts`。两个 target 同时写入 GEMINI.md 是安全的：
 * 基于标记的章节替换使第二次写入成为字节完全相同的空操作。
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
    ? path.join(os.homedir(), '.gemini')
    : path.join(process.cwd(), '.gemini');
}
function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}
function instructionsPath(loc: Location): string {
  // 全局 GEMINI.md 位于 ~/.gemini/ 下；项目本地 GEMINI.md
  // 位于项目根目录（不在 .gemini/ 下），与 Gemini CLI 层级上下文
  // 加载器的搜索方式一致。
  return loc === 'global'
    ? path.join(configDir('global'), 'GEMINI.md')
    : path.join(process.cwd(), 'GEMINI.md');
}

class GeminiTarget implements AgentTarget {
  readonly id = 'gemini' as const;
  readonly displayName = 'Gemini CLI';
  readonly docsUrl = 'https://geminicli.com/docs/tools/mcp-server/';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = settingsJsonPath(loc);
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

    // GEMINI.md 写入简短的标记围栏式 Synapse 块（#704）：
    // 子智能体和非 MCP 运行环境会读取 GEMINI.md，但不接收 MCP
    // initialize 指令。Upsert 可自动修复过时的 #529 前块。
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const file = settingsJsonPath(loc);
    const config = readJsonFile(file);
    if (config.mcpServers?.synapse) {
      delete config.mcpServers.synapse;
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }
      // 若文件现在是空的 `{}`，我们仍保留它——用户以后可能添加的其他
      // 顶层 Gemini 设置可以共用此文件；删除它会令人意外。
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    files.push(removeInstructionsEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = settingsJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { synapse: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [settingsJsonPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
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
 * 若之前的安装写入了标记分隔的 Synapse 块，则从 GEMINI.md 中将其清除。
 * install（升级时自愈）和 uninstall 均会使用——见 issue #529。
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, SYNAPSE_SECTION_START, SYNAPSE_SECTION_END);
  return { path: file, action };
}

export const geminiTarget: AgentTarget = new GeminiTarget();
