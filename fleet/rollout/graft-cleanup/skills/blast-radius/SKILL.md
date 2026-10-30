---
status: active-finalized
tags: [skill, process, mandatory]
created: 2026-04-23
updated: 2026-10-30
supersedes: none
mandated_by: Bob's 2026-04-23 directive
name: blast-radius
effort: xhigh
description: >-
  Pre-flight protocol for missions that modify, remove, rename, or alter
  the semantics of existing symbols. Maps call-site impact via the
  CodeGraph call graph (callers, impact, blast) plus rg for non-code
  references, and documents required updates before code changes are made.
when_to_use: >-
  Mission touches existing primitives (the core entities,
  an entity, an archive store, the store, a compute engine, a scoring engine,
  ProgressLeversEngine, RAGVerifier, SchemaValidator). Mission renames
  or removes a symbol. Mission changes a function signature. Mission
  deprecates a method. Mission alters CloudKit record fields, SQLite
  columns, bitmap bits, NodeType cases, a core entity cases, or
  ProgressLeversLevel cases. Trigger phrases: blast radius, MUST_UPDATE,
  INTENTIONALLY_LEFT, RESCOPE_REQUIRED, rename, signature change,
  symbol removal, deprecation, migration, orphan deprecation, bridge
  helper, shim, partial migration, Critical Primitives Table, Blast
  Radius Report, docs/blast_radius, swift test exit 0, baseline test
  count, call sites, symbol being changed, codegraph, codegraph callers,
  codegraph impact, codegraph blast, blast radius, call graph.
placement: shared/skills/SKILL_BLAST_RADIUS.md
---

# Skill: Blast Radius Discipline
## Claude Code Reference — The Top-to-Bottom Change Protocol
### Version 1.0 — April 2026

---

## Commander's Standard

*Bob is the Commander. He values accuracy and completeness over speed.
Every rule in this document exists because a missed caller costs more
than a slow mission.*

*Right the first time, every time.*

*A partial migration is worse than a delayed migration. A missing file
is worse than slow sync. If the cascade cannot be completed in this
mission, the mission pauses and rescopes — it never ships partial.*

---

## When This Skill Applies

This skill is MANDATORY before Bilby makes any change to existing code
that modifies, removes, renames, deprecates, or alters the semantics
of a symbol that may be referenced elsewhere. Specifically, any of:

- Renaming a type, function, parameter, or field
- Changing the signature of a function (adding, removing, or reordering
  parameters; changing types; changing return type)
- Removing a property, parameter, accessor, or case
- Adding `@available(*, deprecated, ...)` or any deprecation annotation
- Changing the semantics of an existing symbol even if the signature
  is preserved (for example: same function, different return value
  contract)
- Modifying a shared data-model field (stored property, computed
  property, bitmap bit assignment)
- Modifying persistence schema (SQLite column, CloudKit record field)
- Modifying canonical constants (slider stops, date weights, effort
  modifiers, bit assignments)

This skill does NOT apply to purely additive changes:
- Adding a new file with no external references yet
- Adding a new case to a previously-private enum
- Adding a new private helper
- Pure formatting/whitespace changes
- Comment-only edits

If you are uncertain whether a change triggers this skill, it does.
Err on the side of running the protocol.

---

## The Protocol — Five Steps

### Step 0: Establish the baseline

Before writing any production code, capture:

```bash
cd into the kit and run swift test 2>&1 | tail -5
```

Record the baseline test pass count. If `swift test` does not exit 0
at mission start, STOP and write a .stuck signal with
`ERROR="test suite broken at mission start; needs triage before this
mission can proceed"`. Do not attempt to work around broken tests.
Fix the test suite first in a separate mission if necessary.

If `swift test` exits 0 cleanly, record the pass count. This is the
gate value. At mission end, the pass count must be at least this
number, and `swift test` must exit 0.

#### Step 0b: Bring the index up to the working tree

