# Playbook：为新语言扩展值引用边

**目的。** 本文档是为新增一种语言的值引用边覆盖并验证的操作手册。将新会话指向本文件并说 **"从语言 X 开始"**——它包含一切所需信息：特性工作原理、代码位置、精确的验证方案（含脚本）、每语言核对清单，以及已踩过的坑。

设计依据 + 已完成的验证矩阵见配套文档：
[`value-reference-edges.md`](./value-reference-edges.md)。本文件是*操作指南*。

---

## 0. "从语言 X 开始"——按顺序执行

1. 阅读 §1（工作原理）和 §2（当前状态），了解机制和已完成内容。
2. 执行**每语言接线检查**（§5 步骤 A–C）——这里是各语言差异所在，也是大多数实际工作/决策的地方。不要跳过：错误的声明符节点类型或类作用域 vs 文件作用域不匹配，会导致特性静默地不产生任何边（或产生错误的边）。
3. 对该语言的小/中/大**公共 OSS** 代码库运行**验证扫描**（§4）。追查误报（FP）。**修复 FP 簇；记录单例。**（§3 说明了什么是真正的 FP vs 可接受的情况。）
4. 在 `value-reference-edges.md` 中**添加矩阵行**，并在 `__tests__/value-reference-edges.test.ts` 中添加**测试用例**。
5. 在分支上提交，开一个 PR。（§6 有 git 工作流 + 已有 PR 的做法。）

作用域规则（强制）：**绝不在维护者自己的代码库上评估**——为该语言克隆一个真实的公共 OSS 代码库。（记忆：`agent-eval-targets-public-oss-only`。）

---

## 1. 值引用边的工作原理

**是什么：** 从*读取者符号*到其**所读取的文件作用域 `const`/`var`** 的 `references` 边，带有 `metadata: { valueRef: true }`，仅限同文件。它的存在是为了让影响分析能捕获"修改这个常量/配置对象/查找表 → 影响其读取者"这类变更——这是 calls/imports/继承边从未捕获的一类变更（常量的消费者以前看起来像"没有任何东西依赖它"）。

**流向：** 直接进入 `getImpactRadius` → `synapse impact` 以及 `synapse_explore` / `synapse_node` 中的影响追踪。无需任何智能体行为变更。**胜出在影响半径的正确性**（一个被 90 个符号读取的常量从"1 个受影响"变为"90 个"），*而非*智能体读取次数减少（见 §4.3）。

**代码——全部在 `src/extraction/tree-sitter.ts` 中：**

| 符号 | 角色 |
|---|---|
| `VALUE_REF_LANGS`（static Set） | 该特性运行的语言集合。当前为 `typescript`、`javascript`、`tsx`、`go`、`python`、`rust`、`ruby`、`c`、`java`、`csharp`、`php`、`scala`、`kotlin`、`swift`、`dart`、`pascal`。**在此添加新语言。** |
| `valueRefsEnabled` | `process.env.SYNAPSE_VALUE_REFS !== '0'`——默认开启，环境变量可关闭。 |
| `MAX_VALUE_REF_NODES`（20_000） | 每次作用域遍历上限（及影子扫描上限）。 |
| `captureValueRefScope(kind, name, id, node)` | 在 `createNode` 中为每个节点调用。记录**目标**（文件作用域的 `const`/`var`）和**读取者作用域**（`function`/`method`/`const`/`var`）。 |
| `flushValueRefs()` | 在 `extract()` 末尾调用一次。剪除被遮蔽的目标，然后对每个读取者作用域遍历其子树，查找与目标名称匹配的标识符并发出边。 |

**`captureValueRefScope` 内的两道门控**（可能需要按语言调整）：

- **目标门控：** `kind ∈ {constant, variable}` **且** `name.length >= 3` **且** `/[A-Z_]/.test(name)`（有辨识度的名称——规避单字母/全小写遮蔽）**且**节点的父 id 以 `file:`、`class:` 或 `module:` 开头（文件/类/模块作用域）。
- **读取者门控：** `kind ∈ {function, method, constant, variable}`。

**`flushValueRefs` 中的发射循环：** 仅限同文件（目标和作用域是按文件维护的，每次 flush 时重置）；按 `(reader, target)` 去重；跳过 `isGeneratedFile(path)` 的文件；**剪除被遮蔽的目标**（见 §3）。

---

## 2. 当前状态（已发布 + 已验证的内容）

