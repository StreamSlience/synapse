/**
 * 名称匹配器
 *
 * 处理引用解析中的符号名称匹配。
 */

import { Node } from '../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from './types';

/**
 * 尝试通过将文件名与文件节点进行匹配，解析类路径引用（如 "snippets/drawer-menu.liquid"）。
 */
export function matchByFilePath(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // 路径形式（`a/b.liquid`）或以短扩展名结尾的裸文件名
  // （`Foo.h` —— Objective-C 的 `#import "Foo.h"`，按 basename 解析到头文件）。
  // 不带扩展名的裸引用是符号名，不是文件，留给符号匹配策略处理。
  if (!ref.referenceName.includes('/') && !/\.[A-Za-z][A-Za-z0-9]{0,3}$/.test(ref.referenceName)) {
    return null;
  }

  // 从路径中提取文件名
  const fileName = ref.referenceName.split('/').pop();
  if (!fileName) return null;

  // 按文件名搜索文件节点
  const candidates = context.getNodesByName(fileName);
  const fileNodes = candidates.filter(n => n.kind === 'file');

  if (fileNodes.length === 0) return null;

  // 优先按 qualified_name 精确路径匹配
  const exactMatch = fileNodes.find(n => n.qualifiedName === ref.referenceName || n.filePath === ref.referenceName);
  if (exactMatch) {
    return {
      original: ref,
      targetNodeId: exactMatch.id,
      confidence: 0.95,
      resolvedBy: 'file-path',
    };
  }

  // 回退到后缀匹配（如 ref="snippets/foo.liquid" 匹配
  // "src/snippets/foo.liquid"）。当多个文件共享同一 basename 时——
  // `#include "RNCAsyncStorage.h"` 在另一平台（windows/code/ 对比 apple/）
  // 存在同名头文件——优先选择 includer 所在目录中的那个，
  // 再按目录接近度 / 相同语言家族排序。C/C++ 的 include（以及任何
  // 裸文件名导入）相对于包含文件所在目录解析，而非树中任意同名头文件。
  const suffixMatches = fileNodes.filter(
    n => n.qualifiedName.endsWith(ref.referenceName) || n.filePath.endsWith(ref.referenceName)
  );
  if (suffixMatches.length > 0) {
    return {
      original: ref,
      targetNodeId: pickClosestFileNode(suffixMatches, ref).id,
      confidence: 0.85,
      resolvedBy: 'file-path',
    };
  }

  // 若只有一个同名文件节点，以较低置信度使用它
  if (fileNodes.length === 1) {
    return {
      original: ref,
      targetNodeId: fileNodes[0]!.id,
      confidence: 0.7,
      resolvedBy: 'file-path',
    };
  }

  return null;
}

/**
 * 当多个文件节点均通过 basename 匹配某个裸 include/import 时，
 * 选择距引用文件最近的那个：同目录优先，其次按目录树接近度，
 * 相同语言家族作为决胜条件。C/C++ 的 `#include "X.h"`（以及任何裸文件名导入）
 * 相对于包含文件所在目录解析，而非另一平台上任意同名头文件。
 */
