// Method routing of the console's MCP server: one JSON-RPC message in, one
// response (or none, for a notification) out. Version-specific behaviour is
// read from the request context's flags (mcp.protocol.ts); the transport
// (status codes, headers, Origin, batches) is the controller's.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { resolveApiVersion } from '@marinoscar/platform-api/host';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { McpMetrics, MCP_METRIC_METHODS } from './mcp.metrics';
import { LIST_CACHE_SCOPE, LIST_TTL_MS, META, SUPPORTED_VERSIONS, clientBucket, negotiateInitialize, type McpRequestContext, type RpcMessage } from './mcp.protocol';
import { McpApiError, mapUnknownError } from './mcp.errors';
import { RPC, errorResult, finalizeResult, limitsFor, rpcError, rpcResult, withDeadline, type McpContext, type McpCredentialKind, type McpLimits, type McpToolResult, type RpcId, type RpcResponse } from './mcp.results';
import { MCP_INSTRUCTIONS, MCP_TOOLS, toolAnnotations, type McpTool } from './mcp.tools';

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? String(v[0]) : v === undefined ? undefined : String(v);
}

/** The credential kind of a request as the tools see it (`oauth` from E33.1 on). */
export function credentialKindOf(rctx: Pick<McpRequestContext, 'credential'>): McpCredentialKind | undefined {
  return rctx.credential?.kind as McpCredentialKind | undefined;
}

/** How to follow work that outlived the deadline of a call. */
function followUp(tool: string): string {
  if (tool === 'ask_human' || tool === 'question_status' || tool === 'inbox_answer') return 'Follow it with question_status.';
  if (tool === 'browser_request_human' || tool === 'browser_handoff_status') return 'Follow it with browser_handoff_status.';
  if (tool.startsWith('browser_')) return 'Check the page with browser_screenshot before acting again.';
  return 'Follow it with run_status or runs_list.';
}

/** The answer of a call that passed its server-side deadline: a normal result, never a hung request. */
export function stillWorking(tool: McpTool, limits: McpLimits): McpToolResult {
  const s = Math.round((limits.deadlineMs ?? 0) / 1000);
  return { content: [{ type: 'text', text: `${tool.name} is still working after ${s} seconds; the work continues on the server. ${followUp(tool.name)}` }] };
}

/** One tool entry of `tools/list` for a revision: title and outputSchema only where the revision has them. */
export function toolListEntry(t: McpTool, flags: { toolTitle: boolean; structuredContent: boolean }): Record<string, unknown> {
  return {
    name: t.name,
    ...(flags.toolTitle ? { title: t.title } : {}),
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: 'input' }),
    // `io: 'input'` keeps extra properties allowed: the REST shapes grow, and a client must not reject a newer field.
    ...(flags.structuredContent && t.output ? { outputSchema: z.toJSONSchema(t.output, { io: 'input' }) } : {}),
    annotations: toolAnnotations(t),
  };
}

/** What the dispatcher answers: the JSON-RPC response and the HTTP status it wants (200 unless said). */
export interface DispatchOutcome {
  status: number;
  body: RpcResponse;
}

/** The server's identity; `version` is the console's own version. */
export function serverInfo(): { name: string; title: string; version: string } {
  return { name: 'hexactra-console', title: 'Hexactra', version: resolveApiVersion(__dirname) };
}

/** Methods offered on no revision (deprecated or not served): always `-32601`. */
const NOT_OFFERED = /^(logging\/setLevel|sampling\/|roots\/|prompts\/|completion\/|elicitation\/|tasks\/|subscriptions\/)/;

const tracer = trace.getTracer('hexactra-console.mcp');

@Injectable()
export class McpDispatcher {
  private readonly log = new Logger('McpDispatcher');

  constructor(
    private readonly adapter: HttpAdapterHost,
    @Optional() private readonly metrics: McpMetrics = new McpMetrics(),
  ) {}

  /** How tools reach the console: its REST routes, in-process, as the caller. */
  private toolContext(authorization: string, kind: McpCredentialKind | undefined, limits: McpLimits): McpContext {
    const fastify = this.adapter.httpAdapter.getInstance<FastifyInstance>();
    const call = async (method: string, path: string, body?: unknown, extra?: Record<string, string>) =>
      fastify.inject({
        method: method as 'GET',
        url: `/api${path}`,
        headers: { authorization, ...extra, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      });
    return {
      async api<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
        const res = await call(method, path, body, headers);
        if (res.statusCode === 204) return { ok: true } as T;
        let parsed: { data?: T; message?: unknown; code?: unknown; details?: unknown } = {};
        try {
          parsed = res.body ? JSON.parse(res.body) : {};
        } catch {
          parsed = { message: res.statusMessage };
        }
        if (res.statusCode >= 400) {
          const retry = Number(header(res.headers, 'retry-after'));
          throw new McpApiError(
            res.statusCode,
            typeof parsed.code === 'string' ? parsed.code : '',
            typeof parsed.message === 'string' ? parsed.message : Array.isArray(parsed.message) ? parsed.message.join('; ') : (res.statusMessage ?? ''),
            parsed.details,
            header(res.headers, 'x-request-id'),
            Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : undefined,
          );
        }
        return (parsed.data ?? parsed) as T;
      },
      async bytes(path: string) {
        const res = await call('GET', path);
        if (res.statusCode >= 400) throw new McpApiError(res.statusCode, 'SCREENSHOT_FAILED', 'could not fetch the screenshot', undefined, header(res.headers, 'x-request-id'));
        return { mime: String(res.headers['content-type'] ?? 'application/octet-stream'), data: res.rawPayload };
      },
      ...(kind ? { credential: { kind } } : {}),
      limits,
    };
  }

