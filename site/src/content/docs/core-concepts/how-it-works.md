---
title: 工作原理
description: 提取、存储、解析和自动同步的完整流水线。
---

Synapse 通过四个阶段将源代码转化为可查询的图谱。

```
files → Extraction (tree-sitter) → DB (nodes/edges/files)
            ↓
      Resolution (imports, name-matching, framework patterns)
            ↓
      Graph queries (callers, callees, impact)
            ↓
      Context building (markdown / JSON for AI consumption)
```

## 1. 提取

[tree-sitter](https://tree-sitter.github.io/) 将源码解析为 AST。针对各语言的查询从中提取**节点**（函数、类、方法、类型等）和**边**（调用、导入、继承、实现等）。耗时较长的解析任务在主线程之外运行。

## 2. 存储

所有数据写入本地 SQLite 数据库（`.synapse/synapse.db`），并支持 FTS5 全文检索。Synapse 优先使用原生 `better-sqlite3`，无法使用时自动透明地回退到 WASM 后端；`synapse status` 命令会显示当前使用的后端。

## 3. 解析

提取完成后，Synapse 对引用进行解析：函数调用 → 定义，导入 → 源文件，类继承关系，以及框架特定的模式。一些动态分发边界（回调、观察者、React 重渲染、JSX 子组件）由合成器负责桥接，从而使调用链在端到端保持连通。参见[解析与框架](/synapse/core-concepts/resolution/)。

## 4. 自动同步

MCP 服务器使用系统原生文件事件（FSEvents / inotify / ReadDirectoryChangesW）监听项目变化。变更经过防抖处理和源文件过滤后进行增量同步——图谱会随代码变化实时更新，无需任何配置。
