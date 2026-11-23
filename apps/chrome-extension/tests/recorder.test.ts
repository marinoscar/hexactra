import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCdp } from '../src/cdp';
import { MAX_FPS, recordPause, recordPull, recordStart, recordStop, resetRecorder } from '../src/recorder';
import { RECORDING_MIME, RecordQueue, encodeFrame, encodeHeader, toBase64 } from '../src/recording-format';
import { handleRequest } from '../src/remote';

type EventListener = (source: { tabId?: number }, method: string, params: unknown) => void;

function makeChrome(opts: { offscreen?: boolean; focusSensitive?: () => boolean } = {}) {
  const events: EventListener[] = [];
  const commands: { method: string; params?: unknown }[] = [];
  const received: { id: string; data: string; ts: number }[] = [];
  const open = new Set<string>();
  const api = {
    debugger: {
      attach: vi.fn(async () => undefined),
      sendCommand: vi.fn(async (_t: unknown, method: string, params?: unknown) => {
        commands.push({ method, params });
        if (method === 'Runtime.evaluate') return { result: { type: 'boolean', value: opts.focusSensitive?.() ?? false } };
        return {};
      }),
      onEvent: { addListener: (l: EventListener) => events.push(l) },
      onDetach: { addListener: vi.fn() },
    },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, windowId: 1, url: 'https://shop.test/', active: true, status: 'complete' })),
      query: vi.fn(async () => [{ id: 1, windowId: 1, url: 'https://shop.test/', active: true, status: 'complete' }]),
      onRemoved: { addListener: vi.fn() },
    },
    runtime: {
      sendMessage: vi.fn(async (msg: { cmd: string; id: string; data?: string; ts?: number }) => {
        // A fake offscreen encoder: one "encoded" record per frame.
        if (msg.cmd === 'open') {
          open.add(msg.id);
          return { ok: true, result: {} };
        }
        if (!open.has(msg.id)) return { ok: false, error: 'recording_not_found' };
        if (msg.cmd === 'frame') {
          received.push({ id: msg.id, data: msg.data!, ts: msg.ts! });
          return { ok: true, result: {} };
        }
        const taken = { data: toBase64(new Uint8Array(received.length)), size: received.length, error: null, frames: received.length, dropped: 0, bytes_total: received.length, duration_ms: 1000 };
        if (msg.cmd === 'close') open.delete(msg.id);
        return { ok: true, result: taken };
      }),
    },
    ...(opts.offscreen === false
      ? {}
      : { offscreen: { hasDocument: vi.fn(async () => false), createDocument: vi.fn(async () => undefined) } }),
  };
  const frame = (tabId: number, data: string) => {
    for (const l of events) l({ tabId }, 'Page.screencastFrame', { data, sessionId: 7 });
  };
  return { api, commands, received, frame };
}

let c: ReturnType<typeof makeChrome>;
const gap = 1000 / MAX_FPS + 5;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  resetCdp();
  resetRecorder();
  c = makeChrome();
  vi.stubGlobal('chrome', c.api);
});

afterEach(() => {
  vi.useRealTimers();
});