- **默认开启**，适用于 TS/JS/tsx + Go + Python + Rust + Ruby + C + Java + C#（`SYNAPSE_VALUE_REFS=0` 关闭）。在 **PR #895** 中发布（开关 + 影子剪除）；Go 在后续 PR 中添加（影子剪除声明符扩展 + `VALUE_REF_LANGS`）；C 再之后（提取器修改以发出节点 + 裸标识符误解析守卫）；Java + C# 在那之后（字段→常量类型切换）。
- **已验证 S/M/L**，覆盖 **TS、JS、tsx、Go、Python、Rust、Ruby、C、Java 和 C#**——见设计文档中的矩阵。全部通过：开/关节点数一致，精度守卫有效，影响提升已复现。Go 需要扩展影子剪除（每语法声明符）——这是"步骤 B 至关重要"的实例。**C 需要 Ruby 处理方式**（提取器完全没有发出 C 文件作用域 const/var 节点）**加上** C 特有的 FP 守卫（宏前缀原型误解析会造出以返回类型命名的裸标识符"变量"——跳过裸 `identifier` 声明符）。这是"§2b 覆盖表中*简单路径*猜测可能是错的——在信任之前务必执行 §5 步骤 C（确认节点存在）"的实例。
- **Java + C# 是最干净的类作用域（"Ruby 处理方式"）语言。** 常量已提取——但类型是 `field`，被门控拒绝。全部改动只是将 const *子集*发出为 `constant`：每个提取器上的 `isConst` 谓词（Java 的 `static final`；C# 的 `const` / `static readonly`）+ `extractField` 中的类型切换。**无需新的影子剪除接线**（方法局部变量是 `variable_declarator`，已在 switch 中）且**无 FP 守卫**（UPPER_SNAKE / PascalCase 符合有辨识度名称门控）。实例 `final`/`readonly` 字段正确保留为 `field`。已验证 S/M/L：gson/commons-lang/guava，automapper/newtonsoft/efcore——0 泄漏，节点一致，大幅影响提升（`INDEX_NOT_FOUND` 4→165，`_resourceManager` 22→1664）。
- **PHP 是最简洁的——只需改一行读取器扫描。** 常量已提取为 `constant`（顶层 + 类），唯一的改动是让读取器扫描知道 PHP 常量*引用*是一个 `name` 节点（裸 `X`，或 `self::X` / `Foo::X` 中的 const 部分）。**无需提取器改动，无需剪除接线**（`$var` 局部变量无法遮蔽裸常量——命名空间不同）。已验证 S/M/L（guzzle/monolog/laravel），全部通过，0 类/常量冲突。诚实的注意事项：**产出较低**——PHP 跨文件读取常量远多于同文件（laravel 2,956 个文件 → 86 条边），而值引用仅限同文件；结果仍然正确，只是贡献较小。
- **Scala——`object` 是常量作用域。** Scala 没有 `static`；单例 `object` 的 `val` 是共享常量惯用法（`object Config { val Timeout = 30 }`）。顶层 `val` 已提取为 `constant`，但 object/class 的 val 都作为 `field` 输出。修复：在 Scala 的 `val_definition` 处理器中，上走至外层定义——`object_definition`（或顶层）→ `constant`/`variable`；`class`/`trait`/`enum` → `field`（按实例，类似 Java 实例 `final`）。将 `val_definition`/`var_definition` 添加到影子剪除（方法局部 `val` 遮蔽）。读取器扫描无需改动（引用是 `identifier`）。已知轻微限制：Scala 的 `val`/`def` 可互换作为成员，所以 camelCase 的 val 可能与方法同名——同文件名称匹配无法区分（有界的，类似 Ruby 的兄弟类；扫描显示标记的冲突大多是真实的 object val 被兄弟读取）。已验证 S/M/L（upickle/cats/pekko）。
- **C++ 尝试后已回退——不要在解决解析保真度之前重试。** tree-sitter-cpp 对真实的模板/宏密集型 C++（以及将 `.h` 文件路由到 C 语法的情况）存在误解析：类成员和参数泄漏到文件作用域，成为虚假的常量/变量。两个守卫（跳过 `ERROR` 祖先和 `compound_statement` 祖先声明）消除了约 83% 的严重泄漏，但残余问题充斥于结构良好的库源码（模板类成员泄漏、合并的超大头文件、`.h` 当 C++ 使用）。未达到其他语言的精度标准。见下方 C++ 章节。
- **Kotlin = C + Scala + PHP 技术的组合（且干净）。** 此前没有任何提取（属性名嵌套在 `property_declaration → variable_declaration → simple_identifier` 中——C 问题的翻版）。修复：在 Kotlin 的 `visitNode` 钩子中处理 `property_declaration`——提取嵌套名称，上走外层定义确定类型（`object`/`companion object`/顶层 → `constant`/`variable`；`class` → `field`——Scala 规则；跳过 `function_body`/`init`/lambda 下的局部），将 `simple_identifier` 添加到读取器扫描（PHP 的 `name` 动作），并将 `property_declaration` 添加到影子剪除。解析保真度干净（唯一的 `fun interface` 误解析已处理），因此无 C++ 风格的尾巴。产出最佳之一——companion-object 位掩码/状态常量是大量同文件读取的惯用法。已验证 S/M/L（okio/coroutines/ktor）；只剩有界的 val/def 或类与兄弟 companion 名称重叠（与 Scala/Ruby 共有）。
- **Swift 复用了 Kotlin + 两个 Swift 特有处理。** 顶层 `let` + 类型中的 `static let` 是共享常量（`enum`/`struct` 命名空间化它们）；实例 `let` 保留为 `field`。嵌套名称（`property_declaration → <name> pattern → simple_identifier`）；读取器扫描已覆盖（`simple_identifier`，来自 Kotlin）。两个新增点：**(1) 目标门控扩展到 `struct:`/`enum:` 父级**——Swift 在那里命名空间化常量（`enum Constants { static let X }`），其他所有语言的目标都是 `file:`/`class:`/`module:`；**(2) 跳过计算属性**（`var x:Int{ … }` 的 getter 没有存储值——检测 `computed_property` 子节点）。节点创建嵌入*现有*的 Swift `property_declaration` 处理器（属性包装器/类型依赖），保持其不变。解析干净，无尾巴。已验证 S/M/L（Alamofire/swift-argument-parser/swift-nio）。
- **Dart——语法分离干净，但有兄弟体读取器扫描修复。** Dart 的语法已将情况清晰分开：**`static_final_declaration`** *正好*是顶层/`static` 的 `const`/`final`（共享常量惯用法），而实例字段/`var` 使用 `initialized_identifier`，局部变量使用 `initialized_variable_definition`——所以将 `static_final_declaration` 提取为 `constant`（在 `visitNode` 钩子中）**无需实例/局部泄漏守卫**。读取器扫描无障碍（Dart 引用是 `identifier`）。关键问题在**读取器扫描**：Dart 将方法/函数的 `body` 作为签名节点（存储的作用域）的*下一个兄弟*附加，而非子节点，因此扫描只看到签名，**找不到任何内容**，直到被教会引入 `function_body` 下一兄弟（值引用集合中仅 Dart 如此）。影子剪除需要 `static_final_declaration` + `initialized_identifier` + `initialized_variable_definition`（局部 `const X` 遮蔽文件 `const X`）。已验证 S/M/L（http/flame/flutter-packages）。**注意事项：** 生成的 Dart 文件会放大兄弟类的歧义（带有数百个 `static final _class` 的 JNIGEN `_bindings.dart` 会折叠为文件范围目标）。常见代码生成后缀（`.g.dart`/`.freezed.dart`/`.pb.dart`）已被 `isGeneratedFile` 过滤；仅有头部标记的生成器（JNIGEN）未处理，所以真实源码干净，但生成的 FFI/JNI 绑定有噪声。
- **Pascal——真正的简单路径 + 再次遇到 Dart 兄弟体修复。** 单元/类 `const` *已经*提取为 `constant`（`variableTypes: ['declConst', …]`），所以只需添加到 `VALUE_REF_LANGS` + 影子剪除（`declConst`/`declVar`；局部 `const X` 遮蔽单元 `const X`）。关键是遇到了*相同*的读取器扫描 bug：Pascal 的过程体是 `declProc` 头部（读取者作用域）的**`block` 兄弟**，两者都在 `defProc` 下——所以同样的兄弟引入修复扩展到了 `block`。读取器扫描节点类型已覆盖（引用是 `identifier`）。**产出低**——Pascal 跨单元读取常量多于同文件（horse：4 条边）。**注意事项：** Pascal 不区分大小写，但读取器扫描匹配确切文本，所以大小写不同的引用会被遗漏（无 FP，只是遗漏）；不值得规范化。
- **测试：** `__tests__/value-reference-edges.test.ts`——同文件读取者有边；在影响半径中呈现；被遮蔽的常量不应有边（验证无守卫时失败）；仅 JSX 读取有边（tsx）；`SYNAPSE_VALUE_REFS=0` 不产生任何边。
- **记忆：** `value-reference-edges-default-on`（A/B 发现 + 影子守卫依据）。

