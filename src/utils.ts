/**
 * Synapse 工具函数
 *
 * 用于内存管理、并发控制、批处理和安全校验的通用工具函数。
 *
 * @module utils
 *
 * @example
 * ```typescript
 * import { Mutex, processInBatches, MemoryMonitor, validatePathWithinRoot } from 'synapse';
 *
 * // 使用 mutex 保证并发安全
 * const mutex = new Mutex();
 * await mutex.withLock(async () => {
 *   await performCriticalOperation();
 * });
 *
 * // 批量处理条目以管理内存
 * const results = await processInBatches(items, 100, async (item) => {
 *   return await processItem(item);
 * });
 *
 * // 监控内存使用
 * const monitor = new MemoryMonitor(512, (usage) => {
 *   console.warn(`内存使用超过 512MB：${usage / 1024 / 1024}MB`);
 * });
 * monitor.start();
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================
// 安全工具函数
// ============================================================

/**
 * 不应用作项目根目录的敏感系统目录。
 * 在所有平台上检查；不适用的路径会被无害地跳过。
 */
const SENSITIVE_PATHS = new Set([
  '/', '/etc', '/usr', '/bin', '/sbin', '/var', '/tmp', '/dev', '/proc', '/sys',
  '/root', '/boot', '/lib', '/lib64', '/opt',
  'c:\\', 'c:\\windows', 'c:\\windows\\system32',
]);

/**
 * 来自配置"语言"的节点，是从配置文件中提取的纯键/值数据
 * （例如 Spring `application.{yml,properties}`），而非源代码。
 */
export const CONFIG_LEAF_LANGUAGES: ReadonlySet<string> = new Set(['yaml', 'properties']);

/**
 * 配置叶节点是从纯配置/数据文件中提取的单个键——
 * 在 {@link CONFIG_LEAF_LANGUAGES} 语言中 `kind: 'constant'`。其磁盘上的行是
 * `key = <value>`，而该值通常是机密（DB 密码、API 密钥、带嵌入凭证的 JDBC URL）。
 * Synapse 必须只呈现键，绝不读取/返回值，否则会将机密未经提示地推入智能体上下文——
 * 解析不需要该值，真正需要它的智能体可以直接读取文件。(#383)
 */
export function isConfigLeafNode(node: { kind: string; language?: string }): boolean {
  return node.kind === 'constant' && !!node.language && CONFIG_LEAF_LANGUAGES.has(node.language);
}

/**
 * `child` 是否就是 `parent` 本身或位于其下方。在 Windows 上不区分大小写——
 * NTFS 不区分大小写，realpathSync 返回的大小写可能与词法根不同，
 * 否则会错误地拒绝一个合法文件。
 */
function isWithinDir(child: string, parent: string): boolean {
  let c = child;
  let p = parent;
  if (process.platform === 'win32') {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }
  return c === p || c.startsWith(p + path.sep);
}

/**
 * 校验文件路径是否在项目根目录内，同时解析符号链接。
 *
 * 两层检查：先做廉价的词法检查以捕获 `../` 路径遍历，
 * 再做 realpath 检查以捕获符号链接逃逸——即仓库内符号链接的
 * 逻辑路径在根目录内，但真实目标指向根目录外的情况（issue #527）。
 * 仍在根目录内的符号链接依然允许，因此合法的树内符号链接可以正常工作。
 * 两个内容服务读取汇聚点（synapse_node `includeCode`、synapse_explore source）
 * 都经过此处，因此这是防止根目录外文件内容泄露的关口。
 *
 * @param projectRoot - 项目根目录
 * @param filePath - 待校验的（相对或绝对）文件路径
 * @returns 解析后的绝对路径（存在时为 realpath），若逃出根目录则返回 null
 */
export function validatePathWithinRoot(projectRoot: string, filePath: string): string | null {
  const resolved = path.resolve(projectRoot, filePath);
  const normalizedRoot = path.resolve(projectRoot);

  // 1. 词法包含检查——廉价，可捕获 `../` 路径遍历。
  if (!isWithinDir(resolved, normalizedRoot)) {
    return null;
  }

  // 2. 感知符号链接的包含检查——在两侧解析符号链接后重新检查，
  //    以拒绝真实目标逃出根目录的仓库内符号链接。
  try {
    const realRoot = fs.realpathSync(normalizedRoot);
    const realResolved = fs.realpathSync(resolved);
    return isWithinDir(realResolved, realRoot) ? realResolved : null;
  } catch (err) {
    // ENOENT：路径尚不存在（即将写入的文件，或已删除文件的索引条目）——
    // 没有符号链接可跟随，词法检查已通过，因此允许词法路径。任何其他
    // 解析失败（ELOOP、EACCES 等）视为不安全 → 拒绝。
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return resolved;
    }
    return null;
  }
}