function pickClosestFileNode(candidates: Node[], ref: UnresolvedRef): Node {
  const dirOf = (p: string): string => {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(0, i) : '';
  };
  const refDir = dirOf(ref.filePath);
  const sameDir = candidates.filter((c) => dirOf(c.filePath) === refDir);
  const pool = sameDir.length > 0 ? sameDir : candidates;
  let best = pool[0]!;
  let bestScore = -Infinity;
  for (const c of pool) {
    const score =
      computePathProximity(ref.filePath, c.filePath) +
      (sameLanguageFamily(c.language, ref.language) ? 5 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/**
 * 共享类型系统 / 运行时的语言家族，同语言家族内的引用仍可跨语言解析
 * （Kotlin 的 `Foo.BAR` 可指向 Java 的 `Foo`）。
 * 未列出的语言各自构成单元素家族。
 */
const LANGUAGE_FAMILY: Record<string, string> = {
  java: 'jvm', kotlin: 'jvm', scala: 'jvm',
  swift: 'apple', objc: 'apple',
  typescript: 'web', tsx: 'web', javascript: 'web', jsx: 'web',
  c: 'c', cpp: 'c',
  // Razor/Blazor 标记引用 C# 类型——归入同一家族，
  // 使 `@model Foo` / `<MyComponent/>` 能通过跨家族门限解析到 `.cs` 类。
  csharp: 'dotnet', razor: 'dotnet',
};
export function sameLanguageFamily(a: string, b: string): boolean {
  if (a === b) return true;
  const fa = LANGUAGE_FAMILY[a];
  return fa !== undefined && fa === LANGUAGE_FAMILY[b];
}
/**
 * 当 `lang` 属于已知多语言家族（jvm/apple/web/c）时返回 true。
 * 未列出的语言（php、python、go、ruby、rust、dart……）以及配置格式
 * （yaml/xml/blade）构成各自的单元素家族，返回 `false`——
 * 用于将配置↔代码框架桥接（其配置侧从不属于已知编程语言家族）
 * 排除在跨家族门限之外。
 */
export function isKnownLanguageFamily(lang: string): boolean {
  return LANGUAGE_FAMILY[lang] !== undefined;
}
/**
 * 当 `a` 和 `b` 属于两个不同的*已知*语言家族时返回 true——
 * 这是跨语言名称碰撞的典型特征（TS 的 `import React` 与 Swift 的 `import React`，
 * C++ 的 `#include "X.h"` 与另一平台上同名的 ObjC 头文件）。
 * 两者都*已知*的检测刻意比 {@link sameLanguageFamily} 取反更宽松：
 * 携带自身标签（`vue`/`svelte`）的单文件组件语言导入 `.ts` 模块，
 * 或任何单元素家族语言（php/go/ruby/……），在此返回 `false`，保持原样。
 */
export function crossesKnownFamily(a: string, b: string): boolean {
  return isKnownLanguageFamily(a) && isKnownLanguageFamily(b) && !sameLanguageFamily(a, b);
}
/**
 * 从名称查找结果中过滤掉跨语言候选项。两种模式：
 *  - `references`（类型引用）：语言 X 中命名的类型解析到同家族类型，
 *    绝不解析到另一语言中碰巧同名的符号（Android 的 `BatteryManager` 系统类
 *    vs JS 中的同名类）。严格同家族过滤——跨语言通信用 `calls`，不用 refs。
 *  - `imports`（导入绑定）：`import`/`#include` 绝不跨越两个*已知*家族
 *    （TS 的 `import React` ↮ Swift 的 `import React`）。较宽松的
 *    两者均已知过滤，使 `.vue`/`.svelte`（携带自身标签）导入 `.ts` 得以通过。
 */
function applyLanguageGate(candidates: Node[], ref: UnresolvedRef): Node[] {
  if (ref.referenceKind === 'references' || ref.referenceKind === 'function_ref') {
    return candidates.filter((c) => sameLanguageFamily(c.language, ref.language));
  }
  if (ref.referenceKind === 'imports') {
    return candidates.filter((c) => !crossesKnownFamily(c.language, ref.language));
  }
  return candidates;
}

/**
 * 解析函数即值引用（#756）——函数名作为回调/函数指针值使用
 * （`register(handler)`、`o->cb = handler`、`{ .cb = handler }`、
 * `signal(SIGINT, handler)`）。`function_ref` 引用的唯一允许策略：
 * 精确名称、仅限 function/method 目标、同语言家族、同文件优先，
 * 跨文件仅在匹配唯一时解析。无模糊回退，无限定名遍历——
 * 错误的回调边比没有边更糟。
 */
export function matchFunctionRef(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // `this.<成员>` 引用仅由 resolveOne 中的类作用域解析器（resolveThisMemberFnRef）处理——
  // 不在此处通过名称匹配解析。
  if (ref.referenceName.startsWith('this.')) return null;

  // 在 JS/TS/Python 中，裸标识符永远不能是方法值（方法只能通过接收者访问——
  // `this.m` / `self.m` / `Cls.m`），因此裸 fn-ref 仅匹配 FUNCTION。
  // 这也绕开了 TS 中类字段被提取为 method 类型节点的已知怪异行为，
  // 否则会将作为参数传递的局部名称吸收掉（excalidraw A/B 发现；
  // vendored docopt.py 中有相同模式）。Python 的 `self.m` 形式
  // 通过其自身的捕获形状保留方法目标。C++ 同理：裸标识符只能是
  // 自由函数（成员值需要 `&Cls::method`）。PHP 字符串可调用项命名
  // 全局 FUNCTION（方法需要 `[$obj, 'm']` 数组形式，有自身形状）。
  // 其他语言保留方法目标：C# 方法组、Swift/Dart 隐式 self、
  // Java/Kotlin 方法引用。
  const bareFnOnly =
    ref.language === 'typescript' || ref.language === 'tsx' ||
    ref.language === 'javascript' || ref.language === 'jsx' ||
    ref.language === 'cpp' || ref.language === 'python' ||
    ref.language === 'php';

  // 限定成员指针（`&Widget::on_click` → "Widget::on_click"）：
  // 在该作用域上解析成员——豁免于 bareFnOnly（`&Cls::m` 形式是显式成员引用）。
  // 与其他情况一样，唯一匹配则解析，否则丢弃。
  if (ref.referenceName.includes('::')) {
    const memberName = ref.referenceName.slice(ref.referenceName.lastIndexOf('::') + 2);
    const scoped = context
      .getNodesByName(memberName)
      .filter(
        (n) =>
          (n.kind === 'function' || n.kind === 'method') &&
          sameLanguageFamily(n.language, ref.language) &&
          n.id !== ref.fromNodeId &&
          (n.qualifiedName === ref.referenceName ||
            n.qualifiedName.endsWith(`::${ref.referenceName}`))
      );
    if (scoped.length === 0) return null;
    const sameFileScoped = scoped.filter((n) => n.filePath === ref.filePath);
    const pool = sameFileScoped.length > 0 ? sameFileScoped : scoped;
    if (sameFileScoped.length === 0 && scoped.length > 1) return null;
    const target = pool.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.9,
      resolvedBy: 'function-ref',
    };
  }

  let candidates = context
    .getNodesByName(ref.referenceName)
    .filter(
      (n) =>
        (n.kind === 'function' || (!bareFnOnly && n.kind === 'method')) &&
        sameLanguageFamily(n.language, ref.language) &&
        n.id !== ref.fromNodeId // a function registering itself is not a dependency edge
    );
  if (candidates.length === 0) return null;

  // Swift 隐式 self：裸标识符只能命名*封闭类型*中的 METHOD
  // （`Button(action: handleTap)` 写在该类型内部）——
  // 其他类上的同名方法是参数碰撞
  // （Alamofire：`request` 参数解析到 EventMonitor::request）。
  // 将方法候选项限定在 from-symbol 所在类型；顶层代码无隐式 self，
  // 因此方法目标在那里被完全排除。自由函数不受影响。
  if (ref.language === 'swift' && candidates.some((n) => n.kind === 'method')) {
    const fromNode = context.getNodeById?.(ref.fromNodeId);
    const sep = fromNode ? fromNode.qualifiedName.lastIndexOf('::') : -1;
    const classPrefix = fromNode && sep > 0 ? fromNode.qualifiedName.slice(0, sep) : null;
    candidates = candidates.filter((n) => {
      if (n.kind !== 'method') return true;
      if (!classPrefix) return false;
      const mSep = n.qualifiedName.lastIndexOf('::');
      if (mSep <= 0) return false;
      const methodPrefix = n.qualifiedName.slice(0, mSep);
      // 接受精确作用域匹配，以及两个方向上的后缀关系，
      // 使 extension 中声明的成员（`Holder::m`）仍能匹配嵌套的
      // from-scope（`Module::Holder::wire`），反之亦然。
      return (
        methodPrefix === classPrefix ||
        methodPrefix.endsWith(`::${classPrefix}`) ||
        classPrefix.endsWith(`::${methodPrefix}`)
      );
    });
    if (candidates.length === 0) return null;
  }

  // 同文件定义优先——提取门限保证大多数幸存者都有一个，
  // 且这是 C 语言的主要模式（在同文件 ops 结构体中注册的静态回调）。
  const sameFile = candidates.filter((n) => n.filePath === ref.filePath);
  if (sameFile.length > 0) {
    // Swift：一个文件中多个同名 METHOD 构成 API 重载族
    // （`Session.request(...)` × N），裸标识符命中时几乎总是
    // 同名参数，而非方法值（Alamofire A/B 发现）——
    // 宁可拒绝也不猜测。单个方法（SwiftUI 的 `action: handleTap`）仍可解析。
    if (
      ref.language === 'swift' &&
      sameFile.length > 1 &&
      sameFile.every((n) => n.kind === 'method')
    ) {
      return null;
    }
    // 同一文件中同名重载属于同一概念符号；为保证确定性，按位置选第一个。
    const target = sameFile.reduce((a, b) => (a.startLine <= b.startLine ? a : b));
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: sameFile.length === 1 ? 0.95 : 0.9,
      resolvedBy: 'function-ref',
    };
  }

  // 跨文件（导入解析器未已处理的导入名称）：
  // 仅在匹配唯一时解析。
  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.8,
      resolvedBy: 'function-ref',
    };
  }
  return null;
}

