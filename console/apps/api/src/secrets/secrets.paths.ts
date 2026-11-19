// Plain constants of the Vault connection that `src/instrumentation.ts` (loaded before Nest, so it imports nothing
// Nest-related) and the Fastify hook both need.

/** The OAuth redirect URI's path: the browser arrives here from Vault with `?code=` and `?state=`. */
export const VAULT_CALLBACK_PATH = '/api/secrets/vault/callback';
