import { connectSse } from '@marinoscar/platform-web/core';

import { api } from './api';

/** One event of `GET /api/runs/:id/stream`, or `open` on every (re)connect. */
export type RunStreamEvent = { type: 'open' } | { type: 'run' | 'step' | 'heartbeat'; data: unknown };

const bearer = () => {
  const t = api.getAccessToken();
  return t ? `Bearer ${t}` : null;
};

/** Follow a run's event stream; returns the closer. */
export function subscribeRun(id: string, onEvent: (e: RunStreamEvent) => void): () => void {
  const conn = connectSse({
    url: `/api/runs/${id}/stream`,
    authorization: bearer,
    reauthenticate: () => api.refreshToken(),
    onOpen: () => onEvent({ type: 'open' }),
    onFrame: (f) => {
      if (f.event !== 'run' && f.event !== 'step' && f.event !== 'heartbeat') return;
      try {
        onEvent({ type: f.event, data: JSON.parse(f.data) });
      } catch {
        // a malformed frame is ignored; the next open refetches
      }
    },
  });
  return () => conn.close();
}

/** A fresh screenshot of a live run's browser, as an object URL (revoke it). */
export async function fetchRunScreenshot(id: string): Promise<string | null> {
  const auth = bearer();
  const res = await fetch(`/api/runs/${id}/screenshot`, { headers: auth ? { authorization: auth } : {} });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

/**
 * One live picture of a scan question (#924), or why there is none. `refused`: the server will not show one (the browser left the site,
 * its address is unknown, the request is closed): the card says "do not scan". Otherwise a passing failure: the card tries again. Never stored.
 */
export type ScanFrame = { ok: true; url: string; domain: string | null } | { ok: false; refused: boolean; message: string };

export async function fetchScanImage(questionId: string): Promise<ScanFrame> {
  const auth = bearer();
  const path = `/questions/${questionId}/scan-image`;
  const res = await fetch(`/api${path}`, { headers: auth ? { authorization: auth } : {}, cache: 'no-store' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    return { ok: false, refused: res.status === 409 || res.status === 410 || res.status === 404, message: body?.message ?? 'The picture is not available.' };
  }
  return { ok: true, url: URL.createObjectURL(await res.blob()), domain: res.headers.get('x-scan-domain') };
}

/** The events of `GET /api/chats/:id/stream` (#485), or `open` on every (re)connect. */
export const CHAT_STREAM_EVENTS = ['chat', 'message', 'turn', 'run', 'question', 'guidance', 'heartbeat'] as const;
export type ChatStreamEventType = (typeof CHAT_STREAM_EVENTS)[number];
export type ChatStreamEvent = { type: 'open' } | { type: ChatStreamEventType; data: unknown };

/**
 * Follow a chat: its new messages, whether the AI is working, its newest run
 * and the request that run waits on. `afterSeq` is the newest `seq` the page
 * holds when it subscribes. A reconnect asks from that same point again, so
 * messages can arrive twice: keep them by `seq`. Returns the closer.
 */
export function subscribeChat(id: string, afterSeq: number, onEvent: (e: ChatStreamEvent) => void): () => void {
  const known = new Set<string>(CHAT_STREAM_EVENTS);
  const conn = connectSse({
    url: `/api/chats/${id}/stream?afterSeq=${Math.max(0, Math.floor(afterSeq))}`,
    authorization: bearer,
    reauthenticate: () => api.refreshToken(),
    onOpen: () => onEvent({ type: 'open' }),
    onFrame: (f) => {
      if (!known.has(f.event)) return;
      try {
        onEvent({ type: f.event as ChatStreamEventType, data: JSON.parse(f.data) });
      } catch {
        // a malformed frame is ignored; the next open resends the state
      }
    },
  });
  return () => conn.close();
}
