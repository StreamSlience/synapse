# 调用序列分析——为何读取次数的节省无法转化为挂钟时间

**日期：** 2026-05-23 · **分支：** `architectural-improvements` · **数据来源：** A/B 矩阵中保留的 stream-json 日志（`/tmp/ab-matrix/<Cell>/run-headless-{with,without}.jsonl`，37 个单元格 × 2 组）。通过 `scripts/agent-eval/seq-matrix.mjs` 重新挖掘——**无重跑**。

## 背景

[A/B 矩阵](synapse-ab-matrix.md)显示 Synapse 将**读取次数减少了 75%**，但**挂钟时间仅减少约 16%**，且 63% 的挂钟时间节省来自 3 个大型代码库单元格。读取次数已降至最低（约 0），因此剩余的挂钟时间消耗在**往返延迟 + 综合回答轮次**上——这两者都无法用读取次数来解释。矩阵记录的是工具**调用次数**，而非调用**序列**或每次调用的**输出大小**。本分析对两者进行还原，以找出挂钟时间的真正去向。

## TL;DR——瓶颈是 trace 的采用率，而非 trace 的完整性

1. **37 个单元格中只有 3 个调用了 trace**——尽管每个问题都是典型的流程问题（"trace 控制器 → 服务 → 仓库"、"X 如何到达 Y"）。agent 几乎总是选择 **`context → search → search → explore`** 的路径——这正是指引中要求避免的路径重建反模式。
2. **`explore` 平均每次调用 17.9K 字符；`trace` 平均每次 0.8K**——**相差 22 倍的输出大小**。解决小代码库输出膨胀问题的路径限定工具已经存在且体积很小，只是没有被调用。
3. **小型代码库仍然获得臃肿的输出**，原因是默认走 explore：一个 **6 个文件**的代码库（`flutter_module_books`）拉取了 **17.4K**；一个 10 个文件的代码库拉取了 18.0K。这正是"在小型代码库上上下文过多"的失败模式——目前正在通过 explore 发生。
4. **有 Synapse 时往返次数减少 25%（283 vs 375 轮）**，但挂钟时间仅快 16%——因为有 Synapse 的每轮都携带约 18K 的 explore 输出，拉高了首 token 延迟（TTFT），抵消了轮次节省。
5. **根本原因：** `src/mcp/server-instructions.ts` 以 *"直接回答……先调用 `synapse_context`，再调用一次 `synapse_explore`"* 作为主要模式。trace 优先指引被埋在下方的一个表格和调用链列表中。agent 会锚定在显眼的主要模式上 → context→explore。

**决策：** 下一步实验是 **trace 优先引导 / 提升采用率**，而非丰富 trace 内容。在仅 3/37 次使用的情况下，完整性无从谈起。先提升采用率，再衡量后续的 `node`/`explore` 跟进调用是否需要更丰富的 trace。

## 发现 1——trace 采用率：3/37

| 指标 | 值 |
|---|---|
| 流程类问题单元格 | 37（全部）|
| 调用了 `synapse_trace` 的单元格 | **3**（`cpp-leveldb`、`excalidraw`、`c-redis`）|
| 主导模式 | `context` → `search`×N → `explore` |

3 个使用了 trace 的单元格及其后续调用：

| 代码库 | 文件数 | 代码图调用序列 | 轮次（有/无 Synapse）|
|---|--:|---|---|
| cpp-leveldb | 134 | `trace, node, node` | 5 / 8 |
| excalidraw | 643 | `context, trace, trace, explore` | 6 / **19** |
| c-redis | 884 | `context, trace, explore, node` | 10 / 15 |

即使*使用了* trace，agent 也会随后调用 `node`/`explore` 来获取函数体——因此提升采用率之后的第二个杠杆是让单次 trace 调用足够自给自足，以消除这些跟进调用。但那是第二步。

## 发现 2——输出大小：路径限定的 trace（0.8K）vs. 广度扫描的 explore（17.9K）

所有单元格中，每个 synapse 工具的调用次数和**平均每次输出**：

| 工具 | 调用次数 | 平均每次 | 合计 |
|---|--:|--:|--:|
| `explore` | 32 | **17.9K** | 573K |
| `context` | 36 | 4.3K | 156K |
| `search` | 39 | 1.3K | 50K |
| `files` | 5 | 3.4K | 17K |
| `node` | 19 | 2.0K | 38K |
| `trace` | 4 | **0.8K** | 3.4K |

