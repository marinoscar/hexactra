// The internal release route of the built-in store (E37.5, #594): how the fabric asks for ONE field of ONE login.
//
//   POST /api/internal/secrets-store/v1/lookup   { owner_id, origin, kind? }                       -> { items: [...] }
//   POST /api/internal/secrets-store/v1/release  { owner_id, item_id, field, origin, purpose, ... } -> the field's bytes
//   POST /api/internal/secrets-store/v1/code     { owner_id, item_id, origin, purpose, ... }        -> the code's bytes
//
// WHO MAY CALL IT. Only the fabric, with the credential the console minted when it registered the store for an owner
// (`sct_...`, store.callback-tokens.ts). A session, a personal access token and an AI app's OAuth token are all
// refused with the same 401 (none has that shape and none is a callback credential), and an AI app's token never
// reaches the route anyway: it is confined to its protected resource. The credential names ONE owner; a request that
// names another is refused; and the owner must have a live run, so the route answers nothing for an idle account.
// The route is for the fabric's network: nginx answers 404 to it from the public side
// (infra/nginx/app.d/locations/secrets-store-internal.conf), and over a network it must be https or loopback.
//
// WHAT IT NEVER DOES. It never logs a body, a value or a token (the request log prints the method and path only);
// every answer carries `Cache-Control: no-store`; the value is written straight from the Buffer to the response and the
// Buffer is zeroed when the response has finished (or the socket closed), never converted to a string here.
//
// Errors are `{ "code": <provider error code> }` with the matching status, no message from the store.
import { CanActivate, Controller, ExecutionContext, Injectable, Post, UseGuards, Body, Req, Res, HttpCode } from '@nestjs/common';
import { Public } from '@marinoscar/platform-api/identity';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { PrismaService } from '../../prisma/prisma.service';
import { SecretsProviderError, type SecretField, type SecretPurpose } from '../secrets-provider.port';
import { SecretsStoreCallbackTokens } from './store.callback-tokens';
import { BuiltinSecretsProvider } from './store.provider';

export const STORE_CALLBACK_PATH = 'internal/secrets-store/v1';
/** Runs that can be using a stored secret. */
const LIVE_RUN_STATUSES = ['queued', 'running', 'waiting_human', 'paused'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = ['username', 'password', 'full_name', 'date_of_birth', 'id_type', 'id_number', 'id_issuing_country', 'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country', 'phone', 'email', 'card_number', 'exp_month', 'exp_year', 'holder_name', 'security_code'] as const;
const PURPOSES = ['login', 'signup', 'password_change', 'mfa', 'form', 'purchase'] as const;

const base = z.object({ owner_id: z.string().uuid(), origin: z.string().min(1).max(2048), run_id: z.string().min(1).max(100).optional(), client_label: z.string().min(1).max(100).optional() }).strict();
const lookupBody = base.extend({ kind: z.enum(['login', 'identity', 'card']).default('login') }).strict();
const releaseBody = base.extend({ item_id: z.string().uuid(), field: z.enum(FIELDS), purpose: z.enum(PURPOSES) }).strict();
const codeBody = base.extend({ item_id: z.string().uuid(), purpose: z.enum(PURPOSES) }).strict();
/** `save` (#712): the owner's typed sign-in, sent by the fabric from the copy it holds. The only route whose body carries a value. */
const saveBody = base
  .extend({ name: z.string().trim().min(1).max(200), username: z.string().trim().min(1).max(200), password: z.string().min(1).max(1024), purpose: z.literal('save_login') })
  .strict();

const STATUS: Record<string, number> = { name_taken: 409, not_found: 404, origin_mismatch: 403, disabled: 403, rate_limited: 429, unauthorized: 401, refused: 403, unsupported: 422, unavailable: 503, unknown: 500 };

interface CallbackRequest extends FastifyRequest {
  storeOwnerId?: string;
}

/** Authenticates the fabric: a valid callback credential, nothing else. The same 401 for every other kind of credential. */
@Injectable()
export class StoreCallbackGuard implements CanActivate {
  constructor(private readonly tokens: SecretsStoreCallbackTokens) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<CallbackRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const owner = token ? await this.tokens.verify(token) : null;
    if (!owner) {
      void reply.status(401).header('cache-control', 'no-store').header('www-authenticate', 'Bearer').send({ code: 'unauthorized' });
      return false;
    }
    request.storeOwnerId = owner;
    return true;
  }
}

@ApiExcludeController()
@Controller(STORE_CALLBACK_PATH)
@Public()
@UseGuards(StoreCallbackGuard)
export class StoreCallbackController {
  constructor(
    private readonly provider: BuiltinSecretsProvider,
    private readonly prisma: PrismaService,
  ) {}

  private fail(reply: FastifyReply, e: unknown): FastifyReply {
    const err = e instanceof SecretsProviderError ? e : new SecretsProviderError('unavailable', 'unavailable');
    reply.status(STATUS[err.code] ?? 500).header('cache-control', 'no-store');
    if (err.retryAfterSeconds !== undefined) reply.header('retry-after', String(Math.max(1, Math.ceil(err.retryAfterSeconds))));
    return reply.send({ code: err.code });
  }

