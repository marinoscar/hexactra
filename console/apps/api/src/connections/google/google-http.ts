// The one way the Google adapter talks to Google (E39.3, #601): plain `fetch`-style requests over the console's SSRF-guarded
// `OutboundHttp`, with typed wrappers above it (gmail.ts, google-calendar.ts, google-docs.ts). The choice and its reason are in
// docs/connections.md ("Google"): a handful of endpoints are needed, and `googleapis` would add tens of megabytes to the API image
// and a large transitive surface; the official clients are not worth that for twenty calls.
//
// What this layer guarantees to every call:
//   * the connection's own access token, taken from the token service for THIS connection at the moment of the call (a 401 forces
//     one refresh and one retry); tokens of two connections never meet;
//   * a per-connection concurrency limit (4) and an AbortSignal that cancels a wait, a backoff sleep and an in-flight request;
//   * exponential backoff with jitter on 429 and 5xx, at most 3 tries, honouring `Retry-After`; a request that is not safe to
//     repeat (a send, an append) is retried only on 429, never after a 5xx or a lost connection: the failure then says
//     `outcomeUnknown`;
//   * a typed error for every failure, built from the status and Google's reason CODES, never from its message (which can carry
//     the very subject, address or file name the owner trusted us with);
//   * privacy in telemetry: the span and the metrics carry the service, the operation name, the connection id, sizes, attempts and
//     the status code. No URL (ids and search text sit in it), no subject, address, body, file name, query or cell.
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { SpanStatusCode, trace } from '@opentelemetry/api';

import { OutboundHttp, OutboundHttpError } from '../../oauth-client/outbound-http';
import { CapabilityError, type ConnectionContext } from '../capabilities';
import { toCapabilityError } from '../capability-hub';
import { GOOGLE_CONCURRENCY, GOOGLE_MAX_TRIES, GOOGLE_MAX_WAIT_MS, type GoogleService } from './google.constants';
import type { GoogleOutcome } from './google.metrics';
import './google.metrics';

/** What the adapter needs of the token service (`ConnectionTokensService` satisfies it). */
export interface TokenSource {
  getAccessToken(connectionId: string, userId: string, opts?: { forceRefresh?: boolean }): Promise<string>;
}

export type QueryValue = string | number | boolean | undefined | readonly (string | number)[];

export interface GoogleCall {
  service: GoogleService;
  /** The operation's name for the span and the logs: `messages.list`. A bounded vocabulary, never data. */
  op: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute, without a query string. */
  url: string;
  query?: Record<string, QueryValue>;
  json?: unknown;
  raw?: { contentType: string; body: string };
  /** Safe to repeat after a 5xx or a lost connection (GET, and writes that carry their own idempotency key). */
  idempotent: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  /** Statuses the caller handles itself (returned, not thrown): `[404]` for "does it exist". */
  accept?: readonly number[];
}

export interface GoogleResponse<T = unknown> {
  status: number;
  data: T | null;
  headers: Record<string, string>;
  bytes: number;
}

export interface GoogleHttpOptions {
  /** Replaced by tests so no real time passes. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  maxTries?: number;
  concurrency?: number;
}

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CapabilityError('ABORTED'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CapabilityError('ABORTED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** A counting semaphore whose waiters leave when their signal fires. */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  get idle(): boolean {
    return this.active === 0 && this.waiters.length === 0;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const i = this.waiters.indexOf(go);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new CapabilityError('ABORTED'));
        };
        if (signal?.aborted) return reject(new CapabilityError('ABORTED'));
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(go);
      });
    } else this.active++;
    // The slot was handed over by `release` (active unchanged) or taken just now.
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export const GOOGLE_REASONS = {
  scope: ['insufficientpermissions', 'access_token_scope_insufficient', 'insufficient_scopes'],
  rate: ['ratelimitexceeded', 'userratelimitexceeded', 'rate_limit_exceeded', 'resource_exhausted'],
  quota: ['dailylimitexceeded', 'quotaexceeded', 'storagequotaexceeded', 'quota_exceeded', 'dailylimitexceededunreg'],
  disabled: ['accessnotconfigured', 'service_disabled'],
  notPicked: ['appnotauthorizedtofile'],
} as const;

/** The reason codes and the status word of a Google error body: a closed reading, never the message. */
export function readGoogleError(body: unknown): { reasons: Set<string>; status: string | null; scopeMessage: boolean } {
  const reasons = new Set<string>();
  let status: string | null = null;
  let scopeMessage = false;
  const err = (body as { error?: unknown } | null)?.error;
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; message?: unknown; errors?: unknown; details?: unknown };
    if (typeof e.status === 'string') status = e.status;
    if (typeof e.message === 'string') scopeMessage = /insufficient authentication scopes/i.test(e.message);
    for (const x of Array.isArray(e.errors) ? e.errors : []) if (typeof (x as { reason?: unknown })?.reason === 'string') reasons.add((x as { reason: string }).reason.toLowerCase());
    for (const x of Array.isArray(e.details) ? e.details : []) if (typeof (x as { reason?: unknown })?.reason === 'string') reasons.add((x as { reason: string }).reason.toLowerCase());
  }
  return { reasons, status, scopeMessage };
}

