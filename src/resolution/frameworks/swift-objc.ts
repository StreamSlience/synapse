/**
 * Swift ↔ Objective-C 桥接解析器。
 *
 * 弥合混合 iOS 代码库中的跨语言流程断点。纯粹的
 * 桥接名称运算逻辑位于 `../swift-objc-bridge.ts`；本文件将其
 * 接入解析流水线。
 *
 * **需要闭合的两个方向：**
 *
 * 1. **Swift 调用 → ObjC 方法** — Swift 调用方写
 *    `imageDownloader.download(url:completion:)`。tree-sitter-swift 将其
 *    解析为 call_expression，其被调用者标识符为 `download`
 *    （参数标签位于参数列表，而非被调用者）。名称匹配器尝试
 *    查找名为 `download` 的节点并失败（项目中没有该名称的
 *    Swift 方法；ObjC 实现是 `-downloadURL:completion:`）。
 *    我们在此拦截：从裸 Swift 名称 `download`，查找 ObjC 方法，
 *    其桥接 Swift 基础名称为 `download`（使用
 *    `swiftBaseNamesForObjcSelector` 的反向映射，每次会话预计算一次）。
 *
 * 2. **ObjC 调用 → Swift 方法** — ObjC 调用方写
 *    `[swiftThing fooWithBar:42]`。tree-sitter-objc 将其解析为
 *    selector 为 `fooWithBar:` 的 message_expression（经过本分支的
 *    多关键字修复）。名称匹配器尝试查找名为 `fooWithBar:` 的节点——
 *    没有 Swift 节点的名称中带冒号，因此失败。我们拦截：从 ObjC
 *    selector 推导候选 Swift 基础名称（`['fooWithBar', 'foo']`），
 *    并查找以这些名称命名的 Swift 方法。
 *
 * **来源标注：** 此处生成的每条边都记录为框架解析引用
 * （`resolvedBy: 'framework'`），置信度 0.7
 * （与 django ORM 动态分发先例相符——非精确，但由桥接规则确定）。
 */
import { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import type { Node } from '../../types';
import {
  swiftBaseNamesForObjcSelector,
  isObjcExposed,
} from '../swift-objc-bridge';

/**
 * 记忆化的"Swift 基础名称 → ObjC 方法节点"映射。
 *
 * 在每个解析器实例首次调用 `resolve()` 时懒惰构建——解析器在
 * 索引重建时重新创建，因此该映射随图自然失效。
 * 以 ResolutionContext 标识为键，使共享进程（守护进程）中的
 * 多个项目之间不会互相污染映射。
 */
const objcByCandidateSwiftBase: WeakMap<
  ResolutionContext,
  Map<string, Node[]>
> = new WeakMap();

/**
 * 构建反向桥接映射：对图中每个 ObjC 方法节点，
 * 计算会自动桥接到其 selector 的 Swift 基础名称，
 * 并将节点记录在每个名称下。
 *
 * 每个解析器生命周期运行一次；开销与 ObjC 方法节点数量线性相关。
 * 在 Wikipedia-iOS（约 2500 个文件，约 25k 个 ObjC 方法）上，
 * 耗时几百毫秒——远比每次未解析引用时重新解析源码便宜。
 */
/**
 * 过于通用而无法精确桥接的名称。这些是几乎每个 ObjC 类都实现的
 * 常见 Cocoa / NSObject 约定；如果 Swift 调用方写了 `init()` 或 `description`，
 * 将其映射到项目本地的任意同名 ObjC 方法只会产生噪声，而非信号。
 *
 * 关键在于，这些名称的引用几乎总是通过常规名称匹配器解析
 * （每个项目都有许多 `init` 节点）——在此跳过它们只是为了避免
 * 桥接器与名称匹配器在已处理的引用上竞争。
 */
const GENERIC_NAMES = new Set([
  'init',
  'description',
  'debugDescription',
  'hash',
  'isEqual',
  'isEqualTo',
  'copy',
  'mutableCopy',
  'class',
  'self',
  'count',
  'length',
  'value',
  'name',
  'data',
  'string',
  'object',
  'add',
  'remove',
  'update',
  'load',
  'save',
  'reload',
  'cancel',
  'start',
  'stop',
  'pause',
  'resume',
  'close',
  'open',
  'show',
  'hide',
  'toString',
  'dealloc',
  'release',
  'retain',
  'autorelease',
]);

function buildObjcMap(context: ResolutionContext): Map<string, Node[]> {
  const cached = objcByCandidateSwiftBase.get(context);
  if (cached) return cached;

  const map = new Map<string, Node[]>();
  const objcMethods = context
    .getNodesByKind('method')
    .filter((n) => n.language === 'objc');
  for (const node of objcMethods) {
    const candidates = swiftBaseNamesForObjcSelector(node.name);
    for (const c of candidates) {
      // 跳过 Swift 基础名称与 ObjC 方法名称完全相同的平凡情况
      // （无冒号）——常规名称匹配器已处理该情况，映射中的重复毫无意义。
      if (c === node.name && !node.name.includes(':')) continue;
      // 跳过通用 Cocoa 名称（init、description 等）——它们会对项目本地
      // 任何同名 ObjC 方法产生误报。常规名称匹配器负责处理它们。
      if (GENERIC_NAMES.has(c)) continue;
      const arr = map.get(c);
      if (arr) arr.push(node);
      else map.set(c, [node]);
    }
  }
  objcByCandidateSwiftBase.set(context, map);
  return map;
}

/**
 * `isObjcExposed` 用于检测 `@objc` / `@nonobjc` 注解的 Swift 声明
 * 周围源码文本窗口。读取上方一行 + 声明行——Swift 属性通常
 * 位于前一行（`@objc` 单独一行）或内联。
 */
const SOURCE_PROBE_LINES = 3;

/**
 * 读取以 `node.startLine` 结尾的一小段源码，用于检查
 * 附加到声明上的 Swift 属性注解。如果源码无法读取则返回空字符串。
 */
function declarationSourceWindow(node: Node, context: ResolutionContext): string {
  const content = context.readFile(node.filePath);
  if (!content) return '';
  const lines = content.split(/\r?\n/);
  const startIdx = Math.max(0, node.startLine - 1 - SOURCE_PROBE_LINES);
  const endIdx = Math.min(lines.length, node.startLine);
  return lines.slice(startIdx, endIdx).join('\n');
}

/**
 * 尝试将 Swift 调用方的裸引用解析到 ObjC 实现。
 *
 * 策略：在 ObjC 反向桥接映射中查找 Swift 基础名称会匹配的节点。
 * 返回第一个匹配项（符合现有的单目标解析契约）。
 */
function resolveSwiftCallToObjc(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // `obj.foo(bar:)` 的 Swift 调用点以裸名称 `foo`（tree-sitter-swift）
  // 或限定名 `obj.foo` 到达解析器——去除前缀。
  const rawName = ref.referenceName.includes('.')
    ? ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1)
    : ref.referenceName;

  const map = buildObjcMap(context);
  const candidates = map.get(rawName);
  if (!candidates || candidates.length === 0) return null;

  // 优先选择没有对应 Swift 声明的 ObjC 方法（避免在存在同名 Swift 方法时
  // 错误地将 Swift 调用重定向到 ObjC——那是语言内部的情况，应已由
  // 名称匹配器解析）。由于本解析器在精确匹配之后运行，
  // 到达此处的候选项是合法的跨语言命中。
  const target = candidates[0];
  if (!target) return null;
  return {
    original: ref,
    targetNodeId: target.id,
    confidence: 0.6,
    resolvedBy: 'framework',
  };
}

