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

Until phase 5, chat goals never used the feature: only saved tasks could opt in. Phase 5 adds a fifth switch for chats and one-off runs, **everyday**, with a narrower effect: see below.

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
- **Bundle cost.** The Map is two lazily loaded chunks, both behind the one `lazy()` import in `KgraphPage`: `MapTab` (3.5 kB, 1.8 kB gzip: the small-screen note and the help, so a phone never downloads the canvas) and `KgraphMap` (254 kB minified, 83 kB gzip, plus 15.4 kB of React Flow's CSS, 2.5 kB gzip). No other page loads them, and no other chunk changes for them (#894).
  - **What leaked, and the fix.** Rolldown never lets a lazy chunk import the entry chunk, so a module the Map shared with the entry or with another page was split into a new shared chunk, keeping every export either side used. As first shipped (#795) that made four shared chunks: `d3-timer` (`d3-color`, `d3-interpolate`, `d3-timer`, taken out of MUI X Charts' chunk with the exports only React Flow uses: a chart page's closure 469,502 to 471,284 bytes), `with-selector` (`use-sync-external-store`, shared with MUI X: a data-grid page +158 bytes), `siteFacts` (`src/kgraph/api.ts`, `labels.tsx`, `siteFacts.tsx`, moved out of the entry, one more request on every first load) and an icon chunk (`AssignmentOutlined`). `apps/web/build-config/map-bundle.ts` now gives the Map its own copy of exactly those modules (d3-color, d3-interpolate, d3-timer, use-sync-external-store, MUI icons, and the three Knowledge Graph helpers): imported from the Map, from a library only the Map uses (React Flow, dagre, zustand, classcat, the d3 zoom, drag, selection and transition modules) or from another copy, each resolves to the same file with a `?kgmap` query, a module only the Map's chunk holds. The copies are stateless except `d3-timer`, whose own timer queue then serves only React Flow. The Map's chunk grows by 19.5 kB raw (8 kB gzip) for them; `manualChunks` is not needed.
  - **Measured** with `npm run bundle:compare --workspace=web` against `apps/web/bundle-baseline.json`, the build of the pre-epic merge base (`38233dba`, built with the same installed packages). Each chunk's static-import closure, baseline → now: a chart page (`BarChart`) 469,502 → 469,502 bytes, a data-grid page 780,652 → 780,652, the telemetry dashboard 939,692 → 939,725 (+33: the navigation's Knowledge Graph icon moved to a shared icon chunk). The first load (`index`) 2,996,016 → 3,054,419 (+58,403 raw, +15,310 gzip), all of it the epic's own pages and data: the Knowledge Graph pages, the Sites tab and site-fact review card, the run panel and settings pages in the entry (+50,501), the Knowledge Graph entries of `packages/shared/capabilities.json` (264 added lines) (+7,747, in the shared `api` chunk), the navigation icon (+155). The script fails when a Map library or `src/kgraph/map/` module has more bytes outside the Map's chunks than in the baseline, or when a chunk the Map shares with another page is new or changed; it runs in CI (`console.yml`, a few seconds). After a dependency upgrade that changes the shared chunks, rewrite the baseline from the same commit (`-- --write-baseline --ref 38233dba`).
- **One pure module.** `apps/web/src/kgraph/map/mapModel.ts` turns the view model into what is drawn: which nodes are visible, which edges are re-routed to the node they are folded into, the type filter, search, "focus on a task", "what uses this site" and the node limit. It is tested with Vitest; the layout (`layout.ts`) is the only other computation.
- **Clustered by default.** Every task (a procedure), site and account is one node. A task expands into its steps, parameters and outputs; an account into its tools and saved logins; a site into the steps done on it (screens are not in the view model, so its steps stand for them). A folded node's edges are drawn from the node it is folded into. Edges: **uses** faint, **then** solid (a task's entry too), **feeds** dashed and coloured.
- **Limit.** Above 500 visible nodes the map drops its expansions and says so; if the clusters alone are above 500 it draws nothing and asks the owner to filter. The API's own folding and paging above 2,000 nodes is shown as a note and Next tasks / First page.
- **Health.** A node's border is its health (healthy, degraded, failing, no runs), with words beside it; a suspended procedure (the procedures list's state) has a pause icon, a red border and the word. Unused capabilities are faint with a dashed border, and the legend says what each style means.
- **Reachable without the canvas.** Every node has an accessible name (kind, label, health or "not used by any task yet", what is folded inside). The list under the map has every visible node as a button, and the side panel does everything the canvas does: expand, focus, what uses this site, the step list (`/kgraph/procedures/:id`), History (`/kgraph?tab=history&procedure=`) and the procedure's pending reviews. Every string is rendered as text.
- **Width.** The canvas is offered from 768 px up; below, the tab is a short note and a link to the Procedures list.