/**
 * 尝试通过精确名称匹配解析引用
 */
export function matchByExactName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const candidates = applyLanguageGate(context.getNodesByName(ref.referenceName), ref);

  if (candidates.length === 0) {
    return null;
  }

  // 只有一个匹配时使用它——但对跨语言匹配降低置信度
  if (candidates.length === 1) {
    const isCrossLanguage = candidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: isCrossLanguage ? 0.5 : 0.9,
      resolvedBy: 'exact-match',
    };
  }

  // 多个匹配——尝试缩小范围
  const bestMatch = findBestMatch(ref, candidates, context);
  if (bestMatch) {
    // 当匹配来自距离较远/无关模块时，降低置信度
    const proximity = computePathProximity(ref.filePath, bestMatch.filePath);
    const confidence = proximity >= 30 ? 0.7 : 0.4;
    return {
      original: ref,
      targetNodeId: bestMatch.id,
      confidence,
      resolvedBy: 'exact-match',
    };
  }

  return null;
}

/**
 * 尝试通过限定名解析引用
 */
export function matchByQualifiedName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // 检查引用名是否看起来是限定名（包含 :: 或 .）
  if (!ref.referenceName.includes('::') && !ref.referenceName.includes('.')) {
    return null;
  }

  const candidates = context.getNodesByQualifiedName(ref.referenceName);

  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.95,
      resolvedBy: 'qualified-name',
    };
  }

  // 尝试部分限定名匹配
  const parts = ref.referenceName.split(/[:.]/);
  const lastName = parts[parts.length - 1];
  if (lastName) {
    const partialCandidates = context.getNodesByName(lastName);
    for (const candidate of partialCandidates) {
      if (candidate.qualifiedName.endsWith(ref.referenceName)) {
        return {
          original: ref,
          targetNodeId: candidate.id,
          confidence: 0.85,
          resolvedBy: 'qualified-name',
        };
      }
    }
  }

  return null;
}

function resolveMethodOnType(
  typeName: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  confidence: number,
  resolvedBy: ResolvedRef['resolvedBy'],
  /**
   * 用于标识调用方文件中 `typeName` 指向哪个类声明的可选 FQN。
   * 当多个候选项共享相同的 qualifiedName（`FooConverter::convert`
   * 同时存在于 `dao/converter/` 和 `service/converter/`），
   * FQN 的文件路径后缀可选出正确的那个——
   * 这是 Java import 携带但调用点不带的消歧信号（#314）。
   */
  preferredFqn?: string,
  /** 超类型/一致性遍历的递归守卫。 */
  depth = 0,
): ResolvedRef | null {
  // 按名称查找方法，通过 qualifiedName 以 `<typeName>::<methodName>` 结尾进行匹配。
  // 无论方法是内联定义（`class Foo { int bar() { ... } }`）还是
  // 在独立文件中类外定义（`int Foo::bar() { ... }` 在 foo.cpp，
  // 而 `class Foo` 在 foo.hpp），都能正常工作。
  // 之前的同文件方式遗漏了后者——这是典型的 C++ 布局。
  const methodCandidates = context.getNodesByName(methodName);
  const want = `${typeName}::${methodName}`;
  const matches: Node[] = [];
  for (const m of methodCandidates) {
    if (m.kind !== 'method') continue;
    if (m.language !== ref.language) continue;
    const qn = m.qualifiedName;
    if (qn === want || qn.endsWith(`::${want}`)) {
      matches.push(m);
    }
  }
  if (matches.length === 0) {
    // 一致性回退：方法可能定义在 `typeName` 继承的超类型上，
    // 或定义在它遵循的协议/trait 上（例如 Swift 协议 extension 方法、
    // C# 默认接口或扩展方法、Kotlin 对超类型的扩展）。
    // 通过已解析的 implements/extends 边递归遍历超类型（有深度限制）——
    // 第一次解析遍历时为空，一致性遍历后才有数据。
    // 仍需 VALIDATED（方法必须存在于某个超类型上），
    // 因此错误的推断不会产生边。
    if (depth < 4 && context.getSupertypes) {
      for (const supertype of context.getSupertypes(typeName, ref.language)) {
        const via = resolveMethodOnType(
          supertype, methodName, ref, context, confidence, resolvedBy, preferredFqn, depth + 1,
        );
        if (via) return via;
      }
    }
    return null;
  }

  if (matches.length > 1 && preferredFqn) {
    const ext = ref.language === 'kotlin' ? '.kt' : '.java';
    const fqnPath = preferredFqn.replace(/\./g, '/') + ext;
    const chosen = matches.find((m) => {
      const fp = m.filePath.replace(/\\/g, '/');
      return fp.endsWith(fqnPath) || fp.endsWith('/' + fqnPath);
    });
    if (chosen) {
      return {
        original: ref,
        targetNodeId: chosen.id,
        confidence,
        resolvedBy,
      };
    }
  }

  return {
    original: ref,
    targetNodeId: matches[0]!.id,
    confidence,
    resolvedBy,
  };
}

// C++ 关键字/控制流 token，可能出现在接收者前面
// （如 `return ptr->m()`），不得将其视为类型。
const CPP_NON_TYPE_TOKENS = new Set([
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'goto', 'throw', 'new', 'delete', 'co_await', 'co_yield',
  'co_return', 'static_cast', 'const_cast', 'dynamic_cast', 'reinterpret_cast',
  'sizeof', 'alignof', 'typeid', 'and', 'or', 'not', 'xor',
]);

