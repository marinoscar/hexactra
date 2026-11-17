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
} from '@marinoscar/platform-api/settings';

import '../src/platform/platform';

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
});
