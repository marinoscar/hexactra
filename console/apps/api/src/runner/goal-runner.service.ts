import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AiService } from '@marinoscar/platform-api/ai';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { ApprovalRulesService } from '../approvals/approval-rules.service';
import { ASK_TOPICS } from '../approvals/approval-match';
import { FabricClient } from '../fabric/fabric.client';
import { MemoryContext } from '../memories/memory-context';
import { MemoryProposals } from '../memories/memory-proposals.service';
import { PolicyModelCheck } from '../policies/policy-model-check';
import { ModelTiersService } from '../policies/model-tiers.service';
import { PolicyResolver } from '../policies/policy.resolver';
import { PrismaService } from '../prisma/prisma.service';
import { QuestionsService } from '../questions/questions.service';
import { RunSecretsService } from '../secrets/run-secrets.service';
import { RUN_ARTIFACT_STORE, type RunArtifactStore } from '../tasks/run-delete.service';
import { RunNotifier } from '../tasks/run-notifier';
import { TasksService } from '../tasks/tasks.service';
import { AgentTrace } from './agent-trace';
import { browserInstructions } from '@marinoscar/hexactra-browser-agent/instructions';
import { LeaseLost, RunLease } from './lease';
import type { RunOutcome } from '@marinoscar/hexactra-agent';
import { RunStopSignal } from './stop-signal';
import { AGENT, ATTR } from './trace-attributes';
import { beforeLoop } from './host/before-loop';
import { buildRun } from './host/build-context';
import type { HostDeps } from './host/deps';
import { policySnapshot } from './host/policy-snapshot';
import { startRun } from './host/start';

export { GUIDANCE_PREFIX } from '@marinoscar/hexactra-agent/engine';
export { describeScript } from '@marinoscar/hexactra-browser-agent/page';
export { answerLine, requestHumanSpec, type RequestHumanArgs } from '@marinoscar/hexactra-browser-agent/request-human-spec';
export { pausedFor } from './host/paused-for';
export type { RunMemory, SaveLoginMemory, RunOutcome } from './host/run-memory';

/** The browser agent's system instructions: the sections of `browser/instructions.ts`, with the owner's fixed ask topics. */
export const INSTRUCTIONS = browserInstructions(ASK_TOPICS);

/**
 * The goal runner: an AI tool loop that drives a browser toward a run's goal, pausing for people through handoffs (E38.5). This service
 * only loads the run and holds it; the work is in three layers beside it: `harness/` (the generic loop, tools, gates and ports),
 * `browser/` (the browser and desktop tools, vision, the site and risk gates) and `host/` (the bindings to the console's services).
 * See `console/docs/runner.md`.
 */
@Injectable()
export class GoalRunnerService {
  private readonly log = new Logger(GoalRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly fabric: FabricClient,
    private readonly ai: AiService,
    @Optional() private readonly notifier?: RunNotifier,
    @Optional() private readonly questions?: QuestionsService,
    @Optional() private readonly systemSettings?: SystemSettingsService,
    @Optional() private readonly policies?: PolicyResolver,
    @Optional() private readonly modelCheck?: PolicyModelCheck,
    @Optional() private readonly modelTiers?: ModelTiersService,
    /** Where the masked trace screenshots go (#541); absent without the storage slice, and then none is taken. */
    @Optional() @Inject(RUN_ARTIFACT_STORE) public artifacts?: RunArtifactStore,
    /** The owner's memories (#553): the block the model reads, and the proposals it may make. */
    @Optional() private readonly memoryContext?: MemoryContext,
    @Optional() private readonly proposals?: MemoryProposals,
    /** Saved approvals (#555): the owner's standing answers, matched by the server. Absent: every step asks as before. */
    @Optional() public approvals?: ApprovalRulesService,
    /** The owner's secrets providers (E37.3): absent without the secrets module, and then no run signs in from a saved login. */
    @Optional() public secrets?: RunSecretsService,
  ) {}

  /** The wall clock; tests replace it to pass time without waiting. */
  clock: () => number = Date.now;

