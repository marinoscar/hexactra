// The routes of deliveries (E39.6, #603): a task's deliveries (`/api/tasks/{id}/deliveries`), their log per run
// (`/api/runs/{id}/deliveries`), the recipients the owner confirmed (`/api/delivery-recipients`) and, with no session, the link that
// stops the emails (`/api/deliveries/unsubscribe/{token}`). Every authenticated route is the owner's own: another user's task, run
// or delivery is 404. There is NO MCP tool for any of this: a hosted app must not add a recipient (docs/parity.md).
import { Body, Controller, Delete, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Patch, Post, Res } from '@nestjs/common';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser, Public } from '@marinoscar/platform-api/identity';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { HttpException, HttpStatus } from '@nestjs/common';

import { MCP_RATE_LIMITER, type McpRateLimiter } from '../mcp/mcp.rate-limit';
import { PrismaService } from '../prisma/prisma.service';
import { readOutputs } from '../tasks/task-outputs.schemas';
import { DELIVERY_AUDIT, DELIVERY_ERROR_TEXT, type DeliveryErrorCode } from './deliveries.constants';
import { DeliveriesService } from './deliveries.service';
import { DeliveryEvents } from './deliveries.events';
import { DeliveryPipeline } from './delivery-pipeline.service';
import { DeliveryRecipients } from './delivery-recipients.service';
import {
  ConfirmRecipientDto,
  CreateDeliveryDto,
  DeliveryCreatedResponseDto,
  DeliveryRecipientResponseDto,
  DeliveryResponseDto,
  DeliveryTestResponseDto,
  RunDeliveryResponseDto,
  UpdateDeliveryDto,
} from './delivery.schemas';

/** At most this many test sends a minute per user. */
export const TEST_RATE_LIMIT = 10;

