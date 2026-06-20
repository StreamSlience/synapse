/**
 * React Native Fabric / Codegen 视图组件——iOS/RN 混合桥接工作的第 6 阶段。
 *
 * 在新的 RN 架构中，JS 可见的视图组件通过如下形式的 Codegen TypeScript spec 文件声明：
 *
 *   // src/fabric/MyComponentNativeComponent.ts
 *   import { codegenNativeComponent } from 'react-native';
 *   import type { ViewProps, CodegenTypes as CT } from 'react-native';
 *
 *   export interface NativeProps extends ViewProps {
 *     color?: ColorValue;
 *     onTap?: CT.DirectEventHandler<TapEvent>;
 *   }
 *
 *   export default codegenNativeComponent<NativeProps>('MyComponent');
 *
 * Codegen 随后生成一个原生 ComponentDescriptor，将 JS 组件名称与原生实现类绑定——
 * 按 RN 惯例，实现类为以下之一：`MyComponent`、`MyComponentView`、
 * `MyComponentComponentView`、`MyComponentManager`、`MyComponentViewManager`。
 * 实际实现在 iOS 的 ObjC++（.mm）或 Android 的 Kotlin/Java 中。
 *
 * 若不做桥接，消费方应用中的 JSX `<MyComponent color="red"/>` 在图谱中将无处落地——
 * JS 可见名称 `MyComponent` 在任何地方都不是节点（只有 `MyComponentView` 在 .mm 中），
 * 而 JSX 合成器按名称严格匹配。
 *
 * 此提取器的功能：
 *   1. 解析 spec 文件中的 `codegenNativeComponent<Props>('Name', ...)` 字面量——
 *      生成一个以 `Name` 命名的 `component` 节点，归属到 spec 文件。
 *   2. 解析 `NativeProps` 接口，为每个 prop 生成一个 `property` 节点，
 *      归属到 spec 文件。`onTap` / `onFinishTransitioning` 等 prop 是
 *      JS 可调用的事件 handler 绑定；将它们作为节点暴露，让智能体能够
 *      发现组件的 JS 接口。
 *
 * 配套合成器（callback-synthesizer.ts 中的 `fabricNativeImplEdges`）
 * 通过基于惯例的名称+后缀查找，将生成的 component 节点链接到其原生实现类——
 * 产生跨语言跳转，JSX 合成器的 `<MyComponent>` 边自然链接到该节点。
 */
import type { Node } from '../../types';
import {
  FrameworkExtractionResult,
  FrameworkResolver,
} from '../types';

const CODEGEN_DECL_RE =
  /codegenNativeComponent\s*(?:<[^>]+>)?\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;

/**
 * 旧版 Paper 视图管理器宏——较老的 RN 库（仍非常常见，尤其是尚未迁移到
 * Codegen 的小型库）通过声明 ViewManager 类并使用这些宏暴露 prop。两种形式：
 *
 *   RCT_EXPORT_VIEW_PROPERTY(values, NSArray)
 *   RCT_EXPORT_VIEW_PROPERTY(onChange, RCTBubblingEventBlock)
 *   RCT_CUSTOM_VIEW_PROPERTY(text, NSString, RNCMyView) { … }
 *   RCT_REMAP_VIEW_PROPERTY(jsName, nativeKeyPath, NSString)
 *
 * 捕获第一个参数——即 JS 可见的 prop 名称。
 */
const RCT_VIEW_PROP_RE =
  /\bRCT_(?:EXPORT|CUSTOM|REMAP)_VIEW_PROPERTY\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * ObjC `@implementation Foo` 提取。用于识别 ViewManager 类，
 * 从而推导 JS 可见的组件名称（去掉 `Manager` 后缀和 `RCT` 前缀，
 * 两者都是标准惯例）。
 */
