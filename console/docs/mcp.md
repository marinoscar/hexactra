# The console as an MCP server

Any MCP client (an agent framework, an IDE assistant, a script) can use Hexactra through the console. It can hand Hexactra a goal, or drive a browser itself. Every call goes through the console's REST API **as the authenticated user**, so the same permissions, policies, redaction and run recording apply. The user sees each run in the console, can stop it, and answers its requests in the Inbox.

## Connect

| Transport | Endpoint | Credential |
|---|---|---|
| Streamable HTTP (stateless, JSON responses) | `POST https://<console>/api/mcp` | `Authorization: Bearer pat_…` (a personal access token: Settings → Access tokens, or `hexactra login`) |
| stdio | `hexactra mcp serve` | The CLI's login (`hexactra login`, or `HEXACTRA_SERVER_URL` + `HEXACTRA_TOKEN`) |

Example (Claude Code):

```bash
claude mcp add --transport http hexactra https://<console>/api/mcp --header "Authorization: Bearer $HEXACTRA_TOKEN"
# or, through the CLI's login:
claude mcp add hexactra -- hexactra mcp serve
```

Hermes Agent, OpenClaw and Pi: ready-made, CI-tested recipes in [agent-frameworks.md](agent-frameworks.md).

**Give each framework its own user.** Personal access tokens carry every permission of their user (there are no per-token scopes yet), so:
1. Create a user for the framework (for example `agent-hermes@…`) with the **contributor** role.
2. Mint its token while signed in as that user.
3. Revoke the token, or remove the user, to cut the framework off. Its runs stay visible to admins.

## Tools

