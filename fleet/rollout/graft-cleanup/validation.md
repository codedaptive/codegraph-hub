# Proposal validation (2026-10-30)

Static proposal checks only. No shared writes, regeneration, installs, runtime builds or suites.

- `git -C <disposable-catalog-snapshot> apply --check <package>/catalog.patch`: exit 0; local application exit 0; 6 targets have zero retired-tool references.
- `git -C <disposable-codeteam-snapshot> apply --check <package>/codeteam.patch`: exit 0; local application exit 0; 3 targets have zero retired-tool references.
- TOML/YAML assertions PASS: only fleet.job and obsolete fixture skill changed; names/models/efforts/tools and other metadata preserved. Persona bodies unchanged outside named search/query instructions.
- `git -C <disposable-settings-snapshot> apply --check <package>/settings.patch`: exit 0; local application exit 0; 4 targets have zero retired-tool references.
- JSON assertions PASS: 20 groups and four associated matchers removed; all unrelated values and hook order preserved.

- Final source baselines: 13, unchanged during successful validation. Earlier checks stopped on external manifest drift and caught a settings EOF-marker defect; records above describe the corrected patch state.

## Configured identity audit (not an identity-migration approval)

| Team | Configured source | Identity | Installed home | Source | Catalog |
|---|---|---|---|---|---|
| moot | `/Users/bob/devlop/team-moot/design/mootx01-ee-develop_1.1.x/.claude` | `integration-builder` | present | present | present |
| moot | `/Users/bob/devlop/team-moot/design/mootx01-ee-develop_1.1.x/.claude` | `repo-designer` | present | present | present |
| moot | `/Users/bob/devlop/team-moot/design/mootx01-ee-develop_1.1.x/.claude` | `repo-orchestrator` | present | present | present |
| moot | `/Users/bob/devlop/team-moot/design/mootx01-ee-develop_1.1.x/.claude` | `security-reviewer` | present | present | present |
| moot | `/Users/bob/devlop/team-moot/design/mootx01-ee-develop_1.1.x/.claude` | `spec-guard` | present | present | present |
| moot | `/Users/bob/devlop/team-moot/design/mootx01-ee-develop_1.1.x/.claude` | `zone-coordinator` | present | present | present |
| codegraph | `/Users/bob/devlop/team-codegraph/team/claude` | `repo-designer` | present | present | present |
| codegraph | `/Users/bob/devlop/team-codegraph/team/claude` | `repo-orchestrator` | present | present | present |
| codegraph | `/Users/bob/devlop/team-codegraph/team/claude` | `spec-guard` | present | present | present |
| codegraph | `/Users/bob/devlop/team-codegraph/team/claude` | `zone-coordinator` | present | present | present |
| codeteam | `/Users/bob/devlop/team-codeteam/team/claude` | `repo-designer` | present | present | present |
| codeteam | `/Users/bob/devlop/team-codeteam/team/claude` | `repo-orchestrator` | present | present | present |
| codeteam | `/Users/bob/devlop/team-codeteam/team/claude` | `spec-guard` | present | present | present |
| codeteam | `/Users/bob/devlop/team-codeteam/team/claude` | `zone-coordinator` | present | present | present |
| aimodel | `/Users/bob/devlop/team-moot/design/mootx01-ee-develop_1.1.x/.claude` | `bilby-coordinate` | present | MISSING | MISSING |
| aimodel | `/Users/bob/devlop/team-moot/design/mootx01-ee-develop_1.1.x/.claude` | `bilby-lab` | present | MISSING | MISSING |
| aimodel | `/Users/bob/devlop/team-moot/design/mootx01-ee-develop_1.1.x/.claude` | `skippy-orchestrate` | present | MISSING | MISSING |
| bench | `/Users/bob/devlop/team-moot/design/mootx01-ee-develop_1.1.x/.claude` | `bilby-bench` | present | MISSING | MISSING |
| bench | `/Users/bob/devlop/team-moot/design/mootx01-ee-develop_1.1.x/.claude` | `bilby-coordinate` | present | MISSING | MISSING |
| bench | `/Users/bob/devlop/team-moot/design/mootx01-ee-develop_1.1.x/.claude` | `skippy-orchestrate` | present | MISSING | MISSING |
| forge | `/Users/bob/devlop/forge/.claude` | `integration-builder` | present | MISSING | present |
| forge | `/Users/bob/devlop/forge/.claude` | `repo-designer` | present | MISSING | present |
| forge | `/Users/bob/devlop/forge/.claude` | `repo-orchestrator` | present | MISSING | present |
| forge | `/Users/bob/devlop/forge/.claude` | `spec-guard` | present | MISSING | present |
| forge | `/Users/bob/devlop/forge/.claude` | `zone-coordinator` | present | MISSING | present |
| fulcrum | `/Users/bob/devlop/team-moot/team/claude` | `bilby-coordinate` | present | MISSING | MISSING |
| fulcrum | `/Users/bob/devlop/team-moot/team/claude` | `bilby-zone-sonnet-5-5-high` | present | MISSING | MISSING |
| fulcrum | `/Users/bob/devlop/team-moot/team/claude` | `kong-opus-5-5-medium` | present | MISSING | MISSING |
| fulcrum | `/Users/bob/devlop/team-moot/team/claude` | `nagatha-opus-5-5-medium` | present | MISSING | MISSING |
| fulcrum | `/Users/bob/devlop/team-moot/team/claude` | `skippy-orchestrate` | present | MISSING | MISSING |

Current catalog: 28 generated names. Source is not necessarily installed home. Missing names are HOLD, never permission to alias/delete. This audit covers configured selections; full transitive Agent closure must be proved on the future approved candidate output, not claimed here.

## Explicit limits

Four-team regeneration is held by S-39/#1087. No custom-role mapping or manifest identity change is proposed. No live-home zero-hit pass, runtime-test pass, factory smoke or shared regeneration is claimed. Zone-test-status has no record: these are proposal-only static checks.

## Review rework validation

- Catalog-only changed state: disposable `git apply --check` and application exit 0; all six targets remain free of the retired-tool name. Unchanged codeteam/settings checks above were not repeated.
- Three missing required sections are inline, copied from the complete legacy split documents recorded in source-hashes.json, not invented. No references/ link remains.
- File selector guidance now explicitly limits -f to named-symbol commands and excludes explore.

## Validated patch state

```text
0dee8a8e138bb7a9d391bcac8e50aba3ec114efb0e0a6bbc51130d8940bbfdd7  catalog.patch
9cf9dced8744f6c43e3461f2dabed4de8be292de452ad74364768fabd802e420  codeteam.patch
4cc14dce0a9bf76752c650ca43867d8494381510fe442ac0a812fbbf3bbac8ce  settings.patch
```
