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

`kind` says why it is asked (`captcha`, `code`, `passkey`, `login`, `confirmation`, `other`). Declining is `outcome: "cancelled"` for any type.

A response is `{ outcome, value?, values?, valueWithheld, channel?, by?, answeredAt }`. `by` is the signed-in answerer (`user:<id>`); a webhook answer is recorded as its owner on channel `webhook`. **The first answer wins**: a later one is a 409, whichever channel it comes from.

### Memory proposals (#553)

A question of input and kind `memory` is a memory the agent proposes ([memories.md](memories.md#how-the-agent-proposes-one-553)). No question spec can ask one: `POST /api/questions`, `request_human` and an external agent's handoff refuse `memory`. It carries `blocking: false` (no run waits on it: a run's end does not cancel it, the chat's request card and the run's waiting state ignore it), `proposal` (the proposed memory) and `conversationId` (the chat it came from). Its `prompt` is always "The agent suggests remembering something.", so a notification or a webhook carries no value. It expires after 7 days.

The answer is `{ "outcome": "completed", "memory": { "label", "aliases"?, "attributes", "kind"? } }` (Save, with what the owner edited; without `memory` the proposal is saved as proposed) or `outcome: "cancelled"` (Not now). Only this answer writes the memory, through the memories service: a `422 MEMORY_HOLDS_SECRET` or a `409 MEMORY_LABEL_TAKEN` leaves the question pending. **Channels:** saved or declined only on `web`, `android_app` and `inbox`; every other channel, declining included, is `403 CHANNEL_NOT_ALLOWED`. Through the MCP endpoint a proposal is not listed and reads as `404`, and an answer claiming a console channel is recorded as `mcp` (refused).

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
- **One copy of the answer rules.** The constraint checks, the selection limits and which inputs need a sign-in are `@app/shared/question-rules` (`packages/shared/question-rules.js`), read by the web form, the MCP Apps widgets and `channel-rules.ts`.

## In a chat

A run started from a chat ([chat.md](chat.md)) asks in that chat: its request is a card in the thread, with the same form as the Inbox and the same route (`POST /api/questions/:id/answer`, channel `web`). The Inbox still lists it, with **Answer in chat**, and its notifications open the chat. Nothing else changes: it is one question, the rules in the table above apply, and a secret typed into the card goes to the fabric, never into a chat message.

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
