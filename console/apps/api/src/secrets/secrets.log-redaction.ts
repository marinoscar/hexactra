// Keeps the OAuth callbacks' query (the Vault's and, since E39.2, the Connections') (`code`, `state`) out of the request log (E37.2, #591).
//
// The platform's request logger and error filter print `METHOD request.url`, and an authorization response is a GET
// with `?code=...&state=...`. A code is single-use, short-lived and useless without the PKCE verifier, but a secret
// is never allowed in a log line, so for this one path the URL the rest of the stack sees is rewritten to carry no
// query. Fastify has parsed the query by then (`request.query`, which the handler reads); only `request.url` changes.
// Traces skip the path (`ignoreIncomingPaths` in src/instrumentation.ts) and the nginx location does not log it
// (infra/nginx/app.d/locations/secrets-callback.conf).
import type { FastifyInstance } from 'fastify';

import { CONNECTION_CALLBACK_PATH_PREFIX } from '../connections/connections.paths';
import { VAULT_CALLBACK_PATH } from './secrets.paths';

/** The URL as the logs should see it. */
export function redactedCallbackUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  if (q === -1) return url;
  const path = url.slice(0, q);
  if (path === VAULT_CALLBACK_PATH) return `${VAULT_CALLBACK_PATH}?redacted`;
  // The Connections callbacks (E39.2): `/api/connections/callback/google|microsoft` carry the same `?code=&state=`.
  if (path.startsWith(CONNECTION_CALLBACK_PATH_PREFIX) && path.length < CONNECTION_CALLBACK_PATH_PREFIX.length + 20) return `${path}?redacted`;
  return url;
}

/** Registers the `onRequest` hook. Call before the app is initialised. */
export function registerVaultCallbackLogRedaction(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', async (request) => {
    request.raw.url = redactedCallbackUrl(request.raw.url);
  });
}
