# Upstream main cc17b69a into ours: merge review

Date: 2026-11-18
Owner: Coord-upstream-prs
Request: Orc-Codegraph #4414 (docs/SPEC-upstream.md §7.5 merge; creator #4413), work order upstream-review-cc17b69a
Companions: `upstream-review-2026-11-03.md` (format precedent), `pr-stack-handover-2026-11-03.md` (custody list)

"Ours" is the `ours` branch at 82e81862, which was also `integration` when this was read. "Theirs" is upstream main
at cc17b69a. Abbreviations: NM is `src/resolution/name-matcher.ts`, RI is `src/resolution/index.ts`, II is
`src/resolution/import-resolver.ts`, TS is `src/extraction/tree-sitter.ts`, EI is `src/extraction/index.ts`, SI is
`src/index.ts`. Line numbers in section 3 are lines of the trial merge's result tree 43f88f8d (below), conflict
markers included, unless a line says otherwise.

This lane merged, checked out, built and tested nothing. Every fact below was read with `git log`, `git show`,
`git diff`, `git merge-tree` (in memory only) or `gh`, in the request's worktree. CodeGraph was not used: the
search server answers only for the lane's own repository path, not this worktree's.

## 1. Range and facts

| Fact | Value | Command |
|---|---|---|
| Ours | 82e818620093 (`ours` = `integration` = this worktree's HEAD) | `git rev-parse HEAD integration ours` |
| Theirs | cc17b69a66ad; the live `refs/heads/main` was still cc17b69a when read | `git rev-parse upstream/main`; `git ls-remote upstream refs/heads/main` |
| Merge-base | f72c9d2efb14 | `git merge-base ours upstream/main` |
| Upstream commits past the base | 77 (it includes release 1.6.3, 3212a990) | `git rev-list --count f72c9d2e..upstream/main` |
| Ours past the base | 901 commits | `git rev-list --count f72c9d2e..ours` |
| Trial merge | tree 43f88f8d, 13 conflicting files, the same 13 as Orc's trial | `git merge-tree --write-tree --name-only --messages ours upstream/main` |

Conflict kinds, from the same command: content conflicts in 10 files, modify/delete in `src/mcp/daemon-registry.ts`
and `src/mcp/project-lifecycle.ts` (deleted in ours, modified upstream; git leaves upstream's copy in the tree), and
add/add in `__tests__/swift-try-await-condition.test.ts`.

Conflict blocks per file (`git show 43f88f8d:<file>` read for `<<<<<<<` / `=======` / `>>>>>>>`):

| File | Blocks | Lines of 43f88f8d |
|---|---|---|
| `src/bin/codegraph.ts` | 1 | 426-458 |
| TS | 1 | 27-32 |
| `src/mcp/daemon.ts` | 2 | 377-397, 615-636 |
| `src/mcp/engine.ts` | 6 | 83-94, 104-132, 138-162, 304-331, 354-411, 443-549 |
| `src/mcp/index.ts` | 2 | 515-544, 575-594 |
| `src/mcp/session.ts` | 1 | 323-360 |
| `src/mcp/tools.ts` | 3 | 163-182, 5089-5093, 5156-5160 |
| NM | 11 | 14-21, 2774-2784, 2789-2815, 2823-2828, 2861-2926, 2952-2959, 2964-2970, 12564-12573, 12577-12610, 28488-28505, 34708-34747 |
| `src/resolution/pascal-scope.ts` | 2 | 1013-1022, 1057-1060 |
| `src/resolution/swift-type-visibility.ts` | 2 | 139-206, 301-312 |
| `__tests__/swift-try-await-condition.test.ts` | 3 | 2-62, 75-90, 97-284 |

## 2. Per-commit table (77 commits, oldest first)

"Files" counts every file the command below lists for the commit, CHANGELOG.md included. "Ours overlap" lists the files a
commit changes (CHANGELOG.md left out) that ours has also changed since f72c9d2e
(`git diff --name-only f72c9d2e ours`). File level only: an overlap is not a conflict. Five commits carry author dates
before the newest commits around them (7f6e4348, 98d722a4, b2862791, 5fd2d019, df208537): they were merged into upstream main
after f72c9d2e, so the table follows `git log --reverse` order, not author date.

| # | Commit | PR | Gist | Files | Ours overlap |
|---|---|---|---|---|---|
| 1 | 01a49312 | #3196 | C++: a call through a template parameter links each class written as its argument | 15 | AGENTS.md, src/db/queries.ts, RI, NM, src/resolution/types.ts |
| 2 | 329dd12f | #3215 | Resolution walks answer the same whoever asks first (final form of the PR ours carries) | 10 | the two #3215 tests, c-macro-renames.ts, cpp-includers.ts, II, RI, NM, pascal-scope.ts |
| 3 | 9bc50cf0 | #3306 | Release notes cut to GitHub's limit | 3 | AGENTS.md |
| 4 | b300ccea | #3307 | 1.6.3 changelog condensed | 1 | none |
| 5 | 22c11045 | #3312 | Blank string contents by slices (perf) | 3 | NM |
| 6 | 73d57959 | #3313 | C#: extension-method overload by its arguments | 2 | NM |
| 7 | b0779f76 | #3314 | PHP: anonymous classes, imported names, Eloquent locals | 5 | NM |
| 8 | 2b5adb3a | #3315 | Rust: a call through Pin onto a type parameter | 3 | NM |
| 9 | 932a7fab | #3316 | Ruby: a class name is the class Ruby's lookup finds | 4 | NM |
| 10 | 94c1c0eb | #3317 | Sync skips the manifest walk when git shows no manifest change | 6 | EI, SI, RI |
| 11 | 1f569a6a | #3318 | One-off sync drops framework-detection reads | 3 | EI, SI |
| 12 | 147fe290 | #3319 | TS: callback parameters, call results, type guards type the receiver | 9 | EI, SI, II, RI, NM |
| 13 | 3212a990 | #3323 | Release 1.6.3 | 3 | package.json, package-lock.json |
| 14 | d19748fa | #3324 | CI: macOS kernel on macos-15 | 1 | none |
| 15 | 44098dec | #3325 | README for 1.6.3 | 1 | README.md |
| 16 | ef4bd058 | - | Changelog: [Unreleased] to [1.6.3] | 1 | none |
| 17 | f8b3681b | #3326 | Site docs for 1.6.3 | 14 | none |
| 18 | e2af4146 | #3328 | CI: wait for npm up to 30 minutes | 1 | none |
| 19 | ffaaf6f2 | #3331 | Python: `import time` links no project function `time` | 4 | RI, NM |
| 20 | 1ddbe699 | #3334 | Rust: a module a glob `use` brings in, and a head a function's `use` binds | 3 | NM |
| 21 | 5ea5aeb9 | #3338 | Change detection without git's index lock | 3 | EI |
| 22 | 7f6e4348 | #3248 | Impact reads a node's edges in one unlimited query (PR #3249's change) | 4 | __tests__/graph.test.ts, src/db/queries.ts, src/graph/traversal.ts |
| 23 | 21cb1699 | #3354 | MCP: a catch-up the WAL valve stopped backs off (5 s doubling to 5 min) | 3 | src/mcp/project-lifecycle.ts |
| 24 | 70853c06 | #3355 | MCP: a direct session arms its liveness watchdog on first work | 5 | src/mcp/engine.ts, index.ts, session.ts |
| 25 | 96abf099 | #3356 | Daemon exits once its project is gone; deregister only its own record | 4 | src/mcp/daemon-registry.ts, src/mcp/daemon.ts |
| 26 | 34ce0f49 | #3345 | JS/TS: `this.m()` and a shadowing local don't link the import | 5 | II, RI, NM |
| 27 | a7fb6d89 | #3352 | JS/TS: a bare call links the declaration in scope | 3 | NM |
| 28 | bff60e89 | #3353 | JS/TS: namespace re-exports and `export *` barrels | 4 | II, NM |
| 29 | 8184f026 | #3371 | TS: a local's call result and an interface property decide the method | 3 | NM |
| 30 | ac6149c5 | #3372 | JS/TS: a call two fields deep from `this` | 4 | RI, NM |
| 31 | e10d3920 | #3333 | Installer: upgrade from the home folder leaves user-wide setup alone | 3 | none |
| 32 | fd2c36b3 | #3336 | CLI init says when the last index run didn't finish | 3 | __tests__/cli-install-init.test.ts, src/bin/codegraph.ts |
| 33 | 619b5a62 | #3344 | CLI callers/callees/impact warn when a file changed since indexed (`src/graph/file-drift.ts`) | 5 | src/bin/codegraph.ts, src/mcp/tools.ts |
| 34 | d2facd72 | #3351 | A workspaces entry outside the project names no member | 3 | none |
| 35 | e4cc9662 | #3359 | Status reports changes to gitignored source that `include` indexes | 3 | EI |
| 36 | 460b4f24 | #3363 | A run killed by a signal names it and exits like a shell | 6 | src/extraction/wasm-runtime-flags.ts |
| 37 | 0ae76391 | #3370 | Synthesis: a test's request reaches only its own app's routes | 3 | none |
| 38 | bbaf7185 | #3373 | Sync: a call through an imported object follows edits to its members | 6 | SI, NM |
| 39 | adad3152 | #3332 | PHP: `(new Foo())->bar()` | 4 | II, NM |
| 40 | 8fb8b91d | #3337 | Laravel: a route's controller is the imported class | 3 | none |
| 41 | bc81faa1 | #3347 | Java: a call reaches the same-named class the file can see | 3 | NM |
| 42 | 3e4d8697 | #3348 | Kotlin: extension on an aliased library type | 3 | NM |
| 43 | 7e57aa16 | #3361 | PHP: method called in another letter case | 4 | II, NM |
| 44 | b4be1c70 | #3368 | PHP: `$str{0}` offset keeps its function | 3 | none |
| 45 | 1e590ea6 | #3379 | PHP: require/include inside a function | 5 | TS |
| 46 | 98d722a4 | #3265 | Blast radius counts Rust `#[cfg(test)]` and tests.rs callers as tests (`isTestCode` takes a source reader) | 6 | src/bin/codegraph.ts, src/mcp/tools.ts |
| 47 | d5f883cb | #3343 | Rust file read as a declared module only by a declarable name | 2 | none |
| 48 | b2862791 | - | Rust: a method passed as a value through its path | 7 | TS, RI, NM |
| 49 | 723781d9 | #3382 | Rust kernel keeps a function passed through its path | 3 | codegraph-kernel/src/rustlang.rs |
| 50 | be3a0e08 | #3383 | Rust: no link to a same-named method a bare name can't reach | 4 | RI, NM |
| 51 | 4fb11bc4 | #3384 | Rust: calls inside `format!`, `assert_eq!`, `vec!` (`rust-macro-calls.ts`) | 7 | codegraph-kernel/src/rustlang.rs, TS |
| 52 | 0ac95cb5 | #3349 | Python: an overloaded function's call reaches the def that runs | 5 | src/db/queries.ts, RI |
| 53 | 905b1fd7 | #3350 | Python: `self.x()` on an attribute | 4 | RI, NM |
| 54 | 962e8796 | #3357 | Python: builtins link no project namesake | 3 | RI |
| 55 | 195462e8 | #3358 | Python: a name the code around it binds | 3 | NM |
| 56 | 5969542c | #3360 | Python: a local built through its module or bound by `with` | 3 | NM |
| 57 | 6f0fa222 | #3375 | Python: a local typed by its callee's return | 4 | NM |
| 58 | d2f3f07e | #3377 | Python: a from-import inside a function is that function's | 4 | II, NM |
| 59 | ddac1222 | #3362 | JS: an emitted event links only handlers on the same emitter | 6 | none |
| 60 | bb0f254e | #3380 | JS: a constructor's prototype and static functions are its methods | 10 | TS, II, NM |
| 61 | 3b860721 | #3386 | JS/TS: a call on `this` never links a const, require or declared function | 4 | RI, NM |
| 62 | 99014e22 | #3339 | Swift: inheritance read from the type's own header, not a nested type's | 3 | src/resolution/swift-type-visibility.ts |
| 63 | d509d2f5 | #3388 | C#: a call on what a bare method call returns | 3 | NM |
| 64 | 1a161dc9 | #3389 | ASP.NET attribute routes | 5 | none |
| 65 | 70decd12 | #3390 | C#: extension method by its `this` parameter's type | 3 | NM |
| 66 | dc53ff33 | #3385 | Go: a method called on `new(T)` / `make(T)` | 7 | TS, RI, NM |
| 67 | da7089da | #3387 | C#: calls through `?.` and `!.` | 5 | TS |
| 68 | 9253fea5 | #3391 | C#: a method group through a receiver is a use | 7 | RI, NM |
| 69 | 7efa65b6 | #3392 | Swift: tree-sitter-swift 0.7.4 (wasm and kernel) | 15 | __tests__/kernel-swift-parity.test.ts, __tests__/swift-try-await-condition.test.ts, codegraph-kernel/src/swift.rs, TS |
| 70 | 46450bc3 | #3340 | JS/TS: a local declared after a comma or beside a default shadows | 3 | NM |
| 71 | b2858dd6 | #3364 | JS: a member a required module lacks links nothing else | 3 | NM |
| 72 | 3d27a988 | #3365 | Tier: a call to another host's URL links none of the project's routes (fixes #2974) | 3 | none |
| 73 | 6e03cda6 | #3366 | JS/TS: an unimported standard global links no module's export | 4 | NM |
| 74 | 5fd2d019 | #2964 | A relative require of a folder loads its package.json main | 3 | II |
| 75 | 19f906a7 | #3378 | JS: a variable holding a required module's call result is not the module | 4 | II, NM |
| 76 | df208537 | #3271 | An installed but undeclared package is the package's | 4 | RI |
| 77 | cc17b69a | #3374 | A parse that never ends is cancelled (`parse-budget.ts`, `parse-pool.ts`) | 25 | codegraph-kernel/src/rustlang.rs, codegraph-kernel/src/swift.rs, TS |

Commands: `git log --reverse --format='%h|%ad|%s' --date=short f72c9d2e..upstream/main`; per commit
`git diff-tree --no-commit-id --name-only -r <sha>` compared with `git diff --name-only f72c9d2e ours`.

## 3. Per conflict file: what each side changed, and the resolution

Per-file history: `git log --reverse --format='%h %s' f72c9d2e..upstream/main -- <file>` (theirs) and
`git log --no-merges --format='%h %s %(trailers:key=Feature,valueonly)' f72c9d2e..ours -- <file>` (ours). Many of
ours' commits are landing squashes with no `Feature:` trailer; those are named by subject.

Besides the conflict blocks, three upstream commits auto-merged hunks into ours' MCP files that only make sense with
upstream's per-project daemon. They are listed with their file below and must come out in the merge commit, or the
type-check fails or dead code lands (`git diff -U0 ours 43f88f8d -- <file>` gives every hunk).

### 3.1 `src/bin/codegraph.ts` (owner: host)

- Theirs: fd2c36b3 (#3336, init reports an unfinished last run), 619b5a62 (#3344, `warnChangedOnDisk` and
  `changedOnDisk` in callers/callees/impact), 98d722a4 (#3265, `isTestCode(e.node, sourceOf)`).
- Ours: many host commits, among them 162d4bad machine-server, 47548e7c index-builder, 48467fa7 cli-builder-route,
  82d760d3 (R-46), 9be4fa03 and f3481b7f (R-50), 49f23494 (S-82), and the stopped-note series b07fb427, f7f6ce0d,
  457dc95f, 64ce642e, 1df6d97d, 8b15c7e6.
- Block 426-458: both sides added a helper after `openIndexToRead`. **Keep both**: ours' `stoppedNoteFor` and
  `warnStoppedIndex` (lines 427-439), close `warnStoppedIndex` with its own `}`, then theirs' `warnChangedOnDisk`
  (441-457); the shared `}` at 459 closes `warnChangedOnDisk`.
- Auto-merged, keep: `unfinishedIndexWarning` and `readLastIndexRun` (#3336) and their use in `runInit` and `status`;
  `filesChangedSinceIndexed` / `warnChangedOnDisk` calls in callers/callees and impact; `isTestCode(e.node, sourceOf)`.
  `readLastIndexRun` opens the index read-only in the CLI process: host confirms that is allowed on a root in no git
  worktree and not opted in (ours refuses CLI reads there, S-82), and on a stopped root.

### 3.2 TS, `src/extraction/tree-sitter.ts` (upstream-owned: Orc)

- Theirs: 1e590ea6, b2862791, 4fb11bc4, bb0f254e, dc53ff33, da7089da, 7efa65b6, cc17b69a.
- Ours: 941ef2a2 and 705b5307 (Rust impl in a fn body, `rust-impl-in-fn-review-fixes`), a1646ab5
  (`swift-enum-cases`), 59113aea (Swift qualified inheritance).
- Block 27-32 (imports): ours dropped `rustImplTypeName` from the `./languages/rust` import (its impl-in-fn code
  replaced the one use); theirs added `import { rustMacroArgRefs } from './languages/rust-macro-calls';` (4fb11bc4).
  **Keep both, without `rustImplTypeName`**: `import { rustImplItemOwner } from './languages/rust';` then theirs'
  `rustMacroArgRefs` line. The merged tree has no other use of `rustImplTypeName` in TS
  (`git grep -n rustImplTypeName 43f88f8d -- src/extraction`).
- The grammar bump (7efa65b6) also replaces `src/extraction/wasm/tree-sitter-swift.wasm` and auto-merges
  `codegraph-kernel/src/swift.rs` and `rustlang.rs`, which ours also changed: the kernel needs a rebuild before the
  parity tests mean anything.

### 3.3 `src/mcp/daemon.ts` (owner: host)

- Theirs: 96abf099 (#3356, fixes #3245): the per-project daemon checks every 5 s that its project is still there and
  exits after 30 s gone; `deregisterDaemon(root, pid)`.
- Ours: the per-project daemon became the machine-wide server: 1f967e06 `machine-server`, cc0e43ef `index-builder`,
  5b8ece1a and 01fed579 `session-focus`, b9d7e144 `cli-builder-route`, 3eb1b655 `socket-candidate-length`, 28e6e43a
  `pinned-open-at-start`, 85467837 `pinned-seed`, 474aca5b `split-server-fix`, and earlier 949ce9e5, 1f647706,
  c754e940.
- Block 377-397 (constructor): **keep ours** (no `projectRoot`, server socket and pid paths, `BuilderClient.start`).
- Block 615-636 (old stop body with `deregisterDaemon(this.projectRoot, process.pid)`): **keep ours** (empty).
- Auto-merged, **remove** (all #3245, all need `this.projectRoot`, which the machine server has not): lines 122-170
  (`DEFAULT_ROOT_CHECK_MS`, `DEFAULT_ROOT_GONE_GRACE_MS`, `isMissing`, `projectGoneReason`), 361-364
  (`rootCheckTimer`, `projectGoneSince`, `rootGoneGraceMs`), 540-543 (clearing `rootCheckTimer`), 726-759 (the
  timer start and `checkProject`), 1202-1219 (`resolveRootCheckMs`, `resolveRootGoneGraceMs`).
- Why not port it: ours serves many projects in one process with no idle exit (R-9, R-10); a gone project must not
  stop the server. Ours already releases a project whose folder or index is gone (the engine's housekeeping,
  `EngineHousekeeping` in `src/extensions/host/worktree-lifecycle/housekeeping.ts`, and `src/extensions/host/worktree-lifecycle/teardown.ts`), and removes
  its socket and lock only while it still owns them (474aca5b). See section 4, item C5.

### 3.4 `src/mcp/daemon-registry.ts`: modify/delete (owner: host)

- Deleted by ours in 1f967e06 (`machine-server`); ours' earlier edits (949ce9e5, 1f647706, c754e940) went with it.
  The per-project registry has no single successor: the machine server is one per machine, and ours' project records
  are `src/extensions/host/worktree-lifecycle/project-registry.ts`.
- Theirs: 96abf099 only, `deregisterDaemon(root, pid?)` leaves another daemon's record alone.
- **Resolution: keep the deletion** (`git rm src/mcp/daemon-registry.ts` in the merge). Nothing to re-apply: ours'
  equivalent guard is the ownership-checked socket and lock removal of 474aca5b (`split-server-fix`).
- Also **do not take** `__tests__/daemon-project-gone.test.ts` (new in 96abf099): it imports `Daemon` with a
  `projectRoot` constructor, `projectGoneReason`, `src/mcp/daemon-paths`' `getDaemonPidPath` and this deleted file.
  Host confirms ours has a test for a gone worktree's release (teardown) before the merge drops it.

### 3.5 `src/mcp/project-lifecycle.ts`: modify/delete (owner: host)

- Deleted by ours in cc0e43ef (`index-builder`; 1f967e06 edited it first). The writer slot, watcher and catch-up it
  managed per project are the builder's now: `src/extensions/host/builder/` (`holder.ts`, `queue.ts`, `service.ts`).
- Theirs: 21cb1699 (#3354, fixes #3273): after a catch-up sync the WAL valve stopped (`WalValveAbortError`, code
  `WAL_VALVE_ABORT`), the project waits 5 s, doubling to 5 minutes, before the next attempt.
- **Resolution: keep the deletion** (`git rm src/mcp/project-lifecycle.ts`), and **do not take**
  `__tests__/project-lifecycle-valve-backoff.test.ts` (it imports `acquireProject` from the deleted file).
- Re-apply elsewhere: settled by S-93 (Designer, 2026-11-18, on Orc #4590), not part of the merge. The builder
  re-queues a catch-up the WAL valve stopped (`WalValveAbortError`, code `WAL_VALVE_ABORT`) with #3354's backoff: 5 s,
  doubling per stop in a row, capped at 5 minutes, no attempt cap while the hold lasts; each stop is logged with the next attempt, and a retry ended at a job limit is not retried (S-69). Host's WO valve-catchup-retry
  is landed (569d95ec, e0102231, a718ef83; handling in `src/extensions/host/builder/holder.ts`, `queueCatchUp`).
  #3273 is not an open question for us. Section 5.

### 3.6 `src/mcp/engine.ts` (owner: host)

- Theirs: 70853c06 (#3355, fixes #3250): `onWorkBegins` option, `noteToolCall()`, `workBegins()`, called from
  `retryInitializeSync` and `doInitialize`.
- Ours: c754e940 `worktree-lifecycle`, 1f967e06 `machine-server`, cc0e43ef `index-builder`, b9d7e144
  `cli-builder-route`, 1c29eb7a `uninit-unlock-r15`, 28e6e43a `pinned-open-at-start`, 85467837 `pinned-seed`, 913e3cdd.
  Ours removed the default-project, writer-lock and lease code the theirs side of each block still carries.
- All six blocks: **keep ours**. Theirs' side of blocks 104-132, 304-331, 354-411 and 443-549 is upstream's old
  default-project code with #3250's few lines inside it; ours has none of it (a `projectPath` field, `initPromise`,
  `retryInitializeSync`, `doInitialize`, `explicitProjects`, `watchOptions`).
- Every #3250 line in the merged file is inside a block (`git diff -U0 ours 43f88f8d -- src/mcp/engine.ts`), so keeping
  ours removes all of it.

### 3.7 `src/mcp/index.ts` (owner: host)

- Theirs: 70853c06 (#3250): direct mode passes `onWorkBegins: () => this.armLivenessWatchdog()` and arms the watchdog
  lazily.
- Ours: 92f165e2, 1f967e06 `machine-server`, cc0e43ef `index-builder`, 5b8ece1a and 01fed579 `session-focus`, 474aca5b
  `split-server-fix`, 30fa7483.
- Block 515-544: **keep ours** (`resolveAnchor`, `BuilderClient.start` or `makeFallbackEngine()`).
- Block 575-594: **keep ours** (`this.livenessWatchdog = installMainThreadWatchdog(...)` at launch). Theirs' side also
  repeats `this.mode = 'direct'` and the two installs that ours does at 511-513.
- Auto-merged, **remove**: line 382-383, `private livenessWatchdogArmed = false;`, unused once ours' blocks are kept.
- Why not port #3250 in the merge: ours' direct mode starts a builder child at launch anyway (all but the no-builder fallback), so a lazy watchdog
  saves one of two extra processes, and direct mode is ours' fallback, not the normal path (the session proxies to the
  machine server). Host may port it later as a small change. **Do not take** `__tests__/mcp-lazy-watchdog.test.ts`
  without that port: it expects a direct session with no watchdog before the first tool call.

### 3.8 `src/mcp/session.ts` (owner: host)

- Theirs: 70853c06, one call `this.engine.noteToolCall?.();` before dispatch.
- Ours: 8a94fa2b, 6501b2bf, 162d4bad, 47548e7c, 48467fa7, c27aff7b: dispatch moved behind an `outcome` object.
- Block 323-360: **keep ours** (`this.transport.sendResult(request.id, outcome.result);`). Theirs' side is upstream's
  old inline dispatch with the one #3250 line.

### 3.9 `src/mcp/tools.ts` (owner: host; the blast-radius text is read by queries)

- Theirs: 619b5a62 (#3344: the drift check moves to `src/graph/file-drift.ts` as `fileDrift`) and 98d722a4 (#3265:
  `testCodeReading`, `isTestCode` with a `SourceReader`, `indirectTestNote` takes an `isTest` predicate).
- Ours: 30-odd commits; the ones in these hunks are the session-focus series (47548e7c, 19f45082, 00ace95c, 2455e7c8,
  34cb8982: `indirectTestNote` takes the focus `prefixes`) and the imports of ours' host extensions.
- Block 163-182 (imports): **both, trimmed**: ours' lines 164-178 without `import { indexedHashInput } from
  '../file-limits';` (its one use, ours' inline drift hash, is replaced by `fileDrift` in the auto-merged hunk at
  3440-3442), plus theirs' `import { fileDrift } from '../graph/file-drift';`. Keep ours' path import
  (`resolve as resolvePath, dirname`): theirs' `relative as relativePath` is used upstream only by
  `knownSubprojects`, which ours does not have.
- Blocks 5089-5093 and 5156-5160: **combine**. `indirectTestNote` needs both the focus and the predicate: line 5179
  (auto-merged context) reads `prefixes`, line 5181 (auto-merged from theirs) reads `isTest`. Signature
  `indirectTestNote(cg, directCallers, rel, prefixes, isTest)` and call `this.indirectTestNote(cg, uniq, rel,
  prefixes, isTest)`.
- Auto-merged, keep: `testCodeReading` (4992-5017), `const isTest = this.testCodeReading(cg);`, test files by caller
  (5071-5074), the drift check through `fileDrift`.

### 3.10 NM, `src/resolution/name-matcher.ts` (owner: resolution)

- Theirs: 37 commits (section 2, every row with NM), +4247/-198 lines against the base (`git diff --numstat`).
- Ours: e4d185df, 3b3e142e, 38cd0f0b, 69de0412, 2803fe38 `swift-builtins-review-fixes`, be45bad8
  `swift-static-calls-review-fixes`, cf921c51 `rust-path-calls-review-fixes`, 5512afb0
  `swift-builtins-trailing-closure-fix`, fa8994c5 `hub-scrub-resolution`, fca3b349 (PR #3215's head b9d7af9f3f as
  carried under R-40).
- Blocks 2774-2784, 2789-2815, 2823-2828, 2861-2926, 2952-2959, 2964-2970 (Lua alias walk) and 34708-34747
  (`tsAliasedType`): **take theirs**. Each is #3215's final form (329dd12f: the walk is a loop, no stack frame per
  step) against the earlier head ours carries (fca3b349; R-40: "When upstream merges either, the monthly update takes
  upstream's version"). Theirs' `tsAliasedType` drops the `seen` parameter; no caller passes it in the merged tree's
  blocks (resolution confirms with the type-check).
- Block 14-21 (imports): **union**: theirs' `js-builtins` line (adds `JS_STANDARD_GLOBALS`, 6e03cda6), and ours'
  `SWIFT_TYPE_CALL, SWIFT_TYPE_PATH_CALL, resolveSwiftTypeCall, resolveSwiftTypePathCall` line and ours'
  `swift-builtins` line (`SWIFT_STD_METHODS, isSwiftStdMethodName`).
- Block 28488-28505: **both**: ours' comment lines (Swift `Type.member()` settled earlier by `resolveSwiftTypeCall`)
  followed by theirs' Java receiver code (`javaClass`, bc81faa1, #3347).
- Blocks 12564-12573 and 12577-12610 (`rustPathTarget`): **the one block that needs judgement.** Both sides make a
  head that a function-local `use` binds resolve through that `use`. Ours (cf921c51, carry-back of our PR #3203's
  review findings) rewrites `segs`, `head` and `bare` through each local alias in turn, loop-guarded, and stops at a
  nearer block `mod` (`modAround`). Theirs (1ddbe699, #3334) keeps `head` and `bare` const, records the binding in
  `headUse`, and uses it below in the memo key (`headScope`, line 12616) and in `named()` (lines 12628-12636), which
  the merge already auto-merged. Recommendation: **take theirs** for both blocks, so `headUse` is set and the
  auto-merged code below it works, then run ours' `__tests__/rust-path-call-edge-cases.test.ts` and
  `__tests__/rust-path-super-glob.test.ts` with theirs' `__tests__/rust-glob-module-paths.test.ts`. Any of ours'
  cases that then fails (an alias of an alias as a head, a nearer block `mod`) is a fix-forward order for resolution
  on top of `headUse`, not a reason to keep ours' version: ours' loop leaves `headUse` unset and theirs' function-scope
  cases would fail. Taking ours instead is the other choice; it needs `let headUse` declared and set by hand.

### 3.11 `src/resolution/pascal-scope.ts` (owner: resolution)

- Theirs: 329dd12f (#3215 final). Ours: fca3b349 (#3215 head).
- Blocks 1013-1022 (`MAX_ALIAS_WALK = 1000` and its comment) and 1057-1060 (`if (seen.size >= MAX_ALIAS_WALK)
  return null;`): **take theirs** (R-40, as 3.10).

### 3.12 `src/resolution/swift-type-visibility.ts` (owner: resolution)

- Theirs: 99014e22 (#3339, fixes #3213): `INHERITANCE_CLAUSE` with an optional clause and
  `blankSwiftCommentsAndStrings`, matched from the declaration keyword.
- Ours: 13 commits, the one in these blocks is 2f1b826a (`swift-nested-supertypes`, landed 2026-11-08): the same bug,
  fixed already (`blankSwiftHead`, `swiftDeclarationHead`, clause pinned at the keyword, cut at the depth-0 body brace).
- Blocks 139-206 and 301-312: **keep ours**. Theirs' `blankSwiftCommentsAndStrings` has no other caller in the merged
  tree once ours' block 301-312 is kept, so it goes with theirs' side. Both regexes answer "no clause" for a header
  with no colon.
- Then run theirs' two new cases in `__tests__/swift-type-visibility.test.ts` (auto-merged, +78 lines) against ours'
  code, with ours' `__tests__/extensions/resolution/swift-nested-supertypes.integration.test.ts`. If a theirs case
  fails, resolution takes theirs' reading instead and keeps ours' test; that is the place to decide, not the merge.

### 3.13 `__tests__/swift-try-await-condition.test.ts`: add/add (owner: host by the lane map; the subject is Swift extraction)

- Ours: 6022954b (`swift-method-range`, S-29) and fa8994c5: three `it.fails` cases pinned to tree-sitter-swift 0.7.3
  (VECTOR_1, VECTOR_1_COMMENT, VECTOR_2) and one control `it` (VECTOR_3), on the wasm extractor only.
- Theirs: 7efa65b6 (#3392, fixes #3212): grammar 0.7.4; samples KIT (= ours' VECTOR_1 text), SMALL and OTHERS, run on
  the kernel and on wasm, plus a parse-without-error check.
- **Combine, theirs as the base.** Under 0.7.4 ours' three `it.fails` cases would pass, and `it.fails` then reports
  each as a failure. Keep theirs' file whole and add ours' VECTOR_1_COMMENT (a comment between `try` and `await`),
  VECTOR_2 (the `restorePending` shape) and VECTOR_3 (the control) as plain `it` cases, through theirs' `extract`
  helper so they run on both backends. Drop ours' header text about 0.7.3.

## 4. Coverage: what upstream now covers

Commands: `gh pr list --repo colbymchenry/codegraph --author @me --state all --json ...` (all 15 of ours open, none
merged or closed), `gh api graphql` for each R-40 and R-51 PR, `git show <sha> | git patch-id --stable`,
`git merge-base --is-ancestor`, and for each PR head `git merge-tree --write-tree --name-only cc17b69a <head>`.

### 4.1 Carried upstream PRs (R-40) now on upstream main

| PR | Upstream state | Upstream commit | Evidence | Merge action |
|---|---|---|---|---|
| #3215 | MERGED 2026-11-16 | 329dd12f | Final form is larger than the head ours carries (b9d7af9f3f; ours fca3b349 + 802cfea9): NM 156 vs 40 lines changed, pascal-scope.ts 51 vs 43, plus `__tests__/alias-chain-length.test.ts` | take theirs in its blocks (3.10, 3.11) |
| #3249 (issue #3248) | PR page still OPEN | 7f6e4348 "(#3248)" | Same three files and counts as the PR head b536579b32 plus a CHANGELOG line; patch-id of b536579b32 = ours' c5ddc1b7 (401f9e0e13c9) | auto-merges; nothing to do. Upstream-prs may ask the maintainer to close #3249 as landed (a public action: R-25 applies) |

### 4.2 R-51 PRs (not yet in ours)

`git log --grep` finds none of #3261, #3258, #3303, #3256, #3226 in `f72c9d2e..ours`.

| PR | Upstream state | Covered by this range? | Trial merge of its head onto cc17b69a |
|---|---|---|---|
| #3256 absolute fetch URLs (fixes #2974) | OPEN | **Yes, redundant**: 3d27a988 (#3365) "Fixes #2974", an independent fix in `src/resolution/tier-synthesizer.ts` | CONFLICT in `tier-synthesizer.ts` |
| #3261 rebind callers on shared definition change | OPEN | No. Adjacent: bbaf7185 (#3373) adds a sync re-open pass for edited object literals beside the CG-33 rebind; a different case | clean |
| #3258 synthesis skips dispatch scans with no targets | OPEN | No | clean |
| #3303 grammar loads wait for each other | OPEN | No (7efa65b6 touches `grammars.ts` for the Swift bump only) | clean |
| #3226 TS variance annotations | OPEN, MERGEABLE | No | head eedeb6ad32 is not in the local object store: not tried |

Recommendation for Orc: drop the #3256 order from R-51's queue (R-51: "If upstream merges one of them first, it comes
in with the main merge instead"; here upstream merged a different PR for the same issue, so this is the designer's or
Bob's call to confirm, not the lane's).

### 4.3 Our own features upstream now covers

| # | Ours | Upstream | Extent | Evidence |
|---|---|---|---|---|
| C1 | `swift-nested-supertypes` (2f1b826a) | 99014e22 (#3339, fixes #3213) | Same bug, independent fix | 3.12 |
| C2 | `swift-method-range` pin (6022954b, S-29: "fixed by a grammar bump") | 7efa65b6 (#3392) tree-sitter-swift 0.7.4 | The bump S-29 waited for | 3.13 |
| C3 | Carried #3215, #3249 | 329dd12f, 7f6e4348 | Full | 4.1 |
| C4 | Our PR #3203 (`rust-path-call-edge-cases`) and its carry-back cf921c51 | 1ddbe699 (#3334) function-scoped `use` heads; be3a0e08 (#3383) | Partial: the function-local `use` head case | 3.10; #3203 head conflicts with cc17b69a in NM |
| C5 | `machine-server` housekeeping, `split-server-fix` ownership-checked removal | 96abf099 (#3356, fixes #3245) | Upstream fixes #3245 for its per-project daemon; ours already releases a gone project and keeps the server; nothing taken | 3.3, 3.4 |
| C6 | queries' blast test counting (`src/extensions/queries/shared/test-path.ts`, path-based) | 98d722a4 (#3265): Rust `#[cfg(test)]` and tests.rs callers count as tests in explore's blast radius | Covered, landed (987c3715): `codegraph_blast` counts a Rust out-of-line `cfg(test)` module file as test code (`inCfgTestFile`, per file, as well as by path); `orphans` also counts an inline `cfg(test)` or `cfg(all(test, ..))` module's symbols (`inCfgTestModule`). Open limits in `src/graph/test-code.ts` (owner orc): the one-line form `#[cfg(test)] mod x;` is not read, and `CFG_TEST` also matches `cfg(all(any(unix, test), ..))` | section 5 |

### 4.4 Our open PRs on upstream (the custody list plus #3329)

All 15 are OPEN and none is merged or closed (`gh pr list ... --author @me --state all`). GitHub reports
`mergeable` CONFLICTING for all fifteen (`gh pr list ... --json number,state,mergeable`). The local trial
merge of each head onto cc17b69a:

| PR | Name | Trial merge onto cc17b69a | Upstream range overlap |
|---|---|---|---|
| #3197 | node-25-support | clean | none found |
| #3198 | sync-mtime-refresh | clean | EI changed by 94c1c0eb, 1f569a6a, 147fe290, 5ea5aeb9, e4cc9662 |
| #3199 | swift-builtins | clean | none found |
| #3200 | swift-enum-cases | clean | TS changed (7efa65b6 grammar bump) |
| #3201 | swift-qualified-inheritance | clean | 99014e22 changes the same function, `declaredSupertypes`; still needed (upstream still reduces a dotted supertype to its last segment) |
| #3202 | rust-impl-in-fn | **CONFLICT** in TS | b2862791, 4fb11bc4 |
| #3203 | rust-path-call-edge-cases | **CONFLICT** in NM | partly covered (C4) |
| #3204 | copied-index-locks | clean | none found |
| #3205 | lock-takeover-race | **CONFLICT** in `src/mcp/daemon.ts` | 96abf099 |
| #3206 | swift-type-calls | **CONFLICT** in NM | NM (37 commits) |
| #3207 | suspects | clean | none found |
| #3208 | grep-by-symbol | clean | none found |
| #3209 | blast-base | clean | 98d722a4 changes test classification in explore's blast radius (C6) |
| #3210 | orphans | clean | none found |
| #3329 | `.codegraphignore` (the S-75 half) | clean onto cc17b69a and onto e2af4146 (GitHub's recorded base) | not covered: upstream main has no `.codegraphignore` (`git grep -i codegraphignore upstream/main -- src` finds nothing); e4cc9662 (#3359) is the `include` path, not an ignore file |

GitHub's CONFLICTING is not reproduced by the clean local merges above; the cause was not found. Re-check on GitHub
before any push (a public action; R-25 applies).

## 5. Owner checks after the merge

Test paths are run with `make zone-test-one DIR=<path>` in the owning lane's tree; upstream's new tests live in
`__tests__/` and are run by path.

| Lane | Conflict or feature | Check |
|---|---|---|
| Orc (upstream-owned `src/extraction/`, `codegraph-kernel/`) | 3.2 TS; 7efa65b6 grammar; cc17b69a parse deadline | `npx --no-install tsc --noEmit -p .`; rebuild the kernel (ours and theirs both changed `codegraph-kernel/src/swift.rs` and `rustlang.rs`); `__tests__/kernel-swift-parity.test.ts`, `__tests__/kernel-rustlang-parity.test.ts`, `__tests__/rust-macro-calls.test.ts`, `__tests__/parse-deadline.test.ts`, `__tests__/rust-impl-in-fn-body.test.ts`, `__tests__/rust-impl-review-parity.test.ts` |
| host | 3.1 CLI | `__tests__/cli-install-init.test.ts`, `__tests__/cli-line-drift.test.ts`, `__tests__/extensions/host` (stopped note); `codegraph init` on an initialized root, on a root outside git and not opted in, and on a stopped root: confirm `readLastIndexRun` neither opens what S-82 refuses nor loses the stopped note |
| host | 3.3-3.5 daemon, registry, lifecycle | the merge drops `daemon-project-gone.test.ts` and `project-lifecycle-valve-backoff.test.ts`; confirm ours has a test that a removed worktree is released by the server (C5); the valve-stop retry (#3273) is settled by S-93 and landed (valve-catchup-retry) |
| host | 3.6-3.8 engine, index, session | `__tests__/extensions/host` whole; the merged tree has no `onWorkBegins`, `noteToolCall`, `workBegins` or `livenessWatchdogArmed` left (`git grep`); decide whether to port #3250 (lazy watchdog in direct mode) later |
| host | 3.9 tools | `__tests__/explore-blast-radius.test.ts`, `__tests__/rust-cfg-test-file.test.ts`, `__tests__/mcp-stale-slice.test.ts` (drift parity through `fileDrift`), and ours' focus tests for explore's blast section (focused `indirectTestNote`) |
| host | 3.13 Swift try-await test | the combined file on both backends |
| resolution | 3.10 NM | `__tests__/resolution-order-independence.test.ts`, `__tests__/alias-chain-length.test.ts`, `__tests__/lua-local-alias-calls.test.ts`, `__tests__/ts-alias-typed-receivers.test.ts`, `__tests__/rust-glob-module-paths.test.ts`, `__tests__/rust-path-call-edge-cases.test.ts`, `__tests__/rust-path-super-glob.test.ts`, `__tests__/java-class-visibility.test.ts`, `__tests__/swift-static-calls.test.ts`, `__tests__/js-unimported-global-calls.test.ts`; then `__tests__/extensions/resolution` whole. A failing #3203 case after taking theirs in `rustPathTarget` is a fix-forward order |
| resolution | 3.11 pascal-scope | `__tests__/pascal-chained-calls.test.ts` and the other `__tests__/pascal-*.test.ts` |
| resolution | 3.12 Swift inheritance (C1) | `__tests__/swift-type-visibility.test.ts` (theirs' two new cases), `__tests__/swift-qualified-inheritance.test.ts`, `__tests__/extensions/resolution/swift-nested-supertypes.integration.test.ts` |
| queries | C6 blast test counting | landed (987c3715): blast through `inCfgTestFile`, orphans through `inCfgTestModule`; open limits as in 4.3; `__tests__/extensions/queries` after the merge |
| upstream-prs | 4.2, 4.4 | for Orc and the designer: #3256 redundant; #3202, #3203, #3205, #3206 need a rebase before any further push; #3249's code is on upstream main while its page says OPEN; GitHub's CONFLICTING on the clean ones (all fifteen show it) unexplained. All public steps wait on R-25 and the rule-12 publishing gate |

## 6. What was not read or not done

- No build, type-check or test ran; every "keep", "take" and "remove" above is from reading the trial merge, and the
  merge commit's type-check is the first proof.
- PR #3226's head (eedeb6ad32) is not in the local object store; its trial merge was not run.
- GitHub's reason for CONFLICTING on the PRs whose local merge is clean was not found.
- CodeGraph was not used (the server does not answer for this worktree's path); callers were found with `git grep`
  and `rg`.
- Auto-merged files outside the 13 (for example EI, RI, II, `src/db/queries.ts`) were not reviewed hunk by hunk;
  they are in the type-check and the lanes' test runs above.
