import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { AiError, AiService, aiErrorLogDetails } from '@marinoscar/platform-api/ai';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { registrableDomain, validateSiteFact } from '@marinoscar/hexactra-kgraph';
import type { Prisma, TaskImprovement } from '@prisma/client';
import { z } from 'zod';

import { consoleSecretCheck } from '../kgraph/prisma-site-fact-store';
import { PrismaService } from '../prisma/prisma.service';
import { diagnoseRun, type DiagnosticStep } from '../run-insights/run-diagnostics';
import { maskFinding } from '../run-insights/run-insights.service';
import { RUN_ARTIFACT_STORE, type RunArtifactStore } from '../tasks/run-delete.service';
import { TERMINAL_RUN_STATUSES } from '../tasks/run-status';
import { maskSensitive } from '../tasks/mask';
import { buildImproverInput, type ImproverRun, type ImproverStep } from './task-improver-input';
import { TASK_IMPROVER_INSTRUCTIONS } from './task-improver-instructions';
import { enqueueTaskImprovement } from './task-improver.enqueue';
import { TASK_IMPROVER_FEATURE_ID } from './task-improver.feature';
import { proposalAnswerSchema, type ImprovementStatus, type ProposalAnswer, type ProposalSiteFact } from './task-improver.schemas';
import { validateProposal, type ValidationContext } from './task-improver-validate';

/** The runs read by default, and at most. */
export const DEFAULT_RUNS = 5;
export const MAX_RUNS = 10;
/** Proposals one owner may ask for in a day. */
export const DAILY_LIMIT = 20;
/** Screenshots sent to the model, at most. */
export const MAX_IMAGES = 6;

/**
 * What the model is asked to fill: the same shape as `proposalAnswerSchema`, without length limits (a provider's strict schema mode
 * may not take them). The server then checks the answer against the strict schema and the rules (`validateProposal`).
 */
const answerShape = z.object({
  summary: z.string(),
  proposedGoal: z.string(),
  changes: z.array(
    z.object({
      kind: z.enum(['add', 'replace', 'remove']),
      text: z.string(),
      why: z.string(),
      evidence: z.array(z.object({ runId: z.string(), seqFrom: z.number().int(), seqTo: z.number().int(), finding: z.string().nullable() })),
    }),
  ),
  siteFacts: z.array(
    z.object({
      site: z.string(),
      kind: z.enum(['navigation', 'timing', 'quirk']),
      text: z.string(),
      evidence: z.array(z.object({ runId: z.string(), seqFrom: z.number().int(), seqTo: z.number().int() })),
    }),
  ),
  confidence: z.enum(['low', 'medium', 'high']),
});

/** A proposal as the API shows it. */
export interface ImprovementView {
  id: string;
  taskId: string;
  status: ImprovementStatus;
  runIds: string[];
  goalBefore: string;
  proposedGoal: string | null;
  summary: string | null;
  changes: unknown;
  siteFacts: unknown;
  confidence: string | null;
  model: string | null;
  usedImages: boolean;
  error: string | null;
  appliedGoal: string | null;
  createdAt: string;
  finishedAt: string | null;
  decidedAt: string | null;
}

export function improvementView(r: TaskImprovement, withChanges = true): ImprovementView {
  return {
    id: r.id,
    taskId: r.taskId,
    status: r.status as ImprovementStatus,
    runIds: r.runIds,
    goalBefore: r.goalBefore,
    proposedGoal: r.proposedGoal,
    summary: r.summary,
    changes: withChanges ? r.changes : undefined,
    siteFacts: withChanges ? r.siteFacts : undefined,
    confidence: r.confidence,
    model: r.model,
    usedImages: r.usedImages,
    error: r.error,
    appliedGoal: r.appliedGoal,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    decidedAt: r.decidedAt?.toISOString() ?? null,
  };
}

class ProposalRefused extends Error {}

/**
 * "Improve this task" (E52.8, #1023): an AI reads a task's recent runs and proposes a better goal, each change tied to steps of those
 * runs. It writes a proposal row only: it never changes a task, starts a run, creates a schedule, an approval, a memory or a site fact.
 * The model's answer is data, checked by the server (`validateProposal`) before it is stored as `ready`.
 */
@Injectable()
export class TaskImproverService {
  private readonly log = new Logger(TaskImproverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SystemSettingsService,
    private readonly jobs: JobsService,
    @Optional() private readonly ai?: AiService,
    @Optional() @Inject(RUN_ARTIFACT_STORE) private readonly artifacts?: RunArtifactStore,
  ) {}

