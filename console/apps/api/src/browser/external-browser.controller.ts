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
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser } from '@marinoscar/platform-api/identity';
import type { FastifyReply } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { profileNameSchema } from '../fleet/fleet.schemas';
import { PrismaService } from '../prisma/prisma.service';
import { FabricSession } from '../runner/fabric-session';
import { domainAllowed } from '../runner/policy';
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

const ACTION_TYPES = ['navigate', 'click', 'type', 'press', 'scroll', 'screenshot', 'text', 'elements', 'wait_for', 'tabs', 'new_tab', 'activate_tab', 'close_tab', 'back', 'forward', 'reload'] as const;
const actionSchema = z.object({
  action: z.looseObject({ type: z.enum([...ACTION_TYPES, 'type_handoff_secret']) }),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});
class ActionDto extends createZodDto(actionSchema) {}

const handoffSchema = z.object({
  kind: z.enum(['captcha', 'code', 'passkey', 'login', 'confirmation', 'other']),
  prompt: z.string().trim().min(1).max(2000),
  input: z.enum(['none', 'text', 'secret', 'choice']).default('none'),
  choices: z.array(z.string().max(200)).max(10).default([]),
  timeoutMs: z.number().int().min(10_000).max(24 * 3600_000).optional(),
});
class HandoffDto extends createZodDto(handoffSchema) {}

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
  ) {}

  private async liveRun(userId: string, runId: string) {
    const run = await this.prisma.forUser({ userId }).run.findFirst({ where: { id: runId, trigger: 'external' } });
    if (!run) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Browser session not found' });
    if (run.cancelRequested && run.status !== 'cancelled') {
      if (run.sessionId) await new FabricSession(this.fabric).end(run.sessionId);
      await this.tasks.transition(userId, runId, 'cancelled', { error: 'Stopped by the user' });
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
  }

  @Post()
  @Auth({ permissions: ['runs:write'] })
  async open(@CurrentUser('id') userId: string, @Body() body: OpenDto) {
    const run = await this.prisma.forUser({ userId }).run.create({
      data: { userId, goal: body.goal, profile: body.profile, hostId: body.hostId ?? null, trigger: 'external', actor: body.actor, status: 'queued' },
    });
    let sessionId: string;
    try {
      sessionId = await new FabricSession(this.fabric).create({ profile: body.profile, hostId: body.hostId ?? null, label: `${body.actor}: run ${run.id}` });
    } catch (e) {
      await this.tasks.transition(userId, run.id, 'failed', { error: e instanceof Error ? e.message : String(e) });
      if (e instanceof FabricError && e.status === 404) throw new NotFoundException({ code: 'PROFILE_NOT_FOUND', message: e.message });
      throw new ConflictException({ code: 'NO_BROWSER', message: e instanceof Error ? e.message : 'No browser available' });
    }
    await this.tasks.transition(userId, run.id, 'running', {
      sessionId,
      // The policy of an external session lives in its memory, like a run's.
      transcript: { log: [], chunks: 0, allowedDomains: body.allowedDomains } as never,
    });
    this.log.log(`external session opened by ${body.actor}: run ${run.id}`);
    await this.notifier?.started(userId, run);
    return { runId: run.id, profile: body.profile };
  }

  @Post(':runId/actions')
  @HttpCode(200)
  @Auth({ permissions: ['runs:write'] })
  async act(@CurrentUser('id') userId: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() body: ActionDto) {
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

    // Type the secret a person gave through a handoff; the agent never sees it.
    if (type === 'type_handoff_secret') {
      const handoffId = String(action.handoffId ?? '');
      const selector = String(action.selector ?? '');
      if (!handoffId || !selector) throw new BadRequestException({ code: 'INVALID_ACTION', message: 'type_handoff_secret needs handoffId and selector' });
      let value: string;
      try {
        value = await session.claimSecret(handoffId);
      } catch {
        throw new ConflictException({ code: 'NO_SECRET', message: 'No secret to type (already used, expired, or not answered yet)' });
      }
      const op = await session.act(run.sessionId!, { type: 'type', selector, text: value, clear: true, submit: Boolean(action.submit) });
      value = '';
      await this.record(runId, userId, 'action', 'type', { selector, submit: Boolean(action.submit) }, op.state === 'succeeded', op.state === 'succeeded' ? 'typed the secret' : (op.error ?? op.state), started);
      return { state: op.state, error: op.error ?? null };
    }

    let op;
    try {
      op = await session.act(run.sessionId!, action, body.timeoutMs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.record(runId, userId, 'action', type, action, false, msg, started);
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
    // A screenshot is returned by handle; fetch it from this console.
    if (type === 'screenshot' && typeof result.artifact_id === 'string') {
      return { ...op, result: { ...result, url_path: `/api/browser/sessions/${runId}/artifacts/${result.artifact_id}` } };
    }
    return op;
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
  async handoff(@CurrentUser('id') userId: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() body: HandoffDto) {
    const run = await this.liveRun(userId, runId);
    const started = Date.now();
    const id = await new FabricSession(this.fabric).createHandoff(run.sessionId!, { kind: body.kind, prompt: body.prompt, input: body.input, choices: body.choices, timeoutMs: body.timeoutMs });
    await this.record(runId, userId, 'handoff', null, { kind: body.kind, input: body.input }, true, `asked a person (${body.kind}): ${body.prompt.slice(0, 300)}`, started);
    await this.tasks.transition(userId, runId, 'waiting_human', { handoffId: id });
    await this.notifier?.needsYou(userId, run, body.prompt, body.kind);
    return { handoffId: id };
  }

  /** A handoff's status; a text or choice answer is included, a secret never is. */
  @Get(':runId/handoffs/:handoffId')
  @Auth({ permissions: ['runs:read'] })
  async handoffStatus(@CurrentUser('id') userId: string, @Param('runId', ParseUUIDPipe) runId: string, @Param('handoffId', ParseUUIDPipe) handoffId: string) {
    const run = await this.prisma.forUser({ userId }).run.findFirst({ where: { id: runId, trigger: 'external' } });
    if (!run) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Browser session not found' });
    const h = await new FabricSession(this.fabric).getHandoff(handoffId);
    if (h.status !== 'pending' && run.status === 'waiting_human' && run.handoffId === handoffId) {
      await this.tasks.transition(userId, runId, 'running', { handoffId: null });
    }
    return {
      status: h.status,
      outcome: h.response?.outcome ?? null,
      value: h.input === 'secret' ? null : (h.response?.value ?? null),
      secretAvailable: h.input === 'secret' && h.status === 'completed' && h.response?.outcome === 'completed',
    };
  }

  /** End the session and the run. */
  @Delete(':runId')
  @Auth({ permissions: ['runs:write'] })
  async close(@CurrentUser('id') userId: string, @Param('runId', ParseUUIDPipe) runId: string, @Body() body: CloseDto) {
    const run = await this.prisma.forUser({ userId }).run.findFirst({ where: { id: runId, trigger: 'external' } });
    if (!run) throw new NotFoundException({ code: 'SESSION_NOT_FOUND', message: 'Browser session not found' });
    if (run.sessionId) await new FabricSession(this.fabric).end(run.sessionId);
    if (run.status === 'running' || run.status === 'waiting_human' || run.status === 'queued') {
      return this.tasks.transition(userId, runId, body.success ? 'succeeded' : 'failed', { result: body.result ?? null, handoffId: null });
    }
    return run;
  }
}
