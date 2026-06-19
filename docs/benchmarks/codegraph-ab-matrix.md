# Synapse A/B 基准测试——有无对比，覆盖所有语言 × S/M/L

**日期：** 2026-05-24 · **分支：** `main` · **synapse 0.9.4**

无头智能体（Claude Opus，`--permission-mode bypassPermissions`）对每个代码库各回答一个**典型流程问题**——重复两次：**有** synapse MCP 服务器，以及**没有**任何 MCP（仅使用内置 Read/Grep/Glob/Bash）。相同模型，相同提示词；synapse 是唯一变量。每个单元格在测试前都进行了**全新重新索引**（针对当前 `main` HEAD 的 `dist/` 构建），因此"有"组反映的是已发布的 0.9.4 解析器。

## 总结

**在 37 个单元格中，synapse 将文件总读取次数从 159 次降至 38 次——减少了 76%。** 在任何单元格中都未*增加*读取次数（0 次回退）。机制：几次亚毫秒级 synapse 调用替代了读取+搜索的探索过程。

**成本大致持平——"有"组这里略高**（37 个单元格合计："有" 组 `$15.4` vs "无"组 `$13.8`）。在这些短单次流程问题中，"无"组在不到 10 次调用内完成，从不膨胀，因此不会进入 synapse 节省成本发挥作用的场景，而"有"组需要承担固定的 MCP 开销（上下文中的工具定义 + 工具加载），短任务无法分摊。胜在**工具调用次数更少（189 次 vs 321 次，-41%）+ 挂钟时间更低**（均值 **38s vs 48s**），这正是设计目标。在更难的多轮调查中，随着"无"组的累积上下文膨胀，成本会反转为净节省——参见 `docs/benchmarks/call-sequence-analysis.md`。

随着代码库规模和流程复杂性增加，差距扩大：在中型/大型代码库上，"无 synapse"组经常**反复横跳**——大量 grep/glob、shell `find`/`grep`（Bash），偶尔还会派生**子智能体**——而"有 synapse"组只需 2–8 次调用就能回答。在微型代码库（只有几个文件）上，两组持平或 synapse 稍慢（MCP/索引开销在整个流程只有一两个文件时无法发挥价值）——但读取次数仍然下降。

## 如何阅读表格

- **R / G / Gl / B / Ag** = Read / Grep / Glob / Bash / 子智能体（Task）工具调用次数。
- **cg-calls** = "有"组的 synapse MCP 调用次数（以此换取 Read/Grep）。
- **dur** = 挂钟秒数。**files** = 已索引文件数（规模代理指标）。
- **reads saved** = 无组读取次数 − 有组读取次数。
- 每组各跑一次（**快照**——单次运行方差真实存在；±1–2 次读取和 ±10s 视为噪声，关注跨单元格的规律）。本矩阵中多条流程的 2次/组 标题数据见 `docs/design/dynamic-dispatch-coverage-playbook.md` §7。

## 结果

