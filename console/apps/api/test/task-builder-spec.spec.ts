// The task builder's spec (E42.1, #718): what passes, what does not, and how a patch merges.
import { mergeSpec, readSpec, SPEC_MAX_BYTES, taskBuilderSpecPatchSchema, taskBuilderSpecSchema } from '../src/task-builder/task-builder.spec.schema';

describe('taskBuilderSpecSchema', () => {
  it('accepts an empty spec and a full one', () => {
    expect(taskBuilderSpecSchema.parse({})).toEqual({});
    const full = taskBuilderSpecSchema.parse({
      name: 'Pay the water bill',
      objective: 'The bill is paid and I have the confirmation number',
      goal: 'Pay {{Amount}} on the water utility site',
      sites: ['The water utility'],
      allowedDomains: ['water.example.test', '*.pay.example.test'],
      accounts: [{ label: 'Marin', access: 'read' }],
      parameters: [{ name: 'Amount', type: 'money' }],
      outputs: [{ label: 'Confirmation number' }],
      guardrails: { confirmRiskyActions: true, useSavedLogins: true },
      needsBrowser: 'always',
      policy: { ref: 'builtin:balanced', why: 'A short job' },
      schedules: [{ cron: '0 9 1 * *', timezone: 'America/Costa_Rica', inputs: { Amount: '25' } }],
      edgeCases: ['If the site is down, try again in an hour'],
      openQuestions: ['Which account pays?'],
      suggestions: ['Turn on confirmation before purchases'],
      ready: false,
    });
    expect(full.outputs).toEqual([{ label: 'Confirmation number', type: 'text' }]);
    expect(full.parameters?.[0]).toEqual({ name: 'Amount', type: 'money' });
  });

  it('refuses a bad domain, a bad cron, an unknown time zone, a too-frequent schedule and an unknown key', () => {
    expect(taskBuilderSpecSchema.safeParse({ allowedDomains: ['not a domain'] }).success).toBe(false);
    expect(taskBuilderSpecSchema.safeParse({ schedules: [{ cron: 'every day', timezone: 'UTC' }] }).success).toBe(false);
    expect(taskBuilderSpecSchema.safeParse({ schedules: [{ cron: '0 9 * * *', timezone: 'Mars/Olympus' }] }).success).toBe(false);
    expect(taskBuilderSpecSchema.safeParse({ schedules: [{ cron: '* * * * *', timezone: 'UTC' }] }).success).toBe(false);
    expect(taskBuilderSpecSchema.safeParse({ password: 'x' }).success).toBe(false);
    expect(taskBuilderSpecSchema.safeParse({ guardrails: { skipStop: true } }).success).toBe(false);
  });

  it('refuses a spec larger than the cap', () => {
    const big = { suggestions: Array.from({ length: 10 }, () => 'x'.repeat(300)), edgeCases: Array.from({ length: 10 }, () => 'y'.repeat(300)), openQuestions: Array.from({ length: 10 }, () => 'z'.repeat(300)), goal: 'g'.repeat(4000), objective: 'o'.repeat(1000), sites: Array.from({ length: 20 }, () => 's'.repeat(200)) };
    expect(JSON.stringify(big).length).toBeGreaterThan(SPEC_MAX_BYTES);
    const r = taskBuilderSpecSchema.safeParse(big);
    expect(r.success).toBe(false);
  });

  it('reads back a stored spec that no longer passes as empty', () => {
    expect(readSpec({ allowedDomains: ['bad domain'] })).toEqual({});
    expect(readSpec(null)).toEqual({});
    expect(readSpec({ name: 'Ok' })).toEqual({ name: 'Ok' });
  });
});

describe('mergeSpec', () => {
  it('replaces a value and an array whole, clears on null, keeps what is absent', () => {
    const current = { name: 'A', sites: ['one', 'two'], objective: 'Do it' };
    expect(mergeSpec(current, { sites: ['three'], objective: null })).toEqual({ name: 'A', sites: ['three'] });
  });

  it('merges the guardrails field by field', () => {
    expect(mergeSpec({ guardrails: { confirmRiskyActions: true } }, { guardrails: { useSavedLogins: true } })).toEqual({ guardrails: { confirmRiskyActions: true, useSavedLogins: true } });
  });
});

describe('taskBuilderSpecPatchSchema', () => {
  it('takes null to clear, refuses an empty patch and an unknown key', () => {
    expect(taskBuilderSpecPatchSchema.safeParse({ name: null }).success).toBe(true);
    expect(taskBuilderSpecPatchSchema.safeParse({}).success).toBe(false);
    expect(taskBuilderSpecPatchSchema.safeParse({ cardNumber: '4111' }).success).toBe(false);
  });
});
