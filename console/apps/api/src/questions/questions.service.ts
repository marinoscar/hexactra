import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { Prisma, type Question } from '@prisma/client';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { PrismaService } from '../prisma/prisma.service';
import { enqueueGoalRun } from '../runner/goal-run.enqueue';
import { FabricSession, handoffOutcome, type CreatedHandoff, type FabricHandoff } from '../runner/fabric-session';
import { CHANNEL_RULES, channelId, mayAnswerOn } from './channels/channel-rules';
import { QuestionEvents, type QuestionEventType } from './question-events';
import { TaskRunStarter } from './task-run-starter';
import type { FormField } from '../tasks/task-params';
import {
  holdsSecret,
  AnswerInvalidError,
  QUESTION_INPUTS,
  QUESTION_KINDS,
  QUESTION_TIMEOUT,
  normalizeOptions,
  questionSpecSchema,
  toResponse,
  validateAnswer,
  type QuestionAnswerInput,
  type QuestionGate,
  type QuestionConstraints,
  type QuestionInputType,
  type QuestionOption,
  type QuestionResponse,
  type QuestionSpec,
  type QuestionStatusType,
} from './questions.contract';

/** The longest a `GET /api/questions/:id?waitMs=` holds the request. */
export const MAX_WAIT_MS = 30_000;
/** How often a waiting request re-reads the row, in case an event was missed. */
const WAIT_RECHECK_MS = 2_000;

/** Who acts: the signed-in user (an agent's token acts as its user). */
export interface QuestionActor {
  id: string;
  activeOrgId?: string | null;
}

/** A question as the API returns it. Never a secret value. */
export interface QuestionView {
  id: string;
  askedBy: string;
  runId: string | null;
  handoffId: string | null;
  /** True when it belongs to a browser session (it mirrors a fabric handoff). */
  browserBound: boolean;
  input: QuestionInputType;
  kind: string;
  prompt: string;
  options: QuestionOption[] | null;
  constraints: QuestionConstraints | null;
  confirmLabel: string | null;
  denyLabel: string | null;
  risk: 'low' | 'high' | null;
  /** credentials and secret: the site's "remember me" option, in the page's words (#527). */
  rememberLabel: string | null;
  /** form (#552): the missing parameters of a task run, asked at once before it starts. */
  fields: FormField[] | null;
  /** The commitment the server's confirmation gate stopped (#550), set by the server only; null otherwise. */
  gate: QuestionGate | null;
  status: QuestionStatusType;
  response: QuestionResponse | null;
  pageTitle: string | null;
  viewerUrl: string | null;
  createdAt: string;
  expiresAt: string;
  answeredAt: string | null;
  /** The AI app that asked (#464); null when no app did. */
  client: { id: string | null; name: string | null; verified: boolean } | null;
}

/** The client columns a question stores (#464). */
export interface QuestionClient {
  clientId: string | null;
  clientName: string | null;
  grantId: string | null;
}

function clientData(c: QuestionClient | null | undefined) {
  return c ? { clientId: c.clientId, clientName: c.clientName, grantId: c.grantId } : {};
}

export function toQuestionView(q: Question): QuestionView {
  return {
    id: q.id,
    askedBy: q.askedBy,
    runId: q.runId,
    handoffId: q.handoffId,
    browserBound: Boolean(q.handoffId || q.fabricSessionId),
    input: q.input as QuestionInputType,
    kind: q.kind,
    prompt: q.prompt,
    options: (q.options as unknown as QuestionOption[] | null) ?? null,
    constraints: (q.constraints as unknown as QuestionConstraints | null) ?? null,
    confirmLabel: q.confirmLabel,
    denyLabel: q.denyLabel,
    risk: (q.risk as 'low' | 'high' | null) ?? null,
    rememberLabel: q.rememberLabel,
    fields: (q.fields as unknown as FormField[] | null) ?? null,
    gate: (q.gate as unknown as QuestionGate | null) ?? null,
    status: q.status,
    response: (q.response as unknown as QuestionResponse | null) ?? null,
    pageTitle: q.pageTitle,
    viewerUrl: q.viewerUrl,
    createdAt: q.createdAt.toISOString(),
    expiresAt: q.expiresAt.toISOString(),
    answeredAt: q.answeredAt?.toISOString() ?? null,
    client: q.clientId || q.clientName ? { id: q.clientId, name: q.clientName, verified: q.clientId !== null } : null,
  };
}

