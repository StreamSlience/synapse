# synapse 遥测数据采集 Worker

`telemetry.getsynapse.com` 背后的第一方端点。该目录**有意**放在公开仓库中：这正是接收 Synapse 匿名使用遥测数据的完整代码，任何人都可以审计其存储内容。Schema 契约（每个事件、每个字段，以及永远不会采集的内容）详见 [`docs/design/telemetry.md`](../docs/design/telemetry.md)。

一句话概括其功能：对传入的批量数据按严格白名单进行校验（未知事件直接丢弃，未知属性自动剥除），从不读取或转发客户端 IP，按机器 ID 进行限速，并在响应路径之外将数据转发至 PostHog。它不会随 npm 包一起发布——引擎的 `files` 白名单已将其排除。

## 端点契约

- `POST /v1/events` — JSON 请求体：信封（`machine_id` UUID、`synapse_version`、`os`、`arch`、`node_major`、`ci`、`schema_version`）+ `events: [{event, ts?, props?}]`。接受时响应 `204`（包括被白名单丢弃的事件），对格式错误、超大或被限速的请求返回诚实的 `4xx`。客户端将每次响应视为最终结果——不重试。
- `GET /` — 纯文本，指向文档和关闭开关。

## 部署

前提条件：部署所用 Cloudflare 账号上需有 `getsynapse.com` Zone（自定义域名路由会自动配置 DNS 和证书），wrangler ≥ 4.36（需要 `ratelimits` binding）。

```bash
cd telemetry-worker
npm install
npx wrangler login                      # 首次执行一次
npx wrangler secret put POSTHOG_KEY     # phc_… 项目写入密钥——不要提交到仓库
npm run deploy
```

PostHog 项目本身必须启用 **"Discard client IP data"**——这是在 Worker 从不转发 IP 之上的纵深防御（每个事件也会设置 `$geoip_disable`）。

## 本地开发与检查

```bash
cp .dev.vars.example .dev.vars   # 占位密钥；同时供 `wrangler types` 使用
npm run check                    # wrangler types + tsc --noEmit + deploy --dry-run
npm run dev                      # http://localhost:8787

curl -i localhost:8787/v1/events -H 'content-type: application/json' -d '{
  "machine_id": "00000000-0000-4000-8000-000000000000",
  "synapse_version": "0.9.9", "os": "darwin", "arch": "arm64",
  "node_major": 22, "ci": false, "schema_version": 1,
  "events": [{ "event": "usage_rollup",
               "props": { "kind": "mcp_tool", "name": "synapse_explore",
                          "count": 12, "error_count": 0, "client_name": "Claude Code" } }]
}'
```

## 变更 Schema

`src/index.ts` 中的白名单与 `docs/design/telemetry.md`（以及面向用户的 `TELEMETRY.md`）保持镜像同步。新增字段须通过同一个 PR 同时修改所有相关文件——这正是该设计的核心意图。
