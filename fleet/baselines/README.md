# Per-repository CodeGraph baselines (1.6.2-sm.1, Node 26)

Feature `repo-baselines`, 2026-10-29; brief `design/Orc-Codegraph/ledger/reports/fleet-per-team-and-baselines.md`
section 2 (MISSION "Scope: every repository and team"). Each repository measured once, before its team switches,
on a throwaway clone that was deleted afterwards. One cold index at a time (settled S-6), in roughly increasing
order of expected size (the gauntlets, codegraph, forge, then bench, aimodel, mootx01-ce, fulcrum); a STATUS with
the load went to Orc-Codegraph before each of the last four. codegraph's index (66 s) proved the longest and ran
without one. expr-gauntlet's first run stopped at the sync step (no source file to edit); the script was fixed to
skip that step and the run repeated.

**Build:** `@colbymchenry/codegraph@1.6.2-sm.1`, packed by `fleet/pack.sh` from `ours` 835aaa32 and installed
in a throwaway npm prefix; Node v26.12.0, no override; `DO_NOT_TRACK=1`. **Machine:** this Mac, 18 cores,
**overloaded throughout**: 1-minute load 38-68 during these runs (other lanes were indexing). Wall times are
therefore upper bounds; CPU time (user + sys) is the steadier figure. Peak RSS is the process's maximum resident
set size from `/usr/bin/time -l`. Sizes are MiB (2^20 bytes).

