// A small typed client for Microsoft Graph over plain `fetch` (E39.4, #602): no SDK, so the API image gains no dependency and the
// attack surface is the handful of endpoints the capability interfaces need. One instance serves every connection; what is per
// connection (the token, the concurrency slot) is looked up per call.
//
// What it guarantees, so that no operation can forget it:
//   * the access token comes from the token service (`TokenSource`) and is attached here only; a 401 forces one refresh and one retry;
//   * at most {@link GRAPH_CONCURRENCY} requests per connection at a time (Graph allows 4 per mailbox);
//   * 429 is retried after `Retry-After` (never more than {@link MAX_TRIES} tries; a wait beyond {@link MAX_WAIT_MS} is returned to the caller
//     as RATE_LIMITED with `retryAfterMs`); 502/503/504, a timeout and a dropped connection are retried only for a request that is safe
//     to repeat, so a failed POST is never sent blindly twice (the error says `reason: 'AMBIGUOUS'` instead);
//   * a per-attempt timeout and the caller's AbortSignal (Stop, #582);
//   * errors are mapped to `CapabilityError` with a closed code and the HTTP status; Graph's message text is NEVER copied or logged
//     because it can carry a subject, an address or a file name (its `error.code` is a stable identifier and is kept);
//   * telemetry carries the operation name, the connection id, the status, sizes, counts and durations, never content.
import { Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';

import { CapabilityError, type CapabilityContext, type ConnectionContext } from '../capabilities';
import type { Capability } from '../connections.constants';
import { GRAPH_BASE } from './microsoft.constants';

export const GRAPH_CONCURRENCY = 3;
export const MAX_TRIES = 3;
export const MAX_WAIT_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 30_000;

/** The token of a connection. `forceRefresh` is asked once after a 401. */
export type TokenSource = (ctx: ConnectionContext, opts?: { forceRefresh?: boolean }) => Promise<string>;

export interface GraphCallRecord {
  op: string;
  connectionId: string;
  status: number;
  attempt: number;
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
}

export interface GraphTelemetry {
  record(call: GraphCallRecord): void;
}

const TRACER_NAME = 'hexactra-console.connections.microsoft';
const logger = new Logger('MicrosoftGraph');

/** Spans and one line per failed call; operation, connection id, status and sizes only. */
export const defaultTelemetry: GraphTelemetry = {
  record(c) {
    const span = trace.getTracer(TRACER_NAME).startSpan(`graph ${c.op}`, { attributes: { 'connection.id': c.connectionId, 'graph.operation': c.op, 'http.response.status_code': c.status, 'graph.attempt': c.attempt, 'graph.request_bytes': c.requestBytes, 'graph.response_bytes': c.responseBytes, 'graph.duration_ms': c.durationMs } });
    if (c.status >= 400 || c.status === 0) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    if (c.status >= 400 || c.status === 0) logger.warn(`graph ${c.op} answered ${c.status} (attempt ${c.attempt}, ${c.durationMs} ms)`);
  },
};

export type GraphMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface GraphRequest {
  /** The operation name for telemetry and nothing else (`mail.search`). */
  op: string;
  method: GraphMethod;
  /** Relative to the Graph base and already encoded: `/me/messages`. */
  path: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  json?: unknown;
  body?: Buffer;
  contentType?: string;
  /** What to read from the answer. */
  accept?: 'json' | 'buffer' | 'none';
  /** Statuses that are an answer and not an error (a 404 where "not there" is expected). */
  okStatuses?: readonly number[];
  /** A request that may be repeated after a 5xx or a dropped connection (default: GET, PUT and DELETE). */
  repeatable?: boolean;
  /** The capability the call serves, so a 403 says which switch lacks its grant. */
  capability?: Capability;
  /** An absolute URL that is not Graph itself (an upload session). The bearer token is NOT sent there. */
  absoluteUrl?: string;
  /** Do not wait longer than this for a throttled call (default {@link MAX_WAIT_MS}). */
  maxWaitMs?: number;
}

export interface GraphResponse {
  status: number;
  headers: Headers;
  json: unknown;
  buffer: Buffer | null;
}

export interface GraphClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  tokens: TokenSource;
  telemetry?: GraphTelemetry;
  /** Replaced by tests so a backoff costs no time. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
  concurrency?: number;
}

class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    // A slot handed over by `release` is already counted: the waiter does not add one, so the limit can never be exceeded.
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new CapabilityError('ABORTED'));
      };
      this.waiting.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  get idle(): boolean {
    return this.active === 0 && this.waiting.length === 0;
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
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

/** `Retry-After` is seconds or an HTTP date. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d{1,6}$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Graph's `error.code` is a stable identifier (`ErrorItemNotFound`); it is kept only when it looks like one. */
function graphCode(json: unknown): string | undefined {
  const code = (json as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(code) ? code : undefined;
}

export class GraphClient {
  private readonly doFetch: typeof fetch;
  private readonly base: string;
  private readonly limiters = new Map<string, Semaphore>();
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly telemetry: GraphTelemetry;
  private readonly timeoutMs: number;
  private readonly concurrency: number;

  constructor(private readonly opts: GraphClientOptions) {
    this.doFetch = opts.fetch ?? fetch;
    this.base = (opts.baseUrl ?? GRAPH_BASE).replace(/\/+$/, '');
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.telemetry = opts.telemetry ?? defaultTelemetry;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.concurrency = opts.concurrency ?? GRAPH_CONCURRENCY;
  }

  /** The Graph base, for building a page token's check. */
  get baseUrl(): string {
    return this.base;
  }

  private limiter(connectionId: string): Semaphore {
    let s = this.limiters.get(connectionId);
    if (!s) this.limiters.set(connectionId, (s = new Semaphore(this.concurrency)));
    return s;
  }

  /** One call, with the concurrency slot, the retries and the error mapping. */
  async request(ctx: CapabilityContext, req: GraphRequest): Promise<GraphResponse> {
    const limiter = this.limiter(ctx.connectionId);
    await limiter.acquire(ctx.signal);
    try {
      return await this.attempts(ctx, req);
    } finally {
      limiter.release();
      if (limiter.idle) this.limiters.delete(ctx.connectionId);
    }
  }

  /** A JSON answer (`accept: 'json'` unless said otherwise). */
  async json<T = unknown>(ctx: CapabilityContext, req: Omit<GraphRequest, 'accept'>): Promise<T> {
    return (await this.request(ctx, { ...req, accept: 'json' })).json as T;
  }

  private url(req: GraphRequest): string {
    const u = new URL(req.absoluteUrl ?? `${this.base}${req.path}`);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  }

  private async attempts(ctx: CapabilityContext, req: GraphRequest): Promise<GraphResponse> {
    const repeatable = req.repeatable ?? (req.method === 'GET' || req.method === 'PUT' || req.method === 'DELETE');
    const maxWait = req.maxWaitMs ?? MAX_WAIT_MS;
    let refreshed = false;
    let forceRefresh = false;
    for (let attempt = 1; ; attempt++) {
      if (ctx.signal?.aborted) throw new CapabilityError('ABORTED');
      // The token first and outside the network `try`: a refused grant is the token service's own typed error, not a dropped connection.
      const token = req.absoluteUrl ? null : await this.opts.tokens(ctx, forceRefresh ? { forceRefresh: true } : undefined);
      const started = Date.now();
      let res: Response | null = null;
      let failure: 'network' | 'timeout' | null = null;
      try {
        res = await this.once(ctx, req, token);
      } catch (e) {
        if (e instanceof CapabilityError) throw e;
        if (ctx.signal?.aborted) throw new CapabilityError('ABORTED');
        failure = e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network';
      }
      forceRefresh = false;
      const status = res?.status ?? 0;
      const buffer = res && req.accept !== 'none' && status !== 204 ? Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0))) : null;
      this.telemetry.record({ op: req.op, connectionId: ctx.connectionId, status, attempt, durationMs: Date.now() - started, requestBytes: req.body?.length ?? (req.json === undefined ? 0 : JSON.stringify(req.json).length), responseBytes: buffer?.length ?? 0 });

      if (res && ((status >= 200 && status < 300) || req.okStatuses?.includes(status))) {
        return { status, headers: res.headers, json: req.accept === 'json' && buffer && buffer.length > 0 ? this.parse(buffer) : null, buffer: req.accept === 'buffer' ? buffer : null };
      }

      const json = buffer && buffer.length > 0 && (res?.headers.get('content-type') ?? '').includes('json') ? this.parse(buffer) : null;
      if (status === 401 && !refreshed && !req.absoluteUrl) {
        refreshed = true;
        forceRefresh = true;
        continue;
      }
      if (status === 429 || (status === 503 && res?.headers.get('retry-after'))) {
        const wait = retryAfterMs(res?.headers.get('retry-after') ?? null) ?? this.backoff(attempt);
        if (attempt >= MAX_TRIES || wait > maxWait) throw new CapabilityError('RATE_LIMITED', { retryAfterMs: wait, status: 429 });
        await this.sleep(wait, ctx.signal);
        continue;
      }
      const transient = failure !== null || status === 500 || status === 502 || status === 503 || status === 504;
      if (transient && repeatable && attempt < MAX_TRIES) {
        await this.sleep(this.backoff(attempt), ctx.signal);
        continue;
      }
      throw this.mapError(status, json, req, transient && !repeatable);
    }
  }

  private async once(ctx: CapabilityContext, req: GraphRequest, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', ...(req.headers ?? {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    let body: Buffer | string | undefined;
    if (req.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.json);
    } else if (req.body) {
      headers['content-type'] = req.contentType ?? 'application/octet-stream';
      body = req.body;
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
    return this.doFetch(this.url(req), { method: req.method, headers, body: body as BodyInit | undefined, signal, redirect: 'manual' });
  }

  private parse(buf: Buffer): unknown {
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      return null;
    }
  }

  /** Exponential backoff with full jitter: about 0.5 s, 1 s, 2 s. */
  private backoff(attempt: number): number {
    return Math.round(500 * 2 ** (attempt - 1) * (0.5 + this.random() / 2));
  }

  private mapError(status: number, json: unknown, req: GraphRequest, ambiguous: boolean): CapabilityError {
    const code = graphCode(json);
    if (status === 401) return new CapabilityError('CONNECTION_NEEDS_RECONNECT', { reason: 'UNAUTHORIZED' });
    if (status === 403) return new CapabilityError('PERMISSION_MISSING', { ...(req.capability ? { capability: req.capability } : {}), reason: code === 'ErrorAccessDenied' || !code ? 'FORBIDDEN' : code });
    if (status === 404 || code === 'ErrorItemNotFound' || code === 'itemNotFound' || code === 'ErrorInvalidIdMalformed') return new CapabilityError('NOT_FOUND');
    if (status === 409 || status === 412 || code === 'ErrorIrresolvableConflict') return new CapabilityError('CONFLICT', { status, ...(code ? { reason: code } : {}) });
    if (status === 413) return new CapabilityError('TOO_LARGE', { reason: 'PROVIDER_LIMIT' });
    if (status === 507 || code === 'ErrorQuotaExceeded' || code === 'quotaLimitReached') return new CapabilityError('QUOTA_EXCEEDED', { status });
    if (status === 0) return new CapabilityError('PROVIDER_ERROR', { status: 0, reason: ambiguous ? 'AMBIGUOUS' : 'UNREACHABLE' });
    return new CapabilityError('PROVIDER_ERROR', { status, ...(ambiguous ? { reason: 'AMBIGUOUS' } : code ? { reason: code } : {}) });
  }
}

// ---- paging ----

/** A page token is the next link as a path under the Graph base: opaque to callers, and only ever used under the prefix of its own operation. */
export function encodePageToken(nextLink: unknown, base: string): string | null {
  if (typeof nextLink !== 'string' || !nextLink.startsWith(`${base}/`)) return null;
  return Buffer.from(nextLink.slice(base.length), 'utf8').toString('base64url');
}

/**
 * The relative path a token stands for, or INVALID_INPUT when it was not issued for this operation (a caller cannot aim a token at
 * another endpoint). Graph sometimes writes `/me/` as `/users('<id>')/` in a next link; that is read back as `/me/`, so a token can
 * never address another user's mailbox.
 */
export function decodePageToken(token: string, allowedPrefix: string): string {
  let path = '';
  try {
    path = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    path = '';
  }
  path = path.replace(/^\/users(?:\('[^']{1,200}'\)|\/[^/?]{1,200})\//, '/me/');
  if (!path.startsWith(allowedPrefix) || path.startsWith('//') || /[\r\n\\]/.test(path)) throw new CapabilityError('INVALID_INPUT', { issues: ['pageToken'] });
  return path;
}
