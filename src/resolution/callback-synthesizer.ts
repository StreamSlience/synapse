/**
 * 回调 / 观察者边合成——第 1 + 2 阶段。
 *
 * 弥补动态分发缺口：分发器调用在其他地方注册的回调时，静态边会断裂。
 * 两种通道形态：
 *
 *  (1) 字段支撑的观察者（第 1 阶段）：
 *      onUpdate(cb) { this.callbacks.add(cb); }            // 注册方
 *      triggerUpdate() { for (cb of this.callbacks) cb(); } // 分发方
 *      scene.onUpdate(this.triggerRender)                  // 注册调用
 *      → 合成 triggerUpdate → triggerRender
 *
 *  (2) 字符串键 EventEmitter（第 2 阶段）：
 *      this.on('mount', function onmount(){...})           // 注册
 *      fn.emit('mount', this)                              // 分发
 *      → 合成（包含 emit('mount') 的方法）→ onmount
 *
 * 在基础解析之后对整个图执行。设计上高精度/低召回：
 * 仅处理具名回调；字段通道按 file+field 配对；EventEmitter
 * 通道受事件扇出上限约束（'error' 等泛型名称跳过——
 * 需要接收者类型匹配，延至第 3 阶段处理）。所有合成边均
 * 标记 `provenance:'heuristic'`。参见 docs/design/callback-edge-synthesis.md。
 */
import type { Edge, Node, NodeKind } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { ResolutionContext } from './types';
import { isGeneratedFile } from '../extraction/generated-detection';
import { stripCommentsForRegex } from './strip-comments';

const REGISTRAR_NAME = /^(on[A-Z]\w*|subscribe|addListener|addEventListener|register|watch|listen|addCallback)$/;
const DISPATCHER_NAME = /(emit|trigger|notify|dispatch|fire|publish|flush)/i;
const MAX_CALLBACKS_PER_CHANNEL = 40;
const EVENT_FANOUT_CAP = 6; // 处理器/分发器数量超过此上限的事件跳过（缺乏类型信息时过于泛化）