---

## 2b. 覆盖对比 README（语言 + 框架）

以 README 的**支持语言**表（24 行）和**框架感知路由**列表为基准跟踪。值引用是**语言级别**特性，框架*不是*独立轴（见本节底部）。

**✅ 已完成——已验证 S/M/L（15 + 3 继承）：**

| 语言 | 方式 |
|---|---|
| TypeScript、JavaScript、tsx | 文件作用域 `const`/`var`；最初支持的语言 |
| Python | 模块级 `NAME =` |
| Go | 包 `const`/`var` |
| Rust | 模块 + impl 中的 `const`/`static` |
| Ruby | 类/模块 `CONST`（类作用域扩展） |
| C | 文件作用域 `static const` 标量 + 指针/数组查找表 + 可变全局变量。**需要提取器修改**（节点未被发出）+ 裸标识符误解析守卫——并非表格最初猜测的简单路径 |
| Java | 类 `static final` 字段。节点已存在，类型为 `field`；将 const 子集发出为 `constant`（`isConst` + `extractField` 类型切换）。无需新的剪除接线，无 FP 守卫 |
| C# | 类 `const` / `static readonly`。与 Java 相同——同样的 `field`→`constant` 改动 |
| PHP | 顶层 `const` + 类 `const`（均已为 `constant` 类型）。**唯一**改动是读取器扫描：PHP 常量*引用*是一个 `name` 节点。无提取器改动，无剪除接线（`$var` 局部无法遮蔽裸常量）。产出较低——PHP 跨文件读取常量多于同文件 |
| Scala | 顶层 `val`（已为 `constant`）+ **`object` val**（单例常量惯用法；从 `field` 通过上走 `object_definition` 重新分类）。`class`/`trait`/`enum` val 保留为 `field`。`val_definition`/`var_definition` 添加到影子剪除。轻微的 val/def 名称冲突限制 |
| Kotlin | 顶层 / `object` / `companion object` `val`（从无到有重新分类——属性根本没有被提取）。在 `visitNode` 中处理：嵌套名称（`variable_declaration → simple_identifier`，C 的动作）+ 作用域上走确定类型（Scala 的动作）+ 读取器扫描中的 `simple_identifier`（PHP 的动作）+ 剪除。类实例 val 保留为 `field`。干净——产出最佳之一（companion 位掩码） |
| Swift | 顶层 `let` + `struct`/`enum`/`class` 中的 `static let`。复用 Kotlin（嵌套名称 + `simple_identifier` 读取器扫描）。两个 Swift 特有处理：**门控扩展到 `struct:`/`enum:` 父级**（Swift 在那里命名空间化常量），以及**跳过计算属性**。类/实例存储属性保留为 `field`。嵌入现有的 Swift 属性包装器处理器 |
| Dart | 顶层 `const`/`final` + 类 `static const`/`static final`——均为 **`static_final_declaration`** 节点，语法上与实例/`var`/局部干净分离（无泄漏守卫）。`visitNode` → `constant`。需要读取器扫描修复：Dart 方法的**体是签名的下一个兄弟**，扫描引入 `function_body` 兄弟。生成的 FFI 噪声（JNIGEN `_bindings.dart`）是唯一注意事项 |
| Pascal / Delphi | 单元/类 `const`（已提取为 `constant`）。添加到 `VALUE_REF_LANGS` + 影子剪除（`declConst`/`declVar`）+ **同 Dart 的兄弟体修复**（Pascal 的过程体是 `declProc` 头部的 `block` 兄弟）。产出低（跨单元读取）；不区分大小写（精确文本扫描遗漏大小写不同的引用） |
| **Svelte、Vue、Astro** | **免费继承**——它们的提取器将 `<script>`/前置内容块重新解析为 `typescript`/`javascript`，这两者在 `VALUE_REF_LANGS` 中（已验证：`.svelte` 中的 `const` 会与其读取者建立边）。无需独立工作；无需独立矩阵行。 |