## Phase 5: reuse across goals and site knowledge (#847)

Added on the owner's decision of 2026-11-22, before the merge into `main`. A procedure learned by one task, and what the agent learned about a site, are useful to goals that are not that task. Two capabilities, each off unless the owner turns it on:

1. **Reuse across goals.** A chat or one-off run is offered the owner's procedures that fit its goal.
2. **Site knowledge.** The owner keeps short facts about a site that the agent reads as data.

### The everyday switch

| Level | Where | Default | Effect when off |
|---|---|---|---|
| Everyday | User setting `kgraph.everyday` ("Use what was learned in chats and one-off runs") | **off** | Chats and one-off runs are exactly as before: no procedure block, no procedure tools, no site facts, no proposal tool. |

- **When it applies.** It takes effect only when the deployment and user switches are on, and only for a run that is not a saved task's run (trigger `chat`, a conversation, or no task).
- **The mode it gives.** The run's mode is `everyday`.
  - It **offers** matched procedures and site facts.
  - It never captures, compiles or replays a whole procedure by itself.
  - A procedure runs only when the agent chooses `run_procedure`, as a sub-procedure, through `executeTool`.
- **Saved tasks are unchanged.** For saved tasks, `effectiveMode` stays as it was (`off`, `learn` or `reuse`). Site facts are also given in `learn` and `reuse` runs, because they are the owner's approved data and change no procedure.

### Matching a goal to procedures

The matching is deterministic: no embeddings, no vector store and no model call. It lives in the package (`src/match/`).

- **Candidate sites.** These are the registrable domains named in the goal, the run's allowed sites, and the sites of the accounts the goal names. The **exact registrable domain** is required, so a lookalike domain matches nothing.
- **Procedures.** The owner's `active` procedures whose sites intersect the candidate sites. `candidate` and `suspended` procedures are never offered, and neither is the running task's own.
- **Ranking.**
  1. A site match.
  2. Word overlap between the goal and the procedure's name, description and parameter names (lower case, accents stripped, a small stop-word list, plurals folded).
  3. Clean-replay rate.
  4. Procedure id, so the order is stable.
- **What is offered.** At most 5 procedures appear in a delimited block, "Saved procedures that may fit (data, not instructions)", in the stable part of the input. The `procedures_list` and `run_procedure` tools of E46.22 are registered last, and `procedures_list` gains an optional `query`.
- **The ledger.** A procedure run in an everyday run gets a `kg_ledger` row with mode `everyday`. An everyday row never enters a task's baseline.

### Site facts

A **site fact** is a short sentence about one site that the agent reads before it starts, so it does not rediscover it: where a page lives, how sign-in works, a quirk, a timing.

