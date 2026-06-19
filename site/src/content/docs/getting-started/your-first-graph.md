---
title: 构建你的第一个图谱
description: 构建索引并运行第一批查询。
---

安装好 Synapse 后，构建和探索一个图谱只需三条命令。

## 索引项目

```bash
cd your-project
synapse init -i      # 初始化 + 一步完成索引
```

`init` 会创建 `.synapse/` 目录；`-i`（或 `--index`）会立即构建完整索引。对于已有项目，可以随时重新索引：

```bash
synapse index          # 全量索引
synapse sync           # 仅更新有变动的文件（增量）
```

## 验证是否成功

```bash
synapse status
```

此命令会报告节点/边/文件数量、当前使用的 SQLite 后端和日志模式——可以快速确认索引已就绪。

## 运行查询

```bash
synapse query UserService          # 按名称查找符号
synapse callers handleRequest      # 谁调用了某个函数
synapse callees handleRequest      # 某个函数调用了谁
synapse impact AuthMiddleware      # 修改某符号会影响哪些代码
synapse context "fix the login flow"   # 构建以任务为中心的上下文
```

所有命令都支持 `--json` 标志以输出机器可读格式。参见完整的 [CLI 参考](/synapse/reference/cli/)。

## 交给你的 agent

只要存在 `.synapse/` 目录且 agent 已完成配置（参见[安装](/synapse/getting-started/installation/)），你的 agent 就会自动使用 [MCP 工具](/synapse/reference/mcp-server/)——无需额外操作。
