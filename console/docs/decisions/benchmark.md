# Decision: benchmarks on the real product, graded from site state

**Status:** accepted (epic E44, #738: #739 to #746). **Scope:** the console (API, web, CLI, the nginx overlay) and its docs. This record is written with the foundation (#739); the issues that follow build what it describes, and each one records here what it decided.

## The problem

The owner wants to compare model configurations and agent policies, and to know whether a change to the agent made it better or worse. That could not be measured on the real product.

| # | Gap | Where |
|---|---|---|
| 1 | A run succeeds because the model says so. Nothing verifies it. | `packages/hexactra-browser-agent/src/tools/finish.ts`; [runner.md](../runner.md) ("there is no model-graded judge") |
| 2 | The replay suite scores model tiers, but against an in-memory fake site. It never touches real Chrome, a node or the fabric. | `apps/api/test/replay/site.ts`, `apps/api/scripts/scenarios-live.ts` |
| 3 | Nothing groups "the same work under N policies", and no report compares them. | `apps/api/src/tasks/task-summary.service.ts` (statistics are per task, not per policy) |
| 4 | `crates/hexactra-benchmark` returns random results. | `crates/hexactra-benchmark/src/runner.rs` (`simulate_task`) |

## The decision

An administrator picks challenges, agent policies and a trial count. The console runs every combination (challenge x policy x trial) as an ordinary run on a real node, against a challenge site it serves itself, and grades each trial from that site's own state. A scorecard compares the policies.

| Topic | Decision | Why |
|---|---|---|
| Shape | An administrator's feature with its own tables, `Benchmark` and `BenchmarkTrial`. Each trial is an ordinary `Run` with `trigger: benchmark`. | A benchmark is a matrix, not one task. Reusing runs gives the duration, the steps, the tokens, the cost, the stop reason and the trace for free, and a trial can be stopped and paused like any run. |
| Comparing models | A configuration is an agent policy. A policy pinned to one model (`startTier = maxTier`, `pins`) isolates that model. | `agentPolicySpecSchema` already supports it; nothing new decides which model a run uses. |
| Challenge site | Served by the console API, behind an nginx overlay at `/benchmark/`. The base URL is a system setting (`benchmark.siteBaseUrl`). | No new DNS name or certificate; it can move to its own host later by changing the setting. |
| Grading | Deterministic, from the site's server-side state per trial. No model judge. | A state check is reproducible. Screenshot judges have been shown to inflate results (WebVoyager: 68.6% when audited against 87% reported). |
| Seeds | Each trial has a seed (`seedFrom`). Names, prices, codes and the expected answer derive from it. | A model or a prompt cannot learn a fixed answer, and a trial can be rebuilt exactly. |
| Repeated trials | Three per cell by default. The scorecard reports pass^k (all k trials passed) and a 95% interval. | One run per task hides inconsistency (tau-bench). |
| The agent asks a person | A scripted owner per challenge answers from rules. A question no rule fits ends the trial as "asked a person". | A benchmark runs unattended. Modelled on `apps/api/test/replay/owner.ts`. |
| Headline | No single composite score. Policies are ranked by success rate, then by cost per success. | VISION.MD warns against one "completed" metric. |
| Suite | Built in, defined in code, with a `suiteVersion`. Two benchmarks compare only within one version. | The same precedent as the `builtin:` policies: a change is a version bump, never a silent edit. |
| Unsupported | A challenge that needs a capability the agent lacks is reported `unsupported`, never failed. | Upload to a web form (#662) and downloads have no browser action; a missing feature is not a wrong answer. |
| Retention | A trial's metrics are copied onto its row when it is graded. | A scorecard outlives run retention (E40, #684): the run and its trace may be deleted, the result stays. |
| The owner's views | A benchmark run is left out of the run list, the counts, the home summary and task statistics unless `trigger=benchmark` is asked for. | Thirty trial runs are not the owner's own work and would bury it; they stay one filter away, and each is still served by its id. |
| Permissions | `benchmarks:read` and `benchmarks:run`, granted to the organization administrator only. | A benchmark spends money on model calls and occupies a node. |
| MCP | Not offered. | It spends money and is an administrator's feature; no hosted assistant starts one. |

### What a benchmark run may do

A benchmark run is limited to the benchmark site (its allowed sites), uses no connection, no saved login, no saved identity and no saved card. The scripted owner answers questions only: it never ticks "remember", so it cannot create or widen a saved approval, a memory, a connection or a secret. Every tool call still goes through `executeTool`. The runner, the tools and the gates are not changed by this epic: there is no benchmark mode in the agent, and no agent logic in `apps/api/src` (`test/architecture/no-agent-logic.spec.ts`).

## The suite contract

`apps/api/src/benchmark/suite/` (`types.ts`, `registry.ts`, `seeded.ts`). A challenge is plain code with no dependency on Nest, Prisma or the runner:

```ts
interface Challenge {
  id: string; title: string; category: Category; difficulty: 1 | 2 | 3;
  requires?: readonly Capability[];
  setup(seed: Seed): SiteState;                 // the site's state at the start
  goal(seed: Seed, baseUrl: string): string;    // includes the start URL
  owner?(seed: Seed): OwnerRule[];              // scripted answers
  run?: { confirmRiskyActions?: boolean };
  grade(input: GradeInput): Check[];            // named checks; a trial passes when all pass
}
```

- **Seed.** `seedFrom(benchmarkId, challengeId, policyRef, trialIndex)` is 32 hex characters of a SHA-256: deterministic, and different for every trial. `seeded(seed)` gives the fixture values (a person `Person QK`, an address on `example.test`, a product, a price in whole cents, a code without look-alike characters, a reference, a date) and `fork(scope)` for independent streams.
- **Site state.** Plain JSON in `BenchmarkTrial.siteState`. Its optimistic version is the column `siteStateVersion` beside it, not a key inside it, so a challenge cannot overwrite it.
- **Owner rules.** A rule states any of a question's kind, its input and text its prompt contains; the first rule that fits answers `approve`, `deny`, `text` or `credentials`. Credentials here are fixture values derived from the seed for the challenge site: they are not Secret Material.
- **Checks.** `{ name, pass, detail? }`. A check that guards an invariant is named `safety:<name>`, and the scorecard flags a failed one apart from an ordinary failure.
- **Capabilities.** `pointer`, `real_keys`, `file_upload`, `file_download`. `AGENT_CAPABILITIES` (`registry.ts`) is what the agent has today; `missingCapabilities(challenge)` decides `unsupported`.

Two details differ from the sketch in the epic, on purpose. `owner` is a function of the seed, because a scripted answer (fixture credentials, a code) derives from it like everything else. `grade` also receives the `seed` and `claimedSuccess`: the grader recomputes the expected values instead of trusting a copy in the state, and a challenge about an impossible task expects the agent to say it failed.

## How this differs from the replay suite

The replay suite ([runner.md, Testing a change to the agent](../runner.md#testing-a-change-to-the-agent)) and a benchmark answer different questions and neither replaces the other.

| | Replay suite (E38.6) | Benchmark (E44) |
|---|---|---|
| The website | `SiteBrowser`: an in-memory fake that answers the browser port | real pages served over HTTPS, opened by real Chrome on a node |
| What runs | the harness and the browser layer, in a test process | the whole product: the queue, the host bindings, the fabric, the node, the extension |
| The model | scripted (free, in CI) or live | always live |
| Success | the scenario's `expect` and the invariants, over what reached the fake site | the challenge's grader, over the site's stored state |
| Where | `npm run scenarios`, CI | an administrator's page, on a deployed stack |
| It is for | "did my change to a prompt, a tool or a gate break the agent's behaviour?" before merging | "which policy or model does the work best, at what cost?" and "did the deployed agent get worse?" |

The replay suite stays the gate for a change to the agent. A benchmark costs money and needs a node, so it never runs in the default CI job.

## Why `crates/hexactra-benchmark` is not reused

That crate predates the decision that there is one agent loop and it is not in Rust ([one-agent-loop.md](../../../docs/decisions/one-agent-loop.md)). Its runner simulates a task and returns random results (`simulate_task`); it starts no run, calls no model and reads no page. A benchmark has to exercise the console's goal runner, so it lives in the console, next to the runs it creates. The crate is left as it is: nothing in this epic depends on it or changes it.

## The challenge site (#740)

How the site is served and how to add a challenge: [benchmark.md](../benchmark.md). What was decided while building it:

| Topic | Decision | Why |
|---|---|---|
| Who owns a challenge's pages | The challenge. `Challenge.site.handle(request)` is a pure function of the request, the seed and the state; it returns a page, JSON, a redirect or a 404, and the new state. One dispatcher (`site/site.service.ts`) routes everything under `t/<token>/` to it. | Twelve more challenges (#745) are twelve files. The controller never grows, and a challenge is tested without Nest or a database. |
| State writes | The handler returns the new state; the dispatcher stores it with the optimistic version and re-runs the handler when another request wrote first. | A handler cannot forget the version or write after the trial closed: one statement checks `running`, the open token and the version. |
| What is in the state | Only what the agent's actions change. Seeded data that never changes is recomputed from the seed (the challenge's plan). | A small state, and a grader that never reads its expected answer from something a page could have written. |
| Reported values | The answer must name the expected value and none of the other candidates the site showed, after normalising case, spacing and currency format. | The agent answers in a sentence; exact equality would fail a correct answer, and plain containment would pass an answer that lists everything. |
| Token in the address | A path segment, not a cookie or a header. The request log sees `/api/benchmark-site/t/redacted`, no span is made, nginx writes no access log for `/benchmark/`. | The agent is given one URL. A cookie would need a sign-in step that is not what a challenge measures. |
| Content-Security-Policy | The site sends its own (`script-src 'self'; style-src 'self'`, no inline anything), on top of the platform's from nginx. | The pages are safe in development too, where nginx is not in front, and a page cannot depend on what only one of the two allows. |
| Static files | `/benchmark/assets/<file>`, without a token, the same for every trial. | They carry no data, and a browser can cache them across trials. |
| When a site opens | `issueToken` accepts a `pending` or `running` trial and resets the state; the pages answer only while it is `running`. | The orchestration (#741) needs the token to word the goal before the run starts. |

## Running a benchmark (#741)

How a benchmark runs, the scripted owner and the API: [benchmark.md](../benchmark.md). What was decided while building it:

### How a run without a task carries its allowed sites and `confirmRiskyActions`

A trial run has no task and no chat. Before this, a run read its two opt-ins from one of those and an ad-hoc run had none, so a trial run would have been free to visit any site.

**Decision.** The run starter writes `runs.context.benchmark = { benchmarkId, trialId, allowedDomains, confirmRiskyActions }`, and one helper, `runLimits(run)` (`apps/api/src/runner/host/run-limits.ts`), is now the only place a run's own limits are read. The two call sites that read the task's values before (`runner/host/browser-session.ts` for the browser's own enforcement, `runner/host/build-context.ts` for the site gate and the risk gate) call it instead.

| Property | How it holds |
|---|---|
| It changes nothing for any other run | `runLimits` reads the context only when `run.trigger === 'benchmark'`. For every other trigger it returns the same expression the two call sites had: the task's values, else the chat's, else none. `test/benchmark-run.spec.ts` checks every trigger, with the same context on the row. |
| No request can make a benchmark run | `trigger: 'benchmark'` is written in one file, `benchmark/benchmark-run-starter.ts`, and `benchmarkRunContext()` is called in one file. A unit test scans `src/` for both. No route takes a trigger or a context in its body: `POST /api/runs` with both is checked in `test/benchmark-run.db.spec.ts`, and `POST /api/benchmarks` is a strict schema with no field for a site, a context or a confirmation setting. |
| It can only narrow | The context names sites; it has no "any site" value. A benchmark run whose context is missing or unreadable is allowed `no-site.invalid` only (`NO_SITE`), never the empty list that means "any site". `benchmarkRunContext()` refuses to build a context without a site. |
| The agent is unchanged | The gates, the tools and the loop are the packages' and were not touched. `test/architecture/no-agent-logic.spec.ts`, `test/runner-characterisation.db.spec.ts` and `test/agent-host-conformance.db.spec.ts` pass unchanged. The model reads the same "Allowed sites:" line a task's run reads. |

**Rejected.** (a) A hidden task per trial: it would appear in the owner's tasks, statistics and schedules, and a task has switches (connections, saved logins) that would then have to be forced off. (b) The AI app limits column (`runs.app_limits`), which already narrows sites and asks before purchases: it means "an AI app started this run", shows as one in the run's views, and words the allowed sites differently to the model, so a benchmark would measure a slightly different agent. (c) A new column: the context column already exists for "what started the run beside the task", and a benchmark is the second case of it after an email.

The allowed site is the challenge site's host (the host of `benchmark.siteBaseUrl`, by default the console's own). The site gate matches by host, so on the default address a trial run could also open the console's own pages; it has no session there. A separate host for the site removes even that (the setting exists for it).

### What a trial run cannot use

Nothing was switched off for a benchmark run: it has no task and no chat, and each of these is turned on only by a task's or a chat's own switch.

| | Why a trial run has none |
|---|---|
| Connections | `runConnections` reads the task's list, else the chat's. The owner's new-chat default (`connections.newChats`) attaches accounts to a chat row when a chat is created; a trial run has no chat. |
| Saved logins, identity details, cards | `runner/host/start.ts` reads `useSavedLogins`, `useSavedIdentity` and `useSavedCards` from the task, else the chat, else off. |
| Saved approvals, memories | The scripted owner never ticks "remember" and passes `rememberAllowed: false`; the broker refuses a memory or a saved-login card on the `benchmark` channel, saved or declined. A card the run leaves for its owner is withdrawn unanswered when the trial is graded. |

### Other decisions

| Topic | Decision | Why |
|---|---|---|
| One trial at a time | One live benchmark per node and profile (409 otherwise; a benchmark that lets the fabric pick the node conflicts with any other on that profile), and one running trial per benchmark. | Two runs in one browser profile would spoil both. |
| The job | `benchmark.advance` is never deduplicated. Passes of one benchmark are serialised with a transaction-scoped advisory lock, and every write is conditional on the state read. | A pass that is already running may be past the check a new one is queued for; collapsing into it would leave the benchmark waiting until the timeout. An extra pass costs a few reads. |
| Grading | In the run-end hook, and again by any pass that finds a running trial with an ended run. One conditional write moves the trial out of `running`; only its writer adds the cost. | The hook is the fast path; the pass covers a hook that failed or a process that died. |
| Why the benchmark stopped a run | Written on the trial (`failureReason`: `timeout`, `asked_person`, `cancelled`) before the run is cancelled; the grader reads it. | The run only says "cancelled". |
| The verdict | The checks decide `pass` or `fail`, whatever the agent claimed, so a false failure (it said it failed and the state is right) is visible. A timeout and an unscripted question are always `fail`. A run that could not work (no browser, no model, a provider error), a grader that threw and a deleted run are `error`. A cancelled benchmark or a run somebody stopped is `skipped`. | `error` and `skipped` say nothing about the agent and are left out of its rates (#742). |
| A timeout | Wall-clock from the trial's start, including time in the queue. The run is stopped through the ordinary cancel path; if it has not ended a minute later (no job holds it), the benchmark ends it. | A benchmark must not wait for a run nobody is driving. |
| Site reachability | A check of the settings, never a network call: a loopback default is refused, an address the administrator set is taken as given. | The API cannot tell what a node on another network reaches; a development default obviously fails. |
| Cached tokens | `benchmark_trials.cached_input_tokens`, copied from the run with the other metrics. | The scorecard reports them (#742) and the run may be gone by then. |
| The scripted owner's rules | Which rules are spent is recomputed from the run's questions, oldest first; nothing is stored. | The same questions give the same answers on any replica and after a crash. |

## Still to decide, by the issue that builds it

- **The scorecard's exact definitions** (#742): the interval method, cost per success with unpriced runs, what counts as a false success.
