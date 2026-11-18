import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, authCredentialOf, type RequestWithAuthCredential } from '@marinoscar/platform-api/identity';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { McpDispatcher } from './mcp.dispatcher';
import { MCP_VERSIONS, McpProtocolError, acceptsJson, isAllowedOrigin, requestContext, resolveVersion, type McpHeaders, type RpcMessage } from './mcp.protocol';
import { RPC, rpcError, type RpcId, type RpcResponse } from './mcp.results';

/** The endpoint, as Fastify sees it (the global `/api` prefix included). */
export const MCP_PATH = '/api/mcp';

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

function sendRpc(reply: FastifyReply, status: number, body: RpcResponse | RpcResponse[]): FastifyReply {
  return reply.code(status).header('content-type', 'application/json').send(JSON.stringify(body));
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
export function registerMcpTransport(fastify: Pick<FastifyInstance, 'addHook'>, appUrl: string | undefined): void {
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
 * like the rest of the API (a personal access token or a session). Every
 * tool calls the console's own REST routes in-process as the caller, so
 * permissions, validation, redaction and run recording are exactly the REST
 * API's. This class is HTTP only: methods are routed by `McpDispatcher`.
 */
@ApiTags('MCP')
@Controller('mcp')
export class McpController {
  constructor(private readonly dispatcher: McpDispatcher) {}

  @Post()
  @HttpCode(200)
  @Auth()
  async post(@Req() req: FastifyRequest, @Body() body: unknown, @Res() res: FastifyReply): Promise<void> {
    const authorization = String(req.headers.authorization ?? '');
    const userAgent = header(req, 'user-agent');
    const credential = authCredentialOf(req as FastifyRequest & RequestWithAuthCredential);
    const headers: McpHeaders = { protocolVersion: header(req, 'mcp-protocol-version'), method: header(req, 'mcp-method'), name: header(req, 'mcp-name') };
    // A waiting tool (run_wait) stops waiting when the client goes away; nothing it started is cancelled.
    const gone = new AbortController();
    res.raw.once('close', () => {
      if (!res.raw.writableEnded) gone.abort();
    });
    const extra = { userId: (req as FastifyRequest & { user?: { id?: string } }).user?.id, signal: gone.signal };

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
      const out = (
        await Promise.all(
          body.map(async (m: unknown): Promise<RpcResponse | null> => {
            const bad = invalid(m);
            if (bad) return bad;
            const msg = m as RpcMessage;
            try {
              const rctx = requestContext({ protocolVersion: headers.protocolVersion }, msg, credential);
              return (await this.dispatcher.dispatch(msg, rctx, authorization, userAgent, extra))?.body ?? null;
            } catch (e) {
              if (e instanceof McpProtocolError) return msg.id === undefined ? null : rpcError(idOf(msg) ?? null, e.code, e.message, e.data);
              throw e;
            }
          }),
        )
      ).filter((r): r is RpcResponse => r !== null);
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
    const out = await this.dispatcher.dispatch(msg, rctx, authorization, userAgent, extra);
    if (out === null) return void (await res.status(202).send());
    await sendRpc(res, out.status, out.body);
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
