# Hexactra Console

Assign work to AI browser agents and watch them do it.

[![CI](https://github.com/marinoscar/hexactra/actions/workflows/console.yml/badge.svg)](https://github.com/marinoscar/hexactra/actions/workflows/console.yml)

This app was started from the platform starter. The platform (sign-in, users and organizations, settings, the job queue, the admin Doctor, the CLI, the Compose and nginx stack) comes from the published `@marinoscar/platform-*` packages. This repository holds only what is yours: the composition (`apps/api/src/platform/`, `apps/web/src/App.tsx`, `apps/cli/src/app.ts`), your domain code, and your appearance.

**Never edit platform code here.** There is none to edit: it lives in `node_modules`. When the platform lacks a seam you need, ask for it upstream with a [seam request](https://github.com/marinoscar/EnterpriseAppBase/issues/new?template=seam_request.yml); see [Changing the platform](#changing-the-platform).

## What the console adds

The console drives the **Hexactra Fabric**: the Rust control plane and its browser hosts (`../crates`, `../docs/remote-control-api.md`). Every capability is a REST operation, and lives on the web, CLI, TUI and MCP surfaces unless [packages/shared/capabilities.json](packages/shared/capabilities.json) says why not. That file is the parity registry: each surface's tests fail when a capability it names is missing there, or when a REST operation, command or MCP tool belongs to no capability.

| Capability | Web | API | CLI / TUI | Permission |
|---|---|---|---|---|
| Fabric connection (URL and `hxs_` service token, stored encrypted; Doctor checks `fabric.*`) | Administration → Fabric connection | `GET/PUT/DELETE /api/fabric/connection`, `POST …/test` | `hexactra fabric show\|set URL --token-stdin\|test\|clear --yes` | `fabric_config:read` / `:write` |
| Tasks: saved goals with a profile, an agent policy (budgets and models), optional allowed sites, opt-in confirm-before-purchase | `/tasks` | `/api/tasks` | `hexactra tasks list\|create\|update\|run [--watch]\|delete` | `tasks:read` / `tasks:write` |
| Agent policies: named, versioned bundles of model tiers, budgets (any of them unlimited), stall detection and context settings; four built-ins, a default per user, one per task, schedule or run ([Agent policies](#agent-policies)) | Settings → Browser agent → Agent policies; Administration → Browser agent | `/api/agent-policies` | `hexactra policies`; MCP `policies_*` and `policy_*` tools; SDK `hx.policies` | `agent_policies:read` / `:write` |
| Runs: the AI goal runner (`browser.goal.run` job): steps, handoffs, cancel | `/runs`, `/runs/:id` | `/api/runs`, `POST /api/tasks/:id/runs`, `POST /api/runs/:id/cancel` | `hexactra runs list\|start\|show\|watch\|cancel` | `runs:read` / `runs:write` |
| Inbox: what agents wait for (CAPTCHA, code, sign-in, confirmation); answers resume the run | `/inbox` | `GET /api/inbox`, `POST /api/inbox/:runId/respond` | `hexactra inbox list\|answer RUN --done\|--value\|--choice\|--secret-stdin\|--decline`; TUI **Agent ▸ Inbox** | `runs:read` / `runs:write` |
| Questions: an agent asks its user a typed question (text, choice, multi-choice, number, confirm, none, takeover; a secret only in a browser session) and waits for the typed answer; the person answers on any channel, the first answer wins ([docs/questions.md](docs/questions.md)) | `/inbox`, `/inbox/q/:id` | `/api/questions`, `POST /api/questions/:id/answer\|cancel\|answer-by-token` | `hexactra questions ask\|list\|show\|answer`; TUI **Agent ▸ Inbox** | `runs:read` / `runs:write` |
| Live run view: steps over SSE, live screenshot, take over | `/runs/:id` | `GET /api/runs/:id/stream\|screenshot\|viewer` | `hexactra runs watch`; TUI **Agent ▸ Runs** | `runs:read` |
| External agents: a browser session through the console, recorded as a run (trigger `external`); the user sees each step, can stop it, and answers its handoffs | `/runs` | `POST /api/browser/sessions`, `…/:runId/actions\|handoffs\|artifacts/:id`, `DELETE …/:runId` | via MCP | `runs:read` / `runs:write` |
| MCP server for agent frameworks: delegate goals or drive browsers, with every call going through the REST API as the user ([docs/mcp.md](docs/mcp.md)) | — | `POST /api/mcp` (Streamable HTTP) | `hexactra mcp serve` (stdio) | the tools' routes |
| Fleet: hosts, enrollment, drain, revoke, profiles | `/fleet` | `/api/fleet/…` | `hexactra fleet hosts\|enroll\|drain\|undrain\|revoke\|commands`, `hexactra fleet profile create\|delete\|restart\|close`; TUI **Agent ▸ Fleet** | `fleet:read` / `fleet:write` |
| Remote desktop of a host: a viewer session bound to the host, the person and the organization; every connect re-checks the permission (docs/nodes.md) | `/fleet/hosts/:id/desktop` (Fleet → Open desktop) | `POST/DELETE /api/fleet/hosts/{id}/viewer-session` | `hexactra fleet desktop <host>`; TUI **Agent ▸ Fleet** key `o` | `fleet:desktop` |
| Take over a host's desktop: the agent's next steps wait until you release it; keyboard and mouse pass only while you hold the lease | Desktop page **Take over** / **Release** | `/api/fleet/hosts/{id}/takeover` (GET, POST, renew, DELETE) | `hexactra fleet takeover\|release <host>` | `fleet:desktop` |
| Alerts: a browser host offline (or the fabric unreachable), a schedule failing 3+ runs in a row, a user's runs over their token, cost or budget limits, a user's runs stalling, one expensive run ([Watching a run's spend](#watching-a-runs-spend)); incidents fire, notify the holders of `alerts:read` (and `alerts.alert.*` webhooks) and resolve on their own | Administration → Alerts | `/api/admin/alerts/…` (the platform slice) | — | `alerts:read` / `alerts:write` |

Run it all on a VPS (console, fabric and an optional browser host in one stack): [docs/runbooks/vps-stack.md](docs/runbooks/vps-stack.md). Run the browsers on **nodes** at home, which keep a residential IP and connect outbound over HTTPS: [../docs/nodes.md](../docs/nodes.md).

**The goal runner**:
- It uses the AI slice: feature `browser_agent`, a model with `tools`. Configure a provider at Administration → AI.
- The model never sees secrets: codes and passwords come from handoffs, and the fabric types them into the page (`type_secret`); the console never holds them.
- Steps store redacted arguments only.
- It works like a person at the computer, with your full powers (VISION §27, epic #366):
  - every model round starts with a screenshot of the page, with the interactive elements numbered;
  - it acts by selector, by mark or by position, with trusted mouse and keyboard;
  - it runs JavaScript in the page;
  - it uses the node's desktop for native dialogs and file pickers.
  A model without vision keeps working from the page's text and elements.
- A run's limits come from its [agent policy](#agent-policies) (the built-in Balanced by default: 60 actions, 20 active minutes). No confirmation before purchases. Two limits are opt-in per task: an allowed-sites list, and "Ask me before purchases".
- Every model call is priced from the admin's `agentPricing` table (USD per million tokens, [Model prices](docs/runbooks/operations.md#model-prices)): a run shows its model calls, tokens and cost (a lower bound, "at least", while a model has no price) and a task its spend over 30 days.

The CLI's commands use the login from `hexactra login`, or `HEXACTRA_SERVER_URL` and `HEXACTRA_TOKEN`. Install it with one `curl | bash` line; the terminal UI groups its screens into Agent, Worker, Server, Developer and Account; the guide, with screenshots, is [apps/cli/README.md](apps/cli/README.md).

## Agent policies

An **agent policy** says which models a run may use and how much it may spend. It is a named, versioned, personal bundle. The spec is `console/apps/api/src/policies/agent-policy.schema.ts`, the single source of truth: the API, the OpenAPI document, the built-ins, the run snapshot, the export file and the web editor all derive from it, and every field carries its own description.

A policy holds four blocks, and every one is enforced:

| Block | What it sets | Read more |
|---|---|---|
| **Models** | The start tier and the highest tier (`fast`, `standard`, `frontier`) a run may escalate to, whether a tier's fallback model may be used on a provider error, and optional **model pins** | [Model tiers](#model-tiers) |
| **Budget** | Most browser actions, model calls, active minutes, input tokens, output tokens and cost in US dollars, and a warning threshold. **`null` means unlimited**, for any of them | [Budgets](#budgets) |
| **Stall** | Failures in a row, a repeated action, actions without progress, and what to do (nudge then escalate, escalate, ask a person, fail). **Always on**, even when every budget is unlimited | [Stall detection and escalation](#stall-detection-and-escalation) |
| **Context** | Screenshots kept, prune batch, model calls per chunk and observation size | [Context settings](#context-settings) |

### Built-in policies and your own

The four **built-in policies** are code (`builtin:economy`, `builtin:balanced`, `builtin:thorough`, `builtin:unlimited`): read-only, versioned with the console and never pinning a model. Duplicate one to edit a copy.

| | Economy | **Balanced** | Thorough | Unlimited |
|---|---|---|---|---|
| Tiers (start to max) | fast to standard | standard to frontier | frontier to frontier | standard to frontier |
| Actions / model calls | 40 / 80 | 60 / 120 | 200 / 400 | no limit |
| Active minutes / cost | 10 / $0.50 | 20 / $2 | 60 / $10 | no limit |
| On a stall | nudge, escalate once | nudge, escalate twice | ask a person | nudge, escalate twice |
| Screenshots kept / calls per chunk | 1 / 8 | 2 / 10 | 3 / 10 | 2 / 10 |

Your own policies are personal (organization-shared policies are not offered; a [JSON file](#export-and-import) is how you share one). Names are unique among your policies, and every edit bumps the policy's `version`.

**The default.** Each user has one default policy, stored as `browserAgent.defaultPolicyRef` in their user settings (`GET`/`PUT /api/agent-policies/default`). With none chosen it is `builtin:balanced`. A default cannot be deleted.

### Which policy a run uses

Most specific first:

1. the run's own `policyId` (`POST /api/runs`, `POST /api/tasks/:id/runs`: "Run with...");
2. the schedule's `policyId`, for a scheduled run;
3. the task's `policyId`;
4. the user's default;
5. `builtin:balanced`.

A reference to a deleted policy (or someone else's) falls through to the next level. The fall-through is logged and noted in the run's first log line, and never fails the run.

**The policy is snapshotted onto the run** at its first step (`runs.policy_snapshot`, with `policy_ref`, `policy_version` and `policy_source`) and never changed. The snapshot also holds the effective budget and the resolved model tiers. The runner and the budget engine read only the snapshot, so editing a policy, your settings or a ceiling later does not affect a run in flight. Run responses carry `policy: { id, name, version, source, builtin }`, where `source` is `run`, `schedule`, `task`, `user_default` or `system_default`.

### The API

`/api/agent-policies`, with permissions `agent_policies:read` / `:write` (granted like `tasks:*`). The per-endpoint reference is the OpenAPI document at `/api/docs`; in short:

- **List** (built-ins and your own, each with `isDefault`, `usage` and `hasNoHardStop`), **create**, **read**, **duplicate**.
- **Edit** with `PATCH` and `If-Match: <version>` (`412 POLICY_VERSION_CONFLICT` on a stale version; built-ins answer `403`).
- **Delete**: `409 POLICY_IN_USE` lists the tasks and schedules that use it, or pass `?reassignTo=<id>`; `409 POLICY_IS_DEFAULT` for your default.
- **Default**: `GET`/`PUT /default`. **Tiers**: `GET /model-tiers/effective`. **Share**: `GET /export` and `POST /import`.
- Tasks and schedules take `policyId`; `null` follows the next level.

**The earlier task fields are deprecated.** `maxSteps`, `maxMinutes` and `model` on a task still work, and are removed in the release after the one that introduced agent policies. Sending one (with no `policyId`) saves a derived personal policy named `Task: <task name>`, built from Balanced (`maxActions` = `maxSteps`, `maxActiveMinutes` = `maxMinutes`; a model becomes the `standard` pin and caps `maxTier` at `standard`), and answers with a `Deprecation: true` header. The `agent_policies` migration converted existing tasks the same way. Use `policyId` instead.

### Model tiers

Models are chosen by **tier**, not by name. There are three fixed tiers: **Fast** (cheap and quick), **Standard** (the everyday one) and **Frontier** (the strongest, for a run that is stuck). A tier is a model, a reasoning effort (`none`, `low`, `medium`, `high`; blank is the provider's default), a cap on output tokens and an optional fallback model. A policy only says which tier a run starts on and how high it may climb, and may pin a model to a tier.

**Model pins.** A policy may pin one model to a tier: `provider:modelId`, or a bare model id. A pin beats the tier's own definition for runs under that policy. Saving a policy refuses (`400 POLICY_PIN_INVALID`) a pin to a model that is not enabled for you, or that lacks tool calls and vision (one check, `PolicyModelCheck`). Built-in policies never pin, so they follow your tiers.

**Where tiers are defined**, once, in two layers (the spec is `console/apps/api/src/policies/model-tiers.schema.ts`):

- the **deployment default**, the `browserAgentTiers` system setting, edited by an administrator (`PATCH /api/system-settings`, `system_settings:write`; the page is **Administration → Browser agent → Agent model tiers**);
- **your own override**, `tiers` in your `browserAgent` user setting (`PATCH /api/user-settings`), per tier and per field. A field you leave out uses the deployment's.

**Which model a tier uses**, most specific first:

1. the policy's **pin** for that tier;
2. your tier;
3. the deployment's tier;
4. **fill-down**: a tier with no model borrows the nearest tier that has one (Fast and Frontier borrow Standard first; Standard borrows Frontier, then Fast);
5. your default model in your AI settings (`ai.defaultModel`).

If none gives a model the run fails at once, before a browser is allocated, with `No model selected`, naming the Model tiers page. The effort, output cap and fallback are the tier's own (your tier, then the deployment's, else unset): they are never borrowed, so Fast keeps the provider's default effort even when it borrows Standard's model. `none` asks the provider for the least reasoning it offers; an effort is not sent to a model that cannot reason. The per-model output caps an admin set in the AI settings still clamp the tier's cap.

**Same model, different effort.** Standard and Frontier may name the same model with a lower and a higher effort (for example Standard = model X at `low`, Frontier = model X at `high`). Escalating then changes only how hard the model thinks, so the provider's prompt cache stays warm, which is cheaper and faster than switching models.

**Checked at the start of a run.** Every resolved model must be one you can call right now (enabled by the administrator, on an enabled provider, with a key) and must support tool calls; otherwise the run fails with a message naming the tier. A model **without image input** is allowed: the run starts with screenshots off (it works from `observe_elements` and `read_text`) instead of finding out from a refused call.

**Fixed for the run.** The resolved tiers (model, provider, effort, cap, fallback and what each can do) are written to the run's policy snapshot (`resolvedTiers`) when it starts. Every model call reads them from there, so editing the tiers while a run is in flight changes nothing for it; the next run picks the change up.

**Reading them.** `GET /api/agent-policies/model-tiers/effective` (`agent_policies:read`; `?policyId=` resolves for another policy) returns the tiers a new run of your default policy would use, with where each value came from (`pin`, `user`, `deployment`, `fill_down`, `ai_default`) and `vision` / `tools` flags.

**Under the hood.** The console binds the platform's `AI_TARGET_RESOLVER` (`console/apps/api/src/platform/ai/browser-agent-target.resolver.ts`). The goal runner always names the tier's provider and model (the `browser_agent` feature); every other feature (`notes-summary`) resolves exactly as the platform does by default.

### Budgets

A run is held to six budgets: **actions**, **model calls**, **active minutes** (time waiting for a person never counts), **input tokens**, **output tokens** and **cost** (US dollars, from the admin price table; an unpriced call counts nothing toward the limit and the run shows "at least"). The budget engine is `console/apps/api/src/runner/budget.ts` (`BudgetTracker`, pure and unit tested).

- **`null` is unlimited ("No limit" in the editor).** A policy with every budget `null` (the built-in Unlimited) has no hard stop: the run ends when it finishes, when you stop it, or when it stalls. The first line of its run log says so, and the editor warns (but does not block saving). Stop and takeover always work.
- **Ceilings.** The deployment's admin sets ceilings in the `browserAgentCeilings` system setting (**Administration → Browser agent → Agent budget ceilings**; same keys as a policy's budget, each nullable, none by default). A run's effective limit is `min(policy, ceiling)`; it is unlimited only when both are `null`, so a ceiling also caps an Unlimited policy. The effective budget is written to the run's snapshot at its first step (`policy_snapshot.effectiveBudget`, with where each limit came from: `policy` or `ceiling`), so changing a policy or a ceiling never changes a run in flight.
- **Where it is checked.** After every model call (model calls, tokens, cost), before every browser action (actions) and before each chunk (everything, active time included). A run continued after a handoff or in a new job starts from what it already used, never from a fresh budget.
- **Warning.** The first time a budget reaches the policy's `warnAtPercent`, the model's next round carries: `Budget: <budget> is at <p>% (<used> of <limit>). Finish the goal now if you can; otherwise call finish with what you achieved and what remains.` The run log records it once per budget.
- **Wrap-up.** When a budget is used up the run makes one last model call with only the `finish` tool (one step, a capped output), exempt from the exhausted budget and counted in the run's totals, so a stopped run still returns a partial result: `finish(success: true)` ends the run `succeeded`; anything else ends it `failed` with the model's summary as `result` and the budget message (for example `Step budget exhausted`) as `error`. If the model calls no `finish`, the run ends with the budget message alone.
- **`stopReason`.** Every finished run carries a typed `stopReason` (`runs.stop_reason`): `finished`, `budget_actions`, `budget_model_calls`, `budget_active_time`, `budget_input_tokens`, `budget_output_tokens`, `budget_cost`, `stalled`, `cancelled`, `error` or `no_model`. A wrap-up that succeeds keeps the budget reason, so the run page can say what forced the stop. Runs from before the column have `null`.
- **API.** Run responses (and the `run` events of `GET /api/runs/:id/stream`) carry `stopReason` and `budget: { effective, used, percent, source, costKnown }`: the limits, what the run used (active time in minutes, cost in USD), the percent of each limit (`null` when unlimited), and the source of each limit. `budget` is `null` until the run's first step.
- **Stalls.** Stall detection is always on, so a run with no budget still ends when it loops (see Stall detection and escalation below).

### Stall detection and escalation

Stall detection is **always on**, including under the Unlimited policy. The detector is `console/apps/api/src/runner/stall.ts` (pure, unit tested); the runner feeds it every recorded action and the page as measured at the start of every chunk. Its state lives in the run's memory, so it survives chunks, jobs and handoffs, and holds only short digests, normalised selectors and URLs without a query: never typed text (only its length), never a secret value, never an image. Typing a handoff secret is not fed to it at all.

**Signals** (thresholds are the policy's `stall` block):

| Signal | Fires when |
|---|---|
| Failures in a row | `maxConsecutiveFailures` failed actions in a row. |
| Repeated action | The same action fingerprint occurs `maxRepeatedAction` times in the last 10 actions. A fingerprint is a hash of the action type, its arguments (redacted first: typed text is its length, URLs lose their query, positions are rounded to 10 pixels), whether it succeeded, the page URL, what it returned (the scroll position, a digest of read content) and a digest of the page. |
| No progress | `noProgressActions` actions with no change of URL, page title or page view (a digest of the numbered elements on the screenshot, or of the screenshot itself when it has none; computed in the console, never sent to the model), and no successful `read_text`, `observe_elements` or `run_javascript` that returned content not seen recently. Observations alone are never progress. The page is only measured when a screenshot is taken, so this signal is judged at chunk boundaries. Without screenshots (vision off) a new successful change of the page counts as progress. |
| No action | Three rounds in a row that record no action at all (a model that only talks). |

A `request_human` or any handoff resets every counter.

**Responses** (`stall.onStall`):

| Mode | What happens |
|---|---|
| `nudge_then_escalate` | The first stall at a tier adds a nudge to the next round: `You appear stuck: <reason> (last actions: ...). Do not repeat the same action. Try a different approach (another selector, position, keyboard, run_javascript, or a different page), or call finish if the goal is impossible.` The next stall escalates one tier. When there is nothing left to escalate to, the run asks a person, or fails as `stalled` when it runs unattended (a scheduled run) or has already asked three times. |
| `escalate` | Escalates at once; with no escalation left the run fails as `stalled`. |
| `ask_human` | Opens a `takeover` handoff (kind `other`) whose prompt gives the reason and the last 5 actions, through the same path as `request_human`, and waits (`waiting_human`). |
| `fail` | Ends the run as `stalled`, after the same one-call `finish` wrap-up a used-up budget gets. |

**Escalation.** The run moves to the next tier above its current one, up to `models.maxTier`, at most `stall.maxEscalations` times per run; a tier whose model, effort and output cap are the same as the current one is skipped, as is one that is not usable. The model only ever changes between chunks (the chunk that stalled ends first), so provider caching holds inside a chunk. The tier, the escalation count, the stall counters and the fingerprint window are kept in the run's memory; `runs.current_tier` and `runs.escalations` (and `currentTier`, `escalations` on run responses and the live stream) show them. If the new tier's model has no vision, screenshots turn off for the run.

**De-escalation.** After 5 successful actions in a row that were not repeats, on an escalated tier, the run returns to its start tier at the next chunk boundary. A single hard step does not move the whole run onto the strongest model. Escalations are still counted against `maxEscalations`.

**Provider fallback.** When the policy has `allowProviderFallback` and the tier has a fallback model, a chunk whose model call fails with `AI_PROVIDER_UNAVAILABLE` (down, overloaded, a 5xx), `AI_RATE_LIMITED` or `AI_MODEL_NOT_REACHABLE` is retried once on the fallback model, and the next chunk goes back to the primary. A fallback is not an escalation. Without a fallback the error stands as before: a rate limit defers the job, other errors fail the run.

**Visibility.** Every escalation, de-escalation and fallback writes a run step of kind `routing` with `args: { from, to, reason, kind }`. A routing step is not an action: it counts toward neither `stepCount` nor the actions budget. While the run is on an escalated tier its activity carries a `note` (for example `Escalated to Frontier (stuck: repeated click on #submit)`) that the run page shows, and the run log the model reads says so too.

### Context settings

Most of a long run's cost is context re-sent on every model call. The policy's `context` block (read from the run's snapshot, never from constants) sets how much each round carries:

| Knob | Range | What it does | Cost and accuracy trade-off |
|---|---|---|---|
| `callsPerChunk` | 1-20 | Model calls per chunk (the `runTools` step cap). A chunk ends, and the conversation of tool outputs resets, after this many calls; the step log (last 60 lines) carries continuity. | Smaller: less re-sent output (input grows roughly with the square of the calls in a chunk) but a new screenshot and log each chunk. Larger: fewer resets, more cost, better short-term memory. |
| `observationChars` | 500-20000 | Most characters of one `read_text`, `run_javascript`, `observe_elements` or `tabs` result sent to the model. `observe_elements` lists at most `min(80, floor(chars / 75))` elements. | Smaller: cheaper rounds, but a long page may be cut off. |
| `screenshotsKept` | 0-5 | Screenshots in the model's context: the current one plus earlier ones. `0` turns vision off (text only, the same as a model that refuses images). | More images show what changed but each costs tokens on every round they stay. |
| `pruneBatch` | 1-50 | Older screenshots go in batches, not one per call: once the window is full only the newest image is replaced, so the older images, and the prompt prefix up to them, stay byte-identical for `pruneBatch` chunks (provider prompt caching keeps hitting). Then the window is trimmed to the current screenshot and refills. | A larger batch caches better but keeps a stale image longer. |

The built-ins' screenshots and calls per chunk are in the table above; all use 6000 characters and a prune batch of 10. The settings the runner used before policies (20 calls, 6000 characters, 1 screenshot) appear only as the baseline of the measurement below.

**What stays the same on purpose.**
- Screenshots live only in the job's memory: `runs.transcript` keeps digests (`shots`), never images. After a job hop or a handoff the window restarts with the current screenshot.
- The instructions and tool definitions contain no per-run value, so they are byte-identical for every run (a test hashes them). The round input is ordered goal and allowed sites, step log, screenshots, then the volatile tail (what the screenshot shows, steps used).
- Provider cache hints: the platform exposes only an untyped `providerOptions` escape hatch and documents no cache option, so none is set. Providers with automatic prefix caching benefit from the stable prefix; explicit hints (for example a cache key or breakpoints) need an EnterpriseAppBase seam request.
- Each model call records `app.runs.input_tokens_per_call` (histogram) in the "Browser agents" telemetry.

**Measurement.** A deterministic fixture (`apps/api/test/context-efficiency.db.spec.ts`): the same scripted run of 30 actions on a large page, a fake model that reports input tokens as the size of everything it would be sent (characters / 4, plus 850 per image), run under the old settings and under Balanced. It measures context size, not provider prices or task success on real sites: real-provider benchmarking was not possible in the build environment.

| Settings | Chunks | Model calls | Input tokens | Result |
|---|---|---|---|---|
| Old (20 calls, 6000 chars, 1 screenshot) | 2 | 31 | 443,728 | succeeded |
| Balanced (10 calls, 6000 chars, 2 screenshots) | 4 | 31 | 364,417 | succeeded |

Balanced sends 18% fewer input tokens here even though it shows one more image. The saving grows with page size and run length; a model that must remember more between chunks may need larger chunks.

### Export and import

A policy is personal, so a JSON file is how it is shared with a colleague or moved to another deployment.

- **Export:** `GET /api/agent-policies/export?ids=<id>,<id>|all&includePins=true|false` (permission `agent_policies:read`) answers a JSON attachment `agent-policies-<yyyymmdd>.json`, not wrapped in the `data` envelope. `ids` defaults to `all` (the built-ins, then your own); built-ins can be exported as a starting template. `includePins=false` strips every model pin, so the file only relies on tiers and works on any deployment.
- **Import:** `POST /api/agent-policies/import` with `{ "file": <the JSON>, "onConflict": "rename" | "skip" | "replace" }` (permission `agent_policies:write`). On a name you already use: `rename` (the default) adds ` (2)`, ` (3)`; `skip` leaves yours and lists the entry under `skipped`; `replace` overwrites yours in place, keeps its id and the tasks that use it, and bumps its version (a run in flight keeps its own snapshot).
- **Atomic:** the whole file is written in one transaction. Any invalid policy rejects the file with `400 POLICY_IMPORT_INVALID`, whose `details.errors` lists every invalid entry (`index`, `name`, Zod `issues`); nothing is created. A newer `formatVersion` or `spec.schemaVersion` than the deployment reads is `400 POLICY_IMPORT_UNSUPPORTED_VERSION`. Limits: 100 policies and 256 KB (`413 POLICY_IMPORT_TOO_LARGE`).
- **Pins:** a pin to a model that is unknown, disabled or without tools and vision on this deployment is dropped (that tier falls back to your tier definition) and listed under `warnings` with code `PIN_DROPPED`; the policy is still created.
- **Ceilings:** a budget above the deployment's ceilings is stored as written and listed under `warnings` with code `EXCEEDS_CEILING`; it is clamped when a run uses it, so an import never weakens a ceiling.
- **What the file holds:** names, descriptions and specs only. No ids, user, version, timestamps, task usage or secret. The response is `{ created, replaced, skipped, warnings, errors }` (`errors` is always empty on success).

```json
{
  "kind": "hexactra.agent-policies",
  "formatVersion": 1,
  "exportedAt": "2026-11-17T12:00:00.000Z",
  "policies": [
    {
      "name": "Careful shopping",
      "description": "Frontier from the start, ask a person when stuck",
      "spec": {
        "schemaVersion": 1,
        "models": { "startTier": "frontier", "maxTier": "frontier", "allowProviderFallback": false },
        "budget": { "maxActions": 200, "maxModelCalls": 400, "maxActiveMinutes": 60, "maxInputTokens": null, "maxOutputTokens": null, "maxCostUsd": 10, "warnAtPercent": 80 },
        "stall": { "maxConsecutiveFailures": 4, "maxRepeatedAction": 3, "noProgressActions": 10, "onStall": "ask_human", "maxEscalations": 0 },
        "context": { "screenshotsKept": 3, "pruneBatch": 10, "callsPerChunk": 8, "observationChars": 6000 }
      }
    }
  ]
}
```

### Using it in the console

Everything above is on the console's pages (`apps/web/src/pages/`, one client for every call in `src/policies/api.ts`). Built-ins show a lock; your own policies show their version, and every policy shows its tiers, a budget summary ("60 actions · $2 · 20 min" or "Unlimited") and how many tasks and schedules use it. The editor's help texts are the API's own field descriptions.

**Create a policy**

1. Open **Settings → Browser agent → Agent policies** (`/settings/agent-policies`).
2. Choose **New policy** and pick the built-in to start from, or **Duplicate** any policy (name the copy; the editor opens on it).
3. In the editor, fill in **General** (name, description), then **Models**: the start and max tier (Fast | Standard | Frontier), provider fallback, and optional pins per tier. Each tier shows the model it resolves to for you and where that comes from.
4. Under **Budgets**, set each limit or turn on its **No limit** switch (saved as `null`). With every budget off, the page warns: "Nothing will stop this run except finishing, Stop, or stall detection." Saving is still allowed. When an administrator set a ceiling, it shows under the field ("Capped at 300 actions by your administrator").
5. Adjust **When the agent is stuck** and, under **Advanced: context**, the context settings; then **Save**. If someone changed the policy meanwhile, the page says so and offers **Reload**.

**Set your default**

1. On **Agent policies**, open a policy's **⋮** menu and choose **Set as default**. The **Default** badge moves to it.
2. Tasks whose policy is **Default** (and ad-hoc runs) now use it. A default cannot be deleted; deleting a policy that tasks or schedules still use asks which policy they move to.

**Choose a policy for a task, a schedule or one run**

1. In the task form (**Tasks**), pick **Policy**: *Default (name)*, a built-in, or one of yours. The line under it summarises the choice; **Manage policies** opens the list. The form sends `policyId` only.
2. A task card shows `policy: <name>` and `model: <the model its start tier uses>`.
3. When adding a schedule, **Policy override** runs that schedule under another policy (default: the task's).
4. **Run with…** (the arrow next to **Run now**) starts one run under the policy you pick from the menu, without changing the task.

**Export and import**

1. **Export all** downloads every policy as one JSON file; a policy's **⋮ → Export** downloads just that one. Turn off **Include model pins** for a file that works on any deployment.
2. **Import** opens a file picker. The dialog lists the policies in the file and asks what to do when you already have one with the same name (keep both and rename, skip, or replace yours), then reports what was created, replaced and skipped, with any warnings (for example a pin to a model this deployment does not have, which is dropped).

**Model tiers.** **Settings → Browser agent → Model tiers** (`/settings/agent-model-tiers`, shown while AI is on) has one card per tier: model, reasoning effort, max output tokens and fallback model. Each tier **inherits from the deployment** until you switch that off; "Now:" shows what it resolves to.

**For administrators**, under **Administration → Browser agent**: **Agent model tiers** (`/admin/settings/agent-model-tiers`, the deployment default for every user), **Agent budget ceilings** (`/admin/settings/agent-ceilings`, the most any run may spend, also capping Unlimited policies; **No ceiling** per budget) and **Model prices** (`/admin/settings/agent-pricing`, US dollars per million input, output and cached input tokens per `provider:modelId`). All three read with `system_settings:read` and save with `system_settings:write`.

### Watching a run's spend

The run page (`/runs/:id`) shows the run's **policy** (name, version, and whether it came from your default, the task, the schedule or this run), its **tier** (`tier: Standard`, highlighted as `tier: Standard → Frontier` once a stall escalated it) and the **model** that tier uses. Under them, a **budget meter** has one bar per limited budget (used / limit and the percent; a deployment ceiling is marked), turning orange at the policy's `warnAtPercent` and red at 100%; an unlimited budget shows what was used and "∞", and an unpriced cost reads "≥ $x". The meter follows the run's live stream and ticks active time between events. When the run ends, one line says why (for example "Stopped: cost budget reached ($2.00)." with the agent's summary). Escalations, de-escalations and model fallbacks appear in the step timeline as their own rows (↑, ↓, ⇄). The runs list shows each run's cost (a chip on a phone) and a chip for a budget, stall, error or cancel stop; a task card and the task's runs view show its last 30 days: runs, cost, tokens and the average cost of a successful run (`spend30d.succeeded`, `spend30d.avgSuccessCostUsd`). Run responses carry the tier as `tier: { start, max, current, escalations, model }`. Cost-aware alerts: [operations runbook](docs/runbooks/operations.md#the-run-budget-meter-stop-reasons-and-cost-alerts).

![The run page: policy, tier and model chips over the budget meter](docs/images/run-budget-meter.png)

### CLI, SDK and MCP

The same policies are reachable from scripts and agents ([docs/mcp.md](docs/mcp.md#agent-policies), [apps/cli/README.md](apps/cli/README.md#agent-policies), [packages/sdk/README.md](packages/sdk/README.md)).

- **CLI:** `hexactra policies list|show|export|import|default`, and `--policy <id|name|builtin key>` on `runs start`, `tasks run|create|update` and `schedules create`. `runs list|show` and the terminal UI show each run's policy and cost (and tier, budget use and stop reason when the API reports them).
- **MCP:** `policies_list`, `policy_get`, `policy_create`, `policy_update`, `policy_set_default`, `policies_export`, `policies_import`, and `policy_id` on `run_goal`, `task_create`, `task_update`, `task_run` and `schedule_create`. Each tool calls the REST route as the caller, so `agent_policies:read` / `:write` apply: a read-only user is refused the write tools with `403`. Deleting a policy is not an MCP tool.
- **SDK:** `hx.policies.list|get|create|update|setDefault|export|import`, `hx.tasks.create|update|run` and `hx.runs.start` (each with `policyId`), and the exported `AgentPolicySpec` type.

## Layout

```
apps/api/          NestJS API: src/platform/ binds the packages (slices/ + one folder per optional slice), src/notes/ is the sample feature
  prisma/          fragments/ (your models), schema/ (GENERATED), migrations/, platform.lock, seed.ts
apps/web/          React app: App.tsx (routes, the packaged shell), slices/ (one file per optional slice), config/ (the two settings registries, the navigation), theme.ts, pages/
apps/cli/          the CLI: createCli() with this app's identity
packages/shared/   identity.json: the ONE identity source (name, repository, CLI name, colours); slices.json: the ONE slice manifest
infra/             platform fragments GENERATED by platform-infra sync, plus your app.* overlays
scripts/rename.mjs rebrand this app (identity.json plus the few literal targets)
```

## Run it

Needs Node 24 and Docker.

```bash
git clone https://github.com/marinoscar/hexactra.git
cd hexactra
npm install
npm run setup                    # builds the CLI and writes infra/compose/.env
docker network create devnet     # once per host
cd infra/compose && docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml up
```

Then, with the same `-f` files, migrate and seed (the API never migrates on startup):

```bash
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml exec api npm run prisma:migrate
docker compose -f base.compose.yml -f dev.compose.yml -f devdb.compose.yml exec api npm run prisma:seed
```

Three values nothing can generate go in `infra/compose/.env`: `INITIAL_ADMIN_EMAIL` (your Google account; it is always allowed in and becomes the administrator), `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The application is at http://localhost:3535.

Checks, as CI runs them (`.github/workflows/ci.yml`):

```bash
npm run platform:check     # installed migrations, composed schema and infra fragments equal the packages'
npm run typecheck
npm test                   # API (with runPlatformConformance), web and CLI
npm run build
npm run test:db --workspace=api   # the whole app against a migrated, seeded PostgreSQL
```

## Add your first feature

`apps/api/src/notes/` is a complete feature in seven small files. Copy its shape; each step below names the package documentation it follows.

1. **A model.** Write it in `apps/api/prisma/fragments/<feature>.prisma`, with an `extend model User { ... }` block for the back-relation, then:

   ```bash
   cd apps/api
   npm run db:compose                                    # platform fragments + yours -> prisma/schema/
   npm run prisma:generate
   npm run prisma:migrate:dev -- --name add_<feature>    # your migration sorts after the installed ones
   ```

   A model with a foreign key to `User` is registered in the user-owned data registry with its purge and export policy, and classified in the model ownership registry (`notes.ownership.ts`, registered after the platform's own models by `src/platform/registrations.ts`); the conformance suite, which checks the whole composed schema, fails until it is. Catalog: [`platform-db` extension points](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-db/README.md#extension-point-catalog), [scoped data access](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/core/README.md#extension-point-catalog).
2. **A permission.** Declare it as data (`notes.permissions.ts`), add the map to `app.permissions` in `src/platform/permissions.ts` (the registry and the seed both read it, after the platform's), and put `@Auth({ permissions: [...] })` on every route: there is no global guard, so a route without `@Auth()` is public. Validate every body with zod (`notes.schemas.ts`). Catalog: [identity](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/identity/README.md#extension-point-catalog).
3. **A settings namespace and its card.** Register the namespace before `SettingsModule.forRoot()` (`notes.settings.ts`); append its card to `apps/web/src/config/adminSections.tsx` or `userSettingsSections.tsx` with the exact permission string its route enforces. Never add a settings page as a tab of another. Catalog: [settings (API)](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/settings/README.md#extension-point-catalog), [settings (web)](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-web/src/settings/README.md#extension-point-catalog).
4. **A job.** Anything that outlives a request is a registered job handler (`notes-archive.job.ts`); a `@Cron` only decides whether work is due and enqueues it. A job `type` is permanent once jobs of it exist. Catalog: [jobs](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/jobs/README.md#extension-point-catalog).
5. **A Doctor check.** One read-only provider that registers itself (`notes.doctor-check.ts`); it appears at `/admin/settings/doctor`. Catalog: [doctor](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/doctor/README.md#extension-point-catalog).

Then add the module to `apps/api/src/app.module.ts`, its page to `apps/web/src/App.tsx`, and tests beside the notes ones.

## Optional slices

The core is always mounted: the API host (the event bus, the platform's app metrics, maintenance mode at `/api/admin/maintenance`, the `{ data }` envelope, request ids, the API reference at `/api/docs`: [host](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/host/README.md)), identity, settings, worker-node credentials, jobs, the Doctor and the data resets (the user Danger Zone at `/settings/danger-zone`, the admin factory reset and organization offboarding: [user-data](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/user-data/README.md)). Everything else the platform ships is an **optional slice**, and **which slices this app mounts is one list**: `enabled` in [`packages/shared/slices.json`](packages/shared/slices.json). The API and the web app both read it, so they cannot disagree.

| Slice | What you get | Requires | Notes |
|---|---|---|---|
| `credentials` | The encrypted credential store (deployment, user and organization tiers) | none | No pages. Needs `SECRETS_ENCRYPTION_KEY`. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/credentials/README.md) |
| `storage` | Uploads (`/api/storage`), profile pictures (Profile page), the storage admin page | `credentials` | Bucket, region and key are set at `/admin/settings/storage`, never in `.env`. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/storage/README.md) |
| `email` | SES and SMTP transports, templates, the email settings page | `credentials` | Set at `/admin/settings/email`. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/email/README.md) |
| `notifications` | The bell and live inbox, preferences, email delivery, **Web Push**, admin broadcasts; the identity notices stop being log lines | `email` | Web Push: an administrator generates a VAPID key pair at `/admin/settings/push`; the service worker is `apps/web/src/sw.ts`, served at `/sw.js`. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/notifications/README.md) |
| `sharing` | Groups, members, invites, grants, link shares and the public `/s` page, and a sample shareable record (`/api/documents`) | `notifications` | A shareable record belongs to an organization, so the sample is a `Document`, not the personal `Note`; the README has the other shapes. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/sharing/README.md) |
| `ai` | The provider gateway (keys at three tiers, models, usage) and its admin and key pages | `credentials`, `storage` | Off until an administrator enables it at `/admin/settings/ai`. Server-side only. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/ai/README.md) |
| `db-backup` | Scheduled and on-demand `pg_dump` to object storage, retention, a guarded restore | `storage`, `notifications` | Needs a direct database connection (no transaction-mode pooler); the API image carries the pinned client. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/db-backup/README.md) |
| `exports` | Signed, expiring exports of a user's or an organization's data | `storage`, `notifications` | The sample feature's notes source is the example. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/exports/README.md) |
| `onboarding` | The welcome dialog, Get started, the administrator's Setup guide, activation metrics | none | A step shows only when the page it links to exists in the enabled slices. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/onboarding/README.md) |
| `android-app` | Trusted-app asset links, hosted APK releases, the Android push channel | `storage`, `notifications` | The server half; the Kotlin shell is built by the CLI's `android` command. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/android-app/README.md) |
| `telemetry` | The OpenTelemetry export gate, the GreptimeDB connection, the SQL Explorer (with an AI assistant when `ai` is on), the Telemetry Dashboard and its metric groups, the `telemetry.*` Doctor checks | `credentials` | Off until an administrator saves a connection and turns collection on at `/admin/settings/telemetry`; the SDK starts only with `OTEL_ENABLED=true`. [README](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-api/src/telemetry/README.md) |

Not in the starter yet: the web conformance call (`runPlatformWebConformance`); `src/__tests__/slices.test.ts` covers the registries.

**Turn a slice off** by deleting its line from `enabled`. Order does not matter, and a slice that requires one you removed fails at startup naming both, with the line to add or remove. Nothing else changes: its routes answer 404, its cards, pages, providers, banners and jobs are not mounted, its permissions are not seeded, and its `forRoot()` never runs. Its tables stay in the schema (the platform's migrations are one history), unused.

**Turn a slice on** by adding its id, then:

```bash
cd apps/api && npm run prisma:seed       # seeds the permissions its routes check (upserts only)
```

and restart. Nothing else is required in code: the slice's runtime configuration (a bucket, an email transport, an AI key, a VAPID key pair) is set in the admin UI, never in `.env`.

**Remove a slice's code for good** (not just switch it off): delete `apps/api/src/platform/<id>/`, `apps/web/src/slices/<id>.tsx`, their lines in `apps/api/src/platform/slices/definitions.ts` and `apps/web/src/slices/definitions.ts`, and the slice's entry in `catalog` and `enabled` of `slices.json`.

**Peer dependencies.** The platform packages mark every peer their always-mounted core does not need as *optional*, and npm never installs an optional peer, so this app declares the peers of the slices it imports itself (`apps/api/package.json`, `apps/web/package.json`). The lists come from [`packages/platform-slice-peers.json`](https://github.com/marinoscar/EnterpriseAppBase/blob/main/packages/platform-slice-peers.json) in the platform repository, and `node scripts/check-slice-peers.mjs --app apps/api` (the platform repository's check, run in CI against this starter) fails when an imported slice's peer is not declared. On the API every optional slice above runs on the peers of the always-mounted core (`@nestjs/*`, `fastify`, `passport`, `@prisma/client-runtime-utils`, `@opentelemetry/api`, `zod` and friends), so removing an API slice removes no dependency. On the web, two slices bring peers of their own, which you may remove together with the slice's code:

| Slice | Web peers only it needs |
|---|---|
| `ai` | `@mui/x-data-grid` (its lists use the packaged data table) |
| `telemetry` | `@mui/x-charts`, `@mui/x-data-grid`, `@uiw/react-codemirror`, `@codemirror/lang-sql` |

The root `package.json` carries `overrides: { "fastify": "^5" }` because `@nestjs/platform-fastify` pins one exact `fastify` and the API declares the peer range: without it npm installs two copies and the Fastify plugin types stop matching.

`@mui/x-data-grid` stays while either slice, or any other page of yours that uses the packaged data table, remains.

**Where a slice lives.** On the API, `src/platform/<id>/` holds `<id>.slice.ts` (what the slice mounts, replaces and contributes: its modules, host-port overrides, registrations, notifications, storage prefixes, settings namespaces), its `forRoot()` configuration (`*.config.ts`), its host-port adapters and its **minimal example**; `src/platform/slices/` is the loader. A slice definition runs nothing on import: everything lazy sits behind a function that is called for an enabled slice only. On the web, `src/slices/<id>.tsx` is the slice's routes, cards, providers and shell parts; `src/slices/manifest.ts` composes the enabled ones into `App.tsx` and the two registries in `src/config/`.

| Slice | Minimal example |
|---|---|
| `credentials` | `credential-purposes.ts`: a purpose the sample feature could keep a webhook secret under |
| `storage` | `storage-prefixes.ts`: the key prefix of files attached to a note |
| `email` | `templates/notes-archived.email.ts`: an app template, typed through `EmailTemplateDataMap` |
| `notifications` | `notes-archived.notification.ts`: an event raised by the sample archive job after its write commits |
| `sharing` | `documents/`: the `document` resource type (`document.resource-type.ts`), its service deciding every record with `AccessPolicy` and its controller; the `Document` model is an organization's row with row-level security (`prisma/fragments/documents.prisma`) |
| `ai` | `notes-summary.feature.ts`: a registered feature and a service calling `AiService.forUser` |
| `db-backup` | `restore-carry-over.ts`: a table whose rows survive a restore |
| `exports` | `notes.export-source.ts`: a shaped, filterable export of the notes |
| `onboarding` | `onboarding.manifest.ts`: a fact and a "write your first note" step |
| `android-app` | `device-source.ts`: the device source a native capability replaces |
| `telemetry` | `activity.metric-group.ts`: a Telemetry Dashboard section of the app's own (sign-ins and token refreshes by outcome), one option of `TelemetryModule.forRoot` |

**Tests.** `test/slices.spec.ts` and `src/__tests__/slices.test.ts` check the manifest rules; `test/slices-composition.spec.ts` and the web twin compose the core alone and each slice with only what it requires, and prove it mounts, the others are absent, its permissions are seeded only while it is on and the host ports it replaces are replaced; `test/slices.db.spec.ts` probes one route per slice against a real database, 404 when off. `test/conformance.spec.ts` runs the enabled slices' conformance suites; `test/ai-conformance.spec.ts` runs the five AI suites that boot the app (kill switch, RBAC matrix, secret egress, key policy, jobs server-only) over a mocked database, with the fixture in `test/ai-conformance/` (no PostgreSQL needed). `test/documents.db.spec.ts` proves the sharing slice's sample record end to end under row-level security.

## Rename

```bash
node scripts/rename.mjs --name "Kappa Hub" --repo kappa/kappa-hub --theme "#c62828" [--cli-name kappactl] [--dry-run]
```

It writes `packages/shared/identity.json`, edits the literal targets nothing can derive (the root `package.json` name, this README, `install.sh`, the two SVG fills, the CI test database, the CLI `bin` key), and re-renders `infra/` with `platform-infra sync`. It never commits.

## Upgrading the platform

Renovate (`renovate.json`) opens one pull request that moves every `@marinoscar/platform-*` package to the same version. After merging it:

```bash
npm install
cd apps/api && npm run db:sync && npm run db:compose && npm run prisma:generate   # new platform migrations and fragments
cd ../.. && npm run platform:infra:sync                                           # new infra fragments
npm run platform:check
```

Order matters for migrations: `db:sync` installs the package's new migrations first, then `prisma migrate dev` authors yours after them. Read each package's `CHANGELOG.md` for upgrade notes.

**The `next` channel.** Pre-releases are published under the `next` dist-tag. To try one, install it explicitly (`npm install @marinoscar/platform-api@next ...`, every platform package at the same version), or set `"followTag": "next"` on the platform rule in `renovate.json`.

## Changing the platform

The platform's code is not in this repository, on purpose: an app that edits a copy drifts from every other app. When you need something the packages do not offer (a port, a registry, an option):

1. [File a seam request](https://github.com/marinoscar/EnterpriseAppBase/issues/new?template=seam_request.yml) in the platform repository: what you need, where, and why the existing extension points do not cover it.
2. Work around it in your own code, behind your own interface, until the release that adds the seam.

## License

MIT — see [LICENSE](LICENSE).
