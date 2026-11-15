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
| Delegate to Hexactra's agent | `run_goal`, `run_status`, `runs_list`, `run_cancel`, `tasks_list`, `task_create`, `task_run`, `schedule_create`, `schedules_list` |
| Ask the user a question | `ask_human` (no browser: text, choice, multi_choice, number, confirm, none, takeover; `wait_s` ≤ 300 waits for the answer), `question_status` |
| Relay a person's answers | `inbox_list`, `inbox_answer` (by `question_id` or `run_id`): only answers the user actually gave |
| Drive a browser yourself | `browser_open`, then `browser_navigate`, `browser_elements`, `browser_text`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_wait_for`, `browser_back`, `browser_tabs`, `browser_screenshot` (an image), `browser_request_human`, `browser_handoff_status`, `browser_type_secret`, `browser_close` |
| Fleet | `hosts_list` |

**Rules the server gives every client (`instructions`):**
- Never bypass a CAPTCHA or bot check, and never guess codes: ask the person (`browser_request_human`).
- Type codes with `browser_type_secret`, so the agent never sees them.
- Ask before purchases and other irreversible steps.
- Close sessions when done.

Sessions are limited to `allowed_domains` when the client sets them.

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
