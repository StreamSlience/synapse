# 设计与状态：自适应 `synapse_explore` 输出规模（兄弟节点骨架化）

**状态：** 已实现并验证，**默认开启**，位于分支
`feat/adaptive-explore-sizing`（初始提交 `d6d059f`；**2026-05-29 精化**，
经过真实智能体 A/B 测试发现了读回归问题——详见下方"精化"章节）。
逃生舱：`SYNAPSE_ADAPTIVE_EXPLORE=0`。
**动机：** 让 `synapse_explore` 的输出规模与*答案*匹配，而非总是填满预算上限——
这样一个"兄弟节点密集"的流程（同一接口的多个可互换实现）就不会比直接
grep/read 代价更高，同时也不会让真正需要大量源码的"扩散型"流程陷入饥荒。

> **精化（2026-05-29）——读回归问题。** 第一版仅对*脊外 + 多态兄弟*进行门控。
> 真实智能体 A/B 测试（非确定性探针）发现：智能体随后**读回**了两个被骨架化的文件，
> 适得其反：OkHttp 的 `RealCall`（它实现了 9 实现的 `Lockable` *mixin*，因此触发了兄弟
> 信号，尽管它是编排者）和 Django 的 `compiler.py`（它*定义*了 `SQLCompiler` 并将子类
> 置于同一文件）。两个条件修复了这一问题——仅当文件**未被豁免**时才骨架化，
> 其中**豁免 = 智能体在该文件中命名了一个可调用符号**
> （`getResponseWithInterceptorChain`、`SQLCompiler.execute_sql` → 保持完整）
> **除非该文件定义了一个 ≥3 实现的超类型**（基类+子类的"家族"文件体积庞大且无论如何会
> 被读取，因此骨架化它能*释放探索预算*给智能体本应逐一读取的兄弟文件）。
> 结果：OkHttp **从成本增加 3% 变为降低约 10%**（RealCall 保持完整，0 次读回）；
> Django **从成本增加 10% 变为降低约 10%**（compiler.py 骨架化释放了 28KB 预算中的约
> 6.5KB；一半运行以 0 次读取作答）。超类型信号最初被用作*豁免*条件——那是反的，使
> Django 回归到成本增加 9%；现在它改为*覆盖*命名可调用符号的豁免。下方单条件历史记录
> 仅作背景保留。
>
> **进一步精化（2026-05-29）——按符号聚焦视图 + 命名簇保留。** 整文件骨架化/豁免对
> 真实 Django A/B 而言仍过于粗糙：智能体读回了 `compiler.py`（折叠后其 `execute_sql`/
> `as_sql` 体被省略）和 `query.py`（一个非兄弟的超大文件，其 `_fetch_all` 簇被裁剪）。
> 四项改进使两个代码库从约 9–10% 变为**约 14–17% 成本更低**，**中位数 0 次读取**：
>
> 1. **唯一性感知豁免**——只有（近）唯一的命名可调用符号才豁免文件。`as_sql` 在每个
>    Compiler/Expression 子类中有 **110 个定义**；命名它不应让每个后端变体保持完整
>    （这在淹没 Django 的预算）。`getResponseWithInterceptorChain`（1 个定义）仍豁免
>    RealCall。
> 2. **按符号聚焦视图**——折叠的家族文件显示脊上/唯一命名/规范基类超类型方法的**完整
>    体**，其余仅显示**签名**。因此 `SQLCompiler.execute_sql`/`as_sql` 保留，而 80 个
>    其他符号 + 冗余子类折叠 → 无需读回。
> 3. **所有层级排除测试文件**——一个测试文件（`custom_lookups/tests.py`）占用了
>    Django 28KB 预算中的 2.3KB；测试文件很少能回答架构问题。（此前仅 <500 文件的层级
>    排除测试文件。）
> 4. **非兄弟文件中命名簇的保留**——将智能体命名的方法定义注入文件的簇中（即使收集
>    阶段遗漏），赋予重要性 9，并以 `min(每文件上限, 剩余总量)` 限制簇选择，使高重要
>    性的命名簇得以保留，而不会被源码顺序裁剪（Django 的 `_fetch_all`，L2237，四个大
>    文件中最后一个）。
>
> 对照组维持不变：OkHttp 成本降低 14% / 0 次 RealCall 读回；Excalidraw 成本降低 31%
> / 0 次读取（超大文件聚类不受影响——其大文件首先输出，因此预算上限不会约束它）。
> OkHttp 的拦截器仍是纯签名骨架（其中无命名可调用符号，且未定义超类型）。

