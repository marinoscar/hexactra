// The shared rate limit store (#517), without a database: the window math of
// the sliding window counter, the store setting, the key hashing, the
// bindings, the cleanup job and the failure modes (the MCP guard fails open
// for an authenticated caller, the unauthenticated limit and the OAuth
// adapter fail closed). The shared limit across processes: rate-limit-shared.db.spec.ts.
import type { ExecutionContext } from '@nestjs/common';

import { MCP_DEFAULT_SETTINGS } from '../src/mcp/mcp.settings';
import { mcpRateLimiterFactory, oauthRateLimiterFactory } from '../src/mcp/mcp-security.module';
import { InMemoryMcpRateLimiter, McpRateLimitGuard, McpUnauthenticatedLimit } from '../src/mcp/mcp.rate-limit';
import { MCP_RATE_LIMIT_PURGE_JOB, McpRateLimitPurgeHandler, McpRateLimitPurgeTask } from '../src/mcp/mcp.rate-limit.jobs';
import {
  PostgresRateLimiter,
  RATE_LIMIT_KEY_MAX,
  SharedOAuthRateLimiter,
  rateLimitStoreFrom,
  retryAfterSeconds,
  slidingWindowAllows,
  slidingWindowRetryMs,
  storedRateLimitKey,
  windowPosition,
} from '../src/mcp/mcp.rate-limit.pg';
import type { PrismaService } from '../src/prisma/prisma.service';

const W = 60_000;

describe('the sliding window counter (#517)', () => {
  it('places now in its fixed window and weighs the previous one by what is left of it', () => {
    expect(windowPosition(120_000, W)).toEqual({ startMs: 120_000, prevStartMs: 60_000, elapsedMs: 0, carry: 1 });
    expect(windowPosition(135_000, W)).toEqual({ startMs: 120_000, prevStartMs: 60_000, elapsedMs: 15_000, carry: 0.75 });
    expect(windowPosition(179_999, W).startMs).toBe(120_000);
    expect(windowPosition(180_000, W)).toMatchObject({ startMs: 180_000, elapsedMs: 0 });
  });

  it('allows while current + 1 + floor(previous × carry) stays within the limit', () => {
    // Nothing before: exactly `limit` hits fit.
    expect(slidingWindowAllows({ limit: 3, prev: 0, cur: 2, carry: 1 })).toBe(true);
    expect(slidingWindowAllows({ limit: 3, prev: 0, cur: 3, carry: 1 })).toBe(false);
    // A full previous window at the start of this one leaves no room.
    expect(slidingWindowAllows({ limit: 10, prev: 10, cur: 0, carry: 1 })).toBe(false);
    // Half way through, half of it still counts.
    expect(slidingWindowAllows({ limit: 10, prev: 10, cur: 4, carry: 0.5 })).toBe(true);
    expect(slidingWindowAllows({ limit: 10, prev: 10, cur: 5, carry: 0.5 })).toBe(false);
    // floor: 9 × 0.5 = 4.5 counts as 4.
    expect(slidingWindowAllows({ limit: 10, prev: 9, cur: 5, carry: 0.5 })).toBe(true);
    // A zero limit refuses everything.
    expect(slidingWindowAllows({ limit: 0, prev: 0, cur: 0, carry: 1 })).toBe(false);
  });

  it('the wait after a refusal: until the previous window weighs little enough, or until the next window', () => {
    // Room in this window, the previous one full: 10 × (60 − 15 − d)/60 < 10 − 5 → d > 15 s.
    expect(slidingWindowRetryMs({ limit: 10, windowMs: W, elapsedMs: 15_000, prev: 10, cur: 5 })).toBe(15_001);
    // This window full (5 of 5) at 20 s: 40 s to its end, then 5 × (60 − e)/60 < 5 → e > 0.
    expect(slidingWindowRetryMs({ limit: 5, windowMs: W, elapsedMs: 20_000, prev: 0, cur: 5 })).toBe(40_001);
    // Over full (a race added one): 6 × (60 − e)/60 < 5 → e > 10 s.
    expect(slidingWindowRetryMs({ limit: 5, windowMs: W, elapsedMs: 20_000, prev: 0, cur: 6 })).toBe(50_001);
    // A zero limit: the rest of this window and the next.
    expect(slidingWindowRetryMs({ limit: 0, windowMs: W, elapsedMs: 0, prev: 0, cur: 0 })).toBe(120_000);
    expect(retryAfterSeconds(15_001)).toBe(16);
    expect(retryAfterSeconds(0)).toBe(1);
  });

  it('the wait it names is enough: after it, the same counts allow the hit', () => {
    for (const c of [
      { limit: 10, elapsedMs: 15_000, prev: 10, cur: 5 },
      { limit: 7, elapsedMs: 59_000, prev: 120, cur: 6 },
      { limit: 30, elapsedMs: 1_000, prev: 31, cur: 0 },
    ]) {
      expect(slidingWindowAllows({ limit: c.limit, prev: c.prev, cur: c.cur, carry: (W - c.elapsedMs) / W })).toBe(false);
      const d = slidingWindowRetryMs({ ...c, windowMs: W });
      const t = c.elapsedMs + d;
      expect(t).toBeLessThan(W);
      expect(slidingWindowAllows({ limit: c.limit, prev: c.prev, cur: c.cur, carry: (W - t) / W })).toBe(true);
      expect(slidingWindowAllows({ limit: c.limit, prev: c.prev, cur: c.cur, carry: (W - t + 2) / W })).toBe(false);
    }
  });
});