| Group | Tools |
|---|---|
| Delegate to Hexactra's agent | `run_goal`, `run_status`, `runs_list`, `run_cancel`, `tasks_list`, `task_create`, `task_update`, `task_run`, `schedule_create`, `schedules_list` |
| Agent policies (budgets and model tiers) | `policies_list`, `policy_get`, `policies_export` (read); `policy_create`, `policy_update`, `policy_set_default`, `policies_import` (write) |
| Ask the user a question | `ask_human` (no browser: text, choice, multi_choice, number, confirm, none, takeover; `wait_s` ≤ 300 waits for the answer), `question_status` |
| Relay a person's answers | `inbox_list`, `inbox_answer` (by `question_id` or `run_id`): only answers the user actually gave |
| Drive a browser yourself | `browser_open`, then `browser_navigate`, `browser_elements`, `browser_text`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_wait_for`, `browser_back`, `browser_tabs`, `browser_screenshot` (an image, with numbered marks by default); full powers (VISION §27): `browser_evaluate` (JavaScript), `browser_click_at`, `browser_hover_at`, `browser_drag`, `browser_scroll_at`, `browser_type_keys`, `browser_key` (trusted input by position), `browser_desktop_screenshot`, `browser_desktop_click`, `browser_desktop_type`, `browser_desktop_key`, `browser_desktop_scroll`, `browser_desktop_drag` (the node's OS desktop); `browser_request_human`, `browser_handoff_status`, `browser_type_secret`, `browser_close` |
| Fleet | `hosts_list` (each host's mode, unattended or attended, is *Planned* in #336). Viewing and controlling a node's desktop is for people only, so there is no viewer tool ([nodes.md](../../docs/nodes.md)). |

**Rules the server gives every client (`instructions`):**
- You act with the user's full authority, like a person at their computer: look at the page, act by selector or by position, run JavaScript, and use the desktop.
- Ask the person (`browser_request_human`) only for what only they have: a code sent to them, a passkey, a password you were not given, a CAPTCHA puzzle you cannot pass. Never guess codes.
- Type codes with `browser_type_secret`, so the agent never sees them.
- Close sessions when done.

Sessions are limited to `allowed_domains` when the client sets them.

## Agent policies

A policy is what a delegated run may spend and which models it uses: budgets (actions, model calls, active minutes, tokens, cost), the model **tiers** (`fast`, `standard`, `frontier`: the tier a run starts on and the highest it may escalate to when it stalls), stall detection and context settings. Four built-ins always exist (`builtin:economy`, `builtin:balanced`, `builtin:thorough`, `builtin:unlimited`); the user may add their own. The full model is in [../README.md](../README.md#agent-policies).

- **Choose a policy per call.** `run_goal`, `task_create`, `task_update`, `task_run` and `schedule_create` take an optional `policy_id` (a UUID from `policies_list`, or `builtin:<key>`). Without it a run uses the schedule's, then the task's, then the user's default policy (`policy_set_default` changes the default; `null` goes back to `builtin:balanced`).
  - `task_run { task_id, policy_id }` runs the task under another policy for that run only.
  - `task_update { policy_id: null }` makes the task follow the default again.
  - A policy is snapshotted when the run starts: editing it later never changes a run in flight.
- **`null` means unlimited.** In a policy's `budget`, a limit of `null` is unlimited (`hasNoHardStop` in `policies_list` is true when every limit is `null`). Stall detection stays on either way.
- **Pick models through tiers, not model ids.** Set `models.startTier` and `models.maxTier`; the deployment and the user decide which model serves each tier. `models.pins` (a model id per tier) is an advanced override that the console checks against the enabled models.
- **Read runs.** `run_status` and `runs_list` return the run as the REST API does: `policy` (id, name, version, source), `tier` (start, max, current, escalations, model) with `currentTier` and `escalations`, `budget` (the effective limits, what the run used and the percent of each; `null` is unlimited), `stopReason` (`finished`, `budget_*`, `stalled`, `cancelled`, `error` or `no_model`), `costUsd`, `costKnown` (false: the cost is a lower bound) and `modelCalls`. The tools add nothing of their own.
- **Budgets are not the only guard.** Stall detection is always on, and `run_cancel` stops any run, including one under an unlimited policy.
- **Edit safely.** `policy_update` replaces the whole `spec`, so start from `policy_get`. Pass `version` (from `policy_get`) to refuse the edit if someone else changed the policy meanwhile (`412 POLICY_VERSION_CONFLICT`). Built-ins are read-only: create a copy (`policy_create` with their spec).
- **Move policies between consoles.** `policies_export { ids?, include_pins? }` returns the portable `hexactra.agent-policies` JSON file (the built-ins and the user's own by default; no ids, users or secrets; `include_pins: false` strips model pins). Pass that JSON as `file` to `policies_import { file, on_conflict }` on another console (`rename` by default, `skip` or `replace`). It returns what was created, replaced and skipped, and warnings (a dropped pin, a budget above the deployment's ceiling).
- **Permissions** are the user's: reads need `agent_policies:read`, writes `agent_policies:write` (a viewer can read policies and is refused the write tools with `403`). Deleting a policy is not offered to agents; use the web app.

Example (`run_goal` under the thorough built-in):

```json
{ "name": "run_goal", "arguments": { "goal": "Find the cheapest fare to Lisbon", "policy_id": "builtin:thorough" } }
```

## Asking the user

Questions are typed: the person answers on the web app, the Android app, the CLI or TUI, a notification button or a webhook, and the answer comes back typed. Types, channel rules and webhooks: [questions.md](questions.md).

- **No browser involved:** `ask_human`. Example arguments:
  ```json
  { "input": "choice", "prompt": "Which plan should I renew?",
    "options": [{ "id": "basic", "label": "Basic" }, { "id": "team", "label": "Team", "description": "5 seats" }],
    "wait_s": 120, "agent_name": "renewal-bot" }
  ```
  It returns `{ "question_id", "status", "input", "expires_at" }`, plus `outcome` and `value` (an option id, text, a number or `approve`/`deny`) or `values` (multi_choice) once answered. While it is `pending`, keep waiting with `question_status { question_id, wait_s }`.
- **Constraints** go in `constraints`: `max_length`, `pattern`, `multiline` (text); `min`, `max`, `step`, `unit` (number); `min_selections`, `max_selections` (multi_choice). A confirm takes `confirm_label`, `deny_label` and `risk` (`high` by default: only signed-in channels may answer it; `low` also allows notification buttons and webhooks).
- **In a browser session:** `browser_request_human` takes the same fields plus `input: "secret"` for a code or password, and pauses the session until it is answered; follow it with `browser_handoff_status`. A secret is never returned (`secretAvailable: true`): `browser_type_secret { session_id, handoff_id, selector, clear?, submit? }` has the fabric type it into the page with its `type_secret` action. Neither the agent nor the console ever holds it, and it can be typed once.
- **`inbox_answer`** relays an answer the user gave you in your own conversation: `{ question_id, outcome: "completed", value }` (or `values`; `outcome: "cancelled"` declines). The first answer wins, from whichever channel.
- **MCP elicitation is not supported.** The console's MCP transport is stateless (one JSON response per request), so the server cannot ask your client's user mid-call. Ask with `ask_human` instead.
