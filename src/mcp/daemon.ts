/**
 * 共享 MCP 守护进程 — issue #411。
 *
 * 每个项目根目录一个分离的 `synapse serve --mcp` 守护进程进程，
 * 通过 Unix 域 socket（或 Windows 上的命名管道）接受 N 个并发 MCP 客户端。
 * 每个进入的连接获得自己的 {@link MCPSession}；所有会话共享单个 {@link MCPEngine}，
 * 这意味着单个文件监视器（一个 inotify 集）、单个 SQLite 连接（一个 WAL 写入器）
 * 和单次 tree-sitter 预热 — 一次付出，摊销到所有与该项目通信的智能体。
 *
 * 生命周期（另见 `./index.ts` 和 `./proxy.ts`）：
 *   - 守护进程由发现没有守护进程运行的第一个启动器**分离地**派生
 *     （独立的 session/进程组，stdio 解耦）。它**不是**任何 MCP 宿主的子进程，
 *     因此关闭一个终端/Ctrl-C 一个会话不会使其停止并断开其他客户端。
 *     这就是为什么此进程没有 PPID 看门狗：它刻意比所有单个客户端存活更久。
 *   - 每个 MCP 宿主通过一个薄薄的 `proxy` 进程（宿主实际派生的那个）与守护进程通信。
 *     代理保留 #277 PPID 看门狗，因此被 SIGKILL 的宿主仍会及时回收其代理；
 *     代理的 socket 关闭随后递减守护进程的引用计数。
 *   - 当最后一个客户端断开连接时，守护进程会等待
 *     `SYNAPSE_DAEMON_IDLE_TIMEOUT_MS`（默认 300s），以便同一项目中背靠背的
 *     智能体运行不必重新支付启动代价，然后干净退出。这就是防止单次智能体会话
 *     永远泄漏守护进程的机制（#277）。
 *
 * 此文件负责：
 *   - 监听守护进程 socket 并为每个连接派生会话。
 *   - 让代理在通过它管道传输任何 JSON-RPC 之前验证找到的是同版本守护进程的
 *     握手 "hello" 行。
 *   - 竞争守护进程仲裁的锁文件（`.synapse/daemon.pid`）— 原子 `O_EXCL` 创建，
 *     同时写入完整记录（没有空文件窗口）+ 退出时清理。
 *   - 引用计数 + 空闲超时。
 *   - 优雅关闭（SIGTERM/SIGINT）和空闲退出。
 *
 * 此文件不负责：
 *   - 代理侧（`./proxy.ts`）。
 *   - *是否*以守护进程模式运行的决策 — 那是 `MCPServer` 的职责。
 *   - MCP 协议状态机 — 那是 `./session.ts` 的职责。
 */

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { MCPEngine } from './engine';
import { MCPSession } from './session';
import { SocketTransport } from './transport';
import {
  DaemonLockInfo,
  decodeLockInfo,
  encodeLockInfo,
  getDaemonPidPath,
  getDaemonSocketPath,
} from './daemon-paths';
import { SynapsePackageVersion } from './version';
import { registerDaemon, deregisterDaemon } from './daemon-registry';

/** 最后一个客户端断开后的默认空闲等待时间。 */
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/**
 * 当客户端仍（名义上）连接但没有入站流量时守护进程保持运行的硬性上限。
 * 这是一个兜底（#692）：如果客户端的 socket 关闭从未被送达
 * （Windows 命名管道的隐患），它会永久被计入引用，而仅在零客户端时
 * 触发的正常空闲定时器永远不会触发。幽灵客户端不发送任何流量，
 * 因此通过不活跃性限制来回收守护进程。设置得足够宽裕，
 * 以免真实但暂时空闲的会话在使用中被回收。
 */
const DEFAULT_MAX_IDLE_MS = 1_800_000; // 30 min

/** 守护进程扫描已连接客户端以查找死亡对端进程的频率（#692）。 */
const DEFAULT_CLIENT_SWEEP_MS = 30_000;

/** 守护进程在继续处理之前等待可选客户端 hello 的时长。 */
const CLIENT_HELLO_TIMEOUT_MS = 3_000;

/** 超大 hello 行的字节/解析窗口 — 防范恶意对端。 */
const MAX_HELLO_LINE_BYTES = 4096;

