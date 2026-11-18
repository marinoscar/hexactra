// The pictures of a run's trace (#544): a lazy thumbnail on a step row and a
// lightbox across the run's images. Each image is the masked key-moment
// screenshot of #541, fetched with the session (`GET /runs/{id}/steps/{seq}/screenshot`
// needs the bearer token) as a blob and shown through an object URL.
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import { Box, ButtonBase, Dialog, DialogContent, DialogTitle, IconButton, Stack, Typography, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useOptionalPlatformHost } from '@marinoscar/platform-web/core';

import type { RunStep } from '../types/runs';
import { imageCaption, imageCaptionLong, maskedWords } from './runTrace';

type PictureStep = Pick<RunStep, 'seq' | 'hasScreenshot' | 'screenshotMoment' | 'screenshotMasked'>;

interface PictureSource {
  /** The picture of step `seq` as an object URL, or null when it cannot be had. Cached for the run. */
  load(seq: number): Promise<string | null>;
  /** Open the lightbox on step `seq`. */
  open(seq: number): void;
}

const PictureContext = createContext<PictureSource | null>(null);

/** The pictures of one run; null outside a `RunPictures` (no thumbnails then). */
export const usePictures = () => useContext(PictureContext);

/**
 * Provides the run's pictures to the step rows under it, and the lightbox.
 * Every object URL it made is revoked when it unmounts.
 */
export function RunPictures({ runId, steps, children }: { runId: string; steps: readonly PictureStep[]; children: ReactNode }) {
  const host = useOptionalPlatformHost();
  const client = host?.api;
  const cache = useRef(new Map<number, Promise<string | null>>());
  const urls = useRef<string[]>([]);
  const [openSeq, setOpenSeq] = useState<number | null>(null);

  useEffect(() => {
    const made = urls.current;
    const known = cache.current;
    return () => {
      made.forEach((u) => URL.revokeObjectURL(u));
      made.length = 0;
      known.clear();
    };
  }, [runId]);

  const source = useMemo<PictureSource>(
    () => ({
      load(seq) {
        const have = cache.current.get(seq);
        if (have) return have;
        const p = (async () => {
          if (!client?.getBlob || typeof URL.createObjectURL !== 'function') return null;
          try {
            const res = await client.getBlob(`/runs/${encodeURIComponent(runId)}/steps/${seq}/screenshot`);
            const url = URL.createObjectURL(res.blob);
            urls.current.push(url);
            return url;
          } catch {
            // A missing or refused picture shows the placeholder; the next mount asks again.
            cache.current.delete(seq);
            return null;
          }
        })();
        cache.current.set(seq, p);
        return p;
      },
      open: setOpenSeq,
    }),
    [client, runId],
  );

  const pictures = useMemo(() => steps.filter((s) => s.hasScreenshot).sort((a, b) => a.seq - b.seq), [steps]);
  return (
    <PictureContext.Provider value={source}>
      {children}
      <Lightbox pictures={pictures} seq={openSeq} onChange={setOpenSeq} onClose={() => setOpenSeq(null)} />
    </PictureContext.Provider>
  );
}

/** The picture of `seq`: its URL once loaded, `failed` when there is none. `enabled` defers the fetch (lazy). */
function usePicture(seq: number, enabled: boolean): { url: string | null; failed: boolean; markFailed: () => void } {
  const source = usePictures();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || !source) return;
    let stale = false;
    setFailed(false);
    void source.load(seq).then((u) => {
      if (stale) return;
      setUrl(u);
      setFailed(!u);
    });
    return () => {
      stale = true;
    };
  }, [enabled, seq, source]);
  return { url, failed, markFailed: () => setFailed(true) };
}

