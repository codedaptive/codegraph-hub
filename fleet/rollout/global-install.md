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
# 2. Swap the global install. Running helpers retain their old version until reconnected. The old server
#    detects the install change and exits; steps 4 and 5 move sessions without restarting them.
npm uninstall -g --ignore-scripts @colbymchenry/codegraph
npm install -g --ignore-scripts ~/devlop/team-codegraph/releases/colbymchenry-codegraph-1.6.2-sm.<N>.tgz
# 3. Check.
codegraph --version            # 1.6.2-sm.<N>, no banner
npm ls -g --depth=0            # @colbymchenry/codegraph@1.6.2-sm.<N>
# 4. Do not run `codegraph daemon --stop` after the install. The old server detects the replacement and
#    exits itself; a new server may already own server.pid, so a stop would hit the new one. Wait about 30 s.
#    From sm.14 the 30 s rests on CODEGRAPH_SERVER_STOP_GRACE_MS: how long the old server's install-change
#    shutdown waits before builder.stop (5 s cap); default 15 s, cap 120 s (resolveServerStopGraceMs in
#    src/mcp/server-control.ts; Daemon.stop). That shutdown starts at the next install check
#    (CODEGRAPH_DAEMON_INSTALL_CHECK_MS, default every 30 s; 0 turns it off and the server never exits itself), so
#    the worst case is check interval + grace + 5 s (about 50 s at the defaults): repeat the listing below until it is gone.
sleep 30
#    List detached servers on macOS: their environment carries CODEGRAPH_DAEMON_INTERNAL=1. Session helpers
#    also run `codegraph.js serve --mcp` but are not detached servers; never kill helpers. This listing includes
#    process environments, which may contain secrets; do not share its output. Read the owner's JSON lock pid.
ps -ax -E -o pid= -o command= | grep 'CODEGRAPH_DAEMON_INTERNAL=1' | grep '[c]odegraph.js serve'
node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME + "/.codegraph/server.pid", "utf8")).pid)'
#    If the lock is missing or unreadable, resolve that first; do not guess. Check each listed server's cwd
#    with `lsof -a -p <pid> -d cwd`: only servers using ~/.codegraph belong to this lock. Do not kill servers
#    using another state directory. Recheck the lock and list, then `kill -9 <pid>` each server of this state
#    directory that the lock does not name.
#    Never use SIGTERM: a stale server's graceful stop can unlink the live server's socket. See `Daemon.stop`
#    in src/mcp/daemon.ts (the `fs.unlinkSync(this.socketPath)` after `cleanupLockfile()`, lines 482-484
#    before split-server-fix). Its builder goes with it, though it may finish a job before exiting (sm.13 steps 4 and 8).
#    Check one server at the installed version and one builder; repeat the process check if needed.
codegraph daemon               # pid P  v1.6.2-sm.<N>  up ...
ps -ax -o pid= -o ppid= -o command= | grep '[e]xtensions/host/builder/main.js'
# 5. Reconnect every running session (codeteam's bin; /mcp reconnect restarts the session's helper from the new
#    install). It is typed into every session of every team that is up and not HALTED, once its turn has ended,
#    its box is empty, and it is not on a dialog; busy ones are retried every 20 s for up to --wait minutes
#    (default 20). Report the sessions it lists as not reached.
~/devlop/codeteam/bin/codeteam-type-all --dry-run "/mcp reconnect codegraph"   # who would get it; types nothing
~/devlop/codeteam/bin/codeteam-type-all "/mcp reconnect codegraph"             # --teams a,b to limit it
# 6. Every team answers a codegraph call. Check the server version after reconnecting: helpers start or attach
#    in the background, not necessarily on a call. An old helper can retry after the server exits and launch its own
#    entry point, or fall back in-process on a version mismatch; a successful call alone does not prove the
#    server version. If no server is running, this prints "No CodeGraph server running.".
codegraph daemon               # pid P  v1.6.2-sm.<N>  up ...
```

A failed check at any step rolls back to the previous sm.N by the same steps: `rollback.md`, step 1.

`npm install -g` of the tarball fetches its 10 runtime dependencies from the registry (13 packages, 2.4 s in the
throwaway-prefix test of sm.1 from 835aaa32). No `EBADENGINE`: that ref's `engines` is `node >=20.0.0`.

Each later sm.N+1 is step 1, `npm install -g --ignore-scripts <new tarball>` (no uninstall needed), then steps 3
to 6: check, wait and clear stale servers, reconnect, every team answers.

## Who else this reaches

- `~/.codex/config.toml` `[mcp_servers.codegraph]` runs `codegraph` too, so Codex sessions get sm.N. Not changed here.
- `~/.claude/CLAUDE.md`'s marker-fenced CodeGraph block and `~/.claude/settings.json`'s `mcp__codegraph__*`
  permissions stay; they name tools sm.N still has.

## Undo

Back to 1.5.0 (to the previous sm.N instead: `rollback.md`, step 1). 1.5.0's `codegraph daemon` has no `--stop`,
so stop the sm.N server first, then reconnect the sessions and check as `rollback.md` step 1 does.

If the running server is from a build that cannot answer the daemon proof's challenge (built before ec171901,
2026-11-19), `--stop` does not stop it: it says the server did not prove it runs as this user (outcome `unproven`),
names the socket and the pid the server claims, and sends no signal. Check that this pid is the process listening on
that socket (`lsof -a -p <pid> -U`), stop it once by hand with `kill <pid>`, then go on. SIGTERM is right here,
unlike step 4's stale servers: this pid owns the socket, so the socket its graceful stop removes is its own.
Installing a new sm.N over the old one needs no such step: the old server's install check stops it by itself
(step 4).

```bash
codegraph daemon --stop                                     # still sm.N: stop its server before the uninstall
#                                                             not proven (pre-proof server): see above
npm uninstall -g --ignore-scripts @colbymchenry/codegraph   # --ignore-scripts: keep the agents' global entries
npm install -g @colbymchenry/codegraph@1.5.0                # from the registry (checked: 1.5.0 is published)
codegraph --version                                         # 1.5.0
```
