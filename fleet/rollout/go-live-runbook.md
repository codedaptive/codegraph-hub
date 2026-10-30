# Go-live runbook: index each team repository once, pin the standing worktrees

For Bob's go-ahead; the fleet lane applies none of it. Settled S-33 (one cold index per team repository at
go-live) and S-34 (standing and tier worktrees pinned at go-live, and by codeteam when it
creates one). Runs after `global-install.md` and before any team is switched on (`mcp-json.md`,
`per-team-mcp.md`). The order matters: a session told that a project is not indexed stops calling codegraph for
that project for the rest of the session (`src/mcp/server-instructions.ts`, Limitations). A team switched on
before its repository is indexed and its worktrees pinned would have sessions give up on CodeGraph on their
first call.

## Precondition: an sm.N with worktree-lifecycle

`codegraph project pin` and the seeding that copies a registered sibling's index into a new worktree arrive with
host's `worktree-lifecycle` (exchange c754e9409d). It is not on `ours` yet, and the installed 1.6.2-sm.2 has no
`project` command. Pack and install the first sm.N cut from an `ours` that carries it (`global-install.md`).
Tested here on a throwaway build of exchange (`fleet/pack.sh 99 HEAD`, installed in a scratch prefix, `HOME`
pointed at a scratch folder so the real registry, `~/.codegraph/projects/`, was untouched):
`codegraph project pin <worktree>` printed `Pinned <path>`, and `codegraph project list` showed it `pinned`
with its repository.

## 1. Index one standing worktree per team repository, one at a time (S-6)

Each repository gets one cold `codegraph init`, in the checkout its lanes are cut from: exchange where the team
has one, the design checkout for the two lab teams (aimodel and bench, no exchange). Shortest first by baseline cold time, so a
problem shows on a short run: codeteam first, mootx01-ee last. Never start the next before the last has finished.
Before each, post a STATUS with the load and the free memory:

```bash
uptime
vm_stat | awk 'NR==1{gsub(/[^0-9]/,"",$0); ps=$0} /Pages free|Pages inactive|Pages speculative/{gsub(/\./,"",$NF); s+=$NF} END{printf "%.1f GB free or reclaimable\n", s*ps/1e9}'
```

Start an index only when its peak fits in that free memory with room to spare: the baselines below give each
one's peak. mootx01-ee peaks at 5.4 GB, so wait for at least 8 GB free before starting it. That leaves about
2.6 GB for everything else that grows while it runs, since sessions keep working. On 2026-10-30 at 00:52 the line
printed 61.7 GB at load 37.

```bash
export DO_NOT_TRACK=1
codegraph init <worktree>        # one at a time, in the order below
```

| # | Team (repository) | Worktree to index | Baseline cold index | Tracked files now |
|---|---|---|---|---|
| 1 | codeteam | `/Users/bob/devlop/team-codeteam/exchange/codeteam-integration-exchange` | 3.9 s wall, 5.8 s CPU, 476 MiB; 108 files indexed, 7.1 MiB (1.6.2-sm.2, e08680a0, load 84) | 377 |
| 2 | forge | `/Users/bob/devlop/team-forge/exchange/forge-integration-exchange` | 8.7 s wall, 18.6 s CPU, 1.1 GiB | 1,155 |
| 3 | aimodel (ai-model-lab) | `/Users/bob/devlop/team-aimodel/design/ai-model-lab-main` | 24.3 s, 50.4 s CPU, 1.7 GiB | 2,870 |
| 4 | fulcrum | `/Users/bob/devlop/team-fulcrum/exchange/fulcrum-integration-exchange` | 36.9 s, 67.2 s CPU, 2.1 GiB | 23,255 (1,715 indexed) |
| 5 | bench (moot-ee-bench) | `/Users/bob/devlop/team-bench/design/moot-ee-bench-main` | 38.8 s, 49.7 s CPU, 1.7 GiB | 1,502 |
| 6 | codegraph (this fork) | `/Users/bob/devlop/team-codegraph/exchange/codegraph-integration-exchange` | 65.7 s, 91.5 s CPU, 2.8 GiB | 1,876 |
| 7 | moot (mootx01-ee) | `/Users/bob/devlop/team-moot/exchange/mootx01-ee-integration-exchange` | 688 s; 737 s / 274 s CPU, 5.4 GB peak, 633 MB database (MISSION.md baselines) | 10,252 |

Baseline 1: measured for this runbook with `fleet/baselines/run-baseline.sh` on a throwaway clone of
codeteam's exchange head. Baselines 2-6: `fleet/baselines/README.md` (1.6.2-sm.1, Node 26, at load 38-68, on throwaway clones of each
repository's head that day). They are guides, not promises: the heads have moved, and wall time grows with load.
Every one of these worktrees has no index today. Only the forge design checkout (`/Users/bob/devlop/forge`)
has one, built 2026-09-08 by an older release; it is not the one indexed here, and it catches up by sync when
it is next opened.

A CLI `codegraph init` builds the index but registers nothing. In this build only the MCP server's cold build,
seeding and `codegraph project pin` write the registry. The index is what seeding needs: a new worktree copies
the index of its nearest sibling that has a complete one (`seed.ts`). The registration S-33's cold-build gate
checks comes from step 2, which registers every pinned worktree. From then on WP2 holds for each repository: new
worktrees seed, and a repository whose worktrees have all gone cold-builds in the background.

