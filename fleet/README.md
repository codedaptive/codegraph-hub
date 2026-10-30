# fleet/: the fork's own files

Fork-only (`codedaptive/codegraph`); never offered upstream. Maintained by the fleet lane.

- `/Makefile` (repository root): codeteam's test targets (`test-one`, `typecheck`, `test-times`, the zone suite)
  on the npx test calls; settled S-15, write-up `makefile/README.md`. Upstream has no Makefile.

- `pack.sh`: packs `ours` as `@colbymchenry/codegraph@<version>-sm.N`.
- `rollout/`: go-live write-ups for shared state (global install, MCP entry, per-team config, rollback).
- `baselines/`: CodeGraph baselines per team repository.
- `makefile/`: the write-up behind `/Makefile`.
- `golden/graft-0.16/`: graft's output, kept as the reference for `codegraph grep` / `blast`.

## Upstream files our patch stack edits

Every upstream file a feature on `ours` changes, by feature, from each feature's DONE report (settled S-12). Our
own code (`src/extensions/<zone>/`, `__tests__/extensions/<zone>/`, `fleet/`) is not counted; where a row names
it, it is marked fork-only. Checked against `git diff --name-only $(git merge-base HEAD upstream) HEAD` at upstream
60b0d7a9 on exchange 2026-10-30: 54 files, the 53 in the table plus `docs/RULINGS.md`, the fork's own rulings
register (no feature).

