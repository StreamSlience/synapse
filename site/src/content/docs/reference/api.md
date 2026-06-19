---
title: API
description: 将 Synapse 作为 TypeScript 库使用。
---

Synapse 提供了一套 TypeScript API，公开接口为 `Synapse` 类。

```typescript
import Synapse from '@colbymchenry/synapse';

const cg = await Synapse.init('/path/to/project');
// 或打开已有索引：
// const cg = await Synapse.open('/path/to/project');

await cg.indexAll({
  onProgress: (p) => console.log(`${p.phase}: ${p.current}/${p.total}`),
});

const results = cg.searchNodes('UserService');
const callers = cg.getCallers(results[0].node.id);
const context = await cg.buildContext('fix login bug', {
  maxNodes: 20,
  includeCode: true,
  format: 'markdown',
});
const impact = cg.getImpactRadius(results[0].node.id, 2);

cg.watch();   // 文件变更时自动同步
cg.unwatch(); // 停止监听
cg.close();
```

## 主要方法

| 方法 | 用途 |
|---|---|
| `Synapse.init(path)` / `Synapse.open(path)` | 创建或打开一个项目索引 |
| `indexAll(opts)` | 全量索引，支持进度回调 |
| `sync()` | 增量更新 |
| `searchNodes(query)` | 全文符号搜索 |
| `getCallers(id)` / `getCallees(id)` | 遍历调用图 |
| `getImpactRadius(id, depth)` | 计算某个变更的传递性影响 |
| `buildContext(task, opts)` | 为 AI 构建 Markdown / JSON 上下文 |
| `watch()` / `unwatch()` | 启动 / 停止文件监听器 |
| `close()` | 关闭数据库连接 |
