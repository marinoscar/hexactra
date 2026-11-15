import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { ActionTokenStore } from './action-token-store';

/** How long the buttons on a "needs you" notification work. */
export const RUN_ACTION_TTL_S = 60 * 60;

/** What a run notification button may do: stop the run, approve a plain confirmation, or remind later. */
export type RunAction = 'cancel' | 'approve' | 'snooze';

/** A question notification's quick-answer buttons: the first or second allowed answer. */
export const QUESTION_ACTIONS = ['answer-0', 'answer-1'] as const;
export type QuestionAction = (typeof QUESTION_ACTIONS)[number];

export interface RunActionClaims {
  t?: 'run';
  userId: string;
  runId: string;
  /** The handoff an `approve` answers; `null` when only `cancel` is allowed. */
  handoffId: string | null;
  exp: number;
  nonce: string;
}

export interface QuestionActionClaims {
  t: 'question';
  userId: string;
  questionId: string;
  /** The answer value each button sends, in button order (`answer-0`, `answer-1`). */
  answers: string[];
  exp: number;
  nonce: string;
}

export type ActionClaims = RunActionClaims | QuestionActionClaims;

/**
 * Tokens for the action buttons of a notification, so a person can act from
 * the phone without opening the app: the service worker holds no session, so
 * the button carries its authority.
 *
 * - HMAC-SHA256, keyed from `JWT_SECRET`, over what the button may do: stop
 *   one run or approve its plain confirmation (an hour), or send one of the
 *   allowed answers to one question (until it expires).
 * - Usable once, on every API instance: the nonce is spent in
 *   `action_tokens` (only its sha256 is stored).
 * - A question token exists only for a public answer a button can carry
 *   (a low-risk confirm, a two-option choice): never a secret, a high-risk
 *   confirm or a free-form value.
 */
@Injectable()
export class RunActionTokens {
  private readonly key: Buffer;

  constructor(private readonly store: ActionTokenStore) {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is required to sign notification actions');
    this.key = createHmac('sha256', secret).update('hexactra-run-action-v1').digest();
  }

  private sign(claims: ActionClaims): string {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${body}.${createHmac('sha256', this.key).update(body).digest('base64url')}`;
  }

  issue(userId: string, runId: string, approveHandoffId: string | null, now = Date.now()): string {
    return this.sign({ t: 'run', userId, runId, handoffId: approveHandoffId, exp: Math.floor(now / 1000) + RUN_ACTION_TTL_S, nonce: randomBytes(12).toString('base64url') });
  }

  /** A question's quick-answer token: valid until `expiresAt`, for `answers` only. */
  issueQuestion(userId: string, questionId: string, answers: readonly string[], expiresAt: Date): string {
    return this.sign({ t: 'question', userId, questionId, answers: [...answers], exp: Math.floor(expiresAt.getTime() / 1000), nonce: randomBytes(12).toString('base64url') });
  }

  /** The claims of a correctly signed, unexpired token (not spent), else `null`. */
  verify(token: string | undefined, now = Date.now()): ActionClaims | null {
    if (!token || token.length > 1500) return null;
    const [body, sig, extra] = token.split('.');
    if (!body || !sig || extra !== undefined) return null;
    const expected = createHmac('sha256', this.key).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let claims: ActionClaims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ActionClaims;
    } catch {
      return null;
    }
    if (!claims || typeof claims !== 'object' || typeof claims.nonce !== 'string') return null;
    if (!Number.isInteger(claims.exp) || claims.exp * 1000 <= now) return null;
    return claims;
  }

  /** Spend a verified token's nonce: `true` for exactly one caller, on any instance. */
  spend(claims: ActionClaims): Promise<boolean> {
    return this.store.spendOnce(claims.nonce, claims.t === 'question' ? 'question-action' : 'run-action', new Date(claims.exp * 1000));
  }

  /**
   * The claims of a valid, unexpired, unused run token for `action` (the
   * token is spent), else `null`.
   */
  async redeem(token: string | undefined, action: RunAction, now = Date.now()): Promise<RunActionClaims | null> {
    const claims = this.verify(token, now);
    if (!claims || claims.t === 'question') return null;
    if (action === 'approve' && !claims.handoffId) return null;
    return (await this.spend(claims)) ? claims : null;
  }

  /**
   * The claims and the answer of a valid, unused question token for a
   * quick-answer button (the token is spent), else `null`.
   */
  async redeemQuestion(token: string | undefined, action: QuestionAction, now = Date.now()): Promise<{ claims: QuestionActionClaims; value: string } | null> {
    const claims = this.verify(token, now);
    if (!claims || claims.t !== 'question' || !Array.isArray(claims.answers)) return null;
    const value = claims.answers[QUESTION_ACTIONS.indexOf(action)];
    if (typeof value !== 'string') return null;
    return (await this.spend(claims)) ? { claims, value } : null;
  }
}