| Feature | Upstream files |
|---|---|
| `node-25-support` (host) | `src/bin/codegraph.ts`, `src/bin/node-version-check.ts`, `src/extraction/wasm-runtime-flags.ts` (comment only), `package.json`, `package-lock.json` (engines line only), `AGENTS.md`, `CHANGELOG.md`, `scripts/build-bundle.sh` (comment only), `vitest.config.mts`, `__tests__/node-version-check.test.ts`, `__tests__/watcher.test.ts`, `__tests__/mcp-daemon.test.ts`, `__tests__/bundle-launcher.test.ts` |
| `extension-hooks` (host) | `src/bin/codegraph.ts` (one `registerExtensionCommands` call), `src/mcp/tools.ts` (extension tools in `getTools` / `getStaticTools`, the small-repo exemption, `dispatchTool`'s default), `src/mcp/session.ts` (`tools/call` passes non-built-in names on to execute) |
| `copied-index-locks` (host) | `src/index.ts`, `src/utils.ts` (`FileLock`), `src/mcp/writer-lock.ts`, `src/mcp/daemon.ts`, `src/mcp/daemon-paths.ts`, `src/mcp/daemon-registry.ts`, `src/mcp/index.ts` |
| `query-pool-idle` (host) | `src/mcp/query-pool.ts`, `src/mcp/query-worker.ts` |
| `lock-takeover-race` (host) | `src/utils.ts` (`FileLock.acquire`), `src/mcp/writer-lock.ts`, `src/mcp/daemon.ts`, `src/mcp/daemon-registry.ts`, `src/mcp/lock-takeover.ts` (new file in upstream's tree) |
| `rust-impl-in-fn` (resolution) | `src/extraction/tree-sitter.ts`, `codegraph-kernel/src/rustlang.rs`, `docs/design/rust-lang-kernel-port-checklist.md`, `__tests__/rust-impl-in-fn-body.test.ts` (new test in upstream's flat `__tests__/`, settled S-26) |
| `swift-external-member-ref` (resolution) | `src/resolution/index.ts`, `src/resolution/swift-type-visibility.ts`, `__tests__/swift-external-member-ref.test.ts` (new test, settled S-26), `__tests__/swift-type-path-calls.test.ts` |
| `fresh-answers` (host) | `src/bin/codegraph.ts`, `src/mcp/tools.ts`, `src/mcp/server-instructions.ts` |
| `rust-crate-calls` (resolution) | `src/resolution/name-matcher.ts`, `__tests__/rust-crate-path-calls.test.ts` (new test, settled S-26) |
| `swift-builtins` (resolution) | `src/resolution/name-matcher.ts`, `src/resolution/swift-builtins.ts` (new file in upstream's tree), `__tests__/swift-std-method-calls.test.ts` (new test, settled S-26) |
| `swift-method-range` (resolution) | `__tests__/swift-try-await-condition.test.ts` (new test, settled S-26; pins a tree-sitter-swift 0.7.3 behavior, S-29) |
| `swift-enum-cases` (resolution) | `src/extraction/tree-sitter.ts`, `codegraph-kernel/src/swift.rs`, `docs/design/swift-kernel-port-checklist.md`, `src/resolution/swift-type-visibility.ts`, `__tests__/swift-enum-multi-case.test.ts` (new test, settled S-26), `__tests__/kernel-swift-parity.test.ts`, `__tests__/swift-external-member-ref.test.ts` |
| `worktree-lifecycle` (host) | `src/mcp/daemon-paths.ts`, `src/mcp/daemon-registry.ts`, `src/mcp/daemon.ts`, `src/mcp/engine.ts`, `src/mcp/process-identity.ts`, `src/mcp/query-pool.ts`, `src/mcp/query-worker.ts`, `src/mcp/server-instructions.ts`, `src/mcp/session.ts`, `src/mcp/tools.ts`, `src/mcp/writer-lock.ts`, `src/utils.ts` and `src/index.ts` (comments, its second push); also `src/mcp/lock-takeover.ts` (lock-takeover-race's new file). Fork-only: `src/extensions/host/extension.ts` and the new `src/extensions/host/worktree-lifecycle/` (`cli`, `cold-build`, `git`, `housekeeping`, `project-registry`, `seed-check`, `seed`, `teardown`); tests in `__tests__/extensions/host/`: `copied-index-locks.unit` (edited), new `dead-lock-reclaim.gate`, `dead-lock-reclaim.unit`, `project-cli`, `project-registry`, `worktree-lifecycle-extension`, `worktree-lifecycle-followups.gate`, `worktree-lifecycle-ownership.gate`, `worktree-lifecycle-races.gate`, `worktree-seed.gate`, `worktree-seed`, `worktree-teardown.gate`, and fixtures `dead-lock-helpers`, `dead-lock-victim` |
| `sync-mtime-refresh` (host) | `src/extraction/index.ts`, `__tests__/sync-mtime-refresh.test.ts` (new test, settled S-26) |
| `swift-static-calls` (resolution) | `src/resolution/index.ts`, `src/resolution/name-matcher.ts`, `src/resolution/swift-type-visibility.ts`, `src/resolution/types.ts`, `src/resolution/swift-builtins.ts`, `src/resolution/swift-module.ts` (new file in upstream's tree), `__tests__/swift-static-calls.test.ts` (new test, settled S-26), `__tests__/swift-external-member-ref.test.ts`. Fork-only: `src/extensions/resolution/suspects.ts`, `__tests__/extensions/resolution/suspects.test.ts` |
| `swift-qualified-inheritance` (resolution) | `src/extraction/tree-sitter.ts`, `codegraph-kernel/src/swift.rs`, `docs/design/swift-kernel-port-checklist.md`, `src/resolution/swift-type-visibility.ts`, `src/resolution/index.ts` (its second push), `__tests__/fixtures/kernel-parity/torture.swift` (the parity corpus), `__tests__/swift-qualified-inheritance.test.ts` (new test, settled S-26), `__tests__/swift-static-calls.test.ts` (swift-static-calls' new test) |
| `swift-enum-case-calls` (resolution) | `src/resolution/swift-type-visibility.ts`, `__tests__/swift-enum-case-calls.test.ts` (new test, settled S-26), `__tests__/swift-static-calls.test.ts` |
| `questionable-marks` (queries) | none. Fork-only: `src/extensions/queries/extension.ts`; in `src/extensions/queries/blast/`: `blast`, `extension`, `index`, `render`, `store`; in `src/extensions/queries/grep/`: `grep-command`, `grep-core`, `grep-definition`, `grep-format`, `grep-mcp`; `src/extensions/queries/orphans/orphans.ts`; new `src/extensions/queries/shared/questionable.ts`; tests in `__tests__/extensions/queries/`: `grep-by-symbol`, `grep-extension`, `orphans` (edited), new `questionable-blast`, `questionable-grep` |

Fleet adds a row for each feature that edits an upstream file, from that feature's DONE list, in a fleet push of
its own: never inside the product feature's squash, which must stay cherry-pickable upstream (settled S-12).
