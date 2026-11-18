// The audit trail of external AI apps (#465): one sanitized row per
// `tools/call` from an OAuth app or a personal access token (written by the
// dispatcher), per refusal the console makes on its own (kill switch, rate
// limit, step-up) and per change of an app's limits. The trail is the
// Execution Events of VISION §27, not OpenTelemetry.
//
// What a row may hold of the call's arguments is a closed list
// (`activityDetail`): the goal's first 200 characters (run_goal,
// task_create), the URL's host (navigation), the selector (clicks), a
// script's SHA-256 and length (browser_evaluate). Never typed text, never a
// script, never a result, never a token.
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { authCredentialOf, type AuthCredentialInfo, type RequestWithAuthCredential } from '@marinoscar/platform-api/identity';
import { Prisma } from '@prisma/client';

import { cleanClientName } from '../connected-apps/request-client';
import { PrismaService } from '../prisma/prisma.service';
import { MCP_TOOLS } from './mcp.tools';

/** The events of the trail. */
export const MCP_ACTIVITY_EVENTS = ['tool_call', 'step_up', 'rate_limited', 'kill_switch', 'app_settings', 'admin_disconnect'] as const;
export type McpActivityEvent = (typeof MCP_ACTIVITY_EVENTS)[number];

/** The outcomes of a row. */
export const MCP_ACTIVITY_OUTCOMES = ['ok', 'error', 'still_working', 'confirmation_required', 'refused'] as const;
export type McpActivityOutcome = (typeof MCP_ACTIVITY_OUTCOMES)[number];

/** How many characters of a goal a row keeps. */
export const ACTIVITY_GOAL_CHARS = 200;

/** The tools whose goal is kept (its first 200 characters). */
const GOAL_TOOLS = new Set(['run_goal', 'task_create']);
/** The tools whose URL host is kept. */
const URL_TOOLS = new Set(['browser_navigate']);
/** The tools whose selector is kept. */
const SELECTOR_TOOLS = new Set(['browser_click']);

