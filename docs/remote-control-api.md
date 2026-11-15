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

## Authentication and credentials

Every route except `GET /v1/health`, the handoff answer page and `POST /v1/hosts/enroll` requires `Authorization: Bearer <token>`. Tokens are scoped:

| Kind | Looks like | May call |
|---|---|---|
| operator | the configured token (`api-token` file or `HEXACTRA_API_TOKEN`) | everything, including service-token management |
| service | `hxs_…` | client routes (hosts list, sessions, actions, operations, handoffs, webhooks) and host enrollment/revocation |
| host | `hxh_…` | only its own host routes: register, poll, report results, go offline |
| enrollment | `hxe_…` | only `POST /v1/hosts/enroll`, once, before it expires |

Tokens are stored as SHA-256 digests only and shown once when created. A wrong token returns `401`; a valid token on a route outside its scope returns `403`.

**Enrolling a host** (recommended over sharing the operator token):

```bash
# operator or service token
curl -X POST $URL/v1/admin/hosts/enrollments -H "Authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"name":"vps","ttl_s":3600}'
# → { "enrollment": {...}, "enrollment_token": "hxe_…" }

# on the host
hexactra-agent daemon --url $URL --enrollment-token hxe_… [--browser …]
```

The agent exchanges the enrollment token once, saves its host credential to `$XDG_CONFIG_HOME/hexactra/host-credential.json` (mode `0600`) and uses it from then on. `DELETE /v1/admin/hosts/{id}` revokes a host: its credential stops working and its sessions end. On shutdown an agent calls `POST /v1/hosts/{id}/offline`, so no new sessions are routed to it.

| Method and path | Token | Purpose |
|---|---|---|
| `POST /v1/admin/hosts/enrollments` | operator, service | Create an enrollment `{ "name"?, "ttl_s"? }` (default 1 h, at most 7 days) |
| `GET /v1/admin/hosts/enrollments` | operator, service | Pending enrollments (no tokens) |
| `POST /v1/hosts/enroll` | none (enrollment token in body) | `{ "enrollment_token", "name"?, "version"? }` → `{ host_id, host_token }` |
| `DELETE /v1/admin/hosts/{id}` | operator, service | Revoke and remove a host |
| `POST /v1/admin/service-tokens` | operator | Create `{ "name" }` → `{ service_token, token }` |
| `GET /v1/admin/service-tokens` | operator | List (no tokens) |
| `DELETE /v1/admin/service-tokens/{id}` | operator | Revoke |

The operator token still works on host routes, so existing single-token setups keep working. Credentials are held in memory in this release; durable storage lands with #211.

## Endpoints

| Method and path | Who | Purpose |
|---|---|---|
| `GET /v1/health` | anyone | Liveness and version |
| `GET /v1/hosts` | client | Hosts, with `online`, `browser_connected`, `on_demand` (launches its browser when needed) and `viewer_url` |
| `POST /v1/sessions` | client | Create a session; body `{ "host_id"?, "label"?, "profile"?, "create_profile"? }`. `profile` defaults to `default`. Without `host_id` the control plane picks the most recently seen host that has a connected browser or launches one on demand. `503 no_host_available` if none |
| `GET /v1/sessions`, `GET /v1/sessions/{id}` | client | List or read sessions |
| `DELETE /v1/sessions/{id}` | client | End a session; queued operations become `cancelled` |
| `POST /v1/sessions/{id}/actions` | client | Run one action. Body `{ "action": {...}, "timeout_ms"? }`. Waits for a terminal state and returns the operation. `?async=true` returns `202` at once |
| `GET /v1/operations/{id}?wait_ms=` | client | Read an operation, optionally waiting for it to finish |
| `POST /v1/hosts/register` | host | Register; body `{ "name", "version", "host_id"?, "viewer_url"? }` |
| `GET /v1/hosts/{id}/next?wait_ms=&browser_connected=&on_demand=&profiles=&running=` | host | Long-poll (max 30 s) for the next operation; `204` when none |
| `POST /v1/hosts/{id}/operations/{op}/result` | host | Report `{ "ok", "result"?, "error"? }`. Only the host the operation was dispatched to may report, once |

An action that fails in the browser returns `200` with `state: "failed"` and an `error`. Request problems return `400` (invalid action), `404`, `409` (session ended, duplicate result) or `422` (malformed JSON or an unknown action type).

## Profiles

A host can keep several named browser profiles, each with its own cookies and sign-ins. Names are 1–32 characters of lowercase letters, digits, `-` and `_`.

- **Hosts report their profiles.** Each poll lists the profiles the host has (`profiles`) and which are running (`running`). `GET /v1/hosts` shows them. A host that reports nothing has only `default`.
- **Sessions pick a profile.** Without `host_id`, the control plane picks an online host that has the profile, preferring one where it is already running.
- **Unknown profiles are refused** with `404 profile_not_found`. Pass `create_profile: true` to let an on-demand host create it, so a typo never silently creates a new, signed-out profile. Attach-mode hosts cannot create profiles.
- **Operations and handoffs carry the session's `profile`.**

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
- When the session's host registered a `viewer_url`, the handoff carries it. The answer page and webhook payloads then link to the remote browser, so a person can solve a CAPTCHA or approve a passkey there.
- The HTML page escapes all agent-provided text. It is served with a `default-src 'none'` CSP, `no-store`, `no-referrer` and `DENY` framing.

