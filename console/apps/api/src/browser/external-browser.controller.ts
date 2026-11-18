import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Optional,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, AuthCredential, CurrentUser, type AuthCredentialInfo } from '@marinoscar/platform-api/identity';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AppLimitError } from '../connected-apps/connected-apps.errors';
import { friendlyAppName } from '../connected-apps/request-client';
import { McpSettingsReader } from '../mcp/mcp-settings.reader';
import {
  APPROVAL_QUESTION_TIMEOUT_MS,
  APPROVAL_TTL_MS,
  DENIAL_TTL_MS,
  approvalKey,
  classifySensitiveAction,
  snapshotOf,
  type ApprovalEntry,
  type PageSnapshot,
  type SensitiveVerdict,
} from './sensitive-actions';
import { ConnectedAppsService } from '../connected-apps/connected-apps.service';
import { RequestClientService, clientColumns } from '../connected-apps/request-client';
import { FabricClient, FabricError } from '../fabric/fabric.client';
import { assertBrowserScopes, browserActionScope } from './browser-action-scopes';
import { profileNameSchema } from '../fleet/fleet.schemas';
import { PrismaService } from '../prisma/prisma.service';
import { QUESTION_INPUTS, QUESTION_KINDS, questionSpecObject, questionSpecSchema, type QuestionSpec } from '../questions/questions.contract';
import { QuestionsService } from '../questions/questions.service';
import { FabricSession, handoffOutcome, isTakeoverActive } from '../runner/fabric-session';
import { domainAllowed, fabricAllowedSites } from '../runner/policy';
import { redactActionArgs, redactUrl } from '../tasks/redact';
import { RunNotifier } from '../tasks/run-notifier';
import { TasksService } from '../tasks/tasks.service';

const openSchema = z.object({
  profile: profileNameSchema.default('default'),
  hostId: z.uuid().nullable().optional(),
  /** Who is driving: the agent framework's name (shown in the console). */
  actor: z.string().trim().min(1).max(200).default('external agent'),
  /** What the agent says it is doing (shown as the run's goal). */
  goal: z.string().trim().min(1).max(4000).default('External agent session'),
  allowedDomains: z.array(z.string().trim().toLowerCase().max(253)).max(50).default([]),
});
class OpenDto extends createZodDto(openSchema) {}

const ACTION_TYPES = [
  'navigate', 'click', 'type', 'press', 'scroll', 'screenshot', 'text', 'elements', 'wait_for', 'tabs', 'new_tab', 'activate_tab', 'close_tab', 'back', 'forward', 'reload',
  // Full powers (#366): JavaScript, trusted positional input, the OS desktop.
  'evaluate', 'click_at', 'mouse', 'drag', 'scroll_at', 'type_keys', 'key',
  'desktop_screenshot', 'desktop_click', 'desktop_move', 'desktop_drag', 'desktop_type', 'desktop_key', 'desktop_scroll',
] as const;
const actionSchema = z.object({
  action: z.looseObject({ type: z.enum([...ACTION_TYPES, 'type_handoff_secret']) }),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});
class ActionDto extends createZodDto(actionSchema) {}

/**
 * A handoff: the full question contract (camelCase; the fabric's snake_case
 * body is built by `handoffBody`). `choices` (bare strings or option
 * objects) is the historical name of `options`; `kind` is required here.
 */
/** What an external session keeps in `runs.transcript`. */
interface SessionTranscript {
  log?: unknown[];
  chunks?: number;
  allowedDomains?: string[];
  appAllowedDomains?: string[];
  /** The page as its last element list showed it (#465): for an AI app's sensitive-action rules. */
  page?: PageSnapshot | null;
  /** Approval requests of sensitive actions (#465). */
  approvals?: ApprovalEntry[];
}

const handoffSchema = questionSpecObject.extend({
  kind: z.enum(QUESTION_KINDS),
  input: z.enum(QUESTION_INPUTS).default('none'),
});
class HandoffDto extends createZodDto(handoffSchema) {}

/** Validates a handoff against the question contract before anything reaches the fabric; a 400 names what is wrong. */
function parseHandoffSpec(body: z.infer<typeof handoffSchema>): QuestionSpec {
  const parsed = questionSpecSchema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({ code: 'INVALID_QUESTION', message: parsed.error.issues.map((i) => `${i.path.join('.') || 'question'}: ${i.message}`).join('; ') });
  }
  return parsed.data;
}

