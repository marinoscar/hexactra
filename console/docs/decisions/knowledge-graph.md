# Decision record: the Knowledge Graph (epic E46, #770)

**Status:** accepted, being built on the integration branch `epic/e46-kgraph` (#775). Experimental and off by default until E46.25 merges.

## Problem

Every run starts from zero. The model input (`packages/hexactra-agent/src/input-builder.ts`) carries the goal, the owner's memories, chat context and this run's log, and nothing from earlier runs. A task that runs every day rediscovers its path every day: one model round per step, with a screenshot each round.

The owner wants runs that are **more deterministic, faster and cheaper**: the AI discovers how to do a job once, the result is captured in a graph, later runs execute it without the model, and the AI steps back in only when something no longer works, then updates the graph.

The model's job changes from *interpreter* (decides every step of every run) to *compiler and repairer* (discovers the path once; returns only when a check fails).

## Decisions

| Topic | Decision |
|---|---|
| Name | Feature: **Knowledge Graph**. Package: `@marinoscar/hexactra-kgraph` in `console/packages/hexactra-kgraph`. One learned, runnable unit: a **procedure**. |
| Optional | Off by default at four levels: deployment (admin), user, task, run. The agent loop stays the default and the fallback. |
| Admin kill switch | An admin can turn the feature off for the whole deployment. Off means no capture, no replay, no tools, no pages. |
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
| Run | "Run with AI only this time" on the start form and API | n/a | That run ignores the procedure. |

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

## Out of scope

Teaching by demonstration, dry run, a hand editor, a shared marketplace, a cross-owner ontology, a graph database.

## Load test results (E46.4)

Recorded by #778.
