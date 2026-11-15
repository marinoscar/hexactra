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
