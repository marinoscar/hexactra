import { Injectable, Logger } from '@nestjs/common';
import { context, propagation } from '@opentelemetry/api';
import { CredentialsService } from '@marinoscar/platform-api/credentials';

import { FABRIC_CREDENTIAL_PURPOSE, FABRIC_TOKEN_NAME, FABRIC_URL_NAME } from './fabric.credentials';

/** Why a fabric call failed. */
export type FabricErrorKind = 'not_configured' | 'unreachable' | 'unauthorized' | 'api';

/** A failed fabric call. `message` never carries the token. */
export class FabricError extends Error {
  constructor(
    readonly kind: FabricErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'FabricError';
  }
}

export interface FabricConfig {
  url: string;
  token: string;
}

export interface FabricRequest {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  /** Retry network errors and 5xx (GET only by default). */
  retries?: number;
}

/** A host as `GET /v1/hosts` reports it (the fields the console uses). */
/** How a host runs its browsers (docs/nodes.md). */
export type HostMode = 'unattended' | 'attended' | 'container';

export interface FabricHost {
  id: string;
  name: string;
  version: string;
  online: boolean;
  browser_connected: boolean;
  on_demand: boolean;
  viewer_url?: string;
  /** Absent for agents older than #336. */
  mode?: HostMode | null;
  desktop?: boolean;
  profiles: string[];
  running_profiles: string[];
  draining?: boolean;
  last_seen: string;
}

const CONFIG_TTL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The console's client for the Hexactra Fabric `/v1` API (api/openapi.yaml).
 * Server-side only: the service token never leaves the API process. Every
 * request carries the current W3C trace context, so one trace runs from the
 * console request to the browser action.
 */
@Injectable()
export class FabricClient {
  private readonly log = new Logger(FabricClient.name);
  private cached: { at: number; config: FabricConfig | null } | null = null;

  constructor(private readonly credentials: CredentialsService) {}

  /** Drop the cached URL and token (after the admin changes them). */
  invalidate(): void {
    this.cached = null;
  }

  /** The stored URL and token, or `null` when either is missing. */
  async config(): Promise<FabricConfig | null> {
    if (this.cached && Date.now() - this.cached.at < CONFIG_TTL_MS) return this.cached.config;
    const [url, token] = await Promise.all([
      this.credentials.getSecret(FABRIC_CREDENTIAL_PURPOSE.purpose, FABRIC_URL_NAME),
      this.credentials.getSecret(FABRIC_CREDENTIAL_PURPOSE.purpose, FABRIC_TOKEN_NAME),
    ]);
    const config = url && token ? { url: url.replace(/\/+$/, ''), token } : null;
    this.cached = { at: Date.now(), config };
    return config;
  }

  async request<T>(method: string, path: string, opts: FabricRequest = {}): Promise<T> {
    const res = await this.raw(method, path, opts);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** The response itself (for streams and bytes). Throws on non-2xx. */
  async raw(method: string, path: string, opts: FabricRequest = {}): Promise<Response> {
    const config = await this.config();
    if (!config) throw new FabricError('not_configured', 'The fabric connection is not configured');
    const url = new URL(config.url + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { authorization: `Bearer ${config.token}`, accept: 'application/json' };
    propagation.inject(context.active(), headers);
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const retries = opts.retries ?? (method === 'GET' ? 2 : 0);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (e) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          continue;
        }
        const reason = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
        throw new FabricError('unreachable', `Cannot reach the fabric at ${url.origin}: ${reason}`);
      }
      if (res.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      if (res.ok) return res;
      let code: string | undefined;
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        code = body.error;
        if (body.message) message = body.message;
      } catch {
        // not JSON
      }
      if (res.status === 401 || res.status === 403) {
        throw new FabricError('unauthorized', `The fabric refused the service token (${res.status})`, res.status, code);
      }
      throw new FabricError('api', message, res.status, code);
    }
  }

  health(timeoutMs = 5_000): Promise<{ status: string; version: string }> {
    return this.request('GET', '/v1/health', { timeoutMs, retries: 0 });
  }

  async hosts(): Promise<FabricHost[]> {
    return (await this.request<{ hosts: FabricHost[] }>('GET', '/v1/hosts')).hosts;
  }

  /** Open the event stream and confirm it answers as SSE, then close it. */
  async probeEvents(timeoutMs = 5_000): Promise<void> {
    const res = await this.raw('GET', '/v1/events', { timeoutMs, retries: 0 });
    const type = res.headers.get('content-type') ?? '';
    await res.body?.cancel().catch(() => undefined);
    if (!type.startsWith('text/event-stream')) {
      throw new FabricError('api', `The event stream answered with ${type || 'no content type'}`);
    }
    this.log.debug('fabric event stream reachable');
  }
}
