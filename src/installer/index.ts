/**
 * Synapse 交互式安装器
 *
 * 多目标：为用户选择的智能体（Claude Code、Cursor、Codex CLI、opencode、
 * Hermes Agent、Gemini CLI、Antigravity IDE）写入 MCP 服务器配置 + instructions。
 * 在未明确选择 target 且未检测到其他智能体时，默认仅针对 Claude 以保持向后兼容。
 *
 * 使用 @clack/prompts 提供交互式 UI；`runInstallerWithOptions` 是
 * `--target` / `--print-config` CLI 标志使用的非交互式入口点。
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
  ALL_TARGETS,
  detectAll,
  getTarget,
  resolveTargetFlag,
} from './targets/registry';
import type { AgentTarget, Location, TargetId } from './targets/types';
import { getGlyphs } from '../ui/glyphs';
// Import the lightweight submodules directly (not the ../sync barrel, which
// re-exports FileWatcher and would transitively pull in ../extraction — the
// installer must stay importable even when native modules can't load).
import { watchDisabledReason } from '../sync/watch-policy';
import { isGitRepo, isSyncHookInstalled, installGitSyncHook } from '../sync/git-hooks';
import { getSynapseDir, synapseDirName, unsafeIndexRootReason } from '../directory';
import { getTelemetry, recordIndexEvent, TELEMETRY_DOCS } from '../telemetry';

// 向后兼容：保留这些具名导出——下游代码可能会导入它们。
// `config-writer.ts` 中的 shim 继续重新导出它们。
export {
  writeMcpConfig,
  writePermissions,
  hasMcpConfig,
  hasPermissions,
} from './config-writer';
export type { InstallLocation } from './config-writer';

// 动态导入辅助——tsc 在 CJS 模式下将 import() 编译为 require()，
// 这对仅 ESM 的包会失败。此处绕过该转换。
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importESM = new Function('specifier', 'return import(specifier)') as
  (specifier: string) => Promise<typeof import('@clack/prompts')>;

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function getVersion(): string {
  try {
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch {
    return '0.0.0';
  }
}

export interface RunInstallerOptions {
  /** 逗号分隔的 target 列表，或 `auto` / `all` / `none`。 */
  target?: string;
  /** 跳过位置提示，直接使用此值。 */
  location?: Location;
  /** 跳过自动允许提示，直接使用此值。 */
  autoAllow?: boolean;
  /**
   * 跳过所有确认并使用默认值：location=global，
   * autoAllow=true，target=auto。用于脚本 / CI。
   */
  yes?: boolean;
}

/**
 * 交互式入口点——保留历史 UX（无参数的 `synapse install` 经过提示流程），
 * 但现在多选提示会预先填充已检测到的智能体。
 */
export async function runInstaller(): Promise<void> {
  return runInstallerWithOptions({});
}