/**
 * 守护进程在每个新连接上发出的单次 hello 行的线格式。
 * 以包自身的 semver 版本化，使 0.9.x 代理永远不会通过 0.10.x 守护进程传输（反之亦然）—
 * 代理在版本不匹配时回退到直接模式，而不是冒着细微线格式不兼容的风险。
 */
export interface DaemonHello {
  synapse: string; // 包版本（必须与代理自身版本匹配）
  pid: number;       // 守护进程 pid（信息性；用于 `ps` 调试）
  socketPath: string; // 回显以便代理记录日志
  protocol: 1;       // hello 形状改变时递增
}

/**
 * 代理在验证守护进程 hello 后立即发送的可选反向握手行，携带自身 pid，
 * 以便守护进程在客户端进程死亡但 socket 从未发出关闭信号时（#692 背后的 Windows
 * 命名管道隐患）能够回收该客户端。完全可选且故障安全：从未发送此行的连接
 * （旧版/直接客户端）只是回退到 socket 关闭生命周期。`synapse_client` 标记
 * 用于将其与客户端的第一条 JSON-RPC 消息区分。
 */
export interface DaemonClientHello {
  synapse_client: 1;
  pid: number;             // 代理进程自身的 pid
  hostPid: number | null;  // MCP 宿主 pid（经过任何启动器 shim），若已知
}

export interface DaemonStartResult {
  /** 成功启动的守护进程始终非空。 */
  socketPath: string;
  /** 已写入的锁文件内容。 */
  lock: DaemonLockInfo;
}

/**
 * 作为 `projectRoot` 的共享守护进程运行。socket 开始监听后 resolve。
 * 守护进程拥有 socket、引擎和锁文件，直到调用 `stop()` 或因空闲/信号退出。
 *
 * 竞争安全：调用方必须首先调用 `tryAcquireDaemonLock(projectRoot)`，
 * 仅在获得锁（`kind: 'acquired'`）时才构造 Daemon。获取辅助函数内部的原子
 * `O_EXCL` 创建 — 现在也在返回前写入完整记录 — 是竞争守护进程之间唯一的同步机制。
 */
export class Daemon {
  private server: net.Server | null = null;
  private clients = new Set<MCPSession>();
  /** 每个客户端来自可选 client-hello 的对端 pid，供活跃性扫描使用。 */
  private clientPeers = new Map<MCPSession, { pid: number | null; hostPid: number | null }>();
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number;
  private maxIdleMs: number;
  private lastActivityAt = Date.now();
  private maxIdleTimer: NodeJS.Timeout | null = null;
  private clientSweepTimer: NodeJS.Timeout | null = null;
  private engine: MCPEngine;
  private stopping = false;
  private socketPath: string;
  private pidPath: string;

  constructor(
    private projectRoot: string,
    opts: { idleTimeoutMs?: number; maxIdleMs?: number } = {},
  ) {
    this.socketPath = getDaemonSocketPath(projectRoot);
    this.pidPath = getDaemonPidPath(projectRoot);
    this.idleTimeoutMs = opts.idleTimeoutMs ?? resolveIdleTimeoutMs();
    this.maxIdleMs = opts.maxIdleMs ?? resolveMaxIdleMs();
    this.engine = new MCPEngine();
    this.engine.setProjectPathHint(projectRoot);
  }

