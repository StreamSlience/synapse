/**
 * opencode target。
 *
 *   - MCP 服务器条目写入 `~/.config/opencode/opencode.jsonc`（全局，
 *     所有平台包括 Windows 均采用 XDG 风格——见下文）或
 *     `./opencode.jsonc`（本地）。若已存在 `.json` 文件则回退到
 *     `opencode.json`；全新安装默认使用 `.jsonc`，因为 opencode 自身
 *     在首次运行时也会创建 `.jsonc`。
 *
 *     opencode 使用 `xdg-basedir` 包解析其配置目录
 *     （sst/opencode `packages/core/src/global.ts`）：若设置了
 *     `XDG_CONFIG_HOME` 则使用该值，否则使用 `~/.config`——在所有平台上
 *     无条件如此。它从不读取 `%APPDATA%`；那个布局属于已停止维护的 Go 分支。
 *     我们之前在 Windows 上写入该位置，导致 opencode 从未看到该条目（#535）——
 *     现在 install/uninstall 同时会清除遗留 `%APPDATA%/opencode` 位置中过时的
 *     synapse 条目。
 *   - Instructions 写入 `~/.config/opencode/AGENTS.md`（全局）或
 *     `./AGENTS.md`（本地）。opencode 读取 AGENTS.md 获取智能体指令——
 *     与 Codex CLI 使用相同约定。
 *   - 无权限概念。
 *
 * 配置格式使用 opencode 的包装器：
 *   {
 *     "$schema": "https://opencode.ai/config.json",
 *     "mcp": { "synapse": { "type": "local", "command": [...], "enabled": true } }
 *   }
 *
 * 格式与 Claude/Cursor 不同——opencode 使用 `mcp.<name>`（而非 `mcpServers`），
 * 将 `command` 作为合并了二进制名和参数的字符串数组，并包含显式的 `enabled` 标志。
 *
 * 读写均通过 `jsonc-parser` 进行，这样用户在 `.jsonc` 中添加的 `//` 和
 * `/* *\/` 注释可在幂等重复运行中得以保留。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseJsonc, modify, applyEdits } from 'jsonc-parser';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import {
  atomicWriteFileSync,
  jsonDeepEqual,
  removeMarkedSection,
  upsertInstructionsEntry,
} from './shared';
import {
  SYNAPSE_SECTION_END,
  SYNAPSE_SECTION_START,
} from '../instructions-template';

function globalConfigDir(): string {
  // XDG_CONFIG_HOME 若已设置则使用，否则使用 ~/.config——在所有平台上，
  // 与 opencode 自身的 `xdg-basedir` 解析一致（无 Windows 特殊处理；#535）。
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdg, 'opencode');
}

/**
 * #535 之前的安装将全局条目写入 `%APPDATA%/opencode`——一个当今 opencode
 * 从不读取的目录。当该目录可能存有过时状态时（APPDATA 已设置且解析位置
 * 不同于真实配置目录），返回该遗留目录。以环境变量而非 `process.platform`
 * 为条件，使清理逻辑可在跨平台测试套件下运行；在 POSIX 上，实际环境中
 * APPDATA 未设置，因此此处为空操作。
 */
function legacyWindowsConfigDir(): string | null {
  const appData = process.env.APPDATA;
  if (!appData || !appData.trim()) return null;
  const legacy = path.join(appData, 'opencode');
  return path.resolve(legacy) === path.resolve(globalConfigDir()) ? null : legacy;
}

function configBaseDir(loc: Location): string {
  return loc === 'global' ? globalConfigDir() : process.cwd();
}

// 优先使用已存在的 .jsonc，其次 .json，新文件默认为 .jsonc。
// opencode 首次运行时自动创建 .jsonc，因此这是现实中最常见的情况，
// 也是全新安装的合理默认值。
function configPath(loc: Location): string {
  const dir = configBaseDir(loc);
  const jsonc = path.join(dir, 'opencode.jsonc');
  const json = path.join(dir, 'opencode.json');
  if (fs.existsSync(jsonc)) return jsonc;
  if (fs.existsSync(json)) return json;
  return jsonc;
}

function instructionsPath(loc: Location): string {
  return path.join(configBaseDir(loc), 'AGENTS.md');
}

function readConfigText(file: string): string {
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf-8');
}

function parseConfig(text: string): Record<string, any> {
  if (!text.trim()) return {};
  const errors: any[] = [];
  const result = parseJsonc(text, errors, { allowTrailingComma: true });
  if (result == null || typeof result !== 'object' || Array.isArray(result)) {
    return {};
  }
  return result as Record<string, any>;
}

function getOpencodeServerEntry(): { type: string; command: string[]; enabled: boolean } {
  return {
    type: 'local',
    command: ['synapse', 'serve', '--mcp'],
    enabled: true,
  };
}

const FORMATTING = { tabSize: 2, insertSpaces: true, eol: '\n' };

