# @hexactra/console-sdk

The Hexactra Console REST API for TypeScript. Its types are generated from the console's OpenAPI document (`openapi.json`), so every path, parameter, request body and response is checked against what the server serves.

```ts
import { createConsoleClient, ConsoleApiError } from '@hexactra/console-sdk';

const hx = createConsoleClient({ baseUrl: 'https://console.example.test', token: process.env.HEXACTRA_TOKEN! });

const task = await hx.data(hx.api.POST('/api/tasks', { body: { name: 'Fares', goal: 'Find a fare to Lisbon' } }));
const run = await hx.data(hx.api.POST('/api/tasks/{id}/runs', { params: { path: { id: task.id } } }));
const inbox = await hx.data(hx.api.GET('/api/inbox')); // what the agent is waiting for
```

- **`hx.api`** is an [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) client over the whole API, including the platform's routes (personal access tokens, notifications, …).
- **`hx.data(call)`** unwraps the console's `{ data }` envelope. On an error status it throws `ConsoleApiError`, with `status`, a stable `code` and the prose `message`.
- **Tokens.** Use a personal access token of a dedicated user (see `../../docs/mcp.md#connect`). The SDK sends the token as a bearer header and never logs it.

## Example

```bash
HEXACTRA_CONSOLE_URL=https://console.example.test HEXACTRA_TOKEN=pat_… node dist/examples/tasks.js
```

The example (`src/examples/tasks.ts`) saves a task, changes its goal, then lists tasks and runs. CI runs it against a live console: `apps/api/test/sdk.db.spec.ts`.

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