  /**
   * 绑定 socket，启动引擎初始化，并注册信号处理器。锁文件体已由
   * `tryAcquireDaemonLock` 原子写入，因此这里无需写入。Promise 在服务器开始
   * 监听后 resolve — 守护进程随后一直存在直到空闲/关闭。
   */
  async start(): Promise<DaemonStartResult> {
    // 引擎初始化刻意在后台执行 — 见 #172。首个到达的会话无论如何都会
    // 等待 `ensureInitialized`，而未加载的会话（仅跨项目工具调用）不应支付任何打开代价。
    void this.engine.ensureInitialized(this.projectRoot);

    // 过期的 socket 文件（被 SIGKILL 的上一个守护进程遗留）会使
    // `listen` 因 EADDRINUSE 挂起。我们持有锁文件到达这里，
    // 意味着没有存活的守护进程，因此安全地清除。
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.socketPath); } catch { /* not-exists is fine */ }
    }

    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      server.once('error', (err) => reject(err));
      server.listen(this.socketPath, () => {
        // POSIX：收紧权限为仅限用户 — socket 存放在 `.synapse/` 下，
        // 该目录被 git 忽略但可能在共享文件系统上。
        if (process.platform !== 'win32') {
          try { fs.chmodSync(this.socketPath, 0o600); } catch { /* best-effort */ }
        }
        this.server = server;
        resolve();
      });
    });

    const lock: DaemonLockInfo = {
      pid: process.pid,
      version: SynapsePackageVersion,
      socketPath: this.socketPath,
      startedAt: Date.now(),
    };

    // 发布一条发现记录，以便 `synapse list` / `stop --all` 能找到我们。
    // 尽力而为；缺少记录只意味着 list 的活跃性修剪会覆盖它。
    registerDaemon({ root: this.projectRoot, ...lock });

    process.stderr.write(
      `[Synapse daemon] Listening on ${this.socketPath} (pid ${process.pid}, v${SynapsePackageVersion}). Idle timeout ${this.idleTimeoutMs}ms.\n`
    );

    // 尚无客户端：立即触发空闲定时器，使从未有人连接的守护进程
    // （例如派生后因启动器死亡而被放弃的）不会永久占用资源。
    this.armIdleTimer();
    this.startLivenessTimers();

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));

    return { socketPath: this.socketPath, lock };
  }

  /** 当前已连接的客户端数量。暴露给测试/状态输出使用。 */
  getClientCount(): number {
    return this.clients.size;
  }

  /** 守护进程正在（或将要）监听的 socket 路径。 */
  getSocketPath(): string {
    return this.socketPath;
  }

  /** 优雅关闭：关闭所有会话、引擎，并清理锁。 */
  async stop(reason: string = 'stop'): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.maxIdleTimer) {
      clearInterval(this.maxIdleTimer);
      this.maxIdleTimer = null;
    }
    if (this.clientSweepTimer) {
      clearInterval(this.clientSweepTimer);
      this.clientSweepTimer = null;
    }
    process.stderr.write(`[Synapse daemon] Shutting down (${reason}; clients=${this.clients.size}).\n`);
    for (const session of [...this.clients]) {
      try { session.stop(); } catch { /* best-effort */ }
    }
    this.clients.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    this.engine.stop();
    this.cleanupLockfile();
    deregisterDaemon(this.projectRoot);
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.socketPath); } catch { /* may already be gone */ }
    }
    process.exit(0);
  }

  private handleConnection(socket: net.Socket): void {
    // 先发送 hello，以便代理在管道传输任何应用字节之前验证版本。
    // 代理恰好读取一行，然后转发。
    const hello: DaemonHello = {
      synapse: SynapsePackageVersion,
      pid: process.pid,
      socketPath: this.socketPath,
      protocol: 1,
    };
    socket.write(JSON.stringify(hello) + '\n');

    // 读取可选的 client-hello（代理 → 守护进程）以获取客户端的对端 pid，
    // 然后将 socket 交给会话。故障安全：任何问题 — 超时、非 hello 的第一行、
    // 提前关闭 — 都产生空 pid，我们像之前一样回退到 socket 关闭生命周期（#692）。
    void readClientHello(socket).then((peers) => {
      const transport = new SocketTransport(socket);
      const session = new MCPSession(transport, this.engine, {
        explicitProjectPath: this.projectRoot,
      });
      transport.onClose(() => this.dropClient(session));
      this.clients.add(session);
      this.clientPeers.set(session, peers);
      this.disarmIdleTimer();
      session.start();
      // 仅观察入站字节以驱动不活跃兜底 — 第二个 'data' 监听器，
      // 什么都不读，在传输层的监听器之后添加，以便
      // unshift 的 client-hello 尾部能完整到达传输层。
      socket.on('data', () => { this.lastActivityAt = Date.now(); });
    });
  }

  private dropClient(session: MCPSession): void {
    if (!this.clients.delete(session)) return;
    this.clientPeers.delete(session);
    if (this.clients.size === 0) this.armIdleTimer();
  }

  private armIdleTimer(): void {
    if (this.idleTimer || this.stopping) return;
    if (this.idleTimeoutMs <= 0) return; // 0 = 永不空闲退出
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // 最后一刻健全性检查：如果定时器触发到现在之间有连接到来，不退出。
      // （setImmediate 顺序是唯一的竞争方式；防御代价很低。）
      if (this.clients.size > 0) {
        this.armIdleTimer();
        return;
      }
      void this.stop('idle timeout');
    }, this.idleTimeoutMs);
    // 不要仅为此定时器保持事件循环存活 — net.Server 在监听时会保持
    // 循环存活，定时器仍会触发；一旦我们 stop()，循环应自然排空。
    this.idleTimer.unref?.();
  }

  private disarmIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * 针对守护进程在引用计数 + 空闲定时器因 socket 关闭从未到达而失效的情况
   * 的纵深防御（#692）：
   *   - **不活跃兜底：** 如果在仍（名义上）有客户端连接时的 `maxIdleMs` 内
   *     没有入站流量，则退出。幽灵客户端什么都不发送，因此不能在此窗口之外
   *     固定守护进程。
   *   - **活跃性扫描：** 丢弃任何对端进程已死亡的客户端（根据 client-hello pid），
   *     一旦最后一个真实客户端消失就重新触发空闲定时器。在一次扫描内
   *     捕获死亡对端，而不是等待整个兜底时间。
   * 两个定时器都 unref — 监听中的服务器保持循环存活，
   * 两者都不应单独持有它。
   */
  private startLivenessTimers(): void {
    if (this.maxIdleMs > 0) {
      const tick = Math.min(this.maxIdleMs, 60_000);
      this.maxIdleTimer = setInterval(() => {
        if (this.stopping || this.clients.size === 0) return; // idle timer owns the no-client case
        if (Date.now() - this.lastActivityAt >= this.maxIdleMs) {
          void this.stop('inactivity backstop');
        }
      }, tick);
      this.maxIdleTimer.unref?.();
    }
    const sweepMs = resolveClientSweepMs();
    if (sweepMs > 0) {
      this.clientSweepTimer = setInterval(() => this.reapDeadClients(isProcessAlive), sweepMs);
      this.clientSweepTimer.unref?.();
    }
  }

  /**
   * 丢弃每个对端进程已消失的已连接客户端。返回回收的数量。
   * `isAlive` 可注入以供测试。没有已知 pid（无 client-hello）的客户端被跳过 —
   * 它们依赖 socket 关闭路径。
   */
  reapDeadClients(isAlive: (pid: number) => boolean): number {
    if (this.clients.size === 0) return 0;
    let reaped = 0;
    for (const session of [...this.clients]) {
      const peers = this.clientPeers.get(session);
      if (!peers || !peerIsDead(peers, isAlive)) continue;
      process.stderr.write(
        `[Synapse daemon] Reaping client with dead peer (pid ${peers.pid}); clients=${this.clients.size - 1}.\n`
      );
      try { session.stop(); } catch { /* best-effort */ }
      this.dropClient(session);
      reaped++;
    }
    return reaped;
  }

  private cleanupLockfile(): void {
    try {
      if (fs.existsSync(this.pidPath)) {
        // 仅在仍属于我们时删除 — 另一个守护进程可能已在我们关闭期间接管（极为罕见）。
        const raw = fs.readFileSync(this.pidPath, 'utf8');
        const info = decodeLockInfo(raw);
        if (info && info.pid === process.pid) {
          fs.unlinkSync(this.pidPath);
        }
      }
    } catch { /* best-effort; we're exiting anyway */ }
  }
}

