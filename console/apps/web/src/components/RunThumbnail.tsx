import CloseIcon from '@mui/icons-material/Close';
import { Box, ButtonBase, Dialog, IconButton } from '@mui/material';
import { useEffect, useRef, useState } from 'react';

import { fetchRunScreenshot } from '../live';

/** How often the thumbnail asks for a fresh frame while it is on screen. */
export const THUMBNAIL_REFRESH_MS = 5_000;

/**
 * A small live picture of a run's browser, as context for a question the
 * run asks: the same screenshot the run page shows, refreshed every 5 s
 * while the thumbnail is on screen. A tap opens it full-screen. When the
 * screenshot cannot be fetched it renders nothing (no broken image, no
 * error): the picture is context, never required.
 */
export function RunThumbnail({ runId }: { runId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let stopped = false;
    let current: string | null = null;
    // Where the browser cannot say (an old one, jsdom), the thumbnail counts as on screen.
    let onScreen = true;
    const next = async () => {
      if (!onScreen || document.visibilityState === 'hidden') return;
      const url = await fetchRunScreenshot(runId).catch(() => null);
      if (stopped) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      // A failed fetch drops the picture rather than show a stale one as if it were live.
      if (current) URL.revokeObjectURL(current);
      current = url;
      setSrc(url);
    };
    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined' && anchor.current) {
      observer = new IntersectionObserver((entries) => {
        const was = onScreen;
        onScreen = entries.some((e) => e.isIntersecting);
        if (onScreen && !was) void next();
      });
      observer.observe(anchor.current);
    }
    void next();
    const t = setInterval(() => void next(), THUMBNAIL_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(t);
      observer?.disconnect();
      if (current) URL.revokeObjectURL(current);
    };
  }, [runId]);

  return (
    <>
      {/* Always mounted, so the observer has something to watch before the first frame arrives. */}
      <span ref={anchor} />
      {src && (
        <ButtonBase
          aria-label="Show the browser full screen"
          onClick={() => setOpen(true)}
          sx={{ display: 'block', mt: 1.5, borderRadius: 1, overflow: 'hidden', border: 1, borderColor: 'divider', lineHeight: 0, maxWidth: '100%' }}
        >
          <Box component="img" src={src} alt="The run's browser right now" sx={{ display: 'block', width: 160, maxWidth: '100%', height: 100, objectFit: 'cover', objectPosition: 'top left' }} />
        </ButtonBase>
      )}
      <Dialog fullScreen open={open && src !== null} onClose={() => setOpen(false)} aria-label="The run's browser">
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', p: 1 }}>
          <IconButton aria-label="Close" onClick={() => setOpen(false)} sx={{ width: 44, height: 44 }}>
            <CloseIcon />
          </IconButton>
        </Box>
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 1, overflow: 'auto' }}>
          {src && <Box component="img" src={src} alt="The run's browser right now, full size" sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />}
        </Box>
      </Dialog>
    </>
  );
}