**🔜 剩余——可能是简单路径**（常量在文件/模块作用域或顶层；执行 §5：添加到 `VALUE_REF_LANGS`，验证声明符节点类型 + 提取器类型，扫描）。在构建之前先分类——其中几个是混合文件 + 类作用域。**从 C 学到的教训：** 这里的"简单路径"意味着*作用域*符合——**不**保证提取器已发出 const 节点。C 在这一列，但没有发出任何文件作用域 const/var 节点（其名称嵌套在通用回退无法读取的 `init_declarator` 中），所以最终还是需要 Ruby 风格的提取器修改。**运行 §5 步骤 C（确认 `select kind,name from nodes …` 实际显示 const）之前不要信任这一列。**

| 语言 | 常量形式 | 备注 |
|---|---|---|
| Lua / Luau | 文件/块 `local X =` + 全局；无 `const` 关键字 | 有辨识度名称门控（需要 `[A-Z_]`）捕获较少——Lua 大小写使用不一 |
| R | 文件作用域 `X <- …` / `X = …` | |

**🧱 剩余——需要 Ruby 处理方式**（常量几乎完全**在类/类型内部**；类作用域*门控*现已存在，但首先确认提取器将其发出为 `constant`/`variable` 节点——Ruby 的常量根本没有被提取，类字段通常以 `field`/`property` 类型输出，被门控拒绝）。**Java + C#（已完成）正是这种情况**：其常量以 `field` 类型提取，修复是将 const 子集（`static final` / `const` / `static readonly`）发出为 `constant`——这是其余语言的模板：

| 语言 | 常量形式 |
|---|---|
| Objective-C | `static const` / `extern const` / `#define`（类似文件作用域；宏未解析；已是"部分支持"） |

**⛔ 已尝试并回退——C++。** 文件作用域 + 类 `static const`/`constexpr`（混合）。机制已构建且在干净的 C++ 上正确，但 **tree-sitter-cpp 解析保真度是阻塞问题**：模板/宏密集型真实 C++ 会将类成员 + 参数泄漏到文件作用域为虚假的常量/变量，且 `.h` 文件路由到 C 语法（破坏 C++ 类）。两个守卫（跳过 `ERROR` 祖先和 `compound_statement` 祖先声明）消除了约 83% 的严重泄漏，但残余问题充斥于结构良好的库源码。**未达到精度标准；已回退。** 不要以"值引用"任务重试——需要先解决 C++ 解析处理问题（模板类成员作用域、`.h` 当 C++ 检测、合并超大头文件排除）。

**🚫 不适用：** Liquid（模板语言——没有值常量可跟踪）。

**框架——不是值引用轴。** README 的框架列表（Django、Flask、Express、NestJS、Rails、Spring、Gin、Laravel……）是*独立*特性：**路由节点提取**。值引用与框架无关——它通过底层语言支持覆盖任何框架代码中的常量，**每个框架无需做任何额外工作**。验证扫描已在框架代码库上运行（Rails → Ruby，Django → Python，gin → Go，express/eslint/webpack → JS，jekyll/sinatra → Ruby），所以框架代码已被覆盖；无需独立的框架矩阵。

---

## 3. 精度守卫 + 什么算误报

守卫在 `flushValueRefs` 中按顺序运行：

1. **`isGeneratedFile(path)`**（`src/extraction/generated-detection.ts`）——跳过*后缀识别的*生成文件（`.pb.ts`、`.min.js`……）。**仅路径**——无法捕获内容压缩的包。
2. **影子剪除**——当目标的**声明符数量超过其文件作用域节点数量**时，丢弃该目标（即它也在内层/局部作用域中绑定）。依据：捆绑的/Emscripten 的 `const Module` 被内层 `var Module` 重新声明，Go 包 const 被局部 `:=` 遮蔽，或 Python 模块 const 被局部 `=` 遮蔽，对嵌套读取者解析的是*内层*绑定，所以文件作用域边是错误的。内层重绑定不是图节点，所以声明符在**语法树**层面计数。*这是每语言敏感的守卫：* 声明符节点类型因语法而异（§5 步骤 B），且比较的是文件作用域节点数（非单纯的 `>1`），这样才能保留**条件模块定义**（`try: X=…; except: X=…`）。
3. **有辨识度名称 + 同文件**（目标门控）。

**真正的 FP 是什么样的**（需修复）：读取者与文件作用域 const 建立了边，但它**实际上并未读取**该常量——几乎总是集中在**捆绑/压缩/生成**文件中的**文件内遮蔽**（名称在内层作用域重绑定）。在 excalidraw 上，这是一个 Emscripten blob 中的 23 条边。

**什么不是 FP**（保留）：
- **CommonJS `var x = require('…')` 绑定**（JS）——正确的同文件读取；修改绑定*确实*影响其读取者；在影响中与 `calls` 边去重。不是噪声。
- **被许多同文件函数读取的模块级可变 `var` 状态**——这正是预期用途。
- 某语言边的占比更高（JS ~4–5% vs TS ~0.7–1.6%）在精度保持的情况下是可以接受的。

