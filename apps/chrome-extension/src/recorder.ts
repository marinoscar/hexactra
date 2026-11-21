// Run recordings (epic #755, docs/decisions/run-recordings.md).
//
// `record_start` runs a CDP screencast of the tab (`Page.startScreencast`,
// through the `debugger` permission) and sends its frames to the offscreen
// document, which encodes them (offscreen-recorder.ts). `record_pull` takes the
// encoded bytes, `record_pause` holds the recording, `record_stop` ends it.
//
// THE VIDEO IS NOT MASKED. It exists only when the owner opted the run in.
// What is kept out (this reduces exposure; it is not masking):
// - every frame while a sensitive value is typed (`type` / `type_keys` with
//   `sensitive: true`: a handoff secret or a provider's value), and for a
//   moment after;
// - every frame while the focused element is a sensitive field (a password,
//   a one-time code, a card or account number);
// - every frame while the recording is paused (the runner pauses it while a
//   secret or credentials request is open).

import * as cdp from './cdp.js';
import { RECORDING_MIME } from './recording-format.js';
import { OFFSCREEN_TARGET } from './offscreen-recorder.js';

/** Most bytes of `data` one pull returns. */
export const MAX_PULL_BYTES = 8 * 1024 * 1024;
/** At most this many frames a second are encoded; the latest of a burst is kept. */
export const MAX_FPS = 10;
/** Frames are still dropped this long after sensitive typing ends (the page repaints). */
export const SENSITIVE_TAIL_MS = 1_000;
export const DEFAULT_MAX_WIDTH = 1280;
export const DEFAULT_QUALITY = 70;
const OFFSCREEN_URL = 'offscreen-recorder.html';

/** Raised for a recording action that cannot be performed. */
export class RecordingError extends Error {}

interface Recording {
  id: string;
  tabId: number;
  startedAt: number;
  paused: boolean;
  seq: number;
  dropped: number;
  lastSent: number;
  pending: { data: string; at: number } | null;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  ended: string | null;
  checking: Promise<void>;
}

const recordings = new Map<string, Recording>();
let sensitiveTyping = 0;
let sensitiveUntil = 0;
let listening = false;

/**
 * True when the focused element (through open shadow roots and same-origin
 * frames) is a field whose value must not be recorded. Runs in the page.
 */
export const SENSITIVE_FOCUS_SCRIPT = `(() => {
  let el = document.activeElement;
  for (let i = 0; i < 10 && el; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el.tagName === 'IFRAME') { try { const d = el.contentDocument; if (d && d.activeElement) { el = d.activeElement; continue; } } catch (e) { return true; } }
    break;
  }
  if (!el || el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'password') return true;
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (/one-time-code|cc-number|cc-csc|cc-exp|current-password|new-password/.test(ac)) return true;
  const label = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' ');
  return /otp|passcode|password|pin\\b|cvv|cvc|ssn|routing|account.?number|card.?number|iban/i.test(label);
})()`;

/** Run `fn` while no frame is kept (a sensitive value is being typed). */
export async function withSensitiveTyping<T>(fn: () => Promise<T>): Promise<T> {
  sensitiveTyping++;
  try {
    return await fn();
  } finally {
    sensitiveTyping--;
    sensitiveUntil = Date.now() + SENSITIVE_TAIL_MS;
  }
}

function suppressed(r: Recording): boolean {
  return r.paused || sensitiveTyping > 0 || Date.now() < sensitiveUntil;
}

async function offscreen<T>(msg: Record<string, unknown>): Promise<T> {
  const reply = (await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, ...msg })) as { ok: boolean; result?: T; error?: string } | undefined;
  if (!reply) throw new RecordingError('encoder_unavailable: the offscreen recorder did not answer');
  if (!reply.ok) throw new RecordingError(reply.error ?? 'encoder_failed');
  return reply.result as T;
}

