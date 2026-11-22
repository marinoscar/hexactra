// The run recording beside a job (epic #755, docs/recordings.md). A run whose owner switched Record video on keeps a video of its browser
// tab: this recorder starts it once the run has a browser session, pulls the encoded bytes every 10 s into part objects, holds it while
// the owner has paused the run, and stops it when the run ends (the finalize job then makes the video).
//
// Not an agent tool: it changes nothing on the page, is never offered to the model, takes no budget and does not go through `executeTool`
// (the same footing as a trace screenshot). It never changes a run: every failure is caught, stored as a short code on the recording, and
// the run goes on. THE VIDEO IS NOT MASKED AND WITHHOLDS NOTHING (the owner's decision, #882): it keeps every frame, also while a secret,
// a code or a sign-in is asked for or typed.
import { RecordingCallError, recordPause, recordPull, recordStart, recordStop, type RecordingChunk } from '@marinoscar/hexactra-browser-agent/recording';

import { PART_CONTENT_TYPE, partKey } from '../../recordings/recording-keys';
import { readRecordingsSettings } from '../../recordings/recordings.settings';
import { isTerminal } from '../../tasks/run-status';
import { FabricSession } from '../fabric-session';
import type { HostDeps } from './deps';

export const RECORDING_PULL_EVERY_MS = 10_000;
/** Frames are at most this wide (CSS pixels). */
export const RECORDING_MAX_WIDTH = 1280;

/** The fabric calls the recorder makes: the package's, bound to the run's fabric session (tests replace them). */
export interface RecorderCalls {
  start(sessionId: string): Promise<string>;
  pull(sessionId: string, recordingId: string): Promise<RecordingChunk>;
  pause(sessionId: string, recordingId: string, paused: boolean): Promise<void>;
  stop(sessionId: string, recordingId: string): Promise<RecordingChunk>;
}

export function fabricRecorderCalls(d: Pick<HostDeps, 'fabric'>): RecorderCalls {
  const session = new FabricSession(d.fabric);
  return {
    start: (s) => recordStart(session, s, { maxWidth: RECORDING_MAX_WIDTH }),
    pull: (s, r) => recordPull(session, d.fabric, s, r),
    pause: (s, r, p) => recordPause(session, s, r, p),
    stop: (s, r) => recordStop(session, d.fabric, s, r),
  };
}

type Deps = Pick<HostDeps, 'prisma' | 'artifacts' | 'systemSettings' | 'log' | 'clock'>;

interface Row {
  id: string;
  status: string;
  fabricId: string | null;
  partCount: number;
}

export class RunRecorder {
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private row: Row | null = null;
  /** The session the extension's recording belongs to. */
  private recordingSession: string | null = null;
  /** What the recorder last told the extension; unknown at the start of a job. */
  private paused: boolean | null = null;
  private done = false;

  private constructor(
    private readonly d: Deps,
    private readonly calls: RecorderCalls,
    private readonly runId: string,
    private readonly userId: string,
    private readonly maxMs: number,
  ) {}

  /**
   * The recorder of one job, or null when the run does not record (not opted in, no storage, or its recording already ended). It ticks
   * once now and then every 10 s until `endJob`.
   */
  static async start(d: Deps, calls: RecorderCalls, runId: string, userId: string, opts: { everyMs?: number } = {}): Promise<RunRecorder | null> {
    try {
      if (!d.artifacts) return null;
      const run = await d.prisma.forUser({ userId }).run.findFirst({ where: { id: runId }, select: { recordVideo: true } });
      if (!run?.recordVideo) return null;
      const existing = await d.prisma.runRecording.findUnique({ where: { runId }, select: { id: true, status: true, fabricId: true, partCount: true } });
      if (existing && existing.status !== 'recording') return null;
      const settings = readRecordingsSettings(await d.systemSettings?.getNamespace('recordings').catch(() => undefined));
      const r = new RunRecorder(d, calls, runId, userId, settings.maxMinutes * 60_000);
      r.row = existing;
      r.recordingSession = existing?.fabricId ? '?' : null;
      r.tick();
      r.timer = setInterval(() => r.tick(), opts.everyMs ?? RECORDING_PULL_EVERY_MS);
      r.timer.unref?.();
      return r;
    } catch (e) {
      d.log.warn(`run ${runId}: the recorder did not start (${e instanceof Error ? e.name : 'error'})`);
      return null;
    }
  }

  /** Queue one tick after the ones before it; never throws. */
  tick(): Promise<void> {
    this.chain = this.chain.then(() => this.step()).catch((e) => this.d.log.warn(`run ${this.runId}: recording tick failed (${e instanceof Error ? e.name : 'error'})`));
    return this.chain;
  }

  /** The job is ending: a last pull, then stop the recording if the run ended, or hold it while the owner has paused the run. */
  async endJob(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tick();
    this.chain = this.chain.then(async () => {
      if (this.done || !this.row?.fabricId) return;
      const run = await this.d.prisma.forUser({ userId: this.userId }).run.findFirst({ where: { id: this.runId }, select: { status: true, sessionId: true } });
      if (!run) return;
      const sessionId = run.sessionId ?? '';
      if (isTerminal(run.status)) {
        await this.finish(sessionId, null);
      } else if (run.status === 'paused' && sessionId && this.paused !== true) {
        await this.calls.pause(sessionId, this.row.fabricId, true).catch(() => undefined);
        this.paused = true;
      }
    }).catch((e) => this.d.log.warn(`run ${this.runId}: recording end failed (${e instanceof Error ? e.name : 'error'})`));
    await this.chain;
  }

