// The reader of a run recording's framed stream (epic #755). The writer is the extension's
// apps/chrome-extension/src/recording-format.ts; keep both in step.
//
// Stream := Header Frame*         (a recording the extension restarted carries a second Header later on)
// Header := "HXR1" | u16 width | u16 height | u8 codecLength | codec
// Frame  := u8 0x01 | u8 flags (bit 0: key frame) | u32 timestamp ms | u32 length | bytes
// Big-endian. The parts of one recording, concatenated in order, are one stream.

export const RECORDING_MIME = 'application/x-hexactra-recording';
const MAGIC = Buffer.from('HXR1', 'ascii');
const FRAME_RECORD = 0x01;
const FRAME_HEADER_BYTES = 10;
/** The gap left in the timeline where a restarted recording joins the one before. */
export const SEGMENT_GAP_MS = 100;

export interface RecordedFrame {
  key: boolean;
  /** Milliseconds since the recording started, increasing. */
  ts: number;
  data: Buffer;
}

export interface RecordedStream {
  width: number;
  height: number;
  codec: string;
  frames: RecordedFrame[];
  /** How many headers the stream had (1 + the times the extension restarted the recording). */
  segments: number;
}

/** A stream that cannot be read. */
export class RecordingFormatError extends Error {}

/**
 * Read a whole stream. A second header starts a new segment: its frames continue the timeline after the last frame (plus a short gap),
 * and the first header's frame size is the video's. A truncated last record (a part that was cut) is dropped, not an error.
 */
export function readRecording(bytes: Buffer): RecordedStream {
  let at = 0;
  let width = 0;
  let height = 0;
  let codec = '';
  let segments = 0;
  let offset = 0;
  let last = -1;
  const frames: RecordedFrame[] = [];
  while (at < bytes.length) {
    if (bytes.length - at >= 4 && bytes.subarray(at, at + 4).equals(MAGIC)) {
      if (bytes.length - at < 9) break;
      const w = bytes.readUInt16BE(at + 4);
      const h = bytes.readUInt16BE(at + 6);
      const n = bytes.readUInt8(at + 8);
      if (bytes.length - at < 9 + n) break;
      const c = bytes.subarray(at + 9, at + 9 + n).toString('ascii');
      if (segments === 0) {
        width = w;
        height = h;
        codec = c;
      } else {
        offset = last + SEGMENT_GAP_MS;
      }
      segments++;
      at += 9 + n;
      continue;
    }
    if (segments === 0) throw new RecordingFormatError('the recording does not start with a header');
    if (bytes[at] !== FRAME_RECORD) throw new RecordingFormatError(`unknown record type ${bytes[at]} at byte ${at}`);
    if (bytes.length - at < FRAME_HEADER_BYTES) break;
    const flags = bytes.readUInt8(at + 1);
    const ts = bytes.readUInt32BE(at + 2);
    const len = bytes.readUInt32BE(at + 6);
    if (bytes.length - at - FRAME_HEADER_BYTES < len) break;
    const t = Math.max(offset + ts, last + 1);
    frames.push({ key: (flags & 1) === 1, ts: t, data: bytes.subarray(at + FRAME_HEADER_BYTES, at + FRAME_HEADER_BYTES + len) });
    last = t;
    at += FRAME_HEADER_BYTES + len;
  }
  if (segments === 0) throw new RecordingFormatError('the recording is empty');
  return { width, height, codec, frames, segments };
}

/** Write a stream (tests, and the fixtures of the finalize job's specs). */
export function writeRecording(width: number, height: number, codec: string, frames: { key: boolean; ts: number; data: Buffer }[]): Buffer {
  const name = Buffer.from(codec, 'ascii');
  const head = Buffer.alloc(9 + name.length);
  MAGIC.copy(head, 0);
  head.writeUInt16BE(width, 4);
  head.writeUInt16BE(height, 6);
  head.writeUInt8(name.length, 8);
  name.copy(head, 9);
  const parts: Buffer[] = [head];
  for (const f of frames) {
    const h = Buffer.alloc(FRAME_HEADER_BYTES);
    h.writeUInt8(FRAME_RECORD, 0);
    h.writeUInt8(f.key ? 1 : 0, 1);
    h.writeUInt32BE(f.ts, 2);
    h.writeUInt32BE(f.data.length, 6);
    parts.push(h, f.data);
  }
  return Buffer.concat(parts);
}
