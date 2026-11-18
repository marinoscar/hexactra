import { Body, Controller, Get, HttpCode, Optional, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, InProcessDelegation, authCredentialOf, type RequestWithAuthCredential } from '@marinoscar/platform-api/identity';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { RequestClientService } from '../connected-apps/request-client';
import { McpActivityService } from './mcp-activity.service';
import { McpSettingsReader } from './mcp-settings.reader';
import { userPermissionsOf } from './mcp.access';
import { McpKillSwitchGuard, McpRateLimitGuard, McpRefusalFilter, type McpUnauthenticatedLimit } from './mcp.rate-limit';
import { McpDispatcher, stepUpChallenge, stepUpScopes, type DispatchOutcome, type McpCaller } from './mcp.dispatcher';
import { MCP_VERSIONS, McpProtocolError, acceptsJson, isAllowedOrigin, isChatGptCaller, requestContext, resolveVersion, stepUpTransport, type McpHeaders, type McpRequestContext, type RpcMessage } from './mcp.protocol';
import { RPC, rpcError, type RpcId, type RpcResponse } from './mcp.results';

import { MCP_PATH } from './mcp.path';

export { MCP_PATH };

/**
 * `mcp.allowedOrigins`: browser origins allowed besides the console's own
 * (`APP_URL`) and loopback origins on any port. Empty by default: hosted
 * clients (ChatGPT, Claude) call from their servers, with no `Origin`.
 */
export const MCP_ALLOWED_ORIGINS: readonly string[] = [];

const CORS_ALLOW_HEADERS = 'authorization, content-type, mcp-protocol-version, mcp-method, mcp-name';
const CORS_EXPOSE_HEADERS = 'www-authenticate';

function isMcpPath(url: string): boolean {
  const path = url.split('?')[0].replace(/\/+$/, '');
  return path === MCP_PATH;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function sendRpc(reply: FastifyReply, status: number, body: RpcResponse | RpcResponse[], headers: Record<string, string> = {}): FastifyReply {
  for (const [k, v] of Object.entries(headers)) reply.header(k, v);
  return reply.code(status).header('content-type', 'application/json').send(JSON.stringify(body));
}

/** The words of a step-up, the same in both forms. */
export function stepUpText(missing: readonly string[]): string {
  return `This tool needs permission the user has not given this app yet (${missing.join(' ')}). Ask the user to allow it.`;
}

/**
 * Step-up (#460): the whole HTTP request is refused with `403` and the
 * platform's `insufficient_scope` challenge, whose `scope` lists the scopes
 * the token holds and the missing ones. Claude starts re-consent on this
 * status and header.
 */
function sendStepUp(reply: FastifyReply, challenge: string, missing: readonly string[]): FastifyReply {
  return reply
    .code(403)
    .header('www-authenticate', challenge)
    .header('content-type', 'application/json')
    .header('cache-control', 'no-store')
    .send(JSON.stringify({ error: 'insufficient_scope', error_description: stepUpText(missing) }));
}

/** The `_meta` key ChatGPT reads a tool's authentication challenge from (#531). */
export const WWW_AUTHENTICATE_META = 'mcp/www_authenticate';

/**
 * Step-up as a tool result (#531): ChatGPT's documented form. A `200` with a
 * JSON-RPC result that is a tool error with the same words as the `403`
 * body, and the very `WWW-Authenticate` value in
 * `_meta["mcp/www_authenticate"]` (an array of challenges). No
 * `structuredContent`: there is no tool output to describe.
 */
export function stepUpToolResult(id: RpcId, challenge: string, missing: readonly string[]): RpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result: { isError: true, content: [{ type: 'text', text: stepUpText(missing) }], _meta: { [WWW_AUTHENTICATE_META]: [challenge] } },
  };
}

/**
 * The transport rules that must hold before authentication and outside the
 * route itself, as Fastify hooks on `/api/mcp` only:
 * - `Origin` (DNS rebinding): present and not allowed → `403`; allowed → the
 *   CORS answer (`Access-Control-Allow-Origin` echoing it, exposed
 *   `WWW-Authenticate`); absent → passes (server-to-server clients).
 * - `OPTIONS` → the CORS preflight (`204`).
 * - Any method but `POST` → `405` with `Allow: POST`.
 * - `Accept` without `application/json` (or a wildcard) → `406`.
 * - A body Fastify could not take (malformed JSON, over the 1 MiB body
 *   limit, not JSON) → a JSON-RPC error instead of the generic error body.
 * Called once by `createApp`, before the app initialises.
 */
