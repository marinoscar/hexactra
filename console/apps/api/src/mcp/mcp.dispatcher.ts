// Method routing of the console's MCP server: one JSON-RPC message in, one
// response (or none, for a notification) out. Version-specific behaviour is
// read from the request context's flags (mcp.protocol.ts); the transport
// (status codes, headers, Origin, batches) is the controller's.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { resolveApiVersion } from '@marinoscar/platform-api/host';
import { buildBearerChallenge } from '@marinoscar/platform-api/identity';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { z } from 'zod';

import { QuestionEvents } from '../questions/question-events';
import { RunEvents } from '../tasks/run-events';
import { ELICIT_KEY, ELICITING_TOOLS, argsDigest, clientCanElicitForm, openState, sealState } from './mcp.elicitation';
import { McpMetrics, MCP_METRIC_METHODS } from './mcp.metrics';
import { watchRun, type RunEventSource } from './mcp.run-watch';
import { MCP_DEFAULT_SETTINGS } from './mcp.settings';
import { LIST_CACHE_SCOPE, LIST_TTL_MS, META, SUPPORTED_VERSIONS, clientBucket, negotiateInitialize, type McpRequestContext, type RpcMessage } from './mcp.protocol';
import { McpApiError, mapUnknownError } from './mcp.errors';
import { MCP_CLIENT_HEADER, mcpClientHeaderValue } from '../connected-apps/request-client';
import {
  RPC,
  errorResult,
  finalizeResult,
  limitsFor,
  rpcError,
  rpcResult,
  withDeadline,
  type McpContext,
  type McpCredentialKind,
  type McpElicitResponse,
  type McpElicitationContext,
  type McpLimits,
  type McpToolResult,
  type RpcId,
  type RpcResponse,
} from './mcp.results';
import { MCP_TOOLS, instructionsFor, toolAnnotations, type McpTool } from './mcp.tools';
import { challengeScopes, isScopeGated, missingScopes, scopeUsable, toolAccess, toolScopes, type GatePrincipal, type ToolAccess } from './mcp.access';
import { MCP_OAUTH_RESOURCE_ID } from './mcp.scopes';
import { McpActivityService, activityDetail, activityTargets, type McpActivityOutcome } from './mcp-activity.service';
import { redactToolResult } from './mcp.redact';
import { RequestClientService } from '../connected-apps/request-client';
import { FabricClient } from '../fabric/fabric.client';
import {
  MCP_APP_MIME,
  MCP_APPS_EXTENSION_ID,
  MCP_UI_RESOURCES,
  cardKey,
  clientSupportsApps,
  loadUiResource,
  toolUiMeta,
  uiDomainFor,
  uiResourceAvailable,
  uiResourceListEntry,
  uiResourceMeta,
} from './mcp.apps';

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? String(v[0]) : v === undefined ? undefined : String(v);
}

/**
 * How a tool's REST sub-request reaches the console: the controller passes the
 * platform's in-process delegation (`InProcessDelegation.inject`), so the
 * sub-request runs as the caller's principal, with an OAuth token's narrowed
 * permissions, whatever the credential kind (#459). A string is an
 * `Authorization` value forwarded as is: only for direct dispatcher calls in
 * tests, which have no originating HTTP request to delegate from.
 */
export type McpCaller = ((options: InjectOptions) => Promise<LightMyRequestResponse>) | string;

/** What the tools are told about the credential (`McpContext.credential`), from the guard's record. */
export function toolCredential(rctx: Pick<McpRequestContext, 'credential'>): McpContext['credential'] {
  const c = rctx.credential;
  if (!c) return undefined;
  if (c.kind === 'oauth') {
    return {
      kind: 'oauth',
      // The guard always records scopes, client and grant for `oauth`; copied only when present.
      ...(Array.isArray(c.scopes) ? { scopes: [...c.scopes] } : {}),
      ...(c.clientId ? { clientId: c.clientId } : {}),
      ...(c.grantId ? { grantId: c.grantId } : {}),
    };
  }
  return { kind: c.kind as McpCredentialKind };
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
  return 'Follow it with run_wait or runs_list.';
}

