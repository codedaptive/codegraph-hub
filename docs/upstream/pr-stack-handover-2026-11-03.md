# Upstream PR stack: custody handover

Date: 2026-11-03
Owner: Coord-upstream-prs
Request: Orc-Codegraph #1862, implementing Bob's R-26 (message #1859)
Companion: `upstream-review-2026-11-03.md` (analysis of upstream commits after 5cd8a9a8)

Paths are relative to `/Users/bob/devlop/team-codegraph/` unless they are absolute.

This document records custody of the fourteen open upstream pull requests. It authorises no public mutation: no push,
PR edit, reply, branch move or cleanup. Nothing below was run by this lane, except the read-only checks in section 3.

Two kinds of record are kept apart:
- Section 2 is INHERITED. The results were recorded on 2026-11-03 by Orc-Codegraph and its RS-3 reviewer. This lane did
  not re-run them.
- Section 3 is OBSERVED. This lane made the read-only checks on 2026-11-03 (gh pr list, gh api, git rev-parse and
  merge-base). Nothing was fetched, checked out or written.

## 1. The fourteen open PRs

All fourteen are open on colbymchenry/codegraph, base `main`, not drafts. Source: `design/Orc-Codegraph/ledger/reports/handover-upstream-prs.md:11-27`.
"Base" is the commit each branch was cut from (its merge-base with upstream). "Sits on" is the open PR whose commits
lie underneath it.

| PR | Branch | Head | Base | Sits on |
|---|---|---|---|---|
| #3197 | node-25-support | 1c78ef9a | 5cd8a9a8 | alone |
| #3198 | sync-mtime-refresh | cb940a10 | 5cd8a9a8 | alone |
| #3199 | swift-builtins | 3b9f3597 | 5cd8a9a8 | alone |
| #3200 | swift-enum-cases | bd2e11f0 | 5cd8a9a8 | alone |
| #3201 | swift-qualified-inheritance | aacc6d28 | 47a9c7d6 | alone |
| #3202 | rust-impl-in-fn | edcbf06b | 5cd8a9a8 | alone |
| #3203 | rust-path-call-edge-cases | 6321cfcc | 47a9c7d6 | alone |
| #3204 | copied-index-locks | d9357165 | 5cd8a9a8 | alone |
| #3205 | lock-takeover-race | c42a83f0 | 5cd8a9a8 | alone |
| #3206 | swift-type-calls | 44588f82 | 47a9c7d6 | #3201 |
| #3207 | suspects | c8c87984 | 5cd8a9a8 | #3199 |
| #3208 | grep-by-symbol | 0e7639a1 | 5cd8a9a8 | #3207 |
| #3209 | blast-base | d836e397 | 5cd8a9a8 | #3207 |
| #3210 | orphans | 63afb04a | 5cd8a9a8 | a copy of #3208's commit (a3985bd0), which sits on #3209 |

