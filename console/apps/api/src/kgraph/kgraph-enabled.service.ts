import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { effectiveMode, modeSchema, type Mode } from '@marinoscar/hexactra-kgraph';

import { PrismaService } from '../prisma/prisma.service';
import { KGRAPH_ERROR_STAGES, type KgraphErrorStage } from './kgraph-metrics';
import { readKgraphSystemSettings, readKgraphUserSettings, type KgraphSystemSettings } from './kgraph.settings';

/** What the gate needs to know about the run asking. */
export interface KgraphRunFacts {
  /** True for a saved task's run; a chat goal or an ad-hoc run is always `off`. */
  isTaskRun: boolean;
  /** "Run with AI only this time". */
  aiOnly?: boolean;
}

/** The effective switches of one user, for `GET /api/kgraph/status` and the gate. */
export interface KgraphStatus {
  deployment: boolean;
  user: boolean;
  /** Both switches on: a task may choose `learn` or `reuse`. */
  available: boolean;
  /** The user's own everyday switch (E46.28): effective for chats and one-off runs only while `available`. */
  everyday: boolean;
  /** The user's "Approve facts from server records automatically" (E46.36): effective only while `available`. */
  autoApproveFacts: boolean;
}

/**
 * The one gate of the Knowledge Graph (E46.3, #777). Every other E46 code path asks `modeFor` and nothing else. It reads, in order, the
 * deployment switch, the user switch, the task mode, the run's AI-only flag and whether it is a saved task's run. It never throws: an error
 * reading any of them is `off`. The caller reads it once per job.
 */
@Injectable()
export class KgraphEnabledService {
  private readonly log = new Logger(KgraphEnabledService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly systemSettings?: SystemSettingsService,
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  async systemSettingsOf(): Promise<KgraphSystemSettings> {
    return readKgraphSystemSettings(await this.systemSettings?.getNamespace('kgraph'));
  }

  async status(userId: string): Promise<KgraphStatus> {
    const deployment = (await this.systemSettingsOf()).enabled;
    const row = await this.prisma.userSettings.findUnique({ where: { userId }, select: { value: true } });
    const own = readKgraphUserSettings(row?.value);
    return { deployment, user: own.enabled, available: deployment && own.enabled, everyday: own.everyday, autoApproveFacts: own.autoApproveFacts };
  }

  /** The task's stored mode (`off` without a row). */
  async taskMode(userId: string, taskId: string): Promise<Mode> {
    const row = await this.prisma.forUser({ userId }).kgTaskSettings.findFirst({ where: { taskId }, select: { mode: true } });
    const parsed = modeSchema.safeParse(row?.mode);
    return parsed.success ? parsed.data : 'off';
  }

  async modeFor(input: { userId: string; taskId: string | null; run: KgraphRunFacts }): Promise<Mode> {
    try {
      if (!input.run.isTaskRun || input.taskId === null) return 'off';
      const s = await this.status(input.userId);
      if (!s.available) return 'off';
      return effectiveMode({ deployment: s.deployment, user: s.user, task: await this.taskMode(input.userId, input.taskId), aiOnlyThisRun: input.run.aiOnly === true, savedTask: true });
    } catch (err) {
      this.log.warn(`kgraph mode read failed, using off: ${err instanceof Error ? err.name : 'error'}`);
      return 'off';
    }
  }

  /**
   * The everyday switch (E46.28): true only when the deployment, user and everyday switches are on and the run is NOT a saved task's run (a
   * chat, a conversation's run or a one-off run). Such a run is offered matched procedures; it never captures, compiles or replays a whole
   * procedure by itself. Never throws: an error reading any switch is false, so the run is exactly as without the feature.
   */
  async everydayFor(userId: string, run: KgraphRunFacts): Promise<boolean> {
    try {
      if (run.isTaskRun) return false;
      const s = await this.status(userId);
      return s.available && s.everyday;
    } catch (err) {
      this.log.warn(`kgraph everyday read failed, using off: ${err instanceof Error ? err.name : 'error'}`);
      return false;
    }
  }

  /** Counts one Knowledge Graph failure that did not fail the run (`app.kgraph.errors{stage}`). Never throws. */
  countError(stage: KgraphErrorStage): void {
    try {
      if ((KGRAPH_ERROR_STAGES as readonly string[]).includes(stage)) this.metrics?.add('kgraphErrors', 1, { stage });
    } catch {
      // A metric never fails a run.
    }
  }
}
