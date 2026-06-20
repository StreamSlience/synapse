/**
 * MCP 单连接会话 — 通过单个 {@link JsonRpcTransport} 处理 JSON-RPC 协议
 * （initialize、tools/list、tools/call）。它只持有每个客户端的状态
 * （客户端请求的协议版本、是否声明了 `roots`、一次性 roots/list 锁存）；
 * 重量级资源（Synapse、文件监视器、ToolHandler）存放在共享的
 * {@link MCPEngine} 中，以便守护进程模式能将 N 个 inotify 集 / DB 句柄
 * 合并为一个。
 *
 * 状态机本身镜像了 `MCPServer` 在 issue #411 拆分之前内联执行的逻辑
 * — `__tests__/mcp-initialize.test.ts` 中相同的回归测试仍驱动此代码路径。
 */

import * as path from 'path';
import { JsonRpcRequest, JsonRpcNotification, JsonRpcTransport, ErrorCodes } from './transport';
import { MCPEngine } from './engine';
import { tools } from './tools';
import { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_UNINDEXED } from './server-instructions';
import { SynapsePackageVersion } from './version';
import { findNearestSynapseRoot } from '../directory';
import { getTelemetry, ClientInfo } from '../telemetry';

/**
 * MCP 服务器信息 — 保存在会话中，因为部分客户端会记录它。
 * 版本号追踪真实的包版本（原先硬编码为 '0.1.0'）。
 */
// 导出以便代理可以用与守护进程发送完全相同的 payload 在本地回应 `initialize`
// — 两条握手路径之间不会产生偏差。
export const SERVER_INFO = {
  name: 'synapse',
  version: SynapsePackageVersion,
};

/** MCP 协议版本（服务器声明的最新版本）。 */
export const PROTOCOL_VERSION = '2024-11-05';

/**
 * 等待客户端 `roots/list` 响应的超时时间，超时后回退到进程 cwd。
 */
const ROOTS_LIST_TIMEOUT_MS = 5000;

/**
 * 将 file:// URI 转换为文件系统路径。处理 URL 编码和 Windows 盘符路径。
 */
function fileUriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    let filePath = decodeURIComponent(url.pathname);
    if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }
    return path.resolve(filePath);
  } catch {
    return uri.replace(/^file:\/\/\/?/, '');
  }
}

/** 从 `roots/list` 结果中取第一个可用的文件系统路径，若无则返回 null。 */
function firstRootPath(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const roots = (result as { roots?: unknown }).roots;
  if (!Array.isArray(roots) || roots.length === 0) return null;
  const first = roots[0] as { uri?: unknown };
  if (typeof first?.uri !== 'string') return null;
  return fileUriToPath(first.uri);
}

export interface MCPSessionOptions {
  /**
   * 来自 `--path` CLI 标志的显式项目路径。设置后，会话将不再请求
   * 客户端的 `roots/list` — 我们已经知道项目在哪里。
   */
  explicitProjectPath?: string | null;
}

/**
 * 单个 MCP 客户端对服务器的视图。直接模式（stdio 启动）时每次新建一个，
 * 守护进程模式（socket 连接）时每个连接新建一个。
 */
export class MCPSession {
  private clientSupportsRoots = false;
  /** 来自 initialize 握手 — 将用量汇总归因到对应的智能体宿主。 */
  private clientInfo: ClientInfo | undefined;
  private rootsAttempted = false;
  private resolvePromise: Promise<void> | null = null;
  private explicitProjectPath: string | null;

  constructor(
    private transport: JsonRpcTransport,
    private engine: MCPEngine,
    opts: MCPSessionOptions = {},
  ) {
    this.explicitProjectPath = opts.explicitProjectPath ?? null;
  }

  /**
   * 开始处理来自传输层的消息。立即返回 —
   * 会话在传输层开放期间持续存在。
   */
  start(): void {
    this.transport.start(this.handleMessage.bind(this));
  }

  /**
   * 关闭会话。不会触碰引擎（引擎可能服务于其他会话），
   * 也不调用 `process.exit`（守护进程自行决定何时退出）。
   */
  stop(): void {
    this.transport.stop();
  }

