# A fork Makefile for codeteam's test targets (write-up, for Orc-Codegraph)

Feature `fork-makefile`, 2026-10-29; Orc-Codegraph's #149. Fork-only, never offered upstream. Proposed, not
applied: the file goes at the repository root, outside every lane's walls, so the orchestrator decides it (the
manifest leaves changes outside the lanes' paths to the orchestrator: `codeteam/teams/codegraph.toml`).

## The gap

Reviewers and test runners cannot make a test record in this repository: `make zone-test-one DIR=...` fails with
`No rule to make target 'test-one'` (queries' `blast-base.md`, host's `extension-hooks.md` EH-INFRA-01).
So every record so far is a lead's own run.

How make is wired here (codeteam 34c2667):
- codeteam exports `MAKEFILES=<codeteam>/zone/zone.mk` for every lane (`bin/codeteam:1448`, `v2/codeteam2/team.py:387`).
  GNU make reads that file first, then the worktree's own Makefile.
- zone.mk supplies `zone-test` and `zone-test-one`, which record a run through `zone-tool`, and
  `zone-test-status`, which only reads the records. `zone-test-one`'s run is the repository's own
  `test-one DIR=<path>` target, in the worktree root. The fork has no Makefile
  (upstream has none), so there is no `test-one`.
- `zone-test` runs `ZONE_TEST`. A lane's `test` key in the manifest sets it (exported as `ZONE_TEST`,
  `bin/codeteam:1441`); otherwise zone.mk's default is `test-one DIR=$(ZONE)` then `test-one DIR=$(ZONE)/rust`.
  Every codegraph lane has `path = "."`, so that default would run the whole suite and then a folder that does
  not exist.

## Proposal: one fork-only root `Makefile`, no codeteam change

The file is the root `Makefile` (settled S-15). It maps codeteam's
targets onto `team/claude/rules/product.md` "Test calls":

| Target | Runs |
|---|---|
| `test-one DIR=<test file or folder> [TEST="<regex>"]` | `npx --no-install vitest run <DIR> [-t <regex>]`; `TEST` is refused under `zone-test-one` (below) |
| `typecheck` | `npx --no-install tsc --noEmit -p .` (the push gate) |
| `test-times DIR=<...>` | vitest's JSON report, listing tests over 5 s (the zone rules name `make test-times`) |
| zone suite (`ZONE_TEST`) | when the manifest gives the lane no `test`: `typecheck`, then `test-one` on each folder under `__tests__/` in the lane's `owns` (`CODETEAM_OWNS`). host gets `__tests__/extensions/host`, queries and resolution theirs, and fleet gets `typecheck` alone. A manifest `test` still wins (the Makefile checks `$(origin ZONE_TEST)`). |

Each target says "run npm ci once" when the worktree has no `node_modules`, instead of failing inside npx.
`DIR` and `TEST` reach the shell as environment variables, so quotes and backticks in them arrive as typed on
`make test-one` and `make test-times`. A `$` in a command-line value is still expanded by make (write `$$`); through
`zone-test-one`, `DIR` first passes zone.mk's unquoted `DIR=$(DIR)` (below).

`TEST` and the record: zone.mk keys a `zone-test-one` record on `DIR`, `SWIFT_TEST_ARGS` and `CARGO_TEST_ARGS`
(`zone.mk:44`), not `TEST`. A filtered run would be stored under the unfiltered key and replayed for a later
unfiltered request. So the Makefile stops with an error when `TEST` is set and the goal is `zone-test-one` or
`zone-test`; a filtered run is `make test-one`, unrecorded. vitest 2.1.9 has no `file:line` filter that could
carry the filter inside `DIR`.

Why the root: zone.mk runs `$(MAKE) test-one` from the worktree root, so make has to find the target there. Upstream
has no `Makefile`, so a fork-only root `Makefile` merges cleanly every day. If upstream ever adds one, the daily
merge conflicts and someone notices; that is better than a `GNUmakefile`, which would silently hide upstream's.
`fleet/README.md` (on `lane/fleet` from feature `fork-readme`) would list it among the fork's own files.

## Tested (a throwaway `git clone --shared` of this feature's base, with this Makefile copied to its root, under the fleet scratchpad; Node 26.12, GNU make 3.81; codeteam's zone.mk as of the test, its cited lines unchanged since 34c2667)

With `MAKEFILES` set to codeteam's real `zone/zone.mk`, `CODETEAM_ZONE=.`, and `CODETEAM_OWNS` as host's:
- `make zone-test-one DIR=__tests__/extensions/host/extension-hooks.test.ts`: 14 passed, recorded. A repeat
  replayed the record without running again. `make zone-test-status` printed `PASS ... matches current code`.
- `make zone-test`: the derived suite ran `typecheck` then `test-one DIR=__tests__/extensions/host`. 3 files,
  20 passed, 13.0 s wall, 21.5 s user, 2.7 s sys (`/usr/bin/time -p`), load 22. Recorded as the zone suite.
- With `ZONE_TEST` set in the environment (as a manifest `test` sets it), the Makefile kept that value. With
  `CODETEAM_OWNS=fleet`, the suite is `typecheck` alone.
- `make test-one DIR=__tests__/extensions/host/extension-hooks.test.ts TEST="lists the extension tool"`: 2 passed,
  12 skipped. `TEST` is vitest's `-t`, a regex: a name with parentheses has to be escaped (`\(`) or shortened; an
  escaped one ran 1 test.
- `make zone-test-one ... TEST=x`: stops with the record-key error, nothing run or recorded.
- `make test-times` on a failing test: the failure is reported and make exits non-zero; on a file that does not
  exist, vitest's own message is shown, non-zero.
- `make test-times DIR=__tests__/extensions/host`: "no test over 5 s" (the slowest is 0.9 s).
- `make test-one` with no `DIR`, and `make typecheck` with no `node_modules`: the messages above, exit 2.

## Seen along the way (for codeteam's maintainer, not part of this change)

- `zone-tool` writes its records in the worktree root: `.test-record.json` (the suite) and `.test-record-*.json`
  (each `zone-test-one`) show as untracked in `git status` (the `.log` files are already ignored by `*.log`).
  codeteam already adds `.codegraph/` to each team repository's `info/exclude` (decision 82); `.test-record*.json`
  could go there too.
- `zone-test-one` could add `$(TEST)` to its record key (`zone.mk:44`); the Makefile's refusal can then go.
- `zone-test-one` passes `DIR=$(DIR)` unquoted to its inner make (`zone.mk:44`), so a path with a space, a quote or
  a backtick is changed there, before this Makefile sees it.

## Applied / undo

Applied by settled S-15: the root `Makefile`, listed in `fleet/README.md`'s own files; fleet maintains it.
Undo: delete `Makefile`; zone.mk's test targets go back to failing as they did before.
