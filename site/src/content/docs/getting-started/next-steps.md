---
title: 后续步骤
description: 安装并完成索引后，接下来该做什么。
---

Synapse 已安装完毕，图谱也已构建好。以下是接下来可以探索的方向。

## 深入理解原理

- [工作原理](/synapse/core-concepts/how-it-works/) — 提取 → 存储 → 解析 → 同步的完整流水线。
- [知识图谱](/synapse/core-concepts/knowledge-graph/) — 图谱由哪些节点类型和边类型构成。
- [解析与框架](/synapse/core-concepts/resolution/) — 引用如何被解析，框架路由如何被连接。

## 付诸实践

- [索引项目](/synapse/guides/indexing/) — 全量索引、增量同步和文件监听器。
- [框架路由](/synapse/guides/framework-routes/) — 将 URL 模式与对应的处理函数关联起来。
- [CI 中的受影响测试](/synapse/guides/affected-tests/) — 只运行被变更影响的测试。

## 参考文档

- [MCP 服务器](/synapse/reference/mcp-server/) — agent 调用的工具。
- [CLI](/synapse/reference/cli/) — 所有命令和标志。
- [API](/synapse/reference/api/) — 将 Synapse 作为 TypeScript 库使用。
- [集成](/synapse/reference/integrations/) — 支持的 agent 及手动配置方式。
