# @marinoscar/hexactra-kgraph

A generic **Knowledge Graph of learned procedures**, behind ports. An AI agent works out how to do a job once. The steps it took are compiled into a **procedure**: server-recorded tool calls, never model prose. Later runs execute the procedure without the model and check each step. They hand back to the agent only when a check fails, and the agent's repair becomes a new version.

**What it is:** the typed graph (zod schemas), the validator a procedure must pass before it runs, a deterministic compiler from a run's trace, an executor that walks a version through ports, the repair diff and its classification, the circuit breaker, the view model a map or an API reads, export and import of a file, host-neutral MCP tool descriptors, and an optional bridge to `@marinoscar/hexactra-agent`.

**What it is not:** an agent loop, a model client, a browser driver, a database, a web UI or an MCP server. It never decides who may do what. A host binds the ports to its own tool wrapper, database, model routing and clock, and keeps its own gates, Stop, Pause and approvals.

## Status

**Experimental. Off by default in every host.** Version `0.1.0-next.*`; publishing is off (`docs/decisions/agent-packages.md`). The Hexactra Console is the only host so far (epic E46, [decision record](../../docs/decisions/knowledge-graph.md)), and the feature ships there switched off at every level: deployment, user, task and run. The package stays experimental until a second, independent host uses it. `test/second-host.spec.ts` is a minimal second host inside this repository, not an outside user.

## Install

```bash
npm install @marinoscar/hexactra-kgraph zod @opentelemetry/api
# optional, only for the ./harness bridge:
npm install @marinoscar/hexactra-agent
```

CommonJS, Node 24. Its dependencies are `zod` and `@opentelemetry/api` only (peer dependencies). The core imports no framework, database client, model SDK or agent harness. Only `src/harness/` imports `@marinoscar/hexactra-agent`, and `test/imports.spec.ts` scans the built output to enforce it.

## Quick start

This example uses the fakes from `./testing`. It compiles a run's trace into a candidate version, replays it, breaks it the way a site redesign would, then compiles the agent's repaired run and classifies the change.

```ts runnable
import assert from 'node:assert/strict';
import { compileTrace, type TraceEvent } from '@marinoscar/hexactra-kgraph/compile';
import { executeProcedure } from '@marinoscar/hexactra-kgraph/execute';
import { classifyRepair, diffVersions } from '@marinoscar/hexactra-kgraph/repair';
import { fakePorts, replies } from '@marinoscar/hexactra-kgraph/testing';

const tools = [
  { name: 'navigate', family: 'browser', commits: false },
  { name: 'click', family: 'browser', commits: false },
  { name: 'read_text', family: 'browser', commits: false },
];
const goal = 'Open the orders export and read the total';
const at = (path: string) => ({ host: 'shop.example.com', path });
const button = (selector: string) => ({ role: 'button', name: 'Export', tag: 'button', inputType: null, selectors: [selector], anchor: null });

// 1. A run's trace: what each tool call did and where each argument came from (never typed text, page text or the model's reasoning).
const trace = (exportSelector: string): TraceEvent[] => [
  { seq: 1, tool: 'navigate', family: 'browser', commits: false, ok: true, outcome: 'ran', bindings: { url: { kind: 'literal', value: 'https://shop.example.com/orders' } }, post: at('/orders') },
  { seq: 2, tool: 'click', family: 'browser', commits: false, ok: true, outcome: 'ran', bindings: { selector: { kind: 'literal', value: exportSelector } }, post: { ...at('/orders/export'), element: button(exportSelector) } },
  { seq: 3, tool: 'read_text', family: 'browser', commits: false, ok: true, outcome: 'ran', bindings: { selector: { kind: 'literal', value: '#total' } }, post: at('/orders/export') },
  // The run's finish: its output `total` came from the read above.
  { seq: 4, tool: 'finish', family: 'browser', commits: false, ok: true, outcome: 'ran', bindings: { 'outputs.total': { kind: 'output', seq: 3 } }, post: {} },
];
const compile = (version: string, number: number, exportSelector: string, parent: string | null = null) =>
  compileTrace({ procedure: 'proc1', version, number, parent, createdAt: '2026-11-22T00:00:00.000Z', sourceRun: `run-${number}`, trace: trace(exportSelector), tools, parameters: [], outputs: [{ name: 'total' }] });

// 2. Compile: deterministic and model-free. The result is validated; a candidate is never replayed before a host verifies it.
const compiled = compile('v1', 1, '#export');
assert.equal(compiled.status, 'candidate');
const v1 = compiled.version!;

// 3. Replay with the fakes. Every call goes through the ToolInvokerPort (a host binds its one tool wrapper there).
const ports = fakePorts();
ports.tools
  .on('navigate', () => (ports.probe.at('https://shop.example.com/orders'), replies.ok()))
  .on('click', () => (ports.probe.at('https://shop.example.com/orders/export'), replies.ok()))
  .on('read_text', replies.ok('4,512.07'));
const first = await executeProcedure(v1, {}, ports, { goal });
assert.equal(first.status, 'completed');
assert.equal(first.judgeCalls, 0); // no model call at all

// 4. The site moves its Export button: the click lands nowhere and the location check after it fails. The walk stops there (no retry);
//    a host hands the run to its agent with `first.resume` (expected and observed: hosts and paths, never page text).
const broken = fakePorts();
broken.tools
  .on('navigate', () => (broken.probe.at('https://shop.example.com/orders'), replies.ok()))
  .on('click', replies.ok()); // the page stays on /orders
const second = await executeProcedure(v1, {}, broken, { goal });
assert.equal(second.status, 'failed_check');

// 5. Repair: the agent finished the run with the new button. Its trace compiles to v2; the diff and the classification decide how it
//    is promoted. A moved button is structural (verified on its next run); a new send, payment, recipient, site, account or saved login
//    would be sensitive and wait for the owner.
const v2 = compile('v2', 2, '#export-v2', 'v1').version!;
const changes = diffVersions(v1, v2);
const verdict = classifyRepair(v1, v2, changes, tools);
assert.equal(verdict.changeClass, 'structural');

export const result = {
  compiled: v1.steps.map((s) => `${s.kind}:${s.kind === 'call' ? s.tool : s.id}`),
  firstRun: { status: first.status, outputs: first.outputs },
  secondRun: { status: second.status, step: second.resume?.step },
  repair: { changes: changes.map((c) => c.kind), changeClass: verdict.changeClass },
};
```

