/**
 * React Native 跨语言桥接解析器。
 *
 * 弥合 React Native 项目中 JS ↔ 原生代码的流程断层。覆盖范围：
 *
 * **Legacy bridge**（旧版 / 中等层次 RN 库中仍普遍使用）：
 *   - ObjC：`RCT_EXPORT_MODULE([opt_name])` 声明模块；未传参时模块名
 *     默认为类名去掉 `RCT` 前缀。`RCT_EXPORT_METHOD(selector:(args))` 声明
 *     一个 JS 可调用方法，其 JS 名称为 selector 的第一个关键字。
 *     `RCT_REMAP_METHOD(jsName, nativeSelector:(args))` 显式覆盖 JS 名称。
 *   - Java/Kotlin：`ReactContextBaseJavaModule` 子类上以 `@ReactMethod` 注解的
 *     方法；模块名来自 `getName()` 返回的字符串字面量。
 *
 * **TurboModules**（现代方式，react-native-svg、screens、FBSDK 下一代库使用）：
 *   - 在 `Native<X>.ts` 文件中声明的 TS spec 接口，导出
 *     `TurboModuleRegistry.getEnforcing<Spec>('<ModuleName>')`（或
 *     `.get<Spec>('<ModuleName>')`）。Spec 接口方法是 JS 可调用的接口；
 *     对应的原生实现是一个方法名与之匹配的类（ObjC 用 selector 首关键字，
 *     Kotlin/Java 用标识符）。
 *
 * 两种机制具有相同的终态形状：从 `(moduleName, jsMethodName)` 到原生方法节点的
 * 映射，以及一个仅含 `jsMethodName` 的较小映射，用于 JS 调用点不带模块限定符的
 * 情况（最常见的 JS 模式是
 * `import Geo from './NativeGeolocation'; Geo.getPosition()`——接收者是默认导出，
 * 而非字面的 `NativeModules.<Mod>`，因此按方法名查找才是实际生效的解析方式）。
 *
 * **未覆盖**（按设计文档 §6 推迟到后续阶段）：
 *   - Fabric 视图组件（`RCT_EXPORT_VIEW_PROPERTY` / Codegen 视图规范）——
 *     这些将 JSX props 连接到原生渲染器，流程形状不同，与现有 JSX 合成器组合。
 *   - 原生 → JS 事件（`RCTEventEmitter` / `NativeEventEmitter`）——
 *     属于回调合成器的跨语言通道。
 */
import type { Node } from '../../types';
import {
  FrameworkResolver,
  ResolutionContext,
} from '../types';

/**
 * 解析器已知的一个原生 RN 方法。按 JS 可见名称建立索引。
 */
interface NativeMethod {
  /** 从 JS 可见的模块名（`Geolocation`、`RNSVGRenderableModule` 等）。 */
  moduleName: string;
  /** JS 可见的方法名。 */
  jsName: string;
  /** 原生实现节点（ObjC 方法 / Java 方法 / Kotlin 函数）。 */
  node: Node;
}

/** 每个 context 的惰性映射缓存。 */
const nativeMethodMaps: WeakMap<
  ResolutionContext,
  { byJsName: Map<string, NativeMethod[]> }
> = new WeakMap();

// ─── 原生侧提取 ─────────────────────────────────────────────────────────────

/**
 * 当 `RCT_EXPORT_MODULE()` 无参数时，ObjC 模块名的默认值：
 * 从类名中去掉前导 `RCT` 前缀（Apple 的约定），将余下部分作为 JS 可见的模块名。
 * `RCTGeolocation` → `Geolocation`。不带 `RCT` 前缀的类名原样返回。
 */
function defaultObjcModuleName(className: string): string {
  return className.startsWith('RCT') && className.length > 3
    ? className.slice(3)
    : className;
}

