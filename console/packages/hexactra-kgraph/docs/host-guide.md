# Host guide

A host embeds the package by binding its ports. The package reaches the outside world only through them. A host is "correct" when each binding keeps the guarantees below. The package cannot check most of them itself.

## The ports

All of them are in `./ports`. `KgraphPorts` is the set the executor takes.

| Port | Methods | A correct binding guarantees |
|---|---|---|
| `ProcedureStorePort` | `getProcedure`, `findProcedureForTask`, `listProcedures`, `putProcedure`, `getVersion`, `listVersions` (newest first), `putVersion`, `setVersionState`, `activate`, `recordEvidence`, `deleteAll` | **Owner isolation**: no call returns or changes another owner's record, even given its id. **Immutable versions**: `putVersion` refuses an existing id, and only `setVersionState` and `recordEvidence` change a stored version. **Checked state moves**: `setVersionState` is compare-and-set on `expected` and applies only moves `canTransition` allows. **One active version**: `activate` leaves exactly one `active` version per procedure, retires the earlier one and sets `activeVersion`, in one transaction. **Complete deletion**: `deleteAll` removes every procedure, version and evidence row of the owner. |
| `ToolInvokerPort` | `invoke({ tool, args, step, commitClass })` | Every call goes through the host's **one** tool wrapper, so Stop, Pause, the gates, the trace and intent recording apply exactly as for a model-chosen call. A refusal, a Stop or a Pause is **reported** (`refused`, `stopped`, `paused`), not thrown. A commit-class call whose earlier outcome is unknown is never sent again. A `secret` binding arrives as a reference that the host's secret path types; the package never holds the value. |
| `StateProbePort` | `location`, `viewDigest`, `elementPresent` | Reads only: no call changes the page, the desktop or an account. A value that is not available is `null`, never a guess. No typed value, secret or image is returned; a view digest is a hash of structure, not text. |
| `JudgePort` | `judge`, optional `locate` | The model sees only the goal, the declared inputs and the fixed schema (for `locate`, the step's tool, role, label and anchor, and the page's numbered controls as data). The call goes through the host's model routing and budgets. A result that does not fit the schema is `ok: false`, never a partial value. A host without `locate` skips that recovery rung. |
| `ClockPort` | `now`, `sleep` | `sleep` resolves early, without throwing, when the run is stopped. |
| `IdPort` | `next(prefix)` | Unique ids that match the schema's id pattern (`[A-Za-z0-9._:-]`, at most 200 characters). |
| `TelemetryPort` | `span`, `count`, `log` | Never throws into the caller. Never records a typed value, a secret or page text. `noopTelemetry` is a valid binding. |

The MCP handlers add one more port, `ProcedureRunPort` (`./mcp`): `start(owner, procedure, inputs)` starts a run through the host's existing run start path. See [mcp.md](mcp.md).

## Embedding, step by step

1. Bind `ProcedureStorePort` to your database. Run `runStoreConformance` from `./testing` against it in your own test suite (see "The conformance kit").
2. Bind `ToolInvokerPort` to your tool wrapper. Never call a tool around it.
3. Validate every version with `validateVersion(version, { tools, isSensitive })` before you store or run it. Pass your own `isSensitive` if you have a sensitive-pattern table. The default (`defaultIsSensitive`) is conservative.
4. Decide the mode with `effectiveMode` from your switches. Every level should default to off.
5. Treat any error from the package as "use the agent". A Knowledge Graph failure must never fail a run.
6. Compile only from facts your server recorded: build `TraceEvent`s with `bindArguments` while the run happens, and pass them to `compileTrace`. Never pass model text or page prose.
7. Keep promotion with the owner. Store a `sensitive` repair as a candidate that waits for the owner's own approval in your UI. Never approve it through a token, a webhook, a CLI or an AI app.

## Running a procedure

`executeProcedure(version, inputs, ports, options)` (`./execute`) walks a version and returns an `ExecutionReport`:

- `status`: one of `completed`, `failed_check`, `refused`, `stopped`, `paused`, `error`, `needs_owner`, `agent`, `missing_input` (a required input is empty; nothing ran) or `halted` (`options.before` returned `stop`).
- `steps`: one entry per step, with `done`, `skipped`, `failed_check`, `refused`, `stopped`, `paused`, `error`, `needs_owner` or `agent`, the invoker's result digest, and for a failed check what was expected and observed.
- `outputs`, and `results`: the steps' results, in memory only, for a restart.
- `resume`: the first step not done, with what was expected and what was observed (hosts, paths, digests and selectors; never page text).
- `judgeCalls` and `toolCalls`.

The executor never retries. A failed check, a refusal, a Stop or a Pause ends the walk.

