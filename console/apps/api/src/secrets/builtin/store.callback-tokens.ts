// The credential the fabric presents on the built-in store's internal release route (E37.5, #594).
//
// The built-in store has no address of its own, so the fabric calls BACK into the console
// (`/api/internal/secrets-store/v1/*`, store.callback.controller.ts). What authenticates that call is not a user's
// session, a personal access token or an AI app's OAuth token (none of them is accepted there) but this credential:
//
//   - minted by the console when it registers the store with the fabric for ONE owner (`sct_` + 256 random bits),
//     handed to the fabric as the provider's access token (held in the fabric's memory only), kept here as a hash;
//   - bound to that owner: the route refuses a request that names another owner;
//   - short-lived (`TOKEN_TTL_MS`), revoked on switching the store off or changing provider, and one registration
//     replaces the previous credential of the owner.
//
// A token never appears in a log line, an audit event, an error or a response.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

export const CALLBACK_TOKEN_PREFIX = 'sct_';
/** The fabric re-registers while a run is live; a token the console lost track of dies on its own. */
export const TOKEN_TTL_MS = 60 * 60_000;

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** True when `value` has the shape of a callback token (a cheap pre-check; never proof). */
export function looksLikeCallbackToken(value: string): boolean {
  return value.startsWith(CALLBACK_TOKEN_PREFIX) && /^[A-Za-z0-9_-]{43}$/.test(value.slice(CALLBACK_TOKEN_PREFIX.length));
}

@Injectable()
export class SecretsStoreCallbackTokens {
  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  constructor(private readonly prisma: PrismaService) {}

  /** Mints a credential for `userId`, revoking the owner's earlier ones. Returns the token (once) and its expiry. */
  async mint(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = `${CALLBACK_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const now = new Date(this.clock());
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
    await this.prisma.$transaction([
      this.prisma.secretsStoreCallbackToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.secretsStoreCallbackToken.create({ data: { userId, tokenHash: hashOf(token), expiresAt } }),
    ]);
    return { token, expiresAt };
  }

  /** The owner a valid, unexpired, unrevoked credential belongs to, or null. */
  async verify(token: string): Promise<string | null> {
    if (!looksLikeCallbackToken(token)) return null;
    const hash = hashOf(token);
    const row = await this.prisma.secretsStoreCallbackToken.findUnique({ where: { tokenHash: hash } });
    if (!row || row.revokedAt || row.expiresAt.getTime() <= this.clock()) return null;
    // The lookup was by hash already; the constant-time compare keeps the check uniform.
    const a = Buffer.from(row.tokenHash);
    const b = Buffer.from(hash);
    return a.length === b.length && timingSafeEqual(a, b) ? row.userId : null;
  }

  /** Revokes every credential of the owner (switch turned off, provider changed). */
  async revokeFor(userId: string): Promise<number> {
    const { count } = await this.prisma.secretsStoreCallbackToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(this.clock()) } });
    return count;
  }

  /** Removes expired and long-revoked rows (the maintenance job). */
  async sweep(olderThanMs = 24 * 60 * 60_000): Promise<number> {
    const cutoff = new Date(this.clock() - olderThanMs);
    const { count } = await this.prisma.secretsStoreCallbackToken.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] } });
    return count;
  }
}
