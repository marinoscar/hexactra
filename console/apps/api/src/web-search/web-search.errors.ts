import { HttpException, HttpStatus } from '@nestjs/common';
import { registerErrorCode } from '@marinoscar/platform-api/core';
import type { WebToolError, WebToolErrorCode } from '@marinoscar/hexactra-web-agent';

// The error codes of `POST /api/web-search/search` (E50.5, #975): a `WebToolError` code with a `WEB_SEARCH_` prefix. None carries a
// provider's message, the query or a key.
const CODES = {
  NOT_CONFIGURED: { status: HttpStatus.CONFLICT, description: 'Web search is off for you, or no provider has a usable key. `GET /api/web-search/status` says why.' },
  AUTH_REFUSED: { status: HttpStatus.BAD_GATEWAY, description: 'The search provider refused the key.' },
  RATE_LIMITED: { status: HttpStatus.TOO_MANY_REQUESTS, description: 'The search provider asked to slow down. `details.retryAfterMs` when it said how long.' },
  QUOTA_EXCEEDED: { status: HttpStatus.BAD_GATEWAY, description: "The key's quota at the search provider is spent." },
  UNAVAILABLE: { status: HttpStatus.BAD_GATEWAY, description: 'The search provider could not be reached or did not answer.' },
  LIMIT_REACHED: { status: HttpStatus.TOO_MANY_REQUESTS, description: "Today's web search limit for you is reached (Administration → Web search)." },
  ABORTED: { status: HttpStatus.SERVICE_UNAVAILABLE, description: 'The search was cancelled.' },
} as const satisfies Partial<Record<WebToolErrorCode, { status: HttpStatus; description: string }>>;

for (const [code, v] of Object.entries(CODES)) registerErrorCode({ code: `WEB_SEARCH_${code}`, status: v.status, description: v.description });
registerErrorCode({ code: 'WEB_SEARCH_TEST_RATE_LIMITED', status: 429, description: 'At most 10 searches a minute from this route. `details.retryAfterS` says how long to wait.' });

/** A `WebToolError` as an HTTP error with a fixed sentence. */
export function webSearchHttpError(e: WebToolError): HttpException {
  const known = (CODES as Record<string, { status: HttpStatus; description: string }>)[e.code] ?? CODES.UNAVAILABLE;
  const code = e.code in CODES ? e.code : 'UNAVAILABLE';
  return new HttpException({ code: `WEB_SEARCH_${code}`, message: known.description, ...(e.retryAfterMs !== undefined ? { details: { retryAfterMs: e.retryAfterMs } } : {}) }, known.status);
}