**已知限制（有意的，已记录）：** 仅参数的遮蔽*没有*被守卫（剪除计数声明符，而非参数——守卫它会过度剪除名称与参数重合的合法常量）；仅限同文件（不覆盖跨文件消费者）；没有静态标识符的响应式/计算式读取不在覆盖范围内。

---

## 4. 验证方案

### 4.1 确定性探针（核心——发现 FP）

对同一代码库索引两次（开启 vs `SYNAPSE_VALUE_REFS=0`）；节点数**必须完全一致**（仅边特性）。先构建：`npm run build`。将以下内容保存为 `probe.sh`：

```bash
#!/usr/bin/env bash
set -uo pipefail
SRC="$1"; NAME="$2"; WORK="${WORK:-/tmp/cg-vr}"
CG="$(pwd)/dist/bin/synapse.js"
export SYNAPSE_TELEMETRY=0 DO_NOT_TRACK=1 SYNAPSE_NO_DAEMON=1
ON="$WORK/$NAME-on"; OFF="$WORK/$NAME-off"
rm -rf "$ON" "$OFF"; mkdir -p "$WORK"
rsync -a --exclude='.git' "$SRC/" "$ON/"; rsync -a --exclude='.git' "$SRC/" "$OFF/"
node "$CG" init "$ON"  2>&1 | grep -E "nodes,|Indexed"
SYNAPSE_VALUE_REFS=0 node "$CG" init "$OFF" 2>&1 | grep -E "nodes,|Indexed"
OND="$ON/.synapse/synapse.db"; OFD="$OFF/.synapse/synapse.db"
echo "nodes on/off: $(sqlite3 "$OND" 'select count(*) from nodes') / $(sqlite3 "$OFD" 'select count(*) from nodes')  (MUST MATCH)"
# 精确过滤——不要使用 LIKE '%valueRef%'（它会匹配文件名中含 valueRef 的边，
# 如 textModelValueReference.ts；见 §7）。始终使用：kind='references' AND 精确键。
F="kind='references' and metadata like '%\"valueRef\":true%'"
echo "value-ref edges: $(sqlite3 "$OND" "select count(*) from edges where $F")"
echo "=== top targets by same-file reader count ==="
sqlite3 -column "$OND" "select t.name, count(*) r, replace(t.file_path,'$ON/','') f from edges e join nodes t on e.target=t.id where e.$F group by e.target order by r desc limit 15;"
```

运行：`WORK=/tmp/cg-vr bash probe.sh /path/to/cloned-repo reponame`。

### 4.2 FP 追踪（对开启的 db `$OND` 运行，使用上方的 `F`）

```bash
# (a) 目标中的捆绑/压缩文件——#1 FP 来源（woff2 案例）：
sqlite3 "$OND" "select distinct t.file_path from edges e join nodes t on e.target=t.id where e.$F;" \
 | while read -r f; do [ -f "$f" ] || continue; \
     m=$(awk '{if(length>x)x=length}END{print x+0}' "$f"); [ "$m" -gt 300 ] && echo "MINIFIED? $m $f"; done
# (b) 守卫不变式——没有幸存目标在其文件中被重新声明（按语言调整正则）：
sqlite3 "$OND" "select distinct t.name, t.file_path from edges e join nodes t on e.target=t.id where e.$F limit 80;" \
 | while IFS='|' read -r n f; do [ -f "$f" ] || continue; \
     c=$(grep -cE "(const|let|var)[[:space:]]+$n\b" "$f"); [ "${c:-0}" -gt 1 ] && echo "LEAK $n x$c $f"; done
# (c) 精度抽查——目测整棵树中的读取者→目标对：
sqlite3 -column "$OND" "select s.name,'->',t.name from edges e join nodes s on e.source=s.id join nodes t on e.target=t.id where e.$F order by e.id desc limit 12;"
```

对每个疑似 FP，打开文件确认读取者是否确实读取了那个文件作用域目标。某个文件中有 FP 簇 → 修复（扩展守卫）。孤立 FP → 记录它，不要追查。

### 4.3 影响 API 增量（头条指标）+ 智能体 A/B

头条指标——值引用将盲目的影响变为真实的影响：

```bash
for s in SOME_CONST ANOTHER_CONST; do
  printf "%-20s ON %s OFF %s\n" "$s" \
    "$(node dist/bin/synapse.js impact "$s" --path "$ON"  2>/dev/null | grep -oE '— [0-9]+ affected' | head -1)" \
    "$(node dist/bin/synapse.js impact "$s" --path "$OFF" 2>/dev/null | grep -oE '— [0-9]+ affected' | head -1)"
done
```
从探针的"top targets"列表中选取目标。预期 ON ≫ OFF（例如 1 → 90）。

**智能体 A/B**（按语言可选——以下发现与大小/语言无关，所以确定性探针 + 影响增量通常已足够）。如果运行：两个**全新开/关索引**，每个索引预热一个 `--no-watch` 守护进程，使用 **`--model sonnet --effort high`** 的 `claude -p`，每组 ≥2 次运行。`scripts/agent-eval/ab-new-vs-baseline.sh` 中的模式是模板，**但它切换构建 + 重建索引（无标志），这会抹掉标志特定的索引——不要直接用于标志 A/B。**（记忆：`agent-eval-nested-attach`，`agent-eval-targets-public-oss-only`。）

**已确立的 A/B 发现（不要重新推导）：** 在 excalidraw 的 12 次运行中，两组都是 0 次 Read / 0 次 Grep——智能体用一次调用回答影响问题，并使用 `synapse_search`/`callers` 而*非* `impact`/`explore`，所以通常根本不查询值引用边。ON 从未比 OFF 更差。**所以：值引用不减少智能体读取——胜出在爆炸半径的正确性**（影响 API / Synapse Pro 的评判引擎）。

