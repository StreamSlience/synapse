---
title: MCP 服务器
description: Synapse 通过 MCP 向 AI agent 暴露的工具。
---

Synapse 作为[模型上下文协议](https://modelcontextprotocol.io/)服务器运行。启动方式：

```bash
synapse serve --mcp
```

由安装器配置的 agent 会自动启动该服务器。当 `.synapse/` 索引存在时，agent 可使用以下工具。

## 工具列表

| 工具 | 用途 |
|---|---|
| `synapse_search` | 按名称在代码库中搜索符号 |
| `synapse_callers` | 查找调用某函数的代码 |
| `synapse_callees` | 查找某函数调用的代码 |
| `synapse_impact` | 分析修改某符号会影响哪些代码 |
| `synapse_node` | 获取特定符号的详细信息（可选择包含源码） |
| `synapse_explore` | 一次调用返回多个相关符号的源码（按文件分组）及其关系图 |
| `synapse_files` | 获取已索引的文件结构（比文件系统扫描更快） |
| `synapse_status` | 检查索引健康状态和统计信息 |

## agent 应如何使用

Synapse *本身就是*预构建的搜索索引。对于"X 是如何工作的"、架构分析、调用链追踪或符号定位类问题，agent 应该通过少量 Synapse 调用给出答案并停止——通常**零次文件读取**——而不是通过 `grep` + `Read` 重新推导。直接用 Synapse 只需几次调用；而用 grep/read 探索则需要几十次。

安装器会自动将这份指南写入每个 agent 的说明文件。
