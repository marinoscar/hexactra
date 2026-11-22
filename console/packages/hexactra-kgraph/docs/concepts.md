# Concepts

## The idea

An agent loop is an *interpreter*: a model decides every step of every run. A procedure turns the model into a *compiler and repairer* instead. The model discovers the path once and the steps are kept. Later runs replay them with a check after each, and the model comes back only when a check fails.

The package holds no opinion about what a tool does. A "tool" is a name in the host's catalogue with a `family` (for example `browser`, `accounts`, `secrets`, `desktop`, `mcp:<id>`) and a `commits` flag (it sends, pays or otherwise acts in a way that cannot be taken back).

## The graph

Per owner, the graph holds **procedures** and what they touch. Every record is scoped to one owner. Nothing is shared between owners.

| Node | What |
|---|---|
| `Task` | The owner's saved task a procedure belongs to. |
| `Procedure` | A task's learned way of doing its job, across versions. At most one per task. |
| `ProcedureVersion` | One immutable, runnable graph of steps. |
| `Step` | One step (kinds below). |
| `Site` | A registrable domain a step touches (`example.com`). |
| `Screen`, `Element` | A site's surface graph: screens (a site and a path pattern), and elements by role, label, tag, an anchor and up to three selector candidates. |
| `Account` | A connected account by reference (connection id and provider). Never a token. |
| `Tool` | A tool by name, family and whether it commits. |
| `SecretRef` | A saved login, identity or card by label. Never the value. |
| `Parameter` | A declared task input. A `sensitive` one never reaches the graph, a judge or a file. |
| `Output` | A named value the procedure produces, read from a step. |

| Edge | From → to |
|---|---|
| `uses` | step → tool, site, account, secret reference |
| `then` | step → step (control flow; `loop: true` only from a `foreach` body back to its `foreach`) |
| `feeds` | step → later step (data flow: an output fills an argument) |
| `on` | step → screen or element |
| `transition` | screen → screen |
| `version_of` | version → procedure |

The full schema, field by field, is [schema.md](schema.md).

## Step kinds

| Kind | Does | Model call |
|---|---|---|
| `call` | Runs a tool with bound arguments, through the host's tool wrapper. | no |
| `extract` | Reads a value from an earlier result: a field path, or a bounded pattern over its text. | no |
| `judge` | One small model call with a **fixed output schema**. It gets the task's goal (the owner's words) and its declared inputs. It stores no instruction from a run. | one, small |
| `ask` | The owner is asked (`confirm`, `missing_input`, `choice`); the host's own question flow and gates decide when and how. | no |
| `check` | A postcondition on its own. | no |
| `branch` | A guard on observed state (a location or an element present) picks `then` or `else`. | no |
| `foreach` | Repeats a body once per item of a list output, bounded by `maxItems`. | no |
| `agent` | A part the compiler could not express safely. The host's agent does it, until the `until` checks hold. | the agent's |

Every step may carry `checks` (postconditions run after it), `sites`, an `element` and `screen`, a `segment` and `commitClass`.

## Bindings

Where an argument comes from:

| Kind | Value |
|---|---|
| `literal` | A fixed value. Allowed only when it passes the sensitive-value check. |
| `parameter` | A declared task parameter, filled by the run's inputs. |
| `output` | An earlier step's result, optionally a field `path` (`items.0.link`). |
| `judge` | A field of an earlier judge step's result. |
| `secret` | A saved login, identity or card by reference. The host's secret path types it; the package never sees the value. |

## Checks

Each check has a `tolerance` from 0 (exact) to 1 (anything).

| Kind | Passes when |
|---|---|
| `location` | The page is on the host and the path matches the pattern (`*` one segment, `**` any). |
| `view_digest` | The view digest (a hash of structure, not text) is close to the recorded one. |
| `element_present` | The element (by surface-graph id or selector) is present. |
| `result_shape` | A step's result has `ok` as expected and the listed fields. |

A probe that cannot read a value returns `null`. The executor notes it on the step instead of guessing.

## Versions and states

```text
candidate ──► verified ──► active ──► suspended ──► active (restore)
    │             │           │            │
    ├─► rejected  └───────────┴────────────┴─► retired
    └─► retired
```

- `candidate`: compiled, never replayed.
- `verified`: one clean replay.
- `active`: the procedure's one version in use.
- `suspended`: stopped by the circuit breaker.
- `retired`: replaced, forgotten or pruned. It is kept for history and never runs.
- `rejected`: failed validation. It never runs.