/**
 * 解析 ObjC `.m`/`.mm` 文件中的 `RCT_EXPORT_MODULE` 和
 * `RCT_EXPORT_METHOD` / `RCT_REMAP_METHOD` 声明，返回推断出的
 * (moduleName, jsMethodName) 对。
 *
 * 宏的形式（每个文件通常只有一个 `RCT_EXPORT_MODULE`，对应一个 `@implementation`）：
 *   - `RCT_EXPORT_MODULE()` — 模块名 = 去掉 `RCT` 前缀的类名
 *   - `RCT_EXPORT_MODULE(jsName)` — 显式名称
 *   - `RCT_EXPORT_METHOD(selector:(arg1)label1:(arg2)label2)` — JS 名称 =
 *     `selector`（第一个关键字）
 *   - `RCT_REMAP_METHOD(jsName, selector:(arg1)label1:(arg2)label2)` —
 *     JS 名称 = 字面量 `jsName`
 *
 * 基于正则的扫描已足够——这些宏形式高度程式化，出现在顶层。
 * 从完整 AST 中提取它们需要 tree-sitter 语法不支持的宏感知 ObjC 解析。
 */
function parseObjcRNExports(
  source: string,
  className: string | null
): Array<{ moduleName: string; jsName: string; nativeSelectorFirstKw: string; line: number }> {
  const results: Array<{ moduleName: string; jsName: string; nativeSelectorFirstKw: string; line: number }> = [];

  // RCT_EXPORT_MODULE — 按约定每个文件只有一个。捕获可选参数。
  const moduleMatch = source.match(/RCT_EXPORT_MODULE\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\)/);
  // 需要模块名才能归属方法。优先使用宏的显式参数，
  // 其次是类名，否则放弃（无模块名 = 无可注册内容）。
  const moduleName =
    moduleMatch?.[1] ??
    (className ? defaultObjcModuleName(className) : null);
  if (!moduleName) return results;

  const lineOf = (idx: number): number => {
    let line = 1;
    for (let i = 0; i < idx && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
    return line;
  };

  // RCT_EXPORT_METHOD(selectorFirstKw:(args)…)
  // 第一个关键字（冒号或左括号前的所有内容）是 JS 可见名称。
  // 不尝试解析完整的多关键字 selector——RN 的 JS 视图只使用第一个关键字。
  const exportRegex = /RCT_EXPORT_METHOD\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = exportRegex.exec(source)) !== null) {
    const kw = m[1];
    if (kw) results.push({ moduleName, jsName: kw, nativeSelectorFirstKw: kw, line: lineOf(m.index) });
  }

  // RCT_REMAP_METHOD(jsName, nativeSelectorFirstKw:(args)…)
  const remapRegex =
    /RCT_REMAP_METHOD\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  while ((m = remapRegex.exec(source)) !== null) {
    const jsName = m[1];
    const nativeKw = m[2];
    if (jsName && nativeKw) {
      results.push({ moduleName, jsName, nativeSelectorFirstKw: nativeKw, line: lineOf(m.index) });
    }
  }

  return results;
}

/**
 * 在 ObjC `.m`/`.mm` 文件中查找 `@implementation` 的类名——当
 * `RCT_EXPORT_MODULE()` 无参数时用作回退模块名。
 * （形如 `@implementation Foo (Bar)` 的 Category 在此正确捕获为 `Foo`，
 * 但 Category 文件通常不会放 `RCT_EXPORT_MODULE`。）
 */
function findObjcClassName(source: string): string | null {
  const m = source.match(/@implementation\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return m?.[1] ?? null;
}

/**
 * 解析 Java/Kotlin 源文件中以 `@ReactMethod` 注解的方法，以及外层类的
 * `getName()` 返回值（JS 可见的模块名）。
 *
 * Java：`@ReactMethod public void getCurrentPosition(Callback cb) { … }`
 * Kotlin：`@ReactMethod fun getCurrentPosition(cb: Callback) { … }`
 *
 * 类名来自 `class XxxModule extends ReactContextBaseJavaModule`（Java）
 * 或 `class XxxModule : ReactContextBaseJavaModule(...)`（Kotlin）。
 * JS 可见的模块名来自 `getName()` 返回的字符串字面量——若无法找到字面量，
 * 则回退为去掉 `Module` 后缀的类名。
 */
function parseJvmRNExports(
  source: string
): Array<{ moduleName: string; jsName: string }> {
  const results: Array<{ moduleName: string; jsName: string }> = [];

  // getName() 字面量——Java 和 Kotlin 的形式大致如下：
  //   public String getName() { return "Geolocation"; }
  //   fun getName(): String = "Geolocation"
  //   fun getName() = "Geolocation"
  const getName = source.match(
    /\bgetName\s*\([^)]*\)\s*(?::\s*String)?\s*(?:=\s*|\{[^}]*return\s*)"([^"]+)"/
  );
  // 类名回退。
  const classMatch =
    source.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*ReactContextBaseJavaModule/) ??
    source.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*ReactPackage/);
  const moduleName =
    getName?.[1] ?? (classMatch?.[1] ? classMatch[1].replace(/Module$/, '') : null);
  if (!moduleName) return results;

  // @ReactMethod 注解——其后（经过可选的修饰符/参数/换行后）紧跟
  // `void <name>(`（Java）或 `fun <name>(`（Kotlin）。
  const methodRegex =
    /@ReactMethod\b[^{]*?(?:\bfun\s+|\bvoid\s+|\bpublic\s+\w[\w<>\[\]]*\s+)([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = methodRegex.exec(source)) !== null) {
    const jsName = m[1];
    if (jsName) results.push({ moduleName, jsName });
  }

  return results;
}

