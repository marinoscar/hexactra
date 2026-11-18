// Rate limits of `/api/mcp` (#465). The platform ships no global throttler,
// and a global `APP_GUARD` would have to be declared to the `host` conformance
// suite: these limits are a guard on `McpController` only, after
// authentication, plus the transport's count of unauthenticated answers.
//
//   key kind       key                                   default (per minute)
//   credential     grant:<id> | pat:<id> | session:<user>  120, all methods
//   writes         writes:<grant id>                      30 `tools/call` whose tool's effect is not `read` (OAuth apps)
//   user           user:<id>                              600, across all the user's credentials
//   unauthenticated  unauth:<source address>              30 answers `401` (discovery probes)
//
// The limiter sits behind the `MCP_RATE_LIMITER` token, chosen at boot by
// `MCP_RATE_LIMIT_STORE` (McpSecurityModule): `memory` (the default, one API
// process) is an exact sliding window in this process's memory; `postgres`
// (several API replicas, #517) is a sliding window counter in the shared
// `rate_limit_windows` table (mcp.rate-limit.pg.ts), which also backs the
// OAuth server's limits.
//
// Failure: a limiter that throws lets an authenticated caller through and
// refuses an unauthenticated one (fail open / fail closed), logging once a minute.
import { Catch, HttpException, Inject, Injectable, Logger, Optional, type ArgumentsHost, type CanActivate, type ExceptionFilter, type ExecutionContext } from '@nestjs/common';
import { authCredentialOf, type AuthCredentialInfo, type RequestWithAuthCredential } from '@marinoscar/platform-api/identity';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { McpActivityService } from './mcp-activity.service';
import { McpSettingsReader } from './mcp-settings.reader';
import { McpMetrics } from './mcp.metrics';
import { clientBucket } from './mcp.protocol';
import { RPC, rpcError, type RpcResponse } from './mcp.results';
import { MCP_TOOLS } from './mcp.tools';

/** Injection token of the limiter. */
export const MCP_RATE_LIMITER = Symbol('MCP_RATE_LIMITER');

/** What a limiter answers for one hit. */
export interface McpRateVerdict {
  allowed: boolean;
  /** When refused: whole seconds until a slot frees (at least 1). */
  retryAfterS: number;
}

/** A sliding-window limiter. `hit` counts one request against `key` when it is allowed. */
export interface McpRateLimiter {
  hit(key: string, limit: number, windowMs: number): McpRateVerdict | Promise<McpRateVerdict>;
}

/** The window of every MCP limit. */
export const MCP_RATE_WINDOW_MS = 60_000;

/**
 * The default limiter: per key, the times of the hits in the last window
 * (an exact sliding window; at most `limit` entries per key). Keys idle for a
 * window are dropped on the way.
 */
export class InMemoryMcpRateLimiter implements McpRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, limit: number, windowMs: number): McpRateVerdict {
    const now = this.now();
    this.sweep(now, windowMs);
    const since = now - windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length >= limit) {
      this.hits.set(key, list);
      return { allowed: false, retryAfterS: Math.max(1, Math.ceil((list[0]! + windowMs - now) / 1000)) };
    }
    list.push(now);
    this.hits.set(key, list);
    return { allowed: true, retryAfterS: 0 };
  }

  private sweep(now: number, windowMs: number): void {
    if (now - this.lastSweep < windowMs) return;
    this.lastSweep = now;
    for (const [k, list] of this.hits) if (!list.length || list[list.length - 1]! <= now - windowMs) this.hits.delete(k);
  }
}

/** The kinds of key a refusal names (the metric's `key_kind`). */
export const MCP_RATE_KEY_KINDS = ['credential', 'writes', 'user', 'unauthenticated'] as const;
export type McpRateKeyKind = (typeof MCP_RATE_KEY_KINDS)[number];

/**
 * A refusal of the MCP transport that must reach the client as an HTTP status
 * with a JSON-RPC body (429, 503), not as the platform's error envelope:
 * thrown by the guards, written by `McpRefusalFilter`.
 */
