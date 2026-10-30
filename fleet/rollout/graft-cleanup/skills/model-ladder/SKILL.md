---
name: model-ladder
description: Which model and effort to give each subagent you dispatch. Use whenever you launch a subagent with Workflow agent() — pre-flight, post-flight, documentation, comment trim, tests, inventories, escalation.
---

# Model ladder

You run on the model your lane pins. Each subagent you dispatch gets its own
model and effort, chosen from this ladder: the lowest rung that the task's row
names. Measured on Terminal-Bench 4.0, cost per task, October 2026.

| Rung | Model | Effort | Score | Cost per task | Use for |
|---|---|---|---|---|---|
| 1 | claude-haiku-5-5 | xhigh | 29.3% | $0.46 | Comment trim (trim5, one per port), mechanical renames, formatting |
| 2 | claude-haiku-5-5 | max | 32.8% | $0.65 | Running tests and sorting failures, inventories with codegraph and rg, summarising logs into a report, pre-flight on a single-file unit |
| 3 | claude-sonnet-5-5 | high | 43.9% | $2.19 | Pre-flight on larger units, documentation (simms5), read-only specialists (kinsta5, scorandum5, nert5, friedlander5), code units in a Sonnet lane |
| 4 | claude-opus-5-5 | medium | 52.5% | $4.04 | Post-flight (adams5), architecture (kong5), security (perkins5), code units in an Opus lane |
| 5 | claude-opus-5-5 | high | 56.6% | $5.12 | Escalation (ace5), math (newton5) |
| 6 | claude-opus-5-5 | xhigh | 59.6% | $8.78 | A unit outside what a brief can specify (bilby5): a derived algorithm, a design choice inside the implementation, a change that needs several subsystems read together |

## How to dispatch

Workflow `agent()` takes the model and effort on every call. Spread one rung
constant per call:

```js
const R1 = { model: 'claude-haiku-5-5',  effort: 'xhigh' }
const R2 = { model: 'claude-haiku-5-5',  effort: 'max' }
const R3 = { model: 'claude-sonnet-5-5', effort: 'high' }
const R4 = { model: 'claude-opus-5-5',   effort: 'medium' }
const R5 = { model: 'claude-opus-5-5',   effort: 'high' }
const R6 = { model: 'claude-opus-5-5',   effort: 'xhigh' }

await agent(BRIEF, { ...R1, agentType: 'simms5',  label: 'trim-batch-3' })
await agent(BRIEF, { ...R4, agentType: 'adams5',  label: 'post-flight' })
```

## Moving up

1. Start on the rung the task's row names.
2. Check every result yourself. A result that falls short goes one rung up,
   with a brief corrected to name exactly what fell short.
3. Post-flight runs on rung 4 or higher.
4. Record the rung of each dispatch in your feature report, with the result:
   accepted, or sent up.
