# Fleet production rollout, go-live step 1, staged for Bob's go-ahead

Feature `fleet-rollout`, 2026-10-29; brief `design/Orc-Codegraph/ledger/reports/fleet-production-rollout.md`,
as narrowed by Orc-Codegraph's rulings #98, #102, #104 and #112 (settled S-8, S-9) and extended by #110 (per-team
config): the agent instructions and graft's removal are Bob's crew's (`CODEGRAPH-COMMANDS.md`,
`graft-removal.md`), worktree indexes are seeded by CodeGraph itself (host's `worktree-lifecycle`), so no zone.mk
change is staged here, and codeteam owns its MCP entry (`share/mcp-codegraph.json`, decision 82). Every file describes one
change to shared state with its exact diff and its undo. None has been applied.

## Apply in this order

| # | Write-up | Shared state | Waits on |
|---|---|---|---|
| 1 | `global-install.md` | `/opt/homebrew` npm prefix: 1.5.0 out, 1.6.2-sm.N (`fleet/pack.sh`) in | nothing |
| 2 | `mcp-json.md` (+ `mcp-json.patch`) | `codeteam/share/mcp-codegraph.json`: `CODEGRAPH_QUERY_POOL_SIZE=0` added to codeteam's staged entry | nothing |
| 3 | `claude-json.md` | `~/.claude.json`: the stale user-scope 1.5.0 entry removed | nothing |
| 4 | `per-team-mcp.md` (+ `codeteam-mcp.patch`) | codeteam's launch code: a manifest's `mcp_configs` adds MCP files for that team; then one manifest line per team switches it on | proposal to codeteam's maintainer; switching a team on waits on 1, 2 and host's `worktree-lifecycle` (S-9), and the order is Bob's (Q-7) |

Undo, in reverse order: `rollback.md`.

## The package (`fleet/pack.sh`)

`fleet/pack.sh <N> [ref] [out-dir]` builds a ref of the fork in a `git archive` export and packs it as
`@colbymchenry/codegraph@<base>-sm.<N>`, the version stamped in the export only (never committed). It writes a
`.txt` beside the tarball naming the commit. `N` is a whole number with no leading zero; a relative out-dir is
taken from the caller's folder.

Tested on this Mac (Node v26.12.0, 18 cores), into throwaway npm prefixes only, never the global one:

| Check | sm.1 from 01e0ac3a, `CODEGRAPH_ALLOW_UNSAFE_NODE=1` | sm.1 from `ours` 835aaa32 (node-25-support), no override |
|---|---|---|
| `fleet/pack.sh 1 <ref> <out>` | 110 s wall, 36 s user | 34.4 s wall, 36.5 s user, 5.3 s sys (load 13-21) |
| `npm install -g --prefix <tmp> <tgz>` | 13 packages, 11 s | 13 packages, 2.4 s; no `EBADENGINE` (`engines`: `node >=20.0.0`) |
| `codegraph --version` | `1.6.2-sm.1`; without the override: the >=25 banner, exit 1 | `1.6.2-sm.1`, exit 0, no banner |
| cold `codegraph init -i`, 12-file repo | 5.6 s | 2.4 s wall; 12 files, 553 nodes, 1,434 edges; `node:sqlite`, WAL |
| `serve --mcp` `tools/list` (`test-tools/mcp-list.mjs`) | ~1 s; `codegraph_explore` only | 0.42 s; `codegraph_explore` only |
| same, `CODEGRAPH_MCP_TOOLS=explore,node,search,callers,callees,impact` | the six | 0.45 s; `codegraph_search, _callers, _callees, _impact, _node, _explore` |
| `CODEGRAPH_QUERY_POOL_SIZE=0` reaches the daemon | daemon log: query pool disabled | not re-run (no change in `src/mcp` between the refs) |
| watcher auto-sync, 12-file repo | — | one append, one auto-sync, 0.6-1.6 s each (3 of 3) |
| `fleet/pack.sh 2 ours <relative dir>`; `fleet/pack.sh 01 ...` | — | tarball and `.txt` in the relative dir (41.4 s wall, 37.1 s user, 5.1 s sys; load not recorded, 16-21 in the runs around it); `01` refused before building |

With 835aaa32 nothing in this rollout needs `CODEGRAPH_ALLOW_UNSAFE_NODE`.