CodeGraph follows indexed repositories automatically; a new worktree seeds
from an indexed sibling on its first call. There is no agent-run index
build. Before a gate, request bounded catch-up and inspect its evidence:

```bash
codegraph checkpoint --fresh <wt>
```

Record the returned HEAD, working-tree hash and pending-file count. The
wait is bounded: if files remain pending, do not claim a fresh graph or a
complete radius; retry or report the incomplete gate.

Pass your own absolute worktree on every call (`-p <wt>` on the CLI,
`projectPath` on MCP). MCP gates use `fresh: true`; CLI `grep`, `blast`,
`orphans` and `suspects` need the explicit checkpoint first, not a
`--fresh` option. Treat returned source as already read; open a file only
for an uncovered span or a staleness warning naming an on-disk change.

If the answer says the index is building or being copied, retry shortly;
do not abandon CodeGraph for the session. A repository never indexed is
the user's decision: never run `init`, `index`, `uninit`, `unlock`,
`install`, `uninstall`, `upgrade` or `telemetry`. When no graph is
available, record `codegraph: unavailable` and the reason in the report;
an rg-only radius is weaker and cannot be presented as graph-verified.

### Step 1: Identify every symbol being changed

List every symbol the mission will modify. For each:

- Full symbol path (e.g., a computed field on an entity,
  `RAGVerifier.testCorrectExclusion(targetRoleId:)`, `an archive store.init`)
- Change class: rename / signature / removal / deprecation / semantic
- Scope: public / internal / private / module-local

For each symbol in the "Critical Primitives Table" (§Critical
Primitives below), the blast radius protocol runs automatically
regardless of how minor the change appears.

### Step 2: Map call sites — CodeGraph primary, rg backstop

The blast radius has two halves: **code call sites** (who calls or
references the symbol in source) and **non-code references** (docs,
canon, comments, schema strings). CodeGraph owns the first; rg owns
the second.

#### 2a. Code call sites — CodeGraph

For each symbol being changed, query the call graph:

```bash
# Direct callers — who calls or references this symbol right now
codegraph callers SYMBOL -p <wt>

# Transitive blast radius — everything affected if SYMBOL changes,
# walked out two levels (-d <n> for more). This is the reach rg never gave you.
codegraph impact SYMBOL -p <wt>

# For a rename or removal, also list what the symbol itself calls,
# so you know what becomes orphaned if the symbol is deleted.
codegraph callees SYMBOL -p <wt>
```

For a whole diff rather than one symbol:

```bash
codegraph checkpoint --fresh <wt>   # inspect HEAD, hash and pending count
codegraph blast -b <base-ref> -p <wt> -f markdown
```

Record the actual base ref and returned checkpoint in the request. For a
symbol not yet edited, run `codegraph impact SYMBOL -p <wt> --fresh`.
The diff query starts from the changed ranges; impact starts from the
named symbol (default depth 2, `-d <n>` for a wider walk).

These are indexed dependency candidates, not proof that every binding is
certain. Classify every returned site in Step 3 and investigate ambiguous
or low-confidence bindings before treating the radius as complete.

**Know its limits.** A name defined in several places can leave a caller
bound by name only, or with low confidence; `codegraph suspects -p <wt>`
lists such calls, ranked. Treat any that touch SYMBOL as gaps in the list
and resolve them with `codegraph grep "SYMBOL" -p <wt>` (every hit,
grouped under its enclosing symbol) before treating the radius as
complete.

This bites hardest on a DUAL-PORT repo, where the same name exists in both
ports by design. `DistilledSavings` reported no callers and was being
called perfectly well. So a zero-caller result is a SUSPICION, never a
finding — confirm every one with `codegraph grep` before acting on it.
Without that step the check produces a false positive on most symbols in
the repo, and a check that cries wolf on most of its hits gets ignored.

For a renamed symbol, run `callers` on the OLD name before the change and
again after, to confirm the old name has zero surviving callers and the
new name carries them all. Before squash/push, run a fresh checkpoint,
inspect its pending count, then check additions:

