# 匿名使用遥测

状态：已实现——摄取 Worker（`telemetry-worker/`）、客户端（`src/telemetry/`）、`synapse telemetry` CLI、MCP + 安装器接入、`TELEMETRY.md`。待完成：Worker 部署 + DNS、发布。

范围：公开的 `synapse` 引擎（CLI + MCP 服务器 + 安装器）

Synapse 是一个本地优先工具，其核心主张是"你的代码永远不会离开你的机器"。遥测的设计必须让这句话保持真实且可证明：一份简短、可审计的匿名计数器列表，逐字段记录文档，易于关闭，且不可悄悄扩展。本文档是契约；`TELEMETRY.md`（仓库根目录，面向用户）重申了它，实现中绝不能收集未在那里列出的任何内容。

## 目标

聚合且匿名地回答：

- 有多少机器在活跃使用 synapse（日/周），以及这一数字如何变化？
- 哪些智能体驱动了使用（Claude Code、Cursor、Codex、opencode……）——通过 MCP `clientInfo`。
- 人们选择哪些安装目标，本地还是全局，首次安装还是升级。
- MCP 工具和 CLI 命令的使用频率，以及报错频率。
- 人们索引哪些语言（通过真实使用情况来确定提取器/框架的优先级）。
- 版本采用速度、OS/架构/Node 版本分布、原生 vs wasm SQLite 后端占比。

## 非目标 / 永不收集

- **绝不收集源码。** 不收集文件路径、文件名、仓库名、符号名、查询字符串、搜索词，或任何来源于已索引项目内容的衍生内容。
- 不收集 IP 地址（在边缘层剥除；后端存储层也已禁用）。
- 不做硬件指纹识别——机器 ID 是随机 UUID，不派生自任何设备信息。
- 不收集逐键击/逐调用事件流——使用情况在发送前在本地聚合为每日汇总。
- 不从 `synapse-pro` 分支收集遥测（见下方"synapse-pro 规则"）。

## 原则

1. **Schema 即白名单。** 客户端仅发送下述事件；摄取 Worker 针对同一白名单进行验证并丢弃其他内容。添加字段 = 同时编辑本文档 + `TELEMETRY.md` + Worker 白名单的 PR。
2. **遥测绝不能给用户带来任何代价**：MCP 工具调用热路径上零增加延迟（仓库的核心不变式），零新 npm 依赖（全局 `fetch`，Node ≥18），stdout 零字节输出（stdio 是 MCP 协议通道），零重试，零错误噪声。每种失败模式的结果都是静默。
3. **关闭就是关闭。** 禁用时，没有任何进程会向遥测端点打开套接字——连"已选择退出"的 ping 都没有。
4. **第一方端点。** 客户端仅与 `telemetry.getsynapse.com` 通信。烧录到已发布 npm 版本中的 URL 永远 POST 到那里，因此该域名必须是我们的；其背后的后端可以在不发布新客户端版本的情况下更改。

## 事件

每批次的公共信封（每个进程计算一次）：

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| `machine_id` | `b3a8…`（UUIDv4） | 随机，首次运行时生成，存储于全局配置 |
| `synapse_version` | `0.9.12` | 来自 package.json |
| `os` / `arch` | `darwin` / `arm64` | `process.platform` / `process.arch` |
| `node_major` | `22` | 仅主版本号 |
| `ci` | `false` | `CI` 环境变量是否存在 |
| `schema_version` | `1` | schema 变更时递增 |

事件类型：