export function registerMcpTransport(fastify: Pick<FastifyInstance, 'addHook'>, appUrl: string | undefined, opts: { unauthenticated?: McpUnauthenticatedLimit } = {}): void {
  fastify.addHook('onRequest', async (req, reply) => {
    if (!isMcpPath(req.url)) return;
    const origin = header(req, 'origin');
    if (origin !== undefined) {
      if (!isAllowedOrigin(origin, appUrl, MCP_ALLOWED_ORIGINS)) return sendRpc(reply, 403, rpcError(null, RPC.INVALID_REQUEST, `Origin ${origin.slice(0, 200)} is not allowed to call the MCP endpoint`));
      reply.header('access-control-allow-origin', origin).header('vary', 'Origin').header('access-control-expose-headers', CORS_EXPOSE_HEADERS);
    }
    if (req.method === 'OPTIONS') {
      return reply
        .code(204)
        .header('allow', 'POST, OPTIONS')
        .header('access-control-allow-methods', 'POST, OPTIONS')
        .header('access-control-allow-headers', CORS_ALLOW_HEADERS)
        .header('access-control-max-age', '86400')
        .send();
    }
    if (req.method !== 'POST') {
      reply.header('allow', 'POST');
      return sendRpc(reply, 405, rpcError(null, RPC.INVALID_REQUEST, `Method ${req.method} not allowed: the MCP endpoint accepts POST only (no server-initiated stream, no sessions)`));
    }
    if (!acceptsJson(header(req, 'accept'))) return sendRpc(reply, 406, rpcError(null, RPC.INVALID_REQUEST, 'Not acceptable: this endpoint answers application/json only'));
    return;
  });

  fastify.addHook('onSend', async (req, reply, payload) => {
    if (!isMcpPath(req.url) || req.method !== 'POST') return payload;
    const status = reply.statusCode;
    // The unauthenticated limit (#465): every 401 counts against its source address; over the limit it becomes a 429.
    if (status === 401 && opts.unauthenticated) {
      const wait = await opts.unauthenticated.over(req.ip, header(req, 'user-agent'));
      if (wait !== null) {
        reply.code(429).header('retry-after', String(wait)).header('content-type', 'application/json');
        reply.removeHeader('www-authenticate');
        return JSON.stringify(rpcError(null, RPC.RATE_LIMITED, `Too many unauthenticated requests from this address. Wait ${wait} seconds and try again.`, { retryAfterS: wait }));
      }
      return payload;
    }
    if (status !== 400 && status !== 413 && status !== 415) return payload;
    if (typeof payload === 'string' && payload.includes('"jsonrpc"')) return payload; // our own answer
    reply.header('content-type', 'application/json');
    if (status === 413) return JSON.stringify(rpcError(null, RPC.INVALID_REQUEST, 'Request body too large (the limit is 1 MiB)'));
    if (status === 415) return JSON.stringify(rpcError(null, RPC.INVALID_REQUEST, 'Unsupported media type: send application/json'));
    return JSON.stringify(rpcError(null, RPC.PARSE_ERROR, 'Parse error'));
  });
}

/** A message's id when it is a valid JSON-RPC id (string, number or null). */
function idOf(msg: RpcMessage): RpcId | undefined {
  const id = msg.id;
  if (id === undefined) return undefined;
  return typeof id === 'string' || typeof id === 'number' || id === null ? id : undefined;
}

/** `-32600` for a message that is not a JSON-RPC 2.0 request or notification; `null` when it is one. */
function invalid(msg: unknown): RpcResponse | null {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, RPC.INVALID_REQUEST, 'Invalid Request: a JSON-RPC message is an object');
  const m = msg as RpcMessage;
  const id = idOf(m) ?? null;
  if (m.jsonrpc !== '2.0') return rpcError(id, RPC.INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"');
  if (m.id !== undefined && idOf(m) === undefined) return rpcError(null, RPC.INVALID_REQUEST, 'Invalid Request: id must be a string, a number or null');
  if (typeof m.method !== 'string' || m.method === '') return rpcError(id, RPC.INVALID_REQUEST, 'Invalid Request: method is required (this server accepts requests and notifications only)');
  if (m.params !== undefined && (m.params === null || typeof m.params !== 'object' || Array.isArray(m.params))) return rpcError(id, RPC.INVALID_REQUEST, 'Invalid Request: params must be an object');
  return null;
}

