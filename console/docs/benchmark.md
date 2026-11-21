# Benchmarks

A benchmark runs the same challenges under several agent policies on a real node and grades each trial from the challenge site's own state. The design and the reasons are in the [decision record](decisions/benchmark.md). This page is the working reference. It grows with the epic (E44, #738): the challenge site, the first ten challenges, starting and running a benchmark through the API, and its scorecard are here; the pages, the exports and the CLI arrive with the issues that build them.

## How a benchmark runs

An organization administrator starts one with `POST /api/benchmarks` (permission `benchmarks:run`). The request answers at once; the work is a queue job.

1. **Start.** The API checks the challenges, the policies (each must be a built-in or one of the administrator's own), the node, and that a node can reach the challenge site. It writes the benchmark and one trial per challenge, policy and attempt, and queues the job `benchmark.advance`. A challenge the agent cannot attempt is marked `unsupported` here and never run.
2. **One trial at a time.** The job starts the next trial as an ordinary run (`trigger: benchmark`) under that trial's policy. Trials run attempt by attempt, challenge by challenge, one policy after the other, so a drift in the node or the provider is spread over all policies.
3. **The run.** The goal runner drives it like any run. It can be watched, paused and stopped on its run page. It is limited to the challenge site and has no connection, saved login, identity detail or card.
4. **Questions.** When the run asks a person, the [scripted owner](#the-scripted-owner) answers from the challenge's rules.
5. **Grading.** When the run ends, the site is closed, the challenge's grader reads the site's stored state, and the verdict, the checks and the run's metrics are written on the trial. The cost is added to the benchmark's spend.
6. **Next.** The job checks the spend cap and starts the next trial, or finishes the benchmark.

| | |
|---|---|
| A benchmark's status | `queued`, `running`, then `completed`, `cancelled` or `failed` |
| A trial's status | `pending`, `running`, then `graded` (it ran and was judged) or `skipped` (it never ran, or was stopped) |
| One benchmark per browser | A second benchmark on the same node and profile is refused (`409 BENCHMARK_RUNNING`) while the first is live |
| Where the runs are | In the run history with the filter `trigger=benchmark`; they are left out of the ordinary run list, the counts and the statistics |

### Verdicts

| Verdict | When | Failure reason |
|---|---|---|
| `pass` | every check of the grader passed, whatever the agent claimed | |
| `fail` | a check failed | `wrong_result` (the agent claimed success), `gave_up` (it did not), `budget` or `stalled` (what stopped the run) |
| `fail` | the trial ran past its timeout, or the agent asked a question no rule answers | `timeout`, `asked_person` |
| `error` | the trial could not be judged: the node was down, no model or a provider error, the grader threw, the run was deleted | `error`, `no_model` |
| `skipped` | it never ran or was stopped: the benchmark was cancelled, the spend cap was reached, three errors in a row, somebody stopped the run | `cancelled`, `cap`, `error` |
| `unsupported` | the challenge needs a capability the agent lacks | `unsupported` |

`claimedSuccess` is what the agent said (`finish` with success). A `fail` with `claimedSuccess: true` is a false success; a `pass` with `claimedSuccess: false` is a false failure. `error`, `skipped` and `unsupported` say nothing about the agent.

### The limits of a benchmark

| Limit | What happens |
|---|---|
| Spend cap (`capUsd`) | Checked before each trial against the cost of the trials that ended. Once reached, the rest is `skipped` with the reason `cap` and the benchmark is `completed`. A trial in progress finishes, so the spend can pass the cap by one trial. A run whose model has no price counts as zero (`costKnown: false`). |
| Trial timeout (`trialTimeoutMinutes`) | Wall-clock from the trial's start. The run is stopped like any run and the trial is `fail` with `timeout`. A run that does not stop within a minute is ended by the benchmark. |
| A node that is down | The trial is `error` and the next one starts. Three `error` trials in a row end the benchmark as `failed`, the rest `skipped`. |
| Cancel | `POST /api/benchmarks/{id}/cancel`: nothing more starts, the trials that have not run and the one running are `skipped` with `cancelled`, and the running trial's run is stopped through the ordinary cancel path. |
| A crash | The job reads the rows every time and every write is conditional, so a pass may run twice or after a restart. A trial claimed without a run gets its run on the next pass. |

### What a trial run may do

- It may visit the challenge site's host and nothing else: the browser enforces it, and the site gate checks every action.
- It asks before a risky step only when its challenge says so (`run.confirmRiskyActions`).
- It uses no connection, saved login, identity detail or card, whatever the administrator's own defaults are.
- How a run without a task carries those two limits is in the [decision record](decisions/benchmark.md#how-a-run-without-a-task-carries-its-allowed-sites-and-confirmriskyactions).

## The scripted owner

A benchmark runs unattended, so a challenge scripts its owner's answers (`Challenge.owner(seed)`, a list of rules).

- A rule states any of the question's kind, its input and text its prompt contains (compared without case). The first rule that fits answers `approve`, `deny`, `text` or `credentials`. A rule answers once unless it says `repeat`.
- The answer goes through the ordinary answer service as the administrator, on the channel `benchmark`.
- A question no rule fits ends the trial: the run is stopped, the verdict is `fail`, the reason `asked_person`. An answer that does not suit the card (text for a yes/no card) counts as no rule.
- It answers questions and nothing else. It never ticks "remember" and cannot create or widen a saved approval. It never answers a suggested memory or an offer to save a sign-in; one left by a run is withdrawn when the trial is graded.
- `credentials` are fixture values derived from the trial's seed, for the challenge site. The password goes to the fabric like any sign-in and is stored nowhere.
- The grader receives every question the run asked (`asked`): its kind, its input, the masked prompt, when, and what the scripted owner answered (`none` when nobody did).

## The API

Every route is under `/api/benchmarks`. Reading needs `benchmarks:read`; starting, cancelling and deleting need `benchmarks:run`. Both belong to the organization administrator. There is no MCP tool.

| Route | What it does |
|---|---|
| `GET /suite` | The challenges with category, difficulty and `supported`, the defaults and limits of a new benchmark, and `site.reachable` |
| `GET /` | The administrator's benchmarks, newest first (`limit`, `offset`) |
| `POST /` | Start one |
| `GET /{id}` | One benchmark: settings, status, `spentUsd`, `progress` (trial counts by status and verdict), `totals` (input, output and cached tokens, model calls and cost of the trials that ended; `costKnown: false` when any call had no price), `appVersion` and `commit` |
| `GET /{id}/trials` | Its trials in run order: verdict, failure reason, checks, `claimedSuccess`, the metrics copied from the run (`durationMs`, `activeMs`, `steps`, `modelCalls`, `inputTokens`, `outputTokens`, `cachedInputTokens`, `costUsd`, `costKnown`, `stopReason`, `questions`, `escalations`), `model` and `models` (the models its policy resolved to: each tier from start to max, and the tier it ended on), `runId`. Filters: `status`, `verdict`, `policyRef`, `challengeId` |
| `GET /{id}/scorecard` | Its [scorecard](#reading-the-scorecard): live while it runs, cached once it has ended |
| `GET /{id}/compare?baseline={id}` | Its [comparison](#comparing-with-a-baseline) with an earlier benchmark on the same suite key and version (`409 BENCHMARK_SUITE_MISMATCH` otherwise) |
| `POST /{id}/cancel` | Cancel it |
| `DELETE /{id}` | Delete one that has ended, with its trials. Its runs stay in the run history |

```json
POST /api/benchmarks
{
  "name": "Economy against Thorough",
  "challengeIds": ["nav-lookup", "form-multistep"],
  "policies": [{ "ref": "builtin:economy" }, { "ref": "builtin:thorough", "label": "Thorough" }],
  "trials": 3,
  "hostId": "6f1c2a5e-0000-4000-8000-000000000001",
  "profile": "default",
  "capUsd": 5,
  "trialTimeoutMinutes": 15
}
```

Only `policies` is required: 1 to 8 of them. `challengeIds` defaults to the whole suite, `trials`, `capUsd` and `trialTimeoutMinutes` to the system settings `benchmark.*`, `profile` to `default`, and without `hostId` the fabric picks a node for each trial.

| Refusal | Code |
|---|---|
| A challenge the suite does not have | `400 CHALLENGE_UNKNOWN` |
| A policy that is not a built-in or the administrator's own; a policy or a label listed twice | `400 POLICY_REF_INVALID`, `400 POLICY_DUPLICATE` |
| A node that is not in the fleet; the fabric did not answer | `400 BENCHMARK_HOST_NOT_FOUND`, `400 BENCHMARK_HOST_UNAVAILABLE` |
| A node cannot reach the challenge site (the address is a loopback default) | `400 BENCHMARK_SITE_UNREACHABLE` |
| A benchmark is already live on that node and profile; deleting a live benchmark | `409 BENCHMARK_RUNNING` |

A trial never returns its seed, its token, the site's state or an expected answer.

| Telemetry | |
|---|---|
| Counters | `app.benchmarks.started`; `app.benchmarks.trials` by `verdict` |
| Audit events | `benchmarks.started`, `benchmarks.cancelled`, `benchmarks.deleted` (ids and counts only) |
| Job | `benchmark.advance`, in Administration, Background jobs |

### Code map

| File (`apps/api/src/benchmark/`) | What it holds |
|---|---|
| `benchmarks.controller.ts`, `benchmarks.service.ts`, `benchmarks.schemas.ts` | The routes, start/read/cancel/delete, the request and response shapes |
| `benchmark.jobs.ts`, `benchmark-runner.service.ts` | The job and one pass over a benchmark |
| `benchmark-run-starter.ts` | Creates a trial's run |
| `benchmark-owner.ts`, `owner-script.ts` | The scripted owner, and its rules as pure functions |
| `benchmark-grader.ts`, `trial-verdict.ts` | The run-end hook, and the verdict as a pure function |
| `benchmark-site-address.ts` | The site's address and the reachability check |

## Reading the scorecard

`GET /api/benchmarks/{id}/scorecard` (`benchmarks:read`) turns the trials into a comparison of the policies. Every number is computed by the pure functions of `scorecard.ts` from the metrics copied onto the trials, so a deleted run, or a run past its retention, changes nothing. The shapes are in `scorecard.schemas.ts` (`scorecardSchema`, `benchmarkComparisonSchema`); the pages and the report files render them as they are.

### Which trials count

| Trials | In the rates | In the cost and tokens |
|---|---|---|
| `pass` and `fail` (**judged**) | Yes: they are the denominator of every rate | Yes |
| `error` | No: the trial says nothing about the agent; counted in `counts.error` | Yes, it spent |
| `skipped` (cancelled, the cap) | No; `counts.skipped` | Yes, when it ran part way before it was stopped |
| `unsupported` | No; `counts.unsupported` | No, it never ran |
| `pending`, `running` | No; `counts.unfinished` (only while the benchmark is live) | Not yet |

A trial "ran" when its run's metrics are on it: those trials are the ones whose cost makes up the benchmark's spend.

### The metrics

Each policy has them, and each policy within each category (`policies[].categories[]`, only the categories the benchmark has, in the suite's order).

| Metric | Field | Definition |
|---|---|---|
| Success rate | `successRate` | Passes / judged trials, with a Wilson 95% interval (`low`, `high`). Null when nothing was judged |
| Reliability (pass^k) | `passAllK` | The share of challenges, among those with at least one judged trial, whose k trials were all judged and all passed. A challenge with a trial that errored or was skipped is not "all passed". It has its own Wilson interval |
| False success | `falseSuccess` | Claimed success and graded `fail`, over judged trials |
| False failure | `falseFailure` | Graded `pass` without claiming success, over judged trials |
| Speed | `speed` | Median and p90 `activeMs`, median steps and median model calls, of the judged trials |
| Total cost | `cost.totalUsd` | The sum of the cost of every trial that ran |
| Cost per trial | `cost.medianPerTrialUsd` | The median cost of a judged trial |
| Cost per success | `cost.perSuccessUsd` | Total cost / passes. No value when there is no pass |
| "At least" | `cost.known` | False when any trial that ran had a model call with no price (`costKnown: false`): every cost figure of the group is then a lower bound, shown as "at least" |
| Tokens | `tokens` | Total input, output and cached input tokens of every trial that ran (`cached` is part of `input`), `total` = input + output; the median input, output and cached tokens of a judged trial; `perSuccess` = total / passes, no value when there is no pass |
| Failure reasons | `failureReasons` | Trials by `failureReason` (every trial that has one, the excluded ones too), most first |
| Stop reasons | `stopReasons` | Trials that ran by their run's `stopReason`, most first |
| Safety | `safety` | Trials with at least one failed check named `safety:…`, and each such check with how many trials failed it. A flag, never averaged into the success rate |
| Models | `models` | The models (`provider:modelId`) that served the trials: each trial's tiers from its start tier up to the tier it ended on, in the order first seen |

How the statistics are computed:

- **Wilson interval** at 95% (z = 1.959963984540054): with p = k / n, centre = (p + z²/2n) / (1 + z²/n) and half-width = z·√(p(1−p)/n + z²/4n²) / (1 + z²/n), clamped to [0, 1]. Unlike p ± 1.96·√(p(1−p)/n), it stays meaningful at 0 of 3 or 3 of 3. Examples: 0 of 1 is [0, 0.793]; 2 of 3 is [0.208, 0.939]; 7 of 10 is [0.397, 0.892].
- **Median**: the middle value, or the mean of the two middle values for an even count.
- **p90**: by nearest rank, the smallest value with at least 90% of the values at or below it (the 9th of 10, the 10th of 11).
- Money is rounded to a millionth of a dollar.

### The matrix, the ranking and the totals

| Part | Field | What it holds |
|---|---|---|
| Matrix | `matrix[]` | One row per challenge (the benchmark's order), one cell per policy: passes out of the judged trials and of k, each attempt's verdict by `trialIndex` (null while it has not ended), the median active time and cost of a judged trial, total tokens, whether a safety check failed, whether the cost is known |
| Ranking | `ranking[]`, `policies[].rank` | Best first: the higher success rate, then the lower cost per success, then the lower median active time, then the benchmark's policy order; a missing value ranks last. There is no composite score |
| Totals | `totals` | The whole benchmark: its cost (`spentUsd`), `costKnown`, total input, output, cached and input + output tokens, model calls, and the trial counts |

`policies[]` keeps the benchmark's policy order (the columns); `ranking[]` is the order to read them in.

### Live and cached

- While a benchmark is `queued` or `running`, the scorecard is computed on every read and says `live: true`.
- When it ends (the pass that finds nothing more to run, the cap, three errors in a row, or Cancel), the scorecard is written to `Benchmark.summary` once no trial is running; a cancelled benchmark whose last trial was still being stopped gets it from the pass that grades that trial. Until then a read computes it (`live: true`).
- A cached scorecard is final: later passes leave it. It carries `format: "hexactra.benchmark-scorecard"` and `version`; a summary of another version (a formula changed) is recomputed from the trials on the next read.
- A benchmark with no judged trial has an empty scorecard (null rates), not an error.

### Comparing with a baseline

`GET /api/benchmarks/{id}/compare?baseline={id}` (`benchmarks:read`) compares two of the administrator's benchmarks.

- **Same suite only.** A different suite key or version is refused with `409 BENCHMARK_SUITE_MISMATCH`; the message and `details` (`benchmark`, `baseline`) name both. A challenge's meaning may change between versions, so a comparison across them would mislead.
- **Policies** are matched by ref, then by label among those left. The rest are listed in `unmatched`.
- **Deltas** (`current − baseline`) per matched policy: success rate, pass^k, false-success rate, median active time, median cost per trial, total cost, cost per success, total tokens and tokens per success; and for the whole benchmark, total cost and total tokens. Each says which way is better (`better`) and whether it went that way (`improved`). A rate's delta is `withinNoise` when the two Wilson intervals overlap: the change is not shown to be real, and `improved` is then null. A cost's delta is `atLeast` when either side has an unknown cost.
- **Flipped challenges**: for a matched policy, a challenge whose outcome changed between "all judged trials passed", "none passed" and "mixed", with the passes of each side and whether it got better or worse.
- Both sides carry their `appVersion` and `commit`, so a regression can be traced to a change.

| Code (`apps/api/src/benchmark/`) | |
|---|---|
| `scorecard.ts` | The formulas, pure: `wilson`, `median`, `percentile`, `metricsOf`, `rankPolicies`, `computeScorecard`, `compareScorecards` |
| `scorecard.schemas.ts` | The shapes, for the pages and the report |
| `scorecard.service.ts` | `ScorecardService`: `scorecard(userId, id)`, `compare(userId, id, baselineId)`, `cacheIfEnded(id)` |
| Tests (`apps/api/test/`) | `benchmark-scorecard.spec.ts` (every formula with hand-computed numbers; the Wilson bounds against reference values to three decimals), `benchmark-scorecard.db.spec.ts` (the routes, the cache, a deleted run, the refusal and the flipped challenges) |

## The challenge site

The console API serves a small fake web application for each trial. A real Chrome on a node opens it like any other site.

| | |
|---|---|
| Address | `https://<console>/benchmark/t/<token>/` |
| Served by | the API, `apps/api/src/benchmark/site/`, at `/api/benchmark-site/` |
| Published by | the nginx overlay `infra/nginx/app.d/locations/benchmark.conf`: `/benchmark/` proxies to `/api/benchmark-site/` |
| In development | `http://localhost:<port>/api/benchmark-site/t/<token>/`, through the Vite proxy or the API's own port |
| Base URL | the system setting `benchmark.siteBaseUrl`; empty means the console's public URL plus `/benchmark` |
| Static files | `/benchmark/assets/<file>`: the scripts and the stylesheet in `apps/api/assets/benchmark-site/` |

A node's browser must reach the base URL. A node on another network reaches the console's public name, so the default works wherever the console itself is reachable from the node.

### What a page is

- Server-rendered HTML in one layout (`assets/benchmark-site/layout.html`), plus scripts and one stylesheet from the same origin.
- No inline script, no inline event handler and no inline style. The site sends its own `Content-Security-Policy` (`script-src 'self'; style-src 'self'`), and nginx adds the platform's. A browser enforces both.
- No console code, no cookie and no session. The token in the address is the only authority.
- Every link, form action, redirect and script call is relative. The same page works at `/benchmark/...` and at `/api/benchmark-site/...`.
- A page changes the trial's state the way a real site does: a form post, or a small JSON call made by the page's own script.

### The token and the state

| | |
|---|---|
| Token | 32 random bytes, base64url. Made by `TrialStateService.issueToken(trialId)`, returned once, and written into the trial's goal as part of the start URL. |
| Stored | only its SHA-256, in `BenchmarkTrial.tokenHash`. |
| Valid | while the trial's status is `running` and the site is open. `closeToken(trialId)` closes it. |
| State | plain JSON in `BenchmarkTrial.siteState`. `issueToken` sets it to the challenge's `setup(seed)`. |
| Writes | optimistic: a write names the version it read (`siteStateVersion`). A request that lost re-runs. A write on a closed trial is refused. |

An unknown, malformed or closed token answers the same 404 page on every route, and so does a page the challenge does not have.

### Limits and logging

- 600 requests a minute for one trial (the shared rate limiter, keyed by the trial's id). Over it: `429` with `Retry-After`.
- A posted body is at most 64 KB. nginx refuses a larger one first.
- The request log sees every page of a trial as `/api/benchmark-site/t/redacted`: no token, no page address, no query. No span is made for the site's paths, and the nginx location writes no access log.
- A refused write is logged with the trial's id only. No token, seed, expected answer or state is written to a log, a span or a metric.

### Check it on a deployed stack

```bash
curl -si https://<console>/benchmark/assets/site.css | head -n 1          # 200, text/css
curl -si https://<console>/benchmark/t/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/ | grep -iE '^(HTTP|content-security-policy|x-frame-options|x-content-type-options|strict-transport-security)'
```

The second command answers `404` with the platform's security headers and two `Content-Security-Policy` headers (the platform's and the site's). `scripts/stack-smoke.sh` asserts both in CI.

In a deployment whose public proxy forwards only chosen paths ([public-exposure.md](runbooks/public-exposure.md), shape (c)), the nodes must still reach `/benchmark/`. Either forward that path too, or set `benchmark.siteBaseUrl` to an address the nodes can reach.

## The challenges (suite `core`, version 1)

| Id | Category | The agent must | Graded on |
|---|---|---|---|
| `nav-lookup` | Navigation | follow three pages (customers, a customer, an order) to an order's status | the reported status |
| `nav-spa` | Navigation | reach a setting through client-side routes, change it and save | the stored setting; nothing else changed |
| `nav-pagination` | Navigation | find one product across six pages of results | the reported price |
| `nav-new-tab` | Navigation | open a document that opens in a new tab and read its access code | the reported code |
| `form-multistep` | Forms | complete a three-step registration; the phone number in the goal has a dash and the form wants digits | the stored record, field by field |
| `form-select-date` | Forms | choose a service in a custom dropdown and a date in a calendar | the stored booking |
| `extract-table` | Extraction | find the largest amount of one region in a table that sorts and filters | the reported amount |
| `extract-infinite-scroll` | Extraction | scroll a feed of 120 entries to one shipment | the reported pickup code |
| `dyn-delayed` | Dynamic pages | wait for a figure that arrives seconds after the page opens, next to an out-of-date one | the reported total; the figure reached the page |
| `dyn-modal` | Dynamic pages | answer a dialog that covers the page, then switch on a preference and save | the stored preference; the dialog was answered |

### How a trial is graded

- A grader returns named checks. A trial passes only when every check passes.
- A grader reads the site's stored state and, where the task is to report something, the agent's final answer. It never trusts the agent's claim of success.
- A reported value passes when the answer names the expected value and none of the other candidates the site showed. An answer that lists every status, or every price, is not an answer. Case, spacing and currency format are ignored (`$1,234.50`, `1234.5` and `USD 1,234.50` are the same amount).
- Every name, price, code and expected answer derives from the trial's seed. Two trials never share an answer by design, and a grader recomputes the expected values from the seed.

## How to add a challenge

A challenge is one file in `apps/api/src/benchmark/suite/challenges/`. It owns its data, its pages, its endpoints and its grader. Nothing else changes except the list it is added to.

1. **Write the plan.** A function of the seed that returns everything seeded: the data the pages show and the expected answer. Use `seeded(seed, '<id>')` and `distinct(...)` (`challenges/shared.ts`) for lists a person searches. Export it (`myChallengePlan`); the tests use it.
2. **Write `setup(seed)`.** The state at the start: only what the agent's actions change. Keep it small. Data that never changes stays in the plan.
3. **Write `goal(seed, baseUrl)`.** One or two sentences that start with `Open ${baseUrl}/`. Name the values the agent needs. Give no instruction about tools or how to solve it.
4. **Write `site.handle(request)`.** It receives the method, the path below the trial's root, the query, the posted body, the seed and the state, and returns `page(...)`, `json(...)`, `redirect(...)` or `notFound()` (`suite/pages.ts`).
   - Build markup with the `html` tag. It escapes every value.
   - Build every address from `request.root`: `${request.root}orders/${id}`.
   - To change the state, return the new state: `redirect('done', { state })`, `json(data, { state })`, `page(view, { state })` or `withState(response, state)`. Never change `request.state` in place. The handler may run again for the same request, so it must depend only on its input.
   - Change the state only on a completed interaction. A script error must never be able to mark a challenge passed.
   - Validate everything posted. Use `field(body, name)` for text.
5. **Add a page script only if the page needs one.** Put it in `apps/api/assets/benchmark-site/<id>.js` and name it in the page's `scripts`. Use `window.BenchmarkSite` (`site.js`) for calls: `get(path)`, `post(path, body)`, `el(tag, attrs, children)`. No `innerHTML`, no absolute address. Styles go in `site.css` as classes; a page has no inline style. Canvas drawing, shadow roots and same-origin frames are allowed by the site's policy (`frame-src 'self'`).
6. **Write `grade(input)`.** Return named checks (`kebab-case`; `safety:<name>` for a check that guards an invariant). Recompute the expected values from `input.seed`. Use `reportedValue`, `reportedAmount` and `storedField` (`suite/compare.ts`).
7. **Register it** in `challenges/index.ts`. Set `requires` when the agent needs a capability beyond a browser.
8. **Test it.**
   - Add a solver to `apps/api/test/support/benchmark-solvers.ts`. It completes the challenge through `SiteBrowser`, knowing only what the goal says and what the pages show. `test/benchmark-site.spec.ts` and `test/benchmark-site.db.spec.ts` then run it for every challenge: solved and graded, an untouched trial fails, two seeds differ, no page has inline script.
   - Add the wrong cases to `test/benchmark-site.spec.ts`: a wrong reported value, a wrong stored value.
   - Open the page once in a real browser. The solver tests exercise the endpoints, not the page's script.
9. **Bump `SUITE.version`** (`suite/registry.ts`) when a released suite changes: a challenge added, removed, or changed in a way that changes its results. Two benchmarks compare only within one version.

```bash
cd console/apps/api
npx jest --config ./test/jest.config.js benchmark-site                              # the unit tier
npx jest --config ./test/jest.config.js --testRegex 'benchmark-site\.db\.spec\.ts$' --runInBand   # over HTTP, real Postgres
```

## Tests

| Spec (`apps/api/test/`) | What it proves |
|---|---|
| `benchmark-run.spec.ts` | A trial run's limits and that no other run can carry them, the scripted owner's rules, the verdict, the order of trials, the site address check |
| `benchmark-run.db.spec.ts` | A benchmark end to end on a real database with a scripted model and the in-memory fabric: every trial graded, a false success, a scripted and an unscripted question, the cap, the timeout, cancel, a node that is down, a crash, the refusals |
| `support/benchmark-fixtures.ts` | `createGradedBenchmark(prisma, userId, opts)`: a finished benchmark with graded trials, for a spec that reads one |

```bash
cd console/apps/api
npx jest --config ./test/jest.config.js benchmark-run
npx jest --config ./test/jest.config.js --testRegex 'benchmark-run\.db\.spec\.ts$' --runInBand
```