`context`（36/37 个单元格使用）是默认的开场工具；`explore` 是默认的收尾工具。合计约 22K 的广度输出。`trace`——本可以用实际路径替代上述输出的工具——体积小 22 倍，却几乎没有被使用。这从数字上印证了用户的预设：explore 是广度限定的（返回邻近区域），trace 是路径限定的（返回调用链）。

## 发现 3——输出随代码库规模增长，且在小型代码库上过度返回

各规模档位的 explore 输出：

| 档位 | 单元格数 | 平均每次 explore 输出 |
|---|--:|--:|
| 小型（S, <500 个文件）| 19 | 12.7K |
| 中型（M, 500–5K）| 9 | 32.4K |
| 大型（L, >5K）| 9 | 34.0K |

小型代码库的输出浪费最为显著：

| 代码库 | 文件数 | explore 输出 |
|---|--:|--:|
| flutter_module_books | 6 | 17.4K |
| computer-database | 10 | 18.0K |
| express | 147 | 12.0K |
| meilisearch | 197 | 11.1K |

explore 的每次调用预算已经是自适应的（#185），但对此并无帮助——agent 选择的是广度，而非路径。在一个 6 个文件的代码库中，explore 返回的内容超过了 agent 真正需要的数量级。

## 发现 4——往返次数与 ToolSearch 开销

| 指标 | 有 Synapse | 无 Synapse |
|---|--:|--:|
| 总轮次 | 283 | 375 |
| 平均每个单元格 | 7.6 | 10.1 |

有 Synapse 时轮次减少 25%，但挂钟时间仅快约 16%——差距来自有 Synapse 时每轮携带约 18K 的 explore 输出，拉高了首 token 延迟（TTFT），抵消了轮次节省。

此外，每次有 Synapse 的运行都以一次 ToolSearch 往返开头（该测试环境中 MCP 工具延迟加载）。这给每次 synapse 运行额外增加了约 2 次往返，进一步压缩了轮次节省对挂钟时间的收益。

## 结论——下一步实验

**实验：trace 优先引导 A/B**

- **变更：** 将 `src/mcp/server-instructions.ts` 中的主要模式从 `context → explore` 改为流程类问题优先调用 `synapse_trace`
- **指标：** trace 采用率（目标：远超 3/37）、输出大小（预期下降）、轮次（预期下降）、挂钟时间
- **对照：** 非流程类的"X 模块是什么"问题必须仍走 `context → explore`
- **后续：** 采用率提升后，衡量 `node`/`explore` 跟进调用的频率；如果频繁，再丰富 trace 内容

**复现方法：**

```bash
node scripts/agent-eval/seq-matrix.mjs
```

---

# 消融实验——`context`、`explore` 与 `trace` 是否相互竞争？`trace` 是否足够？

**日期：** 2026-05-23 · 52 次运行，约 $20。工具集通过新增的 `SYNAPSE_MCP_TOOLS` 允许名单在**服务端**裁剪（被消融的工具在 ListTools 中真正缺席，而非在调用时被拒绝）；trace 优先引导通过 `--append-system-prompt` 注入。6 个代码库（2 S / 2 M / 2 L）× 2 次运行；arm E 是针对 2 个代码库的**非流程**概览问题。驱动脚本 `arms-matrix.sh`，分析脚本 `parse-arms.mjs`。

| arm | 工具 | 引导 | trace 采用率 | 读取次数 | synapse 输出 | 轮次 | 耗时 |
|---|---|---|--:|--:|--:|--:|--:|
| **A** 对照 | 全部 | 无 | 2/12 | 1.25 | 28.8K | 7.6 | 38s |
| **B** 引导 | 全部 | trace 优先 | **8/12** | 1.00 | **32.0K** | 7.9 | 43s |
| **C** 无 explore | 隐藏 explore | trace 优先 | 8/12 | **2.08** | **9.2K** | 9.0 | 44s |
| **D** trace 中心 | 隐藏 explore+context | trace 优先 | 8/12 | 2.00 | 6.6K | 10.5 | 46s |
| **E** 对照探针 | 隐藏 explore+context | trace 优先 | 0/4 | 2.50 | 27.8K | **20.0** | **72s** |