/**
 * 解析 TS 文件中的 TurboModule spec 声明。spec 文件是新架构中
 * JS ↔ 原生的单一真相来源——其接口列出了所有 JS 可见方法，
 * `TurboModuleRegistry.get*<Spec>(...)` 的默认导出确定了模块名。
 *
 * 若文件不是 TurboModule spec，则返回 `null`。
 */
function parseTurboModuleSpec(
  source: string
): { moduleName: string; methods: string[] } | null {
  // `TurboModuleRegistry.getEnforcing<Spec>('ModuleName')` 或
  // `TurboModuleRegistry.get<Spec>('ModuleName')`。字面量必须使用
  // 单引号或双引号。
  const regMatch = source.match(
    /TurboModuleRegistry\.(?:getEnforcing|get)\s*<[^>]*>\s*\(\s*['"]([^'"]+)['"]\s*\)/
  );
  if (!regMatch || !regMatch[1]) return null;
  const moduleName = regMatch[1];

  // 查找 `export interface Spec extends TurboModule { … }` 并提取每个
  // 方法声明的名称。不需要类型，只需要名称。
  const ifaceMatch = source.match(
    /export\s+interface\s+Spec\b[^{]*\{([\s\S]*?)\n\}/
  );
  if (!ifaceMatch || !ifaceMatch[1]) return null;
  const body = ifaceMatch[1];

  const methods: string[] = [];
  // 方法形式：`name(args): ReturnType;` 或 `name(): void;`。跳过
  // 属性（冒号前无括号）。
  const methodRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = methodRegex.exec(body)) !== null) {
    const name = m[1];
    if (name) methods.push(name);
  }
  return { moduleName, methods };
}

// ─── 映射构建 ────────────────────────────────────────────────────────────────

/**
 * 每个 emitter 子类都继承的 `RCTEventEmitter` 内置方法。JS 代码不会直接调用
 * 这些方法——它们是 `NativeEventEmitter` 抽象的内部管道。若将它们保留在桥接映射中，
 * 每次 JS 调用 `addListener` / `remove`（Firestore 订阅者、RxJS 管道、
 * 普通 Array.remove 等）都会被错误地桥接到碰巧定义了这些方法的 emitter。
 * 在构建映射时跳过这些方法。
 */
const RN_EMITTER_BUILTINS = new Set([
  'addListener',
  'removeListeners',
  'remove',
  'invalidate',
  'startObserving',
  'stopObserving',
]);

