// The web as two ports (E50.4, epic E50 #970, decision record docs/decisions/web-search.md §1). The host binds them: a search provider
// registry (E50.5) and a server-side page reader over OutboundHttp (E50.6). This package never makes a request of its own.

/** One search result. `snippet` may be empty (an answer-type provider's citation). */
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
}

export interface WebSearchResult {
  /** A bounded id ('brave', 'tavily', 'exa', 'searxng', 'openai'), for the step and the span. Never a URL. */
  provider: string;
  /** Always present; may be empty. */
  hits: WebSearchHit[];
  /** Answer-type providers only (OpenAI, Perplexity): the answer, and the URLs it cites in the provider's order. */
  answer: { text: string; citations: string[] } | null;
}

export type WebFreshness = 'day' | 'week' | 'month' | 'year';

export interface WebSearchRequest {
  query: string;
  count: number;
  freshness: WebFreshness | null;
  site: string | null;
  signal: AbortSignal;
}

/** Searches the public web. Throws `WebToolError`, never an error carrying a provider's own text. */
export interface WebSearchPort {
  search(req: WebSearchRequest): Promise<WebSearchResult>;
}

export interface WebFetchRequest {
  url: string;
  maxChars: number;
  signal: AbortSignal;
}

export interface WebPage {
  /** The address after redirects; the port checked every hop against the run's allowed sites (E50.6). */
  finalUrl: string;
  title: string | null;
  text: string;
  /** The text was cut at `maxChars`. */
  truncated: boolean;
  contentType: string;
}

/** Reads one public page as text, on the server: no sign-in, no scripts. Throws `WebToolError`. */
export interface WebFetchPort {
  fetch(req: WebFetchRequest): Promise<WebPage>;
}

export const WEB_TOOL_ERROR_CODES = [
  'NOT_CONFIGURED',
  'AUTH_REFUSED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'UNAVAILABLE',
  'BLOCKED',
  'NOT_ALLOWED',
  'UNSUPPORTED_TYPE',
  'TOO_LARGE',
  'LIMIT_REACHED',
  'ABORTED',
] as const;

export type WebToolErrorCode = (typeof WEB_TOOL_ERROR_CODES)[number];

/**
 * What a port throws. The code is a closed vocabulary; the tools turn it into a fixed sentence, so no provider text ever reaches the model.
 * The message is the code itself, on purpose.
 */
export class WebToolError extends Error {
  readonly code: WebToolErrorCode;
  readonly retryAfterMs?: number;

  constructor(code: WebToolErrorCode, options: { retryAfterMs?: number } = {}) {
    super(code);
    this.name = 'WebToolError';
    this.code = code;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export function isWebToolError(e: unknown): e is WebToolError {
  return e instanceof WebToolError || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'WebToolError' && WEB_TOOL_ERROR_CODES.includes((e as { code?: unknown }).code as WebToolErrorCode));
}
