# The goal runner

How a browser run is driven, in code: the packages and the host, the life of one tool call, the layering rules, and the checklist for adding a tool. For what a run is to the owner see [runs.md](runs.md); for the model tiers, budgets and stalls see the README, "Agent policies"; for secrets see [secrets.md](secrets.md).

The agent harness and the browser toolset are **workspace packages** (E38.9, #614; [decision record](decisions/agent-packages.md)); the console's API **hosts** them. `apps/api/src/runner/` keeps only the bindings: `goal-runner.service.ts` is a thin NestJS service (about 150 lines) that claims the run's lease and its stop signal, starts the run, builds its ports and context and calls the loop.

## The layers

```
packages/hexactra-agent/                 @marinoscar/hexactra-agent: the generic agent harness. No browser, no database, no framework.
  src/ports/             the interfaces the harness reaches the outside through (doc comments say what a correct implementation guarantees)
  src/run-context.ts     RunContext: ports and plain state (the memory, the counters, the budget tracker, the stall state), no service
  src/tool-def.ts registry.ts  RunnerTool and ToolRegistry
  src/gate-pipeline.ts   the Gate interface and the pipeline that runs the gates a tool names
  src/execute-tool.ts    the one wrapper around every tool call
  src/steps.ts           record, openIntent, note, routing: the step rows and the model's log
  src/input-builder.ts instructions.ts   the round's text (stable prefix first) and the instructions composed from sections
  src/stall.ts budget.ts tiers.ts ...    stall detection, budgets, tier changes
  src/reconcile.ts       crash recovery: the step rows are the truth
  src/run-loop.ts outcomes.ts  the chunk loop; how a run ends or waits (closing, cancelling, pausing, wrap-up, stalls)
  src/engine.ts          what only a host imports: createRunLoop, the loop, the wrapper, the context factory   (export ./engine)
  src/testing/           in-memory fakes of every port, a scripted model, a ready context, fakeHarnessHost and runHarnessHostConformance   (export ./testing)
packages/hexactra-browser-agent/         @marinoscar/hexactra-browser-agent: the Hexactra browser toolset. Imports only the harness.
  src/tools/             one file per tool or small family: observe, navigate, click, type, pointer, desktop, look, request-human, type-secret, finish
  src/gates/             the site gate (allowed sites) and the risk gate (the confirmation gate #550, saved approvals #555)
  src/act.ts page.ts     running one browser action and turning its result into the text and the step; asking the page itself (not an action)
  src/browser-port.ts    the browser as a port: act, typeSecret, capture, captureTrace
  src/vision.ts round.ts screenshots with numbered marks, and how a round is shown to the model
  src/instructions.ts    the browser agent's system instructions, as sections
  src/testing/           a scriptable FakeBrowser and a browser context over the fakes   (export ./testing)
apps/api/src/runner/host/                the bindings to the console. The only layer that imports console services.
  prisma-run-store.ts model-port.ts question-port.ts ...   one file per port, over Prisma, the AI service, the fabric and the question broker
  tools/                 the app's own tool families: saved logins, identity details, cards, memories (they reach console services)
  start.ts build-context.ts before-loop.ts   the setup of a job: resume, policy snapshot, session, ports, tools, gates, createRunLoop
apps/api/src/runner/goal-runner.service.ts   claims the lease and the stop signal; startRun -> buildRun -> beforeLoop -> loop.run
```

The rules between them are tests, and each proves that it fires:

- `packages/hexactra-agent/test/imports.spec.ts` scans the **built output** and the sources: the harness imports only `zod`, `@opentelemetry/api` and `node:` built-ins (no NestJS, Prisma, provider SDK, platform package, fabric client or console path);
- `packages/hexactra-browser-agent/test/imports.spec.ts` does the same for the toolset (it may also import `@marinoscar/hexactra-agent`), and a **tool** imports no loop code (`@marinoscar/hexactra-agent/engine`) and **no other tool**; a **gate** imports no loop code. The composer `src/tools/index.ts` lists the tools of a family and is the only file that imports them;
- `apps/api/test/runner-layering.spec.ts`: the same tool rule for the host's own tools (`host/tools/`, composer `saved-card-tools.ts`), and no production code imports a test kit;
- `apps/api/test/architecture/no-agent-logic.spec.ts`: no tool (outside `runner/host/tools/`), no gate and no loop code in `apps/api/src/`, and `runner/harness` and `runner/browser` do not exist.

The apps import the packages' **built output**: run `npm run build:packages` (from `console/`) after `npm ci` and after a change in a package; the root `build`, `typecheck` and `test` scripts do it first. Some pure helpers keep their old import path in the app (`runner/budget.ts`, `stall.ts`, `cost.ts`, `reconcile.ts`, `policy.ts`, `vision.ts`, ...) as one-line re-exports of a package subpath, so the specs and callers that use them did not change.

## The ports

The harness reaches the outside only through `@marinoscar/hexactra-agent/ports`; `host/` binds each to a console service.

| Port | The harness needs | Bound to |
|---|---|---|
| `ModelPort` | run one tool-calling chunk, with an `onStep` callback and an abort signal | `AiService.runTools` (`host/model-port.ts`); a provider that cannot be reached is `ModelUnavailable`, so the loop may use the tier's fallback model |
| `RunStorePort` | step rows, checkpoints, intents, the lease, activity, transitions | Prisma, the tasks service and `RunLease` (`host/prisma-run-store.ts`) |
| `QuestionPort` | open a question for a person | the fabric's handoffs and the question broker (`host/question-port.ts`) |
| `ControlPort` | the owner's Stop and Pause | the job's `RunStopSignal` and the run's flags |
| `ApprovalPort` | the owner's saved approvals | `ApprovalRulesService` (always bound; `enabled` says whether a store is there) |
| `PolicyPort` | the run's policy snapshot, what each tier resolves to, masking | `runs.policy_snapshot` and `tier-request.ts` |
| `EventsPort` | metrics, the live step count, notifications | `TasksService` and `RunNotifier` |
| `TelemetryPort` | spans and metrics of the job | `AgentTrace` |
| `PicturePort` | the masked trace pictures | the browser host and object storage (`host/pictures-port.ts`) |
| `ClockPort`, `IdPort` | time and ids | `Date.now`, `randomUUID` |

The browser layer has one more port, `BrowserPort` (`act`, `typeSecret`, `capture`, `captureTrace`), bound to the run's fabric session (`host/fabric-browser.ts`).

## The life of one tool call

Every tool the model calls goes through `executeTool` (`hexactra-agent/src/execute-tool.ts`), in this order:

1. **Stop, then Pause** (E38.1, E38.2). A call chosen before the owner pressed it is not carried out; nothing is gated, traced, executed or recorded. The model reads "Stopped by the owner." or "The owner paused the run. This was not done." and the chunk ends.
2. **The trace span** opens (`execute_tool <name>`, E38.4): everything below is inside it.
3. **The gates** the tool names (`gated`: gate name to the function that builds that gate's request) decide, in the order listed, from facts the server read itself, never from the model's words. The first that does not allow ends the call: a refusal is recorded as a failed step and its text is what the model reads.
4. **The commit-class marker** (`commits: true`). The tool runs marked as one: the first action it sends is intent-recorded before it goes (E38.3), so a job that dies between the send and the result leaves a step in `intent`, which the next job marks `unknown` and never repeats.
5. **The tool runs** through the context and returns the text the model reads. It records its step through `ctx.record(...)` (or `act`, which does): that one service writes the step row, the step count and the memory in a single transaction conditional on the lease, adds the action to the budget, feeds the stall detector, and appends the model's log line. A tool never touches the database or a client of its own.

What a tool may do through `ctx`: `ctx.record`, `ctx.openIntent`, `ctx.note` (a trace record that is not an action), `ctx.askPerson`, `ctx.setActivity`, `ctx.budgetStop`, `ctx.preflight`, `ctx.checkpoint`, `ctx.memory`, `ctx.state`, and the ports. A browser tool additionally has `ctx.ext` (the browser, the site list, the marks, the masking hooks).

## A structured result: task outputs (E39.5)

A task can declare outputs the run must return ([api-tasks-runs.md](api-tasks-runs.md#task-outputs)). The harness knows only that a finished run may carry a `StructuredResult` (`fields` by key, `complete`) and a count of refused `finish` calls (`memory.outputAttempts`); what a field is, how it is read and the words about it are the host's (`runner/outputs.ts`), handed to the toolset as an `OutputsHandle` in `ctx.ext.outputs` (null for a task without outputs):

- **The `finish` tool** offers `ctx.ext.outputs.parameters` through the tool's optional `parametersFor(ctx)` (a pure function of the run, so the schema is identical in every round; without outputs `parameters` is offered, unchanged), reads what it was given with `decide`, refuses a success finish with a problem twice at most (a note step, not an action), and strips a sensitive value from the result text with `scrub`. A failed finish and the wrap-up (`state.wrappingUp`) are never refused.
- **The instructions** gain the list of outputs in `host/build-context.ts` (`instructionsWithOutputs`), once per run, so the stable prefix is unchanged between rounds.
- **The loop** asks for them when the model stops without `finish`: `LoopProfile.beforeImplicitFinish` returns the nudge (and counts the attempt); `wrapUpNote` adds a line to the wrap-up call's input.
- **Ending the run** (`closeRun`, `wrapUp`, the loop's finish) passes `outputs` and `outputsComplete` to `RunStorePort.finish`, which the host writes with the status in one transition; a run with outputs that ends without them is marked `outputsComplete: false` there.

## A round, as the loop sees it

`runLoop` (`hexactra-agent/src/run-loop.ts`, started by `createRunLoop(ports, options).run(profile)`) checks Stop, Pause, the budgets and the hop to a new job at each chunk boundary, moves the tier if the policy says so, folds in the owner's chat guidance, asks the profile to `observe` (the browser takes its screenshot), judges the stall detector on the new page, builds the input and calls the model for up to `callsPerChunk` tool calls. After the chunk it saves the memory and the usage, and decides: finished, waiting for a person, paused, wrapped up on a budget, handed on, stalled. The input is built so that the provider's cache holds (#406): the **stable prefix** (goal, memories, context, allowed sites, the progress log) is identical between rounds of a chunk and comes first; the volatile status (steps used, the owner's ask rules for the page) comes last, after the screenshots. `packages/hexactra-agent/test/harness.spec.ts` asserts it.

## How to add a tool

1. **Pick the package and the group.** A browser or desktop tool goes in `packages/hexactra-browser-agent/src/tools/`; a tool that reaches a console service (a provider, a mailbox, a memory) in `apps/api/src/runner/host/tools/`. The harness package has no tools of its own: a tool that needs only the context is defined by whoever hosts the harness (its tests define one). `group` is `browser`, `desktop`, `human`, `control`, `secrets`, `memory`, later `connection:<id>`: it lets a policy or a task switch a family on and off. **A new tool, gate or loop behaviour goes in a package, with its test in the package; the app only binds ports** (`no-agent-logic.spec.ts`).
2. **Write the file** with `defineRunnerTool({ name, group, description, parameters, execute })`: the zod schema (every field the model may omit is `nullable`, as the strict schemas of the providers require), `execute(ctx, args, gate)` returning the text the model reads. One file per tool or small family. Import only `@marinoscar/hexactra-agent`, the toolset's own modules (for a browser tool) and your own helpers: **not another tool, not the loop**; the import-scan specs fail if you do.
3. **A tool name is permanent.** A model learns names; never rename or remove one. Descriptions are the prompt: a change is a change of what the agent does and needs its own issue and snapshot update.
4. **Decide `commits`.** `true` when the tool can do something irreversible (a click that passes the risk gate, typing a secret, later sending mail or a provider fill): its first action is intent-recorded.
5. **Decide the gates** (`gated`). A tool that opens a URL names the `site` gate and builds `{ url, refusal }`; a tool that acts on a target the page describes names the `risk` gate. A new kind of check is a new `Gate` (`name`, `check(ctx, request, call)` returning `allow`, `refuse(text, step)` or `ask(question)`), defined in a package and registered in the host's pipeline (`host/build-context.ts`).
6. **Decide `available(ctx)`** when the tool must be hidden (vision off, no desktop, a connection not enabled for this run). The registry offers tools in **registration order and never sorts them**: the order is part of the stable prefix.
7. **Add a usage note** (`usage`) only if the tool needs words in the instructions; notes are appended after the sections in registration order, so the instructions stay byte-identical between rounds. No tool contributes one today.
8. **Register it**: in the toolset's composer (`packages/hexactra-browser-agent/src/tools/index.ts`, or the host's `build-context.ts` for an app family), in the position it should be offered. Rebuild the packages (`npm run build:packages`) before the app sees it.
9. **Test it alone** against a fake context: `fakeBrowserRun()` (`@marinoscar/hexactra-browser-agent/testing`) for a browser tool, `fakeRun()` (`@marinoscar/hexactra-agent/testing`) for a generic one; see `packages/hexactra-browser-agent/test/browser-tools.spec.ts`. Test the refusal, the success and what the step row says.
10. **Update the snapshot deliberately.** `apps/api/test/runner-characterisation.db.spec.ts` pins the tool list (names, descriptions, JSON schemas), the model input of each round, the fabric actions, the step rows and the final run row. A new tool changes the first: `npx jest --config ./test/jest.config.js --testRegex 'runner-characterisation\.db\.spec\.ts$' -u` from `apps/api`, and read the diff.
11. **MCP parity.** The MCP tools (`apps/api/src/mcp/mcp.tools.ts`) are a separate surface that is not touched by a runner tool. Decide whether the capability also needs an MCP tool and a row in [parity.md](parity.md); if so, follow the MCP rules in `AGENTS.md`.
12. **Secrets.** A tool that types or reads something sensitive records its step with `{ secret: true }` (not fed to the stall detector), never puts a value in the step, the memory or its answer, and masks what it reads back through `ReadMasking`.

## Tests

| Spec | What it proves | Needs |
|---|---|---|
| `packages/hexactra-agent/test/imports.spec.ts` | the harness imports only `zod`, `@opentelemetry/api`, `node:`; the rule fires | the built `dist/` |
| `packages/hexactra-agent/test/harness.spec.ts` | the gate pipeline, `executeTool` (order, Stop and Pause, commit marker), the input builder and its stable prefix, the loop with a trivial tool, crash recovery | nothing (fakes) |
| `packages/hexactra-agent/test/second-host.spec.ts` | a second, minimal host (not the console) runs a scripted goal to completion on the fakes: the harness is embeddable | nothing (fakes) |
| `packages/hexactra-agent/test/conformance.spec.ts` | `runHarnessHostConformance` passes over the package's in-memory host | nothing |
| `packages/hexactra-browser-agent/test/browser-tools.spec.ts` | navigate, new_tab, click and the risk gate, saved approvals, look, request_human, finish, observe_elements, type_handoff_secret | the built harness, a fake browser |
| `packages/hexactra-browser-agent/test/imports.spec.ts` | the toolset imports only the harness; a tool imports no loop code and no other tool; the rules fire | the built `dist/` |
| `apps/api/test/runner-layering.spec.ts`, `architecture/no-agent-logic.spec.ts` | the host's own tools follow the tool rules; no agent logic in the app; the rules fire | nothing |
| `apps/api/test/agent-host-conformance.db.spec.ts` | `runHarnessHostConformance` over the console's real bindings: the Prisma store and its lease, the stop signal, the question port | the test database |
| `apps/api/test/runner-characterisation.db.spec.ts` | what the agent does, byte for byte: tools offered, input per round, fabric actions, step rows, the final run row | the test database |
| `apps/api/test/runner*.db.spec.ts`, `stall-escalation`, `saved-*`, `run-pause`, ... | the real bindings against a database, a scripted model and an in-memory fabric | the test database |

`npm run test:packages` (from `console/`) runs the first six; `npm run check:package-pack` dry-runs `npm pack` for both packages and checks the tarballs hold `dist/`, `README.md`, `LICENSE` and nothing else. Nothing is published.