- **`install`** — 每次安装器运行一次。属性：`targets`（如 `["claude","cursor"]`）、`scope`（`local`/`global`）、`kind`（`fresh`/`upgrade`/`reinstall`）、`sqlite_backend`（`native`/`wasm`）。
- **`index`** — 每次全量索引（`init`/`index`，非 `sync`）一次。属性：`languages`（仅名称，如 `["typescript","go"]`）、`file_count_bucket`（`<100`、`100-1k`、`1k-10k`、`10k+`）、`duration_bucket`（`<10s`、`10-60s`、`1-5m`、`5m+`）、`sqlite_backend`。
- **`usage_rollup`** — 主力事件。每台机器每 `(day, kind, name)` 一条事件，在本地聚合。属性：`kind`（`mcp_tool`/`cli_command`）、`name`（如 `synapse_explore`、`affected`）、`count`、`error_count`，以及 MCP 专属的：来自 `initialize` 握手的 `client_name`/`client_version`（`src/mcp/session.ts` `case 'initialize'`——待添加的管道；目前未读取）。
- **`uninstall`** — 每次 `uninstall`/`uninit` 运行一次（流失信号）。属性：`targets`。

数量估算：汇总意味着月事件数 ≈ 活跃机器数 × 活跃天数 × 使用的不同工具数（个位数）——PostHog 免费层（100 万事件/月）可支持数万 MAU。设计上不存在逐调用事件。

事件以 PostHog **匿名事件**发送（`$process_person_profile: false`）：更便宜，无个人档案，唯一机器计数在 `distinct_id` = `machine_id` 上仍然有效。仅在留存工具需要档案时才重新评估。

## 同意与控制

解析顺序（第一个匹配优先）：

1. `DO_NOT_TRACK=1`（社区标准——始终遵守）→ 关闭
2. `SYNAPSE_TELEMETRY=0|1` → 当前进程强制关闭/开启
3. 全局配置 `~/.synapse/telemetry.json` → 存储的用户选择
4. 默认值：**开启**，受下述首次运行通知门控

界面：

- **安装器（交互式）：** 现有提示流程中的可见 clack 切换——"分享匿名使用数据？（无代码、路径或名称——详见 TELEMETRY.md）"——默认是。选择以 `consent_source: "installer"` 持久化。重新运行/升级时遵守已存储的选择，不重新询问。
- **无头路径**（`npx synapse init`、MCP 服务器——无 TTY，从不提示）：在**第一次实际发送**之前（记录仅在本地缓冲，保持静默——因此安装器的明确切换始终先于任何通知），向 **stderr** 打印一行并记录 `first_run_notice_shown`：
  `synapse collects anonymous usage stats (no code or paths) — "synapse telemetry off" or SYNAPSE_TELEMETRY=0 disables. Details: TELEMETRY.md`
- **CLI：** `synapse telemetry status|on|off`（status 打印机器 ID、当前状态及决定因素）。删除 `~/.synapse/telemetry.json` 会重置所有内容，包括机器 ID。

`~/.synapse/telemetry.json`：

```json
{
  "enabled": true,
  "machine_id": "uuid-v4",
  "consent_source": "installer | default-notice | cli",
  "first_run_notice_shown": true,
  "updated_at": "2026-06-12T00:00:00Z"
}
```

（`~/.synapse/` 是新的——目前没有任何全局内容存在。如果用户索引 `$HOME` 本身，可通过文件名共存，因为每个项目的数据位于 `<project>/.synapse/`，使用固定的其他文件名。）

## 客户端架构

新模块 `src/telemetry/`（单个小模块，无依赖）：

