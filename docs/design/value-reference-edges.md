# 设计与状态：同文件值引用边

**状态：** 已发布（默认开启，适用于 TS/JS/tsx + Go + Python + Rust + Ruby + C + Java + C# + PHP + Scala + Kotlin + Swift + Dart + Pascal；`SYNAPSE_VALUE_REFS=0` 可关闭）。发射器位于 `TreeSitterExtractor.flushValueRefs`（`src/extraction/tree-sitter.ts`）。
**动机：** 填补*值消费者*的影响分析空白。静态提取会建立调用、导入和继承边，但从不为常量建立指向读取它的符号的边——所以修改一个配置对象/查找表/共享常量，看起来像"没有任何东西依赖这个"。这是"修改这张表，破坏其读取者"那类变更（促成此工作的 ReScript PR 误报案例）。

---

## 新会话速览

我们从读取者符号到其**所读取的文件/包作用域 `const`/`var`** 发出一条 `references` 边（`metadata: { valueRef: true }`），仅限同文件，适用于 TS/JS/tsx + Go + Python + Rust + Ruby + C + Java + C# + PHP + Scala + Kotlin + Swift + Dart + Pascal。这些边直接流入 `getImpactRadius` / `synapse impact` 以及 `synapse_explore` / `synapse_node` 中的影响追踪——无需任何智能体行为变更。

胜出在**影响半径的正确性**，而非智能体读取次数减少（见"智能体 A/B"）。

## 边语义

- **目标：** 文件作用域的 `const`/`var`，名称"有辨识度"（≥3 个字符且含大写字母或 `_`）——规避单字母/全小写名称带来的局部遮蔽精度陷阱。
- **读取者（源）：** 任何 `function` / `method` / `const` / `var` 符号，其体引用了目标名称。
- **仅限同文件**——无需导入/作用域分析即可无歧义解析。
- **按 `(reader, target)` 去重**。**仅添加边**——只增加边，不增加节点。

## 精度守卫（按发射顺序）

1. **`isGeneratedFile(path)`**——跳过后缀识别的生成文件（`.pb.ts`、`.min.js`……）。仅路径；无法捕获内容压缩的包。
2. **影子剪除**——当目标的**声明符数量超过其文件作用域节点数量**时，丢弃该目标，即它也在*内层*（局部）作用域绑定过。捆绑的/Emscripten 的 `const Module` 被内层 `var Module` 重新声明、Go 包 const 被局部 `:=` 遮蔽、Python 模块 const 被局部 `=` 遮蔽——对嵌套读取者解析的都是内层绑定，文件作用域边会是误报。内层重绑定不是图节点，所以声明符在语法层面计数（每语法的节点类型：TS/JS 用 `variable_declarator`，Go 用 `const_spec`/`var_spec`/`short_var_declaration`，Python 用 `assignment`，Rust 用 `const_item`/`static_item`/`let_declaration`）。
   与文件作用域节点数比较（而非单纯的 `>1`）保留了**条件模块定义**（`try: X=…; except: X=…`），这些在文件作用域合法地绑定了名称两次。这可以捕获守卫 #1 遗漏的内容压缩包。
3. **有辨识度名称 + 同文件**（如上）。

## 验证矩阵——TS / JS / Go / Python / Rust / Ruby / C / Java / C# / PHP / Scala / Kotlin / Swift / Dart / Pascal

每个代码库的方法：对同一代码树索引两次（开启值引用 vs `SYNAPSE_VALUE_REFS=0`），对比节点/边数量，抽查精度，并对几个文件作用域 const 测量 `synapse impact`。节点数开/关必须**完全一致**（仅边特性）。

**TypeScript**

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| sindresorhus/ky | 小 | 54 | 562（稳定） | +29（0.8%） | 抽样均为 TP | — |
| excalidraw/excalidraw | 中 | 645 | 10,301（稳定） | +717（1.6%） | 影子剪除后均为 TP（#895 消除了 23 条 woff2 bundle 误报） | `tablerIconProps` 1→**170** |
| microsoft/vscode | 大 | 11,548 | 333,999（稳定） | +10,605（0.69%） | 抽样均为 TP；前 200 中无参数遮蔽/bundle 误报 | `LayoutStateKeys` 1→**85**，`CORE_WEIGHT` 1→52 |

**JavaScript**（相同提取器；CommonJS、`var`、IIFE/UMD）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| expressjs/express | 小 | 147 | 1,082（稳定） | +27（0.75%） | 抽样均为 TP | — |
| eslint/eslint | 中 | 1,420 | 7,167（稳定） | +1,192（4.2%） | 抽样均为 TP；守卫有效；无压缩文件误报 | `internalSlotsMap` 1→**32**，`INDEX_MAP` 1→27 |
| webpack/webpack | 大 | 9,371 | 28,922（稳定） | +3,521（4.8%） | 抽样均为 TP；守卫有效；无压缩文件误报 | `LogType` 1→**89**，`LOG_SYMBOL` 1→90，`UsageState` 2→52 |

