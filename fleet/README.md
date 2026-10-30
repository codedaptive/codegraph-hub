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
own code (`src/extensions/<zone>/`, `__tests__/extensions/<zone>/`, `fleet/`) is not listed. Checked against
`git diff --name-only $(git merge-base HEAD upstream) HEAD` at upstream 60b0d7a9 on exchange 2026-10-29: 35 files,
the 33 in the table plus `src/mcp/answer-freshness.ts` and `src/mcp/server-instructions.ts` from host's
`fresh-answers`, whose row comes when it integrates.

| Feature | Upstream files |
|---|---|
| `node-25-support` (host) | `src/bin/codegraph.ts`, `src/bin/node-version-check.ts`, `src/extraction/wasm-runtime-flags.ts` (comment only), `package.json`, `package-lock.json` (engines line only), `AGENTS.md`, `CHANGELOG.md`, `scripts/build-bundle.sh` (comment only), `vitest.config.mts`, `__tests__/node-version-check.test.ts`, `__tests__/watcher.test.ts`, `__tests__/mcp-daemon.test.ts`, `__tests__/bundle-launcher.test.ts` |
| `extension-hooks` (host) | `src/bin/codegraph.ts` (one `registerExtensionCommands` call), `src/mcp/tools.ts` (extension tools in `getTools` / `getStaticTools`, the small-repo exemption, `dispatchTool`'s default), `src/mcp/session.ts` (`tools/call` passes non-built-in names on to execute) |
| `copied-index-locks` (host) | `src/index.ts`, `src/utils.ts` (`FileLock`), `src/mcp/writer-lock.ts`, `src/mcp/daemon.ts`, `src/mcp/daemon-paths.ts`, `src/mcp/daemon-registry.ts`, `src/mcp/index.ts` |
| `query-pool-idle` (host) | `src/mcp/query-pool.ts`, `src/mcp/query-worker.ts` |
| `lock-takeover-race` (host) | `src/utils.ts` (`FileLock.acquire`), `src/mcp/writer-lock.ts`, `src/mcp/daemon.ts`, `src/mcp/daemon-registry.ts`, `src/mcp/lock-takeover.ts` (new file in upstream's tree) |
| `rust-impl-in-fn` (resolution) | `src/extraction/tree-sitter.ts`, `codegraph-kernel/src/rustlang.rs`, `docs/design/rust-lang-kernel-port-checklist.md`, `__tests__/rust-impl-in-fn-body.test.ts` (new test in upstream's flat `__tests__/`, settled S-26) |
| `swift-external-member-ref` (resolution) | `src/resolution/index.ts`, `src/resolution/swift-type-visibility.ts`, `__tests__/swift-external-member-ref.test.ts` (new test, settled S-26), `__tests__/swift-type-path-calls.test.ts` |

Fleet adds a row for each feature that edits an upstream file, from that feature's DONE list, in a fleet push of
its own: never inside the product feature's squash, which must stay cherry-pickable upstream (settled S-12).
