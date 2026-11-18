# Agent frameworks: Hermes Agent, OpenClaw, Pi

Recipes for connecting three agent frameworks to the console's MCP server ([mcp.md](mcp.md)). Each recipe is a file in [recipes/](recipes/). CI hands each file, unchanged, to that framework's own CLI, which connects to a live console and lists its tools (`apps/api/test/agent-clients.db.spec.ts`).

Before you start, for each framework:
1. Create a console user for it, with the **contributor** role (see [mcp.md](mcp.md#connect)).
2. Sign in as that user and mint a personal access token.
3. Export the token as `HEXACTRA_TOKEN` and your console's base URL (no trailing slash) as `HEXACTRA_CONSOLE_URL`.

| Framework | Version checked | Recipe | Goes into | Check it with | Tool names the model sees |
|---|---|---|---|---|---|
| Hermes Agent | 0.19.0 | [hermes.config.yaml](recipes/hermes.config.yaml) | `~/.hermes/config.yaml`, under `mcp_servers` (put both variables in `~/.hermes/.env`) | `hermes mcp test hexactra`, then `/reload-mcp` in a running chat | `mcp_hexactra_run_goal`, … |
| OpenClaw | 2026.11.3 | [openclaw.json](recipes/openclaw.json) | `~/.openclaw/openclaw.json`, under `mcp.servers` (stop the Gateway first, or use the Control UI) | `openclaw mcp probe hexactra` | `hexactra__run_goal`, … |
| Pi | 1.5.2 | [pi.mcp.json](recipes/pi.mcp.json) | `~/.pi/agent/mcp.json`, under `mcpServers` | `pi mcp list`, then `/reload` in a running session | `mcp__hexactra__run_goal`, … |

What differs between them:
- **Hermes and OpenClaw** expand `${VAR}` in both the URL and the headers, so their recipes need no edit.
- **Pi** expands `${VAR}` in headers but not in the URL. Replace `https://console.example.test` in `pi.mcp.json` with your console's address.
- **Timeouts.** All three recipes allow 300 s per call. `run_goal` and `task_run` return at once, but a `browser_*` action waits for the page.
- **Approvals.** Every tool announces all four MCP hints explicitly, plus a `title` (console 1.34.0, #462): `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`. Read tools (`run_status`, `runs_list`, `inbox_list`, `hosts_list`, `browser_text`, `browser_screenshot`, …) are `readOnlyHint: true`. Tools that can lose or irreversibly change something (`run_cancel`, `task_update`, `policy_update`, every click, key press, typing, `browser_evaluate` and desktop input) are `destructiveHint: true`; navigation, scrolling, opening a session, starting a run and asking a question are neither. OpenClaw reads these hints when it decides which calls need your approval, so read tools can run without asking and destructive ones always ask. The full table is in [mcp.md](mcp.md#tools).

## Which tools to give the agent

- **Delegate (recommended).** Give the agent `run_goal`, `run_status`, `run_wait`, `inbox_list`, `inbox_answer` and `run_cancel` (and `ask_human`, `question_status` to let it ask you questions, `policies_list` to let it choose a policy). Hexactra's own goal runner then drives the browser and asks you for CAPTCHAs and codes. The framework only follows progress, with `run_wait` (one call that returns when something happens; see [mcp.md](mcp.md#following-a-run-from-a-chat)). Filters:
  - Hermes: `tools: { include: [run_goal, run_status, run_wait, inbox_list, inbox_answer, run_cancel] }`.
  - OpenClaw: `toolFilter: { include: [...] }`.
  - Pi: `"exposure": "hidden"` with `"toolExposure": { "run_*": "direct", "inbox_*": "direct", "ask_human": "direct", "question_status": "direct", "policies_list": "direct" }` (the last one only if the agent should choose a policy).
- **Drive.** Expose the `browser_*` tools too, and the framework's model controls the browser step by step. Each action is still recorded as a run that you can watch and stop in the console.

Whichever mode you choose, the agent never sees a code or password you type into a handoff: `browser_type_secret` has the fabric type it into the page.

## Choosing an agent policy

Delegated runs follow an **agent policy** (budgets and model tiers; [mcp.md](mcp.md#agent-policies)). The policy write tools (`policy_create`, `policy_update`, `policy_set_default`, `policies_import`) change what every run may spend, so leave them out of the filters above unless the agent should manage policies. Add `policies_list` to the tool filters above to let the agent see them, and pass `policy_id` to `run_goal`, `task_run`, `task_create`, `task_update` or `schedule_create`. Without it the user's default policy applies. `policy_id` is a UUID from `policies_list` or `builtin:economy|balanced|thorough|unlimited`; budgets set to `null` are unlimited, and models are chosen by tier, not by model id. The same arguments work in all three frameworks; only the tool name's prefix differs:

| Framework | Call |
|---|---|
| Hermes Agent | `mcp_hexactra_run_goal { "goal": "Find a fare to Lisbon", "policy_id": "builtin:economy" }` |
| OpenClaw | `hexactra__run_goal { "goal": "Find a fare to Lisbon", "policy_id": "builtin:economy" }` |
| Pi | `mcp__hexactra__run_goal { "goal": "Find a fare to Lisbon", "policy_id": "builtin:economy" }` |

For example, to run a saved task once under a bigger budget (`task_run`):

```json
{ "name": "task_run", "arguments": { "task_id": "<task id>", "policy_id": "builtin:thorough" } }
```

## Asking you a question

Any of the three frameworks can stop and ask you something with `ask_human` (add it, and `question_status`, to the tool filters above). You answer in the console, the Android app, the CLI, a notification button or your own webhook receiver ([questions.md](questions.md)). For example, the model calls:

```json
{
  "name": "ask_human",
  "arguments": {
    "input": "choice",
    "prompt": "Two flights match. Which one should I book?",
    "options": [
      { "id": "am", "label": "07:40, direct", "description": "Arrives 09:55" },
      { "id": "pm", "label": "16:15, one stop", "description": "Arrives 21:30" }
    ],
    "wait_s": 300,
    "agent_name": "travel-agent"
  }
}
```

and gets back, once you pick the second option on your phone:

```json
{ "question_id": "…", "status": "answered", "input": "choice", "outcome": "completed", "value": "pm", "channel": "notification" }
```

A two-option choice like this one is answered from the notification itself. If `wait_s` runs out first, the result is `"status": "pending"`: call `question_status` with the `question_id` to keep waiting. The tool names carry each framework's prefix (`mcp_hexactra_ask_human`, `hexactra__ask_human`, `mcp__hexactra__ask_human`).

## Troubleshooting

| Symptom | Cause |
|---|---|
| 401, or "authentication refused" | The token is expired or revoked, or `HEXACTRA_TOKEN` is not set in the framework's environment. |
| `403 …` in a tool result | The framework's user lacks the permission. A viewer can list, but cannot create tasks or open browsers. |
| Hermes: "not an MCP endpoint" | The URL misses the `/api/mcp` suffix, or points at the web app. |
| Pi: "url must be an http or https URL" | `${HEXACTRA_CONSOLE_URL}` was left in `pi.mcp.json`. Pi does not expand it there. |