  private db() {
    return this.d.prisma;
  }

  private async step(): Promise<void> {
    if (this.done) return;
    const run = await this.d.prisma.forUser({ userId: this.userId }).run.findFirst({ where: { id: this.runId }, select: { sessionId: true } });
    const sessionId = run?.sessionId;
    if (!sessionId) return;
    if (!this.row) {
      this.row = await this.db().runRecording.upsert({
        where: { runId: this.runId },
        create: { runId: this.runId, userId: this.userId },
        update: {},
        select: { id: true, status: true, fabricId: true, partCount: true },
      });
      if (this.row.status !== 'recording') {
        this.done = true;
        return;
      }
    }
    // A new session (the browser restarted) has no recording of ours: start one there.
    if (this.row.fabricId && this.recordingSession !== '?' && this.recordingSession !== sessionId) await this.forget('restarted');
    if (!this.row.fabricId) {
      try {
        const id = await this.calls.start(sessionId);
        this.row.fabricId = id;
        this.recordingSession = sessionId;
        this.paused = false;
        await this.db().runRecording.update({ where: { id: this.row.id }, data: { fabricId: id } });
      } catch (e) {
        if (e instanceof RecordingCallError && e.code === 'encoder_unavailable') await this.fail('encoder_unavailable');
        // Anything else (a secret is being asked for, a busy host): the next tick tries again.
        return;
      }
    }
    this.recordingSession = sessionId;
    const recordingId = this.row.fabricId!;
    // A job works the run: the recording runs (it is held only while the owner has paused the run, see endJob). Nothing is withheld for a
    // secret or a sign-in request (#882).
    if (this.paused !== false) {
      await this.calls.pause(sessionId, recordingId, false).then(() => (this.paused = false)).catch(() => undefined);
    }
    let chunk: RecordingChunk;
    try {
      chunk = await this.calls.pull(sessionId, recordingId);
    } catch (e) {
      if (e instanceof RecordingCallError && e.code === 'recording_not_found') await this.forget('restarted');
      return;
    }
    if (!(await this.store(chunk))) return;
    if (chunk.encoderError || chunk.ended) await this.finish(sessionId, chunk.encoderError ? 'encoder_failed' : chunk.ended === 'stopped' ? null : chunk.ended, true);
    else if (chunk.durationMs >= this.maxMs) await this.finish(sessionId, 'max_minutes');
  }

  /** Store a chunk as the next part. False when storage failed (the recording is then failed). */
  private async store(chunk: RecordingChunk): Promise<boolean> {
    const row = this.row!;
    if (chunk.bytes.length > 0) {
      // The part's number is taken in the database, so two jobs of one run (one superseded) never write the same part.
      const { partCount } = await this.db().runRecording.update({ where: { id: row.id }, data: { partCount: { increment: 1 }, bytes: { increment: chunk.bytes.length } }, select: { partCount: true } });
      row.partCount = partCount;
      try {
        await this.d.artifacts!.put(partKey(this.userId, this.runId, partCount - 1), chunk.bytes, PART_CONTENT_TYPE);
      } catch (e) {
        this.d.log.warn(`run ${this.runId}: could not store a recording part (${e instanceof Error ? e.name : 'error'})`);
        row.partCount = (await this.db().runRecording.update({ where: { id: row.id }, data: { partCount: { decrement: 1 }, bytes: { decrement: chunk.bytes.length } }, select: { partCount: true } })).partCount;
        await this.fail('storage_error');
        return false;
      }
    }
    await this.db().runRecording.update({ where: { id: row.id }, data: { ...(chunk.durationMs ? { durationMs: chunk.durationMs } : {}), droppedFrames: chunk.dropped } });
    return true;
  }

  /** The extension lost the recording (its worker restarted, a new session): the next tick starts a new one; the parts so far stay. */
  private async forget(note: string): Promise<void> {
    this.row!.fabricId = null;
    this.recordingSession = null;
    this.paused = null;
    await this.db().runRecording.update({ where: { id: this.row!.id }, data: { fabricId: null, note } });
  }

  /** Stop (unless the extension already ended it), store the last bytes, and hand the recording to the finalize job. */
  private async finish(sessionId: string, note: string | null, ended = false): Promise<void> {
    const row = this.row!;
    if (!ended && row.fabricId && sessionId) {
      const last = await this.calls.stop(sessionId, row.fabricId).catch(() => null);
      if (last && !(await this.store(last))) return;
    }
    this.done = true;
    await this.db().runRecording.update({
      where: { id: row.id },
      data: { status: row.partCount > 0 ? 'processing' : 'failed', fabricId: null, endedAt: new Date(this.d.clock()), ...(note ? { note } : row.partCount > 0 ? {} : { note: 'empty' }) },
    });
  }

  private async fail(note: string): Promise<void> {
    this.done = true;
    if (this.row?.fabricId && this.recordingSession && this.recordingSession !== '?') await this.calls.stop(this.recordingSession, this.row.fabricId).catch(() => null);
    // The parts stored so far are still a video: the finalize job makes it, and the note says why it is short.
    await this.db().runRecording.update({ where: { id: this.row!.id }, data: { status: (this.row?.partCount ?? 0) > 0 ? 'processing' : 'failed', fabricId: null, note, endedAt: new Date(this.d.clock()) } });
  }
}