export class McpRefusal extends HttpException {
  constructor(
    readonly httpStatus: number,
    readonly rpc: RpcResponse,
    readonly headers: Record<string, string> = {},
  ) {
    super(rpc.error?.message ?? 'Refused', httpStatus);
  }
}

/** The JSON-RPC id of a single message body, for the refusal (null for a batch or a bad body). */
export function rpcIdOf(body: unknown): string | number | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/** A `429` with `Retry-After` and the wait in the message. */
export function rateLimitedRefusal(id: string | number | null, retryAfterS: number, what: string): McpRefusal {
  return new McpRefusal(429, rpcError(id, RPC.RATE_LIMITED, `Too many requests (${what}). Wait ${retryAfterS} seconds and try again.`, { retryAfterS }), {
    'retry-after': String(retryAfterS),
  });
}

/** Whether a message is a `tools/call` of a tool that changes something (effect not `read`). */
function isWriteCall(m: unknown): boolean {
  if (m === null || typeof m !== 'object' || (m as { method?: unknown }).method !== 'tools/call') return false;
  const name = String(((m as { params?: { name?: unknown } }).params ?? {}).name ?? '');
  const tool = MCP_TOOLS.find((t) => t.name === name);
  return tool !== undefined && tool.effect !== 'read';
}

/** The number of write calls in a body (a batch counts each). */
export function writeCalls(body: unknown): number {
  return Array.isArray(body) ? body.filter(isWriteCall).length : isWriteCall(body) ? 1 : 0;
}

/** The credential key of a request: the grant, the token or the session's user. */
export function credentialKey(credential: AuthCredentialInfo | null, userId: string | undefined): string | null {
  if (credential?.kind === 'oauth') return `grant:${credential.grantId}`;
  if (credential?.kind === 'pat') return `pat:${credential.tokenId}`;
  if (userId) return `session:${userId}`;
  return null;
}

/** Logs at most once a minute. */
class Throttled {
  private last = 0;
  constructor(private readonly log: Logger) {}
  warn(msg: string): void {
    const now = Date.now();
    if (now - this.last < 60_000) return;
    this.last = now;
    this.log.warn(msg);
  }
}

/**
 * The kill switches (#465), before the rate limits: an app signed in with
 * OAuth while `mcp.externalAppsEnabled` is false, or a personal access token
 * while `mcp.patMcpEnabled` is false, is refused with HTTP `503` and a JSON-RPC
 * error. Console sessions are never refused here.
 */
@Injectable()
export class McpKillSwitchGuard implements CanActivate {
  constructor(
    private readonly settings: McpSettingsReader,
    @Optional() private readonly activity?: McpActivityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest & RequestWithAuthCredential & { user?: { id?: string; orgId?: string } }>();
    const credential = authCredentialOf(req);
    if (credential?.kind !== 'oauth' && credential?.kind !== 'pat') return true;
    const s = await this.settings.read();
    const id = rpcIdOf(req.body);
    if (credential.kind === 'oauth' && !s.externalAppsEnabled) {
      await this.activity?.refusal(req, 'kill_switch');
      throw new McpRefusal(503, rpcError(id, RPC.DISABLED, 'External AI apps are turned off on this Hexactra. An administrator can turn them back on in Administration → External AI apps.'), { 'retry-after': '300' });
    }
    if (credential.kind === 'pat' && !s.patMcpEnabled) {
      await this.activity?.refusal(req, 'kill_switch');
      throw new McpRefusal(503, rpcError(id, RPC.DISABLED, 'Personal access tokens are turned off for MCP on this Hexactra. An administrator can turn them back on in Administration → External AI apps.'), { 'retry-after': '300' });
    }
    return true;
  }
}

/**
 * The per-credential, per-app write and per-user limits of `/api/mcp`
 * (#465), after authentication. A refusal is HTTP `429` with `Retry-After` and
 * a JSON-RPC error naming the wait.
 */
@Injectable()
export class McpRateLimitGuard implements CanActivate {
  private readonly log = new Logger(McpRateLimitGuard.name);
  private readonly failures = new Throttled(this.log);

