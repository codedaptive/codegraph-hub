# SPEC: the CodeGraph server (`ours`)

Draft 3, 2026-10-30, Designer-Codegraph. Governing decision: Bob's
`/Users/bob/devlop/team-codegraph/SPEC-codegraph-server-2026-10-30.md` (R-11); numbers in brackets, e.g. [B4], cite
its items. This file expands it with what is already on `ours` and how the parts fit. Bob's answers to the open readings are R-12;
the governing spec replaces MISSION.md, and nothing only in MISSION.md applies.

Standing rulings: R-10 (private, never distributed; one server per computer; no ceremony), R-8's "no security
machinery" as narrowed by [B8]; R-12 (Bob's answers to draft 2). Superseded by R-11: R-9's five-minute close and no-pin rule, R-8's "any repository
may be queried", MISSION.md WP1's project cap and in-server worker processes.

## 1. What it is

A private improvement of CodeGraph (upstream `colbymchenry/codegraph`, TypeScript on Node) for Bob's machine. It
gives coding agents a code graph of any repository or directory on the computer through one MCP server and the
`codegraph` CLI. Nothing in it is codeteam-specific [B14].

## 2. Processes

| Process | Count | Does |
|---|---|---|
| Server | one per computer [B1] | Answers every query, for every repository. Reads databases; never writes an index. |
| Builder | one, long-lived, separate from the server [B9] | Every index write: cold builds, catch-up after a copy, syncs. Runs a queue; small syncs go ahead of cold builds [B10]. |
| `serve --mcp` session | one per agent session | Carries the session's launch settings (§4) and forwards calls to the server. |

The first client starts the server; the server starts the builder; neither exits when idle (R-12). That keeps
pinned databases open and current [B13].

The CLI commands that write an index (`init`, `index`, `sync`, `checkpoint`/`--fresh`) hand the work to the builder
when it is running; when it is not, they write in their own process under the writer lock (R-14).
`codegraph uninit` asks a running server to release the root before it deletes `.codegraph/`; `codegraph unlock`
removes only a lock whose owner is dead, and with a live holder says so and removes nothing (R-15).
Because indexing has no opt-in (R-12), `uninit` does not stay done while a session still queries that path: the next
call rebuilds the index within seconds.

While no server answers, a session is served in-process, read-only: it never writes, seeds or builds an index, and
it moves to the server as soon as one answers.

**Development builds** (R-12) are built in an isolated directory and run on their own test socket (or port) with
their own state directory. They never connect to, replace or write through the live server or builder.

## 3. Databases

- A database lives in its worktree's `.codegraph/` and always covers the whole repository of that worktree [B3]
  (not a subdirectory; `--focus` narrows answers, never the index).
- Opened when a call needs it; closed after **10 minutes** with no call; no limit on how many are open [B2].
  Closing releases handles and keeps the file. Every pinned project is also opened without a call: when the server
  starts and after each housekeeping pass (`pinned-open-at-start`). A pinned project with no index is first seeded
  from its nearest indexed sibling, when it is pinned and on that pass (S-57, `pinned-seed`).
- **Pinned** databases (standing worktrees) stay open and current: never closed for idleness, always synced, so they
  are always a good copy source [B13]. Who pins: codeteam, with `codegraph project pin`, for the worktrees it
  calls standing [B14].
- A closed, unpinned database is not watched; the next call opens it and queues a catch-up sync. (R-12)

Index selection and admission stop at the call path's git root: a git clone nested under another checkout is its own
repository, so it gets its own index root and is built, never answered from the outer checkout's index [B3].

### A worktree with no index [B11, B12]

The lifecycle already on `ours` (`src/extensions/host/worktree-lifecycle/`), unchanged in intent:
1. Find indexed worktrees of the same repository (same git common dir).
2. Pick the one whose HEAD is the fewest commits away (ties by path); checkpoint it; APFS-clone its database in
   (`clonefile`, else copy); register the new worktree.
3. Queue the catch-up on the builder; only files whose content changed are re-indexed.
4. Housekeeping deletes the index of a worktree that is gone, and reclaims a writer lock whose PID is dead.

With no indexed sibling (or a directory that is not a git worktree), the builder cold-builds it from the queue, and
calls meanwhile get success-shaped "building" guidance. No opt-in: the registration/`CODEGRAPH_AUTO_INDEX=1` gate
on `ours` (S-33) goes (R-12). `CODEGRAPH_NO_AUTO_SEED=1` turns automatic seeding and cold builds off for the process
that sets it.

