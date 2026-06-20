/**
 * Expo Modules 框架——为 Expo SDK 包打通 JS → 原生的调用流程。
 *
 * Expo Modules 使用一套独立于 React Native 旧版 bridge 的 Swift / Kotlin DSL。
 * 每个原生模块是一个继承自 `Module` 的类，其 `definition()` 函数体通过
 * `Name(...)`、`Function(...)`、`AsyncFunction(...)`、`Property(...)` 和
 * `View {...}` 字面量调用来声明 JS 可见的接口。Tree-sitter 将这些解析为
 * 带尾随闭包的普通 call_expression，因此 JS 可见的方法默认不会以具名符号节点
 * 的形式存在——JS 端的 `Camera.takePictureAsync(...)` 没有任何节点可以解析到。
 *
 * 此框架提取器遍历文件源码中的这些声明式字面量，生成命名为
 * `takePictureAsync` / `notificationAsync` / `width` 等的方法节点，
 * 归属到对应的 Swift / Kotlin 文件。标准名称匹配器随后通过已有的
 * `obj.method` → 方法名路径，将 JS 端的 `Foo.takePictureAsync(...)` 解析到
 * 这些节点——无需单独的 resolve() 分支。
 *
 * 真实示例（expo-haptics）：
 *
 *   public class HapticsModule: Module {
 *     public func definition() -> ModuleDefinition {
 *       Name("ExpoHaptics")
 *       AsyncFunction("notificationAsync") { ... }
 *       AsyncFunction("impactAsync") { ... }
 *       AsyncFunction("selectionAsync") { ... }
 *     }
 *   }
 *
 * Kotlin Module 声明使用相同的 DSL（API 与 Swift 镜像对应）。
 *
 * 非目标（延后处理）：
 * - 尾随闭包的函数体不会被提取为方法体——它仍归属于现有提取中的 `definition()`。
 *   未来工作可以为更丰富的 `trace` 输出合成函数体范围，但可达性
 *   （这是 bridge 的核心价值）已经完整。
 * - `View { ... }` 块暴露 JSX prop 绑定；这与 Fabric（第 6 阶段）重叠，
 *   留待该阶段处理。
 */
import type { Node } from '../../types';
import {
  FrameworkExtractionResult,
  FrameworkResolver,
} from '../types';

/**
 * 匹配 `Function("name")`、`AsyncFunction("name")` 或 `Property("name")`，
 * 表达式开头（可选空白后行首锚定）。不捕获后续的尾随闭包——我们只需要
 * 成为 JS 可见方法的名称字面量。
 *
 * 注意：正则故意要求开括号与关键字在同一行，这与所有真实 Expo Module
 * 声明风格一致。多行 `AsyncFunction(\n"x"\n)` 形式在 SDK 中不是真实写法；
 * 若有出现再扩展正则。
 *
 * 可选的 `<…>` 覆盖 Kotlin 的泛型类型声明
 * （`AsyncFunction<Float>("getBatteryLevelAsync")`、`AsyncFunction<Int, String>(…)`）
 * ——不加此项，所有 Android Expo Module 方法都会被静默丢弃，导致 JS 调用点
 * 只能解析到 iOS Swift 实现而无法解析到 Android 实现。
 */