const ON_RE = /\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*(?:function\s+(\w+)|(?:this\.)?(\w+))/g;
const EMIT_RE = /\.(?:emit|fire|dispatchEvent)\(\s*['"]([^'"]+)['"]/g;
const SETSTATE_RE = /this\.setState\s*\(/;
const FLUTTER_SETSTATE_RE = /\bsetState\s*\(/; // Flutter: setState((){…}) / this.setState
const JSX_TAG_RE = /<([A-Z][A-Za-z0-9_]*)[\s/>]/g;
const MAX_JSX_CHILDREN = 30;
// Vue SFC 模板：kebab-case 子组件（<el-button> → ElButton）和
// 事件绑定（@click="fn" / v-on:click="fn"）。PascalCase 子组件（<VPNav/>）
// 已通过 SFC 组件节点由 JSX_TAG_RE 捕获。
const VUE_KEBAB_RE = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g;
// PascalCase 组件标签——`<MediaCard ...>`、`<NavBar/>`。HTML 元素为小写，
// 因此首字母大写的标签即为组件用法；内置组件
// （`<NuxtLink>`、`<Transition>`）解析为空，不产生边。
const VUE_PASCAL_RE = /<([A-Z][A-Za-z0-9]*)[\s/>]/g;
const VUE_HANDLER_RE = /(?:@|v-on:)([a-zA-Z][\w-]*)(?:\.[\w]+)*\s*=\s*"([^"]+)"/g;
// 组合式函数/hook 解构：`const { close: closeSidebar } = useSidebarControl()`。
// 捕获解构体与被调用的组合式函数；仅 `use*` 调用符合条件。
const VUE_DESTRUCTURE_RE = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(\w+)\s*\(/g;

// 闭包集合动态分发（语言无关，Swift 优先）。某方法将一个闭包
// 追加到集合属性；另一方法遍历该属性并*逐元素调用*
// （`coll.forEach { $0() }` / `{ it() }`）。
// 元素调用（`$0(` / `it(`）证明集合持有闭包，因此将分发器与
// 同名注册方（`.append`/`.add`/`.push`/`.insert`，
// 包括 Swift 的 `prop.write { $0.append }`）配对是高精度的。
// 设计上支持跨文件/类：Alamofire 在 `DataRequest.validate` 中追加，
// 却在基类 `Request.didCompleteTask` 中遍历——
// 同文件或同类配对均无法覆盖此场景。
const CC_DISPATCH_RE = /(\w+)\.forEach\s*\{\s*(?:\$0|it)\s*\(/g;
const CC_APPEND_WRITE_RE = /(\w+)\.write\s*\{\s*\$0(?:\.(\w+))?\.(?:append|add|push|insert)\s*\(/g;
const CC_APPEND_DIRECT_RE = /(\w+)\.(?:append|add|push|insert)\s*\(/g;
const CC_FANOUT_CAP = 8; // 某字段名的分发器/注册方超过此数量时跳过（过于泛化，无法可靠配对）

function kebabToPascal(s: string): string {
  return s.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/**
 * 从 `components/` 下的路径推导 Nuxt 自动导入组件名：
 * `components/media/Card.vue` → `MediaCard`，`components/base/foo/Bar.vue` →
 * `BaseFooBar`。每个目录段和文件名均转为 PascalCase 后拼接；
 * 若某目录的 PascalCase 名是下一段的前缀，则折叠合并
 * （Nuxt 去重规则：`base/BaseButton.vue` → `BaseButton`，而非 `BaseBaseButton`）。
 * 对平铺组件（`components/NavBar.vue`）返回 null——
 * 其节点已按 basename 命名，直接标签匹配即可找到。
 */
function nuxtComponentName(filePath: string): string | null {
  const marker = filePath.lastIndexOf('components/');
  if (marker === -1) return null;
  const rel = filePath.slice(marker + 'components/'.length).replace(/\.(vue|ts|tsx|js|jsx)$/i, '');
  const segs = rel.split('/').filter(Boolean).map(kebabToPascal);
  if (segs.length < 2) return null;
  const out: string[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && s.startsWith(prev)) out[out.length - 1] = s;
    else out.push(s);
  }
  return out.join('');
}

function sliceLines(content: string, startLine?: number, endLine?: number): string | null {
  if (!startLine || !endLine) return null;
  return content.split('\n').slice(startLine - 1, endLine).join('\n');
}

function registrarField(src: string): string | null {
  const m = src.match(/this\.(\w+)\.(?:add|push|set)\(/);
  return m ? m[1]! : null;
}

function dispatcherField(src: string): string | null {
  const forOf = src.match(/\bof\s+(?:Array\.from\(\s*)?this\.(\w+)/);
  if (forOf && /\b\w+\s*\(/.test(src)) return forOf[1]!;
  const forEach = src.match(/this\.(\w+)\.forEach\(/);
  if (forEach) return forEach[1]!;
  return null;
}

const FN_KINDS = new Set(['method', 'function', 'component']);

/** 行范围包含 `line` 的最内层函数/方法节点。 */
function enclosingFn(nodesInFile: Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const n of nodesInFile) {
    if (!FN_KINDS.has(n.kind)) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= line && end >= line) {
      if (!best || n.startLine >= best.startLine) best = n; // 优先选取范围最紧（起始行最晚）的外层节点
    }
  }
  return best;
}

/**
 * 惰性流式返回方法与函数节点。合成器只需扫描并筛选出极少量匹配项，
 * 若将所有函数/方法一次性物化（在符号密集的项目上可达数 GB）再迭代，
 * 正是导致 #610 OOM 的原因。惰性迭代使内存消耗在节点数上保持 O(1)。
 */
function* methodAndFunctionNodes(queries: QueryBuilder): IterableIterator<Node> {
  yield* queries.iterateNodesByKind('method');
  yield* queries.iterateNodesByKind('function');
}

/** 第 1 阶段：字段支撑的观察者通道（注册方与分发方共享同一存储）。 */
function fieldChannelEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const registrars: Array<{ node: Node; field: string }> = [];
  const dispatchers: Array<{ node: Node; field: string }> = [];

  for (const m of methodAndFunctionNodes(queries)) {
    const isReg = REGISTRAR_NAME.test(m.name);
    const isDisp = DISPATCHER_NAME.test(m.name);
    if (!isReg && !isDisp) continue;
    const content = ctx.readFile(m.filePath);
    const src = content && sliceLines(content, m.startLine, m.endLine);
    if (!src) continue;
    if (isReg) { const f = registrarField(src); if (f) registrars.push({ node: m, field: f }); }
    if (isDisp) { const f = dispatcherField(src); if (f) dispatchers.push({ node: m, field: f }); }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const reg of registrars) {
    const chDispatchers = dispatchers.filter(
      (d) => d.node.filePath === reg.node.filePath && d.field === reg.field
    );
    if (chDispatchers.length === 0) continue;
    const argRe = new RegExp(`${reg.node.name}\\s*\\(\\s*(?:this\\.)?(\\w+)`);
    let added = 0;
    for (const e of queries.getIncomingEdges(reg.node.id, ['calls'])) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (!e.line) continue;
      const caller = queries.getNodeById(e.source);
      if (!caller) continue;
      const line = ctx.readFile(caller.filePath)?.split('\n')[e.line - 1];
      const am = line?.match(argRe);
      if (!am) continue;
      const fn = ctx.getNodesByName(am[1]!).find((n) => n.kind === 'method' || n.kind === 'function');
      if (!fn) continue;
      for (const disp of chDispatchers) {
        if (disp.node.id === fn.id) continue;
        const key = `${disp.node.id}>${fn.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: disp.node.id, target: fn.id, kind: 'calls', line: disp.node.startLine,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'callback', via: reg.node.name, field: reg.field,
            // 回调的连线位置（`scene.onUpdate(this.triggerRender)`）。
            // 这是智能体最常通过 read/grep 查阅以理解流程的信息——
            // 将其暴露出来，让 node/trace/context 无需经过
            // callers() + Read 往返即可直接展示。
            registeredAt: `${caller.filePath}:${e.line}`,
          },
        });
        added++;
      }
    }
  }
  return edges;
}

/**
 * 闭包集合分发：分发器遍历闭包集合属性并逐元素调用；注册方将闭包追加到
 * 同名属性。产生分发器 → 注册方的边，使流程能到达注册点
 * （追加的闭包体及其调用者均在此处）。高精度：分发器的元素调用是门控条件
 * （不调用元素的 `.forEach` 被忽略），因此在没有闭包集合分发的仓库中
 * 不会产生任何边，无论有多少 `.append`/`.push` 调用点。
 *
 * 按字段名全局配对（必须支持跨文件/类——参见 Alamofire 的基类
 * `Request.didCompleteTask` 遍历由子类 `DataRequest.validate` 追加的
 * `validators`），并受扇出上限约束，防止跨无关类共享的泛型字段名
 * 产生噪声边。
 */
function closureCollectionEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const dispatchers = new Map<string, Array<{ node: Node; line: number }>>(); // 字段 → 分发方法 + forEach 行号
  const registrars = new Map<string, Array<{ node: Node; line: number }>>();   // 字段 → 注册方法 + append 行号

  const addReg = (field: string | undefined, node: Node, absLine: number) => {
    if (!field || /^\d+$/.test(field)) return; // `$0.append` 错误捕获了 `0`；写入 RE 负责处理该字段
    const arr = registrars.get(field) ?? [];
    if (!arr.some((r) => r.node.id === node.id)) arr.push({ node, line: absLine });
    registrars.set(field, arr);
  };

  for (const m of methodAndFunctionNodes(queries)) {
    const content = ctx.readFile(m.filePath);
    const src = content && sliceLines(content, m.startLine, m.endLine);
    if (!src) continue;
    const hasForEach = src.includes('.forEach');
    const hasAppend = src.includes('.append(') || src.includes('.add(') || src.includes('.push(') || src.includes('.insert(');
    if (!hasForEach && !hasAppend) continue;
    const lineAt = (idx: number) => (m.startLine ?? 1) + src.slice(0, idx).split('\n').length - 1;

    if (hasForEach) {
      CC_DISPATCH_RE.lastIndex = 0;
      let d: RegExpExecArray | null;
      while ((d = CC_DISPATCH_RE.exec(src))) {
        const arr = dispatchers.get(d[1]!) ?? [];
        if (!arr.some((n) => n.node.id === m.id)) arr.push({ node: m, line: lineAt(d.index) });
        dispatchers.set(d[1]!, arr);
      }
    }
    if (hasAppend) {
      CC_APPEND_WRITE_RE.lastIndex = 0;
      let w: RegExpExecArray | null;
      while ((w = CC_APPEND_WRITE_RE.exec(src))) addReg(w[2] || w[1], m, lineAt(w.index)); // 嵌套的 `$0.streams` 否则取 `.write` 的接收者
      CC_APPEND_DIRECT_RE.lastIndex = 0;
      let a: RegExpExecArray | null;
      while ((a = CC_APPEND_DIRECT_RE.exec(src))) addReg(a[1], m, lineAt(a.index));
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [field, disps] of dispatchers) {
    const regs = registrars.get(field);
    if (!regs || regs.length === 0) continue;
    if (disps.length > CC_FANOUT_CAP || regs.length > CC_FANOUT_CAP) continue; // 泛型字段——无法可靠配对
    for (const disp of disps) for (const reg of regs) {
      if (disp.node.id === reg.node.id) continue;
      const key = `${disp.node.id}>${reg.node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: disp.node.id, target: reg.node.id, kind: 'calls', line: disp.line,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'closure-collection', field, registeredAt: `${reg.node.filePath}:${reg.line}` },
      });
    }
  }
  return edges;
}

/** 第 2 阶段：字符串键 EventEmitter 通道（on('e', fn) ↔ emit('e')）。 */
function eventEmitterEdges(ctx: ResolutionContext): Edge[] {
  const emitsByEvent = new Map<string, Set<string>>();          // 事件 → 分发器节点 id
  const handlersByEvent = new Map<string, Map<string, string>>(); // 事件 → 处理器 id → 注册点（file:line）

  for (const file of ctx.getAllFiles()) {
    const content = ctx.readFile(file);
    if (!content) continue;
    const hasEmit = content.includes('.emit(') || content.includes('.fire(') || content.includes('.dispatchEvent(');
    const hasOn = content.includes('.on(') || content.includes('.once(') || content.includes('.addListener(');
    if (!hasEmit && !hasOn) continue;
    const nodesInFile = ctx.getNodesInFile(file);
    const lineOf = (idx: number) => content.slice(0, idx).split('\n').length;

    if (hasEmit) {
      EMIT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = EMIT_RE.exec(content))) {
        const disp = enclosingFn(nodesInFile, lineOf(m.index));
        if (!disp) continue;
        const set = emitsByEvent.get(m[1]!) ?? new Set<string>();
        set.add(disp.id); emitsByEvent.set(m[1]!, set);
      }
    }
    if (hasOn) {
      ON_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ON_RE.exec(content))) {
        const handlerName = m[2] || m[3];
        if (!handlerName) continue;
        const handler = ctx.getNodesByName(handlerName).find((n) => n.kind === 'function' || n.kind === 'method');
        if (!handler) continue;
        const map = handlersByEvent.get(m[1]!) ?? new Map<string, string>();
        map.set(handler.id, `${file}:${lineOf(m.index)}`); handlersByEvent.set(m[1]!, map);
      }
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [event, dispatchers] of emitsByEvent) {
    const handlers = handlersByEvent.get(event);
    if (!handlers) continue;
    // 精度保护：泛型事件名若有大量处理器/分发器，在缺乏接收者类型信息（第 3 阶段）的情况下
    // 无法精确匹配——跳过，而非过度连接。
    if (dispatchers.size > EVENT_FANOUT_CAP || handlers.size > EVENT_FANOUT_CAP) continue;
    for (const d of dispatchers) for (const [h, registeredAt] of handlers) {
      if (d === h) continue;
      const key = `${d}>${h}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: d, target: h, kind: 'calls', provenance: 'heuristic', metadata: { synthesizedBy: 'event-emitter', event, registeredAt } });
    }
  }
  return edges;
}

/**
 * 第 4 阶段：React 类组件重渲染。`this.setState(...)` 会重新执行
 * 组件的 `render()`，但该跳转是 React 内部行为——没有静态边——
 * 因此"mutation → setState → 画布重绘"这样的流程会在 setState 处中断，
 * 即便 `render → getRenderableElements → …` 在其后已完全通过调用连接。
 * 桥接方式：对每个拥有 `render` 方法的类，将所有在方法体中调用
 * `this.setState(` 的兄弟方法链接到 `render`。setState 门控将范围限制在
 * React 类组件（非 React 类即便有 `render` 方法也不会调用 `this.setState`）。
 * 过度近似（所有 setState 方法都能到达 render）是可接受的——
 * 可达性正确，与回调通道的处理方式一致。
 */
function reactRenderEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const cls of queries.getNodesByKind('class')) {
    const children = queries.getOutgoingEdges(cls.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
    const render = children.find((n) => n.name === 'render');
    if (!render) continue;
    let added = 0;
    for (const m of children) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (m.id === render.id) continue;
      const content = ctx.readFile(m.filePath);
      const src = content && sliceLines(content, m.startLine, m.endLine);
      if (!src || !SETSTATE_RE.test(src)) continue;
      const key = `${m.id}>${render.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: m.id, target: render.id, kind: 'calls', line: m.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'react-render', via: 'setState', registeredAt: `${render.filePath}:${render.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

/**
 * 第 4b 阶段：Flutter setState → build（react-render 的 Dart 对应版本）。
 * 在 StatefulWidget 的 State 类中，`setState(() {…})` 会重新执行 `build(context)`，
 * 但该跳转是框架内部行为（Flutter 负责调用 build），因此
 * "onPressed → _increment → setState → 界面重建"这样的流程会在 setState 处中断。
 * 桥接方式：对每个拥有 `build` 方法的 Dart 类，将所有在方法体中调用
 * `setState(` 的兄弟方法链接到 `build`。setState 门控加上 `.dart` 文件限制
 * 将范围约束在 Flutter State 类。过度近似可接受（可达性正确）。
 */
function flutterBuildEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const cls of queries.getNodesByKind('class')) {
    const children = queries.getOutgoingEdges(cls.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
    const build = children.find((n) => n.name === 'build');
    if (!build || !build.filePath.endsWith('.dart')) continue;
    let added = 0;
    for (const m of children) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      if (m.id === build.id) continue;
      const content = ctx.readFile(m.filePath);
      const src = content && sliceLines(content, m.startLine, m.endLine);
      if (!src || !FLUTTER_SETSTATE_RE.test(src)) continue;
      const key = `${m.id}>${build.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: m.id, target: build.id, kind: 'calls', line: m.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'flutter-build', via: 'setState', registeredAt: `${build.filePath}:${build.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

/**
 * 第 4c 阶段：C++ 虚函数覆盖。通过基类/接口指针的调用
 * （`db->Get(...)`、`iter->Next()`）在运行时分发到子类覆盖，
 * 但该跳转是 vtable 间接调用——没有静态调用边——因此流程会停在
 * 抽象基类方法处。桥接方式类似 react-render：对每个 `extends` 基类的 C++ 类，
 * 将每个基类方法链接到同名子类方法（覆盖），使接口方法的
 * trace/callees 能到达具体实现。过度近似可接受（可达性正确）；
 * 每类设上限，且仅限 C++ 以避免影响其他语言的分发。
 */
function cppOverrideEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const methodsOf = (classId: string): Node[] =>
    queries
      .getOutgoingEdges(classId, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
  for (const cls of queries.getNodesByKind('class')) {
    const subMethods = methodsOf(cls.id).filter((n) => n.language === 'cpp');
    if (subMethods.length === 0) continue;
    for (const ext of queries.getOutgoingEdges(cls.id, ['extends'])) {
      const base = queries.getNodeById(ext.target);
      if (!base || base.language !== 'cpp' || base.id === cls.id) continue;
      const baseMethods = new Map(methodsOf(base.id).map((m) => [m.name, m]));
      let added = 0;
      for (const m of subMethods) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
        const bm = baseMethods.get(m.name);
        if (!bm || bm.id === m.id) continue;
        const key = `${bm.id}>${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: bm.id,
          target: m.id,
          kind: 'calls',
          line: bm.startLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'cpp-override', via: m.name, registeredAt: `${m.filePath}:${m.startLine}` },
        });
        added++;
      }
    }
  }
  return edges;
}

/**
 * 第 5.5 阶段：接口/抽象类分发（Java、Kotlin）。通过注入接口
 * （`@Autowired FooService svc; svc.list()`）或抽象基类的调用，
 * 在运行时分发到实现类的覆盖方法——vtable 间接调用，无静态调用边——
 * 因此 request→service 流程会停在接口方法处。桥接方式类似 cpp-override：
 * 对每个 `implements` 接口（或 `extends` 抽象基类）的类，将每个
 * 基类/接口方法链接到该类的同名方法（覆盖），使 trace/callees 能到达实现。
 * 过度近似可接受（可达性正确）；每类设上限，仅限 JVM 语言。
 */
// 应为接口（或抽象基类）方法与对应具体类方法建立桥接的语言集合，
// 通过静态 `implements`/`extends` 边实现。
// 该集合为"具有显式名义子类型且持有方法的单一 class 类型"的语言，
// 即符合此循环期望的形态。Swift 和 Scala 在形态上符合
// （Swift 的 `protocol`/`class`，Scala 的 `trait`/`class`），已添加至此；
// 其具体端节点可以是 `struct`（Swift）或 `object`（Scala），
// 因此循环也会遍历这两种类型。
const IFACE_OVERRIDE_LANGS = new Set([
  'java', 'kotlin', 'csharp', 'typescript', 'javascript', 'swift', 'scala', 'go', 'rust',
]);
/**
 * Go 隐式接口满足（#584）。Go 没有 `implements` 关键字——
 * 当一个 struct 的方法集覆盖接口的方法集时，结构性地满足该接口。
 * 通过方法名集合匹配来合成缺失的 `implements` 边（struct → interface），
 * 使实现导航可用，同时让接口分发桥接（{@link interfaceOverrideEdges}，
 * 现已启用 'go'）能将接口方法调用链接到具体覆盖方法。
 *
 * 仅按名称匹配（忽略签名）——过度近似可接受，与其他分发合成器保持一致；
 * 每接口设上限。空接口（`any`）跳过，以免匹配所有 struct。
 */
function goImplementsEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  const methodNameSet = (id: string): Set<string> =>
    new Set(
      queries
        .getOutgoingEdges(id, ['contains'])
        .map((e) => queries.getNodeById(e.target))
        .filter((n): n is Node => !!n && n.kind === 'method')
        .map((n) => n.name),
    );

  const goStructs = queries.getNodesByKind('struct').filter((s) => s.language === 'go');
  const structMethods = new Map<string, Set<string>>();
  for (const s of goStructs) structMethods.set(s.id, methodNameSet(s.id));

  for (const iface of queries.getNodesByKind('interface')) {
    if (iface.language !== 'go') continue;
    const want = methodNameSet(iface.id);
    if (want.size === 0) continue; // 空接口（`any`）——会匹配所有内容
    let added = 0;
    for (const s of goStructs) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      const have = structMethods.get(s.id);
      if (!have || have.size < want.size) continue;
      let all = true;
      for (const m of want) {
        if (!have.has(m)) { all = false; break; }
      }
      if (!all) continue;
      const key = `${s.id}>${iface.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: s.id,
        target: iface.id,
        kind: 'implements',
        line: s.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'go-implements', via: iface.name, registeredAt: `${s.filePath}:${s.startLine}` },
      });
      added++;
    }
  }
  return edges;
}

/**
 * 跨文件 Go 方法 → 接收者类型 `contains` 边。Go 中一个类型的方法
 * 通常声明在与 `type` 声明不同的文件中（`user.go` 中的
 * `type User struct{…}`，`user_store.go` 中的 `func (u *User) Save()`）。
 * 提取时仅在接收者类型与方法在同一文件时才附加 struct→method 的 `contains` 边——
 * `tree-sitter.ts` 中的所有者查找仅在当前被解析的文件内有效——
 * 因此跨文件方法与其类型是孤立的（它仍被所在文件 `contains`，只是不被其 struct）。
 * 这会破坏 `synapse_node` 的成员列表、所有经过类型 `contains` 边的
 * callers/callees/impact 遍历，以及 {@link goImplementsEdges} 的方法集计算
 * （后者从同一批边推导 struct 的方法集，因此会少计跨文件 struct 满足的接口）。
 *
 * Go 保证方法的接收者类型与方法声明在同一包（即同一目录）中——
 * 因此这是确定性的结构链接，而非启发式：在方法所在目录中找到同名类型，
 * 补充缺失的 `contains` 边（不设 `provenance: 'heuristic'`，
 * 与提取已产生的同文件边保持一致）。跳过已有类型父节点的方法（同文件情况）。
 * （#583，跨文件部分）
 */
function goCrossFileMethodContainsEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const TYPE_KINDS = new Set<NodeKind>(['struct', 'class', 'interface', 'enum', 'type_alias']);
  const dirOf = (p: string): string => {
    const i = p.replace(/\\/g, '/').lastIndexOf('/');
    return i >= 0 ? p.slice(0, i) : '';
  };

  for (const method of queries.getNodesByKind('method')) {
    if (method.language !== 'go') continue;
    // 接收者类型被编码在方法的 qualifiedName 中，格式为 `Recv::name`
    // （提取器对接收者方法设置 `${receiverType}::${name}`）。
    const qn = method.qualifiedName;
    if (!qn) continue;
    const sep = qn.lastIndexOf('::');
    if (sep <= 0) continue;
    const receiver = qn.slice(0, sep);
    if (!receiver) continue;

    // 已挂载到其类型（提取时的同文件情况已处理）？
    const hasTypeParent = queries
      .getIncomingEdges(method.id, ['contains'])
      .some((e) => {
        const src = queries.getNodeById(e.source);
        return src != null && TYPE_KINDS.has(src.kind);
      });
    if (hasTypeParent) continue;

    // 在同一目录（= 同一 Go 包）中查找接收者类型。Go 禁止包内出现重复类型名，
    // 因此同名同目录的匹配是无歧义的；限定到目录可避免链接到另一个包中的同名类型。
    const dir = dirOf(method.filePath);
    const owner = queries
      .getNodesByName(receiver)
      .find((n) => n.language === 'go' && TYPE_KINDS.has(n.kind) && dirOf(n.filePath) === dir);
    if (!owner) continue;

    const key = `${owner.id}>${method.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ source: owner.id, target: method.id, kind: 'contains', line: method.startLine });
  }
  return edges;
}

/**
 * Kotlin Multiplatform `expect`/`actual`链接。`common` 源集声明
 * `expect fun foo()` / `expect class Bar`；每个平台源集（jvm、native、
 * js 等）在不同文件中提供具有完全相同全限定名的 `actual` 实现。
 * common 代码中的调用方解析到 `expect` 声明，因此每个 `actual` 实现
 * 都没有依赖方——即便修改它可能破坏 API 的每个调用者，
 * 在 impact/affected 中也是不可见的。
 *
 * 从 common 声明到每个平台 `actual` 合成 `calls` 边
 * （镜像接口-实现桥接：抽象 → 具体），使修改平台实现时能暴露
 * common `expect` 及其调用者，实现文件也能参与图的遍历。
 *
 * `expect`/`actual` 在提取时被记录到节点的 `decorators` 列表中
 * （kotlin.ts 的 `extractModifiers`）。`expect class` 的成员本身
 * 不带关键字标记，因此声明端匹配为具有相同 FQN、相同 kind 且
 * 未标记 `actual` 的节点。要求对端标记 `actual` 同时也能排除
 * 普通跨文件重载（两端均未标记）。
 */
// `expect`/`actual` 对合法跨越的类型。`expect class` 通常由
// `actual typealias` 实现（如 `actual typealias CancellationException = …`、
// `actual typealias SchedulerTask = Task`），严格 kind 匹配会遗漏
// 这些单行别名文件。同 FQN + `actual` 标记已足以排除无关符号，
// 因此扩展到类型类 kind 是安全的。
const KMP_TYPE_KINDS = new Set(['class', 'interface', 'struct', 'enum', 'type_alias']);
function kmpKindsCompatible(a: string, b: string): boolean {
  return a === b || (KMP_TYPE_KINDS.has(a) && KMP_TYPE_KINDS.has(b));
}

function kotlinExpectActualEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const actuals = queries
    .getAllNodes()
    .filter((n) => n.language === 'kotlin' && !!n.decorators?.includes('actual'));
  for (const act of actuals) {
    let added = 0;
    for (const cand of queries.getNodesByQualifiedNameExact(act.qualifiedName)) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      // 声明端：相同 FQN + 兼容 kind，不同文件，且本身不是 `actual`
      // （否则就是同级平台实现，而非声明）。
      if (cand.language !== 'kotlin' || cand.id === act.id) continue;
      if (!kmpKindsCompatible(cand.kind, act.kind) || cand.filePath === act.filePath) continue;
      if (cand.decorators?.includes('actual')) continue;
      const key = `${cand.id}>${act.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: cand.id,
        target: act.id,
        kind: 'calls',
        line: cand.startLine,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'kotlin-expect-actual',
          via: act.name,
          registeredAt: `${act.filePath}:${act.startLine}`,
        },
      });
      added++;
    }
  }
  return edges;
}

function interfaceOverrideEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const methodsOf = (classId: string): Node[] =>
    queries
      .getOutgoingEdges(classId, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
  // 具体端 kind 因语言而异：`class` 涵盖 Java / Kotlin /
  // C# / TypeScript / Swift 类 / Scala 类；`struct` 涵盖遵循协议的
  // Swift 值类型。两种都要遍历。
  const concreteKinds = ['class', 'struct'] as const;
  for (const kind of concreteKinds) {
  for (const cls of queries.getNodesByKind(kind)) {
    const implMethods = methodsOf(cls.id).filter((n) => IFACE_OVERRIDE_LANGS.has(n.language));
    if (implMethods.length === 0) continue;
    for (const sup of queries.getOutgoingEdges(cls.id, ['implements', 'extends'])) {
      const base = queries.getNodeById(sup.target);
      if (!base || !IFACE_OVERRIDE_LANGS.has(base.language) || base.id === cls.id) continue;
      // 按名称将实现方法分组以处理重载：接口的 `list()` 和
      // `list(params)` 是不同节点，调用可能解析到任意一个，
      // 因此将每个基类重载链接到所有同名实现重载
      // （仅按名称键入会丢弃除一个之外的所有重载，遗漏已解析的那个）。
      const implByName = new Map<string, Node[]>();
      for (const m of implMethods) {
        const arr = implByName.get(m.name);
        if (arr) arr.push(m); else implByName.set(m.name, [m]);
      }
      let added = 0;
      for (const bm of methodsOf(base.id)) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
        for (const m of implByName.get(bm.name) ?? []) {
          if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
          if (bm.id === m.id) continue;
          const key = `${bm.id}>${m.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            source: bm.id,
            target: m.id,
            kind: 'calls',
            line: bm.startLine,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'interface-impl', via: m.name, registeredAt: `${m.filePath}:${m.startLine}` },
          });
          added++;
        }
      }
    }
  }
  }
  return edges;
}