const closeSchema = z.object({ success: z.boolean().default(true), result: z.string().max(8000).optional() });
class CloseDto extends createZodDto(closeSchema) {}

/**
 * `/api/browser/sessions`: external agents (MCP clients, agent frameworks,
 * scripts) drive a browser through the console instead of the fabric. Each
 * session is a Run (trigger `external`) whose actions are recorded as
 * redacted steps, so the user sees what the agent is doing, can stop it
 * (cancel), and answers its handoffs in the Inbox. Navigation is limited to
 * http(s) and to the session's allowed sites.
 */
@ApiTags('Browser')
@Controller('browser/sessions')
export class ExternalBrowserController {
  private readonly log = new Logger(ExternalBrowserController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fabric: FabricClient,
    private readonly tasks: TasksService,
    @Optional() private readonly notifier?: RunNotifier,
    @Optional() private readonly questions?: QuestionsService,
    @Optional() private readonly clients?: RequestClientService,
    @Optional() private readonly apps?: ConnectedAppsService,
    @Optional() private readonly mcpSettings?: McpSettingsReader,
  ) {}

  /**
   * Whether this action of an AI app signed in with OAuth needs the user's
   * approval first (#465, `sensitive-actions.ts`): only when the app's
   * `confirmSensitiveActions` is on (the default). Any other caller (the
   * console, a personal access token, the runner) is never asked here.
   */
  private async sensitive(userId: string, credential: AuthCredentialInfo | null | undefined, transcript: SessionTranscript, action: Record<string, unknown>): Promise<SensitiveVerdict | null> {
    if (credential?.kind !== 'oauth' || !this.apps) return null;
    const limits = await this.apps.limits(userId, credential.clientId);
    if (!limits.confirmSensitiveActions) return null;
    const sensitiveHosts = (await this.mcpSettings?.read())?.sensitiveHosts ?? [];
    return classifySensitiveAction(action, { page: transcript.page ?? null, sensitiveHosts });
  }

  /** Writes the session's transcript only if nobody changed it meanwhile; false when someone did. */
  private async casTranscript(userId: string, runId: string, before: SessionTranscript, next: SessionTranscript): Promise<boolean> {
    const { count } = await this.prisma.forUser({ userId }).run.updateMany({ where: { id: runId, transcript: { equals: before as never } }, data: { transcript: next as never } });
    return count === 1;
  }