**Go**（包级别 `const`/`var`；需要扩展影子剪除——见下文）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| gin-gonic/gin | 小 | 110 | 2,599（稳定） | +166（1.9%） | 抽样均为 TP；守卫有效 | `abortIndex` 1→**24**，`jsonContentType` 1→8 |
| gohugoio/hugo | 中 | 952 | 19,160（稳定） | +1,616（2.5%） | 抽样均为 TP；守卫有效 | `filepathSeparator` 2→**26** |
| prometheus/prometheus | 大 | 1,329 | 23,322（稳定） | +3,466（3.3%） | 抽样均为 TP；守卫有效 | `rdsLabelInstance` 1→**82**，`ec2Label` 1→24 |
| kubernetes/kubernetes | 超大 | 19,160 | 251,086（稳定） | +20,574（1.9%） | 抽样均为 TP；250 个目标上守卫有效 | `KubeletSubsystem` 3→**138**，`LEVEL_0` 1→102 |

**Python**（模块级 `NAME = …`；需要扩展剪除*并*改进其规则——见下文）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| psf/requests | 小 | 49 | 1,299（稳定） | +85（2.9%） | 抽样均为 TP；守卫有效 | `ITER_CHUNK_SIZE` 1→4，`DEFAULT_POOLBLOCK` 1→4 |
| sqlalchemy/sqlalchemy | 中 | 679 | 59,963（稳定） | +1,929（0.8%） | 抽样均为 TP；守卫有效 | `COMPARE_FAILED` 1→**26**，`DB_LINK_PLACEHOLDER` 1→19 |
| django/django | 大 | 3,005 | 61,748（稳定） | +1,328（0.7%） | 抽样均为 TP；守卫有效 | `_trans` 1→**138**，`SEARCH_VAR` 4→8 |

**Rust**（模块级 `const`/`static`；添加了声明符，无需修改规则）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| BurntSushi/ripgrep | 小 | 107 | 3,731（稳定） | +144（0.9%） | 抽样均为 TP；守卫有效 | `SHERLOCK` 7→**113** |
| tokio-rs/tokio | 中 | 795 | 13,281（稳定） | +476（1.1%） | 抽样均为 TP；`#[cfg]` 条件 const 已保留 | `PERMIT_SHIFT` 1→**97**，`LOCAL_QUEUE_CAPACITY` 2→46 |
| rust-lang/rust-analyzer | 大 | 1,530 | 38,780（稳定） | +475（0.25%） | 抽样均为 TP；0 真实遮蔽泄漏 | `INLINE_CAP` 2→**183**，`SPAN_PARTS_BIT` 2→18 |

**Ruby**（`CONST = …`，几乎总是**在类/模块内部**——需要类作用域扩展）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| sinatra/sinatra | 小 | 96 | 1,800（稳定） | +73（2.1%） | ~100% TP（标记的均是有效的嵌套读取） | `HEADER_PARAM` 1→**5** |
| jekyll/jekyll | 中 | 218 | 1,906（稳定） | +100（2.4%） | ~100% TP | `DEFAULT_PRIORITY` 1→3，`LOG_LEVELS` 4→5 |
| rails/rails | 大 | 1,452 | 61,911（稳定） | +2,255（1.2%） | ~98% TP（同文件歧义 1208 个目标中的 21 个） | `Post`（Struct const）75 个读取者 |

**C**（文件作用域 `static const` 标量 + 指针/数组查找表 + 可变全局变量；需要先提取节点——见下文）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| redis/hiredis | 小 | 52 | 1,161（稳定） | +29（2.5%） | 抽样均为 TP；守卫有效 | `hiredisAllocFns` 1→**71** |
| curl/curl | 大 | 994 | 16,124（稳定） | +597（3.7%） | 抽样均为 TP；守卫有效；无压缩误报 | `Curl_ssl` 3→**57** |
| redis/redis | 中 | 782 | 19,446（稳定） | +1,634（8.4%） | 宏误解析修复后抽样均为 TP；守卫有效 | `asmManager` 2→**97**，`keyMetaClass` 1→36，`XXH3_kSecret` 1→27，`helpEntries` 1→13 |

**Java**（类作用域 `static final` 常量；需要以 `constant` 类型发出——见下文）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| google/gson | 小 | 262 | 8,563（稳定） | +387 | 抽样均为 TP；守卫有效 | `PEEKED_NONE` 1→**31** |
| apache/commons-lang | 中 | 623 | 19,976（稳定） | +2,087 | 抽样均为 TP；守卫有效；无压缩误报 | `INDEX_NOT_FOUND` 4→**165**，`EMPTY` 5→161 |
| google/guava | 大 | 3,227 | 130,945（稳定） | +6,354 | 抽样均为 TP；守卫有效；无压缩误报 | `APPLICATION_TYPE` 2→**126**，`ABSENT` 4→66 |

**C#**（类作用域 `const` / `static readonly`；与 Java 相同的 `field`→`constant` 改动）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| AutoMapper/AutoMapper | 小 | 511 | 19,254（稳定） | +133 | 抽样均为 TP；守卫有效 | `ContextParameter` 1→**17**，`InstanceFlags` 1→14 |
| JamesNK/Newtonsoft.Json | 中 | 945 | 20,208（稳定） | +344 | 抽样均为 TP；守卫有效 | `DefaultFlags` 1→**37**，`JsonNamespaceUri` 1→15 |
| dotnet/efcore | 大 | 5,731 | 140,847（稳定） | +3,720 | 抽样均为 TP；守卫有效；无压缩误报 | `_resourceManager` 22→**1664**，`Prefix` 40→237，`Guid77` 2→191 |

