# Upstream commits after 5cd8a9a8: analysis

Date: 2026-11-03
Owner: Coord-upstream-prs
Request: Orc-Codegraph #1862 (R-26)
Companion: `pr-stack-handover-2026-11-03.md` (custody of the fourteen open PRs)

Paths are relative to `/Users/bob/devlop/team-codegraph/` unless they are absolute.
"Fork" is ours. The simulation baseline is 41782bea (section 1). Table abbreviations: NM is `src/resolution/name-matcher.ts`, RI is
`src/resolution/index.ts`, TS is `src/extraction/tree-sitter.ts`, EI is `src/extraction/index.ts`.
"NM set" means #3199, #3203, #3206, #3207, #3208, #3209 and #3210, the open PRs that change NM.

This lane did not merge, cherry-pick, build, test or fetch anything. Commit f72c9d2e was read through `gh api` only,
and it is not in the local object store.

## 1. Range and facts

- Range: `5cd8a9a83a203f16b5260b7a0425e6498f5afe1a..f72c9d2efb14454ff4f9fd7b8460abd82f19a287`.
- GitHub compare, read 2026-11-03: ahead_by 20, behind_by 0, 20 commits, 69 files.
- Upstream main, read 2026-11-03 with `gh api repos/colbymchenry/codegraph/commits/main`: f72c9d2e.
- Local `upstream/main` is 483a0988, which is 19 commits after 5cd8a9a8 (`git rev-list --count`). f72c9d2e is not in
  the local store (`git cat-file -t` fails).
- Simulation baseline: 41782bea, the worker's base when the lead's merge-tree run was made (2026-11-03). The lane/exchange
  was later updated to 9ff39864 (Orc #1871, coordinator pull-down). The simulation was not run against 9ff39864, so do
  not assume the two are the same.
- The fourteen open PRs are in the custody document, section 1 (table) and section 3 (observed heads).

## 2. Per-commit table (20 commits, oldest first)

Fork overlap is the set of files the commit shares with the fork's changes since 5cd8a9a8, at the simulation baseline
41782bea. PR overlap is the set of
files each open PR changes against its base. These are file-level overlaps only. For #3201, #3203 and #3206 (base
47a9c7d6), the commits up to 47a9c7d6 are already in the base, so their rows show that the PR's own changes touch the
same file. They do not show a new merge.