  /**
   * The approval gate of a sensitive action (#465). The approval is a
   * `confirm` question with risk high in the user's inbox, so only a channel
   * where the person is signed in can approve it (never the app itself through
   * `inbox_answer`). It is bound to the session, the action kind and the
   * target, lets exactly that action through once, and only within two minutes
   * of the approval. Throws (409) until then; nothing reaches the fabric.
   */
  private async requireApproval(userId: string, run: { id: string; transcript: unknown; clientId: string | null; clientName: string | null; grantId: string | null; goal: string }, v: SensitiveVerdict, action: string, started: number): Promise<void> {
    const transcript = (run.transcript ?? {}) as SessionTranscript;
    const key = approvalKey(run.id, v);
    const approvals = transcript.approvals ?? [];
    const entry = [...approvals].reverse().find((a) => a.key === key && !a.usedAt);
    const now = Date.now();
    if (entry) {
      const q = await this.prisma.forUser({ userId }).question.findFirst({ where: { id: entry.questionId }, select: { status: true, response: true, answeredAt: true, expiresAt: true } });
      const response = (q?.response ?? null) as { outcome?: string; value?: unknown } | null;
      const answeredAt = q?.answeredAt?.getTime() ?? 0;
      if (q?.status === 'answered' && response?.outcome === 'completed' && response.value === 'approve' && now - answeredAt <= APPROVAL_TTL_MS) {
        const next = { ...transcript, approvals: approvals.map((a) => (a === entry ? { ...a, usedAt: new Date(now).toISOString() } : a)) };
        // Exactly once: a second retry racing this one finds the approval used.
        if (await this.casTranscript(userId, run.id, transcript, next)) {
          await this.record(run.id, userId, 'action', action, null, true, `approved by the user: ${v.describe}`.slice(0, 300), started);
          return;
        }
        throw new ConflictException({ code: 'CONFIRMATION_REQUIRED', message: 'This approval was already used. Ask the user again.' });
      }
      if (q?.status === 'pending' && q.expiresAt.getTime() > now) {
        throw new ConflictException({ code: 'CONFIRMATION_PENDING', message: `Waiting for the user to approve: ${v.describe}.`, details: { questionId: entry.questionId } });
      }
      const declined = q && (q.status === 'cancelled' || (q.status === 'answered' && !(response?.outcome === 'completed' && response.value === 'approve')));
      if (declined && now - answeredAt <= DENIAL_TTL_MS) {
        throw new ConflictException({ code: 'CONFIRMATION_DENIED', message: `The user did not approve this: ${v.describe}.`, details: { questionId: entry.questionId } });
      }
    }
    if (!this.questions) throw new ConflictException({ code: 'CONFIRMATION_REQUIRED', message: `This needs the user's approval, and no inbox is available: ${v.describe}.` });
    const appName = friendlyAppName(run.clientName);
    const spec = questionSpecSchema.parse({
      kind: 'confirmation',
      input: 'confirm',
      risk: 'high',
      prompt: `${appName} wants to ${v.describe}, in its browser session "${run.goal.slice(0, 200)}". Approve only if you asked it to. The approval lets this one action through within 2 minutes.\n\nStarted by ${appName}.`.slice(0, 2000),
      confirmLabel: 'Allow once',
      denyLabel: 'Block',
      timeoutMs: APPROVAL_QUESTION_TIMEOUT_MS,
    });
    const q = await this.questions.create({ id: userId }, spec, {
      askedBy: 'system:sensitive-action',
      runId: run.id,
      client: { clientId: run.clientId, clientName: run.clientName, grantId: run.grantId },
    });
    const next: SessionTranscript = { ...transcript, approvals: [...approvals.filter((a) => a.key !== key || a.usedAt), { key, questionId: q.id }].slice(-20) };
    await this.prisma.forUser({ userId }).run.update({ where: { id: run.id }, data: { transcript: next as never } });
    await this.record(run.id, userId, 'action', action, null, false, `paused: needs the user's approval (${v.rule}): ${v.describe}`.slice(0, 300), started);
    throw new ConflictException({
      code: 'CONFIRMATION_REQUIRED',
      message: `${v.describe.charAt(0).toUpperCase()}${v.describe.slice(1)}: this needs the user's approval. It is waiting in their Hexactra inbox (only they can approve it, where they are signed in).`,
      details: { questionId: q.id, rule: v.rule },
    });
  }