/** The answer of a call that passed its server-side deadline: a normal result, never a hung request. */
export function stillWorking(tool: McpTool, limits: McpLimits): McpToolResult {
  const s = Math.round((limits.deadlineMs ?? 0) / 1000);
  return { content: [{ type: 'text', text: `${tool.name} is still working after ${s} seconds; the work continues on the server. ${followUp(tool.name)}` }] };
}

/** Appended to the description of a tool an OAuth app may ask the user to allow (#460). */
export const STEP_UP_NOTE = 'Needs extra permission: the user will be asked to allow it.';

/** The tool error of a call the user's own account may not make (#460): no consent can help. */
export const FORBIDDEN_TOOL_TEXT = 'Your Hexactra account is not allowed to do this. Ask an administrator.';

/**
 * A tool's per-tool auth declaration for ChatGPT (`securitySchemes`, an
 * extension outside core MCP that other clients ignore): the OAuth scopes the
 * tool needs, its own first. On every tool for every caller. The shape
 * (`[{ type: 'oauth2', scopes }]`) follows the epic (#458) and is NOT yet
 * verified against OpenAI's documentation (unreachable from the build
 * environment): E33.10 (#468) verifies it with the real client.
 */
export function securitySchemes(t: Pick<McpTool, 'scope'>): Array<{ type: 'oauth2'; scopes: string[] }> {
  return [{ type: 'oauth2', scopes: toolScopes(t) }];
}

/**
 * One tool entry of `tools/list` for a revision: title and outputSchema only
 * where the revision has them; `_meta.ui` (MCP Apps, #466) when the tool
 * links a resource that can be served, or has a visibility; `securitySchemes`
 * always (#460); with `stepUp`, the description says the user will be asked.
 */
export function toolListEntry(
  t: McpTool,
  flags: { toolTitle: boolean; structuredContent: boolean },
  opts: { uiAvailable?: (uri: string) => boolean; stepUp?: boolean } = {},
): Record<string, unknown> {
  const resourceUri = t.ui && (opts.uiAvailable?.(t.ui.resourceUri) ?? true) ? t.ui.resourceUri : undefined;
  const meta = toolUiMeta(resourceUri, t.visibility);
  return {
    name: t.name,
    ...(flags.toolTitle ? { title: t.title } : {}),
    description: opts.stepUp ? `${t.description} ${STEP_UP_NOTE}` : t.description,
    inputSchema: z.toJSONSchema(t.input, { io: 'input' }),
    // `io: 'input'` keeps extra properties allowed: the REST shapes grow, and a client must not reject a newer field.
    ...(flags.structuredContent && t.output ? { outputSchema: z.toJSONSchema(t.output, { io: 'input' }) } : {}),
    annotations: toolAnnotations(t),
    securitySchemes: securitySchemes(t),
    ...(meta ? { _meta: meta } : {}),
  };
}

/**
 * The tools a caller is offered (#466): every model-visible tool, and an
 * app-only tool (`visibility: ["app"]`, the run card's helper) only to a
 * caller that can host MCP Apps: an app signed in with OAuth (the hosted
 * clients) or a client that declared the MCP Apps extension in this
 * request's capabilities. Personal access token clients keep exactly their
 * list. Calling an app-only tool works for every caller (a host on a
 * handshake revision sends no capabilities with `tools/list`).
 */
export function offeredTools(rctx: Pick<McpRequestContext, 'credential' | 'clientCapabilities'>): McpTool[] {
  const appsHost = credentialKindOf(rctx) === 'oauth' || clientSupportsApps(rctx.clientCapabilities);
  return MCP_TOOLS.filter((t) => !t.visibility || t.visibility.includes('model') || appsHost);
}

/**
 * The tools `tools/list` gives a caller (#460), in registry order: what
 * `offeredTools` offers, less, for an OAuth app, the `forbidden` tools, and
 * the `needs_scope` ones unless `advertiseStepUp` (they are then marked).
 * Every other caller gets exactly `offeredTools`.
 */
