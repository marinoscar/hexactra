import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JobsService } from '@marinoscar/platform-api/jobs';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { PrismaService } from '../prisma/prisma.service';
import { enqueueGoalRun } from '../runner/goal-runner.jobs';

/**
 * Answers a run's pending handoff on the fabric and resumes the run: the one
 * path the Inbox and the notification buttons share. A secret value goes to
 * the fabric (single use) and is never stored or logged here.
 */
@Injectable()
export class HandoffAnswers {
  private readonly log = new Logger(HandoffAnswers.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fabric: FabricClient,
    private readonly jobs: JobsService,
  ) {}

  /** `expectHandoffId`: refuse unless the run still waits on that handoff (a notification's stale button). */
  async answer(user: { id: string; activeOrgId?: string | null }, runId: string, outcome: 'completed' | 'cancelled', value?: string, expectHandoffId?: string): Promise<void> {
    const run = await this.prisma.forUser({ userId: user.id }).run.findFirst({ where: { id: runId }, select: { status: true, handoffId: true, trigger: true } });
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    if (run.status !== 'waiting_human' || !run.handoffId || (expectHandoffId && run.handoffId !== expectHandoffId)) {
      throw new ConflictException({ code: 'NOT_WAITING', message: 'This run is not waiting for you' });
    }
    try {
      await this.fabric.request('POST', `/v1/handoffs/${run.handoffId}/respond`, { body: { outcome, ...(value !== undefined ? { value } : {}) } });
    } catch (e) {
      if (e instanceof FabricError && e.status === 400) throw new BadRequestException({ code: 'INVALID_ANSWER', message: e.message });
      if (e instanceof FabricError && (e.status === 409 || e.status === 404)) throw new ConflictException({ code: 'ALREADY_ANSWERED', message: 'This request was already answered or expired' });
      throw e;
    }
    this.log.log(`run ${runId}: handoff ${outcome}`);
    // The AI runner resumes its own runs; an external agent polls its handoff.
    if (run.trigger !== 'external') {
      await enqueueGoalRun(this.jobs, { runId, userId: user.id, orgId: user.activeOrgId ?? null }, 'handoff_answered');
    }
  }
}