  private async liveRun(userId: string, runId: string) {
    const run = await this.prisma.forUser({ userId }).run.findFirst({ where: { id: runId, trigger: 'external' } });
    if (!run) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Browser session not found' });
    if (run.cancelRequested && run.status !== 'cancelled') {
      if (run.sessionId) await new FabricSession(this.fabric).end(run.sessionId);
      await this.tasks.transition(userId, runId, 'cancelled', { error: 'Stopped by the user', stopReason: 'cancelled' });
      throw new ConflictException({ code: 'SESSION_CANCELLED', message: 'The user stopped this session' });
    }
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled' || !run.sessionId) {
      throw new ConflictException({ code: 'SESSION_ENDED', message: 'This browser session has ended' });
    }
    return run;
  }

  private async record(runId: string, userId: string, kind: string, action: string | null, args: Record<string, unknown> | null, ok: boolean, summary: string, started: number) {
    const db = this.prisma.forUser({ userId });
    const updated = await db.run.update({ where: { id: runId }, data: { stepCount: { increment: 1 } }, select: { stepCount: true } });
    this.tasks.metrics.step(kind, ok);
    await this.prisma.runStep.create({
      data: { runId, seq: updated.stepCount, kind, action, args: args ? (redactActionArgs(action ?? '', args) as never) : undefined, ok, summary: summary.slice(0, 1_900), durationMs: Date.now() - started },
    });
    await this.tasks.stepRecorded?.(userId, runId, updated.stepCount);
  }

  @Post()
  @Auth({ permissions: ['runs:write'] })
  async open(@CurrentUser('id') userId: string, @Body() body: OpenDto, @AuthCredential() credential?: AuthCredentialInfo | null, @Req() req?: object) {
    assertBrowserScopes(credential, 'browser:drive');
    // Who opens it (#464) and the AI app's limits (paused, run limits, sites): a refusal opens nothing.
    const client = (await this.clients?.resolve(req)) ?? null;
    const decision = client && this.apps ? await this.apps.checkStart(userId, client, { kind: 'session', allowedDomains: body.allowedDomains }) : null;
    const run = await this.prisma.forUser({ userId }).run.create({
      data: {
        userId,
        goal: body.goal,
        profile: body.profile,
        hostId: body.hostId ?? null,
        trigger: 'external',
        actor: body.actor,
        status: 'queued',
        ...(client ? clientColumns(client) : {}),
        ...(decision?.appLimits ? { appLimits: decision.appLimits as never } : {}),
      },
    });
    let sessionId: string;
    try {
      // The sites the session may visit reach the fabric's session request (#465), which enforces them in the
      // browser (#508): the session's list narrowed by an AI app's own.
      const sites = fabricAllowedSites(body.allowedDomains ?? [], decision?.appLimits?.allowedDomains ?? []);
      sessionId = await new FabricSession(this.fabric).create({ profile: body.profile, hostId: body.hostId ?? null, label: `${body.actor}: run ${run.id}`, allowedDomains: sites });
    } catch (e) {
      await this.tasks.transition(userId, run.id, 'failed', { error: e instanceof Error ? e.message : String(e), stopReason: 'error' });
      if (e instanceof FabricError && e.status === 404) throw new NotFoundException({ code: 'PROFILE_NOT_FOUND', message: e.message });
      throw new ConflictException({ code: 'NO_BROWSER', message: e instanceof Error ? e.message : 'No browser available' });
    }
    await this.tasks.transition(userId, run.id, 'running', {
      sessionId,
      // The policy of an external session lives in its memory, like a run's.
      // An AI app's own site limit (#464) is kept apart and checked too: the two lists intersect.
      transcript: { log: [], chunks: 0, allowedDomains: body.allowedDomains, ...(decision?.appLimits?.allowedDomains.length ? { appAllowedDomains: decision.appLimits.allowedDomains } : {}) } as never,
    });
    this.log.log(`external session opened by ${body.actor}: run ${run.id}`);
    await this.notifier?.started(userId, run);
    return { runId: run.id, profile: body.profile };
  }

  @Post(':runId/actions')
  @HttpCode(200)
  @Auth({ permissions: ['runs:write'] })
  async act(@CurrentUser('id') userId: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() body: ActionDto, @AuthCredential() credential?: AuthCredentialInfo | null) {
    // An OAuth app needs the action kind's own scope (#460), checked before anything is read or recorded.
    assertBrowserScopes(credential, browserActionScope(String(body.action.type)));
    const run = await this.liveRun(userId, runId);
    if (run.status === 'waiting_human') throw new ConflictException({ code: 'HANDOFF_PENDING', message: 'Waiting for the person to answer the handoff' });
    const session = new FabricSession(this.fabric);
    const action = { ...body.action } as Record<string, unknown>;
    const type = String(action.type);
    const started = Date.now();
    const allowed = ((run.transcript as { allowedDomains?: string[] } | null)?.allowedDomains ?? []) as string[];

    if ((type === 'navigate' || type === 'new_tab') && typeof action.url === 'string' && !domainAllowed(action.url, allowed)) {
      await this.record(runId, userId, 'action', type, action, false, 'refused by policy: site not allowed', started);
      throw new BadRequestException({ code: 'SITE_NOT_ALLOWED', message: `This session may not open ${redactUrl(action.url)}` });
    }
    const appAllowed = ((run.transcript as { appAllowedDomains?: string[] } | null)?.appAllowedDomains ?? []) as string[];
    if ((type === 'navigate' || type === 'new_tab') && typeof action.url === 'string' && !domainAllowed(action.url, appAllowed)) {
      await this.record(runId, userId, 'action', type, action, false, "refused by the app's limits: site not allowed", started);
      throw new AppLimitError('APP_DOMAIN_NOT_ALLOWED', { site: redactUrl(action.url) });
    }

    // A sensitive action of an AI app (#465): the user approves it first, in the console.
    const verdict = await this.sensitive(userId, credential, (run.transcript ?? {}) as SessionTranscript, action);
    if (verdict) await this.requireApproval(userId, run, verdict, type, started);

    // Type the secret a person gave through a handoff; the agent never sees it.
    if (type === 'type_handoff_secret') {
      const handoffId = String(action.handoffId ?? '');
      const selector = String(action.selector ?? '');
      if (!handoffId || !selector) throw new BadRequestException({ code: 'INVALID_ACTION', message: 'type_handoff_secret needs handoffId and selector' });
      let op;
      try {
        // The fabric types the value itself (`type_secret`): the console never sees it.
        op = await session.typeSecret(run.sessionId!, { handoffId, selector, clear: action.clear === undefined ? true : Boolean(action.clear), submit: Boolean(action.submit) });
      } catch (e) {
        if (e instanceof FabricError && (e.status === 409 || e.status === 422 || e.status === 404)) {
          throw new ConflictException({ code: 'NO_SECRET', message: 'No secret to type (already used, expired, or not answered yet)' });
        }
        throw new ConflictException({ code: 'ACTION_FAILED', message: e instanceof Error ? e.message : String(e) });
      }
      await this.record(runId, userId, 'action', 'type', { selector, submit: Boolean(action.submit) }, op.state === 'succeeded', op.state === 'succeeded' ? 'typed the secret' : (op.error ?? op.state), started);
      return { state: op.state, error: op.error ?? null };
    }

    let op;
    try {
      op = await session.act(run.sessionId!, action, body.timeoutMs, { waitForTakeover: false });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.record(runId, userId, 'action', type, action, false, msg, started);
      if (isTakeoverActive(e)) {
        throw new ConflictException({ code: 'TAKEOVER_ACTIVE', message: `A person is controlling this browser. Try again later. (${msg})` });
      }
      throw new ConflictException({ code: 'ACTION_FAILED', message: msg });
    }
    const result = op.result ?? {};
    const summary =
      op.state !== 'succeeded'
        ? (op.error ?? op.state)
        : type === 'navigate'
          ? `at ${redactUrl(String(result.url ?? ''))}`
          : type === 'text'
            ? `read ${String(result.text ?? '').length} characters`
            : type === 'elements'
              ? `${(result.elements as unknown[] | undefined)?.length ?? 0} interactive elements`
              : 'done';
    await this.record(runId, userId, 'action', type, action, op.state === 'succeeded', summary, started);
    // What the page holds, for an AI app's sensitive-action rules (#465): kept from its element lists, forgotten when it changes.
    if (credential?.kind === 'oauth' && op.state === 'succeeded') await this.rememberPage(userId, runId, type, result);
    // A screenshot is returned by handle; fetch it from this console.
    if ((type === 'screenshot' || type === 'desktop_screenshot') && typeof result.artifact_id === 'string') {
      return { ...op, result: { ...result, url_path: `/api/browser/sessions/${runId}/artifacts/${result.artifact_id}` } };
    }
    return op;
  }

  /** Keeps (or forgets) the page snapshot of an OAuth app's session. Never fails the action. */
  private async rememberPage(userId: string, runId: string, type: string, result: Record<string, unknown>): Promise<void> {
    const navigates = ['navigate', 'new_tab', 'back', 'forward', 'reload', 'activate_tab', 'close_tab'].includes(type);
    if (type !== 'elements' && !navigates) return;
    try {
      const db = this.prisma.forUser({ userId });
      const row = await db.run.findFirst({ where: { id: runId }, select: { transcript: true } });
      const t = (row?.transcript ?? {}) as SessionTranscript;
      const page: PageSnapshot = type === 'elements' ? snapshotOf(result as { url?: unknown; elements?: unknown }) : { url: typeof result.url === 'string' ? result.url : null, password: false, payment: false, links: {} };
      await db.run.update({ where: { id: runId }, data: { transcript: { ...t, page } as never } });
    } catch (e) {
      this.log.warn(`run ${runId}: could not keep the page snapshot: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Screenshot bytes by handle (short-lived; proxied from the fabric). */
  @Get(':runId/artifacts/:artifactId')
  @Auth({ permissions: ['runs:read'] })
  async artifact(
    @CurrentUser('id') userId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('artifactId', ParseUUIDPipe) artifactId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const run = await this.prisma.forUser({ userId }).run.findFirst({ where: { id: runId, trigger: 'external' }, select: { id: true } });
    if (!run) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Browser session not found' });
    let res: Response;
    try {
      res = await this.fabric.raw('GET', `/v1/artifacts/${artifactId}`, { retries: 0 });
    } catch {
      throw new NotFoundException({ code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found or expired' });
    }
    await reply.header('cache-control', 'no-store').type(res.headers.get('content-type') ?? 'application/octet-stream').send(Buffer.from(await res.arrayBuffer()));
  }

  /** Ask the person for help; answered in the Inbox. Poll it with GET …/handoffs/:id. */
  @Post(':runId/handoffs')
  @Auth({ permissions: ['runs:write'] })
  async handoff(@CurrentUser('id') userId: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() body: HandoffDto, @AuthCredential() credential?: AuthCredentialInfo | null) {
    assertBrowserScopes(credential, 'browser:drive');
    const spec = parseHandoffSpec(body);
    const run = await this.liveRun(userId, runId);
    const started = Date.now();
    const created = await new FabricSession(this.fabric).openHandoff(run.sessionId!, {
      kind: spec.kind,
      prompt: spec.prompt,
      input: spec.input,
      choices: spec.options ?? [],
      constraints: spec.constraints,
      confirmLabel: spec.confirmLabel,
      denyLabel: spec.denyLabel,
      risk: spec.risk,
      timeoutMs: body.timeoutMs,
    });
    const { id, expiresAt } = created;
    // Mirror it in the question broker (the inbox and every channel read it there).
    if (this.questions) {
      try {
        await this.questions.mirrorHandoff({ id: userId }, spec, created, { askedBy: `agent:${(run.actor ?? 'external agent').slice(0, 190)}`, runId, fabricSessionId: run.sessionId, client: { clientId: run.clientId, clientName: run.clientName, grantId: run.grantId } });
      } catch (e) {
        // The handoff exists on the fabric: the inbox mirrors it on first answer.
        this.log.warn(`run ${runId}: could not mirror handoff ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await this.record(runId, userId, 'handoff', null, { kind: body.kind, input: body.input }, true, `asked a person (${body.kind}): ${body.prompt.slice(0, 300)}`, started);
    await this.tasks.transition(userId, runId, 'waiting_human', { handoffId: id, handoffExpiresAt: expiresAt });
    await this.notifier?.needsYou(userId, { ...run, handoffId: id }, body.prompt, body.kind, body.input, expiresAt);
    return { handoffId: id };
  }

  /** A handoff's status; a text or choice answer is included, a secret never is. */
  @Get(':runId/handoffs/:handoffId')
  @Auth({ permissions: ['runs:read'] })
  async handoffStatus(@CurrentUser('id') userId: string, @Param('runId', ParseUUIDPipe) runId: string, @Param('handoffId', ParseUUIDPipe) handoffId: string) {
    const run = await this.prisma.forUser({ userId }).run.findFirst({ where: { id: runId, trigger: 'external' } });
    if (!run) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Browser session not found' });
    const h = await new FabricSession(this.fabric).getHandoff(handoffId);
    if (h.status !== 'pending') await this.questions?.reconcileHandoff(h);
    if (h.status !== 'pending' && run.status === 'waiting_human' && run.handoffId === handoffId) {
      await this.tasks.transition(userId, runId, 'running', { handoffId: null });
    }
    const outcome = handoffOutcome(h);
    return {
      status: h.status,
      outcome,
      // A sign-in's username is returned (the agent types it); a secret and a password never are.
      value: h.input === 'secret' ? null : (h.response?.value ?? null),
      values: h.response?.values ?? null,
      secretAvailable: (h.input === 'secret' || h.input === 'credentials') && h.status === 'completed' && outcome === 'completed',
      ...(typeof h.response?.remember === 'boolean' ? { remember: h.response.remember } : {}),
    };
  }

  /** End the session and the run. */
  @Delete(':runId')
  @Auth({ permissions: ['runs:write'] })
  async close(@CurrentUser('id') userId: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() body: CloseDto, @AuthCredential() credential?: AuthCredentialInfo | null) {
    assertBrowserScopes(credential, 'browser:drive');
    const run = await this.prisma.forUser({ userId }).run.findFirst({ where: { id: runId, trigger: 'external' } });
    if (!run) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Browser session not found' });
    if (run.sessionId) await new FabricSession(this.fabric).end(run.sessionId);
    if (run.status === 'running' || run.status === 'waiting_human' || run.status === 'queued') {
      return this.tasks.transition(userId, runId, body.success ? 'succeeded' : 'failed', { result: body.result ?? null, handoffId: null, stopReason: 'finished' });
    }
    return run;
  }
}
