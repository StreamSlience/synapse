# 函数值捕获（#756）——回调注册链接

**问题。** 被用作*值*的函数——作为参数传递、赋值给函数指针或字段、放入结构体初始化器或处理器表——在 19 种 tree-sitter 语言中均**不产生任何边**（2026-06-11 探针；0/19）。C 回调上的 `callers(my_recv_cb)` 除直接调用外什么也没显示，因此每个已注册的回调看起来都是死代码，注册点——智能体实际上最想知道的下一个问题（"它在哪里接入？"）——是不可见的。

**刻意不做的事情。** 解析*分发*（`o->cb(x)` → 具体注册的函数）需要通过结构体字段进行数据流分析；即便是 LSP 也需要回退方案（见 #756 讨论）。部分覆盖比没有覆盖更糟，错误的边比沉默更糟——分发解析维持不覆盖。发布的是*注册*侧，这是确定性的：函数名字面上就在注册点的源码中。

## 机制

```text
捕获（tree-sitter.ts 遍历器，按语言表驱动：src/extraction/function-ref.ts）
   → 门控（flushFnRefCandidates：同文件 fn/method 名称 ∪ 导入绑定名称；
            C 系列文件作用域初始化器跳过门控——见下文）
   → 未解析 ref，referenceKind 'function_ref'（仅内部使用的类型）
   → 解析（resolveOne 分支：先 resolveViaImport，再 matchFunctionRef——
                 精确名称，仅 function/method 类型，同语言家族，同文件优先，
                 仅在 UNIQUE 时才跨文件，永不模糊匹配）
   → 边类型 'references'，metadata { fnRef: true, resolvedBy, confidence }
```

`getCallers`/`getCallees`/`getImpactRadius` 已遍历 `references`，因此注册点无需图层改动即可呈现。MCP 调用者/被调用者列表将其标注为"通过回调注册"。

捕获从三个遍历器触发（一个节点只被一个遍历器访问）：`visitNode`（文件/类作用域）、`visitForCallsAndStructure`（函数体）、`visitPascalBlock`（Pascal 体）。遍历器无需向下递归就消费的子树（顶层变量初始化器、类字段/属性初始化器、Scala 的 val/var 处理器等自定义 `visitNode` 钩子）有一个仅候选的 `scanFnRefSubtree`，在嵌套函数边界处停止。

## 每种语言的值位置（探针已验证）

| 语言 | 参数 | 赋值右侧 | 键值初始化 | 列表/表格 | 包装形式 |
| --- | --- | --- | --- | --- | --- |
| C / ObjC | `argument_list` | `assignment_expression.right` | `initializer_pair.value` | `initializer_list`，`init_declarator.value` | `&fn`（`pointer_expression`），`@selector(...)`（ObjC） |
| C++ | 仅参数/右侧/变量初始化中的 **`&` 形式** | （同上——仅显式 `&`） | 仅文件作用域的裸 id | 仅文件作用域的裸 id | `&fn`，`&Cls::method`（解析时限定到该类） |
| TS / JS (tsx/jsx) | `arguments` | `assignment_expression.right` | `pair.value` | `array`，`variable_declarator.value` | `this.method`（`member_expression`，类作用域——见规则 3） |
| Python | `argument_list`，`keyword_argument.value` | `assignment.right` | `pair.value` | `list` | `self.method`（`attribute`） |
| Go | `argument_list` | `assignment_statement` / `short_var_declaration`（`expression_list`） | `keyed_element` | `literal_value`，`var_spec.value` | — |
| Rust | `arguments` | `assignment_expression.right` | `field_initializer.value` | `array_expression`，`static_item` / `let_declaration.value` | — |
| Java | `argument_list` | `assignment_expression.right` | — | `variable_declarator.value` | `method_reference`（`Cls::m`，`this::m`）——唯一形式 |
| Kotlin | `value_arguments` | `assignment`（最后一个子节点） | — | — | `callable_reference`（`::f`），`navigation_expression` `this::m` |
| C# | `argument_list`（`argument`） | `assignment_expression.right`（含 `+=`） | — | `initializer_expression`，`variable_declarator` | `this.M`（`member_access_expression`；厂商语法保持 `this` 匿名——已处理） |
| Ruby | `argument_list` | — | `pair.value` | — | 仅 `method(:sym)` / `&method(:sym)`——Ruby 中的裸 id 是调用/局部变量 |
| Swift | `value_arguments`（`value_argument.value`） | `assignment.result` | （带标签的构造参数 = 参数） | `array_literal`，`property_declaration.value` | `#selector(...)` |
| Scala | `arguments` | `assignment_expression.right` | — | `val_definition.value`（通过钩子扫描） | eta `fn _`（`postfix_expression`） |
| Dart | `arguments`（`argument`） | `assignment_expression.right` | `pair.value` | `list_literal`，`static_final_declaration` | — |
| Lua / Luau | `arguments` | `assignment_statement`（`expression_list.value`） | `field.value`（键值 + 位置） | （同上） | — |
| Pascal | `exprArgs`（通过 `visitPascalBlock`） | `assignment.rhs`（`OnFire := Handler`） | — | — | `@Handler`（`exprUnary.operand`） |
| PHP | 仅已知核心高阶函数参数中的字符串可调用（`usort`、`array_map`、`call_user_func*`……——`PHP_CALLABLE_HOFS`），不门控 + unique-or-drop（PHP 全局变量不被导入） | — | — | — | `[$this, 'm']` → 类作用域 `this.m`；`[Foo::class, 'm']` → 限定；`'Cls::m'` → 限定；首类可调用 `fn(...)` 已作为 `calls` 提取 |
| Ruby 钩子 | `(skip_)?(before\|after\|around)_*` + `validate`/`set_callback`/`helper_method`/`rescue_from(with:)` 符号 → 类作用域 `this.<sym>`（走超类型遍历：`before_action :authenticate` → ApplicationController）。`validates`（复数）排除——其符号是**属性** | — | — | — | 任何其他调用下的符号不产生任何内容 |