- `call`, `extract` and `check` steps never call a model. A `judge` step calls `JudgePort.judge` once.
- `ask` ends the walk with `needs_owner`. Ask through your own question flow, then call again with `fromStep`.
- `agent` ends the walk with `agent`. Run your agent until the step's `until` checks hold, then call again from the next step.
- `options.before(step)` may return `stop` (budgets, a deadline, a lease). `options.after(step)` runs after each step that is done, so you can keep the resume point.
- `options.recovery` takes a `RecoveryLadder` of your `RecoveryStrategy` objects, tried before the walk stops ([concepts.md](concepts.md), "Running").
- `options.evidence: { owner }` records per-step evidence through the store (best effort; a failure is counted, not thrown).

### Crash-safety contract

1. Before a commit-class step is invoked, the executor awaits `options.onCommitIntent(step)`. Record the intent durably **before** you return.
2. The executor can restart from a resume point. Call it again with `fromStep`, `done` (the steps already done, with their results or `null`) and `unknown` (commit-class steps whose intent you recorded but whose outcome you do not know).
3. A commit-class step in `unknown` is **never invoked again**. The report says `needs_owner` and the owner decides.

```ts runnable
import assert from 'node:assert/strict';
import { executeProcedure } from '@marinoscar/hexactra-kgraph/execute';
import { aVersion, call, fakePorts, lit, replies } from '@marinoscar/hexactra-kgraph/testing';

const version = aVersion([
  call('c1', 'mail_search', { q: lit('subject:invoice') }),
  call('c2', 'mail_send', { to: lit('team@example.com') }, { commitClass: true }),
  call('c3', 'navigate', { url: lit('https://example.com/') }),
]);
const ports = fakePorts();
ports.tools.on('mail_search', replies.ok('', { items: [] })).on('mail_send', replies.crash()).on('navigate', replies.ok());

// Your durable intent record (a database row in production).
const intents: string[] = [];
const onCommitIntent = async (step: { id: string }) => void intents.push(step.id);

// The send is invoked after its intent is recorded, and the process "crashes" before its result arrives.
const first = await executeProcedure(version, {}, ports, { goal: 'Send the invoice summary', onCommitIntent });
assert.deepEqual(intents, ['c2']);
assert.equal(first.status, 'error');

// Restart: c1 is done; c2 has an intent and no outcome, so it is unknown.
const again = await executeProcedure(version, {}, ports, { goal: 'Send the invoice summary', fromStep: 'c1', done: { c1: first.results.c1! }, unknown: ['c2'], onCommitIntent });
assert.equal(again.status, 'needs_owner');
assert.equal(again.resume?.step, 'c2');
assert.equal(ports.tools.calls.filter((c) => c.tool === 'mail_send').length, 1); // sent at most once, never repeated
assert.equal(ports.tools.calls.some((c) => c.tool === 'navigate'), false); // nothing after it ran
```

## The conformance kit

`runStoreConformance(host)` (`./testing`) proves a `ProcedureStorePort` binding keeps the store's guarantees:

- reads newest first;
- owner isolation (another owner reads nothing and changes nothing);
- immutable versions;
- compare-and-set along allowed transitions only;
- atomic activation under a race;
- evidence per version and per step;
- deleting one owner's data only.

It uses jest's globals (`describe`, `it`, `expect`, `beforeEach`, `afterEach`), so call it at the top level of a spec file:

```ts sketch
import { runStoreConformance } from '@marinoscar/hexactra-kgraph/testing';

runStoreConformance({
  name: 'my database store',
  open: async () => ({
    store: new MyStore(db), // your ProcedureStorePort
    owners: ['user-a', 'user-b'], // two real user ids
    task: async (owner, key) => createTask(owner, key), // a real task id of that owner
    close: async () => cleanUp(),
  }),
});
```

The package runs the kit against its own in-memory store (`test/store-conformance.spec.ts`). The console runs it against PostgreSQL (`apps/api/test/kgraph-switches.db.spec.ts`).

`test/second-host.spec.ts` is a second, minimal host with no harness, browser or database: a key-value "app" with three tools that binds the ports by hand and runs a procedure.

## The harness bridge

`./harness` binds the ports for a host built on `@marinoscar/hexactra-agent`:

- `harnessToolInvoker`: every call through `executeTool`, looked up in the run's registry (a tool not offered to the run is a refusal).
- `harnessJudge`: one call on a model route, counted against the run's budgets.
- `harnessProbe`, and `watchCalls` (an observer that keeps the last call for the invoker and the probe).
- `replayPhase`: runs a procedure before the loop. It checks the loop's own boundaries before every step, keeps the commit intent in the run's memory (checkpointed), asks the owner before each commit-class step in a verification run, and hands over to the loop with a note on any mismatch. It never throws.
- `runSubProcedure` and `bindParameters`: a procedure called as a tool inside a run, depth 1. A sensitive parameter is filled only from the run's own inputs.

## The Hexactra Console

The console binds:

- the store to PostgreSQL (`kg_` tables, `apps/api/src/kgraph/prisma-procedure-store.ts`);
- the tool invoker to `executeTool`;
- the judge to `harnessJudge` on the run's `fast` model route from its policy snapshot;
- the sensitive predicate to its own sensitive-pattern table.

See `console/docs/decisions/knowledge-graph.md` and `console/docs/knowledge-graph.md`.
