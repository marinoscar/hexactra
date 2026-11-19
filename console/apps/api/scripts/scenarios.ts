// `npm run scenarios --workspace=api` (E38.6, #587): the scripted replay suite. Runs every `*.scenario.json` of test/scenarios against
// the real runner loop with a scripted model and a fake site, prints a table, writes JUnit XML for CI, and exits 1 when a scenario fails
// or when no scenario was found (a step must never report success for a suite that did not run).
//
//   npm run scenarios --workspace=api -- [--dir test/scenarios] [--junit test-results/scenarios.xml] [--filter <text>]
//   npm run scenarios:schema --workspace=api          rewrites test/scenarios/scenario.schema.json from the zod schema
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { junitXml, loadScenarios, resultsTable, runScenario, ScenarioInvalid, scenarioJsonSchema, type ScenarioResult } from '../test/replay';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const root = resolve(__dirname, '..');
  const dir = resolve(root, arg('dir') ?? 'test/scenarios');
  if (process.argv.includes('--write-schema')) {
    writeFileSync(join(dir, 'scenario.schema.json'), `${JSON.stringify(scenarioJsonSchema(), null, 2)}\n`);
    process.stdout.write(`wrote ${join(dir, 'scenario.schema.json')}\n`);
    return 0;
  }
  const filter = arg('filter');
  let loaded;
  try {
    loaded = loadScenarios(dir);
  } catch (e) {
    if (e instanceof ScenarioInvalid) {
      process.stderr.write(`invalid scenario: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  const files = new Map(loaded.map((l) => [l.scenario.name, l.file.replace(`${root}/`, '')]));
  const chosen = filter ? loaded.filter((l) => l.scenario.name.includes(filter) || l.file.includes(filter)) : loaded;
  if (chosen.length === 0) {
    process.stderr.write(`no scenario found in ${dir}${filter ? ` matching "${filter}"` : ''}: refusing to report success for a suite that did not run\n`);
    return 1;
  }
  const results: ScenarioResult[] = [];
  for (const { scenario } of chosen) results.push(await runScenario(scenario));
  process.stdout.write(`${resultsTable(results)}\n`);
  const junit = resolve(root, arg('junit') ?? 'test-results/scenarios.xml');
  mkdirSync(dirname(junit), { recursive: true });
  writeFileSync(junit, junitXml(results, files));
  process.stdout.write(`JUnit: ${junit}\n`);
  return results.every((r) => r.pass) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  },
);
