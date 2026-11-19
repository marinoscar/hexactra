# Deliveries after a run

Epic E39 (#581), issue E39.6 (#603). When a run of a task ends, its result goes where the owner said, without the owner doing anything: an **email with the PDF report**, a **signed webhook** with the run's fields, a **row in a spreadsheet**, **files saved to a folder**. This is the "keep the evidence" half of the owner's monthly car-loan example: pay the loan on a schedule, then the email arrives, the row is added and the report is in the folder.

**A delivery is deterministic.** A job reads the finished run and the delivery's settings and sends. The model is not in that step, so nothing a web page said can change a recipient, a destination or the content beyond the values of the run's own result and outputs. A value is data: it fills a table cell, a subject placeholder, a column or a file name, and does nothing else.

## In short

- A **task** has up to **10 deliveries**, each of one of four **kinds**, each with a **when** (`always`, `succeeded`, `failed`, `needs_attention`).
- **Recipients, destinations and file names are fixed at setup**, by the owner, on the delivery. Nothing in a run (its goal, its result, an output value, a parameter, a page) can add, change or redirect one.
- A run end writes one **log row per delivery** and queues one job (`deliveries.send`) for each. Each is **sent once**, even when the job runs twice or retries.
- A delivery's failure **never changes the run's status**. It is in the run's log (the run page, `hexactra runs deliveries`), and the owner is told once per task per day.
- **Attachments and links are always the masked files** of E35. There is no unmasked report, trace or picture.

## Where things are

| What | Where |
|---|---|
| The API | `GET\|POST /api/tasks/{id}/deliveries`, `PATCH\|DELETE /api/tasks/{id}/deliveries/{deliveryId}`, `POST .../{deliveryId}/test`; `GET /api/runs/{id}/deliveries`, `POST /api/runs/{id}/deliveries/{runDeliveryId}/retry`; `GET\|POST /api/delivery-recipients`; with no session: `GET /api/reports/{token}`, `GET\|POST /api/deliveries/unsubscribe/{token}`. The OpenAPI at `/api/docs` is the reference. Permissions: `runs:read` to read, `runs:write` to change |
| The CLI | `hexactra tasks deliveries list <task>`, `hexactra tasks deliveries test <task> <delivery>`, `hexactra runs deliveries <run> [--retry <logId>]` |
| The SDK | `hx.tasks.deliveries(id)`, `hx.tasks.testDelivery(id, deliveryId)`, `hx.runs.deliveries(id)`, `hx.runs.retryDelivery(id, logId)` |
| MCP | **No tool creates or changes a delivery**: a hosted app must not add a recipient. `run_status` reports a `deliveries` summary (counts by status), never a recipient, a subject or a destination ([parity.md](parity.md#what-connections-added-e39)) |
| The web app | The run page's **Deliveries** block (status, the reason, **Retry**). The editor on the task page is E39.10 (#605); until then deliveries are created through the API (`POST /api/tasks/{id}/deliveries`, typed through `hx.api`); the CLI lists and tests them |
| The code | `apps/api/src/deliveries/`, `apps/api/prisma/fragments/deliveries.prisma`, `apps/api/src/tasks/run-files.service.ts`, `run-report-link.ts` |
| Settings | System namespace `deliveries`: `maxRecipientsPerTask` (10), `maxEmailsPerDay` (100), `maxAttachmentMb` (7). `PATCH /api/system-settings` |

## The four kinds

Each configuration is a strict object: an unknown key is `400 INVALID_DELIVERY` (`details.issues`: a path and a message each).

### `email`

`{ via, to, cc?, subject?, attach, includeOutputs, includeSensitive }`

- `via`: `"console"` (the default: the console's own email sender, set up under Administration → Email) or `{ connectionId }` (sent from the owner's own Gmail or Outlook account: the connection needs `mail_send` switched on).
- `to`: 1 to 10 addresses; `cc` up to 10 more. **One message per address, in both modes** (so each recipient has their own unsubscribe link): `cc` means "also gets a copy".
- `subject`: a template (below). Default `{{task}}: {{status}} on {{date}}`.
- `attach`: `{ pdf: true, json: false, screenshots: 'none' | 'final' | 'all' }`. The PDF embeds the step pictures when `screenshots` is not `none`; `final` attaches the last picture, `all` up to 20.
- `includeOutputs` (default on): the outputs as a two-column table. `includeSensitive` (default off): see [Masking](#masking).

The message (`apps/api/src/platform/email/templates/run-report.email.ts`, plain-text and HTML parts): the outcome in one sentence, the outputs table, the result text, a **What to check** callout when the run ended without success after a step the owner confirmed (#540: check the account before running it again), a button to the run, and the masking note. No remote image; pictures are only attachments. Every value is escaped into the HTML and printed as text in the plain part.

**Size.** The attachments of a console email are cut at the deployment's `maxAttachmentMb` (default 7); through a connection at the capability limits (10 MB a file, about 18 MB in all). A file that does not fit is left out; **a PDF that does not fit is replaced by a signed link to it** and the message says so ("The report is too large to attach"). The PDF without its pictures is tried first.

### `webhook`

`{ url, includeOutputs, includeReportLink, includeSensitive }`

One signed `POST` to the address, with the platform's envelope `{ id, type, createdAt, apiVersion, org, data }`:

- `type` is `runs.run.finished` and `data` is the same object that event carries (`runId`, `taskId`, `goal`, `trigger`, `status`, `result`, `error`, `outputs`, `outputsComplete`, `runUrl`, and `reportUrl` when asked). A test sends type `deliveries.test` with `data.test: true`.
- Signed as **Standard Webhooks** with the delivery's own secret (`webhook-id`, `webhook-timestamp`, `webhook-signature`). The secret (`whsec_...`) is **shown once, in the response that creates the delivery**, and kept in the encrypted credential store (purpose `delivery_webhook`); it cannot be read again.
- `webhook-id` is `run:<runId>:delivery:<deliveryId>` on every attempt: a receiver that keeps ids sees a retry as one event.
- The address goes through the platform's egress guard: **https only, never a private network address** (checked when the delivery is saved and again, after DNS, when it is sent: `DESTINATION_BLOCKED`).
- **`endpointId` is not offered.** The platform's webhook slice has no seam to deliver one payload to one existing endpoint (it fans an event out to every subscriber). Endpoints the owner already registered under Settings → Webhooks receive `runs.run.finished`, which now carries the same new fields; that is the "reuse where an endpoint exists" path. A seam request for sending to one endpoint can follow.

### `sheet_row`

`{ connectionId, fileId?, sheet?, newTitle?, columns, createIfMissing, includeSensitive }`

One row appended to the spreadsheet through the connection's documents capability (needs `docs_write`). `columns` is up to 50 `{ header, value }` where `value` is `{ kind: 'output', key }` (an output of the task) or `{ kind: 'field', field }` with `field` one of `run_date`, `status`, `task`, `goal`, `result`, `run_link`, `report_link`, `cost`, `steps`. A **Run ID column is always added last**.

- If the first row is empty the headers are written with the row.
- **Cells are written raw:** a value that starts with `=` is text, never a formula (the capability contract; the adapters and the in-memory double enforce it).
- With `createIfMissing` and no `fileId`, the first send **creates** the spreadsheet (titled `newTitle` or the task's name, headers in row 1) and **pins its id** into the delivery: the one change the system ever makes to a destination, and it is to a file it just created.
- **Exactly once.** On a retry, or after an attempt whose outcome is unknown, the sender first reads the Run ID column and, if the run's id is already there, adds nothing. An append the provider answered ambiguously (a timeout after the request left) is checked the same way before it is repeated. The check reads one column (up to 5,000 rows).

### `folder`

`{ target, files, nameTemplate }`

- `target`: `{ connectionId, folderId }` (a folder of one of the owner's connections; needs `docs_write`) or `"storage"` (the deployment's own object storage under `deliveries/<userId>/<runId>/`).
- `files`: `{ pdf, json, screenshots }` as above: the masked PDF report, the masked JSON trace, the masked step pictures. At least one.
- `nameTemplate` (default `{{task}} {{date}}`): the file name without its extension. Files are `<name>.pdf`, `<name>.json`, `<name> step-3.png`.
- A retry looks for the name in the folder before it uploads (no second copy); storage keys are the same on every attempt, so a retry overwrites.

## Templates and file names

`subject` and `nameTemplate` may use only `{{task}}`, `{{date}}` (the day the run ended, UTC), `{{status}}` (`succeeded`, `failed`, `stopped`) and `{{output:<key>}}` (an output the task defines). Anything else is `400` when the delivery is saved, as is a line break or a control character. At send time every value is **inserted as text, flattened to one line and cut to 80 characters**, so it can never introduce a header; in a file name `/`, `\`, `..`, reserved characters, control characters and bidirectional controls are replaced, so a value names a file and never a place. A template only ever sees **masked** text, even in a delivery that carries sensitive values.

## Recipients

- **Your own** account address and the addresses of **your own connections** are usable at once.
- **Any other address must be confirmed once, by you, in the web app**: a dialog naming the address, recorded with the time (`POST /api/delivery-recipients`). A delivery with an unconfirmed address **cannot be switched on** (`409 RECIPIENT_NOT_CONFIRMED`, `details.addresses`); it can be saved switched off. Only your own request confirms one: no run, tool or model path does, and there is no MCP tool for it.
- **The recipient is told once**, before the first report: "You will receive run reports from <you> through Hexactra", with a link that stops them. Every report carries the same link (the footer and a `List-Unsubscribe` header).
- **The link is a page with one button** (opening it changes nothing, so a mail scanner opening it does nothing); the button disables that recipient on **all** your deliveries (`unsubscribedAt`): their next report is skipped (`RECIPIENT_UNSUBSCRIBED`). Only you confirming the address again turns it back on.
- **Caps** (system settings `deliveries`): at most `maxRecipientsPerTask` different addresses over all of a task's email deliveries (default 10, `422 RECIPIENT_LIMIT`), and `maxEmailsPerDay` messages per user in 24 hours (default 100; a delivery over it fails `DAILY_LIMIT` before anything goes out). Tests count toward the daily number.
- Removing a connection removes its address from "yours": an email delivery that named it needs the address confirmed to send again.

## Masking

- A sensitive output reads **`[hidden]`** in the email table, the webhook and the spreadsheet cell unless the delivery was set up with `includeSensitive: true`: only then is the stored value used, and only by that delivery. A **subject or a file name never carries one**.
- **Attachments are the masked PDF, JSON trace and step pictures of E35** (#538 to #543): text is masked at export, pictures are masked at capture in the page. There is no unmasked attachment, for any setting. A picture whose masking was not recorded is left out rather than sent.
- The result and every non-sensitive output pass the same masking as a trace.

## What is sent, and when

`when`: `always`; `succeeded`; `failed` (status `failed`); `needs_attention` (a failed run, a run whose outputs are not all there, or a run that ended without success after a confirmed step). A stopped run matches `always`, and `needs_attention` when it did not return every output. Runs without a task (chat jobs, external sessions) have no deliveries.

A **schedule** can choose among its task's deliveries: `deliveryIds` on `POST /api/schedules` and `PATCH /api/schedules/{id}` (a list of the task's own delivery ids; `null` follows the task; an empty list sends nothing; an id that is not the task's is `400 INVALID_DELIVERY`). A manual run, the API and MCP use all of the task's enabled deliveries.

## How it works

1. **A run ends.** `RunEndHooks` fires; `DeliveryPipeline.onRunEnd` writes one `run_deliveries` row (`pending`) per enabled delivery whose `when` matches, and queues one `deliveries.send` job for each. `unique (run_id, delivery_id)` makes this idempotent: a second call adds nothing.
2. **The job** (`DeliverySendHandler`, server-only, one attempt) claims the row (`pending` to `sending`, compare-and-set; the loser changes nothing), builds the run's facts once (masked), builds the run's files **once per run** and shares them with the run's other deliveries (a small in-process cache), and hands them to the kind's sender. A row already `sent` or `skipped` does nothing: a job that runs twice sends once.
3. **Retries.** A rate limit, a provider error, a network error or a timeout (`RATE_LIMITED`, `PROVIDER_ERROR`, `NETWORK_ERROR`, `TIMEOUT`, `HTTP_5XX`) is retried **up to 5 times** with backoff (30 s, 2 min, 10 min, 30 min; a longer `Retry-After` wins). Anything else fails at once with its code: `CONNECTION_NEEDS_RECONNECT`, `CAPABILITY_OFF`, `PERMISSION_MISSING`, `NOT_FOUND`, `RECIPIENT_NOT_CONFIRMED`, `DAILY_LIMIT`, ... The owner is told **once per task per day** ("Could not add the row: the connection needs reconnecting."; the `deliveries.failed` notification, in the bell and on the phone).
4. **A write whose outcome is unknown** (the request left and got no definite answer) is never repeated blindly: an email fails `OUTCOME_UNKNOWN`; a row or a file is looked for first. A job that died mid-send leaves the row `sending`; after 10 minutes the next attempt treats it the same way, and the owner can retry it.
5. **The owner can retry** a failed delivery (`POST /api/runs/{id}/deliveries/{id}/retry`): a fresh set of attempts, still checking for its own earlier work. An email whose outcome was unknown may arrive twice.
6. **A test send** (`POST .../{deliveryId}/test`) sends a clearly marked test with **sample values built from the task's output definitions** to the delivery's own destination: an email marked `[TEST]` with no attachments, a webhook of type `deliveries.test`, a spreadsheet row whose Run ID reads `TEST-xxxxxxxx` (its location is returned), a small `TEST.txt` in the folder. It reads no run and writes no run's log; a failure is a `200` with `ok: false` and a `code`. At most 10 a minute.

## The log

`GET /api/runs/{id}/deliveries`: per delivery `status` (`pending`, `sending`, `sent`, `failed`, `skipped`), `attempts`, a closed `errorCode` with a fixed `errorText`, `detail` (counts, sizes, `messages`, `files`, a webhook's host) and times. **Never an address, a subject, a body, a cell, a file name or a webhook's path.** Deleting a delivery keeps its log with the run (`deliveryId` null); deleting a task removes its deliveries (and a webhook's secret), deleting a user purges everything (the three models are in the user-owned data registry).

**Observability.** Counters `app.deliveries` (kind; status `sent`, `failed`, `skipped`, `retry`, `test`) and a duration histogram `app.deliveries.duration` (kind); audit events `delivery.created`, `.updated`, `.removed`, `.recipient_confirmed`, `.recipient_unsubscribed`, `.sent`, `.failed`, `.retried`, `.tested` and `.connection_cleared` (ids, kinds and counts: never an address list, a subject, a body, a cell or a file name); the alert rule `hexactra.delivery_failing` (a delivery that failed 3 times in a day; [operations](runbooks/operations.md)). No log line, span or notification carries content.

## The report link

`GET /api/reports/{token}` streams a run's **masked PDF** with `Cache-Control: private, no-store`, with **no session**. The token is a signed claim of one run of one user (HMAC, keyed from `JWT_SECRET`) valid **7 days**; it grants that file and nothing else (no list, no other run, no other format). An expired, altered or unknown link, another user's run and a deleted run are all the same `404 REPORT_LINK_INVALID`; there are 20 requests a minute per run. The email carries one when the PDF was too large to attach, and a webhook with `includeReportLink` carries one as `reportUrl`. `runs.run.finished` carries `reportUrl`, `runUrl` and `outputsComplete` for every finished run (additive: existing subscribers are unaffected). The router's parameter length is raised to 1024 for these links.

## Connections

A delivery that uses a connection registers with the connection usage registry: Disconnect lists it ("<task>: spreadsheet row delivery") and, when the connection is removed, **switches those deliveries off** (`disabledReason: connection_removed`, the connection shown as "removed"). Switching one back on needs it pointed at a connection that exists and has the capability. The real Google and Microsoft adapters plug in through the provider-neutral interface (`connections/capabilities.ts`); the spreadsheet and folder deliveries are tested against its in-memory double.

## Not in this issue

The editor UI (E39.10, #605); deliveries for chat jobs without a task; messaging apps, SMS and other storage providers; unmasked reports; `endpointId` webhooks (above). **Verified with a real account** only when the owner runs the acceptance run on the deployed stack: one task with an email, a sheet row and a folder delivery, run twice.