export async function runInstallerWithOptions(opts: RunInstallerOptions): Promise<void> {
  const clack = await importESM('@clack/prompts');

  clack.intro(`Synapse v${getVersion()}`);

  // --yes 隐含所有默认值；显式标志仍优先。
  const useDefaults = opts.yes === true;

  // 第一步：选择智能体 target？首先询问，让用户在触碰 npm 或磁盘之前
  // 知道自己将要进行哪些操作。检测会探测用户提供的位置（若已知），
  // 否则以 'global' 作为最常见的默认值——标签仅供参考，不作为实际依据。
  const detectionLocation: Location = opts.location ?? 'global';
  const targets = await resolveTargets(clack, opts, detectionLocation, useDefaults);
  if (targets.length === 0) {
    clack.outro('No agent targets selected — nothing to do.');
    return;
  }

  // 第二步：在 PATH 上安装 synapse npm 包（始终提供；与现有行为一致）。
  // --yes 时跳过（假设已存在）。
  if (!useDefaults) {
    const shouldInstallGlobally = await clack.confirm({
      message: 'Install the synapse CLI on your PATH? (Required so agents can launch the MCP server)',
      initialValue: true,
    });
    if (clack.isCancel(shouldInstallGlobally)) {
      clack.cancel('Installation cancelled.');
      process.exit(0);
    }
    if (shouldInstallGlobally) {
      const s = clack.spinner();
      s.start('Installing synapse CLI...');
      try {
        execSync('npm install -g @colbymchenry/synapse', { stdio: 'pipe', windowsHide: true });
        s.stop('Installed synapse CLI on PATH');
      } catch {
        s.stop('Could not install (permission denied)');
        clack.log.warn('Try: sudo npm install -g @colbymchenry/synapse');
      }
    } else {
      clack.log.info('Skipped CLI install — agents will not be able to launch the MCP server without it');
    }
  }

  // 第三步：各智能体配置文件的写入位置。
  let location: Location;
  if (opts.location) {
    location = opts.location;
  } else if (useDefaults) {
    location = 'global';
  } else {
    // 若所有选定 target 均仅支持全局（如 Codex），跳过提示并强制用户范围——
    // 项目本地会直接产生跳过警告。
    const allGlobalOnly = targets.every((t) => !t.supportsLocation('local'));
    if (allGlobalOnly) {
      location = 'global';
      clack.log.info('Writing user-wide configs (selected agents have no project-local config).');
    } else {
      const sel = await clack.select({
        message: 'Apply agent configs to all your projects, or just this one?',
        options: [
          { value: 'global' as const, label: 'All projects', hint: '~/.claude, ~/.cursor, etc.' },
          { value: 'local'  as const, label: 'Just this project', hint: './.claude, ./.cursor, etc.' },
        ],
        initialValue: 'global' as const,
      });
      if (clack.isCancel(sel)) {
        clack.cancel('Installation cancelled.');
        process.exit(0);
      }
      location = sel;
    }
  }

  // 第四步：自动允许权限（仅对 Claude 有意义；其他 target 静默跳过）。
  let autoAllow: boolean;
  if (opts.autoAllow !== undefined) {
    autoAllow = opts.autoAllow;
  } else if (useDefaults) {
    autoAllow = true;
  } else if (targets.some((t) => t.id === 'claude')) {
    const ans = await clack.confirm({
      message: 'Auto-allow Synapse commands? (Skips permission prompts in Claude Code)',
      initialValue: true,
    });
    if (clack.isCancel(ans)) {
      clack.cancel('Installation cancelled.');
      process.exit(0);
    }
    autoAllow = ans;
  } else {
    autoAllow = false;
  }

  // 第四步半：匿名使用遥测——一个可见的默认开启开关，仅询问一次。
  // 若环境变量（DO_NOT_TRACK / SYNAPSE_TELEMETRY）已做出决定，或之前
  // 的运行已存储了选择，则跳过——重复运行和升级不再重复询问。
  if (!useDefaults && getTelemetry().getStatus().decidedBy === 'default' && !getTelemetry().hasStoredChoice()) {
    const share = await clack.confirm({
      message: 'Share anonymous usage stats? (No code, paths, or names — see TELEMETRY.md)',
      initialValue: true,
    });
    if (clack.isCancel(share)) {
      // 不因遥测问题中止安装——保持未决状态
      // （记录的默认值 + 首次运行通知稍后适用）。
      clack.log.info('Skipped — manage anytime with `synapse telemetry on|off`.');
    } else {
      getTelemetry().setEnabled(share, 'installer');
      clack.log.info(
        share
          ? `Thanks! Exactly what is collected: ${TELEMETRY_DOCS}`
          : 'Telemetry disabled — nothing will be collected or sent.',
      );
    }
  }

  // 第五步：按 target 逐一安装循环。
  const installedIds: TargetId[] = [];
  let sawCreated = false;
  let sawUpdated = false;
  for (const target of targets) {
    if (!target.supportsLocation(location)) {
      clack.log.warn(
        `${target.displayName}: skipped — does not support --location=${location}.`,
      );
      continue;
    }
    const result = target.install(location, { autoAllow });
    installedIds.push(target.id);
    for (const file of result.files) {
      if (file.action === 'created') sawCreated = true;
      if (file.action === 'updated') sawUpdated = true;
      const verb = file.action === 'unchanged'
        ? 'Unchanged'
        : file.action === 'created' ? 'Created'
          : file.action === 'removed' ? 'Removed'
            : 'Updated';
      clack.log.success(`${target.displayName}: ${verb} ${tildify(file.path)}`);
    }
    for (const note of result.notes ?? []) {
      clack.log.info(`${target.displayName}: ${note}`);
    }
  }

  // 遥测：配置了哪些智能体、在哪里、是全新还是升级（从上面的文件操作推断）。
  // 仅包含 target ID 和位置枚举。
  if (installedIds.length > 0) {
    getTelemetry().recordLifecycle('install', {
      targets: installedIds,
      scope: location,
      kind: sawCreated ? 'fresh' : sawUpdated ? 'upgrade' : 'reinstall',
    });
  }

  // 第六步：本地安装时，初始化项目。
  if (location === 'local') {
    await initializeLocalProject(clack, useDefaults);
  }

  if (location === 'global') {
    clack.note('cd your-project\nsynapse init -i', 'Quick start');
  }

  // 趁我们仍在一个耗时的交互命令中，交付缓冲的遥测数据——
  // 有界（最坏情况约 1.5 秒），在多秒安装之后看不出来。
  await getTelemetry().flushNow();

  const finalNote = targets.length > 0
    ? `Done! Restart your agent${targets.length > 1 ? 's' : ''} to use Synapse.`
    : 'Done!';
  clack.outro(finalNote);
}

