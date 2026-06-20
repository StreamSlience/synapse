/**
 * WASM 运行时标志——V8 turboshaft WASM Zone OOM 问题的规避方案。
 *
 * tree-sitter grammar 是大型 WebAssembly 模块。在 Node >= 22 上，V8 的
 * "turboshaft" 优化型 WASM 编译器在后台线程编译这些 grammar 时，可能耗尽
 * 其 per-compilation Zone 竞技场，并以 `Fatal process out of memory: Zone`
 * 中止整个进程——即使系统仍有数十 GB 空闲内存，因为 Zone 是 V8 内部竞技场，
 * 而非 JS 堆。已在 Node 22 和 24 上复现；Node 25 因相同崩溃已被强制拦截
 * （参见 ../bin/node-version-check.ts）。见 issue #293 和 #298。
 *
 * `--liftoff-only` 强制所有 WASM 模块使用 Liftoff 基线编译器，从不运行
 * turboshaft，从而消除崩溃。解析结果完全正确；仅放弃了（边际收益且 grammar
 * 很少能达到的）优化层加速。
 *
 * 该标志必须位于 node 命令行上——它在引擎初始化时由 V8 读取，早于我们任何
 * JS 代码运行。实验验证（Node 24）以下方式均无效：
 *   - `v8.setFlagsFromString('--liftoff-only')` 运行时设置——太晚了。
 *   - Worker `execArgv: ['--liftoff-only']`——被拒绝（ERR_WORKER_INVALID_EXEC_ARGV）。
 *   - `NODE_OPTIONS=--liftoff-only`——不在 Node 的 NODE_OPTIONS 允许列表中。
 * 同样经实验验证，`--no-wasm-tier-up` / `--no-wasm-dynamic-tiering` 并不能
 * 阻止崩溃——只有完全禁用优化层才有效。
 *
 * 传递方式：打包启动器直接传递该标志（参见 scripts/build-bundle.sh 和
 * scripts/npm-shim.js）；对于其他启动路径（直接运行 dist、从源码运行等），
 * CLI 通过 {@link relaunchWithWasmRuntimeFlagsIfNeeded} 携带该标志重新执行
 * 一次自身。V8 标志是进程全局的，且 parse worker 以默认（继承的）execArgv
 * 创建，因此标记主进程即可控制 worker 的 WASM 编译。
 */
import { spawnSync } from 'child_process';

/**
 * 使 tree-sitter grammar 编译绕过 turboshaft 优化层的 V8 标志。
 * 唯一真实来源：重启守卫和测试套件均读取此值（测试会断言每个标志在当前
 * 运行时上是合法标志，因此重命名不会悄悄地回退该修复）。
 */
export const WASM_RUNTIME_FLAGS: readonly string[] = ['--liftoff-only'];

/**
 * 设置在重启后子进程上的环境变量，防止检测失误导致无限重执行循环。
 * 也允许用户强制禁用重启。
 */
const RELAUNCH_GUARD_ENV = 'SYNAPSE_WASM_RELAUNCHED';

/**
 * 跨重执行传递*宿主* PID（重启者自身的父进程）的环境变量。
 * 若不带 `--liftoff-only`，CLI 会重执行自身一次，在 MCP 宿主与服务器之间
 * 插入一个中间进程。该中间进程在宿主被杀死后仍会存活（阻塞在 spawnSync），
 * 因此服务器的 PPID 看门狗无法通过监视自身 `process.ppid` 来检测宿主的
 * 死亡。通过此变量传递宿主 PID，可让看门狗直接轮询它。
 * 在无需重执行的路径（打包启动器 / 标志已存在）上不设置此变量，
 * 此时服务器已是宿主的直接子进程。见 src/mcp/index.ts (#277)。
 */
export const HOST_PPID_ENV = 'SYNAPSE_HOST_PPID';

/** 当所有必需的 WASM 运行时标志已存在于 `execArgv` 中时返回 true。 */
export function processHasWasmRuntimeFlags(
  execArgv: readonly string[] = process.execArgv
): boolean {
  return WASM_RUNTIME_FLAGS.every((flag) => execArgv.includes(flag));
}

/**
 * 构建携带 WASM 运行时标志重新执行 node 的 argv：先是我们的标志，
 * 然后是 `execArgv` 中已有的 node 标志（去重），最后是脚本及其参数。
 * 纯函数——导出供单元测试使用。
 */
export function buildRelaunchArgv(
  scriptPath: string,
  scriptArgs: readonly string[],
  execArgv: readonly string[] = process.execArgv
): string[] {
  const preserved = execArgv.filter((arg) => !WASM_RUNTIME_FLAGS.includes(arg));
  return [...WASM_RUNTIME_FLAGS, ...preserved, scriptPath, ...scriptArgs];
}

/**
 * 若当前进程缺少 WASM 运行时标志，则携带这些标志重执行一次并以子进程的
 * 状态码退出。在以下情况下为空操作：标志已存在（正常的打包启动器路径）、
 * 已经重启过、或通过 SYNAPSE_NO_RELAUNCH 禁用。
 *
 * 若启动失败，则返回让调用方在当前进程中继续运行——冒 OOM 风险仍优于
 * 拒绝启动。
 */
export function relaunchWithWasmRuntimeFlagsIfNeeded(scriptPath: string): void {
  if (processHasWasmRuntimeFlags()) return;
  if (process.env[RELAUNCH_GUARD_ENV]) return;
  if (process.env.SYNAPSE_NO_RELAUNCH) return;

  const argv = buildRelaunchArgv(scriptPath, process.argv.slice(2));
  const result = spawnSync(process.execPath, argv, {
    stdio: 'inherit',
    env: { ...process.env, [RELAUNCH_GUARD_ENV]: '1', [HOST_PPID_ENV]: String(process.ppid) },
    windowsHide: true,
  });

  if (result.error) {
    // 无法重启（例如 execPath 不可用）——直接在当前进程中运行。
    // 功能降级（大型代码库可能 OOM），但不会完全中断。
    return;
  }
  process.exit(result.status ?? (result.signal ? 1 : 0));
}