/**
 * Go gRPC 桩代码 → 实现桥接。protoc-gen-go-grpc 代码生成器在
 * `*_grpc.pb.go` 中生成 `UnimplementedXxxServer` struct，每个服务 RPC
 * 对应一个方法；真正的处理器是另一个文件中手写的 struct
 * （如 cosmos-sdk 中的 `x/bank/keeper/msg_server.go::msgServer.Send`）。
 * Go 的结构性类型意味着我们的解析器没有可跟随的 `implements` 边，
 * 因此 `trace("Send","SendCoins")` 会落到空桩上并报告"无路径"
 * （已实证验证——这正是推动本工作的 cosmos Q1 r1 trace 失败）。
 *
 * 桥接：对每个 RPC 方法名是某个其他 Go struct 方法名子集的
 * `UnimplementedXxxServer`，产生 `calls` 边 `桩.method → 实现.method`
 * （按名称配对）。排除 gRPC 内部标记方法 `mustEmbedUnimplementedXxxServer`
 * 和 `testEmbeddedByValue`，并跳过自身在生成文件中的候选实现
 * （否则 `xxxClient` / 同级桩会被误判为实现）。
 *
 * 允许多个候选实现，上限为 MAX_CALLBACKS_PER_CHANNEL——
 * 一个服务通常同时有生产实现和一个或多个测试 mock；
 * 全部链接可保留 trace 的实用性，而不会错误偏袒某一个。
 *
 * 出处：`heuristic`，`synthesizedBy: 'go-grpc-stub-impl'`。
 * 桩的源码行是 trace 追踪路径中显示的连线点。
 */
function goGrpcStubImplEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  const STUB_RE = /^Unimplemented.*Server$/;
  // gRPC 每个 Unimplemented*Server 上都存在的内部辅助方法；
  // 不属于服务契约，因此在计算用于匹配实现的 RPC 方法签名时排除。
  const isInternalMarker = (n: string) => n.startsWith('mustEmbed') || n === 'testEmbeddedByValue';

  // 每个 Go struct 直接包含的方法，仅记录名称。构建一次。
  const methodNamesByStruct = new Map<string, Set<string>>();
  const methodNodesByStruct = new Map<string, Node[]>();
  const goStructs: Node[] = [];
  for (const s of queries.getNodesByKind('struct')) {
    if (s.language !== 'go') continue;
    goStructs.push(s);
    const ms = queries
      .getOutgoingEdges(s.id, ['contains'])
      .map((e) => queries.getNodeById(e.target))
      .filter((n): n is Node => !!n && n.kind === 'method');
    methodNodesByStruct.set(s.id, ms);
    methodNamesByStruct.set(s.id, new Set(ms.map((m) => m.name)));
  }

  for (const stub of goStructs) {
    if (!STUB_RE.test(stub.name)) continue;
    // 桩必须位于生成文件中——这才能说明它是 protoc 生成的脚手架，
    // 而非有人手写了名为 `UnimplementedXxxServer` 的 struct。
    // 没有此门控，我们也会桥接此类手写 struct，产生误导性的边。
    if (!isGeneratedFile(stub.filePath)) continue;

    const stubMethods = (methodNodesByStruct.get(stub.id) ?? []).filter(
      (m) => !isInternalMarker(m.name),
    );
    if (stubMethods.length === 0) continue;
    const stubMethodNames = stubMethods.map((m) => m.name);

    for (const cand of goStructs) {
      if (cand.id === stub.id) continue;
      // 跳过生成文件中的候选实现——它们是同级文件（msgClient、
      // UnsafeMsgServer 等），其方法集恰好与桩匹配。
      if (isGeneratedFile(cand.filePath)) continue;

      const candNames = methodNamesByStruct.get(cand.id);
      if (!candNames) continue;
      // 子集：每个 RPC 方法必须按名称存在于候选实现中。
      // 签名级匹配可进一步收紧，但仅名称匹配在真实代码库中
      // 已能实现一对一配对，因为 gRPC 方法名集合极具辨识度
      // （Send + MultiSend + UpdateParams + SetSendEnabled 唯一标识 bank 的 MsgServer）。
      if (!stubMethodNames.every((n) => candNames.has(n))) continue;

      const candMethods = methodNodesByStruct.get(cand.id) ?? [];
      let added = 0;
      for (const sm of stubMethods) {
        if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
        for (const cm of candMethods) {
          if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
          if (cm.name !== sm.name) continue;
          const key = `${sm.id}>${cm.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            source: sm.id,
            target: cm.id,
            kind: 'calls',
            line: sm.startLine,
            provenance: 'heuristic',
            metadata: {
              synthesizedBy: 'go-grpc-stub-impl',
              via: cm.name,
              registeredAt: `${cm.filePath}:${cm.startLine}`,
            },
          });
          added++;
        }
      }
    }
  }
  return edges;
}

/**
 * 第 5 阶段：React JSX 子组件渲染。返回 `<Child .../>` 的组件
 * 会挂载 Child——React 负责调用——但 JSX 实例化不是静态调用边，
 * 因此渲染树（App.render → StaticCanvas → renderStaticScene）会在
 * JSX 跳转处断裂。将父组件链接到其渲染的每个大写 JSX 子组件。
 * 以文件为单位处理（每个 JSX 文件读取一次）。精度门控：子组件名必须
 * 解析到 component/function/class 节点——TypeScript 泛型如 `Array<Foo>`
 * 会解析到类型（或空），被丢弃。
 */
function reactJsxChildEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const PARENT_KINDS = new Set(['method', 'function', 'component']);
  for (const file of ctx.getAllFiles()) {
    const content = ctx.readFile(file);
    if (!content || (!content.includes('</') && !content.includes('/>'))) continue; // JSX-file gate
    const parents = ctx.getNodesInFile(file).filter((n) => PARENT_KINDS.has(n.kind));
    for (const parent of parents) {
      const src = sliceLines(content, parent.startLine, parent.endLine);
      if (!src || (!src.includes('</') && !src.includes('/>'))) continue;
      const names = new Set<string>();
      JSX_TAG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = JSX_TAG_RE.exec(src))) names.add(m[1]!);
      let added = 0;
      for (const name of names) {
        if (added >= MAX_JSX_CHILDREN) break;
        const child = ctx.getNodesByName(name).find(
          (n) => n.kind === 'component' || n.kind === 'function' || n.kind === 'class'
        );
        if (!child || child.id === parent.id) continue;
        const key = `${parent.id}>${child.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: parent.id, target: child.id, kind: 'calls', line: parent.startLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'jsx-render', via: name },
        });
        added++;
      }
    }
  }
  return edges;
}