---

## TL;DR

`synapse_explore` 对每个相关文件（在字符预算内）都返回完整源码。对于答案横跨许多
*形状相同*的类的问题——例如"OkHttp 如何通过拦截器链处理请求？"，涉及约 14 个
`class … : Interceptor` 实现——这意味着约 28KB 大多是**冗余完整体**。由于这些体在
会话后续一直占据上下文窗口，有 synapse 的一方**比没有**的一方（通过约 10 次廉价的
grep 就能回答这个具名拦截器问题）成本*更高*。OkHttp 是基准测试中的成本异常值
（-3%，即*比*原生搜索更贵）。

修复：当一个文件**同时满足（a）脱离合成流程脊线，且（b）是多态兄弟**时，将其渲染为
**骨架**（类 + 成员*签名*，省略体），同时保留脊线上的典型案例和机制的完整内容。

- **OkHttp：** 拦截器链流程对 5 个冗余的 `: Interceptor` 实现进行骨架化，同时保持
  `RealInterceptorChain`（调度机制）和 `RealCall`（编排者，智能体命名）完整 →
  **比原生搜索约便宜 10%，0 次 RealCall 读回**（精化后的修正数字；原始的
  "28.5k → 16.6k" / "读取 1 vs 3" 数字来自确定性探针查询，非智能体的真实查询）。
- **Django：** QuerySet→SQL 流程对 `compiler.py`（基类+子类家族文件）进行骨架化，
  释放预算 → **约便宜 10%**。（早期声称 Django "字节完全相同 / 0 个骨架" 是*探针*
  查询的假象；智能体的真实查询确实会暴露 SQLCompiler 家族。）
- **Excalidraw / Tokio / VS Code / Gin：** 探索输出与标志开关完全**字节相同**
  （0 个骨架）——其流程没有脱离脊线的 ≥3 实现兄弟组。精化后的门控仅*增加*了豁免
  条件，因此骨架化范围是原始门控的**严格子集** → 这些代码库可证明保持 0 个骨架
  （探针已验证）。

---

## 用一张图说明问题

`handleExplore` 收集相关文件，按相关性排序，并填充到 `maxOutputChars`（"整小文件规则"
将任何 ≤220 行的相关文件完整输出）。预算是一个**目标**，而非上限：

```text
OkHttp explore（已发布）：RealCall（完整）+ RealInterceptorChain（完整）
                         + CallServerInterceptor（完整，8.7k）
                         + Bridge/Connect/Cache/…（完整，各约 4-5k）  ← 形状几乎相同
                         = 约 28k，大部分是冗余的拦截器体
```

智能体只需要**机制**（`RealInterceptorChain.proceed` 迭代链）+**每个拦截器实现的
契约** + 也许一个具体示例。其余五个完整体是填充——但仅仅是*因为它们可以互换*。
对于扩散型问题（Excalidraw 的渲染管道：`mutateElement → … → renderStaticScene`），
脱离脊线的文件是**各自独立的步骤**，其体做了真正的工作——省略它们只会让智能体从
签名重建（更多推理，净成本更高；见"死路"章节）。

所以整个问题在于：**廉价地区分"可互换兄弟"与"独立步骤"。**

## 门控条件（精化后）

当满足**所有**以下条件时，文件被骨架化（且 `SYNAPSE_ADAPTIVE_EXPLORE != 0`）：

1. **脊线存在。** `buildFlowFromNamedSymbols` 返回其路径节点集（`pathNodeIds`）和智能体
   命名的全部可调用符号集（`namedNodeIds`）。若没有脊线形成，则不进行骨架化。

2. **脱离流程脊线。** 文件中没有符号位于被追踪的链上——该链是智能体正在遍历的机制，
   始终保持完整。

3. **多态兄弟。** 文件的类 `implements`/`extends` 一个有 **≥3 个实现者**
  （`MIN_SIBLINGS`）的超类型——这是它是众多*可互换*实现之一的信号。来自真实的
  `implements`/`extends` 边，已缓存。

4. **未被豁免。** 当且仅当智能体**命名了文件中的一个可调用符号**时，文件被**豁免**
   （保持完整）——命名的方法/函数是智能体要*查看*的内容（`getResponseWithInterceptorChain`、
   `SQLCompiler.execute_sql`），而非可互换叶节点——**除非文件本身定义了一个 ≥3 实现的
   超类型**。最后这个条款是覆盖：基类+子类的"家族"文件（Django 的 `compiler.py`）体积
   庞大且无论如何会被读取，因此一份完整副本只会吃掉探索预算；骨架化它能*释放*该预算
   给智能体本应逐一读取的兄弟文件。即：*命名 ⇒ 豁免，除非是家族文件 ⇒ 无论如何都
   骨架化。*

