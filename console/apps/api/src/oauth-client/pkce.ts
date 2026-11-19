// PKCE (RFC 7636, S256) and the random values of an OAuth client flow. Generic: the Vault connection
// (src/secrets) uses it first, E39's Google and Microsoft connections reuse it.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A URL-safe random string of `bytes` random bytes (43 characters for 32). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** A PKCE code verifier: 64 characters of the unreserved set (RFC 7636 §4.1 allows 43 to 128). */
export function newCodeVerifier(): string {
  return randomToken(48);
}

/** `BASE64URL(SHA256(verifier))`: the `S256` code challenge. */
export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** The hex SHA-256 of a value: how `state` and the browser-binding cookie are kept (never the value itself). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time equality of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}
