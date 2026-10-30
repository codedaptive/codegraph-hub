---
name: orchestrator
description: >-
  The fleet as it stands: who exists, what each one is for, which model
  each runs, and the two lifecycles. Read this when deciding who to
  dispatch, when running interactively without the wormhole, or when the
  structure itself is in question.
when_to_use: >-
  Deciding which agent to dispatch for a piece of work. Running
  interactively outside the wormhole and needing the worktree lifecycle.
  Asked what the fleet is or who does what. Unsure whether a role has a
  4-variant or a 5-variant. Setting up a wave. Trigger phrases: who should
  do this, which agent, the fleet, what agents exist, orchestrator
  structure, worktree setup, who reviews, which model, 4 or 5 variant.
status: active
tags: [orchestration, fleet, lifecycle]
created: 2026-08-16
---

# The fleet

## Shape

```
Bob
 └─ ORCHESTRATOR      skippy-orchestrate   opus-5-5    interactive, holds the plan
     └─ COORDINATOR   bilby-coordinate     opus-5-5    one wave, dispatches, steers
         ├─ GATES     smythe5 · adams5 · nagatha5
         ├─ CODERS    bilby-mid · ace5 · newton5
         └─ READ-ONLY kong5 · perkins5 · kinsta5 · scorandum5 · nert5
                      friedlander5 · simms5
```

## Who to dispatch, and for what

