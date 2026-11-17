// Example: agent policies. Create one from a built-in, export it, import it
// back, then run a goal and a saved task under it.
//
//   HEXACTRA_CONSOLE_URL=https://console.example.test HEXACTRA_TOKEN=pat_… node dist/examples/policies.js
//
// CI runs it against a live console (apps/api/test/sdk.db.spec.ts). It prints
// one JSON line; it never prints the token.
import { createConsoleClient, type AgentPolicySpec } from '../index.js';

async function main() {
  const baseUrl = process.env.HEXACTRA_CONSOLE_URL;
  const token = process.env.HEXACTRA_TOKEN;
  if (!baseUrl || !token) throw new Error('Set HEXACTRA_CONSOLE_URL and HEXACTRA_TOKEN');
  const hx = createConsoleClient({ baseUrl, token });
  const suffix = Date.now();

  // Start from the built-in Economy policy; a budget limit of `null` means unlimited.
  const economy = await hx.policies.get('builtin:economy');
  const spec: AgentPolicySpec = { ...economy.spec, budget: { ...economy.spec.budget, maxActions: 30, maxCostUsd: 1.5 } };
  const policy = await hx.policies.create({ name: `Cheap fares ${suffix}`, description: 'A small budget for fare lookups', spec });
  const edited = await hx.policies.update(policy.id, { ...spec, budget: { ...spec.budget, maxActions: 45 } }, policy.version);

  // A portable file: no ids, users or secrets. Importing it again renames on a name clash.
  const file = await hx.policies.export({ ids: [policy.id], includePins: false });
  const imported = await hx.policies.import(file, { onConflict: 'rename' });

  const run = await hx.runs.start({ goal: 'Find a fare to Lisbon', policyId: policy.id });
  const task = await hx.tasks.create({ name: `Fares ${suffix}`, goal: 'Find a fare', policyId: edited.id });
  const taskRun = await hx.tasks.run(task.id, { policyId: 'builtin:thorough' });
  const all = await hx.policies.list();

  process.stdout.write(
    `${JSON.stringify({
      policyId: policy.id,
      editedVersion: edited.version,
      editedMaxActions: edited.spec.budget.maxActions,
      exported: file.policies.length,
      importedName: imported.created[0]?.name,
      runId: run.id,
      taskPolicyId: task.policyId,
      taskRunId: taskRun.id,
      listed: all.length,
    })}\n`,
  );
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`);
  process.exit(1);
});
