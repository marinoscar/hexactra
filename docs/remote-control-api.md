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

## Human handoff

When an agent meets something only a person should do (a CAPTCHA, a one-time code, a passkey, a purchase to approve), it opens a **handoff**. The session pauses: actions return `409 handoff_pending` until a person answers or the handoff expires. Hexactra never tries to solve or bypass these checks.

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /v1/sessions/{id}/handoffs` | API token | Open a handoff. Returns `{ handoff, response_token, respond_path }` |
| `GET /v1/handoffs?pending=true&session_id=` | API token | List handoffs |
| `GET /v1/handoffs/{id}?wait_ms=` | API token | Read one, waiting up to 120 s for it to resolve |
| `POST /v1/handoffs/{id}/claim` | API token | Return a `secret` answer once, then erase it |
| `POST /v1/handoffs/{id}/cancel` | API token | Cancel |
| `POST /v1/handoffs/{id}/respond` | API token **or** response token | Answer as JSON: `{ "outcome": "completed" \| "cancelled", "value"?, "channel"?, "response_token"? }`. The token can also go in the `X-Hexactra-Response-Token` header |
| `GET /v1/handoffs/{id}/respond?token=` | response token | A minimal HTML page with the prompt and a form, for channels that can only send a link (email, SMS, chat) |

Create body:

```json
{
  "kind": "code",
  "prompt": "Enter the 6-digit code the airline sent to your phone",
  "input": "secret",
  "timeout_ms": 600000,
  "page": { "url": "https://example.test/login", "title": "Sign in" }
}
```

- `kind` is one of `captcha`, `code`, `passkey`, `login`, `confirmation` or `other`.
- `input` is one of:
  - `none`: the person acts in the browser and clicks "done".
  - `text`: a free-text answer.
  - `secret`: an answer that is withheld from reads and payloads and claimed once.
  - `choice`: one of `choices` (1 to 10 options).
- The timeout defaults to 10 minutes and can be set from 10 seconds to 24 hours.

Rules:

- The response token is 256 bits, stored only as a SHA-256 digest, and **single use**. It stops working once the handoff resolves, is cancelled or expires.
- A response token can only answer its own handoff. It cannot call any other route.
- `secret` values never appear in `GET` responses, logs or event payloads.
- Ending a session cancels its open handoff.
- The HTML page escapes all agent-provided text. It is served with a `default-src 'none'` CSP, `no-store`, `no-referrer` and `DENY` framing.

Statuses: `pending` → `completed` | `cancelled` | `expired`.

## Limitations of this release

- State is in memory: restarting `hexactra-control` drops sessions and operations. Durable sessions and the audit trail are follow-up work on #173.
- One shared token for clients and hosts.
- The pre-existing routes in `crates/hexactra-control/src/routes/` are not mounted by this server.
