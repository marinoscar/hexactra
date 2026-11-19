// The live mode of the replay suite (E38.6): a real model behind the same fake sites, N runs per scenario, under a spend cap. It checks the
// prompts and the model, which the scripted mode cannot. It costs money, so it is never part of the default CI job: a separate workflow
// with an explicit trigger runs it (`.github/workflows/scenarios-live.yml`), and `npm run scenarios:live` is the manual way.
//
// This module is the mechanism and takes the model as a port: the script (`scripts/scenarios-live.ts`) binds it to the console's AI
// service. The specs run it with a fake provider.
import { priceCall, type ModelPort, type PolicyPort, type PriceTable, type Tier } from '../harness';
import { runScenario, type ScenarioResult } from './run-scenario';
import type { Scenario } from './scenario.schema';

/** The cap was reached: no more model calls are made. */
export class SpendCapReached extends Error {
  constructor(readonly spentUsd: number) {
    super(`the spend cap was reached after $${spentUsd.toFixed(4)}`);
  }
}

/** Counts what live calls cost, from the price table, and refuses the next call once the cap is reached. Shared by every run of one live job. */
export class SpendGuard {
  spentUsd = 0;
  /** Calls whose model had no price: with any, the cap cannot be trusted, and the summary says so. */
  unpricedCalls = 0;
  reached = false;
  constructor(
    readonly capUsd: number,
    private readonly prices: PriceTable,
  ) {}

  wrap(model: ModelPort): ModelPort {
    return {
      runTools: async (req) => {
        if (this.spentUsd >= this.capUsd) {
          this.reached = true;
          throw new SpendCapReached(this.spentUsd);
        }
        return model.runTools({
          ...req,
          onStep: (step) => {
            const usd = priceCall(step.response.provider ?? '', step.response.model ?? '', step.response.usage ?? {}, this.prices);
            if (usd === null) this.unpricedCalls += 1;
            else this.spentUsd += usd;
            // The harness counts the call first (it may end the chunk itself); then a spent cap ends it, so a run overshoots by one call at most.
            req.onStep(step);
            if (this.spentUsd >= this.capUsd) {
              this.reached = true;
              throw new SpendCapReached(this.spentUsd);
            }
          },
        });
      },
    };
  }
}

export interface LiveOptions {
  /** A model for each run. A fresh one each time, so nothing leaks between runs. A real model ignores the scenario; a fake one may play its script. */
  model: (scenario: Scenario) => ModelPort;
  /** Runs per scenario (the issue's default is 3). */
  runs: number;
  tier: Tier;
  /** What a model call costs. A live run without prices cannot be held to a cap, so it is refused. */
  prices: PriceTable;
  /** The most the job may spend, in USD. */
  capUsd: number;
  /** How each tier resolves to a model (the real resolver in the script). */
  routing?: PolicyPort['routing'];
  /** The time written in the summary. */
  now?: () => Date;
  progress?: (line: string) => void;
}

export interface LiveScenarioSummary {
  name: string;
  /** Runs asked for and runs that completed before the cap. */
  runs: number;
  completed: number;
  passes: number;
  passRate: number;
  medianSteps: number;
  medianTokens: number;
  /** Null when a call could not be priced. */
  medianCostUsd: number | null;
  /** Every distinct violation seen in any run. */
  violations: string[];
  /** Every distinct reason a run failed. */
  failures: string[];
  skipped: boolean;
}

export interface LiveSummary {
  type: 'hexactra.scenario-live';
  formatVersion: 1;
  generatedAt: string;
  tier: Tier;
  runsPerScenario: number;
  capUsd: number;
  spentUsd: number;
  /** The cap was reached before every run finished. */
  capped: boolean;
  unpricedCalls: number;
  scenarios: LiveScenarioSummary[];
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

/** What one scenario's runs add up to. */
export function summarizeRuns(scenario: Scenario, results: ScenarioResult[], asked: number): LiveScenarioSummary {
  const completed = results.length;
  const passes = results.filter((r) => r.pass).length;
  const costs = results.map((r) => (r.usage.costKnown ? r.usage.costUsd : null));
  return {
    name: scenario.name,
    runs: asked,
    completed,
    passes,
    passRate: completed ? passes / completed : 0,
    medianSteps: median(results.map((r) => r.steps.filter((s) => s.kind === 'action').length)),
    medianTokens: median(results.map((r) => r.usage.inputTokens + r.usage.outputTokens)),
    medianCostUsd: costs.length && costs.every((c): c is number => c !== null) ? Math.round(median(costs.map((c) => c * 1e6))) / 1e6 : null,
    violations: [...new Set(results.flatMap((r) => r.violations))].sort(),
    failures: [...new Set(results.flatMap((r) => r.failures))],
    skipped: completed === 0,
  };
}

/** Runs the scenarios against a live model, in order, and sums them up. Scenarios that the cap stops before they start are marked skipped. */
export async function runLive(scenarios: Scenario[], options: LiveOptions): Promise<LiveSummary> {
  if (Object.keys(options.prices).length === 0) throw new Error('live mode needs the agent price table (the agentPricing setting): without prices a spend cap cannot hold');
  if (!(options.capUsd > 0)) throw new Error('live mode needs a spend cap above zero');
  const guard = new SpendGuard(options.capUsd, options.prices);
  const out: LiveScenarioSummary[] = [];
  for (const scenario of scenarios) {
    const results: ScenarioResult[] = [];
    for (let i = 1; i <= options.runs; i += 1) {
      if (guard.reached || guard.spentUsd >= options.capUsd) {
        guard.reached = true;
        break;
      }
      options.progress?.(`${scenario.name} (run ${i} of ${options.runs}, $${guard.spentUsd.toFixed(4)} spent)`);
      const r = await runScenario(scenario, { model: guard.wrap(options.model(scenario)), prices: options.prices, tier: options.tier, ...(options.routing ? { routing: options.routing } : {}) });
      // A run the cap cut off says nothing about the model: it is not counted as a failure.
      if (!r.error?.includes('the spend cap')) results.push(r);
    }
    out.push(summarizeRuns(scenario, results, options.runs));
  }
  return {
    type: 'hexactra.scenario-live',
    formatVersion: 1,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    tier: options.tier,
    runsPerScenario: options.runs,
    capUsd: options.capUsd,
    spentUsd: Math.round(guard.spentUsd * 1e6) / 1e6,
    capped: guard.reached,
    unpricedCalls: guard.unpricedCalls,
    scenarios: out,
  };
}