function buildRNMaps(context: ResolutionContext): { byJsName: Map<string, NativeMethod[]> } {
  const cached = nativeMethodMaps.get(context);
  if (cached) return cached;

  const byJsName = new Map<string, NativeMethod[]>();
  const allFiles = context.getAllFiles();
  // 按名称预建原生方法索引，以便与桥接导出快速匹配。
  const objcMethodsByFirstKw = new Map<string, Node[]>();
  const jvmMethodsByName = new Map<string, Node[]>();
  for (const node of context.getNodesByKind('method')) {
    if (node.language === 'objc') {
      const firstKw = node.name.includes(':') ? node.name.split(':')[0] : node.name;
      if (firstKw) {
        const arr = objcMethodsByFirstKw.get(firstKw);
        if (arr) arr.push(node);
        else objcMethodsByFirstKw.set(firstKw, [node]);
      }
    } else if (node.language === 'java' || node.language === 'kotlin') {
      const arr = jvmMethodsByName.get(node.name);
      if (arr) arr.push(node);
      else jvmMethodsByName.set(node.name, [node]);
    }
  }

  for (const file of allFiles) {
    // Legacy bridge — ObjC 侧。
    if (file.endsWith('.m') || file.endsWith('.mm')) {
      const source = context.readFile(file);
      if (!source) continue;
      const className = findObjcClassName(source);
      const exports = parseObjcRNExports(source, className);
      for (const exp of exports) {
        if (RN_EMITTER_BUILTINS.has(exp.jsName)) continue;
        // 按 selector 首关键字解析到原生节点。多个 ObjC 方法可能在不同模块中
        // 共享同一首关键字；按文件路径过滤，将导出归属到本模块的实现文件。
        const candidates = objcMethodsByFirstKw.get(exp.nativeSelectorFirstKw) ?? [];
        const node = candidates.find((c) => c.filePath === file) ?? candidates[0];
        if (!node) continue;
        const entry: NativeMethod = { moduleName: exp.moduleName, jsName: exp.jsName, node };
        const arr = byJsName.get(exp.jsName);
        if (arr) arr.push(entry);
        else byJsName.set(exp.jsName, [entry]);
      }
    }

    // Legacy bridge — Java/Kotlin 侧。
    if (file.endsWith('.java') || file.endsWith('.kt')) {
      const source = context.readFile(file);
      if (!source) continue;
      const exports = parseJvmRNExports(source);
      for (const exp of exports) {
        if (RN_EMITTER_BUILTINS.has(exp.jsName)) continue;
        const candidates = jvmMethodsByName.get(exp.jsName) ?? [];
        const node = candidates.find((c) => c.filePath === file) ?? candidates[0];
        if (!node) continue;
        const entry: NativeMethod = { moduleName: exp.moduleName, jsName: exp.jsName, node };
        const arr = byJsName.get(exp.jsName);
        if (arr) arr.push(entry);
        else byJsName.set(exp.jsName, [entry]);
      }
    }

    // TurboModule spec — TS 侧。
    if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      const source = context.readFile(file);
      if (!source) continue;
      const spec = parseTurboModuleSpec(source);
      if (!spec) continue;
        // 对于每个 spec 方法，按名称查找匹配的原生实现。
        // spec 的模块名不能确定原生文件路径（Codegen 通过名称约定连接），
        // 因此在所有同名的原生方法中匹配。
      for (const methodName of spec.methods) {
        if (RN_EMITTER_BUILTINS.has(methodName)) continue;
        // ObjC 首关键字匹配，然后是 JVM 裸名匹配。不要求 ObjC 的模块名匹配，
        // 因为原生侧可能已去掉了前缀。
        const objcCands = objcMethodsByFirstKw.get(methodName) ?? [];
        const jvmCands = jvmMethodsByName.get(methodName) ?? [];
        for (const node of [...objcCands, ...jvmCands]) {
          const entry: NativeMethod = { moduleName: spec.moduleName, jsName: methodName, node };
          const arr = byJsName.get(methodName);
          if (arr) arr.push(entry);
          else byJsName.set(methodName, [entry]);
        }
      }
    }
  }

  const result = { byJsName };
  nativeMethodMaps.set(context, result);
  return result;
}

// ─── 解析器 ──────────────────────────────────────────────────────────────────

