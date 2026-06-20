/**
 * 全局守护进程注册表 + 停止/列出控制 — `synapse list` 和
 * `synapse stop [--all]` 背后的发现层。
 *
 * 每个项目守护进程已经在 `<root>/.synapse/daemon.pid` 写入了权威锁文件。
 * 这足以停止一个可以命名的守护进程，但没有一个中心位置可以找到所有守护进程
 * — 而 `list` 和 `stop --all` 需要这个能力。因此每个守护进程在启动时
 * 还会在 `~/.synapse/daemons/` 下写入一条小记录，并在优雅关闭时删除它。
 *
 * 注册表是一个发现索引，而不是事实来源：live pid 才是。
 * 被 SIGKILL 的守护进程无法删除自己的记录，因此读取方会修剪任何 pid 已死亡
 * 的记录（`isProcessAlive`）。每次写入/读取都是尽力而为的 — 注册表故障
 * 绝不能破坏守护进程或命令；最坏情况下 `list` 短暂地少列或多列一个，
 * 下次活跃性修剪会纠正。
 *
 * 跨平台设计：仅使用文件 + `process.kill(pid, signal)`，
 * 在 macOS/Linux（真实信号）和 Windows（映射到 TerminateProcess）上行为一致。
 * 已在三个平台上实际验证。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDaemonPidPath, getDaemonSocketPath, decodeLockInfo } from './daemon-paths';

export interface DaemonRecord {
  /** 守护进程所服务的项目根目录（已 realpath 处理）。 */
  root: string;
  pid: number;
  version: string;
  socketPath: string;
  /** 守护进程绑定其 socket 时的 Epoch 毫秒时间戳。 */
  startedAt: number;
}

/**
 * `~/.synapse/daemons` — 全局目录，以 home 安装目录为键。
 * （`SYNAPSE_DIR` 环境变量只重命名每个项目的索引目录，不影响此目录。）
 */
export function getRegistryDir(): string {
  return path.join(os.homedir(), '.synapse', 'daemons');
}

function recordPath(root: string): string {
  const hash = crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(getRegistryDir(), `${hash}.json`);
}

/**
 * `pid` 对应的进程是否存活？`kill(pid, 0)` 不发送信号 — 只探测：
 * ESRCH ⇒ 已死，EPERM ⇒ 存活但不属于我们（仍然存活）。
 * PPID 看门狗（#277）和守护进程锁仲裁使用相同的活跃性检查。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 尽力而为：注册此守护进程，以便 `list`/`stop --all` 能找到它。 */
export function registerDaemon(rec: DaemonRecord): void {
  try {
    fs.mkdirSync(getRegistryDir(), { recursive: true });
    fs.writeFileSync(recordPath(rec.root), JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  } catch {
    /* best-effort — list's liveness prune tolerates a missing record */
  }
}

/** 尽力而为：在优雅关闭时删除此守护进程的记录。 */
export function deregisterDaemon(root: string): void {
  try {
    fs.unlinkSync(recordPath(root));
  } catch {
    /* already gone */
  }
}

/**
 * 所有进程仍存活的已注册守护进程，最新的排在最前面。已死亡/垃圾记录
 * 作为副作用被删除（自我修复），除非 `prune` 为 false。
 */
export function listDaemons(opts: { prune?: boolean } = {}): DaemonRecord[] {
  const prune = opts.prune ?? true;
  const dir = getRegistryDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return []; // no registry dir yet
  }

  const live: DaemonRecord[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    let rec: DaemonRecord | null = null;
    try {
      rec = JSON.parse(fs.readFileSync(full, 'utf8')) as DaemonRecord;
    } catch {
      rec = null;
    }
    const valid = rec && typeof rec.pid === 'number' && typeof rec.root === 'string';
    if (valid && isProcessAlive(rec!.pid)) {
      live.push(rec!);
    } else if (prune) {
      try { fs.unlinkSync(full); } catch { /* ignore */ }
    }
  }
  return live.sort((a, b) => b.startedAt - a.startedAt);
}

/** 删除已停止守护进程遗留的锁文件 + socket + 注册表记录。 */
function cleanupDaemonArtifacts(root: string): void {
  try { fs.unlinkSync(getDaemonPidPath(root)); } catch { /* gone */ }
  // POSIX socket 是真实文件；Windows 命名管道随进程消失。
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(getDaemonSocketPath(root)); } catch { /* gone */ }
  }
  deregisterDaemon(root);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  return !isProcessAlive(pid);
}

export interface StopResult {
  root: string;
  pid: number | null;
  /** 'term' 优雅终止，'kill' 强制终止，'not-running' 锁文件已过期，'no-daemon' 未找到守护进程。 */
  outcome: 'term' | 'kill' | 'not-running' | 'no-daemon';
}

/**
 * 停止服务于 `root` 的守护进程：发送 SIGTERM，等待，若不退出则发送 SIGKILL，
 * 然后清理其遗留文件。`root` 必须经过 realpath 处理（与守护进程对 socket/锁文件的键方式一致）。
 * 从权威锁文件解析 pid，若无锁文件则回退到注册表。
 */
export async function stopDaemonAt(root: string): Promise<StopResult> {
  let pid: number | null = null;
  try {
    const info = decodeLockInfo(fs.readFileSync(getDaemonPidPath(root), 'utf8'));
    pid = info?.pid ?? null;
  } catch {
    /* no lockfile */
  }
  if (pid == null) {
    const rec = listDaemons({ prune: false }).find(
      (r) => path.resolve(r.root) === path.resolve(root)
    );
    pid = rec?.pid ?? null;
  }

  if (pid == null) {
    cleanupDaemonArtifacts(root);
    return { root, pid: null, outcome: 'no-daemon' };
  }
  if (!isProcessAlive(pid)) {
    cleanupDaemonArtifacts(root);
    return { root, pid, outcome: 'not-running' };
  }

  // POSIX：SIGTERM 触发守护进程的优雅关闭。Windows：TerminateProcess
  // （无优雅关闭路径），因此始终由我们在下方清理遗留文件。
  try { process.kill(pid, 'SIGTERM'); } catch { /* raced to exit */ }
  let outcome: StopResult['outcome'] = 'term';
  if (!(await waitForDeath(pid, 3000))) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* raced to exit */ }
    await waitForDeath(pid, 2000);
    outcome = 'kill';
  }
  cleanupDaemonArtifacts(root);
  return { root, pid, outcome };
}

/** 停止所有已注册且仍在运行的守护进程。 */
export async function stopAllDaemons(): Promise<StopResult[]> {
  const results: StopResult[] = [];
  for (const rec of listDaemons()) {
    results.push(await stopDaemonAt(rec.root));
  }
  return results;
}
