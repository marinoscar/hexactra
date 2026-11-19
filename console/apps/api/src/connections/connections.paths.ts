// Plain constants of the connection callback that `src/instrumentation.ts` (loaded before Nest, so it imports nothing
// Nest-related) and the Fastify hook both need.

/** The OAuth redirect URIs' path prefix: the browser arrives at `<prefix>google` or `<prefix>microsoft` with `?code=` and `?state=`. */
export const CONNECTION_CALLBACK_PATH_PREFIX = '/api/connections/callback/';
