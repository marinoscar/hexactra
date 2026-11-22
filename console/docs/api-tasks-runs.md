# Tasks, schedules, runs and Home: the API behind the console's pages

Every route epic E32 (#418) added or changed, with its parameters, answers, permission and error codes, and what the other clients (CLI, TUI, MCP, SDK) do with it. All routes are under `/api`, answer `{ "data": … }`, need a signed-in caller (an access token or a personal access token in `Authorization: Bearer`) and only ever read or change the caller's own data: another user's task or run answers `404`. An error is `{ statusCode, code, message, details? }`; `code` is stable.

The per-endpoint reference is the OpenAPI document the API serves (`/api/docs`, `/api/openapi.json`). This page and that document are checked against each other: see [How this page was checked](#how-this-page-was-checked). Runs have their own, longer reference in [runs.md](runs.md); the pages that use these routes are described in [README, Using the console](../README.md#using-the-console).

## Every route

| Route | What it does | Permission | Answers | Error codes |
|---|---|---|---|---|
| `GET /runs` | The runs, newest first. `envelope=1` answers a page `{ items, nextCursor }`; without it, the array it always returned. Filters: `status`, `state`, `taskId`, `trigger`, `from`, `to`, `q`, `stopReason`, `policyId`; paging: `cursor`, `limit`, `order` ([runs.md](runs.md#get-apiruns)) | `runs:read` | `200` | `400 BAD_REQUEST`, `INVALID_FILTER`, `INVALID_CURSOR` |
| `GET /runs/counts` | How many runs match the same filters (all but `status` and `state`): `{ total, live, byStatus, costUsd, costKnown }` ([runs.md](runs.md#get-apirunscounts)) | `runs:read` | `200` | `400 BAD_REQUEST`, `INVALID_FILTER` |
| `GET /runs/:id/export` | The run as one masked JSON trace file, `hexactra.run-trace` (`format=json`; `screenshots=embed` (default) or `none`), sent as an attachment, not in the `data` envelope ([runs.md](runs.md#exporting-a-run)); `format=pdf` (with `paper=a4` or `letter`) answers the PDF report instead ([runs.md](runs.md#the-pdf-report)) | `runs:read` | `200` the file (`application/json` or `application/pdf`) | `400 BAD_REQUEST`, `404 RUN_NOT_FOUND`, `413 EXPORT_TOO_LARGE`, `429 EXPORT_RATE_LIMITED` |
| `POST /runs/:id/pause` | Pause a run: sets `pauseRequested`; a running run pauses before its next action, one waiting for a person once its question is answered ([runs.md](runs.md#pause-and-resume-e382)) | `runs:write` | `200`, the run | `404 RUN_NOT_FOUND`, `409 RUN_FINISHED`, `409 RUN_NOT_PAUSABLE` |
| `POST /runs/:id/resume` | Resume a paused run: it is queued again and a job with the reason `resumed` starts | `runs:write` | `200`, the run | `404 RUN_NOT_FOUND`, `409 RUN_NOT_PAUSED` |
| `DELETE /runs/:id` | Delete one finished run, with its steps and questions ([runs.md](runs.md#deleting-runs)) | `runs:delete` | `204` | `404 RUN_NOT_FOUND`, `409 RUN_LIVE` |
| `POST /runs/delete` | Delete a list (`{ ids }`, 1 to 500) or every finished run a filter matches (`{ filter, expectedCount? }`) | `runs:delete` | `200 { deleted, costUsd, skippedLive, notFound }`; `202 { jobId, matched, costUsd }` when a filter matches more than 500 | `400 BAD_REQUEST`, `INVALID_FILTER`, `409 COUNT_CHANGED` |
| `GET /runs/retention` | The caller's retention rule ([runs.md](runs.md#retention)) | `runs:delete` | `200 { keepDays, keepPerTask, keepFailedDays, saved, maxKeepDays, floorHours }` | |
| `GET /runs/retention/preview` | What the limits given (`keepDays`, `keepPerTask`, `keepFailedDays`; each optional) would delete now. It does not read the saved rule | `runs:delete` | `200 { wouldDelete, finished, oldestKept, costUsd, maxKeepDays, capped, floorHours }` | `400 BAD_REQUEST` |
| `POST /runs/retention/apply` | Apply the caller's saved rule now, as a queue job | `runs:delete` | `202 { jobId }` | |
| `GET /tasks` | The tasks. `envelope=1` answers a page `{ items, nextCursor, total }`; `include=summary` adds each task's schedules, last run and counts; `q`, `filter`, `policyId`, `sort`, `limit`, `cursor` | `tasks:read` | `200` | `400 BAD_REQUEST`, `INVALID_TASK_CURSOR` |
| `GET /tasks/:id` | One task; `include=summary` as above | `tasks:read` | `200` | `404 NOT_FOUND` |
| `POST /tasks` | Create a task, with optional `schedules[]` (at most 10) in the same transaction | `tasks:write` | `201`, the task with its `summary` | `400 BAD_REQUEST`, `INVALID_CRON`, `INVALID_TIMEZONE`, `CRON_TOO_FREQUENT`, `POLICY_REF_INVALID` (`details.path` names the schedule) |
| `PUT /tasks/:id/schedules` | Replace the task's schedules: update by `id`, create without, delete the unlisted | `tasks:write` | `200`, the task with its `summary` | the four schedule codes above, `400 SCHEDULE_NOT_IN_TASK`, `404 NOT_FOUND` |
| `POST /tasks/:id/schedules/pause` | Disable every schedule of the task | `tasks:write` | `200`, the task with its `summary` and `skipped` | `404 NOT_FOUND`, `409 NO_SCHEDULES` |
| `POST /tasks/:id/schedules/resume` | Enable every schedule of the task and compute the next firings | `tasks:write` | `200`, as above | `404 NOT_FOUND`, `409 NO_SCHEDULES` |
| `GET /tasks/:id/mail-triggers` | The task's email triggers (E39.8, [connections.md](connections.md#start-a-task-from-an-email-e398)): rules, account, status, runs today | `runs:read` | `200` | `404 TASK_NOT_FOUND` |
| `POST /tasks/:id/mail-triggers` | Start the task when a matching email arrives; `match.from` is required | `runs:write` | `201` | `400 MAIL_TRIGGER_CONNECTION_INVALID`, `MAIL_TRIGGER_INPUTS_INVALID`, `MAIL_TRIGGER_POLL_TOO_FAST`, `409 MAIL_TRIGGER_LIMIT` |
| `PATCH /mail-triggers/:id`, `DELETE /mail-triggers/:id` | Change, switch on or off, delete | `runs:write` | `200`, `204` | `404 MAIL_TRIGGER_NOT_FOUND` |
| `POST /mail-triggers/:id/test` | The last 5 matching messages (subjects cut to 60 characters) and whether each would start a run; starts nothing | `runs:write` | `200` | `409 MAIL_TRIGGER_CONNECTION_UNAVAILABLE` |
| `GET /mail-triggers/:id/events` | What the trigger did with each message it saw | `runs:read` | `200` | `404 MAIL_TRIGGER_NOT_FOUND` |
| `GET /tasks/:id/outputs` | What the task's finished runs returned, newest first, keyset paged (`limit` 1 to 100, default 20; `cursor`): `{ columns, items: [{ runId, status, createdAt, finishedAt, outputsComplete, values }], nextCursor }` ([Task outputs](#task-outputs)) | `runs:read` | `200` | `400 INVALID_CURSOR`, `404 TASK_NOT_FOUND` |
| `GET /tasks/:id/deliveries` | What the task sends when a run ends (E39.6), in order: email with the PDF report, signed webhook, spreadsheet row, files in a folder. Email recipients show where each stands (`own`, `confirmed`, `unconfirmed`, `unsubscribed`). Never a secret ([deliveries.md](deliveries.md)) | `runs:read` | `200`, an array | `404 TASK_NOT_FOUND` |
| `POST /tasks/:id/deliveries` | Add one (at most 10): `{ kind, config, enabled?, when?, position? }`. A webhook answers its `signingSecret` once | `runs:write` | `201` | `400 INVALID_DELIVERY` (`details.issues`), `409 RECIPIENT_NOT_CONFIRMED` (`details.addresses`), `422 RECIPIENT_LIMIT`, `422 TOO_MANY_DELIVERIES` |
| `PATCH /tasks/:id/deliveries/:deliveryId`, `DELETE ...` | Change one (the kind never changes; `config` is the whole new one) or remove it | `runs:write` | `200`, the delivery; `204` | as above, `404 DELIVERY_NOT_FOUND` |
| `POST /tasks/:id/deliveries/:deliveryId/test` | Send a clearly marked TEST with sample values to the delivery's destination; no run is read. A failure is `200 { ok: false, code, message }` | `runs:write` | `201 { ok, code, message, detail }` | `429 DELIVERY_TEST_RATE_LIMITED` |
| `GET /runs/:id/deliveries` | What was sent for the run: status, attempts, a closed `errorCode` with a fixed `errorText`, safe `detail`. Never content | `runs:read` | `200`, an array | |
| `POST /runs/:id/deliveries/:runDeliveryId/retry` | Retry a delivery that failed, or one stuck sending or pending | `runs:write` | `201`, the entry | `404 RUN_DELIVERY_NOT_FOUND`, `409 DELIVERY_NOT_RETRYABLE` |
| `GET /delivery-recipients`, `POST /delivery-recipients` | The addresses you confirmed; confirm one (`{ address }`): your explicit yes, recorded with the time | `runs:read`, `runs:write` | `200`; `201` | |
| `GET /reports/:token` | **No session.** A run's masked PDF by a signed 7-day link (`reportUrl`); `Cache-Control: private, no-store` | the token | `200 application/pdf` | `404 REPORT_LINK_INVALID` (expired, altered, another user's, deleted: all the same) |
| `GET\|POST /deliveries/unsubscribe/:token` | **No session.** The page behind the unsubscribe link of a run report email (the button is the `POST`) | the token | `200` HTML | `404` |
| `GET /tasks/:id/stats` | The task's run statistics for `days` (7 to 90, default 30) | `runs:read` | `200 { days, timezone, totals, avgDurationSeconds, p95DurationSeconds, avgSteps, avgCostPerSuccessUsd, series, stopReasons }` | `400 BAD_REQUEST`, `404 NOT_FOUND` |
| `POST /schedules/preview` | What `{ cron, timezone?, count? }` means and when it fires next. Saves nothing | `tasks:read` | always `200`: `{ valid: true, cron, timezone, description, next, intervalSeconds }` or `{ valid: false, code, message }` | inside the answer: `INVALID_CRON`, `INVALID_TIMEZONE`, `CRON_TOO_FREQUENT` |
| `GET /schedules/defaults` | The time zone a new schedule gets: `{ timezone, source }` | `tasks:read` | `200` | |
| `GET /home/summary` | The Home page in one read | a sign-in; each block needs its own permission | `200 { generatedAt, timezone, needsYou, liveRuns, upcoming, recentRuns, week, fleet, counts }` | |

Changed, not new: `POST /schedules` takes `timezone` as optional (the [time zone rule](#the-time-zone-rule)), every schedule answer carries a `description` in words, and a task holds at most 10 schedules (`409 SCHEDULE_LIMIT`). `maxSteps`, `maxMinutes` and `model` on a task are deprecated: a run's limits and models come from its [agent policy](../README.md#agent-policies), and the web app never sends them.

**The Knowledge Graph** (E46, experimental, off by default) adds `GET /tasks/:id/kgraph` (`kgraph:read`) and `PUT /tasks/:id/kgraph` (`kgraph:write`, `{ mode: "off" | "learn" | "reuse" }`, `409 KGRAPH_OFF` while the deployment's or the caller's switch is off), and its own routes under `/kgraph`. Nothing in the task and run routes above changes shape for it: a task's mode lives in `kg_task_settings`, not on the task, and `POST /tasks/:id/runs` has no "AI only this time" field yet. The routes, and what a replay does to a run: [knowledge-graph.md](knowledge-graph.md#api).

**What agent policies add to these routes** (E31; listed here because E32's pages show them):

- `GET /runs` and `GET /runs/counts` filter by `stopReason` (`budget` is every `budget_*` reason) and `policyId`, each run row carries `policy`, `costUsd`, `costKnown`, `modelCalls`, `stopReason` and `currentTier`, and the counts carry the matching runs' `costUsd` and `costKnown`.
- The delete answers and the retention preview carry `costUsd`: the recorded spend of the runs deleted, or that would be.
- A schedule in `schedules[]` (and on `POST`/`PATCH /schedules`) takes `policyId`: its runs use that policy instead of the task's.
- A task's `summary.policy` is the policy a run started now would use: `{ id, name, builtin, isDefault }`.
- `GET /tasks/:id/stats` carries `totals.costUsd`, `totals.costKnown`, `avgCostPerSuccessUsd` and `stopReasons` (`[{ reason, count }]`).
- `GET /home/summary`: a live run's `policyName`, `currentTier`, `startTier`, `budgetPercent` and `budgetWarnPercent`; a finished run's `stopReason`, `costUsd` and `costKnown`; the week's `costUsd`, `costKnown`, `budgetStops` and `stalled`.

**Deleting runs removes more than the runs.** Their cost and stop-reason history leaves task spend (`spend30d`, the statistics) and the alert counts that read runs. Retention never deletes a run inside the window an enabled alert rule reads ([README, Run history and retention](../README.md#run-history-and-retention)).

## Tasks and schedules

### The task list: `GET /api/tasks`

Needs `tasks:read`. With no parameter it returns every task, newest first, as an array (unchanged). All parameters are optional:

| Parameter | Meaning |
|---|---|
| `envelope=1` | Return a page, `{ items, nextCursor, total }`, instead of an array. `total` counts the tasks that match the filters, on every page. |
| `include=summary` | Add a `summary` to each task: its `schedules` (each with a `description` such as "Monday to Friday at 09:00" and its `policyId` override), `scheduleState` (`none`, `active`, `paused`, `partial`), `nextRunAt`, `lastRun`, `liveRunId`, `runCounts` (`total`, and `last7d` by outcome) and `policy` (the policy a run started now would use). Also on `GET /api/tasks/:id?include=summary`. |
| `q` | Case-insensitive text in the name or the goal (1 to 200 characters). |
| `filter` | `scheduled` (an enabled schedule), `paused` (schedules, none enabled), `unscheduled`, `failing` (a schedule failed 3 times in a row, or the last run failed), `never_run`. |
| `policyId` | Tasks whose own policy is this one; `default` is the tasks that follow your default policy. |
| `sort` | `created_desc` (default), `name_asc`, `last_run_desc`, `next_run_asc` (no next run: last), `spend_desc` (cost of the last 30 days). |
| `limit`, `cursor` | 1 to 100 (50 with `envelope`). `cursor` is the previous page's `nextCursor`: opaque, do not parse it, and valid only with the same `sort` (`400 INVALID_TASK_CURSOR` otherwise). |

A page costs the same number of database queries whatever its size. `created_desc` and `name_asc` page by keyset; the three computed sorts page by an offset inside the cursor, because their sort key moves whenever a run starts.

### A task with its schedules

`POST /api/tasks` takes an optional `schedules` list (at most 10; each `{ cron, timezone?, enabled?, concurrency?, policyId? }`). The task and its schedules are created in one transaction. One invalid schedule fails the whole request with `400`, a typed `code` (`INVALID_CRON`, `INVALID_TIMEZONE`, `CRON_TOO_FREQUENT`, `POLICY_REF_INVALID`) and `details.path` naming it, for example `schedules[1].cron`; nothing is created. The response is the task with its `summary`.

`PUT /api/tasks/:id/schedules` replaces the task's schedules in one transaction: an item with an `id` updates that schedule (its last run and failure count are kept, and a field left out is unchanged), an item without creates one, and schedules that are not listed are deleted. An `id` that is not this task's answers `400 SCHEDULE_NOT_IN_TASK`. `POST`, `PATCH` and `DELETE /api/schedules` still work one schedule at a time; a task holds at most 10 (`409 SCHEDULE_LIMIT`).

Deleting a task (`DELETE /api/tasks/:id`) deletes its schedules and keeps its runs, with `taskId` set to `null`.

### Pause and resume

`POST /api/tasks/:id/schedules/pause` disables every schedule of the task; `…/resume` enables them all, recomputes their next firing and resets their failure count (`tasks:write`; `409 NO_SCHEDULES` for a task without a schedule). This is what "disable a task" means: there is no enabled flag on a task. A run that is live when the task is paused finishes, and the task can still be started by hand, the API or MCP.

### Check a schedule before saving it

`POST /api/schedules/preview` with `{ cron, timezone?, count? }` (`count` 1 to 10, default 5; `tasks:read`) always answers `200`: `{ valid: true, cron, timezone, description, next, intervalSeconds }` with the next firings as ISO instants, or `{ valid: false, code, message }` with the reason saving would be refused. `description` is English and 24-hour; expressions the schedule builder does not write read "Custom schedule (<expression>)".

### The time zone rule

A schedule that is created without `timezone` gets the owner's profile time zone (Settings → Profile). When the profile follows the device ("Automatic"), it gets the zone the client sent in the `X-Time-Zone` header, which the web app always sends; with neither, `UTC`. `GET /api/schedules/defaults` returns `{ timezone, source }` (`profile`, `device` or `default`), so a client can show the zone before saving. An explicit `timezone` is still accepted. Changing the profile later does not move existing schedules.

### Statistics

`GET /api/tasks/:id/stats?days=30` (`runs:read`; 7 to 90 days, today included) returns `totals` (runs, outcomes, `successRate`, `costUsd`, `costKnown`), `avgDurationSeconds`, `p95DurationSeconds`, `avgSteps`, `avgCostPerSuccessUsd`, a `series` with one entry per day (zeros included) and `stopReasons`. Days are bucketed in the viewer's time zone (the same rule as above). `costUsd` is `null` when no run of the period has a cost, and `costKnown` is `false` when a run could not be priced.

### Tasks with parameters

A goal can hold named blanks (E36.6, #552). Running the task collects every missing value at once, checks it, fills the goal in and only then starts the agent: the model never asks for them one by one.

```
Send ${{Amount}} today to {{Phone Number}} using Zelle on my Bank of America account using the checking account ending in {{Account Last 4 Digits}}
```

**Syntax** (one parser for the API, the web form and the CLI: `packages/shared/task-params.js`):

- A placeholder is `{{Name}}`: letters, digits, spaces, `_` and `-`, 1 to 40 characters. Its **key** is the name lower-cased with spaces, `_` and `-` as one `_` (`Phone Number` → `phone_number`). The same key may appear more than once.
- Anything else between braces is text. `\{{` is a literal `{{`. `${{Amount}}` with `25` reads `$25`.
- A `{{` that is never closed, an empty `{{ }}` or a name over 40 characters is a `400 INVALID_GOAL` naming the position. At most 20 parameters.

**Definitions** (`parameters` on `POST /api/tasks` and `PATCH /api/tasks/:id`, returned on every task): `{ key, label, type, required, options?, help?, default?, constraints?, sensitive? }`.

- The server reconciles them with the goal on every save: a placeholder without a definition gets one (`text`, required, labelled with its name); a definition without a placeholder is dropped. Changing the goal re-runs this.
- `type`: `text`, `number`, `money` (a leading currency sign is dropped, so the goal's own `$` is not doubled), `date` (ISO, or `today` / `tomorrow` in the owner's time zone; the goal reads "Wednesday, November 18, 2026"), `choice` (2 to 50 `options`), `phone`, `email`.
- `constraints`: `min`, `max`, `maxLength`, `pattern` (at most 200 characters; back-references and nested quantifiers such as `(a+)+` are refused so a pattern cannot hang the server).
- `default`: `{ value }`, `{ identity: { field } }` or `{ memory: { id, attribute } }`. An **identity** default (`field` one of `full_name`, `date_of_birth`, `id_type`, `id_number`, `id_issuing_country`, `address_line1`, `address_line2`, `city`, `region`, `postal_code`, `country`, `phone`, `email`; E37.6) takes the value from the owner's saved details: the goal the model reads says `[provided: <label>]`, the run records the field in `runs.inputs.identity` (never a value; run views show "[from your saved details]" with source `saved_details`), and the agent fills it with `fill_from_identity`. A run that cannot use saved details asks for the value like a sensitive one. A `memory` default is resolved from the owner's memory when the run starts. It is read from the owner's **active** memory with that id ([memories.md](memories.md)), and the memory is marked used (`lastUsedAt`); the run records the source `memory`. A memory that is missing, archived or superseded, or one without that attribute, makes the value missing (it is then asked for).
- `sensitive: true`: a value that must not be stored or shown to the model (a gift card code). It has no default, cannot be preset on a schedule and is never accepted from the API, the CLI or MCP (`400 SENSITIVE_INPUT`). The goal the model reads says `[provided: <label>]`; once the browser is open the runner asks for it as a `secret` request (answered in the signed-in console), the fabric keeps it and the agent types it with `type_handoff_secret(parameter)`. It is in no table row, step, run view or export.
- Definition problems are `400 INVALID_PARAMETERS` with `details.issues` per key.

**Starting a run with inputs.** `POST /api/tasks/:id/runs` takes `inputs: { <key or name>: value }`.

- Unknown names are `400 UNKNOWN_INPUT` (so is any input on a task without parameters); an invalid value is `400 INVALID_INPUT` with `details.issues` per key. Nothing is written for a refused start.
- Values come from `inputs`, then a schedule's presets, then the defaults. `runs.inputs` keeps each value with its source (`provided`, `default`, `memory`, `asked`, `schedule`); run views return them **masked** (#538), as `inputs: [{ key, label, value, source }]`.
- `runs.goal` is the **rendered** goal: each value between the data markers `⟦ ⟧`, which the runner's instructions describe as data. The console shows the marked values masked; the model reads the real ones. A value is text only: it cannot add a placeholder, and nothing in it changes the task's allowed sites, policy or confirmation setting.
- A task without parameters behaves exactly as before.

**Missing values: one form, before the browser opens.** When a required value is still missing, the run is created `waiting_human` with one question of input `form`: `fields: [{ key, label, type, required, options?, help?, constraints? }]`. No browser session and no model call happen until it is answered, and the waiting time is not active time.

- Answer it like any question: `POST /api/questions/:id/answer` with `{ outcome: "completed", fields: { amount: "25" } }`, or `POST /api/inbox/:runId/respond` with the same body. Every field is checked with the parameter rules; a bad answer is `400 INVALID_INPUT` with `details.issues` and the run keeps waiting. A good one fills the goal, moves the run to `queued` and starts it. The stored answer keeps the values masked.
- Declined or expired (24 hours), the run ends `cancelled` with "The values were not provided."
- Channels: answered in the signed-in web and Android app, the Inbox, and by an AI app through `inbox_answer` with `fields` (a form never holds a sensitive field). Notifications and webhooks carry a link. The CLI does not answer a form: `hexactra tasks run` asks for missing values before it starts the run.

**Schedules.** A schedule stores `inputs` (presets, checked like a run's). Saving, enabling or resuming a schedule whose task has a required parameter with no preset, no default and no memory is `400 SCHEDULE_INPUTS_MISSING`. If a value is missing at fire time anyway (a memory was deleted), the run waits on the form and the owner is notified.

**Chat, CLI, SDK and MCP.**

- Chat: the orchestrator's `run_task(task, inputs)` starts a saved task by name ("send Paula 25 with my Zelle task"); a missing value produces the same form in the thread.
- CLI: `hexactra tasks run <task> --input amount=25 --input "Phone Number=555 010 6020"`; at a terminal, each missing value is prompted for. A sensitive parameter is never prompted: the CLI prints the console link.
- SDK: `packages/sdk/src/examples/task-parameters.ts`.
- MCP: `task_run` takes `inputs`; `tasks_list`, `task_create` and `task_update` return `parameters` with `has_default` and never a default's value; `schedule_create` takes `inputs`; `inbox_answer` takes `fields`. Scopes, effects and titles are unchanged.

### Task outputs

A task can name the values its runs must return (E39.5, #600): a payment's amount, its confirmation number, the date, the remaining balance. The agent has to give them when it finishes; they are checked on the server, kept on the run, shown, listed per task and sent on by the webhook. A row in a spreadsheet needs columns, not a paragraph.

**Definitions** (`outputs` on `POST /api/tasks` and `PATCH /api/tasks/:id`, returned on every task; at most 30): `{ key, label, type, required, options?, help?, sensitive? }`.

- `key`: snake_case, unique in the task, 1 to 40 characters (`a-z`, `0-9`, `_`). Omitted, it is derived from the label (`Confirmation number` → `confirmation_number`; a derived key that is taken gets `_2`). Types are the shared ones of `packages/shared/task-fields.js`, which task parameters share the names of (`text`, `number`, `money`, `date`, `choice`) plus `datetime`, `boolean` and `url`.
- `required` defaults to `true`. `options` (2 to 50) only for a `choice`. `help` is one line telling the agent what to look for. `sensitive: true` masks the value wherever a person, an export or an AI app sees it ([below](#what-is-masked-in-an-output)).
- `outputs: []` on a `PATCH` removes them. Definition problems are `400 INVALID_OUTPUTS` with `details.issues` per key. A schedule, the API (`POST /tasks/:id/runs`), MCP and the chat all start a run with the task's outputs; none of them can redefine them, and a start body has no `outputs`.
- A chat job (no task) has no outputs. A chat that starts a saved task with `run_task` does.

**The agent's side.** When the run's task has outputs the instructions gain a section that lists each one (key, label, type, required, `help`) and says: collect these while you work; give every required one in `finish`; write a value exactly as the page shows it; if one cannot be found give `null` and say why in the result. The section depends only on the definitions the run started with, so it is part of the stable prefix and identical in every round. `finish` takes `outputs`, an object with exactly the task's keys (each nullable; `number`, `money` and `boolean` also take the page's text), built into the tool's JSON schema. A task without outputs gets today's `{ success, result }` schema unchanged.

**Validation, on the server.** Unknown keys are dropped; each value is read by its type:

| Type | Reads | Stored as |
|---|---|---|
| `text` | a line of at most 500 characters | the text |
| `number` | `1,234.50`, `1.234,50`, `12,50`, `(12.5)` (a negative), `-3` | a number |
| `money` | a number with an optional sign or ISO code before or after: `$1,234.50`, `EUR 20`, `20.00 CAD`, `US$ 5`. A bare `$` reads as USD | `{ amount, currency }` (`currency` null when the page gave none) |
| `date` | ISO `YYYY-MM-DD`, or when unambiguous `03/25/2026`, `25/03/2026`, `25.03.2026`, `March 25, 2026`, `25 March 2026`. `03/04/2026` is refused | `YYYY-MM-DD` |
| `datetime` | ISO 8601 with a time, or a local date then a time (`March 25, 2026 3:30 PM`) | `YYYY-MM-DDTHH:MM:SS` (with `Z` or the offset the page gave) |
| `boolean` | `true`/`false`, `yes`/`no`, `y`/`n`, `1`/`0`, `on`/`off` | a boolean |
| `url` | an absolute `http` or `https` address | the address |
| `choice` | one of the options, case-insensitive | the option |

On a success finish with a missing required value or a value that does not parse, `finish` does **not** end the run: it answers the model with what is wrong ("`confirmation_number` is required", "`amount_paid` is not an amount of money: 'ten dollars'") and the run goes on, **twice at most**. After that the run finishes with what it has: an invalid field is `null` with its reason, and `outputsComplete` is `false`. A `success: false` finish may omit outputs and is never refused; whatever it gives is validated and stored. The wrap-up call after a budget or a stall uses the same schema (and is never refused), so a stopped run still returns the fields it found. A model that stops without calling `finish` is asked for the outputs by the same rule. A run with outputs that ends without having returned them (Stop, an error) has `outputsComplete: false`. The agent's words are scrubbed of a sensitive output's value before they are stored as the result.

A value is data. Nothing downstream reads it as an instruction, and it cannot name a recipient or a destination: deliveries (E39.6) take those from the task only.

**Storage and views.**

- `runs.outputs_spec` copies the task's definitions when the run **starts**, so editing the task never relabels an old run. `runs.outputs` is `{ [key]: { value, ok, note? } }`; `runs.outputs_complete` says whether every output was returned and valid (`null` without outputs or before the run ends).
- `GET /api/runs/{id}` returns `outputs: [{ key, label, type, required, sensitive, value, ok, note }]` (definitions as the run started with them, values masked) and `outputsComplete`. A list row (`GET /api/runs`) carries only `outputsComplete`. `note` is "Not found" or the reason a value was refused ("Not a number"); it never holds a value.
- `GET /api/tasks/{id}/outputs?limit=&cursor=` answers the history the task page shows: `columns` (the task's outputs now, then any key an older run reported that the task no longer has) and `items`, the task's finished runs that had outputs, newest first, each with `values` by key. `404 TASK_NOT_FOUND` for a task that is not yours.
- The chat result message's `meta` carries `outputs` and `outputsComplete`; the webhook `runs.run.finished` payload gains `outputs` (additive: absent for a task without outputs) and, from E39.6, `outputsComplete`, `runUrl` and a signed `reportUrl` ([deliveries.md](deliveries.md#the-report-link)); MCP `run_status`, `run_wait`, `run_goal`, `task_run` and `run_cancel` return `outputs` (and `outputs_complete` in the `progress` block), and `tasks_list` returns each task's `outputs` definitions; the JSON trace file (`outputs`, `outputsComplete`) and the PDF report (an "Outputs" section after the outcome) include them.

#### What is masked in an output

A `sensitive` output is stored whole (the owner may configure a delivery to carry it, E39.6) and reads `[hidden]` in the run view, the history table, the chat message, the webhook payload, the MCP results, the JSON trace and the PDF report. It is never in a step, a log or a span. Any other text value passes the same masking as the rest of a trace ([runs.md, "What is masked"](runs.md)): a long digit run that looks like a card number is masked, so a confirmation number that long should be a `sensitive` output only if it must not be seen. A hosted AI app sees what the REST view returns: never an unmasked sensitive value.

**Clients.** Web: the task form's **Outputs** section (rows of label, type, required, what to look for and sensitive; add, remove, reorder; the key under **More**; a hint for a scheduled task with none), an **Outputs** block under a finished run's result and in the chat's result card, an **Outputs** table on the task page, and a chat draft that proposes outputs from what the finished run reported. CLI: `hexactra runs show <id>` prints them; `hexactra tasks outputs <task> [--limit n] [--csv|--json]` prints the history as a table or a CSV (one column per output; money as an amount and a currency column; a cell that would read as a formula is prefixed). SDK: `hx.tasks.outputs(taskId, { limit, cursor })` and `src/examples/task-outputs.ts`. MCP: no new tool.

### Deliveries after a run (E39.6)

A task can send its result where the owner said when a run ends: an email with the masked PDF report, a signed webhook with the fields, a spreadsheet row, files in a folder ([deliveries.md](deliveries.md) has all of it). The settings are `GET|POST|PATCH|DELETE /api/tasks/{id}/deliveries`, the log is `GET /api/runs/{id}/deliveries`, and a schedule can choose among the task's deliveries with `deliveryIds` (`POST /schedules`, `PATCH /schedules/:id`; `null` follows the task).

- **Fixed at setup.** Recipients, destinations and file names are stored on the delivery by the owner's own request. A run, a parameter, an output value or a page cannot add or change one; an unknown key is `400 INVALID_DELIVERY`.
- **Sent once.** A run end writes one log row per delivery and queues one `deliveries.send` job; a job that runs twice, or a retry, sends once.
- **Masked.** A sensitive output reads `[hidden]` unless the delivery was set up to carry it; attachments are always the masked files.
- **Never in MCP.** No tool creates or changes a delivery; `run_status` carries `deliveries` (counts by status).
- Another user's task, run or delivery is `404`.

### Saved logins on a task (E37.3)

- `useSavedLogins` (boolean): let the task's runs sign in from the owner's saved logins. Absent on create, it starts from the owner's user setting `secrets.defaultUseSavedLogins` (off unless turned on); `PATCH` changes it. It works only while the deployment's and the owner's secrets switches are on and a Vault is connected, and an AI app's run also needs the app's `allowSavedLogins` ([secrets.md](secrets.md#how-the-agent-signs-in)).
- `unattendedPayments` (`ask` default, or `allow`): what a run that is **not** started from a chat does at a payment step after it signed in with a saved login. `ask` keeps the confirmation before commitments on for that run even when `confirmRiskyActions` is off; `allow` leaves the task's own setting. Saved approvals still apply.
- `useSavedIdentity` (boolean, default off, E37.6): let the task's runs fill **identity details** (a date of birth, an ID number, an address) from the owner's saved details. It needs `useSavedLogins`, a provider that holds identity details (the Vault grant has `vault:identity_read` and `vault:identity_fill`) and, for an AI app's run, the app's `allowSavedIdentity` (default off). The model names a field; the fabric types it; no value is ever returned ([secrets.md](secrets.md#identity-details-e376)).
- `useSavedCards` (boolean, default off, E37.7): let the task's runs **pay with a saved card**, under the owner's per-merchant approval and an amount limit. It needs `useSavedLogins`, a provider whose grant has `vault:cards_read` and `vault:cards_fill` with Vault's card release on, and for an AI app's run the app's `allowSavedCards` (default off). The model names a card and the fields; the fabric types them; no number, expiry or code is ever returned. An unattended run (not started from a chat) types a card only with `unattendedPayments: allow` **and** a matching remembered approval with an amount limit ([secrets.md](secrets.md#cards-e377), [approvals.md](approvals.md#cards-e377)).
- `connections` (list of `{ connectionId, access }`, E39.7): the connections (mail, calendar, documents) the agent may use in the task's runs; `access` is `read` or `read_write`. **Off until listed**; replacing the list is allowed (`PATCH`), `[]` switches every connection off; a connection that is not the caller's, or is listed twice, is `400 CONNECTION_SELECTION_INVALID`. Responses carry each entry with the connection's label, provider, address and status. A run snapshots the list when it starts. A run an AI app starts has none unless the app's limit `allowConnections` is on. See [connections.md](connections.md#what-the-agent-can-do-with-a-connection-e397).
- `needsBrowser` (`auto` default, `always`, `never`, E39.7): whether the task's runs open a browser. With `auto`, a run that has connections opens it at its first browser tool call (a job that needs only mail, a calendar or documents allocates no node); a run without connections opens it at the start, as before.
- A chat has the same `useSavedLogins`, `useSavedIdentity` and `useSavedCards` (`POST`/`PATCH /api/chats`), and a task drafted from a chat carries them over.

### Secrets fields at a glance (epic E37)

Every switch is **off by default**, and none of these fields, in any request or response, ever carries a value. The model of the whole feature is in [secrets.md](secrets.md) and its threats in [security-secrets.md](security-secrets.md).

| Where | Field | Meaning |
|---|---|---|
| Task, chat (`POST`/`PATCH /api/tasks`, `/api/chats`) | `useSavedLogins` | Sign in from saved logins and authenticator codes. A new one starts from the owner's `secrets.defaultUseSavedLogins`. |
| Task, chat | `useSavedIdentity` | Also fill identity details (needs `useSavedLogins`). |
| Task, chat | `useSavedCards` | Also pay with a saved card, at a merchant and up to a limit the owner approved (needs `useSavedLogins`). |
| Task, chat | `connections` | The accounts the agent may use (mail, calendar, documents), each read only or read and write. Off until listed (E39.7). |
| Task only | `needsBrowser` (`auto` \| `always` \| `never`) | Whether the runs open a browser; `auto` opens it at the first browser tool when the run has connections. |
| Task only | `unattendedPayments` (`ask` \| `allow`) | What a run **not started from a chat** does at a payment after it signed in with a saved login. `ask` keeps the confirmation on. |
| Task parameter | `default: { identity: { field } }` | A parameter filled from a saved identity field (the goal reads `[provided: <label>]`). |
| Run (read-only) | `usedSavedLogins`, `usedSavedIdentity`, `usedSavedCards` | What the run used: names, labels, sites and (for a card) brand, last four and amounts. Never a username, a password, a code, a detail or a card number. |
| Connected AI app (`PATCH /api/connected-apps/{clientId}/settings`) | `allowSavedLogins`, `allowSavedIdentity`, `allowSavedCards`, `allowConnections` (E39.7: the app's runs may use the connections the task lists) | The app's own limits; each is a further condition on a run the app starts, and none widens another. |
| User settings (`PATCH /api/user-settings`) | `secrets.agentUse.enabled`, `secrets.defaultUseSavedLogins`, `secrets.provider` | The owner's switch, where new tasks and chats start, and which provider (`vault` or `builtin`) is active. |
| System settings (`PATCH /api/system-settings`) | `secrets.agentUse.enabled`, `secrets.vault.allowedHosts` | The deployment's switch, and the Vault host names exempt from the private-address check. |

A run uses a saved secret only when **all** of its switches hold; otherwise the secret tools are not offered and the run asks the owner, as before. A provider that is down, revoked or without a match also ends in a question to the owner, never in a failed run. There is no MCP tool and no CLI command for any of this ([parity.md](parity.md#what-secrets-added-e37)).

## Runs

A run an email started (E39.8) has `trigger: email`, origin `system` and `mailTriggerId`; `GET /runs` filters by `trigger=email`, and a run's inputs show the source `email` for each value a message gave. A task's `summary.mailTriggers` is the number of email triggers switched on, and `summary.deliveries` (E39.10) the number of deliveries switched on; `GET /runs/{id}` names the trigger that started a run in `mailTriggerId` (null otherwise; the run page links it).

The list, its filters and cursor, the counts, deleting and retention are in [runs.md](runs.md). In short:

- **Saved cards used.** `usedSavedCards` on a run: `[{ provider, itemName, brand, last4, merchant, origin, currency, declaredAmount, confirmedAmount, mismatch, at }]`, at most 10, empty when none. The brand, the last four digits, the merchant, the amount the agent declared and the one it read on the confirmation page (`mismatch` when they differ by more than a cent or one percent), never a number, an expiry or a code (E37.7).
- **Saved details used.** `usedSavedIdentity` on a run: `[{ provider, itemName, label, origin, at }]`, at most 40, empty when none. The item's name and the field's **label** ("Date of birth"), never a value (E37.6).
- **Saved logins used.** `usedSavedLogins` on a run (`GET /api/runs/{id}` and the list): `[{ provider, itemName, origin, at }]`, empty when none. The item's name and the site, never a username, a password or a code (E37.3).
- **Pause and resume.** `paused` is a live status (`state=live`, the counts' `live` and a status filter include it); `pauseRequested` and `pausedAt` are on every run. The deployment setting `runs.maxPausedHours` (system settings, namespace `runs`, default 72, `null` for no limit) cancels a run paused for longer, with the reason "Paused too long".
- **Trace id.** `traceId` on a run (`GET /api/runs/{id}` and the list): the OpenTelemetry trace id of its latest job, `null` before the first job or with the telemetry slice off; every job's id is `run.traceIds` in the JSON export ([operations runbook, Reading a run's trace](runbooks/operations.md#find-a-runs-trace-and-read-it)).
- **A page.** `GET /api/runs?envelope=1&limit=50` answers `{ items, nextCursor }`; pass `nextCursor` back as `cursor` with the same filters; `null` is the end. A row never carries `transcript` or `policySnapshot`.
- **Delete by filter.** `POST /api/runs/delete` with `{ filter, expectedCount }`: the filter is the list's own, live statuses are never matched, "all my finished runs" needs `expectedCount`, and a count that moved by more than 5 % answers `409 COUNT_CHANGED` with `details { matched, expectedCount }`. Up to 500 matches are deleted in the request; more answer `202` and the queue job `browser.runs.delete` deletes them.
- **Export.** `GET /api/runs/{id}/export` answers the run's masked trace file (`hexactra.run-trace`, JSON Schema `packages/sdk/run-trace.schema.json`): the run, policy, budget, models, every step with its question and answer, the trace screenshots (`screenshots=none` leaves them out) and the chat. Never the transcript, a token or a withheld answer; 50 MB at most; 10 a minute. `format=pdf&paper=a4|letter` renders the same masked trace as a PDF report (#543).
- **Retention.** The rule is the `runs` namespace of the user's settings (`PATCH /api/user-settings`); the three routes above read it, preview limits and apply it. The preview takes its limits as parameters: `GET /api/runs/retention/preview` with none answers for "no limit at all", whatever rule is saved.

## Home

**`GET /api/home/summary`** needs a sign-in and no permission of its own. A block is built only when the caller holds its permission and is `null` otherwise, never an empty list: `needsYou`, `liveRuns`, `recentRuns` and `week` need `runs:read`; `upcoming` needs `tasks:read`; `fleet` needs `fleet:read`; `counts.tasks` and `counts.runs` are `null` without theirs. Limits: 3 questions, 6 live runs (running first), 5 firings, 8 finished runs, 6 machines; `needsYou.count` and `liveRuns.count` are the real totals. The response never carries a question's answer, a secret, a transcript, a policy snapshot, an action's arguments or a viewer URL: a live run's `activity` is its phase, the action's name and the reason only. `budgetPercent` is the highest percent among the run's limited budgets, from the run's stored budget. The week is bucketed in the profile time zone (else the `X-Time-Zone` header, else UTC). The fleet comes from the fabric with a 1.5 second limit: a fabric that is slow or down answers `fleet.stale: true` with the last hosts read, and never fails the request. It costs six SQL statements whatever the account holds, and records `app.home.summary.duration`.

## Client parity

What each client can do with the capabilities of E32. "No" is a decision, with its reason; nothing here is left for later. The capabilities of epic E33 (connected apps, the activity log, the kill switch, the in-chat cards, consent) are in [parity.md](parity.md). The machine-checked form of this table is [packages/shared/capabilities.json](../packages/shared/capabilities.json): each surface's tests fail when a tool or command it names is missing.

| Capability | MCP (`apps/api/src/mcp/mcp.tools.ts`) | CLI and TUI (`apps/cli`) | SDK (`@hexactra/console-sdk`) |
|---|---|---|---|
| A page of runs, filtered | **Implemented.** `runs_list` takes `status`, `task_id`, `stop_reason`, and `limit` / `cursor` for a page (`{ items, nextCursor }`); with neither it answers the list it always did | **Implemented.** The TUI Runs screen reads a page and `m` loads the next one. `hexactra runs list` keeps printing the most recent runs (`--status`): **decided: no** paging flags, because a script that needs more reads the REST route with `hexactra api` | **Implemented.** `hx.runs.list({ …filter, cursor, limit })` answers a `RunPage` |
| Delete runs | **Decided: no tool.** An agent must not erase its own history: the runs are the user's record of what the agent did, and the audit trail of an agent with the user's full powers. A test fails if a tool named like one appears | **Implemented.** `hexactra runs delete <id>` and `runs delete --older-than <days>`; both ask first (`--yes` for a script). The TUI: **decided: no**, it is for watching and answering | **Implemented.** `hx.runs.delete(id)`, `hx.runs.deleteMany({ ids } \| { filter, expectedCount })` |
| Export a run as a trace file (#542) | **Implemented.** `run_export` (read-only, `runs:read`): the trace without images, cut to the result size limit (`truncated`) | **Implemented.** `hexactra runs export <id> [--no-screenshots] [-o <file>]`, and `--pdf [--paper letter]` for the PDF report (#543). The TUI: **decided: no**, it is for watching and answering | **Implemented.** `hx.runs.export(id, { screenshots })` answers a `RunTrace`; example `src/examples/run-export.ts` |
| Retention rule | **Decided: no tool**, for the same reason as deleting | **Decided: no** command for the standing rule: it is a setting with a preview, made on its page. `runs delete --older-than` is the one-off form | **Decided: no** helper: three plain routes, typed through `hx.api` (`RetentionSettingsResponseDto`, `RetentionPreviewResponseDto`, `RetentionApplyResponseDto`) |
| Pause and resume a task's schedules | **Implemented.** `task_pause`, `task_resume` | **Implemented.** `hexactra tasks pause\|resume <id>` (one schedule: `schedules pause\|resume`) | **Implemented.** `hx.tasks.pauseSchedules(id)`, `hx.tasks.resumeSchedules(id)` |
| Schedule preview | **Implemented.** `schedule_preview` (read-only) | **Decided: no.** `schedules create` reports the same errors when it saves, and prints the next firing | **Implemented.** `hx.schedules.preview({ cron, timezone?, count? })` |
| Create a task with schedules | **Implemented.** `task_create` takes `schedules[]` (`cron`, `timezone`, `enabled`, `policy_id`) | **Decided: no** `--schedule` flag: `tasks create` then `schedules create` are two short commands, and a failed second one leaves a task that can be scheduled again | **Implemented.** `hx.tasks.create({ …, schedules })` answers the task with its summary |
| Replace a task's schedules (`PUT`) | **Decided: no tool.** It deletes the schedules it is not given, which is too easy for an agent to get wrong; `schedule_create` adds one | **Decided: no**: `schedules create\|pause\|resume\|delete` cover it one schedule at a time | **Decided: no** helper: `hx.api.PUT('/api/tasks/{id}/schedules', …)` is typed |
| Task statistics | **Decided: no.** An agent reads the runs themselves (`runs_list` with `task_id`); the statistics are a chart for a person | **Decided: no**, same reason | Typed through `hx.api` (`TaskStats`) |
| Wait for a run's progress in one call (`run_wait`, #463) | **Implemented.** `run_wait { run_id, wait_s, since, screenshot }`, and `wait_s` on `run_goal` and `task_run`; every run answer carries a `progress` block | **Decided: no** new command: `hexactra runs watch <id>` already follows a run live in a terminal (the stream), and a script waits on the REST stream. `run_wait` is a tool-only convenience for chat apps, which have no timers and no stream | **Decided: no** helper: a program reads `GET /api/runs/{id}` and `GET /api/questions?runId=` (typed through `hx.api`) or follows the SSE stream `GET /api/runs/{id}/stream`; the progress block is an MCP view of those two reads |
| Home summary | **Decided: no.** An agent reads each part with its own tool (`runs_list`, `inbox_list`, `schedules_list`, `hosts_list`) | **Decided: no.** The CLI lists each part (`runs list`, `inbox list`, `schedules list`, `fleet hosts`) and the TUI opens on its own screens | Typed through `hx.api` (`HomeSummaryResponseDto`); no helper, it is one call |

Every MCP change has a test in `apps/api/test/mcp.db.spec.ts` ("MCP tasks, schedules and the paged run list"), the CLI's are in `apps/cli/src/runs.test.ts`, and the SDK's example (`packages/sdk/src/examples/tasks.ts`) calls each new helper against a running API in `apps/api/test/sdk.db.spec.ts`.

One known difference, kept on purpose: `hexactra schedules create` sends `--tz`, which defaults to the terminal's time zone, while the web, MCP and the SDK leave the zone out and get the profile's. Someone at a terminal expects the terminal's clock; pass `--tz` to choose.

## How this page was checked

- **Against the OpenAPI document.** `packages/sdk/openapi.json` is the document the API serves: `apps/api/test/sdk.db.spec.ts` ("ships the OpenAPI document the API serves") fails when the two differ. Every route in the table above was read from that file (path, method, query parameters, the permission in its description, the answer's schema, the status codes) and compared with this page.
- **What the comparison found.** The document called the three limits of `GET /runs/retention/preview` required while the route accepts none; the schema was corrected (the route's behaviour did not change) and a test pins it (`run-retention.db.spec.ts`). Two things the document cannot say and this page does: `GET /runs` and `GET /tasks` are documented with their array answer only (so code typed against the earlier contract keeps compiling; the page shapes are the `RunPageResponseDto` and `TaskPageResponseDto` schemas), and error `code`s are prose in each operation's description, not an enumerated schema.
- **The error codes.** Each code in the table was produced against the running API (a real database) with a request made to fail that way, and the code read from the answer. That corrected one entry of this page: a task that is not the caller's answers `404 NOT_FOUND` on these routes, not a task-specific code.
- **Against the running API.** The acceptance run of #432 drove these routes through the web app against a real database (create with schedules, pause and resume, run with a policy, the paged runs list with 5,000 runs, delete by filter in the request and as a queue job, the retention preview and apply, the Home summary).
