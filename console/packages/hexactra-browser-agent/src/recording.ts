/**
 * The fabric calls of a run recording (epic #755, docs/decisions/run-recordings.md): start, pull, pause and stop a video recording of the
 * session's tab. THE VIDEO IS NOT MASKED: it exists only for a run its owner opted in, and the host keeps it out of every export.
 *
 * These are not agent tools. The host's recorder calls them beside the loop, like a trace screenshot: they change nothing on the page, take
 * no budget and are never offered to the model. Every call is bounded; a failure is a typed `RecordingCallError`, never a thrown fabric error.
 */
import type { ActSession, ArtifactFetcher } from './vision';

/** How long one recording call may take before it is given up (the pull carries at most 8 MiB). */
export const RECORDING_CALL_TIMEOUT_MS = 20_000;

/** Why a recording call failed, as a short code the host stores (never page text). */
export type RecordingFailure = 'recording_not_found' | 'recording_active' | 'encoder_unavailable' | 'encoder_failed' | 'unavailable';

export class RecordingCallError extends Error {
  constructor(readonly code: RecordingFailure, detail?: string) {
    super(`recording: ${code}${detail ? ` (${detail})` : ''}`);
  }
}

/** One pulled chunk: whole records of the extension's framed stream, in `seq` order. */
export interface RecordingChunk {
  bytes: Buffer;
  seq: number;
  frames: number;
  dropped: number;
  durationMs: number;
  /** Why the recording ended on its own (`tab_closed`, `detached`), or `stopped`. */
  ended: string | null;
  /** The encoder failed: the recording keeps what it has and ends. */
  encoderError: string | null;
  done: boolean;
}

const CODES: RecordingFailure[] = ['recording_not_found', 'recording_active', 'encoder_unavailable', 'encoder_failed'];

function failure(message: string | null | undefined): RecordingCallError {
  const text = message ?? '';
  const code = CODES.find((c) => text.includes(c)) ?? 'unavailable';
  return new RecordingCallError(code);
}

async function call(session: ActSession, sessionId: string, action: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RecordingCallError('unavailable', 'timed out')), timeoutMs);
  });
  try {
    // waitForTakeover: false, like a trace screenshot: a recording call never waits for a person who holds the desktop.
    const op = await Promise.race([session.act(sessionId, action, timeoutMs, { waitForTakeover: false }), timeout]);
    if (op.state !== 'succeeded') throw failure(op.error);
    return (op.result ?? {}) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof RecordingCallError) throw e;
    throw failure(e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ''}` : String(e));
  } finally {
    clearTimeout(timer);
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const text = (v: unknown) => (typeof v === 'string' && v ? v : null);

async function chunkOf(fabric: ArtifactFetcher, r: Record<string, unknown>): Promise<RecordingChunk> {
  let bytes = Buffer.alloc(0);
  if (typeof r.data === 'string' && r.data) bytes = Buffer.from(r.data, 'base64');
  else if (typeof r.artifact_id === 'string' && num(r.size) > 0) {
    const res = await fabric.raw('GET', `/v1/artifacts/${r.artifact_id}`, { retries: 1 });
    bytes = Buffer.from(await res.arrayBuffer());
  }
  return {
    bytes,
    seq: num(r.seq),
    frames: num(r.frames),
    dropped: num(r.dropped),
    durationMs: num(r.duration_ms),
    ended: text(r.ended),
    encoderError: text(r.encoder_error),
    done: r.done === true,
  };
}

/** Start recording the session's active tab; returns the extension's recording id. */
export async function recordStart(session: ActSession, sessionId: string, opts: { maxWidth?: number; quality?: number } = {}, timeoutMs = RECORDING_CALL_TIMEOUT_MS): Promise<string> {
  const r = await call(session, sessionId, { type: 'record_start', ...(opts.maxWidth ? { max_width: opts.maxWidth } : {}), ...(opts.quality ? { quality: opts.quality } : {}) }, timeoutMs);
  const id = text(r.recording_id);
  if (!id) throw new RecordingCallError('unavailable', 'no recording id');
  return id;
}

/** Take the bytes written since the last pull. */
export async function recordPull(session: ActSession, fabric: ArtifactFetcher, sessionId: string, recordingId: string, timeoutMs = RECORDING_CALL_TIMEOUT_MS): Promise<RecordingChunk> {
  return chunkOf(fabric, await call(session, sessionId, { type: 'record_pull', recording_id: recordingId }, timeoutMs));
}

/** Hold (no frame is kept) or resume the recording. */
export async function recordPause(session: ActSession, sessionId: string, recordingId: string, paused: boolean, timeoutMs = RECORDING_CALL_TIMEOUT_MS): Promise<void> {
  await call(session, sessionId, { type: 'record_pause', recording_id: recordingId, paused }, timeoutMs);
}

/** Stop the recording and take its last bytes. */
export async function recordStop(session: ActSession, fabric: ArtifactFetcher, sessionId: string, recordingId: string, timeoutMs = RECORDING_CALL_TIMEOUT_MS): Promise<RecordingChunk> {
  return chunkOf(fabric, await call(session, sessionId, { type: 'record_stop', recording_id: recordingId }, timeoutMs));
}
