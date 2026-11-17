// The run filter (#420): what the query parameters parse to, the WHERE they
// build, and the cursor. Delete by filter and retention reuse exactly these.
import { BadRequestException } from '@nestjs/common';

import { decodeRunCursor, encodeRunCursor, runWhere } from '../src/tasks/runs.query';
import { listRunsSchema, runCountsQuerySchema, runFilterSchema } from '../src/tasks/runs.schemas';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return ((err as BadRequestException).getResponse() as { code?: string }).code;
  }
  return undefined;
};

describe('runFilterSchema', () => {
  it('reads a list as repeated values, comma-separated values, or one value', () => {
    expect(runFilterSchema.parse({ status: 'failed' }).status).toEqual(['failed']);
    expect(runFilterSchema.parse({ status: 'failed, cancelled,failed' }).status).toEqual(['failed', 'cancelled']);
    expect(runFilterSchema.parse({ status: ['failed', 'queued,running'] }).status).toEqual(['failed', 'queued', 'running']);
    expect(runFilterSchema.parse({ trigger: ['mcp', 'api'], stopReason: 'budget,stalled' })).toMatchObject({ trigger: ['mcp', 'api'], stopReason: ['budget', 'stalled'] });
  });

  it('treats an empty list and an empty search as absent', () => {
    expect(runFilterSchema.parse({ status: '', trigger: ',', q: '   ' })).toEqual({});
    expect(runFilterSchema.parse({ q: '  fare ' }).q).toBe('fare');
  });

  it('rejects unknown values, malformed dates and ids', () => {
    for (const bad of [{ status: 'done' }, { status: 'failed,done' }, { trigger: 'cron' }, { stopReason: 'budget_everything' }, { state: 'open' }, { taskId: 'x' }, { from: '2026-06-01' }, { to: 'soon' }, { q: 'x'.repeat(201) }, { policyId: 'builtin:nope' }]) {
      expect(runFilterSchema.safeParse(bad).success).toBe(false);
    }
    expect(runFilterSchema.parse({ taskId: 'none', from: '2026-06-01T00:00:00Z', to: '2026-06-02T00:00:00+02:00', policyId: 'builtin:balanced' })).toMatchObject({ taskId: 'none' });
  });

  it('pages with a default of 50: up to 100 with the envelope, up to 200 without', () => {
    expect(listRunsSchema.parse({})).toEqual({ limit: 50, order: 'desc' });
    expect(listRunsSchema.parse({ envelope: '1', limit: '100', order: 'asc' })).toEqual({ envelope: true, limit: 100, order: 'asc' });
    expect(listRunsSchema.parse({ limit: '200' }).limit).toBe(200);
    expect(listRunsSchema.safeParse({ envelope: '1', limit: '101' }).success).toBe(false);
    expect(listRunsSchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(listRunsSchema.safeParse({ envelope: 'yes' }).success).toBe(false);
  });

  it('the counts query has no status and no state', () => {
    expect(runCountsQuerySchema.parse({ status: 'failed', state: 'live', q: 'fare' })).toEqual({ q: 'fare' });
  });
});

describe('runWhere', () => {
  it('is empty for an empty filter', () => {
    expect(runWhere({})).toEqual({});
  });

  it('builds one condition per filter', () => {
    const where = runWhere(
      runFilterSchema.parse({
        status: 'failed,cancelled',
        taskId: 'none',
        trigger: 'mcp',
        from: '2026-06-01T00:00:00Z',
        to: '2026-07-01T00:00:00Z',
        q: 'Fare',
        stopReason: 'budget,stalled',
        policyId: 'builtin:balanced',
      }),
    );
    expect(where).toEqual({
      status: { in: ['failed', 'cancelled'] },
      taskId: null,
      trigger: { in: ['mcp'] },
      createdAt: { gte: new Date('2026-06-01T00:00:00Z'), lt: new Date('2026-07-01T00:00:00Z') },
      goal: { contains: 'Fare', mode: 'insensitive' },
      stopReason: { in: ['budget_actions', 'budget_model_calls', 'budget_active_time', 'budget_input_tokens', 'budget_output_tokens', 'budget_cost', 'stalled'] },
      policyRef: 'builtin:balanced',
    });
  });

  it('expands state to its statuses', () => {
    expect(runWhere({ state: 'live' })).toEqual({ status: { in: ['queued', 'running', 'waiting_human'] } });
    expect(runWhere({ state: 'finished' })).toEqual({ status: { in: ['succeeded', 'failed', 'cancelled'] } });
  });

  it('rejects status with state, and from after to, with INVALID_FILTER', () => {
    expect(code(() => runWhere({ status: ['failed'], state: 'live' }))).toBe('INVALID_FILTER');
    expect(code(() => runWhere({ from: '2026-06-02T00:00:00Z', to: '2026-06-01T00:00:00Z' }))).toBe('INVALID_FILTER');
    expect(runWhere({ from: '2026-06-01T00:00:00Z', to: '2026-06-01T00:00:00Z' })).toHaveProperty('createdAt');
  });
});

describe('the run cursor', () => {
  it('round-trips and is URL-safe', () => {
    const cursor = { c: '2026-06-01T12:00:00.123456Z', i: '3f0c1a52-5d5e-4c0e-9d0a-1b2c3d4e5f60' };
    const text = encodeRunCursor(cursor);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRunCursor(text)).toEqual(cursor);
  });

  it('rejects anything else with INVALID_CURSOR', () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const bad of ['', 'x', '%%%', b64(null), b64({}), b64({ c: '2026-06-01T12:00:00Z', i: '3f0c1a52-5d5e-4c0e-9d0a-1b2c3d4e5f60' }), b64({ c: '2026-13-41T12:00:00.000000Z', i: '3f0c1a52-5d5e-4c0e-9d0a-1b2c3d4e5f60' }), b64({ c: '2026-06-01T12:00:00.000000Z', i: "1' OR '1'='1" })]) {
      expect(code(() => decodeRunCursor(bad))).toBe('INVALID_CURSOR');
    }
  });
});
