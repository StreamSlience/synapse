/**
 * Git 同步钩子
 *
 * 当实时文件监视器被禁用时（例如在 WSL2 `/mnt/*` 驱动器上，
 * 参见 watch-policy.ts），Synapse 索引会在用户手动运行 `synapse sync`
 * 之前一直处于过期状态。作为可选替代方案，我们可以安装 git 钩子，
 * 在会修改磁盘文件的操作（commit、merge（含 `git pull`）、checkout）
 * 后自动刷新索引。
 *
 * 钩子在后台运行 `synapse sync`，因此绝不会阻塞 git，
 * 并通过 `command -v synapse` 守卫，在 CLI 不在 PATH 中时静默退出。
 * 我们的代码片段由标记注释界定，因此安装是幂等的，
 * 卸载时会保留用户自己编写的钩子内容。
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const MARKER_BEGIN = '# >>> synapse sync hook >>>';
const MARKER_END = '# <<< synapse sync hook <<<';

export type GitHookName = 'post-commit' | 'post-merge' | 'post-checkout';

/** 默认安装的钩子：commit、merge（git pull）和 checkout。 */
export const DEFAULT_SYNC_HOOKS: GitHookName[] = ['post-commit', 'post-merge', 'post-checkout'];

export interface GitHookResult {
  /** 已创建或更新的钩子名称。 */
  installed: GitHookName[];
  /** 已解析的钩子目录，若非 git 仓库则为 null。 */
  hooksDir: string | null;
  /** 未执行任何操作的原因（如不是 git 仓库）。 */
  skipped?: string;
}

/**
 * 检查 `projectRoot` 是否在 git 工作树内。若 git 未安装或路径不是仓库则返回 false。
 */
export function isGitRepo(projectRoot: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return out === 'true';
  } catch {
    return false;
  }
}

/**
 * 解析项目的 git 钩子目录，遵循 `core.hooksPath` 配置和 git worktree。
 * 返回绝对路径，若非 git 仓库则返回 null。
 */
function gitHooksDir(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    if (!out) return null;
    return path.isAbsolute(out) ? out : path.resolve(projectRoot, out);
  } catch {
    return null;
  }
}

/** 注入每个钩子的 shell 代码片段（位于标记之间）。 */
function markerBlock(): string {
  return [
    MARKER_BEGIN,
    '# 在实时文件监视器关闭时（如 WSL2 /mnt 驱动器）保持 Synapse 索引新鲜。',
    '# 在后台运行，因此永不阻塞 git。',
    '# 由 synapse 管理；通过 `synapse uninit` 卸载或手动删除此块。',
    'if command -v synapse >/dev/null 2>&1; then',
    '  ( synapse sync >/dev/null 2>&1 & ) >/dev/null 2>&1',
    'fi',
    MARKER_END,
  ].join('\n');
}

/** 从钩子内容中移除我们的标记块（含标记行本身）。 */
function stripMarkerBlock(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === MARKER_BEGIN) { inBlock = true; continue; }
    if (trimmed === MARKER_END) { inBlock = false; continue; }
    if (!inBlock) kept.push(line);
  }
  return kept.join('\n');
}

/** 判断钩子内容是否仅含 shebang/空行（即只有我们写入的内容）。 */
function isEffectivelyEmpty(content: string): boolean {
  return content
    .split('\n')
    .map((l) => l.trim())
    .every((l) => l.length === 0 || l.startsWith('#!'));
}

function chmodExecutable(file: string): void {
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    /* chmod 在某些平台（如 Windows）上是空操作或不受支持 */
  }
}

/**
 * 在 git 仓库中安装（或更新）Synapse 同步钩子。
 * 幂等：重新运行时替换我们的标记块而非重复写入，
 * 用户自己编写的钩子内容会被保留。
 */
export function installGitSyncHook(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): GitHookResult {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) {
    return { installed: [], hooksDir: null, skipped: 'not a git repository' };
  }

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch {
    return { installed: [], hooksDir, skipped: 'could not access the git hooks directory' };
  }

  const block = markerBlock();
  const installed: GitHookName[] = [];

  for (const hook of hooks) {
    const file = path.join(hooksDir, hook);
    let content: string;

    if (fs.existsSync(file)) {
      // 移除之前的块，然后重新追加当前版本。
      const base = stripMarkerBlock(fs.readFileSync(file, 'utf8')).replace(/\s*$/, '');
      content = base.length > 0
        ? `${base}\n\n${block}\n`
        : `#!/bin/sh\n${block}\n`;
    } else {
      content = `#!/bin/sh\n${block}\n`;
    }

    fs.writeFileSync(file, content);
    chmodExecutable(file);
    installed.push(hook);
  }

  return { installed, hooksDir };
}

/**
 * 移除 Synapse 同步钩子。仅删除我们的标记块；
 * 若钩子文件中仅剩 shebang 则整个文件删除，
 * 否则保留用户内容不变并重写文件。
 */
export function removeGitSyncHook(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): GitHookResult {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) {
    return { installed: [], hooksDir: null, skipped: 'not a git repository' };
  }

  const removed: GitHookName[] = [];

  for (const hook of hooks) {
    const file = path.join(hooksDir, hook);
    if (!fs.existsSync(file)) continue;

    const original = fs.readFileSync(file, 'utf8');
    if (!original.includes(MARKER_BEGIN)) continue;

    const stripped = stripMarkerBlock(original);
    if (isEffectivelyEmpty(stripped)) {
      fs.unlinkSync(file);
    } else {
      fs.writeFileSync(file, `${stripped.replace(/\s*$/, '')}\n`);
      chmodExecutable(file);
    }
    removed.push(hook);
  }

  return { installed: removed, hooksDir };
}

/** 检查是否已安装任意一个 Synapse 同步钩子。 */
export function isSyncHookInstalled(
  projectRoot: string,
  hooks: GitHookName[] = DEFAULT_SYNC_HOOKS,
): boolean {
  const hooksDir = gitHooksDir(projectRoot);
  if (!hooksDir) return false;
  return hooks.some((hook) => {
    const file = path.join(hooksDir, hook);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARKER_BEGIN);
  });
}
