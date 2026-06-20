/**
 * 同步模块
 *
 * 提供同步功能，用于使代码图与文件系统变更保持最新状态。
 *
 * 组件：
 * - FileWatcher：带防抖的 fs.watch，在文件变更时自动触发同步
 * - 监视策略：决定何时必须禁用监视器（如 WSL2 /mnt）
 * - Git 同步钩子：监视关闭时的可选提交/合并/checkout 钩子
 * - Git worktree 感知：检测查询是否借用了另一个工作树的索引
 * - 用于变更检测的内容哈希（在提取模块中）
 * - 增量重新索引（在提取模块中）
 */

export { FileWatcher, WatchOptions, PendingFile, LockUnavailableError } from './watcher';
export { watchDisabledReason, detectWsl } from './watch-policy';
export {
  installGitSyncHook,
  removeGitSyncHook,
  isSyncHookInstalled,
  isGitRepo,
  DEFAULT_SYNC_HOOKS,
  type GitHookName,
  type GitHookResult,
} from './git-hooks';
export {
  gitWorktreeRoot,
  detectWorktreeIndexMismatch,
  worktreeMismatchWarning,
  worktreeMismatchNotice,
  type WorktreeIndexMismatch,
} from './worktree';
