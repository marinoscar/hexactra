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
| `infra/compose/.env` | `JWT_SECRET`, `COOKIE_SECRET`, `SECRETS_ENCRYPTION_KEY`, `HEXACTRA_FABRIC_OPERATOR_TOKEN`, database password | Secret; keep it apart from the backups |

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

### Model prices

Every model call the browser agent makes is priced, so a run, a task (last 30 days) and the platform's AI usage report can show money as well as tokens. The console ships no prices: they change, and they are your contract with a provider.

- **Where.** The `agentPricing` system setting (`PATCH /api/system-settings`, `system_settings:write`): `{ "agentPricing": { "models": { "<provider>:<model id>": { "inputPerMTok": 3, "outputPerMTok": 15, "cachedInputPerMTok": 0.3 } } } }`. The key is the provider id, a colon and the model id exactly as the provider reports it for a call (the model that served it, as listed in Administration → AI → Models and Usage). A PATCH replaces the whole `models` table.
- **Units.** USD per **million** tokens. `cachedInputPerMTok` is optional: without it, input tokens served from the provider's cache are billed at the input price. Prices cannot be negative.
- **Unpriced models.** A call on a model that is not in the table has no price, and counts as unknown, never as free. The run's `costKnown` becomes `false` and its cost is a lower bound: show it as "at least" (≥ $x.xx). Add the model's price to make later runs exact. Earlier runs are not re-priced, and runs from before cost tracking stay unknown.
- **Same table, two uses.** The platform's usage report (Administration → AI → Usage) reads it through the `AI_PRICING` port: it shows `priced: true` and a cost per model, and a model with no price has no cost there either.
- **Metrics.** `app.runs.model_calls` (counter) and `app.runs.cost` (histogram, USD, one value per finished run whose calls were all priced). Neither carries a user or run label.




### Moving agent policies between users and deployments

