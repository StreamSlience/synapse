/**
 * Git Worktree 感知
 *
 * Synapse 索引存放在 `.synapse/` 目录中，通过向上遍历父目录找到最近的一个
 * （参见 `findNearestSynapseRoot`）。该遍历不感知 git worktree：当 worktree
 * 创建在主检出目录*内部*时（例如某些工具将其置于 `.gitignore` 的路径下，
 * 如 `.claude/worktrees/<name>/`），从 worktree 运行的命令会向上遍历并
 * 静默地解析到主检出的索引。
 *
 * 这样所有查询结果都来自主工作树的代码——通常是另一个分支——
 * 而非用户实际编辑的 worktree。仅在 worktree 中添加或修改的符号是不可见的。
 * 本模块用于检测这种"借用索引"的情况，以便调用方能发出警告。
 *
 * 检测是尽力而为的：当 git 不可用或路径不是仓库时，
 * 报告"无不匹配"并让调用方继续正常运行。
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * `dir` 所在 git 工作树的绝对符号链接已解析顶层路径，
 * 若 `dir` 不在 git 仓库内（或 git 不存在）则返回 null。
 *
 * `git rev-parse --show-toplevel` 返回每个 worktree 自己的根目录：
 * 主检出和每个链接的 worktree 各自报告独立的目录，
 * 这正是本模块所依赖的区分依据。
 */
export function gitWorktreeRoot(dir: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
    return out ? realpath(out) : null;
  } catch {
    return null;
  }
}

export interface WorktreeIndexMismatch {
  /** 命令运行所在的 git 工作树。 */
  worktreeRoot: string;
  /** 正在使用其 `.synapse` 索引的（另一个）工作树。 */
  indexRoot: string;
}

/**
 * 检测 `startPath` 所在的 git 工作树与已解析的 Synapse 索引（`indexRoot`）
 * 所属工作树不同的情况。
 *
 * 在以下情况返回 null（即"无需警告"）：
 *   - `startPath` 不在 git 仓库中（或 git 不可用），
 *   - 索引已在 `startPath` 自己的工作树中，或
 *   - `indexRoot` 本身不是工作树根目录（只是一个恰好包含 `.synapse/` 的
 *     无关父目录），以防止非 git 和 monorepo 子目录布局产生误报。
 */
export function detectWorktreeIndexMismatch(
  startPath: string,
  indexRoot: string,
): WorktreeIndexMismatch | null {
  const worktreeRoot = gitWorktreeRoot(startPath);
  if (!worktreeRoot) return null;

  const resolvedIndexRoot = realpath(indexRoot);
  if (worktreeRoot === resolvedIndexRoot) return null;

  // 仅在索引根目录本身是真实工作树根目录时才标记。这可以区分
  // "借用了另一个 worktree 的索引"与"索引位于普通祖先目录"两种情况，
  // 并避免在完全非 git 场景下发出警告。
  if (gitWorktreeRoot(resolvedIndexRoot) !== resolvedIndexRoot) return null;

  return { worktreeRoot, indexRoot: resolvedIndexRoot };
}

/** 逐条描述检测到的不匹配情况的单行警告。 */
export function worktreeMismatchWarning(m: WorktreeIndexMismatch): string {
  return (
    `This Synapse index belongs to a different git working tree.\n` +
    `  Running in: ${m.worktreeRoot}\n` +
    `  Index from: ${m.indexRoot}\n` +
    `Results reflect that tree's code (often a different branch), not this worktree — ` +
    `symbols changed only here are missing. Run "synapse init -i" in this worktree ` +
    `for a worktree-local index.`
  );
}

/**
 * 用于在工具结果前缀处追加的紧凑单行变体。读取工具的答案是内联返回的，
 * 因此提示必须附在智能体正在读取的同一载荷上——多行块会把结果淹没。
 */
export function worktreeMismatchNotice(m: WorktreeIndexMismatch): string {
  return (
    `⚠ Synapse results below come from a different git worktree (${m.indexRoot}), ` +
    `not where you're working (${m.worktreeRoot}) — they may reflect another branch, ` +
    `and symbols changed only here are missing. Run "synapse init -i" here for a ` +
    `worktree-local index.`
  );
}

/** 尽可能解析符号链接，以避免 tmp/realpath 的差异导致路径相等性判断失败。 */
function realpath(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}
