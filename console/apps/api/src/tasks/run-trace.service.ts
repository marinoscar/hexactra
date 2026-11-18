// The run trace (#542): everything about one run that is safe to share, as
// one object. The single source of the JSON file (`GET /runs/{id}/export`,
// the CLI, the SDK, the MCP tool `run_export`) and of the PDF report (#543).
//
// What is in it: the run, its policy snapshot (spec, never the AI app's
// limits), budget, the tiers and models it used, every step with its masked
// question and (on request) its masked trace picture, and the messages of
// its chat. Every string goes through `maskValue` at export time, so a run
// recorded before the masking module (#538) is masked too.
//
// What is never in it: `runs.transcript` (the model's working memory; never
// selected), a token or cookie, a withheld answer (`stepQuestionView`), the
// grant or limits of an AI app, `screenshotKey`, another user's data (the
// run is read through `prisma.forUser`) and the node's enrollment data (the
// host is its id and name).
import { HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, Optional, PayloadTooLargeException } from '@nestjs/common';
import { resolveApiVersion } from '@marinoscar/platform-api/host';
import type { PatternHits, PatternId } from '@app/shared/sensitive-patterns';

import { FabricClient } from '../fabric/fabric.client';
import { MCP_RATE_LIMITER, type McpRateLimiter } from '../mcp/mcp.rate-limit';
import { TIERS, type Tier } from '../policies/agent-policy.schema';
import { readSnapshot, snapshotBudgetView } from '../policies/policy-snapshot';
import { readConfirmedActions } from '../runner/confirmed-actions';
import { PrismaService } from '../prisma/prisma.service';
import { maskValue, SENSITIVE_PATTERNS_VERSION } from './mask';
import { RUN_ARTIFACT_STORE, type RunArtifactStore } from './run-delete.service';
import { RunMetrics } from './run-metrics';
import { runClientView } from './run-cost';
import { TERMINAL_RUN_STATUSES, type RunStatus } from './run-status';
import { STEP_QUESTION_SELECT, stepQuestionView } from './run-trace.view';
import {
  RUN_EXPORT_MAX_BYTES,
  RUN_EXPORT_RATE_LIMIT,
  RUN_TRACE_FORMAT_VERSION,
  RUN_TRACE_MAX_CHAT,
  RUN_TRACE_TYPE,
  type RunExportScreenshots,
  type RunTrace,
  type RunTraceScreenshot,
  type RunTraceStep,
} from './run-trace.schemas';
import './runs.errors';

export interface RunTraceOptions {
  /** `embed` puts each stored picture in `steps[].screenshot.data` (base64); `none` leaves the images out. */
  screenshots: RunExportScreenshots;
  /** Refuse (413 `EXPORT_TOO_LARGE`) once the embedded images pass this many bytes; default `RUN_EXPORT_MAX_BYTES`. */
  maxBytes?: number;
  /** The clock of `exportedAt` and the live budget; default now. */
  now?: Date;
}

/** A serialized export, ready to send. */
export interface RunExportFile {
  body: string;
  filename: string;
  bytes: number;
}

/** How long the host name lookup may take before the file goes without it. */
const HOST_LOOKUP_MS = 3_000;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** `hexactra-run-<first 8 of id>-<yyyymmdd>.json` (UTC date). */
export function runExportFilename(runId: string, at: Date, ext = 'json'): string {
  return `hexactra-run-${runId.slice(0, 8)}-${at.toISOString().slice(0, 10).replace(/-/g, '')}.${ext}`;
}

/** The non-zero counts of `hits`, in table order. */
function nonZero(hits: PatternHits): Partial<Record<PatternId, number>> {
  return Object.fromEntries(Object.entries(hits).filter(([, n]) => n > 0)) as Partial<Record<PatternId, number>>;
}

function tooLarge(maxBytes: number): PayloadTooLargeException {
  return new PayloadTooLargeException({
    code: 'EXPORT_TOO_LARGE',
    message: `This run's file would be over ${Math.round(maxBytes / (1024 * 1024))} MB with its screenshots. Export it with screenshots=none (CLI: --no-screenshots).`,
  });
}

/** The tiers a run used, in order: the start tier, then each tier a routing step moved to. */
export function tiersUsed(start: Tier | null, steps: { kind: string; args: unknown }[]): Tier[] {
  const out: Tier[] = start ? [start] : [];
  for (const s of steps) {
    if (s.kind !== 'routing' || !s.args || typeof s.args !== 'object') continue;
    const to = (s.args as { to?: unknown }).to;
    if (typeof to === 'string' && (TIERS as readonly string[]).includes(to) && !out.includes(to as Tier)) out.push(to as Tier);
  }
  return out;
}