```bash
codegraph checkpoint --fresh <wt>
codegraph orphans -b <base-ref> -p <wt>
```

For each listed candidate run `rg -nw SYMBOL` for dynamic and string uses
before calling it unwired. Protocol/trait implementations and tests are
excluded by the orphan tool. MCP: `codegraph_orphans` with `base`,
`projectPath` and `fresh: true`. Documented but unwired API is a finding,
not permission to delete it.

If CodeGraph is unavailable (Step 0b) and you are on the rg-only fallback,
skip 2a and rely on 2b for code as well — but flag it: an rg-only blast
radius is weaker and the reviewer must know.

#### 2b. Non-code references — rg

CodeGraph indexes symbols, not prose or schema strings. Docs, canon
files, comments, SQLite column names, and CloudKit field names are
NOT call edges and will not appear in `impact`. rg remains MANDATORY
for these:

```bash
# Docs and canon — symbol named in prose
rg -n "SYMBOL" docs/canon/ docs/decisions/ docs/missions/ docs/skills/

# Schema and persistence — substitute the product's actual paths
rg -n "SYMBOL" "$SCHEMA_FILE"
rg -n "SYMBOL" "$SYNC_SOURCES"
rg -n "SYMBOL" "$SCHEMA_VALIDATOR"
rg -n "SYMBOL" "$KIT/Package.swift"

# Comments and docstrings that name the symbol
rg -n "SYMBOL" "$KIT/Sources/" -g '*.swift' -B 1 -A 1
```

If the symbol name is short or common, use `\bSYMBOL\b` or a
uniquely-qualified form to cut noise.

#### 2c. Reconcile

Union the CodeGraph call sites (2a) and the rg non-code hits (2b)
into one list. If rg surfaces a *code* call site that CodeGraph did
NOT (e.g. a dynamic dispatch, a reflection-based call, a string
selector), that is a signal the call graph could not see it statically
— classify it MUST_UPDATE and note `dynamic — rg-only` in the
justification, because the static index is blind to it.

### Step 3: Classify every hit

Every call site (from CodeGraph or rg) gets one of three
classifications:

**MUST_UPDATE** — this call site uses the symbol and must be changed
to match the new signature / semantics / deprecation. This includes
tests, docs, canon files, comments that name the symbol, and schema
references.

**INTENTIONALLY_LEFT** — this hit matches the grep pattern but does
not actually reference the symbol being changed (false positive), OR
references the symbol but legitimately does not need updating. Every
INTENTIONALLY_LEFT hit requires a written justification.

**RESCOPE_REQUIRED** — this call site must be updated, but doing so
expands the mission scope beyond what was sanctioned. Mission pauses.
Surface to Bob with a rescope request. Do not proceed.

The RESCOPE_REQUIRED classification is the escape valve. When Bilby
hits one, the mission stops. The correct action is to request that
Skippy rescope (either expand this mission's scope or create a
follow-up mission that handles the expansion before this one merges).
The incorrect action is to silence the issue with a bridge, shim, or
`@available(*, deprecated)` annotation. See "Anti-Patterns" below.

### Step 4: Write the Blast Radius Report

Use this exact template. Write to
`docs/blast_radius/<task_id>_BLAST_RADIUS.md` and commit it as
the first commit of the stream (before any production changes):

```markdown
# Blast Radius Report — <task_id>

**Baseline:** swift test pass count at mission start: NNN
**Mission:** <mission_title>
**Symbols being changed:**

## Symbol 1: <full.symbol.path>
**Change class:** rename / signature / removal / deprecation / semantic
**Scope:** public / internal / private

### Call sites

| File | Line | Source | Classification | Justification (if INTENTIONALLY_LEFT) |
|---|---|---|---|---|
| the kit's Sources/X.swift | 42 | codegraph | MUST_UPDATE | |
| the kit's Sources/Y.swift | 87 | grep | INTENTIONALLY_LEFT | Matches pattern but refers to unrelated local var `boost` in sort comparator |
| the kit's Tests/XTests.swift | 15 | codegraph | MUST_UPDATE | |
| docs/canon/MATH_SPEC.md | 204 | grep | MUST_UPDATE | Prose references old signature |

### Summary
- MUST_UPDATE: N sites
- INTENTIONALLY_LEFT: M sites (all justified below)
- RESCOPE_REQUIRED: P sites (if P > 0, mission blocks)

## Symbol 2: ...
```

