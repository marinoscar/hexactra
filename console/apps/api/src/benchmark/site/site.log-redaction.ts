// Keeps a trial's token out of the request log (E44.2, #740). The platform's request logger and error filter print
// `METHOD request.url`, and the token of a trial is a path segment of every page of the challenge site. The token is random, short
// lived and opens fixture data only, but it is the one credential of a trial's site, so the URL the rest of the stack sees is
// rewritten for these paths (the same technique as src/secrets/secrets.log-redaction.ts). Fastify has routed the request and parsed
// its parameters and query by then, which is what the controller reads. Traces skip the paths (`ignoreIncomingPaths` in
// src/instrumentation.ts) and the nginx location does not log them (infra/nginx/app.d/locations/benchmark.conf).
import type { FastifyInstance } from 'fastify';

import { redactedBenchmarkSiteUrl } from './site.paths';

/** Registers the `onRequest` hook. Call before the app is initialised. */
export function registerBenchmarkSiteLogRedaction(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', async (request) => {
    request.raw.url = redactedBenchmarkSiteUrl(request.raw.url);
  });
}
