// The run recording on the run page (E45.5, #760, docs/recordings.md): its status, a short-lived playback link, the video by that link
// (HTTP Range, so the player can seek) and Delete. Owner-only: every route reads the run through `forUser`, so another user's run, an
// administrator's view of it and a run without a recording are the same 404. THE VIDEO IS NOT MASKED; it is in no export, delivery, run
// files, agent tool or MCP tool.
import { Controller, Delete, Get, HttpCode, Inject, Logger, NotFoundException, Optional, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiDataResponse } from '@marinoscar/platform-api/core';
import { Auth, CurrentUser, Public } from '@marinoscar/platform-api/identity';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service';
import { RUN_ARTIFACT_STORE, type RunArtifactStore } from '../tasks/run-delete.service';
import { signToken, verifyToken } from '../tasks/signed-token';
import { recordingKeys } from './recording-keys';
import { readRecordingsSettings, recordingExpiresAt } from './recordings.settings';

/** A playback link lasts this long. */
export const RECORDING_LINK_TTL_S = 15 * 60;
const LINK_KIND = 'run-recording';
export const RECORDING_DELETED_AUDIT_ACTION = 'runs.recording_deleted';

export const recordingViewSchema = z.object({
  status: z.enum(['recording', 'processing', 'ready', 'failed']).describe('recording: the run works; processing: the video is being made; ready: playable; failed: no video'),
  bytes: z.number().int(),
  durationMs: z.number().int(),
  mime: z.string(),
  droppedFrames: z.number().int().describe('Frames kept out (a sensitive value typed, a sensitive field focused, paused) or over the rate limit'),
  note: z.string().nullable().describe('Why it ended early or failed: max_minutes, tab_closed, restarted, encoder_unavailable, storage_error, empty, …'),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  expiresAt: z.string().nullable().describe('When the retention policy deletes it; null while recordings are kept indefinitely, or while it records'),
  masked: z.literal(false).describe('A run recording is never masked'),
});
class RecordingViewDto extends createZodDto(recordingViewSchema) {}
const recordingLinkSchema = z.object({ url: z.string().describe('A same-origin path to the video, valid until expiresAt'), expiresAt: z.string() });
class RecordingLinkDto extends createZodDto(recordingLinkSchema) {}

function notFound(): NotFoundException {
  return new NotFoundException({ code: 'RECORDING_NOT_FOUND', message: 'This run has no recording' });
}

