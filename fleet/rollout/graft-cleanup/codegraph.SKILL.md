---
name: codegraph
description: >-
  Ask the code index before reading source: locate symbols, follow calls,
  map a change, and check additions for missing wiring.
when_to_use: >-
  Code navigation, callers, callees, impact, request blast radius,
  pre-push orphan checks and deletion closure.
status: active
tags: [context, code-graph, retrieval, codegraph]
created: 2026-10-29
updated: 2026-10-30
source: /Users/bob/devlop/team-codegraph/CODEGRAPH-COMMANDS.md
---

# CodeGraph

## Scope, freshness and source

1. **Name your absolute worktree on every call.** CLI: `-p <wt>`;
   `status`, `sync` and `checkpoint` take the path as an argument.
   MCP: `projectPath: "<wt>"`. A subagent shares its parent's connection;
   the launch directory does not identify the subagent's worktree.
2. **Returned source is already read.** Read only an uncovered span or a
   file the answer flags as changed on disk since its last index sync.
3. **No build step.** The host seeds new worktrees from an indexed sibling
   and catches up automatically. If it reports building or copying,
   retry shortly; do not abandon CodeGraph for the session. Indexing a
   repository never indexed is the user's decision. Never run `init`,
   `index`, `uninit`, `unlock`, `install`, `uninstall`, `upgrade` or
   `telemetry`. Do not present an unavailable graph as a complete check.
4. **Gates need evidence.** `codegraph checkpoint --fresh <wt>` requests
   bounded catch-up. Inspect and record HEAD, the working-tree hash and
   pending files. Pending files mean incomplete freshness: retry or
   report the incomplete gate, never claim the tree is fully indexed.
   MCP tools accept `fresh: true`; `checkpoint: true` reports without
   waiting. CLI `explore`, `callers`, `callees`, `impact`, `node` and
   `query` accept `--fresh` / `--checkpoint`; `grep`, `blast`, `orphans`
   and `suspects` require the explicit checkpoint first instead.
5. **Use `rg` for text.** Prose, config, YAML, docs, schema strings and
   string literals are not call edges.

## Commands

All CLI queries below carry `-p <wt>` unless the path is positional.
Every MCP call carries `projectPath` too.

| Question | CLI | MCP tool |
|---|---|---|
| a flow's source and path | `codegraph explore <SymA> <Type.method> -p <wt>` | `codegraph_explore {query, projectPath}` |
| a symbol's source and trail | `codegraph node <Symbol> -p <wt>` | `codegraph_node {symbol, projectPath}` |
| a file's API | `codegraph node -f <file> --symbols-only -p <wt>` | `codegraph_node {file, symbolsOnly: true, projectPath}` |
| a file span | `codegraph node -f <file> --offset <n> --limit <n> -p <wt>` | `codegraph_node {file, offset, limit, projectPath}` |
| a symbol by name | `codegraph query <name> -p <wt>` | `codegraph_search {query, projectPath}` |
| direct callers | `codegraph callers <Symbol> -p <wt>` | `codegraph_callers {symbol, projectPath}` |
| outgoing calls | `codegraph callees <Symbol> -p <wt>` | `codegraph_callees {symbol, projectPath}` |
| a symbol's reach | `codegraph impact <Symbol> -d 2 -p <wt>` | `codegraph_impact {symbol, depth: 2, projectPath}` |
| hits grouped by symbol | `codegraph grep <pattern> -p <wt>` | `codegraph_grep {pattern, projectPath}` |
| a diff's reach | `codegraph blast -b <base-ref> -p <wt>` | `codegraph_blast {base, projectPath}` |
| added symbols with no incoming edges | `codegraph orphans -b <base-ref> -p <wt>` | `codegraph_orphans {base, projectPath}` |
| questionable name/low-confidence bindings | `codegraph suspects -p <wt>` | `codegraph_suspects {projectPath}` |
| affected tests | `codegraph affected <files...> -p <wt>` | CLI only |
| layout | `codegraph files -p <wt>` | not enabled in the fleet |
| health | `codegraph status <wt>` | not enabled in the fleet |

`explore` takes precise symbol names: name both ends of the flow; qualify
ambiguous endpoints as `Type.method`. The `-f <file>` selector belongs to
named-symbol commands such as `node`, `callers`, `callees` and `impact`,
not `explore`. Name-only bindings need inspection; an edge is not proof
of certainty.

## Two mandatory gates

**Writing a request:** `codegraph checkpoint --fresh <wt>`, inspect its
pending count, then `codegraph blast -b <base-ref> -p <wt>` over the diff.
For a symbol not yet changed use `codegraph impact SYMBOL -p <wt> --fresh`.
Use `rg` for string/config references. Quote the returned evidence.

**Before squash/push:** take a fresh checkpoint, then
`codegraph orphans -b <base-ref> -p <wt>`. Follow each listed candidate
with `rg -nw SYMBOL` for dynamic/string uses. Protocol/trait implementations
and tests are excluded by the orphan tool. An apparent orphan is a question,
not permission to delete documented API. MCP gates use the same base and
worktree with `fresh: true`.

## Deletion closure

Follow `callees` outward from the retiring code for candidates; then
inspect `callers` of each candidate. Anything with a live caller leaves
the deletion set. Check dynamic/string uses and the published contract
before deleting the rest: documented but unwired is a defect to report.
