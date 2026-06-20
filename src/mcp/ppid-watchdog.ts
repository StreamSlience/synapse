/**
 * PPID 看门狗的共享决策逻辑（#277、#692）。
 *
 * 看门狗的职责：感知我们所依赖的进程 — 父进程，或通过中间启动器连接的 MCP 宿主 —
 * 已经死亡，从而让孤立的代理/直接服务器自行关闭，而不是永远泄漏。
 *
 * 父进程死亡在不同操作系统上的表现不同，这正是导致 Windows 上无限守护进程/代理泄漏的原因
 * （#692、#576）：
 *
 *   - **POSIX** 会将孤儿进程重新挂载到 init（pid 1），因此 `process.ppid` 在父进程
 *     死亡的瞬间*发生变化*。这个差异是经典的 #277 信号。
 *   - **Windows** 永远不会重新挂载：`process.ppid` 会一直报告原始（现已死亡的）父进程，
 *     因此变化检查永远无法触发。在 Windows 上我们必须改为轮询原始父进程的*活跃性*。
 *
 * 活跃性回退刻意仅限 Windows。在 POSIX 上，双重 fork 的祖父进程可以合理地比重新挂载
 * 更长寿，因此 `originalPpid` 已死并不能证明发生了孤立 — 变化检查是正确且充分的
 * POSIX 信号，同时使用活跃性检查会有误报关闭的风险。
 */
export interface SupervisionState {
  /** 启动时捕获的 `process.ppid`。 */
  originalPpid: number;
  /** 当前的 `process.ppid`。 */
  currentPpid: number;
  /**
   * 通过中间启动器透传的 MCP 宿主 pid（`SYNAPSE_HOST_PPID`），
   * 未知时为 null — 例如独立 bundle，它预置了 `--liftoff-only`，
   * 因此从不执行设置该值的重启逻辑。
   */
  hostPpid: number | null;
  /** 活跃性探测 — 生产中使用 `process.kill(pid, 0)`，测试中使用桩函数。 */
  isAlive: (pid: number) => boolean;
  /** 默认为 `process.platform`。 */
  platform?: NodeJS.Platform;
}

/**
 * 进程已失去监管者、应关闭时返回人类可读的原因字符串，仍在监管中时返回 null。
 */
export function supervisionLostReason(state: SupervisionState): string | null {
  const { originalPpid, currentPpid, hostPpid, isAlive } = state;
  const platform = state.platform ?? process.platform;

  // POSIX：父进程死亡会导致重新挂载，因此 ppid 发生变化。（Windows 上永不发生。）
  if (currentPpid !== originalPpid) {
    return `ppid ${originalPpid} -> ${currentPpid}`;
  }
  // Windows：ppid 在父进程死亡后保持不变，因此通过活跃性检测。
  // 跳过 pid 0/1 — "unknown" 和 init 从不是真实的 Windows 父进程，
  // 对它们进行虚假的活跃性探测不得触发关闭。
  if (platform === 'win32' && originalPpid > 1 && !isAlive(originalPpid)) {
    return `parent pid ${originalPpid} exited`;
  }
  // 任意平台：通过启动器 shim 透传的宿主 pid 已消失。
  if (hostPpid !== null && !isAlive(hostPpid)) {
    return `host pid ${hostPpid} exited`;
  }
  return null;
}