Commit message for this commit:

```
docs(blast-radius): <task_id> Blast Radius Report

Enumerates all call sites affected by the symbol changes in this
mission. MUST_UPDATE: N sites. INTENTIONALLY_LEFT: M sites. Each
INTENTIONALLY_LEFT has a written justification.

Stream: <stream-id>
```

### Step 5: Implement — every MUST_UPDATE site must be touched

When implementation begins, every file listed as MUST_UPDATE must
appear in the final diff. If any MUST_UPDATE file is not in the
diff at commit time, Bilby either:

- Touches it to reflect the change, OR
- Reclassifies it to INTENTIONALLY_LEFT in the Blast Radius Report
  with a written justification, AND adds a commit amending the
  report.

Adams re-reads the Blast Radius Report in post-flight and verifies
every MUST_UPDATE file appears in the diff. A MUST_UPDATE file
missing from the diff is a CRITICAL finding.

---


## Critical Primitives Table

The following symbols and surfaces are so cross-cutting that ANY
change — including renames, signature changes, semantic changes, or
removal — automatically triggers the full blast-radius protocol
regardless of mission size or apparent triviality.

| Primitive | Grep pattern guidance |
|---|---|
| `the entity` fields (stored properties) | `<fieldname>` across Sources/ Tests/ the iOS app/ CloudSync/ Persistence/ Validation/ CKRecordMapper |
| `a settings entity` fields | Same as the entity |
| `an entity`, `an entity`, `FKnowledgeDoc`, `a settings entity` fields | Same as the entity |
| `an archive store.init` signature | `an archive store(` across all .swift files |
| `the store` public API | `the store.` and `store.` across all callers |
| Public APIs of `a compute engine`, `a scoring engine`, `ProgressLeversEngine`, `RAGVerifier`, `RAGRetriever` | Module name + `.` across Sources/ Tests/ the iOS app/ |
| `SchemaValidator` rules (add/remove/change) | `SchemaValidator` + the specific field name being validated |
| CloudKit record field names in `CKRecordMapper+Node.swift` | The exact string literal used as the record key |
| SQLite column names in `SQLiteSchema.swift` and `SQLiteStore+*.swift` | The exact column name as string AND as Swift property |
| `DATA_MODEL.md` version rev | Grep `DATA_MODEL` across canon/ decisions/ skills/ |
| Bitmap bit assignments (any bit in `the bitmap field`, `the bitmap field`, `the bitmap field`, etc.) | Grep the bit constant AND the computed accessor name |
| Canon file rev bumps (DATA_MODEL, MATH_SPEC, UI_SPEC_IOS, ARCHITECTURE, MANIFEST, PHASE_PLAN, PRODUCT_LINE, VOCABULARY, NEXUS_SPEC) | Grep the filename across Sources/ Tests/ missions/ decisions/ skills/ |
| `ProgressLeversLevel` cases, `NodeType` cases, `a core entity` cases | Case name across all `.swift` files (switches especially — `default` branches can hide missed cases) |

When the primitive being changed appears in this table, Step 2's grep
command set is the MINIMUM — Bilby may need to extend it based on the
primitive's specific distribution.

The table is curated, not exhaustive. If Bilby encounters a primitive
not listed here that feels similarly cross-cutting, Bilby treats it
as critical by default (run the full protocol) and mentions the
candidate to Skippy for inclusion in a future revision of this table.

---

## Anti-Patterns

When the blast radius is larger than the mission scope, the following
responses are PROHIBITED. All are forms of partial migration. All are
"missing files" in Bob's framing.

### 1. Bridge helpers that preserve old behavior

