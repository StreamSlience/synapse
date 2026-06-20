/**
 * MCP 代理模式 — issue #411。
 *
 * 代理是一个近乎透明的 stdio↔socket 管道。一旦验证了守护进程的 hello 行
 * （与本进程的主版本.次版本.补丁版本完全一致），它就不再自行解析协议：
 * MCP 宿主写入代理 stdin 的每个字节都直接传到守护进程 socket，
 * 守护进程发出的每个字节都直接传到宿主的 stdout。
 * 服务器发起的 JSON-RPC 请求（如 `roots/list`）也通过同一管道透明地流通。
 *
 * 生命周期预期：
 *   - 代理在*任一*流关闭时退出（宿主 stdin 关闭 → 守护进程 socket 结束，
 *     或守护进程侧 socket 关闭 → 宿主 stdout 结束）。
 *   - 在代理侧关闭 socket 是通知守护进程递减已连接客户端引用计数的方式。
 *   - 对于无法通过 stdin 关闭感知的父进程死亡（如 MCP 宿主被 SIGKILL），
 *     代理的 PPID 看门狗会捕获它 — 与直接模式服务器使用的逻辑相同；参见 issue #277。
 */

import * as fs from 'fs';
import * as net from 'net';
import { HOST_PPID_ENV } from '../extraction/wasm-runtime-flags';
import { DaemonClientHello, DaemonHello, MAX_HELLO_LINE_BYTES } from './daemon';
import { supervisionLostReason } from './ppid-watchdog';
import { treatStdinFailureAsShutdown } from './stdin-teardown';
import { SynapsePackageVersion } from './version';
import { SERVER_INFO, PROTOCOL_VERSION } from './session';
import { SERVER_INSTRUCTIONS } from './server-instructions';
import { getStaticTools } from './tools';
import { getTelemetry, ClientInfo } from '../telemetry';
import type { MCPEngine } from './engine';

/** PPID 看门狗的默认轮询间隔（与直接模式服务器相同）。 */
const DEFAULT_PPID_POLL_MS = 5000;

/**
 * 选择加入"已连接到共享守护进程"日志行的环境变量。默认关闭：
 * 该行是无害的 INFO，但 MCP 宿主会将服务器 stderr 渲染为错误级别
 * （并附加一个 `undefined` 数据字段），导致每次会话启动时
 * 一条正常的连接成功日志显示为 `[error] … undefined`。
 * 调试守护进程连接时设为 `1` 以启用。（#618；方案来自 #640，作者 @mturac）
 */
const LOG_ATTACH_ENV = 'SYNAPSE_MCP_LOG_ATTACH';

/**
 * 记录成功的守护进程连接 — 受 {@link LOG_ATTACH_ENV} 门控，默认静默
 * （见 #618）。导出以供测试使用。
 */
export function logAttachedDaemon(socketPath: string, hello: DaemonHello): void {
  if (process.env[LOG_ATTACH_ENV] !== '1') return;
  process.stderr.write(
    `[Synapse MCP] Attached to shared daemon on ${socketPath} (pid ${hello.pid}, v${hello.synapse}).\n`
  );
}

export interface ProxyResult {
  /**
   * `proxied` — 成功连接到同版本守护进程并完成 stdio 管道传输。
   * 代理保持存活直到任一端关闭。
   * `fallback-needed` — 守护进程拒绝了我们（版本不匹配/socket 不可达），
   * 调用方应以直接模式运行服务器。
   */
  outcome: 'proxied' | 'fallback-needed';
  reason?: string;
}

/**
 * 尝试连接到 `socketPath` 处的守护进程并通过它管道传输 stdio。
 *
 * 返回一个 Promise，在以下情况之一时 resolve：
 *   - 连接成功且 stdin/socket 中的一个已关闭
 *     （此后进程应退出），或
 *   - 连接在足够早期失败，调用方仍可回退到直接模式。
 *
 * `expectedVersion` 参数默认为包自身的版本 — 守护进程和代理*必须*完全匹配。
 * 不匹配时以 `outcome: 'fallback-needed'` resolve，调用方可透明地启动
 * 自己的服务器。（我们接受此情况下两个并发服务器的代价，以确保
 * 永远不会静默地用旧守护进程运行新客户端代码。）
 */