在两个代码库中验证：

- **`RealInterceptorChain`** —— `proceed` 在脊线上 → 保持完整（条件 2）。
- **`RealCall`** —— 脱离脊线，且通过 **9 实现的 `Lockable` mixin**（而非作为可互换拦截
  器）触发兄弟信号。但智能体在其中命名了 `getResponseWithInterceptorChain`/`execute`/
  `enqueue`，且它未定义 ≥3 实现的超类型 → **豁免，保持完整**（条件 4）。这是读回问题
  的修复：条件 4 之前它被骨架化，智能体因此读回它。
- **`BridgeInterceptor` 及其他 4 个** —— 脱离脊线，≥3 实现的兄弟，仅按*类型*命名，未定
  义超类型 → **骨架化**。这是赢在之处。
- **Django `compiler.py`** —— 脱离脊线，是一个兄弟（其子类扩展了 `SQLCompiler`），智能体
  在其中命名了 `execute_sql`——*但它定义了 `SQLCompiler` 超类型*，因此覆盖触发 →
  **骨架化**（释放预算）。改为豁免它（错误的第一次尝试）会让成本更高、读取更多。

## 为什么"有 ≥3 实现者的共享超类型"是信号

让 OkHttp 的拦截器可以互换，正是因为它们是**一个接口的 N 个实现**，以多态方式被调用。
这是图以 `implements`/`extends` 边记录的*结构性*属性：

```text
14 个类 ──implements──▶ Interceptor      （BridgeInterceptor、CacheInterceptor、
                                           CallServerInterceptor、……）
```

Excalidraw 的 `renderStaticScene`、`Scene`、`Collab` **没有**共同超类型——对它们的
≥3 实现者查询不返回任何结果。因此该信号能清楚地区分这两个代码库，且（下文验证）
对所有非兄弟流程不产生影响。

`≥3` 阈值很重要：1:1 的"服务接口→单一实现"对（Spring/Java 中的常见形态）**不是**
兄弟节点，保持完整。只有真正的多实现家族（拦截器链、策略/访问者家族、编解码器
注册表）才触发门控。

## 骨架渲染

对于被骨架化的文件，我们输出类和成员的**签名行**（而非体）。由于符号节点的
`startLine` 可能指向装饰器/注解（`@Throws`、`@Override`、`@objc`），我们向前扫描最多
4 行以找到实际*命名*符号的行，以便骨架显示真实的签名：

```text
#### …/CallServerInterceptor.kt — CallServerInterceptor, intercept, … · 骨架（仅签名；读取完整体请使用 Read）

    30  object CallServerInterceptor : Interceptor {
    32  override fun intercept(chain: Interceptor.Chain): Response {
    194 private fun shouldIgnoreAndWaitForRealResponse(code: Int): Boolean =
```

标头仍列出文件的符号并标注 `Read for a full body`，因此智能体在真正需要时可以拉取
某个具体实现。

## 验证（精化后的门控）

无头 `claude -p`，Opus 4.8，**有 vs 无** synapse（真实基准测试臂，而非第一版使用的
开/关探针）。成本 = 中位数 `total_cost_usd`。

| 代码库 | 有→无成本 | 有侧读取次数 | 无侧读取次数 | RealCall/compiler 读回 |
| --- | --- | --- | --- | --- |
| **OkHttp** (n=4) | **$0.45 → $0.50**（约便宜 10%） | 2 | 3.5 | **0 / —**（RealCall 完整） |
| **Django** (n=6) | **$0.56 → $0.63**（约便宜 10%） | 2 | 8.5 | 一半运行读取 0 次 |

两者都是 README 的**成本异常值**（OkHttp 贵 3%，Django 贵 10%），现在都翻转为明显
的胜利。OkHttp 有侧在全部 4 次运行中更便宜；Django 在 6 次中有 5 次（n=6 以应对其高
方差）。无侧基线与 README 一致（$0.50/$0.63 vs $0.57/$0.64），因此收益来自有侧的
改善。

