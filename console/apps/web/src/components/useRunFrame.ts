import { useEffect, useState } from 'react';

import { fetchRunScreenshot } from '../live';

export interface RunFrame {
  /** An object URL of the newest frame; null before the first one and whenever frames are off. */
  src: string | null;
  /** When the newest frame arrived. */
  shotAt: number | null;
  /** The last fetch failed: the frame on screen (if any) is getting old. */
  failing: boolean;
}

const NONE: RunFrame = { src: null, shotAt: null, failing: false };

/**
 * A live run's browser as a picture, fetched every `intervalMs` while
 * `enabled` and while the tab is visible (`GET /runs/:id/screenshot`; the
 * frame is never stored). One fetch feeds every place the chat shows the
 * browser. A failed fetch keeps the last frame and sets `failing`, so the
 * caption can say how old it is. Disabled, or with no run, there is no frame:
 * what was shown is dropped, not kept as if it were live.
 */
export function useRunFrame(runId: string | null, enabled: boolean, intervalMs: number): RunFrame {
  const [frame, setFrame] = useState<RunFrame>(NONE);

  useEffect(() => {
    if (!runId || !enabled) {
      setFrame(NONE);
      return;
    }
    let stopped = false;
    let current: string | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const next = async () => {
      // A hidden tab asks for nothing; it catches up when it is shown again.
      if (document.visibilityState !== 'hidden') {
        const url = await fetchRunScreenshot(runId).catch(() => null);
        if (stopped) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        if (url) {
          if (current) URL.revokeObjectURL(current);
          current = url;
          setFrame({ src: url, shotAt: Date.now(), failing: false });
        } else {
          setFrame((prev) => ({ ...prev, failing: true }));
        }
      }
      timer = setTimeout(() => void next(), intervalMs);
    };
    timer = setTimeout(() => void next(), 0);
    const onVisible = () => {
      if (document.visibilityState === 'hidden') return;
      clearTimeout(timer);
      timer = setTimeout(() => void next(), 0);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      if (current) URL.revokeObjectURL(current);
      setFrame(NONE);
    };
  }, [runId, enabled, intervalMs]);

  return frame;
}
