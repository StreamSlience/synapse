# 发行版：自包含 bundle

Synapse 随应用一起打包了一个**vendored Node 运行时**。由于 Node 22.5+ 内置了真正的 SQLite（`node:sqlite`，支持 WAL + FTS5），打包 Node 意味着：

- **无需原生构建** — `better-sqlite3` 已移除，不再需要编译或重新构建任何原生插件。
- **无需 wasm 回退** — 因此也不再出现 `database is locked`（issue #238）。
- **不依赖 Node 版本** — 应用始终运行在内置的 Node 上，与用户安装的版本（或未安装）无关。

## bundle 的内容

由 [`scripts/build-bundle.sh`](scripts/build-bundle.sh) 构建——每个平台一个归档，配方完全相同（只有 Node 下载部分不同）：

```
synapse-<target>/
  node | node.exe          # 针对 <target> 的官方 Node 运行时
  lib/
    dist/                  # 编译后的应用（+ tree-sitter .wasm 语法文件、schema.sql）
    node_modules/          # 仅生产依赖（纯 JS / wasm——可移植）
  bin/
    synapse | synapse.cmd   # 启动器 → 用内置 Node 运行应用
```

目标平台：`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64`、`win32-x64`、`win32-arm64`。Unix 目标生成 `.tar.gz`（shell 启动器）；Windows 生成 `.zip`（`node.exe` + `.cmd` 启动器）。

```bash
scripts/build-bundle.sh linux-x64            # -> release/synapse-linux-x64.tar.gz
scripts/build-bundle.sh win32-x64            # -> release/synapse-win32-x64.zip
```

由于移除了 better-sqlite3 后**零原生插件**，构建 bundle 就是纯粹的文件打包——**任何**目标都可以在**任何** OS 上构建（整个矩阵在一台 Linux runner 上构建）。交叉编译不是问题；只有*运行测试* bundle 才需要目标平台（或模拟，例如 `docker run --platform linux/amd64`）。

## 安装渠道（均分发相同的 bundle）

1. **`curl | sh`**（[`install.sh`](install.sh)）— 无需 Node；适合通过 SSH 连接的全新 Linux VPS。检测操作系统/架构，从 GitHub Releases 拉取归档，将 `synapse` 软链接到 PATH。重新运行可升级；`--uninstall` 可移除。
2. **npm**（[`scripts/npm-shim.js`](scripts/npm-shim.js)）— 保留 `npm i -g @colbymchenry/synapse`。主包是一个微型 shim；bundle 以每平台 `optionalDependencies` 的形式发布（`@colbymchenry/synapse-<target>`，带有 `os`/`cpu` 字段），npm 只安装匹配的那个。shim 由用户的 Node 运行，然后 exec 到 bundle，因此实际工作运行在内置 Node 24 上。即使在旧版 Node 上也能工作。在 Windows 上，它直接调用内置 `node.exe` 执行应用入口（而非 `.cmd` 启动器）——现代 Node 在被要求 spawn `.cmd`/`.bat` 时会抛出 `EINVAL`。
3. **Windows**（[`install.ps1`](install.ps1)）— `irm … | iex`；流程与 install.sh 相同（检测架构，从 Releases 拉取 `.zip`，添加到 PATH）。
4. **Homebrew / Scoop** — TODO（tap + cask 指向 Release 归档）。

## 发布流水线

[`.github/workflows/release.yml`](.github/workflows/release.yml) — 手动触发。从 `package.json` 读取版本，在一台 runner 上构建所有平台 bundle，创建 GitHub Release（发布说明来自 `CHANGELOG.md`），并发布 npm shim + 各平台包。需要 `NPM_TOKEN` 仓库密钥。

待完成事项：
- **代码签名** — "下载并运行"的主要缺口：macOS Gatekeeper 需要 Developer ID + 公证；Windows 需要 Authenticode。Homebrew 可以缓解 macOS 的情况（处理隔离检疫）。
- 退役 `src/bin/synapse.ts` 中现在已多余的 Node 版本检查——bundle 始终运行 Node 24，npm shim 也不做 tree-sitter 工作。
- 通过 shim 重新接入 `npm uninstall` 清理（agent 配置的 `preuninstall`）——生成的主包目前不携带该钩子。
