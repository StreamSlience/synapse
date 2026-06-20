/**
 * OpenAI Codex CLI target。
 *
 *   - MCP 服务器条目写入 `~/.codex/config.toml`，使用点分键表格
 *     `[mcp_servers.synapse]`。格式为 TOML 而非 JSON，由
 *     `./toml.ts` 中的轻量序列化器处理。
 *   - Instructions 写入 `~/.codex/AGENTS.md`。
 *
 * 截至 2026-05 的 Codex CLI 没有项目本地配置概念——
 * 所有内容都存放在 `~/.codex/` 下。`supportsLocation('local')`
 * 返回 false；用户选择本地安装位置时，编排器会跳过 Codex。
 *
 * 无权限概念。
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
  removeMarkedSection,
  upsertInstructionsEntry,
} from './shared';
import {
  SYNAPSE_SECTION_END,
  SYNAPSE_SECTION_START,
} from '../instructions-template';
import { buildTomlTable, removeTomlTable, upsertTomlTable } from './toml';

const TOML_HEADER = 'mcp_servers.synapse';

function configDir(): string {
  return path.join(os.homedir(), '.codex');
}
function tomlConfigPath(): string {
  return path.join(configDir(), 'config.toml');
}
function instructionsPath(): string {
  return path.join(configDir(), 'AGENTS.md');
}

class CodexTarget implements AgentTarget {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly docsUrl = 'https://github.com/openai/codex';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const tomlPath = tomlConfigPath();
    let alreadyConfigured = false;
    if (fs.existsSync(tomlPath)) {
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        alreadyConfigured = content.includes(`[${TOML_HEADER}]`);
      } catch { /* 忽略 */ }
    }
    const installed = fs.existsSync(configDir());
    return { installed, alreadyConfigured, configPath: tomlPath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Codex CLI has no project-local config — re-run with --location=global to install.'],
      };
    }
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry());

    // AGENTS.md 写入简短的标记围栏式 Synapse 块（#704）：
    // 子智能体和非 MCP 运行环境会读取 AGENTS.md，但不接收 MCP
    // initialize 指令。Upsert 可自动修复过时的 #529 前块。
    files.push(upsertInstructionsEntry(instructionsPath()));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const files: WriteResult['files'] = [];

    const tomlPath = tomlConfigPath();
    if (fs.existsSync(tomlPath)) {
      const content = fs.readFileSync(tomlPath, 'utf-8');
      const { content: nextContent, action } = removeTomlTable(content, TOML_HEADER);
      if (action === 'removed') {
        if (nextContent.trim() === '') {
          try { fs.unlinkSync(tomlPath); } catch { /* 忽略 */ }
        } else {
          atomicWriteFileSync(tomlPath, nextContent.trimEnd() + '\n');
        }
        files.push({ path: tomlPath, action: 'removed' });
      } else {
        files.push({ path: tomlPath, action: 'not-found' });
      }
    } else {
      files.push({ path: tomlPath, action: 'not-found' });
    }

    files.push(removeInstructionsEntry());

    return { files };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Codex CLI has no project-local config — use --location=global.\n';
    }
    const block = buildSynapseBlock();
    return `# Add to ${tomlConfigPath()}\n\n${block}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc !== 'global') return [];
    return [tomlConfigPath(), instructionsPath()];
  }
}

function buildSynapseBlock(): string {
  const mcp = getMcpServerConfig();
  return buildTomlTable(TOML_HEADER, {
    command: mcp.command,
    args: mcp.args,
  });
}

function writeMcpEntry(): WriteResult['files'][number] {
  const file = tomlConfigPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const block = buildSynapseBlock();
  // 单次读取——`existing === ''` 同时推断出"文件为空或不存在"
  // 和"文件的原有内容"，避免了两次 `fs.existsSync` 调用之间的 TOCTOU 窗口。
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const created = existing.length === 0;
  const { content: nextContent, action } = upsertTomlTable(existing, TOML_HEADER, block);

  if (action === 'unchanged') {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, nextContent);
  return { path: file, action: created ? 'created' : 'updated' };
}

/**
 * 若之前的安装写入了标记分隔的 Synapse 块，则从 `~/.codex/AGENTS.md`
 * 中将其清除。install（升级时自愈）和 uninstall 均会使用——见 issue #529。
 */
function removeInstructionsEntry(): WriteResult['files'][number] {
  const file = instructionsPath();
  const action = removeMarkedSection(file, SYNAPSE_SECTION_START, SYNAPSE_SECTION_END);
  return { path: file, action };
}

export const codexTarget: AgentTarget = new CodexTarget();