/**
 * `POST /api/mcp`: the Model Context Protocol over Streamable HTTP
 * (stateless, one JSON response per request, never a session), for every
 * revision from 2024-11-05 to 2026-07-28 (mcp.protocol.ts), authenticated
 * like the rest of the API (a session, a personal access token or, from
 * #459, an OAuth `oat_` token: this path is the protected resource `mcp`, so a
 * missing or bad credential is a 401 with the platform's `WWW-Authenticate`
 * challenge). Every tool calls the console's own REST routes in-process as the
 * caller (`InProcessDelegation`), so permissions (an OAuth token's narrowed
 * ones included), validation, redaction and run recording are exactly the
 * REST API's. This class is HTTP only: methods are routed by `McpDispatcher`.
 */
@ApiTags('MCP')
@Controller('mcp')
@UseFilters(McpRefusalFilter)
export class McpController {
  constructor(
    private readonly dispatcher: McpDispatcher,
    private readonly delegation: InProcessDelegation,
    @Optional() private readonly activity?: McpActivityService,
    @Optional() private readonly settings?: McpSettingsReader,
    @Optional() private readonly clients?: RequestClientService,
  ) {}

  /**
   * Which form a step-up takes for this request (#531): the `mcp.stepUpForm`
   * setting, and for `auto` whether the caller is ChatGPT (its OAuth
   * client's hosts, or the request's `clientInfo.name`). A batch keeps the
   * `403`: hosted clients send one call per request.
   */
  private async stepUpForm(credential: ReturnType<typeof authCredentialOf>, rctx: Pick<McpRequestContext, 'clientInfo'> | undefined): Promise<'http' | 'tool'> {
    if (credential?.kind !== 'oauth') return 'http';
    const setting = (await this.settings?.read())?.stepUpForm ?? 'auto';
    if (setting !== 'auto') return stepUpTransport(setting, credential.kind, false);
    const clientHosts = (await this.clients?.clientHosts(credential.clientId).catch(() => [])) ?? [];
    return stepUpTransport(setting, credential.kind, isChatGptCaller({ clientHosts, clientInfoName: rctx?.clientInfo?.name }));
  }