## 精度规则（每条都由真实代码库的假正例驱动）

1. **门控**（提取时）：候选仅在名称匹配同文件函数/方法或**已导入绑定**（仅 `referenceKind === 'imports'`——抓取类型注解 `references` 名称允许了与类型成员同名的局部变量；excalidraw）时才存活。
2. **C 系列无门控文件作用域**：C 没有符号导入，且在整个仓库范围内跨文件注册回调（redis 的 `server.c` 命令表命名了来自 `t_*.c` 的处理器）。文件作用域初始化器位置（`value`/`list` 模式）跳过门控——安全，因为 C 文件作用域初始化器是**常量表达式上下文**：裸标识符在那里只能是函数地址（枚举/宏名称被类型过滤器丢弃）。局部初始化器和赋值保持门控：`prev = next`、`*str = field`、`arena_ind_prev = arena_ind`（redis/jemalloc）每个都匹配到了某处唯一同名函数，当 `rhs`/`varinit` 无门控时产生错误边。
3. **TS/JS/Python：裸 id 仅解析到 `function` 类型。** 这些语言中裸标识符永远不能是方法值（方法需要接收者——`this.m` / `self.m`），因此允许方法目标会吸收作为参数传递的局部变量（`new Set(selectedPointsIndices)`；docopt.py 的 `name`/`match` 参数——excalidraw/fmt A/B 发现）。TS/JS 的 `this.X` 值被捕获为带 `this.` 前缀的候选，并进行**类作用域**解析（`src/resolution/index.ts` 中的 `resolveThisMemberFnRef`）：目标必须是限定名与来源符号的类前缀共享的函数/方法，同文件，无任何回退——`addEventListener(…, this.onResize)` 命中外层类的方法；`this.fonts`（属性，#808 后字段分类）和继承/未知成员不产生边。Python 的 `self.m` 形式通过其自身的捕获形态保留方法目标。C#/Swift/Dart/Java/Kotlin 保留方法目标（方法组、隐式 self、方法引用是真实的方法值）。
4. **C++ 是显式 `&`**（`addressOfOnly`）：裸标识符仅在文件作用域初始化表中符合条件；其他地方（参数、赋值、局部花括号初始化 `{begin, size}`）只有 `&fn` / `&Cls::method` 有效。C++ 代码库中充满了与局部变量冲突的通用自由函数名（`begin`、`end`、`out`、`size`、`data`），且**离线**成员定义被提取为 *function* 类型节点，破坏了类型过滤器——裸 id 匹配在 fmt 上大多是错误边（72 个通用名 + 105 个成员/宏误匹配 → 应用规则后：22 条边，约 20 个真实的 gtest 成员指针接入）。`&x` 与 `*x` 共享 C 的 `pointer_expression`；只有 `&` 运算符符合条件。`&Cls::method` 限定解析到该类。
5. **Swift 重载家族拒绝**：一个文件中多个同名**方法**（`Session.request(...)` × N）+ 裸标识符 = 几乎总是同名参数，而非方法值（Alamofire）——拒绝而非猜测。唯一方法（SwiftUI 的 `action: handleTap`）仍然解析。
6. **参数转发跳过**：`this.status = status` / `o->cb = cb`（赋值中成员名等于右侧标识符）以及 Swift/Kotlin 带标签参数 `value: value`——被转发的局部/参数，其函数值不可知；其他地方的同名函数会是**错误**目标。
7. **解构跳过**：`const { center } = ellipse` 是数据提取，永远不是函数别名。
8. **生成/压缩文件**（`*.min.js` 以及 `generated-detection.ts` 中的代码生成模式）不产生 fn-ref 候选——压缩的单字母符号在任何地方都能解析（Alamofire 内嵌的 jquery）。
9. **解析**：仅 function/method 类型，相同语言家族，永不是 ref 自身节点（无自环），同文件匹配优先，仅当名称**唯一**时才跨文件——歧义产生**无边**。无任何模糊回退（`matchReference` 对 `function_ref` ref 短路到 `matchFunctionRef`）。
10. **失控不变式**（#760）：`matchFunctionRef` 始终返回 `original: ref`——存储的行——因此 `deleteSpecificResolvedReferences` 能排空批次。