export const reactNativeBridgeResolver: FrameworkResolver = {
  name: 'react-native-bridge',
  // objc/mm 包含在内，使 `extract()` 能看到原生文件——`resolve()` 仍然
  // 只重定向 JS 调用方（对原生语言返回 null）。
  languages: ['javascript', 'typescript', 'tsx', 'jsx', 'objc'],

  /**
   * 提取 `RCT_EXPORT_METHOD` / `RCT_REMAP_METHOD` 声明为方法节点。这些宏被解析
   * 为宏表达式（ERROR 节点），而非 `method_definition`，因此 ObjC 提取器从未
   * 为它们生成节点——iOS 原生模块的一半不可见，JS 调用无法解析到它，
   * 跨平台配对也无从配对。节点以 JS 可见名称（selector 的首关键字，
   * 或 `RCT_REMAP_METHOD` 中的显式 JS 名称）命名，以与 Android 的
   * `@ReactMethod` 方法匹配。
   */
  extract(filePath, source) {
    if (!filePath.endsWith('.m') && !filePath.endsWith('.mm')) return { nodes: [], references: [] };
    if (!/RCT_EXPORT_MODULE\b/.test(source)) return { nodes: [], references: [] };
    const exports = parseObjcRNExports(source, findObjcClassName(source));
    const now = Date.now();
    const nodes: Node[] = [];
    const seen = new Set<string>();
    for (const e of exports) {
      if (seen.has(e.jsName)) continue;
      seen.add(e.jsName);
      nodes.push({
        id: `rn-export:${filePath}:${e.moduleName}.${e.jsName}`,
        kind: 'method',
        name: e.jsName,
        qualifiedName: `${filePath}::${e.moduleName}.${e.jsName}`,
        filePath,
        language: 'objc',
        startLine: e.line,
        endLine: e.line,
        startColumn: 0,
        endColumn: 0,
        isExported: true,
        docstring: `RCT_EXPORT_METHOD ${e.nativeSelectorFirstKw} (module ${e.moduleName})`,
        signature: `RCT_EXPORT_METHOD(${e.nativeSelectorFirstKw}:…)`,
        updatedAt: now,
      });
    }
    return { nodes, references: [] };
  },

  /**
   * 检测：package.json 依赖 `react-native`，或任何源文件使用了
   * `RCT_EXPORT_MODULE` / `RCT_EXPORT_METHOD` /
   * `TurboModuleRegistry` 标记。任一信号均满足条件——不同的库将 JS 包与
   * 原生代码分离（`react-native-svg` 的 apple/ + android/ 目录 vs 其 src/），
   * 因此不要求两者同时存在。
   */
  detect(context) {
    const pkg = context.readFile('package.json');
    if (pkg && /["']react-native["']\s*:/.test(pkg)) return true;
    // 回退：扫描少量文件中的宏标记——只检查 getAllFiles 返回的前几个文件，
    // 以保持 detect() 在大型仓库中的高效性。
    const files = context.getAllFiles();
    for (let i = 0; i < Math.min(files.length, 200); i++) {
      const f = files[i];
      if (!f) continue;
      if (f.endsWith('.mm') || f.endsWith('.m')) {
        const src = context.readFile(f);
        if (src && /RCT_EXPORT_MODULE\b/.test(src)) return true;
      }
      if (f.endsWith('.ts') || f.endsWith('.tsx')) {
        const src = context.readFile(f);
        if (src && /TurboModuleRegistry\.(?:get|getEnforcing)\s*</.test(src)) return true;
      }
    }
    return false;
  },

  claimsReference(_name) {
    // JS 可见的方法名是普通标识符，通常已在 `knownNames` 中（每个 TurboModule
    // spec 方法、每个 RCT_EXPORT_METHOD 都在某处有节点）。因此不需要通过
    // 预过滤器认领——引用会通过正常的 hasAnyPossibleMatch 路径到达本解析器。
    return false;
  },

  resolve(ref, context) {
    // 只重定向 JS 调用方——原生调用方不需要本解析器。
    if (
      ref.language !== 'javascript' &&
      ref.language !== 'typescript' &&
      ref.language !== 'tsx' &&
      ref.language !== 'jsx'
    ) {
      return null;
    }

    // JS 调用点的 `obj.method()` 以 `obj.method`（限定名）或 `method`（裸名）
    // 形式到达解析器。截取最后一个点之后的部分以获取 JS 可见的方法名。
    const name = ref.referenceName.includes('.')
      ? ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1)
      : ref.referenceName;

    const maps = buildRNMaps(context);
    const entries = maps.byJsName.get(name);
    if (!entries || entries.length === 0) return null;

    // 当 iOS（ObjC）和 Android 目标同时存在时，优先选择 iOS——iOS 是 RN
    // 库文档和大多数图查询的惯用首选平台。仍只记录一条边；
    // 若无 ObjC 目标，JVM 解析结果同样有效。
    const objc = entries.find((e) => e.node.language === 'objc');
    const target = objc ?? entries[0];
    if (!target) return null;
    return {
      original: ref,
      targetNodeId: target.node.id,
      confidence: 0.6,
      resolvedBy: 'framework',
    };
  },
};
