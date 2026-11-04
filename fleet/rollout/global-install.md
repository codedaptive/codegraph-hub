# Global install: 1.5.0 out, 1.6.2-sm.N in

Shared state: the Homebrew npm prefix `/opt/homebrew` (`/opt/homebrew/bin/codegraph`). For Bob's go-ahead; the lane
never applies it.

## Today (checked 2026-10-29)

- `npm ls -g --depth=0`: `@colbymchenry/codegraph@1.5.0`, `@nanonets/graft@0.16.0`.
- 1.5.0 is upstream's thin-installer shim: `/opt/homebrew/bin/codegraph -> ../lib/node_modules/@colbymchenry/codegraph/npm-shim.js`,
  which execs the nested `@colbymchenry/codegraph-darwin-arm64` bundle and its vendored Node 24.16 (older than
  Node's 24.22.1 security release). It has **no npm scripts**, so uninstalling it runs nothing.
- 1.6.2-sm.N is the root package built from `ours` (`fleet/pack.sh`), run by the system Node (v26.12.0). It has a
  `preuninstall` (`dist/bin/uninstall.js`) that removes the **global** CodeGraph entries of every agent target
  (Claude, Codex, Gemini, opencode, ...) when it is uninstalled. Every uninstall of sm.N below therefore uses
  `--ignore-scripts`.

## Precondition

The packed ref carries host's `node-25-support` (`ours` from 835aaa32 on). An older ref's `codegraph` on Node 26
prints the unsupported-Node banner and exits 1 unless `CODEGRAPH_ALLOW_UNSAFE_NODE=1` is set. Tested with
1.6.2-sm.1 from 835aaa32 on Node 26.12.0, no override set: `fleet/rollout/README.md`.

## Apply

```bash
# 1. Pack (any folder; the tarball and a .txt naming its commit land in the out dir).
cd ~/devlop/team-codegraph/design/codegraph-ours        # or any worktree of the fork
fleet/pack.sh <N> ours ~/devlop/team-codegraph/releases
# 2. Swap the global install. Running helpers retain their old version until reconnected; the server may
#    also remain old. Steps 4 and 5 move sessions without restarting them.
npm uninstall -g --ignore-scripts @colbymchenry/codegraph
npm install -g --ignore-scripts ~/devlop/team-codegraph/releases/colbymchenry-codegraph-1.6.2-sm.<N>.tgz
# 3. Check.
codegraph --version            # 1.6.2-sm.<N>, no banner
npm ls -g --depth=0            # @colbymchenry/codegraph@1.6.2-sm.<N>
# 4. Stop the old server. A newer -sm.N launcher never replaces an older server itself: isOlderRelease
#    (src/mcp/version.ts) compares plain MAJOR.MINOR.PATCH only, and a -sm.N version never compares.
codegraph daemon --stop        # "Stopped the CodeGraph server (pid P, vX)." or "No CodeGraph server running.";
                               # exit 1 when it did not exit (stop it with the `kill -9 <pid>` printed) or did
                               # not answer as the server (left running)
# 5. Reconnect every running session (codeteam's bin; /mcp reconnect restarts the session's helper from the new
#    install). It is typed into every session of every team that is up and not HALTED, once its turn has ended,
#    its box is empty, and it is not on a dialog; busy ones are retried every 20 s for up to --wait minutes
#    (default 20). Report the sessions it lists as not reached.
~/devlop/codeteam/bin/codeteam-type-all --dry-run "/mcp reconnect codegraph"   # who would get it; types nothing
~/devlop/codeteam/bin/codeteam-type-all "/mcp reconnect codegraph"             # --teams a,b to limit it
# 6. Every team answers a codegraph call. Check the server version after reconnecting: helpers start or attach
#    in the background, not necessarily on a call. An old helper can retry after the stop and launch its own
#    entry point, or fall back in-process on a version mismatch; a successful call alone does not prove the
#    server version. If no server is running, this prints "No CodeGraph server running.".
codegraph daemon               # pid P  v1.6.2-sm.<N>  up ...
```

A failed check at any step rolls back to the previous sm.N by the same steps: `rollback.md`, step 1.

`npm install -g` of the tarball fetches its 10 runtime dependencies from the registry (13 packages, 2.4 s in the
throwaway-prefix test of sm.1 from 835aaa32). No `EBADENGINE`: that ref's `engines` is `node >=20.0.0`.

Each later sm.N+1 is step 1, `npm install -g --ignore-scripts <new tarball>` (no uninstall needed), then steps 3
to 6: check, stop the old server, reconnect, every team answers.

## Who else this reaches

- `~/.codex/config.toml` `[mcp_servers.codegraph]` runs `codegraph` too, so Codex sessions get sm.N. Not changed here.
- `~/.claude/CLAUDE.md`'s marker-fenced CodeGraph block and `~/.claude/settings.json`'s `mcp__codegraph__*`
  permissions stay; they name tools sm.N still has.

## Undo

Back to 1.5.0 (to the previous sm.N instead: `rollback.md`, step 1). 1.5.0's `codegraph daemon` has no `--stop`,
so stop the sm.N server first, then reconnect the sessions and check as `rollback.md` step 1 does.

```bash
codegraph daemon --stop                                     # still sm.N: stop its server before the uninstall
npm uninstall -g --ignore-scripts @colbymchenry/codegraph   # --ignore-scripts: keep the agents' global entries
npm install -g @colbymchenry/codegraph@1.5.0                # from the registry (checked: 1.5.0 is published)
codegraph --version                                         # 1.5.0
```
