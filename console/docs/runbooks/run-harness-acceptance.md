# Runbook: acceptance run for the run harness (E38)

Epic E38 ([#580](https://github.com/marinoscar/hexactra/issues/580)) made the browser agent's harness something an owner can stop, pause and trust: Stop within seconds ([runs.md, Stop](../runs.md#stop-e381)), Pause and Resume ([runs.md](../runs.md#pause-and-resume-e382)), crash safety ([runs.md](../runs.md#crash-safety-e383)), one OpenTelemetry trace per run job ([operations.md](operations.md#find-a-runs-trace-and-read-it)), a replay suite ([runner.md](../runner.md#testing-a-change-to-the-agent)) and two packages ([runner.md](../runner.md)). The close-out issue ([#589](https://github.com/marinoscar/hexactra/issues/589)) asks for **measurements, not claims**, on the deployed stack with a real model and the residential node. This runbook is the procedure a person follows to take them, and the table to fill in.

**Status when this was written: not performed.** The automated evidence below exists and is green on `main`; none of the measurements in "The nine items" has been taken, because they need the deployed stack, a real model and a node behind a residential connection, which the build environment does not have. Nothing in this file is a measured number: the results table is empty on purpose. Fill it in, paste it into [#650](https://github.com/marinoscar/hexactra/issues/650) (the issue that tracks taking the measurements) and into #589, and leave a failing item as a failing item.

## What the automated tests already prove, and what they cannot

| # | Item | Automated evidence on `main` | What it cannot show |
|---|---|---|---|
| 1 | Stop latency, ten Stops at varied moments | `apps/api/test/runner-stop.db.spec.ts`: the third action of a five-action chunk is not sent when Stop comes after the second; a model call in flight is aborted and the run ends within 2 s; a model call that ignores the signal ends the run as it returns and no tool of its answer runs; a `wait_for` of 15 s ends within 2 s; Stop from another process (the flag poll, no event) ends within 3 s; a run waiting for a person is cancelled in the same request; Stop during a hop delay and during a wrap-up. `apps/api/test/stop-signal.spec.ts`. The metric `app.runs.stop_latency_ms` and its log line are asserted in the same spec. | Latency against a real provider's abort, a real fabric and a real network |
| 2 | No action after Stop | The first test of `runner-stop.db.spec.ts` (no fabric call after Stop); `packages/hexactra-agent/test/harness.spec.ts` (`executeTool` checks Stop before gating, tracing or executing); the replay suite's invariant `action_after_stop` with the scenario `stop-mid-chunk` and the violation scenario `violations/acts-after-stop` that proves the invariant fires | An action in flight at the moment of Stop on a real browser (the host finishes it) |
| 3 | Pause holds | `apps/api/test/run-pause.db.spec.ts`: later actions of the chunk do not run, the browser session is kept, neither active time nor budgets move while paused, resume reads the memory and takes a fresh look and adds the pause note, no second browser; the scenario `pause-and-resume` and the invariant `action_while_paused` | Ten real minutes on a phone, and the agent really re-reading a real page |
| 4 | Crash before the commit | `apps/api/test/runner-crash.db.spec.ts`: progress saved after every action, reconcile from the step rows, a run killed before the confirmed click continues; the scenario `crash-before-confirmed-click` | A real container restart under a real queue |
| 5 | Crash around the commit | `runner-crash.db.spec.ts`: killed between the intent record and the result, the step is `unknown`, the model is told, the gate asks again; a saved approval does not cover an `unknown` target; killed after the result, the step is `done` and nothing repeats; the scenario `crash-after-confirmed-click` and the invariant `repeat_commit` | A real site and a real button |
| 6 | Two workers | `runner-crash.db.spec.ts`: two jobs for one run, the one that does not hold the run stops without sending or writing; two `advance` calls started together, both finish and exactly one acts per action | Two real API processes on the real queue |
| 7 | Trace | `apps/api/test/agent-trace.db.spec.ts`: the tree (job, chunks, model calls, tool calls, fabric actions, the question), the links between jobs, `runs.trace_id`, and that marker strings typed, read and asked never reach a span, event, link or metric label; nothing recorded with the telemetry slice off | The deployment's own collector and a real run's attributes |
| 8 | Replay suite | `apps/api/test/scenarios.spec.ts` (every scenario, the schema, each invariant broken on purpose) and the CI step `npm run scenarios --workspace=api` of the "Console typecheck, test, build, platform checks" job, which exits 1 when a scenario fails or when none is found: 16 scenarios plus 7 violation scenarios, 23 of 23 passing. `apps/api/test/scenarios-live.spec.ts` proves the live mode's mechanism with a fake provider (the spend cap, the summary, the baseline diff) | **A live-mode summary against a real model**: none exists |
| 9 | Behaviour unchanged | `apps/api/test/runner-characterisation.db.spec.ts` pins, byte for byte, the tools offered, the model input of each round, the fabric actions, the step rows and the final run row, and has not changed except for the deliberate, reviewed additions of the epic; `apps/api/test/context-efficiency.db.spec.ts` | Steps and tokens of a real task before and after, with a real model |
| 10 | After the package extraction (amendment, #614) | `npm run test:packages` runs the harness and toolset tests with no console, database or fabric (`packages/hexactra-agent/test/harness.spec.ts`, `second-host.spec.ts`, `conformance.spec.ts`; `hexactra-browser-agent/test/browser-tools.spec.ts`, the two `imports.spec.ts`), `npm run check:package-pack`, and `apps/api/test/agent-host-conformance.db.spec.ts` runs the host conformance suite over the console's real bindings; all in CI on `main` | Steps and tokens of a real task before and after the extraction |

CI on `main` (workflow "Console CI", job "Console typecheck, test, build, platform checks") runs `build:packages`, `typecheck:packages`, `test:packages`, `check:package-pack`, the typecheck, `npm test`, `npm run scenarios --workspace=api` (the JUnit file `apps/api/test-results/scenarios.xml` is kept as an artifact), the build and `test:db --workspace=api`. The "Console VPS stack" job brings up the console, the fabric and the browser host in Docker and runs `scripts/stack-smoke.sh`; it is a smoke test, not this acceptance run.

## Before you start

You need the deployed stack ([vps-stack.md](vps-stack.md)) at the commit under test, with:

- a real model on the Standard tier (Administration → Browser agent → Model tiers) and prices for it ([operations.md, Model prices](operations.md#model-prices)), so cost is known;
- the residential node connected and healthy (Administration → Machines);
- the telemetry slice on and collection turned on (Administration → Telemetry), with a collector you can search by attribute (items 1 and 7);
- an account with `runs:read`, `runs:write` and `tasks:write`, and a phone signed in to the same console (item 3);
- **a harmless test page you control**, on a host you own, with a "Confirm" button that records the click on the server and shows the count (for example "Confirmed: 1"). It must hold nothing real: no payment, no account. Put its host in the task's allowed sites and turn on **Ask me before purchases and other irreversible steps**. The count on the page is how items 4 and 5 know "exactly once";
- a second page that answers slowly (about 15 s before it shows "Ready"), for the wait in item 1;
- for item 6, two API instances on the same database (`docker compose $F up -d --scale api=2` where the project allows it, otherwise a second console process with the same environment), both claiming `browser.goal.run` jobs.

Two goals are enough: **Goal A** ("Open the test page, read the heading, scroll to the bottom, then press Confirm and tell me the number it shows", with the confirm setting on) and **Goal B** ("Open the slow page and tell me when it says Ready"). Write the exact text you used in the results.

Take the run ids from the run page URL (`/runs/<id>`); every query below is read-only and runs against the console's database (`docker compose $F exec db psql ...`).

## The nine items

### 1. Stop latency (ten Stops)

Start ten runs and press Stop at these moments, reading the moment off the run page's activity bar ("Thinking", "Looking", the action in progress, "Waiting for you"):

| Stops | Moment |
|---|---|
| 3 | During a model call (activity "Thinking") |
| 3 | Between two actions (just after a step lands) |
| 2 | During a wait (Goal B, while it says it is waiting) |
| 2 | While waiting for a person (Goal A, on the confirmation card) |

For each run read the latency three ways and check they agree:

```sql
SELECT id, status, stop_reason, cancel_requested_at, finished_at,
       ROUND(EXTRACT(EPOCH FROM (finished_at - cancel_requested_at)) * 1000) AS stop_ms
FROM runs WHERE id IN ('<id1>', '<id2>' /* ... */) ORDER BY cancel_requested_at;
```

- the API log line `run <id>: Stop took <n> ms (cancelled)`;
- the histogram `app.runs.stop_latency_ms` (label `status`) in Administration → Telemetry.

**Pass:** every one of the ten is **under 3000 ms**. The platform's abort of a model call is available (the runner passes the signal to `AiService.runTools`), so the weaker target ("under the duration of one model call") does not apply; if a Stop that fell on a model call takes about a model call's duration, the abort did not reach the provider: record it as a failure and say so. A Stop that lands while an action is in flight is a different case: the fabric has no operation cancel, so the host finishes the action (up to `ACTION_TIMEOUT_MS`, 45 s). If one of your ten fell there, record it with its moment and do not count it as a pass or a fail of the 3-second target; repeat the Stop at another moment to have ten.

### 2. No action after Stop

For each of the ten runs, no action may have **started** after the press. An action in flight at the press is recorded after it, as a failed step "Stopped by the owner while this was running", so compare the step's start, not its record time:

```sql
SELECT s.seq, s.action, s.ok, s.summary, s.created_at,
       s.created_at - make_interval(secs => COALESCE(s.duration_ms, 0) / 1000.0) AS started_at, r.cancel_requested_at
FROM run_steps s JOIN runs r ON r.id = s.run_id
WHERE s.run_id = '<id>' AND s.kind = 'action'
  AND s.created_at - make_interval(secs => COALESCE(s.duration_ms, 0) / 1000.0) > r.cancel_requested_at;
```

**Pass:** zero rows for each of the ten runs. Also check in the trace (item 7) that no `execute_tool` span starts after the press.

### 3. Pause for ten minutes

On a Goal A run that has made a few steps, press **Pause** from the phone. Note the values the moment the status reads `paused`, again after ten minutes, and again just before pressing **Resume**:

```sql
SELECT status, active_ms, step_count, model_calls, input_tokens, output_tokens, cost_usd, paused_at FROM runs WHERE id = '<id>';
```

**Pass:** `active_ms`, `step_count`, `model_calls`, tokens and cost are **identical** across the three readings; after Resume, the agent's log shows "The owner paused the run and resumed it after N minutes. Look at the page again before acting." and the first chunk of the resumed job starts with a fresh look (the trace's job root has `hexactra.job.reason = resumed`, and a `look`/screenshot comes before the first action). Check the browser stayed where it was (the live view). Then let the run finish.

### 4. Crash before the commit

Start Goal A. When the run is past the heading and before the confirmed click (the confirmation card is not open yet), kill the API as a crash and bring it back:

```bash
docker compose $F kill -s KILL api && docker compose $F up -d api
```

Repeat once with a plain `docker compose $F restart api` (a deploy). **Pass:** the run continues without being restarted by hand (its log says "The run was interrupted and continued", `runs.recoveries` is 1), the owner is asked **once** for the confirmation, and the test page's counter reads **1** after you approve.

### 5. Crash around the commit

Approve the confirmation on a Goal A run, and kill the API in the short window between the intent and the result (a slow test page helps: make the Confirm button take several seconds to answer, so the click is sent and the result is not back). Restart as in item 4. **Pass:**

```sql
SELECT seq, action, phase, summary FROM run_steps WHERE run_id = '<id>' ORDER BY seq;
```

shows the click's step in phase `unknown`; the agent's log says "Step N (press 'Confirm') may or may not have happened. Do not repeat it"; the run asks the owner again before pressing that button (the gate, not the model's choice); and the page's counter does not go above 1 **unless you approve the second ask**. Approve it once to see that a fresh approval ends the `unknown` state, and record the counter. Do this on at least two runs: the window is narrow, and a run killed just before the intent (item 4) or just after the result (a `done` step) is a useful third reading, not a pass of this item.

### 6. Two workers

With two API instances running, start three Goal A runs together and let them finish, with one hop forced if you can (a long run, or `docker compose $F restart api` on one instance mid-run). **Pass** when, for each run:

- the run's `invoke_agent hexactra.browser_agent` spans (one per job, items 7) **do not overlap in time**;
- `SELECT seq FROM run_steps WHERE run_id = '<id>' ORDER BY seq` is contiguous with no duplicate, and the test page's counter is 1 per run;
- the Jobs page shows one active `browser.goal.run` per run at a time, and any log line `run <id>: stopped, another job took over the run` belongs to a job that then wrote nothing.

Record the `runs.worker_token` changing between jobs and how many `superseded` lines you saw (zero is a valid result).

### 7. Trace

Pick one finished run and find it in the collector by the attribute `hexactra.run.id = <run id>` on the root span (the run page's **Trace id** also opens it). **Pass:**

- the tree matches [operations.md](operations.md#find-a-runs-trace-and-read-it) and [runner.md](../runner.md#traces-e384): a job root `invoke_agent hexactra.browser_agent` with `hexactra.chunk` children, `chat <model>` and `execute_tool <tool>` under them, `hexactra.fabric <action>` under the tool calls, and `hexactra.ask_human` events for the question;
- the fabric's own spans continue the trace when `HEXACTRA_FABRIC_OTLP_ENDPOINT` is set (record whether it was);
- **no personal data in any attribute.** Export the whole trace as JSON from the collector and search it for the words of your goal, the test page's path and query, the text the agent typed, your name and your email, and the run's result text:

```bash
grep -i -E '<goal word>|<page path>|<typed text>|<your name>|<your email>|<result text>' trace.json | head
```

Expected: nothing. Hosts alone (`hexactra.page.host`) are allowed. Record the span count, the root's duration and the `hexactra.cost_usd` sum against the run's `cost_usd`.

### 8. Replay suite, and one live-mode summary

- **Scripted, in CI on `main`:** open the latest "Console CI" run on `main` and record that the step `npm run scenarios --workspace=api` is green and which commit it ran on (`gh run list --workflow "Console CI" --branch main --limit 3`). The step exits 1 when a scenario fails or when none is found.
- **One live-mode summary:** from a machine with the deployment's database and an owner account:

  ```bash
  cd console && npm run build:packages
  npm run scenarios:live --workspace=api -- --tier standard --runs 3 --cap-usd 2 --user <email>
  ```

  Read `apps/api/test-results/live-standard.md` (pass rate, median steps, tokens and cost per scenario, the diff against the baseline, whether the cap cut it short), attach it to #589, and, after reading it, decide whether to commit a first baseline with `--save-baseline` (`apps/api/test/scenarios/baselines/standard.json`; none is committed yet, so the first live run has nothing to diff against). **Pass:** no violation (the command exits 0) and the summary is attached. The manual workflow `scenarios-live.yml` does the same against the database its secrets name.

### 9. Behaviour unchanged

The same Goal A, on the same node and model, before and after the epic: **before** is the stack built from commit `e8a143c` (the last commit before the first E38 change merged), **after** is the commit under test. Run it **three times on each** (a model varies), and record for each run id: `step_count`, `model_calls`, `input_tokens`, `cached_input_tokens`, `output_tokens` and `cost_usd`:

```sql
SELECT id, status, step_count, model_calls, input_tokens, cached_input_tokens, output_tokens, cost_usd FROM runs WHERE id IN (...);
```

State both medians. Decide the tolerance **before** you run (a suggestion: the median steps and the median tokens within 20 percent, and the same final result). **Pass:** within it. A difference outside it is not necessarily a defect (a model's variance, the pause and crash notes are new text), but it is a finding: file it.

### 10. After the package extraction (amendment, #614)

As item 9, with **before** the commit `8c11a96` (the last commit before the harness moved into `@marinoscar/hexactra-agent` and `@marinoscar/hexactra-browser-agent`). Record also: `npm run test:packages` run on a machine with no database and no fabric running (it needs only the built packages), and the CI job for `agent-host-conformance.db.spec.ts` green on `main`.

## Results

Copy this table into #589 and fill it in. "Not performed" is the honest value until you do.

| # | Item | Result (pass / fail / not performed) | Run ids | Numbers | Notes |
|---|---|---|---|---|---|
| 1 | Stop latency, ten Stops | not performed | | ms per Stop: | |
| 2 | No action after Stop | not performed | | rows found: | |
| 3 | Pause for ten minutes | not performed | | `active_ms` before / during / after: | |
| 4 | Crash before the commit | not performed | | counter on the page: | |
| 5 | Crash around the commit | not performed | | phase, counter: | |
| 6 | Two workers | not performed | | overlap, duplicates, `superseded`: | |
| 7 | Trace | not performed | | trace id, spans, personal data found: | |
| 8 | Replay suite and one live summary | scripted: green in CI; live: not performed | | CI run, live summary attached: | |
| 9 | Behaviour unchanged | not performed | | steps and tokens before / after: | |
| 10 | After the extraction | not performed | | steps and tokens before / after: | |

## When an item fails

A defect found here is **not** fixed in the close-out. File it as its own issue (a child of #580, label `v1`), fix it in its own pull request, and repeat the failed item. Keep the failing run ids in the issue.

Other follow-ups from the close-out: a nightly live-mode replay with a spend cap and a committed baseline ([#651](https://github.com/marinoscar/hexactra/issues/651)), a flaky CI job ([#652](https://github.com/marinoscar/hexactra/issues/652)), a tidy-up after the split ([#653](https://github.com/marinoscar/hexactra/issues/653)), further console packages ([#654](https://github.com/marinoscar/hexactra/issues/654)), the fabric idempotency key ([#633](https://github.com/marinoscar/hexactra/issues/633)) and the package follow-ups ([#643](https://github.com/marinoscar/hexactra/issues/643)).