const OBJC_IMPL_RE = /@implementation\s+([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * 从原生 ViewManager 类推导 JS 可见的组件名称。
 * 去掉尾随的 `Manager`（以及可选的 `ViewManager`）——RN 的视图注册表
 * 通过此惯例将 `XXXManager` ↔ JS `<XXX/>` 对应。
 * 前导的 `RCT` 前缀也会被去掉（与 RN 旧版 bridge 模块的
 * `defaultObjcModuleName` 处理方式一致）。
 */
function deriveComponentNameFromManager(className: string): string {
  let name = className.startsWith('RCT') ? className.slice(3) : className;
  // 按顺序去掉 ViewManager > Manager > View。
  if (name.endsWith('ViewManager')) name = name.slice(0, -'ViewManager'.length);
  else if (name.endsWith('Manager')) name = name.slice(0, -'Manager'.length);
  return name;
}

/**
 * 廉价的源码级检测器——必须包含 `codegenNativeComponent` 才值得解析。
 * 该 import 的存在是规范的 Fabric spec 信号。
 */
function isFabricSpec(source: string): boolean {
  return source.includes('codegenNativeComponent');
}

/**
 * 从 Fabric spec 源码中提取 `NativeProps` 接口的函数体。
 * 当接口未以预期形式声明时返回 `null`。
 */
function findNativePropsBody(source: string): string | null {
  // 宽松匹配：`export interface NativeProps [extends X, Y] { … }`。
  const m = source.match(/export\s+interface\s+NativeProps\b[^{]*\{([\s\S]*?)\n\}/);
  return m?.[1] ?? null;
}

/**
 * 解析 NativeProps 接口体并返回 prop 名称列表。
 * 每个 prop 的形式为独占一行的 `name?: Type;` 或 `name: Type;`。
 * 我们不关心类型——只需 JS 可见的名称。
 */
function extractPropNames(body: string): string[] {
  const props: string[] = [];
  // 锚定到行首（可选空白之后），捕获标识符，然后可选的 `?`，再接 `:`。
  // 跳过看起来像方法声明的行（`name(`）——那些是 TurboModule spec 方法，
  // 不是视图 prop。
  const regex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(body)) !== null) {
    const name = m[1]!;
    // 排除紧接着变成函数形式的行（例如 `onTap?: () => void` 没问题——
    // 它是 prop，不是方法体——但字面量 `name(arg: T): R` 是方法声明）。
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 80);
    if (/^\s*\(/.test(after)) continue; // 方法形式，跳过
    props.push(name);
  }
  return props;
}

/**
 * 从 .m/.mm 文件中提取旧版 Paper 视图管理器声明。
 * 根据 JS 可见名称（从 @implementation 类推导）生成 `component` 节点，
 * 并为每个 `RCT_EXPORT_VIEW_PROPERTY(name, ...)` 宏生成 `property` 节点。
 *
 * 若文件不像 ViewManager（无 RCT_EXPORT_VIEW_PROPERTY 宏），返回 `[]`。
 */
function extractLegacyViewManagerNodes(filePath: string, source: string): Node[] {
  // 廉价门控：完全没有视图属性宏 → 不是 view manager。
  if (!source.includes('RCT_EXPORT_VIEW_PROPERTY') &&
      !source.includes('RCT_CUSTOM_VIEW_PROPERTY') &&
      !source.includes('RCT_REMAP_VIEW_PROPERTY')) {
    return [];
  }
  const implMatch = source.match(OBJC_IMPL_RE);
  if (!implMatch || !implMatch[1]) return [];
  const className = implMatch[1];
  // 仅处理真正的 ViewManager——以 Manager 或（旧版）ViewManager 结尾的类。
  // 含有视图属性宏但不符合命名惯例的类不寻常；跳过以保持精度。
  if (!className.endsWith('Manager') && !className.endsWith('ViewManager')) return [];
  const componentName = deriveComponentNameFromManager(className);
  if (!componentName) return [];

  const now = Date.now();
  const nodes: Node[] = [];

  // component 节点——与 Codegen Fabric 的形状相同，因此
  // fabricNativeImplEdges 合成器（将 component 链接到原生类）
  // 对旧版同样有效。此情况下原生类就是 manager 本身；
  // 合成器中基于惯例的后缀查找（`Manager`、`ViewManager`）会找到它。
  const before = source.slice(0, implMatch.index ?? 0);
  const startLine = before.split('\n').length;
  nodes.push({
    id: `fabric-component:${filePath}:${componentName}:${startLine}`,
    kind: 'component',
    name: componentName,
    qualifiedName: `${filePath}::${componentName}`,
    filePath,
    language: 'objc',
    startLine,
    endLine: startLine,
    startColumn: 0,
    endColumn: componentName.length,
    docstring: `Legacy Paper ViewManager component '${componentName}' (from @implementation ${className})`,
    signature: `RCT_EXPORT_MODULE() // ViewManager: ${className}`,
    isExported: true,
    updatedAt: now,
  });

  // 每个 RCT_EXPORT_VIEW_PROPERTY 宏对应一个 property 节点。
  const seen = new Set<string>();
  RCT_VIEW_PROP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RCT_VIEW_PROP_RE.exec(source)) !== null) {
    const propName = m[1]!;
    if (seen.has(propName)) continue;
    seen.add(propName);
    const propBefore = source.slice(0, m.index);
    const propLine = propBefore.split('\n').length;
    nodes.push({
      id: `fabric-prop:${filePath}:${propName}:${propLine}`,
      kind: 'property',
      name: propName,
      qualifiedName: `${filePath}::${componentName}.${propName}`,
      filePath,
      language: 'objc',
      startLine: propLine,
      endLine: propLine,
      startColumn: 0,
      endColumn: propName.length,
      docstring: `Legacy Paper view prop '${propName}' on ${componentName}`,
      isExported: true,
      updatedAt: now,
    });
  }
  return nodes;
}

