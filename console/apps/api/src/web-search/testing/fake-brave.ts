// An in-process fake of Brave Search's web endpoint (E50.5, #975), built from the documented response shape with INVENTED data
// (`*.example.test`). It implements `OutboundHttp`, so `BraveSearchProvider` runs unchanged against it with no network.
//
// What it checks, so a passing test means something:
//   * the request is `GET https://api.search.brave.com/res/v1/web/search` and carries `X-Subscription-Token` with a known key
//     (an unknown key is 401, as Brave answers); the key is never in the URL (a key in the query fails the request with 400);
//   * `count` is 1 to 20; `freshness` is one of pd, pw, pm, py;
//   * it records every request (path, query, whether the header was present: never the key's value), and can answer the next
//     requests with a scripted status, headers and body (429 rate, 429 quota, 5xx, a slow answer).
import { OutboundHttp, OutboundHttpError, type OutboundRequest, type OutboundResponse } from '../../oauth-client/outbound-http';
import { BRAVE_ENDPOINT } from '../providers/brave.provider';

export interface FakeBraveRequest {
  method: string;
  url: string;
  query: Record<string, string>;
  /** `X-Subscription-Token` was sent. Never its value. */
  tokenPresent: boolean;
  timeoutMs: number | undefined;
  maxBytes: number | undefined;
}

export interface FakeBraveStub {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Throw this transport error instead of answering. */
  error?: OutboundHttpError['code'];
}

/** A documented-shape result list with invented pages. */
export function braveBody(results: { title: string; url: string; description?: string; page_age?: string }[]): unknown {
  return { type: 'search', query: { original: 'invented' }, web: { type: 'search', results: results.map((r) => ({ type: 'search_result', ...r, language: 'en', family_friendly: true })) } };
}

export const FAKE_BRAVE_RESULTS = [
  { title: 'Example <strong>widgets</strong> &amp; parts', url: 'https://docs.example.test/widgets', description: 'An <strong>invented</strong> page about widgets.', page_age: '2026-10-01T00:00:00' },
  { title: 'Not a web address', url: 'ftp://files.example.test/widgets', description: 'Dropped: not http or https.' },
  { title: 'Widget catalogue', url: 'http://shop.example.test/catalogue', description: '' },
];

export class FakeBrave extends OutboundHttp {
  readonly requests: FakeBraveRequest[] = [];
  private readonly keys = new Set<string>();
  private readonly next: FakeBraveStub[] = [];
  results = [...FAKE_BRAVE_RESULTS];

  constructor(keys: readonly string[] = []) {
    super();
    for (const k of keys) this.keys.add(k);
  }

  addKey(key: string): this {
    this.keys.add(key);
    return this;
  }

  /** Answer the next request with this. */
  stub(s: FakeBraveStub): this {
    this.next.push(s);
    return this;
  }

  async check(): Promise<void> {}

  async send(req: OutboundRequest): Promise<OutboundResponse> {
    if (req.signal?.aborted) throw new OutboundHttpError('aborted', 'The request was cancelled.');
    const u = new URL(req.url);
    const token = Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === 'x-subscription-token')?.[1];
    const query = Object.fromEntries(u.searchParams.entries());
    this.requests.push({ method: req.method, url: `${u.origin}${u.pathname}`, query, tokenPresent: token !== undefined, timeoutMs: req.timeoutMs, maxBytes: req.maxBytes });
    const stub = this.next.shift();
    if (stub?.error) throw new OutboundHttpError(stub.error, 'scripted');
    if (stub) return { status: stub.status, headers: stub.headers ?? {}, body: typeof stub.body === 'string' ? stub.body : JSON.stringify(stub.body ?? {}) };
    if (`${u.origin}${u.pathname}` !== BRAVE_ENDPOINT || req.method !== 'GET') return this.json(404, { type: 'ErrorResponse', error: { code: 'NOT_FOUND' } });
    if ([...u.searchParams.values()].some((v) => this.keys.has(v))) return this.json(400, { type: 'ErrorResponse', error: { code: 'KEY_IN_URL' } });
    if (!token || !this.keys.has(token)) return this.json(401, { type: 'ErrorResponse', error: { code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'invented provider text that must never be copied' } });
    const count = Number(query.count ?? '20');
    if (!query.q || !Number.isInteger(count) || count < 1 || count > 20) return this.json(422, { type: 'ErrorResponse', error: { code: 'VALIDATION' } });
    if (query.freshness !== undefined && !['pd', 'pw', 'pm', 'py'].includes(query.freshness)) return this.json(422, { type: 'ErrorResponse', error: { code: 'VALIDATION' } });
    return this.json(200, braveBody(this.results.slice(0, count)), { 'x-ratelimit-limit': '1, 2000', 'x-ratelimit-remaining': '0, 1999', 'x-ratelimit-reset': '1, 1000000' });
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): OutboundResponse {
    return { status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
  }
}
