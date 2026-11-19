// Example: a task with `{{parameters}}` (#552). Save the goal with blanks and
// their types, run it with only the value that changes, and see the one form a
// run waits on when a value is missing.
//
//   HEXACTRA_CONSOLE_URL=https://console.example.test HEXACTRA_TOKEN=pat_… node dist/examples/task-parameters.js
//
// CI runs it against a live console (apps/api/test/sdk.db.spec.ts). It prints
// one JSON line; it never prints the token.
import { createConsoleClient } from '../index.js';

async function main() {
  const baseUrl = process.env.HEXACTRA_CONSOLE_URL;
  const token = process.env.HEXACTRA_TOKEN;
  if (!baseUrl || !token) throw new Error('Set HEXACTRA_CONSOLE_URL and HEXACTRA_TOKEN');
  const hx = createConsoleClient({ baseUrl, token });

  // Two of the three blanks have a saved value: running it asks for the amount only.
  const task = await hx.data(
    hx.api.POST('/api/tasks', {
      body: {
        name: 'Pay a friend',
        goal: 'Send ${{Amount}} today to {{Phone Number}} from the checking account ending in {{Account last 4}}',
        allowedDomains: ['bank.example.test'],
        parameters: [
          { key: 'amount', type: 'money', required: true },
          { key: 'phone_number', type: 'phone', required: true, default: { value: '555-010-6020' } },
          { key: 'account_last_4', type: 'text', required: true, default: { value: '0659' }, constraints: { pattern: '\\d{4}' } },
        ],
      },
    }),
  );

  // With the amount: the run starts at once, its goal filled in by the server.
  const started = await hx.data(hx.api.POST('/api/tasks/{id}/runs', { params: { path: { id: task.id } }, body: { inputs: { Amount: '25' } } }));

  // Without it: the run waits on one form that asks for every missing value before the browser opens.
  const waiting = await hx.data(hx.api.POST('/api/tasks/{id}/runs', { params: { path: { id: task.id } }, body: {} }));
  const pending = await hx.data(hx.api.GET('/api/questions', { params: { query: { runId: waiting.id, status: 'pending' } } }));
  const form = pending.find((q) => q.input === 'form');

  // A value that does not fit its type is refused with the problem per parameter.
  const refused = await hx.api.POST('/api/tasks/{id}/runs', { params: { path: { id: task.id } }, body: { inputs: { amount: 'lots' } } });

  process.stdout.write(
    `${JSON.stringify({
      parameters: (task.parameters ?? []).map((p) => p.key),
      startedStatus: started.status,
      startedInputs: (started.inputs ?? []).map((i) => `${i.key}:${i.source}`),
      waitingStatus: waiting.status,
      formFields: (form?.fields ?? []).map((f) => f.key),
      refused: refused.response.status,
    })}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
  process.exit(1);
});
