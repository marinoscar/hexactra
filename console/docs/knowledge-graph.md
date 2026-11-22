# Knowledge Graph

The Knowledge Graph (epic E46, [decision record](decisions/knowledge-graph.md), [threat model](security-kgraph.md)) learns how one of your saved tasks is done from your own runs, then replays it without the model; the AI steps back in only when something no longer matches, and its repair becomes a new version. The goal: runs that are more predictable, faster and cheaper.

## Off until you turn it on

| Level | Where | Default | Off means |
|---|---|---|---|
| Deployment | Admin → Knowledge Graph (`kgraph.enabled`, `kgraph:admin`) | off | No capture, replay, job, agent tool or MCP tool. |
| You | Settings → Knowledge Graph (`kgraph.enabled`) | off | The same, for you. |
| Task | The task's Knowledge Graph choice (`PUT /api/tasks/{id}/kgraph`) | AI only (`off`) | That task runs with AI only. |
| Run | "Run with AI only this time" | — | That run ignores the procedure. |

Turning any switch off deletes nothing: what was learned is kept and unused. **Delete everything learned** (`DELETE /api/kgraph`) removes it. Chat goals never use the feature; only saved tasks can.

## The three modes of a task

- **AI only** (`off`): runs as before; nothing is captured.
- **Learn only** (`learn`): runs as before; each successful run is captured and compiled into a candidate procedure, which is never executed.
- **Learn and reuse** (`reuse`): the procedure runs without the model. Its first run is a **verification run**: it asks you before every step that sends or pays, whatever the task's confirmation setting and saved approvals say. After one clean run it becomes the task's active version.

## What happens in a reuse run

1. The procedure's steps run through the same tool wrapper as the agent's (Stop, Pause, the site and risk gates, saved approvals and the trace apply exactly as for the agent), at a human pace, waiting for the page rather than the clock.
2. When a step does not match, a recovery ladder tries: wait again, handle a cookie banner you answered before / a pop-up / an expired session, find the element again from its fingerprint, and (never for a send or a payment) one small model call to locate it.
3. Anything else hands the run to the agent with a note in its log. When the agent has done the broken part and the next part's page is there, the procedure resumes (up to 3 times per run).
4. A replay that finishes with a missing, mistyped or implausible output does not count as a success: the agent checks and corrects the result.

## What is learned, and what is never stored

Learned: which tools were called, where each argument came from (a task parameter, an earlier result, a fixed structural value, or the model), what the page or the result looked like afterwards (host and path, a structure digest, a result's shape), and element fingerprints (role, label, selector candidates, an anchor).

Never stored: what you typed, passwords, handoff codes, tokens, card or account numbers, page text, screenshots, the model's reasoning. A secret-looking value is withheld; a saved login is referenced by its label.

## Repairs and reviews

When the agent finishes a run the procedure could not, the difference becomes a proposed version:

- **Structural** (a moved or relabelled button, a new path on known sites): it is verified on its next run and then used.
- **Sensitive** (it adds or changes a send, a payment, a recipient, a site, an account or a saved login): it waits for your review (`GET /api/kgraph/reviews`). Only you, signed in to the console, can approve or decline: not a token, an AI app or MCP. Declined changes are not proposed again for 30 days; unanswered reviews expire after 7 days. The task keeps its old version meanwhile.

## Protection, restore and forget

- **Circuit breaker:** 3 failures in a row (`kgraph.suspendAfterFailures`), more than half of the last 10 runs needing the agent, or a failed outcome check early on suspends the procedure; the task runs with AI and you are notified once.
- **Audit runs:** every Nth run (`kgraph.auditEvery`, default 10; 0 never) runs with AI only and is compared with the procedure.
- **Restore** (`POST /api/kgraph/procedures/{id}/restore`) brings back a retired or suspended version (verified again before use); **Forget** (`…/forget`) retires every version so the task learns again.

## Savings ledger

Each run with the feature on records its model calls, tokens, cost and active time by mode against the task's AI-only baseline (the median of its last AI-only runs): `GET /api/kgraph/ledger?taskId=` and `GET /api/kgraph/summary`. With no baseline it says "no baseline yet" and claims no saving. How to measure a live comparison: [runbooks/kgraph-measurement.md](runbooks/kgraph-measurement.md).

## Upkeep

A daily job prunes traces and old versions, retires procedures not run for `kgraph.retentionDays`, removes orphans and merges duplicate elements: [runbooks/kgraph-upkeep.md](runbooks/kgraph-upkeep.md).

## Export and import (E46.23)

- **Export:** `GET /api/kgraph/export?procedureIds=` (`kgraph:read`) downloads `hexactra-kgraph-<yyyymmdd>.json` (`kind: "hexactra.kgraph"`, `formatVersion: 1`, schema in `packages/hexactra-kgraph/docs/schema.md`, "TransferFile"). Each procedure carries its task's name, goal, parameters and outputs, and its active version's steps, edges, checks and element fingerprints.
  - **Never exported:** ids of users, runs, tasks, chats, procedures or versions; connection ids or tokens (an account is its provider and a placeholder such as `account-1`); saved-login ids (a saved login is its label); evidence; traces; a literal that looks like a secret (it becomes a sensitive task parameter you fill in).
- **Import:** `POST /api/kgraph/import` (`kgraph:write`) with `{ file, accounts?, attach? }`.
  1. The file is validated (shape, format version, limits: 1 MB, 50 procedures, 500 steps each). A malformed file, a newer `formatVersion` or an over-limit file is refused with `400 KGRAPH_IMPORT_INVALID` and nothing is imported; an older format version is read.
  2. Each exported account must be mapped by you (`accounts: { "account-1": "<your connection id>" }`); nothing is matched by name. An unmapped procedure is skipped with its reason.
  3. It is attached to one of your tasks (`attach: { "0": "<task id>" }`), or a new task is created in `learn` mode with your defaults: an import never sets allowed sites, adds a connection to a task or creates a saved approval.
  4. It is stored as a candidate with `change_class: sensitive` and a review of the whole procedure. It is never replayed before you approve it (signed in to the console), and then its first run is a verification run that asks before every step that sends or pays.