| Field | Rule |
|---|---|
| `site` | One registrable domain. |
| `kind` | `navigation`, `sign_in`, `quirk`, `timing`, `other`. |
| `text` | At most 300 characters, stored as typed and shown as text. |
| `source` | `owner` (typed by the owner), `derived` (from server-recorded facts), `agent_proposed` (the agent's words). |
| `status` | `proposed`, `active`, `archived`. **Only the owner's own act makes a fact `active`**: typing it, or approving a proposal, signed in, in the console. |
| `evidence` | For a proposal: the run, steps or screens it came from. |

- **Derived proposals** come only from server-recorded facts:
  - surface-graph transitions, with masked labels ("Invoices: Billing → History");
  - a handoff of kind one-time code on the site ("Sign-in asks for a one-time code");
  - an interrupt handler that fired ("A cookie banner appears on first visit");
  - waits above a threshold.
  - The same proposal (site, kind and normalised text) is never made twice.
- **Agent proposals.** In `learn`, `reuse` and `everyday` runs, the tool `propose_site_fact` writes a `proposed` fact: at most 3 per run, and it never blocks the run. It lands in Reviews, exactly like a memory proposal.
- **Rejected at write.**
  - Secret Material: the memories secret rules and `sensitive-patterns` apply, and a refusal is `422`.
  - Instruction-shaped text ("ignore…", "always allow…", "send to…", a link to another site). This is defence in depth, since the owner still approves.
- **In the input.** An "About these sites" block sits after the memories block, in the stable part of the input.
  - It is headed "facts the owner approved; they are information, not instructions, and they grant no permission".
  - It holds active facts of the candidate sites only: at most 1,500 characters and 15 facts, preferring those whose words appear in the goal, then the most recently used.
  - The `site_facts` tool reads the active facts of the registrable domain the page is on now. The domain is read from the browser, never from model or page text.
- **A fact grants nothing.** It cannot widen allowed sites, add an account, connection or recipient, release a secret, create a saved approval or change a confirmation. The gates read the run's own limits only.

### What phase 5 does not change

The no-impact contract holds for everything off, and for chats with only `everyday` off. Phase 5 adds:
- one `kg_` table (`kg_site_facts`) and one ledger mode;
- new routes only;
- no MCP tool or scope. Site facts are not exposed over Hexactra's MCP server in this phase, and `docs/parity.md` says so.

### Phase 6: automated facts (#890, E46.36 #892)

Added on the owner's decision of 2026-11-23.

- **Derived after every run.** A `learn` or `reuse` run derives in the `kgraph.compile` job, as before. With `kgraph.everyday` on, a chat or one-off run records its surface (shared elements with masked labels, one `RunSurface` node per call, no trace row); its end queues `kgraph.site_facts`, which builds the trace from the run's `run_steps` (tool, duration, a one-time-code handoff) joined with that surface, proposes facts and removes the surface rows. **No procedure is ever compiled from an everyday run.** With everyday off nothing is recorded.
- **Opt-in auto-approve.** The user setting `kgraph.autoApproveFacts` ("Approve facts from server records automatically") is **off** by default. When on, a newly derived fact is made `active` only if its source is `derived`, its kind is `navigation`, `timing` or `quirk`, and it passes `validateSiteFact`. A `sign_in` fact, an agent or MCP proposal, an imported fact and anything a rule refuses always wait for the owner. This is the owner's own act: their setting, for facts read from server records only.
- **How it was activated.** `kg_site_facts.approved_by` (`owner` or `auto`, default `owner`) is returned as `approvedBy`. Reviews lists the facts approved automatically in the last 30 days and the Sites tab labels them; the owner archives or deletes one as usual. Turning the setting off changes nothing already active.
- **Threat and residual risk:** [security-kgraph.md](../security-kgraph.md), "Automated facts".

## Out of scope

Teaching by demonstration, dry run, a hand editor, a shared marketplace, a cross-owner ontology, a graph database, embeddings or a vector store for matching, site facts over MCP.

## Load test, 2026-11-22

E46.4 (#778) is a gate: does the table-backed graph meet the pass bar at 10x and 100x the data it is expected to hold? **Result: q1, q2, q3 and q5 meet their bar with a wide margin. q4, one owner's whole graph for the Map, misses. The read of all columns misses for both owners. The read of only the Map's columns meets the bar for a normal owner and misses it for the heavy owner, by 104 ms at p95.** Run 2 added covering indexes on `kg_` tables. They cut the database time of the heavy owner's Map read by about 9x, but its client p95 is still 2,083 ms, so the bar is still **missed**. In both runs the time goes to the client turning rows into objects, not to the database. The raw numbers, every query plan and the cold method are in [knowledge-graph-loadtest.json](knowledge-graph-loadtest.json) (run 1) and [knowledge-graph-loadtest-index.json](knowledge-graph-loadtest-index.json) (run 2).

### How it was run

```bash
# throwaway database, kg_ migrations applied (npm run prisma:migrate), pg_prewarm created by the superuser
npm run kgraph:loadtest --workspace=api -- --database hexactra_kgraph_load --owners 200 --heavy 1
```

- **Script:** `apps/api/scripts/kgraph-loadtest.mjs`. The dataset and the five queries are in `apps/api/scripts/kgraph-loadtest-lib.js`, which the db-tier smoke `apps/api/test/kgraph-loadtest.db.spec.ts` also uses. The smoke runs the same queries on two small owners, including the Map-columns q4, and checks that the graph queries can reach every table through an owner index.
- **PostgreSQL:** 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) with default settings: shared_buffers 128 MB, work_mem 4 MB, effective_cache_size 4 GB, random_page_cost 4, jit on. It runs on the same machine as the client.
- **Machine:** 4 vCPU Intel Xeon @ 2.10 GHz, 16,473,744 kB RAM (`/proc/meminfo`), local disk. Node v22.23.5, and Prisma 7 with the `@prisma/adapter-pg` driver adapter, as in the API.
- **Iterations:** 1,000 cold and 1,000 warm per query, with two exceptions where there is not enough distinct data for more cold samples. q4 cold on a normal owner has 199 samples, one per normal owner. q4 cold on the heavy owner has 5 samples, with a cache flush before each.
- **Cold:** at the start of the phase, shared_buffers is overwritten with a 256 MB scratch table (`pg_prewarm`) and the OS page cache is dropped (`echo 3 > /proc/sys/vm/drop_caches`). Each iteration then reads a key (task, step, site or owner) that no earlier iteration of the phase read. **Warm:** 20 keys (5 owners for q4), each read twice unmeasured, then read in turn.
- **Timing:** client wall time of the Prisma calls (what the host sees), in ms. Percentiles are nearest-rank. The bar is on the **warm p95**, compared unrounded. Cold numbers are shown beside it.
- **Queries, as the store issues them:**
  1. `PrismaProcedureStore.findProcedureForTask` then `getVersion`: `kgProcedure.findFirst`, then `kgProcedureVersion.findFirst({ include: { evidence: true } })`. Both go through the scoped client (`forUser`), built afresh per call as the store does. That is three statements.
  2. One interactive transaction: a `run_steps` insert the size the runner writes (args JSON, a summary of about 120 characters, reasoning of about 150), then `recordEvidence` (the version check and the upserts of the version row and the step row). The scoped client refuses the unscoped `run_steps` model, so the transaction runs on the base client, with the owner condition written exactly as `forUser` writes it. The script checks that these evidence statements are byte-identical to the ones the scoped client issues (`q2Fidelity.same: true`).
  3. One SQL join: `kg_edges` (`Task -uses-> Site`) to `kg_nodes` (type `Task`), with every table filtered by `user_id`. This is raw SQL, because the scoped client refuses raw SQL.
  4. `kgNode.findMany` and `kgEdge.findMany` for one owner, in parallel, through the scoped client. Two shapes: **all columns**, and **Map columns** (node `id, type, key, label`; edge `id, type, from_id, to_id`).
  5. Site impact in one SQL statement: site <- screens <- elements <- steps <- tasks. That is four edge hops, one more than the issue's three, because elements hang off screens (`Screen -on-> Site`, `Element -on-> Screen`, `Step -on-> Element`, `Task -uses-> Step`).

### Dataset

Dataset A is 200 owners, and dataset B sits inside it: owner 0 has 10 times the tasks and the sites. A normal owner has 100 tasks × 10 versions × 30 steps, plus 50 sites × 30 screens × 20 elements. In rows, a normal owner has 100 procedures, 1,000 versions (graph JSON of 30 steps), 31,000 evidence rows, 34,650 nodes and 37,800 edges: about 104,550 rows. That is more than the issue's estimate of 60,000, because the surface graph and the steps are also stored as nodes and edges. The load took 672 s.

| Table | Rows | Size (with indexes) | Heavy owner's rows |
|---|---:|---:|---:|
| `kg_procedures` | 20,900 | 5.4 MB | 1,000 |
| `kg_procedure_versions` | 209,000 | 480 MB | 10,000 |
| `kg_evidence` | 6,479,000 | 1.37 GB | 310,000 |
| `kg_nodes` | 7,241,850 | 2.94 GB | 346,500 |
| `kg_edges` | 7,900,200 | 2.42 GB | 378,000 |
| `tasks` / `runs` / `users` | 20,900 / 200 / 200 | | |
| **Total kg_ rows** | **21,850,950** | **7.2 GB** | **1,045,500** |

### Run 1: the migration's indexes

| Query | Cold p50 | Cold p95 | Cold p99 | Warm p50 | Warm p95 | Warm p99 | n cold / warm | Bar | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1. Active version of one task | 4.49 | 6.79 | 9.84 | 2.60 | 4.07 | 6.17 | 1000 / 1000 | warm p95 ≤ 50 ms | **met** |
| 2. Evidence write + run_steps insert | 7.12 | 9.68 | 12.70 | 4.96 | 7.13 | 9.11 | 1000 / 1000 | warm p95 ≤ 50 ms | **met** |
| 3. Tasks that use a site | 1.00 | 1.45 | 2.03 | 0.67 | 0.87 | 1.47 | 1000 / 1000 | warm p95 ≤ 50 ms | **met** |
| 4. Owner graph, all columns, normal owner | 400.53 | 587.70 | 698.52 | 399.29 | 540.92 | 614.64 | 199 / 1000 | warm p95 ≤ 500 ms | **missed** |
| 4. Owner graph, all columns, heavy owner | 4423.42 | 4773.76 | 4773.76 | 4208.63 | 5287.87 | 5709.47 | 5 / 1000 | warm p95 ≤ 2000 ms | **missed** |
| 4. Owner graph, Map columns, normal owner | 362.03 | 981.12 | 1218.20 | 157.42 | 224.97 | 254.96 | 199 / 1000 | warm p95 ≤ 500 ms | **met** (cold p95 is above 500) |
| 4. Owner graph, Map columns, heavy owner | 1848.59 | 1866.71 | 1866.71 | 1703.07 | 2104.45 | 2372.14 | 5 / 1000 | warm p95 ≤ 2000 ms | **missed** |
| 5. Site impact (4 hops) | 13.38 | 31.08 | 41.97 | 3.19 | 4.50 | 6.98 | 1000 / 1000 | warm p95 ≤ 50 ms | **met** |

All times are in ms.

**Why q4 misses: the client materialises the rows; the database is not the bottleneck.** EXPLAIN (ANALYZE) of the same statements:

| q4 | Database time, warm (nodes + edges) | Database time, cold | Client time, warm p50 |
|---|---:|---:|---:|
| All columns, normal owner | 11.6 + 10.4 ms (bitmap scans on the owner indexes) | 258 + 186 ms | 399 ms |
| All columns, heavy owner | 266 ms (parallel seq scan of `kg_nodes`) + 64 ms | 1,013 + 211 ms | 4,209 ms |
| Map columns, heavy owner | 656 ms (parallel seq scan, 197,872 pages read from the OS cache) + 89 ms | 828 + 214 ms | 1,703 ms |

The heavy owner's graph is 724,500 rows. As a diagnostic (100 iterations, in the JSON), the same SQL was read through node-postgres, without Prisma, one statement after the other. That took 2,680 ms warm p50 (3,182 ms p95) for all columns, and 1,102 ms (1,435 ms p95) for the Map columns. The rest of the time is JavaScript turning rows into objects. Through Prisma that is about 5.8 µs a row for all columns, including the `props` JSON and the timestamps, and about 2.4 µs a row for the Map columns. An index cannot remove that cost.

### Run 2: covering indexes for the Map read (an index change, tried and not kept)

The one q4 cost an index can cut is the heavy owner's sequential scan of `kg_nodes`. A plain `kg_nodes (user_id)` index did not change the plan: the planner kept the parallel seq scan. Covering indexes give an index-only scan of just the owner's entries:

```sql
CREATE INDEX kg_nodes_user_id_map_idx ON kg_nodes (user_id) INCLUDE (id, type, key, label);   -- 843 MB
CREATE INDEX kg_edges_user_id_map_idx ON kg_edges (user_id) INCLUDE (id, type, from_id, to_id); -- 883 MB
```

They were created in the throwaway database only, followed by `VACUUM (ANALYZE)`. The Map-columns q4 was then measured again with the same method (`--queries 4 --q4-variants map`). The all-columns q4 cannot use these indexes; its numbers are in run 1.

| Query (run 2, covering indexes) | Cold p50 | Cold p95 | Cold p99 | Warm p50 | Warm p95 | Warm p99 | n cold / warm | Bar | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| 4. Owner graph, Map columns, normal owner | 177.74 | 269.84 | 298.25 | 168.77 | 254.16 | 310.11 | 199 / 1000 | warm p95 ≤ 500 ms | **met** |
| 4. Owner graph, Map columns, heavy owner | 1594.44 | 1807.40 | 1807.40 | 1511.25 | 2083.41 | 2472.92 | 5 / 1000 | warm p95 ≤ 2000 ms | **missed** |

Run 2 plans: both statements are an `Index Only Scan` on the new indexes, with `Heap Fetches: 0`.

```
Map columns, normal owner  warm: Index Only Scan kg_nodes_user_id_map_idx  shared hit=554    8.1 ms
                                 Index Only Scan kg_edges_user_id_map_idx  shared hit=519    8.5 ms
                           cold: shared read=518 / 514, 12.7 / 16.9 ms
Map columns, heavy owner   warm: Index Only Scan kg_nodes_user_id_map_idx  shared hit=5132  59.7 ms   (run 1: Parallel Seq Scan, 656.4 ms)
                                 Index Only Scan kg_edges_user_id_map_idx  shared hit=5281  71.1 ms   (run 1: 88.8 ms)
                           cold: shared read=5131 / 5280, 116.8 / 111.2 ms                            (run 1: 827.5 / 214.3 ms)
```

The node-postgres diagnostic for the heavy owner fell from 1,102 to 746 ms warm p50 (954 ms p95). Through Prisma, the warm p50 fell from 1,703 to 1,511 ms, and the warm p95 only from 2,104 to 2,083 ms.

**Verdict of run 2: still missed for the heavy owner (2,083.41 ms against 2,000 ms).** The database part is now about 130 ms of a 1.5 to 2.1 s request. The indexes cost 1.7 GB, and an index-only scan needs the visibility map kept current by autovacuum. They were therefore **not added** as a migration: no `kg_` index change is in this branch. The decision is the owner's (see "What this means").

### What this means

- **q1, q2, q3 and q5 have a wide margin.** Each warm p95 is under 8 ms against a bar of 50 ms, and each cold p95 is under 32 ms. Every statement is an index scan on an owner-scoped index, and the plan shapes are the same at 200 owners as in the smoke at 2. The run-time path (load one procedure, write evidence) is not a concern at 100x.
- **Loading one owner's whole graph in one request is the limit.** Its cost grows with the owner's row count and sits in the client, not in PostgreSQL. A graph database would not change this, because the Map would still receive 724,500 objects.
- **Design requirement for E46.19: the graph view reads only the columns the Map draws, and pages or clusters an owner above the node limit.**

**Owner's decision (2026-11-22): the miss is accepted.** The run-time queries have a wide margin. The Map read is bounded by E46.19's 2,000-node fold-and-page view, and no index change is kept. The live AI-only vs reuse comparison ([runbooks/kgraph-measurement.md](../runbooks/kgraph-measurement.md)) is still **not measured**.

### Query plans (run 1, condensed)

The plans are `EXPLAIN (ANALYZE, BUFFERS)` of the exact statements and parameters Prisma sent, run inside a transaction that is rolled back. Cold means after a cache flush. The full text of every plan is in the JSON.

**q1 (three statements):**
```
cold: Index Scan using kg_procedures_user_id_task_id_key              shared read=3    0.241 ms
      Index Scan using kg_procedure_versions_pkey (Filter user_id)    shared read=4    0.341 ms
      Index Scan using kg_evidence_version_id_step_id_key (31 rows)   shared read=35   1.494 ms
warm: the same plans, shared hit=3 / 4 / 35, 0.031 / 0.035 / 0.063 ms
```

**q2 (the run_steps INSERT; the version check; per evidence row: SELECT id, UPDATE ... WHERE id IN, SELECT the row):**
```
cold: Insert on run_steps  shared read=4 dirtied=4                                         2.679 ms (FK triggers 0.8 + 1.2 ms)
      Index Scan using kg_procedure_versions_pkey                                         0.291 ms
      Index Scan using kg_evidence_user_id_version_id_idx (Filter step_id, 30 rows removed) 0.058 ms
      Update on kg_evidence <- Index Scan using kg_evidence_user_id_version_id_idx        0.992 ms
      Index Scan using kg_evidence_pkey                                                   0.015 ms
      (the same three for the step row: 0.062 / 0.371 / 0.040 ms)
warm: Insert 0.338 ms; every other statement 0.03-0.4 ms, the same plans, all shared hit
```
Prisma does not use `INSERT ... ON CONFLICT` for these upserts, because the scoped where adds `user_id`. It does a SELECT, then an UPDATE (or an INSERT), then reads the row back.

**q3:**
```
cold: Nested Loop (6 rows)                                                         0.706 ms, shared hit=26 read=11
        -> Index Scan using kg_edges_user_id_to_id_type_idx on kg_edges e (user_id, to_id, type = 'uses')
        -> Index Scan using kg_nodes_pkey on kg_nodes t (Filter user_id, type = 'Task'), loops=6
warm: the same plan, 0.064 ms
```

**q5:**
```
cold: Unique <- Sort <- Nested Loop x4 (60 rows before DISTINCT, 6 tasks)     8.844 ms, shared hit=3176 read=54
        -> Index Scan kg_edges_user_id_to_id_type_idx sc (30 screens)
        -> Index Scan kg_edges_user_id_to_id_type_idx el (20 elements per screen, loops=30)
        -> Index Scan kg_edges_user_id_to_id_type_idx st (loops=600)
        -> Index Scan kg_edges_user_id_to_id_type_idx tk (loops=60)
        -> Index Scan kg_nodes_pkey t (Filter user_id, type = 'Task', loops=60)
warm: the same plan, 1.718 ms
```

**q4 (nodes, then edges):**
```
all columns, normal owner  warm: Bitmap Heap Scan kg_nodes <- Bitmap Index Scan kg_nodes_user_id_type_key_key (34,650 rows)   11.6 ms
                                 Bitmap Heap Scan kg_edges <- Bitmap Index Scan kg_edges_user_id_to_id_type_idx (37,800 rows) 10.4 ms
                           cold: the same plans, 258.1 / 186.1 ms
all columns, heavy owner   warm: Gather <- Parallel Seq Scan on kg_nodes (346,500 rows)                                       265.9 ms
                                 Gather <- Parallel Bitmap Heap Scan kg_edges <- Bitmap Index Scan kg_edges_user_id_to_id_type_idx (378,000 rows) 64.2 ms
                           cold: the same plans, 1,013.2 / 211.1 ms
Map columns, normal owner  warm: the same plan shapes as all columns, 11.7 / 11.3 ms; cold 246.0 / 172.1 ms
Map columns, heavy owner   warm: Parallel Seq Scan kg_nodes 656.4 ms; Parallel Bitmap Heap Scan kg_edges 88.8 ms; cold 827.5 / 214.3 ms
```