## 验证（2026-06-11，EXTRACTION_VERSION 19）

无暂存 A/B（基线 = `main` 处的 worktree），全新浅克隆，仅公开 OSS。每个代码库：节点数必须相同，`calls` 边相同，`references` 严格增量，通过读取采样 `fnRef` 边的源码行进行精度抽查。

最终构建，全部 17 个代码库（每行节点数相同，calls 边未改动；`unresolved_refs` 完全排空——无批处理解析器失控）：

| 语言 | 代码库 | 节点数（基线=修复） | calls Δ | 新增 refs | 说明 |
| --- | --- | --- | --- | --- | --- |
| C | redis | 18931 | 0/0 | **+1918** | 30/30 采样均真实——操作表、qsort 比较器、模块注册、lua 库表 |
| TS/React | excalidraw | 10299 | 0/0 | **+121** | 18/20——残余 = 参数遮蔽了已导入函数（文件级依赖是真实的） |
| Go | gin | 2599 | 0/0 | +14 | |
| Rust | bytes | 947 | 0/0 | +76 | `map(fn)`，结构体初始化 |
| Java | okhttp | 16008 | 0/0 | +2 | 仅方法引用形式，设计如此 |
| Kotlin | okio | 7801 | 0/0 | +1 | 仅 `::fn` 形式，设计如此 |
| Swift | alamofire | 3477 | 0/0 | +116 | 对抗性案例（参数与 API 名称相同）；应用了重载家族 + 标签==名称规则 |
| Python | flask | 2705 | 0/0 | +111 | 8/8 采样均真实——含 `ensure_sync(self.dispatch_request)` |
| Ruby | sinatra | 1751 | 0/0 | +8 | 仅 `method(:sym)` |
| C# | newtonsoft | 20208 | 0/0 | +38 | 方法组，`+=` |
| Scala | scopt | 694 | 0/0 | +10 | eta 展开 |
| Dart | provider | 1154 | 0/0 | +73 | 隐式 this getter 读取——真实的同类依赖 |
| Lua | busted | 1257 | 0/0 | +14 | |
| Luau | fusion | 2126 | 0/0 | +18 | `:Connect(fn)` |
| ObjC | afnetworking | 1487 | 0/0 | +52 | `@selector`，target-action |
| Pascal | pascalcoin | 48788 | 0/0 | +577 | `OnClick :=` 事件接入 + 无括号调用 refs（见限制） |
| C++ | fmt | 7345 | 0/0 | +22 | 应用 addressOfOnly 后约 20/22 个真实的 gtest 成员指针接入 |

redis 上的索引开销：时间 +6%，DB 大小 +5%。

## 已知限制（已记录，刻意为之）

