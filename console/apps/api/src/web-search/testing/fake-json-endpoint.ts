// The base of the in-process fakes of a search provider's endpoint (E50.8, #978): Tavily, Exa and a SearXNG instance. Built from each
// provider's documented request and response shapes with INVENTED data (`*.example.test`); no key of a real account exists here.
//
// What every fake checks, so a passing test means something:
//   * every request first passes the REAL address check of the console's transport (`checkOutboundUrl`, development conveniences
//     off) against a scripted DNS (a host not scripted resolves to a public address), with the request's own exemptions
//     (`allowedHosts`, `allowInsecureHttp`): a private SearXNG is reached only when the provider asked for that exemption;
//   * a request that passes is recorded: method, address without query, the query, the parsed body, whether a known key was in the
//     provider's header (never the key's value), and the address it would connect to;
//   * the next requests can be answered with a scripted status, headers and body, or a transport error.
import type { HostResolver, ResolvedAddress } from '@marinoscar/platform-api/core';

import { checkOutboundUrl, OutboundHttp, OutboundHttpError, type OutboundRequest, type OutboundResponse } from '../../oauth-client/outbound-http';
import { FAKE_PUBLIC_ADDRESS } from './fake-web';

export interface FakeEndpointRequest {
  method: string;
  /** Origin and path, no query. */
  url: string;
  query: Record<string, string>;
  /** The parsed JSON body, or null. */
  body: unknown;
  /** A key the fake knows was in the provider's header. Never its value. */
  keyPresent: boolean;
  /** The address the connection would go to (the checked one). */
  address: string;
  timeoutMs: number | undefined;
  maxBytes: number | undefined;
}

export interface FakeEndpointStub {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Throw this transport error instead of answering. */
  error?: OutboundHttpError['code'];
}

/** Text a fake puts in its error bodies; a test asserts it never leaves the adapter. */
export const PROVIDER_TEXT = 'invented provider text that must never be copied';

export abstract class FakeJsonEndpoint extends OutboundHttp {
  readonly requests: FakeEndpointRequest[] = [];
  readonly lookups: string[] = [];
  protected readonly keys = new Set<string>();
  private readonly next: FakeEndpointStub[] = [];
  private readonly dns = new Map<string, ResolvedAddress[]>();

  readonly resolver: HostResolver = {
    resolveAll: async (hostname: string): Promise<ResolvedAddress[]> => {
      this.lookups.push(hostname);
      const a = this.dns.get(hostname.toLowerCase());
      if (a && a.length === 0) throw new Error('ENOTFOUND');
      return a ?? [{ address: FAKE_PUBLIC_ADDRESS, family: 4 }];
    },
  };

  constructor(keys: readonly string[] = []) {
    super();
    for (const k of keys) this.keys.add(k);
  }

  addKey(key: string): this {
    this.keys.add(key);
    return this;
  }

  /** Answer the next request with this. */
  stub(s: FakeEndpointStub): this {
    this.next.push(s);
    return this;
  }

  /** `host` resolves to these addresses (none: it does not resolve). */
  resolve(host: string, ...addresses: string[]): this {
    this.dns.set(host.toLowerCase(), addresses.map((address) => ({ address, family: address.includes(':') ? (6 as const) : (4 as const) })));
    return this;
  }

  async check(url: string, allowedHosts: readonly string[] = [], allowInsecureHttp = false): Promise<void> {
    await checkOutboundUrl(url, this.resolver, allowedHosts, false, allowInsecureHttp);
  }

  /** The key the provider sent in its documented place, or undefined. */
  protected abstract keyOf(headers: Record<string, string>): string | undefined;
  /** The answer to a request that reached the fake (no stub). */
  protected abstract answer(req: { method: string; url: URL; body: unknown; key: string | undefined }): OutboundResponse;

  async send(req: OutboundRequest): Promise<OutboundResponse> {
    if (req.signal?.aborted) throw new OutboundHttpError('aborted', 'The request was cancelled.');
    const target = await checkOutboundUrl(req.url, this.resolver, req.allowedHosts ?? [], false, req.allowInsecureHttp ?? false);
    const u = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k.toLowerCase()] = v;
    const key = this.keyOf(headers);
    let body: unknown = null;
    if (req.body !== undefined) {
      try {
        body = JSON.parse(req.body);
      } catch {
        body = '(not json)';
      }
    }
    this.requests.push({ method: req.method, url: `${u.origin}${u.pathname}`, query: Object.fromEntries(u.searchParams.entries()), body, keyPresent: key !== undefined && this.keys.has(key), address: target.address, timeoutMs: req.timeoutMs, maxBytes: req.maxBytes });
    const stub = this.next.shift();
    if (stub?.error) throw new OutboundHttpError(stub.error, 'scripted');
    if (stub) return { status: stub.status, headers: stub.headers ?? {}, body: typeof stub.body === 'string' ? stub.body : JSON.stringify(stub.body ?? {}) };
    if ([...u.searchParams.values()].some((v) => this.keys.has(v)) || (req.body !== undefined && [...this.keys].some((k) => req.body!.includes(k)))) return this.json(400, { error: 'KEY_IN_URL_OR_BODY' });
    return this.answer({ method: req.method, url: u, body, key });
  }

  protected json(status: number, body: unknown, headers: Record<string, string> = {}): OutboundResponse {
    return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
  }
}
