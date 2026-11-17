# Runs: list, filter, search, count and delete

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

A list parameter (`status`, `trigger`, `stopReason`) is repeated (`status=failed&status=cancelled`) or comma-separated (`status=failed,cancelled`).

Errors are `400` with a typed `code`:

| Code | When |
|---|---|
| `BAD_REQUEST` | An unknown status, trigger or stop reason, a malformed date or id, `limit` out of range. `details.issues` names the parameter. |
| `INVALID_FILTER` | `status` together with `state`, or `from` after `to`. |
| `INVALID_CURSOR` | A cursor that no page returned. |

### What a list row carries

A row is the run as `GET /api/runs/{id}` returns it, without its steps, plus `taskName` (null for a run without a task). It includes `startedAt`, `finishedAt`, `policy { id, name, version, source, builtin }`, `costUsd`, `costKnown`, `modelCalls`, `stopReason` and `currentTier`.

A list row never carries the run's transcript or its policy snapshot, so 50 rows stay well under 100 KB. `budget` is present while a run is live and `null` on a finished run: read a finished run's budget from `GET /api/runs/{id}`.

## `GET /api/runs/counts`

The number of runs per status, and what they cost, in one query:

```json
{ "data": { "total": 5000, "live": 0, "byStatus": { "queued": 0, "running": 0, "waiting_human": 0, "succeeded": 3433, "failed": 1139, "cancelled": 428 }, "costUsd": 512.4, "costKnown": false } }
```

It takes the same filter parameters as the list except `status` and `state` (the counts are per status): `taskId`, `trigger`, `from`, `to`, `q`, `stopReason`, `policyId`. `live` is `queued + running + waiting_human`. `costUsd` is the sum over the counted runs, `null` when none of them made a model call; it is a lower bound ("at least") while `costKnown` is false.

## Deleting runs

Deleting is permanent: the run, its steps, its questions and the stored screenshots of its steps. There is no trash and no undo. All three forms need the `runs:delete` permission (contributors and organization admins have it; a viewer does not). It is separate from `runs:write`, so a role can start and answer runs without being able to erase history.

**A live run is never deleted.** A run that is `queued`, `running` or `waiting_human` must be cancelled first (`POST /api/runs/{id}/cancel`). The status is checked again inside the transaction that deletes.

**Deleting runs also removes their cost and stop-reason history from task spend and from alert counts.** A task's `spend30d` and the run-budget, stalled-runs and expensive-run alerts are computed from run rows, so they drop when the rows go. The AI usage report (**Administration → AI Usage**, `/admin/settings/ai/usage`) is not affected: it reads the AI gateway's own records (`ai_usage_events`), priced by the same table, and never the `runs` table.

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

`POST /api/runs/delete` documents both answers: `RunsDeletedResponseDto` (200) and `RunsDeleteQueuedResponseDto` (202); its body is `DeleteRunsDto`. The CLI and the SDK's helper methods do not wrap the delete routes yet (call them through `hx.api`).
