/**
 * Swift ↔ Objective-C 桥接规则。
 *
 * Apple 的自动桥接机制会按照确定性的选择器命名规则，将 Swift 声明暴露给
 * ObjC 运行时。完整规则集：
 * https://developer.apple.com/documentation/swift/importing-swift-into-objective-c
 *
 * 本模块是**纯名称计算**——给定 Swift 声明的基础名称及参数外部标签
 * （或原始签名文本），生成桥接后的 ObjC 选择器；给定 ObjC 选择器，
 * 生成候选的 Swift 基础名称。此处不涉及图/数据库访问。
 *
 * 由 `frameworks/swift-objc.ts`（将规则接入解析流水线的框架解析器）
 * 及其测试使用。
 *
 * ─── 桥接速查表 ─────────────────────────────────────────────────────────
 *
 *   Swift 声明                                    ObjC 选择器
 *   ─────────────────────────────────────────     ─────────────────────────
 *   func play()                                    play
 *   func play(_ song: String)                      play:
 *   func play(song: String)                        playWithSong:
 *   func play(_ song: String, by artist: String)   play:by:
 *   func play(song: String, by artist: String)     playWithSong:by:
 *   init(name: String)                             initWithName:
 *   init(name: String, age: Int)                   initWithName:age:
 *   var name: String  (getter / setter)            name  /  setName:
 *   @objc(custom:) func f(_ x: Int)                custom:        （字面量覆盖）
 *
 * 反向（ObjC → Swift）会折叠桥接：Swift 调用点对 `play(song:)` 的调用，
 * 在 tree-sitter 的 call_expression 中被解析为裸基础名称 `play`（参数标签
 * 从被调用名称中剥离）。因此 `swiftBaseNamesForObjcSelector('playWithSong:')`
 * 返回 `['play']`——解析器会查找名为 `play` 的 Swift 方法。
 */

/**
 * 将字符串首字符大写。用于当 Swift 声明含有显式的第一参数标签时，
 * 在选择器首关键字上添加 "With" 前缀
 * （例如 `func play(song:)` → `playWithSong:`）。
 */
function capFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * 将字符串首字符小写。用于反向转换：`setName:` setter ↔
 * Swift 属性 `name`。
 */
function lowerFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/**
 * 计算 Swift 方法声明自动桥接后的 ObjC 选择器。
 *
 * @param baseName  Swift 方法的基础名称（例如 `play`）。
 * @param externalLabels  按声明顺序排列的参数外部标签；
 *                        `null` 表示 `_`（无标签）参数；
 *                        `[]` 表示无参数方法。
 * @param explicitObjcName  若指定了 `@objc(customSel:)`，则为字面量选择器——
 *                          此时短路所有规则，直接原样返回。
 * @returns ObjC 选择器（例如 `playWithSong:by:`），若无法确定则返回 `null`。
 *
 * **方法规则：**
 * - 无参数 → 基础名称（无冒号）
 * - 单参数，`_` 标签 → `baseName:`
 * - 单参数，显式标签 `L` → `baseNameWithL:`
 * - 多参数，首标签为 `_` → `baseName:label2:label3:`
 * - 多参数，首标签为显式 `L1` → `baseNameWithL1:label2:label3:`
 *
 * 初始化方法规则由 `objcSelectorForSwiftInit` 处理。
 */
export function objcSelectorForSwiftMethod(
  baseName: string,
  externalLabels: (string | null)[],
  explicitObjcName?: string | null
): string | null {
  if (!baseName) return null;
  if (explicitObjcName) return explicitObjcName;

  if (externalLabels.length === 0) {
    return baseName;
  }

  const [first, ...rest] = externalLabels;
  // 单参数："_" → "base:" ；"label" → "baseWithLabel:"
  // 多参数与单参数的首关键字构造规则相同，然后将每个后续标签作为独立关键字追加。
  // 后续标签中的 `null` 在 ObjC 中无效（无法表达无标签的中间参数）——
  // 为安全起见，保留为 `:`。
  const firstKeyword =
    first === null || first === undefined || first === '_' || first === ''
      ? `${baseName}:`
      : `${baseName}With${capFirst(first)}:`;

  const restKeywords = rest.map((l) => `${l ?? ''}:`).join('');
  return firstKeyword + restKeywords;
}

