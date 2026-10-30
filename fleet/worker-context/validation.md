# worker-context K-38/K-39: validation record

2026-10-30, Coord-fleet. Orc #1182 asked for the disposable checks; Orc #1202 (R-10) ruled
that worker-context is a shell/doc proposal, so no recorded zone pass applies and the harness
is run directly with plain `python3`, with no runner. This is not an engine test: no engine
code is imported, built or tested, and nothing outside temporary directories is touched.

Machine: Darwin arm64, load averages 6.97 6.99 5.85 at the time of the run (the machine was
loaded; the run itself is 0.35 s wall, 0.26 s CPU).

## Command and output (final state of this commit)

```text
$ python3 -I fleet/worker-context/validate-provisioning.py
Platform: Darwin arm64
Recipe SHA256: a0be9e608944130db2bc4904cab815aa4c6884ffc579ab5b8de895494900edf5
PASS fresh: exit=0, new_entries=4, existing_entries_preserved
PASS all-equal: exit=0, new_entries=0, existing_entries_preserved
PASS published-home-missing-links: exit=0, new_entries=2, existing_entries_preserved
PASS conflict: exit=1, new_entries=0, existing_entries_preserved
PASS dangling: exit=1, new_entries=0, existing_entries_preserved
PASS wrong-rules: exit=1, new_entries=0, existing_entries_preserved
PASS: 6 disposable provisioning cases (3 success states, 3 refusals); no shared application or engine tests
```

Exit status 0 (`echo "exit=$?"` after the final run, output redirected to a file and printed above).

What the six cases prove, each in a fresh temporary tree whose root contains a space:

| Case | Expected | What is checked |
|---|---|---|
| fresh | exit 0 | home PROJECT.md + toolchain rule copied (2 new), primary and worker PROJECT links created (2 new); contents equal the sources |
| all-equal | exit 0 | everything already equal and linked: zero new entries (this is K-39's macOS `cp -n` skip case) |
| published-home-missing-links | exit 0 | home documents equal; the two missing PROJECT links are completed (2 new), nothing forced |
| conflict | exit 1 | a differing home PROJECT.md survives; stderr says "context conflict" |
| dangling | exit 1 | a dangling worker PROJECT link survives, refused |
| wrong-rules | exit 1 | a worker `rules` directory that is not the linked one is refused; stderr says "worker rules differ" |

In every case the harness snapshots the fixture before and after, and asserts every existing
file, directory and link keeps its mode, inode, mtime and content/target; the only differences
are exactly the new entries listed. It extracts the README's shell block verbatim and changes
only the four root assignments (`CAT`, `HOME_CTX`, `PRIMARY`, `WT`).

## Negative control (the harness catches K-39)

The same harness against the pre-repair README (`git show HEAD:fleet/worker-context/README.md`),
in a scratch directory:

```text
AssertionError: ('all-equal', 1, '', '')
```

The old recipe exited 1 with no message on the all-equal case (`cp -n` on macOS returns nonzero
when it skips an existing destination, and `set -e` stops the script), which is the failure Kong
reported as K-39. The repaired recipe passes that case. `fresh` ran first and passed on the old
recipe, as expected.

## Other checks

- `catalog.patch` applied with `git apply -p1 --verbose` in a disposable `git init` directory:
  both new files applied cleanly, and `products/codegraph/PROJECT.md` and
  `products/codegraph/rules/toolchain-typescript.md` are byte-equal to
  `fleet/worker-context/PROJECT.md` and `toolchain-typescript.md`.
- `toolchain-typescript.md` is unchanged: git blob `51c8cbe4b168df41b71847a829d869f913491235`, the same
  at HEAD and in the working tree.
- K-38: PROJECT.md (lines 12-23) cites `design/codegraph-ours/docs/RULINGS.md` R-8/R-9 and says
  they are an intended target, not released state or WP1 acceptance; the patch carries the same text.

## Not done, on purpose

No shared application, no agent generation, no real home or worktree provisioned, no engine
build or test, no old R-9 gate rerun, and no claim that the blocked workers have resumed.
