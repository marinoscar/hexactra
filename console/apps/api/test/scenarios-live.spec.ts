// The live mode of the replay suite (E38.6, #587), with a FAKE provider: the mechanism (N runs per scenario, pass rate, medians, the spend
// cap, the baseline diff, the Markdown summary) is checked here; a real model is not run in CI and costs money. The fake plays each
// scenario's script and reports a provider, a model and token counts, so the price table and the cap apply to it as they would to a real one.
import { join } from 'node:path';

import type { ModelPort } from '@marinoscar/hexactra-agent';
import {
  diffBaseline,
  liveMarkdown,
  loadScenarios,
  runLive,
  runScenario,
  ScriptedScenarioModel,
  SpendCapReached,
  SpendGuard,
  type LiveSummary,
  type Scenario,
} from './replay';

const all = loadScenarios(join(__dirname, 'scenarios')).map((l) => l.scenario);
const get = (name: string): Scenario => all.find((s) => s.name === name)!;
const lookup = get('a simple lookup');
const payment = get('confirmed payment on a review page');

/** A "real" model: plays the scenario's script, as a provider that reports its model and tokens. `tokens` is what each call is billed. */
function fakeProvider(scenario: Scenario, tokens = { inputTokens: 1_000, outputTokens: 100 }): ModelPort {
  const inner = new ScriptedScenarioModel(scenario.script);
  return { runTools: (req) => inner.runTools({ ...req, onStep: (s) => req.onStep({ ...s, response: { provider: 'fake', model: 'fake-1', usage: tokens } }) }) };
}

// $1 per million input tokens and $10 per million output tokens: a call of 1000 in and 100 out costs $0.002.
const PRICES = { 'fake:fake-1': { inputPerMTok: 1, outputPerMTok: 10 } };

describe('runLive', () => {
  it('runs each scenario N times and sums up the pass rate, steps, tokens and cost', async () => {
    const lines: string[] = [];
    const summary = await runLive([lookup, payment], { model: (s) => fakeProvider(s), runs: 3, tier: 'standard', prices: PRICES, capUsd: 10, now: () => new Date('2026-11-19T00:00:00Z'), progress: (l) => lines.push(l) });
    expect(summary).toMatchObject({ type: 'hexactra.scenario-live', formatVersion: 1, generatedAt: '2026-11-19T00:00:00.000Z', tier: 'standard', runsPerScenario: 3, capped: false, unpricedCalls: 0 });
    expect(lines).toHaveLength(6);
    const [a, b] = summary.scenarios;
    expect(a).toMatchObject({ name: 'a simple lookup', runs: 3, completed: 3, passes: 3, passRate: 1, medianSteps: 3, violations: [], skipped: false });
    expect(b).toMatchObject({ name: 'confirmed payment on a review page', completed: 3, passes: 3 });
    // 4 calls of $0.002: the lookup script has 2 chunks, with 3 and 1 calls.
    expect(a!.medianCostUsd).toBe(0.008);
    expect(a!.medianTokens).toBe(4 * 1_100);
    expect(summary.spentUsd).toBeGreaterThan(0.008 * 3);
  });

  it('counts a run that fails, with the reason, in the pass rate', async () => {
    const wrong: Scenario = JSON.parse(JSON.stringify(lookup));
    // The model "forgets" to finish: the run cannot succeed.
    wrong.script = [[{ tool: 'observe_elements' }], [{ tool: 'finish', args: { success: false, result: 'could not find it' } }]];
    const summary = await runLive([lookup], { model: () => fakeProvider(wrong), runs: 2, tier: 'fast', prices: PRICES, capUsd: 10 });
    expect(summary.scenarios[0]).toMatchObject({ passes: 0, passRate: 0, completed: 2 });
    expect(summary.scenarios[0]!.failures.join('\n')).toMatch(/status: expected succeeded, got failed/);
  });

  it('stops at the spend cap, says so, and does not count the cut-off runs as failures', async () => {
    // $0.002 a call: the cap of $0.01 is reached in the first run of the lookup (4 calls = $0.008) and the second.
    const summary = await runLive([lookup, payment], { model: (s) => fakeProvider(s), runs: 3, tier: 'standard', prices: PRICES, capUsd: 0.01 });
    expect(summary.capped).toBe(true);
    expect(summary.spentUsd).toBeLessThanOrEqual(0.012);
    const [a, b] = summary.scenarios;
    expect(a!.completed).toBeLessThan(3);
    expect(a!.failures.join('\n')).not.toMatch(/spend cap/);
    expect(b).toMatchObject({ completed: 0, skipped: true, passRate: 0 });
  });

  it('refuses to run without a price table or without a cap: a spend cap could not hold', async () => {
    await expect(runLive([lookup], { model: (s) => fakeProvider(s), runs: 1, tier: 'standard', prices: {}, capUsd: 1 })).rejects.toThrow(/price table/);
    await expect(runLive([lookup], { model: (s) => fakeProvider(s), runs: 1, tier: 'standard', prices: PRICES, capUsd: 0 })).rejects.toThrow(/spend cap above zero/);
  });

  it('counts a call whose model has no price, so the summary can say the cost is a lower bound', async () => {
    const summary = await runLive([lookup], { model: (s) => fakeProvider(s), runs: 1, tier: 'standard', prices: { 'other:model': { inputPerMTok: 1, outputPerMTok: 1 } }, capUsd: 1 });
    expect(summary.unpricedCalls).toBe(4);
    expect(summary.scenarios[0]!.medianCostUsd).toBeNull();
  });

  it('holds a live model to the same rules: a model that pays without asking is stopped by the gate, and one that gets round it is reported', async () => {
    const payFirst: Scenario = JSON.parse(JSON.stringify(payment));
    payFirst.script = [[{ tool: 'click', args: { selector: '#pay' } }], [{ tool: 'finish', args: { success: false, result: 'The payment needs the owner.' } }]];
    const gated = await runScenario(payment, { model: fakeProvider(payFirst) });
    expect(gated.violations).toEqual([]);
    expect(gated.site.state.paid).toBe('no');
    const broken: Scenario = JSON.parse(JSON.stringify(payFirst));
    broken.harness.sabotage = ['gates_off'];
    broken.expect.status = 'succeeded';
    const unsafe = await runScenario(broken, { model: fakeProvider(payFirst) });
    expect(unsafe.violations).toContain('click:Pay:without_confirmation');
  });
});

