# Runbook: operating Hexactra (console + fabric)

Day-2 operations for the stack in [vps-stack.md](vps-stack.md): what holds state, how to back it up and restore it, how to upgrade, and how big a machine you need. In the commands, `$F` is the compose file list from that runbook:

```bash
F="-f base.compose.yml -f prod.compose.yml -f app.fabric.compose.yml"   # + -f devdb.compose.yml for the bundled Postgres
```

## 1. What holds state

| Where | What | Sensitivity |
|---|---|---|
| Postgres (the console) | Users, roles, tasks, runs and steps (redacted), schedules, notifications, alert rules and incidents, webhooks, the encrypted credentials (the fabric service token, AI keys) | Encrypted secrets inside; back up with the `SECRETS_ENCRYPTION_KEY` kept separately |
| Object storage (the console) | Run screenshots, database backups | Screenshots can show what was on screen |
| Volume `fabric-control-data` | The control plane's state database `control.db`: hosts, host credentials (digests), sessions, handoffs (token digests), host commands; its webhook registry | Digests only: no raw tokens |
| Volume `fabric-host-data` | The browser profiles of the bundled host: cookies and live sign-ins | **Secret**: whoever has a profile is signed in as you |
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
- **Telemetry.** Administration → Telemetry. The Browser agents group charts runs, steps, waits for a person and model tokens. To trace across console and fabric, set `HEXACTRA_FABRIC_OTLP_ENDPOINT` ([vps-stack.md](vps-stack.md)).
- **Doctor.** Administration → Doctor. It runs the `fabric.*` checks: reachability, token, hosts online, event stream.