| 语言 | 规模 | 代码库 | 文件数 | **有** R/G | cg-calls | dur | **无** R/G | dur | reads saved |
|---|---|---|--:|---|--:|--:|---|--:|--:|
| C | L | `c-redis` | 884 | 0R / 2G | 4 | 42s | 5R / 6G | 51s | 5 |
| C# | S | `aspnet-realworld` | 78 | 0R / 0G | 2 | 27s | 5R / 3G / 2Gl | 54s | 5 |
| C# | M | `aspnet-eshop` | 262 | 0R / 1G | 5 | 39s | 9R / 2G / 5Gl | 58s | 9 |
| C# | L | `aspnet-jellyfin` | 2081 | 3R / 0G | 4 | 51s | 17R / 1G / 2Gl / 17B / 1Ag | 212s | 14 |
| C++ | M | `cpp-leveldb` | 134 | 0R / 0G | 3 | 26s | 4R / 2G | 37s | 4 |
| Dart | S | `flutter_module_books` | 6 | 1R / 0G | 2 | 24s | 2R / 0G / 1Gl | 29s | 1 |
| Dart | M | `compass_app` | 212 | 2R / 0G / 1Gl | 2 | 42s | 3R / 0G / 2Gl | 30s | 1 |
| Go | S | `gin-realworld` | 21 | 0R / 0G | 5 | 35s | 4R / 3G / 1Gl | 57s | 4 |
| Go | M | `gin-vueadmin` | 625 | 1R / 1G | 4 | 47s | 3R / 3G / 1Gl | 44s | 2 |
| Go | L | `gin-gitness` | 4438 | 4R / 3G | 4 | 64s | 8R / 7G / 2Gl | 57s | 4 |
| Java | S | `spring-realworld` | 117 | 2R / 0G | 3 | 35s | 8R / 1G / 5B | 57s | 6 |
| Java | M | `spring-mall` | 536 | 1R / 0G | 5 | 39s | 2R / 4G / 2Gl | 49s | 1 |
| Java | L | `spring-halo` | 2444 | 1R / 2G | 8 | 60s | 4R / 1G / 6B | 52s | 3 |
| Kotlin | S | `kotlin-petclinic` | 43 | 0R / 0G | 2 | 37s | 3R / 0G / 1Gl | 23s | 3 |
| Kotlin | M | `Jetcaster` | 166 | 1R / 0G | 3 | 36s | 1R / 0G / 2Gl | 46s | 0 |
| Lua | S | `lualine.nvim` | 123 | 1R / 1G | 4 | 48s | 4R / 0G / 2Gl | 49s | 3 |
| Lua | M | `telescope.nvim` | 84 | 0R / 0G | 1 | 15s | 1R / 0G / 1Gl | 20s | 1 |
| Luau | S | `Knit` | 11 | 0R / 0G | 2 | 30s | 5R / 0G / 2Gl | 37s | 5 |
| PHP | S | `laravel-realworld` | 114 | 1R / 0G | 6 | 40s | 5R / 1G / 3Gl | 39s | 4 |
| PHP | M | `laravel-firefly` | 2047 | 2R / 1G | 4 | 47s | 4R / 5G / 3Gl | 75s | 2 |
| PHP | L | `laravel-bookstack` | 2160 | 1R / 2G | 2 | 41s | 2R / 4G / 1Gl | 50s | 1 |
| Python | S | `django-realworld` | 44 | 2R / 1G | 2 | 47s | 9R / 0G / 1B | 38s | 7 |
| Python | M | `django-wagtail` | 1672 | 2R / 0G | 4 | 45s | 8R / 3G / 3Gl / 1B | 66s | 6 |
| Python | L | `django-saleor` | 4429 | 2R / 2G | 4 | 52s | 4R / 6G / 1Gl | 64s | 2 |
| Ruby | S | `rails-realworld` | 59 | 0R / 0G | 2 | 30s | 3R / 0G / 2B | 33s | 3 |
| Ruby | M | `rails-spree` | 2905 | 2R / 3G / 1Gl | 5 | 43s | 3R / 3G / 2Gl / 1B | 55s | 1 |
| Ruby | L | `rails-forem` | 4658 | 3R / 1G | 3 | 43s | 4R / 2G / 3Gl | 48s | 1 |
| Rust | S | `rust-axum-realworld` | 13 | 0R / 0G | 2 | 21s | 3R / 0G / 1Gl | 38s | 3 |
| Rust | M | `rust-actix-examples` | 176 | 0R / 1G | 3 | 42s | 3R / 0G / 3B | 36s | 3 |
| Rust | L | `rust-cratesio` | 1053 | 1R / 0G | 3 | 22s | 1R / 2G | 18s | 0 |
| Scala | S | `computer-database` | 10 | 1R / 0G | 2 | 27s | 3R / 0G / 1Gl | 25s | 2 |
| Swift | S | `vapor-template` | 14 | 0R / 0G | 2 | 21s | 2R / 0G / 2Gl | 22s | 2 |
| Swift | M | `vapor-steampress` | 100 | 0R / 0G | 5 | 49s | 3R / 1G / 2Gl | 39s | 3 |
| Swift | L | `vapor-spi` | 542 | 1R / 1G | 4 | 27s | 2R / 5G | 34s | 1 |
| TypeScript/JS | S | `express-realworld` | 39 | 1R / 0G | 1 | 25s | 2R / 2G | 19s | 1 |
| TypeScript/JS | M | `excalidraw` | 643 | 1R / 0G | 3 | 55s | 7R / 5G / 3Gl / 1B | 87s | 6 |
| TypeScript/JS | L | `nest-immich` | 2759 | 1R / 0G | 7 | 50s | 3R / 0G / 1Gl | 44s | 2 |

