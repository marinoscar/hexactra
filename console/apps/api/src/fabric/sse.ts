// A small, bounded reader of a server-sent-events body: reads the events the server replays at once and stops when the
// stream goes quiet, the deadline passes or enough events were read. Used to drain a replay (`GET /v1/events?after=0`)
// without holding a connection open.

/** One event of the stream: `data` is the parsed JSON of the `data:` lines, `event` the `event:` name. */
export interface SseEvent {
  event: string;
  data: unknown;
}

export interface SseReadOptions {
  /** Stop when nothing arrived for this long. */
  idleMs: number;
  /** Stop after this long in all. */
  maxMs: number;
  /** Stop after this many events. */
  maxEvents: number;
}

/** Splits `buffer` into complete frames (blank-line separated) and the rest. Pure. */
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = parts.pop() ?? '';
  return { frames: parts.filter((p) => p.trim() !== ''), rest };
}

/** One frame as an event; comments (`: keep-alive`) and frames without data are skipped. Pure. */
export function parseFrame(frame: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) as unknown };
  } catch {
    return null;
  }
}

/**
 * Reads events from `body` until it is idle for `idleMs`, `maxMs` passed, `maxEvents` were read or the stream ended.
 * Always cancels the body. Never throws on a broken stream: it returns what it has read.
 */
export async function readSseEvents(body: ReadableStream<Uint8Array> | null, opts: SseReadOptions): Promise<SseEvent[]> {
  if (!body) return [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const out: SseEvent[] = [];
  const started = Date.now();
  let buffer = '';
  try {
    for (;;) {
      const left = Math.min(opts.idleMs, opts.maxMs - (Date.now() - started));
      if (left <= 0 || out.length >= opts.maxEvents) break;
      let timer: NodeJS.Timeout | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<'idle'>((resolve) => {
          timer = setTimeout(() => resolve('idle'), left);
        }),
      ]).finally(() => clearTimeout(timer));
      if (next === 'idle' || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const { frames, rest } = splitFrames(buffer);
      buffer = rest;
      for (const f of frames) {
        const ev = parseFrame(f);
        if (ev) out.push(ev);
        if (out.length >= opts.maxEvents) break;
      }
    }
  } catch {
    // A broken stream returns what was read.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out;
}