**PHP**（顶层 `const` + 类 `const`，均已是 `constant`；仅需调整读取器扫描——见下文）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| guzzle/guzzle | 小 | 81 | 1,655（稳定） | +5（稀疏——见说明） | 抽样均为 TP；无冲突 | `CONNECTION_ERRORS` 1→3 |
| Seldaek/monolog | 中 | 217 | 3,047（稳定） | +79 | 抽样均为 TP；无类/常量冲突 | `DEFAULT_JSON_FLAGS` 1→**18**，`RFC_5424_LEVELS` 1→17 |
| laravel/framework | 大 | 2,956 | 57,519（稳定） | +86 | 抽样均为 TP；无压缩/冲突误报 | `INVISIBLE_CHARACTERS` 1→**93**，`SESSION_ID_LENGTH` 1→9 |

**Scala**（顶层 `val` + `object` val——从 `field` 重新分类；`class` 实例 val 保留为 `field`）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| com-lihaoyi/upickle | 小 | 145 | 3,052（稳定） | +82 | 抽样均为 TP；无类/方法冲突 | `IntegralPattern` 1→**9** |
| typelevel/cats | 中 | 835 | 15,774（稳定） | +89 | 抽样为 TP；标记的 val/def 名称冲突均是被兄弟读取的真实 object val | `maxArity` 3→**17**，`fusionMaxStackDepth` 1→13，`minIntValue` 1→7 |
| apache/pekko | 大 | 2,720 | 135,041（稳定） | +8,453（2,065 Scala） | Scala object val 干净；大量是来自生成的 protobuf `.java` 文件的有效 Java `PARSER`/`DEFAULT_INSTANCE` | `ErrorLevel` 5→**33**，`WarningLevel` 5→29 |

**Kotlin**（顶层 / `object` / `companion object` `val` → `constant`；`class` 实例 val 保留为 `field`）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| square/okio | 小 | 307 | 8,540（稳定） | +157 | 抽样均为 TP；0 冲突 | `STATE_IN_QUEUE` 1→**32**，`HMAC_KEY` 1→9 |
| Kotlin/kotlinx.coroutines | 中 | 1,039 | 17,058（稳定） | +210 | 抽样均为 TP；1 个跨文件冲突 | `BLOCKING_SHIFT` 1→**24**，`TERMINATED` 2→22（companion 位掩码） |
| ktorio/ktor | 大 | 2,302 | 43,272（稳定） | +849 | object/companion const（HTTP 头名称）；标记的冲突是真实常量；`TYPE` 是兄弟 companion 歧义 | `TYPE` 8→**109**，`FailedPath` 1→22 |

**Swift**（顶层 `let` + `struct`/`enum`/`class` 中的 `static let` → `constant`；实例 `let` 保留为 `field`；跳过计算属性）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| Alamofire/Alamofire | 小 | 98 | 4,192（稳定） | +108 | 抽样均为 TP；0 冲突；计算属性已跳过 | `defaultRetryLimit` 1→3，`defaultWait` 1→4 |
| apple/swift-argument-parser | 中 | 165 | 4,435（稳定） | +36 | 抽样均为 TP；1 个兄弟类型冲突（`usageString`） | `usageString` 8→**18**，`labelColumnWidth` 1→2 |
| apple/swift-nio | 大 | 554 | 20,136（稳定） | +589 | 抽样均为 TP；0 冲突；`eventLoop`（static let）验证为 TP | `CONNECT_DELAYER` 1→**15**，`SINGLE_IPv4_RESULT` 1→12 |

**Dart**（顶层 `const`/`final` + 类 `static const`/`static final` = `static_final_declaration` 节点 → `constant`）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| dart-lang/http | 小 | 324 | 4,860（稳定） | +668 | 真实源码 TP；数字被一个 JNIGEN `_bindings.dart` 扭曲（兄弟类折叠） | `Finishing` 1→**10**，`CONNECTION_PREFACE` 5→7 |
| flame-engine/flame | 中 | 1,655 | 19,608（稳定） | +465 | 抽样均为 TP；有界的 const 与 getter 冲突 | `cardWidth` 4→**15**，`tileSize` 3→12 |
| flutter/packages | 大 | 3,452 | 116,075（稳定） | +10,015 | 真实 Flutter const；部分 `.gen.dart`（pigeon）生成噪声 | `iconFont` 1→**1790**，`_channel` 6→72，`kMaxId` 1→23 |

**Pascal / Delphi**（单元/类 `const` → `constant`；**仅 `constant`** 目标——提取器将参数/字段作为 `variable` 发出）

