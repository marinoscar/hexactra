# Runbook: the Hexactra stack on a VPS

One Docker Compose project runs:
- the **console**: nginx, web, API and Postgres;
- the **fabric control plane** (`fabric-control`);
- one **containerized browser host** (`fabric-host`). It is optional (`COMPOSE_PROFILES=bundled-host` in `infra/compose/.env`): the primary browsers run on **nodes at home** ([docs/nodes.md](../../../docs/nodes.md)), because sites challenge datacenter IPs. A new deploy leaves it off (`COMPOSE_PROFILES=none`); a deploy that already ran it keeps it.

Only nginx is published, and only on `127.0.0.1`. The host proxy terminates TLS in front of it (Tailscale is optional). The fabric is reachable only on the private `app-network`.

```text
you (web, Android, CLI, MCP) ──HTTPS──▶ host proxy ──▶ nginx :3535 ──▶ web, /api
                                                                     └─▶ /viewer/<host>/websockify (viewer session) ──▶ fabric tunnel ──▶ the host's desktop
api ──http://fabric-control:8787 (hxs_ service token)──▶ fabric-control ◀── long-poll ── fabric-host (and your other hosts)
```

## Deploy with the CLI (recommended)

`hexactra deploy` installs and updates the console exactly as it does for every platform app. That covers the TLS certificate and vhost on the shared host proxy, the database role, migrations, the seed and health checks, plus the fabric and the bundled browser host. The full reference is the platform's [deploy-to-vps runbook](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/runbooks/deploy-to-vps.md). Sections 1 and 2 below are the same steps by hand.

**What this repository adds to the platform deploy:**
- The console lives in `console/`, so the CLI declares `deploy: { appDir: 'console' }` (`apps/cli/src/app.ts`).
  - The deploy keeps one checkout of the whole repository under `<deploy root>/repo` and builds from `repo/console/infra/compose`.
  - The fabric images build from the repository root.
- The deploy generates `HEXACTRA_FABRIC_OPERATOR_TOKEN` without asking, and sets `COMPOSE_PROFILES`: `bundled-host` where the bundled host's data volume already exists, `none` on a new server. Change it in `infra/compose/.env`, then run `hexactra deploy update`.
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

It generates every other secret.