Example: `legacyStaticBoost(for level: ProgressLeversLevel) -> Double`
— a private helper that returns the same values the deprecated
accessor returned, called from the single site that triggered the
deprecation warning. Silences the warning without executing the
migration.

Why forbidden: the deprecated symbol is still effectively alive via
the bridge. Downstream readers of the vestigial data still work on
stale values. The migration was not done — just hidden.

Correct response: RESCOPE_REQUIRED. Surface to Bob.

### 2. Shim types or adapters

Example: creating a wrapper type that forwards calls to a deprecated
type, so the deprecated type "can be removed later." The deprecated
type cannot be removed because the wrapper references it.

Correct response: remove the deprecated type entirely in the same
mission that introduces the replacement, OR RESCOPE_REQUIRED.

### 3. `@available(*, deprecated, ...)` left alive

Marking a symbol deprecated is a PROMISE to remove it in the same
mission or an immediate follow-up. Missions that mark symbols
deprecated and ship without scheduling the removal mission have
created the exact situation we are currently cleaning up.

Correct response: either remove in this mission, or open a follow-up
mission in the same push that removes it, with the removal mission
created as a hard dependency. No orphan deprecations.

### 4. TODO / FIXME comments deferring same-symbol work

Any TODO or FIXME comment referencing the symbol being changed is
evidence of incomplete migration. If the work is needed, it is in
scope. If the work is not needed, no comment should exist.

Correct response: do the work in this mission, or rescope.

### 5. "Out of scope, pre-existing issue"

The ONLY legitimate out-of-scope items are genuinely unrelated
pre-existing issues that happen to coexist with the mission's files
— e.g., a pre-existing test-case typo in a different test unrelated
to the symbol being changed. If a pre-existing issue involves the
SAME symbol as the mission's change, it is not pre-existing to the
blast radius: it is part of it.

### 6. "Tests already broken, not caused by this mission"

If `swift test` is broken at mission start, the mission STOPS (per
Step 0). Bilby writes a .stuck signal and Bob dispatches a separate
test-fix mission. Bilby never ships a mission on top of a broken
test suite. The 0231 → 0239 gap existed because this rule was not
yet codified.

---

## Test Verification — The Exit-Zero Rule

`swift test` at mission-end MUST exit 0. Not "tests look fine." Not
"the test target compiles." Not "my tests pass." The full test
suite, exit 0, pass count at or above the baseline recorded in
Step 0.

Required in the completion report, §Test Verification Log:

```markdown
## Test Verification Log

### Baseline (from Blast Radius Report, Step 0)
- Pass count at mission start: NNN
- Command: `cd into the kit and run swift test`

### Final (post-commit, pre-signal)
- Command: `cd into the kit and run swift test 2>&1 | tail -20`
- Exit code: 0
- Pass count: NNN (or higher)
- Fail count: 0
- Full tail output pasted below (verbatim, 20 lines minimum):

```
<PASTE FULL TAIL OUTPUT HERE — unmodified>
```

### iOS target
- Command: `xcodebuild -workspace Fulcrum.xcworkspace -scheme the iOS app -destination 'platform=iOS Simulator,name=iPhone 17' test 2>&1 | tail -10`
- Exit code: 0
- Full tail output pasted below:

```
<PASTE FULL TAIL OUTPUT HERE — unmodified>
```
```

Adams re-runs these commands in post-flight (or verifies the pasted
output is genuine by spot-checking specific test names against the
test files). A report with `swift test` output that doesn't match
the tests actually present is a CRITICAL finding and blocks signal.

---


## Examples

### Example 1: Proper MUST_UPDATE classification

Mission: rename `the entity.importanceSlider` to `the entity.importance`.

Grep results include:
- `the kit's Sources/DataModel/Entities/the entity's source file:145` — stored
  property declaration → MUST_UPDATE
- `the kit's Sources/a compute engine/a scoring engine.swift:87` — reads
  `node.importanceSlider` → MUST_UPDATE
