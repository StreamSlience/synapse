---
title: 故障排查
description: 最常见 Synapse 问题的解决方法。
---

## "Synapse not initialized"

先在项目目录中运行 `synapse init`。

## 索引速度慢

检查 `node_modules` 和其他大目录是否已被排除（如果已加入 `.gitignore`，则会自动排除）。使用 `--quiet` 可减少输出开销。

## MCP 报 `database is locked`

当前版本不应出现此问题：Synapse 内置了自己的 Node 运行时，使用 Node 原生的 `node:sqlite` 并以 WAL 模式运行，并发读取不会被写入阻塞。如果仍然遇到，请检查：

- **你使用的是旧版（0.9 之前）安装。** 重新安装以获取内置运行时——`curl -fsSL https://raw.githubusercontent.com/colbymchenry/synapse/main/install.sh | sh`（macOS/Linux），`irm https://raw.githubusercontent.com/colbymchenry/synapse/main/install.ps1 | iex`（Windows），或 `npm i -g @colbymchenry/synapse@latest`。
- **`synapse status` 显示 `Journal:` 不是 `wal`**——说明当前文件系统无法启用 WAL（常见于网络共享和 WSL2 的 `/mnt`），读取可能被写入阻塞。将项目（连同 `.synapse/` 目录）移至本地磁盘。

## MCP 服务器无法连接

确认项目已初始化/索引，检查 MCP 配置中的路径是否正确，并验证 `synapse serve --mcp` 能否在命令行正常运行。

## 符号缺失

MCP 服务器会在保存后自动同步（等待几秒钟）。如有需要，可手动运行 `synapse sync`。检查该文件的语言是否[受支持](/synapse/reference/languages/)，以及是否被 `.gitignore` 排除。
