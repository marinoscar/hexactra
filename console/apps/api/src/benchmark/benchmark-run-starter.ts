// Starting a trial's run (E44.3, #741). A trial is an ordinary run with `trigger: benchmark`: the goal runner drives it like any other.
//
// What makes it a benchmark run is written here and nowhere else:
//   - no task and no chat, so it has no connection, no saved login, no saved identity and no saved card: the runner turns each of those
//     on only from a task's or a chat's own switch (`runner/host/start.ts`, `runner/host/connections/run-connections.ts`);
//   - `runs.context.benchmark`: the challenge site's host as its only allowed site, and the challenge's `confirmRiskyActions`
//     (`runner/host/run-limits.ts`; docs/decisions/benchmark.md);
//   - the benchmark's host with no fallback to another machine, and the trial's policy as a run override.
import { Injectable, Logger } from '@nestjs/common';
import { JobsService } from '@marinoscar/platform-api/jobs';
import type { Prisma } from '@prisma/client';

import { FabricClient } from '../fabric/fabric.client';
import { PrismaService } from '../prisma/prisma.service';
import { enqueueGoalRun } from '../runner/goal-run.enqueue';
import { unavailableReason } from '../runner/host-choice';
import { benchmarkRunContext } from '../runner/host/run-limits';
import { BENCHMARK_RUN_TRIGGER } from './benchmark.constants';
import { BenchmarkGrader } from './benchmark-grader';
import { BenchmarkSiteAddress } from './benchmark-site-address';
import type { StoredBenchmarkConfig } from './benchmark-config';
import { TrialStateService, trialBaseUrl } from './site/trial-state.service';
import { challengeById } from './suite/registry';

export interface StartableTrial {
  id: string;
  benchmarkId: string;
  challengeId: string;
  policyRef: string;
  seed: string;
  status: string;
}

@Injectable()
export class BenchmarkRunStarter {
  private readonly log = new Logger(BenchmarkRunStarter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly fabric: FabricClient,
    private readonly site: BenchmarkSiteAddress,
    private readonly trials: TrialStateService,
    private readonly grader: BenchmarkGrader,
  ) {}

  /** Why the benchmark's host cannot take a trial now, or null. A benchmark without a chosen host lets the fabric pick. */
  private async hostProblem(hostId: string | null): Promise<string | null> {
    if (!hostId) return null;
    try {
      const host = (await this.fabric.hosts()).find((h) => h.id === hostId);
      const why = unavailableReason(host);
      return why ? `The node ${host?.name ?? hostId.slice(0, 8)} ${why}` : null;
    } catch (e) {
      return `The fabric did not answer: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * Starts the run of a `pending` trial, or of a `running` one that has no run yet (the process died between the two writes). True: a
   * run is going. False: the trial ended without one (the node is down, the suite no longer has the challenge) and is closed as `error`.
   * Called under the benchmark's lock, so one trial is started once.
   */
  async start(owner: { userId: string; orgId: string | null }, config: StoredBenchmarkConfig, trial: StartableTrial): Promise<boolean> {
    const challenge = challengeById(trial.challengeId);
    if (!challenge) {
      await this.grader.close(trial.id, 'challenge', `The suite has no challenge ${trial.challengeId}`);
      return false;
    }
    const site = await this.site.read();
    const problem = site.reachable ? await this.hostProblem(config.hostId) : site.problem;
    if (problem) {
      await this.grader.close(trial.id, 'host', problem);
      return false;
    }
    const now = new Date();
    if (trial.status === 'pending') {
      const { count } = await this.prisma.benchmarkTrial.updateMany({ where: { id: trial.id, status: 'pending' }, data: { status: 'running', startedAt: now } });
      if (count !== 1) return true;
    }
    // A new token each time: one issued for a run that was never created opens nothing any more.
    const token = await this.trials.issueToken(trial.id);
    const run = await this.prisma.forUser({ userId: owner.userId }).run.create({
      data: {
        userId: owner.userId,
        goal: challenge.goal(trial.seed, trialBaseUrl(site.baseUrl, token)).slice(0, 4000),
        profile: config.profile,
        hostId: config.hostId,
        hostFallback: false,
        trigger: BENCHMARK_RUN_TRIGGER,
        origin: 'system',
        policyRef: trial.policyRef,
        policySource: 'run',
        // Fixed on the run when it is created (epic #755): the benchmark owner's opt-in (#841).
        recordVideo: config.recordVideo,
        context: benchmarkRunContext({ benchmarkId: trial.benchmarkId, trialId: trial.id, allowedDomains: [site.host], confirmRiskyActions: challenge.run?.confirmRiskyActions === true }) as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    await this.prisma.benchmarkTrial.updateMany({ where: { id: trial.id, status: 'running', runId: null }, data: { runId: run.id } });
    await enqueueGoalRun(this.jobs, { runId: run.id, userId: owner.userId, orgId: owner.orgId }, 'run_started');
    this.log.log(`benchmark ${trial.benchmarkId}: trial ${trial.id} started as run ${run.id}`);
    return true;
  }
}
