/**
 * Synapse MCP 服务器
 *
 * 将 Synapse 功能作为工具暴露给 Claude 等 AI 助手的
 * Model Context Protocol 服务器。
 *
 * @module mcp
 *
 * @example
 * ```typescript
 * import { MCPServer } from 'synapse';
 *
 * const server = new MCPServer('/path/to/project');
 * await server.start();
 * ```
 *
 * 运行时模式（在 {@link MCPServer.start} 中决定）：
 *
 * - **直接模式** — 单进程通过 stdio 服务一个 MCP 客户端。#411 之前的行为；
 *   用于用户选择退出（`SYNAPSE_NO_DAEMON=1`）、无法访问 `.synapse/`
 *   或守护进程机制因任何原因失败时。
 * - **代理模式** — MCP 宿主在启用共享时实际通信的对象：一个薄薄的
 *   stdio↔socket 管道，连接到共享守护进程。代理携带 #277 PPID 看门狗，
 *   因此被 SIGKILL 的宿主会及时回收其代理。参见 {@link ./proxy.ts}。
 * - **守护进程模式** — 一个*分离的*后台进程（独立的 session/进程组），
 *   通过 Unix 域 socket / 命名管道服务 N 个代理，共享一个
 *   Synapse + 监视器 + SQLite 句柄。按需派生；从不是任何宿主的子进程，
 *   因此能在各个会话之间存活，并通过客户端引用计数 + 空闲超时回收。
 *   参见 {@link ./daemon.ts} 和 issue #411。
 *
 * 分离守护进程 + 始终代理的拆分是对审查发现的修复：原始进程内守护进程
 * (a) 是第一个宿主的子进程，因此关闭该终端会断开所有其他客户端；
 * (b) 禁用了 PPID 看门狗，导致 #277 回归（宿主 SIGKILL 时守护进程变为孤儿）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, StdioOptions } from 'child_process';
import { findNearestSynapseRoot, getSynapseDir } from '../directory';
import { StdioTransport } from './transport';
import { MCPEngine } from './engine';
import { MCPSession } from './session';
import {
  Daemon,
  clearStaleDaemonLock,
  isProcessAlive,
  tryAcquireDaemonLock,
} from './daemon';
import { connectWithHello, runLocalHandshakeProxy } from './proxy';
import { getDaemonSocketPath } from './daemon-paths';
import { getTelemetry } from '../telemetry';
import { supervisionLostReason } from './ppid-watchdog';
import { installMainThreadWatchdog, WatchdogHandle } from './liveness-watchdog';
import { treatStdinFailureAsShutdown } from './stdin-teardown';
import { HOST_PPID_ENV } from '../extraction/wasm-runtime-flags';

/**
 * 轮询 `process.ppid` 以检测父进程死亡的频率（见 #277）。
 * 5s 是经过权衡的选择：所防范的故障模式很少见（父进程被 SIGKILL），
 * 较长的轮询间隔意味着空闲时更少的唤醒开销。
 */
const DEFAULT_PPID_POLL_MS = 5000;

/**
 * 将此进程标记为*分离守护进程*本身的环境变量（由
 * {@link spawnDetachedDaemon} 在重新调用 CLI 时设置）。
 * 没有它，`serve --mcp` 调用是一个连接-或-派生的启动器；
 * 有了它，该进程就*是*守护进程，绝不能尝试再派生另一个（无限派生）。
 */
const DAEMON_INTERNAL_ENV = 'SYNAPSE_DAEMON_INTERNAL';

/**
 * 分离守护进程仲裁 O_EXCL 锁对抗竞争兄弟进程的重试次数。
 * 很少 — 实践中锁在第一轮就能解决；重试只用于清除真正过期（pid 已死）的锁文件。
 */
const TAKEOVER_MAX_RETRIES = 5;
const TAKEOVER_RETRY_DELAY_MS = 100;

/**
 * 启动器等待新派生的守护进程绑定其 socket 的时长，超时后放弃并在进程内运行。
 * 守护进程在（后台化的）引擎/语法预热*之前*绑定 socket，因此这里只需覆盖
 * Node 进程启动时间。60 × 100ms = 6s 的余量用于冷启动/慢速机器；
 * 通常情况下 socket 在几轮内就会出现。
 */