---

## 5. 每语言核对清单（实际工作）

### A. "值得跟踪的常量"在哪里？（首先决定）

目标门控现在接受 **`file:`、`class:` 和 `module:`** 父级。在做任何事之前：

- 如果语言将可共享常量放在**文件/模块作用域**（TS/JS，Python 模块 const，Go 包变量，Rust 模块/impl `const`/`static`）→ 直接适配；继续。
- 如果常量**在类/模块内部**（Ruby——已完成）→ `class:`/`module:` 门控现在已覆盖，但可能需要先修复两件事：(1) 提取器必须实际*提取*类内部常量为节点（`variableTypes` 分支上的分发跳过类内赋值——Ruby 需要对 `constant` LHS 赋值的例外）；(2) 读取器扫描必须匹配语法中常量*引用*的表示方式（Ruby 使用 `constant` 节点，而非 `identifier`）。见设计文档中的 Ruby 块。
- **类作用域精度**使用**文件范围**目标映射（每文件每名称一个目标），而非严格的同类匹配——因为词法作用域语言（Ruby）允许嵌套类读取外层类的常量，严格匹配会丢弃这些有效读取。唯一真正的 FP 是同一文件中的*兄弟*类中有相同常量名（rails 中约 1.7% 的 Ruby 目标）；有效代码很少遇到（裸兄弟类常量在 Ruby 中是 NameError）。
- **Java/C#/Kotlin/Swift 类作用域常量已完成。** 门控现接受 `file:`/`class:`/`module:`/**`struct:`/`enum:`** 父级——`struct:`/`enum:` 扩展是为 Swift 添加的，Swift 将共享常量命名空间化在 `enum`/`struct` 中（`enum Constants { static let X }`）。**下一个类作用域语言的教训：** 检查样本 const 的*父类型*（`select … substr(id…)`）——如果是 `struct:`/`enum:`/`interface:` 且门控没有列出它，扩展门控（一行）否则特性静默无边，尽管节点存在。
- **确认读取器扫描匹配语言的常量*引用*节点类型（PHP 教训）。** `flushValueRefs` 中的读取器扫描匹配 `identifier` / `constant` / `name`。如果新语言以其他节点类型表示常量*读取*，扫描找不到任何东西，**即使目标正确注册也不会形成任何边**。PHP 通过 **`name`** 节点引用常量（裸 `X`，以及 `self::X` / `Foo::X` 中的 const 部分），扫描直到 `name` 被添加才检测到。在扫描之前，转储样本的读取者体并检查常量引用的节点类型——零边扫描通常意味着这个，而非目标门控 bug。

### B. 确认声明符节点类型（用于影子剪除）

影子剪除（在 `flushValueRefs` 中）通过对声明符节点类型的 `switch (n.type)` 计数声明符名称——一个文件只有自己语法的节点，所以在一个 switch 中列出所有语言的类型是安全的。**在那里添加新语法的声明符类型**，以及正确提取绑定名称的方式。**对照实际语法验证**（不要信任此表——通过解析样本确认）。**这一步至关重要：** 如果跳过，剪除对新语言静默无效，文件内遮蔽产生误报（这正是第一次 Go 传递时发生的——见下方 §5-Go）。

| 语言 | 声明符节点 | 名称提取 | 状态 |
|---|---|---|---|
| TS/JS/tsx | `variable_declarator` | `namedChild(0)` | 已完成 |
| Go | `const_spec`、`var_spec`、`short_var_declaration` | spec → `namedChild(0)`；short-var → `left` 字段中的标识符 | **已完成** |
| Python | `assignment` | `left` 字段：标识符，或遍历 `pattern_list`/`tuple_pattern` | **已完成** |
| Rust | `const_item`、`static_item`、`let_declaration` | const/static → `name` 字段；let → `pattern` 字段 | **已完成** |
| Ruby | `assignment`（LHS 是 `constant` 节点） | 已在 switch 中；Ruby 无法局部遮蔽常量，剪除对其实际上是空操作 | **已完成**（类作用域） |
| Ruby | 带 constant LHS 的 `assignment`（`CONST`） | LHS | 待验证 |
| C | 文件作用域 `declaration` 中的 `init_declarator` | `cDeclaratorIdentifier` 沿 `declarator` 链走（init → 指针/数组 → 标识符） | **已完成** |
| C++ | **已尝试并回退**——解析保真度（见 §2b 的 C++ 注释） | — | 已回退 |
| Java | `variable_declarator`（字段和方法局部） | `namedChild(0)` = 名称标识符——**已是 TS/JS 的情况**，无需新接线 | **已完成** |
| C# | `variable_declarator`（字段和方法局部） | 同 Java——已在 switch 中 | **已完成** |
| PHP | **无** | `$var` 局部（`variable_name`）与裸常量命名空间不同——局部永远无法遮蔽常量，剪除是空操作，无需 PHP 声明符 | **已完成**（不适用） |
| Scala | `val_definition`、`var_definition` | `pattern` 字段（标识符）——捕获 object/顶层 val 被方法局部 `val` 遮蔽 | **已完成** |
| Kotlin | `property_declaration` | `variable_declaration → simple_identifier`（`bump` 接受 `simple_identifier`）——捕获 object/companion const 被方法局部 `val` 遮蔽 | **已完成** |
| Swift | `property_declaration` | `<name> pattern → simple_identifier`（`firstSimpleIdentifier`）——剪除情况同时处理 Kotlin 和 Swift 形状；捕获 static const 被方法局部 `let` 遮蔽 | **已完成** |
| Dart | `static_final_declaration`（目标）+ `initialized_identifier`（字段/`var`）+ `initialized_variable_definition`（局部） | 每个都有直接的 `identifier` 子节点——捕获顶层/static const 被方法局部 `const` 遮蔽 | **已完成** |
| Pascal | `declConst`（单元/类 const = 目标）+ `declVar`（局部 `var`） | `<name>` 字段——捕获单元 `const X` 被函数局部 `const X` 遮蔽 | **已完成** |

