/**
 * 在 MCP `initialize` 响应中输出的服务器级别 instructions。
 *
 * MCP 客户端（Claude Code、Cursor、opencode、LangChain、OpenAI Agent
 * SDK 等）会自动将此文本注入智能体的系统提示，让智能体在看到
 * 具体工具描述之前就掌握 synapse 工具集的整体使用策略。
 *
 * 编辑此内容时的目标：
 *   - 按意图选择工具（哪个问题用哪个工具）
 *   - 常见调用链（重构规划 = X 然后 Y）
 *   - 反模式（synapse_search 更快时不要用 grep）
 *
 * 保持简洁。智能体每次会话都会读取此内容——冗长的 instructions 会
 * 消耗大量 token。只引用 `main` 上已存在的工具；条件性工具在发布时
 * 再通过 feature check 进行门控。
 */
export const SERVER_INSTRUCTIONS = `# Synapse — code intelligence over an indexed knowledge graph

Synapse is a SQLite knowledge graph of every symbol, edge, and file in
the workspace — pre-computed structure you would otherwise re-derive by
reading files (cached intelligence: thousands of parse/trace decisions you
don't pay to re-reason each run). Reads are sub-millisecond; the index lags
writes by ~1s through the file watcher. Reach for it BEFORE *and* while
writing or editing code — not just for questions: one call returns the
verbatim source PLUS who calls it and what it affects, so you edit with the
blast radius in view. More accurate context, in far fewer tokens and
round-trips than reading files yourself.

## Use synapse instead of reading files — for questions AND edits

Whether you're answering "how does X work" or implementing a change (fixing
a bug, adding a feature), reach for synapse before you Read. For
understanding, answer DIRECTLY — usually with ONE \`synapse_explore\` call.
\`synapse_explore\` takes either a natural-language question or a bag of
symbol/file names and returns the verbatim source of the relevant symbols
grouped by file, so it is Read-equivalent and most often the ONLY
synapse call you need. Synapse IS the pre-built search index — so
delegating the lookup to a separate file-reading sub-task/agent, or
running your own grep + read loop, repeats work synapse already did and
costs more for the same answer. Reach for raw Read/Grep only to confirm a
specific detail synapse didn't cover. A direct synapse answer is
typically one to a few calls; a grep/read exploration is dozens.

## Tool selection by intent

- **Almost any question — "how does X work", architecture, a bug, "what/where is X", or surveying an area** → \`synapse_explore\` (PRIMARY — call FIRST; ONE capped call returns the verbatim source of the relevant symbols grouped by file; most often the ONLY call you need)
- **"How does X reach/become Y? / the flow / the path from X to Y"** → \`synapse_explore\`, naming the symbols that span the flow (e.g. \`mutateElement renderScene\`) — it surfaces the call path among them, including dynamic-dispatch hops (callbacks, React re-render, JSX children) grep can't follow
- **"What is the symbol named X?" (just its location)** → \`synapse_search\`
- **"What calls this?" / "What would changing this break?"** → \`synapse_callers\` — EVERY call site with file:line, including where a function is **registered as a callback** (passed as an argument, assigned to a function pointer/field, listed in a handler table) — labeled "via callback registration" — so a function with no direct calls is NOT dead if it's wired up somewhere. When several UNRELATED symbols share a name (one \`UserService\` per monorepo app), it reports **one section per definition** (never a merged list) — pass \`file\` to focus the definition you mean. The wider blast radius arrives automatically on \`synapse_explore\` (its "Blast radius" section) and \`synapse_node\` (the dependents note)
- **"What does this call?"** → \`synapse_node\` with that symbol and \`includeCode: true\` — the body IS the callee list, and the caller/callee trail comes with it
- **Reading a source FILE (any time you'd use the \`Read\` tool)** → \`synapse_node\` with a \`file\` path and no \`symbol\`. It returns the file's **current source with line numbers — the same \`<n>\\t<line>\` shape \`Read\` gives you, safe to \`Edit\` from** — narrowable with \`offset\`/\`limit\` exactly like \`Read\`, PLUS a one-line note of which files depend on it. Same bytes as \`Read\`, faster (served from the index), with the blast radius attached. Use it **instead of \`Read\`** for indexed source files; fall back to \`Read\` only for what synapse doesn't index (configs, docs). Pass \`symbolsOnly: true\` for just the file's structure.
- **About to read or edit a symbol you can name** → \`synapse_node\` with that \`symbol\` (SECONDARY — the after-explore depth tool): the verbatim source (\`includeCode: true\`) PLUS its caller/callee trail, so before changing it you see what calls it and what your edit would break. For an OVERLOADED name it returns EVERY matching definition's body in one call, so you never Read a file to find the right overload

## Common chains

- **Flow / "how does X reach Y"**: ONE \`synapse_explore\` with the symbol names spanning the flow — it surfaces the call path among them (riding dynamic-dispatch hops) AND returns their source. No need to reconstruct the path with \`synapse_search\` + \`synapse_callers\`.
- **Onboarding / understanding any area**: ONE \`synapse_explore\` is usually the whole answer. Only follow up — \`synapse_node\` for a specific symbol — if something is still unclear.
- **Refactor planning**: \`synapse_callers\` for the complete call-site list to update; the wider blast radius is already attached to \`synapse_explore\` / \`synapse_node\` output.
- **Debugging a regression**: \`synapse_callers\` of the suspected symbol; \`synapse_node\` on anything unexpected that appears.

## Anti-patterns

- **Trust synapse's results — don't re-verify them with grep.** They come from a full AST parse; re-checking with grep is slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name — \`synapse_search\` is faster and returns kind + location + signature.
- **Don't chain \`synapse_search\` + \`synapse_node\`** to understand an area — ONE \`synapse_explore\` returns the relevant symbols' source together in a single round-trip.
- **Don't loop \`synapse_node\` over many symbols** — one \`synapse_explore\` call returns them all grouped by file, while each separate call re-reads the whole context and costs far more. Use \`synapse_node\` for a single symbol.
- **Don't reach for the \`Read\` tool on an indexed source file** — \`synapse_node\` with a \`file\` reads it for you (same \`<n>\\t<line>\` source, \`offset\`/\`limit\` like Read, faster, with its blast radius), and with a \`symbol\` it returns the source plus the caller/callee trail. Reach for raw \`Read\` only for what synapse doesn't index (configs, docs) or when the staleness banner flags a file as pending re-index.
- **After editing, check the staleness banner.** When a tool response starts with "⚠️ Some files referenced below were edited since the last index sync…", the listed files are pending re-index — Read those specific files for accurate content. Every file NOT in that banner is fresh, so still trust synapse. A different, rarer banner — "⚠️ Synapse auto-sync is DISABLED…" — means live watching stopped entirely (the whole index is frozen, not just a few files); until it's resolved, Read files directly to confirm anything that may have changed.

## Limitations

- If a tool reports a project isn't indexed (no \`.synapse/\`), stop calling synapse tools for that project for the rest of the session and use your built-in tools there instead. Indexing is the user's decision — mention they can run \`synapse init\` if it comes up, but don't run it yourself.
- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Synapse supplements those with structural context they don't have.
`;

/**
 * 工作区**没有** synapse 索引时发送的 instructions 变体。
 *
 * 在每次调用都会失败的会话中发送完整的操作手册（"凡事依赖 synapse"）
 * 会浪费智能体的调用次数——更糟糕的是，失败会让它认为 synapse 已损坏。
 * 未索引变体是简短、明确的"本次会话不可用"说明；`tools/list` 在同一状态下
 * 被门控为空，使智能体无从误调用。索引操作刻意留给用户决定：
 * 智能体被明确告知不要自行运行 init。
 */
export const SERVER_INSTRUCTIONS_UNINDEXED = `# Synapse — inactive (workspace not indexed)

This workspace has no synapse index (no \`.synapse/\` directory), so no
synapse tools are available this session. Work with your built-in tools as
usual.

Indexing is the user's decision — do not run it yourself. If the user asks
about synapse, they can enable it by running \`synapse init\` in the
project root and starting a new session.
`;