describe('SpendGuard', () => {
  it('ends the chunk that spends the cap, refuses the next call, and says how much was spent', async () => {
    const guard = new SpendGuard(0.003, PRICES);
    const inner: ModelPort = {
      runTools: async (req) => {
        req.onStep({ response: { provider: 'fake', model: 'fake-1', usage: { inputTokens: 1_000, outputTokens: 100 } } });
        return { stopReason: 'steps_exhausted', outputText: '' };
      },
    };
    const model = guard.wrap(inner);
    const steps: number[] = [];
    const req = { route: { label: 'standard', params: {} }, instructions: '', input: '', tools: [], maxSteps: 5, signal: new AbortController().signal, onStep: () => void steps.push(1) };
    await model.runTools(req);
    expect(guard.spentUsd).toBeCloseTo(0.002);
    // The second call spends past the cap: the harness has counted it, then the chunk ends with the cap error.
    await expect(model.runTools(req)).rejects.toBeInstanceOf(SpendCapReached);
    expect(steps).toHaveLength(2);
    expect(guard.spentUsd).toBeCloseTo(0.004);
    await expect(model.runTools(req)).rejects.toBeInstanceOf(SpendCapReached);
    expect(steps).toHaveLength(2);
    expect(guard.reached).toBe(true);
  });
});

describe('the baseline diff', () => {
  const base = async (): Promise<LiveSummary> => runLive([lookup], { model: (s) => fakeProvider(s), runs: 2, tier: 'standard', prices: PRICES, capUsd: 10, now: () => new Date('2026-11-01T00:00:00Z') });

  it('shows what moved against the last saved baseline and flags a lower pass rate as a regression', async () => {
    const before = await base();
    const worse: Scenario = JSON.parse(JSON.stringify(lookup));
    worse.script = [[{ tool: 'observe_elements' }], [{ tool: 'finish', args: { success: false, result: 'could not find it' } }]];
    const after = await runLive([lookup], { model: () => fakeProvider(worse), runs: 2, tier: 'standard', prices: PRICES, capUsd: 10 });
    const diffs = diffBaseline(after, before);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ scenario: 'a simple lookup', passRate: { before: 1, after: 0 }, regression: true });
    const markdown = liveMarkdown(after, diffs);
    expect(markdown).toContain('# Live replay: tier standard');
    expect(markdown).toContain('100% → 0% (0/2)');
    expect(markdown).toContain('**regression**');
    expect(markdown).toContain('1 scenario(s) are worse than the baseline.');
  });

  it('reports no regression when nothing got worse, and notes scenarios the baseline lacks', async () => {
    const before = await base();
    const same = await runLive([lookup, payment], { model: (s) => fakeProvider(s), runs: 2, tier: 'standard', prices: PRICES, capUsd: 10 });
    const diffs = diffBaseline(same, before);
    expect(diffs.every((d) => !d.regression)).toBe(true);
    expect(diffs.find((d) => d.scenario === payment.name)!.note).toBe('new: not in the baseline');
    expect(liveMarkdown(same, diffs)).toContain('Nothing is worse than the baseline.');
  });

  it('says so when there is no baseline for the tier yet', async () => {
    const summary = await base();
    expect(diffBaseline(summary, null)).toEqual([]);
    expect(liveMarkdown(summary, [])).toContain('No baseline saved for this tier yet');
  });
});
