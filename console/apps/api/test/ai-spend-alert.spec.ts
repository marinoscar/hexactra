// The monthly AI spend alert (#736) and the spend summary it reads, without a database.
import { aiSpendMonthlyKind, setAlertSources, type AlertSources, type MonthlyAiSpend } from '../src/alerts/hexactra-alert-kinds';
import { rowCost, spendSummary } from '../src/usage/usage-report';
import type { UsageRow } from '../src/usage/usage-rollup.service';

const prices = { 'openai:gpt-6.1-sol': { inputPerMTok: 2, outputPerMTok: 10 } };
const row = (over: Partial<UsageRow>): UsageRow => ({
  hour: new Date('2026-11-03T10:00:00Z'), orgId: null, userId: 'u1', provider: 'openai', modelId: 'gpt-6.1-sol', operation: 'responses', feature: 'browser_agent', keySource: 'user',
  requests: 1, failed: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMsSum: 0, ...over,
});

describe('spendSummary', () => {
  it('sums cost per user and in total, and marks unpriced usage as a lower bound', () => {
    const s = spendSummary(
      [row({ inputTokens: 1_000_000 }), row({ userId: 'u2', outputTokens: 100_000 }), row({ userId: 'u2', modelId: 'mystery', inputTokens: 5 }), row({ userId: 'u1', inputTokens: 500_000 })],
      prices,
    );
    expect(s.totalUsd).toBe(4);
    expect(s.totalKnown).toBe(false);
    expect(s.users).toEqual([
      { userId: 'u1', usd: 3, known: true },
      { userId: 'u2', usd: 1, known: false },
    ]);
  });

  it('prices a slice with no tokens at zero, even on an unpriced model', () => {
    expect(rowCost(row({ modelId: 'mystery' }), prices)).toBe(0);
    expect(rowCost(row({ modelId: 'mystery', outputTokens: 1 }), prices)).toBeNull();
  });
});

describe('the monthly AI spend alert', () => {
  let spend: MonthlyAiSpend;
  const sources = { monthlyAiSpend: async () => spend } as unknown as AlertSources;
  const ctx = { now: new Date('2026-11-21T12:00:00Z') } as never;
  const view = (config: { maxDeploymentUsd: number | null; maxUserUsd: number | null; warnAtPercent: number }) => ({ name: 'Monthly AI spend', config }) as never;

  beforeEach(() => {
    setAlertSources(sources);
    spend = { since: new Date('2026-11-01T00:00:00Z'), totalUsd: 420, totalKnown: true, users: [{ userId: 'u1', usd: 300, known: true }, { userId: 'u2', usd: 120, known: false }, { userId: null, usd: 0, known: true }] };
  });

  it('fires for the deployment at the warning share, and resolves below it', async () => {
    const [obs] = await aiSpendMonthlyKind.evaluate(ctx, view({ maxDeploymentUsd: 500, maxUserUsd: null, warnAtPercent: 80 }));
    expect(obs).toMatchObject({ labels: { scope: 'deployment' }, value: 420, breached: true });
    expect(obs!.summary).toContain('84% of $500.00');
    spend = { ...spend, totalUsd: 100 };
    expect((await aiSpendMonthlyKind.evaluate(ctx, view({ maxDeploymentUsd: 500, maxUserUsd: null, warnAtPercent: 80 })))[0]).toMatchObject({ breached: false });
  });

  it('fires per user over their share, by id only, and says when a cost is a lower bound', async () => {
    const out = await aiSpendMonthlyKind.evaluate(ctx, view({ maxDeploymentUsd: null, maxUserUsd: 150, warnAtPercent: 80 }));
    expect(out.map((o) => o.labels)).toEqual([{ 'user.id': 'u1' }, { 'user.id': 'u2' }]);
    expect(out[1]!.summary).toContain('≥');
    expect(JSON.stringify(out)).not.toMatch(/@/);
  });

  it('checks nothing when no amount is set, or when the source is missing', async () => {
    expect(await aiSpendMonthlyKind.evaluate(ctx, view({ maxDeploymentUsd: null, maxUserUsd: null, warnAtPercent: 80 }))).toEqual([]);
    setAlertSources({} as AlertSources);
    expect(await aiSpendMonthlyKind.evaluate(ctx, view({ maxDeploymentUsd: 1, maxUserUsd: 1, warnAtPercent: 80 }))).toEqual([]);
  });
});
