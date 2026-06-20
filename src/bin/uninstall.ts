#!/usr/bin/env node
/**
 * Synapse 预卸载清理脚本
 *
 * 在调用 `npm uninstall -g @colbymchenry/synapse` 时自动运行。
 * 仅针对全局位置，遍历所有已知智能体 target 并调用其
 * `uninstall(loc)`——本地位置的条目存在于项目工作树中，
 * 不应在 npm 卸载时由我们删除。
 *
 * 本脚本绝不能抛出异常——清理失败不得阻塞卸载流程。
 */

try {
  // 懒加载，以防注册表模块级错误冒泡出来并中止 npm 卸载。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ALL_TARGETS } = require('../installer/targets/registry') as
    typeof import('../installer/targets/registry');

  for (const target of ALL_TARGETS) {
    if (!target.supportsLocation('global')) continue;
    try {
      target.uninstall('global');
    } catch {
      // 每个 target 均可独立跳过；单个 target 的失败不得中断循环。
    }
  }
} catch {
  // 如果注册表本身无法加载（例如部分安装），则静默跳过清理。卸载仍正常完成。
}