| # | Commit | Upstream PR | Change (gist) | Files | Fork overlap | PR overlap (PR: files) |
|---|---|---|---|---|---|---|
| 1 | d2e0389b | #3177 | Sparse checkout shown in status | 3 | CHANGELOG.md, EI | CHANGELOG.md (all 14); #3198: EI |
| 2 | 4b5cb19d | #3178 | CLI starts with a V8 new-space limit of 16 MB | 5 | bundle-launcher test, build-bundle.sh, wasm-runtime-flags.ts | #3197: the same three files |
| 3 | 3b37fb01 | #3179 | Parse workers started as needed; slow-file handoff | 10 | CHANGELOG.md, EI, TS, vitest.config.mts | CHANGELOG.md (all 14); #3198: EI; #3200, #3201, #3202, #3206: TS; #3197: vitest.config.mts |
| 4 | 3ee59947 | #3180 | Node rows read as arrays; a source file read through one open | 5 | src/db/queries.ts, RI | #3201, #3206: RI |
| 5 | 1f188da1 | #3181 | C and C++ text read by char codes | 9 | RI, NM | NM set; #3201, #3206: RI |
| 6 | 221d80c7 | #3184 | Rust use through a module with a file per cfg | 3 | CHANGELOG.md, NM | CHANGELOG.md (all 14); NM set |
| 7 | 608487e2 | #3185 | Go implementer's methods take and return the interface's types | 4 | CHANGELOG.md | CHANGELOG.md (all 14) |
| 8 | 45ea6801 | #3186 | Swift closure reaches the overload that takes a function | 3 | CHANGELOG.md, NM | CHANGELOG.md (all 14); NM set |
| 9 | be06c5e2 | #3187 | Java call arguments pick the overload; lambda parameter typed | 3 | CHANGELOG.md, NM | CHANGELOG.md (all 14); NM set |
| 10 | fab65e9d | #3188 | Java inherited members do not depend on resolve order | 3 | CHANGELOG.md, NM | CHANGELOG.md (all 14); NM set |
| 11 | c3443661 | #3189 | Java constant read from the other class | 4 | CHANGELOG.md, TS | CHANGELOG.md (all 14); #3200, #3201, #3202, #3206: TS |
| 12 | 41587d38 | #3190 | Kotlin chain reads through a holder of its type argument | 3 | CHANGELOG.md, NM | CHANGELOG.md (all 14); NM set |
| 13 | 59bfe6d7 | #3191 | Kotlin Multiplatform import reaches what the caller compiles against | 3 | CHANGELOG.md | CHANGELOG.md (all 14) |
| 14 | afa1e147 | #3182 | C++ project scans taken by resolver workers | 7 | RI | #3201, #3206: RI |
| 15 | 15483713 | #3183 | Resolver workers sized to what the main thread can keep busy | 5 | CHANGELOG.md, RI | CHANGELOG.md (all 14); #3201, #3206: RI |
| 16 | 4e96d759 | #3192 | A large run waits for its resolver pool | 3 | RI | #3201, #3206: RI |
| 17 | 6aa358cc | #3193 | Java lambda or method reference reaches the function overload | 3 | CHANGELOG.md, NM | CHANGELOG.md (all 14); NM set |
| 18 | 47a9c7d6 | #3194 | Python local binding decided by the line reading it | 3 | CHANGELOG.md, NM | CHANGELOG.md (all 14); NM set. Base of #3201, #3203, #3206 |
| 19 | 483a0988 | #3195 | Ruby parameter's class taken from the method's call sites | 12 | AGENTS.md, CHANGELOG.md, src/db/queries.ts, src/index.ts, RI, NM | CHANGELOG.md (all 14); #3197: AGENTS.md; #3204: src/index.ts; #3201, #3206: RI; NM set |
| 20 | f72c9d2e | #3214 | A resolver keeps no memo or Cargo read across a sync | 19 | AGENTS.md, CHANGELOG.md, src/index.ts, RI, NM, src/resolution/types.ts | CHANGELOG.md (all 14); #3197: AGENTS.md; #3204: src/index.ts; #3201, #3206: RI; NM set; #3206: types.ts |

## 3. f72c9d2e (#3214): the commit not simulated

Facts from `gh api` (2026-11-03). The commit changes 19 files: AGENTS.md, CHANGELOG.md, two new tests
(`__tests__/name-matcher-memo-clears.test.ts`, `__tests__/sync-memo-lifetime.test.ts`), three changed tests
(`__tests__/resolution.test.ts`, `__tests__/sync-module-config-change.test.ts`, `__tests__/worker-teardown.test.ts`),
src/engine.ts, src/index.ts, src/resolution/types.ts, src/resolution/resolver-pool.ts, src/resolution/import-resolver.ts,
src/resolution/index.ts, src/resolution/name-matcher.ts, and five framework files under `src/resolution/frameworks/`.

The upstream commit message says that a resolver lives as long as its CodeGraph, so a server syncs on one for days. It
says eight memos in name-matcher and three in the frameworks outlived `clearCaches`. It also says the Cargo crate map
and the compile database's include directories were read once for the process. The commit adds the memos to
`clearNameMatcherMemos`, renews the framework memos with the node lists, and moves Cargo manifests and compile databases
into the module-config snapshot.

Checked in the patch, saved to `/tmp/upstream-f72-review/f72c9d2e.diff` outside the repo:
- `clearNameMatcherMemos` gains the memo clears. The new test `__tests__/name-matcher-memo-clears.test.ts` checks that
  every module-level memo in name-matcher.ts is dropped by it or appears on a short allow-list.
- `getCargoWorkspaceCrateMap(context)` in `src/resolution/frameworks/cargo-workspace.ts` returns
  `context.getCargoCrates?.()` when that member exists, and otherwise `readCargoWorkspaceCrateMap(context)`.
  `ResolutionContext` in `src/resolution/types.ts` gains the optional `getCargoCrates`.