| 代码库 | 规模 | 文件数 | 节点数（on=off） | +值引用边 | 精度 | `impact` on→off 示例 |
|---|---|---|---|---|---|---|
| HashLoad/horse | 小 | 74 | 2,464（稳定） | +4（稀疏——跨单元读取） | 抽样均为 TP | `LOG_NFACILITIES`（Syslog const） |
| synopse/mORMot2 | 中 | 539 | 66,760（稳定） | +2,240 | 精度抽样 100% TP（字体/加密/DB const）；复杂 Delphi 签名中少数 `const` 参数误解析误报 | `LIB_CRYPTO` 1→**358**，`DEFAULT_ECCROUNDS` 1→31 |
| castle-engine | 大 | 2,430 | 93,692（稳定） | +6,983 | 顶部目标均为真实 FFI 绑定常量；0 冲突 | `LazGio2_library` 2→**1880**，`LIB_CAIRO` 1→223 |

在所有十五种语言的 S/M/L 验证中：节点数从未变动，精度守卫均有效，`impact` OFF 列才是 bug——一个被 80–140 个符号读取的常量，在没有值引用的情况下报告"1 个受影响"。

**Go 需要代码修改**（不同于 JS/tsx，已有守卫可以不改地覆盖它）。Go 将常量放在包 = 文件作用域（很好——目标门控适配），但其声明符是 `const_spec`/`var_spec`/`short_var_declaration`，而非 `variable_declarator`，所以影子剪除对 Go 是空操作，包 `const Timeout` 被局部 `Timeout := …` 遮蔽时产生了误报。将剪除的声明符 switch 扩展到 Go 的节点类型修复了它（一个合成复现，然后在 gin/hugo/prometheus 上干净）。这是下一种语言的模板：**影子剪除是每语法的，必须按语言接线**（见 playbook）。

**Python 迫使对剪除*规则*进行改进——一个通用改进。** Python 的声明符是 `assignment`（已添加到 switch）。但 Python 还**条件性地定义模块常量**（`try: HAS_SSL = True; except: HAS_SSL = False`）——一种在模块作用域将名称绑定两次的非常常见惯用法。旧的"绑定超过一次 → 丢弃"规则过度剪除了这些（丢弃了真实 const 及其读取者）。修复通过将声明符数量与该名称拥有的**文件作用域节点**数量比较，区分条件模块定义和真实遮蔽：条件定义使两者相等（两个绑定都在文件作用域），局部遮蔽使声明符超过文件作用域节点（超出部分是局部）。这对*所有*语言都更严格正确。（它还使条件定义的两半通过各自的名称相互引用，所以同名值引用边现在被抑制。）

**Rust 只需要声明符——规则已经正确。** Rust 的是 `const_item` / `static_item`（模块 const）和 `let_declaration`（遮蔽用的局部）。将它们添加到 switch 修复了预期的遮蔽误报（被局部 `let TIMEOUT` 遮蔽的 `const TIMEOUT`）。Rust 也有条件定义模式——`#[cfg(unix)] const SEP = …; #[cfg(windows)] const SEP = …`——Python 时代的文件作用域计数规则已经正确保留了这些（在 tokio 的 `io/interest.rs` cfg 门控标志上验证）。还有一个好的附带效果：写在配置宏（`cfg_aio! { … }`）内的 const 存在于未解析的 token tree 中，所以剪除的语法遍历根本看不到它们。

**Ruby 是类作用域情况——需要三项修改。** Ruby 几乎将所有常量保存在类/模块*内部*（jekyll 的 `lib/`：0 个顶层 vs 58 个类内部），所以原来仅文件作用域的目标门控几乎覆盖不到任何内容。三项 Ruby 特有修复：(1) 提取器现在为常量赋值（`CONST = …` 有 `constant` 类型的 LHS，而非 `identifier`，所以它们从未被提取过）创建节点——包括类内部的；(2) 值引用目标门控接受 `class:`/`module:` 父级，而非仅 `file:`；(3) 读取器扫描匹配 `constant` 节点，因为在 Ruby 中，常量的定义和引用都是 `constant` 类型。**实际上是 Ruby 特有的：** Rust impl const 已经以 `file:` 为父（所以门控变更不影响它们——ripgrep 保持在 144 条边），TS/Python 类成员不是 `constant`/`variable` 类型。

关于类作用域目标属于*哪个*类这一精度问题——结果表明**文件范围**目标映射更好（每文件每名称一个目标），因为 Ruby 的常量查找是**词法 + 祖先**的：嵌套类中的方法合法地读取外层类的常量（在 jekyll 的 `ERBRenderer→ThemeBuilder::SCAFFOLD_DIRECTORIES` 和 sinatra 的 `AcceptEntry→Request::HEADER_PARAM` 上验证）。严格的同类匹配会错误地丢弃这些读取。唯一真正的误报是同一文件中*兄弟*（未嵌套）类中相同的常量名——rails 上 1,208 个目标中的 21 个（1.7%），而且大多数也能正确解析；在真实 Ruby 中引用兄弟类的裸常量是 NameError，所以有效代码很少遇到。净精度 ~98–100%。

