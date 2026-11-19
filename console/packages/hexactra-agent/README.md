# @marinoscar/hexactra-agent

A generic agent harness behind ports. It runs a model that calls tools toward a goal, and gives every host the same rules: Stop and Pause are seen before the next tool, every tool call goes through one wrapper (gates, intent records, recording), a crash is recoverable from the step rows, budgets and stalls end a run in a typed way, and a person can be asked a question.

It knows nothing about browsers, the Hexactra fabric, Prisma, NestJS or a provider SDK. It imports only `zod`, `@opentelemetry/api` and `node:` built-ins (a test scans the built output). A host binds the ports; the browser toolset is a separate package, [`@marinoscar/hexactra-browser-agent`](../hexactra-browser-agent/README.md).

**Stability: experimental.** The package is `0.1.0-next.x`, used by one real host (the Hexactra Console) and one minimal host in its own tests. The ports may change until a second real host uses it. It is not published to npm yet (decision record: [`docs/decisions/agent-packages.md`](../../docs/decisions/agent-packages.md)).

## Ports

A host implements these (`@marinoscar/hexactra-agent/ports`); each doc comment says what a correct implementation guarantees.

| Port | The harness needs |
|---|---|
| `ModelPort` | run one tool-calling chunk: instructions, input, tools, limits, an `AbortSignal`, an `onStep` callback; returns usage |
| `RunStorePort` | step rows with their phase (`intent`, `done`, `unknown`), checkpoints, the memory, the tier, the lease check (`holdsRun`), transitions, finishing |
| `QuestionPort` | open a question for a person; an answer is delivered once |
| `ControlPort` | the owner's Stop and Pause, as signals |
| `ApprovalPort` | optional: the owner's saved approvals; absent means every gated step asks |
| `PolicyPort` | the run's policy snapshot: budgets, tiers, stall settings |
| `EventsPort` | metrics, the live step count, notifications |
| `TelemetryPort` | spans and metrics of a job (`noopTelemetry` binds none) |
| `PicturePort` | optional: masked trace pictures |
| `ClockPort`, `IdPort` | time and ids, so tests are deterministic |

## What it exports

- `createRunLoop(ports, options)` (`/engine`): binds a run to its ports and returns `{ context, run(profile) }`.
- `RunContext`, `RunnerTool` and `defineRunnerTool`, `ToolRegistry`: what a tool is (`execute(ctx, args)` returning the text the model reads, the step recorded through `ctx.record`).
- `executeTool` (`/engine`): the one wrapper around every tool call (Stop, Pause, trace span, gates, commit marker).
- `Gate` and `GatePipeline`: gates decide from facts the server read, never from the model. The site and risk gates are not here; they plug in.
- `BudgetTracker` and the budget functions, the stall detector, `reconcileSteps` (crash recovery), the input builder with its stable-prefix guarantee, `composeInstructions`, typed outcomes and errors (`LeaseLost`, `ModelUnavailable`).
- `/testing`: in-memory fakes of every port, `ScriptedModel`, `fakeRun`, `fakeHarnessHost` and `runHarnessHostConformance`.

## A minimal host

```ts
import { createRunLoop } from '@marinoscar/hexactra-agent/engine';
import { defineRunnerTool, noopTelemetry, type Ports } from '@marinoscar/hexactra-agent';
import { FakeControl, FakeQuestions, FakeRunStore, ScriptedModel, fakePolicy, textProfile } from '@marinoscar/hexactra-agent/testing';

const ports: Ports = { model, store, questions, control, policy: fakePolicy(), events, telemetry: noopTelemetry, clock: { now: Date.now }, ids: { uuid: randomUUID } };
const loop = createRunLoop(ports, { run: { id: 'run-1', userId: 'u', orgId: null, goal: 'Write two notes.', trigger: null, taskId: null, conversationId: null }, memory: { log: [], chunks: 0 }, ext: {} });
const outcome = await loop.run(textProfile([note, finish]));   // 'succeeded' | 'failed' | 'cancelled' | 'waiting_human' | 'paused' | 'continue' ...
```

`test/second-host.spec.ts` is this, run for real over the fakes.

## Prove your bindings

```ts
import { runHarnessHostConformance } from '@marinoscar/hexactra-agent/testing';

runHarnessHostConformance({ name: 'my host', open: async () => ({ job, claimAgain, pressStop, answer, readMemory, close }) });
```

The suite checks: a checkpoint survives a simulated crash, the run belongs to one job at a time (the worker token excludes a second job), a Stop pressed from outside is seen before the next tool, and a question's answer is delivered once. It uses the `describe`/`it`/`expect` globals of Jest or Vitest. The console runs it over its Prisma, lease, stop-signal and question bindings in `apps/api/test/agent-host-conformance.db.spec.ts`.

## Build

```bash
npm run build:packages   # from console/: this package, then the browser toolset
npm run test:packages
```

CommonJS, `tsc -p tsconfig.build.json` to `dist/` (git-ignored). The apps import the built output, so build before the apps' typecheck and tests.