export async function runProxy(
  socketPath: string,
  expectedVersion: string = SynapsePackageVersion,
): Promise<ProxyResult> {
  // POSIX：拒绝连接到没有监听进程的过期 socket 文件。
  // `fs.existsSync` 是廉价的预检；真正的 ECONNREFUSED 会捕获罕见的"文件存在但未绑定"竞争。
  if (process.platform !== 'win32' && !fs.existsSync(socketPath)) {
    return { outcome: 'fallback-needed', reason: 'socket file missing' };
  }

  const socket = net.createConnection(socketPath);
  socket.setEncoding('utf8');

  const hello = await readHelloLine(socket).catch((err) => {
    socket.destroy();
    return new Error(String(err));
  });
  if (hello instanceof Error) {
    return { outcome: 'fallback-needed', reason: hello.message };
  }

  if (hello.synapse !== expectedVersion) {
    process.stderr.write(
      `[Synapse MCP] Found a daemon on ${socketPath} but version (${hello.synapse}) ` +
      `differs from ours (${expectedVersion}); falling back to direct mode.\n`
    );
    socket.destroy();
    return { outcome: 'fallback-needed', reason: 'version mismatch' };
  }

  logAttachedDaemon(socketPath, hello);

  sendClientHello(socket);
  startPpidWatchdog(socket);
  await pipeUntilClose(socket);
  // 宿主断连（或守护进程消失）。代理的唯一职责是管道传输；
  // 现在退出，以免我们滞留 — process.stdin 的 'data' 监听器
  // 否则会让事件循环保持活跃，留下一个僵尸启动器。
  process.exit(0);
}

/**
 * 连接到 `socketPath` 处的守护进程并验证其 hello（精确版本匹配）。
 * 返回存活的 socket（hello 已消费）或在不可达/过期/版本不匹配时返回 null。
 * 与 {@link runProxy} 不同，它*不*做管道传输 — 调用方拥有该 socket。
 * 供本地握手代理的后台连接使用。
 */
export async function connectWithHello(
  socketPath: string,
  expectedVersion: string = SynapsePackageVersion,
): Promise<net.Socket | 'version-mismatch' | null> {
  if (process.platform !== 'win32' && !fs.existsSync(socketPath)) return null;
  const socket = net.createConnection(socketPath);
  socket.setEncoding('utf8');
  const hello = await readHelloLine(socket).catch(() => null);
  if (!hello) {
    socket.destroy();
    return null; // 守护进程尚未就绪 — 调用方应继续轮询
  }
  if (hello.synapse !== expectedVersion) {
    // 守护进程*已*启动但版本错误 — 这是确定性的，不是"尚未就绪"。
    // 不要轮询；调用方在进程内响应，以确保不会运行旧版对新版。
    process.stderr.write(
      `[Synapse MCP] Found a daemon on ${socketPath} but version (${hello.synapse}) ` +
      `differs from ours (${expectedVersion}); serving this session in-process.\n`
    );
    socket.destroy();
    return 'version-mismatch';
  }
  logAttachedDaemon(socketPath, hello);
  sendClientHello(socket);
  return socket;
}

/**
 * 验证守护进程 hello 后立即告知守护进程我们的 pid，以便其活跃性扫描
 * 能在我们的进程死亡但 socket 未能触发关闭时回收此客户端
 * （Windows 命名管道的 #692 隐患）。尽力而为：在任何管道字节之前发送，
 * 因此始终是守护进程从我们这里收到的第一行；此处写入失败无害
 * （守护进程仅回退到 socket 关闭生命周期）。`hostPid` 镜像 PPID 看门狗：
 * 若已设置则为透传的宿主 pid，否则为我们自己的父进程（无重启 bundle 时的宿主）。
 */
