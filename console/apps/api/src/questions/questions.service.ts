import { recordRequestInChat } from './chat-request-record';
import { questionsSettings } from './request-history.jobs';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { Prisma, type Question } from '@prisma/client';

import { ApprovalRulesService } from '../approvals/approval-rules.service';
import { FabricClient, FabricError } from '../fabric/fabric.client';
import { MemoriesService } from '../memories/memories.service';
import { createMemorySchema, supersedeMemorySchema } from '../memories/memories.schemas';
import { PrismaService } from '../prisma/prisma.service';
import { enqueueGoalRun } from '../runner/goal-run.enqueue';
import { FabricSession, handoffOutcome, type CreatedHandoff, type FabricHandoff } from '../runner/fabric-session';
import { CHANNEL_RULES, channelId, mayAnswerOn, mayRememberOn } from './channels/channel-rules';
import { QuestionEvents, type QuestionEventType } from './question-events';
import { SAVE_ERROR_STATUS, SAVE_TOO_LATE_TEXT, SaveLoginError, type SaveLoginPort } from './save-login.port';
import { TaskRunStarter } from './task-run-starter';
import { captureScan, scanFacts, ScanCaptureError } from './scan-capture';
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
  MEMORY_PROPOSAL_TTL_MS,
  memoryProposalSchema,
  saveLoginProposalSchema,
  type MemoryProposal,
  type SaveLoginProposal,
  type NormalizedAnswer,
  type QuestionAnswerInput,
  type QuestionGate,
  type QuestionRememberable,
  type QuestionAction,
  type QuestionScan,
  type QuestionConstraints,
  type QuestionInputType,
  type QuestionOption,
  type QuestionResponse,
  type QuestionSpec,
  type QuestionStatusType,
} from './questions.contract';

/** Thrown inside the answer's transaction when another answer won: the rule it made is rolled back. */
class LostRace extends Error {}

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
  /** What "Don't ask again" would remember (#555), computed by the server only; null when the question cannot be remembered. */
  rememberable: QuestionRememberable | null;
  /** A call through one of the owner's connections this question asks to approve (E39.7), set by the server only; null otherwise. */
  action: QuestionAction | null;
  status: QuestionStatusType;
  response: QuestionResponse | null;
  pageTitle: string | null;
  viewerUrl: string | null;
  createdAt: string;
  expiresAt: string;
  answeredAt: string | null;
  /** The AI app that asked (#464); null when no app did. */
  client: { id: string | null; name: string | null; verified: boolean } | null;
  /** False for a question no run waits on: a memory proposal (#553). */
  blocking: boolean;
  /** memory (#553): the proposed memory, shown on its card; null for every other input. */
  proposal: MemoryProposal | null;
  /** The chat a memory proposal came from (#553); null otherwise. */
  conversationId: string | null;
  /** save_login (E37.4b): what the card shows (the site, the suggested name, the username, when the fabric stops holding the password); null for every other input. */
  saveLogin: SaveLoginCard | null;
  /** scan (#924): the picture's source and the page's address as the browser reported it when asked; null for every other input. */
  scan: QuestionScan | null;
}

/** A "Save this login?" proposal as the API returns it: the fabric's handoff id and the provider stay on the server. */
export type SaveLoginCard = Pick<SaveLoginProposal, 'site' | 'domain' | 'name' | 'username' | 'valueExpiresAt'>;

export function saveLoginCardOf(q: Pick<Question, 'input' | 'proposal'>): SaveLoginCard | null {
  if (q.input !== 'save_login') return null;
  const p = saveLoginProposalSchema.safeParse(q.proposal ?? {});
  return p.success ? { site: p.data.site, domain: p.data.domain, name: p.data.name, username: p.data.username, valueExpiresAt: p.data.valueExpiresAt } : null;
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
    rememberable: (q.rememberable as unknown as QuestionRememberable | null) ?? null,
    action: (q.action as unknown as QuestionAction | null) ?? null,
    status: q.status,
    response: (q.response as unknown as QuestionResponse | null) ?? null,
    pageTitle: q.pageTitle,
    viewerUrl: q.viewerUrl,
    createdAt: q.createdAt.toISOString(),
    expiresAt: q.expiresAt.toISOString(),
    answeredAt: q.answeredAt?.toISOString() ?? null,
    client: q.clientId || q.clientName ? { id: q.clientId, name: q.clientName, verified: q.clientId !== null } : null,
    blocking: q.blocking,
    proposal: q.input === 'memory' ? ((q.proposal as unknown as MemoryProposal | null) ?? null) : null,
    conversationId: q.conversationId,
    saveLogin: saveLoginCardOf(q),
    scan: q.input === 'scan' ? ((q.scan as unknown as QuestionScan | null) ?? null) : null,
  };
}

