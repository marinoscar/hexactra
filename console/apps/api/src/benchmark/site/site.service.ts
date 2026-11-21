// The challenge site's dispatcher (E44.2, #740): one request of a trial's site, from token to answer. It resolves the token, counts
// the request against the trial's rate limit, hands the request to the trial's challenge (`Challenge.site`, pure code in
// src/benchmark/suite/) and stores the state the challenge returns, re-running the challenge when another request wrote first.
// The controller only reads the HTTP request and sends what this returns.
import { Inject, Injectable, Optional } from '@nestjs/common';

import { MCP_RATE_LIMITER, type McpRateLimiter } from '../../mcp/mcp.rate-limit';
import type { SiteRequest, SiteResponse } from '../suite/pages';
import { challengeById } from '../suite/registry';
import type { Json } from '../suite/types';
import { NOT_FOUND_HTML, renderPage, siteAsset } from './site.render';
import { TrialStateService } from './trial-state.service';

/** Requests a minute for one trial: pages, their script calls and form posts. A page that polls twice a second stays far below it. */
export const SITE_RATE_LIMIT = 600;
/** The largest body a page may post. nginx refuses a larger one first (`client_max_body_size 64k`). */
export const SITE_MAX_BODY_BYTES = 64 * 1024;
/** How often a request is re-run when another request of the same trial wrote the state first. */
const WRITE_ATTEMPTS = 4;

/** What the controller sends. */
export interface SiteAnswer {
  status: number;
  type: string;
  body: string;
  headers?: Record<string, string>;
}

const HTML = 'text/html; charset=utf-8';
const NOT_FOUND: SiteAnswer = { status: 404, type: HTML, body: NOT_FOUND_HTML };
const plain = (status: number, body: string, headers?: Record<string, string>): SiteAnswer => ({ status, type: 'text/plain; charset=utf-8', body, ...(headers ? { headers } : {}) });

export interface SiteCall {
  token: string;
  method: string;
  /** The path after `t/<token>/`, as it was asked (it may be empty, and may end with a slash). */
  rest: string;
  query: unknown;
  body: unknown;
}

const firstStrings = (query: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (query === null || typeof query !== 'object') return out;
  for (const [key, value] of Object.entries(query)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (typeof v === 'string') out[key] = v.slice(0, 500);
  }
  return out;
};
const asBody = (body: unknown): Record<string, Json> => (body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, Json>) : {});

@Injectable()
export class BenchmarkSiteService {
  constructor(
    private readonly trials: TrialStateService,
    @Optional() @Inject(MCP_RATE_LIMITER) private readonly limiter?: McpRateLimiter,
  ) {}

  /** A script or a stylesheet of the site. The same file for every trial: it needs no token. */
  asset(name: string): SiteAnswer {
    const asset = siteAsset(name);
    return asset ? { status: 200, type: asset.type, body: asset.body, headers: { 'cache-control': 'public, max-age=60' } } : NOT_FOUND;
  }

  /** The site's one 404. */
  notFound(): SiteAnswer {
    return NOT_FOUND;
  }

  async handle(call: SiteCall): Promise<SiteAnswer> {
    if (call.method !== 'GET' && call.method !== 'POST') return NOT_FOUND;
    let trial = await this.trials.resolve(call.token);
    if (!trial) return NOT_FOUND;
    if (this.limiter) {
      // Keyed by the trial, never by the token. A limiter that fails lets the page through: a benchmark is not stopped by it.
      const verdict = await Promise.resolve(this.limiter.hit(`benchmark-site:${trial.trialId}`, SITE_RATE_LIMIT, 60_000)).catch(() => ({ allowed: true, retryAfterS: 0 }));
      if (!verdict.allowed) return plain(429, 'Too many requests. Try again shortly.', { 'retry-after': String(verdict.retryAfterS) });
    }
    if (Buffer.byteLength(JSON.stringify(call.body ?? null)) > SITE_MAX_BODY_BYTES) return plain(413, 'The request is too large.');
    const challenge = challengeById(trial.challengeId);
    if (!challenge) return NOT_FOUND;

    let rest = call.rest;
    try {
      rest = decodeURIComponent(rest);
    } catch {
      return NOT_FOUND;
    }
    const segments = rest.split('/').filter(Boolean);
    if (segments.some((s) => s === '.' || s === '..')) return NOT_FOUND;
    // `orders/abc` is one level below the trial's root, `orders/abc/` two: the relative way back follows the address as it was asked.
    const depth = rest.split('/').length - 1;
    const root = depth === 0 ? './' : '../'.repeat(depth);
    const base: Omit<SiteRequest, 'state'> = { method: call.method, path: segments.join('/'), segments, query: firstStrings(call.query), body: call.method === 'POST' ? asBody(call.body) : {}, root, seed: trial.seed, now: Date.now() };

    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      const response = challenge.site.handle({ ...base, state: trial.state });
      if (response.kind === 'not_found') return NOT_FOUND;
      if (response.state) {
        const written = await this.trials.write(trial.trialId, trial.version, response.state);
        if (written === 'closed') return NOT_FOUND;
        if (written === 'conflict') {
          trial = await this.trials.resolve(call.token);
          if (!trial) return NOT_FOUND;
          continue;
        }
      }
      return this.answer(response, root);
    }
    return plain(503, 'The page is busy. Try again.', { 'retry-after': '1' });
  }

  private answer(response: Exclude<SiteResponse, { kind: 'not_found' }>, root: string): SiteAnswer {
    if (response.kind === 'json') return { status: response.status, type: 'application/json; charset=utf-8', body: JSON.stringify(response.data) };
    // A relative Location: the same redirect works at /benchmark/ behind nginx and at /api/benchmark-site/ in development.
    if (response.kind === 'redirect') return { status: 303, type: HTML, body: '', headers: { location: `${root}${response.to}` } };
    if (response.kind === 'file') return { status: 200, type: 'text/plain; charset=utf-8', body: response.body, headers: { 'content-disposition': `attachment; filename="${response.name}"` } };
    return { status: response.status, type: HTML, body: renderPage(response.view, root) };
  }
}