**C 并非语言追踪表最初设想的"简单路径"——它需要提取器首先发出节点。** C 将可共享值保存在文件作用域（`static const` 标量，以及非常常见的指针/数组**查找表** + 可变全局状态），这适配文件作用域目标门控。但不同于 Go/Rust（其 const 节点已存在），C 的文件作用域 `const`/`var` **从未以节点形式被提取**：C 的 `declaration` 将其名称嵌套在 `init_declarator` 中（通过 `pointer_declarator`/`array_declarator`），通用变量提取回退只找直接的 `identifier` 子节点——所以什么都没产出。三项修改（与 Ruby 相同的形状）：(1) `extractVariable` 中的 C 分支，通过声明符链解析名称并将文件作用域声明发出为 `constant`/`variable`（通过祖先检查跳过函数体内的局部，以及 `function_declarator` 原型）；(2) C 提取器上的 `isConst`（`const` `type_qualifier` → `constant` 类型）；(3) 影子剪除的声明符 switch 扩展了 `init_declarator`。**仅限 C**——C++ 保留在通用回退上（其类作用域成员是更难的那桶）。

扫描暴露的唯一误报簇是**宏前缀原型误解析**，修复是关键的 C 细节：未知的前导宏（`CURL_EXTERN`、`XXH_PUBLIC_API`）使 tree-sitter-c 将原型 `MACRO RetType fn(args);` 误解析为一个声明，其中声明的"变量"是**裸返回类型标识符**（`XXH_errorcode`/`CURLcode`），将 `fn(args)` 切分为虚假表达式——为每个原型造出一个以类型命名的虚假全局，然后被每个返回该类型的函数建立边（修复前 redis 的 `XXH_errorcode` 1→18）。这些误解析*总是*产生一个**裸 `identifier`** 声明符（经指针/数组/带大小返回变体验证）；真正的 const/表总带有初始化器（`init_declarator`），真正的指针/数组全局有自己的声明符。所以 C 分支**完全跳过裸 `identifier` 声明符**——以牺牲未初始化标量全局（`static int g;`，少见且价值低）为代价消灭了整个误报类。修复后：hiredis/redis/curl 上每个抽样边均为真正的正例，守卫不变式泄漏检查在所有三个代码库上找到 0 个遮蔽，`impact` 增量确认了盲目→真实半径（`asmManager` 2→97，`Curl_ssl` 3→57，`hiredisAllocFns` 1→71）。

**Java + C# 是最干净的类作用域语言——一个类型切换，无新守卫。** 两者都将常量保存在*类内部*（Java `static final` 字段；C# `const` / `static readonly`），所以不像 C，节点已存在——但类型是 **`field`**，值引用门控（只接受 `constant`/`variable`）拒绝了。全部改动只是将常量*子集*发出为 `constant`：每个提取器上的 `isConst` 谓词（Java = `static final` 字段；C# = `const`，或 `static readonly`）加上 `extractField` 中的类型切换。其他一切都已就位——来自 Ruby 的类作用域目标门控、`identifier` 读取器扫描，以及关键的影子剪除：遮蔽类 const 的方法局部在两种语法中都是 `variable_declarator`，*已在*剪除 switch 中，所以被局部遮蔽的类 const 无需新接线即可被丢弃（通过 Java/C# 遮蔽测试验证）。实例字段保留为 `field`——Java 实例 `final` 或 C# 实例 `readonly` 是每对象状态，不是共享常量，所以永远不是目标。有辨识度名称门控完美适配两种约定（Java `UPPER_SNAKE`，C# `PascalCase`），所以没有误报类出现：在 S/M/L（gson/commons-lang/guava，automapper/newtonsoft/efcore）中，每个抽样边都是真正的正例，0 遮蔽泄漏，无压缩文件误报，节点数开/关完全一致。`impact` 提升是头条——Java 的经典 `public static final` 常量（`INDEX_NOT_FOUND` 4→165，`EMPTY` 5→161）和 C# 的 `const`/`static readonly`（`Prefix` 40→237，生成的 `_resourceManager` 22→1664）都从盲目的"1 个受影响"变为真实半径。已知的兄弟类限制（同一文件两个类中相同的 const 名称解析到文件范围目标）与 Ruby 共有，且保持可以忽略不计。

**PHP 几乎是纯粹的"简单路径"——一行读取器扫描，无需提取器修改，无需剪除接线。** PHP 已将顶层 `const X = …` 和类 `const X = …` 提取为 `constant` 类型（专用的 `const_declaration` 处理器），在正确的作用域内（`file:` / `class:`，两者均已门控）。*唯一*的改动是读取器扫描：PHP 将常量*引用*——裸 `X`，或 `self::X` / `Foo::X` / `static::X` 中的 const 部分——表示为 **`name`** 节点，而扫描（匹配 `identifier` / `constant`）遗漏了它，所以什么都找不到，直到 `name` 被添加。这在各语言间是安全的：`flushValueRefs` 只对值引用集合运行，而 `name` 在其中是 PHP 独有的。**根本不需要影子剪除**——PHP 局部是 `$var`（`variable_name`），与裸常量命名空间不同，局部*永远无法*遮蔽常量；没有什么需要剪除（迄今为止最简洁的情况）。精度出色：UPPER_SNAKE 常量符合有辨识度名称门控，对目标名称与同文件*类*冲突（PHP 唯一现实的误报——`name` 节点也在 `new Foo()` / `Foo::` 中命名类）的专项检查在 guzzle/monolog/laravel 上发现**零**冲突；每个抽样边均为真正的正例，节点数开/关完全一致。