function normalizeCppTypeName(typeName: string): string | null {
  const normalized = typeName
    .replace(/\b(const|volatile|mutable|typename|class|struct)\b/g, ' ')
    .replace(/[&*]+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  const parts = normalized.split(/::/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  if (CPP_NON_TYPE_TOKENS.has(last)) return null;
  return last;
}

// 声明符正则：匹配 `Type receiver`、`Type* receiver`、`Type *receiver`、
// `Type*receiver`、`Type<X> receiver` 等形式，要求接收者后面紧跟声明符终结符
// （`;`、`=`、`,`、`)`、`[`、`{`、`(` 或行尾）。
// 终结符规则排除了 `return receiver->m()` 这类用法，其中前置 token 是关键字而非类型。
function buildDeclaratorRegex(escapedReceiver: string): RegExp {
  return new RegExp(
    `([A-Za-z_][\\w:]*(?:\\s*<[^;=(){}]+>)?(?:\\s*[*&]+)?)\\s*\\b${escapedReceiver}\\b\\s*(?=[;=,)\\[{(]|$)`,
  );
}

function inferCppReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
): string | null {
  const source = context.readFile(ref.filePath);
  if (!source) return null;

  const lines = source.split(/\r?\n/);
  const callLineIndex = Math.max(0, Math.min(lines.length - 1, ref.line - 1));
  const escapedReceiver = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const receiverPattern = new RegExp(`\\b${escapedReceiver}\\b`);
  const declaratorRegex = buildDeclaratorRegex(escapedReceiver);

  for (let i = callLineIndex; i >= 0; i--) {
    const line = lines[i];
    if (!line || !receiverPattern.test(line)) continue;

    const declaratorMatch = line.match(declaratorRegex);
    if (declaratorMatch) {
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '');
      if (normalized === 'auto') {
        // `auto x = Foo::instance();` —— 声明类型由推导得出；
        // 从初始化表达式（调用返回类型/构造）中恢复它（#645）。
        const initType = inferCppAutoInitializerType(line, receiverName, ref, context, depth);
        if (initType) return initType;
        // 该行无可用初始化表达式——继续扫描更早的行。
      } else if (normalized) {
        return normalized;
      }
    }
  }

  const headerCandidates = [
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.h'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hpp'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hxx'),
  ].filter((candidate, index, arr) => arr.indexOf(candidate) === index && candidate !== ref.filePath);

  for (const headerPath of headerCandidates) {
    if (!context.fileExists(headerPath)) continue;
    const headerSource = context.readFile(headerPath);
    if (!headerSource) continue;

    for (const line of headerSource.split(/\r?\n/)) {
      if (!receiverPattern.test(line)) continue;
      const declaratorMatch = line.match(declaratorRegex);
      if (!declaratorMatch) continue;
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '');
      if (normalized && normalized !== 'auto') return normalized;
    }
  }

  return null;
}

/**
 * 返回（可能带命名空间限定的）C++ 名称中最后一个 `::` 分隔的段。
 */
function cppLastSegment(name: string): string {
  const parts = name.split('::').filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

/**
 * 从提取时捕获的 `Class::method`（或自由函数）的返回类型中读取，
 * 取自已索引节点的 `returnType`——供 C++（#645）和 PHP（#608）
 * 链式调用解析器使用。按语言过滤。未索引或未记录返回类型（void/原始类型返回）时返回 null。
 */
function lookupCalleeReturnType(
  callee: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  let method = callee;
  let cls: string | null = null;
  if (callee.includes('::')) {
    const parts = callee.split('::').filter(Boolean);
    method = parts[parts.length - 1] ?? callee;
    cls = parts.slice(0, -1).join('::');
  }
  const candidates = context.getNodesByName(method).filter(
    (n) =>
      (n.kind === 'method' || n.kind === 'function') &&
      n.language === ref.language &&
      !!n.returnType,
  );
  if (cls) {
    const want = `${cls}::${method}`;
    // 调用点命名的类可能比存储节点带有更多命名空间限定
    // （调用点 `details::registry::instance` vs 节点上的 `registry::instance`——
    // 接收者类型只携带直接类名），或更少。
    // 接受精确匹配或两者互为命名空间后缀的情况；
    // 共享的 `::<class>::<method>` 尾缀保证了特异性。
    const m = candidates.find(
      (n) =>
        n.qualifiedName === want ||
        n.qualifiedName.endsWith(`::${want}`) ||
        want.endsWith(`::${n.qualifiedName}`),
    );
    return m?.returnType ?? null;
  }
  return candidates.find((n) => n.kind === 'function')?.returnType ?? null;
}

/** 图中是否存在以 `name` 最后一段命名的 class/struct？ */
function cppClassExists(name: string, ref: UnresolvedRef, context: ResolutionContext): boolean {
  const last = cppLastSegment(name);
  return context
    .getNodesByName(last)
    .some((n) => (n.kind === 'class' || n.kind === 'struct') && n.language === ref.language);
}

/**
 * 使用提取时捕获的返回类型，推断 C++ 调用/构造表达式产生的类（#645）。
 * 按顺序处理：
 *   - `make_unique<T>()` / `make_shared<T>()`        → T
 *   - 单层成员调用 `recv.method()`                   → recv 的类型，再到方法的返回类型
 *   - `Class::method()` / 自由 `func()`              → 被调用者记录的返回类型
 *   - 直接构造 `Type()` / `ns::Type()`               → Type
 * 无法确定时返回 null。调用方在创建边之前仍须验证外部方法存在于结果上，
 * 因此错误推断保持静默。
 */
function resolveCppCallResultType(
  inner: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
): string | null {
  if (depth > 3) return null; // 防止病态的相互递归
  const expr = inner.trim();

  const make = expr.match(/(?:^|::)(?:make_unique|make_shared)\s*<\s*([A-Za-z_]\w*)/);
  if (make) return make[1] ?? null;

  // 单层成员调用 `recv.method`（`manager.view().render()` 形式）。
  const dotIdx = expr.lastIndexOf('.');
  if (dotIdx > 0) {
    const recv = expr.slice(0, dotIdx);
    const method = expr.slice(dotIdx + 1);
    if (recv.includes('.') || recv.includes('(') || recv.includes('::')) return null; // single level only
    const recvType = inferCppReceiverType(recv, ref, context, depth + 1);
    if (!recvType) return null;
    return lookupCalleeReturnType(`${recvType}::${method}`, ref, context);
  }

  const ret = lookupCalleeReturnType(expr, ref, context);
  if (ret) return ret;

  // 直接构造——被调用者本身命名一个 class/struct。
  if (cppClassExists(expr, ref, context)) return cppLastSegment(expr);

  return null;
}

/**
 * 从声明行的初始化表达式恢复 `auto` 声明局部变量的类型——
 * `auto x = Foo::instance();`、`auto w = make_unique<W>();`、
 * `auto p = new W();`、`auto w = Widget();`（#645）。
 */
function inferCppAutoInitializerType(
  line: string,
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth: number,
): string | null {
  const escaped = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = line.match(new RegExp(`\\b${escaped}\\b\\s*=\\s*([^;]+)`));
  if (!m || !m[1]) return null;
  const init = m[1].trim();

  const neu = init.match(/^new\s+([A-Za-z_][\w:]*)/);
  if (neu && neu[1]) return cppLastSegment(neu[1]);

  // 调用或构造：`Foo(...)`、`A::b(...)`、`make_unique<T>(...)`。
  const call = init.match(/^([A-Za-z_][\w:]*(?:\s*<[^>;]*>)?)\s*\(/);
  if (call && call[1]) return resolveCppCallResultType(call[1].replace(/\s+/g, ''), ref, context, depth + 1);

  return null;
}

/**
 * 解析接收者本身也是调用的 C++ 链式调用——由提取器编码为
 * `<innerCallee>().<method>`（#645）。接收者的类型是内层调用的返回类型；
 * 外层方法随后在其上解析并 VALIDATED（resolveMethodOnType 要求 `cls::method` 存在），
 * 因此错误推断不会产生边，而是静默处理。
 */
export function matchCppCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const cls = resolveCppCallResultType(m[1], ref, context);
  if (!cls) return null;
  return resolveMethodOnType(cls, m[2], ref, context, 0.85, 'instance-method');
}

/**
 * 解析接收者为作用域/静态调用的 `::` 工厂链——
 * PHP 的 `Cls::for($x)->method()`（#608，按凭证的 Laravel 客户端惯用法）
 * 或 Rust 的 `Foo::new().bar()`（关联函数调用）——
 * 两者均由提取器编码为 `Cls::factory().method`。
 * 接收者的类型是 `Cls::factory` 的返回类型：`self` 标记
 * （PHP `: self`/`: static`，Rust `-> Self`）解析到工厂自身的类型，
 * 具体返回类型解析到该类型。外层方法随后在其上解析并 VALIDATED
 * （resolveMethodOnType 要求方法存在于该类型或其遵循的超类型上），
 * 因此错误推断不会产生边。由 `::` 接收者语言（PHP、Rust）共用。
 */
export function matchScopedCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const inner = m[1];
  const method = m[2];
  if (!inner.includes('::')) return null; // 仅静态工厂（`Cls::method`）链
  const factoryClass = inner.slice(0, inner.lastIndexOf('::'));
  const ret = lookupCalleeReturnType(inner, ref, context);
  if (!ret) return null;
  // `self`（提取器对 self/static/$this 的标记）→ 工厂的类。
  const resolvedClass = ret === 'self' ? factoryClass : ret;
  return resolveMethodOnType(resolvedClass, method, ref, context, 0.85, 'instance-method');
}

