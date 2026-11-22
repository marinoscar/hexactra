# Knowledge Graph

The Knowledge Graph (epic E46, [decision record](decisions/knowledge-graph.md), [threat model](security-kgraph.md)) learns how one of your saved tasks is done from your own runs. Later runs replay the learned steps without the model. The AI steps back in only when something no longer matches, and its repair becomes a new version. The aim is runs that are more predictable, faster and cheaper.

**Status: experimental, and off at every level.** A fresh deployment has the deployment switch off, every user's switch off and every task on AI only, so runs behave exactly as before. The engine is the package `@marinoscar/hexactra-kgraph` ([README](../packages/hexactra-kgraph/README.md)).

Four rules hold whatever you turn on:

- **A Knowledge Graph failure never fails a run.** An error in capture, compile, replay, a check or a repair is logged and counted, and the run continues with the agent.
- **Every replayed step goes through the same tool wrapper as the agent's** (`executeTool`). Stop, Pause, the site and risk gates, saved approvals, the trace and intent recording apply exactly as for a step the model chose.
- **The graph grants nothing.** It never widens a task's allowed sites, adds a connection or a recipient, releases a secret or creates a saved approval. A learned procedure still passes every gate on every run.
- **Sensitive changes need you, signed in.** A change that adds or changes a send, a payment, a recipient, a site, an account or a saved login is approved only by you, in the console. A token, an AI app, MCP, the CLI or a webhook cannot approve it.

## The four switches

| Level | Where | Default | Off means |
|---|---|---|---|
| Deployment | Administration → Knowledge Graph (`/admin/settings/kgraph`; the system setting `kgraph.enabled`; `kgraph:admin`) | off | No capture, replay, job, agent tool or MCP tool for anyone. |
| You | Settings → Knowledge Graph (`/settings/kgraph`; your user setting `kgraph.enabled`; `hexactra kgraph on` / `off`) | off | The same, for you. Your administrator must allow it too. |
| Task | The task page's Knowledge Graph control (`PUT /api/tasks/{id}/kgraph`) | AI only (`off`) | That task runs with AI only. |
| Run | AI only for one run | off for audit runs only | That run ignores the procedure. |

**The run level is partial.** The package supports an "AI only this time" flag, but the console's start-run form and `POST /api/tasks/{id}/runs` do not offer it yet (#794). Today a run uses AI only in two cases: when it is an audit run (below), and when its task's procedure is suspended. To run a `reuse` task with AI only now, switch the task to AI only or Learn only first.

Turning a switch off deletes nothing: what was learned is kept and unused. **Delete everything learned** (Settings → Knowledge Graph, or `DELETE /api/kgraph`) removes your procedures, versions, evidence, reviews, task modes and run records, and nobody else's. Chat goals never use the feature; only saved tasks can.

The task control is on the task page and on the task's edit page. It is not on the new-task form yet: save the task first (#794).

## The three modes of a task

- **AI only** (`off`): the task runs as before, and nothing is captured.
- **Learn only** (`learn`): the task runs as before. After each clean, successful run, the run's tool calls are compiled into a candidate procedure, which is never executed.
- **Learn and reuse** (`reuse`): the procedure runs without the model, and the AI repairs it when needed. The first run of a new, restored, repaired or imported version is a **verification run**: it asks you before every step that sends or pays, whatever the task's confirmation setting and saved approvals say. After one clean verification run, the version becomes the task's active one.

## What happens in a reuse run

1. The procedure runs before the agent loop, inside the same run, lease and budgets. Its steps go through the agent's tool wrapper. Browser actions are paced like a person by default (the deployment's `kgraph.pacing`) and wait for the page rather than the clock.
2. When a step does not match, a recovery ladder tries, in order:
   - wait again;
   - an interrupt: repeat the cookie choice your own run made on that site, close a pop-up, or sign in again with the saved login your run used (a "blocked" page is never automated);
   - find the element again from its fingerprint (exactly one visible match, or nothing);
   - one small model call to locate it, never for a step that sends or pays, and at most 3 per run.
3. Anything else hands the run to the agent, with one line in its log saying which step did not match. When the agent has finished the broken part and the next part's page is there, the procedure resumes, up to 3 times per run.
4. A replay that finishes with a missing, mistyped or implausible output does not count as a success: the agent checks and corrects the result.
5. Inside a `reuse` run, the agent also gets `procedures_list` and `run_procedure`, so it can call another of your **active** procedures as a sub-step (one level deep, every step through the same wrapper).

The run page has a **Knowledge Graph** panel (`GET /api/kgraph/runs/{runId}`). It shows the run's mode and outcome, and which procedure steps were replayed, recovered, judged (one small model call) or done by the agent.

## What is learned, and what is never stored

