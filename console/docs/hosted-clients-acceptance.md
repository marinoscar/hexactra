# Hosted clients acceptance: ChatGPT, Claude and Claude Code

This is the manual check of E33.10 ([#468](https://github.com/marinoscar/hexactra/issues/468), epic [#458](https://github.com/marinoscar/hexactra/issues/458)). The console's owner runs it with real accounts; CI cannot sign in to ChatGPT or Claude. What CI does check on every change is the console's side of the same journey, with a scripted client in five profiles (`apps/api/test/mcp-hosted-client.db.spec.ts`) and the real Claude Code and MCP Inspector CLIs with a token (`apps/api/test/agent-clients.db.spec.ts`).

**This checklist has not been executed yet.** A run is recorded as a comment on #468 with the date, each client's version or build, and the result of every line. It runs twice: **pass 1** (connect, delegate, step-up, limits) and **pass 2** (the in-chat cards of E33.9). The recipes it checks are [hosted-clients.md](hosted-clients.md).

**You need:**
- the console on a public HTTPS URL (the VPS stack or a tunnel: [runbooks/public-exposure.md](runbooks/public-exposure.md)), for example `https://hex.example.test`, with **default settings** except: Administration → **OAuth clients** on, hosts `claude.ai` and `chatgpt.com` allowed;
- one home or VPS node online, with a signed-in **demo** browser profile (no personal accounts);
- a **contributor** user for the run (not an administrator), and an administrator account to read the logs;
- accounts on ChatGPT and Claude on a plan that can add a custom connector, the Claude app on a phone (iOS or Android), and Claude Code;
- a demo site with a login that sends a one-time code (a test account on a site you control);
- a stopwatch.

**What to record verbatim** (Administration → **External AI apps** → activity, Administration → **OAuth clients**, and the API log; never a token):

| Fact | Where it shows |
|---|---|
| Registration path (CIMD or DCR) and `client_id` | OAuth clients: the client's kind and id |
| Redirect URI it sent | the consent page's redirect host; the API log line of `/api/oauth/authorize` |
| Scopes it requested, and whether it sent `resource` | the consent page; the `/authorize` log line |
| Protocol version and `clientInfo` | External AI apps → activity (client name), span `mcp.protocol.version` |

Use only placeholder data in anything you paste into #468: a demo console, a demo profile, the `@example.test` contributor. Screenshots for [hosted-clients.md](hosted-clients.md) go under `docs/images/hosted/`, taken from a demo console and a placeholder account.

Tick each line per client, and note anything unexpected.

## Pass 1, for each of ChatGPT, Claude web, Claude mobile, Claude Code

Copy this block four times (one per client) into the #468 comment.

```text
Client: ____________   Version / build: ____________   Date: ____________   Tester: ____________
```

### Connect

- [ ] Connect from scratch by following [hosted-clients.md](hosted-clients.md) in **under two minutes**, with no token typed. Time: ______.
- [ ] The consent page names the client's host (`claude.ai`, `chatgpt.com`, or for Claude Code the loopback address it was sent back to).
- [ ] Recorded verbatim: registration path ______; redirect URI ______; scopes requested ______; `resource` sent (yes/no) ______; protocol version ______; `clientInfo` ______.
- [ ] Where these differ from the epic's client table (#458) or the platform spec's compatibility table (EnterpriseAppBase `docs/specs/oauth-server.md`), the correction is filed: a comment on #458, and an issue or PR on EnterpriseAppBase.
- [ ] Every menu label in the recipe matched the screen; where it did not, `apps/web/src/content/connect-ai-apps.ts` is corrected and `npm run docs:hosted-clients` run.

### Delegate

- [ ] "What can you do with Hexactra?" lists delegate capabilities (goals, runs, tasks, questions) and **no drive tools** (no clicking or typing in a browser itself).
- [ ] "Use Hexactra to find &lt;public information on a public site>": the run starts, the assistant reports progress, shows or describes the screenshot and returns the result; the run appears in the console with **Started by** &lt;the app>.
- [ ] A run that needs a **choice**: the question is answered from the chat; the run continues.
- [ ] A run that needs a **code** (the demo login): the assistant sends you to the console; the code is typed there; the assistant never sees it. Checked in the chat transcript **and** in the activity (no value recorded).
- [ ] "Stop it" stops the run (the console shows it cancelled).

### Step-up and sensitive actions

- [ ] "Open example.test and click …": the step-up consent appears with only the new box; after approval the browser is driven.
- [ ] A sensitive action asks for confirmation **in the console** (E33.7), not in the chat.
- [ ] Whether the client needed anything beyond the HTTP `403` challenge to start the step-up (ChatGPT: the `_meta["mcp/www_authenticate"]` form) is recorded; if it did, a follow-up issue exists.

### Tokens, pause, disconnect

- [ ] Token refresh: leave the chat for **more than an hour**, come back: it still works with no prompt.
- [ ] Pause the app (Settings → AI apps → the app → **Paused**): the assistant gets a clear refusal; switching it back resumes.
- [ ] Disconnect in the console: the next request fails and the client offers to reconnect.

### Limits

- [ ] The largest tool result the client accepted: ______ characters (`browser_text` on a long page, paging with `offset`).
- [ ] The longest tool call the client waited for: ______ s (`run_wait` with `wait_s` 200 on a quiet run).
- [ ] Both recorded in [mcp.md, Client differences we handle](mcp.md#client-differences-we-handle). If a client is stricter than the constants in `apps/api/src/mcp/mcp.results.ts` (100,000 characters, 200 s waits, a 220 s deadline), the constants are changed in a PR with this evidence.

### Mobile only (Claude mobile)

- [ ] The consent page is usable one-handed on the phone; screenshots at the device's width.

## Pass 2: the cards (after E33.9), for each of ChatGPT, Claude web, Claude mobile, Claude Code

- [ ] The **run card** renders, updates while the run works, and **Stop** stops the run.
- [ ] The **question card** answers a choice in place.
- [ ] A **secret** shows the "enter it in Hexactra" state with a link to the Inbox; no field for the value.
- [ ] On a client without MCP Apps (Claude Code), the same run gives the **text** flow.
- [ ] Mobile: the cards are usable one-handed; screenshots at the device's width.

## Result

Post the ticked checklists, per client and pass, with the client versions, the dates and the recorded facts, as a comment on #468. The epic is not done while a line of the delegate flow fails on ChatGPT or Claude web. Each failed line becomes a fix in the same PR (docs, constants, a small compatibility shim with a row in [mcp.md](mcp.md#client-differences-we-handle) and a test), a linked console issue, or a seam request on EnterpriseAppBase.