/**
 * 未前缀大写调用 `Foo(args)` 构造该类的语言
 * （即 `Foo(args).method()` 接收者的类型为 `Foo`）。
 * Java/C# 需要 `new`，因此裸 `Foo()` 是方法调用而非构造——已排除。
 * Scala 的 `Foo(args)` 是 case class / companion `apply`，按惯例返回 `Foo`——
 * resolveMethodOnType 会验证，因此返回其他类型的非惯例 `apply` 只会不产生边而非错误边。
 * Pascal/Delphi：`TFoo(x)` 是结果为 `TFoo` 的类型转换，
 * 因此 `TFoo(x).method()` 在 `TFoo` 上解析方法——形状相同，验证相同。
 */
const CONSTRUCTS_VIA_BARE_CALL = new Set(['kotlin', 'swift', 'scala', 'dart', 'pascal']);

/**
 * 解析接收者为静态工厂/流式调用的点式链式调用——
 * `Foo.getInstance().bar()`，由提取器编码为 `Foo.getInstance().bar`
 * （#645/#608 机制）。接收者的类型是 `Foo.getInstance` 的返回类型
 * （其声明的返回类型）；外层方法随后在其上解析并 VALIDATED
 * （resolveMethodOnType 要求 `Type::method` 存在），
 * 因此错误推断不会产生边（例如不相关类上的同名 `bar()` 永远不会被匹配）。
 * 由点记法语言（Java、Kotlin、C#、Swift）共用——
 * 相同的接收者形状，相同的 `Class::method` 限定名。
 */
