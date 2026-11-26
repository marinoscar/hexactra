// An in-process fake of the public web for web_fetch (E50.6, #976). It implements `OutboundHttp`, so `WebFetchService` runs unchanged
// against it with no network. Invented hosts (`*.example.test`) and addresses.
//
// What it checks, so a passing test means something:
//   * every request first passes the REAL address check of the console's transport (`checkOutboundUrl`, with the development
//     conveniences off) against a scripted DNS: a name may answer differently on each lookup (rebinding), and every lookup is kept;
//   * a request that passes is recorded with the address it would connect to (the checked, pinned one) and every header sent, so a test
//     can assert that no cookie, Authorization or referrer left and that nothing reached a refused target;
//   * it serves pages by exact URL: a status, headers and a body, a redirect, a slow answer (honouring `timeoutMs` and `signal`), an
//     answer larger than `maxBytes` (`too_large`, as the real transport). An unknown URL is 404.
import type { HostResolver, ResolvedAddress } from '@marinoscar/platform-api/core';

import { checkOutboundUrl, OutboundHttp, OutboundHttpError, type OutboundRequest, type OutboundResponse } from '../../oauth-client/outbound-http';

export interface FakePage {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Answer after this many ms (a slow server). */
  delayMs?: number;
}

export interface FakeWebRequest {
  url: string;
  /** The address the connection would go to: the one that was checked. */
  address: string;
  headers: Record<string, string>;
  timeoutMs: number | undefined;
  maxBytes: number | undefined;
}

/** A public address of the fake web (a real public range, so the address check passes; nothing is ever connected to). */
export const FAKE_PUBLIC_ADDRESS = '93.184.215.14';

export class FakeWeb extends OutboundHttp {
  /** Every request that passed the address check, oldest first. */
  readonly requests: FakeWebRequest[] = [];
  /** Every name looked up, in order (a rebinding test counts them). */
  readonly lookups: string[] = [];
  private readonly pages = new Map<string, FakePage>();
  /** Per host: the answers of the successive lookups; the last one repeats. A host not listed resolves to {@link FAKE_PUBLIC_ADDRESS}. */
  private readonly dns = new Map<string, ResolvedAddress[][]>();
  private readonly dnsCalls = new Map<string, number>();

  readonly resolver: HostResolver = {
    resolveAll: async (hostname: string): Promise<ResolvedAddress[]> => {
      this.lookups.push(hostname);
      const answers = this.dns.get(hostname.toLowerCase());
      if (!answers) return [{ address: FAKE_PUBLIC_ADDRESS, family: 4 }];
      const n = this.dnsCalls.get(hostname) ?? 0;
      this.dnsCalls.set(hostname, n + 1);
      const answer = answers[Math.min(n, answers.length - 1)]!;
      if (answer.length === 0) throw new Error('ENOTFOUND');
      return answer;
    },
  };

  /** Serves `url` (exact match, after URL normalisation). */
  page(url: string, page: FakePage): this {
    this.pages.set(new URL(url).href, page);
    return this;
  }

  html(url: string, html: string, headers: Record<string, string> = {}): this {
    return this.page(url, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body: html });
  }

  redirect(from: string, to: string, status = 302): this {
    return this.page(from, { status, headers: { location: to } });
  }

  /** The successive answers of `host`'s lookups (each a list of addresses; an empty list does not resolve). */
  resolve(host: string, ...answers: string[][]): this {
    this.dns.set(
      host.toLowerCase(),
      answers.map((a) => a.map((address) => ({ address, family: address.includes(':') ? (6 as const) : (4 as const) }))),
    );
    return this;
  }

  /** The requests that reached a URL whose host is `host`. */
  requestsTo(host: string): FakeWebRequest[] {
    return this.requests.filter((r) => new URL(r.url).hostname === host);
  }

  async check(url: string, allowedHosts: readonly string[] = []): Promise<void> {
    await checkOutboundUrl(url, this.resolver, allowedHosts, false);
  }

  async send(req: OutboundRequest): Promise<OutboundResponse> {
    if (req.signal?.aborted) throw new OutboundHttpError('aborted', 'The request was cancelled.');
    const target = await checkOutboundUrl(req.url, this.resolver, req.allowedHosts ?? [], false);
    this.requests.push({ url: target.url.href, address: target.address, headers: { ...(req.headers ?? {}) }, timeoutMs: req.timeoutMs, maxBytes: req.maxBytes });
    const page = this.pages.get(target.url.href) ?? { status: 404, headers: { 'content-type': 'text/plain' }, body: 'Not found' };
    if (page.delayMs) await this.wait(page.delayMs, req);
    const bytes = Buffer.isBuffer(page.body) ? page.body : Buffer.from(page.body ?? '', 'utf8');
    if (bytes.length > (req.maxBytes ?? 64 * 1024)) throw new OutboundHttpError('too_large', 'The response is larger than the limit.');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(page.headers ?? {})) headers[k.toLowerCase()] = v;
    return { status: page.status ?? 200, headers, body: bytes.toString('utf8'), bytes };
  }

  private wait(ms: number, req: OutboundRequest): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = req.timeoutMs ?? 10_000;
      const done = (f: () => void) => {
        clearTimeout(t);
        clearTimeout(limit);
        req.signal?.removeEventListener('abort', onAbort);
        f();
      };
      const t = setTimeout(() => done(resolve), ms);
      const limit = setTimeout(() => done(() => reject(new OutboundHttpError('timeout', 'The server did not answer in time.'))), timeout);
      const onAbort = () => done(() => reject(new OutboundHttpError('aborted', 'The request was cancelled.')));
      req.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
