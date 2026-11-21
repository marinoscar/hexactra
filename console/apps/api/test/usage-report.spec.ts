// The usage and cost report core (#733), pure: windows in a time zone, buckets,
// the token and cost split, the series of each breakdown and the CSV.
import { addMonths, buildUsageReport, costSplit, csvCell, tokenSplit, usageCsv, usageWindow } from '../src/usage/usage-report';
import type { UsageRow } from '../src/usage/usage-rollup.service';

const row = (over: Partial<UsageRow>): UsageRow => ({
  hour: new Date('2026-11-20T15:00:00Z'),
  orgId: null,
  userId: 'u1',
  provider: 'openai',
  modelId: 'gpt-6-luna',
  operation: 'responses',
  feature: 'browser_agent',
  keySource: 'user',
  requests: 1,
  failed: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  latencyMsSum: 0,
  ...over,
});

const prices = {
  'openai:gpt-6-luna': { inputPerMTok: 0.1, outputPerMTok: 0.5, cachedInputPerMTok: 0.01 },
  'openai:gpt-6.1-sol': { inputPerMTok: 2, outputPerMTok: 10 },
};

describe('usageWindow', () => {
  const now = new Date('2026-11-21T03:30:00Z'); // 2026-11-20 21:30 in Chicago

  it('ends today in the time zone and covers whole local days', () => {
    const w = usageWindow('7d', 'America/Chicago', now);
    expect(w.granularity).toBe('day');
    expect(w.buckets).toEqual(['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
    expect(w.from.toISOString()).toBe('2026-11-14T06:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-11-21T06:00:00.000Z');
  });

  it('gives 30 and 90 days', () => {
    expect(usageWindow('30d', 'UTC', now).buckets).toHaveLength(30);
    expect(usageWindow('90d', 'UTC', now).buckets).toHaveLength(90);
  });

  it('gives the 12 calendar months ending this month for 1y', () => {
    const w = usageWindow('1y', 'UTC', now);
    expect(w.granularity).toBe('month');
    expect(w.buckets[0]).toBe('2025-12');
    expect(w.buckets.at(-1)).toBe('2026-11');
    expect(w.buckets).toHaveLength(12);
    expect(w.from.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(w.lastDay).toBe('2026-11-30');
  });

  it('adds months across years', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-11', 2)).toBe('2027-01');
  });
});

describe('tokenSplit and costSplit', () => {
  it('splits input into uncached and cached, output into output and reasoning, adding up', () => {
    const t = tokenSplit({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 300, reasoningTokens: 100 });
    expect(t).toEqual({ input: 600, cachedInput: 400, output: 200, reasoning: 100 });
  });

  it('never splits more than there is', () => {
    expect(tokenSplit({ inputTokens: 10, cachedInputTokens: 50, outputTokens: 5, reasoningTokens: 9 })).toEqual({ input: 0, cachedInput: 10, output: 0, reasoning: 5 });
  });

  it('prices cached input at its own price, reasoning as output', () => {
    const c = costSplit({ input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000, reasoning: 1_000_000 }, prices['openai:gpt-6-luna']);
    expect(c).toEqual({ input: 0.1, cachedInput: 0.01, output: 0.5, reasoning: 0.5 });
    expect(costSplit({ input: 0, cachedInput: 1_000_000, output: 0, reasoning: 0 }, prices['openai:gpt-6.1-sol']).cachedInput).toBe(2);
  });
});

describe('buildUsageReport', () => {
  const window = usageWindow('7d', 'UTC', new Date('2026-11-21T12:00:00Z'));
  const rows = [
    row({ inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000, reasoningTokens: 20_000 }),
    row({ hour: new Date('2026-11-21T09:00:00Z'), modelId: 'gpt-6.1-sol', inputTokens: 200_000, outputTokens: 10_000, requests: 3, failed: 1, feature: 'chat_orchestrator' }),
    row({ hour: new Date('2026-11-19T01:00:00Z'), modelId: 'mystery', inputTokens: 1000, outputTokens: 10 }),
    // Outside the window: ignored.
    row({ hour: new Date('2026-11-01T00:00:00Z'), inputTokens: 999 }),
  ];

  it('totals tokens and cost, and marks the cost a lower bound when a model has no price', () => {
    const r = buildUsageReport(rows, { window, timeZone: 'UTC', breakdown: 'model', prices });
    // luna: 0.5M uncached * 0.1 + 0.5M cached * 0.01 + 80k out * 0.5 + 20k reasoning * 0.5 = 0.05 + 0.005 + 0.04 + 0.01
    // sol: 0.2M * 2 + 10k * 10 = 0.4 + 0.1
    expect(r.totals.costUsd).toBeCloseTo(0.605, 6);
    expect(r.totals.costKnown).toBe(false);
    expect(r.unpricedModels).toEqual(['openai:mystery']);
    expect(r.totals).toMatchObject({ requests: 5, failed: 1, inputTokens: 1_201_000, cachedInputTokens: 500_000, outputTokens: 110_010, reasoningTokens: 20_000, tokens: 1_311_010 });
    expect(r.totals.costByTokenType).toEqual({ input: 0.45, cachedInput: 0.005, output: 0.14, reasoning: 0.01 });
  });

  it('splits series by model, largest cost first, aligned with the buckets', () => {
    const r = buildUsageReport(rows, { window, timeZone: 'UTC', breakdown: 'model', prices });
    expect(r.series.map((s) => s.key)).toEqual(['openai:gpt-6.1-sol', 'openai:gpt-6-luna', 'openai:mystery']);
    const sol = r.series[0]!;
    expect(sol.costUsd[window.buckets.indexOf('2026-11-21')]).toBeCloseTo(0.5, 6);
    expect(sol.requests.reduce((a, b) => a + b, 0)).toBe(3);
    expect(r.byModel.map((m) => [m.model, m.costUsd])).toEqual([
      ['gpt-6.1-sol', 0.5],
      ['gpt-6-luna', 0.105],
      ['mystery', null],
    ]);
  });

  it('stacks by token type with four series that add up to the tokens and the cost', () => {
    const r = buildUsageReport(rows, { window, timeZone: 'UTC', breakdown: 'tokenType', prices });
    expect(r.series.map((s) => s.key)).toEqual(['input', 'cachedInput', 'output', 'reasoning']);
    const sum = (k: 'tokens' | 'costUsd') => r.series.reduce((a, s) => a + s[k].reduce((x, y) => x + y, 0), 0);
    expect(sum('tokens')).toBe(r.totals.tokens);
    expect(sum('costUsd')).toBeCloseTo(r.totals.costUsd, 6);
  });

  it('groups by feature and by user, with labels', () => {
    expect(buildUsageReport(rows, { window, timeZone: 'UTC', breakdown: 'feature', prices }).series.map((s) => s.key).sort()).toEqual(['browser_agent', 'chat_orchestrator']);
    const byUser = buildUsageReport(rows, { window, timeZone: 'UTC', breakdown: 'user', prices, userLabel: (id) => `user ${id}` });
    expect(byUser.series).toHaveLength(1);
    expect(byUser.series[0]!.label).toBe('user u1');
  });

  it('buckets hours into the viewer’s local days', () => {
    const w = usageWindow('7d', 'America/Chicago', new Date('2026-11-21T12:00:00Z'));
    // 2026-11-21T03:00Z is 2026-11-20 21:00 in Chicago.
    const r = buildUsageReport([row({ hour: new Date('2026-11-21T03:00:00Z'), inputTokens: 10 })], { window: w, timeZone: 'America/Chicago', breakdown: 'none', prices });
    expect(r.series[0]!.tokens[w.buckets.indexOf('2026-11-20')]).toBe(10);
  });

  it('buckets a year by month', () => {
    const w = usageWindow('1y', 'UTC', new Date('2026-11-21T12:00:00Z'));
    const r = buildUsageReport([row({ hour: new Date('2026-03-05T00:00:00Z'), inputTokens: 5 }), row({ hour: new Date('2026-03-28T00:00:00Z'), inputTokens: 6 })], { window: w, timeZone: 'UTC', breakdown: 'none', prices });
    expect(r.series[0]!.tokens[w.buckets.indexOf('2026-03')]).toBe(11);
  });
});

describe('the CSV', () => {
  it('neutralises formulas and quotes separators', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(3.5)).toBe('3.5');
  });

  it('has one line per period, provider, model and feature, with cost, and a user column only when asked', () => {
    const window = usageWindow('7d', 'UTC', new Date('2026-11-21T12:00:00Z'));
    const rows = [row({ inputTokens: 1_000_000, outputTokens: 0 }), row({ hour: new Date('2026-11-20T16:00:00Z'), inputTokens: 1_000_000 }), row({ modelId: 'mystery', inputTokens: 5 })];
    const csv = usageCsv(rows, { window, timeZone: 'UTC', prices, withUser: false }).split('\r\n').filter(Boolean);
    expect(csv[0]).toBe('period,provider,model,feature,requests,failed,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,total_tokens,cost_usd,cost_known');
    expect(csv).toContain('2026-11-20,openai,gpt-6-luna,browser_agent,2,0,2000000,0,0,0,2000000,0.2,true');
    expect(csv).toContain('2026-11-20,openai,mystery,browser_agent,1,0,5,0,0,0,5,,false');
    const withUser = usageCsv(rows, { window, timeZone: 'UTC', prices, withUser: true, userLabel: () => 'a@example.test' }).split('\r\n')[0];
    expect(withUser).toContain(',user,');
  });
});
