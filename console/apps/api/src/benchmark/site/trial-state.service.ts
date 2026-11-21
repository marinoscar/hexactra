// A trial's site token and site state (E44.2, #740; decision record docs/decisions/benchmark.md).
//
//   token   32 random bytes, base64url (43 characters). Only its SHA-256 is stored (`BenchmarkTrial.tokenHash`); the token itself is
//           returned once by `issueToken` and lives in the trial's goal. It opens the trial's pages while the trial is `running`,
//           and nothing else.
//   state   plain JSON in `BenchmarkTrial.siteState`, with the optimistic version `siteStateVersion` beside it: a write names the
//           version it read, and loses to a write that got there first.
//
// Nothing here logs a token, a seed, an answer or a state: a refused write is logged with the trial's id only.
import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { challengeById } from '../suite/registry';
import type { Seed, SiteState } from '../suite/types';

/** A token as `issueToken` makes it: 32 bytes in base64url. Anything else is refused before the database is asked. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
/** A state stays far below this (`SiteState`); a larger one is a bug in a challenge, not something to store. */
export const MAX_SITE_STATE_BYTES = 64 * 1024;

export const isTrialToken = (token: string): boolean => TOKEN_FORMAT.test(token);
/** What is stored of a token. */
export const hashTrialToken = (token: string): string => createHash('sha256').update(token).digest('hex');
/** The trial's own base URL, without a trailing slash: what a challenge's `goal(seed, baseUrl)` is given. */
export const trialBaseUrl = (siteBaseUrl: string, token: string): string => `${siteBaseUrl.replace(/\/+$/, '')}/t/${token}`;

/** A trial as its site sees it. */
export interface TrialSite {
  trialId: string;
  challengeId: string;
  seed: Seed;
  state: SiteState;
  /** The version `state` was read at: what a write must name. */
  version: number;
}

/** `written`; `conflict` (another write got there first: read again and retry); `closed` (the trial no longer accepts writes). */
export type TrialWriteResult = 'written' | 'conflict' | 'closed';

const asState = (value: unknown): SiteState => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as SiteState) : {});

@Injectable()
export class TrialStateService {
  private readonly log = new Logger('BenchmarkSite');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Opens a trial's site: builds the challenge's starting state from the trial's seed, stores it, and returns a new token (the only
   * time it exists outside the trial's goal). An earlier token of the trial stops working. The pages answer once the trial is
   * `running`. Throws for an unknown trial, a challenge the suite does not have, or a trial that is already graded or skipped.
   */
  async issueToken(trialId: string): Promise<string> {
    const trial = await this.prisma.benchmarkTrial.findUnique({ where: { id: trialId }, select: { challengeId: true, seed: true, status: true } });
    if (!trial) throw new Error(`Benchmark trial ${trialId} does not exist`);
    const challenge = challengeById(trial.challengeId);
    if (!challenge) throw new Error(`Benchmark trial ${trialId}: the suite has no challenge ${trial.challengeId}`);
    const token = randomBytes(32).toString('base64url');
    const { count } = await this.prisma.benchmarkTrial.updateMany({
      where: { id: trialId, status: { in: ['pending', 'running'] } },
      data: { tokenHash: hashTrialToken(token), siteState: challenge.setup(trial.seed) as Prisma.InputJsonObject, siteStateVersion: { increment: 1 } },
    });
    if (count !== 1) throw new Error(`Benchmark trial ${trialId} is ${trial.status}: its site cannot be opened`);
    return token;
  }

  /** Closes a trial's site: its token stops working and its state can no longer change. The state stays for the grader. Idempotent. */
  async closeToken(trialId: string): Promise<void> {
    await this.prisma.benchmarkTrial.updateMany({ where: { id: trialId, tokenHash: { not: null } }, data: { tokenHash: null } });
  }

  /** The trial a token opens, or null: a malformed or unknown token, a closed site, a trial that is not `running`. */
  async resolve(token: string): Promise<TrialSite | null> {
    if (!isTrialToken(token)) return null;
    const trial = await this.prisma.benchmarkTrial.findUnique({
      where: { tokenHash: hashTrialToken(token) },
      select: { id: true, challengeId: true, seed: true, status: true, siteState: true, siteStateVersion: true },
    });
    if (!trial || trial.status !== 'running') return null;
    return { trialId: trial.id, challengeId: trial.challengeId, seed: trial.seed, state: asState(trial.siteState), version: trial.siteStateVersion };
  }

  /** A trial's state as it is now, open or closed: what the grader reads when the run has ended. Null for an unknown trial. */
  async read(trialId: string): Promise<{ state: SiteState; version: number } | null> {
    const trial = await this.prisma.benchmarkTrial.findUnique({ where: { id: trialId }, select: { siteState: true, siteStateVersion: true } });
    return trial ? { state: asState(trial.siteState), version: trial.siteStateVersion } : null;
  }

  /**
   * Stores a new state, if the trial is still `running` with an open site and nobody wrote since `version` was read. One statement:
   * a trial closed between the read and the write is refused, never written.
   */
  async write(trialId: string, version: number, state: SiteState): Promise<TrialWriteResult> {
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_SITE_STATE_BYTES) throw new Error(`Benchmark trial ${trialId}: the site state is over ${MAX_SITE_STATE_BYTES} bytes`);
    const { count } = await this.prisma.benchmarkTrial.updateMany({
      where: { id: trialId, status: 'running', tokenHash: { not: null }, siteStateVersion: version },
      data: { siteState: state as Prisma.InputJsonObject, siteStateVersion: { increment: 1 } },
    });
    if (count === 1) return 'written';
    const now = await this.prisma.benchmarkTrial.findUnique({ where: { id: trialId }, select: { status: true, tokenHash: true } });
    if (now && now.status === 'running' && now.tokenHash !== null) return 'conflict';
    this.log.warn(`state write refused: trial ${trialId} is closed`);
    return 'closed';
  }
}
