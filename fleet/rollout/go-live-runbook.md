# Go-live runbook: index each team repository once, pin the standing worktrees

For Bob's go-ahead; the fleet lane applies none of it. Settled S-33 (one cold index per team repository at go-live;
its registration gate on first-call builds was removed by R-12) and S-34 (standing and tier worktrees pinned at
go-live). Runs after `global-install.md` and before any team is switched on (`mcp-json.md`, `per-team-mcp.md`).

Why the order still matters, now that indexing has no opt-in (R-12, `docs/SPEC.md` §2-3): nothing breaks if a team is
switched on first. The first call that names an unindexed worktree is answered "being built" (success-shaped; the
agent uses Read/Grep meanwhile and retries, `src/mcp/server-instructions.ts`, Limitations), and the index is copied
from an indexed sibling worktree or cold-built on the builder's queue. But a team switched on before step 1 spends
its cold builds when its first sessions happen to name each repository (mootx01-ee: 123 to 472 s depending on load,
and 5.5 GB, at baseline), and those sessions go without CodeGraph meanwhile. Step 1 spends them once, at a time Bob
picks, one repository at a time.

## State observed on 2026-11-01 (read-only; the steps below were written before go-live)

- The global `codegraph` is `1.6.2-sm.8` (`codegraph --version`, `/opt/homebrew/bin/codegraph`).
- Every worktree in the step 1 table, and the forge design checkout, has a `.codegraph/` today.
- `codegraph project list --json` shows 113 registered projects, 98 pinned, 25 seeded.
- `fleet/rollout/pin-standing.py` (list mode) prints 99 lines against codeteam `3157a61`: aimodel 5, bench 4,
  codegraph 7, codeteam 10, forge 8, fulcrum 12, moot 43, tessera 10. No `pin-standing.log` was found under `fleet/`,
  so the Undo for step 2 below has nothing to read unless the log is elsewhere.

## Precondition: an sm.N with the host features

`codegraph project pin` and the seeding that copies an indexed sibling's index into a new worktree arrive with
host's `worktree-lifecycle`; the one machine server, the index builder and the CLI's routing of `init`/`index`/`sync`
through the builder arrive with `machine-server`, `index-builder` and `cli-builder-route` (`fleet/README.md` lists
each). Pack and install an sm.N cut from an `ours` that carries them (`global-install.md`). `codegraph project --help`
on the installed sm.8 lists `list`, `pin`, `unpin` and `remove`.

Re-checked 2026-11-01 with the installed sm.8, `CODEGRAPH_STATE_DIR` and `HOME` pointed at a scratch folder (the real
registry, `~/.codegraph/projects/`, was untouched), on a scratch git repository: `project list --json` on an empty
registry printed `[]` (text: "No registered projects."); `project pin <repo>` printed `Pinned <path>` and exited 0;
the JSON record then had `flags` 1 (bit 0 = pinned) and a `commonDir`; pinning created no `.codegraph/` in the
repository; `unpin` left `flags` 0; `remove` printed `Unregistered <path>` and the list was empty again;
`project pin /nonexistent` printed `No such directory: /nonexistent` and exited 1.

## 1. Index one standing worktree per team repository, one at a time (S-6)

