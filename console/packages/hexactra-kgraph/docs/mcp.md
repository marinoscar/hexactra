# MCP

`@marinoscar/hexactra-kgraph/mcp` (E46.22, #796) lets a host expose an owner's learned procedures as MCP tools: `procedures_list`, `procedure_get` and `procedure_run`. It ships **descriptors** (what a server lists) and **handlers** (what a call does) written over the ports. It imports no MCP SDK: a host maps each descriptor to its own server.

## The descriptors

`PROCEDURE_TOOL_DESCRIPTORS` holds three `ProcedureToolDescriptor`s, in the order a host lists them:

| Tool | Effect | Open world | Untrusted result | What it does |
|---|---|---|---|---|
| `procedures_list` | read | no | no | The owner's procedures: id, task name, parameters, outputs, state, health. |
| `procedure_get` | read | no | yes | One procedure's parameters, outputs and masked steps in order. |
| `procedure_run` | write | yes | no | Starts a run of an **active** procedure's task through the host's run start path and returns the run id at once. |

Each descriptor has `name`, `title`, `description`, `input` and `output` (zod objects; `z.toJSONSchema(d.input, { io: 'input' })` gives an MCP `inputSchema`), `effect`, `openWorld`, `idempotent` and `untrusted`. Map `effect` to the MCP hints: `readOnlyHint: effect === 'read'`, `destructiveHint: false`, `openWorldHint: openWorld`, `idempotentHint: idempotent`.

There is deliberately no tool to create, edit, approve, decline, restore, forget, export or import a procedure, or to change a switch. Those stay with the owner, signed in, in the host's own pages.

## The handlers

`procedureToolHandlers({ store, runs, taskName?, mask? })` returns one async function per tool, each called as `handler(owner, args)`:

- `store` is your `ProcedureStorePort` (the same binding the executor uses). Owner isolation comes from it: another owner's id is `NOT_FOUND`.
- `runs` is a `ProcedureRunPort`: `start(owner, procedure, inputs)` starts a run of the procedure's task with your **existing** run start path (the same policy, limits, gates and questions as any run) and returns `{ runId, status }` at once. Never walk the procedure inline in a tool call.
- `taskName` names the task for the list; `mask` masks every label (default: the package's conservative mask).

A handler returns `{ ok, summary, structured, code?, untrusted }`. It never throws for a refusal: `NOT_FOUND`, `NOT_ACTIVE` (only an active version runs), `SENSITIVE_INPUT` (a sensitive parameter is never accepted from a caller: the owner enters it when the run starts) and `RUN_REFUSED` (your `start` threw) are results with `ok: false`.

## Example

Exposing the three tools from any server, against the package's fakes. `server.tool` stands for your server's own registration call.

```ts runnable
import { z } from 'zod';
import { PROCEDURE_TOOL_DESCRIPTORS, procedureToolHandlers } from '@marinoscar/hexactra-kgraph/mcp';
import { aProcedure, aVersion, call, InMemoryProcedureStore, lit } from '@marinoscar/hexactra-kgraph/testing';

const store = new InMemoryProcedureStore(); // your database binding in production
await store.putProcedure(aProcedure({ id: 'proc1', owner: 'me', task: 'task1', activeVersion: 'v1' }));
await store.putVersion('me', aVersion([call('c1', 'navigate', { url: lit('https://example.com/') })], { state: 'active' }));

const handlers = procedureToolHandlers({
  store,
  runs: { start: async () => ({ runId: 'run-1', status: 'queued' }) }, // your run start path
});

const listed: Record<string, unknown>[] = [];
const server = { tool: (entry: Record<string, unknown>) => listed.push(entry) };
for (const d of PROCEDURE_TOOL_DESCRIPTORS) {
  server.tool({
    name: d.name,
    title: d.title,
    description: d.description,
    inputSchema: z.toJSONSchema(d.input, { io: 'input' }),
    annotations: { title: d.title, readOnlyHint: d.effect === 'read', destructiveHint: false, idempotentHint: d.idempotent, openWorldHint: d.openWorld },
    // Your server authenticates the caller and passes its user id as the owner.
    call: (owner: string, args: never) => handlers[d.name](owner, args),
  });
}

const run = await handlers.procedure_run('me', { procedure_id: 'proc1' });
export const result = { listed: listed.map((t) => t.name), run: run.structured };
```

`result` is `{ listed: ['procedures_list', 'procedure_get', 'procedure_run'], run: { run_id: 'run-1', status: 'queued', procedure_id: 'proc1', task_id: 'task1', follow: 'run_wait with run_id run-1' } }` (`test/mcp-doc-example.spec.ts` runs this block as written).

## What a host adds

The package decides nothing about who may call. A host adds:

- **Authentication.** The owner passed to a handler is the authenticated caller, never an argument.
- **Scopes or permissions.** The console offers the read tools with `procedures:read` and `procedure_run` with `procedures:run`, and lists and accepts them only while the deployment and the owner's own switches are on.
- **Limits.** Rate limits, result size and deadlines. `procedure_run` returns at once; follow the run with your own tool (the console's `run_wait`).
- **The untrusted notice.** When `untrusted` is true (a step's label or target can come from a web page), start the result with your untrusted-content notice and mark it untrusted.
- **Redaction.** Pass results through your secret redaction like any other tool's.
