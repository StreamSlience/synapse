/**
 * 未捕获异常和未处理 rejection 的最后兜底处理器。
 *
 * 走到这里，说明某个错误绕过了所有边界（MCP 传输层的逐请求
 * try/catch、文件监视器自身的 `'error'` 处理器、遥测的静默
 * 失败契约）——即进程已处于未定义状态。Node 默认行为是打印并
 * 以非零退出码退出。CLI 以前将其覆盖为"记录错误并继续运行"，
 * 正是这个做法引发了两起生产事故：
 *
 *   - #799 — 一个 stdin socket `'error'` 升级到了这里；服务器记录
 *     后继续运行，孤立了已分离的 MCP 守护进程，并（在 Linux 上）
 *     让一个 POLLHUP fd 以 100% CPU 空转。该触发路径已通过将
 *     stdin 失败视为关闭来修复（`src/mcp/stdin-teardown.ts`）。
 *   - #850 — 另一个未捕获异常命中了同一处理器。记录日志迫使 V8
 *     惰性格式化 Error 的 `.stack`，从而进入一个不终止的源码位置
 *     遍历，并钉死一个核心。由于处理器让进程保持存活，已分离的
 *     守护进程被卡住：其 PPID 看门狗和空闲计时器（均为
 *     `setInterval`）无法再触发，也没有任何东西重新启动它——不
 *     手动 `kill` 就无法恢复。
 *
 * 修复方案恢复了安全默认值：记录一行有界、防挂起的日志，然后
 * 以非零退出码退出，以便在下次连接时启动新的守护进程。
 *
 * 以下两个属性是核心保证，并有测试覆盖：
 *   1. {@link describeFatal} 绝不读取 `error.stack`，也绝不将原始
 *      Error 传给 `console.*`。惰性 stack getter 正是可能卡住的步骤
 *      （#850）；若在此处理器内触碰它，可能会阻塞下方的 `exit()`。
 *      name 和 message 是普通字符串属性，始终安全。
 *   2. 我们同步写入 fd 2 然后退出，因此即使 `process.exit()` 不会
 *      排空异步流，消息也能被刷出。
 */
import * as fs from 'fs';

/**
 * 将未捕获的值渲染为最后兜底日志，不触发栈格式化。
 * 纯函数且完全——永不抛出，永不触碰 `.stack`。
 */
export function describeFatal(value: unknown): string {
  if (value instanceof Error) {
    const name = typeof value.name === 'string' && value.name ? value.name : 'Error';
    // `message` 是普通的自有/原型字符串属性——读取它不会
    // 格式化栈（那才是可能无限循环的地方，#850）。
    const message = typeof value.message === 'string' ? value.message : '';
    return message ? `${name}: ${message}` : name;
  }
  try {
    return String(value);
  } catch {
    // 例如，一个 `toString` / `Symbol.toPrimitive` 会抛出的对象。
    return '<unstringifiable value>';
  }
}

/** 尽力同步写入 stderr，永远不会让一个注定退出的进程保持存活。 */
function writeStderr(line: string): void {
  try {
    fs.writeSync(2, line);
  } catch {
    /* stderr 已关闭或不可用——没有更多可以安全做的事了 */
  }
}

/** 可注入的接缝，使连接逻辑可在不注册真实处理器的情况下进行测试。 */
export interface FatalHandlerDeps {
  /** 要绑定的事件目标，默认为 `process`。 */
  target?: NodeJS.EventEmitter;
  /** 终止方式，默认为 `process.exit`。 */
  exit?: (code: number) => void;
  /** 输出有界日志行的方式，默认为同步写入 fd 2。 */
  write?: (line: string) => void;
}

/**
 * 安装未捕获异常 / 未处理 rejection 的处理器。两者均记录一行
 * 有界日志，然后以非零退出码退出（与 Node 默认致命语义一致）。
 */
export function installFatalHandlers(deps: FatalHandlerDeps = {}): void {
  const target = deps.target ?? process;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const write = deps.write ?? writeStderr;

  target.on('uncaughtException', (error: unknown) => {
    write(`[Synapse] Uncaught exception: ${describeFatal(error)}\n`);
    exit(1);
  });

  target.on('unhandledRejection', (reason: unknown) => {
    write(`[Synapse] Unhandled rejection: ${describeFatal(reason)}\n`);
    exit(1);
  });
}
