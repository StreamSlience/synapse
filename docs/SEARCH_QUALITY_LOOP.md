# Synapse 语言验证指南

你正在验证 Synapse 是否完整支持某种特定编程语言。用户会提供一个在本地克隆的真实流行开源代码库路径。你的任务是使用 Synapse 的 API 对其运行一系列真实提示，并验证结果是否足够好，可以宣称该语言已**覆盖并受支持**。

一种语言在 LLM 能够可靠地使用 Synapse 的 MCP 工具导航该代码库之前，均视为**未经验证**——包括找到正确的符号、理解调用链、探索子系统，并为实际任务获取有用的上下文。

## 设置

### 1. 构建与索引

```bash
npm run build
rm -rf <codebase_path>/.synapse
node dist/bin/synapse.js init -iv <codebase_path>
```

`-iv` 标志会输出详细信息，显示提取进度、节点/边计数和耗时。

### 2. 快速健全性检查

```bash
# 验证节点是否以正确的限定名提取
sqlite3 <codebase_path>/.synapse/synapse.db \
  "SELECT name, kind, qualified_name FROM nodes WHERE kind = 'method' LIMIT 10;"

# 正确: file.go::StructName::method_name  (包含所属类型)
# 错误: file.go::file.go::method_name     (所属类型缺失 — 需要 getReceiverType)

# 检查边的计数
sqlite3 <codebase_path>/.synapse/synapse.db \
  "SELECT kind, COUNT(*) FROM edges GROUP BY kind ORDER BY COUNT(*) DESC;"

# 检查节点类型分布
sqlite3 <codebase_path>/.synapse/synapse.db \
  "SELECT kind, COUNT(*) FROM nodes GROUP BY kind ORDER BY COUNT(*) DESC;"
```

