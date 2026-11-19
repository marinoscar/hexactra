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
| `GET /v1/hosts` | client | Hosts, with `online`, `browser_connected`, `on_demand` (launches its browser when needed) and `viewer_url`. *Planned* (#336): `mode` (`unattended`, `attended`, `container`) and `desktop` (true when the host can share its desktop); `viewer_url` is then deprecated |
| `POST /v1/sessions` | client | Create a session; body `{ "host_id"?, "label"?, "profile"?, "create_profile"?, "allowed_domains"? }`. `profile` defaults to `default`. `allowed_domains` confines the session to those sites ([Allowed sites](#allowed-sites)); an invalid entry is `400`. Without `host_id` the control plane picks the most recently seen host that has a connected browser or launches one on demand. `503 no_host_available` if none |
| `GET /v1/sessions`, `GET /v1/sessions/{id}` | client | List or read sessions |
| `DELETE /v1/sessions/{id}` | client | End a session; queued operations become `cancelled` |
| `POST /v1/sessions/{id}/actions` | client | Run one action. Body `{ "action": {...}, "timeout_ms"? }`. Waits for a terminal state and returns the operation. `?async=true` returns `202` at once |
| `GET /v1/operations/{id}?wait_ms=` | client | Read an operation, optionally waiting for it to finish |
| `GET /v1/artifacts/{id}` | client | Bytes of a screenshot, by the handle in its result |
| `POST /v1/hosts/register` | host | Register; body `{ "name", "version", "host_id"?, "viewer_url"? }`. *Planned* (#336, #338): `mode`, `desktop`, `desktop_protocol` (`rfb` or `kasmvnc`) |
| `GET /v1/hosts/{id}/next?wait_ms=&browser_connected=&on_demand=&profiles=&running=&commands=` | host | Long-poll (max 30 s) for the next operation, or with `commands=true` a host command (`{ "command": {...} }`, sent first); `204` when none |
| `POST /v1/hosts/{id}/operations/{op}/result` | host | Report `{ "ok", "result"?, "error"?, "navigation_blocked"? }`. Only the host the operation was dispatched to may report, once |
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
| `session.navigation_blocked` | The browser blocked a top-level navigation outside the session's [allowed sites](#allowed-sites): `{ session_id, operation_id, host, at }` |
| `operation.queued`, `operation.dispatched`, `operation.succeeded`, `operation.failed`, `operation.timed_out`, `operation.cancelled` | Each action |
| `handoff.created`, `handoff.resolved`, `handoff.cancelled`, `handoff.expired` | Human handoffs |
| `secrets.lookup`, `secrets.release`, `secrets.provider_registered`, `secrets.provider_removed` | A [secrets provider](#secrets-from-a-provider-e37) was asked, a value was released (or refused) and typed, a provider was registered or removed. Never a value or a token |
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

## Allowed sites

A session created with `allowed_domains` may only load top-level pages on those sites (#508). The browser enforces the list itself, so a page cannot leave by redirecting, by script or with `window.open`.

- **Matching.** A listed domain covers itself and its subdomains, case-insensitively: `example.com` allows `www.example.com`, not `badexample.com`. An IP literal is allowed only when it is listed. Write `example.com`, not `*.example.com` (refused). A scheme, path, port or trailing dot is stripped. At most 100 entries. An empty or absent list allows every site.
- **What is blocked.** Every top-level navigation to another host, whoever starts it. Subresources (images, scripts, API calls of an allowed page) are not blocked.
- **How it is reported.**
  - A `navigate` or `new_tab` the agent asks for outside the list fails at once, with an error starting `navigation_blocked:`.
  - A navigation the page starts itself is blocked by the browser and reported with the next action on that browser, in the operation's `navigation_blocked` list: `[{ "host", "at" }]`. Only the host is kept, never the URL. Each one is also a `session.navigation_blocked` event on the [event stream](#event-stream).
- **Desktop actions are refused** in a confined session: desktop input reaches every window on the node, so the sites could not be enforced there.
- **Scope.** The host agent sends the list with every action, and the extension applies it to the whole browser of that profile until the next action brings another list. An action of an unconfined session lifts it. Use a separate profile for confined sessions when a person shares the browser (attended mode).
- **CLI.** `hexactra-fabric session create --allow-domain example.com --allow-domain example.org`.

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

## Remote desktop tunnels

A person can see and use a node's desktop through the console (#338, [nodes.md](nodes.md)). The fabric joins two WebSockets and relays the desktop stream (RFB) between them; the node opens no inbound port.

1. `POST /v1/hosts/{id}/desktop-sessions` (client token, body `{ "actor": { "user_id", "org_id", "display_name" } }`) returns `201 { tunnel_id, host_id, connect_token, expires_at }` and sends the host an `open_desktop` command.
   - `404` unknown host
   - `409 host_offline`, `409 desktop_unavailable` (the host registered no `--desktop-vnc`)
   - `429 too_many_desktops`: at most `HEXACTRA_DESKTOP_MAX_PER_HOST` (2) per host and `HEXACTRA_DESKTOP_MAX` (50) per fabric.
2. The viewer opens `GET /v1/desktop/{tunnel_id}/connect` as a WebSocket with `Authorization: Bearer hxd_…`.
   - The token works once and lasts 30 seconds. Only its hash is stored.
   - The fabric waits up to 20 seconds for the node.
3. The agent dials `GET /v1/hosts/{host_id}/desktop/{tunnel_id}` with its own host credential, after connecting its local desktop server (a Unix socket or a loopback port). If it cannot, the command fails with `desktop_unavailable`, `desktop_busy`, `vnc_unavailable` or `tunnel_failed`.

The relay forwards binary messages (up to 1 MiB each) both ways and pings both legs every 20 seconds.

| Close code | Meaning |
|---|---|
| 1000 | The other leg closed |
| 4504 | The node did not connect in time |
| 4408 | Idle for `HEXACTRA_DESKTOP_IDLE_S` (900 s) |
| 4000 | Open for `HEXACTRA_DESKTOP_MAX_S` (3600 s) |

**Events:**
- `desktop.requested`, with `actor`;
- `desktop.opened`;
- `desktop.closed`, with `reason`, `bytes_up`, `bytes_down` and `duration_ms`.

**Metrics:** `hexactra.desktop.tunnels`, `hexactra.desktop.tunnel_bytes{direction}`, `hexactra.desktop.tunnel_failures{reason}` and `hexactra.desktop.tunnel_duration`.

Tokens appear in no event, log or URL. Tunnels live in the memory of the fabric replica both legs reach, so run one `fabric-control` replica.

**On the console domain:** only the node's leg is published, at `https://<console>/fabric/v1/hosts/<id>/desktop/<tunnel>`. Creating tunnels and the viewer's leg stay on the private network.

### Takeover

A person takes control of a host's desktop and the agent pauses (#342).

**Routes** (client token):
- `POST /v1/hosts/{id}/takeover` with `{ "actor": { "user_id", "display_name"? }, "ttl_s"? }` takes the lease. The default is 300 s and the maximum 600 s.
  - It returns `201 { lease_id, host_id, actor, started_at, expires_at }`.
  - The same person asking again extends their lease.
  - Anyone else gets `409 takeover_held`.
- `POST …/takeover/{lease_id}/renew` and `DELETE …/takeover/{lease_id}` renew and release it.
- `GET /v1/hosts/{id}/takeover` returns the live lease, or `404`.

**While the lease is held:**
- New actions on that host answer `409 takeover_active`, with the time it ends. An action already running finishes.
- The console's goal runner waits and retries the step, for up to 30 minutes. An external agent (MCP) gets "A person is controlling this browser" and retries itself.

**On desktop tunnels:**
- The fabric parses the viewer's RFB stream and drops keyboard, pointer, clipboard, resize and power messages, unless the viewer the tunnel was opened for (`actor.user_id`) holds the lease. Watching is the default.
- A message that is not RFB closes the tunnel with `4400`.

**Events:** `takeover.started`, `takeover.renewed` and `takeover.released`.

## Actions

Actions are JSON objects tagged by `type`. `tab_id` is optional on tab-scoped actions; without it the active tab of the last focused window is used.

| `type` | Fields | Result |
|---|---|---|
| `navigate` | `url` | `{ url, title }` |
| `click` | `selector` | `{}` |
| `type` | `selector`, `text`, `clear`?, `submit`?, `sensitive`? | `{}` |
| `type_secret` | `handoff_id`, `selector`, `clear`?, `submit`? | `{}`. Types the answer of a `secret` handoff; see [secrets](#secrets-typed-by-the-fabric) |
| `secrets_lookup`, `type_from_provider`, `type_code_from_provider`, `select_from_provider`, `type_card_field` | see [secrets from a provider](#secrets-from-a-provider-e37) | Answered by the control plane from the session owner's secrets provider; never a value |
| `press` | `key`, `selector`? | `{}` |
| `scroll` | `dx`?, `dy`?, `selector`? | `{ x, y }` |
| `screenshot` | `marks`?, `mask`? | `{ artifact_id, mime, size, expires_at, width, height, url, title }`: fetch the bytes from `GET /v1/artifacts/{artifact_id}` ([artifacts](#artifacts)). The image is in CSS pixels, the coordinates `click_at` takes. With `"marks": true`, interactive elements are boxed and numbered in the image and listed as `marks: [{ n, selector, tag, role, text, x, y, w, h }]`. With `"mask": true`, sensitive regions are covered before the capture and the result adds `masked` (see [masked screenshots](#masked-screenshots)) |
| `text` | `selector`?, `max_chars`? | `{ text, truncated }` |
| `elements` | `max_elements`? | `{ elements: [{ selector, tag, role, text, ... }] }` |
| `wait_for` | `selector`, `timeout_ms`? (≤ 60000) | `{}` |
| `tabs` | — | `{ tabs: [{ id, url, title, active, last_focused? }] }` |
| `new_tab` | `url`? | `{ tab_id }` |
| `activate_tab`, `close_tab` | `tab_id` | `{}` |
| `back`, `forward`, `reload` | — | `{}` |
| `evaluate` | `script`, `await_promise`? | `{ value, type, description? }`. Runs any JavaScript in the page's main world, whatever its CSP, like the DevTools console: the last expression is the value, and top-level `await` works. A thrown exception fails the operation with its message |
| `click_at` | `x`, `y`, `button`? (`left`, `middle`, `right`), `click_count`? (1–3), `modifiers`? (`alt`, `ctrl`, `meta`, `shift`) | `{}`. A trusted click at viewport CSS pixels |
| `mouse` | `op` (`move`, `down`, `up`), `x`, `y`, `button`? | `{}`. A trusted hover, press or release |
| `drag` | `from_x`, `from_y`, `to_x`, `to_y`, `steps`? (1–100, default 10) | `{}`. A trusted drag with intermediate moves |
| `scroll_at` | `x`, `y`, `dx`?, `dy`? | `{}`. A trusted mouse-wheel scroll at a point |
| `type_keys` | `text`, `expect_origin`? | `{}`. Trusted typing at the focus: key events per character (one insert above 300 characters) |
| `key` | `key`, `modifiers`? | `{}`. One trusted key press: `Enter`, `Escape`, `ArrowDown`, `F5`, or a character with modifiers (`a` + `ctrl`) |
| `desktop_screenshot` | — | Like `screenshot`, for the node's **whole screen** (screen pixels), with `width` and `height` |
| `desktop_click` | `x`, `y`, `button`?, `click_count`? | `{}`. Anywhere on the node's screen |
| `desktop_move` | `x`, `y` | `{}` |
| `desktop_drag` | `from_x`, `from_y`, `to_x`, `to_y` | `{}` |
| `desktop_type` | `text` | `{}`. Into whatever has the desktop focus (a native file dialog, another window) |
| `desktop_key` | `key` | `{}`. xdotool chords: `Return`, `ctrl+l`, `alt+F4`, `ctrl+a BackSpace` |
| `desktop_scroll` | `dy` (−100–100 wheel clicks), `x`? and `y`? (both or neither) | `{}` |

### Full powers (#366)

Hexactra is a human emulator for its owner (VISION §27): an agent may do anything a person at the machine could do.
- **In the page:** the extension executes `evaluate` and the positional actions through `chrome.debugger`. Pages receive trusted events (`isTrusted: true`). No CDP domain is ever `enable`d, and Chrome runs with `--silent-debugger-extension-api`, so there is no debugging bar.
- **On the desktop:** the host agent runs the `desktop_*` actions itself, on its X11 display, with `xdotool` (arguments are passed directly, never through a shell). It captures the screen with ImageMagick `import`, or `xwd` + `convert`. `hexactra agent install` and `update` install both. A node without them fails the action and names the package to install. Desktop actions are serialised per node: one pointer, one keyboard.

Policy enforced before an action is queued:

- `navigate` and `new_tab` open any URL a person could type (`http(s)`, `file:`, `chrome:`, `data:`, `about:`, extension pages). Only `javascript:` is refused: use `evaluate`.
- Selectors are limited to 2,000 characters, typed text to 100,000, scripts to 200,000, and coordinates to 0–100,000.
- Logs record the action `type` only, never URLs, selectors or typed text.
- A `type` action with `"sensitive": true` (CLI: `type --sensitive`) still sends its text to the host, but the operation view reports it as `[secret]`; use it for passwords the caller already holds.

### Masked screenshots

A screenshot kept for a run's trace must not show a password, a one-time code, a card number or an account number in the clear (#539). With `"mask": true` (CLI: `screenshot --mask`), the extension covers them **in the page, before the capture**, so no unmasked image exists on the node, in the fabric or in object storage:

- It adds one fixed-position container (`pointer-events: none`, highest z-index) holding one opaque `#111` box per region (no blur: a blur can be reversed), waits one animation frame, captures, and removes the container in all cases, also when the capture fails.
- Covered: `input[type=password]`; inputs with `autocomplete` `one-time-code`, `cc-number`, `cc-csc`, `cc-exp*`, `current-password` or `new-password`; inputs whose `name`, `id` or `aria-label` matches `otp|passcode|cvv|cvc|ssn|routing|account.?number|card.?number`; any other text field whose value, and any visible text, matching a pattern of `packages/contracts/sensitive-patterns.json` (the table the console masks run traces with: tokens, URL queries, emails, IBANs, card numbers with the Luhn check, SSNs, routing numbers with the ABA check, account numbers, phone numbers, long digit runs). Text is covered character-exact (only the number, not its paragraph); a label in one table cell is context for the number in the next.
- Same-origin frames are masked inside. A cross-origin frame or a plugin (a PDF viewer) that is part of the page is covered by one box.
- Only regions in the viewport are counted. The result's `masked` is the number of boxes; past 500 the whole viewport is covered and `masked` is 500.
- **Not masked:** text inside images, canvases and videos (there is no OCR). A canvas over half the viewport is covered whole; a smaller one is captured as is.
- **Fail closed:** if the page cannot be masked (a page the extension cannot script, such as `chrome://` pages; a cross-origin frame or plugin that fills the viewport; the pattern file missing), the action fails with an error starting `mask_unavailable` and returns no image. It never falls back to an unmasked picture.
- `marks` and `mask` together are allowed: both are drawn and both removed, and the marks' labels are masked as well. Trace captures use `mask` without `marks`; the screenshots the model sees are not masked. `desktop_screenshot` has no page and no `mask`.
- The handoff rule is unchanged: a masked plain screenshot is taken while a handoff waits, except while it asks for a secret.

## Artifacts

Screenshots do not travel inside operation results. The control plane keeps the image and returns a short-lived handle; large data moves by handle, not in control messages.

- **Fetch:** `GET /v1/artifacts/{id}` (client token) returns the bytes with their `Content-Type` and `Cache-Control: no-store`.
- **Lifetime:** handles last 15 minutes. The control plane keeps at most 256 MiB, dropping the oldest first. After that, or after a restart, the handle returns `404`. Artifacts are never written to disk.
- **Migration flag:** send `"inline_artifacts": true` in the action body, or `?inline_artifacts=true`, to also get the base64 `data` as before.
- **CLI and MCP** fetch the bytes by handle, so `hexactra-fabric screenshot -o file.jpg` and `browser_screenshot` work unchanged.

## Operation states

`queued` → `dispatched` → `succeeded` | `failed`, or `timed_out` (no result in time; the error says whether the action may have run) or `cancelled` (the session ended first).

## Human handoff

When an agent meets something only its owner can do (a one-time code sent to them, a passkey, a password it was not given, a CAPTCHA puzzle it cannot pass, or a purchase the task asks to confirm), it opens a **handoff**. The session pauses: actions return `409 handoff_pending` until a person answers or the handoff expires. The one exception is a plain `screenshot` (without `marks`) or a `desktop_screenshot`: it is still taken, so the person can see the page they are asked about, except while the handoff asks for a secret. The same holds while a person has taken over the desktop.

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
- `remember` (`credentials` and `secret` only): `{ "label": "Keep me signed in" }`, the site's option to remember the sign-in or the device, in its own words (1-80 characters). The answer's `remember` (`true` or `false`) is the person's choice and comes back in the response.
- `input` is one of:
  - `none`: the person acts in the browser and clicks "Done".
  - `takeover`: the person operates the browser themselves, then clicks "Done".
  - `text`: a free-text answer. Constraints: `max_length` (1 to 4096, default 4096), `pattern` (a regex of at most 200 characters the whole answer must match), `multiline` (`false` rejects newlines).
  - `secret`: an answer that is withheld from reads and payloads and typed into the page by the control plane, once ([below](#secrets-typed-by-the-fabric)). Constraint: `max_length`.
  - `credentials`: a sign-in in one answer. `value` is the username, returned like `text`; `secret` is the password, held and typed like a `secret` answer and never returned. Constraint: `max_length` (each).
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

**Handoffs and the console's questions.** A handoff is the fabric half of a question: browser-bound, it pauses one session, and it is the only place a secret is typed (`type_secret`). The Hexactra Console adds a question broker on top: free-standing questions with no browser, an owner and audit trail per question, and channels (its Inbox on web, Android, CLI/TUI and MCP; notifications with quick-answer buttons; signed webhooks). The console mirrors each handoff it opens as a question and enforces its channel rules there: a secret is answered only on its signed-in page, a high-risk `confirm` only where the person is signed in, and the first answer wins. See [console/docs/questions.md](../console/docs/questions.md). The fabric itself accepts any valid answer from an API token or the handoff's response token.

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
- `POST /v1/handoffs/{id}/claim` still returns the value once, for operator and service tokens only, with a `Deprecation: true` header. It shares the single use: whichever of claim and `type_secret` comes first gets the value. The Hexactra Console, the SDK and the MCP server no longer call it; it will be removed in a later release.

### Secrets from a provider (E37)

A stored secret (a login's password, a one-time code) can also come from a **secrets provider** the session's owner registered, instead of from a person: the agent names *which* item and field, the control plane fetches the value, types it and wipes it. The model, logs, events, operation results, the state database and screenshots never hold it. Providers (Vault, the console's built-in store) plug into the `SecretsProvider` contract of `crates/hexactra-credential-resolver`.

**Sessions have an owner.** `POST /v1/sessions` takes an optional `owner_id` (the console's user id); `SessionView.owner_id` reports it. The three actions use the providers registered for that owner; a session without an owner, or an owner without a provider, fails with `no_provider`.

**Registering a provider** (client token; the console does this with a freshly minted token and removes it when the owner disconnects):

| Route | |
|---|---|
| `PUT /v1/secrets-providers/{owner_id}/{provider}` | Body `{ "kind": "vault" \| "console" \| "test", "base_url"?, "access_token"?, "expires_at"?, "settings"? }`. Replaces any earlier registration. Answers the registration without its token (`Cache-Control: no-store`). `400` for an invalid registration (a `vault` needs `base_url`, `access_token` and `expires_at`); `501 provider_kind_unsupported` for a kind this build does not implement (`console`, and `test` without the `test-provider` feature) |
| `DELETE /v1/secrets-providers/{owner_id}/{provider}` | Drops the registration and its token. Idempotent, `204` |
| `GET /v1/secrets-providers/{owner_id}` | `{ "providers": [...] }`, never a token |

**The Vault provider** (`kind: "vault"`, E37.2) talks to the owner's Vault over its agent credential API (`/api/agent/v1` under `base_url`, the Vault's `APP_URL`; `https`, or `http` on loopback): `secrets_lookup` is `GET /credentials?origin=` (exact matches first; a site-only match is listed, never fillable), `type_from_provider` is `POST /credentials/{id}/fill` for one field (`username` or `password`) with the page's origin and the purpose, and a card lookup is `GET /cards?origin=` and `type_card_field` is `POST /cards/{id}/fill` for one field with the merchant's top-level origin, the payment frame's origin when there is one, the amount, the currency and the purpose `purchase` (contract 1.1, E37.7), and `type_code_from_provider` is `POST /credentials/{id}/totp` fetched right before typing (a code with fewer than 5 seconds left is dropped and the next period's code is fetched). TLS verification is on, connect 3 s and total 10 s, redirects are never followed, nothing is cached and no body or header is logged. Vault's answers map to failure codes by status and its `code` only, never its `message`: `401` `unauthorized`; `403 AGENT_ACCESS_DISABLED` `disabled`; `403 ORIGIN_MISMATCH` `origin_mismatch` (never retried); a missing scope `refused: insufficient_scope`; `404` `not_found`; `429` `rate_limited` (a `Retry-After` of 5 s or less is waited out once); a network failure, a timeout or a `5xx` `unavailable`. The wire shapes follow Vault's `docs/agent-credential-api.md`, contract 1.2 (beta). The console hands over a short-lived `oat_` access token (never the refresh token) and replaces it before it expires; the control plane drops it at `expires_at`.

The token is Secret Material: kept in the control plane's memory only (never in the state database, never returned, never logged) and gone when `expires_at` passes or the process restarts; the console registers again with a fresh one.

**The actions** (answered by the control plane, not a host):

| `type` | Fields | Result |
|---|---|---|
| `secrets_lookup` | `kind`? (`login`, `identity`, `card`), `provider`?, `run_id`?, `client_label`?, `tab_id`? | `{ origin, provider, items: [{ id, name, username?, origins, match_kind: "exact" \| "site", has_code, updated_at?, fields?: [{ key, label, sensitive, usable_here }], card?: { brand?, last4?, exp_month?, exp_year?, grant?: { max_amount, currency, includes_security_code, expires_at? } } }] }`. `fields` is only for identity items, `card` only for cards (listed only for a merchant the owner granted). Never a value, never a length, never more than the last four digits |
| `type_from_provider` | `item_id`, `field`, `selector` or `point: { x, y }`, `purpose`? (`login`), `clear`?, `submit`?, `provider`?, `run_id`?, `client_label`?, `tab_id`? | `{ typed: true }`. Never the value, never its length |
| `type_code_from_provider` | `item_id`, `selector` or `point`, `clear`?, `submit`?, `provider`?, `run_id`?, `client_label`?, `tab_id`? | `{ typed: true, expires_at }` |
| `type_card_field` | `item_id`, `field` (`number`, `expiry`, `exp_month`, `exp_year`, `holder_name`, `postal_code`, `security_code`), `selector` or `point: { x, y }`, `amount` (decimal, at most two places), `currency` (ISO 4217, upper case), `clear`?, `provider`?, `run_id`?, `client_label`?, `tab_id`? | `{ typed: true, frame_origin? }`. Never the value. See [cards](#cards-e377) |
| `select_from_provider` | `item_id`, `field`, `selector`, `part`? (`day`, `month`, `year`, only for `date_of_birth`), `provider`?, `run_id`?, `client_label`?, `tab_id`? | `{ selected: true }`. Never the value, never which option |

How a value gets typed: the control plane reads the tab's top-level URL from the extension (`tabs`), so the model never names an origin; normalises it to `scheme://host[:port]` (`https`, or `http` on loopback); pins every later step to that tab; asks the provider, which binds the release to that exact origin; reads the origin again; and only then queues a `type` (or, for a `point`, `click_at` and `type_keys`) with `sensitive: true` and `expect_origin` (E37.10), so the existing redaction path hands the real text to the host alone and the extension checks the tab's URL once more at the moment of typing, typing nothing and failing `origin_mismatch` when the tab has moved. For `field: password` the fabric also probes the target before asking the provider: an `input` of type `password`, or a text input the page marks as a password (`autocomplete` `current-password`/`new-password`, or a name, id, `aria-label` or placeholder that says `password`, `passwd` or `pwd`), passes; any other element is `not_a_password_field` and nothing is fetched. A `point` that lands in a frame of another origin is refused (`cross_origin_frame`); a `selector` acts on the top-level document. No screenshot is accepted (`409`) between the release and the end of typing. During a takeover, or while a handoff is pending, the actions are refused like any other (`409 takeover_active`, `409 handoff_pending`).

### Cards (E37.7)

`type_card_field` types one field of a saved card. A card works on any site, so the fabric is stricter than for a login and relies on the owner's **merchant grant** in the provider (Vault, contract 1.1):

* The page's top-level origin must be `https` (`insecure_origin` otherwise); nothing is fetched first.
* The fabric reads the merchant (the tab's top-level origin) itself. The caller never names an origin, and `type_from_provider` refuses the purpose `purchase`.
* A `selector` acts on the top-level document and may not name a frame. A `point` may land inside an embedded frame (a payment processor's iframe): the field is typed with a click and keystrokes at screen coordinates, so no script runs in the frame, and the frame's origin is read from the frame element's source and sent to the provider as the frame origin (the grant lists the frames it accepts) and reported in the result. If the fabric cannot determine the frame's origin (no source, `about:blank`, `data:`, not `https`) it refuses with `frame_unknown` and nothing is fetched. The origin is what the page declares for the frame; a frame that redirects, or a frame inside a frame, is not seen (documented limit: the owner's grant and amount limit are the protection).
* The target (the page's origin and the thing at the target) is read before the provider is asked and again afterwards; a change in between refuses with `origin_mismatch` and nothing is typed.
* `amount` and `currency` are the purchase about to be made; the provider checks them against the grant and records them. `field: expiry` is composed inside the fabric from the two released parts as `MM/YY` and is never returned.
* No screenshot is accepted (`409`) between the release and the end of typing. A card field is never submitted.
* Failure codes added for cards: `amount_exceeded`, `currency_mismatch`, `security_code_not_granted`, `grant_expired`, `limit_reached` (the grant's period limit or the card's daily cap), `cards_disabled`, `frame_unknown`; a wrong merchant or frame is `origin_mismatch`; a card that is missing, not the owner's, not opened or without any grant is `not_found`.
* The audit event adds `amount`, `currency` and `frame_origin` (the merchant is `origin`). The built-in store (`console` provider) holds no cards: a lookup is empty and a release is `refused: unsupported`.

A failed action is `state: "failed"` with `error: "<code>: <message>"`: `no_provider`, `provider_required`, `not_found` (missing, not the owner's, or not opened: one code), `origin_mismatch` (the page is not exactly one of the item's origins, or navigated while the value was fetched), `disabled`, `rate_limited` (`retry in N s`), `unavailable`, `unauthorized` (reconnect), `refused`, `origin_unavailable`, `cross_origin_frame`, `not_a_password_field`, `typing_failed`, `insecure_origin`, `no_option`, `unsupported` and the card codes above, `timed_out`. There is no automatic retry after `origin_mismatch`.

Audit: each lookup emits `secrets.lookup` and each release `secrets.release` on the event stream with `owner_id`, `session_id`, `op_id`, `run_id`, `client_label`, `provider`, `item_id`, `field`, `origin`, `purpose`, `outcome` (`ok`, `typed`, or the failure code) and `released`; registrations emit `secrets.provider_registered` and `secrets.provider_removed`. Never a value. The console stores the stream as its audit trail; the fabric keeps the last 2,000 events. Webhooks carry handoff events only.

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

**Identity details** (E37.6). `secrets_lookup` with `kind: "identity"` lists the owner's opened identity items with, per field, a `key`, a `label` and two flags: `sensitive` (a date of birth, an ID number: released only to a site on that item's allowed list, exact origin) and `usable_here` (a fill on the page the lookup was for would be allowed). For an identity item `match_kind` is `exact` when the page's origin is on that list. Fill a field with `type_from_provider` (`purpose: "form"`), or choose a `<select>` option with `select_from_provider`: the control plane lists the select's options, asks the provider for the value bound to the page's origin, picks the matching option itself (a date of birth split in three selects takes a `part`; a month matches its number, its name or its abbreviation), wipes the value and chooses the option by index, after reading the origin once more. The Vault provider maps this to `GET /identity?origin=` and `POST /identity/{id}/fill` (contract 1.1, scopes `vault:identity_read` and `vault:identity_fill`; a missing scope is `refused: insufficient_scope`, a switched-off identity feature `refused: identity_access_disabled`). The fabric refuses, whatever the provider says, to type a sensitive field (`date_of_birth`, `id_number`, card numbers and security codes) into a page that is not `https`: `insecure_origin`. `select_from_provider` fails with `no_option` when the element is not a `<select>` or none of its options is the value. The index of the chosen option goes to the page in an internal `evaluate` of the control plane; no result, event or log holds the value.