export interface RunUninstallerOptions {
  /**
   * 逗号分隔的 target 列表，或 `auto` / `all` / `none`。默认为
   * `all`——卸载会扫描每个已知智能体并报告实际触碰了哪些，
   * 无需用户记住配置位置。
   */
  target?: string;
  /** 跳过位置提示，直接使用此值。 */
  location?: Location;
  /** 非交互式：location=global，target=all，无提示。 */
  yes?: boolean;
}

export type UninstallStatus = 'removed' | 'not-configured' | 'unsupported';

/**
 * 按 target 输出的卸载扫描结果。`removed` 表示我们至少删除了一项；
 * `not-configured` 表示该智能体在此位置没有 synapse 配置（无需操作）；
 * `unsupported` 表示该智能体在此位置没有配置概念（例如 Codex 仅支持全局，
 * 因此本地卸载会跳过它）。
 */
export interface UninstallReport {
  id: TargetId;
  displayName: string;
  status: UninstallStatus;
  /** 我们实际编辑/删除的绝对路径（action === 'removed'）。 */
  removedPaths: string[];
  /** 来自 target 的逐字说明（卸载时少见）。 */
  notes: string[];
}

/**
 * 纯卸载扫描——无提示，无 I/O（除各 target 自身的文件编辑外）。
 * 与 `runUninstaller` 中的 clack UI 分离后单独暴露（并单元测试），
 * 使聚合逻辑可被直接断言。
 *
 * 每个 target 的 `uninstall()` 在从未安装时调用也是安全的（返回
 * `not-found` actions），因此可以无条件地对每个 target 运行。
 */
export function uninstallTargets(
  targets: readonly AgentTarget[],
  location: Location,
): UninstallReport[] {
  return targets.map((target) => {
    if (!target.supportsLocation(location)) {
      const only: Location = location === 'local' ? 'global' : 'local';
      return {
        id: target.id,
        displayName: target.displayName,
        status: 'unsupported' as const,
        removedPaths: [],
        notes: [`no ${location} config — this agent is ${only}-only`],
      };
    }
    const result = target.uninstall(location);
    const removedPaths = result.files
      .filter((f) => f.action === 'removed')
      .map((f) => f.path);
    return {
      id: target.id,
      displayName: target.displayName,
      status: removedPaths.length > 0 ? ('removed' as const) : ('not-configured' as const),
      removedPaths,
      notes: result.notes ?? [],
    };
  });
}

/**
 * 交互式卸载器——`runInstallerWithOptions` 的逆操作。
 * 首先询问全局 vs 本地（除非给出了 `--location`/`--yes`），然后扫描
 * 每个智能体 target（或 `--target` 子集）并为每个智能体打印一个块，
 * 让用户清楚地看到它触碰了哪些提供方。
 *
 * 仅删除 install 写入的内容（MCP 服务器条目、instructions 块、权限）——
 * 永不删除 `.synapse/` 索引，那属于 `synapse uninit` 管理。
 */