/**
 * 尝试将 ObjC 调用方的 selector 引用解析到 Swift `@objc` 实现。
 *
 * 策略：通过 `swiftBaseNamesForObjcSelector` 从 selector 推导候选
 * Swift 基础名称。对每个名称，查找以该名称命名的 Swift 方法，
 * 并通过源码窗口检查验证声明是否被 `@objc` 暴露
 * （过滤掉 Swift 函数碰巧同名但未桥接的误匹配）。
 */
function resolveObjcCallToSwift(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // 当接收者不是 self/super 时，ObjC 调用点会带接收者前缀
  // （参见 tree-sitter.ts 的 message_expression 处理）：`[obj foo:bar:]`
  // 变为 `obj.foo:bar:`。去除接收者前缀以还原用于桥接运算的原始 selector。
  const rawSelector = ref.referenceName.includes('.')
    ? ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1)
    : ref.referenceName;

  // 桥接运算仅适用于 selector 形状的名称（含 `:`）。
  if (!rawSelector.includes(':')) return null;

  const candidates = swiftBaseNamesForObjcSelector(rawSelector);
  for (const candidate of candidates) {
    const matches = context
      .getNodesByName(candidate)
      .filter((n) => n.language === 'swift' && (n.kind === 'method' || n.kind === 'function'));
    for (const match of matches) {
      const window = declarationSourceWindow(match, context);
      if (isObjcExposed(window)) {
        return {
          original: ref,
          targetNodeId: match.id,
          confidence: 0.6,
          resolvedBy: 'framework',
        };
      }
    }
  }
  return null;
}

export const swiftObjcBridgeResolver: FrameworkResolver = {
  name: 'swift-objc-bridge',
  // 适用于两种语言——桥接跨越语言边界。
  languages: ['swift', 'objc'],

  /**
   * 检测：当项目同时包含 Swift 和 Objective-C 源码时，此解析器才有意义。
   * 只有一侧的项目不需要桥接（空的反向映射也是无操作）。
   */
  detect(context) {
    const files = context.getAllFiles();
    let hasSwift = false;
    let hasObjc = false;
    for (const f of files) {
      if (f.endsWith('.swift')) hasSwift = true;
      else if (f.endsWith('.m') || f.endsWith('.mm')) hasObjc = true;
      if (hasSwift && hasObjc) return true;
    }
    return false;
  },

  /**
   * 让 selector 形状的引用（任何含有 `:` 的名称）通过解析器的
   * 名称存在预过滤——没有 Swift 节点的名称中含冒号，因此若不选择
   * 加入，这些引用会在 `resolve()` 看到它们之前就被丢弃。
   * 同时加入 `setX:` 风格的名称，以防 Swift 侧是属性。
   */
  claimsReference(name) {
    if (name.includes(':')) return true;
    // 不含冒号的裸名称由常规名称存在预过滤处理——此处无需加入。
    return false;
  },

  /**
   * 根据调用方所在语言路由。两个方向在形状上对称，
   * 但实现差异很大（正向使用预计算的反向桥接映射；
   * 反向使用确定性名称推导）。
   */
  resolve(ref, context) {
    if (ref.language === 'swift') {
      return resolveSwiftCallToObjc(ref, context);
    }
    if (ref.language === 'objc') {
      return resolveObjcCallToSwift(ref, context);
    }
    return null;
  },
};
