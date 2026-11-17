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

- **Alerts.** Administration → Alerts. It ships rules for a browser host offline (or the fabric unreachable), a schedule failing 3+ runs in a row, and a user's runs over their token or budget limits.
- **Run time budget.** A task's `maxMinutes` counts **active** time only: the time the run spends in `running`. Time spent waiting for a person (a handoff or a question) is never counted, so a run that waited two hours for a code resumes with its remaining active time intact (`runs.active_ms`, `runs.active_since`). A new task gets the same defaults everywhere (100 steps, 30 minutes). A run that outlasts one job (30 min of work) continues in a new `browser.goal.run` job (reason "Run continued in a new job") and stays `running`; you will see two or more jobs for one run in Administration → Jobs. A budget stop ends the run as `failed` with the error `Step budget exhausted` or `Time budget exhausted`.
- **Telemetry.** Administration → Telemetry. The Browser agents group charts runs, steps, waits for a person and model tokens. To trace across console and fabric, set `HEXACTRA_FABRIC_OTLP_ENDPOINT` ([vps-stack.md](vps-stack.md)).
- **Doctor.** Administration → Doctor. It runs the `fabric.*` checks: reachability, token, hosts online, event stream.
- **About.** Administration → About (`system_settings:read`). What is deployed: the console version, the deployment mode, the record `hexactra deploy` leaves on disk (commit, ref, install and update times, the last run's outcome and failed step, the proxy and certificate expiry, the host, the deploy history), database liveness, and a **Hexactra Fabric** section (URL, fabric version, reachable, browser hosts online and with a browser connected). The service token is never shown. API: `GET /api/admin/about`.

## 7. Questions

What agents ask people is in the console's `questions` table ([../questions.md](../questions.md)). A browser-bound question mirrors a fabric handoff; a free-standing one lives only in the console.

- **Expiry.** Every minute a cron checks for overdue pending questions and, when there are any, enqueues the `questions.expire` housekeeping job (Administration → Jobs). It marks them `expired`, withdraws their fabric handoffs, and sends `questions.question.expired` to webhooks. A question that does not expire on time means the job queue is not running: check Administration → Jobs and the API logs.
- **Delivery.** Each asked or settled question enqueues a `questions.deliver` job, which delivers it on (or withdraws it from) every channel: notifications and webhooks. A failure is logged with the channel and the error class only, never the question or the answer. Webhook deliveries and their retries are at `/settings/webhooks`.
- **Action tokens.** Notification buttons (Stop run, Approve, Remind me, a question's quick answers) and webhook answer tokens are single use, recorded in `action_tokens` as sha256 only. `questions.expire` deletes tokens that expired more than a day ago, so the table stays small; nothing else needs purging. A leaked token answers one question (or acts on one run) once, before it expires, and nothing else.
- **Webhook answer tokens.** Only questions with a public answer (choice, multi_choice, text, number, a low-risk confirm) get one, in the `answer` block of `questions.question.asked`. To stop webhook answers for a user, remove their webhook endpoints: tokens already sent keep working until their question settles or expires.
- **Secrets.** A code or password typed into a question is relayed to the fabric and typed into the page by the fabric's `type_secret` action. It is never stored by the console, never returned by an API, and the fabric keeps it in memory for at most 10 minutes. Restoring a backup cannot bring one back.
