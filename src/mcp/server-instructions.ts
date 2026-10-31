/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients (Claude Code, Cursor, opencode, LangChain, OpenAI Agent
 * SDK, …) surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the codegraph toolset
 * before it sees individual tool descriptions.
 *
 * This is the single source of agent-facing tool guidance (issue #529), and
 * the only text the server sends: there is no per-root variant, because the
 * machine server has no default project. It states the two session rules the
 * call guard enforces (src/extensions/host/server/repo-anchor.ts): `projectPath`
 * is required on every call (the exact missing-argument answer is
 * MISSING_PROJECT_PATH_TEXT there), and a session answers only for the
 * repository it was launched in and that repository's worktrees, or, launched
 * outside git, only the launch directory and what is below it.
 *
 * Goals when editing this:
 *   - Lead the agent to codegraph_explore for any structural/flow question
 *   - Reinforce "explore instead of Read/Grep" for indexed code
 *   - Anti-patterns (don't re-verify with grep; don't hand-reconstruct flows)
 *
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. The DEFAULT MCP surface is `codegraph_explore` ALONE (see
 * DEFAULT_MCP_TOOLS in tools.ts) — reference only that tool here. The other
 * tools (node/search/callers/…) stay defined and are re-enablable via
 * CODEGRAPH_MCP_TOOLS, but they are NOT listed to agents, so don't name them.
 * The one exception is the focus paragraph: every session is shown it, whatever
 * its tool list, and it names `codegraph_search`, `codegraph_explore`,
 * `codegraph_callers` and `codegraph_impact`, the tools a focus narrows or
 * orders. Callers and impact are named because their out-of-focus section is the
 * one place a focused session sees what the focus held back. The text is the same
 * for every session (the proxy sends it too), so it states what a focus does, not
 * whether this session has one.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph — code intelligence over an indexed knowledge graph

Codegraph is a SQLite knowledge graph of every symbol, edge, and file in
the workspace — pre-computed structure you would otherwise re-derive by
reading files (cached intelligence: thousands of parse/trace decisions you
don't pay to re-reason each run). It indexes 30+ languages
(TypeScript/JavaScript, Python, Go, Rust, Java, C#, C/C++, PHP, Ruby, Swift,
Kotlin, and more) — don't assume a language here isn't covered. Reads are
fast; the index lags writes by ~1s through the file watcher. Reach for it BEFORE *and* while
writing or editing code — not just for questions: one call returns the
verbatim source PLUS who calls it and what it affects, so you edit with the
blast radius in view. More accurate context, in far fewer tokens and
round-trips than reading files yourself.

## One tool: codegraph_explore — use it instead of reading files

There is a single tool, \`codegraph_explore\`, and it is Read-equivalent. It
takes either a natural-language question or a bag of symbol/file names and
returns the **verbatim, line-numbered source** of the relevant symbols
grouped by file — the same \`<n>\\t<line>\` shape \`Read\` gives you, safe to
\`Edit\` from — PLUS the call path among them (including dynamic-dispatch hops
like callbacks, React re-render, and JSX children that grep can't follow) and
a blast-radius summary of what depends on them.

Whether you're answering "how does X work" or implementing a change (fixing a
bug, adding a feature), call \`codegraph_explore\` before you Read. ONE call
usually answers the whole question. Codegraph IS the pre-built search index —
so running your own grep + read loop, or delegating the lookup to a separate
file-reading sub-task/agent, repeats work codegraph already did and costs more
for the same answer. A direct codegraph answer is typically one to a few
calls; a grep/read exploration is dozens.

## Every call needs \`projectPath\`

This server has no default project. Pass \`projectPath\` — the root path of the code you want to query — on every \`codegraph_explore\` call. A call without it is answered exactly \`missing argument: root path to the code you wish to query\`; add the argument and call again.

The session answers only for the repository it was launched in and that repository's git worktrees (siblings of this checkout included: pass a sibling worktree's path to query it), or, launched outside git, only the launch directory and what is below it. A \`projectPath\` outside them is answered with guidance naming the repository this session covers, not with results and not with an error: use your built-in tools (Read/Grep/Glob) for code elsewhere.

## Focus

A session may be started with \`--focus <dir>\` (repeatable; directories relative to the repository root). With a focus, \`codegraph_search\` and \`codegraph_explore\` return only code inside those directories; pass \`scope: "repo"\` to search the whole repository instead (\`scope\` has no effect when the session has no focus). \`codegraph_callers\` and \`codegraph_impact\` always cover the whole repository: the in-focus results come first, and those outside the focus are listed after them under \`## Outside focus (N)\`. An answer that says nothing is inside the focus is not an error: for \`codegraph_search\` and \`codegraph_explore\`, repeat the call with \`scope: "repo"\`. \`codegraph_callers\` and \`codegraph_impact\` take no \`scope\`; their headline counts (\`N found\`, \`affects N symbols\`) count the in-focus results only, and the rest are listed under \`## Outside focus (N)\`.

## How to query

- **Almost any question — "how does X work", architecture, a bug, "what/where is X", or surveying an area** → \`codegraph_explore\` with a natural-language question or the relevant names. ONE capped call returns the verbatim source grouped by file; most often the ONLY call you need.
- **"How does X reach/become Y? / the flow / the path from X to Y"** → \`codegraph_explore\`, naming the symbols that span the flow (e.g. \`mutateElement renderScene\`) — it surfaces the call path among them, riding dynamic-dispatch hops, and returns their source.
- **Reading or editing a file/symbol you can name** → put its name or file path in the \`codegraph_explore\` query — it returns that current line-numbered source (safe to \`Edit\` from) with the call path and blast radius attached, so you don't Read it separately. For an overloaded name it returns every matching definition's body in one call.
- **Need more?** Call \`codegraph_explore\` again with more specific names — treat the source it returns as already Read. Suggested call counts are advisory only, NOT a quota; extra calls are never rejected or rate-limited.
- Qualified symbol names accept dots, \`::\`, or slashes, including containers whose names contain dots (for example, \`AppWeb.Format.group\`).
- Named-symbol call paths require exact matches; partial or mistyped names are never silently substituted as flow endpoints. If a graph query reports a missing symbol with did-you-mean suggestions, query the suggested name explicitly.
- Explore matches names and indexed code words lexically, not by meaning; an empty result reports word matches and may suggest indexed candidate names to retry with \`codegraph_explore\`.

## Anti-patterns

- **Trust codegraph's results — don't re-verify them with grep.** They come from a full AST parse; re-checking with grep is slower, less accurate, and wastes context.
- **Don't grep or Read first** to find or understand indexed code — ONE \`codegraph_explore\` returns the relevant symbols' source together in a single round-trip. Reach for raw \`Read\`/\`Grep\` only to confirm a specific detail codegraph didn't cover, or for what codegraph doesn't index (configs, docs).
- **Don't reconstruct a flow by hand** — name the endpoints in one \`codegraph_explore\` and it surfaces the path between them, dynamic-dispatch hops included.
- **After editing, check the staleness banner.** When a tool response starts with "⚠️ Some files referenced below were edited since the last index sync…", the listed files are pending re-index — Read those specific files for accurate content. Every file NOT in that banner is fresh, so still trust codegraph. A different, rarer banner — "⚠️ CodeGraph auto-sync is DISABLED…" or "⚠️ CodeGraph auto-sync is RECOVERING…" — means the whole index may be stale; until the full catch-up completes, Read files directly to confirm anything that may have changed. If a response refuses to answer from changed files or says freshness could not be verified within its budget, retry after sync or narrow the query; that refusal is not an error in the tool.
- **A file flagged "⚠ changed on disk after the last index sync" drifted from its index** (most common on projects another process writes, and on in-process reads, which have no watcher here). Codegraph never serves a possibly-mis-sliced body from such a file — it either shows the file's full CURRENT source (trust it as a Read) or omits the source with this flag. When the source was omitted, Read that specific file; line numbers referencing it elsewhere in the response may be shifted until that project's next sync. All unflagged files remain trustworthy.

- **Source is re-served on every call by default**, including for fresh subagents and after context compaction. Cross-call dedup requires \`CODEGRAPH_EXPLORE_DEDUP=1\` and is only suitable for hosts that guarantee one durable context per connection. With that opt-in, **"Already sent earlier in this conversation"** points to exact, unchanged source returned by an earlier \`codegraph_explore\` in that context. Use that copy; don't re-fetch it and don't Read the file. The bytes it freed went into source you have not seen yet, elsewhere in the same response.

## Limitations

- The server builds a missing index itself, from its own build queue, and the answer says so: when it says the index is being built, use your built-in tools (Read/Grep/Glob) for that code meanwhile and retry the same \`projectPath\` later. Never run indexing yourself. If an answer says a project isn't indexed (no \`.codegraph/\`) and the server will not build it (a plain directory such as your home directory or a filesystem root), use your built-in tools for that code; if it comes up, mention that the user can index it with \`codegraph init\` in that project.
- A git worktree with no index of its own gets one on its first call: copied from another indexed worktree of the same repository or, when there is none, built in the background. A git repository nested inside another indexed checkout is its own repository, so the outer index does not answer for it; it gets its own index the same way on its first call from a session launched inside that repository. A plain directory (not in git) with no index is built in the background at the directory this session was launched in, whichever path inside it you pass. While a copy or build runs, the call answers that it is building: retry later, since a large repository takes minutes. If an answer says codegraph does not build an index for a directory (such as your home directory) or that a build failed, use your built-in tools there. Pass the worktree or directory itself as \`projectPath\`.
- Index lags file writes by ~1 second. Pass \`fresh: true\` to any tool to wait (bounded) until the index matches the working tree before it answers; \`fresh\` or \`checkpoint: true\` ends a successful answer with a \`Checkpoint:\` line (git HEAD, uncommitted-changes hash, pending file count). (\`fresh\` itself never creates an index.)
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Codegraph supplements those with structural context they don't have.
`;