/**
 * 第 6 阶段：Vue SFC 模板。`.vue` 提取器仅解析 `<script>`，因此
 * 模板中的用法是不可见的——只在模板中使用的子组件和事件处理器
 * 与它们之间没有边。PascalCase 子组件（`<VPNav/>`）已由
 * reactJsxChildEdges 捕获（扫描 SFC 组件节点），因此这里补充
 * 两种 Vue 特有形态：
 *   - kebab-case 子组件：`<el-button>` → `ElButton` 组件（渲染关系）。
 *   - 事件绑定：`@click="onClick"` / `v-on:submit="save"` → 处理器方法。
 * 范围限定在 `.vue` 文件的 `<template>` 块；通过解析门控（kebab→
 * 组件，处理器→function/method）保持精度；内联箭头函数 / `$emit` 跳过。
 */
function vueTemplateEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const COMPONENT_KINDS = new Set(['component', 'function', 'class']);
  const HANDLER_KINDS = new Set(['method', 'function']);
  // 组合式函数的返回成员可以是函数（`function close(){}`）或
  // 赋值给 const 的箭头函数（`const close = () => {}`）。
  const RETURN_KINDS = new Set(['method', 'function', 'variable', 'constant']);
  // Nuxt 按目录前缀名自动导入嵌套组件——
  // `components/media/Card.vue` 用作 `<MediaCard/>`，而非 `<Card/>`——
  // 但组件节点以 basename（`Card`）命名，直接标签匹配会遗漏它
  // （平铺组件按 basename 匹配，无需此处理）。将每个嵌套组件的
  // Nuxt 名称映射到节点，以便模板中的用法能够正确解析。
  const nuxtComponents = new Map<string, Node>();
  for (const c of ctx.getNodesByKind('component')) {
    const nn = nuxtComponentName(c.filePath);
    if (nn && !nuxtComponents.has(nn)) nuxtComponents.set(nn, c);
  }
  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.vue')) continue;
    const content = ctx.readFile(file);
    const tpl = content && content.match(/<template[^>]*>([\s\S]*)<\/template>/i)?.[1];
    if (!tpl) continue;
    const comp = ctx.getNodesInFile(file).find((n) => n.kind === 'component');
    if (!comp) continue;

    // 组合式函数解构映射：alias → { composable, key }。用于解析
    // 模板中非局部函数、而是解构组合式函数返回值的处理器
    // （`@click="closeSidebar"` ← `const { close: closeSidebar } = useSidebarControl()`）。
    const script = content.match(/<script[^>]*>([\s\S]*?)<\/script>/i)?.[1] ?? '';
    const destructured = new Map<string, { composable: string; key: string }>();
    VUE_DESTRUCTURE_RE.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = VUE_DESTRUCTURE_RE.exec(script))) {
      if (!/^use[A-Z]/.test(dm[2]!)) continue; // 仅限组合式函数 / hooks
      for (const part of dm[1]!.split(',')) {
        const pm = part.trim().match(/^(\w+)\s*(?::\s*(\w+))?$/); // key | key: alias
        if (pm) destructured.set(pm[2] || pm[1]!, { composable: dm[2]!, key: pm[1]! });
      }
    }

    let added = 0;
    const addEdge = (target: Node | undefined, meta: Record<string, unknown>) => {
      if (added >= MAX_JSX_CHILDREN || !target || target.id === comp.id) return;
      const k = `${comp.id}>${target.id}>${meta.synthesizedBy}`;
      if (seen.has(k)) return;
      seen.add(k);
      edges.push({ source: comp.id, target: target.id, kind: 'calls', line: comp.startLine, provenance: 'heuristic', metadata: meta });
      added++;
    };
    // 优先选取当前 SFC 中的目标（处理器位于同文件的 script 中）——
    // 避免在 monorepo 中同名重复时发生跨文件错误匹配。
    const resolve = (name: string, kinds: Set<string>): Node | undefined => {
      const matches = ctx.getNodesByName(name).filter((n) => kinds.has(n.kind));
      return matches.find((n) => n.filePath === file) ?? matches[0];
    };

    let m: RegExpExecArray | null;
    VUE_KEBAB_RE.lastIndex = 0;
    while ((m = VUE_KEBAB_RE.exec(tpl))) {
      const tag = kebabToPascal(m[1]!);
      addEdge(resolve(tag, COMPONENT_KINDS) ?? nuxtComponents.get(tag), { synthesizedBy: 'jsx-render', via: m[1] });
    }
    // PascalCase 组件标签。先尝试直接名称匹配（平铺组件和显式注册），
    // 再尝试 Nuxt 目录前缀自动导入名（`<MediaCard>` → components/media/Card.vue）。
    // 内置组件两者均不匹配 → 不产生边。
    VUE_PASCAL_RE.lastIndex = 0;
    while ((m = VUE_PASCAL_RE.exec(tpl))) {
      const tag = m[1]!;
      addEdge(resolve(tag, COMPONENT_KINDS) ?? nuxtComponents.get(tag), { synthesizedBy: 'jsx-render', via: tag });
    }
    VUE_HANDLER_RE.lastIndex = 0;
    while ((m = VUE_HANDLER_RE.exec(tpl))) {
      const event = m[1]!;
      const expr = m[2]!.trim();
      if (expr.includes('=>') || expr.startsWith('$')) continue; // 内联箭头函数 / $emit
      const name = expr.match(/^([A-Za-z_]\w*)/)?.[1];
      if (!name) continue;
      const direct = resolve(name, HANDLER_KINDS);
      if (direct) { addEdge(direct, { synthesizedBy: 'vue-handler', event }); continue; }
      // 组合式函数解构处理器 → 解析到该组合式函数的返回函数。
      const d = destructured.get(name);
      if (!d) continue;
      const composable = resolve(d.composable, HANDLER_KINDS);
      // 解析到组合式函数文件中定义的特定返回成员（如 `close`）。
      // 不回退到组合式函数本身——组件已有静态的 `useX()` 调用边，
      // 那样只会造成冗余且精度更低。
      const keyFn = composable
        ? ctx.getNodesByName(d.key).find((n) => RETURN_KINDS.has(n.kind) && n.filePath === composable.filePath)
        : undefined;
      if (keyFn) addEdge(keyFn, { synthesizedBy: 'vue-handler', event, via: d.composable });
    }
  }
  return edges;
}

/**
 * React Native 跨语言事件通道（混合 iOS/RN 桥接工作的第 3 阶段）。
 * 与 `eventEmitterEdges` 形态相同，但跨语言：
 *
 *   原生端（ObjC，在 RCTEventEmitter 子类中）：
 *     [self sendEventWithName:@"locationUpdate" body:@{...}];
 *
 *   原生端（Java/Kotlin，通过 JS 模块分发器）：
 *     emitter.emit("locationUpdate", body);
 *     reactContext.getJSModule(RCTDeviceEventEmitter.class).emit("locationUpdate", body);
 *
 *   JS 端（订阅方）：
 *     new NativeEventEmitter(NativeModules.Geo).addListener("locationUpdate", handler);
 *     DeviceEventEmitter.addListener("locationUpdate", handler);
 *
 * 合成：原生分发点 → JS 处理器，以字面事件名为键。
 * 仅匹配具名处理器（现有 `ON_RE` 具名捕获形式）。
 * 内联箭头处理器如 `addListener('x', d => …)` 在提取时未命名，
 * 需要链式传递体支持；与同语言合成器的刻意范围保持一致。
 *
 * 出处 `'heuristic'`，synthesizedBy `'rn-event-channel'`。
 */
// ObjC 的 `[self sendEventWithName:@"X" body:...]` 形态（括号语法，
// `@` 字符串字面量）。
const RN_OBJC_SEND_RE = /\bsendEventWithName\s*:\s*@"([^"]+)"/g;
// Swift 的 `sendEvent(withName: "X", body: ...)` 形态——与 ObjC 相同的
// RCTEventEmitter 方法，但调用语法不同。ObjC 和 Swift 都继承
// RCTEventEmitter，因此这捕获了 Swift 端等效的发送点
// （如 RNFusedLocation.swift 的 `sendEvent(withName: "geolocationDidChange",
// body: locationData)`）。
const RN_SWIFT_SEND_RE = /\bsendEvent\s*\(\s*withName\s*:\s*"([^"]+)"/g;
// JVM 端发送调用：`emitter.emit("X", body)`。Java 和 Kotlin 语法相同，
// 因此同一正则均可匹配。在消费处限定为 JVM 源文件，
// 以免重复处理 JS 端的 emit（已由 `eventEmitterEdges` 处理）。
const RN_JVM_EMIT_RE = /\.emit\s*\(\s*"([^"]+)"\s*,/g;
// 自定义 `sendEvent(reactContext, "X", body)` 包装器——极为常见
// （react-native-device-info 及众多库将 `DeviceEventManagerModule…emit`
// 封装在一个辅助函数后面，该函数的 `.emit(eventName, …)` 使用变量，
// 因此 RN_JVM_EMIT_RE 无法匹配；字面量位于包装调用处）。
// 捕获 `sendEvent(...)` 调用内的第一个字符串字面量。`[^;{}]*?` 限定在
// 单条语句范围内并在块边界处停止，因此包装函数定义（其 `(` 后跟
// `… ) {`）永远不会匹配。支持多行。（java/kotlin/swift）
const RN_NATIVE_SENDEVENT_RE = /\bsendEvent\s*\([^;{}]*?"([^"]+)"/g;

