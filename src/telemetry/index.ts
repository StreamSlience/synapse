/**
 * 匿名使用遥测——客户端。
 *
 * 可收集内容的约定位于 docs/design/telemetry.md
 * （以及面向用户的 TELEMETRY.md）；执行该约定的摄取端点
 * 公开于 telemetry-worker/。本模块遵守四条不变式：
 *
 * 1. 零热路径开销：记录仅为内存中的计数递增。磁盘写入是进程退出时
 *    的一次微小同步追加（在 `process.exit()` 下也有效，`beforeExit` 不会触发）；
 *    网络发送在长期运行命令启动时按需触发、在守护进程间隔时触发、
 *    在 install/init 结束时有界等待，其他情况下均为触发后不等待。
 * 2. 零 stdout：stdio 是 MCP 协议通道。通知和调试输出仅写入 stderr。
 * 3. 关闭即关闭：禁用后，不记录、不发送、不开 socket——
 *    不存在"已退出"的心跳包。关闭遥测同时删除所有已缓冲但未发送的数据。
 * 4. 静默失败：离线、端点宕机、磁盘满——所有失败模式均静默处理，
 *    绝不重试循环，绝不向用户/智能体暴露错误。
 *
 * 使用计数在本地按天聚合；仅发送已*完成*的（UTC）天，
 * 因此流量随活跃机器数扩展，而非随工具调用次数扩展。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

export const TELEMETRY_ENDPOINT = 'https://telemetry.getsynapse.com/v1/events';
export const TELEMETRY_DOCS = 'https://github.com/colbymchenry/synapse/blob/main/TELEMETRY.md';

const SCHEMA_VERSION = 1;
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_EVENTS_PER_REQUEST = 100;
const DEFAULT_FLUSH_TIMEOUT_MS = 1500;
/** 崩溃的发送方声明的文件在此时间后合并回来。 */
const STALE_CLAIM_MS = 60 * 60_000;

export type UsageKind = 'mcp_tool' | 'cli_command';
export type LifecycleEvent = 'install' | 'index' | 'uninstall';

/** 粗粒度分桶——故意不收集精确计数。 */
export function bucketFileCount(n: number): '<100' | '100-1k' | '1k-10k' | '10k+' {
  if (n < 100) return '<100';
  if (n < 1000) return '100-1k';
  if (n < 10000) return '1k-10k';
  return '10k+';
}

export function bucketDuration(ms: number): '<10s' | '10-60s' | '1-5m' | '5m+' {
  if (ms < 10_000) return '<10s';
  if (ms < 60_000) return '10-60s';
  if (ms < 300_000) return '1-5m';
  return '5m+';
}

/** 将后端标识符（如 `node-sqlite`）折叠为 schema 的枚举值。 */
export function backendKind(backend: string): 'native' | 'wasm' {
  return backend.toLowerCase().includes('wasm') ? 'wasm' : 'native';
}

/**
 * 共享的"完整索引已完成"事件（CLI init/index + 安装器本地 init）：
 * 仅包含语言名称和粗粒度分桶——绝不包含路径、文件名或精确计数。
 * 结构化类型，调用方无需引入引擎模块。
 */
export function recordIndexEvent(
  cg: { getStats(): { filesByLanguage: Record<string, number> }; getBackend(): string },
  result: { filesIndexed: number; durationMs: number },
): void {
  try {
    const languages = Object.entries(cg.getStats().filesByLanguage)
      .filter(([, count]) => count > 0)
      .map(([lang]) => lang);
    getTelemetry().recordLifecycle('index', {
      languages,
      file_count_bucket: bucketFileCount(result.filesIndexed),
      duration_bucket: bucketDuration(result.durationMs),
      sqlite_backend: backendKind(cg.getBackend()),
    });
  } catch {
    /* telemetry must never break indexing */
  }
}

export interface ClientInfo {
  name?: string;
  version?: string;
}