- **分发解析**（`o->cb(x)` → 实现）：未覆盖，见上文。
- **门控位置中的 C 跨文件**：通过不同文件中的*赋值*注册的外部回调仅在名称在整个仓库中唯一时才解析（初始化表没有这个限制——它们在文件作用域无门控）。
- **C++ 裸名注册**（`register_handler(my_cb)` 不带 `&`）：被 `addressOfOnly` 丢弃——通用名称冲突率使裸 id 在真实 C++ 中净为负收益（fmt）。`&my_cb` / 文件作用域表覆盖了这些惯用法；C 文件保留裸参数。
- **局部/参数遮蔽了已导入或同文件函数**（`mutateElement(newElement, …)` 其中文件也导入了 `newElement`；JS 插件的 `indexOf(val)` 与同文件的 `val()` 辅助函数）：在没有局部作用域跟踪的情况下不可消除——刻意留作数据流前沿的未覆盖内容。在回调密集型代码库中，每 20 个采样边约有 1-2 个；每个观察到的案例中文件级依赖都是真实的。
- **Swift 同类参数冲突**（`eventMonitor?.request(self, didFailTask: task…)` 其中外层类型也有 `task` 方法）：外层类型作用域（隐式 self——方法仅匹配来源符号自身的类型，顶层裸 id 永不匹配方法）消除了 Alamofire 上的跨类冲突（−44 个错误边），但**与**同一类型方法同名的参数在静态上与隐式 self 方法值不可区分。已记录的残余问题。
- **Pascal 无括号调用**（`Result := DoInitialize`）：捕获为引用（Pascal 在没有类型信息的情况下无法区分过程**值**与无括号**调用**）。依赖方向是正确的，这些调用之前完全不可见（#791）——比之前更真实，标注不完美。
- **通过变量的 Java/Kotlin 方法引用**（`subscriber::onNext`，`m::run0`）：接收者类型静态未知——刻意不产生边（obj.method 类）。RxJava 基线的裸捕获将这些解析到同文件同名方法（测试方法"注册"了匿名类的 `onNext`）；限定重构丢弃了它们。`Type::method` 跨文件解析（作用域限于同文件类型 ∪ 已导入名称，包括点分 JVM 导入的最后一段）；`this::m` / `super::m` 走类作用域 + 超类型路径。
- **限定的 `Type::member` 候选跳过名称门控**（类似 `this.X`）：Java/Kotlin 同包引用和 Kotlin 伴生对象不需要导入，因此门控永远看不到它们的作用域——而显式引用语法是自选择的，解析仍以作用域后缀为锚 + unique-or-drop（`Decoy::handle` 不能匹配 `KtHandlers::handle` ref）。这也是解析伴生成员 ref 的原因：伴生对象在真实多行代码中**透明地**提取（`KtHandlers::handle`，类的方法）。（单行 `class X { companion object { … } }` 是上游 tree-sitter-kotlin 的误解析——ERROR 节点——且只出现在我们自己的探针固件中；不要追它。）
- **Swift 跨文件裸引用**：Swift 无需导入即可看到模块范围的符号，因此跨文件裸回调仅在仓库唯一时才解析（函数；方法仅限外层类型）。跨类型 `#selector` 目标（罕见——target-action 通常是 self）也被作用域排除。
- **`obj.method` 成员值**（其中 `obj` 不是 `this`/`self`）：已推迟——接收者类型在没有局部数据流的情况下静态不可知。
- **已知高阶函数位置之外的 PHP 字符串**（任意函数的裸 `'handler'`；WordPress `add_action` 等框架注册表）：刻意不捕获——字符串仅在已知可调用位置才可信赖为可调用。框架注册表如需添加属于 `frameworks/` 解析器。Ruby 的钩子 DSL 之外的**符号**同理。
- **超类型遍历是节点锚定的**（文件锚定的类节点 → implements/extends 边目标 → `contains` 锚定的成员查找）：基于名称键的 `getSupertypes('Engine')` 合并了每个 rails `Engine` 的父类并产生了跨类错误边；节点遍历消除了它（rails +440 → +385，所有采样边均真实）。
- **`this.X` 继承成员通过超类型遍历解析**（`resolveDeferredThisMemberRefs`，深度上限 BFS 遍历 implements/extends，在边持久化后运行——与 #750 一致性遍历的生命周期相同）。将 getter 读入局部变量（`const s = this.snapshot`）仍产生到 getter 的引用边——一个具有不完美"注册"味道的真实依赖。
