# Global install: 1.5.0 out, 1.6.2-sm.N in

Shared state: the Homebrew npm prefix `/opt/homebrew` (`/opt/homebrew/bin/codegraph`). For Bob's go-ahead; the lane
never applies it.

## Today (checked 2026-10-29)

- `npm ls -g --depth=0`: `@colbymchenry/codegraph@1.5.0`, `@nanonets/graft@0.16.0`.
- 1.5.0 is upstream's thin-installer shim: `/opt/homebrew/bin/codegraph -> ../lib/node_modules/@colbymchenry/codegraph/npm-shim.js`,
  which execs the nested `@colbymchenry/codegraph-darwin-arm64` bundle and its vendored Node 24.16 (older than
  Node's 24.22.1 security release). It has **no npm scripts**, so uninstalling it runs nothing.
- 1.6.2-sm.N is the root package built from `ours` (`fleet/pack.sh`), run by the system Node (v26.12.0). It has a
  `preuninstall` (`dist/bin/uninstall.js`) that removes the **global** CodeGraph entries of every agent target
  (Claude, Codex, Gemini, opencode, ...) when it is uninstalled. Every uninstall of sm.N below therefore uses
  `--ignore-scripts`.

## Precondition

The packed ref carries host's `node-25-support` (`ours` from 835aaa32 on). An older ref's `codegraph` on Node 26
prints the unsupported-Node banner and exits 1 unless `CODEGRAPH_ALLOW_UNSAFE_NODE=1` is set. Tested with
1.6.2-sm.1 from 835aaa32 on Node 26.12.0, no override set: `fleet/rollout/README.md`.

## Apply

```bash
# 1. Pack (any folder; the tarball and a .txt naming its commit land in the out dir).
cd ~/devlop/team-codegraph/design/codegraph-ours        # or any worktree of the fork
fleet/pack.sh <N> ours ~/devlop/team-codegraph/releases
# 2. Swap the global install. Sessions using 1.5.0 keep their running daemons until they restart.
npm uninstall -g --ignore-scripts @colbymchenry/codegraph
npm install -g --ignore-scripts ~/devlop/team-codegraph/releases/colbymchenry-codegraph-1.6.2-sm.<N>.tgz
# 3. Check.
codegraph --version            # 1.6.2-sm.<N>, no banner
npm ls -g --depth=0            # @colbymchenry/codegraph@1.6.2-sm.<N>
```

`npm install -g` of the tarball fetches its 10 runtime dependencies from the registry (13 packages, 2.4 s in the
throwaway-prefix test of sm.1 from 835aaa32). No `EBADENGINE`: that ref's `engines` is `node >=20.0.0`.

Each later sm.N+1 is step 1 and `npm install -g --ignore-scripts <new tarball>` (no uninstall needed).

## Who else this reaches

- `~/.codex/config.toml` `[mcp_servers.codegraph]` runs `codegraph` too, so Codex sessions get sm.N. Not changed here.
- `~/.claude/CLAUDE.md`'s marker-fenced CodeGraph block and `~/.claude/settings.json`'s `mcp__codegraph__*`
  permissions stay; they name tools sm.N still has.

## Undo

```bash
npm uninstall -g --ignore-scripts @colbymchenry/codegraph   # --ignore-scripts: keep the agents' global entries
npm install -g @colbymchenry/codegraph@1.5.0                # from the registry (checked: 1.5.0 is published)
codegraph --version                                         # 1.5.0
```