/**
 * `tryAcquireDaemonLock` 的结果。要么我们获得了锁文件（调用方成为守护进程），
 * 要么它已存在（调用方应作为代理连接到现有守护进程，或者 — 如果持有者已死 —
 * 清除它并重试）。
 */
export type AcquireResult =
  | { kind: 'acquired'; pidPath: string; info: DaemonLockInfo }
  | { kind: 'taken'; existing: DaemonLockInfo | null; pidPath: string };

/**
 * 以原子方式创建守护进程 pidfile，并已在其中写入完整记录。
 * 返回 `acquired` 结果（调用方是守护进程候选，可以构造 {@link Daemon}）
 * 或 `taken` 结果。
 *
 * must-fix 1（issue #411 审查）：锁文件必须在一个原子步骤中出现，且已经完整 —
 * 永远不能为空，哪怕是瞬间。最初的尝试（`O_EXCL` 创建后再单独 `writeSync`）
 * 留下了一个微秒级窗口，文件存在但为空；在并发守护进程启动时，
 * 第三个候选可以读到那个空文件，将其解码为 `null`，然后 `unlink` 赢家的锁 →
 * 两个守护进程（两个监视器，两个写入器）。这个窗口通常太短而无法命中，
 * 但文件监视器额外的启动时间使并发守护进程重叠到足以可靠地复现。
 *
 * 修复方法是将完整记录写入私有临时文件，然后将其硬链接到目标位置：
 * `link()` 既原子又排他（目标存在时 EEXIST），因此 pidfile 在一步中变为可见，
 * 且已包含完整记录。首先链接者获胜；其他人得到 EEXIST 并读取完整文件。
 * 完全没有空文件窗口。
 */
