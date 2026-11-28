// Pricing a model call and adding up a run's usage (src/runner/cost.ts), the
// `agentPricing` settings namespace and the AI_PRICING port bound to it.
import { composePatchSystemSettingsSchema, composeDefaultSystemSettings } from '@marinoscar/platform-api/settings';

import '../src/platform/platform';
import { ConsoleAiPricing } from '../src/platform/ai/console-ai-pricing';
import { agentPricingSettingsSchema } from '../src/runner/agent-pricing.schemas';
import { RunUsage, priceCall, priceKey, roundUsd, type PriceTable } from '../src/runner/cost';

const PRICES: PriceTable = {
  'prov-a:model-x': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  'prov-a:model-y': { inputPerMTok: 0.8, outputPerMTok: 4 },
  'prov-b:free': { inputPerMTok: 0, outputPerMTok: 0 },
};

describe('priceCall', () => {
  it('prices input and output per million tokens', () => {
    expect(priceCall('prov-a', 'model-y', { inputTokens: 1_000_000, outputTokens: 500_000 }, PRICES)).toBe(2.8);
    expect(priceCall('prov-a', 'model-y', { inputTokens: 1234, outputTokens: 567 }, PRICES)).toBe(0.003255);
  });

  it('prices cached input separately, as part of the input count', () => {
    // 1M input of which 800k cached: 200k * 3 + 800k * 0.3 = 0.6 + 0.24; 100k output * 15 = 1.5
    expect(priceCall('prov-a', 'model-x', { inputTokens: 1_000_000, cachedInputTokens: 800_000, outputTokens: 100_000 }, PRICES)).toBe(2.34);
  });

  it('bills cached tokens as input when the model has no cached price, and never more cached than input', () => {
    expect(priceCall('prov-a', 'model-y', { inputTokens: 1_000_000, cachedInputTokens: 600_000 }, PRICES)).toBe(0.8);
    expect(priceCall('prov-a', 'model-x', { inputTokens: 1000, cachedInputTokens: 5000 }, PRICES)).toBe(0.0003);
  });

  it('returns null for a model with no price, never 0, and 0 for a model priced at 0', () => {
    expect(priceCall('prov-a', 'unlisted', { inputTokens: 10, outputTokens: 10 }, PRICES)).toBeNull();
    expect(priceCall('prov-z', 'model-x', { inputTokens: 10 }, PRICES)).toBeNull();
    expect(priceCall('prov-a', 'model-x', { inputTokens: 10 }, null)).toBeNull();
    expect(priceCall('prov-b', 'free', { inputTokens: 10, outputTokens: 10 }, PRICES)).toBe(0);
  });

  it('rounds to 6 decimal places and treats missing or invalid counts as zero', () => {
    expect(priceCall('prov-a', 'model-y', { inputTokens: 1 }, PRICES)).toBe(0.000001);
    expect(priceCall('prov-a', 'model-y', { inputTokens: 1, outputTokens: 1 }, PRICES)).toBe(0.000005);
    expect(priceCall('prov-a', 'model-y', { inputTokens: Number.NaN, outputTokens: -5 }, PRICES)).toBe(0);
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
    expect(priceKey('prov-a', 'model:with:colons')).toBe('prov-a:model:with:colons');
  });
});