interface ConfigFile {
  enabled: boolean;
  machine_id: string;
  consent_source: 'installer' | 'default-notice' | 'cli';
  first_run_notice_shown?: boolean;
  updated_at: string;
}

export interface TelemetryStatus {
  enabled: boolean;
  /** 决定当前状态的因素——与优先级顺序对应。 */
  decidedBy: 'DO_NOT_TRACK' | 'SYNAPSE_TELEMETRY' | 'config' | 'default';
  machineId: string | null;
  configPath: string;
}

/** 一条缓冲行：使用计数增量或生命周期事件。 */
interface CountLine {
  v: number;
  d: string; // UTC 日期 YYYY-MM-DD
  k: UsageKind;
  n: string;
  c: number; // 调用次数
  e: number; // 错误次数
  cn?: string; // 客户端名称（仅 mcp_tool）
  cv?: string; // 客户端版本
}
interface EventLine {
  v: number;
  ev: LifecycleEvent;
  ts: string;
  props: Record<string, unknown>;
}
type BufferLine = CountLine | EventLine;

export interface TelemetryOptions {
  /** 全局状态目录；默认为 ~/.synapse。测试中注入临时目录。 */
  dir?: string;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  stderr?: (line: string) => void;
  /** 测试中退出，以避免短生命周期实例在 process 'exit' 上堆积。 */
  installExitHook?: boolean;
}

// 进程级别唯一的 'exit' 监听器，用于所有实例（实际上是单例）——
// N 个实例不应意味着 N 个 process 监听器。
const exitInstances = new Set<Telemetry>();
let exitListenerRegistered = false;
function registerForExit(instance: Telemetry): void {
  exitInstances.add(instance);
  if (!exitListenerRegistered) {
    exitListenerRegistered = true;
    // 'exit' 在 process.exit() 下也会触发（与 beforeExit 不同）；处理函数必须
    // 是同步的——persistSync 只是一次小型文件写入。
    process.on('exit', () => {
      for (const i of exitInstances) i.persistSync();
    });
  }
}

export class Telemetry {
  private readonly dir: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;
  private readonly writeStderr: (line: string) => void;

  private counts = new Map<string, CountLine>();
  private events: EventLine[] = [];
  private readonly installExitHook: boolean;
  private exitHookInstalled = false;
  private configCache: ConfigFile | null | undefined; // undefined = not read yet
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(opts: TelemetryOptions = {}) {
    this.dir = opts.dir ?? path.join(os.homedir(), '.synapse');
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
    this.env = opts.env ?? process.env;
    this.writeStderr = opts.stderr ?? ((line) => process.stderr.write(line));
    this.installExitHook = opts.installExitHook ?? true;
  }

  // ---------------------------------------------------------------- 同意

  get configPath(): string {
    return path.join(this.dir, 'telemetry.json');
  }
  get queuePath(): string {
    return path.join(this.dir, 'telemetry-queue.jsonl');
  }

  /**
   * 解析顺序（首个匹配生效）——与 TELEMETRY.md 保持同步：
   * DO_NOT_TRACK=1 > SYNAPSE_TELEMETRY=0|1 > 存储的配置 > 默认开启。
   */
  getStatus(): TelemetryStatus {
    const config = this.readConfig();
    const machineId = config?.machine_id ?? null;
    const dnt = this.env.DO_NOT_TRACK;
    if (dnt !== undefined && dnt !== '' && dnt !== '0' && dnt.toLowerCase() !== 'false') {
      return { enabled: false, decidedBy: 'DO_NOT_TRACK', machineId, configPath: this.configPath };
    }
    const forced = this.env.SYNAPSE_TELEMETRY;
    if (forced !== undefined && forced !== '') {
      const on = forced !== '0' && forced.toLowerCase() !== 'false';
      return { enabled: on, decidedBy: 'SYNAPSE_TELEMETRY', machineId, configPath: this.configPath };
    }
    if (config) {
      return { enabled: config.enabled, decidedBy: 'config', machineId, configPath: this.configPath };
    }
    return { enabled: true, decidedBy: 'default', machineId, configPath: this.configPath };
  }