/**
 * 计算 Swift `init(...)` 声明桥接后的 ObjC 选择器。
 *
 * **初始化方法规则**（与普通方法不同——无论首标签是否为 `_`，
 * Apple 始终使用 `initWith`）：
 * - `init()`                       → `init`
 * - `init(_ name: String)`         → `initWithName:`  （外部标签为 `_` 时使用
 *                                    内部名称，遵循 Apple 的桥接约定）
 * - `init(name: String)`           → `initWithName:`
 * - `init(name: String, age: Int)` → `initWithName:age:`
 *
 * 对于 `_` 的情况，需要使用内部（第二个标识符）名称——
 * 通过 `internalNames` 传入。
 */
export function objcSelectorForSwiftInit(
  externalLabels: (string | null)[],
  internalNames: string[],
  explicitObjcName?: string | null
): string | null {
  if (explicitObjcName) return explicitObjcName;

  if (externalLabels.length === 0) {
    return 'init';
  }

  const [firstExt, ...restExt] = externalLabels;
  const [firstInt] = internalNames;
  // 当外部标签为 "_" 时使用内部名称；ObjC 需要某个关键字，
  // Swift 的自动桥接器在此情况下会使用参数的局部名称。
  const firstLabel =
    firstExt === null || firstExt === '_' || firstExt === ''
      ? firstInt
      : firstExt;
  if (!firstLabel) return null;

  const firstKeyword = `initWith${capFirst(firstLabel)}:`;
  const restKeywords = restExt
    .map((label, idx) => {
      const internal = internalNames[idx + 1];
      const name = label && label !== '_' ? label : internal ?? '';
      return `${name}:`;
    })
    .join('');
  return firstKeyword + restKeywords;
}

/**
 * 计算 Swift `@objc` 属性桥接后的 ObjC getter 与 setter。
 *
 * - `var name: String`        → getter `name`，setter `setName:`
 * - `var isReady: Bool`       → getter `isReady`，setter `setIsReady:`
 *   （不做特殊的 `is` 处理——Swift 的 `isReady` 在 ObjC 中保持为 `isReady`；
 *   若需要 Cocoa 风格的 getter `isReady` / setter `setReady:` 配对，
 *   可通过 `@objc(name:)` 覆盖——这是声明上 `@objc(customGetter)` 注解
 *   的职责，通过 `explicitObjcName` 向上透传。）
 */
export function objcAccessorsForSwiftProperty(
  swiftName: string,
  explicitObjcName?: string | null
): { getter: string; setter: string } | null {
  if (!swiftName) return null;
  // 覆盖语法 `@objc(customGetterName)` 只重定向 GETTER；
  // setter 仍遵循 `setX:` 规则，但以覆盖名称为基础。
  // （`@objc(getX:setY:)` 目前不支持——这是较罕见的形式；
  // 若真实代码库有需要，可在后续扩展。）
  const getter = explicitObjcName ?? swiftName;
  return {
    getter,
    setter: `set${capFirst(getter)}:`,
  };
}

/**
 * 反向：给定一个 ObjC 选择器，返回解析器在查找被桥接 Swift 声明时
 * 应当尝试的候选 Swift 基础名称。
 *
 * 示例：
 *   `play`                 → ['play']
 *   `play:`                → ['play']
 *   `playWithSong:`        → ['play', 'playWithSong']
 *   `play:by:`             → ['play']
 *   `playWithSong:by:`     → ['play', 'playWithSong']
 *   `initWithName:`        → ['init']                      （init 自身即为基础名称）
 *   `initWithName:age:`    → ['init']
 *   `setName:`             → ['name', 'setName']           （可能是 setter，也可能是普通函数）
 *   `tableView:didSel…:`   → ['tableView']
 *
 * 返回多个候选，因为裸基础名称存在歧义——`playWithSong:` 既可能对应
 * `func play(song:)`，也可能对应 `func playWithSong(_ x:)`（一个字面命名如此、
 * 首标签为 `_` 的 Swift 方法）。解析器会逐一尝试。
 */
