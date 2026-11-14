# Remote control API (`/v1`)

The `/v1` API lets a person or an AI agent drive a browser on a host machine from anywhere. It is served by the `hexactra-control` binary. Epic: #173.

```text
client (CLI, MCP, SDK) ──HTTP──▶ hexactra-control ◀──long-poll── host agent ──native messaging──▶ Chrome extension ──▶ page
```

## Run the server

```bash
cargo build --release -p hexactra-control
./target/release/hexactra-control serve            # listens on 127.0.0.1:8787
```

| Setting | Flag | Environment | Default |
|---|---|---|---|
| Listen address | `--bind` | `HEXACTRA_BIND` | `127.0.0.1:8787` |
| Allow a non-loopback address | `--allow-remote-bind` | `HEXACTRA_ALLOW_REMOTE_BIND` | off |
| Token file | `--token-file` | `HEXACTRA_TOKEN_FILE` | `$XDG_CONFIG_HOME/hexactra/api-token` |
| Token value (overrides the file) | — | `HEXACTRA_API_TOKEN` | — |

On first start, if no token is configured, the server generates a 64-hex-character token and writes it to the default token file with mode `0600`. The token itself is never logged. `hexactra-control token-path` prints where that file is.

The server refuses to listen on a non-loopback address unless `--allow-remote-bind` is passed. Reach it remotely through an SSH tunnel or a private network such as Tailscale or WireGuard; do not expose it to the internet.

## Authentication

Every route except `GET /v1/health` requires `Authorization: Bearer <token>`. A missing or wrong token returns `401`. Clients and host agents share one token in this release.

## Endpoints

| Method and path | Who | Purpose |
|---|---|---|
| `GET /v1/health` | anyone | Liveness and version |
| `GET /v1/hosts` | client | Hosts, with `online` and `browser_connected` |
| `POST /v1/sessions` | client | Create a session; body `{ "host_id"?, "label"? }`. Without `host_id` the most recently seen host with a connected browser is chosen. `503 no_host_available` if none |
| `GET /v1/sessions`, `GET /v1/sessions/{id}` | client | List or read sessions |
| `DELETE /v1/sessions/{id}` | client | End a session; queued operations become `cancelled` |
| `POST /v1/sessions/{id}/actions` | client | Run one action. Body `{ "action": {...}, "timeout_ms"? }`. Waits for a terminal state and returns the operation. `?async=true` returns `202` at once |
| `GET /v1/operations/{id}?wait_ms=` | client | Read an operation, optionally waiting for it to finish |
| `POST /v1/hosts/register` | host | Register; body `{ "name", "version", "host_id"? }` |
| `GET /v1/hosts/{id}/next?wait_ms=&browser_connected=` | host | Long-poll (max 30 s) for the next operation; `204` when none |
| `POST /v1/hosts/{id}/operations/{op}/result` | host | Report `{ "ok", "result"?, "error"? }`. Only the host the operation was dispatched to may report, once |

An action that fails in the browser returns `200` with `state: "failed"` and an `error`. Request problems return `400` (invalid action), `404`, `409` (session ended, duplicate result) or `422` (malformed JSON or an unknown action type).

## Actions

Actions are JSON objects tagged by `type`. `tab_id` is optional on tab-scoped actions; without it the active tab of the last focused window is used.

| `type` | Fields | Result |
|---|---|---|
| `navigate` | `url` | `{ url, title }` |
| `click` | `selector` | `{}` |
| `type` | `selector`, `text`, `clear`?, `submit`? | `{}` |
| `press` | `key`, `selector`? | `{}` |
| `scroll` | `dx`?, `dy`?, `selector`? | `{ x, y }` |
| `screenshot` | — | `{ mime, data }` (base64) |
| `text` | `selector`?, `max_chars`? | `{ text, truncated }` |
| `elements` | `max_elements`? | `{ elements: [{ selector, tag, role, text, ... }] }` |
| `wait_for` | `selector`, `timeout_ms`? (≤ 60000) | `{}` |
| `tabs` | — | `{ tabs: [{ id, url, title, active }] }` |
| `new_tab` | `url`? | `{ tab_id }` |
| `activate_tab`, `close_tab` | `tab_id` | `{}` |
| `back`, `forward`, `reload` | — | `{}` |

Policy enforced before an action is queued:

- `navigate` and `new_tab` accept only `http(s)` URLs and `about:blank`. `javascript:`, `file:`, `chrome:`, `data:` and extension URLs are refused.
- There is no "run arbitrary JavaScript" action.
- Selectors are limited to 2,000 characters and typed text to 100,000.
- Logs record the action `type` only, never URLs, selectors or typed text.

## Operation states

`queued` → `dispatched` → `succeeded` | `failed`, or `timed_out` (no result in time; the error says whether the action may have run) or `cancelled` (the session ended first).

## Limitations of this release

- State is in memory: restarting `hexactra-control` drops sessions and operations. Durable sessions and the audit trail are follow-up work on #173.
- One shared token for clients and hosts.
- The pre-existing routes in `crates/hexactra-control/src/routes/` are not mounted by this server.