`canTransition(from, to)` holds the table (`VERSION_TRANSITIONS`). A store refuses any other move, by compare-and-set on the current state.

A version records why it differs from its parent (`changeClass`):

- `initial`: the first compile.
- `structural`: promoted after a clean run.
- `sensitive`: it adds or changes a send, a payment, a recipient, a site, an account or a credential, and waits for the owner.

`classifyRepair` decides the class (see "Repair" below).

## Modes and switches

Each task has one of three modes:

- `off`: AI only; nothing is captured.
- `learn`: the AI runs as before, and a procedure is compiled but never executed.
- `reuse`: the compiled steps run without the model, and the AI repairs.

`effectiveMode` folds the switches into one mode: the deployment switch, the user switch, the task's mode, an "AI only this run" flag, and whether the run is a saved task at all. The result is `off` unless every level allows it.

```ts runnable
import assert from 'node:assert/strict';
import { effectiveMode } from '@marinoscar/hexactra-kgraph/ports';

const on = { deployment: true, user: true, task: 'reuse' as const, aiOnlyThisRun: false, savedTask: true };
assert.equal(effectiveMode(on), 'reuse');
assert.equal(effectiveMode({ ...on, deployment: false }), 'off'); // the administrator's switch
assert.equal(effectiveMode({ ...on, user: false }), 'off'); // the owner's own switch
assert.equal(effectiveMode({ ...on, task: 'off' }), 'off'); // the task's mode
assert.equal(effectiveMode({ ...on, aiOnlyThisRun: true }), 'off'); // one run
assert.equal(effectiveMode({ ...on, savedTask: false }), 'off'); // a chat goal never uses it
```

## Compiling

`compileTrace` turns the trace of one clean, successful run into a `candidate` version. It is deterministic and model-free.

- It reads only `TraceEvent`s: tool names, each argument's **provenance** (a literal, a parameter, an earlier result, or "the model produced it"), and the post-state (host and path, a view digest, a result's shape, an element fingerprint).
- Failed calls, undone navigations and observations nothing consumed are dropped.
- An argument the model produced becomes a `judge` step over what the run read, or the step stays with the agent.
- These always stay with the agent: a withheld (secret-looking) value, raw coordinates without element facts, model-written code, desktop actions and unknown tools.
- A repeated block that walks a list becomes a `foreach`. `mergeBranches` builds a `branch` only from **two** successful runs that diverge where each path's precondition is observable. A single run never produces a branch.
- The result is validated. A version with violations is `rejected` and never stored as runnable.

## Running

`executeProcedure` walks a version through the ports and returns an `ExecutionReport`: one entry per step, the outputs, and a **resume point** (the first step not done, with what was expected and what was observed). It never retries a step on its own. See [host-guide.md](host-guide.md).

**Recovery.** When a step does not match, a `RecoveryLadder` can try, in order, the rungs the host supplies:

1. `wait`: wait again.
2. `interrupts`: a banner, a pop-up or an expired session.
3. `reresolve`: find the element again from its fingerprint.
4. `locate`: one narrow model call through `JudgePort.locate`.

If no rung works, the run is handed to the agent. Each rung is tried at most once per step, and the model rung at most `RECOVERY_LIMITS.modelLocatesPerRun` (3) times per run. A commit-class step never uses the model rung. A commit-class step whose call was already sent is never retried.

**Outcome checks.** Step checks prove the path was followed. They do not prove the answer is right. `checkOutcome` checks each declared output's presence, type, options and plausibility against the *shape* of earlier verified results: an order of magnitude, a year, a character class and a length band, never a value. A sensitive output gets no shape at all. `isAuditRun` picks every Nth run to run with AI only, for comparison.

## Repair

When the agent finishes a run the procedure could not, the host compiles the finished run as a new version. `diffVersions` aligns it with the version that handed over: `unchanged`, `relocated`, `inserted`, `removed`, `rebound` or `retargeted`. `classifyRepair` then marks the change **sensitive** when it does any of these, and **structural** otherwise:

- inserts, removes or retargets a commit step;
- changes a commit step's arguments, or moves it to a control with a different role or label;
- changes a recipient or destination argument;
- adds a site, an account, an account or MCP tool, or a saved-login reference;
- lets a judge's answer reach a commit step.

## The circuit breaker

`breaker(history)` reads the outcomes of a version's own runs, oldest first, and suspends it when any of these holds:

- `failuresInARow` failures in a row (default 3; the host can configure it);
- more than half of the last 10 runs needed the agent;
- an outcome check failed while the clean history is shorter than 3 runs.