  isEnabled(): boolean {
    return this.getStatus().enabled;
  }

  /**
   * 持久化用户的显式选择（安装器开关或 `synapse telemetry on|off`）。
   * 关闭遥测时同时删除所有已缓冲但未发送的数据——关闭就是关闭。
   */
  setEnabled(enabled: boolean, source: 'installer' | 'cli'): void {
    const existing = this.readConfig();
    this.writeConfig({
      enabled,
      machine_id: existing?.machine_id ?? randomUUID(),
      consent_source: source,
      first_run_notice_shown: true,
      updated_at: this.now().toISOString(),
    });
    if (!enabled) {
      try { fs.rmSync(this.queuePath, { force: true }); } catch { /* fail silent */ }
    }
  }

  /** 一旦任何同意决策（或首次运行通知）已写入磁盘，返回 true。 */
  hasStoredChoice(): boolean {
    return this.readConfig() !== null;
  }

  // -------------------------------------------------------------- 记录

  /** 内存中递增——在 MCP 工具调用热路径上安全使用。 */
  recordUsage(kind: UsageKind, name: string, ok: boolean, client?: ClientInfo): void {
    if (!this.isEnabled()) return;
    const day = this.utcDay();
    const cn = client?.name?.slice(0, 64);
    const cv = client?.version?.slice(0, 32);
    const key = [day, kind, name, cn ?? '', cv ?? ''].join(' ');
    const line = this.counts.get(key);
    if (line) {
      line.c += 1;
      if (!ok) line.e += 1;
    } else {
      const fresh: CountLine = { v: SCHEMA_VERSION, d: day, k: kind, n: name.slice(0, 64), c: 1, e: ok ? 0 : 1 };
      if (cn) fresh.cn = cn;
      if (cv) fresh.cv = cv;
      this.counts.set(key, fresh);
    }
    this.ensureExitHook();
  }

  /** install / index / uninstall——与其他内容一样缓冲。 */
  recordLifecycle(event: LifecycleEvent, props: Record<string, unknown>): void {
    if (!this.isEnabled()) return;
    this.events.push({ v: SCHEMA_VERSION, ev: event, ts: this.now().toISOString(), props });
    this.ensureExitHook();
  }

  // ---------------------------------------------------------------- 发送

  /**
   * 触发后不等待的发送，发送所有可发送内容。永不抛出，永不记录调试以上级别的日志。
   * 适合在长期运行命令启动时调用。
   */
  maybeFlush(): void {
    void this.flushNow().catch(() => { /* fail silent */ });
  }