/**
 * Java/Kotlin `@ReactProp("name")` 提取。该注解位于继承自 `ViewManager` /
 * `SimpleViewManager` 的类上的 setter 方法之前（Kotlin 使用 `:` 语法）。
 *
 * 若未找到 @ReactProp 注解，返回 `[]`。
 */
function extractJvmViewManagerNodes(filePath: string, source: string): Node[] {
  if (!source.includes('@ReactProp')) return [];

  // 类名——查找 `class FooManager [extends ViewManager...]`（Java）
  // 或 `class FooManager : ViewManager...`（Kotlin）。两者都能确认
  // 这是 ViewManager 文件；含有 @ReactProp 的非 Manager 类不寻常。
  const classMatch = source.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
  if (!classMatch || !classMatch[1]) return [];
  const className = classMatch[1];
  if (!className.endsWith('Manager') && !className.endsWith('ViewManager')) return [];
  const componentName = deriveComponentNameFromManager(className);
  if (!componentName) return [];

  const language: 'java' | 'kotlin' = filePath.endsWith('.kt') ? 'kotlin' : 'java';
  const now = Date.now();
  const nodes: Node[] = [];

  const classBefore = source.slice(0, classMatch.index ?? 0);
  const startLine = classBefore.split('\n').length;
  nodes.push({
    id: `fabric-component:${filePath}:${componentName}:${startLine}`,
    kind: 'component',
    name: componentName,
    qualifiedName: `${filePath}::${componentName}`,
    filePath,
    language,
    startLine,
    endLine: startLine,
    startColumn: 0,
    endColumn: componentName.length,
    docstring: `Android view-manager component '${componentName}' (from class ${className})`,
    signature: `class ${className} : ViewManager`,
    isExported: true,
    updatedAt: now,
  });

  // @ReactProp("name") 之后（可选修饰符/参数之后）紧跟
  // setter 声明。注解参数是 JS 可见的 prop 名称。
  // 对其余部分保持宽松——我们只需要字面量。
  const REACT_PROP_RE = /@ReactProp\s*\(\s*(?:name\s*=\s*)?"([^"]+)"/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = REACT_PROP_RE.exec(source)) !== null) {
    const propName = m[1]!;
    if (seen.has(propName)) continue;
    seen.add(propName);
    const propBefore = source.slice(0, m.index);
    const propLine = propBefore.split('\n').length;
    nodes.push({
      id: `fabric-prop:${filePath}:${propName}:${propLine}`,
      kind: 'property',
      name: propName,
      qualifiedName: `${filePath}::${componentName}.${propName}`,
      filePath,
      language,
      startLine: propLine,
      endLine: propLine,
      startColumn: 0,
      endColumn: propName.length,
      docstring: `Android @ReactProp prop '${propName}' on ${componentName}`,
      isExported: true,
      updatedAt: now,
    });
  }
  return nodes;
}