**关键检查现在以正确的原因通过**：有了命名可调用符号豁免，OkHttp 的 `RealCall` 保持完
整，且**从不**被读回（修复前在 4 次中有 3 次被读回）。惰性代码库（Excalidraw / Tokio
/ VS Code / Gin）保持 **0 个骨架**——探针已验证——因为精化后的门控对原始门控是严格子集。
（第一版"开 vs 关，读取次数持平 1 vs 3"的说法来自确定性探针查询，对智能体的真实查询
并**不**成立——这种不一致正是本次精化修正的内容。）

## 死路（不要再次尝试）

1. **降权/排序低价值文件**（例如扩大 `isLowValuePath` 以丢弃 `*-testing-support/` 固
   件）。改善*内容质量*但**不改善大小**——explore 会用其他完整体填补释放的预算
   （28,478 → 28,424）。排序 ≠ 缩减；必须*骨架化*才能缩减。
2. **以入口节点成员资格为门控。** 精确的符号包探索查询*命名*了每个链参与者，因此
   它们都是"入口节点"——无法区分，无内容被骨架化。
3. **依赖接口实现合成边**（`synthesizedBy:'interface-impl'`）作为兄弟信号。OkHttp 的
   `Interceptor`（Kotlin `fun interface`）**未**创建这些边，因此信号必须来自真实的
   `implements`/`extends` 边，而非合成边。
4. **普通的"核心下限"门控**（保持前 N 个完整，其余骨架化）——骨架化了 Excalidraw 的
   *独立*步骤 → **成本回归 +17%**。兄弟条件是使其安全的原因。
5. **因文件定义了超类型而豁免它**（第一次精化尝试）。这是反的：基类+子类的*家族*文件
   （Django 的 `compiler.py`，2,266 行）体积庞大且无论如何会被读取，因此保持完整只会
   **吃掉 28KB 探索预算并使智能体逐一读取兄弟文件**——使 Django 回归到**成本增加 9%**
   （$0.71）。定义超类型改为是一个**覆盖**，让已命名的家族文件无论如何都骨架化。
6. **仅用确定性探针查询验证骨架化。** 探针（`probe-explore.mjs "<符号包>"`）和*智能体*
   的真实探索查询命名符号的方式不同，因此形成不同的脊线，骨架化不同的文件。探针
   显示"Django：0 个骨架 / 读取次数持平"；真实智能体查询对 `compiler.py` 进行了骨架
   化并读回了它。**始终用真实智能体 A/B（`run-all.sh`）确认，而不仅仅是探针。**

## 代码

- `src/mcp/tools.ts`
  - `adaptiveExploreEnabled()` —— 标志（默认开启）。
  - `buildFlowFromNamedSymbols()` —— 返回 `{ text, pathNodeIds, namedNodeIds }`。
    `namedNodeIds` 是智能体命名的每个可调用符号（脊线的超集）——命名可调用符号豁免
    读取它。
  - `handleExplore()` —— 两个缓存辅助函数：`isPolymorphicSibling()`（一个节点有
    指向 ≥3 实现超类型的 `implements`/`extends` 出边）和
    `definesPolymorphicSupertype()`（一个节点有 ≥3 个 `implements`/`extends` 入边
    ——即文件是家族基类）。骨架分支：
    `off-spine && isPolymorphicSibling && !(namedInFile && !definesSupertype)`。
- `__tests__/adaptive-explore-sizing.test.ts` —— 7 个测试用例，含命名可调用符号豁免
  （RealCall）和超类型家族覆盖（compiler.py）。

## 前沿 / 未来工作

- **在家族文件内部按符号骨架化。** `compiler.py` 整体被骨架化，因此
  `SQLCompiler.execute_sql`（基类机制）也变成签名，在约一半的 Django 运行中被读回。
  理想情况是保持基类方法完整，只省略冗余子类体——在不省略答案的情况下缩减负载。
  整文件骨架化目前无法表达这一点。
- **大型非兄弟文件主导 Django 的残余读取。** `query.py`（3,040 行）和
  `sql/query.py` 不是多态家族，因此骨架化无法触及它们；当 28KB 聚类视图不足时，
  智能体会读取它们。这是探索预算 / 大文件聚类的前沿，而非骨架化的问题。
- **非接口兄弟家族**（Go 的 `HandlerFunc` 切片、函数指针注册表）未被捕获——它们
  没有 `implements`/`extends` 边。例如 Gin 的中间件链不触发门控（其处理器是函数，
  不是接口实现）。
- **当*没有*拦截器在脊线上时的典型案例选择：** 目前所有兄弟都被骨架化，智能体
  依赖接口契约；将一个作为强制典型案例展示可能效果略好（未经测试）。
