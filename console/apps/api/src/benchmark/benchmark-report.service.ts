// Exporting a benchmark (E44.6, #744): the report as JSON, CSV or PDF, for `GET /api/benchmarks/{id}/export`. Like the run export
// (`RunTraceService.exportJson`/`exportPdf`): 10 exports a minute per user (429 `EXPORT_RATE_LIMITED`), the audit event
// `benchmarks.exported` with the format (never a goal, a result or a check note), one log line. Every string is masked once, in
// `buildBenchmarkReport`; there is no unmasked export.
import { PassThrough, type Readable } from 'node:stream';

import { HttpException, HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { resolveApiVersion } from '@marinoscar/platform-api/host';

import { MCP_RATE_LIMITER, type McpRateLimiter } from '../mcp/mcp.rate-limit';
import { PrismaService } from '../prisma/prisma.service';
import { renderPdf } from '../tasks/run-report.pdf';
import '../tasks/runs.errors';
import { benchmarkExportFilename, benchmarkReportCsv, buildBenchmarkReport, type TrialRunText } from './benchmark-report';
import { buildBenchmarkReportDefinition } from './benchmark-report.pdf';
import { BENCHMARK_EXPORT_RATE_LIMIT, type BenchmarkExportFormat, type BenchmarkReport, type BenchmarkReportPaper } from './benchmark-report.schemas';
import { BenchmarksService } from './benchmarks.service';
import { ScorecardService } from './scorecard.service';

/** The audit action of an export. */
export const BENCHMARK_EXPORTED = 'benchmarks.exported' as const;

export interface BenchmarkExportOptions {
  format: BenchmarkExportFormat;
  paper?: BenchmarkReportPaper;
  baseline?: string;
  orgId?: string | null;
  /** The viewer has `runs:read`: each trial carries its run's recording status (#846). Never the video. */
  recordings?: boolean;
  /** The clock of `exportedAt` and the file name; default now. */
  now?: Date;
}

/** A file ready to send: a string body (JSON, CSV) or a stream (PDF). */
export interface BenchmarkExportFile {
  filename: string;
  contentType: string;
  body: string | Readable;
  partial: boolean;
}

const CONTENT_TYPE: Record<BenchmarkExportFormat, string> = { json: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8', pdf: 'application/pdf' };

@Injectable()
export class BenchmarkReportService {
  private readonly log = new Logger('BenchmarkReport');

  constructor(
    private readonly prisma: PrismaService,
    private readonly benchmarks: BenchmarksService,
    private readonly scorecards: ScorecardService,
    @Optional() @Inject(MCP_RATE_LIMITER) private readonly limiter?: McpRateLimiter,
  ) {}

  /**
   * The report of one of the user's benchmarks (404 `BENCHMARK_NOT_FOUND` for any other), with the comparison when `baseline` is given
   * (409 `BENCHMARK_SUITE_MISMATCH` on another suite version). A benchmark still running is exported with `partial: true`.
   */
  async build(userId: string, id: string, opts: { baseline?: string; now?: Date; recordings?: boolean } = {}): Promise<BenchmarkReport> {
    const benchmark = await this.benchmarks.get(userId, id);
    const [scorecard, trials, baseline] = await Promise.all([
      this.scorecards.scorecard(userId, id),
      this.benchmarks.trials(userId, id, {}, { recordings: opts.recordings }),
      opts.baseline ? this.scorecards.compare(userId, id, opts.baseline) : Promise.resolve(null),
    ]);
    const runIds = trials.items.map((t) => t.runId).filter((x): x is string => !!x);
    // Through the user's own scope: a run that is not theirs (or is gone) contributes nothing.
    const rows = runIds.length ? await this.prisma.forUser({ userId }).run.findMany({ where: { id: { in: runIds } }, select: { id: true, goal: true, result: true } }) : [];
    const runs = new Map<string, TrialRunText>(rows.map((r) => [r.id, { goal: r.goal, result: r.result }]));
    return buildBenchmarkReport({ benchmark, scorecard, trials: trials.items, runs, baseline, consoleVersion: resolveApiVersion(__dirname), exportedAt: opts.now ?? new Date() });
  }

  /** The file of a benchmark in one format, for the route: the rate limit first, then the report, the audit event and the log line. */
  async export(userId: string, id: string, opts: BenchmarkExportOptions): Promise<BenchmarkExportFile> {
    const started = Date.now();
    await this.rateLimit(userId);
    const now = opts.now ?? new Date();
    const report = await this.build(userId, id, { baseline: opts.baseline, now, recordings: opts.recordings });
    const filename = benchmarkExportFilename(id, now, opts.format);
    const paper = opts.paper ?? 'a4';
    let body: string | Readable;
    if (opts.format === 'pdf') {
      const out = new PassThrough();
      const pdf = renderPdf(buildBenchmarkReportDefinition(report, { paper }));
      pdf.once('error', (err: Error) => {
        this.log.warn(`benchmarks.export: the PDF of benchmark ${id} could not be rendered: ${err.name}`);
        out.destroy(err);
      });
      pdf.pipe(out);
      body = out;
    } else {
      body = opts.format === 'csv' ? benchmarkReportCsv(report) : JSON.stringify(report, null, 2);
    }
    this.log.log(`benchmarks.export user=${userId} benchmark=${id} format=${opts.format}${opts.format === 'pdf' ? ` paper=${paper}` : ''} trials=${report.trials.length} ms=${Date.now() - started}`);
    await this.audit(userId, id, opts.orgId ?? null, {
      format: opts.format,
      ...(opts.format === 'pdf' ? { paper } : {}),
      ...(opts.baseline ? { baselineId: opts.baseline } : {}),
      partial: report.partial,
      trials: report.trials.length,
    });
    return { filename, contentType: CONTENT_TYPE[opts.format], body, partial: report.partial };
  }

  /** `benchmarks.exported`: ids, the format and counts; never a goal, a result or a check note. */
  private async audit(userId: string, id: string, orgId: string | null, meta: Record<string, string | number | boolean>): Promise<void> {
    try {
      await this.prisma.auditEvent.create({ data: { actorUserId: userId, action: BENCHMARK_EXPORTED, targetType: 'benchmark', targetId: id, orgId, meta: { benchmarkId: id, ...meta } } });
    } catch (err) {
      this.log.warn(`benchmarks.export: the audit record could not be written: ${err instanceof Error ? err.name : 'error'}`);
    }
  }

  /** 429 `EXPORT_RATE_LIMITED` past 10 exports a minute (every format together); a limiter that fails lets the export through. */
  private async rateLimit(userId: string): Promise<void> {
    if (!this.limiter) return;
    const verdict = await Promise.resolve(this.limiter.hit(`benchmarks-export:${userId}`, BENCHMARK_EXPORT_RATE_LIMIT, 60_000)).catch(() => ({ allowed: true, retryAfterS: 0 }));
    if (!verdict.allowed) {
      throw new HttpException(
        { code: 'EXPORT_RATE_LIMITED', message: `At most ${BENCHMARK_EXPORT_RATE_LIMIT} benchmark exports a minute. Wait ${verdict.retryAfterS} seconds and try again.`, details: { retryAfterS: verdict.retryAfterS } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