**Method** (`run-baseline.sh`; raw `key<TAB>value` rows in `raw/`):
- cold index: `codegraph init <clone>`, timed whole;
- index size: `codegraph.db` plus `-wal` right after the index;
- queries: `codegraph callers`, `codegraph query` (the CLI's search) and `codegraph impact` (depth 2), each a fresh
  CLI process (start-up included), on the function or method name with the most incoming `calls` edges. That name
  is often common (`init`, `exists`), so these are busy queries; "callers" in the tables counts the `calls` edges
  into every definition with that name;
- one-file sync: one blank line appended to the first file (by path) of the repository's main language, then
  `codegraph sync`, timed.

## Summary

| Repository | Team | Commit | Indexed files | Nodes | Edges | Index MiB | Cold index wall / CPU s | Peak RSS MiB | callers / query / impact s | One-file sync s |
|---|---|---|---|---|---|---|---|---|---|---|
| calc-gauntlet | gauntlets | cfa7dc7db3 | 10 | 49 | 65 | 0.2 | 4.93 / 1.9 | 421 | 1.53 / 1.69 / 1.25 | 1.74 |
| expr-gauntlet | gauntlets | 0043340f5c | 0 | 0 | 0 | 0.2 | 1.22 / 1.5 | 320 | — | — |
| forge | forge | f0f789b51c | 531 | 12,059 | 29,752 | 37.3 | 8.72 / 18.6 | 1,093 | 0.67 / 0.76 / 0.97 | 1.52 |
| ai-model-lab | aimodel | fa06077854 | 643 | 20,002 | 61,889 | 79.8 | 24.29 / 50.4 | 1,787 | 0.59 / 0.57 / 0.57 | 1.69 |
| moot-ee-bench | bench | ba18b2805a | 1,122 | 24,274 | 58,446 | 91.1 | 38.77 / 49.7 | 1,788 | 1.15 / 1.62 / 0.69 | 3.18 |
| codegraph | codegraph | 835aaa32c5 | 1,432 | 35,222 | 112,906 | 126.7 | 65.67 / 91.5 | 2,824 | 0.76 / 0.63 / 0.70 | 6.00 |
| fulcrum | fulcrum | bbac6eed4d | 1,715 | 42,224 | 119,015 | 147.7 | 36.90 / 67.2 | 2,119 | 1.69 / 0.82 / 0.97 | 4.42 |
| mootx01-ce | moot | e59669c153 | 2,259 | 53,787 | 172,703 | 192.7 | 34.29 / 108.2 | 2,850 | 0.62 / 0.57 / 0.75 | 4.04 |
| mootx01-ee (not re-measured) | moot | 96acd65de8 | 5,499 | 152,433 | 522,220 | 622 MB (brief) | 472 at load 48-80; 122.9 at load ~28 (host); 234.5 / 327.9 at load 89→45 (fleet, sm.1 from 01e0ac3a) | 5.5 GB (fleet) | — | — |

mootx01-ee is the brief's measured reference (host's two timings and size, as the brief quotes them; nodes, edges,
peak RSS and the third timing from fleet's fleet-rollout index, recorded in that feature's dropped zone-mk.md and
first-index.md at commit 5cc8b6e1 on the fleet lane's backup); it was not indexed again.

## Per repository

### calc-gauntlet

Team gauntlets (bare repo calc-gauntlet.git); source `/Users/bob/devlop/.repos/calc-gauntlet.git` at `develop` = `cfa7dc7db3ef82dd9799b6867e5654122b3f0f44`. Measured at `develop`, the bare repository's head; its `gauntlet-base-*` branches carry the arms' code.

| Measure | Value |
|---|---|
| Tracked files / indexed files | 14 / 10 |
| Languages (files) | swift 10 |
| Nodes / edges | 49 / 65 |
| Index size | 0.2 MiB |
| Cold index | 4.93 s wall, 1.44 s user, 0.44 s sys, 421 MiB peak RSS |
| Load before / after the index (1, 5, 15 min) | 48.22 28.23 23.52 / 51.96 29.33 23.94 |
| Query symbol | `multiply` (7 `calls` edges into it) |
| `codegraph callers` | 1.53 s wall, 0.6 s CPU, 96 MiB |
| `codegraph query` (search) | 1.69 s wall, 0.6 s CPU, 98 MiB |
| `codegraph impact` (depth 2) | 1.25 s wall, 0.5 s CPU, 98 MiB |
| One-file sync (`Package.swift`) | 1.74 s wall, 0.8 s CPU, 131 MiB |

### expr-gauntlet

Team gauntlets (bare repo expr-gauntlet.git); source `/Users/bob/devlop/.repos/expr-gauntlet.git` at `develop` = `0043340f5cbba6257db080139e586d44ecbf603e`. `develop` holds only `README.md`, `CLAUDE.md`, `.claude/PROJECT.md` and `.gitignore`: nothing to index. The gauntlet's code lives on its `gauntlet-base-*` branches, which a gauntlet worktree checks out; those were not measured (the brief names the repository, and `develop` is its head).

| Measure | Value |
|---|---|
| Tracked files / indexed files | 4 / 0 |
| Languages (files) | none |
| Nodes / edges | 0 / 0 |
| Index size | 0.2 MiB |
| Cold index | 1.22 s wall, 1.14 s user, 0.33 s sys, 320 MiB peak RSS |
| Load before / after the index (1, 5, 15 min) | 39.94 34.07 26.62 / 39.94 34.07 26.62 |
| Queries | not run: no function or method indexed |
| One-file sync | not run: no source file indexed |

### forge

Team forge; source `/Users/bob/devlop/forge` at `HEAD` = `f0f789b51c0d4f337ccb96c87379cbc4780ec4d2`. Measured at the checkout's `develop`.

| Measure | Value |
|---|---|
| Tracked files / indexed files | 1,150 / 531 |
| Languages (files) | swift 515, yaml 11, python 3, c 2 |
| Nodes / edges | 12,059 / 29,752 |
| Index size | 37.3 MiB |
| Cold index | 8.72 s wall, 16.64 s user, 2.00 s sys, 1,093 MiB peak RSS |
| Load before / after the index (1, 5, 15 min) | 40.22 33.92 26.48 / 39.94 34.07 26.62 |
| Query symbol | `writeControl` (258 `calls` edges into it) |
| `codegraph callers` | 0.67 s wall, 0.6 s CPU, 112 MiB |
| `codegraph query` (search) | 0.76 s wall, 0.6 s CPU, 114 MiB |
| `codegraph impact` (depth 2) | 0.97 s wall, 0.6 s CPU, 118 MiB |
| One-file sync (`Package.swift`) | 1.52 s wall, 1.4 s CPU, 233 MiB |

### ai-model-lab

Team aimodel; source `/Users/bob/devlop/team-aimodel/design/ai-model-lab-main` at `HEAD` = `fa060778544be41ed305c2be893d77fff2567baa`. Measured at the team checkout's `main`.

| Measure | Value |
|---|---|
| Tracked files / indexed files | 2,870 / 643 |
| Languages (files) | python 640, swift 2, rust 1 |
| Nodes / edges | 20,002 / 61,889 |
| Index size | 79.8 MiB |
| Cold index | 24.29 s wall, 46.55 s user, 3.86 s sys, 1,787 MiB peak RSS |
| Load before / after the index (1, 5, 15 min) | 65.85 42.33 30.16 / 68.04 44.64 31.34 |
| Query symbol | `exists` (334 `calls` edges into it) |
| `codegraph callers` | 0.59 s wall, 0.6 s CPU, 109 MiB |
| `codegraph query` (search) | 0.57 s wall, 0.6 s CPU, 104 MiB |
| `codegraph impact` (depth 2) | 0.57 s wall, 0.6 s CPU, 125 MiB |
| One-file sync (`extractor/__init__.py`) | 1.69 s wall, 1.8 s CPU, 278 MiB |

### moot-ee-bench

Team bench; source `/Users/bob/devlop/team-bench/design/moot-ee-bench-main` at `HEAD` = `ba18b2805a5e7d56f7eed6d54abf6235c42fc84a`. Measured at the team checkout's `main`. The load rose from 38 to 63 during this index (another lane's index started).

| Measure | Value |
|---|---|
| Tracked files / indexed files | 1,502 / 1,122 |
| Languages (files) | python 741, swift 280, rust 101 |
| Nodes / edges | 24,274 / 58,446 |
| Index size | 91.1 MiB |
| Cold index | 38.77 s wall, 45.49 s user, 4.22 s sys, 1,788 MiB peak RSS |
| Load before / after the index (1, 5, 15 min) | 38.34 33.84 26.58 / 63.44 41.06 29.57 |
| Query symbol | `contains` (538 `calls` edges into it) |
| `codegraph callers` | 1.15 s wall, 0.6 s CPU, 125 MiB |
| `codegraph query` (search) | 1.62 s wall, 0.6 s CPU, 119 MiB |
| `codegraph impact` (depth 2) | 0.69 s wall, 0.6 s CPU, 133 MiB |
| One-file sync (`aria-v2-qualification/prepare_lme_aggregate.py`) | 3.18 s wall, 3.2 s CPU, 339 MiB |