export function listedTools(rctx: Pick<McpRequestContext, 'credential' | 'clientCapabilities'>, principal: GatePrincipal | undefined, advertiseStepUp: boolean): Array<{ tool: McpTool; access: ToolAccess }> {
  return offeredTools(rctx)
    .map((tool) => ({ tool, access: toolAccess(tool, rctx.credential, principal) }))
    .filter((t) => t.access === 'allowed' || (t.access === 'needs_scope' && advertiseStepUp));
}

/** The scopes a step-up must add for these messages, or `null` when no `tools/call` among them needs one (#460). */
export function stepUpScopes(messages: readonly unknown[], rctx: Pick<McpRequestContext, 'credential'>, principal: GatePrincipal | undefined): string[] | null {
  if (!isScopeGated(rctx.credential)) return null;
  const missing = new Set<string>();
  for (const m of messages) {
    if (m === null || typeof m !== 'object' || (m as RpcMessage).method !== 'tools/call') continue;
    const name = String(((m as RpcMessage).params as { name?: unknown } | undefined)?.name ?? '');
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool || toolAccess(tool, rctx.credential, principal) !== 'needs_scope') continue;
    for (const s of missingScopes(tool, rctx.credential)) missing.add(s);
  }
  return missing.size > 0 ? [...missing] : null;
}

/**
 * The `WWW-Authenticate` value of a step-up (`403 insufficient_scope`): the
 * platform's challenge, whose `scope` lists every scope the token holds and
 * the missing ones.
 */
export function stepUpChallenge(rctx: Pick<McpRequestContext, 'credential'>, missing: readonly string[]): string {
  return buildBearerChallenge({
    resourceId: MCP_OAUTH_RESOURCE_ID,
    error: 'insufficient_scope',
    errorDescription: 'This tool needs more permission than the user allowed',
    scope: challengeScopes(rctx.credential, missing),
  });
}

/** What the transport knows about one request beyond the message: who it is and whether the client is still there. */
export interface DispatchExtra {
  /** The authenticated user (binds a `requestState` to its caller). */
  userId?: string;
  /**
   * The permissions the user's roles give, before an OAuth token's narrowing
   * (#460): tells a tool the user may allow (`needs_scope`) from one they may
   * not (`forbidden`). Absent: every missing scope counts as `needs_scope`.
   */
  userPermissions?: readonly string[];
  /** Aborted when the client disconnects: a waiting tool stops waiting. */
  signal?: AbortSignal;
  /** The organization the request acts in (the audit row, #465). */
  orgId?: string | null;
  /** The request id (the audit row, #465). */
  requestId?: string | null;
}

/** What one `tools/call` leaves for its audit row (#465). */
interface ToolCallTrace {
  tool?: string;
  args?: Record<string, unknown>;
  result?: McpToolResult;
  timedOut?: boolean;
}

/** An `ElicitResult` from a retry's `inputResponses`, or undefined when it is not one. */
function elicitResponseOf(v: unknown): McpElicitResponse | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as { action?: unknown; content?: unknown };
  if (r.action !== 'accept' && r.action !== 'decline' && r.action !== 'cancel') return undefined;
  const content = r.content !== null && typeof r.content === 'object' && !Array.isArray(r.content) ? (r.content as Record<string, unknown>) : undefined;
  return { action: r.action, ...(content ? { content } : {}) };
}