export function matchDottedCallChain(
  ref: UnresolvedRef,
  context: ResolutionContext,
): ResolvedRef | null {
  const m = ref.referenceName.match(/^(.+)\(\)\.(\w+)$/);
  if (!m || !m[1] || !m[2]) return null;
  const inner = m[1]; // `Foo.getInstance`
  const method = m[2]; // `bar`
  const lastDot = inner.lastIndexOf('.');

  if (lastDot <= 0) {
    // Go：裸包级工厂函数 `New().method()` —— 接收者的类型是
    // `New` 的返回类型；在其上解析方法。
    if (ref.language === 'go') {
      const ret = lookupCalleeReturnType(inner, ref, context);
      if (ret) {
        return resolveMethodOnType(ret, method, ref, context, 0.85, 'instance-method', importedFqnOf(ret, ref, context));
      }
      // `inner` 不是带有捕获返回类型的函数——通常是持有函数值的包级
      // 变量（如 gin 的 `engine()`），其类型无法恢复。
      // 回退到方法的裸名解析，以免丢失原本能找到的边。
      // （当 `inner` 确实是真实工厂函数但方法不存在于其返回类型上时，
      // `ret` 为真值，上面已返回无边——缺失方法的安全保证得以保留。）
      //
      // 关键：通过合成的裸名 ref 解析目标，但返回绑定到原始 `ref`
      // （referenceName 为 `inner().method`）的匹配。批量解析器
      // （resolveAndPersistBatched）每遍从偏移 0 读取未解析行，
      // 依赖 deleteSpecificResolvedReferences——以 referenceName 为键——
      // 清除每个已解析行，使批次清空。
      // 如果将合成 ref 的裸 `method` 作为 `.original` 传播，
      // 删除操作永远不会匹配存储的 `inner().method` 行，
      // 批次永远不会排空，循环会反复解析+插入（一个失控循环，
      // 在此修复之前将 gin 的图增长到 500 万条边 / 1.4 GB）。
      const bareRef = { ...ref, referenceName: method };
      const bareMatch = matchByExactName(bareRef, context) ?? matchFuzzy(bareRef, context);
      return bareMatch ? { ...bareMatch, original: ref } : null;
    }
    // 构造函数接收者 `Foo(args).method()`（编码为 `Foo().method`）：
    // 裸大写内层是类构造，因此接收者类型就是该类本身——
    // 在其上解析方法。仅适用于未前缀大写调用构造类的语言（Kotlin、Swift）；
    // 在 Java/C# 中裸 `Foo()` 是方法调用（构造需要 `new`），
    // 因此不能假定为构造。小写裸内层是无法恢复类型的顶层 `factory().method()`——退出。
    if (!CONSTRUCTS_VIA_BARE_CALL.has(ref.language) || !/^[A-Z]/.test(inner)) return null;
    return resolveMethodOnType(inner, method, ref, context, 0.85, 'instance-method', importedFqnOf(inner, ref, context));
  }

  // 工厂/流式接收者 `Receiver.factory(args).method()`：
  // 接收者类型是 `Receiver.factory` 的返回类型（其声明的返回类型）。
  const factoryClass = inner.slice(0, lastDot).split('.').pop(); // 简单类名
  const factoryMethod = inner.slice(lastDot + 1);
  if (!factoryClass || !factoryMethod) return null;
  const ret = lookupCalleeReturnType(`${factoryClass}::${factoryMethod}`, ref, context);
  if (!ret) {
    // Objective-C：类消息工厂——`[X alloc]`、`[X new]`、`[X sharedFoo]`——
    // 按惯例返回接收者类 `X` 的实例（`instancetype`）。
    // 因此当工厂自身的返回类型无法恢复时（其选择器返回 `instancetype`，
    // 或 `alloc`/`new` 根本不是用户定义的节点），
    // 接收者类型就是类 `X` 本身。
    // 这解析了无处不在的 `[[X alloc] init]` 和单例链。
    // resolveMethodOnType 针对 X（及其超类型）进行验证，
    // 因此方法实际上定义在别处的类不会产生边——
    // 关键是当具体返回类型已被捕获但只是缺少该方法时，此处不会触发
    // （已在上面返回 null：缺失方法安全性，同名诱饵永远不会被匹配）。
    if (ref.language === 'objc' && /^[A-Z]/.test(factoryClass)) {
      return resolveMethodOnType(factoryClass, method, ref, context, 0.8, 'instance-method', importedFqnOf(factoryClass, ref, context));
    }
    // Pascal/Delphi：提取器只重新编码 `TFoo`/`IFoo` 前缀的链
    // （类型命名惯例），因此 `factoryClass` 在此始终是真实类。
    // 未捕获返回类型的工厂是构造函数
    // （`TFileMem.Create().SetCachePerformance` —— `constructor Create` 没有 `: TBar`
    // 注解但返回自身类），或未注解的函数。
    // 两种情况下接收者类型都是类本身，因此在 `factoryClass` 上解析方法。
    // resolveMethodOnType 针对它（及其超类型）验证，
    // 因此错误推断不产生边——且当返回类型已被捕获但缺少方法时绝不触发
    // （上面的缺失方法安全性）。
    if (ref.language === 'pascal' && /^[TI]/.test(factoryClass)) {
      return resolveMethodOnType(factoryClass, method, ref, context, 0.8, 'instance-method', importedFqnOf(factoryClass, ref, context));
    }
    return null;
  }
  return resolveMethodOnType(ret, method, ref, context, 0.85, 'instance-method', importedFqnOf(ret, ref, context));
}

/**
 * 当多个类共享同一简单类型名时，调用方文件对该类型的 import 是
 * 命名*哪一个*的唯一信号（#314）。
 * 返回 ref 所在文件中 `typeName` 对应的已导入 FQN，或 undefined。
 */
function importedFqnOf(
  typeName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | undefined {
  const imports = context.getImportMappings(ref.filePath, ref.language);
  return imports.find((i) => i.localName === typeName)?.source;
}

/**
 * Java/Kotlin：通过遍历调用点所在类的字段声明来推断接收者的声明类型。
 * 字段的 `signature` 已经是 "<TypeName> <fieldName>" 的形式
 * （由 tree-sitter.ts 的 extractField 设置），因此从中提取类型。
 * 处理 Spring `@Resource UserBO userbo;` / `@Autowired private UserService userService;`
 * 的情况，其中接收者字段名与类名不符合 Java 命名惯例。
 *
 * 返回裸类型名（去掉泛型、去掉点分包名），或在封闭类中未找到匹配字段时返回 null。
 */
function inferJavaFieldReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  const inFile = context.getNodesInFile(ref.filePath);
  if (inFile.length === 0) return null;

  // 找到包含调用行的类（最紧的匹配，按最晚开始行）。
  let enclosing: Node | null = null;
  for (const n of inFile) {
    if (n.kind !== 'class' && n.kind !== 'interface') continue;
    if (n.language !== ref.language) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= ref.line && end >= ref.line) {
      if (!enclosing || n.startLine >= enclosing.startLine) enclosing = n;
    }
  }
  if (!enclosing) return null;

  const enclosingEnd = enclosing.endLine ?? enclosing.startLine;
  const field = inFile.find(
    (n) =>
      n.kind === 'field' &&
      n.name === receiverName &&
      n.language === ref.language &&
      n.startLine >= enclosing.startLine &&
      (n.endLine ?? n.startLine) <= enclosingEnd,
  );
  if (!field || !field.signature) return null;

  // 签名形式：`<TypeName> <fieldName>`（extractField）。提取类型，
  // 去掉泛型 + 点分包名，去除数组/可变参数标记。
  const beforeName = field.signature.slice(
    0,
    field.signature.lastIndexOf(field.name),
  );
  const typeRaw = beforeName.trim();
  if (!typeRaw) return null;

  const typeNoGenerics = typeRaw.replace(/<[^>]*>/g, '').trim();
  const typeNoArray = typeNoGenerics.replace(/\[\s*\]/g, '').replace(/\.\.\.$/, '').trim();
  const parts = typeNoArray.split(/[.\s]+/).filter(Boolean);
  const lastPart = parts[parts.length - 1];
  if (!lastPart) return null;
  if (!/^[A-Z]/.test(lastPart)) return null; // 原始类型 / 小写 → 跳过
  return lastPart;
}

/**
 * 尝试通过类/对象上的方法名解析引用
 */