/**
 * 校验路径是否为安全的项目根目录。
 *
 * 拒绝敏感系统目录，并确保路径是真实存在的目录。
 * 在 MCP 和 API 入口点使用，以防止任意目录访问。
 *
 * @param dirPath - 待校验的路径
 * @returns 无效时返回错误信息，有效时返回 null
 */
export function validateProjectPath(dirPath: string): string | null {
  const resolved = path.resolve(dirPath);

  // 阻止敏感系统目录
  if (SENSITIVE_PATHS.has(resolved) || SENSITIVE_PATHS.has(resolved.toLowerCase())) {
    return `Refusing to operate on sensitive system directory: ${resolved}`;
  }

  // 同时阻止常见的敏感家目录子目录
  const homeDir = require('os').homedir();
  const sensitiveHomeDirs = ['.ssh', '.gnupg', '.aws', '.config'];
  for (const dir of sensitiveHomeDirs) {
    const sensitivePath = path.join(homeDir, dir);
    if (resolved === sensitivePath || resolved.startsWith(sensitivePath + path.sep)) {
      return `Refusing to operate on sensitive directory: ${resolved}`;
    }
  }

  // 验证它是真实目录
  try {
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      return `Path is not a directory: ${resolved}`;
    }
  } catch {
    return `Path does not exist or is not accessible: ${resolved}`;
  }

  return null;
}

/**
 * 安全解析 JSON，使用回退值。
 * 防止因数据库元数据损坏而崩溃。
 */
export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * 将数值夹在指定范围内。
 * 用于对 MCP 工具输入强制实施合理限制。
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * 将文件路径标准化为使用正斜杠。
 * 修正 Windows 反斜杠路径，使 glob 匹配保持一致。
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * 使用锁文件和 PID 跟踪的跨进程文件锁。
 *
 * 防止多个进程（例如 git hooks、CLI、MCP 服务器）
 * 同时向同一数据库写入。
 */
export class FileLock {
  private lockPath: string;
  private held = false;

  /** 超过此时间的锁无论 PID 状态如何都视为过期 */
  private static readonly STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 分钟

  constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  /**
   * 获取锁。若锁被另一个存活进程持有则抛出异常。
   */
  acquire(): void {
    // 检查现有锁
    if (fs.existsSync(this.lockPath)) {
      try {
        const content = fs.readFileSync(this.lockPath, 'utf-8').trim();
        const pid = parseInt(content, 10);
        const stat = fs.statSync(this.lockPath);
        const lockAge = Date.now() - stat.mtimeMs;

        // 将超时的锁视为过期，无论 PID 如何
        if (lockAge < FileLock.STALE_TIMEOUT_MS && !isNaN(pid) && this.isProcessAlive(pid)) {
          throw new Error(
            `Synapse database is locked by another process (PID ${pid}). ` +
            `If this is stale, run 'synapse unlock' or delete ${this.lockPath}`
          );
        }

        // 过期锁（进程已死亡或超时）——移除它
        fs.unlinkSync(this.lockPath);
      } catch (err) {
        if (err instanceof Error && err.message.includes('locked by another')) {
          throw err;
        }
        // 其他读取锁文件的错误——尝试删除它
        try { fs.unlinkSync(this.lockPath); } catch { /* ignore */ }
      }
    }

    // 使用排他创建标志将 PID 写入锁文件
    try {
      fs.writeFileSync(this.lockPath, String(process.pid), { flag: 'wx' });
      this.held = true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // 竞争条件：另一个进程在我们检查和写入之间抢占了锁
        throw new Error(
          'Synapse database is locked by another process. ' +
          `If this is stale, run 'synapse unlock' or delete ${this.lockPath}`
        );
      }
      throw err;
    }
  }

  /**
   * 释放锁
   */
  release(): void {
    if (!this.held) return;
    try {
      // 仅在仍归我们所有时移除（检查 PID）
      const content = fs.readFileSync(this.lockPath, 'utf-8').trim();
      if (parseInt(content, 10) === process.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // 锁文件已消失——没问题
    }
    this.held = false;
  }

  /**
   * 持锁执行函数
   */
  withLock<T>(fn: () => T): T {
    this.acquire();
    try {
      return fn();
    } finally {
      this.release();
    }
  }

  /**
   * 持锁执行异步函数
   */
  async withLockAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * 检查进程是否仍在运行
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 批量处理条目以管理内存
 *
 * @param items - 待处理的条目数组
 * @param batchSize - 每批的条目数
 * @param processor - 处理每个条目的函数
 * @param onBatchComplete - 每批完成后的可选回调
 * @returns 结果数组
 */
export async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T, index: number) => Promise<R>,
  onBatchComplete?: (completed: number, total: number) => void
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, Math.min(i + batchSize, items.length));
    const batchResults = await Promise.all(
      batch.map((item, idx) => processor(item, i + idx))
    );
    results.push(...batchResults);

    if (onBatchComplete) {
      onBatchComplete(Math.min(i + batchSize, items.length), items.length);
    }

    // 允许批次间进行 GC
    if (global.gc) {
      global.gc();
    }
  }

  return results;
}