/** A neutral stand-in for a picture that could not be loaded: never the browser's broken-image icon. */
function Placeholder({ label, small }: { label: string; small?: boolean }) {
  return (
    <Stack
      role="img"
      aria-label={`${label} (picture unavailable)`}
      spacing={0.5}
      data-testid="picture-placeholder"
      sx={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', bgcolor: 'action.hover', color: 'text.secondary', textAlign: 'center', p: 1 }}
    >
      <ImageOutlinedIcon fontSize={small ? 'small' : 'large'} aria-hidden />
      <Typography variant="caption" component="span">
        Picture unavailable
      </Typography>
    </Stack>
  );
}

/** Starts the fetch when the thumbnail comes near the viewport (at once where there is no observer). */
function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !ref.current || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

/**
 * A step's picture on its row: 16:10, lazy, with its caption ("The screen
 * when the agent asked · 2 areas masked"). A press opens the lightbox.
 */
export function StepThumbnail({ step }: { step: PictureStep }) {
  const source = usePictures();
  const [ref, near] = useNearViewport<HTMLButtonElement>();
  const { url, failed, markFailed } = usePicture(step.seq, near && Boolean(step.hasScreenshot) && source !== null);
  if (!source || !step.hasScreenshot) return null;
  const caption = imageCaption(step);
  const long = imageCaptionLong(step);
  return (
    <Box sx={{ mt: 1, width: { xs: 168, sm: 200 }, maxWidth: '100%' }} data-testid={`thumb-${step.seq}`}>
      <ButtonBase
        ref={ref}
        focusRipple
        aria-label={`Open the picture: ${caption}, step ${step.seq}`}
        aria-haspopup="dialog"
        onClick={() => source.open(step.seq)}
        sx={{ display: 'block', width: '100%', aspectRatio: '16 / 10', borderRadius: 1, overflow: 'hidden', border: 1, borderColor: 'divider', bgcolor: 'action.hover' }}
      >
        {url && !failed ? (
          <Box component="img" src={url} alt={caption} loading="lazy" decoding="async" onError={markFailed} sx={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : failed ? (
          <Placeholder label={caption} small />
        ) : null}
      </ButtonBase>
      <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
        {long}
      </Typography>
    </Box>
  );
}

/** The full picture of the open step, with its neighbours a press (or an arrow key) away. */
function Lightbox({ pictures, seq, onChange, onClose }: { pictures: readonly PictureStep[]; seq: number | null; onChange: (seq: number) => void; onClose: () => void }) {
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'));
  const titleId = useId();
  const index = seq === null ? -1 : pictures.findIndex((p) => p.seq === seq);
  const current = index >= 0 ? pictures[index] : null;
  const prev = index > 0 ? pictures[index - 1] : null;
  const next = index >= 0 && index < pictures.length - 1 ? pictures[index + 1] : null;
  const { url, failed, markFailed } = usePicture(current?.seq ?? -1, current !== null);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowLeft' && prev) {
      e.preventDefault();
      onChange(prev.seq);
    } else if (e.key === 'ArrowRight' && next) {
      e.preventDefault();
      onChange(next.seq);
    }
  };
  const caption = current ? imageCaption(current) : '';
  return (
    <Dialog open={current !== null} onClose={onClose} fullScreen={fullScreen} maxWidth="lg" fullWidth aria-labelledby={titleId} onKeyDown={onKeyDown}>
      {current && (
        <>
          <DialogTitle id={titleId} sx={{ pr: 7, overflowWrap: 'anywhere' }}>
            {caption}
            <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block' }}>
              {[`Step ${current.seq}`, `${index + 1} of ${pictures.length}`, maskedWords(current.screenshotMasked)].filter(Boolean).join(' · ')}
            </Typography>
          </DialogTitle>
          <IconButton aria-label="Close" onClick={onClose} sx={{ position: 'absolute', top: 8, right: 8, width: 44, height: 44 }}>
            <CloseIcon />
          </IconButton>
          <DialogContent sx={{ px: { xs: 1, sm: 3 } }}>
            {/* Pinch to zoom on a touch screen: the browser zooms, the picture's box scrolls. */}
            <Box sx={{ touchAction: 'pinch-zoom', overflow: 'auto', display: 'flex', justifyContent: 'center', bgcolor: 'action.hover', borderRadius: 1, minHeight: 200 }}>
              {url && !failed ? (
                <Box component="img" src={url} alt={caption} onError={markFailed} sx={{ display: 'block', maxWidth: '100%', height: 'auto', maxHeight: fullScreen ? 'none' : '70vh', objectFit: 'contain' }} />
              ) : failed ? (
                <Box sx={{ width: '100%', aspectRatio: '16 / 10' }}>
                  <Placeholder label={caption} />
                </Box>
              ) : (
                <Box sx={{ width: '100%', aspectRatio: '16 / 10' }} aria-busy="true" />
              )}
            </Box>
            <Stack direction="row" spacing={1} sx={{ mt: 1.5, justifyContent: 'space-between' }}>
              <IconButton aria-label="Previous picture" disabled={!prev} onClick={() => prev && onChange(prev.seq)} sx={{ width: 44, height: 44 }}>
                <ChevronLeftIcon />
              </IconButton>
              <IconButton aria-label="Next picture" disabled={!next} onClick={() => next && onChange(next.seq)} sx={{ width: 44, height: 44 }}>
                <ChevronRightIcon />
              </IconButton>
            </Stack>
          </DialogContent>
        </>
      )}
    </Dialog>
  );
}
