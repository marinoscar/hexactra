# Runs: list, filter, search and count

How a client reads a user's runs when there are thousands of them. Every answer is inside the platform's `{ data }` envelope, and both routes need the `runs:read` permission. A user only ever sees their own runs.

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

## Sample data for development

```bash
npm run seed:runs --workspace=api -- --user you@example.test --count 5000
```

Creates five tasks ("Seed task 1" to "Seed task 5", reused on the next call) and that many finished runs for an existing user: mixed statuses and stop reasons, spread over 120 days, each with 3 to 10 steps, a cost and an agent policy (mostly `builtin:balanced`). It reads the database from `POSTGRES_*` like the `prisma:*` scripts and refuses to run with `NODE_ENV=production`.

## For code in this repository

`runFilterSchema` (`apps/api/src/tasks/runs.schemas.ts`) is the one definition of "which runs", and `runWhere(filter)` (`apps/api/src/tasks/runs.query.ts`) turns it into the database condition. Anything that acts on "the runs this filter shows" builds its condition with `runWhere` and runs it through `prisma.forUser({ userId })`, so a list and an action on it cannot disagree.

## In the OpenAPI document and the SDK

`GET /api/runs` is documented with its array answer, so code typed against the earlier contract keeps compiling. The page shape is the `RunPageResponseDto` schema (`components['schemas']['RunPageResponseDto']` in `@hexactra/console-sdk`): cast the data to it when you send `envelope=1`. The counts are `RunCountsResponseDto`.
