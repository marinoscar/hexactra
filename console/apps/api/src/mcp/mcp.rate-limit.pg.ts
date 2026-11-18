// The shared store of the rate limiters (#517): a console with more than one
// API process sets `MCP_RATE_LIMIT_STORE=postgres`, and every replica then
// counts the MCP limits (`MCP_RATE_LIMITER`) and the OAuth server's limits
// (`OAUTH_RATE_LIMITER`) in one table, `rate_limit_windows`
// (prisma/fragments/rate-limits.prisma). The default, `memory`, keeps the
// exact sliding window of one process (mcp.rate-limit.ts).
//
// Algorithm: a sliding window COUNTER. Time is cut into fixed windows of the
// limit's length; a row counts the hits allowed in one window. A hit at
// `elapsed` ms into the current window is allowed when
//
//   current + 1 + floor(previous × (window − elapsed) / window) ≤ limit
//
// i.e. the previous window's hits are assumed spread evenly and only the part
// still inside the sliding window counts. It is an approximation of the exact
// sliding window (exact when hits are evenly spread; a burst at the end of the
// previous window is under-counted by at most its uneven share), it never lets
// more than `limit` through inside one fixed window, and it costs one row per
// key and window. Like the in-memory limiter, a refused hit is not counted.
//
// Atomicity across processes: one statement. The previous window is closed
// (read once); the current window's row is inserted, or updated under its row
// lock with the condition re-checked on the latest version
// (`ON CONFLICT … DO UPDATE … WHERE`), so two replicas never both take the
// last slot. The statement returns no `hits` exactly when the hit is refused.
//
// Clocks: each process computes the window from its own clock; keep the
// replicas' clocks synchronised (NTP). A skew of a second moves the weight of
// the previous window by 1/60 of a minute's limit.
//
// Failure: `hit` throws on a database error. The MCP guard then lets an
// authenticated caller through and the transport refuses an unauthenticated
// one (mcp.rate-limit.ts). The OAuth endpoints are unauthenticated, so the
// OAuth adapter below refuses (fail closed) with a 429 instead of a 500.
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { OAuthRateLimiter, OAuthRateLimitVerdict } from '@marinoscar/platform-api/identity';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import type { McpRateLimiter, McpRateVerdict } from './mcp.rate-limit';

/** The stores `MCP_RATE_LIMIT_STORE` names. */
export const RATE_LIMIT_STORES = ['memory', 'postgres'] as const;
export type RateLimitStore = (typeof RATE_LIMIT_STORES)[number];

/**
 * The store of this deployment, from `MCP_RATE_LIMIT_STORE` (empty: `memory`).
 * An unknown value fails the boot: a typo must not silently keep per-process limits.
 */
export function rateLimitStoreFrom(env: NodeJS.ProcessEnv = process.env): RateLimitStore {
  const raw = (env.MCP_RATE_LIMIT_STORE ?? '').trim().toLowerCase();
  if (raw === '') return 'memory';
  if ((RATE_LIMIT_STORES as readonly string[]).includes(raw)) return raw as RateLimitStore;
  throw new Error(`MCP_RATE_LIMIT_STORE must be one of ${RATE_LIMIT_STORES.join(', ')} (got "${env.MCP_RATE_LIMIT_STORE}")`);
}

/** The longest key stored as it is; a longer one (a client id that is a URL) is stored as its SHA-256. */
export const RATE_LIMIT_KEY_MAX = 200;

/** The key as stored. Pure. */
export function storedRateLimitKey(key: string): string {
  return key.length <= RATE_LIMIT_KEY_MAX ? key : `sha256:${createHash('sha256').update(key).digest('hex')}`;
}

/** Where `now` falls: the current fixed window, the previous one, and the previous window's weight. Pure. */
export function windowPosition(nowMs: number, windowMs: number): { startMs: number; prevStartMs: number; elapsedMs: number; carry: number } {
  const startMs = Math.floor(nowMs / windowMs) * windowMs;
  const elapsedMs = nowMs - startMs;
  return { startMs, prevStartMs: startMs - windowMs, elapsedMs, carry: (windowMs - elapsedMs) / windowMs };
}

/** Whether one more hit fits: `cur + 1 + floor(prev × carry) ≤ limit`. Pure (the SQL states the same condition). */
export function slidingWindowAllows(input: { limit: number; prev: number; cur: number; carry: number }): boolean {
  return input.cur + 1 + Math.floor(input.prev * input.carry) <= input.limit;
}

/**
 * After a refusal: the milliseconds until a hit would be allowed, if nothing
 * else is counted meanwhile. Pure.
 *
 * - Room left in this window (`cur < limit`): wait until the previous window's
 *   weight falls enough, `prev × (W − t − d) / W < limit − cur`.
 * - This window full: wait for the next one, then until this window's weight
 *   (it becomes the previous one) falls enough, `cur × (W − e) / W < limit`.
 */
