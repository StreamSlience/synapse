# 设计与状态：链式静态工厂 / 流式调用解析

**状态：** 已为 **13 种语言**发布（C++、C、PHP、Java、Kotlin、C#、Swift、Rust、Go、Scala、Dart、Objective-C、Pascal/Delphi）+ 一次一致性遍历。**TypeScript 和 Luau 已评估并刻意跳过**（两者均为渐进类型 → 该机制在真实代码上 +0 / 出现回退）。见下方"完整 README 分类"。跟踪 issue：**#750**（最初表述为"静态类型的 README 语言"，但该枚举不完整——遗漏了 ObjC / Pascal / Luau）。

**动机：** 一个**接收者本身是一次调用**的调用——工厂 / 单例 / 构建器，返回一个对象——应为链式方法生成 `calls` 边：

```java
Foo.getInstance().bar();   // bar() 应解析到 Foo::bar，而非同名的干扰项
```

此工作之前，每种静态类型语言都会**丢弃接收者**并对裸方法名（`bar`）进行名称匹配，导致 9 种语言中有 7 种会悄悄链接到**不相关类型上的同名方法**——这是正确性 bug，而非仅仅是覆盖缺失。

---

## 三部分机制（每种语言）

1. **捕获工厂的声明返回类型** — 每种语言专属的 `getReturnType` 钩子写入 `nodes.return_type`（schema v5）。`*Foo`→`Foo`，`List<Bar>`→`List`，`pkg.Foo`→`Foo`，`-> Self` / `: self` / `this.type` → 声明类型。
2. **在提取时保留链式接收者** — `tree-sitter.ts`（或专用提取器）将 `Foo.getInstance().bar()` 编码为标记字符串 `Foo.getInstance().bar`（`().` 标记在普通 ref 中不会出现）。每种语言的门控保持**实例**链（`list.map().filter()`）为裸格式，使其现有解析不受影响——只有大写接收者/工厂链重新编码。
3. **解析并验证** — 解析时从内层调用的返回值推断接收者类型，然后**在该类型上**解析外层方法，并进行验证：方法必须存在于该类型（或其遵守的超类型）上，因此错误推断产生**无边**，而非错误边。

`src/resolution/name-matcher.ts` 中的三个共享解析器，均调用 `resolveMethodOnType`（含一致性超类型遍历）：

| 解析器 | 接收者风格 | 语言 |
| --- | --- | --- |
| `matchCppCallChain` | `field_expression`（`Foo::instance().bar`） | C++、C |
| `matchScopedCallChain` | `::`（`Cls::for($x)->m`，`Foo::new().bar`） | PHP、Rust |
| `matchDottedCallChain` | `.`（`Foo.create().bar`） | Java、Kotlin、C#、Swift、Go、Scala、Dart |

**一致性遍历（#754）。** 当链式方法位于返回类型所遵守的**超类型**上（继承 / 默认接口 / trait / mixin / 嵌入方法）时，第一遍无法看到它——`implements`/`extends` 边尚未构建。因此，失败的链式 ref 被推迟（`resolution/index.ts` 中的 `CHAIN_LANGUAGES`），在边存在后的第二遍 `resolveChainedCallsViaConformance()` 中重新解析，遍历 `context.getSupertypes(...)`。

**添加一种语言：** 在 `languages/*.ts` 中实现 `getReturnType`；编码链式接收者 + 节点类型门控；将该语言添加到正确的 `matchReference` 门控（若裸大写调用构造类，还需加入 `CONSTRUCTS_VIA_BARE_CALL`）；加入 `CHAIN_LANGUAGES`；编写合成测试 + 真实代码库 A/B；递增 `EXTRACTION_VERSION`。

---

## 覆盖情况（已验证——每种语言均通过合成诱饵/缺失方法测试 + 真实代码库 A/B）