const EXPO_DECL_RE =
  /\b(Function|AsyncFunction|Property|Constants)\s*(?:<[^(]*>)?\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g;

/**
 * 匹配模块名称字面量 `Name("ExpoX")`。用于丰富每个生成方法的 qualifiedName，
 * 使 monorepo 中多个 Expo 模块的相同 JS 调用点 `Foo.fn` 不会产生歧义。
 */
const EXPO_MODULE_NAME_RE = /\bName\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/;

/**
 * 启发式类名匹配——在未找到 `Name(...)` 字面量时作为回退。
 * 检测 `class XxxModule: Module`（Swift）或
 * `class XxxModule : Module`（Kotlin / 允许空白）。
 */
const EXPO_CLASS_RE =
  /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*Module\b/;

/**
 * 检测文件是否可能是 Expo Module——同时查找 `: Module` 继承关系以及至少一个
 * 声明式 `Function(...)` / `AsyncFunction(...)` / `Property(...)` / `Name(...)`
 * 字面量。任一单独信号都会产生过多误判（随机 Swift 代码可能因无关原因包含
 * `class X: Module`）。
 */
function isExpoModuleSource(source: string): boolean {
  if (!EXPO_CLASS_RE.test(source)) return false;
  // 防御性重置 lastIndex；EXPO_DECL_RE 带有 `g` 标志。
  EXPO_DECL_RE.lastIndex = 0;
  return EXPO_DECL_RE.test(source);
}

/**
 * 从 Swift / Kotlin 源文件中提取 Expo Module 方法声明。
 * 每个 `Function("X") { … }` / `AsyncFunction("X") { … }` /
 * `Property("X") { … }` 字面量都会生成一个命名为 `X` 的方法节点，
 * 归属到该文件的字面量所在行。
 */
function extractExpoMethods(filePath: string, source: string, language: 'swift' | 'kotlin'): Node[] {
  if (!isExpoModuleSource(source)) return [];
  const nodes: Node[] = [];

  const nameMatch = source.match(EXPO_MODULE_NAME_RE);
  const classMatch = source.match(EXPO_CLASS_RE);
  // 优先使用显式的 `Name("X")` 字面量——那是 JS 可见的模块名。
  // 类名作为回退。
  const moduleName = nameMatch?.[1] ?? classMatch?.[1] ?? 'ExpoModule';

  const now = Date.now();
  const seenAtLine = new Set<string>();
  EXPO_DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPO_DECL_RE.exec(source)) !== null) {
    const kind = m[1]!;
    const methodName = m[2]!;
    // 从匹配索引计算行号。
    const before = source.slice(0, m.index);
    const startLine = before.split('\n').length;
    // 若同一文件中相同方法字面量出现两次（例如在 `View {...}` 块中
    // 声明并重新声明），则去重。
    const dedupKey = `${methodName}:${startLine}`;
    if (seenAtLine.has(dedupKey)) continue;
    seenAtLine.add(dedupKey);

    const startColumn = before.length - before.lastIndexOf('\n') - 1;
    nodes.push({
      id: `expo-module:${filePath}:${moduleName}:${methodName}:${startLine}`,
      kind: 'method',
      name: methodName,
      qualifiedName: `${filePath}::${moduleName}.${methodName}`,
      filePath,
      language,
      startLine,
      // 不提取闭包函数体的结束行——使用字面量的行作为单行范围。
      // trace/explore 仍会展示声明位置，这是用户可见的主要信号。
      endLine: startLine,
      startColumn,
      endColumn: startColumn + kind.length + 2 + methodName.length + 2,
      docstring: `Expo Modules ${kind}("${methodName}") in ${moduleName}`,
      signature: `${kind}("${methodName}")`,
      isExported: true,
      updatedAt: now,
    });
  }

  return nodes;
}

export const expoModulesResolver: FrameworkResolver = {
  name: 'expo-modules',
  languages: ['swift', 'kotlin'],

  /**
   * 通过查看项目的 package.json 或对源文件进行少量扫描来检测 Expo Modules，
   * 寻找 `: Module` + 声明式 DSL 标志。任一信号即可。
   */
  detect(context) {
    const pkg = context.readFile('package.json');
    if (pkg && /["']expo-modules-core["']\s*:/.test(pkg)) return true;
    const files = context.getAllFiles();
    for (let i = 0; i < Math.min(files.length, 200); i++) {
      const f = files[i];
      if (!f) continue;
      if (f.endsWith('.swift') || f.endsWith('.kt')) {
        const src = context.readFile(f);
        if (src && isExpoModuleSource(src)) return true;
      }
    }
    return false;
  },

  /**
   * 逐文件提取——编排器对项目中的每个 `.swift` / `.kt` 文件调用此方法。
   * 仅当文件看起来像 Expo Module 时才生成节点；否则返回空结果。
   */
  extract(filePath, source): FrameworkExtractionResult {
    const language = filePath.endsWith('.kt') ? 'kotlin' : 'swift';
    return {
      nodes: extractExpoMethods(filePath, source, language),
      references: [],
    };
  },

  /**
   * 无需专门的解析逻辑——`extract()` 生成的合成方法节点在 JS 调用点
   * （如 `Foo.takePictureAsync(args)`）解析时会被标准名称匹配器捕获。
   * 此处返回 null 是正确的。
   */
  resolve() {
    return null;
  },
};
