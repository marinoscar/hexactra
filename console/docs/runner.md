# The goal runner

How a browser run is driven, in code: the parts, the life of one tool call, the layering rule, and the checklist for adding a tool. For what a run is to the owner see [runs.md](runs.md); for the model tiers, budgets and stalls see the README, "Agent policies"; for secrets see [secrets.md](secrets.md).

The runner is `apps/api/src/runner/`. `goal-runner.service.ts` is a thin NestJS service (about 150 lines): it claims the run's lease and its stop signal, starts the run, builds its context and calls the loop. The work is in three layers beside it.

## The three layers

```
runner/
  goal-runner.service.ts   claims the lease and the stop signal; startRun -> buildRun -> beforeLoop -> runLoop
  harness/                 the generic agent harness. No browser, no database, no framework.
    ports/                 the interfaces the harness reaches the outside through (doc comments say what a correct implementation guarantees)
    run-context.ts         RunContext: ports and plain state (the memory, the counters, the budget tracker, the stall state), no service
    tool-def.ts registry.ts  RunnerTool and ToolRegistry
    gate-pipeline.ts       the Gate interface and the pipeline that runs the gates a tool names
    execute-tool.ts        the one wrapper around every tool call
    steps.ts               record, openIntent, note, routing: the step rows and the model's log
    input-builder.ts instructions.ts   the round's text (stable prefix first) and the instructions composed from sections
    stall.ts budget.ts tiers.ts ...    stall detection, budgets, tier changes
    reconcile.ts           crash recovery: the step rows are the truth
    run-loop.ts outcomes.ts  the chunk loop; how a run ends or waits (closing, cancelling, pausing, wrap-up, stalls)
    engine.ts              what only a host imports: the loop, the wrapper, the context factory
    testing/               in-memory fakes of every port, a scripted model and a ready context
  browser/                 the Hexactra browser toolset. Imports only harness/.
    tools/                 one file per tool or small family: observe, navigate, click, type, pointer, desktop, look, request-human, type-secret, finish
    gates/                 the site gate (allowed sites) and the risk gate (the confirmation gate #550, saved approvals #555)
    act.ts page.ts         running one browser action and turning its result into the text and the step; asking the page itself (not an action)
    browser-port.ts        the browser as a port: act, typeSecret, capture, captureTrace
    vision.ts round.ts     screenshots with numbered marks, and how a round is shown to the model
    instructions.ts        the browser agent's system instructions, as sections
    testing/               a scriptable FakeBrowser and a browser context over the fakes
  host/                    the bindings to the console. The only layer that imports console services.
    prisma-run-store.ts model-port.ts question-port.ts ...   one file per port, over Prisma, the AI service, the fabric and the question broker
    tools/                 the app's own tool families: saved logins, identity details, cards, memories (they reach console services)
    start.ts build-context.ts before-loop.ts   the setup of a job: resume, policy snapshot, session, ports, tools, gates
```

`test/runner-layering.spec.ts` enforces the lines between them, and proves that it fires:

- a file under `harness/` imports only `harness/`, `zod`, `@opentelemetry/api` and `node:` built-ins (no NestJS, Prisma, platform package, fabric client or console module);
- a file under `browser/` imports only `harness/` and `browser/`;
- a **tool** imports no loop code (`harness/engine` and what it exports, the service) and **no other tool**; a **gate** imports no loop code. Two composers (`browser/tools/index.ts`, `host/tools/saved-card-tools.ts`) list the tools of a family and are the only files that import them.

