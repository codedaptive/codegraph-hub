# SPEC: the CodeGraph server (`ours`)

Draft 2, 2026-10-30, Designer-Codegraph. Governing decision: Bob's
`/Users/bob/devlop/team-codegraph/SPEC-codegraph-server-2026-10-30.md` (R-11); numbers in brackets, e.g. [B4], cite
its items. This file expands it with what is already on `ours` and how the parts fit. Lines marked **[check]** are
my interpretation where the decision is silent; §9 lists them.

Standing rulings: R-10 (private, never distributed; one server per computer; no ceremony), R-8's "no security
machinery" as narrowed by [B8]. Superseded by R-11: R-9's five-minute close and no-pin rule, R-8's "any repository
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

A cold build in the builder never slows another repository's queries in the server, because they are separate
processes. A development build of this fork runs its own server and builder (separate socket and state directory)
and never joins the machine's.

How the server and builder are started (first client, or launchd) and whether they exit when idle is not decided.
**[check 1]**

## 3. Databases

- A database lives in its worktree's `.codegraph/` and always covers the whole repository of that worktree [B3]
  (not a subdirectory; `--focus` narrows answers, never the index).
- Opened when a call needs it; closed after **10 minutes** with no call; no limit on how many are open [B2].
  Closing releases handles and keeps the file.
- **Pinned** databases (standing worktrees) stay open and current: never closed for idleness, always synced, so they
  are always a good copy source [B13]. Who pins: codeteam, with `codegraph project pin`, for the worktrees it
  calls standing [B14].
- A closed, unpinned database is not watched; the next call opens it and queues a catch-up sync. **[check 2]**

### A worktree with no index [B11, B12]

The lifecycle already on `ours` (`src/extensions/host/worktree-lifecycle/`), unchanged in intent:
1. Find indexed worktrees of the same repository (same git common dir).
2. Pick the one whose HEAD is the fewest commits away (ties by path); checkpoint it; APFS-clone its database in
   (`clonefile`, else copy); register the new worktree.
3. Queue the catch-up on the builder; only files whose content changed are re-indexed.
4. Housekeeping deletes the index of a worktree that is gone, and reclaims a writer lock whose PID is dead.

With no indexed sibling (or a directory that is not a git worktree), the builder cold-builds it from the queue, and
calls meanwhile get success-shaped "building" guidance. Today `ours` gates this on registration or
`CODEGRAPH_AUTO_INDEX=1` (S-33); [B2]/[B9] read as dropping that gate. **[check 3]**

## 4. Session launch settings (`serve --mcp …`)

- **Repo anchor [B4].** The launch directory fixes the session's repository. A call whose path is outside it is
  rejected. "The repository" means every worktree sharing the anchor's git common dir, so a lane may query its
  sibling worktrees. **[check 4]** The rejection is success-shaped guidance naming the anchor, not `isError`
  (upstream's "errors teach abandonment"). **[check 5]**
- **Focus [B5].** `--focus <dir>`, repeatable, relative to the repository root, applies to the session and every
  subagent on it.
  - Finding tools (`search`, `explore`, `grep`) return results inside the focus by default; the caller can ask for
    the whole repository (a `scope: "repo"` argument). **[check 6]**
  - Impact tools (`callers`, `impact`, `blast`) always cover the whole repository and list results outside the
    focus in a separate section.
  - Tools [B5] does not name (`node`, `callees`, `files`, `status`, `orphans`, `suspects`) ignore focus.
    **[check 7]**
- codeteam passes `--focus` from `CODETEAM_ZONE`; CodeGraph knows nothing of zones [B14].

## 5. Calls

- Every call needs `projectPath` [B6]. Without it the answer is exactly: `missing argument: root path to the code
  you wish to query`. No default from the session's launch directory or a cached database.
- `projectPath` may be any directory inside the anchor repository; it selects the worktree whose root contains it.
- **Worktree hook [B7].** CodeGraph ships a Claude Code `PreToolUse` hook for `mcp__codegraph__.*` that sets
  `projectPath` to the git root of the calling agent's `cwd`. When deployed it always wins over what the agent
  passed; when not deployed, callers pass the path. codeteam deploys it [B14]. Shipped as a file in the package plus
  a documented settings entry; `codegraph install` does not add it. **[check 8]**
- No security or access control beyond the anchor [B8].

## 6. Tools

Upstream: `codegraph_explore` (primary), `node`, `search`, `callers`, `callees`, `impact`, `status`, `files`.

Ours (on `ours` since sm.2–sm.4; enabled by name in `CODEGRAPH_MCP_TOOLS`):

| Tool / CLI | What it does |
|---|---|
| `grep` | Regex over indexed files; each hit assigned to its innermost enclosing symbol; groups ranked by incoming edges. Unscoped full-monorepo search under 2 s warm. |
| `blast --base <ref>` | Changed ranges against the merge base; seeds are the innermost symbol per range (the file when none covers it); incoming edges to `--depth` (default 2); grouped by file. |
| `orphans --base <ref>` | Symbols added since `<ref>` with no incoming edges; implementations of protocols/traits and tests excluded. |
| `suspects` | Name-only or low-confidence call edges, ranked; `grep`/`blast` mark them, `--strict` drops them. |
| `checkpoint`, `fresh` | What an answer describes (HEAD, uncommitted-change hash, files pending); `fresh` waits until the index matches the tree. |
| `project list/pin/unpin/remove` | The worktree registry; pin as in §3. |

## 7. Acceptance

On throwaway clones, never live team worktrees. Every performance claim carries command, wall, CPU and load.
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
- A queued small sync completes ahead of a running queue of cold builds' next item; a 5 GB cold build leaves another
  repository's query p95 unchanged.
- 40 open databases, 10 concurrent clients: query p95 under 500 ms; resident memory reported against the 40 × ~1 GB
  baseline.
- Deleting a worktree frees its index within one housekeeping interval; killing the builder mid-write leaves no
  lock that blocks the next write.

## 8. Status (2026-10-30)

| Part | State |
|---|---|
| grep, blast, orphans, suspects, checkpoint/fresh, worktree lifecycle and pins, Swift/Rust resolution | shipped through sm.4 |
| One server per computer; separate builder with queue; 10-minute close, no cap; repo anchor; focus; required `projectPath`; hook | to build (WP1, `lane/host`). Today sm.4 runs one daemon per project root (`src/mcp/daemon-paths.ts`), caps 8 cached projects (`src/mcp/tools.ts:2022`) with a 10-minute release, and syncs inside the server. |

## 9. Interpretations to confirm

1. Server/builder start: on demand by the first client, or launchd; exit when idle?
2. A closed, unpinned database is not watched; reopening queues a catch-up.
3. No indexed sibling: cold build from the queue with no `CODEGRAPH_AUTO_INDEX` gate.
4. The anchor covers every worktree of the repository (same git common dir), not only the launch worktree.
5. The outside-anchor rejection and the missing-path message are success-shaped text, not MCP errors.
6. The whole-repo opt-in on finding tools is an argument named `scope: "repo"`.
7. Tools [B5] does not list ignore focus.
8. The hook ships in the package; codeteam installs it; `codegraph install` leaves it out.