function rnEventEdges(ctx: ResolutionContext): Edge[] {
  // 原生分发器（source = 发送事件的原生方法）和 JS 处理器
  // （target = 注册为监听器的函数/方法），以事件名为键。
  const nativeDispatchersByEvent = new Map<string, Set<string>>();
  const jsHandlersByEvent = new Map<string, Map<string, string>>();

  for (const file of ctx.getAllFiles()) {
    const content = ctx.readFile(file);
    if (!content) continue;

    const nodesInFile = ctx.getNodesInFile(file);
    const lineOf = (idx: number) => content.slice(0, idx).split('\n').length;
    const addDispatcher = (event: string, line: number) => {
      const disp = enclosingFn(nodesInFile, line);
      if (!disp) return;
      const set = nativeDispatchersByEvent.get(event) ?? new Set<string>();
      set.add(disp.id);
      nativeDispatchersByEvent.set(event, set);
    };

    // ObjC 端：`sendEventWithName:@"X"` 仅在 `.m`/`.mm` 文件中触发
    // （RCTEventEmitter 子类）。
    if (file.endsWith('.m') || file.endsWith('.mm')) {
      RN_OBJC_SEND_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RN_OBJC_SEND_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
    }

    // Swift 端：相同的 RCTEventEmitter 方法，圆括号/具名参数语法。
    if (file.endsWith('.swift')) {
      RN_SWIFT_SEND_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = RN_SWIFT_SEND_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
      RN_NATIVE_SENDEVENT_RE.lastIndex = 0;
      while ((m = RN_NATIVE_SENDEVENT_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
    }

    // JVM 端：Java/Kotlin 中的 `.emit("X", …)`，以及常见的
    // `sendEvent(ctx, "X", body)` 包装器。（我们在文件任意位置进行模式匹配；
    // JS 同语言路径使用独立的发送器对象模式，已由 eventEmitterEdges 处理。）
    if (file.endsWith('.java') || file.endsWith('.kt')) {
      let m: RegExpExecArray | null;
      RN_JVM_EMIT_RE.lastIndex = 0;
      while ((m = RN_JVM_EMIT_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
      RN_NATIVE_SENDEVENT_RE.lastIndex = 0;
      while ((m = RN_NATIVE_SENDEVENT_RE.exec(content))) {
        if (m[1]) addDispatcher(m[1], lineOf(m.index));
      }
    }

    // JS 订阅方（.addListener("X", handler)）。限定为 JS 系列文件，
    // 以防原生文件中的 `addListener:`（ObjC 方法）被误认为
    // JS 订阅——尽管名称相同，但它们是完全不同的东西。
    if (
      file.endsWith('.js') ||
      file.endsWith('.jsx') ||
      file.endsWith('.ts') ||
      file.endsWith('.tsx') ||
      file.endsWith('.mjs') ||
      file.endsWith('.cjs')
    ) {
      // 同时匹配具名处理器形式（`.addListener('x', fn)`）和
      // 未命名处理器形式（`.addListener('x', listener)`，其中
      // `listener` 是参数——在 RNFirebase 的
      // `messaging().onMessageReceived(listener)` 等 RN 包装 API 中很常见）。
      // 对于未命名情况，将订阅归属到外层 JS 函数（抽象层），
      // 即便实际的用户侧处理器在调用链上更高一层，也能给出可达性正确的跳转。
      const ADDLISTENER_ANY = /\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_][\w.]*)/g;
      ADDLISTENER_ANY.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ADDLISTENER_ANY.exec(content))) {
        const event = m[1];
        const arg = m[2];
        if (!event || !arg) continue;
        const bareName = arg.includes('.') ? arg.slice(arg.lastIndexOf('.') + 1) : arg;
        // 先尝试具名符号匹配（与同语言语义一致）。
        const namedHandler = ctx
          .getNodesByName(bareName)
          .find((n) => n.kind === 'function' || n.kind === 'method');
        let targetId: string | null = namedHandler?.id ?? null;
        if (!targetId) {
          // 回退到外层函数——订阅包装器模式意味着事件在到达用户代码
          // 的途中会经过该函数。可达性正确的归因。
          const enclosing = enclosingFn(nodesInFile, lineOf(m.index));
          targetId = enclosing?.id ?? null;
        }
        if (!targetId) {
          // JS 对象字面量 API 形态的更宽泛回退
          // （`const Foo = { watchX(...) { … addListener(...) … } }`）：
          // 对象字面量中的方法简写不会被提取为方法节点，因此
          // enclosingFn 返回 null。归属到最小的外层 `constant` / `variable` 节点——
          // 那是下游调用者会 `import` 并调用的 API 表面。可达性正确。
          const line = lineOf(m.index);
          let smallest: typeof nodesInFile[number] | null = null;
          for (const n of nodesInFile) {
            if (n.kind !== 'constant' && n.kind !== 'variable') continue;
            const end = n.endLine ?? n.startLine;
            if (n.startLine <= line && end >= line) {
              if (!smallest || n.startLine >= smallest.startLine) smallest = n;
            }
          }
          targetId = smallest?.id ?? null;
        }
        if (!targetId) continue;
        const map = jsHandlersByEvent.get(event) ?? new Map<string, string>();
        map.set(targetId, `${file}:${lineOf(m.index)}`);
        jsHandlersByEvent.set(event, map);
      }
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [event, dispatchers] of nativeDispatchersByEvent) {
    const handlers = jsHandlersByEvent.get(event);
    if (!handlers) continue;
    // 与同语言通道相同的扇出保护：泛型事件名（如 'change'、'error'、'data'）
    // 若有大量处理器/分发器，在缺乏接收者类型信息的情况下无法精确匹配。
    if (dispatchers.size > EVENT_FANOUT_CAP || handlers.size > EVENT_FANOUT_CAP) continue;
    for (const d of dispatchers) {
      for (const [h, registeredAt] of handlers) {
        if (d === h) continue;
        const key = `${d}>${h}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: d,
          target: h,
          kind: 'calls',
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'rn-event-channel', event, registeredAt },
        });
      }
    }
  }
  return edges;
}

/**
 * 第 6 阶段——React Native Fabric/Codegen 视图组件桥接。
 *
 * Fabric 框架提取器（`frameworks/fabric.ts`）从每个
 * `codegenNativeComponent<Props>('Name')` 规范声明中，
 * 生成以 JS 可见组件命名的 `component` 节点（如 `RNSScreenStack`）。
 * 原生实现位于 ObjC++/.mm 或 Kotlin/Java 类中，
 * 命名遵循 RN 的以下约定之一：
 *
 *   - 精确匹配：`RNSScreenStack`
 *   - 带后缀：`RNSScreenStackView`、`RNSScreenStackViewManager`、
 *     `RNSScreenStackComponentView`、`RNSScreenStackManager`
 *
 * 本合成器遍历所有 Fabric 组件节点，查找匹配上述名称之一的
 * 原生类；找到后，产生 `calls` 边 `component → native class`
 * （出处 `'heuristic'`，`synthesizedBy:'fabric-native-impl'`），
 * 使从 JSX 使用点对该组件的 trace 能够继续进入原生代码。
 *
 * 基于约定的后缀查找是精确的：RN 视图管理器代码库在设计上不存在
 * 命名冲突（否则 Codegen 输出也会冲突）。
 */
const FABRIC_NATIVE_SUFFIXES = ['', 'View', 'ViewManager', 'ComponentView', 'Manager'];

/**
 * Expo 模块跨平台配对。一个 Expo 模块从 iOS（Swift）和 Android（Kotlin）
 * 两端暴露相同的 JS 可见方法（`AsyncFunction("getBatteryLevelAsync")`）。
 * JS 调用点只能名称解析到其中一个平台的实现，因此另一个平台的实现
 * 看起来没有任何调用方（修改它也不显示影响半径）。
 * 将同一 `<module>.<method>` 的 iOS 和 Android 实现双向相互链接，
 * 使到达一个平台的 JS 调用也能到达另一个平台，修改任意一侧都能暴露 JS 调用方。
 * Expo 方法节点以 `expo-module:` 为 id 前缀，
 * 由框架提取器限定为 `<file>::<module>.<method>`。
 */
function expoCrossPlatformEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const byKey = new Map<string, Node[]>();
  for (const m of queries.getNodesByKind('method')) {
    if (!m.id.startsWith('expo-module:')) continue;
    const key = m.qualifiedName.split('::').pop(); // `<module>.<method>`
    if (!key) continue;
    const arr = byKey.get(key);
    if (arr) arr.push(m);
    else byKey.set(key, [m]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const a of group) {
      for (const b of group) {
        if (a.id === b.id || a.language === b.language) continue; // 仅跨平台
        const key = `${a.id}>${b.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: a.id,
          target: b.id,
          kind: 'calls',
          line: a.startLine,
          provenance: 'heuristic',
          metadata: { synthesizedBy: 'expo-cross-platform', via: a.name },
        });
      }
    }
  }
  return edges;
}

/**
 * 经典 React Native NativeModules 跨平台配对。原生模块方法
 * （Android 上的 `@ReactMethod`，iOS 上的 `RCT_EXPORT_METHOD`）
 * 在两个平台上均有实现，但 JS 调用点只能名称解析到其中一个——
 * 因此另一个平台的实现看起来没有任何调用方。
 * 有 JS 调用方的原生方法是已确认的桥接方法；将其链接到另一种语言中
 * 同名的原生方法（另一个平台的实现），使到达一个平台的 JS 调用
 * 也能到达另一个平台，修改任意一侧都能暴露 JS 调用方。
 *
 * 名称规范化为第一个选择器关键字（`getFreeDiskStorage:` →
 * `getFreeDiskStorage`）——那是 JS 可见名称，也是 iOS 选择器与
 * Android 裸方法名的对应方式。
 */
function rnCrossPlatformEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const NATIVE = new Set(['java', 'kotlin', 'objc', 'cpp']);
  const JS = new Set(['typescript', 'tsx', 'javascript', 'jsx']);
  // RN 模块基础设施方法存在于每个原生模块上（由 RN 运行时调用，而非用户 JS），
  // 因此按名称配对会在多模块仓库中将无关模块交叉链接。跳过它们——这些不是面向用户的方法。
  const RN_INFRA = new Set([
    'addListener', 'removeListeners', 'getConstants', 'constantsToExport', 'getName',
    'invalidate', 'initialize', 'getDefaultEventTypes', 'supportedEvents',
    'requiresMainQueueSetup', 'methodQueue',
  ]);
  const norm = (name: string): string => {
    const i = name.indexOf(':');
    return i >= 0 ? name.slice(0, i) : name;
  };

  // 按 JS 可见（规范化后的）名称索引原生方法。只有在 ≥2 种原生语言中
  // 均有实现的名称才能配对，因此下方的每方法 JS 调用方检查
  // 仅对真正的跨平台候选项运行。
  const byName = new Map<string, Node[]>();
  for (const m of queries.iterateNodesByKind('method')) {
    if (!NATIVE.has(m.language)) continue;
    const key = norm(m.name);
    const arr = byName.get(key);
    if (arr) arr.push(m);
    else byName.set(key, [m]);
  }

  for (const [groupName, group] of byName) {
    if (RN_INFRA.has(groupName)) continue;
    const langs = new Set(group.map((m) => m.language));
    if (langs.size < 2) continue; // 单平台——无需配对
    for (const m of group) {
      // m 是桥接方法吗？（有 JS 语言的 `calls` 边指向它）
      const incoming = queries.getIncomingEdges(m.id, ['calls']);
      if (incoming.length === 0) continue;
      const sources = queries.getNodesByIds(incoming.map((e) => e.source));
      const isBridge = incoming.some((e) => {
        const s = sources.get(e.source);
        return !!s && JS.has(s.language);
      });
      if (!isBridge) continue;
      // 链接到其他平台的实现（双向）。
      for (const sib of group) {
        if (sib.id === m.id || sib.language === m.language) continue;
        for (const [a, b] of [[m, sib], [sib, m]] as const) {
          const key = `${a.id}>${b.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({
            source: a.id,
            target: b.id,
            kind: 'calls',
            line: a.startLine,
            provenance: 'heuristic',
            metadata: { synthesizedBy: 'rn-cross-platform', via: norm(m.name) },
          });
        }
      }
    }
  }
  return edges;
}

function fabricNativeImplEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();

  // Fabric 提取器的 ID 以 `fabric-component:` 为前缀，因此
  // 无需遍历所有 `component` 节点即可筛选出目标。
  const components = ctx.getNodesByKind('component').filter((n) => n.id.startsWith('fabric-component:'));
  if (components.length === 0) return edges;

  // 按名称预索引原生类，以实现 O(1) 查找。
  const nativeClassesByName = new Map<string, Node[]>();
  for (const n of ctx.getNodesByKind('class')) {
    if (n.language !== 'objc' && n.language !== 'kotlin' && n.language !== 'java' && n.language !== 'cpp') continue;
    const arr = nativeClassesByName.get(n.name);
    if (arr) arr.push(n);
    else nativeClassesByName.set(n.name, [n]);
  }

  for (const component of components) {
    for (const suffix of FABRIC_NATIVE_SUFFIXES) {
      const candidate = component.name + suffix;
      const matches = nativeClassesByName.get(candidate);
      if (!matches || matches.length === 0) continue;
      // 将组件节点链接到所有匹配的原生类（iOS + Android 各一个）。
      for (const native of matches) {
        const key = `${component.id}>${native.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: component.id,
          target: native.id,
          kind: 'calls',
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'fabric-native-impl',
            viaSuffix: suffix || '(exact)',
            componentName: component.name,
          },
        });
      }
    }
  }

  return edges;
}

/**
 * MyBatis：将 Java mapper 接口方法链接到持有其 SQL 的 XML 语句。
 * XML 提取器（`src/extraction/mybatis-extractor.ts`）将每条
 * `<select|insert|update|delete|sql id="X">` 限定为 `<namespace>::<id>`，
 * 其中 `<namespace>` 是 mapper 接口的 Java FQN。Java 方法的
 * qualifiedName 以 `<ClassName>::<methodName>` 结尾，因此我们对
 * XML 限定名的最后两段进行后缀匹配，以 `<ClassName>::<methodName>`
 * 找到唯一的 Java 方法（`ClassName` = XML namespace 的最后一个点分段）。
 * 跨 mapper 的 `<include refid="other.X">` 引用通过普通限定名解析器处理——
 * 只有 Java↔XML 桥接是合成的。
 *
 * 精度优先于召回：存在歧义的 mapper（多个同简单名称的 Java 类）被丢弃。
 * 无需按包名桥接，因为 Java mapper 接口在项目中通常具有唯一名称。
 */
function mybatisJavaXmlEdges(queries: QueryBuilder): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  // 按 `<ClassName>::<methodName>` 索引 Java 方法，以实现 O(1) 查找。
  const javaIndex = new Map<string, Node[]>();
  for (const m of queries.iterateNodesByKind('method')) {
    if (m.language !== 'java' && m.language !== 'kotlin') continue;
    const parts = m.qualifiedName.split('::');
    const last = parts[parts.length - 1];
    const cls = parts[parts.length - 2];
    if (!last || !cls) continue;
    const key = `${cls}::${last}`;
    const arr = javaIndex.get(key);
    if (arr) arr.push(m); else javaIndex.set(key, [m]);
  }

  for (const xml of queries.iterateNodesByKind('method')) {
    if (xml.language !== 'xml') continue;
    // 限定名：`<namespace>::<id>`。提取简单类名。
    const colonIdx = xml.qualifiedName.lastIndexOf('::');
    if (colonIdx < 0) continue;
    const namespace = xml.qualifiedName.slice(0, colonIdx);
    const id = xml.qualifiedName.slice(colonIdx + 2);
    if (!namespace || !id) continue;
    const dotIdx = namespace.lastIndexOf('.');
    const className = dotIdx >= 0 ? namespace.slice(dotIdx + 1) : namespace;
    const candidates = javaIndex.get(`${className}::${id}`);
    if (!candidates || candidates.length === 0) continue;
    // 丢弃有歧义的匹配（多个同名类）；用户可在后续增强中
    // 通过添加包名后缀匹配来消歧。
    if (candidates.length > 1) continue;
    const java = candidates[0]!;
    const key = `${java.id}>${xml.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      source: java.id,
      target: xml.id,
      kind: 'calls',
      line: java.startLine,
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'mybatis-java-xml',
        via: `${className}.${id}`,
        registeredAt: `${xml.filePath}:${xml.startLine}`,
      },
    });
  }
  return edges;
}

/**
 * Gin 中间件链。Gin 通过 `(*Context).Next` 中的一行动态代码运行整个处理器链：
 *     for c.index < len(c.handlers) { c.handlers[c.index](c); c.index++ }
 * `c.handlers` 是一个 `HandlersChain`（`[]HandlerFunc`），在注册时由
 * `combineHandlers` 从传入 `r.Use(...)`/`r.GET("/path", h...)`/`r.Handle(...)`
 * 的函数中组装而成。由于调用是对运行时构建的切片进行的计算索引，
 * tree-sitter 将 `c.handlers[c.index](c)` 解析为空——因此 `callees(Next)` 只有
 * `len()` 辅助函数，而"请求如何流经中间件链"这一问题所关注的
 * `ServeHTTP → handleHTTPRequest → Next` 流程恰恰在此中断。
 * 智能体随后重新查询 Next 并回退到 Read/grep（已验证：gin WITH-arm 正是
 * 陷入了这个死胡同）。
 *
 * 桥接：找到链分发器（一个 Go 方法，其方法体通过索引调用 `handlers` 切片），
 * 将其链接到所有通过 gin 注册调用注册的 HandlerFunc，使 `callees(Next)` 和
 * `trace(ServeHTTP, <handler>)` 能够端到端连通。仅处理具名处理器
 * （`gin.Logger()` → `Logger`，`authMiddleware`）；匿名内联闭包跳过。
 * 与 react-render / interface-impl 一样，这是刻意的过度近似——
 * 可达性正确（任何已注册的处理器都可能在某条路由上运行），设有上限，
 * 并以分发器存在为门控，因此在非 gin 的 Go 仓库上永远不会运行。
 * 出处 `heuristic`，`synthesizedBy:'gin-middleware-chain'`；`registeredAt`
 * 是智能体原本需要 grep 查找的 `.Use`/`.GET` 调用点。
 */
const GIN_DISPATCH_RE = /\.handlers\s*\[[^\]]*\]\s*\(/;                 // c.handlers[c.index](c)
const GIN_REG_RE = /\.(?:Use|GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Handle)\s*\(/g;

/** 从 '(' 索引开始的平衡 `(...)` 体；不平衡时返回 null。 */
function goBalancedArgs(s: string, openIdx: number): string | null {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return s.slice(openIdx + 1, i); }
  }
  return null;
}
/** 分割顶层逗号列表，遵循嵌套的 () [] {}。 */
function goSplitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const c of args) {
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; }
    else if (c === ')' || c === ']' || c === '}') { depth--; cur += c; }
    else if (c === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
/** 处理器参数的尾部标识符：`gin.Logger()`→`Logger`，`mw`→`mw`；字符串路径/闭包返回 null。 */
function goHandlerIdent(expr: string): string | null {
  const cleaned = expr.trim().replace(/\(\s*\)$/, '');                  // drop a trailing call ()
  if (!cleaned || cleaned.startsWith('"') || cleaned.startsWith('`') || cleaned.startsWith('func')) return null;
  const m = cleaned.match(/(?:\.|^)([A-Za-z_]\w*)$/);
  return m ? m[1]! : null;
}