The harness is written this way so that extracting it into packages (#614) is a move: `harness/` becomes `@marinoscar/hexactra-agent` and `browser/` the browser toolset. The old paths of the pure helpers that moved (`runner/budget.ts`, `stall.ts`, `cost.ts`, `reconcile.ts`, ...) re-export from their new home so imports elsewhere did not change.

## The ports

The harness reaches the outside only through `harness/ports/`; `host/` binds each to a console service.

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

Every tool the model calls goes through `executeTool` (`harness/execute-tool.ts`), in this order:

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

`runLoop` (`harness/run-loop.ts`) checks Stop, Pause, the budgets and the hop to a new job at each chunk boundary, moves the tier if the policy says so, folds in the owner's chat guidance, asks the profile to `observe` (the browser takes its screenshot), judges the stall detector on the new page, builds the input and calls the model for up to `callsPerChunk` tool calls. After the chunk it saves the memory and the usage, and decides: finished, waiting for a person, paused, wrapped up on a budget, handed on, stalled. The input is built so that the provider's cache holds (#406): the **stable prefix** (goal, memories, context, allowed sites, the progress log) is identical between rounds of a chunk and comes first; the volatile status (steps used, the owner's ask rules for the page) comes last, after the screenshots. `test/runner-harness.spec.ts` asserts it.

## How to add a tool

1. **Pick the layer and the group.** A browser or desktop tool goes in `browser/tools/`; a tool that reaches a console service (a provider, a mailbox, a memory) in `host/tools/`. `harness/` has no tools of its own: a tool that needs only the context is defined by whoever hosts the harness (the tests define one). `group` is `browser`, `desktop`, `human`, `control`, `secrets`, `memory`, later `connection:<id>`: it lets a policy or a task switch a family on and off.
2. **Write the file** with `defineRunnerTool({ name, group, description, parameters, execute })`: the zod schema (every field the model may omit is `nullable`, as the strict schemas of the providers require), `execute(ctx, args, gate)` returning the text the model reads. One file per tool or small family. Import only the harness, the browser layer (for a browser tool) and your own helpers: **not another tool, not the loop**; `test/runner-layering.spec.ts` fails if you do.
3. **A tool name is permanent.** A model learns names; never rename or remove one. Descriptions are the prompt: a change is a change of what the agent does and needs its own issue and snapshot update.
4. **Decide `commits`.** `true` when the tool can do something irreversible (a click that passes the risk gate, typing a secret, later sending mail or a provider fill): its first action is intent-recorded.
5. **Decide the gates** (`gated`). A tool that opens a URL names the `site` gate and builds `{ url, refusal }`; a tool that acts on a target the page describes names the `risk` gate. A new kind of check is a new `Gate` (`name`, `check(ctx, request, call)` returning `allow`, `refuse(text, step)` or `ask(question)`), registered in the host's pipeline.
6. **Decide `available(ctx)`** when the tool must be hidden (vision off, no desktop, a connection not enabled for this run). The registry offers tools in **registration order and never sorts them**: the order is part of the stable prefix.
7. **Add a usage note** (`usage`) only if the tool needs words in the instructions; notes are appended after the sections in registration order, so the instructions stay byte-identical between rounds. No tool contributes one today.
8. **Register it**: in the family's composer (`browser/tools/index.ts`, or the host's `build-context.ts` for an app family), in the position it should be offered.
9. **Test it alone** against a fake context: `fakeBrowserRun()` (`browser/testing/fake-browser.ts`) for a browser tool, `fakeRun()` (`harness/testing/`) for a generic one; see `test/runner-browser-tools.spec.ts`. Test the refusal, the success and what the step row says.
10. **Update the snapshot deliberately.** `test/runner-characterisation.db.spec.ts` pins the tool list (names, descriptions, JSON schemas), the model input of each round, the fabric actions, the step rows and the final run row. A new tool changes the first: `npx jest --config ./test/jest.config.js --testRegex 'runner-characterisation\.db\.spec\.ts$' -u` from `apps/api`, and read the diff.
11. **MCP parity.** The MCP tools (`apps/api/src/mcp/mcp.tools.ts`) are a separate surface that is not touched by a runner tool. Decide whether the capability also needs an MCP tool and a row in [parity.md](parity.md); if so, follow the MCP rules in `AGENTS.md`.
12. **Secrets.** A tool that types or reads something sensitive records its step with `{ secret: true }` (not fed to the stall detector), never puts a value in the step, the memory or its answer, and masks what it reads back through `ReadMasking`.

## Connection tools, the connection gate and runs without a browser (E39.7)

- **A tool family with a gate.** `host/tools/connections/` is the family (`connections_list`, mail, calendar, documents; group `connection`), registered by `host/build-context.ts` only when the run has a connection (`available` also follows the switches on and the run's access). Its shared helpers (`support.ts`, `commit.ts`, `artifacts.ts`) are listed as tool support in `test/runner-layering.spec.ts`, `index.ts` is its composer. A gated tool names the `connection` gate (`host/gates/connection-gate.ts`): its request builder resolves the account and validates the arguments against the capability schemas, and the gate answers `allow` (the owner approved exactly this call, or a saved `connection` rule), `refuse`, or **`ask`**. This is the first built-in gate that asks: `executeTool` opens the question and tells the model to wait.
- **Questions that need no browser.** `QuestionPort.open` may return `handoffId: null`: the question is created in the broker (`QuestionsService.create`, with the run's id) and the run goes `waiting_human` with no handoff, like a task's parameter form. It is used for every question with an `action` (the card of a connection call) and for any question a run with no browser yet asks. The answer resumes the run through `QuestionsService.resumeRun`; `HandoffCheckHandler` is the safety net for a lost resume and for a question that expired (the model is told the owner did not help). `startRun` folds the answer back from the question (`host/connections/answer.ts`).
- **Content stays out of the record.** A step holds recipients, subject, names and sizes, the length and a short hash of a body; the question carries a one-line `action.summary` that the step, the memory (`askedPrompt`), the run notification and the question webhook use instead of the card's text. The trace span of a connection call carries only `hexactra.connection.provider`, `.capability` and `.effect` (`TelemetryPort.toolAttributes`, a closed list in `trace-attributes.ts`).
- **The browser opens lazily.** A run with connections (and `needsBrowser: auto`) starts with no fabric session: `FabricBrowser` takes an `ensure` that `host/browser-session.ts` implements, called by the first `act`, `typeSecret` or screenshot. `observeRound` takes no picture while there is no session. `needsBrowser: never` registers only `request_human`, the connection tools and `finish`.
- **Tests.** `test/runner-connections.db.spec.ts` (availability, reads and caps, the card, approval and decline, "Don't ask again" and the recipient rule, the account being explicit, injection, a crash around a send, the step rows, the browser-less runs), `test/chat-connections.db.spec.ts` (the chat's read tools), and `test/support/connection-run-kit.ts`, which runs the real runner over the capability double.

## Tests

| Spec | What it proves | Needs |
|---|---|---|
| `test/runner-layering.spec.ts` | the layers hold; the rule fires on a violation | nothing |
| `test/runner-harness.spec.ts` | the gate pipeline, `executeTool` (order, Stop and Pause, commit marker), the input builder and its stable prefix, the loop with a trivial tool, crash recovery | nothing (fakes) |
| `test/runner-browser-tools.spec.ts` | navigate, new_tab, click and the risk gate, saved approvals, look, request_human, finish, observe_elements, type_handoff_secret | nothing (fake browser) |
| `test/runner-characterisation.db.spec.ts` | what the agent does, byte for byte: tools offered, input per round, fabric actions, step rows, the final run row | the test database |
| `test/runner*.db.spec.ts`, `stall-escalation`, `saved-*`, `run-pause`, ... | the real bindings against a database, a scripted model and an in-memory fabric | the test database |
