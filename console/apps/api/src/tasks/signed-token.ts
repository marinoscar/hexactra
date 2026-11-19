// Small stateless signed tokens for links that must work without a session (the report link, the unsubscribe link of a recipient).
// HMAC-SHA256 over the claims, keyed from `JWT_SECRET` and a per-purpose label (so a token of one purpose never verifies as another),
// so every API instance agrees. The claims are readable (base64url JSON): they hold ids and an expiry, never content.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignedClaims {
  /** The purpose; a token made for one `kind` never verifies for another. */
  k: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
  [claim: string]: string | number;
}

function keyFor(label: string, secret = process.env.JWT_SECRET): Buffer {
  if (!secret) throw new Error('JWT_SECRET is required to sign links');
  return createHmac('sha256', secret).update(`hexactra-signed-link-v1:${label}`).digest();
}

/** `<claims>.<signature>`, both base64url. */
export function signToken(kind: string, claims: Record<string, string | number>, ttlS: number, now = Date.now(), secret?: string): string {
  const body = Buffer.from(JSON.stringify({ ...claims, k: kind, exp: Math.floor(now / 1000) + ttlS })).toString('base64url');
  return `${body}.${createHmac('sha256', keyFor(kind, secret)).update(body).digest('base64url')}`;
}

/** The claims of a token that is intact, made for `kind` and not expired; null for anything else (never throws). */
export function verifyToken(kind: string, token: string, now = Date.now(), secret?: string): SignedClaims | null {
  try {
    if (typeof token !== 'string' || token.length > 2000) return null;
    const [body, sig, ...rest] = token.split('.');
    if (!body || !sig || rest.length) return null;
    const want = createHmac('sha256', keyFor(kind, secret)).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedClaims;
    if (!claims || typeof claims !== 'object' || claims.k !== kind || typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
    return claims;
  } catch {
    return null;
  }
}
