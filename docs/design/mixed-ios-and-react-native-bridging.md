# 混合 iOS + React Native 桥接——覆盖设计

**受众：** 继续推进 #165 落地纯 Objective-C 支持之后工作的 Claude 智能体（或人类工程师）。
**目标：** 让 synapse 的 `trace` / `callers` / `callees` / `impact` / 流程上下文调用，能够跨越当前静默断裂流程的**跨语言运行时分发边界**端到端连接：混合 iOS 代码库中的 **Swift ↔ Objective-C**，以及 React Native / Expo 应用中的 **JavaScript ↔ native**。

> 本文档是**设计方案**，而非实现。此分支不包含任何代码落地——仅有设计、验证语料库和成功标准。编码工作在各阶段的后续分支上展开。

本工作是[动态分发覆盖 playbook](./dynamic-dispatch-coverage-playbook.md) §6 矩阵中的下一项：行"Swift × Objective-C 桥接"和新增的"React Native 桥接"行。两者均为**解析器**模式（两侧均存在命名引用——桥接规则是确定性的），而非合成器模式。参见 playbook §3a 中的参考 Django ORM 解析器。

---

## 1. 问题所在（当前缺口）

#165 之后，synapse 能够各自正确地索引 Swift、Objective-C 和 JavaScript/TypeScript。但价值在于跨语言流程——而 iOS 应用和 React Native 应用恰恰生活在这里：

- **混合 iOS 应用：** `MyViewController.swift` 调用 `imageDownloader.download(url:completion:)`，对应 `ImageDownloader.m` 中的 `-[ImageDownloader downloadURL:completion:]`。当前状态：`trace("MyViewController.viewDidLoad", "downloadURL:completion:")` 返回空路径。Swift 调用点被解析为一个 `call_expression`，其选择器指向虚空；ObjC 方法节点存在，但没有入边。智能体需要读取两个文件来重建桥接关系。
- **React Native 应用：** `App.js` 中的 `useEffect(() => NativeModules.Geolocation.getCurrentPosition(cb))` 到达 `RNCGeolocation.m` 中的 `RCT_EXPORT_METHOD(getCurrentPosition:(RCTResponseSenderBlock)cb)`。当前状态：JS 调用点没有指向 ObjC 实现的出边；ObjC 处理器没有来自 JS 的入边。`impact(getCurrentPosition)`（ObjC 侧）显示没有 JS 调用者。
- **Expo 模块：** `await ExpoCamera.takePictureAsync(options)`（JS）到达 `ExpoCamera.swift`（Expo Modules API）中的 `AsyncFunction("takePictureAsync") { ... }`。同样的断裂。

在每种情况下，**两侧都存在名称**，智能体或名称匹配器都可以关联——Swift 自动桥接的 ObjC 选择器、`RCT_EXPORT_METHOD` 的字面第一个参数、Expo 的 `Function("name")` 字面值。修复方案是一个**解析器**，它了解每个通道的桥接规则，并发出带有 `provenance:'heuristic'` 和 `metadata.synthesizedBy:'<channel>'` 的 `references` 边。

playbook 的核心警告在这里比往常更为适用：

> **部分覆盖比没有覆盖更糟。** 桥接了一个边界却没有桥接下一个，反而暴露了智能体需要深入读取才能完成的跳转。务必端到端地闭合流程并重新测量——绝不发布半桥接的流程。

对于混合 iOS，这意味着**两个方向**（Swift→ObjC 和 ObjC→Swift）以及**所有桥接类型**（方法、属性、init/initializer、协议）都必须在测量前闭合。对于 React Native，JS→native 和 native→JS（`RCTEventEmitter`、`sendEvent`）都必须闭合，且同时覆盖**传统桥接和 TurboModules**，否则混用两者的应用会出现半桥接。

---

## 2. 需要建模的桥接机制

每行是 playbook 词汇中独立的**分发通道**——每个通道有自己的解析器（如果不存在静态引用则用合成器）、自己的验证和 §6 矩阵中自己的行。