  /**
   * Answer one message under one span (`mcp <method>`). A notification gets
   * `null` (the transport answers `202`). The span and the metrics carry the
   * method, the tool name, the revision, the client, the credential kind and
   * whether it failed: never a token, an argument value or a result.
   */
  async dispatch(msg: RpcMessage, rctx: McpRequestContext, authorization: string, userAgent?: string): Promise<DispatchOutcome | null> {
    const method = typeof msg.method === 'string' ? msg.method : '';
    const toolName = method === 'tools/call' ? String((msg.params as { name?: unknown } | undefined)?.name ?? '').slice(0, 64) : undefined;
    const client = clientBucket(rctx.clientInfo?.name ?? userAgent);
    const credential = rctx.credential?.kind ?? 'none';
    return tracer.startActiveSpan(`mcp ${method || 'message'}`, async (span) => {
      span.setAttributes({
        'mcp.method': method.slice(0, 64),
        'mcp.protocol.version': rctx.version,
        'mcp.credential.kind': credential,
        ...(toolName ? { 'mcp.tool.name': toolName } : {}),
        ...(rctx.clientInfo ? { 'mcp.client.name': rctx.clientInfo.name.slice(0, 64) } : {}),
      });
      const started = Date.now();
      let isError = false;
      try {
        const out = await this.route(msg, method, rctx, authorization);
        isError = out !== null && (out.body.error !== undefined || (out.body.result as McpToolResult | undefined)?.isError === true);
        return out;
      } catch (e) {
        isError = true;
        span.recordException(e instanceof Error ? e : new Error(String(e)));
        throw e;
      } finally {
        span.setAttribute('mcp.result.is_error', isError);
        if (isError) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        const metricMethod = msg.id === undefined ? 'notification' : (MCP_METRIC_METHODS as readonly string[]).includes(method) ? method : 'other';
        this.metrics.message({ method: metricMethod, protocolVersion: rctx.version, client, credential, isError });
        if (toolName) this.metrics.tool({ tool: toolName, client, credential, isError }, (Date.now() - started) / 1000);
        this.log.log(`mcp ${method || '?'}${toolName ? ` ${toolName}` : ''} v${rctx.version} client=${client} credential=${credential}${isError ? ' (error)' : ''}`);
      }
    });
  }