const anyOf = (set: Set<string>, list: readonly string[]) => list.some((r) => set.has(r));

/** The status and body of a Google answer as the typed error callers handle. */
export function mapGoogleError(status: number, body: unknown, retryAfterMs?: number): CapabilityError {
  const { reasons, scopeMessage } = readGoogleError(body);
  if (status === 404 || status === 410) return new CapabilityError('NOT_FOUND', { status });
  if (status === 413) return new CapabilityError('TOO_LARGE', { reason: 'REQUEST' });
  if (status === 429) return anyOf(reasons, GOOGLE_REASONS.quota) && !anyOf(reasons, GOOGLE_REASONS.rate) ? new CapabilityError('QUOTA_EXCEEDED') : new CapabilityError('RATE_LIMITED', { retryAfterMs });
  if (status === 403) {
    if (anyOf(reasons, GOOGLE_REASONS.scope) || scopeMessage) return new CapabilityError('PERMISSION_MISSING', { reason: 'SCOPE', status });
    if (anyOf(reasons, GOOGLE_REASONS.rate)) return new CapabilityError('RATE_LIMITED', { retryAfterMs });
    if (anyOf(reasons, GOOGLE_REASONS.quota)) return new CapabilityError('QUOTA_EXCEEDED');
    if (anyOf(reasons, GOOGLE_REASONS.disabled)) return new CapabilityError('PROVIDER_ERROR', { status, reason: 'API_DISABLED' });
    if (anyOf(reasons, GOOGLE_REASONS.notPicked)) return new CapabilityError('PERMISSION_MISSING', { reason: 'NOT_PICKED', status });
    return new CapabilityError('PERMISSION_MISSING', { reason: 'FORBIDDEN', status });
  }
  return new CapabilityError('PROVIDER_ERROR', { status });
}

/** Seconds, or an HTTP date, to milliseconds. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d{1,6}$/.test(value)) return Number(value) * 1000;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

const tracer = () => trace.getTracer('hexactra-console.connections.google');
const outcomeOf = (status: number): GoogleOutcome => (status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'ok');

/** Built by `GoogleConnectionsModule` with a factory (the options object is not injectable). */
export class GoogleHttp {
  private readonly limiters = new Map<string, Semaphore>();
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly maxTries: number;
  private readonly concurrency: number;

  constructor(
    private readonly http: OutboundHttp,
    private readonly metrics?: AppMetricsService,
    opts: GoogleHttpOptions = {},
  ) {
    this.sleep = opts.sleep ?? abortableSleep;
    this.random = opts.random ?? Math.random;
    this.maxTries = opts.maxTries ?? GOOGLE_MAX_TRIES;
    this.concurrency = opts.concurrency ?? GOOGLE_CONCURRENCY;
  }

  /** One call with the connection's token. Throws a {@link CapabilityError}. */
  async call<T = unknown>(tokens: TokenSource, ctx: ConnectionContext, call: GoogleCall): Promise<GoogleResponse<T>> {
    return tracer().startActiveSpan(`google ${call.service}.${call.op}`, async (span) => {
      const started = Date.now();
      span.setAttribute('connection.id', ctx.connectionId);
      span.setAttribute('google.service', call.service);
      span.setAttribute('google.operation', call.op);
      if (call.json !== undefined) span.setAttribute('http.request.body.size', Buffer.byteLength(JSON.stringify(call.json)));
      else if (call.raw) span.setAttribute('http.request.body.size', Buffer.byteLength(call.raw.body));
      try {
        const res = await this.attempts<T>(tokens, ctx, call, span);
        span.setAttribute('http.response.status_code', res.status);
        span.setAttribute('http.response.body.size', res.bytes);
        return res;
      } catch (e) {
        const err = toCapabilityError(e, ctx);
        span.setAttribute('error.code', err.code);
        if (err.details.status !== undefined) span.setAttribute('http.response.status_code', err.details.status);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        this.metrics?.record('googleRequestDuration', Date.now() - started, { service: call.service });
        span.end();
      }
    });
  }

  private limiter(connectionId: string): Semaphore {
    let s = this.limiters.get(connectionId);
    if (!s) this.limiters.set(connectionId, (s = new Semaphore(this.concurrency)));
    if (this.limiters.size > 500) for (const [k, v] of this.limiters) if (v.idle && k !== connectionId) this.limiters.delete(k);
    return s;
  }

