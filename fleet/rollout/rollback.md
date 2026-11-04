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

# 1. Global install (global-install.md): sm.N out, 1.5.0 back. --ignore-scripts keeps sm.N's preuninstall
#    from removing every agent's global CodeGraph entry.
npm uninstall -g --ignore-scripts @colbymchenry/codegraph
npm install -g @colbymchenry/codegraph@1.5.0
codegraph --version    # 1.5.0
#    Then move the running sessions to it, as global-install.md steps 4 to 6 do: stop the server they use,
#    reconnect every session, and have every team answer a codegraph call. An old helper can retry and start
#    its own entry point after the stop; check the server version rather than assuming the call proves it.
codegraph daemon --stop    # "Stopped the CodeGraph server (pid P, vX)." or "No CodeGraph server running."
~/devlop/codeteam/bin/codeteam-type-all --dry-run "/mcp reconnect codegraph"   # who would get it; types nothing
~/devlop/codeteam/bin/codeteam-type-all "/mcp reconnect codegraph"             # report who it could not reach
codegraph daemon           # after reconnect and a call: check for the version just installed
```

The reconnect in step 1 replaces a restart for the version change. Steps 3 to 5 change MCP config, which a session
reads at launch: after any of them, restart the sessions. `mcp-json.patch` and
`codeteam-mcp.patch` were checked on copies of today's files: each applies, and its reverse restores the files
byte for byte.
