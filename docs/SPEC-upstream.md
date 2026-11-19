# SPEC: offering our work upstream

Draft 7, 2026-11-19, Designer-Codegraph. Governing decisions: Bob, 2026-10-31 (R-17), 2026-11-04 (R-31, the
hub, §7) and 2026-11-19 (R-56, the hub's stable `main`, §7 item 10). Upstream is `colbymchenry/codegraph`. Lines marked **[check]** are my reading; §6 lists them.

## 1. What Bob decided

1. Open **pull requests** for the changes that make sense on their own upstream.
2. Publish **a public fork** holding everything else, and open **one issue** upstream that describes what the fork
   adds and offers it for upstream to use as it likes.
3. If upstream wants any of it in the main repository, we **volunteer** to bring it over.

## 2. Before anything is cut

- Refresh the `upstream` mirror (ours carries upstream through 60b0d7a9, 2026-10-29) and merge it into integration,
  so every PR and the fork start from current upstream.
- PRs are cut from the per-feature commits on `exchange`, never from `integration` (one squash per integrate call) or
  `ours` (each `sm.N` release squashes many features into one commit).
- Every PR follows upstream's own rules (upstream `AGENTS.md`): tests in upstream's `__tests__/`, a `CHANGELOG.md`
  entry under `## [Unreleased]` in its user-facing style, no version bump.
- The team does the work with `gh` (Bob, R-17): it creates the fork under the `codedaptive` organisation, pushes
  the fork and the `pr/<feature>` branches to it, and opens the PRs and the issue upstream.

## 3. Pull requests

One PR per row, each on `pr/<feature>` cut from current upstream with that feature's commits applied, its tests
passing on upstream's suite. Smallest and least dependent first.

The rows are not all independent (Orc-Codegraph, from the tree, `design/Orc-Codegraph/ledger/reports/r17-plan.md`):
3 builds on 2; 5-8 share Swift/Rust resolution files and the extraction kernel; 12 builds on 11. A PR from the fork
cannot be based on another open PR, so a dependent PR either carries its prerequisite's commits (and says so) or
waits until the prerequisite merges. The refresh comes first: upstream is 84 commits ahead and a merge conflicts in
26 files.

| PR | Feature(s) | What it fixes |
|---|---|---|
| 1 | `query-pool-idle` | Idle query workers retire down to one (upstream issue #3027, already filed) |
| 2 | `copied-index-locks` | A copied `.codegraph/` recovers on its own instead of blocking on the source's lock |
| 3 | `lock-takeover-race` | Stale-lock takeover removes a lock only if it is still the one judged stale |
| 4 | `sync-mtime-refresh` | Sync stops re-hashing files whose content is unchanged |
| 5 | `swift-builtins` | Calls on Swift standard-library values no longer link by name to project methods |
| 6 | `swift-enum-cases` | Every case in a comma-separated Swift `case` list is indexed |
| 7 | `swift-external-member-ref`, `swift-static-calls`, `swift-qualified-inheritance` | Swift `Type.member()` calls and qualified supertypes resolve to the right type (one PR or three, as they apply) |
| 8 | `rust-impl-in-fn`, `rust-crate-calls` | Rust `impl` inside a function body, and `crate::path::Type::method` calls, resolve |
| 9 | `suspects`, `swift-builtins`' suspects part, `questionable-marks` | `codegraph suspects` and `codegraph_suspects`: name-only and low-confidence call edges, ranked for a person to check |
| 10 | `grep-by-symbol` | `codegraph grep` and `codegraph_grep`: regex hits grouped by enclosing symbol, ranked by incoming edges |
| 11 | `blast-base` | `codegraph blast` and `codegraph_blast`: the impact of a diff against its merge base |
| 12 | `orphans` | `codegraph orphans` and `codegraph_orphans`: symbols added since a ref that nothing uses |
| 13 | `node-25-support` | CodeGraph runs on Node 25 and later (upstream 60b0d7a9 still caps `engines` below 25 and exits on 25) |

PRs 9-12 (Bob, R-17): their logic stands alone (`grep-core.ts`, `blast.ts`, `orphans.ts`, `suspects.ts` import no
host code except grep's focus lookup). In each PR the command and tool are registered the way upstream registers
its own (`src/bin/codegraph.ts`, `src/mcp/tools.ts`), not through our extension hooks, and the session-focus parts
are left out; the questionable-call marks in grep and blast (`--strict`) follow PR 9.

Not a PR: the pinned tree-sitter-swift mis-parse test, which goes upstream as the drafted issue instead. (`node-25-support`
was first left out on upstream's guide; the upstream code at 60b0d7a9 still refuses Node 25, so it is PR 13. If the
refresh shows upstream has since fixed it, it drops.)

Two Swift issues already drafted (Orc-Codegraph's todo) go upstream with the PRs: the 0.7.3 `if try await` mis-parse,
and `declaredSupertypes` reading a nested type's inheritance clause. Status: both filed 2026-11-01, #3212 and #3213,
open with no replies (checked 2026-11-08). Our fix for #3213, `swift-nested-supertypes`, landed on `integration`
2026-11-08 (2f1b826a); it is not yet offered upstream as a PR.

## 4. The public fork and its issue

**The fork** is upstream plus every feature on `ours`, under a public GitHub fork of `colbymchenry/codegraph` in the `codedaptive` organisation. `codedaptive/codegraph` is
already taken by our private repository (not a GitHub fork), so the public fork takes another name:
`codedaptive/codegraph-sharedserver` (R-17), renamed `codedaptive/codegraph-hub`, the official public fork (R-31,
§7). It
carries the product only: no `fleet/`, no fork-only root `Makefile` (codeteam's targets), no `docs/RULINGS.md`, team
reports or graft golden files. (R-17) Its README opens with a section on what the fork adds and how to
use it.

**The issue** upstream, one, describes the fork's additions in user terms and links the fork:

| Area | What the fork adds |
|---|---|
| One server per machine | One MCP server for every repository and worktree, started by the first client; each call names its path; databases open on demand and close after 10 idle minutes, with no cap |
| Index builder | One long-lived process with a queue does every index write; small syncs go ahead of full builds; a query waits at most a few seconds for a queued copy, never for a full build |
| Worktree lifecycle | A new git worktree copies its index from the nearest indexed sibling; a removed worktree's index is deleted; dead locks are reclaimed |
| Session focus | `serve --mcp --focus <dir>`: finding tools answer inside the focus, impact tools cover the whole repository and list out-of-focus results apart |
| Worktree hook | A Claude Code `PreToolUse` hook that sets `projectPath` to the agent's own git root |
| Fresh answers | `--fresh` / `fresh: true` and `checkpoint`: an answer says what tree state it describes |
| Extension hooks | New CLI commands and MCP tools added from `src/extensions/<zone>/` without editing upstream files |

It says plainly which of these change upstream's defaults (no default project, indexing without opt-in, the repo
anchor), that the fork runs on macOS only so far, and that we will bring any part upstream as opt-in, tested on
Linux and Windows, if they want it.

## 5. Done

- The public fork exists under `codedaptive` with its README section.
- Every §3 PR is open upstream from its `pr/<feature>` branch on the fork, applying to current upstream and passing
  upstream's suite, with its `CHANGELOG` entry.
- The fork issue and the two Swift issues are open upstream.

## 6. Readings to confirm

1. Settled by R-17: the fork leaves out the team's files
   (`fleet/`, the codeteam Makefile, rulings, reports, graft golden files, `docs/SPEC*.md`).
2. Settled by R-17: grep, blast, orphans and suspects are PRs (9-12).
3. Settled by R-17: the public fork is `codedaptive/codegraph-sharedserver`; renamed `codedaptive/codegraph-hub`
   by R-31.

## 7. The hub (R-31)

1. **Name.** `codedaptive/codegraph-hub` is the official public fork: `codegraph-sharedserver` renamed (one fork per
   organisation; GitHub redirects the old name, so #3211's link and existing clones keep working).
2. **Stance.** The README opens by saying the hub tracks `colbymchenry/codegraph` and keeps its own feature set (the
   §4 table), is updated monthly, and takes issues. Issues are turned on.
3. **The README says simply and clearly exactly what we added and how to use it** (Bob, R-31 amended):
   - one entry per added feature, each with one plain sentence of what it does and then how to use it: the command,
     argument, setting or file, with a short example; nothing we did not add, nothing left out;
   - fixes we carry ahead of upstream in a short list, each with its upstream PR number;
   - how to install and point an agent at it, and where it differs from upstream's defaults;
   - written for a stranger: no internal names, rulings, lanes or process words; every claim true of the hub's
     `main` (Kong checks it against the code);
   - upstream's README is not appended (it would contradict the hub on install, `codegraph upgrade` and indexing):
     it is kept as `UPSTREAM-README.md` at the top level, exactly as of the upstream version the update merged, under
     a two-line note ("This is upstream's README as of <version>. To install and run the hub, see README.md."), and
     the README links it once near the top ("For everything else CodeGraph does, see upstream's README"). Each
     monthly update regenerates it.
4. **License.** The hub carries upstream's license unchanged (MIT; upstream's `LICENSE` file as is), and the README
   says so.
5. **Monthly update.** Once a month: current upstream merged into `ours` through integration, the whole-suite gate,
   then the hub's `develop` brought to that `ours` with §4's exclusions and R-19's rules (no graft references, the
   bob-codedaptive identity); the stable `main` and the release follow from it as item 10 says (R-56). The backporter
   lane runs the update (R-56, superseding R-36). The hub is public, so the `develop` push publishes too: like the
   push to `main` (item 10), it refuses while the `ours` it takes still carries an open security finding (rules/global.md
   rule 12), and that `ours` waits for the fix to promote. Each `develop` update is one commit whose tree is `ours` minus
   §4's exclusions plus the README. While the hub has no outside users (no stars, forks, or issues or pull requests
   from anyone else), its only parent is the upstream `main` that update merged and it is force-pushed over the
   previous `develop`, kept first as a backup ref on our private origin (R-35); after that it has two parents, that
   upstream `main` and the previous `develop`, and is never force-pushed (S-56). (Before R-56 these updates went to
   the hub's `main`; the first, from sm.12, was released as `v1.6.2-sm.12`. 2026-11-04: the hub's `main` was
   900d223b, upstream 5cd8a9a8 plus one commit.)
6. **Sooner fixes.** An issue reported on the hub that needs a fix before the next monthly update gets one out of
   cycle, through the owning lane and the same gate. An open upstream PR comes into `ours` before upstream merges
   it only on Bob's word, PR by PR (R-40: #3249 and #3215); when upstream merges it, the monthly update takes
   upstream's version.
7. **The PRs.** S-53's restack leaves all 14 PRs mergeable; after that they stay open as offered, with no further
   pushes, restacks or bot replies. If the maintainer himself comments on one, upstream-prs answers him.
8. **Issue #3211.** Its body is edited to name the hub; no new comment (R-25).
9. **Upgrade and update notice (R-32).** `codegraph upgrade` installs the hub's latest release (or the hub version
   named) and never upstream's package or install script; a source checkout keeps "git pull && npm run build". The
   update check reads the hub's releases. Versions keep the `-sm.N` suffix, compared by its number.
10. **Stable `main` and `develop` (R-56).** The hub has two long-lived branches:
    - `develop` is the line item 5 updates: `ours` as published, its history as it comes.
    - `main` is the stable branch and the hub's default. It takes only cleaned-up commits. Upstream comes in as a
      real merge, with the upstream commit a parent and never squashed in, so GitHub's compare against upstream
      stays meaningful and the next upstream merge has a base. Each of our features is one squash with a `Feature:`
      trailer, so it can still be offered upstream as a pull request. `main` is never force-pushed.
    - The backporter lane builds each batch on a candidate branch cut from `main`: the upstream merge the batch
      needs, then one squash per feature changed since the last batch, cleaned (§4's exclusions, R-19's rules, the
      README per item 3). The candidate is done when its tree equals `develop`'s tree for the same `ours` and the
      whole-suite gate passes on it. The backporter then merges it into `main` and pushes. That push is the
      publishing gate (rules/global.md rule 12): it refuses any change that still carries an open security finding.
      It is not the only one: the `develop` push (item 5) is checked the same way, so no public push carries one.
    - Releases are cut from `main` only, as GitHub releases of the hub tagged `v` plus the build's own version (the
      packed `package.json` version, e.g. `v1.6.3-sm.17`; the base follows the merged upstream, S-102), with the
      packed build attached. `develop` gets no releases, so `codegraph upgrade` and the update notice (item 9) offer
      only stable builds.
    - The first candidate builds `main` from the upstream base sm.17 carries (cc17b69a) and `ours` at sm.17
      (987c3715), and its release is `v1.6.3-sm.17`. The `pr/<feature>` branches (§3) are left as they are.
