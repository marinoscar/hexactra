// Example: save a task, change its goal, list tasks and recent runs.
//
//   HEXACTRA_CONSOLE_URL=https://console.example.test HEXACTRA_TOKEN=pat_… node dist/examples/tasks.js
//
// CI runs it against a live console (apps/api/test/sdk.db.spec.ts). It prints
// one JSON line; it never prints the token.
import { createConsoleClient } from '../index.js';

async function main() {
  const baseUrl = process.env.HEXACTRA_CONSOLE_URL;
  const token = process.env.HEXACTRA_TOKEN;
  if (!baseUrl || !token) throw new Error('Set HEXACTRA_CONSOLE_URL and HEXACTRA_TOKEN');
  const hx = createConsoleClient({ baseUrl, token });

  const task = await hx.data(
    hx.api.POST('/api/tasks', { body: { name: 'Lisbon fares', goal: 'Find a fare to Lisbon', allowedDomains: ['flights.example.test'] } }),
  );
  const updated = await hx.data(
    hx.api.PATCH('/api/tasks/{id}', { params: { path: { id: task.id } }, body: { goal: 'Find the cheapest fare to Lisbon in March' } }),
  );
  const tasks = await hx.data(hx.api.GET('/api/tasks'));
  const runs = await hx.data(hx.api.GET('/api/runs', { params: { query: {} } }));
  process.stdout.write(
    `${JSON.stringify({ taskId: task.id, listed: tasks.length, updatedGoal: updated.goal, profileKept: updated.profile, runs: runs.length })}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
  process.exit(1);
});
