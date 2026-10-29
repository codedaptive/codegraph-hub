# codeteam/mcp.json: the CodeGraph server

Shared state: `/Users/bob/devlop/codeteam/mcp.json`, the MCP servers every codeteam session gets
(`codeteam` passes it with `--mcp-config`; isolated sessions also pass `--strict-mcp-config`, so this file is
their only MCP source). For Bob's go-ahead; the lane never applies it.

## Today (checked 2026-10-29, codeteam 34c2667)

`mcp.json` is `{"mcpServers": {}}`: codeteam decision 82 took graft out. The CodeGraph entry is staged beside it
in `codeteam/share/mcp-codegraph.json`, to become `mcp.json` once 1.6.2-sm.N is the global install
(`global-install.md`). The staged entry lacks `CODEGRAPH_QUERY_POOL_SIZE=0`; this change adds it.

## Change

```diff
--- a/mcp.json
+++ b/mcp.json
@@ -1,3 +1,13 @@
 {
-  "mcpServers": {}
+  "mcpServers": {
+    "codegraph": {
+      "command": "/opt/homebrew/bin/codegraph",
+      "args": ["serve", "--mcp"],
+      "env": {
+        "CODEGRAPH_MCP_TOOLS": "explore,node,search,callers,callees,impact",
+        "CODEGRAPH_QUERY_POOL_SIZE": "0",
+        "DO_NOT_TRACK": "1"
+      }
+    }
+  }
 }
```

Apply from `/Users/bob/devlop/codeteam`: `patch -p1 < <fork>/fleet/rollout/mcp-json.patch` (`<fork>`: any
checkout of the fork with this file, e.g. `~/devlop/team-codegraph/design/codegraph-ours`). Checked on a copy of
today's file: the result is valid JSON, equal to `share/mcp-codegraph.json` plus the one key, and the reverse
patch restores today's file byte for byte. Copying `share/mcp-codegraph.json` over `mcp.json` and adding the key
by hand gives the same entry.

- One daemon per worktree, as upstream runs today. A session's `serve --mcp` starts in its worktree, finds that
  worktree's `.codegraph/` and proxies to its daemon. The env reaches the daemon (tested: the daemon a proxy
  started logged that its query pool was disabled).
- `CODEGRAPH_QUERY_POOL_SIZE=0`: about 0.3 GB per worktree instead of ~1 GB, and up to 5 GB after a burst
  (host's Q2, `workcrews/host/ledger/reports/oq2-3-memory-and-copy.md`).
- `CODEGRAPH_MCP_TOOLS`: without it sm.N lists only `codegraph_explore`. With it, `tools/list` answers
  `codegraph_search, codegraph_callers, codegraph_callees, codegraph_impact, codegraph_node, codegraph_explore`
  (tested on sm.1 from 835aaa32: `README.md`). `grep,blast` join the list when queries ships them.
- No `CODEGRAPH_ALLOW_UNSAFE_NODE`: sm.N packed from `ours` 835aaa32 or later starts on Node 26 without it.
- Every call passes its worktree as `projectPath` (settled S-3); the instructions crew teaches it.
- Go-live step 1 waits on host's `worktree-lifecycle` seeding (settled S-9): without it, a session's first call
  in a worktree with no index gets guidance to index, not an answer.

Sessions read this file at launch: running sessions see the change when they restart.

## Undo

From `/Users/bob/devlop/codeteam`: `patch -p1 -R < <fork>/fleet/rollout/mcp-json.patch`, or write back

```json
{
  "mcpServers": {}
}
```
