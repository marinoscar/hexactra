# @marinoscar/hexactra-kgraph

A generic **Knowledge Graph of learned procedures**, behind ports. An AI agent discovers how to do a job once; the steps it took (server-recorded tool calls, never model prose) are compiled into a **procedure**; later runs execute the procedure without the model, check each step, and hand back to the agent only when a check fails. The agent's repair becomes a new version.

**Status: experimental until a second host uses it.** The Hexactra Console is the first host (epic E46, [decision record](../../docs/decisions/knowledge-graph.md)). Version `0.1.0-next.*`; publishing is off.

## Install

```bash
npm install @marinoscar/hexactra-kgraph zod @opentelemetry/api
# optional, only for the ./harness bridge:
npm install @marinoscar/hexactra-agent
```

CommonJS, Node 24. Dependencies: `zod` and `@opentelemetry/api` only. The core imports no framework, database client, model SDK or the agent harness.

## Example

```ts
import { validateVersion } from '@marinoscar/hexactra-kgraph/validate';
import { aProcedure, aVersion, call, lit, out, InMemoryProcedureStore, TOOLS } from '@marinoscar/hexactra-kgraph/testing';

const store = new InMemoryProcedureStore();
await store.putProcedure(aProcedure({ id: 'proc1', owner: 'me', task: 'daily-report' }));

const version = aVersion([
  call('c1', 'mail_search', { q: lit('subject:"daily numbers"') }),
  call('c2', 'navigate', { url: out('c1', 'items.0.link') }, { sites: ['s1'] }),
]);

const violations = validateVersion(version, { tools: TOOLS });
if (violations.length === 0) await store.putVersion('me', version);

await store.setVersionState('me', version.id, 'candidate', 'verified');
console.log((await store.getVersion('me', version.id))?.state); // 'verified'
```

`test/readme-example.spec.ts` runs this example.

## Entry points

| Import | What |
|---|---|
| `@marinoscar/hexactra-kgraph` | Everything below except `./testing`, `./mcp` and `./harness`. |
| `./schema` | The typed graph: nodes, edges, steps, bindings, checks, versions and states, evidence (zod schemas and their types). |
| `./validate` | `validateVersion`: the rules a version must satisfy before it can run; `defaultIsSensitive`. |
| `./ports` | `ProcedureStorePort`, `ToolInvokerPort`, `StateProbePort`, `JudgePort`, `ClockPort`, `IdPort`, `TelemetryPort` (`noopTelemetry`), `effectiveMode`. |
| `./view` | The plain view model the Map, the API and exports read: `buildGraphView` (nodes with type, label, health and counts; edges; clusters per site and per account; capabilities no procedure uses flagged `unused`; folded and paged above a node limit), `stepList`, `readableDiff`, `healthOf`. Labels pass the host's mask. |
| `./testing` | In-memory fakes of every port, a scripted tool invoker, builders, `runStoreConformance` (the host conformance kit). |
| `./mcp` | Host-neutral MCP tool descriptors and handlers (planned). |
| `./harness` | The bridge to `@marinoscar/hexactra-agent` (planned; the only place that imports it). |

## Documentation

- [docs/concepts.md](docs/concepts.md): the graph, step kinds, bindings, checks, versions and states, modes.
- [docs/host-guide.md](docs/host-guide.md): each port and its guarantees; how to embed the package.
- [docs/schema.md](docs/schema.md): the schema as JSON Schema (generated: `npm run docs:schema -w @marinoscar/hexactra-kgraph`).
- [docs/security.md](docs/security.md): the threat model and the rules a host must keep.
- [docs/mcp.md](docs/mcp.md): exposing procedures over MCP.
- [CHANGELOG.md](CHANGELOG.md).

## License

MIT.
