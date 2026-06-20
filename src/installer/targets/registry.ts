/**
 * 所有已知智能体 target 的注册表。
 *
 * 添加新 target = 创建 `targets/<id>.ts` 并导出 `AgentTarget`，
 * 然后在下方数组中添加一条记录。此处的顺序即为它们在多选提示、
 * `--target=all` 以及 `--print-config` 帮助列表中的显示顺序——保持稳定。
 */

import { AgentTarget, Location, TargetId } from './types';
import { claudeTarget } from './claude';
import { cursorTarget } from './cursor';
import { codexTarget } from './codex';
import { opencodeTarget } from './opencode';
import { hermesTarget } from './hermes';
import { geminiTarget } from './gemini';
import { antigravityTarget } from './antigravity';
import { kiroTarget } from './kiro';

export const ALL_TARGETS: readonly AgentTarget[] = Object.freeze([
  claudeTarget,
  cursorTarget,
  codexTarget,
  opencodeTarget,
  hermesTarget,
  geminiTarget,
  antigravityTarget,
  kiroTarget,
]);

export function getTarget(id: string): AgentTarget | undefined {
  return ALL_TARGETS.find((t) => t.id === id);
}

export function listTargetIds(): TargetId[] {
  return ALL_TARGETS.map((t) => t.id);
}

/**
 * 对注册表中每个 target 在给定位置运行 `detect()`。返回
 * 完整注册表与检测结果的压缩结果——编排器用此将已安装的
 * 智能体在多选提示中预先勾选。
 */
export function detectAll(loc: Location): Array<{
  target: AgentTarget;
  detection: ReturnType<AgentTarget['detect']>;
}> {
  return ALL_TARGETS.map((target) => ({
    target,
    detection: target.detect(loc),
  }));
}

/**
 * 将 `--target=` 标志值解析为 `AgentTarget` 实例列表。接受：
 *
 *   - `auto` — 返回所有 `detect().installed` 为 true 的 target，
 *     若无检测到则以 `['claude']` 作为回退（对现有用户影响最小）。
 *   - `all` — 注册表中的每个 target。
 *   - `none` — 空列表（调用方完全跳过智能体写入）。
 *   - csv 列表 — 如 `'claude,cursor'`。未知 id 会抛出异常。
 */
export function resolveTargetFlag(value: string, loc: Location): AgentTarget[] {
  if (value === 'none') return [];
  if (value === 'all') return [...ALL_TARGETS];
  if (value === 'auto') {
    const detected = detectAll(loc).filter(({ detection }) => detection.installed);
    if (detected.length > 0) return detected.map(({ target }) => target);
    const fallback = getTarget('claude');
    return fallback ? [fallback] : [];
  }

  const ids = value.split(',').map((s) => s.trim()).filter(Boolean);
  const resolved: AgentTarget[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const t = getTarget(id);
    if (t) resolved.push(t);
    else unknown.push(id);
  }
  if (unknown.length > 0) {
    const known = listTargetIds().join(', ');
    throw new Error(
      `Unknown --target id(s): ${unknown.join(', ')}. Known: ${known}, plus 'auto' / 'all' / 'none'.`,
    );
  }
  return resolved;
}