function ginMiddlewareChainEdges(queries: QueryBuilder, ctx: ResolutionContext): Edge[] {
  // 1. 找到链分发器：通过索引调用 `handlers` 切片的 Go 方法。
  const dispatchers: Node[] = [];
  for (const n of queries.iterateNodesByKind('method')) {
    if (n.language !== 'go') continue;
    const content = ctx.readFile(n.filePath);
    const src = content && sliceLines(content, n.startLine, n.endLine);
    if (src && GIN_DISPATCH_RE.test(src)) dispatchers.push(n);
  }
  if (dispatchers.length === 0) return [];                              // 非 gin 仓库——退出

  // 2. 收集通过 gin 注册调用（.Use / .GET / … / .Handle）注册的处理器标识符。
  //    字符串参数（路径/方法）和内联闭包由 goHandlerIdent 丢弃；其余均为 HandlerFunc。
  const registered = new Map<string, string>();                         // 名称 → registeredAt（file:line）
  for (const file of ctx.getAllFiles()) {
    if (!file.endsWith('.go')) continue;
    const content = ctx.readFile(file);
    if (!content || (!content.includes('.Use(') && !/\.(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Any|Handle)\(/.test(content))) continue;
    const safe = stripCommentsForRegex(content, 'go');
    GIN_REG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = GIN_REG_RE.exec(safe))) {
      const parenIdx = m.index + m[0].length - 1;
      const argStr = goBalancedArgs(safe, parenIdx);
      if (!argStr) continue;
      const line = safe.slice(0, m.index).split('\n').length;
      for (const arg of goSplitArgs(argStr)) {
        const name = goHandlerIdent(arg);
        if (name && !registered.has(name)) registered.set(name, `${file}:${line}`);
      }
    }
  }
  if (registered.size === 0) return [];

  // 3. 将每个分发器链接到每个已注册的处理器节点（去重，设上限）。
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const disp of dispatchers) {
    let added = 0;
    for (const [name, registeredAt] of registered) {
      if (added >= MAX_CALLBACKS_PER_CHANNEL) break;
      const handler = ctx.getNodesByName(name).find(
        (n) => (n.kind === 'function' || n.kind === 'method') && n.language === 'go'
      );
      if (!handler || handler.id === disp.id) continue;
      const key = `${disp.id}>${handler.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        source: disp.id, target: handler.id, kind: 'calls', line: disp.startLine,
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'gin-middleware-chain', via: name, registeredAt },
      });
      added++;
    }
  }
  return edges;
}

/**
 * Delphi 窗体代码后置：窗体单元 `UFRMAbout.pas` 拥有其可视化窗体定义
 * `UFRMAbout.dfm`（VCL）/ `.fmx`（FireMonkey）——通过同目录下相同
 * basename 配对，由 `{$R *.dfm}` 指令而非 `uses` 子句连接。
 * 将单元链接到其窗体，使仅作为窗体定义使用的 `.dfm`/`.fmx` 不会孤立，
 * 修改窗体时也能暴露其代码后置单元。
 */
function pascalFormEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const allFiles = new Set(ctx.getAllFiles());
  for (const file of allFiles) {
    if (!/\.(dfm|fmx)$/i.test(file)) continue;
    const pasFile = file.replace(/\.(dfm|fmx)$/i, '.pas');
    if (!allFiles.has(pasFile)) continue;
    const formNode = ctx.getNodesInFile(file).find((n) => n.kind === 'file');
    const unitNode = ctx.getNodesInFile(pasFile).find((n) => n.kind === 'file');
    if (!formNode || !unitNode) continue;
    edges.push({
      source: unitNode.id,
      target: formNode.id,
      kind: 'references',
      line: unitNode.startLine,
      provenance: 'heuristic',
      metadata: { synthesizedBy: 'pascal-form', registeredAt: pasFile },
    });
  }
  return edges;
}

/**
 * SvelteKit 文件约定数据流。路由目录下的 `+page.svelte`（一个
 * `component` 节点）从同级的 `+page.server.{ts,js}` / `+page.{ts,js}`
 * 的 `load` 函数接收 `data`，并将表单提交到其 `actions`——
 * 由框架通过文件路径连接，两者之间没有静态导入。因此修改 `load`
 * 不会显示对其所服务页面的影响，页面也看起来没有服务端依赖。
 * 将页面组件链接到同级加载器的 `load` / `actions`（`+layout` 同理）。
 * 配对是路径确定性的（同目录，匹配 `+page`/`+layout` 前缀），因此是精确的——
 * 但这是框架约定边，出处保持 `heuristic`。
 *
 * 方向：page → load，使 `getImpactRadius(load)` 能暴露 page（修改加载器数据时
 * 显示其所服务的页面），page 的依赖项也包含其加载器。
 */
function svelteKitLoadEdges(ctx: ResolutionContext): Edge[] {
  const edges: Edge[] = [];
  const allFiles = new Set(ctx.getAllFiles());
  const HOOKS = new Set(['load', 'actions']);
  const HOOK_KINDS = new Set(['function', 'method', 'constant', 'variable']);
  for (const file of allFiles) {
    const m = file.match(/(.*\/)(\+(?:page|layout))\.svelte$/);
    if (!m) continue;
    const dir = m[1]!;
    const prefix = m[2]!;
    const page = ctx.getNodesInFile(file).find((n) => n.kind === 'component');
    if (!page) continue;
    for (const ext of ['.server.ts', '.server.js', '.ts', '.js']) {
      const loaderFile = `${dir}${prefix}${ext}`;
      if (!allFiles.has(loaderFile)) continue;
      for (const hook of ctx.getNodesInFile(loaderFile)) {
        if (!HOOK_KINDS.has(hook.kind) || !HOOKS.has(hook.name)) continue;
        edges.push({
          source: page.id,
          target: hook.id,
          kind: 'references',
          line: page.startLine,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'sveltekit-load',
            via: hook.name,
            registeredAt: `${loaderFile}:${hook.startLine ?? 0}`,
          },
        });
      }
    }
  }
  return edges;
}

/**
 * 合成分发器→回调边（字段观察者 + EventEmitter + React 重渲染 +
 * JSX 子组件 + Vue 模板 + SvelteKit load + RN 事件通道 +
 * Fabric 原生实现 + MyBatis Java↔XML + Gin 中间件链）。
 * 返回新增的边数量。绝不向索引抛出异常——调用方使用 try/catch 包裹。
 */
export function synthesizeCallbackEdges(queries: QueryBuilder, ctx: ResolutionContext): number {
  // 跨文件 Go 方法→类型 `contains` 边必须首先合成并持久化：
  // 在接收者类型与方法不在同一文件的情况下，方法会与 struct 孤立，
  // 而 goImplementsEdges（下一步）从 `contains` 边推导 struct 的方法集——
  // 若不先处理，它会少计跨文件 struct 满足的接口。（#583）
  const goMethodContains = goCrossFileMethodContainsEdges(queries);
  if (goMethodContains.length > 0) queries.insertEdges(goMethodContains);

  // Go 隐式 `implements` 边必须紧接着合成并持久化：下方的接口分发桥接
  // 从数据库读取 `implements` 边，而 Go 静态提取中没有此类边。
  // （其他语言已在提取时产生静态 implements 边，无需此预处理。）
  const goImpl = goImplementsEdges(queries);
  if (goImpl.length > 0) queries.insertEdges(goImpl);

  const fieldEdges = fieldChannelEdges(queries, ctx);
  const closureCollEdges = closureCollectionEdges(queries, ctx);
  const emitterEdges = eventEmitterEdges(ctx);
  const renderEdges = reactRenderEdges(queries, ctx);
  const jsxEdges = reactJsxChildEdges(ctx);
  const vueEdges = vueTemplateEdges(ctx);
  const svelteKitEdges = svelteKitLoadEdges(ctx);
  const pascalEdges = pascalFormEdges(ctx);
  const flutterEdges = flutterBuildEdges(queries, ctx);
  const cppEdges = cppOverrideEdges(queries);
  const ifaceEdges = interfaceOverrideEdges(queries);
  const kotlinExpectActual = kotlinExpectActualEdges(queries);
  const goGrpcEdges = goGrpcStubImplEdges(queries);
  const rnEventEdgesList = rnEventEdges(ctx);
  const fabricNativeEdges = fabricNativeImplEdges(ctx);
  const expoXPlatEdges = expoCrossPlatformEdges(queries);
  const rnXPlatEdges = rnCrossPlatformEdges(queries);
  const mybatisEdges = mybatisJavaXmlEdges(queries);
  const ginEdges = ginMiddlewareChainEdges(queries, ctx);

  const merged: Edge[] = [];
  const seen = new Set<string>();
  for (const e of [
    ...fieldEdges,
    ...closureCollEdges,
    ...emitterEdges,
    ...renderEdges,
    ...jsxEdges,
    ...vueEdges,
    ...svelteKitEdges,
    ...pascalEdges,
    ...flutterEdges,
    ...cppEdges,
    ...ifaceEdges,
    ...kotlinExpectActual,
    ...goGrpcEdges,
    ...rnEventEdgesList,
    ...fabricNativeEdges,
    ...expoXPlatEdges,
    ...rnXPlatEdges,
    ...mybatisEdges,
    ...ginEdges,
  ]) {
    const key = `${e.source}>${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(e);
  }
  if (merged.length > 0) queries.insertEdges(merged);
  return merged.length + goImpl.length + goMethodContains.length;
}
