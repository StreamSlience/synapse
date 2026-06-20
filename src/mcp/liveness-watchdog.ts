/**
 * 主线程活跃性看门狗 — #850 的双重保险。
 *
 * #850 的修复移除了唯一*已知*的触发条件（未捕获异常处理器不再格式化原始 Error 的 `.stack`）。
 * 但主线程上任何同步、不让步的循环 — 未来的 V8 栈格式异常、失控的正则、意外的 `while (true)` —
 * 都会卡住事件循环，而在 JS 中无法中断它：定时器、信号处理器和 PPID 看门狗都运行*在*
 * 那个被阻塞的循环上，进程会永久占用一个 CPU 核心且无法自我恢复
 * （正是 #850 报告的那种不可恢复状态）。
 *
 * **为什么用独立进程而非 worker 线程。** Worker 线程是最初的明显选择，在玩具进程中也能工作 —
 * 但已在真实守护进程上验证其会*失败*（#850 实测）。同一进程中的 V8 隔离区在全局安全点上协调，
 * 因此当一个线程请求 GC 时，所有其他线程必须到达安全点才能继续。卡在紧密、无内存分配循环中的
 * 主线程永远到不了安全点，这会让看门狗 worker 在其下一次内存分配/安全点检查时卡死 —
 * 而 #850 的热循环（`SourcePositionTableIterator::Advance`，一个无内存分配的 C++ 表遍历）
 * 正是这种形态。子进程与父进程不共享隔离区和堆，因此卡死无法影响它；
 * 它通过内核发送 SIGKILL，内核会无视父进程线程的状态来执行。
 *
 * **机制。** 父进程每隔 `checkMs` 通过定时器向子进程的 stdin 写入一个心跳字节 —
 * 能触发就说明事件循环在运转。子进程在每次收到字节时重置一个终止定时器；
 * 如果在 `timeoutMs` 内没有收到任何字节，则 `SIGKILL` 父进程，以便下次连接时启动新的守护进程。
 * 父进程正常退出时管道关闭，子进程也随之退出（无孤儿进程）。
 *
 * **不会在正常工作时触发。** 繁重的解析在解析 worker（非主线程）中运行，
 * 索引则调用子进程，因此守护进程主线程只做快速、有界的工作。
 * 默认超时约为 #850 那次 5 小时卡死的 300 分之一，但远长于任何合理的主线程阻塞时间。
 * 用 `SYNAPSE_NO_WATCHDOG=1` 禁用；用 `SYNAPSE_WATCHDOG_TIMEOUT_MS` 调整。
 */
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';

/** 默认值：60s — 约为 #850 那次 5 小时卡死的 300 分之一，远长于任何真实的主线程阻塞。 */
export const DEFAULT_WATCHDOG_TIMEOUT_MS = 60_000;

