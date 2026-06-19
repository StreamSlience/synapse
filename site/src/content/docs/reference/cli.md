---
title: CLI
description: Synapse 的所有命令及其支持的标志。
---

```bash
synapse                         # 运行交互式安装器
synapse install                 # 运行安装器（显式调用）
synapse uninstall               # 从所有 agent 中移除 Synapse（install 的逆操作）
synapse init [path]             # 在项目中初始化（--index 同时进行索引）
synapse uninit [path]           # 从项目中移除 Synapse（--force 跳过确认提示）
synapse index [path]            # 全量索引（--force 重新索引，--quiet 减少输出）
synapse sync [path]             # 增量更新
synapse status [path]           # 显示统计信息
synapse query <search>          # 搜索符号（--kind、--limit、--json）
synapse files [path]            # 显示文件结构（--format、--filter、--max-depth、--json）
synapse context <task>          # 为 AI 构建上下文（--format、--max-nodes）
synapse callers <symbol>        # 查找调用某函数/方法的代码（--limit、--json）
synapse callees <symbol>        # 查找某函数/方法调用的代码（--limit、--json）
synapse impact <symbol>         # 分析修改某符号会影响哪些代码（--depth、--json）
synapse affected [files...]     # 查找受变更影响的测试文件
synapse serve --mcp             # 启动 MCP 服务器
```

## 查询命令

`query`、`callers`、`callees` 和 `impact` 均支持 `--json` 标志以输出机器可读格式。

```bash
synapse query UserService --kind class --limit 10
synapse callers handleRequest --json
synapse impact AuthMiddleware --depth 3
```

## affected

通过传递性地追踪导入依赖，找出受变更源文件影响的测试文件。选项说明和 CI 示例请参见 [CI 中的受影响测试](/synapse/guides/affected-tests/)。
