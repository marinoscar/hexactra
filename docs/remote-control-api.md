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

The operator token still works on host routes, so existing single-token setups keep working.

## The `hexactra-fabric` CLI

The Rust CLI for the fabric is `hexactra-fabric`, which drives sessions directly and administers the fabric. The user-facing `hexactra` CLI is the console's (`console/`).

| Command | Does |
|---|---|
| `hexactra-fabric admin service-token-create NAME` | Mint an `hxs_` service token, e.g. for the console (needs the operator token; printed once) |
| `hexactra-fabric admin service-token-list`, `service-token-revoke ID` | List (never the tokens) and revoke |
| `hexactra-fabric admin enroll [--name N] [--ttl-minutes M]` | Single-use `hxe_` enrollment plus the `hexactra-agent daemon …` command |
| `hexactra-fabric admin revoke-host ID` | Revoke a host's credential and remove it |

## Endpoints

The full reference is [`api/openapi.yaml`](../api/openapi.yaml) (OpenAPI 3.1).
- **Generated from the server code:** `cargo run -q -p hexactra-control -- openapi > api/openapi.yaml`.
- **Kept in sync by CI:** `crates/hexactra-control/tests/openapi_contract.rs` fails when the committed file is stale, or when a mounted route is missing from it.

| Method and path | Who | Purpose |
|---|---|---|
| `GET /v1/health` | anyone | Liveness and version |
| `GET /v1/hosts` | client | Hosts, with `online`, `browser_connected`, `on_demand` (launches its browser when needed) and `viewer_url` |
| `POST /v1/sessions` | client | Create a session; body `{ "host_id"?, "label"?, "profile"?, "create_profile"? }`. `profile` defaults to `default`. Without `host_id` the control plane picks the most recently seen host that has a connected browser or launches one on demand. `503 no_host_available` if none |
| `GET /v1/sessions`, `GET /v1/sessions/{id}` | client | List or read sessions |
| `DELETE /v1/sessions/{id}` | client | End a session; queued operations become `cancelled` |
| `POST /v1/sessions/{id}/actions` | client | Run one action. Body `{ "action": {...}, "timeout_ms"? }`. Waits for a terminal state and returns the operation. `?async=true` returns `202` at once |
| `GET /v1/operations/{id}?wait_ms=` | client | Read an operation, optionally waiting for it to finish |
| `GET /v1/artifacts/{id}` | client | Bytes of a screenshot, by the handle in its result |
| `POST /v1/hosts/register` | host | Register; body `{ "name", "version", "host_id"?, "viewer_url"? }` |
| `GET /v1/hosts/{id}/next?wait_ms=&browser_connected=&on_demand=&profiles=&running=&commands=` | host | Long-poll (max 30 s) for the next operation, or with `commands=true` a host command (`{ "command": {...} }`, sent first); `204` when none |
| `POST /v1/hosts/{id}/operations/{op}/result` | host | Report `{ "ok", "result"?, "error"? }`. Only the host the operation was dispatched to may report, once |
| `POST /v1/hosts/{id}/commands` | client | Run a [host command](#host-commands); body `{ "command": {...}, "timeout_ms"? }`. Waits for the result; `?async=true` returns `202` |
| `GET /v1/hosts/{id}/commands`, `GET /v1/host-commands/{cmd}?wait_ms=` | client | Recent commands for a host (newest first), or one command |
| `POST /v1/hosts/{id}/commands/{cmd}/result` | host | Report a command's result, like an operation's |

An action that fails in the browser returns `200` with `state: "failed"` and an `error`. Request problems return `400` (invalid action), `404`, `409` (session ended, duplicate result) or `422` (malformed JSON or an unknown action type).

## Event stream

`GET /v1/events` (operator or service token) is a [server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) stream of what happens in the fabric. It lets the console and other clients follow along without polling.

```text
id: 42
event: operation.succeeded
data: {"seq":42,"type":"operation.succeeded","at":"…","data":{"op_id":"…","session_id":"…","host_id":"…","kind":"navigate","state":"succeeded","error":null}}
```

| Type | When |
|---|---|
| `host.registered`, `host.online`, `host.offline`, `host.removed`, `host.browser` | Host lifecycle; `host.browser` fires when the extension connects or disconnects |
| `session.created`, `session.ended` | Session lifecycle |
| `operation.queued`, `operation.dispatched`, `operation.succeeded`, `operation.failed`, `operation.timed_out`, `operation.cancelled` | Each action |
| `handoff.created`, `handoff.resolved`, `handoff.cancelled`, `handoff.expired` | Human handoffs |
| `handoff.secret_used`, `handoff.secret_claimed` | A `secret` answer was consumed by a `type_secret` action (with its `op_id`) or by the deprecated claim route. Never the value |
| `host.command.queued`, `.dispatched`, `.succeeded`, `.failed`, `.timed_out`; `host.draining` | [Host commands](#host-commands) |
| `reset` | You missed events. Re-read state and continue from the new position |

- **Resume after a disconnect** with the `Last-Event-ID` header, or with `?after=<seq>`. The last 2,000 events are kept for replay. A client further behind, or one resuming with a sequence number from before a control-plane restart, gets `reset` first.
- **Filter** with `?types=operation.*,handoff.*`, using the same matching rules as webhooks.
- **Payloads are content-free:** ids, action kinds, states and error messages. They never include typed text, selectors, action URLs, screenshots, handoff prompts, answers or tokens. Read details through the regular endpoints.
- A keep-alive comment is sent every 15 seconds.

## Profiles

A host can keep several named browser profiles, each with its own cookies and sign-ins. Names are 1–32 characters of lowercase letters, digits, `-` and `_`.

- **Hosts report their profiles.** Each poll lists the profiles the host has (`profiles`) and which are running (`running`). `GET /v1/hosts` shows them. A host that reports nothing has only `default`.
- **Sessions pick a profile.** Without `host_id`, the control plane picks an online host that has the profile, preferring one where it is already running.
- **Unknown profiles are refused** with `404 profile_not_found`. Pass `create_profile: true` to let an on-demand host create it, so a typo never silently creates a new, signed-out profile. Attach-mode hosts cannot create profiles.
- **Operations and handoffs carry the session's `profile`.**

## Host commands

Host commands manage a host's profiles and browsers rather than act in a session. They are queued per host, handed to the agent on its next poll ahead of session operations, and go through the same states as operations.

| `type` | Fields | Effect |
|---|---|---|
| `create_profile` | `profile` | Create an empty, signed-out profile |
| `delete_profile` | `profile` | Close its browser and delete the profile directory (cookies, sign-ins, storage). Refused for `default`, and with `409` while an active session uses the profile |
| `restart_browser` | `profile` | Close the profile's browser and start it again |
| `close_browser` | `profile` | Close the profile's browser gracefully; the next action starts it again |
| `drain` | `enabled` (default `true`) | Stop (or resume) placing new sessions on the host. Existing sessions keep working. Applied by the control plane at once; the host shows `draining: true` |

- **Launch-mode hosts only.** Attach-mode hosts use the Chrome you run yourself, so they fail profile and browser commands with an error that says so. `drain` works for every host.
- **Agent support.** Agents ask for commands with `commands=true` on their poll. An older agent never receives one, and the command times out with an error saying it did not run.
- **Effects show at once.** A successful `create_profile` or `delete_profile` updates the host's `profiles` without waiting for its next poll.
- **CLI:**
  - `hexactra-fabric profile create|delete|close|restart NAME [--host ID]`. `delete` needs `--yes`.
  - `hexactra-fabric host drain|undrain|commands HOST`.

## Actions

Actions are JSON objects tagged by `type`. `tab_id` is optional on tab-scoped actions; without it the active tab of the last focused window is used.

| `type` | Fields | Result |
|---|---|---|
| `navigate` | `url` | `{ url, title }` |
| `click` | `selector` | `{}` |
| `type` | `selector`, `text`, `clear`?, `submit`?, `sensitive`? | `{}` |
| `type_secret` | `handoff_id`, `selector`, `clear`?, `submit`? | `{}`. Types the answer of a `secret` handoff; see [secrets](#secrets-typed-by-the-fabric) |
| `press` | `key`, `selector`? | `{}` |
| `scroll` | `dx`?, `dy`?, `selector`? | `{ x, y }` |
| `screenshot` | — | `{ artifact_id, mime, size, expires_at }`: fetch the bytes from `GET /v1/artifacts/{artifact_id}` ([artifacts](#artifacts)) |
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
- A `type` action with `"sensitive": true` (CLI: `type --sensitive`) still sends its text to the host, but the operation view reports it as `[secret]`; use it for passwords the caller already holds.

## Artifacts

Screenshots do not travel inside operation results. The control plane keeps the image and returns a short-lived handle; large data moves by handle, not in control messages.

- **Fetch:** `GET /v1/artifacts/{id}` (client token) returns the bytes with their `Content-Type` and `Cache-Control: no-store`.
- **Lifetime:** handles last 15 minutes. The control plane keeps at most 256 MiB, dropping the oldest first. After that, or after a restart, the handle returns `404`. Artifacts are never written to disk.
- **Migration flag:** send `"inline_artifacts": true` in the action body, or `?inline_artifacts=true`, to also get the base64 `data` as before.
- **CLI and MCP** fetch the bytes by handle, so `hexactra-fabric screenshot -o file.jpg` and `browser_screenshot` work unchanged.

## Operation states

`queued` → `dispatched` → `succeeded` | `failed`, or `timed_out` (no result in time; the error says whether the action may have run) or `cancelled` (the session ended first).

## Human handoff

When an agent meets something only a person should do (a CAPTCHA, a one-time code, a passkey, a purchase to approve), it opens a **handoff**. The session pauses: actions return `409 handoff_pending` until a person answers or the handoff expires. Hexactra never tries to solve or bypass these checks.

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /v1/sessions/{id}/handoffs` | API token | Open a handoff. Returns `{ handoff, response_token, respond_path }` |
| `GET /v1/handoffs?pending=true&session_id=` | API token | List handoffs |
| `GET /v1/handoffs/{id}?wait_ms=` | API token | Read one, waiting up to 120 s for it to resolve |
| `POST /v1/handoffs/{id}/claim` | Operator or service token | **Deprecated.** Return a `secret` answer once, then erase it. Use a `type_secret` action instead |
| `POST /v1/handoffs/{id}/cancel` | API token | Cancel |
| `POST /v1/handoffs/{id}/respond` | API token **or** response token | Answer as JSON: `{ "outcome": "completed" \| "cancelled", "value"?, "values"?, "channel"?, "answered_by"?, "response_token"? }`. The token can also go in the `X-Hexactra-Response-Token` header |
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
  - `none`: the person acts in the browser and clicks "Done".
  - `takeover`: the person operates the browser themselves, then clicks "Done".
  - `text`: a free-text answer. Constraints: `max_length` (1 to 4096, default 4096), `pattern` (a regex of at most 200 characters the whole answer must match), `multiline` (`false` rejects newlines).
  - `secret`: an answer that is withheld from reads and payloads and typed into the page by the control plane, once ([below](#secrets-typed-by-the-fabric)). Constraint: `max_length`.
  - `choice`: one of `choices`; the answer's `value` is the option id.
  - `multi_choice`: several of `choices`; the answer's `values` are option ids, unique, between `min_selections` (default 1) and `max_selections` (default: all).
  - `number`: a decimal string, returned in canonical form (`02.50` becomes `2.5`). Constraints: `min`, `max`, `step` (the answer is `min`, or 0, plus a multiple of it), `unit` (a label, at most 20 characters).
  - `confirm`: `value` is `approve` or `deny`. Optional `confirm_label` and `deny_label` (at most 40 characters each) and `risk` (`low` or `high`, default `high`). A `deny` is a completed answer, not a cancellation.
- `choices` (1 to 10) are strings or `{ "id", "label", "description"? }` objects; an id matches `[A-Za-z0-9_-]{1,64}`, a label is at most 100 characters and a description at most 200. A string is both the id and the label. Handoffs always return options as objects.
- `constraints` is an object; a constraint that does not apply to the `input` is a `400`, as are `choices` on other inputs and the confirm fields on anything but `confirm`.
- The timeout defaults to 10 minutes and can be set from 10 seconds to 24 hours.

Rules:

- The response token is 256 bits, stored only as a SHA-256 digest, and **single use**. It stops working once the handoff resolves, is cancelled or expires.
- A response token can only answer its own handoff. It cannot call any other route.
- `secret` values never appear in `GET` responses, logs or event payloads.
- Ending a session cancels its open handoff and erases any unused secret answer of the session.
- When the session's host registered a `viewer_url`, the handoff carries it. The answer page and webhook payloads then link to the remote browser, so a person can solve a CAPTCHA or approve a passkey there.
- The HTML page escapes all agent-provided text. It is served with a `default-src 'none'` CSP, `no-store`, `no-referrer` and `DENY` framing.

Statuses: `pending` → `completed` | `cancelled` | `expired`.

An answered handoff carries `response`: `{ "outcome": "completed" | "cancelled", "value"?, "values"?, "value_withheld", "channel"?, "by", "answered_at" }`. `by` is `operator`, `service:<token name>`, `token` (the response-token holder), or the `answered_by` an operator or service caller sent (at most 128 characters, e.g. `user:42`); `answered_by` from a response-token answer is ignored. `cancelled` means the person declined. Handoffs saved before these fields existed read back with `outcome` taken from the status and `answered_at` from `resolved_at`.

### Secrets typed by the fabric

A `secret` answer (a one-time code, a password) is never returned to the caller that asked for it. The agent asks the control plane to type it:

```json
POST /v1/sessions/{session_id}/actions
{ "action": { "type": "type_secret", "handoff_id": "…", "selector": "#otp", "submit": true } }
```

- The control plane checks that the handoff belongs to this session, asked for a `secret`, and was answered. It then takes the value, once, and sends the host an ordinary `type` action carrying it. Only that host-bound command contains the value.
- The operation view (`GET /v1/operations/{id}`), events, webhooks, logs and traces show the `type_secret` action (handoff id and selector), never the value. The host's result is reported as for `type`.
- Errors: `404 not_found` (unknown handoff), `422 handoff_wrong_session` (the handoff belongs to another session), `422 handoff_not_secret`, and `409 secret_unavailable` (not answered yet, cancelled or expired, already used, or erased).
- Lifetime: the value is kept in memory only (never persisted) and erased, with its memory zeroed, when it is used, when the session ends, or 10 minutes after the person answered if nothing used it. A value taken by a `type_secret` that then times out before a host picks it up is dropped too; ask the person again.
- The MCP tool is `browser_type_secret { handoff_id, selector, clear?, submit? }`; `browser_request_human` with `input: "secret"` answers `{"status": "completed", "value_withheld": true, …}`. The CLI is `hexactra-fabric handoff type-secret <id> --selector <css> [--clear] [--submit]`; `handoff request --wait` and `handoff show` never print a secret.
- `POST /v1/handoffs/{id}/claim` still returns the value once, for operator and service tokens only, with a `Deprecation: true` header. It shares the single use: whichever of claim and `type_secret` comes first gets the value. It will be removed once its callers move to `type_secret`.

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

## Tracing and metrics (OpenTelemetry)

`hexactra-control` and `hexactra-agent` export OpenTelemetry traces and metrics over OTLP/HTTP. Export is off unless an endpoint is set.

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL, e.g. `http://otel-collector:4318`. Unset or empty means nothing is exported |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` (default) or `http/json` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `..._METRICS_ENDPOINT`, `OTEL_BSP_*`, `OTEL_METRIC_EXPORT_INTERVAL` | Standard OpenTelemetry settings |

**One trace runs from the caller to the browser.**
- Send a W3C `traceparent` header with any `/v1` request.
- The control plane's `http.request` span joins that trace.
- The context travels with the queued action or host command to the agent, whose `operation.execute` or `host_command.execute` span continues it.
- Propagation works even with export off, so a caller's trace id still reaches the agent's logs.
- Host long-polls and the event stream get no span unless the caller sends a `traceparent`.

**Metrics:**

| Metric | Meaning |
|---|---|
| `hexactra.operations` | Count of actions, by `kind` and final `state` |
| `hexactra.operation.duration` | Seconds from queue to final state |
| `hexactra.host_commands` | Count of host commands, by `kind` and `state` |

**Content-free:** span names, attributes and events carry ids, routes (templated, such as `/v1/sessions/{id}/actions`), kinds, profile names and states. They never carry action URLs, selectors, typed text, screenshots or tokens. The e2e test checks that no action URL reaches the collector.

## Limitations of this release

- **State and restarts.** The control plane saves hosts, sessions, handoffs and credentials to a SQLite state database: `--state-db`, `HEXACTRA_STATE_DB`, default `$XDG_DATA_HOME/hexactra/control.db`, mode `0600`.
  - What is saved: about once a second when something changed, plus on SIGTERM or Ctrl-C. Credentials are stored as digests only.
  - What is not saved: **operations**, which are short-lived; a caller waiting at restart time sees a timeout. **Secret handoff answers** waiting to be typed. **Connection state**: hosts come back offline until they poll.
  - Run history and the audit trail belong to the Hexactra Console (#217).
- The pre-existing routes in `crates/hexactra-control/src/routes/` are not mounted by this server.