/**
 * 用于防止并发操作的简单 mutex 锁
 */
export class Mutex {
  private locked = false;
  private waitQueue: Array<() => void> = [];

  /**
   * 获取锁
   *
   * @returns 完成后调用的释放函数
   */
  async acquire(): Promise<() => void> {
    while (this.locked) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }

    this.locked = true;

    return () => {
      this.locked = false;
      const next = this.waitQueue.shift();
      if (next) {
        next();
      }
    };
  }

  /**
   * 持锁执行函数
   */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * 检查锁当前是否被持有
   */
  isLocked(): boolean {
    return this.locked;
  }
}

/**
 * 大文件分块读取器
 *
 * 分块读取文件，避免将整个文件加载到内存中。
 */
export async function* readFileInChunks(
  filePath: string,
  chunkSize: number = 64 * 1024
): AsyncGenerator<string, void, undefined> {
  const fs = await import('fs');

  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(chunkSize);

  try {
    let bytesRead: number;
    while ((bytesRead = fs.readSync(fd, buffer, 0, chunkSize, null)) > 0) {
      yield buffer.toString('utf-8', 0, bytesRead);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 对函数进行防抖处理
 *
 * @param fn - 待防抖的函数
 * @param delay - 延迟时间（毫秒）
 * @returns 防抖后的函数
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * 对函数进行节流处理
 *
 * @param fn - 待节流的函数
 * @param limit - 两次调用之间的最短间隔时间（毫秒）
 * @returns 节流后的函数
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = limit - (now - lastCall);

    if (remaining <= 0) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      lastCall = now;
      fn(...args);
    } else if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        timeoutId = null;
        fn(...args);
      }, remaining);
    }
  };
}

/**
 * 估算对象的内存占用（粗略估计）
 *
 * @param obj - 待测量的对象
 * @returns 近似大小（字节）
 */
export function estimateSize(obj: unknown): number {
  const seen = new WeakSet();

  function sizeOf(value: unknown): number {
    if (value === null || value === undefined) {
      return 0;
    }

    switch (typeof value) {
      case 'boolean':
        return 4;
      case 'number':
        return 8;
      case 'string':
        return 2 * (value as string).length;
      case 'object':
        if (seen.has(value as object)) {
          return 0;
        }
        seen.add(value as object);

        if (Array.isArray(value)) {
          return value.reduce((acc: number, item) => acc + sizeOf(item), 0);
        }

        return Object.entries(value as object).reduce(
          (acc, [key, val]) => acc + sizeOf(key) + sizeOf(val),
          0
        );
      default:
        return 0;
    }
  }

  return sizeOf(obj);
}

/**
 * 用于在操作期间追踪内存使用的内存监控器
 */
export class MemoryMonitor {
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private peakUsage = 0;
  private threshold: number;
  private onThresholdExceeded?: (usage: number) => void;

  constructor(
    thresholdMB: number = 500,
    onThresholdExceeded?: (usage: number) => void
  ) {
    this.threshold = thresholdMB * 1024 * 1024;
    this.onThresholdExceeded = onThresholdExceeded;
  }

  /**
   * 开始监控内存使用
   */
  start(intervalMs: number = 1000): void {
    this.stop();
    this.peakUsage = 0;

    this.checkInterval = setInterval(() => {
      const usage = process.memoryUsage().heapUsed;
      if (usage > this.peakUsage) {
        this.peakUsage = usage;
      }
      if (usage > this.threshold && this.onThresholdExceeded) {
        this.onThresholdExceeded(usage);
      }
    }, intervalMs);
  }

  /**
   * 停止监控
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * 获取峰值内存使用量（字节）
   */
  getPeakUsage(): number {
    return this.peakUsage;
  }

  /**
   * 获取当前内存使用量（字节）
   */
  getCurrentUsage(): number {
    return process.memoryUsage().heapUsed;
  }
}
