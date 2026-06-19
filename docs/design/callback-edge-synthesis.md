# 设计与状态：通用回调 / 观察者边合成

**状态：** 已发布（`callback-synthesizer.ts` 中的合成器已合并到 `main`）。本文记录原始设计。

**动机：** 填补静态提取在观察者 / 事件发射器 / 信号模式中留下的动态分发空洞——在这些模式中，*分发者*通过共享存储调用在其他地方注册的回调——从而让"更新如何到达屏幕"之类的流程真实存在于图中。

> **更新（2026-06-01）：** `synapse_trace` 和 `synapse_context` MCP 工具此后已**移除**——`synapse_explore` 现在是唯一的呈现工具。其"Flow"部分（`buildFlowFromNamedSymbols`）和 `synapse_node` 调用链会呈现这些合成边；下文的 `trace(a, b)` 表示"a→b 流程"，现在通过 `synapse_explore` / `probe-explore.mjs` 验证（`probe-trace.mjs` / `probe-context.mjs` 开发探针随工具一起移除）。

---

## 新会话 TL;DR

我们合成静态解析遗漏的 `dispatcher → callback` 边。效果：

- **字段观察者**（excalidraw `Scene.onUpdate`/`triggerUpdate`）：合成 `triggerUpdate → triggerRender`。`trace(mutateElement, triggerRender)` 现在 = 3 跳。
- **EventEmitter**（express `on('mount', …)`/`emit('mount')`）：合成 `use → onmount`。
- 精度高：excalidraw 在 27k 条边中得到 **1** 条合成边（正确的那条）；Phase 3 后节点数增加 +3（无爆炸）。

**涉及文件（均已合并到 `main`）：**

- `src/resolution/callback-synthesizer.ts` — 全图合成遍历（Phase 1 + 2）。
- `src/resolution/index.ts` — 在 `resolveAndPersistBatched()` 末尾（基础边持久化后）调用 `synthesizeCallbackEdges()` + 导入。
- `src/extraction/tree-sitter.ts` — `visitFunctionBody` 现在提取**具名**嵌套函数（Phase 3），使内联具名处理器成为可链接节点。

**复现 / 测试方法：**

```bash
npm run build
rm -rf /tmp/synapse-corpus/excalidraw/.synapse
( cd /tmp/synapse-corpus/excalidraw && synapse init -i )
# 合成边（provenance='heuristic'，metadata.synthesizedBy 为 callback 或 event-emitter）：
sqlite3 /tmp/synapse-corpus/excalidraw/.synapse/synapse.db \
  "select s.name||' → '||t.name||'  '||coalesce(e.metadata,'') from edges e \
   join nodes s on e.source=s.id join nodes t on e.target=t.id where e.provenance='heuristic';"
# 端到端流程（合成边出现在 explore 的 Flow 部分和节点调用链中）：
node scripts/agent-eval/probe-explore.mjs /tmp/synapse-corpus/excalidraw "triggerUpdate triggerRender"
```

探针脚本（仅供开发，位于 `scripts/agent-eval/`）：`probe-node.mjs`（符号 + 调用链）、`probe-explore.mjs`（相关源码 + 具名符号间的流程）。EventEmitter 固件位于 `/tmp/cb-fixture/bus.js`（临时——请移至 `__tests__/` 或重新创建）。

---

## 空洞所在

```ts
class Scene {
  private callbacks = new Set<Callback>();
  onUpdate(cb: Callback) { this.callbacks.add(cb); }          // 注册者
  triggerUpdate() { for (const cb of this.callbacks) cb(); }  // 分发者
}
this.scene.onUpdate(this.triggerRender);                      // 注册点
```

运行时边 `triggerUpdate → triggerRender` 在静态分析中不存在：`triggerUpdate` 唯一的字面调用是 `cb()`（匿名）。实测：`triggerUpdate` 唯一的被调用者是 `randomInteger`；`trace(triggerUpdate, triggerRender)` 未返回任何路径。