function sendClientHello(socket: net.Socket): void {
  const clientHello: DaemonClientHello = {
    synapse_client: 1,
    pid: process.pid,
    hostPid: parseHostPpid(process.env[HOST_PPID_ENV]) ?? process.ppid,
  };
  try { socket.write(JSON.stringify(clientHello) + '\n'); } catch { /* best-effort */ }
}

type JsonRpc = Record<string, unknown>;

/** 本地握手代理所需的依赖项，由 MCPServer 注入
 *  （MCPServer 拥有守护进程派生机制和引擎工厂）。 */
export interface LocalHandshakeDeps {
  /** 探测 → 派生 → 重试 → hello 验证；resolve 一个已连接的守护进程 socket，
   *  或在守护进程路径确实不可用时返回 null（→ 进程内回退）。 */
  getDaemonSocket(): Promise<net.Socket | null>;
  /** 惰性创建进程内引擎 — 仅在守护进程始终未启动时使用，
   *  保持"损坏的守护进程永远不会卡住会话"的保证。 */
  makeEngine(): MCPEngine;
  /** 回退引擎惰性初始化的项目根目录。 */
  root: string;
}

/**
 * 本地握手代理（冷启动修复）。
 *
 * 在客户端请求的瞬间，立即从*静态常量*响应 `initialize` + `tools/list` —
 * 工具注册在约进程启动时间内完成，而不是等待守护进程派生+绑定的约 600ms，
 * 正是这个等待产生了"No such tool available"竞争，导致无头智能体乱用 grep/Read。
 * 工具*调用*转发到共享守护进程（在后台连接）；守护进程对转发的 `initialize`
 * 的响应被抑制（客户端已收到本地响应）。如果守护进程始终未启动
 * （版本不匹配/派生失败），惰性创建的进程内引擎负责处理调用 —
 * 因此握手加速从不牺牲原有的回退到直接模式的健壮性。
 */
