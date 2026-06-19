# 范围：模板标记解析器（Razor / Blazor / Thymeleaf）

状态：**P1+P2+@code 已实现**（提交 59b8de2 指令/标签，90c5f39 @code 委托），位于 `feat/cross-language-impact-coverage`。Razor/Blazor 标记已解析（`src/extraction/razor-extractor.ts`）。待完成：DTO 与实体名称冲突的 `@using` 命名空间消歧（ASP.NET 的残余缺口），以及 Thymeleaf/Django（P4，已推迟——代码链接薄弱）。撰写于 2026-06-04。

## 问题

影响图基于引擎解析的代码构建。**模板标记未被解析**，因此仅从标记中引用的代码后置文件、组件、视图模型或 DTO 看起来在仓库内没有依赖者。对于约定优于配置的框架，这是排除框架入口后最主要的残余缺口：

| 框架 | 应用 | FAIR 覆盖率（排除入口后） | 残余原因 |
| --- | --- | --- | --- |
| ASP.NET | eShopOnWeb | **77.2%**（115/149） | Razor `.cshtml` + Blazor `.razor` 引用了我们未解析的 `.cs` |
| Spring | petclinic | 65.2% | 主要是 Spring Data 代理 + JPA，**不是**模板（Thymeleaf 链接薄弱） |
| Django | django-realworld | 74.1% | 信号 / DRF / 字符串配置，**不是**模板 |

**此功能主要是 ASP.NET（Razor + Blazor）的收益。** Thymeleaf 和 Django 模板与代码的链接薄弱（模板→模板片段 + 模糊的模型属性字符串），这些框架的真正缺口在别处——因此在此明确将其列为较低优先级。

### 量化目标（eShopOnWeb，排除入口后的 34 个残余零覆盖）

- **~20 个可通过此功能覆盖的标记项：**
  - 5 个 MVC `ViewModels/*` ← Razor `@model X`
  - 7 个 `BlazorShared/Models/*`（DTO）← Blazor `@bind` / 组件参数
  - 6 个 `BlazorAdmin/*` C# 组件 ← Blazor `<Component/>` 标签
  - 1 个 `BasketComponent` ViewComponent ← `<vc:basket>` / `Component.InvokeAsync`
  - 1 个 Razor 页面 helper
- **~13 个无法覆盖**（独立前沿——反射/代理 + 值读取）：AutoMapper `MappingProfile`、Swagger `CustomSchemaFilters`/`ImageValidators`、`ExceptionMiddleware`、健康检查、`Constants`（静态成员读取）、`Buyer` 实体。

**诚实上限：ASP.NET ~77% → ~90%**，而非 95%。最后 ~10% 是反射/代理（AutoMapper、Swagger、DI/中间件注册）+ C# 静态常量读取——这是*独立*功能（反射建模 + 将静态成员遍历扩展到 C#）。

## 待提取的引用模式（按优先级排序）

| 优先级 | 格式 | 标记构造 | 要发出的边 | 解析目标 |
| --- | --- | --- | --- | --- |
| P1 | Razor `.cshtml`/`.razor` | `@model Foo` / `@inherits X<Foo>` | `references` | 模型/VM 类 `Foo` |
| P1 | Razor/Blazor | `@inject IBar bar` | `references` | 服务类型 `IBar` |
| P2 | Blazor `.razor` | `<MyComponent .../>` （PascalCase 元素） | `references` | 组件类（`.razor` 或 `.cs : ComponentBase`） |
| P2 | Blazor `.razor` | `@typeof(MainLayout)`，`@inherits LayoutBase` | `references` | 该类型 |
| P3 | Razor `.cshtml` | `<partial name="_X"/>`，`<vc:basket>`，`Component.InvokeAsync("X")` | `references` | 部分视图 / `XViewComponent` |
| P3 | Razor `.cshtml` | `asp-page="./Register"`，`asp-controller`/`asp-action` | `references` | 页面 / 控制器 action |
| P4（推迟） | Thymeleaf `.html` | `th:replace="~{frag :: x}"` | `references` | 模板片段（仅模板→模板） |
| P4（推迟） | Django `.html` | `{% extends %}` / `{% include %}` / `{% url 'n' %}` | `references` | 模板 / 具名路由 |

`asp-for="Prop"`、`th:field="*{prop}"`（属性字符串绑定）是数据流前沿——**超出范围**（需要模型类型推断；价值低，噪声高）。

## 架构——遵循现有独立提取器模式

引擎已有非 tree-sitter 提取器（`svelte-extractor.ts`、`vue-extractor.ts`、`liquid-extractor.ts`）：接受 `(filePath, source)`，返回 `{ nodes, references }` 的类，在两处接入。完全镜像该模式：

1. **`src/extraction/grammars.ts`** — 将扩展名映射为合成语言：`.cshtml`/`.razor` → `'razor'`，（后续）`templates/` 下的 `.html` → `'thymeleaf'`。（Django 的 `.html` 与普通 HTML 有歧义——通过 `templates/` 路径或 `{% %}`/`{{ }}` 内容嗅探来门控，与框架解析器的做法相同。）
2. **`src/extraction/tree-sitter.ts`** — 按扩展名分发给新的 `RazorExtractor`（以及 `ThymeleafExtractor`），完全类似 `SvelteExtractor` 的分发方式（约第 4025 行）。
3. **`src/extraction/razor-extractor.ts`**（新建）——正则/行扫描（标记高度规范化；不需要语法，与 Liquid/Svelte 模板扫描相同）：
   - 为文件发出**一个** `component` 节点（使 `.razor` 组件可作为 `<X/>` 目标链接，成为图的成员）。
   - 按上述 P1–P3 模式发出 `references`，`fromNodeId` = 文件/组件节点，`referenceKind: 'references'`，`language: 'razor'`。
   - **代码后置链接：** `Foo.razor` + `Foo.razor.cs`（分部类）——发出 `references`（或依赖同名规则），使标记的引用也归功于代码后置文件。（eShop 的 Blazor 组件是普通的 `.cs : ComponentBase`，命名为 `<ToastComponent/>`，通过类名解析；`.razor.cs` 分部类是另一种形态。）