export function tryAcquireDaemonLock(projectRoot: string): AcquireResult {
  const pidPath = getDaemonPidPath(projectRoot);
  // Make sure the .synapse/ directory exists — the daemon may be the first
  // thing to touch it on a fresh-clone-but-already-initialized checkout.
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });

  const info: DaemonLockInfo = {
    pid: process.pid,
    version: SynapsePackageVersion,
    socketPath: getDaemonSocketPath(projectRoot),
    startedAt: Date.now(),
  };

  // 临时文件名以 pid 为作用域，竞争候选永远不会在它上面冲突。
  const tmp = `${pidPath}.${process.pid}.tmp`;
  let acquired = false;
  try {
    fs.writeFileSync(tmp, encodeLockInfo(info), { mode: 0o600 });
    try {
      fs.linkSync(tmp, pidPath); // atomic + exclusive
      acquired = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* temp already gone */ }
  }

  if (acquired) return { kind: 'acquired', pidPath, info };

  // 已被占用。因为 pidfile 是原子链接的，所以它始终持有完整记录 —
  // `existing` 仅对真正损坏的遗留文件为 null，而不是写入中途的竞争。
  let existing: DaemonLockInfo | null = null;
  try {
    existing = decodeLockInfo(fs.readFileSync(pidPath, 'utf8'));
  } catch { /* unreadable lockfile — treat as malformed */ }
  return { kind: 'taken', existing, pidPath };
}

/**
 * 清除过期的 pidfile，但仅在它仍然指向已死进程时。在 unlink 前立即重新读取文件，
 * 确保我们永远不会删除存活守护进程（重新）获取的锁。
 *
 * must-fix 1（issue #411 审查）：原始实现无条件 `unlink`，
 * 这让竞争候选可以删除健康守护进程的锁。传入 `expectedDeadPid`
 * （调用方认为已死的 pid）使清除成为比较-并-删除操作：
 * 如果文件现在持有不同的 pid，或任何存活的 pid，则退出。
 * 返回 true 表示过期锁已消失（或已经消失）。
 */
export function clearStaleDaemonLock(pidPath: string, expectedDeadPid?: number): boolean {
  try {
    const raw = fs.readFileSync(pidPath, 'utf8');
    const info = decodeLockInfo(raw);
    if (info) {
      // 另一个 pid 自我们读取后接管了 — 不是我们该清除的。
      if (expectedDeadPid !== undefined && info.pid !== expectedDeadPid) return false;
      // 持有者实际上存活 — 永远不清除存活守护进程的锁。
      if (info.pid > 0 && isProcessAlive(info.pid)) return false;
    }
    fs.unlinkSync(pidPath);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return true; // 已消失
    return false;
  }
}