Dependency order:
- #3201 comes before #3206.
- #3199 comes before #3207. #3207 comes before #3208 and #3209.
- The #3210 stack, bottom to top, is: c8c87984 (#3207), then d836e397 (#3209, blast), then a3985bd0 (a copy of #3208's
  grep commit), then 63afb04a (#3210, orphans). So a3985bd0 sits above #3209 and below #3210. Source: RS-3 return
  (`design/Orc-Codegraph/ledger/reports/r17-round2/RS-3-return.md:44-47`). Parents checked with `git log`: 63afb04a has
  parent a3985bd0, a3985bd0 has parent d836e397, and d836e397 has parent c8c87984.
- The other PRs stand alone.

Restack rule: a change in a parent means a restack of every child. Each restack is proved by tree equality or patch-id equality. A follow-up commit is never used (`handover-upstream-prs.md:29`; R-23 in section 5).

## 2. INHERITED: checks and receipts (recorded 2026-11-03, not re-run by this lane)

Source: `design/Orc-Codegraph/ledger/reports/r17-round2-results.md` (table rows 9-19, notes 21-27) and
`r17-round2/RS-3-return.md`. Counts are as the sources record them.

Round-two verdicts. Round two answered the Codex bot's comments under R-24.

| PR | Round-two comments | Verdicts | Pushed head | Recorded tests |
|---|---|---|---|---|
| #3199 | 2 | 2 REAL | 3b9f3597 | 21 tests; 11 fail on main |
| #3207 | 2 | 1 DUPLICATE, 1 REAL | c8c87984 | body edited |
| #3208 | 2 | 2 REAL | 0e7639a1 | 128 passed, 1 skipped |
| #3209 | 2 | 2 REAL | d836e397 | 104 passed in 4 files |
| #3210 | 2 | 1 REAL, 1 REAL-LIMIT (documented, not fixed) | 63afb04a | orphans 148 passed; blast 104; grep 128 passed, 1 skipped |
| #3201 | 2 | 2 REAL; change review PASS | aacc6d28 | 14 tests; 6 of the 10 vector tests fail on main |
| #3206 | 4 | 3 REAL, 1 WRONG on its mechanism | 44588f82 | parent #3201; two known-limit sentences added |
| #3202 | 2 | 2 REAL | edcbf06b | 20 tests and 2 todo |
| #3203 | 3 | 2 REAL, 1 WRONG | 6321cfcc | 17 cases |
| #3204 | 1 | 1 REAL | d9357165 | see the lock suites below |
| #3197, #3198, #3200, #3205 | none | none | unchanged | none |

The table holds 22 comments: the 18 that R-24 names on eight PRs, plus 4 on #3209 and #3210 (`RULINGS.md:233-240`).

Lock suites for #3204 (round-two row 18): writer-lock 7, mcp-writer-lock 6, filelock-stale-takeover 7 (1 skipped),
daemon-older-version 28, daemon-bind-failure 4, copied-index-locks 10 passed. daemon-socket-fallback has 17 passed and
1 failed at its line 77. The PR text states that failure as environment-specific.

RS-3 receipts (`RS-3-return.md:19-79`):
- rs3/grep-by-symbol 0e7639a1: typecheck exit 0. grep-by-symbol 104 passed, 1 skipped; grep-questionable 24 passed.
- rs3/blast-base d836e397: typecheck exit 0. blast 58, blast-diff 18, blast-questionable 11, blast-surfaces 17 passed (104 in all).
- rs3/orphans 63afb04a: typecheck exit 0. The orphans suites pass 148 over seven files, including orphans-surfaces.
- Leak scan clean and no trailer lines on the three branches (`RS-3-return.md:26-28`, `40-41`, `77-78`).
- Change review: PASS, no findings (`RS-3-return.md:84-88`).

Not re-run, as the sources say:
- The MCP contract tests `mcp-tool-allowlist` and `mcp-tool-annotations`. The blast and orphans texts cite 29 passed,
  and the grep text cites 11 passed. The fixups touch no `src/mcp/` (`RS-3-return.md:139`; `handover-upstream-prs.md:41`).
- The Rust kernel mirror of #3202. It compiles (`npm run build:kernel`, exit 0, `r17-round2-results.md:27`), but its
  tests were not run and the kernel was never loaded.

Test method, as the sources record it:
- The node-25 change (`git diff 5cd8a9a8 pr/node-25-support`) was applied to the working tree only for the four
  CLI-spawning suites, then reverted after each tip. It was never committed (`RS-3-return.md:82`).
- Load was 110 when RS-3 started. Runs went one at a time at load 39 to 97, with no timing failures (`RS-3-return.md:140`).

## 3. OBSERVED on 2026-11-03 (read-only)

Checked by this lane:
- `gh pr list -R colbymchenry/codegraph --author @me --state open`: all 14 are OPEN and not draft, and report
  mergeable MERGEABLE. Each head equals the table in section 1. No comment fields were requested.
- The local `refs/heads/pr/*` in the shared object store (`/Users/bob/devlop/.repos/codegraph.git`) equal the same
  fourteen heads.
- Parent links: c8c87984^ is 3b9f3597; 44588f82^ is aacc6d28; 0e7639a1^ and d836e397^ are c8c87984; 63afb04a^ is
  a3985bd0; a3985bd0^ is d836e397. These match section 1.
- Merge-base with local `upstream/main` (483a0988): 5cd8a9a8 for eleven PRs, and 47a9c7d6 for #3201, #3203 and #3206.
- GitHub's MERGEABLE is textual mergeability against `main` at the time of the read, not a test. `main` read as
  f72c9d2e (`upstream-review-2026-11-03.md`, section 1).
- Origin's copies of the heads were not re-read here. The handover says they matched on 2026-11-03
  (`handover-upstream-prs.md:11`).

## 4. Scripts and preconditions (not run)

Source: the headers of the scripts in `design/Orc-Codegraph/ledger/jobs/`, read only. They are historical tools. Their
presence here is not authorisation. Nothing was executed.

| Script | Purpose (from its header) | Preconditions (from header and body) |
|---|---|---|
| `leak-scan.sh` | Scans added lines, commit messages, identities and Co-Authored-By lines, and an optional PR text. Exits 1 on a match. | Worktree, base (default 4499d007, a historical base, so pass 5cd8a9a8), optional text file, ref. The handover requires it before every push and body edit (`handover-upstream-prs.md:33`). |
| `prepush-check.sh` | Pre-push check of `restack/<name>` branches (`PREFIX`, default `restack`): leak scan, trailers, identity, merge base, tip. | Uses the `_base` checkout and `name:base` pairs. Takes the merge base against `refs/remotes/upstream/main`. |
| `push-round2.sh` | Saves the old tip as `refs/backup/r17-round2/<n>`, moves `pr/<n>` to `rs3/<n>`, and pushes to the fork with a lease. | The fork's tip must equal the local `pr/<n>`, and `rs3/<n>` must exist. Writes to the public fork. This is a public mutation. |
| `rs3-single.sh` | One-commit restack of an independent PR: `rs3/<name>` is the tree of `fixr2/<name>` as one commit on the PR base. | `fixr2/<name>` must be the published tip plus one commit. `pr/<name>` must be a single commit with no trailer lines. |
| `rs3-tree-proof.sh` | Patch-id and tree proofs for the RS-3 branches. | Hard-coded hashes (a4f8544d, c8c87984) and the `_base` path. Uses a temporary index; otherwise read-only. |
| `build-rs3-bodies.sh` | Builds the bodies of #3208, #3209 and #3210 from `texts/<name>.md`, re-adds parent PR numbers, and diffs each against the live body. | Reads the live bodies with `gh pr view`. Writes to the Orc scratchpad. |
| `post-round2-replies.sh` | Posts one reply per bot comment (`PR:commentid`). Idempotent through `posted.log`. | Reply texts in `reports/r17-round2/replies/`. This posts public replies. R-24 and R-25 forbid it under this order. |
| `backup-origin-round2.sh` | Pushes `refs/backup/r17-round2/*` and `pr/*` to origin, with leases on the saved old tips. | Backup refs must exist. Writes to origin. |
| `run-lock-suites.sh` | Adds a worktree at `rs3/copied-index-locks`, runs seven lock suites through `make test-one`, then removes the worktree. | Needs the `_base` Makefile and node_modules copied in. Writes a worktree and logs. |

The CLI-spawning suites (grep-by-symbol, grep-questionable, blast-surfaces and orphans-surfaces) need the node-25 diff
applied to the working tree, and reverted after (`handover-upstream-prs.md:35`). The machine runs Node 26 there.

## 5. Binding rules (R-18 to R-26)

Source: `design/codegraph-ours/docs/RULINGS.md`, which holds R-1 to R-26. The worker's own `docs/RULINGS.md` still ends
at R-21, because its base (41782bea) predates the exchange copy at 9ff39864. Orc resolved this in #1871 (section 6.7).

- R-18 (line 176): the installed CodeGraph (1.6.2-sm.8) stays in use. Tests run in isolation, and Bob is told before any install or update.
- R-21 (line 203): no Linux or Windows validation. Each PR text says it was tested on macOS only.
- R-22 (line 210): run only the changed tests. No duplicate full suites.
- R-23 (line 217): one squash per feature, and no follow-up commits on a pushed PR. The handover adds the commit rule: public commits carry the PR's own message, with no trailers (`handover-upstream-prs.md:32`).
- R-24 (line 233): round two was the last round of fixes and replies for the bot's comments. Nothing is fixed or replied to for comments that round-two pushes draw.
- R-25 (line 247): post no comment asking the maintainer for anything. Post each reply when it is ready.
- R-26 (line 258): this lane owns the PRs and the analysis of new upstream commits. A code change inside a PR is a REQUEST to the owning lane (host, queries or resolution). The daily merge stays with Orc-Codegraph.

## 6. Open items

### 6.1 Inherited orphans findings (assigned to queries)

Orc-Codegraph's handover asks that the orphans findings go to queries as one REQUEST with the table
(`design/Orc-Codegraph/ledger/reports/handover-upstream-prs.md:39`). The lane's handoff records that REQUEST as #1865 to
Coord-queries (`workcrews/upstream-prs/ledger/reports/handoff.md:40`). The terms were relayed to queries as #1870
(`handoff.md:41`; `workcrews/upstream-prs/ledger/reports/orphans-inherited-findings-2026-11-03.md:38`). Queries owns
verification and any code fix. Nothing in this document fixes them.

The thirteen findings, at 63afb04a (`RS-3-return.md:123-134`; `orphans-inherited-findings-2026-11-03.md:11-23`):

| ID | Priority | Location (63afb04a) | Status in the sources |
|---|---|---|---|
| O-01 | P1 | src/graph/orphans.ts:1098 | Confirmed by reading. A probe gave 249,500 entries for 500 same-named symbols. |
| O-02 | P2 | src/graph/orphans.ts:1020 | Confirmed by reading. A plain-object lookup throws for a parent named `constructor`. |
| O-03 | P2 | src/graph/orphans.ts:833 | Unverified. |
| O-04 | P2 | src/graph/orphans-run.ts:108 | Unverified. |
| O-05 | P2 | src/graph/orphans.ts:926 | Unverified. |
| O-06 | P2 | src/graph/orphans.ts:891 | Unverified. |
| O-07 | P2 | src/graph/orphans.ts:815 | Unverified. |
| O-08 | P2 | src/graph/orphans.ts:931 | Unverified. |
| O-09 | P2 | src/graph/orphans.ts:668 | Unverified. |
| O-10 | P2 | src/graph/git-diff.ts:229 | Unverified. Shared with blast (#3209). |
| O-11 | P3 | src/graph/orphans-run.ts:98 | Unverified. |
| O-12 | P3 | src/graph/orphans.ts:804 | Unverified. |
| O-13 | P3 | src/graph/orphans.ts:172 | Maintenance (a duplicated kind list). Excluded by S-47. |

Source note: `r17-round2-results.md:24` says "nine P2/P3 listed in the return" for the unverified items. The return
lists eleven (eight P2, three P3). This document uses eleven.

S-47 terms (`team/settled.md:349-354`, Designer #1869, answering #1866), in the order's wording:
1. One final push of #3210, and of #3209 only where the shared git-diff code changes.
2. Only O-01 to O-12 behavioural defects that queries verifies, each with a test that fails on the published head.
3. O-13 is excluded.
4. Unverified and not-reproduced findings are left out and listed. The eleven unverified items above are left out unless queries verifies them.
5. The PR bodies' tests and limits are updated.
6. The same fixes go into ours through queries (#1864).
7. No fixes or replies for bot comments that the push draws (R-24).
8. R-18, R-21, R-22 and R-25 hold.

This order authorises no public mutation. Round-two follow-on bot comments are not processed (R-24).

### 6.2 Known limits left in the PR texts

Source: `handover-upstream-prs.md:40`, and `r17-round2-results.md:22` and `:26-27`.
- Opt-in tools are hidden on projects under 500 files in direct mode. This is upstream's gate, `ToolHandler.getTools()` in src/mcp/tools.ts:2462-2470. The grep, blast, orphans and suspects texts state it.
- #3206: the residual `if`-brace case, and module-blind superclass-name matching.
- #3202: the `[lib] path` and `#[path]` limits.
- #3203: two generic-bound readers that still count `<` and `>` inside a const block.
- grep keeps vue, svelte, astro, razor and cfml files line-only.

### 6.3 Not re-run

See section 2. The MCP contract tests and the Rust kernel mirror of #3202 were not run.

### 6.4 Comments drawn by the round-two pushes

These were not read, as R-24 requires. At the last look, #3198, #3205, #3197 and #3200 had no new comment (`handover-upstream-prs.md:42`).

### 6.5 Cutting notes (not done by this order)

Source: `handover-upstream-prs.md:43`, and the settled entries S-19 (`team/settled.md:143`) and S-26 (`team/settled.md:192`).
- Each PR's CHANGELOG `[Unreleased]` entry, with the upstream issue number (S-19), checked against what is already published.
- The tests of copied-index-locks, query-pool-idle and lock-takeover-race move from `__tests__/extensions/host/` to `__tests__/` (S-26).
- Other notes listed in the handover: grep-windows-hide and a windowsHide commit for blast, lock-takeover.ts beside utils.ts (K-19), the swift-enum-cases and swift-static-calls notes, and the worktree-lifecycle split (K-28).

### 6.6 Branches in `_base` (not cleaned by this order)

Source: `handover-upstream-prs.md:44`. The counts there were not re-counted by this lane.
- `pr/*` (14): keep.
- `fixr2/*` (10) and `rs3/*` (10): on origin, per `backup-origin-round2.sh`.
- `fix/*` (11), `restack/*` (12) and `restack2/*` (2): delete only when sure nothing needs them, locally and on GitHub.
- `refs/backup/r17-pre-restack/*` and `refs/backup/r17-round2/*`: keep until told otherwise.
- `worktree-agent-*` branches belong to host.

### 6.7 Lane layout (resolved by Orc #1871 on exchange at 9ff39864)

- `docs/lanes/upstream-prs.md` and the rulings copy were missing or stale, as routed to Orc in #1867. Orc resolved both
  in #1871. The commit is `9ff39864` on exchange. The branches `exchange` and `lane/upstream-prs` both point at it, and
  this lane read its content: `git show 9ff39864:docs/lanes/upstream-prs.md` returns the lane's zone guide, and
  `git show 9ff39864:docs/RULINGS.md` holds R-22 to R-26. The Orc #1871 decision itself rests on the coordinator's report.
- This worker's base (41782bea) predates that commit. The base was deliberately not moved while the worker is active.
  The worker's own `docs/lanes/` holds only `queries.md`, and its `docs/RULINGS.md` ends at R-21.
- A separate request handles `docs/upstream/pr-fixes-backport-inventory-2026-11-03.md` for Orc #1871. It is not part of
  this request, and this lane did not create or touch that file.

### 6.8 Tool limitation

Reported in the dispatch brief and not re-checked here: the role-listed codegraph, git-worktree and zone-tests skills
returned "Unknown skill", and the mootx01 memory recall returned unrelated material only. This lane used gh and git
read commands and file reads.
