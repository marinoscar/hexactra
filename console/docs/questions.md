# Questions: asking a person

An agent asks its user a typed question and waits for a typed answer. The person answers wherever they are: the web app, the Android app, the CLI or TUI, a notification button, or a webhook receiver they run. This page is the reference for the console's question broker (epic #285). The fabric side (handoffs, `type_secret`) is in [../../docs/remote-control-api.md](../../docs/remote-control-api.md).

## Two kinds of question

| | Free-standing question | Browser-bound question |
|---|---|---|
| Asked with | `POST /api/questions`, `hexactra questions ask`, MCP `ask_human` | `POST /api/browser/sessions/:runId/handoffs`, MCP `browser_request_human`, the goal runner's `request_human` |
| Lives in | The console only (`questions` table) | A fabric handoff on the browser session, mirrored as a console question |
| Pauses a browser | No | Yes: the session's actions wait until it is answered (a plain screenshot is still taken, except while a secret is asked for) |
| `secret` | Refused (`SECRET_NEEDS_BROWSER`) | Allowed: the fabric holds the answer and types it with `type_secret` |

Every question has an **owner** (the user it is asked of), an **asker** (`user:<id>`, `agent:<name>` or `run:<id>`) and an expiry (10 s to 24 h; 1 h by default). Only the owner sees or answers it: another user's question is a 404. Each step is recorded: asked, answered (with the channel and `by`), cancelled or expired.

## Question types

