# Always-on browser host (containers)

Run Hexactra on an always-on machine, so you can drive a browser on demand even when your desktop is off. Epic: #195.

```text
laptop / phone / AI agent ──(Tailscale or SSH)──▶ control  (API :8787)
                                                     ▲ long-poll
                                                  host  (Chromium on Xvfb + extension + agent, viewer :6080)
```

- **control**: the `/v1` API, plus the `hexactra` CLI and `hexactra-mcp` inside the image.
- **host**:
  - Chromium on a virtual display, with the Hexactra extension and the agent in launch mode;
  - the browser starts on the first action, closes after an idle period, and keeps its profile in a volume;
  - a password-protected web viewer (noVNC) lets you see and use that browser from any device, to sign in or to solve a CAPTCHA.

Your desktop setup (attach mode) still works. Both hosts can be registered at once; pick one with `hexactra session create --host <id>`.

## 1. Pick a machine

Any always-on Linux machine with Docker works: a home server, mini PC, NAS that runs Docker, or a small VPS.

| Need | Recommended |
|---|---|
| CPU and memory | 2 vCPU, 2 GB RAM (about 600 MB while the browser is open, about 60 MB when idle) |
| Disk | 5 GB for images and the profile |
| Network | Outbound internet. Nothing needs to be exposed publicly. |

A home machine keeps your home IP, which looks like you to most sites. A VPS IP sits in a data-centre range and is more likely to face extra checks. Hexactra hands those checks to you; it does not try to get around them.

## 2. Install

```bash
git clone https://github.com/marinoscar/hexactra && cd hexactra/deploy/container
./setup.sh                      # creates .env (0600) with an API token and viewer password
docker compose up -d --build    # first build takes a few minutes
docker compose ps               # both services "healthy"
docker compose exec control hexactra --url http://127.0.0.1:8787 status
# host … container-host  online=true browser=false on_demand=true
```

`browser=false` is expected: the browser starts with the first action.

## 3. Reach it privately

Both ports are published on `127.0.0.1` only. Pick one of the following.

**Tailscale (recommended).** Install Tailscale on the machine, then:

```bash
sudo tailscale serve --bg --https=443  http://127.0.0.1:8787   # API
sudo tailscale serve --bg --https=8443 http://127.0.0.1:6080   # viewer
```

Then set the external URLs in `.env` and apply them:

```bash
HEXACTRA_PUBLIC_URL=https://<machine>.<tailnet>.ts.net
HEXACTRA_VIEWER_URL=https://<machine>.<tailnet>.ts.net:8443/vnc.html
docker compose up -d
```

**SSH tunnel.**

```bash
ssh -N -L 8787:127.0.0.1:8787 -L 6080:127.0.0.1:6080 you@machine
```

On your laptop, point the CLI and MCP at it:

```bash
export HEXACTRA_URL=https://<machine>.<tailnet>.ts.net     # or http://127.0.0.1:8787 over SSH
export HEXACTRA_API_TOKEN=<value of HEXACTRA_API_TOKEN in .env>
hexactra status
claude mcp add hexactra --env HEXACTRA_URL=$HEXACTRA_URL --env HEXACTRA_API_TOKEN=$HEXACTRA_API_TOKEN -- hexactra-mcp
```

## 4. Sign in once through the viewer

The container's browser has its own profile. Your desktop Chrome profile cannot be copied, because its cookies are encrypted with your desktop keyring. Sign in to the sites you need once:

1. Start the browser: `hexactra navigate https://accounts.google.com`.
2. Open the viewer (`…/vnc.html`) and enter the viewer password from `.env`.
3. Sign in to each site, completing any 2-step verification.
4. Optionally set `HEXACTRA_IDLE_SHUTDOWN_S=0` while you do this, so the browser stays open.