  private async route(msg: RpcMessage, method: string, rctx: McpRequestContext, authorization: string): Promise<DispatchOutcome | null> {
    const id = msg.id as RpcId | undefined;
    if (id === undefined) return null; // a notification: nothing to answer
    const { flags } = rctx;
    const ok = (result: Record<string, unknown>, cacheable = false): DispatchOutcome => ({ status: 200, body: rpcResult(id, this.decorate(result, rctx, cacheable)) });
    // 2026-07-28 answers an unknown method with HTTP 404 (transport rule); earlier revisions inside a 200.
    const notFound = (message: string, data?: unknown): DispatchOutcome => ({ status: flags.perRequestMeta ? 404 : 200, body: rpcError(id, RPC.METHOD_NOT_FOUND, message, data) });

    switch (method) {
      case 'initialize': {
        if (!flags.handshake) {
          // A request marked 2026-07-28 does not open a session: the client is modern, so point it at server/discover.
          return notFound(`initialize is not part of protocol ${rctx.version}: call server/discover, or send initialize without a 2026-07-28 version to use a handshake revision. Supported: ${SUPPORTED_VERSIONS.join(', ')}`, {
            supported: [...SUPPORTED_VERSIONS],
          });
        }
        return ok({
          protocolVersion: negotiateInitialize((msg.params as { protocolVersion?: unknown } | undefined)?.protocolVersion),
          capabilities: this.capabilities(),
          serverInfo: serverInfo(),
          instructions: MCP_INSTRUCTIONS,
        });
      }
      case 'ping':
        // Removed in 2026-07-28 (changelog: "Remove ping").
        if (!flags.handshake) return notFound('Method not found: ping (removed in 2026-07-28)');
        return ok({});
      case 'server/discover':
        return ok({ supportedVersions: [...SUPPORTED_VERSIONS], capabilities: this.capabilities(), instructions: MCP_INSTRUCTIONS }, true);
      case 'tools/list':
        // Deterministic order: the registry's own order.
        return ok({ tools: MCP_TOOLS.map((t) => toolListEntry(t, flags)) }, true);
      case 'tools/call': {
        const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = String(params.name ?? '');
        const tool = MCP_TOOLS.find((t) => t.name === name);
        if (!tool) return { status: 200, body: rpcError(id, RPC.INVALID_PARAMS, `Unknown tool ${name}`) };
        const kind = credentialKindOf(rctx);
        const limits = limitsFor(kind);
        const finalize = (r: McpToolResult) => finalizeResult(r, { structured: flags.structuredContent, limits });
        const args = tool.input.safeParse(params.arguments ?? {});
        if (!args.success) return ok({ ...finalize(errorResult(`Invalid arguments: ${args.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)) });
        const work = tool.call(args.data as Record<string, unknown>, this.toolContext(authorization, kind, limits)).catch((e: unknown) => {
          if (e instanceof McpApiError) {
            // The original answer stays in the log (with its request id); the model gets a sentence.
            this.log.warn(`mcp tool ${tool.name} failed: ${e.status} ${e.code} ${e.message.slice(0, 300)}${e.requestId ? ` request=${e.requestId}` : ''}`);
          } else {
            this.log.error(`mcp tool ${tool.name} threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
          }
          return mapUnknownError(e, tool.name);
        });
        const result = await withDeadline(work, limits.deadlineMs, () => stillWorking(tool, limits));
        // The output schemas are checked by the tests against real REST answers; outside production a
        // mismatch is logged (never refused: the answer is still useful).
        if (tool.output && result.structuredContent && !result.isError && process.env.NODE_ENV !== 'production') {
          const check = tool.output.safeParse(result.structuredContent);
          if (!check.success) this.log.warn(`mcp tool ${tool.name}: structuredContent does not match its output schema: ${check.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        }
        return ok({ ...finalize(withoutSchemaBreakingError(tool, result)) });
      }
      case 'resources/list':
        // No resources until the MCP Apps (E33.8); the capability is not advertised.
        return ok({ resources: [] }, true);
      case 'resources/templates/list':
        return ok({ resourceTemplates: [] }, true);
      case 'resources/read': {
        const uri = String((msg.params as { uri?: unknown } | undefined)?.uri ?? '');
        // Resource not found: -32602 from 2026-07-28, -32002 before (changelog, minor change 6).
        return { status: 200, body: rpcError(id, flags.perRequestMeta ? RPC.INVALID_PARAMS : RPC.RESOURCE_NOT_FOUND_LEGACY, `Resource not found: ${uri}`, { uri }) };
      }
      default:
        if (NOT_OFFERED.test(method)) return notFound(`Method not found: ${method} (not offered by this server)`);
        return notFound(`Method not found: ${method}`);
    }
  }

  /** What the server offers. `resources` and the MCP Apps extension come with E33.8; no tasks extension. */
  private capabilities(): Record<string, unknown> {
    return { tools: { listChanged: false } };
  }

  /**
   * 2026-07-28 result fields: `resultType: "complete"` on every result,
   * the server's identity in `_meta`, and on cacheable results `ttlMs` with
   * the per-authorization `cacheScope` ("private": the list depends on the
   * caller). Earlier revisions get the result unchanged.
   */
  private decorate(result: Record<string, unknown>, rctx: McpRequestContext, cacheable: boolean): Record<string, unknown> {
    if (!rctx.flags.perRequestMeta) return result;
    return {
      ...result,
      resultType: 'complete',
      ...(cacheable && rctx.flags.listCacheHints ? { ttlMs: LIST_TTL_MS, cacheScope: LIST_CACHE_SCOPE } : {}),
      _meta: { ...((result._meta as Record<string, unknown> | undefined) ?? {}), [META.serverInfo]: serverInfo() },
    };
  }
}

/**
 * An error result of a tool that declares an `outputSchema` carries no
 * `structuredContent`: a client may validate it against that schema even when
 * `isError` is true, and `{ code, message }` would not match. The code moves
 * into the text instead, so the model still sees it.
 */
export function withoutSchemaBreakingError(tool: { output?: unknown }, result: McpToolResult): McpToolResult {
  if (!result.isError || !tool.output || !result.structuredContent) return result;
  const { structuredContent, ...rest } = result;
  const code = typeof structuredContent.code === 'string' ? structuredContent.code : undefined;
  if (!code) return rest;
  const content = rest.content.map((c, i) => (i === 0 && c.type === 'text' && !c.text.includes(code) ? { ...c, text: `${c.text} [${code}]` } : c));
  return { ...rest, content };
}