// 细粒度轮询（25ms）使代理在新派生的守护进程绑定的瞬间就能连接，
// 而不是等待粗粒度的 100ms — 缩短了冷启动握手时间（无头智能体竞争的窗口）。
// 相同的约 6s 放弃预算（240 × 25ms），只是粒度更细；socket 连接探测代价很低。
// 配合将 Synapse 加载从绑定路径推迟（engine.ts），这缩短了"No such tool available"的竞争窗口。
const DAEMON_CONNECT_MAX_RETRIES = 240;
const DAEMON_CONNECT_RETRY_DELAY_MS = 25;

/**
 * 从环境变量覆盖中解析 PPID 看门狗轮询间隔。值为 `0` 时完全禁用看门狗
 * （用于父进程有意重新挂载服务器的嵌入式场景的逃生舱口）。
 * 任何非数字或负值都回退到默认值。
 */
function parsePpidPollMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PPID_POLL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_PPID_POLL_MS;
  if (parsed < 0) return DEFAULT_PPID_POLL_MS;
  return Math.floor(parsed);
}

/**
 * 解析通过 `--liftoff-only` 重执行传播的宿主 PID
 * （{@link HOST_PPID_ENV}）。返回正整数 PID，或在未设置/无效时返回 null —
 * 直接启动路径，看门狗回退到 `process.ppid` 差异检测。
 * 0/1 的 PID 被拒绝（0 = 未知，1 = init，即已经是孤儿），
 * 以防看门狗锁定到 init。
 */
function parseHostPpid(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 1) return null;
  return parsed;
}

/** `SYNAPSE_NO_DAEMON` 是否设置为真值。 */
function daemonOptOutSet(): boolean {
  const raw = process.env.SYNAPSE_NO_DAEMON;
  if (!raw) return false;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

/** 此进程是否被派生为分离守护进程。 */
function daemonInternalSet(): boolean {
  const raw = process.env[DAEMON_INTERNAL_ENV];
  return !!raw && raw !== '0' && raw.toLowerCase() !== 'false';
}

/**
 * 解析守护进程机制应以其为键的项目根目录。当从候选路径无法访问 `.synapse/` 时返回
 * `null` — 在这种情况下调用方必须以直接模式运行，因为守护进程的锁文件和
 * socket 都存放在 `.synapse/` 下。
 *
 * 结果通过 `realpathSync` 规范化，使每个客户端收敛到相同的 socket/锁路径，
 * 无论它如何表达路径：通过符号链接下的 cwd 启动的客户端（例如 macOS `/var` → `/private/var`，
 * 派生的 `process.cwd()` 已经是 realpath）和传递了符号链接 `rootUri` 的客户端
 * 否则会哈希到不同的 socket，并悄悄地无法共享守护进程。
 */
function resolveDaemonRoot(explicitPath: string | null): string | null {
  const candidate = explicitPath ?? process.cwd();
  const root = findNearestSynapseRoot(candidate);
  if (!root) return null;
  try { return fs.realpathSync(root); } catch { return root; }
}

/**
 * 将共享守护进程作为完全分离的后台进程派生：独立的 session/进程组
 * （使得启动器终端的 SIGHUP/SIGINT 无法到达它），stdio 与启动器解耦
 * （日志写入 `.synapse/daemon.log`）。通过复用 `process.argv[0]`（正确的 node）、
 * 当前的 `process.execArgv`（携带 `--liftoff-only`，使守护进程永不重执行）
 * 和 `process.argv[1]`（此脚本），在开发模式和 bundle 启动之间忠实地重新调用
 * *相同的* CLI。派生的进程自行仲裁 O_EXCL 锁，因此竞争的启动器可能各自派生一个 —
 * 失败者退出，每个启动器都通过单一胜者进行代理。
 */
function spawnDetachedDaemon(root: string): void {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    // 没有可解析的 CLI 入口点可重新调用 — 让调用方回退到
    // 直接模式而不是派生一个损坏的进程。
    throw new Error('cannot resolve CLI script path to spawn the daemon');
  }

  let logFd: number | null = null;
  let stdio: StdioOptions = 'ignore';
  try {
    logFd = fs.openSync(path.join(getSynapseDir(root), 'daemon.log'), 'a');
    stdio = ['ignore', logFd, logFd];
  } catch {
    stdio = 'ignore'; // 无日志文件 — 丢弃守护进程输出而不是失败
  }
  try {
    const child = spawn(
      process.execPath,
      [...process.execArgv, scriptPath, 'serve', '--mcp', '--path', root],
      {
        detached: true,
        stdio,
        windowsHide: true,
        env: { ...process.env, [DAEMON_INTERNAL_ENV]: '1' },
      },
    );
    child.unref();
  } finally {
    // 子进程现在持有日志 fd 的自己的 dup；启动器不再需要它。
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch { /* ignore */ }
    }
  }
}

