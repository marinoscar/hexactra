# Questions: asking a person

An agent asks its user a typed question and waits for a typed answer. The person answers wherever they are: the web app, the Android app, the CLI or TUI, a notification button, or a webhook receiver they run. This page is the reference for the console's question broker (epic #285). The fabric side (handoffs, `type_secret`) is in [../../docs/remote-control-api.md](../../docs/remote-control-api.md).

## Two kinds of question

| | Free-standing question | Browser-bound question |
|---|---|---|
| Asked with | `POST /api/questions`, `hexactra questions ask`, MCP `ask_human` | `POST /api/browser/sessions/:runId/handoffs`, MCP `browser_request_human`, the goal runner's `request_human` |
| Lives in | The console only (`questions` table) | A fabric handoff on the browser session, mirrored as a console question |
| Pauses a browser | No | Yes: the session's actions wait until it is answered |
| `secret` | Refused (`SECRET_NEEDS_BROWSER`) | Allowed: the fabric holds the answer and types it with `type_secret` |

Every question has an **owner** (the user it is asked of), an **asker** (`user:<id>`, `agent:<name>` or `run:<id>`) and an expiry (10 s to 24 h; 1 h by default). Only the owner sees or answers it: another user's question is a 404. Each step is recorded: asked, answered (with the channel and `by`), cancelled or expired.

## Question types

| `input` | The person gives | Constraints | Response |
|---|---|---|---|
| `none` | Nothing: they do something, then press Done | | `outcome` |
| `takeover` | Nothing: they take over the browser, then press Done | | `outcome` |
| `text` | A line or paragraph of text | `maxLength` (≤ 4096), `pattern` (whole-answer regex), `multiline` | `value` |
| `secret` | A code or password (browser-bound only) | | `valueWithheld: true`, never the value |
| `choice` | One option | 1-10 `options`, each a label or `{ id, label, description? }` | `value`: the option id |
| `multi_choice` | Several options | `options`, `minSelections`, `maxSelections` | `values`: option ids |
| `number` | A number | `min`, `max`, `step`, `unit` | `value`: a canonical decimal string (`"7.5"`) |
| `confirm` | Approve or deny | `confirmLabel`, `denyLabel`, `risk` (`low` or `high`, default `high`) | `value`: `approve` or `deny` |

`kind` says why it is asked (`captcha`, `code`, `passkey`, `login`, `confirmation`, `other`). Declining is `outcome: "cancelled"` for any type.

A response is `{ outcome, value?, values?, valueWithheld, channel?, by?, answeredAt }`. `by` is the signed-in answerer (`user:<id>`); a webhook answer is recorded as its owner on channel `webhook`. **The first answer wins**: a later one is a 409, whichever channel it comes from.

## Channels

A question is delivered on every registered channel and withdrawn from all of them once it is settled. The channel rules decide where an answer may come back:

| Answer | Inbox (web, Android app, CLI/TUI, MCP `inbox_answer`) | Notification buttons | Webhook (`answer-by-token`) |
|---|---|---|---|
| `choice`, `multi_choice`, `text`, `number` | Yes | A two-option `choice` gets one button per option; the rest open the question | Yes |
| `confirm`, `risk: low` | Yes | Approve and Deny buttons | Yes |
| `confirm`, `risk: high` | Yes (signed in) | Opens the question | No: the payload carries no token |
| `secret` | Yes, on the question's protected page | A link only | A link only |
| `none`, `takeover` | Yes | Opens the question | No |

- **Public answers** (choice, multi_choice, text, number, low-risk confirm) can be collected on any channel.
- **Secrets are link-only.** No notification, webhook or chat message ever carries a secret or a way to type one.
- **High-risk confirmations** are answered only where the console signs the person in.
- Chat apps (Slack, Teams, Telegram) are post-v1 (#293); they will be added as channels, under the same rules.
- MCP elicitation (the server asking the client's user directly) is not supported: the console's MCP transport is stateless. An agent asks with `ask_human` and waits with `wait_s` or `question_status`.

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
