# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **MCP protocol revisions** (#461): `POST /api/mcp` speaks `2026-07-28` (stateless: no `initialize`, per-request `_meta`, `server/discover`, `Mcp-Method`/`Mcp-Name` header checks, `resultType`, `ttlMs` and `cacheScope: "private"` on lists) and `2025-11-25`, alongside `2025-06-18`, `2025-03-26` and `2024-11-05`. An unsupported version header is `400` naming the supported versions; an `initialize` asking for an unknown version is answered with `2025-11-25` (it was `2025-06-18`). `serverInfo` carries the console's version and the title "Hexactra".
  - Transport rules on every revision: `GET`/`DELETE` are `405`, `Accept` without JSON is `406`, a browser `Origin` other than the console's own or loopback is `403` (with CORS for allowed origins), batches only on `2025-03-26`, and JSON-RPC errors (`-32700`, `-32600`) instead of generic error bodies. Details: `docs/mcp.md`, "Protocol versions".
  - `hexactra mcp serve` forwards the negotiated version in `MCP-Protocol-Version`, and the `2026-07-28` headers, on every request, and passes the console's JSON-RPC errors through.
  - Telemetry: a span per MCP message and the metrics `app.mcp.requests` and `app.mcp.tool.duration`.
- **Agent policies** (epic #398): named, versioned, personal bundles that say which models a run uses and how much it may spend. A policy holds model tiers, six budgets, stall detection and context settings.
  - Four built-in, read-only policies: Economy, Balanced (the default), Thorough and Unlimited. A user duplicates one to edit a copy, chooses one default, and assigns a policy to a task, a schedule or a single run ("Run with...").
  - Resolution order: the run, then the schedule, the task, the user's default and `builtin:balanced`. The policy is snapshotted onto the run at its first step, so editing it never changes a run in flight.
  - API `/api/agent-policies` (list, create, read, edit with `If-Match`, delete with `reassignTo`, duplicate, default, effective model tiers), permissions `agent_policies:read` and `agent_policies:write`. Tasks, schedules and run starts take `policyId`.
- **Model tiers**: Fast, Standard and Frontier, each a model, a reasoning effort, an output cap and an optional fallback model. Defined once per deployment (`browserAgentTiers`), overridable per user, and pinnable per policy. A run starts on the policy's start tier and escalates when it stalls, then steps back down after progress. Models change only between chunks, so provider prompt caching holds. A tier's fallback model is used on a provider error or rate limit when the policy allows it.
- **Budgets, each optionally unlimited** (`null`): actions, model calls, active minutes, input tokens, output tokens and cost. A warning reaches the model at the policy's threshold, and a used-up budget ends the run after one wrap-up call. Administrators set **ceilings** (`browserAgentCeilings`) that cap every policy, Unlimited included. Every finished run records a typed `stopReason`.
- **Stall detection**, always on: failures in a row, a repeated action, no progress and rounds with no action nudge the model, escalate a tier, ask a person or end the run as `stalled`. It keeps only digests, never typed text, secrets or images.
- **Per-run cost.** Every model call is priced from the administrator's `agentPricing` table (USD per million tokens). Runs report `modelCalls`, `cachedInputTokens`, `costUsd` and `costKnown`; tasks report their 30-day spend and the average cost of a successful run.
- **Context settings** (screenshots kept, calls per chunk, observation size, prune batch) with a stable prompt prefix, and the histogram `app.runs.input_tokens_per_call`. On the measurement fixture Balanced sends 18% fewer input tokens than the earlier fixed settings.
- **Export and import** of policies as JSON (`hexactra.agent-policies`, `formatVersion` 1), atomic, with `rename`, `skip` or `replace` on a name clash. A file holds no ids, user or secret.
- **Web**: Settings → Browser agent → Agent policies and Model tiers; Administration → Browser agent → Agent model tiers, Agent budget ceilings and Model prices; a policy picker on tasks and schedules; "Run with..."; on the run page the policy, tier and model, a live budget meter, the stop reason and routing rows; run cost in the runs list and spend on task cards.
- **CLI, SDK and MCP**: `hexactra policies list|show|export|import|default` and `--policy` on `runs start`, `tasks run|create|update` and `schedules create`; `hx.policies` in the SDK; the MCP tools `policies_list`, `policy_get`, `policy_create`, `policy_update`, `policy_set_default`, `policies_export`, `policies_import`, and `policy_id` on `run_goal`, `task_create`, `task_update`, `task_run` and `schedule_create`.
- **Alerts**: a cost threshold and budget-stop count on the run-budget rule, "Runs stalling", and "Expensive run" (off by default). The alerts read the typed `stopReason`, not error text.

### Changed

- A run's time budget counts **active** time only. Time spent waiting for a person no longer makes a resumed run fail, and a run that outlasts one job continues in a new job.
- A run's limits come from its agent policy: the default Balanced allows 60 actions, 120 model calls, $2 and 20 active minutes (the earlier task default was 100 steps and 30 minutes). Existing tasks keep their limits through a derived `Task: <name>` policy created by the migration.
- The goal runner picks every model call's provider, model, reasoning effort and output cap from the run's resolved tiers, no longer from the task's `model` or the user's default model alone. A run with no usable model fails at once, naming the tier, before a browser is allocated.
- The documentation (`VISION.MD` sections 25 to 27, the console README, runbooks, API, security and MCP guides) describes policies instead of per-task step and time limits.

### Deprecated

- The task fields `maxSteps`, `maxMinutes` and `model`. They still work and map to a derived personal policy (`Task: <name>`), and the response carries a `Deprecation: true` header. Use `policyId` instead. **They are removed in the release after the one that introduced agent policies.**

## [0.1.0] - 2026-11-15

### Added

- Initial project, started from the platform starter.