**Learned:**

- which tools were called;
- where each argument came from: a task parameter, an earlier result, a fixed structural value (a URL, a selector, an option), words from your goal, or the model;
- what the page or the result looked like afterwards: host and path, a structure digest, a result's shape;
- element fingerprints: role, label, tag, an anchor and selector candidates.

A value the model produced becomes a small "judge" step with a fixed answer form, or the step stays with the agent. These always stay with the agent: raw screen coordinates without element facts, model-written JavaScript and desktop actions.

**Never stored:**

- what you typed;
- passwords, handoff codes and one-time codes;
- tokens, and card or account numbers;
- page text and screenshots;
- the model's reasoning.

A value that matches the console's sensitive patterns is withheld, and that step stays with the agent. A saved login, identity or card is referenced by its label. A sensitive task parameter is kept by name only.

## Repairs and reviews

When the agent finishes a run the procedure could not, the finished run is compiled as a proposed version and compared with the old one:

- **Structural** (a moved or relabelled button, another path on a site it already uses, an extra ordinary step): it is verified on its next run and then used.
- **Sensitive** (it adds or changes a send, a payment, a recipient or destination, a site, an account or an added tool, or a saved login, or it lets a model call decide part of a send): it waits for your review. The task keeps its old version meanwhile, and a review never pauses a run.

Reviews are on the Knowledge Graph page's **Reviews** tab and in the Inbox's Suggestions. Each change is listed in plain, masked words. Only you, signed in to the console in a browser session, can approve or decline (`POST /api/kgraph/reviews/{id}/answer`). Every other credential gets `403 KGRAPH_REVIEW_CONSOLE_ONLY`. A declined change is not proposed again for 30 days, and an unanswered review expires after 7 days without being approved.

## Protection, restore and forget

- **Circuit breaker.** A procedure is suspended when it fails 3 times in a row (`kgraph.suspendAfterFailures`), when more than half of its last 10 runs needed the agent, or when an outcome check fails before it has 3 clean runs. The task then runs with AI and you are notified once.
- **Audit runs.** Every Nth run of a `reuse` task (`kgraph.auditEvery`, default 10; 0 never) runs with AI only. It is compared with the procedure and recorded as the baseline.
- **Restore** (the procedure page, `hexactra kgraph restore`, `POST /api/kgraph/procedures/{id}/restore`) brings back a retired or suspended version as a new candidate copy, and the other usable versions retire. Its next run is a verification run.
- **Forget** (the procedure page, `hexactra kgraph forget`, `POST …/forget`) retires every version (kept for history), and the task learns again from its next successful run.
- **Switch this task to AI only** (the procedure page) sets the task's mode to `off`.

## The Knowledge Graph page

`/kgraph` appears in the navigation only while the deployment's switch and yours are both on. It has four tabs:

- **Procedures**: each procedure with its state, health and its savings against AI only.
- **Map**: see below.
- **Reviews**: changes waiting for you.
- **History**: versions and a readable diff of each.

`/kgraph/procedures/:id` shows one procedure: its steps in order, each with its kind, tool, target, whether it uses AI, its health and where each argument comes from; its parameters, sites, accounts and saved logins (by label); its versions; and Restore, Forget and Switch this task to AI only.

## The Map

The Map tab (`/kgraph?tab=map`, `GET /api/kgraph/graph`) draws **what the agent has learned to do reliably**. It is not everything the agent can do: with your full powers, the agent can use any site and any connected account, learned or not.

- Every task, site and account starts as one node. A task expands into its steps, parameters and outputs, and an account into its tools and saved logins.
- Edges: **uses** faint, **then** solid, **feeds** dashed.
- A node's border shows its health, with words beside it. A suspended procedure has a pause icon. Connected accounts, added MCP tools and saved logins that no procedure uses yet are faint with a dashed border.
- You can filter by type, search, focus on one task, and ask "what uses this site".
- Above 500 visible nodes the Map drops its expansions and says so. The API folds and pages above 2,000 nodes.
- The canvas is offered from 768 px wide. Below that, the tab shows a note and a link to the Procedures list.
- Every node is also a button in the list under the canvas, and the side panel does everything the canvas does, so the Map can be used without the canvas.

