# Per-team MCP config: a team switches CodeGraph on by itself (proposal for codeteam's maintainer)

For Bob, through codeteam's maintainer: codeteam owns its MCP wiring (decision 82). The lane never applies it.
MISSION "Scope: every repository and team"; Orc-Codegraph's #110 and #112.

## How a session gets its MCP servers today (codeteam 34c2667)

- One file for every team: `MCP_FILE = TOOL_DIR / "mcp.json"` (`bin/codeteam:103`).
- v1 launch scripts pass it as `--mcp-config <mcp.json>` when it exists (`bin/codeteam:1393-1394`).
- v2 launch scripts do the same unless the manifest's `[v2]` table sets `mcp = false`
  (`v2/codeteam2/team.py:336-337`).
- An isolated team (`isolate`) also passes `--setting-sources project,local --strict-mcp-config`
  (`bin/codeteam:1367`, `team.py:333-334`), so `--mcp-config` is its only MCP source: no user-scope server, no
  `.mcp.json` from the repository.
- `claude_source` (each manifest's `.claude` folder) carries agents, rules and settings, not MCP servers.

So today a server in `mcp.json` reaches every team at once, and a team cannot have its own server or its own
env.

## Change

`codeteam-mcp.patch` (from `/Users/bob/devlop/codeteam`: `patch -p1 < <fork>/fleet/rollout/codeteam-mcp.patch`)
adds one optional manifest key, `mcp_configs`: a list of MCP config files, relative to codeteam or absolute.
One function, `mcp_config_files(t)` in `bin/codeteam`, returns the shared `mcp.json` (when it exists) followed
by those files. Both launch paths pass the whole list to one `--mcp-config`, which takes several files
(`claude --help`: `--mcp-config <configs...>`). The v2 `[v2] mcp = false` switch still turns off all of them.
Any entry that is not a path to an existing file (a missing file, a folder, an empty string, a number, a `~user`
that does not exist) is skipped with a warning on stderr, so a bad manifest line never stops a session from
launching; a single string instead of a list is taken as a list of one. Nothing changes for a manifest
without the key: every team today gets exactly what it gets now.

Checked on copies of today's `bin/codeteam` and `v2/codeteam2/team.py`: the patch applies, both files parse
(`ast.parse`, `py_compile`), and the reverse restores both byte for byte. `mcp_config_files` was run on
stand-in manifests: no key gives the shared file only; `["share/mcp-codegraph.json"]` and the bare string give
both; `17`, `""`, a folder, a nonexistent `~user` path, a missing file, `5`, `None` and a table are each skipped
with the warning; no shared file and no key gives none, so no `--mcp-config` flag at all, as today.
The launch itself was not run.

## Switching a team on (after the global install and `go-live-runbook.md` steps 1 and 2)

One line in that team's manifest, `codeteam/teams/<team>.toml`, at the top level (beside `claude_source`):

```toml
mcp_configs = ["share/mcp-codegraph.json"]
```

The team's sessions get the CodeGraph server when they next launch; the other teams are untouched. To switch it
off, delete the line. `share/mcp-codegraph.json` carries the fleet settings (`CODEGRAPH_MCP_TOOLS`,
`DO_NOT_TRACK=1`, and `CODEGRAPH_QUERY_POOL_SIZE=0` after `mcp-json.md`).

A team that needs settings of its own gets its own file, `share/mcp-codegraph-<team>.json`, a copy of the shared
one with its env changed, and names that file instead. These settings do not impose a repository/edition
allowlist: under R-8 (`docs/RULINGS.md`), this trusted-local MCP may query any checked-out repository, and
agent-supplied `projectPath` selects the requested database rather than granting access. The server key stays
`codegraph` in every file, so the tool names agents see (`mcp__codegraph__codegraph_explore`, ...) are the same
on every team.

Team-codegraph switches on the same way. Its file runs `/opt/homebrew/bin/codegraph`, the fleet's released build
(the global install), never a build from this fork's worktrees (MISSION "Scope").

The order teams switch in is open with Bob (Q-7). This change works for one team at a time or for all.

## Undo

Delete `mcp_configs` from every manifest that has it, then from `/Users/bob/devlop/codeteam`:
`patch -p1 -R < <fork>/fleet/rollout/codeteam-mcp.patch`.