  /** The deployment switch; off answers 404 everywhere. */
  async assertEnabled(): Promise<void> {
    const on = await this.settings
      .getNamespace('taskImprover')
      .then((s) => s.enabled)
      .catch(() => true);
    if (!on || !this.ai) throw new NotFoundException({ code: 'TASK_IMPROVER_OFF', message: 'Improve this task is not available on this deployment' });
  }

  async request(userId: string, orgId: string | null, taskId: string, runIds: string[] | undefined): Promise<{ id: string; status: ImprovementStatus }> {
    await this.assertEnabled();
    const db = this.prisma.forUser({ userId });
    const task = await db.task.findFirst({ where: { id: taskId }, select: { id: true, goal: true } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    let ids: string[];
    if (runIds?.length) {
      const found = await db.run.findMany({ where: { id: { in: runIds }, taskId, status: { in: [...TERMINAL_RUN_STATUSES] } }, select: { id: true }, orderBy: { createdAt: 'desc' } });
      if (found.length !== new Set(runIds).size) throw new BadRequestException({ code: 'INVALID_RUNS', message: 'Every run must be a finished run of this task' });
      ids = found.map((r) => r.id);
    } else {
      ids = (await db.run.findMany({ where: { taskId, status: { in: [...TERMINAL_RUN_STATUSES] }, trigger: { not: 'benchmark' } }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: DEFAULT_RUNS })).map((r) => r.id);
      if (ids.length === 0) throw new BadRequestException({ code: 'NO_FINISHED_RUNS', message: 'This task has no finished run to learn from yet' });
    }
    const busy = await db.taskImprovement.findFirst({ where: { taskId, status: { in: ['queued', 'running'] } }, select: { id: true } });
    if (busy) throw new ConflictException({ code: 'IMPROVEMENT_RUNNING', message: 'A proposal for this task is being made', details: { id: busy.id } });
    const today = await db.taskImprovement.count({ where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
    if (today >= DAILY_LIMIT) throw new HttpException({ code: 'IMPROVEMENT_LIMIT', message: `At most ${DAILY_LIMIT} proposals a day` }, HttpStatus.TOO_MANY_REQUESTS);
    const row = await db.taskImprovement.create({ data: { userId, taskId, runIds: ids, goalBefore: task.goal, status: 'queued' } });
    await enqueueTaskImprovement(this.jobs, { improvementId: row.id, userId, orgId });
    return { id: row.id, status: 'queued' };
  }

  async list(userId: string, taskId: string): Promise<ImprovementView[]> {
    await this.assertEnabled();
    const db = this.prisma.forUser({ userId });
    if (!(await db.task.findFirst({ where: { id: taskId }, select: { id: true } }))) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    const rows = await db.taskImprovement.findMany({ where: { taskId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((r) => improvementView(r, false));
  }

  async get(userId: string, id: string): Promise<ImprovementView> {
    await this.assertEnabled();
    return improvementView(await this.own(userId, id));
  }

  async dismiss(userId: string, id: string): Promise<ImprovementView> {
    await this.assertEnabled();
    const r = await this.own(userId, id);
    if (r.status !== 'ready') throw new ConflictException({ code: 'IMPROVEMENT_NOT_READY', message: `This proposal is ${r.status}` });
    const db = this.prisma.forUser({ userId });
    return improvementView(await db.taskImprovement.update({ where: { id }, data: { status: 'dismissed', decidedAt: new Date() } }));
  }

  /**
   * Records that the owner saved a goal through the task form. It never writes to `tasks`: it is refused unless the task's goal now is
   * the one given (the save happened first).
   */
  async applied(userId: string, id: string, goal: string): Promise<ImprovementView> {
    await this.assertEnabled();
    const r = await this.own(userId, id);
    if (r.status !== 'ready') throw new ConflictException({ code: 'IMPROVEMENT_NOT_READY', message: `This proposal is ${r.status}` });
    const db = this.prisma.forUser({ userId });
    const task = await db.task.findFirst({ where: { id: r.taskId }, select: { goal: true } });
    if (!task || task.goal !== goal) throw new ConflictException({ code: 'GOAL_NOT_SAVED', message: "Save the goal in the task form first: the task's goal is not the one given" });
    return improvementView(await db.taskImprovement.update({ where: { id }, data: { status: 'applied', appliedGoal: goal, decidedAt: new Date() } }));
  }

  private async own(userId: string, id: string): Promise<TaskImprovement> {
    const r = await this.prisma.forUser({ userId }).taskImprovement.findFirst({ where: { id } });
    if (!r) throw new NotFoundException({ code: 'IMPROVEMENT_NOT_FOUND', message: 'Proposal not found' });
    return r;
  }

  /** The job (`task_improver.propose`): reads the runs, asks the model once (twice when the first answer is refused), stores the result. */
  async propose(improvementId: string, userId: string, orgId: string | null, jobId?: string): Promise<'ready' | 'failed' | 'skipped'> {
    const db = this.prisma.forUser({ userId });
    const claimed = await db.taskImprovement.updateMany({ where: { id: improvementId, status: 'queued' }, data: { status: 'running' } });
    if (claimed.count === 0) return 'skipped';
    const row = await db.taskImprovement.findFirstOrThrow({ where: { id: improvementId } });
    const fail = async (error: string) => {
      await db.taskImprovement.update({ where: { id: improvementId }, data: { status: 'failed', error: error.slice(0, 500), finishedAt: new Date() } });
      return 'failed' as const;
    };
    if (!this.ai) return fail('No AI model is available on this deployment.');
    try {
      const task = await db.task.findFirst({ where: { id: row.taskId }, select: { name: true, goal: true, parameters: true, allowedDomains: true, confirmRiskyActions: true } });
      if (!task) return fail('The task is gone.');
      const { runs, ctx, images } = await this.load(userId, row.runIds, task.goal, task.allowedDomains);
      const params = (Array.isArray(task.parameters) ? task.parameters : []) as { key?: string; label?: string; type?: string }[];
      const text = buildImproverInput(
        { name: task.name, goal: task.goal, parameters: params.filter((p) => p.key).map((p) => ({ key: String(p.key), label: String(p.label ?? p.key), type: String(p.type ?? 'text') })), allowedDomains: task.allowedDomains, confirmRiskyActions: task.confirmRiskyActions },
        runs,
        (t) => maskSensitive(t).text,
      );
      const call = (extra: string) =>
        this.ai!.forUser(userId, { feature: TASK_IMPROVER_FEATURE_ID, ...(orgId ? { orgId } : {}), ...(jobId ? { jobId } : {}) } as never).respondStructured({
          instructions: TASK_IMPROVER_INSTRUCTIONS,
          input: images.length
            ? ([{ type: 'message', role: 'user', content: [{ type: 'text', text: text + extra }, ...images.map((url) => ({ type: 'image', url, detail: 'low' }))] }] as never)
            : text + extra,
          schema: answerShape,
          schemaName: 'proposal',
        } as never);
      let tokensIn = 0;
      let tokensOut = 0;
      let model: string | null = null;
      let reason: string | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = (await call(reason ? `\n\nYour previous answer was refused: ${reason}. Answer again, following every rule.` : '')) as { parsed: unknown; usage?: { inputTokens?: number; outputTokens?: number }; model?: string };
        tokensIn += res.usage?.inputTokens ?? 0;
        tokensOut += res.usage?.outputTokens ?? 0;
        model = res.model ?? model;
        const strict = proposalAnswerSchema.safeParse(normalize(res.parsed));
        if (!strict.success) {
          reason = 'it does not fit the required shape or limits';
          continue;
        }
        const v = validateProposal(strict.data, ctx);
        if (!v.ok) {
          reason = v.reason ?? 'it broke a rule';
          continue;
        }
        await db.taskImprovement.update({
          where: { id: improvementId },
          data: {
            status: 'ready',
            proposedGoal: v.proposedGoal,
            summary: maskSensitive(strict.data.summary).text.slice(0, 1000),
            changes: v.changes as unknown as Prisma.InputJsonValue,
            siteFacts: v.siteFacts as unknown as Prisma.InputJsonValue,
            confidence: strict.data.confidence,
            model,
            usedImages: images.length > 0,
            inputTokens: tokensIn,
            outputTokens: tokensOut,
            finishedAt: new Date(),
          },
        });
        return 'ready';
      }
      await db.taskImprovement.update({ where: { id: improvementId }, data: { model, inputTokens: tokensIn, outputTokens: tokensOut, usedImages: images.length > 0 } });
      return fail(`The proposal was refused twice: ${reason ?? 'it broke a rule'}.`);
    } catch (e) {
      if (e instanceof ProposalRefused) return fail(e.message);
      if (e instanceof AiError) {
        this.log.warn(`proposal ${improvementId}: the model call failed (${e.code}) ${aiErrorLogDetails(e)}`.trimEnd());
        return fail(/^No model selected/.test(e.message) ? 'No AI model is selected. Choose your default model under Settings → AI Keys, then ask again.' : `The AI could not answer (${e.code}). Try again in a moment.`);
      }
      this.log.warn(`proposal ${improvementId}: failed: ${e instanceof Error ? e.message : String(e)}`);
      return fail('The proposal could not be made. Try again.');
    }
  }

  /** The runs as the model reads them, the validator's facts, and up to 6 masked trace screenshots (never a recording). */
  private async load(userId: string, runIds: string[], goal: string, allowedDomains: string[]): Promise<{ runs: ImproverRun[]; ctx: ValidationContext; images: string[] }> {
    const db = this.prisma.forUser({ userId });
    const rows = await db.run.findMany({
      where: { id: { in: runIds } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, trigger: true, stopReason: true, stepCount: true, modelCalls: true, inputTokens: true, outputTokens: true, costUsd: true, activeMs: true, result: true, inputs: true, startedAt: true },
    });
    const runs: ImproverRun[] = [];
    const seqs = new Map<string, Set<number>>();
    const values: string[] = [];
    const sites = new Set<string>();
    const shots: { key: string; rank: number }[] = [];
    for (const r of rows) {
      // Steps by run id, once the run is known to be the owner's.
      const steps = await this.prisma.runStep.findMany({
        where: { runId: r.id },
        orderBy: { seq: 'asc' },
        take: 2_000,
        select: { seq: true, kind: true, action: true, args: true, ok: true, summary: true, phase: true, createdAt: true, reasoning: true, screenshotKey: true, screenshotMoment: true, question: { select: { kind: true, prompt: true, status: true } } },
      });
      const inputs = inputValues(r.inputs);
      values.push(...Object.values(inputs));
      seqs.set(r.id, new Set(steps.map((s) => s.seq)));
      for (const s of steps) {
        const url = (s.args as { url?: unknown } | null)?.url;
        if (typeof url === 'string') {
          try {
            sites.add(registrableDomain(new URL(url).hostname));
          } catch {
            // Not a URL: nothing to record.
          }
        }
        if (s.screenshotKey) shots.push({ key: s.screenshotKey, rank: s.screenshotMoment === 'failure' ? 0 : s.screenshotMoment === 'question' ? 1 : s.screenshotMoment === 'final' ? 2 : 3 });
      }
      const findings = diagnoseRun({ startedAt: r.startedAt, budget: null }, steps as DiagnosticStep[]).map(maskFinding);
      runs.push({
        id: r.id,
        status: r.status,
        trigger: r.trigger,
        stopReason: r.stopReason,
        stepCount: r.stepCount,
        modelCalls: r.modelCalls,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: Number(r.costUsd),
        activeMs: r.activeMs,
        result: r.result,
        inputs,
        findings,
        steps: steps.map(
          (s): ImproverStep => ({
            seq: s.seq,
            kind: s.kind,
            action: s.action,
            args: s.args,
            ok: s.ok,
            summary: s.summary,
            reasoning: s.reasoning,
            // A question's prompt and outcome; never an answer value.
            question: s.question ? { kind: s.question.kind, prompt: maskSensitive(s.question.prompt).text, outcome: s.question.status } : null,
          }),
        ),
      });
    }
    const images: string[] = [];
    if (this.artifacts) {
      for (const shot of shots.sort((a, b) => a.rank - b.rank)) {
        if (images.length >= MAX_IMAGES) break;
        const found = await this.artifacts.get(shot.key).catch(() => null);
        if (found) images.push(`data:${found.contentType};base64,${found.bytes.toString('base64')}`);
      }
    }
    const ctx: ValidationContext = {
      goal,
      allowedDomains,
      runs: seqs,
      runValues: values,
      visitedSites: [...sites],
      checkSiteFact: (f: ProposalSiteFact) => validateSiteFact({ site: f.site, kind: f.kind, text: f.text, source: 'agent_proposed' }, { secretCheck: consoleSecretCheck }).map((v) => v.message),
    };
    return { runs, ctx, images };
  }
}

/** A run's non-sensitive input values by parameter key (sensitive ones are never stored). */
export function inputValues(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const values = (raw as { values?: unknown } | null)?.values;
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      const value = typeof v === 'object' && v !== null && 'value' in v ? (v as { value: unknown }).value : v;
      if (typeof value === 'string' || typeof value === 'number') out[k] = String(value);
    }
  }
  return out;
}

/** The loose answer as the strict schema reads it: a null `finding` becomes absent. */
function normalize(parsed: unknown): unknown {
  const a = parsed as ProposalAnswer & { changes?: { evidence?: { finding?: string | null }[] }[] };
  if (!a || typeof a !== 'object' || !Array.isArray(a.changes)) return parsed;
  return { ...a, changes: a.changes.map((c) => ({ ...c, evidence: (c.evidence ?? []).map((e) => (e.finding == null ? { runId: (e as { runId: string }).runId, seqFrom: (e as { seqFrom: number }).seqFrom, seqTo: (e as { seqTo: number }).seqTo } : e)) })) };
}
