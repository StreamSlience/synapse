/**
 * MCP JSON-RPC 传输层
 *
 * 两种传输方式共享相同的线路格式（换行符分隔的 JSON-RPC 2.0）：
 *
 * - `StdioTransport` — 原始传输方式；读写进程的 stdin/stdout。
 *   用于直连模式的 MCP 服务器。
 * - `SocketTransport` — 封装单个 `net.Socket`。用于共享守护进程
 *   架构（参见 {@link ./daemon}），通过每连接会话将多个 MCP 客户端
 *   多路复用到同一个 Synapse 实例上。
 *
 * 两者均实现 {@link JsonRpcTransport}，因此会话层协议逻辑
 *（initialize / tools/list / tools/call，以及服务器发起的 `roots/list`）
 * 与字节来源无关，完全一致。
 */

import * as readline from 'readline';
import type { Socket } from 'net';

/**
 * JSON-RPC 2.0 请求
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC 2.0 响应
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 错误
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * JSON-RPC 2.0 通知（无 id，不期望响应）
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// 标准 JSON-RPC 错误码
export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type MessageHandler = (message: JsonRpcRequest | JsonRpcNotification) => Promise<void>;

/**
 * 通用 JSON-RPC 传输接口——stdio 和 socket 载体的公共接口。
 * 会话层以下（initialize、工具分发等）的代码与此接口交互，
 * 而非与具体的传输类耦合。
 */
export interface JsonRpcTransport {
  start(handler: MessageHandler): void;
  stop(): void;
  send(response: JsonRpcResponse): void;
  notify(method: string, params?: unknown): void;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  sendResult(id: string | number, result: unknown): void;
  sendError(id: string | number | null, code: number, message: string, data?: unknown): void;
}

/**
 * 基于换行符分隔 JSON-RPC 2.0 的共享实现，支持任意 `Readable`/`Writable`
 * 流对。stdio 和 socket 传输均继承此类——两者的唯一区别在于
 * 接入哪对流，以及"关闭"事件如何传播回上层代码。
 */
abstract class LineBasedJsonRpcTransport implements JsonRpcTransport {
  protected messageHandler: MessageHandler | null = null;
  // 待处理的服务器主动发起的请求（例如 roots/list），以我们发送的 id 为键。
  // 客户端的响应会在此处匹配回来。
  protected pending = new Map<string | number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  protected nextRequestId = 1;
  protected stopped = false;

  abstract start(handler: MessageHandler): void;
  protected abstract write(line: string): void;
  protected abstract idPrefix(): string;
  abstract stop(): void;