  @Post()
  @HttpCode(200)
  // After authentication (#465): the kill switches, then the rate limits (a 503 or a 429 with a JSON-RPC body).
  @UseGuards(McpKillSwitchGuard, McpRateLimitGuard)
  @Auth()
  async post(@Req() req: FastifyRequest, @Body() body: unknown, @Res() res: FastifyReply): Promise<void> {
    // Tools call the REST routes in-process as THIS caller, through the platform's
    // delegation: never by forwarding the Authorization header (an `oat_` token is
    // confined to /api/mcp and would be refused elsewhere; a delegation keeps the
    // principal, its credential kind and an OAuth token's narrowed permissions).
    const caller: McpCaller = (options) => this.delegation.inject(req, options);
    const userAgent = header(req, 'user-agent');
    const credential = authCredentialOf(req as FastifyRequest & RequestWithAuthCredential);
    const headers: McpHeaders = { protocolVersion: header(req, 'mcp-protocol-version'), method: header(req, 'mcp-method'), name: header(req, 'mcp-name') };
    // A waiting tool (run_wait) stops waiting when the client goes away; nothing it started is cancelled.
    const gone = new AbortController();
    res.raw.once('close', () => {
      if (!res.raw.writableEnded) gone.abort();
    });
    const user = (req as FastifyRequest & { user?: { id?: string; orgId?: string; activeOrgId?: string | null } }).user;
    // An OAuth app is gated by its token's scopes (#460): the user's own permissions tell what step-up could add.
    const userPermissions = credential?.kind === 'oauth' ? userPermissionsOf(user) : undefined;
    const extra = { userId: user?.id, orgId: user?.activeOrgId ?? user?.orgId ?? null, requestId: typeof req.id === 'string' ? req.id : null, signal: gone.signal, ...(userPermissions ? { userPermissions } : {}) };
    const principal = userPermissions ? { permissions: userPermissions } : undefined;
    // A tools/call the token's scopes do not cover, but the user may allow: 403 for the whole request,
    // before anything runs (a batch mixing it with allowed calls is refused as a whole).
    const stepUp = (messages: readonly unknown[], single?: { id: RpcId | undefined; rctx: McpRequestContext }) => {
      const missing = stepUpScopes(messages, { credential }, principal);
      if (!missing) return null;
      return async () => {
        await this.activity?.refusal(req, 'step_up', { missing: missing.join(' ') });
        const challenge = stepUpChallenge({ credential }, missing);
        // A tool error result only for one tools/call with an id (#531); a batch, or a call sent as a notification, gets the 403.
        if (single && single.id !== undefined && (await this.stepUpForm(credential, single.rctx)) === 'tool') {
          res.header('cache-control', 'no-store');
          return void (await sendRpc(res, 200, stepUpToolResult(single.id, challenge, missing)));
        }
        void sendStepUp(res, challenge, missing);
      };
    };

    if (Array.isArray(body)) {
      // Batches exist in 2025-03-26 only (and a request with no version header is 2025-03-26).
      let version;
      try {
        version = resolveVersion({ protocolVersion: headers.protocolVersion }, {});
      } catch (e) {
        if (e instanceof McpProtocolError) return void (await sendRpc(res, e.httpStatus, rpcError(null, e.code, e.message, e.data)));
        throw e;
      }
      if (!MCP_VERSIONS[version].batching) return void (await sendRpc(res, 400, rpcError(null, RPC.INVALID_REQUEST, `Invalid Request: JSON-RPC batches are not part of protocol ${version} (only 2025-03-26)`)));
      if (body.length === 0) return void (await sendRpc(res, 400, rpcError(null, RPC.INVALID_REQUEST, 'Invalid Request: an empty batch')));
      const refuse = stepUp(body.filter((m) => invalid(m) === null));
      if (refuse) return void (await refuse());
      const outcomes = await Promise.all(
        body.map(async (m: unknown): Promise<DispatchOutcome | RpcResponse | null> => {
          const bad = invalid(m);
          if (bad) return bad;
          const msg = m as RpcMessage;
          try {
            const rctx = requestContext({ protocolVersion: headers.protocolVersion }, msg, credential);
            return await this.dispatcher.dispatch(msg, rctx, caller, userAgent, extra);
          } catch (e) {
            if (e instanceof McpProtocolError) return msg.id === undefined ? null : rpcError(idOf(msg) ?? null, e.code, e.message, e.data);
            throw e;
          }
        }),
      );
      // A token that stopped being valid during one call: the whole batch is that 401.
      const unauthorized = outcomes.find((o): o is DispatchOutcome => o !== null && 'status' in o && o.status === 401);
      if (unauthorized) return void (await sendRpc(res, 401, unauthorized.body, unauthorized.headers));
      const out = outcomes.map((o) => (o !== null && 'status' in o ? o.body : o)).filter((r): r is RpcResponse => r !== null);
      if (out.length === 0) return void (await res.status(202).send());
      return void (await sendRpc(res, 200, out));
    }

    const bad = invalid(body);
    if (bad) return void (await sendRpc(res, 400, bad));
    const msg = body as RpcMessage;
    let rctx;
    try {
      rctx = requestContext(headers, msg, credential);
    } catch (e) {
      if (e instanceof McpProtocolError) return void (await sendRpc(res, e.httpStatus, rpcError(idOf(msg) ?? null, e.code, e.message, e.data)));
      throw e;
    }
    const refuse = stepUp([msg], { id: idOf(msg), rctx });
    if (refuse) return void (await refuse());
    const out = await this.dispatcher.dispatch(msg, rctx, caller, userAgent, extra);
    if (out === null) return void (await res.status(202).send());
    await sendRpc(res, out.status, out.body, out.headers);
  }

  /**
   * No server-initiated stream (stateless server). The transport hook answers
   * `GET` and `DELETE` (no route: there are no sessions to end) before this.
   */
  @Get()
  @Auth()
  get(@Res() res: FastifyReply): void {
    void res.status(405).header('allow', 'POST').send();
  }
}