## 2. Pin every standing lane worktree and tier checkout (S-34)

```bash
python3 -I -B fleet/rollout/pin-standing.py            # the list only: path, then "to pin (<team> <tier|lane>)"
python3 -I -B fleet/rollout/pin-standing.py --apply    # codegraph project pin, one per worktree; exit 1 if any failed;
                                                       # writes pin-standing.log (keep it: the undo reads it)
```

The script reads the list from codeteam itself: its manifests in `codeteam/teams/`, and `Team.tier_wt` and
`lane_wt` in `bin/codeteam`. So the list matches what exists when it runs. Request worktrees are never on
it: they stay unpinned (S-34). `-B` stops Python writing a bytecode cache into codeteam's folder when the script
loads `bin/codeteam`. Today (codeteam 1213e17) it lists 89, all present:

| Team | Tier checkouts | Standing lane worktrees | Total |
|---|---|---|---|
| aimodel (lab) | design | 4 | 5 |
| bench (lab) | design | 3 | 4 |
| codegraph | design, exchange, integration | 4 | 7 |
| codeteam | design, exchange, integration | 7 | 10 |
| forge | design, exchange, integration | 5 | 8 |
| fulcrum | design, exchange, integration | 9 | 12 |
| moot | design, exchange, integration | 40 | 43 |

Pinning only writes the registry (`~/.codegraph/projects/`): it creates no index and touches no worktree. A
pinned project stays open in the MCP servers that open it: it is never idle-released or evicted from their
cache. Teardown still treats a pinned worktree that has gone like any other. A
pinned worktree with no index yet is seeded from its indexed sibling on its first CodeGraph call. Pin after
step 1. A worktree pinned before its repository has an indexed sibling has nothing to seed from, and with the
repository now registered its first call would start a cold build instead.

Tested: the list mode against the live manifests (89 lines, exit 0). `--apply` and `--undo` against a scratch
manifest whose only checkout is a scratch repository, `HOME` in a scratch folder, the throwaway build:
- the prior state comes from `codegraph project list --json` (a record's `flags` bit 0 is pinned), not the text
  listing (Kong's K-31);
- from an empty registry, `--apply` run twice logged `new` once, and the undo left "No registered projects";
- with the project registered but not pinned before, the log said `registered`, and the undo left it registered,
  unpinned;
- with the project already pinned before, the log said `pinned`, and the undo left it pinned;
- with a codegraph that cannot start, the run stopped with the error, exit 1.
`--apply` was not run against the team worktrees: that is the go-live step itself.

## 3. codeteam pins a standing worktree when it creates one

`codeteam-pin.patch`, from `/Users/bob/devlop/codeteam`: `patch -p1 < <fork>/fleet/rollout/codeteam-pin.patch`.

S-34 names a `team.py` change. In the code, though, standing worktrees are created only by v1 `codeteam init`
(`cmd_init` in `bin/codeteam`): `ensure_worktree` for the integration and exchange tiers and for each lane's
standing worktree. v2's `team.py` launches sessions and creates no worktree. So the change is in `bin/codeteam`:
- `ensure_worktree` returns True when it created the worktree, False when it reused one. Every other caller
  ignores the value.
- A new `pin_codegraph(path)` runs `codegraph project pin <path>` (with `DO_NOT_TRACK=1`). It is best effort: with
  no `codegraph` on PATH, a codegraph that cannot be started, or a failed pin, `init` warns and carries on.
- `init` calls it for the integration and exchange checkouts and each lane's standing worktree, only when it has
  just created them. Unit, snapshot and pin-branch worktrees, which use the same `ensure_worktree`, are left
  unpinned.

Checked on a copy of today's `bin/codeteam` (1213e17): the patch applies and parses, and the reverse restores the
file byte for byte. `pin_codegraph` was run alone in a sandboxed HOME: a real folder printed "pinned in
CodeGraph"; a missing folder warned with codegraph's "No such directory"; with no codegraph on PATH, and with a codegraph
whose interpreter does not exist, it warned and returned. `codeteam init` itself was not run.

## CODEGRAPH_AUTO_INDEX: left unset

Not set in the MCP entry (`mcp-json.md`). Setting `CODEGRAPH_AUTO_INDEX=1` would make the first CodeGraph call in
a worktree of a repository nobody has indexed start a background cold build there. That is WP2's letter, but it is
also several cold builds at once across sessions on any repository an agent names (mootx01-ee: 688 s, 5.4 GB
each), and indexing a new repository is the user's decision (S-33).

## Undo

- Step 3: `patch -p1 -R < <fork>/fleet/rollout/codeteam-pin.patch` from `/Users/bob/devlop/codeteam`.
- Step 2: `python3 -I -B fleet/rollout/pin-standing.py --undo` (reads `pin-standing.log`): unpins what the step
  pinned and unregisters only the projects it registered; projects already registered or pinned before stay so.
- Step 1: `rm -rf <worktree>/.codegraph` removes the index once its daemon has stopped (`codegraph daemon`). The
  CLI index registered nothing, so there is nothing to unregister.
