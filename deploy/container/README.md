# Hexactra container stack

The control plane and a browser host run as containers, so you can drive a browser on demand even when your desktop is off. The host runs Chromium on a virtual display with the Hexactra extension, starts it on demand, and keeps its profile in a volume.

```bash
cd deploy/container
./setup.sh                      # writes .env (0600): API token and viewer password
docker compose up -d --build
docker compose exec control hexactra --url http://127.0.0.1:8787 status
```

| Service | Published on | What it is |
|---|---|---|
| `control` | `127.0.0.1:8787` | `/v1` API, plus the `hexactra` CLI and `hexactra-mcp` inside the image |
| `host` | `127.0.0.1:6080` | Password-protected noVNC viewer (`/vnc.html`) of the container's browser |

Volumes: `control-data` holds the webhook registry, and `host-data` holds the browser profile (`/data/profile`).

Settings live in `.env`:
- `HEXACTRA_IDLE_SHUTDOWN_S` (default 900; 0 keeps the browser open);
- `HEXACTRA_LAUNCH_EAGERLY`;
- `HEXACTRA_PUBLIC_URL` and `HEXACTRA_VIEWER_URL` (external links for webhooks and handoffs);
- `HEXACTRA_HOST_NAME`.

Full guide (deployment, Tailscale, first sign-in, backups, security): [docs/container-host.md](../../docs/container-host.md).

Test: `bash tests/e2e/container.e2e.sh` builds the images and drives the containerized browser end to end.
