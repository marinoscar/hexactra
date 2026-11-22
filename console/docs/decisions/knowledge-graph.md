# Decision record: the Knowledge Graph (epic E46, #770)

**Status:** accepted and built (E46.1 to E46.24, on the integration branch `epic/e46-kgraph`, merged to `main` by E46.25, #799). Experimental, and off by default at every level. Owner guide: [knowledge-graph.md](../knowledge-graph.md); threat model: [security-kgraph.md](../security-kgraph.md).

## Problem

Every run starts from zero. The model input (`packages/hexactra-agent/src/input-builder.ts`) carries the goal, the owner's memories, chat context and this run's log, and nothing from earlier runs. A task that runs every day rediscovers its path every day: one model round per step, with a screenshot each round.

The owner wants runs that are **more deterministic, faster and cheaper**: the AI discovers how to do a job once, the result is captured in a graph, later runs execute it without the model, and the AI steps back in only when something no longer works, then updates the graph.

The model's job changes from *interpreter* (decides every step of every run) to *compiler and repairer* (discovers the path once; returns only when a check fails).

## Decisions

| Topic | Decision |
|---|---|
| Name | Feature: **Knowledge Graph**. Package: `@marinoscar/hexactra-kgraph` in `console/packages/hexactra-kgraph`. One learned, runnable unit: a **procedure**. |
| Optional | Off by default at four levels: deployment (admin), user, task, run. The agent loop stays the default and the fallback. |
| Admin kill switch | An admin can turn the feature off for the whole deployment. Off means no capture, no replay and no tools; the pages are hidden from the navigation and say the feature is off. |
| User opt-out | A user can opt out completely. The user switch is **opt-in** (default off) even after the admin enables the feature. |
| Turning off | Learned data is **kept and unused**. A separate, explicit "Delete everything learned" action removes it. |
| Must not affect what exists | The no-impact contract below. It is an acceptance criterion of every E46 child. |
| Storage | PostgreSQL (the console's own database), behind the package's store port. A graph database is a later binding, decided by a load test (E46.4). No new required service. |
| Reuse | The package is generic: its own README and documentation, ports to the outside, usable by another host. It can be exposed over MCP by any host. |
| Split with the AEF | The console's Knowledge Graph is the owner's **private, per-owner** graph. The Agent Experience Framework (VISION §17) stays the optional, independent, cross-owner layer; it may consume an export. |
| Who updates the graph | The AI may. **Structural** repairs promote themselves after they complete a run. Anything that adds or changes a send, a payment, a recipient, a site, an account or a credential needs the **owner's approval**. |
| Delivery | All E46 work happens on the integration branch `epic/e46-kgraph`; one final PR merges it to `main` (E46.25). |
| In scope | Verified admission, recovery ladder, interrupt handlers, conditions and pacing, outcome checks, circuit breaker and rollback, per-segment reuse, savings ledger, crash safety, procedures as callable tools (agent and MCP), export and import, library upkeep, a graph visualizer. |
| Out of scope | Teaching by demonstration, dry run, a hand editor, a shared marketplace, cross-owner ontology, a graph database. |

## The no-impact contract

Every E46 child proves it.

1. **Off is byte-identical.** With the feature off at any level, a run's instructions, offered tool list and schemas, per-round input, fabric actions, step rows and final run row are identical to `main`. `apps/api/test/runner-characterisation.db.spec.ts` passes **unchanged**; a child that needs to edit it is wrong.
2. **No existing table changes.** New tables only (prefix `kg_`). No column is added to, changed in or removed from an existing table. Per-task and per-run settings live in new tables keyed by `task_id` / `run_id`.
3. **No existing API response changes.** New routes only (`/api/kgraph/...`, `/api/tasks/{id}/kgraph`). Existing responses, the OpenAPI entries of existing routes and existing MCP tools keep their shape.
4. **A Knowledge Graph failure never fails a run.** Any error in capture, compile, replay, check or repair is logged, counted, and the run continues with the agent loop (AI only).
5. **Nothing bypasses the wrapper.** Every tool the executor runs goes through `executeTool` (`packages/hexactra-agent/src/execute-tool.ts`): Stop, Pause, the gates, the trace span and intent recording apply exactly as for a model-chosen call.
6. **The graph never grants anything.** It cannot widen allowed sites, add a connection, release a secret, add a recipient or create a saved approval. The gates read the run's own limits, never the graph.

## Data model

A per-owner graph whose main content is **procedures**.

| Term | Meaning |
|---|---|
| Procedure | A versioned graph of steps for one task. |
| Step | `call` (a tool call with bound arguments), `extract` (read a value from a result), `judge` (one small model call with a fixed output schema), `ask` (the owner is asked; the gates decide when), `check` (a postcondition). Control nodes: `branch` (a guard on observed state) and `foreach` (over a list output). |
| Binding | Where a step argument comes from: a literal, a task parameter, an earlier step's output, or a judge result. |
| Segment | A run of consecutive steps reused or invalidated together. |
| Surface graph | Per site: screens, elements (role, label, selector candidates, anchors) and transitions. Shared by every procedure that uses the site. Browser-specific; lives with the browser toolset. |
| Version states | `candidate` (compiled, never replayed) → `verified` (one clean replay) → `active` → `suspended` (circuit breaker) → `retired`. |
| Modes (per task) | `off` (AI only, nothing captured), `learn` (the AI runs as today; a procedure is compiled and never executed), `reuse` (compiled steps run without the model; the AI repairs). |

Nodes: `Task`, `Procedure`, `ProcedureVersion`, `Step`, `Site`, `Screen`, `Element`, `Account` (a connection reference, never a token), `Tool`, `SecretRef` (a saved login, identity or card reference by label, never a value), `Parameter`, `Output`. Edges: `uses`, `then`, `feeds`, `on`, `transition`, `version_of`.

Package layout:

```
packages/hexactra-kgraph/   generic; imports only zod, @opentelemetry/api, node: built-ins
  src/schema  src/validate  src/compile  src/execute  src/repair  src/ports
  src/view    src/mcp (./mcp)  src/harness (./harness, the only folder that imports the harness)
  src/testing (./testing)
packages/hexactra-browser-agent/   the surface graph, element re-resolution, interrupt handlers, pacing
apps/api/src/kgraph/               the host: Prisma store binding, settings, routes, jobs, the review flow
apps/api/src/runner/host/kgraph/   bindings only: ToolInvokerPort -> executeTool, JudgePort -> tierRequest(snapshot, 'fast')
```

## The four switches

| Level | Where | Default | Effect when off |
|---|---|---|---|
| Deployment | Admin setting `kgraph.enabled` (a settings card, `kgraph:admin`) | **off** | No capture, replay, job, agent tool or MCP tool. Pages show "turned off by your administrator". Data kept. |
| User | User setting `kgraph.enabled` | **off** (opt-in) | Same, for that user. Data kept. |
| Task | `kg_task_settings.mode`: `off`, `learn`, `reuse` (route `/api/tasks/{id}/kgraph`) | **off** | That task runs AI only. |
| Run | "Run with AI only this time" on the start form and API | n/a | That run ignores the procedure. **Not built yet** (#794): the package's `effectiveMode` takes the flag, but the start form and `POST /api/tasks/{id}/runs` have no field for it. Audit runs and runs of a suspended procedure are the only AI-only runs today. |

Chat goals never use the feature: only saved tasks can opt in.

## The promotion rule

- A compiled version is a `candidate`. It becomes `verified` only after one clean replay whose outcome checks pass, then `active`.
- When the agent finishes a run the executor could not, the difference becomes a proposed version and is classified:
  - **Structural** (a new locator, a wait, a reordered read, a dismissed interrupt): promotes itself after it completes a run.
  - **Sensitive** (adds or changes a send, a payment, a recipient, a site, an account or a credential): waits for the owner's approval.
- Repeated failures suspend a procedure (circuit breaker); the task runs AI only until the owner restores the last good version.

## Security rules

The threat is a page or an email steering what gets learned.

- A procedure is built from **server-recorded facts** (tool names, arguments, results the server saw), never from the model's free text and never from page prose treated as instructions.
- A `judge` step stores no free-text instruction from a run: it gets the task's goal (the owner's words), its declared inputs and a fixed output schema.
- A value that matches the sensitive patterns (`packages/shared/sensitive-patterns.js`) is never stored in the graph. A step that needs one is bound to a task parameter or a saved-login/identity/card reference, or it is not compilable and stays with the agent.
- A commit-class step (a tool with `commits: true`, or a click the risk gate classifies as risky) is intent-recorded and is never repeated when its outcome is unknown, exactly as today ([runs.md](../runs.md), "Crash safety").
- A sensitive change is approved only by the owner, signed in, in the console (web or Android): never through a webhook, the CLI, MCP or a hosted AI app. Same pattern as memory proposals ([memories.md](../memories.md)).
- The graph shows labels and references, never typed values, secrets or account numbers. It is in the user-owned data registry (purge and export).

## Split with the AEF

VISION §17 keeps the Agent Experience Framework independent, optional and cross-owner. The Knowledge Graph is not the AEF: it is private to one owner, learns only from that owner's own runs, never grants a permission and needs no new service. The AEF may consume a redacted export (E46.23); nothing flows back from it into a procedure.

## Why PostgreSQL behind a port

- The queries the feature needs are shallow: one task's active procedure, its versions, one site's surface graph, one owner's library. A table-backed graph scales for shallow queries partitioned by owner (Facebook TAO, USENIX ATC 2013).
- The console already runs PostgreSQL with row-level security and the user-owned data registry; a new service would be a new required dependency and a new place for owner data.
- The store is a port (`ProcedureStorePort`), so a graph database can be added as another binding without touching the executor.
- **What would trigger a graph database:** the E46.4 load test missing its pass bar at 10x or 100x the expected data, or a later feature needing deep, cross-procedure traversals (more than a few hops) on the hot path of a run.

## Evidence

- A state graph of an application cut cost sharply in research: ActionEngine, [arXiv 2602.20502](https://arxiv.org/abs/2602.20502).
- Workflow memory improved success: Agent Workflow Memory, ICML 2025 ([arXiv 2409.07429](https://arxiv.org/abs/2409.07429)).
- A budget-matched study found memory modules can fail to pay for themselves: "Are Online Skill and Memory Modules Always Worth Their Tokens?", EMNLP 2026. Hence the savings ledger and the AI audit runs.
- Self-written memory is an attack surface: MINJA, [arXiv 2503.03704](https://arxiv.org/abs/2503.03704); MemoryGraft, [arXiv 2512.16962](https://arxiv.org/abs/2512.16962). Hence the promotion rule.
- A write-time verifier beats admitting anything the agent proposes: survey, [arXiv 2607.10113](https://arxiv.org/abs/2607.10113). Hence verified admission.
- Shipping products use the same shape (cached steps, a check, fallback to the model, self-healing): Stagehand caching, Skyvern code caching, UiPath Healing Agent.
- A table-backed graph scales when queries are shallow and data is partitioned by owner: TAO, [USENIX ATC 2013](https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson).

## The surface graph and the browser toolset (E46.13)

The surface graph (screens, element fingerprints, re-resolution) is browser-specific, so it lives in `@marinoscar/hexactra-browser-agent` (`./surface`). That package imports only the harness and itself (its import scan), so it does **not** import `@marinoscar/hexactra-kgraph`: the fingerprint, screen key and page element are **duplicated as plain interfaces** in the toolset, and the console host maps them onto the graph's `Element` and `Screen` (`apps/api/src/runner/host/kgraph/surface.ts`). Elements are shared per owner as `kg_nodes` rows of type `Element`, keyed by a stable id derived from the site and the fingerprint, so a repaired fingerprint is used by every procedure that references it. Resolution uses page queries only (never a model); exactly one confident match is used, otherwise the step fails its check. A label passes the trace masking table before it is stored; a password field stores no name.

## The API, the view model and the CLI (E46.19)

The pages, the CLI and (later) MCP read the graph through REST routes behind `kgraph:read` (`apps/api/src/kgraph/kgraph-read.controller.ts`): procedures, one procedure as an ordered step list, versions, a readable diff (`diffVersions` in words), the Map's view model and how a run's steps ran. The deployment switch has its own route behind `kgraph:admin` (`GET/PUT /api/admin/kgraph/settings`), reading and writing the same `kgraph` system-settings namespace. The full list is in [parity.md](../parity.md#what-the-knowledge-graph-added-e46).

- **Off.** A read answers with the stored data and `enabled: false`; restore, forget and a task's mode answer `409 KGRAPH_OFF`; "Delete everything learned" and the admin settings answer whatever the switches.
- **Masking.** Every label and literal passes the run trace's masking (`maskSensitive`); a saved login is its kind and label; a parameter is its name, a sensitive one too. Audit events carry ids, states, kinds and changed keys only.
- **The view model** lives in the package (`@marinoscar/hexactra-kgraph/view`: `buildGraphView`, `stepList`, `readableDiff`, `healthOf`), pure and tested there. Nodes have a type, a label, a health and counts; edges are `has`, `then`, `feeds`, `uses`; clusters are per site and per account. The host adds the owner's connected accounts, the MCP tools they switched on and the saved logins their runs signed in with; the ones no procedure uses are flagged `unused`. The console lists no saved-login provider's items, so a saved login never used by any run is not on the map.
- **Cost of the map.** The graph route reads one row per procedure: its shown version's steps without their checks, guards and element references, and none of its screens or elements, plus counters. Above 2,000 nodes the view folds steps, parameters and outputs into their procedures, then pages over procedures (`nextCursor`).
- **CLI.** `hexactra kgraph status | list | show | versions | restore | forget | off | on`; `off` and `on` set the user setting `kgraph.enabled`.

## Procedures as callable tools (E46.22)

- **For other agents, over MCP.** `procedures_list`, `procedure_get` (scope `procedures:read`) and `procedure_run` (scope `procedures:run`), built from the package's host-neutral descriptors (`@marinoscar/hexactra-kgraph/mcp`, no MCP SDK). They are listed and callable only while the deployment and the caller's switches are on (per-request availability in the one registry, `McpTool.feature`); otherwise `tools/list` is the list of before and a call answers "turned off". `procedure_run` starts an ordinary run of the procedure's task and returns its id at once. Nothing over MCP creates, changes, approves, restores, forgets, exports or imports a procedure, or changes a switch.
- **For the agent inside a run.** In a run whose mode is `reuse`, the tool family `procedures` adds `procedures_list` and `run_procedure`, registered last (a run with the feature off is offered exactly the tools of before). `run_procedure` walks another **active** procedure of the same owner (never the task's own) with the package's `runSubProcedure`: every step through the run's tool wrapper (Stop, Pause, the gates, intent recording), parameters bound from the call (a sensitive one only from the run's own inputs), and depth 1 (a sub-procedure that reaches `run_procedure` is refused). Its own calls are not captured; the capture records the one `run_procedure` call.

## The Map (E46.21)

The Map tab of `/kgraph` (`/kgraph?tab=map`) draws `GET /api/kgraph/graph`. It says it shows **what the agent has learned to do reliably**, not everything it can do: with its owner's full powers the agent can use any site and any connected account, learned or not.

- **Libraries.** [React Flow](https://reactflow.dev) (`@xyflow/react` 12.12.1, MIT; it brings `@xyflow/system`, `zustand`, `classcat` (MIT) and `d3-zoom`, `d3-drag`, `d3-selection`, `d3-transition` (ISC)) draws the canvas, its zoom, fit and minimap. [dagre](https://github.com/dagrejs/dagre) (`@dagrejs/dagre` 3.1.3 with `@dagrejs/graphlib` 4.0.6, MIT) lays it out left to right. dagre over elkjs: elkjs is EPL-2.0 or GPL-3.0 and its bundle is over a megabyte (8.2 MB unpacked), dagre is MIT and its ES module is 49 kB before minifying, and a layered left-to-right layout is all the map needs. React Flow 13 was days old when this was chosen, so the map stays on 12.
- **Bundle cost.** The Map is two lazily loaded chunks: `MapTab` (3.7 kB, the small-screen note and the help, so a phone never downloads the canvas) and `KgraphMap` (233 kB minified, 75 kB gzip, plus 15.4 kB of React Flow's CSS). No other page loads them. Rolldown moved three modules the Map now shares with other pages into shared chunks: `labels` (the Knowledge Graph page's own chip labels), `with-selector` (`use-sync-external-store`, shared with MUI X) and `d3-timer` (`d3-color`, `d3-interpolate`, `d3-timer`, shared with MUI X Charts). Measured as each chunk's static-import closure, before and after: the first load (`index`) 2,960,814 to 2,962,018 bytes (+0.04%), a data-grid page +158 bytes, a chart page (`BarChart`) 469,336 to 471,109 bytes (+0.4%, the d3 exports only React Flow uses now sit in the shared chunk). Each page's own code is unchanged.
- **One pure module.** `apps/web/src/kgraph/map/mapModel.ts` turns the view model into what is drawn: which nodes are visible, which edges are re-routed to the node they are folded into, the type filter, search, "focus on a task", "what uses this site" and the node limit. It is tested with Vitest; the layout (`layout.ts`) is the only other computation.
- **Clustered by default.** Every task (a procedure), site and account is one node. A task expands into its steps, parameters and outputs; an account into its tools and saved logins; a site into the steps done on it (screens are not in the view model, so its steps stand for them). A folded node's edges are drawn from the node it is folded into. Edges: **uses** faint, **then** solid (a task's entry too), **feeds** dashed and coloured.
- **Limit.** Above 500 visible nodes the map drops its expansions and says so; if the clusters alone are above 500 it draws nothing and asks the owner to filter. The API's own folding and paging above 2,000 nodes is shown as a note and Next tasks / First page.
- **Health.** A node's border is its health (healthy, degraded, failing, no runs), with words beside it; a suspended procedure (the procedures list's state) has a pause icon, a red border and the word. Unused capabilities are faint with a dashed border, and the legend says what each style means.
- **Reachable without the canvas.** Every node has an accessible name (kind, label, health or "not used by any task yet", what is folded inside). The list under the map has every visible node as a button, and the side panel does everything the canvas does: expand, focus, what uses this site, the step list (`/kgraph/procedures/:id`), History (`/kgraph?tab=history&procedure=`) and the procedure's pending reviews. Every string is rendered as text.
- **Width.** The canvas is offered from 768 px up; below, the tab is a short note and a link to the Procedures list.

## Out of scope

Teaching by demonstration, dry run, a hand editor, a shared marketplace, a cross-owner ontology, a graph database.

## Load test results (E46.4)

Recorded by #778. The load test met its pass bars except one: the heavy owner's Map query (query 4, heavy owner) had a **warm p95 of 2,083 ms against a bar of 2,000 ms**, with about 130 ms of it in the database. **Whether to accept this miss is pending the owner's decision**; it is not accepted. The live AI-only vs reuse comparison ([runbooks/kgraph-measurement.md](../runbooks/kgraph-measurement.md)) was **not measured**: there was no AI provider key in the session that prepared E46.25.
