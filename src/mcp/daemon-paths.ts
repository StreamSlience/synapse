/**
 * 守护进程 socket + 锁文件路径辅助函数 — issue #411。
 *
 * 每个项目根目录共享一个 `synapse serve --mcp` 守护进程，这意味着我们需要
 * 一个稳定的、以项目为键的会合点，供协作进程使用。IPC 的接口面只有两个文件路径：
 *
 *   - `daemon.sock` — 守护进程监听的 Unix 域 socket / 命名管道。
 *   - `daemon.pid` — 原子创建的锁文件，保存守护进程的 pid + 版本信息。
 *
 * 两者都存放在 `.synapse/` 下，因此项目范围的卸载（`synapse uninit`）
 * 可以顺带清理它们。
 *
 * 特殊情况：Unix 域 socket 路径有硬性长度限制（macOS 约 104，Linux 约 108）；
 * 当项目内路径超过该限制时，回退到 `os.tmpdir()` 下的绝对路径哈希。
 * pidfile 始终保存在项目内（无长度限制），并作为守护进程所选 socket 路径的
 * 权威指针。
 */

import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { getSynapseDir } from '../directory';

/** 项目内 socket 路径的软上限。 */
const POSIX_SOCKET_PATH_LIMIT = 100;

/** 项目根目录的简短稳定标识符 — 用于 tmpdir/管道名称。 */
function projectHash(projectRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

/**
 * 计算守护进程应监听（代理应连接）的 socket / 命名管道路径，以 `projectRoot` 为键。
 * 给定项目根目录时结果确定，因此独立进程无需协调即可汇聚到同一路径。
 */
export function getDaemonSocketPath(projectRoot: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\synapse-${projectHash(projectRoot)}`;
  }
  const inProject = path.join(getSynapseDir(projectRoot), 'daemon.sock');
  if (inProject.length <= POSIX_SOCKET_PATH_LIMIT) return inProject;
  // 超长的项目路径（深层 monorepo、Bazel 输出目录）需要回退到 tmpdir，
  // 否则 `bind` 会返回 EADDRINUSE / ENAMETOOLONG。哈希保证路径仍与项目绑定。
  return path.join(os.tmpdir(), `synapse-${projectHash(projectRoot)}.sock`);
}

/** `projectRoot` 对应的守护进程 pid 锁文件的绝对路径。 */
export function getDaemonPidPath(projectRoot: string): string {
  return path.join(getSynapseDir(projectRoot), 'daemon.pid');
}

/** pid 锁文件的结构化内容。 */
export interface DaemonLockInfo {
  pid: number;
  version: string;
  socketPath: string;
  startedAt: number;
}

/**
 * 将 {@link DaemonLockInfo} 序列化以写入 pidfile。使用 JSON 格式以便人工读取
 * — 运维人员调试时偶尔会 `cat` 该文件。
 */
export function encodeLockInfo(info: DaemonLockInfo): string {
  return JSON.stringify(info, null, 2) + '\n';
}

/**
 * 解析 pidfile 内容。对旧格式 pidfile（纯十进制 pid）具有容忍性，
 * 以防 0.10.x 守护进程遭遇 0.9.x 锁文件——此类锁文件被视为
 * "进程版本未知，拒绝共享"。
 */
export function decodeLockInfo(raw: string): DaemonLockInfo | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed.pid === 'number' &&
      typeof parsed.version === 'string' &&
      typeof parsed.socketPath === 'string' &&
      typeof parsed.startedAt === 'number'
    ) {
      return parsed as DaemonLockInfo;
    }
    return null;
  } catch {
    // 回退到旧版纯 pid 格式处理。
  }
  const pid = Number(trimmed);
  if (Number.isFinite(pid) && pid > 0) {
    return { pid, version: 'unknown', socketPath: '', startedAt: 0 };
  }
  return null;
}