/**
 * 探测 `pid` 当前是否存活（signal-0）。在所有平台上将 EPERM 视为存活
 * （进程存在，只是不属于我们来发信号），以防我们将存活的守护进程误认为已死
 * 并清除其锁。
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EPERM') return true; // 存在，只是不属于我们来发信号
    return false;
  }
}

function resolveIdleTimeoutMs(): number {
  const raw = process.env.SYNAPSE_DAEMON_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.floor(parsed);
}

function resolveMaxIdleMs(): number {
  const raw = process.env.SYNAPSE_DAEMON_MAX_IDLE_MS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_IDLE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_IDLE_MS;
  return Math.floor(parsed); // 0 disables the backstop
}

function resolveClientSweepMs(): number {
  const raw = process.env.SYNAPSE_DAEMON_CLIENT_SWEEP_MS;
  if (raw === undefined || raw === '') return DEFAULT_CLIENT_SWEEP_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CLIENT_SWEEP_MS;
  return Math.floor(parsed); // 0 disables the sweep
}

/**
 * 解析一行 client-hello。如果 `line` 是格式良好的 client-hello
 * （携带 `synapse_client` 标记），返回对端 pid；否则返回 null —
 * 在这种情况下调用方将字节视为普通 JSON-RPC。
 */
export function parseClientHelloLine(
  line: string,
): { pid: number; hostPid: number | null } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (o.synapse_client !== 1 || typeof o.pid !== 'number') return null;
  return { pid: o.pid, hostPid: typeof o.hostPid === 'number' ? o.hostPid : null };
}

/**
 * 当客户端的代理进程消失，或其已知宿主进程消失时，该客户端的对端视为已死。
 * 未知 pid（无 client-hello）在此基础上永远不是"已死" —
 * 这些客户端依赖 socket 关闭路径。导出供测试使用。
 */
export function peerIsDead(
  peers: { pid: number | null; hostPid: number | null },
  isAlive: (pid: number) => boolean,
): boolean {
  if (peers.pid === null) return false;
  if (!isAlive(peers.pid)) return true;
  if (peers.hostPid !== null && !isAlive(peers.hostPid)) return true;
  return false;
}

/**
 * 读取代理在守护进程 hello 之后发送的可选 client-hello 行。
 * 始终 resolve（永不 reject）— 设计上故障安全，因为每个连接都经过这里。
 * 当第一行是 client-hello 时以对端 pid resolve；否则以空 pid resolve，
 * 并将已读字节 unshift 回去，使传输层将其解析为客户端的第一条 JSON-RPC 消息。
 * 以 Buffer 形式累积并在换行字节处分割，使跨块边界的 UTF-8 序列
 * 在 unshift 的尾部中永远不会被损坏。
 */
function readClientHello(
  socket: net.Socket,
): Promise<{ pid: number | null; hostPid: number | null }> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (
      peers: { pid: number | null; hostPid: number | null },
      putBack?: Buffer,
    ) => {
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onEnd);
      socket.removeListener('close', onEnd);
      clearTimeout(timer);
      if (putBack && putBack.length > 0 && !socket.destroyed) {
        try { socket.unshift(putBack); } catch { /* stream already gone */ }
      }
      resolve(peers);
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      chunks.push(buf);
      total += buf.length;
      const all = chunks.length === 1 ? buf : Buffer.concat(chunks, total);
      const nl = all.indexOf(0x0a); // '\n'
      if (nl === -1) {
        // 尚无换行符。如果已经太长而不可能是 hello，就不是 —
        // 将字节归还为数据；否则继续累积。
        if (total > MAX_HELLO_LINE_BYTES) finish({ pid: null, hostPid: null }, all);
        else chunks = [all];
        return;
      }
      const peers = parseClientHelloLine(all.subarray(0, nl).toString('utf8'));
      if (peers) {
        const tail = all.subarray(nl + 1);
        finish(peers, tail.length > 0 ? tail : undefined);
      } else {
        // 第一行不是 client-hello（旧版/直接客户端）— 将整个缓冲区归还，
        // 使传输层能原样看到消息。
        finish({ pid: null, hostPid: null }, all);
      }
    };
    const onEnd = () => finish({ pid: null, hostPid: null });
    const timer = setTimeout(() => finish({ pid: null, hostPid: null }), CLIENT_HELLO_TIMEOUT_MS);
    timer.unref?.();
    socket.on('data', onData);
    socket.on('error', onEnd);
    socket.on('close', onEnd);
  });
}

/** 导出供需要限定 hello 行读取的测试桩使用。 */
export { MAX_HELLO_LINE_BYTES };
