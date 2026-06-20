/**
 * 交互式守护进程管理器 — `synapse daemon` / `daemons` 背后的逻辑。
 *
 * 与 CLI（负责 @clack/prompts 接线）分开，是为了让选择/停止循环
 * 可以用假 `select` 进行单元测试：无需 TTY、无需 clack、无需真实守护进程。
 * CLI 会传入真实的 clack `select`/`isCancel` 以及注册表的 list/stop 函数。
 */
import * as path from 'path';
import type { DaemonRecord, StopResult } from './daemon-registry';

/** 哨兵选项值（不是真实根目录，因此不会与项目路径冲突）。 */
export const STOP_ALL = '__stop_all__';
export const CANCEL = '__cancel__';

export interface PickItem {
  value: string;
  label: string;
  hint?: string;
}

/** 紧凑运行时长：`45s`、`12m`、`3h 5m`。 */
export function formatUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * 构建有序的、可供 UI 使用的选项列表：当前项目的守护进程排在最前面
 * （作为自动选中的默认项），其余按最新优先排列，最后是"全部停止"
 * （仅当有多个时显示）和"取消"。
 */
export function buildPickItems(daemons: DaemonRecord[], cwdRoot: string | null, now: number): PickItem[] {
  const cwd = cwdRoot != null ? path.resolve(cwdRoot) : null;
  const ordered = [...daemons].sort((a, b) => {
    if (cwd) {
      const aCur = path.resolve(a.root) === cwd;
      const bCur = path.resolve(b.root) === cwd;
      if (aCur && !bCur) return -1;
      if (bCur && !aCur) return 1;
    }
    return b.startedAt - a.startedAt; // newest first
  });

  const items: PickItem[] = ordered.map((d) => {
    const current = cwd != null && path.resolve(d.root) === cwd;
    return {
      value: d.root,
      label: current ? `${d.root}  (current project)` : d.root,
      hint: `pid ${d.pid} · up ${formatUptime(now - d.startedAt)} · Running`,
    };
  });

  if (items.length > 1) items.push({ value: STOP_ALL, label: 'Stop all', hint: '' });
  items.push({ value: CANCEL, label: 'Cancel', hint: '' });
  return items;
}

export interface PickerDeps {
  list: () => DaemonRecord[];
  stop: (root: string) => Promise<StopResult>;
  stopAll: () => Promise<StopResult[]>;
  /** 当前项目守护进程的 realpath 根目录，若无则为 null。 */
  cwdRoot: string | null;
  now: () => number;
  /** 渲染选择器；返回所选值或取消哨兵。 */
  select: (opts: { message: string; options: PickItem[]; initialValue: string }) => Promise<unknown>;
  isCancel: (v: unknown) => boolean;
  /** 每次操作的提示（如"已停止守护进程 …"）。 */
  note: (msg: string) => void;
  /** 最终提示行 + 收尾（clack outro）。 */
  done: (msg: string) => void;
}

/**
 * 选择一个守护进程 → 停止它 → 用剩余的守护进程重新提示，直到用户取消
 * （Esc / Ctrl-C / "取消"）、选择"全部停止"或没有守护进程剩余。
 */
export async function runDaemonPicker(deps: PickerDeps): Promise<void> {
  for (;;) {
    const daemons = deps.list();
    if (daemons.length === 0) {
      deps.done('All daemons stopped.');
      return;
    }

    const items = buildPickItems(daemons, deps.cwdRoot, deps.now());
    const choice = await deps.select({
      message: 'Select a daemon to stop',
      options: items,
      initialValue: items[0]?.value ?? CANCEL, // daemons.length > 0 here, so items[0] is a daemon
    });

    if (deps.isCancel(choice) || choice === CANCEL) {
      deps.done('Cancelled.');
      return;
    }

    if (choice === STOP_ALL) {
      const results = await deps.stopAll();
      const n = results.filter((r) => r.outcome === 'term' || r.outcome === 'kill').length;
      deps.note(`Stopped ${n} daemon${n === 1 ? '' : 's'}.`);
      deps.done('Done.');
      return;
    }

    const result = await deps.stop(String(choice));
    const forced = result.outcome === 'kill' ? ', forced' : '';
    deps.note(`Stopped daemon (pid ${result.pid}${forced}) — ${choice}`);
    // 循环：下次迭代重新列出；若还有守护进程则重新提示，否则
    // 循环顶部的空检查会打印"所有守护进程已停止"。
  }
}