describe('the store setting and the keys (#517)', () => {
  it('MCP_RATE_LIMIT_STORE: memory by default, postgres on demand, anything else fails the boot', () => {
    expect(rateLimitStoreFrom({})).toBe('memory');
    expect(rateLimitStoreFrom({ MCP_RATE_LIMIT_STORE: '' })).toBe('memory');
    expect(rateLimitStoreFrom({ MCP_RATE_LIMIT_STORE: 'memory' })).toBe('memory');
    expect(rateLimitStoreFrom({ MCP_RATE_LIMIT_STORE: ' Postgres ' })).toBe('postgres');
    expect(() => rateLimitStoreFrom({ MCP_RATE_LIMIT_STORE: 'redis' })).toThrow(/memory, postgres/);
  });

  it('binds the in-memory limiter by default and the Postgres one (plus the OAuth adapter) with postgres', () => {
    const before = process.env.MCP_RATE_LIMIT_STORE;
    const prisma = { $queryRaw: jest.fn() } as unknown as PrismaService;
    try {
      delete process.env.MCP_RATE_LIMIT_STORE;
      const mem = mcpRateLimiterFactory(prisma);
      expect(mem).toBeInstanceOf(InMemoryMcpRateLimiter);
      expect(oauthRateLimiterFactory(mem)).toBeUndefined();
      process.env.MCP_RATE_LIMIT_STORE = 'postgres';
      const pg = mcpRateLimiterFactory(prisma);
      expect(pg).toBeInstanceOf(PostgresRateLimiter);
      expect(oauthRateLimiterFactory(pg)).toBeInstanceOf(SharedOAuthRateLimiter);
    } finally {
      if (before === undefined) delete process.env.MCP_RATE_LIMIT_STORE;
      else process.env.MCP_RATE_LIMIT_STORE = before;
    }
  });

  it('a long key (a client id that is a URL) is stored as its SHA-256', () => {
    expect(storedRateLimitKey('grant:abc')).toBe('grant:abc');
    const long = `oauth:token:https://${'x'.repeat(RATE_LIMIT_KEY_MAX)}.example.test/client.json`;
    expect(storedRateLimitKey(long)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(storedRateLimitKey(long)).toBe(storedRateLimitKey(long));
  });

  it('the Postgres limiter maps the statement: a returned count allows, none refuses with the wait', async () => {
    const queryRaw = jest.fn();
    const l = new PostgresRateLimiter({ $queryRaw: queryRaw } as never, () => 135_000);
    queryRaw.mockResolvedValueOnce([{ hits: 3, prev: 0, cur: 2 }]);
    expect(await l.hit('k', 5, W)).toEqual({ allowed: true, retryAfterS: 0 });
    queryRaw.mockResolvedValueOnce([{ hits: null, prev: 10, cur: 5 }]);
    expect(await l.hit('k', 10, W)).toEqual({ allowed: false, retryAfterS: 16 });
    await expect(l.hit('k', 10, 0)).rejects.toThrow(/invalid rate limit window/);
  });
});

describe('failure modes of the shared store (#517)', () => {
  const down = () => new PostgresRateLimiter({ $queryRaw: jest.fn().mockRejectedValue(new Error('connection refused')) } as never);

  it('the Postgres limiter throws on a database error (it never swallows it)', async () => {
    await expect(down().hit('k', 10, W)).rejects.toThrow('connection refused');
  });

  it('an authenticated MCP caller is let through (fail open)', async () => {
    const guard = new McpRateLimitGuard(down(), { read: async () => MCP_DEFAULT_SETTINGS } as never);
    const req = { headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, user: { id: 'u-1' } };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('an unauthenticated MCP caller is refused (fail closed)', async () => {
    const limit = new McpUnauthenticatedLimit(down(), async () => 30);
    expect(await limit.over('203.0.113.9', 'probe')).toBe(60);
  });

  it('the OAuth endpoints (unauthenticated) are refused with a wait, not a 500 (fail closed)', async () => {
    expect(await new SharedOAuthRateLimiter(down()).consume('oauth:authorize:203.0.113.9', 30, W)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    const ok = new SharedOAuthRateLimiter({ hit: async () => ({ allowed: false, retryAfterS: 12 }) });
    expect(await ok.consume('k', 1, W)).toEqual({ allowed: false, retryAfterSeconds: 12 });
  });
});

describe('the cleanup job (#517)', () => {
  it('registers a permanent type and deletes the windows past their expiry', async () => {
    const register = jest.fn();
    const deleteMany = jest.fn().mockResolvedValue({ count: 4 });
    const h = new McpRateLimitPurgeHandler({ register } as never, { rateLimitWindow: { deleteMany } } as never);
    h.onModuleInit();
    expect(register).toHaveBeenCalledWith(h);
    expect(h.type).toBe('mcp.rate_limit.purge');
    expect(MCP_RATE_LIMIT_PURGE_JOB).toBe('mcp.rate_limit.purge');
    expect(h.profile).toEqual({ maxRuntimeMs: 300_000, maxAttempts: 2 });
    const now = new Date('2026-11-18T12:00:00Z');
    expect(await h.purge(now)).toBe(4);
    expect(deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lt: now } } });
  });

  it('the hourly cron enqueues only with the Postgres store, and does no work itself', async () => {
    const before = process.env.MCP_RATE_LIMIT_STORE;
    const enqueue = jest.fn().mockResolvedValue({ id: 'j' });
    const prisma = { job: { findFirst: jest.fn().mockResolvedValue(null) } };
    const task = new McpRateLimitPurgeTask({ enqueue } as never, prisma as never);
    try {
      delete process.env.MCP_RATE_LIMIT_STORE;
      await task.handleCron();
      expect(enqueue).not.toHaveBeenCalled();
      process.env.MCP_RATE_LIMIT_STORE = 'postgres';
      await task.handleCron();
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'mcp.rate_limit.purge' }));
    } finally {
      if (before === undefined) delete process.env.MCP_RATE_LIMIT_STORE;
      else process.env.MCP_RATE_LIMIT_STORE = before;
    }
  });
});
