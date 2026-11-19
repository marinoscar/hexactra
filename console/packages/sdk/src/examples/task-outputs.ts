// Example: a task with outputs (E39.5, #600). The task names the values its runs must return (a confirmation
// number, the amount paid); a run copies them when it starts, stores what the agent returned, and the
// per-task history lists them newest first, a sensitive value as "[hidden]".
//
//   HEXACTRA_CONSOLE_URL=https://console.example.test HEXACTRA_TOKEN=pat_… node dist/examples/task-outputs.js
//
// CI runs it against a live console (apps/api/test/sdk.db.spec.ts). It prints one JSON line; it never prints the token.
import { createConsoleClient } from '../index.js';

async function main() {
  const baseUrl = process.env.HEXACTRA_CONSOLE_URL;
  const token = process.env.HEXACTRA_TOKEN;
  if (!baseUrl || !token) throw new Error('Set HEXACTRA_CONSOLE_URL and HEXACTRA_TOKEN');
  const hx = createConsoleClient({ baseUrl, token });

  // Keys are derived from the labels (`confirmation_number`); a choice needs its options.
  const task = await hx.tasks.create({
    name: 'Pay the rent',
    goal: 'Pay this month\'s rent on the property portal and read the receipt',
    allowedDomains: ['portal.example.test'],
    outputs: [
      { label: 'Confirmation number', type: 'text', help: 'Shown on the receipt page' },
      { label: 'Amount paid', type: 'money' },
      { label: 'Paid on', type: 'date' },
      { label: 'Remaining balance', type: 'money', required: false },
      { label: 'Account', type: 'text', required: false, sensitive: true },
    ],
  });

  // A run copies the task's outputs when it starts; a start takes no outputs of its own.
  const run = await hx.tasks.run(task.id);
  const detail = await hx.data(hx.api.GET('/api/runs/{id}', { params: { path: { id: run.id } } }));

  // The history of what finished runs returned: empty until one finishes.
  const history = await hx.tasks.outputs(task.id, { limit: 20 });

  // A definition that cannot work is refused with the problem per key.
  const refused = await hx.api.POST('/api/tasks', { body: { name: 'Bad', goal: 'x', outputs: [{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }] } });

  process.stdout.write(
    `${JSON.stringify({
      outputKeys: (task.outputs ?? []).map((o) => o.key),
      sensitiveKeys: (task.outputs ?? []).filter((o) => o.sensitive).map((o) => o.key),
      runOutputLabels: (detail.outputs ?? []).map((o) => o.label),
      runOutputsComplete: detail.outputsComplete,
      columns: history.columns.map((c) => c.key),
      historyRuns: history.items.length,
      nextCursor: history.nextCursor,
      refused: refused.response.status,
    })}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
  process.exit(1);
});
