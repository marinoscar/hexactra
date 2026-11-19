// The console's outbound HTTP for OAuth clients and the providers they unlock (E37.2, #591).
//
// An address an owner typed (their Vault) is the classic SSRF primitive, so every request passes the
// platform's egress guard (`@marinoscar/platform-api/core`, the one webhooks use), checked AGAIN at send
// time (DNS may have changed): `https` only, no userinfo, no private, loopback, link-local or
// carrier-grade-NAT address (cloud metadata included), and the connection goes to the address that was
// checked (pinned, so a second DNS answer cannot redirect it) while the host name still drives the Host
// header and TLS verification. A redirect is NEVER followed. Bodies are bounded and never logged.
//
// Development: `http` and loopback targets are allowed unless `NODE_ENV=production` (a Vault on the
// developer's machine). An administrator can also exempt exact host names from the private-address
// check (`secrets.vault.allowedHosts`), which still requires `https`.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { WebhookEgressError, resolveWebhookTarget, systemHostResolver, type HostResolver, type ResolvedWebhookTarget, type WebhookEgressPolicy } from '@marinoscar/platform-api/core';

/** Why an outbound call did not happen or did not finish. Closed set: never a URL path, query or body. */
export type OutboundErrorCode = 'invalid_url' | 'scheme_not_allowed' | 'userinfo_not_allowed' | 'port_not_allowed' | 'private_target' | 'unresolvable' | 'timeout' | 'too_large' | 'network' | 'aborted';

export class OutboundHttpError extends Error {
  constructor(
    readonly code: OutboundErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OutboundHttpError';
  }
}

export interface OutboundRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** The deadline for the whole exchange (default 10 s). */
  timeoutMs?: number;
  /** The most response bytes read (default 64 KiB); more is `too_large`. */
  maxBytes?: number;
  /** Exact host names exempt from the private-address check (https is still required). */
  allowedHosts?: readonly string[];
  /** Cancels the exchange (E39.3: Stop): the request is destroyed and `send` rejects with `aborted`. */
  signal?: AbortSignal;
}

export interface OutboundResponse {
  status: number;
  /** Lower-cased names, first value of each. */
  headers: Record<string, string>;
  body: string;
}

/** The port: the real one is {@link PinnedOutboundHttp}; a test may replace it. An abstract class so Nest can inject it. */
export abstract class OutboundHttp {
  abstract send(req: OutboundRequest): Promise<OutboundResponse>;
  /** Refuses (throws {@link OutboundHttpError}) a URL `send` would refuse, without sending: for validating an address when it is saved. */
  abstract check(url: string, allowedHosts?: readonly string[]): Promise<void>;
}

/** Injection token of the DNS resolver, so a test can script a rebinding answer. */
export const OUTBOUND_RESOLVER = Symbol('OUTBOUND_RESOLVER');

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = h.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  if (isIP(lower) === 4) return lower.split('.')[0] === '127';
  return lower === '::1';
}

/** Whether development conveniences (http and loopback targets) are on. */
export function devTargetsAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * The checked target of `raw`, or an {@link OutboundHttpError}. Used when a URL is saved (a clear refusal)
 * and again by every request.
 */
export async function checkOutboundUrl(raw: string, resolver: HostResolver, allowedHosts: readonly string[] = [], allowDev = devTargetsAllowed()): Promise<ResolvedWebhookTarget> {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    throw new OutboundHttpError('invalid_url', 'The address is not a valid URL.');
  }
  const loopback = allowDev && isLoopbackHost(host);
  const policy: WebhookEgressPolicy = loopback ? { allowInsecureHttp: true, allowPrivateTargets: true, allowedHosts: [] } : { allowInsecureHttp: false, allowPrivateTargets: false, allowedHosts };
  try {
    return await resolveWebhookTarget(raw, policy, resolver);
  } catch (e) {
    if (e instanceof WebhookEgressError) throw new OutboundHttpError(e.code, e.message);
    throw new OutboundHttpError('network', 'The address could not be checked.');
  }
}

const isLiteral = (host: string) => /^[\d.]+$/.test(host) || host.includes(':');

@Injectable()
export class PinnedOutboundHttp extends OutboundHttp {
  private readonly resolver: HostResolver;

  constructor(@Optional() @Inject(OUTBOUND_RESOLVER) resolver?: HostResolver) {
    super();
    this.resolver = resolver ?? systemHostResolver;
  }

  async check(url: string, allowedHosts: readonly string[] = []): Promise<void> {
    await checkOutboundUrl(url, this.resolver, allowedHosts);
  }

  async send(req: OutboundRequest): Promise<OutboundResponse> {
    if (req.signal?.aborted) throw new OutboundHttpError('aborted', 'The request was cancelled.');
    const target = await checkOutboundUrl(req.url, this.resolver, req.allowedHosts ?? []);
    return this.exchange(target, req);
  }

  private exchange(target: ResolvedWebhookTarget, req: OutboundRequest): Promise<OutboundResponse> {
    const secure = target.url.protocol === 'https:';
    const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pinned: NonNullable<RequestOptions['lookup']> = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: target.address, family: target.family }]);
      else callback(null, target.address, target.family);
    };
    const headers: Record<string, string> = { accept: 'application/json', 'cache-control': 'no-store', ...req.headers };
    if (req.body !== undefined) headers['content-length'] = String(Buffer.byteLength(req.body));
    return new Promise<OutboundResponse>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        action();
      };
      const options: RequestOptions = {
        method: req.method,
        host: target.hostname,
        port: target.url.port === '' ? (secure ? 443 : 80) : Number(target.url.port),
        path: `${target.url.pathname}${target.url.search}`,
        headers,
        lookup: pinned,
        ...(secure && !isLiteral(target.hostname) ? { servername: target.hostname } : {}),
        agent: false,
      };
      const clientRequest = (secure ? httpsRequest : httpRequest)(options, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const out: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === 'string') out[name.toLowerCase()] = value;
          else if (Array.isArray(value) && value[0] !== undefined) out[name.toLowerCase()] = value[0];
        }
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(() => reject(new OutboundHttpError('too_large', 'The response is larger than the limit.')));
            response.destroy();
            clientRequest.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => finish(() => resolve({ status: response.statusCode ?? 0, headers: out, body: Buffer.concat(chunks).toString('utf8') })));
        response.on('error', () => finish(() => reject(new OutboundHttpError('network', 'Network error while reading the response.'))));
        response.on('close', () => finish(() => reject(new OutboundHttpError('network', 'The connection closed early.'))));
      });
      const timer = setTimeout(() => {
        finish(() => reject(new OutboundHttpError('timeout', 'The server did not answer in time.')));
        clientRequest.destroy();
      }, timeoutMs);
      timer.unref?.();
      const onAbort = () => {
        finish(() => reject(new OutboundHttpError('aborted', 'The request was cancelled.')));
        clientRequest.destroy();
      };
      if (req.signal) {
        if (req.signal.aborted) onAbort();
        else req.signal.addEventListener('abort', onAbort, { once: true });
      }
      clientRequest.on('error', (error: NodeJS.ErrnoException) => {
        // The message may name the host and port; never the path or query.
        finish(() => reject(new OutboundHttpError('network', `Network error${error.code ? ` (${error.code})` : ''}.`)));
      });
      if (req.body !== undefined) clientRequest.write(req.body);
      clientRequest.end();
    });
  }
}
