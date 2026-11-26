# Runbook: operating Hexactra (console + fabric)

Day-2 operations for the stack in [vps-stack.md](vps-stack.md): what holds state, how to back it up and restore it, how to upgrade, and how big a machine you need. In the commands, `$F` is the compose file list from that runbook:

```bash
F="-f base.compose.yml -f prod.compose.yml -f app.fabric.compose.yml"   # + -f devdb.compose.yml for the bundled Postgres
```

## 1. What holds state

| Where | What | Sensitivity |
|---|---|---|
| Postgres (the console) | Users, roles, tasks, runs and steps (redacted), questions and their answers (never a secret), single-use action tokens (sha256 only), schedules, notifications, alert rules and incidents, webhooks, the encrypted credentials (the fabric service token, AI keys) | Encrypted secrets inside; back up with the `SECRETS_ENCRYPTION_KEY` kept separately |
| Object storage (the console) | Run screenshots, database backups | Screenshots can show what was on screen |
| Volume `fabric-control-data` | The control plane's state database `control.db`: hosts, host credentials (digests), sessions, handoffs (token digests; a `secret` answer is held in memory only, never written), host commands; its webhook registry | Digests only: no raw tokens |
| Volume `fabric-host-data` | The browser profiles of the bundled host (optional; nodes keep their profiles on the node, see [docs/nodes.md](../../../docs/nodes.md)): cookies and live sign-ins | **Secret**: whoever has a profile is signed in as you |
| `infra/compose/.env` | `JWT_SECRET`, `COOKIE_SECRET`, `SECRETS_ENCRYPTION_KEY`, `HEXACTRA_FABRIC_OPERATOR_TOKEN`, database password, and with the built-in secrets store on `SECRETS_STORE_KEY` (and `SECRETS_STORE_KEY_PREVIOUS` during a rotation) | Secret; keep it apart from the backups. **Losing `SECRETS_STORE_KEY` loses every saved login of the built-in store for good** |
| Postgres (secrets) | `secrets_connections` (a Vault connection's address, client id, status, error code; no token), `secrets_activity` (what the agent used: value-free, 180 days), the encrypted Vault tokens in the credential store; with the built-in store, the Vault tables (ciphertext) and `secrets_store_data_keys` (wrapped per-owner keys) | No login, password, code or card is readable from a backup without the keys in `.env` ([security-secrets.md](../security-secrets.md)) |
| Postgres (connections) | `connections` (label, provider, the account's address, switches, status and reason code: in the clear), `task_connections`, `conversation_connections`, mail triggers and their event history, deliveries and their log (recipient addresses, destinations and file names are in the clear; the log has closed codes and counts, never content); the refresh and access tokens, and the Google and Microsoft client secrets, are rows of the encrypted credential store | Tokens and app secrets are ciphertext under `SECRETS_ENCRYPTION_KEY`; the rest is metadata that shows who the owner corresponds with ([security-connections.md](../security-connections.md)). A restore without the key leaves every connection to be connected again |

Other browser hosts (your desktop, other machines) keep their profiles on their own disk. Back them up there.

## 2. Back up

**Postgres.** Use **Administration → Database backup**. It streams `pg_dump` into object storage on a schedule or on demand.

**The fabric volumes.**
1. Stop the services for a consistent copy. Stopping `fabric-host` gives the browsers 30 s to flush their cookies.
2. Archive each volume.
3. Start the services again.

Hosts reconnect on their own, and runs waiting for a person keep waiting.

```bash
cd infra/compose
mkdir -p ~/hexactra-backups
docker compose $F stop fabric-host fabric-control
for svc in fabric-control fabric-host; do
  docker run --rm --volumes-from "$(docker compose $F ps -aq $svc)" -v ~/hexactra-backups:/backup alpine:3.22 \
    tar czf "/backup/$svc-$(date +%F).tgz" -C /data .
done
docker compose $F start fabric-control fabric-host
```

CI runs exactly these steps on a fresh stack, then checks the host is back online (`console/scripts/stack-smoke.sh`).

- Encrypt `fabric-host-*.tgz` before it leaves the machine (for example with `age` or `gpg`).
- Keep `.env` in a password manager, not next to the archives.

## 3. Restore

1. **Postgres.** Restore from **Administration → Database backup**, or with the guided manual restore it shows (the platform's [database-restore spec](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/specs/database-restore.md)). Keep the same `SECRETS_ENCRYPTION_KEY`, or the stored credentials cannot be decrypted.
2. **The fabric volumes.** Restore into the stopped services:
   ```bash
   docker compose $F stop fabric-host fabric-control
   for svc in fabric-control fabric-host; do
     docker run --rm --volumes-from "$(docker compose $F ps -aq $svc)" -v ~/hexactra-backups:/backup alpine:3.22 \
       sh -c "rm -rf /data/* && tar xzf /backup/$svc-<date>.tgz -C /data"
   done
   docker compose $F start fabric-control fabric-host
   ```
3. **Check.**
   - Administration → Doctor reports the `fabric.*` checks.
   - Fleet shows the hosts online.
   - A profile you were signed in to is still signed in.

## 4. Upgrade

```bash
git pull
cd console/infra/compose
docker compose $F build
docker compose $F run --rm --no-deps api npm run prisma:migrate   # when the release notes say so; the API never migrates on start
docker compose $F up -d
```

- **Order.** The console tolerates a fabric that is briefly away: Doctor reports it, and runs fail with a clear error. Upgrading both at once is fine.
- **Back up first.** Take section 2's backups before an upgrade with a migration.
- **Check.** `docker compose $F ps` shows every service healthy, and Administration → About shows the new version.

## 5. Capacity

Measured numbers, and how to size a machine: [capacity.md](capacity.md).

## 6. Watching it

- **Alerts.** Administration → Alerts. It ships rules for a browser host offline (or the fabric unreachable), a browser profile signed out of Google, a schedule failing 3+ runs in a row, a user's runs over their token, cost or budget limits, a user's runs stalling, and one expensive run (off by default); see [the run budget meter, stop reasons and cost alerts](#the-run-budget-meter-stop-reasons-and-cost-alerts).
- **Telemetry.** Administration → Telemetry. The Browser agents group charts runs, steps, waits for a person and model tokens. To trace across console and fabric, set `HEXACTRA_FABRIC_OTLP_ENDPOINT` ([vps-stack.md](vps-stack.md)). With the telemetry slice on, every run job is also one OpenTelemetry trace: see [Reading a run's trace](#find-a-runs-trace-and-read-it).
- **Doctor.** Administration → Doctor. It runs the `fabric.*` checks: reachability, token, hosts online, event stream; and `runs.retention`: when the nightly run retention job last succeeded ([run-retention.md](run-retention.md)).
- **About.** Administration → About (`system_settings:read`). What is deployed: the console version, the deployment mode, the record `hexactra deploy` leaves on disk (commit, ref, install and update times, the last run's outcome and failed step, the proxy and certificate expiry, the host, the deploy history), database liveness, and a **Hexactra Fabric** section (URL, fabric version, reachable, browser hosts online and with a browser connected). The service token is never shown. API: `GET /api/admin/about`.

### Agent policies in operation

What an administrator sets, in the order a run meets it: the deployment's [model tiers](#model-tiers), the [model prices](#model-prices), the [ceilings](#budget-ceilings-run-time-and-why-a-run-stopped), then what the run reports ([meter, stop reasons and alerts](#the-run-budget-meter-stop-reasons-and-cost-alerts)). Users' own policies, tiers and default are in the console's settings ([README](../../README.md#agent-policies)). The three administrator pages are under Administration → Browser agent and read with `system_settings:read`.

### Model tiers

The browser agent picks its model by tier (Fast, Standard, Frontier; [README, Model tiers](../../README.md#model-tiers)). The deployment's default tiers are the `browserAgentTiers` system setting (Administration → Browser agent → Agent model tiers).

- **Where.** `PATCH /api/system-settings` with `system_settings:write`: `{ "browserAgentTiers": { "standard": { "model": "<provider>:<model id>", "reasoningEffort": "low", "maxOutputTokens": 4000, "fallbackModel": null }, "frontier": { "model": "<provider>:<model id>", "reasoningEffort": "high" } } }`. A PATCH merges per tier and per field; `null` clears a field. The model is named as the catalogue names it (Administration → AI → Models), and must be enabled there and support tool calls. Each user may override any field in their own settings.
- **A fresh deployment** has every tier unset: each user's own default model (AI settings) is used for all three tiers, and a run with no model anywhere fails with `No model selected`, naming the Model tiers page. Set at least Standard to give every user a working model.
- **A good starting pair:** one capable model on Standard at `low` effort and the same model on Frontier at `high` effort (prompt caching stays warm on an escalation); add a smaller model on Fast for the Economy policy.
- **Changing them** affects runs that start afterwards. A run in flight keeps the models it started with.
- **Prices.** Give every tier's model (and fallback) an entry in [Model prices](#model-prices), or the run's cost is a lower bound.

### AI usage rollups

Usage and cost reports (#730) read hourly sums of the AI usage ledger, not every call, so a year stays fast and outlives the ledger's own retention.

- **What.** `ai_usage_hourly`: one row per UTC hour × organization × user × provider × model × operation × feature × key source, with requests, failed requests, input, cached input, output and reasoning tokens, latency and non-token units. Counts and ids only. `ai_usage_rollup_state.rolled_until` says how far the rollups go.
- **The job.** `usage.rollup` is enqueued every 15 minutes (at :07, :22, :37 and :52). It re-rolls from two hours before `rolled_until` up to the start of the current hour, replacing those hours in one transaction per week of data. It is idempotent, and it picks up ledger rows written late. The first run rolls the whole ledger. It deletes rollup hours older than 25 months. It calls no model, so it keeps running while AI is switched off.
- **Reads.** A report takes the rollups before `rolled_until` and the ledger from there on, so it is never behind and never counts an hour twice. Catalogue syncs are left out of reports by default.
- **Retention.** The ledger keeps `ai.usageRetentionDays` (180 by default; drill-down beyond the rollups needs the ledger). The rollups keep 25 months. Shortening the ledger's retention is safe once `rolled_until` is current.
- **Check it.** `SELECT rolled_until FROM ai_usage_rollup_state;` should be within the last hour. Administration → Jobs lists `usage.rollup` runs. Each run logs `usage.rollup windows=… hours=… rows=… purged=… rolledUntil=…`.

### Model prices

Every model call the browser agent makes is priced, so a run, a task (last 30 days) and the platform's AI usage report can show money as well as tokens. The console ships no prices: they change, and they are your contract with a provider.

- **Where.** Administration → Browser agent → Model prices, or the `agentPricing` system setting (`PATCH /api/system-settings`, `system_settings:write`): `{ "agentPricing": { "models": { "<provider>:<model id>": { "inputPerMTok": 3, "outputPerMTok": 15, "cachedInputPerMTok": 0.3 } } } }`. The key is the provider id, a colon and the model id exactly as the provider reports it for a call (the model that served it, as listed in Administration → AI → Models and Usage). A PATCH replaces the whole `models` table.
- **Units.** USD per **million** tokens. `cachedInputPerMTok` is optional: without it, input tokens served from the provider's cache are billed at the input price. Prices cannot be negative.
- **Unpriced models.** A call on a model that is not in the table has no price, and counts as unknown, never as free. The run's `costKnown` becomes `false` and its cost is a lower bound: show it as "at least" (≥ $x.xx). Add the model's price to make later runs exact. Earlier runs are not re-priced, and runs from before cost tracking stay unknown.
- **A user's own prices** (#735). Settings → My model prices (`agentPricing` in `PATCH /api/user-settings`) replaces the deployment's price of a model for that user only: their runs' cost and cost budgets (read at the start of each run job, like the deployment's table) and their own usage report. The deployment-wide usage report (Administration → AI usage & cost) and other users keep the deployment's prices. A run's stored cost is never re-priced.
- **Same table, two uses.** The platform's usage report (Administration → AI → Usage) reads it through the `AI_PRICING` port: it shows `priced: true` and a cost per model, and a model with no price has no cost there either.
- **Is usage being recorded?** The Doctor check `ai.usage_ledger` (Administration → Doctor, `GET /api/admin/doctor`) compares the last 7 days of the runs' own input tokens (`runs.input_tokens`) with what the AI usage ledger (`ai_usage_events`) holds for the browser agent. It **fails** when runs used tokens but the ledger has under half of them, and warns when every recorded model call carries no token counts (a provider that reports no usage). Catalogue syncs are rows with no tokens by design. The platform writes each ledger row best effort: a failed write is only a `Could not record AI usage (...)` warning in the API log. Until 1.105.2 every model call's row was lost that way (`this.prisma.forOrg is not a function`, #731), so Administration → AI Usage showed requests with 0 tokens and no cost. Rows lost before the fix cannot be recovered; the runs' own token and cost counters were not affected.
- **Metrics.** `app.runs.model_calls` (counter) and `app.runs.cost` (histogram, USD, one value per finished run whose calls were all priced). Neither carries a user or run label.
- **Stop.** `app.runs.stop_latency_ms` (histogram, label `status`) is the time from the owner's Stop to the run's terminal status; the API also logs `run <id>: Stop took <n> ms (<status>)`. It should sit under 2000 ms: the worker hears Stop on the event bus at once and polls the flag every second as the fallback. A high value means a long action on the host (the fabric cannot cancel an action it is running) or a worker that is not polling. How it works: [runs.md, Stop](../runs.md#stop-e381).

### Budget ceilings, run time and why a run stopped

- **Budgets belong to the policy.** A run's limits (actions, model calls, active minutes, tokens, cost) come from its agent policy, snapshotted when the run starts ([README, Budgets](../../README.md#budgets)). Edit the limits in the policy, not on the task: a task's `maxSteps`, `maxMinutes` and `model` fields are deprecated and removed in the release after the one that introduced agent policies.
- **Ceilings.** Administration → Browser agent → Agent budget ceilings (API: `PATCH /api/system-settings`, `system_settings:write`) holds `browserAgentCeilings`: `{ "browserAgentCeilings": { "maxActions": 200, "maxModelCalls": null, "maxActiveMinutes": 120, "maxInputTokens": null, "maxOutputTokens": null, "maxCostUsd": 25 } }`. Each key is the most any agent policy may allow a run; `null` (the default) sets no ceiling. A PATCH changes only the keys it names. A run's limit is the smaller of its policy's and the ceiling, and a ceiling also caps a policy that is unlimited, so set one if no user should ever be able to run without a hard stop. The effective numbers are fixed when the run starts: a changed ceiling applies to the next run, never to one in flight.
- **Run time counts active time only.** The time a run spends in `running` counts toward `maxActiveMinutes`; time waiting for a person (a handoff or a question) never does, so a run that waited two hours for a code resumes with its remaining active time intact (`runs.active_ms`, `runs.active_since`). A run that outlasts one job (30 minutes of work) continues in a new `browser.goal.run` job (reason "Run continued in a new job") and stays `running`: you will see two or more jobs for one run in Administration → Jobs.
- **Reading `stop_reason`.** `runs.stop_reason` says why a run ended: `finished` (the model called finish, or answered), `budget_actions`, `budget_model_calls`, `budget_active_time`, `budget_input_tokens`, `budget_output_tokens`, `budget_cost` (that budget was used up; the run made one wrap-up call and kept the model's summary; it is `succeeded` only when the wrap-up reported success), `stalled` (no progress), `cancelled`, `error` (a failure in the runner or the job; `error` holds the text) and `no_model` (no model could be chosen). It is `null` for runs from before the column. A chat run (`trigger = 'chat'`) never has a budget stop reason: its budgets are soft (#537, `policy_snapshot.effectiveBudget.enforcement = 'soft'`), so the run-budget alert, which counts `budget_*` stop reasons, does not count chat runs. A budget stop ends the run as `failed` with the budget's message (for example `Step budget exhausted` or `Time budget exhausted`) in `error`. To count the last day's budget stops: `SELECT stop_reason, count(*) FROM runs WHERE stop_reason::text LIKE 'budget_%' AND created_at > now() - interval '1 day' GROUP BY 1;`. The run's `budget.source` tells you whether the policy or a ceiling set the limit that stopped it.

### The run budget meter, stop reasons and cost alerts

- **The meter.** A run's page (`/runs/:id`) shows its policy, its current tier and model, and one bar per limited budget: used / limit and the percent. A bar turns orange at the policy's `warnAtPercent` and red at 100%; "(ceiling)" means the deployment ceiling, not the policy, set that limit. An unlimited budget shows only what was used, with "∞". "≥ $x" means a call was on a model with no price: add it to [Model prices](#model-prices). The numbers come from the run's `budget` (`GET /api/runs/:id`, and every `run` event of its stream), so the page needs no reload; active time also ticks on the page between events.
- **Stop reasons.** A finished run says why in one line, from `stop_reason`: "Stopped: cost budget reached ($2.00)." (and the five other budgets, with their limit), "Stopped: stalled (…)", "Stopped: cancelled.", "Stopped: an error ended the run." (with the error), "Stopped: no usable model for this run's tier." or "Finished: …". A budget or stall stop keeps the agent's wrap-up summary under it. The runs list shows the same as a chip (`cost budget`, `stalled`, `no model`; a plain error or cancellation is the status itself) next to each run's cost.
- **Routing rows.** When a run escalates a tier, steps back down, or switches to a fallback model, its timeline shows a row of its own: "↑ Frontier: …", "↓ Standard: …", "⇄ fallback model: …". These are `routing` steps; they do not count as actions.
- **Task spend.** A task card shows its last 30 days: runs, cost, tokens and the average cost of one successful run. A task that spends a lot per success is a candidate for a cheaper policy, a narrower goal or a tighter cost budget.

The console's alert rules (Administration → Alerts, created once by key; an edited or disabled rule is never reset):

| Rule (key) | Kind id (permanent) | Fires when | Starter config |
|---|---|---|---|
| Run budget exceeded (`hexactra.run_budget`) | `hexactra_run_budget` | In `windowHours`, one user's runs used more than `maxTokens` tokens, or more than `maxCostUsd` US dollars (`runs.cost_usd`; `null` checks no cost), or `maxBudgetStops` runs ended on a `budget_*` stop reason | `{ windowHours: 24, maxTokens: 2000000, maxCostUsd: null, maxBudgetStops: 5 }`, enabled |
| Runs stalling (`hexactra.run_stalled`) | `hexactra_run_stalled` | In `windowHours`, `minStalls` or more of one user's runs ended `stalled` | `{ windowHours: 24, minStalls: 3 }`, warning, enabled |
| Expensive run (`hexactra.run_cost`) | `hexactra_run_cost` | One run created in the last `windowHours` cost more than `maxRunCostUsd` | `{ maxRunCostUsd: 10, windowHours: 24 }`, **disabled** |
| Run keeps being interrupted (`hexactra.run_recovered`) | `hexactra_run_recovered` | One run created in the last `windowHours` was recovered `minRecoveries` or more times after its job was interrupted (`runs.recoveries`) | `{ minRecoveries: 4, windowHours: 24 }`, warning, enabled |
| Delivery keeps failing (`hexactra.delivery_failing`) | `hexactra_delivery_failing` | One delivery after a run (an email, a spreadsheet row, a file, a webhook) failed `minFailures` or more times in `windowHours` (`run_deliveries.status = 'failed'`). The summary names the kind and the task, never an address or a destination; the run's page and `hexactra runs deliveries <run>` say why | `{ minFailures: 3, windowHours: 24 }`, warning, enabled |
| Browser profile signed out (`hexactra.profile_signed_out`) | `hexactra_profile_signed_out` | A browser profile on a host is `signed_out` of Google, or (with `includeExpired`) its Google session is `expired`, as the node last reported it (E48, [decision record](../../../docs/decisions/profile-signin-health.md)). One incident per host and profile, labelled `host.id`, `host.name` and `profile`; `profiles` (empty: every profile) limits it to some profile names. `unknown` (never checked, a failed check, or the checks disagree) never fires; like a signed-in profile, it resolves an open incident. The summary names the host and the profile, **never the account's email** (alerts reach channels outside the console). Fix it from Fleet: the profile's **Sign in** | `{ includeExpired: true, profiles: [] }`, warning, held 10 minutes (`forSeconds: 600`, so a sign-in in progress pages nobody), enabled |
| Monthly AI spend (`hexactra.ai_spend_monthly`) | `hexactra_ai_spend_monthly` | This calendar month's AI spend (UTC; every model call, priced at the deployment's prices, from the usage rollups) reached `warnAtPercent` of `maxDeploymentUsd` (the deployment) or of `maxUserUsd` (any one user, named by id). `null` skips that check. See [docs/usage.md](../usage.md#alerts) | `{ maxDeploymentUsd: 500, maxUserUsd: null, warnAtPercent: 80 }`, **disabled** |

- **Tuning.** Set `maxCostUsd` on the run-budget rule to about a day's acceptable spend per user once [Model prices](#model-prices) cover your models (without prices every cost is 0 and the threshold never fires). Raise `minStalls` if users run many exploratory goals; lower it to 1 for a scheduled task that must never loop. Turn the expensive-run rule on when anyone uses the Unlimited policy or a policy without a cost budget, with `maxRunCostUsd` a little above the cost of a normal long run (the task spend line gives the average).
- **What the summary carries.** The run's short id and its task's name (or, for a one-off goal, the goal cut to 80 characters with secret-looking values such as `password: …`, `token=…` and long keys masked), and amounts as "$x" or "≥ $x". Never the full goal, the result or a step. The notifications and `alerts.alert.*` webhooks reuse the platform's channels.
- **Resolving.** An incident resolves on its own once the condition stops: the usage window moves on, the stalls age out, or the expensive run is older than `windowHours`.

### A run that seems to burn tokens: what to check

Work down the list; each step names where to look.

1. **Open the run** (`/runs/:id`, or `GET /api/runs/:id`). The budget meter shows what it used against each limit, the policy and the tier. `modelCalls`, `costUsd` and `costKnown` give the totals.
2. **Is the policy unlimited?** `GET /api/agent-policies` marks a policy with no budget at all as `hasNoHardStop`. The built-in Unlimited has none, and only a ceiling caps it. Switch the task to Balanced or Economy, or set `maxCostUsd` on the policy or a ceiling.
3. **Is it on the strongest model?** The run's `currentTier` and `escalations` show whether a stall moved it to Frontier, and the timeline carries a "↑" row for each escalation. Escalation is bounded by the policy's `maxTier` and `stall.maxEscalations`; set `maxEscalations` to 0 to keep a run on one tier.
4. **Which model does each tier resolve to?** `GET /api/agent-policies/model-tiers/effective` lists them with where each came from (`pin`, `user`, `deployment`, `fill_down`, `ai_default`). A tier with no model borrows the nearest tier that has one (Fast borrows Standard's, Standard borrows Frontier's), so an unset Fast tier gives the Economy policy no saving.
5. **Is the cost real?** "≥ $x" means a call was on a model with no entry in [Model prices](#model-prices): the true cost is higher and the cost budget cannot stop it. Add the price. Without prices the cost alerts never fire.
6. **Is it looping?** Look for repeated steps in the timeline and the stall alert. Stall detection stops a loop only at the policy's thresholds (`maxRepeatedAction`, `noProgressActions`, `maxConsecutiveFailures`); a page that keeps changing can defeat the no-progress signal, and `onStall: ask_human` waits for a person instead of ending the run. An unattended run (a scheduled one) that stalls with nothing left to escalate to fails as `stalled` rather than waiting for a person.
7. **Is each call too large?** Chart `app.runs.input_tokens_per_call` on Administration → Telemetry → Browser agents. Input tokens dominate the bill because every call re-sends the context. Lower the policy's `callsPerChunk`, `observationChars` or `screenshotsKept` ([README, Context settings](../../README.md#context-settings)); `0` screenshots turns vision off.
8. **Find the expensive runs.** `SELECT id, task_id, cost_usd, model_calls, input_tokens, output_tokens, stop_reason FROM runs ORDER BY cost_usd DESC LIMIT 10;` and the task's last-30-day spend on its card (an average cost per successful run well above its peers points at a goal or policy to tighten).
9. **Cap it and watch it.** Set `browserAgentCeilings.maxCostUsd`, and turn on the "Expensive run" alert (below). Stop a live run from its page or `hexactra runs cancel`; Stop always works, even under Unlimited.

### Moving agent policies between users and deployments

Agent policies are personal; a JSON file is how they are shared (format and API: [console README](../../README.md#export-and-import)).

- **Export** with `GET /api/agent-policies/export?ids=all` (the signed-in user's policies and the built-ins). Add `includePins=false` for a file that carries no model id and so works on any deployment.
- **Import** with `POST /api/agent-policies/import`. The default is `rename` on a name clash; `replace` overwrites the user's same-named policy and bumps its version (runs in flight keep their own snapshot). A file is written in one transaction: if any policy is invalid, nothing is imported and `details.errors` lists every problem.
- **Read the `warnings`.** `PIN_DROPPED` means a model pin names a model that is unknown or disabled here (enable the model, or leave the tier to the user's tier definition); `EXCEEDS_CEILING` means a budget is above the deployment ceilings: it is stored as written and held to the ceiling when a run uses it.
- **Limits.** 100 policies and 256 KB per file; the file holds no ids, no user and nothing secret, so it is safe to attach to a ticket.

## 7. Questions

What agents ask people is in the console's `questions` table ([../questions.md](../questions.md)). A browser-bound question mirrors a fabric handoff; a free-standing one lives only in the console.

- **Expiry.** Every minute a cron checks for overdue pending questions and, when there are any, enqueues the `questions.expire` housekeeping job (Administration → Jobs). It marks them `expired`, withdraws their fabric handoffs, and sends `questions.question.expired` to webhooks. A question that does not expire on time means the job queue is not running: check Administration → Jobs and the API logs.
- **Delivery.** Each asked or settled question enqueues a `questions.deliver` job, which delivers it on (or withdraws it from) every channel: notifications and webhooks. A failure is logged with the channel and the error class only, never the question or the answer. Webhook deliveries and their retries are at `/settings/webhooks`.
- **Action tokens.** Notification buttons (Stop run, Approve, Remind me, a question's quick answers) and webhook answer tokens are single use, recorded in `action_tokens` as sha256 only. `questions.expire` deletes tokens that expired more than a day ago, so the table stays small; nothing else needs purging. A leaked token answers one question (or acts on one run) once, before it expires, and nothing else.
- **Webhook answer tokens.** Only questions with a public answer (choice, multi_choice, text, number, a low-risk confirm) get one, in the `answer` block of `questions.question.asked`. To stop webhook answers for a user, remove their webhook endpoints: tokens already sent keep working until their question settles or expires.
- **Secrets.** A code or password typed into a question is relayed to the fabric and typed into the page by the fabric's `type_secret` action. It is never stored by the console, never returned by an API, and the fabric keeps it in memory for at most 10 minutes. Restoring a backup cannot bring one back.

## 8. When a run went wrong: ask for its trace

A user who reports a run that did something odd, stopped early or "failed after paying" can hand you everything in one file, safe to share:

- **Ask for:** the run exported as **JSON without screenshots** — run page → **Export** → JSON trace, "Include screenshots" off (or `hexactra runs export <id> --no-screenshots`). It is masked always; without screenshots it carries no pictures of their screens. A PDF (`--pdf`) is for a person to read; the JSON is for you or a coding agent.
- **Read it:** `run` (status, `stopReason`, `result`, `error`, `confirmedActions`: steps the owner approved that were carried out), `budget` (`enforcement: "soft"` for a chat run, which is never stopped by a budget; `over` lists the budgets past their limit), `models` (the tiers used), then `steps` in order: `kind` `action`/`handoff`/`finish`/`error`, `handoff` + `action: "answered"` for the owner's answer, `guidance` for what they added in the chat, `routing` for tier changes, `end` last. A `question` on a step holds the prompt and the answer (`valueWithheld` for a secret). `masking.hits` says how much was masked.
- **Common readings:** `stopReason: "stalled"` → the stall detector (`docs/runs.md`); a `budget_*` reason on a scheduled or API run → a hard budget; a result that starts "The step you confirmed was carried out" → the run ended after a confirmed, irreversible step — check the site before running it again.
- **Never ask** for a screenshot of their bank, a password or a code; the file never holds those.

### A run will not stop

Stop should end a run in about two seconds ([docs/runs.md, Stop](../runs.md#stop-e381)). When it does not, find where the time goes before you do anything to the row.

- **Look at the run.** `SELECT status, cancel_requested, cancel_requested_at, pause_requested, worker_token, updated_at FROM runs WHERE id = '<id>'`. `cancel_requested_at` null means the press never reached the API (check the browser's network tab and the API log for `POST /api/runs/<id>/cancel`). `status` `queued`, `paused` or `waiting_human` is cancelled in the same request; only a `running` run depends on a worker.
- **How long it took.** The API logs `run <id>: Stop took <n> ms (cancelled)` when a run reaches a terminal status after a Stop, and the histogram `app.runs.stop_latency_ms` (Administration → Telemetry; label `status`) holds it. A few of them over 3000 ms are a worker-side delay; one that never records is a job nobody is driving.
- **What can legitimately take longer than two seconds.** (1) An action already sent to the browser: the fabric has no operation cancel, so the host finishes it, up to `ACTION_TIMEOUT_MS` (45 s), and the step says "Stopped by the owner while this was running"; nothing after it starts. (2) A model call whose provider ignores the abort: the run ends when the call returns and no tool of its answer runs. (3) A tool that is several fabric calls (a saved login, a saved card) finishes the field it is typing. The run page shows "Stopping…" and the step in progress; the latency is those, not a stuck run.
- **A job nobody is driving.** `worker_token` set on a `running` run whose job is gone (a worker that died) has no one to hear the Stop. The queue retries the job when its lease expires (up to the job's runtime limit, 30 minutes); the retried job sees `cancel_requested` at its start and cancels. Look at Administration → Jobs for the `browser.goal.run` job of the run (subject `browser_run`). Do not edit the run's row by hand: a run that was in the middle of a confirmed click would lose its `unknown` step ([A run recovered after a restart](#a-run-recovered-after-a-restart)).
- **Two processes.** The stop signal listens on the run event bus and polls the flag every second, so Stop works when the API and the worker are different processes or an event is lost (3 seconds at worst). If it takes much longer than that, check that a worker is claiming `browser.goal.run` jobs (Administration → Jobs) and that the database is reachable from it.
- **Still stuck.** Export the run as JSON without screenshots (section 8) and file it: the last steps show whether an action was in flight. A defect here is a harness defect (E38.1), not an operations one.

### A run recovered after a restart

A restart of the API during a run is safe: the run keeps its progress after every action and the queue retries the job (`docs/runs.md`, "Crash safety").

- **What you see.** The run page shows "The run was interrupted and continued" in the agent's log and `runs.recoveries` goes up; the counter `app.runs.recovered` and a warning log line (`recovered after an interruption`) record it. More than three recoveries of one run raises "Run keeps being interrupted": look at why the worker keeps dying (memory, deploys, a page that crashes the runner).
- **A step marked unknown.** `SELECT seq, action, phase, summary FROM run_steps WHERE run_id = '<id>' ORDER BY seq` lists the phases. A step in `unknown` was a click or typed secret that may or may not have gone through when the job died. The agent is told not to repeat it and the owner is asked again before the same button is pressed. Check the site (the order, the account's recent activity) before approving a repeat.
- **A run that does nothing after a restart.** `runs.worker_token` not null on a `running` run whose job is gone means the retry has not started yet (the job queue's lease must expire first, up to the job's runtime limit). It starts by itself; do not cancel and re-run a run that may have paid.

### Find a run's trace and read it

With the telemetry slice on and collection turned on at Administration → Telemetry, every **job** of a run is one OpenTelemetry trace, sent to the deployment's OTLP collector with the rest of the API's telemetry. Standard OpenTelemetry only: there is no viewer in the console, so open the trace in whatever the collector feeds (Grafana Tempo, Jaeger, Honeycomb, the Greptime explorer). With the slice off the spans are the API's no-op: nothing is created, and `traceId` is null.

**Find a run's trace.**

- The run page shows **Trace id** under its details, with a copy button. `GET /api/runs/{id}` has the same `traceId` (the latest job's), and the run's JSON export lists every job's in `run.traceIds`.
- A run has several traces when it waited for a person or ran long: one trace per job, oldest first in `traceIds`. Each job's root carries a **span link** to the previous job's root (`hexactra.link.type = previous_job`), so a viewer can hop from one to the next. The first job of a chat run links to the chat turn that started it (`started_by`).
- From a run id without the page: search the collector for the attribute `hexactra.run.id = <run id>` on the root span.

**The tree.**

| Span | Name | What it tells you |
|---|---|---|
| Job | `invoke_agent hexactra.browser_agent` | `hexactra.run.id`, `.run.trigger`, `.run.origin`, `.policy.id`, `.tier`, `.job.reason` (`started`, `resumed`, `continued`), and at the end `.run.status`, `.run.stop_reason`, `.job.outcome` |
| Chunk | `hexactra.chunk` | `.chunk.number`, `.tier`, `.chunk.model_calls`, `.chunk.tool_calls`. A new chunk is the only place the model changes |
| Model call | `chat <model>` (client) | `gen_ai.request.model`, `.response.model`, `.provider.name`, `.usage.input_tokens`, `.usage.output_tokens`, `.usage.cache_read.input_tokens`, `.response.finish_reasons`, `hexactra.cost_usd` (when the model is priced), `hexactra.model.fallback` (true on the tier's fallback model), `error.type` and an error status on a failed call. The platform's own `ai.request` span for the same round trip sits beside it |
| Tool call | `execute_tool <tool>` | `gen_ai.tool.name`, `.tool.call.id`, `hexactra.step.seq` (the run page's step number), `.step.ok`, `.action.type`, `.page.host` (the host only), `.gate.category` when a confirmation gate applied, `error.type` and an error status when the tool failed, timed out or was called with bad arguments |
| Fabric action | `hexactra.fabric <action>` (client) | `hexactra.fabric.action`, `.fabric.operation_id`, `.fabric.state`. The W3C `traceparent` goes to the fabric, so with `HEXACTRA_FABRIC_OTLP_ENDPOINT` set the fabric's own spans continue the same trace |
| Question | `hexactra.ask_human` | A span event when the question is asked (`hexactra.question.kind`, `.input`) and one in the **resumed** job when it was answered (`.channel`, `.outcome`, `.waited_ms`). The wait itself is never an open span |

The chat orchestrator is the same in small: `invoke_agent hexactra.chat_orchestrator` with its `chat <model>` and `execute_tool` spans. The run it starts is linked from its first job.

**Reading it.** A slow run: sort the chunk's children by duration. A model call that dominates means a big context (compare `usage.input_tokens` with [the token check above](#a-run-that-seems-to-burn-tokens-what-to-check)); a `hexactra.fabric` span that dominates means the browser, not the model. An expensive run: add up `hexactra.cost_usd` per tier. A failed run: look for the spans with `error.type`; the root's `hexactra.run.stop_reason` says why it stopped.

**What is never in a trace.** No prompt, model output, typed text, page text, URL beyond its host, selector, question or answer, memory, parameter value or secret: spans carry names, counts, sizes, durations and outcomes. There is no switch that records message content. A test (`apps/api/test/agent-trace.db.spec.ts`) types, reads and asks with marker strings and fails if one reaches a span, event, link or metric label. A trace is **not** the audit trail: the durable record of what a run did is its steps and the audit log.

**Metrics alongside** (Administration → Telemetry): `app.runs.model_call_duration` and `app.runs.model_call_tokens` by model and tier, `app.runs.tool_duration` by tool name and outcome, `app.runs.tool_calls` by tool family (`browser`, `desktop`, `accounts`, `mcp`, `human`, `control`, ...; every MCP server is `mcp`) and outcome (`ok`, `error`, `refused` by a gate). Each `execute_tool` span carries `hexactra.tool.family`, and a job's root span `hexactra.run.families_offered` and `hexactra.run.families_used` (sorted, comma-joined; an MCP server is `mcp:<connection id>` there, never in a metric label). The platform's metric registry only accepts `app.` names, so the GenAI metric names themselves are not used. Attribute names follow the GenAI semantic conventions (version in `apps/api/src/runner/trace-attributes.ts`, the one file that spells them; the conventions are still marked "Development").

## 9. External AI apps

ChatGPT, Claude and agent frameworks call the console's MCP endpoint (`/api/mcp`). Putting the console on the internet for them: [public-exposure.md](public-exposure.md); the threat model: [../security-hosted-clients.md](../security-hosted-clients.md).

- **The kill switch.** Administration → **External AI apps** → "AI apps signed in with OAuth" off, or on the box:

  ```bash
  hexactra mcp status          # the switches, the public URL check, how many apps are connected
  hexactra mcp disable         # every app signed in with OAuth gets 503 on /api/mcp, within a few seconds
  hexactra mcp disable --pat   # the same for personal access tokens over MCP (REST with a token still works)
  hexactra mcp enable [--pat|--all]
  ```

  It is the `mcp` system settings (`externalAppsEnabled`, `patMcpEnabled`), read through a cache of at most five seconds. The console and personal access tokens on REST are never affected; runs already working keep going (stop them from Runs). Doctor `mcp.kill_switch` reports both switches.
- **Rate limits.** Same page: requests per minute per connection (120), write calls per app (30), per user (600) and unauthenticated per address (30); refusals are `429` with `Retry-After`, counted by `app.mcp.rate_limited` (Administration → Telemetry). nginx adds a coarse per-address fence (`infra/nginx/app.d/{http,server,locations}/mcp*.conf`). One API process counts in memory; several replicas set `MCP_RATE_LIMIT_STORE=postgres` to share one count in the database (table `rate_limit_windows`, cleaned hourly by the job `mcp.rate_limit.purge`; [public-exposure.md, section 4](public-exposure.md#4-the-limits-that-apply)). The per-address limits key on the caller's forwarded address from the proxies `TRUST_PROXY` trusts (default: loopback and private ranges, which covers the stack's nginx; `false` makes every caller share nginx's bucket; same section).
- **Sensitive actions.** When an app signed in with OAuth drives a browser, a secret, a page with a password or payment field, a host on **Sensitive sites**, the desktop or network-reaching JavaScript waits for the owner's approval in their inbox (a high-risk confirm, `system:sensitive-action`). The owner can turn it off per app (Settings → AI apps → the app).
- **The audit trail** is the table `mcp_activity`: one row per tool call from an OAuth app or a personal access token, and per refusal (kill switch, rate limit, step-up) and limit change. No typed text, script or result. Each user reads theirs on the app's page or `hexactra apps activity`; administrators read everyone's on External AI apps (`mcp_activity:read`, `GET /api/admin/mcp/activity`). The nightly job `mcp.activity.purge` (03:40, Administration → Jobs) deletes rows past the user's run retention (365 days at most); deleting a run keeps its activity rows and clears their run id.
- **Every user's apps.** External AI apps → **Connected apps** lists every active grant with its user, scopes and last use; **Disconnect** revokes it (`oauth_clients:write`, recorded as `oauth:grant.revoke` by `admin` and in the user's activity). Doctor `mcp.high_risk_grants` counts grants holding `browser:evaluate`, `desktop:control` or `policies:write`.
- **Doctor.** `mcp.endpoint` (an anonymous call gets the `401` challenge and its metadata document answers), `mcp.public_reachability` (OAuth on but `APP_URL` not public HTTPS), `mcp.exposure` (admin routes answer `200` without a credential through the public URL), `mcp.trust_proxy` (`TRUST_PROXY=false` while `APP_URL` is public HTTPS, so every caller shares one per-address bucket).

## 10. Saved logins and the secrets providers

How it works and what it protects: [../secrets.md](../secrets.md); what stops each threat and what does not: [../security-secrets.md](../security-secrets.md). In operation there are three things you will be asked about: a run that could not sign in, a Vault that must be reconnected, and the built-in store's key.

### A run could not sign in

A run that did not sign in from a saved login **has not failed**: by design it fell back to the sign-in card and waits for the owner. For a scheduled run that means it is waiting (Inbox, and the notification) until someone answers. Work down the list.

1. **Read the Activity.** Settings → Secrets → **Activity** lists the newest 100 uses and refusals of the owner (admins see counts only: Administration → Secrets), each with the run, the site and the outcome in words. The run page says "Signed in with: …" when it worked. Find the row for the run and read the outcome:

   | Outcome shown | What it means | What to do |
   |---|---|---|
   | Refused: no provider was connected | The run had no provider registered for its owner | Settings → Secrets: connect (or choose the built-in store); check `GET /api/secrets/status` |
   | Refused: saved logins are turned off | One of the switches is off, or the other provider is the chosen one | Check, in this order: the deployment switch (Administration → Secrets), the owner's switch, the task's or chat's *Use my saved logins*, an AI app's limit `allowSavedLogins`, Vault's own Agent access, and which provider the owner chose |
   | Refused: no saved login for this page | The provider has no login **opened to agents** for this exact origin | In the provider, open the login to agents and check its site is the page's exact origin: `https://www.example.test` and `https://example.test` are different. A site that signs in on another domain (single sign-on) needs that domain listed too |
   | Refused: the page was not the saved site | The run was on another origin than the login's (a look-alike, or a redirect) | If it is the real site, add the origin to the login in the provider; if you do not know the address, treat it as a phishing attempt. The run asked the owner with a warning card and switched saved logins off for the rest of the run |
   | Refused: the field was in a frame of another site | The sign-in form is inside another site's frame | Not supported for logins: the owner signs in by hand |
   | Refused: too many requests, try again later | Vault's per-minute limit | Wait; reduce parallel runs for that owner |
   | Failed: the provider asks you to connect again (`unauthorized`) | Vault refused the token | The connection says *Reconnect*: [below](#reconnect-the-vault) |
   | Failed: the provider could not be reached (`unavailable`), or: it took too long | The address, the network or Vault is down | Administration → **Doctor**, `secrets.vault_connections`; the Vault host is listed in Doctor's egress inventory; from the console host `curl -sS -o /dev/null -w '%{http_code}\n' https://<vault>/api/agent/v1/whoami` should answer an HTTP status (`401`, or `403` when Vault's Agent access is off), not time out |
   | Refused by the provider | Vault refused for a reason of its own (a missing scope, for instance) | Vault's **Agent activity** page; reconnect with the scopes the feature needs |
   | Failed: the page address could not be read / the field could not be typed into | The browser did not report the tab's URL, or the selector the model chose did not take the text | Look at the run's screenshots; the run asks the owner |

1b. **A card payment that did not go through** has its own outcomes and instructions (an amount over the merchant grant's limit, a currency mismatch, an expired grant, a payment frame the grant does not list, a bank verification step): [../secrets.md](../secrets.md#errors-become-instructions). The fix is almost always in the provider (create or widen the merchant grant, with the owner's own session) and never in Hexactra; the run asks the owner. Incident handling for cards is in [public-exposure.md](public-exposure.md#8-saved-cards-on-a-public-console-e377).
2. **Several matching logins** is not a fault: the run asks with a choice card of names and usernames. Save only one login per site, or the owner picks.
3. **A rejected password is not retried.** A password is typed at most once per run and site; if the site refused it, the run asks the owner. Update the login in the provider.
4. **A code by text message** is never in a vault: the run asks the owner for it.
5. **Still waiting?** The run is in the Inbox with the sign-in card; the owner can answer there, take over the desktop, or stop the run. Nothing about a saved login makes a run fail on its own.
6. **Do not** look for the value in the logs: it is not there (that is the design). The run's steps say "signed in with the saved login 'Shop login' (username p•••@example.test)", the Activity says what was typed, Vault's own **Agent activity** page says the same from its side.

### Reconnect the vault

An owner's connection becomes `needs_reconnect` when Vault answers `401`: they removed Hexactra in Vault's **Connected apps**, the refresh token expired or was replayed (Vault then revokes the grant), or the client secret was rotated. The console deletes the stored tokens, the fabric forgets the provider, the owner gets **one** notification ("Reconnect your Vault") and runs ask instead of signing in. Doctor `secrets.vault_connections` warns while any connection needs it.

1. The owner opens Settings → **Secrets** and presses **Reconnect** (the Vault's own consent screen opens; they must come back in the same browser within 10 minutes).
2. A return to `/settings/secrets?vault=<reason>` says what went wrong: `denied` (they refused), `expired` (more than 10 minutes), `state_invalid` or `binding_invalid` (a different browser or a stale link: start again), `issuer_mismatch` (Vault answered as another issuer), `exchange_failed`, `no_refresh_token` (Vault issued no refresh token: ask its administrator to allow refresh tokens, `offline_access`, for the Hexactra client), `whoami_failed` (the connection was made but Vault did not identify the account; try again).
3. If **many owners** need it at once, the cause is on the Vault side: the client secret was rotated, the redirect URI changed (`GET /api/secrets/status` shows the exact `redirectUri` to register), or Vault's host allowlist no longer lists the console. Fix it in Vault, then update the deployment default (Administration → Secrets) or each owner's client (**Disconnect** first: `PUT /api/secrets/vault/client` answers `409 SECRETS_VAULT_DISCONNECT_FIRST` while connected), and each owner reconnects.
4. After it, the next run signs in again with no question. Reconnecting never needs the owner to retype anything.

### Rotate the store key

Only for deployments with the built-in store (switched on in Administration → Secrets; its key `SECRETS_STORE_KEY` is in `infra/compose/.env`). The key wraps each owner's data key; rotation re-wraps the data keys and **does not re-encrypt the values**. Take a database backup first and keep the old key until you hold one made **after** step 5. The reference is [../secrets.md](../secrets.md#rotating-the-store-key).

1. Generate the new key: `openssl rand -base64 32`. Keep the old one.
2. In `infra/compose/.env` set `SECRETS_STORE_KEY=<new>` and add `SECRETS_STORE_KEY_PREVIOUS=<old>` (neither is in the env template). Recreate the API: `docker compose $F up -d api`. Everything keeps working: rows still wrapped under the old key are read with it.
3. Administration → **Doctor**: `secrets.store_key` warns "A rotation is unfinished". If it **fails** ("wrapped under a store key this deployment no longer has"), the previous key is missing: put it back in `SECRETS_STORE_KEY_PREVIOUS` before anything else; without it those logins cannot be recovered.
4. Re-wrap: `POST /api/admin/secrets-store/rewrap` (a session or a personal access token with `system_settings:write`; it queues the job `secrets.store.maintain`, visible under Administration → Jobs, and is safe to repeat), for example `curl -sS -X POST -H "Authorization: Bearer $HEXACTRA_TOKEN" https://<console>/api/admin/secrets-store/rewrap`.
5. When `secrets.store_key` passes ("every owner key is wrapped under it"), take a fresh database backup, then remove `SECRETS_STORE_KEY_PREVIOUS` and recreate the API. Keep the old key somewhere safe until that backup exists.
6. Check: a scheduled run on a test login still signs in; the Activity shows `typed`.

The same job removes expired fabric credentials and the data of owners who no longer exist. **To restore** a database backup, restore `SECRETS_STORE_KEY` with it (the key that was current when the backup was taken, and its predecessor if a rotation was unfinished); without it the app works and the logins are unreadable.

## 11. Connections and deliveries

How they work: [../connections.md](../connections.md) and [../deliveries.md](../deliveries.md). What protects them and what does not: [../security-connections.md](../security-connections.md). Four things you will be asked about: an account that needs connecting again, a delivery that keeps failing, a mail trigger that stopped, and the provider's app secret.

### A connection needs reconnecting

What the owner sees: a bell and push notification **"Reconnect an account"**, the account listed at the top of Settings → Connections under **Needs reconnecting**, tasks and chats that fail with `CONNECTION_NEEDS_RECONNECT` (409, the label named), deliveries that fail with "the connection needs reconnecting", and mail triggers with the status `needs_reconnect`. Nothing falls back to another account. `hexactra connections list` shows the status of every connection of the signed-in owner.

1. **Read the reason** on the connection (`statusReason`, a code, never a provider message):

   | Reason | What happened | What to do |
   |---|---|---|
   | `GRANT_REVOKED` | The provider refused the saved grant: the owner removed the app in their account, changed the password, the grant expired, or the Google project was left in **Testing** (every sign-in ends after about seven days) | Reconnect. If a Google connection fails inside its first week, check the project's publishing status first ([connections.md, Google setup](../connections.md#setup-checklist-for-the-administrator)) |
   | `NO_REFRESH_TOKEN` | The provider issued no refresh token | Reconnect; for Google tick every permission on the consent screen |
   | `TOKEN_STORE_FAILED` | A new refresh token could not be stored (the provider had retired the old one) | Check that `SECRETS_ENCRYPTION_KEY` is the key the credentials were written with and that the database accepts writes; then reconnect |

2. **The owner reconnects**: Settings → Connections → **Reconnect** on the account. The provider's consent screen opens; they must come back **in the same browser within 10 minutes**. The return to `/settings/connections?connect=<outcome>` names a closed outcome: `connected`, `denied`, `expired`, `state_invalid` or `binding_invalid` (another browser or a stale link: start again), `exchange_failed`, `no_refresh_token`, `account_mismatch` (signed in as another account), `nothing_granted`, `provider_unavailable`, `limit` (25 connections per owner), and for Microsoft `admin_consent_required` (an administrator of the account's organization must approve the app once; the page shows the link to send).
3. **Many owners at once** is not a user problem. A refusal of the deployment's own app (`invalid_client`) does **not** make connections `needs_reconnect`: it answers `CONNECTION_UNAVAILABLE` (503) and changes no status, because it is the administrator's to fix. Look at the app: the Microsoft client secret expired (at most 24 months), the Google project went back to Testing, the redirect URI changed, or the provider is switched off or removed under Administration → Browser agent → Connections. Then [rotate the app's secret](#rotate-the-providers-app-secret).
4. **After the reconnect.** Mail triggers start polling again by themselves (any good poll clears the status). A delivery that failed with the connection can be sent with **Retry** on the run. A delivery that was **switched off** because its connection was *removed* stays off: point it at a connection that exists and switch it on.
5. A **paused** connection (Settings → Connections → Pause, or `hexactra connections pause`) is not an error: nothing uses it, mail triggers wait and say `connection_paused`, and the daily health job keeps its sign-in alive. Resume it.

The daily job `connections.health` (Administration → Jobs; 04:17 UTC, server-only) refreshes connections that were neither used nor refreshed in the last 20 hours and flags the ones that fail, so a token does not die of inactivity.

### A connection does not work: read its diagnostics

1. **The owner** opens the connection's diagnostics (`POST /api/connections/{id}/diagnose`; the last reports at `GET /api/connections/{id}/diagnostics`). Each stage has a code and a remedy key whose words are in `packages/shared/diagnostics.json`. An administrator cannot read a user's report: ask the owner for the codes (they hold no content, address or token).
2. **Read the first stage that is not `pass`** ([connections.md, the stages](../connections.md#what-needs-reconnect-means)):
   - `sign_in` `GRANT_REVOKED` / `NO_REFRESH_TOKEN` / `TOKEN_STORE_FAILED`: [the owner reconnects](#a-connection-needs-reconnecting).
   - `sign_in` `APP_CREDENTIALS_REFUSED`: the deployment's client id or secret is refused, for every owner. Test the app (below) and [rotate the secret](#rotate-the-providers-app-secret).
   - `permissions` `PERMISSION_MISSING` (`data.capability` names it): the owner uses **Change what it can do** and ticks that permission.
   - `capability:<name>` `API_DISABLED` (`data.api` names it, Google): enable that API in the Google Cloud project of the sign-in client (APIs & Services, Library, the API, Enable). Nothing to reconnect.
   - `MAILBOX_NOT_FOUND`, `LICENSE_MISSING`, `ADMIN_CONSENT_REQUIRED` (Microsoft): the account's organization has to give it a mailbox or a licence, or approve the app; or the owner switches that capability off.
   - `clock` `CLOCK_SKEW`: set the server to synchronise its clock (NTP).
   - `token_lifetime` `REFRESH_STALE`: check that the `connections.health` job runs (Administration, Jobs).
3. **Test the deployment's app** with no user: Administration, Connections, or `POST /api/connections/admin/apps/{google|microsoft}/diagnose` (`system_settings:write`). `client_check` `APP_CREDENTIALS_REFUSED` is a wrong or expired secret; `redirect_uri` `APP_URL_MISMATCH` means `APP_URL` is not the address the console is served on (the redirect URI registered at the provider must match it); `discovery` `TENANT_NOT_FOUND` is a Microsoft tenant setting that does not exist ([connections.md, the app's test](../connections.md#test-the-app-before-anyone-connects-e5011)).

### A connection will not complete (the owner approved everything and came back to an error)

The owner passes the provider's consent screens, is returned to the console, and the Connections page shows a red banner. The banner names which way it failed (#670); the audit log says why. The callback is deliberately **not** in the nginx access log or the API request log, so the audit is the place to look.

```bash
# The last ten connect events (closed values only: no code, state, token or provider text). Run on the host:
docker exec hexactra-api-1 node -e '
const { buildDatabaseUrl } = require("@marinoscar/platform-api/core");
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: buildDatabaseUrl(process.env) });
  await c.connect();
  const r = await c.query("select created_at, action, meta from audit_events where action like $1 order by created_at desc limit 10", ["connection.%"]);
  console.log(JSON.stringify(r.rows, null, 1));
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
'
docker logs --since 2h hexactra-api-1 2>&1 | grep -E 'connect failed|connection' | tail -20
```

**A red banner but a `connection.created` row at the same moment** is not a failure: the provider's return was delivered twice at once (on a phone, the in-app browser and the app link), and the duplicate used to answer an error although the other had connected (#672). It no longer does (a repeat of a callback that claimed its flow answers the same outcome for two minutes, and the code is exchanged once). If you see it on an older build, reload the Connections page: the account is there.

Read the `connection.connect_failed` row's `meta`:

| `reason` | `cause` / `oauthError` / `status` | Meaning and fix |
|---|---|---|
| `binding_invalid` | none | The sign-in came back to a different browser or app than the one that started it (the HttpOnly binding cookie is missing). Start again and finish in the same one; on a phone, open the console in the browser it will return to, not a different app. |
| `state_invalid` | `verifier_missing` | The flow was found but its PKCE verifier is gone (the sign-in took too long, or the flow was cleaned up). Start again. |
| `exchange_failed` | `cause: invalid_client`, `oauthError: invalid_client`, `status: 401` | The provider rejected the app's client id or secret. Check Administration, Connections: the client id and secret of the app, and that the secret was copied whole. |
| `exchange_failed` | `cause: invalid_grant`, `oauthError: invalid_grant`, `status: 400` | The code was already used, expired, or the **redirect URI sent does not match** the one registered at the provider (`<console>/api/connections/callback/google`, exactly, https). |
| `exchange_failed` | `cause: unavailable` | The console could not reach the provider's token endpoint, or it answered 5xx or 429 (the egress guard, a proxy, DNS, the provider's own outage). |
| `exchange_failed` | `cause: refused`, `oauthError` (for example `invalid_request`, `invalid_scope`) | The provider refused the exchange for another reason: the `oauthError` code names it (a scope the app is not allowed to ask for, a malformed request). |
| `exchange_failed` | `cause: save_failed`, `error`, `code` | The provider accepted the code but the connection could not be stored (database, credential store: `SECRETS_ENCRYPTION_KEY`). |
| `refused` | `reason` carries the provider's error code | The provider returned `error=` on the redirect. |
| `admin_consent_required` | none | Microsoft: an administrator has to approve the app. |

### The chat answers "The AI could not answer (AI_INVALID_REQUEST ...)"

The provider (OpenAI) refused the request itself, not the account or the key: it answers 400 within a second and no model work is done (#675). The owner's line names the provider's short code and the request field it objected to, for example `(AI_INVALID_REQUEST: invalid_function_parameters, tools[3].parameters)`: `tools[N]` is the N-th tool the chat sent (counting from 0, in the order `ask_user`, `start_run`, `run_task`, `propose_memory`, `guide_run`, `stop_run`, `pause_run`, `resume_run`, `draft_task`, then the chat's connection read tools), `input` the conversation text, `model` the model name.

```bash
# The failed turn with the provider's facts (status, code, type, parameter, request id and its redacted, capped message). Run on the host:
docker logs --since 1h hexactra-api-1 2>&1 | grep 'the model call failed'
# The failed job (its error is the generic text; the line above has the facts):
docker exec hexactra-api-1 node -e '
const { buildDatabaseUrl } = require("@marinoscar/platform-api/core");
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: buildDatabaseUrl(process.env) });
  await c.connect();
  const r = await c.query("select created_at, status, last_error from jobs where type = $1 order by created_at desc limit 5", ["chat.turn"]);
  console.log(JSON.stringify(r.rows, null, 1));
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
'
```

The two causes seen so far, both a tool schema the provider's strict function calling refuses (`invalid_function_parameters`): a free-form object field (`z.record`) in a tool's parameters (#675: `propose_memory.attributes`; use a list of name/value pairs), and a field that is not required. A run that fails at step 0 with the same code is the same class: the run's error line carries the code and the field (`AI_INVALID_REQUEST (invalid_function_parameters, tools[N].parameters)`), and `docker logs hexactra-api-1 | grep 'the model call failed'` shows the facts (#679). The provider names only the first bad tool, so fix every one the guard test (`chat-tool-schemas.db.spec.ts`) lists, not just the one named.

The provider's own log lists only requests it processed, so a 400 is not in the OpenAI dashboard; the `providerRequestId` in the API log is what to quote to the provider's support. The chat uses the owner's default model (Settings, AI), not the model tiers of the agent policies, so a run can work while the chat does not.

### A delivery keeps failing

A delivery's failure never changes the run's status. Where to look: the run page's **Deliveries** block, or `hexactra runs deliveries <run>`; each row has a status (`pending`, `sending`, `sent`, `failed`, `skipped`), the attempts, a closed code and a fixed sentence, never an address or a subject. The owner is told once per task per day (**"A delivery after a run failed"**); the alert rule **Delivery keeps failing** (`hexactra.delivery_failing`, on by default: three failed deliveries in 24 hours) is at Administration → Alerts.

1. **Read the code and act:**

   | Code | Meaning | What to do |
   |---|---|---|
   | `CONNECTION_NEEDS_RECONNECT`, `CONNECTION_PAUSED`, `CONNECTION_NOT_FOUND` | The account is the problem | [Reconnect](#a-connection-needs-reconnecting), resume, or point the delivery at another connection |
   | `CAPABILITY_OFF`, `PERMISSION_MISSING` | The switch is off, or the account did not grant the permission | Switch the capability on (Settings → Connections); a missing permission starts an incremental consent |
   | `NOT_FOUND` | The spreadsheet or folder is gone, or (Google) is not one the app created or the owner picked | Check the destination; with `drive.file` the app sees only files it made or the owner picked |
   | `NOT_SUPPORTED` | The provider cannot do it for this account type (for example an Excel row on a personal Microsoft account) | See the capability matrix in [../connections.md](../connections.md#what-each-kind-of-account-can-do) |
   | `RECIPIENT_NOT_CONFIRMED`, `RECIPIENT_UNSUBSCRIBED` | An address was not confirmed by the owner, or the recipient stopped the reports | The owner confirms the address again in the web app (that is the only thing that turns an unsubscribed recipient back on) |
   | `DAILY_LIMIT` | The user's 100 emails a day (system setting `deliveries.maxEmailsPerDay`; test sends count) | Wait, or raise the setting (`PATCH /api/system-settings`, `system_settings:write`) |
   | `TOO_LARGE` | A file is over the provider's limit | The PDF is replaced by a signed link when it does not fit; other files are left out: lower `screenshots`, or attach fewer |
   | `RATE_LIMITED`, `QUOTA_EXCEEDED`, `PROVIDER_ERROR`, `NETWORK_ERROR`, `TIMEOUT`, `HTTP_5XX` | Retried automatically, up to 5 attempts (30 s, 2 min, 10 min, 30 min, or the provider's longer `Retry-After`) | If it still failed: the provider's status page, then **Retry** |
   | `OUTCOME_UNKNOWN` | The request left and got no definite answer. **Not repeated**, so as not to send twice | Look in the Sent folder or the sheet first. **Retry** can send a second copy of an email; a sheet row and a folder file are looked for before they are added again |
   | `DESTINATION_BLOCKED`, `HTTP_4XX`, `SECRET_MISSING` | A webhook address resolves to a private network or is not https; the receiver refused; or the signing secret is missing | Fix the address; a missing secret means the delivery must be created again (the secret is shown once) |
   | `KIND_UNAVAILABLE`, `EMAIL_NOT_CONFIGURED`, `EMAIL_REFUSED` | The email, storage or webhooks slice is off, or email is not set up (Administration → Email), or the email provider refused | Set it up |
   | `NOTIFY_REQUIRED`, `CONFLICT`, `CONFIG_INVALID`, `INVALID_INPUT`, `INTERNAL` | A change that would email attendees, a file changed meanwhile, a configuration that cannot be sent | Open the delivery and fix its setup; for `INTERNAL`, the API log (it carries ids and codes, never content) |

2. **Test it without a run.** On the task, **Test** (or `hexactra tasks deliveries test <task> <delivery>`) sends a marked test with sample values to the delivery's own destination: an email marked `[TEST]` with no attachment, a webhook of type `deliveries.test`, a row whose Run ID reads `TEST-xxxxxxxx`, a small `TEST.txt` in the folder. It reads no run. At most ten a minute.
3. **Retry** the failed entry (the run page, or `hexactra runs deliveries <run> --retry <logId>`): a fresh set of attempts, still checking for its own earlier work.
4. A row stuck in `sending` for more than 10 minutes was held by a job that died; the next attempt treats its outcome as unknown (see above). The job type is `deliveries.send` (Administration → Jobs): server-only, one attempt per job, the retries are the delivery's own.

### A trigger stopped firing

On the task page, the email trigger shows a status; the history (`GET /api/mail-triggers/{id}/events`) says what it did with each message: `started` (with the run), `skipped_unverified` (reason `SENDER_NOT_VERIFIED` or `SENDER_NOT_CHECKED`), `skipped_limit` (`TRIGGER_DAILY_LIMIT` or `USER_DAILY_LIMIT`), `skipped_loop` (`OWN_MESSAGE`) and `failed` (`START_FAILED`). No subject or sender is stored.

| Status or history | Cause | What to do |
|---|---|---|
| `needs_reconnect`, `connection_paused`, `connection_removed` | The account | [Reconnect](#a-connection-needs-reconnecting), resume, or point the trigger at another account. A removed connection switched the trigger off |
| `failing` | Three failed polls in a row (one notice) | Look at the connection's **Test**; the trigger keeps trying and clears itself on a good poll |
| `rate_limited` | The provider asked to slow down; the trigger waits (the provider's `Retry-After`, at least 10 minutes without one) | Wait |
| Messages `skipped_unverified` | The provider's own sender check says the message `fail`ed, or could not be checked | A forwarder or a mailing list often breaks SPF and DKIM. For an `unknown` result only, the trigger's "Also accept mail the provider could not verify" lets it through; a `fail` never starts a run. Think before switching it on ([security-connections.md](../security-connections.md#3-a-mail-from-a-forged-sender-starts-a-task)) |
| Messages `skipped_limit` | The trigger's `maxRunsPerDay` (10) or the owner's cap across triggers (50) | The owner is told once a day. Raise the trigger's limit (at most 100) or the deployment's `mailTriggers.maxRunsPerUserPerDay` |
| Nothing at all | The trigger is switched off; the mail arrived **before** it was switched on (only mail after the trigger was created or last switched on counts; a gap is caught up for the last 24 hours only); `from` does not match exactly (an address or exactly one domain, never a subdomain); the message is not in the inbox label; or the poll has not run yet (5 minutes by default, 1 minute at least) | **Test** the trigger (`POST /api/mail-triggers/{id}/test`): it lists the last 5 matching messages with the subject cut to 60 characters and whether each would start a run; it starts nothing. Then check the job `connections.mail-triggers.poll` under Administration → Jobs: a per-minute cron only asks whether a trigger is due and enqueues it |

Deployment limits are the `mailTriggers` system settings: `minPollSeconds` (60), `maxTriggersPerUser` (20), `maxRunsPerUserPerDay` (50). Metrics: `app.mail_triggers.polls`, `.matches`, `.runs_started`, `.skips` (by reason) and `.lag` (seconds from the message to the run).

### Rotate the provider's app secret

The client id and secret of the Google and Microsoft apps are the **deployment's** (the administrator registered them: [../connections.md](../connections.md#administrator-setup-bring-your-own-app)). The secret expires (Microsoft: at most 24 months, **note the date when you create it**) or leaks, and then every connection of that provider stops refreshing at the same moment. Rotating it keeps the **same client id**, so owners **do not** have to reconnect.

1. **At the provider**, create a new secret next to the old one: Microsoft Entra admin center, the app, Certificates and secrets, **New client secret** (copy the *value* at once: it is shown once). Google Cloud console, Google Auth Platform, Clients, the client, add a new secret. Keep the old one until step 4.
2. **In the console**: Administration → Browser agent → Connections, the provider, paste the new secret and save (`PUT /api/connections/admin/apps/{provider}` with `clientSecret`; leaving it out keeps the stored one; it is write-only and never returned). It is the same credential-store row, so the next refresh uses it.
3. **Check.** Settings → Connections → **Test** on one account of that provider (one cheap read per switched-on capability); a deliveries test send or a mail trigger's **Test** also exercises it. The audit event `connection.app_saved` records the change with `secretSet` and no value.
4. **Remove the old secret at the provider** once a connection has refreshed with the new one.
5. **If the secret leaked**, rotate as above and then treat it like a stolen token ([security-connections.md, threat 7](../security-connections.md#7-a-stolen-refresh-token)): a refresh token is expected to need the secret to be used, which makes the old one worthless once it is deleted at the provider. That is the provider's behaviour as documented and is not verified here.
6. **A changed client id, or a deleted app**, orphans every grant: every connection of that provider must be connected again by its owner. **Removing the app in the console** (`DELETE /api/connections/admin/apps/{provider}`) deletes the id and secret and switches the provider off; connected accounts stay but cannot refresh until an app is set again.

Disconnecting an account revokes the grant at Google (best effort) and cannot revoke it at Microsoft: the owner removes the app at the account's own page (`account.live.com/consent/Manage`, or My Apps for a work or school account), or an administrator deletes the grant.

### Reading the Connections and Web search lines in Doctor

Administration → Doctor groups six lines under **Connections** and **Web search** (E50.13). Each reads **stored state only**: the settings, counts, the last deployment report in `connection_diagnostics` and the usage table. Doctor never calls Google, Microsoft, an MCP server or a search provider, writes nothing and names no user, account address, server label or query. To get a fresh answer, press **Test** on the settings page (`/admin/settings/connections`, `/admin/settings/web-search`), which runs a staged report and stores it; Doctor reads it on its next run.

| Line | Pass | Warn | Fail |
|---|---|---|---|
| `connections.google_app`, `connections.microsoft_app` | The provider is switched on and its app has a client id and secret (and its last app test passed); or it is off or not installed, and says so | The last app test warned or is older than 30 days; or, once app tests are installed (E50.11), the app was never tested | On and not configured, or the last app test failed: open the provider's card and read the failed stage |
| `connections.accounts` | Active accounts, by provider | Accounts that need reconnecting, by provider. Each owner was notified once and reconnects on their Connections page | The check could not run (the API log says why) |
| `connections.health_job` | `connections.health` succeeded in the last 26 hours, or no connection was idle (the daily task enqueues it only when one is) | It has not run in 26 hours while idle connections wait: check the scheduler and Administration → Jobs; idle tokens may expire | Its last run failed: open it under Administration → Jobs |
| `connections.mcp` | The deployment switch and the number of active servers | Servers whose status reason is `UNAVAILABLE` or `AUTH_REFUSED` or whose last stored diagnosis failed, and tools that changed and wait for the owner's review (switched off until then): each owner tests the server or reviews its tools | The check could not run |
| `web_search.provider` | A provider answers with the deployment's key (or address, or AI) and its last deployment test passed; or search is off | No deployment key (users need their own; if user keys are not allowed, nobody can search), the last deployment test warned, is older than 30 days or missing, or more than 20% of yesterday's searches failed | A deployment key is set and its last deployment test failed |

The web search **Test** (`POST /api/web-search/admin/providers/{id}/diagnose`) uses the deployment's key only, never a user's, and sends **one real search** of a fixed common word, counted as one call of yours in the usage table (it costs what a search costs). Its stages are `switches`, `credential`, `network`, `live_query`, `limits` and `fetch`; the `fetch` stage reads `https://example.com/` once when `web_fetch` is installed and on. A user's own report (`POST /api/web-search/diagnose`) uses their effective key and never says whether the deployment holds a key it does not share. The egress list (Administration → Doctor, Network) shows the hosts each line depends on: `connections.google` and `connections.microsoft` (the providers' API hosts), `connections.mcp` (the distinct hosts of the users' servers, at most 20) and `web_search.<id>` (the provider's hosts plus `example.com`).