**诚实的注意事项：PHP 产出低于类作用域语言，这是设计决定。** PHP 惯用法跨文件读取常量远多于同文件（`Logger::DEBUG` 或到处使用的配置常量），而值引用**仅限同文件**——所以 laravel（2,956 个文件）只产出了 86 条边，而 Ruby rails（1,452 个文件）产出 2,255 条。这不是遗漏：跨文件读取对*每种*语言都超出范围（需要导入/作用域解析），PHP 只是更多地依赖它们。它*确实*捕获的同文件读取干净，可传递影响提升也是真实的（`INVISIBLE_CHARACTERS` 来自 3 个直接读取者 1→93）。净效果：正确且累加，只是绝对贡献比 Java/C#/Go 小。

**Scala——`object` 是常量作用域。** Scala 没有 `static`；共享常量的惯用法是单例 `object` 内的 `val`（`object Config { val Timeout = 30 }`）。顶层 `val` 已提取为 `constant`，但 `object` 和 `class` 的 val 都作为 `field` 输出（门控拒绝 `field`）。修复是在 Scala 的 `val_definition` 处理器中进行类型细化：上走至外层定义，将 `object_definition`（或顶层）val 视为 `constant`/`variable`——而 `class`/`trait`/`enum` val 保留为 `field`，因为它是每实例不可变状态，与我们也保留为 `field` 的 Java 实例 `final` 完全类似。（`object` 和 `class` 都提取为 `class` *类型*，所以区别在于外层 AST 节点类型，而非节点类型。）影子剪除增加了 `val_definition`/`var_definition`（方法局部 `val` 可以遮蔽 object val）；读取器扫描无需改动，因为 Scala val 引用是普通 `identifier`。方法局部 val 根本不被提取，所以它们不是目标来源。唯一**已知限制**是 Scala 的 `val`/`def` 可互换作为成员：同一文件中 camelCase 的 val 可能与方法同名，同文件名称匹配无法区分——但这是有界的（类似 Ruby 的兄弟类情况），在扫描中每个标记的 val/def 冲突都是被兄弟 val 读取的真实 `object` val（cats 的类型类实例：`val flatMap = monad`，被 `invariantSemigroupal` 读取）。已验证 S/M/L（upickle/cats/pekko）：节点数开/关完全一致，顶部目标是真正的 object val（`maxArity` `val = 22`，`DigitTens` 查找表），影响提升真实（`maxArity` 3→17）。有辨识度名称门控通过内部大写字母适配 Scala 的 camelCase/PascalCase 常量（`maxArity`、`IntegralPattern`）。

**Kotlin 组合了三种已有技术。** Kotlin 没有 `static`：共享常量位于顶层、`object`（单例）或类的 `companion object` 中——均为 `val`/`const val`。类实例 `val` 是每对象状态。此前什么都没提取，因为 Kotlin 属性名嵌套（`property_declaration → variable_declaration → simple_identifier`），通用路径只读取直接子节点——**C 问题**的翻版。修复在 Kotlin 的 `visitNode` 钩子中处理 `property_declaration`（现有钩子已管理 `fun interface` 误解析）：提取嵌套名称，然后上走至外层定义设置类型——`object_declaration`/`companion_object`（或顶层）→ `constant`/`variable`（**Scala** 的 object vs class 规则），`class_declaration` → `field`，`function_body`/`init`/lambda 下的属性是局部，跳过。读取器扫描增加了 `simple_identifier`（Kotlin 的引用节点——**PHP `name`** 的动作；`simple_identifier` 在值引用集合中是 Kotlin 特有的），影子剪除增加了 `property_declaration`（方法局部 `val` 可以遮蔽 object const）。Kotlin 的解析保真度干净（唯一已知的误解析 `fun interface` 已处理），所以不像 C++ 没有精度尾巴。验证为最**干净**的语言之一：companion-object 位掩码和状态常量是大量同文件读取的惯用法（coroutines 的 `BLOCKING_SHIFT` 1→24，`TERMINATED` 2→22 在调度器中；okio 的 `STATE_IN_QUEUE` 1→32；ktor 的 content-type `TYPE` 8→109）。okio 有 0 冲突，coroutines 有 1 个（跨文件）。与 Scala 相同的 val/def 或类名称重叠限制（ktor 的 HTTP DSL 将头部常量和类命名为相同名称），加上兄弟 companion 情况（一个文件中多个 `companion object { const val TYPE }` 折叠到文件范围目标，类似 Ruby 的兄弟类）——两者均有界，每个调查的冲突都是真实的 object/companion const。

