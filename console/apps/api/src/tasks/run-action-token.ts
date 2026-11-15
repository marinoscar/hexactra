import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

/** How long the buttons on a "needs you" notification work. */
export const RUN_ACTION_TTL_S = 60 * 60;

/** What a notification button may do: stop the run, or approve a plain confirmation. */
export type RunAction = 'cancel' | 'approve';

export interface RunActionClaims {
  userId: string;
  runId: string;
  /** The handoff an `approve` answers; `null` when only `cancel` is allowed. */
  handoffId: string | null;
  exp: number;
  nonce: string;
}

/**
 * Tokens for the action buttons of a "needs you" notification (Stop run,
 * Approve), so a person can act from the phone without opening the app: the
 * service worker holds no session, so the button carries its authority.
 *
 * - HMAC-SHA256, keyed from `JWT_SECRET`, over the run, its owner and the
 *   handoff it may approve; valid for an hour; usable once (used nonces are
 *   kept in memory until they expire, one API instance).
 * - An `approve` token exists only for a confirmation with no input: a code,
 *   a password, a choice or a sign-in always needs the app.
 */
@Injectable()
export class RunActionTokens {
  private readonly key: Buffer;
  private readonly used = new Map<string, number>();

  constructor() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is required to sign notification actions');
    this.key = createHmac('sha256', secret).update('hexactra-run-action-v1').digest();
  }

  issue(userId: string, runId: string, approveHandoffId: string | null, now = Date.now()): string {
    const claims: RunActionClaims = { userId, runId, handoffId: approveHandoffId, exp: Math.floor(now / 1000) + RUN_ACTION_TTL_S, nonce: randomBytes(12).toString('base64url') };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`;
  }

  /** The claims of a valid, unexpired, unused token for `action` (the token is spent), else `null`. */
  redeem(token: string | undefined, action: RunAction, now = Date.now()): RunActionClaims | null {
    if (!token || token.length > 1000) return null;
    const [body, sig, extra] = token.split('.');
    if (!body || !sig || extra !== undefined) return null;
    const expected = createHmac('sha256', this.key).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let claims: RunActionClaims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as RunActionClaims;
    } catch {
      return null;
    }
    if (!Number.isInteger(claims.exp) || claims.exp * 1000 <= now) return null;
    if (action === 'approve' && !claims.handoffId) return null;
    for (const [n, exp] of this.used) if (exp * 1000 <= now) this.used.delete(n);
    if (this.used.has(claims.nonce)) return null;
    this.used.set(claims.nonce, claims.exp);
    return claims;
  }
}
