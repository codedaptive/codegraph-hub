# SPEC: offering our work upstream

Draft 1, 2026-10-31, Designer-Codegraph. Governing decision: Bob, 2026-10-31 (R-17). Upstream is
`colbymchenry/codegraph`. Lines marked **[check]** are my reading; §6 lists them.

## 1. What Bob decided

1. Open **pull requests** for the changes that make sense on their own upstream.
2. Publish **a public fork** holding everything else, and open **one issue** upstream that describes what the fork
   adds and offers it for upstream to use as it likes.
3. If upstream wants any of it in the main repository, we **volunteer** to bring it over.

## 2. Before anything is cut

- Refresh the `upstream` mirror (ours carries upstream through 60b0d7a9, 2026-10-29) and merge it into integration,
  so every PR and the fork start from current upstream.
- PRs are cut from integration's per-feature commits, never from `ours`: each `sm.N` release on `ours` squashes many
  features into one commit.
- Every PR follows upstream's own rules (upstream `AGENTS.md`): tests in upstream's `__tests__/`, a `CHANGELOG.md`
  entry under `## [Unreleased]` in its user-facing style, no version bump.
- The team prepares branches and texts. Bob creates the fork, pushes, and opens the PRs and the issue (agents never
  push or publish).

## 3. Pull requests

One PR per row, each on `pr/<feature>` cut from current upstream with that feature's commits applied, its tests
passing on upstream's suite. Smallest and least dependent first.

| PR | Feature(s) | What it fixes |
|---|---|---|
| 1 | `query-pool-idle` | Idle query workers retire down to one (upstream issue #3027, already filed) |
| 2 | `copied-index-locks` | A copied `.codegraph/` recovers on its own instead of blocking on the source's lock |
| 3 | `lock-race` | Stale-lock takeover removes a lock only if it is still the one judged stale |
| 4 | `sync-mtime-refresh` | Sync stops re-hashing files whose content is unchanged |
| 5 | `swift-builtins` | Calls on Swift standard-library values no longer link by name to project methods |
| 6 | `swift-enum-cases` | Every case in a comma-separated Swift `case` list is indexed |
| 7 | `swift-external-member-ref`, `swift-static-calls`, `swift-qualified-inheritance` | Swift `Type.member()` calls and qualified supertypes resolve to the right type (one PR or three, as they apply) |
| 8 | `rust-impl-in-fn`, `rust-crate-calls` | Rust `impl` inside a function body, and `crate::path::Type::method` calls, resolve |

Not a PR: `node-25` if upstream already supports Node 25 (its guide says it does) **[check 1]**; the pinned
tree-sitter-swift mis-parse test, which goes upstream as the drafted issue instead.

Two Swift issues already drafted (Orc-Codegraph's todo) go upstream with the PRs: the 0.7.3 `if try await` mis-parse,
and `declaredSupertypes` reading a nested type's inheritance clause.

## 4. The public fork and its issue

**The fork** is upstream plus every feature on `ours`, under a public GitHub fork of `colbymchenry/codegraph`. It
carries the product only: no `fleet/`, no fork-only root `Makefile` (codeteam's targets), no `docs/RULINGS.md`, team
reports or graft golden files. **[check 2]** Its README opens with a section on what the fork adds and how to
use it.

**The issue** upstream, one, describes the fork's additions in user terms and links the fork:

| Area | What the fork adds |
|---|---|
| One server per machine | One MCP server for every repository and worktree, started by the first client; each call names its path; databases open on demand and close after 10 idle minutes, with no cap |
| Index builder | One long-lived process with a queue does every index write; small syncs go ahead of full builds; a query never waits on a build |
| Worktree lifecycle | A new git worktree copies its index from the nearest indexed sibling; a removed worktree's index is deleted; dead locks are reclaimed |
| Session focus | `serve --mcp --focus <dir>`: finding tools answer inside the focus, impact tools cover the whole repository and list out-of-focus results apart |
| Worktree hook | A Claude Code `PreToolUse` hook that sets `projectPath` to the agent's own git root |
| New tools | `grep` (hits grouped by enclosing symbol), `blast` (impact of a diff against its merge base), `orphans` (new symbols nothing uses), `suspects` (name-only call edges to check) |
| Fresh answers | `--fresh` / `fresh: true` and `checkpoint`: an answer says what tree state it describes |
| Extension hooks | New CLI commands and MCP tools added from `src/extensions/<zone>/` without editing upstream files |

It says plainly which of these change upstream's defaults (no default project, indexing without opt-in, the repo
anchor), that the fork runs on macOS only so far, and that we will bring any part upstream as opt-in, tested on
Linux and Windows, if they want it.

## 5. Done

- Every §3 PR branch exists, applies to current upstream and passes upstream's suite, with its PR text and
  `CHANGELOG` entry ready for Bob.
- The fork's tree and README are ready to publish; the upstream issue text is ready; the two Swift issues are ready.
- Bob publishes.

## 6. Readings to confirm

1. `node-25` is left out if upstream already runs on Node 25 and later.
2. The public fork leaves out the team's own files (fleet, the codeteam Makefile, rulings, reports, graft golden
   files) and keeps our `docs/SPEC.md` out too, since it cites team rulings.
3. `grep`, `blast`, `orphans` and `suspects` go in the fork issue, not as PRs, because they are built on our
   extension hooks.
