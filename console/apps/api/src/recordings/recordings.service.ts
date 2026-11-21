import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { RUN_ARTIFACT_STORE, type RunArtifactStore } from '../tasks/run-delete.service';
import { TERMINAL_RUN_STATUSES } from '../tasks/run-status';
import { RECORDING_CONTENT_TYPE, partKey, recordingKey } from './recording-keys';
import { RecordingFormatError, readRecording } from './recording-format';
import { muxWebm, streamDurationMs } from './webm';

/** A recording left `recording` this long after its run ended is finalized from the parts it has (the run ended outside a job). */
export const STALE_RECORDING_MS = 5 * 60_000;
/** Recordings finalized per pass. */
export const FINALIZE_BATCH = 20;

export type FinalizeResult = 'ready' | 'failed' | 'gone';

/**
 * Run recordings (epic #755, docs/recordings.md): the finished video made from the parts a run stored. NOT masked: the video is the
 * owner's, never exported or delivered.
 */
@Injectable()
export class RecordingsService {
  private readonly log = new Logger(RecordingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(RUN_ARTIFACT_STORE) private readonly store?: RunArtifactStore,
  ) {}

  /** The recordings due for the finalize job: every `processing` one, and a `recording` one whose run ended a while ago. */
  async due(now = new Date(), take = FINALIZE_BATCH): Promise<string[]> {
    const rows = await this.prisma.runRecording.findMany({
      where: {
        OR: [
          { status: 'processing' },
          { status: 'recording', updatedAt: { lt: new Date(now.getTime() - STALE_RECORDING_MS) }, run: { status: { in: [...TERMINAL_RUN_STATUSES] } } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take,
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Join a recording's parts, in order, into one seekable WebM, store it, and delete the parts. A recording without a readable frame is
   * `failed` (`empty`, `unreadable`). Safe to repeat: a recording that is no longer due is left as it is.
   */
  async finalize(id: string): Promise<FinalizeResult> {
    const rec = await this.prisma.runRecording.findUnique({ where: { id } });
    if (!rec || (rec.status !== 'processing' && rec.status !== 'recording')) return 'gone';
    if (!this.store) return this.markFailed(id, 'no_storage');
    const parts: Buffer[] = [];
    for (let n = 0; n < rec.partCount; n++) {
      const got = await this.store.get(partKey(rec.userId, rec.runId, n));
      // A missing part leaves a gap; the stream's records are whole, so the rest still reads.
      if (got) parts.push(got.bytes);
    }
    let video: Buffer;
    let durationMs: number;
    try {
      const stream = readRecording(Buffer.concat(parts));
      if (stream.frames.length === 0) return this.markFailed(id, 'empty', rec);
      video = muxWebm(stream);
      durationMs = streamDurationMs(stream);
    } catch (e) {
      return this.markFailed(id, e instanceof RecordingFormatError || parts.length === 0 ? (parts.length === 0 ? 'empty' : 'unreadable') : 'finalize_failed', rec);
    }
    const key = recordingKey(rec.userId, rec.runId);
    await this.store.put(key, video, RECORDING_CONTENT_TYPE);
    const updated = await this.prisma.runRecording.updateMany({
      where: { id, status: { in: ['processing', 'recording'] } },
      data: { status: 'ready', objectKey: key, bytes: video.length, durationMs, mime: RECORDING_CONTENT_TYPE, fabricId: null, endedAt: rec.endedAt ?? new Date() },
    });
    if (updated.count === 0) {
      // Deleted (with its run) while it was made: remove the file again.
      await this.store.delete(key).catch(() => undefined);
      return 'gone';
    }
    await this.removeParts(rec);
    return 'ready';
  }

  private async markFailed(id: string, note: string, rec?: { userId: string; runId: string; partCount: number }): Promise<FinalizeResult> {
    await this.prisma.runRecording.updateMany({ where: { id }, data: { status: 'failed', note, fabricId: null } });
    if (rec) await this.removeParts(rec);
    return 'failed';
  }

  private async removeParts(rec: { userId: string; runId: string; partCount: number }): Promise<void> {
    let failed = 0;
    for (let n = 0; n < rec.partCount; n++) {
      await this.store?.delete(partKey(rec.userId, rec.runId, n)).catch(() => failed++);
    }
    if (failed) this.log.warn(`${failed} recording part(s) could not be deleted`);
  }
}