export function matchMethodCall(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // 解析方法调用模式，如 "obj.method" 或 "Class::method"。
  // 方法部分允许尾随 `:` 关键字，以便 Objective-C 选择器能够解析
  // （`SDImageCache.storeImage:`、`obj.setX:y:`）；冒号在其他语言的方法引用中
  // 从不出现，因此对它们是无操作。
  // 接收者允许点（`builder.Services.AddCoreServices`），
  // 使链式调用能通过最后一段解析——下面的策略 3 按名称匹配方法
  // （使用已有的单候选 / 接收者重叠守卫）。没有此项，
  // 多点扩展方法调用（C# DI 的 `builder.Services.AddCoreServices()`、
  // `Guard.Against.X()`）不匹配任何模式，永远无法解析。
  const dotMatch = ref.referenceName.match(/^([\w.]+)\.(\w+:?(?:\w+:)*)$/);
  const colonMatch = ref.referenceName.match(/^(\w+)::(\w+)$/);

  const match = dotMatch || colonMatch;
  if (!match) {
    return null;
  }

  const [, objectOrClass, methodName] = match;

  if (ref.language === 'cpp' && dotMatch) {
    const inferredType = inferCppReceiverType(objectOrClass!, ref, context);
    if (inferredType) {
      const typedMatch = resolveMethodOnType(
        inferredType,
        methodName!,
        ref,
        context,
        0.9,
        'instance-method',
      );
      if (typedMatch) {
        return typedMatch;
      }
    }
  }

  // Java/Kotlin：接收者可能是字段，其名称不符合 Java 命名惯例中与类型对应的形式
  // （`userbo` → 类 `UserBO`，缩写形式）。在封闭类中查找字段以获取其声明类型，
  // 然后在该类型上解析方法。涵盖 Spring `@Resource`/`@Autowired` 字段注入，
  // 其中字段类型是具体 bean 类。
  if ((ref.language === 'java' || ref.language === 'kotlin') && dotMatch) {
    const inferredType = inferJavaFieldReceiverType(objectOrClass!, ref, context);
    if (inferredType) {
      // 当两个类共享同一简单名时，调用方文件的 import 是
      // 命名哪一个的唯一信号——传入已导入的 FQN 以便
      // resolveMethodOnType 能消歧（#314）。
      const imports = context.getImportMappings(ref.filePath, ref.language);
      const importedFqn = imports.find((i) => i.localName === inferredType)?.source;
      const typedMatch = resolveMethodOnType(
        inferredType,
        methodName!,
        ref,
        context,
        0.9,
        'instance-method',
        importedFqn,
      );
      if (typedMatch) {
        return typedMatch;
      }
    }
  }

  // 策略 1：直接类名匹配（现有逻辑）
  const classCandidates = context.getNodesByName(objectOrClass!);

  for (const classNode of classCandidates) {
    if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
      // 跳过跨语言的类匹配
      if (classNode.language !== ref.language) continue;

      const nodesInFile = context.getNodesInFile(classNode.filePath);
      const methodNode = nodesInFile.find(
        (n) =>
          n.kind === 'method' &&
          n.name === methodName &&
          n.qualifiedName.includes(classNode.name)
      );

      if (methodNode) {
        return {
          original: ref,
          targetNodeId: methodNode.id,
          confidence: 0.85,
          resolvedBy: 'qualified-name',
        };
      }
    }
  }

  // 策略 2：实例变量接收者——尝试大写形式查找类
  // 例如，"permissionEngine" → 查找包含 "PermissionEngine" 的类
  const capitalizedReceiver = objectOrClass!.charAt(0).toUpperCase() + objectOrClass!.slice(1);
  if (capitalizedReceiver !== objectOrClass) {
    const fuzzyClassCandidates = context.getNodesByName(capitalizedReceiver);
    for (const classNode of fuzzyClassCandidates) {
      if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
        // 跳过跨语言的类匹配
        if (classNode.language !== ref.language) continue;

        const nodesInFile = context.getNodesInFile(classNode.filePath);
        const methodNode = nodesInFile.find(
          (n) =>
            n.kind === 'method' &&
            n.name === methodName &&
            n.qualifiedName.includes(classNode.name)
        );

        if (methodNode) {
          return {
            original: ref,
            targetNodeId: methodNode.id,
            confidence: 0.8,
            resolvedBy: 'instance-method',
          };
        }
      }
    }
  }

  // 策略 3：按名称在代码库中查找方法，通过接收者名称与包含类名的相似度匹配。
  // 处理缩写变量名，如 permissionEngine → PermissionRuleEngine。
  if (methodName) {
    const methodCandidates = context.getNodesByName(methodName!);
    const methods = methodCandidates.filter(
      (n) => n.kind === 'method' && n.name === methodName
    );

    // 优先过滤同语言候选项
    const sameLanguageMethods = methods.filter(m => m.language === ref.language);
    const targetMethods = sameLanguageMethods.length > 0 ? sameLanguageMethods : methods;

    // 仅有一个同语言同名方法时使用它
    if (targetMethods.length === 1 && targetMethods[0]!.language === ref.language) {
      return {
        original: ref,
        targetNodeId: targetMethods[0]!.id,
        confidence: 0.7,
        resolvedBy: 'instance-method',
      };
    }

    // 多个方法：按接收者名称词与类名的重叠程度打分
    if (targetMethods.length > 1) {
      const receiverWords = splitCamelCase(objectOrClass!);
      let bestMatch: typeof targetMethods[0] | undefined;
      let bestScore = 0;

      for (const method of targetMethods) {
        const classWords = splitCamelCase(method.qualifiedName);
        let score = receiverWords.filter(w =>
          classWords.some(cw => cw.toLowerCase() === w.toLowerCase())
        ).length;
        // 同语言加分
        if (method.language === ref.language) score += 1;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = method;
        }
      }

      if (bestMatch && bestScore >= 2) {
        return {
          original: ref,
          targetNodeId: bestMatch.id,
          confidence: 0.65,
          resolvedBy: 'instance-method',
        };
      }
    }
  }

  return null;
}

/**
 * 将 camelCase 或 PascalCase 字符串拆分为单词列表。
 */
function splitCamelCase(str: string): string[] {
  return str.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._:\/\\]+/)
    .filter(w => w.length > 1);
}

/**
 * 计算两个文件路径之间的目录接近度。
 * 根据共享目录段数返回分数。
 * 分数越高，在目录树中越接近。
 */