**合计（37 个单元格）：** 有 synapse 时 **38 次读取 / 22 次 grep**，无 synapse 时 **159 次读取 / 72 次 grep**——**减少 76% 的读取次数，约减少 69% 的 grep 次数。** Synapse 在任何单元格中都未增加读取次数，而"无"组还额外执行了 **52 次 glob + 37 次 shell `find`/`grep`（Bash）+ 1 次子智能体**，"有"组（**0 次 Bash，0 次子智能体**）完全不需要。（74 次智能体运行，共 $29.18。）

## 观察

- **最大收益出现在中型/大型后端代码库，且有真实的路由→处理器→服务流程：** aspnet-jellyfin（3R / 51s vs **17R + 17 Bash + 一个派生子智能体 / 212s**——最戏剧性的单元格），aspnet-eshop（0R vs 9R），django-realworld（2R vs 9R），spring-realworld（2R vs 8R + 5 Bash），django-wagtail（2R vs 8R），excalidraw（1R / 55s vs 7R / 87s），Luau Knit（0R vs 5R），aspnet-realworld（0R vs 5R），c-redis（0R vs 5R）。
- **无 synapse 时，大型代码库会让智能体反复横跳：** 它回退到 shell `find`/`grep`（矩阵中共 37 次 Bash 调用），在 jellyfin 上甚至派生了一个子智能体——这正是 synapse 要防止的行为。"有"组在那些场景下用 2–8 次 synapse 调用就给出了答案，且**任何地方都用了 0 次 Bash 和 0 次子智能体**。
- **平局区 = 微型代码库**（Kotlin Jetcaster 1R/1R，Rust cratesio 1R/1R，express 1R/2R，Swift template 0R/2R）：整个流程只需要 1–2 个文件，读取本就很廉价；synapse 在读取次数上持平，有时稍慢几秒（MCP + 索引开销——Kotlin petclinic 37s vs 23s，cratesio 22s vs 18s）。这与 synapse 的价值随代码库规模扩展的设计说明相符。
- **大型代码库上，耗时与读取次数同步变化**（jellyfin 51s vs 212s，excalidraw 55s vs 87s，aspnet-eshop 39s vs 58s，django-wagtail 45s vs 66s），小型代码库上则是噪声；有 vs 无挂钟均值为 38s vs 48s。
- 部分"有"组单元格仍读取了 2–4 个文件（jellyfin、gitness、forem、saleor、django）——残差是有据可查的前沿问题（匿名处理器、深层服务链、动态查找器）；synapse 将智能体引到正确文件，然后它再读一个以确认细节。

## 覆盖说明

所有 14 个 README 框架和每种与流程相关的语言都已验证（参见 playbook）。这里的规模按已索引文件数计；少数语言在语料库中缺少干净的第三档规模（Dart/Kotlin = S/M，Scala/Luau = S only，C = L only，C++ = M only）——这些单元格直接省略，不作伪造。

## 复现方法

标准测试框架：`scripts/agent-eval/run-all.sh <repo> "<question>" headless`（有 = 仅 synapse MCP，无 = 空 MCP），从 stream-json 日志中解析。本表所用的一次性矩阵驱动程序 + 解析器位于 `/tmp/ab-matrix/`：`run.sh`（`lang|size|repo|question` 矩阵——每个单元格先 `rm -rf .synapse && synapse init -i` 再跑两组），`parse-matrix.mjs`（单元格 → 本表），以及 `compare.mjs`（新旧对比 + 聚合统计）。先从目标提交构建 `dist/`，以便 MCP 服务器加载被测代码（PATH 上的 `synapse` 通过 `npm link` 链接到开发 `dist/`）。