  /**
   * 将内存状态刷入缓冲区，然后发送已完成天的汇总和生命周期事件。
   * 受 `timeoutMs` 限制；未发完的内容留在缓冲区等待下次进程处理。
   * 仅在延迟不可见的地方（install/init）才会被 await。
   */
  async flushNow(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      this.persistSync();
      this.recoverStaleClaims();
      const claim = this.claimQueue();
      if (!claim) return;
      const { claimPath, lines } = claim;
      const today = this.utcDay();
      const sendable: BufferLine[] = [];
      const keep: BufferLine[] = [];
      for (const line of lines) {
        if ('ev' in line) sendable.push(line);
        else if (line.d < today) sendable.push(line);
        else keep.push(line);
      }
      let failed: BufferLine[] = [];
      if (sendable.length > 0) {
        // 同意门控：一次性通知在第一批字节离开机器之前展示
      // （同时生成 machine id）。记录只在本地缓冲，保持静默——
      // 这样安装器可以在任何通知触发之前显示其显式同意开关，
      // 而不会被预操作使用计数抢先触发。
      // 安装器/CLI 的显式选择会设置 first_run_notice_shown，永久抑制此通知。
        this.firstRunNotice();
        failed = await this.send(sendable, timeoutMs);
      }
      // 未发出的内容返回队列（追加——持有声明期间其他写入方可能已创建新队列文件）。
      const back = [...failed, ...keep];
      if (back.length > 0) this.appendLines(back);
      try { fs.rmSync(claimPath, { force: true }); } catch { /* fail silent */ }
    } catch {
      /* fail silent */
    }
  }

  /**
   * 长期运行进程（MCP 守护进程/serve）的周期性刷新。
   * 已 unref，永不阻止进程退出。
   */
  startInterval(everyMs: number = 6 * 60 * 60_000): void {
    if (this.intervalHandle || !this.isEnabled()) return;
    this.maybeFlush();
    this.intervalHandle = setInterval(() => this.maybeFlush(), everyMs);
    this.intervalHandle.unref();
  }

  stopInterval(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  // -------------------------------------------------------------- 内部实现

  private utcDay(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private readConfig(): ConfigFile | null {
    if (this.configCache !== undefined) return this.configCache;
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as ConfigFile;
      this.configCache = typeof raw.machine_id === 'string' && typeof raw.enabled === 'boolean' ? raw : null;
    } catch {
      this.configCache = null;
    }
    return this.configCache;
  }

  private writeConfig(config: ConfigFile): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2) + '\n');
      this.configCache = config;
    } catch {
      /* fail silent */
    }
  }

  /**
   * 默认开启的同意由一次性 stderr 通知守卫
   * （交互式安装已显式记录选择，不会走到这里）。
   */
  private firstRunNotice(): void {
    const config = this.readConfig();
    if (config?.first_run_notice_shown) return;
    if (!config) {
      this.writeConfig({
        enabled: true,
        machine_id: randomUUID(),
        consent_source: 'default-notice',
        first_run_notice_shown: true,
        updated_at: this.now().toISOString(),
      });
    } else {
      this.writeConfig({ ...config, first_run_notice_shown: true, updated_at: this.now().toISOString() });
    }
    this.writeStderr(
      `synapse collects anonymous usage stats (no code, paths, or names) — ` +
      `"synapse telemetry off" or SYNAPSE_TELEMETRY=0 disables. Details: ${TELEMETRY_DOCS}\n`,
    );
  }

  /**
   * 同步、微小、退出安全：将内存中的增量刷入 JSONL 队列。
   * 在 `process.on('exit')` 中运行，因此绝不能是异步或慢速操作。
   */
  persistSync(): void {
    if (this.counts.size === 0 && this.events.length === 0) return;
    const lines: BufferLine[] = [...this.counts.values(), ...this.events];
    this.counts.clear();
    this.events = [];
    // 在持久化时重新检查：进程中途执行 `synapse telemetry off` 时，
    // 不得让本次调用在退出时重新创建队列文件。
    if (!this.isEnabled()) return;
    this.appendLines(lines);
  }

  private appendLines(lines: BufferLine[]): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const payload = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
      // 限制缓冲区大小：优先丢弃最旧的行（遥测是尽力而为的——
      // 有界的磁盘用量比完整性更重要）。
      let existing = '';
      try { existing = fs.readFileSync(this.queuePath, 'utf8'); } catch { /* no queue yet */ }
      let combined = existing + payload;
      if (combined.length > MAX_BUFFER_BYTES) {
        combined = combined.slice(combined.length - MAX_BUFFER_BYTES);
        combined = combined.slice(combined.indexOf('\n') + 1); // drop the partial first line
      }
      fs.writeFileSync(this.queuePath, combined);
    } catch {
      /* fail silent */
    }
  }

  /**
   * 原子性地声明队列以便发送（重命名）。并发进程无法重复发送；
   * 发送中途崩溃会留下一个声明文件，`recoverStaleClaims` 在一小时后将其合并回来。
   */
  private claimQueue(): { claimPath: string; lines: BufferLine[] } | null {
    const claimPath = path.join(this.dir, `telemetry-queue.sending.${process.pid}.jsonl`);
    try {
      fs.renameSync(this.queuePath, claimPath);
    } catch {
      return null; // no queue, or another process just claimed it
    }
    const lines: BufferLine[] = [];
    try {
      for (const raw of fs.readFileSync(claimPath, 'utf8').split('\n')) {
        if (!raw.trim()) continue;
        try {
          const parsed = JSON.parse(raw) as BufferLine;
          if (parsed && typeof parsed === 'object' && parsed.v === SCHEMA_VERSION) lines.push(parsed);
        } catch {
          /* 跳过损坏的行 */
        }
      }
    } catch {
      /* unreadable claim — treat as empty; file removed by caller */
    }
    return { claimPath, lines };
  }

  private recoverStaleClaims(): void {
    try {
      const cutoff = this.now().getTime() - STALE_CLAIM_MS;
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.startsWith('telemetry-queue.sending.')) continue;
        const full = path.join(this.dir, name);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) {
            const content = fs.readFileSync(full, 'utf8');
            fs.rmSync(full, { force: true });
            if (content.trim()) fs.appendFileSync(this.queuePath, content.endsWith('\n') ? content : content + '\n');
          }
        } catch {
          /* fail silent */
        }
      }
    } catch {
      /* fail silent */
    }
  }

  /** 返回未能发出的行（用于重新入队）。 */
  private async send(lines: BufferLine[], timeoutMs: number): Promise<BufferLine[]> {
    const config = this.readConfig();
    if (!config) return [];
    const events = lines.map((line) =>
      'ev' in line
        ? { event: line.ev, ts: line.ts, props: line.props }
        : {
            event: 'usage_rollup',
            ts: `${line.d}T12:00:00.000Z`,
            props: {
              kind: line.k,
              name: line.n,
              count: line.c,
              error_count: line.e,
              ...(line.cn ? { client_name: line.cn } : {}),
              ...(line.cv ? { client_version: line.cv } : {}),
            },
          },
    );
    const envelope = {
      machine_id: config.machine_id,
      synapse_version: this.packageVersion(),
      os: process.platform,
      arch: process.arch,
      node_major: parseInt(process.versions.node.split('.')[0] ?? '0', 10),
      ci: this.env.CI !== undefined && this.env.CI !== '' && this.env.CI !== '0' && this.env.CI !== 'false',
      schema_version: SCHEMA_VERSION,
    };
    const endpoint = this.env.SYNAPSE_TELEMETRY_ENDPOINT || TELEMETRY_ENDPOINT;
    for (let i = 0; i < events.length; i += MAX_EVENTS_PER_REQUEST) {
      const chunk = events.slice(i, i + MAX_EVENTS_PER_REQUEST);
      const body = JSON.stringify({ ...envelope, events: chunk });
      this.debug(`POST ${endpoint} (${chunk.length} events)`);
      try {
        // 任何响应——204、4xx、任何内容——均为终态。不重试。
        await this.fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        this.debug(`send failed: ${String(err)}`);
        return lines.slice(i); // network failure: re-queue this chunk + the rest
      }
    }
    return [];
  }

  private packageVersion(): string {
    try {
      // dist/telemetry/index.js → ../../package.json（在 src/ 中通过 tsx 运行测试时布局相同）
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string };
      return pkg.version ?? '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  private ensureExitHook(): void {
    if (this.exitHookInstalled || !this.installExitHook) return;
    this.exitHookInstalled = true;
    registerForExit(this);
  }

  private debug(msg: string): void {
    if (this.env.SYNAPSE_TELEMETRY_DEBUG === '1') {
      this.writeStderr(`[synapse telemetry] ${msg}\n`);
    }
  }
}

// 进程级别单例——应用代码通过此访问；测试自行构造实例。
let singleton: Telemetry | null = null;

export function getTelemetry(): Telemetry {
  if (!singleton) singleton = new Telemetry();
  return singleton;
}
