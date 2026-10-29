# fleet/: the fork's own files

Fork-only (`codedaptive/codegraph`); never offered upstream. Maintained by the fleet lane.

- `pack.sh`: packs `ours` as `@colbymchenry/codegraph@<version>-sm.N`.
- `rollout/`: go-live write-ups for shared state (global install, MCP entry, per-team config, rollback).
- `baselines/`: CodeGraph baselines per team repository.
- `golden/graft-0.16/`: graft's output, kept as the reference for `codegraph grep` / `blast`.

## Upstream files our patch stack edits

Every upstream file a feature on `ours` changes, by feature, from each feature's DONE report (settled S-12). Our
own code (`src/extensions/<zone>/`, `__tests__/extensions/<zone>/`, `fleet/`) is not listed. Checked against
`git diff --name-only $(git merge-base HEAD upstream) HEAD` at upstream 86c85cff: the same 15 files.

| Feature | Upstream files |
|---|---|
| `node-25-support` (host) | `src/bin/codegraph.ts`, `src/bin/node-version-check.ts`, `src/extraction/wasm-runtime-flags.ts` (comment only), `package.json`, `package-lock.json` (engines line only), `AGENTS.md`, `CHANGELOG.md`, `scripts/build-bundle.sh` (comment only), `vitest.config.mts`, `__tests__/node-version-check.test.ts`, `__tests__/watcher.test.ts`, `__tests__/mcp-daemon.test.ts`, `__tests__/bundle-launcher.test.ts` |
| `extension-hooks` (host) | `src/bin/codegraph.ts` (one `registerExtensionCommands` call), `src/mcp/tools.ts` (extension tools in `getTools` / `getStaticTools`, the small-repo exemption, `dispatchTool`'s default), `src/mcp/session.ts` (`tools/call` passes non-built-in names on to execute) |

Fleet adds a row for each feature that edits an upstream file, from that feature's DONE list, in a fleet push of
its own: never inside the product feature's squash, which must stay cherry-pickable upstream (settled S-12).