| 语言 | PR | 接收者 | 真实代码库 A/B（唯一 `calls` 边） | 说明 |
| --- | --- | --- | --- | --- |
| **C++ / C** | #645 (#742) | `field_expression` | — | 最初：单例 / 工厂 / 链式 getter。 |
| **PHP** | #608 (#749) | `::` → `->` | — | `Cls::for($x)->method()` — Laravel 每租户客户端惯用法。`: self`/`: static`。 |
| **Java** | #751 | `.` | Guava **+1,507 / −0** | 缺失边 → 纯增量。 |
| **Kotlin** | #752 | `.` | arrow **+49 / −438** | 错误边 → 精度提升（438 个被移除 = 测试/文档噪声 + 错误项）。需要大写接收者门控 + 构造函数接收者处理。 |
| **C#** | #753 | `.` | Newtonsoft +3 / NodaTime **+73 / −0** | 增量式。返回类型来自 `returns` 字段；扩展方法链正确地不解析。 |
| **一致性** | #754 | （解析器升级） | arrow **+22 / −0** | 超类型遍历——启用 Swift protocol-ext、Rust trait、Go 嵌入、Dart mixin、Java/Kotlin/C# 继承链。 |
| **Swift** | #755 | `.` | Alamofire / Kingfisher **0 / 0** | 中性安全（唯一的流式名称已通过裸名称解析）。需要嵌套扩展命名修复（`KF.Builder`→`KF::Builder`）。 |
| **Rust** | #757 | `::` | clap **+937 / −775** | 精度提升（622 个错误→正确重定向，+162 净增）。`-> Self`；trait 默认方法通过一致性遍历。单跳。 |
| **Go** | #760 | `.` | gin **净零** | `New().Method()`；嵌入结构体通过一致性遍历。变量内层回退。**发现并修复了批处理解析器失控**（变更后的 `original.referenceName` 使 offset-0 批次循环 → 5M 边 / 1.4 GB；通过将回退绑定到原始 ref + 无进展守卫修复）。 |
| **Scala** | #761 | `.` | gatling **+14 / −59** | 精度提升（−59 = 基线将 stdlib `Option`/`Iterator` `.map`/`.flatMap` 错误绑定到 gatling 的 `Validation::*`）。伴生工厂 + case class `apply`。 |
| **Dart** | #762 | `.` | localsend 手写 **+17 / −10** | 精度提升 + **构造函数提升为一等公民**（工厂/具名构造函数 `Foo.create()`/`Foo._()` 现已索引；无名 `Foo()` 仍保持 `instantiates`）。`dartCtorInfo` 验证构造函数与外层类名——处理 tree-sitter 误解析（`@override (A,B) m()` 使 `m()` 看起来像构造函数）。 |
| **Objective-C** | #786 | 消息发送 | SDWebImage **+35 / −75** | 精度提升。链式消息发送 `[[Foo create] doIt]`，基于 `message_expression`。getReturnType 跳过可空性限定符（`nonnull instancetype`）。类消息工厂按约定返回接收者类，因此 `[[X alloc] init]` / 单例链在 `X` 上解析（已验证）。−75 是重新定向到正确类的错误 `init` 误匹配。 |
| **Pascal/Delphi** | #791 | `.`（`exprDot`） | PascalCoin **+19 / −18** | 精度提升。Pascal 的 `exprCall`/`exprDot` 上的 `TFoo.GetInstance().DoIt()`。getReturnType 来自 `typeref`（含接口返回 `IFoo`）。重编码门控于 Delphi `TFoo`/`IFoo` 类型约定，使大写*变量*链保持裸格式。无 `: TBar` 的构造函数或类型转换 `TFoo(x)` 在类上解析。−18 中有 15 个是正确的类→接口重定向（`GetInstance(): IAsn1OctetString`）。 |
| **TypeScript** | — | `.` | typeorm +0/−6 · nest **+0/−164** | **已评估，未发布** — 渐进类型；见下文。 |
| **Luau** | — | `:` / `.` | Fusion +0/−0 · matter +0/−0 | **已评估，未发布** — 渐进类型；增量安全（缺失边空洞，无回退），但真实 Luau 代码很少标注工厂返回类型，因此两个基准测试均为 +0。对 `Foo.create(): Bar` 后接 `:doIt()` 有效（合成测试）。 |

`EXTRACTION_VERSION` 现在为 **18**（C++→…→Pascal 链→无括号调用→自由例程归属）。在现有图上运行 `synapse index -f` 以使用更新的提取器。

## 为什么跳过 TypeScript