  /** The collaborators the host layer binds, as they are now (a test may replace `artifacts`, `approvals`, `secrets` or `clock`). */
  private deps(): HostDeps {
    return {
      prisma: this.prisma,
      tasks: this.tasks,
      fabric: this.fabric,
      ai: this.ai,
      notifier: this.notifier,
      questions: this.questions,
      systemSettings: this.systemSettings,
      policies: this.policies,
      modelCheck: this.modelCheck,
      modelTiers: this.modelTiers,
      artifacts: this.artifacts,
      memoryContext: this.memoryContext,
      proposals: this.proposals,
      approvals: this.approvals,
      secrets: this.secrets,
      clock: () => this.clock(),
      log: this.log,
    };
  }

  /** The run's policy snapshot (#401), taken once at its first advance: see `host/policy-snapshot.ts`. Kept here for the specs that read it. */
  policySnapshot(...args: Parameters<typeof policySnapshot> extends [unknown, ...infer Rest] ? Rest : never): ReturnType<typeof policySnapshot> {
    return policySnapshot(this.deps(), ...args);
  }

  /**
   * Advance a run: start it, resume it after a handoff, or finish it.
   * Returns what the caller (the job) should do next.
   */
  async advance(runId: string, userId: string, orgId: string | null): Promise<RunOutcome> {
    // One OpenTelemetry trace per job (E38.4, runner/agent-trace.ts): a no-op with the telemetry slice off.
    const tr = AgentTrace.start(AGENT.browser, this.tasks.metrics, { [ATTR.runId]: runId });
    try {
      const outcome = await tr.within(() => this.advanceLeased(runId, userId, orgId, tr));
      const final = tr.recording ? await this.prisma.forUser({ userId }).run.findFirst({ where: { id: runId }, select: { status: true, stopReason: true } }) : null;
      tr.end({ outcome, status: final?.status, stopReason: final?.stopReason });
      return outcome;
    } catch (e) {
      tr.end({ error: e });
      throw e;
    }
  }

  private async advanceLeased(runId: string, userId: string, orgId: string | null, tr: AgentTrace): Promise<RunOutcome> {
    // The job holds the run (E38.3): a job that finds another token later stops without touching the run.
    const lease = await RunLease.claim(this.prisma, userId, runId);
    // The owner's Stop (E38.1): one signal for the job, fed by the `run.cancel` event and a poll of the flag, disposed with the job.
    const events = this.tasks.events;
    const owned = this.prisma.forUser({ userId });
    const stop = RunStopSignal.start({
      runId,
      isRequested: async () => (await owned.run.findFirst({ where: { id: runId }, select: { cancelRequested: true } }))?.cancelRequested === true,
      // The owner's Pause (E38.2) rides the same signal.
      isPauseRequested: async () => (await owned.run.findFirst({ where: { id: runId }, select: { pauseRequested: true } }))?.pauseRequested === true,
      ...(events ? { subscribe: (h) => events.subscribe(h) } : {}),
    });
    try {
      return await this.advanceRun(runId, userId, orgId, lease, tr, stop);
    } catch (e) {
      // A job that lost the run stops quietly, whatever it tripped on: its error must not fail a run another job now drives.
      if (!(e instanceof LeaseLost) && (await lease.held().catch(() => true))) throw e;
      this.log.warn(`run ${runId}: stopped, another job took over the run`);
      return 'superseded';
    } finally {
      await stop.dispose();
      await lease.release().catch(() => undefined);
    }
  }

  /** Load or resume the run, build its context, ask for what the goal needs first, then run the loop. */
  private async advanceRun(runId: string, userId: string, orgId: string | null, lease: RunLease, tr: AgentTrace, stop: RunStopSignal): Promise<RunOutcome> {
    const deps = this.deps();
    const started = await startRun(deps, runId, userId, orgId, lease, tr, stop);
    if (typeof started === 'string') return started;
    const { loop, ctx, profile } = await buildRun(deps, started);
    const early = await beforeLoop(ctx);
    if (early) return early;
    return loop.run(profile as never);
  }
}
