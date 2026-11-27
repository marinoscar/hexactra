// An in-process fake of Tavily's search endpoint (E50.8, #978), from the documented shapes with INVENTED data. It answers
// `POST https://api.tavily.com/search` with `Authorization: Bearer <known key>` (an unknown key is 401, as Tavily answers), checks the
// body (`query`, `max_results` 0 to 20, `search_depth` basic or advanced, `time_range`, `include_domains`), and refuses a request
// that asks for an answer or the pages' text (this adapter never should).
import type { OutboundResponse } from '../../oauth-client/outbound-http';
import { TAVILY_ENDPOINT } from '../providers/tavily.provider';
import { FakeJsonEndpoint, PROVIDER_TEXT } from './fake-json-endpoint';

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  published_date?: string;
}

export function tavilyResponse(query: string, results: TavilyResult[]): unknown {
  return { query, answer: null, images: [], results: results.map((r) => ({ score: 0.9, raw_content: null, ...r })), response_time: 0.42, request_id: '00000000-0000-4000-8000-000000000000' };
}

export const FAKE_TAVILY_RESULTS: TavilyResult[] = [
  { title: 'Example widgets & parts', url: 'https://docs.example.test/widgets', content: 'An invented page about widgets.', published_date: '2026-10-01T00:00:00Z' },
  { title: 'Not a web address', url: 'ftp://files.example.test/widgets', content: 'Dropped: not http or https.' },
  { title: 'Widget catalogue', url: 'http://shop.example.test/catalogue', content: '' },
];

export class FakeTavily extends FakeJsonEndpoint {
  results = [...FAKE_TAVILY_RESULTS];

  protected keyOf(headers: Record<string, string>): string | undefined {
    const m = /^Bearer (.+)$/.exec(headers.authorization ?? '');
    return m?.[1];
  }

  protected answer({ method, url, body, key }: { method: string; url: URL; body: unknown; key: string | undefined }): OutboundResponse {
    if (`${url.origin}${url.pathname}` !== TAVILY_ENDPOINT || method !== 'POST') return this.json(404, { detail: { error: 'Not found' } });
    if (!key || !this.keys.has(key)) return this.json(401, { detail: { error: `Unauthorized: missing or invalid API key. ${PROVIDER_TEXT}` } });
    const b = (body ?? {}) as Record<string, unknown>;
    const max = b.max_results === undefined ? 5 : Number(b.max_results);
    const bad =
      typeof b.query !== 'string' ||
      !b.query ||
      !Number.isInteger(max) ||
      max < 0 ||
      max > 20 ||
      (b.search_depth !== undefined && !['basic', 'advanced'].includes(String(b.search_depth))) ||
      (b.time_range !== undefined && !['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'].includes(String(b.time_range))) ||
      (b.include_domains !== undefined && !Array.isArray(b.include_domains)) ||
      b.include_answer === true ||
      b.include_raw_content === true;
    if (bad) return this.json(400, { detail: { error: `Invalid request. ${PROVIDER_TEXT}` } });
    const domains = (b.include_domains as string[] | undefined) ?? [];
    const results = this.results.filter((r) => domains.length === 0 || domains.some((d) => r.url.includes(d)));
    return this.json(200, tavilyResponse(b.query as string, results.slice(0, max)));
  }
}