| `input` | The person gives | Constraints | Response |
|---|---|---|---|
| `none` | Nothing: they do something, then press Done | | `outcome` |
| `takeover` | Nothing: they take over the browser, then press Done | | `outcome` |
| `text` | A line or paragraph of text | `maxLength` (≤ 4096), `pattern` (whole-answer regex), `multiline` | `value` |
| `secret` | A code or password (browser-bound only) | | `valueWithheld: true`, never the value |
| `credentials` | A sign-in: a username (`value`) and a password (`secret`), in one answer (browser-bound only, #527) | | `value`: the username; `valueWithheld: true`, never the password |
| `choice` | One option | 1-10 `options`, each a label or `{ id, label, description? }` | `value`: the option id |
| `multi_choice` | Several options | `options`, `minSelections`, `maxSelections` | `values`: option ids |
| `number` | A number | `min`, `max`, `step`, `unit` | `value`: a canonical decimal string (`"7.5"`) |
| `confirm` | Approve or deny | `confirmLabel`, `denyLabel`, `risk` (`low` or `high`, default `high`) | `value`: `approve` or `deny` |
| `memory` | Save or decline a memory the agent proposes (#553); **created by the server only** | `proposal: { kind, label, aliases, attributes, supersedes }` | `memoryId` of the saved memory |
| `save_login` | Save, decline or "never for this site" for the sign-in the owner just typed by hand (E37.4b); **created by the server only** | `proposal` (stored): site, origin, domain, suggested name, username, the fabric's handoff id | `savedAs` (the name), or `neverForSite`; **never the password** |
| `form` | The missing parameter values of a task run, all at once, before it starts (#552, #556); **created by the server only** | `fields: [{ key, label, type, required, options?, help?, constraints? }]`, at most 20 | `fields`: the values by key, masked |

`kind` says why it is asked (`captcha`, `code`, `passkey`, `login`, `confirmation`, `verification`, `other`). `verification` is the owner's own bank wanting them to confirm a payment (a banking-app approval, 3-D Secure): the agent does not try to pass it and waits (E37.7). Declining is `outcome: "cancelled"` for any type.

A response is `{ outcome, value?, values?, valueWithheld, channel?, by?, answeredAt }`. `by` is the signed-in answerer (`user:<id>`); a webhook answer is recorded as its owner on channel `webhook`. **The first answer wins**: a later one is a 409, whichever channel it comes from.

### Memory proposals (#553)

A question of input and kind `memory` is a memory the agent proposes ([memories.md](memories.md#how-the-agent-proposes-one-553)). No question spec can ask one: `POST /api/questions`, `request_human` and an external agent's handoff refuse `memory`. It carries `blocking: false` (no run waits on it: a run's end does not cancel it, the chat's request card and the run's waiting state ignore it), `proposal` (the proposed memory) and `conversationId` (the chat it came from). Its `prompt` is always "The agent suggests remembering something.", so a notification or a webhook carries no value. It expires after 7 days.

The answer is `{ "outcome": "completed", "memory": { "label", "aliases"?, "attributes", "kind"? } }` (Save, with what the owner edited; without `memory` the proposal is saved as proposed) or `outcome: "cancelled"` (Not now). Only this answer writes the memory, through the memories service: a `422 MEMORY_HOLDS_SECRET` or a `409 MEMORY_LABEL_TAKEN` leaves the question pending. **Channels:** saved or declined only on `web`, `android_app` and `inbox`; every other channel, declining included, is `403 CHANNEL_NOT_ALLOWED`. Through the MCP endpoint a proposal is not listed and reads as `404`, and an answer claiming a console channel is recorded as `mcp` (refused).

### "Save this login?" (E37.4b)

A question of input `save_login` is the sign-in the owner typed by hand through a `credentials` card, offered to their secrets provider ([secrets.md](secrets.md#saving-a-login-the-owner-typed-by-hand-e374b)). Like a memory proposal it is created by the server only (`SERVER_QUESTION_INPUTS`; `POST /api/questions`, `request_human` and an external agent refuse it) and is **non-blocking**: `blocking: false`, `kind: "login"`, `runId` and `conversationId` of the run and chat it came from. Its `prompt` is always "The agent offers to save the sign-in you just typed.", so a notification or a webhook names no site, name or username. The question's `saveLogin` is what the card shows, `{ site, domain, name, username, valueExpiresAt }`; the fabric's handoff id and the provider stay on the server, and **there is no password anywhere on it**. It **expires when the fabric stops holding the password** (`valueExpiresAt`, ten minutes after the owner typed it), not after days: after that it is `expired` and the card says "Too late to save this time; it will be offered at the next sign-in."

The answer is one of:

| Button | Request body | Result |
|---|---|---|
| **Save** | `{ "outcome": "completed", "saveLogin": { "name": "Example Bank sign-in" } }` | The fabric sends the password it holds to the provider; `status: answered`, `response.savedAs` |
| **Not now** | `{ "outcome": "cancelled" }` | `status: cancelled`; nothing is remembered |
| **Never for this site** | `{ "outcome": "cancelled", "neverForSite": true }` | `status: cancelled`, `response.neverForSite`; the registrable domain is added to the user setting `secrets.neverSaveLoginSites` |

A save that did not happen leaves the question **pending** (so the owner can pick another name or reconnect and press Save again) and answers `409 SAVE_NAME_TAKEN`, `409 SAVE_RECONNECT`, `409 SAVE_DISABLED`, `503 SAVE_UNAVAILABLE` or `422 SAVE_REFUSED`, with the card's words in `message`; a password the fabric no longer holds is `409 SAVE_TOO_LATE` and the question becomes `expired`. **Channels:** saved or declined, "never" included, **only** on `web`, `android_app` and `inbox`: a hosted AI app (`mcp-oauth`, `mcp-elicitation`, `mcp-app`), an MCP client with a token (`mcp`), a webhook, a notification action, the CLI, the TUI and the REST API under any other name get `403 CHANNEL_NOT_ALLOWED` (`SAVE_LOGIN_ANSWER_CHANNELS`, `channel-rules.ts`), for a decline too. No webhook token and no notification button is made for it, and through the MCP endpoint it is not listed and reads as `404`.

### The confirmation gate (#550)

With "Ask me before purchases" on, the runner stops a click only when **the element clicked** commits something: a button, submit input, link or menu item whose whole label is a commitment ("Pay", "Pay $10.00", "Send money", "Place your order", "Confirm transfer", "Delete account", "Cancel subscription"), or a submit button whose form posts to a commit path (`/payment/submit`, `/checkout/place-order`). The table is `classifyTarget` in `apps/api/src/runner/policy.ts`, with five categories: `payment`, `purchase`, `send`, `delete`, `submit`.

- **Decided by the target, never by the model's words.** The model's `reason` and the selector string are not inputs. The runner reads the element through the fabric (one `evaluate` for `click` and `click_mark`, `elementFromPoint` for `click_at`); these reads are not actions: no step, no budget, no stall count. When the page cannot be asked (a failure, a cross-origin frame), the old word list is matched on the element's label only.
- **Never risky:** a date cell, an option, a checkbox, a radio, a text field, a tab, an accordion, plain text, and a link or menu item that names a feature ("Send money with Zelle®", "Payment activity"). "Continue", "Next", "Review" and "Cancel" are not commitments. A desktop click (`desktop_click`) has no page element and is never gated.
- **The step and the question say why.** A paused click's step stores `{ category, label }` in its args and its summary names them. The confirmation the agent then asks carries `gate: { host, category, label }`, set by the server only: the host is the active tab's, as the browser reports it. A `gate` sent by the model or an API caller is dropped.
- **An approval covers that target only.** Approving the question lets the click on the same category and label on the same host through, once. A different commitment asks again; so does a confirmation the agent asked on its own, before the gate named a target.

### A few details to start: the `form` (#552, #556)

A task whose goal holds `{{Name}}` parameters ([api-tasks-runs.md](api-tasks-runs.md#tasks-with-parameters)) and is started without every required value (no input, no default, no memory) creates its run `waiting_human` with one question of input `form`: one field per missing value, typed (`text`, `number`, `money`, `date`, `choice`, `phone`, `email`), in order. No question spec can ask one (`SERVER_QUESTION_INPUTS` in `questions.contract.ts`). It has no fabric handoff: no browser session and no model call exist until it is answered (`apps/api/src/questions/task-run-starter.ts`).

- **The answer** is `{ "outcome": "completed", "fields": { "amount": "25" } }`. Every field is checked with the parameter rules; a bad one is `400 INVALID_INPUT` with `details.issues` per key, and the run keeps waiting. A good one fills the goal, moves the run to `queued` and starts it. The stored response keeps the values masked (#538); the card settles as "Provided".
- **Declined or expired** (it lives 24 hours): the run ends `cancelled`, "The values were not provided."
- **A sensitive parameter is never a field.** It is asked as a `secret` request right after the browser opens, in the signed-in console only, and typed by the fabric.
- **Channels.** A form has only public fields, so it is answered in the web and Android app, the Inbox, and relayed by a hosted AI app with `inbox_answer` (`fields`). A form holding a sensitive field would need a signed-in channel (`needsSignedIn` in `packages/shared/question-rules.js`); the starter never builds one. The MCP Apps card does not fill a form in place: it sends the person to Hexactra. Notifications and webhooks carry a link, never a value.

### "Don't ask again" (#555)

A confirmation may carry `rememberable: { kind, host, category, matchKey, summary, scopes }`: what a saved approval made from it would match. The runner sets it (a gate question from the gate's verdict; an ask from the `topic` the agent gave `request_human`, from a fixed list, and the page the browser reports); like `gate`, a request body cannot. The answer may then carry `rememberRule: { enabled: true, scope?: 'everywhere' | 'this_task' | 'this_chat', maxAmount?, expiresInDays? }`, accepted only with an approval, only on a rememberable question and only from the signed-in web or Android app (channel `web` or `android_app`, and the console's own session); from anywhere else it is `422` and the question stays answerable once. The rule is made in the same transaction as the answer, and `response.ruleId` names it. Inbox items carry `rememberable` too. Details: [approvals.md](approvals.md#dont-ask-again-on-a-request-555).

### "Remember me" (#527)

A `credentials` or `secret` question may carry `rememberLabel`: the words of the site's own option to remember the sign-in or the device ("Keep me signed in", "Trust this device"), at most 80 characters. The form shows it as a checkbox, **ticked by default**, and the answer's `remember` records the choice. The agent then ticks or unticks that box on the page before it submits. With no answer for it, the box is left as the page had it. The site does the remembering, in the run's browser profile; Hexactra stores no password.

## Channels

A question is delivered on every registered channel and withdrawn from all of them once it is settled. The channel rules decide where an answer may come back:

| Answer | Inbox (web, Android app, CLI/TUI, MCP `inbox_answer` with a personal access token) | Notification buttons | Webhook (`answer-by-token`) | MCP relay by an app signed in with OAuth (`mcp-oauth`) | MCP elicitation (`mcp-elicitation`) | MCP Apps question card (`mcp-app`) |
|---|---|---|---|---|---|---|
| `choice`, `multi_choice`, `text`, `number` | Yes | A two-option `choice` gets one button per option; the rest open the question | Yes | Yes | Yes (a form in the AI app) | Yes (the card's form) |
| `confirm`, `risk: low` | Yes | Approve and Deny buttons | Yes | Yes | Yes (a yes/no field) | Yes (two buttons) |
| `confirm`, `risk: high` | Yes (signed in) | Opens the question | No: the payload carries no token | No: the inbox link | Never asked | No: the inbox link |
| `secret`, `credentials` | Yes, on the question's protected page | A link only | A link only (a sign-in's webhook carries neither the username nor the password) | No: the inbox link | Never asked (no URL mode either) | No: the inbox link |
| `none`, `takeover` | Yes | Opens the question | No | No: the inbox link | Never asked | `none`: Done; `takeover`: a link to the viewer |

The rule table is code: `CHANNEL_RULES` in `apps/api/src/questions/channels/channel-rules.ts`, by channel id (`mcp-oauth.claude` is the `mcp-oauth` channel from a Claude client). `QuestionsService` refuses, with `403`, a secret or the approval of a high-risk confirm from a channel that is not signed in (`notification`, `webhook`, `mcp-oauth`, `mcp-elicitation`, `mcp-app`); declining is allowed from anywhere. The web, Android, CLI, TUI, inbox, REST and `mcp` (a personal access token) channels are signed in.

- **Public answers** (choice, multi_choice, text, number, low-risk confirm) can be collected on any channel.
- **Secrets are link-only.** No notification, webhook or chat message ever carries a secret or a way to type one.
- **High-risk confirmations** are answered only where the console signs the person in.
- Chat apps (Slack, Teams, Telegram) are post-v1 (#293); they will be added as channels, under the same rules.
- **AI apps (#463).** An app signed in with OAuth relays what the user typed in the chat (`inbox_answer`, channel `mcp-oauth.<client>`), and on MCP `2026-07-28` the console may ask a run's question in the app's own form (elicitation, channel `mcp-elicitation.<client>`). Neither is a Hexactra sign-in, so both carry public answers only. Details: [mcp.md](mcp.md#following-a-run-from-a-chat).
- **The MCP Apps question card (#467).** In an AI app that renders MCP Apps, the question card (and the run card's "Needs you" banner) shows the typed form and records the click with `question_card_answer` under channel `mcp-app.<client>`. The person answered first-hand, but the card is drawn by the AI app and its calls carry the app's credential, so it is not a sign-in either: public answers and acknowledgements only. The tool also refuses a takeover (it is done in the browser). Details: [mcp-apps.md](mcp-apps.md#what-can-and-cannot-be-answered-in-a-chat).
- **A memory proposal and "Save this login?"** are answered only on `web`, `android_app` and `inbox` (`MEMORY_ANSWER_CHANNELS`, `SAVE_LOGIN_ANSWER_CHANNELS`): saving writes to the owner's own data or vault, so no hosted app, webhook, notification action, MCP client, CLI or other REST caller may do it, and declining is refused there too.
- **"Don't ask again" (#555)** is ticked only in the signed-in web and Android app (`REMEMBER_RULE_CHANNELS`, `mayRememberOn` in `channel-rules.ts`). Every other channel, the CLI and a personal access token included, approves once.
- **One copy of the answer rules.** The constraint checks, the selection limits and which inputs need a sign-in are `@app/shared/question-rules` (`packages/shared/question-rules.js`), read by the web form, the MCP Apps widgets and `channel-rules.ts`.

## In a chat

A run started from a chat ([chat.md](chat.md)) asks in that chat: its request is a card in the thread, with the same form as the Inbox and the same route (`POST /api/questions/:id/answer`, channel `web`). The Inbox still lists it, with **Answer in chat**, and its notifications open the chat. Nothing else changes: it is one question, the rules in the table above apply, and a secret typed into the card goes to the fabric, never into a chat message. The thread keeps a record of the request and its outcome after it settles, never its value ([chat.md](chat.md), "Requests in the chat", E40.1).

## The web form

`/inbox` lists what is waiting and `/inbox/q/:id` shows one question; both render the same card (`apps/web/src/components/QuestionCard.tsx`) around the same form (`QuestionAnswerForm.tsx`).

**The card.** Chips for the kind and "High risk", a countdown ("4 min 05 s left") that ticks once a second on one timer for the whole page and turns to a warning colour under a minute, the prompt, who asked or the run it is for, and the page title (two lines at most, the full text in its tooltip). At zero the form is replaced by "This request expired." without waiting for a refresh. A browser-bound question also shows a small picture of its run's browser (`GET /api/runs/:id/screenshot`, refreshed every 5 s while it is on screen); a tap opens it full screen, and nothing is shown when it cannot be fetched. Every text that a user or a web page wrote wraps anywhere, so one long URL never widens the card.

**The form, per `input`.**

| `input` | Control | Notes |
|---|---|---|
| `text` | A text field, or a text area when `multiline` | Label "Your answer", always above the field. The error is on the left of the helper line and the "120 / 500" counter on the right |
| `number` | A number field with the `unit` at its end | Decimal keypad on a phone; no native spinner |
| `secret` | A field with a show/hide button | See below |
| `credentials` | "Username or email" and "Password" in one form, then "Sign in" | The password field lets the phone's password manager fill a saved sign-in (`autocomplete="current-password"`); the browser may then offer to save it for the console's address, which you can decline |
| `choice`, `multi_choice` | Full-width rows, at least 44 px tall, the whole row clickable | More than 8 options scroll inside a box; the buttons stay outside it. `multi_choice` says "2 of 3 selected" |
| `confirm` | The `confirmLabel` and `denyLabel` buttons | `risk: high` (the default) asks "Are you sure?" as a second step |
| `takeover` | "Open the browser", then "Done" | "Open the browser" is the main button until it has been pressed once |
| `none` | "Done" ("Approve" for kind `confirmation`) | |

**The buttons.** One row from 600 px up; on a phone a full-width stack in the order main action, Open the browser, Decline. Decline is always last. Declining a browser-bound question asks first ("Decline? The agent will be told you said no."), because its run cannot go on without an answer; a free-standing question declines at once. While an answer is sent, the main button shows progress and the card's controls are disabled.

**The secret field.**

- Its label is "Code" (kind `code`), "Password" (kind `login`) or "Secret", and the sentence "Sent straight to the agent's browser. Never stored or shown again." is helper text under it.
- The eye button shows or hides the value. It only changes the input's type: what is sent and stored is the same either way.
- A one-time code starts shown, with `autocomplete="one-time-code"` and a number pad when its `pattern` allows digits only. Every other secret starts hidden, with `autocomplete="new-password"` so the browser does not fill or offer to save it; password-manager hints (`data-1p-ignore`, `data-lpignore`) say the same.
- A shown value hides again when the answer is sent, when the tab is hidden, and after 30 seconds without a keystroke.
- The value lives in the form's memory only while it is typed. It is removed before the request is sent, even when the request then fails, and it is never logged, put in a URL or written to browser storage.

**After an answer.** In the Inbox the card says "Sent." or "Declined." for two seconds, then collapses. A failed answer shows its error inside that card and keeps what was typed (never a secret). An answer the API refuses because the question was already answered or had expired (409) shows that final state instead of an error.

**Refreshes.** The Inbox re-reads the list every 5 seconds. Cards keep their place and their state, so a refresh never interrupts typing; a new request appears on top with a brief highlight, and the request a notification links to (`?run=` or `?q=`) stays first.

## REST

All under `/api`, with `runs:read` to read and `runs:write` to ask or answer, except `answer-by-token`.

| Route | What |
|---|---|
| `POST /questions` | Ask yourself a free-standing question. Body: `input`, `prompt`, `kind?`, `options?`, `constraints?`, `confirmLabel?`, `denyLabel?`, `risk?`, `timeoutMs?`, `asker?` (recorded as `agent:<asker>`) |
| `GET /questions?status=&runId=&limit=` | Your questions, newest first; filter by `status` (`pending`, `answered`, `cancelled`, `expired`) or run |
| `GET /questions/:id?waitMs=` | One question; `waitMs` (≤ 30000) holds the request while it is pending |
| `POST /questions/:id/answer` | `{ outcome?, value?, values?, channel? }`. 400 `INVALID_ANSWER` when it breaks a constraint, 409 when already settled |
| `POST /questions/:id/cancel` | Decline it |
| `POST /questions/:id/answer-by-token` | Public. The webhook receiver's answer, with the token in the `x-question-token` header (never the query string) |
| `GET /inbox` | What is pending for you: questions and runs waiting for a person |
| `POST /notification-actions` | Public. A notification button, authorized by the button's single-use token |

Example (an agent asks which plan to pick):

```bash
curl -s -X POST "$HEXACTRA_CONSOLE_URL/api/questions" \
  -H "Authorization: Bearer $HEXACTRA_TOKEN" -H 'content-type: application/json' \
  -d '{"input":"choice","prompt":"Which plan should I renew?","options":[{"id":"basic","label":"Basic"},{"id":"team","label":"Team","description":"5 seats"}],"asker":"renewal-bot"}'
curl -s "$HEXACTRA_CONSOLE_URL/api/questions/<id>?waitMs=30000" -H "Authorization: Bearer $HEXACTRA_TOKEN"
# → { "data": { "status": "answered", "response": { "outcome": "completed", "value": "team", "channel": "web", "by": "user:…" }, … } }
```

The CLI: `hexactra questions ask --input choice --prompt "Which plan?" --option basic=Basic --option team=Team --wait 120`, `hexactra questions list [--all]`, `hexactra questions show <id> [--wait <s>]`, `hexactra questions answer <id> --choice team` (also `--value`, `--values a,b`, `--approve`, `--deny`, `--done`, `--decline`, `--secret-stdin`).

## Webhooks

Register an endpoint at `/settings/webhooks` (your own webhooks; the platform's webhooks slice). Deliveries carry Standard Webhooks signatures. The question events:

| Event | Data |
|---|---|
| `questions.question.asked` | `question` (`id`, `prompt`, `input`, `kind`, `options`, `constraints`, `confirmLabel`, `denyLabel`, `risk`, `expiresAt`, `runId`) and, for a public answer only, `answer` |
| `questions.question.answered` | `question` (`id`, `input`, `kind`, `runId`), `status`, `outcome`, `value` or `values` (never for a secret), `valueWithheld`, `channel`, `answeredAt` |
| `questions.question.cancelled` | The same, with `outcome: "cancelled"` |
| `questions.question.expired` | `question`, `status: "expired"` |

The `answer` block of `questions.question.asked`:

```json
{
  "url": "https://console.example.test/api/questions/<id>/answer-by-token",
  "method": "POST",
  "token": "…",
  "tokenHeader": "x-question-token",
  "expiresAt": "2026-11-15T19:00:00.000Z"
}
```

Answer by posting the answer body with the token in that header:

```bash
curl -s -X POST "$URL" -H "x-question-token: $TOKEN" -H 'content-type: application/json' -d '{"value":"team"}'
```

- The token is issued once per question, stored only as a sha256 in `action_tokens`, and answers that one question once, before it expires.
- An invalid answer (400 `INVALID_ANSWER`) does not spend it. A spent token is 409 `TOKEN_USED`; a settled question is 409 `ALREADY_ANSWERED` or `QUESTION_EXPIRED`; a wrong or expired token is 401.
- A question that is not public (secret, high-risk confirm, none, takeover) gets no `answer` block, and the route refuses it with 403 `CHANNEL_NOT_ALLOWED`.

## Notification quick actions

A free-standing question is announced as the `questions.asked` notification (in-app, Web Push, the Android app, email), linking to `/inbox/q/:id`. A browser run's question is announced by the run's `runs.needs_you` instead, so one question never makes two notifications.

- A low-risk confirm gets **Approve** and **Deny** buttons; a two-option choice gets one button per option. Other questions open the page.
- The service worker posts the button to `POST /api/notification-actions` (`action: "answer-0"` or `"answer-1"`) with a single-use signed token naming the question and the answers it allows, spent in `action_tokens`.
- When the question is settled elsewhere, the in-app notification is dismissed. A push already on a device stays, but its buttons answer nothing (409) and open the question instead.

## Add a channel

A channel is a `QuestionChannel` (`apps/api/src/questions/channels/question-channel.ts`) registered with the `QuestionChannelRegistry`. The built-ins are `inbox`, `notifications` and `webhook`. A post-v1 chat adapter (#293) follows the same shape:

```ts
@Injectable()
export class ChatQuestionChannel implements QuestionChannel, OnModuleInit {
  readonly id = 'chat'; // 1-40 of a-z, 0-9, ".", "_", "-"; unique

  constructor(private readonly registry: QuestionChannelRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** Buttons or replies only for public answers (channel-rules.ts). */
  canCollect(q: QuestionView): boolean {
    return isPublicAnswer(q);
  }

  /** Post the question (or, when !canCollect, only a link to /inbox/q/:id). */
  async deliver(q: QuestionView, ctx: QuestionChannelContext): Promise<void> {}

  /** Edit or delete the message once the question is answered, cancelled or expired. */
  async withdraw(q: QuestionView, ctx: QuestionChannelContext): Promise<void> {}
}
```

- `deliver` and `withdraw` run in the `questions.deliver` job, never in a request or an event listener. A failure is logged without the question or the answer.
- Never put a secret, or any answer of a secret question, in a message.
- Collect an answer by calling `QuestionsService.answer` as the owner, with your channel id; apply the same rule first (`isPublicAnswer`), and authorize the incoming answer yourself (a signed callback or a single-use token from `ActionTokenStore`).
