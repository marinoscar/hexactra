import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { Prisma, type Question, type Task } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { enqueueGoalRun, type GoalRunReason } from '../runner/goal-run.enqueue';
import { maskSensitive } from '../tasks/mask';
import { RunNotifier } from '../tasks/run-notifier';
import { TaskSchedulesService } from '../tasks/task-schedules.service';
import { TasksService } from '../tasks/tasks.service';
import { MEMORY_VALUE_RESOLVER, checkValues, formFields, keyInputs, renderRunGoal, resolveInputs, type FormField, type MemoryValueResolver } from '../tasks/task-params';
import { readParameters, readRunInputs, type InputSource, type RunInputs, type TaskParameter } from '../tasks/task-params.schemas';
import { QuestionEvents } from './question-events';
import { QUESTION_TIMEOUT } from './questions.contract';

/** Why a run waiting for its values ended (#552). */
export const VALUES_NOT_PROVIDED = 'The values were not provided.';

/** How long the form of a task run's missing values stays open: the longest a question may (24 h). */
export const FORM_TIMEOUT_MS = QUESTION_TIMEOUT.maxMs;

/** Who starts the run. */
export interface StartActor {
  id: string;
  activeOrgId?: string | null;
}

export interface StartTaskRunOptions {
  /** Values the caller gave, by key or display name (`POST /tasks/:id/runs`, MCP `task_run`, chat `run_task`, the CLI). */
  inputs?: Record<string, string | number> | null;
  /** A schedule's preset values, by key. */
  presets?: Record<string, string> | null;
  /** The run's columns besides the task's (trigger, origin, client, policy, conversation). */
  data: Omit<Prisma.RunUncheckedCreateInput, 'userId' | 'taskId' | 'goal' | 'profile' | 'hostId' | 'hostFallback' | 'inputs' | 'status'>;
  /** Why the run job is queued. */
  reason: GoalRunReason;
  /** The owner's time zone (today and tomorrow); defaults to their profile zone. */
  timeZone?: string | null;
}

export interface StartedTaskRun<R> {
  run: R;
  /** The run waits for its missing values: the `form` question that asks for them. */
  formQuestionId: string | null;
}

/**
 * Starting a saved task (E36.6, #552): its parameters are resolved from the
 * caller's inputs, a schedule's presets, the defaults and the owner's memories.
 * With every required value known, the goal is filled in and the run queued.
 * Otherwise the run waits (`waiting_human`) on ONE `form` question for every
 * missing value, with no browser session and no model call until it is
 * answered; the answer is checked with the parameter rules, fills the goal and
 * queues the run. A sensitive parameter is never part of either: the runner
 * asks for it as a secret once the browser is open.
 */
@Injectable()
export class TaskRunStarter {
  private readonly log = new Logger(TaskRunStarter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly events: QuestionEvents,
    private readonly tasks: TasksService,
    private readonly taskSchedules: TaskSchedulesService,
    @Optional() private readonly notifier?: RunNotifier,
    @Optional() @Inject(MEMORY_VALUE_RESOLVER) private readonly memories?: MemoryValueResolver,
  ) {}

  private async zone(userId: string, given?: string | null): Promise<string> {
    if (given) return given;
    return (await this.taskSchedules.defaultTimezone(userId).catch(() => ({ timezone: 'UTC' }))).timezone;
  }

  /** Check a caller's inputs against a task (400 `UNKNOWN_INPUT`, `SENSITIVE_INPUT`, `INVALID_INPUT`) without starting anything. */
  async checkInputs(userId: string, task: Pick<Task, 'parameters'>, inputs: Record<string, string | number> | null | undefined, timeZone?: string | null): Promise<Record<string, string>> {
    const params = readParameters(task.parameters);
    const keyed = keyInputs(params, inputs);
    return checkValues(params, keyed, { timeZone: await this.zone(userId, timeZone) });
  }

  /** Start a run of `task`. Inputs are checked before anything is written. */
  async start(actor: StartActor, task: Task, opts: StartTaskRunOptions) {
    const userId = actor.id;
    const params = readParameters(task.parameters);
    const timeZone = await this.zone(userId, opts.timeZone);
    const given = checkValues(params, keyInputs(params, opts.inputs), { timeZone });
    const resolved = await resolveInputs(userId, params, given, { presets: opts.presets, presetSource: 'schedule', resolver: this.memories ?? null, timeZone });
    const inputs: RunInputs | null = params.length ? { values: resolved.values, sensitive: resolved.sensitive } : null;
    const base = {
      ...opts.data,
      userId,
      taskId: task.id,
      profile: task.profile,
      hostId: task.hostId,
      hostFallback: task.hostFallback,
      ...(inputs ? { inputs: inputs as unknown as Prisma.InputJsonValue } : {}),
    };
    const db = this.prisma.forUser({ userId });
    if (resolved.missing.length === 0) {
      const run = await db.run.create({ data: { ...base, goal: params.length ? renderRunGoal(task.goal, params, resolved.values) : task.goal }, omit: { transcript: true } });
      await enqueueGoalRun(this.jobs, { runId: run.id, userId, orgId: actor.activeOrgId ?? null }, opts.reason);
      return { run, formQuestionId: null } satisfies StartedTaskRun<typeof run>;
    }
    // Missing values: the run waits on one form, before any browser or model (#552).
    const now = new Date();
    const expiresAt = new Date(now.getTime() + FORM_TIMEOUT_MS);
    const { run, question } = await this.prisma.$transaction(async (tx) => {
      const r = await tx.run.create({ data: { ...base, goal: task.goal, status: 'waiting_human', waitingSince: now }, omit: { transcript: true } });
      const q = await tx.question.create({
        data: {
          ownerUserId: userId,
          askedBy: `run:${r.id}`,
          runId: r.id,
          input: 'form',
          kind: 'other',
          prompt: `A few details to start "${task.name.slice(0, 200)}": ${resolved.missing.map((p) => p.label).join(', ')}`.slice(0, 2000),
          fields: formFields(resolved.missing) as unknown as Prisma.InputJsonValue,
          ...(opts.data.clientId !== undefined || opts.data.clientName !== undefined ? { clientId: (opts.data.clientId as string | null) ?? null, clientName: (opts.data.clientName as string | null) ?? null, grantId: (opts.data.grantId as string | null) ?? null } : {}),
          expiresAt,
        },
      });
      return { run: r, question: q };
    });
    this.log.log(`run ${run.id}: waiting for ${resolved.missing.length} value(s) before it starts`);
    await this.events.emit({ type: 'question.asked', questionId: question.id, ownerUserId: userId, runId: run.id, input: 'form', kind: 'other', status: 'pending' });
    await this.tasks.events?.publish({ type: 'run.status', runId: run.id, ownerUserId: userId, status: 'waiting_human' });
    await this.notifier?.needsYou(userId, { ...run, handoffId: null }, question.prompt, 'other', 'form', expiresAt).catch((e: unknown) => this.log.warn(`run ${run.id}: could not notify: ${e instanceof Error ? e.message : String(e)}`));
    return { run, formQuestionId: question.id } satisfies StartedTaskRun<typeof run>;
  }