/** A fabric handoff's input or kind, mapped onto the console's (unknown values fall back). */
function inputOf(v: string): QuestionInputType {
  return (QUESTION_INPUTS as readonly string[]).includes(v) ? (v as QuestionInputType) : 'none';
}
function kindOf(v: string): string {
  return (QUESTION_KINDS as readonly string[]).includes(v) ? v : 'other';
}

/**
 * The question broker (#288): every question an agent asks a person, with
 * one answer path for every channel. A browser-bound question mirrors a
 * fabric handoff and is answered on the fabric too (with the console's
 * service token, as `user:<id>`); a free-standing one lives only here. The
 * first answer wins (a conditional update on `status = 'pending'`). A secret
 * is forwarded to the fabric (single use) and never stored, returned or
 * logged here: the row records `valueWithheld: true`.
 */
@Injectable()
export class QuestionsService {
  private readonly log = new Logger(QuestionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fabric: FabricClient,
    private readonly jobs: JobsService,
    private readonly events: QuestionEvents,
    @Optional() private readonly starter?: TaskRunStarter,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  private async emit(type: QuestionEventType, q: Question, channel?: string | null): Promise<void> {
    await this.events.emit({ type, questionId: q.id, ownerUserId: q.ownerUserId, runId: q.runId, input: q.input, kind: q.kind, status: q.status, ...(channel !== undefined ? { channel } : {}) });
  }

  /** Validates a question (camelCase contract); a 400 names what is wrong. */
  parseSpec(raw: unknown): QuestionSpec {
    const parsed = questionSpecSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({ code: 'INVALID_QUESTION', message: parsed.error.issues.map((i) => `${i.path.join('.') || 'question'}: ${i.message}`).join('; ') });
    }
    return parsed.data;
  }

  /**
   * Ask a question. Free-standing (no browser) for every input but `secret`:
   * a secret goes to a browser session through the fabric, single use, so it
   * needs `runId` or `fabricSessionId` (browser-bound questions are created
   * by `mirrorHandoff`).
   */
  async create(owner: QuestionActor, spec: QuestionSpec, opts: { askedBy: string; runId?: string | null; fabricSessionId?: string | null; client?: QuestionClient | null }): Promise<QuestionView> {
    if (holdsSecret(spec.input) && !opts.runId && !opts.fabricSessionId) {
      throw new BadRequestException({ code: 'SECRET_NEEDS_BROWSER', message: 'A secret or sign-in question must belong to a browser session (it is typed there, never stored)' });
    }
    if (opts.runId) {
      const run = await this.db(owner.id).run.findFirst({ where: { id: opts.runId }, select: { id: true } });
      if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    }
    const q = await this.db(owner.id).question.create({
      data: {
        ownerUserId: owner.id,
        askedBy: opts.askedBy.slice(0, 200),
        runId: opts.runId ?? null,
        fabricSessionId: opts.fabricSessionId ?? null,
        ...clientData(opts.client),
        ...this.specData(spec),
        expiresAt: new Date(Date.now() + spec.timeoutMs),
      },
    });
    await this.emit('question.asked', q);
    return toQuestionView(q);
  }