**剪除规则是 `declarators > file-scope-node-count`，而非 `> 1`。** 一个名称可以在*文件作用域*合法地绑定两次——**条件模块定义**（`try: X = a; except: X = b`，或 `if cond: X = a else: X = b`）。这些会形成 N 个文件作用域节点 AND N 个声明符，所以会被保留；真正的局部遮蔽使声明符超过文件作用域节点数。Python 迫使了这个改进（try/except const 定义无处不在）；它对所有语言都更严格正确。`fileScopeValueCounts`（在 `captureValueRefScope` 中递增）按名称跟踪文件作用域节点数。另外：同名值引用边会被抑制（`refName !== scope.name`），因为条件定义的两半否则会相互引用。

**Go 是"步骤 B 很重要"的实例：** 第一次传递只将 `go` 添加到 `VALUE_REF_LANGS`，合成探针立即显示出误报——`func withShadow() { TimeoutSeconds := 5; return TimeoutSeconds }` 与包 `const TimeoutSeconds` 建立了边，因为剪除扫描了 `variable_declarator`（Go 没有这个节点类型）。修复：将 Go 的 `const_spec`/`var_spec`/`short_var_declaration` 添加到 switch。注意这从 TS/JS 继承了**精度优先的权衡**——被遮蔽的目标对*整个文件*都被丢弃，所以那个文件中其他地方的合法读取者也失去了边。在 Go 扫描（gin/hugo/prometheus）中，这种过度剪除可以忽略不计（守卫不变式干净，无 LEAK），所以不值得进行每读取者分析——但要按语言重新检查。

### C. 确认提取器分配的类型

`captureValueRefScope` 对目标使用 `kind ∈ {constant, variable}` 作为键。索引一个样本文件，检查 `select kind,name from nodes where file_path like '%sample%'`——确认模块级常量以 `constant`/`variable` 类型输出（而非 `field`、`property`、`import` 等）。如果以其他类型输出，调整目标门控。

### D. 接线 + 扫描

1. 将语言字符串添加到 `VALUE_REF_LANGS`。
2. `npm run build`。
3. 在**小/中/大**公共 OSS 代码库（≥3 种规模）上运行 §4.1 探针。优先选择有真实配置/常量/查找表模块的代码库（特性在那里最有效）。
4. 对每个代码库运行 §4.2 FP 追踪。修复 FP 簇（扩展守卫）；记录单例。
5. 对几个目标运行 §4.3 影响增量。
6. 在 `value-reference-edges.md` 中添加**矩阵行**（按语言），并在 `__tests__/value-reference-edges.test.ts` 中添加**测试**（正读取 + 遮蔽/否定案例）。
7. `npx vitest run __tests__/value-reference-edges.test.ts` 以及完整测试套件。

**通过标准：** 每种规模开/关节点数一致；精度抽查干净（FP 簇已修复）；影响增量显示盲目→真实半径的提升；完整测试套件通过。

---

## 6. Git / PR 工作流（已有 PR 的做法）

- 从 `main` 分支（例如 `feat/value-refs-<lang>`）。此验证工作在 `feat/value-refs-validation` 上进行；新语言可以在其上扩展，或使用自己的分支。
- 纯验证性改动是 **docs（+ 测试）**；精度修复是专注的 **code** PR（如 #895）。在实际操作中，将代码修复与文档/矩阵更新分开。
- Commit 消息尾部：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- PR 正文尾部：`🤖 Generated with [Claude Code](https://claude.com/claude-code)`。
- 合并由**维护者决定**——未被告知时不要自行合并。分支保护需要经授权时使用 `gh pr merge --squash --admin`（记忆：`gh-merge-needs-admin`）。
- CHANGELOG：在 `## [Unreleased]` 下写面向用户的条目；不要预先创建版本块。

---

## 7. 已踩过的坑（省去重蹈覆辙的时间）