export async function runLocalHandshakeProxy(deps: LocalHandshakeDeps): Promise<void> {
  let daemonStatus: 'connecting' | 'ready' | 'failed' = 'connecting';
  let daemonSocket: net.Socket | null = null;
  let clientInitId: unknown = undefined;   // 抑制守护进程对转发的 initialize 的回复
  // 仅用于进程内回退的遥测归因 — 路由到守护进程的调用由守护进程自己的会话计数
  // （接收转发的 initialize，含 clientInfo），在此处永不重复计数。
  let telemetryClient: ClientInfo | undefined;
  const pending: string[] = [];            // 守护进程 resolve 前缓冲的客户端行
  let engine: MCPEngine | null = null;
  let engineReady: Promise<void> | null = null;
  let shuttingDown = false;
  // 转发到守护进程但尚未收到答复的请求，以 JSON-RPC id 为键。
  // 如果守护进程在会话中途消失（#662 — 例如 MCP 宿主在新会话启动时 SIGTERM 它），
  // 这些请求否则会永久挂起；我们在进程内重新响应，确保宿主始终收到回复。
  const inflight = new Map<unknown, string>();
  const trackInflight = (line: string): void => {
    try {
      const m = JSON.parse(line) as JsonRpc;
      if (m && m.id !== undefined && typeof m.method === 'string' && m.method !== 'initialize') {
        inflight.set(m.id, line);
      }
    } catch { /* unparseable — nothing we could re-serve anyway */ }
  };

  const writeClient = (obj: JsonRpc | string): void => {
    try { process.stdout.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n'); } catch { /* host gone */ }
  };
  const shutdown = (): void => {
    if (shuttingDown) return; shuttingDown = true;
    try { daemonSocket?.destroy(); } catch { /* ignore */ }
    try { engine?.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  const ensureEngine = (): Promise<void> => {
    if (!engine) engine = deps.makeEngine();
    if (!engineReady) engineReady = engine.ensureInitialized(deps.root).catch(() => { /* degraded */ });
    return engineReady;
  };
  // Daemon-unavailable fallback: serve a client message in-process.
  const handleLocally = async (line: string): Promise<void> => {
    let msg: JsonRpc; try { msg = JSON.parse(line) as JsonRpc; } catch { return; }
    const id = msg.id;
    if (msg.method === 'tools/call' && id !== undefined) {
      try {
        await ensureEngine();
        const params = (msg.params || {}) as { name: string; arguments?: Record<string, unknown> };
        const result = await engine!.getToolHandler().execute(params.name, params.arguments || {});
        writeClient({ jsonrpc: '2.0', id, result });
        getTelemetry().recordUsage('mcp_tool', params.name, !result.isError, telemetryClient);
      } catch (err) {
        writeClient({ jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
      }
    } else if (msg.method === 'ping' && id !== undefined) {
      writeClient({ jsonrpc: '2.0', id, result: {} });
    } else if (id !== undefined && msg.method !== 'initialize') {
      // 无法在进程内响应的请求（且守护进程已消失）— 返回错误而非让宿主
      // 等待一个永不会来的回复。
      writeClient({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Synapse daemon unavailable' } });
    }
    // initialize 已在本地响应；通知（initialized）不需要回复。
  };
  const routeToDaemon = (line: string): void => {
    if (daemonStatus === 'ready' && daemonSocket) {
      trackInflight(line);
      try { daemonSocket.write(line.endsWith('\n') ? line : line + '\n'); } catch { /* close path */ }
    } else if (daemonStatus === 'failed') {
      void handleLocally(line);
    } else {
      pending.push(line);
    }
  };

  // ---- client (stdin) ----
  let stdinBuf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    stdinBuf += chunk;
    let idx: number;
    while ((idx = stdinBuf.indexOf('\n')) !== -1) {
      const line = stdinBuf.slice(0, idx).trim();
      stdinBuf = stdinBuf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpc; try { msg = JSON.parse(line) as JsonRpc; } catch { routeToDaemon(line); continue; }
      if (msg.method === 'initialize') {
        clientInitId = msg.id;
        const initParams = (msg.params ?? {}) as { clientInfo?: { name?: unknown; version?: unknown } };
        if (initParams.clientInfo) {
          telemetryClient = {
            name: typeof initParams.clientInfo.name === 'string' ? initParams.clientInfo.name : undefined,
            version: typeof initParams.clientInfo.version === 'string' ? initParams.clientInfo.version : undefined,
          };
        }
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS } });
        routeToDaemon(line); // prime the daemon so it resolves the project (its reply is suppressed below)
      } else if (msg.method === 'tools/list') {
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { tools: getStaticTools() } });
      } else if (msg.method === 'resources/list') {
        // 不暴露任何资源 — 在本地响应探测，以防它作为未处理方法到达守护进程并记录 `-32601`。(#621)
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { resources: [] } });
      } else if (msg.method === 'resources/templates/list') {
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { resourceTemplates: [] } });
      } else if (msg.method === 'prompts/list') {
        writeClient({ jsonrpc: '2.0', id: msg.id, result: { prompts: [] } });
      } else {
        routeToDaemon(line);
      }
    }
  });
  // 当 stdin 结束/关闭时关闭 — 同样监听 stdin `'error'`，
  // socket 后端的 stdin（VS Code stdio 形式）在客户端死亡时可能发出此事件
  // 而非干净的关闭；销毁流可防止挂起的 fd 忙自旋事件循环（#799）。
  treatStdinFailureAsShutdown(shutdown);
  startPpidWatchdogNoSocket(shutdown);

  // ---- daemon connection (background) ----
  let socket: net.Socket | null = null;
  try { socket = await deps.getDaemonSocket(); } catch { socket = null; }

  if (socket && !shuttingDown) {
    daemonSocket = socket;
    daemonStatus = 'ready';
    let sockBuf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      sockBuf += chunk;
      let idx: number;
      while ((idx = sockBuf.indexOf('\n')) !== -1) {
        const line = sockBuf.slice(0, idx);
        sockBuf = sockBuf.slice(idx + 1);
        if (!line.trim()) continue;
        let resp: JsonRpc | null = null;
        try { resp = JSON.parse(line) as JsonRpc; } catch { /* not JSON — relay verbatim */ }
        if (resp && resp.id !== undefined && ('result' in resp || 'error' in resp)) {
          inflight.delete(resp.id); // 已响应 — 不再进行中
          // 抑制守护进程对我们转发的用于初始化它的 initialize 的回复
          // （客户端已收到本地握手响应）。
          if (clientInitId !== undefined && resp.id === clientInitId) continue;
        }
        writeClient(line);
      }
    });
    // 守护进程消失不会结束会话（#662）。MCP 宿主可能在另一个会话启动时
    // SIGTERM 共享守护进程；如果我们在此退出，该宿主会静默地失去 Synapse，
    // 所有进行中的请求都会挂起。改为回退到进程内引擎服务本会话剩余请求，
    // 并重新响应守护进程未完成的请求。
    const onDaemonLost = (): void => {
      if (shuttingDown || daemonStatus !== 'ready') return; // 宿主正在拆解，或已处理
      daemonStatus = 'failed';
      try { daemonSocket?.destroy(); } catch { /* ignore */ }
      daemonSocket = null;
      process.stderr.write(
        `[Synapse MCP] Shared daemon connection lost; serving this session in-process (degraded), re-serving ${inflight.size} in-flight request(s).\n`
      );
      const orphaned = [...inflight.values()];
      inflight.clear();
      for (const line of orphaned) void handleLocally(line);
    };
    socket.on('close', onDaemonLost);
    socket.on('error', onDaemonLost);
    for (const line of pending) { trackInflight(line); try { socket.write(line + '\n'); } catch { /* ignore */ } }
    pending.length = 0;
  } else if (!shuttingDown) {
    daemonStatus = 'failed';
    process.stderr.write('[Synapse MCP] Shared daemon unavailable; serving this session in-process (degraded).\n');
    const buffered = pending.splice(0);
    for (const line of buffered) await handleLocally(line);
  }

  await new Promise<void>(() => { /* stdin keeps the loop alive; exit via shutdown() */ });
}

