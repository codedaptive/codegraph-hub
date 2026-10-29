# Rollback: every rollout step undone, last applied first

For Bob. Each step is the "Undo" of its write-up, in the order to run them. `<fork>` is any checkout of the fork
holding `fleet/rollout/`: `~/devlop/team-codegraph/design/codegraph-ours` once this feature is on `ours`. Skip a
step whose change was never applied.

```bash
# 4. Per-team config (per-team-mcp.md): delete `mcp_configs` from every codeteam/teams/<team>.toml that has it,
#    then take the launch-code change out.
cd /Users/bob/devlop/codeteam && patch -p1 -R < <fork>/fleet/rollout/codeteam-mcp.patch

# 3. ~/.claude.json (claude-json.md): put the user-scope entry back.
claude mcp add codegraph -s user -- codegraph serve --mcp

# 2. codeteam/share/mcp-codegraph.json (mcp-json.md): the added setting out.
cd /Users/bob/devlop/codeteam && patch -p1 -R < <fork>/fleet/rollout/mcp-json.patch

# 1. Global install (global-install.md): sm.N out, 1.5.0 back. --ignore-scripts keeps sm.N's preuninstall
#    from removing every agent's global CodeGraph entry.
npm uninstall -g --ignore-scripts @colbymchenry/codegraph
npm install -g @colbymchenry/codegraph@1.5.0
codegraph --version    # 1.5.0
```

Sessions read their MCP config at launch: restart them after the rollback. `mcp-json.patch` and
`codeteam-mcp.patch` were checked on copies of today's files: each applies, and its reverse restores the files
byte for byte.
