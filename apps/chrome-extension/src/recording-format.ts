// The byte format of a run recording's chunks (epic #755).
//
// The extension does not write a video container. It hands the console the
// encoded frames, in order, as a stream of self-delimited records; the
// console's finalize job muxes them into one seekable WebM (with its duration
// and cues). A pull returns whole records only, so the chunks of one
// recording, concatenated in `seq` order, are one valid stream.
//
// Stream := Header Frame*
// Header := "HXR1" (4 bytes) | u16 width | u16 height | u8 codecLength | codec (ASCII, e.g. "vp8")
// Frame  := u8 0x01 | u8 flags (bit 0: key frame) | u32 timestamp (ms since the recording started) | u32 length | bytes
//
// All integers are big-endian. The console's reader is
// console/apps/api/src/tasks/recordings/recording-format.ts; keep both in step.

export const RECORDING_MIME = 'application/x-hexactra-recording';
export const RECORDING_MAGIC = 'HXR1';
export const FRAME_RECORD = 0x01;
export const FRAME_HEADER_BYTES = 10;

/** The stream header: the frame size and the codec, written once, first. */
export function encodeHeader(width: number, height: number, codec: string): Uint8Array {
  const name = new TextEncoder().encode(codec);
  if (name.length > 255) throw new Error('codec name too long');
  const out = new Uint8Array(4 + 2 + 2 + 1 + name.length);
  out.set(new TextEncoder().encode(RECORDING_MAGIC), 0);
  const v = new DataView(out.buffer);
  v.setUint16(4, width);
  v.setUint16(6, height);
  v.setUint8(8, name.length);
  out.set(name, 9);
  return out;
}

/** One encoded frame. */
export function encodeFrame(key: boolean, timestampMs: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + data.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, FRAME_RECORD);
  v.setUint8(1, key ? 1 : 0);
  v.setUint32(2, Math.max(0, Math.min(0xffffffff, Math.round(timestampMs))));
  v.setUint32(6, data.length);
  out.set(data, FRAME_HEADER_BYTES);
  return out;
}

/**
 * Whole records waiting to be pulled. `take(max)` returns as many whole
 * records as fit in `max` bytes (always at least one, so a single large key
 * frame is never stuck), in order.
 */
export class RecordQueue {
  private records: Uint8Array[] = [];
  private queued = 0;
  total = 0;

  push(record: Uint8Array): void {
    this.records.push(record);
    this.queued += record.length;
    this.total += record.length;
  }

  get pending(): number {
    return this.queued;
  }

  take(max: number): Uint8Array {
    let n = 0;
    let size = 0;
    while (n < this.records.length && (n === 0 || size + this.records[n].length <= max)) {
      size += this.records[n].length;
      n++;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const r of this.records.splice(0, n)) {
      out.set(r, at);
      at += r.length;
    }
    this.queued -= size;
    return out;
  }
}

/** Base64 of bytes, in slices (no call-stack limit on large chunks). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(s);
}
