# Rollback: every rollout step undone, last applied first

For Bob. Each step is the "Undo" of its write-up, in the order to run them. `<fork>` is any checkout of the fork
holding `fleet/rollout/`: `~/devlop/team-codegraph/design/codegraph-ours` once this feature is on `ours`. Skip a
step whose change was never applied.

```bash
# 5. Per-team config (per-team-mcp.md): delete `mcp_configs` from every codeteam/teams/<team>.toml that has it,
#    then take the launch-code change out.
cd /Users/bob/devlop/codeteam && patch -p1 -R < <fork>/fleet/rollout/codeteam-mcp.patch

# 4. ~/.claude.json (claude-json.md): put the user-scope entry back.
claude mcp add codegraph -s user -- codegraph serve --mcp

# 3. codeteam/share/mcp-codegraph.json (mcp-json.md): the added settings out.
cd /Users/bob/devlop/codeteam && patch -p1 -R < <fork>/fleet/rollout/mcp-json.patch

# 2. Go-live indexes and pins (go-live-runbook.md, "Undo"): the pins undone from pin-standing.log, and the
#    indexes step 1 made removed with `codegraph uninit -f <worktree>` (not rm -rf), for those worktrees only.
python3 -I -B <fork>/fleet/rollout/pin-standing.py --undo --log <the pin-standing.log go-live wrote>

# 1. Global install (global-install.md). R-30's rollback target is the previous sm.N (sm.8 today), by the same
#    steps as global-install.md: install its tarball, check, wait and clear stale servers, reconnect, every team answers.
#    --ignore-scripts keeps sm.N's preuninstall from removing every agent's global CodeGraph entry.
npm install -g --ignore-scripts ~/devlop/team-codegraph/releases/colbymchenry-codegraph-1.6.2-sm.<prev>.tgz
codegraph --version            # 1.6.2-sm.<prev>
# Follow global-install.md step 4: do not stop the new owner or kill session helpers; wait about 30 s, SIGKILL
# each detached server of this state directory not named by server.pid, then check one server and one builder
# (commands and outputs: global-install.md step 4).
~/devlop/codeteam/bin/codeteam-type-all --dry-run "/mcp reconnect codegraph"   # who would get it; types nothing
~/devlop/codeteam/bin/codeteam-type-all "/mcp reconnect codegraph"             # report who it could not reach
codegraph daemon               # after the reconnect: pid P  v1.6.2-sm.<prev>  up ...
#
# 1, further back: sm.N out, 1.5.0 back. 1.5.0's `codegraph daemon` is an interactive picker over per-project
#    daemons with no --stop, and its helpers never use the sm.N server, so stop that server with the sm.N CLI
#    BEFORE the uninstall. A helper that respawns it before the uninstall starts sm.N again; its install check
#    runs every 30 s by default and stops it when it detects that its install was removed or replaced.
codegraph daemon --stop        # still sm.N: "Stopped the CodeGraph server (pid P, vX)."
#    A server built before ec171901 (2026-11-19) cannot answer the daemon proof's challenge and is not stopped:
#    --stop says it did not prove it runs as this user (outcome `unproven`), names the socket and the pid it
#    claims, and sends no signal. Check that the pid is the process listening on that socket: `ps -p <pid> -o command=`
#    shows a `codegraph.js serve` command, and `lsof -a -p <pid> -U` lists the socket path the `--stop` message names.
#    If either check fails, do not kill anything: stop there and report the pid and the socket. If both pass, stop it
#    once by hand with `kill <pid>`, then go on (SIGTERM is right for the socket's owner;
#    global-install.md "Undo"). Installing one sm.N over another (step 1 above) needs no such step: the old
#    server's install check stops it by itself (global-install.md step 4).
npm uninstall -g --ignore-scripts @colbymchenry/codegraph
npm install -g @colbymchenry/codegraph@1.5.0
~/devlop/codeteam/bin/codeteam-type-all --dry-run "/mcp reconnect codegraph"   # who would get it; types nothing
~/devlop/codeteam/bin/codeteam-type-all "/mcp reconnect codegraph"             # report who it could not reach
codegraph --version            # 1.5.0; then every team answers a codegraph call (not `codegraph daemon`)
```

The reconnect in step 1 replaces a restart for the version change. Steps 3 to 5 change MCP config, which a session
reads at launch: after any of them, restart the sessions. `mcp-json.patch` and
`codeteam-mcp.patch` were checked on copies of today's files: each applies, and its reverse restores the files
byte for byte.