- `getModuleConfigSnapshot(previous, treeMoved = false)` in `src/resolution/index.ts`. The resolver supplies `getCargoCrates`.
- Removed from `src/resolution/import-resolver.ts`: the module-level `importMappingCache`, `clearImportMappingCache`
  and `clearCppIncludeDirCache`.

The removed symbols are defined in the fork (`src/resolution/import-resolver.ts:1719`, `:2522`, `:2527`). Nothing in
fork `src/` calls `clearImportMappingCache` or `clearCppIncludeDirCache`. Their only callers are in
`__tests__/resolution.test.ts` (lines 3876, 4110, 4134, 4164 and 4193), which the commit updates. The fork's
per-instance `importMappingCache` LRU in `src/resolution/index.ts:340` is a different field, and the commit leaves it alone.

Fork overlap: AGENTS.md, CHANGELOG.md, src/index.ts, RI, NM and src/resolution/types.ts.

## 4. Evidence levels

### 4.1 Demonstrated textual conflict: simulation baseline 41782bea with 483a0988

Source: `/tmp/bilby-r26/fork-mt.out`, the lead's `git merge-tree --write-tree` run. It writes tree objects only and
changes no ref, index or worktree. This lane did not repeat it. It read the saved conflict blobs,
`/tmp/bilby-r26/m-queries.ts` and `/tmp/bilby-r26/m-nm.ts`, which hold one conflict hunk each.

The run reports three conflicting files. The others auto-merged: AGENTS.md, the bundle-launcher test, build-bundle.sh,
EI, TS, wasm-runtime-flags.ts, src/index.ts, RI and vitest.config.mts.

- CHANGELOG.md: mechanical. Keep both entries.
- src/db/queries.ts: one hunk (`m-queries.ts:225-320`). The fork's f635b215 rewrites the doc comment above
  `FieldFilters`, adding the `pathPrefixes` text. Upstream's 3ee59947 inserts `arrayToNode`, `NodeStatement` and
  `prepareNodeStatement` (a 76-line insertion, hunk `@@ -220,6 +220,82 @@`) directly above the same comment. The
  conflict is the comment. The code does not overlap. Keep the inserted block and the rewritten comment.
- src/resolution/name-matcher.ts: one hunk (`m-nm.ts:32363-32465`). The fork side holds `swiftArgumentLabels` and
  `swiftCallFitsLabels` from 38cd0f0b (fork lines 31689 and 31698). The upstream side holds `isSwiftFunctionParameter`,
  `swiftParameters` and `swiftOverloadForClosure` from 45ea6801, inserted after `retargetSelfOverload` (hunk
  `@@ -31713,6 +31718,92 @@`). Keep both groups. The reference is `pr/swift-type-calls`, which holds six Swift helpers in one file:
  `swiftOverloadForClosure`, `isSwiftFunctionParameter`, `swiftParameters`, `swiftArgumentLabels`,
  `swiftCallFitsLabels` and `swiftCallHasTrailingClosure`.

f72c9d2e was not simulated, because it is not in the local store.

### 4.2 No conflict shown, and not a test

- The lead's runs, not repeated by this lane: `git merge-tree --write-tree --name-only --no-messages pr/<name> 483a0988`
  for each of the 14 `pr/*` branches. Per the lead, each run printed only a tree id and no conflicted path. The exit
  status is reported for one spot check only: pr/swift-type-calls returned exit 0. The output was not saved.
  `/tmp/bilby-r26/mergetree.sh` has the same form, with local upstream/main (483a0988) as the second argument, but its
  output was not saved either.
- GitHub reports all 14 MERGEABLE on 2026-11-03, against `main`, which read as f72c9d2e. That is textual mergeability
  at the time of the read. It is not a test.

## 5. Overlap risks (file level; no conflict shown)

Each risk names an owner and the check. Owners follow the walls in `team/claude/rules/product.md` ("Where code goes")
and in the dispatch brief: resolution, queries, host.

R1. f72c9d2e memo and Cargo rules (owner: resolution).
- The new rule requires every module-level memo in name-matcher.ts to be dropped by `clearNameMatcherMemos` or allow-listed.
  Fork memos added since 5cd8a9a8 must be checked against it. Upstream's 45ea6801 already adds `SWIFT_PARAMETERS` to
  `clearNameMatcherMemos` (its hunk `@@ -21980,6 +21980,7 @@`).