@ApiTags('Deliveries')
@Controller('tasks/:id/deliveries')
export class TaskDeliveriesController {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly pipeline: DeliveryPipeline,
    private readonly events: DeliveryEvents,
    private readonly prisma: PrismaService,
    @Optional() @Inject(MCP_RATE_LIMITER) private readonly limiter?: McpRateLimiter,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A task's deliveries",
    description:
      'What is sent when a run of the task ends (E39.6): an email with the PDF report, a signed webhook with the fields, a spreadsheet row, files saved to a folder. In the order they are sent. Each email delivery lists its addresses with where each stands (`own`, `confirmed`, `unconfirmed`, `unsubscribed`). Never a secret.',
  })
  @ApiDataResponse(DeliveryResponseDto, { isArray: true })
  @Auth({ permissions: ['runs:read'] })
  list(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) taskId: string) {
    return this.deliveries.list(userId, taskId);
  }

  @Post()
  @ApiOperation({
    summary: 'Add a delivery to a task',
    description:
      'At most 10 per task. Recipients, destinations and file names are fixed here: nothing in a run can add or change one. An email address that is not yours (or one of your connections\') must first be confirmed with `POST /delivery-recipients`; a delivery with such an address can be saved with `enabled: false`. A webhook delivery answers its `signingSecret` once; it cannot be read again. 400 `INVALID_DELIVERY` lists the problems (`details.issues`); 409 `RECIPIENT_NOT_CONFIRMED` lists the addresses (`details.addresses`); 422 `RECIPIENT_LIMIT` or `TOO_MANY_DELIVERIES`.',
  })
  @ApiDataResponse(DeliveryCreatedResponseDto, { status: 201 })
  @Auth({ permissions: ['runs:write'] })
  async create(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) taskId: string, @Body() body: CreateDeliveryDto) {
    const { view, signingSecret } = await this.deliveries.create(userId, taskId, body);
    return { ...view, signingSecret };
  }

  @Patch(':deliveryId')
  @ApiOperation({ summary: 'Change a delivery', description: 'The kind never changes. `config` is the whole new configuration. Switching a delivery on, or changing it, re-checks it (addresses confirmed, the connection still yours and allowed).' })
  @ApiDataResponse(DeliveryResponseDto)
  @Auth({ permissions: ['runs:write'] })
  update(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) taskId: string, @Param('deliveryId', ParseUUIDPipe) id: string, @Body() body: UpdateDeliveryDto) {
    return this.deliveries.update(userId, taskId, id, body);
  }

  @Delete(':deliveryId')
  @ApiOperation({ summary: 'Remove a delivery', description: 'Its log entries stay with their runs, without the link to it. A webhook delivery\'s signing secret is deleted.' })
  @HttpCode(204)
  @Auth({ permissions: ['runs:write'] })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) taskId: string, @Param('deliveryId', ParseUUIDPipe) id: string): Promise<void> {
    await this.deliveries.remove(userId, taskId, id);
  }

  @Post(':deliveryId/test')
  @ApiOperation({
    summary: 'Send a test',
    description:
      'Sends a clearly marked TEST with sample values to the delivery\'s own destination (an email marked TEST, a webhook of type `deliveries.test`, a spreadsheet row whose Run ID reads `TEST-...` and whose location is returned, a small text file in the folder). It reads no run and writes no run\'s log. A failure is a `200` with `ok: false` and the `code`. At most 10 a minute.',
  })
  @ApiDataResponse(DeliveryTestResponseDto)
  @ApiResponse({ status: 429, description: '`DELIVERY_TEST_RATE_LIMITED`.' })
  @Auth({ permissions: ['runs:write'] })
  async test(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) taskId: string, @Param('deliveryId', ParseUUIDPipe) id: string) {
    const row = await this.deliveries.getRow(userId, taskId, id);
    if (this.limiter) {
      const v = await Promise.resolve(this.limiter.hit(`delivery-test:${userId}`, TEST_RATE_LIMIT, 60_000)).catch(() => ({ allowed: true, retryAfterS: 0 }));
      if (!v.allowed) throw new HttpException({ code: 'DELIVERY_TEST_RATE_LIMITED', message: `At most ${TEST_RATE_LIMIT} test sends a minute. Wait ${v.retryAfterS} seconds.`, details: { retryAfterS: v.retryAfterS } }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const task = await this.prisma.forUser({ userId }).task.findFirst({ where: { id: taskId }, select: { id: true, name: true, outputs: true } });
    const r = await this.pipeline.test(userId, row, { id: taskId, name: task?.name ?? '', outputs: readOutputs(task?.outputs) });
    // The audit event counts messages (the daily cap reads it); it never carries an address.
    await this.events.audit(userId, DELIVERY_AUDIT.tested, id, { taskId, kind: row.kind, ok: r.ok, code: r.code, messages: typeof r.detail.messages === 'number' ? r.detail.messages : 0 });
    const code = r.code as DeliveryErrorCode | null;
    return { ok: r.ok, code, message: r.ok ? 'The test was sent.' : code ? `The test could not be sent: ${DELIVERY_ERROR_TEXT[code]}.` : 'The test was not sent.', detail: r.detail };
  }
}

@ApiTags('Deliveries')
@Controller('runs/:id/deliveries')
export class RunDeliveriesController {
  constructor(private readonly pipeline: DeliveryPipeline) {}

  @Get()
  @ApiOperation({
    summary: "What was sent for a run",
    description: 'The delivery log of one of your runs (E39.6): one entry per delivery with its `status` (`pending`, `sending`, `sent`, `failed`, `skipped`), the attempts, a closed `errorCode` with a fixed `errorText`, and safe `detail` (sizes, counts, the destination\'s kind). Never an address, a subject, a body, a cell or a file name.',
  })
  @ApiDataResponse(RunDeliveryResponseDto, { isArray: true })
  @Auth({ permissions: ['runs:read'] })
  list(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) runId: string) {
    return this.pipeline.listForRun(userId, runId);
  }

  @Post(':runDeliveryId/retry')
  @ApiOperation({ summary: 'Retry a delivery', description: 'A delivery that failed, or one stuck pending or sending, gets a fresh set of attempts. The send checks for its own earlier work first (a spreadsheet row, an uploaded file), but an email whose outcome was unknown (`OUTCOME_UNKNOWN`) may arrive twice. 409 `DELIVERY_NOT_RETRYABLE` otherwise.' })
  @ApiDataResponse(RunDeliveryResponseDto)
  @Auth({ permissions: ['runs:write'] })
  retry(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) runId: string, @Param('runDeliveryId', ParseUUIDPipe) id: string) {
    return this.pipeline.ownerRetry(userId, runId, id);
  }
}