| # | 方向 | 通道 | 映射规则 | 位置 | 难度 |
|---|---|---|---|---|---|
| 1 | Swift → ObjC | 直接调用，通过 `-Bridging-Header.h` 导入的 ObjC 类 | Swift 调用 `obj.x(y:z:)` ↔ ObjC 选择器 `-x:z:`（字面映射，见 §3a） | `frameworks/swift-objc.ts` 中的解析器 | 中 |
| 2 | ObjC → Swift | `@objc` 暴露 | Swift `@objc func foo(bar:)` ↔ ObjC `-fooWithBar:`（自动命名）；`@objc(custom:)` 可覆盖 | `frameworks/swift-objc.ts` 中的解析器 | 中 |
| 3 | Swift ↔ ObjC | 属性/getter/setter 桥接 | Swift `var name: String` ↔ ObjC `-name` / `-setName:` | `frameworks/swift-objc.ts` 中的解析器 | 低 |
| 4 | Swift ↔ ObjC | 初始化器桥接 | Swift `init(name:age:)` ↔ ObjC `-initWithName:age:` | `frameworks/swift-objc.ts` 中的解析器 | 低 |
| 5 | Swift ↔ ObjC | 协议桥接（`@objc protocol`） | 跨语言的遵从边 | `frameworks/swift-objc.ts` 中的解析器 | 中 |
| 6 | JS → ObjC（RN 传统桥接） | `NativeModules.<Mod>.<fn>` ↔ `RCT_EXPORT_METHOD(<fn>:...)` 或 `RCT_REMAP_METHOD(<jsName>, <selector>:...)` | 以 ObjC 侧的 `RCT_EXPORT_MODULE()` 字面量为键进行名称匹配 | `frameworks/react-native.ts` 中的解析器 | 中 |
| 7 | JS → Java/Kotlin（RN 传统桥接，Android） | `NativeModules.<Mod>.<fn>` ↔ `@ReactMethod` 注解的方法（位于 `getName()` 返回 `<Mod>` 的 `ReactContextBaseJavaModule` 子类） | 解析器——形状与 #6 相同，JVM 侧 | 中 |
| 8 | JS ↔ native（RN TurboModules / Codegen） | `TurboModuleRegistry.get('Mod')` ↔ 生成的 spec 接口（`NativeMod` TS 类型）↔ 匹配 spec 的 ObjC++/Kotlin 实现 | 以 spec 文件为 ground truth 的解析器 | 难 |
| 9 | Native → JS（事件） | ObjC `[self sendEventWithName:@"x" body:b]`（继承 `RCTEventEmitter`）↔ JS `new NativeEventEmitter(NativeModules.Mod).addListener('x', cb)` | EventEmitter 风格合成器（与已有的 `callback-synthesizer.ts` 处理同语言 EventEmitter 一致） | 中 |
| 10 | JS → native（Expo 模块） | JS `ExpoX.fn(args)` ↔ Swift 中含 `Name("ExpoX")` 的 `Module` 子类内的 `Function("fn") { ... }` 或 `AsyncFunction("fn") { ... }` | `frameworks/expo-modules.ts` 中的解析器 | 中 |
| 11 | JS → native（Fabric 视图组件） | JS `<MyView prop={v}/>` ↔ ObjC/Swift `RCT_EXPORT_VIEW_PROPERTY(prop, ...)` 或 Codegen 视图 spec | 解析器 + JSX 跳转（与已有 JSX 合成器组合） | 难（延后） |

**难度**列决定阶段顺序——见 §6。

### 2a. 为何是解析器而非合成器

在每一行中，**桥接规则都可以从名称确定性地推导**：
- Swift 的 `@objc` 暴露有文档记载的自动映射规则；`@objc(custom:)` 是显式覆盖；两者均可在静态提取时获取。
- `RCT_EXPORT_METHOD` 接受字面选择器；`RCT_EXPORT_MODULE()` 接受可选的字面模块名（默认：去掉 `RCT` 前缀的类名）；`NativeModules.Mod.fn` 是已知全局变量上的字面属性访问。
- Expo Modules 的 `Function("name") { ... }` 和 `Module { Name("ExpoX"); ... }` 是 `Module` 定义内的字面字符串。
- TurboModules spec 接口是字面 `Native<Name>` 导出，配合 `TurboModuleRegistry.get<...>('<Name>')`。

因此工作是：**提取桥接侧名称 → 让解析器匹配它们**。形状与 `djangoResolver` 将 `_iterable_class` 解析到 `ModelIterable` 相同——无需全图关联传递。

唯一的例外是 **#9 native→JS 事件**，其注册站点的形态与已有 callback 合成器处理的同语言 EventEmitter 模式非常相似。将该合成器扩展为跨语言通道是最自然的方案。

---

## 3. 具体桥接规则（参考表）

### 3a. Swift → ObjC 选择器映射（自动）

Swift 使用标准规则从 Swift 方法推导出 ObjC 选择器：

| Swift 声明 | ObjC 选择器 |
|---|---|
| `func greet()` | `greet` |
| `func say(_ msg: String)` | `say:` |
| `func set(name: String)` | `setWithName:` |
| `func setName(_ name: String)` | `setName:` |
| `func move(to point: CGPoint)` | `moveTo:` |
| `func move(from a: CGPoint, to b: CGPoint)` | `moveFrom:to:` |
| `init(name: String)` | `initWithName:` |
| `init(name: String, age: Int)` | `initWithName:age:` |
| `var name: String`（getter） | `name` |
| `var name: String`（setter） | `setName:` |
| `@objc(customSel:) func f(...)` | `customSel:`（显式覆盖） |