- The Cargo crate map now goes through `context.getCargoCrates`. The fork's callers of `getCargoWorkspaceCrateMap`
  (name-matcher.ts:9433, :9502, :9587 and frameworks/rust.ts:29) keep working through the fallback.

R2. #3207 suspects comment (owner: resolution, per Orc #1871, for the public PR path and the fork copy).
- Wall note: the lane walls list `src/graph` as queries' wall. The routing (`workcrews/upstream-prs/ledger/orders/pr-fixes-backport-inventory.md:12`)
  and S-37 (`team/settled.md:275`, "suspects.ts is resolution's") put suspects under resolution. This document follows the
  routing. Confirm the owner with Orc if the walls and the routing are read differently.
- At c8c87984, `src/graph/suspects.ts:268-270` builds a partial context and calls `getCargoWorkspaceCrateMap`. The comment
  there says the function "reads only `readFile` and `listDirectories`". #3208, #3209 and #3210 contain the same code by
  ancestry. The fork has the same code at `src/extensions/resolution/suspects.ts:263-285`, with the call at line 285.
- After f72c9d2e, the function first probes `context.getCargoCrates?.()`. The partial context has no such member, so the
  fallback should run as before. The comment is then incomplete. This lane did not test it.

R3. Rust: #3203 and #3202 (owner: resolution).
- #3203 (rust-path-call-edge-cases) changes NM and `src/resolution/rust-scopes.ts`. It shares NM with f72c9d2e.
- #3202 (rust-impl-in-fn) changes TS and `codegraph-kernel/src/rustlang.rs`. It shares no file with f72c9d2e. Any
  connection to the Cargo change is in meaning only.

R4. #3206 (owner: resolution).
- #3206 shares RI, NM and `src/resolution/types.ts` with f72c9d2e. In that file the commit adds one optional member,
  `getCargoCrates`, with its doc comment. Nothing else in the file changes (+6 -0 in the file list).
- 45ea6801's `swiftOverloadForClosure` and #3206's `swiftCallHasTrailingClosure` both decide trailing-closure calls. Both
  sit in NM on `pr/swift-type-calls`. Check them together, including the documented `if`-brace residual limit in the
  round-two notes (`r17-round2-results.md:22`).

R5. #3204 and src/index.ts (owner: host, which holds copied-index-locks as a PR candidate).
- `src/index.ts` is changed by 483a0988 and f72c9d2e (upstream) and by the fork. Check the merge against #3204's
  copied-index-locks changes in the same file.

R6. The V8 new-space flag (owner: host for the builder; Orc for the merge).
- 4b5cb19d adds `--max-semi-space-size=16` to `NODE_RUNTIME_FLAGS` (through `nodeRuntimeFlagsFor` in
  `src/extraction/wasm-runtime-flags.ts`), to the bundled launchers in `scripts/build-bundle.sh`, and to
  `scripts/npm-shim.js`.
- #3197 changes wasm-runtime-flags.ts, build-bundle.sh and the bundle-launcher test. The lead reports a clean textual
  merge. That is not simulated here. Read the two flag lists together.
- The fork's builder forks with `execArgv: [...WASM_RUNTIME_FLAGS, ...NODE_RUNTIME_FLAGS]`
  (`src/extensions/host/builder/client.ts:312`). It imports both lists from `src/extraction/wasm-runtime-flags.ts`
  (`client.ts:22`). After the merge, the builder child gets the new limit with no fork change.
  This is a memory behaviour change that host should know about.

R7. name-matcher.ts (owner: resolution).
- Ten upstream commits change NM: 1f188da1, 221d80c7, 45ea6801, be06c5e2, fab65e9d, 41587d38, 6aa358cc, 47a9c7d6,
  483a0988 and f72c9d2e. The NM set changes the same file, and so does every fork Swift change.

R8. Extraction files (owner: upstream-owned; Orc decides).
- TS: 3b37fb01 and c3443661 (upstream), and #3200, #3201, #3202 and #3206.
- EI: d2e0389b and 3b37fb01 (upstream), and #3198.

