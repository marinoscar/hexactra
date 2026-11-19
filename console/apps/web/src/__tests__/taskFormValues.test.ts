// The task form's pure parts (#427): sites, request bodies and API error mapping.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTestApiError } from '@marinoscar/platform-web/testing';
import { describe, expect, it } from 'vitest';

import {
  DOMAIN_RE,
  PROFILE_NAME_RE,
  addDomains,
  copyValues,
  createBody,
  emptyValues,
  fieldOfPath,
  isDirty,
  mapApiError,
  normalizeDomain,
  normalizePath,
  patchBody,
  schedulesChanged,
  splitDomains,
  validateValues,
  valuesFromTask,
  type TaskWithSchedules,
} from '../taskForm/values';

// Read at run time, not imported: the web image's build type-checks src/ with
// only apps/web and packages/shared in its context (apps/web/Dockerfile), so an
// import of a file outside them fails `tsc` there.
const openapi: unknown = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'packages', 'sdk', 'openapi.json'), 'utf8'));

const TASK: TaskWithSchedules = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Check fare',
  goal: 'Find the cheapest fare',
  profile: 'travel',
  hostId: null,
  hostFallback: true,
  allowedDomains: ['flights.example.test'],
  confirmRiskyActions: true,
  policyId: 'builtin:economy',
  summary: { schedules: [{ id: 's1', cron: '0 9 * * 1-5', timezone: 'UTC', enabled: true, concurrency: 'queue', policyId: 'builtin:thorough' }] },
};

describe('allowed sites', () => {
  it('keeps the hostname of a URL, lower-cases, and keeps a wildcard', () => {
    expect(normalizeDomain('https://shop.example.test/cart?x=1')).toBe('shop.example.test');
    expect(normalizeDomain(' Shop.Example.test ')).toBe('shop.example.test');
    expect(normalizeDomain('*.Example.test')).toBe('*.example.test');
    expect(normalizeDomain('http://user@a.example.test:8080/x')).toBe('a.example.test');
    expect(normalizeDomain('  ')).toBe('');
  });

  it('adds entries without duplicates and stops at 50', () => {
    expect(addDomains(['a.example.test'], splitDomains('Shop.Example.test, https://a.example.test/x b.example.test'))).toEqual(['a.example.test', 'shop.example.test', 'b.example.test']);
    const many = Array.from({ length: 60 }, (_, i) => `s${i}.example.test`);
    expect(addDomains([], many)).toHaveLength(50);
  });

  it('names an entry the server would refuse', () => {
    const errors = validateValues({ ...emptyValues(), name: 'n', goal: 'g', allowedDomains: ['ok.example.test', 'not_a_site'] }, { checkProfile: true });
    expect(errors.allowedDomains).toMatch(/“not_a_site” is not a site/);
  });
});

describe('the rules mirror the API', () => {
  const schemas = (openapi as { components: { schemas: Record<string, { properties?: Record<string, { pattern?: string; items?: { pattern?: string } }> }> } }).components.schemas;
  const patterns = Object.values(schemas).flatMap((s) => Object.entries(s.properties ?? {}).map(([name, p]) => ({ name, pattern: name === 'allowedDomains' ? p.items?.pattern : p.pattern })));

  it('the domain expression is the one in the OpenAPI document', () => {
    const documented = patterns.filter((p) => p.name === 'allowedDomains' && p.pattern).map((p) => p.pattern);
    expect(documented.length).toBeGreaterThan(0);
    for (const pattern of documented) expect(pattern).toBe(DOMAIN_RE.source);
  });

  it('the profile name expression is the one in the OpenAPI document', () => {
    const documented = patterns.filter((p) => p.name === 'profile' && p.pattern).map((p) => p.pattern);
    expect(documented.length).toBeGreaterThan(0);
    for (const pattern of documented) expect(pattern).toBe(PROFILE_NAME_RE.source);
  });
});