/** What a memory proposal's question says wherever it is listed or notified: never the proposal's values (#553). */
export const MEMORY_PROPOSAL_PROMPT = 'The agent suggests remembering something.';

/** What a "Save this login?" question says wherever it is listed or notified: never the site, the name or the username (E37.4b). */
export const SAVE_LOGIN_PROMPT = 'The agent offers to save the sign-in you just typed.';

/** The inputs only the owner answers on a card of their own, signed in, and no AI app or MCP client reads (a memory proposal, a "Save this login?"). */
export const isOwnerCardInput = (input: string): boolean => input === 'memory' || input === 'save_login';

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
  /** Carries out a "Save this login?" answer (E37.4b); set by the secrets module when it is mounted. */
  private saveLogins: SaveLoginPort | null = null;

  /** The secrets module registers how a "Save this login?" answer is carried out. */
  useSaveLogin(port: SaveLoginPort): void {
    this.saveLogins = port;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly fabric: FabricClient,
    private readonly jobs: JobsService,
    private readonly events: QuestionEvents,
    @Optional() private readonly memories?: MemoriesService,
    @Optional() private readonly starter?: TaskRunStarter,
    @Optional() private readonly approvals?: ApprovalRulesService,
    @Optional() private readonly systemSettings?: SystemSettingsService,
  ) {}

  /**
   * How long a question waits (E40.4): the asker's own time, or, when it set none, the administrator's
   * `questions.defaultWaitMinutes` (default 60), within the question limits.
   */
  async resolveTimeoutMs(spec: Pick<QuestionSpec, 'timeoutMs' | 'timeoutDefaulted'>): Promise<number> {
    if (!spec.timeoutDefaulted) return spec.timeoutMs;
    const { defaultWaitMinutes } = await questionsSettings(this.systemSettings, this.log);
    return Math.min(QUESTION_TIMEOUT.maxMs, Math.max(QUESTION_TIMEOUT.minMs, defaultWaitMinutes * 60_000));
  }

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
    if (spec.input === 'scan') {
      // Its picture is the run's browser, captured by the server (#924): a question with no browser has nothing to show.
      throw new BadRequestException({ code: 'SCAN_NEEDS_BROWSER', message: "A scan question must belong to a browser session (its picture is the browser's screen)" });
    }
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
        expiresAt: new Date(Date.now() + (await this.resolveTimeoutMs(spec))),
      },
    });
    await this.emit('question.asked', q);
    await recordRequestInChat(this.prisma, q, this.log);
    return toQuestionView(q);
  }

  /**
   * A memory proposal (#553): a question no run waits on, answered only on the
   * owner's signed-in card. Created by the server only (`MemoryProposals`),
   * never from a question spec. Its prompt is fixed and carries no value, so a
   * notification or a webhook never shows what is proposed.
   */
  async createProposal(ownerUserId: string, proposal: MemoryProposal, opts: { askedBy: string; proposalKey: string; runId?: string | null; conversationId?: string | null }): Promise<QuestionView> {
    const q = await this.db(ownerUserId).question.create({
      data: {
        ownerUserId,
        askedBy: opts.askedBy.slice(0, 200),
        runId: opts.runId ?? null,
        conversationId: opts.conversationId ?? null,
        input: 'memory',
        kind: 'memory',
        prompt: MEMORY_PROPOSAL_PROMPT,
        blocking: false,
        proposal: memoryProposalSchema.parse(proposal) as unknown as Prisma.InputJsonValue,
        proposalKey: opts.proposalKey,
        expiresAt: new Date(Date.now() + MEMORY_PROPOSAL_TTL_MS),
      },
    });
    await this.emit('question.asked', q);
    return toQuestionView(q);
  }

  /**
   * "Save this login?" (E37.4b): a question no run waits on, answered only on the owner's signed-in card. Created by the
   * server only (`SaveLoginService`), never from a question spec. Its prompt is fixed and names nothing, and it expires when
   * the fabric stops holding the password (`proposal.valueExpiresAt`): afterwards the card says it is too late.
   */
  async createSaveLoginProposal(ownerUserId: string, proposal: SaveLoginProposal, opts: { askedBy: string; proposalKey: string; runId?: string | null; conversationId?: string | null }): Promise<QuestionView> {
    const parsed = saveLoginProposalSchema.parse(proposal);
    const q = await this.db(ownerUserId).question.create({
      data: {
        ownerUserId,
        askedBy: opts.askedBy.slice(0, 200),
        runId: opts.runId ?? null,
        conversationId: opts.conversationId ?? null,
        input: 'save_login',
        kind: 'login',
        prompt: SAVE_LOGIN_PROMPT,
        blocking: false,
        proposal: parsed as unknown as Prisma.InputJsonValue,
        proposalKey: opts.proposalKey,
        expiresAt: new Date(parsed.valueExpiresAt),
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
      rememberable: spec.rememberable ? (spec.rememberable as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      action: spec.action ? (spec.action as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      scan: spec.input === 'scan' && spec.scan ? (spec.scan as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      source: spec.source === 'stall' ? 'stall' : null,
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
    // A scan's address is read from the browser now, by the server (#924): whatever the asker or the page says is not used.
    if (spec.input === 'scan') spec = { ...spec, scan: await scanFacts(this.fabric, opts.fabricSessionId, spec.scan?.source ?? 'page') };
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
        expiresAt: h.expiresAt ?? new Date(Date.now() + (await this.resolveTimeoutMs(spec))),
      },
    });
    await this.emit('question.asked', q);
    await recordRequestInChat(this.prisma, q, this.log);
    return toQuestionView(q);
  }

  /**
   * A fresh picture for a pending scan question (#924), for its owner only; nothing is stored. 404 for another user's question or another
   * input, 410 once it is settled or expired, 409 when the page's address is unknown or the browser moved to another site.
   */
  async scanImage(userId: string, id: string): Promise<{ bytes: Buffer; mime: string; domain: string }> {
    const q = await this.find(userId, id);
    if (q.input !== 'scan') throw new NotFoundException({ code: 'QUESTION_NOT_FOUND', message: 'Question not found' });
    if (q.status !== 'pending' || q.expiresAt.getTime() <= Date.now() || !q.fabricSessionId) {
      throw new HttpException({ code: 'SCAN_CLOSED', message: 'This request is no longer open.' }, HttpStatus.GONE);
    }
    const scan = (q.scan as unknown as QuestionScan | null) ?? { source: 'page' as const, domain: null, origin: null };
    try {
      return await captureScan(this.fabric, q.fabricSessionId, scan);
    } catch (e) {
      // A picture that could not be taken is a passing failure (503: the card tries again); a page that is not the site is a refusal (409).
      if (e instanceof ScanCaptureError) throw e.code === 'SCAN_CAPTURE_FAILED' ? new HttpException({ code: e.code, message: e.message }, HttpStatus.SERVICE_UNAVAILABLE) : new ConflictException({ code: e.code, message: e.message });
      throw e;
    }
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

  /**
   * What was asked and is over (E40.3, the Inbox's History): answered, declined and expired questions, newest first,
   * with their run's goal and chat. Keyset pages on (createdAt, id).
   */
  async settledWithRuns(
    userId: string,
    opts: { status?: Exclude<QuestionStatusType, 'pending'>; before?: { at: Date; id: string }; limit?: number } = {},
  ): Promise<(Question & { run: { goal: string; conversationId: string | null } | null })[]> {
    await this.expireDue({ ownerUserId: userId });
    const page = opts.before ? { OR: [{ createdAt: { lt: opts.before.at } }, { createdAt: opts.before.at, id: { lt: opts.before.id } }] } : {};
    return this.db(userId).question.findMany({
      where: { status: opts.status ?? { in: ['answered', 'cancelled', 'expired'] }, ...page },
      include: { run: { select: { goal: true, conversationId: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit ?? 50,
    });
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
  async answer(actor: QuestionActor, id: string, input: QuestionAnswerInput, opts: { channel?: string; rememberAllowed?: boolean } = {}): Promise<QuestionView> {
    const q = await this.find(actor.id, id);
    return this.answerQuestion(actor, q, input, opts.channel ?? 'api', opts.rememberAllowed ?? true);
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
      // A question that needs no browser (a call through a connection the owner is asked to approve, E39.7): the run waits on it with no handoff.
      const free = await this.freeQuestionOf(actor.id, runId);
      if (free) return this.answerQuestion(actor, free, input, opts.channel ?? 'inbox');
    }
    if (run.status !== 'waiting_human' || !run.handoffId || (opts.expectHandoffId && run.handoffId !== opts.expectHandoffId)) {
      throw new ConflictException({ code: 'NOT_WAITING', message: 'This run is not waiting for you' });
    }
    const q = await this.questionForHandoff(actor.id, runId, run.handoffId);
    return this.answerQuestion(actor, q, input, opts.channel ?? 'inbox');
  }

  /** The newest pending question a run waits on that has no browser handoff (E39.7), or null. */
  private freeQuestionOf(userId: string, runId: string): Promise<Question | null> {
    return this.db(userId).question.findFirst({ where: { runId, status: 'pending', blocking: true, handoffId: null, input: { notIn: ['form', 'memory', 'save_login'] } }, orderBy: { createdAt: 'desc' } });
  }

  private async answerQuestion(actor: QuestionActor, q: Question, input: QuestionAnswerInput, channel: string, rememberAllowed = true): Promise<QuestionView> {
    if (q.status !== 'pending') {
      throw new ConflictException({ code: q.status === 'expired' ? 'QUESTION_EXPIRED' : 'ALREADY_ANSWERED', message: q.status === 'expired' ? 'This question expired' : 'This question was already answered' });
    }
    // The channel rules (channels/channel-rules.ts): a channel that does not sign the person in never sends a secret or approves a high-risk confirm.
    if (!mayAnswerOn(channel, { input: q.input, risk: q.risk, fields: (q.fields as unknown as FormField[] | null) ?? null }, input.outcome ?? 'completed')) {
      const where = CHANNEL_RULES[channelId(channel)]?.label ?? channel;
      if (q.input === 'memory') {
        throw new ForbiddenException({ code: 'CHANNEL_NOT_ALLOWED', message: `A memory the agent suggests is saved or declined only in Hexactra, signed in (the web app or the Android app), not from ${where}` });
      }
      if (q.input === 'save_login') {
        throw new ForbiddenException({ code: 'CHANNEL_NOT_ALLOWED', message: `Saving a login is decided only in Hexactra, signed in (the web app or the Android app), not from ${where}` });
      }
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
    // Saving a login needs the secrets module that carries it out (E37.4b); without it the question is not claimed.
    if (q.input === 'save_login' && answer.outcome === 'completed' && !this.saveLogins) {
      throw new HttpException({ code: 'SAVE_UNAVAILABLE', message: 'Saving a login is not available on this server.' }, SAVE_ERROR_STATUS.SAVE_UNAVAILABLE);
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
    // "Don't ask again" (#555): checked before anything is claimed, so a refused tick leaves the question answerable once.
    const remember = input.rememberRule ? await this.rememberPlan(actor, q, input, answer, channel, rememberAllowed) : null;
    // First answer wins: only a still-pending, unexpired question is claimed. With "Don't ask again", the rule is
    // made in the same transaction as the answer: both happen, or neither.
    let createdRuleId: string | null = null;
    const claimed = remember
      ? await this.prisma.$transaction(async (tx) => {
          const made = await this.approvals!.createFromAnswer(remember.question, remember.choice, { tx, now, orgId: actor.activeOrgId ?? null });
          response.ruleId = made.rule.id;
          if (made.created) createdRuleId = made.rule.id;
          const c = await tx.question.updateMany({
            where: { id: q.id, ownerUserId: actor.id, status: 'pending', expiresAt: { gt: now } },
            data: { status, response: response as unknown as Prisma.InputJsonValue, answeredByUserId: actor.id, answeredChannel: channel, answeredAt: now },
          });
          // Lost the race: roll the rule back with the answer.
          if (c.count === 0) throw new LostRace();
          return c;
        }).catch((e: unknown) => {
          if (e instanceof LostRace) return { count: 0 };
          throw e;
        })
      : await db.question.updateMany({
          where: { id: q.id, status: 'pending', expiresAt: { gt: now } },
          data: { status, response: response as unknown as Prisma.InputJsonValue, answeredByUserId: actor.id, answeredChannel: channel, answeredAt: now },
        });
    if (claimed.count === 0) {
      const fresh = await this.find(actor.id, q.id);
      throw new ConflictException({ code: fresh.status === 'expired' ? 'QUESTION_EXPIRED' : 'ALREADY_ANSWERED', message: fresh.status === 'expired' ? 'This question expired' : 'This question was already answered' });
    }

    if (q.input === 'memory' && status === 'answered') {
      // Only this handler writes a proposed memory, through the memories service: its secret check, label rule and limit apply.
      try {
        const memoryId = await this.saveProposal(actor.id, q, answer);
        await db.question.updateMany({ where: { id: q.id }, data: { response: { ...response, memoryId } as unknown as Prisma.InputJsonValue } });
      } catch (e) {
        await db.question.updateMany({
          where: { id: q.id, status, answeredAt: now },
          data: { status: 'pending', response: Prisma.DbNull, answeredByUserId: null, answeredChannel: null, answeredAt: null },
        });
        throw e;
      }
    }

    if (q.input === 'save_login') await this.settleSaveLogin(actor, q, status, answer, now);

    if (q.handoffId) {
      const session = new FabricSession(this.fabric);
      try {
        // The secret (if any) travels in this call only: never stored or logged.
        await session.respond(q.handoffId, { outcome: answer.outcome, value: answer.value, values: answer.values, secret: answer.secret, remember: answer.remember, channel, answeredBy: by });
      } catch (e) {
        const release = async () => {
          await db.question.updateMany({
            where: { id: q.id, status, answeredAt: now },
            data: { status: 'pending', response: Prisma.DbNull, answeredByUserId: null, answeredChannel: null, answeredAt: null },
          });
          // The answer did not reach the browser: a rule it made is undone with it (#555).
          if (createdRuleId) await this.prisma.approvalRule.deleteMany({ where: { id: createdRuleId, userId: actor.id, useCount: 0 } });
        };
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

  /**
   * Checks a "Don't ask again" tick (#555) and returns what the rule is made from, or throws `422`. The tick is
   * accepted only with an approval, only on a question the server marked `rememberable`, and only from the
   * signed-in web or Android app (`mayRememberOn`, and the request's own origin: never a token or an AI app).
   */
  private async rememberPlan(actor: QuestionActor, q: Question, input: QuestionAnswerInput, answer: { outcome: string; value?: string }, channel: string, rememberAllowed: boolean) {
    const refuse = (code: string, message: string): never => {
      throw new HttpException({ code, message }, HttpStatus.UNPROCESSABLE_ENTITY);
    };
    if (!this.approvals) refuse('REMEMBER_NOT_AVAILABLE', 'Saved approvals are not available.');
    if (!rememberAllowed || !mayRememberOn(channel)) {
      const where = CHANNEL_RULES[channelId(channel)]?.label ?? channel;
      refuse('REMEMBER_NOT_ALLOWED_HERE', `"Don't ask again" can only be ticked in the Hexactra web or Android app, signed in, not from ${where}. Your approval can still be given once from here.`);
    }
    const rememberable = (q.rememberable as unknown as QuestionRememberable | null) ?? null;
    if (!rememberable) refuse('NOT_REMEMBERABLE', 'This request cannot be remembered.');
    // Only a confirmation: never a secret, a sign-in, a code or a choice, whatever a row says.
    const approves = answer.outcome === 'completed' && q.kind === 'confirmation' && (q.input === 'none' || (q.input === 'confirm' && answer.value === 'approve'));
    if (!approves) refuse('REMEMBER_NEEDS_APPROVAL', '"Don\'t ask again" goes with an approval only.');
    const run = q.runId ? await this.db(actor.id).run.findFirst({ where: { id: q.runId }, select: { taskId: true, conversationId: true } }) : null;
    const r = input.rememberRule!;
    // A card (E37.7): unlike other approvals the amount limit is required, and it must cover this purchase.
    if (rememberable!.cardRef) {
      if (r.maxAmount === undefined) refuse('CARD_RULE_NEEDS_AMOUNT_LIMIT', 'A saved approval for a card needs an amount limit: choose the most it may pay without asking.');
      const purchase = Number(rememberable!.amount ?? 'NaN');
      if (Number.isFinite(purchase) && r.maxAmount! < purchase) refuse('CARD_RULE_LIMIT_TOO_LOW', 'The limit is lower than this purchase. Choose at least this amount, or approve it once without ticking "Don\'t ask again".');
    }
    return {
      question: { id: q.id, userId: actor.id, rememberable: rememberable!, taskId: run?.taskId ?? null, conversationId: run?.conversationId ?? null },
      choice: { scope: r.scope, maxAmount: r.maxAmount ?? null, expiresInDays: r.expiresInDays ?? null, ...(r.recipientsFrom ? { recipientsFrom: r.recipientsFrom } : {}) },
    };
  }

  /**
   * Carries out the answer to a "Save this login?" card (E37.4b), after the answer won. Save: the fabric sends the password it
   * still holds to the provider (the console never has it). "Never for this site": remembered for the owner and the registrable
   * domain. A save that did not happen puts the question back to pending (the owner may pick another name or try again) and
   * throws the card's words; one that came too late settles it as expired.
   */
  private async settleSaveLogin(actor: QuestionActor, q: Question, status: 'answered' | 'cancelled', answer: NormalizedAnswer, now: Date): Promise<void> {
    const db = this.db(actor.id);
    const revert = (next: 'pending' | 'expired') =>
      db.question.updateMany({
        where: { id: q.id, status, answeredAt: now },
        data: { status: next, response: Prisma.DbNull, answeredByUserId: null, answeredChannel: null, answeredAt: null },
      });
    const proposal = saveLoginProposalSchema.parse(q.proposal ?? {});
    try {
      if (status === 'cancelled') {
        if (answer.neverForSite) await this.saveLogins?.never(actor.id, proposal.domain);
        return;
      }
      await this.saveLogins!.save(actor.id, proposal, answer.saveLogin!.name, { questionId: q.id, runId: q.runId });
    } catch (e) {
      if (e instanceof SaveLoginError) {
        const tooLate = e.code === 'SAVE_TOO_LATE';
        await revert(tooLate ? 'expired' : 'pending');
        if (tooLate) {
          const fresh = await db.question.findFirst({ where: { id: q.id } });
          if (fresh) await this.emit('question.expired', fresh);
        }
        throw new HttpException({ code: e.code, message: tooLate ? SAVE_TOO_LATE_TEXT : e.message }, SAVE_ERROR_STATUS[e.code]);
      }
      await revert('pending');
      throw e;
    }
  }

  /**
   * Writes the memory an approved proposal holds (#553), as the owner edited it
   * on the card: a new memory, or a new version of the one it supersedes, with
   * source `agent_proposed` and the run or chat it came from.
   */
  private async saveProposal(userId: string, q: Question, answer: NormalizedAnswer): Promise<string> {
    if (!this.memories) throw new ConflictException({ code: 'MEMORIES_UNAVAILABLE', message: 'Memories are not available on this server' });
    const proposal = memoryProposalSchema.parse(q.proposal ?? {});
    const edited = answer.memory;
    const body = {
      kind: edited?.kind ?? proposal.kind,
      label: edited?.label ?? proposal.label,
      aliases: edited?.aliases ?? proposal.aliases,
      attributes: edited?.attributes ?? proposal.attributes,
    };
    const origin = { source: 'agent_proposed' as const, sourceRunId: q.runId, sourceConversationId: q.conversationId };
    const invalid = (issues: readonly { path: readonly PropertyKey[]; message: string }[]) =>
      new BadRequestException({ code: 'INVALID_ANSWER', message: issues.map((i) => `${i.path.map(String).join('.') || 'memory'}: ${i.message}`).join('; ') });
    if (proposal.supersedes) {
      const parsed = supersedeMemorySchema.safeParse(body);
      if (!parsed.success) throw invalid(parsed.error.issues);
      try {
        return (await this.memories.supersede(userId, proposal.supersedes, parsed.data, origin)).id;
      } catch (e) {
        // The memory it would replace was changed, archived or deleted since: save it as a new one.
        if (!(e instanceof HttpException) || !['MEMORY_NOT_FOUND', 'MEMORY_NOT_ACTIVE'].includes(String((e.getResponse() as { code?: unknown }).code))) throw e;
      }
    }
    const parsed = createMemorySchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);
    return (await this.memories.create(userId, parsed.data, origin)).id;
  }

  /** The AI runner resumes its own runs at once; an external agent polls its handoff. */
  private async resumeRun(actor: QuestionActor, q: Question): Promise<void> {
    if (!q.runId) return;
    if (!q.handoffId) {
      // A question that needs no browser (E39.7): its answer resumes the run that waits on it (no handoff, so `handoffId` is null on both).
      if (!q.blocking || q.input === 'form' || q.input === 'memory' || q.input === 'save_login') return;
      const waiting = await this.db(actor.id).run.findFirst({ where: { id: q.runId }, select: { status: true, handoffId: true, trigger: true } });
      if (!waiting || waiting.trigger === 'external' || waiting.status !== 'waiting_human' || waiting.handoffId !== null) return;
      await enqueueGoalRun(this.jobs, { runId: q.runId, userId: actor.id, orgId: actor.activeOrgId ?? null }, 'handoff_answered');
      return;
    }
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