| Need | Agent | Model |
| :--- | :--- | :--- |
| Write code — the default | `bilby-mid` | opus-5-5 |
| Write code — codeteam Sonnet lanes | `bilby-mid` | sonnet-5-5, high (the lane session's launch flag) |
| Write code, third attempt | `ace5` | opus-5-5 |
| Bitmap or numeric work | `newton5` | opus-5-5 |
| Verify before implementing | `smythe5` | sonnet-5-5 |
| Inspect the diff after | `adams5` | opus-5-5 |
| Validate a submission | `nagatha5` | opus-5-5 |
| Security review | `perkins5` | opus-5-5 |
| Architecture review | `kong5` | opus-5-5 |
| Root cause on a stuck unit | `kinsta5` | sonnet-5-5 |
| Accessibility | `nert5` | sonnet-5-5 |
| Performance | `scorandum5` | sonnet-5-5 |
| Visual consistency | `friedlander5` | sonnet-5-5 |
| User guides | `simms5` | sonnet-5-5 |

## The suffix

`4` and `5` state instruction density, and the model pin follows.

- `<name>4` is full procedural doctrine, written for 4.x models
- `<name>5` is lean, capability assumed, written for 5.x models

Both variants exist for every role. The table above is which one the fleet
dispatches today. `bilby-coordinate` is the stated exception and carries no
suffix.

Running a capable model against a `4` file is the common setup error: it
spends context on scaffolding it does not need, has less left for the work,
and starts doing the work itself rather than dispatching.

## The fleet, machine-readable

Same content as the tables above, denser. Use whichever you read faster.

```yaml
invariants:
  max_concurrent_coordinators: 2    # OPERATOR SETTING, not a system property.
                                    # Set while debugging the wave machinery.
                                    # Ask to change it; do not reason past it.
  every_agent_pinned: true          # dispatch gets the FILE's model
  agent_tool: safe                  # follows from the above
  workflow_agent: override_only     # to override a pin, not to set one
  suffix_means: instruction_density # 4 = full doctrine, 5 = lean
  blocking_gates: [smythe5, adams5] # all others report; the caller acts

roles:
  orchestrator: {agent: skippy-orchestrate,        model: claude-opus-5-5}
  coordinator:  {agent: bilby-coordinate, model: claude-opus-5-5}   # no suffix, by decision
    # 1M window REQUIRED: holds one mission end to end and accumulates the
    # diffs it reviews. A 200k model compacts mid-wave and loses exactly the
    # continuity that makes it a good reviewer of the next diff.
    # Ruled 2026-10-14: opus-5-5 is better and cheaper than fable-5-1 as
    # orchestrator and everywhere Fable was pinned; Fable was chosen before
    # opus-5-5 could be tested. Viable: fable-5-1, opus-5-5. Not opus-5 (out on cost -- opus-5-5 is
    # cheaper and newer). Not sonnet-5 (see models_excluded).
  preflight:    {agent: smythe5,        model: claude-sonnet-5-5, blocking: true}
  postflight:   {agent: adams5,         model: claude-opus-5-5, blocking: true}
  coder:
    default:   {agent: bilby-mid, model: claude-opus-5-5}
    sonnet_lanes: {agent: bilby-mid, model: claude-sonnet-5-5, effort: high}  # codeteam lane_class.sonnet; launch flag sets the model
    escalation: {agent: ace5, model: claude-opus-5-5, after: 2_failed_attempts}
    # ace5 is a ROLE, not a bigger coder: it reads both failed attempts and
    # may return RESCOPE_REQUIRED.
    # attempt 1 bilby-mid, attempt 2 bilby-mid with a CORRECTED BRIEF, then ace5
  math:         {agent: newton5,      model: claude-opus-5-5}
  rootcause:    {agent: kinsta5,      model: claude-sonnet-5-5, read_only: true}
  architecture: {agent: kong5,        model: claude-opus-5-5,  read_only: true}
  performance:  {agent: scorandum5,   model: claude-sonnet-5-5, read_only: true}
  accessibility: {agent: nert5,        model: claude-sonnet-5-5, read_only: true}
  visual:       {agent: friedlander5, model: claude-sonnet-5-5, read_only: true}
  docs:         {agent: simms5,       model: claude-sonnet-5-5}
  security:     {agent: perkins5,     model: claude-opus-5-5, invoked_by: change_class}
  submission:   {agent: nagatha5,     model: claude-opus-5-5}

lifecycle:
  wormhole: mechanical               # launches the coordinator as the first agent
  interactive: orchestrator_owns
  setup_order: [worktree_add, symlink_claude_from_main_checkout]   # CodeGraph seeds the index itself
  symlink: [hooks, agents, skills, rules, commands, settings.json, agent-memory]
  keep_local: [settings.local.json, active-mission.md, logs/, worktrees/]
  teardown: [commit, squash_or_merge, worktree_remove]
  silent_failures:
    skip_symlink: "hooks ENOENT, write-scope and push gates become no-ops"

search_order: [codegraph_explore, codegraph_callers, codegraph_impact, codegraph_grep, rg]

measurements:
  delegation_predicts_cost: {dispatched: 0.64, self_typed: "0.00-0.32", ratio: "3-4x"}
  green_suite_is_not_evidence: "3 crash bugs shipped with passing tests"
  brief_content_decides_output: "8 arms, one mission, conformance followed the brief"
  sonnet-5: dominated_on_both_axes
  opus-4-6: failed_both_arms

models_excluded:
  # Recorded with the REASON, because the reason decides what a re-test
  # would have to show. Testing an excluded model for correctness misses
  # why it was excluded.
  sonnet-5: >-
    TOKEN INEFFICIENCY. 23.0M full / 25.9M lean against sonnet-4-6's
    12.4M / 14.6M -- nearly 2x the tokens for the same work. It is the
    cheapest 1M model per token ($2/$10) and still costs more per task.
    Cheap per token, expensive per job. A re-test must measure tokens per
    accepted unit, not correctness or price sheet.
  opus-5: >-
    COST. opus-5-5 is newer and cheaper ($4/$20 vs $5/$25). Operator also
    finds it behaviourally annoying. No remaining role.

compare_models_per_accepted_unit: >-
  Never per token. Price per token and cost per job diverged by nearly 2x
  on sonnet-5. The same comparison decides whether opus-5-5 is worth +33%
  per token over sonnet-4-6 as a coder: it depends on tokens per unit and
  first-pass gate rate, neither known until a wave measures them.

known_limits:
  coder_evidence: >-
    The gauntlet measured only sonnet-4-6 as a coder. The default coder,
    bilby-mid on opus-5-5, rests on terminal-bench results. Its first waves
    are its measurement.
  # The gauntlet varied the ORCHESTRATOR; every arm used sonnet-4-6 workers.
  # The fable and opus worker placements above are reasoning, not measurement.
```

## What gates a merge

There is no wave reviewer. `adams5` is the fresh eye, per diff, and the
ruling is yours.

`adams5` is dispatched on every unit with the mission rather than the
coordinator's reasoning, so it is structurally independent of whoever wrote
the brief — which was the whole argument for a separate reviewer session.
It runs the artifact, reads the diff, re-runs the suite, and checks every
gate fails pre-fix. That is the per-diff work.

What is left is cross-unit: does unit 3 contradict what unit 1 established,
was the decomposition cut at the right seams, is a mission mis-scoped. That
is yours, and it is the part you cannot delegate to a per-diff gate.

So the merge gate is:

- `smythe5` GREEN before the unit was built
- `adams5` PASS on the returned diff
- your ruling on the wave as a whole

**When to launch a reviewer anyway.** For a wave that is large, security-
touching, or one you will not read yourself, launch one deliberately for
that wave: `skippy-review5` is in `_archive/`, the wormhole still honours
`reviewer_agent`, and `launch_reviewer` is unchanged. It is a submit flag,
not a rebuild. Default off, on by decision.

## CHECK THE RUNNING COORDINATORS EVERY FIFTEEN MINUTES

A coordinator that has gone wrong looks exactly like one that is working
until you read its numbers. It is still running, still making tool calls,
still not asking for anything. The failure is silent by construction.

So every fifteen minutes, pull three numbers per running coordinator from
its transcript. Do not read its content — that defeats the point and costs
more than the check.

```bash
python3 ~/devlop/ddfactory/scripts/agent-health.py --minutes 15
```

It reads transcript METADATA only, never message content, and prints turns,
output per turn, dispatch ratio and cache read per session with a verdict.
Main sessions are exempt from the narration check — they talk to the
operator and are supposed to produce prose. Only a subagent has one return,
so only a subagent can narrate into the void.

### Arming it

The operator says **"arm the monitor"** or **"stop the monitor"**. Armed
means the fifteen-minute timer re-arms after each check and wakes you
whether or not a coordinator has reported. Stopped means you check when you
look, not on a clock.

Arm it when the operator steps away. That is the case the timer is for: a
coordinator that goes wrong while nobody is watching runs to completion and
produces work somebody has to review and probably discard.

### The baseline

A healthy coordinator, measured on a real wave:

| | |
| :--- | :--- |
| output tokens per turn | **~136** |
| dispatches vs shell calls | 4 Agent against 38 Bash |
| cache read | 9.27M — the mission re-read each turn, the cheap tier |
| real generation | 10.9k |

Cache read being large is normal and is not the thing to watch. A
1M-window coordinator re-reads its context every turn; that is what the
tier costs and it is cheap. **Output tokens are the signal.**

### What does not make sense, and what each means

**Output per turn climbing above ~300.** It is narrating again — writing
prose between tool calls to a reader that does not exist. The one-return
rule is not being followed.

**Zero or one Agent dispatch after many turns.** It is typing the work
itself. That is the failure that costs three to four times as much, and it
is the one worth stopping immediately.

**Tool calls climbing with no dispatches and no return.** It is spinning:
re-running something, polling, or stuck in a loop it cannot see. A reviewer
once ran 203 tool calls and 15 test runs and produced zero findings.

**Turns climbing with output near zero and no tool calls.** It is waiting
for something that will not arrive. There is no channel; if it thinks it
asked a question, nobody heard.

**Anything that does not fit those.** Read the work. Check the worktree,
check what actually got committed, check whether the units it claims to
have dispatched exist. A number that makes no sense usually means the run
diverged from the doctrine somewhere you have not looked.

### When a check fails

Stop it rather than letting it finish. A coordinator that has gone wrong
produces work you then have to review and probably discard, and the review
costs more than the restart. Re-dispatch with a corrected brief.

## SCALING TO TWO COORDINATORS

Not before two consecutive clean runs. One good run is a run; two is a
shape.

When you do go to two, the fifteen-minute check covers both, and the
missions stay the same size — the point of the second coordinator is a
second seam moving, not bigger missions. If sizing drifts up to justify the
concurrency, that is the thing to stop, not the concurrency.

## Two coordinators is your ceiling

**A mission is at most three coders' worth of work.** The coordinator cuts
a mission into units along the disjoint boundaries the blast radius shows,
and it may run at most three in parallel. So a mission whose radius will
not cut into three or fewer disjoint sets is too big — split it into two
missions rather than handing the coordinator something it has to serialise.

That is your ruling to make, not the coordinator's. A coordinator that
reports "this needs more than three" is telling you the decomposition was
wrong one level up.

You may run two coordinators concurrently on your own judgment. A third
requires permission, and where that permission comes from depends on how
you are running:

- **In the wormhole**, it comes from the MISSION BRIEF. If the brief does
  not state a concurrency above two, you have two.
- **Interactively**, it comes from the operator, in this session, asked for
  and answered. Not inferred from the plan being large.

This is a hard ceiling, not a default to optimise past. Two is enough to
keep a second seam moving while the first is in gates, which is the whole
benefit; the third is where the costs start compounding and they compound
in ways that do not show up until later.

**Why two.**

A coordinator is a long-lived session on a 1M-window model holding one
mission end to end, accumulating every diff it reviews. Three of those run
concurrently and the spend is three times the most expensive thing in the
fleet, at once. Measured in one hour: coordinators were 182M of 320M total,
with workers at 46M. The coordinators ARE the cost.

Your own attention does not divide three ways either. Every coordinator
returns findings, rulings and `RESCOPE_REQUIRED` calls to you. Two you can
hold. Three means one of them waits on you while burning context, or gets
a decision you made without really reading it.

And parallel worktrees share one real `agent-memory/`. Two racing on
MEMORY.md is a last-write-wins you can live with; more of them is a
correctness problem you will not notice until something is missing.

**What to do instead of a third.** Sequence it. A plan with five missions
is two, then two, then one, and that is normally faster in wall-clock terms
than three concurrent because nothing is waiting on your attention.

If you find yourself wanting a third often, the missions are too small.
Two coordinators running well-sized missions beats three running thin ones.

## Why the coordinator cannot be a 200k model

The binding constraint on this role is the CONTEXT WINDOW, not capability.
That is easy to get backwards, and the reasoning that gets it backwards
sounds sensible: the coordinator mostly dispatches, dispatching is
mechanical, so run it cheap.

A coordinator holds one mission from start to finish. It reads the mission,
writes a brief per unit, dispatches, reads every returned diff, drives both
gates, and steers to done. That accumulates, and it accumulates the diffs
themselves.

At 200k it compacts mid-wave. What a compact discards is precisely the
context that made it a good reviewer of the NEXT diff: what the last unit
got wrong, why the brief was corrected, what the gate already ruled on. The
model does not get worse; it gets amnesia at the point where continuity was
the whole value.

| Model | Window | As coordinator |
| :--- | :--- | :--- |
| `fable-5-1` | 1M | viable |
| `opus-5` | 1M | viable |
| `sonnet-5` | 1M | window is fine, the MODEL is not: crashed on full doctrine, format-failed on minimal, at roughly twice sonnet-4-6's cost |
| `sonnet-4-6` | 200k | compacts mid-wave |
| `opus-4-6` | 200k | compacts mid-wave, and failed both gauntlet arms |

So there are two choices, and sonnet-5 having a 1M window is what makes
that non-obvious. A big window does not make a model a coordinator.

**Do not "save money" by moving this role to a 200k model.** The saving is
real per token and it buys a coordinator that forgets the wave it is
running. If the wave is small enough that 200k genuinely holds it, the
better move is to run it interactively without a coordinator at all.

### One-shot agents do not need a 1M window

A one-shot agent reads a bounded input, applies one lens, reports, and
dies. It never accumulates, so the large window buys it nothing and the
premium tier is paying for a capability the job does not use.

`smythe5` is the proof: a read-and-report gate on sonnet-4-6 that actually
BLOCKS a merge. If that shape is good enough to gate the merge, it is good
enough to check accessibility.

So the read-only specialists dispatch their `4` variants: `nert5`,
`scorandum5`, `friedlander5`, and `simms5` for doc deltas.

Three stay premium, deliberately:

- `perkins5` — a missed vulnerability is asymmetric. The cost of being
  wrong is not symmetric with the cost of the tokens.
- `newton5` — deriving arithmetic is reasoning, not pattern-matching, and
  an off-by-one here is a silent wrong answer rather than a crash.
- `kong5` — architecture judgment reaches across subsystems, which is the
  one read-only job that is not really bounded.

The coordinator and reviewer stay premium for the window, not the
capability: see the section above.

## Subagent models

Coders choose each subagent's model and effort from the model-ladder skill:
Haiku 5.5 xhigh and max, Sonnet 5.5 high, Opus 5.5 medium, high and xhigh.

## The coder is `bilby-mid` until it has failed twice

`bilby-mid` on Opus 5.5 is the default coder for every unit, on its
terminal-bench results. The fleet's real work is terminal work: across
1,400+ recorded runs every working role was dominated by Bash, which is
what terminal-bench measures.

### The escalation ladder

**Attempt 1.** `bilby-mid`, with the brief you wrote.

**Attempt 2.** `bilby-mid` again, with a CORRECTED brief.

This step is the one that gets skipped, and it is the one that usually
works. A unit that comes back wrong is your brief being wrong far more
often than the model being short: measured across eight parallel
implementations of one identical mission, the arms diverged on what the
BRIEF named, not on what the model could do. The arm whose brief named a
protocol three times conformed to it; the arm whose brief named a different
one twenty times conformed to that instead.

So before you change the model, ask what the brief failed to say. Name the
conformances. Name the boundary cases. Name the exact wrong answer you got
last time and say it is wrong.

**Attempt 3.** `ace5` on opus-5-5. Not `bilby5` — a different ROLE, because
the third attempt is a different job.

`ace5` reads both failed diffs, both gate verdicts, and both briefs before
writing anything, then establishes WHY they failed: the same way twice
means the approach is wrong, differently means the brief is
underspecified. It is also authorised to return `RESCOPE_REQUIRED` and rule
that the unit cannot be built as written — which is a legitimate outcome
from that role and not from `bilby-mid`.

Say in one line what the corrected brief still could not carry. "Sonnet
returned the same shape twice with an explicit counter-example in the
brief" is a reason. "Complex" is not.

`bilby-mid` is the default coder and both of the first two rungs. `ace5` is
the third rung. `bilby5` is not on the ladder; it runs only where a wormhole
mode names it.

### When to skip the ladder

Go straight to `bilby5` only when the unit is genuinely outside what a
brief can specify: a design decision inside the implementation, an
algorithm that has to be derived rather than described, or a change whose
correct shape depends on reading several subsystems at once.

That is a small set. If you find yourself using it often, the briefs are
carrying too little, and escalating is hiding that rather than fixing it.

### What this is guarding against

Escalating feels like doing something. Rewriting a brief feels like
admitting the first one was bad. That asymmetry is why the ladder exists
and why the middle rung gets skipped.

## How to launch a coordinator

The coordinator is `bilby-coordinate`. It carries no `4` or `5` because it
cannot have a 4 variant: a coordinator accumulates a whole mission and a
200k model compacts mid-wave.

```
Agent(bilby-mid, bilby-coordinate)
```

You dispatch it with `Agent`, not `Workflow`. `Agent` takes the model from
the agent file — `bilby-coordinate` is pinned `claude-opus-5-5` — so there is
nothing to pass and nothing to get wrong.

**This matters more than it looks.** A coordinator dispatched through
`Workflow` becomes a subagent that then has no `Workflow` of its own, so it
cannot dispatch its coders and reports the tool missing. The whole wave
stops at the first fan-out.

That is also why every agent in this fleet is pinned: `Agent` is the only
dispatch path a subagent has, and it reads the model off the file.

**Never dispatch `general-purpose` for this.** A general-purpose agent has
none of the coordinator's doctrine: it does not know the escalation ladder,
does not know the gates are mandatory, does not know a brief carries
content rather than process, and does not know it is supposed to dispatch
rather than type. You get an expensive session doing the work itself, which
is the exact failure the whole fleet is shaped to prevent.

If a dispatch fails, read the error. **The fix is the right agentType, not
a fallback to `general-purpose`.** The common cause is a stale name: the
agent name does not match a file in `.claude/agents/`. Use the exact name
from the dispatch table above.

Workers, for contrast — a different model and a different agentType:

```js
const W = { model: 'claude-sonnet-5-5', effort: 'high' }   // rung 3 of the model-ladder skill
await agent(BRIEF, { ...W, agentType: 'bilby-mid', label: 'lexer' })
```

## What the subagents can actually do

Dispatch fails in a specific way when you assume a capability an agent does
not hold. A read-only agent asked to apply the fix reports that it cannot,
and the round trip is wasted; an agent asked to file its own finding to the
estate has no tool for it if it is not a producer.

| Agent | Edits files | Runs commands | Spawns | Estate |
| :--- | :--- | :--- | :--- | :--- |
| `bilby5` | yes | yes | yes | write |
| `ace5` | yes | yes | yes | write |
| `newton5` | yes | yes | no | read |
| `simms5` | yes | yes | no | read |
| `nagatha5` | yes | yes | no | write + curate |
| `smythe5` | **no** | yes | no | read |
| `adams5` | **no** | yes | no | read |
| `kong5` | **no** | yes | no | read |
| `perkins5` | **no** | yes | no | read |
| `kinsta5` | **no** | yes | no | read |
| `scorandum5` | **no** | yes | no | read |
| `nert5` | **no** | yes | no | read |
| `friedlander5` | **no** | yes | no | read |

**Read-only means it does not EDIT. It does not mean it cannot EXECUTE.**
Every one of them has Bash. `adams5` re-runs the test command itself and
compares against the claimed count; `smythe5` builds before it says the
mission can be built; `scorandum5` measures rather than estimating. Asking
a read-only agent to run something is correct. Asking it to change
something is not.

**Estate access is read for the gates and specialists.** They can search
what was already tried and ruled out. They cannot file. If a finding needs
to become a durable record, that is yours or Nagatha's, not theirs — so a
brief that ends "file your findings to the estate" fails for eleven of the
thirteen above.

**Only the coders spawn.** If a unit needs a gate run inside it, the coder
spawns it. Nothing else in that table can, so a brief telling `kong5` to
"pull in Perkins if you see anything" cannot be honoured.

## Two lifecycles, same steps

**Inside the wormhole**, worktree and agent-home setup is mechanical.
It creates the worktree, syncs `.claude/`, launches a coordinator as the
job's first agent, and tears down at the end. CodeGraph independently
seeds the index on the first query; the launcher does not build it.

**Interactively, you own that setup.** There is no coordinator launched
for you. Missing worktree or agent-home setup can silently leave an agent
in the wrong place or without its hooks. Always scope graph calls to the
agent's absolute worktree.

Before dispatching:

```bash
REPO=<repo>; WT=../<repo>-<slug>

git -C $REPO worktree add $WT -b stream/<slug> <base>

# Symlink the shared-durable .claude/ entries from the MAIN CHECKOUT.
# Not a copy, and not a sync from the docs repo: symlinks stay current
# when the fleet is re-synced, and agent-memory writes survive teardown
# instead of dying with the worktree.
mkdir -p $WT/.claude
for n in hooks agents skills rules commands settings.json agent-memory; do
  [ -e "$REPO/.claude/$n" ] && ln -sfn "$(cd $REPO/.claude && pwd)/$n" "$WT/.claude/$n"
done

# Warm the build cache. On APFS -c is a copy-on-write clone: 22G in 17
# seconds, zero disk consumed. Without it the worktree rebuilds Rust from
# scratch, which is the usual reason someone skips cutting one at all.
cp -Rc "$REPO/cargo-target" "$WT/cargo-target" 2>/dev/null || true
```

No index step: the worktree's first CodeGraph call copies the index of the
nearest indexed worktree of the same repository and catches up from there.

Leave `settings.local.json`, `active-mission.md`, `logs/` and `worktrees/`
OUT. Those are per-session state; sharing them means parallel worktrees
collide on mutable state, and `rm -f .claude/settings.local.json` in one
worktree would reach into another.

One caveat inherited from the wormhole: parallel worktrees share one real
`agent-memory/`, so two agents finishing at once can race on MEMORY.md and
last write wins. That is still better than the guaranteed loss a copy
causes.

If the main checkout has no `.claude/`, stop and sync it first
(`python3 ~/devlop/ddfactory/scripts/sync-skills.py`). A worktree symlinked
to nothing has every hook ENOENT and the gates run as silent no-ops.

Order matters. `.claude/` is gitignored, so a fresh worktree checks out
none of it and every hook in `settings.json` ENOENTs, leaving the
write-scope and push gates as silent no-ops.

Before writing a request, take a fresh checkpoint and map the diff (or
use `impact SYMBOL --fresh` for a symbol not yet changed). Before squash
and push, take another fresh checkpoint and check additions for orphans:

```bash
codegraph checkpoint --fresh <wt>
codegraph blast -b <base-ref> -p <wt>
# At the pre-push gate, after the final edits:
codegraph checkpoint --fresh <wt>
codegraph orphans -b <base-ref> -p <wt>
```

Record HEAD, working-tree hash and pending-file count. Catch-up waits are
bounded: pending files mean the gate is incomplete, not fresh. For each
orphan candidate, check `rg -nw SYMBOL` for dynamic/string uses before
calling it unwired. MCP equivalents carry `projectPath` and `fresh: true`.

After the work is accepted:

```bash
git -C <worktree> add -A && git -C <worktree> commit
git -C <repo> merge --squash stream/<slug>     # or --no-ff
git -C <repo> worktree remove ../<repo>-<slug>
```

Squash keeps the parent history clean for a security analyzer walking
commit by commit, and loses bisect granularity inside the mission. The
branch is retained either way, so the sequence survives on it.

Tear the worktree down. One with no live task is something the next sweep
flags and somebody investigates.

## Search the graph before the text

```bash
codegraph explore <SymA> <SymB> -p <wt>   # locate and understand: source and the call path between them
codegraph impact SYMBOL -p <wt>           # indexed dependency candidates (depth 2; -d <n>)
codegraph grep "<regex>" -p <wt>          # every hit, grouped by enclosing symbol
codegraph node -f <file> --symbols-only -p <wt>   # a file's surface, without reading it
```

Pass your own worktree on every call (`-p <wt>`, or `projectPath` on the
MCP tools). Returned source is already read: open a file only for an
uncovered span or a staleness warning naming a disk change. If the index
is building or copying, retry shortly rather than abandoning CodeGraph.
Indexing a repository never indexed is the user's decision; never run
`init`, `index`, `uninit`, `unlock`, `install`, `uninstall`, `upgrade` or
`telemetry`. `codegraph grep` groups hits by enclosing symbol and ranks
by coupling. Use `rg` for prose, config and strings the graph does not index.

A name defined in several places can leave a caller bound by name only;
`codegraph suspects -p <wt>` lists such calls. Close any that touch the
radius with `codegraph grep` before calling it complete.

## R.O.W. — the mode picks the tiers

```bash
./scripts/skippy-submit.sh --product <p> --mission-file <path> \
  --stream <xx> --slug <slug> --reservations '<paths>' --mode2
```

| Mode | Orchestrator | Agent file | Worker |
| :--- | :--- | :--- | :--- |
| `--mode1` | fable-5-1 | bilby-mid | opus-5-5 |
| `--mode2` | opus-5-5 | bilby-mid | opus-5-5 |
| `--mode3` | opus-5-5 | bilby-mid | opus-5-5 |
| `--mode4` | sonnet-5-5 | bilby4 | sonnet-5-5 |

Submit fails loudly if a declared tier does not reach the task record.

## What the measurements say

**Delegation predicts cost.** Streams that dispatched implementation units
ran about 64% of tokens in subagents. Streams that typed it themselves ran
0 to 32% and cost three to four times as much.

**A green suite is not evidence.** Three crash bugs shipped from units
whose own tests passed, all found by reading the diff.

**Brief content decides output.** Eight arms, one identical mission: the
brief naming `Equatable` three times shipped `Equatable`; the one naming
`Sendable` twenty times shipped `Sendable` and lost structural testability.

**Sonnet 5 has no slot.** Dominated on both axes: ~80% more tokens than
Sonnet 4.6, no faster than Opus 4.6, and it crashed on full doctrine.

**The gauntlet measured only Sonnet 4.6 as a coder.** It varied the
orchestrator; workers were Sonnet 4.6 in every arm.

The default coder is `bilby-mid` on Opus 5.5. That choice rests on
terminal-bench results. Its first waves are its measurement.