完整规则集见
[Apple — 将 Swift 导入 Objective-C](https://developer.apple.com/documentation/swift/importing-swift-into-objective-c)
——具体是"方法名称翻译"和"初始化器名称翻译"章节。解析器在**提取时单向实现**此映射（Swift 声明生成桥接的 ObjC 名称，作为 Swift 方法节点上的别名存储），因此 ObjC 侧的名称解析通过普通名称匹配找到 Swift 方法。

### 3b. React Native 传统桥接——名称解析

```objc
// Native 侧（ObjC）
@implementation RCTGeolocation
RCT_EXPORT_MODULE();                                    // 模块名："Geolocation"（去掉 RCT 前缀）
RCT_EXPORT_METHOD(getCurrentPosition:(RCTResponseSenderBlock)cb) { ... }
@end
```
```js
// JS 侧
import { NativeModules } from 'react-native';
NativeModules.Geolocation.getCurrentPosition(cb);       // 解析到上方的 ObjC 方法
```

规则：
1. 在 native 侧，为每个含有 `RCT_EXPORT_MODULE()` 的类提取一个合成 `module` 节点。名称 = 存在显式字符串参数时用该参数，否则去掉类名的 `RCT` 前缀。
2. 每个 `RCT_EXPORT_METHOD(<sel>)` 和 `RCT_REMAP_METHOD(<jsName>, <sel>)` 成为附属于该模块节点的方法节点，带有 JS 可见名称（`RCT_EXPORT_METHOD` 用 `<sel>` 的第一个关键字，`RCT_REMAP_METHOD` 用 `<jsName>`）。
3. 在 JS 侧，解析器将字面属性链 `NativeModules.<Mod>.<fn>` 与 native 侧的 `(module, jsName)` 对进行匹配。
4. 解析器从 JS 调用点到 native 方法发出 `references` 边（`provenance:'heuristic'`，`synthesizedBy:'rn-bridge'`）。

### 3c. React Native TurboModule——名称解析

```ts
// Spec（TS）——codegen ground truth
export interface Spec extends TurboModule {
  getCurrentPosition(cb: (loc: Location) => void): void;
}
export default TurboModuleRegistry.getEnforcing<Spec>('Geolocation');
```
```objc
// ObjC++ 实现
@implementation RCTGeolocation
- (void)getCurrentPosition:(RCTResponseSenderBlock)cb { ... }
@end
```
```js
import Geolocation from './NativeGeolocation';
Geolocation.getCurrentPosition(cb);  // 通过 spec 解析到 ObjC 方法
```

规则：
1. spec 文件是 source of truth：解析 `TurboModuleRegistry.get*<Spec>('<Name>')` 以找到模块名，然后读取 `Spec` 接口方法。
2. 将每个 spec 方法与 native 实现中同名方法（按选择器首个关键字，在按命名约定或读取 `JSI_EXPORT_MODULE` 宏确定的类中）进行匹配。
3. spec 文件的 JS 导入通过 spec 进行名称解析。
4. 发出与 #3b 相同的 `references` 边，带有 `synthesizedBy:'rn-turbomodule'`。

### 3d. Expo Modules——名称解析

```swift
// Native（Swift，expo-modules-core API）
public class ExpoCameraModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoCamera")
    AsyncFunction("takePictureAsync") { (options: CameraOptions) in /* ... */ }
    View(ExpoCameraView.self) {
      Prop("type") { (view: ExpoCameraView, type: String) in /* ... */ }
    }
  }
}
```
```js
import { requireNativeModule } from 'expo-modules-core';
const ExpoCamera = requireNativeModule('ExpoCamera');
await ExpoCamera.takePictureAsync({ quality: 1 });
```

规则：
1. 在 native 侧：继承 `Module`（或新版 API 中在 `init { /* DSL */ }` 内）的类，其 `definition()` 中含有 `Name("X")` 调用，定义了该模块。每个 `Function("y")` / `AsyncFunction("y")` 字面量定义一个方法。尾随闭包是实现体——提取为名称为 `y` 的方法节点，附属于模块 `X`。
2. 在 JS 侧：`requireNativeModule('X')` 产生一个绑定；解析其上的属性访问到对应的命名方法。
3. 视图模块的 `Prop("name")` 行为类似于 RN 的 `RCT_EXPORT_VIEW_PROPERTY`——与视图组件前沿的其他内容一同延后处理。

---

## 4. 需要存在的边

对于每个通道，闭合的流程是：

- **JS 调用点 → 桥接方法节点**（`references`，heuristic，`synthesizedBy:'<channel>'`）
- **桥接方法节点 → native 实现方法**（已在提取时获得；对于 #6/#7，桥接方法即 native 实现；对于 #10，闭包体即实现）
- **Native 实现方法 → 其被调用者**（已在同语言内提取）

对于 Swift↔ObjC，最简洁的模型是**在声明节点上存储别名**：扩展 Swift 方法提取，计算 ObjC 自动桥接名称并将其存储为解析器考虑的备用名称。Swift 和 ObjC 方法节点之间无需新建边——正常名称解析即可，因为提取后两侧都认可桥接选择器。

MCP 读取工具已内联展示 heuristic 边（见 #312/#403 的 `metadata.synthesizedBy` 管道）；这些新边直接走该路径，无需额外管道。

---

## 5. 验证语料库（小型/中型/大型标准）

遵循 CLAUDE.md 的验证方法论——**每种小/中/大代码库各 ≥3 个流程提示，包含确定性探针 + 智能体 A/B，每组 ≥2 次运行**。以下候选项在实现分支中确认；实现 PR 在验证每个代码库仍能干净构建索引后最终确定选择。

### 5a. 混合 iOS（Swift+ObjC）——选 3 个

| 层级 | 代码库 | 原因 | 典型流程 |
|---|---|---|---|
| **小型** | [Charts](https://github.com/danielgindi/Charts)（~150 个 Swift+ObjC 文件） | 带有 ObjC 兼容层的 Swift 优先库；知名 | "在 `ChartView` 上设置 `data` 如何到达渲染器？" |
| **小型（备选）** | [Lottie-ios](https://github.com/airbnb/lottie-ios)（~300 个文件，曾是混合；当前可能是纯 Swift——需验证） | 动画引擎，知名混合库 | "`AnimationView.play()` 如何到达图层合成器？" |
| **中型** | [Realm-Cocoa](https://github.com/realm/realm-swift)（~500 个文件） | 大量 Swift-on-top-of-ObjC：Swift API 封装 ObjC 核心，ObjC 核心再封装 C++ Realm Core | "`Realm.write { realm.add(obj) }` 如何到达 ObjC 持久化层？" |
| **大型** | [Wikipedia-iOS](https://github.com/wikimedia/wikipedia-ios)（~2500 个 Swift+ObjC 文件） | 真实应用，深度混合，活跃开发 | "点击搜索结果如何到达文章获取网络调用？" |
| **大型（备选）** | [WordPress-iOS](https://github.com/wordpress-mobile/WordPress-iOS) | 更多 ObjC 遗留 + Swift 新增 | "新建帖子草稿保存如何到达 Core Data 持久化？" |

每个代码库的通过标准：
1. 纯语言探针仍通过（Swift 内 Swift trace；ObjC 内 ObjC trace）——相对 #165 纯 ObjC 基线无回退。
2. **跨语言探针通过：** 上述典型流程通过 `trace` 端到端连通，语言边界处无断裂。
3. **智能体 A/B（有无 synapse 对比，每组 ≥2 次运行）：** 在 explore 调用预算内 Read = 0；比无 synapse 更快；在对照代码库（如 Texture）上无回退。
4. **无节点数爆炸**（vs 加桥接前的基线，`select count(*) from nodes` 前后保持稳定）。

### 5b. React Native——选 3 个

| 层级 | 代码库 | 原因 | 典型流程 |
|---|---|---|---|
| **小型** | [react-native-svg](https://github.com/software-mansion/react-native-svg)（~100 个 JS+ObjC+Java 文件） | 小型、边界清晰的 native 模块集 | "设置 `<Path d=.../>` 如何到达 iOS Core Graphics 调用？" |
| **中型** | [react-native-screens](https://github.com/software-mansion/react-native-screens)（~300 个文件，JS+native） | 真实导航原语，同时支持传统桥接和 Fabric | "导航到新屏幕如何到达 UINavigationController？" |
| **中型（备选）** | [react-native-firebase](https://github.com/invertase/react-native-firebase)（跨包 ~1000 个文件） | 多个 native 模块，双平台——压力测试模块发现 | "`firestore().collection('x').get()` 如何到达 iOS Firebase SDK 调用？" |
| **大型** | [facebook/react-native](https://github.com/facebook/react-native) RNTester 子集（~3000 个文件） | 框架本身 + 示例应用；典型桥接使用 | "在 RNTester 的 GeolocationExample 中按下按钮如何到达 iOS Core Location 调用？" |

每个代码库的通过标准：
1. 纯 JS 探针不变（`useState` → 重渲染流程仍可解析——已有 react 合成器无回退）。
2. **JS → ObjC 桥接探针通过**，每个代码库至少 1 个已知 `RCT_EXPORT_METHOD`。
3. **JS → TurboModule 探针通过**，针对使用 TurboModules 的代码库（react-native main 两者皆有；各选一）。
4. **Native → JS 事件探针通过**，至少 1 个 emitter（NativeEventEmitter 模式）。
5. **智能体 A/B** 如上。关键：一个**跨越桥接**的问题（如"按下按钮 X 如何到达网络调用"）在使用 synapse 的 ≥1 次运行中 Read 必须降至 0。
6. **在纯 JS 对照代码库上无回退**（已有 react-realworld / excalidraw 数据不变）。

### 5c. Expo——选 2 个（范围较小，API 面较窄）

| 层级 | 代码库 | 原因 |
|---|---|---|
| **小/中型** | [expo/expo](https://github.com/expo/expo)——某个 SDK 模块，如 `expo-camera` 或 `expo-location` | 最干净的 Expo Modules API 示例；持续维护 |
| **大型** | 完整 `expo/expo` monorepo（所有 SDK 模块 + JS API） | 压力测试跨多个包的模块名解析 |

典型流程："`await Camera.takePictureAsync()`（JS）如何到达 native 相机 API 调用（Swift `AVCaptureSession` 或 Kotlin `CameraDevice`）？"

---

## 6. 阶段规划——先做什么

根据 playbook 的难度梯度和半桥接规则，顺序由**最小代码库上哪个能端到端闭合流程**决定。

### 阶段 1——Swift ↔ ObjC 桥接（上方第 1–5 行）
范围最小，确定性名称映射，不涉及 JS。在 Charts/Realm/Wikipedia 语料库上验证后再继续。**阶段 1 在 §5a 的全部三个代码库上通过后，才推进到阶段 2。**

### 阶段 2——React Native 传统桥接（第 6–7 行，ObjC + Java/Kotlin）
iOS 和 Android 两侧必须在同一 PR 中闭合——半桥接一个平台会在另一平台暴露半覆盖跳转，促使智能体读取文件。在 §5b 语料库上验证。

### 阶段 3——Native → JS 事件（第 9 行）
扩展已有 callback 合成器，增加跨语言通道。在同一 §5b 语料库上验证（大多数 RN 库至少使用一个事件 emitter）。

### 阶段 4——Expo Modules（第 10 行）
基于阶段 1 的 Swift 提取进行叠加。使用更小的 §5c 语料库。

### 阶段 5——RN TurboModules / Codegen（第 8 行）
需要以 spec 文件作为跨语言 ground truth 进行读取。在 §5b 语料库的 TurboModules 使用者上验证（react-native main，0.73 以后的库）。

### 阶段 6——Fabric 视图组件（第 11 行）
延后——与已有 JSX 合成器和 TurboModules 的视图侧组合。待 §5b 语料库中 ≥1 个代码库的桥接已闭合但 Fabric 流程仍断裂时处理。

---

## 7. 非目标（不会尝试做的事）

- **Android Kotlin/Java 提取质量**——超出范围。使用 Kotlin/Java 提取器已有的产出。如果它们遗漏了 `@ReactMethod` 注解的字面名称，可能会添加微小的提取器改进，但不重新设计 JVM 提取。
- **动态/计算型桥接键**——`NativeModules[someVar]`、`requireNativeModule(name)` 中 `name` 是参数等。仅解析字面键访问（与[智能体评估 Lua 前沿](./dynamic-dispatch-coverage-playbook.md)一致——仅匿名模式延后处理）。
- **Bridging-header 文件内容解析**——我们*确实*索引 `.h` 文件（#165 的内容嗅探已实现），但**不**将 bridging header 的 `#import` 列表解析为"Swift 可见内容"的特殊清单。将其视为普通 ObjC 头文件。
- **`performSelector:` 上的运行时分发**——超出范围；与"仅命名"反目标一致。
- **JSI（裸，非 TurboModule）**——超出范围。使用裸 JSI 的应用通过自定义 `Host*` 接口调用 native，没有文档化的声明式 spec。等待这些应用迁移到 TurboModules。
- **ObjC 协议上的 Swift 泛型 / ObjC 类上的 Swift 扩展**——如果扩展方法带 `@objc` 则仍然可在 ObjC 中调用，走阶段 1 的相同路径。泛型不行——我们静默地遗漏它们。可接受；与 Java/Kotlin 泛型前沿一致。

---

## 8. 覆盖矩阵条目——已测量

| 语言 | 框架 | 典型流程 | 机制 | 状态 |
|---|---|---|---|---|
| Swift × Objective-C | 桥接 | Swift 调用 → ObjC 选择器；ObjC 调用 → @objc Swift 方法 | R | ✅ 阶段 1（§8a） |
| JavaScript × Objective-C/Java/Kotlin | React Native 传统桥接 | `NativeModules.<M>.<f>` → `RCT_EXPORT_METHOD` / `@ReactMethod` | R | ✅ 阶段 2（§8b） |
| JavaScript × native | React Native TurboModules | spec 接口 ↔ 实现 | R（以 spec 为 ground truth） | ✅ 部分——名称匹配路径落地（§8b） |
| Objective-C/Java/Kotlin → JavaScript | React Native 事件 emitter | `[self sendEventWithName:]` → `addListener` | S（跨语言通道） | ✅ 阶段 3（§8e） |
| JavaScript × Swift/Kotlin | Expo Modules | `requireNativeModule('X').fn(...)` → `Function("fn") { }` | R（提取时合成方法节点） | ✅ 阶段 4（§8f） |
| JavaScript × native | React Native Fabric 视图 | `<MyView p=v/>` → Codegen spec 组件 + NativeProps | R（提取）+ S（native 实现）+ JSX | ✅ 阶段 6（§8g） |

### 8a. 阶段 1 测量——Swift ↔ ObjC

| 代码库 | 源文件数 | 桥接边（框架解析） | 示例边 |
|---|---|---|---|
| **Charts**（小型） | 269（205 Swift + 59 ObjC/.h） | 28 objc→swift，1 swift→objc | `handleOption:forChartView:` → `animate` · `setupPieChartView:` → `setExtraOffsets` · `setDataCount:range:` → `setColor` |
| **realm-swift**（中型） | 369（151 Swift + 218 ObjC 家族） | 36 objc→swift，1185 swift→objc | `valueForUndefinedKey:` → `get` · `setValue:forUndefinedKey:` → `set` · `promote:on:` → `initialize` |
| **wikipedia-ios**（大型） | 1734（1234 Swift + 500 ObjC/.h） | 52 objc→swift，983 swift→objc | 真实 iOS 应用跨多个功能模块的桥接 |

三个代码库均通过：同语言基线不变，无节点数爆炸，`trace` 跨边界连通典型流程（在 Charts 上验证：`trace(handleOption:forChartView:, animate)` 直接呈现桥接边）。

### 8b. 阶段 2 + 5（部分）测量——React Native 桥接

| 代码库 | 源文件数 | 桥接边（框架解析） | 备注 |
|---|---|---|---|
| **react-native-svg**（小/中型） | ~700（93 .mm + 115 .java + 6 .kt + 49 js + 92 ts + 154 tsx） | 9 条 tsx→java via TurboModule spec | RNSvg 的 iOS 使用 TurboModule 自动生成（无 `RCT_EXPORT_METHOD`）；解析结果落在 Java 侧。全部 9 条精确：`isPointInStroke`、`isPointInFill`、`getTotalLength`、`getPointAtLength`、`getCTM`、`getScreenCTM`、`getBBox`、`toDataURL`。 |
| **AsyncStorage**（小型，纯传统桥接） | ~60（28 kt + 2 mm + 16 ts + 14 tsx + …） | **8/8 条精确** | 典型传统桥接测试——Kotlin `@ReactMethod` + ObjC `RCT_EXPORT_METHOD`。JS `setItem` → Kotlin `legacy_multiSet`；`getItem` → `legacy_multiGet`；`clear` → `legacy_clear`；等。 |
| **react-native-firebase**（大型） | ~1100（111 .java + 63 .m + 13 .mm + 239 js + 427 ts + 9 tsx） | 加 RCTEventEmitter 阻断列表后 18 条（之前为 78 条） | 初始 78 条中包含 60 条指向 `addListener:` / `remove:` 的误报（每个 RCTEventEmitter 都声明了这些方法；每个 JS 调用 `.addListener(...)` 的地方都解析到噪声中）。阻断列表削减到 18 条，全部精确：`httpsCallable:region:emulatorHost:...`、`signInWithProvider`、`configureProvider`、`removeFunctionsStreaming:`。 |
| **react-native-screens**（中型） | 1211 | 0——TurboModule spec 为空，无 `RCT_EXPORT_METHOD`，全部为 Fabric/Codegen 视图侧 | RNScreens 完全处于阶段 6（Fabric，延后）。桥接在此处不过度匹配是正确的行为。 |

### 8c. 验证过程中发现的架构修复

解析器的 `initialize()` 在 Synapse 构建时运行——早于任何文件被索引——因此 `detect()` 会查询已索引文件列表的框架解析器（UIKit / SwiftUI 扫描导入、`swift-objc-bridge` 查找 Swift 和 ObjC 文件、`react-native-bridge` 查找 RN 标记）在那次初始传递中全部返回 false，并悄无声息地将自身移除。这影响了代码库中所有读取 `context.getAllFiles()` / `context.readFile()` 而非直接扫描文件系统的框架解析器——这是一个预先存在的潜在 bug，并非桥接特有。修复方案：`indexAll()` 现在在提取完成后调用 `resolver.initialize()`，使 `detect()` 在已填充的索引上运行。

### 8d. 桥接精度阻断列表（经验教训）

| 桥接 | 阻断名称 | 原因 |
|---|---|---|
| swift-objc | `init`、`description`、`hash`、`isEqual`、`copy`、`count`、`value`、`data`、`string`、`object`、`add`、`remove`、`update`、`load`、`save`、`reload`、`cancel`、`start`、`stop`、`pause`、`resume`、`close`、`open`、`show`、`hide`、`dealloc`、`release`、`retain`、`autorelease`……等 | 每个 NSObject 子类都实现这些方法；将它们桥接到任意项目本地 ObjC 方法会产生噪声。普通名称匹配器自行处理即可。 |
| react-native | `addListener`、`removeListeners`、`remove`、`invalidate`、`startObserving`、`stopObserving` | 每个 `RCTEventEmitter` 子类都通过 `RCT_EXPORT_METHOD` 声明这些方法。JS 调用 `.addListener(...)` / `.remove(...)` 的地方通过 `NativeEventEmitter`（JS 抽象层）而非直接通过 native 桥接进行。 |

### 8e. 阶段 3 测量——RN native → JS 事件通道

合成器模式；扩展 `src/resolution/callback-synthesizer.ts`，增加以字面事件名为键的跨语言事件通道。在 **RNFirebase**（大型）上验证：

| 合成事件通道 | 边数 | 示例 |
|---|---|---|
| `messaging_message_received` | 2 | `application:didReceiveRemoteNotification:fetchCompletionHandler:` → TS `onMessage`（以及 `UNUserNotificationCenter` willPresent 变体 → 同一 `onMessage`） |
| `messaging_notification_opened` | 1 | `userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:` → TS `onNotificationOpenedApp` |

每条边均为 `provenance:'heuristic'`，`metadata.synthesizedBy:'rn-event-channel'`。与同语言通道相同的 `EVENT_FANOUT_CAP = 6`——处理程序或分发者过多的通用事件名称跳过而非过度关联。

合成器还处理 RN 库中常见的**订阅封装模式**（`messaging().onMessage(listener)` 中 `listener` 是向上流动到用户代码的参数）：当 JS 处理器参数不是命名符号时，将监听器归因于**外层 JS 函数**（可达性正确，归因于抽象层）。

### 8f. 阶段 4 测量——Expo Modules

框架 `extract()` 解析 Swift / Kotlin 源码中 `class X: Module`（或 Kotlin 的 `: Module()`）内的字面 `Function("X") { … }` / `AsyncFunction("X") { … }` / `Property("X") { … }` / `Constants` 声明，并为每个字面量发出一个名称为 `X` 的 `method` 节点。标准名称匹配器通过已有的 `obj.method` → 方法名路径，将 JS 调用点（如 `Foo.takePictureAsync(...)`）解析到这些合成节点。

在真实 Expo SDK 包上验证：

| 包 | 已索引文件数 | 提取的 Expo 方法节点数 | 跨语言边数 |
|---|---|---|---|
| **expo-haptics** | 14 | 6（3 Swift + 3 Kotlin：`notificationAsync`、`impactAsync`、`selectionAsync` / `performHapticsAsync`） | 模块节点已注册；消费者应用调用者通过名称匹配解析 |
| **expo-camera** | 72 | 41（Swift + Kotlin；覆盖 `takePictureAsync`、`record`、`resumePreview`、`getAvailableLenses`、`scanFromURLAsync`、`requestCameraPermissionsAsync`、视图侧 `width`/`height` 属性等） | 9 条 swift→expo，7 条 kotlin→expo 内部边。包内 JS 侧调用点用 TS 封装器遮蔽了 native 名称（`CameraView.tsx` 上定义了 `pausePreview()`）；名称匹配正确地优先选择本地 TS 方法。外部消费者应用调用 `Camera.takePictureAsync()` 时，直接解析到 native 方法。 |

五个测试覆盖提取器 + 端到端 fixture：`JS callsite of literal AsyncFunction("uniqueExpoHapticCall") resolves to the native impl node`——确认在名称未被遮蔽时无解析器桥接路径正常工作。

### 8g. 阶段 6 测量——Fabric / Codegen 视图组件

两部分设计：

1. **框架提取器**（`src/resolution/frameworks/fabric.ts`）——解析 TS / TSX spec 文件中的 `codegenNativeComponent<Props>('Name', ...)` 声明。发出：
   - 每个声明一个 `component` 节点（以 JS 可见组件名命名；匹配 JSX 合成器的名称+类型过滤器）。
   - `NativeProps` 接口每个已声明字段一个 `property` 节点——将 JSX 可调用的 prop（如 `onTap`、`nativeContainerBackgroundColor`）作为可发现的图节点暴露出来。

2. **合成器**（`callback-synthesizer.ts` 中的 `fabricNativeImplEdges`）——遍历每个 `fabric-component:*` 节点，查找名称匹配其名称加 RN 约定后缀（空 / `View` / `ViewManager` / `ComponentView` / `Manager`）的 native 类。发出带有 `metadata.synthesizedBy:'fabric-native-impl'` 的 `calls` 边，从组件指向每个匹配。该约定足够精确，在规范的 RN 库中不会出现名称冲突。

与已有 `reactJsxChildEdges` JSX 合成器结合，闭合了完整的 JSX → native 流程：消费者应用 JSX `<MyView prop=v/>` → Fabric `component` 节点 `MyView` → native 类 `MyViewView`（或 `MyViewManager` / `MyViewComponentView` / …）。

在 **react-native-screens**（阶段 2 中完全是 Fabric 且显示 0 桥接的语料库代码库）上重新验证：

| 指标 | 数量 |
|---|---|
| `codegenNativeComponent` spec 声明数 | 54 |
| 提取的 Fabric 组件节点数 | 27（每个非 web spec 一个；`*.web.ts` 变体由 spec 有效性过滤） |
| 提取的 Fabric prop 节点数 | 272（跨所有组件的完整 NativeProps 接口面） |
| `fabric-native-impl` 桥接边数 | 68 |

示例桥接边：

| JS 组件 | Native 类 | 后缀 |
|---|---|---|
| `RNSFullWindowOverlay` | `RNSFullWindowOverlay`（ObjC） | （精确） |
| `RNSFullWindowOverlay` | `RNSFullWindowOverlayManager`（ObjC） | `Manager` |
| `RNSModalScreen` | `RNSModalScreenManager`（ObjC） | `Manager` |
| `RNSScreenContainer` | `RNSScreenContainerView`（ObjC） | `View` |

四个测试覆盖提取器 + 完整端到端 fixture（`App (TSX) → MyView (fabric-component) → MyViewView (ObjC class)`），断言 JSX→component 边和 component→native-class 边在索引后均存在。

---

## 9. 阶段 1 待确认的未解问题

这些问题不阻塞阶段 1 的启动——它们是*在编写* Swift↔ObjC 解析器时需要首先决定的事项：

1. **声明上的别名 vs 新桥接边？** 将自动桥接的 ObjC 选择器存储为 Swift 方法节点上的备用名称，开销更小，且与名称解析已有的工作方式一致。替代方案（在匹配节点间合成跨语言 `references` 边）在 `trace` 输出中更明确，但每个 `@objc` 符号会增加 N 条边。**默认：别名。** 验证别名是否能在 `callers`/`callees`/`trace` 结果中正确呈现。
2. **`trace` 如何显示跨语言跳转？** MCP `trace` 工具内联每个跳转的体。Swift → ObjC 跳转应在渲染输出中清晰标记（"Swift `func foo(bar:)` → 桥接到 ObjC 选择器 `-fooWithBar:` → ObjC `-[ImageDownloader fooWithBar:]`"）。可能需要在 `trace.ts` 中对渲染器做小改动来标注桥接。
3. **解析器桥接规则放在哪里？** 建议在 `src/resolution/frameworks/swift-objc.ts` 中存放自动命名映射（纯函数），由 Swift 提取器（在提取时计算别名）和测试共同引用。让映射保持单一位置。
4. **`@objcMembers` 怎么处理？** 类级别导出——应用于所有成员，除非带有 `@nonobjc`。通过在 Swift 提取器中检查类的修饰符，并从中推断每个成员的 `@objc` 属性来处理。

---

## 10. 完成标准（知道何时可以停止）

阶段 1（Swift↔ObjC）的完成条件：
- §5a 三个语料库全部通过：纯语言探针不变；跨语言典型流程探针端到端找到路径；智能体 A/B 在使用 synapse 的 ≥1 次运行中 Read = 0，比无 synapse 更快。
- playbook §6 的覆盖矩阵行已填入数据。
- CHANGELOG `[Unreleased]` 存在一条面向用户的条目。

每个后续阶段的形态相同——有自己的 §5 语料库、自己的矩阵行、自己的 CHANGELOG 条目——且**在上一阶段通过前不发布**。在这里，不允许以避免半桥接为由绕过此要求；半桥接会让 synapse 在这些代码库上主动变差，比没有任何桥接还要糟糕。
