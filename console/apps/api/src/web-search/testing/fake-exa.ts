// An in-process fake of Exa's search endpoint (E50.8, #978), from the documented shapes with INVENTED data. It answers
// `POST https://api.exa.ai/search` with `x-api-key: <known key>` (an unknown key is 401), checks the body (`query`, `numResults` 1 to
// 100, `type`, `includeDomains`, `startPublishedDate` ISO 8601, `contents`), and refuses a request that asks for the pages' full text.
import type { OutboundResponse } from '../../oauth-client/outbound-http';
import { EXA_ENDPOINT } from '../providers/exa.provider';
import { FakeJsonEndpoint, PROVIDER_TEXT } from './fake-json-endpoint';

export interface ExaResult {
  title: string | null;
  url: string;
  publishedDate?: string | null;
  highlights?: string[];
}

export function exaResponse(results: ExaResult[]): unknown {
  return {
    requestId: 'invented-request',
    resolvedSearchType: 'neural',
    results: results.map((r, i) => ({ id: r.url, author: null, score: 0.5 - i / 100, highlightScores: (r.highlights ?? []).map(() => 0.4), ...r })),
    costDollars: { total: 0.006 },
  };
}

export const FAKE_EXA_RESULTS: ExaResult[] = [
  { title: 'Example widgets & parts', url: 'https://docs.example.test/widgets', publishedDate: '2026-10-01T00:00:00.000Z', highlights: ['An invented page about widgets.'] },
  { title: 'Not a web address', url: 'ftp://files.example.test/widgets', highlights: ['Dropped: not http or https.'] },
  { title: null, url: 'http://shop.example.test/catalogue', publishedDate: null },
];

export class FakeExa extends FakeJsonEndpoint {
  results = [...FAKE_EXA_RESULTS];

  protected keyOf(headers: Record<string, string>): string | undefined {
    return headers['x-api-key'];
  }

  protected answer({ method, url, body, key }: { method: string; url: URL; body: unknown; key: string | undefined }): OutboundResponse {
    if (`${url.origin}${url.pathname}` !== EXA_ENDPOINT || method !== 'POST') return this.json(404, { error: 'Not found' });
    if (!key || !this.keys.has(key)) return this.json(401, { requestId: 'x', error: `Invalid API key. ${PROVIDER_TEXT}` });
    const b = (body ?? {}) as Record<string, unknown>;
    const n = b.numResults === undefined ? 10 : Number(b.numResults);
    const contents = (b.contents ?? {}) as Record<string, unknown>;
    const bad =
      typeof b.query !== 'string' ||
      !b.query ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > 100 ||
      (b.type !== undefined && !['auto', 'neural', 'keyword', 'fast'].includes(String(b.type))) ||
      (b.includeDomains !== undefined && !Array.isArray(b.includeDomains)) ||
      (b.startPublishedDate !== undefined && Number.isNaN(Date.parse(String(b.startPublishedDate)))) ||
      contents.text === true ||
      (typeof contents.text === 'object' && contents.text !== null);
    if (bad) return this.json(400, { requestId: 'x', error: `Invalid request. ${PROVIDER_TEXT}` });
    const domains = (b.includeDomains as string[] | undefined) ?? [];
    const results = this.results.filter((r) => domains.length === 0 || domains.some((d) => r.url.includes(d)));
    return this.json(200, exaResponse(results.slice(0, n)));
  }
}
