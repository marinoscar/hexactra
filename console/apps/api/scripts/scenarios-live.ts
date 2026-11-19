// `npm run scenarios:live --workspace=api -- --tier standard --runs 3 --cap-usd 2 --user owner@example.test` (E38.6, #587): the live mode of
// the replay suite. A REAL model, through the console's AI service on the chosen tier, against the same fake sites, N runs per scenario,
// under a spend cap. It costs money. It is never part of the default CI job: `.github/workflows/scenarios-live.yml` runs it on an explicit
// trigger, and a person can run it by hand.
//
// It needs a console database that already has AI configured (a deployment key, the model tiers, the agent price table: all runtime
// settings in the admin UI) and a user whose AI settings the run may use (`--user`, the email of an existing account). It writes
// `<out>/live-<tier>.json` and `.md` (pass rate, median steps, tokens and cost per scenario, and the diff against the last saved baseline in
// test/scenarios/baselines/<tier>.json). `--save-baseline` replaces the baseline with this run: do it on purpose, after reading the diff.
//
//   --tier fast|standard|frontier   the tier the run starts on (default standard)
//   --runs N                        runs per scenario (default 3)
//   --cap-usd N                     the most the job may spend (default 2); a job that reaches it stops and says so
//   --user <email>                  whose AI settings to use (required)
//   --filter <text>                 only scenarios whose name or file contains it
//   --out <dir>                     where the summary goes (default test-results)
//   --save-baseline                 write the summary as the baseline for this tier
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { AiService } from '@marinoscar/platform-api/ai';

import { createApp } from '../src/main';
import { builtinPolicy } from '../src/policies/builtin-policies';
import { ModelTiersService } from '../src/policies/model-tiers.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { priceTableOf } from '../src/runner/agent-pricing.settings';
import { AiModelPort } from '../src/runner/host/model-port';
import { policyPort } from '../src/runner/host/policy-port';
import { diffBaseline, liveMarkdown, loadScenarios, runLive, type LiveSummary } from '../src/runner/testing';
import type { Tier } from '../src/runner/harness';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const root = resolve(__dirname, '..');
  const tier = (arg('tier') ?? 'standard') as Tier;
  if (!['fast', 'standard', 'frontier'].includes(tier)) throw new Error(`--tier: fast, standard or frontier, not "${tier}"`);
  const runs = Number(arg('runs') ?? 3);
  const capUsd = Number(arg('cap-usd') ?? 2);
  const email = arg('user');
  if (!email) throw new Error('--user <email>: the account whose AI settings the live runs use');
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs: a whole number, at least 1');
  if (!(capUsd > 0)) throw new Error('--cap-usd: above zero');

  const dir = resolve(root, 'test/scenarios');
  const filter = arg('filter');
  // The violation scenarios break a rule on purpose with a scripted model: they say nothing about a real one, so they are not run live.
  const chosen = loadScenarios(dir)
    .filter((l) => l.scenario.expect.violations.length === 0 && !(l.scenario.harness.sabotage ?? []).length)
    .filter((l) => !filter || l.scenario.name.includes(filter) || l.file.includes(filter));
  if (chosen.length === 0) {
    process.stderr.write('no scenario to run: refusing to report success for a suite that did not run\n');
    return 1;
  }

  const app = await createApp();
  await app.init();
  try {
    const prisma = app.get(PrismaService);
    const user = await prisma.user.findFirst({ where: { email } });
    if (!user) throw new Error(`--user: no account with the email ${email}`);
    const ai = app.get(AiService);
    const prices = priceTableOf(await app.get(SystemSettingsService).getNamespace('agentPricing'));
    const spec = builtinPolicy('builtin:balanced')!.spec;
    const resolvedTiers = await app.get(ModelTiersService).resolve(user.id, spec);
    const routing = policyPort({ ref: 'builtin:balanced', spec, resolvedTiers } as never, true).routing;

    const summary = await runLive(
      chosen.map((c) => c.scenario),
      { model: () => new AiModelPort(ai, user.id, null), runs, tier, prices, capUsd, routing, progress: (line) => process.stdout.write(`${line}\n`) },
    );

    const out = resolve(root, arg('out') ?? 'test-results');
    mkdirSync(out, { recursive: true });
    const baselinePath = join(dir, 'baselines', `${tier}.json`);
    const baseline = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as LiveSummary) : null;
    const markdown = liveMarkdown(summary, diffBaseline(summary, baseline));
    writeFileSync(join(out, `live-${tier}.json`), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(join(out, `live-${tier}.md`), markdown);
    if (process.argv.includes('--save-baseline')) {
      mkdirSync(join(dir, 'baselines'), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(summary, null, 2)}\n`);
    }
    process.stdout.write(`\n${markdown}`);
    // A violation is a failure of the safety net whatever the pass rate; the exit code carries it for the workflow.
    return summary.scenarios.some((s) => s.violations.length > 0) ? 1 : 0;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  },
);