/** What the dispatcher answers: the JSON-RPC response and the HTTP status it wants (200 unless said). */
export interface DispatchOutcome {
  status: number;
  body: RpcResponse;
  /** HTTP headers the transport adds (a `401`'s `WWW-Authenticate`). */
  headers?: Record<string, string>;
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
    @Optional() private readonly runEvents?: RunEvents,
    @Optional() private readonly questionEvents?: QuestionEvents,
    @Optional() private readonly settings?: SystemSettingsService,
    @Optional() private readonly activity?: McpActivityService,
    @Optional() private readonly clients?: RequestClientService,
    @Optional() private readonly fabric?: FabricClient,
  ) {}

  /** Exact secret values a result must never carry: the fabric's service token, when configured (#465). */
  private async secretValues(): Promise<string[]> {
    try {
      const c = await this.fabric?.config();
      return c?.token ? [c.token] : [];
    } catch {
      return [];
    }
  }

  /**
   * The audit row of one `tools/call` from an OAuth app or a personal access
   * token (#465): who, which tool, its targets, the outcome and how long; of
   * the arguments only what `activityDetail` keeps. Never the result.
   */
  private async audit(rctx: McpRequestContext, extra: DispatchExtra, call: ToolCallTrace, out: DispatchOutcome | null, durationMs: number): Promise<void> {
    const c = rctx.credential;
    if (!this.activity || !extra.userId || !McpActivityService.audited(c)) return;
    const result = call.result;
    const code = typeof result?.structuredContent?.code === 'string' ? result.structuredContent.code : /\[([A-Z_]+)\]$/.exec(result?.content.find((x) => x.type === 'text')?.text ?? '')?.[1];
    let outcome: McpActivityOutcome = 'ok';
    if (!out || out.status === 401 || out.body.error) outcome = 'error';
    else if (code === 'CONFIRMATION_REQUIRED' || code === 'CONFIRMATION_PENDING') outcome = 'confirmation_required';
    else if (call.timedOut) outcome = 'still_working';
    else if (!result || result.isError || (out.body.result as McpToolResult | undefined)?.isError) outcome = 'error';
    const oauth = c?.kind === 'oauth';
    const clientId = oauth ? (c as { clientId?: string }).clientId ?? null : null;
    const clientName = oauth && clientId ? await this.clients?.displayName(clientId).catch(() => null) : (rctx.clientInfo?.name ?? null);
    await this.activity.record({
      userId: extra.userId,
      orgId: extra.orgId ?? null,
      credentialKind: c!.kind,
      clientId,
      clientName: clientName ?? null,
      grantId: oauth ? ((c as { grantId?: string }).grantId ?? null) : null,
      tool: call.tool ?? null,
      ...activityTargets(call.tool ?? '', call.args ?? {}, result?.structuredContent ?? null),
      outcome,
      errorCode: outcome === 'error' || outcome === 'confirmation_required' ? (code ?? (out?.body.error ? `RPC_${out.body.error.code}` : null)) : null,
      durationMs,
      requestId: extra.requestId ?? null,
      detail: call.tool && call.args ? activityDetail(call.tool, call.args) : null,
    });
  }

  /** The event sources a waiting tool listens on (no database access); empty without a run event source. */
  private runSources(): RunEventSource[] {
    if (!this.runEvents) return [];
    const runs = this.runEvents;
    const sources: RunEventSource[] = [(h) => runs.subscribe((e) => (e.type === 'run.cancel' || e.type === 'run.pause' ? undefined : h({ runId: e.runId, kind: e.type === 'run.step' ? 'step' : 'status' })))];
    const questions = this.questionEvents;
    if (questions) sources.push((h) => questions.subscribe((e) => h({ runId: e.runId, kind: 'question' })));
    return sources;
  }

  /** `mcp.elicitation` (system settings): on unless an administrator turned it off. */
  private async elicitationEnabled(): Promise<boolean> {
    try {
      const v = await this.settings?.getNamespace('mcp');
      return (v ?? MCP_DEFAULT_SETTINGS).elicitation !== false;
    } catch {
      return MCP_DEFAULT_SETTINGS.elicitation;
    }
  }

  /** `mcp.advertiseStepUpTools` (system settings): on unless an administrator turned it off. */
  private async advertiseStepUpTools(): Promise<boolean> {
    try {
      const v = await this.settings?.getNamespace('mcp');
      return (v ?? MCP_DEFAULT_SETTINGS).advertiseStepUpTools !== false;
    } catch {
      return MCP_DEFAULT_SETTINGS.advertiseStepUpTools;
    }
  }

  /** How tools reach the console: its REST routes, in-process, as the caller. */
  private toolContext(
    caller: McpCaller,
    credential: McpContext['credential'],
    limits: McpLimits,
    extra: { client?: string; clientName?: string | null; signal?: AbortSignal; elicitation?: McpElicitationContext } = {},
  ): McpContext {
    // Marks every sub-request as coming from the MCP endpoint, with the client's own name (#464). The REST routes
    // honour it only on a request the platform's in-process delegation injected (request-client.ts), never over the network.
    const marker = { [MCP_CLIENT_HEADER]: mcpClientHeaderValue(extra.clientName ?? undefined) };
    const send =
      typeof caller === 'string'
        ? (options: InjectOptions) => this.adapter.httpAdapter.getInstance<FastifyInstance>().inject({ ...options, headers: { ...options.headers, authorization: caller } })
        : caller;
    const call = async (method: string, path: string, body?: unknown, extra?: Record<string, string>) =>
      send({
        method: method as 'GET',
        url: `/api${path}`,
        headers: { ...extra, ...marker, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
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
      ...(credential ? { credential } : {}),
      limits,
      ...(process.env.APP_URL ? { appUrl: process.env.APP_URL } : {}),
      ...(extra.client ? { client: extra.client } : {}),
      ...(extra.signal ? { signal: extra.signal } : {}),
      ...(extra.elicitation ? { elicitation: extra.elicitation } : {}),
      ...(this.runEvents ? { watchRun: (runId: string) => watchRun(runId, this.runSources(), extra.signal) } : {}),
    };
  }

  /**
   * Answer one message under one span (`mcp <method>`). A notification gets
   * `null` (the transport answers `202`). The span and the metrics carry the
   * method, the tool name, the revision, the client, the credential kind and
   * whether it failed: never a token, an argument value or a result.
   */
  async dispatch(msg: RpcMessage, rctx: McpRequestContext, caller: McpCaller, userAgent?: string, extra: DispatchExtra = {}): Promise<DispatchOutcome | null> {
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
        const out = await this.route(msg, method, rctx, caller, { ...extra, client });
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

  private async route(msg: RpcMessage, method: string, rctx: McpRequestContext, caller: McpCaller, extra: DispatchExtra & { client?: string } = {}): Promise<DispatchOutcome | null> {
    const id = msg.id as RpcId | undefined;
    if (id === undefined) return null; // a notification: nothing to answer
    const { flags } = rctx;
    const principal: GatePrincipal | undefined = extra.userPermissions ? { permissions: extra.userPermissions } : undefined;
    // The instructions name only what the caller can use (#460): everything, except for an OAuth app.
    // An app signed in with OAuth (a hosted model) is also told not to take orders from page text (#465).
    const instructions = instructionsFor((scope) => scopeUsable(scope, rctx.credential, principal), { hosted: isScopeGated(rctx.credential) });
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
          instructions,
        });
      }
      case 'ping':
        // Removed in 2026-07-28 (changelog: "Remove ping").
        if (!flags.handshake) return notFound('Method not found: ping (removed in 2026-07-28)');
        return ok({});
      case 'server/discover':
        return ok({ supportedVersions: [...SUPPORTED_VERSIONS], capabilities: this.capabilities(), instructions }, true);
      case 'tools/list': {
        // Deterministic order: the registry's own order. An OAuth app sees what its consent covers, plus (by default) what it may ask for.
        const version = serverInfo().version;
        const advertise = isScopeGated(rctx.credential) ? await this.advertiseStepUpTools() : false;
        const tools = listedTools(rctx, principal, advertise).map(({ tool, access }) =>
          toolListEntry(tool, flags, { uiAvailable: (uri) => uiResourceAvailable(uri, version), stepUp: access === 'needs_scope' }),
        );
        return ok({ tools }, true);
      }
      case 'tools/call': {
        const started = Date.now();
        const call: ToolCallTrace = {};
        const out = await this.toolsCall(msg, id, rctx, caller, extra, principal, ok, call);
        await this.audit(rctx, extra, call, out, Date.now() - started);
        return out;
      }
      case 'resources/list': {
        // MCP Apps (#466): the `ui://` resources a tool this caller is offered links to, when built.
        const version = serverInfo().version;
        const linked = new Set(offeredTools(rctx).flatMap((t) => (t.ui ? [t.ui.resourceUri] : [])));
        const domain = uiDomainFor(extra.client, process.env.APP_URL);
        const resources = MCP_UI_RESOURCES.filter((r) => linked.has(r.uri) && loadUiResource(r, version) !== null).map((r) => uiResourceListEntry(r, domain));
        return ok({ resources }, true);
      }
      case 'resources/templates/list':
        return ok({ resourceTemplates: [] }, true);
      case 'resources/read': {
        const uri = String((msg.params as { uri?: unknown } | undefined)?.uri ?? '');
        const r = MCP_UI_RESOURCES.find((x) => x.uri === uri);
        const loaded = r ? loadUiResource(r, serverInfo().version) : null;
        if (r && loaded) {
          // The HTML holds no user data: any credential /api/mcp admits may read it.
          const domain = uiDomainFor(extra.client, process.env.APP_URL);
          return ok({ contents: [{ uri: r.uri, mimeType: MCP_APP_MIME, text: loaded.text, _meta: uiResourceMeta(r, domain) }] });
        }
        // Resource not found: -32602 from 2026-07-28, -32002 before (changelog, minor change 6).
        return { status: 200, body: rpcError(id, flags.perRequestMeta ? RPC.INVALID_PARAMS : RPC.RESOURCE_NOT_FOUND_LEGACY, `Resource not found: ${uri}`, { uri }) };
      }
      default:
        if (NOT_OFFERED.test(method)) return notFound(`Method not found: ${method} (not offered by this server)`);
        return notFound(`Method not found: ${method}`);
    }
  }

  /** One `tools/call`; `call` collects what the audit row needs (the tool, the parsed arguments, the result). */
  private async toolsCall(
    msg: RpcMessage,
    id: RpcId,
    rctx: McpRequestContext,
    caller: McpCaller,
    extra: DispatchExtra & { client?: string },
    principal: GatePrincipal | undefined,
    ok: (result: Record<string, unknown>, cacheable?: boolean) => DispatchOutcome,
    call: ToolCallTrace,
  ): Promise<DispatchOutcome> {
    const { flags } = rctx;
    const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown; inputResponses?: unknown; requestState?: unknown };
    const name = String(params.name ?? '');
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) return { status: 200, body: rpcError(id, RPC.INVALID_PARAMS, `Unknown tool ${name}`) };
    call.tool = tool.name;
    const kind = credentialKindOf(rctx);
    const limits = limitsFor(kind);
    const finalize = (r: McpToolResult) => finalizeResult(r, { structured: flags.structuredContent, limits });
    // The scope gate (#460). The transport answers `needs_scope` with `403 insufficient_scope` before
    // dispatching; reaching here with it (a direct dispatch) is refused as a tool error all the same.
    const access = toolAccess(tool, rctx.credential, principal);
    if (access === 'forbidden') return ok({ ...finalize(errorResult(FORBIDDEN_TOOL_TEXT)) });
    if (access === 'needs_scope') {
      return ok({ ...finalize(errorResult(`${tool.name} needs extra permission (${missingScopes(tool, rctx.credential).join(' ')}): reconnect the app and allow it.`)) });
    }
    const args = tool.input.safeParse(params.arguments ?? {});
    if (!args.success) return ok({ ...finalize(errorResult(`Invalid arguments: ${args.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)) });
    const data = args.data as Record<string, unknown>;
    call.args = data;
    // Multi round-trip elicitation (2026-07-28 only): whether this call may ask, and a retry's verified state and answer.
    let elicitation: McpElicitationContext | undefined;
    if (flags.multiRoundTrip && ELICITING_TOOLS.has(tool.name)) {
      const available = clientCanElicitForm(rctx.clientCapabilities) && (await this.elicitationEnabled());
      elicitation = { available };
      if (params.requestState !== undefined) {
        const state = openState(params.requestState, { sub: extra.userId ?? '', tool: tool.name, args: argsDigest(data) });
        if (!state) {
          return { status: 200, body: rpcError(id, RPC.INVALID_PARAMS, 'Invalid requestState: it was altered, has expired, or belongs to another call or user. Call the tool again without it.') };
        }
        const responses = params.inputResponses !== null && typeof params.inputResponses === 'object' ? (params.inputResponses as Record<string, unknown>) : {};
        const response = elicitResponseOf(responses[ELICIT_KEY]);
        elicitation.resume = { runId: state.runId, questionId: state.questionId, cursor: state.cursor, ...(response ? { response } : {}) };
      }
    }
    // An OAuth token that stops being valid while the tool works (its grant revoked): the whole request is a 401.
    let tokenGone = false;
    const work = tool.call(data, this.toolContext(caller, toolCredential(rctx), limits, { client: extra.client, clientName: rctx.clientInfo?.name ?? (extra.client && extra.client !== 'other' ? extra.client : null), signal: extra.signal, elicitation })).catch((e: unknown) => {
      if (e instanceof McpApiError && e.status === 401 && kind === 'oauth') tokenGone = true;
      if (e instanceof McpApiError) {
        // The original answer stays in the log (with its request id); the model gets a sentence.
        this.log.warn(`mcp tool ${tool.name} failed: ${e.status} ${e.code} ${e.message.slice(0, 300)}${e.requestId ? ` request=${e.requestId}` : ''}`);
      } else {
        this.log.error(`mcp tool ${tool.name} threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      }
      return mapUnknownError(e, tool.name);
    });
    let timedOut = false;
    const raw = await withDeadline(work, limits.deadlineMs, () => {
      timedOut = true;
      return stillWorking(tool, limits);
    });
    // No result carries the console's own tokens (#465): a page can hold one, and browser_evaluate reads anything.
    const result = redactToolResult(raw, await this.secretValues());
    call.result = result;
    call.timedOut = timedOut;
    if (tokenGone) return tokenRevoked(id);
    if (result.inputRequired && flags.multiRoundTrip) {
      // Ask the client's user (MRTR): the request state is signed, bound to the caller, this call and an expiry.
      const st = result.inputRequired.state;
      const requestState = sealState({ v: 1, tool: tool.name, args: argsDigest(data), sub: extra.userId ?? '', exp: Number.isFinite(st.expiresAt) ? st.expiresAt : Date.now() + 15 * 60_000, runId: st.runId, questionId: st.questionId, cursor: st.cursor });
      return {
        status: 200,
        body: rpcResult(id, { resultType: 'input_required', inputRequests: result.inputRequired.inputRequests, requestState, _meta: { [META.serverInfo]: serverInfo() } }),
      };
    }
    // The output schemas are checked by the tests against real REST answers; outside production a
    // mismatch is logged (never refused: the answer is still useful).
    if (tool.output && result.structuredContent && !result.isError && process.env.NODE_ENV !== 'production') {
      const check = tool.output.safeParse(result.structuredContent);
      if (!check.success) this.log.warn(`mcp tool ${tool.name}: structuredContent does not match its output schema: ${check.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    return ok({ ...finalize(withCardKey(tool, withoutSchemaBreakingError(tool, result))) });
        }

  /** What the server offers: tools, the `ui://` resources and the MCP Apps extension (#466); no tasks extension. */
  private capabilities(): Record<string, unknown> {
    return { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME] } } };
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
 * The answer to an OAuth app whose token stopped being valid during a call
 * (#460, "Error handling"): HTTP `401` with the platform's `invalid_token`
 * challenge for the whole request, so the client signs in again, never a tool
 * error the model would read.
 */
export function tokenRevoked(id: RpcId): DispatchOutcome {
  let challenge: string | undefined;
  try {
    challenge = buildBearerChallenge({ resourceId: MCP_OAUTH_RESOURCE_ID, error: 'invalid_token', errorDescription: 'The access token is invalid or expired' });
  } catch {
    // No APP_URL: the 401 stands without the header.
  }
  return { status: 401, body: rpcError(id, RPC.INVALID_REQUEST, 'Unauthorized: the access token is no longer valid; sign in again'), ...(challenge ? { headers: { 'www-authenticate': challenge } } : {}) };
}

/**
 * A result that opens a run card carries the card's supersession key
 * (`card_key`: server time and a counter) in `structuredContent`, so the
 * newest card of a run keeps polling and older ones stop (#466). Not in the
 * text, and not on errors.
 */
export function withCardKey(tool: Pick<McpTool, 'ui'>, result: McpToolResult): McpToolResult {
  if (!tool.ui || result.isError || !result.structuredContent) return result;
  return { ...result, structuredContent: { ...result.structuredContent, card_key: cardKey() } };
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