class OpencodeTarget implements AgentTarget {
  readonly id = 'opencode' as const;
  readonly displayName = 'opencode';
  readonly docsUrl = 'https://opencode.ai/docs/config';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = configPath(loc);
    const config = parseConfig(readConfigText(file));
    const alreadyConfigured = !!config.mcp?.synapse;
    // 全局：XDG 目录是当前 opencode 首次运行时创建的目录；
    // 遗留的 %APPDATA% 目录仍算作"opencode 已存在"，
    // 这样重新安装时可以将过时的 #535 前条目从中清除。
    const legacy = legacyWindowsConfigDir();
    const installed = loc === 'global'
      ? fs.existsSync(globalConfigDir()) || (!!legacy && fs.existsSync(legacy))
      : fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));

    // AGENTS.md 写入简短的标记围栏式 Synapse 块（#704）：
    // 子智能体和非 MCP 运行环境会读取 AGENTS.md，但不接收 MCP
    // initialize 指令。Upsert 可自动修复过时的 #529 前块。
    files.push(upsertInstructionsEntry(instructionsPath(loc)));

    // 自愈 #535 之前写入 %APPDATA%/opencode 的安装——
    // opencode 从不读取该位置，因此其中我们的任何内容均已过时。
    if (loc === 'global') files.push(...cleanupLegacyWindowsState());

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(removeMcpEntryAt(configPath(loc)));
    files.push(removeInstructionsEntry(loc));
    if (loc === 'global') files.push(...cleanupLegacyWindowsState());
    return { files };
  }

  printConfig(loc: Location): string {
    const target = configPath(loc);
    const snippet = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      mcp: { synapse: getOpencodeServerEntry() },
    }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = configPath(loc);
  const existed = fs.existsSync(file);
  let text = readConfigText(file);

  // 当文件全新时，植入一个最小化的 opencode 配置，
  // 使结果成为完整的、带 schema 标签的文件（而非仅 `{ "mcp": {...} }`）。
  if (!text.trim()) {
    text = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  }

  const config = parseConfig(text);
  const before = config.mcp?.synapse;
  const after = getOpencodeServerEntry();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  // 若用户现有文件缺少 $schema，则补充添加。
  if (!config.$schema) {
    const schemaEdits = modify(text, ['$schema'], 'https://opencode.ai/config.json', {
      formattingOptions: FORMATTING,
    });
    text = applyEdits(text, schemaEdits);
  }

  // 精确编辑——保留注释、格式以及所有未触及键的顺序。
  const edits = modify(text, ['mcp', 'synapse'], after, {
    formattingOptions: FORMATTING,
  });
  const updated = applyEdits(text, edits);
  atomicWriteFileSync(file, updated);

  return { path: file, action: existed ? 'updated' : 'created' };
}

/**
 * 精确删除一个配置文件中的 `mcp.synapse`。保留同级服务器、注释和格式不变；
 * 若 `mcp` 包装器被清空也一并删除。由 uninstall 和遗留 %APPDATA% 清理共用。
 */
function removeMcpEntryAt(file: string): WriteResult['files'][number] {
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const text = readConfigText(file);
  const config = parseConfig(text);
  if (!config.mcp?.synapse) return { path: file, action: 'not-found' };

  let edits = modify(text, ['mcp', 'synapse'], undefined, {
    formattingOptions: FORMATTING,
  });
  let updated = applyEdits(text, edits);

  // 若 `mcp` 现在是空对象，也删除包装器。
  const afterParsed = parseConfig(updated);
  if (afterParsed.mcp && typeof afterParsed.mcp === 'object' &&
      Object.keys(afterParsed.mcp).length === 0) {
    edits = modify(updated, ['mcp'], undefined, { formattingOptions: FORMATTING });
    updated = applyEdits(updated, edits);
  }

  atomicWriteFileSync(file, updated);
  return { path: file, action: 'removed' };
}

/**
 * 删除 #535 之前的安装在 `%APPDATA%/opencode` 中遗留的内容——一条 opencode
 * 从不读取的 MCP 条目，以及我们标记围栏的 AGENTS.md 块。仅返回实际变更的
 * 文件，使安装输出在无需修复时保持静默。不触碰遗留目录中的任何其他内容：
 * 用户可能在 %APPDATA% 下确实保存了其他工具的状态。
 */
function cleanupLegacyWindowsState(): WriteResult['files'] {
  const dir = legacyWindowsConfigDir();
  if (!dir || !fs.existsSync(dir)) return [];
  const out: WriteResult['files'] = [];
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const res = removeMcpEntryAt(path.join(dir, name));
    if (res.action === 'removed') out.push(res);
  }
  const agents = path.join(dir, 'AGENTS.md');
  const action = removeMarkedSection(agents, SYNAPSE_SECTION_START, SYNAPSE_SECTION_END);
  if (action === 'removed') out.push({ path: agents, action });
  return out;
}

/**
 * 若之前的安装写入了标记分隔的 Synapse 块，则从 AGENTS.md 中将其清除。
 * install（升级时自愈）和 uninstall 均会使用——见 issue #529。
 */
function removeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const action = removeMarkedSection(file, SYNAPSE_SECTION_START, SYNAPSE_SECTION_END);
  return { path: file, action };
}

export const opencodeTarget: AgentTarget = new OpencodeTarget();
