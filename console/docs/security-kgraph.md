# Security: the Knowledge Graph

Threat model of the Knowledge Graph in a Hexactra Console deployment (epic E46; [decision record](decisions/knowledge-graph.md); the package's own model is `packages/hexactra-kgraph/docs/security.md`).

## What is at stake

A procedure is replayed without the model. If an attacker could write into one, every later run of that task would do what they want, quietly. The graph also must not become a place where secrets collect.

## Threats and controls

| Threat | Control | Where it is enforced |
|---|---|---|
| A page, an email or an MCP tool result tells the agent to add a recipient, a site or a step, hoping it is learned | A procedure is compiled only from server-recorded facts (tool names, argument provenance, post-state), never from model text or page prose. A repair that adds or changes a send, a payment, a recipient, a site, an account or a credential is **sensitive**: it waits for the owner's review and is never replayed before it is approved. | `packages/hexactra-kgraph/src/compile/`, `src/repair/classify.ts`; `apps/api/src/kgraph/kgraph-compile.service.ts`, `reviews.service.ts`; `test/scenarios/kgraph/poisoning.spec.ts` |
| A judge step is used to smuggle an instruction | A judge step has no free-text instruction field (strict schema, validator rule `judge_instruction`); it gets the owner's goal, its declared inputs (as data) and a fixed output schema; an answer outside the schema is a failed check. | `src/schema/step.ts`, `src/validate/validate.ts`, `src/execute/execute.ts` |
| Secrets end up in the graph | Argument provenance stores a value only as a literal that is structural or the goal's own words and passes the sensitive-pattern table; a secret-looking value is `withheld`; secrets are referenced by saved-login label. Validator rules `sensitive_literal`, `sensitive_flow` (no secret to a judge or to an account/MCP tool). Exports hold no ids, tokens, evidence or traces. | `src/compile/trace.ts`, `src/validate/`, `src/transfer/`; `apps/api/src/runner/host/kgraph/observer-port.ts` (console sensitive table); marker tests in `kgraph-capture.db.spec.ts`, `transfer.spec.ts` |
| A replay bypasses Stop, Pause, the gates or crash safety | Every replayed call goes through `executeTool` (Stop, Pause, site and risk gates, saved approvals, the span, intent recording, the step row). A commit-class step whose outcome is unknown after a crash is never sent again. A verification run asks the owner before every commit-class step, whatever the task's settings and saved approvals say. | `src/harness/index.ts`; `kgraph-replay.db.spec.ts`, `kgraph-verify.db.spec.ts` |
| A review is answered by something other than the owner | The answer route requires a signed-in browser session (`principal.credential === 'session'`); a personal access token, an OAuth app (MCP, hosted AI apps), a node credential or a device token gets `403 KGRAPH_REVIEW_CONSOLE_ONLY`. There is no MCP tool, webhook or CLI command for it. | `apps/api/src/kgraph/reviews.controller.ts`, `reviews.service.ts`; `kgraph-reviews.spec.ts` |
| An imported file widens what a task may do | An import is a sensitive candidate with a review of the whole procedure and a verification run; accounts are mapped only by the owner's explicit choice to their own connections; a new task gets the owner's defaults (no allowed sites, connections or saved approvals from the file). | `apps/api/src/kgraph/transfer.service.ts`; `kgraph-transfer.db.spec.ts` |
| The graph grants a permission | The gates read the run's own limits only. Nothing in the graph widens allowed sites, adds a connection or recipient, releases a secret or creates a saved approval. An approved version still passes every gate on every run. | runner gates (unchanged) |
| A failing procedure keeps acting | Outcome checks catch a replay that finishes with a wrong result; the circuit breaker suspends a procedure after repeated failures; every Nth run is AI only and compared. | `src/execute/outcome.ts`, `src/repair/breaker.ts`; `kgraph-outcome.db.spec.ts`, `kgraph-breaker.db.spec.ts` |
| The feature changes behaviour while off | Off at any level is byte-identical: `runner-characterisation.db.spec.ts` passes unchanged; new `kg_` tables only; no existing route or MCP tool changes shape. | `test/kgraph-switches.spec.ts` (migration statements), characterisation spec |

## Residual risks

- An owner who approves a sensitive review without reading it accepts its changes; the review shows each change in plain, masked words.
- A site that changes so that the same control means something else can mislead element re-resolution; exactly one confident match is required, commit-class steps never use the model-located rung, and outcome checks and audit runs catch silent drift.