## 为什么是全图遍历，而非 `FrameworkResolver.resolve()`

`resolve(ref)` 回答"这个**具名** ref 指向什么"，一次处理一个 ref。回调边**没有可解析的 ref**（`cb()` 是匿名的），且需要**跨文件、多站点关联**（注册者、注册点、分发者）。因此它是基础解析后的全图遍历，适用于语言级别（任何 OO 观察者），位于 `src/resolution/callback-synthesizer.ts`——**不在** `frameworks/` 下。

> 另一类动态分发——**具名**属性/描述符分发（如 django `self._iterable_class(...)`）——的同级机制是 `claimsReference` 钩子（`resolution/types.ts` + `resolution/index.ts` 预过滤器）+ `FrameworkResolver.resolve()`（`frameworks/python.ts` 中的 django ORM 解析器）。那种情况**确实**适合 `resolve()`，因为 ref 是具名的。两者都属于同一覆盖工作；见"相关工作"章节。

---

## 实际构建算法（及与原始设计的差异）

### 字段观察者通道（`fieldChannelEdges`，Phase 1）

1. **按方法/函数名筛选候选** — 注册者：`^(on[A-Z]\w*|subscribe|addListener|addEventListener|register|watch|listen|addCallback)$`；分发者：名称中含 `(emit|trigger|notify|dispatch|fire|publish|flush)`。
2. **通过函数体确认**（通过 `ctx.readFile` 读取并切片节点行）：注册者含 `this.<F>.add|push|set(`；分发者含 `for (… of [Array.from(]this.<F>)` + 调用，或 `this.<F>.forEach(`。
3. **配对——设计差异：** 设计方案是按*类*配对；实际构建按**同文件 + 同字段 `F`** 配对（将文件作为类的代理——可靠地获取含类更难）。适用于常见的单类单文件情况；多类文件待改进。
4. **注册点：** `queries.getIncomingEdges(registrar.id, ['calls'])` → 对每个调用者，读取该边行的源码并**通过正则恢复参数**（`<registrarName>\s*\(\s*(?:this\.)?(\w+)`）。**设计差异：** 设计倾向于 tree-sitter 重解析；实际构建使用正则（仅具名 ref——箭头函数/内联参数会被遗漏）。
5. **合成** `dispatcher → fn`（`getNodesByName(arg)` → method|function）。上限为 `MAX_CALLBACKS_PER_CHANNEL = 40`。

### EventEmitter 通道（`eventEmitterEdges`，Phase 2）

- **面向文件扫描**（`ctx.getAllFiles()` + `readFile`，先通过 `.emit(`/`.on(`等子串预过滤）。`ON_RE` = `\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*(?:function\s+(\w+)|(?:this\.)?(\w+))`；`EMIT_RE` = `\.(?:emit|fire|dispatchEvent)\(\s*['"]([^'"]+)['"]`。
- 分发者 = `emit('e')` 调用的**外层函数**（`enclosingFn` 找到包含该行的最近函数/方法/组件节点）。处理器 = `getNodesByName`（on 处理器名称）。
- 按**事件名字面量**关联；合成 dispatcher → handler。
- **精度——设计差异：** 设计提议接收者类型匹配；实际构建使用**事件扇出上限**（`EVENT_FANOUT_CAP = 6`）——跳过处理器或分发者超过 6 个的事件（如 `error`/`change` 这类通用名在没有类型信息时会过度连接）。

### Provenance——设计差异

`Edge.provenance` 是固定枚举（`'tree-sitter'|'scip'|'heuristic'`），因此合成边使用 **`provenance: 'heuristic'`** + `metadata: { synthesizedBy: 'callback'|'event-emitter', via/event/field }`。设计中的 `'callback-synthesis'` provenance 和高/中/低**置信度分层未被实现**——扇出上限 + 注册者名称唯一性 + 仅具名处理器是替代的精度保障。

### Phase 3——内联回调提取（`tree-sitter.ts`）