- **探针误匹配：** `metadata LIKE '%valueRef%'` 会匹配其他边的 metadata 中的*文件名*（例如一条 `interface-impl` 的 `calls` 边，其 `registeredAt` 是 `…/textModelValueReference.ts`）。**始终**过滤 `kind='references' AND metadata LIKE '%"valueRef":true%'`。这在 vscode 上制造了一个虚假的"方法目标" FP，完全是查询噪声。
- **`searchNodes` 返回 `SearchResult[]`**（`.node` 包装 `Node`）——在测试中使用 `.map(r => r.node)`。`getImpactRadius().nodes` 是一个 **`Map`**——遍历 `.values()`。
- **`Synapse.initSync(dir, opts)` 忽略 `opts`**——它只接受路径；默认配置索引 `.ts`/`.tsx`/`.js`。不要依赖传入的 `include`。
- **开/关节点数必须一致。** 如果不一致，值引用（错误地）正在创建节点——在做其他任何事之前先调查。
- **大型代码库：** 索引 vscode（11.5k 个文件）每组用了约 2 分钟，每个 DB 约 1GB；之后清理 `/tmp`（每个开/关对是数百 MB 到 >2GB）。
- **require 绑定（CommonJS）不是 FP**——见 §3。不要"修复"它们。
- **不要为未出现的问题过度设计守卫**（例如仅参数遮蔽）：以证据为驱动。维护者倾向于最小化、外科手术式的修复。
- **C 宏前缀原型误解析（C FP 簇）：** 未知的前导宏（`CURL_EXTERN`、`XXH_PUBLIC_API`）使 tree-sitter-c 将原型 `MACRO RetType fn(args);` 误解析为一个*声明*，其中声明的"变量"是裸返回类型标识符（`XXH_errorcode`），将 `fn(args)` 分割为一个虚假表达式。这为每个原型造出一个以类型命名的虚假全局——然后被那个类型的每个函数建立边（redis 的 `XXH_errorcode` 1→18）。这些误解析*总是*产生一个**裸 `identifier`** 声明符（经指针/数组/带大小返回变体验证）；真正的 const/表总有 `init_declarator`，真正的指针/数组全局有自己的声明符。修复 = 在 C 分支中**跳过裸 `identifier` 声明符**。"额外的"文件作用域变量节点也降低了早期传递的节点数——两组一致，但修复后数量*更低*，不要惊讶。
- **"简单路径" ≠ "节点已存在。"** §2b 表按*作用域*分类；它不保证语言的 const 已被提取。C 位于简单路径列，却没有发出任何文件作用域 const 节点。先在样本上运行 §5 步骤 C（`select kind,name from nodes where file_path like '%sample%'`）——如果 const 不在那里，你在做 Ruby 处理方式，而非简单路径。
- **类 const 可能以 `field` 类型提取，而非 `constant`（Java/C# 案例）。** 步骤 C 必须检查*类型*，而非仅检查节点是否存在：Java 的 `static final` 和 C# 的 `const`/`static readonly` 以 `field` 类型输出，而值引用目标门控（只接受 `constant`/`variable`）静默拒绝——所以尽管节点存在，特性没有产生任何边。修复 = 提取器上的 `isConst` 谓词（以 const 修饰符为条件）+ `extractField` 中的类型切换（按语言限定，其他语言的字段保留为 `field`）。不要扩展*门控*以接受 `field`——那会将每个可变实例字段都拉入目标。且仅转换 const *子集*：Java 实例 `final` 或 C# 实例 `readonly` 是每对象状态，必须保留为 `field`。
- **有目标却零边的扫描 = 读取器侧问题，不仅仅是读取器扫描节点类型（PHP 陷阱）。** 目标可以完美注册（正确的类型、正确的作用域），*仍然*产生零边，如果读取器扫描不识别语言写常量*读取*的方式。PHP 通过 **`name`** 节点引用常量，而非 `identifier`/`constant`，所以扫描什么都看不到，直到 `name` 被添加。在假设目标门控 bug 之前，在稀疏/空扫描时转储读取者体并检查已知常量引用的节点类型。（向扫描添加引用节点类型在各语言间是安全的——`flushValueRefs` 只对值引用集合运行，文件只含有自己语法的节点；`name` 在当前集合中是 PHP 独有的。）
- **同文件限制意味着跨文件密集型语言产出更少——这是正确的，而非遗漏。** PHP 跨文件读取常量远多于同文件（`Logger::DEBUG` 无处不在），所以 laravel（2,956 个文件）只给出 86 条边，而 Ruby rails 有 2,255 条。不要追查它：跨文件值消费者对*每种*语言都超出范围（需要导入/作用域解析）。在矩阵中诚实地报告较低的产出，而非将其视为需要修复的 bug。
- **一些提取器在错误作用域将参数/字段发出为 `variable`——限制为 `constant`（Pascal 陷阱）。** Pascal 的提取器将函数 `const`/`var` 参数和类字段作为 `variable` 发出，父级为外层单元/类，所以它们通过目标门控并折叠为嘈杂的文件范围目标（`Dest`、`aItem` "到处"被读取）。真正的共享值全是 `constant`（`declConst`），所以修复是 `captureValueRefScope` 中的单行每语言限制：Pascal 只针对 `constant`。在信任新语言的 `variable` 目标之前，抽样检查它们——如果是参数或实例字段而非模块/全局状态，限制为 `constant`。（仍有残余尾巴可能泄漏：tree-sitter-pascal 在复杂 Delphi 签名中将 `const` 参数上下文相关地误解析为 `declConst`——小型解析保真度 FP，作为已记录的注意事项接受。）
- **有目标存在时的零边扫描也可能是读取者侧，而非仅读取器扫描节点类型（Dart 陷阱）。** 目标提取正常，读取者作用域已注册，读取器扫描节点类型正确——仍然零边，因为 Dart 将方法的**体作为签名节点（注册为读取者作用域的节点）的下一个*兄弟***附加，所以扫描只遍历了签名子树。如果语言的函数/方法体不是注册为读取者作用域的节点的后代，扫描看不到读取——引入兄弟/链接体。当边为零但目标和读取者节点看起来都正确时，检查这一点。

---

## 8. 参考

- 代码：`src/extraction/tree-sitter.ts`（`VALUE_REF_LANGS`、`captureValueRefScope`、`flushValueRefs`），`src/extraction/generated-detection.ts`（`isGeneratedFile`）。
- 设计 + 矩阵：`docs/design/value-reference-edges.md`。
- 测试：`__tests__/value-reference-edges.test.ts`。
- PR：**#895**（默认开启 + 影子剪除），**#897**（TS/JS/tsx 验证）。
- 记忆：`value-reference-edges-default-on`、`agent-eval-targets-public-oss-only`、`agent-eval-nested-attach`、`gh-merge-needs-admin`、`impact-coverage-findings`。
