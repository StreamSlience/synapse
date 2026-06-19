/**
 * The marker-fenced agent-instructions block the installer writes into each
 * agent's instructions file (CLAUDE.md / AGENTS.md / GEMINI.md).
 *
 * History: pre-#529 the installer wrote a full usage playbook here, which
 * duplicated the MCP `initialize` instructions for the main agent — so it
 * was removed and `mcp/server-instructions.ts` became the single source of
 * truth. A much smaller block returned for #704, because the MCP
 * instructions cannot reach two audiences that the instructions FILE does
 * reach:
 *
 *  - **Task-tool subagents** — they receive the project instructions file
 *    in their context but NOT the MCP initialize instructions. They hold
 *    the synapse MCP tools only as deferred names and rarely think to
 *    load them: measured on a forced-delegation flow question (excalidraw,
 *    sonnet, high effort), subagents loaded + used synapse in ~1 of 9
 *    runs without this block, and consistently with it — including runs
 *    with zero Read/grep fallback.
 *  - **Non-MCP harnesses** — agents with no MCP client at all can still
 *    run the `synapse explore` / `synapse node` CLI, which prints the
 *    same output as the MCP tools.
 *
 * Keep this block SHORT. The main agent reads it every turn on top of the
 * server instructions — the #529 duplication-cost argument still bounds
 * its size. Command names and the two surfaces, nothing more.
 */

/** Markers used by the marker-based section write/removal. */
export const SYNAPSE_SECTION_START = '<!-- SYNAPSE_START -->';
export const SYNAPSE_SECTION_END = '<!-- SYNAPSE_END -->';

/**
 * The full block, markers included, exactly as written to disk.
 *
 * The wording is deliberately CONDITIONAL ("in repositories indexed by…"):
 * a global install writes this into a user-scope file (~/.claude/CLAUDE.md,
 * ~/.codex/AGENTS.md) that applies to every project the user opens —
 * including unindexed ones, where an unconditional "this repository is
 * indexed" claim would send subagents into failing synapse calls (the
 * noise the unindexed-session policy exists to prevent).
 */
export const SYNAPSE_INSTRUCTIONS_BLOCK = `${SYNAPSE_SECTION_START}
## Synapse

In repositories indexed by Synapse (a \`.synapse/\` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tools** (when available): \`synapse_explore\` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them. \`synapse_node\` returns one symbol's source + callers, or reads a whole file with line numbers. If the tools are listed but deferred, load them by name via tool search.
- **Shell** (always works): \`synapse explore "<symbol names or question>"\` and \`synapse node <symbol-or-file>\` print the same output.

If there is no \`.synapse/\` directory, skip Synapse entirely — indexing is the user's decision.
${SYNAPSE_SECTION_END}`;