  private count(service: GoogleService, outcome: GoogleOutcome): void {
    this.metrics?.add('googleRequests', 1, { service, outcome });
  }

  private backoff(attempt: number): number {
    return Math.round(Math.min(8_000, 500 * 2 ** (attempt - 1)) * (0.5 + this.random() * 0.5));
  }

  private url(call: GoogleCall): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(call.query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) q.append(k, String(x));
      else q.set(k, String(v));
    }
    const qs = q.toString();
    return qs ? `${call.url}?${qs}` : call.url;
  }

  private async attempts<T>(tokens: TokenSource, ctx: ConnectionContext, call: GoogleCall, span: { setAttribute(k: string, v: number): void }): Promise<GoogleResponse<T>> {
    const unknownOutcome = call.method !== 'GET' && !call.idempotent;
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      span.setAttribute('attempts', attempt);
      if (ctx.signal?.aborted) throw new CapabilityError('ABORTED');
      let accessToken = await tokens.getAccessToken(ctx.connectionId, ctx.userId, refreshed ? { forceRefresh: true } : undefined);
      let res;
      try {
        res = await this.limiter(ctx.connectionId).run(async () => {
          if (ctx.signal?.aborted) throw new CapabilityError('ABORTED');
          const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
          let body: string | undefined;
          if (call.json !== undefined) {
            body = JSON.stringify(call.json);
            headers['content-type'] = 'application/json; charset=utf-8';
          } else if (call.raw) {
            body = call.raw.body;
            headers['content-type'] = call.raw.contentType;
          }
          return this.http.send({ method: call.method, url: this.url(call), headers, body, maxBytes: call.maxBytes ?? 4 * 1024 * 1024, timeoutMs: call.timeoutMs ?? 30_000, signal: ctx.signal });
        }, ctx.signal);
      } catch (e) {
        accessToken = '';
        if (e instanceof CapabilityError) {
          if (e.code === 'ABORTED') this.count(call.service, 'aborted');
          throw e;
        }
        if (!(e instanceof OutboundHttpError)) throw e;
        if (e.code === 'aborted') {
          this.count(call.service, 'aborted');
          throw new CapabilityError('ABORTED');
        }
        if (e.code === 'too_large') throw new CapabilityError('TOO_LARGE', { reason: 'RESPONSE' });
        this.count(call.service, 'network');
        // A refused address (a private target) is not a transient failure: it is never retried.
        const transient = e.code === 'timeout' || e.code === 'network' || e.code === 'unresolvable';
        if (transient && call.idempotent && attempt < this.maxTries) {
          await this.sleep(this.backoff(attempt), ctx.signal);
          continue;
        }
        throw new CapabilityError('PROVIDER_ERROR', { status: 0, ...(unknownOutcome && transient ? { outcomeUnknown: true } : {}) });
      }
      accessToken = '';
      this.count(call.service, outcomeOf(res.status));
      const bytes = Buffer.byteLength(res.body);
      const data = parseJson<T>(res.body);
      if (res.status >= 200 && res.status < 300) return { status: res.status, data, headers: res.headers, bytes };
      if (call.accept?.includes(res.status)) return { status: res.status, data, headers: res.headers, bytes };

      if (res.status === 401) {
        if (!refreshed) {
          refreshed = true; // one forced refresh, then one more try; a second 401 means the grant is no good
          continue;
        }
        throw new CapabilityError('CONNECTION_NEEDS_RECONNECT', { reason: 'UNAUTHORIZED' });
      }

      const retryAfterMs = parseRetryAfter(res.headers['retry-after']);
      const error = mapGoogleError(res.status, data, retryAfterMs);
      if (error.code === 'RATE_LIMITED') {
        const wait = retryAfterMs ?? this.backoff(attempt);
        if (attempt < this.maxTries && wait <= GOOGLE_MAX_WAIT_MS) {
          await this.sleep(wait, ctx.signal);
          continue;
        }
        throw new CapabilityError('RATE_LIMITED', { retryAfterMs: wait });
      }
      if (res.status >= 500) {
        if (call.idempotent && attempt < this.maxTries) {
          await this.sleep(retryAfterMs !== undefined && retryAfterMs <= GOOGLE_MAX_WAIT_MS ? retryAfterMs : this.backoff(attempt), ctx.signal);
          continue;
        }
        throw new CapabilityError('PROVIDER_ERROR', { status: res.status, ...(unknownOutcome ? { outcomeUnknown: true } : {}) });
      }
      throw error;
    }
  }
}

function parseJson<T>(body: string): T | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}