  constructor(
    @Inject(MCP_RATE_LIMITER) private readonly limiter: McpRateLimiter,
    private readonly settings: McpSettingsReader,
    @Optional() private readonly metrics?: McpMetrics,
    @Optional() private readonly activity?: McpActivityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest & RequestWithAuthCredential & { user?: { id?: string } }>();
    const credential = authCredentialOf(req);
    const userId = req.user?.id;
    const s = await this.settings.read();
    const checks: Array<{ kind: McpRateKeyKind; key: string; limit: number; count: number; what: string }> = [];
    const ck = credentialKey(credential, userId);
    if (ck) checks.push({ kind: 'credential', key: ck, limit: s.rateLimitPerCredential, count: 1, what: `${s.rateLimitPerCredential} requests per minute for this connection` });
    if (userId) checks.push({ kind: 'user', key: `user:${userId}`, limit: s.rateLimitPerUser, count: 1, what: `${s.rateLimitPerUser} requests per minute for this account` });
    const writes = credential?.kind === 'oauth' ? writeCalls(req.body) : 0;
    if (credential?.kind === 'oauth' && writes > 0) {
      checks.push({ kind: 'writes', key: `writes:${credential.grantId}`, limit: s.rateLimitWritesPerApp, count: writes, what: `${s.rateLimitWritesPerApp} actions per minute for this app` });
    }
    for (const c of checks) {
      let verdict: McpRateVerdict = { allowed: true, retryAfterS: 0 };
      try {
        for (let i = 0; i < c.count && verdict.allowed; i++) verdict = await this.limiter.hit(c.key, c.limit, MCP_RATE_WINDOW_MS);
      } catch (e) {
        // Fail open: the caller is authenticated.
        this.failures.warn(`the MCP rate limiter failed (${e instanceof Error ? e.message : String(e)}); letting authenticated calls through`);
        return true;
      }
      if (!verdict.allowed) {
        const client = clientBucket(req.headers['user-agent'] as string | undefined);
        this.metrics?.rateLimited({ keyKind: c.kind, client });
        await this.activity?.refusal(req, 'rate_limited', { keyKind: c.kind });
        throw rateLimitedRefusal(rpcIdOf(req.body), verdict.retryAfterS, c.what);
      }
    }
    return true;
  }
}

/**
 * The unauthenticated limit, applied by the transport (an `onSend` hook on
 * `/api/mcp`): every `401` counts against its source address, and once over
 * the limit the `401` becomes a `429` with `Retry-After`. An authenticated
 * request is never affected. A failing limiter refuses (fail closed).
 */
export class McpUnauthenticatedLimit {
  private readonly log = new Logger('McpUnauthenticatedLimit');
  private readonly failures = new Throttled(this.log);

  constructor(
    private readonly limiter: McpRateLimiter,
    private readonly limit: () => Promise<number>,
    private readonly onLimited?: (client: string) => void,
  ) {}

  /** `null` when the 401 may stand; otherwise the seconds to wait. */
  async over(address: string, userAgent: string | undefined): Promise<number | null> {
    let verdict: McpRateVerdict;
    try {
      verdict = await this.limiter.hit(`unauth:${address}`, await this.limit(), MCP_RATE_WINDOW_MS);
    } catch (e) {
      this.failures.warn(`the MCP rate limiter failed (${e instanceof Error ? e.message : String(e)}); refusing unauthenticated calls`);
      return 60;
    }
    if (verdict.allowed) return null;
    this.onLimited?.(clientBucket(userAgent));
    return verdict.retryAfterS;
  }
}

/**
 * Writes a `McpRefusal` (from the kill switch or the rate limit guard) as the
 * MCP transport answers: the HTTP status, its headers and a JSON-RPC body,
 * never the platform's error envelope. Scoped to `McpController`.
 */
@Catch(McpRefusal)
export class McpRefusalFilter implements ExceptionFilter {
  catch(e: McpRefusal, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    for (const [k, v] of Object.entries(e.headers)) void reply.header(k, v);
    void reply.code(e.httpStatus).header('content-type', 'application/json').header('cache-control', 'no-store').send(JSON.stringify(e.rpc));
  }
}
