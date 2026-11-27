# @hexactra/console-sdk

The Hexactra Console REST API for TypeScript. Its types are generated from the console's OpenAPI document (`openapi.json`), so every path, parameter, request body and response is checked against what the server serves.

```ts
import { createConsoleClient, ConsoleApiError } from '@hexactra/console-sdk';

const hx = createConsoleClient({ baseUrl: 'https://console.example.test', token: process.env.HEXACTRA_TOKEN! });

const task = await hx.data(hx.api.POST('/api/tasks', { body: { name: 'Fares', goal: 'Find a fare to Lisbon' } }));
const run = await hx.data(hx.api.POST('/api/tasks/{id}/runs', { params: { path: { id: task.id } } }));
const inbox = await hx.data(hx.api.GET('/api/inbox')); // what the agent is waiting for
```

- **`hx.policies`, `hx.tasks`, `hx.runs`** are typed helpers over the same routes, for agent policies (the budgets and model tiers a run follows) and the `policyId` option:
  ```ts
  import type { AgentPolicySpec } from '@hexactra/console-sdk';

  const economy = await hx.policies.get('builtin:economy');
  const spec: AgentPolicySpec = { ...economy.spec, budget: { ...economy.spec.budget, maxCostUsd: 1.5 } }; // null = unlimited
  const policy = await hx.policies.create({ name: 'Cheap fares', spec });
  await hx.policies.update(policy.id, spec, policy.version);          // version: refused with 412 if it moved
  const file = await hx.policies.export({ ids: [policy.id], includePins: false });
  await hx.policies.import(file, { onConflict: 'rename' });           // or 'skip' | 'replace'
  await hx.policies.setDefault(policy.id);                             // null: back to builtin:balanced
  await hx.runs.start({ goal: 'Find a fare', policyId: policy.id });
  await hx.tasks.run(taskId, { policyId: 'builtin:thorough' });        // this run only
  ```
  and for tasks with schedules, pages of runs and deleting finished runs:
  ```ts
  const check = await hx.schedules.preview({ cron: '0 9 * * 1-5' });   // { valid: true, description, next } or { valid: false, code, message }
  const task = await hx.tasks.create({ name: 'Morning report', goal: 'Read the headline numbers', schedules: [{ cron: '0 9 * * 1-5' }] });
  await hx.tasks.pauseSchedules(task.id);                              // it still runs when started by hand
  await hx.tasks.resumeSchedules(task.id);
  const page = await hx.runs.list({ taskId: task.id, limit: 50 });     // { items, nextCursor }; pass nextCursor back as cursor
  await hx.runs.delete(runId);                                         // permanent; 409 RUN_LIVE for a live run
  await hx.runs.deleteMany({ filter: { taskId: task.id, to: '2026-08-01T00:00:00Z' }, expectedCount: 40 }); // or { ids }
  ```
  and for a task that must return values (E39.5, [Task outputs](../../docs/api-tasks-runs.md#task-outputs)):
  ```ts
  const task = await hx.tasks.create({ name: 'Pay the rent', goal: 'Pay the rent and read the receipt', outputs: [{ label: 'Confirmation number', type: 'text' }, { label: 'Amount paid', type: 'money' }] });
  const run = await hx.tasks.run(task.id);                              // run.outputs: the definitions the run started with, values once it finishes
  const history = await hx.tasks.outputs(task.id, { limit: 20 });       // { columns, items: [{ runId, values }], nextCursor }, newest first
  ```
  Deleting needs the `runs:delete` permission. The routes, their answers and error codes: [docs/api-tasks-runs.md](../../docs/api-tasks-runs.md).
- **`hx.api`** is an [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) client over the whole API, including the platform's routes (personal access tokens, notifications, …).
- **Diagnostics** (E50.10 to E50.13) are typed through `hx.api`. A report is ordered stages with closed codes; the words for a code are in `packages/shared/diagnostics.json` (`DIAGNOSTIC_REMEDIES` of `@app/shared`), never in the report. Run one and print the failing stage:
  ```ts
  const report = await hx.data(hx.api.POST('/api/connections/{id}/diagnose', { params: { path: { id: connectionId } } }));
  const failing = report.stages.find((s) => s.status === 'fail');
  if (failing) console.log(`${failing.id}: ${failing.code}`);   // e.g. capability:mail_read: API_DISABLED
  // Web search: POST /api/web-search/diagnose (?provider=brave); the history: GET /api/connections/{id}/diagnostics, GET /api/web-search/diagnostics
  ```
  The CLI prints the same report with the remedies: `hexactra connections diagnose <connection>`, `hexactra search test`.
- **`hx.data(call)`** unwraps the console's `{ data }` envelope. On an error status it throws `ConsoleApiError`, with `status`, a stable `code` and the prose `message`.
- **Tokens.** Use a personal access token of a dedicated user (see `../../docs/mcp.md#connect`). The SDK sends the token as a bearer header and never logs it.

## Example

```bash
HEXACTRA_CONSOLE_URL=https://console.example.test HEXACTRA_TOKEN=pat_… node dist/examples/tasks.js
```

The example (`src/examples/tasks.ts`) saves a task, changes its goal, lists tasks and runs, then uses the schedule preview, a task with schedules, pause and resume, a page of runs and a delete by filter. `src/examples/policies.ts` creates, edits, exports and imports a policy, then runs a goal and a task under it. `src/examples/task-outputs.ts` saves a task with outputs, starts a run and reads the history of what runs returned. `src/examples/run-stats.ts` prints the last 7 days of runs per task: success rate and the p50/p90 of steps, tokens and cost. `src/examples/run-dataset.ts` saves the last 7 days of runs as the masked run dataset (it needs object storage, so CI checks its route, not the example). CI runs the others against a live console: `apps/api/test/sdk.db.spec.ts`.

## Regenerating

Run this when the API changes:

```bash
UPDATE_SDK_OPENAPI=1 npm run test:db --workspace=api -- -t 'ships the OpenAPI'   # refresh openapi.json from the running API
npm run generate --workspace=@hexactra/console-sdk                               # openapi.json → src/schema.d.ts
```

CI catches drift in two places:
- `test:db` fails when `openapi.json` differs from the served document;
- `check:generated` fails when `src/schema.d.ts` differs from what `openapi.json` generates.

Generation runs `openapi-typescript` with `--default-non-nullable=false`. Without that flag, a field with a server-side default would appear required in the request types.
