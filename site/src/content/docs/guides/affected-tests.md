---
title: CI 中的受影响测试
description: 只运行被变更实际影响的测试。
---

`synapse affected` 通过传递性地追踪导入依赖，找出受一组变更源文件影响的测试文件——让 CI 只运行相关测试。

```bash
synapse affected src/utils.ts src/api.ts          # 直接传入文件
git diff --name-only | synapse affected --stdin    # 从 git diff 管道输入
synapse affected src/auth.ts --filter "e2e/*"      # 自定义测试文件匹配模式
```

## 选项

| 选项 | 说明 | 默认值 |
|---|---|---|
| `--stdin` | 从标准输入读取文件列表 | `false` |
| `-d, --depth <n>` | 最大依赖遍历深度 | `5` |
| `-f, --filter <glob>` | 用于识别测试文件的自定义 glob | 自动检测 |
| `-j, --json` | 以 JSON 格式输出 | `false` |
| `-q, --quiet` | 仅输出文件路径 | `false` |

## CI / hook 示例

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | synapse affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```