/** 本地握手代理的 PPID 看门狗 — 与 {@link startPpidWatchdog} 相同的 #277 逻辑，
 *  但没有 socket 可关闭（调用方的 shutdown 处理拆解）。 */
function startPpidWatchdogNoSocket(onDeath: () => void): void {
  const pollMs = parsePollMs(process.env.SYNAPSE_PPID_POLL_MS);
  if (pollMs <= 0) return;
  const originalPpid = process.ppid;
  const hostPpid = parseHostPpid(process.env[HOST_PPID_ENV]);
  const timer = setInterval(() => {
    const reason = supervisionLostReason({
      originalPpid,
      currentPpid: process.ppid,
      hostPpid,
      isAlive: isProcessAliveLocal,
    });
    if (reason) {
      process.stderr.write(`[Synapse MCP] Parent process exited (${reason}); shutting down.\n`);
      onDeath();
    }
  }, pollMs);
  timer.unref?.();
}

/**
 * 从 socket 读取一行 CRLF/LF 终止的 JSON，将其解析为守护进程 hello 并返回。
 * 限制为 {@link MAX_HELLO_LINE_BYTES}，防止恶意或损坏的对端导致 OOM。
 * 超时 3s — 正常的守护进程在 accept 后立即发送 hello。
 */
function readHelloLine(socket: net.Socket): Promise<DaemonHello> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      clearTimeout(timer);
    };
    const onData = (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx === -1) {
        if (buffer.length > MAX_HELLO_LINE_BYTES) {
          cleanup();
          reject(new Error('daemon hello line exceeded size limit'));
        }
        return;
      }
      const line = buffer.slice(0, idx);
      // Re-emit anything past the newline so the pipe-stage sees it.
      const tail = buffer.slice(idx + 1);
      cleanup();
      if (tail.length > 0) {
        // 通过 unshift 推回 — Node 的 net.Socket 在可读流上支持它。
        socket.unshift(tail);
      }
      try {
        const parsed = JSON.parse(line) as DaemonHello;
        if (typeof parsed.synapse !== 'string' || typeof parsed.pid !== 'number') {
          reject(new Error('daemon hello missing required fields'));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(new Error(`daemon hello not JSON: ${err instanceof Error ? err.message : String(err)}`));
      }
    };
    const onError = (err: Error) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error('daemon closed connection before hello')); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for daemon hello'));
    }, 3000);
    timer.unref?.();
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/**
 * 管道传输 stdin → socket 和 socket → stdout。在任一端关闭后 resolve，
 * 以便进程退出。注意：我们刻意不使用 `process.stdin.pipe(socket)`，
 * 因为 pipe 会将 'end' 传播到下游，如果 stdin 恰好提前结束，
 * 这会过早关闭 socket — MCP 规范允许它在重连间保持开放。
 */
function pipeUntilClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };

    process.stdin.on('data', (chunk) => {
      try { socket.write(chunk); } catch { /* socket may have errored — close path catches it */ }
    });
    process.stdin.on('end', () => {
      try { socket.end(); } catch { /* ignore */ }
      done();
    });
    // 'close' 和 'error' 都会触发拆解：socket 后端的 stdin 可能以
    // 'error'（ECONNRESET/hangup）而非干净的关闭结束；销毁它
    // 可防止挂起的 fd 忙自旋事件循环（#799）。
    const teardown = () => {
      try { process.stdin.destroy(); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
      done();
    };
    process.stdin.on('close', teardown);
    process.stdin.on('error', teardown);

    socket.on('data', (chunk) => {
      try { process.stdout.write(chunk); } catch { /* ignore */ }
    });
    socket.on('end', () => done());
    socket.on('close', () => done());
    socket.on('error', (err) => {
      process.stderr.write(`[Synapse MCP] daemon socket error: ${err.message}\n`);
      done();
    });
  });
}

/**
 * PPID 看门狗，镜像 `MCPServer.start` 中的看门狗 — 当 MCP 宿主
 * （或其代理的宿主，见 HOST_PPID_ENV）消失但未关闭 stdin 时终止代理。
 * Issue #277 记录了为何在 Linux 上不能依赖 stdin EOF：
 * 父进程可能被 SIGKILL，而重新挂载不会关闭管道。
 *
 * 代理的"终止"只是关闭 socket + process.exit — 没有 SQLite 或监视器需要清理，
 * 所以代价很低。
 */
function startPpidWatchdog(socket: net.Socket): void {
  const pollMs = parsePollMs(process.env.SYNAPSE_PPID_POLL_MS);
  if (pollMs <= 0) return;
  const originalPpid = process.ppid;
  const hostPpid = parseHostPpid(process.env[HOST_PPID_ENV]);
  const timer = setInterval(() => {
    const reason = supervisionLostReason({
      originalPpid,
      currentPpid: process.ppid,
      hostPpid,
      isAlive: isProcessAliveLocal,
    });
    if (reason) {
      process.stderr.write(`[Synapse MCP] Parent process exited (${reason}); shutting down.\n`);
      try { socket.destroy(); } catch { /* ignore */ }
      process.exit(0);
    }
  }, pollMs);
  timer.unref?.();
}

function parsePollMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PPID_POLL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_PPID_POLL_MS;
  if (parsed < 0) return DEFAULT_PPID_POLL_MS;
  return Math.floor(parsed);
}

function parseHostPpid(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 1) return null;
  return parsed;
}

function isProcessAliveLocal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EPERM') return true;
    return false;
  }
}
