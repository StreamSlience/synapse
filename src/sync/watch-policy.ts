/**
 * 监视策略
 *
 * 决定是否应为指定项目运行实时文件监视器。
 *
 * 原生递归 `fs.watch` 在 WSL2 的 `/mnt/*` 驱动器（通过 9p/drvfs 桥接暴露的 NTFS）
 * 上极慢：设置递归监视时需要遍历目录树，每次 readdir/stat 都要跨越 Windows 边界。
 * 在 MCP 服务器内，这会在启动时阻塞事件循环，时间足以超过宿主握手超时
 * （opencode 的 30 秒限制），导致工具始终无法出现。参见 issue #199。
 *
 * 此模块集中管理开/关决策，使监视器、MCP 服务器（用于诊断）和安装器保持一致。
 */

import * as fs from 'fs';
import { normalizePath } from '../utils';

let wslChecked = false;
let wslValue = false;

/**
 * 检测当前进程是否运行在 WSL（Windows Subsystem for Linux）下。
 * 结果在首次调用后缓存。
 *
 * 优先检查 WSL 特有的环境变量（无 I/O），若不存在则回退到读取
 * `/proc/version`，WSL 内核的该文件包含 "microsoft" 字样。
 */
export function detectWsl(): boolean {
  if (wslChecked) return wslValue;
  wslChecked = true;

  if (process.platform !== 'linux') {
    wslValue = false;
    return wslValue;
  }
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    wslValue = true;
    return wslValue;
  }
  try {
    const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
    wslValue = version.includes('microsoft') || version.includes('wsl');
  } catch {
    wslValue = false;
  }
  return wslValue;
}

/**
 * 对 `/mnt/c` 或 `/mnt/d/project` 等 WSL Windows 驱动器挂载点返回 true。
 * 故意只匹配单字母驱动器挂载，以避免将真正快速的 Linux 挂载（如 `/mnt/wsl/...`）误标。
 */
function isWindowsDriveMount(projectRoot: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(normalizePath(projectRoot));
}

/**
 * 可在测试中覆盖的输入项，使决策具有确定性，
 * 无需修改真实的环境变量或 `/proc/version`。
 */
export interface WatchProbe {
  /** 默认使用 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 默认使用 `detectWsl()` 的结果。 */
  isWsl?: boolean;
}

/**
 * 决定是否应为某个项目禁用文件监视器，并说明原因。
 *
 * 当应跳过监视时返回简短的人类可读原因，应正常运行时返回 `null`。
 *
 * 优先级（首个匹配生效）：
 *  1. `SYNAPSE_NO_WATCH=1`    → 关闭（显式退出始终优先）
 *  2. `SYNAPSE_FORCE_WATCH=1` → 开启（覆盖自动检测）
 *  3. WSL2 + `/mnt/*` 驱动器  → 关闭（递归 fs.watch 过慢；#199）
 */
export function watchDisabledReason(projectRoot: string, probe: WatchProbe = {}): string | null {
  const env = probe.env ?? process.env;

  if (env.SYNAPSE_NO_WATCH === '1') {
    return 'SYNAPSE_NO_WATCH=1 is set';
  }
  if (env.SYNAPSE_FORCE_WATCH === '1') {
    return null;
  }

  const isWsl = probe.isWsl ?? detectWsl();
  if (isWsl && isWindowsDriveMount(projectRoot)) {
    return 'project is on a WSL2 /mnt/ drive, where recursive fs.watch is too slow to be reliable';
  }

  return null;
}

/** 仅供测试：重置已缓存的 WSL 检测结果。 */
export function __resetWslCacheForTests(): void {
  wslChecked = false;
  wslValue = false;
}