  /** 底层传输层 — 暴露给守护进程侧的关闭钩子使用。 */
  getTransport(): JsonRpcTransport {
    return this.transport;
  }

  private async handleMessage(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    const isRequest = 'id' in message;
    switch (message.method) {
      case 'initialize':
        if (isRequest) await this.handleInitialize(message as JsonRpcRequest);
        break;
      case 'initialized':
        // 客户端已完成初始化的通知 — 无需任何操作。
        break;
      case 'tools/list':
        if (isRequest) await this.handleToolsList(message as JsonRpcRequest);
        break;
      case 'tools/call':
        if (isRequest) await this.handleToolsCall(message as JsonRpcRequest);
        break;
      case 'ping':
        if (isRequest) this.transport.sendResult((message as JsonRpcRequest).id, {});
        break;
      case 'resources/list':
        // 我们不暴露任何 MCP 资源，但部分客户端（opencode、Codex）会在连接时探测；
        // 返回空列表而不是 MethodNotFound 错误，以避免显示吓人的 `-32601` 日志行。(#621)
        if (isRequest) this.transport.sendResult((message as JsonRpcRequest).id, { resources: [] });
        break;
      case 'resources/templates/list':
        if (isRequest) this.transport.sendResult((message as JsonRpcRequest).id, { resourceTemplates: [] });
        break;
      case 'prompts/list':
        // 同上 — 不暴露任何 prompts，但干净地回应探测。(#621)
        if (isRequest) this.transport.sendResult((message as JsonRpcRequest).id, { prompts: [] });
        break;
      default:
        if (isRequest) {
          this.transport.sendError(
            (message as JsonRpcRequest).id,
            ErrorCodes.MethodNotFound,
            `Method not found: ${message.method}`,
          );
        }
    }
  }

  private async handleInitialize(request: JsonRpcRequest): Promise<void> {
    const params = request.params as {
      rootUri?: string;
      workspaceFolders?: Array<{ uri: string; name: string }>;
      capabilities?: { roots?: unknown };
      clientInfo?: { name?: unknown; version?: unknown };
    } | undefined;

    this.clientSupportsRoots = !!params?.capabilities?.roots;
    if (params?.clientInfo) {
      this.clientInfo = {
        name: typeof params.clientInfo.name === 'string' ? params.clientInfo.name : undefined,
        version: typeof params.clientInfo.version === 'string' ? params.clientInfo.version : undefined,
      };
    }

    // 显式项目信号，优先级从高到低：客户端提供的 rootUri /
    // workspaceFolders（LSP 风格），其次是服务器启动时的 --path。
    // 此处不使用 cwd — 我们推迟它，以便 roots/list 的答案
    // 能够覆盖它。参见 issue #196。
    let explicitPath: string | null = null;
    if (params?.rootUri) {
      explicitPath = fileUriToPath(params.rootUri);
    } else if (params?.workspaceFolders?.[0]?.uri) {
      explicitPath = fileUriToPath(params.workspaceFolders[0].uri);
    } else if (this.explicitProjectPath) {
      explicitPath = this.explicitProjectPath;
    }

    // 根据工作区的索引状态选择说明文字变体 — 一次廉价的同步向上遍历
    // （仅 existsSync 循环，不打开 DB，因此满足 #172 的快速响应约定）。
    // 未索引的工作区收到简短的"本次会话不活跃"提示，而非完整的使用手册：
    // 使用手册会告知智能体依赖那些全部会失败的工具，而早期失败会让智能体
    // 在整个会话中放弃 synapse。`tools/list` 以同样方式设门控（未索引时返回空列表）。
    // 当尚不知道显式路径时（roots/list 握手待处理），cwd 是预测默认项目
    // 解析位置的最佳方案 — 即使不匹配，最坏情况也只是乐观地返回完整使用手册，
    // 并由空工具列表兜底。
    const indexed = findNearestSynapseRoot(explicitPath ?? process.cwd()) !== null;

    // 在任何重量级初始化之前先响应握手 — 参见 issue #172。
    this.transport.sendResult(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: indexed ? SERVER_INSTRUCTIONS : SERVER_INSTRUCTIONS_UNINDEXED,
    });