该机制从工厂的**声明**返回类型解析链。TypeScript 依赖**类型推断**——例如 NestJS 的 `Test.createTestingModule(m) { return new TestingModuleBuilder(...) }` 没有 `: TestingModuleBuilder` 注解——因此工厂类型无法恢复，重编码的链无法解析，并且会**丢弃**现有解析器找到的裸名称边。真实代码库 A/B 在 typeorm 和 nest 两个代码库上均为 **+0 新增**，且净召回率回退（nest −164，主要是无处不在的 `Test.createTestingModule({…}).compile()` 模式）。被移除的边大多是*错误的*（基线将 `.compile()` 错误解析到 `ModuleCompiler::compile`），因此精度为正但召回率为负——违反了召回优先不变式，且在不造成伤害的地方也没有任何新增（TS 方法名已足够唯一，裸名称已能正确解析）。该机制已完整实现（5 个合成测试通过，裸名称回退安全无失控），并经过深思熟虑后未发布。TS 的唯一改进路径是读取**推断**返回类型（解析工厂体中的 `return new X()`）——这是更大的变更。完整说明见 issue #750。

---

## 完整 README 分类（全部 21 种语言）

该机制真正的要求是**声明的返回类型**以恢复接收者类型——而非"静态类型"（PHP 通过 `: self` / `: Type` 返回声明符合条件）。对照 README 完整支持语言列表：

| 分类 | 语言 |
| --- | --- |
| **已覆盖**（13）| C++、C、PHP、Java、Kotlin、C#、Swift、Rust、Go、Scala、Dart、Objective-C、Pascal/Delphi |
| **已评估，已跳过**（2）| **TypeScript** — 渐进类型 → 推断类型工厂无法恢复；净召回率回退。**Luau** — 渐进类型；增量安全但在 Fusion 和 matter 上均为 +0（真实 Luau 很少标注工厂返回类型）。两者：该机制需要可靠声明的返回类型，而渐进类型代码经常缺失。 |
| **Pascal 调用覆盖后续** | 链式调用工作中的两个缺口，均已解决。**无括号调用（#793）：** Pascal 允许无参方法省略括号（`Obj.Free;`，`TFoo.GetInstance.DoIt;`），它们被解析为裸 `exprDot`，之前根本不被提取为调用。现已提取，限定在 STATEMENT 位置（赋值/条件位置的裸 dot 保持不变——与字段/属性访问存在歧义）。PascalCoin A/B **+1131 / −1**，所有新边均解析到方法。**自由例程归属（#795）：** 仅在 `implementation` 节（无接口声明，非方法）中定义的过程/函数之前没有节点，其 body 的调用被归入文件级别；现在它获得函数节点，其调用归属于它。PascalCoin A/B **+511 / −145**（文件级聚合 → 每例程边）。 |
| **超出范围——无声明返回类型**（6） | JavaScript、Ruby、Lua、Svelte、Vue、Liquid（Liquid 根本没有方法/链） |
| **部分 / 独立**（1） | Python — 仅有可选的 `-> T` 注解；跟踪于 #578，不属于本机制 |

因此 #750 最初的表述（"9 种静态类型 README 语言"）不完整——它遗漏了三种已处理的类型语言：**Objective-C** 已发布（#786，相同的错误边缺口，机制直接移植）；**Pascal/Delphi** 已发布（#791，括号链的干净移植——最初"受阻"的判断是错误的，原因是只探测了无括号形式）；**Luau** 已评估并跳过（渐进类型 → 真实代码库 +0，增量安全）。

贯穿其中的主线：本机制适合具有**可靠声明返回类型**的语言（已发布的 13 种）。渐进类型语言（TypeScript、Luau）省略得太频繁而难以回报，动态类型语言则完全没有。

---

## 边界情况 / 模型

- **单跳**：链式重编码一跳；更深的跳（`a.b().c().d()`）保持裸名称（内层 `()` 破坏了 `Class::method` 拆分）。在深度流式构建器代码库上重新测量。
- **验证，而非猜测**：每个解析器均以 `resolveMethodOnType` 结束，因此未知 / 错误推断类型产生**无边**——这是使其可安全发布的诱饵 / 缺失方法保证。
- **每种语言的接收者门控**保持实例链为裸格式，使现有解析绝不回退；A/B 中"移除"的计数是错误边修正，而非损失。

## 相关工作

- **动态分发 / 回调合成**（*不同*机制）：观察者 / EventEmitter / React-render / JSX-child / django-ORM 边合成位于 `callback-edge-synthesis.md` + `dynamic-dispatch-coverage-playbook.md`。
- #750 的详细会话工作笔记位于 `.claude/handoffs/chained-call-multilang-probe.md`（草稿；本文是正式记录）。