## 实验说明

1. **引导能提升采用率，但无法降低输出大小。** B 将 trace 使用率从 **2/12 提升到 8/12**（在 4/4 个真正具有路径形态的问题上——2 个未采用的（flutter "有哪些 widget"、vapor "说出路由名称"）并非 from→to 类问题）。但 B 的输出（32.0K）比对照（28.8K）**更大**，而且更慢——因为 agent 在调用 trace **之后仍然调用了 explore**。引导增加了 trace 一跳，却没有取代 explore 的大输出。
2. **`explore` 是输出的来源，且是刚性依赖——但重了 3–5 倍。** 移除它（C）将输出**减少 71%**（32K→9.2K）——证实了它就是膨胀所在。但读取次数**翻倍**（1.0→2.1），轮次也上升：agent 通过读取文件来补回 explore 内联的函数体。因此 explore 不是多余的；它是唯一一个单次调用就能提供函数体的工具，只不过是用 32K 的大锤去完成这件事。
3. **`context` 在三者中最为冗余——至少作为函数体提供者而言。** 在 explore 之上再移除它（D vs C），读取次数基本不变（2.08→2.00），但轮次增加（9.0→10.5）。它不提供任何独特的函数体；它的价值仅在于节省往返延迟（作为组合式定向调用的开场）。
4. **移除工具让流程问题变慢，而非更快。** 轮次沿 A→D 单调递增（7.6→10.5），耗时随之增加——读取文件和 trace 跟进调用的往返延迟，比节省的输出大小消耗更多挂钟时间。输出更精简 ≠ 速度更快。
5. **`trace` 明确不够用。** 非流程探针（E）在没有概览工具的情况下陷入混乱——**20 轮、72s**，用 search/node/files 重建概览。概览类问题需要概览工具；trace 无法替代。

## 三个设计问题的结论

- **需要全部三个工具吗？** 是的——但原因不同。trace = 流程工具（真实存在，采用率不足）。explore = 单次调用提供函数体的工具（刚性依赖，过重）。context = 节省往返延迟的开场工具（对函数体而言冗余，对定向有用）。
- **三者相互竞争吗？** 是的：explore 与 trace 竞争，且**默认获胜**——即使有引导，agent 仍然既调用 trace 又调用 explore，因此在 explore 被取代之前，输出节省从未实现。
- **trace 能成为全部吗？** 不能。E 排除了非流程问题的可能性；C/D 甚至对流程问题也排除了（移除 explore 导致读取次数翻倍）。

**数据已排除三种廉价方案：** "只需 trace"（否）、"仅靠引导 trace"（B：比对照更慢更大），以及"移除 explore"（C/D：更多读取/轮次，更慢）。

## 数据指向的修复方案——下一步实验

唯一获胜的路径：**通过内联每跳函数体（每跳有上限→仍保持路径限定）使 `trace` 自给自足**，让一次 trace 调用既能提供 explore 的内容，又能提供读取文件回退所补回的内容——对流程问题同时取代两者。保留**一个**概览工具（context；将 explore 降级为深度概览，而非流程默认）用于 E 证明是刚性依赖的非流程问题。

- **实验：** 带函数体内联的 trace + 引导 vs 对照。
- **目标：** C/D 的精简输出（约 7–9K，而非 32K）**且不增加** C/D 的额外读取/轮次，并**在挂钟时间上超越 A**（B/C/D 均未达到的标准）。
- **指标：** 输出大小、读取次数（必须保持约等于 A 的 ~1.0，而非上升到 2.0）、轮次、耗时。

## 复现方法（消融实验）

```bash
bash scripts/agent-eval/arms-matrix.sh     # 52 次运行（RUNS=2）
node scripts/agent-eval/parse-arms.mjs
```

---

# 验证——正文内联 trace（arm F）

**日期：** 2026-05-23 · 12 次运行，约 $5。Arm F = arm B 的调用方式（全部工具 + `--append-system-prompt` trace 优先引导），仅 trace 工具更换为**正文内联版本**（每跳最多 28 行，带目标节点的被调用者列表）。F vs B 隔离正文内联特性；F vs A 是相对于发布基线的净增益。

