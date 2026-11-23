# Runbook: measure what the Knowledge Graph saves

How to compare the same task run by the AI alone and run with the Knowledge Graph's `reuse` mode, and how to read the result. Nothing here is assumed: every figure comes from the savings ledger (E46.6, #780), which copies each run's own counters. Design: [decisions/knowledge-graph.md](../decisions/knowledge-graph.md).

**You need an AI provider key.** The comparison runs real model calls (Settings → AI). Without one, the runs fail before their first step and the ledger has nothing to compare. A scripted comparison without a key is the scenario suite's job, not this runbook's.

## What the ledger records

For every run of a saved task whose effective mode was `learn` or `reuse`, a `kgraph.ledger.write` job (label "Write the Knowledge Graph savings ledger of a run") writes one `kg_ledger` row after the run ended:

| Field | Meaning |
|---|---|
| `mode` | `learn` or `reuse` (a run with the feature off gets no row). |
| `procedureVersionId` | The procedure version the run executed; `null` when none ran. |
| `steps` | Steps by how they ran: `replayed`, `recovered`, `judge`, `agent`. |
| `modelCalls`, tokens | From the usage the runner already records on the run. |
| `costUsd`, `costKnown` | `costKnown: false`: a call could not be priced and the cost is a **lower bound** ("at least"). |
| `activeMs` | The run's active time (waiting for you does not count). |
| `outcome` | `ai_only` (no procedure ran: every `learn` run), `replayed_clean`, `recovered`, `repaired`, `fell_back`. |
| `checksPassed` | Whether the procedure's outcome checks passed; `null` when no procedure ran. |

**Chats and one-off runs (E46.28).** With your everyday switch on (`kgraph.everyday`, "Use what was learned in chats and one-off runs"), a chat or one-off run in which the agent chose `run_procedure` also gets a row: `mode` `everyday`, no task, `steps.replayed` the procedure steps that ran without the model, `outcome` `replayed_clean` while every procedure it ran finished (otherwise `fell_back`) and `checksPassed` `null`. Such a row belongs to no task: it never enters a task's ledger, baseline or saving. `GET /api/kgraph/summary` counts them as `everydayProcedureRuns`.

The job runs after the run's final status is saved and never writes to the run: a ledger failure fails the job (Administration → Jobs), never the run.

**The baseline** of a task is the median of its newest 10 (at most) succeeded AI-only runs: the ledger's `ai_only` rows plus the task's runs from before its first ledger row (before the feature was on). Model calls, cost and active time each have their own median. Until there is one such run the baseline is `null`, and the summary says **"no baseline yet"** and shows no saving.

## Run the comparison

1. Turn the feature on: an administrator sets `kgraph.enabled` in the system settings, and you set yours (Settings, or `PATCH /api/user-settings` with `{ "kgraph": { "enabled": true } }`).
2. Pick one saved task that does the same job every time (the example in the package's tests is `test/fixtures/daily-summary.procedure.json`: search mail, read a value from a page, append a sheet row, send a summary).
3. **Five AI-only runs.** Set the task to `learn` (`PUT /api/tasks/{id}/kgraph` with `{ "mode": "learn" }`) and run it 5 times. Each is an AI-only run with a ledger row (`outcome: ai_only`): together with any earlier runs of the task they make the baseline. A run with the mode `off` is AI only too, but gets no ledger row; it counts toward the baseline only when it finished before the task's first ledger row.
4. **Five reuse runs.** Set the task to `reuse` and run it 5 times, the same way (same inputs, same time of day if the site changes through the day). Until a procedure version is compiled and verified (E46.7–E46.11) a `reuse` run still runs the agent loop and is recorded as `ai_only`.
5. Let the queue finish: every run has a `kgraph.ledger.write` job, normally done within seconds of the run's end.

## Read the result

- `GET /api/kgraph/ledger?taskId=<id>`: the task's rows (newest first, up to 200) and its `baseline`.
- `GET /api/kgraph/summary`: per task, `runs`, `procedureRuns` (runs that executed a procedure), `cleanReplayRate` (`replayed_clean` over procedure runs), `baseline`, `procedureFigures` (the medians of the procedure runs) and `saving` (baseline minus procedure runs; positive is saved).

What to look at:

1. **`baseline` is not null** and its `runs` is at least 5. With `note: "no baseline yet"` there is nothing to compare: run more AI-only runs.
2. **`procedureRuns`** is the number of `reuse` runs that really executed a procedure. Zero: no saving is claimed (`saving: null`), whatever the runs cost.
3. **`saving.modelCalls`** and **`saving.activeMs`** are the headline: fewer model calls and less time per run. A negative value means the procedure runs cost more than the AI alone; say so.
4. **`saving.costKnown: false`**: the baseline or the procedure runs hold a lower-bound cost, so the cost saving is approximate. Report it as "at least" / "about", never as exact.
5. **`cleanReplayRate`** below 1 with outcomes `fell_back` or `repaired`: the procedure needed the agent; the saving is smaller and the repair flow (E46.17) has work to do.

Metrics, for a dashboard rather than one task: `app.kgraph.runs` (labels `mode`, `outcome`) counts ledger rows, `app.kgraph.model_calls_saved` adds the model calls a procedure run did not make against its task's baseline (never counted without a baseline), and `app.kgraph.errors` (label `stage`; `match`: offering saved procedures to a chat or one-off run) counts Knowledge Graph failures that were logged and did not fail the run.

## When something looks wrong

| Symptom | Check |
|---|---|
| A run has no ledger row | Its effective mode was `off` (a switch off, a chat run, "Run with AI only this time"): no `kg_runs` row, so no job. Otherwise Administration → Jobs, type `kgraph.ledger.write`, for its error. |
| The job failed | The run is unchanged by design. Re-running the job is safe: it rewrites the same row. |
| The baseline moves after a deletion | A ledger row is deleted with its run (retention, or by hand), and with it its share of the baseline. |