@ApiTags('Deliveries')
@Controller('delivery-recipients')
export class DeliveryRecipientsController {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly recipients: DeliveryRecipients,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The addresses you confirmed', description: 'Addresses that are not yours that you confirmed as recipients of your run reports, with the time, and whether the recipient stopped the emails.' })
  @ApiDataResponse(DeliveryRecipientResponseDto, { isArray: true })
  @Auth({ permissions: ['runs:read'] })
  async list(@CurrentUser('id') userId: string) {
    return (await this.recipients.list(userId)).map((r) => ({ address: r.address, confirmedAt: r.confirmedAt.toISOString(), unsubscribedAt: r.unsubscribedAt?.toISOString() ?? null }));
  }

  @Post()
  @ApiOperation({
    summary: 'Confirm an address',
    description:
      'Your explicit "yes, send my run reports to this address": the web app asks with a dialog naming the address. Recorded with the time. The recipient gets a one-time notice on first use, with a link that stops the emails. Confirming again re-enables a recipient who had stopped them. Your own address and the addresses of your connections need no confirmation. No MCP tool does this.',
  })
  @ApiDataResponse(DeliveryRecipientResponseDto, { status: 201 })
  @Auth({ permissions: ['runs:write'] })
  async confirm(@CurrentUser('id') userId: string, @Body() body: ConfirmRecipientDto) {
    const r = await this.deliveries.confirmRecipient(userId, body.address);
    return { address: r.address, confirmedAt: r.confirmedAt.toISOString(), unsubscribedAt: r.unsubscribedAt?.toISOString() ?? null };
  }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'";
const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#12131c}button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:.4rem;background:#4b4be8;color:#fff;cursor:pointer}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

/** The link in the notice and the footer of a report: no session, the signed token is the authority. */
@ApiTags('Deliveries')
@Controller('deliveries/unsubscribe')
export class DeliveryUnsubscribeController {
  constructor(
    private readonly recipients: DeliveryRecipients,
    private readonly events: DeliveryEvents,
  ) {}

  @Get(':token')
  @Public()
  @ApiOperation({ summary: 'Stop receiving run reports (page)', description: 'A page with one button. Opening the link changes nothing (mail scanners open links); the button does.' })
  @ApiResponse({ status: 200, description: 'An HTML page.' })
  async show(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    const ok = this.recipients.verifyUnsubscribe(token) !== null;
    const html = ok
      ? page('Stop these emails?', `<p>You will no longer receive run reports at this address from this sender.</p><form method="post" enctype="text/plain" action=""><button type="submit">Stop these emails</button></form>`)
      : page('This link is not valid', '<p>It may be damaged. Ask the sender to stop the emails.</p>');
    await reply.status(ok ? 200 : 404).header('content-security-policy', PAGE_CSP).header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').type('text/html; charset=utf-8').send(html);
  }

  @Post(':token')
  @Public()
  @ApiOperation({ summary: 'Stop receiving run reports', description: 'Disables the address on every delivery of the person who set them up, until that person confirms it again. Idempotent.' })
  @ApiResponse({ status: 200, description: 'An HTML page.' })
  async stop(@Param('token') token: string, @Res() reply: FastifyReply): Promise<void> {
    const claims = this.recipients.verifyUnsubscribe(token);
    let html = page('This link is not valid', '<p>It may be damaged. Ask the sender to stop the emails.</p>');
    let status = 404;
    if (claims) {
      const changed = await this.recipients.unsubscribe(claims);
      if (changed) await this.events.audit(claims.userId, DELIVERY_AUDIT.recipientUnsubscribed, claims.userId, { unsubscribed: true }, 'user');
      html = page('Done', '<p>You will no longer receive these emails.</p>');
      status = 200;
    }
    await reply.status(status).header('content-security-policy', PAGE_CSP).header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').type('text/html; charset=utf-8').send(html);
  }
}
