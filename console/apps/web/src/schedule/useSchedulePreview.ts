import { useEffect, useRef, useState } from 'react';
import { usePlatformHost } from '@marinoscar/platform-web/core';

/** What `POST /api/schedules/preview` answers (always 200). */
export type SchedulePreview =
  | { valid: true; cron: string; timezone: string; description: string; next: string[]; intervalSeconds: number | null }
  | { valid: false; code: string; message: string };

export interface SchedulePreviewState {
  /** The last answer; it stays while a newer request is in flight. Null before the first one. */
  result: SchedulePreview | null;
  /** The answer is for an earlier expression or zone: a request is waiting or in flight. */
  pending: boolean;
  /** The last request failed (network): the schedule could not be checked. */
  failed: boolean;
}

export const PREVIEW_DEBOUNCE_MS = 300;

/**
 * What a schedule means and when it fires next, from the server, 300 ms after
 * the last change. Pass `cron: null` while the editor's own validation
 * rejects the spec: nothing is requested and the state clears.
 */
export function useSchedulePreview(cron: string | null, timezone: string, count = 5): SchedulePreviewState {
  const { api } = usePlatformHost();
  const [state, setState] = useState<SchedulePreviewState>({ result: null, pending: cron !== null, failed: false });
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    if (cron === null) {
      setState({ result: null, pending: false, failed: false });
      return;
    }
    setState((s) => ({ ...s, pending: true }));
    const timer = setTimeout(() => {
      api
        .post<SchedulePreview>('/schedules/preview', { cron, timezone, count })
        .then((result) => {
          if (seq.current === mine) setState({ result, pending: false, failed: false });
        })
        .catch(() => {
          if (seq.current === mine) setState({ result: null, pending: false, failed: true });
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [api, cron, timezone, count]);

  return state;
}
