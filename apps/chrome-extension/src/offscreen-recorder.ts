// The run recording's encoder (epic #755), in the extension's offscreen
// document: WebCodecs is not available in an MV3 service worker.
//
// The service worker (recorder.ts) sends the screencast's JPEG frames here;
// this page decodes each one, draws it on a fixed-size canvas, encodes it to
// VP8 and queues the encoded frames as records (recording-format.ts) until the
// service worker pulls them. Nothing here reads the page or decides what is
// recorded: the frames that must not be kept are dropped before they arrive.

import { RecordQueue, encodeFrame, encodeHeader, toBase64 } from './recording-format.js';

export const OFFSCREEN_TARGET = 'hexactra-recorder-offscreen';

/** Encoded bytes held for one recording before frames are dropped (the runner pulls every 10 s). */
export const MAX_PENDING_BYTES = 64 * 1024 * 1024;
/** A key frame at least this often, so the video can be seeked. */
export const KEY_FRAME_EVERY_MS = 2_000;
const BITRATE = 1_500_000;

interface Encoding {
  queue: RecordQueue;
  encoder: VideoEncoder | null;
  canvas: OffscreenCanvas | null;
  width: number;
  height: number;
  frames: number;
  dropped: number;
  lastKeyMs: number;
  lastTs: number;
  last: ImageBitmap | null;
  chain: Promise<unknown>;
  error: string | null;
}

const encodings = new Map<string, Encoding>();

type Command =
  | { cmd: 'open'; id: string }
  | { cmd: 'frame'; id: string; data: string; ts: number }
  | { cmd: 'take'; id: string; max: number }
  | { cmd: 'close'; id: string; ts: number };

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

async function decode(base64: string): Promise<ImageBitmap> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
}

function startEncoder(e: Encoding, width: number, height: number): void {
  if (typeof VideoEncoder === 'undefined') throw new Error('encoder_unavailable: WebCodecs is not available');
  e.width = even(width);
  e.height = even(height);
  e.canvas = new OffscreenCanvas(e.width, e.height);
  e.encoder = new VideoEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      e.queue.push(encodeFrame(chunk.type === 'key', chunk.timestamp / 1000, bytes));
    },
    error: (err) => {
      e.error = `encoder_failed: ${err.message}`;
    },
  });
  e.encoder.configure({ codec: 'vp8', width: e.width, height: e.height, bitrate: BITRATE, framerate: 10, latencyMode: 'realtime' });
  e.queue.push(encodeHeader(e.width, e.height, 'vp8'));
}

function encodeBitmap(e: Encoding, bitmap: ImageBitmap, ts: number): void {
  if (!e.encoder) startEncoder(e, bitmap.width, bitmap.height);
  const ctx = e.canvas!.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, e.width, e.height);
  // Fit, keeping the aspect ratio (a resized window letterboxes).
  const scale = Math.min(e.width / bitmap.width, e.height / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (e.width - w) / 2, (e.height - h) / 2, w, h);
  const ms = Math.max(ts, e.lastTs + 1);
  const frame = new VideoFrame(e.canvas!, { timestamp: ms * 1000 });
  const key = e.frames === 0 || ms - e.lastKeyMs >= KEY_FRAME_EVERY_MS;
  if (key) e.lastKeyMs = ms;
  e.encoder!.encode(frame, { keyFrame: key });
  frame.close();
  e.lastTs = ms;
  e.frames++;
}

function stats(e: Encoding) {
  return { frames: e.frames, dropped: e.dropped, bytes_total: e.queue.total, duration_ms: Math.max(0, Math.round(e.lastTs)) };
}

async function handle(c: Command): Promise<unknown> {
  if (c.cmd === 'open') {
    if (encodings.has(c.id)) throw new Error('recording_active');
    encodings.set(c.id, {
      queue: new RecordQueue(), encoder: null, canvas: null, width: 0, height: 0, frames: 0, dropped: 0,
      lastKeyMs: 0, lastTs: -1, last: null, chain: Promise.resolve(), error: null,
    });
    return {};
  }
  const e = encodings.get(c.id);
  if (!e) throw new Error('recording_not_found');
  if (c.cmd === 'frame') {
    e.chain = e.chain.then(async () => {
      if (e.error) return;
      if (e.queue.pending > MAX_PENDING_BYTES) {
        e.dropped++;
        return;
      }
      const bitmap = await decode(c.data);
      e.last?.close();
      e.last = bitmap;
      encodeBitmap(e, bitmap, c.ts);
    }).catch((err) => {
      e.error = e.error ?? `encoder_failed: ${err instanceof Error ? err.message : String(err)}`;
    });
    return {};
  }
  if (c.cmd === 'take') {
    await e.chain;
    const data = e.queue.take(c.max);
    return { data: toBase64(data), size: data.length, error: e.error, ...stats(e) };
  }
  // close: the last picture again at the stop time, so the video lasts until the end.
  await e.chain;
  try {
    if (e.encoder && e.last && !e.error && c.ts > e.lastTs) encodeBitmap(e, e.last, c.ts);
    await e.encoder?.flush();
  } catch (err) {
    e.error = e.error ?? `encoder_failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  const data = e.queue.take(Number.MAX_SAFE_INTEGER);
  const out = { data: toBase64(data), size: data.length, error: e.error, ...stats(e) };
  try {
    e.encoder?.close();
  } catch {
    // Already closed after an error.
  }
  e.last?.close();
  encodings.delete(c.id);
  return out;
}

/** The offscreen page's message entry point. */
export function startOffscreenRecorder(): void {
  chrome.runtime.onMessage.addListener((msg: { target?: string } & Command, _sender, sendResponse) => {
    if (msg?.target !== OFFSCREEN_TARGET) return false;
    handle(msg).then(
      (result) => sendResponse({ ok: true, result }),
      (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });
}

if (typeof document !== 'undefined' && document.documentElement?.dataset?.hexactra === 'offscreen-recorder') {
  startOffscreenRecorder();
}