  /** Same owner as the credential, and a live run (the run of the request when it names one). */
  private async authorize(req: CallbackRequest, body: { owner_id: string; run_id?: string }): Promise<void> {
    if (!req.storeOwnerId || body.owner_id.toLowerCase() !== req.storeOwnerId) throw new SecretsProviderError('unauthorized', 'owner');
    // A run id that is not a UUID is not a run of this console: refused, not a database error.
    if (body.run_id !== undefined && !UUID.test(body.run_id)) throw new SecretsProviderError('refused', 'no live run');
    const live = await this.prisma.run.findFirst({ where: { userId: req.storeOwnerId, status: { in: [...LIVE_RUN_STATUSES] }, ...(body.run_id ? { id: body.run_id } : {}) }, select: { id: true } });
    if (!live) throw new SecretsProviderError('refused', 'no live run');
  }

  private async handle<T extends { owner_id: string; run_id?: string }>(schema: z.ZodType<T>, raw: unknown, req: CallbackRequest, reply: FastifyReply, work: (b: T) => Promise<FastifyReply>): Promise<FastifyReply> {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return reply.status(400).header('cache-control', 'no-store').send({ code: 'refused' });
    try {
      await this.authorize(req, parsed.data);
      return await work(parsed.data);
    } catch (e) {
      return this.fail(reply, e);
    }
  }

  @Post('lookup')
  @HttpCode(200)
  lookup(@Body() raw: unknown, @Req() req: CallbackRequest, @Res() reply: FastifyReply): Promise<FastifyReply> {
    return this.handle(lookupBody, raw, req, reply, async (b) => {
      const items = await this.provider.lookup(b.owner_id, b.origin, b.kind);
      return reply.status(200).header('cache-control', 'no-store').send({ items: items.map((i) => ({ id: i.id, name: i.name, username: i.username ?? null, origins: i.origins, match_kind: i.matchKind, has_code: i.hasCode, updated_at: i.updatedAt?.toISOString() ?? null })) });
    });
  }

  @Post('release')
  @HttpCode(200)
  release(@Body() raw: unknown, @Req() req: CallbackRequest, @Res() reply: FastifyReply): Promise<FastifyReply> {
    return this.handle(releaseBody, raw, req, reply, async (b) => {
      const secret = await this.provider.release({ ownerId: b.owner_id, itemId: b.item_id, field: b.field as SecretField, origin: b.origin, purpose: b.purpose as SecretPurpose, runId: b.run_id, clientLabel: b.client_label });
      return this.sendBytes(reply, secret, {});
    });
  }

  @Post('code')
  @HttpCode(200)
  code(@Body() raw: unknown, @Req() req: CallbackRequest, @Res() reply: FastifyReply): Promise<FastifyReply> {
    return this.handle(codeBody, raw, req, reply, async (b) => {
      const { value, expiresAt } = await this.provider.oneTimeCode({ ownerId: b.owner_id, itemId: b.item_id, origin: b.origin, purpose: b.purpose as SecretPurpose, runId: b.run_id, clientLabel: b.client_label });
      return this.sendBytes(reply, value, { 'x-expires-at': expiresAt.toISOString() });
    });
  }

  /**
   * `save` (#712): the owner's sign-in typed by hand. Bound to the owner of the credential only: the owner presses Save on the
   * card when they like, possibly after the run ended, so no live run is required (the fabric still refuses without its copy of
   * the password, which it holds ten minutes). The body's password is taken into a buffer at once and wiped after the call.
   */
  @Post('save')
  @HttpCode(201)
  async save(@Body() raw: unknown, @Req() req: CallbackRequest, @Res() reply: FastifyReply): Promise<FastifyReply> {
    const parsed = saveBody.safeParse(raw);
    if (!parsed.success) return reply.status(400).header('cache-control', 'no-store').send({ code: 'refused' });
    const b = parsed.data;
    const password = Buffer.from(b.password, 'utf8');
    try {
      if (!req.storeOwnerId || b.owner_id.toLowerCase() !== req.storeOwnerId) throw new SecretsProviderError('unauthorized', 'owner');
      const saved = await this.provider.saveLogin({ ownerId: b.owner_id, name: b.name, username: b.username, origin: b.origin, password, ...(b.client_label ? { clientLabel: b.client_label } : {}) });
      return reply.status(201).header('cache-control', 'no-store').send({ id: saved.id });
    } catch (e) {
      return this.fail(reply, e);
    } finally {
      password.fill(0);
    }
  }

  /** Writes the bytes as the body and zeroes them once the response has gone out. Never a string. */
  private sendBytes(reply: FastifyReply, secret: { expose<R>(fn: (b: Buffer) => R): R; wipe(): void }, headers: Record<string, string>): FastifyReply {
    const wipe = () => secret.wipe();
    reply.raw.once('finish', wipe);
    reply.raw.once('close', wipe);
    reply.status(200).header('cache-control', 'no-store').header('content-type', 'application/octet-stream').headers(headers);
    return secret.expose((bytes) => reply.send(bytes));
  }
}
