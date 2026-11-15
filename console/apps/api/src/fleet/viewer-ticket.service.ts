import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

/** How long a ticket in a viewer link is valid (once). */
export const VIEWER_TICKET_TTL_S = 60;
/** How long the viewer cookie lasts once a ticket is exchanged. */
export const VIEWER_SESSION_TTL_S = 60 * 60;
export const VIEWER_COOKIE = 'hx_viewer';

type Kind = 't' | 'c';

/**
 * Tickets for the browser viewer that nginx proxies at `/viewer/<host>/`
 * (infra/nginx/app.d/locations/viewer.conf). A browser navigation carries
 * no bearer token, so:
 *
 * 1. a `fleet:write` user asks the API for a viewer link: a single-use
 *    ticket valid for 60 s;
 * 2. nginx's `auth_request` sends the ticket to `GET /api/fleet/viewer-auth`,
 *    which answers 204 plus a `/viewer/`-scoped HttpOnly cookie valid for an
 *    hour (the page's assets and its WebSocket then use the cookie);
 * 3. anything else is 401 and nginx serves nothing from the host.
 *
 * Both are HMAC-SHA256 over `kind.exp.nonce`, keyed from `JWT_SECRET`. Used
 * ticket nonces are kept in memory until they expire (one API instance).
 */
@Injectable()
export class ViewerTicketService {
  private readonly key: Buffer;
  private readonly used = new Map<string, number>();

  constructor() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is required to sign viewer tickets');
    this.key = createHmac('sha256', secret).update('hexactra-viewer-v1').digest();
  }

  private sign(kind: Kind, ttlS: number, now = Date.now()): string {
    const exp = Math.floor(now / 1000) + ttlS;
    const nonce = randomBytes(12).toString('base64url');
    const body = `${kind}.${exp}.${nonce}`;
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`;
  }

  /** `{ exp, nonce }` of a valid, unexpired value of `kind`, or `null`. */
  private verify(kind: Kind, value: string | undefined, now = Date.now()): { exp: number; nonce: string } | null {
    if (!value || value.length > 200) return null;
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== kind) return null;
    const [, expS, nonce, sig] = parts as [string, string, string, string];
    const expected = createHmac('sha256', this.key).update(`${kind}.${expS}.${nonce}`).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const exp = Number(expS);
    if (!Number.isInteger(exp) || exp * 1000 <= now) return null;
    return { exp, nonce };
  }

  issueTicket(): string {
    return this.sign('t', VIEWER_TICKET_TTL_S);
  }

  /** A fresh session for a valid, unused ticket (the ticket is spent), else `null`. */
  exchange(ticket: string | undefined, now = Date.now()): string | null {
    const t = this.verify('t', ticket, now);
    if (!t) return null;
    for (const [nonce, exp] of this.used) if (exp * 1000 <= now) this.used.delete(nonce);
    if (this.used.has(t.nonce)) return null;
    this.used.set(t.nonce, t.exp);
    return this.sign('c', VIEWER_SESSION_TTL_S, now);
  }

  validSession(cookie: string | undefined, now = Date.now()): boolean {
    return this.verify('c', cookie, now) !== null;
  }

  /** The `Set-Cookie` value for a session. */
  cookieHeader(session: string, secure: boolean): string {
    return `${VIEWER_COOKIE}=${session}; Path=/viewer/; Max-Age=${VIEWER_SESSION_TTL_S}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }
}
