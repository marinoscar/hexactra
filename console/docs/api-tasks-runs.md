# Tasks, schedules, runs and Home: the API behind the console's pages

Every route epic E32 (#418) added or changed, with its parameters, answers, permission and error codes, and what the other clients (CLI, TUI, MCP, SDK) do with it. All routes are under `/api`, answer `{ "data": … }`, need a signed-in caller (an access token or a personal access token in `Authorization: Bearer`) and only ever read or change the caller's own data: another user's task or run answers `404`. An error is `{ statusCode, code, message, details? }`; `code` is stable.

The per-endpoint reference is the OpenAPI document the API serves (`/api/docs`, `/api/openapi.json`). This page and that document are checked against each other: see [How this page was checked](#how-this-page-was-checked). Runs have their own, longer reference in [runs.md](runs.md); the pages that use these routes are described in [README, Using the console](../README.md#using-the-console).

## Every route

| Route | What it does | Permission | Answers | Error codes |
|---|---|---|---|---|
| `GET /runs` | The runs, newest first. `envelope=1` answers a page `{ items, nextCursor }`; without it, the array it always returned. Filters: `status`, `state`, `taskId`, `trigger`, `from`, `to`, `q`, `stopReason`, `policyId`; paging: `cursor`, `limit`, `order` ([runs.md](runs.md#get-apiruns)) | `runs:read` | `200` | `400 BAD_REQUEST`, `INVALID_FILTER`, `INVALID_CURSOR` |
| `GET /runs/counts` | How many runs match the same filters (all but `status` and `state`): `{ total, live, byStatus, costUsd, costKnown }` ([runs.md](runs.md#get-apirunscounts)) | `runs:read` | `200` | `400 BAD_REQUEST`, `INVALID_FILTER` |
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
| `GET /tasks/:id/stats` | The task's run statistics for `days` (7 to 90, default 30) | `runs:read` | `200 { days, timezone, totals, avgDurationSeconds, p95DurationSeconds, avgSteps, avgCostPerSuccessUsd, series, stopReasons }` | `400 BAD_REQUEST`, `404 NOT_FOUND` |
| `POST /schedules/preview` | What `{ cron, timezone?, count? }` means and when it fires next. Saves nothing | `tasks:read` | always `200`: `{ valid: true, cron, timezone, description, next, intervalSeconds }` or `{ valid: false, code, message }` | inside the answer: `INVALID_CRON`, `INVALID_TIMEZONE`, `CRON_TOO_FREQUENT` |
| `GET /schedules/defaults` | The time zone a new schedule gets: `{ timezone, source }` | `tasks:read` | `200` | |
| `GET /home/summary` | The Home page in one read | a sign-in; each block needs its own permission | `200 { generatedAt, timezone, needsYou, liveRuns, upcoming, recentRuns, week, fleet, counts }` | |

Changed, not new: `POST /schedules` takes `timezone` as optional (the [time zone rule](#the-time-zone-rule)), every schedule answer carries a `description` in words, and a task holds at most 10 schedules (`409 SCHEDULE_LIMIT`). `maxSteps`, `maxMinutes` and `model` on a task are deprecated: a run's limits and models come from its [agent policy](../README.md#agent-policies), and the web app never sends them.

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

## Runs

The list, its filters and cursor, the counts, deleting and retention are in [runs.md](runs.md). In short:

- **A page.** `GET /api/runs?envelope=1&limit=50` answers `{ items, nextCursor }`; pass `nextCursor` back as `cursor` with the same filters; `null` is the end. A row never carries `transcript` or `policySnapshot`.
- **Delete by filter.** `POST /api/runs/delete` with `{ filter, expectedCount }`: the filter is the list's own, live statuses are never matched, "all my finished runs" needs `expectedCount`, and a count that moved by more than 5 % answers `409 COUNT_CHANGED` with `details { matched, expectedCount }`. Up to 500 matches are deleted in the request; more answer `202` and the queue job `browser.runs.delete` deletes them.
- **Retention.** The rule is the `runs` namespace of the user's settings (`PATCH /api/user-settings`); the three routes above read it, preview limits and apply it. The preview takes its limits as parameters: `GET /api/runs/retention/preview` with none answers for "no limit at all", whatever rule is saved.

## Home

**`GET /api/home/summary`** needs a sign-in and no permission of its own. A block is built only when the caller holds its permission and is `null` otherwise, never an empty list: `needsYou`, `liveRuns`, `recentRuns` and `week` need `runs:read`; `upcoming` needs `tasks:read`; `fleet` needs `fleet:read`; `counts.tasks` and `counts.runs` are `null` without theirs. Limits: 3 questions, 6 live runs (running first), 5 firings, 8 finished runs, 6 machines; `needsYou.count` and `liveRuns.count` are the real totals. The response never carries a question's answer, a secret, a transcript, a policy snapshot, an action's arguments or a viewer URL: a live run's `activity` is its phase, the action's name and the reason only. `budgetPercent` is the highest percent among the run's limited budgets, from the run's stored budget. The week is bucketed in the profile time zone (else the `X-Time-Zone` header, else UTC). The fleet comes from the fabric with a 1.5 second limit: a fabric that is slow or down answers `fleet.stale: true` with the last hosts read, and never fails the request. It costs six SQL statements whatever the account holds, and records `app.home.summary.duration`.

## Client parity

What each client can do with the capabilities of E32. "No" is a decision, with its reason; nothing here is left for later. The machine-checked form of this table is [packages/shared/capabilities.json](../packages/shared/capabilities.json): each surface's tests fail when a tool or command it names is missing.

| Capability | MCP (`apps/api/src/mcp/mcp.tools.ts`) | CLI and TUI (`apps/cli`) | SDK (`@hexactra/console-sdk`) |
|---|---|---|---|
| A page of runs, filtered | **Implemented.** `runs_list` takes `status`, `task_id`, `stop_reason`, and `limit` / `cursor` for a page (`{ items, nextCursor }`); with neither it answers the list it always did | **Implemented.** The TUI Runs screen reads a page and `m` loads the next one. `hexactra runs list` keeps printing the most recent runs (`--status`): **decided: no** paging flags, because a script that needs more reads the REST route with `hexactra api` | **Implemented.** `hx.runs.list({ …filter, cursor, limit })` answers a `RunPage` |
| Delete runs | **Decided: no tool.** An agent must not erase its own history: the runs are the user's record of what the agent did, and the audit trail of an agent with the user's full powers. A test fails if a tool named like one appears | **Implemented.** `hexactra runs delete <id>` and `runs delete --older-than <days>`; both ask first (`--yes` for a script). The TUI: **decided: no**, it is for watching and answering | **Implemented.** `hx.runs.delete(id)`, `hx.runs.deleteMany({ ids } \| { filter, expectedCount })` |
| Retention rule | **Decided: no tool**, for the same reason as deleting | **Decided: no** command for the standing rule: it is a setting with a preview, made on its page. `runs delete --older-than` is the one-off form | **Decided: no** helper: three plain routes, typed through `hx.api` (`RetentionSettingsResponseDto`, `RetentionPreviewResponseDto`, `RetentionApplyResponseDto`) |
| Pause and resume a task's schedules | **Implemented.** `task_pause`, `task_resume` | **Implemented.** `hexactra tasks pause\|resume <id>` (one schedule: `schedules pause\|resume`) | **Implemented.** `hx.tasks.pauseSchedules(id)`, `hx.tasks.resumeSchedules(id)` |
| Schedule preview | **Implemented.** `schedule_preview` (read-only) | **Decided: no.** `schedules create` reports the same errors when it saves, and prints the next firing | **Implemented.** `hx.schedules.preview({ cron, timezone?, count? })` |
| Create a task with schedules | **Implemented.** `task_create` takes `schedules[]` (`cron`, `timezone`, `enabled`, `policy_id`) | **Decided: no** `--schedule` flag: `tasks create` then `schedules create` are two short commands, and a failed second one leaves a task that can be scheduled again | **Implemented.** `hx.tasks.create({ …, schedules })` answers the task with its summary |
| Replace a task's schedules (`PUT`) | **Decided: no tool.** It deletes the schedules it is not given, which is too easy for an agent to get wrong; `schedule_create` adds one | **Decided: no**: `schedules create\|pause\|resume\|delete` cover it one schedule at a time | **Decided: no** helper: `hx.api.PUT('/api/tasks/{id}/schedules', …)` is typed |
| Task statistics | **Decided: no.** An agent reads the runs themselves (`runs_list` with `task_id`); the statistics are a chart for a person | **Decided: no**, same reason | Typed through `hx.api` (`TaskStats`) |
| Home summary | **Decided: no.** An agent reads each part with its own tool (`runs_list`, `inbox_list`, `schedules_list`, `hosts_list`) | **Decided: no.** The CLI lists each part (`runs list`, `inbox list`, `schedules list`, `fleet hosts`) and the TUI opens on its own screens | Typed through `hx.api` (`HomeSummaryResponseDto`); no helper, it is one call |

Every MCP change has a test in `apps/api/test/mcp.db.spec.ts` ("MCP tasks, schedules and the paged run list"), the CLI's are in `apps/cli/src/runs.test.ts`, and the SDK's example (`packages/sdk/src/examples/tasks.ts`) calls each new helper against a running API in `apps/api/test/sdk.db.spec.ts`.

One known difference, kept on purpose: `hexactra schedules create` sends `--tz`, which defaults to the terminal's time zone, while the web, MCP and the SDK leave the zone out and get the profile's. Someone at a terminal expects the terminal's clock; pass `--tz` to choose.

## How this page was checked

- **Against the OpenAPI document.** `packages/sdk/openapi.json` is the document the API serves: `apps/api/test/sdk.db.spec.ts` ("ships the OpenAPI document the API serves") fails when the two differ. Every route in the table above was read from that file (path, method, query parameters, the permission in its description, the answer's schema, the status codes) and compared with this page.
- **What the comparison found.** The document called the three limits of `GET /runs/retention/preview` required while the route accepts none; the schema was corrected (the route's behaviour did not change) and a test pins it (`run-retention.db.spec.ts`). Two things the document cannot say and this page does: `GET /runs` and `GET /tasks` are documented with their array answer only (so code typed against the earlier contract keeps compiling; the page shapes are the `RunPageResponseDto` and `TaskPageResponseDto` schemas), and error `code`s are prose in each operation's description, not an enumerated schema.
- **The error codes.** Each code in the table was produced against the running API (a real database) with a request made to fail that way, and the code read from the answer. That corrected one entry of this page: a task that is not the caller's answers `404 NOT_FOUND` on these routes, not a task-specific code.
- **Against the running API.** The acceptance run of #432 drove these routes through the web app against a real database (create with schedules, pause and resume, run with a policy, the paged runs list with 5,000 runs, delete by filter in the request and as a queue job, the retention preview and apply, the Home summary).