**Swift 复用了 Kotlin 技术并添加了两个 Swift 特有处理。** Swift 没有全局 `static` 关键字；其共享常量惯用法是顶层 `let` 或类型中的 `static let`——Swift 惯用地在 `enum`/`struct` 中*命名空间化*常量（`enum Constants { static let X }`）。属性名嵌套（`property_declaration → <name> pattern → simple_identifier`），这是 C 风格问题；读取器扫描已匹配 `simple_identifier`（为 Kotlin 添加——Swift 共用）。类型规则：顶层 `let` 和（任意类型中的）`static let` → `constant`（`var` → `variable`）；*实例* `let`/`var` 保留为 `field`（Swift 实例存储属性否则不是独立节点——保持不变）。两个 Swift 特有处理：(1) **值引用目标门控扩展到 `struct:`/`enum:` 父级**，因为 Swift 在那里命名空间化常量（其他所有语言的目标位于 `file:`/`class:`/`module:`）；没有它，大量使用的 `enum`/`struct` static const 都会被遗漏。(2) **跳过计算属性**——`var x: Int { … }` 有 getter 块，没有存储值，不是常量；提取器检测 `computed_property` 子节点并不发出节点（验证：扫描中没有计算属性泄漏）。节点创建嵌入*现有*的 Swift `property_declaration` 处理器（已提取 `@Published`/`@State` 等属性包装器/类型注解依赖），所以该行为保持不变。已验证 S/M/L（Alamofire/swift-argument-parser/swift-nio）：节点数开/关完全一致，真正的 static let 常量（`defaultRetryLimit`，swift-nio 的 `CONNECT_DELAYER`/`SINGLE_IPv4_RESULT` 测试常量，被 37 个方法读取的共享 `static let eventLoop`），计算属性已跳过，每个代码库 0–1 个冲突（与 Kotlin/Ruby 相同的兄弟类型名称重叠限制）。

**Dart——语法完成了作用域分离；关键是兄弟体问题。** Dart 的 tree-sitter 语法在这里异常贴心：**`static_final_declaration`** 节点*正好*是顶层或类 `static` 的 `const`/`final`——共享常量惯用法——而实例字段和 `var` 使用 `initialized_identifier`，方法局部使用 `initialized_variable_definition`。所以一条 `visitNode` 规则（`static_final_declaration` → `constant`，以其 `identifier` 子节点命名）捕获了所有且只有常量，**无需实例/局部泄漏守卫**，无需作用域上走（节点栈对顶层给出 `file:`，对 static 成员给出 `class:`）。读取器扫描已覆盖（Dart 引用是普通 `identifier`）。不明显的 bug：**Dart 将方法/函数的 `body` 作为签名节点的下一个*兄弟*附加**——签名就是存储为读取者作用域的节点——所以扫描只遍历了签名，产生*零*条边，直到被教会同时引入 `function_body` 下一兄弟（Dart 是唯一以这种方式组织体的值引用语言，所以这个检查在其他地方是无害的）。影子剪除计数所有三种 Dart 声明符节点，使方法局部 `const X` 正确地丢弃文件作用域 `const X`。已验证 S/M/L（http / flame-engine/flame / flutter/packages）：节点数开/关完全一致，真实源码上的真正 static const（flame 的 `cardWidth` 4→15，`tileSize` 3→12；HTTP/2 的 `Finishing` 1→10），与 Kotlin/Scala 相同的有界 const vs getter 名称重叠。**一个注意事项是生成代码：** 常见 Dart 代码生成后缀（`.g.dart` / `.freezed.dart` / `.pb.dart`）已被 `isGeneratedFile` 跳过，但仅有头部标记的生成器（带有数百个 `static final _class` 的 JNIGEN `_bindings.dart`）没有后缀检测，所以它折叠为文件范围目标并主导小型代码库的数字（http）——真实源码保持干净。

**Pascal / Delphi——简单路径加上 Dart 兄弟体修复和 `constant` 限制。** Pascal 在单元（文件）或类作用域的 `const` 节中保存共享常量，而这些*已经*被提取为 `constant`（`variableTypes: ['declConst', …]`），所以接线只需添加到 `VALUE_REF_LANGS` + 影子剪除（`declConst`/`declVar`——函数局部 `const X` 遮蔽单元 `const X`）。它遇到了**与 Dart 相同的读取器扫描 bug**：Pascal 将过程体（`block`）作为 `declProc` 头部（读取者作用域）的*下一兄弟*附加，两者都在 `defProc` 下，所以同样的兄弟引入修复扩展到了 `block`。Pascal 特有的问题是精度：Pascal 提取器将函数**参数**（`const ATarget: TControl`、`var Dest: …`）和类**字段**在外层作用域发出为 `variable`，这些折叠为嘈杂的文件范围目标——所以 **Pascal 值引用目标限制为 `constant`**（真正的共享值是 `const`；代价是罕见的单元级 `var` 全局）。这清理了大部分（`var` 参数/字段误报消除）。还剩少数残余——tree-sitter-pascal 在复杂多行 Delphi 方法签名中*上下文相关地*将 `const` 参数误解析为 `declConst`（`ATarget` 案例；不可孤立复现），这是类似 C++ 但小得多的解析保真度尾巴。修复后：mORMot 上的随机精度抽样是 100% TP（字体/加密/DB 常量相互引用），castle 的顶部目标全是真实的 FFI 绑定常量，0 冲突，头条是 FFI 库名常量——`LazGio2_library = 'libgio-2.0…'` 被 **1880** 个 `external` 声明读取（2→1880），mORMot 的 `LIB_CRYPTO` 1→358。**注意事项：** 应用代码的同文件密度低（跨单元读取；horse 给出 4 条边）、`constant` 限制、罕见的 const 参数误解析，以及 Pascal 的大小写不敏感（精确文本读取器扫描遗漏大小写不同的引用——是遗漏，而非误报）。