### codegraph

Team codegraph (this fork, `ours`); source `/Users/bob/devlop/.repos/codegraph.git` at `835aaa32c5b409b8e460033506aef76dfff13f55` = `835aaa32c5b409b8e460033506aef76dfff13f55`. Measured at `ours` 835aaa32, the build being measured. `callers` / `impact` ran on `init`, which has many definitions across the fixture languages.

| Measure | Value |
|---|---|
| Tracked files / indexed files | 1,747 / 1,432 |
| Languages (files) | typescript 1190, svelte 55, javascript 50, rust 28, c 27, go 20, dart 18, scala 10, php 6, astro 4, python 4, cpp 3, csharp 3, swift 3, java 2, kotlin 2, yaml 2, lua 1, luau 1, r 1, ruby 1, tsx 1 |
| Nodes / edges | 35,222 / 112,906 |
| Index size | 126.7 MiB |
| Cold index | 65.67 s wall, 85.57 s user, 5.94 s sys, 2,824 MiB peak RSS |
| Load before / after the index (1, 5, 15 min) | 59.08 32.91 25.39 / 44.63 34.54 26.61 |
| Query symbol | `init` (928 `calls` edges into it) |
| `codegraph callers` | 0.76 s wall, 0.6 s CPU, 125 MiB |
| `codegraph query` (search) | 0.63 s wall, 0.6 s CPU, 116 MiB |
| `codegraph impact` (depth 2) | 0.70 s wall, 0.6 s CPU, 138 MiB |
| One-file sync (`__tests__/absent-member-calls.test.ts`) | 6.00 s wall, 4.8 s CPU, 565 MiB |

### fulcrum

Team fulcrum; source `/Users/bob/devlop/fulcrum` at `HEAD` = `bbac6eed4d6785cc850830175284e1653dda564c`. 23,255 tracked files, of which 1,715 are source CodeGraph indexes; the rest are assets, data and docs.

| Measure | Value |
|---|---|
| Tracked files / indexed files | 23,255 / 1,715 |
| Languages (files) | swift 1709, python 2, go 1, javascript 1, jsx 1, yaml 1 |
| Nodes / edges | 42,224 / 119,015 |
| Index size | 147.7 MiB |
| Cold index | 36.90 s wall, 59.24 s user, 7.95 s sys, 2,119 MiB peak RSS |
| Load before / after the index (1, 5, 15 min) | 49.69 43.58 31.72 / 49.69 44.14 32.46 |
| Query symbol | `nodes` (2,196 `calls` edges into it) |
| `codegraph callers` | 1.69 s wall, 0.8 s CPU, 213 MiB |
| `codegraph query` (search) | 0.82 s wall, 0.7 s CPU, 194 MiB |
| `codegraph impact` (depth 2) | 0.97 s wall, 0.9 s CPU, 224 MiB |
| One-file sync (`FulcrumAI/Package.swift`) | 4.42 s wall, 4.5 s CPU, 512 MiB |

### mootx01-ce

Team moot (community edition, bare repo mootx01-ce.git); source `/Users/bob/devlop/.repos/mootx01-ce.git` at `develop/1.0.x` = `e59669c15390201e36165c03092a0ec60b42c856`. Measured at `develop/1.0.x`, the bare repository's head.

| Measure | Value |
|---|---|
| Tracked files / indexed files | 2,857 / 2,259 |
| Languages (files) | swift 1445, rust 765, python 25, yaml 13, javascript 6, c 2, cpp 1, ruby 1, xml 1 |
| Nodes / edges | 53,787 / 172,703 |
| Index size | 192.7 MiB |
| Cold index | 34.29 s wall, 96.13 s user, 12.06 s sys, 2,850 MiB peak RSS |
| Load before / after the index (1, 5, 15 min) | 66.20 44.65 31.42 / 55.37 44.44 31.88 |
| Query symbol | `bytes` (442 `calls` edges into it) |
| `codegraph callers` | 0.62 s wall, 0.7 s CPU, 216 MiB |
| `codegraph query` (search) | 0.57 s wall, 0.6 s CPU, 217 MiB |
| `codegraph impact` (depth 2) | 0.75 s wall, 0.8 s CPU, 225 MiB |
| One-file sync (`apps/Mootx01-App/App/Mootx01App.swift`) | 4.04 s wall, 4.3 s CPU, 555 MiB |

## Reproduce

```bash
fleet/pack.sh 1 835aaa32c5b409b8e460033506aef76dfff13f55 <out>      # then: npm install -g --prefix <tmp> <out>/*.tgz
fleet/baselines/run-baseline.sh <tmp>/bin/codegraph <source repo> <ref> <name> <scratch dir> > raw/<name>.tsv
```