**解析：不需要新的解析器。** 发出的 ref 是对类/组件的普通 `references`（按名称）；现有名称匹配器会解析它们（`@model RegisterModel` → 类 `RegisterModel`；`<ToastComponent/>` → 类 `ToastComponent`）。应用**与现有相同的跨语言家族门控**——`razor` ref 必须解析到 `csharp` 符号，因此将 `razor` 添加到 `web`/dotnet 家族，或将 `razor`↔`csharp` 视为同一家族（否则提交 082353e 的门控会丢弃所有边）。**这是解析器侧唯一需要的改动**，不做则所有边都被门控掉。

## 节点/边形态与不变式

- 每个模板文件 +1 个 `component` 节点（真实的新符号——类似 `.svelte`/`.vue`）。节点数仅增加模板文件数；**无标签爆炸**（组件标签成为 `references` 边，而非节点）。
- 所有边均为 `references`（被影响计算 / `affected` / `getFileDependents` 统计，而非 `callers`/`callees`——与现有 `route`/`component` 边的行为一致）。
- 重新索引幂等；多次运行节点数稳定。

## 分阶段

- **P1（价值/工作量比最高）：** `.cshtml` 和 `.razor` 的 Razor `@model` + `@inject`。覆盖 5 个 ViewModel + 注入的服务。+ 解析器家族门控修复。
- **P2：** Blazor `<PascalComponent/>` 标签 + `@typeof`/`@inherits` + 代码后置链接。覆盖 6 个 Blazor `.cs` 组件 + 7 个 DTO（通过组件参数/`@bind`）。
- **P3：** Razor `<partial>` / `<vc:>` / `Component.InvokeAsync` / `asp-page`。
- **P4（推迟/可能跳过）：** Thymeleaf + Django 模板——代码链接薄弱，覆盖率收益低；仅在 Thymeleaf/Django 应用成为优先级时才重新评估。

## 边界情况与风险

- **PascalCase 标签 vs HTML 元素：** 只有以 `[A-Z]` 开头的标签才是 Blazor 组件（HTML 是小写）——安全的判别符。通过内置集跳过已知框架组件（`<Router>`、`<Found>`、`<LayoutView>`、`<RouteView>`、`<CascadingValue>`），或直接让它们解析失败（不会产生错误边——它们不在仓库内）。
- **`_Imports.razor` 中的 `@using`：** 是命名空间导入，而非代码 ref——忽略（或向命名空间发出 `imports`，价值低）。
- **泛型组件 `<Grid TItem="CatalogItem">`：** 将类型参数捕获为对 `CatalogItem` 的 `references`（额外的 DTO 覆盖）。
- **命名冲突：** 组件/模型名称通常唯一；依赖名称匹配器的现有邻近度评分。另一种语言中的同名类被家族门控阻断。
- **Razor `@{ ... }` C# 块：** 包含真实 C#（调用、`new`）——P-future；对标记内的 C# 进行正则扫描噪声大。推迟（上述指令是收益所在）。
- **`.razor` 不是 `.cs`：** 必须添加到 `grammars.ts` + 索引器的包含 glob（验证 `.razor`/`.cshtml` 未被默认排除）。

## 验证（按引擎方法论）

1. 构建 `RazorExtractor`；在 `__tests__/extraction.test.ts` 中编写单元测试（带 `@model X` 的 `.cshtml` 覆盖 `X`；带 `<ToastComponent/>` 的 `.razor` 覆盖它；普通 HTML `<div>` **不**创建边）。
2. 在 eShopOnWeb 上重新测量修改前后的 FAIR 覆盖率（`/tmp/faircov.cjs`）：目标 77% → ~90%；**节点数稳定**（仅增加模板文件组件节点）；残余零覆盖仅为反射/值读取集合。
3. 在非 .NET 对照（gin/requests）和无 Razor 的 C# 仓库（cs-mediatr/cs-polly 不变）上无回退。
4. 记录在本文档 + 覆盖率交接文档中。

## 工作量

- P1：~0.5 天（提取器骨架 + `@model`/`@inject` 扫描 + 家族门控修复 + 测试）。
- P2：~1 天（Blazor 标签 + 代码后置 + 泛型类型参数）。
- P3：~0.5 天。P4（Thymeleaf/Django）：~1–2 天，ROI 低——推迟。
- **ASP.NET 收益合计（P1+P2+P3）：~2 天 → ASP.NET ~90%。**

## 非目标（以及 95% 覆盖率还需要什么）

此功能**不**闭合：反射/代理注册（Spring Data 仓库代理、AutoMapper 配置、Swagger 过滤器、DI 容器/中间件）、属性字符串数据绑定（`asp-for`/`th:field`）或 C# 静态常量值读取（`Constants.X`）。约定应用达到字面意义上的 95% 还需要**反射/DI 注册建模**遍历和**将静态成员遍历扩展到 C#/TS**——单独跟踪。标记解析是最大的、最独立的单步骤改进。