**C++ 已尝试并回退**——机制（文件/命名空间作用域 + 类 `field_declaration` 提取）在干净的 C++ 上是正确的，但 tree-sitter-cpp 在真实模板/宏密集型代码（以及 `.h`→C 语法路由）上的解析保真度，会将类成员和参数泄漏到文件作用域作为虚假常量。两个守卫（跳过 `ERROR` 或 `compound_statement` 祖先下的声明）消除了约 83% 的严重泄漏，但残余充斥于结构良好的库源码（模板类成员泄漏、合并的超大头文件、`.h` 当 C++ 使用）。未达到其他语言的精度标准，因此已回退。重振 C++ 需要先在 C++ 解析处理上做前置工作（模板类成员作用域、`.h` 当 C++ 检测、合并超大头文件排除），而非值引用接线传递。见 playbook 的 §2b C++ 说明。

**`tsx` 由 TS 那几行覆盖**——excalidraw 是 React/.tsx 代码库，所以头条 `tablerIconProps`（1→170）和大多数目标都在 `.tsx` 文件中。唯一的 tsx 特有路径——仅在 JSX 内（`<Foo x={CONST}/>`）读取的 const——依赖于读取器扫描向下进入 JSX 子树；它由单元测试（`value-reference-edges.test.ts`）锁定，所以不需要独立的 tsx 代码库扫描。

**Svelte / Vue / Astro 免费覆盖**——它们的提取器将 `<script>` / 前置内容块重新解析为 `typescript` / `javascript`，这两者都在 `VALUE_REF_LANGS` 中，所以 `.svelte`/`.vue`/`.astro` 脚本中的 `const` 无需任何额外工作即可与其读取者建立边（在合成的 `.svelte` 上验证）。无需独立的矩阵行。完整的对比 README 语言列表的状态见 playbook 的覆盖追踪（§2b）。

**JavaScript 说明——CommonJS `require` 绑定是目标，这是正确的。** JS 的边增长（~4–5%）高于 TS（~0.7–1.6%），因为 `var x = require('…')` 绑定和模块级 `var` 状态通过了有辨识度名称门控，并被同文件函数读取。这些*不是*噪声：修改这样的绑定（替换依赖项、重新赋值状态）真实地影响其读取者，所以它是合法的影响目标。在与已有 `calls` 边重叠的地方，`getImpactRadius` 按节点去重——不会重复计数。（TS 的 `import` 完全规避了这一点：它们是 `import` 类型的节点，而非 `const`/`var`，所以永远不是目标。）

## 智能体 A/B——能带来什么和不能带来什么（excalidraw，sonnet/high，12 次运行）

- **影响 API（胜出之处）：** `impact` ON vs OFF——`tablerIconProps` 1→170，`COLOR_PALETTE` 15→26，`CaptureUpdateAction` 61→86。这是 `synapse impact` 和 Synapse Pro 的评判引擎通过 `getImpactRadius` 消费的内容。
- **智能体读取置换：无——这是预期的。** 在已索引的代码库上，智能体用一次 synapse 调用回答影响问题（*两组*均 0 次 Read / 0 次 Grep），它使用 `synapse_search` / `callers`，**而非** `impact`/`explore`，所以通常根本不查询值引用边。ON 从未比 OFF 更差。**不要声称值引用减少智能体读取**——胜出在爆炸半径的正确性，而非更少的轮次。（这是"让工具适应智能体"的墙：只有当智能体调用遍历边的工具时，边才有帮助。）

## 已知限制（有意的）

- **仅参数的遮蔽**没有被守卫。影子剪除计数 `variable_declarator`，所以一个被同名函数参数*仅仅*遮蔽的文件作用域 const 会溜过去。在 S/M/L TS 验证中没有观察到，且守卫它会过度剪除名称与文件其他地方某个参数重合的合法 const——所以保持未守卫状态，直到真实代码库暴露出来。
- **仅限同文件。** 跨文件值消费者（在其他地方导入并读取的 const）不建立边；那需要导入/作用域解析，超出范围。
- **响应式/计算式读取**（仅通过框架 getter 读取的值）没有可匹配的静态标识符，不在覆盖范围内。

## 扩展到另一种语言

逐步操作手册——接线核对清单、验证脚本、FP 追踪、每语言声明符类型和已踩的坑——在
[`value-reference-edges-playbook.md`](./value-reference-edges-playbook.md) 中。将新会话指向它，说"从语言 X 开始"。简而言之：决定该语言的常量是文件/模块作用域（适配）还是类作用域（更大的改动）；确认影子剪除的声明符节点类型；在小/中/大公共 OSS 代码库上扫描；修复 FP 簇；在这里添加矩阵行 + 测试。