export function slidingWindowRetryMs(input: { limit: number; windowMs: number; elapsedMs: number; prev: number; cur: number }): number {
  const { limit, windowMs, elapsedMs, prev, cur } = input;
  const toWindowEnd = windowMs - elapsedMs;
  if (limit <= 0) return toWindowEnd + windowMs;
  if (cur < limit) {
    if (prev <= 0) return 0;
    return Math.max(0, toWindowEnd - ((limit - cur) * windowMs) / prev) + 1;
  }
  return toWindowEnd + Math.max(0, windowMs * (1 - limit / cur)) + 1;
}

/** Whole seconds to tell the caller (at least 1). Pure. */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** The Postgres limiter (`MCP_RATE_LIMIT_STORE=postgres`). */
export class PostgresRateLimiter implements McpRateLimiter {
  constructor(
    private readonly prisma: Pick<PrismaService, '$queryRaw'>,
    private readonly now: () => number = Date.now,
  ) {}

  async hit(key: string, limit: number, windowMs: number): Promise<McpRateVerdict> {
    if (!Number.isInteger(windowMs) || windowMs <= 0 || windowMs > 2_000_000_000) throw new Error(`invalid rate limit window: ${windowMs}`);
    const pos = windowPosition(this.now(), windowMs);
    const k = storedRateLimitKey(key);
    const start = new Date(pos.startMs);
    const prevStart = new Date(pos.prevStartMs);
    // The row matters while it is the current or the previous window.
    const expires = new Date(pos.startMs + 2 * windowMs);
    const rows = await this.prisma.$queryRaw<Array<{ hits: number | null; prev: number; cur: number }>>(Prisma.sql`
      WITH prev AS (
        SELECT COALESCE((SELECT hits FROM rate_limit_windows WHERE key = ${k} AND window_ms = ${windowMs} AND window_start = ${prevStart}), 0)::int AS hits
      ), cur AS (
        SELECT COALESCE((SELECT hits FROM rate_limit_windows WHERE key = ${k} AND window_ms = ${windowMs} AND window_start = ${start}), 0)::int AS hits
      ), hit AS (
        INSERT INTO rate_limit_windows (key, window_ms, window_start, hits, expires_at)
        SELECT ${k}, ${windowMs}, ${start}, 1, ${expires} FROM prev
        WHERE 1 + floor(prev.hits * ${pos.carry}::float8) <= ${limit}
        ON CONFLICT (key, window_ms, window_start) DO UPDATE SET hits = rate_limit_windows.hits + 1
        WHERE rate_limit_windows.hits + 1 + (SELECT floor(prev.hits * ${pos.carry}::float8) FROM prev) <= ${limit}
        RETURNING hits
      )
      SELECT (SELECT hits FROM hit)::int AS hits, prev.hits AS prev, cur.hits AS cur FROM prev, cur`);
    const row = rows[0];
    if (!row) throw new Error('rate limit statement returned no row');
    if (row.hits !== null && row.hits !== undefined) return { allowed: true, retryAfterS: 0 };
    // `cur` is the count this statement saw before it ran (a concurrent hit may have added one since).
    const retryMs = slidingWindowRetryMs({ limit, windowMs, elapsedMs: pos.elapsedMs, prev: Number(row.prev), cur: Math.max(Number(row.cur), 0) });
    return { allowed: false, retryAfterS: retryAfterSeconds(retryMs) };
  }
}

/**
 * The OAuth server's limiter over a shared MCP limiter (bound to
 * `OAUTH_RATE_LIMITER` when the store is `postgres`). The OAuth endpoints are
 * unauthenticated, so a failing store refuses (429, `Retry-After: 60`) rather
 * than letting the platform answer 500. Unlike the platform's in-memory
 * default (a fixed window counting every hit), refused hits are not counted.
 */
export class SharedOAuthRateLimiter implements OAuthRateLimiter {
  private readonly log = new Logger('SharedOAuthRateLimiter');
  private lastWarn = 0;

  constructor(private readonly limiter: McpRateLimiter) {}

  async consume(key: string, limit: number, windowMs: number): Promise<OAuthRateLimitVerdict> {
    try {
      const v = await this.limiter.hit(key, limit, windowMs);
      return { allowed: v.allowed, retryAfterSeconds: v.allowed ? 0 : v.retryAfterS };
    } catch (e) {
      const now = Date.now();
      if (now - this.lastWarn >= 60_000) {
        this.lastWarn = now;
        this.log.warn(`the OAuth rate limiter failed (${e instanceof Error ? e.message : String(e)}); refusing OAuth calls`);
      }
      return { allowed: false, retryAfterSeconds: 60 };
    }
  }
}