如果方法在 `qualified_name` 中缺少所属类型，请先修复（参见[添加 getReceiverType](#添加-getreceivertype)），再继续完整测试。

## 测试套件

对代码库运行以下**所有**测试类别。直接使用 Node.js API——下面的测试脚本是模板，请根据你正在测试的代码库中的真实类型、方法和子系统调整查询。

**每项测试的通过标准：** 结果是否给 LLM 提供了足够正确的信息来回答问题或完成任务？如果你是那个 LLM，你会信任这些结果吗？

---

### 测试 1：`synapse_explore` — 深度探索（最重要）

这是 LLM 使用的主要工具。它必须为自然语言查询返回按文件分组、带有正确关系的相关源代码。用**至少 5 种不同查询类型**进行测试：

```bash
node -e "
const { Synapse } = require('./dist/index.js');
async function test() {
  const cg = await Synapse.open('<codebase_path>');

  const queries = [
    // A. 子系统探索 — 宽泛主题，应找到正确的文件和关键类
    'How does the caching system work?',

    // B. 特定类/类型深挖 — 应返回该类、其方法和相关类型
    'CacheBuilder configuration and build process',

    // C. 横切关注点 — 应跨多个文件找到实现
    'How are errors handled and propagated?',

    // D. 数据流问题 — 应追踪多个层次
    'How does data flow from input to storage?',

    // E. 实现细节 — 特定方法的行为
    'How does eviction decide which entries to remove?',
  ];

  for (const query of queries) {
    console.log(\`\n========================================\`);
    console.log(\`QUERY: \${query}\`);
    console.log(\`========================================\`);

    const subgraph = await cg.findRelevantContext(query, {
      searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2,
    });

    // 显示入口点 — LLM 首先看到的内容
    console.log(\`\nEntry points (\${subgraph.roots.length}):\`);
    for (const rootId of subgraph.roots.slice(0, 8)) {
      const node = subgraph.nodes.get(rootId);
      if (node) console.log(\`  \${node.name} (\${node.kind}) — \${node.filePath}:\${node.startLine}\`);
    }

    // 显示文件分布 — 正确的文件是否浮现？
    const fileGroups = new Map();
    for (const node of subgraph.nodes.values()) {
      if (!fileGroups.has(node.filePath)) fileGroups.set(node.filePath, []);
      fileGroups.get(node.filePath).push(node.name);
    }
    console.log(\`\nFiles (\${fileGroups.size}):\`);
    for (const [file, nodes] of [...fileGroups.entries()].sort((a,b) => b[1].length - a[1].length).slice(0, 8)) {
      console.log(\`  \${file} (\${nodes.length} symbols): \${nodes.slice(0, 6).join(', ')}\`);
    }

    // 显示边分布 — 关系是否被捕获？
    const edgeKinds = new Map();
    for (const edge of subgraph.edges) {
      edgeKinds.set(edge.kind, (edgeKinds.get(edge.kind) || 0) + 1);
    }
    console.log(\`\nEdges (\${subgraph.edges.length}):\`);
    for (const [kind, count] of [...edgeKinds.entries()].sort((a,b) => b - a)) {
      console.log(\`  \${kind}: \${count}\`);
    }

    console.log(\`\nTotal: \${subgraph.nodes.size} nodes, \${subgraph.edges.length} edges, \${fileGroups.size} files\`);
  }

  await cg.close();
}
test().catch(console.error);
"
```

**每个查询需检查的内容：**
- 入口点对问题来说有意义吗？
- 正确的文件是否浮现（而非只有测试文件或无关代码）？
- 是否有多种边类型（calls、contains、extends、implements）——而非只有 `contains`？
- 节点数量是否合理？过少（<5）意味着搜索失败；过多无关节点意味着噪音。

---

### 测试 2：`synapse_search` — 符号查找

验证基本符号搜索能正确工作。

```bash
node -e "
const { Synapse } = require('./dist/index.js');
async function test() {
  const cg = await Synapse.open('<codebase_path>');

  const tests = [
    // 按精确名称搜索
    'MainClass',
    // 按方法名搜索
    'processRequest',
    // 按局部名称搜索（应返回多个候选）
    'init',
  ];

  for (const query of tests) {
    console.log(\`\nSearch: \${query}\`);
    const results = cg.searchNodes(query, { limit: 5 });
    for (const { node, score } of results) {
      console.log(\`  \${score.toFixed(2)} \${node.kind} \${node.qualifiedName}\`);
    }
  }

  await cg.close();
}
test().catch(console.error);
"
```

**检查内容：**
- 精确名称匹配排在第一位
- `qualifiedName` 包含所属类型（`ClassName::method_name`），而非只是文件路径
- 类方法以 `file.go::TypeName::method_name` 形式展示，而非 `file.go::method_name`

---

### 测试 3：`synapse_callers` / `synapse_callees` — 调用链追踪

验证调用关系能被正确追踪。

```bash
node -e "
const { Synapse } = require('./dist/index.js');
async function test() {
  const cg = await Synapse.open('<codebase_path>');

  // 先找一个应该有调用者的核心方法
  const results = cg.searchNodes('processRequest', { limit: 3 });
  if (results.length === 0) { console.log('No results'); process.exit(1); }

  const node = results[0].node;
  console.log(\`Testing callers/callees for: \${node.qualifiedName}\`);

  const callers = cg.getCallers(node.id);
  console.log(\`\nCallers (\${callers.length}):\`);
  for (const c of callers.slice(0, 5)) {
    console.log(\`  \${c.node.qualifiedName} (\${c.node.filePath}:\${c.node.startLine})\`);
  }

  const callees = cg.getCallees(node.id);
  console.log(\`\nCallees (\${callees.length}):\`);
  for (const c of callees.slice(0, 5)) {
    console.log(\`  \${c.node.qualifiedName} (\${c.node.filePath}:\${c.node.startLine})\`);
  }

  await cg.close();
}
test().catch(console.error);
"
```

**检查内容：**
- 调用者指向实际调用了该方法的地方（而非任意文件）
- 被调用者是该方法体内调用的函数
- `qualifiedName` 包含所属类型（`TypeName::method_name`）

---

### 测试 4：`synapse_impact` — 变更影响分析

验证变更影响分析工作正常。

```bash
node -e "
const { Synapse } = require('./dist/index.js');
async function test() {
  const cg = await Synapse.open('<codebase_path>');

  // 找一个核心类/接口
  const results = cg.searchNodes('BaseClient', { limit: 3 });
  if (results.length === 0) { console.log('No results'); process.exit(1); }

  const node = results[0].node;
  console.log(\`Impact radius for: \${node.qualifiedName}\`);

  const impact = cg.getImpactRadius(node.id, 3);
  console.log(\`\nTotal impact: \${impact.nodes.size} nodes\`);

  // 按层级分组
  const byDepth = new Map();
  for (const [id, depth] of impact.depths) {
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    const n = impact.nodes.get(id);
    if (n) byDepth.get(depth).push(n.qualifiedName);
  }
  for (const [depth, nodes] of [...byDepth.entries()].sort()) {
    console.log(\`  Depth \${depth}: \${nodes.slice(0, 5).join(', ')}\`);
  }

  await cg.close();
}
test().catch(console.error);
"
```

**检查内容：**
- 影响半径沿调用链扩散（不仅仅停留在直接调用者）
- 无图爆炸（数百个节点往往意味着遍历了错误的边类型）

---

### 测试 5：边提取质量

```bash
# 查看各边类型的计数
sqlite3 <codebase_path>/.synapse/synapse.db \
  "SELECT kind, COUNT(*) as cnt FROM edges GROUP BY kind ORDER BY cnt DESC;"
```

**针对该语言的健康边分布：**
- `contains`：应为最多（文件→符号关系）
- `calls`：应相当多（调用边）
- `imports`：应有一些（导入边）
- `extends`/`implements`：视代码库而定
- 如果只有 `contains` 边，说明调用提取存在问题

---

### 测试 6：节点提取完整性

```bash
# 验证节点以正确的限定名提取
sqlite3 <codebase_path>/.synapse/synapse.db \
  "SELECT kind, COUNT(*) FROM nodes GROUP BY kind ORDER BY COUNT(*) DESC;"

# 验证方法有正确的限定名（应包含所属类型）
sqlite3 <codebase_path>/.synapse/synapse.db \
  "SELECT qualified_name FROM nodes WHERE kind = 'method' LIMIT 20;"
```

**正确的限定名格式：**
- Go: `file.go::TypeName::method_name`
- TypeScript: `file.ts::ClassName::methodName`
- Python: `file.py::ClassName::method_name`
- 错误：`file.go::file.go::method_name`（重复文件路径）
- 错误：`file.go::method_name`（缺少所属类型）

---

### 测试 7：真实 LLM 提示词

用几个**真实的**用户查询来测试完整的工作流程——就像 LLM 在代码库中实际工作时会提问的那种。这些应该是自然语言、具体而非通用的提问：

```
1. "Where is the HTTP connection pool managed?"
2. "How does [ClassName] handle errors?"
3. "What calls [CoreMethod] and why?"
4. "How is authentication validated before [Endpoint]?"
5. "What would break if I changed [InterfaceName]?"
```

用 `synapse_explore` 和 `synapse_search` 运行这些查询，并检查一个 LLM 能否在不读取任何实际文件的情况下根据结果给出合理的答案。

---

## 诊断失败

### 如果 `synapse_explore` 返回结果较少或完全无关

```bash
# 检查 FTS5 索引
sqlite3 <codebase_path>/.synapse/synapse.db \
  "SELECT COUNT(*) FROM nodes_fts;"

# 检查 FTS5 实际工作情况
sqlite3 <codebase_path>/.synapse/synapse.db \
  "SELECT name, kind FROM nodes_fts WHERE nodes_fts MATCH 'cache' LIMIT 10;"

# 检查特定文件是否被索引
sqlite3 <codebase_path>/.synapse/synapse.db \
  "SELECT path, indexed_at FROM files LIMIT 10;"
```

### 如果方法缺少所属类型

在 `qualified_name` 中看到 `file.go::method_name` 而非 `file.go::TypeName::method_name`，说明需要为该语言实现 `getReceiverType`（参见[添加 getReceiverType](#添加-getreceivertype)）。

### 如果调用者/被调用者为空

```bash
# 检查调用边是否存在
sqlite3 <codebase_path>/.synapse/synapse.db \
  "SELECT COUNT(*) FROM edges WHERE kind = 'calls';"

# 查看调用边的样本
sqlite3 <codebase_path>/.synapse/synapse.db \
  "SELECT e.kind, n1.name, n2.name
   FROM edges e
   JOIN nodes n1 ON e.from_id = n1.id
   JOIN nodes n2 ON e.to_id = n2.id
   WHERE e.kind = 'calls' LIMIT 10;"
```

---

## 修复后

修复任何质量问题后，**完整重新索引**：

```bash
rm -rf <codebase_path>/.synapse
node dist/bin/synapse.js init -iv <codebase_path>
```

然后重新运行**全部测试套件**以验证质量。

---

## 添加 getReceiverType

如果方法缺少所属类型，需要在对应的语言提取器中实现 `getReceiverType`：

**位置：** `src/extraction/languages/<language>-extractor.ts`

**实现模式（以 Go 为例）：**

```typescript
private getReceiverType(node: Parser.SyntaxNode): string | null {
  // 寻找方法接收者参数
  // 例如 Go: func (r *ReceiverType) MethodName() {}
  //  → 找到 parameter_declaration 子节点
  //  → 提取类型名称（去掉 * 指针符号）
  const params = node.childForFieldName('parameters');
  if (!params) return null;

  for (const child of params.namedChildren) {
    if (child.type === 'parameter_declaration') {
      const typeNode = child.childForFieldName('type');
      if (typeNode) {
        let typeName = typeNode.text.replace(/^\*/, '');
        return typeName;
      }
    }
  }
  return null;
}
```

然后在方法提取中使用它：

```typescript
const receiverType = this.getReceiverType(methodNode);
const qualifiedName = receiverType
  ? `${filePath}::${receiverType}::${methodName}`
  : `${filePath}::${methodName}`;
```

---

## 关键文件

- `src/extraction/languages/` — 各语言提取器
- `src/resolution/` — 跨文件引用解析
- `src/graph/` — 图遍历和查询
- `src/types.ts` — `NodeKind` 和 `EdgeKind` 定义
- `__tests__/extraction.test.ts` — 提取测试

---

## 语言状态

添加完对某种语言的支持后，用你在本验证周期中测试的**具体代码库名称**更新 `README.md` 中的语言状态表：

```markdown
| Go | `.go` | 完整支持 |
```

如果某个方面存在已知局限（例如接口实现推断），在支持说明中注明。