  /**
   * Check a form's answer against its fields (before the answer is recorded):
   * every key a field, every required field given, every value valid.
   * 400 `INVALID_INPUT` with `details.issues` per key.
   */
  async checkForm(userId: string, q: Pick<Question, 'fields' | 'runId'>, raw: Record<string, string>): Promise<Record<string, string>> {
    const fields = ((q.fields as unknown as FormField[] | null) ?? []).map((f) => ({ ...f, required: f.required !== false })) as TaskParameter[];
    const issues: { key: string; message: string }[] = [];
    const known = new Set(fields.map((f) => f.key));
    for (const k of Object.keys(raw)) if (!known.has(k)) issues.push({ key: k, message: 'Not a field of this form' });
    const present: Record<string, string> = {};
    for (const f of fields) {
      const v = raw[f.key];
      if (v === undefined || String(v).trim() === '') {
        if (f.required) issues.push({ key: f.key, message: 'Enter a value' });
      } else present[f.key] = v;
    }
    if (issues.length) throw new BadRequestException({ code: 'INVALID_INPUT', message: issues.map((i) => `${i.key}: ${i.message}`).join('; '), details: { issues } });
    const timeZone = await this.zone(userId);
    return checkValues(fields, present, { timeZone });
  }

  /** The values as a stored answer shows them: masked (#538). */
  maskedFields(values: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, maskSensitive(v).text]));
  }

  /** The form was answered (and recorded): fill the goal and queue the run. A run that moved on meanwhile is left alone. */
  async complete(actor: StartActor, q: Pick<Question, 'runId' | 'fields'>, values: Record<string, string>): Promise<void> {
    if (!q.runId) return;
    const db = this.prisma.forUser({ userId: actor.id });
    const run = await db.run.findFirst({ where: { id: q.runId }, select: { id: true, status: true, handoffId: true, goal: true, inputs: true, task: { select: { goal: true, parameters: true } } } });
    if (!run || run.status !== 'waiting_human' || run.handoffId) return;
    const prior = readRunInputs(run.inputs) ?? { values: {}, sensitive: [] };
    const fields = (q.fields as unknown as FormField[] | null) ?? [];
    const asked: RunInputs['values'] = {};
    for (const [k, v] of Object.entries(values)) asked[k] = { value: v, source: 'asked' satisfies InputSource, label: fields.find((f) => f.key === k)?.label ?? k };
    const all = { ...prior.values, ...asked };
    // The task's definitions when it still exists; else the form's fields (the task was deleted while it waited).
    const params = run.task ? readParameters(run.task.parameters) : (fields as TaskParameter[]);
    const goal = renderRunGoal(run.task?.goal ?? run.goal, params, all);
    await db.run.updateMany({ where: { id: run.id, status: 'waiting_human' }, data: { goal, inputs: { values: all, sensitive: prior.sensitive } as unknown as Prisma.InputJsonValue } });
    try {
      await this.tasks.transition(actor.id, run.id, 'queued');
    } catch (e) {
      this.log.warn(`run ${run.id}: not queued after its form: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    await enqueueGoalRun(this.jobs, { runId: run.id, userId: actor.id, orgId: actor.activeOrgId ?? null }, 'run_started');
  }

  /** The form was declined or expired: the run ends `cancelled`, "The values were not provided." */
  async abandon(ownerUserId: string, runId: string | null): Promise<void> {
    if (!runId) return;
    const run = await this.prisma.forUser({ userId: ownerUserId }).run.findFirst({ where: { id: runId }, select: { status: true, handoffId: true } });
    if (!run || run.status !== 'waiting_human' || run.handoffId) return;
    await this.tasks.transition(ownerUserId, runId, 'cancelled', { error: VALUES_NOT_PROVIDED, stopReason: 'cancelled' }).catch((e: unknown) => this.log.warn(`run ${runId}: not cancelled after its form: ${e instanceof Error ? e.message : String(e)}`));
  }
}
