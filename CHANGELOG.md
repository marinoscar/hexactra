# Changelog

## Unreleased

- **Stall detection, tier escalation and provider fallback** (#405).
  - Stall detection is always on, including under the Unlimited policy. It watches for consecutive failures, a repeated action, no progress and idle rounds.
  - The policy's `onStall` response decides what happens: nudge, then escalate to a stronger tier; escalate at once; ask a person; or stop as `stalled`.
  - Escalation switches model tiers only between chunks, and the run returns to its start tier after 5 progressing actions.
  - A provider outage or rate limit retries the chunk once on the tier's fallback model.
  - Routing steps show in the run timeline. Runs carry `currentTier` and `escalations`.
  - Fixed: an unavailable provider is no longer mistaken for a model that refuses images.
- **Context efficiency follows the run's policy** (#406).
  - Settings: `callsPerChunk`, `observationChars`, `screenshotsKept` and `pruneBatch`.
  - Screenshot window: the model sees the last few screenshots. Old ones are pruned in batches, so the provider's prompt cache keeps hitting, and only their hashes are stored.
  - Stable prompt: instructions and tool definitions stay byte-identical across runs, and the round input puts its stable parts first.
  - New metric `app.runs.input_tokens_per_call`.
  - On a scripted 30-action fixture, the Balanced settings use 18% fewer input tokens than the old fixed settings.
- **The budget engine enforces every run budget** (#404): actions, model calls, active minutes, input tokens, output tokens and cost. `null` means unlimited.
  - Ceilings: administrators set deployment ceilings in `browserAgentCeilings`, and they clamp every policy. A run's effective budget is fixed in its snapshot.
  - Warning: a run gets one warning per budget at `warnAtPercent`.
  - Wrap-up: when a budget is used up, the model makes one final call to report what it achieved, so a stopped run still returns a partial result.
  - Stop reason: runs carry a typed `stopReason` (`finished`, `budget_*`, `stalled`, `cancelled`, `error`, `no_model`) and a `budget` view (effective, used, percent, source).
  - Alerts now count budget stops by `stop_reason`. The hidden chunk cap is gone.
- **Model tiers: Fast, Standard and Frontier** (#403).
  - Where they are set: the `browserAgentTiers` system setting (deployment default) and `tiers` in the user's `browserAgent` setting (per-user override). Each tier is a model, a reasoning effort, an output cap and a fallback model.
  - How a run picks its model: policy pin, then the user's tier, then the deployment's tier, then fill-down, then the user's default AI model. A run resolves its tiers once at start, and every model call uses its tier's model, effort and output cap.
  - Early checks: a run whose start tier has no usable model fails before a browser is allocated. A model without image input starts with screenshots off.
  - New route `GET /api/agent-policies/model-tiers/effective` shows each value and where it came from. The console binds the platform's `AI_TARGET_RESOLVER` for the browser agent.
- **Agent policies export and import as JSON** (#402).
  - `GET /api/agent-policies/export` (`ids`, `includePins`) returns a portable `hexactra.agent-policies` v1 file. It carries no ids, user or secrets.
  - `POST /api/agent-policies/import` takes `onConflict` set to `rename`, `skip` or `replace`. An import is atomic. Model pins this deployment cannot use are dropped with a warning, and budgets above the deployment ceilings are flagged.
- **Agent policies** (#401): named, versioned, personal bundles of model tiers (with optional per-tier model pins), budgets where each may be unlimited (`null`), stall detection and context settings.
  - Four built-in policies: Economy, Balanced (the default), Thorough and Unlimited.
  - API: `GET/POST/PATCH/DELETE /api/agent-policies` (with `If-Match`, duplicate, `reassignTo`) and `GET/PUT /api/agent-policies/default`.
  - Tasks, schedules and run starts take a `policyId`. Every run snapshots its policy at its first step, so editing a policy never changes a live run.
  - The runner takes its action and active-minute limits from the snapshot.
  - Deprecated: the task fields `maxSteps`, `maxMinutes` and `model`. They still work for one release, map to a derived "Task: <name>" policy and return a `Deprecation` header. Existing tasks were converted by the migration.
- **Every model call the browser agent makes is priced** (#400). Admins set USD prices per million tokens (input, output, cached input) in the `agentPricing` system setting. Runs report `modelCalls`, `cachedInputTokens`, `costUsd` and `costKnown` (false, and shown as "at least", while a model has no price). Tasks report their 30-day `spend30d`. The platform's AI usage report is priced too. New metrics: `app.runs.model_calls`, `app.runs.cost`.
- **A run's time budget counts only active time** (#399). Time spent waiting for a person no longer makes a resumed run fail with "Time budget exhausted" (`runs.active_ms`). Task defaults are now 100 steps and 30 minutes everywhere; before, a task created outside the API got 40 and 15. A run that works longer than one job's runtime limit continues in a new job ("Run continued in a new job") instead of being reaped.
- **The bundled VPS browser host is opt-in** (#343). New deploys leave it off; an existing deploy that runs it keeps it (`COMPOSE_PROFILES=bundled-host` in `infra/compose/.env`). Its desktop now opens in the console through the fabric tunnel, like a node's. The old ticket viewer (`/viewer/local/`, `POST /api/fleet/viewer-ticket`, `HEXACTRA_VIEWER_PASSWORD`) is removed.
- **The extension id changed** to `ahpjoclfeibdmlnbaednepiihpamklcl` (new signing key, #335).
  - The agent bundle and its native host use the new id.
  - Run `hexactra agent update` on each host.
  - If you loaded the extension unpacked, remove the old copy and load the new build.
- **A signed CRX and `updates.xml`** are published with every agent release, so Google Chrome can force-install the extension by policy (`apps/chrome-extension/README.md`).

#90
