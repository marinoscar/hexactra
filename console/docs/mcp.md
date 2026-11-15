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
| Relay a person's answers | `inbox_list`, `inbox_answer`: only answers the user actually gave |
| Drive a browser yourself | `browser_open`, then `browser_navigate`, `browser_elements`, `browser_text`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_wait_for`, `browser_back`, `browser_tabs`, `browser_screenshot` (an image), `browser_request_human`, `browser_handoff_status`, `browser_type_secret`, `browser_close` |
| Fleet | `hosts_list` |

**Rules the server gives every client (`instructions`):**
- Never bypass a CAPTCHA or bot check, and never guess codes: ask the person (`browser_request_human`).
- Type codes with `browser_type_secret`, so the agent never sees them.
- Ask before purchases and other irreversible steps.
- Close sessions when done.

Sessions are limited to `allowed_domains` when the client sets them.
