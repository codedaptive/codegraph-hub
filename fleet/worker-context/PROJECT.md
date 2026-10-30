# CodeGraph project context

This is product-owned working context, not a replacement for the root
`AGENTS.md`, the request order or your lane's ownership boundaries. Read
`~/devlop/team-codegraph/MISSION.md` before the first request. Root `AGENTS.md`
controls technical facts; `.claude/rules/product.md` controls this team's
workflow. Read `.claude/rules/toolchain-typescript.md` for build/test meaning.

## Fork rulings and current WP1 target

Read the actual canonical ruling register at
`/Users/bob/devlop/team-codegraph/design/codegraph-ours/docs/RULINGS.md`,
**R-8 and R-9**. A request/exchange checkout's copy may lag that source.
R-8 defines trusted-local query scope as database selection, not repository
or edition authorization; correct requested-database answers and ordinary
SQLite integrity/copy/writer coordination still matter. R-9 supersedes the
older per-repository-host and pinned-open assumptions: the intended target
is one system-wide MCP server, explicit database selection per query,
initialization when absent, and database close after five query-idle minutes
without a permanently pinned-open exception.

This is the governing **intended target**, not a claim about the released
binary or WP1 acceptance. R-9 neither waives acceptance/performance gates nor
authorizes live install/MCP changes. Follow the current request order under
these rulings; older MISSION topology descriptions do not override them.

## Product and implementation map

CodeGraph is a local-first code-intelligence library, CLI and MCP server.
Tree-sitter extraction produces symbols and edges in SQLite/FTS5; reference
resolution connects them; graph queries and context formatting expose source
and dependencies. Per-project index data is under `.codegraph/`.

There is one team port: **TypeScript on Node**. A role saying “both ports”
means this port only; the upstream Rust kernel is not a second lane port.

Paths below are relative to **your request worktree**, not another checkout:

- `src/index.ts`: public `CodeGraph` API and layer wiring.
- `src/mcp/`, `src/sync/`, `src/bin/`: hosting/protocol, synchronization and CLI.
- `src/resolution/`: imports, matching and framework resolution.
- `src/graph/`, `src/search/`, `src/context/`: graph queries, search and context.
- `src/extensions/<zone>/`, `__tests__/extensions/<zone>/`: fork-owned features
  and their tests. Upstream hook-in edits need the owning lane's authority.
- `fleet/`: fork packaging, upstream-file inventory and rollout proposals.
- `docs/`: reference/design material; root `AGENTS.md` gives the detailed map.

## Repository and work boundaries

This is private `codedaptive/codegraph`, tracking `colbymchenry/codegraph`.
`ours` is the shipping base; `exchange` and `integration` are shared tiers.
The coordinator creates worktrees. Work in the assigned one and edit only
your zone; do not check out another branch inside it or work in `.repos`.

Upstream-owned extraction/kernel, UI, installer, upgrade and telemetry areas
are read-only for lanes unless the orchestrator explicitly authorizes a
change. Shared root APIs and cross-zone dependencies go through the owner;
this context grants no additional write scope.

Navigate using the fleet's released `codegraph ... -p <absolute-worktree>`
(or MCP `projectPath`), not a development build as the team's search tool.
Development builds run only on this team's separate test server. Never test
against other live teams or change the global install, shared MCP/settings,
agent catalog or codeteam tooling from a lane. Such changes are proposals
for the authorized owner; telemetry remains off.