Agent policies are personal; a JSON file is how they are shared (format and API: [console README](../../README.md#export-and-import)).

- **Export** with `GET /api/agent-policies/export?ids=all` (the signed-in user's policies and the built-ins). Add `includePins=false` for a file that carries no model id and so works on any deployment.
- **Import** with `POST /api/agent-policies/import`. The default is `rename` on a name clash; `replace` overwrites the user's same-named policy and bumps its version (runs in flight keep their own snapshot). A file is written in one transaction: if any policy is invalid, nothing is imported and `details.errors` lists every problem.
- **Read the `warnings`.** `PIN_DROPPED` means a model pin names a model that is unknown or disabled here (enable the model, or leave the tier to the user's tier definition); `EXCEEDS_CEILING` means a budget is above the deployment ceilings: it is stored as written and held to the ceiling when a run uses it.
- **Limits.** 100 policies and 256 KB per file; the file holds no ids, no user and nothing secret, so it is safe to attach to a ticket.

- **Alerts.** Administration → Alerts. It ships rules for a browser host offline (or the fabric unreachable), a schedule failing 3+ runs in a row, and a user's runs over their token or budget limits.
- **Run time budget.** A task's `maxMinutes` counts **active** time only: the time the run spends in `running`. Time spent waiting for a person (a handoff or a question) is never counted, so a run that waited two hours for a code resumes with its remaining active time intact (`runs.active_ms`, `runs.active_since`). A new task gets the same defaults everywhere (100 steps, 30 minutes). A run that outlasts one job (30 min of work) continues in a new `browser.goal.run` job (reason "Run continued in a new job") and stays `running`; you will see two or more jobs for one run in Administration → Jobs. A budget stop ends the run as `failed` with the error `Step budget exhausted` or `Time budget exhausted` (or the model-call, input-token, output-token or cost message), after one wrap-up call; the typed reason is `stop_reason` (below).
- **Telemetry.** Administration → Telemetry. The Browser agents group charts runs, steps, waits for a person and model tokens. To trace across console and fabric, set `HEXACTRA_FABRIC_OTLP_ENDPOINT` ([vps-stack.md](vps-stack.md)).
- **Doctor.** Administration → Doctor. It runs the `fabric.*` checks: reachability, token, hosts online, event stream.
- **About.** Administration → About (`system_settings:read`). What is deployed: the console version, the deployment mode, the record `hexactra deploy` leaves on disk (commit, ref, install and update times, the last run's outcome and failed step, the proxy and certificate expiry, the host, the deploy history), database liveness, and a **Hexactra Fabric** section (URL, fabric version, reachable, browser hosts online and with a browser connected). The service token is never shown. API: `GET /api/admin/about`.

### Budget ceilings and why a run stopped

- **Ceilings.** Administration → Settings (API: `PATCH /api/system-settings`, `system_settings:write`) holds `browserAgentCeilings`: `{ "browserAgentCeilings": { "maxActions": 200, "maxModelCalls": null, "maxActiveMinutes": 120, "maxInputTokens": null, "maxOutputTokens": null, "maxCostUsd": 25 } }`. Each key is the most any agent policy may allow a run; `null` (the default) sets no ceiling. A PATCH changes only the keys it names. A run's limit is the smaller of its policy's and the ceiling, and a ceiling also caps a policy that is unlimited, so set one if no user should ever be able to run without a hard stop. The effective numbers are fixed when the run starts: a changed ceiling applies to the next run, never to one in flight.
- **Reading `stop_reason`.** `runs.stop_reason` says why a run ended: `finished` (the model called finish, or answered), `budget_actions`, `budget_model_calls`, `budget_active_time`, `budget_input_tokens`, `budget_output_tokens`, `budget_cost` (that budget was used up; the run made one wrap-up call and kept the model's summary; it is `succeeded` only when the wrap-up reported success), `stalled` (no progress), `cancelled`, `error` (a failure in the runner or the job; `error` holds the text) and `no_model` (no model could be chosen). It is `null` for runs from before the column. For example, to count the last day's budget stops: `SELECT stop_reason, count(*) FROM runs WHERE stop_reason LIKE 'budget_%' AND created_at > now() - interval '1 day' GROUP BY 1;`. The run's `budget.source` tells you whether the policy or a ceiling set the limit that stopped it.
- **Alerts.** The run-budget rule counts failed runs with a `budget_%` stop reason. For one release it also counts older failed runs (no stop reason) whose error is `Step budget exhausted` or `Time budget exhausted`.

### Model tiers

The browser agent picks its model by tier (Fast, Standard, Frontier; [README, Model tiers](../../README.md#model-tiers)). The deployment's default tiers are the `browserAgentTiers` system setting, the same document as the model prices.

- **Where.** `PATCH /api/system-settings` with `system_settings:write`: `{ "browserAgentTiers": { "standard": { "model": "<provider>:<model id>", "reasoningEffort": "low", "maxOutputTokens": 4000, "fallbackModel": null }, "frontier": { "model": "<provider>:<model id>", "reasoningEffort": "high" } } }`. A PATCH merges per tier and per field; `null` clears a field. The model is named as the catalogue names it (Administration → AI → Models), and must be enabled there and support tool calls. Each user may override any field in their own settings.
- **A fresh deployment** has every tier unset: each user's own default model (AI settings) is used for all three tiers, and a run with no model anywhere fails with `No model selected`, naming the Model tiers page. Set at least Standard to give every user a working model.
- **A good starting pair:** one capable model on Standard at `low` effort and the same model on Frontier at `high` effort (prompt caching stays warm on an escalation); add a smaller model on Fast for the Economy policy.
- **Changing them** affects runs that start afterwards. A run in flight keeps the models it started with.
- **Prices.** Give every tier's model (and fallback) an entry in [Model prices](#model-prices), or the run's cost is a lower bound.

## 7. Questions

What agents ask people is in the console's `questions` table ([../questions.md](../questions.md)). A browser-bound question mirrors a fabric handoff; a free-standing one lives only in the console.

- **Expiry.** Every minute a cron checks for overdue pending questions and, when there are any, enqueues the `questions.expire` housekeeping job (Administration → Jobs). It marks them `expired`, withdraws their fabric handoffs, and sends `questions.question.expired` to webhooks. A question that does not expire on time means the job queue is not running: check Administration → Jobs and the API logs.
- **Delivery.** Each asked or settled question enqueues a `questions.deliver` job, which delivers it on (or withdraws it from) every channel: notifications and webhooks. A failure is logged with the channel and the error class only, never the question or the answer. Webhook deliveries and their retries are at `/settings/webhooks`.
- **Action tokens.** Notification buttons (Stop run, Approve, Remind me, a question's quick answers) and webhook answer tokens are single use, recorded in `action_tokens` as sha256 only. `questions.expire` deletes tokens that expired more than a day ago, so the table stays small; nothing else needs purging. A leaked token answers one question (or acts on one run) once, before it expires, and nothing else.
- **Webhook answer tokens.** Only questions with a public answer (choice, multi_choice, text, number, a low-risk confirm) get one, in the `answer` block of `questions.question.asked`. To stop webhook answers for a user, remove their webhook endpoints: tokens already sent keep working until their question settles or expires.
- **Secrets.** A code or password typed into a question is relayed to the fabric and typed into the page by the fabric's `type_secret` action. It is never stored by the console, never returned by an API, and the fabric keeps it in memory for at most 10 minutes. Restoring a backup cannot bring one back.