async function ensureOffscreen(): Promise<void> {
  const api = (chrome as unknown as { offscreen?: { hasDocument?: () => Promise<boolean>; createDocument: (o: unknown) => Promise<void> } }).offscreen;
  if (!api) throw new RecordingError('encoder_unavailable: this Chrome has no offscreen documents');
  if (api.hasDocument && (await api.hasDocument())) return;
  try {
    await api.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Encode the screencast of a run the owner chose to record into a video.',
    });
  } catch (e) {
    if (!/single offscreen|already/i.test(e instanceof Error ? e.message : String(e))) {
      throw new RecordingError(`encoder_unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function send(r: Recording, data: string, at: number): void {
  r.lastSent = at;
  void offscreen({ cmd: 'frame', id: r.id, data, ts: at - r.startedAt }).catch(() => {
    r.dropped++;
  });
}

/** Decide about one screencast frame: drop it, keep it, or hold it for the rate limit. */
function onFrame(r: Recording, data: string): void {
  if (r.ended) return;
  if (suppressed(r)) {
    r.dropped++;
    return;
  }
  const at = Date.now();
  // The focus check is in order: a frame is only sent once the check of the
  // frame before it has finished, so frames stay in time order.
  r.checking = r.checking.then(async () => {
    let sensitive = true;
    try {
      const v = await cdp.evaluate(r.tabId, SENSITIVE_FOCUS_SCRIPT, false, 1_000);
      sensitive = v.value !== false;
    } catch {
      // A page that cannot be read: keep the frame out.
    }
    if (sensitive || suppressed(r) || r.ended) {
      r.dropped++;
      return;
    }
    const gap = 1000 / MAX_FPS;
    if (at - r.lastSent >= gap) {
      send(r, data, at);
      return;
    }
    // Too soon: keep the latest frame of the burst and send it when its slot comes.
    if (r.pending) r.dropped++;
    r.pending = { data, at };
    if (!r.pendingTimer) {
      r.pendingTimer = setTimeout(() => {
        r.pendingTimer = null;
        const p = r.pending;
        r.pending = null;
        if (p && !r.ended && !suppressed(r)) send(r, p.data, Math.max(p.at, r.lastSent + gap));
      }, Math.max(0, r.lastSent + gap - at));
    }
  });
}

function listen(): void {
  if (listening) return;
  listening = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (method !== 'Page.screencastFrame' || source.tabId === undefined) return;
    const p = params as { data: string; sessionId: number };
    // Always acknowledge, or Chrome stops sending frames.
    void chrome.debugger.sendCommand({ tabId: source.tabId }, 'Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => undefined);
    for (const r of recordings.values()) if (r.tabId === source.tabId) onFrame(r, p.data);
  });
  chrome.debugger.onDetach?.addListener((source) => {
    for (const r of recordings.values()) if (r.tabId === source.tabId && !r.ended) r.ended = 'detached';
  });
  chrome.tabs.onRemoved?.addListener((tabId) => {
    for (const r of recordings.values()) if (r.tabId === tabId && !r.ended) r.ended = 'tab_closed';
  });
}

function get(id: string): Recording {
  const r = recordings.get(id);
  if (!r) throw new RecordingError(`recording_not_found: no recording ${id}`);
  return r;
}

function newId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return 'rec-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function recordStart(tabId: number, maxWidth = DEFAULT_MAX_WIDTH, quality = DEFAULT_QUALITY) {
  for (const r of recordings.values()) {
    if (r.tabId === tabId && !r.ended) throw new RecordingError(`recording_active: this tab is already recorded (${r.id})`);
  }
  if (!cdp.cdpAvailable()) throw new RecordingError('encoder_unavailable: the debugger API is not available');
  await ensureOffscreen();
  const id = newId();
  await offscreen({ cmd: 'open', id });
  const r: Recording = {
    id, tabId, startedAt: Date.now(), paused: false, seq: 0, dropped: 0, lastSent: 0,
    pending: null, pendingTimer: null, ended: null, checking: Promise.resolve(),
  };
  recordings.set(id, r);
  listen();
  try {
    await cdp.send(tabId, 'Page.startScreencast', {
      format: 'jpeg',
      quality,
      maxWidth,
      maxHeight: maxWidth,
      everyNthFrame: 1,
    });
  } catch (e) {
    recordings.delete(id);
    await offscreen({ cmd: 'close', id, ts: 0 }).catch(() => undefined);
    throw new RecordingError(`cannot record this tab: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { recording_id: id, tab_id: tabId };
}

type Taken = { data: string; size: number; error: string | null; frames: number; dropped: number; bytes_total: number; duration_ms: number };

function chunk(r: Recording, t: Taken, done: boolean) {
  return {
    mime: RECORDING_MIME,
    data: t.data,
    seq: r.seq++,
    frames: t.frames,
    dropped: t.dropped + r.dropped,
    bytes_total: t.bytes_total,
    duration_ms: t.duration_ms,
    ...(r.ended ? { ended: r.ended } : {}),
    ...(t.error ? { encoder_error: t.error } : {}),
    ...(done ? { done: true } : {}),
  };
}

export async function recordPull(id: string) {
  const r = get(id);
  await r.checking;
  return chunk(r, await offscreen<Taken>({ cmd: 'take', id, max: MAX_PULL_BYTES }), false);
}

export function recordPause(id: string, paused: boolean) {
  const r = get(id);
  r.paused = paused;
  if (paused && r.pending) {
    r.pending = null;
    r.dropped++;
  }
  return { paused };
}

export async function recordStop(id: string) {
  const r = get(id);
  if (!r.ended) r.ended = 'stopped';
  await cdp.send(r.tabId, 'Page.stopScreencast').catch(() => undefined);
  if (r.pendingTimer) clearTimeout(r.pendingTimer);
  await r.checking;
  const t = await offscreen<Taken>({ cmd: 'close', id, ts: Date.now() - r.startedAt });
  recordings.delete(id);
  return chunk(r, t, true);
}

/** Forget every recording (tests). */
export function resetRecorder(): void {
  recordings.clear();
  sensitiveTyping = 0;
  sensitiveUntil = 0;
  listening = false;
}
