/**
 * Cursor target。
 *
 *   - MCP 服务器条目到 `~/.cursor/mcp.json`（全局）或
 *     `./.cursor/mcp.json`（本地）。与 Claude 相同的 `{mcpServers: {...}}` 格式。
 *   - Instructions 到 `./.cursor/rules/synapse.mdc`（仅项目本地）。
 *     Cursor 的 rules 系统是项目范围的配置面；截至 2026-05，全局 cursor rules
 *     尚无稳定惯例。`--location=global` 时只写 mcp.json。
 *
 * ## 为何为 Cursor 硬编码 `--path`
 *
 * Cursor 以非工作区根目录的工作目录启动 MCP 服务器子进程，且在 MCP initialize
 * 调用时不传递 `rootUri` / `workspaceFolders`。因此 synapse MCP 服务器的
 * `process.cwd()` 回退无法找到工作区的 `.synapse/`，并在每次工具调用时
 * 报告"未初始化"。
 *
 * 所以我们自行将 `--path` 注入 args：
 *
 *   - `local` 安装：绝对路径（安装时已知）。
 *   - `global` 安装：`${workspaceFolder}`——Cursor 将其展开为已打开工作区的根，
 *     从单一全局配置实现按工作区行为。
 *
 * Codex 和 Claude 不需要此处理——前者以 `cwd = workspace` 启动 MCP 服务器，
 * 后者传递 `rootUri`。
 *
 * 无权限概念——Cursor 没有安装器可填充的自动允许列表。`autoAllow` 会被静默忽略。
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
  atomicWriteFileSync,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared';
import {
  SYNAPSE_SECTION_END,
  SYNAPSE_SECTION_START,
} from '../instructions-template';

function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(os.homedir(), '.cursor', 'mcp.json')
    : path.join(process.cwd(), '.cursor', 'mcp.json');
}
/**
 * Cursor "rules" 文件。仅对项目本地位置有意义——Cursor 从工作区根目录的
 * `.cursor/rules/*.mdc` 加载规则。截至 2026-05 没有全局等效位置。
 */
function rulesPath(): string {
  return path.join(process.cwd(), '.cursor', 'rules', 'synapse.mdc');
}

/**
 * Cursor `.mdc` rules 使用类 YAML 的 frontmatter。`alwaysApply: true`
 * 使规则在每次对话中都加载，不受文件模式限制——对于与用户让智能体
 * 浏览代码时始终相关的工具使用指南，这是适当的设置。
 */
const MDC_FRONTMATTER = [
  '---',
  'description: Synapse MCP usage guide — when to use which tool',
  'alwaysApply: true',
  '---',
  '',
].join('\n');

class CursorTarget implements AgentTarget {
  readonly id = 'cursor' as const;
  readonly displayName = 'Cursor';
  readonly docsUrl = 'https://docs.cursor.com/context/model-context-protocol';

  supportsLocation(_loc: Location): boolean {
    // 两者均支持，但 `local` 会写入更多文件（mcp.json + rules）；
    // `global` 只写 mcp.json。编排器通过 describePaths 展示差异。
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config.mcpServers?.synapse;
    // "已安装"启发式：~/.cursor 是否存在（全局），或用户是否选择了
    // 项目本地的 cursor 配置目录？
    const installed = loc === 'global'
      ? fs.existsSync(path.join(os.homedir(), '.cursor'))
      : fs.existsSync(path.join(process.cwd(), '.cursor'));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(loc));

    // 我们不再写入 `.cursor/rules/synapse.mdc`——synapse 使用指南已通过
    // MCP 服务器的 `initialize` 响应传递，这是唯一真实来源（issue #529）。
    // 清除之前安装创建的 rules 文件，使升级自愈。
    if (loc === 'local') {
      const rulesCleanup = removeRulesEntry();
      if (rulesCleanup.action === 'removed') files.push(rulesCleanup);
    }

    return {
      files,
      notes: ['Restart Cursor for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

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

    if (loc === 'local') {
      files.push(removeRulesEntry());
    }

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { synapse: buildCursorMcpConfig(loc) } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return loc === 'local'
      ? [mcpJsonPath(loc), rulesPath()]
      : [mcpJsonPath(loc)];
  }
}

/**
 * 为给定位置的 Cursor 构建 synapse MCP 服务器配置。继承共享格式
 * ({type, command, args}) 并追加 `--path`，使派生的 MCP 服务器能正确
 * 解析工作区，而不受 Cursor 启动 cwd 影响。完整原因见文件头注释。
 */
function buildCursorMcpConfig(loc: Location): { type: string; command: string; args: string[] } {
  const base = getMcpServerConfig();
  const pathArg = loc === 'local' ? process.cwd() : '${workspaceFolder}';
  return { ...base, args: [...base.args, '--path', pathArg] };
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing.mcpServers?.synapse;
  const after = buildCursorMcpConfig(loc);

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before ? 'updated' : (fs.existsSync(file) ? 'updated' : 'created');
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers.synapse = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * 卸载时（以及作为安装时的自愈——见 issue #529）移除 Cursor rules 文件。
 *
 * 与共享的 CLAUDE.md / AGENTS.md 文件不同（synapse 在那里只拥有标记分隔的章节），
 * `.cursor/rules/synapse.mdc` 是我们完全创建的文件——frontmatter 也是我们的。
 * 因此单纯的 `removeMarkedSection` 在此是错误的：它会清除我们的 instructions 块，
 * 但留下孤立的 `description: Synapse ...` frontmatter，使文件残留并仍"提及" synapse。
 *
 * 替代方案：清除我们的块，若只剩我们自己的 frontmatter，则删除整个文件。
 * 只有当用户在我们的标记之外添加了自己的内容时，才保留文件（去掉我们的块）。
 */
function removeRulesEntry(): WriteResult['files'][number] {
  const file = rulesPath();
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };

  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return { path: file, action: 'not-found' };
  }

  const ourFrontmatter = MDC_FRONTMATTER.trim();
  const startIdx = content.indexOf(SYNAPSE_SECTION_START);
  const endIdx = content.indexOf(SYNAPSE_SECTION_END);

  // 我们的标记块存在——清除它，然后判断剩余内容。
  if (startIdx !== -1 && endIdx > startIdx) {
    const before = content.substring(0, startIdx).trimEnd();
    const after = content.substring(endIdx + SYNAPSE_SECTION_END.length).trimStart();
    const remainder = (before + (before && after ? '\n\n' : '') + after).trim();
    if (remainder === '' || remainder === ourFrontmatter) {
      try { fs.unlinkSync(file); } catch { /* 忽略 */ }
    } else {
      atomicWriteFileSync(file, remainder + '\n');
    }
    return { path: file, action: 'removed' };
  }

  // 无块，但文件仍是我们原始的仅含 frontmatter 的文件——
  // 这是我们的文件，移除它。
  if (content.trim() === ourFrontmatter) {
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
    return { path: file, action: 'removed' };
  }

  // 我们无法识别的外部内容——保持不变。
  return { path: file, action: 'not-found' };
}

export const cursorTarget: AgentTarget = new CursorTarget();
