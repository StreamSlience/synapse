/**
 * Node.js 版本兼容性检查。
 *
 * Node 25.x 存在一个 V8 turboshaft WASM JIT Zone 分配器 bug，
 * 在 tree-sitter 语法编译期间会稳定地以 `Fatal process out of memory: Zone`
 * 崩溃 Synapse。本模块负责在退出前展示面向用户的提示横幅。
 * 保持无副作用，以便在测试中安全导入而不触发 CLI 引导流程。
 */

/**
 * 构建 Synapse 检测到不受支持的 Node.js 主版本（当前为 25+）时
 * 显示的带边框横幅。通过单元测试固定，以防未来的编辑静默删除
 * 恢复命令和覆盖说明。
 *
 * 使用 ASCII 字符，以确保在 Windows OEM 代码页控制台上可读
 * （原理见 ../ui/glyphs.ts）。
 */
export function buildNode25BlockBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  return [
    sep,
    `[Synapse] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    'Node.js 25.x has a V8 WASM JIT (turboshaft) Zone allocator bug that',
    'crashes with `Fatal process out of memory: Zone` when Synapse',
    'compiles tree-sitter grammars. Synapse WILL crash on this Node',
    'version mid-indexing. See https://github.com/colbymchenry/synapse/issues/81',
    '',
    'Fix: install Node.js 22 LTS:',
    '  nvm install 22 && nvm use 22                          # nvm',
    '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
    '',
    'To override (NOT recommended - you will likely OOM):',
    '  SYNAPSE_ALLOW_UNSAFE_NODE=1 synapse ...',
    sep,
  ].join('\n');
}

/**
 * 受支持的最低 Node.js 主版本，与 package.json 中 `engines` 的下限一致。
 * 低于此版本，Synapse 依赖的语言特性或原生 API 不存在，且该组合未经测试。
 * `engines` 仅在安装时*警告*（除非用户设置了 `engine-strict`），因此
 * CLI 引导也在此处硬性阻止，以真正强制执行最低版本要求。
 */
export const MIN_NODE_MAJOR = 20;

/**
 * 构建 Synapse 检测到 Node.js 主版本低于 {@link MIN_NODE_MAJOR} 时
 * 显示的带边框横幅。通过单元测试固定，以防未来的编辑静默删除
 * 恢复命令和覆盖环境变量。
 *
 * 使用 ASCII 字符，以确保在 Windows OEM 代码页控制台上可读
 * （原理见 ../ui/glyphs.ts）。
 */
export function buildNodeTooOldBanner(nodeVersion: string): string {
  const sep = '-'.repeat(72);
  return [
    sep,
    `[Synapse] Unsupported Node.js version: ${nodeVersion}`,
    sep,
    `Synapse requires Node.js ${MIN_NODE_MAJOR} or newer. Older versions lack`,
    'language features and native APIs Synapse depends on, and are not',
    'tested or supported.',
    '',
    'Fix: install Node.js 22 LTS:',
    '  nvm install 22 && nvm use 22                          # nvm',
    '  brew install node@22 && brew link --overwrite --force node@22  # Homebrew',
    '',
    'To override (NOT recommended - unsupported):',
    '  SYNAPSE_ALLOW_UNSAFE_NODE=1 synapse ...',
    sep,
  ].join('\n');
}