export async function runUninstaller(opts: RunUninstallerOptions): Promise<void> {
  const clack = await importESM('@clack/prompts');

  clack.intro(`Synapse v${getVersion()} — uninstall`);

  const useDefaults = opts.yes === true;

  // 第一步：选择位置——首先询问，这是用户必须做的唯一决定。
  // 全局扫描 ~/.claude、~/.codex 等；本地扫描此项目目录中的配置。
  let location: Location;
  if (opts.location) {
    location = opts.location;
  } else if (useDefaults) {
    location = 'global';
  } else {
    const sel = await clack.select({
      message: 'Remove Synapse from all your projects, or just this one?',
      options: [
        { value: 'global' as const, label: 'All projects (global)', hint: '~/.claude, ~/.cursor, ~/.codex, ~/.config/opencode, ~/.hermes, ~/.gemini, ~/.kiro' },
        { value: 'local'  as const, label: 'Just this project (local)', hint: './.claude, ./.cursor, ./opencode.jsonc, ./.gemini, ./.kiro' },
      ],
      initialValue: 'global' as const,
    });
    if (clack.isCancel(sel)) {
      clack.cancel('Uninstall cancelled.');
      process.exit(0);
    }
    location = sel;
  }

  // 第二步：选择智能体。默认为所有智能体，这样用户无需记住安装位置——
  // 未配置的智能体报告为"无需删除"并保持不变。显式的 --target 可缩小范围。
  let targets: AgentTarget[];
  if (opts.target !== undefined) {
    targets = resolveTargetFlag(opts.target, location);
  } else {
    targets = [...ALL_TARGETS];
  }
  if (targets.length === 0) {
    clack.outro('No agent targets selected — nothing to do.');
    return;
  }

  // 第三步：扫描 + 按智能体反馈。
  const reports = uninstallTargets(targets, location);
  const removed = reports.filter((r) => r.status === 'removed');

  for (const r of reports) {
    if (r.status === 'removed') {
      for (const p of r.removedPaths) {
        clack.log.success(`${r.displayName}: removed ${tildify(p)}`);
      }
    } else if (r.status === 'not-configured') {
      clack.log.info(`${r.displayName}: not configured — nothing to remove`);
    } else {
      clack.log.info(`${r.displayName}: skipped — ${r.notes[0] ?? 'unsupported location'}`);
    }
  }

  // 第四步：对于本地卸载，索引目录是独立的——指向 `uninit`，
  // 让用户知道它仍然存在（以及如何删除它）。
  if (location === 'local' && fs.existsSync(getSynapseDir(process.cwd()))) {
    clack.log.info(`The ${synapseDirName()}/ index for this project is still here. Run \`synapse uninit\` to delete it.`);
  }

  // 遥测流失信号（仅 agent ID）——立即刷新，因为卸载后通常没有
  // "下次运行"来交付数据。
  if (removed.length > 0) {
    getTelemetry().recordLifecycle('uninstall', { targets: removed.map((r) => r.id) });
    await getTelemetry().flushNow();
  }

  // 第五步：总结。
  if (removed.length > 0) {
    const names = removed.map((r) => r.displayName).join(', ');
    clack.outro(
      `Removed Synapse from ${removed.length} agent${removed.length > 1 ? 's' : ''}: ${names}. ` +
      `Restart ${removed.length > 1 ? 'them' : 'it'} to apply.`,
    );
  } else {
    clack.outro(`Synapse was not configured in any ${location} agent — nothing to remove.`);
  }
}

/**
 * 将路径中的 home 目录前缀替换为 `~/`，使日志行更简洁。纯装饰性操作。
 */
function tildify(p: string): string {
  const home = require('os').homedir();
  if (p.startsWith(home + path.sep)) return '~' + p.substring(home.length);
  return p;
}

async function resolveTargets(
  clack: typeof import('@clack/prompts'),
  opts: RunInstallerOptions,
  location: Location,
  useDefaults: boolean,
): Promise<AgentTarget[]> {
  // 显式的 --target 标志优先。
  if (opts.target !== undefined) {
    return resolveTargetFlag(opts.target, location);
  }

  // --yes 隐含自动检测。
  if (useDefaults) {
    return resolveTargetFlag('auto', location);
  }

  // 交互式多选。
  const detected = detectAll(location);
  const initialValues = detected
    .filter(({ detection }) => detection.installed)
    .map(({ target }) => target.id);
  // 若未检测到任何内容，默认仅选中 Claude（与历史默认值及最小意外结果一致）。
  const initial = initialValues.length > 0 ? initialValues : ['claude'];

  const choice = await clack.multiselect<string>({
    message: 'Which agents should Synapse configure?',
    options: ALL_TARGETS.map((t) => {
      const det = detected.find(({ target }) => target.id === t.id)!.detection;
      const flag = det.installed ? '(detected)' : '(not found)';
      const globalOnly = !t.supportsLocation('local') ? ' — global only' : '';
      return {
        value: t.id,
        label: `${t.displayName} ${flag}${globalOnly}`,
      };
    }),
    initialValues: initial,
    required: false,
  });

  if (clack.isCancel(choice)) {
    clack.cancel('Installation cancelled.');
    process.exit(0);
  }

  return choice
    .map((id) => getTarget(id))
    .filter((t): t is AgentTarget => t !== undefined);
}

/**
 * 在当前项目中初始化 Synapse（用于本地安装），然后在实时监视器
 * 无法在此运行时提供 watch 回退（见 offerWatchFallback）。本质上与智能体无关。
 */
