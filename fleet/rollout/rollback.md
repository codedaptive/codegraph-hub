# Rollback: every rollout step undone, last applied first

For Bob. Each step is the "Undo" of its write-up, in the order to run them. `<fork>` is any checkout of the fork
holding `fleet/rollout/`: `~/devlop/team-codegraph/design/codegraph-ours` once this feature is on `ours`. Skip a
step whose change was never applied.

```bash
# 3. ~/.claude.json (claude-json.md): put the user-scope entry back.
claude mcp add codegraph -s user -- codegraph serve --mcp

# 2. codeteam/mcp.json (mcp-json.md): the codegraph entry out, back to no servers.
cd /Users/bob/devlop/codeteam && patch -p1 -R < <fork>/fleet/rollout/mcp-json.patch

# 1. Global install (global-install.md): sm.N out, 1.5.0 back. --ignore-scripts keeps sm.N's preuninstall
#    from removing every agent's global CodeGraph entry.
npm uninstall -g --ignore-scripts @colbymchenry/codegraph
npm install -g @colbymchenry/codegraph@1.5.0
codegraph --version    # 1.5.0
```

Sessions read `mcp.json` at launch: restart them after the rollback. `mcp-json.patch` was checked on a copy of
today's file: it applies, and its reverse restores the file byte for byte.