function extractFabricNodes(filePath: string, source: string): Node[] {
  if (!isFabricSpec(source)) return [];

  const now = Date.now();
  const nodes: Node[] = [];

  CODEGEN_DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODEGEN_DECL_RE.exec(source)) !== null) {
    const componentName = m[1]!;
    const before = source.slice(0, m.index);
    const startLine = before.split('\n').length;
    const startColumn = before.length - before.lastIndexOf('\n') - 1;

    // component 节点本身——kind: 'component'，使现有的
    // reactJsxChildEdges 合成器能将 `<MyComponent>` JSX 标签匹配到它
    // （其 name+kind 过滤器是门控条件）。
    const componentId = `fabric-component:${filePath}:${componentName}:${startLine}`;
    nodes.push({
      id: componentId,
      kind: 'component',
      name: componentName,
      qualifiedName: `${filePath}::${componentName}`,
      filePath,
      // spec 文件为 .ts 或 .tsx；按文件扩展名使用其对应语言。
      // 裁剪为已知的 Language 值。
      language: filePath.endsWith('.tsx') ? 'tsx' : 'typescript',
      startLine,
      endLine: startLine,
      startColumn,
      endColumn: startColumn + 'codegenNativeComponent'.length,
      docstring: `Fabric/Codegen native component '${componentName}'`,
      signature: `codegenNativeComponent<NativeProps>('${componentName}')`,
      isExported: true,
      updatedAt: now,
    });
  }

  // NativeProps 接口中的 prop。这些不是"方法"语义
  // ——它们是消费者通过 JSX 属性设置的 JS 可见绑定——
  // 因此使用 `property` kind。（JSX 合成器目前不生成
  // 按属性的边，但将 prop 名称作为节点暴露，
  // 使 `synapse_search('onFinishTransitioning')` 能够发现它们。）
  const body = findNativePropsBody(source);
  if (body) {
    const props = extractPropNames(body);
    for (const propName of props) {
      const propBefore = source.indexOf(propName, source.indexOf(body));
      const propLine =
        propBefore >= 0 ? source.slice(0, propBefore).split('\n').length : 1;
      nodes.push({
        id: `fabric-prop:${filePath}:${propName}:${propLine}`,
        kind: 'property',
        name: propName,
        qualifiedName: `${filePath}::NativeProps.${propName}`,
        filePath,
        language: filePath.endsWith('.tsx') ? 'tsx' : 'typescript',
        startLine: propLine,
        endLine: propLine,
        startColumn: 0,
        endColumn: propName.length,
        docstring: `Fabric NativeProps prop '${propName}'`,
        isExported: true,
        updatedAt: now,
      });
    }
  }

  return nodes;
}

export const fabricViewResolver: FrameworkResolver = {
  name: 'fabric-view',
  languages: ['typescript', 'tsx', 'objc', 'java', 'kotlin'],

  detect(context) {
    // 根节点 package.json 是常见情况。索引器在 getAllFiles() 中只跟踪
    // 源文件，因此子包的 package.json 无法通过该方式枚举——
    // 对于 monorepo，需要通过 listDirectories() 显式探测。
    const checkPkg = (relativePath: string) => {
      const pkg = context.readFile(relativePath);
      return pkg ? /["']react-native["']\s*:/.test(pkg) : false;
    };
    if (checkPkg('package.json')) return true;
    // Monorepo 逃生舱——react-native-skia 及类似的 workspace 仓库
    // 仅在 `packages/<sub>/package.json` 中有 RN 依赖。
    // 向下遍历常见的 workspace 根目录一层。
    const list = context.listDirectories;
    if (!list) return false;
    for (const root of ['packages', 'apps', 'modules', 'libraries']) {
      for (const sub of list(root) ?? []) {
        if (checkPkg(`${root}/${sub}/package.json`)) return true;
      }
    }
    return false;
  },

  extract(filePath, source): FrameworkExtractionResult {
    // 按文件语言选择正确的提取器。框架注册表已按 `languages` 过滤，
    // 因此我们只会看到相关文件。
    let nodes: Node[] = [];
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      nodes = extractFabricNodes(filePath, source);
    } else if (filePath.endsWith('.m') || filePath.endsWith('.mm')) {
      nodes = extractLegacyViewManagerNodes(filePath, source);
    } else if (filePath.endsWith('.java') || filePath.endsWith('.kt')) {
      nodes = extractJvmViewManagerNodes(filePath, source);
    }
    return { nodes, references: [] };
  },

  resolve() {
    // 配套合成器（`fabricNativeImplEdges`）处理跨语言边；
    // 标准名称解析通过 JSX 合成器处理 <MyComponent> → component 节点。
    return null;
  },
};
