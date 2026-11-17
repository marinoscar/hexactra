// The run page's tier and model chips (#408): which tier a run is on, from
// its snapshot and (once stall escalation keeps them, #405) its routing columns.
import { balancedSpec } from '../src/policies/builtin-policies';
import type { ResolvedTier } from '../src/policies/model-tiers.schema';
import { runView, type RunPolicySnapshot } from '../src/policies/policy-snapshot';
import { runTierView } from '../src/policies/run-tier-view';

const tier = (model: string | null): ResolvedTier => ({
  model,
  provider: model ? 'prov-a' : null,
  modelId: model ? model.split(':')[1]! : null,
  modelSource: model ? 'user' : null,
  borrowedFrom: null,
  reasoningEffort: null,
  effortSource: null,
  maxOutputTokens: null,
  maxOutputTokensSource: null,
  fallbackModel: null,
  fallbackProvider: null,
  fallbackSource: null,
  vision: true,
  tools: true,
  reasoning: null,
  usable: model !== null,
  problem: null,
});

function snapshot(extra: Partial<RunPolicySnapshot> = {}): RunPolicySnapshot {
  return { schemaVersion: 1, ref: 'builtin:balanced', name: 'Balanced', version: 1, builtin: true, source: 'user_default', spec: balancedSpec(), tiers: null, takenAt: '2026-11-17T00:00:00.000Z', ...extra };
}

describe('runTierView', () => {
  it('is null before the run has a snapshot', () => {
    expect(runTierView(null)).toBeNull();
  });

  it('reports the start tier and its resolved model until the run escalates', () => {
    const s = snapshot({ resolvedTiers: { fast: tier('prov-a:small'), standard: tier('prov-a:mid'), frontier: tier('prov-a:large') } });
    expect(runTierView(s)).toEqual({ start: 'standard', max: 'frontier', current: 'standard', escalations: 0, model: 'prov-a:mid' });
  });

  it('follows the current tier and escalation count when the run row carries them (#405)', () => {
    const s = snapshot({ resolvedTiers: { fast: tier('prov-a:small'), standard: tier('prov-a:mid'), frontier: tier('prov-a:large') } });
    expect(runTierView(s, { currentTier: 'frontier', escalations: 1 })).toMatchObject({ current: 'frontier', escalations: 1, model: 'prov-a:large' });
    // A value that is not a tier falls back to the start tier.
    expect(runTierView(s, { currentTier: 'ultra', escalations: -2 })).toMatchObject({ current: 'standard', escalations: 0 });
  });

  it('reads the older `tiers` map, and has no model when nothing was resolved', () => {
    expect(runTierView(snapshot({ tiers: { standard: { provider: 'prov-b', model: 'm-1' } } }))?.model).toBe('prov-b:m-1');
    expect(runTierView(snapshot())?.model).toBeNull();
  });

  it('is part of the run view', () => {
    const v = runView({ id: 'r1', policySnapshot: snapshot(), policyRef: 'builtin:balanced', policyVersion: 1, policySource: 'user_default' });
    expect(v.tier).toMatchObject({ start: 'standard', current: 'standard' });
    expect(runView({ id: 'r2', policySnapshot: null }).tier).toBeNull();
  });
});
