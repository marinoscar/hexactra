# Runbook: the Hexactra stack on a VPS

One Docker Compose project runs:
- the **console**: nginx, web, API and Postgres;
- the **fabric control plane** (`fabric-control`);
- one **containerized browser host** (`fabric-host`).

Only nginx is published, and only on `127.0.0.1`. A host proxy or Tailscale terminates TLS in front of it. The fabric is reachable only on the private `app-network`.

```text
you (web, Android, CLI, MCP) ──HTTPS──▶ host proxy / Tailscale ──▶ nginx :3535 ──▶ web, /api
                                                                     └─▶ /viewer/local/ (ticket-gated) ──▶ fabric-host:6080
api ──http://fabric-control:8787 (hxs_ service token)──▶ fabric-control ◀── long-poll ── fabric-host (and your other hosts)
```

## Deploy with the CLI (recommended)

`hexactra deploy` installs and updates the console exactly as it does for every platform app. That covers the TLS certificate and vhost on the shared host proxy, the database role, migrations, the seed and health checks, plus the fabric and the bundled browser host. The full reference is the platform's [deploy-to-vps runbook](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/runbooks/deploy-to-vps.md). Sections 1 and 2 below are the same steps by hand.

**What this repository adds to the platform deploy:**
- The console lives in `console/`, so the CLI declares `deploy: { appDir: 'console' }` (`apps/cli/src/app.ts`).
  - The deploy keeps one checkout of the whole repository under `<deploy root>/repo` and builds from `repo/console/infra/compose`.
  - The fabric images build from the repository root.
- The deploy generates `HEXACTRA_FABRIC_OPERATOR_TOKEN` and `HEXACTRA_VIEWER_PASSWORD` without asking.
- `infra/compose/app.vps.stack-agent-image.compose.yml` runs the platform's published stack-agent image, because only the platform repository ships `apps/stack-agent`.

**Before you start** (`deploy doctor` checks each one):
- a DNS A record for the domain, pointing at the server;
- Docker with Compose 2.24 or later, git, and Node.js 24;
- an external PostgreSQL 16 the server can reach;
- a Google OAuth client whose redirect URI is `https://<domain>/api/auth/google/callback`.

**Install** (on the server, as an ordinary user, never with `sudo`):

```bash
git clone https://github.com/marinoscar/hexactra && cd hexactra/console
npm ci && npm run build --workspace=cli
node apps/cli/dist/cli.js deploy doctor --domain hexactra.example.test
node apps/cli/dist/cli.js deploy install --domain hexactra.example.test
```

The install asks for:
- the database credentials;
- the Google OAuth client;
- `INITIAL_ADMIN_EMAIL`.

It generates every other secret. Add `--staging` while you are still working out DNS and the proxy, so you stay clear of Let's Encrypt's rate limits.

**Then connect the console to the fabric** (once). Mint the service token inside `fabric-control`, then follow section 3 from step 1:

```bash
docker exec "$(docker ps -qf name=fabric-control)" hexactra-fabric --url http://127.0.0.1:8787 admin service-token-create console
```

**Update** (safe to run from cron; it exits 0 when nothing moved):

```bash
cd hexactra/console && git pull && npm ci && npm run build --workspace=cli
node apps/cli/dist/cli.js deploy update
```

`deploy status`, `deploy about`, `deploy certs` and `deploy list` inspect the deployment.

**Version bumps.** By default `install` and `update` bump the console's patch version, commit it, and push the commit to the deployed branch. The bumped files are `console/apps/*/package.json`, `console/packages/shared/package.json` and `console/package-lock.json`. If the server cannot push to that branch, for example because `main` accepts changes only through pull requests, add `--no-version-bump`. The version then comes from the commit you deploy.

## 1. Configure

```bash
git clone https://github.com/marinoscar/hexactra && cd hexactra/console
npm ci && npm run setup                 # writes infra/compose/.env (secrets generated)
```

Edit `infra/compose/.env`:

| Variable | Value |
|---|---|
| `APP_URL` | The public URL, e.g. `https://hexactra.example.test` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client (sign-in) |
| `INITIAL_ADMIN_EMAIL` | Your email (first admin) |
| `POSTGRES_HOST` | `db` with the bundled database (below) |
| `HEXACTRA_FABRIC_OPERATOR_TOKEN` | `openssl rand -hex 32` |
| `HEXACTRA_VIEWER_PASSWORD` | Up to 8 characters (noVNC) |
| `HEXACTRA_MAX_BROWSERS` | Profiles open at once; about 600 MB each |

## 2. Start

```bash
cd infra/compose
docker network create devnet 2>/dev/null || true    # once per host (the platform stack joins it)
F="-f base.compose.yml -f prod.compose.yml -f devdb.compose.yml -f vps.compose.yml -f app.fabric.compose.yml"
docker compose $F build
docker compose $F up -d db fabric-control fabric-host
docker compose $F run --rm --no-deps api npm run prisma:migrate
docker compose $F run --rm --no-deps api npm run prisma:seed
docker compose $F up -d
docker compose $F ps                   # everything running; db and fabric services healthy
```

- Drop `devdb.compose.yml` and set `POSTGRES_*` if you use an existing Postgres.
- Drop `vps.compose.yml` on a machine with no shared host proxy.

## 3. Connect the console to the fabric

Mint a service token for the console with the fabric's admin CLI. It runs inside `fabric-control`, which already holds the operator token:

```bash
docker compose $F exec fabric-control hexactra-fabric --url http://127.0.0.1:8787 admin service-token-create console
```

Then, signed in as admin:
1. Open **Administration → Fabric connection**.
2. Set the URL to `http://fabric-control:8787` and paste the `hxs_…` token.
3. Click **Test connection**.
4. Open **Administration → Doctor**: the `fabric.*` checks must pass.

## 4. Use the bundled browser

- **Fleet** lists the host `local`.
- **Open the viewer** issues a one-time ticket, valid for 60 s, that nginx exchanges for an hour-long cookie scoped to `/viewer/`. It needs `fleet:write`.
- Sign in to your sites there once per profile. Profiles live in the `fabric-host-data` volume.
- Without a ticket or cookie, `/viewer/local/` answers `401` and nginx never contacts the host.

## 5. Add more hosts (desktop, other machines)

1. **Fleet → Enroll host** prints a single-use command: `hexactra-agent daemon --url … --enrollment-token hxe_…`.
2. The new host must reach the fabric, which is not published. Give it a private route, e.g. Tailscale: `tailscale serve --bg --tcp=8787 tcp://127.0.0.1:8787`, with a `127.0.0.1:8787:8787` port added to `fabric-control` in an `app.vps.fabric-port.compose.yml` overlay that publishes on loopback only.
3. Pass `--agent-url https://<vps>.<tailnet>.ts.net:8787` when enrolling, so the printed command uses that URL.

## 6. Operate

| Task | Command |
|---|---|
| Logs | `docker compose $F logs -f api fabric-control fabric-host` |
| Upgrade | `git pull && docker compose $F build && docker compose $F up -d` (run `prisma:migrate` first when the release notes say so) |
| Back up | Postgres (Administration → Database backup), plus the `fabric-control-data` (hosts, credentials) and `fabric-host-data` (profiles, which hold live sign-ins: treat as secrets) volumes |
| Smoke test (CI does this) | `console/scripts/stack-smoke.sh` |
| Telemetry | Add `-f telemetry.compose.yml` to `$F`, and set `HEXACTRA_FABRIC_OTLP_ENDPOINT=http://otel-collector:4318` in `.env`. Console and fabric then export to one store, so a trace runs from the console request through its job to the fabric operation. **Administration → Telemetry → Browser agents** charts runs, steps, waits for a person and model tokens |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `fabric.reachable` fails | `docker compose $F ps fabric-control`; the URL must be `http://fabric-control:8787` |
| `fabric.token` fails | Mint a new service token (section 3) and save it |
| `fabric.hosts` warns | `docker compose $F logs fabric-host`; the host must be healthy and use the same operator token |
| The viewer says 401 | Open it from the Fleet page (tickets expire after 60 s and work once) |