EventEmitter 在真实代码库中的真正瓶颈：内联处理器（`on('mount', function onmount(){})`)）不是**节点**，因此无法链接到它们。根本原因：`visitFunctionBody` 在遍历时会穿过嵌套函数而不提取。修复：在 `visitForCallsAndStructure` 中，当一个 body 节点是 `functionType` 且 `extractName` 返回真实名称时，调用 `extractFunction`（提取它并遍历其自身 body）并返回。**仅限具名**——匿名箭头函数走现有递归路径（其内部调用仍归属于外层函数）。结果有界：excalidraw +3 节点，无爆炸，无回退。

---

## 验证结果（实际）

| 代码库 | 结果 |
| --- | --- |
| excalidraw | 1 条合成边 `triggerUpdate → triggerRender`（共 27,214 条）；`trace(mutateElement, triggerRender)` = 3 跳；节点 9,286 → 9,289 |
| express | Phase 3 后：`use → onmount` `{event-emitter, event:"mount"}`（`onmount` 现提取自 `application.js:109`） |
| `/tmp/cb-fixture/bus.js` | `tick → handleRefresh`、`persist → handleSave`（具名方法 EventEmitter 处理器） |
| excalidraw / express | Phase 1 无回退；节点数稳定 |

---

## 剩余工作（按优先级排序）

1. **匿名箭头处理器** — `on('e', () => foo())` 仍不产生边（无节点，Phase 3 刻意不提取）。修复方案是**合成器链内体**：解析箭头的 body 并链接 `dispatcher → (箭头内的调用)`。这是剩余召回率提升最大的点；覆盖最常见的现代回调形式。
2. **接入 `resolveAndPersist`**（增量同步）——合成目前仅在 `resolveAndPersistBatched`（全量索引）中运行。增量重新索引不会刷新合成边。
3. **接收者类型匹配**，用于 EventEmitter 精度（替代/增强扇出上限）——使用 `type_of` 边，使 `x.emit('change')` 仅在 `x`、`y` 同类型时才链接到 `y.on('change', fn)`。这样扇出上限可以放宽。
4. **tree-sitter 参数恢复**（替换字段通道 Stage 4 中的正则）——对箭头函数、多参数、换行调用更稳健。
5. **单回调字段**（`this.onChange = cb; … this.onChange()`）——字段观察者的标量存储变体；尚未构建。
6. **全面精度/召回率审计**——在完整语料库上运行；统计每个代码库的合成边数，抽查，确认 EventEmitter 密集型代码库无爆炸。
7. **测试 + CHANGELOG**——固件已是现成的 vitest 测试用例；添加 Phase 3 的提取器测试（具名嵌套函数提取；确认其他语言不受影响——该变更位于共享遍历器中），以及 django 侧的解析器测试。

## 边界情况 / 模型

- **跨实例过近似**是被接受的（可达性，而非实例精度）。忽略 `unregister`/`off`。
- 合成边是**增量式的**——永不替换静态边；工具可按 `provenance='heuristic'` + `metadata.synthesizedBy` 过滤。

## 相关工作（同一覆盖工作）

这是闭合动态分发覆盖工作的一半。`main` 上的其他产物：

- **具名属性/描述符解析器**：`claimsReference`（`resolution/types.ts`，`resolution/index.ts` 预过滤器）+ django ORM 解析器（`frameworks/python.ts`，`_iterable_class` → `ModelIterable.__iter__`）。
- **检索/UX 变更**（与覆盖独立）：`explore` 整小文件 + 粘合修复，`explore` Flow 部分（`buildFlowFromNamedSymbols`），以及带调用链的 `node`——均在 `src/mcp/tools.ts`。（`synapse_trace` / `synapse_context` 后来已移除；explore 是唯一的呈现工具。）
- **完整调查上下文和发现：** 自动记忆 `project_synapse_read_displacement`（为什么覆盖——而非提示/钩子/新工具——是让智能体使用 synapse 而非 Read 的杠杆）。