Each profile lives in `/data/profiles/<name>` on the `host-data` volume. A volume from the single-profile release (`/data/profile`) is moved to `/data/profiles/default` automatically. Cookies and sign-ins stay in the volume across idle shutdowns, container restarts and upgrades. Debian's Chromium has no Chrome Sync, but signing in to websites, Google included, works normally. Sites may sign you out over time; when that happens, the agent asks you through a handoff.

## 5. When a site challenges the agent

The agent opens a handoff, and your webhook channels get the prompt, the answer link, and a link to this host's viewer. Open the viewer, solve the CAPTCHA or approve the sign-in in the remote browser, then tap **I've done it** on the answer page. One-time codes can be typed straight into the answer form. See [remote-control-quickstart.md §6](remote-control-quickstart.md#6-captchas-codes-and-approvals-handing-off-to-you).

## 6. On-demand behaviour

| Setting (`.env`) | Default | Effect |
|---|---|---|
| `HEXACTRA_IDLE_SHUTDOWN_S` | `900` | Close the browser after 15 idle minutes. The next action starts it again in a few seconds with the same profile. `0` keeps it open. |
| `HEXACTRA_LAUNCH_EAGERLY` | `false` | Start the browser when the container starts. |
| `HEXACTRA_MAX_BROWSERS` | `1` | Profiles whose browsers may be open at once. Each needs about 300–600 MB. At the limit, the least recently used idle browser closes to make room. |
| `HEXACTRA_SCREEN` | `1440x900x24` | Virtual display size. |

Browsers close gracefully, through the extension, when idle, when evicted and when the container stops (`stop_grace_period: 30s`). Chromium therefore writes cookies to disk and reopens with its last tabs. The containers restart automatically after a crash or reboot (`restart: unless-stopped`). Enable Docker at boot with `sudo systemctl enable docker`.

## 7. Operate

```bash
git pull && docker compose up -d --build            # upgrade
docker compose logs -f host                          # agent and browser logs
docker run --rm -v hexactra_host-data:/d -v "$PWD":/b debian:bookworm-slim \
  tar czf /b/hexactra-profile.tgz -C /d .            # back up the profile (holds your sign-ins)
docker compose down                                  # stop (volumes are kept)
```

## 8. Security checklist

- The API token and viewer password are in `.env` (mode `0600`). Rotate them by editing `.env` and running `docker compose up -d`.
- Keep the API and viewer private (Tailscale or SSH). VNC passwords are limited to 8 characters, so never publish port 6080 to the internet.
- The profile volume holds live sign-ins: treat backups as secrets.
- Chromium runs as a non-root user (uid 1000) **with its sandbox on**; CI checks that renderers run in their own namespace.
- The host container gets `CAP_SYS_ADMIN`, because Docker's default seccomp profile allows the sandbox's namespaces only with it. Only the setuid `chrome-sandbox` helper, the image's sole setuid binary, can use that capability. This is safer than the common `--no-sandbox` alternative.
- The containers need no `privileged` mode and no `seccomp=unconfined`.
- Webhook channels receive answer tokens: register only channels you control.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `browser unavailable: browser exited during startup` | The error includes the browser's last output (full log: `docker compose exec host cat /data/profile/hexactra-browser.log`). `Failed to move to new namespace` means the `SYS_ADMIN` capability from `compose.yml` is missing. |
| A session waits, then reports the extension did not connect | Rebuild the image (`--build`) so the extension and native host versions match. |
| The viewer shows a black screen | The browser is idle-stopped. Run any action, or set `HEXACTRA_LAUNCH_EAGERLY=true`. |
| Sites ask you to sign in again | Sign in through the viewer. If it keeps happening, consider running the stack at home rather than on a VPS. |

## Desktop off: alternatives considered

- **Wake-on-LAN for the desktop:** needs a device that stays on in the same LAN and a BIOS that supports it, and the desktop must auto-login. It can complement the container host but does not replace it. Not implemented.
- **Copying the desktop profile:** not possible, because the cookies are encrypted with the desktop keyring.
