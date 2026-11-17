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
import { RPC, errorResult, rpcError, rpcResult, type McpContext, type McpToolResult, type RpcId, type RpcResponse } from './mcp.results';
import { MCP_INSTRUCTIONS, MCP_TOOLS, READ_ONLY_TOOLS } from './mcp.tools';

/** An error a REST route answered with, shown to the model as a tool error. */
class ApiCallError extends Error {}

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
  private toolContext(authorization: string): McpContext {
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
        const parsed = res.body ? (JSON.parse(res.body) as { data?: T; message?: string; code?: string }) : {};
        if (res.statusCode >= 400) throw new ApiCallError(`${res.statusCode} ${parsed.code ?? ''}: ${parsed.message ?? res.statusMessage}`.trim());
        return (parsed.data ?? parsed) as T;
      },
      async bytes(path: string) {
        const res = await call('GET', path);
        if (res.statusCode >= 400) throw new ApiCallError(`${res.statusCode}: could not fetch ${path}`);
        return { mime: String(res.headers['content-type'] ?? 'application/octet-stream'), data: res.rawPayload };
      },
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
        return ok(
          {
            tools: MCP_TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: z.toJSONSchema(t.input, { io: 'input' }),
              annotations: READ_ONLY_TOOLS.has(t.name) ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: t.name === 'run_cancel' || t.name === 'browser_close', openWorldHint: true },
            })),
          },
          true,
        );
      case 'tools/call': {
        const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = String(params.name ?? '');
        const tool = MCP_TOOLS.find((t) => t.name === name);
        if (!tool) return { status: 200, body: rpcError(id, RPC.INVALID_PARAMS, `Unknown tool ${name}`) };
        const args = tool.input.safeParse(params.arguments ?? {});
        if (!args.success) return ok({ ...errorResult(`Invalid arguments: ${args.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`) });
        let result: McpToolResult;
        try {
          result = await tool.call(args.data as Record<string, unknown>, this.toolContext(authorization));
        } catch (e) {
          result = errorResult(e instanceof Error ? e.message : String(e));
        }
        // structuredContent is a 2025-06-18 field: older clients get the text blocks only.
        if (!flags.structuredContent && result.structuredContent !== undefined) {
          const { structuredContent: _omit, ...rest } = result;
          result = rest;
        }
        return ok({ ...result });
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