/** The sanitized detail of one call's arguments: the closed list above, nothing else. */
export function activityDetail(tool: string, args: Record<string, unknown>): Record<string, string | number> | null {
  const out: Record<string, string | number> = {};
  if (GOAL_TOOLS.has(tool) && typeof args.goal === 'string') out.goal = args.goal.slice(0, ACTIVITY_GOAL_CHARS);
  if (URL_TOOLS.has(tool) && typeof args.url === 'string') {
    try {
      out.host = new URL(args.url).hostname.slice(0, 253);
    } catch {
      out.host = '(not a URL)';
    }
  }
  if (SELECTOR_TOOLS.has(tool) && typeof args.selector === 'string') out.selector = args.selector.slice(0, 500);
  if (tool === 'browser_evaluate' && typeof args.script === 'string') {
    out.scriptSha256 = createHash('sha256').update(args.script, 'utf8').digest('hex');
    out.scriptLength = args.script.length;
  }
  return Object.keys(out).length ? out : null;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOr = (v: unknown): string | null => (typeof v === 'string' && uuid.test(v) ? v : null);

/** The target ids of a call: from its arguments, then from what it returned (a new run, task or session). */
export function activityTargets(tool: string, args: Record<string, unknown>, structured?: Record<string, unknown> | null): { runId: string | null; taskId: string | null; sessionId: string | null; questionId: string | null } {
  const s = structured ?? {};
  const isBrowser = tool.startsWith('browser_');
  return {
    runId: idOr(args.run_id) ?? (!isBrowser && (tool === 'run_goal' || tool === 'task_run') ? idOr(s.id) : null),
    taskId: idOr(args.task_id) ?? (tool === 'task_create' ? idOr(s.id) : null),
    sessionId: idOr(args.session_id) ?? (tool === 'browser_open' ? idOr(s.session_id) : null),
    questionId: idOr(args.question_id) ?? idOr(args.handoff_id) ?? (tool === 'ask_human' ? idOr(s.id) : null),
  };
}

/** One row to write. */
export interface McpActivityInput {
  userId: string;
  orgId?: string | null;
  event?: McpActivityEvent;
  credentialKind: string;
  clientId?: string | null;
  clientName?: string | null;
  grantId?: string | null;
  tool?: string | null;
  runId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  questionId?: string | null;
  outcome: McpActivityOutcome;
  errorCode?: string | null;
  durationMs?: number;
  requestId?: string | null;
  detail?: Record<string, string | number | boolean | string[]> | null;
}

/** One row as the API returns it. */
export interface McpActivityView {
  id: string;
  createdAt: string;
  userId: string;
  event: string;
  credentialKind: string;
  clientId: string | null;
  clientName: string | null;
  tool: string | null;
  effect: string | null;
  runId: string | null;
  taskId: string | null;
  sessionId: string | null;
  questionId: string | null;
  outcome: string;
  errorCode: string | null;
  durationMs: number;
  requestId: string | null;
  detail: Record<string, unknown> | null;
}

/** The filters of the list. */
export interface McpActivityFilter {
  clientId?: string;
  tool?: string;
  effect?: string;
  outcome?: string;
  /** PAT callers: `pat`; OAuth apps: `oauth`. */
  credentialKind?: string;
  limit?: number;
  /** The `id` of the last row of the previous page. */
  cursor?: string;
}

/** The longest page. */
export const ACTIVITY_PAGE_MAX = 200;

type Row = Prisma.McpActivityGetPayload<object>;

function view(r: Row): McpActivityView {
  return {
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    userId: r.userId,
    event: r.event,
    credentialKind: r.credentialKind,
    clientId: r.clientId,
    clientName: r.clientName,
    tool: r.tool,
    effect: r.effect,
    runId: r.runId,
    taskId: r.taskId,
    sessionId: r.sessionId,
    questionId: r.questionId,
    outcome: r.outcome,
    errorCode: r.errorCode,
    durationMs: r.durationMs,
    requestId: r.requestId,
    detail: (r.detail as Record<string, unknown> | null) ?? null,
  };
}

type AnyReq = RequestWithAuthCredential & { user?: { id?: string; orgId?: string; activeOrgId?: string | null }; headers?: Record<string, unknown>; id?: unknown; body?: unknown };

@Injectable()
export class McpActivityService {
  private readonly log = new Logger(McpActivityService.name);
  /** The last refusal audited per key: at most one row per key a minute while a client keeps hammering. */
  private readonly lastRefusal = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  /** Whether calls of this credential are audited: OAuth apps and personal access tokens. */
  static audited(credential: Pick<AuthCredentialInfo, 'kind'> | null | undefined): boolean {
    return credential?.kind === 'oauth' || credential?.kind === 'pat';
  }

  /** Writes one row. A failure is logged and swallowed: the call it records already happened. */
  async record(input: McpActivityInput): Promise<void> {
    const tool = input.tool ? MCP_TOOLS.find((t) => t.name === input.tool) : undefined;
    try {
      await this.prisma.forUser({ userId: input.userId }).mcpActivity.create({
        data: {
          userId: input.userId,
          orgId: input.orgId ?? null,
          event: input.event ?? 'tool_call',
          credentialKind: input.credentialKind.slice(0, 16),
          clientId: input.clientId ?? null,
          clientName: cleanClientName(input.clientName ?? null),
          grantId: input.grantId ?? null,
          tool: tool ? tool.name : null,
          effect: tool ? tool.effect : null,
          runId: input.runId ?? null,
          taskId: input.taskId ?? null,
          sessionId: input.sessionId ?? null,
          questionId: input.questionId ?? null,
          outcome: input.outcome,
          errorCode: input.errorCode ? input.errorCode.slice(0, 64) : null,
          durationMs: Math.max(0, Math.round(input.durationMs ?? 0)),
          requestId: input.requestId ? input.requestId.slice(0, 100) : null,
          detail: input.detail ? (input.detail as Prisma.InputJsonValue) : Prisma.DbNull,
        },
      });
    } catch (e) {
      this.log.error(`could not write the MCP activity row (${input.event ?? 'tool_call'} ${input.tool ?? ''}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * A refusal the transport made before any tool ran (kill switch, rate
   * limit, step-up), for an audited credential. At most one row per caller,
   * event and minute: a flood is one line, not a flood of rows.
   */
  async refusal(req: unknown, event: Extract<McpActivityEvent, 'kill_switch' | 'rate_limited' | 'step_up'>, detail: Record<string, string> = {}): Promise<void> {
    const r = (req ?? {}) as AnyReq;
    const credential = authCredentialOf(r);
    const userId = r.user?.id;
    if (!userId || !McpActivityService.audited(credential)) return;
    const key = `${event}:${credential?.kind === 'oauth' ? credential.grantId : credential?.kind === 'pat' ? credential.tokenId : userId}`;
    const now = Date.now();
    if (event !== 'step_up' && now - (this.lastRefusal.get(key) ?? 0) < 60_000) return;
    if (this.lastRefusal.size > 5000) this.lastRefusal.clear();
    this.lastRefusal.set(key, now);
    const body = r.body as { method?: unknown; params?: { name?: unknown } } | undefined;
    const tool = !Array.isArray(body) && body?.method === 'tools/call' ? String(body.params?.name ?? '') : null;
    await this.record({
      userId,
      orgId: r.user?.activeOrgId ?? r.user?.orgId ?? null,
      event,
      credentialKind: credential!.kind,
      clientId: credential?.kind === 'oauth' ? credential.clientId : null,
      grantId: credential?.kind === 'oauth' ? credential.grantId : null,
      tool,
      outcome: 'refused',
      requestId: typeof r.id === 'string' ? r.id : null,
      detail: Object.keys(detail).length ? detail : null,
    });
  }

  private where(f: McpActivityFilter): Prisma.McpActivityWhereInput {
    return {
      ...(f.clientId ? { clientId: f.clientId } : {}),
      ...(f.tool ? { tool: f.tool } : {}),
      ...(f.effect ? { effect: f.effect } : {}),
      ...(f.outcome ? { outcome: f.outcome } : {}),
      ...(f.credentialKind ? { credentialKind: f.credentialKind } : {}),
    };
  }

  private async page(rows: () => Promise<Row[]>, limit: number): Promise<{ items: McpActivityView[]; nextCursor: string | null }> {
    const got = await rows();
    const items = got.slice(0, limit).map(view);
    return { items, nextCursor: got.length > limit ? (items.at(-1)?.id ?? null) : null };
  }

  /** The caller's own rows, newest first, keyset-paged. */
  async listOwn(userId: string, f: McpActivityFilter): Promise<{ items: McpActivityView[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(f.limit ?? 50, 1), ACTIVITY_PAGE_MAX);
    const db = this.prisma.forUser({ userId });
    return this.page(
      () =>
        db.mcpActivity.findMany({
          where: this.where(f),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
        }),
      limit,
    );
  }

  /** Every user's rows (administrators), newest first, keyset-paged. */
  async listAll(f: McpActivityFilter & { userId?: string }): Promise<{ items: McpActivityView[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(f.limit ?? 50, 1), ACTIVITY_PAGE_MAX);
    return this.page(
      () =>
        this.prisma.mcpActivity.findMany({
          where: { ...this.where(f), ...(f.userId ? { userId: f.userId } : {}) },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
        }),
      limit,
    );
  }

  /** Deletes one user's rows older than `before`; returns how many. */
  async purgeUser(userId: string, before: Date): Promise<number> {
    const { count } = await this.prisma.forUser({ userId }).mcpActivity.deleteMany({ where: { createdAt: { lt: before } } });
    return count;
  }

  /** The users who have rows older than `before` (one page). */
  async usersWithRowsBefore(before: Date, take = 500, afterUserId?: string): Promise<string[]> {
    const rows = await this.prisma.mcpActivity.findMany({
      where: { createdAt: { lt: before }, ...(afterUserId ? { userId: { gt: afterUserId } } : {}) },
      distinct: ['userId'],
      select: { userId: true },
      orderBy: { userId: 'asc' },
      take,
    });
    return rows.map((r) => r.userId);
  }
}