@Injectable()
export class RunTraceService {
  private readonly log = new Logger('RunTrace');

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics: RunMetrics = new RunMetrics(),
    @Optional() @Inject(RUN_ARTIFACT_STORE) private readonly store?: RunArtifactStore,
    @Optional() private readonly fabric?: FabricClient,
    @Optional() @Inject(MCP_RATE_LIMITER) private readonly limiter?: McpRateLimiter,
  ) {}

  /** The trace of one of the user's runs; 404 `RUN_NOT_FOUND` for any other run. */
  async build(userId: string, runId: string, opts: RunTraceOptions): Promise<RunTrace> {
    const now = opts.now ?? new Date();
    const maxBytes = opts.maxBytes ?? RUN_EXPORT_MAX_BYTES;
    const run = await this.prisma.forUser({ userId }).run.findFirst({
      where: { id: runId },
      // Never the transcript, the AI app's grant or limits, the fabric session or handoff.
      select: {
        id: true,
        goal: true,
        status: true,
        stopReason: true,
        result: true,
        error: true,
        trigger: true,
        origin: true,
        clientId: true,
        clientName: true,
        taskId: true,
        conversationId: true,
        profile: true,
        hostId: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        confirmedActions: true,
        stepCount: true,
        modelCalls: true,
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        costUsd: true,
        costKnown: true,
        activeMs: true,
        activeSince: true,
        policySnapshot: true,
        policySource: true,
        currentTier: true,
        task: { select: { name: true } },
        steps: {
          orderBy: { seq: 'asc' },
          select: {
            seq: true,
            createdAt: true,
            kind: true,
            action: true,
            args: true,
            ok: true,
            summary: true,
            reasoning: true,
            durationMs: true,
            screenshotKey: true,
            screenshotMoment: true,
            screenshotMasked: true,
            screenshotNote: true,
            question: { select: STEP_QUESTION_SELECT },
          },
        },
        conversation: { select: { messages: { orderBy: { seq: 'desc' }, take: RUN_TRACE_MAX_CHAT, select: { seq: true, role: true, kind: true, text: true, createdAt: true } } } },
      },
    });
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });

    const snapshot = readSnapshot(run.policySnapshot);
    const used = tiersUsed(snapshot?.spec.models.startTier ?? null, run.steps);
    const modelOf = (tier: Tier): string | null => {
      const resolved = snapshot?.resolvedTiers?.[tier];
      if (resolved) return resolved.model;
      const legacy = snapshot?.tiers?.[tier];
      return legacy?.model ? (legacy.provider ? `${legacy.provider}:${legacy.model}` : legacy.model) : null;
    };

    const steps: RunTraceStep[] = run.steps.map((s) => ({
      seq: s.seq,
      at: s.createdAt.toISOString(),
      kind: s.kind,
      action: s.action,
      args: s.args && typeof s.args === 'object' && !Array.isArray(s.args) ? (s.args as Record<string, unknown>) : null,
      ok: s.ok,
      summary: s.summary,
      reasoning: s.reasoning,
      durationMs: s.durationMs,
      // Unmasked here: the whole trace is masked below, so the hits count the question too.
      question: s.question ? stepQuestionView(s.question, (t) => t) : null,
      screenshot:
        s.screenshotKey || s.screenshotNote
          ? {
              moment: (s.screenshotMoment ?? null) as RunTraceScreenshot['moment'],
              masked: s.screenshotMasked ?? null,
              note: (s.screenshotNote ?? null) as RunTraceScreenshot['note'],
              contentType: s.screenshotKey ? (s.screenshotKey.endsWith('.png') ? 'image/png' : 'image/jpeg') : null,
              bytes: null,
            }
          : null,
    }));

    const trace: RunTrace = {
      type: RUN_TRACE_TYPE,
      formatVersion: RUN_TRACE_FORMAT_VERSION,
      exportedAt: now.toISOString(),
      partial: !TERMINAL_RUN_STATUSES.includes(run.status as RunStatus),
      console: { version: resolveApiVersion(__dirname) },
      masking: { applied: true, patternsVersion: SENSITIVE_PATTERNS_VERSION, hits: {} },
      run: {
        id: run.id,
        goal: run.goal,
        status: run.status,
        stopReason: run.stopReason,
        result: run.result,
        error: run.error,
        trigger: run.trigger,
        origin: run.origin,
        client: runClientView(run),
        taskId: run.taskId,
        taskName: run.task?.name ?? null,
        conversationId: run.conversationId,
        profile: run.profile,
        host: run.hostId ? { id: run.hostId, name: await this.hostName(run.hostId) } : null,
        createdAt: run.createdAt.toISOString(),
        startedAt: iso(run.startedAt),
        finishedAt: iso(run.finishedAt),
        confirmedActions: readConfirmedActions(run.confirmedActions),
        usage: {
          stepCount: run.stepCount,
          modelCalls: run.modelCalls,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          cachedInputTokens: run.cachedInputTokens,
          costUsd: Number(run.costUsd),
          costKnown: run.costKnown,
          activeMs: run.activeMs,
        },
      },
      // The spec and where it came from; never the snapshot's app limits or resolved provider details.
      policy: snapshot ? { id: snapshot.ref, name: snapshot.name, version: snapshot.version, builtin: snapshot.builtin, source: run.policySource ?? snapshot.source ?? null, spec: snapshot.spec } : null,
      budget: snapshotBudgetView(snapshot, run, now.getTime()),
      models: used.map((tier) => ({ tier, model: modelOf(tier), calls: used.length === 1 ? run.modelCalls : null })),
      steps,
      chat: (run.conversation?.messages ?? [])
        .slice()
        .reverse()
        .map((m) => ({ seq: m.seq, role: m.role, kind: m.kind, text: m.text, at: m.createdAt.toISOString() })),
    };

    // Every string, at export time. Images are added after: they are stored masked (#539, #541).
    const masked = maskValue(trace);
    const out = masked.value;
    out.masking.hits = nonZero(masked.hits);

    if (opts.screenshots === 'embed' && this.store) {
      let total = 0;
      for (const [i, s] of run.steps.entries()) {
        const shot = out.steps[i]!.screenshot;
        if (!s.screenshotKey || !shot) continue;
        const found = await this.store.get(s.screenshotKey).catch(() => null);
        if (!found) continue;
        total += Math.ceil(found.bytes.length / 3) * 4;
        if (total > maxBytes) throw tooLarge(maxBytes);
        shot.contentType = found.contentType;
        shot.bytes = found.bytes.length;
        shot.data = found.bytes.toString('base64');
      }
    }
    return out;
  }

  /**
   * The JSON file of a run, for the route: the rate limit (10 a minute per
   * user), the 50 MB guard, then the audit record, the counter and one log
   * line. None of them carries goal, result or step content.
   */
  async exportJson(userId: string, runId: string, opts: RunTraceOptions & { orgId?: string | null }): Promise<RunExportFile> {
    const started = Date.now();
    await this.rateLimit(userId);
    const maxBytes = opts.maxBytes ?? RUN_EXPORT_MAX_BYTES;
    const trace = await this.build(userId, runId, { ...opts, maxBytes });
    const body = JSON.stringify(trace, null, 2);
    const bytes = Buffer.byteLength(body);
    if (bytes > maxBytes) throw tooLarge(maxBytes);
    const ms = Date.now() - started;
    this.log.log(`runs.export user=${userId} run=${runId} format=json screenshots=${opts.screenshots} bytes=${bytes} ms=${ms}`);
    this.metrics.exported('json', opts.screenshots);
    try {
      await this.prisma.auditEvent.create({
        data: { actorUserId: userId, action: 'runs.exported', targetType: 'run', targetId: runId, orgId: opts.orgId ?? null, meta: { runId, format: 'json', screenshots: opts.screenshots, bytes, partial: trace.partial } },
      });
    } catch (err) {
      this.log.warn(`runs.export: the audit record could not be written: ${err instanceof Error ? err.name : 'error'}`);
    }
    return { body, bytes, filename: runExportFilename(runId, opts.now ?? new Date()) };
  }

  /** 429 `RATE_LIMITED` past `RUN_EXPORT_RATE_LIMIT` exports in a minute; a limiter that fails lets the export through. */
  private async rateLimit(userId: string): Promise<void> {
    if (!this.limiter) return;
    const verdict = await Promise.resolve(this.limiter.hit(`runs-export:${userId}`, RUN_EXPORT_RATE_LIMIT, 60_000)).catch(() => ({ allowed: true, retryAfterS: 0 }));
    if (!verdict.allowed) {
      throw new HttpException(
        { code: 'EXPORT_RATE_LIMITED', message: `At most ${RUN_EXPORT_RATE_LIMIT} run exports a minute. Wait ${verdict.retryAfterS} seconds and try again.`, details: { retryAfterS: verdict.retryAfterS } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** The host's display name from the fabric; null when it cannot say in time. */
  private async hostName(hostId: string): Promise<string | null> {
    if (!this.fabric) return null;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((res) => {
      timer = setTimeout(() => res(null), HOST_LOOKUP_MS);
    });
    try {
      const hosts = await Promise.race([this.fabric.hosts().catch(() => null), timeout]);
      return hosts?.find((h) => h.id === hostId)?.name ?? null;
    } finally {
      clearTimeout(timer);
    }
  }
}
