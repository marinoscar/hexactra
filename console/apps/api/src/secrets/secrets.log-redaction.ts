// Keeps the OAuth callback's query (`code`, `state`) out of the request log (E37.2, #591).
//
// The platform's request logger and error filter print `METHOD request.url`, and an authorization response is a GET
// with `?code=...&state=...`. A code is single-use, short-lived and useless without the PKCE verifier, but a secret
// is never allowed in a log line, so for this one path the URL the rest of the stack sees is rewritten to carry no
// query. Fastify has parsed the query by then (`request.query`, which the handler reads); only `request.url` changes.
// Traces skip the path (`ignoreIncomingPaths` in src/instrumentation.ts) and the nginx location does not log it
// (infra/nginx/app.d/locations/secrets-callback.conf).
import type { FastifyInstance } from 'fastify';

import { VAULT_CALLBACK_PATH } from './secrets.paths';

/** The URL as the logs should see it. */
export function redactedCallbackUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  return q !== -1 && url.slice(0, q) === VAULT_CALLBACK_PATH ? `${VAULT_CALLBACK_PATH}?redacted` : url;
}

/** Registers the `onRequest` hook. Call before the app is initialised. */
export function registerVaultCallbackLogRedaction(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', async (request) => {
    request.raw.url = redactedCallbackUrl(request.raw.url);
  });
}
