# R-7: remaining instruction cleanup — proposals only

Coord-fleet, 2026-10-30. Request #1036, resumed #1066, bounded by #1087 / S-39.
Authority: `/Users/bob/devlop/team-codegraph/design/codegraph-ours/docs/RULINGS.md:42-45`.
Command contract: `/Users/bob/devlop/team-codegraph/CODEGRAPH-COMMANDS.md`, updated 2026-10-30.

**Nothing shared was applied by fleet.** This package finishes the independent skill,
settings, fleet-job and smoke-fixture proposals and the product-preservation plan.
Four-team regeneration, custom-role mapping and manifest identity migration remain
**HOLD** under S-39/#1087. Completing these proposals is not a fleet-wide zero-hit pass.

## Verified roots and package

- Catalog repository: `/Users/bob/dev_docs/simple-machines-docs`.
- Catalog root, resolved to its absolute path:
  `/Users/bob/dev_docs/simple-machines-docs/shared/agent_catalog`.
- Catalog installation source is `skills/`, not `shared/agents_source/_skills/`.
  The latter supplied the three surviving draft baselines; the former currently
  has none of those three files. They are additions in this proposal.
- Codeteam source root: `/Users/bob/devlop/codeteam`; it is live. Its owning crew
  applies the codeteam patch in its own worktree and promotes normally, not by
  fleet editing that live checkout.
- Package: this document's sibling `graft-cleanup/`. `source-hashes.json` records
  every inspected external patch baseline. `validation.md` records dry-checks and
  identity closure; `identity-closure.json` is the machine-readable closure audit.

## Exact independent changes

| Patch | Relative to | Targets and effect |
|---|---|---|
| `graft-cleanup/catalog.patch` | catalog root | Add `skills/blast-radius/SKILL.md`, `skills/orchestrator/SKILL.md`, `skills/model-ladder/SKILL.md`; update `skills/codegraph/SKILL.md`, `rules/search-tooling.md`, `products/codeteam/AGENTS.md`. |
| `graft-cleanup/settings.patch` | `/Users/bob/devlop` | Four `team-<team>/team/claude/settings.json` files: moot, aimodel, bench, fulcrum. Remove exactly five retired-helper-only hook groups per file, including the whole associated `mcp__graft__` matcher group. |
| `graft-cleanup/codeteam.patch` | codeteam repository root | Only fleet's `job` string in `teams/codegraph.toml`, plus the two selected `v2/smoke/claude-fab/agents/{kong,nagatha}-opus-5-5-medium.md` fixtures. |

### Skill and rule contracts

The three migrated skills retain their other doctrine. Blast-radius is now
self-contained: its critical-primitives table, anti-patterns and examples are
inlined from the complete split documents under
`/Users/bob/dev_docs/simple-machines-docs/shared/agents_source/_archive/_skills/blast-radius/references/`,
with source hashes recorded. The prose was preserved, not reconstructed; the
incomplete active copy's dangling links are not carried into the catalog.
Index construction is not part of launcher/wormhole setup; the host seeds and catches up. Every query names
its absolute worktree. Returned source counts as read; a staleness warning or an
uncovered span warrants a file read. Building/copying answers warrant a retry, not
session-long abandonment. Agents do not initialize/index a never-indexed repository.

Both mandatory gates are explicit: fresh checkpoint then diff blast when writing a
request (impact for an unchanged symbol); fresh checkpoint then orphans before
squash/push, followed by dynamic/string-use checks. Freshness waits are bounded;
HEAD/hash/pending evidence must be inspected. Pending files cannot be called a
complete fresh check. CLI blast/grep/orphans/suspects use an explicit checkpoint,
not an unsupported `--fresh` flag. Indexed edges are candidates, not a guarantee
that name-based bindings are certain. The model-ladder change is its inventory
search-tool cell only; no model, effort or dispatch ladder is changed.

The existing CodeGraph skill is refreshed from the command reference, including
CLI-only versus enabled MCP surfaces. Search-tooling's historical note and the
codeteam product's obsolete pre-go-live wording are corrected as part of literal
loaded-content cleanup, without deleting product doctrine.

### Settings preservation

The four settings files are independent sources; the catalog has no settings
installer. Moot's design-checkout link reaches the same moot source, not a fifth
file. The patch was generated with JSON parsing. Each removed group contains only
the named helper command; no mixed group was silently discarded. All unrelated
values, permissions, environment, hooks and their relative order are preserved.
No general hook matcher, security gate or runtime setting is broadened.

### Smoke fixture identities are deliberately unchanged

`v2/smoke/run.py:115-146` selects these exact names. The proposal updates their
search instructions and Kong's obsolete blast-query lines, not their persona or
role. YAML frontmatter is parsed for preservation checks. Names, filenames, model,
effort, tools and other metadata are retained; the obsolete search-skill dependency
is removed without introducing a new dependency in a fixture home with no skills
directory. The smoke consumer is unchanged. This is not an alias or a migration
to differently named catalog roles.

## Owner application and rollback

These are instructions for the applying owners, **not commands fleet ran**. Work
from an approved catalog/codeteam owner worktree. Do not force a patch over source
drift: compare the package hashes, inspect changes, refresh the proposal if its
assumptions changed, and repeat the dry-check. Back up settings outside loaded team
homes before applying them. Keep the package available through acceptance/rollback.