/**
 * Synapse MCP 服务器
 *
 * 实现 Model Context Protocol，将 Synapse 功能作为工具暴露，
 * 供 AI 助手调用。
 *
 * 与 #411 之前实现向后兼容的构造函数和 `start()` 签名：
 * 调用方继续使用 `new MCPServer(path).start()`。内部现在在启动时
 * 从直接/代理/守护进程模式中选择。
 */
export class MCPServer {
  private projectPath: string | null;
  // 直接模式/代理模式/守护进程模式的私有状态。在守护进程模式下，每个连接的会话
  // 存放在 Daemon 类中；在代理模式下根本没有会话。
  private session: MCPSession | null = null;
  private engine: MCPEngine | null = null;
  private daemon: Daemon | null = null;
  private ppidWatchdog: ReturnType<typeof setInterval> | null = null;
  // Worker 线程活跃性看门狗（#850）。仅限长期运行模式；若主线程卡在
  // 非让步的同步循环中则 SIGKILL 进程。
  private livenessWatchdog: WatchdogHandle | null = null;
  // PPID 看门狗基线 — 在构造时捕获，使我们始终有基线，
  // 即使 start() 在 fork 式重新挂载之后运行。
  private originalPpid: number = process.ppid;
  private hostPpid: number | null = parseHostPpid(process.env[HOST_PPID_ENV]);
  // stop() 的幂等性保护。
  private stopped = false;
  private mode: 'unstarted' | 'direct' | 'proxy' | 'daemon' = 'unstarted';

  constructor(projectPath?: string) {
    this.projectPath = projectPath || null;
  }