@ApiTags('Runs')
@Controller('runs')
export class RunRecordingController {
  private readonly log = new Logger('RunRecording');

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(RUN_ARTIFACT_STORE) private readonly store?: RunArtifactStore,
    @Optional() private readonly systemSettings?: SystemSettingsService,
  ) {}

  private async own(userId: string, runId: string) {
    const run = await this.prisma.forUser({ userId }).run.findFirst({ where: { id: runId }, select: { id: true } });
    if (!run) throw notFound();
    const rec = await this.prisma.runRecording.findFirst({ where: { runId, userId } });
    if (!rec) throw notFound();
    return rec;
  }

  @Get(':id/recording')
  @Auth({ permissions: ['runs:read'] })
  @ApiOperation({ summary: "A run's video recording: its status and when it is deleted", description: 'Owner only. The video is NOT masked. 404 `RECORDING_NOT_FOUND` when the run has none (it was not opted in, or it was deleted).' })
  @ApiDataResponse(RecordingViewDto)
  async get(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<z.infer<typeof recordingViewSchema>> {
    const r = await this.own(userId, id);
    const settings = readRecordingsSettings(await this.systemSettings?.getNamespace('recordings').catch(() => undefined));
    const finished = r.status === 'ready' || r.status === 'failed';
    return {
      status: r.status as z.infer<typeof recordingViewSchema>['status'],
      bytes: Number(r.bytes),
      durationMs: r.durationMs,
      mime: r.mime,
      droppedFrames: r.droppedFrames,
      note: r.note,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      expiresAt: finished ? (recordingExpiresAt(r.createdAt, settings.keepDays)?.toISOString() ?? null) : null,
      masked: false,
    };
  }

  @Post(':id/recording/link')
  @HttpCode(200)
  @Auth({ permissions: ['runs:read'] })
  @ApiOperation({ summary: "A short-lived link to play a run's video", description: 'Owner only, a ready recording only. The link is valid for 15 minutes and names this recording; the browser\'s video player reads it with HTTP Range.' })
  @ApiDataResponse(RecordingLinkDto)
  async link(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<z.infer<typeof recordingLinkSchema>> {
    const r = await this.own(userId, id);
    if (r.status !== 'ready' || !r.objectKey) throw notFound();
    const now = Date.now();
    const token = signToken(LINK_KIND, { r: r.id, u: userId }, RECORDING_LINK_TTL_S, now);
    return { url: `/api/recordings/${token}`, expiresAt: new Date(now + RECORDING_LINK_TTL_S * 1000).toISOString() };
  }

  @Delete(':id/recording')
  @HttpCode(204)
  @Auth({ permissions: ['runs:delete'] })
  @ApiOperation({ summary: "Delete a run's video recording", description: 'Owner only. The run and its masked trace stay. Audited as `runs.recording_deleted`.' })
  @ApiResponse({ status: 204, description: 'Deleted.' })
  async remove(@CurrentUser('id') userId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    const r = await this.own(userId, id);
    await this.prisma.runRecording.delete({ where: { id: r.id } });
    let failed = 0;
    for (const key of recordingKeys(r)) await this.store?.delete(key).catch(() => failed++);
    if (failed) this.log.warn(`recording of run ${id}: ${failed} object(s) could not be deleted`);
    await this.prisma.auditEvent
      .create({ data: { actorUserId: userId, action: RECORDING_DELETED_AUDIT_ACTION, targetType: 'run', targetId: id, meta: { bytes: Number(r.bytes), durationMs: r.durationMs } } })
      .catch((e) => this.log.warn(`the recording deletion could not be audited: ${e instanceof Error ? e.name : 'error'}`));
  }
}

/** Parse one `Range: bytes=a-b` (or `a-`, or `-n`) against a size; null when absent or not satisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

@ApiTags('Runs')
@Controller('recordings')
export class RecordingLinkController {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(RUN_ARTIFACT_STORE) private readonly store?: RunArtifactStore,
  ) {}

  @Get(':token')
  @Public()
  @ApiOperation({
    summary: "A run's video, by its playback link",
    description: 'No session: the signed token from `POST /runs/{id}/recording/link` is the authority, for 15 minutes. Streams `video/webm` with HTTP Range (206) and `Cache-Control: private, no-store`. An expired, altered or unknown link, and a deleted recording, are all 404.',
  })
  @ApiParam({ name: 'token', description: 'The signed token of the playback link.' })
  @ApiProduces('video/webm')
  @ApiResponse({ status: 200, description: 'The whole video (not masked).' })
  @ApiResponse({ status: 206, description: 'The requested byte range.' })
  @ApiResponse({ status: 404, description: '`RECORDING_LINK_INVALID`.' })
  async play(@Param('token') token: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const claims = verifyToken(LINK_KIND, token);
    const refused = () => new NotFoundException({ code: 'RECORDING_LINK_INVALID', message: 'This link is not valid or has expired.' });
    if (!claims || typeof claims.r !== 'string' || typeof claims.u !== 'string') throw refused();
    const rec = await this.prisma.runRecording.findFirst({ where: { id: claims.r, userId: claims.u, status: 'ready' }, select: { objectKey: true, mime: true } });
    const file = rec?.objectKey && this.store ? await this.store.get(rec.objectKey) : null;
    if (!file) throw refused();
    const size = file.bytes.length;
    reply
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .type(rec!.mime);
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      await reply.code(416).header('content-range', `bytes */${size}`).send();
      return;
    }
    if (range) {
      await reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`).send(file.bytes.subarray(range.start, range.end + 1));
      return;
    }
    await reply.send(file.bytes);
  }
}