describe('RunUsage', () => {
  it('adds calls, tokens and cost for the model that served each call, and drains', () => {
    const u = new RunUsage();
    u.add('prov-a', 'model-y', { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400 }, PRICES);
    u.add('prov-a', 'model-x', { inputTokens: 2000, outputTokens: 50 }, PRICES);
    u.add('prov-a', 'model-y', { inputTokens: 500, outputTokens: 10 }, PRICES);
    const d = u.drain();
    expect(d).toMatchObject({ modelCalls: 3, inputTokens: 3500, outputTokens: 160, cachedInputTokens: 400, costKnown: true });
    expect(d.costUsd).toBe(roundUsd(0.0008 * 0.6 + 0.0008 * 0.4 + 0.0004 + 0.006 + 0.00075 + 0.0004 + 0.00004));
    expect(d.byModel).toEqual({ 'prov-a:model-y': { calls: 2, costUsd: expect.any(Number), ms: 0 }, 'prov-a:model-x': { calls: 1, costUsd: expect.any(Number), ms: 0 } });
    expect(u.dirty).toBe(false);
    expect(u.drain()).toMatchObject({ modelCalls: 0, costUsd: 0, costKnown: true });
  });

  it('flips costKnown on an unpriced call but keeps the priced part, and counts a response with no model as unpriced', () => {
    const u = new RunUsage();
    u.add('prov-a', 'model-y', { inputTokens: 1_000_000 }, PRICES);
    u.add('prov-a', 'unlisted', { inputTokens: 5, outputTokens: 5 }, PRICES);
    u.add(undefined, undefined, { inputTokens: 1 }, PRICES);
    const d = u.drain();
    expect(d).toMatchObject({ modelCalls: 3, inputTokens: 1_000_006, costUsd: 0.8, costKnown: false });
    expect(d.byModel['prov-a:unlisted']).toEqual({ calls: 1, costUsd: null, ms: 0 });
    expect(d.byModel['unknown']).toEqual({ calls: 1, costUsd: null, ms: 0 });
    // The next chunk starts known again: the run flips it with the first delta that says so.
    expect(u.delta().costKnown).toBe(true);
  });

  it('does not drift over many small calls', () => {
    const u = new RunUsage();
    for (let i = 0; i < 1000; i++) u.add('prov-a', 'model-y', { inputTokens: 1, outputTokens: 1 }, PRICES);
    expect(u.drain().costUsd).toBe(0.005);
  });
});

describe('the agentPricing settings namespace', () => {
  it('registers with an empty default table', () => {
    expect(composeDefaultSystemSettings()).toMatchObject({ agentPricing: { currency: 'USD', models: {} } });
  });

  it('validates a price table and a PATCH body', () => {
    const models = { 'prov-a:model-x': { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 } };
    expect(agentPricingSettingsSchema.parse({ currency: 'USD', models })).toEqual({ currency: 'USD', models });
    expect(composePatchSystemSettingsSchema().parse({ agentPricing: { models } })).toEqual({ agentPricing: { models } });
  });

  it('rejects negative, non-numeric and absurd prices, bad keys and other currencies', () => {
    const one = (price: unknown, key = 'prov-a:m') => agentPricingSettingsSchema.safeParse({ currency: 'USD', models: { [key]: price } }).success;
    expect(one({ inputPerMTok: 1, outputPerMTok: 1 })).toBe(true);
    expect(one({ inputPerMTok: -1, outputPerMTok: 1 })).toBe(false);
    expect(one({ inputPerMTok: 1, outputPerMTok: -0.01 })).toBe(false);
    expect(one({ inputPerMTok: 1, outputPerMTok: 1, cachedInputPerMTok: -1 })).toBe(false);
    expect(one({ inputPerMTok: '1', outputPerMTok: 1 })).toBe(false);
    expect(one({ inputPerMTok: 1_000_000, outputPerMTok: 1 })).toBe(false);
    expect(one({ inputPerMTok: 1 })).toBe(false);
    expect(one({ inputPerMTok: 1, outputPerMTok: 1 }, 'no-provider')).toBe(false);
    expect(agentPricingSettingsSchema.safeParse({ currency: 'EUR', models: {} }).success).toBe(false);
    expect(composePatchSystemSettingsSchema().safeParse({ agentPricing: { models: { 'prov-a:m': { inputPerMTok: -2, outputPerMTok: 1 } } } }).success).toBe(false);
  });
});

describe('the AI_PRICING port (ConsoleAiPricing)', () => {
  const slice = { provider: 'prov-a', modelId: 'model-x', operation: 'responses', requests: 3, inputTokens: 1_000_000, outputTokens: 100_000, reasoningTokens: 0, cachedInputTokens: 800_000, units: {} };
  const port = (models: PriceTable) => new ConsoleAiPricing({ getNamespace: async () => ({ currency: 'USD', models }) } as never);

  it('prices a usage slice from the admin table in USD', async () => {
    expect(await port(PRICES).costFor(slice)).toEqual({ amount: 2.34, currency: 'USD' });
  });

  it('answers null (unknown, not 0) for an unlisted model or non-token units', async () => {
    expect(await port({}).costFor(slice)).toBeNull();
    expect(await port(PRICES).costFor({ ...slice, units: { images: 2 } })).toBeNull();
  });
});