Statuses: `pending` → `completed` | `cancelled` | `expired`.

## Webhooks: channels that reach a person

Webhooks let any number of channels hear about handoffs and answer them: a Slack or Telegram bot, an n8n or Zapier flow, an email or SMS gateway, your own service.

| Method and path | Purpose |
|---|---|
| `POST /v1/webhooks` | Register `{ "url", "events"?, "description"? }`. `events` defaults to `["handoff.*"]`. Returns `{ webhook, secret }`; the `whsec_…` secret is shown **only once** |
| `GET /v1/webhooks` | List endpoints (no secrets) |
| `DELETE /v1/webhooks/{id}` | Remove an endpoint |
| `POST /v1/webhooks/{id}/test` | Send a `webhook.test` event |
| `GET /v1/webhooks/{id}/deliveries` | The last 50 attempts: outcome, HTTP status, error |

Events: `handoff.created`, `handoff.resolved`, `handoff.cancelled`, `handoff.expired`, `webhook.test`. Filters accept an exact name, `handoff.*` or `*`.

### Payload

```json
{
  "id": "evt_3f2c…",
  "type": "handoff.created",
  "created_at": "2026-11-14T21:30:00Z",
  "data": {
    "handoff": { "id": "…", "kind": "code", "prompt": "Enter the code…", "input": "secret", "status": "pending", "expires_at": "…", "page": { "url": "…", "title": "…" } },
    "respond": {
      "token": "<single-use response token>",
      "path": "/v1/handoffs/<id>/respond",
      "method": "POST",
      "token_header": "x-hexactra-response-token",
      "url": "https://hexactra.example.test/v1/handoffs/<id>/respond",
      "form_url": "https://hexactra.example.test/v1/handoffs/<id>/respond?token=<token>"
    }
  }
}
```

- `respond` appears only on `handoff.created`.
- `url` and `form_url` are present when the server runs with `--public-url` (`HEXACTRA_PUBLIC_URL`).
- A channel can answer in either of two ways:
  - `POST` JSON `{ "value": "…", "channel": "slack", "response_token": "<token>" }` to `url`;
  - send the person `form_url`, which opens a small page where they type the answer or click done.
- The first answer from any channel wins. The token then stops working for every channel.
- `secret` answers never appear in later events.

### Signature

Deliveries follow [Standard Webhooks](https://www.standardwebhooks.com/). Headers:

- `webhook-id`: the event id, which stays the same across retries;
- `webhook-timestamp`: Unix seconds;
- `webhook-signature`: `v1,<base64>`.

The signature is HMAC-SHA256 over `"{webhook-id}.{webhook-timestamp}.{raw body}"`, keyed with the base64-decoded part of the secret after `whsec_`. Reject timestamps more than 5 minutes old.

```js
import crypto from 'node:crypto';
function verify(secret, headers, rawBody) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signed = `${headers['webhook-id']}.${headers['webhook-timestamp']}.${rawBody}`;
  const expected = 'v1,' + crypto.createHmac('sha256', key).update(signed).digest('base64');
  const fresh = Math.abs(Date.now() / 1000 - Number(headers['webhook-timestamp'])) < 300;
  return fresh && headers['webhook-signature'].split(' ').some((s) =>
    s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
```

```python
import base64, hashlib, hmac, time
def verify(secret, headers, raw_body: bytes) -> bool:
    key = base64.b64decode(secret.removeprefix("whsec_"))
    signed = f"{headers['webhook-id']}.{headers['webhook-timestamp']}.".encode() + raw_body
    expected = "v1," + base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
    fresh = abs(time.time() - int(headers["webhook-timestamp"])) < 300
    return fresh and any(hmac.compare_digest(s, expected) for s in headers["webhook-signature"].split())
```

### Delivery and safety

- Retries: up to 5 attempts, after 0 s, 5 s, 30 s, 2 min and 10 min. Any 2xx counts as delivered. Each attempt times out after 10 s, and redirects are not followed.
- Targets must be `https` and resolve to public addresses. Start the server with `--webhook-allow-insecure` (`HEXACTRA_WEBHOOK_ALLOW_INSECURE=1`) to allow `http` and private, loopback or Tailscale (CGNAT) addresses, for example an n8n instance on your LAN.
- Link-local, multicast and unspecified addresses, which include cloud metadata endpoints, are always refused. The resolved address is pinned for the request.
- The registry is saved to `$XDG_CONFIG_HOME/hexactra/webhooks.json` (mode `0600`, because it holds secrets), or to the path given by `--webhooks-file`.
- Every subscribed endpoint receives a token that can answer the handoff, so register only channels you trust.

## Limitations of this release

- State is in memory: restarting `hexactra-control` drops sessions and operations. Durable sessions and the audit trail are follow-up work on #173.
- The pre-existing routes in `crates/hexactra-control/src/routes/` are not mounted by this server.
