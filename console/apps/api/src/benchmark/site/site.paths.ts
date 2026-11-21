// Plain constants of the challenge site (E44.2, #740) that `src/instrumentation.ts` (loaded before Nest, so it imports nothing
// Nest-related), the Fastify hook and the controller all need.

/** The controller's path below the API prefix. nginx serves the same routes at `/benchmark/` (infra/nginx/app.d/locations/benchmark.conf). */
export const BENCHMARK_SITE_ROUTE = 'benchmark-site';
/** Every request of the site starts with this. A trial's token is the path segment after `t/`, so no span is made for these paths. */
export const BENCHMARK_SITE_PATH_PREFIX = `/api/${BENCHMARK_SITE_ROUTE}/`;

const TRIAL_PATH_PREFIX = `${BENCHMARK_SITE_PATH_PREFIX}t/`;

/**
 * The URL as the logs should see it: everything after `t/` replaced. That drops the token, the page below it (a page's address can
 * hold an id made from the seed) and the query (which can hold what was typed into a challenge). Anything that is not a trial's URL
 * is returned as it is.
 */
export function redactedBenchmarkSiteUrl(url: string | undefined): string | undefined {
  return url?.startsWith(TRIAL_PATH_PREFIX) ? `${TRIAL_PATH_PREFIX}redacted` : url;
}