R9. RI (owner: resolution).
- Changed by 3ee59947, 1f188da1, afa1e147, 15483713, 4e96d759, 483a0988 and f72c9d2e (upstream), by #3201 and #3206,
  and by the fork. The three upstream resolver-pool commits (afa1e147, 15483713, 4e96d759) change RI in the same file as
  #3201's and #3206's changes.

R10. src/db/queries.ts (owner: queries, focus-recall). Changed by 3ee59947 and 483a0988 (upstream) and by the fork's
f635b215. See 4.1.

## 6. Recommendation

1. Orc merges the full range `5cd8a9a8..f72c9d2e` into ours through integration. This lane does not merge. f72c9d2e must
   be in the local store before any simulation, because it is not simulated yet (section 4.1).
2. Resolve the three fork conflicts as in section 4.1:
   - CHANGELOG.md: mechanical.
   - src/db/queries.ts: keep the inserted block and the rewritten FieldFilters comment. Queries checks the focus-recall behaviour.
   - src/resolution/name-matcher.ts: keep both Swift helper groups. Resolution checks the behaviour, using `pr/swift-type-calls` as the reference.
3. f72c9d2e is the commit most relevant to the server. A long-lived resolver keeps memos and Cargo data across syncs. It is
   the one commit whose textual merge was not simulated. Simulate it before the merge.
4. Owners' checks:
   - Resolution: R1 (the memo clear rule against the fork's memos since 5cd8a9a8, and the Cargo change), R2 (the suspects comment and the `getCargoCrates` probe, on the public path and in the fork copy at `src/extensions/resolution/suspects.ts`), R3 (#3203 with NM), R4 (#3206 with 45ea6801), R7.
   - Queries: the focus-recall comment (4.1) and the inherited orphans defects O-01 to O-12. The fork's orphans code is at `src/extensions/queries/orphans/orphans.ts`. Its line 880 is the fork's copy of the O-02 lookup. The fork has no `src/graph/git-diff.ts`, so the owner maps the path for O-10.
   - Host: R5 (copied-index-locks and src/index.ts) and R6 (the builder's V8 limit).
5. Open PRs: no restack is needed for textual reasons now. All 14 are MERGEABLE, and the lead's merge-tree runs against 483a0988
   print no conflicted path for any of them (4.2, not re-run here). Any later change to an open PR follows R-23, R-24 and S-47,
   under a new order. This document authorises no public action.

## 7. Corrections made by this pass, and uncertainty

Corrections to the lead's analysis, from source checks on 2026-11-03:
- The "one resolver for days" wording is upstream's, from the f72c9d2e commit message (#3214). The fork's `docs/SPEC.md`
  (sections 2 and 3, B13) keeps pinned databases open and current. It does not say that a resolver runs for days.
- `pr/swift-type-calls` holds six Swift helpers, not four (4.1).
- #3202 shares no file with f72c9d2e (R3). The earlier reading listed it as touching Rust resolution. It does not.
- The suspects comment exists in the fork as well, at `src/extensions/resolution/suspects.ts` (R2). It is not only on the PR path.
- The queries.ts conflict is in one doc comment above `FieldFilters` (4.1). It is not code inserted on top of code.
- `src/resolution/types.ts` is shared by f72c9d2e and #3206 (R4). The earlier list omitted it.
- The unverified orphans findings number eleven, not nine. The custody document records this (section 6.1).
- The baseline is pinned to 41782bea. The earlier text called it the lane's current HEAD. The lane/exchange is at 9ff39864 (section 1).
- Suspects is resolution's (Orc #1871; S-37). The earlier text put R2 under queries. Queries keeps the focus-recall and orphans items.

Uncertainty:
- The simulation baseline is 41782bea, not 9ff39864. The conflicts, the fork overlaps and the fork copies were not checked against 9ff39864.
- f72c9d2e is not simulated. It is not local, and it was read through `gh api` only.
- Overlap is not conflict. Every overlap here is at file level.
- Nothing was built, tested, merged, cherry-picked or fetched by this lane.
- The merge-tree results are the lead's and were not re-run here.
- GitHub mergeability can change. It was read against main at f72c9d2e.
- Line numbers are at the commits named. They are not line numbers in a merged tree.
