// The app's composition registers every system settings namespace it reads,
// in the order the request bodies are composed: the app's own `notes` first
// (src/platform/platform.ts imports its declaration first), then `jobs`,
// which `JobsModule.forRoot()` registers itself. Without `jobs` the nightly
// job-history purge would find no policy, and a PATCH of `jobs` would be
// dropped by the validation pipe.
import { DEFAULT_JOBS_POLICY } from '@marinoscar/platform-api/jobs';
import {
  composeDefaultSystemSettings,
  composePatchSystemSettingsSchema,
  systemSettingsNamespaceRegistry,
  userSettingsNamespaceRegistry,
} from '@marinoscar/platform-api/settings';

import '../src/platform/platform';
import { browserAgentSettingsSchema } from '../src/policies/policies.settings';

describe('system settings namespaces', () => {
  it('registers notes, then jobs (from JobsModule.forRoot())', () => {
    const ids = systemSettingsNamespaceRegistry.ids();
    expect(ids).toEqual(expect.arrayContaining(['notes', 'jobs']));
    expect(ids.indexOf('notes')).toBeLessThan(ids.indexOf('jobs'));
  });

  it('defaults jobs to the shipped policy, so the job-history purge has one', () => {
    expect(composeDefaultSystemSettings()).toMatchObject({
      notes: { archiveAfterDays: 0 },
      jobs: DEFAULT_JOBS_POLICY,
    });
  });

  it('accepts both namespaces in a PATCH /api/system-settings body', () => {
    const body = { notes: { archiveAfterDays: 30 }, jobs: { history: { purgeEnabled: false } } };
    expect(composePatchSystemSettingsSchema().parse(body)).toEqual(body);
  });

  it('registers agentPricing, accepts a price table and rejects a negative price', () => {
    expect(systemSettingsNamespaceRegistry.ids()).toContain('agentPricing');
    const ok = { agentPricing: { models: { 'prov-a:model-x': { inputPerMTok: 3, outputPerMTok: 15 } } } };
    expect(composePatchSystemSettingsSchema().parse(ok)).toEqual(ok);
    const bad = { agentPricing: { models: { 'prov-a:model-x': { inputPerMTok: -3, outputPerMTok: 15 } } } };
    expect(composePatchSystemSettingsSchema().safeParse(bad).success).toBe(false);
  });

  it('registers browserAgentCeilings: all null by default, partial patches, a bad value refused', () => {
    expect(systemSettingsNamespaceRegistry.ids()).toContain('browserAgentCeilings');
    expect(composeDefaultSystemSettings()).toMatchObject({
      browserAgentCeilings: { maxActions: null, maxModelCalls: null, maxActiveMinutes: null, maxInputTokens: null, maxOutputTokens: null, maxCostUsd: null },
    });
    const ok = { browserAgentCeilings: { maxActions: 200, maxCostUsd: 5 } };
    expect(composePatchSystemSettingsSchema().parse(ok)).toEqual(ok);
    expect(composePatchSystemSettingsSchema().safeParse({ browserAgentCeilings: { maxActions: 0 } }).success).toBe(false);
    expect(composePatchSystemSettingsSchema().safeParse({ browserAgentCeilings: { maxCostUsd: -1 } }).success).toBe(false);
  });

  it('registers the system namespace runs: no ceiling by default, a bad value refused (#422)', () => {
    expect(systemSettingsNamespaceRegistry.ids()).toContain('runs');
    expect(composeDefaultSystemSettings()).toMatchObject({ runs: { maxKeepDays: null } });
    const ok = { runs: { maxKeepDays: 180 } };
    expect(composePatchSystemSettingsSchema().parse(ok)).toEqual(ok);
    expect(composePatchSystemSettingsSchema().safeParse({ runs: { maxKeepDays: 0 } }).success).toBe(false);
    expect(composePatchSystemSettingsSchema().safeParse({ runs: { maxKeepDays: 3651 } }).success).toBe(false);
  });

  it('registers the user namespace runs apart from browserAgent, and stamps a saved rule (#422)', () => {
    expect(userSettingsNamespaceRegistry.ids()).toEqual(expect.arrayContaining(['browserAgent', 'runs']));
    const runs = userSettingsNamespaceRegistry.get('runs')!;
    expect(runs.patchSchema.safeParse({ keepDays: 0 }).success).toBe(false);
    expect(runs.patchSchema.safeParse({ keepPerTask: 10_001 }).success).toBe(false);
    // A first save starts from the defaults and records that the user chose.
    expect(runs.merge(undefined, { keepPerTask: 50 })).toEqual({ keepDays: 90, keepPerTask: 50, keepFailedDays: null, noticeSentAt: expect.any(String) });
    // "Forever" is null, and the stamp is kept.
    const saved = { keepDays: 30, keepPerTask: null, keepFailedDays: null, noticeSentAt: '2026-01-01T00:00:00.000Z' };
    expect(runs.merge(saved, { keepDays: null })).toEqual({ ...saved, keepDays: null });
    // Clearing the namespace goes back to the defaults.
    expect(runs.merge(saved, null)).toBeUndefined();
    // No field of #422 lives in E31's namespace.
    expect(Object.keys(browserAgentSettingsSchema.shape).sort()).toEqual(['defaultPolicyRef', 'tiers']);
  });
});