A call for a root whose copy is queued behind a running job waits up to 10 s
(`CODEGRAPH_BUILDER_ENSURE_WAIT_MS`) for it, then answers with the building guidance; it never waits for a cold
build to finish.

A directory outside git with no index is cold-built at the session's launch directory, and calls meanwhile get the
building guidance. The builder refuses what upstream's `unsafeIndexRootReason` (`src/directory.ts`, upstream #860)
refuses (the home directory, a filesystem root, any parent of home) and sensitive paths, and checks
the real path again when the queued job starts. Known cost: the build and its watch cover the whole launch
directory, and the build waits its turn on the builder's serial queue. (index-builder, c8a25bb5.)

## 4. Session launch settings (`serve --mcp …`)

- **Repo anchor [B4].** The launch directory fixes the session's repository. A call whose path is outside it is
  rejected. "The repository" means every worktree sharing the anchor's git common dir, so a lane may query its
  sibling worktrees. (R-12) The rejection is success-shaped guidance naming the anchor, not `isError`
  (upstream's "errors teach abandonment"). (R-12)
- **Focus [B5].** `--focus <dir>`, repeatable, relative to the repository root, applies to the session and every
  subagent on it.
  - Finding tools (`search`, `explore`, `grep`) return results inside the focus by default; the caller can ask for
    the whole repository (a `scope: "repo"` argument). (R-12)
  - Impact tools (`callers`, `impact`, `blast`) always cover the whole repository and list results outside the
    focus in a separate section.
  - A focused `explore` whose query names an identifier defined only outside the focus ends with one line saying
    that name exists outside the session's focus and to pass `scope: "repo"`: the name only, no path or source (S-46).
  - Tools [B5] does not name (`node`, `callees`, `files`, `status`, `orphans`, `suspects`) ignore focus. (R-12)
- codeteam passes `--focus` from `CODETEAM_ZONE`; CodeGraph knows nothing of zones [B14].

## 5. Calls

- Every call needs `projectPath` [B6]. Without it the answer is exactly: `missing argument: root path to the code
  you wish to query`. No default from the session's launch directory or a cached database.
- `projectPath` may be any directory inside the anchor repository; it selects the worktree whose root contains it.
- **Worktree hook [B7].** CodeGraph ships a Claude Code `PreToolUse` hook for `mcp__codegraph__.*` that sets
  `projectPath` to the git root of the calling agent's `cwd`. When deployed it always wins over what the agent
  passed; when not deployed, callers pass the path. codeteam deploys it [B14]. Shipped as a file in the package plus
  a documented settings entry; `codegraph install` does not add it. (R-12)
- No security or access control beyond the anchor [B8].

## 6. Tools

Upstream: `codegraph_explore` (primary), `node`, `search`, `callers`, `callees`, `impact`, `status`, `files`.

Ours (on `ours` since sm.2–sm.4; enabled by name in `CODEGRAPH_MCP_TOOLS`):

| Tool / CLI | What it does |
|---|---|
| `grep` | Regex over indexed files; each hit assigned to the innermost symbol enclosing its match, or to its file when none does; hits in a file changed since it was indexed are listed unattributed, in a group marked stale; groups ranked by incoming edges. |
| `blast --base <ref>` | Changed lines from the merge base to the working tree; each changed line seeds its innermost symbols, and a changed code line in no symbol seeds the file; a deletion seeds the symbols spanning both lines beside it, else the file; incoming edges to `--depth` (default 2); grouped by file. (S-51) |
| `orphans --base <ref>` | Symbols added since `<ref>` with no incoming edges; implementations of protocols/traits and tests excluded. |
| `suspects` | Name-only or low-confidence call edges, ranked; `grep`/`blast` mark them, `--strict` drops them. |
| `checkpoint`, `fresh` | What an answer describes (HEAD, uncommitted-change hash, files pending); `fresh` waits until the index matches the tree. |
| `project list/pin/unpin/remove/seed` | The worktree registry; pin as in §3. `project seed <path>` seeds a worktree from its nearest indexed sibling now: exit 0 when it has an index afterwards, 3 when no sibling has one, 1 on an error (S-57). |
| `upgrade`, update notice | Install and announce the hub's releases (`codedaptive/codegraph-hub`), never upstream's package; `-sm.N` versions compared by number (R-32). |

## 7. Acceptance

On throwaway clones, never live team worktrees, and against a development server (§2), never the live one.
- Calls from sessions in unrelated repositories reach the same server process; every index write happens in the
  builder process.
- First call on an unindexed worktree with an indexed sibling copies from the nearest-commit sibling and answers
  from it; seeding twice gives identical contents; queryable within 30 s.
- An unpinned database closes after 10 idle minutes and reopens correctly on the next call; a pinned one stays open
  and reflects edits.
- A call with no `projectPath` returns the exact [B6] text. A call outside the anchor repository is rejected; one in
  a sibling worktree of the anchor is answered from that worktree.
- With `--focus`, `search`/`explore`/`grep` return only focus results unless asked for the repository; `callers`/
  `impact`/`blast` return the whole repository with out-of-focus results listed separately.
- With the hook deployed, an agent passing a wrong `projectPath` is answered from its own cwd's git root.
- With cold builds queued, a small sync queued after them runs before the next cold build starts.
- Deleting a worktree frees its index within one housekeeping interval; killing the builder mid-write leaves no
  lock that blocks the next write.

## 8. Status (2026-11-10)

Every item of the governing spec [B1]-[B14] is built and shipped. Installed globally: **1.6.2-sm.14** (ours
6a2b6eff, 2026-11-10, R-41); running sessions moved to it with `/mcp reconnect codegraph`, no restart. Public:
`codedaptive/codegraph-hub`, release `v1.6.2-sm.12` (R-31, R-32). The team works its bug list, bug fixes only (R-38); upstream main f72c9d2e is already in ours.

| Release | What it shipped |
|---|---|
| sm.5 (ours 687fb5a6) | one machine server and index builder, 10-minute close with no cap, pinned standing databases, repo anchor, required `projectPath`, session `--focus` with `scope: "repo"` on the finding tools (grep included; blast always covers the repository and lists out-of-focus dependents apart), the worktree hook, building guidance; the worktree lifecycle and tools carried from sm.4 |
| sm.6 (ours b8a23dbc) | CLI index writes go to a running builder (R-14); focused context recall filtered to the focus; the out-of-focus name note (S-46) |
| sm.7 (ours 62efe36e) | `uninit` releases through a running server first; `unlock` refuses a live holder (R-15); the out-of-focus name note's ceiling fix |
| sm.8 (ours a7881907) | a focused `explore` keeps its Flow strip along the deepest in-focus chain, and its no-result explanation names no out-of-focus symbol (queries Defects 1 and 2) |
| sm.9 (ours 8ebff286) | upstream 4499d007 merged in (84 commits), keeping the machine server, builder and focus work; tool descriptions say `projectPath` is required; `CODEGRAPH_NO_AUTO_SEED` named where users see it |
| sm.10 (ours 182c04bb) | upstream 5cd8a9a8 merged in (16 commits); pinned projects opened at server start and after each housekeeping pass (`pinned-open-at-start`); slow tests wait on events with stated timeouts (`slow-tests`); a server that cannot bind any socket says why for each candidate |
| sm.11 (ours ff092584, 2026-11-04) | upstream f72c9d2e merged in; the review fixes from our upstream pull requests carried back (S-52, R-29): locks, sync and readiness (host); `grep` (stale files unattributed), `blast` (per-line seeds, S-51) and `orphans` (queries); `suspects`, Swift and Rust resolution (resolution) |
| sm.12 (ours 4fdda779, 2026-11-04) | `codegraph upgrade` and the update notice use the hub's releases, never upstream's package; `-sm.N` versions compared by number (R-32); comments and test names without internal citations (S-55); the hub's first release |
| sm.13 (ours be5ab360, 2026-11-06) | a pinned project with no index is seeded from its nearest sibling; `codegraph project seed <path>` (S-57) |
| sm.14 (ours 6a2b6eff, 2026-11-10) | a launcher no longer takes over a busy server, and a stopping server removes only its own socket (split-server fix, F-1/F-2, S-58); the R-38 bug list (Swift member and nested-supertype resolution, `grep`/`orphans` tool descriptions, install runbook, seed and upgrade-version fixes); upstream PRs #3249 (impact speed) and #3215 (order-independent resolution) taken early (R-40); tests sorted into unit, integration and validation groups (R-41, S-64) |

| Left | State |
|---|---|
| fleet/README's rust-path-calls row (K-F7); the lanes' own lists | lanes' todos |
| The hub's monthly update, next due 2026-12-04 | Bob (R-36) |

## 9. Out of scope (R-12)

Builder robustness items closed by R-16 (watchdog, hook sync, stale `rebuild.pid`) until one surfaces.

Performance targets; graft and anything only in MISSION.md. (The upstream process R-12 deferred is now in scope:
R-17, `docs/SPEC-upstream.md`, R-26.)