function computePathProximity(filePath1: string, filePath2: string): number {
  const dir1 = filePath1.split('/').slice(0, -1);
  const dir2 = filePath2.split('/').slice(0, -1);

  let shared = 0;
  for (let i = 0; i < Math.min(dir1.length, dir2.length); i++) {
    if (dir1[i] === dir2[i]) {
      shared++;
    } else {
      break;
    }
  }

  // 每个共享目录段贡献 15 分，上限 80
  return Math.min(shared * 15, 80);
}

/**
 * 当有多个候选项时，查找最佳匹配节点
 */
function findBestMatch(
  ref: UnresolvedRef,
  candidates: Node[],
  _context: ResolutionContext
): Node | null {
  // 优先级规则：
  // 1. 同文件 > 不同文件
  // 2. 目录接近度（同模块/包 > 不同模块）
  // 3. 同语言 > 不同语言
  // 4. 函数/方法 > 类/类型（用于调用引用）
  // 5. 已导出 > 未导出

  let bestScore = -1;
  let bestNode: Node | null = null;

  for (const candidate of candidates) {
    let score = 0;

    // 同文件加分
    if (candidate.filePath === ref.filePath) {
      score += 100;
    }

    // 目录接近度加分——强烈偏向同模块/包
    score += computePathProximity(ref.filePath, candidate.filePath);

    // 语言匹配：强烈偏向同语言，惩罚跨语言
    if (candidate.language === ref.language) {
      score += 50;
    } else {
      score -= 80;
    }

    // 对于调用引用，偏向函数/方法
    if (ref.referenceKind === 'calls') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      }
    }

    // 对于实例化引用（`new Foo()`），偏向类型目标——
    // 否则另一模块中名为 `Foo` 的函数可能超过实际类的得分。
    if (ref.referenceKind === 'instantiates') {
      if (
        candidate.kind === 'class' ||
        candidate.kind === 'struct' ||
        candidate.kind === 'interface'
      ) {
        score += 25;
      }
    }

    // 对于装饰器引用（`@Foo`），偏向函数。类装饰器
    // （Python 的 `@SomeClass`、Java 注解接口）也在此解析，
    // 因此类的加分较小。
    if (ref.referenceKind === 'decorates') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      } else if (candidate.kind === 'class' || candidate.kind === 'interface') {
        score += 15;
      }
    }

    // 已导出加分
    if (candidate.isExported) {
      score += 10;
    }

    // 更近的行号加分（同文件内）
    if (candidate.filePath === ref.filePath && candidate.startLine) {
      const distance = Math.abs(candidate.startLine - ref.line);
      score += Math.max(0, 20 - distance / 10);
    }

    if (score > bestScore) {
      bestScore = score;
      bestNode = candidate;
    }
  }

  return bestNode;
}

/**
 * 模糊匹配——最后手段，置信度较低
 */
export function matchFuzzy(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const lowerName = ref.referenceName.toLowerCase();

  // 使用预构建的小写索引进行 O(1) 查找，而非扫描所有节点
  const candidates = context.getNodesByLowerName(lowerName);

  // 仅过滤可调用类型（function、method、class）
  const callableKinds = new Set(['function', 'method', 'class']);
  const callableCandidates = applyLanguageGate(candidates.filter((n) => callableKinds.has(n.kind)), ref);

  // 优先选择同语言匹配
  const sameLanguageCandidates = callableCandidates.filter(n => n.language === ref.language);
  const finalCandidates = sameLanguageCandidates.length > 0 ? sameLanguageCandidates : callableCandidates;

  if (finalCandidates.length === 1) {
    const isCrossLanguage = finalCandidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: finalCandidates[0]!.id,
      confidence: isCrossLanguage ? 0.3 : 0.5,
      resolvedBy: 'fuzzy',
    };
  }

  return null;
}

/**
 * 按置信度顺序依次尝试所有匹配策略
 */
export function matchReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // 函数即值引用（#756）仅通过专用匹配器解析——
  // 永远不走下面的模糊/限定名回退（错误的回调边比没有边更糟）。
  if (ref.referenceKind === 'function_ref') {
    return matchFunctionRef(ref, context);
  }

  // 按置信度顺序依次尝试各策略
  let result: ResolvedRef | null;

  // 0. 文件路径匹配（如 "snippets/drawer-menu.liquid" → 文件节点）
  result = matchByFilePath(ref, context);
  if (result) return result;

  // 1. 限定名匹配（最高置信度）
  result = matchByQualifiedName(ref, context);
  if (result) return result;

  // 1b. C++ 链式调用，其接收者是另一个调用——`Foo::instance().bar()`
  // 由提取器编码为 `Foo::instance().bar`（#645）。
  // 从内层调用的返回类型推断接收者类型，再在其上解析方法。
  if (ref.language === 'cpp' || ref.language === 'c') {
    result = matchCppCallChain(ref, context);
    if (result) return result;
  }

  // 1c. `::` 作用域工厂链——PHP 的 `Cls::for($x)->method()`（#608）或 Rust 的
  // `Foo::new().bar()`，均编码为 `Cls::factory().method`。
  // 接收者类型是工厂的 `self`（PHP `: self`/`: static`，Rust `-> Self`）
  // 或具体返回类型。
  if (ref.language === 'php' || ref.language === 'rust') {
    result = matchScopedCallChain(ref, context);
    if (result) return result;
  }

  // 1d. 点式链式静态工厂/流式调用（Java / Kotlin / C# / Swift /
  // Go / Scala / Dart / Objective-C）——`Foo.getInstance().bar()` 编码为
  // `Foo.getInstance().bar`，Go 的裸工厂 `New().Method()` 编码为 `New().Method`，
  // Scala 的 companion 工厂，Dart 的静态工厂/工厂构造函数，或
  // ObjC 的链式消息发送 `[[Foo create] doIt]` 编码为 `Foo.create().doIt`
  // （#645/#608 机制）。从内层调用的声明返回类型推断方法所属类，再验证。
  if (
    ref.language === 'java' ||
    ref.language === 'kotlin' ||
    ref.language === 'csharp' ||
    ref.language === 'swift' ||
    ref.language === 'go' ||
    ref.language === 'scala' ||
    ref.language === 'dart' ||
    ref.language === 'objc' ||
    ref.language === 'pascal'
  ) {
    result = matchDottedCallChain(ref, context);
    if (result) return result;
  }

  // 2. 方法调用模式匹配
  result = matchMethodCall(ref, context);
  if (result) return result;

  // 3. 精确名称匹配
  result = matchByExactName(ref, context);
  if (result) return result;

  // 4. 模糊匹配（最低置信度）
  result = matchFuzzy(ref, context);
  if (result) return result;

  return null;
}