  /**
   * 向客户端发送服务器主动请求并等待其响应。
   *
   * MCP 是双向的：服务器也可以向客户端发问。我们用此方法处理
   * `roots/list`——这是在客户端未在 `initialize` 中传递工作区根目录时，
   * 规范推荐的获取方式（参见 issue #196）。超时后拒绝，
   * 使调用方可以降级处理而非永久挂起。
   */
  request(method: string, params?: unknown, timeoutMs = 5000): Promise<unknown> {
    const id = `${this.idPrefix()}-${this.nextRequestId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for "${method}" response`));
      }, timeoutMs);
      // 不要让待处理的请求在关闭时阻止进程退出。
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  send(response: JsonRpcResponse): void {
    this.write(JSON.stringify(response));
  }

  notify(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.write(JSON.stringify(notification));
  }

  sendResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message, data } });
  }

  /**
   * 拒绝所有正在飞行中的服务器主动请求，使其等待方不会挂起。
   * 在子类的 `stop()` 中调用。
   */
  protected rejectPending(reason: string): void {
    for (const { reject } of this.pending.values()) {
      reject(new Error(reason));
    }
    this.pending.clear();
  }

  /**
   * 处理一行传入的 JSON。两种传输均将行内容传至此处。
   */
  protected async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.sendError(null, ErrorCodes.ParseError, 'Parse error: invalid JSON');
      return;
    }

    // 服务器主动请求的响应（有 id + result/error，无 method）。
    // 将其路由到等待中的请求方，而非消息处理器——
    // 此前这类消息因不含 method 字段而被当作"无效请求"丢弃。
    const obj = parsed as Record<string, unknown>;
    if (
      obj?.jsonrpc === '2.0' &&
      typeof obj.method !== 'string' &&
      'id' in obj &&
      ('result' in obj || 'error' in obj)
    ) {
      this.handleResponse(obj);
      return;
    }

    // 校验基本 JSON-RPC 结构
    if (!this.isValidMessage(parsed)) {
      this.sendError(null, ErrorCodes.InvalidRequest, 'Invalid Request: not a valid JSON-RPC 2.0 message');
      return;
    }

    if (this.messageHandler) {
      try {
        await this.messageHandler(parsed as JsonRpcRequest | JsonRpcNotification);
      } catch (err) {
        const message = parsed as JsonRpcRequest;
        if ('id' in message) {
          this.sendError(
            message.id,
            ErrorCodes.InternalError,
            `Internal error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }

  /**
   * 解析（或拒绝）与此响应 id 匹配的待处理服务器主动请求。
   * 未知 id 将被忽略——客户端可能回传我们从未发送的内容，
   * 或请求可能已超时。
   */
  private handleResponse(msg: Record<string, unknown>): void {
    const id = msg.id as string | number;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if ('error' in msg && msg.error) {
      const err = msg.error as { message?: string };
      pending.reject(new Error(err.message || 'Request failed'));
    } else {
      pending.resolve(msg.result);
    }
  }

  /**
   * 检查消息是否为有效的 JSON-RPC 2.0 消息
   */
  private isValidMessage(msg: unknown): boolean {
    if (typeof msg !== 'object' || msg === null) return false;
    const obj = msg as Record<string, unknown>;
    if (obj.jsonrpc !== '2.0') return false;
    if (typeof obj.method !== 'string') return false;
    return true;
  }
}

export interface StdioTransportOptions {
  /**
   * 若为 true，当 stdin 关闭时传输层调用 `process.exit(0)`。在共享守护进程
   * 模式下设为 `false`，此时 stdio "会话"只是多个客户端之一——
   * 断开它不应拖垮整个守护进程。默认值（true）与调用方所依赖的
   * 原始单进程行为一致。
   */
  exitOnClose?: boolean;
  /**
   * stdin 流关闭时触发的可选回调。守护进程用此来递减已连接客户端的引用计数。
   */
  onClose?: () => void;
}

/**
 * MCP 的 Stdio 传输
 *
 * 从 stdin 读取 JSON-RPC 消息并将响应写入 stdout。用于直连（单进程）
 * MCP 服务器路径，此时 MCP 宿主为每个会话启动一个服务器并通过
 * 子进程的 stdio 与其通信。在共享守护进程模式下也用于启动器的会话
 *（设置 `exitOnClose: false`），使守护进程存活于其启动器之外。
 */
export class StdioTransport extends LineBasedJsonRpcTransport {
  private rl: readline.Interface | null = null;
  private opts: Required<StdioTransportOptions>;

  constructor(opts: StdioTransportOptions = {}) {
    super();
    this.opts = {
      exitOnClose: opts.exitOnClose ?? true,
      onClose: opts.onClose ?? (() => { /* no-op */ }),
    };
  }

  start(handler: MessageHandler): void {
    this.messageHandler = handler;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    this.rl.on('line', async (line) => {
      await this.handleLine(line);
    });

    // readline 的 'close' 事件在 stdin 正常 EOF 时触发。但 socket 支撑的 stdin
    // （VS Code 的 stdio 形态）可能以 'error' 的形式失败（ECONNRESET/挂断），
    // readline 不会将其作为 'close' 暴露出来——不处理的话，它会上升至
    // 全局 uncaughtException 处理器（进程继续运行），使服务器成为孤儿进程，
    // 并在 Linux 上以 100% CPU 忙轮询 POLLHUP 的 fd（参见 #799）。
    // 将 'error' 也视为终止信号，并销毁 stdin，使 fd 脱离 epoll。
    let closed = false;
    const onStreamEnd = (): void => {
      if (closed) return;
      closed = true;
      try { process.stdin.destroy(); } catch { /* already gone */ }
      this.opts.onClose();
      if (this.opts.exitOnClose) {
        process.exit(0);
      }
    };
    this.rl.on('close', onStreamEnd);
    process.stdin.on('error', onStreamEnd);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectPending('Transport stopped');
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  protected write(line: string): void {
    process.stdout.write(line + '\n');
  }

  protected idPrefix(): string {
    return 'cg-srv';
  }
}

/**
 * MCP 守护进程会话的 Socket 传输。
 *
 * 封装单个 `net.Socket`（POSIX 上为 Unix 域 socket，Windows 上为命名管道）。
 * 每个已连接的 MCP 客户端对应一个实例。与 {@link StdioTransport} 不同，
 * `stop()` 和流关闭*不会*调用 `process.exit`——守护进程侧的会话结束
 * 不得拖垮整个守护进程。
 */
export class SocketTransport extends LineBasedJsonRpcTransport {
  private buffer = '';
  private closeHandlers: Array<() => void> = [];

  constructor(private socket: Socket, private prefix: string = 'cg-sock') {
    super();
  }

  /**
   * 注册一个回调，当 socket 从任意一侧关闭时恰好触发一次。
   * 守护进程用此来递减已连接客户端的引用计数。
   */
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  start(handler: MessageHandler): void {
    this.messageHandler = handler;

    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let idx;
      // 清空每一行完整内容；尾部片段留在缓冲区等待下一个数据块。
      // 处理器是异步的，但此处不使用 await——JSON-RPC 允许乱序响应，
      // 若在此处序列化会造成死锁：如果处理器发起了一个服务器主动请求，
      // 而响应需要*后续*行才能到达（例如 roots/list 处于 tools/call 中途）。
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        void this.handleLine(line);
      }
    });

    this.socket.on('close', () => this.handleSocketClose());
    this.socket.on('error', (err) => {
      // 不因一个损坏的管道而使守护进程崩溃；只关闭此连接。
      process.stderr.write(`[Synapse daemon] socket error: ${err.message}\n`);
      this.handleSocketClose();
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectPending('Transport stopped');
    if (!this.socket.destroyed) {
      this.socket.end();
      this.socket.destroy();
    }
  }

  /**
   * 直接向 socket 写入一行原始数据（此类不进行 JSON-RPC 组帧——
   * 由调用方生成行内容）。守护进程用此发送 JSON-RPC 流前的
   * hello/握手行。
   */
  writeRaw(line: string): void {
    if (!this.socket.destroyed) {
      this.socket.write(line.endsWith('\n') ? line : line + '\n');
    }
  }

  protected write(line: string): void {
    if (!this.socket.destroyed) {
      this.socket.write(line + '\n');
    }
  }

  protected idPrefix(): string {
    return this.prefix;
  }

  private handleSocketClose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.rejectPending('Socket closed');
    for (const h of this.closeHandlers) {
      try { h(); } catch { /* 绝不让关闭处理器拖垮守护进程 */ }
    }
    this.closeHandlers = [];
  }
}