**Known gaps** (#795): an expanded site shows the steps done on it, not its screens. Keyboard use goes through the node list and the side panel, not the canvas itself.

## The savings ledger

Each run with the feature on records its model calls, tokens, cost and active time, and how its steps ran. These are compared with the task's AI-only baseline: the median of its newest 10 (at most) successful AI-only runs.

- The Procedures tab shows the ledger summary.
- `GET /api/kgraph/ledger?taskId=` gives the rows, and `GET /api/kgraph/summary` the per-task totals.
- With no baseline yet, it says so and claims no saving. A cost that could not be priced is a lower bound ("at least").

How to measure a live comparison: [runbooks/kgraph-measurement.md](runbooks/kgraph-measurement.md).

**Not measured yet.** The live comparison of AI only against reuse has not been run for this release: there was no AI provider key in the session that prepared it. No saving is claimed until it is measured.

## Storage and the load test

Knowledge Graph data lives in new `kg_` tables in the console's own PostgreSQL, behind the package's store port. No new service is required.

The E46.4 load test met its bars for the run-time queries, by a wide margin. Reading one owner's whole graph missed: the heavy owner's Map-columns read had a warm p95 of 2,104 ms (2,083 ms with covering indexes, not kept) against a bar of 2,000 ms. Most of that time is the API turning rows into objects, not the database. **The owner accepted the miss (2026-11-22):** the Map's view folds and pages above 2,000 nodes ([decision record](decisions/knowledge-graph.md#load-test-2026-11-22)).

## Upkeep

A daily job prunes traces and old versions, removes orphans, merges duplicate elements and refreshes health. It also retires procedures not run for `kgraph.retentionDays` (default: kept). An administrator can run it now with `POST /api/kgraph/admin/upkeep`; there is no button for it in the web app yet. See [runbooks/kgraph-upkeep.md](runbooks/kgraph-upkeep.md).

## Export and import

Export and import go through the REST API only. There is no page or CLI command for them yet.

- **Export:** `GET /api/kgraph/export?procedureIds=` (`kgraph:read`; all active procedures when omitted) downloads `hexactra-kgraph-<yyyymmdd>.json` (`kind: "hexactra.kgraph"`, `formatVersion: 1`; schema in `packages/hexactra-kgraph/docs/schema.md`, "TransferFile"). Each procedure carries its task's name, goal, parameters and outputs, and its active version's steps, edges, checks and element fingerprints.
  - **Never exported:** ids of users, runs, tasks, chats, procedures or versions; connection ids or tokens (an account becomes its provider and a placeholder such as `account-1`); saved-login ids (a saved login is its label); evidence; traces; a literal that looks like a secret (it becomes a sensitive task parameter you fill in).
- **Import:** `POST /api/kgraph/import` (`kgraph:write`) with `{ file, accounts?, attach? }`.
  1. The file is validated: shape, format version and limits (1 MB, 50 procedures, 500 steps each). A malformed file, a newer `formatVersion` or an over-limit file is refused with `400 KGRAPH_IMPORT_INVALID`, and nothing is imported. An older format version is read.
  2. You map each exported account yourself (`accounts: { "account-1": "<your connection id>" }`); nothing is matched by name. A procedure with an unmapped account is skipped, with its reason.
  3. Each procedure is attached to one of your tasks (`attach: { "0": "<task id>" }`), or to a new task created in `learn` mode with your defaults. An import never sets allowed sites, adds a connection to a task or creates a saved approval.
  4. It is stored as a candidate with `change_class: sensitive` and a review of the whole procedure. It is never replayed before you approve it, signed in to the console, and its first run is then a verification run.

## For other agents: MCP

While the deployment's switch and yours are both on, the console's MCP server lists three more tools ([mcp.md](mcp.md), "Learned procedures"):

- `procedures_list` and `procedure_get` (scope `procedures:read`);
- `procedure_run` (scope `procedures:run`): it starts an ordinary run of an active procedure's task, which must be in `reuse` mode, and returns the run id at once. A sensitive parameter is never accepted from the caller.

While either switch is off, the tools are not listed. Nothing over MCP creates, changes, approves, restores, forgets, exports or imports a procedure, or changes a switch.

**Not verified** (#796): the agent-framework recipes for Hermes, OpenClaw and Pi were not run against these tools (their smoke test needs those frameworks' CLIs, which were not installed). No test checks the OAuth consent screen itself with the switch off; only `tools/list` is checked.

## The CLI

`hexactra kgraph`:

| Command | What |
|---|---|
| `status [--json]` | Whether it is on: your administrator, you, and both. |
| `list [--task <id>] [--state <state>] [--search <text>] [--json]` | Your procedures with state, health and clean-replay rate. |
| `show <procedure> [--json]` | One procedure as its ordered steps (an id, an id prefix, or a procedure or task name). |
| `versions <procedure> [--json]` | Its versions, newest first. |
| `restore <procedure> <version>` | Bring back a retired or suspended version (by number or id); its next run asks before every step that sends or pays. |
| `forget <procedure>` | Retire every version; the task learns again. |
| `on`, `off` | Your own switch (what was learned is kept). |

The CLI cannot answer reviews, read the ledger, export or import, or set a task's mode. `hexactra tasks run <task>` runs a task, which replays its procedure in `reuse` mode.

## API

From the controllers in `apps/api/src/kgraph/`. While the deployment's switch or yours is off, a read answers with the stored data and `enabled: false`. Restore, forget and setting a task's mode answer `409 KGRAPH_OFF`. Delete everything learned, export, import, the reviews and the admin routes answer whatever the switches.

| Method and path | Permission | What |
|---|---|---|
| `GET /api/kgraph/status` | `kgraph:read` | The deployment switch, your switch, and whether both are on. |
| `DELETE /api/kgraph` | `kgraph:write` | Delete everything learned (yours only). |
| `GET /api/tasks/{id}/kgraph` | `kgraph:read` | A task's mode (`off`, `learn`, `reuse`) and whether it is available. |
| `PUT /api/tasks/{id}/kgraph` | `kgraph:write` | Set a task's mode: `{ "mode": "learn" }`. |
| `GET /api/kgraph/procedures?taskId=&state=&q=` | `kgraph:read` | Your procedures with state, health, step count and ledger summary (newest first, at most 200). |
| `GET /api/kgraph/procedures/{id}` | `kgraph:read` | One procedure: its active (else newest) version as an ordered step list, its parameters and outputs. |
| `GET /api/kgraph/procedures/{id}/versions` | `kgraph:read` | Its versions, newest first, with state, change class, health and evidence. |
| `GET /api/kgraph/procedures/{id}/versions/{number}` | `kgraph:read` | One version as an ordered step list. |
| `GET /api/kgraph/procedures/{id}/versions/{number}/diff?against=` | `kgraph:read` | What changed, step by step in plain words. |
| `POST /api/kgraph/procedures/{id}/restore` | `kgraph:write` | Restore a retired or suspended version as a new candidate. |
| `POST /api/kgraph/procedures/{id}/forget` | `kgraph:write` | Retire every version. |
| `GET /api/kgraph/graph?taskId=&site=&types=&cursor=` | `kgraph:read` | The Map's view model: nodes, edges, clusters, unused capabilities; folded and paged above 2,000 nodes. |
| `GET /api/kgraph/runs/{runId}` | `kgraph:read` | How a run used the Knowledge Graph. |
| `GET /api/kgraph/reviews?status=` | `kgraph:read` | Reviews (`pending`, `approved`, `declined`, `expired`). |
| `GET /api/kgraph/reviews/{id}` | `kgraph:read` | One review. |
| `POST /api/kgraph/reviews/{id}/answer` | `kgraph:write`, and a signed-in browser session | `{ "approve": true }` or `false`. Any other credential: `403 KGRAPH_REVIEW_CONSOLE_ONLY`. |
| `GET /api/kgraph/ledger?taskId=` | `kgraph:read` | A task's ledger rows and its AI-only baseline. |
| `GET /api/kgraph/summary` | `kgraph:read` | Savings per task. |
| `GET /api/kgraph/export?procedureIds=` | `kgraph:read` | A `hexactra.kgraph` file (an attachment, not wrapped in `data`). |
| `POST /api/kgraph/import` | `kgraph:write` | Import a file: `{ file, accounts?, attach? }`. |
| `GET /api/admin/kgraph/settings` | `kgraph:admin` | The deployment settings: `enabled`, `auditEvery`, `suspendAfterFailures`, `retentionDays`, `pacing`. |
| `PUT /api/admin/kgraph/settings` | `kgraph:admin` | Change them (the fields sent change). |
| `POST /api/kgraph/admin/upkeep` | `kgraph:admin` | Enqueue the upkeep job now (`202`). |

Your own switch is the user setting `kgraph.enabled` (`PATCH /api/user-settings` with `{ "kgraph": { "enabled": true } }`). The deployment switch is also in the `kgraph` namespace of the system settings.

## Known gaps

- **The start-run form** has no "AI only this time" option, and the API has no such field (#794).
- **The new-task form** has no Knowledge Graph control; set the mode after saving (#794).
- **The procedure pages** draw a branch or a loop as a flat list, without indenting. They do not show a step's tool family or a version's source (whether it was compiled or imported), and the procedures list has no "last success" (#794; each needs an API field first).
- **The Map** shows a site's steps, not its screens, and the canvas itself is not keyboard-driven (#795).
- **The framework recipes** for Hermes, OpenClaw and Pi are not verified, and the consent screen with the switch off is not tested (#796).
- **Export, import and upkeep** have no page or CLI command.
- **The live AI-only vs reuse comparison** is not measured.
- **The E46.4 heavy-owner Map query** missed its bar (2,104 ms against 2,000 ms warm p95). The owner accepted it; the Map's view folds and pages above 2,000 nodes.
