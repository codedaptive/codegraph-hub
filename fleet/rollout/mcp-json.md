# codeteam's CodeGraph MCP entry: one setting added

Shared state: `/Users/bob/devlop/codeteam/share/mcp-codegraph.json`, the CodeGraph server entry codeteam staged
(decision 82, codeteam 34c2667). codeteam owns the entry and wires it in at Bob's green light; how a team gets it
is `per-team-mcp.md`. This write-up is the one setting fleet adds to it. For Bob's go-ahead; the lane never applies
it.

## Change

```diff
--- a/share/mcp-codegraph.json
+++ b/share/mcp-codegraph.json
@@ -5,6 +5,7 @@
       "args": ["serve", "--mcp"],
       "env": {
         "CODEGRAPH_MCP_TOOLS": "explore,node,search,callers,callees,impact",
+        "CODEGRAPH_QUERY_POOL_SIZE": "0",
         "DO_NOT_TRACK": "1"
       }
     }
```

Apply from `/Users/bob/devlop/codeteam`: `patch -p1 < <fork>/fleet/rollout/mcp-json.patch` (`<fork>`: any checkout
of the fork holding this file, e.g. `~/devlop/team-codegraph/design/codegraph-ours`). Checked on a copy of
today's file: it applies, the result is valid JSON with the three env keys, and the reverse restores the file
byte for byte.

- `CODEGRAPH_QUERY_POOL_SIZE=0` turns off the daemon's query worker pool: about 0.3 GB per worktree instead of
  ~1 GB, and up to 5 GB after a burst (host's Q2, `workcrews/host/ledger/reports/oq2-3-memory-and-copy.md`).
  The env reaches the daemon: tested, the daemon a proxy started logged that its query pool was disabled.
- The staged entry's other settings stand as codeteam wrote them, and were tested on sm.1 from 835aaa32
  (`README.md`): `CODEGRAPH_MCP_TOOLS` lists the six tools (without it, only `codegraph_explore`); no
  `CODEGRAPH_ALLOW_UNSAFE_NODE` is needed on Node 26.
- Go-live waits on host's `worktree-lifecycle` seeding (settled S-9).

## Undo

From `/Users/bob/devlop/codeteam`: `patch -p1 -R < <fork>/fleet/rollout/mcp-json.patch`, or delete the
`"CODEGRAPH_QUERY_POOL_SIZE": "0",` line.