/** `1/true/yes/on`（不区分大小写）时为 `true`；否则为 `false`。 */
function isEnvTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** 解析超时环境变量，对缺失/无效值回退到默认值。 */
export function parseWatchdogTimeoutMs(
  raw: string | undefined,
  fallback: number = DEFAULT_WATCHDOG_TIMEOUT_MS
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 推导一个在超时窗口内能发出若干次心跳的心跳间隔。 */
export function deriveCheckIntervalMs(timeoutMs: number): number {
  return Math.min(2000, Math.max(50, Math.round(timeoutMs / 5)));
}

/** 启动/拆解诊断信息，受现有 MCP 调试开关控制。 */
function debug(msg: string): void {
  if (process.env.SYNAPSE_MCP_DEBUG) {
    try { fs.writeSync(2, `[Synapse watchdog] ${msg}\n`); } catch { /* ignore */ }
  }
}

export interface WatchdogHandle {
  /** 停止心跳并关闭看门狗子进程。幂等。 */
  stop(): void;
}

/**
 * 看门狗子进程体，通过 `node -e` 运行。以字符串内联（而非打包的 `.js`），
 * 以避免需要解析 dist 与 src 的路径 — 在测试中的 `tsx` 和生产中的 bundle 下
 * 行为完全相同。从 argv 读取目标 pid 和超时；MSG 在启动时构建一次
 * （子进程不会卡死，所以此处的内存分配没问题）。
 */
const CHILD_SOURCE = `
const fs = require('fs');
const parentPid = Number(process.argv[1]);
const timeoutMs = Number(process.argv[2]);
const secs = Math.round(timeoutMs / 1000);
const MSG = Buffer.from('[Synapse] Main thread unresponsive for ~' + secs + 's — killing the wedged process so a fresh one can start (#850). Disable with SYNAPSE_NO_WATCHDOG=1.\\n');
function kill() {
  try { fs.writeSync(2, MSG); } catch (e) {}
  try { process.kill(parentPid, 'SIGKILL'); } catch (e) {}
  process.exit(0);
}
let timer = setTimeout(kill, timeoutMs);
process.stdin.on('data', () => { clearTimeout(timer); timer = setTimeout(kill, timeoutMs); });
process.stdin.on('end', () => process.exit(0));   // parent closed the pipe (exited) -> no orphan
process.stdin.on('error', () => process.exit(0)); // pipe broke -> parent gone
process.stdin.resume();
`;

/**
 * 为长期运行的进程安装主线程活跃性看门狗。返回一个用于停止它的句柄，
 * 或在已禁用或子进程无法派生时返回 `null`
 * （降级运行，永不抛出异常 — 缺少看门狗绝不能阻止进程启动）。
 */
export function installMainThreadWatchdog(): WatchdogHandle | null {
  if (isEnvTruthy(process.env.SYNAPSE_NO_WATCHDOG)) return null;

  const timeoutMs = parseWatchdogTimeoutMs(process.env.SYNAPSE_WATCHDOG_TIMEOUT_MS);
  const checkMs = deriveCheckIntervalMs(timeoutMs);

  let child: ChildProcess;
  try {
    // 不继承 execArgv（不同于 Worker），所以子进程不携带我们的 V8 标志 —
    // 它不运行 WASM 也不需要。stderr 继承父进程的 fd 2，
    // 使终止通知输出到父进程记录日志的地方（daemon.log）。
    child = spawn(
      process.execPath,
      ['-e', CHILD_SOURCE, String(process.pid), String(timeoutMs)],
      {
        stdio: ['pipe', 'ignore', 'inherit'],
        windowsHide: true,
        // 看门狗不触碰任何文件；将其 cwd 设在项目/临时目录之外，
        // 以防它持有目录句柄（Windows EPERM-on-cleanup，与
        // parse-worker 的问题类似）。
        cwd: os.tmpdir(),
      }
    );
  } catch (err) {
    debug(`spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  const stdin = child.stdin;
  if (!stdin) {
    debug('child has no stdin pipe; not arming');
    try { child.kill(); } catch { /* ignore */ }
    return null;
  }
  // 子进程退出后向其写入会在流上触发 EPIPE — 吞掉它，
  // 以防升级到全局处理器（现在会退出，#850）。
  stdin.on('error', () => { /* child gone; heartbeat writes are best-effort */ });
  child.on('error', (err) => debug(`child error: ${err.message}`));

  // 心跳：每个滴答写入一个字节。当主线程卡死时，这些心跳停止，
  // 子进程的超时触发。unref 使其不会让进程在工作结束后继续存活。
  const heartbeat = setInterval(() => {
    try { stdin.write('\n'); } catch { /* child gone */ }
  }, checkMs);
  heartbeat.unref();

  // 子进程及其管道都不应让父进程在工作结束后继续存活。
  child.unref();
  try { (stdin as unknown as { unref?: () => void }).unref?.(); } catch { /* ignore */ }

  debug(`armed (child pid ${child.pid ?? '?'}): timeoutMs=${timeoutMs} checkMs=${checkMs}`);

  let stopped = false;
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      try { stdin.end(); } catch { /* ignore */ } // EOF -> child exits cleanly
      try { child.kill(); } catch { /* ignore */ } // belt-and-suspenders
    },
  };
}