**The database login can be an administrator** (for example a managed PostgreSQL's `admin`). The console must not run as a superuser, because row-level security does not apply to one. So the install uses that login once to create an ordinary database user for the console, and only that user's login is saved to `.env`. The administrator's password is held in memory and never saved.
- **At the terminal** it asks: *Create a dedicated ordinary database user for the app?* (Enter answers yes), then the user name (Enter keeps the default) and its password (Enter generates a strong one; a typed one needs at least 12 characters).
- **In the TUI** (`hexactra` → Install) the same two questions are optional fields, *app database user* and *app database password* (masked). Creating the user is the default.
- **Opting out:** "Create no role" (`--skip-role-provisioning`) means `POSTGRES_USER` must already be an ordinary role you created. "Run as a superuser anyway" (`--allow-superuser`) turns tenant isolation off; don't use it in production.
- **The database itself:** tick "Create the database if it is missing" (`--create-database`) and it is created, owned by the new user.
- **Unattended runs:** `--provision-app-role` consents in advance and asks nothing. Put `APP_DB_USER` / `APP_DB_PASSWORD` in the answers file to choose them. The password is never a flag.
- **Retrying:** changing any of these choices and retrying, including with `--resume` or the TUI's resume, reruns the environment step, so the new choice takes effect.

Details: the platform's [deploy-to-vps runbook, section 2.1](https://github.com/marinoscar/EnterpriseAppBase/blob/main/docs/runbooks/deploy-to-vps.md#21-the-database-login-a-dedicated-role). Add `--staging` while you are still working out DNS and the proxy, so you stay clear of Let's Encrypt's rate limits.

**The fabric connection is automatic.** The last step of `install` and `update` (`fabric-connect`) connects the console to the bundled fabric:
- **Not connected yet** (or the bundled connection broke, e.g. after a volume restore): it mints an `hxs_` service token inside `fabric-control` and pipes it straight into the API, which stores it encrypted. The token appears in no command line, log or journal.
- **Already connected**: it does nothing.
- **Pointed at another fabric** in Administration → Fabric connection: it leaves that connection alone, even if that fabric is down.

If the step cannot connect, the deploy still succeeds and the journal shows a warning. Set the connection by hand (section 3), or run `deploy update` again. Check the result at **Administration → Doctor**: the `fabric.*` checks pass.

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
| `COMPOSE_PROFILES` | `bundled-host` to run the bundled browser host, `none` to leave it off |
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

With `hexactra deploy`, this happens on its own (above). With a hand-run stack, the same pipe does it in one line:

```bash
docker compose $F exec -T fabric-control hexactra-fabric --url http://127.0.0.1:8787 admin service-token-create console \
  | docker compose $F exec -T api node dist/fabric/fabric-connect.cli.js set --url http://fabric-control:8787
```

Or by hand: mint a service token for the console with the fabric's admin CLI. It runs inside `fabric-control`, which already holds the operator token:

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
Run it with `COMPOSE_PROFILES=bundled-host`.
- **Fleet** lists the host `local` (mode Container).
- **Open desktop** shows its screen, like any node's. You need `fleet:desktop`.
  - The desktop comes through the fabric's tunnel, from VNC on the container's own loopback; nothing is published.
  - Use **Take over** to type, and **Release** to hand control back.
- Sign in to your sites there once per profile. Profiles live in the `fabric-host-data` volume.
- Without a viewer session, `/viewer/<host>/websockify` answers `401` and nginx never contacts the fabric.

## 5. Add more hosts (desktop, other machines)

This is how you add **nodes**, the recommended place to run browsers: a machine on your home network keeps a residential IP ([docs/nodes.md](../../../docs/nodes.md)).

A browser host only makes outbound HTTPS requests to the console's own domain, at `https://<console>/fabric`. You need no VPN, no open port and no extra certificate.

**What is published there.** Only the host protocol (`infra/nginx/app.d/locations/fabric-agents.conf`):
- `POST /v1/hosts/enroll`: takes a single-use `hxe_` token an admin minted;
- `register`, `next`, `offline`, and the result posts: each takes that host's own credential, and a host may act only for its own id.

Everything else under `/fabric/` answers 404: the fabric's client, admin and operator APIs, sessions, events and artifacts. The console still reaches the fabric privately.

**Real time.** The agent keeps one long-poll request open (`GET …/next`, up to 30 s). The fabric answers it the moment work is queued for that host, and the agent posts each result straight back. Work starts within milliseconds, with no polling delay. A 4-core machine handles over 1,000 actions a second ([capacity.md](capacity.md)).

**Steps: only the `hexactra` CLI, on the machine that joins (Linux x86_64 desktop):**
1. Install the CLI and log in: `hexactra login` (see [the CLI guide](../../apps/cli/README.md#install)).
2. `hexactra agent install`. Or, in the terminal UI, open **Agent** and press `i`. It:
   - downloads the agent bundle and verifies it;
   - downloads Chrome for Testing, and sets up its sandbox helper with `sudo` once on Ubuntu 23.10 and later;
   - enrolls the machine with your login;
   - starts a systemd user service in your desktop session;
   - waits until the host is online.
3. Check it with `hexactra agent status`. Fleet also shows the host. Create profiles on it and pick them in tasks.

**Managing the agent:**
- `hexactra agent logs -f`
- `hexactra agent update`
- `hexactra agent stop`, `start` and `restart`
- `hexactra agent uninstall --yes`: also revokes the host in Fleet.

**Joining without being a Fleet admin.** An admin gives you the token from **Fleet → Enroll host**. You run:

```bash
hexactra agent install --enrollment-token hxe_… --agent-url https://<console>/fabric
```

**A fabric you run elsewhere.** If the console points at a fabric other than the bundled one, the enroll command uses that fabric's URL as it is.

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
