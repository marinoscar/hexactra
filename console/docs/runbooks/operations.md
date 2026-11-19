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

- **Alerts.** Administration → Alerts. It ships rules for a browser host offline (or the fabric unreachable), a schedule failing 3+ runs in a row, a user's runs over their token, cost or budget limits, a user's runs stalling, and one expensive run (off by default); see [the run budget meter, stop reasons and cost alerts](#the-run-budget-meter-stop-reasons-and-cost-alerts).
- **Telemetry.** Administration → Telemetry. The Browser agents group charts runs, steps, waits for a person and model tokens. To trace across console and fabric, set `HEXACTRA_FABRIC_OTLP_ENDPOINT` ([vps-stack.md](vps-stack.md)).
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

### Model prices

Every model call the browser agent makes is priced, so a run, a task (last 30 days) and the platform's AI usage report can show money as well as tokens. The console ships no prices: they change, and they are your contract with a provider.

- **Where.** Administration → Browser agent → Model prices, or the `agentPricing` system setting (`PATCH /api/system-settings`, `system_settings:write`): `{ "agentPricing": { "models": { "<provider>:<model id>": { "inputPerMTok": 3, "outputPerMTok": 15, "cachedInputPerMTok": 0.3 } } } }`. The key is the provider id, a colon and the model id exactly as the provider reports it for a call (the model that served it, as listed in Administration → AI → Models and Usage). A PATCH replaces the whole `models` table.
- **Units.** USD per **million** tokens. `cachedInputPerMTok` is optional: without it, input tokens served from the provider's cache are billed at the input price. Prices cannot be negative.
- **Unpriced models.** A call on a model that is not in the table has no price, and counts as unknown, never as free. The run's `costKnown` becomes `false` and its cost is a lower bound: show it as "at least" (≥ $x.xx). Add the model's price to make later runs exact. Earlier runs are not re-priced, and runs from before cost tracking stay unknown.
- **Same table, two uses.** The platform's usage report (Administration → AI → Usage) reads it through the `AI_PRICING` port: it shows `priced: true` and a cost per model, and a model with no price has no cost there either.
- **Metrics.** `app.runs.model_calls` (counter) and `app.runs.cost` (histogram, USD, one value per finished run whose calls were all priced). Neither carries a user or run label.

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

Only for deployments with the built-in store (`SECRETS_STORE_ENABLED=true`). The key wraps each owner's data key; rotation re-wraps the data keys and **does not re-encrypt the values**. Take a database backup first and keep the old key until you hold one made **after** step 5. The reference is [../secrets.md](../secrets.md#rotating-the-store-key).

1. Generate the new key: `openssl rand -base64 32`. Keep the old one.
2. In `infra/compose/.env` set `SECRETS_STORE_KEY=<new>` and add `SECRETS_STORE_KEY_PREVIOUS=<old>` (neither is in the env template). Recreate the API: `docker compose $F up -d api`. Everything keeps working: rows still wrapped under the old key are read with it.
3. Administration → **Doctor**: `secrets.store_key` warns "A rotation is unfinished". If it **fails** ("wrapped under a store key this deployment no longer has"), the previous key is missing: put it back in `SECRETS_STORE_KEY_PREVIOUS` before anything else; without it those logins cannot be recovered.
4. Re-wrap: `POST /api/admin/secrets-store/rewrap` (a session or a personal access token with `system_settings:write`; it queues the job `secrets.store.maintain`, visible under Administration → Jobs, and is safe to repeat), for example `curl -sS -X POST -H "Authorization: Bearer $HEXACTRA_TOKEN" https://<console>/api/admin/secrets-store/rewrap`.
5. When `secrets.store_key` passes ("every owner key is wrapped under it"), take a fresh database backup, then remove `SECRETS_STORE_KEY_PREVIOUS` and recreate the API. Keep the old key somewhere safe until that backup exists.
6. Check: a scheduled run on a test login still signs in; the Activity shows `typed`.

The same job removes expired fabric credentials and the data of owners who no longer exist. **To restore** a database backup, restore `SECRETS_STORE_KEY` with it (the key that was current when the backup was taken, and its predecessor if a rotation was unfinished); without it the app works and the logins are unreadable.
