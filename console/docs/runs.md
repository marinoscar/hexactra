# Runs: list, filter, search, count, delete and retention

How a client reads a user's runs when there are thousands of them, and how it deletes them. Every answer is inside the platform's `{ data }` envelope. The two read routes need the `runs:read` permission; [deleting](#deleting-runs) needs `runs:delete`. A user only ever sees, and deletes, their own runs.

## `GET /api/runs`

Without `envelope` the answer is an array: the newest `limit` runs (default 50, at most 200). This is the shape the CLI, the MCP `runs_list` tool and earlier SDK code read.

With `envelope=1` the answer is one page:

```json
{ "data": { "items": [ { "id": "…", "status": "failed", "taskName": "Check fares", "…": "…" } ], "nextCursor": "eyJjIjoi…" } }
```

To read the next page, send the same request with `cursor=<nextCursor>`. `nextCursor` is `null` on the last page, also when the result is empty.

**The cursor is opaque. Do not parse it, build it or store it for long.** It marks a position in one user's list under one order; send it back unchanged, with the same filters and the same `order`. Anything else answers `400 INVALID_CURSOR`: start again from the first page.

Paging is by keyset on `(createdAt, id)`, so a page costs the same at any depth, and a run created while you page never shifts the rows you have not read yet.

### Parameters

All of them work with and without `envelope`.

| Parameter | Value | Meaning |
|---|---|---|
| `envelope` | `1` | Answer `{ items, nextCursor }` instead of an array. |
| `cursor` | string | The previous page's `nextCursor`. |
| `limit` | 1 to 100 with `envelope` (1 to 200 without), default 50 | Rows per page. |
| `order` | `desc` (default) or `asc` | By creation time, then id. `desc` is newest first. |
| `status` | one or more of `queued`, `running`, `waiting_human`, `succeeded`, `failed`, `cancelled` | Any of them. |
| `state` | `live` or `finished` | `live` = `queued`, `running`, `waiting_human`; `finished` = `succeeded`, `failed`, `cancelled`. Not together with `status`. |
| `taskId` | a task's UUID, or `none` | `none` is the runs without a task (ad-hoc and external runs). A task that is not yours is an empty list. |
| `trigger` | one or more of `manual`, `schedule`, `api`, `mcp`, `external` | Any of them. |
| `from`, `to` | ISO 8601 date-time with a zone (`2026-06-01T00:00:00Z`) | On the creation time: `from` inclusive, `to` exclusive. |
| `q` | 1 to 200 characters | Case-insensitive substring of the goal. Plain text: `%` and `_` are not wildcards. Empty is ignored. |
| `stopReason` | one or more stop reasons (`finished`, `budget_cost`, `stalled`, …), or `budget` | Any of them. `budget` is every `budget_*` reason. |
| `policyId` | an agent policy id: a UUID or `builtin:<key>` | The runs that ran under that policy. |
| `origin` | one or more of `web`, `android`, `cli`, `api`, `mcp`, `schedule`, `system` | Where the runs were started from (#464; see [Who started a run](#who-started-a-run)). |
| `clientId` | an AI app's OAuth client id (`client.id` of a run, `clientId` of `GET /api/connected-apps`) | The runs that app started. |

A list parameter (`status`, `trigger`, `stopReason`, `origin`) is repeated (`status=failed&status=cancelled`) or comma-separated (`status=failed,cancelled`).

Errors are `400` with a typed `code`:

| Code | When |
|---|---|
| `BAD_REQUEST` | An unknown status, trigger or stop reason, a malformed date or id, `limit` out of range. `details.issues` names the parameter. |
| `INVALID_FILTER` | `status` together with `state`, or `from` after `to`. |
| `INVALID_CURSOR` | A cursor that no page returned. |

### What a list row carries

A row is the run as `GET /api/runs/{id}` returns it, without its steps, plus `taskName` (null for a run without a task). It includes `startedAt`, `finishedAt`, `policy { id, name, version, source, builtin }`, `costUsd`, `costKnown`, `modelCalls`, `stopReason` and `currentTier`.

A list row never carries the run's transcript or its policy snapshot, so 50 rows stay well under 100 KB. `budget` is present while a run is live and `null` on a finished run: read a finished run's budget from `GET /api/runs/{id}`.

### Who started a run

Every run carries `origin` and `client` (#464). The server sets them from the request's credential, **never** from a request body or a header a network caller sends (a `clientName` or `origin` in a body is ignored):

| `origin` | Set when |
|---|---|
| `web` | A signed-in session in the console (the Runs page, a task, Home, a chat). |
| `android` | The Android app's own client (a User-Agent with `HexactraAndroid`). The Android app's web view is Chrome and reads as `web`. |
| `cli` | The CLI (`hexactra/<version>` User-Agent). |
| `api` | Any other personal access token caller: the SDK, a script, an agent framework over REST. |
| `mcp` | A call through `POST /api/mcp`: an AI app signed in with OAuth, or any MCP client with a personal access token or a session. |
| `schedule` | A task's schedule. |
| `system` | A worker node or the server itself. |

`client` is `{ id, name, verified }`, or `null` when no AI app started the run:

- An app signed in with **OAuth**: `id` is its OAuth client (`oauth_clients.id`), `name` the client's host at the time (`chatgpt.com`, `claude.ai`; a local app such as Claude Code: its own name), `verified: true`. The run also records the grant (server-side only). An app an administrator removes keeps its name on its runs.
- An MCP client with a **personal access token**: `id: null`, `name` is the MCP `clientInfo.name` it sent (at most 64 characters), `verified: false`. The console shows it with a "?".

Existing runs were backfilled from `trigger` (`manual` and `chat` → `web`, `schedule` → `schedule`, `api` and `external` → `api`, `mcp` → `mcp`). External browser sessions and questions carry the same client fields. A list row carries `origin` and `client`, never the grant or the limits that applied.

## `GET /api/runs/counts`

The number of runs per status, and what they cost, in one query:

```json
{ "data": { "total": 5000, "live": 0, "byStatus": { "queued": 0, "running": 0, "waiting_human": 0, "succeeded": 3433, "failed": 1139, "cancelled": 428 }, "costUsd": 512.4, "costKnown": false } }
```

It takes the same filter parameters as the list except `status` and `state` (the counts are per status): `taskId`, `trigger`, `from`, `to`, `q`, `stopReason`, `policyId`. `live` is `queued + running + waiting_human`. `costUsd` is the sum over the counted runs, `null` when none of them made a model call; it is a lower bound ("at least") while `costKnown` is false.

## Deleting runs

Deleting is permanent: the run, its steps, its questions and the stored screenshots of its steps. There is no trash and no undo. All three forms need the `runs:delete` permission (contributors and organization admins have it; a viewer does not). It is separate from `runs:write`, so a role can start and answer runs without being able to erase history.

**A live run is never deleted.** A run that is `queued`, `running` or `waiting_human` must be cancelled first (`POST /api/runs/{id}/cancel`). The status is checked again inside the transaction that deletes.

**Deleting runs also removes their cost and stop-reason history from task spend and from alert counts.** A task's `spend30d` and the run-budget, stalled-runs and expensive-run alerts are computed from run rows, so they drop when the rows go. The AI usage report (**Administration → AI Usage**, `/admin/settings/ai/usage`) is not affected: it reads the AI gateway's own records (`ai_usage_events`), never the `runs` table.

| Route | Body | Answer |
|---|---|---|
| `DELETE /api/runs/{id}` | none | `204`. `404 RUN_NOT_FOUND` for an id that is not yours (missing or another user's: the two are not told apart). `409 RUN_LIVE` while the run is live. |
| `POST /api/runs/delete` | `{ "ids": ["…"] }`: 1 to 500 unique ids | `200 { deleted, costUsd, skippedLive, notFound }` |
| `POST /api/runs/delete` | `{ "filter": { … }, "expectedCount": 120 }` | `200 { deleted, costUsd, skippedLive, notFound }` when at most 500 finished runs match; else `202 { jobId, matched, costUsd }` |

Send exactly one of `ids` or `filter`; neither, both, or an unknown key is a `400`.

- **`ids`.** Live runs are skipped and listed in `skippedLive`; ids that are not your runs are listed in `notFound`. Neither fails the call.
- **`filter`** is the list's filter: `status`, `state`, `taskId`, `trigger`, `from`, `to`, `q`, `stopReason`, `policyId` ([parameters](#parameters)), as JSON (a list is an array or a comma-separated string). The server always narrows it to the finished statuses (`succeeded`, `failed`, `cancelled`), so it deletes exactly what `GET /api/runs` lists for the same filter with `state=finished`. A live status in the filter is ignored, not an error. A misspelt filter key is a `400`, never ignored.
- **`expectedCount`** is the number of runs you expect to delete: the count you showed in your confirmation. When the finished runs that match differ from it by more than 5 %, nothing is deleted and the answer is `409 COUNT_CHANGED` with the real count in `details.matched`. Read the count from `GET /api/runs/counts` (the sum of `byStatus.succeeded`, `failed` and `cancelled`).
- **A filter that selects every finished run** (`{}`, `{ "state": "finished" }` or all three finished statuses with nothing else) is accepted only with `expectedCount`.
- **`costUsd`** is the recorded model spend of the deleted runs (of the matched runs in a `202`); `null` when none of them made a model call.

```json
{ "data": { "deleted": 120, "costUsd": 14.2, "skippedLive": [], "notFound": [] } }
```

### More than 500 runs: a queue job

When a filter matches more than 500 finished runs the request deletes nothing and answers `202`:

```json
{ "data": { "jobId": "0b0c…", "matched": 1200, "costUsd": 96.4 } }
```

The `browser.runs.delete` job ("Delete runs by filter" under **Administration → Jobs**) deletes them 200 at a time. It only deletes runs created at or before the request, so a run that starts afterwards is never swept in. If it fails part-way the batches already deleted stay deleted and the retry (three attempts) continues. The same request sent again while the job is pending returns the same `jobId`. To see when it is done, read `GET /api/runs/counts` with the same filter.

### What else changes

- A schedule whose last run was deleted forgets it (`lastRunId` becomes `null`). The deleted run's failure is then not counted towards the schedule's "failing" notice.
- Notifications that link to a deleted run stay; the run page answers "not found".
- A policy's usage counts tasks and schedules, not runs: deleting runs neither blocks nor unblocks deleting a policy.
- Each call writes one line to the API log (`runs.delete user=… mode=single|ids|filter matched=… deleted=… skippedLive=… job=… ms=…`), adds to the `app.runs.deleted` counter (label `mode`) and writes an audit event (`runs.deleted`, or `runs.delete_queued` for a `202`) with the counts and the names of the filter keys. None of them holds goal text, results or step content.
- If a screenshot cannot be removed from object storage, the run is deleted all the same and the API logs how many objects were left.

## Retention

Each user has a retention rule; a nightly job deletes the finished runs outside it. What the rule means, its defaults and what is never deleted: [README, Run history and retention](../README.md#run-history-and-retention). Operating it: [runbooks/run-retention.md](runbooks/run-retention.md). All three routes need `runs:delete` and only ever touch the caller's runs.

| Call | Answer |
|---|---|
| `GET /api/runs/retention` | `200 { keepDays, keepPerTask, keepFailedDays, saved, maxKeepDays, floorHours }` |
| `GET /api/runs/retention/preview?keepDays=&keepPerTask=&keepFailedDays=` | `200 { wouldDelete, finished, oldestKept, costUsd, maxKeepDays, capped, floorHours }` |
| `POST /api/runs/retention/apply` | `202 { jobId }` |

- **Reading the rule.** `saved` is `false` while the user never saved one: the values are then the defaults (`keepDays: 90`, the others `null`). `maxKeepDays` is the deployment limit (`null`: none) and `floorHours` the age below which no run is deleted.
- **Saving the rule.** It is the `runs` namespace of the user's settings: `PATCH /api/user-settings` with `{ "runs": { "keepDays": 30, "keepPerTask": 50, "keepFailedDays": null } }`. `keepDays` and `keepFailedDays` are whole numbers from 1 to 3650 or `null`; `keepPerTask` is 1 to 10000 or `null`. `{ "runs": null }` goes back to the defaults.
- **The preview.** A limit left empty or out means none. It counts with the query the job uses, applies the deployment limit to the values given (`capped` is `true` when that shortened one) and deletes nothing. `costUsd` is the recorded spend of the runs that would go, `null` when none of them made a model call. `oldestKept` is when the oldest run that would remain finished.
- **Apply now.** Enqueues `browser.runs.retention.apply` for the caller, which applies their **saved** rule. Sent again while that job is pending, it answers the same `jobId`.
- **The deployment limit.** The `runs` namespace of the system settings: `PATCH /api/system-settings` with `{ "runs": { "maxKeepDays": 180 } }` (`system_settings:write`).

The nightly job (`browser.runs.retention`, 03:20 server time) reads each user's rule, applies the limit and deletes through `RunDeleteService.deleteByIds` with `mode: 'retention'`, at most 20,000 runs per user per night.

## What a run records

Every run keeps a trace a person can follow afterwards (#541): its steps (`run_steps`), the questions it asked and the answers given, the owner's guidance from the chat, and **masked screenshots of the key moments**. `GET /api/runs/{id}` returns it; the run's live stream sends the same step fields.

| Step | What it is | An action? |
|---|---|---|
| `action`, `handoff`, `finish`, `error`, `note` | What the agent did, asked, or ended with | yes (counts toward `stepCount` and the actions budget) |
| `handoff` with `action: "answered"` | The owner's answer: "The owner allowed it", "declined", "provided the sign-in", or "answered: …" (masked). A secret, a sign-in or a withheld value never appears. | no |
| `guidance` | A message the owner typed in the chat while the run worked (#490), masked | no |
| `routing` | A tier change or a provider fallback (#405) | no |
| `end` | The closing step; it holds the final screen | no |

**Questions.** A step that asked a person carries `questionId`, and the API adds `question: { id, kind, input, prompt, options, risk, status, answer: { outcome, value?, valueWithheld, channel, answeredAt } | null }`. `prompt`, the option labels and `value` are masked when they are read; `value` is absent for a secret, a sign-in or a withheld answer.

**Screenshots: the key moments.** A masked picture is stored when the agent asks a person (`question`; for a confirmation, `before_confirmed`: the screen the owner was asked about), after a confirmed action succeeded (`after_confirmed`), when a stall is signalled (`failure`, on the latest step), and at the end of every run (`final`, on the `end` step). Expect 5 to 15 per run; at most 40, past which only `before_confirmed`, `after_confirmed` and `final` are kept.

- **Masked at capture, in the page.** The trace asks the fabric for `{ type: "screenshot", mask: true }` (#539): the extension covers password and code fields and text that looks like a card, account or identity number before the picture is taken, so no unmasked trace image exists anywhere. It never reuses the model's own (unmasked) screenshot. A page that cannot be masked gives no picture at all, never an unmasked one.
- **Never during a secret.** No picture is taken for a `secret` or `credentials` request (the fabric refuses them then anyway, #525).
- **Best effort.** A capture is bounded to 10 seconds and is not an action: it never counts toward `stepCount`, the actions budget or the stall detector. A step without its picture says why in `screenshotNote`: `no_storage` (the storage slice is off), `capped`, `masked_failed` or `unavailable`.
- **Where.** Object storage, key `runs/<userId>/<runId>/<seq>-<moment>.jpg` (prefix `run-traces`), about 150 kB each. Steps return `hasScreenshot` and `screenshotMoment`, never the key. The picture: `GET /api/runs/{id}/steps/{seq}/screenshot` (`runs:read`, the owner only: `404` for another user's run, a missing step or a step without a picture; `Cache-Control: private, max-age=3600`).
- **Removed with the run** by a delete and by the nightly retention; a storage failure never keeps a run.
- **Metrics.** `app.runs.trace_screenshots` (labels `moment`, `result`: `stored`, `skipped`, `failed`) and `app.runs.trace_screenshot_bytes`. The Doctor's `runs.trace_storage` warns when storage is off. No image, key or prompt text is ever logged.

## What is masked

A run's trace, its JSON export, its PDF report and the extension's screenshot masking hide sensitive text with one pattern table, so they cannot disagree. The table is `console/packages/shared/sensitive-patterns.js` (`@app/shared/sensitive-patterns`, version `SENSITIVE_PATTERNS_VERSION`); the API applies it with `maskSensitive(text)` and `maskValue(value)` (`apps/api/src/tasks/mask.ts`), and the extension reads a generated copy, `packages/contracts/sensitive-patterns.json` at the repository root (`node scripts/gen-sensitive-patterns.mjs` writes it; CI fails when it is stale). Masking hides text in what is shown and exported; it does not change what the model sees during a run.

The patterns are applied in this order, most specific first. A pattern with a check masks a match only when the checksum passes; a number that fails it can still be masked by a later pattern (a 9-digit number with no banking word nearby is masked by `digits`).

<!-- masked-patterns:start -->
| Order | Pattern | What matches | Check | Shown as |
|---|---|---|---|---|
| 1 | `token` | The console's and the fabric's credentials (`pat_`, `oat_`, `hxs_`, …), `Bearer …` values, JWTs, and `sk-…`, `key-…` style API keys | — | `[redacted token]` |
| 2 | `urlSecret` | The query and fragment of an `http(s)` URL (they can carry tokens); origin and path stay | — | `https://example.test/path (query removed)` |
| 3 | `email` | An email address | — | `o•••@example.test` |
| 4 | `iban` | An IBAN: country code, two check digits, 11 to 30 letters and digits (grouped by four or not), passing the mod-97 check | `mod97` | `GB•• •••• 3456` |
| 5 | `card` | A payment card number: 13 to 19 digits, plain or in groups split by spaces or dashes, passing the Luhn check | `luhn` | `•••• 4242` |
| 6 | `ssn` | A US Social Security number `ddd-dd-dddd`, and 9 digits after the words SSN or Social Security | — | `•••-••-6789` |
| 7 | `routing` | A US routing number: 9 digits passing the ABA checksum, after the words routing, ABA or RTN | `aba` | `•••••6789` |
| 8 | `account` | An account number: 6 to 17 digits after the words account, acct, checking, savings or IBAN, or after a "#" | — | `••••0659` |
| 9 | `phone` | A phone number: US forms (`(555) 123-4567`, `555-123-4567`, `+1 555 123 4567`) and international forms with a leading `+` | — | `•••-•••-6020` |
| 10 | `digits` | Any other run of 9 or more digits | — | `••••1234` |
<!-- masked-patterns:end -->

- Text a page already shortened, such as "checking ending 0659" or "phone ending 6020", is left as it is.
- Dates, times, prices, step numbers, CSS selectors and ids, UUIDs and run ids, and pixel sizes are not masked.
- **Names, addresses, balances and amounts are not patterns** and are not masked. Reports therefore say "masked", never "anonymised".
- Masking is deterministic and idempotent: masking masked text changes nothing.

The table above is generated from the pattern table; after changing a pattern (and bumping `SENSITIVE_PATTERNS_VERSION`), rewrite it and the extension's copy:

```bash
cd console/apps/api && UPDATE_MASK_DOCS=1 npx jest --config ./test/jest.config.js mask
node scripts/gen-sensitive-patterns.mjs   # from the repository root
```

## Sample data for development

```bash
npm run seed:runs --workspace=api -- --user you@example.test --count 5000
```

Creates five tasks ("Seed task 1" to "Seed task 5", reused on the next call) and that many finished runs for an existing user: mixed statuses and stop reasons, spread over 120 days, each with 3 to 10 steps, a cost and an agent policy (mostly `builtin:balanced`). It reads the database from `POSTGRES_*` like the `prisma:*` scripts and refuses to run with `NODE_ENV=production`.

## For code in this repository

`runFilterSchema` (`apps/api/src/tasks/runs.schemas.ts`) is the one definition of "which runs", and `runWhere(filter)` (`apps/api/src/tasks/runs.query.ts`) turns it into the database condition. Anything that acts on "the runs this filter shows" builds its condition with `runWhere` and runs it through `prisma.forUser({ userId })`, so a list and an action on it cannot disagree.

`RunDeleteService` (`apps/api/src/tasks/run-delete.service.ts`, exported by `TasksModule`) is the one place runs are deleted. `deleteMatching(userId, filter, { createdAtOrBefore?, mode? })` deletes every finished run that matches, with no size limit: call it from a queue job. `deleteByIds(userId, ids, { mode? })` takes any number of ids. Both skip live runs and are safe to repeat. A new table or column that holds a run id must cascade or be cleared there; `apps/api/test/run-relations.spec.ts` fails until it is.

## In the OpenAPI document and the SDK

`GET /api/runs` is documented with its array answer, so code typed against the earlier contract keeps compiling. The page shape is the `RunPageResponseDto` schema (`components['schemas']['RunPageResponseDto']` in `@hexactra/console-sdk`): cast the data to it when you send `envelope=1`. The counts are `RunCountsResponseDto`.

`POST /api/runs/delete` documents both answers: `RunsDeletedResponseDto` (200) and `RunsDeleteQueuedResponseDto` (202); its body is `DeleteRunsDto`. The SDK wraps them as `hx.runs.delete(id)` and `hx.runs.deleteMany(...)`, and a page of runs as `hx.runs.list(...)`; the CLI has `hexactra runs delete <id>` and `runs delete --older-than <days>`. An MCP tool that deletes runs does not exist, on purpose ([api-tasks-runs.md](api-tasks-runs.md#client-parity)).

The retention routes answer `RetentionSettingsResponseDto`, `RetentionPreviewResponseDto` and `RetentionApplyResponseDto`. `RunRetentionService` (`apps/api/src/tasks/run-retention.service.ts`, exported by `TasksModule`) holds the one query that decides which runs a rule deletes; `preview` and `apply` both use it.
