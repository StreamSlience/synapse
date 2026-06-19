---
title: 简介
description: Synapse 是什么，以及它如何让 AI 编程 agent 更快、成本更低。
---

Synapse 是一款**本地优先的代码智能工具**。它用 [tree-sitter](https://tree-sitter.github.io/) 解析你的代码库，将所有符号、边和文件存储在本地 SQLite 数据库中，并通过[模型上下文协议（MCP）](/synapse/reference/mcp-server/)、CLI 和 TypeScript 库，将结果以可查询的**知识图谱**形式对外暴露。

它的目标是让 AI 编程 agent——Claude Code、Cursor、Codex CLI、opencode、Hermes Agent、Gemini CLI、Antigravity IDE 和 Kiro——**无需扫描文件即可回答结构性问题**。agent 不必通过 `grep`、`glob` 和 `Read` 来逐步还原代码的组织方式，而是直接查询预先构建好的索引，用少量调用即可得到答案。

## 为什么重要

当 agent 探索一个代码库时，大部分"预算"都花在*发现阶段*——在真正读取文件之前，先找到正确的文件。Synapse 消除了这一步：符号关系、调用图和代码结构已经全部索引完毕。

在 7 个真实开源代码库上测试（每组 4 次运行取中位数），为 agent 配备 Synapse 后，平均效果：

- **成本降低 35%**
- **token 减少 57%**
- **速度提升 46%**
- **工具调用减少 71%**

收益随代码库规模增长——在大型仓库上，agent 完全从索引中获取答案，**文件读取次数为零**。

## 图谱中包含什么

- **符号** — 函数、类、方法、类型、路由、组件等。
- **边** — 调用、导入、继承、引用以及框架特定关系。
- **文件** — 结构信息加上全文检索（FTS5）。

提取过程是**确定性的**——源自 AST，从不经 LLM 汇总。

## 100% 本地

数据不会离开你的机器。无需 API 密钥，无需外部服务——只有 `.synapse/` 目录中的一个 SQLite 数据库。

准备好体验了吗？前往[快速上手](/synapse/getting-started/quickstart/)。