Each repository gets one cold `codegraph init`, in the checkout its lanes are cut from: exchange where the team
has one, the design checkout for the two lab teams (aimodel and bench, no exchange). With the machine server and its
builder running, `init` hands the build to the builder (other jobs may be ahead of it in the builder's queue) and prints its
own progress as before; with none running it builds in its own process under the writer lock (`docs/SPEC.md` §2, R-14).
The baselines below were taken with the build in the CLI's own process; when the build is routed, the same memory is
the builder's. Shortest first by baseline cold time, so a problem shows on a short run: codeteam first, mootx01-ee last. Never start the next before the last has finished.
Before each, post a STATUS with the load and the free memory:

```bash
uptime
vm_stat | awk 'NR==1{gsub(/[^0-9]/,"",$0); ps=$0} /Pages free|Pages inactive|Pages speculative/{gsub(/\./,"",$NF); s+=$NF} END{printf "%.1f GB free or reclaimable\n", s*ps/1e9}'
```

Start an index only when its peak fits in that free memory with room to spare: the baselines below give each
one's peak. mootx01-ee peaks at 5.5 GB, so wait for at least 8 GB free before starting it. That leaves about
2.5 GB for everything else that grows while it runs, since sessions keep working. On 2026-10-30 at 00:52 the line
printed 61.7 GB at load 37.

```bash
export DO_NOT_TRACK=1
codegraph init <worktree>        # one at a time, in the order below
```

| # | Team (repository) | Worktree to index | Baseline cold index | Tracked files (`git ls-files`, 2026-11-01) |
|---|---|---|---|---|
| 1 | codeteam | `/Users/bob/devlop/team-codeteam/exchange/codeteam-integration-exchange` | 3.9 s wall, 5.8 s CPU, 476 MiB; 108 files indexed, 7.1 MiB (1.6.2-sm.2, e08680a0, load 84) | 451 |
| 2 | forge | `/Users/bob/devlop/team-forge/exchange/forge-integration-exchange` | 8.7 s wall, 18.6 s CPU, 1.1 GiB | 1,155 |
| 3 | aimodel (ai-model-lab) | `/Users/bob/devlop/team-aimodel/design/ai-model-lab-main` | 24.3 s, 50.4 s CPU, 1.7 GiB | 2,877 |
| 4 | fulcrum | `/Users/bob/devlop/team-fulcrum/exchange/fulcrum-integration-exchange` | 36.9 s, 67.2 s CPU, 2.1 GiB | 23,255 (1,715 indexed at baseline) |
| 5 | bench (moot-ee-bench) | `/Users/bob/devlop/team-bench/design/moot-ee-bench-main` | 38.8 s, 49.7 s CPU, 1.7 GiB | 1,502 |
| 6 | codegraph (this fork) | `/Users/bob/devlop/team-codegraph/exchange/codegraph-integration-exchange` | 65.7 s, 91.5 s CPU, 2.8 GiB | 2,050 |
| 7 | moot (mootx01-ee) | `/Users/bob/devlop/team-moot/exchange/mootx01-ee-integration-exchange` | not re-measured (`fleet/baselines/README.md`): 472 s at load 48-80, 122.9 s at load ~28 (host), 234.5 / 327.9 s at load 89 to 45 (fleet); 5.5 GB peak (fleet); 622 MB database (brief) | 10,252 |

Baseline 1: measured for this runbook with `fleet/baselines/run-baseline.sh` on a throwaway clone of
codeteam's exchange head. Baselines 2-6: `fleet/baselines/README.md` (1.6.2-sm.1, Node 26, at load 38-68, on throwaway clones of each
repository's head that day). They are guides, not promises: the heads have moved, and wall time grows with load.
When this runbook was written (2026-10-30) none of these worktrees had an index; check before step 1 with
`test -e <worktree>/.codegraph`, per worktree, and write down which ones had none: the Undo of step 1 applies only to
those. The forge design checkout (`/Users/bob/devlop/forge`) had an older release's index and is not one of the seven.

A CLI `codegraph init` builds the index but registers nothing, whether it runs in its own process or is routed
through the builder (`src/extensions/host/builder/cli-jobs.ts`). Only the builder's seeding and cold builds
(`seed.ts`, `cold-build.ts`; the registry record is SEEDED) and `codegraph project pin` write the registry. The index is
what seeding needs: a new worktree copies the index of its nearest sibling that has a complete one (`seed.ts`), whether
or not that sibling is registered. Nothing needs registering for a new worktree to be seeded, or for a repository whose
worktrees have all gone to be cold-built in the background: there is no gate (R-12).

## 2. Pin every standing lane worktree and tier checkout (S-34)

```bash
python3 -I -B fleet/rollout/pin-standing.py            # the list only: path, then "to pin (<team> <tier|lane>)"
python3 -I -B fleet/rollout/pin-standing.py --apply    # codegraph project pin, one per worktree; exit 1 if any failed;
                                                       # writes pin-standing.log (keep it: the undo reads it)
```

The script reads the list from codeteam itself: its manifests in `codeteam/teams/`, and `Team.tier_wt` and
`lane_wt` in `bin/codeteam`. So the list matches what exists when it runs. Request worktrees are never on
it: they stay unpinned (S-34). `-B` stops Python writing a bytecode cache into codeteam's folder when the script
loads `bin/codeteam`. List mode does not read the registry: it prints "to pin" for a worktree whatever its state.
On 2026-11-01 (codeteam `3157a61`) it lists 99, all present:

| Team | Tier checkouts | Standing lane worktrees | Total |
|---|---|---|---|
| aimodel (lab) | design | 4 | 5 |
| bench (lab) | design | 3 | 4 |
| codegraph | design, exchange, integration | 4 | 7 |
| codeteam | design, exchange, integration | 7 | 10 |
| forge | design, exchange, integration | 5 | 8 |
| fulcrum | design, exchange, integration | 9 | 12 |
| moot | design, exchange, integration | 40 | 43 |
| tessera | design, exchange, integration | 7 | 10 |

Pinning only writes the registry (`<state dir>/projects/`, by default `~/.codegraph/projects/`): it creates no index and
touches no worktree. The machine server closes an open project after 10 idle minutes
(`CODEGRAPH_PROJECT_IDLE_TIMEOUT_MS`, `src/mcp/tools.ts`) and has no cap on how many are open; a pinned project is
exempt from that close, so the builder's hold on it (its watcher and writer slot) stays too. Nothing opens a pinned
project when the server starts: it opens on the first call that names it, so after a server restart a pinned worktree is
closed, and not being synced, until then. Teardown still treats a pinned worktree that has gone like any other.
A pinned worktree with no index yet gets one on its first call: copied from its indexed sibling, or cold-built when it
has none; pinning does not change which. Pin after step 1 so the pinned worktrees are the ones with indexes.

Tested 2026-10-30 on a throwaway build, not re-run since (the four `project` commands it calls were re-run on sm.8, see
the Precondition): the list mode against the live manifests (89 lines, exit 0; 99 on 2026-11-01). `--apply` and
`--undo` against a scratch manifest whose only checkout is a scratch repository, `HOME` in a scratch folder:
- the prior state comes from `codegraph project list --json` (a record's `flags` bit 0 is pinned), not the text
  listing (Kong's K-31);
- from an empty registry, `--apply` run twice logged `new` once, and the undo left "No registered projects";
- with the project registered but not pinned before, the log said `registered`, and the undo left it registered,
  unpinned;
- with the project already pinned before, the log said `pinned`, and the undo left it pinned;
- with a codegraph that cannot start, the run stopped with the error, exit 1.
`--apply` was not run against the team worktrees: that is the go-live step itself.

## 3. codeteam pins a standing worktree when it creates one: not part of this runbook

Dropped. codeteam supplies its own wiring and Bob does that side (Orc-Codegraph #1246, after the standing rule #1242), so
the fleet lane neither applies nor maintains `codeteam-pin.patch`. CodeGraph's side is only the command
`codegraph project pin <path>` (`docs/SPEC.md` §3, [B14]), checked above.

## No indexing opt-in: `CODEGRAPH_AUTO_INDEX` is gone

Nothing reads `CODEGRAPH_AUTO_INDEX` any more (`grep -rn AUTO_INDEX src` finds nothing); setting it does nothing, and it
is not in the MCP entry (`mcp-json.md`). R-12 removed the gate: the first call that names an unindexed worktree starts a
copy from an indexed sibling or a queued cold build, with no registration and no setting. `CODEGRAPH_NO_AUTO_SEED=1`
turns seeding and cold builds off for the process that sets it (`seed.ts`). The builder refuses roots that
`unsafeIndexRootReason` (`src/directory.ts`) refuses, and sensitive paths, and a plain directory it will not build gets
guidance to use built-in tools (`src/mcp/server-instructions.ts`, Limitations). Indexing each repository once at go-live
(step 1) is therefore a scheduling choice, not a gate.

## Undo

In reverse order, with the teams switched off first (`rollback.md`): an index removed while a session still names the
worktree comes back on that session's next call, within seconds (`docs/SPEC.md` §2).

- Step 2: `python3 -I -B fleet/rollout/pin-standing.py --undo` (reads `pin-standing.log`, written by `--apply`):
  unpins what the step pinned and unregisters only the projects it registered; projects already registered or pinned
  before stay so. With no `pin-standing.log` it changes nothing (none was found under `fleet/` on 2026-11-01); then unpin by hand,
  `codegraph project unpin <path>` per worktree, for the ones whose earlier state you know.
- Step 1: only for the worktrees `test -e <worktree>/.codegraph` found without an index before step 1 (see the table's
  note), not for any other checkout: `codegraph uninit -f <worktree>`. `uninit` has the machine server and the builder let go of
  the root before it deletes `.codegraph/` (`src/extensions/host/uninit.ts`); `rm -rf <worktree>/.codegraph` does not, and
  leaves the deleted database open in both processes. The CLI index registered nothing, so there is nothing to unregister,
  unless a session's call meanwhile seeded or built that worktree: then `codegraph project list` shows it `seeded`, and
  `codegraph project remove <path>` unregisters it (it deletes no file).