describe('request bodies', () => {
  it('create carries every task field, policyId only when allowed, schedules only when there are some, and no legacy field', () => {
    const values = valuesFromTask(TASK);
    const body = createBody(values, { sendPolicy: true });
    expect(body).toEqual({
      name: 'Check fare',
      goal: 'Find the cheapest fare',
      profile: 'travel',
      hostId: null,
      hostFallback: true,
      allowedDomains: ['flights.example.test'],
      confirmRiskyActions: true,
      useSavedLogins: false,
      unattendedPayments: 'ask',
      policyId: 'builtin:economy',
      schedules: [{ id: 's1', cron: '0 9 * * 1-5', timezone: 'UTC', enabled: true, concurrency: 'queue', policyId: 'builtin:thorough' }],
    });
    const plain = createBody({ ...values, schedules: [] }, { sendPolicy: false });
    expect(plain).not.toHaveProperty('policyId');
    expect(plain).not.toHaveProperty('schedules');
    for (const legacy of ['maxSteps', 'maxMinutes', 'model']) expect(body).not.toHaveProperty(legacy);
  });

  it('patch carries only what changed', () => {
    const { schedules: _s, ...fields } = valuesFromTask(TASK);
    expect(patchBody(fields, fields, { sendPolicy: true })).toBeNull();
    expect(patchBody({ ...fields, policyId: null }, fields, { sendPolicy: true })).toEqual({ policyId: null });
    expect(patchBody({ ...fields, policyId: null }, fields, { sendPolicy: false })).toBeNull();
    expect(patchBody({ ...fields, name: ' Fares ', allowedDomains: [] }, fields, { sendPolicy: true })).toEqual({ name: 'Fares', allowedDomains: [] });
  });

  it('a copy is named "Copy of", keeps the policy and pauses its schedules as new ones', () => {
    const copy = copyValues(TASK);
    expect(copy.name).toBe('Copy of Check fare');
    expect(copy.policyId).toBe('builtin:economy');
    expect(copy.schedules).toEqual([{ cron: '0 9 * * 1-5', timezone: 'UTC', enabled: false, concurrency: 'queue', policyId: 'builtin:thorough' }]);
  });

  it('dirty follows the fields and the schedule set', () => {
    const values = valuesFromTask(TASK);
    expect(isDirty(values, values)).toBe(false);
    expect(isDirty({ ...values, goal: 'Other' }, values)).toBe(true);
    expect(schedulesChanged([], values.schedules)).toBe(true);
    expect(isDirty({ ...values, schedules: [{ ...values.schedules[0]!, enabled: false }] }, values)).toBe(true);
  });
});

describe('API errors', () => {
  it('reads both path spellings', () => {
    expect(normalizePath('allowedDomains.2')).toBe('allowedDomains[2]');
    expect(normalizePath(['schedules', 1, 'cron'])).toBe('schedules[1].cron');
    expect(fieldOfPath('schedules[1].cron')).toBe('schedules[1]');
    expect(fieldOfPath('allowedDomains[2]')).toBe('allowedDomains');
    expect(fieldOfPath('nope')).toBeNull();
  });

  it('puts a schedule issue on its schedule, without the path in the message', () => {
    const path = 'schedules[1].cron';
    const mapped = mapApiError(createTestApiError(400, `${path}: Not a 5-field cron expression`, 'INVALID_CRON', { path, issues: [{ path, message: 'Not a 5-field cron expression' }] }), 'x');
    expect(mapped).toEqual({ fields: { 'schedules[1]': 'Not a 5-field cron expression' }, banner: null });
  });

  it('puts validation issues on their fields and the rest in the banner', () => {
    const mapped = mapApiError(
      createTestApiError(400, 'Validation failed', 'VALIDATION_ERROR', {
        issues: [
          { path: 'name', message: 'Too long' },
          { path: 'allowedDomains.2', message: 'A hostname such as example.test' },
          { path: 'somethingElse', message: 'Unexpected' },
        ],
      }),
      'x',
    );
    expect(mapped.fields).toEqual({ name: 'Too long', allowedDomains: 'Site 3: A hostname such as example.test' });
    expect(mapped.banner).toBe('somethingElse: Unexpected');
  });

  it('maps a refused policy and the schedule limit by code, and anything else to the banner', () => {
    expect(mapApiError(createTestApiError(400, 'policyId does not name a policy', 'POLICY_REF_INVALID'), 'x').fields).toHaveProperty('policyId');
    expect(mapApiError(createTestApiError(409, 'A task has at most 10 schedules', 'SCHEDULE_LIMIT'), 'x').fields).toEqual({ schedules: 'A task has at most 10 schedules' });
    expect(mapApiError(createTestApiError(500, 'Boom'), 'x')).toEqual({ fields: {}, banner: 'Boom' });
    expect(mapApiError(new Error(''), 'Could not save')).toEqual({ fields: {}, banner: 'Could not save' });
  });
});