```sh
PACK=/Users/bob/devlop/team-codegraph/workcrews/fleet/codegraph-fleet-graft-cleanup/fleet/rollout/graft-cleanup
# CAT_WT is the approved catalog repository worktree, not its nested catalog dir.
# CODETEAM_WT is codeteam's approved owner worktree, not the live main checkout.
: "${CAT_WT:?set approved catalog repository worktree}"
: "${CODETEAM_WT:?set approved codeteam owner worktree}"
git -C "$CAT_WT" apply --check --directory=shared/agent_catalog "$PACK/catalog.patch"
git -C "$CODETEAM_WT" apply --check "$PACK/codeteam.patch"
git -C /Users/bob/devlop apply --check "$PACK/settings.patch"
# After owner approval and backup, the corresponding applications are:
git -C "$CAT_WT" apply --directory=shared/agent_catalog "$PACK/catalog.patch"
git -C "$CODETEAM_WT" apply "$PACK/codeteam.patch"
git -C /Users/bob/devlop apply "$PACK/settings.patch"
```

Catalog/codeteam sources then follow their owning crews' normal release/promotion
procedures. Settings have no catalog regeneration step. Roll back each patch with
its same root/prefix and `git apply -R --check` then `git apply -R`; if unrelated
edits cause the inverse check to fail, reconcile the named changes rather than
restoring whole runtime settings from an older snapshot. The codeteam owner runs
its factory smoke in a throwaway team; fleet has not run that out-of-zone smoke.

## Product-rule/runtime preservation and regeneration HOLD

`make install` is copy-only: 82 obsolete agent files would survive the previously
suggested four-team copy. `make install-rules` deletes destination rules before
copying (`Makefile:15-29`). Product overlays currently exist for moot, forge,
codegraph and codeteam, not aimodel/bench/fulcrum. Neither command is a safe
standalone regeneration instruction for this request. **Do not run them yet.**

The preservation plan for the applying owner, after the identity decision:

1. Snapshot each actual installed home **and** its manifest's configured source,
   resolving symlinks. Record hashes, modes and link targets for all loaded rules,
   settings and configured agent files; keep backups outside loaded directories.
2. Preserve each product's doctrine, including lab/bench laws, without replacing it
   with moot's product layer. Build a reviewed product overlay from its existing
   product-owned rules before any delete-and-copy install. Classify collisions with
   generic rules explicitly; unchanged non-cleanup product rules must remain
   byte-identical. Other runtime metadata and permissions must remain unchanged.
3. Settle configured identities before pruning obsolete agents. Stage the catalog
   output separately, never copy over the installed agents as the first step.
   Check every top-level/override/assistant selection and every declared Agent
   dependency against the candidate output. A role absent from that set is a HOLD,
   not a license to alias it, delete it, or silently choose a different model.
4. Reconcile source versus installed-home differences in `validation.md`. Aimodel
   and bench name moot's design source; fulcrum names moot's team home; forge names
   its separate `/Users/bob/devlop/forge/.claude`. Do not replace one team's rules
   through a shared source and accidentally change another product's law.
5. Only after the owner has approved a closed identity set and product overlay,
   stage a complete replacement set, prove the non-target hashes and runtime
   values are preserved, then perform the authorized atomic installation. Compare
   its exact file set to the candidate: neither retained stale agents nor missing
   required agents is acceptable. This package supplies no manifest migration or
   executable four-team install sequence while that authorization is absent.
6. Forge's separate `agents/skippy-orchestrate.md` is tracked in that same held
   replacement plan. It is not cleaned by copying `repo-orchestrator.md` beside
   it. Resolve its continued use/retirement with the configured-identity decision;
   do not add a compatibility alias. No standalone-skippy patch is slipped into
   the independent changes above.

Current configured-identity audit is in `validation.md` / `identity-closure.json`.
It distinguishes installed-home presence, configured-source presence and current
catalog membership. It does **not** assert closure where the evidence fails it.

## Final loaded-content verification (after authorized completion)

This scope includes all seven live homes and forge's separate source, following
symlinks, including ignored files, but not inactive archives/backups or agent
memory. The smoke fixture home is also checked. Missing required roots and `rg`
errors fail; only exit 1 from `rg` means no matches. Do not claim this pass after
only the independent patches: held agent regeneration still carries references.

```sh
(
  set --
  for team in moot codegraph codeteam aimodel bench forge fulcrum; do
    root="/Users/bob/devlop/team-$team/team/claude"
    test -d "$root" || exit 2
    for entry in agents rules skills hooks commands settings.json; do
      if test -e "$root/$entry" || test -L "$root/$entry"; then
        set -- "$@" "$root/$entry"
      fi
    done
  done
  root=/Users/bob/devlop/forge/.claude
  test -d "$root" || exit 2
  for entry in agents rules skills hooks commands settings.json; do
    if test -e "$root/$entry" || test -L "$root/$entry"; then
      set -- "$@" "$root/$entry"
    fi
  done
  root=/Users/bob/devlop/codeteam/v2/smoke/claude-fab
  test -d "$root" || exit 2
  set -- "$@" "$root"
  rg --hidden --no-ignore -L -n -i graft "$@"
  result=$?
  test "$result" -eq 1
)
```

No live zero-hit or runtime-test pass is claimed. Proposal dry-checks, structural
preservation assertions and configured-identity evidence are recorded separately
in `graft-cleanup/validation.md`.