    if (explicitPath) {
      // 在后台启动引擎初始化。如果同一守护进程中的另一个会话已经打开了该项目，
      // `ensureInitialized` 几乎是无操作 — N 个并发客户端只需一次打开。
      this.resolvePromise = this.engine.ensureInitialized(explicitPath);
    }
  }

  private async handleToolsList(request: JsonRpcRequest): Promise<void> {
    await this.retryInitIfNeeded();
    // 未索引的工作区返回空工具列表：缺席是智能体无法误读的唯一信号。
    // 列出 8 个全部失败的工具会浪费智能体的调用次数，并让它认为 synapse 坏了
    // （观察到：一两次早期 isError 响应后，智能体在整个会话中停止调用 synapse）。
    // 服务器启动后运行 `synapse init` 会在下次 tools/list 时被感知到
    // — retryInitIfNeeded 会重新遍历 — 尽管大多数宿主每次连接只请求一次列表。
    this.transport.sendResult(request.id, {
      tools: this.engine.hasDefaultSynapse() ? this.engine.getToolHandler().getTools() : [],
    });
  }

  private async handleToolsCall(request: JsonRpcRequest): Promise<void> {
    const params = request.params as {
      name: string;
      arguments?: Record<string, unknown>;
    };

    if (!params || !params.name) {
      this.transport.sendError(request.id, ErrorCodes.InvalidParams, 'Missing tool name');
      return;
    }

    const toolName = params.name;
    const toolArgs = params.arguments || {};

    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      this.transport.sendError(
        request.id,
        ErrorCodes.InvalidParams,
        `Unknown tool: ${toolName}`,
      );
      return;
    }

    await this.retryInitIfNeeded();

    const result = await this.engine.getToolHandler().execute(toolName, toolArgs);
    this.transport.sendResult(request.id, result);
    // 回复在线后 — 遥测绝不能延迟工具响应
    // （仅内存计数；参见 src/telemetry）。
    getTelemetry().recordUsage('mcp_tool', toolName, !result.isError, this.clientInfo);
  }

  /**
   * 惰性默认项目解析。三层逻辑：
   *   1. 等待来自 `handleInitialize` 发起的进行中初始化（如有）；
   *   2. 若仍未初始化且从未向客户端请求 roots，现在请求（一次性）；
   *      若客户端不支持 roots 则回退到 cwd；
   *   3. 最后手段：从最佳候选路径重新遍历 — 能感知到服务器启动后
   *      `synapse init` 的项目。
   */
  private async retryInitIfNeeded(): Promise<void> {
    if (this.resolvePromise) {
      try { await this.resolvePromise; } catch { /* fall through to retry */ }
      this.resolvePromise = null;
    }

    if (this.engine.hasDefaultSynapse()) return;

    const hint = this.explicitProjectPath ?? this.engine.getProjectPath();
    if (!hint && !this.rootsAttempted) {
      this.rootsAttempted = true;
      this.resolvePromise = this.clientSupportsRoots
        ? this.initFromRoots()
        : this.engine.ensureInitialized(process.cwd());
      try { await this.resolvePromise; } catch { /* fall through */ }
      this.resolvePromise = null;
      if (this.engine.hasDefaultSynapse()) return;
    }

    // 最后手段：从最佳候选路径遍历（同步打开）。能感知服务器启动后出现的项目。
    const candidate = hint ?? process.cwd();
    this.engine.retryInitializeSync(candidate);
  }

  /**
   * 通过 `roots/list` 向客户端请求其工作区根目录，并打开第一个。
   * 超时或收到空答案时回退到 `process.cwd()`。
   */
  private async initFromRoots(): Promise<void> {
    let target = process.cwd();
    try {
      const result = await this.transport.request('roots/list', undefined, ROOTS_LIST_TIMEOUT_MS);
      const rootPath = firstRootPath(result);
      if (rootPath) {
        target = rootPath;
      } else {
        process.stderr.write('[Synapse MCP] Client returned no workspace roots; falling back to process cwd.\n');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[Synapse MCP] roots/list request failed (${msg}); falling back to process cwd.\n`);
    }
    await this.engine.ensureInitialized(target);
  }
}
