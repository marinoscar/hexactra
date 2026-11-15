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

Mint a service token for the console. It runs inside the API container, which already has the operator token:

```bash
docker compose $F exec api node -e "fetch('http://fabric-control:8787/v1/admin/service-tokens',{method:'POST',headers:{authorization:'Bearer '+process.env.HEXACTRA_FABRIC_OPERATOR_TOKEN,'content-type':'application/json'},body:JSON.stringify({name:'console'})}).then(r=>r.json()).then(j=>console.log(j.token))"
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

## Troubleshooting

| Symptom | Fix |
|---|---|
| `fabric.reachable` fails | `docker compose $F ps fabric-control`; the URL must be `http://fabric-control:8787` |
| `fabric.token` fails | Mint a new service token (section 3) and save it |
| `fabric.hosts` warns | `docker compose $F logs fabric-host`; the host must be healthy and use the same operator token |
| The viewer says 401 | Open it from the Fleet page (tickets expire after 60 s and work once) |