| arm | trace 采用率 | 读取次数 | 输出大小 | 轮次 | 耗时 | 费用 |
|---|--:|--:|--:|--:|--:|--:|
| A 对照（无引导，无正文 trace）| 2/12 | 1.25 | 28.8K | 7.6 | 38s | $0.390 |
| B 引导（无正文 trace）| 8/12 | 1.00 | 32.0K | 7.9 | 43s | $0.423 |
| **F 正文 trace + 引导** | **5/12** | **1.17** | **25.1K** | **6.8** | **37s** | **$0.348** |

F 是各维度最均衡的 arm：**最低轮次（6.8）、最快（37s）、最便宜（$0.348）**，且读取次数低于 A（1.17 vs 1.25）。正文内联将 B 的 explore 跟进调用转化为 trace 自给自足，将 32K 的输出降至 25.1K，并收回了 B 相比 A 损失的速度。

**连通才是决定性因素。** 在 trace 能够连通的地方，提升最为显著——excalidraw（已验证的 6 跳路径）：

| arm | 调用序列 | 轮次 | 读取次数 | 耗时 |
|---|---|--:|--:|--:|
| B（无正文）| `trace → context → explore → Grep → Read` | 7 | 1 | 47s |
| **F（有正文）r1** | `trace → context` | **4** | **0** | **31s** |
| F（有正文）r2 | `trace → trace → explore` | 5 | 0 | 42s |

正文 trace 在 `trace → context`（run 1）就结束了调查——0 读取、0 Grep、0 explore。

**连通性是上限。** 在*未桥接*动态分发处断裂的流程上——aspnet-realworld（MediatR `_mediator.Send → Handle`）、vapor-spi（闭包路由）——trace 返回"无路径"，agent 回退到 explore，因此 F ≈ B（无回退，无提升）。F 的聚合增益因此**受动态分发覆盖范围的制约**：图谱端到端连通的流程越多，自给自足的 trace 触发越频繁。（n=2/arm——采用率和单个代码库的数字存在噪声；excalidraw 和 spring-halo 这两个连通代码库，在 B 和 F 中均为 2/2 trace。）

## 结论与发布清单

1. **发布正文内联 trace**——严格改进（各维度最均衡的 arm；在连通 trace 上实现 0 读取/4 轮的干净提升；在不连通的 trace 上无回退）。
2. **加强引导。** Arm A（已发布的 server-instructions，其中*已经*写了"流程问题优先 trace"）trace 采用率仅 2/12——指引被埋得太深。B–F 中使用的显式 `--append-system-prompt` 提升了采用率。将其移植到 `server-instructions.ts` + `instructions-template.ts` + `.cursor/rules/synapse.mdc`（规则：三处同步更新），加流程问题门控，使非流程概览问题仍走 context/explore（arm E 证明了这一点是必要的）。
3. **扩大 F 覆盖范围的下一个前沿：** 桥接更多动态分发（MediatR/.NET、Vapor 路由）——每新连通一条流程，就将一个 F≈B 的代码库转化为 F 获胜的代码库。

## 复现方法（arm F）

```bash
bash scripts/agent-eval/arms-F.sh          # 12 次运行（RUNS=2）；需要正文内联构建
node scripts/agent-eval/parse-arms.mjs     # F 与 A/B/C/D/E 并排显示
```

---

# 引导移植——负结果（arm G）

F 的胜利使用了 `--append-system-prompt`，真实用户无法获得这个条件。Arm **G** = arm A 的调用方式（无 append-prompt），在将引导移植到生产渠道的构建上运行（`server-instructions.ts` + `context`/`trace` 工具描述 + `instructions-template.ts` + `.cursor/rules`）。三种措辞变体，每种 12 次运行：

| arm | trace 采用率 | 读取次数 | 输出大小 | 轮次 | 耗时 |
|---|--:|--:|--:|--:|--:|
| A（已发布指引）| 2/12 | 1.25 | 28.8K | 7.6 | **38s** |
| F（正文 trace + append-prompt）| 5/12 | **1.17** | 25.1K | 6.8 | **37s** |
| G v1——反 explore 措辞 | 6/12 | 2.08 | 13.8K | 8.8 | 46s |
| G v2——恢复 explore 作为回退 | 6/12 | 1.67 | 22.0K | 7.8 | 46s |
| G v3——恢复 context 作为开场 | 6/12 | 2.08 | 11.7K | 8.9 | 46s |