  private specData(spec: QuestionSpec) {
    return {
      input: spec.input,
      kind: spec.kind,
      prompt: spec.prompt,
      options: spec.options ? (spec.options as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      constraints: spec.constraints ? (spec.constraints as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      confirmLabel: spec.confirmLabel,
      denyLabel: spec.denyLabel,
      risk: spec.risk,
      rememberLabel: spec.rememberLabel,
      gate: spec.gate ? (spec.gate as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    };
  }

  /**
   * The console page showing the desktop of the host a fabric session runs
   * on, when that host shares one (#343): where a person solves a CAPTCHA or
   * takes over. Null when the host has no desktop or cannot be found.
   */
  async desktopLink(fabricSessionId: string | null): Promise<string | null> {
    if (!fabricSessionId) return null;
    try {
      const s = await this.fabric.request<{ host_id?: string }>('GET', `/v1/sessions/${encodeURIComponent(fabricSessionId)}`);
      if (!s.host_id) return null;
      const hosts = await this.fabric.hosts();
      if (!hosts.find((x) => x.id === s.host_id)?.desktop) return null;
      return `${(process.env.APP_URL ?? '').replace(/\/+$/, '')}/fleet/hosts/${s.host_id}/desktop`;
    } catch {
      return null;
    }
  }

  /** Record the question a fabric handoff asks (the goal runner's and external agents' handoffs). */
  async mirrorHandoff(owner: QuestionActor, spec: QuestionSpec, h: CreatedHandoff, opts: { askedBy: string; runId: string | null; fabricSessionId: string | null; client?: QuestionClient | null }): Promise<QuestionView> {
    const viewerUrl = h.viewerUrl && h.viewerUrl.length <= 2000 ? h.viewerUrl : await this.desktopLink(opts.fabricSessionId);
    const q = await this.db(owner.id).question.create({
      data: {
        ownerUserId: owner.id,
        askedBy: opts.askedBy.slice(0, 200),
        runId: opts.runId,
        fabricSessionId: opts.fabricSessionId,
        ...clientData(opts.client),
        handoffId: h.id,
        ...this.specData(spec),
        pageTitle: h.pageTitle?.slice(0, 500) ?? null,
        viewerUrl,
        expiresAt: h.expiresAt ?? new Date(Date.now() + spec.timeoutMs),
      },
    });
    await this.emit('question.asked', q);
    return toQuestionView(q);
  }

  /**
   * The mirrored question of a run's open handoff. A handoff opened before
   * the broker existed (or whose mirror failed) is mirrored from the fabric
   * on first use.
   */
  private async questionForHandoff(userId: string, runId: string, handoffId: string): Promise<Question> {
    const found = await this.db(userId).question.findFirst({ where: { handoffId } });
    if (found) return found;
    let h: FabricHandoff;
    try {
      h = await new FabricSession(this.fabric).getHandoff(handoffId);
    } catch {
      throw new ConflictException({ code: 'ALREADY_ANSWERED', message: 'This request was already answered or expired' });
    }
    const options = h.choices?.length ? normalizeOptions(h.choices.map((c) => (typeof c === 'string' ? c.slice(0, 100) : c))) : null;
    const expires = h.expires_at ? new Date(h.expires_at) : new Date(Date.now() + QUESTION_TIMEOUT.defaultMs);
    try {
      return await this.db(userId).question.create({
        data: {
          ownerUserId: userId,
          askedBy: `run:${runId}`,
          runId,
          handoffId,
          input: inputOf(h.input),
          kind: kindOf(h.kind),
          prompt: (h.prompt ?? '').slice(0, 2000) || 'The agent needs you.',
          options: options ? (options as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          pageTitle: h.page?.title?.slice(0, 500) ?? null,
          rememberLabel: h.remember?.label?.slice(0, 80) ?? null,
          viewerUrl: h.viewer_url ?? (await this.desktopLink(h.session_id ?? null)),
          status: h.status === 'pending' ? 'pending' : h.status === 'expired' ? 'expired' : handoffOutcome(h) === 'cancelled' ? 'cancelled' : 'answered',
          expiresAt: Number.isNaN(expires.getTime()) ? new Date(Date.now() + QUESTION_TIMEOUT.defaultMs) : expires,
        },
      });
    } catch (e) {
      // Mirrored concurrently by another request.
      const again = await this.db(userId).question.findFirst({ where: { handoffId } });
      if (again) return again;
      throw e;
    }
  }

  async list(userId: string, filter: { status?: QuestionStatusType; runId?: string; limit?: number } = {}): Promise<QuestionView[]> {
    await this.expireDue({ ownerUserId: userId });
    const rows = await this.db(userId).question.findMany({
      where: { ...(filter.status ? { status: filter.status } : {}), ...(filter.runId ? { runId: filter.runId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: filter.limit ?? 50,
    });
    return rows.map(toQuestionView);
  }

  /** The pending questions with their run's goal (the inbox). */
  async pendingWithRuns(userId: string, limit = 100): Promise<(Question & { run: { goal: string; conversationId: string | null } | null })[]> {
    await this.expireDue({ ownerUserId: userId });
    return this.db(userId).question.findMany({
      where: { status: 'pending' },
      include: { run: { select: { goal: true, conversationId: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  private async find(userId: string, id: string): Promise<Question> {
    const q = await this.db(userId).question.findFirst({ where: { id } });
    if (!q) throw new NotFoundException({ code: 'QUESTION_NOT_FOUND', message: 'Question not found' });
    if (q.status === 'pending' && q.expiresAt.getTime() <= Date.now()) {
      await this.expireDue({ id });
      return (await this.db(userId).question.findFirst({ where: { id } }))!;
    }
    return q;
  }

  /**
   * One question. With `waitMs` (at most 30 s), a pending question is held
   * until it is answered, cancelled or expired, or the wait ends: the request
   * never outlives the wait.
   */
  async get(userId: string, id: string, waitMs = 0): Promise<QuestionView> {
    let q = await this.find(userId, id);
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), MAX_WAIT_MS);
    while (q.status === 'pending' && Date.now() < deadline) {
      await this.waitForEvent(id, Math.min(WAIT_RECHECK_MS, deadline - Date.now(), Math.max(1, q.expiresAt.getTime() - Date.now())));
      q = await this.find(userId, id);
    }
    return toQuestionView(q);
  }

  private waitForEvent(id: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      let unsubscribe: () => void = () => undefined;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(finish, Math.max(ms, 1));
      unsubscribe = this.events.subscribe((e) => {
        if (e.questionId === id) finish();
      });
    });
  }

  /**
   * Answer (or decline) a question. Validated against the question; the
   * first answer wins and a later one gets 409. A browser-bound answer is
   * forwarded to the fabric; a run waiting on it is resumed.
   */
  async answer(actor: QuestionActor, id: string, input: QuestionAnswerInput, opts: { channel?: string } = {}): Promise<QuestionView> {
    const q = await this.find(actor.id, id);
    return this.answerQuestion(actor, q, input, opts.channel ?? 'api');
  }

  /** Decline a question: the same as answering it with `outcome: "cancelled"`. */
  async cancel(actor: QuestionActor, id: string, opts: { channel?: string } = {}): Promise<QuestionView> {
    return this.answer(actor, id, { outcome: 'cancelled' }, opts);
  }

  /**
   * Answer the question a run waits on (the inbox and the notification
   * buttons). `expectHandoffId`: refuse unless the run still waits on that
   * handoff (a notification's stale button).
   */
  async answerRun(actor: QuestionActor, runId: string, input: QuestionAnswerInput, opts: { channel?: string; expectHandoffId?: string } = {}): Promise<QuestionView> {
    const run = await this.db(actor.id).run.findFirst({ where: { id: runId }, select: { status: true, handoffId: true } });
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    // A task run waiting for its values (#552) waits on a form, not a handoff.
    if (run.status === 'waiting_human' && !run.handoffId && !opts.expectHandoffId) {
      const form = await this.db(actor.id).question.findFirst({ where: { runId, input: 'form', status: 'pending' }, orderBy: { createdAt: 'desc' } });
      if (form) return this.answerQuestion(actor, form, input, opts.channel ?? 'inbox');
    }
    if (run.status !== 'waiting_human' || !run.handoffId || (opts.expectHandoffId && run.handoffId !== opts.expectHandoffId)) {
      throw new ConflictException({ code: 'NOT_WAITING', message: 'This run is not waiting for you' });
    }
    const q = await this.questionForHandoff(actor.id, runId, run.handoffId);
    return this.answerQuestion(actor, q, input, opts.channel ?? 'inbox');
  }

  private async answerQuestion(actor: QuestionActor, q: Question, input: QuestionAnswerInput, channel: string): Promise<QuestionView> {
    if (q.status !== 'pending') {
      throw new ConflictException({ code: q.status === 'expired' ? 'QUESTION_EXPIRED' : 'ALREADY_ANSWERED', message: q.status === 'expired' ? 'This question expired' : 'This question was already answered' });
    }
    // The channel rules (channels/channel-rules.ts): a channel that does not sign the person in never sends a secret or approves a high-risk confirm.
    if (!mayAnswerOn(channel, { input: q.input, risk: q.risk, fields: (q.fields as unknown as FormField[] | null) ?? null }, input.outcome ?? 'completed')) {
      const where = CHANNEL_RULES[channelId(channel)]?.label ?? channel;
      throw new ForbiddenException({
        code: 'CHANNEL_NOT_ALLOWED',
        message: `${q.input === 'credentials' ? 'A sign-in' : q.input === 'secret' ? 'A code or password' : 'A high-risk confirmation'} cannot be answered from ${where}: answer it in the Hexactra inbox, signed in`,
      });
    }
    let answer;
    try {
      answer = validateAnswer(
        { input: q.input as QuestionInputType, options: (q.options as unknown as QuestionOption[] | null) ?? null, constraints: (q.constraints as unknown as QuestionConstraints | null) ?? null, rememberLabel: q.rememberLabel },
        input,
      );
    } catch (e) {
      if (e instanceof AnswerInvalidError) throw new BadRequestException({ code: 'INVALID_ANSWER', message: e.message });
      throw e;
    }
    // A form's values are checked with the task's parameter rules before the answer is recorded (#552).
    let formValues: Record<string, string> | null = null;
    if (q.input === 'form' && answer.outcome === 'completed') {
      if (!this.starter) throw new BadRequestException({ code: 'INVALID_ANSWER', message: 'Forms cannot be answered here' });
      formValues = await this.starter.checkForm(actor.id, q, answer.fields ?? {});
      answer = { ...answer, fields: this.starter.maskedFields(formValues) };
    }
    const now = new Date();
    const by = `user:${actor.id}`;
    const response = toResponse(q.input as QuestionInputType, answer, { channel, by, answeredAt: now });
    const status = answer.outcome === 'completed' ? 'answered' : 'cancelled';
    const db = this.db(actor.id);
    // First answer wins: only a still-pending, unexpired question is claimed.
    const claimed = await db.question.updateMany({
      where: { id: q.id, status: 'pending', expiresAt: { gt: now } },
      data: { status, response: response as unknown as Prisma.InputJsonValue, answeredByUserId: actor.id, answeredChannel: channel, answeredAt: now },
    });
    if (claimed.count === 0) {
      const fresh = await this.find(actor.id, q.id);
      throw new ConflictException({ code: fresh.status === 'expired' ? 'QUESTION_EXPIRED' : 'ALREADY_ANSWERED', message: fresh.status === 'expired' ? 'This question expired' : 'This question was already answered' });
    }

    if (q.handoffId) {
      const session = new FabricSession(this.fabric);
      try {
        // The secret (if any) travels in this call only: never stored or logged.
        await session.respond(q.handoffId, { outcome: answer.outcome, value: answer.value, values: answer.values, secret: answer.secret, remember: answer.remember, channel, answeredBy: by });
      } catch (e) {
        const release = () =>
          db.question.updateMany({
            where: { id: q.id, status, answeredAt: now },
            data: { status: 'pending', response: Prisma.DbNull, answeredByUserId: null, answeredChannel: null, answeredAt: null },
          });
        if (e instanceof FabricError && (e.status === 404 || e.status === 409)) {
          // Resolved on the fabric already (another channel, or expired): take its state.
          await release();
          const h = await session.getHandoff(q.handoffId).catch(() => null);
          if (h) await this.reconcileHandoff(h);
          else await db.question.updateMany({ where: { id: q.id, status: 'pending' }, data: { status: 'expired' } });
          throw new ConflictException({ code: 'ALREADY_ANSWERED', message: 'This request was already answered or expired' });
        }
        await release();
        if (e instanceof FabricError && e.status === 400) throw new BadRequestException({ code: 'INVALID_ANSWER', message: e.message });
        throw e;
      }
    }

    const done = (await db.question.findFirst({ where: { id: q.id } }))!;
    this.log.log(`question ${q.id}: ${status} via ${channel}`);
    await this.emit(status === 'answered' ? 'question.answered' : 'question.cancelled', done, channel);
    if (done.input === 'form') {
      // The run starts with its values, or ends: nothing was provided (#552).
      if (formValues) await this.starter?.complete(actor, done, formValues);
      else await this.starter?.abandon(actor.id, done.runId);
    } else await this.resumeRun(actor, done);
    return toQuestionView(done);
  }

  /** The AI runner resumes its own runs at once; an external agent polls its handoff. */
  private async resumeRun(actor: QuestionActor, q: Question): Promise<void> {
    if (!q.runId || !q.handoffId) return;
    const run = await this.db(actor.id).run.findFirst({ where: { id: q.runId }, select: { status: true, handoffId: true, trigger: true } });
    if (!run || run.trigger === 'external' || run.status !== 'waiting_human' || run.handoffId !== q.handoffId) return;
    await enqueueGoalRun(this.jobs, { runId: q.runId, userId: actor.id, orgId: actor.activeOrgId ?? null }, 'handoff_answered');
  }

  /**
   * Take a resolved fabric handoff's state onto its mirrored question (a
   * channel answered on the fabric directly, or it expired or was cancelled
   * there). A no-op while the handoff is pending or the question is settled.
   */
  async reconcileHandoff(h: FabricHandoff): Promise<void> {
    if (h.status === 'pending') return;
    const q = await this.prisma.question.findFirst({ where: { handoffId: h.id, status: 'pending' } });
    if (!q) return;
    const outcome = handoffOutcome(h);
    let data: Prisma.QuestionUpdateManyMutationInput;
    if (h.status === 'expired' || !outcome) data = { status: 'expired' };
    else {
      const at = h.response?.answered_at ? new Date(h.response.answered_at) : h.resolved_at ? new Date(h.resolved_at) : new Date();
      const answeredAt = Number.isNaN(at.getTime()) ? new Date() : at;
      const response: QuestionResponse = {
        outcome,
        ...(h.response?.value !== undefined && q.input !== 'secret' ? { value: h.response.value } : {}),
        ...(h.response?.values !== undefined ? { values: h.response.values } : {}),
        valueWithheld: holdsSecret(q.input) && outcome === 'completed',
        ...(typeof h.response?.remember === 'boolean' ? { remember: h.response.remember } : {}),
        ...(h.response?.channel ? { channel: h.response.channel } : {}),
        ...(h.response?.by ? { by: h.response.by } : {}),
        answeredAt: answeredAt.toISOString(),
      };
      data = { status: outcome === 'completed' ? 'answered' : 'cancelled', response: response as unknown as Prisma.InputJsonValue, answeredChannel: h.response?.channel?.slice(0, 40) ?? null, answeredAt };
    }
    const { count } = await this.prisma.question.updateMany({ where: { id: q.id, status: 'pending' }, data });
    if (count === 1) {
      const done = (await this.prisma.question.findFirst({ where: { id: q.id } }))!;
      await this.emit(done.status === 'expired' ? 'question.expired' : done.status === 'answered' ? 'question.answered' : 'question.cancelled', done, h.response?.channel ?? null);
    }
  }

  /**
   * Mark overdue pending questions expired (the `questions.expire` job, and
   * lazily on read). With `withdraw` (the job), a browser-bound question's
   * handoff is withdrawn on the fabric too, best effort: the fabric expires
   * it on the same deadline anyway. Returns how many expired.
   */
  async expireDue(scope: { id?: string; ownerUserId?: string } = {}, opts: { limit?: number; withdraw?: boolean } = {}): Promise<number> {
    const now = new Date();
    const due = await this.prisma.question.findMany({
      where: { status: 'pending', expiresAt: { lte: now }, ...scope },
      take: opts.limit ?? 500,
      orderBy: { expiresAt: 'asc' },
    });
    let n = 0;
    for (const q of due) {
      const { count } = await this.prisma.question.updateMany({ where: { id: q.id, status: 'pending', expiresAt: { lte: now } }, data: { status: 'expired' } });
      if (count === 0) continue;
      n += 1;
      if (q.handoffId && opts.withdraw) await new FabricSession(this.fabric).cancelHandoff(q.handoffId);
      await this.emit('question.expired', { ...q, status: 'expired' });
      // A task run's unanswered form (#552): the run ends, the values were not provided.
      if (q.input === 'form') await this.starter?.abandon(q.ownerUserId, q.runId);
    }
    return n;
  }
}
