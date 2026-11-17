# Runbook: run retention

How to check that old runs are being removed, and how to remove them without waiting for the night. What the rule is and how a user sets it: [README, Run history and retention](../../README.md#run-history-and-retention). The API: [runs.md](../runs.md#retention).

## What runs, and when

| Job type | Label under Administration → Jobs | Started by | Covers |
|---|---|---|---|
| `browser.runs.retention` | Delete runs past their retention | a timer at 03:20 server time, every night | every user with at least one finished run |
| `browser.runs.retention.apply` | Apply run retention for one user | **Apply now** on Settings → Run history, or `POST /api/runs/retention/apply` | the caller's runs only |

- The timer only puts the job on the queue. If a nightly job is still pending or running at 03:20, that night's tick is skipped.
- Each job may run for 15 minutes and is tried twice.
- A user's nightly share is at most 20,000 runs. The rest goes the next night, and the API log says so (`reached the nightly cap`).
- A second pass the same night deletes nothing: it is safe to run again.

## Check it

1. **Administration → Doctor**, check **Run retention** (`runs.retention`).
   - `pass`: when the nightly job last succeeded and how many runs it deleted.
   - `warn`: it has not succeeded in 48 hours, or it has never succeeded.
   - `skip`: it has not run yet (a new deployment before its first 03:20).
2. **Administration → Jobs**, filter by type `browser.runs.retention`: the last jobs, their status and error.
3. **The API log.** One line per pass:

   ```
   job <id>: runs.retention users=14 deleted=3887 skipped=12 noticed=0 failed=0 ms=575
   ```

   - `users`: users with at least one finished run.
   - `deleted`: runs deleted in this pass.
   - `skipped`: users with nothing to delete, or whose rule keeps everything.
   - `noticed`: users on the default rule who were only told tonight (see below).
   - `failed`: users whose pass failed. Each has its own line: `retention failed for user <id> (<error name>); moving on`.

   Each user with deletions also has the delete service's line: `runs.delete user=… mode=retention matched=… deleted=… job=…`.
4. **Telemetry.** The counter `app.runs.deleted` with `mode="retention"`.
5. **The audit log.** One `runs.retention_completed` event per nightly pass (the totals above), and one `runs.deleted` event per user with `mode: retention`.

## The job failed

The job fails only when more than half the users failed. Deletions already made stay made.

1. Read the job's error under Administration → Jobs, and the `retention failed for user` lines in the API log.
2. Fix the cause (usually the database being unreachable part of the night).
3. Retry the failed job from Administration → Jobs, or wait for the next night.

One user failing every night does not fail the job. Look for that user's line in the log. A stored setting that is not valid is not a failure: each invalid field is read as its default.

## A user says runs were deleted, or were not

- **Nothing was deleted for a new rule.** A user who never saved a rule is on the default (90 days). The first night there is something to delete, the job deletes nothing: it sends that user one notification ("Old runs will be removed") and starts deleting the next night. `noticed` in the log line counts them.
- **A run is older than the limit and still there.** Retention never deletes a live run, a run with an unanswered question, or a run that finished less than 24 hours ago. That floor is longer when an enabled alert rule (Administration → Alerts) of the kinds *Run budget exceeded*, *Runs stalling* or *Expensive run* looks further back: the longest `windowHours` among them. `GET /api/runs/retention` returns the floor in use as `floorHours`.
- **Runs were deleted although the user keeps them forever.** The deployment limit applies: Administration → Browser agent → **Run history limit**. It cuts every user's rule to that many days and does not rewrite their setting.

## Run it by hand

- **For one user:** that user opens Settings → Run history and presses **Apply now**, or calls:

  ```bash
  curl -X POST https://<console>/api/runs/retention/apply -H "Authorization: Bearer <token>"
  # 202 { "data": { "jobId": "…" } }
  ```

  It applies their saved rule at once, without the first-night notice. It needs `runs:delete`. To see what it would delete first: `GET /api/runs/retention/preview?keepDays=30&keepPerTask=50`.
- **For everyone:** there is no route that starts the nightly job on request. Wait for 03:20, or retry a failed nightly job from Administration → Jobs.

## Set or lift the deployment limit

Administration → Browser agent → **Run history limit** (`system_settings:write`): a number of days, or **No limit**. It takes effect at the next nightly pass and at the next **Apply now**. Users see "Capped at N days by your administrator" on their Run history page. Through the API: `PATCH /api/system-settings` with `{ "runs": { "maxKeepDays": 180 } }` (`null` lifts it).