export function swiftBaseNamesForObjcSelector(selector: string): string[] {
  if (!selector) return [];

  // 去掉尾部冒号并按冒号拆分为关键字列表。
  const keywords = selector.replace(/:+$/g, '').split(':');
  const firstKeyword = keywords[0];
  if (!firstKeyword) return [];

  const candidates: Set<string> = new Set();

  // 始终是候选：原始首关键字。涵盖以下情形：
  //   `play:`           → `play`
  //   `play:by:`        → `play`
  //   `playWithSong:`   → `playWithSong`（Swift 字面名称）
  //   `tableView:...:`  → `tableView`
  candidates.add(firstKeyword);

  // `initWith<X>:` 和 `initWith<X>:<more>:` 始终归约为 `init`。
  if (firstKeyword.startsWith('initWith')) {
    candidates.add('init');
  }

  // 介词前缀模式：`<base>(With|For|By|In|On|At|From|To|Of|As)<Cap>:`
  // 同时涵盖 Swift 的 @objc 导出规则（始终为 "With"）和 Cocoa 原生导入选择器
  // 中使用其他介词的情形（例如 `objectForKey:`、`stringWithFormat:`、
  // `compareTo:`、`imageNamed:inBundle:`）。剥离介词以还原调用方
  // 使用的 Swift 基础名称（例如 `object`、`string`、`compare`、`image`）。
  const prepositionMatch = firstKeyword.match(
    /^([a-z][a-zA-Z0-9]*?)(?:With|For|By|In|On|At|From|To|Of|As)[A-Z]/
  );
  if (prepositionMatch && prepositionMatch[1]) {
    candidates.add(prepositionMatch[1]);
  }

  // `setX:` 可能是属性 setter——对应的 Swift 属性名为 `x`（小写）。
  // 仅在明确的形式下触发：`set` + 大写字母 + ':' （单参数）。
  if (
    keywords.length === 1 &&
    /^set[A-Z]/.test(firstKeyword) &&
    selector.endsWith(':')
  ) {
    const propName = lowerFirst(firstKeyword.slice(3));
    if (propName) candidates.add(propName);
  }

  return Array.from(candidates);
}

/**
 * 检测 Swift 方法的 `@objc` 声明是否使用了 `@objc(custom:)` 覆盖形式，
 * 若存在则返回字面量选择器。
 *
 * 基于正则对声明前的一小段源码进行扫描——tree-sitter 会更精确，
 * 但此函数仅作为结构化 AST 不可用时的后备方案（例如通过
 * `context.readFile` 进行的解析器时查找）。
 *
 * 当声明为普通 `@objc`（无覆盖）或完全没有 `@objc` 属性时，返回 `null`。
 */
export function detectExplicitObjcName(sourceSlice: string): string | null {
  // `@objc(customName:)` 或 `@objc(custom:name:)`——括号内的内容即为字面量
  // ObjC 选择器。允许空白字符。
  const m = sourceSlice.match(/@objc\s*\(\s*([^)\s]+)\s*\)/);
  return m && m[1] ? m[1] : null;
}

/**
 * 检测 Swift 声明是否通过扫描其前置源码片段而暴露为 `@objc`。
 * 对于显式 `@objc`、`@objc(custom:)` 或属于 `@objcMembers` 类的成员，
 * 均返回 true（若需传入类级别上下文，由调用方负责）。
 *
 * 若同时出现 `@nonobjc`，即使存在 `@objc` 也返回 false
 * （遵循 Swift 规则：`@nonobjc` 可退出类级别的 `@objcMembers`）。
 */
export function isObjcExposed(sourceSlice: string): boolean {
  if (/@nonobjc\b/.test(sourceSlice)) return false;
  return /@objc\b/.test(sourceSlice);
}