- `the kit's Tests/the entityTests/the entityTests.swift:42` — asserts
  `node.importanceSlider == 0.5` → MUST_UPDATE
- `docs/canon/DATA_MODEL.md:312` — prose references
  `importanceSlider` → MUST_UPDATE
- `docs/canon/MATH_SPEC.md:156` — formula uses `importanceSlider`
  → MUST_UPDATE
- `docs/decisions/ADR-007-scoring-model.md:88` — decision context
  references `importanceSlider` → INTENTIONALLY_LEFT, with
  justification: "ADR records the historical decision at the time
  of its authorship. Updating the ADR would retcon history. A new
  ADR documenting the rename is the correct artifact."
- `docs/missions/MISSION_0042.md:22` — archived mission references
  `importanceSlider` → INTENTIONALLY_LEFT, with justification:
  "Archived missions are historical records and are not updated
  when primitives rename."

### Example 2: Improper INTENTIONALLY_LEFT (caught by Adams)

Mission: remove a computed field on an entity.

Grep hit:
- `the kit's Sources/a compute engine/a scoring engine.swift:145` —
  reads `node.progressLeverImportanceBoost` for its importance
  calculation.

Bilby classifies: INTENTIONALLY_LEFT, justification: "a scoring engine
use of this field is pre-existing and unrelated to the scope of this
mission."

This classification is WRONG. a scoring engine's use of the field
is exactly what the mission is trying to retire. If the field is
removed, a scoring engine no longer compiles. The correct
classification is MUST_UPDATE (migrate a scoring engine) or
RESCOPE_REQUIRED (pause and rescope if the migration is complex).

Adams catches this in post-flight by re-running the grep and
seeing that `a scoring engine.swift:145` is in MUST_UPDATE territory
but wasn't touched. Adams flags CRITICAL.

### Example 3: RESCOPE_REQUIRED done correctly

Mission: delete a computed field on an entity.

Grep surfaces 11 call sites: 6 in production code across FCL, VMs,
persistence, and sync; 3 in tests; 2 in canon docs. The mission
was scoped to address 3-4 sites. Bilby classifies the remaining 7
as RESCOPE_REQUIRED, writes the Blast Radius Report, commits it,
and writes a .stuck signal with:

```
STREAM=pb
MISSION=fulcrum/missions/MISSION_PROGRESS_BOOST_PURGE.md
ERROR=Blast radius larger than mission scope — 7 additional
MUST_UPDATE sites identified. See
docs/blast_radius/TASK-FLX-2026-0241_BLAST_RADIUS.md.
Rescope required.
```

Bob / Skippy either expand the mission or split into multiple
sequential missions. Bilby does NOT proceed with the original
narrow scope.

---

## Relationship with Other Skills

- **SKILL_PRE_COMMIT.md** — §0 of pre-commit requires a Blast
  Radius Report exists at `docs/blast_radius/<task_id>_BLAST_RADIUS.md`
  before ANY commit beyond the report itself. The first commit of
  every stream that touches existing code is the Blast Radius
  Report.

- **SKILL_SELF_REVIEW.md** — Step 0 requires verifying the final
  diff matches the MUST_UPDATE list in the Blast Radius Report.

- **SKILL_MISSION_TEMPLATE_v2.1.md** — execution order step 3.5 is
  the Blast Radius HARD GATE. Bilby cannot proceed past step 3.5
  without a Blast Radius Report.

- **Agent: Adams (post-flight)** — MUST read the Blast Radius
  Report as a required input. MUST re-run the queries to catch drift.
  MUST verify every MUST_UPDATE file appears in the diff. MUST
  verify test exit 0 via log capture or re-run.

---

## The Rule

If a change to symbol X has any effect on other code that reads or
writes X, every such call site is in scope. There is no "pre-existing,
out of scope" escape hatch for call sites of the SAME symbol. If the
mission as originally scoped cannot cover all call sites, the mission
pauses and rescopes. It never ships partial.

Right the first time, every time.
