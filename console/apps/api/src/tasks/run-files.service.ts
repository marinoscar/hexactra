// A run's masked files as bytes, for the places that send them on (deliveries E39.6, #603; the signed report link): the PDF report
// (#543), the JSON trace (#542) and the step pictures (#541). Everything comes from the one masked trace: nothing here reads the
// transcript, masks again or unmasks. There is NO unmasked file, for any caller (§26.8).
//
// Apart from `RunTraceService.exportPdf`/`exportJson` (the owner's own export routes) these have no rate limit and write no
// `runs.exported` audit event: a delivery is not an export, and its own audit event says what was sent.
import { Inject, Injectable, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { buildReportDefinition, renderPdf, type ReportPaper } from './run-report.pdf';
import { RUN_ARTIFACT_STORE, type RunArtifactStore } from './run-delete.service';
import { runExportFilename, RunTraceService } from './run-trace.service';

export interface RunFile {
  /** A safe name made from the run's id and date. */
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export interface RunPicture extends RunFile {
  /** The step the picture belongs to. */
  seq: number;
  /** `question`, `before_confirmed`, `after_confirmed`, `failure`, `final`; null for an older picture. */
  moment: string | null;
}

/** The most step pictures one delivery carries, whatever `screenshots` says. */
export const MAX_RUN_PICTURES = 20;

@Injectable()
export class RunFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly traces: RunTraceService,
    @Optional() @Inject(RUN_ARTIFACT_STORE) private readonly store?: RunArtifactStore,
  ) {}

  /** The masked PDF report of one of the user's runs; 404 `RUN_NOT_FOUND` for any other. `screenshots: 'embed'` puts the pictures in it. */
  async pdf(userId: string, runId: string, opts: { screenshots: 'embed' | 'none'; paper?: ReportPaper; now?: Date }): Promise<RunFile> {
    const now = opts.now ?? new Date();
    const trace = await this.traces.build(userId, runId, { screenshots: opts.screenshots, now });
    const stream = renderPdf(buildReportDefinition(trace, { paper: opts.paper ?? 'a4', screenshots: opts.screenshots }));
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
    return { filename: runExportFilename(runId, now, 'pdf'), contentType: 'application/pdf', bytes: Buffer.concat(chunks) };
  }

  /** The masked JSON trace; `embed` includes the pictures as base64. */
  async json(userId: string, runId: string, opts: { screenshots: 'embed' | 'none'; now?: Date }): Promise<RunFile> {
    const now = opts.now ?? new Date();
    const trace = await this.traces.build(userId, runId, { screenshots: opts.screenshots, now });
    return { filename: runExportFilename(runId, now, 'json'), contentType: 'application/json; charset=utf-8', bytes: Buffer.from(JSON.stringify(trace, null, 2), 'utf8') };
  }

  /**
   * The stored step pictures, oldest first, only those whose masking ran at capture (`screenshot_masked` holds the number of regions
   * masked, 0 included): a picture with no masking recorded is left out rather than sent. `final`: the last one, preferring the one taken at the end.
   */
  async pictures(userId: string, runId: string, which: 'final' | 'all'): Promise<RunPicture[]> {
    if (!this.store) return [];
    const steps = await this.prisma.forUser({ userId }).runStep.findMany({
      where: { runId, screenshotKey: { not: null }, screenshotMasked: { not: null } },
      orderBy: { seq: 'asc' },
      select: { seq: true, screenshotKey: true, screenshotMoment: true },
    });
    if (steps.length === 0) return [];
    const picked = which === 'all' ? steps.slice(-MAX_RUN_PICTURES) : [[...steps].reverse().find((s) => s.screenshotMoment === 'final') ?? steps[steps.length - 1]!];
    const out: RunPicture[] = [];
    for (const s of picked) {
      const found = await this.store.get(s.screenshotKey!).catch(() => null);
      if (!found) continue;
      const ext = found.contentType === 'image/png' ? 'png' : 'jpg';
      out.push({ seq: s.seq, moment: s.screenshotMoment ?? null, filename: `step-${s.seq}.${ext}`, contentType: found.contentType, bytes: found.bytes });
    }
    return out;
  }
}
