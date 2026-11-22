# Host guide

A host embeds the package by binding its ports. The package reaches the outside world only through them.

## The ports

| Port | A correct binding guarantees |
|---|---|
| `ProcedureStorePort` | Owner isolation on every call; versions immutable once stored (`putVersion` refuses an existing id); `setVersionState` is compare-and-set and only along `canTransition`; `deleteAll` removes every procedure, version and evidence row of the owner. |
| `ToolInvokerPort` | Every call goes through the host's **one** tool wrapper, so Stop, Pause, the gates, the trace and intent recording apply as for a model-chosen call; a refusal, a Stop or a Pause is reported, not thrown; a commit-class call whose earlier outcome is unknown is never sent again. |
| `StateProbePort` | Reads only; a value that is not available is `null`; no typed value, secret or image is returned. |
| `JudgePort` | The model sees only the goal, the declared inputs and the fixed schema; the call goes through the host's model routing and budgets; a result off the schema is `ok: false`. |
| `ClockPort` | `sleep` resolves early when the run is stopped. |
| `IdPort` | Unique ids matching the schema's id pattern. |
| `TelemetryPort` | Never throws into the caller; never records a typed value, a secret or page text. `noopTelemetry` is a valid binding. |

## Embedding, step by step

1. Bind `ProcedureStorePort` to your database. Run `runStoreConformance` from `./testing` against it in your own test suite (it uses jest's globals).
2. Bind `ToolInvokerPort` to your tool wrapper. Never call a tool around it.
3. Validate every version with `validateVersion(version, { tools, isSensitive })` before storing or running it. Pass your own `isSensitive` if you have a sensitive-pattern table; the default is conservative.
4. Decide the mode with `effectiveMode` from your switches. Every level defaults to off.
5. Treat any error from the package as "use the agent": a Knowledge Graph failure must never fail a run.

## The Hexactra Console

The console binds the store to PostgreSQL (`kg_` tables), the tool invoker to `executeTool`, and the judge to `tierRequest(snapshot, 'fast')`. See `console/docs/decisions/knowledge-graph.md`.
