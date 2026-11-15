import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma, type ActionToken } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/** What a stored token authorizes. Permanent ids (stored in `action_tokens.purpose`). */
export type ActionTokenPurpose = 'run-action' | 'question-action' | 'question-webhook';

/** sha256 (hex) of a token or nonce: the only form stored. */
export function tokenHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Why a stored token was refused. */
export type StoredTokenRefusal = 'unknown' | 'used' | 'expired';

/**
 * Single use across every API instance (`action_tokens`), for the
 * notification buttons' signed tokens (their nonce is spent here) and the
 * random webhook answer tokens (issued and redeemed here). Only sha256 is
 * stored; a token never appears in a row, a log line or an error.
 */
@Injectable()
export class ActionTokenStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Spend a signed token's nonce: `true` the first time, `false` on every
   * later call (on this or any other instance).
   */
  async spendOnce(nonce: string, purpose: ActionTokenPurpose, expiresAt: Date): Promise<boolean> {
    const now = new Date();
    try {
      await this.prisma.actionToken.create({ data: { tokenHash: tokenHash(nonce), purpose, expiresAt, usedAt: now } });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
      throw e;
    }
  }

  /**
   * Issue a random token, stored as sha256. With `issueKey`, at most one is
   * ever issued for that key: a second call returns `null`.
   */
  async issue(purpose: ActionTokenPurpose, opts: { expiresAt: Date; questionId?: string | null; issueKey?: string | null }): Promise<string | null> {
    const token = randomBytes(32).toString('base64url');
    try {
      await this.prisma.actionToken.create({
        data: { tokenHash: tokenHash(token), purpose, expiresAt: opts.expiresAt, questionId: opts.questionId ?? null, issueKey: opts.issueKey ?? null },
      });
      return token;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      throw e;
    }
  }

  /** The stored row of a usable token, or why it is refused. Does not spend it. */
  async find(token: string | undefined, purpose: ActionTokenPurpose, now = new Date()): Promise<ActionToken | StoredTokenRefusal> {
    if (!token || token.length < 16 || token.length > 200) return 'unknown';
    const row = await this.prisma.actionToken.findUnique({ where: { tokenHash: tokenHash(token) } });
    if (!row || row.purpose !== purpose) return 'unknown';
    if (row.usedAt) return 'used';
    if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
    return row;
  }

  /** Spend a found token: `true` for exactly one caller. */
  async claim(row: Pick<ActionToken, 'id'>, now = new Date()): Promise<boolean> {
    const { count } = await this.prisma.actionToken.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    return count === 1;
  }

  /** Delete rows that expired before `before` (the `questions.expire` job). */
  async purgeExpired(before: Date): Promise<number> {
    const { count } = await this.prisma.actionToken.deleteMany({ where: { expiresAt: { lt: before } } });
    return count;
  }
}