`test/docs-examples.spec.ts` runs every block marked ```` ```ts runnable ```` in this README and in `docs/`, against the built package.

## Entry points

As `package.json` `exports` declares them:

| Import | What |
|---|---|
| `@marinoscar/hexactra-kgraph` | Everything in `./schema`, `./validate`, `./ports`, `./compile`, `./execute`, `./repair`, `./view`, `./transfer` and `./match`. Not `./testing`, `./mcp` or `./harness`. |
| `./schema` | The typed graph: nodes, edges, step kinds, bindings, checks, parameters, outputs, the surface graph (screens and elements), versions, the state machine (`canTransition`, `VERSION_TRANSITIONS`), evidence. Zod schemas and their types. |
| `./validate` | `validateVersion` (typed violations; empty means valid), `VIOLATION_RULES`, `defaultIsSensitive`. |
| `./compile` | The trace types and `bindArguments` (argument provenance), `compileTrace` (trace to a `candidate` version), `cleanTrace`, `findLoop`, `mergeBranches`. |
| `./execute` | `executeProcedure` (walks a version through the ports and returns an `ExecutionReport` with a resume point), the outcome check (`checkOutcome`, `learnShape`, `isAuditRun`), and the recovery ladder (`RecoveryLadder`, `RUNGS`, `RECOVERY_LIMITS`). |
| `./repair` | `diffVersions`, `classifyRepair` (`structural` or `sensitive`, with reasons), `breaker` (the circuit breaker, `BREAKER`). |
| `./transfer` | `exportFile`, `exportProcedure` and `readTransferFile`: the `hexactra.kgraph` file, with no ids, tokens, secret values, evidence or traces. |
| `./match` | `matchProcedures` (the procedures that may do part of a goal: exact registrable-domain sites, accounts and normalised words; no I/O, no model), `sitesInText`, `siteOf`, `wordsOf`, `cleanReplayRate`, `MATCHABLE_STATES`. |
| `./ports` | `ProcedureStorePort`, `ToolInvokerPort`, `StateProbePort`, `JudgePort`, `ClockPort`, `IdPort`, `TelemetryPort` (`noopTelemetry`), `KgraphPorts`, `effectiveMode`. |
| `./view` | The plain view model the console's Map, API and CLI read: `buildGraphView` (nodes, edges, clusters, `unused` capabilities, folding and paging above a node limit), `stepList`, `readableDiff`, `healthOf`, `defaultMask`. |
| `./testing` | In-memory fakes of every port (`fakePorts`, `InMemoryProcedureStore`, `ScriptedToolInvoker`, `FakeStateProbe`, `FakeJudge`, `FakeClock`, `SequentialIds`, `RecordingTelemetry`), `replies`, builders (`aProcedure`, `aVersion`, `call`, `lit`, `param`, `out`, `secret`, `TOOLS`), and `runStoreConformance`, the host conformance kit. |
| `./mcp` | Host-neutral MCP tool descriptors and handlers over the ports: `procedures_list`, `procedure_get`, `procedure_run`. No MCP SDK ([docs/mcp.md](docs/mcp.md)). |
| `./harness` | The bridge to `@marinoscar/hexactra-agent`: `replayPhase`, `harnessToolInvoker` (every call through `executeTool`), `watchCalls`, `harnessJudge`, `harnessProbe`, `handoverNote`, and `runSubProcedure` and `bindParameters` (a procedure called as a tool inside a run, depth 1). The only folder that imports the harness. |

## Documentation

| File | What |
|---|---|
| [docs/concepts.md](docs/concepts.md) | The graph, step kinds, bindings, checks, versions and states, change classes, modes, matching, the compiler, recovery and the breaker. |
| [docs/host-guide.md](docs/host-guide.md) | Every port and its guarantees, embedding step by step, the crash-safety contract, the conformance kit. |
| [docs/schema.md](docs/schema.md) | The schema as JSON Schema. Generated: `npm run docs:schema -w @marinoscar/hexactra-kgraph`; `test/schema-doc.spec.ts` fails when it is stale. |
| [docs/security.md](docs/security.md) | The threat model: poisoning through pages, emails and tool results; what the package enforces; what a host must enforce. |
| [docs/mcp.md](docs/mcp.md) | Exposing procedures as MCP tools. |
| [CHANGELOG.md](CHANGELOG.md) | Changes by version. |

## License

MIT.