async function initializeLocalProject(
  clack: typeof import('@clack/prompts'),
  useDefaults = false,
): Promise<void> {
  const projectPath = process.cwd();

  // 永不自动索引 home 目录或文件系统根目录。从 `$HOME` 运行安装器
  // 否则会索引整个 home 目录树——产生数 GB 的索引、持续的监视器抖动，
  // 以及（1.0 之前的 macOS 上）导致机器崩溃的文件描述符耗尽（#845）。
  // 安装本身仍会完成；我们只是跳过自动索引并将用户引导至真实项目。
  const unsafe = unsafeIndexRootReason(projectPath);
  if (unsafe) {
    clack.log.warn(`Skipping automatic indexing — ${projectPath} looks like ${unsafe}.`);
    clack.log.info('Indexing it would pull in caches, other projects, and your whole tree. Run "synapse init" inside a specific project instead.');
    return;
  }

  let Synapse: typeof import('../index').default;
  try {
    Synapse = (await import('../index')).default;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    clack.log.error(`Could not load native modules: ${msg}`);
    clack.log.info('Skipping project initialization. Run "synapse init -i" later.');
    return;
  }

  // 检查是否已初始化
  if (Synapse.isInitialized(projectPath)) {
    clack.log.info('Synapse already initialized in this project');
    await offerWatchFallback(clack, projectPath, { yes: useDefaults });
    return;
  }

  // 初始化
  const cg = await Synapse.init(projectPath);
  clack.log.success('Created .synapse/ directory');

  // 使用 shimmer 进度条为项目建立索引（worker 线程保证动画流畅）
  const { createShimmerProgress } = await import('../ui/shimmer-progress');
  process.stdout.write(`\x1b[2m${getGlyphs().rail}\x1b[0m\n`);
  const progress = createShimmerProgress();

  const result = await cg.indexAll({
    onProgress: progress.onProgress,
  });

  await progress.stop();

  if (result.filesErrored > 0) {
    clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} failed, ${formatNumber(result.nodesCreated)} symbols)`);
  } else {
    clack.log.success(`Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.nodesCreated)} symbols)`);
  }

  recordIndexEvent(cg, result); // buffered; the installer flushes at the end

  cg.close();

  await offerWatchFallback(clack, projectPath, { yes: useDefaults });
}

/**
 * 当该项目的实时文件监视器被禁用时（例如 WSL2 /mnt 驱动器，或设置了
 * SYNAPSE_NO_WATCH），索引会悄无声息地过期。此函数会向用户说明这一情况，
 * 并提议通过 git hooks（commit / pull / checkout）自动保持索引新鲜，
 * 以替代手动执行 `synapse sync`。
 *
 * 在监视器正常运行的环境中为空操作，因此在 init 之后无条件调用是安全的。
 */
export async function offerWatchFallback(
  clack: typeof import('@clack/prompts'),
  projectPath: string,
  opts: { yes?: boolean } = {},
): Promise<void> {
  const reason = watchDisabledReason(projectPath);
  if (!reason) return; // 监视器正常运行——无需任何配置。

  clack.log.warn(`Live file watching is disabled here — ${reason}.`);
  clack.log.info('Until you re-sync, the Synapse index stays frozen — it will not pick up edits on its own.');

  // 非 git 仓库 → commit hook 路径不适用；指引用户手动同步。
  if (!isGitRepo(projectPath)) {
    clack.log.info('Run `synapse sync` after changing files to refresh the index.');
    return;
  }

  // 之前运行时已配置好——确认并继续，不再重复提示。
  if (isSyncHookInstalled(projectPath)) {
    clack.log.info('Git sync hooks are already installed — the index refreshes after commit / pull / checkout.');
    return;
  }

  let choice: 'hook' | 'manual';
  if (opts.yes) {
    choice = 'hook';
  } else {
    const sel = await clack.select({
      message: 'How should Synapse keep its index fresh?',
      options: [
        { value: 'hook' as const, label: 'Sync on git commit / pull / checkout', hint: 'installs git hooks (recommended)' },
        { value: 'manual' as const, label: 'I\'ll run `synapse sync` myself', hint: 'fully manual' },
      ],
      initialValue: 'hook' as const,
    });
    if (clack.isCancel(sel)) {
      clack.log.info('Skipped — run `synapse sync` after changes to refresh the index.');
      return;
    }
    choice = sel;
  }

  if (choice === 'manual') {
    clack.log.info('Run `synapse sync` after changing files to refresh the index.');
    return;
  }

  const result = installGitSyncHook(projectPath);
  if (result.installed.length > 0) {
    clack.log.success(
      `Installed git ${result.installed.join(', ')} hook${result.installed.length > 1 ? 's' : ''} — ` +
      'the index refreshes in the background after each.',
    );
    clack.log.info('Run `synapse sync` anytime to refresh immediately.');
  } else {
    clack.log.warn(
      `Could not install git hooks${result.skipped ? ` (${result.skipped})` : ''}. ` +
      'Run `synapse sync` after changes instead.',
    );
  }
}
