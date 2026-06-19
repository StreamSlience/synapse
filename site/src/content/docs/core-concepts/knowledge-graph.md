---
title: 知识图谱
description: 图谱由哪些节点类型和边类型构成。
---

Synapse 存储三类数据：**节点**（符号和文件）、**边**（它们之间的关系）以及**文件**。每个节点和边都有一个精确的 `kind` 字段，取自固定词汇表，确保跨语言查询的一致性。

## 节点类型

`file`、`module`、`class`、`struct`、`interface`、`trait`、`protocol`、`function`、`method`、`property`、`field`、`variable`、`constant`、`enum`、`enum_member`、`type_alias`、`namespace`、`parameter`、`import`、`export`、`route`、`component`。

## 边类型

`contains`、`calls`、`imports`、`exports`、`extends`、`implements`、`references`、`type_of`、`returns`、`instantiates`、`overrides`、`decorates`。

## 来源标记

大多数边直接来自 AST。少数边——位于静态解析无法跨越的动态分发边界处——是**合成**生成的，标记有 `provenance: 'heuristic'` 以及创建它们的接线点。这些标记会在 `explore` 的输出和 `node` 的调用链中内联展示，让 agent 清楚地看到每条连接的来源。

## 查询方式

- **搜索** — 按名称搜索符号（FTS5）。
- **调用者 / 被调用者** — 逐跳遍历调用图。
- **影响** — 计算某个变更的传递性影响半径。
- **探索** — 一次调用返回多个相关符号的源码（按文件分组），并附带它们之间的调用路径。

具体用法请参见 [CLI](/synapse/reference/cli/) 和 [MCP 服务器](/synapse/reference/mcp-server/) 参考文档。
