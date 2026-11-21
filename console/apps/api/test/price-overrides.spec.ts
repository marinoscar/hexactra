// A user's own model prices (#735), pure: read from the settings document, and
// laid over the deployment's table.
import { AGENT_PRICING_USER_SETTINGS, mergePrices, userPriceOverrides } from '../src/runner/agent-pricing.settings';

const deployment = { 'openai:gpt-6-luna': { inputPerMTok: 0.1, outputPerMTok: 0.5 }, 'openai:gpt-6.1-sol': { inputPerMTok: 2, outputPerMTok: 10 } };

describe('userPriceOverrides', () => {
  it("reads the user's table, and nothing from a missing or malformed one", () => {
    expect(userPriceOverrides({ agentPricing: { currency: 'USD', models: { 'openai:gpt-6-luna': { inputPerMTok: 0.05, outputPerMTok: 0.2 } } } })).toEqual({ 'openai:gpt-6-luna': { inputPerMTok: 0.05, outputPerMTok: 0.2 } });
    expect(userPriceOverrides(null)).toEqual({});
    expect(userPriceOverrides({ theme: 'dark' })).toEqual({});
    expect(userPriceOverrides({ agentPricing: { currency: 'EUR', models: {} } })).toEqual({});
    expect(userPriceOverrides({ agentPricing: { currency: 'USD', models: { 'no-colon': { inputPerMTok: 1, outputPerMTok: 1 } } } })).toEqual({});
  });
});

describe('mergePrices', () => {
  it("lets the user's price win for that model and keeps the rest", () => {
    const merged = mergePrices(deployment, { 'openai:gpt-6-luna': { inputPerMTok: 0.05, outputPerMTok: 0.2 }, 'compatible:local': { inputPerMTok: 0, outputPerMTok: 0 } });
    expect(merged['openai:gpt-6-luna']).toEqual({ inputPerMTok: 0.05, outputPerMTok: 0.2 });
    expect(merged['openai:gpt-6.1-sol']).toEqual(deployment['openai:gpt-6.1-sol']);
    expect(merged['compatible:local']).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
    expect(mergePrices(deployment, {})).toBe(deployment);
  });
});

describe('the user namespace', () => {
  it('replaces the whole table on a patch, and null clears it', () => {
    const current = { currency: 'USD' as const, models: { 'openai:a': { inputPerMTok: 1, outputPerMTok: 1 } } };
    expect(AGENT_PRICING_USER_SETTINGS.merge(current, { models: { 'openai:b': { inputPerMTok: 2, outputPerMTok: 2 } } })).toEqual({ currency: 'USD', models: { 'openai:b': { inputPerMTok: 2, outputPerMTok: 2 } } });
    expect(AGENT_PRICING_USER_SETTINGS.merge(current, null)).toBeUndefined();
    expect(AGENT_PRICING_USER_SETTINGS.merge(current, undefined)).toBe(current);
  });
});
