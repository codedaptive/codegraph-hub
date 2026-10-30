# codeteam's CodeGraph MCP entry: the ten tools, query pool off

Shared state: `/Users/bob/devlop/codeteam/share/mcp-codegraph.json`, the CodeGraph server entry codeteam staged
(decision 82, codeteam 34c2667). codeteam owns the entry and wires it in at Bob's green light; how a team gets it
is `per-team-mcp.md`. This write-up is the two settings fleet changes in it. For Bob's go-ahead; the lane never applies
it.

## Change

```diff
--- a/share/mcp-codegraph.json
+++ b/share/mcp-codegraph.json
@@ -4,7 +4,8 @@
       "command": "/opt/homebrew/bin/codegraph",
       "args": ["serve", "--mcp"],
       "env": {
-        "CODEGRAPH_MCP_TOOLS": "explore,node,search,callers,callees,impact",
+        "CODEGRAPH_MCP_TOOLS": "explore,node,search,callers,callees,impact,grep,blast,orphans,suspects",
+        "CODEGRAPH_QUERY_POOL_SIZE": "0",
         "DO_NOT_TRACK": "1"
       }
     }
```

Apply from `/Users/bob/devlop/codeteam`: `patch -p1 < <fork>/fleet/rollout/mcp-json.patch` (`<fork>`: any checkout
of the fork holding this file, e.g. `~/devlop/team-codegraph/design/codegraph-ours`). Checked on a copy of
today's file: it applies, the result is valid JSON with the three env keys and the ten tools, and the reverse restores the file
byte for byte.

- `CODEGRAPH_MCP_TOOLS` gains `grep,blast,orphans,suspects`, which 1.6.2-sm.2 (ours 11b39cfc) serves. Tested from
  `team-codegraph/releases/colbymchenry-codegraph-1.6.2-sm.2.tgz` in a throwaway npm prefix, Node 26.12: with
  this value `tools/list` answered `codegraph_search, _callers, _callees, _impact, _node, _explore, _grep, _blast,
  _orphans, _suspects`; without it, only `codegraph_explore`.
- `CODEGRAPH_QUERY_POOL_SIZE=0` turns off the daemon's query worker pool: about 0.3 GB per worktree instead of
  ~1 GB, and up to 5 GB after a burst (host's Q2, `workcrews/host/ledger/reports/oq2-3-memory-and-copy.md`).
  The env reaches the daemon: tested, the daemon a proxy started logged that its query pool was disabled.
- The staged entry's other settings stand as codeteam wrote them. No `CODEGRAPH_ALLOW_UNSAFE_NODE` is needed on
  Node 26 (`README.md`).
- Go-live waits on host's `worktree-lifecycle` seeding (settled S-9), and no team gets this entry before
  `go-live-runbook.md` steps 1 and 2 (index and pin) have run.

## Undo

From `/Users/bob/devlop/codeteam`: `patch -p1 -R < <fork>/fleet/rollout/mcp-json.patch`, or delete the
`"CODEGRAPH_QUERY_POOL_SIZE": "0",` line and drop `,grep,blast,orphans,suspects` from `CODEGRAPH_MCP_TOOLS`.