async function tick(ms = gap) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('run recordings (#755)', () => {
  it('starts a screencast, keeps frames in order, acknowledges each, and pulls chunks', async () => {
    const { recording_id } = await recordStart(1);
    expect(recording_id).toMatch(/^rec-[0-9a-f]{24}$/);
    expect(c.commands.find((x) => x.method === 'Page.startScreencast')?.params).toMatchObject({ format: 'jpeg', maxWidth: 1280 });
    c.frame(1, 'A');
    await tick();
    c.frame(1, 'B');
    await tick();
    expect(c.received.map((r) => r.data)).toEqual(['A', 'B']);
    expect(c.commands.filter((x) => x.method === 'Page.screencastFrameAck')).toHaveLength(2);
    const first = await recordPull(recording_id);
    expect(first).toMatchObject({ mime: RECORDING_MIME, seq: 0, frames: 2 });
    expect((await recordPull(recording_id)).seq).toBe(1);
  });

  it('keeps the latest frame of a burst and drops the rest', async () => {
    const { recording_id } = await recordStart(1);
    c.frame(1, 'A');
    await vi.advanceTimersByTimeAsync(1);
    c.frame(1, 'B');
    await vi.advanceTimersByTimeAsync(1);
    c.frame(1, 'C');
    await tick(200);
    expect(c.received.map((r) => r.data)).toEqual(['A', 'C']);
    expect((await recordPull(recording_id)).dropped).toBe(1);
  });

  it('keeps every frame while a sensitive value is typed: the recording withholds nothing (#882)', async () => {
    await recordStart(1);
    const typing = handleRequest({ type: 'request', id: 't', action: { type: 'type_keys', text: '424242', sensitive: true }, deadline_ms: Date.now() + 10_000 });
    c.frame(1, 'while-typing');
    await tick();
    await typing;
    c.frame(1, 'right-after');
    await tick();
    expect(c.received.map((r) => r.data)).toEqual(['while-typing', 'right-after']);
  });

  it('keeps every frame while a password field has focus, and never asks the page (#882)', async () => {
    c = makeChrome({ focusSensitive: () => true });
    vi.stubGlobal('chrome', c.api);
    await recordStart(1);
    c.frame(1, 'password-field');
    await tick();
    expect(c.received.map((r) => r.data)).toEqual(['password-field']);
    expect(c.commands.some((x) => x.method === 'Runtime.evaluate')).toBe(false);
  });

  it('keeps no frame while paused', async () => {
    const { recording_id } = await recordStart(1);
    expect(recordPause(recording_id, true)).toEqual({ paused: true });
    c.frame(1, 'while-paused');
    await tick();
    recordPause(recording_id, false);
    c.frame(1, 'resumed');
    await tick();
    expect(c.received.map((r) => r.data)).toEqual(['resumed']);
  });

  it('stops: ends the screencast, returns the last bytes with done, and forgets the recording', async () => {
    const { recording_id } = await recordStart(1);
    const last = await recordStop(recording_id);
    expect(last).toMatchObject({ mime: RECORDING_MIME, done: true, ended: 'stopped' });
    expect(c.commands.some((x) => x.method === 'Page.stopScreencast')).toBe(true);
    await expect(recordPull(recording_id)).rejects.toThrow(/recording_not_found/);
  });

  it('refuses a second recording of the same tab', async () => {
    await recordStart(1);
    await expect(recordStart(1)).rejects.toThrow(/recording_active/);
  });

  it('fails clearly when Chrome has no offscreen documents', async () => {
    c = makeChrome({ offscreen: false });
    vi.stubGlobal('chrome', c.api);
    await expect(recordStart(1)).rejects.toThrow(/encoder_unavailable/);
  });

  it('is reachable through the bridge, with typed errors', async () => {
    const started = await handleRequest({ type: 'request', id: '1', action: { type: 'record_start' }, deadline_ms: Date.now() + 10_000 });
    expect(started.ok).toBe(true);
    const missing = await handleRequest({ type: 'request', id: '2', action: { type: 'record_pull', recording_id: 'rec-none' }, deadline_ms: Date.now() + 10_000 });
    expect(missing).toMatchObject({ ok: false });
    expect(missing.error).toMatch(/^recording_not_found/);
  });
});

describe('the recording byte format', () => {
  it('writes a header and self-delimited frames', () => {
    const h = encodeHeader(1280, 720, 'vp8');
    expect(new TextDecoder().decode(h.subarray(0, 4))).toBe('HXR1');
    const v = new DataView(h.buffer);
    expect([v.getUint16(4), v.getUint16(6), v.getUint8(8)]).toEqual([1280, 720, 3]);
    const f = encodeFrame(true, 1234.4, new Uint8Array([9, 8, 7]));
    const fv = new DataView(f.buffer);
    expect([fv.getUint8(0), fv.getUint8(1), fv.getUint32(2), fv.getUint32(6)]).toEqual([1, 1, 1234, 3]);
    expect(Array.from(f.subarray(10))).toEqual([9, 8, 7]);
  });

  it('takes whole records only, at least one', () => {
    const q = new RecordQueue();
    q.push(new Uint8Array(5));
    q.push(new Uint8Array(5));
    q.push(new Uint8Array(20));
    expect(q.take(12).length).toBe(10);
    expect(q.take(3).length).toBe(20);
    expect(q.pending).toBe(0);
    expect(q.total).toBe(30);
  });
});