- **内存中的计数器** — 记录工具调用/CLI 命令是一次内存增量。热路径上没有任何操作会触及磁盘或网络。MCP 工具处理器调用 `telemetry.count('mcp_tool', name, ok)` 然后继续。
- **缓冲区** — 计数器以防抖异步方式持久化到 `~/.synapse/telemetry-queue.jsonl`。硬上限约 256 KB；溢出时丢弃最旧的行。缓冲区损坏 → 截断，永不抛出。
- **刷新** — 许多 CLI 操作通过 `process.exit()` 结束，`beforeExit` 从不触发且异步发送会中止，因此设计为：在 `process.on('exit')` 上进行微小的**同步追加**，持久化内存中的增量（在 `process.exit` 后仍存活），实际网络发送以机会主义方式进行——在长运行命令（`init`/`index`/`sync`/`uninit`/`upgrade`）开始时、在长期运行的 MCP 服务器/守护进程中的 unref'd 定时器上，以及在 `install`/`init`/`index`/`uninit` 结束时受上限约束等待（此处一秒是不可见的）。发送以 `AbortSignal.timeout(1500)` 将已完成天的汇总 + 生命周期事件 POST 到 `https://telemetry.getsynapse.com/v1/events`，即发即忘：任何响应（或无响应）都是最终结果——不重试，不暴露错误。队列通过原子重命名申领，避免并发进程重复发送（崩溃发送者的申领在一小时后合并回来）。`SYNAPSE_TELEMETRY_DEBUG=1` 将负载回显到 stderr 供开发使用。
- **离线 / 隔离网络：** 刷新静默失败，缓冲区保持在上限内，稳定状态是一个有界文件和零噪声。

## 摄取端点（Cloudflare Worker）

`telemetry.getsynapse.com` → 位于本仓库 `telemetry-worker/` 的小型 Worker——刻意公开，以便任何人都可以审计端点究竟存储了什么。它不随 npm 包一起发布（被 `files` 白名单排除）：

- `POST /v1/events`：针对事件/属性白名单进行验证（丢弃未知事件，去除未知属性），执行合理的大小限制，**永不转发或记录客户端 IP**（丢弃 `CF-Connecting-IP`），对每个 `machine_id` 设置轻量限速以防止滥用耗尽摄取额度，转发到带有 Worker secret 中项目密钥的 `https://us.i.posthog.com/batch/`。接受时响应 `204`（包括被白名单丢弃的事件），格式错误/超大/限速请求返回诚实的 `4xx`——客户端将每个响应视为最终结果，永不重试。
- 当前后端：PostHog Cloud US，免费计划，"丢弃客户端 IP"已启用，GeoIP 已禁用，自动捕获/回放/热图/Web 指标全部关闭。Worker 是接缝：后续更换后端是 Worker 变更，而非客户端发布。

## synapse-pro 规则（不要在上游合并中丢失此内容）

私有的 `synapse-pro` 分支在客户容器内发布，其保证是"没有任何内容离开容器"——包括遥测。在该分支中，遥测必须**默认关闭且安装器不可启用**（编译时常量或剥离模块），容器也设置 `SYNAPSE_TELEMETRY=0` 作为双重保险。此规则位于该分支的 CLAUDE.md 中，必须在每次上游合并中保留。

## 发布计划

1. 本文档 + 仓库根目录 `TELEMETRY.md`（面向用户的逐字段列表）+ README 章节。
2. Worker + DNS 先上线（使第一个发布的客户端永远不会 404），PostHog 仪表盘：每周活跃机器数、按目标分类的安装数、按工具 × 客户端分类的使用量、版本采用情况、已索引语言。
3. 客户端模块 + 配置 + `synapse telemetry` 子命令 + MCP `clientInfo` 管道。
4. 安装器切换 + 首次运行通知。`CHANGELOG.md` 的 `[Unreleased]` 下添加宣布遥测、默认值及每个关闭开关的条目。发布。

测试（按仓库约定不模拟 DB；在 `globalThis.fetch` 处模拟 fetch）：同意优先级（env > config > default）、关闭 ⇒ 零 fetch 调用、跨天汇总聚合、缓冲区上限 + 损坏缓冲区恢复、MCP 传输下无 stdout 不变式、刷新中止遵守超时、安装器切换持久化 + 重新运行不重新询问（`__tests__/installer-targets.test.ts`，按惯例）。

## 待解问题

- 确切的安装器文案 / 通知措辞——发布前由维护者决定。
- `uninstall` 事件：保留还是删除？（诚实的流失信号 vs "在离开时发 ping"的观感问题。）
- CI 事件保留（标记 `ci: true`），因为引擎在 CI 中运行是真实的使用模式——如果它最终主导流量则重新评估。