  /**
   * Start the MCP server.
   *
   * Decision order:
   *   1. `SYNAPSE_NO_DAEMON=1` → direct mode (unchanged pre-#411 behavior).
   *   2. `SYNAPSE_DAEMON_INTERNAL=1` → we ARE the detached daemon; listen.
   *   3. No `.synapse/` reachable → direct mode (the daemon's lockfile and
   *      socket both live under `.synapse/`).
   *   4. Otherwise connect to (or spawn) the shared daemon and proxy to it.
   *
   * On any unexpected failure in step 4 we transparently fall back to direct
   * mode — a misbehaving daemon must never block a session from starting.
   */
  async start(): Promise<void> {
  // 直接模式/代理模式/守护进程模式均为长期运行进程：机会性地刷新缓冲的遥测数据。
  // fire-and-forget + unref — 不增加握手路径的延迟，也不让进程保持存活。
    getTelemetry().startInterval();

    // 分离守护进程进程本身。在选择退出之前检查，
    // 使守护进程遵循与其派生时相同的环境（它从不设置 NO_DAEMON）。
    if (daemonInternalSet()) {
      return this.startDaemonProcess();
    }

    // 用户选择退出时为直接模式。设置环境变量足以
    // 获得 #411 之前的单进程行为。
    if (daemonOptOutSet()) {
      return this.startDirect('SYNAPSE_NO_DAEMON set');
    }

    const root = resolveDaemonRoot(this.projectPath);
    if (!root) {
      // 未找到已初始化的项目 — 守护进程模式没有地方放置其 socket。
      // 这是全新检出/项目外的情况；与之前行为一致。
      return this.startDirect('no .synapse/ root found');
    }

    try {
      // 在本地响应 MCP 握手（即时工具注册 — 无需等待约 600ms 的守护进程派生+绑定，
      // 正是这个等待产生了冷启动竞争），并将工具调用转发到共享守护进程，
      // 共享守护进程在后台连接。运行直到宿主断开连接；若守护进程始终未启动，
      // 代理回退到进程内引擎，因此永远不会卡住会话。
      this.mode = 'proxy';
      await this.runProxyWithLocalHandshake(root);
      return;
    } catch (err) {
      // 双重保险：代理设置期间（客户端被服务之前）的抛出
      // 仍然可以通过直接模式会话安全地恢复。
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[Synapse MCP] Proxy path failed (${msg}); falling back to direct mode.\n`);
      return this.startDirect('proxy path threw');
    }
  }

  /**
   * 停止服务器。在守护进程模式下触发每个已连接会话的优雅关闭；
   * 在直接模式下镜像 #411 之前的行为（关闭 cg，退出）。
   * 代理模式永远不会经过这里 — 代理自行退出。
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ppidWatchdog) {
      clearInterval(this.ppidWatchdog);
      this.ppidWatchdog = null;
    }
    if (this.livenessWatchdog) {
      this.livenessWatchdog.stop();
      this.livenessWatchdog = null;
    }
    if (this.daemon) {
      void this.daemon.stop('stop()');
      // Daemon.stop 调用 process.exit；无需做其他事情。
      return;
    }
    if (this.session) {
      this.session.stop();
      this.session = null;
    }
    if (this.engine) {
      this.engine.stop();
      this.engine = null;
    }
    process.exit(0);
  }

  /** 单进程 stdio MCP 会话 — #411 之前的代码路径。 */
  private async startDirect(reason: string): Promise<void> {
    if (reason && process.env.SYNAPSE_MCP_DEBUG) {
      process.stderr.write(`[Synapse MCP] Direct mode: ${reason}.\n`);
    }
    this.engine = new MCPEngine();
    const transport = new StdioTransport();
    this.session = new MCPSession(transport, this.engine, {
      explicitProjectPath: this.projectPath,
    });

    if (this.projectPath) {
      // 后台初始化，使 initialize 响应保持快速（#172）。
      void this.engine.ensureInitialized(this.projectPath);
    }

    this.session.start();

    // 检测父进程死亡 — 与重构前逻辑相同。当 stdin 关闭时，
    // 我们已通过 StdioTransport 的 `process.exit(0)` 处理，但父进程被 SIGKILL
    // 在 Linux 上并不总能可靠地关闭 stdin（#277）。
    // 同样将 stdin `'error'`（socket 后端的 stdin 可能以 ECONNRESET/hangup 而非
    // 干净关闭结束）视为关闭，并销毁流以防挂起的 fd 忙自旋事件循环（#799）。
    treatStdinFailureAsShutdown(() => this.stop());

    this.mode = 'direct';
    this.installSignalHandlers();
    this.installPpidWatchdog();
    this.livenessWatchdog = installMainThreadWatchdog();
  }

  /**
   * 作为分离共享守护进程运行（以 `SYNAPSE_DAEMON_INTERNAL=1` 派生的进程）。
   * 仲裁 O_EXCL 锁，然后成为守护进程（绑定 socket，永久服务）— 或者
   * 如果存活的守护进程已持有锁 — 退出以免泄漏冗余进程。
   *
   * 没有 PPID 看门狗，也没有 stdin 处理器：守护进程是刻意分离的，
   * 通过客户端引用计数 + 空闲超时自我回收（见 {@link Daemon}）。
   */
  private async startDaemonProcess(): Promise<void> {
    const root = resolveDaemonRoot(this.projectPath) ?? this.projectPath ?? process.cwd();
    for (let attempt = 0; attempt < TAKEOVER_MAX_RETRIES; attempt++) {
      const lock = tryAcquireDaemonLock(root);

      if (lock.kind === 'acquired') {
        const daemon = new Daemon(root);
        await daemon.start();
        this.daemon = daemon;
        this.mode = 'daemon';
        // 分离守护进程没有 PPID 看门狗或 stdin 生命线，
        // 因此主线程若卡住会永久占用一个核心（#850）。活跃性
        // 看门狗是唯一的恢复路径。
        this.livenessWatchdog = installMainThreadWatchdog();
        return; // net.Server 会保持进程存活
      }

      // 已被占用。如果持有者存活，另一个守护进程已在服务（或正在绑定）—
      // 我们是多余的；干净退出，让启动器代理到它。
      const existing = lock.existing;
      if (existing && existing.pid > 0 && isProcessAlive(existing.pid)) {
        process.stderr.write(
          `[Synapse daemon] Another daemon (pid ${existing.pid}) already holds the lock; exiting.\n`
        );
        process.exit(0);
      }

      // 持有者已死（或记录不可读）— 清除它（已验证 pid，
      // 因此永远不会删除存活守护进程的锁）并重试获取。
      clearStaleDaemonLock(lock.pidPath, existing?.pid);
      await sleep(TAKEOVER_RETRY_DELAY_MS);
    }

    process.stderr.write('[Synapse daemon] Could not acquire the daemon lock; exiting.\n');
    process.exit(0);
  }

  /**
   * 代理模式（常见情况）。立即响应 MCP 握手以实现即时工具注册，
   * 将工具调用转发到共享守护进程 — 共享守护进程在后台连接
   * （探测，若不存在则派生 + 轮询），因此握手永远不会等待约 600ms。
   * 运行直到宿主断开连接；若守护进程始终未绑定，代理回退到进程内引擎，
   * 因此永远不会卡住会话。
   */
  private async runProxyWithLocalHandshake(root: string): Promise<void> {
    const socketPath = getDaemonSocketPath(root);
    const getDaemonSocket = async () => {
      // 快速路径：守护进程可能已在监听。
      const probe = await connectWithHello(socketPath);
      if (probe === 'version-mismatch') return null; // 明确结论 — 在进程内服务，不再轮询 6s
      if (probe) return probe;
      // 均不可达 — 派生一个（分离模式）并轮询其绑定。
      spawnDetachedDaemon(root);
      for (let attempt = 0; attempt < DAEMON_CONNECT_MAX_RETRIES; attempt++) {
        await sleep(DAEMON_CONNECT_RETRY_DELAY_MS);
        const s = await connectWithHello(socketPath);
        if (s === 'version-mismatch') return null;
        if (s) return s;
      }
      return null; // 从未绑定 — 代理在进程内服务此会话
    };
    await runLocalHandshakeProxy({ getDaemonSocket, makeEngine: () => new MCPEngine(), root });
  }

  /** 路由到我们 `stop()` 的标准 SIGINT/SIGTERM 处理器（直接模式）。 */
  private installSignalHandlers(): void {
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  /**
   * PPID 看门狗（#277）— 仅限直接模式。守护进程模式刻意分离，
   * 通过空闲超时回收；代理模式在 {@link runProxy} 内安装自己的看门狗。
   * 因此这里只在进程内直接会话中运行。
   */
  private installPpidWatchdog(): void {
    if (this.mode !== 'direct') return;
    const pollMs = parsePpidPollMs(process.env.SYNAPSE_PPID_POLL_MS);
    if (pollMs <= 0) return;
    this.ppidWatchdog = setInterval(() => {
      const reason = supervisionLostReason({
        originalPpid: this.originalPpid,
        currentPpid: process.ppid,
        hostPpid: this.hostPpid,
        isAlive: isProcessAlive,
      });
      if (reason) {
        process.stderr.write(
          `[Synapse MCP] Parent process exited (${reason}); shutting down.\n`
        );
        this.stop();
      }
    }, pollMs);
    this.ppidWatchdog.unref();
  }
}

function sleep(ms: number): Promise<void> {
  // 刻意*不* unref。在守护进程连接/接管重试循环期间，我们可能处于进程之间 —
  // 尚未绑定 socket，没有传输层，没有监听器固定事件循环。
  // unref 的定时器会让 Node 排空循环并静默退出，使我们没有机会再次尝试。
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// 导出供 CLI 使用
export { StdioTransport } from './transport';
export { tools, ToolHandler } from './tools';
// 暴露部分守护进程模式的内容供测试 + 诊断使用。
export { Daemon } from './daemon';
export { SynapsePackageVersion } from './version';
